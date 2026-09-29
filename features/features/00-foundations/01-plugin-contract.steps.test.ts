import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { WorldLive } from "../../step-definitions/FoundationsWorld.ts";
import { pluginContractSteps } from "../../step-definitions/PluginContractSteps.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./01-plugin-contract.feature", import.meta.url)),
);

describeFeature(feature, WorldLive, ({ use }) => {
  use(pluginContractSteps);
});
