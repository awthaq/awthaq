// ADR-EA-038, BEH-EA-323: `SignUp`, the one implementation of user creation for a sign-up. The
// per-plugin sign-up hook tests (veto, amendment, announcement, conflicts) are these cases; each
// plugin keeps one wiring probe. Memory here; `SignUpSql.test.ts` runs the rollback cases over a
// real transaction (and Postgres under `pnpm test:pg`).
import { SqlTransaction } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SqlError, UnknownError } from "effect/unstable/sql/SqlError";
import * as Accounts from "../src/Accounts.ts";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as Errors from "../src/Errors.ts";
import * as HookPoint from "../src/HookPoint.ts";
import * as Hooks from "../src/Hooks.ts";
import * as Phone from "../src/Phone.ts";
import * as Sessions from "../src/Sessions.ts";
import * as SignUp from "../src/SignUp.ts";
import * as Users from "../src/Users.ts";

interface Recorder {
  readonly beforeSignUp: Array<unknown>;
  readonly afterSignUp: Array<unknown>;
  readonly beforeUserDelete: Array<unknown>;
  readonly order: Array<string>;
}

const newRecorder = (): Recorder => ({
  beforeSignUp: [],
  afterSignUp: [],
  beforeUserDelete: [],
  order: [],
});

interface Behaviour {
  readonly abort?: boolean;
  /** Replaces `name`/`email` for later taps and the operation. */
  readonly amend?: {
    readonly name?: string;
    readonly dropEmail?: boolean;
    readonly email?: string;
  };
  readonly afterFails?: boolean;
  readonly divert?: boolean;
  readonly signInAbort?: boolean;
  readonly sessionsOutage?: boolean;
  readonly noTransaction?: boolean;
}

const outage = new Errors.StoreUnavailable({ operation: "test" });

const SessionsOutage = Layer.effect(
  Sessions.Sessions,
  Effect.map(Sessions.Sessions, (inner) =>
    Sessions.Sessions.of({ ...inner, issue: () => Effect.fail(outage) }),
  ),
);

const envFor = (recorder: Recorder, behaviour: Behaviour = {}) => {
  const base = Layer.mergeAll(Users.layerMemory, Accounts.layerMemory, Sessions.layerMemory).pipe(
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layerMemory),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(SqlTransaction.layerNoop),
  );
  const taps = Layer.mergeAll(
    Hooks.BeforeSignUp.tap((input) =>
      Effect.suspend(() => {
        recorder.beforeSignUp.push(input);
        if (behaviour.abort === true)
          return Effect.fail(new HookPoint.HookAbort({ code: "NO_SIGNUPS" }));
        const amend = behaviour.amend;
        if (amend === undefined) return Effect.succeed(input);
        const { email: _dropped, ...rest } = input;
        return Effect.succeed({
          ...rest,
          ...(amend.dropEmail === true
            ? {}
            : amend.email !== undefined
              ? { email: amend.email }
              : input.email === undefined
                ? {}
                : { email: input.email }),
          name: amend.name ?? input.name,
        });
      }),
    ),
    Hooks.AfterSignUp.tap((input) =>
      Effect.suspend(() => {
        recorder.afterSignUp.push(input);
        recorder.order.push("AfterSignUp");
        return behaviour.afterFails === true ? Effect.fail("observer exploded") : Effect.void;
      }),
    ),
    Hooks.BeforeUserDelete.tap((input) =>
      Effect.suspend(() => {
        recorder.beforeUserDelete.push(input);
        return Effect.fail(new HookPoint.HookAbort({ code: "LEGAL_HOLD" }));
      }),
    ),
    Hooks.BeforeSignIn.tap((input) =>
      behaviour.signInAbort === true
        ? Effect.fail(new HookPoint.HookAbort({ code: "SIGNIN_DENIED" }))
        : Effect.succeed(input),
    ),
    Hooks.BeforeSessionIssue.tap((input) =>
      Effect.succeed(
        behaviour.divert === true
          ? Option.some(new Hooks.TwoFactorRequired({ userId: input.userId, challengeId: "chal" }))
          : Option.none(),
      ),
    ),
  ).pipe(Layer.provideMerge(Hooks.HooksLive));
  const withOutage =
    behaviour.sessionsOutage === true ? SessionsOutage.pipe(Layer.provideMerge(base)) : base;
  return Layer.provideMerge(taps, withOutage);
};

const eventTags = Effect.map(
  Effect.flatMap(AuditLog.AuditLog, (log) => log.list({})),
  (rows) => rows.map((row) => row.eventTag).toReversed(),
);

