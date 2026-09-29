import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { twoFactorSecuritySteps } from "../../step-definitions/TwoFactorSecuritySteps.ts";
import { twoFactorSteps } from "../../step-definitions/TwoFactorSteps.ts";
import { WorldLive } from "../../step-definitions/TwoFactorWorld.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./31-two-factor.feature", import.meta.url)),
);

describeFeature(feature, WorldLive, ({ use }) => {
  use(twoFactorSteps);
  use(twoFactorSecuritySteps);
});
