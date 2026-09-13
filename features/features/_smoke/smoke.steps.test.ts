import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { smokeSteps } from "../../step-definitions/SmokeSteps.ts";
import { WorldLive } from "../../step-definitions/SmokeWorld.ts";

const feature = await loadFeature(fileURLToPath(new URL("./smoke.feature", import.meta.url)));

describeFeature(feature, WorldLive, ({ use }) => {
  use(smokeSteps);
});
