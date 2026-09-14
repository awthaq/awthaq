// @awthaq/jwt — Jwt
//
// .scratch/jwt/spec.md. Tickets 08 (sign/verify), 09 (JWKS endpoint), 10
// (mint endpoint), 12 (verifyLive), 14 (general-purpose signJWT/verifyJWT).
//
// `sign`/`verify`/`signJWT`/`verifyJWT` are thin wrappers around
// `JwtCodec.ts` (the shared, `AuthPlugin`-independent claims/verification
// module ticket 13's lite verifier will also depend on) — this file's own
// job is only to supply the plugin-specific inputs `JwtCodec` needs.
//
// `JwtConfig` and the `KeyRing` reference itself are resolved once, at the
// top of `make` — the same "capture once, don't `yield*` a service inside
// a returned closure" architecture ticket 19 of the `Organization` effort
// already learned the hard way (a per-call `yield*` inside a plugin method
// widens that method's own `R`, which `HttpApiBuilder.group`'s
// handler-typing can't discharge via ordinary `Layer.provide`). `sign`/
// `verify`/`jwks` all go through `KeyRing.current`/`KeyRing.verifiable`
// (ticket 11's own rotation-aware accessors) rather than reimplementing
// `ref.get` composition here — their `R` (`KeyRing | JwtConfig`) is
// discharged to `never` once, right here, via `Layer.succeed`s built from
// the two values `make` already yielded; every returned method's own `R`
// stays `never`, matching every other plugin's `Shape` in this codebase.
//
// `verifyLive` is the one deliberate exception to that `R = never`
// convention (ticket 12): it requires `Sessions` directly, not captured in
// `make`, because `Sessions` is not — and must not become — a hard
// dependency of installing `Jwt` at all (`dependsOn: []`; ordinary
// sign/verify/jwks work with zero other plugins installed). It is never
// wired to an HTTP handler, so `HttpApiBuilder.group`'s discharge
// constraint that motivates the `R = never` convention for every other
// method simply doesn't apply to it — a caller invoking `verifyLive`
// provides `Sessions` at their own call site (trivial in practice: any
// app hosting `Jwt` already has `Sessions` in its `Auth.make` composition).
//
// `verifyLive` has no bare id-only session lookup to call — `Sessions`'
// own `verify` needs the full `id.secret` credential, which a JWT never
// carries by design (embedding the session secret in a JWT would let a
// JWT holder also use it as a raw session token elsewhere, defeating the
// whole point of a narrower-scoped delegation credential). Reusing
// `Sessions.list(userId, ...)` — matching the token's own `sub`/`sid`
// claims — and checking for a still-unexpired row with that id is the
// least-invasive way to ask "is this session still live," using only
// capabilities `Sessions` already exposes; ticket 12 was scoped to avoid
// touching `packages/core` (that's ticket 16's own, separately-justified
// core touch), and this achieves the live check without doing so.

import { Api } from "@awthaq/api";
import { AuthPlugin, Sessions, Users } from "@awthaq/core";
import { Authentication } from "@awthaq/server";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { JwksResponse, JwtApi, TokenResponse } from "./JwtApi.ts";
import { JwtConfig } from "./JwtConfig.ts";
import * as JwtCodec from "./JwtCodec.ts";
import * as KeyRing from "./KeyRing.ts";

export interface JwtShape {
  readonly sign: (principal: Api.Principal) => Effect.Effect<string, JwtCodec.JwtInvalidError>;
  readonly verify: (
    token: string,
  ) => Effect.Effect<Record<string, unknown>, JwtCodec.JwtInvalidError>;
  /** Ticket 12: `verify` plus a live check that the token's `sid` still names an unrevoked, unexpired session. The documented, deliberate weakening `verify` alone carries (a revoked session's JWT keeps verifying until its own `exp`) does not apply here. */
  readonly verifyLive: (
    token: string,
  ) => Effect.Effect<Record<string, unknown>, JwtCodec.JwtInvalidError, Sessions.Sessions>;
  /** Ticket 14: arbitrary-payload signing, not tied to any `Principal` — reuses the same key/rotation machinery `sign` does. `options.ttl` overrides `JwtConfig.ttl` for this one call. */
  readonly signJWT: (
    payload: Record<string, unknown>,
    options?: { readonly ttl?: Duration.Duration },
  ) => Effect.Effect<string, JwtCodec.JwtInvalidError>;
  /** Ticket 14: identical checks to `verify` — `verify` never assumed a particular principal shape beyond a present, non-empty `sub`, so this is that same function, not a second implementation. */
  readonly verifyJWT: (
    token: string,
  ) => Effect.Effect<Record<string, unknown>, JwtCodec.JwtInvalidError>;
  readonly jwks: Effect.Effect<{ readonly keys: ReadonlyArray<Record<string, unknown>> }>;
}

