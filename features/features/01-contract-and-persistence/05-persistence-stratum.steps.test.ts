import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import * as Layer from "effect/Layer";
import { fileURLToPath } from "node:url";
import { WorldLive } from "../../step-definitions/FoundationsWorld.ts";
import { WorldLive as PasswordWorldLive } from "../../step-definitions/PasswordWorld.ts";
import { passwordTransactionSteps } from "../../step-definitions/PasswordTransactionSteps.ts";
import { persistenceMigrationSteps } from "../../step-definitions/PersistenceMigrationSteps.ts";
import { persistenceStratumSteps } from "../../step-definitions/PersistenceStratumSteps.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./05-persistence-stratum.feature", import.meta.url)),
);

describeFeature(feature, Layer.mergeAll(WorldLive, PasswordWorldLive), ({ use }) => {
  use(persistenceStratumSteps);
  use(persistenceMigrationSteps);
  use(passwordTransactionSteps);
});
