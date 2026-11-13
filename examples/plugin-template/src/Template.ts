// plugin-template — Template
//
// The smallest plugin that still shows every convention: a config
// `Context.Reference`, one tenant-partitioned table with dialect-branched migrations, a records
// service with a memory and a SQL adapter, a veto + an observe hook point, an `HttpApiGroup` with
// handlers, and `AuthPlugin.Service` tying them together. `docs/plugin-authoring.md` walks
// through this file top to bottom; `test/Template.test.ts` keeps it honest.

import { Api } from "@awthaq/api";
import {
  AuthEvents,
  AuthPlugin,
  ConfigDescriptor,
  CurrentUser,
  HookPoint,
  Migrations,
  RateLimits,
} from "@awthaq/core";
import { RateLimiter, Tenant } from "@awthaq/ports";
import { Models as SqlModels, SqlStore, StoreFailure, TenantScoped } from "@awthaq/sql";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as NotesEvents from "./NotesEvents.ts";
import * as TemplateApi from "./TemplateApi.ts";

// ---- config: a Context.Reference with a default (BEH-EA-017) -----------------------
// Policy knobs are a Reference, not a required service: the plugin works with no
// setup, and an app overrides it with `Notes.config({...})`.

export interface NotesConfigShape {
  readonly maxLength: number;
  /** How many notes one owner may keep in a tenant; the store enforces it atomically. */
  readonly maxNotesPerOwner: number;
}

const defaultConfig: NotesConfigShape = { maxLength: 500, maxNotesPerOwner: 100 };

export const NotesConfig: Context.Reference<NotesConfigShape> = Context.Reference(
  "example/notes/Config",
  { defaultValue: () => defaultConfig },
);

/**
 * What a plugin author decides here: the scope (`perTenant`: a tenant's own `Template.config(...)` governs its requests;
 * `perDeployment` for a setting that cannot vary), and any `boot` field no operation reads from the tenant's value.
 * Both limits are read per operation, so there is no boot field. ADR-EA-018 D8, BEH-EA-355.
 */
export const NotesConfigScoped = Tenant.perTenant(NotesConfig);

export const config = (partial: Partial<NotesConfigShape>) =>
  NotesConfigScoped.layer({ ...defaultConfig, ...partial });

// ---- hook points: one veto (before) + one observe (after) --------------------------
// A tap can amend or abort the operation (veto) or watch it (observe). The input
// schema is only a type carrier. Every point's own `.layer` must be provided once.

const NoteInput = Schema.Struct({ owner: Schema.String, text: Schema.String });

export class BeforeCreateNote extends HookPoint.veto<BeforeCreateNote>()(
  "notes.create.before",
  NoteInput,
) {}

export class AfterCreateNote extends HookPoint.observe<AfterCreateNote>()(
  "notes.create.after",
  Schema.Struct({ ...NoteInput.fields, noteId: Schema.String }),
) {}

export const NotesHooksLive = Layer.mergeAll(BeforeCreateNote.layer, AfterCreateNote.layer);

// ---- persistence: a records service over one table ---------------------------------
// The plugin owns its tables; the table prefix is the plugin id. Columns are single
// lowercase words so the same statement decodes on SQLite and Postgres alike (the tenant
// column is the one quoted camelCase exception, `"tenantId"`, quoted in every statement).
//
// Four conventions every records module follows (docs/plugin-authoring.md):
//   - two adapters, `layerMemory` and `layerSql`, behind one shape and one conformance suite;
//   - the table is *partitioned* by tenant: an insert is stamped with the ambient tenant
//     (`TenantScoped.stamp`) and every read is confined to it (`TenantScoped.predicate` in SQL,
//     `TenantScoped.matches` in memory), so isolation lives in the store, not in the service;
//   - a store failure is the typed `StoreUnavailable` (`StoreFailure`), never a defect;
//   - a method that must see other tenants takes a `TenantScoped.CrossTenant` witness (this
//     template has none: the owner's notes are tenant-local).
//
// And one rule (ADR-EA-041 decision 9): an invariant over several rows is enforced by the write
// that could break it, atomically. The per-owner quota is such an invariant: `create` takes the
// limit and refuses at it, in one `Ref.modify` in memory and inside `SqlStore.atomically` (one
// transaction holding the owner's lock on Postgres) in SQL. Counting first and inserting second, in
// two calls, would let two concurrent creates both pass at `limit - 1`. The service keeps an earlier
// check, but only so the refusal comes before the veto hook; the store's answer is the authority.
// Its contract suite (`test/contract/NoteRecords.ts`) classifies every method and races `create`.

