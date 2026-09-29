import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { WorldLive } from "../../step-definitions/FoundationsWorld.ts";
import { registriesSteps } from "../../step-definitions/RegistriesSteps.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./03-ports-slots-hooks-registries.feature", import.meta.url)),
);

describeFeature(feature, WorldLive, ({ use }) => {
  use(registriesSteps);
});
