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

# Token gate — report, never crash. Without it the repo's committed .npmrc
# cannot resolve @quantum-l9/*, and CI remains the validation gate.
if [ -z "$NODE_AUTH_TOKEN" ]; then
  echo "WARN: NODE_AUTH_TOKEN not injected — @quantum-l9 packages will not resolve."
  echo "      Set a read:packages PAT as NODE_AUTH_TOKEN in the environment panel."
  echo "      CI remains the authoritative validation gate until then."
  exit 0
fi

# Persist the token for every subsequent Bash tool call in this session.
# CLAUDE_ENV_FILE is provided to SessionStart hooks; guard in case it is empty.
if [ -n "$CLAUDE_ENV_FILE" ]; then
  echo "export NODE_AUTH_TOKEN=$NODE_AUTH_TOKEN" >> "$CLAUDE_ENV_FILE"
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
# redundant installs. No committed lockfile → `npm install` (never `npm ci`),
# matching .github/workflows/ci.yml.
if [ -f "package.json" ] && [ ! -d "node_modules" ]; then
  npm install --no-audit --no-fund || echo "WARN: npm install failed — run it manually in-session."
fi

exit 0
