// spec/behaviors/27-admin-impersonation.md, BEH-EA-209 through BEH-EA-220.
//
// Real, in-memory domain-level tests (no HTTP layer here — see
// `AuthHttp.test.ts` for the wire-level equivalent, ticket 08): real
// `Sessions`/`AuthEvents`/`ImpersonationRecords`, a plain in-test
// `canImpersonate` function (no `Layer.mock` needed — it is a bare config
// predicate, not a service).
import { Api } from "@awthaq/api";
import { AuditChain, AuditLog, AuthEvents, Hooks, Sessions, Users } from "@awthaq/core";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Admin from "../src/Admin.ts";
import * as ImpersonationRecords from "../src/ImpersonationRecords.ts";

const CoreLive = Layer.mergeAll(Sessions.layerMemory, Users.layerMemory).pipe(
  // RRS-003: `Sessions.layerMemory` now also needs `AuthEvents`.
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

/**
 * The `admin` group declares `.middleware(Api.Authentication)` — merged into
 * `Admin.Admin.layer` regardless of whether a test ever dispatches real
 * HTTP, so this domain-level suite still has to satisfy it, the same way
 * `@awthaq/passkey`'s own `Passkey.test.ts` does.
 */
const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

// AR-003: the admin group sits behind `Api.AdminAuthentication`; the default just delegates.
const AdminAuthenticationLive = Authentication.AdminAuthenticationLive.pipe(
  Layer.provide(AuthenticationLive),
);

/**
 * `admin` also now declares `.middleware(Api.CsrfProtection)` — merged into
 * `Admin.Admin.layer` regardless of whether a test ever issues real HTTP
 * (`HttpApiBuilder.group` requires it in context to even build the handlers
 * layer). No request is ever built in this domain-level suite, so nothing
 * downstream of this actually exercises the double-submit check — only its
 * presence in context is load-bearing here.
 */
const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("admin-domain-test-csrf-secret-padded-to-thirty-two-bytes"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const buildLayerWith = (config: Partial<Admin.AdminConfigShape>) =>
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

const buildLayer = (canImpersonate: Admin.AdminConfigShape["canImpersonate"]) =>
  buildLayerWith({ canImpersonate });

const allow = () => Effect.succeed(true);
const deny = () => Effect.succeed(false);

/**
 * IDS-003: `Admin` now refuses a nonexistent target, so every test seeds real
 * `Users` rows and uses their generated ids.
 */
const seedUsers = Effect.gen(function* () {
  const users = yield* Users.Users;
  const admin = yield* users.create({ email: "admin-1@example.com", name: "admin" });
  const target = yield* users.create({ email: "target-1@example.com", name: "target" });
  return { adminId: admin.id, targetId: target.id, users };
});

const protectedIds = new Set<string>();

const asCaller = (input: {
  readonly id: string;
  readonly sessionId: string;
  readonly actingAs?: { readonly type: string; readonly id: string };
}): Api.UserPrincipal =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id: input.id }),
    sessionId: input.sessionId,
    ...(input.actingAs === undefined ? {} : { actingAs: new Api.PrincipalRef(input.actingAs) }),
  });

