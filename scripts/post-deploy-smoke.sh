#!/usr/bin/env bash
set -euo pipefail

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required"
  exit 1
fi

if [[ -z "${SMOKE_BASE_URL:-}" ]]; then
  echo "SMOKE_BASE_URL is required (e.g. https://miso-chat.example.com)"
  exit 1
fi

BASE_URL="${SMOKE_BASE_URL%/}"
SMOKE_TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-20}"
SMOKE_SESSION_KEY="${SMOKE_SESSION_KEY:-default}"
SMOKE_MESSAGE="${SMOKE_MESSAGE:-deploy smoke ping $(date -u +%Y-%m-%dT%H:%M:%SZ)}"
SMOKE_HEALTH_URL="${SMOKE_HEALTH_URL:-${BASE_URL}/api/health}"

TMP_DIR="$(mktemp -d)"
COOKIE_JAR="${TMP_DIR}/cookies.txt"
HEADERS_FILE="${TMP_DIR}/headers.txt"
trap 'rm -rf "${TMP_DIR}"' EXIT

echo "🔎 [1/4] Checking health endpoint: ${SMOKE_HEALTH_URL}"
HEALTH_PAYLOAD="$(curl -fsS --max-time "${SMOKE_TIMEOUT_SECONDS}" "${SMOKE_HEALTH_URL}")"
HEALTH_STATUS="$(jq -r '.status // empty' <<<"${HEALTH_PAYLOAD}")"

if [[ "${HEALTH_STATUS}" != "healthy" ]]; then
  echo "Health check failed: expected status=healthy, got '${HEALTH_STATUS:-<empty>}'"
  exit 1
fi

HEALTH_VERSION="$(jq -r '.version // empty' <<<"${HEALTH_PAYLOAD}")"
if [[ -n "${HEALTH_VERSION}" ]]; then
  echo "✅ Health OK (version ${HEALTH_VERSION})"
else
  echo "✅ Health OK"
fi

echo "🔎 [2/4] Checking auth mode"
LOGIN_OPTIONS_PAYLOAD="$(curl -fsS --max-time "${SMOKE_TIMEOUT_SECONDS}" "${BASE_URL}/api/login-options")"
REQUIRES_AUTH="$(jq -r '.requiresAuth // true' <<<"${LOGIN_OPTIONS_PAYLOAD}")"
AUTH_MODE="$(jq -r '.authMode // "unknown"' <<<"${LOGIN_OPTIONS_PAYLOAD}")"

CURL_AUTH_ARGS=()

if [[ "${REQUIRES_AUTH}" == "true" ]]; then
  LOCAL_AUTH_ENABLED="$(jq -r '.localAuthEnabled // false' <<<"${LOGIN_OPTIONS_PAYLOAD}")"
  if [[ "${LOCAL_AUTH_ENABLED}" != "true" ]]; then
    echo "Auth is required, but local login is disabled (authMode=${AUTH_MODE})."
    echo "This smoke script currently supports local username/password login only."
    exit 1
  fi

  SMOKE_USERNAME="${SMOKE_USERNAME:-admin}"
  SMOKE_PASSWORD="${SMOKE_PASSWORD:-password123}"

  echo "🔎 [3/4] Verifying login flow"
  curl -sS --max-time "${SMOKE_TIMEOUT_SECONDS}" \
    -c "${COOKIE_JAR}" -b "${COOKIE_JAR}" \
    -D "${HEADERS_FILE}" -o /dev/null \
    -X POST "${BASE_URL}/login" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode "username=${SMOKE_USERNAME}" \
    --data-urlencode "password=${SMOKE_PASSWORD}" \
    --data-urlencode 'return_to=/'

  tr -d '\r' < "${HEADERS_FILE}" > "${HEADERS_FILE}.clean"
  if ! grep -Eq '^HTTP/[0-9.]+ 302' "${HEADERS_FILE}.clean"; then
    echo "Login did not return expected redirect"
    cat "${HEADERS_FILE}.clean"
    exit 1
  fi

  if grep -Eiq '^location: /login\?error=' "${HEADERS_FILE}.clean"; then
    echo "Login failed: server redirected to login error"
    cat "${HEADERS_FILE}.clean"
    exit 1
  fi

  AUTH_PAYLOAD="$(curl -fsS --max-time "${SMOKE_TIMEOUT_SECONDS}" -b "${COOKIE_JAR}" "${BASE_URL}/api/auth")"
  if ! jq -e '.authenticated == true' <<<"${AUTH_PAYLOAD}" >/dev/null; then
    echo "Authenticated session was not established"
    echo "Payload: ${AUTH_PAYLOAD}"
    exit 1
  fi

  echo "✅ Login OK"
  CURL_AUTH_ARGS=(-b "${COOKIE_JAR}")
else
  echo "ℹ️ Auth not required by deployment (authMode=${AUTH_MODE}); skipping interactive login"
  echo "✅ Login check skipped"
fi

echo "🔎 [4/4] Verifying send-message API path"
SEND_PAYLOAD="$(
  curl -fsS --max-time "${SMOKE_TIMEOUT_SECONDS}" "${CURL_AUTH_ARGS[@]}" \
    -X POST "${BASE_URL}/api/sessions/${SMOKE_SESSION_KEY}/send" \
    -H 'Content-Type: application/json' \
    --data "$(jq -nc --arg message "${SMOKE_MESSAGE}" '{message: $message}')"
)"

if ! jq -e '.success == true' <<<"${SEND_PAYLOAD}" >/dev/null; then
  SEND_ERROR="$(jq -r '.error // empty' <<<"${SEND_PAYLOAD}")"
  echo "Send-message check failed${SEND_ERROR:+: ${SEND_ERROR}}"
  echo "Payload: ${SEND_PAYLOAD}"
  exit 1
fi

echo "✅ Message send path OK"
echo "✅ Post-deploy smoke check passed"
