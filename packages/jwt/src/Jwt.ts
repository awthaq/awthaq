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
// whole point of a narrower-scoped delegation credential). Ticket 12
// originally reused `Sessions.list(userId, ...)` — matching the token's
// own `sub`/`sid` claims against a per-user scan — to avoid touching
// `packages/core`. TIR-002/FAMS-009/MAPS-006: that scan was also wrong by
// half the expiry model (`SessionListItem.expiresAt` is only
// `absoluteExpiresAt`; an idle-expired session kept passing this check),
// not just O(sessions-per-user) instead of O(1) — a correctness bug, not
// only a performance one, so it warranted the `packages/core` touch
// ticket 12 deferred: `Sessions.isLive(userId, id)` is a real, keyed,
// tombstone-aware liveness check applying `verify`'s own exact expiry
// logic.

import { Api } from "@awthaq/api";
import { AuthPlugin, Errors, Migrations, Sessions, Tenant, Users } from "@awthaq/core";
import { Defects, RefreshingCache } from "@awthaq/ports";
import { Authentication } from "@awthaq/server";
import * as Arr from "effect/Array";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { IntrospectionResponse, JwtApi, TokenResponse } from "./JwtApi.ts";
import { JwtConfig, type JwtConfigShape } from "./JwtConfig.ts";
import * as JwtCodec from "./JwtCodec.ts";
import * as KeyRing from "./KeyRing.ts";
import * as RevocationStore from "./RevocationStore.ts";

/**
 * VB-005: the header `typ` separating token classes. Principal tokens follow
 * RFC 9068 (`at+jwt`); everything `signJWT` mints is a plain `JWT` unless the
 * caller says otherwise, so an arbitrary payload carrying `sub`/`sid` cannot
 * pass as a principal token.
 */
const PRINCIPAL_TYP = "at+jwt";
const GENERAL_TYP = "JWT";

/** RFC 7662 shape (TIR-001/TRBS-001/MAPS-002): `claims` present iff `active`. */
export type IntrospectionResult =
  | { readonly active: true; readonly claims: Record<string, unknown> }
  | { readonly active: false };

export interface JwtShape {
  /** `options.ttl` overrides `JwtConfig.ttl` for this token (BO-006: the session-mirror cookie's JWT expires with the cookie). */
  readonly sign: (
    principal: Api.Principal,
    options?: { readonly ttl?: Duration.Duration },
  ) => Effect.Effect<string, JwtCodec.JwtInvalidError>;
  readonly verify: (
    token: string,
  ) => Effect.Effect<Record<string, unknown>, JwtCodec.JwtInvalidError>;
  /** Ticket 12: `verify` plus a live check that the token's `sid` still names an unrevoked, unexpired session. The documented, deliberate weakening `verify` alone carries (a revoked session's JWT keeps verifying until its own `exp`) does not apply here. */
  readonly verifyLive: (
    token: string,
  ) => Effect.Effect<
    Record<string, unknown>,
    JwtCodec.JwtInvalidError | Errors.StoreUnavailable,
    Sessions.Sessions
  >;
  /**
   * Ticket 14: arbitrary-payload signing, not tied to any `Principal` — reuses
   * the same key/rotation machinery `sign` does. `options.ttl` overrides
   * `JwtConfig.ttl` for this one call. VB-005: `options.audience` (ticket 33's
   * `signJWT({ audience })`) replaces `JwtConfig.audience` for this token, and
   * the header `typ` is `"JWT"` (override with `options.typ`) so a general-purpose
   * token can never be mistaken for a principal token (`"at+jwt"`) by `verify`,
   * `verifyLive` or `introspect`, whatever claims its payload carries.
   */
  readonly signJWT: (
    payload: Record<string, unknown>,
    options?: {
      readonly ttl?: Duration.Duration;
      readonly audience?: string | ReadonlyArray<string>;
      readonly typ?: string;
    },
  ) => Effect.Effect<string, JwtCodec.JwtInvalidError>;
  /**
   * The general-purpose counterpart of `signJWT` (JJS-007/VB-005): checks
   * issuer, `options.audience` (default `JwtConfig.audience`) and
   * `options.typ` (default `"JWT"`), but — unlike `verify` — does not require a
   * `sub`, so every token `signJWT` can mint is one this can verify.
   */
  readonly verifyJWT: (
    token: string,
    options?: { readonly audience?: string; readonly typ?: string },
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
  ) => Effect.Effect<IntrospectionResult, Errors.StoreUnavailable, Sessions.Sessions>;
  /**
   * TIR-007: what `POST /jwt/introspect` calls. `introspect`, plus the same
   * session-liveness check `introspectLive` runs *whenever `Sessions` was
   * composed alongside `Jwt` at build time* — captured once in `make` through
   * `Effect.serviceOption`, so it keeps `R = never` (dischargeable by
   * `HttpApiBuilder.group`) and `Sessions` still is not a dependency of
   * installing `Jwt`. Without `Sessions` in the composition it is exactly
   * `introspect`. Revoking a session therefore makes every JWT minted from it
   * introspect `active: false` over HTTP at once; bare `verify` (and any
   * bearer re-entry built on it) lags by at most `JwtConfig.ttl`.
   */
  readonly introspectComposed: (token: string) => Effect.Effect<IntrospectionResult, Errors.StoreUnavailable>;
}

