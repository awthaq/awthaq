// spec/behaviors/12-hooks.md, BEH-EA-089 through BEH-EA-096. See
// src/HookPoint.ts's own header comment for why this exercises three
// standalone factories (`veto`/`observe`/`divert`) rather than one
// `HookPoint.Service<Self>()(id, {kind, ...})` call.
//
// Each test defines its own hook point class rather than sharing one across
// several `it.effect` cases: BEH-EA-024's "frozen at first read" is
// per-instance state (an application defines a hook point once, for its own
// lifetime) — a class shared across test cases with different tap
// configurations would have its registry frozen by whichever test happens
// to call `run` first, exactly the pollution a real application never sees
// because it never redefines the same point twice.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HookPoint from "../src/HookPoint.ts";

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
    }).pipe(Effect.provide(BeforeSignUp.layer.pipe(Layer.provideMerge(Lowercase))));
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
    }).pipe(Effect.provide(BeforeSignUp.layer.pipe(Layer.provideMerge(CompanyEmail))));
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
          BeforeSignUp.layer.pipe(Layer.provideMerge(Layer.mergeAll(RunsSecond, RunsFirst))),
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
    }).pipe(Effect.provide(AfterSignIn.layer.pipe(Layer.provideMerge(Failing))));
  });

  it.effect("a healthy tap still observes, recording what it was given", () => {
    class AfterSignIn extends HookPoint.observe<AfterSignIn>()("auth.signIn", Schema.String) {}
    const seen = Effect.runSync(Ref.make<ReadonlyArray<string>>([]));
    const Recording = AfterSignIn.tap((userId) => Ref.update(seen, (s) => [...s, userId]));
    return Effect.gen(function* () {
      const point = yield* AfterSignIn;
      yield* point.run("user-2");
      assert.deepStrictEqual(yield* Ref.get(seen), ["user-2"]);
    }).pipe(Effect.provide(AfterSignIn.layer.pipe(Layer.provideMerge(Recording))));
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
    }).pipe(Effect.provide(BeforeSessionIssue.layer.pipe(Layer.provideMerge(TwoFactor))));
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
