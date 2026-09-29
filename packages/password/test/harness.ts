// Shared composition for the password plugin's newer test files: the same
// real in-memory stack `Password.test.ts` builds inline, parameterised over
// the pieces a test wants to swap (HIBP transport, config, mailer, hasher).
import {
  AuditLog,
  Hooks,
  AuthEvents,
  RateLimits,
  Sessions,
  Users,
  Verification,
  Accounts,
} from "@awthaq/core";
import { ClientAddress, Mailer, PasswordHasher, RateLimiter, SqlTransaction } from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Password from "../src/Password.ts";

export const email = "ada@example.com";
export const strongPassword = Redacted.make("correct horse battery staple");

export const httpClientReturning = (
  body: (url: string) => string,
  status = 200,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(body(request.url), { status })),
      ),
    ),
  );

/** A well-formed range listing that never matches a real suffix (PHS-004: an empty body now counts as unavailable). */
export const NoBreachHttpClient = httpClientReturning(() => `${"F".repeat(35)}:1`);

export const UnavailableHttpClient: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request }),
      }),
    ),
  ),
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
      secret: Redacted.make("password-harness-csrf-secret-0123456789abcdef"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

export const makeTestLayer = (
  options: {
    readonly httpClient?: Layer.Layer<HttpClient.HttpClient>;
    readonly config?: Partial<Password.PasswordConfigShape>;
    readonly mailer?: Layer.Layer<Mailer.Mailer>;
    readonly limiter?: Layer.Layer<RateLimiter.RateLimiter>;
    readonly hasher?: Layer.Layer<PasswordHasher.PasswordHasher, never, Crypto.Crypto>;
  } = {},
) =>
  Password.Password.layer.pipe(
    Layer.provideMerge(AuthenticationLive),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(
      Layer.mergeAll(
        options.hasher ?? PasswordHasher.layerArgon2id,
        options.mailer ?? Mailer.layerMemory,
        options.limiter ?? RateLimiter.layerPermissive,
      ).pipe(Layer.provideMerge(NodeCrypto.layer)),
    ),
    Layer.provideMerge(RateLimits.layer),
    Layer.provide(options.httpClient ?? NoBreachHttpClient),
    Layer.provide(SqlTransaction.layerNoop),
    Layer.provide(ClientAddress.layerDirect),
    Layer.provideMerge(Password.config(options.config ?? {})),
  );

/** Cooperative scheduler turns for the background mail fibers (see `Password.test.ts`). */
export const letForkedFibersRun = Effect.gen(function* () {
  for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
});

/** A mailed token, whether the adapter-facing value is a plain string or `Redacted` (EOTS-010). */
export const tokenOf = (mail: Mailer.MailMessage | undefined): string => {
  const token = mail?.data?.["token"];
  return Redacted.isRedacted(token) ? String(Redacted.value(token)) : String(token);
};
