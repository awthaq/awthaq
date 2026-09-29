// @awthaq/api-key — ApiKey
//
// spec/models/07-api-keys.md, BEH-EA-140/141, ADR-EA-022, wayfinder ticket 10 (OCM-001,
// OCM-002, OCM-005, MAPS-003, MAPS-004). One plugin owns both machine-credential shapes,
// because they serve different callers and folding them into one would be the wrong
// kind of simplicity:
//
// 1. API keys — a long-lived, opaque, show-once secret for CI/scripts/cron that hold one
//    static credential. Format `{prefix}{keyId}.{secret}` (`ak_<uuidv7>.<64 hex>`), the
//    same `id.secret` shape as a session token: `keyId` is the lookup key, only the
//    SHA-256 of the secret is stored (`SecretHash`, shared with `Sessions`), compared in
//    constant time. Presented in the `x-api-key` header, resolved per request to an
//    `ApiKeyPrincipal` carrying the key's own scopes — no signing, no token endpoint, and
//    deliberately no cross-request cache: a revoked or expired key is dead on its next
//    request (TRBS-009).
// 2. `client_credentials` clients (RFC 6749 §4.4) — for service-to-service callers that
//    want a short-lived, cheaply verifiable token instead of presenting a static secret
//    on every call. `POST /api-key/token` verifies the client secret and mints a
//    15-minute JWT through `@awthaq/jwt`'s signer (`typ: "service+jwt"`, `sub:
//    "service:<clientId>"`); verifying it back into a `ServicePrincipal` is a pure
//    signature check, zero database hits. The accepted trade-off, stated plainly: a
//    revoked client blocks *new* tokens at once, but a token already minted lives until
//    its (short) expiry. `packages/oauth` stays a pure client of external IdPs.
//
// **Both are resolved through `@awthaq/server`'s credential-resolver registry**
// (ADR-EA-012), never a new scheme per credential type: keys claim the `apiKey` carrier
// by prefix, service tokens claim the `bearer` carrier by JOSE `typ` (so they never
// collide with `@awthaq/jwt`'s own `at+jwt` principal tokens). Groups that serve machines
// declare `Api.MachineAuthentication`; the user tier never sees these principals.
//
// **Rotation (OCM-005, ADR-EA-022).** `rotate` mints a successor (same name and scopes,
// `rotatedFrom`) and shortens the predecessor's expiry to `now + gracePeriod` (default 24
// hours, bounded by `maxRotationGrace`, default 30 days), so both keys resolve until the
// window ends and then only the successor does. A client holds at most two valid secret
// hashes the same way. `revoke` stays immediate.
//
// **Authorization is not built here** (ADR-EA-009): a principal's `scopes` become qadi
// permissions in `@awthaq/qadi`'s default subject resolver, the one place every
// `SubjectResolver` override delegates to for non-user principals (ADR-EA-012: this plugin
// never claims the exclusive slot). A SCIM directory token is just a key scoped `scim:*`.

import { Api } from "@awthaq/api";
import {
  AuthEvents,
  AuthPlugin,
  ConfigDescriptor,
  Migrations,
  RateLimits,
  SecretHash,
  Users,
} from "@awthaq/core";
import { Jwt, JwtCodec } from "@awthaq/jwt";
import { ClientAddress, Defects, Hmac, RateLimiter } from "@awthaq/ports";
import { Authentication } from "@awthaq/server";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ApiKeyApi from "./ApiKeyApi.ts";
import * as ApiKeyClientRecords from "./ApiKeyClientRecords.ts";
import * as ApiKeyRecords from "./ApiKeyRecords.ts";

// ---- config: a Context.Reference with a default (ADR-EA-011) ---------------------

export interface RateLimit {
  readonly limit: number;
  readonly window: Duration.Duration;
}

export interface ApiKeyConfigShape {
  /** What every key starts with (`ak_` by default): a recognisable, greppable marker for secret scanners. Letters, digits, `_` and `-` only. */
  readonly prefix: string;
  /** A new key's lifetime when the caller names none; unset means keys do not expire by default. */
  readonly defaultExpiresIn?: Duration.Duration | undefined;
  /** The longest lifetime any key may be given. When set, a key created with no expiry gets this one. */
  readonly maxExpiresIn?: Duration.Duration | undefined;
  /** How long a rotated key (or client secret) keeps working beside its successor (ADR-EA-022, default 24 hours). */
  readonly rotationGrace: Duration.Duration;
  /** The longest grace a caller may ask for (default 30 days, mirroring `JwtConfig.keyGracePeriod`). */
  readonly maxRotationGrace: Duration.Duration;
  /**
   * The scopes a key or client may be granted. Unset: any scope string. A user creating
   * their own key is otherwise choosing their own grants, so an application that maps
   * scopes to real permissions should list exactly what it is prepared to hand out.
   */
  readonly grantableScopes?: ReadonlyArray<string> | undefined;
  /** How long a minted service token lives (default 15 minutes): the revocation lag of a revoked client. */
  readonly serviceTokenTtl: Duration.Duration;
  /** The service token's `aud`; unset uses `JwtConfig.audience`, i.e. the token is accepted by this API. */
  readonly serviceTokenAudience?: string | undefined;
  /** `lastUsedAt` is written at most this often per key, so a busy key is not a write per request (default 1 minute). */
  readonly lastUsedGranularity: Duration.Duration;
  /**
   * Per-IP throttle on key resolution (`x-api-key` attempts, valid or not), so a flood of
   * guesses cannot turn into a database read each. Keys carry 256 random bits, so this is
   * flood protection rather than brute-force defence; the default is deliberately high
   * enough for a busy CI runner behind one address. Lower it to tighten.
   */
  readonly resolveRateLimit: RateLimit;
  /** The token endpoint's throttles: per IP, and per `client_id` (the tighter one, bounding secret guessing). */
  readonly tokenRateLimit: { readonly ip: RateLimit; readonly client: RateLimit };
}

