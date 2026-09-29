import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { WorldLive } from "../../step-definitions/FoundationsWorld.ts";
import { persistenceMigrationSteps } from "../../step-definitions/PersistenceMigrationSteps.ts";
import { persistenceStratumSteps } from "../../step-definitions/PersistenceStratumSteps.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./05-persistence-stratum.feature", import.meta.url)),
);

describeFeature(feature, WorldLive, ({ use }) => {
  use(persistenceStratumSteps);
  use(persistenceMigrationSteps);
});
