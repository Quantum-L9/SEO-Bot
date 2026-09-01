/**
 * Gate 5 — the suite that needs real services.
 *
 * Separate from `vitest.config.ts` because these tests have a precondition the
 * others do not: a reachable Postgres and Redis. Mixing them into the default
 * run would mean either a default run that fails without docker, or a skip
 * nobody notices — and a skip nobody notices is how a gap stops being tracked.
 *
 *   docker compose -f docker-compose.validation.yml up -d
 *   npm run test:live
 *
 * `LIVE_SERVICES_REQUIRED=1` turns the skip into a failure. CI sets it, so the
 * suite cannot pass by finding nothing to do.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/live/**/*.live.test.ts"],
    // Real services are shared state. Parallel files would race on the same
    // tables and the same Redis keyspace, and the resulting flake would read as
    // a product bug — which is exactly the misdiagnosis this suite exists to
    // prevent elsewhere.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      // The plane never calls a vendor in this suite. These exist because
      // `getConfig()` validates the whole schema at first use, and a missing
      // key would fail the run for a reason unrelated to what is being tested.
      // Placeholders, not credentials — an accidental live call fails loudly on
      // an unresolvable host rather than quietly succeeding.
      POSTHOG_API_URL: process.env.POSTHOG_API_URL ?? "https://posthog.invalid",
      POSTHOG_PERSONAL_API_KEY: process.env.POSTHOG_PERSONAL_API_KEY ?? "live-suite-placeholder",
      DATAFORSEO_LOGIN: process.env.DATAFORSEO_LOGIN ?? "live-suite-placeholder",
      DATAFORSEO_PASSWORD: process.env.DATAFORSEO_PASSWORD ?? "live-suite-placeholder",
      PAGESPEED_API_KEY: process.env.PAGESPEED_API_KEY ?? "live-suite-placeholder",
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "live-suite-placeholder",
      PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY ?? "live-suite-placeholder",
      NODE_ENV: "test",
    },
  },
});
