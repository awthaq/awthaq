// @awthaq/core — HookPoint
//
// spec/behaviors/12-hooks.md, BEH-EA-089 through BEH-EA-096; also
// spec/behaviors/03-ports-slots-hooks-registries.md, BEH-EA-022 through
// BEH-EA-024 (the same design restated from the tap author's point of
// view). This module makes the mechanism real — a point declared with
// `HookPoint.veto<Self>()(id, input)` (or `.observe`/`.divert`), `.tap(handler)`
// registering a tap, and `(yield* Point).run(input)` actually executing the
// registered chain.
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
// entire body (registry included). The registry itself is one generic
// helper (`makeRegistry<F>`) instantiated at each kind's own tap type.
//
// ELC-001/GC-006 (.issues/medium): the registry is *per composition*, not
// per module. A point's `.layer` allocates the registrations when it is
// built, `tap()` returns a Layer that *requires* the point (`RIn = Self`)
// and registers through it, and freezing (BEH-EA-024's "must freeze at
// first read") is therefore per built layer: two compositions built from
// the same module never share taps or a frozen state, and a suite that
// rebuilds a composition repeatedly no longer dies with `HookPointFrozen`.
// The `RIn = Self` requirement is also what makes BEH-EA-094/INV-EA-005
// true at the type level: a tap Layer whose point nobody provides leaves
// that point in the composition's `RIn`, so `Layer.launch` refuses to
// compile (`test/HookPoint.types.test.ts`). One consequence: a tap must be
// built in the *same* layer graph as the point it taps (memoized by layer
// reference, as `Hooks.HooksLive` is) — `Effect.provide`-ing the point and
// its tap in two unrelated builds gives two unrelated registries.
//
// JH-003/PERS-003: a point's resolved tap order is the spec's three keys —
// dependency order, then declared `order`, then plugin id — a pure
// function of (the owners' `dependsOn` graph, declared orders, owner ids),
// independent of Layer build/registration order. `TapOptions.owner` names
// the contributing plugin (any value with an `id` and `dependsOn`, which
// every `AuthPlugin` class already is); a tap with no owner is an
// application tap and runs after every plugin's. `compareTaps` is the one
// comparator both the runtime chain and `Auth.make`'s `manifest.hooks` use,
// so the printed order and the executed order cannot drift. `resolved` on
// each point's service reports that order without invoking any tap.
//
// JH-004/GC-009: a point's `input` (and `divert`'s `diverted`) schemas are
// used, via `Schema.is` (a type guard — no decoding services, no
// assertions), to check every value a tap hands back before it reaches the
// guarded operation: since a veto tap's amended value flows straight into
// e.g. `users.create`, "already-typed, internal data" no longer holds for a
// value that originates in third-party tap code.

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Observability from "./Observability.ts";

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

/**
 * JH-004: a veto tap returned a value that fails the point's own input
 * schema (or a divert tap a diverted value that fails its outcome schema).
 * A defect, not a `HookAbort`: the tap author's code is wrong, not the
 * caller's request — and the invalid value never reaches the guarded
 * operation. `owner` names the offending tap's plugin (`"app"` for an
 * application tap).
 */
export class HookTapOutputInvalid extends Data.TaggedError("HookTapOutputInvalid")<{
  readonly point: string;
  readonly owner: string;
  readonly message: string;
}> {}

/**
 * NAM-002: BEH-EA-090's translation, once — a veto point's `run` fails with
 * the `HookAbort` a tap raised; every call site turns that into the typed,
 * wire-shaped `HookAborted` naming the point (`Point.id`) right where the
 * point is run.
 */
export const aborted =
  (point: { readonly id: string }) =>
  <A, R>(effect: Effect.Effect<A, HookAbort, R>): Effect.Effect<A, HookAborted, R> =>
    effect.pipe(
      Effect.catchTag(
        "HookAbort",
        (abort) => new HookAborted({ point: point.id, code: abort.code, message: abort.message }),
      ),
    );

