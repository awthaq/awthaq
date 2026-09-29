import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { nextSsrSteps } from "../../step-definitions/NextSsrSteps.ts";
import { WorldLive } from "../../step-definitions/NextSsrWorld.ts";
import { qadiClientNextSteps } from "../../step-definitions/QadiClientSteps.ts";

const feature = await loadFeature(
  fileURLToPath(new URL("./24-nextjs-ssr.feature", import.meta.url)),
);

describeFeature(feature, WorldLive, ({ use }) => {
  use(nextSsrSteps);
  use(qadiClientNextSteps);
});
