import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { oauthSteps } from "../../step-definitions/OAuthSteps.ts";
import { WorldLive } from "../../step-definitions/OAuthWorld.ts";

const feature = await loadFeature(fileURLToPath(new URL("./16-oauth.feature", import.meta.url)));

describeFeature(feature, WorldLive, ({ use }) => {
  use(oauthSteps);
});