/**
 * JH-003: the contributing plugin of a tap, as far as ordering needs to
 * know it. Structural on purpose: every `AuthPlugin` class already has this
 * shape (its `id` and `dependsOn` statics), and requiring only this keeps
 * `HookPoint` from importing `AuthPlugin` (whose `layer` initializers call
 * `.tap()` — see OAuth.ts's static-initializer note).
 */
export interface TapOwner {
  readonly id: string;
  readonly dependsOn: ReadonlyArray<TapOwner>;
}

/** The reserved owner id application taps (no `owner`) are reported under. */
export const APP_OWNER = "app";

/** BEH-EA-091/096: a tap's declared tie-breaker plus the plugin contributing it. */
export interface TapOptions {
  /**
   * Lower runs first, among taps of equal dependency level. Observe taps run
   * inline and sequentially in this order (JH-002): a slow tap adds latency to
   * the operation it observes, so fork heavy work or use an `AuthEvents`
   * subscriber instead.
   */
  readonly order?: number;
  readonly owner?: TapOwner;
}

/** One entry of a point's resolved chain, as `resolved` and `Auth.make`'s `manifest.hooks` report it. */
export interface ResolvedTap {
  readonly owner: string;
  readonly order: number;
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

interface Registration<F> {
  readonly handler: F;
  readonly order: number;
  readonly owner: TapOwner | undefined;
}

/**
 * The tap's contribution of one registration, addressed to the point that
 * owns the registry — `tap()`'s Layer calls it, nothing else should.
 */
export interface Registrar<F> {
  readonly register: (registration: Registration<F>) => Effect.Effect<void>;
}

export interface VetoShape<Input> extends Registrar<VetoTap<Input>> {
  readonly kind: "veto";
  readonly run: (input: Input) => Effect.Effect<Input, HookAbort>;
  /** PERS-003: the frozen chain's order, without invoking any tap. */
  readonly resolved: Effect.Effect<ReadonlyArray<ResolvedTap>>;
}

export interface ObserveShape<Input> extends Registrar<ObserveTap<Input>> {
  readonly kind: "observe";
  readonly run: (input: Input) => Effect.Effect<void>;
  readonly resolved: Effect.Effect<ReadonlyArray<ResolvedTap>>;
}

export interface DivertShape<Input, Diverted> extends Registrar<DivertTap<Input, Diverted>> {
  readonly kind: "divert";
  readonly run: (input: Input) => Effect.Effect<DivertResult<Input, Diverted>>;
  readonly resolved: Effect.Effect<ReadonlyArray<ResolvedTap>>;
}

/**
 * PERS-003: a tap declared statically on a plugin (`AuthPlugin.layer`'s
 * `taps` option) — what `Auth.make` reads to print the resolved per-point
 * order into `manifest.hooks` without building any layer. `Point` is the
 * hook point's service type, which joins the plugin layer's `RIn`.
 */
export interface TapDeclaration<Point> {
  readonly point: string;
  readonly order: number;
  readonly install: (owner: TapOwner) => Layer.Layer<never, never, Point>;
}

export interface VetoClass<Self, Id extends string, Input> extends Context.ServiceClass<
  Self,
  Key<Id>,
  VetoShape<Input>
> {
  readonly kind: "veto";
  /** The point's id as declared (`"auth.user.signUp"`), which `HookAborted.point` reports. */
  readonly id: Id;
  readonly tap: (handler: VetoTap<Input>, options?: TapOptions) => Layer.Layer<never, never, Self>;
  readonly declareTap: (
    handler: VetoTap<Input>,
    options?: { readonly order?: number },
  ) => TapDeclaration<Self>;
  readonly layer: Layer.Layer<Self>;
}

export interface ObserveClass<Self, Id extends string, Input> extends Context.ServiceClass<
  Self,
  Key<Id>,
  ObserveShape<Input>
> {
  readonly kind: "observe";
  readonly id: Id;
  readonly tap: (
    handler: ObserveTap<Input>,
    options?: TapOptions,
  ) => Layer.Layer<never, never, Self>;
  readonly declareTap: (
    handler: ObserveTap<Input>,
    options?: { readonly order?: number },
  ) => TapDeclaration<Self>;
  readonly layer: Layer.Layer<Self>;
}

export interface DivertClass<Self, Id extends string, Input, Diverted> extends Context.ServiceClass<
  Self,
  Key<Id>,
  DivertShape<Input, Diverted>
> {
  readonly kind: "divert";
  readonly id: Id;
  readonly tap: (
    handler: DivertTap<Input, Diverted>,
    options?: TapOptions,
  ) => Layer.Layer<never, never, Self>;
  readonly declareTap: (
    handler: DivertTap<Input, Diverted>,
    options?: { readonly order?: number },
  ) => TapDeclaration<Self>;
  readonly layer: Layer.Layer<Self>;
}

// ---- ordering ---------------------------------------------------------------

/** How many plugins sit below `owner` in the `dependsOn` graph — the "dependency order" key. A guard against a cycle (which `Auth.make` refuses anyway) keeps this total. */
const dependencyDepth = (owner: TapOwner, path: ReadonlySet<string> = new Set()): number => {
  if (path.has(owner.id)) return 0;
  const next = new Set(path).add(owner.id);
  let depth = 0;
  for (const dependency of owner.dependsOn) {
    depth = Math.max(depth, 1 + dependencyDepth(dependency, next));
  }
  return depth;
};

/** What `compareTaps` orders: one tap's owner and declared order. */
export interface TapSortKey {
  readonly owner: TapOwner | undefined;
  readonly order: number;
}

/**
 * JH-003, BEH-EA-091/096/111: dependency order (a plugin's taps run after
 * those of every plugin it depends on; application taps last), then declared
 * `order`, then plugin id. Exported so `Auth.make`'s manifest sorts with the
 * identical rule the runtime chain does.
 */
export const compareTaps = (a: TapSortKey, b: TapSortKey): number => {
  const level = (key: TapSortKey) =>
    key.owner === undefined ? Number.POSITIVE_INFINITY : dependencyDepth(key.owner);
  const idOf = (key: TapSortKey) => key.owner?.id ?? APP_OWNER;
  const byLevel = level(a) === level(b) ? 0 : level(a) < level(b) ? -1 : 1;
  if (byLevel !== 0) return byLevel;
  if (a.order !== b.order) return a.order - b.order;
  return idOf(a) === idOf(b) ? 0 : idOf(a) < idOf(b) ? -1 : 1;
};

/**
 * One point's registrations, allocated per built layer. Generic in the tap
 * type `F` so each kind keeps its own precise `Input`/`Diverted` (no erased
 * registry). Registrations sort stably (`toSorted`), so the final tiebreak
 * — two taps equal on all three keys — is registration sequence within this
 * one point.
 */
const makeRegistry = <F>(key: string) => {
  const entries: Array<Registration<F>> = [];
  let frozen: ReadonlyArray<Registration<F>> | undefined;
  const resolve = (): ReadonlyArray<Registration<F>> => {
    if (frozen === undefined) frozen = entries.toSorted(compareTaps);
    return frozen;
  };
  const register = (registration: Registration<F>): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (frozen !== undefined) {
        return Effect.die(
          new HookPointFrozen({
            point: key,
            message: `awthaq: hook point "${key}" already ran once in this composition — every tap must be installed before the first run, never after`,
          }),
        );
      }
      entries.push(registration);
      return Effect.void;
    });
  const resolved = Effect.sync(() =>
    resolve().map((entry) => ({ owner: entry.owner?.id ?? APP_OWNER, order: entry.order })),
  );
  return { register, resolve, resolved };
};

