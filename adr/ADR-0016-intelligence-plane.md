<!-- L9_META: layer=architecture, role=intelligence_plane_adr, status=accepted, version=1.0.0 -->
# ADR-0016: The Bot Is the Primary Consumer of Its Own SQL

## Status
Accepted.

## Date
2026-08-31

## Context
ADR-0015 builds a governed read plane and frames its consumers as humans and
external agents. That framing is backwards for this system.

SEO-Bot is a 24/7 maintenance daemon whose operator's daily job is reviewing a
weekly report and approving queued actions. If a human has to ask "which
keywords dropped on pages that are also slow?", the bot should have asked itself
that question first — at 07:30, every day, for every client.

The five modules each write facts and each act within their own lane. Nothing
reads across them. A keyword drop, a 71% exit rate, and a competitor's answer-
engine citation can all concern the same URL, and today they produce three
independent module behaviors. The joins that connect them exist only when a
human writes them by hand, after the fact.

Meanwhile `action_outcomes` already has `positionBefore` / `positionAfter` /
`success` / `learnings` and a memory-promotion path — but nothing decides WHEN
"after" is. Without a measurement window, "did it work?" has no answer, so the
learning loop the schema anticipates never closes.

## Decision
Add an intelligence plane: a deterministic, SQL-backed reasoning subsystem that
converts telemetry into signals, opportunities, decisions, and measured
outcomes. The bot is its primary consumer; the operator dashboard, the REST API,
and external agents are secondary.

**1. Interpretation is durable (migration 0003).** `intelligence_runs`,
`intelligence_signals`, `intelligence_opportunities`, `intelligence_decisions`,
`intelligence_experiments`, `intelligence_policy_state`. Operational tables
record facts; these record what the bot made of them. An operator can
reconstruct why the bot did something months later from the database alone.

**2. Signals are observations, never instructions.** Eight extractors run per
client per day, each one deterministic SQL — zero tokens. Several read the
ADR-0015 reporting views rather than re-deriving "latest row per entity"
windows, so the bot's reasoning and the operator's dashboard cannot disagree.
Each signal carries a value-only `fingerprint` for suppression and run
idempotency.

**3. Opportunities are signals grouped by TARGET.** Signals normalize a page key
(`https://x.example/pricing?utm=y` → `/pricing`), and a keyword drop on a page
groups with an experience problem on that same page. The group is classified by
an ordered rule table and scored:

```
score = impact × confidence × urgency ÷ max(effort + risk, 1)   (scaled ×40)
```

with hand-set per-type constants. Deterministic, explicable, reproducible — an
operator asking "why that first?" gets the same answer twice.

The scale matters more than it looks. Unscaled, the band the shape constants
produce is 0–2.5, and a threshold set anywhere in a 0–100 mental model would put
every actionable type permanently below the bar — the plane would observe
forever and propose nothing, with no error and no failing test to say so. The
scale places a strong compound case near 55 and a low-severity single finding
near 10, so the default threshold of 20 separates them. A test asserts that
relationship directly rather than trusting the constants.

**4. The governors become SQL-readable state.** `intelligence_policy_state`
holds the pause switch, the ranking circuit breaker, outreach headroom, and
daily LLM headroom, each computed from the same function and constants the
enforcing module uses (`velocityRunLimit`, `LINK_VELOCITY`, the 30% circuit
threshold). The policy engine is pure and can only refuse.

**5. The LLM receives an evidence pack, never a socket.** Packs carry industry
and market — never client name, domain, contact, or credential — plus explicit
`allowed_actions` and `forbidden_actions`. Redaction is asserted by walking the
finished pack and throwing on any forbidden key, email, or absolute URL.

**6. Acting stays where it already is.** A permitted opportunity becomes an
`ActionProposal` for the EXISTING execution policy, which decides autonomy
versus approval, and a follow-up job from the EXISTING `TRIGGERABLE_JOBS`
allow-list — which excludes `serp:execute-surpass-plans`, the gated live-site
write path (AGENTS §9). The plane proposes; it never mutates.

**7. Measurement closes the loop.** An executed action opens an experiment with
a baseline window before and a measurement window after. A daily pass measures
the due ones and writes `measuredAt` / `success` / `learnings` onto the existing
`action_outcomes` row, which the existing memory promoter already picks up. Thin
samples return `inconclusive` and promote nothing.

## Rationale
The leverage is grouping. Acting module-by-module treats a slow page that lost a
ranking as two problems and applies two partial remedies. Reading across the
modules in SQL turns it into one problem with one fix, and that is a capability
no individual module can have.

Determinism is not a limitation here, it is the point. The scoring and the
policy gate produce numbers an operator can check and a test can pin. A model
asked to rank a portfolio produces a different order each run, cannot be
regression-tested, and costs tokens per client per day — for a decision that
arithmetic makes better.

Inverting the LLM's relationship to the database is the same argument. A model
with a socket writes its own joins, sees whatever the columns contain, and must
be trusted not to act outside scope. A model with an evidence pack sees exactly
what was put in it, and `forbidden_actions` is a fact about the pack rather than
an instruction it may reinterpret.

