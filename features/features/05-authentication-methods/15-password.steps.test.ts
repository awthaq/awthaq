import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import * as Layer from "effect/Layer";
import { fileURLToPath } from "node:url";
import { passwordParameterTypes } from "../../step-definitions/PasswordParameterTypes.ts";
import { passwordSteps } from "../../step-definitions/PasswordSteps.ts";
import { WorldLive } from "../../step-definitions/PasswordWorld.ts";
import { twoFactorResetSteps } from "../../step-definitions/TwoFactorResetSteps.ts";
import { WorldLive as TwoFactorWorldLive } from "../../step-definitions/TwoFactorWorld.ts";

// AH-007: `{passwordConfig}` and `{breachFailure}` are declared parameter types, so the feature's
// config literals resolve by exact match instead of a bare `{string}` step dispatching on substrings.
const feature = await loadFeature(
  fileURLToPath(new URL("./15-password.feature", import.meta.url)),
  passwordParameterTypes,
);

// BEH-EA-259 (BCR-010) is wired over the two-factor composition: Password's own HTTP world has no
// second factor, and `TwoFactorWorld` builds its composition lazily, so the other Rules pay nothing for it.
describeFeature(feature, Layer.mergeAll(WorldLive, TwoFactorWorldLive), ({ use }) => {
  use(passwordSteps);
  use(twoFactorResetSteps);
});
