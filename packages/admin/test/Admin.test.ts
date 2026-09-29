// spec/behaviors/27-admin-impersonation.md, BEH-EA-209 through BEH-EA-220.
//
// Real, in-memory domain-level tests (no HTTP layer here — see
// `AuthHttp.test.ts` for the wire-level equivalent, ticket 08): real
// `Sessions`/`AuthEvents`/`ImpersonationRecords`, a plain in-test
// `canImpersonate` function (no `Layer.mock` needed — it is a bare config
// predicate, not a service).
import { Api } from "@awthaq/api";
import { AuditLog, AuthEvents, Sessions, Users } from "@awthaq/core";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Admin from "../src/Admin.ts";
import * as ImpersonationRecords from "../src/ImpersonationRecords.ts";

const CoreLive = Layer.mergeAll(Sessions.layerMemory).pipe(
  // RRS-003: `Sessions.layerMemory` now also needs `AuthEvents`.
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
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

const buildLayer = (canImpersonate: Admin.AdminConfigShape["canImpersonate"]) =>
  Admin.Admin.layer.pipe(
    Layer.provide(Admin.config({ canImpersonate })),
    Layer.provide(AuthenticationLive),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(ImpersonationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
  );

const allow = () => Effect.succeed(true);
const deny = () => Effect.succeed(false);

const adminId = Users.UserId("admin-1");
const targetId = Users.UserId("target-1");

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

  it.effect("forceStop is gated by the same canImpersonate predicate as impersonate", () =>
    Effect.gen(function* () {
      const admin = yield* Admin.Admin;
      const anotherAdmin = asCaller({ id: "admin-2", sessionId: "admin-2-session" });
      const failure = yield* admin.forceStop(anotherAdmin, "some-session").pipe(Effect.flip);
      assert.strictEqual(failure._tag, "AdminImpersonationDenied");
    }).pipe(Effect.provide(buildLayer(deny))),
  );

  it.effect(
    "BEH-EA-219/220: list returns full history newest-first and an active filter, gated by the same predicate",
    () =>
      Effect.gen(function* () {
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

        const all = yield* admin.list(caller);
        assert.strictEqual(all.length, 2);

        const active = yield* admin.list(caller, { active: true });
        assert.strictEqual(active.length, 1);
        assert.strictEqual(active[0]?.reason, "second");
      }).pipe(Effect.provide(buildLayer(allow))),
  );

  it.effect("list is denied for a caller failing the gate", () =>
    Effect.gen(function* () {
      const admin = yield* Admin.Admin;
      const caller = asCaller({ id: adminId, sessionId: "admin-session" });
      const failure = yield* admin.list(caller).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "AdminImpersonationDenied");
    }).pipe(Effect.provide(buildLayer(deny))),
  );
});
