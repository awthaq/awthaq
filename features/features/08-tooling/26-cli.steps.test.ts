import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { cliSteps } from "../../step-definitions/CliSteps.ts";
import { WorldLive } from "../../step-definitions/CliWorld.ts";

const feature = await loadFeature(fileURLToPath(new URL("./26-cli.feature", import.meta.url)));

describeFeature(feature, WorldLive, ({ use }) => {
  use(cliSteps);
});