const ownerName = (registration: { readonly owner: TapOwner | undefined }): string =>
  registration.owner?.id ?? APP_OWNER;

const dispatchSpan = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.withSpan(Observability.Span.hookDispatch, {
      attributes: { [Observability.Field.hook]: key },
    }),
  );

/**
 * BEH-EA-089/090: a hook point whose taps may amend the input or abort the
 * operation with a typed `HookAbort`, run in order, one after another
 * (BEH-EA-091). Each amended value is checked against `input` (JH-004).
 */
export const veto =
  <Self>() =>
  <const Id extends string, Input>(
    id: Id,
    input: Schema.Schema<Input>,
  ): VetoClass<Self, Id, Input> => {
    const key: Key<Id> = `awthaq/hook/${id}`;
    const serviceKey = Context.Service<Self, VetoShape<Input>>()(key);
    const isInput = Schema.is(input);
    const tap = (handler: VetoTap<Input>, options?: TapOptions): Layer.Layer<never, never, Self> =>
      Layer.effectDiscard(
        Effect.flatMap(serviceKey, (point) =>
          point.register({ handler, order: options?.order ?? 0, owner: options?.owner }),
        ),
      );
    const declareTap = (
      handler: VetoTap<Input>,
      options?: { readonly order?: number },
    ): TapDeclaration<Self> => {
      const order = options?.order ?? 0;
      return { point: key, order, install: (owner) => tap(handler, { order, owner }) };
    };
    const layer = Layer.effect(
      serviceKey,
      Effect.sync(() => {
        const registry = makeRegistry<VetoTap<Input>>(key);
        const run: VetoShape<Input>["run"] = (value) =>
          dispatchSpan(
            key,
            Effect.gen(function* () {
              let current = value;
              for (const registration of registry.resolve()) {
                current = yield* registration.handler(current);
                if (!isInput(current)) {
                  return yield* Effect.die(
                    new HookTapOutputInvalid({
                      point: key,
                      owner: ownerName(registration),
                      message: `awthaq: a tap on hook point "${key}" (owner "${ownerName(registration)}") returned a value that does not match the point's input schema`,
                    }),
                  );
                }
              }
              return current;
            }),
          );
        return serviceKey.of({
          kind: "veto",
          run,
          register: registry.register,
          resolved: registry.resolved,
        });
      }),
    );
    const statics: {
      readonly kind: "veto";
      readonly id: Id;
      readonly tap: typeof tap;
      readonly declareTap: typeof declareTap;
      readonly layer: typeof layer;
    } = { kind: "veto", id, tap, declareTap, layer };
    return Object.assign(serviceKey, statics);
  };

