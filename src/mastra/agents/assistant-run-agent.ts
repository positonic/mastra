import { Agent } from '@mastra/core/agent';
import { hasToolCall, stepCountIs } from 'ai';
import { memory } from '../memory/index.js';
import { neutralizeServerToolErrorsProcessor } from '../processors/neutralize-server-tool-errors.js';
import { EXPONENTIAL_CONTEXT } from './exponential-context.js';
import { SECURITY_POLICY } from './security-policy.js';
import { assistantModel, assistantTools } from './assistant-agent.js';
import { runTools, runUpdateActionTool } from '../tools/run-tools.js';

/**
 * Assistant Run Agent — the engine behind an **Agent run** (Exponential
 * ADR-0067, Agent PRD D4/D5): an Assistant that was *assigned* an action,
 * working unattended as its own principal.
 *
 * Same shape as `assistantAgent` (identity arrives in system messages the
 * app builds from the owner's Assistant persona) with two differences that
 * are the whole point:
 *
 *  1. **The tool map is restricted by construction.** Unattended, the run
 *     reads anything the owner can read and writes only inside Exponential.
 *     The outbound tools — email send/reply, calendar create, every Notion and
 *     CRM write, OKR deletes, Slack, WhatsApp — are simply not on the map.
 *     `SECURITY_POLICY` is prompt text; this is structural, and
 *     `__tests__/assistant-run-tools.test.ts` pins it.
 *  2. **It carries the run tools** that report back into the app (progress,
 *     comments, questions to the owner, finish). The app writes the run events
 *     inside those callbacks.
 *
 * The map is a static object (the `anthropic` profile) so Mastra registers
 * every tool on the instance — see `toolsets.ts` for why a resolver function
 * would silently drop them.
 */

/**
 * Keys of `assistantTools` a run may carry: reads, plus the writes that stay
 * inside Exponential (create/update actions). Anything not listed here is
 * excluded — the allow-list is the contract, not a deny-list.
 */
export const RUN_ALLOWED_ASSISTANT_TOOL_KEYS = [
  // Exponential reads
  'getProjectContextTool',
  'getProjectActionsTool',
  'getProjectGoalsTool',
  'getAllGoalsTool',
  'getAllProjectsTool',
  'getTodaysActionsTool',
  'getOverdueTriageTool',
  'getUserWorkspacesTool',
  'listProductsTool',
  'listCyclesTool',
  'listTicketsTool',
  'getOkrObjectivesTool',
  'getOkrStatsTool',
  'getMeetingTranscriptionsTool',
  'queryMeetingContextTool',
  'getMeetingInsightsTool',
  'listDecisionsTool',
  // Exponential writes that stay inside the app. Updating actions goes through
  // the run tools' `runUpdateActionTool`, which cannot set status — the chat
  // `updateActionTool` (status: COMPLETED/CANCELLED) is deliberately absent.
  'createProjectActionTool',
  'quickCreateActionTool',
  // External reads (never writes)
  'notionSearchTool',
  'notionGetPageTool',
  'notionQueryDatabaseTool',
  'checkCalendarConnectionTool',
  'getTodayCalendarEventsTool',
  'getUpcomingCalendarEventsTool',
  'getCalendarEventsInRangeTool',
  'findAvailableTimeSlotsTool',
  'searchCrmContactsTool',
  'getCrmContactTool',
  'searchCrmOrganizationsTool',
  'checkEmailConnectionTool',
  'getRecentEmailsTool',
  'getEmailByIdTool',
  'searchEmailsTool',
  // Anthropic provider tools. NOT toolSearch: with it on the map,
  // anthropic-prompt-cache.ts defers every function tool behind BM25 search —
  // including get-run-context, ask-owner and finish-run, the calls the run
  // contract depends on. ~40 tools load in full affordably for a run.
  'webSearch',
  'webFetch',
] as const;

/**
 * Tools a run must never carry (Agent PRD D5, "excluded by construction").
 * Listed explicitly so the test can assert each one is absent by name, not
 * merely "not in the allow-list".
 */
export const RUN_EXCLUDED_TOOL_KEYS = [
  'sendEmailTool',
  'replyToEmailTool',
  'createCalendarEventTool',
  'notionCreatePageTool',
  'notionUpdatePageTool',
  'createFullCrmContactTool',
  'updateCrmContactTool',
  'addCrmInteractionTool',
  'createCrmOrganizationTool',
  'updateActionTool',
  'toolSearch',
  'deleteOkrObjectiveTool',
  'deleteOkrKeyResultTool',
  'sendSlackMessageTool',
  'updateSlackMessageTool',
  'getSlackUserInfoTool',
  'listSlackChannelsTool',
  'getSlackChannelHistoryTool',
  'getSlackThreadRepliesTool',
  'searchSlackMessagesTool',
  'getSlackMentionsTool',
  'getSlackUnreadsTool',
  'listWhatsAppChatsTool',
  'getWhatsAppChatHistoryTool',
  'searchWhatsAppChatsTool',
  // Chat routing tools (ADR-0068 in exponential, Agent PRD D9). They call the
  // human roster and `action.assign` as the caller; a run delegates through
  // `reassign-action` instead, whose containment runs as the owner.
  'listAssignableMembersTool',
  'assignActionTool',
  // Import roles & responsibilities (Agent PRD D10): writes Positions as the
  // user after their yes. `position.importMany` is human-only and refuses a
  // run's token anyway; the run never carries the tool.
  'importPositionsTool',
] as const;

