// @awthaq/core — HookPoint
//
// spec/behaviors/12-hooks.md, BEH-EA-089 through BEH-EA-096; also
// spec/behaviors/03-ports-slots-hooks-registries.md, BEH-EA-022 through
// BEH-EA-024 (the same design restated from the tap author's point of
// view). awthaq is pre-implementation; this module makes the
// mechanism real — a point declared with `HookPoint.veto<Self>()(id,
// input)` (or `.observe`/`.divert`), `.tap(handler)` registering a tap, and
// `(yield* Point).run(input)` actually executing the registered chain —
// rather than merely typing it the way
// `archive/design/plugins-as-layers.md` §3.4 does.
//
// Exposed as three separate factories (`veto`/`observe`/`divert`), not the
// single `HookPoint.Service<Self>()(id, {kind, input})` curried-options
// form `spec/behaviors/12-hooks.md`'s own (explicitly non-normative —
// "specifies intended design... not code that has shipped") illustration
// uses. `VetoShape`/`ObserveShape`/`DivertShape` are three structurally
// different service shapes (only `DivertShape` carries a second type
// parameter, `Diverted`); a single factory dispatching on a runtime `kind`
// string would need its shared implementation to bridge an erased,
// kind-agnostic tap registry back to each kind's own precise `Input`/
// `Diverted` types at `run` time — exactly the gap this codebase closes
// everywhere else with a type assertion, which is the one tool not
// available here. Three independently, honestly generic functions need no
// such bridge: each keeps its own `Input`/`Diverted` concrete for the
// entire body (registry included), the same way `AuthPlugin.Service`
// itself stays generic in `Self`/`Shape` without ever erasing either.
//
// `input` (and `divert`'s `diverted`) are accepted as `Schema.Schema`
// values purely as type carriers, matching BEH-EA-089's own
// `{ input: SignUpInput }` — never decoded here. A hook point's input is
// always an already-typed value handed down from application/plugin code
// (the operation the point guards), never unknown external data crossing a
// boundary, so there is nothing for this module itself to decode.
//
// Scoped smaller than the full design in one respect: BEH-EA-091/096/111
// specify a hook point's resolved tap order as "dependency order, then
// declared `order`, then plugin id" — the same three-key rule
// `Auth.ts`'s `renumberMigrations` already applies to migrations. That rule
// needs each tap's *contributing plugin*'s resolved topological position
// (`Auth.ts`'s `linkPlugins`), which only exists once `Auth.make` runs, over
// already-built plugin values — nothing here lets a plugin's own `layer`
// initializer (where `.tap()` is called) see that position ahead of time.
// This module implements the piece that doesn't depend on it: declared
// `order` (a plain number, default 0), then registration sequence, frozen
// the first time a point runs (BEH-EA-024's "must freeze at first read").
// Threading dependency order through is a follow-up once a plugin's own
// identity is available at `.tap()`'s call site.
//
// Also scoped smaller in not yet wiring any concrete hook point into
// `Users.ts`/`Sessions.ts`'s real `signUp`/`signIn` flows (BEH-EA-090's
// `BeforeSignUp`, BEH-EA-092's `AfterSignIn`) — `AuthCore`, the fixed tuple
// those flows would run inside, does not exist yet (`Auth.ts`'s own header
// comment). What ships here is the mechanism every future hook point is
// built from, exercised directly in `test/HookPoint.test.ts` rather than
// through a real signUp/signIn call.

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** BEH-EA-089: a point's failure semantics are fixed once, at its own definition — never decided later by whichever plugin taps it. */
export type Kind = "veto" | "observe" | "divert";

/** BEH-EA-090: what a `"veto"` tap fails with to abort the operation the point guards. */
export class HookAbort extends Data.TaggedError("HookAbort")<{
  readonly code: string;
  readonly message?: string;
}> {}

/**
 * JH-001/PERS-001: BEH-EA-090's own MUST — a veto abort "surface[s] to the
 * caller as a typed error naming the abort's `code`," never as a bare
 * defect. `HookAbort` above is the in-process value a tap fails with (it
 * never itself crosses the wire); this is what a veto call site translates
 * it into right where the point is run, one shared type rather than a
 * class per operation — `code`/`message` are already point-agnostic by
 * design (the point's own owner doesn't know a tap author's business rule
 * in advance), so a client `catchTag("HookAborted", ...)`es once and
 * branches on `code`, regardless of which veto point fired. `point` names
 * that point's own id so a caller (or a log) can tell which one, when an
 * operation guards more than one.
 */
export class HookAborted extends Schema.TaggedError<HookAborted>()(
  "HookAborted",
  {
    point: Schema.String,
    code: Schema.String,
    message: Schema.optional(Schema.String),
  },
  { httpApiStatus: 403 },
) {}

/** Reachable only if a tap is installed (its Layer built) after the point it targets has already run once — a construction-order bug, not a normal-flow error (BEH-EA-024's "frozen at first read"). */
export class HookPointFrozen extends Data.TaggedError("HookPointFrozen")<{
  readonly point: string;
  readonly message: string;
}> {}

