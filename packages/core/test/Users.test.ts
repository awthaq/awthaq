// spec/behaviors/06-domain-users-accounts.md, BEH-EA-041, BEH-EA-042.
//
// Plan 02 (ADR-EA-041): `Users` is one implementation over `UserStore`, so its domain suite runs
// once, over the `Ref` adapter. What a store must do on every backend (the atomic insert-or-holder,
// the identity compare-and-swap, the delete that takes the fields with it, the keyset page) is
// `StoreContract.users`, run on the `Ref`, SQLite, WAL-file and (`pnpm test:pg`) Postgres adapters;
// the SQL adapter's own failure mapping is `packages/sql/test/UserStoreSql.test.ts`.
import { UserStore } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { StoreUnavailable } from "../src/Errors.ts";
import * as Hooks from "../src/Hooks.ts";
import { ErasureClearance } from "../src/internal/erasureClearance.ts";
import * as Phone from "../src/Phone.ts";
import * as Tenant from "../src/Tenant.ts";
import * as Users from "../src/Users.ts";

const MemoryLayer = Users.layer.pipe(
  Layer.provide(UserStore.layerMemory),
  Layer.provide(NodeCrypto.layer),
);

/** The clearance `AccountErasure` would mint once the veto passed; core tests may mint one directly. */
const clearanceFor = (id: Users.UserId) => ErasureClearance.afterVeto(id, Effect.void);

const suite = (
  name: string,
  layer: Layer.Layer<Users.Users | Users.UserRemoval, unknown, never>,
): void => {
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
      "findById/updateProfile/verifyEmail all fail with UserNotFound for an unknown id",
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
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "UserRemoval.remove with a clearance drops the row and its fields; an unknown id is UserNotFound",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const removal = yield* Users.UserRemoval;
          const created = yield* users.create({
            identity: { _tag: "Email", email: "removed@example.com" },
            name: "Removed",
          });
          yield* removal.remove(yield* clearanceFor(created.id));
          assert.strictEqual(
            (yield* users.findById(created.id).pipe(Effect.flip))._tag,
            "UserNotFound",
          );
          assert.isTrue(Option.isNone(yield* users.findByEmail("removed@example.com")));
          // The address is free again.
          yield* users.create({
            identity: { _tag: "Email", email: "removed@example.com" },
            name: "Again",
          });
          const missing = Users.UserId("00000000-0000-0000-0000-000000000000");
          const failure = yield* removal.remove(yield* clearanceFor(missing)).pipe(Effect.flip);
          assert.strictEqual(failure._tag, "UserNotFound");
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "createWith abandons the user when completion fails, dies or is interrupted, and keeps it when it succeeds",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const input = (email: string) => ({
            identity: { _tag: "Email" as const, email },
            name: "Provisioned",
          });
          const abandoned = (email: string) =>
            users.findByEmail(email).pipe(Effect.map(Option.isNone));

          const failed = yield* users
            .createWith(input("fail@example.com"), () => Effect.fail("boom" as const))
            .pipe(Effect.flip);
          assert.strictEqual(failed, "boom");
          assert.isTrue(yield* abandoned("fail@example.com"));

          const died = yield* users
            .createWith(input("die@example.com"), () => Effect.die("boom"))
            .pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(died));
          assert.isTrue(yield* abandoned("die@example.com"));

          const interrupted = yield* users
            .createWith(input("interrupt@example.com"), () => Effect.interrupt)
            .pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(interrupted));
          assert.isTrue(yield* abandoned("interrupt@example.com"));

          // The abandoned address is free again, and success keeps the user.
          const kept = yield* users.createWith(input("fail@example.com"), (user) =>
            Effect.succeed(user.name),
          );
          assert.strictEqual(kept.value, "Provisioned");
          assert.strictEqual((yield* users.findById(kept.user.id)).id, kept.user.id);
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
        const found = yield* users
          .findByEmail("dir@example.com")
          .pipe(Tenant.withTenant("tenant-b"));
        assert.isTrue(Option.isSome(found));
        const clash = yield* users
          .create({ identity: { _tag: "Email", email: "dir@example.com" }, name: "Dir 2" })
          .pipe(Tenant.withTenant("tenant-b"), Effect.flip);
        assert.strictEqual(clash._tag, "Users/EmailAlreadyExists");
      }).pipe(Effect.provide(layer)),
    );
  });
};