/**
 * `sub` always comes from the principal's own ref id, for every principal
 * kind. `sid`/`act` (RFC 8693 §4.1) exist only for a `UserPrincipal` — the
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
          ? // JR-005: RFC 8693 §4.1 identifies the actor by `sub`; the actor's
            // principal type rides along as a private (non-registered) member.
            { act: { sub: principal.actingAs.id, awthaq_actor_type: principal.actingAs.type } }
          : {}),
      }
    : { sub: principal.ref.id };

/**
 * MAPS-001: the inverse of `principalClaims` for the one principal kind a
 * bearer JWT can stand for. `principalClaims` writes `sub` only for a non-User
 * principal (its kind is not in the token), so a token without `sid` cannot be
 * turned back into a principal and fails closed rather than guessing a type.
 */
const UserTokenClaims = Schema.Struct({
  sub: Schema.String,
  sid: Schema.String,
  act: Schema.optional(
    Schema.Struct({ sub: Schema.String, awthaq_actor_type: Schema.optional(Schema.String) }),
  ),
});

const claimsToPrincipal = (claims: Record<string, unknown>) =>
  Schema.decodeUnknownEffect(UserTokenClaims)(claims).pipe(
    Effect.map(
      (decoded) =>
        new Api.UserPrincipal({
          ref: new Api.PrincipalRef({ type: "user", id: decoded.sub }),
          sessionId: decoded.sid,
          ...(decoded.act !== undefined
            ? {
                actingAs: new Api.PrincipalRef({
                  type: decoded.act.awthaq_actor_type ?? "user",
                  id: decoded.act.sub,
                }),
              }
            : {}),
        }),
    ),
    Effect.mapError(() => new Api.Unauthenticated()),
  );

