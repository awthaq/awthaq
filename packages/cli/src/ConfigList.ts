// @awthaq/cli — ConfigList
//
// spec/behaviors/26-cli.md BEH-EA-229 (ECS-008, EP-009), BEH-EA-208 class 1: `awthaq config list`
// prints every configuration descriptor the CLI can see (the manifest's, core's, the server's) with
// its default and, when the configuration module exports a configuration Layer, the value that
// Layer sets and whether it overrides the default. It answers the question ADR-EA-006's first
// revision left unanswerable — "what is `Password`'s `minLength` in this application?" — without
// running the application. A value declared sensitive, or held in a `Redacted`, prints as
// `<redacted>` and is never unwrapped (BEH-EA-201).

import { EffectiveConfig } from "@awthaq/core";
import * as Effect from "effect/Effect";
import type { CliConfig } from "./Config.ts";
import * as Doctor from "./Doctor.ts";
import * as Output from "./Output.ts";

export const renderText = (items: ReadonlyArray<EffectiveConfig.Item>) =>
  items.flatMap((item) => [
    `${item.owner}  ${item.key}  (${item.source})`,
    ...item.entries.map((entry) => `  ${entry.path} = ${entry.value}`),
  ]);

export const show = (config: CliConfig) =>
  Effect.gen(function* () {
    const context = yield* Doctor.configContext(config);
    const items = EffectiveConfig.read(context, Doctor.descriptorsOf(config));
    yield* Output.report(items, renderText);
  });
