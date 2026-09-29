import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { emailOtpSteps } from "../../step-definitions/EmailOtpSteps.ts";
import { WorldLive } from "../../step-definitions/MagicLinkWorld.ts";
import { passwordlessCommonSteps } from "../../step-definitions/PasswordlessCommonSteps.ts";
import { numericValueTypeSteps } from "../../step-definitions/CompileTimeSteps.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./33-email-otp.feature", import.meta.url)),
);

describeFeature(feature, WorldLive, ({ use }) => {
  use(passwordlessCommonSteps);
  use(emailOtpSteps);
  use(numericValueTypeSteps);
});