export const JwtHandlers = Layer.mergeAll(
  HttpApiBuilder.group(
    JwtApi,
    "jwt",
    Effect.fnUntraced(function* (handlers) {
      const jwt = yield* Jwt;
      // EP-007: the cache lifetime advertised is the one in force for the request.
      const builtConfig = yield* JwtConfig;
      const configNow = Tenant.configInForce(JwtConfig, builtConfig);
      return handlers.handleAll({
        // ECF-002/KRS-010: a returned `HttpServerResponse` bypasses the
        // success-schema encode, so the body is the plain JWKS document and
        // the header tells verifiers how long they may cache it.
        jwks: () =>
          Effect.gen(function* () {
            const config = yield* configNow;
            const cacheControl = `public, max-age=${Math.floor(Duration.toSeconds(config.jwksMaxAge))}`;
            const document = yield* jwt.jwks;
            return HttpServerResponse.jsonUnsafe(document, {
              headers: { "cache-control": cacheControl },
            });
          }),
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
        // TIR-001/MAPS-002/TIR-007: `introspectComposed`, not
        // `introspectLive` — the latter carries `Sessions` as its own per-call
        // `R`, which this codebase's own established convention (and a
        // genuine `HttpApiBuilder.group` limitation — see `make`'s comment on
        // `revocationStore`) keeps off of every HTTP handler. `Sessions` is
        // captured once in `make` instead, when the app composed it, so this
        // endpoint is the full denylist- and session-liveness-aware RFC 7662
        // path without a per-call requirement.
        introspect: Effect.fnUntraced(function* ({ payload }) {
          const result = yield* jwt.introspectComposed(payload.token);
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
 * (default: a no-op) so a fresh token can mirror onto authenticated
 * responses across every installed plugin — better-auth's `set-auth-jwt`
 * equivalent — with no per-plugin opt-in. PDR-003 (decision: adopted
 * recommended option B): mirroring is a `JwtConfig.mirrorResponses` choice
 * and defaults to `"off"`, because a response header is a log/proxy/APM
 * capture surface and silently converting a cookie session into a portable
 * bearer token is not something a deployment should get by accident.
 * `"bearer"` mirrors only for bearer-authenticated requests, `"always"` also
 * for cookie-authenticated ones; the explicit `POST /jwt/token` endpoint is
 * the recommended delivery either way. Cross-origin JS needs
 * `Access-Control-Expose-Headers: x-jwt-token` to read the header at all.
 *
 * Requires `Jwt` itself, provided via `Layer.provideMerge` against
 * `AuthPlugin.layer(Jwt, {...})` in `Jwt`'s own `static readonly layer`
 * below (first plugin in this codebase to merge a second Layer into its own
 * `static readonly layer`). `decorate`'s own type forces this to never fail
 * the underlying response (`Effect.Effect<HttpServerResponse>`, no error
 * channel): a `sign` failure here is logged and the response is returned
 * unchanged — minting a bonus header must never break an otherwise-
 * successful response, but it must not vanish silently either.
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
    // EP-007: whether and how responses are mirrored is decided per response (see `Jwt.layer`).
    const builtConfig = yield* JwtConfig;
    const configNow = Tenant.configInForce(JwtConfig, builtConfig);
    type HookContext = Parameters<Authentication.PostAuthResponseHookShape["decorate"]>[2];
    const mirrorHeader = (
      principal: Api.Principal,
      response: HttpServerResponse.HttpServerResponse,
      context: HookContext,
      config: JwtConfigShape,
    ) =>
      config.mirrorResponses === "off" ||
      (config.mirrorResponses === "bearer" && context.scheme !== "bearer")
        ? Effect.succeed(response)
        : jwt.sign(principal).pipe(
            Effect.map((token) => HttpServerResponse.setHeader(response, "x-jwt-token", token)),
            Effect.catch((error) =>
              Effect.logWarning("awthaq/jwt: response mirroring failed", error.reason).pipe(
                Effect.as(response),
              ),
            ),
          );
    // BO-006: the opt-in session-mirror cookie — a short-lived JWT copy of a
    // *cookie*-authenticated session (a bearer client has no browser edge to
    // serve). Like the header mirror, a failure to mint never fails the
    // response. It rides every authenticated response, so any API call keeps it
    // fresh; a response that revoked the session (sign-out) still gets one,
    // valid for at most `ttl` — the bounded lag the edge tier documents.
    const mirrorCookie = (
      principal: Api.Principal,
      response: HttpServerResponse.HttpServerResponse,
      context: HookContext,
      config: JwtConfigShape,
    ) => {
      const mirror = config.sessionCookie;
      return mirror === false || context.scheme !== "cookie"
        ? Effect.succeed(response)
        : jwt.sign(principal, { ttl: mirror.ttl }).pipe(
            Effect.flatMap((token) =>
              HttpServerResponse.setCookie(response, mirror.name, token, {
                // Always `__Host-` and strict, whatever `SessionCookieConfig` mode the
                // session cookie itself uses: the edge tier is same-origin by design.
                secure: true,
                httpOnly: true,
                sameSite: "strict",
                path: "/",
                maxAge: mirror.ttl,
              }),
            ),
            Effect.catch((error) =>
              Effect.logWarning(
                "awthaq/jwt: session-mirror cookie failed",
                "reason" in error ? error.reason : error,
              ).pipe(Effect.as(response)),
            ),
          );
    };
    const decorate: Authentication.PostAuthResponseHookShape["decorate"] = (
      principal,
      response,
      context,
    ) =>
      Effect.flatMap(configNow, (config) =>
        mirrorHeader(principal, response, context, config).pipe(
          Effect.flatMap((decorated) => mirrorCookie(principal, decorated, context, config)),
        ),
      );
    return { decorate };
  }),
);

/**
 * MAPS-001/NAM-001 (wayfinder ticket 33): with `JwtConfig.acceptAsBearer`, a
 * principal JWT (`typ: at+jwt`, the class `sign` mints) presented as
 * `Authorization: Bearer` authenticates statelessly: bare `verify`, no session
 * row, so no rotation and a revocation lag bounded by `ttl` (documented in the
 * README). It contributes to `Authentication`'s bearer registry rather than
 * overriding a slot, so `@awthaq/api-key` can claim service tokens next to it.
 * Default off: with the flag unset this layer contributes nothing and a JWT
 * bearer still answers 401. A token the plugin did not mint for this audience
 * (`signJWT({ audience })`, another issuer, another `typ`) fails `verify` and is
 * `Unauthenticated`; it is never retried as a session.
 */
const BearerCredentialContributionLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* JwtConfig;
    if (!config.acceptAsBearer) return Layer.empty;
    const jwt = yield* Jwt;
    // Looked up as an optional service so a deployment that leaves the flag off
    // (the default) never has to provide the registry, and `Jwt.layer`'s own
    // requirements stay what they were. Opting in without one is a wiring
    // mistake that would otherwise silently leave JWT bearers answering 401,
    // so it fails the build instead.
    const registry = yield* Effect.serviceOption(Authentication.CredentialResolvers);
    if (Option.isNone(registry)) {
      return yield* Defects.invalidConfiguration(
        "acceptAsBearer",
        "awthaq/jwt: acceptAsBearer needs Authentication.CredentialResolversLive in the composition",
      );
    }
    return Authentication.contribute("bearer", {
      id: "jwt",
      claims: (raw) =>
        Option.exists(JwtCodec.peekTyp(raw), (typ) => typ.toLowerCase() === PRINCIPAL_TYP),
      resolve: (credential) =>
        jwt.verify(Redacted.value(credential)).pipe(
          Effect.mapError(() => new Api.Unauthenticated()),
          Effect.flatMap(claimsToPrincipal),
        ),
    }).pipe(Layer.provide(Layer.succeed(Authentication.CredentialResolvers, registry.value)));
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
            "publicKeyJwk" TEXT NOT NULL,
            "privateKeyJwk" TEXT,
            "createdAt" TIMESTAMPTZ NOT NULL,
            "rotatedAt" TIMESTAMPTZ,
            "retiresAt" TIMESTAMPTZ
          )`,
        sqlite: () => sql`
          CREATE TABLE jwt_signing_key (
            kid TEXT PRIMARY KEY,
            alg TEXT NOT NULL,
            "publicKeyJwk" TEXT NOT NULL,
            "privateKeyJwk" TEXT,
            "createdAt" TEXT NOT NULL,
            "rotatedAt" TEXT,
            "retiresAt" TEXT
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
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
            "expiresAt" TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE jwt_token_revocation (
            jti TEXT PRIMARY KEY,
            "expiresAt" TEXT NOT NULL
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
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
        CREATE INDEX jwt_signing_key_active_idx ON jwt_signing_key ("createdAt")
        WHERE "rotatedAt" IS NULL`;
    }),
  },
  {
    // JJS-004/KRS-009: at most one current key (`rotatedAt IS NULL`), enforced
    // by the store — every current row indexes the same constant expression,
    // so a second one is a unique violation, which `SigningKeyRecords.create`
    // reports as `CurrentKeyConflict` and `KeyRing` resolves by adopting the
    // winner. Expression + partial unique index: valid on pg and sqlite.
    name: "create_jwt_signing_key_single_current_index",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE UNIQUE INDEX jwt_signing_key_single_current
        ON jwt_signing_key (("rotatedAt" IS NULL))
        WHERE "rotatedAt" IS NULL`;
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
    Layer.mergeAll(PostAuthResponseHookLive, BearerCredentialContributionLive),
    AuthPlugin.layer(Jwt, {
      handlers: JwtHandlers,
      make: Effect.gen(function* () {
        // EP-007 (ADR-EA-018 Decision 8): the token policy — issuer, audience, ttl,
        // `definePayload` — is decided per operation, so a tenant's `Jwt.config(...)` provided in
        // the calling fiber applies to that request; with none, the build-time value applies
        // exactly as before. The signing-key ring (algorithm, rotation, grace, cache) is one
        // deployment-wide store and stays boot-scoped.
        const config = yield* JwtConfig;
        const configNow = Tenant.configInForce(JwtConfig, config);
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
        // TIR-007: present iff the app composed `Sessions` alongside `Jwt`;
        // asking for an *optional* service adds no requirement (`R` stays
        // `never`) and keeps `Jwt.dependsOn` empty.
        const composedSessions = yield* Effect.serviceOption(Sessions.Sessions);

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
        const signClaims = (
          claims: Record<string, unknown>,
          options: {
            readonly typ: string;
            readonly ttl?: Duration.Duration | undefined;
            readonly audience?: string | ReadonlyArray<string> | undefined;
          },
        ) =>
          Effect.gen(function* () {
            const config = yield* configNow;
            const key = yield* currentKey;
            const audience = options.audience ?? config.audience;
            if (typeof audience !== "string" && !Arr.isReadonlyArrayNonEmpty(audience)) {
              return yield* Effect.fail(
                new JwtCodec.JwtInvalidError({ reason: "audience must not be empty" }),
              );
            }
            const now = yield* DateTime.now;
            const iat = Math.floor(DateTime.toEpochMillis(now) / 1000);
            const exp = iat + Math.floor(Duration.toMillis(options.ttl ?? config.ttl) / 1000);
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
                    Defects.invalidConfiguration("remoteSigner", `awthaq/jwt: signing key "${key.kid}" has no local private key material and no RemoteSigner is configured`),
                }),
            });
            return yield* JwtCodec.sign({
              kid: key.kid,
              alg: key.alg,
              typ: options.typ,
              signer,
              claims: { ...claims, iat, exp, jti, iss: config.issuer, aud: audience },
            });
          });

        const sign: JwtShape["sign"] = (principal, options) =>
          Effect.gen(function* () {
            const extra = yield* (yield* configNow).definePayload(principal);
            // `principalClaims` wins over `definePayload`'s extras — a
            // config-supplied payload function may add claims, never
            // override the ones this plugin itself is responsible for.
            return yield* signClaims(
              { ...extra, ...principalClaims(principal) },
              { typ: PRINCIPAL_TYP, ttl: options?.ttl },
            );
          });

        // `definePayload` is principal-scoped (`(principal: Api.Principal) => ...`)
        // and `signJWT` has no principal at all, so it is deliberately not
        // consulted here — there is nothing to call it with. The caller's own
        // `payload` is this method's one input; registered claims still
        // always win over it, via `signClaims`.
        const signJWT: JwtShape["signJWT"] = (payload, options) =>
          signClaims(
            { ...payload },
            { typ: options?.typ ?? GENERAL_TYP, ttl: options?.ttl, audience: options?.audience },
          );

        // JJS-003: the signature algorithm is checked against each key's own
        // `alg` (and this set, the distinct algorithms of the server-side
        // verifiable keys), so keys minted before a `JwtConfig.algorithm`
        // change keep verifying through their grace period.
        //
        // KRS-006: a token naming a `kid` this process's snapshot lacks (a peer
        // just rotated, or a key was imported) triggers one forced,
        // rate-limited re-read of the store and a single retry, so peer-minted
        // keys verify at once instead of after `keyCacheMaxAge`.
        const keyRefresh = yield* RefreshingCache.make(
          Effect.provide(KeyRing.refresh, keyRingAmbient),
          { ttl: config.keyCacheMaxAge, minRefetchInterval: config.keyMinRefreshInterval },
        );
        const verifyWith = (
          token: string,
          expected: {
            readonly typ: string | ReadonlyArray<string>;
            readonly audience: string;
            readonly requireSubject: boolean;
          },
        ) => {
          const attempt = Effect.gen(function* () {
            const config = yield* configNow;
            const keys = yield* verifiableKeys;
            return yield* JwtCodec.verify({
              token,
              keys: keys.map((key) => ({
                kid: key.kid,
                alg: key.alg,
                publicKeyJwk: key.publicKeyJwk,
              })),
              algorithms: Array.from(new Set(keys.map((key) => key.alg))),
              issuer: config.issuer,
              audience: expected.audience,
              expectedTyp: expected.typ,
              requireSubject: expected.requireSubject,
            });
          });
          return attempt.pipe(
            Effect.catchIf(
              (error) => error.reason === "unknown kid",
              () => Effect.andThen(keyRefresh.refreshOnMiss, attempt),
            ),
          );
        };

        // Principal tokens only (`typ: "at+jwt"`, a `sub` is mandatory):
        // what `sign`, `POST /jwt/token` and response mirroring mint.
        const verify: JwtShape["verify"] = (token) =>
          Effect.flatMap(configNow, (config) =>
            verifyWith(token, {
              typ: PRINCIPAL_TYP,
              audience: config.audience,
              requireSubject: true,
            }),
          );

        // JJS-007/VB-005: its own function, not `verify` under another name —
        // a different token class (`typ`), no mandatory `sub`, and a
        // per-call audience matching `signJWT`'s.
        const verifyJWT: JwtShape["verifyJWT"] = (token, options) =>
          Effect.flatMap(configNow, (config) =>
            verifyWith(token, {
              typ: options?.typ ?? GENERAL_TYP,
              audience: options?.audience ?? config.audience,
              requireSubject: false,
            }),
          );

        /**
         * `sid`'s owning session is still a live row, per `Sessions.isLive`
         * (TIR-002/FAMS-009/MAPS-006: a keyed, tombstone-aware lookup
         * applying `Sessions.verify`'s own exact absolute+idle expiry
         * logic — not the single-deadline, full-user-scan check this used
         * to do via `Sessions.list`). Shared by `verifyLive` and
         * `introspectLive` (TIR-001) — one implementation, not two, per
         * this file's own established "reuse, don't duplicate" posture
         * for `verify`/`verifyJWT`.
         */
        const sidStillLiveIn = (sessions: Sessions.SessionsShape, sub: string, sid: string) =>
          sessions.isLive(Users.UserId(sub), Sessions.SessionId(sid));

        const sidStillLive = (sub: string, sid: string) =>
          Effect.flatMap(Sessions.Sessions, (sessions) => sidStillLiveIn(sessions, sub, sid));

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
            const config = yield* configNow;
            const outcome = yield* Effect.result(
              // RFC 7662 introspection answers "is this token live" for either
              // token class; only `verify`/`verifyLive` are principal-only.
              verifyWith(token, {
                typ: [PRINCIPAL_TYP, GENERAL_TYP],
                audience: config.audience,
                requireSubject: false,
              }),
            );
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

        const introspectComposed: JwtShape["introspectComposed"] = (token) =>
          Effect.gen(function* () {
            const result = yield* introspect(token);
            if (!result.active || Option.isNone(composedSessions)) return result;
            const sid = result.claims["sid"];
            const sub = result.claims["sub"];
            if (typeof sid !== "string" || typeof sub !== "string") return result;
            const stillLive = yield* sidStillLiveIn(composedSessions.value, sub, sid);
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
          introspectComposed,
        };
      }),
    }),
  );
}
