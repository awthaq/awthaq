// @awthaq/cli — Output
//
// One place every command writes through, so the two output rules of the spec
// hold for all of them by construction rather than by review:
//
//   - `--json` (BEH-EA-225): a command's result, and its failure, are data. A
//     failure document carries the same `_tag` and exit code the process ends
//     with, so a CI job never scrapes prose.
//   - No secret values (BEH-EA-201, ECS-005): a command hands `Output` values it
//     already redacted (`ConfigDescriptor` renders `<redacted>`); `Output` itself
//     never receives a `Redacted`, and `failure` prints an error's own `message`,
//     which the error classes build from names and counts, never from a value.
//
// `layerConsole` is the process's real stdout/stderr; `capture` is what tests use.

import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Runtime from "effect/Runtime";
import type { CliError } from "./CliErrors.ts";

export interface OutputShape {
  readonly json: boolean;
  /** A line on stdout. */
  readonly line: (text: string) => Effect.Effect<void>;
  /** A line on stderr (progress, warnings, the fallback-store notice). */
  readonly warn: (text: string) => Effect.Effect<void>;
  /** One JSON document on stdout. */
  readonly document: (value: unknown) => Effect.Effect<void>;
}

export class Output extends Context.Service<Output, OutputShape>()("awthaq/cli/Output") {}

const stringify = (value: unknown) => JSON.stringify(value, null, 2);

export const layerConsole = (json: boolean) =>
  Layer.succeed(
    Output,
    Output.of({
      json,
      line: (text) => Console.log(text),
      warn: (text) => Console.error(text),
      document: (value) => Console.log(stringify(value)),
    }),
  );

/** What a test reads back: stdout lines, stderr lines and JSON documents, in order. */
export interface Captured {
  readonly stdout: Ref.Ref<ReadonlyArray<string>>;
  readonly stderr: Ref.Ref<ReadonlyArray<string>>;
  readonly documents: Ref.Ref<ReadonlyArray<unknown>>;
}

export const capture = (json: boolean) =>
  Effect.gen(function* () {
    const stdout = yield* Ref.make<ReadonlyArray<string>>([]);
    const stderr = yield* Ref.make<ReadonlyArray<string>>([]);
    const documents = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const push = (ref: Ref.Ref<ReadonlyArray<string>>) => (text: string) =>
      Ref.update(ref, (lines) => [...lines, text]);
    const captured: Captured = { stdout, stderr, documents };
    const layer = Layer.succeed(
      Output,
      Output.of({
        json,
        line: push(stdout),
        warn: push(stderr),
        document: (value) =>
          Ref.update(documents, (all) => [...all, value]).pipe(
            Effect.andThen(push(stdout)(stringify(value))),
          ),
      }),
    );
    return { captured, layer };
  });

/** Prints `value` as a JSON document under `--json`, otherwise the lines `render` builds. */
export const report = <A>(value: A, render: (value: A) => ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const out = yield* Output;
    if (out.json) return yield* out.document(value);
    yield* Effect.forEach(render(value), out.line, { discard: true });
  });

/** The failure document `--json` prints and the exit code the process ends with (BEH-EA-225). */
export const failureDocument = (error: CliError) => ({
  _tag: error._tag,
  code: Runtime.getErrorExitCode(error),
  message: error.message,
});

/**
 * Renders a typed failure on stderr — stdout stays the command's result, so a `--json` consumer
 * parsing stdout never meets a second document: a JSON failure document under `--json`,
 * `awthaq: <message>` otherwise.
 */
export const failure = (error: CliError) =>
  Effect.gen(function* () {
    const out = yield* Output;
    yield* out.warn(out.json ? JSON.stringify(failureDocument(error)) : `awthaq: ${error.message}`);
  });
