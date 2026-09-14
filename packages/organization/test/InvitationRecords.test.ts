// spec.md's "Invitations": the same contract-suite-over-both-layers
// pattern `MembershipRecords.test.ts` uses.
import { Users } from "@awthaq/core";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as InvitationRecords from "../src/InvitationRecords.ts";

const MemoryLayer = InvitationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer));

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

const Migrated = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE organization_invitation (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        inviterId TEXT NOT NULL,
        organizationId TEXT NOT NULL,
        teamId TEXT,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL
      )
    `;
  }),
).pipe(Layer.provide(SqlLive));

const SqlLayer = InvitationRecords.layerSql.pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const orgId = "org-1";
const inviter = Users.UserId("inviter-1");
const future = (hours: number) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    return DateTime.addDuration(now, Duration.hours(hours));
  });

const suite = (
  name: string,
  layer: Layer.Layer<InvitationRecords.InvitationRecords, unknown, never>,
): void => {
  describe(name, () => {
    it.effect("create then findById round-trips every field", () =>
      Effect.gen(function* () {
        const records = yield* InvitationRecords.InvitationRecords;
        const expiresAt = yield* future(48);
        const record = yield* records.create({
          email: "Invitee@Example.com",
          inviterId: inviter,
          organizationId: orgId,
          role: ["member"],
          expiresAt,
        });
        assert.strictEqual(record.email, "invitee@example.com");
        assert.strictEqual(record.status, "pending");
        assert.deepStrictEqual(record.teamId, Option.none());

        const found = yield* records.findById(record.id);
        assert.isTrue(Option.isSome(found));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("findPendingByEmailAndOrg only matches pending status", () =>
      Effect.gen(function* () {
        const records = yield* InvitationRecords.InvitationRecords;
        const expiresAt = yield* future(48);
        const record = yield* records.create({
          email: "a@example.com",
          inviterId: inviter,
          organizationId: orgId,
          role: ["member"],
          expiresAt,
        });
        const foundPending = yield* records.findPendingByEmailAndOrg("a@example.com", orgId);
        assert.isTrue(Option.isSome(foundPending));

        yield* records.updateStatus(record.id, "accepted");
        const foundAfter = yield* records.findPendingByEmailAndOrg("a@example.com", orgId);
        assert.isTrue(Option.isNone(foundAfter));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("listByOrganization and listByEmail filter correctly", () =>
      Effect.gen(function* () {
        const records = yield* InvitationRecords.InvitationRecords;
        const expiresAt = yield* future(48);
        yield* records.create({
          email: "a@example.com",
          inviterId: inviter,
          organizationId: "org-a",
          role: ["member"],
          expiresAt,
        });
        yield* records.create({
          email: "a@example.com",
          inviterId: inviter,
          organizationId: "org-b",
          role: ["member"],
          expiresAt,
        });
        assert.strictEqual((yield* records.listByOrganization("org-a")).length, 1);
        assert.strictEqual((yield* records.listByEmail("a@example.com")).length, 2);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("countPendingByInviter counts only pending invitations from that inviter", () =>
      Effect.gen(function* () {
        const records = yield* InvitationRecords.InvitationRecords;
        const expiresAt = yield* future(48);
        const a = yield* records.create({
          email: "a@example.com",
          inviterId: inviter,
          organizationId: orgId,
          role: ["member"],
          expiresAt,
        });
        yield* records.create({
          email: "b@example.com",
          inviterId: inviter,
          organizationId: orgId,
          role: ["member"],
          expiresAt,
        });
        yield* records.updateStatus(a.id, "canceled");
        assert.strictEqual(yield* records.countPendingByInviter(inviter), 1);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("updateStatus transitions status; fails for an unknown id", () =>
      Effect.gen(function* () {
        const records = yield* InvitationRecords.InvitationRecords;
        const expiresAt = yield* future(48);
        const record = yield* records.create({
          email: "a@example.com",
          inviterId: inviter,
          organizationId: orgId,
          role: ["member"],
          expiresAt,
        });
        const updated = yield* records.updateStatus(record.id, "accepted");
        assert.strictEqual(updated.status, "accepted");
        const failure = yield* records.updateStatus("no-such-id", "accepted").pipe(Effect.flip);
        assert.strictEqual(failure._tag, "InvitationRecordNotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("removeAllForOrganization clears every invitation for that org, and no other", () =>
      Effect.gen(function* () {
        const records = yield* InvitationRecords.InvitationRecords;
        const expiresAt = yield* future(48);
        yield* records.create({
          email: "a@example.com",
          inviterId: inviter,
          organizationId: "org-a",
          role: ["member"],
          expiresAt,
        });
        yield* records.create({
          email: "a@example.com",
          inviterId: inviter,
          organizationId: "org-b",
          role: ["member"],
          expiresAt,
        });
        yield* records.removeAllForOrganization("org-a");
        assert.strictEqual((yield* records.listByOrganization("org-a")).length, 0);
        assert.strictEqual((yield* records.listByOrganization("org-b")).length, 1);
      }).pipe(Effect.provide(layer)),
    );
  });
};

suite("InvitationRecords (layerMemory)", MemoryLayer);
suite("InvitationRecords (layerSql)", SqlLayer);
