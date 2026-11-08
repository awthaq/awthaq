// Plan 25 ticket 12 (ADR-EA-041 decision 9): `InvitationRecords`' contract, run on memory and SQL (Postgres under
// `pnpm test:pg`) from `Contract.test.ts`. A transition is a compare-and-set from `pending` (BEH-EA-286): of
// racing accept, reject, cancel and expire exactly one wins. The per-inviter quota (`pendingWithin`) is decided
// with the insert.
import { Users } from "@awthaq/core";
import { RecordsContract, type TestAuth } from "@awthaq/test";
import { assert } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as InvitationRecords from "../../src/InvitationRecords.ts";
import { ambientOrganization, grant } from "../support.ts";

const orgId = "org-1";
const inviter = Users.UserId("inviter-1");
const future = (hours: number) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    return DateTime.addDuration(now, Duration.hours(hours));
  });

let hashCounter = 0;
const nextHash = (): string => `token-hash-${++hashCounter}`;

const invite = (
  email: string,
  options?: { readonly pendingWithin?: { readonly limit: number; readonly grant: typeof grant } },
) =>
  Effect.gen(function* () {
    const records = yield* InvitationRecords.InvitationRecords;
    return yield* records.create(
      {
        email,
        inviterId: inviter,
        organizationId: orgId,
        role: ["member"],
        expiresAt: yield* future(48),
        tokenHash: nextHash(),
      },
      options,
    );
  });

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
    transition: {
      keyed: {
        run: (row, as) =>
          changed(row, (records) =>
            records.transition(orgOf(row, as), row.id, { from: "pending", to: "canceled" }),
          ),
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

export const invitationRecords = RecordsContract.suite(InvitationRecords.InvitationRecords, {
  operations: {
    create: {
      atomic: [
        {
          name: "create then findById round-trips every field",
          run: Effect.gen(function* () {
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
          }),
        },
        {
          name: "pendingWithin refuses at the inviter's limit (InvitationRecords/LimitReached); a settled one frees a slot",
          run: Effect.gen(function* () {
            const records = yield* InvitationRecords.InvitationRecords;
            const bound = { pendingWithin: { limit: 2, grant } };
            const first = yield* invite("a@example.com", bound);
            yield* invite("b@example.com", bound);
            const refused = yield* Effect.flip(invite("c@example.com", bound));
            assert.strictEqual(refused._tag, "InvitationRecords/LimitReached");
            yield* records.transition(orgId, first.id, { from: "pending", to: "canceled" });
            yield* invite("c@example.com", bound);
            assert.strictEqual(yield* records.countPendingByInviter(grant, inviter), 2);
          }),
        },
      ],
      race: [
        {
          name: "8 invitations racing at pendingWithin - 1 store exactly one",
          run: Effect.gen(function* () {
            const records = yield* InvitationRecords.InvitationRecords;
            yield* invite("first@example.com");
            const outcomes = yield* Effect.all(
              Array.from({ length: RecordsContract.CONCURRENCY }, (_, n) =>
                Effect.exit(invite(`r${n}@example.com`, { pendingWithin: { limit: 2, grant } })),
              ),
              { concurrency: "unbounded" },
            );
            assert.strictEqual(outcomes.filter((exit) => exit._tag === "Success").length, 1);
            assert.strictEqual(yield* records.countPendingByInviter(grant, inviter), 2);
          }),
        },
      ],
    },
    findById: {
      read: [
        {
          name: "finds an invitation by id with the witness",
          run: Effect.gen(function* () {
            const records = yield* InvitationRecords.InvitationRecords;
            const created = yield* invite("a@example.com");
            assert.isTrue(Option.isSome(yield* records.findById(grant, created.id)));
            assert.isTrue(Option.isNone(yield* records.findById(grant, "missing")));
          }),
        },
      ],
    },
    findByTokenHash: {
      read: [
        // MTI-010: the emailed capability is a random token whose SHA-256 is stored;
        // the invitation's own (REST-visible) id is no longer the secret.
        {
          name: "findByTokenHash resolves the invitation by its hash and not by any other",
          run: Effect.gen(function* () {
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
          }),
        },
      ],
    },
    setTokenHash: {
      write: [
        {
          name: "setTokenHash rotates the hash: the old one stops resolving",
          run: Effect.gen(function* () {
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
          }),
        },
      ],
    },
    findPendingByEmailAndOrg: {
      read: [
        {
          name: "findPendingByEmailAndOrg only matches pending status",
          run: Effect.gen(function* () {
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

            yield* records.transition(orgId, record.id, { from: "pending", to: "accepted" });
            const foundAfter = yield* records.findPendingByEmailAndOrg("a@example.com", orgId);
            assert.isTrue(Option.isNone(foundAfter));
          }),
        },
      ],
    },
    listByOrganization: {
      read: [
        {
          name: "listByOrganization and listByEmail filter correctly",
          run: Effect.gen(function* () {
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
          }),
        },
      ],
    },
    listByEmail: {
      read: [
        {
          name: "lists an email's invitations across organizations, case-insensitively",
          run: Effect.gen(function* () {
            const records = yield* InvitationRecords.InvitationRecords;
            yield* invite("Who@Example.com");
            yield* records.create({
              email: "who@example.com",
              inviterId: inviter,
              organizationId: "org-2",
              role: ["member"],
              expiresAt: yield* future(48),
              tokenHash: nextHash(),
            });
            assert.strictEqual((yield* records.listByEmail(grant, "WHO@example.com")).length, 2);
          }),
        },
      ],
    },
    listByInviter: {
      read: [
        {
          name: "lists every invitation the user sent, any status",
          run: Effect.gen(function* () {
            const records = yield* InvitationRecords.InvitationRecords;
            const a = yield* invite("a@example.com");
            yield* invite("b@example.com");
            yield* records.transition(orgId, a.id, { from: "pending", to: "rejected" });
            assert.strictEqual((yield* records.listByInviter(grant, inviter)).length, 2);
            assert.strictEqual(
              (yield* records.listByInviter(grant, Users.UserId("nobody"))).length,
              0,
            );
          }),
        },
      ],
    },
    countPendingByInviter: {
      read: [
        {
          name: "countPendingByInviter counts only pending invitations from that inviter",
          run: Effect.gen(function* () {
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
            yield* records.transition(orgId, a.id, { from: "pending", to: "canceled" });
            assert.strictEqual(yield* records.countPendingByInviter(grant, inviter), 1);
          }),
        },
      ],
    },
    transition: {
      atomic: [
        {
          name: "moves a pending invitation once; a second transition answers false; an unknown id fails",
          run: Effect.gen(function* () {
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
            assert.isTrue(
              yield* records.transition(orgId, record.id, { from: "pending", to: "accepted" }),
            );
            assert.strictEqual(
              Option.getOrThrow(yield* records.findById(grant, record.id)).status,
              "accepted",
            );
            assert.isFalse(
              yield* records.transition(orgId, record.id, { from: "pending", to: "canceled" }),
            );
            assert.strictEqual(
              Option.getOrThrow(yield* records.findById(grant, record.id)).status,
              "accepted",
            );
            const failure = yield* records
              .transition(orgId, "no-such-id", { from: "pending", to: "accepted" })
              .pipe(Effect.flip);
            assert.strictEqual(failure._tag, "InvitationRecordNotFound");
          }),
        },
      ],
      race: [
        {
          name: "8 racing transitions out of pending: exactly one wins, and its status stays",
          run: Effect.gen(function* () {
            const records = yield* InvitationRecords.InvitationRecords;
            const created = yield* invite("a@example.com");
            const targets: ReadonlyArray<"accepted" | "rejected" | "canceled" | "expired"> = [
              "accepted",
              "rejected",
              "canceled",
              "expired",
            ];
            const outcomes = yield* Effect.all(
              Array.from({ length: RecordsContract.CONCURRENCY }, (_, n) => {
                const to = targets[n % targets.length] ?? "accepted";
                return Effect.map(
                  records.transition(orgId, created.id, { from: "pending", to }),
                  (won) => ({ won, to }),
                );
              }),
              { concurrency: "unbounded" },
            );
            const winners = outcomes.filter((outcome) => outcome.won);
            assert.strictEqual(winners.length, 1);
            assert.strictEqual(
              Option.getOrThrow(yield* records.findById(grant, created.id)).status,
              winners[0]?.to,
            );
          }),
        },
      ],
    },
    purgeExpired: {
      write: [
        {
          name: "purgeExpired deletes only the invitations whose expiry is before the cutoff",
          run: Effect.gen(function* () {
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
          }),
        },
      ],
    },
    removeAllForUser: {
      write: [
        {
          name: "deletes the invitations an erased user sent and the ones addressed to their email, and no other",
          run: Effect.gen(function* () {
            const records = yield* InvitationRecords.InvitationRecords;
            yield* invite("someone@example.com");
            yield* records.create({
              email: "Erased@Example.com",
              inviterId: Users.UserId("other-inviter"),
              organizationId: orgId,
              role: ["member"],
              expiresAt: yield* future(48),
              tokenHash: nextHash(),
            });
            const kept = yield* records.create({
              email: "kept@example.com",
              inviterId: Users.UserId("other-inviter"),
              organizationId: orgId,
              role: ["member"],
              expiresAt: yield* future(48),
              tokenHash: nextHash(),
            });
            yield* records.removeAllForUser(grant, inviter, "erased@example.com");
            const left = (yield* records.listByOrganization(orgId)).map((row) => row.id);
            assert.deepStrictEqual(left, [kept.id]);
          }),
        },
      ],
    },
    removeAllForOrganization: {
      write: [
        {
          name: "removeAllForOrganization clears every invitation for that org, and no other",
          run: Effect.gen(function* () {
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
          }),
        },
      ],
    },
  },
  tenancy: { covers: ["organization_invitation"], cases: [isolationCase] },
});
