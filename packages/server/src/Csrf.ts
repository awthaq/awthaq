// @awthaq/server — CSRF protection
//
// spec/behaviors/10-csrf.md, BEH-EA-073 through BEH-EA-080. Implements
// `@awthaq/api`'s `CsrfProtection` declaration: `Sec-Fetch-Site` first,
// `Origin` fallback, backed by a signed double-submit `__Host-csrf` cookie —
// all three compose (BEH-EA-075 "backs", not replaces, the site check).
//
// CDS-006: the token is `<iatSeconds>.<random>.<hmac(iat.random)>`, time-bound
// by `CsrfConfig.maxAge` and re-minted at half-life. It is deliberately NOT
// bound to the session: the session secret rotates every `touchEvery`, so a
// binding would 403 every user hourly.
//
// MNA-008 (decision 24 §2): a request carrying a non-empty `Authorization`
// header is exempt from minting and enforcement alike. The double-submit and
// site checks defend against a browser *automatically* attaching an ambient
// credential (a cookie) to a forged cross-site request; a cross-site page
// cannot set `Authorization` without a CORS preflight the server's own CORS
// policy must separately allow, so an explicitly-bearer request was never in
// CSRF's threat model. Without this, every cookie-less bearer/native client
// would be 403'd on sign-out/revoke/delete-user.

import { Api } from "@awthaq/api";
import { SessionCookie } from "@awthaq/core";
import { Hmac } from "@awthaq/ports";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

/** BEH-EA-077: only these methods are subject to any CSRF check at all. */
const UNSAFE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface CsrfConfigShape {
  /** BEH-EA-075: signs the double-submit cookie; never a default in production. */
  readonly secret: Redacted.Redacted<string>;
  /** BEH-EA-074: compared against `Origin` when `Sec-Fetch-Site` is absent. */
  readonly allowedOrigins: ReadonlyArray<string>;
  /**
   * CDS-006: how long a minted double-submit token stays valid (default 24
   * hours). A token is re-minted on any request once it is older than half of
   * this, so an active user always holds a fresh one and never meets the
   * expiry mid-session; a token past it is invalid (`403` on an unsafe
   * request, with a fresh cookie on that response).
   */
  readonly maxAge?: Duration.Input;
}

export class CsrfConfig extends Context.Service<CsrfConfig, CsrfConfigShape>()(
  "awthaq/server/CsrfConfig",
) {}

/**
 * SMS-004: the Config-backed `CsrfConfig`, mirroring `KeyProvider.layerEnv` —
 * the obvious path never puts a literal secret in source.
 * `AWTHAQ_CSRF_SECRET` (required, at least 32 UTF-8 bytes — a present but
 * weak secret dies with `WeakSigningSecret` at boot, ACS-007) and
 * `AWTHAQ_CSRF_ALLOWED_ORIGINS` (optional, comma-separated, defaults to none).
 * A missing secret surfaces as a `Config.ConfigError`, the same way any
 * absent config value does.
 */
export const layerConfig = Layer.effect(
  CsrfConfig,
  Effect.gen(function* () {
    const secret = yield* Config.Redacted("AWTHAQ_CSRF_SECRET");
    yield* Hmac.requireMinSecretBytes(secret);
    const allowedOrigins = yield* Config.Array(Schema.String, "AWTHAQ_CSRF_ALLOWED_ORIGINS").pipe(
      Config.withDefault([]),
    );
    return { secret, allowedOrigins };
  }),
);

// BEH-EA-075/ACS-005: HMAC-SHA256 and the constant-time comparison are the
// shared `@awthaq/ports` `Hmac` primitives, not copies.
const sign = (crypto: Crypto.Crypto, secret: Redacted.Redacted<string>, token: string) =>
  Hmac.hmacSha256(
    crypto,
    new TextEncoder().encode(Redacted.value(secret)),
    new TextEncoder().encode(token),
  ).pipe(Effect.map(Hmac.toHex));

/** How far a token's `iat` may sit in the future (clock skew between instances) before it is rejected. */
const FUTURE_SKEW_SECONDS = 60;
const DEFAULT_MAX_AGE = Duration.hours(24);

/** BEH-EA-075/CDS-006: `<iatSeconds>.<random>.<hmac>` — the whole string is both the cookie value and the required header echo. */
const mint = Effect.fnUntraced(function* (
  crypto: Crypto.Crypto,
  secret: Redacted.Redacted<string>,
  nowSeconds: number,
) {
  const random = Hmac.toHex(yield* crypto.randomBytes(32));
  const signed = `${nowSeconds}.${random}`;
  const signature = yield* sign(crypto, secret, signed);
  return `${signed}.${signature}`;
});

