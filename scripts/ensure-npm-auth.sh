#!/usr/bin/env bash
# Load NODE_AUTH_TOKEN for @quantum-l9/* GitHub Packages installs (SEO-Bot#17).
#
# Usage:
#   source scripts/ensure-npm-auth.sh   # export into current shell
#   eval "$(scripts/ensure-npm-auth.sh --print-export)"  # non-source form
#
# Prefer an already-exported token; else resolve openclaw-igorbot/github#token
# from Cursor-Governance AWS secrets SSOT (never prints the secret value to chat).
set -euo pipefail

PRINT_EXPORT=0
if [[ "${1:-}" == "--print-export" ]]; then
  PRINT_EXPORT=1
fi

if [[ -n "${NODE_AUTH_TOKEN:-}" ]]; then
  echo "ensure-npm-auth: NODE_AUTH_TOKEN already set" >&2
  if [[ "$PRINT_EXPORT" -eq 1 ]]; then
    printf 'export NODE_AUTH_TOKEN=%q\n' "$NODE_AUTH_TOKEN"
  fi
  return 0 2>/dev/null || exit 0
fi

GOV="${CURSOR_GOVERNANCE_ROOT:-}"
if [[ -z "$GOV" ]]; then
  if [[ -d "${HOME}/.cursor-governance/ops/secrets" ]]; then
    GOV="${HOME}/.cursor-governance"
  elif [[ -d "${HOME}/Cursor-Governance/ops/secrets" ]]; then
    GOV="${HOME}/Cursor-Governance"
  else
    echo "ensure-npm-auth: WARN — governance clone not found; export NODE_AUTH_TOKEN manually" >&2
    return 0 2>/dev/null || exit 0
  fi
fi

PY="${GOV}/.venv/bin/python"
[[ -x "$PY" ]] || PY="python3"
RESOLVER="${GOV}/ops/secrets/resolve_secret.py"
REF="${L9_GITHUB_PACKAGES_SECRET_REF:-openclaw-igorbot/github#token}"

if [[ ! -f "$RESOLVER" ]]; then
  echo "ensure-npm-auth: WARN — resolver missing at $RESOLVER" >&2
  return 0 2>/dev/null || exit 0
fi

TOKEN="$(
  cd "$GOV" || exit 1
  "$PY" "$RESOLVER" --ref "$REF" 2>/dev/null || true
)"
TOKEN="${TOKEN//$'\n'/}"

if [[ -z "$TOKEN" ]]; then
  echo "ensure-npm-auth: WARN — could not resolve $REF; export NODE_AUTH_TOKEN manually" >&2
  return 0 2>/dev/null || exit 0
fi

export NODE_AUTH_TOKEN="$TOKEN"
echo "ensure-npm-auth: NODE_AUTH_TOKEN loaded from AWS ref (len=${#NODE_AUTH_TOKEN})" >&2
if [[ "$PRINT_EXPORT" -eq 1 ]]; then
  printf 'export NODE_AUTH_TOKEN=%q\n' "$NODE_AUTH_TOKEN"
fi
