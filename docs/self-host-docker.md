# Running Mastra in Docker (self-host)

`docker/Dockerfile` builds the Mastra agent service for the self-host Docker
Compose stack in the Exponential app repo. Production on Railway does **not**
use it: Railway keeps building from `package.json` with its default builder
(`npm run build`, then `npm start`). The image runs the same two steps.

## Build and run

Build from the repo root. The build context is the whole repo, and the
Dockerfile lives under `docker/`:

```bash
docker build -f docker/Dockerfile -t mastra:local .

docker run --rm -p 4111:4111 \
  -e DATABASE_URL=postgresql://postgres:postgres@<db-host>:5432/<db> \
  -e AUTH_SECRET=<same value as the app> \
  -e OPENAI_API_KEY=<key> \
  -e ANTHROPIC_API_KEY=<key> \
  -e TODO_APP_BASE_URL=http://<app-host>:3000 \
  mastra:local
```

- **Lockfile:** the image installs with `npm ci` from `package-lock.json`, the
  same command and lockfile CI uses. `bun.lockb` is not used.
- **Base:** `node:22-bookworm` to build and `node:22-bookworm-slim` to run
  (`engines` asks for Node >= 22.13). It runs as the `node` user with
  `NODE_ENV=production`, which turns off the dev-only `EXPONENTIAL_TEST_JWT`
  fallback in `src/mastra/index.ts`.
- **Why `docker/`:** Railway switches a service to Dockerfile builds when it
  finds a `Dockerfile` at the repo root, and applies a root `.dockerignore` to
  its builds. Keeping both files under `docker/` leaves the production deploy
  unchanged. The ignore rules are in `docker/Dockerfile.dockerignore`, which
  BuildKit reads for this Dockerfile. They keep `node_modules`, `.env*`,
  `*.log` (including `mastra.log`), local databases and tooling directories out
  of the build context.
- **Compose:** point the `mastra` service at this repo with
  `dockerfile: docker/Dockerfile`.

## Environment

### Required

| Variable | What it is |
|---|---|
| `DATABASE_URL` | Postgres with the `vector` extension (for example `pgvector/pgvector:pg16`). It can be the app's own database: Mastra keeps its tables in the `mastra` schema and creates them at boot. Prisma owns `public`. |
| `AUTH_SECRET` | The app's `AUTH_SECRET` (shared with the app). Mastra verifies the app's JWTs with it (audience `mastra-agents`, issuer `todo-app`). If it is missing, tokens are decoded **without verification**, so always set it. |
| `OPENAI_API_KEY` | Used by the enrichment, expo and platform agents, and for embeddings. |
| `ANTHROPIC_API_KEY` | Used by the assistant run agent (agent runs), Zoe (chat) and observational memory. |
| `PORT` | HTTP port. The image sets `4111`, which the app's `MASTRA_API_URL` should point at. |
| `TODO_APP_BASE_URL` | Where Mastra's tools call the app back. Defaults to `http://localhost:3000`, which inside a container is the container itself, so set it to the app service (in Compose, for example `http://app:3000`). Mastra boots without it, but every tool call to the app fails. |

### Recommended

| Variable | Default | What it is |
|---|---|---|
| `TZ` | `Europe/Berlin` (scheduler only) | Timezone for the proactive scheduler's cron expressions. |

### Off unless you turn them on

With none of these set, the container starts only the API on 4111 and the
WhatsApp gateway's HTTP server on 4112, which stays idle until a user links a
session. Nothing connects to Telegram, Matrix, Signal or Vapi.

| Variable | Turns on | Also needs |
|---|---|---|
| `ENABLE_TELEGRAM_BOT=true` | Single-tenant curation Telegram bot | `CURATION_TELEGRAM_BOT_TOKEN` |
| `ENABLE_TELEGRAM_GATEWAY=true` | Multi-tenant Telegram gateway (port 4113) | `TELEGRAM_BOT_TOKEN` |
| `ENABLE_MATRIX_GATEWAY=true` | Matrix gateway | `MATRIX_HOMESERVER_URL`, `MATRIX_ACCESS_TOKEN`, `MATRIX_BOT_USER_ID` |
| `ENABLE_SIGNAL_GATEWAY=true` | Signal gateway | see `docs/signal-gateway.md` |
| `ENABLE_VOICE_GATEWAY=true` | Vapi voice gateway | `VAPI_API_KEY` |
| `ENABLE_CHANNEL_SUMMARIZER=true` | Periodic WhatsApp channel summaries posted to the app | a linked WhatsApp session |
| `MASTRA_ONE2B_AGENTS_ENABLED=true` | The One2b agents | |
| `MASTRA_TRACING=true` | AI tracing spans in `mastra.mastra_ai_spans` (on automatically when `RAILWAY_ENVIRONMENT_NAME` is set) | |
| `SENTRY_DSN` | Error reporting to Sentry | |

### On by default

| Variable | Default | Behaviour without a Telegram token |
|---|---|---|
| `ENABLE_PROACTIVE_SCHEDULER` | on (`false` turns it off) | It logs `No Telegram token - Telegram notifications disabled` and keeps running. Each tick (`PROACTIVE_MORNING_CRON` default `0 9 * * 1-5`, `PROACTIVE_EVENING_CRON` default `0 18 * * 1-5`) finds no paired users and finishes with `0 error(s)`. `TELEGRAM_BOT_TOKEN` or `TELEGRAM_GATEWAY_BOT_TOKEN` turns delivery on. |

### State on disk

Gateway pairings and sessions are written under `$HOME/.mastra`
(`/home/node/.mastra` in the image). Mount a volume there if you enable a
gateway and want pairings to survive a restart. `WHATSAPP_SESSIONS_DIR`,
`TELEGRAM_SESSIONS_DIR` and `SIGNAL_SESSIONS_DIR` move the individual
directories.

### Known limit

The CORS allowlist (`src/mastra/utils/cors-origins.ts`) only names
exponential.im and `http://localhost:3000`, so browser-to-Mastra calls (local
wiki streaming) do not work from another domain. Server-to-server calls from
the app are not affected.

## Quiet-boot check

`docker/boot-check.sh` boots an image against a throwaway
`pgvector/pgvector:pg16` container with only the required variables and
placeholder LLM keys. It checks that:

- `GET /api/agents` answers 200 on 4111
- the Telegram bot and the Telegram, Matrix, Signal and Voice gateways log that
  they are disabled
- the proactive scheduler, forced to tick every minute, completes a run without
  a Telegram token, and the container is still up afterwards

```bash
docker build -f docker/Dockerfile -t mastra:local .
docker/boot-check.sh mastra:local   # prints PASS: quiet boot
```

It removes everything it starts when it exits.
