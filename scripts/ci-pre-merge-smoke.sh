#!/usr/bin/env bash
# Pre-merge integration smoke for miso-chat.
#
# Runs the same checks a freshly deployed instance must pass before a PR can
# merge. Designed to fail fast on the regression class that #374 / #618 / #620
# hit (frontend boot break, auth-boundary break, send-message break). Catches
# these regressions pre-merge instead of post-deploy.
#
# Steps:
#   1. `npm run lint` — fail on any eslint error
#   2. `npm run test:ci` — full regression suite
#   3. Boot the stub HTTP gateway (scripts/ci-stub-gateway.js)
#   4. Boot miso-chat with GATEWAY_URL pointed at the stub and a no-op WS URL
#   5. curl /api/health  — process boot, no crash, status=healthy
#   6. POST /login       — local-auth path works
#   7. GET /api/auth     — session persists
#   8. GET /api/sessions — session list resolves
#   9. POST /api/sessions/:key/send — chat send path returns success=true with
#                                     responseText (catches the #374/#618/#620
#                                     class of "frontend boot / send-message
#                                     regression caught post-merge")
#
# Environment overrides (all optional):
#   PORT                  — server port (default 3300)
#   STUB_GATEWAY_PORT     — stub gateway port (default 3890)
#   SMOKE_USERNAME        — login user (default admin)
#   SMOKE_PASSWORD        — login password (default password123)
#   SMOKE_SESSION_KEY     — session key for send-message (default agent:main:main)
#   SMOKE_TIMEOUT_SECONDS — per-curl timeout (default 20)
#   SKIP_LINT=1           — skip npm run lint (used by release workflow)
#   SKIP_UNIT_TESTS=1     — skip npm run test:ci (used by release workflow)
set -euo pipefail

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required"
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-3300}"
STUB_GATEWAY_PORT="${STUB_GATEWAY_PORT:-3890}"
SMOKE_TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-20}"
SMOKE_USERNAME="${SMOKE_USERNAME:-admin}"
SMOKE_PASSWORD="${SMOKE_PASSWORD:-password123}"
SMOKE_SESSION_KEY="${SMOKE_SESSION_KEY:-agent:main:main}"
BASE_URL="http://127.0.0.1:${PORT}"
GATEWAY_URL="http://127.0.0.1:${STUB_GATEWAY_PORT}"

TMP_DIR="$(mktemp -d)"
COOKIE_JAR="${TMP_DIR}/cookies.txt"
HEADERS_FILE="${TMP_DIR}/headers.txt"
SERVER_LOG="${TMP_DIR}/server.log"
STUB_LOG="${TMP_DIR}/stub.log"
HEADERS_CLEAN="${HEADERS_FILE}.clean"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "${STUB_PID:-}" ]] && kill -0 "$STUB_PID" 2>/dev/null; then
    kill "$STUB_PID" 2>/dev/null || true
    wait "$STUB_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

step() {
  printf '\n▶ %s\n' "$1"
}

fail() {
  printf '\n❌ %s\n' "$1" >&2
  if [[ -s "$SERVER_LOG" ]]; then
    printf '\n--- server log tail ---\n' >&2
    tail -n 60 "$SERVER_LOG" >&2 || true
  fi
  if [[ -s "$STUB_LOG" ]]; then
    printf '\n--- stub gateway log tail ---\n' >&2
    tail -n 40 "$STUB_LOG" >&2 || true
  fi
  exit 1
}

# ---------------------------------------------------------------------------
# 1. Lint
# ---------------------------------------------------------------------------
if [[ "${SKIP_LINT:-0}" != "1" ]]; then
  step "[1/6] Running ESLint (npm run lint)"
  if ! npm run lint --silent; then
    fail "ESLint reported errors"
  fi
  echo "✅ Lint clean"
else
  echo "ℹ️ Skipping lint (SKIP_LINT=1)"
fi

