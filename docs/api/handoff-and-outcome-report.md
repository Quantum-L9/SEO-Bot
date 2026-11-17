# Website handoff enrollment and client outcome report

## 1. `POST /api/clients/register` — Website-Bot handoff

Contract: `@quantum-l9/bot-interop` `WebsiteFactoryHandoffV3` (`schema_version: "3.0"`),
emitted by Website-Bot `src/stages/HandoffEmitterStage.ts`. Both repos vendor the same
`packages/bot-interop` 1.3.0 sources.

| Request part | Value | Checked by |
|---|---|---|
| `Authorization` | `Bearer <SEO_BOT_API_KEY>` | constant-time compare; 503 if unset, 401 if wrong |
| `Idempotency-Key` | `contract_id` | 409 on mismatch |
| body | sealed v3 handoff | `assertWebsiteFactoryHandoffV3` (digest-sealed); 400 on failure |

Outcomes:

| Status | Meaning |
|---|---|
| `201` + `SeoBotRegistrationAck` | maintenance readiness verified (repo, branch, commit, editable paths); client `active` |
| `202` `{registered:true, maintenance_ready:false, probes}` | stored inactive; Website-Bot treats the non-ack body as `HANDOFF_ACK_MISMATCH` |

Idempotency:

- The client row is upserted on the normalized domain — one row per site.
- `clients.config` is **merged** (`config || excluded.config`): handoff-owned keys are
  replaced, operator-set keys (`ownerEmail`, `aeoQueries`, …) survive a redeploy.
- On `201`, one baseline run of each monitoring job is queued —
  `serp:check-rankings`, `vitals:check-all-sources`, `aeo:check-citations`,
  `behavior:pull-engagement` — with BullMQ job id
  `baseline~<job>~<clientId>~<contract digest>`. A retry of the same handoff queues nothing;
  a new release earns a new baseline. Enqueue failure is logged and does not fail the
  handoff: the active client is still picked up by every cron fan-out.

## 2. Client outcome report

Operator surface (`OPERATOR_API_KEY`, `src/api/security.ts`). Read-only.

### `GET /api/reports/clients/:clientId/outcome`

| Query | Default | Notes |
|---|---|---|
| `from` | `to − 7 days` | ISO-8601 |
| `to` | now | ISO-8601; period ≤ 92 days |
| `format` | `json` | `json` → `{report, markdown}`; `markdown` → `text/markdown` |

### `GET /api/reports/clients/:clientId/outcome/latest`

The most recent stored weekly snapshot (`{report, markdown, storedAt}`), or `404
no weekly outcome report stored yet`.

### Weekly job `reports:outcome-weekly`

Monday 07:00 UTC, client-scoped fan-out, zero tokens. Snapshots the closed ISO week
(Mon 00:00 → Mon 00:00 UTC) into `job_executions` (`job_name = reports:outcome-snapshot`,
report in `metadata`). One snapshot per client and week; a retry writes nothing.

### Report schema `l9.seo-bot.outcome-report.v1`

Every section is `{source, status: "ok" | "no_data", note?, data}`. Nothing is estimated:
a missing value is `null`, and a section without stored observations is `no_data` with a
reason.

| Section | Source | Content |
|---|---|---|
| `rankings` | `serp_rankings` | per keyword: latest position, start position (last check before the period, else first in it), `delta` (positive = up), status `ranking` / `not_in_results` / `no_data`; tracked keywords with no check are listed as `no_data` |
| `coreWebVitals` | `web_vitals` | latest LCP/INP (ms) and CLS per URL × source × device, with the last pre-period measurement |
| `aiCitations` | `aeo_citations` | checks, cited count, rate, per-platform split, per-query rows |
| `leads` | — | always `no_data` today: SEO-Bot stores no form/lead events |
| `spend` | `llm_usage` | LLM USD by module; third-party API costs (DataForSEO, PageSpeed) are not metered per client |