/**
 * `sub` always comes from the principal's own ref id, for every principal
 * kind. `sid`/`act` (RFC 8693-style) exist only for a `UserPrincipal` — the
 * only kind `Authentication`'s own `PrincipalResolverLive` ever actually
 * resolves (BEH-EA-069), and the only kind that carries a session/`actingAs`
 * at all; omitted entirely (not `undefined`) for every other principal kind
 * and when `actingAs` is absent, mirroring `PrincipalResolverLive`'s own
 * "omit, don't set undefined" convention.
 */
const principalClaims = (principal: Api.Principal): Record<string, unknown> =>
  principal._tag === "User"
    ? {
        sub: principal.ref.id,
        sid: principal.sessionId,
        ...(principal.actingAs !== undefined
          ? { act: { type: principal.actingAs.type, id: principal.actingAs.id } }
          : {}),
      }
    : { sub: principal.ref.id };

export const JwtHandlers = Layer.mergeAll(
  HttpApiBuilder.group(
    JwtApi,
    "jwt",
    Effect.fnUntraced(function* (handlers) {
      const jwt = yield* Jwt;
      return handlers.handleAll({
        jwks: () => Effect.map(jwt.jwks, (document) => new JwksResponse(document)),
      });
    }),
  ),
  HttpApiBuilder.group(
    JwtApi,
    "jwt.token",
    Effect.fnUntraced(function* (handlers) {
      const jwt = yield* Jwt;
      return handlers.handleAll({
        // `sign`'s own `JwtInvalidError` here can only come from the
        // signing operation itself failing (a WebCrypto import/sign
        // failure) — an infra fault, never something this already-
        // authenticated caller could act on, so it's a defect here rather
        // than a second typed error this endpoint's contract would need to
        // declare alongside `Unauthenticated`.
        mint: Effect.fnUntraced(function* () {
          const principal = yield* Api.CurrentPrincipal;
          const token = yield* jwt.sign(principal).pipe(Effect.orDie);
          return new TokenResponse({ token });
        }),
      });
    }),
  ),
);

/**
 * .scratch/jwt/issues/16-automatic-response-mirroring.md: installing `Jwt`
 * overrides `@awthaq/server`'s `Authentication.PostAuthResponseHook`
 * (default: a no-op) so a fresh token mirrors onto every authenticated
 * response across every installed plugin — better-auth's `set-auth-jwt`
 * equivalent — with no per-plugin opt-in. Requires `Jwt` itself, provided
 * via `Layer.provideMerge` against `AuthPlugin.layer(Jwt, {...})` in
 * `Jwt`'s own `static readonly layer` below (first plugin in this
 * codebase to merge a second Layer into its own `static readonly layer`).
 * `decorate`'s own type forces this to never fail the underlying response
 * (`Effect.Effect<HttpServerResponse>`, no error channel): a `sign`
 * failure here is swallowed via `Effect.catch`, not surfaced — minting
 * a bonus header must never break an otherwise-successful response.
 *
 * Header name `x-jwt-token`: neither `spec/models/08-jwt-bearer.md`'s own
 * sketch nor `.scratch/jwt/spec.md` names one (better-auth's own
 * `set-auth-jwt` isn't reused verbatim — this plugin's contract is its
 * own, not a port).
 */
const PostAuthResponseHookLive = Layer.effect(
  Authentication.PostAuthResponseHook,
  Effect.gen(function* () {
    const jwt = yield* Jwt;
    const decorate: Authentication.PostAuthResponseHookShape["decorate"] = (principal, response) =>
      jwt.sign(principal).pipe(
        Effect.map((token) => HttpServerResponse.setHeader(response, "x-jwt-token", token)),
        Effect.catch(() => Effect.succeed(response)),
      );
    return { decorate };
  }),
);

