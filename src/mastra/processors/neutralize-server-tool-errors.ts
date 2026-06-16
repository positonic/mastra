import type {
  MastraDBMessage,
  MastraMessagePart,
} from '@mastra/core/agent/message-list';
import type { Processor, ProcessInputArgs } from '@mastra/core/processors';

/**
 * Neutralize server-tool error results before replay — ADR-0002.
 *
 * Anthropic server tools (`web_fetch`, `web_search`, code execution) routinely
 * return an *error* result variant — e.g. `web_fetch_tool_result_error` with
 * `url_not_in_prior_context` when the model fetches a URL not already in the
 * conversation. The live turn tolerates it (the response parser accepts the
 * error as part of a union), but on every *subsequent* turn the stored error
 * block is re-serialized back to the API and the request-conversion path
 * validates it against a success-only schema (`web_fetch_result`) and throws a
 * Zod `Type validation failed` error during prompt construction. One failed
 * fetch therefore poisons the ENTIRE thread — every later message dies, on any
 * topic.
 *
 * The fix neutralizes these error results at *our* layer, on Mastra's own V2
 * message representation, before the provider's request conversion runs — so
 * the throw never happens, for ALL server tools (no per-tool special-casing,
 * per ADR-0001's rejection of exception lists). The errored
 * `server_tool_use` + error result is flattened to a short assistant TEXT note
 * recording the fact of failure, e.g.
 * `(Attempted web_fetch of <url> — failed: url_not_in_prior_context.)`. This
 * preserves the model's memory that it tried (breaking retry loops), keeps
 * tool_use/result pairing valid, is independent of `@ai-sdk/anthropic`'s
 * version, and is idempotent — running it twice equals running it once and a
 * clean history passes through unchanged. It also de-poisons already-broken
 * threads on next read with no DB migration.
 *
 * ## V2 message shape (determined empirically)
 *
 * A provider-executed server-tool result is stored on an assistant message as
 * a `tool-invocation` part:
 *
 * ```jsonc
 * {
 *   "type": "tool-invocation",
 *   "toolInvocation": {
 *     "toolCallId": "tc_1",
 *     "toolName": "web_fetch",          // or web_search / code_execution
 *     "args": { "url": "https://…" },   // url present for web_fetch
 *     "state": "result",
 *     "result": {
 *       "type": "web_fetch_tool_result_error",   // the poison: *_tool_result_error
 *       "errorCode": "url_not_in_prior_context"
 *     }
 *   }
 * }
 * ```
 *
 * The V2 message also mirrors the same data into `content.toolInvocations[]`
 * and a `content.content` string; both are rebuilt here so the neutralized
 * message has no stale tool data for any downstream code path to resurrect.
 */

/** The discriminator on an errored server-tool result. */
const ERROR_RESULT_TYPE_SUFFIX = '_tool_result_error';

interface ServerToolErrorResult {
  type: string;
  errorCode?: unknown;
  error_code?: unknown;
}

/** A V2 `tool-invocation` part carrying a resolved tool result. */
interface ToolInvocationLike {
  toolName?: unknown;
  args?: unknown;
  state?: unknown;
  result?: unknown;
}

function isServerToolErrorResult(result: unknown): result is ServerToolErrorResult {
  return (
    typeof result === 'object' &&
    result !== null &&
    typeof (result as { type?: unknown }).type === 'string' &&
    (result as { type: string }).type.endsWith(ERROR_RESULT_TYPE_SUFFIX)
  );
}

/**
 * True when a part is a `tool-invocation` whose resolved result is a
 * server-tool `*_tool_result_error` block — the shape that poisons replay.
 *
 * ⚠️ V2-format-coupled detection. This keys on `part.type === 'tool-invocation'`,
 * which is Mastra's V2 message representation. If Mastra emits a different
 * message format (e.g. a future V3) — or the provider result lands as a
 * different part type — this predicate returns false, the neutralizer silently
 * no-ops, and the poison can return with NO signal. This is an accepted
 * trade-off today (V2 is what these agents store), but it is the first thing to
 * revisit on any message-format bump. See ADR-0002 "Consequences".
 */
