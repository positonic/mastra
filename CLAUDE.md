# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Mandatory Workflow: Plan First with Beads

**This is the most important rule in this repository.** Never jump straight into coding. Every task follows this workflow:

1. **Plan first** — Break the work into beads issues (`bd create`) before writing any code. Structure the plan as a dependency graph so tasks can be worked sequentially.
2. **Execute sequentially** — Work through beads one at a time: `bd ready` to find the next unblocked issue, `bd update <id> --status in_progress` to claim it, do the work, then `bd close <id>`.
3. **Never skip planning** — Even for "small" tasks, create at least one bead. The plan is the source of truth for what we're doing and why.

**Quick reference:**
```bash
# Planning phase
bd create --title="Step 1: ..." --type=task --priority=2
bd create --title="Step 2: ..." --type=task --priority=2
bd dep add <step2-id> <step1-id>   # step2 depends on step1

# Execution phase
bd ready                            # what's next?
bd update <id> --status in_progress # claim it
# ... do the work ...
bd close <id>                       # done
bd ready                            # next?

# Session end
bd sync && git push
```

**Do NOT use TodoWrite for task tracking.** All task tracking goes through beads (`bd`).

See [AGENTS.md](AGENTS.md) for session completion protocol and full beads reference.

## Development Commands

- `bun run dev` - Start development server using Mastra CLI (port 4111)
- `bun run dev:log` - Start with logging to mastra.log (recommended for debugging)
- `bun run logs` - View real-time logs from mastra.log
- `bun run build` - Build the project using Mastra CLI
- `bun start` - Start the built application from `.mastra/output/index.mjs`
- `bun install` - Use Bun as package manager

### Debugging with Claude Code

Run `bun run dev:log` to capture logs to `mastra.log` for troubleshooting. The log file captures both stdout and stderr.

## Architecture Overview

This is a Mastra-based multi-agent application with external integrations (WhatsApp, Telegram, Slack, Binance, external APIs). The primary client is the **Exponential app** — see [docs/exponential-app.md](docs/exponential-app.md) for its route structure, data model, workflows, and how it calls Mastra agents.

### Entry Point and Initialization

[src/mastra/index.ts](src/mastra/index.ts) - Creates the Mastra instance, registers agents, initializes the Telegram bot and WhatsApp gateway, and sets up graceful shutdown handlers (SIGINT, SIGTERM, uncaughtException, unhandledRejection).

### Agents

All agents are defined in [src/mastra/agents/index.ts](src/mastra/agents/index.ts):

| Agent | Name | Model | Purpose |
|-------|------|-------|---------|
| `weatherAgent` | Weather Agent | GPT-4o | Weather information with location recommendations |
| `ashAgent` | Ash Maurya Agent | GPT-4o | Lean Startup business modeling advisor |
| `pierreAgent` | Pierre | GPT-4o-mini | Crypto trend-following trading mentor with RAG |
| `projectManagerAgent` | Paddy | GPT-4o-mini | Project/task management with Slack and meeting integrations |
| `expoAgent` | Expo | GPT-4o | Exponential app knowledge expert with RAG (docs + Prisma schema) |

The `curationAgent` (Lin) is defined separately in [src/mastra/agents/ostrom-agent.ts](src/mastra/agents/ostrom-agent.ts) for Curation Platform analysis via MCP server (currently disabled).

The `expoAgent` (Expo) is defined in [src/mastra/agents/expo-agent.ts](src/mastra/agents/expo-agent.ts) with knowledge indexed from the Exponential app's docs and Prisma schema. Re-index with `npx tsx src/mastra/rag/exponential-setup.ts`.

### Tools

Defined in [src/mastra/tools/index.ts](src/mastra/tools/index.ts). All tools use Zod schemas for validation.

**Market Data Tools:**
- `binancePriceTool` - Real-time crypto prices
- `binanceCandlestickTool` - Multi-timeframe candlesticks (1d/4h/1h) with calculated MAs (EMA13/25/32, MA100/300, EMA200)

**RAG Tools:**
- `pierreTradingQueryTool` - Vector search against Pierre's trading knowledge base (PostgreSQL + pgvector)
- `queryExponentialDocsTool` - Vector search against Exponential app docs + Prisma schema (839 chunks)

**Project Management Tools** (require `authToken` in runtimeContext):
- `getProjectContextTool`, `getProjectActionsTool`, `createProjectActionTool`, `updateProjectStatusTool`
- `getProjectGoalsTool`, `getAllGoalsTool`, `getAllProjectsTool`
- `getMeetingTranscriptionsTool`, `queryMeetingContextTool`, `getMeetingInsightsTool`

**Slack Tools:**
- `sendSlackMessageTool`, `updateSlackMessageTool`, `getSlackUserInfoTool`

**Weather:**
- `weatherTool` - Open-Meteo API for weather data

### Telegram Bot (Curation)

[src/mastra/bots/ostrom-telegram.ts](src/mastra/bots/ostrom-telegram.ts) - Single-tenant bot that polls Telegram and routes messages to `curationAgent`. Features retry logic with exponential backoff for 409 conflicts, message chunking (4096 char limit), and graceful shutdown. Gated behind `ENABLE_TELEGRAM_BOT=true`.

### Telegram Gateway (Multi-Tenant)