export class Jwt extends AuthPlugin.Service<Jwt, JwtShape>()("jwt", {
  apiVersion: 1,
  contract: JwtApi,
  tables: ["jwt_signing_key"],
}) {
  static readonly layer = Layer.provideMerge(
    PostAuthResponseHookLive,
    AuthPlugin.layer(Jwt, {
      handlers: JwtHandlers,
      make: Effect.gen(function* () {
        const config = yield* JwtConfig;
        const ref = yield* KeyRing.KeyRing;
        const remoteSigner = yield* JwtCodec.RemoteSigner;

        // Discharges `KeyRing.current`/`KeyRing.verifiable`'s own `R`
        // (`KeyRing | JwtConfig` — ticket 11's rotation-aware accessors) down
        // to `never`, from the two values already yielded above, so every
        // method below stays `R = never` per this file's own convention.
        const keyRingAmbient = Layer.mergeAll(
          Layer.succeed(JwtConfig, config),
          Layer.succeed(KeyRing.KeyRing, ref),
        );
        const currentKey = Effect.provide(KeyRing.current, keyRingAmbient);
        const verifiableKeys = Effect.provide(KeyRing.verifiable, keyRingAmbient);

        /**
         * The shared assembly step `sign` and `signJWT` (ticket 14) both
         * reduce to: sign whatever `claims` the caller already merged
         * together, with `iat`/`exp`/`iss`/`aud` always computed here and
         * always winning over anything already in `claims` — this is the one
         * place those four registered claims are ever set, so neither caller
         * can special-case forgetting them.
         */
        const signClaims = (claims: Record<string, unknown>, ttl?: Duration.Duration) =>
          Effect.gen(function* () {
            const key = yield* currentKey;
            const now = yield* DateTime.now;
            const iat = Math.floor(DateTime.toEpochMillis(now) / 1000);
            const exp = iat + Math.floor(Duration.toMillis(ttl ?? config.ttl) / 1000);
            // A key with local private material (every key ticket 07's `mint`
            // produces) signs via `JwtCodec.localSigner`; one with none (a
            // remote-signing key — ticket 15's `KeyRing.registerRemoteKey`)
            // signs via whatever `RemoteSigner` was configured, or dies with a
            // clear configuration error if none was — a key with no local
            // material and no remote signer configured is a deployment
            // mistake, not a recoverable runtime condition.
            const signer = yield* Option.match(key.privateKeyJwk, {
              onSome: (redacted) => Effect.succeed(JwtCodec.localSigner(Redacted.value(redacted))),
              onNone: () =>
                Option.match(remoteSigner, {
                  onSome: Effect.succeed,
                  onNone: () =>
                    Effect.die(
                      new Error(
                        `awthaq/jwt: signing key "${key.kid}" has no local private key material and no RemoteSigner is configured`,
                      ),
                    ),
                }),
            });
            return yield* JwtCodec.sign({
              kid: key.kid,
              alg: key.alg,
              signer,
              claims: { ...claims, iat, exp, iss: config.issuer, aud: config.audience },
            });
          });

        const sign: JwtShape["sign"] = (principal) =>
          Effect.gen(function* () {
            const extra = yield* config.definePayload(principal);
            // `principalClaims` wins over `definePayload`'s extras — a
            // config-supplied payload function may add claims, never
            // override the ones this plugin itself is responsible for.
            return yield* signClaims({ ...extra, ...principalClaims(principal) });
          });

        // `definePayload` is principal-scoped (`(principal: Api.Principal) => ...`)
        // and `signJWT` has no principal at all, so it is deliberately not
        // consulted here — there is nothing to call it with. The caller's own
        // `payload` is this method's one input; registered claims still
        // always win over it, via `signClaims`.
        const signJWT: JwtShape["signJWT"] = (payload, options) =>
          signClaims({ ...payload }, options?.ttl);

        const verify: JwtShape["verify"] = (token) =>
          Effect.gen(function* () {
            const keys = yield* verifiableKeys;
            return yield* JwtCodec.verify({
              token,
              keys: keys.map((key) => ({
                kid: key.kid,
                alg: key.alg,
                publicKeyJwk: key.publicKeyJwk,
              })),
              algorithm: config.algorithm,
              issuer: config.issuer,
              audience: config.audience,
            });
          });

        // Identical checks to `verify` — it never assumed a particular
        // principal shape beyond a present, non-empty `sub` — so this is
        // that same function, not a second implementation.
        const verifyJWT: JwtShape["verifyJWT"] = verify;

        const verifyLive: JwtShape["verifyLive"] = (token) =>
          Effect.gen(function* () {
            const claims = yield* verify(token);
            const sid = claims["sid"];
            const sub = claims["sub"];
            if (typeof sid !== "string" || typeof sub !== "string") {
              return yield* Effect.fail(
                new JwtCodec.JwtInvalidError({ reason: "no session to live-check" }),
              );
            }
            const sessions = yield* Sessions.Sessions;
            const now = yield* DateTime.now;
            const rows = yield* sessions.list(Users.UserId(sub));
            const stillLive = rows.some(
              (row) =>
                row.id === Sessions.SessionId(sid) &&
                DateTime.toEpochMillis(row.expiresAt) > DateTime.toEpochMillis(now),
            );
            if (!stillLive) {
              return yield* Effect.fail(
                new JwtCodec.JwtInvalidError({ reason: "session no longer live" }),
              );
            }
            return claims;
          });

        const jwks: JwtShape["jwks"] = Effect.map(verifiableKeys, (keys) => ({
          keys: keys.map((key) => key.publicKeyJwk),
        }));

        return { sign, verify, verifyLive, signJWT, verifyJWT, jwks };
      }),
    }),
  );
}
