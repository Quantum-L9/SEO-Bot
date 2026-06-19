#!/usr/bin/env bash
# L9_META
# layer: script
# role: seo_bot_engine
# status: active

set -euo pipefail

OWNER="cryptoxdog"
SEO_BOT_REPO="SEO-Bot"
WEBSITE_BOT_REPO=""
ROUTER_PATH="packages/llm-router/src/index.ts"
SEO_SHA=""
WEBSITE_SHA=""
AUTH_HEADER_PREFIX="Authorization:"
AUTH_SCHEME="Bearer"

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "GITHUB_TOKEN is required to compare router file SHAs."
  exit 1
fi

github_api_get() {
  local endpoint="$1"
  local auth_header="${AUTH_HEADER_PREFIX} ${AUTH_SCHEME} ${GITHUB_TOKEN}"

  curl -sS \
    -H "${auth_header}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com${endpoint}"
}

resolve_website_repo() {
  local candidates=("website-bot" "Website-Bot")
  local response=""
  local message=""

  for candidate in "${candidates[@]}"; do
    response="$(github_api_get "/repos/${OWNER}/${candidate}")"
    message="$(printf '%s' "${response}" | python -c 'import json,sys; print(json.load(sys.stdin).get("message",""))')"
    if [[ "${message}" != "Not Found" ]]; then
      WEBSITE_BOT_REPO="${candidate}"
      return
    fi
  done

  echo "Could not resolve Website Bot repository. Checked: ${candidates[*]}"
  exit 1
}

fetch_router_sha() {
  local repo="$1"
  local response
  local message

  response="$(github_api_get "/repos/${OWNER}/${repo}/contents/${ROUTER_PATH}")"
  message="$(printf '%s' "${response}" | python -c 'import json,sys; print(json.load(sys.stdin).get("message",""))')"

  if [[ "${message}" == "Not Found" ]]; then
    echo "Router file not found in ${OWNER}/${repo} at ${ROUTER_PATH}."
    exit 1
  fi

  printf '%s' "${response}" | python -c 'import json,sys; print(json.load(sys.stdin)["sha"])'
}

resolve_website_repo

SEO_SHA="$(fetch_router_sha "${SEO_BOT_REPO}")"
WEBSITE_SHA="$(fetch_router_sha "${WEBSITE_BOT_REPO}")"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "seo_sha=${SEO_SHA}"
    echo "website_sha=${WEBSITE_SHA}"
    echo "website_repo=${WEBSITE_BOT_REPO}"
  } >> "${GITHUB_OUTPUT}"
fi

if [[ "${SEO_SHA}" == "${WEBSITE_SHA}" ]]; then
  echo "Router is in sync: ${SEO_SHA}"
  exit 0
fi

echo "Router drift detected."
echo "  ${OWNER}/${SEO_BOT_REPO}: ${SEO_SHA}"
echo "  ${OWNER}/${WEBSITE_BOT_REPO}: ${WEBSITE_SHA}"
echo "Run: chmod +x scripts/check-router-sync.sh"
exit 1
