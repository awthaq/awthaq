import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { WorldLive } from "../../step-definitions/DomainWorld.ts";
import { verificationSteps } from "../../step-definitions/VerificationSteps.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./08-verification-tokens.feature", import.meta.url)),
);

describeFeature(feature, WorldLive, ({ use }) => {
  use(verificationSteps);
});
