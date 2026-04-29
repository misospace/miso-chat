#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${GITHUB_REPOSITORY:-}" ]]; then
  echo "GITHUB_REPOSITORY is required (e.g. misospace/miso-chat)"
  exit 1
fi

if [[ -z "${RELEASE_TAG:-}" ]]; then
  echo "RELEASE_TAG is required (e.g. v0.3.1)"
  exit 1
fi

VERSION="${RELEASE_TAG#v}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]]; then
  echo "Release tag must be semantic (got: ${RELEASE_TAG})"
  exit 1
fi

echo "✅ Release tag is semantic: ${RELEASE_TAG}"

IMAGE_REGISTRY="${IMAGE_REGISTRY:-ghcr.io}"
IMAGE_REF="${IMAGE_REGISTRY}/${GITHUB_REPOSITORY}:${VERSION}"

echo "🔎 Checking image exists: ${IMAGE_REF}"
docker buildx imagetools inspect "${IMAGE_REF}" >/dev/null

echo "✅ Image exists for release tag"

if [[ -z "${DEPLOY_HEALTH_URL:-}" ]]; then
  echo "ℹ️ DEPLOY_HEALTH_URL not set; skipping deployed smoke verification"
  exit 0
fi

echo "🔎 Checking deployed health endpoint: ${DEPLOY_HEALTH_URL}"
HEALTH_PAYLOAD="$(curl -fsS --retry 3 --retry-delay 2 "${DEPLOY_HEALTH_URL}")"
HEALTH_STATUS="$(jq -r '.status // empty' <<<"${HEALTH_PAYLOAD}")"

if [[ "${HEALTH_STATUS}" != "healthy" ]]; then
  echo "Deploy health check failed: expected status=healthy, got '${HEALTH_STATUS:-<empty>}'"
  exit 1
fi

DEPLOYED_VERSION="$(jq -r '.version // empty' <<<"${HEALTH_PAYLOAD}")"
if [[ -n "${DEPLOYED_VERSION}" && "${DEPLOYED_VERSION}" != "${VERSION}" ]]; then
  echo "Deploy version mismatch: expected ${VERSION}, got ${DEPLOYED_VERSION}"
  exit 1
fi

echo "✅ Deploy health check passed"
if [[ -n "${DEPLOYED_VERSION}" ]]; then
  echo "✅ Deploy version matches release: ${DEPLOYED_VERSION}"
else
  echo "ℹ️ Deploy health payload did not include version; status-only smoke passed"
fi
