// spec/behaviors/12-hooks.md, BEH-EA-089 through BEH-EA-096. See
// src/HookPoint.ts's own header comment for why this exercises three
// standalone factories (`veto`/`observe`/`divert`) rather than one
// `HookPoint.Service<Self>()(id, {kind, ...})` call.
//
// ELC-001: a point's registry lives in its built layer, so each case below
// composes `Tap.pipe(Layer.provideMerge(Point.layer))` — the tap requires its
// point — and two builds never share taps or a frozen state (proven by the
// "independently built compositions" case, which reuses one class).
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HookPoint from "../src/HookPoint.ts";
import * as Observability from "../src/Observability.ts";

class SignUpInput extends Schema.Class<SignUpInput>("SignUpInput")({ email: Schema.String }) {}

describe("HookPoint.veto (BEH-EA-090/091)", () => {
  it.effect("with no taps installed, run returns the input unchanged", () => {
    class BeforeSignUp extends HookPoint.veto<BeforeSignUp>()("auth.user.signUp", SignUpInput) {}
    return Effect.gen(function* () {
      const point = yield* BeforeSignUp;
      const out = yield* point.run(new SignUpInput({ email: "a@example.com" }));
      assert.strictEqual(out.email, "a@example.com");
    }).pipe(Effect.provide(BeforeSignUp.layer));
  });

  it.effect("a tap may amend the value; later taps and the caller see the amendment", () => {
    class BeforeSignUp extends HookPoint.veto<BeforeSignUp>()("auth.user.signUp", SignUpInput) {}
    const Lowercase = BeforeSignUp.tap((input) =>
      Effect.succeed(new SignUpInput({ email: input.email.toLowerCase() })),
    );
    return Effect.gen(function* () {
      const point = yield* BeforeSignUp;
      const out = yield* point.run(new SignUpInput({ email: "A@EXAMPLE.COM" }));
      assert.strictEqual(out.email, "a@example.com");
    }).pipe(Effect.provide(Lowercase.pipe(Layer.provideMerge(BeforeSignUp.layer))));
  });

  it.effect("a tap may abort with a typed HookAbort, naming its own code", () => {
    class BeforeSignUp extends HookPoint.veto<BeforeSignUp>()("auth.user.signUp", SignUpInput) {}
    const CompanyEmail = BeforeSignUp.tap((input) =>
      input.email.endsWith("@acme.com")
        ? Effect.fail(new HookPoint.HookAbort({ code: "EMAIL_DOMAIN_NOT_ALLOWED" }))
        : Effect.succeed(input),
    );
    return Effect.gen(function* () {
      const point = yield* BeforeSignUp;
      const failure = yield* point.run(new SignUpInput({ email: "x@acme.com" })).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "HookAbort");
      assert.strictEqual(failure.code, "EMAIL_DOMAIN_NOT_ALLOWED");
    }).pipe(Effect.provide(CompanyEmail.pipe(Layer.provideMerge(BeforeSignUp.layer))));
  });

  it.effect(
    "BEH-EA-091: a tap with a lower declared `order` runs before one with a higher order",
    () => {
      class BeforeSignUp extends HookPoint.veto<BeforeSignUp>()("auth.user.signUp", SignUpInput) {}
      const seen: Array<string> = [];
      const RunsSecond = BeforeSignUp.tap(
        (input) => Effect.sync(() => seen.push("runs-second")).pipe(Effect.as(input)),
        { order: 1 },
      );
      const RunsFirst = BeforeSignUp.tap(
        (input) => Effect.sync(() => seen.push("runs-first")).pipe(Effect.as(input)),
        { order: 0 },
      );
      return Effect.gen(function* () {
        const point = yield* BeforeSignUp;
        // Installed in the "wrong" order on purpose — `order` alone must
        // decide the outcome, not registration order.
        yield* point.run(new SignUpInput({ email: "a@example.com" }));
        assert.deepStrictEqual(seen, ["runs-first", "runs-second"]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(RunsSecond, RunsFirst).pipe(Layer.provideMerge(BeforeSignUp.layer)),
        ),
      );
    },
  );
});

