// BEH-EA-100. Wayfinder map (.scratch/resolve-ready-for-human-findings),
// ticket 01 (ALF-001/ESA-001/ESS-002/CSG-004/EP-002).
//
// The same contract suite runs against both `Layer`s — `layerMemory` (a
// `Ref`) and `layerSql` (a real, in-memory SQLite database via
// `@effect/sql-sqlite-node`) — matching every other dual-backend suite in
// this package (`Sessions.test.ts`, `Verification.test.ts`).
import { Repositories } from "@awthaq/sql";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import { SessionId } from "../src/Sessions.ts";
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
  Layer.provideMerge(Repositories.AuditLogRepositoryLive),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const userId = UserId("11111111-1111-1111-1111-111111111111");
const otherUserId = UserId("22222222-2222-2222-2222-222222222222");
const sessionId = SessionId("33333333-3333-3333-3333-333333333333");

/** A delivered event with a hand-set envelope: `n` orders ids, `ms` is the timestamp. */
const stamped = (event: AuthEvents.AuthEvent, n: number, ms = 1_700_000_000_000 + n * 1000) => {
  const published: AuthEvents.Published = {
    ...event,
    eventId: `018f0000-0000-7000-8000-${String(n).padStart(12, "0")}`,
    occurredAt: DateTime.makeUnsafe(ms),
    correlationId: Option.none(),
    traceId: Option.none(),
    spanId: Option.none(),
    ip: Option.none(),
    userAgent: Option.none(),
  };
  return published;
};