export interface NoteRecord {
  readonly id: string;
  readonly owner: string;
  readonly text: string;
  readonly created: DateTime.Utc;
  /** The tenant the note was written under; `None` for a deployment without tenants. */
  readonly tenantId: Option.Option<string>;
}

/** The owner already keeps `limit` notes in the ambient tenant. */
export class NoteRecordLimitReached extends Data.TaggedError("NoteRecords/LimitReached")<{
  readonly owner: string;
  readonly limit: number;
}> {}

export interface NoteRecordsShape {
  /**
   * Stamped with the ambient tenant. Atomic: with `within`, refuses with `NoteRecordLimitReached` when
   * the owner already keeps that many notes in the ambient tenant (the count and the insert are one step).
   */
  readonly create: (
    input: { readonly owner: string; readonly text: string },
    options?: { readonly within?: number },
  ) => Effect.Effect<NoteRecord, NoteRecordLimitReached | StoreFailure.StoreUnavailable>;
  /** The owner's notes in the ambient tenant, oldest first. */
  readonly listByOwner: (
    owner: string,
  ) => Effect.Effect<ReadonlyArray<NoteRecord>, StoreFailure.StoreUnavailable>;
}

export class NoteRecords extends Context.Service<NoteRecords, NoteRecordsShape>()(
  "example/notes/records/NoteRecords",
) {}

export const layerMemory = Layer.effect(
  NoteRecords,
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const state = yield* Ref.make<ReadonlyArray<NoteRecord>>([]);

    const create: NoteRecordsShape["create"] = Effect.fnUntraced(function* (input, options) {
      const id = yield* random.uuidV7();
      const created = yield* DateTime.now;
      const stamped = yield* TenantScoped.stamp({ tenantId: null });
      const seen = yield* TenantScoped.visibility();
      const record: NoteRecord = {
        id,
        owner: input.owner,
        text: input.text,
        created,
        tenantId: Option.fromNullishOr(stamped.tenantId),
      };
      const limit = options?.within;
      // The count and the insert in one `Ref.modify`: no other create can land between them.
      const stored = yield* Ref.modify(
        state,
        (rows): readonly [boolean, ReadonlyArray<NoteRecord>] => {
          const held = rows.filter(
            (row) =>
              row.owner === input.owner &&
              TenantScoped.matches(Option.getOrNull(row.tenantId), seen),
          ).length;
          return limit !== undefined && held >= limit ? [false, rows] : [true, [...rows, record]];
        },
      );
      if (!stored && limit !== undefined) {
        return yield* Effect.fail(new NoteRecordLimitReached({ owner: input.owner, limit }));
      }
      return record;
    });

    const listByOwner: NoteRecordsShape["listByOwner"] = Effect.fnUntraced(function* (owner) {
      const seen = yield* TenantScoped.visibility();
      return (yield* Ref.get(state)).filter(
        (row) => row.owner === owner && TenantScoped.matches(Option.getOrNull(row.tenantId), seen),
      );
    });

    return { create, listByOwner };
  }),
);

// The row codec follows the dialect: SQLite stores `created` as TEXT, Postgres hands back a `Date`.
const noteRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({
    id: Schema.String,
    owner: Schema.String,
    text: Schema.String,
    created: wire.dateTime,
    tenantId: Schema.NullOr(Schema.String),
  });

const toRecord = (row: {
  id: string;
  owner: string;
  text: string;
  created: DateTime.Utc;
  tenantId: string | null;
}): NoteRecord => ({
  id: row.id,
  owner: row.owner,
  text: row.text,
  created: row.created,
  tenantId: Option.fromNullishOr(row.tenantId),
});

