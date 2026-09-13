// @awthaq/server — CSRF protection
//
// spec/behaviors/10-csrf.md, BEH-EA-073 through BEH-EA-080. Implements
// `@awthaq/api`'s `CsrfProtection` declaration: `Sec-Fetch-Site` first,
// `Origin` fallback, backed by a signed double-submit `__Host-csrf` cookie —
// all three compose (BEH-EA-075 "backs", not replaces, the site check).

import { Api } from "@awthaq/api";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import { HttpApiBuilder, HttpApiMiddleware } from "effect/unstable/httpapi";
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

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a.codePointAt(i) ?? 0) ^ (b.codePointAt(i) ?? 0);
  return diff === 0;
};

const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

const SHA256_BLOCK_SIZE = 64;

/**
 * BEH-EA-075: HMAC-SHA256 (RFC 2104) built directly from `Crypto.digest`,
 * since the platform-neutral `Crypto` service exposes only plain digests,
 * not a keyed-MAC primitive.
 */
const hmacSha256: (
  crypto: Crypto.Crypto,
  key: Uint8Array,
  message: Uint8Array,
) => Effect.Effect<Uint8Array, PlatformError.PlatformError> = Effect.fnUntraced(
  function* (crypto, key, message) {
    let blockKey = key.length > SHA256_BLOCK_SIZE ? yield* crypto.digest("SHA-256", key) : key;
    if (blockKey.length < SHA256_BLOCK_SIZE) {
      const padded = new Uint8Array(SHA256_BLOCK_SIZE);
      padded.set(blockKey);
      blockKey = padded;
    }
    const ipad = new Uint8Array(SHA256_BLOCK_SIZE);
    const opad = new Uint8Array(SHA256_BLOCK_SIZE);
    for (let i = 0; i < SHA256_BLOCK_SIZE; i++) {
      const keyByte = blockKey[i] ?? 0;
      ipad[i] = keyByte ^ 0x36;
      opad[i] = keyByte ^ 0x5c;
    }
    const inner = yield* crypto.digest("SHA-256", concatBytes(ipad, message));
    return yield* crypto.digest("SHA-256", concatBytes(opad, inner));
  },
);

const sign = (crypto: Crypto.Crypto, secret: Redacted.Redacted<string>, token: string) =>
  hmacSha256(
    crypto,
    new TextEncoder().encode(Redacted.value(secret)),
    new TextEncoder().encode(token),
  ).pipe(Effect.map(toHex));

/** BEH-EA-075: `<token>.<hmac-signature>` — the whole string is both the cookie value and the required header echo. */
const mint = Effect.fnUntraced(function* (
  crypto: Crypto.Crypto,
  secret: Redacted.Redacted<string>,
) {
  const token = toHex(yield* crypto.randomBytes(32));
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
  return constantTimeEqual(signature, expected);
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
          !constantTimeEqual(header.value, existingCookie)
        ) {
          return yield* Effect.fail(new Api.CsrfRejected());
        }

        return yield* httpEffect;
      });

    return middleware;
  }),
);
