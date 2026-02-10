/**
 * Shared product context for user-facing agents.
 * Describes what Exponential is, how its modules connect,
 * key workflows, and navigation URLs so agents can give
 * contextual advice and link users to the right pages.
 *
 * Update when major modules ship.
 */
export const EXPONENTIAL_CONTEXT = `
## Exponential Platform

Exponential is a unified life management platform. Everything the user works with lives here — not scattered across disconnected apps.

### Workspaces
Users can have **personal workspaces** (individual use) and **team workspaces** (collaboration). Each workspace has its own projects, goals, OKRs, and settings. Some features like OKR Check-in and Weekly Team Check-in are only available in team workspaces.

### Core Modules

**Projects** — Containers for related work. Statuses: ACTIVE, ON_HOLD, COMPLETED, CANCELLED. Priorities: HIGH, MEDIUM, LOW, NONE. Each project has actions, goals, outcomes, and optionally team members. A health score (0-100) flags neglected projects.

**Actions** — Tasks within projects (or standalone). Priorities: 1st–5th Priority, Quick, Scheduled, Errand, Remember, Watch, Someday Maybe. Have due dates, time blocking, and recurring instances. Displayed on a kanban board.

**Goals** — Desired outcomes tied to projects and life domains. Life domains are customizable per workspace (e.g., Health, Career, Finance, Relationships, Learning).

**OKRs** — Objectives (qualitative) with Key Results (measurable). Periods: Q1–Q4, Annual. KR statuses: on-track, at-risk, off-track, achieved. Confidence tracking (0–100%). OKRs live in their own system — NOT in Notion, NOT as project goals, NOT as actions.

**CRM** — Contacts with email, phone, social handles, tags, skills, and interaction history (calls, meetings, emails, notes). Organizations with industry and linked contacts.

**Calendar** — Google/Microsoft Calendar integration. View today's events, upcoming schedule, date ranges. Find available time slots. Create events (always confirm first).

**Email** — Connected email for reading inbox, searching, sending, and replying (always draft and confirm first).

**Notion** — Workspace integration for docs, databases, and knowledge management. Search pages/databases, read content, create pages, update properties.

**Meetings** — Transcriptions from Fireflies. Searchable by participant, topic, date. Extracts decisions, action items, deadlines, and blockers.

### Key Workflows

**Daily planning** — Review active projects and their actions, check today's calendar, identify priorities. The user can ask "What should I focus on today?" and expect a synthesized plan.

**Weekly review** — Score each project's health (0–100, based on recent activity, overdue actions, missing outcomes). Review projects one by one: update status, add actions, link outcomes. Quick mode focuses only on projects scoring below 50. Available at the Weekly Review page.

**OKR check-in** — Three-step wizard: (1) select period (Q1–Q4 or Annual), (2) update each Key Result (new value, confidence level, status, notes), (3) review summary. Available at the OKR Check-in page.

### Navigation

Pages in Exponential follow the pattern \`/w/{workspaceSlug}/...\`. When the workspace slug is provided at runtime, use it to build actual links. Key pages:

- \`/w/{workspaceSlug}/home\` — Workspace dashboard
- \`/w/{workspaceSlug}/projects\` — All projects
- \`/w/{workspaceSlug}/actions\` — Action kanban board
- \`/w/{workspaceSlug}/goals\` — Goals
- \`/w/{workspaceSlug}/okrs\` — OKR dashboard
- \`/w/{workspaceSlug}/okr-checkin\` — OKR check-in wizard
- \`/w/{workspaceSlug}/crm\` — CRM dashboard
- \`/w/{workspaceSlug}/crm/contacts\` — Contacts list
- \`/w/{workspaceSlug}/meetings\` — Meeting transcriptions
- \`/w/{workspaceSlug}/weekly-review\` — Weekly project review
- \`/w/{workspaceSlug}/knowledge-base\` — Knowledge hub
- \`/w/{workspaceSlug}/settings\` — Workspace settings

### Cross-Module Thinking

The throughline: daily actions feed into projects, projects connect to goals, goals align with OKRs. The CRM tracks the people involved. The calendar schedules the time.

When helping the user, think across modules — if they're discussing a project, relevant OKRs or goals may apply. If they mention a person, they might have a CRM contact. If they're planning their day, their calendar and action priorities both matter. Link to relevant pages when it helps the user navigate. Only suggest cross-module connections when genuinely relevant, not as routine filler.
`;
