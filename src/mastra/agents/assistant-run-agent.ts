import { Agent } from '@mastra/core/agent';
import { memory } from '../memory/index.js';
import { neutralizeServerToolErrorsProcessor } from '../processors/neutralize-server-tool-errors.js';
import { EXPONENTIAL_CONTEXT } from './exponential-context.js';
import { SECURITY_POLICY } from './security-policy.js';
import { assistantModel, assistantTools } from './assistant-agent.js';
import { runTools } from '../tools/run-tools.js';

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
  // Exponential writes that stay inside the app
  'createProjectActionTool',
  'quickCreateActionTool',
  'updateActionTool',
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
  // Anthropic provider tools
  'webSearch',
  'webFetch',
  'toolSearch',
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
] as const;

function pickAllowed<T extends Record<string, unknown>>(all: T) {
  const out: Record<string, unknown> = {};
  for (const key of RUN_ALLOWED_ASSISTANT_TOOL_KEYS) {
    if (key in all) out[key] = all[key];
  }
  return out;
}

export const assistantRunTools = {
  ...pickAllowed(assistantTools),
  ...runTools,
};

export const RUN_CONTRACT = `
## Run contract

You are not in a chat. You were **assigned an action** and are working on it unattended as your own principal: every write you make is recorded as yours, never as your owner's.

- **Read widely, write narrowly.** Read anything you need. Write only inside Exponential: comments, action fields, sub-actions. You have no tool that sends email, books calendar events, or writes to Notion or the CRM — do not try to work around that; if the task needs it, say so in your summary.
- **Never complete the action.** Propose it: finish with \`readyToClose: true\` and the owner confirms from their inbox.
- **Finish with finish-run.** Your last call is always \`finish-run\` with a summary. The summary is public — the requester, your owner and their teammates read it — so write it for them, with what you did, what you found and what is left.
- **Be done quickly.** You have a bounded number of steps. Prefer one good pass over exhaustive exploration.
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

export const assistantRunDefaultOptions = {
  // Bounds a run's wall-clock inside the app's dispatch function (Agent PRD D4).
  maxSteps: 12,
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
