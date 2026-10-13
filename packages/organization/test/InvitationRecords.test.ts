// spec.md's "Invitations": the same contract-suite-over-both-layers
// pattern `MembershipRecords.test.ts` uses. `layerSql` here is migrated via
// `Organization.Organization`'s own real `migrations` (`Migrations.run`,
// `@awthaq/core`) rather than a hand-rolled inline `CREATE TABLE` —
// BAM-002 (.issues/high) verification, the same
// `packages/jwt/test/RevocationStore.test.ts` establishes.
import { Migrations, Users } from "@awthaq/core";
import { TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as InvitationRecords from "../src/InvitationRecords.ts";
import * as Organization from "../src/Organization.ts";
import { TestSql } from "@awthaq/test";
import { ambientOrganization, grant, vitestFramework } from "./support.ts";

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

        const found = yield* records.findById(grant, record.id);
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
        const found = yield* records.findByTokenHash(grant, "hash-of-secret");
        assert.isTrue(Option.isSome(found) && found.value.id === record.id);
        assert.isTrue(Option.isNone(yield* records.findByTokenHash(grant, "some-other-hash")));
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
        const rotated = yield* records.setTokenHash(orgId, record.id, "new-hash");
        assert.deepStrictEqual(rotated.tokenHash, Option.some("new-hash"));
        assert.isTrue(Option.isNone(yield* records.findByTokenHash(grant, "old-hash")));
        assert.isTrue(Option.isSome(yield* records.findByTokenHash(grant, "new-hash")));
        const failure = yield* records.setTokenHash(orgId, "no-such-id", "x").pipe(Effect.flip);
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

        yield* records.updateStatus(orgId, record.id, "accepted");
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
        assert.strictEqual((yield* records.listByEmail(grant, "a@example.com")).length, 2);
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
        yield* records.updateStatus(orgId, a.id, "canceled");
        assert.strictEqual(yield* records.countPendingByInviter(grant, inviter), 1);
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
        const updated = yield* records.updateStatus(orgId, record.id, "accepted");
        assert.strictEqual(updated.status, "accepted");
        const failure = yield* records
          .updateStatus(orgId, "no-such-id", "accepted")
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "InvitationRecordNotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("purgeExpired deletes only the invitations whose expiry is before the cutoff", () =>
      Effect.gen(function* () {
        const records = yield* InvitationRecords.InvitationRecords;
        const make = (email: string, expiresAt: DateTime.Utc) =>
          records.create({
            email,
            inviterId: inviter,
            organizationId: orgId,
            role: ["member"],
            expiresAt,
            tokenHash: nextHash(),
          });
        const gone = yield* make("old@example.com", yield* future(-100));
        const kept = yield* make("live@example.com", yield* future(48));
        assert.strictEqual(yield* records.purgeExpired(grant, yield* future(-1)), 1);
        assert.isTrue(Option.isNone(yield* records.findById(grant, gone.id)));
        assert.isTrue(Option.isSome(yield* records.findById(grant, kept.id)));
        assert.strictEqual(yield* records.purgeExpired(grant, yield* future(-1)), 0);
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

// Plan 05: the tenant-isolation conformance suite. `organization_invitation` is Keyed by
// `organizationId`: a method that takes an organization id can only reach that organization's rows;
// the ones that resolve an invitation by its own capability (id, token) or by a person (invitee,
// inviter) take a witness. It replaces the regex guard of `TenantScoping.test.ts`.
let isolationCounter = 0;
interface Row {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly inviterId: Users.UserId;
  readonly tokenHash: string;
}
const orgOf = (row: Row, as: "owner" | "other") =>
  as === "owner" ? row.organizationId : "another-organization";
const present = (row: Row) =>
  Effect.flatMap(InvitationRecords.InvitationRecords, (records) =>
    Effect.map(records.findById(grant, row.id), Option.isSome),
  );
/** Runs `change` and reports whether the row stopped being as it was (gone, or no longer pending). */
const changed = (
  row: Row,
  change: (records: InvitationRecords.InvitationRecordsShape) => Effect.Effect<unknown, unknown>,
) =>
  Effect.flatMap(InvitationRecords.InvitationRecords, (records) =>
    Effect.gen(function* () {
      const before = yield* records.findById(grant, row.id);
      yield* change(records).pipe(Effect.ignore);
      const after = yield* records.findById(grant, row.id);
      return (
        Option.isSome(before) &&
        (Option.isNone(after) ||
          after.value.status !== before.value.status ||
          Option.getOrUndefined(after.value.tokenHash) !==
            Option.getOrUndefined(before.value.tokenHash))
      );
    }),
  );

const isolationCase: TestAuth.TableCase<
  InvitationRecords.InvitationRecordsShape,
  Row,
  InvitationRecords.InvitationRecords
> = {
  table: "organization_invitation",
  insert: Effect.gen(function* () {
    const records = yield* InvitationRecords.InvitationRecords;
    isolationCounter += 1;
    const organizationId = yield* ambientOrganization;
    const email = `isolation-${isolationCounter}@example.com`;
    const inviterId = Users.UserId(`isolation-inviter-${isolationCounter}`);
    const tokenHash = `isolation-token-${isolationCounter}`;
    const created = yield* records.create({
      email,
      inviterId,
      organizationId,
      role: ["member"],
      expiresAt: yield* future(48),
      tokenHash,
    });
    return { id: created.id, organizationId, email, inviterId, tokenHash };
  }),
  methods: {
    create: { insert: true },
    findById: {
      crossTenant: { run: (row) => present(row) },
    },
    findByTokenHash: {
      crossTenant: {
        run: (row) =>
          Effect.flatMap(InvitationRecords.InvitationRecords, (records) =>
            Effect.map(records.findByTokenHash(grant, row.tokenHash), Option.isSome),
          ),
      },
    },
    setTokenHash: {
      keyed: {
        run: (row, as) =>
          changed(row, (records) =>
            records.setTokenHash(orgOf(row, as), row.id, `${row.tokenHash}-rotated`),
          ),
      },
    },
    findPendingByEmailAndOrg: {
      keyed: {
        run: (row, as) =>
          Effect.flatMap(InvitationRecords.InvitationRecords, (records) =>
            Effect.map(records.findPendingByEmailAndOrg(row.email, orgOf(row, as)), Option.isSome),
          ),
      },
    },
    listByOrganization: {
      keyed: {
        run: (row, as) =>
          Effect.flatMap(InvitationRecords.InvitationRecords, (records) =>
            Effect.map(records.listByOrganization(orgOf(row, as)), (rows) =>
              rows.some((found) => found.id === row.id),
            ),
          ),
      },
    },
    listByEmail: {
      crossTenant: {
        run: (row) =>
          Effect.flatMap(InvitationRecords.InvitationRecords, (records) =>
            Effect.map(records.listByEmail(grant, row.email), (rows) =>
              rows.some((found) => found.id === row.id),
            ),
          ),
      },
    },
    listByInviter: {
      crossTenant: {
        run: (row) =>
          Effect.flatMap(InvitationRecords.InvitationRecords, (records) =>
            Effect.map(records.listByInviter(grant, row.inviterId), (rows) =>
              rows.some((found) => found.id === row.id),
            ),
          ),
      },
    },
    countPendingByInviter: {
      crossTenant: {
        run: (row) =>
          Effect.flatMap(InvitationRecords.InvitationRecords, (records) =>
            Effect.map(records.countPendingByInviter(grant, row.inviterId), (count) => count > 0),
          ),
      },
    },
    updateStatus: {
      keyed: {
        run: (row, as) =>
          changed(row, (records) => records.updateStatus(orgOf(row, as), row.id, "canceled")),
      },
    },
    purgeExpired: {
      crossTenant: {
        run: (row) =>
          changed(row, (records) =>
            Effect.flatMap(future(24 * 365), (before) => records.purgeExpired(grant, before)),
          ),
      },
    },
    removeAllForOrganization: {
      keyed: {
        run: (row, as) =>
          changed(row, (records) => records.removeAllForOrganization(orgOf(row, as))),
      },
    },
    removeAllForUser: {
      crossTenant: {
        run: (row) =>
          changed(row, (records) => records.removeAllForUser(grant, row.inviterId, undefined)),
      },
    },
  },
};

TestAuth.runTenantIsolationTests(vitestFramework, {
  plugin: Organization.Organization,
  covers: ["organization_invitation"],
  adapters: [
    { name: "layerMemory", layer: MemoryLayer },
    { name: "layerSql", layer: SqlLayer },
  ],
  cases: [isolationCase],
  rls: { layer: SqlLayer },
});
