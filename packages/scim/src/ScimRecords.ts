// @awthaq/scim — ScimRecords
//
// spec/behaviors/30-scim.md, BEH-EA-246/242. This plugin's own persistence, owned
// here rather than in `@awthaq/core` so no SCIM concept leaks into the core
// schema (wayfinder ticket 08), built the way every plugin's `*Records.ts` is:
// directly against `SqlSchema`, one `layerMemory` and one `layerSql`.
//
// Two tables:
//
// - `scim_connection` — one row per directory-sync connection of one organization.
//   Only `SHA-256(token)` is stored (the token itself is shown once, at creation);
//   `revokedAt` retires it without losing the audit history of what it provisioned.
// - `scim_resource` — the *ownership and external-id mapping* of what a connection
//   provisioned: one row per (connection, kind, resource). It is what lets a repeat
//   `POST` with the same `externalId` converge, and what confines a connection to
//   the users and groups it created — a connection has no way to name, read,
//   change or deactivate a resource that has no row for it. `name` carries the
//   directory's `userName` for a user (unique per connection); `externalId` is the
//   directory's own key (unique per connection and kind, when present).

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

export type ResourceKind = "User" | "Group";

export interface ConnectionRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  /** Hex SHA-256 of the bearer token — never the token. */
  readonly tokenHash: string;
  readonly createdAt: DateTime.Utc;
  /** `Some` once revoked: the token no longer authenticates. */
  readonly revokedAt: Option.Option<DateTime.Utc>;
}

export interface ResourceLink {
  readonly connectionId: string;
  readonly kind: ResourceKind;
  /** The awthaq id: a `UserId` for a user, a team id for a group. */
  readonly resourceId: string;
  /** The directory's `userName` (users only). */
  readonly name: Option.Option<string>;
  readonly externalId: Option.Option<string>;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}

export class ScimRecordNotFound extends Data.TaggedError("ScimRecordNotFound")<{
  readonly id: string;
}> {}

/** `name` or `externalId` is already held by another resource of this connection. */
export class ScimLinkConflict extends Data.TaggedError("ScimLinkConflict")<{
  readonly field: "name" | "externalId";
}> {}

export interface ResourcePage {
  readonly items: ReadonlyArray<ResourceLink>;
  /** Every link of that kind the connection has, for `totalResults`. */
  readonly total: number;
}

export interface ScimRecordsShape {
  // ---- connections
  readonly createConnection: (input: {
    readonly id: string;
    readonly organizationId: string;
    readonly name: string;
    readonly tokenHash: string;
  }) => Effect.Effect<ConnectionRecord>;
  readonly findConnectionByTokenHash: (
    tokenHash: string,
  ) => Effect.Effect<Option.Option<ConnectionRecord>>;
  readonly listConnections: (
    organizationId: string,
  ) => Effect.Effect<ReadonlyArray<ConnectionRecord>>;
  readonly revokeConnection: (
    organizationId: string,
    id: string,
  ) => Effect.Effect<ConnectionRecord, ScimRecordNotFound>;
  // ---- resource links
  readonly link: (input: {
    readonly connectionId: string;
    readonly kind: ResourceKind;
    readonly resourceId: string;
    readonly name?: string | undefined;
    readonly externalId?: string | undefined;
  }) => Effect.Effect<ResourceLink, ScimLinkConflict>;
  readonly find: (
    connectionId: string,
    kind: ResourceKind,
    resourceId: string,
  ) => Effect.Effect<Option.Option<ResourceLink>>;
  readonly findByName: (
    connectionId: string,
    kind: ResourceKind,
    name: string,
  ) => Effect.Effect<Option.Option<ResourceLink>>;
  readonly findByExternalId: (
    connectionId: string,
    kind: ResourceKind,
    externalId: string,
  ) => Effect.Effect<Option.Option<ResourceLink>>;
  /** Oldest first, offset-paged (`startIndex` is an offset in SCIM; the set is bounded by what one directory provisions). */
  readonly list: (
    connectionId: string,
    kind: ResourceKind,
    page: { readonly offset: number; readonly limit: number },
  ) => Effect.Effect<ResourcePage>;
  /** `externalId: null` clears it. */
  readonly setExternalId: (
    connectionId: string,
    kind: ResourceKind,
    resourceId: string,
    externalId: string | null,
  ) => Effect.Effect<ResourceLink, ScimRecordNotFound | ScimLinkConflict>;
  readonly unlink: (
    connectionId: string,
    kind: ResourceKind,
    resourceId: string,
  ) => Effect.Effect<void>;
}

