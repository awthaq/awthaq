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

export type Algorithm = "EdDSA" | "ES256";

export interface JwtConfigShape {
  readonly issuer: string;
  readonly audience: string;
  readonly algorithm: Algorithm;
  readonly ttl: Duration.Duration;
  readonly keyRotationInterval: Duration.Duration;
  readonly keyGracePeriod: Duration.Duration;
  /** `Cache-Control: max-age` on the served JWKS (ECF-002/KRS-010): how long a verifier may reuse a fetched key set. */
  readonly jwksMaxAge: Duration.Duration;
  readonly definePayload: (principal: Api.Principal) => Effect.Effect<Record<string, unknown>>;
}

export class JwtConfig extends Context.Service<JwtConfig, JwtConfigShape>()("awthaq/jwt/Config") {}

const emptyPayload: JwtConfigShape["definePayload"] = () => Effect.succeed({});

export const config = (
  options: { readonly issuer: string } & Partial<Omit<JwtConfigShape, "issuer">>,
) =>
  Layer.succeed(JwtConfig, {
    issuer: options.issuer,
    audience: options.audience ?? options.issuer,
    algorithm: options.algorithm ?? "EdDSA",
    ttl: options.ttl ?? Duration.minutes(15),
    keyRotationInterval: options.keyRotationInterval ?? Duration.days(90),
    keyGracePeriod: options.keyGracePeriod ?? Duration.days(30),
    jwksMaxAge: options.jwksMaxAge ?? Duration.minutes(10),
    definePayload: options.definePayload ?? emptyPayload,
  });
