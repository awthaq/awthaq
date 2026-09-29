import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { scimSteps } from "../../step-definitions/ScimSteps.ts";
import { WorldLive } from "../../step-definitions/ScimWorld.ts";

const feature = await loadFeature(fileURLToPath(new URL("./30-scim.feature", import.meta.url)));

describeFeature(feature, WorldLive, ({ use }) => {
  use(scimSteps);
});
