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
//
// BDD-002 (.issues/high): every .feature file now has a matching
// *.steps.test.ts, so `include` above genuinely covers the whole suite —
// no Feature is silently absent from a run. A Feature with no real step
// definitions yet carries `@skip @unwired` at the Feature level (inherited
// by every Scenario) and its own *.steps.test.ts registers zero steps:
// `@skip` is what keeps it a visible, non-blocking "skipped" node rather
// than a real failure; `@unwired` is a plain grep-able marker distinguishing
// "never wired" from an ordinary flaky/disabled `@skip` on an otherwise-wired
// Feature. Wiring real steps for one of these (AH-003, tiered by
// `.scratch/resolve-ready-for-human-findings/issues/36-bdd-feature-wiring-prioritization.md`)
// removes both tags and fills in that Feature's own placeholder file — it
// never needs a NEW file to be created.
export default defineConfig({
  test: {
    include: ["features/**/*.steps.test.ts"],
    tags: gherkinTags("features/**/*.feature", { cwd: process.cwd() }),
  },
  plugins: [gherkinWatchTriggers("features/**/*.feature", { cwd: process.cwd() })],
});
