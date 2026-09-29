// This Feature carries no step definitions yet — the `@awthaq/saml` plugin it specifies is not
// built (spec/behaviors/29-saml-sp.md; blocked by AOMS-009 and SFS-003, plan P18). Registering it
// here with zero steps, against `@skip @unwired`, makes every Scenario a real, individually
// reported vitest node (status: skipped) instead of invisible — vitest's include glob only
// discovers `*.steps.test.ts` files. Wiring real steps replaces this placeholder's empty step
// set and removes `@skip @unwired` from the .feature file.
import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import * as Layer from "effect/Layer";
import { fileURLToPath } from "node:url";

const feature = await loadFeature(fileURLToPath(new URL("./29-saml-sp.feature", import.meta.url)));

describeFeature(feature, Layer.empty, () => {});
