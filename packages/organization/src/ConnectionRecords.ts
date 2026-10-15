// @awthaq/organization — ConnectionRecords
//
// EP-004/CWM-001 (wayfinder ticket 18, ADR-EA-018): persistence for the
// `organization_oauth_connection` table — an organization's own OIDC/OAuth2
// identity provider (a WorkOS-style "connection"). Owned by this plugin, built
// the way every other `*Records.ts` here is: directly against `SqlSchema`, one
// `layerMemory` and one `layerSql`.
//
// `clientSecret` is a `SealedColumn` (plan 05, ADR-EA-019 decision 6): this module seals the
// plaintext it is given under `organization_oauth_connection:<id>:clientSecret` and hands out
// a `Sealed` value, so a database dump discloses no provider secret and no caller sees an
// envelope or an AAD (envelopes sealed under the old `organization-oauth-connection:` AAD still
// open, and re-seal on read). `emailDomains` live in their own table so a domain is unique
// across *all* organizations (one domain routes to exactly one connection) and
// home-realm discovery is one indexed lookup. Domains are asserted by the
// organization, not verified (there is no DNS-proof step): they route a sign-in
// to a connection, they do not authenticate anyone — the connection's IdP still
// has to.

import { type Encryption, SqlTransaction } from "@awthaq/ports";
import { Models as SqlModels, SealedColumn, StoreFailure, TenantScoped } from "@awthaq/sql";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

export type ConnectionKind = "oidc" | "oauth2";

export interface ConnectionRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly kind: ConnectionKind;
  readonly name: string;
  readonly issuer: Option.Option<string>;
  readonly discoveryUrl: Option.Option<string>;
  readonly authorizationEndpoint: Option.Option<string>;
  readonly tokenEndpoint: Option.Option<string>;
  readonly jwksUri: Option.Option<string>;
  readonly userinfoEndpoint: Option.Option<string>;
  readonly clientId: string;
  /** The sealed provider secret; `None` for a public client. Open it where it is needed. */
  readonly clientSecret: Option.Option<SealedColumn.Sealed<string>>;
  /**
   * Changes whenever the stored secret does (it is the ciphertext, so it is fresh on every write):
   * a cache fingerprint to compare, never to display or decode.
   */
  readonly secretRevision: Option.Option<string>;
  readonly scopes: ReadonlyArray<string>;
  readonly emailDomains: ReadonlyArray<string>;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}

/** What `create` takes: the caller (the store) mints the id so it can bind the secret's AAD to it. */
export interface ConnectionInput {
  readonly id: string;
  readonly organizationId: string;
  readonly kind: ConnectionKind;
  readonly name: string;
  readonly issuer?: string | undefined;
  readonly discoveryUrl?: string | undefined;
  readonly authorizationEndpoint?: string | undefined;
  readonly tokenEndpoint?: string | undefined;
  readonly jwksUri?: string | undefined;
  readonly userinfoEndpoint?: string | undefined;
  readonly clientId: string;
  readonly clientSecret?: Redacted.Redacted<string> | undefined;
  readonly scopes: ReadonlyArray<string>;
  readonly emailDomains: ReadonlyArray<string>;
}

/** A partial update: `undefined` leaves a field alone, `null` clears a nullable one. */
export interface ConnectionPatch {
  readonly name?: string | undefined;
  readonly issuer?: string | null | undefined;
  readonly discoveryUrl?: string | null | undefined;
  readonly authorizationEndpoint?: string | null | undefined;
  readonly tokenEndpoint?: string | null | undefined;
  readonly jwksUri?: string | null | undefined;
  readonly userinfoEndpoint?: string | null | undefined;
  readonly clientId?: string | undefined;
  readonly clientSecret?: Redacted.Redacted<string> | null | undefined;
  readonly scopes?: ReadonlyArray<string> | undefined;
  readonly emailDomains?: ReadonlyArray<string> | undefined;
}

export class ConnectionRecordNotFound extends Data.TaggedError("ConnectionRecordNotFound")<{
  readonly id: string;
}> {}

