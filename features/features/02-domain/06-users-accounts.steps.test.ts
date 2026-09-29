import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { WorldLive } from "../../step-definitions/DomainWorld.ts";
import { userFieldsSteps } from "../../step-definitions/UserFieldsSteps.ts";
import { usersAccountsSteps } from "../../step-definitions/UsersAccountsSteps.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./06-users-accounts.feature", import.meta.url)),
);

describeFeature(feature, WorldLive, ({ use }) => {
  use(usersAccountsSteps);
  use(userFieldsSteps);
});
