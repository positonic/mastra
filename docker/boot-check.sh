#!/usr/bin/env bash
# Quiet-boot check for the Mastra image (docker/Dockerfile).
#
# Boots the image against a throwaway pgvector/pgvector:pg16 container with
# only the required env (DATABASE_URL, AUTH_SECRET, dummy OpenAI/Anthropic
# keys, PORT=4111) and asserts:
#   - the server answers GET /api/agents with 200 on 4111
#   - the Telegram bot, Telegram/Matrix/Signal/Voice gateways log "disabled"
#     (none of their ENABLE_* flags are set)
#   - the proactive scheduler, forced to tick every minute, completes a run
#     without a Telegram token and the container is still up afterwards
#
# Usage:
#   docker build -f docker/Dockerfile -t mastra:local .
#   docker/boot-check.sh mastra:local
#
# Everything it starts is removed on exit. The keys are placeholders: no LLM
# call is made.
set -euo pipefail

IMAGE="${1:?usage: docker/boot-check.sh <image>}"
HOST_PORT="${HOST_PORT:-14111}"
SUFFIX="$$"
NET="mastra-boot-check-net-$SUFFIX"
PG="mastra-boot-check-pg-$SUFFIX"
APP="mastra-boot-check-app-$SUFFIX"

cleanup() {
  docker rm -f "$APP" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  echo "---- container logs (last 80 lines) ----" >&2
  docker logs "$APP" 2>&1 | tail -80 >&2 || true
  exit 1
}

logs() {
  # Strip ANSI colour codes so the greps below match plain text. $'\x1b' keeps
  # this working with BSD sed (macOS), which has no \x escapes of its own.
  docker logs "$APP" 2>&1 | sed -E $'s/\x1b\\[[0-9;]*m//g'
}

# Grep a captured copy of the logs, never `logs | grep -q`: grep -q exits on
# the first match, the upstream gets SIGPIPE, and pipefail turns a hit into a
# failure once the logs outgrow the pipe buffer.
logs_contain() {
  local out
  out="$(logs)"
  grep -qF -- "$1" <<<"$out"
}

docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=mastra \
  pgvector/pgvector:pg16 >/dev/null

for _ in $(seq 1 60); do
  docker exec "$PG" pg_isready -U postgres -d mastra >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$PG" pg_isready -U postgres -d mastra >/dev/null || fail "postgres never became ready"

docker run -d --name "$APP" --network "$NET" -p "$HOST_PORT:4111" \
  -e DATABASE_URL="postgresql://postgres:postgres@$PG:5432/mastra" \
  -e AUTH_SECRET=boot-check-placeholder-secret \
  -e OPENAI_API_KEY=sk-boot-check-placeholder \
  -e ANTHROPIC_API_KEY=sk-ant-boot-check-placeholder \
  -e PORT=4111 \
  -e 'PROACTIVE_MORNING_CRON=* * * * *' \
  "$IMAGE" >/dev/null

status=""
for _ in $(seq 1 90); do
  status="$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "http://localhost:$HOST_PORT/api/agents" || true)"
  [ "$status" = "200" ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "$APP")" = "true" ] || fail "container exited during boot"
  sleep 1
done
[ "$status" = "200" ] || fail "GET /api/agents returned '$status', expected 200"
echo "ok: GET /api/agents -> 200 on 4111"

for line in \
  'Telegram bot disabled' \
  'Telegram gateway disabled' \
  'Matrix gateway disabled' \
  'Signal gateway disabled' \
  'Voice gateway disabled' \
  'No Telegram token - Telegram notifications disabled'; do
  logs_contain "$line" || fail "expected log line not found: $line"
  echo "ok: $line"
done

# The forced cron fires at the next minute boundary.
ran=""
for _ in $(seq 1 75); do
  if logs_contain 'morning run complete'; then ran=1; break; fi
  sleep 1
done
[ -n "$ran" ] || fail "proactive scheduler did not complete a run within 75s"
# ", 0 error(s)" with the leading comma, so "10 error(s)" does not match.
logs_contain 'WhatsApp briefing(s), 0 error(s)' || fail "proactive run reported errors"
[ "$(docker inspect -f '{{.State.Running}}' "$APP")" = "true" ] || fail "container exited after the proactive run"
echo "ok: proactive scheduler ran without a Telegram token and the container is still up"

echo "PASS: quiet boot"
