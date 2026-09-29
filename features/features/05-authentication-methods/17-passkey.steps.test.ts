import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { passkeyParameterTypes, passkeySteps } from "../../step-definitions/PasskeySteps.ts";
import { WorldLive } from "../../step-definitions/PasskeyWorld.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./17-passkey.feature", import.meta.url)),
  passkeyParameterTypes,
);

describeFeature(feature, WorldLive, ({ use }) => {
  use(passkeySteps);
});
