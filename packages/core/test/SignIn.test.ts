// ADR-EA-038, BEH-EA-322: `SignIn`, the one implementation of sign-in completion. These are the
// interface-level cases the per-plugin hook tests used to repeat once per plugin (veto, divert,
// gate, outage); each plugin now keeps only a wiring probe (its strategy, its `amr`, its refusal
// for a vanished user).
import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as AuthRequestContext from "../src/AuthRequestContext.ts";
import * as Errors from "../src/Errors.ts";
import * as Phone from "../src/Phone.ts";
import * as HookPoint from "../src/HookPoint.ts";
import * as Hooks from "../src/Hooks.ts";
import * as Sessions from "../src/Sessions.ts";
import * as SignIn from "../src/SignIn.ts";
import * as Tenant from "../src/Tenant.ts";
import * as Users from "../src/Users.ts";

interface Recorder {
  readonly beforeSignIn: Array<unknown>;
  readonly beforeIssue: Array<unknown>;
  readonly afterSignIn: Array<unknown>;
  readonly continued: Array<{
    readonly n: number;
    readonly sessionId: string;
    readonly userId: string;
    readonly strategy: string;
  }>;
}

const newRecorder = (): Recorder => ({
  beforeSignIn: [],
  beforeIssue: [],
  afterSignIn: [],
  continued: [],
});

interface Behaviour {
  readonly abort?: boolean;
  readonly divert?: boolean;
  readonly afterFails?: boolean;
  readonly sessionsOutage?: boolean;
  readonly usersOutage?: boolean;
}

const outage = new Errors.StoreUnavailable({ operation: "test" });

const SessionsOutage = Layer.effect(
  Sessions.Sessions,
  Effect.map(Sessions.Sessions, (inner) =>
    Sessions.Sessions.of({ ...inner, issue: () => Effect.fail(outage) }),
  ),
);

const UsersOutage = Layer.effect(
  Users.Users,
  Effect.map(Users.Users, (inner) =>
    Users.Users.of({ ...inner, findById: () => Effect.fail(outage) }),
  ),
);

const testContinuation = (recorder: Recorder) =>
  SignIn.continuation({
    id: "test",
    kind: "test.continuation",
    payload: Schema.Struct({ n: Schema.Number }),
    make: Effect.succeed((payload: { readonly n: number }, context: SignIn.ContinuationContext) =>
      Effect.sync(() => {
        recorder.continued.push({
          n: payload.n,
          sessionId: context.sessionId,
          userId: context.userId,
          strategy: context.strategy,
        });
      }),
    ),
  });

const envFor = (recorder: Recorder, behaviour: Behaviour = {}) => {
  const base = Layer.mergeAll(Users.layerMemory, Sessions.layerMemory).pipe(
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layerMemory),
    Layer.provideMerge(NodeCrypto.layer),
  );
  const taps = Layer.mergeAll(
    Hooks.BeforeSignIn.tap((input) =>
      Effect.suspend(() => {
        recorder.beforeSignIn.push(input);
        return behaviour.abort === true
          ? Effect.fail(new HookPoint.HookAbort({ code: "DENIED" }))
          : Effect.succeed(input);
      }),
    ),
    Hooks.BeforeSessionIssue.tap((input) =>
      Effect.sync(() => {
        recorder.beforeIssue.push(input);
        return behaviour.divert === true
          ? Option.some(new Hooks.TwoFactorRequired({ userId: input.userId, challengeId: "chal" }))
          : Option.none();
      }),
    ),
    Hooks.AfterSignIn.tap((input) =>
      Effect.suspend(() => {
        recorder.afterSignIn.push(input);
        return behaviour.afterFails === true ? Effect.fail("observer exploded") : Effect.void;
      }),
    ),
    testContinuation(recorder).layer,
  ).pipe(Layer.provideMerge(Hooks.HooksLive));
  const withOutage = Layer.mergeAll(
    behaviour.sessionsOutage === true ? SessionsOutage : Layer.empty,
    behaviour.usersOutage === true ? UsersOutage : Layer.empty,
  ).pipe(Layer.provideMerge(base));
  return Layer.provideMerge(taps, withOutage);
};

const makeUser = (email = "ada@example.com") =>
  Effect.gen(function* () {
    const users = yield* Users.Users;
    return yield* users.create({ identity: { _tag: "Email", email }, name: "Ada" });
  });

const eventsOf = (tag: "auth.user.signInFailed" | "auth.user.signedIn" | "auth.session.issued") =>
  Effect.gen(function* () {
    const auditLog = yield* AuditLog.AuditLog;
    return yield* auditLog.list({ eventTag: tag });
  });

