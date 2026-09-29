import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import { fileURLToPath } from "node:url";
import { reactSteps } from "../../step-definitions/ReactSteps.ts";
import { WorldLive } from "../../step-definitions/ReactWorld.ts";
import { qadiClientReactSteps } from "../../step-definitions/QadiClientSteps.ts";

const feature = await loadFeature(fileURLToPath(new URL("./23-react.feature", import.meta.url)));

describeFeature(feature, WorldLive, ({ use }) => {
  use(reactSteps);
  use(qadiClientReactSteps);
});