/** BEH-EA-091/096: a tap's declared tie-breaker against every other tap on the same point — see this module's own header comment for the ordering rule this is currently one third of. */
export interface TapOptions {
  readonly order?: number;
}

export type Key<Id extends string> = `awthaq/hook/${Id}`;

/** BEH-EA-090/091: a veto tap either amends the value for later taps and the operation, or aborts the operation outright. */
export type VetoTap<Input> = (input: Input) => Effect.Effect<Input, HookAbort>;

/** BEH-EA-092: an observe tap's own failure is caught and logged — it can never be seen by, or fail, the operation it observes. */
export type ObserveTap<Input> = (input: Input) => Effect.Effect<void, unknown>;

/** BEH-EA-093: a divert tap returns `Option.none()` to pass through, or `Option.some(diverted)` to redirect the operation to a typed alternative outcome. */
export type DivertTap<Input, Diverted> = (input: Input) => Effect.Effect<Option.Option<Diverted>>;

/** What `(yield* SomePoint).run(input)` returns for a `"divert"` point — the caller is required to handle both cases, never only the passthrough one (BEH-EA-093). */
export type DivertResult<Input, Diverted> =
  | { readonly _tag: "Continue"; readonly value: Input }
  | { readonly _tag: "Diverted"; readonly value: Diverted };

export interface VetoShape<Input> {
  readonly kind: "veto";
  readonly run: (input: Input) => Effect.Effect<Input, HookAbort>;
}

export interface ObserveShape<Input> {
  readonly kind: "observe";
  readonly run: (input: Input) => Effect.Effect<void>;
}

export interface DivertShape<Input, Diverted> {
  readonly kind: "divert";
  readonly run: (input: Input) => Effect.Effect<DivertResult<Input, Diverted>>;
}

export interface VetoClass<Self, Id extends string, Input> extends Context.ServiceClass<
  Self,
  Key<Id>,
  VetoShape<Input>
> {
  readonly kind: "veto";
  readonly tap: (handler: VetoTap<Input>, options?: TapOptions) => Layer.Layer<never>;
  readonly layer: Layer.Layer<Self>;
}

export interface ObserveClass<Self, Id extends string, Input> extends Context.ServiceClass<
  Self,
  Key<Id>,
  ObserveShape<Input>
> {
  readonly kind: "observe";
  readonly tap: (handler: ObserveTap<Input>, options?: TapOptions) => Layer.Layer<never>;
  readonly layer: Layer.Layer<Self>;
}

export interface DivertClass<Self, Id extends string, Input, Diverted> extends Context.ServiceClass<
  Self,
  Key<Id>,
  DivertShape<Input, Diverted>
> {
  readonly kind: "divert";
  readonly tap: (handler: DivertTap<Input, Diverted>, options?: TapOptions) => Layer.Layer<never>;
  readonly layer: Layer.Layer<Self>;
}

interface Registration<F> {
  readonly handler: F;
  readonly order: number;
  readonly sequence: number;
}

let nextSequence = 0;

/** BEH-EA-091/096: stable ordering by declared `order`, then registration sequence — see this module's own header comment for what full BEH-EA-111 ordering still needs. */
const sortEntries = <F>(entries: ReadonlyArray<Registration<F>>): ReadonlyArray<F> =>
  entries
    .toSorted((a, b) => a.order - b.order || a.sequence - b.sequence)
    .map((entry) => entry.handler);

/**
 * BEH-EA-089/090: a hook point whose taps may amend the input or abort the
 * operation with a typed `HookAbort`, run in order, one after another
 * (BEH-EA-091).
 */
export const veto =
  <Self>() =>
  <const Id extends string, Input>(
    id: Id,
    input: Schema.Schema<Input>,
  ): VetoClass<Self, Id, Input> => {
    void input; // type carrier only — see this module's own header comment
    const key: Key<Id> = `awthaq/hook/${id}`;
    const serviceKey = Context.Service<Self, VetoShape<Input>>()(key);
    const entries: Array<Registration<VetoTap<Input>>> = [];
    let frozen: ReadonlyArray<VetoTap<Input>> | undefined;
    const resolveTaps = (): ReadonlyArray<VetoTap<Input>> => {
      if (frozen === undefined) frozen = sortEntries(entries);
      return frozen;
    };
    const tap = (handler: VetoTap<Input>, options?: TapOptions): Layer.Layer<never> =>
      Layer.effectDiscard(
        Effect.suspend(() => {
          if (frozen !== undefined) {
            return Effect.die(
              new HookPointFrozen({
                point: key,
                message: `awthaq: hook point "${key}" already ran once — every tap must be installed before the first run, never after`,
              }),
            );
          }
          nextSequence += 1;
          entries.push({ handler, order: options?.order ?? 0, sequence: nextSequence });
          return Effect.void;
        }),
      );
    const run: VetoShape<Input>["run"] = (value) =>
      Effect.gen(function* () {
        let current = value;
        for (const handler of resolveTaps()) {
          current = yield* handler(current);
        }
        return current;
      });
    const layer: Layer.Layer<Self> = Layer.succeed(
      serviceKey,
      serviceKey.of({ kind: "veto", run }),
    );
    const statics: {
      readonly kind: "veto";
      readonly tap: typeof tap;
      readonly layer: typeof layer;
    } = { kind: "veto", tap, layer };
    return Object.assign(serviceKey, statics);
  };