const defaultConfig: ApiKeyConfigShape = {
  prefix: "ak_",
  rotationGrace: Duration.hours(24),
  maxRotationGrace: Duration.days(30),
  serviceTokenTtl: Duration.minutes(15),
  lastUsedGranularity: Duration.minutes(1),
  resolveRateLimit: { limit: 3000, window: Duration.minutes(1) },
  tokenRateLimit: {
    ip: { limit: 60, window: Duration.minutes(1) },
    client: { limit: 30, window: Duration.minutes(1) },
  },
};

export const ApiKeyConfig = Context.Reference<ApiKeyConfigShape>("awthaq/api-key/Config", {
  defaultValue: () => defaultConfig,
});

export const config = (partial: Partial<ApiKeyConfigShape>) =>
  Layer.succeed(ApiKeyConfig, { ...defaultConfig, ...partial });

/** ADR-EA-022: the JOSE `typ` of a minted service token, distinct from `@awthaq/jwt`'s `at+jwt` principal tokens. */
export const SERVICE_TOKEN_TYP = "service+jwt";

/** The `sub` prefix of a service token: `service:<clientId>`. */
const SERVICE_SUBJECT_PREFIX = "service:";

// ---- service shape -------------------------------------------------------------

/** What a caller learns about a key: everything except the secret and its hash. */
export interface ApiKeyView {
  readonly id: string;
  readonly name: string;
  readonly start: string;
  readonly scopes: ReadonlyArray<string>;
  readonly createdAt: DateTime.Utc;
  readonly expiresAt: Option.Option<DateTime.Utc>;
  readonly lastUsedAt: Option.Option<DateTime.Utc>;
  readonly revokedAt: Option.Option<DateTime.Utc>;
}

/** `create`/`rotate`: the view plus the one and only copy of the key. */
export interface CreatedApiKey {
  readonly view: ApiKeyView;
  readonly key: Redacted.Redacted<string>;
}

export interface ApiKeyClientView {
  readonly clientId: string;
  readonly name: string;
  readonly scopes: ReadonlyArray<string>;
  readonly createdAt: DateTime.Utc;
  readonly revokedAt: Option.Option<DateTime.Utc>;
}

export interface CreatedClient {
  readonly view: ApiKeyClientView;
  readonly clientSecret: Redacted.Redacted<string>;
}

/** RFC 6749 §5.1, before it is put on the wire. */
export interface IssuedServiceToken {
  readonly accessToken: Redacted.Redacted<string>;
  readonly expiresIn: number;
  readonly scope: ReadonlyArray<string>;
}

export interface ApiKeyShape {
  readonly create: (
    ownerId: Users.UserId,
    input: {
      readonly name: string;
      readonly scopes: ReadonlyArray<string>;
      readonly expiresIn?: Duration.Duration | undefined;
    },
  ) => Effect.Effect<
    CreatedApiKey,
    ApiKeyApi.ApiKeyScopeNotGrantable | ApiKeyApi.ApiKeyLifetimeInvalid
  >;
  readonly list: (ownerId: Users.UserId) => Effect.Effect<ReadonlyArray<ApiKeyView>>;
  /** Immediate. An unknown key and someone else's key are the same `ApiKeyNotFound`. */
  readonly revoke: (
    ownerId: Users.UserId,
    keyId: string,
  ) => Effect.Effect<void, ApiKeyApi.ApiKeyNotFound>;
  /** ADR-EA-022: mints a successor and lets the old key live on for `gracePeriod`. */
  readonly rotate: (
    ownerId: Users.UserId,
    keyId: string,
    options?: {
      readonly gracePeriod?: Duration.Duration | undefined;
      readonly expiresIn?: Duration.Duration | undefined;
    },
  ) => Effect.Effect<CreatedApiKey, ApiKeyApi.ApiKeyNotFound | ApiKeyApi.ApiKeyLifetimeInvalid>;
  /**
   * The per-request resolution: `None` for anything that is not a live key (malformed,
   * unknown id, wrong secret, revoked, expired), indistinguishably. Does the same hash and
   * constant-time compare work whether or not the id exists.
   */
  readonly resolve: (
    presented: Redacted.Redacted<string>,
  ) => Effect.Effect<Option.Option<Api.ApiKeyPrincipal>>;

