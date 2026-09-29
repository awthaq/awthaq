// @awthaq/organization — ConnectionRecords
//
// EP-004/CWM-001 (wayfinder ticket 18, ADR-EA-018): persistence for the
// `organization_oauth_connection` table — an organization's own OIDC/OAuth2
// identity provider (a WorkOS-style "connection"). Owned by this plugin, built
// the way every other `*Records.ts` here is: directly against `SqlSchema`, one
// `layerMemory` and one `layerSql`.
//
// `clientSecret` holds whatever the caller stored — `OrganizationConnections`
// only ever writes an `Encryption` envelope (AAD bound to the connection id and
// field), so a database dump discloses no provider secret, and this module never
// sees plaintext. `emailDomains` live in their own table so a domain is unique
// across *all* organizations (one domain routes to exactly one connection) and
// home-realm discovery is one indexed lookup. Domains are asserted by the
// organization, not verified (there is no DNS-proof step): they route a sign-in
// to a connection, they do not authenticate anyone — the connection's IdP still
// has to.

import { Models as SqlModels } from "@awthaq/sql";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
  /** An `Encryption` envelope, never plaintext. `None` for a public client. */
  readonly clientSecret: Option.Option<string>;
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
  readonly clientSecret?: string | undefined;
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
  readonly clientSecret?: string | null | undefined;
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
  ) => Effect.Effect<ConnectionRecord, ConnectionDomainTaken>;
  readonly findById: (
    organizationId: string,
    id: string,
  ) => Effect.Effect<Option.Option<ConnectionRecord>>;
  /** Home-realm discovery: the one connection that routes `domain`, across every organization. */
  readonly findByEmailDomain: (domain: string) => Effect.Effect<Option.Option<ConnectionRecord>>;
  readonly listByOrganization: (
    organizationId: string,
  ) => Effect.Effect<ReadonlyArray<ConnectionRecord>>;
  readonly update: (
    organizationId: string,
    id: string,
    patch: ConnectionPatch,
  ) => Effect.Effect<ConnectionRecord, ConnectionRecordNotFound | ConnectionDomainTaken>;
  readonly remove: (
    organizationId: string,
    id: string,
  ) => Effect.Effect<void, ConnectionRecordNotFound>;
  readonly removeAllForOrganization: (organizationId: string) => Effect.Effect<void>;
}

export class ConnectionRecords extends Context.Service<ConnectionRecords, ConnectionRecordsShape>()(
  "awthaq/organization/ConnectionRecords",
) {}

const notFound = (id: string): ConnectionRecordNotFound => new ConnectionRecordNotFound({ id });
const domainTaken = (domain: string): ConnectionDomainTaken => new ConnectionDomainTaken({ domain });

/** `patch` applied over `record`; `updatedAt` is stamped by the caller. */
const applyPatch = (
  record: ConnectionRecord,
  patch: ConnectionPatch,
  updatedAt: DateTime.Utc,
): ConnectionRecord => {
  const nullable = (
    current: Option.Option<string>,
    next: string | null | undefined,
  ): Option.Option<string> => (next === undefined ? current : Option.fromNullOr(next));
  return {
    ...record,
    name: patch.name ?? record.name,
    issuer: nullable(record.issuer, patch.issuer),
    discoveryUrl: nullable(record.discoveryUrl, patch.discoveryUrl),
    authorizationEndpoint: nullable(record.authorizationEndpoint, patch.authorizationEndpoint),
    tokenEndpoint: nullable(record.tokenEndpoint, patch.tokenEndpoint),
    jwksUri: nullable(record.jwksUri, patch.jwksUri),
    userinfoEndpoint: nullable(record.userinfoEndpoint, patch.userinfoEndpoint),
    clientId: patch.clientId ?? record.clientId,
    clientSecret: nullable(record.clientSecret, patch.clientSecret),
    scopes: patch.scopes ?? record.scopes,
    emailDomains: patch.emailDomains ?? record.emailDomains,
    updatedAt,
  };
};

// ---- layerMemory ------------------------------------------------------------

type State = HashMap.HashMap<string, ConnectionRecord>;

