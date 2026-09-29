// spec.md's "Invitations": the same contract-suite-over-both-layers
// pattern `MembershipRecords.test.ts` uses. `layerSql` here is migrated via
// `Organization.Organization`'s own real `migrations` (`Migrations.run`,
// `@awthaq/core`) rather than a hand-rolled inline `CREATE TABLE` —
// BAM-002 (.issues/high) verification, the same
// `packages/jwt/test/RevocationStore.test.ts` establishes.
import { Migrations, Users } from "@awthaq/core";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as InvitationRecords from "../src/InvitationRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as TestSql from "../../sql/test/support/TestSql.ts";

const MemoryLayer = InvitationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer));

const SqlLive = TestSql.layer("organization_InvitationRecords");

const Migrated = Layer.effectDiscard(Migrations.run(Organization.Organization.migrations)).pipe(
  Layer.provide(SqlLive),
);

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

let hashCounter = 0;
const nextHash = (): string => `token-hash-${++hashCounter}`;

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
          tokenHash: nextHash(),
        });
        assert.strictEqual(record.email, "invitee@example.com");
        assert.strictEqual(record.status, "pending");
        assert.deepStrictEqual(record.teamId, Option.none());

        const found = yield* records.findById(record.id);
        assert.isTrue(Option.isSome(found));
      }).pipe(Effect.provide(layer)),
    );

    // MTI-010: the emailed capability is a random token whose SHA-256 is stored;
    // the invitation's own (REST-visible) id is no longer the secret.
    it.effect("findByTokenHash resolves the invitation by its hash and not by any other", () =>
      Effect.gen(function* () {
        const records = yield* InvitationRecords.InvitationRecords;
        const expiresAt = yield* future(48);
        const record = yield* records.create({
          email: "a@example.com",
          inviterId: inviter,
          organizationId: orgId,
          role: ["member"],
          expiresAt,
          tokenHash: "hash-of-secret",
        });
        assert.deepStrictEqual(record.tokenHash, Option.some("hash-of-secret"));
        const found = yield* records.findByTokenHash("hash-of-secret");
        assert.isTrue(Option.isSome(found) && found.value.id === record.id);
        assert.isTrue(Option.isNone(yield* records.findByTokenHash("some-other-hash")));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("setTokenHash rotates the hash: the old one stops resolving", () =>
      Effect.gen(function* () {
        const records = yield* InvitationRecords.InvitationRecords;
        const expiresAt = yield* future(48);
        const record = yield* records.create({
          email: "a@example.com",
          inviterId: inviter,
          organizationId: orgId,
          role: ["member"],
          expiresAt,
          tokenHash: "old-hash",
        });
        const rotated = yield* records.setTokenHash(record.id, "new-hash");
        assert.deepStrictEqual(rotated.tokenHash, Option.some("new-hash"));
        assert.isTrue(Option.isNone(yield* records.findByTokenHash("old-hash")));
        assert.isTrue(Option.isSome(yield* records.findByTokenHash("new-hash")));
        const failure = yield* records.setTokenHash("no-such-id", "x").pipe(Effect.flip);
        assert.strictEqual(failure._tag, "InvitationRecordNotFound");
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
          tokenHash: nextHash(),
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
          tokenHash: nextHash(),
        });
        yield* records.create({
          email: "a@example.com",
          inviterId: inviter,
          organizationId: "org-b",
          role: ["member"],
          expiresAt,
          tokenHash: nextHash(),
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
          tokenHash: nextHash(),
        });
        yield* records.create({
          email: "b@example.com",
          inviterId: inviter,
          organizationId: orgId,
          role: ["member"],
          expiresAt,
          tokenHash: nextHash(),
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
          tokenHash: nextHash(),
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
          tokenHash: nextHash(),
        });
        yield* records.create({
          email: "a@example.com",
          inviterId: inviter,
          organizationId: "org-b",
          role: ["member"],
          expiresAt,
          tokenHash: nextHash(),
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
