import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { passwordParameterTypes } from "../../step-definitions/PasswordParameterTypes.ts";
import { passwordSteps } from "../../step-definitions/PasswordSteps.ts";
import { WorldLive } from "../../step-definitions/PasswordWorld.ts";

// AH-007: `{passwordConfig}` and `{breachFailure}` are declared parameter types, so the feature's
// config literals resolve by exact match instead of a bare `{string}` step dispatching on substrings.
const feature = await loadFeature(
  fileURLToPath(new URL("./15-password.feature", import.meta.url)),
  passwordParameterTypes,
);

describeFeature(feature, WorldLive, ({ use }) => {
  use(passwordSteps);
});