describe("SignIn.clear", () => {
  it.effect(
    "an active user clears: the clearance carries user, strategy and amr, and no session exists yet",
    () => {
      const recorder = newRecorder();
      return Effect.gen(function* () {
        const signIn = yield* SignIn.make;
        const user = yield* makeUser();
        const cleared = yield* signIn.clear({
          userId: user.id,
          strategy: "password",
          amr: ["pwd"],
        });
        assert.strictEqual(cleared.user.id, user.id);
        assert.strictEqual(cleared.strategy, "password");
        assert.deepStrictEqual(cleared.amr, ["pwd"]);
        const sessions = yield* Sessions.Sessions;
        assert.strictEqual((yield* sessions.list(user.id)).length, 0);
      }).pipe(Effect.provide(envFor(recorder)));
    },
  );

  it.effect(
    "a suspended user is refused, announced as signInFailed{suspended} with the request address, and no tap runs",
    () => {
      const recorder = newRecorder();
      return Effect.gen(function* () {
        const signIn = yield* SignIn.make;
        const users = yield* Users.Users;
        const user = yield* makeUser();
        yield* users.setStatus(user.id, "suspended");
        const error = yield* signIn
          .clear({ userId: user.id, strategy: "passkey", amr: ["hwk"] })
          .pipe(
            Effect.provideService(AuthRequestContext.AuthRequestContext, {
              ...AuthRequestContext.none,
              ip: Option.some("203.0.113.9"),
            }),
            Effect.flip,
          );
        assert.strictEqual(error._tag, "UserSuspended");
        const failures = yield* eventsOf("auth.user.signInFailed");
        assert.strictEqual(failures.length, 1);
        const payload = failures[0]?.payload;
        assert.strictEqual(payload?._tag, "auth.user.signInFailed");
        if (payload?._tag === "auth.user.signInFailed") {
          assert.strictEqual(payload.strategy, "passkey");
          assert.strictEqual(payload.reason, "suspended");
          assert.strictEqual(payload.clientIp, "203.0.113.9");
        }
        assert.strictEqual(recorder.beforeSignIn.length, 0);
        assert.strictEqual(recorder.beforeIssue.length, 0);
        const sessions = yield* Sessions.Sessions;
        assert.strictEqual((yield* sessions.list(user.id)).length, 0);
      }).pipe(Effect.provide(envFor(recorder)));
    },
  );

  it.effect("a suspension that has lapsed no longer blocks", () => {
    const recorder = newRecorder();
    return Effect.gen(function* () {
      const signIn = yield* SignIn.make;
      const users = yield* Users.Users;
      const user = yield* makeUser();
      const until = DateTime.addDuration(yield* DateTime.now, Duration.minutes(5));
      yield* users.setStatus(user.id, "suspended", { until });
      const blocked = yield* Effect.flip(
        signIn.clear({ userId: user.id, strategy: "password", amr: ["pwd"] }),
      );
      assert.strictEqual(blocked._tag, "UserSuspended");
      yield* TestClock.adjust(Duration.minutes(6));
      const cleared = yield* signIn.clear({ userId: user.id, strategy: "password", amr: ["pwd"] });
      assert.strictEqual(cleared.user.id, user.id);
    }).pipe(Effect.provide(envFor(recorder)));
  });

  it.effect("an unknown id is UserGone: no event, no tap", () => {
    const recorder = newRecorder();
    return Effect.gen(function* () {
      const signIn = yield* SignIn.make;
      const error = yield* Effect.flip(
        signIn.clear({ userId: Users.UserId("nobody"), strategy: "password", amr: ["pwd"] }),
      );
      assert.strictEqual(error._tag, "SignIn/UserGone");
      assert.strictEqual((yield* eventsOf("auth.user.signInFailed")).length, 0);
      assert.strictEqual(recorder.beforeSignIn.length, 0);
    }).pipe(Effect.provide(envFor(recorder)));
  });

  it.effect(
    "a BeforeSignIn abort is HookAborted, the divert is not consulted and no session exists",
    () => {
      const recorder = newRecorder();
      return Effect.gen(function* () {
        const signIn = yield* SignIn.make;
        const user = yield* makeUser();
        const error = yield* Effect.flip(
          signIn.complete({ userId: user.id, strategy: "password", amr: ["pwd"] }),
        );
        assert.strictEqual(error._tag, "HookAborted");
        if (error._tag === "HookAborted") {
          assert.strictEqual(error.point, "auth.user.signIn");
          assert.strictEqual(error.code, "DENIED");
        }
        assert.strictEqual(recorder.beforeIssue.length, 0);
        assert.strictEqual((yield* eventsOf("auth.user.signedIn")).length, 0);
      }).pipe(Effect.provide(envFor(recorder, { abort: true })));
    },
  );

  it.effect(
    "BeforeSignIn sees { userId, email, strategy } for an email user and no email key for a phone user",
    () => {
      const recorder = newRecorder();
      return Effect.gen(function* () {
        const signIn = yield* SignIn.make;
        const users = yield* Users.Users;
        const emailUser = yield* makeUser();
        yield* signIn.clear({ userId: emailUser.id, strategy: "magicLink", amr: ["email"] });
        const phoneUser = yield* users.create({
          identity: {
            _tag: "Phone",
            phone: Option.getOrThrow(Phone.normalizePhone("+15555550123")),
          },
          name: "Phoney",
        });
        yield* signIn.clear({ userId: phoneUser.id, strategy: "sms", amr: ["sms"] });
        assert.deepStrictEqual(recorder.beforeSignIn, [
          { userId: emailUser.id, email: "ada@example.com", strategy: "magicLink" },
          { userId: phoneUser.id, strategy: "sms" },
        ]);
      }).pipe(Effect.provide(envFor(recorder)));
    },
  );

  it.effect(
    "BeforeSessionIssue sees exactly { userId, strategy, amr, handoff }: the attempt's amr, the ambient tenant and the continuation",
    () => {
      const recorder = newRecorder();
      return Effect.gen(function* () {
        const signIn = yield* SignIn.make;
        const user = yield* makeUser();
        const continuation = yield* testContinuation(recorder).of({ n: 7 });
        yield* signIn
          .clear({ userId: user.id, strategy: "saml:org:conn", amr: ["fed"], continuation })
          .pipe(Tenant.withTenant("t1"));
        assert.deepStrictEqual(recorder.beforeIssue, [
          {
            userId: user.id,
            strategy: "saml:org:conn",
            amr: ["fed"],
            handoff: {
              tenantId: "t1",
              continuation: { kind: "test.continuation", payload: { n: 7 } },
            },
          },
        ]);
      }).pipe(Effect.provide(envFor(recorder)));
    },
  );

  it.effect("a divert surfaces TwoFactorRequired: no session, no signedIn", () => {
    const recorder = newRecorder();
    return Effect.gen(function* () {
      const signIn = yield* SignIn.make;
      const user = yield* makeUser();
      const error = yield* Effect.flip(
        signIn.complete({ userId: user.id, strategy: "password", amr: ["pwd"] }),
      );
      assert.strictEqual(error._tag, "TwoFactorRequired");
      const sessions = yield* Sessions.Sessions;
      assert.strictEqual((yield* sessions.list(user.id)).length, 0);
      assert.strictEqual((yield* eventsOf("auth.user.signedIn")).length, 0);
      assert.strictEqual(recorder.afterSignIn.length, 0);
    }).pipe(Effect.provide(envFor(recorder, { divert: true })));
  });

  it.effect("a Users outage surfaces as the typed StoreUnavailable", () => {
    const recorder = newRecorder();
    return Effect.gen(function* () {
      const signIn = yield* SignIn.make;
      const error = yield* Effect.flip(
        signIn.clear({ userId: Users.UserId("u"), strategy: "password", amr: ["pwd"] }),
      );
      assert.strictEqual(error._tag, "StoreUnavailable");
    }).pipe(Effect.provide(envFor(recorder, { usersOutage: true })));
  });
});