const application = (email = "ada@example.com", strategy = "password"): SignUp.Application => ({
  identity: { _tag: "Email", email },
  name: "Ada",
  strategy,
});

describe("SignUp.vet", () => {
  it.effect("an abort is HookAborted at auth.user.signUp and nothing is created", () => {
    const recorder = newRecorder();
    return Effect.gen(function* () {
      const signUp = yield* SignUp.make;
      const users = yield* Users.Users;
      const error = yield* Effect.flip(signUp.vet(application()));
      assert.strictEqual(error._tag, "HookAborted");
      if (error._tag === "HookAborted") {
        assert.strictEqual(error.point, "auth.user.signUp");
        assert.strictEqual(error.code, "NO_SIGNUPS");
      }
      assert.isTrue(Option.isNone(yield* users.findByEmail("ada@example.com")));
    }).pipe(Effect.provide(envFor(recorder, { abort: true })));
  });

  it.effect(
    "the tap sees { email, name, strategy } and its amended name and email are used",
    () => {
      const recorder = newRecorder();
      return Effect.gen(function* () {
        const signUp = yield* SignUp.make;
        const vetted = yield* signUp.vet(application());
        assert.deepStrictEqual(recorder.beforeSignUp, [
          { email: "ada@example.com", name: "Ada", strategy: "password" },
        ]);
        assert.strictEqual(vetted.name, "Ada Lovelace");
        assert.deepStrictEqual(vetted.identity, { _tag: "Email", email: "ada@corp.example" });
        assert.strictEqual(vetted.strategy, "password");
      }).pipe(
        Effect.provide(
          envFor(recorder, { amend: { name: "Ada Lovelace", email: "ada@corp.example" } }),
        ),
      );
    },
  );

  it.effect("an email application keeps its address when a tap drops it", () => {
    const recorder = newRecorder();
    return Effect.gen(function* () {
      const signUp = yield* SignUp.make;
      const vetted = yield* signUp.vet(application());
      assert.deepStrictEqual(vetted.identity, { _tag: "Email", email: "ada@example.com" });
    }).pipe(Effect.provide(envFor(recorder, { amend: { dropEmail: true } })));
  });

  it.effect(
    "an anonymous application stays anonymous, or becomes an email identity if a tap supplies one",
    () => {
      const recorder = newRecorder();
      return Effect.gen(function* () {
        const signUp = yield* SignUp.make;
        const anonymous: SignUp.Application = {
          identity: { _tag: "Anonymous" },
          name: "Ghost",
          strategy: "acme",
        };
        const kept = yield* signUp.vet(anonymous);
        assert.deepStrictEqual(kept.identity, { _tag: "Anonymous" });
        assert.deepStrictEqual(recorder.beforeSignUp, [{ name: "Ghost", strategy: "acme" }]);
      }).pipe(Effect.provide(envFor(recorder)));
    },
  );

  it.effect("an anonymous application with a tap-supplied email becomes an email identity", () => {
    const recorder = newRecorder();
    return Effect.gen(function* () {
      const signUp = yield* SignUp.make;
      const vetted = yield* signUp.vet({
        identity: { _tag: "Anonymous" },
        name: "Ghost",
        strategy: "acme",
      });
      assert.deepStrictEqual(vetted.identity, { _tag: "Email", email: "found@corp.example" });
    }).pipe(Effect.provide(envFor(recorder, { amend: { email: "found@corp.example" } })));
  });

  it.effect("a phone application is unchanged", () => {
    const recorder = newRecorder();
    return Effect.gen(function* () {
      const signUp = yield* SignUp.make;
      const phone = Option.getOrThrow(Phone.normalizePhone("+15555550123"));
      const vetted = yield* signUp.vet({
        identity: { _tag: "Phone", phone },
        name: "Phoney",
        strategy: "sms",
      });
      assert.deepStrictEqual(vetted.identity, { _tag: "Phone", phone });
      assert.deepStrictEqual(recorder.beforeSignUp, [{ name: "Phoney", strategy: "sms" }]);
    }).pipe(Effect.provide(envFor(recorder)));
  });
});

