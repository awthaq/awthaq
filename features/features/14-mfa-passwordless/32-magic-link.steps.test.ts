import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { magicLinkSteps } from "../../step-definitions/MagicLinkSteps.ts";
import { WorldLive } from "../../step-definitions/MagicLinkWorld.ts";
import { passwordlessCommonSteps } from "../../step-definitions/PasswordlessCommonSteps.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./32-magic-link.feature", import.meta.url)),
);

describeFeature(feature, WorldLive, ({ use }) => {
  use(passwordlessCommonSteps);
  use(magicLinkSteps);
});