# ---------------------------------------------------------------------------
# 2. Unit / regression tests
# ---------------------------------------------------------------------------
if [[ "${SKIP_UNIT_TESTS:-0}" != "1" ]]; then
  step "[2/6] Running regression suite (npm run test:ci)"
  if ! npm run test:ci --silent; then
    fail "Regression tests failed"
  fi
  echo "✅ Regression suite passed"
else
  echo "ℹ️ Skipping unit tests (SKIP_UNIT_TESTS=1)"
fi

# ---------------------------------------------------------------------------
# 3. Boot stub HTTP gateway
# ---------------------------------------------------------------------------
step "[3/6] Booting stub HTTP gateway on port ${STUB_GATEWAY_PORT}"
STUB_GATEWAY_PORT="$STUB_GATEWAY_PORT" \
  node scripts/ci-stub-gateway.js >"$STUB_LOG" 2>&1 &
STUB_PID=$!

for _ in {1..40}; do
  if curl -fsS --max-time 2 "http://127.0.0.1:${STUB_GATEWAY_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
  if ! kill -0 "$STUB_PID" 2>/dev/null; then
    echo "Stub gateway exited unexpectedly" >&2
    cat "$STUB_LOG" >&2 || true
    exit 1
  fi
done

if ! curl -fsS --max-time 2 "http://127.0.0.1:${STUB_GATEWAY_PORT}/health" >/dev/null 2>&1; then
  fail "Stub gateway did not become ready"
fi
echo "✅ Stub gateway up"

# ---------------------------------------------------------------------------
# 4. Boot miso-chat pointed at the stub gateway
# ---------------------------------------------------------------------------
step "[4/6] Booting miso-chat on port ${PORT}"
export NODE_ENV=development
export PORT
export SESSION_SECRET="${SESSION_SECRET:-ci-pre-merge-session-secret-0123456789012345678901234567}"
export OIDC_ENABLED=false
export LOCAL_AUTH_ENABLED=true
export LOCAL_USERS="${SMOKE_USERNAME}:${SMOKE_PASSWORD}"
export GATEWAY_URL
# ws://127.0.0.1:<unbound> — server still boots, WS handshake will fail and
# HTTP fallback to GATEWAY_URL (the stub) is exercised.
export GATEWAY_WS_URL="ws://127.0.0.1:1"
export GATEWAY_WS_MAX_RECONNECT_ATTEMPTS=0

node server.js >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

for _ in {1..80}; do
  if curl -fsS --max-time 2 "${BASE_URL}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Server exited unexpectedly" >&2
    cat "$SERVER_LOG" >&2 || true
    exit 1
  fi
done

if ! curl -fsS --max-time 2 "${BASE_URL}/api/health" >/dev/null 2>&1; then
  fail "Server did not become ready on ${BASE_URL}"
fi
echo "✅ Server up"

# ---------------------------------------------------------------------------
# 5. Health endpoint (anonymous)
# ---------------------------------------------------------------------------
step "[5/6] curl http://127.0.0.1:${PORT}/api/health"
HEALTH_PAYLOAD="$(curl -fsS --max-time "${SMOKE_TIMEOUT_SECONDS}" "${BASE_URL}/api/health")"
HEALTH_STATUS="$(jq -r '.status // empty' <<<"${HEALTH_PAYLOAD}")"
if [[ "${HEALTH_STATUS}" != "healthy" ]]; then
  echo "Payload: ${HEALTH_PAYLOAD}" >&2
  fail "Health check failed: expected status=healthy, got '${HEALTH_STATUS:-<empty>}'"
fi
HEALTH_VERSION="$(jq -r '.version // empty' <<<"${HEALTH_PAYLOAD}")"
if [[ -n "${HEALTH_VERSION}" ]]; then
  echo "✅ Health OK (version ${HEALTH_VERSION})"
else
  echo "✅ Health OK"
fi

# ---------------------------------------------------------------------------
# 6. Auth + send-message
# ---------------------------------------------------------------------------
step "[6/6] POST /login, GET /api/auth, GET /api/sessions, POST /api/sessions/${SMOKE_SESSION_KEY}/send"

