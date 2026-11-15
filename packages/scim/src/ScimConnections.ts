// @awthaq/scim — ScimConnections
//
// spec/behaviors/30-scim.md, BEH-EA-246. A SCIM *connection* is one organization's
// directory-sync credential: the bearer token its identity provider presents. This
// module is the write side (`ScimConnectionStore`: create / list / revoke — an
// application or an administrator surface calls it) and the read side
// (`ScimAuthenticationLive`: what turns `Authorization: Bearer <token>` into the
// `CurrentScimConnection` every endpoint is scoped by).
//
// The token is `scim_` plus 256 random bits, returned exactly once, at creation;
// only its SHA-256 (`SecretHash`) is stored, so a database read discloses nothing an IdP could
// present. Lookup is by that hash (an indexed equality), followed by a
// constant-time comparison. A revoked connection, a connection whose organization
// no longer exists, and a connection whose organization is suspended
// (`OrganizationRecords`, ADR-EA-018) all authenticate as the same generic 401 an
// unknown token gets — nothing reveals which.

import type { Api } from "@awthaq/api";
import { TenantScoped } from "@awthaq/sql";
import { OrganizationConnectionLifecycle, OrganizationDirectory } from "@awthaq/organization";
import { SecretHash } from "@awthaq/core";
import { Hmac } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type * as HttpApiSecurity from "effect/http-api/HttpApiSecurity";
import type * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as ScimApi from "./ScimApi.ts";
import * as ScimRecords from "./ScimRecords.ts";

const TOKEN_PREFIX = "scim_";

/** The bearer token's hash is the capability: the connection is found before any tenant is known. */
const tokenGrant = TenantScoped.crossTenant("scim: the bearer token hash is the capability");

/** A connection is refused: the organization does not exist or is suspended (`reason` says which rule). */
export class InvalidScimConnection extends Data.TaggedError("InvalidScimConnection")<{
  readonly reason: string;
}> {}

const invalid = (reason: string) => new InvalidScimConnection({ reason });

/**
 * What the connection lifecycle needs to know about SCIM: it claims no email domain (`taken` is never reached) and
 * only ever creates, so no write says "gone". The lifecycle still gives create its gate, the organization lock and
 * the in-lock re-check, so a deletion that commits meanwhile cannot leave a connection behind (F-04-01).
 */
const scimProtocol: OrganizationConnectionLifecycle.ConnectionProtocol<
  InvalidScimConnection,
  InvalidScimConnection
> = {
  protocol: "scim",
  refuse: invalid,
  taken: (domain) => invalid(`"${domain}" is taken`),
  isGone: () => false,
};

/** What a caller sees of a connection: never the token, never its hash. */
export interface ScimConnectionView {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly createdAt: DateTime.Utc;
  readonly revokedAt: Option.Option<DateTime.Utc>;
}

const toView = (record: ScimRecords.ConnectionRecord): ScimConnectionView => ({
  id: record.id,
  organizationId: record.organizationId,
  name: record.name,
  createdAt: record.createdAt,
  revokedAt: record.revokedAt,
});

export interface ScimConnectionStoreShape {
  /** Creates a connection and returns its bearer token — shown once, never recoverable. */
  readonly create: (input: {
    readonly organizationId: string;
    readonly name: string;
  }) => Effect.Effect<
    {
      readonly connection: ScimConnectionView;
      readonly token: Redacted.Redacted<string>;
    },
    InvalidScimConnection | Api.StoreUnavailable
  >;
  readonly list: (
    organizationId: string,
  ) => Effect.Effect<ReadonlyArray<ScimConnectionView>, Api.StoreUnavailable>;
  /** Retires the token; what the connection provisioned stays (its users are ordinary users). Idempotent. */
  readonly revoke: (
    organizationId: string,
    connectionId: string,
  ) => Effect.Effect<ScimConnectionView, ScimRecords.ScimRecordNotFound | Api.StoreUnavailable>;
}

