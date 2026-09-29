import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { pathBSteps } from "../../step-definitions/QadiBridgePathBSteps.ts";
import { WorldLive } from "../../step-definitions/QadiBridgeWorld.ts";
import { publicEndpointTypeSteps } from "../../step-definitions/CompileTimeSteps.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./20-qadi-bridge-path-b.feature", import.meta.url)),
);

describeFeature(feature, WorldLive, ({ use }) => {
  use(pathBSteps);
  use(publicEndpointTypeSteps);
});