/** Another connection (in any organization) already routes this email domain. */
export class ConnectionDomainTaken extends Data.TaggedError("ConnectionDomainTaken")<{
  readonly domain: string;
}> {}

export interface ConnectionRecordsShape {
  readonly create: (
    input: ConnectionInput,
  ) => Effect.Effect<ConnectionRecord, ConnectionDomainTaken | StoreFailure.StoreUnavailable>;
  readonly findById: (
    organizationId: string,
    id: string,
  ) => Effect.Effect<Option.Option<ConnectionRecord>, StoreFailure.StoreUnavailable>;
  /** Home-realm discovery: the one connection that routes `domain`, across every organization. */
  readonly findByEmailDomain: (
    grant: TenantScoped.CrossTenant,
    domain: string,
  ) => Effect.Effect<Option.Option<ConnectionRecord>, StoreFailure.StoreUnavailable>;
  readonly listByOrganization: (
    organizationId: string,
  ) => Effect.Effect<ReadonlyArray<ConnectionRecord>, StoreFailure.StoreUnavailable>;
  readonly update: (
    organizationId: string,
    id: string,
    patch: ConnectionPatch,
  ) => Effect.Effect<
    ConnectionRecord,
    ConnectionRecordNotFound | ConnectionDomainTaken | StoreFailure.StoreUnavailable
  >;
  readonly remove: (
    organizationId: string,
    id: string,
  ) => Effect.Effect<void, ConnectionRecordNotFound | StoreFailure.StoreUnavailable>;
  readonly removeAllForOrganization: (
    organizationId: string,
  ) => Effect.Effect<void, StoreFailure.StoreUnavailable>;
}

export class ConnectionRecords extends Context.Service<ConnectionRecords, ConnectionRecordsShape>()(
  "awthaq/organization/records/ConnectionRecords",
) {}

const notFound = (id: string): ConnectionRecordNotFound => new ConnectionRecordNotFound({ id });
const domainTaken = (domain: string): ConnectionDomainTaken =>
  new ConnectionDomainTaken({ domain });

/** The sealed `clientSecret` column. */
export const clientSecretColumn = SealedColumn.column({
  table: "organization_oauth_connection",
  column: "clientSecret",
  key: "id",
});

/** A connection as it is at rest: the secret is the stored envelope. */
interface StoredConnection extends Omit<ConnectionRecord, "clientSecret" | "secretRevision"> {
  readonly clientSecret: Option.Option<string>;
}

/** `patch` applied over `stored`; `updatedAt` is stamped by the caller and `secret` is the already-sealed new value (`undefined` leaves it, `null` clears it). */
const applyPatch = (
  stored: StoredConnection,
  patch: ConnectionPatch,
  updatedAt: DateTime.Utc,
  secret: string | null | undefined,
): StoredConnection => {
  const nullable = (
    current: Option.Option<string>,
    next: string | null | undefined,
  ): Option.Option<string> => (next === undefined ? current : Option.fromNullOr(next));
  return {
    ...stored,
    name: patch.name ?? stored.name,
    issuer: nullable(stored.issuer, patch.issuer),
    discoveryUrl: nullable(stored.discoveryUrl, patch.discoveryUrl),
    authorizationEndpoint: nullable(stored.authorizationEndpoint, patch.authorizationEndpoint),
    tokenEndpoint: nullable(stored.tokenEndpoint, patch.tokenEndpoint),
    jwksUri: nullable(stored.jwksUri, patch.jwksUri),
    userinfoEndpoint: nullable(stored.userinfoEndpoint, patch.userinfoEndpoint),
    clientId: patch.clientId ?? stored.clientId,
    clientSecret: nullable(stored.clientSecret, secret),
    scopes: patch.scopes ?? stored.scopes,
    emailDomains: patch.emailDomains ?? stored.emailDomains,
    updatedAt,
  };
};

// ---- layerMemory ------------------------------------------------------------

/**
 * A test seam of `layerMemory`: the stored envelope of the sealed column, and a way to overwrite it
 * (`TestAuth.runSealedColumnTests` needs to look at, and plant, what is at rest; over SQL that is a
 * statement, over memory it is this).
 */
