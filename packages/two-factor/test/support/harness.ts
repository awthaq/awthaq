// The shared domain-level composition for this plugin's own tests: real in-memory `Users`,
// `Accounts`, `Sessions`, `Verification`, `AuthEvents` and `AuditLog`, the real `Password` plugin
// (the first factor), the real `TwoFactor` plugin with both of its gates, the real `Encryption`
// port over a fixed test key, and argon2id at its smallest legal cost. Only the rate limiter and the
// plugin's configuration vary per suite.
import { TestEncryption } from "@awthaq/test";
import {
  Accounts,
  AuditLog,
  AuthEvents,
  Errors,
  Hooks,
  Persistence,
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
import { CoreMigrations } from "@awthaq/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SecondFactor from "../../src/SecondFactor.ts";
import * as Totp from "../../src/Totp.ts";
import * as TwoFactor from "../../src/TwoFactor.ts";
import * as TwoFactorConfig from "../../src/TwoFactorConfig.ts";
import * as TwoFactorStore from "../../src/TwoFactorStore.ts";
import { TestAuth } from "@awthaq/test";
import { TestSql } from "@awthaq/test";

/** Every SQL store over the ambient `SqlClient` (plan 02): provide it where the composition is built. */
const SqlStores = Persistence.sql().pipe(Layer.provide(TestEncryption.layer));

/** A real hasher (real algorithm, salt and PHC format) at the smallest legal cost, so recovery-code suites stay fast. */
const TestHasher = PasswordHasher.layerArgon2id.pipe(
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromEnv({
        env: { AUTH_ARGON2_MEMORY_KIB: "1024", AUTH_ARGON2_ITERATIONS: "1" },
      }),
    ),
  ),
  Layer.orDie,
);

/** A fixed test key, read through `ConfigProvider.fromEnv` so the real process environment is never consulted. */
export const EncryptionLive = Encryption.layer.pipe(
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

/** Fails `Sessions.issue` with the typed outage while the flag is set (ADR-EA-039: a challenge must survive it). */
const sessionsWithOutage = (outage: Ref.Ref<boolean>) =>
  Layer.effect(
    Sessions.Sessions,
    Effect.gen(function* () {
      const real = yield* Sessions.Sessions;
      return Sessions.Sessions.of({
        ...real,
        issue: (input) =>
          Ref.get(outage).pipe(
            Effect.flatMap((down) =>
              down
                ? Effect.fail(new Errors.StoreUnavailable({ operation: "Sessions.issue" }))
                : real.issue(input),
            ),
          ),
      });
    }),
  ).pipe(Layer.provide(Sessions.layer.pipe(Layer.provide(Persistence.memory))));

const coreLive = (outage: Ref.Ref<boolean> | undefined) =>
  Layer.mergeAll(
    Users.layer.pipe(Layer.provide(Persistence.memory)),
    Accounts.layer.pipe(Layer.provide(Persistence.memory)),
    outage === undefined
      ? Sessions.layer.pipe(Layer.provide(Persistence.memory))
      : sessionsWithOutage(outage),
    Verification.layer.pipe(Layer.provide(Persistence.memory)),
  );

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("two-factor-test-csrf-secret-padded-to-thirty-two-bytes"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

export const Stores = Layer.mergeAll(
  TwoFactorStore.layerSecretsMemory,
  TwoFactorStore.layerRecoveryCodesMemory,
);

/** Both gates, provided to the plugin: what `TwoFactor.layer` demands and what a real composition adds. */
export const Gates = Layer.mergeAll(TwoFactor.sessionGate, TwoFactor.credentialResetGate);

/** A real limiter over the in-memory store (lockout tests need real budgets), or the permissive one. */
export const realLimiter = RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory));

export interface BuildOptions {
  readonly config?: Partial<TwoFactorConfig.TwoFactorConfigShape>;
  readonly limiter?: Layer.Layer<RateLimiter.RateLimiter>;
  /** While set, `Sessions.issue` fails with the typed `StoreUnavailable`. */
  readonly failSessionIssue?: Ref.Ref<boolean>;
}

/** The plugins over the shared stores, gates and in-memory domain services (the foundation is added by the caller). */
const plugins = (outage: Ref.Ref<boolean> | undefined) =>
  Layer.mergeAll(Password.Password.layer, TwoFactor.TwoFactor.layer).pipe(
    Layer.provideMerge(Gates),
    Layer.provideMerge(SecondFactor.layer),
    Layer.provideMerge(Stores),
    Layer.provideMerge(EncryptionLive),
    Layer.provideMerge(AuthenticationLive),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(coreLive(outage)),
  );

/** Everything beneath the foundation: ports, rate limits, the transaction port and the plugin's configuration. */
const beneath =
  (options: BuildOptions | undefined) =>
  <TransactionError>(transaction: Layer.Layer<SqlTransaction.SqlTransaction, TransactionError>) =>
  <A, E, R>(layer: Layer.Layer<A, E, R>) =>
    layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          TestHasher,
          Mailer.layerMemory,
          options?.limiter ?? RateLimiter.layerPermissive,
        ).pipe(Layer.provideMerge(NodeCrypto.layer)),
      ),
      Layer.provideMerge(RateLimits.layer),
      Layer.provide(TestAuth.httpClient.noBreach),
      Layer.provide(transaction),
      Layer.provide(ClientAddress.layerDirect),
      Layer.provideMerge(TwoFactorConfig.config(options?.config ?? {})),
    );

export const buildLayer = (options?: BuildOptions) =>
  plugins(options?.failSessionIssue).pipe(
    Layer.provideMerge(TestAuth.memoryFoundation),
    beneath(options)(SqlTransaction.layerNoop),
  );

const SqlLive = TestSql.layer("two_factor_harness");

/**
 * The same composition with a real database under the audit log and the transaction port
 * (SQLite in memory, the real core migrations), so a rolled-back transaction really erases what
 * was written inside it. Users, sessions and tokens stay in memory.
 */
export const buildDurableAuditLayer = (options?: BuildOptions) => {
  const durableFoundation = AuthEvents.layer.pipe(
    Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(SqlStores))),
    Layer.provideMerge(Hooks.HooksLive),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(SqlLive),
    Layer.provideMerge(
      Layer.effectDiscard(Migrator.make({})({ loader: CoreMigrations.coreMigrations })).pipe(
        Layer.provide(SqlLive),
      ),
    ),
  );
  return plugins(options?.failSessionIssue).pipe(
    Layer.provideMerge(durableFoundation),
    beneath(options)(SqlTransaction.layerSql.pipe(Layer.provide(SqlLive))),
  );
};

/** Lets fibers the plugins fork (mail dispatch) run before a test reads their result. */
export const letForkedFibersRun = Effect.gen(function* () {
  for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
});

/** A mailed token, whether the adapter-facing value is a plain string or `Redacted` (EOTS-010). */
export const tokenOf = (mail: Mailer.MailMessage | undefined): string => {
  const token = mail?.data?.["token"];
  return Redacted.isRedacted(token) ? String(Redacted.value(token)) : String(token);
};

/** The TOTP the enrolled secret yields at the current (test) clock, optionally `steps` away. */
export const codeFor = (secret: string, steps = 0) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const now = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
    const key = Totp.base32Decode(secret);
    if (key._tag === "None") return yield* Effect.die("not base32");
    return yield* Totp.totp(crypto, key.value, now + steps * 30, { period: 30, digits: 6 });
  }).pipe(Effect.provide(NodeCrypto.layer));
