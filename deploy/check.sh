#!/usr/bin/env bash
#
# Self-check for a story-core deployment: the containers, the application's own
# health route, and the reverse proxy in front of it. Run it after every install
# or update — it answers "is this actually serving?" rather than "is the container
# up?".
set -uo pipefail

cd "$(dirname "$0")" || exit 1

ok() { printf '  ok    %s\n' "$1"; }
warn() { printf '  warn  %s\n' "$1"; }
die() {
  printf '  FAIL  %s\n' "$1" >&2
  exit 1
}

echo "story-core self-check"

# ---------------------------------------------------------------- configuration
if [ ! -f .env ]; then
  die "no .env found; copy .env.example to .env first"
fi

APP_DOMAIN_VALUE="$(sed -n 's/^APP_DOMAIN=//p' .env | tail -1)"
APP_DOMAIN_VALUE="${APP_DOMAIN_VALUE:-:80}"
STORY_LOCAL_PORT_VALUE="$(sed -n 's/^STORY_LOCAL_PORT=//p' .env | tail -1)"
STORY_LOCAL_PORT_VALUE="${STORY_LOCAL_PORT_VALUE:-127.0.0.1:8787}"
PROBE_PORT="${STORY_LOCAL_PORT_VALUE##*:}"

# -------------------------------------------------------------------- containers
if ! docker compose ps --status running --format '{{.Service}}' 2>/dev/null | grep -q story-core; then
  docker compose ps >&2 || true
  die "the story-core container is not running"
fi
ok "story-core container is running"

if docker compose ps --status running --format '{{.Service}}' 2>/dev/null | grep -q web; then
  ok "web container is running"
else
  die "the web container is not running"
fi

if docker compose ps --status running --format '{{.Service}}' 2>/dev/null | grep -q caddy; then
  ok "caddy container is running"
else
  die "the caddy container is not running"
fi

# ------------------------------------------------------------------ application
HEALTH="$(curl -sS --max-time 10 "http://127.0.0.1:${PROBE_PORT}/health" 2>/dev/null || true)"
# Whitespace-tolerant: the API pretty-prints its JSON, and an assertion that
# depends on the exact spacing is a false negative waiting to happen.
if printf '%s' "$HEALTH" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
  ok "health route answered on 127.0.0.1:${PROBE_PORT}"
else
  die "health route did not answer on 127.0.0.1:${PROBE_PORT} (got: ${HEALTH:-nothing})"
fi

# The model gateway is optional at this stage: an unconfigured instance still
# serves accounts, cards and the market, it just cannot answer a turn.
if curl -sS --max-time 10 "http://127.0.0.1:${PROBE_PORT}/" 2>/dev/null | grep -Eq '"name"[[:space:]]*:[[:space:]]*"story-core"'; then
  ok "root route identifies the service"
else
  warn "root route did not return the expected landing payload"
fi

# ---------------------------------------------------------------- web client
WEB_LOCAL_PORT_VALUE="$(sed -n 's/^WEB_LOCAL_PORT=//p' .env | tail -1)"
WEB_LOCAL_PORT_VALUE="${WEB_LOCAL_PORT_VALUE:-127.0.0.1:3000}"
WEB_PROBE_PORT="${WEB_LOCAL_PORT_VALUE##*:}"

# A page, not an API: the UI owns `/` now. The API's own landing payload is only
# reachable on the app port above, which is why that check still exists.
PAGE_CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:${WEB_PROBE_PORT}/login" 2>/dev/null || true)"
if [ "$PAGE_CODE" = "200" ]; then
  ok "web client answered on 127.0.0.1:${WEB_PROBE_PORT}"
else
  die "web client did not serve /login (HTTP ${PAGE_CODE:-000})"
fi

# ---------------------------------------------------------------- reverse proxy
case "$APP_DOMAIN_VALUE" in
  :*) URL="http://127.0.0.1${APP_DOMAIN_VALUE}" ;;
  *) URL="https://${APP_DOMAIN_VALUE%%,*}" ;;
esac

CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$URL/" 2>/dev/null || true)"
CODE="${CODE:-000}"
# 307 is the normal answer: `/` sends everyone to /chats, and the app frame then
# sends guests on to /login.
case "$CODE" in
  200|301|302|307|308) ok "reverse proxy answered ($URL -> HTTP $CODE)" ;;
  000) warn "could not reach $URL from here (DNS or the proxy may still be warming up)" ;;
  *) die "unexpected HTTP $CODE from $URL; inspect: docker compose logs --tail=50 caddy" ;;
esac

# The API must be routed to story-core and not to the web client — otherwise
# every page loads and nothing works. This route needs a token, so a probe
# without one getting *story-core's own* JSON back is the correct answer: it
# proves the request was answered by the API instead of with a page.
API_BODY="$(curl -sS --max-time 15 "$URL/api/v1/model" 2>/dev/null || true)"
if printf '%s' "$API_BODY" | grep -Eq '"configured"|"authentication_required"'; then
  ok "reverse proxy routes /api to the application"
else
  die "the API is not reachable through $URL (got: ${API_BODY:-nothing})"
fi

echo "all checks passed"
