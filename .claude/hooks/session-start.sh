#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# SEO-Bot SessionStart hook — install after env injection.
#
# @quantum-l9/* are file: / public git. Do not write GitHub Packages auth
# into ~/.npmrc and do not require NODE_AUTH_TOKEN.
#
# Contract: soft-fail EVERYWHERE. A hook that exits non-zero can stall the
# session, so every non-trivial step is guarded and we always `exit 0`.
# ─────────────────────────────────────────────────────────────────────────────

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ -f "${REPO_ROOT}/package.json" ]] && [[ ! -d "${REPO_ROOT}/node_modules" ]]; then
  (cd "$REPO_ROOT" && npm ci --no-audit --no-fund --ignore-scripts) \
    || echo "WARN: npm ci failed — run it manually in-session."
fi

exit 0
