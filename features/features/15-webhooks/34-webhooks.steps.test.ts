import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { webhooksSteps } from "../../step-definitions/WebhooksSteps.ts";
import { WorldLive } from "../../step-definitions/WebhooksWorld.ts";

const feature = await loadFeature(fileURLToPath(new URL("./34-webhooks.feature", import.meta.url)));

describeFeature(feature, WorldLive, ({ use }) => {
  use(webhooksSteps);
});
