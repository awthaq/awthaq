import { gherkinTags, gherkinWatchTriggers } from "@effect-cucumber/vitest";
import { defineConfig } from "vitest/config";

// No fileParallelism/isolate/pool tuning yet: qadi's own features/vitest.config.ts
// overrides those defaults, but only after measuring against its real suite
// (2989 tests, some sharing process-wide singleton state). Shipping-gap map
// (.scratch/shipping-gaps), ticket 20 onward: step-definitions are now wired
// for a growing subset of features/features/00-* through 08-*, tracked
// scenario-by-scenario in each .feature file's own @skip-tagged pruned set.
// Revisit tuning once the whole suite is wired, with real measurements of
// this suite's own behavior rather than reused numbers from a different one.
//
// `@skip`/`@only` are NOT hand-added here — `gherkinTags` already discovers
// both the moment any `.feature` file carries them (ticket 20's own
// `15-password.feature` does), and a duplicate hand-written entry is a
// startup error ("Tag names must be unique"), not a harmless no-op.
export default defineConfig({
  test: {
    include: ["features/**/*.steps.test.ts"],
    tags: gherkinTags("features/**/*.feature", { cwd: process.cwd() }),
  },
  plugins: [gherkinWatchTriggers("features/**/*.feature", { cwd: process.cwd() })],
});
