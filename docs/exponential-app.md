# Exponential App Reference

Reference for the Exponential application — the primary client app that calls into this Mastra backend. Use this doc instead of exploring the Exponential codebase (`/Users/james/code/exponential`).

## Architecture

- **Stack**: Next.js 15 App Router, tRPC, Prisma, Mantine UI, NextAuth.js v5
- **Multi-tenant**: workspace-scoped routes under `/w/[workspaceSlug]/...`
- **Mastra integration**: Calls Mastra agents via two paths:
  1. **Streaming** (`/api/chat/stream/route.ts`) — main chat UI, uses `MastraClient.stream()`
  2. **Generate** (`server/api/routers/mastra.ts` → `callAgent` mutation) — non-streaming, uses `fetch()` to Mastra's `/api/agents/{id}/generate`

## RequestContext Passed to Agents

Both chat paths build a `requestContext` with these keys:

| Key | Type | Source | Description |
|-----|------|--------|-------------|
| `authToken` | string | JWT | Agent JWT for callback API auth |
| `userId` | string | session | Current user ID |
| `userEmail` | string | session | Current user email |
| `todoAppBaseUrl` | string | env | Base URL of Exponential app (e.g. `http://localhost:3000`) |
| `notionAccessToken` | string? | DB | User's decrypted Notion OAuth token (if connected) |
| `workspaceId` | string? | frontend | Current workspace ID |
| `workspaceSlug` | string? | DB lookup | Workspace slug for URL construction |
| `workspaceName` | string? | DB lookup | Workspace display name |
| `workspaceType` | string? | DB lookup | `"personal"`, `"team"`, or `"organization"` |
| `projectId` | string? | frontend | Project context (when chatting from a project page) |

Additionally, a **system message** is prepended to all agent calls when a workspace is active, providing the workspace slug and base URL so agents can construct navigation links.

## Workspace Model

- **Personal** — individual use, shows alignment section (Goals, OKRs, Wheel of Life)
- **Team** — collaboration, includes OKR Check-in, Weekly Team Check-in
- **Organization** — larger orgs (similar to team)
- Users access workspace via `useWorkspace()` hook which reads `workspaceSlug` from URL params
- Sidebar navigation adapts based on workspace type

## Route Structure

All workspace-scoped routes: `/w/[workspaceSlug]/...`

| Route | Page |
|-------|------|
| `/w/{slug}/home` | Workspace dashboard |
| `/w/{slug}/projects` | Projects list |
| `/w/{slug}/projects/[projectSlug]` | Project detail (slug format: `{name}-{id}`) |
| `/w/{slug}/projects-tasks` | Projects tasks view |
| `/w/{slug}/actions` | Action kanban board |
| `/w/{slug}/goals` | Goals management |
| `/w/{slug}/okrs` | OKR dashboard |
| `/w/{slug}/okr-checkin` | OKR check-in wizard (team workspaces only) |
| `/w/{slug}/outcomes` | Outcomes dashboard |
| `/w/{slug}/alignment` | Alignment overview (personal workspaces) |
| `/w/{slug}/crm` | CRM dashboard |
| `/w/{slug}/crm/contacts` | Contacts list |
| `/w/{slug}/crm/contacts/[id]` | Contact detail |
| `/w/{slug}/crm/organizations` | Organizations list |
| `/w/{slug}/crm/organizations/[id]` | Organization detail |
| `/w/{slug}/meetings` | Meeting transcriptions |
| `/w/{slug}/weekly-review` | Weekly project review |
| `/w/{slug}/weekly-team-checkin` | Weekly team check-in |
| `/w/{slug}/knowledge-base` | Knowledge hub |
| `/w/{slug}/settings` | Workspace settings |
| `/w/{slug}/timeline` | Timeline view |
| `/w/{slug}/views` | Custom views |

Global (non-workspace) routes: `/days`, `/videos`, `/journal`, `/meetings`, `/workflows`, `/alignment`, `/wheel-of-life`, `/settings`, `/teams`

## Data Model Concepts

