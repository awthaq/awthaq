// The shared domain-level composition for this plugin's own tests: real in-memory `Users`,
// `Accounts`, `Sessions`, `Verification`, `AuthEvents` and `AuditLog`, the real `Password` plugin
// (the first factor), the real `TwoFactor` plugin with both of its gates, the real `Encryption`
// port over a fixed test key, and argon2id at its smallest legal cost. Only the rate limiter and the
// plugin's configuration vary per suite.
import {
  Accounts,
  AuditLog,
  AuthEvents,
  Hooks,
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
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as SecondFactor from "../../src/SecondFactor.ts";
import * as Totp from "../../src/Totp.ts";
import * as TwoFactor from "../../src/TwoFactor.ts";
import * as TwoFactorConfig from "../../src/TwoFactorConfig.ts";
import * as TwoFactorStore from "../../src/TwoFactorStore.ts";

export const NoBreachHttpClient: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
  ),
);

/** A real hasher (real algorithm, salt and PHC format) at the smallest legal cost, so recovery-code suites stay fast. */
export const TestHasher = PasswordHasher.layerArgon2id.pipe(
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

const CoreLive = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  Sessions.layerMemory,
  Verification.layerMemory,
).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
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

export const buildLayer = (options?: {
  readonly config?: Partial<TwoFactorConfig.TwoFactorConfigShape>;
  readonly limiter?: Layer.Layer<RateLimiter.RateLimiter>;
}) =>
  Layer.mergeAll(Password.Password.layer, TwoFactor.TwoFactor.layer).pipe(
    Layer.provideMerge(Gates),
    Layer.provideMerge(SecondFactor.layer),
    Layer.provideMerge(Stores),
    Layer.provideMerge(EncryptionLive),
    Layer.provideMerge(AuthenticationLive),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(
      Layer.mergeAll(
        TestHasher,
        Mailer.layerMemory,
        options?.limiter ?? RateLimiter.layerPermissive,
      ).pipe(Layer.provideMerge(NodeCrypto.layer)),
    ),
    Layer.provideMerge(RateLimits.layer),
    Layer.provide(NoBreachHttpClient),
    Layer.provide(SqlTransaction.layerNoop),
    Layer.provide(ClientAddress.layerDirect),
    Layer.provideMerge(TwoFactorConfig.config(options?.config ?? {})),
  );

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