export const layerSql = Layer.effect(
  NoteRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const random = yield* SecureRandom.SecureRandom;
    const NoteRow = noteRow(SqlModels.dialectFields(yield* SqlModels.resolveDialect(sql)));

    const insert = SqlSchema.findOne({
      Request: NoteRow,
      Result: NoteRow,
      execute: (r) =>
        sql`INSERT INTO notes_note (id, owner, text, created, "tenantId") VALUES (${r.id}, ${r.owner}, ${r.text}, ${r.created}, ${r.tenantId}) RETURNING *`,
    });
    const decodeNotes = Schema.decodeUnknownEffect(Schema.Array(NoteRow));
    const listByOwner = (owner: string, seen: TenantScoped.Visibility) =>
      sql`SELECT * FROM notes_note WHERE owner = ${owner} AND ${TenantScoped.predicate(sql, "tenantId", seen)} ORDER BY created ASC`.pipe(
        Effect.flatMap(decodeNotes),
      );

    const countByOwner = (owner: string, seen: TenantScoped.Visibility) =>
      sql<{
        readonly n: number | string;
      }>`SELECT COUNT(*) AS n FROM notes_note WHERE owner = ${owner} AND ${TenantScoped.predicate(sql, "tenantId", seen)}`.pipe(
        Effect.map((rows) => Number(rows[0]?.n ?? 0)),
      );

    const create: NoteRecordsShape["create"] = Effect.fnUntraced(function* (input, options) {
      const id = yield* random.uuidV7();
      const created = yield* DateTime.now;
      const stamped = yield* TenantScoped.stamp({ tenantId: null });
      const seen = yield* TenantScoped.visibility();
      const limit = options?.within;
      const write = insert({
        id,
        owner: input.owner,
        text: input.text,
        created,
        tenantId: stamped.tenantId,
      }).pipe(Effect.map(toRecord));
      // One transaction holding the owner's lock (Postgres): the count and the insert are one step.
      const guarded =
        limit === undefined
          ? write
          : SqlStore.atomically(
              sql,
              `notes_note:owner:${input.owner}`,
            )(
              Effect.gen(function* () {
                if ((yield* countByOwner(input.owner, seen)) >= limit) {
                  return yield* Effect.fail(
                    new NoteRecordLimitReached({ owner: input.owner, limit }),
                  );
                }
                return yield* write;
              }),
            );
      return yield* guarded.pipe(StoreFailure.orStoreUnavailable("NoteRecords.create"));
    });

    const listByOwnerOf: NoteRecordsShape["listByOwner"] = Effect.fnUntraced(function* (owner) {
      const tenant = yield* TenantScoped.visibility();
      return yield* listByOwner(owner, tenant).pipe(
        Effect.map((rows) => rows.map(toRecord)),
        StoreFailure.orStoreUnavailable("NoteRecords.listByOwner"),
      );
    });

    return { create, listByOwner: listByOwnerOf };
  }),
);

// ---- migrations: append-only, dialect-branched -------------------------------------
// Never edit a shipped migration; add a new entry (the tenant column below is the second
// one: the table was created first, and a shipped plugin adds a column the same way).
// `sql.onDialectOrElse` is how a statement differs between Postgres and SQLite (here only
// the timestamp type).

const notesMigrations: Migrations.Migrations = [
  {
    name: "create_notes_note",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE notes_note (
            id TEXT PRIMARY KEY,
            owner TEXT NOT NULL,
            text TEXT NOT NULL,
            created TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE notes_note (
            id TEXT PRIMARY KEY,
            owner TEXT NOT NULL,
            text TEXT NOT NULL,
            created TEXT NOT NULL
          )`,
        orElse: () => Effect.die(new Error("notes: unsupported SQL dialect for migrations")),
      });
    }),
  },
  {
    // Partitioned tables carry a nullable, indexed tenant column: NULL is an untenanted row.
    name: "add_notes_note_tenant_id",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE notes_note ADD COLUMN "tenantId" TEXT`;
      yield* sql`CREATE INDEX notes_note_tenant_id ON notes_note ("tenantId")`;
    }),
  },
];

// ---- the service shape and the plugin -----------------------------------------------

export interface NotesShape {
  readonly create: (
    caller: CurrentUser.Caller,
    text: string,
  ) => Effect.Effect<
    NoteRecord,
    | TemplateApi.NoteTooLong
    | TemplateApi.NoteLimitReached
    | HookPoint.HookAborted
    | Api.RateLimited
    | StoreFailure.StoreUnavailable
  >;
  readonly list: (
    caller: CurrentUser.Caller,
  ) => Effect.Effect<ReadonlyArray<NoteRecord>, StoreFailure.StoreUnavailable>;
}

const toDto = (record: NoteRecord) =>
  new TemplateApi.NoteDto({
    id: record.id,
    text: record.text,
    createdAt: DateTime.formatIso(record.created),
  });

export const NotesHandlers = HttpApiBuilder.group(
  TemplateApi.NotesApi,
  "notes",
  Effect.fnUntraced(function* (handlers) {
    const notes = yield* Notes;
    return handlers.handleAll({
      create: Effect.fnUntraced(function* ({
        payload,
      }: {
        payload: TemplateApi.CreateNotePayload;
      }) {
        const caller = yield* CurrentUser.current;
        return toDto(yield* notes.create(caller, payload.text));
      }),
      list: Effect.fnUntraced(function* () {
        const caller = yield* CurrentUser.current;
        return (yield* notes.list(caller)).map(toDto);
      }),
    });
  }),
);