/**
 * BEH-EA-089/092: a hook point whose taps observe the operation
 * afterward — a failing tap is caught and logged, never propagated to the
 * operation it observes or to another tap. Taps run one after another in
 * resolved order (JH-002), so declared order is real, not advisory.
 */
export const observe =
  <Self>() =>
  <const Id extends string, Input>(
    id: Id,
    _input: Schema.Schema<Input>, // types `run`'s input; an observe tap has no output to validate (JH-004)
  ): ObserveClass<Self, Id, Input> => {
    const key: Key<Id> = `awthaq/hook/${id}`;
    const serviceKey = Context.Service<Self, ObserveShape<Input>>()(key);
    const tap = (
      handler: ObserveTap<Input>,
      options?: TapOptions,
    ): Layer.Layer<never, never, Self> =>
      Layer.effectDiscard(
        Effect.flatMap(serviceKey, (point) =>
          point.register({ handler, order: options?.order ?? 0, owner: options?.owner }),
        ),
      );
    const declareTap = (
      handler: ObserveTap<Input>,
      options?: { readonly order?: number },
    ): TapDeclaration<Self> => {
      const order = options?.order ?? 0;
      return { point: key, order, install: (owner) => tap(handler, { order, owner }) };
    };
    const layer = Layer.effect(
      serviceKey,
      Effect.sync(() => {
        const registry = makeRegistry<ObserveTap<Input>>(key);
        const run: ObserveShape<Input>["run"] = (value) =>
          dispatchSpan(
            key,
            Effect.forEach(
              registry.resolve(),
              (registration) =>
                registration
                  .handler(value)
                  .pipe(
                    Effect.catchCause((cause: Cause.Cause<unknown>) =>
                      Observability.logObserverFailure(
                        "auth.hook.observer.error",
                        { hook: key, owner: ownerName(registration) },
                        cause,
                      ).pipe(
                        Effect.andThen(
                          Metric.update(
                            Metric.withAttributes(Observability.hookObserverErrors, { hook: key }),
                            1,
                          ),
                        ),
                      ),
                    ),
                  ),
              { discard: true },
            ),
          );
        return serviceKey.of({
          kind: "observe",
          run,
          register: registry.register,
          resolved: registry.resolved,
        });
      }),
    );
    const statics: {
      readonly kind: "observe";
      readonly id: Id;
      readonly tap: typeof tap;
      readonly declareTap: typeof declareTap;
      readonly layer: typeof layer;
    } = { kind: "observe", id, tap, declareTap, layer };
    return Object.assign(serviceKey, statics);
  };

