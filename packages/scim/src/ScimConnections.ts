// @awthaq/scim — ScimConnections
//
// spec/behaviors/30-scim.md, BEH-EA-241. A SCIM *connection* is one organization's
// directory-sync credential: the bearer token its identity provider presents. This
// module is the write side (`ScimConnectionStore`: create / list / revoke — an
// application or an administrator surface calls it) and the read side
// (`ScimAuthenticationLive`: what turns `Authorization: Bearer <token>` into the
// `CurrentScimConnection` every endpoint is scoped by).
//
// The token is `scim_` plus 256 random bits, returned exactly once, at creation;
// only its SHA-256 is stored, so a database read discloses nothing an IdP could
// present. Lookup is by that hash (an indexed equality), followed by a
// constant-time comparison. A revoked connection, a connection whose organization
// no longer exists, and a connection whose organization is suspended
// (`OrganizationRecords`, ADR-EA-018) all authenticate as the same generic 401 an
// unknown token gets — nothing reveals which.

import { ConstantTime } from "@awthaq/core";
import { OrganizationRecords } from "@awthaq/organization";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";
import type * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as ScimApi from "./ScimApi.ts";
import * as ScimRecords from "./ScimRecords.ts";

const TOKEN_PREFIX = "scim_";

const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

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
  }) => Effect.Effect<{
    readonly connection: ScimConnectionView;
    readonly token: Redacted.Redacted<string>;
  }>;
  readonly list: (organizationId: string) => Effect.Effect<ReadonlyArray<ScimConnectionView>>;
  /** Retires the token; what the connection provisioned stays (its users are ordinary users). Idempotent. */
  readonly revoke: (
    organizationId: string,
    connectionId: string,
  ) => Effect.Effect<ScimConnectionView, ScimRecords.ScimRecordNotFound>;
}

export class ScimConnectionStore extends Context.Service<
  ScimConnectionStore,
  ScimConnectionStoreShape
>()("awthaq/scim/ScimConnectionStore") {}

/** Hex SHA-256 of a token — the only form of it ever stored or compared. */
const hashToken = (crypto: Crypto.Crypto, token: string) =>
  crypto.digest("SHA-256", new TextEncoder().encode(token)).pipe(Effect.map(hexOf), Effect.orDie);

/** Requires `ScimRecords` and `Crypto`. */
export const layerStore = Layer.effect(
  ScimConnectionStore,
  Effect.gen(function* () {
    const records = yield* ScimRecords.ScimRecords;
    const crypto = yield* Crypto.Crypto;

    const create: ScimConnectionStoreShape["create"] = Effect.fnUntraced(function* (input) {
      const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
      const token = `${TOKEN_PREFIX}${hexOf(yield* crypto.randomBytes(32).pipe(Effect.orDie))}`;
      const record = yield* records.createConnection({
        id,
        organizationId: input.organizationId,
        name: input.name.trim(),
        tokenHash: yield* hashToken(crypto, token),
      });
      return { connection: toView(record), token: Redacted.make(token) };
    });

    const list: ScimConnectionStoreShape["list"] = (organizationId) =>
      records.listConnections(organizationId).pipe(Effect.map((rows) => rows.map(toView)));

    const revoke: ScimConnectionStoreShape["revoke"] = (organizationId, connectionId) =>
      records.revokeConnection(organizationId, connectionId).pipe(Effect.map(toView));

    return ScimConnectionStore.of({ create, list, revoke });
  }),
);

/**
 * BEH-EA-241: bearer authentication for the `scim` group. Requires `ScimRecords`,
 * `OrganizationRecords` and `Crypto`.
 */
export const ScimAuthenticationLive = Layer.effect(
  ScimApi.ScimAuthentication,
  Effect.gen(function* () {
    const records = yield* ScimRecords.ScimRecords;
    const orgs = yield* OrganizationRecords.OrganizationRecords;
    const crypto = yield* Crypto.Crypto;

    const bearer: HttpApiMiddleware.HttpApiMiddlewareSecurity<
      { readonly bearer: typeof HttpApiSecurity.bearer },
      ScimApi.CurrentScimConnection,
      typeof ScimApi.ScimUnauthorized,
      never
    >["bearer"] = (httpEffect, { credential }) =>
      Effect.gen(function* () {
        const presented = Redacted.value(credential);
        if (!presented.startsWith(TOKEN_PREFIX)) return yield* ScimApi.unauthorized();
        const hash = yield* hashToken(crypto, presented);
        const found = yield* records.findConnectionByTokenHash(hash);
        if (Option.isNone(found)) return yield* ScimApi.unauthorized();
        const connection = found.value;
        // Constant-time even though the lookup was an equality: no early exit on a partial match.
        const equal = ConstantTime.constantTimeEqualString(hash, connection.tokenHash);
        if (!equal || Option.isSome(connection.revokedAt)) return yield* ScimApi.unauthorized();
        const organization = yield* orgs.findById(connection.organizationId);
        if (Option.isNone(organization) || Option.isSome(organization.value.suspendedAt)) {
          return yield* ScimApi.unauthorized();
        }
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
