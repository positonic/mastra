/**
 * Provider-agnostic tool loading for Zoe and the Assistant (exponential
 * ticket 674, ADR-0065 in exponential).
 *
 * Both agents register ~85 tools (~25K tokens of JSON schema). On Anthropic
 * that is affordable only because `anthropic-prompt-cache.ts` marks every
 * function tool `deferLoading: true` and the BM25 tool-search server tool
 * finds them on demand. No other provider has that trick, so a non-Anthropic
 * model would ship every schema on every turn — a "hi" would cost ~25K input
 * tokens before saying anything.
 *
 * This module splits the tools into a small always-loaded CORE set plus named
 * TOOLSETS, and resolves the tool map per request from a `toolsets` entry in
 * the Mastra RequestContext. The exponential chat route fills that entry from
 * the same Jev request that picks the model tier (one Noul question per
 * toolset, evaluated in parallel, no extra round-trip).
 *
 * Two profiles:
 *   - `anthropic` — every toolset, always, plus the Anthropic provider tools
 *     (web search/fetch, tool search). Deferral keeps the prompt small, and a
 *     fixed tool list keeps the prompt-cache prefix stable and lets replayed
 *     thread history reference any tool. Selection is ignored. This is what
 *     the four current agents use, so their behaviour and cost are unchanged.
 *   - `generic` — CORE plus the selected toolsets, function tools only. With
 *     no selection (Jev not configured, sticky turn, or low confidence on
 *     every toolset) it is CORE alone, which is the point: cheap by default,
 *     richer only when the turn asks for it. For OpenRouter-backed agents
 *     (exponential ticket 675).
 *
 * The toolset ids are a contract with exponential's
 * `src/server/services/ai/jevDecision.ts` (TOOLSET_IDS there). Unknown ids
 * in a request are ignored, so the two sides can roll out independently.
 */

export const TOOLSET_IDS = [
  'planning',
  'tickets',
  'pages',
  'notion',
  'calendar',
  'crm',
  'email',
  'whatsapp',
  'goals',
  'slack',
  'meetings',
  'decisions',
  'web',
] as const;

export type ToolsetId = (typeof TOOLSET_IDS)[number];
export type ToolGroupId = 'core' | ToolsetId;
export type ToolProfile = 'anthropic' | 'generic';

/** RequestContext key the exponential chat route sets. */
export const TOOLSETS_CONTEXT_KEY = 'toolsets';

/**
 * Which group every tool key belongs to. A key missing from here fails the
 * coverage test in `__tests__/toolsets.test.ts`, so a newly registered tool
 * cannot silently vanish from the generic profile.
 *
 * CORE is what a typical short turn needs: today's work, a project's actions,
 * quick capture, ticking things off, and a look at today's calendar.
 */