### Projects
- **Statuses**: ACTIVE, ON_HOLD, COMPLETED, CANCELLED
- **Priorities**: HIGH, MEDIUM, LOW, NONE
- Have actions, goals, outcomes, team members
- **Health score** (0–100): starts at 100, deductions for no active action (-30), no recent activity (-25), overdue actions (-20), no linked outcome (-15), STUCK/BLOCKED status (-10), no end date (-15), no description (-10)

### Actions (Tasks)
- **Priorities**: 1st Priority, 2nd Priority, 3rd Priority, 4th Priority, 5th Priority, Quick, Scheduled, Errand, Remember, Watch, Someday Maybe
- **Statuses**: ACTIVE, COMPLETED, DONE, CANCELLED
- Features: due dates, time blocking (scheduledStart/scheduledEnd), recurring instances, task chunking
- Displayed on kanban board, groupable by Status, Priority, Assignee, Project, Due Date

### Goals
- Tied to projects and life domains
- **Life domains**: customizable per workspace (e.g., Health, Career, Finance, Relationships, Learning)
- Each domain has a title and color

### OKRs
- **Objectives**: qualitative goals
- **Key Results**: measurable outcomes linked to objectives
- **Periods**: Q1-YYYY, Q2-YYYY, Q3-YYYY, Q4-YYYY, Annual-YYYY (also combined views like Q1-Annual-YYYY)
- **KR statuses**: not-started, on-track, at-risk, off-track, achieved
- **KR fields**: title, description, startValue, currentValue, targetValue, unit (percent/count/currency/hours/custom), unitLabel, confidence (0–100)
- **Check-ins**: track previousValue → newValue with notes and timestamp

### CRM
- **Contacts**: name, email, phone, social handles, tags, skills, about, interaction history
- **Organizations**: name, industry, size, linked contacts
- **Interactions**: type (call/email/meeting/note), subject, notes, date

### Outcomes
- Linked to projects and goals
- **Statuses**: NOT_STARTED, IN_PROGRESS, COMPLETED, BLOCKED
- Types: daily, weekly, monthly, quarterly

## Key Workflows

### Daily Planning
User asks "What should I focus on today?" — agent should:
1. Fetch all active projects (`get-all-projects`)
2. Fetch actions for each active project (`get-project-actions`)
3. Check calendar (`get-today-calendar-events`)
4. Fetch goals (`get-all-goals`)
5. Synthesize: overdue items, due today, priority ranking

### Weekly Review
Available at `/w/{slug}/weekly-review`. Two modes:
- **Quick mode**: reviews only projects with health score < 50
- **Full mode**: reviews all active projects

For each project, the user reviews: status, priority, actions, outcomes. Can update status, add actions, link outcomes. Tracks streak of completed reviews.

### OKR Check-in
Available at `/w/{slug}/okr-checkin` (team workspaces). Three steps:
1. **Period selection**: pick Q1–Q4 or Annual, see stats overview
2. **KR wizard**: update each KR one at a time — new value, confidence (slider 0–100%, color-coded), status override (On Track/At Risk/Off Track/Achieved), notes
3. **Summary**: review all check-ins, option to restart

### Assistant Personality Injection
When `assistantId` is provided, the Exponential app:
1. Fetches the custom assistant record (name, emoji, personality, instructions, userContext)
2. Routes to `assistantAgent` (not the originally selected agent)
3. Prepends a system message with the personality overlay
4. The `assistantAgent` instructions say to follow personality from system messages

## Chat Integration Details

### ManyChat Component (`src/app/_components/ManyChat.tsx`)
- Main chat UI component
- Gets `workspaceId` from `pageContext.data.workspaceId` (set by workspace layout)
- Sends to `/api/chat/stream`: `{ messages, agentId, assistantId, workspaceId, projectId, conversationId }`
- Streams response via text-delta chunks
- Trims to last 40 messages to avoid context overflow

### Page Context System
Each workspace page registers context via `useRegisterPageContext()`:
- `pageType`: e.g., 'workspace', 'project', etc.
- `pageTitle`: display name
- `data`: includes `workspaceId`, `workspaceName`, `workspaceSlug`

This context is available to the chat component so it can send workspace/project info with agent calls.
