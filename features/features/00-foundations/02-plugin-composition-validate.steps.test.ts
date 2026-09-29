import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { compositionSteps } from "../../step-definitions/CompositionSteps.ts";
import { WorldLive } from "../../step-definitions/FoundationsWorld.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./02-plugin-composition-validate.feature", import.meta.url)),
);

describeFeature(feature, WorldLive, ({ use }) => {
  use(compositionSteps);
});