export class ScimRecords extends Context.Service<ScimRecords, ScimRecordsShape>()(
  "awthaq/scim/ScimRecords",
) {}

const notFound = (id: string): ScimRecordNotFound => new ScimRecordNotFound({ id });
const conflict = (field: "name" | "externalId"): ScimLinkConflict => new ScimLinkConflict({ field });

const byCreation = <A extends { readonly createdAt: DateTime.Utc }>(
  rows: ReadonlyArray<A>,
  tieBreak: (row: A) => string,
): ReadonlyArray<A> =>
  [...rows].sort(
    (a, b) =>
      DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt) ||
      tieBreak(a).localeCompare(tieBreak(b)),
  );

// ---- layerMemory ------------------------------------------------------------------------

interface State {
  readonly connections: HashMap.HashMap<string, ConnectionRecord>;
  readonly links: ReadonlyArray<ResourceLink>;
}

export const layerMemory = Layer.effect(
  ScimRecords,
  Effect.gen(function* () {
    const state = yield* Ref.make<State>({ connections: HashMap.empty(), links: [] });

    const createConnection: ScimRecordsShape["createConnection"] = (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const record: ConnectionRecord = {
          id: input.id,
          organizationId: input.organizationId,
          name: input.name,
          tokenHash: input.tokenHash,
          createdAt: now,
          revokedAt: Option.none(),
        };
        yield* Ref.update(state, (s) => ({
          ...s,
          connections: HashMap.set(s.connections, record.id, record),
        }));
        return record;
      });

    const findConnectionByTokenHash: ScimRecordsShape["findConnectionByTokenHash"] = (tokenHash) =>
      Ref.get(state).pipe(
        Effect.map((s) =>
          Option.fromNullishOr(
            Array.from(HashMap.values(s.connections)).find((row) => row.tokenHash === tokenHash),
          ),
        ),
      );

    const listConnections: ScimRecordsShape["listConnections"] = (organizationId) =>
      Ref.get(state).pipe(
        Effect.map((s) =>
          byCreation(
            Array.from(HashMap.values(s.connections)).filter(
              (row) => row.organizationId === organizationId,
            ),
            (row) => row.id,
          ),
        ),
      );

    const revokeConnection: ScimRecordsShape["revokeConnection"] = (organizationId, id) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const outcome = yield* Ref.modify(
          state,
          (s): readonly [Result.Result<ConnectionRecord, ScimRecordNotFound>, State] => {
            const existing = Option.filter(
              HashMap.get(s.connections, id),
              (row) => row.organizationId === organizationId,
            );
            if (Option.isNone(existing)) return [Result.fail(notFound(id)), s] as const;
            const revoked: ConnectionRecord = {
              ...existing.value,
              revokedAt: Option.isSome(existing.value.revokedAt)
                ? existing.value.revokedAt
                : Option.some(now),
            };
            return [
              Result.succeed(revoked),
              { ...s, connections: HashMap.set(s.connections, id, revoked) },
            ] as const;
          },
        );
        return yield* Effect.fromResult(outcome);
      });

    const sameResource = (
      row: ResourceLink,
      connectionId: string,
      kind: ResourceKind,
      resourceId: string,
    ) => row.connectionId === connectionId && row.kind === kind && row.resourceId === resourceId;

    /** The first uniqueness rule `candidate` would break among `links` (ignoring the row being written). */
    const clash = (
      links: ReadonlyArray<ResourceLink>,
      candidate: ResourceLink,
    ): Option.Option<"name" | "externalId"> => {
      const others = links.filter(
        (row) =>
          row.connectionId === candidate.connectionId &&
          row.kind === candidate.kind &&
          row.resourceId !== candidate.resourceId,
      );
      if (
        Option.isSome(candidate.name) &&
        others.some((row) => Option.getOrNull(row.name) === candidate.name.pipe(Option.getOrNull))
      ) {
        return Option.some("name");
      }
      if (
        Option.isSome(candidate.externalId) &&
        others.some(
          (row) => Option.getOrNull(row.externalId) === Option.getOrNull(candidate.externalId),
        )
      ) {
        return Option.some("externalId");
      }
      return Option.none();
    };

    const link: ScimRecordsShape["link"] = (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const record: ResourceLink = {
          connectionId: input.connectionId,
          kind: input.kind,
          resourceId: input.resourceId,
          name: Option.fromNullishOr(input.name),
          externalId: Option.fromNullishOr(input.externalId),
          createdAt: now,
          updatedAt: now,
        };
        const outcome = yield* Ref.modify(
          state,
          (s): readonly [Result.Result<ResourceLink, ScimLinkConflict>, State] => {
            const taken = clash(s.links, record);
            if (Option.isSome(taken)) return [Result.fail(conflict(taken.value)), s] as const;
            return [Result.succeed(record), { ...s, links: [...s.links, record] }] as const;
          },
        );
        return yield* Effect.fromResult(outcome);
      });

    const find: ScimRecordsShape["find"] = (connectionId, kind, resourceId) =>
      Ref.get(state).pipe(
        Effect.map((s) =>
          Option.fromNullishOr(
            s.links.find((row) => sameResource(row, connectionId, kind, resourceId)),
          ),
        ),
      );

    const findByName: ScimRecordsShape["findByName"] = (connectionId, kind, name) =>
      Ref.get(state).pipe(
        Effect.map((s) =>
          Option.fromNullishOr(
            s.links.find(
              (row) =>
                row.connectionId === connectionId &&
                row.kind === kind &&
                Option.getOrNull(row.name) === name,
            ),
          ),
        ),
      );

    const findByExternalId: ScimRecordsShape["findByExternalId"] = (
      connectionId,
      kind,
      externalId,
    ) =>
      Ref.get(state).pipe(
        Effect.map((s) =>
          Option.fromNullishOr(
            s.links.find(
              (row) =>
                row.connectionId === connectionId &&
                row.kind === kind &&
                Option.getOrNull(row.externalId) === externalId,
            ),
          ),
        ),
      );

    const list: ScimRecordsShape["list"] = (connectionId, kind, page) =>
      Ref.get(state).pipe(
        Effect.map((s) => {
          const all = byCreation(
            s.links.filter((row) => row.connectionId === connectionId && row.kind === kind),
            (row) => row.resourceId,
          );
          return { items: all.slice(page.offset, page.offset + page.limit), total: all.length };
        }),
      );

    const setExternalId: ScimRecordsShape["setExternalId"] = (
      connectionId,
      kind,
      resourceId,
      externalId,
    ) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const outcome = yield* Ref.modify(
          state,
          (
            s,
          ): readonly [Result.Result<ResourceLink, ScimRecordNotFound | ScimLinkConflict>, State] => {
            const existing = s.links.find((row) => sameResource(row, connectionId, kind, resourceId));
            if (existing === undefined) return [Result.fail(notFound(resourceId)), s] as const;
            const updated: ResourceLink = {
              ...existing,
              externalId: Option.fromNullOr(externalId),
              updatedAt: now,
            };
            const taken = clash(s.links, updated);
            if (Option.isSome(taken)) return [Result.fail(conflict(taken.value)), s] as const;
            return [
              Result.succeed(updated),
              {
                ...s,
                links: s.links.map((row) =>
                  sameResource(row, connectionId, kind, resourceId) ? updated : row,
                ),
              },
            ] as const;
          },
        );
        return yield* Effect.fromResult(outcome);
      });

    const unlink: ScimRecordsShape["unlink"] = (connectionId, kind, resourceId) =>
      Ref.update(state, (s) => ({
        ...s,
        links: s.links.filter((row) => !sameResource(row, connectionId, kind, resourceId)),
      }));

    return {
      createConnection,
      findConnectionByTokenHash,
      listConnections,
      revokeConnection,
      link,
      find,
      findByName,
      findByExternalId,
      list,
      setExternalId,
      unlink,
    };
  }),
);