describe("SignUp.create", () => {
  it.effect("creates the user, announces auth.user.created, then runs AfterSignUp", () => {
    const recorder = newRecorder();
    return Effect.gen(function* () {
      const signUp = yield* SignUp.make;
      const users = yield* Users.Users;
      const user = yield* signUp.create(yield* signUp.vet(application()));
      assert.strictEqual((yield* users.findById(user.id)).id, user.id);
      assert.deepStrictEqual(yield* eventTags, ["auth.user.created"]);
      assert.deepStrictEqual(recorder.afterSignUp, [
        { userId: user.id, email: "ada@example.com", strategy: "password" },
      ]);
    }).pipe(Effect.provide(envFor(recorder)));
  });

  it.effect("a duplicate email or phone is IdentityTaken with no event and no AfterSignUp", () => {
    const recorder = newRecorder();
    return Effect.gen(function* () {
      const signUp = yield* SignUp.make;
      yield* signUp.create(yield* signUp.vet(application()));
      const phone = Option.getOrThrow(Phone.normalizePhone("+15555550123"));
      yield* signUp.create(
        yield* signUp.vet({ identity: { _tag: "Phone", phone }, name: "P", strategy: "sms" }),
      );
      recorder.afterSignUp.length = 0;
      const dupEmail = yield* Effect.flip(signUp.create(yield* signUp.vet(application())));
      const dupPhone = yield* Effect.flip(
        signUp.create(
          yield* signUp.vet({ identity: { _tag: "Phone", phone }, name: "P", strategy: "sms" }),
        ),
      );
      assert.deepStrictEqual(
        [dupEmail, dupPhone].map((error) => [error._tag, "kind" in error ? error.kind : ""]),
        [
          ["SignUp/IdentityTaken", "Email"],
          ["SignUp/IdentityTaken", "Phone"],
        ],
      );
      assert.deepStrictEqual(yield* eventTags, ["auth.user.created", "auth.user.created"]);
      assert.strictEqual(recorder.afterSignUp.length, 0);
    }).pipe(Effect.provide(envFor(recorder)));
  });

  it.effect("a link conflict is IdentityTaken{Account} and no user remains", () => {
    const recorder = newRecorder();
    return Effect.gen(function* () {
      const signUp = yield* SignUp.make;
      const users = yield* Users.Users;
      const link = { providerId: "acme", subject: "acme-1" };
      yield* signUp.create(yield* signUp.vet(application("first@example.com", "acme")), { link });
      const error = yield* Effect.flip(
        signUp.create(yield* signUp.vet(application("second@example.com", "acme")), { link }),
      );
      assert.deepStrictEqual(
        [error._tag, "kind" in error ? error.kind : ""],
        ["SignUp/IdentityTaken", "Account"],
      );
      assert.isTrue(Option.isNone(yield* users.findByEmail("second@example.com")));
      assert.deepStrictEqual(yield* eventTags, ["auth.user.created"]);
    }).pipe(Effect.provide(envFor(recorder)));
  });

  it.effect("verified marks the mailbox verified in the same unit and links the credential", () => {
    const recorder = newRecorder();
    return Effect.gen(function* () {
      const signUp = yield* SignUp.make;
      const accounts = yield* Accounts.Accounts;
      const user = yield* signUp.create(yield* signUp.vet(application("v@example.com", "acme")), {
        verified: true,
        link: { providerId: "acme", subject: "acme-v" },
      });
      assert.isTrue(Users.isEmailVerified(user));
      assert.isTrue(Option.isSome(yield* accounts.findByProviderSubject("acme", "acme-v")));
      const unverified = yield* signUp.create(yield* signUp.vet(application("u@example.com")));
      assert.isFalse(Users.isEmailVerified(unverified));
    }).pipe(Effect.provide(envFor(recorder)));
  });

  it.effect("an AfterSignUp failure does not fail the sign-up", () => {
    const recorder = newRecorder();
    return Effect.gen(function* () {
      const signUp = yield* SignUp.make;
      const user = yield* signUp.create(yield* signUp.vet(application()));
      assert.strictEqual(user.name, "Ada");
      assert.strictEqual(recorder.afterSignUp.length, 1);
    }).pipe(Effect.provide(envFor(recorder, { afterFails: true })));
  });

  it.effect("a transaction's SqlError is StoreUnavailable (SignUp.create), never a defect", () => {
    const recorder = newRecorder();
    const failing = Layer.succeed(
      SqlTransaction.SqlTransaction,
      SqlTransaction.SqlTransaction.of({
        withTransaction: () =>
          Effect.fail(
            new SqlError({ reason: new UnknownError({ cause: "down", message: "down" }) }),
          ),
      }),
    );
    return Effect.gen(function* () {
      const signUp = yield* SignUp.make;
      const error = yield* Effect.flip(signUp.create(yield* signUp.vet(application())));
      assert.strictEqual(error._tag, "StoreUnavailable");
      if (error._tag === "StoreUnavailable") assert.strictEqual(error.operation, "SignUp.create");
    }).pipe(Effect.provide(failing.pipe(Layer.provideMerge(envFor(recorder)))));
  });
});