  readonly registerClient: (
    ownerId: Users.UserId,
    input: { readonly name: string; readonly scopes: ReadonlyArray<string> },
  ) => Effect.Effect<CreatedClient, ApiKeyApi.ApiKeyScopeNotGrantable>;
  readonly listClients: (ownerId: Users.UserId) => Effect.Effect<ReadonlyArray<ApiKeyClientView>>;
  /** Blocks new tokens at once; tokens already minted live until their expiry. */
  readonly revokeClient: (
    ownerId: Users.UserId,
    clientId: string,
  ) => Effect.Effect<void, ApiKeyApi.ApiKeyClientNotFound>;
  /** ADR-EA-022: a new secret; the old one keeps working for `gracePeriod`. At most two secrets are ever valid. */
  readonly rotateClientSecret: (
    ownerId: Users.UserId,
    clientId: string,
    options?: { readonly gracePeriod?: Duration.Duration | undefined },
  ) => Effect.Effect<
    { readonly clientId: string; readonly clientSecret: Redacted.Redacted<string> },
    ApiKeyApi.ApiKeyClientNotFound | ApiKeyApi.ApiKeyLifetimeInvalid
  >;
  /**
   * RFC 6749 §4.4: verifies the client and mints its token. `requestedScope`
   * absent means every registered scope; otherwise the grant is the intersection with
   * the registered scopes, and a request that shares none of them is `InvalidScope`.
   */
  readonly issueServiceToken: (input: {
    readonly clientId: string;
    readonly clientSecret: Redacted.Redacted<string>;
    readonly requestedScope?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<IssuedServiceToken, ApiKeyApi.InvalidClient | ApiKeyApi.InvalidScope>;
}

// ---- helpers --------------------------------------------------------------------

const KEY_MAX_LENGTH = 512;

/** `{prefix}{keyId}.{secret}` -> its two halves, or `None` for anything that is not shaped like a key. */
export const parseKey = (
  raw: string,
  prefix: string,
): Option.Option<{ readonly id: string; readonly secret: string }> => {
  if (raw.length > KEY_MAX_LENGTH || !raw.startsWith(prefix)) return Option.none();
  const rest = raw.slice(prefix.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return Option.none();
  return Option.some({ id: rest.slice(0, dot), secret: rest.slice(dot + 1) });
};

const toView = (record: ApiKeyRecords.ApiKeyRecord): ApiKeyView => ({
  id: record.id,
  name: record.name,
  start: record.start,
  scopes: record.scopes,
  createdAt: record.createdAt,
  expiresAt: record.expiresAt,
  lastUsedAt: record.lastUsedAt,
  revokedAt: record.revokedAt,
});

const toClientView = (record: ApiKeyClientRecords.ApiKeyClientRecord): ApiKeyClientView => ({
  clientId: record.clientId,
  name: record.name,
  scopes: record.scopes,
  createdAt: record.createdAt,
  revokedAt: record.revokedAt,
});

const isPast = (at: DateTime.Utc, now: DateTime.Utc): boolean =>
  DateTime.toEpochMillis(at) <= DateTime.toEpochMillis(now);

/** A key is live when it is neither revoked nor past its expiry. */
const isLive = (record: ApiKeyRecords.ApiKeyRecord, now: DateTime.Utc): boolean =>
  Option.isNone(record.revokedAt) &&
  !Option.exists(record.expiresAt, (expiresAt) => isPast(expiresAt, now));

const dedupe = (scopes: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(scopes)];

const claimsSchema = Schema.Struct({
  sub: Schema.String,
  scope: Schema.String,
});

// ---- migrations (append-only, dialect-branched) -----------------------------------

const apiKeyMigrations: Migrations.Migrations = [
  {
    name: "create_apikey_key",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE apikey_key (
            id TEXT PRIMARY KEY,
            "ownerId" TEXT NOT NULL,
            name TEXT NOT NULL,
            "start" TEXT NOT NULL,
            "secretHash" TEXT NOT NULL,
            scopes TEXT NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL,
            "expiresAt" TIMESTAMPTZ,
            "revokedAt" TIMESTAMPTZ,
            "lastUsedAt" TIMESTAMPTZ,
            "rotatedFrom" TEXT
          )`,
        sqlite: () => sql`
          CREATE TABLE apikey_key (
            id TEXT PRIMARY KEY,
            "ownerId" TEXT NOT NULL,
            name TEXT NOT NULL,
            "start" TEXT NOT NULL,
            "secretHash" TEXT NOT NULL,
            scopes TEXT NOT NULL,
            "createdAt" TEXT NOT NULL,
            "expiresAt" TEXT,
            "revokedAt" TEXT,
            "lastUsedAt" TEXT,
            "rotatedFrom" TEXT
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
      yield* sql`CREATE INDEX apikey_key_owner_idx ON apikey_key ("ownerId", "createdAt")`;
    }),
  },
  {
    name: "create_apikey_client",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE apikey_client (
            "clientId" TEXT PRIMARY KEY,
            "ownerId" TEXT NOT NULL,
            name TEXT NOT NULL,
            scopes TEXT NOT NULL,
            "secretHash" TEXT NOT NULL,
            "previousSecretHash" TEXT,
            "previousExpiresAt" TIMESTAMPTZ,
            "createdAt" TIMESTAMPTZ NOT NULL,
            "revokedAt" TIMESTAMPTZ
          )`,
        sqlite: () => sql`
          CREATE TABLE apikey_client (
            "clientId" TEXT PRIMARY KEY,
            "ownerId" TEXT NOT NULL,
            name TEXT NOT NULL,
            scopes TEXT NOT NULL,
            "secretHash" TEXT NOT NULL,
            "previousSecretHash" TEXT,
            "previousExpiresAt" TEXT,
            "createdAt" TEXT NOT NULL,
            "revokedAt" TEXT
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
      yield* sql`CREATE INDEX apikey_client_owner_idx ON apikey_client ("ownerId", "createdAt")`;
    }),
  },
];

// ---- handlers ----------------------------------------------------------------------

const toDto = (view: ApiKeyView) =>
  new ApiKeyApi.ApiKeyDto({
    id: view.id,
    name: view.name,
    start: view.start,
    scopes: view.scopes,
    createdAt: DateTime.formatIso(view.createdAt),
    expiresAt: Option.match(view.expiresAt, { onNone: () => null, onSome: DateTime.formatIso }),
    lastUsedAt: Option.match(view.lastUsedAt, { onNone: () => null, onSome: DateTime.formatIso }),
    revokedAt: Option.match(view.revokedAt, { onNone: () => null, onSome: DateTime.formatIso }),
  });

const toCreatedDto = (created: CreatedApiKey) =>
  new ApiKeyApi.ApiKeyCreatedDto({ ...toDto(created.view), key: Redacted.value(created.key) });

const toClientDto = (view: ApiKeyClientView) =>
  new ApiKeyApi.ApiKeyClientDto({
    clientId: view.clientId,
    name: view.name,
    scopes: view.scopes,
    createdAt: DateTime.formatIso(view.createdAt),
    revokedAt: Option.match(view.revokedAt, { onNone: () => null, onSome: DateTime.formatIso }),
  });

/** The management groups sit behind `Authentication` (user tier), so the principal is always a `User`. */
const currentUserId = Effect.gen(function* () {
  const principal = yield* Api.CurrentPrincipal;
  if (principal._tag !== "User") {
    return yield* Defects.invariantViolation(
      "NonUserPrincipal",
      `awthaq/api-key: management reached with a non-User principal: ${principal._tag}`,
    );
  }
  return Users.UserId(principal.ref.id);
});

const seconds = (value: number | undefined) =>
  value === undefined ? undefined : Duration.seconds(value);

/** RFC 6749 §2.3.1: `Authorization: Basic base64(urlencode(id):urlencode(secret))`. Malformed in any way is `None`. */
const basicCredentials = (
  header: string | undefined,
): Option.Option<{ readonly clientId: string; readonly clientSecret: string }> => {
  if (header === undefined || !header.toLowerCase().startsWith("basic ")) return Option.none();
  try {
    const bytes = Uint8Array.from(atob(header.slice(6).trim()), (char) => char.charCodeAt(0));
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const colon = decoded.indexOf(":");
    if (colon < 0) return Option.none();
    return Option.some({
      clientId: decodeURIComponent(decoded.slice(0, colon)),
      clientSecret: decodeURIComponent(decoded.slice(colon + 1)),
    });
  } catch {
    return Option.none();
  }
};

export const ApiKeyHandlers = Layer.mergeAll(
  HttpApiBuilder.group(
    ApiKeyApi.ApiKeyApi,
    "apikey",
    Effect.fnUntraced(function* (handlers) {
      const apiKey = yield* ApiKey;
      return handlers.handleAll({
        create: Effect.fnUntraced(function* ({
          payload,
        }: {
          payload: ApiKeyApi.CreateApiKeyPayload;
        }) {
          const owner = yield* currentUserId;
          return toCreatedDto(
            yield* apiKey.create(owner, {
              name: payload.name,
              scopes: payload.scopes ?? [],
              expiresIn: seconds(payload.expiresInSeconds),
            }),
          );
        }),
        list: Effect.fnUntraced(function* () {
          const owner = yield* currentUserId;
          return (yield* apiKey.list(owner)).map(toDto);
        }),
        revoke: Effect.fnUntraced(function* ({ params }: { params: { readonly id: string } }) {
          yield* apiKey.revoke(yield* currentUserId, params.id);
        }),
        rotate: Effect.fnUntraced(function* ({
          params,
          payload,
        }: {
          params: { readonly id: string };
          payload: ApiKeyApi.RotatePayload;
        }) {
          return toCreatedDto(
            yield* apiKey.rotate(yield* currentUserId, params.id, {
              gracePeriod: seconds(payload.gracePeriodSeconds),
              expiresIn: seconds(payload.expiresInSeconds),
            }),
          );
        }),
      });
    }),
  ),
  HttpApiBuilder.group(
    ApiKeyApi.ApiKeyApi,
    "apikey.client",
    Effect.fnUntraced(function* (handlers) {
      const apiKey = yield* ApiKey;
      return handlers.handleAll({
        register: Effect.fnUntraced(function* ({
          payload,
        }: {
          payload: ApiKeyApi.RegisterClientPayload;
        }) {
          const created = yield* apiKey.registerClient(yield* currentUserId, {
            name: payload.name,
            scopes: payload.scopes,
          });
          return new ApiKeyApi.ApiKeyClientCreatedDto({
            ...toClientDto(created.view),
            clientSecret: Redacted.value(created.clientSecret),
          });
        }),
        list: Effect.fnUntraced(function* () {
          return (yield* apiKey.listClients(yield* currentUserId)).map(toClientDto);
        }),
        revoke: Effect.fnUntraced(function* ({
          params,
        }: {
          params: { readonly clientId: string };
        }) {
          yield* apiKey.revokeClient(yield* currentUserId, params.clientId);
        }),
        rotateSecret: Effect.fnUntraced(function* ({
          params,
          payload,
        }: {
          params: { readonly clientId: string };
          payload: ApiKeyApi.RotatePayload;
        }) {
          const rotated = yield* apiKey.rotateClientSecret(yield* currentUserId, params.clientId, {
            gracePeriod: seconds(payload.gracePeriodSeconds),
          });
          return new ApiKeyApi.ApiKeyClientSecretDto({
            clientId: rotated.clientId,
            clientSecret: Redacted.value(rotated.clientSecret),
          });
        }),
      });
    }),
  ),
  HttpApiBuilder.group(
    ApiKeyApi.ApiKeyApi,
    "apikey.token",
    Effect.fnUntraced(function* (handlers) {
      const apiKey = yield* ApiKey;
      const settings = yield* ApiKeyConfig;
      const clientAddress = yield* ClientAddress.ClientAddress;
      const limiter = yield* RateLimiter.RateLimiter;
      const events = yield* AuthEvents.AuthEvents;
      const enforce = (key: string, rule: string, dimension: "ip" | "custom", limit: RateLimit) =>
        RateLimits.enforce({
          key,
          limit: limit.limit,
          window: limit.window,
          meta: { group: "apikey.token", endpoint: "token", rule, dimension },
        }).pipe(
          Effect.provideService(RateLimiter.RateLimiter, limiter),
          Effect.provideService(AuthEvents.AuthEvents, events),
          Effect.catchTag(
            "RateLimitExceeded",
            (error) => new Api.RateLimited({ retryAfterMillis: error.retryAfterMillis }),
          ),
        );
      return handlers.handleAll({
        token: Effect.fnUntraced(function* ({
          payload,
          request,
        }: {
          payload: ApiKeyApi.TokenPayload;
          request: HttpServerRequest.HttpServerRequest;
        }) {
          const address = yield* clientAddress.resolve(request);
          yield* enforce(
            `apikey:token:ip:${Option.getOrElse(address, () => "unknown")}`,
            "token-ip",
            "ip",
            settings.tokenRateLimit.ip,
          );
          if (payload.grant_type !== "client_credentials") {
            return yield* new ApiKeyApi.UnsupportedGrantType();
          }
          // client_secret_basic wins when present (RFC 6749 §2.3: a client must not use more than one method).
          const basic = basicCredentials(
            Option.getOrUndefined(Headers.get(request.headers, "authorization")),
          );
          const credentials = Option.isSome(basic)
            ? basic.value
            : payload.client_id !== undefined && payload.client_secret !== undefined
              ? { clientId: payload.client_id, clientSecret: payload.client_secret }
              : undefined;
          if (credentials === undefined) return yield* new ApiKeyApi.InvalidRequest();
          // Per client id: bounds secret guessing against one client from many addresses.
          yield* enforce(
            `apikey:token:client:${credentials.clientId}`,
            "token-client",
            "custom",
            settings.tokenRateLimit.client,
          );
          const requestedScope =
            payload.scope === undefined
              ? undefined
              : payload.scope.split(" ").filter((scope) => scope !== "");
          const issued = yield* apiKey.issueServiceToken({
            clientId: credentials.clientId,
            clientSecret: Redacted.make(credentials.clientSecret),
            requestedScope,
          });
          return new ApiKeyApi.TokenResponse({
            access_token: Redacted.value(issued.accessToken),
            token_type: "Bearer",
            expires_in: issued.expiresIn,
            scope: issued.scope.join(" "),
          });
        }),
      });
    }),
  ),
);

// ---- the plugin ----------------------------------------------------------------------

/**
 * Registers what a request-path credential resolver needs. Its `resolve` runs inside
 * the request, so it can rate-limit by the caller's address (`ClientAddress`); every
 * other dependency was captured when this layer was built.
 */
const CredentialContributionsLive = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* ApiKey;
    const jwt = yield* Jwt.Jwt;
    const settings = yield* ApiKeyConfig;
    const clientAddress = yield* ClientAddress.ClientAddress;
    const limiter = yield* RateLimiter.RateLimiter;
    const events = yield* AuthEvents.AuthEvents;
    const registry = yield* Authentication.CredentialResolvers;

