// BCR-010/P20a: the composition 31-two-factor.feature runs against — the real `Password` plugin
// as the first factor, the real `TwoFactor` plugin with both of its gates, real in-memory `Users`/
// `Accounts`/`Sessions`/`Verification`/`AuditLog`, the real `Encryption` port over a fixed test key,
// argon2id at its smallest legal cost, and either the permissive `RateLimiter` or a real one over
// the in-memory store (the lockout scenarios need real budgets). Steps call the services directly:
// the wire contract is `packages/two-factor/test/AuthHttp.test.ts`'s.
//
// The stack is built lazily, on the real clock and outside the step's `TestClock` (so anything that
// reads the clock when it is *built* is not pinned to 1970); every direct call still reads the
// caller's clock, so a scenario moves time with `advance` and TOTPs are computed on the same clock
// the services read. A scenario that wants a non-default composition states so in a Given
// (`configureApp`) before its first call.
import {
  Accounts,
  AuditLog,
  AuthEvents,
  DataExport,
  Erasure,
  Hooks,
  Migrations,
  RateLimits,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import {
  ClientAddress,
  Encryption,
  KeyProvider,
  Mailer,
  PasswordHasher,
  RateLimiter,
  SqlTransaction,
} from "@awthaq/ports";
import { Password } from "@awthaq/password";
import { Authentication, Csrf } from "@awthaq/server";
import { SecondFactor, Totp, TwoFactor, TwoFactorConfig, TwoFactorStore } from "@awthaq/two-factor";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { CsrfConfigForTests } from "./CsrfTestSupport.ts";
import { mailedToken } from "./MailedToken.ts";
import {
  cheapArgon2id,
  letForkedFibersRun,
  makeNamedRegistry,
  STRONG_PASSWORD,
} from "./shared/Harness.ts";
import { TestAuth } from "@awthaq/test";

type NamedRegistry<A> = ReturnType<typeof makeNamedRegistry<A>>;

/** The password every registered person signs up with. */
export const PASSWORD = Redacted.make(STRONG_PASSWORD);

const EncryptionLive = Encryption.layer.pipe(
  Layer.provide(
    KeyProvider.layerEnv.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { AWTHAQ_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") },
          }),
        ),
      ),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);

const NoBreachHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
  ),
);

const CoreLive = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  Sessions.layerMemory,
  Verification.layerMemory,
).pipe(Layer.provideMerge(TestAuth.memoryFoundation));

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(Layer.succeed(Csrf.CsrfConfig, CsrfConfigForTests)),
  Layer.provide(NodeCrypto.layer),
);

export interface AppOptions {
  readonly config?: Partial<TwoFactorConfig.TwoFactorConfigShape>;
  /** `true`: a real `RateLimiter` over the in-memory store — the lockout scenarios' budgets are real. */
  readonly enforceRateLimits?: boolean;
}

const buildAppLayer = (options: AppOptions) =>
  Layer.mergeAll(
    Password.Password.layer,
    TwoFactor.TwoFactor.layer,
    Erasure.layer,
    DataExport.layer,
  ).pipe(
    Layer.provideMerge(TwoFactor.sessionGate),
    Layer.provideMerge(TwoFactor.credentialResetGate),
    Layer.provideMerge(SecondFactor.layer),
    Layer.provideMerge(
      Layer.mergeAll(TwoFactorStore.layerSecretsMemory, TwoFactorStore.layerRecoveryCodesMemory),
    ),
    Layer.provideMerge(EncryptionLive),
    Layer.provideMerge(AuthenticationLive),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(
      Layer.mergeAll(
        cheapArgon2id,
        Mailer.layerMemory,
        options.enforceRateLimits === true
          ? RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))
          : RateLimiter.layerPermissive,
      ).pipe(Layer.provideMerge(NodeCrypto.layer)),
    ),
    Layer.provideMerge(RateLimits.layer),
    Layer.provide(NoBreachHttpClient),
    Layer.provide(SqlTransaction.layerNoop),
    Layer.provide(ClientAddress.layerDirect),
    Layer.provideMerge(TwoFactorConfig.config(options.config ?? {})),
    // The sign-in timing floor sleeps on the clock the scenario controls; it is Password's own concern
    // (packages/password/test/Password.test.ts, TSS-006), not the second factor's.
    Layer.provideMerge(Password.config({ signInTimingFloor: "off" })),
  );