/**
 * BEH-EA-089/092: a hook point whose taps observe the operation
 * afterward — a failing tap is caught and logged, never propagated to the
 * operation it observes or to another tap.
 */
export const observe =
  <Self>() =>
  <const Id extends string, Input>(
    id: Id,
    input: Schema.Schema<Input>,
  ): ObserveClass<Self, Id, Input> => {
    void input; // type carrier only — see this module's own header comment
    const key: Key<Id> = `awthaq/hook/${id}`;
    const serviceKey = Context.Service<Self, ObserveShape<Input>>()(key);
    const entries: Array<Registration<ObserveTap<Input>>> = [];
    let frozen: ReadonlyArray<ObserveTap<Input>> | undefined;
    const resolveTaps = (): ReadonlyArray<ObserveTap<Input>> => {
      if (frozen === undefined) frozen = sortEntries(entries);
      return frozen;
    };
    const tap = (handler: ObserveTap<Input>, options?: TapOptions): Layer.Layer<never> =>
      Layer.effectDiscard(
        Effect.suspend(() => {
          if (frozen !== undefined) {
            return Effect.die(
              new HookPointFrozen({
                point: key,
                message: `awthaq: hook point "${key}" already ran once — every tap must be installed before the first run, never after`,
              }),
            );
          }
          nextSequence += 1;
          entries.push({ handler, order: options?.order ?? 0, sequence: nextSequence });
          return Effect.void;
        }),
      );
    const run: ObserveShape<Input>["run"] = (value) =>
      Effect.forEach(
        resolveTaps(),
        (handler) =>
          handler(value).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("auth.hook.observer.error", { hook: key, cause }),
            ),
          ),
        { concurrency: "unbounded", discard: true },
      );
    const layer: Layer.Layer<Self> = Layer.succeed(
      serviceKey,
      serviceKey.of({ kind: "observe", run }),
    );
    const statics: {
      readonly kind: "observe";
      readonly tap: typeof tap;
      readonly layer: typeof layer;
    } = { kind: "observe", tap, layer };
    return Object.assign(serviceKey, statics);
  };

/**
 * BEH-EA-089/093: a hook point whose taps may redirect the operation to a
 * typed alternative outcome — the first tap to divert wins; if none do,
 * the operation continues with the original input.
 */
export const divert =
  <Self>() =>
  <const Id extends string, Input, Diverted>(
    id: Id,
    input: Schema.Schema<Input>,
    diverted: Schema.Schema<Diverted>,
  ): DivertClass<Self, Id, Input, Diverted> => {
    void input; // type carrier only — see this module's own header comment
    void diverted; // type carrier only — see this module's own header comment
    const key: Key<Id> = `awthaq/hook/${id}`;
    const serviceKey = Context.Service<Self, DivertShape<Input, Diverted>>()(key);
    const entries: Array<Registration<DivertTap<Input, Diverted>>> = [];
    let frozen: ReadonlyArray<DivertTap<Input, Diverted>> | undefined;
    const resolveTaps = (): ReadonlyArray<DivertTap<Input, Diverted>> => {
      if (frozen === undefined) frozen = sortEntries(entries);
      return frozen;
    };
    const tap = (handler: DivertTap<Input, Diverted>, options?: TapOptions): Layer.Layer<never> =>
      Layer.effectDiscard(
        Effect.suspend(() => {
          if (frozen !== undefined) {
            return Effect.die(
              new HookPointFrozen({
                point: key,
                message: `awthaq: hook point "${key}" already ran once — every tap must be installed before the first run, never after`,
              }),
            );
          }
          nextSequence += 1;
          entries.push({ handler, order: options?.order ?? 0, sequence: nextSequence });
          return Effect.void;
        }),
      );
    const continueWith = (value: Input): DivertResult<Input, Diverted> => ({
      _tag: "Continue",
      value,
    });
    const divertTo = (value: Diverted): DivertResult<Input, Diverted> => ({
      _tag: "Diverted",
      value,
    });
    const run: DivertShape<Input, Diverted>["run"] = (value) =>
      Effect.gen(function* () {
        for (const handler of resolveTaps()) {
          const outcome = yield* handler(value);
          if (Option.isSome(outcome)) return divertTo(outcome.value);
        }
        return continueWith(value);
      });
    const layer: Layer.Layer<Self> = Layer.succeed(
      serviceKey,
      serviceKey.of({ kind: "divert", run }),
    );
    const statics: {
      readonly kind: "divert";
      readonly tap: typeof tap;
      readonly layer: typeof layer;
    } = { kind: "divert", tap, layer };
    return Object.assign(serviceKey, statics);
  };
