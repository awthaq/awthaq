// BDD-002 (.issues/high): this Feature carries no step definitions yet —
// its own header comment marks it pre-implementation spec prose (a target
// the future testing harness, BEH-EA-193..200, is meant to execute
// against). Registering it here with zero steps, against `@skip @unwired`
// (the Feature-level tag this file's own scenarios inherit), makes every
// Scenario a real, individually reported vitest node (status: skipped)
// instead of invisible — vitest's include glob only discovers
// `*.steps.test.ts` files, so an unwired `.feature` with no file here at
// all never appears in any run, pass, fail, or report. Wiring real steps
// (AH-003, tiered by `.scratch/resolve-ready-for-human-findings/issues/36-bdd-feature-wiring-prioritization.md`)
// replaces this placeholder's empty step set and removes `@skip @unwired`
// from the .feature file — it does not touch this file's own shape.
import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import * as Layer from "effect/Layer";
import { fileURLToPath } from "node:url";

const feature = await loadFeature(
  fileURLToPath(new URL("./02-plugin-composition-validate.feature", import.meta.url)),
);

describeFeature(feature, Layer.empty, () => {});