export const layerMemory = Layer.effect(
  ConnectionRecords,
  Effect.gen(function* () {
    const state = yield* Ref.make<State>(HashMap.empty());

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
      const outcome = yield* Ref.modify(
        state,
        (s): readonly [Result.Result<ConnectionRecord, ConnectionDomainTaken>, State] => {
          const taken = firstTakenDomain(s, input.emailDomains, input.id);
          if (Option.isSome(taken)) return [Result.fail(domainTaken(taken.value)), s] as const;
          const record: ConnectionRecord = {
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
            clientSecret: Option.fromNullishOr(input.clientSecret),
            scopes: input.scopes,
            emailDomains: input.emailDomains,
            createdAt: now,
            updatedAt: now,
          };
          return [Result.succeed(record), HashMap.set(s, record.id, record)] as const;
        },
      );
      return yield* Effect.fromResult(outcome);
    });

    const findById: ConnectionRecordsShape["findById"] = (organizationId, id) =>
      Ref.get(state).pipe(
        Effect.map((s) =>
          Option.filter(HashMap.get(s, id), (row) => row.organizationId === organizationId),
        ),
      );

    const findByEmailDomain: ConnectionRecordsShape["findByEmailDomain"] = (domain) =>
      Ref.get(state).pipe(
        Effect.map((s) =>
          Option.fromNullishOr(
            Array.from(HashMap.values(s)).find((row) => row.emailDomains.includes(domain)),
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
            ),
        ),
      );

    const update: ConnectionRecordsShape["update"] = Effect.fnUntraced(
      function* (organizationId, id, patch) {
        const now = yield* DateTime.now;
        const outcome = yield* Ref.modify(
          state,
          (
            s,
          ): readonly [
            Result.Result<ConnectionRecord, ConnectionRecordNotFound | ConnectionDomainTaken>,
            State,
          ] => {
            const existing = Option.filter(
              HashMap.get(s, id),
              (row) => row.organizationId === organizationId,
            );
            if (Option.isNone(existing)) return [Result.fail(notFound(id)), s] as const;
            const updated = applyPatch(existing.value, patch, now);
            const taken = firstTakenDomain(s, updated.emailDomains, id);
            if (Option.isSome(taken)) return [Result.fail(domainTaken(taken.value)), s] as const;
            return [Result.succeed(updated), HashMap.set(s, id, updated)] as const;
          },
        );
        return yield* Effect.fromResult(outcome);
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
      Ref.update(state, (s) =>
        HashMap.filter(s, (row) => row.organizationId !== organizationId),
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

const toRecord = (row: ConnectionRow, emailDomains: ReadonlyArray<string>): ConnectionRecord => ({
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

export const layerSql = Layer.effect(
  ConnectionRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // TS-001: the row codecs follow the ambient client's dialect (Date on pg, ISO string on SQLite).
    const wire = SqlModels.dialectFields(yield* SqlModels.resolveDialect(sql));
    const ConnectionRow = makeConnectionRow(wire);

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
            Effect.orDie,
          );

    const withDomains = (rows: ReadonlyArray<ConnectionRow>) =>
      domainsOf(rows.map((row) => row.id)).pipe(
        Effect.map((byConnection) => rows.map((row) => toRecord(row, byConnection.get(row.id) ?? []))),
      );

    /** Replaces a connection's domain set inside the caller's transaction; a taken domain is a `ConnectionDomainTaken`. */
    const replaceDomains = (
      organizationId: string,
      connectionId: string,
      domains: ReadonlyArray<string>,
    ) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM organization_oauth_connection_domain WHERE "connectionId" = ${connectionId}`;
        for (const domain of domains) {
          yield* sql`INSERT INTO organization_oauth_connection_domain (domain, "connectionId", "organizationId") VALUES (${domain}, ${connectionId}, ${organizationId})`.pipe(
            Effect.catchTag("SqlError", (error) =>
              error.reason._tag === "UniqueViolation"
                ? Effect.fail(domainTaken(domain))
                : Effect.die(error),
            ),
          );
        }
      });

    const write = (record: ConnectionRecord) =>
      sql
        .withTransaction(
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
            }).pipe(Effect.orDie);
            yield* replaceDomains(record.organizationId, record.id, record.emailDomains);
            return toRecord(row, record.emailDomains);
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die));

    const create: ConnectionRecordsShape["create"] = Effect.fnUntraced(function* (input) {
      const now = yield* DateTime.now;
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
        clientSecret: Option.fromNullishOr(input.clientSecret),
        scopes: input.scopes,
        emailDomains: input.emailDomains,
        createdAt: now,
        updatedAt: now,
      });
    });

    const findById: ConnectionRecordsShape["findById"] = (organizationId, id) =>
      findByIdQuery({ organizationId, id }).pipe(
        Effect.orDie,
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeedNone,
            onSome: (row) => Effect.map(withDomains([row]), (records) => Option.fromNullishOr(records[0])),
          }),
        ),
      );

    const findByEmailDomain: ConnectionRecordsShape["findByEmailDomain"] = (domain) =>
      findByDomainQuery(domain).pipe(
        Effect.orDie,
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeedNone,
            onSome: (row) => Effect.map(withDomains([row]), (records) => Option.fromNullishOr(records[0])),
          }),
        ),
      );

    const listByOrganization: ConnectionRecordsShape["listByOrganization"] = (organizationId) =>
      listQuery(organizationId).pipe(Effect.orDie, Effect.flatMap(withDomains));

    const update: ConnectionRecordsShape["update"] = Effect.fnUntraced(
      function* (organizationId, id, patch) {
        const existing = yield* findById(organizationId, id);
        if (Option.isNone(existing)) return yield* Effect.fail(notFound(id));
        const now = yield* DateTime.now;
        return yield* write(applyPatch(existing.value, patch, now));
      },
    );

    const remove: ConnectionRecordsShape["remove"] = Effect.fnUntraced(
      function* (organizationId, id) {
        const existing = yield* findById(organizationId, id);
        if (Option.isNone(existing)) return yield* Effect.fail(notFound(id));
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM organization_oauth_connection_domain WHERE "connectionId" = ${id}`;
              yield* sql`DELETE FROM organization_oauth_connection WHERE id = ${id} AND "organizationId" = ${organizationId}`;
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die));
      },
    );

    const removeAllForOrganization: ConnectionRecordsShape["removeAllForOrganization"] = (
      organizationId,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM organization_oauth_connection_domain WHERE "organizationId" = ${organizationId}`;
            yield* sql`DELETE FROM organization_oauth_connection WHERE "organizationId" = ${organizationId}`;
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die));

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