# Anonymous root should bounce to /login (sanity check for auth boundary).
curl -sS --max-time "${SMOKE_TIMEOUT_SECONDS}" -D "$HEADERS_FILE" -o /dev/null "${BASE_URL}/"
tr -d '\r' < "$HEADERS_FILE" > "$HEADERS_CLEAN"
if ! grep -Eq '^HTTP/[0-9.]+ 302' "$HEADERS_CLEAN"; then
  echo "Headers: $(cat "$HEADERS_CLEAN")" >&2
  fail "Expected 302 redirect from /, got: $(head -n 1 "$HEADERS_CLEAN")"
fi
if ! grep -Eiq '^location: /login' "$HEADERS_CLEAN"; then
  fail "Expected redirect target /login, got: $(grep -i '^location' "$HEADERS_CLEAN" || echo none)"
fi

# POST /login — cookie jar.
curl -sS --max-time "${SMOKE_TIMEOUT_SECONDS}" \
  -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
  -D "$HEADERS_FILE" -o /dev/null \
  -X POST "${BASE_URL}/login" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "username=${SMOKE_USERNAME}" \
  --data-urlencode "password=${SMOKE_PASSWORD}" \
  --data-urlencode 'return_to=/'

tr -d '\r' < "$HEADERS_FILE" > "$HEADERS_CLEAN"
if ! grep -Eq '^HTTP/[0-9.]+ 302' "$HEADERS_CLEAN"; then
  cat "$HEADERS_CLEAN" >&2
  fail "Login did not return a redirect"
fi
if grep -Eiq '^location: /login\?error=' "$HEADERS_CLEAN"; then
  cat "$HEADERS_CLEAN" >&2
  fail "Login rejected by server (redirected to login error)"
fi

AUTH_PAYLOAD="$(curl -fsS --max-time "${SMOKE_TIMEOUT_SECONDS}" -b "$COOKIE_JAR" "${BASE_URL}/api/auth")"
if ! jq -e '.authenticated == true' <<<"${AUTH_PAYLOAD}" >/dev/null; then
  echo "Auth payload: ${AUTH_PAYLOAD}" >&2
  fail "Authenticated session was not established"
fi

SESSIONS_PAYLOAD="$(curl -fsS --max-time "${SMOKE_TIMEOUT_SECONDS}" -b "$COOKIE_JAR" "${BASE_URL}/api/sessions")"
if ! jq -e '(.sessions | type) == "array"' <<<"${SESSIONS_PAYLOAD}" >/dev/null; then
  echo "Sessions payload: ${SESSIONS_PAYLOAD}" >&2
  fail "Sessions list did not return an array"
fi
echo "✅ Login + sessions OK"

# POST /api/sessions/:key/send — must succeed via HTTP fallback (stub gateway).
SEND_PAYLOAD="$(
  curl -fsS --max-time "${SMOKE_TIMEOUT_SECONDS}" -b "$COOKIE_JAR" \
    -X POST "${BASE_URL}/api/sessions/${SMOKE_SESSION_KEY}/send" \
    -H 'Content-Type: application/json' \
    --data "$(jq -nc --arg message "pre-merge smoke $(date -u +%Y-%m-%dT%H:%M:%SZ)" '{message: $message}')"
)"
if ! jq -e '.success == true and (.responseText | type) == "string" and (.responseText | length) > 0' <<<"${SEND_PAYLOAD}" >/dev/null; then
  echo "Send payload: ${SEND_PAYLOAD}" >&2
  SEND_ERROR="$(jq -r '.error // empty' <<<"${SEND_PAYLOAD}")"
  fail "Send-message check failed${SEND_ERROR:+: ${SEND_ERROR}}"
fi
echo "✅ Send-message path OK (responseText=$(jq -r '.responseText' <<<"${SEND_PAYLOAD}"))"

printf '\n✅ Pre-merge smoke passed\n'