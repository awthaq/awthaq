// spec/behaviors/06-domain-users-accounts.md, BEH-EA-041, BEH-EA-042.
//
// The same contract suite runs against both `Layer`s — `layerMemory` (a
// `Ref`) and `layerSql` (a real, in-memory SQLite database via
// `@effect/sql-sqlite-node`) — since `UsersShape` is the one thing callers
// depend on and both `Layer`s are meant to satisfy it identically.
import { CoreMigrations, Repositories } from "@awthaq/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SqlError, UnknownError } from "effect/unstable/sql/SqlError";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as Hooks from "../src/Hooks.ts";
import * as Phone from "../src/Phone.ts";
import * as Tenant from "../src/Tenant.ts";
import * as TestSql from "../../sql/test/support/TestSql.ts";
import * as Users from "../src/Users.ts";

const MemoryLayer = Users.layerMemory.pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provide(Hooks.BeforeUserDelete.layer),
);

// PV-010: `:memory:` SQLite by default, a real Postgres schema under `pnpm run test:pg`.
const SqlLive = TestSql.layer("core_Users");

// FAMS-002: the real core migrations (not a hand-copied `CREATE TABLE`), so the
// suite tracks every column and index `layerSql` depends on.
const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(SqlLive));

const SqlTestLayer = Users.layerSql.pipe(
  Layer.provide(Repositories.UsersRepositoryLive),
  Layer.provide(Hooks.BeforeUserDelete.layer),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const suite = (name: string, layer: Layer.Layer<Users.Users, unknown, never>): void => {
  describe(name, () => {
    // EOTS-004: identifiers and emails are typed fields, never part of a message that reaches logs.
    it.effect("EOTS-004: error messages never contain the id or the email", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        yield* users.create({
          identity: { _tag: "Email", email: "pii-holder@example.com" },
          name: "P",
        });
        const duplicate = yield* users
          .create({ identity: { _tag: "Email", email: "pii-holder@example.com" }, name: "P2" })
          .pipe(Effect.flip);
        if (duplicate._tag !== "Users/EmailAlreadyExists") return assert.fail(duplicate._tag);
        assert.strictEqual(duplicate.email, "pii-holder@example.com");
        assert.notInclude(duplicate.message, "pii-holder");
        const missingId = Users.UserId("99999999-9999-9999-9999-999999999999");
        const missing = yield* users.updateProfile(missingId, { name: "x" }).pipe(Effect.flip);
        if (missing._tag !== "UserNotFound") return assert.fail(missing._tag);
        assert.strictEqual(missing.id, missingId);
        assert.notInclude(missing.message, "99999999");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-041: email is lower-cased and case-insensitively unique", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const created = yield* users.create({
          identity: { _tag: "Email", email: "Ada@Example.com" },
          name: "Ada",
        });
        assert.strictEqual(Option.getOrUndefined(Users.emailOf(created)), "ada@example.com");
        assert.strictEqual(Users.isEmailVerified(created), false);

        const duplicate = yield* users
          .create({ identity: { _tag: "Email", email: "ADA@EXAMPLE.COM" }, name: "Ada 2" })
          .pipe(Effect.flip);
        assert.strictEqual(duplicate._tag, "Users/EmailAlreadyExists");

        const found = yield* users.findByEmail("ada@example.com");
        assert.isTrue(Option.isSome(found));
      }).pipe(Effect.provide(layer)),
    );

    // ESR-003: JS `toLowerCase()` is the only fold. SQLite's own `lower()`
    // folds ASCII only, so a SQL-side fold of the *parameter* would miss.
    it.effect("ESR-003: findByEmail finds a non-ASCII email under any casing", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        yield* users.create({
          identity: { _tag: "Email", email: "Müller@Example.com" },
          name: "Müller",
        });
        const found = yield* users.findByEmail("MÜLLER@EXAMPLE.COM");
        assert.isTrue(Option.isSome(found));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-042: emailVerified only ever transitions false -> true, and stays true", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const created = yield* users.create({
          identity: { _tag: "Email", email: "bo@example.com" },
          name: "Bo",
        });
        const verified = yield* users.verifyEmail(created.id);
        assert.strictEqual(Users.isEmailVerified(verified), true);
        const verifiedAgain = yield* users.verifyEmail(created.id);
        assert.strictEqual(Users.isEmailVerified(verifiedAgain), true);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("updateProfile only ever touches name, never emailVerified", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const created = yield* users.create({
          identity: { _tag: "Email", email: "cy@example.com" },
          name: "Cy",
        });
        const updated = yield* users.updateProfile(created.id, { name: "Cy Renamed" });
        assert.strictEqual(updated.name, "Cy Renamed");
        assert.strictEqual(Users.isEmailVerified(updated), false);
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "findById/updateProfile/verifyEmail/delete all fail with UserNotFound for an unknown id",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const missing = Users.UserId("00000000-0000-0000-0000-000000000000");
          const notFound = yield* users.findById(missing).pipe(Effect.flip);
          assert.strictEqual(notFound._tag, "UserNotFound");
          const updateNotFound = yield* users
            .updateProfile(missing, { name: "nobody" })
            .pipe(Effect.flip);
          assert.strictEqual(updateNotFound._tag, "UserNotFound");
          const verifyNotFound = yield* users.verifyEmail(missing).pipe(Effect.flip);
          assert.strictEqual(verifyNotFound._tag, "UserNotFound");
          const deleteNotFound = yield* users.delete(missing).pipe(Effect.flip);
          assert.strictEqual(deleteNotFound._tag, "UserNotFound");
        }).pipe(Effect.provide(layer)),
    );

    it.effect("findByEmail returns None for an unknown email", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const found = yield* users.findByEmail("nobody@example.com");
        assert.isTrue(Option.isNone(found));
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "AOMS-002: metadata defaults to None, is stored opaquely on create, and updateProfile can set/leave/clear it independently of name",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;

          const noMetadata = yield* users.create({
            identity: { _tag: "Email", email: "dee@example.com" },
            name: "Dee",
          });
          assert.isTrue(Option.isNone(noMetadata.metadata));

          const withMetadata = yield* users.create({
            identity: { _tag: "Email", email: "eve@example.com" },
            name: "Eve",
            metadata: '{"tier":"gold"}',
          });
          assert.deepStrictEqual(withMetadata.metadata, Option.some('{"tier":"gold"}'));

          // Omitting `metadata` on updateProfile leaves it untouched.
          const renamedOnly = yield* users.updateProfile(withMetadata.id, { name: "Eve Renamed" });
          assert.strictEqual(renamedOnly.name, "Eve Renamed");
          assert.deepStrictEqual(renamedOnly.metadata, Option.some('{"tier":"gold"}'));

          // An explicit value overwrites it.
          const overwritten = yield* users.updateProfile(withMetadata.id, {
            name: "Eve Renamed",
            metadata: '{"tier":"platinum"}',
          });
          assert.deepStrictEqual(overwritten.metadata, Option.some('{"tier":"platinum"}'));

          // `null` explicitly clears it.
          const cleared = yield* users.updateProfile(withMetadata.id, {
            name: "Eve Renamed",
            metadata: null,
          });
          assert.isTrue(Option.isNone(cleared.metadata));
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "BAM-005/BEH-EA-036: list pages users with a keyset cursor — every user once, oldest first, bounded reads",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const created: Array<string> = [];
          for (const n of [1, 2, 3, 4, 5]) {
            created.push(
              (yield* users.create({
                identity: { _tag: "Email", email: `p${n}@example.com` },
                name: `P${n}`,
              })).id,
            );
          }

          const seen: Array<string> = [];
          let cursor: Users.UserCursor | undefined = undefined;
          let pages = 0;
          for (;;) {
            const page: Users.UsersPage = yield* users.list({
              limit: 2,
              ...(cursor === undefined ? {} : { cursor }),
            });
            pages++;
            assert.isAtMost(page.items.length, 2);
            seen.push(...page.items.map((user) => user.id));
            if (Option.isNone(page.nextCursor)) break;
            cursor = page.nextCursor.value;
          }
          assert.strictEqual(pages, 3);
          assert.deepStrictEqual([...seen].sort(), [...created].sort());
          assert.strictEqual(new Set(seen).size, 5);

          // An exactly-full page reports no next cursor.
          const exact = yield* users.list({ limit: 5 });
          assert.strictEqual(exact.items.length, 5);
          assert.isTrue(Option.isNone(exact.nextCursor));
        }).pipe(Effect.provide(layer)),
    );

    // ---- FAMS-002/SAM-003: the identity union -------------------------------------

    it.effect("FAMS-002: an Anonymous user persists with no email or phone; many coexist", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const a = yield* users.create({ identity: { _tag: "Anonymous" }, name: "Guest A" });
        const b = yield* users.create({ identity: { _tag: "Anonymous" }, name: "Guest B" });
        assert.deepStrictEqual(a.identity, { _tag: "Anonymous" });
        assert.notStrictEqual(a.id, b.id);
        assert.isTrue(Option.isNone(Users.emailOf(a)));
        assert.strictEqual(Users.isEmailVerified(a), false);
        assert.deepStrictEqual((yield* users.findById(a.id)).identity, { _tag: "Anonymous" });
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "FAMS-002: a Phone user round-trips; a second create with the same phone fails PhoneAlreadyExists",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const phone = Option.getOrThrow(Phone.normalizePhone("+1 555 0100"));
          const created = yield* users.create({ identity: { _tag: "Phone", phone }, name: "Pat" });
          assert.deepStrictEqual(created.identity, { _tag: "Phone", phone, phoneVerified: false });

          const duplicate = yield* users
            .create({ identity: { _tag: "Phone", phone }, name: "Pat 2" })
            .pipe(Effect.flip);
          assert.strictEqual(duplicate._tag, "Users/PhoneAlreadyExists");

          const found = yield* users.findByPhone(phone);
          assert.strictEqual(Option.getOrThrow(found).id, created.id);
          const none = yield* users.findByPhone(
            Option.getOrThrow(Phone.normalizePhone("+15550199")),
          );
          assert.isTrue(Option.isNone(none));
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "FAMS-002: phoneVerified is monotone like emailVerified; verifying the wrong kind is IdentityMismatch",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const phone = Option.getOrThrow(Phone.normalizePhone("+447700900123"));
          const created = yield* users.create({ identity: { _tag: "Phone", phone }, name: "Uma" });
          const verified = yield* users.verifyPhone(created.id);
          assert.isTrue(Users.isPhoneVerified(verified));
          assert.isTrue(Users.isPhoneVerified(yield* users.verifyPhone(created.id)));
          const wrong = yield* users.verifyEmail(created.id).pipe(Effect.flip);
          assert.strictEqual(wrong._tag, "IdentityMismatch");
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "FAMS-002: promoteIdentity upgrades Anonymous -> Email in place (same UserId) and enforces uniqueness",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const taken = yield* users.create({
            identity: { _tag: "Email", email: "taken@example.com" },
            name: "T",
          });
          const guest = yield* users.create({ identity: { _tag: "Anonymous" }, name: "Guest" });

          const conflict = yield* users
            .promoteIdentity(guest.id, { _tag: "Email", email: "TAKEN@example.com" })
            .pipe(Effect.flip);
          assert.strictEqual(conflict._tag, "Users/EmailAlreadyExists");
          // A failed promotion leaves the guest anonymous.
          assert.deepStrictEqual((yield* users.findById(guest.id)).identity, { _tag: "Anonymous" });

          const promoted = yield* users.promoteIdentity(guest.id, {
            _tag: "Email",
            email: "Fresh@Example.com",
          });
          assert.strictEqual(promoted.id, guest.id);
          assert.deepStrictEqual(promoted.identity, {
            _tag: "Email",
            email: "fresh@example.com",
            emailVerified: false,
          });
          assert.strictEqual(
            Option.getOrThrow(yield* users.findByEmail("fresh@example.com")).id,
            guest.id,
          );

          // A user that already has an identity cannot be promoted again.
          const again = yield* users
            .promoteIdentity(guest.id, { _tag: "Email", email: "other@example.com" })
            .pipe(Effect.flip);
          assert.strictEqual(again._tag, "IdentityMismatch");
          const alreadyEmail = yield* users
            .promoteIdentity(taken.id, {
              _tag: "Phone",
              phone: Option.getOrThrow(Phone.normalizePhone("+15550111")),
            })
            .pipe(Effect.flip);
          assert.strictEqual(alreadyEmail._tag, "IdentityMismatch");
        }).pipe(Effect.provide(layer)),
    );

    it.effect("FAMS-002: promoteIdentity Anonymous -> Phone enforces phone uniqueness", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const phone = Option.getOrThrow(Phone.normalizePhone("+15550122"));
        yield* users.create({ identity: { _tag: "Phone", phone }, name: "Owner" });
        const guest = yield* users.create({ identity: { _tag: "Anonymous" }, name: "Guest" });
        const conflict = yield* users
          .promoteIdentity(guest.id, { _tag: "Phone", phone })
          .pipe(Effect.flip);
        assert.strictEqual(conflict._tag, "Users/PhoneAlreadyExists");
      }).pipe(Effect.provide(layer)),
    );

    // ---- SCP-001/BAM-005: suspension --------------------------------------------

    it.effect(
      "SCP-001: setStatus(suspended) persists, is not reachable via updateProfile, and reactivation restores sign-in",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const created = yield* users.create({
            identity: { _tag: "Email", email: "sus@example.com" },
            name: "Sus",
          });
          assert.strictEqual(created.status, "active");
          yield* Users.assertCanSignIn(created);

          const suspended = yield* users.setStatus(created.id, "suspended", {
            reason: "chargeback",
          });
          assert.strictEqual(suspended.status, "suspended");
          assert.deepStrictEqual(suspended.statusReason, Option.some("chargeback"));
          const refused = yield* Users.assertCanSignIn(suspended).pipe(Effect.flip);
          assert.strictEqual(refused._tag, "UserSuspended");

          // The generic write path neither reads nor clears the suspension.
          const renamed = yield* users.updateProfile(created.id, { name: "Sus Renamed" });
          assert.strictEqual(renamed.status, "suspended");
          assert.strictEqual((yield* users.findById(created.id)).status, "suspended");
          // Suspension is not deletion: the user, its identity and email uniqueness remain.
          assert.isTrue(Option.isSome(yield* users.findByEmail("sus@example.com")));

          const reactivated = yield* users.setStatus(created.id, "active");
          assert.strictEqual(reactivated.status, "active");
          assert.isTrue(Option.isNone(reactivated.statusReason));
          assert.isTrue(Option.isNone(reactivated.suspendedUntil));
          yield* Users.assertCanSignIn(reactivated);

          const missing = yield* users
            .setStatus(Users.UserId("00000000-0000-0000-0000-000000000000"), "suspended")
            .pipe(Effect.flip);
          assert.strictEqual(missing._tag, "UserNotFound");
        }).pipe(Effect.provide(layer)),
    );

    it.effect("BAM-005: a timed suspension lapses by itself at `until`, without any write", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const created = yield* users.create({
          identity: { _tag: "Email", email: "timed@example.com" },
          name: "Timed",
        });
        const at = yield* DateTime.now;
        const later = DateTime.add(at, { hours: 1 });
        const suspended = yield* users.setStatus(created.id, "suspended", { until: later });
        assert.deepStrictEqual(suspended.suspendedUntil, Option.some(later));
        assert.isTrue(Users.isSuspendedAt(suspended, at));
        assert.isFalse(Users.isSuspendedAt(suspended, DateTime.add(later, { seconds: 1 })));

        const lapsed = yield* users.setStatus(created.id, "suspended", {
          until: DateTime.subtract(at, { hours: 1 }),
        });
        yield* Users.assertCanSignIn(lapsed);
      }).pipe(Effect.provide(layer)),
    );

    // ---- BAM-009/NAM-009: profile image and email change ------------------------

    it.effect(
      "BAM-009: image defaults to None, is set on create/updateProfile, left untouched when omitted, cleared by null",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const plain = yield* users.create({
            identity: { _tag: "Email", email: "img0@example.com" },
            name: "I0",
          });
          assert.isTrue(Option.isNone(plain.image));
          const withImage = yield* users.create({
            identity: { _tag: "Email", email: "img1@example.com" },
            name: "I1",
            image: "https://cdn.example.com/a.png",
          });
          assert.deepStrictEqual(withImage.image, Option.some("https://cdn.example.com/a.png"));
          const renamed = yield* users.updateProfile(withImage.id, { name: "I1b" });
          assert.deepStrictEqual(renamed.image, Option.some("https://cdn.example.com/a.png"));
          const replaced = yield* users.updateProfile(withImage.id, {
            name: "I1b",
            image: "https://cdn.example.com/b.png",
          });
          assert.deepStrictEqual(replaced.image, Option.some("https://cdn.example.com/b.png"));
          const cleared = yield* users.updateProfile(withImage.id, { name: "I1b", image: null });
          assert.isTrue(Option.isNone(cleared.image));
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "BAM-009: changeEmail resets emailVerified, moves the uniqueness key, and enforces uniqueness",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const ann = yield* users.create({
            identity: { _tag: "Email", email: "ann@example.com" },
            name: "Ann",
          });
          yield* users.create({
            identity: { _tag: "Email", email: "ben@example.com" },
            name: "Ben",
          });
          yield* users.verifyEmail(ann.id);

          const conflict = yield* users.changeEmail(ann.id, "BEN@example.com").pipe(Effect.flip);
          assert.strictEqual(conflict._tag, "Users/EmailAlreadyExists");
          assert.isTrue(Users.isEmailVerified(yield* users.findById(ann.id)));

          const changed = yield* users.changeEmail(ann.id, "Ann.New@Example.com");
          assert.deepStrictEqual(changed.identity, {
            _tag: "Email",
            email: "ann.new@example.com",
            emailVerified: false,
          });
          assert.isTrue(Option.isNone(yield* users.findByEmail("ann@example.com")));
          assert.strictEqual(
            Option.getOrThrow(yield* users.findByEmail("ann.new@example.com")).id,
            ann.id,
          );
          // The freed address can be registered again.
          yield* users.create({
            identity: { _tag: "Email", email: "ann@example.com" },
            name: "Ann 2",
          });

          // Same address: a no-op that keeps the verification the user already earned.
          yield* users.verifyEmail(ann.id);
          const same = yield* users.changeEmail(ann.id, "ANN.NEW@example.com");
          assert.isTrue(Users.isEmailVerified(same));

          const guest = yield* users.create({ identity: { _tag: "Anonymous" }, name: "G" });
          const mismatch = yield* users.changeEmail(guest.id, "g@example.com").pipe(Effect.flip);
          assert.strictEqual(mismatch._tag, "IdentityMismatch");
        }).pipe(Effect.provide(layer)),
    );

    // ---- SCP-003: create-or-get ---------------------------------------------------

    it.effect(
      "SCP-003: createOrGet returns the existing user (created=false) instead of failing",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const first = yield* users.createOrGet({
            identity: { _tag: "Email", email: "cog@example.com" },
            name: "Cog",
          });
          assert.isTrue(first.created);
          const second = yield* users.createOrGet({
            identity: { _tag: "Email", email: "COG@example.com" },
            name: "Other Name",
          });
          assert.isFalse(second.created);
          assert.strictEqual(second.user.id, first.user.id);
          assert.strictEqual(second.user.name, "Cog");

          const phone = Option.getOrThrow(Phone.normalizePhone("+15550133"));
          const p1 = yield* users.createOrGet({ identity: { _tag: "Phone", phone }, name: "P" });
          const p2 = yield* users.createOrGet({ identity: { _tag: "Phone", phone }, name: "P" });
          assert.deepStrictEqual([p1.created, p2.created], [true, false]);

          // Anonymous never conflicts: every call is a fresh user.
          const g1 = yield* users.createOrGet({ identity: { _tag: "Anonymous" }, name: "G" });
          const g2 = yield* users.createOrGet({ identity: { _tag: "Anonymous" }, name: "G" });
          assert.deepStrictEqual([g1.created, g2.created], [true, true]);
          assert.notStrictEqual(g1.user.id, g2.user.id);
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "SCP-003: concurrent createOrGet for one email returns one user, exactly one created=true",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const results = yield* Effect.all(
            Array.from({ length: 8 }, () =>
              users.createOrGet({
                identity: { _tag: "Email", email: "race@example.com" },
                name: "Race",
              }),
            ),
            { concurrency: "unbounded" },
          );
          assert.strictEqual(results.filter((r) => r.created).length, 1);
          assert.strictEqual(new Set(results.map((r) => r.user.id)).size, 1);
        }).pipe(Effect.provide(layer)),
    );

    // DRS-001/DRS-005 (ADR-EA-018): the ambient tenant is attribution on the
    // user row; the users table stays the global identity directory.
    it.effect("DRS-001: create stamps the ambient tenant, and none leaves it None", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const tenanted = yield* users
          .create({ identity: { _tag: "Email", email: "t1@example.com" }, name: "T1" })
          .pipe(Tenant.withTenant("tenant-1"));
        assert.deepStrictEqual(tenanted.tenantId, Option.some("tenant-1"));
        const plain = yield* users.create({
          identity: { _tag: "Email", email: "plain@example.com" },
          name: "Plain",
        });
        assert.isTrue(Option.isNone(plain.tenantId));
        const reread = yield* users.findById(tenanted.id);
        assert.deepStrictEqual(reread.tenantId, Option.some("tenant-1"));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("DRS-005: another tenant's request still resolves the same identity", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        yield* users
          .create({ identity: { _tag: "Email", email: "dir@example.com" }, name: "Dir" })
          .pipe(Tenant.withTenant("tenant-a"));
        const found = yield* users.findByEmail("dir@example.com").pipe(Tenant.withTenant("tenant-b"));
        assert.isTrue(Option.isSome(found));
        const clash = yield* users
          .create({ identity: { _tag: "Email", email: "dir@example.com" }, name: "Dir 2" })
          .pipe(Tenant.withTenant("tenant-b"), Effect.flip);
        assert.strictEqual(clash._tag, "Users/EmailAlreadyExists");
      }).pipe(Effect.provide(layer)),
    );
  });
};

