import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { clientEffectSteps } from "../../step-definitions/ClientEffectSteps.ts";
import { WorldLive } from "../../step-definitions/ClientEffectWorld.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./22-client-effect.feature", import.meta.url)),
);

describeFeature(feature, WorldLive, ({ use }) => {
  use(clientEffectSteps);
});
