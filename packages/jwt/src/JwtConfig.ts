// @awthaq/jwt — JwtConfig
//
// .scratch/jwt/spec.md's own "Config (`JwtConfig`)" decision. Kept in its
// own module, separate from `Jwt.ts`, so `KeyRing.ts` (which needs
// `algorithm`/`keyRotationInterval`/`keyGracePeriod` to mint and rotate
// keys) can import it without creating a cycle once `Jwt.ts` itself starts
// importing `KeyRing.ts` (ticket 08 onward).
//
// `issuer` is deliberately a *required* field with no default — unlike
// every other `Context.Reference`-with-default config this codebase uses
// elsewhere (`AdminConfig`, `RolesConfig`, `OAuthConfig`), `JwtConfig` is a
// plain `Context.Service` with no default value at all, so an application
// that installs `Jwt` without calling `config(...)` fails to compose at
// all, rather than silently shipping an unconfigured `iss` claim — the
// spec's own stricter-than-`OAuthConfig.baseUrl` decision.

import type { Api } from "@awthaq/api";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Algorithm } from "./JwtCodec.ts";

// JJS-003: one `Algorithm` type, owned by `JwtCodec` (which also owns the
// algorithm table); re-exported here for `JwtConfig` consumers.
export type { Algorithm };

export interface JwtConfigShape {
  readonly issuer: string;
  readonly audience: string;
  readonly algorithm: Algorithm;
  /** Modulus length for locally generated RSA keys (RS256/PS256); ignored for other algorithms. */
  readonly rsaModulusLength: number;
  readonly ttl: Duration.Duration;
  readonly keyRotationInterval: Duration.Duration;
  readonly keyGracePeriod: Duration.Duration;
  /** `Cache-Control: max-age` on the served JWKS (ECF-002/KRS-010): how long a verifier may reuse a fetched key set. */
  readonly jwksMaxAge: Duration.Duration;
  /**
   * KRS-006: how long a process may serve its cached signing-key snapshot
   * before re-reading the store, so rotations made by peer processes (or the
   * CLI) reach a busy server. Default 5 minutes.
   */
  readonly keyCacheMaxAge: Duration.Duration;
  /**
   * KRS-006: minimum gap between the forced key refreshes `Jwt.verify` performs
   * when a token names a `kid` the snapshot lacks, so garbage kids cannot turn
   * into a store read per request. Default 30 seconds.
   */
  readonly keyMinRefreshInterval: Duration.Duration;
  /**
   * PDR-003: whether (and for which credentials) a fresh JWT is mirrored onto
   * authenticated responses as `x-jwt-token`. `"off"` (default) never does;
   * `"bearer"` only when the request itself authenticated with a bearer token
   * (an API client that already holds a portable credential); `"always"`
   * also converts cookie-authenticated browser requests, better-auth style.
   * Response headers are a log/proxy/APM capture surface and cross-origin
   * scripts additionally need `Access-Control-Expose-Headers`; the explicit
   * `GET /jwt/token` endpoint is the recommended delivery.
   */
  readonly mirrorResponses: "off" | "bearer" | "always";
  readonly definePayload: (principal: Api.Principal) => Effect.Effect<Record<string, unknown>>;
}

export class JwtConfig extends Context.Service<JwtConfig, JwtConfigShape>()("awthaq/jwt/Config") {}

const emptyPayload: JwtConfigShape["definePayload"] = () => Effect.succeed({});

/**
 * KRS-008: a rotated-out key must keep verifying at least as long as the
 * tokens it signed can live, otherwise routine rotation would invalidate
 * still-valid tokens. A `keyGracePeriod` shorter than `ttl` is a
 * configuration mistake and dies at layer build. (Emergency rotation
 * deliberately passes a zero grace period per call to `KeyRing.rotateNow` —
 * that is not this setting.)
 */
export const config = (
  options: { readonly issuer: string } & Partial<Omit<JwtConfigShape, "issuer">>,
) =>
  Layer.effect(
    JwtConfig,
    Effect.gen(function* () {
      const ttl = options.ttl ?? Duration.minutes(15);
      const keyGracePeriod = options.keyGracePeriod ?? Duration.days(30);
      if (Duration.toMillis(keyGracePeriod) < Duration.toMillis(ttl)) {
        return yield* Effect.die(
          new Error(
            "awthaq/jwt: keyGracePeriod must be at least ttl, or rotating a key would invalidate tokens it signed that have not expired yet",
          ),
        );
      }
      return {
        issuer: options.issuer,
        audience: options.audience ?? options.issuer,
        algorithm: options.algorithm ?? "EdDSA",
        rsaModulusLength: options.rsaModulusLength ?? 2048,
        ttl,
        keyRotationInterval: options.keyRotationInterval ?? Duration.days(90),
        keyGracePeriod,
        jwksMaxAge: options.jwksMaxAge ?? Duration.minutes(10),
        keyCacheMaxAge: options.keyCacheMaxAge ?? Duration.minutes(5),
        keyMinRefreshInterval: options.keyMinRefreshInterval ?? Duration.seconds(30),
        mirrorResponses: options.mirrorResponses ?? "off",
        definePayload: options.definePayload ?? emptyPayload,
      };
    }),
  );