export class MemoryEnvelopes extends Context.Service<
  MemoryEnvelopes,
  {
    readonly stored: (id: string) => Effect.Effect<string>;
    readonly plant: (id: string, stored: string) => Effect.Effect<void>;
  }
>()("awthaq/organization/ConnectionRecords/MemoryEnvelopes") {}

type State = HashMap.HashMap<string, StoredConnection>;

// The explicit types are the narrow exception the plugins document (TS2883): declaration emit
// cannot name `Encryption` through the inferred requirement of the sealed-column codec.
export const layerMemory: Layer.Layer<
  ConnectionRecords | MemoryEnvelopes,
  never,
  Encryption.Encryption
> = Layer.effectContext(
  Effect.gen(function* () {
    const state = yield* Ref.make<State>(HashMap.empty());

    /** Persists a re-seal only while the row still holds the envelope that was read. */
    const swap: SealedColumn.Swap = (rowKey, stored, fresh) =>
      Ref.modify(state, (s) => {
        const row = HashMap.get(s, rowKey);
        if (Option.isNone(row) || Option.getOrUndefined(row.value.clientSecret) !== stored) {
          return [false, s] as const;
        }
        return [
          true,
          HashMap.set(s, rowKey, { ...row.value, clientSecret: Option.some(fresh) }),
        ] as const;
      });
    const secrets = yield* SealedColumn.codec(clientSecretColumn, swap);

    const toRecord = (row: StoredConnection): ConnectionRecord => ({
      ...row,
      clientSecret: Option.map(row.clientSecret, (stored) => secrets.sealed(row.id, stored)),
      secretRevision: row.clientSecret,
    });

    /** The first of `domains` another connection already routes. */
    const firstTakenDomain = (
      s: State,
      domains: ReadonlyArray<string>,
      exceptId: string,
    ): Option.Option<string> =>
      Option.fromNullishOr(
        domains.find((domain) =>
          Array.from(HashMap.values(s)).some(
            (row) => row.id !== exceptId && row.emailDomains.includes(domain),
          ),
        ),
      );

    const create: ConnectionRecordsShape["create"] = Effect.fnUntraced(function* (input) {
      const now = yield* DateTime.now;
      const secret =
        input.clientSecret === undefined
          ? Option.none<string>()
          : Option.some(yield* secrets.seal(input.id, input.clientSecret));
      const outcome = yield* Ref.modify(
        state,
        (s): readonly [Result.Result<StoredConnection, ConnectionDomainTaken>, State] => {
          const taken = firstTakenDomain(s, input.emailDomains, input.id);
          if (Option.isSome(taken)) return [Result.fail(domainTaken(taken.value)), s] as const;
          const record: StoredConnection = {
            id: input.id,
            organizationId: input.organizationId,
            kind: input.kind,
            name: input.name,
            issuer: Option.fromNullishOr(input.issuer),
            discoveryUrl: Option.fromNullishOr(input.discoveryUrl),
            authorizationEndpoint: Option.fromNullishOr(input.authorizationEndpoint),
            tokenEndpoint: Option.fromNullishOr(input.tokenEndpoint),
            jwksUri: Option.fromNullishOr(input.jwksUri),
            userinfoEndpoint: Option.fromNullishOr(input.userinfoEndpoint),
            clientId: input.clientId,
            clientSecret: secret,
            scopes: input.scopes,
            emailDomains: input.emailDomains,
            createdAt: now,
            updatedAt: now,
          };
          return [Result.succeed(record), HashMap.set(s, record.id, record)] as const;
        },
      );
      return toRecord(yield* Effect.fromResult(outcome));
    });

    const findById: ConnectionRecordsShape["findById"] = (organizationId, id) =>
      Ref.get(state).pipe(
        Effect.map((s) =>
          Option.map(
            Option.filter(HashMap.get(s, id), (row) => row.organizationId === organizationId),
            toRecord,
          ),
        ),
      );

    const findByEmailDomain: ConnectionRecordsShape["findByEmailDomain"] = (_grant, domain) =>
      Ref.get(state).pipe(
        Effect.map((s) =>
          Option.map(
            Option.fromNullishOr(
              Array.from(HashMap.values(s)).find((row) => row.emailDomains.includes(domain)),
            ),
            toRecord,
          ),
        ),
      );

    const listByOrganization: ConnectionRecordsShape["listByOrganization"] = (organizationId) =>
      Ref.get(state).pipe(
        Effect.map((s) =>
          Array.from(HashMap.values(s))
            .filter((row) => row.organizationId === organizationId)
            .sort(
              (a, b) =>
                DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt) ||
                a.id.localeCompare(b.id),
            )
            .map(toRecord),
        ),
      );

    const update: ConnectionRecordsShape["update"] = Effect.fnUntraced(
      function* (organizationId, id, patch) {
        const now = yield* DateTime.now;
        const secret = yield* patchSecret(secrets, id, patch);
        const outcome = yield* Ref.modify(
          state,
          (
            s,
          ): readonly [
            Result.Result<StoredConnection, ConnectionRecordNotFound | ConnectionDomainTaken>,
            State,
          ] => {
            const existing = Option.filter(
              HashMap.get(s, id),
              (row) => row.organizationId === organizationId,
            );
            if (Option.isNone(existing)) return [Result.fail(notFound(id)), s] as const;
            const updated = applyPatch(existing.value, patch, now, secret);
            const taken = firstTakenDomain(s, updated.emailDomains, id);
            if (Option.isSome(taken)) return [Result.fail(domainTaken(taken.value)), s] as const;
            return [Result.succeed(updated), HashMap.set(s, id, updated)] as const;
          },
        );
        return toRecord(yield* Effect.fromResult(outcome));
      },
    );

    const remove: ConnectionRecordsShape["remove"] = (organizationId, id) =>
      Ref.modify(state, (s): readonly [Result.Result<void, ConnectionRecordNotFound>, State] => {
        const existing = Option.filter(
          HashMap.get(s, id),
          (row) => row.organizationId === organizationId,
        );
        if (Option.isNone(existing)) return [Result.fail(notFound(id)), s] as const;
        return [Result.succeed(undefined), HashMap.remove(s, id)] as const;
      }).pipe(Effect.flatMap(Effect.fromResult));

    const removeAllForOrganization: ConnectionRecordsShape["removeAllForOrganization"] = (
      organizationId,
    ) =>
      Ref.update(state, (s) => HashMap.filter(s, (row) => row.organizationId !== organizationId));

    const records = {
      create,
      findById,
      findByEmailDomain,
      listByOrganization,
      update,
      remove,
      removeAllForOrganization,
    } satisfies ConnectionRecordsShape;
    const envelopes = MemoryEnvelopes.of({
      stored: (id) =>
        Effect.map(Ref.get(state), (s) =>
          Option.getOrElse(
            Option.flatMap(HashMap.get(s, id), (row) => row.clientSecret),
            () => "",
          ),
        ),
      plant: (id, stored) =>
        Ref.update(state, (s) =>
          Option.match(HashMap.get(s, id), {
            onNone: () => s,
            onSome: (row) => HashMap.set(s, id, { ...row, clientSecret: Option.some(stored) }),
          }),
        ),
    });
    return Context.make(ConnectionRecords, records).pipe(Context.add(MemoryEnvelopes, envelopes));
  }),
);

