# TASK-001 — Adopt the exact Router patch version

Campaign: `pe-seo-bot-build-intelligence-hardening-v2`

## What changed

- `package.json` — pinned `@quantum-l9/llm-router` from 1.1.2 to the exact
  promoted patch **1.3.0** (operator-decided release line; no caret, no
  latest, no star).
- `package-lock.json` — regenerated for the pinned version (install performed
  with the trusted-operator npm wrapper; registry = GitHub Packages).

## Validation

- `npm ls @quantum-l9/llm-router` proves the installed dependency is exactly
  1.3.0 (verified against the published registry artifact).
- LLM policy tests and build-intelligence tests pass on the pinned tree.

Final invariant: SEO-Bot Router version == Website-Bot Router version == the
promoted Router patch (1.3.0).
