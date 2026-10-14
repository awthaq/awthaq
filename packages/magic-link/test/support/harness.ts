// The shared domain-level composition for this package's tests: `Auth.make([MagicLink, EmailOtp, TwoFactor])`
// through `TestAuth.layer` (plan 08): real in-memory `Users`, `Sessions`, `Verification`, `AuthEvents` and `AuditLog`,
// the real `MagicLink` and `EmailOtp` plugins, and, so the MFA divert can be proven end to end, the real
// `@awthaq/two-factor` plugin with both gates.
import { Auth, Errors, Sessions } from "@awthaq/core";
import { Mailer, RateLimiter } from "@awthaq/ports";
import { SecondFactor, TwoFactor } from "@awthaq/two-factor";
import { TestAuth } from "@awthaq/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as EmailOtp from "../../src/EmailOtp.ts";
import * as MagicLink from "../../src/MagicLink.ts";

/** Fails `Sessions.issue` with the typed outage while the flag is set (ADR-EA-039: a link must survive it). */
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

/** A real limiter over the in-memory store (rate-limit tests need real budgets), or the permissive one. */
export const realLimiter = RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory));

const built = Auth.make([MagicLink.MagicLink, EmailOtp.EmailOtp, TwoFactor.TwoFactor]);

export const buildLayer = (options?: {
  readonly magicLink?: Partial<MagicLink.MagicLinkConfigShape>;
  readonly emailOtp?: Partial<EmailOtp.EmailOtpConfigShape>;
  readonly limiter?: Layer.Layer<RateLimiter.RateLimiter>;
  /** While set, `Sessions.issue` fails with the typed `StoreUnavailable`. */
  readonly failSessionIssue?: Ref.Ref<boolean>;
}) =>
  TestAuth.layer(built, {
    // `@awthaq/two-factor`'s gates are always installed (so the MFA divert is real); the suite's limiter sits beneath
    // them because `SecondFactor` spends its failure budget through it.
    services: Layer.mergeAll(
      Layer.mergeAll(TwoFactor.sessionGate, TwoFactor.credentialResetGate).pipe(
        Layer.provideMerge(SecondFactor.layer),
      ),
      MagicLink.config(options?.magicLink ?? {}),
      EmailOtp.config(options?.emailOtp ?? {}),
    ).pipe(Layer.provideMerge(options?.limiter ?? RateLimiter.layerPermissive)),
    ...(options?.failSessionIssue === undefined
      ? {}
      : { decorate: sessionsWithOutage(options.failSessionIssue) }),
  });

/** Lets the fibers the plugins fork (mail dispatch) run before a test reads their result. */
export const letForkedFibersRun = Effect.gen(function* () {
  for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
});

/** A mailed value, whether the adapter-facing value is a plain string or `Redacted` (EOTS-010). */
export const secretOf = (mail: Mailer.MailMessage | undefined, field: string): string => {
  const value = mail?.data?.[field];
  return Redacted.isRedacted(value) ? String(Redacted.value(value)) : String(value);
};
