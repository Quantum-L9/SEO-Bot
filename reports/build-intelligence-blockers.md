# Build-Intelligence Producer — Blockers, Causes & Proposed Resolutions

**Branch:** `claude/seo-bot-build-intelligence-6jco2z`
**Commit:** `c67aa58` — `feat(build-intelligence): SEO-Bot build-time intelligence producer (l9.website-intelligence/v1)`
**Date:** 2026-08-14
**Local gate status:** `tsc --noEmit` 0 errors · `eslint src/` clean · `vitest run` 233/233 passing

This document enumerates every blocker/deferred item from the build-intelligence
producer work, its **root cause**, and a concrete **proposed resolution**. None
of these block the correctness of the delivered code — they are environmental /
finalize steps that require credentials or tooling unavailable in the build
sandbox.

---

## BLOCKER 1 — Lockfile integrity for `@quantum-l9/bot-interop@1.1.0` (registry auth)

**Severity:** High — blocks CI `npm ci` until finalized.

### What
CI's `npm ci` needs `package-lock.json` to reference `@quantum-l9/bot-interop`
`1.1.0` with the **authoritative registry `resolved` URL + `integrity` hash**.
The committed lock pinned the stale **`1.0.0`**, and this sandbox cannot fetch
the real `1.1.0` metadata to regenerate it.

### Root cause
The `website-intelligence` protocol (types `CompetitiveLandscapeV1`,
`SEOContentBlueprintV1`, `PageContentContractV1`, `StructuredContentPackageV1`
and integrity functions `sealIntelligenceArtifact` / `assertIntelligenceArtifactIntegrity`
/ `refForArtifact` / …) was introduced in **Website-Bot commit `f8fac03`**, the
same commit that bumped `@quantum-l9/bot-interop` **1.0.0 → 1.1.0**. Therefore
this feature requires bot-interop **≥ 1.1.0**, but SEO-Bot's committed lock still
pinned `1.0.0` (which does not contain the protocol at all).

Regenerating the lock requires reading `npm.pkg.github.com` for the
`@quantum-l9` scope. The sandbox's `GH_TOKEN` lacks the `packages:read` scope
(`403 permission_denied`), and the AWS Secrets Manager path that would resolve
the canonical PAT is unreachable (placeholder `proxy-injected` credentials →
`UnrecognizedClientException`). So neither `npm install` nor `npm view` can
resolve the real `1.1.0` artifact.

### What was done in this branch
- `package.json`: `@quantum-l9/bot-interop` bumped `^1.0.0` → **`^1.1.0`** (the
  correct, worktree-true dependency).
- `package-lock.json`: bot-interop node + root range updated to **`1.1.0`** with
  a **best-effort `integrity`** computed from the locally-built bot-interop
  source (`Website-Bot/packages/bot-interop`, the exact source that ships to the
  registry). The `resolved` URL points at the `1.1.0` path **without** the
  registry's content-hash suffix (unknown without registry access).

### Proposed resolution
Run, in any environment that holds a `packages:read` token (CI already does):

```bash
export NODE_AUTH_TOKEN=<PAT with packages:read>   # or GitHub Actions GITHUB_TOKEN + packages: read
npm install --package-lock-only --ignore-scripts --no-audit --no-fund
git add package-lock.json && git commit -m "chore: finalize bot-interop@1.1.0 lock integrity"
```

This overwrites the best-effort `integrity`/`resolved` with the authoritative
registry values. **Precondition:** `@quantum-l9/bot-interop@1.1.0` must be
published to GitHub Packages (it is built from Website-Bot `f8fac03`); if
Website-Bot has not published it yet, publish it first.

### Verification
Local `tsc --noEmit`, `eslint src/`, and all 233 `vitest` tests already pass
against the worktree-installed bot-interop `1.1.0` (linked from the Website-Bot
monorepo source). Only the CI `npm ci` download/integrity step is gated.

---

## BLOCKER 2 — Live DataForSEO SERP acceptance leg not executed

**Severity:** Medium — one acceptance sub-step unverified against a live provider.

### What
The DONE-CRITERIA asks for "one real SERP request where credentials permit." That
live leg was not run.

### Root cause
No `DATAFORSEO_LOGIN`/`DATAFORSEO_PASSWORD` credentials and no provider egress in
the build sandbox. The DataForSEO client is only exercised against fixtures.

### What was done in this branch
- `createCompetitiveLandscape` takes an injectable `DataForSeoOrganicPort`, so the
  whole path is unit-tested deterministically against SERP fixtures.
