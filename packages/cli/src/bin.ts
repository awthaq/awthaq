#!/usr/bin/env node
// @awthaq/cli — the `awthaq` executable.
//
// The one place the process is touched: it provides the Node platform services and the real
// configuration loader (`awthaq.config.ts`, imported), then hands the argv to `Cli.run` and the
// result to `NodeRuntime.runMain`, whose teardown ends the process with the exit code the typed
// failure carries (`Runtime.errorExitCode`, BEH-EA-225). No command sets `process.exitCode`.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stdio from "effect/Stdio";
import { run } from "./Cli.ts";
import * as CliConfig from "./Config.ts";

const program = Stdio.Stdio.use(({ args }) => Effect.flatMap(args, run)).pipe(
  Effect.provide(CliConfig.layerFile.pipe(Layer.provideMerge(NodeServices.layer))),
);

// Typed CLI errors carry `[Runtime.errorReported] = false` (they render themselves); a defect still reports.
NodeRuntime.runMain(program);
