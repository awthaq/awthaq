import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { authenticationSteps } from "../../step-definitions/AuthenticationSteps.ts";
import { WorldLive } from "../../step-definitions/AuthenticationWorld.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./09-authentication-middleware.feature", import.meta.url)),
);

describeFeature(feature, WorldLive, ({ use }) => {
  use(authenticationSteps);
});
