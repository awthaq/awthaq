import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { passwordSteps } from "../../step-definitions/PasswordSteps.ts";
import { WorldLive } from "../../step-definitions/PasswordWorld.ts";

const feature = await loadFeature(fileURLToPath(new URL("./15-password.feature", import.meta.url)));

describeFeature(feature, WorldLive, ({ use }) => {
  use(passwordSteps);
});