describe("Admin", () => {
  it.effect(
    "BEH-EA-212/218: a denied gate produces AdminImpersonationDenied, no session issued",
    () =>
      Effect.gen(function* () {
        const { adminId, targetId } = yield* seedUsers;
        const admin = yield* Admin.Admin;
        const events = yield* AuthEvents.AuthEvents;
        const sessions = yield* Sessions.Sessions;

        const seen = yield* Effect.forkChild(
          events.stream.pipe(
            Stream.filter((event) => event._tag === "auth.admin.impersonationDenied"),
            Stream.take(1),
            Stream.runCollect,
          ),
          { startImmediately: true },
        );

        const caller = asCaller({ id: adminId, sessionId: "admin-session" });
        const failure = yield* admin
          .impersonate({ caller, targetUserId: targetId, reason: "reproducing a bug" })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "AdminImpersonationDenied");

        const collected = yield* Fiber.join(seen);
        assert.strictEqual(collected.length, 1);

        const listed = yield* sessions.list(targetId);
        assert.strictEqual(listed.length, 0);
      }).pipe(Effect.provide(buildLayer(deny))),
  );

  it.effect(
    "BEH-EA-213/215: a successful impersonate issues a dual-identity session and an audit row, leaving the caller's own session untouched",
    () =>
      Effect.gen(function* () {
        const { adminId, targetId } = yield* seedUsers;
        const admin = yield* Admin.Admin;
        const sessions = yield* Sessions.Sessions;
        const records = yield* ImpersonationRecords.ImpersonationRecords;

        const callerSession = yield* sessions.issue({ userId: adminId });
        const caller = asCaller({ id: adminId, sessionId: callerSession.session.id });

        const issued = yield* admin.impersonate({
          caller,
          targetUserId: targetId,
          reason: "  reproducing a bug report  ",
        });
        assert.strictEqual(issued.session.userId, targetId);
        assert.deepStrictEqual(issued.session.actingAs, Option.some({ type: "user", id: adminId }));

        const record = yield* records.findBySessionId(issued.session.id);
        assert.isTrue(Option.isSome(record));
        if (Option.isSome(record)) {
          assert.strictEqual(record.value.adminUserId, adminId);
          assert.strictEqual(record.value.targetUserId, targetId);
          assert.strictEqual(record.value.reason, "reproducing a bug report");
        }

        // The caller's own original session is completely untouched.
        const stillWorks = yield* sessions.verify(callerSession.token);
        assert.strictEqual(stillWorks.session.id, callerSession.session.id);
      }).pipe(Effect.provide(buildLayer(allow))),
  );

  it.effect(
    "BEH-EA-214/218: self-impersonation is refused before the gate, no event published",
    () =>
      Effect.gen(function* () {
        const { adminId } = yield* seedUsers;
        const admin = yield* Admin.Admin;
        const events = yield* AuthEvents.AuthEvents;

        const seen = yield* Effect.forkChild(
          events.stream.pipe(
            Stream.filter((event) => event._tag === "auth.admin.impersonationDenied"),
            Stream.take(1),
            Stream.runCollect,
          ),
          { startImmediately: true },
        );

        const caller = asCaller({ id: adminId, sessionId: "admin-session" });
        const failure = yield* admin
          .impersonate({ caller, targetUserId: adminId, reason: "test" })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "AdminSelfImpersonationRefused");

        // Prove the denied event genuinely never fires, rather than merely
        // asserting nothing was captured because the fiber never got a turn.
        yield* TestClock.adjust(Duration.millis(10));
        assert.isUndefined(seen.pollUnsafe());
        yield* Fiber.interrupt(seen);
      }).pipe(Effect.provide(buildLayer(deny))),
  );

  it.effect(
    "BEH-EA-214: a session already carrying actingAs cannot start a nested impersonation",
    () =>
      Effect.gen(function* () {
        const { adminId, targetId } = yield* seedUsers;
        const admin = yield* Admin.Admin;
        const caller = asCaller({
          id: adminId,
          sessionId: "admin-session",
          actingAs: { type: "user", id: "someone-else" },
        });
        const failure = yield* admin
          .impersonate({ caller, targetUserId: targetId, reason: "test" })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "AdminAlreadyImpersonating");
      }).pipe(Effect.provide(buildLayer(allow))),
  );

  it.effect(
    "BEH-EA-216: stopImpersonating ends the caller's own episode with no replacement session",
    () =>
      Effect.gen(function* () {
        const { adminId, targetId } = yield* seedUsers;
        const admin = yield* Admin.Admin;
        const sessions = yield* Sessions.Sessions;
        const records = yield* ImpersonationRecords.ImpersonationRecords;

        const callerSession = yield* sessions.issue({ userId: adminId });
        const caller = asCaller({ id: adminId, sessionId: callerSession.session.id });
        const issued = yield* admin.impersonate({ caller, targetUserId: targetId, reason: "test" });

        const impersonating = asCaller({
          id: targetId,
          sessionId: issued.session.id,
          actingAs: { type: "user", id: adminId },
        });
        yield* admin.stopImpersonating(impersonating);

        const revoked = yield* sessions.verify(issued.token).pipe(Effect.flip);
        assert.strictEqual(revoked._tag, "SessionNotFound");

        const record = yield* records.findBySessionId(issued.session.id);
        assert.isTrue(Option.isSome(record));
        if (Option.isSome(record)) {
          assert.deepStrictEqual(record.value.endedBy, Option.some("self"));
        }

        // The target's own (separate, real) sessions are untouched.
        const targetOwnSession = yield* sessions.issue({ userId: targetId });
        const stillWorks = yield* sessions.verify(targetOwnSession.token);
        assert.strictEqual(stillWorks.session.id, targetOwnSession.session.id);
      }).pipe(Effect.provide(buildLayer(allow))),
  );

  it.effect("stopImpersonating fails when the caller's own session carries no actingAs", () =>
    Effect.gen(function* () {
      const { adminId } = yield* seedUsers;
      const admin = yield* Admin.Admin;
      const caller = asCaller({ id: adminId, sessionId: "admin-session" });
      const failure = yield* admin.stopImpersonating(caller).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "AdminImpersonationNotFound");
    }).pipe(Effect.provide(buildLayer(allow))),
  );

  it.effect(
    "BEH-EA-217: forceStop ends another admin's episode and refuses an unknown session id",
    () =>
      Effect.gen(function* () {
        const { adminId, targetId } = yield* seedUsers;
        const admin = yield* Admin.Admin;
        const sessions = yield* Sessions.Sessions;

        const callerSession = yield* sessions.issue({ userId: adminId });
        const caller = asCaller({ id: adminId, sessionId: callerSession.session.id });
        const issued = yield* admin.impersonate({ caller, targetUserId: targetId, reason: "test" });

        const anotherAdmin = asCaller({ id: "admin-2", sessionId: "admin-2-session" });
        yield* admin.forceStop(anotherAdmin, issued.session.id);

        const revoked = yield* sessions.verify(issued.token).pipe(Effect.flip);
        assert.strictEqual(revoked._tag, "SessionNotFound");

        const notFound = yield* admin.forceStop(anotherAdmin, issued.session.id).pipe(Effect.flip);
        assert.strictEqual(notFound._tag, "AdminImpersonationNotFound");

        const unknown = yield* admin.forceStop(anotherAdmin, "does-not-exist").pipe(Effect.flip);
        assert.strictEqual(unknown._tag, "AdminImpersonationNotFound");
      }).pipe(Effect.provide(buildLayer(allow))),
  );

  it.effect("forceStop is gated: a gate that refuses the episode's target denies the stop", () =>
    Effect.gen(function* () {
      const { adminId, targetId } = yield* seedUsers;
      const admin = yield* Admin.Admin;
      const sessions = yield* Sessions.Sessions;
      const records = yield* ImpersonationRecords.ImpersonationRecords;
      const ownSession = yield* sessions.issue({ userId: adminId });
      // The episode row exists (created out of band, as another admin's would be);
      // the deny-all gate must refuse to end it.
      yield* records.create({
        adminUserId: adminId,
        targetUserId: targetId,
        sessionId: ownSession.session.id,
        reason: "seed",
        expiresAt: DateTime.addDuration(yield* DateTime.now, Duration.days(1)),
      });
      const anotherAdmin = asCaller({ id: "admin-2", sessionId: "admin-2-session" });
      const failure = yield* admin.forceStop(anotherAdmin, ownSession.session.id).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "AdminImpersonationDenied");
    }).pipe(Effect.provide(buildLayer(deny))),
  );

  it.effect(
    "BEH-EA-219/220: list returns full history newest-first and an active filter, gated by the same predicate",
    () =>
      Effect.gen(function* () {
        const { adminId, targetId } = yield* seedUsers;
        const admin = yield* Admin.Admin;
        const sessions = yield* Sessions.Sessions;

        const callerSession = yield* sessions.issue({ userId: adminId });
        const caller = asCaller({ id: adminId, sessionId: callerSession.session.id });
        const ended = yield* admin.impersonate({ caller, targetUserId: targetId, reason: "first" });
        yield* admin.stopImpersonating(
          asCaller({
            id: targetId,
            sessionId: ended.session.id,
            actingAs: { type: "user", id: adminId },
          }),
        );
        yield* admin.impersonate({ caller, targetUserId: targetId, reason: "second" });

        const all = (yield* admin.list(caller)).items;
        assert.strictEqual(all.length, 2);

        const active = (yield* admin.list(caller, { active: true })).items;
        assert.strictEqual(active.length, 1);
        assert.strictEqual(active[0]?.reason, "second");
      }).pipe(Effect.provide(buildLayer(allow))),
  );

  it.effect("IDS-001: list under a deny-all gate exposes no episodes (fail-closed)", () =>
    Effect.gen(function* () {
      const { adminId, targetId } = yield* seedUsers;
      const admin = yield* Admin.Admin;
      const records = yield* ImpersonationRecords.ImpersonationRecords;
      yield* records.create({
        adminUserId: adminId,
        targetUserId: targetId,
        sessionId: "seeded-session",
        reason: "seed",
        expiresAt: DateTime.addDuration(yield* DateTime.now, Duration.days(1)),
      });
      const caller = asCaller({ id: adminId, sessionId: "admin-session" });
      const page = (yield* admin.list(caller)).items;
      assert.strictEqual(page.length, 0);
    }).pipe(Effect.provide(buildLayer(deny))),
  );

  it.effect("IDS-001: canImpersonate receives the target and can refuse a protected target", () =>
    Effect.gen(function* () {
      const { adminId, targetId, users } = yield* seedUsers;
      const protectedUser = yield* users.create({
        email: "superadmin-2@example.com",
        name: "superadmin",
      });
      protectedIds.add(protectedUser.id);
      const admin = yield* Admin.Admin;
      const events = yield* AuthEvents.AuthEvents;
      const seen = yield* Effect.forkChild(
        events.stream.pipe(
          Stream.filter((event) => event._tag === "auth.admin.impersonationDenied"),
          Stream.take(1),
          Stream.runCollect,
        ),
        { startImmediately: true },
      );
      const caller = asCaller({ id: adminId, sessionId: "admin-session" });

      const refused = yield* admin
        .impersonate({ caller, targetUserId: protectedUser.id, reason: "not allowed" })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "AdminImpersonationDenied");
      assert.strictEqual((yield* Fiber.join(seen)).length, 1);

      const issued = yield* admin.impersonate({
        caller,
        targetUserId: targetId,
        reason: "allowed",
      });
      assert.strictEqual(issued.session.userId, targetId);
    }).pipe(
      Effect.provide(buildLayer(({ target }) => Effect.succeed(!protectedIds.has(target.id)))),
    ),
  );

  it.effect("IDS-001: forceStop/list are filtered by canManageEpisode", () =>
    Effect.gen(function* () {
      const { adminId, targetId, users } = yield* seedUsers;
      const other = yield* users.create({ email: "other@example.com", name: "other" });
      const admin = yield* Admin.Admin;
      const sessions = yield* Sessions.Sessions;
      const caller = asCaller({ id: adminId, sessionId: "admin-session" });

      const visible = yield* admin.impersonate({ caller, targetUserId: targetId, reason: "a" });
      const hidden = yield* admin.impersonate({ caller, targetUserId: other.id, reason: "b" });

      const page = (yield* admin.list(caller)).items;
      assert.strictEqual(page.length, 1);
      assert.strictEqual(page[0]?.sessionId, visible.session.id);

      const failure = yield* admin.forceStop(caller, hidden.session.id).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "AdminImpersonationDenied");
      // The refused episode's session is still live.
      const stillLive = yield* sessions.verify(hidden.token);
      assert.strictEqual(stillLive.session.id, hidden.session.id);

      yield* admin.forceStop(caller, visible.session.id);
    }).pipe(
      Effect.provide(
        buildLayerWith({
          canImpersonate: () => Effect.succeed(true),
          canManageEpisode: ({ episode }) => Effect.succeed(episode.reason === "a"),
        }),
      ),
    ),
  );

  it.effect(
    "IDS-003: impersonating a nonexistent user fails AdminTargetNotFound and writes no session, no audit row, no impersonationStarted event",
    () =>
      Effect.gen(function* () {
        const { adminId } = yield* seedUsers;
        const admin = yield* Admin.Admin;
        const events = yield* AuthEvents.AuthEvents;
        const sessions = yield* Sessions.Sessions;
        const records = yield* ImpersonationRecords.ImpersonationRecords;
        const seen = yield* Effect.forkChild(
          events.stream.pipe(
            Stream.filter((event) => event._tag.startsWith("auth.admin.impersonation")),
            Stream.take(1),
            Stream.runCollect,
          ),
          { startImmediately: true },
        );
        const caller = asCaller({ id: adminId, sessionId: "admin-session" });
        const ghost = Users.UserId("ghost-user");
        const failure = yield* admin
          .impersonate({ caller, targetUserId: ghost, reason: "phantom" })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "AdminTargetNotFound");

        assert.strictEqual((yield* sessions.list(ghost)).length, 0);
        assert.strictEqual((yield* records.list()).items.length, 0);
        yield* TestClock.adjust(Duration.millis(10));
        assert.isUndefined(seen.pollUnsafe());
        yield* Fiber.interrupt(seen);
      }).pipe(Effect.provide(buildLayer(allow))),
  );

  it.effect(
    "IDS-003: a gate-refused caller gets 403, not 404, for an unknown target (no existence oracle)",
    () =>
      Effect.gen(function* () {
        const { adminId } = yield* seedUsers;
        const admin = yield* Admin.Admin;
        const caller = asCaller({ id: adminId, sessionId: "admin-session" });
        const failure = yield* admin
          .impersonate({ caller, targetUserId: Users.UserId("ghost-user"), reason: "probe" })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "AdminImpersonationDenied");
      }).pipe(Effect.provide(buildLayer(deny))),
  );

  /** Collects every `impersonationStopped` event published from now on (the fork is registered before it returns). */
  const collectStopped = Effect.gen(function* () {
    const events = yield* AuthEvents.AuthEvents;
    const seen = yield* Ref.make<ReadonlyArray<{ sessionId: string; endedBy: string }>>([]);
    yield* events.stream.pipe(
      Stream.runForEach((event) =>
        event._tag === "auth.admin.impersonationStopped"
          ? Ref.update(seen, (all) => [
              ...all,
              { sessionId: event.sessionId, endedBy: event.endedBy },
            ])
          : Effect.void,
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    return seen;
  });

  it.effect(
    "IDS-004: an episode past maxDuration is reported ended (expired) by list({active:true}), closed once with one stopped event",
    () =>
      Effect.gen(function* () {
        const { adminId, targetId } = yield* seedUsers;
        const admin = yield* Admin.Admin;
        const seen = yield* collectStopped;
        const caller = asCaller({ id: adminId, sessionId: "admin-session" });
        const issued = yield* admin.impersonate({ caller, targetUserId: targetId, reason: "x" });

        yield* TestClock.adjust(Duration.sum(Duration.hours(1), Duration.seconds(1)));
        const active = (yield* admin.list(caller, { active: true })).items;
        assert.strictEqual(active.length, 0);

        const all = (yield* admin.list(caller)).items;
        assert.strictEqual(all.length, 1);
        assert.deepStrictEqual(all[0]?.endedBy, Option.some("expired"));
        assert.deepStrictEqual(
          all[0]?.endedAt,
          Option.some(DateTime.addDuration(all[0]!.startedAt, Duration.hours(1))),
        );

        // A further read must not re-close or re-announce it.
        yield* admin.list(caller);
        yield* TestClock.adjust(Duration.millis(10));
        assert.deepStrictEqual(yield* Ref.get(seen), [
          { sessionId: issued.session.id, endedBy: "expired" },
        ]);
      }).pipe(Effect.scoped, Effect.provide(buildLayer(allow))),
  );

  it.effect("IDS-004: sweepExpiredEpisodes closes expired episodes without any read", () =>
    Effect.gen(function* () {
      const { adminId, targetId } = yield* seedUsers;
      const admin = yield* Admin.Admin;
      const records = yield* ImpersonationRecords.ImpersonationRecords;
      const seen = yield* collectStopped;
      const caller = asCaller({ id: adminId, sessionId: "admin-session" });
      const issued = yield* admin.impersonate({ caller, targetUserId: targetId, reason: "x" });

      assert.strictEqual(yield* Admin.sweepExpiredEpisodes, 0);
      yield* TestClock.adjust(Duration.sum(Duration.hours(1), Duration.seconds(1)));
      assert.strictEqual(yield* Admin.sweepExpiredEpisodes, 1);
      assert.strictEqual(yield* Admin.sweepExpiredEpisodes, 0);

      const row = yield* records.findBySessionId(issued.session.id);
      assert.isTrue(Option.isSome(row));
      if (Option.isSome(row)) assert.deepStrictEqual(row.value.endedBy, Option.some("expired"));
      yield* TestClock.adjust(Duration.millis(10));
      assert.strictEqual((yield* Ref.get(seen)).length, 1);
    }).pipe(Effect.scoped, Effect.provide(buildLayer(allow))),
  );

  it.effect("IDS-007: stopImpersonating still revokes when the audit row was already ended", () =>
    Effect.gen(function* () {
      const { adminId, targetId } = yield* seedUsers;
      const admin = yield* Admin.Admin;
      const sessions = yield* Sessions.Sessions;
      const records = yield* ImpersonationRecords.ImpersonationRecords;
      const caller = asCaller({ id: adminId, sessionId: "admin-session" });
      const issued = yield* admin.impersonate({ caller, targetUserId: targetId, reason: "x" });
      yield* records.endEpisode(issued.session.id, "forcedByAdmin");

      yield* admin.stopImpersonating(
        asCaller({
          id: targetId,
          sessionId: issued.session.id,
          actingAs: { type: "user", id: adminId },
        }),
      );
      const revoked = yield* sessions.verify(issued.token).pipe(Effect.flip);
      assert.strictEqual(revoked._tag, "SessionNotFound");
    }).pipe(Effect.provide(buildLayer(allow))),
  );

  it.effect("IDS-007: forceStop after the target's revokeAll does not die", () =>
    Effect.gen(function* () {
      const { adminId, targetId } = yield* seedUsers;
      const admin = yield* Admin.Admin;
      const sessions = yield* Sessions.Sessions;
      const records = yield* ImpersonationRecords.ImpersonationRecords;
      const caller = asCaller({ id: adminId, sessionId: "admin-session" });
      const issued = yield* admin.impersonate({ caller, targetUserId: targetId, reason: "x" });
      // e.g. the target's password reset: their own sessions, impersonation included, are gone.
      yield* sessions.revokeAll(targetId, "admin");

      yield* admin.forceStop(caller, issued.session.id);
      const row = yield* records.findBySessionId(issued.session.id);
      assert.isTrue(Option.isSome(row));
      if (Option.isSome(row)) {
        assert.deepStrictEqual(row.value.endedBy, Option.some("forcedByAdmin"));
      }
    }).pipe(Effect.provide(buildLayer(allow))),
  );

  it.effect("IDS-007: forceStop never revokes a session that has no episode row", () =>
    Effect.gen(function* () {
      const { adminId, targetId } = yield* seedUsers;
      const admin = yield* Admin.Admin;
      const sessions = yield* Sessions.Sessions;
      const ordinary = yield* sessions.issue({ userId: targetId });
      const caller = asCaller({ id: adminId, sessionId: "admin-session" });

      const failure = yield* admin.forceStop(caller, ordinary.session.id).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "AdminImpersonationNotFound");
      const stillLive = yield* sessions.verify(ordinary.token);
      assert.strictEqual(stillLive.session.id, ordinary.session.id);
    }).pipe(Effect.provide(buildLayer(allow))),
  );

  it.effect(
    "IDS-007: forceStop on an already-ended episode still revokes its live session, then reports it ended",
    () =>
      Effect.gen(function* () {
        const { adminId, targetId } = yield* seedUsers;
        const admin = yield* Admin.Admin;
        const sessions = yield* Sessions.Sessions;
        const records = yield* ImpersonationRecords.ImpersonationRecords;
        const caller = asCaller({ id: adminId, sessionId: "admin-session" });
        const issued = yield* admin.impersonate({ caller, targetUserId: targetId, reason: "x" });
        yield* records.endEpisode(issued.session.id, "self");

        const failure = yield* admin.forceStop(caller, issued.session.id).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "AdminImpersonationNotFound");
        const revoked = yield* sessions.verify(issued.token).pipe(Effect.flip);
        assert.strictEqual(revoked._tag, "SessionNotFound");
      }).pipe(Effect.provide(buildLayer(allow))),
  );
});