export class ScimConnectionStore extends Context.Service<
  ScimConnectionStore,
  ScimConnectionStoreShape
>()("awthaq/scim/ScimConnectionStore") {}

/** Requires `ScimRecords`, the exposed `OrganizationConnectionLifecycle`, `SecureRandom` and `Digest`. */
export const layerStore = Layer.effect(
  ScimConnectionStore,
  Effect.gen(function* () {
    const records = yield* ScimRecords.ScimRecords;
    const random = yield* SecureRandom.SecureRandom;
    const hasher = yield* Digest.Digest;
    const lifecycle = yield* OrganizationConnectionLifecycle.OrganizationConnectionLifecycle;

    const create: ScimConnectionStoreShape["create"] = (input) =>
      lifecycle.create(
        scimProtocol,
        input.organizationId,
        Effect.gen(function* () {
          const id = yield* random.uuidV7();
          const token = `${TOKEN_PREFIX}${Hmac.toHex(yield* random.randomBytes(32))}`;
          const tokenHash = yield* SecretHash.digest(hasher, token);
          return {
            connectionId: id,
            domains: [],
            write: records
              .createConnection({
                id,
                organizationId: input.organizationId,
                name: input.name.trim(),
                tokenHash,
              })
              .pipe(
                Effect.map((record) => ({
                  connection: toView(record),
                  token: Redacted.make(token),
                })),
              ),
          };
        }),
      );

    const list: ScimConnectionStoreShape["list"] = (organizationId) =>
      records.listConnections(organizationId).pipe(Effect.map((rows) => rows.map(toView)));

    const revoke: ScimConnectionStoreShape["revoke"] = (organizationId, connectionId) =>
      records.revokeConnection(organizationId, connectionId).pipe(Effect.map(toView));

    return ScimConnectionStore.of({ create, list, revoke });
  }),
);

/**
 * BEH-EA-246: bearer authentication for the `scim` group. Requires `ScimRecords`,
 * the exposed `OrganizationDirectory`, `SecureRandom` and `Digest`.
 */
export const ScimAuthenticationLive = Layer.effect(
  ScimApi.ScimAuthentication,
  Effect.gen(function* () {
    const records = yield* ScimRecords.ScimRecords;
    const directory = yield* OrganizationDirectory.OrganizationDirectory;
    const hasher = yield* Digest.Digest;

    const bearer: HttpApiMiddleware.HttpApiMiddlewareSecurity<
      { readonly bearer: typeof HttpApiSecurity.bearer },
      ScimApi.CurrentScimConnection,
      typeof ScimApi.ScimUnauthorized | typeof Api.StoreUnavailable,
      never
    >["bearer"] = (httpEffect, { credential }) =>
      Effect.gen(function* () {
        const presented = Redacted.value(credential);
        if (!presented.startsWith(TOKEN_PREFIX)) return yield* ScimApi.unauthorized();
        const hash = yield* SecretHash.digest(hasher, presented);
        const found = yield* records.findConnectionByTokenHash(tokenGrant, hash);
        if (Option.isNone(found)) return yield* ScimApi.unauthorized();
        const connection = found.value;
        // Constant-time even though the lookup was an equality: no early exit on a partial match.
        const equal = Hmac.constantTimeEqualString(hash, connection.tokenHash);
        if (!equal || Option.isSome(connection.revokedAt)) return yield* ScimApi.unauthorized();
        // BEH-EA-237: an unknown or suspended organization authenticates nothing.
        const organization = yield* directory.findActive(connection.organizationId);
        if (Option.isNone(organization)) return yield* ScimApi.unauthorized();
        return connection;
      }).pipe(
        Effect.flatMap((connection) =>
          Effect.provideService(httpEffect, ScimApi.CurrentScimConnection, {
            id: connection.id,
            organizationId: connection.organizationId,
            name: connection.name,
          }),
        ),
      );

    return { bearer };
  }),
);
