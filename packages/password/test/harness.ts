// Shared composition for the password plugin's newer test files: `Auth.make([Password])` through `TestAuth.layer`
// (plan 08), parameterised over the pieces a test wants to swap (HIBP transport, config, mailer, hasher, limiter, a
// wrapped core service).
import { Auth } from "@awthaq/core";
import type { Accounts, Sessions, Users } from "@awthaq/core";
import type { Mailer, PasswordHasher, RateLimiter } from "@awthaq/ports";
import { TestAuth } from "@awthaq/test";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Password from "../src/Password.ts";

export const email = "ada@example.com";
export const strongPassword = Redacted.make("correct horse battery staple");

/** `TestAuth.httpClient`'s doubles under the names this package's suites already use. */
export const httpClientReturning = TestAuth.httpClient.returning;
export const NoBreachHttpClient = TestAuth.httpClient.noBreach;
export const UnavailableHttpClient = TestAuth.httpClient.unavailable;

const built = Auth.make([Password.Password]);

export const makeTestLayer = <
  Wrapped extends Sessions.Sessions | Accounts.Accounts | Users.Users = never,
>(
  options: {
    readonly httpClient?: Layer.Layer<HttpClient.HttpClient>;
    readonly config?: Partial<Password.PasswordConfigShape>;
    readonly mailer?: Layer.Layer<Mailer.Mailer>;
    readonly limiter?: Layer.Layer<RateLimiter.RateLimiter>;
    readonly hasher?: Layer.Layer<PasswordHasher.PasswordHasher, never, Crypto.Crypto>;
    /** Application taps on the composition's hook points (a veto or an observer). */
    readonly taps?: Layer.Layer<never, never, unknown>;
    /** Wraps a core service the plugin captures at construction (for example to simulate a store outage). */
    readonly coreOverride?: Layer.Layer<Wrapped, never, Wrapped>;
  } = {},
) =>
  TestAuth.layer(built, {
    services: Layer.mergeAll(
      options.httpClient ?? NoBreachHttpClient,
      Password.config(options.config ?? {}),
      ...(options.mailer === undefined ? [] : [options.mailer]),
      ...(options.limiter === undefined ? [] : [options.limiter]),
      ...(options.hasher === undefined ? [] : [options.hasher]),
    ),
    ...(options.coreOverride === undefined ? {} : { decorate: options.coreOverride }),
    ...(options.taps === undefined ? {} : { taps: options.taps }),
  });

/** Cooperative scheduler turns for the background mail fibers (see `Password.test.ts`). */
export const letForkedFibersRun = Effect.gen(function* () {
  for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
});

/** A mailed token, whether the adapter-facing value is a plain string or `Redacted` (EOTS-010). */
export const tokenOf = (mail: Mailer.MailMessage | undefined): string => {
  const token = mail?.data?.["token"];
  return Redacted.isRedacted(token) ? String(Redacted.value(token)) : String(token);
};
