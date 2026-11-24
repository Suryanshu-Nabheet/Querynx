import { defineConfig } from "vitest/config";

/**
 * Shared vitest defaults. Slow CI runners need roomier timeouts than
 * a dev laptop: 15s per test and 90s per suite keeps real regressions
 * failing while letting heavyweight scenarios (pathological payloads,
 * fake-timer retry loops, crawl engine e2e) complete.
 */
export default defineConfig({
  test: {
    include: [
      "security/**/*.test.ts",
      "integration/**/*.test.ts",
      "e2e/**/*.test.ts",
      "unit/**/*.test.ts",
      "fixtures/**/*.test.ts",
    ],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    teardownTimeout: 10_000,
  },
});
