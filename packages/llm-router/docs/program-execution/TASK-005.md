# TASK-005 — Bump version to the 1.3.0 release line

Campaign: `pe-router-capability-safety-v4` · Stacked on TASK-004

## What changed

- `package.json` and `package-lock.json` (root + packages entry) bumped from
  1.1.3 to **1.3.0**.

Operator decision (2026-08-18, mid-campaign): the release line is 1.3, not
1.1 — the search-policy audit work plus this campaign's capability-safety
work ship as 1.3.0, tagged by the operator after this campaign's delivery PR
merges. The intermediate 1.2.0 bump from PR #46 and the interim 1.1.3 pin
(PR #56) are superseded by this single forward jump; a separate version-fix
PR would have conflicted with this change on the same lines, so the campaign
itself is the 1.3.0 vehicle. Registry-state verification happens at the
operator's tag step (GitHub Packages authentication is operator-held).

## Validation (run on the finished tree)

- `npm run verify:all` — build, types, declarations, lint, boundary lint,
  171+ tests, audit, package smoke
- `npm run verify:package` — packed-tarball smoke install passes

The packed artifact (npm pack) and the declaration-consumer fixture inside
verify:all stand as the local release proof; full disposable Website-Bot and
SEO-Bot consumer installs run at the operator's release step before the
1.3.0 tag push, per the contract's release sequence.