    const throttle = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const address = yield* clientAddress.resolve(request);
      yield* RateLimits.enforce({
        key: `apikey:resolve:ip:${Option.getOrElse(address, () => "unknown")}`,
        limit: settings.resolveRateLimit.limit,
        window: settings.resolveRateLimit.window,
        meta: { group: "apikey", endpoint: "resolve", rule: "resolve-ip", dimension: "ip" },
      }).pipe(
        Effect.provideService(RateLimiter.RateLimiter, limiter),
        Effect.provideService(AuthEvents.AuthEvents, events),
      );
    });

    const keys = Authentication.contribute("apiKey", {
      id: "apikey.key",
      claims: (raw) => raw.startsWith(settings.prefix),
      resolve: (credential) =>
        throttle.pipe(
          // A throttled address is refused the same way a bad key is: fail closed, never a 429 from a middleware that only declares 401.
          Effect.mapError(() => new Api.Unauthenticated()),
          Effect.flatMap(() => apiKey.resolve(credential)),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new Api.Unauthenticated()),
              onSome: (principal) => Effect.succeed(principal),
            }),
          ),
        ),
    });

    // Service tokens are stateless: a signature/`aud`/`exp`/`typ` check, no database hit.
    const serviceTokens = Authentication.contribute("bearer", {
      id: "apikey.service-token",
      claims: (raw) =>
        Option.exists(JwtCodec.peekTyp(raw), (typ) => typ.toLowerCase() === SERVICE_TOKEN_TYP),
      resolve: (credential) =>
        jwt
          .verifyJWT(Redacted.value(credential), {
            typ: SERVICE_TOKEN_TYP,
            ...(settings.serviceTokenAudience === undefined
              ? {}
              : { audience: settings.serviceTokenAudience }),
          })
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(claimsSchema)),
            Effect.flatMap(({ sub, scope }) =>
              sub.startsWith(SERVICE_SUBJECT_PREFIX) && sub.length > SERVICE_SUBJECT_PREFIX.length
                ? Effect.succeed(
                    new Api.ServicePrincipal({
                      ref: new Api.PrincipalRef({
                        type: "service",
                        id: sub.slice(SERVICE_SUBJECT_PREFIX.length),
                      }),
                      scopes: scope.split(" ").filter((entry) => entry !== ""),
                    }),
                  )
                : Effect.fail(new Api.Unauthenticated()),
            ),
            Effect.mapError(() => new Api.Unauthenticated()),
          ),
    });

    return Layer.mergeAll(keys, serviceTokens).pipe(
      Layer.provide(Layer.succeed(Authentication.CredentialResolvers, registry)),
    );
  }),
);