describe("SignIn.issue", () => {
  it.effect(
    "records the clearance's amr; the log order is session.issued, signedIn, then AfterSignIn runs",
    () => {
      const recorder = newRecorder();
      return Effect.gen(function* () {
        const signIn = yield* SignIn.make;
        const user = yield* makeUser();
        const cleared = yield* signIn.clear({
          userId: user.id,
          strategy: "password",
          amr: ["pwd"],
        });
        const issued = yield* signIn.issue(cleared);
        assert.deepStrictEqual(issued.session.amr, ["pwd"]);
        const auditLog = yield* AuditLog.AuditLog;
        const rows = yield* auditLog.list();
        const tags = rows.map((row) => row.payload._tag).reverse();
        const at = (tag: string) => tags.findIndex((candidate) => candidate === tag);
        assert.isTrue(at("auth.session.issued") >= 0);
        assert.isTrue(at("auth.session.issued") < at("auth.user.signedIn"));
        const signedIn = (yield* eventsOf("auth.user.signedIn"))[0]?.payload;
        assert.deepStrictEqual(
          signedIn?._tag === "auth.user.signedIn"
            ? { userId: signedIn.userId, strategy: signedIn.strategy }
            : undefined,
          { userId: user.id, strategy: "password" },
        );
        assert.deepStrictEqual(recorder.afterSignIn, [{ userId: user.id, strategy: "password" }]);
      }).pipe(Effect.provide(envFor(recorder)));
    },
  );

  it.effect(
    "request facts come from AuthRequestContext, an explicit field overrides per field, neither gives an empty record",
    () => {
      const recorder = newRecorder();
      return Effect.gen(function* () {
        const signIn = yield* SignIn.make;
        const user = yield* makeUser();
        const cleared = yield* signIn.clear({
          userId: user.id,
          strategy: "password",
          amr: ["pwd"],
        });
        const bare = yield* signIn.issue(cleared);
        assert.isTrue(Option.isNone(bare.session.ipAddress));
        assert.isTrue(Option.isNone(bare.session.userAgent));
        const ambient = yield* signIn.issue(cleared).pipe(
          Effect.provideService(AuthRequestContext.AuthRequestContext, {
            ...AuthRequestContext.none,
            ip: Option.some("198.51.100.1"),
            userAgent: Option.some("ctx-agent"),
          }),
        );
        assert.deepStrictEqual(Option.getOrUndefined(ambient.session.ipAddress), "198.51.100.1");
        assert.deepStrictEqual(Option.getOrUndefined(ambient.session.userAgent), "ctx-agent");
        const mixed = yield* signIn.issue(cleared, { userAgent: "explicit-agent" }).pipe(
          Effect.provideService(AuthRequestContext.AuthRequestContext, {
            ...AuthRequestContext.none,
            ip: Option.some("198.51.100.1"),
            userAgent: Option.some("ctx-agent"),
          }),
        );
        assert.deepStrictEqual(Option.getOrUndefined(mixed.session.ipAddress), "198.51.100.1");
        assert.deepStrictEqual(Option.getOrUndefined(mixed.session.userAgent), "explicit-agent");
      }).pipe(Effect.provide(envFor(recorder)));
    },
  );

  it.effect("a clearance made under a tenant is issued in that tenant even outside it", () => {
    const recorder = newRecorder();
    return Effect.gen(function* () {
      const signIn = yield* SignIn.make;
      const user = yield* makeUser();
      const cleared = yield* signIn
        .clear({ userId: user.id, strategy: "saml:o:c", amr: ["fed"] })
        .pipe(Tenant.withTenant("t1"));
      const issued = yield* signIn.issue(cleared);
      assert.deepStrictEqual(Option.getOrUndefined(issued.session.tenantId), "t1");
    }).pipe(Effect.provide(envFor(recorder)));
  });

  it.effect("an AfterSignIn failure does not fail the sign-in (BEH-EA-092)", () => {
    const recorder = newRecorder();
    return Effect.gen(function* () {
      const signIn = yield* SignIn.make;
      const user = yield* makeUser();
      const issued = yield* signIn.complete({
        userId: user.id,
        strategy: "password",
        amr: ["pwd"],
      });
      assert.strictEqual(issued.session.userId, user.id);
      assert.strictEqual(recorder.afterSignIn.length, 1);
    }).pipe(Effect.provide(envFor(recorder, { afterFails: true })));
  });

  it.effect("a Sessions outage is the typed StoreUnavailable and nothing is announced", () => {
    const recorder = newRecorder();
    return Effect.gen(function* () {
      const signIn = yield* SignIn.make;
      const user = yield* makeUser();
      const error = yield* Effect.flip(
        signIn.complete({ userId: user.id, strategy: "password", amr: ["pwd"] }),
      );
      assert.strictEqual(error._tag, "StoreUnavailable");
      assert.strictEqual((yield* eventsOf("auth.user.signedIn")).length, 0);
      assert.strictEqual(recorder.afterSignIn.length, 0);
    }).pipe(Effect.provide(envFor(recorder, { sessionsOutage: true })));
  });
});