- The determinism test (same SERP fixture → identical sealed `payload_digest`)
  stands in for the "same SERP → same artifact" guarantee.

### Proposed resolution
In staging/prod (credentials present), issue one real request and confirm a
sealed CompetitiveLandscape is returned:

```bash
curl -sS -X POST "$BOT_URL/api/build-intelligence/competitive-landscape" \
  -H "Authorization: Bearer $OPERATOR_API_KEY" -H 'Content-Type: application/json' \
  -d '{"client_id":"...","build_id":"...","market":{"niche":"...","country":"United States","language":"English"},"seed_queries":[{"query":"...","intent":"commercial"}]}'
```

Expect `201` with `artifact_type: "competitive_landscape"` and a non-empty
`integrity.payload_digest`.

---

## BLOCKER 3 — Drizzle snapshot cannot be regenerated in-sandbox

**Severity:** Low — migration applies correctly; only the generate-time snapshot
is stale (repo-wide, pre-existing).

### What
`npx drizzle-kit generate` fails in this sandbox, so the new migration's
`meta/0001_snapshot.json` was not produced.

### Root cause
`drizzle-kit generate` bundles the schema via a CJS loader and cannot resolve the
NodeNext `./schema.js` ESM specifiers (`Error: Cannot find module './schema.js'`).
Separately, the repo's existing `meta/0000_snapshot.json` is **already stale** — it
omits the `agent_jobs`, `budget_violations`, and `compensation_log` tables that
were added to `schema-extensions.ts` (ADR-0008) without a regenerated snapshot.
So the snapshot is not an authoritative baseline to extend by hand.

### What was done in this branch
- New migration **`drizzle/0001_build_intelligence_artifacts.sql`** (`CREATE TABLE`
  + indexes + unique) and a matching **`meta/_journal.json`** entry were
  hand-authored. `drizzle-orm`'s `migrate()`/`readMigrationFiles()` use the
  journal + `.sql` only (not the snapshot), so `npm run migrate` applies the
  table correctly.
- No `0001_snapshot.json` was fabricated (it would diverge from what an authed
  `drizzle-kit generate` emits and mislead future diffs).
- API persistence is **best-effort / fail-open**, so a not-yet-migrated table
  never blocks the producer transaction.

### Proposed resolution
In an environment where `drizzle-kit` resolves the schema (Node with the project
installed; if the NodeNext issue persists, compile the schema to `dist` first or
pin a drizzle-kit version that handles `.js` specifiers), run:

```bash
npx drizzle-kit generate     # reconciles the snapshot for ALL four missing tables
npm run migrate              # applies against the target DB
```

This regenerates `meta/*_snapshot.json` to include `build_intelligence_artifacts`
plus the pre-existing `agent_jobs` / `budget_violations` / `compensation_log`
tables, closing the repo-wide snapshot drift.

---

## NON-BLOCKER (recorded exemption) — `SEAM_NOT_GATE_ROUTED`

**Not a blocker; recorded per contract.**

L9 law states TransportPacket is the only wire format and Gate is the only routing
authority. This pass ships **three direct HTTP endpoints** on SEO-Bot's existing
Fastify surface per the **accepted `l9.website-intelligence/v1` seam**, with
Website-Bot as the named consumer.

- **Decision:** proceed with direct HTTP (seam accepted; consumer named).
- **Not done:** no Gate routing was silently introduced, and the tension is not
  silently ignored.
- **Future:** if/when the seam is migrated behind Gate, wrap these three services
  in a TransportPacket handler — the producer services (`src/build-intelligence/*`)
  are transport-agnostic and need no change.

---

## Summary table

| # | Blocker | Cause | Resolution | Blocks |
|---|---------|-------|------------|--------|
| 1 | bot-interop@1.1.0 lock integrity | `packages:read` token unavailable; lock pinned stale 1.0.0 (pre-`website-intelligence`) | `npm install` with an authed token to finalize `resolved`/`integrity` | CI `npm ci` |
| 2 | Live SERP leg unrun | No DataForSEO creds / egress in sandbox | Run one real request in staging/prod | 1 acceptance sub-step |
| 3 | Drizzle snapshot not regenerated | `drizzle-kit generate` can't resolve NodeNext `.js`; repo snapshot already stale | `drizzle-kit generate` in an authed/working env | snapshot hygiene only |
| — | `SEAM_NOT_GATE_ROUTED` (exemption) | Accepted direct-HTTP seam vs Gate law | Wrap in TransportPacket if/when seam moves behind Gate | nothing |

_Generated by [Claude Code](https://claude.ai/code)_
