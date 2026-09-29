import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { WorldLive } from "../../step-definitions/QadiBridgeWorld.ts";
import { rolesSubjectResolverSteps } from "../../step-definitions/RolesSubjectResolverSteps.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./18-roles-subject-resolver.feature", import.meta.url)),
);

describeFeature(feature, WorldLive, ({ use }) => {
  use(rolesSubjectResolverSteps);
});