[src/mastra/bots/telegram-gateway.ts](src/mastra/bots/telegram-gateway.ts) - Multi-tenant Telegram gateway for Exponential app users. A single shared bot allows any user to pair their Telegram account and converse with their `assistantAgent`. Gated behind `ENABLE_TELEGRAM_GATEWAY=true`.

**API Endpoints (port 4113):**
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/pair` | Generate pairing code. Body: `{ agentId?, assistantId?, workspaceId? }`. Returns `{ pairingCode, botUsername }` |
| `DELETE` | `/pair` | Unpair user's Telegram account |
| `GET` | `/status` | Returns `{ paired, telegramUsername?, agentId?, lastActive? }` |
| `PUT` | `/settings` | Update agent/assistant selection. Body: `{ agentId?, assistantId? }` |

All endpoints require `Authorization: Bearer {JWT}` header (same JWT format as WhatsApp gateway).

**Pairing Flow:**
1. Exponential app calls `POST /pair` with authToken → gets `{ pairingCode, botUsername }`
2. User opens Telegram, finds the bot, sends `/start CODE`
3. Bot validates code, links Telegram chat to Exponential user, stores encrypted auth token
4. User can now message the bot to interact with their assistant agent

**Bot Commands:**
- `/start CODE` — Complete account pairing
- `/disconnect` — Unlink Telegram account
- `/agent NAME` — Switch default agent (assistant, zoe, paddy, pierre, ash, weather)
- `/help` — Show available commands
- `@mention` inline — Route message to a specific agent (e.g., `@paddy what are my tasks?`)

**Session Storage:** `~/.mastra/telegram-sessions/telegram-mappings.json` maps Telegram chat IDs to Exponential users with encrypted auth tokens.

### WhatsApp Gateway (Multi-Tenant)

[src/mastra/bots/whatsapp-gateway.ts](src/mastra/bots/whatsapp-gateway.ts) - Multi-tenant WhatsApp gateway using Baileys. Each authenticated user can connect their own WhatsApp via QR code. Messages route to `projectManagerAgent` (Paddy).

**API Endpoints (port 4112):**
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/login` | Start login, returns `{ sessionId }` |
| `GET` | `/login/{id}/qr` | Returns QR code as PNG image |
| `GET` | `/login/{id}/status` | Returns `{ connected, phoneNumber, qrAvailable }` |
| `GET` | `/sessions` | List user's sessions |
| `DELETE` | `/sessions/{id}` | Disconnect session |

All endpoints require `Authorization: Bearer {JWT}` header. The JWT must be signed with `AUTH_SECRET` and include:
- `userId` or `sub` claim for user identification
- `aud: "whatsapp-gateway"` audience
- `iss: "todo-app"` issuer

**Session Storage:** `~/.mastra/whatsapp-sessions/` contains per-session Baileys credentials and `sessions.json` metadata.

**User Flow:**
1. Client calls `POST /login` with authToken → gets sessionId
2. Client displays QR from `GET /login/{sessionId}/qr`
3. User scans QR with WhatsApp (Linked Devices)
4. Client polls `GET /login/{sessionId}/status` until connected
5. Messages from user's WhatsApp → routed to Paddy with their authToken

### RAG System

[src/mastra/rag/setup.ts](src/mastra/rag/setup.ts) - PostgreSQL with pgvector, OpenAI text-embedding-3-small (1536 dimensions). Knowledge base stored in `pierre_docs` table with cosine similarity search.

### Workflows

[src/mastra/workflows/index.ts](src/mastra/workflows/index.ts) - `weatherWorkflow` demonstrates multi-step workflows with streaming responses.

### Environment Variables

Key variables (see documentation in `/docs` for setup details):
- `OPENAI_API_KEY` - OpenAI API access
- `DATABASE_URL` - PostgreSQL with pgvector
- `TODO_APP_BASE_URL` - Project management API endpoint
- `SLACK_BOT_TOKEN` - Slack integration
- `CURATION_TELEGRAM_BOT_TOKEN` - Telegram bot token (curation bot)
- `CURATION_CLIENT_TOKEN` - Curation Platform MCP auth
- `TELEGRAM_BOT_TOKEN` - Shared Telegram bot token (multi-tenant gateway)
- `TELEGRAM_GATEWAY_PORT` - Telegram gateway HTTP API port (default: 4113)
- `ENABLE_TELEGRAM_GATEWAY` - Enable multi-tenant Telegram gateway (default: false)
- `WHATSAPP_GATEWAY_PORT` - WhatsApp gateway port (default: 4112)
- `WHATSAPP_MAX_SESSIONS` - Max concurrent WhatsApp sessions (default: 10)
- `AUTH_SECRET` - JWT signing secret (must match client app's secret for gateway auth)
- `GATEWAY_SECRET` - Shared secret for token refresh (falls back to `WHATSAPP_GATEWAY_SECRET`)

### Server Configuration

Mastra runs on port 4111 by default (or `PORT` env var), bound to `0.0.0.0` for Railway deployment. API endpoints follow pattern: `/api/agents/{agentName}/text`. WhatsApp gateway runs on port 4112. Telegram gateway runs on port 4113.

### Key Patterns

**Tool Authentication:** Project management tools extract `authToken` from `runtimeContext` for API calls to the TODO app.

**Agent Instructions:** Agents use detailed system prompts with structured response formats (e.g., Pierre's mandatory market analysis format).

**Debug Logging:** Tools include extensive console logging prefixed with emojis for easy filtering.