describe("HookPoint.observe (BEH-EA-092)", () => {
  it.effect("a failing tap is caught and logged — it never fails the operation", () => {
    class AfterSignIn extends HookPoint.observe<AfterSignIn>()("auth.signIn", Schema.String) {}
    const Failing = AfterSignIn.tap(() => Effect.die(new Error("boom")));
    return Effect.gen(function* () {
      const point = yield* AfterSignIn;
      yield* point.run("user-1");
    }).pipe(Effect.provide(Failing.pipe(Layer.provideMerge(AfterSignIn.layer))));
  });

  it.effect("a healthy tap still observes, recording what it was given", () => {
    class AfterSignIn extends HookPoint.observe<AfterSignIn>()("auth.signIn", Schema.String) {}
    const seen = Effect.runSync(Ref.make<ReadonlyArray<string>>([]));
    const Recording = AfterSignIn.tap((userId) => Ref.update(seen, (s) => [...s, userId]));
    return Effect.gen(function* () {
      const point = yield* AfterSignIn;
      yield* point.run("user-2");
      assert.deepStrictEqual(yield* Ref.get(seen), ["user-2"]);
    }).pipe(Effect.provide(Recording.pipe(Layer.provideMerge(AfterSignIn.layer))));
  });
});

describe("HookPoint.divert (BEH-EA-093)", () => {
  it.effect("with no diverting tap, the operation continues with the original input", () => {
    class BeforeSessionIssue extends HookPoint.divert<BeforeSessionIssue>()(
      "auth.session.beforeIssue",
      Schema.String,
      Schema.String,
    ) {}
    return Effect.gen(function* () {
      const point = yield* BeforeSessionIssue;
      const result = yield* point.run("user-1");
      assert.deepStrictEqual(result, { _tag: "Continue", value: "user-1" });
    }).pipe(Effect.provide(BeforeSessionIssue.layer));
  });

  it.effect("a tap may redirect the operation to a typed alternative outcome", () => {
    class BeforeSessionIssue extends HookPoint.divert<BeforeSessionIssue>()(
      "auth.session.beforeIssue",
      Schema.String,
      Schema.String,
    ) {}
    const TwoFactor = BeforeSessionIssue.tap((userId) =>
      Effect.succeed(Option.some(`two-factor-required:${userId}`)),
    );
    return Effect.gen(function* () {
      const point = yield* BeforeSessionIssue;
      const result = yield* point.run("user-2");
      assert.deepStrictEqual(result, { _tag: "Diverted", value: "two-factor-required:user-2" });
    }).pipe(Effect.provide(TwoFactor.pipe(Layer.provideMerge(BeforeSessionIssue.layer))));
  });
});

describe("HookPoint — BEH-EA-024/094: a hook point's taps freeze once it has run", () => {
  it.effect(
    "a tap installed after the point has already run once is a defect, not a silent no-op",
    () => {
      class BeforeThing extends HookPoint.veto<BeforeThing>()("auth.thing", Schema.String) {}
      return Effect.gen(function* () {
        const point = yield* BeforeThing;
        yield* point.run("first-run-freezes-the-registry");
        const lateTap = BeforeThing.tap((value) => Effect.succeed(value));
        const exit = yield* Effect.exit(Layer.launch(lateTap));
        assert.isTrue(exit._tag === "Failure");
      }).pipe(Effect.provide(BeforeThing.layer));
    },
  );
});

