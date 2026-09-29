// DAG-007: this Feature carries no step definitions yet — the `DeviceAuthorization`
// plugin it specifies is not built (spec/models/13-device-authorization.md; blocked by DAG-005's
// device-authorization-grant workstream). Registering
// it here with zero steps, against `@skip @unwired`, makes every Scenario a real,
// individually reported vitest node (status: skipped) instead of invisible — vitest's
// include glob only discovers `*.steps.test.ts` files. Wiring real steps replaces this
// placeholder's empty step set and removes `@skip @unwired` from the .feature file.
import { describeFeature, loadFeature } from "@effect-cucumber/vitest";
import * as Layer from "effect/Layer";
import { fileURLToPath } from "node:url";

const feature = await loadFeature(
  fileURLToPath(new URL("./28-device-authorization.feature", import.meta.url)),
);

describeFeature(feature, Layer.empty, () => {});
