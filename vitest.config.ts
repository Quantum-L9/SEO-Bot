import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Gate 5 lives in `vitest.live.config.ts` — it needs a real Postgres and
    // Redis, and a default run that silently skipped them would report green
    // for a gate it never reached. `npm run test:live` is the way in.
    exclude: ["**/node_modules/**", "**/dist/**", "tests/live/**"],
    // Each test file gets a private on-disk root for the run-evidence store,
    // so parallel files cannot delete each other's persisted state (seo-s9).
    setupFiles: ["tests/setup/isolated-run-evidence-dir.ts"],
  },
});
