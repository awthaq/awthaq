import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import * as Layer from "effect/Layer";
import { fileURLToPath } from "node:url";
import { WorldLive as AppWorld } from "../../step-definitions/ContractStratumWorld.ts";
import { contractStratumSteps } from "../../step-definitions/ContractStratumSteps.ts";
import { WorldLive as ScratchWorld } from "../../step-definitions/FoundationsWorld.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./04-contract-stratum.feature", import.meta.url)),
);

describeFeature(feature, Layer.mergeAll(ScratchWorld, AppWorld), ({ use }) => {
  use(contractStratumSteps);
});
