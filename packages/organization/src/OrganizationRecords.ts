// @awthaq/organization — OrganizationRecords
//
// spec.md's "Organization entity & CRUD": persistence for the
// `organization` table, built the same way `@awthaq/admin`'s own
// `ImpersonationRecords.ts` builds `admin_impersonation` — directly against
// `effect/unstable/sql`'s `SqlSchema`, owned by this plugin rather than the
// shared persistence stratum.

import { Models as SqlModels } from "@awthaq/sql";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
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

export interface OrganizationRecord {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly logo: Option.Option<string>;
  readonly metadata: Option.Option<string>;
  /**
   * DRS-007: the organization's residency region, drawn from the configured
   * `OrganizationConfig.regions` vocabulary. `None` until set. Application
   * routing (which shard or database serves this tenant) reads it through
   * `homeRegionOf`; nothing here interprets it.
   */
  readonly homeRegion: Option.Option<string>;
  /**
   * EP-003: `Some` while the organization is suspended by a platform
   * administrator (ADR-EA-018). Reversible — a suspended organization keeps
   * every row and is refused access until reinstated.
   */
  readonly suspendedAt: Option.Option<DateTime.Utc>;
  readonly createdAt: DateTime.Utc;
}

export class OrganizationRecordSlugTaken extends Data.TaggedError("OrganizationRecordSlugTaken")<{
  readonly slug: string;
}> {}

export class OrganizationRecordNotFound extends Data.TaggedError("OrganizationRecordNotFound")<{
  readonly id: string;
}> {}

