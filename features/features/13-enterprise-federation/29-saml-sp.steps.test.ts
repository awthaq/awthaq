import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { samlSteps } from "../../step-definitions/SamlSteps.ts";
import { WorldLive } from "../../step-definitions/SamlWorld.ts";

const feature = await loadFeature(fileURLToPath(new URL("./29-saml-sp.feature", import.meta.url)));

describeFeature(feature, WorldLive, ({ use }) => {
  use(samlSteps);
});
