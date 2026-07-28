# L9 CI Convergence — SEO-Bot

Status: **partial → converging** · Node type: TypeScript (`existing_node` adapter)
Reference implementation adapted from: `Quantum-L9/LLM-Router`

This document records the audit of SEO-Bot's CI against the shared L9 target CI
model and the convergence changes applied on this branch. It is the human-readable
companion to the machine-readable policy files under `.github/governance/`.

## 1. Audit summary (before)

| Domain | Before | Notes |
|---|---|---|
| Classifier-first routing | ❌ missing | no changed-files router; every workflow ran on every PR |
| Canonical merge gate | ❌ missing | no single `PR Pipeline Gate` check to require |
| Namespaced labels | ❌ missing | no label taxonomy source of truth |
| Governed analysis (semgrep) | ✅ present | `l9-analysis.yml` via `l9-ci-core` (kept, locked preset) |
| Governed lint/test | ✅ present | `l9-lint-test.yml` via preset (kept, locked preset) |
| Supply chain / SBOM | ❌ missing | no dependency review, no SBOM |
| Secret scanning | ❌ missing | semgrep only; no gitleaks |
| Repo meta | ❌ missing | no CODEOWNERS, dependabot, PR/issue templates |
| Branch protection | ❔ unknown | not verifiable from repo files |

The two `l9-*` preset workflows are **externally managed** (`Managed by
l9-ci-core`, locked structure) and were **not modified**. The hand-written
`ci.yml` and the operational `autonomy-ops.yml` were left in place — `ci.yml`
may be a required status check (branch protection is unknown), so removing it
was deliberately avoided to prevent blocking merges.

## 2. What this branch adds (all additive)

**Router + canonical gate**
- `.github/scripts/classify_pr.py` — changed-files-primary classifier; unknown
  diffs fail closed. Emits `pr_class`, `run_lint`, `run_test`, `run_security`,
  `run_infrastructure`, `is_docs_only`, `requires_human_review`, `diff_unknown`,
  `changed_count`, `detected_labels`, `all_changed_files`.
- `.github/workflows/pr-pipeline.yml` — `classify → routed lint/test → PR
  Pipeline Gate`. The gate uses `if: always()`, depends on every job, and
  summarizes merge truth in one required-checkable job.

**Security / supply chain**
- `.github/workflows/supply-chain.yml` — dependency review (advisory) + CycloneDX SBOM.
- `.github/workflows/gitleaks.yml` + `.gitleaks.toml` — secret scanning.

**Governance source of truth** (`.github/governance/`)
- `label-taxonomy.yaml`, `ci-routing-policy.yaml`, `blocking-policy.yaml`,
  `comment-protocol.yaml`, `branch-protection-baseline.yaml`.

**Repo meta**
- `CODEOWNERS`, `dependabot.yml`, `PULL_REQUEST_TEMPLATE.md`,
  `ISSUE_TEMPLATE/{bug_report,feature_request,security_safe_report,config}`.

## 3. Required-check composition (target)

Because GitHub Actions cannot let one workflow `needs:` a job in another
workflow, "one canonical gate" is realized as a **set** of required checks
(see `branch-protection-baseline.yaml`):

```
PR Pipeline Gate  +  Lint and Type Check  +  Test Suite  +  Governed Semgrep Analysis
```

`PR Pipeline Gate` contributes routing + fail-closed-on-unknown-diff; the
governed presets contribute the heavy validation.

## 4. Known transitional overlap

`pr-pipeline.yml` runs lint/type-check/test, which overlaps the locked
`l9-lint-test.yml` preset. This overlap is intentional and transitional: the
preset is externally managed and out of scope to edit here. Follow-up for the
platform team: fold the canonical gate into the `l9-ci-core` kernel (as
`LLM-Router` does via the reusable `pr-pipeline.yml@v1`) and retire the local
overlap once the kernel supports this TS node.

## 5. Settings-plane follow-ups (require admin, not done here)

1. Provision namespaced labels from `label-taxonomy.yaml`
   (`gh label create … --force`).
2. Apply `branch-protection-baseline.yaml` on `main`; set the initial required
   checks above.
3. Verify `ci.yml`'s `CI / ci` check is/was a required check before retiring it,
   to avoid duplicate validation with `pr-pipeline.yml`.
4. Promote advisory checks (gitleaks, dependency review) to blocking once
   consistently green.
