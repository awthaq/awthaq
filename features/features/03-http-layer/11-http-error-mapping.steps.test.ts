import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { httpErrorSteps } from "../../step-definitions/HttpErrorSteps.ts";
import { WorldLive } from "../../step-definitions/HttpErrorWorld.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./11-http-error-mapping.feature", import.meta.url)),
);

describeFeature(feature, WorldLive, ({ use }) => {
  use(httpErrorSteps);
});
