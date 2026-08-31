/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - BullMQ job-id rules
 *
 * One place that knows what BullMQ will accept as a custom job id, with no
 * dependency on BullMQ itself, so a test can assert the rule without importing
 * a queue and a caller can compose a key without importing the scheduler.
 *
 * It is a separate module because the rule was previously nowhere: three call
 * sites each interpolated their own key with `:` separators, BullMQ rejects a
 * custom id containing `:`, and every queue in the test suite is a `vi.fn()`
 * that accepts anything. So all three threw in production and asserted green.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/**
 * Whether BullMQ will accept a string as a custom job id.
 *
 * Two documented restrictions, both of which throw at `queue.add()`:
 *
 * - **No `:`.** "Custom job ids must not contain the `:` separator as it will
 *   be translated in 2 different values, since we are also following Redis
 *   naming convention." bullmq@5 has a legacy carve-out accepting an id that
 *   splits into exactly 3 colon-separated parts, for compatibility with old
 *   repeatable jobs; its own source marks that for removal in the next breaking
 *   change. Nothing here should depend on it, so this predicate does not.
 * - **Not all digits.** Those collide with generated ids
 *   (`Error: Custom Id cannot be integers`).
 *
 * `tests/live/queue.live.test.ts` pins this against a real Redis, so it cannot
 * drift into being one more fake that vouches for itself.
 */
export function isBullMqSafeJobId(jobId: string): boolean {
  if (jobId === "") return false;
  if (`${Number.parseInt(jobId, 10)}` === jobId) return false;
  return !jobId.includes(":");
}

/** Separator for composed job ids. Absent from uuids, hex digests and job names. */
export const JOB_ID_SEPARATOR = "~";

/**
 * Compose a deterministic, BullMQ-safe job id from its parts.
 *
 * Colons are the natural separator everywhere else here — job names are
 * `module:action`, BullMQ's own repeatable ids are `repeat:<name>:<ms>` — and
 * they are the one character a custom job id may not contain. So parts are
 * sanitized and joined with a character none of them can hold, which keeps the
 * mapping injective: two different tuples cannot produce one id.
 *
 * Throws rather than mangling if a part contains the separator. A dedup key
 * that silently collides is worse than one that fails to build, because the
 * collision suppresses real work and nothing says so.
 */
export function deterministicJobId(...parts: readonly string[]): string {
  for (const part of parts) {
    if (part.includes(JOB_ID_SEPARATOR)) {
      throw new Error(
        `Job id part "${part}" contains the reserved separator "${JOB_ID_SEPARATOR}"`,
      );
    }
  }
  return parts.map((part) => part.replaceAll(":", "-")).join(JOB_ID_SEPARATOR);
}