/** What a step may ask of the running composition. */
export type TwoFactorServices =
  | Password.Password
  | TwoFactor.TwoFactor
  | SecondFactor.SecondFactor
  | TwoFactorStore.TwoFactorSecrets
  | TwoFactorStore.TwoFactorRecoveryCodes
  | Encryption.Encryption
  | Users.Users
  | Sessions.Sessions
  | Verification.Verification
  | AuditLog.AuditLog
  | AuthEvents.AuthEvents
  | Mailer.Mailer
  | Erasure.AccountErasure
  | DataExport.AccountExport
  | Hooks.BeforeSessionIssue
  | Crypto.Crypto
  | PasswordHasher.PasswordHasher;

/** A person a scenario names ("alice"). */
export interface Person {
  readonly email: string;
  readonly userId: Users.UserId;
  /** The sign-up session: fresh for ten minutes (the re-authentication window enrolment needs). */
  readonly sessionId: string;
  /** The base32 secret shown by `enable`, once known. */
  readonly secret: Option.Option<string>;
  /** The recovery codes `confirm` returned, once known (as shown: grouped). */
  readonly recoveryCodes: ReadonlyArray<string>;
}

export interface WorldShape {
  readonly options: Ref.Ref<AppOptions>;
  readonly running: Ref.Ref<Option.Option<Context.Context<TwoFactorServices>>>;
  readonly scope: Scope.Closeable;
  readonly people: NamedRegistry<Person>;
  /** Outcomes of direct service calls, by the name a step chose. */
  readonly exits: NamedRegistry<Exit.Exit<unknown, unknown>>;
  /** Text a step wants a later step to compare against (challenge ids, secrets). */
  readonly strings: NamedRegistry<string>;
  readonly numbers: NamedRegistry<number>;
  readonly lists: NamedRegistry<ReadonlyArray<string>>;
  readonly documents: NamedRegistry<DataExport.AccountExportDocument>;
  /** The SQLite-backed recovery-code store of the atomicity scenario, once opened. */
  readonly sql: Ref.Ref<Option.Option<Context.Context<SqlServices>>>;
}

type SqlServices = TwoFactorStore.TwoFactorRecoveryCodes | SqlClient.SqlClient;

export class World extends Context.Service<World, WorldShape>()("features/TwoFactorWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    const scope = Scope.makeUnsafe();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    return World.of({
      options: yield* Ref.make<AppOptions>({}),
      running: yield* Ref.make<Option.Option<Context.Context<TwoFactorServices>>>(Option.none()),
      scope,
      people: makeNamedRegistry<Person>("person"),
      exits: makeNamedRegistry<Exit.Exit<unknown, unknown>>("outcome"),
      strings: makeNamedRegistry<string>("text"),
      numbers: makeNamedRegistry<number>("number"),
      lists: makeNamedRegistry<ReadonlyArray<string>>("list"),
      documents: makeNamedRegistry<DataExport.AccountExportDocument>("document"),
      sql: yield* Ref.make<Option.Option<Context.Context<SqlServices>>>(Option.none()),
    });
  }),
);

/** States a non-default composition; only valid before the first service call of the scenario. */
export const configureApp = Effect.fn("features.twoFactor.configureApp")(function* (
  options: AppOptions,
) {
  const world = yield* World;
  if (Option.isSome(yield* Ref.get(world.running))) {
    throw new Error("configureApp must precede the scenario's first service call");
  }
  yield* Ref.update(world.options, (existing) => ({
    ...existing,
    ...options,
    config: { ...existing.config, ...options.config },
  }));
});

const running = Effect.gen(function* () {
  const world = yield* World;
  const existing = yield* Ref.get(world.running);
  if (Option.isSome(existing)) return existing.value;
  const options = yield* Ref.get(world.options);
  // Built on the real clock, outside the step's `TestClock` (see the header).
  const context = yield* Effect.promise(() =>
    Effect.runPromise(
      Layer.buildWithMemoMap(buildAppLayer(options), Layer.makeMemoMapUnsafe(), world.scope),
    ),
  );
  yield* Ref.set(world.running, Option.some(context));
  return context;
});

/** Runs a service-level effect against the composition; a typed failure is a defect (use `directExit` to observe one). */
export const direct = <A, E>(effect: Effect.Effect<A, E, TwoFactorServices>) =>
  Effect.gen(function* () {
    const context = yield* running;
    return yield* Effect.provide(effect, context).pipe(Effect.orDie);
  });

/** Like `direct`, but the outcome — typed failure included — is the value. */
export const directExit = <A, E>(effect: Effect.Effect<A, E, TwoFactorServices>) =>
  Effect.gen(function* () {
    const context = yield* running;
    return yield* Effect.exit(Effect.provide(effect, context));
  });

/** The typed failure of an outcome, or `undefined` when it succeeded or died. */
export const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (!Exit.isFailure(exit)) return undefined;
  return exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error;
};

