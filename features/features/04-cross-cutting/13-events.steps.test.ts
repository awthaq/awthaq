import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { eventsSteps } from "../../step-definitions/EventsSteps.ts";
import { WorldLive } from "../../step-definitions/EventsWorld.ts";

const feature = await loadFeature(fileURLToPath(new URL("./13-events.feature", import.meta.url)));

describeFeature(feature, WorldLive, ({ use }) => {
  use(eventsSteps);
});
