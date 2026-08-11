#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# SEO-Bot SessionStart hook — authenticated @quantum-l9 install after injection.
#
# Why a hook (not a setup script): environment-panel variables (NODE_AUTH_TOKEN)
# are injected into the running session but NOT into cached setup scripts. A
# SessionStart hook fires AFTER injection, so it can see the token and install
# the private dep `@quantum-l9/llm-router` that gates `tsc --noEmit` and vitest.
#
# Contract: soft-fail EVERYWHERE. A hook that exits non-zero can stall the
# session, so every non-trivial step is guarded and we always `exit 0`.
# ─────────────────────────────────────────────────────────────────────────────

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Token gate — try AWS SSOT (openclaw-igorbot/github#token) when the panel did
# not inject NODE_AUTH_TOKEN (SEO-Bot#17 / l9-aws-secrets). Soft-fail if absent.
if [[ -z "${NODE_AUTH_TOKEN:-}" ]]; then
  # shellcheck disable=SC1091
  source "${REPO_ROOT}/scripts/ensure-npm-auth.sh" 2>/dev/null || true
fi

if [[ -z "${NODE_AUTH_TOKEN:-}" ]]; then
  echo "WARN: NODE_AUTH_TOKEN not available — @quantum-l9 packages will not resolve."
  echo "      Export NODE_AUTH_TOKEN, or ensure AWS can resolve openclaw-igorbot/github#token."
  echo "      See RUNBOOK.md § Private npm packages. CI remains the validation gate."
  exit 0
fi

# Persist the token for every subsequent Bash tool call in this session.
# CLAUDE_ENV_FILE is provided to SessionStart hooks; guard in case it is empty.
# Use printf %q so a token with shell-significant characters is safely quoted
# for when the env file is later sourced (no breakage, no injection).
if [[ -n "${CLAUDE_ENV_FILE:-}" ]]; then
  printf 'export NODE_AUTH_TOKEN=%q\n' "$NODE_AUTH_TOKEN" >> "$CLAUDE_ENV_FILE"
fi

# Belt-and-suspenders: back the scoped registry into ~/.npmrc (idempotent) so
# npm authenticates even if invoked outside the repo root. The committed
# ./.npmrc already covers in-repo installs; scope MUST be @quantum-l9.
if ! grep -q "@quantum-l9:registry" "$HOME/.npmrc" 2>/dev/null; then
  cat >> "$HOME/.npmrc" <<'EOF'
@quantum-l9:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
always-auth=true
EOF
fi

# Install only when needed. Hooks run on every startup/resume, so guard against
# redundant installs. package-lock.json is committed, so use `npm ci`
# (version-locked, `--ignore-scripts` blocks dependency lifecycle scripts),
# matching .github/workflows/ci.yml.
if [[ -f "${REPO_ROOT}/package.json" ]] && [[ ! -d "${REPO_ROOT}/node_modules" ]]; then
  (cd "$REPO_ROOT" && npm ci --no-audit --no-fund --ignore-scripts) \
    || echo "WARN: npm ci failed — run it manually in-session."
fi

exit 0
