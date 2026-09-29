// The shared domain-level composition for this package's tests: real in-memory `Users`, `Sessions`,
// `Verification`, `AuthEvents` and `AuditLog`, the real `MagicLink` and `EmailOtp` plugins, and —
// so the MFA divert can be proven end to end — the real `@awthaq/two-factor` plugin with both gates.
import { AuditLog, AuthEvents, Hooks, RateLimits, Sessions, Users, Verification } from "@awthaq/core";
import {
  ClientAddress,
  Encryption,
  KeyProvider,
  Mailer,
  PasswordHasher,
  RateLimiter,
  SqlTransaction,
} from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import { SecondFactor, TwoFactor, TwoFactorStore } from "@awthaq/two-factor";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as EmailOtp from "../../src/EmailOtp.ts";
import * as MagicLink from "../../src/MagicLink.ts";

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

const EncryptionLive = Encryption.layer.pipe(
  Layer.provide(
    KeyProvider.layerEnv.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { AWTHAQ_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") },
          }),
        ),
      ),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);

const CoreLive = Layer.mergeAll(Users.layerMemory, Sessions.layerMemory, Verification.layerMemory).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

export const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("magic-link-test-csrf-secret-padded-to-thirty-two-bytes"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

/** A real limiter over the in-memory store (rate-limit tests need real budgets), or the permissive one. */
export const realLimiter = RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory));

/** `@awthaq/two-factor`, gates included, so the MFA divert is real. */
const TwoFactorLive = TwoFactor.TwoFactor.layer.pipe(
  Layer.provideMerge(TwoFactor.sessionGate),
  Layer.provideMerge(TwoFactor.credentialResetGate),
  Layer.provideMerge(SecondFactor.layer),
  Layer.provideMerge(
    Layer.mergeAll(TwoFactorStore.layerSecretsMemory, TwoFactorStore.layerRecoveryCodesMemory),
  ),
  Layer.provideMerge(EncryptionLive),
);

export const buildLayer = (options?: {
  readonly magicLink?: Partial<MagicLink.MagicLinkConfigShape>;
  readonly emailOtp?: Partial<EmailOtp.EmailOtpConfigShape>;
  readonly limiter?: Layer.Layer<RateLimiter.RateLimiter>;
}) =>
  Layer.mergeAll(MagicLink.MagicLink.layer, EmailOtp.EmailOtp.layer, TwoFactorLive).pipe(
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
    Layer.provide(SqlTransaction.layerNoop),
    Layer.provide(ClientAddress.layerDirect),
    Layer.provideMerge(MagicLink.config(options?.magicLink ?? {})),
    Layer.provideMerge(EmailOtp.config(options?.emailOtp ?? {})),
  );

/** Lets the fibers the plugins fork (mail dispatch) run before a test reads their result. */
export const letForkedFibersRun = Effect.gen(function* () {
  for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
});

/** A mailed value, whether the adapter-facing value is a plain string or `Redacted` (EOTS-010). */
export const secretOf = (mail: Mailer.MailMessage | undefined, field: string): string => {
  const value = mail?.data?.[field];
  return Redacted.isRedacted(value) ? String(Redacted.value(value)) : String(value);
};
