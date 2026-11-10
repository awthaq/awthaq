// The template's own suite: it is what keeps `docs/plugin-authoring.md` from rotting. It builds the plugin through
// `Auth.make` and `TestAuth.layer` (plan 08), runs its real migrations, drives the endpoints over a real `HttpRouter`
// handler with a real session cookie, and aborts an operation with a veto tap, in BOTH record modes: the template's
// `records` bundle is what makes the same suite run over memory and over a migrated database.
import { Api } from "@awthaq/api";
import {
  AuditLog,
  Auth,
  AuthEvents,
  ConfigDescriptor,
  CurrentUser,
  EffectiveConfig,
  HookPoint,
} from "@awthaq/core";
import { Rendezvous, TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as NotesEvents from "../src/NotesEvents.ts";
import * as Template from "../src/Template.ts";

const ORIGIN = "http://localhost:3000";
const built = Auth.make([Template.Notes]);

// The tap lives in the composition: the veto test below triggers it with a marker text. It requires its point
// (ELC-001), which the plugin's `hookPoints` declaration has `TestAuth.layer` provide beneath it.
const ForbiddenTap = Template.BeforeCreateNote.tap((input) =>
  input.text.includes("forbidden")
    ? Effect.fail(new HookPoint.HookAbort({ code: "TEXT_FORBIDDEN" }))
    : Effect.succeed(input),
);

// A real limiter for the plugin (the harness's is permissive), so the rate-limit test below can trip it.
const common = {
  rateLimiter: "enforcing",
  taps: ForbiddenTap,
  services: Template.config({ maxLength: 20 }),
} as const;

describe("plugin-template", () => {
  it("composes through Auth.make with its tables in the manifest", () => {
    assert.strictEqual(built.api.identifier, "auth");
    assert.deepStrictEqual(
      built.manifest.plugins.map((plugin) => [plugin.id, plugin.tables]),
      [["notes", ["notes_note"]]],
    );
    // The declaration is part of the manifest: tooling prints it and `enableRls` consumes it.
    assert.deepStrictEqual(
      built.tenancy.map((table) => [table.table, table.tenancy._tag]),
      [["notes_note", "Partitioned"]],
    );
  });

  it("declares its rule statically: the manifest lists it with its key strategy", () => {
    assert.deepStrictEqual(
      built.manifest.rateLimits.map((rule) => [
        rule.plugin,
        rule.group,
        rule.endpoint,
        rule.name,
        rule.key,
        rule.mode,
        rule.limit,
      ]),
      [["notes", "notes", "create", "createByUser", "user", "attempts", 5]],
    );
  });
});

describe("plugin-template: per-tenant configuration (ADR-EA-018 D8)", () => {
  it.effect("a NotesConfig provided for the request overrides the build-time maxLength", () =>
    Effect.gen(function* () {
      const notes = yield* Template.Notes;
      const caller = CurrentUser.of(
        new Api.UserPrincipal({
          ref: new Api.PrincipalRef({ type: "user", id: "tenant-user" }),
          sessionId: "tenant-session",
        }),
      );
      const text = "x".repeat(25);
      // Build-time `maxLength: 20` refuses it ...
      const refused = yield* notes.create(caller, text).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "NoteTooLong");
      // ... a tenant that allows 30 accepts it, in the same composition.
      const created = yield* notes
        .create(caller, text)
        .pipe(Effect.provide(Template.config({ maxLength: 30 })));
      assert.strictEqual(created.text, text);
    }).pipe(Effect.provide(TestAuth.layer(built, common))),
  );
});

describe("plugin-template: the descriptor's view agrees with the operation", () => {
  it.effect("a calling override reports maxLength 30 with tenant scope and source", () =>
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const [item] = yield* EffectiveConfig.snapshot(context, [
        { owner: "notes", descriptor: ConfigDescriptor.make(Template.NotesConfigScoped) },
      ]).pipe(Effect.provide(Template.config({ maxLength: 30 })));
      assert.strictEqual(item?.scope, "tenant");
      assert.strictEqual(item?.source, "tenant");
      assert.strictEqual(
        new Map(item?.entries.map((e) => [e.path, e.value])).get("maxLength"),
        "30",
      );
    }).pipe(Effect.provide(Template.config({ maxLength: 20 }))),
  );
});

