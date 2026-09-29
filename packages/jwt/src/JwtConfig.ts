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
import { SESSION_MIRROR_COOKIE_NAME } from "./verify.ts";

// JJS-003: one `Algorithm` type, owned by `JwtCodec` (which also owns the
// algorithm table); re-exported here for `JwtConfig` consumers.
export type { Algorithm };

export interface SessionMirrorCookie {
  /** Must carry the `__Host-` prefix (`Secure`, `Path=/`, no `Domain`, so a sibling subdomain cannot toss one). */
  readonly name: string;
  /** How long the cookie — and the JWT inside it — stays valid: the revocation lag the edge tier accepts. */
  readonly ttl: Duration.Duration;
}

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
  /**
   * BO-006/ADR D1 option C: an opt-in, short-lived JWT copy of the session
   * (`false`, the default, mints nothing). When on, every cookie-authenticated
   * response also carries this `__Host-` cookie — `HttpOnly`, `Secure`,
   * `SameSite=Strict`, its JWT expiring with the cookie — so an edge
   * `proxy.ts`/middleware can verify it statelessly (`@awthaq/next/edge`)
   * instead of only checking that the opaque session cookie exists. It is a
   * better *redirect signal*, never the authorization boundary: a revoked
   * session's copy keeps verifying for at most `ttl`, and only a
   * database-verified `getSession` decides access (BEH-EA-188).
   */
  readonly sessionCookie: false | SessionMirrorCookie;
  /**
   * MAPS-001/NAM-001 (wayfinder ticket 33): whether a principal JWT this plugin
   * minted (`GET /jwt/token`, the response mirror) is also accepted as a
   * *bearer credential* by this API's `Authentication`, verified statelessly
   * (`verify`, no session-store hit). Default `false`: installing `Jwt` mints a
   * delegation token meant for downstream services, and quietly making that
   * same token a valid origin credential would widen what a leaked or
   * propagated token can do. On, a revoked session's JWT keeps authenticating
   * until its own `exp`, so the revocation lag is bounded by `ttl`. A token
   * minted with `signJWT(payload, { audience })` for a downstream service never
   * re-enters (its `aud` is not this API's).
   */
  readonly acceptAsBearer: boolean;
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
  options: { readonly issuer: string } & Partial<
    Omit<JwtConfigShape, "issuer" | "sessionCookie">
  > & {
      /** BO-006: `true` for the defaults (`SESSION_MIRROR_COOKIE_NAME`, 5 minutes), or override either. */
      readonly sessionCookie?: boolean | Partial<SessionMirrorCookie>;
    },
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
      const sessionCookie = options.sessionCookie ?? false;
      const mirror =
        sessionCookie === false
          ? false
          : {
              name:
                (sessionCookie === true ? undefined : sessionCookie.name) ??
                SESSION_MIRROR_COOKIE_NAME,
              ttl: (sessionCookie === true ? undefined : sessionCookie.ttl) ?? Duration.minutes(5),
            };
      if (mirror !== false && !mirror.name.startsWith("__Host-")) {
        return yield* Effect.die(
          new Error(
            "awthaq/jwt: sessionCookie.name must start with __Host- (Secure, Path=/, no Domain)",
          ),
        );
      }
      if (mirror !== false && Duration.toMillis(mirror.ttl) <= 0) {
        return yield* Effect.die(new Error("awthaq/jwt: sessionCookie.ttl must be positive"));
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
        sessionCookie: mirror,
        acceptAsBearer: options.acceptAsBearer ?? false,
        definePayload: options.definePayload ?? emptyPayload,
      };
    }),
  );
