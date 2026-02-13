# PM Agent Tools — Developer Guide

## Overview

Sprint analytics tools for the Paddy agent (`projectManagerAgent`). These tools let Paddy track sprint progress, detect risks, and compose standup/wrapup messages. They work by calling Exponential's `sprintAnalytics.*` tRPC endpoints via `authenticatedTrpcCall()`.

All five tools are defined in a single file, exported through the barrel index, and registered on the Paddy agent alongside its existing project-management, calendar, and CRM toolset.

## Architecture / Data Flow

```
User (WhatsApp/Chat)
  │
  ▼
Paddy Agent (projectManagerAgent)
  │
  ▼
PM Tool (createTool, Zod-validated I/O)
  │
  ▼
authenticatedTrpcCall()          ◄── src/mastra/utils/authenticated-fetch.ts
  │  POST /api/trpc/sprintAnalytics.*
  │  Authorization: Bearer <authToken>
  ▼
Exponential tRPC Router
  │
  ▼
SprintAnalyticsService / GitHubActivityService
  │
  ▼
PostgreSQL
```

`authenticatedTrpcCall()` wraps `fetch()` with:

- Bearer token from Mastra's `requestContext`
- Automatic 401 retry with token refresh (via WhatsApp gateway refresh endpoint)
- tRPC / SuperJSON response unwrapping

## Tool Reference

| Tool ID | Export Name | tRPC Endpoint | Input | Description |
|---------|------------|---------------|-------|-------------|
| `get-active-sprint` | `getActiveSprintTool` | `sprintAnalytics.getActiveSprint` | `{ workspaceId }` | Find active sprint for a workspace. Returns sprint name, date range, action count. Start here for any sprint query. |
| `get-sprint-metrics` | `getSprintMetricsTool` | `sprintAnalytics.getMetrics` | `{ listId }` | Velocity, kanban counts (BACKLOG/TODO/IN_PROGRESS/IN_REVIEW/DONE/CANCELLED), completion rate, scope creep. |
| `get-risk-signals` | `getRiskSignalsTool` | `sprintAnalytics.getRiskSignals` | `{ listId }` | Detect 5 risk types: `scope_creep`, `stale_items` (IN_PROGRESS 3+ days), `overdue`, `blocked`, `velocity_drop`. |
| `get-github-activity` | `getGitHubActivityTool` | `sprintAnalytics.getGitHubActivity` | `{ workspaceId, since }` | Activity summary since a date: commits, PRs opened/merged, reviews, mapped/unmapped counts. |
| `capture-daily-snapshot` | `captureDailySnapshotTool` | `sprintAnalytics.captureDailySnapshot` | `{ listId }` | Capture daily sprint state for burndown tracking. Records kanban counts and GitHub activity. Use during evening wrapup. |

### Input/Output Schemas

**get-active-sprint**

```typescript
// Input
{ workspaceId: string }

// Output (nullable — null when no active sprint exists)
{
  id: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  actionCount: number;
}
```

**get-sprint-metrics**

```typescript
// Input
{ listId: string }  // sprint list ID from get-active-sprint

// Output
{
  sprintId: string;
  sprintName: string;
  startDate: string | null;
  endDate: string | null;
  plannedEffort: number;
  completedEffort: number;
  velocity: number;
  plannedActions: number;
  completedActions: number;
  addedActions: number;          // scope creep indicator
  kanbanCounts: Record<string, number>;  // e.g. { BACKLOG: 3, IN_PROGRESS: 5, DONE: 12 }
  completionRate: number;        // percentage
}
```

**get-risk-signals**

```typescript
// Input
{ listId: string }

// Output
Array<{
  type: string;        // "scope_creep" | "stale_items" | "overdue" | "blocked" | "velocity_drop"
  severity: "low" | "medium" | "high" | "critical";
  message: string;
  actionIds?: string[];
}>
```

**get-github-activity**

```typescript
// Input
{
  workspaceId: string;
  since: string;       // ISO date — use yesterday for standups, sprint start for reviews
}

// Output
{
  totalCommits: number;
  totalPRsOpened: number;
  totalPRsMerged: number;
  totalReviews: number;
  mappedCount: number;    // GitHub activity mapped to Exponential actions
  unmappedCount: number;  // GitHub activity without an associated action
}
```

**capture-daily-snapshot**

```typescript
// Input
{ listId: string }

// Output
{
  snapshotId: string;
  date: string;
  kanbanCounts: Record<string, number>;
  actionsCompleted: number;
}
```

## Files

| File | Purpose |
|------|---------|
| `src/mastra/tools/pm-tools.ts` | 5 PM tool definitions using `createTool()` with Zod schemas |
| `src/mastra/tools/index.ts` | Barrel re-export of all PM tools |
| `src/mastra/agents/index.ts` | Paddy agent definition — PM tools registered in the `tools` map and sprint instructions added to system prompt |
| `src/mastra/utils/authenticated-fetch.ts` | `authenticatedTrpcCall()` / `authenticatedTrpcQuery()` — handles Bearer auth, 401 retry, tRPC unwrapping |