function pickAllowed<T extends Record<string, unknown>>(all: T) {
  const out: Record<string, unknown> = {};
  for (const key of RUN_ALLOWED_ASSISTANT_TOOL_KEYS) {
    // Fail at import rather than silently dropping a tool a run was meant to
    // carry when it is renamed on assistantTools.
    if (!(key in all)) {
      throw new Error(`assistantRunAgent: allow-listed tool "${key}" is not registered on assistantTools`);
    }
    out[key] = all[key];
  }
  return out;
}

export const assistantRunTools = {
  ...pickAllowed(assistantTools),
  runUpdateActionTool,
  ...runTools,
};

export const RUN_CONTRACT = `
## Run contract

You are not in a chat. You were **assigned an action** and are working on it unattended as your own principal: every write you make is recorded as yours, never as your owner's. Nobody is watching the transcript live; what reaches people is your comments, your question to the owner, and your final summary.

### Your run tools

- **get-run-context** — call it FIRST. It returns the action brief, who is assigned, the project's members (people and other Assistants, with ids and the Positions they hold), recent comments, and — when you are resuming — the previous run's summary and your owner's reply.
- **report-progress** — a one-line transcript note when you move to a new phase. Not a comment; nobody is notified.
- **comment-on-action** — post a comment as yourself, for findings worth a permanent record or to hand something to a person with \`@[Name](userId)\` markup.
- **reassign-action** — add a person or another Assistant as an assignee (ids from get-run-context). Comment with context first. Assigning another Assistant starts its run. When delegating, prefer the member whose Position Remit fits the work, using get-run-context's members (an agent with no Position is described by its \`agentDescription\`).
- **ask-owner** — when you are stuck on something only your owner can decide. It posts the question, pauses the run, and is your LAST call: after ask-owner make no further tool calls, do not call finish-run, and end your turn. A new run resumes when they reply.
- **finish-run** — otherwise, your last call, exactly once, with a public summary and \`readyToClose\`.

### Rules

- **Read widely, write narrowly.** Read anything you need. Write only inside Exponential: comments, action fields, sub-actions. You have no tool that sends email, books calendar events, or writes to Notion or the CRM — do not try to work around that, and never claim you did any of those. If the task needs one of them, do everything up to that point (draft the text, pick the slot, find the contact) and either ask-owner or hand it over in your summary.
- **Never complete the action.** You cannot set an action's status. Propose it: finish with \`readyToClose: true\` and the owner confirms from their inbox.
- **Never guess an id.** Every userId and projectId comes from get-run-context or a read tool.
- **Exactly one ending.** A run ends with either ask-owner or finish-run, never both, never neither.
- **Be done quickly.** You have a bounded number of steps. Prefer one good pass over exhaustive exploration; the owner can always ask for more.
`;

export const assistantRunInstructions = () => `
You are a personal AI assistant integrated into Exponential — a life management system.

${SECURITY_POLICY}

${EXPONENTIAL_CONTEXT}

## Identity

Your name, personality, and behavioral guidelines are provided in system messages at the start of this run. Follow them closely — they define who you are for this user.

${RUN_CONTRACT}

Today's date is ${new Date().toISOString().slice(0, 10)} (UTC).
`;

/** Map keys of the run's two endings — the tool names the model emits. */
export const RUN_ENDING_TOOL_KEYS = ['askOwnerTool', 'finishRunTool'] as const;

export const assistantRunDefaultOptions = {
  // The loop ends on the first step that calls ask-owner or finish-run, so
  // "exactly one ending" is structural rather than prompt-only, and otherwise
  // after 12 steps — which bounds a run's wall-clock inside the app's dispatch
  // function (Agent PRD D4).
  //
  // No `maxSteps` on purpose: Mastra turns a numeric maxSteps into
  // stepCountIs(maxSteps) and DISCARDS stopWhen, so the endings would stop
  // ending the run. The same holds per call — a caller passing maxSteps to
  // generate/stream silently re-opens the loop. hasToolCall matches the map
  // key (askOwnerTool), not the tool id (ask-owner).
  stopWhen: [stepCountIs(12), ...RUN_ENDING_TOOL_KEYS.map((key) => hasToolCall(key))],
  modelSettings: {
    temperature: 0.5,
  },
};

export const assistantRunAgent = new Agent({
  id: 'assistantRunAgent',
  name: 'Assistant (run)',
  instructions: assistantRunInstructions,
  model: assistantModel,
  memory,
  defaultOptions: assistantRunDefaultOptions,
  // Static map on purpose — see toolsets.ts: a resolver function would drop
  // these tools from Mastra's registry.
  tools: assistantRunTools,
  inputProcessors: [neutralizeServerToolErrorsProcessor],
});
