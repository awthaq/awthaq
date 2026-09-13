import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { adminSteps } from "../../step-definitions/AdminSteps.ts";
import { WorldLive } from "../../step-definitions/AdminWorld.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./27-admin-impersonation.feature", import.meta.url)),
);

describeFeature(feature, WorldLive, ({ use }) => {
  use(adminSteps);
});
