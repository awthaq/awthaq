// BEH-EA-207 (BAM-001, ECS-002, FAMS-010): `awthaq import` end to end — the real command tree, the
// real better-auth export (`@awthaq/migrate-better-auth`'s fixture, produced by better-auth 1.7.6
// itself) and Firebase-shaped export, the real `Users`/`Accounts` services over a real SQLite
// target. The target's `SqlClient` is owned by the test, so state survives across the separate
// application builds each CLI invocation performs, the way a database does.
import { AuditLog } from "@awthaq/core";
import { PasswordHasher } from "@awthaq/ports";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, sqlApp } from "./support/SqlApp.ts";
import { runCli } from "./support/RunCli.ts";
import { configOf, passwordAndRoles } from "./support/TestApp.ts";

const here = Path.dirname(fileURLToPath(import.meta.url));
const betterAuthExport = `sqlite:${Path.join(here, "../../migrate-better-auth/test/fixtures/better-auth-export.sqlite")}`;
const firebaseUsers = Path.join(here, "../../migrate-firebase/test/fixtures/users.json");
const firebaseHashConfig = Path.join(here, "../../migrate-firebase/test/fixtures/hash_config.json");

const Target = SqliteClient.layer({ filename: ":memory:" });

const withTarget = <A, E>(
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* migrate;
    return yield* use(sql);
  }).pipe(Effect.provide(Target));

const importArgs = (extra: ReadonlyArray<string>) => [
  "import",
  "--from",
  "better-auth",
  "--source",
  betterAuthExport,
  ...extra,
];

const count = (sql: SqlClient.SqlClient, table: string) =>
  sql<{ readonly n: number }>`SELECT count(*) AS n FROM ${sql(table)}`.pipe(
    Effect.map((rows) => Number(rows[0]?.n ?? 0)),
  );

const ledgerTable = "awthaq_import_runs";
const hasLedger = (sql: SqlClient.SqlClient) =>
  sql<{ readonly n: number }>`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ${ledgerTable}`.pipe(
    Effect.map((rows) => Number(rows[0]?.n ?? 0) > 0),
  );

const summaryOf = (stdout: ReadonlyArray<string>) => JSON.parse(stdout.join("\n"));

