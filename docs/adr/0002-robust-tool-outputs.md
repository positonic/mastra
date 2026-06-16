# Robust tool outputs: neutralize server-tool error results before replay

## Context

Anthropic server tools (`web_fetch`, `web_search`, code execution) return an
*error* result variant — e.g. `web_fetch_tool_result_error` with
`url_not_in_prior_context` when the model fetches a URL that isn't already in
the conversation. web_fetch's [URL-validation rule](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool)
makes this a *routine*, expected outcome for agent-initiated fetches, not a
rare failure.

The **live** turn already tolerates this: `@ai-sdk/anthropic`'s response parser
accepts the error variant as part of a union, so the model receives the failure
and narrates around it. The crash was observed on **replay**: on a subsequent
turn the stored error block is re-serialized back to the API during request
conversion, and a malformed/unrecognized provider-tool result value falls
through to `validateTypes(webFetch_20250910OutputSchema)` (a success-only
schema) and throws a Zod `Type validation failed` error. One failed fetch
therefore **poisons the entire thread** — every later message dies during
prompt construction, regardless of topic. The raw validation blob was being
streamed verbatim into the chat UI.

### Honest version/shape story (`@ai-sdk/anthropic` 3.0.37, verified)

The exact reproduction depends on SDK version and on the precise stored shape.
On the installed **3.0.37**, investigated directly (see the eval-replay test):

- A *clean* `web_fetch_tool_result_error` value does **not** throw — the
  converter has an explicit branch for it. True both for a hand-built
  provider-executed prompt and through Mastra's own V2→model conversion (which
  drops `providerExecuted` and re-emits the result as a plain `tool`-role
  `tool_result`, stringified, with no schema validation).
- The shape that **does** throw `Type validation failed` on 3.0.37 is an
  *incomplete / malformed success* (`{ type: 'web_fetch_result', url }` with no
  `retrievedAt`/`content`), which hits the success-only schema.

So the originally observed production crash most plausibly came from an **older
SDK** and/or a **non-clean provider-tool result shape**. The neutralizer's value
is therefore version-independent: (i) **forward-compat** — it removes the
provider-executed server-tool part entirely, so no future SDK version or new
server tool can reintroduce a replay-side validation crash from this data; and
(ii) it **covers malformed / unknown provider-tool result shapes** that do throw
today. This is not a claim that 3.0.37 throws on the clean error block — it
does not.

This is the output-side sibling of [ADR-0001](./0001-robust-tool-inputs.md)
(robust tool *inputs*): the same "the provider boundary will hand us
plausible-but-unhandled shapes; absorb them at our layer" problem, on the way
out instead of the way in.

## Decision

**Neutralize server-tool error results at our layer before they reach the
provider's request conversion — for all server tools, not just web_fetch.**

- A Mastra **input processor** scans conversation history and replaces any
  server-tool `*_tool_result_error` block (and its `server_tool_use`) with a
  short assistant **text note** recording the fact of failure, e.g.
  `(Attempted web_fetch of <url> — failed: url_not_in_prior_context.)` (the
  tool name and, when present, the URL and error code are included; nothing is
  invented). This runs
  proactively on every turn, is idempotent, de-poisons already-broken threads
  on next read with no DB migration, and is independent of `@ai-sdk/anthropic`
  version.
- The decision is **version-independent by design**. The SDK bump
  (3.0.37 → 3.0.84) is orthogonal hygiene shipped separately; the fix does not
  depend on it.
- Defense-in-depth: the chat-stream error branch never streams raw error text
  to users — it emits a generic message and logs the masked error server-side.

## Considered options

- **Drop the tool_use + error result pair entirely** — *rejected.* Erases the
  model's memory that it tried, so it may re-attempt the same dead URL.
  Flattening to text preserves the fact-of-failure (ADR-0001's "preserve
  intent, never invent it"), breaking retry loops.
- **Coerce the stored block into the exact shape the SDK's error-handler
  branch expects** — *rejected.* Couples us to `@ai-sdk/anthropic` internals;
  a new tool version or refactor silently reintroduces the crash.
- **Rely on the SDK upgrade** — *rejected as the primary fix.* The installed
  3.0.37 already handles the *clean* error variant (verified — it does not throw
  on it), yet the production crash still occurred — so the crash came from an
  older SDK and/or a non-clean stored shape, and "just upgrade" neither explains
  nor guarantees against it. New server tools or malformed shapes can
  reintroduce the gap. Worth the bump for hygiene, not to depend on.
- **Special-case web_fetch only** — *rejected.* `web_search` and code execution
  produce the identical `*_tool_result_error` poison shape. ADR-0001 already
  rejected per-tool exception lists in favour of one blanket rule.

## Consequences

- Applies to both agents (Zoe and the assistant), which both enable
  `webSearch` + `webFetch`.
- web_fetch's *misrouting* to app/Notion URLs (the misleading "I can access your
  Payments database" behaviour) is a **separate** quality issue, deliberately
  out of scope here — routing guidance already exists and was ignored, so it
  needs a structural fix (e.g. `blocked_domains`), not more prompt.
- Guarded by a processor unit test (web_fetch / web_search / code-exec error
  shapes all flatten, zero error blocks remain) plus an eval-replay regression
  that drives a **real Mastra `MessageList`** (re-applying the processor output
  the way the runner does — `removeByIds` + `add`) and asserts that Mastra's own
  V2→model conversion of the neutralized history carries no provider-executed
  tool part and no `*_tool_result_error` (it does for the un-neutralized
  history). The same suite pins the 3.0.37 version story (clean error block does
  not throw; malformed success does).
- **Detection is V2-format-coupled.** `isErroredServerToolPart` keys on the V2
  `tool-invocation` part type. If Mastra emits a different message format (a
  future V3) or the provider result lands as a different part type, the
  neutralizer silently no-ops and the poison can return with no signal. Revisit
  this predicate on any message-format bump.
