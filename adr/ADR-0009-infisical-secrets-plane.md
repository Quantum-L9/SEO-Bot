<!-- L9_META: layer=architecture, role=secrets_adr, status=accepted, version=1.0.0 -->
# ADR-0009: Infisical is the SEO-Bot secrets plane

## Status
Accepted.

## Context
SEO-Bot already consumed `@quantum-l9/infisical-config` at process boot, but GitHub
Actions runtime jobs did not inject Universal Auth bootstrap, so CI/ops stayed on
per-secret Actions `env:` blocks. Website-Bot ADR-0009 is the fleet pattern.

## Decision
1. **Infisical** (org `infiscal-l9`, **SEO-Bot project** — separate from Website-Bot)
   is the secrets plane for runtime hydration.
2. Bootstrap uses Universal Auth:
   `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET`, `INFISICAL_PROJECT_ID`
   (optional `INFISICAL_ENV=prod`).
3. Entrypoints call `hydrateSecretsIfConfigured()` / `loadSecrets()` from
   `src/core/secrets.ts` → `@quantum-l9/infisical-config` before config use.
   Secret **names in Infisical must match app env var names**.
4. Loaders use **`overwrite: false`** — Actions env / local `.env` win over vault.
5. **AWS Secrets Manager** `openclaw-igorbot/infisical-seo-bot` is the agent
   bootstrap mirror (Cursor-Governance registry) — not a second app secrets plane.
6. CI supplies Infisical bootstrap; remaining non-migrated secrets may still arrive
   via GitHub Actions until upserted into Infisical. Do not wrap jobs with
   `infisical run` curl|bash installs.
7. **Do not share** the Website-Bot Infisical project — separate blast radius.

## Consequences
- After creating/rotating the Infisical project in UI, update:
  - GitHub Actions secrets `INFISICAL_PROJECT_ID` (and UA if new identity)
  - AWS `openclaw-igorbot/infisical-seo-bot#project_id` (and keys as needed)
- Agents resolve bootstrap via `l9-aws-secrets` then export `INFISICAL_*`.
- Install-time `NODE_AUTH_TOKEN` stays packages auth (not Infisical).

## Related
- Website-Bot `docs/architecture/ADR-0009-infisical-secrets-plane.md` (fleet SSOT narrative)
- `@quantum-l9/infisical-config`
