// plugin-template — Template
//
// The smallest plugin that still shows every convention: a config
// `Context.Reference`, one tenant-partitioned table with dialect-branched migrations, a records
// service with a memory and a SQL adapter, a veto + an observe hook point, an `HttpApiGroup` with
// handlers, and `AuthPlugin.Service` tying them together. `docs/plugin-authoring.md` walks
// through this file top to bottom; `test/Template.test.ts` keeps it honest.

import { Api } from "@awthaq/api";
import { AuthPlugin, HookPoint, Migrations, RateLimits } from "@awthaq/core";
import { RateLimiter } from "@awthaq/ports";
import { StoreFailure, TenantScoped } from "@awthaq/sql";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as TemplateApi from "./TemplateApi.ts";

// ---- config: a Context.Reference with a default (BEH-EA-017) -----------------------
// Policy knobs are a Reference, not a required service: the plugin works with no
// setup, and an app overrides it with `Notes.config({...})`.

export interface NotesConfigShape {
  readonly maxLength: number;
}

export const NotesConfig: Context.Reference<NotesConfigShape> = Context.Reference(
  "example/notes/Config",
  { defaultValue: () => ({ maxLength: 500 }) },
);

export const config = (partial: Partial<NotesConfigShape>) =>
  Layer.succeed(NotesConfig, { maxLength: 500, ...partial });

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

export interface NoteRecord {
  readonly id: string;
  readonly owner: string;
  readonly text: string;
  readonly created: DateTime.Utc;
  /** The tenant the note was written under; `None` for a deployment without tenants. */
  readonly tenantId: Option.Option<string>;
}

export interface NoteRecordsShape {
  /** Stamped with the ambient tenant. */
  readonly create: (input: {
    readonly owner: string;
    readonly text: string;
  }) => Effect.Effect<NoteRecord, StoreFailure.StoreUnavailable>;
  /** The owner's notes in the ambient tenant, oldest first. */
  readonly listByOwner: (
    owner: string,
  ) => Effect.Effect<ReadonlyArray<NoteRecord>, StoreFailure.StoreUnavailable>;
}

export class NoteRecords extends Context.Service<NoteRecords, NoteRecordsShape>()(
  "example/notes/records/NoteRecords",
) {}

/** Id minting is a `Crypto` call that can fail: an outage, never a defect. */
const mintId = <E>(minted: Effect.Effect<string, E>) =>
  Effect.catch(minted, StoreFailure.storeUnavailable("NoteRecords.create"));

export const layerMemory = Layer.effect(
  NoteRecords,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const state = yield* Ref.make<ReadonlyArray<NoteRecord>>([]);

    const create: NoteRecordsShape["create"] = Effect.fnUntraced(function* (input) {
      const id = yield* mintId(crypto.randomUUIDv7);
      const created = yield* DateTime.now;
      const stamped = yield* TenantScoped.stamp({ tenantId: null });
      const record: NoteRecord = {
        id,
        owner: input.owner,
        text: input.text,
        created,
        tenantId: Option.fromNullishOr(stamped.tenantId),
      };
      yield* Ref.update(state, (rows) => [...rows, record]);
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

const NoteRow = Schema.Struct({
  id: Schema.String,
  owner: Schema.String,
  text: Schema.String,
  created: Schema.DateTimeUtcFromString,
  tenantId: Schema.NullOr(Schema.String),
});

const toRecord = (row: typeof NoteRow.Type): NoteRecord => ({
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
    const crypto = yield* Crypto.Crypto;

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

    const create: NoteRecordsShape["create"] = Effect.fnUntraced(function* (input) {
      const id = yield* mintId(crypto.randomUUIDv7);
      const created = yield* DateTime.now;
      const stamped = yield* TenantScoped.stamp({ tenantId: null });
      return yield* insert({
        id,
        owner: input.owner,
        text: input.text,
        created,
        tenantId: stamped.tenantId,
      }).pipe(Effect.map(toRecord), StoreFailure.orStoreUnavailable("NoteRecords.create"));
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
    caller: Api.UserPrincipal,
    text: string,
  ) => Effect.Effect<
    NoteRecord,
    | TemplateApi.NoteTooLong
    | HookPoint.HookAborted
    | Api.RateLimited
    | StoreFailure.StoreUnavailable
  >;
  readonly list: (
    caller: Api.UserPrincipal,
  ) => Effect.Effect<ReadonlyArray<NoteRecord>, StoreFailure.StoreUnavailable>;
}

const toDto = (record: NoteRecord) =>
  new TemplateApi.NoteDto({
    id: record.id,
    text: record.text,
    createdAt: DateTime.formatIso(record.created),
  });

/** Handlers run behind `Api.Authentication`, so the principal is always there. */
const currentUserPrincipal = Effect.gen(function* () {
  const principal = yield* Api.CurrentPrincipal;
  if (principal._tag !== "User") {
    return yield* Effect.die(new Error(`notes: reached with a non-User principal`));
  }
  return principal;
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
        const caller = yield* currentUserPrincipal;
        return toDto(yield* notes.create(caller, payload.text));
      }),
      list: Effect.fnUntraced(function* () {
        const caller = yield* currentUserPrincipal;
        return (yield* notes.list(caller)).map(toDto);
      }),
    });
  }),
);

// ---- rate limits: declared once, spent by name ---------------------------------------
// A plugin that throttles declares a typed table of rules; `group` must be one of the plugin's own
// contract groups (a compile error otherwise) and `key` says what a bucket counts (`Key.user`: the
// signed-in caller; `Key.ip` for an anonymous endpoint, `Key.email`, `Key.custom`, ...). The static
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
}) {
  static readonly layer = AuthPlugin.layer(Notes, {
    // The port the budget consumes through: declared, and checked for completeness by the compiler.
    ports: [RateLimiter.RateLimiter],
    handlers: NotesHandlers,
    make: Effect.gen(function* () {
      // Dependencies are plain `yield*`s: core services and this plugin's own records
      // are required from the environment, never constructed here (ports-required rule).
      const records = yield* NoteRecords;
      const settings = yield* NotesConfig;
      const beforeCreate = yield* BeforeCreateNote;
      const afterCreate = yield* AfterCreateNote;
      // One budget, opened once: `limits.spend("createByUser", { userId })` is checked against the table
      // above (an unknown name or a missing field is a compile error), and a breach is published, logged,
      // counted and answered with `Api.RateLimited` (429). No annotation or comment is needed here.
      const limits = yield* RateLimits.budget(Notes);

      const create: NotesShape["create"] = Effect.fnUntraced(function* (caller, text) {
        yield* limits.spend("createByUser", { userId: caller.ref.id });
        if (text.length > settings.maxLength) {
          return yield* Effect.fail(new TemplateApi.NoteTooLong());
        }
        const owner = caller.ref.id;
        // BEH-EA-090: a veto abort reaches the caller as the typed `HookAborted`, naming the point,
        // never as a defect. `HookPoint.aborted` translates it right where the point is run.
        const vetoed = yield* HookPoint.aborted(BeforeCreateNote)(
          beforeCreate.run({ owner, text }),
        );
        const record = yield* records.create({ owner, text: vetoed.text });
        yield* afterCreate.run({ owner, text: vetoed.text, noteId: record.id });
        return record;
      });

      const list: NotesShape["list"] = (caller) => records.listByOwner(caller.ref.id);

      return Notes.of({ create, list });
    }),
  });
}
