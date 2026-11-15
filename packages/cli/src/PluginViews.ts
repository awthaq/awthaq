// @awthaq/cli — PluginViews
//
// spec/behaviors/26-cli.md BEH-EA-202: the one place `awthaq plugin list` resolves its `--format`
// flag and the global `--json` flag. Each view is a `View` (rows builder, text renderer and, for the
// graph, a DOT renderer) and `render` picks the output mode once:
//
//   - a view with a DOT renderer and `--format dot` prints DOT (it beats `--json`);
//   - otherwise `--format json` or the global `--json` prints one JSON document;
//   - otherwise the view's text.
//
// A failure is not a view: it renders through `Output.failure`, which stays on the global flag
// (BEH-EA-225).

import * as Effect from "effect/Effect";
import type { LoadedAuth } from "./Config.ts";
import * as Output from "./Output.ts";

export type Format = "text" | "json" | "dot";

export interface View<A> {
  readonly rows: (auth: LoadedAuth) => A;
  readonly text: (rows: A) => ReadonlyArray<string>;
  /** Present only on views that have a DOT form (the graph and the plain list). */
  readonly dot?: ((rows: A) => ReadonlyArray<string>) | undefined;
}

const resolve = (format: Format, globalJson: boolean, hasDot: boolean) =>
  hasDot && format === "dot" ? "dot" : format === "json" || globalJson ? "json" : "text";

export const render = <A>(view: View<A>, auth: LoadedAuth, format: Format) =>
  Effect.gen(function* () {
    const out = yield* Output.Output;
    const rows = view.rows(auth);
    const mode = resolve(format, out.json, view.dot !== undefined);
    const dot = view.dot;
    // DOT is printed with json forced off so the global flag cannot turn it into a document.
    if (mode === "dot" && dot !== undefined)
      return yield* Output.report(rows, dot, { json: false });
    yield* Output.report(rows, view.text, { json: mode === "json" });
  });
