import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { organizationSteps } from "../../step-definitions/OrganizationSteps.ts";
import { WorldLive } from "../../step-definitions/OrganizationWorld.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./35-organization.feature", import.meta.url)),
);

describeFeature(feature, WorldLive, ({ use }) => {
  use(organizationSteps);
});
