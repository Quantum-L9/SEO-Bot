# GMP-129

**Task:** Accept DataForSEO status 40106 in organicSerpTask when the task still carries a result array. Parse organic items the same way as a normal result and record that the task was partial. Do not retry 40106. If result is missing, fail closed. An empty item list stays a valid empty query.
**Tier:** RUNTIME

## TODOs

- accept-40106: src/services/dataforseo.ts REPLACE Accept DataForSEO status 40106 in organicSerpTask when the task still carries a result array, parse its organic items the same way as status 20000, record the task as partial, and do not add 40106 to the 40101 retry set. Missing result stays fail-closed.
- test-40106: tests/services/dataforseo.test.ts REPLACE Prove a 40106 result array returns organic observations and is recorded partial, an empty item list is a valid empty query, a missing result fails closed without a resubmit, and 40106 is not retryable.
