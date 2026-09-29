// BAM-005 (wayfinder ticket 19 §1): the admin plugin's user and session administration —
// every capability behind its own fail-closed predicate, the gate sees the target, and
// the impersonation subsystem's sessions stay under its own controls.
//
// Domain-level like `Admin.test.ts`: real in-memory `Users`/`Sessions`/`AuthEvents`.
import { Api } from "@awthaq/api";
import { AuditChain, AuditLog, AuthEvents, Hooks, Sessions, Users } from "@awthaq/core";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Duration from "effect/Duration";
import * as Admin from "../src/Admin.ts";
import * as ImpersonationRecords from "../src/ImpersonationRecords.ts";

const CoreLive = Layer.mergeAll(Sessions.layerMemory, Users.layerMemory).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);
const AdminAuthenticationLive = Authentication.AdminAuthenticationLive.pipe(
  Layer.provide(AuthenticationLive),
);
const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("admin-users-test-csrf-secret-padded-to-thirty-two-bytes"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const buildLayer = (config: Partial<Admin.AdminConfigShape>) =>
  Admin.Admin.layer.pipe(
    Layer.provide(Admin.config(config)),
    Layer.provide(AdminAuthenticationLive),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(
      ImpersonationRecords.layerMemory.pipe(
        Layer.provide(NodeCrypto.layer),
        Layer.provide(AuditChain.layer.pipe(Layer.provide(NodeCrypto.layer))),
      ),
    ),
  );

const manageAll = { canManageUsers: () => Effect.succeed(true) };

// State for the "gate sees the target" test: what the predicate was asked about, and which
// accounts it protects (ids are generated, so the test registers them once created).
const seenTargets: Array<Option.Option<string>> = [];
const protectedIds = new Set<string>();

const asCaller = (id: string): Api.UserPrincipal =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id }),
    sessionId: "admin-session",
  });

const seed = Effect.gen(function* () {
  const users = yield* Users.Users;
  const admin = yield* users.create({
    identity: { _tag: "Email", email: "admin@example.com" },
    name: "Admin",
  });
  const target = yield* users.create({
    identity: { _tag: "Email", email: "target@example.com" },
    name: "Target",
  });
  return { adminId: admin.id, targetId: target.id, users };
});

/** Collects every event published from now on. */
const collectEvents = Effect.gen(function* () {
  const events = yield* AuthEvents.AuthEvents;
  const seen = yield* Ref.make<ReadonlyArray<AuthEvents.AuthEvent>>([]);
  yield* events.stream.pipe(
    Stream.runForEach((event) => Ref.update(seen, (all) => [...all, event])),
    Effect.forkScoped({ startImmediately: true }),
  );
  return seen;
});