## Authentication

All tools extract three values from Mastra's `requestContext` (set by the WhatsApp gateway or chat API when a user sends a message):

```typescript
const authToken = requestContext?.get("authToken") as string | undefined;
const sessionId = requestContext?.get("whatsappSession") as string | undefined;
const userId    = requestContext?.get("userId") as string | undefined;
```

- `authToken` (required) — passed as `Authorization: Bearer <token>` via `authenticatedTrpcCall()`
- `sessionId` (optional) — used for automatic token refresh on 401
- `userId` (optional) — used for Sentry error context

The Exponential tRPC endpoints accept authentication via:

- **Session JWT** (Bearer token) — used for user-initiated requests through agents
- **API key** (`x-api-key` header) — used for server-to-server/scheduler calls

If the Bearer token returns a 401 and a `sessionId` is available, `authenticatedFetch()` automatically attempts a token refresh through Exponential's `/api/whatsapp-gateway/refresh-token` endpoint and retries the request.

## Paddy System Instructions

Three instruction blocks were added to the `projectManagerAgent` system prompt to teach Paddy how and when to use the PM tools.

### Sprint Tools Reference

Lists all 5 tools with their IDs and one-line descriptions under the "Sprint Analytics & Development Tracking" heading (tools 17–21 in the numbered list in the Enhanced Tools Usage section).

### Sprint Query Routing

Maps user intents to tool call sequences:

| User Intent | Tool Sequence |
|-------------|---------------|
| "Sprint status" / "Sprint update" | `get-active-sprint` → `get-sprint-metrics` → `get-risk-signals` |
| "Morning standup" / "Give me a standup" | `get-active-sprint` → `get-sprint-metrics` + `get-github-activity` (since yesterday) + `get-risk-signals` |
| "Evening wrapup" / "End of day summary" | Same as standup + `capture-daily-snapshot` |
| "Sprint review" / "How did the sprint go?" | `get-sprint-metrics` + `get-github-activity` (since sprint start) + `get-risk-signals` |
| "Any risks?" / "What's at risk?" | `get-risk-signals` (flag high/critical immediately) |

### Message Formats

Defined structured output formats for three cadences:

**Morning Standup**

1. Sprint Health — completion rate, velocity, days remaining
2. Yesterday's Progress — GitHub activity (commits, PRs merged), actions completed
3. Risk Alerts — high/critical risk signals (stale items, overdue, blocked)
4. Today's Focus — top priority actions still in progress or upcoming

**Evening Wrapup**

1. Today's Accomplishments — actions completed, PRs merged, commits pushed
2. Sprint Progress — updated completion rate, burndown trend
3. Slippage/Blockers — anything that slipped or is now at risk
4. Tomorrow's Focus — what should be tackled next
5. Capture a daily snapshot for burndown tracking

**Risk Escalation**

- High/critical severity signals are flagged prominently at the top of any standup/wrapup
- Specific mitigation recommendations are included (e.g., "Action X has been in progress for 5 days — consider breaking it down or reassigning")
- For scope creep, the number of actions added after sprint start is noted

## Adding a New PM Tool

To add a new sprint-related tool:

1. Define the tool in `src/mastra/tools/pm-tools.ts` using `createTool()` with:
   - A unique `id` (kebab-case)
   - A `description` that tells the LLM when to use it
   - Zod `inputSchema` and `outputSchema`
   - An `execute` function that calls `authenticatedTrpcCall()` with the corresponding tRPC endpoint

2. Export the tool from `src/mastra/tools/index.ts`:
   ```typescript
   export { myNewTool } from "./pm-tools.js";
   ```

3. Import and register on the Paddy agent in `src/mastra/agents/index.ts`:
   - Add to the import statement
   - Add to the `tools` map in the `projectManagerAgent` definition

4. Update Paddy's system prompt instructions:
   - Add the tool to the "Sprint Analytics & Development Tracking" numbered list
   - Add relevant query routing rules under "Sprint Queries"
   - Update message formats if the tool produces data that should appear in standups/wrapups

5. Ensure the corresponding tRPC endpoint exists in the Exponential backend under the `sprintAnalytics` router.

## PMScheduler (Planned — Phase 5)

The PMScheduler will be a node-cron service in Mastra that:

1. Reads PM preferences (standup/wrapup times) from Exponential's `PMAgentConfig`
2. At scheduled times, calls the PM tools to gather sprint data
3. Invokes the Paddy agent with the gathered context to compose a standup/wrapup message
4. Sends the message via the WhatsApp gateway

This has not been implemented yet. See the main plan in the Exponential repo for Phase 5 details.
