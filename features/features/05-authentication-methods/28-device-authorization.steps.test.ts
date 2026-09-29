import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { deviceAuthorizationSteps } from "../../step-definitions/DeviceAuthorizationSteps.ts";
import { WorldLive } from "../../step-definitions/DeviceAuthorizationWorld.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./28-device-authorization.feature", import.meta.url)),
);

describeFeature(feature, WorldLive, ({ use }) => {
  use(deviceAuthorizationSteps);
});