export const TOOL_GROUPS: Record<string, ToolGroupId> = {
  // core
  getProjectContextTool: 'core',
  getProjectActionsTool: 'core',
  createProjectActionTool: 'core',
  quickCreateActionTool: 'core',
  updateActionTool: 'core',
  getTodaysActionsTool: 'core',
  getAllProjectsTool: 'core',
  getUserWorkspacesTool: 'core',
  getAllGoalsTool: 'core',
  getTodayCalendarEventsTool: 'core',
  getUpcomingCalendarEventsTool: 'core',

  // planning: project admin, triage and rescheduling
  createProjectTool: 'planning',
  updateProjectTool: 'planning',
  deleteProjectTool: 'planning',
  updateProjectStatusTool: 'planning',
  bulkCreateWorkspaceStructureTool: 'planning',
  getOverdueTriageTool: 'planning',
  deferActionsTool: 'planning',
  rescheduleActionsTool: 'planning',

  // tickets: product pipeline
  listProductsTool: 'tickets',
  createTicketTool: 'tickets',
  bulkCreateTicketsTool: 'tickets',
  importNotionCycleTicketsTool: 'tickets',
  listCyclesTool: 'tickets',
  listTicketsTool: 'tickets',
  addTicketDependenciesTool: 'tickets',
  ideateFeaturesTool: 'tickets',

  // pages: Knowledge Page authoring (ADR-0033)
  createPageTool: 'pages',
  updatePageTool: 'pages',

  notionSearchTool: 'notion',
  notionGetPageTool: 'notion',
  notionQueryDatabaseTool: 'notion',
  notionCreatePageTool: 'notion',
  notionUpdatePageTool: 'notion',

  getCalendarEventsInRangeTool: 'calendar',
  findAvailableTimeSlotsTool: 'calendar',
  createCalendarEventTool: 'calendar',
  checkCalendarConnectionTool: 'calendar',

  searchCrmContactsTool: 'crm',
  getCrmContactTool: 'crm',
  createFullCrmContactTool: 'crm',
  updateCrmContactTool: 'crm',
  addCrmInteractionTool: 'crm',
  searchCrmOrganizationsTool: 'crm',
  createCrmOrganizationTool: 'crm',

  checkEmailConnectionTool: 'email',
  getRecentEmailsTool: 'email',
  getEmailByIdTool: 'email',
  searchEmailsTool: 'email',
  sendEmailTool: 'email',
  replyToEmailTool: 'email',

  listWhatsAppChatsTool: 'whatsapp',
  getWhatsAppChatHistoryTool: 'whatsapp',
  searchWhatsAppChatsTool: 'whatsapp',

  // goals: OKRs and project↔goal links
  getProjectGoalsTool: 'goals',
  getOkrObjectivesTool: 'goals',
  createOkrObjectiveTool: 'goals',
  updateOkrObjectiveTool: 'goals',
  deleteOkrObjectiveTool: 'goals',
  createOkrKeyResultTool: 'goals',
  updateOkrKeyResultTool: 'goals',
  deleteOkrKeyResultTool: 'goals',
  checkInOkrKeyResultTool: 'goals',
  getOkrStatsTool: 'goals',
  linkProjectToGoalTool: 'goals',
  unlinkProjectFromGoalTool: 'goals',
  linkProjectToKeyResultTool: 'goals',
  unlinkProjectFromKeyResultTool: 'goals',
  linkObjectiveToParentTool: 'goals',
  addObjectiveCommentTool: 'goals',
  addObjectiveUpdateTool: 'goals',

  sendSlackMessageTool: 'slack',
  updateSlackMessageTool: 'slack',
  getSlackUserInfoTool: 'slack',
  listSlackChannelsTool: 'slack',
  getSlackChannelHistoryTool: 'slack',
  getSlackThreadRepliesTool: 'slack',
  searchSlackMessagesTool: 'slack',
  getSlackMentionsTool: 'slack',
  getSlackUnreadsTool: 'slack',

  getMeetingTranscriptionsTool: 'meetings',
  queryMeetingContextTool: 'meetings',
  getMeetingInsightsTool: 'meetings',

  logDecisionTool: 'decisions',
  updateDecisionTool: 'decisions',
  listDecisionsTool: 'decisions',

  // web: Anthropic provider tools — only the anthropic profile can use them
  webSearch: 'web',
  webFetch: 'web',
};

/**
 * Provider tools that are not "a capability" but plumbing for the Anthropic
 * profile. Kept out of TOOL_GROUPS so the generic profile can never pick
 * them up.
 */
export const ANTHROPIC_ONLY_TOOL_KEYS = new Set(['toolSearch', 'webSearch', 'webFetch']);

const TOOLSET_ID_SET: ReadonlySet<string> = new Set(TOOLSET_IDS);

/**
 * Parse the RequestContext `toolsets` value. Accepts a comma-separated string
 * (what the exponential route sends, since its RequestContext entries are
 * strings) or an array. Returns undefined when absent, so callers can tell
 * "no selection" from "selected nothing beyond core" (empty array).
 */
export function parseToolsetSelection(value: unknown): ToolsetId[] | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value)
    ? value.map(String)
    : typeof value === 'string'
      ? value.split(',')
      : undefined;
  if (!raw) return undefined;
  const trimmed = raw.map((s) => s.trim()).filter((s) => s !== '');
  for (const s of trimmed) {
    if (!TOOLSET_ID_SET.has(s)) warnUnknownToolsetId(s);
  }
  const ids = trimmed.filter((s): s is ToolsetId => TOOLSET_ID_SET.has(s));
  return [...new Set(ids)];
}

/**
 * Unknown ids are ignored so the two repos can roll out independently, but a
 * rename on one side (e.g. `crm` → `contacts`) would otherwise silently stop
 * a generic-profile agent loading that toolset. Warn once per id per process
 * so the drift shows up in the logs without flooding them.
 *
 * The value comes from the RequestContext, which Mastra's HTTP API accepts
 * from any authenticated caller, so treat it as untrusted: the remembered set
 * is capped (a real drift is a handful of ids, not thousands), and ids are
 * truncated and stripped of control characters before they reach the logs.
 */
const MAX_WARNED_UNKNOWN_IDS = 50;
const MAX_LOGGED_ID_CHARS = 64;
const warnedUnknownToolsetIds = new Set<string>();

