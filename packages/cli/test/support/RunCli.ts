// Runs the real command tree in-process (`Cli.run`) against a fixed configuration, with the
// process's console captured, and reports what a CI job would see: stdout, stderr and the exit
// code the typed failure carries (`Runtime.errorExitCode`, BEH-EA-225).
//
// The session commands need a `CredentialStore` and an `HttpClient`: by default an in-memory store
// (the OS keychain is never touched from a test) and the real undici client, which the session
// suite points at a real server on localhost.
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Runtime from "effect/Runtime";
import { run } from "../../src/Cli.ts";
import { ConfigUnavailable } from "../../src/CliErrors.ts";
import type { CliConfig } from "../../src/Config.ts";
import * as ConfigModule from "../../src/Config.ts";
import * as CredentialStore from "../../src/CredentialStore.ts";

/** A credential store that lives in a `Ref` the test owns, so it can seed and inspect it. */
export const memoryCredentials = (initial?: CredentialStore.Credential) =>
  Effect.gen(function* () {
    const ref = yield* Ref.make(Option.fromNullishOr(initial));
    const writes = yield* Ref.make(0);
    const layer = Layer.succeed(
      CredentialStore.CredentialStore,
      CredentialStore.CredentialStore.of({
        backend: "memory",
        get: Ref.get(ref),
        set: (credential) =>
          Ref.set(ref, Option.some(credential)).pipe(Effect.andThen(Ref.update(writes, (n) => n + 1))),
        clear: Ref.set(ref, Option.none()),
      }),
    );
    return { ref, writes, layer };
  });

/** The store as the real binary wires it: `AWTHAQ_TOKEN`/`AWTHAQ_BASE_URL` win and are never persisted. */
export const withEnvOverride = (base: Layer.Layer<CredentialStore.CredentialStore>) =>
  Layer.effect(
    CredentialStore.CredentialStore,
    Effect.gen(function* () {
      const store = yield* CredentialStore.CredentialStore;
      return CredentialStore.CredentialStore.of(yield* CredentialStore.withEnvOverride(store));
    }),
  ).pipe(Layer.provide(base));

export const runCli = (
  args: ReadonlyArray<string>,
  config?: CliConfig,
  options?: { readonly credentials?: Layer.Layer<CredentialStore.CredentialStore, unknown> },
) =>
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
    const credentials = options?.credentials ?? (yield* memoryCredentials()).layer;
    const exit = yield* Effect.exit(
      run(args).pipe(
        Effect.provide(
          Layer.mergeAll(source, credentials, NodeHttpClient.layerUndici, NodeServices.layer),
        ),
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
