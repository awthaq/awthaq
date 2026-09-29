// @awthaq/server — CSRF protection
//
// spec/behaviors/10-csrf.md, BEH-EA-073 through BEH-EA-080. Implements
// `@awthaq/api`'s `CsrfProtection` declaration: `Sec-Fetch-Site` first,
// `Origin` fallback, backed by a signed double-submit `__Host-csrf` cookie —
// all three compose (BEH-EA-075 "backs", not replaces, the site check).
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
import { Hmac } from "@awthaq/ports";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
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

/** BEH-EA-075: `<token>.<hmac-signature>` — the whole string is both the cookie value and the required header echo. */
const mint = Effect.fnUntraced(function* (
  crypto: Crypto.Crypto,
  secret: Redacted.Redacted<string>,
) {
  const token = Hmac.toHex(yield* crypto.randomBytes(32));
  const signature = yield* sign(crypto, secret, token);
  return `${token}.${signature}`;
});

const isValid = Effect.fnUntraced(function* (
  crypto: Crypto.Crypto,
  secret: Redacted.Redacted<string>,
  cookieValue: string,
) {
  const separator = cookieValue.indexOf(".");
  if (separator < 0) return false;
  const token = cookieValue.slice(0, separator);
  const signature = cookieValue.slice(separator + 1);
  const expected = yield* sign(crypto, secret, token);
  return Hmac.constantTimeEqualString(signature, expected);
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

    const middleware: HttpApiMiddleware.HttpApiMiddleware<never, typeof Api.CsrfRejected, never> =
      Effect.fnUntraced(function* (httpEffect) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = Headers.get(request.headers, "authorization");
        if (Option.isSome(authorization) && authorization.value.trim().length > 0) {
          return yield* httpEffect;
        }
        const existingCookie = request.cookies[Api.CSRF_COOKIE_NAME];
        const cookieIsValid =
          existingCookie !== undefined &&
          (yield* isValid(crypto, config.secret, existingCookie).pipe(Effect.orDie));

        if (!cookieIsValid) {
          const fresh = yield* mint(crypto, config.secret).pipe(Effect.orDie);
          yield* HttpApiBuilder.securitySetCookie(Api.CsrfCookie, fresh, {
            httpOnly: false,
            sameSite: "strict",
            path: "/",
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
