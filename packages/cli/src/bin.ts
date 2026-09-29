#!/usr/bin/env node
// @awthaq/cli — the `awthaq` executable.
//
// The one place the process is touched: it provides the Node platform services and the real
// configuration loader (`awthaq.config.ts`, imported), then hands the argv to `Cli.run` and the
// result to `NodeRuntime.runMain`, whose teardown ends the process with the exit code the typed
// failure carries (`Runtime.errorExitCode`, BEH-EA-225). No command sets `process.exitCode`.

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stdio from "effect/Stdio";
import { run } from "./Cli.ts";
import * as CliConfig from "./Config.ts";
import * as CredentialStore from "./CredentialStore.ts";

// The session commands' credential store (OS keychain first, else a 0600 file, `AWTHAQ_TOKEN` winning)
// and the HTTP client they speak to a running auth server with; the manifest commands use neither.
const Platform = Layer.mergeAll(
  CliConfig.layerFile,
  CredentialStore.layer.pipe(Layer.provide(CredentialStore.layerExec)),
  NodeHttpClient.layerUndici,
).pipe(Layer.provideMerge(NodeServices.layer));

const program = Stdio.Stdio.use(({ args }) => Effect.flatMap(args, run)).pipe(
  Effect.provide(Platform),
);

// Typed CLI errors carry `[Runtime.errorReported] = false` (they render themselves); a defect still reports.
NodeRuntime.runMain(program);