describe("Admin user administration (BAM-005)", () => {
  it.effect("every capability is fail-closed by default and publishes actionDenied", () =>
    Effect.gen(function* () {
      const { adminId, targetId } = yield* seed;
      const admin = yield* Admin.Admin;
      const seen = yield* collectEvents;
      const caller = asCaller(adminId);
      const attempts = {
        listUsers: admin.listUsers(caller),
        getUser: admin.getUser(caller, targetId),
        updateUser: admin.updateUser(caller, targetId, { name: "New" }),
        listUserSessions: admin.listUserSessions(caller, targetId),
        revokeUserSession: admin.revokeUserSession(caller, targetId, "any"),
        revokeUserSessions: admin.revokeUserSessions(caller, targetId),
      };
      for (const [action, attempt] of Object.entries(attempts)) {
        const failure = yield* attempt.pipe(Effect.flip);
        assert.strictEqual(failure._tag, "AdminActionDenied", action);
      }
      yield* TestClock.adjust(Duration.millis(10));
      const denied = (yield* Ref.get(seen)).filter((e) => e._tag === "auth.admin.actionDenied");
      assert.deepStrictEqual(
        denied.map((e) => (e._tag === "auth.admin.actionDenied" ? e.action : "")),
        Object.keys(attempts),
      );
    }).pipe(Effect.scoped, Effect.provide(buildLayer({}))),
  );

  it.effect("the gate sees the target, so a host can protect an account; list sees none", () =>
    Effect.gen(function* () {
      const { adminId, targetId, users } = yield* seed;
      const boss = yield* users.create({
        identity: { _tag: "Email", email: "boss@example.com" },
        name: "Boss",
      });
      protectedIds.add(boss.id);
      const admin = yield* Admin.Admin;
      const caller = asCaller(adminId);

      const failure = yield* admin.getUser(caller, boss.id).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "AdminActionDenied");
      const found = yield* admin.getUser(caller, targetId);
      assert.strictEqual(found.id, targetId);
      // Collection-level calls carry no target.
      yield* admin.listUsers(caller);
      assert.deepStrictEqual(seenTargets.at(-1), Option.none());
    }).pipe(
      Effect.provide(
        buildLayer({
          canManageUsers: ({ target }) => {
            seenTargets.push(Option.map(target, (t) => t.id));
            return Effect.succeed(
              Option.match(target, {
                onNone: () => true,
                onSome: (t) => !protectedIds.has(t.id),
              }),
            );
          },
        }),
      ),
    ),
  );

  it.effect(
    "listUsers pages with a keyset cursor and getUser resolves 404 only past the gate",
    () =>
      Effect.gen(function* () {
        const { adminId, users } = yield* seed;
        for (const n of [1, 2, 3])
          yield* users.create({
            identity: { _tag: "Email", email: `u${n}@example.com` },
            name: `U${n}`,
          });
        const admin = yield* Admin.Admin;
        const caller = asCaller(adminId);

        const first = yield* admin.listUsers(caller, { limit: 3 });
        assert.strictEqual(first.items.length, 3);
        assert.isTrue(Option.isSome(first.nextCursor));
        const second = yield* admin.listUsers(caller, {
          limit: 3,
          ...(Option.isSome(first.nextCursor) ? { cursor: first.nextCursor.value } : {}),
        });
        assert.strictEqual(second.items.length, 2); // 5 users in all
        assert.isTrue(Option.isNone(second.nextCursor));

        const missing = yield* admin.getUser(caller, Users.UserId("ghost")).pipe(Effect.flip);
        assert.strictEqual(missing._tag, "AdminTargetNotFound");
      }).pipe(Effect.provide(buildLayer(manageAll))),
  );

  it.effect(
    "updateUser changes name/metadata, publishes userUpdated, and 404s an unknown user",
    () =>
      Effect.gen(function* () {
        const { adminId, targetId } = yield* seed;
        const admin = yield* Admin.Admin;
        const seen = yield* collectEvents;
        const caller = asCaller(adminId);

        const updated = yield* admin.updateUser(caller, targetId, {
          name: "Renamed",
          metadata: '{"plan":"pro"}',
        });
        assert.strictEqual(updated.name, "Renamed");
        assert.deepStrictEqual(updated.metadata, Option.some('{"plan":"pro"}'));
        // metadata left out leaves it untouched
        const renamed = yield* admin.updateUser(caller, targetId, { name: "Again" });
        assert.deepStrictEqual(renamed.metadata, Option.some('{"plan":"pro"}'));

        const failure = yield* admin
          .updateUser(caller, Users.UserId("ghost"), { name: "x" })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "AdminTargetNotFound");

        yield* TestClock.adjust(Duration.millis(10));
        const events = (yield* Ref.get(seen)).filter((e) => e._tag === "auth.admin.userUpdated");
        assert.strictEqual(events.length, 2);
      }).pipe(Effect.scoped, Effect.provide(buildLayer(manageAll))),
  );

  it.effect(
    "session administration lists, revokes one, and revokes all — impersonation sessions stay out",
    () =>
      Effect.gen(function* () {
        const { adminId, targetId, users } = yield* seed;
        const other = yield* users.create({
          identity: { _tag: "Email", email: "other@example.com" },
          name: "Other",
        });
        const admin = yield* Admin.Admin;
        const sessions = yield* Sessions.Sessions;
        const seen = yield* collectEvents;
        const caller = asCaller(adminId);

        const first = yield* sessions.issue({ userId: targetId });
        const second = yield* sessions.issue({ userId: targetId });
        const foreign = yield* sessions.issue({ userId: other.id });
        // An impersonation session of the target (a support episode in progress).
        const episode = yield* admin.impersonate({
          caller,
          targetUserId: targetId,
          reason: "support",
        });

        const listed = yield* admin.listUserSessions(caller, targetId);
        assert.deepStrictEqual(
          listed.map((s) => s.id).sort(),
          [first.session.id, second.session.id].sort(),
        );

        // Not a session of that user, and not a session this route may touch.
        const wrongUser = yield* admin
          .revokeUserSession(caller, targetId, foreign.session.id)
          .pipe(Effect.flip);
        assert.strictEqual(wrongUser._tag, "AdminSessionNotFound");
        const impersonation = yield* admin
          .revokeUserSession(caller, targetId, episode.session.id)
          .pipe(Effect.flip);
        assert.strictEqual(impersonation._tag, "AdminSessionNotFound");
        assert.strictEqual((yield* sessions.verify(episode.token)).session.id, episode.session.id);

        yield* admin.revokeUserSession(caller, targetId, first.session.id);
        assert.strictEqual(
          (yield* sessions.verify(first.token).pipe(Effect.flip))._tag,
          "Sessions/NotFound",
        );
        assert.strictEqual((yield* sessions.verify(second.token)).session.id, second.session.id);

        yield* admin.revokeUserSessions(caller, targetId);
        assert.strictEqual(
          (yield* sessions.verify(second.token).pipe(Effect.flip))._tag,
          "Sessions/NotFound",
        );
        // Other users' sessions and the support episode are untouched.
        assert.strictEqual((yield* sessions.verify(foreign.token)).session.id, foreign.session.id);
        assert.strictEqual((yield* sessions.verify(episode.token)).session.id, episode.session.id);

        yield* TestClock.adjust(Duration.millis(10));
        const revoked = (yield* Ref.get(seen)).filter(
          (e) => e._tag === "auth.admin.sessionRevoked",
        );
        assert.deepStrictEqual(
          revoked.map((e) => (e._tag === "auth.admin.sessionRevoked" ? e.sessionId : "?")),
          [first.session.id, null],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(buildLayer({ ...manageAll, canImpersonate: () => Effect.succeed(true) })),
      ),
  );
});

