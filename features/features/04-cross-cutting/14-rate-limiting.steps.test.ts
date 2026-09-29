import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { rateLimitingSteps } from "../../step-definitions/RateLimitingSteps.ts";
import { WorldLive } from "../../step-definitions/RateLimitingWorld.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./14-rate-limiting.feature", import.meta.url)),
);

describeFeature(feature, WorldLive, ({ use }) => {
  use(rateLimitingSteps);
});
