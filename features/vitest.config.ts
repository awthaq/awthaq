import { gherkinTags, gherkinWatchTriggers } from "@effect-cucumber/vitest";
import { defineConfig } from "vitest/config";

// No fileParallelism/isolate/pool tuning yet: qadi's own features/vitest.config.ts
// overrides those defaults, but only after measuring against its real suite
// (2989 tests, some sharing process-wide singleton state). This suite is one
// smoke scenario today; the real 602 spec scenarios (features/features/00-*
// through 08-*) have no step-definitions yet (see features/README.md). Revisit
// tuning once they're actually wired to running code, with real measurements
// of this suite's own behavior rather than reused numbers from a different one.
export default defineConfig({
  test: {
    include: ["features/**/*.steps.test.ts"],
    tags: [
      ...gherkinTags("features/**/*.feature", { cwd: process.cwd() }),
      { name: "@skip" },
      { name: "@only" },
    ],
  },
  plugins: [gherkinWatchTriggers("features/**/*.feature", { cwd: process.cwd() })],
});