/** One sample per tag; the mapped type makes adding an `AuthEvent` without one a compile error. */
const samples: { readonly [Tag in AuthEvents.AuthEventTag]: AuthEvents.EventOf<Tag> } = {
  "auth.token.replay": { _tag: "auth.token.replay", identifier: "verify-email:u1" },
  "auth.user.created": { _tag: "auth.user.created", userId },
  "auth.user.signedIn": { _tag: "auth.user.signedIn", userId, strategy: "password" },
  "auth.user.signInFailed": {
    _tag: "auth.user.signInFailed",
    strategy: "password",
    reason: "invalidCredentials",
    clientIp: "203.0.113.5",
    identifierDigest: "ab12",
  },
  "auth.user.emailVerified": { _tag: "auth.user.emailVerified", userId },
  "auth.user.deleted": { _tag: "auth.user.deleted", userId, deletedBy: "self" },
  "auth.user.dataExported": { _tag: "auth.user.dataExported", userId, requestedBy: "self" },
  "auth.session.reuse": {
    _tag: "auth.session.reuse",
    sessionId,
    familyId: "fam-1",
    userId,
  },
  "auth.session.issued": {
    _tag: "auth.session.issued",
    sessionId,
    userId,
    familyId: "fam-1",
    actingAs: { type: "user", id: "admin-1" },
  },
  "auth.session.rotated": { _tag: "auth.session.rotated", sessionId, familyId: "fam-1", userId },
  "auth.session.superseded": {
    _tag: "auth.session.superseded",
    sessionId,
    supersededBy: sessionId,
    familyId: "fam-1",
    userId,
  },
  "auth.session.revoked": {
    _tag: "auth.session.revoked",
    userId,
    sessionId: null,
    scope: "all",
    reason: "signOut",
  },
  "auth.session.expired": { _tag: "auth.session.expired", sessionId, userId, kind: "idle" },
  "auth.password.changed": { _tag: "auth.password.changed", userId },
  "auth.password.resetRequested": { _tag: "auth.password.resetRequested", userId },
  "auth.password.resetCompleted": { _tag: "auth.password.resetCompleted", userId },
  "auth.passkey.counterAnomaly": {
    _tag: "auth.passkey.counterAnomaly",
    userId,
    credentialId: "cred-1",
  },
  "auth.admin.impersonationStarted": {
    _tag: "auth.admin.impersonationStarted",
    adminUserId: otherUserId,
    targetUserId: userId,
    reason: "customer asked us to reproduce a billing bug",
    sessionId,
  },
  "auth.admin.impersonationStopped": {
    _tag: "auth.admin.impersonationStopped",
    sessionId,
    adminUserId: otherUserId,
    targetUserId: userId,
    endedBy: "self",
  },
  "auth.admin.impersonationDenied": {
    _tag: "auth.admin.impersonationDenied",
    adminUserId: otherUserId,
    operation: "impersonate",
    targetUserId: userId,
  },
  "auth.admin.actionDenied": {
    _tag: "auth.admin.actionDenied",
    adminUserId: otherUserId,
    action: "listUsers",
  },
  "auth.admin.userUpdated": {
    _tag: "auth.admin.userUpdated",
    adminUserId: otherUserId,
    userId,
  },
  "auth.admin.sessionRevoked": {
    _tag: "auth.admin.sessionRevoked",
    adminUserId: otherUserId,
    userId,
    sessionId,
  },
  "auth.organization.created": {
    _tag: "auth.organization.created",
    organizationId: "org-1",
    creatorUserId: userId,
  },
  "auth.organization.updated": { _tag: "auth.organization.updated", organizationId: "org-1" },
  "auth.organization.deleted": { _tag: "auth.organization.deleted", organizationId: "org-1" },
  "auth.organization.memberAdded": {
    _tag: "auth.organization.memberAdded",
    organizationId: "org-1",
    userId,
    role: ["member"],
  },
  "auth.organization.memberRemoved": {
    _tag: "auth.organization.memberRemoved",
    organizationId: "org-1",
    userId,
  },
  "auth.organization.memberRoleUpdated": {
    _tag: "auth.organization.memberRoleUpdated",
    organizationId: "org-1",
    userId,
    role: ["admin"],
  },
  "auth.organization.invitationCreated": {
    _tag: "auth.organization.invitationCreated",
    invitationId: "inv-1",
    organizationId: "org-1",
  },
  "auth.organization.invitationAccepted": {
    _tag: "auth.organization.invitationAccepted",
    invitationId: "inv-1",
    organizationId: "org-1",
    userId,
  },
  "auth.organization.invitationRejected": {
    _tag: "auth.organization.invitationRejected",
    invitationId: "inv-1",
    organizationId: "org-1",
  },
  "auth.organization.invitationCanceled": {
    _tag: "auth.organization.invitationCanceled",
    invitationId: "inv-1",
    organizationId: "org-1",
  },
  "auth.organization.roleCreated": {
    _tag: "auth.organization.roleCreated",
    organizationId: "org-1",
    role: "editor",
  },
  "auth.organization.roleUpdated": {
    _tag: "auth.organization.roleUpdated",
    organizationId: "org-1",
    role: "editor",
  },
  "auth.organization.roleDeleted": {
    _tag: "auth.organization.roleDeleted",
    organizationId: "org-1",
    role: "editor",
  },
  "auth.organization.teamCreated": {
    _tag: "auth.organization.teamCreated",
    organizationId: "org-1",
    teamId: "team-1",
  },
  "auth.organization.teamUpdated": {
    _tag: "auth.organization.teamUpdated",
    organizationId: "org-1",
    teamId: "team-1",
  },
  "auth.organization.teamMoved": {
    _tag: "auth.organization.teamMoved",
    organizationId: "org-1",
    teamId: "team-1",
    parentId: null,
  },
  "auth.organization.teamDeleted": {
    _tag: "auth.organization.teamDeleted",
    organizationId: "org-1",
    teamId: "team-1",
  },
  "auth.organization.teamMemberAdded": {
    _tag: "auth.organization.teamMemberAdded",
    organizationId: "org-1",
    teamId: "team-1",
    userId,
  },
  "auth.organization.teamMemberRoleUpdated": {
    _tag: "auth.organization.teamMemberRoleUpdated",
    organizationId: "org-1",
    teamId: "team-1",
    userId,
    role: ["lead"],
  },
  "auth.organization.teamMemberRemoved": {
    _tag: "auth.organization.teamMemberRemoved",
    organizationId: "org-1",
    teamId: "team-1",
    userId,
  },
  "auth.organization.permissionDenied": {
    _tag: "auth.organization.permissionDenied",
    organizationId: "org-1",
    userId,
    resource: "member",
    action: "update",
    reason: "missingStatement",
  },
  "auth.authz.denied": {
    _tag: "auth.authz.denied",
    subjectId: `user:${userId}`,
    evaluationId: "eval-1",
    policyTag: "policy",
    action: "read",
    reason: "no matching permit",
  },
  "auth.roles.assigned": {
    _tag: "auth.roles.assigned",
    userId,
    roleName: "admin",
    actorUserId: otherUserId,
  },
  "auth.user.claimsUpdated": {
    _tag: "auth.user.claimsUpdated",
    userId,
    keys: ["plan"],
    actorUserId: otherUserId,
  },
  "auth.roles.revoked": { _tag: "auth.roles.revoked", userId, roleName: "admin" },
  "auth.rateLimit.exceeded": {
    _tag: "auth.rateLimit.exceeded",
    group: "password",
    endpoint: "signIn",
    rule: "signIn",
    dimension: "ip",
    retryAfterMillis: 1000,
  },
  "auth.mail.failed": { _tag: "auth.mail.failed", template: "verify-email", userId },
  "auth.admin.userBanned": {
    _tag: "auth.admin.userBanned",
    adminUserId: otherUserId,
    userId,
    reason: "abuse",
    until: null,
  },
  "auth.admin.userUnbanned": { _tag: "auth.admin.userUnbanned", adminUserId: otherUserId, userId },
  "auth.admin.organizationSuspended": {
    _tag: "auth.admin.organizationSuspended",
    adminUserId: otherUserId,
    organizationId: "org-1",
    reason: null,
  },
  "auth.admin.organizationUnsuspended": {
    _tag: "auth.admin.organizationUnsuspended",
    adminUserId: otherUserId,
    organizationId: "org-1",
  },
  "auth.scim.userProvisioned": {
    _tag: "auth.scim.userProvisioned",
    connectionId: "conn-1",
    organizationId: "org-1",
    userId,
  },
  "auth.scim.userDeactivated": {
    _tag: "auth.scim.userDeactivated",
    connectionId: "conn-1",
    organizationId: "org-1",
    userId,
  },
  "auth.scim.userReactivated": {
    _tag: "auth.scim.userReactivated",
    connectionId: "conn-1",
    organizationId: "org-1",
    userId,
  },
  "auth.scim.userDeleted": {
    _tag: "auth.scim.userDeleted",
    connectionId: "conn-1",
    organizationId: "org-1",
    userId,
  },
  "auth.scim.groupChanged": {
    _tag: "auth.scim.groupChanged",
    connectionId: "conn-1",
    organizationId: "org-1",
    teamId: "team-1",
    change: "created",
  },
  "auth.admin.seeded": {
    _tag: "auth.admin.seeded",
    targetUserId: userId,
    outcome: "created",
    forced: false,
    role: "admin",
    via: "cli",
  },
  "auth.admin.seedRefused": { _tag: "auth.admin.seedRefused", reason: "adminExists" },
  "auth.import.completed": {
    _tag: "auth.import.completed",
    source: "better-auth",
    runId: "run-1",
    imported: 2,
    skipped: 0,
    failed: 0,
    unmapped: 1,
  },
  "auth.import.failed": {
    _tag: "auth.import.failed",
    source: "better-auth",
    runId: "run-1",
    imported: 1,
    skipped: 0,
    failed: 1,
    unmapped: 0,
  },
  "auth.twoFactor.enabled": { _tag: "auth.twoFactor.enabled", userId },
  "auth.twoFactor.disabled": { _tag: "auth.twoFactor.disabled", userId },
  "auth.twoFactor.verified": {
    _tag: "auth.twoFactor.verified",
    userId,
    method: "totp",
    purpose: "signIn",
  },
  "auth.twoFactor.challengeFailed": {
    _tag: "auth.twoFactor.challengeFailed",
    userId,
    method: "recovery",
    purpose: "credentialReset",
  },
  "auth.twoFactor.recoveryCodeUsed": { _tag: "auth.twoFactor.recoveryCodeUsed", userId, remaining: 9 },
  "auth.twoFactor.recoveryCodesRegenerated": { _tag: "auth.twoFactor.recoveryCodesRegenerated", userId },
  "auth.twoFactor.locked": { _tag: "auth.twoFactor.locked", userId },
  "auth.apiKey.created": { _tag: "auth.apiKey.created", userId, keyId: "key-1" },
  "auth.apiKey.revoked": { _tag: "auth.apiKey.revoked", userId, keyId: "key-1" },
  "auth.apiKey.rotated": {
    _tag: "auth.apiKey.rotated",
    userId,
    keyId: "key-1",
    successorKeyId: "key-2",
  },
  "auth.apiKey.clientRegistered": { _tag: "auth.apiKey.clientRegistered", userId, clientId: "c-1" },
  "auth.apiKey.clientRevoked": { _tag: "auth.apiKey.clientRevoked", userId, clientId: "c-1" },
  "auth.apiKey.clientSecretRotated": {
    _tag: "auth.apiKey.clientSecretRotated",
    userId,
    clientId: "c-1",
  },
};

