// CSG-005 (GDPR Art. 15/20): `AccountExport.exportAccount` and the `DataExportRegistry`
// plugins contribute a section to (ADR-EA-033).
import { PasswordHasher } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Accounts from "../src/Accounts.ts";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as DataExport from "../src/DataExport.ts";
import * as Hooks from "../src/Hooks.ts";
import * as Sessions from "../src/Sessions.ts";
import * as Users from "../src/Users.ts";
import * as Verification from "../src/Verification.ts";

const section = (id: string, order: number | undefined, value: DataExport.ExportSection) =>
  DataExport.contribute({
    id,
    ...(order === undefined ? {} : { order }),
    make: Effect.succeed(() => Effect.succeed(value)),
  });

const layerWith = <E>(contributions: Layer.Layer<never, E, DataExport.DataExportRegistry>) =>
  Layer.mergeAll(DataExport.layer, contributions).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Users.layerMemory,
        Accounts.layerMemory,
        Sessions.layerMemory,
        Verification.layerMemory,
      ),
    ),
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layerMemory),
    Layer.provideMerge(Hooks.HooksLive),
    Layer.provideMerge(NodeCrypto.layer),
  );

const seed = Effect.gen(function* () {
  const users = yield* Users.Users;
  const accounts = yield* Accounts.Accounts;
  const sessions = yield* Sessions.Sessions;
  const user = yield* users.create({
    identity: { _tag: "Email", email: "Export@Example.com" },
    name: "Exporter",
  });
  yield* accounts.link({
    userId: user.id,
    providerId: "google",
    subject: "google-sub-1",
    issuer: "https://accounts.example.com",
  });
  // A credential hash and provider tokens exist on the row; none may reach the export.
  yield* accounts.link({
    userId: user.id,
    providerId: "password",
    subject: user.id,
    credentialHash: Redacted.make(
      PasswordHasher.PhcHash("$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA"),
    ),
  });
  yield* sessions.issue({
    userId: user.id,
    request: { ip: "203.0.113.9", userAgent: "TestAgent/1" },
  });
  return user;
});

describe("AccountExport", () => {
  it.effect(
    "assembles the user, accounts, sessions, activity and one section per contribution",
    () =>
      Effect.gen(function* () {
        const exporter = yield* DataExport.AccountExport;
        const auditLog = yield* AuditLog.AuditLog;
        const user = yield* seed;
        const other = yield* (yield* Users.Users).create({
          identity: { _tag: "Email", email: "other@example.com" },
          name: "Other",
        });

        const document = yield* exporter.exportAccount(user.id);

        assert.strictEqual(document.user.id, user.id);
        assert.deepStrictEqual(document.user.identity, {
          _tag: "Email",
          email: "export@example.com",
          emailVerified: false,
        });
        assert.deepStrictEqual(
          document.accounts.map((account) => [account.providerId, account.issuer]),
          [
            ["google", "https://accounts.example.com"],
            ["password", null],
          ],
        );
        assert.strictEqual(document.sessions.length, 1);
        assert.strictEqual(document.sessions[0]?.userAgent, "TestAgent/1");
        assert.isTrue(document.activity.some((row) => row.event === "auth.session.issued"));
        // sections keyed by contribution id, in run order (`order`, then id)
        assert.deepStrictEqual(Object.keys(document.sections), ["a", "b", "c"]);
        assert.deepStrictEqual(document.sections["b"], { note: "hello" });
        assert.isTrue(DateTime.isDateTime(DateTime.makeUnsafe(document.generatedAt)));

        // no secret of any kind, and nothing about anyone else
        const json = JSON.stringify(document);
        assert.notInclude(json, "argon2id");
        assert.notInclude(json, "credentialHash");
        assert.notInclude(json, "secretHash");
        assert.notInclude(json, other.id);
        assert.notInclude(json, "other@example.com");

        // the export is audited, with ids only
        const recorded = yield* auditLog.list({ eventTag: "auth.user.dataExported" });
        assert.strictEqual(recorded.length, 1);
        assert.deepStrictEqual(recorded[0]?.payload, {
          _tag: "auth.user.dataExported",
          userId: user.id,
          requestedBy: "self",
        });
      }).pipe(
        Effect.provide(
          layerWith(
            Layer.mergeAll(
              section("c", 2, [1, 2]),
              section("a", undefined, { rows: [] }),
              section("b", 1, { note: "hello" }),
            ),
          ),
        ),
      ),
  );

  it.effect("records who requested it when an administrator exports on the user's behalf", () =>
    Effect.gen(function* () {
      const exporter = yield* DataExport.AccountExport;
      const auditLog = yield* AuditLog.AuditLog;
      const user = yield* seed;
      yield* exporter.exportAccount(user.id, { requestedBy: "admin" });
      const recorded = yield* auditLog.list({ eventTag: "auth.user.dataExported" });
      assert.strictEqual(
        recorded[0]?.payload._tag === "auth.user.dataExported" && recorded[0].payload.requestedBy,
        "admin",
      );
    }).pipe(Effect.provide(layerWith(Layer.empty))),
  );

  it.effect("an unknown user fails UserNotFound and publishes nothing", () =>
    Effect.gen(function* () {
      const exporter = yield* DataExport.AccountExport;
      const auditLog = yield* AuditLog.AuditLog;
      const failure = yield* exporter
        .exportAccount(Users.UserId("00000000-0000-4000-8000-000000000000"))
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "UserNotFound");
      assert.deepStrictEqual(yield* auditLog.list({ eventTag: "auth.user.dataExported" }), []);
    }).pipe(Effect.provide(layerWith(Layer.empty))),
  );

  it.effect("a failing contribution fails the whole export: no partial document, no event", () =>
    Effect.gen(function* () {
      const exporter = yield* DataExport.AccountExport;
      const auditLog = yield* AuditLog.AuditLog;
      const user = yield* seed;
      const exit = yield* Effect.exit(exporter.exportAccount(user.id));
      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(yield* auditLog.list({ eventTag: "auth.user.dataExported" }), []);
    }).pipe(
      Effect.provide(
        layerWith(
          Layer.mergeAll(
            section("fine", 1, { ok: true }),
            DataExport.contribute({
              id: "broken",
              order: 2,
              make: Effect.succeed(() => Effect.die(new Error("plugin store unavailable"))),
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("the registry freezes on first read: a late contribution is a defect", () =>
    Effect.gen(function* () {
      const registry = yield* DataExport.DataExportRegistry;
      yield* registry.contributions;
      const exit = yield* Effect.exit(
        registry.register({ id: "late", collect: () => Effect.succeed(null) }),
      );
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(Effect.provide(layerWith(Layer.empty))),
  );
});