function isErroredServerToolPart(part: MastraMessagePart): boolean {
  if (part.type !== 'tool-invocation') return false;
  const invocation = (part as { toolInvocation?: ToolInvocationLike })
    .toolInvocation;
  return (
    invocation?.state === 'result' && isServerToolErrorResult(invocation.result)
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Build the human-readable failure note for one errored server-tool part.
 * Includes the URL (for web_fetch) and the error code when available, but
 * never invents data it doesn't have.
 */
function buildFailureNote(invocation: ToolInvocationLike): string {
  const toolName = asString(invocation.toolName) ?? 'server tool';
  const url =
    invocation.args &&
    typeof invocation.args === 'object' &&
    invocation.args !== null
      ? asString((invocation.args as { url?: unknown }).url)
      : undefined;
  const result = invocation.result as ServerToolErrorResult;
  const errorCode =
    asString(result.errorCode) ?? asString(result.error_code) ?? 'error';

  const target = url ? ` of ${url}` : '';
  return `(Attempted ${toolName}${target} — failed: ${errorCode}.)`;
}

/** Concatenate the text of all `text` parts into the V2 `content` mirror. */
function joinTextParts(parts: MastraMessagePart[]): string {
  return parts
    .filter((p): p is MastraMessagePart & { text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n');
}

/**
 * Pure core (ADR-0002): message-collection in, message-collection out. No I/O,
 * no SDK/agent coupling. Replaces every server-tool `*_tool_result_error`
 * block with a short assistant text note; leaves every other message and part
 * — assistant text, SUCCESSFUL tool results, unrelated messages — untouched.
 * Idempotent: a history with no error blocks is returned unchanged
 * (referentially, the same array), and re-running on neutralized output is a
 * no-op.
 */
export function neutralizeServerToolErrors(
  messages: MastraDBMessage[],
): MastraDBMessage[] {
  let mutatedAny = false;

  const result = messages.map((message) => {
    const parts = message.content?.parts;
    if (!Array.isArray(parts) || !parts.some(isErroredServerToolPart)) {
      return message;
    }

    mutatedAny = true;

    const newParts: MastraMessagePart[] = parts.map((part) => {
      if (!isErroredServerToolPart(part)) return part;
      const invocation = (part as { toolInvocation: ToolInvocationLike })
        .toolInvocation;
      const note: MastraMessagePart = {
        type: 'text',
        text: buildFailureNote(invocation),
      };
      return note;
    });

    // Rebuild the V2 message so no stale tool data survives in the parallel
    // `toolInvocations[]` array or the `content` string mirror — both are
    // derived from the now-flattened parts.
    const oldToolInvocations = message.content.toolInvocations;
    const keptToolInvocations = Array.isArray(oldToolInvocations)
      ? oldToolInvocations.filter(
          (inv) => !isServerToolErrorResult((inv as ToolInvocationLike).result),
        )
      : oldToolInvocations;

    return {
      ...message,
      content: {
        ...message.content,
        parts: newParts,
        ...(keptToolInvocations !== undefined
          ? { toolInvocations: keptToolInvocations }
          : {}),
        ...(message.content.content !== undefined
          ? { content: joinTextParts(newParts) }
          : {}),
      },
    };
  });

  // Idempotency / clean-history fast path: return the original array reference
  // when nothing changed.
  return mutatedAny ? result : messages;
}

/**
 * Thin Mastra input-processor wrapper around {@link neutralizeServerToolErrors}.
 * Runs on every turn, before the provider's request conversion, on the V2
 * message history. Wired onto both Zoe and the assistant agent (and their
 * Haiku variants), which both enable `webSearch` + `webFetch`.
 */
export class NeutralizeServerToolErrorsProcessor
  implements Processor<'neutralize-server-tool-errors'>
{
  readonly id = 'neutralize-server-tool-errors' as const;
  readonly name = 'Neutralize Server-Tool Errors';
  readonly description =
    'Flattens Anthropic server-tool *_tool_result_error blocks to a text note before request conversion (ADR-0002).';

  processInput({ messages }: ProcessInputArgs): MastraDBMessage[] {
    return neutralizeServerToolErrors(messages);
  }
}

/** Singleton instance for wiring into agent `inputProcessors`. */
export const neutralizeServerToolErrorsProcessor =
  new NeutralizeServerToolErrorsProcessor();