export interface OrganizationRecordsShape {
  readonly create: (input: {
    readonly name: string;
    readonly slug: string;
    readonly logo?: string | undefined;
    readonly metadata?: string | undefined;
    readonly homeRegion?: string | undefined;
  }) => Effect.Effect<OrganizationRecord, OrganizationRecordSlugTaken>;
  readonly findById: (id: string) => Effect.Effect<Option.Option<OrganizationRecord>>;
  readonly findBySlug: (slug: string) => Effect.Effect<Option.Option<OrganizationRecord>>;
  readonly update: (
    id: string,
    input: {
      readonly name?: string | undefined;
      readonly slug?: string | undefined;
      readonly logo?: string | null | undefined;
      readonly metadata?: string | null | undefined;
      readonly homeRegion?: string | null | undefined;
    },
  ) => Effect.Effect<OrganizationRecord, OrganizationRecordNotFound | OrganizationRecordSlugTaken>;
  /** EP-003: suspends (`Some(at)`) or reinstates (`None`) the organization. */
  readonly setSuspended: (
    id: string,
    at: Option.Option<DateTime.Utc>,
  ) => Effect.Effect<OrganizationRecord, OrganizationRecordNotFound>;
  /** EP-003: every organization, keyset-paginated on `(createdAt, id)` ascending — the platform administrator's listing, never a tenant-scoped read. */
  readonly listPage: (input: {
    readonly after: Option.Option<{ readonly createdAt: DateTime.Utc; readonly id: string }>;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<OrganizationRecord>>;
  readonly delete: (id: string) => Effect.Effect<void, OrganizationRecordNotFound>;
  readonly listByIds: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<OrganizationRecord>>;
}

export class OrganizationRecords extends Context.Service<
  OrganizationRecords,
  OrganizationRecordsShape
>()("awthaq/organization/OrganizationRecords") {}

const notFound = (id: string): OrganizationRecordNotFound => new OrganizationRecordNotFound({ id });
const slugTaken = (slug: string): OrganizationRecordSlugTaken =>
  new OrganizationRecordSlugTaken({ slug });

// ---- layerMemory ------------------------------------------------------------

type State = HashMap.HashMap<string, OrganizationRecord>;

export const layerMemory = Layer.effect(
  OrganizationRecords,
  Effect.gen(function* () {
    const state = yield* Ref.make<State>(HashMap.empty());
    const crypto = yield* Crypto.Crypto;

    const findBySlugSync = (records: State, slug: string): Option.Option<OrganizationRecord> =>
      Option.fromNullishOr(Array.from(HashMap.values(records)).find((row) => row.slug === slug));

    const create: OrganizationRecordsShape["create"] = Effect.fnUntraced(function* (input) {
      const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
      const now = yield* DateTime.now;
      const outcome = yield* Ref.modify(
        state,
        (s): readonly [Result.Result<OrganizationRecord, OrganizationRecordSlugTaken>, State] => {
          if (Option.isSome(findBySlugSync(s, input.slug))) {
            return [Result.fail(slugTaken(input.slug)), s] as const;
          }
          const record: OrganizationRecord = {
            id,
            name: input.name,
            slug: input.slug,
            logo: Option.fromNullishOr(input.logo),
            metadata: Option.fromNullishOr(input.metadata),
            homeRegion: Option.fromNullishOr(input.homeRegion),
            suspendedAt: Option.none(),
            createdAt: now,
          };
          return [Result.succeed(record), HashMap.set(s, id, record)] as const;
        },
      );
      return yield* Effect.fromResult(outcome);
    });

    const findById: OrganizationRecordsShape["findById"] = (id) =>
      Ref.get(state).pipe(Effect.map((s) => HashMap.get(s, id)));

    const findBySlug: OrganizationRecordsShape["findBySlug"] = (slug) =>
      Ref.get(state).pipe(Effect.map((s) => findBySlugSync(s, slug)));

    const update: OrganizationRecordsShape["update"] = (id, input) =>
      Ref.modify(
        state,
        (
          s,
        ): readonly [
          Result.Result<
            OrganizationRecord,
            OrganizationRecordNotFound | OrganizationRecordSlugTaken
          >,
          State,
        ] => {
          const existing = HashMap.get(s, id);
          if (Option.isNone(existing)) return [Result.fail(notFound(id)), s] as const;
          if (input.slug !== undefined && input.slug !== existing.value.slug) {
            const collision = findBySlugSync(s, input.slug);
            if (Option.isSome(collision)) {
              return [Result.fail(slugTaken(input.slug)), s] as const;
            }
          }
          const updated: OrganizationRecord = {
            ...existing.value,
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.slug !== undefined ? { slug: input.slug } : {}),
            ...(input.logo !== undefined ? { logo: Option.fromNullishOr(input.logo) } : {}),
            ...(input.metadata !== undefined
              ? { metadata: Option.fromNullishOr(input.metadata) }
              : {}),
            ...(input.homeRegion !== undefined
              ? { homeRegion: Option.fromNullishOr(input.homeRegion) }
              : {}),
          };
          return [Result.succeed(updated), HashMap.set(s, id, updated)] as const;
        },
      ).pipe(Effect.flatMap(Effect.fromResult));

    const setSuspended: OrganizationRecordsShape["setSuspended"] = (id, at) =>
      Ref.modify(
        state,
        (s): readonly [Result.Result<OrganizationRecord, OrganizationRecordNotFound>, State] => {
          const existing = HashMap.get(s, id);
          if (Option.isNone(existing)) return [Result.fail(notFound(id)), s] as const;
          const updated: OrganizationRecord = { ...existing.value, suspendedAt: at };
          return [Result.succeed(updated), HashMap.set(s, id, updated)] as const;
        },
      ).pipe(Effect.flatMap(Effect.fromResult));

    const listPage: OrganizationRecordsShape["listPage"] = ({ after, limit }) =>
      Ref.get(state).pipe(
        Effect.map((s) =>
          Array.from(HashMap.values(s))
            .sort(
              (a, b) =>
                DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt) ||
                a.id.localeCompare(b.id),
            )
            .filter((row) =>
              Option.match(after, {
                onNone: () => true,
                onSome: (cursor) => {
                  const delta =
                    DateTime.toEpochMillis(row.createdAt) -
                    DateTime.toEpochMillis(cursor.createdAt);
                  return delta > 0 || (delta === 0 && row.id > cursor.id);
                },
              }),
            )
            .slice(0, limit),
        ),
      );

    const delete_: OrganizationRecordsShape["delete"] = (id) =>
      Ref.modify(state, (s): readonly [Result.Result<void, OrganizationRecordNotFound>, State] => {
        if (!HashMap.has(s, id)) return [Result.fail(notFound(id)), s] as const;
        return [Result.succeed(undefined), HashMap.remove(s, id)] as const;
      }).pipe(Effect.flatMap(Effect.fromResult));

    const listByIds: OrganizationRecordsShape["listByIds"] = (ids) =>
      Ref.get(state).pipe(
        Effect.map((s) => ids.flatMap((id) => Option.toArray(HashMap.get(s, id)))),
      );

    return {
      create,
      findById,
      findBySlug,
      update,
      setSuspended,
      listPage,
      delete: delete_,
      listByIds,
    };
  }),
);