const allSamples: ReadonlyArray<AuthEvents.AuthEvent> = Object.values(samples);

const suite = (name: string, layer: Layer.Layer<AuditLog.AuditLog, unknown, never>): void => {
  describe(name, () => {
    it.effect("records every published AuthEvent, actorless events included", () =>
      Effect.gen(function* () {
        const auditLog = yield* AuditLog.AuditLog;
        yield* auditLog.record(stamped(samples["auth.user.created"], 1));
        yield* auditLog.record(stamped(samples["auth.token.replay"], 2));
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

    // ESA-007: a stored payload decodes back into the typed union — no `unknown`.
    it.effect("round-trips every AuthEvent variant through the schema codec", () =>
      Effect.gen(function* () {
        const auditLog = yield* AuditLog.AuditLog;
        for (const [index, event] of allSamples.entries()) {
          yield* auditLog.record(stamped(event, index + 1));
        }
        const recorded = yield* auditLog.list();
        assert.strictEqual(recorded.length, allSamples.length);
        const byId = new Map(recorded.map((record) => [record.id, record.payload]));
        for (const [index, event] of allSamples.entries()) {
          const id = `018f0000-0000-7000-8000-${String(index + 1).padStart(12, "0")}`;
          assert.deepStrictEqual(byId.get(id), event, event._tag);
        }
      }).pipe(Effect.provide(layer)),
    );

    // PERS-005: an organization PermissionEngine denial is durably recorded with who/what/why.
    it.effect("records an organization permission denial with its actor", () =>
      Effect.gen(function* () {
        const auditLog = yield* AuditLog.AuditLog;
        yield* auditLog.record(stamped(samples["auth.organization.permissionDenied"], 1));
        const recorded = yield* auditLog.list({ eventTag: "auth.organization.permissionDenied" });
        assert.strictEqual(recorded.length, 1);
        assert.deepStrictEqual(recorded[0]?.actorUserId, Option.some(userId));
      }).pipe(Effect.provide(layer)),
    );

    // ECS-006/ECS-002: a CLI run has no session — the seeded target is in the payload, not the actor.
    it.effect("records the CLI's admin-seed and import events with no actor", () =>
      Effect.gen(function* () {
        const auditLog = yield* AuditLog.AuditLog;
        yield* auditLog.record(stamped(samples["auth.admin.seeded"], 1));
        yield* auditLog.record(stamped(samples["auth.admin.seedRefused"], 2));
        yield* auditLog.record(stamped(samples["auth.import.completed"], 3));
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
        yield* auditLog.record(stamped(samples["auth.user.created"], 1));
        yield* auditLog.record(stamped(samples["auth.token.replay"], 2));
        const recorded = yield* auditLog.list({ eventTag: "auth.token.replay" });
        assert.strictEqual(recorded.length, 1);
        assert.strictEqual(recorded[0]?.eventTag, "auth.token.replay");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("list narrows by actorUserId", () =>
      Effect.gen(function* () {
        const auditLog = yield* AuditLog.AuditLog;
        yield* auditLog.record(stamped(samples["auth.user.created"], 1));
        yield* auditLog.record(stamped({ _tag: "auth.user.created", userId: otherUserId }, 2));
        const recorded = yield* auditLog.list({ actorUserId: userId });
        assert.strictEqual(recorded.length, 1);
        assert.deepStrictEqual(recorded[0]?.actorUserId, Option.some(userId));
      }).pipe(Effect.provide(layer)),
    );

    // ESA-002: `id` breaks a same-millisecond tie, so the order is total (newest first).
    it.effect("two events in the same millisecond list newest-first, deterministically by id", () =>
      Effect.gen(function* () {
        const auditLog = yield* AuditLog.AuditLog;
        const ms = 1_700_000_000_000;
        yield* auditLog.record(stamped({ _tag: "auth.token.replay", identifier: "first" }, 1, ms));
        yield* auditLog.record(stamped({ _tag: "auth.token.replay", identifier: "second" }, 2, ms));
        yield* auditLog.record(stamped({ _tag: "auth.token.replay", identifier: "third" }, 3, ms));
        const recorded = yield* auditLog.list();
        assert.deepStrictEqual(
          recorded.map((r) => (r.payload._tag === "auth.token.replay" ? r.payload.identifier : "")),
          ["third", "second", "first"],
        );
      }).pipe(Effect.provide(layer)),
    );

    // ESA-003: the recovery path for the at-most-once bus.
    it.effect("replay({ after }) yields every event after the checkpoint in publish order, across pages", () =>
      Effect.gen(function* () {
        const auditLog = yield* AuditLog.AuditLog;
        for (let n = 1; n <= 7; n++) {
          yield* auditLog.record(stamped({ _tag: "auth.token.replay", identifier: `e${n}` }, n));
        }
        const identifiers = (records: Iterable<AuditLog.AuditLogRecord>) =>
          Array.from(records, (r) => (r.payload._tag === "auth.token.replay" ? r.payload.identifier : ""));
        const all = yield* auditLog.replay({ batchSize: 3 }).pipe(Stream.runCollect);
        assert.deepStrictEqual(identifiers(all), ["e1", "e2", "e3", "e4", "e5", "e6", "e7"]);
        const checkpoint = Array.from(all)[2]?.id;
        const rest = yield* auditLog
          .replay(checkpoint === undefined ? {} : { after: checkpoint, batchSize: 2 })
          .pipe(Stream.runCollect);
        assert.deepStrictEqual(identifiers(rest), ["e4", "e5", "e6", "e7"]);
        const onlyTag = yield* auditLog
          .replay({ eventTag: "auth.user.created" })
          .pipe(Stream.runCollect);
        assert.strictEqual(onlyTag.length, 0);
      }).pipe(Effect.provide(layer)),
    );

    // ESA-005: erasure keeps the forensic timeline and drops the person.
    it.effect("pseudonymizeActor removes the user id and free-text reason from every row but keeps tag, time and id", () =>
      Effect.gen(function* () {
        const auditLog = yield* AuditLog.AuditLog;
        yield* auditLog.record(stamped(samples["auth.user.created"], 1));
        yield* auditLog.record(stamped(samples["auth.admin.impersonationStarted"], 2));
        yield* auditLog.record(stamped(samples["auth.authz.denied"], 3));
        yield* auditLog.record(stamped({ _tag: "auth.token.replay", identifier: `verify-email:${userId}` }, 4));
        yield* auditLog.record(stamped({ _tag: "auth.user.created", userId: otherUserId }, 5));

        const rewritten = yield* auditLog.pseudonymizeActor(userId);
        assert.strictEqual(rewritten, 4);
        // Idempotent: a second pass finds nothing left to rewrite.
        assert.strictEqual(yield* auditLog.pseudonymizeActor(userId), 0);

        const rows = yield* auditLog.list();
        assert.strictEqual(rows.length, 5);
        const text = JSON.stringify(rows.map((row) => row.payload));
        assert.notInclude(text, userId);
        assert.notInclude(text, "billing bug");
        // Tag, id and timestamp survive; the alias stands in consistently...
        const created = rows.find((row) => row.id.endsWith("000000000001"));
        assert.strictEqual(created?.eventTag, "auth.user.created");
        assert.strictEqual(created?.occurredAt.epochMilliseconds, 1_700_000_001_000);
        const alias = Option.getOrUndefined(created?.actorUserId ?? Option.none());
        assert.isDefined(alias);
        assert.notStrictEqual(alias, userId);
        const impersonation = rows.find((row) => row.eventTag === "auth.admin.impersonationStarted");
        assert.strictEqual(
          impersonation?.payload._tag === "auth.admin.impersonationStarted"
            ? impersonation.payload.targetUserId
            : "",
          alias,
        );
        // ...another user's rows are untouched, and nothing lists the erased id any more.
        assert.strictEqual((yield* auditLog.list({ actorUserId: userId })).length, 0);
        assert.strictEqual((yield* auditLog.list({ actorUserId: otherUserId })).length, 2);
      }).pipe(Effect.provide(layer)),
    );
  });
};

suite("AuditLog (layerMemory)", AuditLog.layerMemory);
suite("AuditLog (layerSql)", SqlLayer);

describe("AuditLog (layerSql) — ESA-007 stored-row decoding", () => {
  it.effect("a hand-inserted malformed row surfaces the typed AuditLogDecodeError, not a defect", () =>
    Effect.gen(function* () {
      const repo = yield* Repositories.AuditLogRepository;
      const auditLog = yield* AuditLog.AuditLog;
      yield* repo.insert({
        id: "018f0000-0000-7000-8000-000000000099",
        eventTag: "auth.user.created",
        actorUserId: null,
        occurredAt: DateTime.makeUnsafe(1_700_000_000_000),
        correlationId: null,
        payload: { _tag: "auth.user.created" }, // userId missing
      });
      const failure = yield* auditLog.list().pipe(Effect.flip);
      assert.strictEqual(failure._tag, "AuditLogDecodeError");
      assert.strictEqual(failure.id, "018f0000-0000-7000-8000-000000000099");
    }).pipe(Effect.provide(SqlLayer)),
  );

  it.effect("a payload written before versioning existed (no `version`, no `meta`) still decodes", () =>
    Effect.gen(function* () {
      const repo = yield* Repositories.AuditLogRepository;
      const auditLog = yield* AuditLog.AuditLog;
      yield* repo.insert({
        id: "018f0000-0000-7000-8000-000000000098",
        eventTag: "auth.user.created",
        actorUserId: null,
        occurredAt: DateTime.makeUnsafe(1_700_000_000_000),
        correlationId: null,
        payload: { _tag: "auth.user.created", userId },
      });
      const [row] = yield* auditLog.list();
      assert.deepStrictEqual(row?.payload, { _tag: "auth.user.created", userId });
    }).pipe(Effect.provide(SqlLayer)),
  );
});

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