/**
 * `Some(ageSeconds)` for a token whose signature verifies (constant time) and
 * whose age is within `[-skew, maxAgeSeconds]`; `None` for anything else —
 * malformed, forged, tampered `iat` (the HMAC covers it), or expired.
 */
const tokenAge = Effect.fnUntraced(function* (
  crypto: Crypto.Crypto,
  secret: Redacted.Redacted<string>,
  cookieValue: string,
  nowSeconds: number,
  maxAgeSeconds: number,
) {
  const parts = cookieValue.split(".");
  const [iatText, random, signature] = parts;
  if (
    parts.length !== 3 ||
    iatText === undefined ||
    random === undefined ||
    signature === undefined
  ) {
    return Option.none<number>();
  }
  const iat = Number(iatText);
  if (!Number.isSafeInteger(iat)) return Option.none<number>();
  const expected = yield* sign(crypto, secret, `${iatText}.${random}`);
  if (!Hmac.constantTimeEqualString(signature, expected)) return Option.none<number>();
  const age = nowSeconds - iat;
  return age < -FUTURE_SKEW_SECONDS || age > maxAgeSeconds
    ? Option.none<number>()
    : Option.some(age);
});

/**
 * BEH-EA-073/074: `Sec-Fetch-Site` first; `Origin` is the fallback only when
 * that header is entirely absent, never an additional independent check.
 */
const siteCheck = (
  headers: Headers.Headers,
  allowedOrigins: ReadonlyArray<string>,
): Effect.Effect<boolean> =>
  Effect.sync(() => {
    const secFetchSite = Headers.get(headers, "sec-fetch-site");
    if (Option.isSome(secFetchSite)) {
      return secFetchSite.value !== "cross-site";
    }
    const origin = Headers.get(headers, "origin");
    if (Option.isNone(origin)) {
      // Neither header present: nothing to compare against, so this check
      // has nothing to reject on — the double-submit check below still runs.
      return true;
    }
    return allowedOrigins.includes(origin.value);
  });

export const CsrfProtectionLive: Layer.Layer<
  Api.CsrfProtection,
  never,
  CsrfConfig | Crypto.Crypto
> = Layer.effect(
  Api.CsrfProtection,
  Effect.gen(function* () {
    const config = yield* CsrfConfig;
    const crypto = yield* Crypto.Crypto;
    // ACS-007: no composition may sign CSRF tokens with a guessable key.
    yield* Hmac.requireMinSecretBytes(config.secret);
    const maxAgeSeconds = Duration.toSeconds(config.maxAge ?? DEFAULT_MAX_AGE);

    const middleware: HttpApiMiddleware.HttpApiMiddleware<never, typeof Api.CsrfRejected, never> =
      Effect.fnUntraced(function* (httpEffect) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = Headers.get(request.headers, "authorization");
        if (Option.isSome(authorization) && authorization.value.trim().length > 0) {
          return yield* httpEffect;
        }
        const existingCookie = request.cookies[Api.CSRF_COOKIE_NAME];
        const nowSeconds = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
        const age =
          existingCookie === undefined
            ? Option.none<number>()
            : yield* tokenAge(
                crypto,
                config.secret,
                existingCookie,
                nowSeconds,
                maxAgeSeconds,
              ).pipe(Effect.orDie);
        const cookieIsValid = Option.isSome(age);

        // CDS-006: mint when there is no valid token, and proactively once a
        // valid one passes half its life, on safe and unsafe requests alike.
        if (Option.isNone(age) || age.value > maxAgeSeconds / 2) {
          const fresh = yield* mint(crypto, config.secret, nowSeconds).pipe(Effect.orDie);
          // AGA-004: an embedded (`SameSite=None; Partitioned`) session cookie
          // needs its double-submit companion to travel in the same context.
          const cookieMode = SessionCookie.csrfCookieOptions(
            yield* SessionCookie.SessionCookieConfig,
          );
          yield* HttpApiBuilder.securitySetCookie(Api.CsrfCookie, fresh, {
            httpOnly: false,
            path: "/",
            ...cookieMode,
          });
        }

        if (!UNSAFE_METHODS.has(request.method)) {
          return yield* httpEffect;
        }

        const siteOk = yield* siteCheck(request.headers, config.allowedOrigins);
        if (!siteOk) {
          return yield* Effect.fail(new Api.CsrfRejected());
        }

        // BEH-EA-075/077: double-submit — the header must echo the exact,
        // still-valid cookie value already on this request.
        const header = Headers.get(request.headers, Api.CSRF_HEADER_NAME);
        if (
          !cookieIsValid ||
          existingCookie === undefined ||
          Option.isNone(header) ||
          !Hmac.constantTimeEqualString(header.value, existingCookie)
        ) {
          return yield* Effect.fail(new Api.CsrfRejected());
        }

        return yield* httpEffect;
      });

    return middleware;
  }),
);