suite("Users", MemoryLayer);

// GC-004: the update is one statement, so a row deleted between the caller's read and the write is
// `UserNotFound`, never a defect. A store double that answers "no such row" forces exactly that outcome for
// a user that still exists when `create` returns.
describe("Users profile update racing a delete (GC-004)", () => {
  const VanishingStore = Layer.effect(
    UserStore.UserStore,
    Effect.gen(function* () {
      const real = yield* UserStore.UserStore;
      return { ...real, updateProfile: () => Effect.succeedNone };
    }),
  ).pipe(Layer.provide(UserStore.layerMemory));

  const VanishingLayer = Users.layer.pipe(
    Layer.provide(VanishingStore),
    Layer.provide(NodeCrypto.layer),
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

  it.effect(
    "updateProfile changes name, metadata and image in one statement, leaving identity alone",
    () =>
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
      }).pipe(Effect.provide(MemoryLayer)),
  );
});

// AAPS-005: `updateProfile`/`verifyEmail`/`changeEmail` fire `Hooks.AfterUserAttributesChanged`, but only
// when a policy-readable attribute really changed, so `@awthaq/qadi`'s `DecisionCacheInvalidationLive` can
// flush an application-scoped decision cache exactly when `UserAttributes` could answer differently. The
// unverified-to-verified transition is one compare-and-swap, so of two concurrent calls exactly one announces.
describe("Users attribute-change hook (AAPS-005)", () => {
  const seen: Array<{ readonly userId: string; readonly attributes: ReadonlyArray<string> }> = [];

  const HookedLayer = Users.layer.pipe(
    Layer.provide(UserStore.layerMemory),
    Layer.provide(
      Hooks.AfterUserAttributesChanged.tap((input) =>
        Effect.sync(() => {
          seen.push(input);
        }),
      ).pipe(Layer.provideMerge(Hooks.HooksLive)),
    ),
    Layer.provide(NodeCrypto.layer),
  );

  it.effect("updateProfile announces name; verifyEmail announces emailVerified once", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const user = yield* users.create({
        identity: { _tag: "Email", email: "hook@example.com" },
        name: "Hook",
      });
      assert.deepStrictEqual(seen, []);

      yield* users.updateProfile(user.id, { name: "Renamed" });
      assert.deepStrictEqual(seen, [{ userId: user.id, attributes: ["name"] }]);

      yield* users.verifyEmail(user.id);
      assert.strictEqual(seen.length, 2);
      assert.deepStrictEqual(seen[1], { userId: user.id, attributes: ["emailVerified"] });

      // Already verified: nothing changed, nothing announced.
      yield* users.verifyEmail(user.id);
      assert.strictEqual(seen.length, 2);
    }).pipe(Effect.provide(HookedLayer)),
  );

  it.effect("two concurrent verifyEmail calls announce emailVerified exactly once", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const user = yield* users.create({
        identity: { _tag: "Email", email: "race@example.com" },
        name: "Race",
      });
      yield* Effect.all([users.verifyEmail(user.id), users.verifyEmail(user.id)], {
        concurrency: 2,
      });
      assert.strictEqual(
        seen.filter(
          (entry) => entry.userId === user.id && entry.attributes.includes("emailVerified"),
        ).length,
        1,
      );
    }).pipe(Effect.provide(HookedLayer)),
  );

  // AAPS-005 / U-3: lowering `emailVerified` by an address change is announced from what the change
  // really did, not from a stale pre-read.
  it.effect("changeEmail announces emailVerified only when it lowered a verified address", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const user = yield* users.create({
        identity: { _tag: "Email", email: "moves@example.com" },
        name: "Moves",
      });
      const before = seen.length;
      yield* users.changeEmail(user.id, "moved@example.com");
      assert.strictEqual(seen.length, before);
      yield* users.verifyEmail(user.id);
      yield* users.changeEmail(user.id, "moved-again@example.com");
      assert.deepStrictEqual(seen.at(-1), { userId: user.id, attributes: ["emailVerified"] });
    }).pipe(Effect.provide(HookedLayer)),
  );
});