describe("plugin-template over sql records: the migration", () => {
  it("creates the table the plugin declares", async () => {
    await TestAuth.withApp(
      TestAuth.layer(built, {
        ...common,
        records: "sql",
        suite: "template_migration",
      }),
      undefined,
      async (app) => {
        const rows = await app.run(
          Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT count(*) AS n FROM notes_note`),
        );
        assert.strictEqual(rows.length, 1);
      },
    );
  });
});

for (const records of TestAuth.recordModes) {
  describe(`plugin-template over ${records} records`, () => {
    // Each case serves its own app and releases it when the case ends.
    const layer =
      records === "sql"
        ? TestAuth.layer(built, { ...common, records, suite: "template" })
        : TestAuth.layer(built, common);
    type NotesApp = TestAuth.App<Layer.Success<typeof layer>, Layer.Error<typeof layer>>;
    const withNotes = (use: (app: NotesApp) => Promise<void>) =>
      TestAuth.withApp(layer, { baseUrl: ORIGIN }, use);

    // Each signed-in user is an agent: it keeps its session and CSRF cookies and echoes the token itself.
    type Agent = TestAuth.SignedInAgent;
    const post = (agent: Agent, path: string, body: unknown) =>
      agent.request("POST", path, { json: body });
    const list = (agent: Agent) => agent.request("GET", "/notes");

    it("create then list round-trips over real HTTP, scoped to the caller", () =>
      withNotes(async (app) => {
        const signIn = (email: string) => app.signIn(email);
        const user = await signIn("user-1@example.com");
        assert.strictEqual((await post(user, "/notes", { text: "remember the milk" })).status, 200);
        const listed = await list(user);
        assert.strictEqual(listed.status, 200);
        const notes = (await listed.json()) as ReadonlyArray<{ text: string }>;
        assert.deepStrictEqual(
          notes.map((note) => note.text),
          ["remember the milk"],
        );
        const theirs = await list(await signIn("user-2@example.com"));
        assert.deepStrictEqual(await theirs.json(), []);
      }));

    it("a rate-limited rule answers 429 once the budget is spent, and only for that caller", () =>
      withNotes(async (app) => {
        const signIn = (email: string) => app.signIn(email);
        const user = await signIn("user-4@example.com");
        // `createByUser` is 5 per minute per signed-in user.
        for (let i = 0; i < 5; i += 1) {
          assert.strictEqual((await post(user, "/notes", { text: `note ${i}` })).status, 200);
        }
        const sixth = await post(user, "/notes", { text: "one too many" });
        assert.strictEqual(sixth.status, 429);
        assert.strictEqual(((await sixth.json()) as { _tag: string })._tag, "RateLimited");
        const other = await signIn("user-5@example.com");
        assert.strictEqual((await post(other, "/notes", { text: "mine" })).status, 200);
      }));

    it("requires a session", () =>
      withNotes(async (app) => {
        assert.strictEqual((await app.handler(new Request(`${ORIGIN}/notes`))).status, 401);
      }));

    it("a domain refusal is a typed error with its own status", () =>
      withNotes(async (app) => {
        const signIn = (email: string) => app.signIn(email);
        const res = await post(await signIn("user-6@example.com"), "/notes", {
          text: "x".repeat(21),
        });
        assert.strictEqual(res.status, 422);
        assert.strictEqual(((await res.json()) as { _tag: string })._tag, "NoteTooLong");
      }));

    it("a veto tap aborts the operation with the typed HookAborted, and nothing is stored", () =>
      withNotes(async (app) => {
        const signIn = (email: string) => app.signIn(email);
        const user = await signIn("user-3@example.com");
        const res = await post(user, "/notes", { text: "forbidden" });
        assert.strictEqual(res.status, 403);
        const body = (await res.json()) as {
          _tag: string;
          point: string;
          code: string;
        };
        assert.deepStrictEqual(
          [body._tag, body.point, body.code],
          ["HookAborted", "notes.create.before", "TEXT_FORBIDDEN"],
        );
        assert.deepStrictEqual(await (await list(user)).json(), []);
      }));
  });
}

// The per-owner quota (ADR-EA-041 decision 9). `Notes.create` checks it early, so the refusal comes before the veto
// hook, but the store's atomic `create(…, { within })` decides. The race holds every caller at the veto until all 8
// have passed the early check: only the store can refuse the extra seven, on memory, SQLite and (under
// `pnpm test:pg`) Postgres.
for (const records of TestAuth.recordModes) {
  describe(`plugin-template: the per-owner note quota (${records} records)`, () => {
    const caller = CurrentUser.of(
      new Api.UserPrincipal({
        ref: new Api.PrincipalRef({ type: "user", id: "quota-user" }),
        sessionId: "quota-session",
      }),
    );
    const quota = (taps: Layer.Layer<never, never, Template.BeforeCreateNote>) => {
      const options = {
        taps,
        services: Template.config({ maxNotesPerOwner: 3 }),
      };
      return records === "sql"
        ? TestAuth.layer(built, {
            ...options,
            records,
            suite: "template_quota",
          })
        : TestAuth.layer(built, options);
    };

    it.effect("a full quota answers NoteLimitReached before the veto runs", () =>
      Effect.gen(function* () {
        const notes = yield* Template.Notes;
        for (const text of ["one", "two", "three"]) yield* notes.create(caller, text);
        const refused = yield* Effect.flip(notes.create(caller, "forbidden"));
        assert.strictEqual(refused._tag, "NoteLimitReached");
      }).pipe(Effect.provide(quota(ForbiddenTap))),
    );

    it.effect("8 creates racing past the early check at max - 1 store exactly one", () =>
      Effect.gen(function* () {
        const notes = yield* Template.Notes;
        // Arranged through the store, so only the racers meet at the veto.
        const stored = yield* Template.NoteRecords;
        for (const text of ["one", "two"]) yield* stored.create({ owner: "quota-user", text });
        const outcomes = yield* Effect.all(
          Array.from({ length: 8 }, () => Effect.result(notes.create(caller, "racer"))),
          { concurrency: "unbounded" },
        );
        const tags = outcomes.map((outcome) =>
          Result.isFailure(outcome) ? outcome.failure._tag : "ok",
        );
        assert.deepStrictEqual([...tags].sort(), [
          "NoteLimitReached",
          "NoteLimitReached",
          "NoteLimitReached",
          "NoteLimitReached",
          "NoteLimitReached",
          "NoteLimitReached",
          "NoteLimitReached",
          "ok",
        ]);
        assert.strictEqual((yield* notes.list(caller)).length, 3);
      }).pipe(Effect.provide(quota(Template.BeforeCreateNote.tap(Rendezvous.held(8))))),
    );
  });
}

// ADR-EA-049: the plugin owns its event. It is defined in `NotesEvents.ts`, declared on the class, published with
// `emit`, recorded in the audit log with its actor, readable with `payloadAs`, and typed for subscribers.
for (const records of TestAuth.recordModes) {
  describe(`plugin-template: its own event (${records} records)`, () => {
    const caller = CurrentUser.of(
      new Api.UserPrincipal({
        ref: new Api.PrincipalRef({ type: "user", id: "event-user" }),
        sessionId: "event-session",
      }),
    );
    const layer =
      records === "sql"
        ? TestAuth.layer(built, {
            ...common,
            records,
            suite: "template_events",
          })
        : TestAuth.layer(built, common);

    it("is declared in the composition and its manifest", () => {
      assert.isTrue(built.events.isTag("auth.notes.created"));
      assert.deepStrictEqual(
        built.manifest.events.find((event) => event.tag === "auth.notes.created"),
        {
          tag: "auth.notes.created",
          owner: "notes",
          actor: { _tag: "Field", field: "userId" },
          pii: [],
          attempt: false,
        },
      );
    });

    it.effect("creating a note records auth.notes.created with the caller as actor", () =>
      Effect.gen(function* () {
        const notes = yield* Template.Notes;
        const auditLog = yield* AuditLog.AuditLog;
        const note = yield* notes.create(caller, "hello");
        const rows = yield* auditLog.list({ eventTag: "auth.notes.created" });
        assert.strictEqual(rows.length, 1);
        const [row] = rows;
        assert.isDefined(row);
        if (row === undefined) return;
        assert.deepStrictEqual(Option.map(row.actorUserId, String), Option.some("event-user"));
        // Core reads a row it does not define as a foreign event; the plugin decodes its own.
        const decoded = AuditLog.payloadAs(NotesEvents.NoteCreatedEvent)(row);
        assert.isTrue(Option.isSome(decoded));
        if (Option.isSome(decoded)) assert.strictEqual(decoded.value.noteId, note.id);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("a subscriber receives it typed, by definition and through the composition", () =>
      Effect.gen(function* () {
        const notes = yield* Template.Notes;
        const events = yield* AuthEvents.AuthEvents;
        const seen = yield* Queue.unbounded<string>();
        const typed = AuthEvents.typed(built.events);
        yield* Effect.scoped(
          Effect.gen(function* () {
            // `event.noteId` is typed: the handler receives `NoteCreatedEvent` with its envelope.
            yield* Layer.build(
              AuthEvents.on(NotesEvents.NoteCreatedEvent, (event) =>
                Queue.offer(seen, event.noteId),
              ),
            );
            const stream = yield* events.subscribe;
            const note = yield* notes.create(caller, "typed");
            assert.strictEqual(yield* Queue.take(seen), note.id);
            const [first] = yield* stream.pipe(
              Stream.filter(typed.is),
              Stream.filter((event) => event._tag === "auth.notes.created"),
              Stream.take(1),
              Stream.runCollect,
            );
            // `typed.is` narrows the open stream to the composition's union, so `_tag` narrows to this event.
            assert.strictEqual(first?._tag === "auth.notes.created" ? first.noteId : "", note.id);
          }),
        );
      }).pipe(Effect.provide(layer)),
    );
  });
}

// The store-level cases (the tenant stamp, tenant isolation, the atomic per-owner quota and its race) are
// `test/contract/NoteRecords.ts`, run on both adapters by `Contract.test.ts` (plan 25).