describe("HookPoint — ELC-001: the registry is per composition", () => {
  class BeforeSignUp extends HookPoint.veto<BeforeSignUp>()("auth.user.signUp", SignUpInput) {}
  const append = (suffix: string) =>
    BeforeSignUp.tap((input) => Effect.succeed(new SignUpInput({ email: input.email + suffix })));
  const runOnce = Effect.gen(function* () {
    const point = yield* BeforeSignUp;
    return (yield* point.run(new SignUpInput({ email: "x" }))).email;
  });

  it.effect("two independently built compositions do not share taps or freeze state", () =>
    Effect.gen(function* () {
      const first = yield* runOnce.pipe(
        Effect.provide(append("-A").pipe(Layer.provideMerge(BeforeSignUp.layer))),
      );
      // Composition 1 has run — and thereby frozen — its point. Composition 2
      // is built from the very same class and must neither see tap A nor die
      // with `HookPointFrozen`.
      const second = yield* runOnce.pipe(
        Effect.provide(append("-B").pipe(Layer.provideMerge(BeforeSignUp.layer))),
      );
      assert.strictEqual(first, "x-A");
      assert.strictEqual(second, "x-B");
    }),
  );
});

describe("HookPoint — JH-003/PERS-003: dependency order, then declared order, then plugin id", () => {
  class BeforeSignUp extends HookPoint.veto<BeforeSignUp>()("auth.user.signUp", SignUpInput) {}
  const plugin = (id: string, dependsOn: ReadonlyArray<HookPoint.TapOwner> = []) => ({
    id,
    dependsOn,
  });
  const a = plugin("a");
  const b = plugin("b", [a]);

  /** Builds the taps `define` returns over one point, runs it once, and reports the order the taps ran in. */
  const runTaps = (
    define: (
      trace: (name: string) => (input: SignUpInput) => Effect.Effect<SignUpInput>,
    ) => Layer.Layer<never, never, BeforeSignUp>,
  ) => {
    const seen: Array<string> = [];
    const trace = (name: string) => (input: SignUpInput) =>
      Effect.sync(() => {
        seen.push(name);
        return input;
      });
    return Effect.gen(function* () {
      const point = yield* BeforeSignUp;
      yield* point.run(new SignUpInput({ email: "x" }));
      return seen;
    }).pipe(Effect.provide(define(trace).pipe(Layer.provideMerge(BeforeSignUp.layer))));
  };

  it.effect("equal-order taps run in dependency order regardless of registration order", () =>
    Effect.gen(function* () {
      // b depends on a; b's tap is registered first (and the app's last), with equal order.
      const seen = yield* runTaps((trace) =>
        Layer.mergeAll(
          BeforeSignUp.tap(trace("app")),
          BeforeSignUp.tap(trace("b"), { owner: b }),
          BeforeSignUp.tap(trace("a"), { owner: a }),
        ),
      );
      assert.deepStrictEqual(seen, ["a", "b", "app"]);
    }),
  );

  it.effect("declared order breaks a tie between independent plugins, then plugin id", () =>
    Effect.gen(function* () {
      const seen = yield* runTaps((trace) =>
        Layer.mergeAll(
          BeforeSignUp.tap(trace("z-low"), { owner: plugin("z"), order: 0 }),
          BeforeSignUp.tap(trace("m-high"), { owner: plugin("m"), order: 5 }),
          BeforeSignUp.tap(trace("y-low"), { owner: plugin("y"), order: 0 }),
        ),
      );
      assert.deepStrictEqual(seen, ["y-low", "z-low", "m-high"]);
    }),
  );

  it.effect("`resolved` reports the chain's order without invoking any tap", () =>
    Effect.gen(function* () {
      const build = Layer.mergeAll(
        BeforeSignUp.tap(() => Effect.die("must not run"), { owner: b, order: 2 }),
        BeforeSignUp.tap(() => Effect.die("must not run"), { owner: a, order: 9 }),
      ).pipe(Layer.provideMerge(BeforeSignUp.layer));
      const resolved = yield* Effect.gen(function* () {
        const point = yield* BeforeSignUp;
        return yield* point.resolved;
      }).pipe(Effect.provide(build));
      assert.deepStrictEqual(resolved, [
        { owner: "a", order: 9 },
        { owner: "b", order: 2 },
      ]);
    }),
  );

  it("compareTaps is a pure function of owners and orders", () => {
    const sorted = [
      { owner: undefined, order: -1 },
      { owner: b, order: 0 },
      { owner: a, order: 3 },
    ].toSorted(HookPoint.compareTaps);
    assert.deepStrictEqual(
      sorted.map((tap) => tap.owner?.id ?? "app"),
      ["a", "b", "app"],
    );
  });
});