describe("import: plan mode (the default)", () => {
  it.effect("reads and maps the whole export, prints counts and the unmapped report, and writes nothing", () =>
    withTarget((sql) =>
      Effect.gen(function* () {
        const result = yield* runCli(importArgs([]), configOf(passwordAndRoles, { app: sqlApp(sql) }));
        assert.strictEqual(result.code, 0);
        const text = result.stdout.join("\n");
        assert.include(text, "import plan for better-auth (nothing written; re-run with --yes to import)");
        assert.include(text, "table user: 3 row(s)");
        assert.include(text, "table session: 2 row(s) — not imported: live sessions are bridged");
        assert.include(text, "users: 3 read, 3 to import, 0 already imported, 0 email conflict(s), 0 unmappable, 0 failed");
        assert.include(text, "user.plan (1 row(s))");
        assert.strictEqual(yield* count(sql, "users"), 0);
        assert.strictEqual(yield* count(sql, "accounts"), 0);
        assert.isFalse(yield* hasLedger(sql));
      }),
    ),
  );

  it.effect("--dry-run stays a plan even with --yes", () =>
    withTarget((sql) =>
      Effect.gen(function* () {
        const result = yield* runCli(importArgs(["--yes", "--dry-run"]), configOf(passwordAndRoles, { app: sqlApp(sql) }));
        assert.strictEqual(result.code, 0);
        assert.strictEqual(yield* count(sql, "users"), 0);
      }),
    ),
  );

  it.effect("reports an email that already exists in the target as a conflict", () =>
    withTarget((sql) =>
      Effect.gen(function* () {
        const config = configOf(passwordAndRoles, { app: sqlApp(sql) });
        yield* sql`INSERT INTO users (id, email, emailVerified, name, createdAt, updatedAt) VALUES ('pre', 'ada@example.com', 1, 'Ada', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
        const plan = yield* runCli(importArgs(["--json"]), config);
        const summary = summaryOf(plan.stdout);
        assert.strictEqual(summary.users.emailConflicts, 1);
        assert.strictEqual(summary.users.toImport, 2);
      }),
    ),
  );
});

describe("import --yes", () => {
  it.effect("writes users and accounts through Users and Accounts, records the checkpoint and audits the run", () =>
    withTarget((sql) =>
      Effect.gen(function* () {
        const app = sqlApp(sql);
        const result = yield* runCli(
          importArgs(["--yes", "--json", "--issuer", "github=https://github.com"]),
          configOf(passwordAndRoles, { app }),
        );
        assert.strictEqual(result.code, 0);
        const summary = summaryOf(result.stdout);
        assert.strictEqual(summary.mode, "import");
        assert.strictEqual(summary.users.toImport, 3);
        assert.strictEqual(summary.accounts, 3);

        const users = yield* sql<{ readonly email: string; readonly emailVerified: number }>`SELECT email, emailVerified FROM users ORDER BY email`;
        assert.deepStrictEqual(users, [
          { email: "ada@example.com", emailVerified: 1 },
          { email: "alan@example.com", emailVerified: 0 },
          { email: "grace@example.com", emailVerified: 1 },
        ]);
        const accounts = yield* sql<{ readonly providerId: string; readonly subject: string; readonly issuer: string; readonly userId: string }>`SELECT providerId, subject, issuer, userId FROM accounts ORDER BY providerId, subject`;
        assert.deepStrictEqual(accounts.map((a) => a.providerId), ["github", "password", "password"]);
        const github = accounts[0];
        assert.strictEqual(github?.subject, "1815");
        assert.strictEqual(github?.issuer, "https://github.com");
        // The avatar has a destination (`users.image`), so it is carried, not reported.
        const grace = yield* sql<{ readonly image: string | null }>`SELECT image FROM users WHERE email = 'grace@example.com'`;
        assert.strictEqual(grace[0]?.image, "https://avatars.example.com/grace.png");
        // A password account is keyed by the new user id (`Password.signUp`'s convention).
        const ada = yield* sql<{ readonly id: string }>`SELECT id FROM users WHERE email = 'ada@example.com'`;
        assert.isTrue(accounts.some((a) => a.providerId === "password" && a.subject === ada[0]?.id));

        // The checkpoint: one `done` row per source user.
        const ledger = yield* sql<{ readonly status: string }>`SELECT status FROM awthaq_import_runs`;
        assert.deepStrictEqual(ledger.map((row) => row.status), ["done", "done", "done"]);

        // The durable audit record: one auth.import.completed carrying the run id and counts.
        const completed = yield* AuditLog.AuditLog.use((log) => log.list({ eventTag: "auth.import.completed" })).pipe(
          Effect.provide(app),
        );
        assert.strictEqual(completed.length, 1);
        assert.strictEqual(
          JSON.stringify(completed[0]?.payload).includes(`"runId":"${summary.runId}"`),
          true,
        );
        assert.include(JSON.stringify(completed[0]?.payload), '"imported":3');
      }),
    ),
  );

  it.effect("an imported better-auth password signs in through the legacy verifier and is flagged for rehash", () =>
    withTarget((sql) =>
      Effect.gen(function* () {
        const app = sqlApp(sql);
        yield* runCli(importArgs(["--yes"]), configOf(passwordAndRoles, { app }));
        const rows = yield* sql<{ readonly passwordHash: string }>`
          SELECT a.passwordHash AS passwordHash FROM accounts a JOIN users u ON u.id = a.userId
          WHERE u.email = 'ada@example.com' AND a.providerId = 'password'`;
        const hash = PasswordHasher.PhcHash(rows[0]?.passwordHash ?? "");
        const hasher = yield* PasswordHasher.PasswordHasher.pipe(Effect.provide(app));
        assert.isTrue(yield* hasher.verify(Redacted.make("ExistingUser123!"), hash));
        assert.isFalse(yield* hasher.verify(Redacted.make("wrong-password"), hash));
        assert.isTrue(hasher.needsRehash(hash));
      }),
    ),
  );

  it.effect("is resumable: a second run imports nothing and reports the rows it skipped", () =>
    withTarget((sql) =>
      Effect.gen(function* () {
        const config = configOf(passwordAndRoles, { app: sqlApp(sql) });
        yield* runCli(importArgs(["--yes"]), config);
        const again = yield* runCli(importArgs(["--yes", "--json"]), config);
        assert.strictEqual(again.code, 0);
        const summary = summaryOf(again.stdout);
        assert.strictEqual(summary.users.toImport, 0);
        assert.strictEqual(summary.users.alreadyImported, 3);
        assert.strictEqual(yield* count(sql, "users"), 3);
        assert.strictEqual(yield* count(sql, "accounts"), 3);
      }),
    ),
  );

  it.effect("rolls a failing batch back, reports its source row ids, stops, and resumes from the checkpoint", () =>
    withTarget((sql) =>
      Effect.gen(function* () {
        const app = sqlApp(sql);
        const config = configOf(passwordAndRoles, { app });
        // Rows are read in id order — grace, ada | alan — so with --batch-size 2 the second batch fails.
        yield* sql`CREATE TRIGGER fail_alan BEFORE INSERT ON users WHEN NEW.email = 'alan@example.com'
          BEGIN SELECT RAISE(ABORT, 'injected'); END`;
        const failed = yield* runCli(importArgs(["--yes", "--batch-size", "2", "--json"]), config);
        assert.strictEqual(failed.code, 5);
        const summary = summaryOf(failed.stdout);
        assert.strictEqual(summary.failures.length, 1);
        assert.strictEqual(summary.failures[0].sourceRowIds.length, 1);
        assert.isString(summary.failures[0].error);
        // The first batch committed; the failed one left nothing behind — users, accounts or ledger.
        assert.strictEqual(yield* count(sql, "users"), 2);
        assert.strictEqual(yield* count(sql, "accounts"), 2);
        assert.strictEqual(yield* count(sql, ledgerTable), 2);
        const failedEvents = yield* AuditLog.AuditLog.use((log) => log.list({ eventTag: "auth.import.failed" })).pipe(
          Effect.provide(app),
        );
        assert.strictEqual(failedEvents.length, 1);

        // Repair and re-run the same command: it resumes, importing only what is missing.
        yield* sql`DROP TRIGGER fail_alan`;
        const resumed = yield* runCli(importArgs(["--yes", "--batch-size", "2", "--json"]), config);
        assert.strictEqual(resumed.code, 0);
        const done = summaryOf(resumed.stdout);
        assert.strictEqual(done.users.toImport, 1);
        assert.strictEqual(done.users.alreadyImported, 2);
        assert.strictEqual(yield* count(sql, "users"), 3);
        assert.strictEqual(yield* count(sql, "accounts"), 3);
      }),
    ),
  );

  it.effect("--continue-on-error keeps going past a failed batch", () =>
    withTarget((sql) =>
      Effect.gen(function* () {
        const config = configOf(passwordAndRoles, { app: sqlApp(sql) });
        yield* sql`CREATE TRIGGER fail_ada BEFORE INSERT ON users WHEN NEW.email = 'ada@example.com'
          BEGIN SELECT RAISE(ABORT, 'injected'); END`;
        const result = yield* runCli(
          importArgs(["--yes", "--batch-size", "1", "--continue-on-error", "--json"]),
          config,
        );
        assert.strictEqual(result.code, 5);
        const summary = summaryOf(result.stdout);
        assert.strictEqual(summary.users.failed, 1);
        assert.strictEqual(summary.users.toImport, 2);
        assert.strictEqual(yield* count(sql, "users"), 2);
      }),
    ),
  );

  it.effect("skips an email that already exists (a conflict, not a failure) and records it", () =>
    withTarget((sql) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO users (id, email, emailVerified, name, createdAt, updatedAt) VALUES ('pre', 'ada@example.com', 1, 'Ada', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
        const result = yield* runCli(
          importArgs(["--yes", "--json"]),
          configOf(passwordAndRoles, { app: sqlApp(sql) }),
        );
        assert.strictEqual(result.code, 0);
        assert.strictEqual(yield* count(sql, "users"), 3);
        const skipped = yield* sql<{ readonly status: string }>`SELECT status FROM awthaq_import_runs WHERE status = 'skipped'`;
        assert.strictEqual(skipped.length, 1);
      }),
    ),
  );

  it.effect("--report writes the per-row detail as JSON", () =>
    withTarget((sql) =>
      Effect.gen(function* () {
        const report = Path.join(tmpdir(), `awthaq-import-report-${Date.now()}.json`);
        const result = yield* runCli(
          importArgs(["--report", report]),
          configOf(passwordAndRoles, { app: sqlApp(sql) }),
        ).pipe(Effect.provide(NodeFileSystem.layer));
        assert.strictEqual(result.code, 0);
        const written = JSON.parse(readFileSync(report, "utf8"));
        assert.strictEqual(written.users.seen, 3);
        assert.isTrue("user.plan" in written.unmapped);
      }),
    ),
  );
});

describe("import: sources", () => {
  it.effect("--from lucia and --from authjs are registered and refused as not yet validated (exit 2), touching nothing", () =>
    withTarget((sql) =>
      Effect.gen(function* () {
        const config = configOf(passwordAndRoles, { app: sqlApp(sql) });
        for (const from of ["lucia", "authjs"]) {
          const result = yield* runCli(["import", "--from", from, "--source", "x", "--yes"], config);
          assert.strictEqual(result.code, 2);
          assert.isTrue(result.stderr.some((line) => line.includes("not yet validated")));
        }
        assert.isFalse(yield* hasLedger(sql));
      }),
    ),
  );

  it.effect("an unknown --from is a usage error before any source is opened", () =>
    withTarget((sql) =>
      Effect.gen(function* () {
        const result = yield* runCli(
          ["import", "--from", "mystery", "--source", "x"],
          configOf(passwordAndRoles, { app: sqlApp(sql) }),
        );
        assert.strictEqual(result.code, 2);
      }),
    ),
  );

  it.effect("a better-auth source that cannot be opened is SourceUnavailable (exit 9)", () =>
    withTarget((sql) =>
      Effect.gen(function* () {
        const result = yield* runCli(
          importArgs([]).map((arg) => (arg === betterAuthExport ? "sqlite:/nonexistent/dir/x.db" : arg)),
          configOf(passwordAndRoles, { app: sqlApp(sql) }),
        );
        assert.strictEqual(result.code, 9);
      }),
    ),
  );

  it.effect("firebase: imports password and federated users, reports the email-less and disabled records", () =>
    withTarget((sql) =>
      Effect.gen(function* () {
        const app = sqlApp(sql);
        const result = yield* runCli(
          [
            "import",
            "--from",
            "firebase",
            "--source",
            firebaseUsers,
            "--source-option",
            `hash-config=${firebaseHashConfig}`,
            "--issuer",
            "google=https://accounts.google.com",
            "--yes",
            "--json",
          ],
          configOf(passwordAndRoles, { app }),
        );
        assert.strictEqual(result.code, 0);
        const summary = summaryOf(result.stdout);
        assert.strictEqual(summary.users.toImport, 2);
        assert.strictEqual(summary.users.unmappable, 2);
        assert.deepStrictEqual(
          summary.unmappableRows.map((row: { sourceRowId: string }) => row.sourceRowId).sort(),
          ["fb-user-3", "fb-user-4"],
        );
        assert.strictEqual(yield* count(sql, "users"), 2);
        const google = yield* sql<{ readonly subject: string; readonly issuer: string }>`SELECT subject, issuer FROM accounts WHERE providerId = 'google'`;
        assert.deepStrictEqual(google, [
          { subject: "112233445566778899", issuer: "https://accounts.google.com" },
        ]);
        // The Firebase user keeps their password: the published test-vector password verifies and is flagged for rehash.
        const rows = yield* sql<{ readonly passwordHash: string }>`SELECT passwordHash FROM accounts WHERE providerId = 'password'`;
        const hash = PasswordHasher.PhcHash(rows[0]?.passwordHash ?? "");
        const hasher = yield* PasswordHasher.PasswordHasher.pipe(Effect.provide(app));
        assert.isTrue(yield* hasher.verify(Redacted.make("user1password"), hash));
        assert.isTrue(hasher.needsRehash(hash));
        // Unmappable rows are recorded (with their reason) but are not `done`, so a fixed source retries them.
        const unmappable = yield* sql<{ readonly source_row_id: string }>`SELECT source_row_id FROM awthaq_import_runs WHERE status = 'unmappable' ORDER BY source_row_id`;
        assert.deepStrictEqual(unmappable.map((r) => r.source_row_id), ["fb-user-3", "fb-user-4"]);
      }),
    ),
  );

  it.effect("import needs the application Layer to expose Users and the SqlClient (exit 9 otherwise)", () =>
    Effect.gen(function* () {
      const result = yield* runCli(importArgs(["--yes"]), configOf(passwordAndRoles));
      assert.strictEqual(result.code, 9);
    }),
  );
});
