import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { oauthParameterTypes, oauthSteps } from "../../step-definitions/OAuthSteps.ts";
import { WorldLive } from "../../step-definitions/OAuthWorld.ts";
import { oauthSecretTypeSteps } from "../../step-definitions/CompileTimeSteps.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./16-oauth.feature", import.meta.url)),
  oauthParameterTypes,
);

describeFeature(feature, WorldLive, ({ use }) => {
  use(oauthSteps);
  use(oauthSecretTypeSteps);
});