describe("HookPoint.observe — JH-002: taps run sequentially in resolved order", () => {
  it.effect("a later tap starts only after an earlier, slower one completes", () => {
    class AfterSignIn extends HookPoint.observe<AfterSignIn>()("auth.signIn", Schema.String) {}
    const log: Array<string> = [];
    const Slow = AfterSignIn.tap(
      () =>
        Effect.sleep("1 second").pipe(
          Effect.andThen(
            Effect.sync(() => {
              log.push("a");
            }),
          ),
        ),
      { order: 1 },
    );
    const Fast = AfterSignIn.tap(
      () =>
        Effect.sync(() => {
          log.push("b");
        }),
      { order: 2 },
    );
    return Effect.gen(function* () {
      const point = yield* AfterSignIn;
      const fiber = yield* Effect.forkChild(point.run("u"));
      yield* TestClock.adjust("1 second");
      yield* Fiber.await(fiber);
      assert.deepStrictEqual(log, ["a", "b"]);
    }).pipe(
      Effect.provide(Layer.mergeAll(Slow, Fast).pipe(Layer.provideMerge(AfterSignIn.layer))),
    );
  });

  it.effect("a failing observer is counted in awthaq_hook_observer_error_total", () => {
    class AfterSignIn extends HookPoint.observe<AfterSignIn>()(
      "auth.signIn.metric",
      Schema.String,
    ) {}
    const Failing = AfterSignIn.tap(() => Effect.die(new Error("boom")));
    const counter = Metric.withAttributes(Observability.hookObserverErrors, {
      hook: "awthaq/hook/auth.signIn.metric",
    });
    return Effect.gen(function* () {
      const before = (yield* Metric.value(counter)).count;
      const point = yield* AfterSignIn;
      yield* point.run("u");
      yield* point.run("u");
      assert.strictEqual((yield* Metric.value(counter)).count - before, 2);
    }).pipe(Effect.provide(Failing.pipe(Layer.provideMerge(AfterSignIn.layer))));
  });
});

describe("HookPoint — JH-004: tap outputs are checked against the point's own schema", () => {
  // Refinements the static type cannot see: a tap can satisfy `{ n: number }` and still hand back `-1`.
  const Positive = Schema.Struct({ n: Schema.Number.check(Schema.isGreaterThan(0)) });

  it.effect("a veto tap returning a value that fails the point schema is a defect naming the point", () => {
    class BeforeCount extends HookPoint.veto<BeforeCount>()("auth.count", Positive) {}
    const Bad = BeforeCount.tap(() => Effect.succeed({ n: -1 }));
    return Effect.gen(function* () {
      const point = yield* BeforeCount;
      const exit = yield* Effect.exit(point.run({ n: 1 }));
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const defect = Cause.squash(exit.cause);
        assert.instanceOf(defect, HookPoint.HookTapOutputInvalid);
        if (defect instanceof HookPoint.HookTapOutputInvalid) {
          assert.strictEqual(defect.point, "awthaq/hook/auth.count");
          assert.strictEqual(defect.owner, "app");
        }
      }
    }).pipe(Effect.provide(Bad.pipe(Layer.provideMerge(BeforeCount.layer))));
  });

  it.effect("a divert tap's diverted value must match the outcome schema", () => {
    class BeforeIssue extends HookPoint.divert<BeforeIssue>()(
      "auth.issue",
      Schema.String,
      Schema.NonEmptyString,
    ) {}
    const Bad = BeforeIssue.tap(() => Effect.succeed(Option.some("")));
    return Effect.gen(function* () {
      const point = yield* BeforeIssue;
      const exit = yield* Effect.exit(point.run("u"));
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.instanceOf(Cause.squash(exit.cause), HookPoint.HookTapOutputInvalid);
      }
    }).pipe(Effect.provide(Bad.pipe(Layer.provideMerge(BeforeIssue.layer))));
  });
});
