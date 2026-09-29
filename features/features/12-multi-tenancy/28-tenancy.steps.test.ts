import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { tenancySteps } from "../../step-definitions/TenancySteps.ts";
import { WorldLive } from "../../step-definitions/TenancyWorld.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./28-tenancy.feature", import.meta.url)),
);

describeFeature(feature, WorldLive, ({ use }) => {
  use(tenancySteps);
});