/**
 * BEH-EA-089/093: a hook point whose taps may redirect the operation to a
 * typed alternative outcome — the first tap to divert wins; if none do,
 * the operation continues with the original input. A diverted value is
 * checked against `diverted` (JH-004).
 */
export const divert =
  <Self>() =>
  <const Id extends string, Input, Diverted>(
    id: Id,
    _input: Schema.Schema<Input>, // types `run`'s input; a divert tap returns only the outcome, which `diverted` checks (JH-004)
    diverted: Schema.Schema<Diverted>,
  ): DivertClass<Self, Id, Input, Diverted> => {
    const key: Key<Id> = `awthaq/hook/${id}`;
    const serviceKey = Context.Service<Self, DivertShape<Input, Diverted>>()(key);
    const isDiverted = Schema.is(diverted);
    const tap = (
      handler: DivertTap<Input, Diverted>,
      options?: TapOptions,
    ): Layer.Layer<never, never, Self> =>
      Layer.effectDiscard(
        Effect.flatMap(serviceKey, (point) =>
          point.register({ handler, order: options?.order ?? 0, owner: options?.owner }),
        ),
      );
    const declareTap = (
      handler: DivertTap<Input, Diverted>,
      options?: { readonly order?: number },
    ): TapDeclaration<Self> => {
      const order = options?.order ?? 0;
      return { point: key, order, install: (owner) => tap(handler, { order, owner }) };
    };
    const continueWith = (value: Input): DivertResult<Input, Diverted> => ({
      _tag: "Continue",
      value,
    });
    const divertTo = (value: Diverted): DivertResult<Input, Diverted> => ({
      _tag: "Diverted",
      value,
    });
    const layer = Layer.effect(
      serviceKey,
      Effect.sync(() => {
        const registry = makeRegistry<DivertTap<Input, Diverted>>(key);
        const run: DivertShape<Input, Diverted>["run"] = (value) =>
          dispatchSpan(
            key,
            Effect.gen(function* () {
              for (const registration of registry.resolve()) {
                const outcome = yield* registration.handler(value);
                if (Option.isSome(outcome)) {
                  if (!isDiverted(outcome.value)) {
                    return yield* Effect.die(
                      new HookTapOutputInvalid({
                        point: key,
                        owner: ownerName(registration),
                        message: `awthaq: a tap on hook point "${key}" (owner "${ownerName(registration)}") diverted to a value that does not match the point's outcome schema`,
                      }),
                    );
                  }
                  return divertTo(outcome.value);
                }
              }
              return continueWith(value);
            }),
          );
        return serviceKey.of({
          kind: "divert",
          run,
          register: registry.register,
          resolved: registry.resolved,
        });
      }),
    );
    const statics: {
      readonly kind: "divert";
      readonly id: Id;
      readonly tap: typeof tap;
      readonly declareTap: typeof declareTap;
      readonly layer: typeof layer;
    } = { kind: "divert", id, tap, declareTap, layer };
    return Object.assign(serviceKey, statics);
  };
