import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { hooksSteps } from "../../step-definitions/HooksSteps.ts";
import { WorldLive } from "../../step-definitions/HooksWorld.ts";
import { hookTypeSteps } from "../../step-definitions/CompileTimeSteps.ts";

const feature = await loadFeature(fileURLToPath(new URL("./12-hooks.feature", import.meta.url)));

describeFeature(feature, WorldLive, ({ use }) => {
  use(hooksSteps);
  use(hookTypeSteps);
});