// ---- layerSql -----------------------------------------------------------------

const makeOrganizationRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    slug: Schema.String,
    logo: Schema.NullOr(Schema.String),
    metadata: Schema.NullOr(Schema.String),
    homeRegion: Schema.NullOr(Schema.String),
    suspendedAt: wire.nullableDateTime,
    createdAt: wire.dateTime,
  });

type OrganizationRow = ReturnType<typeof makeOrganizationRow>["Type"];

const toRecord = (row: OrganizationRow): OrganizationRecord => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  logo: Option.fromNullishOr(row.logo),
  metadata: Option.fromNullishOr(row.metadata),
  homeRegion: Option.fromNullishOr(row.homeRegion),
  suspendedAt: Option.fromNullishOr(row.suspendedAt),
  createdAt: row.createdAt,
});

export const layerSql = Layer.effect(
  OrganizationRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // TS-001: the row codecs follow the ambient client's dialect (Date on pg, ISO string on SQLite).
    const wire = SqlModels.dialectFields(yield* SqlModels.resolveDialect(sql));
    const OrganizationRow = makeOrganizationRow(wire);
    const crypto = yield* Crypto.Crypto;

    const insert = SqlSchema.findOne({
      Request: Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        slug: Schema.String,
        logo: Schema.NullOr(Schema.String),
        metadata: Schema.NullOr(Schema.String),
        homeRegion: Schema.NullOr(Schema.String),
        createdAt: wire.dateTime,
      }),
      Result: OrganizationRow,
      execute: (r) => sql`
          INSERT INTO organization_org (id, name, slug, logo, metadata, "homeRegion", "createdAt")
          VALUES (${r.id}, ${r.name}, ${r.slug}, ${r.logo}, ${r.metadata}, ${r.homeRegion}, ${r.createdAt})
          RETURNING *
        `,
    });

    const findByIdQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: OrganizationRow,
      execute: (id) => sql`SELECT * FROM organization_org WHERE id = ${id}`,
    });

    const findBySlugQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: OrganizationRow,
      execute: (slug) => sql`SELECT * FROM organization_org WHERE slug = ${slug}`,
    });

    const deleteQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: OrganizationRow,
      execute: (id) => sql`DELETE FROM organization_org WHERE id = ${id} RETURNING *`,
    });

    const listByIdsBase = SqlSchema.findAll({
      Request: Schema.Array(Schema.String),
      Result: OrganizationRow,
      execute: (r) => sql`SELECT * FROM organization_org WHERE id IN ${sql.in(r)}`,
    });

    const listByIdsQuery = (ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const empty: ReadonlyArray<OrganizationRow> = [];
        if (ids.length === 0) return empty;
        return yield* listByIdsBase(ids);
      });

    const create: OrganizationRecordsShape["create"] = Effect.fnUntraced(function* (input) {
      const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
      const now = yield* DateTime.now;
      const row = yield* insert({
        id,
        name: input.name,
        slug: input.slug,
        logo: input.logo ?? null,
        metadata: input.metadata ?? null,
        homeRegion: input.homeRegion ?? null,
        createdAt: now,
      }).pipe(
        Effect.catchTag("SqlError", (error) =>
          error.reason._tag === "UniqueViolation"
            ? Effect.fail(slugTaken(input.slug))
            : Effect.die(error),
        ),
        Effect.catchTag("SchemaError", Effect.die),
        Effect.catchTag("NoSuchElementError", Effect.die),
      );
      return toRecord(row);
    });

    const findById: OrganizationRecordsShape["findById"] = (id) =>
      findByIdQuery(id).pipe(Effect.map(Option.map(toRecord)), Effect.orDie);

    const findBySlug: OrganizationRecordsShape["findBySlug"] = (slug) =>
      findBySlugQuery(slug).pipe(Effect.map(Option.map(toRecord)), Effect.orDie);

    const update: OrganizationRecordsShape["update"] = Effect.fnUntraced(function* (id, input) {
      const existing = yield* findByIdQuery(id).pipe(Effect.orDie);
      if (Option.isNone(existing)) return yield* Effect.fail(notFound(id));
      const current = existing.value;
      const nextSlug = input.slug ?? current.slug;
      const nextLogo = input.logo === undefined ? current.logo : input.logo;
      const nextMetadata = input.metadata === undefined ? current.metadata : input.metadata;
      const nextHomeRegion = input.homeRegion === undefined ? current.homeRegion : input.homeRegion;
      const updateQuery = SqlSchema.findOneOption({
        Request: Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          slug: Schema.String,
          logo: Schema.NullOr(Schema.String),
          metadata: Schema.NullOr(Schema.String),
          homeRegion: Schema.NullOr(Schema.String),
        }),
        Result: OrganizationRow,
        execute: (r) => sql`
            UPDATE organization_org SET name = ${r.name}, slug = ${r.slug}, logo = ${r.logo}, metadata = ${r.metadata}, "homeRegion" = ${r.homeRegion}
            WHERE id = ${r.id}
            RETURNING *
          `,
      });
      const row = yield* updateQuery({
        id,
        name: input.name ?? current.name,
        slug: nextSlug,
        logo: nextLogo,
        metadata: nextMetadata,
        homeRegion: nextHomeRegion,
      }).pipe(
        Effect.catchTag("SqlError", (error) =>
          error.reason._tag === "UniqueViolation"
            ? Effect.fail(slugTaken(nextSlug))
            : Effect.die(error),
        ),
        Effect.catchTag("SchemaError", Effect.die),
      );
      if (Option.isNone(row)) return yield* Effect.fail(notFound(id));
      return toRecord(row.value);
    });

    const setSuspendedQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ id: Schema.String, suspendedAt: wire.nullableDateTime }),
      Result: OrganizationRow,
      execute: (r) => sql`
          UPDATE organization_org SET "suspendedAt" = ${r.suspendedAt} WHERE id = ${r.id} RETURNING *
        `,
    });

    const setSuspended: OrganizationRecordsShape["setSuspended"] = Effect.fnUntraced(
      function* (id, at) {
        const row = yield* setSuspendedQuery({ id, suspendedAt: Option.getOrNull(at) }).pipe(
          Effect.orDie,
        );
        if (Option.isNone(row)) return yield* Effect.fail(notFound(id));
        return toRecord(row.value);
      },
    );

    const listPageQuery = SqlSchema.findAll({
      Request: Schema.Struct({
        afterCreatedAt: wire.nullableDateTime,
        afterId: Schema.NullOr(Schema.String),
        limit: Schema.Number,
      }),
      Result: OrganizationRow,
      execute: (r) =>
        r.afterCreatedAt === null || r.afterId === null
          ? sql`SELECT * FROM organization_org ORDER BY "createdAt", id LIMIT ${r.limit}`
          : sql`SELECT * FROM organization_org
                WHERE ("createdAt", id) > (${r.afterCreatedAt}, ${r.afterId})
                ORDER BY "createdAt", id LIMIT ${r.limit}`,
    });

    const listPage: OrganizationRecordsShape["listPage"] = ({ after, limit }) =>
      listPageQuery({
        afterCreatedAt: Option.match(after, { onNone: () => null, onSome: (c) => c.createdAt }),
        afterId: Option.match(after, { onNone: () => null, onSome: (c) => c.id }),
        limit,
      }).pipe(
        Effect.map((rows) => rows.map(toRecord)),
        Effect.orDie,
      );

    const delete_: OrganizationRecordsShape["delete"] = Effect.fnUntraced(function* (id) {
      const row = yield* deleteQuery(id).pipe(Effect.orDie);
      if (Option.isNone(row)) return yield* Effect.fail(notFound(id));
    });

    const listByIds: OrganizationRecordsShape["listByIds"] = (ids) =>
      listByIdsQuery(ids).pipe(
        Effect.map((rows) => rows.map(toRecord)),
        Effect.orDie,
      );

    return {
      create,
      findById,
      findBySlug,
      update,
      setSuspended,
      listPage,
      delete: delete_,
      listByIds,
    };
  }),
);
