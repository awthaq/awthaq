// The template's own suite: it is what keeps `docs/plugin-authoring.md` from rotting. It builds the plugin through
// `Auth.make` and `TestAuth.layer` (plan 08), runs its real migrations, drives the endpoints over a real `HttpRouter`
// handler with a real session cookie, and aborts an operation with a veto tap, in BOTH record modes: the template's
// `records` bundle is what makes the same suite run over memory and over a migrated database.
import { Auth, HookPoint, Migrations } from "@awthaq/core";
import { Tenant } from "@awthaq/ports";
import { TestAuth, TestSql } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { afterAll, assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
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

describe("plugin-template over sql records: the migration", () => {
  const app = TestAuth.app(
    TestAuth.layer(built, { ...common, records: "sql", suite: "template_migration" }),
  );
  afterAll(() => app.dispose());

  it("creates the table the plugin declares", async () => {
    const rows = await app.run(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT count(*) AS n FROM notes_note`),
    );
    assert.strictEqual(rows.length, 1);
  });
});

for (const records of TestAuth.recordModes) {
  describe(`plugin-template over ${records} records`, () => {
    const app = TestAuth.app(
      records === "sql"
        ? TestAuth.layer(built, { ...common, records, suite: "template" })
        : TestAuth.layer(built, common),
      { baseUrl: ORIGIN },
    );
    afterAll(() => app.dispose());

    const post = (path: string, body: unknown, cookie?: string) =>
      app.request("POST", path, { json: body, ...(cookie === undefined ? {} : { cookie }) });
    const list = (cookie: string) => app.request("GET", "/notes", { cookie });
    const signIn = async (email: string) => (await app.signIn(email)).cookieHeader;

    it("create then list round-trips over real HTTP, scoped to the caller", async () => {
      const cookie = await signIn("user-1@example.com");
      assert.strictEqual((await post("/notes", { text: "remember the milk" }, cookie)).status, 200);
      const listed = await list(cookie);
      assert.strictEqual(listed.status, 200);
      const notes = (await listed.json()) as ReadonlyArray<{ text: string }>;
      assert.deepStrictEqual(
        notes.map((note) => note.text),
        ["remember the milk"],
      );
      const theirs = await list(await signIn("user-2@example.com"));
      assert.deepStrictEqual(await theirs.json(), []);
    });

    it("a rate-limited rule answers 429 once the budget is spent, and only for that caller", async () => {
      const cookie = await signIn("user-4@example.com");
      // `createByUser` is 5 per minute per signed-in user.
      for (let i = 0; i < 5; i += 1) {
        assert.strictEqual((await post("/notes", { text: `note ${i}` }, cookie)).status, 200);
      }
      const sixth = await post("/notes", { text: "one too many" }, cookie);
      assert.strictEqual(sixth.status, 429);
      assert.strictEqual(((await sixth.json()) as { _tag: string })._tag, "RateLimited");
      const other = await signIn("user-5@example.com");
      assert.strictEqual((await post("/notes", { text: "mine" }, other)).status, 200);
    });

    it("requires a session", async () => {
      assert.strictEqual((await app.handler(new Request(`${ORIGIN}/notes`))).status, 401);
    });

    it("a domain refusal is a typed error with its own status", async () => {
      const res = await post(
        "/notes",
        { text: "x".repeat(21) },
        await signIn("user-6@example.com"),
      );
      assert.strictEqual(res.status, 422);
      assert.strictEqual(((await res.json()) as { _tag: string })._tag, "NoteTooLong");
    });

    it("a veto tap aborts the operation with the typed HookAborted, and nothing is stored", async () => {
      const cookie = await signIn("user-3@example.com");
      const res = await post("/notes", { text: "forbidden" }, cookie);
      assert.strictEqual(res.status, 403);
      const body = (await res.json()) as { _tag: string; point: string; code: string };
      assert.deepStrictEqual(
        [body._tag, body.point, body.code],
        ["HookAborted", "notes.create.before", "TEXT_FORBIDDEN"],
      );
      assert.deepStrictEqual(await (await list(cookie)).json(), []);
    });
  });
}

// Plan 05: the tenant-isolation conformance suite, over both adapters. The table is Partitioned: a note is
// stamped with the ambient tenant at insert and seen only under it, identically in memory and SQL, and (on
// Postgres, under `pnpm run test:pg`) the database confines an unfiltered statement too. A third-party plugin
// runs this same suite over its own records.
interface Written {
  readonly id: string;
  readonly owner: string;
}
let isolationCounter = 0;

const MemoryRecords = Template.layerMemory.pipe(Layer.provide(NodeCrypto.layer));

// The conformance suite builds the records alone, over a migrated database of its own.
const IsolationSql = TestSql.layer("template_isolation");
const RecordsLive = Template.layerSql.pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(IsolationSql),
  Layer.provideMerge(
    Layer.effectDiscard(Migrations.run(Template.Notes.migrations)).pipe(
      Layer.provide(IsolationSql),
    ),
  ),
);

TestAuth.runTenantIsolationTests<Template.NoteRecordsShape, Written, Template.NoteRecords>(
  {
    describe: (name, body) => describe(name, body),
    it: (name, body) => it(name, body),
    fail: (message) => {
      throw new Error(message);
    },
  },
  {
    plugin: Template.Notes,
    adapters: [
      { name: "layerMemory", layer: MemoryRecords },
      { name: "layerSql", layer: RecordsLive },
    ],
    cases: [
      {
        table: "notes_note",
        insert: Effect.gen(function* () {
          const records = yield* Template.NoteRecords;
          isolationCounter += 1;
          const owner = `isolation-owner-${isolationCounter}`;
          const created = yield* records.create({ owner, text: "isolated" });
          return { id: created.id, owner };
        }),
        methods: {
          create: { insert: true },
          listByOwner: {
            scoped: {
              run: (written) =>
                Effect.flatMap(Template.NoteRecords, (records) =>
                  Effect.map(records.listByOwner(written.owner), (rows) =>
                    rows.some((row) => row.id === written.id),
                  ),
                ),
            },
          },
        },
      },
    ],
    rls: { layer: RecordsLive },
  },
);

describe("plugin-template: the records stamp the ambient tenant", () => {
  it.effect("a note carries the tenant it was written under, and none outside a tenant", () =>
    Effect.gen(function* () {
      const records = yield* Template.NoteRecords;
      const inTenant = yield* records
        .create({ owner: "o", text: "t" })
        .pipe(Tenant.withTenant("acme"));
      assert.deepStrictEqual(inTenant.tenantId, Option.some("acme"));
      const outside = yield* records.create({ owner: "o", text: "u" });
      assert.isTrue(Option.isNone(outside.tenantId));
    }).pipe(Effect.provide(MemoryRecords)),
  );
});
