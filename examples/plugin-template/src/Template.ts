// plugin-template — Template
//
// The smallest plugin that still shows every convention: a config
// `Context.Reference`, one table with a dialect-branched migration, a records
// service, a veto + an observe hook point, an `HttpApiGroup` with handlers, and
// `AuthPlugin.Service` tying them together. `docs/plugin-authoring.md` walks
// through this file top to bottom; `test/Template.test.ts` keeps it honest.

import { Api } from "@awthaq/api";
import { AuthPlugin, HookPoint, Migrations } from "@awthaq/core";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
// lowercase words so the same statement decodes on SQLite and Postgres alike. A real
// plugin also ships a `layerMemory` (see `@awthaq/admin`'s ImpersonationRecords).

export interface NoteRecord {
  readonly id: string;
  readonly owner: string;
  readonly text: string;
  readonly created: DateTime.Utc;
}

export class NoteRecords extends Context.Service<
  NoteRecords,
  {
    readonly create: (input: {
      readonly owner: string;
      readonly text: string;
    }) => Effect.Effect<NoteRecord>;
    readonly listByOwner: (owner: string) => Effect.Effect<ReadonlyArray<NoteRecord>>;
  }
>()("example/notes/NoteRecords") {}

const NoteRow = Schema.Struct({
  id: Schema.String,
  owner: Schema.String,
  text: Schema.String,
  created: Schema.DateTimeUtcFromString,
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
        sql`INSERT INTO notes_note (id, owner, text, created) VALUES (${r.id}, ${r.owner}, ${r.text}, ${r.created}) RETURNING *`,
    });
    const listByOwner = SqlSchema.findAll({
      Request: Schema.String,
      Result: NoteRow,
      execute: (owner) => sql`SELECT * FROM notes_note WHERE owner = ${owner} ORDER BY created ASC`,
    });

    return {
      create: Effect.fnUntraced(function* (input) {
        const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
        const created = yield* DateTime.now;
        return yield* insert({ id, owner: input.owner, text: input.text, created }).pipe(
          Effect.orDie,
        );
      }),
      listByOwner: (owner) => listByOwner(owner).pipe(Effect.orDie),
    };
  }),
);

// ---- migrations: append-only, dialect-branched -------------------------------------
// Never edit a shipped migration; add a new entry. `sql.onDialectOrElse` is how a
// statement differs between Postgres and SQLite (here only the timestamp type).

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
];

// ---- the service shape and the plugin -----------------------------------------------

export interface NotesShape {
  readonly create: (
    caller: Api.UserPrincipal,
    text: string,
  ) => Effect.Effect<NoteRecord, TemplateApi.NoteTooLong | HookPoint.HookAborted>;
  readonly list: (caller: Api.UserPrincipal) => Effect.Effect<ReadonlyArray<NoteRecord>>;
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

export class Notes extends AuthPlugin.Service<Notes, NotesShape>()("notes", {
  apiVersion: 1,
  contract: TemplateApi.NotesApi,
  tables: ["notes_note"],
  migrations: notesMigrations,
}) {
  static readonly layer = AuthPlugin.layer(Notes, {
    handlers: NotesHandlers,
    make: Effect.gen(function* () {
      // Dependencies are plain `yield*`s: core services and this plugin's own records
      // are required from the environment, never constructed here (ports-required rule).
      const records = yield* NoteRecords;
      const settings = yield* NotesConfig;
      const beforeCreate = yield* BeforeCreateNote;
      const afterCreate = yield* AfterCreateNote;

      // BEH-EA-090: a veto abort reaches the caller as the typed `HookAborted`, naming
      // the point, never as a defect. Translate it where the point is run.
      const veto = <A>(point: string, effect: Effect.Effect<A, HookPoint.HookAbort>) =>
        effect.pipe(
          Effect.catchTag(
            "HookAbort",
            (abort) =>
              new HookPoint.HookAborted({ point, code: abort.code, message: abort.message }),
          ),
        );

      const create: NotesShape["create"] = Effect.fnUntraced(function* (caller, text) {
        if (text.length > settings.maxLength) {
          return yield* Effect.fail(new TemplateApi.NoteTooLong());
        }
        const owner = caller.ref.id;
        const vetoed = yield* veto("notes.create.before", beforeCreate.run({ owner, text }));
        const record = yield* records.create({ owner, text: vetoed.text });
        yield* afterCreate.run({ owner, text: vetoed.text, noteId: record.id });
        return record;
      });

      const list: NotesShape["list"] = (caller) => records.listByOwner(caller.ref.id);

      return Notes.of({ create, list });
    }),
  });
}