describe("SignIn.resume", () => {
  it.effect(
    "skips BeforeSignIn and BeforeSessionIssue, re-checks suspension (and announces it), restores tenant and continuation",
    () => {
      const recorder = newRecorder();
      return Effect.gen(function* () {
        const signIn = yield* SignIn.make;
        const users = yield* Users.Users;
        const user = yield* makeUser();
        const continuation = yield* testContinuation(recorder).of({ n: 3 });
        const cleared = yield* signIn.resume({
          userId: user.id,
          strategy: "saml:o:c",
          amr: ["fed", "otp", "mfa"],
          handoff: { tenantId: "t9", continuation },
        });
        assert.strictEqual(recorder.beforeSignIn.length, 0);
        assert.strictEqual(recorder.beforeIssue.length, 0);
        const issued = yield* signIn.issue(cleared);
        assert.deepStrictEqual(issued.session.amr, ["fed", "otp", "mfa"]);
        assert.deepStrictEqual(Option.getOrUndefined(issued.session.tenantId), "t9");
        assert.deepStrictEqual(recorder.continued, [
          { n: 3, sessionId: issued.session.id, userId: user.id, strategy: "saml:o:c" },
        ]);

        yield* users.setStatus(user.id, "suspended");
        const refused = yield* Effect.flip(
          signIn.resume({ userId: user.id, strategy: "saml:o:c", amr: ["fed"] }),
        );
        assert.strictEqual(refused._tag, "UserSuspended");
        assert.strictEqual((yield* eventsOf("auth.user.signInFailed")).length, 1);

        const gone = yield* Effect.flip(
          signIn.resume({ userId: Users.UserId("nobody"), strategy: "x", amr: [] }),
        );
        assert.strictEqual(gone._tag, "SignIn/UserGone");
      }).pipe(Effect.provide(envFor(recorder)));
    },
  );
});

