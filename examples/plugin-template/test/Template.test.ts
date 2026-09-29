// The template's own suite: it is what keeps `docs/plugin-authoring.md` from rotting. It
// builds the plugin through `Auth.make`, runs its real migrations on SQLite, drives the
// endpoints over a real `HttpRouter` handler with a real session cookie, and aborts an
// operation with a veto tap.
import { Api } from "@awthaq/api";
import { Auth, AuditLog, AuthEvents, Hooks, HookPoint, Migrations, Sessions, Users } from "@awthaq/core";
import { Authentication, AuthHttp, Csrf } from "@awthaq/server";
import { TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import { createHmac, randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Template from "../src/Template.ts";
import * as TemplateApi from "../src/TemplateApi.ts";

const ORIGIN = "http://localhost:3000";
const CSRF_SECRET = "template-test-csrf-secret-padded-to-thirty-two-bytes";

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const CoreLive = Layer.mergeAll(Sessions.layerMemory, Users.layerMemory).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make(CSRF_SECRET),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const CSRF_TOKEN = (() => {
  // `<iat>.<random>.<hmac(iat.random)>` (CDS-006).
  const signed = `${Math.floor(Date.now() / 1000)}.${randomBytes(32).toString("hex")}`;
  return `${signed}.${createHmac("sha256", CSRF_SECRET).update(signed).digest("hex")}`;
})();

// A real database, migrated with the plugin's own migrations — no hand-written DDL.
const SqlLive = SqliteClient.layer({ filename: ":memory:" });
const Migrated = Layer.effectDiscard(Migrations.run(Template.Notes.migrations)).pipe(
  Layer.provide(SqlLive),
);
const RecordsLive = Template.layerSql.pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

// A veto tap is installed once per process (the tap registry freezes at the first run),
// so it lives in the shared layer: the veto test below triggers it with a marker text.
const ForbiddenTap = Template.BeforeCreateNote.tap((input) =>
  input.text.includes("forbidden")
    ? Effect.fail(new HookPoint.HookAbort({ code: "TEXT_FORBIDDEN" }))
    : Effect.succeed(input),
);

const AppLayer = Layer.mergeAll(
  AuthHttp.routes(TemplateApi.NotesApi).pipe(
    Layer.provide(Template.Notes.layer),
    Layer.provide(Template.config({ maxLength: 20 })),
    Layer.provide(AuthenticationLive),
  ),
).pipe(
  Layer.provide(CsrfProtectionLive),
  Layer.provideMerge(CoreLive),
  Layer.provideMerge(RecordsLive),
  Layer.provideMerge(Template.NotesHooksLive),
  Layer.provideMerge(ForbiddenTap),
  Layer.provideMerge(TestServices),
  Layer.provideMerge(HttpRouter.layer),
);

const memoMap = Layer.makeMemoMapUnsafe();
const { handler } = HttpRouter.toWebHandler(AppLayer, { memoMap });

const issueSessionCookie = (userId: string): Promise<string> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const context = yield* Layer.buildWithMemoMap(AppLayer, memoMap, scope);
        return yield* Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const issued = yield* sessions.issue({ userId: Users.UserId(userId) });
          return `__Host-session=${encodeURIComponent(Redacted.value(issued.token))}`;
        }).pipe(Effect.provide(context));
      }),
    ),
  );

const post = (path: string, body: unknown, cookie?: string) =>
  handler(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: [cookie, `${Api.CSRF_COOKIE_NAME}=${CSRF_TOKEN}`].filter(Boolean).join("; "),
        [Api.CSRF_HEADER_NAME]: CSRF_TOKEN,
      },
      body: JSON.stringify(body),
    }),
  );

describe("plugin-template", () => {
  it("composes through Auth.make with its tables in the manifest", () => {
    const auth = Auth.make([Template.Notes]);
    assert.strictEqual(auth.api.identifier, "auth");
    assert.deepStrictEqual(
      auth.manifest.plugins.map((plugin) => [plugin.id, plugin.tables]),
      [["notes", ["notes_note"]]],
    );
  });

  it.effect("its migration creates the table it declares", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.unsafe("SELECT name FROM sqlite_master WHERE name = 'notes_note'");
      assert.strictEqual(rows.length, 1);
    }).pipe(Effect.provide(RecordsLive)),
  );

  it("create then list round-trips over real HTTP, scoped to the caller", async () => {
    const cookie = await issueSessionCookie("user-1");
    const created = await post("/notes", { text: "remember the milk" }, cookie);
    assert.strictEqual(created.status, 200);

    const listed = await handler(new Request(`${ORIGIN}/notes`, { headers: { cookie } }));
    assert.strictEqual(listed.status, 200);
    const notes = (await listed.json()) as ReadonlyArray<{ text: string }>;
    assert.deepStrictEqual(notes.map((note) => note.text), ["remember the milk"]);

    const other = await issueSessionCookie("user-2");
    const theirs = await handler(new Request(`${ORIGIN}/notes`, { headers: { cookie: other } }));
    assert.deepStrictEqual(await theirs.json(), []);
  });

  it("requires a session", async () => {
    const res = await handler(new Request(`${ORIGIN}/notes`));
    assert.strictEqual(res.status, 401);
  });

  it("a domain refusal is a typed error with its own status", async () => {
    const cookie = await issueSessionCookie("user-1");
    const res = await post("/notes", { text: "x".repeat(21) }, cookie);
    assert.strictEqual(res.status, 422);
    assert.strictEqual(((await res.json()) as { _tag: string })._tag, "NoteTooLong");
  });

  it("a veto tap aborts the operation with the typed HookAborted, and nothing is stored", async () => {
    const cookie = await issueSessionCookie("user-3");
    const res = await post("/notes", { text: "forbidden" }, cookie);
    assert.strictEqual(res.status, 403);
    const body = (await res.json()) as { _tag: string; point: string; code: string };
    assert.deepStrictEqual(
      [body._tag, body.point, body.code],
      ["HookAborted", "notes.create.before", "TEXT_FORBIDDEN"],
    );
    const listed = await handler(new Request(`${ORIGIN}/notes`, { headers: { cookie } }));
    assert.deepStrictEqual(await listed.json(), []);
  });
});

// The shared plugin-contract harness: manifest legality, group ids, table prefixes,
// migration determinism.
TestAuth.runPluginContractTests(
  {
    describe: (name, body) => describe(name, body),
    it: (name, body) => it(name, body),
    fail: (message) => {
      throw new Error(message);
    },
  },
  () => Template.Notes,
  { options: [{}] },
);