suite("Users (layerMemory)", MemoryLayer);
suite("Users (layerSql)", SqlTestLayer);

// GC-004: `layerSql` read the row, then updated it in a second statement; a delete landing between
// the two made `repo.update` die (`SqlModel.update` turns the missing row into a defect), where
// `layerMemory` answers `UserNotFound`. The update is one statement now, and a row that is gone
// by then comes back as `None`; a repository stub forces exactly that outcome for a row that
// still exists when `create` returns.
describe("Users (layerSql) profile update racing a delete (GC-004)", () => {
  const VanishingRepository = Layer.effect(
    Repositories.UsersRepository,
    Effect.gen(function* () {
      const real = yield* Repositories.UsersRepository;
      return { ...real, updateProfile: () => Effect.succeedNone };
    }),
  ).pipe(Layer.provide(Repositories.UsersRepositoryLive));

  const VanishingLayer = Users.layerSql.pipe(
    Layer.provide(VanishingRepository),
    Layer.provide(Hooks.BeforeUserDelete.layer),
    Layer.provideMerge(SqlLive),
    Layer.provideMerge(Migrated),
  );

  it.effect("updateProfile on a user deleted concurrently fails UserNotFound, never a defect", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const created = yield* users.create({
        identity: { _tag: "Email", email: "racer@example.com" },
        name: "Racer",
      });
      const failure = yield* users.updateProfile(created.id, { name: "Renamed" }).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "UserNotFound");
    }).pipe(Effect.provide(VanishingLayer)),
  );

  it.effect("updateProfile changes name, metadata and image in one statement, leaving identity alone", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const created = yield* users.create({
        identity: { _tag: "Email", email: "keep@example.com" },
        name: "Keep",
      });
      const renamed = yield* users.updateProfile(created.id, {
        name: "Kept",
        metadata: "{}",
        image: "https://example.com/a.png",
      });
      assert.strictEqual(renamed.name, "Kept");
      assert.strictEqual(Option.getOrUndefined(Users.emailOf(renamed)), "keep@example.com");
      assert.deepStrictEqual(renamed.metadata, Option.some("{}"));
      assert.deepStrictEqual(renamed.image, Option.some("https://example.com/a.png"));
      const untouched = yield* users.updateProfile(created.id, { name: "Kept again" });
      assert.deepStrictEqual(untouched.metadata, Option.some("{}"));
      assert.deepStrictEqual(untouched.image, Option.some("https://example.com/a.png"));
      const cleared = yield* users.updateProfile(created.id, {
        name: "Kept again",
        metadata: null,
        image: null,
      });
      assert.deepStrictEqual(cleared.metadata, Option.none());
      assert.deepStrictEqual(cleared.image, Option.none());
    }).pipe(Effect.provide(SqlTestLayer)),
  );
});

// MA-004: an infrastructure failure is the typed `StoreUnavailable`, never a defect.
describe("Users infrastructure failures (MA-004)", () => {
  const DownRepository = Layer.effect(
    Repositories.UsersRepository,
    Effect.gen(function* () {
      const real = yield* Repositories.UsersRepository;
      return {
        ...real,
        findByEmail: () =>
          Effect.fail(
            new SqlError({ reason: new UnknownError({ cause: new Error("connection reset") }) }),
          ),
      };
    }),
  ).pipe(Layer.provide(Repositories.UsersRepositoryLive));

  const DownLayer = Users.layerSql.pipe(
    Layer.provide(DownRepository),
    Layer.provide(Hooks.BeforeUserDelete.layer),
    Layer.provideMerge(SqlLive),
    Layer.provideMerge(Migrated),
  );

  it.effect("layerSql: a SqlError from the repository surfaces as StoreUnavailable", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const failure = yield* users.findByEmail("anyone@example.com").pipe(Effect.flip);
      assert.strictEqual(failure._tag, "StoreUnavailable");
      assert.strictEqual(failure.operation, "Users.findByEmail");
    }).pipe(Effect.provide(DownLayer)),
  );
});
