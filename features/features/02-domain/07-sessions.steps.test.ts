import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { sessionSteps } from "../../step-definitions/SessionSteps.ts";
import { WorldLive } from "../../step-definitions/SessionWorld.ts";

const feature = await loadFeature(fileURLToPath(new URL("./07-sessions.feature", import.meta.url)));

describeFeature(feature, WorldLive, ({ use }) => {
  use(sessionSteps);
});
