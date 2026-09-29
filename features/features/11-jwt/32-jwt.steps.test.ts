import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { jwtSteps } from "../../step-definitions/JwtSteps.ts";
import { WorldLive } from "../../step-definitions/JwtWorld.ts";

const feature = await loadFeature(fileURLToPath(new URL("./32-jwt.feature", import.meta.url)));

describeFeature(feature, WorldLive, ({ use }) => {
  use(jwtSteps);
});