describe("sign-in continuations", () => {
  it.effect(
    "a registered continuation runs after the mint and before signedIn, with the decoded payload and the session",
    () => {
      const recorder = newRecorder();
      return Effect.gen(function* () {
        const signIn = yield* SignIn.make;
        const user = yield* makeUser();
        const continuation = yield* testContinuation(recorder).of({ n: 1 });
        const issued = yield* signIn.complete({
          userId: user.id,
          strategy: "saml:o:c",
          amr: ["fed"],
          continuation,
        });
        assert.deepStrictEqual(recorder.continued, [
          { n: 1, sessionId: issued.session.id, userId: user.id, strategy: "saml:o:c" },
        ]);
      }).pipe(Effect.provide(envFor(recorder)));
    },
  );

  it.effect(
    "the continuation runs in the clearance's tenant, wherever the session is issued",
    () => {
      const recorder = newRecorder();
      const tenants: Array<Option.Option<string>> = [];
      const watching = SignIn.continuation({
        id: "watching",
        kind: "test.watching",
        payload: Schema.Struct({}),
        make: Effect.succeed(() =>
          Effect.gen(function* () {
            tenants.push(yield* Tenant.TenantContext);
          }),
        ),
      });
      return Effect.gen(function* () {
        const signIn = yield* SignIn.make;
        const user = yield* makeUser();
        const continuation = yield* watching.of({});
        const cleared = yield* signIn
          .clear({ userId: user.id, strategy: "saml:o:c", amr: ["fed"], continuation })
          .pipe(Tenant.withTenant("t1"));
        yield* signIn.issue(cleared);
        assert.deepStrictEqual(tenants, [Option.some("t1")]);
      }).pipe(Effect.provide(watching.layer.pipe(Layer.provideMerge(envFor(recorder)))));
    },
  );

  it.effect("an unregistered kind is a defect, never a silent skip", () => {
    const recorder = newRecorder();
    return Effect.gen(function* () {
      const signIn = yield* SignIn.make;
      const user = yield* makeUser();
      const exit = yield* Effect.exit(
        signIn.complete({
          userId: user.id,
          strategy: "x",
          amr: ["fed"],
          continuation: { kind: "nobody.registered", payload: {} },
        }),
      );
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) assert.isTrue(Cause.hasDies(exit.cause));
    }).pipe(Effect.provide(envFor(recorder)));
  });

  it.effect("registering after the registry was first read is a defect (frozen)", () => {
    const recorder = newRecorder();
    return Effect.gen(function* () {
      const signIn = yield* SignIn.make;
      const user = yield* makeUser();
      const continuation = yield* testContinuation(recorder).of({ n: 1 });
      yield* signIn.complete({ userId: user.id, strategy: "x", amr: ["fed"], continuation });
      const late = yield* Effect.exit(
        Layer.build(
          SignIn.continuation({
            id: "late",
            kind: "late",
            payload: Schema.Struct({}),
            make: Effect.succeed(() => Effect.void),
          }).layer,
        ).pipe(Effect.scoped),
      );
      assert.isTrue(Exit.isFailure(late));
    }).pipe(Effect.provide(envFor(recorder)));
  });
});
