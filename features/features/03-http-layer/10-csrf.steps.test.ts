import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { csrfSteps } from "../../step-definitions/CsrfSteps.ts";
import { WorldLive } from "../../step-definitions/CsrfWorld.ts";

const feature = await loadFeature(fileURLToPath(new URL("./10-csrf.feature", import.meta.url)));

describeFeature(feature, WorldLive, ({ use }) => {
  use(csrfSteps);
});
