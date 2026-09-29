// Runs the real command tree in-process (`Cli.run`) against a fixed configuration, with the
// process's console captured, and reports what a CI job would see: stdout, stderr and the exit
// code the typed failure carries (`Runtime.errorExitCode`, BEH-EA-225).
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Runtime from "effect/Runtime";
import { run } from "../../src/Cli.ts";
import { ConfigUnavailable } from "../../src/CliErrors.ts";
import type { CliConfig } from "../../src/Config.ts";
import * as ConfigModule from "../../src/Config.ts";

export interface CliRun {
  readonly code: number;
  readonly stdout: ReadonlyArray<string>;
  readonly stderr: ReadonlyArray<string>;
  readonly exit: Exit.Exit<void, unknown>;
}

export const runCli = (args: ReadonlyArray<string>, config?: CliConfig) =>
  Effect.gen(function* () {
    const stdout: Array<string> = [];
    const stderr: Array<string> = [];
    const capturing: Console.Console = {
      ...globalThis.console,
      log: (...values: ReadonlyArray<unknown>) => {
        stdout.push(values.map(String).join(" "));
      },
      error: (...values: ReadonlyArray<unknown>) => {
        stderr.push(values.map(String).join(" "));
      },
    };
    const source =
      config === undefined
        ? Layer.succeed(
            ConfigModule.ConfigSource,
            ConfigModule.ConfigSource.of({
              load: () =>
                Effect.fail(
                  new ConfigUnavailable({ message: "no configuration module in this test" }),
                ),
            }),
          )
        : ConfigModule.layerFixed(config);
    const exit = yield* Effect.exit(
      run(args).pipe(
        Effect.provide(Layer.merge(source, NodeServices.layer)),
        Effect.provideService(Console.Console, capturing),
      ),
    );
    const code = Exit.isSuccess(exit)
      ? 0
      : (() => {
          const error = Exit.findErrorOption(exit);
          return error._tag === "Some" ? Runtime.getErrorExitCode(error.value) : 1;
        })();
    return { code, stdout, stderr, exit };
  });
