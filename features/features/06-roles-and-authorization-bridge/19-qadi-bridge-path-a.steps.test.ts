import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { pathASteps } from "../../step-definitions/QadiBridgePathASteps.ts";
import { WorldLive } from "../../step-definitions/QadiBridgeWorld.ts";
import {
  authorizedSubjectTypeSteps,
  witnessTypeSteps,
} from "../../step-definitions/CompileTimeSteps.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./19-qadi-bridge-path-a.feature", import.meta.url)),
);

describeFeature(feature, WorldLive, ({ use }) => {
  use(pathASteps);
  use(authorizedSubjectTypeSteps);
  use(witnessTypeSteps);
});
