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
import { AuthPlugin, Migrations, Sessions, Users } from "@awthaq/core";
import { Authentication } from "@awthaq/server";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { IntrospectionResponse, JwksResponse, JwtApi, TokenResponse } from "./JwtApi.ts";
import { JwtConfig } from "./JwtConfig.ts";
import * as JwtCodec from "./JwtCodec.ts";
import * as KeyRing from "./KeyRing.ts";
import * as RevocationStore from "./RevocationStore.ts";

/** RFC 7662 shape (TIR-001/TRBS-001/MAPS-002): `claims` present iff `active`. */
export type IntrospectionResult =
  | { readonly active: true; readonly claims: Record<string, unknown> }
  | { readonly active: false };

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
  /**
   * TIR-001/MAPS-002: `verify` plus a denylist lookup by the token's own
   * `jti` — the RFC 7662-shaped path for a caller that needs freshness
   * `verify` alone deliberately doesn't offer. `RevocationStore` is
   * captured once in `make` (this file's own convention for every method
   * but `verifyLive`), so this stays `R = never` and is safely wired to
   * the `/jwt/introspect` handler below. A token with no `jti` (minted
   * before this claim existed, or foreign) simply can't be denylisted and
   * is treated as not revoked.
   */
  readonly introspect: (token: string) => Effect.Effect<IntrospectionResult>;
  /**
   * TIR-001: `introspect` plus, when the token carries a `sid`, the same
   * session-liveness check `verifyLive` runs — a superset, reusing its
   * logic rather than duplicating it. `Sessions` is a per-call `R`, not
   * captured in `make` — the same deliberate exception `verifyLive`
   * itself already is, and for the same reason: `Sessions` must not
   * become a hard dependency of installing `Jwt` at all. Also mirrors
   * `verifyLive` in never being wired to an HTTP handler — `Effect`'s own
   * `HttpApiBuilder.group` has no way to discharge a handler's own extra,
   * un-captured `R` via ordinary `Layer.provide` (see `make`'s own
   * comment on `revocationStore`), so `/jwt/introspect` calls `introspect`
   * alone; a caller wanting the live-session check calls this directly.
   */
  readonly introspectLive: (
    token: string,
  ) => Effect.Effect<IntrospectionResult, never, Sessions.Sessions>;
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
        // TIR-001/MAPS-002: `introspect`, not `introspectLive` — the
        // latter carries `Sessions` as its own per-call `R`, exactly like
        // `verifyLive`, which this codebase's own established convention
        // (and a genuine `HttpApiBuilder.group` limitation — see `make`'s
        // comment on `revocationStore`) keeps off of every HTTP handler.
        // This endpoint is still the full denylist-aware RFC 7662 path
        // TIR-001/MAPS-002 ask for; a caller that also wants the
        // live-session check calls `jwt.introspectLive` directly (the
        // in-process API), the same way `jwt.verifyLive` already works.
        introspect: Effect.fnUntraced(function* ({ payload }) {
          const result = yield* jwt.introspect(payload.token);
          return new IntrospectionResponse(
            result.active ? { active: true, claims: result.claims } : { active: false },
          );
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

/**
 * .scratch/resolve-ready-for-human-findings/issues/11-token-lifecycle-store.md:
 * no production migration existed anywhere for `jwt_signing_key` before
 * this — only `KeyRing.test.ts`'s own inline `CREATE TABLE` for that
 * test's ad hoc setup — a pre-existing gap this closes in passing, since
 * this is the first migration this plugin declares at all (no plugin in
 * this codebase populated `migrations` before now — `Migrations.ts`'s own
 * header comment). `jwt_token_revocation` is `RevocationStore.layerSql`'s
 * own table (TRBS-001/TIR-001/MAPS-002). Dialect-branched via
 * `sql.onDialectOrElse`, mirroring `@awthaq/sql`'s own `CoreMigrations.ts`
 * — one definition, not two duplicated schema files. Columns left
 * unquoted under `pg` (unlike `CoreMigrations.ts`'s `users`/`sessions`
 * tables): `SigningKeyRecords.ts`'s own queries already reference every
 * column unquoted, so Postgres's automatic lowercase-folding is what
 * keeps migration and query consistent here, not literal camelCase
 * preservation.
 */
const jwtMigrations: Migrations.Migrations = [
  {
    name: "create_jwt_signing_key",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE jwt_signing_key (
            kid TEXT PRIMARY KEY,
            alg TEXT NOT NULL,
            publicKeyJwk TEXT NOT NULL,
            privateKeyJwk TEXT,
            createdAt TIMESTAMPTZ NOT NULL,
            rotatedAt TIMESTAMPTZ,
            retiresAt TIMESTAMPTZ
          )`,
        sqlite: () => sql`
          CREATE TABLE jwt_signing_key (
            kid TEXT PRIMARY KEY,
            alg TEXT NOT NULL,
            publicKeyJwk TEXT NOT NULL,
            privateKeyJwk TEXT,
            createdAt TEXT NOT NULL,
            rotatedAt TEXT,
            retiresAt TEXT
          )`,
        orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
      });
    }),
  },
  {
    name: "create_jwt_token_revocation",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE jwt_token_revocation (
            jti TEXT PRIMARY KEY,
            expiresAt TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE jwt_token_revocation (
            jti TEXT PRIMARY KEY,
            expiresAt TEXT NOT NULL
          )`,
        orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
      });
    }),
  },
  {
    // SSMS-001's own recommended fix: `findCurrent`
    // (`SigningKeyRecords.ts`) runs `WHERE rotatedAt IS NULL ORDER BY
    // createdAt DESC LIMIT 1` on every lazy key mint — a partial index
    // keeps that scan proportional to the (small, O(active keys)) live
    // set rather than the whole key-history table. Both pg and sqlite
    // (>= 3.8.0) support partial indexes with this exact syntax.
    name: "create_jwt_signing_key_active_index",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE INDEX jwt_signing_key_active_idx ON jwt_signing_key (createdAt)
        WHERE rotatedAt IS NULL`;
    }),
  },
];

export class Jwt extends AuthPlugin.Service<Jwt, JwtShape>()("jwt", {
  apiVersion: 1,
  contract: JwtApi,
  tables: ["jwt_signing_key", "jwt_token_revocation"],
  migrations: jwtMigrations,
}) {
  static readonly layer = Layer.provideMerge(
    PostAuthResponseHookLive,
    AuthPlugin.layer(Jwt, {
      handlers: JwtHandlers,
      make: Effect.gen(function* () {
        const config = yield* JwtConfig;
        const ref = yield* KeyRing.KeyRing;
        const remoteSigner = yield* JwtCodec.RemoteSigner;
        const crypto = yield* Crypto.Crypto;
        // Captured here, not left as `introspect`'s own per-call `R` the
        // way `verifyLive`'s `Sessions` is: `introspect` is wired to the
        // `/jwt/introspect` handler below, and `HttpApiBuilder.group`
        // wraps any `R` a handler references that ISN'T already captured
        // in `make` into an internal `Request.From<"Requires", R>` marker
        // that ordinary `Layer.provide`/`provideMerge` cannot discharge
        // (only `HttpRouter.provideRequest` can — the exact mechanism
        // `verifyLive`'s own header comment sidesteps entirely by simply
        // never being wired to a handler). Capturing `RevocationStore`
        // here, the same way `config`/`ref` are, keeps `introspect`'s own
        // `R = never` and the handler ordinarily dischargeable — matching
        // every other plugin method's convention.
        const revocationStore = yield* RevocationStore.RevocationStore;

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
            // TRBS-001/TIR-001: every minted token gets a UUIDv7 `jti`,
            // this codebase's established UUIDv7-for-identifiers convention
            // (`Sessions.issue`/`Users.create` mint their own ids the same
            // way) — the handle `RevocationStore`/`introspect` key a
            // denylist entry by.
            const jti = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
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
              claims: { ...claims, iat, exp, jti, iss: config.issuer, aud: config.audience },
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

        /**
         * `sid`'s owning session is still a live row in `Sessions.list`.
         * Shared by `verifyLive` and `introspectLive` (TIR-001) — one
         * implementation, not two, per this file's own established
         * "reuse, don't duplicate" posture for `verify`/`verifyJWT`.
         */
        const sidStillLive = (sub: string, sid: string) =>
          Effect.gen(function* () {
            const sessions = yield* Sessions.Sessions;
            const now = yield* DateTime.now;
            const rows = yield* sessions.list(Users.UserId(sub));
            return rows.some(
              (row) =>
                row.id === Sessions.SessionId(sid) &&
                DateTime.toEpochMillis(row.expiresAt) > DateTime.toEpochMillis(now),
            );
          });

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
            const stillLive = yield* sidStillLive(sub, sid);
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

        const introspect: JwtShape["introspect"] = (token) =>
          Effect.gen(function* () {
            const outcome = yield* Effect.result(verify(token));
            if (Result.isFailure(outcome)) return { active: false };
            const claims = outcome.success;
            const jti = claims["jti"];
            // A token with no `jti` (minted before this claim existed, or
            // foreign) simply can't be denylisted — not the uniform
            // "reject anything unusual" the rest of this collapse applies
            // to, since it's the expected shape for anything predating
            // this ticket.
            if (typeof jti === "string") {
              const revoked = yield* revocationStore.isRevoked(jti);
              if (revoked) return { active: false };
            }
            return { active: true, claims };
          });

        const introspectLive: JwtShape["introspectLive"] = (token) =>
          Effect.gen(function* () {
            const result = yield* introspect(token);
            if (!result.active) return result;
            const sid = result.claims["sid"];
            const sub = result.claims["sub"];
            if (typeof sid !== "string" || typeof sub !== "string") return result;
            const stillLive = yield* sidStillLive(sub, sid);
            return stillLive ? result : { active: false };
          });

        return {
          sign,
          verify,
          verifyLive,
          signJWT,
          verifyJWT,
          jwks,
          introspect,
          introspectLive,
        };
      }),
    }),
  );
}