/** The `_tag` of a typed failure, or `undefined`. */
export const failureTag = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  const failure = failureOf(exit);
  return typeof failure === "object" && failure !== null && "_tag" in failure
    ? String(failure._tag)
    : undefined;
};

/** Moves the composition's (and the steps') simulated clock forward. */
export const advance = Effect.fn("features.twoFactor.advance")(function* (
  duration: Duration.Input,
) {
  yield* TestClock.adjust(duration);
});

/** Starts the next TOTP step: a code is single-use, and enrolment already spent the current one. */
export const nextStep = advance(Duration.seconds(30));

const secretOf = (person: Person): string => {
  if (Option.isNone(person.secret)) throw new Error(`"${person.email}" has no secret yet`);
  return person.secret.value;
};

export const getPerson = Effect.fn("features.twoFactor.getPerson")(function* (name: string) {
  const { people } = yield* World;
  return yield* people.get(name);
});

export const requireSecret = (person: Person): string => secretOf(person);

/** Signs `name` up with a password and consumes the verification mail, so sign-in is not gated on it. */
export const register = Effect.fn("features.twoFactor.register")(function* (name: string) {
  const { people } = yield* World;
  const email = `${name}@example.com`;
  const { userId, sessionId } = yield* direct(
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const mailer = yield* Mailer.Mailer;
      const issued = yield* password.signUp({ email, password: PASSWORD });
      yield* letForkedFibersRun;
      const mail = (yield* mailer.sent).findLast(
        (message) => message.template === "verify-email" && message.to === email,
      );
      if (mail === undefined) return yield* Effect.die("no verify-email mail");
      yield* password.verifyEmail({ token: Redacted.make(mailedToken(mail)) });
      return { userId: issued.session.userId, sessionId: issued.session.id };
    }),
  );
  yield* people.set(name, {
    email,
    userId,
    sessionId,
    secret: Option.none(),
    recoveryCodes: [],
  });
});

/** Stores a new value of a person (the registry replaces by name). */
export const updatePerson = Effect.fn("features.twoFactor.updatePerson")(function* (
  name: string,
  change: (person: Person) => Person,
) {
  const { people } = yield* World;
  const person = yield* people.get(name);
  yield* people.set(name, change(person));
});

/** `enable` on the person's fresh sign-up session; returns the enrolment and remembers the secret. */
export const beginEnrolment = Effect.fn("features.twoFactor.beginEnrolment")(function* (
  name: string,
) {
  const person = yield* getPerson(name);
  const exit = yield* directExit(
    Effect.gen(function* () {
      const twoFactor = yield* TwoFactor.TwoFactor;
      return yield* twoFactor.enable(person.userId, person.sessionId);
    }),
  );
  if (Exit.isSuccess(exit)) {
    yield* updatePerson(name, (existing) => ({
      ...existing,
      secret: Option.some(exit.value.secret),
    }));
  }
  return exit;
});

/** The TOTP `secret` yields at the composition's current clock, `steps` time steps away. */
export const totpFor = (secret: string, steps = 0) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const now = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
    const key = Totp.base32Decode(secret);
    if (Option.isNone(key)) return yield* Effect.die("not base32");
    return yield* Totp.totp(crypto, key.value, now + steps * 30, { period: 30, digits: 6 });
  });

/** The person's current authenticator code. */
export const currentCode = Effect.fn("features.twoFactor.currentCode")(function* (name: string) {
  const person = yield* getPerson(name);
  return yield* direct(totpFor(secretOf(person)));
});

/** Confirms a pending secret with the person's current code; remembers the recovery codes. */
export const confirmEnrolment = Effect.fn("features.twoFactor.confirmEnrolment")(function* (
  name: string,
) {
  const person = yield* getPerson(name);
  const code = yield* currentCode(name);
  const exit = yield* directExit(
    Effect.gen(function* () {
      const twoFactor = yield* TwoFactor.TwoFactor;
      return yield* twoFactor.confirm(person.userId, Redacted.make(code));
    }),
  );
  if (Exit.isSuccess(exit)) {
    yield* updatePerson(name, (existing) => ({ ...existing, recoveryCodes: exit.value }));
  }
  return exit;
});

/** Registers-and-enrols in one go: `enable` then `confirm`, on the person's fresh session. */
export const enrol = Effect.fn("features.twoFactor.enrol")(function* (name: string) {
  const enabled = yield* beginEnrolment(name);
  if (Exit.isFailure(enabled)) throw new Error("enable failed while enrolling");
  const confirmed = yield* confirmEnrolment(name);
  if (Exit.isFailure(confirmed)) throw new Error("confirm failed while enrolling");
});