describe("SignUp.createWith", () => {
  it.effect(
    "returns within's value, and a failing within leaves no user and no account, announcing nothing",
    () => {
      const recorder = newRecorder();
      return Effect.gen(function* () {
        const signUp = yield* SignUp.make;
        const users = yield* Users.Users;
        const accounts = yield* Accounts.Accounts;
        const ok = yield* signUp.createWith(
          yield* signUp.vet(application("ok@example.com", "scim:o:c")),
          {},
          (user) => Effect.succeed(user.id),
        );
        assert.strictEqual(ok.value, ok.user.id);

        const failure = yield* Effect.flip(
          signUp.createWith(
            yield* signUp.vet(application("bad@example.com", "scim:o:c")),
            { link: { providerId: "scim", subject: "bad" } },
            () => Effect.fail("membership refused" as const),
          ),
        );
        assert.strictEqual(failure, "membership refused");
        assert.isTrue(Option.isNone(yield* users.findByEmail("bad@example.com")));
        assert.isTrue(Option.isNone(yield* accounts.findByProviderSubject("scim", "bad")));
        assert.deepStrictEqual(yield* eventTags, ["auth.user.created"]);
        // Nobody was told the failed user existed, so abandoning it consults no delete veto and announces no deletion.
        assert.strictEqual(recorder.beforeUserDelete.length, 0);
        assert.strictEqual(recorder.afterSignUp.length, 1);
      }).pipe(Effect.provide(envFor(recorder)));
    },
  );
});

describe("SignUp.createSignedIn", () => {
  it.effect(
    "creates the user and a session, announcing the sign-up and then the sign-in after the unit",
    () => {
      const recorder = newRecorder();
      return Effect.gen(function* () {
        const signUp = yield* SignUp.make;
        const issued = yield* signUp.createSignedIn(yield* signUp.vet(application()), {
          amr: ["pwd"],
        });
        assert.deepStrictEqual(issued.session.amr, ["pwd"]);
        const tags = yield* eventTags;
        assert.deepStrictEqual(tags.toSorted(), [
          "auth.session.issued",
          "auth.user.created",
          "auth.user.signedIn",
        ]);
        assert.isTrue(tags.indexOf("auth.user.created") < tags.indexOf("auth.user.signedIn"));
      }).pipe(Effect.provide(envFor(recorder)));
    },
  );

  it.effect("a BeforeSignIn veto aborts and no user remains", () => {
    const recorder = newRecorder();
    return Effect.gen(function* () {
      const signUp = yield* SignUp.make;
      const users = yield* Users.Users;
      const error = yield* Effect.flip(
        signUp.createSignedIn(yield* signUp.vet(application()), { amr: ["pwd"] }),
      );
      assert.strictEqual(error._tag, "HookAborted");
      assert.isTrue(Option.isNone(yield* users.findByEmail("ada@example.com")));
      assert.deepStrictEqual(yield* eventTags, []);
    }).pipe(Effect.provide(envFor(recorder, { signInAbort: true })));
  });

  it.effect("a divert commits the account and answers TwoFactorRequired with no session", () => {
    const recorder = newRecorder();
    return Effect.gen(function* () {
      const signUp = yield* SignUp.make;
      const users = yield* Users.Users;
      const error = yield* Effect.flip(
        signUp.createSignedIn(yield* signUp.vet(application()), { amr: ["pwd"] }),
      );
      assert.strictEqual(error._tag, "TwoFactorRequired");
      const user = Option.getOrThrow(yield* users.findByEmail("ada@example.com"));
      const sessions = yield* Sessions.Sessions;
      assert.strictEqual((yield* sessions.list(user.id)).length, 0);
      assert.deepStrictEqual(yield* eventTags, ["auth.user.created"]);
    }).pipe(Effect.provide(envFor(recorder, { divert: true })));
  });

  it.effect("a session-store outage is StoreUnavailable and no user remains", () => {
    const recorder = newRecorder();
    return Effect.gen(function* () {
      const signUp = yield* SignUp.make;
      const users = yield* Users.Users;
      const error = yield* Effect.flip(
        signUp.createSignedIn(yield* signUp.vet(application()), { amr: ["pwd"] }),
      );
      assert.strictEqual(error._tag, "StoreUnavailable");
      assert.isTrue(Option.isNone(yield* users.findByEmail("ada@example.com")));
      assert.deepStrictEqual(yield* eventTags, []);
    }).pipe(Effect.provide(envFor(recorder, { sessionsOutage: true })));
  });
});