export class ApiKey extends AuthPlugin.Service<ApiKey, ApiKeyShape>()("apikey", {
  apiVersion: 1,
  contract: ApiKeyApi.ApiKeyApi,
  tables: ["apikey_key", "apikey_client"],
  migrations: apiKeyMigrations,
  // ECS-008/BEH-EA-229: what `doctor` audits and `config list` prints.
  config: [
    ConfigDescriptor.make(ApiKeyConfig, {
      audit: (value, environment) =>
        environment.production && value.grantableScopes === undefined
          ? [
              ConfigDescriptor.finding(
                "warning",
                "apikey-any-scope",
                "grantableScopes is unset: any scope string can be granted to a key or client (list exactly what the application is prepared to hand out)",
              ),
            ]
          : [],
    }),
  ],
}) {
  static readonly layer = Layer.provideMerge(
    CredentialContributionsLive,
    AuthPlugin.layer(ApiKey, {
      // `Jwt` mints the service tokens, and its signing keys must exist first.
      dependsOn: [Jwt.Jwt],
      handlers: ApiKeyHandlers,
      make: Effect.gen(function* () {
        const records = yield* ApiKeyRecords.ApiKeyRecords;
        const clients = yield* ApiKeyClientRecords.ApiKeyClientRecords;
        const settings = yield* ApiKeyConfig;
        const crypto = yield* Crypto.Crypto;
        const events = yield* AuthEvents.AuthEvents;
        const jwt = yield* Jwt.Jwt;
        const rateLimits = yield* RateLimits.RateLimitsRegistry;

        if (!/^[A-Za-z0-9_-]+$/.test(settings.prefix)) {
          return yield* Defects.invalidConfiguration(
            "prefix",
            "awthaq/api-key: prefix may only contain letters, digits, '_' and '-' (a '.' would break the key format)",
          );
        }

        // Only the rules that guard a request path are registered here; both are enforced by
        // the token handler and the credential contribution through `RateLimits.enforce`.
        // The explicit type is the same narrow exception `OAuth.ts`/`Password.ts` document:
        // passing this class to `register` (an `AuthPlugin.Any`, which requires `layer`) from
        // inside its own `static layer` initializer is a real TS circularity.
        const registerRateLimitRules: Effect.Effect<void, RateLimits.RateLimitScopeViolation> =
          rateLimits
            .register(ApiKey, {
              group: "apikey.token",
              endpoint: "token",
              key: "ip",
              limit: settings.tokenRateLimit.ip.limit,
              window: settings.tokenRateLimit.ip.window,
            })
            .pipe(
              Effect.andThen(
                rateLimits.register(ApiKey, {
                  group: "apikey",
                  endpoint: "resolve",
                  key: "ip",
                  limit: settings.resolveRateLimit.limit,
                  window: settings.resolveRateLimit.window,
                }),
              ),
            );
        yield* registerRateLimitRules.pipe(Effect.orDie);

        const randomHex = (bytes: number) =>
          crypto.randomBytes(bytes).pipe(Effect.map(Hmac.toHex), Effect.orDie);

        const grantable = (scopes: ReadonlyArray<string>) => {
          const refused =
            settings.grantableScopes === undefined
              ? []
              : scopes.filter((scope) => !settings.grantableScopes?.includes(scope));
          return refused.length === 0
            ? Effect.void
            : Effect.fail(new ApiKeyApi.ApiKeyScopeNotGrantable({ scopes: refused }));
        };

        /** The lifetime a new key gets: what was asked, else the default, else the maximum; never beyond the maximum. */
        const lifetime = (requested: Duration.Duration | undefined) => {
          const chosen = requested ?? settings.defaultExpiresIn ?? settings.maxExpiresIn;
          if (
            chosen !== undefined &&
            settings.maxExpiresIn !== undefined &&
            Duration.toMillis(chosen) > Duration.toMillis(settings.maxExpiresIn)
          ) {
            return Effect.fail(new ApiKeyApi.ApiKeyLifetimeInvalid());
          }
          return Effect.succeed(chosen);
        };

        const graceOf = (requested: Duration.Duration | undefined) => {
          const grace = requested ?? settings.rotationGrace;
          return Duration.toMillis(grace) > Duration.toMillis(settings.maxRotationGrace)
            ? Effect.fail(new ApiKeyApi.ApiKeyLifetimeInvalid())
            : Effect.succeed(grace);
        };

        /** Mints and stores a key; the plaintext exists only in the returned value. */
        const mint = Effect.fnUntraced(function* (input: {
          readonly ownerId: Users.UserId;
          readonly name: string;
          readonly scopes: ReadonlyArray<string>;
          readonly expiresIn: Duration.Duration | undefined;
          readonly rotatedFrom: Option.Option<string>;
        }) {
          const now = yield* DateTime.now;
          const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
          const secret = yield* randomHex(32);
          const key = `${settings.prefix}${id}.${secret}`;
          const secretHash = yield* SecretHash.digest(crypto, secret).pipe(Effect.orDie);
          const record: ApiKeyRecords.ApiKeyRecord = {
            id,
            ownerId: input.ownerId,
            name: input.name,
            // The head of the credential — prefix and the public id — never any of the secret.
            start: key.slice(0, settings.prefix.length + 8),
            secretHash,
            scopes: input.scopes,
            createdAt: now,
            expiresAt:
              input.expiresIn === undefined
                ? Option.none()
                : Option.some(DateTime.addDuration(now, input.expiresIn)),
            revokedAt: Option.none(),
            lastUsedAt: Option.none(),
            rotatedFrom: input.rotatedFrom,
          };
          yield* records.insert(record);
          return { view: toView(record), key: Redacted.make(key) };
        });

        const ownedKey = Effect.fnUntraced(function* (ownerId: Users.UserId, keyId: string) {
          const found = yield* records.findById(keyId);
          if (Option.isNone(found) || found.value.ownerId !== ownerId) {
            return yield* new ApiKeyApi.ApiKeyNotFound();
          }
          return found.value;
        });

        const create: ApiKeyShape["create"] = Effect.fnUntraced(function* (ownerId, input) {
          const scopes = dedupe(input.scopes);
          yield* grantable(scopes);
          const expiresIn = yield* lifetime(input.expiresIn);
          const created = yield* mint({
            ownerId,
            name: input.name,
            scopes,
            expiresIn,
            rotatedFrom: Option.none(),
          });
          yield* events.publish({
            _tag: "auth.apiKey.created",
            userId: ownerId,
            keyId: created.view.id,
          });
          return created;
        });

        const list: ApiKeyShape["list"] = (ownerId) =>
          records.listByOwner(ownerId).pipe(Effect.map((all) => all.map(toView)));

        const revoke: ApiKeyShape["revoke"] = Effect.fnUntraced(function* (ownerId, keyId) {
          const record = yield* ownedKey(ownerId, keyId);
          const now = yield* DateTime.now;
          yield* records.revoke(record.id, now);
          yield* events.publish({ _tag: "auth.apiKey.revoked", userId: ownerId, keyId: record.id });
        });

        const rotate: ApiKeyShape["rotate"] = Effect.fnUntraced(
          function* (ownerId, keyId, options) {
            const record = yield* ownedKey(ownerId, keyId);
            const now = yield* DateTime.now;
            // Rotating a dead key would resurrect it as a live successor.
            if (!isLive(record, now)) return yield* new ApiKeyApi.ApiKeyNotFound();
            const grace = yield* graceOf(options?.gracePeriod);
            const expiresIn = yield* lifetime(options?.expiresIn);
            const successor = yield* mint({
              ownerId,
              name: record.name,
              scopes: record.scopes,
              expiresIn,
              rotatedFrom: Option.some(record.id),
            });
            // The successor exists before the predecessor starts its countdown, so there is
            // never a moment with no valid key.
            yield* records.limitExpiry(record.id, DateTime.addDuration(now, grace));
            yield* events.publish({
              _tag: "auth.apiKey.rotated",
              userId: ownerId,
              keyId: record.id,
              successorKeyId: successor.view.id,
            });
            return successor;
          },
        );

        const resolve: ApiKeyShape["resolve"] = Effect.fnUntraced(function* (presented) {
          const parsed = parseKey(Redacted.value(presented), settings.prefix);
          // A string that is not shaped like a key costs nothing and says nothing.
          if (Option.isNone(parsed)) return Option.none();
          const { id, secret } = parsed.value;
          const presentedHash = yield* SecretHash.digest(crypto, secret).pipe(Effect.orDie);
          const found = yield* records.findById(id);
          // The same hash and constant-time compare whether or not the id exists (PIL-007).
          const storedHash = Option.match(found, {
            onNone: () => SecretHash.NEVER_MATCHES,
            onSome: (record) => record.secretHash,
          });
          const matches = SecretHash.equals(presentedHash, storedHash);
          if (Option.isNone(found) || !matches) return Option.none();
          const record = found.value;
          const now = yield* DateTime.now;
          if (!isLive(record, now)) return Option.none();
          const stale = Option.match(record.lastUsedAt, {
            onNone: () => true,
            onSome: (usedAt) =>
              DateTime.toEpochMillis(now) - DateTime.toEpochMillis(usedAt) >=
              Duration.toMillis(settings.lastUsedGranularity),
          });
          if (stale) yield* records.touch(record.id, now);
          return Option.some(
            new Api.ApiKeyPrincipal({
              ref: new Api.PrincipalRef({ type: "apikey", id: record.id }),
              scopes: record.scopes,
            }),
          );
        });

        // ---- clients --------------------------------------------------------------

        const mintClientSecret = randomHex(32).pipe(Effect.map((hex) => `cs_${hex}`));

        const registerClient: ApiKeyShape["registerClient"] = Effect.fnUntraced(
          function* (ownerId, input) {
            const scopes = dedupe(input.scopes);
            yield* grantable(scopes);
            const now = yield* DateTime.now;
            const clientId = `svc_${yield* crypto.randomUUIDv7.pipe(Effect.orDie)}`;
            const secret = yield* mintClientSecret;
            const record: ApiKeyClientRecords.ApiKeyClientRecord = {
              clientId,
              ownerId,
              name: input.name,
              scopes,
              secretHash: yield* SecretHash.digest(crypto, secret).pipe(Effect.orDie),
              previousSecretHash: Option.none(),
              previousExpiresAt: Option.none(),
              createdAt: now,
              revokedAt: Option.none(),
            };
            yield* clients.insert(record);
            yield* events.publish({
              _tag: "auth.apiKey.clientRegistered",
              userId: ownerId,
              clientId,
            });
            return { view: toClientView(record), clientSecret: Redacted.make(secret) };
          },
        );

        const listClients: ApiKeyShape["listClients"] = (ownerId) =>
          clients.listByOwner(ownerId).pipe(Effect.map((all) => all.map(toClientView)));

        const ownedClient = Effect.fnUntraced(function* (ownerId: Users.UserId, clientId: string) {
          const found = yield* clients.findById(clientId);
          if (Option.isNone(found) || found.value.ownerId !== ownerId) {
            return yield* new ApiKeyApi.ApiKeyClientNotFound();
          }
          return found.value;
        });

        const revokeClient: ApiKeyShape["revokeClient"] = Effect.fnUntraced(
          function* (ownerId, clientId) {
            const record = yield* ownedClient(ownerId, clientId);
            yield* clients.revoke(record.clientId, yield* DateTime.now);
            yield* events.publish({
              _tag: "auth.apiKey.clientRevoked",
              userId: ownerId,
              clientId: record.clientId,
            });
          },
        );

        const rotateClientSecret: ApiKeyShape["rotateClientSecret"] = Effect.fnUntraced(
          function* (ownerId, clientId, options) {
            const record = yield* ownedClient(ownerId, clientId);
            if (Option.isSome(record.revokedAt)) return yield* new ApiKeyApi.ApiKeyClientNotFound();
            const grace = yield* graceOf(options?.gracePeriod);
            const now = yield* DateTime.now;
            const secret = yield* mintClientSecret;
            yield* clients.rotateSecret({
              clientId: record.clientId,
              secretHash: yield* SecretHash.digest(crypto, secret).pipe(Effect.orDie),
              previousExpiresAt: DateTime.addDuration(now, grace),
            });
            yield* events.publish({
              _tag: "auth.apiKey.clientSecretRotated",
              userId: ownerId,
              clientId: record.clientId,
            });
            return { clientId: record.clientId, clientSecret: Redacted.make(secret) };
          },
        );

        const issueServiceToken: ApiKeyShape["issueServiceToken"] = Effect.fnUntraced(
          function* (input) {
            const presentedHash = yield* SecretHash.digest(
              crypto,
              Redacted.value(input.clientSecret),
            ).pipe(Effect.orDie);
            const found = yield* clients.findById(input.clientId);
            const now = yield* DateTime.now;
            // Both stored hashes are compared every time, found or not: what differs between a
            // wrong secret, a rotated-out secret and an unknown client is not observable.
            const currentHash = Option.match(found, {
              onNone: () => SecretHash.NEVER_MATCHES,
              onSome: (record) => record.secretHash,
            });
            const previousHash = Option.match(found, {
              onNone: () => SecretHash.NEVER_MATCHES,
              onSome: (record) =>
                Option.getOrElse(record.previousSecretHash, () => SecretHash.NEVER_MATCHES),
            });
            const matchesCurrent = SecretHash.equals(presentedHash, currentHash);
            const matchesPrevious = SecretHash.equals(presentedHash, previousHash);
            if (Option.isNone(found)) return yield* new ApiKeyApi.InvalidClient();
            const client = found.value;
            const previousStillValid = Option.exists(
              client.previousExpiresAt,
              (expiresAt) => !isPast(expiresAt, now),
            );
            const secretOk = matchesCurrent || (matchesPrevious && previousStillValid);
            if (!secretOk || Option.isSome(client.revokedAt)) {
              return yield* new ApiKeyApi.InvalidClient();
            }
            const requested = input.requestedScope;
            const granted =
              requested === undefined || requested.length === 0
                ? client.scopes
                : client.scopes.filter((scope) => requested.includes(scope));
            if (granted.length === 0 && client.scopes.length > 0) {
              return yield* new ApiKeyApi.InvalidScope();
            }
            const token = yield* jwt
              .signJWT(
                {
                  sub: `${SERVICE_SUBJECT_PREFIX}${client.clientId}`,
                  client_id: client.clientId,
                  scope: granted.join(" "),
                },
                {
                  ttl: settings.serviceTokenTtl,
                  typ: SERVICE_TOKEN_TYP,
                  ...(settings.serviceTokenAudience === undefined
                    ? {}
                    : { audience: settings.serviceTokenAudience }),
                },
              )
              .pipe(Effect.orDie);
            return {
              accessToken: Redacted.make(token),
              expiresIn: Math.floor(Duration.toSeconds(settings.serviceTokenTtl)),
              scope: granted,
            };
          },
        );

        return ApiKey.of({
          create,
          list,
          revoke,
          rotate,
          resolve,
          registerClient,
          listClients,
          revokeClient,
          rotateClientSecret,
          issueServiceToken,
        });
      }),
    }),
  );
}