/** The already-sealed new secret a patch carries: `undefined` leaves it, `null` clears it. */
const patchSecret = (
  secrets: {
    readonly seal: (rowKey: string, value: Redacted.Redacted<string>) => Effect.Effect<string>;
  },
  id: string,
  patch: ConnectionPatch,
) =>
  patch.clientSecret === undefined || patch.clientSecret === null
    ? Effect.succeed(patch.clientSecret)
    : secrets.seal(id, patch.clientSecret);

// ---- layerSql -----------------------------------------------------------------

const makeConnectionRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({
    id: Schema.String,
    organizationId: Schema.String,
    kind: Schema.Literals(["oidc", "oauth2"]),
    name: Schema.String,
    issuer: Schema.NullOr(Schema.String),
    discoveryUrl: Schema.NullOr(Schema.String),
    authorizationEndpoint: Schema.NullOr(Schema.String),
    tokenEndpoint: Schema.NullOr(Schema.String),
    jwksUri: Schema.NullOr(Schema.String),
    userinfoEndpoint: Schema.NullOr(Schema.String),
    clientId: Schema.String,
    clientSecret: Schema.NullOr(Schema.String),
    scopes: Schema.fromJsonString(Schema.Array(Schema.String)),
    createdAt: wire.dateTime,
    updatedAt: wire.dateTime,
  });