// ---- rate limits: declared once, spent by name ---------------------------------------
// A plugin that throttles declares a typed table of rules; `group` must be one of the plugin's own
// contract groups (a compile error otherwise) and `key` says what a bucket counts (`Key.user`: the
// signed-in caller; `Key.ip` for an anonymous endpoint (it reads the request context's address, ADR-EA-047,
// so the spend passes none), `Key.email`, `Key.custom`, ...). The static
// `rateLimits` listing (`awthaq plugin list --rules`) is derived from this table, and `make` opens a
// budget over it; `AuthPlugin.layer` refuses a plugin that declares rules and never opens one.

const rules = {
  createByUser: RateLimits.rule({
    group: "notes",
    endpoint: "create",
    key: RateLimits.Key.user,
    limit: 5,
    window: Duration.minutes(1),
  }),
};

export class Notes extends AuthPlugin.Service<Notes, NotesShape>()("notes", {
  apiVersion: 1,
  contract: TemplateApi.NotesApi,
  rateLimitRules: rules,
  tables: {
    // Partitioned: the store stamps the ambient tenant at insert and confines reads to it.
    notes_note: AuthPlugin.Table.partitioned(),
  },
  migrations: notesMigrations,
  // The record store, memory and SQL, matched: both adapters behind one shape (the compiler checks the pair provides
  // every `/records/` store the layer requires, the same stores in both, and nothing else).
  records: { memory: layerMemory, sql: layerSql },
  // The hook points this plugin owns (`BeforeCreateNote`/`AfterCreateNote`): a plugin layer that requires a
  // point it does not declare here does not compile, and `TestAuth.layer` provides the declared ones.
  hookPoints: NotesHooksLive,
  // The events this plugin publishes (ADR-EA-049), defined in `NotesEvents.ts`: `Auth.make` composes them, and
  // `TestAuth.layer` fails a test that emits an event not listed here.
  events: NotesEvents.events,
  config: [ConfigDescriptor.make(NotesConfigScoped)],
}) {
  static readonly layer = AuthPlugin.layer(Notes, {
    // The port the budget consumes through: declared, and checked for completeness by the compiler.
    ports: [RateLimiter.RateLimiter],
    handlers: NotesHandlers,
    make: Effect.gen(function* () {
      // Dependencies are plain `yield*`s: core services and this plugin's own records
      // are required from the environment, never constructed here (ports-required rule).
      const records = yield* NoteRecords;
      // ADR-EA-018 Decision 8: `Tenant.inForce` is yielded once here and its result per operation, so a tenant's
      // `Template.config(...)` in the calling fiber governs its own requests; with none, this build-time value applies.
      const settingsNow = yield* Tenant.inForce(NotesConfigScoped);
      const beforeCreate = yield* BeforeCreateNote;
      const afterCreate = yield* AfterCreateNote;
      const events = yield* AuthEvents.AuthEvents;
      // One budget, opened once: `limits.spend("createByUser", { userId })` is checked against the table
      // above (an unknown name or a missing field is a compile error), and a breach is published, logged,
      // counted and answered with `Api.RateLimited` (429). No annotation or comment is needed here.
      const limits = yield* RateLimits.budget(Notes);

      const create: NotesShape["create"] = Effect.fnUntraced(function* (caller, text) {
        const settings = yield* settingsNow;
        yield* limits.spend("createByUser", { userId: caller.userId });
        if (text.length > settings.maxLength) {
          return yield* Effect.fail(new TemplateApi.NoteTooLong());
        }
        const owner = caller.userId;
        // An early check, so the refusal comes before the veto hook runs. It is not the authority: two
        // concurrent creates can both pass it, and the store's `within` refuses the second.
        if ((yield* records.listByOwner(owner)).length >= settings.maxNotesPerOwner) {
          return yield* Effect.fail(new TemplateApi.NoteLimitReached());
        }
        // BEH-EA-090: a veto abort reaches the caller as the typed `HookAborted`, naming the point,
        // never as a defect. `HookPoint.aborted` translates it right where the point is run.
        const vetoed = yield* HookPoint.aborted(BeforeCreateNote)(
          beforeCreate.run({ owner, text }),
        );
        const record = yield* records
          .create({ owner, text: vetoed.text }, { within: settings.maxNotesPerOwner })
          .pipe(
            Effect.catchTag("NoteRecords/LimitReached", () =>
              Effect.fail(new TemplateApi.NoteLimitReached()),
            ),
          );
        yield* afterCreate.run({ owner, text: vetoed.text, noteId: record.id });
        // The audit row (actor: the caller) and every subscriber; `_tag` is filled in by the definition.
        yield* events.emit(NotesEvents.NoteCreatedEvent, {
          userId: caller.userId,
          noteId: record.id,
        });
        return record;
      });

      const list: NotesShape["list"] = (caller) => records.listByOwner(caller.userId);

      return Notes.of({ create, list });
    }),
  });
}
