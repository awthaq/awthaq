import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { WorldLive } from "../../step-definitions/QadiBridgeWorld.ts";
import { resolversSteps } from "../../step-definitions/QadiResolversSteps.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./21-qadi-resolvers-obligations.feature", import.meta.url)),
);

describeFeature(feature, WorldLive, ({ use }) => {
  use(resolversSteps);
});