/** Printable, bounded rendering of a caller-supplied id for logs. */
export function sanitizeToolsetIdForLog(id: string): string {
  // eslint-disable-next-line no-control-regex
  const printable = id.replace(/[\u0000-\u001f\u007f]/g, '?');
  return printable.length > MAX_LOGGED_ID_CHARS
    ? `${printable.slice(0, MAX_LOGGED_ID_CHARS)}…`
    : printable;
}

function warnUnknownToolsetId(id: string): void {
  const key = sanitizeToolsetIdForLog(id);
  if (warnedUnknownToolsetIds.has(key)) return;
  if (warnedUnknownToolsetIds.size >= MAX_WARNED_UNKNOWN_IDS) return;
  warnedUnknownToolsetIds.add(key);
  console.warn(
    `⚠️ [toolsets] Ignoring unknown toolset id "${key}" — TOOLSET_IDS may have drifted from exponential's jevDecision.ts`,
  );
}

/** Test hook: forget which unknown ids have already been warned about. */
export function resetUnknownToolsetWarnings(): void {
  warnedUnknownToolsetIds.clear();
}

/** Group a flat tool map by TOOL_GROUPS. Unassigned keys are returned separately. */
export function groupTools<T>(tools: Record<string, T>): {
  groups: Partial<Record<ToolGroupId, Record<string, T>>>;
  unassigned: string[];
} {
  const groups: Partial<Record<ToolGroupId, Record<string, T>>> = {};
  const unassigned: string[] = [];
  for (const [key, tool] of Object.entries(tools)) {
    if (key === 'toolSearch') continue;
    const group = TOOL_GROUPS[key];
    if (!group) {
      unassigned.push(key);
      continue;
    }
    (groups[group] ??= {})[key] = tool;
  }
  return { groups, unassigned };
}

/**
 * Select the tool map for one request.
 *
 * `anthropic` returns `allTools` untouched. `generic` returns CORE plus the
 * selected toolsets, minus anything Anthropic-only. Unassigned tools are
 * treated as CORE in the generic profile, so a tool someone forgot to group
 * stays reachable instead of disappearing (the coverage test still fails).
 */
export function selectTools<T>(
  allTools: Record<string, T>,
  profile: ToolProfile,
  selection: ToolsetId[] | undefined,
): Record<string, T> {
  if (profile === 'anthropic') return allTools;

  const { groups, unassigned } = groupTools(allTools);
  const wanted = new Set<ToolGroupId>(['core', ...(selection ?? [])]);
  const out: Record<string, T> = {};
  for (const group of wanted) {
    for (const [key, tool] of Object.entries(groups[group] ?? {})) {
      if (!ANTHROPIC_ONLY_TOOL_KEYS.has(key)) out[key] = tool;
    }
  }
  for (const key of unassigned) {
    if (!ANTHROPIC_ONLY_TOOL_KEYS.has(key)) out[key] = allTools[key] as T;
  }
  return out;
}

interface RequestContextLike {
  get(key: string): unknown;
}

/**
 * Build the value for an Agent's `tools` option. Mastra calls it per request
 * with the RequestContext (DynamicArgument). With no RequestContext — agent
 * listing, the playground — it resolves as if nothing was selected.
 */
export function createToolsResolver<T>(
  allTools: Record<string, T>,
  profile: ToolProfile,
): (args: { requestContext?: RequestContextLike }) => Record<string, T> {
  return ({ requestContext } = {}) => {
    if (profile === 'anthropic') return allTools;
    const selection = parseToolsetSelection(requestContext?.get(TOOLSETS_CONTEXT_KEY));
    return selectTools(allTools, profile, selection);
  };
}

/**
 * The value to pass as an Agent's `tools` option. Use this, not
 * `createToolsResolver`, at agent definitions.
 *
 * `anthropic` returns the static map itself. That is not just an
 * optimisation: `@mastra/core` (1.28) only registers an agent's tools on the
 * Mastra instance (`mastra.addTool`, which backs `GET /api/tools`,
 * `/api/tools/:id/execute` and the Studio tools tab) and wires them into
 * voice when `tools` is a plain object. A function would silently drop them
 * from both, and the anthropic profile returns the same map every time
 * anyway. `generic` returns the per-request resolver.
 */
export function agentTools<T>(
  allTools: Record<string, T>,
  profile: ToolProfile,
): Record<string, T> | ((args: { requestContext?: RequestContextLike }) => Record<string, T>) {
  return profile === 'anthropic' ? allTools : createToolsResolver(allTools, profile);
}
