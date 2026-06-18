#!/usr/bin/env bash
# GAP-10: Verify that contracts/posthog-events.ts is in sync with Website-Bot.
# Run in CI after any change to contracts/posthog-events.ts.
# If WEBSITE_BOT_REPO_PATH is set (monorepo or co-located), compares files directly.
# Otherwise, exits 0 with a warning (remote diff requires manual check).

set -euo pipefail

SEOBOT_FILE="contracts/posthog-events.ts"

if [ ! -f "$SEOBOT_FILE" ]; then
  echo "ERROR: $SEOBOT_FILE not found"
  exit 1
fi

if [ -n "${WEBSITE_BOT_REPO_PATH:-}" ]; then
  WB_FILE="${WEBSITE_BOT_REPO_PATH}/contracts/posthog-events.ts"
  if [ ! -f "$WB_FILE" ]; then
    echo "WARNING: Website-Bot posthog-events.ts not found at $WB_FILE"
    exit 0
  fi
  if diff -q "$SEOBOT_FILE" "$WB_FILE" > /dev/null 2>&1; then
    echo "OK: posthog-events.ts is in sync with Website-Bot"
    exit 0
  else
    echo "DRIFT DETECTED: posthog-events.ts differs from Website-Bot copy:"
    diff "$SEOBOT_FILE" "$WB_FILE" || true
    exit 1
  fi
else
  echo "INFO: WEBSITE_BOT_REPO_PATH not set — skipping cross-repo diff (manual check required)"
  exit 0
fi