/** A first-factor sign-in with the person's password: the outcome is the value. */
export const signInWithPassword = Effect.fn("features.twoFactor.signIn")(function* (name: string) {
  const person = yield* getPerson(name);
  return yield* directExit(
    Effect.gen(function* () {
      const password = yield* Password.Password;
      return yield* password.signIn({ email: person.email, password: PASSWORD });
    }),
  );
});

/** The challenge a diverted password sign-in carries. */
export const divertedChallenge = Effect.fn("features.twoFactor.divertedChallenge")(function* (
  name: string,
) {
  const exit = yield* signInWithPassword(name);
  const failure = failureOf(exit);
  if (
    typeof failure !== "object" ||
    failure === null ||
    !("_tag" in failure) ||
    failure._tag !== "TwoFactorRequired" ||
    !("challengeId" in failure)
  ) {
    throw new Error(`expected a TwoFactorRequired divert for "${name}"`);
  }
  return String(failure.challengeId);
});

/**
 * A challenge minted directly for the person, bypassing the first factor (a real limiter would
 * also throttle `Password.signIn`, and the budget scenarios are about the second factor alone).
 */
export const freshChallenge = Effect.fn("features.twoFactor.freshChallenge")(function* (
  name: string,
) {
  const person = yield* getPerson(name);
  return yield* direct(
    Effect.gen(function* () {
      const factor = yield* SecondFactor.SecondFactor;
      return yield* factor.issueChallenge({
        userId: person.userId,
        strategy: "password",
        amr: ["pwd"],
        attempt: 0,
      });
    }),
  );
});

/** Presents a TOTP code on a challenge to `TwoFactor.verify`. */
export const verifyWith = (challengeId: string, code: string) =>
  directExit(
    Effect.gen(function* () {
      const twoFactor = yield* TwoFactor.TwoFactor;
      return yield* twoFactor.verify({
        challengeId: Redacted.make(challengeId),
        code: Redacted.make(code),
      });
    }),
  );

/** Presents a recovery code on a challenge to `TwoFactor.verifyRecovery`. */
export const verifyRecoveryWith = (challengeId: string, recoveryCode: string) =>
  directExit(
    Effect.gen(function* () {
      const twoFactor = yield* TwoFactor.TwoFactor;
      return yield* twoFactor.verifyRecovery({
        challengeId: Redacted.make(challengeId),
        recoveryCode: Redacted.make(recoveryCode),
      });
    }),
  );

/** How many `auth.session.issued` rows the audit log holds. */
export const sessionsIssued = Effect.fn("features.twoFactor.sessionsIssued")(function* () {
  return yield* direct(
    Effect.gen(function* () {
      const audit = yield* AuditLog.AuditLog;
      return (yield* audit.list({ eventTag: "auth.session.issued" })).length;
    }),
  );
});

/** The audit rows of one event type (the tag arrives as Gherkin text, so the filter is applied here). */
export const auditRows = Effect.fn("features.twoFactor.auditRows")(function* (eventTag: string) {
  const rows = yield* direct(
    Effect.gen(function* () {
      const audit = yield* AuditLog.AuditLog;
      return yield* audit.list();
    }),
  );
  return rows.filter((row) => row.eventTag === eventTag);
});

// ---- a real SQL store for the atomicity Rule ------------------------------------------------------

/** Opens a SQLite database with the plugin's own migrations and the SQL recovery-code store over it (kept for the scenario). */
export const openSqlRecoveryCodes = Effect.fn("features.twoFactor.openSql")(function* () {
  const world = yield* World;
  const context = yield* Effect.promise(() =>
    Effect.runPromise(
      Layer.buildWithMemoMap(
        TwoFactorStore.layerRecoveryCodesSql.pipe(
          Layer.provide(NodeCrypto.layer),
          Layer.provideMerge(
            Layer.effectDiscard(Migrations.run(TwoFactor.TwoFactor.migrations)).pipe(
              Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
            ),
          ),
        ),
        Layer.makeMemoMapUnsafe(),
        world.scope,
      ),
    ),
  );
  yield* Ref.set(world.sql, Option.some(context));
});

/** Runs an effect against the scenario's SQL store; a typed failure is the value (the outcome). */
export const sqlExit = <A, E>(effect: Effect.Effect<A, E, SqlServices>) =>
  Effect.gen(function* () {
    const world = yield* World;
    const context = yield* Ref.get(world.sql);
    if (Option.isNone(context)) throw new Error("the SQL recovery-code store was not opened");
    return yield* Effect.exit(Effect.provide(effect, context.value));
  });