// U-4: every pure check runs before any I/O, so the answer to an unknown field does not depend on
// whether the user exists (both memory and SQL used to answer in opposite orders).
describe("Users declared-field error precedence (U-4)", () => {
  it.effect("an unknown field is UnknownUserField even for a user that does not exist", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const absent = Users.UserId("55555555-5555-5555-5555-555555555555");
      const read = yield* users.getFields(absent, ["nobody_declared"]).pipe(Effect.flip);
      assert.strictEqual(read._tag, "UnknownUserField");
      const write = yield* users.setFields(absent, { nobody_declared: "x" }).pipe(Effect.flip);
      assert.strictEqual(write._tag, "UnknownUserField");
      const missing = yield* users.getFields(absent).pipe(Effect.flip);
      assert.strictEqual(missing._tag, "UserNotFound");
    }).pipe(Effect.provide(MemoryLayer)),
  );
});

// BEH-EA-036/U-10: a page is at least one row and at most MAX; a nonsense limit is clamped, never a defect.
describe("Users.list limit", () => {
  it.effect("a non-positive or oversize limit is clamped, not an error", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      for (let i = 0; i < 3; i++) {
        yield* users.create({
          identity: { _tag: "Email", email: `page-${i}@example.com` },
          name: `P${i}`,
        });
      }
      assert.strictEqual((yield* users.list({ limit: 0 })).items.length, 1);
      assert.strictEqual((yield* users.list({ limit: -5 })).items.length, 1);
      assert.strictEqual((yield* users.list({ limit: 1.9 })).items.length, 1);
      assert.strictEqual((yield* users.list({ limit: 1_000_000 })).items.length, 3);
    }).pipe(Effect.provide(MemoryLayer)),
  );
});

// MA-004: an infrastructure failure is the typed `StoreUnavailable`, never a defect. The store double names
// its own primitive, as an adapter does; the service relabels it to the operation the caller ran.
describe("Users infrastructure failures (MA-004)", () => {
  const down = (primitive: string) => Effect.fail(new StoreUnavailable({ operation: primitive }));
  const DownStore = Layer.mock(UserStore.UserStore, {
    insertOrHolder: () => down("UserStore.insertOrHolder"),
    get: () => down("UserStore.get"),
    getByEmail: () => down("UserStore.getByEmail"),
    getByPhone: () => down("UserStore.getByPhone"),
    updateProfile: () => down("UserStore.updateProfile"),
    casIdentity: () => down("UserStore.casIdentity"),
    setStatus: () => down("UserStore.setStatus"),
    delete: () => down("UserStore.delete"),
    listPage: () => down("UserStore.listPage"),
    readFields: () => down("UserStore.readFields"),
    writeFields: () => down("UserStore.writeFields"),
  });
  const DownLayer = Users.layer.pipe(Layer.provide(DownStore), Layer.provide(NodeCrypto.layer));

  it.effect("a store outage surfaces as StoreUnavailable named for the service operation", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const id = Users.UserId("66666666-6666-6666-6666-666666666666");
      const operationOf = <A>(effect: Effect.Effect<A, { readonly _tag: string }>) =>
        effect.pipe(
          Effect.flip,
          Effect.map((failure) =>
            failure._tag === "StoreUnavailable" && "operation" in failure
              ? failure.operation
              : failure._tag,
          ),
        );
      const email = { _tag: "Email", email: "x@example.com" } as const;
      assert.strictEqual(
        yield* operationOf(users.create({ identity: email, name: "X" })),
        "Users.create",
      );
      assert.strictEqual(yield* operationOf(users.findByEmail("a@b.c")), "Users.findByEmail");
      assert.strictEqual(yield* operationOf(users.findById(id)), "Users.findById");
      assert.strictEqual(yield* operationOf(users.verifyEmail(id)), "Users.verifyEmail");
      assert.strictEqual(
        yield* operationOf(users.updateProfile(id, { name: "n" })),
        "Users.updateProfile",
      );
      assert.strictEqual(yield* operationOf(users.setStatus(id, "active")), "Users.setStatus");
      assert.strictEqual(yield* operationOf(users.list()), "Users.list");
    }).pipe(Effect.provide(DownLayer)),
  );
});