// ---- layerSql -----------------------------------------------------------------------------

const makeConnectionRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({
    id: Schema.String,
    organizationId: Schema.String,
    name: Schema.String,
    tokenHash: Schema.String,
    createdAt: wire.dateTime,
    revokedAt: wire.nullableDateTime,
  });

const makeResourceRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({
    scimConnectionId: Schema.String,
    kind: Schema.Literals(["User", "Group"]),
    resourceId: Schema.String,
    name: Schema.NullOr(Schema.String),
    externalId: Schema.NullOr(Schema.String),
    createdAt: wire.dateTime,
    updatedAt: wire.dateTime,
  });

export const layerSql = Layer.effect(
  ScimRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // TS-001: the row codecs follow the ambient client's dialect (Date on pg, ISO string on SQLite).
    const wire = SqlModels.dialectFields(yield* SqlModels.resolveDialect(sql));
    const ConnectionRow = makeConnectionRow(wire);
    const ResourceRow = makeResourceRow(wire);

    const toConnection = (row: typeof ConnectionRow.Type): ConnectionRecord => ({
      id: row.id,
      organizationId: row.organizationId,
      name: row.name,
      tokenHash: row.tokenHash,
      createdAt: row.createdAt,
      revokedAt: Option.fromNullOr(row.revokedAt),
    });
    const toLink = (row: typeof ResourceRow.Type): ResourceLink => ({
      connectionId: row.scimConnectionId,
      kind: row.kind,
      resourceId: row.resourceId,
      name: Option.fromNullOr(row.name),
      externalId: Option.fromNullOr(row.externalId),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });

    const insertConnection = SqlSchema.findOne({
      Request: ConnectionRow,
      Result: ConnectionRow,
      execute: (r) => sql`
          INSERT INTO scim_connection (id, "organizationId", name, "tokenHash", "createdAt", "revokedAt")
          VALUES (${r.id}, ${r.organizationId}, ${r.name}, ${r.tokenHash}, ${r.createdAt}, NULL)
          RETURNING *
        `,
    });
    const connectionByHash = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: ConnectionRow,
      execute: (tokenHash) => sql`SELECT * FROM scim_connection WHERE "tokenHash" = ${tokenHash}`,
    });
    const connectionsOf = SqlSchema.findAll({
      Request: Schema.String,
      Result: ConnectionRow,
      execute: (organizationId) =>
        sql`SELECT * FROM scim_connection WHERE "organizationId" = ${organizationId} ORDER BY "createdAt", id`,
    });
    const revoke = SqlSchema.findOneOption({
      Request: Schema.Struct({
        organizationId: Schema.String,
        id: Schema.String,
        revokedAt: wire.dateTime,
      }),
      Result: ConnectionRow,
      execute: (r) => sql`
          UPDATE scim_connection SET "revokedAt" = COALESCE("revokedAt", ${r.revokedAt})
          WHERE id = ${r.id} AND "organizationId" = ${r.organizationId}
          RETURNING *
        `,
    });

    const insertLink = SqlSchema.findOne({
      Request: ResourceRow,
      Result: ResourceRow,
      execute: (r) => sql`
          INSERT INTO scim_resource ("scimConnectionId", kind, "resourceId", name, "externalId", "createdAt", "updatedAt")
          VALUES (${r.scimConnectionId}, ${r.kind}, ${r.resourceId}, ${r.name}, ${r.externalId}, ${r.createdAt}, ${r.updatedAt})
          RETURNING *
        `,
    });
    const linkKey = Schema.Struct({
      connectionId: Schema.String,
      kind: Schema.Literals(["User", "Group"]),
      value: Schema.String,
    });
    const findLink = SqlSchema.findOneOption({
      Request: linkKey,
      Result: ResourceRow,
      execute: (r) =>
        sql`SELECT * FROM scim_resource WHERE "scimConnectionId" = ${r.connectionId} AND kind = ${r.kind} AND "resourceId" = ${r.value}`,
    });
    const findLinkByName = SqlSchema.findOneOption({
      Request: linkKey,
      Result: ResourceRow,
      execute: (r) =>
        sql`SELECT * FROM scim_resource WHERE "scimConnectionId" = ${r.connectionId} AND kind = ${r.kind} AND name = ${r.value}`,
    });
    const findLinkByExternalId = SqlSchema.findOneOption({
      Request: linkKey,
      Result: ResourceRow,
      execute: (r) =>
        sql`SELECT * FROM scim_resource WHERE "scimConnectionId" = ${r.connectionId} AND kind = ${r.kind} AND "externalId" = ${r.value}`,
    });
    const listLinks = SqlSchema.findAll({
      Request: Schema.Struct({
        connectionId: Schema.String,
        kind: Schema.Literals(["User", "Group"]),
        offset: Schema.Int,
        limit: Schema.Int,
      }),
      Result: ResourceRow,
      execute: (r) => sql`
          SELECT * FROM scim_resource WHERE "scimConnectionId" = ${r.connectionId} AND kind = ${r.kind}
          ORDER BY "createdAt", "resourceId" LIMIT ${r.limit} OFFSET ${r.offset}
        `,
    });
    const countLinks = SqlSchema.findOne({
      Request: Schema.Struct({
        connectionId: Schema.String,
        kind: Schema.Literals(["User", "Group"]),
      }),
      Result: Schema.Struct({ count: Schema.Number }),
      execute: (r) =>
        sql`SELECT CAST(COUNT(*) AS INTEGER) AS count FROM scim_resource WHERE "scimConnectionId" = ${r.connectionId} AND kind = ${r.kind}`,
    });
    const updateExternalId = SqlSchema.findOneOption({
      Request: Schema.Struct({
        connectionId: Schema.String,
        kind: Schema.Literals(["User", "Group"]),
        resourceId: Schema.String,
        externalId: Schema.NullOr(Schema.String),
        updatedAt: wire.dateTime,
      }),
      Result: ResourceRow,
      execute: (r) => sql`
          UPDATE scim_resource SET "externalId" = ${r.externalId}, "updatedAt" = ${r.updatedAt}
          WHERE "scimConnectionId" = ${r.connectionId} AND kind = ${r.kind} AND "resourceId" = ${r.resourceId}
          RETURNING *
        `,
    });

    /**
     * Which uniqueness rule a failed write broke. Postgres names the violated index
     * (`scim_resource_external_id_unique`); SQLite lists the columns (`... .externalId`) —
     * either way the text says `external` for the external id and nothing of the sort for `name`.
     */
    const conflictField = (reason: {
      readonly message: string;
      readonly cause?: unknown;
      readonly constraint?: string | undefined;
    }): "name" | "externalId" =>
      `${reason.constraint ?? ""} ${reason.message} ${String(reason.cause)}`
        .toLowerCase()
        .includes("external")
        ? "externalId"
        : "name";

    const createConnection: ScimRecordsShape["createConnection"] = (input) =>
      DateTime.now.pipe(
        Effect.flatMap((now) =>
          insertConnection({
            id: input.id,
            organizationId: input.organizationId,
            name: input.name,
            tokenHash: input.tokenHash,
            createdAt: now,
            revokedAt: null,
          }),
        ),
        Effect.map(toConnection),
        Effect.orDie,
      );

    const findConnectionByTokenHash: ScimRecordsShape["findConnectionByTokenHash"] = (tokenHash) =>
      connectionByHash(tokenHash).pipe(Effect.map(Option.map(toConnection)), Effect.orDie);

    const listConnections: ScimRecordsShape["listConnections"] = (organizationId) =>
      connectionsOf(organizationId).pipe(
        Effect.map((rows) => rows.map(toConnection)),
        Effect.orDie,
      );

    const revokeConnection: ScimRecordsShape["revokeConnection"] = Effect.fnUntraced(
      function* (organizationId, id) {
        const now = yield* DateTime.now;
        const row = yield* revoke({ organizationId, id, revokedAt: now }).pipe(Effect.orDie);
        if (Option.isNone(row)) return yield* Effect.fail(notFound(id));
        return toConnection(row.value);
      },
    );

    const link: ScimRecordsShape["link"] = (input) =>
      DateTime.now.pipe(
        Effect.flatMap((now) =>
          insertLink({
            scimConnectionId: input.connectionId,
            kind: input.kind,
            resourceId: input.resourceId,
            name: input.name ?? null,
            externalId: input.externalId ?? null,
            createdAt: now,
            updatedAt: now,
          }),
        ),
        Effect.map(toLink),
        Effect.catchTag("SqlError", (error) =>
          error.reason._tag === "UniqueViolation"
            ? Effect.fail(conflict(conflictField(error.reason)))
            : Effect.die(error),
        ),
        Effect.catchTag("SchemaError", Effect.die),
        Effect.catchTag("NoSuchElementError", Effect.die),
      );

    const find: ScimRecordsShape["find"] = (connectionId, kind, resourceId) =>
      findLink({ connectionId, kind, value: resourceId }).pipe(
        Effect.map(Option.map(toLink)),
        Effect.orDie,
      );

    const findByName: ScimRecordsShape["findByName"] = (connectionId, kind, name) =>
      findLinkByName({ connectionId, kind, value: name }).pipe(
        Effect.map(Option.map(toLink)),
        Effect.orDie,
      );

    const findByExternalId: ScimRecordsShape["findByExternalId"] = (
      connectionId,
      kind,
      externalId,
    ) =>
      findLinkByExternalId({ connectionId, kind, value: externalId }).pipe(
        Effect.map(Option.map(toLink)),
        Effect.orDie,
      );

    const list: ScimRecordsShape["list"] = (connectionId, kind, page) =>
      Effect.all({
        rows: listLinks({ connectionId, kind, offset: page.offset, limit: page.limit }),
        total: countLinks({ connectionId, kind }),
      }).pipe(
        Effect.map(({ rows, total }) => ({ items: rows.map(toLink), total: total.count })),
        Effect.orDie,
      );

    const setExternalId: ScimRecordsShape["setExternalId"] = Effect.fnUntraced(
      function* (connectionId, kind, resourceId, externalId) {
        const now = yield* DateTime.now;
        const row = yield* updateExternalId({
          connectionId,
          kind,
          resourceId,
          externalId,
          updatedAt: now,
        }).pipe(
          Effect.catchTag("SqlError", (error) =>
            error.reason._tag === "UniqueViolation"
              ? Effect.fail(conflict("externalId"))
              : Effect.die(error),
          ),
          Effect.catchTag("SchemaError", Effect.die),
        );
        if (Option.isNone(row)) return yield* Effect.fail(notFound(resourceId));
        return toLink(row.value);
      },
    );

    const unlink: ScimRecordsShape["unlink"] = (connectionId, kind, resourceId) =>
      sql`DELETE FROM scim_resource WHERE "scimConnectionId" = ${connectionId} AND kind = ${kind} AND "resourceId" = ${resourceId}`.pipe(
        Effect.orDie,
        Effect.asVoid,
      );

    return {
      createConnection,
      findConnectionByTokenHash,
      listConnections,
      revokeConnection,
      link,
      find,
      findByName,
      findByExternalId,
      list,
      setExternalId,
      unlink,
    };
  }),
);