describe("Admin ban / unban (BAM-005 remainder, SCP-001)", () => {
  it.effect(
    "banUser and unbanUser are fail-closed by default — even for an administrator of users",
    () =>
      Effect.gen(function* () {
        const { adminId, targetId } = yield* seed;
        const admin = yield* Admin.Admin;
        const seen = yield* collectEvents;
        const caller = asCaller(adminId);
        const ban = yield* admin.banUser(caller, targetId, {}).pipe(Effect.flip);
        const unban = yield* admin.unbanUser(caller, targetId).pipe(Effect.flip);
        assert.strictEqual(ban._tag, "AdminActionDenied");
        assert.strictEqual(unban._tag, "AdminActionDenied");
        // Nothing changed.
        const users = yield* Users.Users;
        assert.strictEqual((yield* users.findById(targetId)).status, "active");
        yield* TestClock.adjust(Duration.millis(10));
        const denied = (yield* Ref.get(seen)).filter((e) => e._tag === "auth.admin.actionDenied");
        assert.deepStrictEqual(
          denied.map((e) => (e._tag === "auth.admin.actionDenied" ? e.action : "")),
          ["banUser", "unbanUser"],
        );
      }).pipe(Effect.scoped, Effect.provide(buildLayer(manageAll))),
  );

  it.effect(
    "a banned user cannot sign in (UserSuspended) and all their sessions are revoked; unban restores sign-in",
    () =>
      Effect.gen(function* () {
        const { adminId, targetId, users } = yield* seed;
        const admin = yield* Admin.Admin;
        const sessions = yield* Sessions.Sessions;
        const seen = yield* collectEvents;
        const caller = asCaller(adminId);
        const a = yield* sessions.issue({ userId: targetId });
        const b = yield* sessions.issue({ userId: targetId });
        const bystander = yield* sessions.issue({ userId: adminId });

        const banned = yield* admin.banUser(caller, targetId, { reason: "  spam  " });
        assert.strictEqual(banned.status, "suspended");
        assert.deepStrictEqual(banned.statusReason, Option.some("spam"));
        // Every session of the target is gone; other users' are not.
        for (const issued of [a, b]) {
          assert.strictEqual(
            (yield* sessions.verify(issued.token).pipe(Effect.flip))._tag,
            "Sessions/NotFound",
          );
        }
        assert.strictEqual(
          (yield* sessions.verify(bystander.token)).session.id,
          bystander.session.id,
        );

        // The shared gate refuses — while an administrator still resolves the user.
        const refused = yield* Users.assertCanSignIn(yield* users.findById(targetId)).pipe(
          Effect.flip,
        );
        assert.strictEqual(refused._tag, "UserSuspended");
        assert.strictEqual((yield* admin.getUser(caller, targetId)).id, targetId);

        const unbanned = yield* admin.unbanUser(caller, targetId);
        assert.strictEqual(unbanned.status, "active");
        yield* Users.assertCanSignIn(unbanned);
        // Accounts/identity survived: ban is not deletion.
        assert.isTrue(Option.isSome(yield* users.findByEmail("target@example.com")));

        yield* TestClock.adjust(Duration.millis(10));
        const events = yield* Ref.get(seen);
        const banEvent = events.find((e) => e._tag === "auth.admin.userBanned");
        assert.deepStrictEqual(
          banEvent === undefined || banEvent._tag !== "auth.admin.userBanned"
            ? undefined
            : { userId: banEvent.userId, reason: banEvent.reason, until: banEvent.until },
          { userId: targetId, reason: "spam", until: null },
        );
        assert.isTrue(events.some((e) => e._tag === "auth.admin.userUnbanned"));
        const revocations = events.filter(
          (e) => e._tag === "auth.session.revoked" && e.reason === "suspended",
        );
        // `revokeAll` announces the sweep with the "suspended" reason.
        assert.isAtLeast(revocations.length, 1);
      }).pipe(
        Effect.scoped,
        Effect.provide(buildLayer({ ...manageAll, canBanUsers: () => Effect.succeed(true) })),
      ),
  );

  it.effect("a ban with `until` lapses by itself; an administrator cannot ban themselves", () =>
    Effect.gen(function* () {
      const { adminId, targetId, users } = yield* seed;
      const admin = yield* Admin.Admin;
      const caller = asCaller(adminId);
      const at = yield* DateTime.now;
      const banned = yield* admin.banUser(caller, targetId, {
        until: DateTime.add(at, { hours: 1 }),
      });
      assert.isTrue(Users.isSuspendedAt(banned, at));
      yield* TestClock.adjust(Duration.hours(2));
      // Still flagged `suspended` in storage, but no longer in force.
      const later = yield* users.findById(targetId);
      assert.strictEqual(later.status, "suspended");
      yield* Users.assertCanSignIn(later);

      const self = yield* admin.banUser(caller, adminId, {}).pipe(Effect.flip);
      assert.strictEqual(self._tag, "AdminSelfBanRefused");
      const unknown = yield* admin
        .banUser(caller, Users.UserId("00000000-0000-0000-0000-000000000000"), {})
        .pipe(Effect.flip);
      assert.strictEqual(unknown._tag, "AdminTargetNotFound");
    }).pipe(Effect.scoped, Effect.provide(buildLayer({ canBanUsers: () => Effect.succeed(true) }))),
  );

  it.effect("the ban gate sees the target, so a host can protect a superadmin", () =>
    Effect.gen(function* () {
      const { adminId, users } = yield* seed;
      const boss = yield* users.create({
        identity: { _tag: "Email", email: "root@example.com" },
        name: "Root",
      });
      protectedIds.add(boss.id);
      const admin = yield* Admin.Admin;
      const denied = yield* admin.banUser(asCaller(adminId), boss.id, {}).pipe(Effect.flip);
      assert.strictEqual(denied._tag, "AdminActionDenied");
      assert.strictEqual((yield* users.findById(boss.id)).status, "active");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        buildLayer({
          canBanUsers: ({ target }) =>
            Effect.succeed(
              Option.match(target, { onNone: () => false, onSome: (t) => !protectedIds.has(t.id) }),
            ),
        }),
      ),
    ),
  );
});
