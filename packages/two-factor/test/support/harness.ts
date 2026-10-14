// The shared composition for this plugin's own tests: `Auth.make([Password, TwoFactor])` through `TestAuth.layer`
// (plan 08): real in-memory `Users`, `Accounts`, `Sessions`, `Verification`, `AuthEvents` and `AuditLog`, the real
// `Password` plugin (the first factor), the real `TwoFactor` plugin with both of its gates, the real `Encryption`
// port over a fixed test key, and argon2id at its smallest legal cost. Only the rate limiter and the plugin's
// configuration vary per suite.
import { Auth, Errors, Sessions } from "@awthaq/core";
import { Mailer, RateLimiter } from "@awthaq/ports";
import { Password } from "@awthaq/password";
import { TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as SecondFactor from "../../src/SecondFactor.ts";
import * as Totp from "../../src/Totp.ts";
import * as TwoFactor from "../../src/TwoFactor.ts";
import * as TwoFactorConfig from "../../src/TwoFactorConfig.ts";

/** A fixed test key (what every `TestAuth` composition carries), for a store suite that builds `Persistence.sql()` alone. */
export const EncryptionLive = TestAuth.encryption;

/** Both gates, provided to the plugin: what `TwoFactor.layer` demands and what a real composition adds. */
export const Gates = Layer.mergeAll(TwoFactor.sessionGate, TwoFactor.credentialResetGate).pipe(
  Layer.provideMerge(SecondFactor.layer),
);

/** A real limiter over the in-memory store (lockout tests need real budgets), or the permissive one. */
export const realLimiter = RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory));

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
  );

export interface BuildOptions {
  readonly config?: Partial<TwoFactorConfig.TwoFactorConfigShape>;
  readonly limiter?: Layer.Layer<RateLimiter.RateLimiter>;
  /** While set, `Sessions.issue` fails with the typed `StoreUnavailable`. */
  readonly failSessionIssue?: Ref.Ref<boolean>;
}

const built = Auth.make([Password.Password, TwoFactor.TwoFactor]);

const compose = (options: BuildOptions | undefined) => ({
  // The configuration and the suite's limiter sit beneath the gates (`sessionGate` reads the config when it is built,
  // `SecondFactor` spends the failure budget through the limiter) and are merged into the output, so the plugins and
  // the test read the very instances the gates use.
  services: Layer.mergeAll(Gates, TestAuth.httpClient.noBreach).pipe(
    Layer.provideMerge(TwoFactorConfig.config(options?.config ?? {})),
    Layer.provideMerge(options?.limiter ?? RateLimiter.layerPermissive),
  ),
  ...(options?.failSessionIssue === undefined
    ? {}
    : { decorate: sessionsWithOutage(options.failSessionIssue) }),
});

export const buildLayer = (options?: BuildOptions) => TestAuth.layer(built, compose(options));

/**
 * The same composition over a real database (SQLite in memory, the real core migrations, `records: "sql"`), so a
 * rolled-back transaction really erases what was written inside it: the audit log, the stores and the tokens are
 * rows, not `Ref`s.
 */
export const buildDurableAuditLayer = (options?: BuildOptions) =>
  TestAuth.layer(built, { ...compose(options), records: "sql", suite: "two_factor_harness" });

/** Lets fibers the plugins fork (mail dispatch) run before a test reads their result. */
export const letForkedFibersRun = Effect.gen(function* () {
  for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
});

/**
 * The newest mail of `template`, waiting for the forked dispatch to land it. On a real database the
 * dispatch crosses socket I/O, which a fixed number of `yieldNow`s does not outwait, so this polls on
 * the real clock (bounded) until the mail is there.
 */
export const awaitMail = (template: string) =>
  Effect.gen(function* () {
    const mailer = yield* Mailer.Mailer;
    for (let attempt = 0; attempt < 200; attempt++) {
      yield* letForkedFibersRun;
      const found = (yield* mailer.sent).findLast((mail) => mail.template === template);
      if (found !== undefined) return found;
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
    }
    return undefined;
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
