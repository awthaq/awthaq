import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { testingHarnessSteps } from "../../step-definitions/TestingHarnessSteps.ts";
import { WorldLive } from "../../step-definitions/TestingHarnessWorld.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./25-testing-harness.feature", import.meta.url)),
);

describeFeature(feature, WorldLive, ({ use }) => {
  use(testingHarnessSteps);
});
