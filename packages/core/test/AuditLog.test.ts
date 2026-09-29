// BEH-EA-100. Wayfinder map (.scratch/resolve-ready-for-human-findings),
// ticket 01 (ALF-001/ESA-001/ESS-002/CSG-004/EP-002).
//
// The same contract suite runs against both `Layer`s — `layerMemory` (a
// `Ref`) and `layerSql` (a real, in-memory SQLite database via
// `@effect/sql-sqlite-node`) — matching every other dual-backend suite in
// this package (`Sessions.test.ts`, `Verification.test.ts`).
import { Repositories } from "@awthaq/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import { UserId } from "../src/Users.ts";

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

const Migrated = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE auth_audit_log (
        id TEXT PRIMARY KEY,
        eventTag TEXT NOT NULL,
        actorUserId TEXT,
        tenantId TEXT,
        occurredAt TEXT NOT NULL,
        correlationId TEXT,
        payload TEXT NOT NULL
      )
    `;
  }),
).pipe(Layer.provide(SqlLive));

const SqlLayer = AuditLog.layerSql.pipe(
  Layer.provide(Repositories.AuditLogRepositoryLive),
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const userId = UserId("11111111-1111-1111-1111-111111111111");

const suite = (name: string, layer: Layer.Layer<AuditLog.AuditLog, unknown, never>): void => {
  describe(name, () => {
    it.effect("records every published AuthEvent, actorless events included", () =>
      Effect.gen(function* () {
        const auditLog = yield* AuditLog.AuditLog;
        yield* auditLog.record({ _tag: "auth.user.created", userId });
        yield* auditLog.record({ _tag: "auth.token.replay", identifier: "verify-email:u1" });
        const recorded = yield* auditLog.list();
        assert.strictEqual(recorded.length, 2);
        const created = recorded.find((r) => r.eventTag === "auth.user.created");
        const replay = recorded.find((r) => r.eventTag === "auth.token.replay");
        assert.isDefined(created);
        assert.isDefined(replay);
        assert.deepStrictEqual(created?.actorUserId, Option.some(userId));
        assert.deepStrictEqual(replay?.actorUserId, Option.none());
      }).pipe(Effect.provide(layer)),
    );

    // PERS-005: an organization PermissionEngine denial is durably recorded with who/what/why.
    it.effect("records an organization permission denial with its actor", () =>
      Effect.gen(function* () {
        const auditLog = yield* AuditLog.AuditLog;
        yield* auditLog.record({
          _tag: "auth.organization.permissionDenied",
          organizationId: "org-1",
          userId,
          resource: "member",
          action: "update",
          reason: "missingStatement",
        });
        const recorded = yield* auditLog.list({ eventTag: "auth.organization.permissionDenied" });
        assert.strictEqual(recorded.length, 1);
        assert.deepStrictEqual(recorded[0]?.actorUserId, Option.some(userId));
      }).pipe(Effect.provide(layer)),
    );

    // ECS-006/ECS-002: a CLI run has no session — the seeded target is in the payload, not the actor.
    it.effect("records the CLI's admin-seed and import events with no actor", () =>
      Effect.gen(function* () {
        const auditLog = yield* AuditLog.AuditLog;
        yield* auditLog.record({
          _tag: "auth.admin.seeded",
          targetUserId: userId,
          outcome: "created",
          forced: false,
          role: "admin",
          via: "cli",
        });
        yield* auditLog.record({ _tag: "auth.admin.seedRefused", reason: "adminExists" });
        yield* auditLog.record({
          _tag: "auth.import.completed",
          source: "better-auth",
          runId: "run-1",
          imported: 2,
          skipped: 0,
          failed: 0,
          unmapped: 1,
        });
        const seeded = yield* auditLog.list({ eventTag: "auth.admin.seeded" });
        assert.strictEqual(seeded.length, 1);
        assert.deepStrictEqual(seeded[0]?.actorUserId, Option.none());
        assert.strictEqual((yield* auditLog.list({ eventTag: "auth.admin.seedRefused" })).length, 1);
        assert.strictEqual((yield* auditLog.list({ eventTag: "auth.import.completed" })).length, 1);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("list narrows by eventTag", () =>
      Effect.gen(function* () {
        const auditLog = yield* AuditLog.AuditLog;
        yield* auditLog.record({ _tag: "auth.user.created", userId });
        yield* auditLog.record({ _tag: "auth.token.replay", identifier: "verify-email:u1" });
        const recorded = yield* auditLog.list({ eventTag: "auth.token.replay" });
        assert.strictEqual(recorded.length, 1);
        assert.strictEqual(recorded[0]?.eventTag, "auth.token.replay");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("list narrows by actorUserId", () =>
      Effect.gen(function* () {
        const auditLog = yield* AuditLog.AuditLog;
        const otherUserId = UserId("22222222-2222-2222-2222-222222222222");
        yield* auditLog.record({ _tag: "auth.user.created", userId });
        yield* auditLog.record({ _tag: "auth.user.created", userId: otherUserId });
        const recorded = yield* auditLog.list({ actorUserId: userId });
        assert.strictEqual(recorded.length, 1);
        assert.deepStrictEqual(recorded[0]?.actorUserId, Option.some(userId));
      }).pipe(Effect.provide(layer)),
    );
  });
};

suite("AuditLog (layerMemory)", AuditLog.layerMemory);
suite("AuditLog (layerSql)", SqlLayer);

// AuthEvents integration: BEH-EA-100's own point is that `publish` itself
// writes durably, never depending on a subscriber existing at all.
it.effect("AuthEvents.publish writes through AuditLog with zero subscribers", () =>
  Effect.gen(function* () {
    const events = yield* AuthEvents.AuthEvents;
    const auditLog = yield* AuditLog.AuditLog;
    yield* events.publish({ _tag: "auth.token.replay", identifier: "reset-password:u1" });
    const recorded = yield* auditLog.list();
    assert.strictEqual(recorded.length, 1);
    assert.strictEqual(recorded[0]?.eventTag, "auth.token.replay");
  }).pipe(Effect.provide(AuthEvents.layer.pipe(Layer.provideMerge(AuditLog.layerMemory)))),
);