Reusing `action_outcomes` rather than adding an outcomes table is deliberate:
the memory-promotion pipeline already reads it. A parallel table would mean
building a second promoter, and then having two disagreeing records of whether
something worked.

## Consequences
**Positive.** Cross-module diagnosis becomes routine rather than manual. Every
decision is durable and explicable. The bot learns from measured outcomes rather
than from assumed ones. Approval queue volume is bounded by fingerprint
suppression and a per-run action ceiling.

**Negative.** Four new scheduled jobs, six new tables, and roughly one
intelligence run per active client per day. The scoring constants are judgment
calls that will need tuning against real outcomes — they are in one table, and
`intelligence_experiments` is what will eventually tell us they are wrong. A
poorly-set `INTELLIGENCE_MIN_OPPORTUNITY_SCORE` either floods the approval queue
or silences the plane; the default of 20 is conservative.

**Neutral.** Signal severity thresholds are hand-set. They are pure functions
with direct tests, so changing one is a small, reviewable diff.

**Explicitly out of scope.** This plane does not write to a client site, does not
widen the execution policy's auto-execute band, does not reclassify a CRITICAL
action, and does not touch the gated site-deployment path. Doing any of those
requires operator sign-off under AGENTS §9, not a change here.

## Alternatives Considered
**Leave SQL as an operator convenience (ADR-0015 alone).** Works, and leaves the
bot acting module-by-module while a human does the joining. Rejected because the
joining is the value.

**An LLM agent with reporting-plane access, reasoning freely.** Flexible and
genuinely capable. Rejected: non-reproducible ranking, per-client daily token
cost for a decision arithmetic makes better, and no way to regression-test a
prioritization that changes every run.

**Extend each module to notice its own compound cases.** Keeps the module
boundary clean. Rejected: every module would need to read the others' tables,
which is the cross-module coupling the boundary exists to prevent — and five
copies of the window logic.

**Measure outcomes inline at execution.** Simplest. Rejected because it is
wrong: an SEO change has no observable effect at the moment it ships, so an
inline measurement records noise and labels it a learning.

## Validation / Evidence
- `tests/intelligence/opportunity-scorer.test.ts` — grouping merges signals on a
  shared target, keeps tenants apart, and ranks reproducibly; every signal type
  has a grouping rule; every actionable opportunity type can clear the default
  action threshold at a plausible severity, and a low-severity one cannot.
- `tests/intelligence/runner.test.ts` — each decision links to its opportunity
  and each experiment to its decision (an unlinked foreign key is the failure
  that produces a healthy-looking database of orphan rows); only allow-listed
  jobs are queued; a run with no scheduler still reasons and still records.
- `tests/intelligence/policy-engine.test.ts` — refusal precedence; unknown
  budget defers rather than spends; diagnostics are never silenced by a pause.
- `tests/intelligence/evidence-pack.test.ts` — hostile evidence containing a
  credential, a domain, and an email survives redaction with none of them intact.
- `tests/intelligence/action-planner.test.ts` — every template action is inside
  its allow-list and no follow-up job can reach the gated live-write job.
- `tests/intelligence/signal-extractor.test.ts` — severity and confidence
  mapping, pg string-numeric coercion, per-tenant scoping of every query.
- `tests/intelligence/outcome-attribution.test.ts` — metric direction (a falling
  SERP position is an improvement), thin samples return `inconclusive`.
- `tests/intelligence/registration.test.ts` — every job declares a zero token
  budget; a failed materialized refresh throws so it is recorded.

## Related Artifacts
- `drizzle/0003_intelligence_plane.sql`
- `src/intelligence/`, `src/core/database/schema-intelligence.ts`
- ADR-0015 (reporting plane), ADR-0003 (token efficiency), ADR-0004 (BullMQ),
  ADR-0006 (competitor kill-chain), AGENTS §9 (safety boundaries)

## Open Questions
- Whether the scoring constants should become per-industry once enough measured
  experiments exist to justify differentiating them.
- **Resolved — a portfolio-wide run type belongs here.** `weekly_portfolio_benchmark`
  (contract C1) records a snapshot of the benchmark plane on `intelligence_runs`
  with a null `client_id`. It is deterministic and zero-token like every other
  run type, and what it adds over an operator-initiated report is history: how
  many cohorts were publishable, and how many existed but sat below the
  k-anonymity floor. Without that, an operator finding an empty benchmark cannot
  tell a working privacy control from a broken pipeline.
- **Resolved — status transitions automatically** (contract C3), because it was
  never really a choice: with no transition, the runner's duplicate-suppression
  lookup matched every opportunity ever recorded, so a problem acted on once and
  not actually fixed was suppressed forever. An `improved` verdict resolves the
  opportunity; `declined` and `unchanged` REOPEN it, since a remedy that did not
  work leaves the problem in place and the next cycle has to be free to try
  something else. `inconclusive` moves nothing. Operators retain the override
  they always had — a status is a column, not a state machine locked in code.