type ConnectionRow = ReturnType<typeof makeConnectionRow>["Type"];

const toStored = (row: ConnectionRow, emailDomains: ReadonlyArray<string>): StoredConnection => ({
  id: row.id,
  organizationId: row.organizationId,
  kind: row.kind,
  name: row.name,
  issuer: Option.fromNullOr(row.issuer),
  discoveryUrl: Option.fromNullOr(row.discoveryUrl),
  authorizationEndpoint: Option.fromNullOr(row.authorizationEndpoint),
  tokenEndpoint: Option.fromNullOr(row.tokenEndpoint),
  jwksUri: Option.fromNullOr(row.jwksUri),
  userinfoEndpoint: Option.fromNullOr(row.userinfoEndpoint),
  clientId: row.clientId,
  clientSecret: Option.fromNullOr(row.clientSecret),
  scopes: row.scopes,
  emailDomains,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const layerSql: Layer.Layer<
  ConnectionRecords,
  never,
  SqlClient.SqlClient | Encryption.Encryption
> = Layer.effect(
  ConnectionRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const unavailable = (operation: string) =>
      StoreFailure.orStoreUnavailable(`ConnectionRecords.${operation}`);
    // TS-001: the row codecs follow the ambient client's dialect (Date on pg, ISO string on SQLite).
    const wire = SqlModels.dialectFields(yield* SqlModels.resolveDialect(sql));
    const ConnectionRow = makeConnectionRow(wire);
    const secrets = yield* SealedColumn.codec(
      clientSecretColumn,
      yield* SealedColumn.sqlSwap(clientSecretColumn),
    );

    const toRecord = (row: StoredConnection): ConnectionRecord => ({
      ...row,
      clientSecret: Option.map(row.clientSecret, (stored) => secrets.sealed(row.id, stored)),
      secretRevision: row.clientSecret,
    });

    const upsertRow = SqlSchema.findOne({
      Request: ConnectionRow,
      Result: ConnectionRow,
      execute: (r) => sql`
          INSERT INTO organization_oauth_connection (
            id, "organizationId", kind, name, issuer, "discoveryUrl", "authorizationEndpoint",
            "tokenEndpoint", "jwksUri", "userinfoEndpoint", "clientId", "clientSecret", scopes,
            "createdAt", "updatedAt"
          ) VALUES (
            ${r.id}, ${r.organizationId}, ${r.kind}, ${r.name}, ${r.issuer}, ${r.discoveryUrl},
            ${r.authorizationEndpoint}, ${r.tokenEndpoint}, ${r.jwksUri}, ${r.userinfoEndpoint},
            ${r.clientId}, ${r.clientSecret}, ${r.scopes}, ${r.createdAt}, ${r.updatedAt}
          )
          ON CONFLICT (id) DO UPDATE SET
            name = excluded.name, issuer = excluded.issuer, "discoveryUrl" = excluded."discoveryUrl",
            "authorizationEndpoint" = excluded."authorizationEndpoint",
            "tokenEndpoint" = excluded."tokenEndpoint", "jwksUri" = excluded."jwksUri",
            "userinfoEndpoint" = excluded."userinfoEndpoint", "clientId" = excluded."clientId",
            "clientSecret" = excluded."clientSecret", scopes = excluded.scopes,
            "updatedAt" = excluded."updatedAt"
          RETURNING *
        `,
    });

    const findByIdQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ organizationId: Schema.String, id: Schema.String }),
      Result: ConnectionRow,
      execute: (r) =>
        sql`SELECT * FROM organization_oauth_connection WHERE id = ${r.id} AND "organizationId" = ${r.organizationId}`,
    });

    const findByDomainQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: ConnectionRow,
      execute: (domain) => sql`
          SELECT c.* FROM organization_oauth_connection c
          JOIN organization_oauth_connection_domain d ON d."connectionId" = c.id
          WHERE d.domain = ${domain}
        `,
    });

    const listQuery = SqlSchema.findAll({
      Request: Schema.String,
      Result: ConnectionRow,
      execute: (organizationId) =>
        sql`SELECT * FROM organization_oauth_connection WHERE "organizationId" = ${organizationId} ORDER BY "createdAt", id`,
    });

    const domainsOf = (connectionIds: ReadonlyArray<string>) =>
      connectionIds.length === 0
        ? Effect.succeed(new Map<string, Array<string>>())
        : SqlSchema.findAll({
            Request: Schema.Array(Schema.String),
            Result: Schema.Struct({ domain: Schema.String, connectionId: Schema.String }),
            execute: (ids) =>
              sql`SELECT domain, "connectionId" FROM organization_oauth_connection_domain WHERE "connectionId" IN ${sql.in(ids)} ORDER BY domain`,
          })(connectionIds).pipe(
            Effect.map((rows) => {
              const byConnection = new Map<string, Array<string>>();
              for (const row of rows) {
                byConnection.set(row.connectionId, [
                  ...(byConnection.get(row.connectionId) ?? []),
                  row.domain,
                ]);
              }
              return byConnection;
            }),
          );

    const withDomains = (rows: ReadonlyArray<ConnectionRow>) =>
      domainsOf(rows.map((row) => row.id)).pipe(
        Effect.map((byConnection) =>
          rows.map((row) => toStored(row, byConnection.get(row.id) ?? [])),
        ),
      );

    /** One connection of `organizationId`, with its domains, as stored. */
    const findStored = (organizationId: string, id: string) =>
      findByIdQuery({ organizationId, id }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeedNone,
            onSome: (row) =>
              Effect.map(withDomains([row]), (stored) => Option.fromNullishOr(stored[0])),
          }),
        ),
      );

    /** Replaces a connection's domain set inside the caller's transaction; a taken domain is a `ConnectionDomainTaken`. */
    const replaceDomains = (
      organizationId: string,
      connectionId: string,
      domains: ReadonlyArray<string>,
    ) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM organization_oauth_connection_domain WHERE "connectionId" = ${connectionId} AND "organizationId" = ${organizationId}`;
        for (const domain of domains) {
          yield* sql`INSERT INTO organization_oauth_connection_domain (domain, "connectionId", "organizationId") VALUES (${domain}, ${connectionId}, ${organizationId})`.pipe(
            Effect.mapError((error) =>
              error.reason._tag === "UniqueViolation" ? domainTaken(domain) : error,
            ),
          );
        }
      });

    const write = (record: StoredConnection) =>
      SqlTransaction.transactional(sql)(
        Effect.gen(function* () {
          const row = yield* upsertRow({
            id: record.id,
            organizationId: record.organizationId,
            kind: record.kind,
            name: record.name,
            issuer: Option.getOrNull(record.issuer),
            discoveryUrl: Option.getOrNull(record.discoveryUrl),
            authorizationEndpoint: Option.getOrNull(record.authorizationEndpoint),
            tokenEndpoint: Option.getOrNull(record.tokenEndpoint),
            jwksUri: Option.getOrNull(record.jwksUri),
            userinfoEndpoint: Option.getOrNull(record.userinfoEndpoint),
            clientId: record.clientId,
            clientSecret: Option.getOrNull(record.clientSecret),
            scopes: record.scopes,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          }).pipe(unavailable("write"));
          yield* replaceDomains(record.organizationId, record.id, record.emailDomains);
          return toRecord(toStored(row, record.emailDomains));
        }),
      ).pipe(Effect.catchTag("SqlError", StoreFailure.storeUnavailable("ConnectionRecords.write")));

    const create: ConnectionRecordsShape["create"] = Effect.fnUntraced(function* (input) {
      const now = yield* DateTime.now;
      const secret =
        input.clientSecret === undefined
          ? Option.none<string>()
          : Option.some(yield* secrets.seal(input.id, input.clientSecret));
      return yield* write({
        id: input.id,
        organizationId: input.organizationId,
        kind: input.kind,
        name: input.name,
        issuer: Option.fromNullishOr(input.issuer),
        discoveryUrl: Option.fromNullishOr(input.discoveryUrl),
        authorizationEndpoint: Option.fromNullishOr(input.authorizationEndpoint),
        tokenEndpoint: Option.fromNullishOr(input.tokenEndpoint),
        jwksUri: Option.fromNullishOr(input.jwksUri),
        userinfoEndpoint: Option.fromNullishOr(input.userinfoEndpoint),
        clientId: input.clientId,
        clientSecret: secret,
        scopes: input.scopes,
        emailDomains: input.emailDomains,
        createdAt: now,
        updatedAt: now,
      });
    });

    const findById: ConnectionRecordsShape["findById"] = (organizationId, id) =>
      findStored(organizationId, id).pipe(
        Effect.map(Option.map(toRecord)),
        unavailable("findById"),
      );

    const findByEmailDomain: ConnectionRecordsShape["findByEmailDomain"] = (grant, domain) =>
      findByDomainQuery(domain).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeedNone,
            onSome: (row) =>
              Effect.map(withDomains([row]), (stored) => Option.fromNullishOr(stored[0])),
          }),
        ),
        Effect.map(Option.map(toRecord)),
        TenantScoped.liftOn(sql, grant),
        unavailable("findByEmailDomain"),
      );

    const listByOrganization: ConnectionRecordsShape["listByOrganization"] = (organizationId) =>
      listQuery(organizationId).pipe(
        Effect.flatMap(withDomains),
        Effect.map((rows) => rows.map(toRecord)),
        unavailable("listByOrganization"),
      );

    const update: ConnectionRecordsShape["update"] = Effect.fnUntraced(
      function* (organizationId, id, patch) {
        const existing = yield* findStored(organizationId, id).pipe(unavailable("update"));
        if (Option.isNone(existing)) return yield* Effect.fail(notFound(id));
        const now = yield* DateTime.now;
        const secret = yield* patchSecret(secrets, id, patch);
        return yield* write(applyPatch(existing.value, patch, now, secret));
      },
    );

    const remove: ConnectionRecordsShape["remove"] = Effect.fnUntraced(
      function* (organizationId, id) {
        const existing = yield* findStored(organizationId, id).pipe(unavailable("remove"));
        if (Option.isNone(existing)) return yield* Effect.fail(notFound(id));
        yield* SqlTransaction.transactional(sql)(
          Effect.gen(function* () {
            yield* sql`DELETE FROM organization_oauth_connection_domain WHERE "connectionId" = ${id} AND "organizationId" = ${organizationId}`;
            yield* sql`DELETE FROM organization_oauth_connection WHERE id = ${id} AND "organizationId" = ${organizationId}`;
          }),
        ).pipe(
          Effect.catchTag("SqlError", StoreFailure.storeUnavailable("ConnectionRecords.remove")),
        );
      },
    );

    const removeAllForOrganization: ConnectionRecordsShape["removeAllForOrganization"] = (
      organizationId,
    ) =>
      SqlTransaction.transactional(sql)(
        Effect.gen(function* () {
          yield* sql`DELETE FROM organization_oauth_connection_domain WHERE "organizationId" = ${organizationId}`;
          yield* sql`DELETE FROM organization_oauth_connection WHERE "organizationId" = ${organizationId}`;
        }),
      ).pipe(
        Effect.catchTag(
          "SqlError",
          StoreFailure.storeUnavailable("ConnectionRecords.removeAllForOrganization"),
        ),
      );

    return {
      create,
      findById,
      findByEmailDomain,
      listByOrganization,
      update,
      remove,
      removeAllForOrganization,
    };
  }),
);
