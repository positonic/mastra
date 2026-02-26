# Signal Gateway

Multi-tenant Signal gateway for Exponential app users. Uses `signal-cli` in daemon mode (JSON-RPC + SSE).

## Architecture

```
Signal app ↔ Signal servers ↔ signal-cli daemon ↔ Signal Gateway ↔ Mastra Agents
                                (JSON-RPC/SSE)        (port 4114)
```

## Prerequisites

1. **signal-cli** installed on the server ([releases](https://github.com/AsamK/signal-cli/releases))
2. A **dedicated phone number** for the bot (recommended)
3. Signal account registered or linked via signal-cli

### Register a bot number

```bash
# Native build (no JRE needed)
signal-cli -a +15551234567 register
signal-cli -a +15551234567 verify <CODE>

# Or link to existing Signal account
signal-cli link -n "Exponential Bot"
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ENABLE_SIGNAL_GATEWAY` | Yes | `false` | Set to `true` to enable |
| `SIGNAL_ACCOUNT` | Yes | — | Bot phone number (E.164: `+15551234567`) |
| `SIGNAL_CLI_PATH` | No | `signal-cli` | Path to signal-cli binary |
| `SIGNAL_CLI_HTTP_URL` | No | — | External daemon URL (skips auto-start) |
| `SIGNAL_AUTO_START` | No | `true` | Auto-spawn signal-cli daemon |
| `SIGNAL_GATEWAY_PORT` | No | `4114` | HTTP API port |
| `SIGNAL_SESSIONS_DIR` | No | `~/.mastra/signal-sessions` | Session storage path |
| `AUTH_SECRET` | Yes | — | JWT signing secret (shared with Exponential app) |

## API Endpoints (port 4114)

All endpoints except `/health` require `Authorization: Bearer {JWT}`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check (no auth) |
| `POST` | `/pair` | Generate pairing code. Body: `{ agentId? }` |
| `DELETE` | `/pair` | Unpair user's Signal account |
| `GET` | `/status` | Check pairing status |
| `PUT` | `/settings` | Update agent. Body: `{ agentId }` |

## Pairing Flow

1. Exponential app calls `POST /pair` with JWT → gets `{ pairingCode, botNumber }`
2. User sends the code to the bot number on Signal (or types `/start CODE`)
3. Gateway validates code, links Signal number to Exponential user
4. User can now message the bot to interact with their agent

## Signal Commands

| Command | Description |
|---------|-------------|
| `/start CODE` | Complete account pairing |
| `/disconnect` | Unlink Signal account |
| `/agent NAME` | Switch agent (assistant, zoe, paddy, pierre, ash, weather) |
| `/help` | Show available commands |
| `@mention` | Route message to specific agent (e.g., `@paddy what are my tasks?`) |

## Daemon Modes

### Auto-start (default)

Gateway spawns `signal-cli daemon --http` automatically. Requires `SIGNAL_ACCOUNT` and `SIGNAL_CLI_PATH`.

### External daemon

Run signal-cli yourself and point the gateway at it:

```bash
# Start daemon manually
signal-cli -a +15551234567 daemon --http 127.0.0.1:4214 --receive-mode=on-connection

# Configure gateway
SIGNAL_CLI_HTTP_URL=http://127.0.0.1:4214
SIGNAL_AUTO_START=false
```

## Deployment (Railway)

Add to your Railway service:

```env
ENABLE_SIGNAL_GATEWAY=true
SIGNAL_ACCOUNT=+15551234567
SIGNAL_CLI_PATH=/opt/signal-cli/bin/signal-cli
SIGNAL_SESSIONS_DIR=/data/signal-sessions
```

Note: signal-cli requires persistent storage for cryptographic keys. Mount a volume at the signal-cli data directory (`~/.local/share/signal-cli/`).

## Session Storage

Mappings are stored in `$SIGNAL_SESSIONS_DIR/signal-mappings.json`:

```json
[
  {
    "userId": "expo-user-id",
    "signalNumber": "+15557654321",
    "agentId": "assistant",
    "encryptedToken": "...",
    "pairedAt": "2026-02-25T...",
    "lastActive": "2026-02-25T..."
  }
]
```
