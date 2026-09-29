// ARF-005 (wayfinder ticket 05 §2), BEH-EA-209: the one mitigation shipped for a zero-factor recovery —
// support-assisted impersonation stops being silent to the account owner. Opt-in; the notice carries
// the reason and the time, never a session id or token.
import { AuditLog, AuthEvents, Hooks, Sessions, Users } from "@awthaq/core";
import { Mailer } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as ImpersonationOwnerNotice from "../src/ImpersonationOwnerNotice.ts";

const CoreLive = Users.layerMemory.pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.BeforeUserDelete.layer),
  Layer.provideMerge(Mailer.layerMemory),
  Layer.provideMerge(NodeCrypto.layer),
);

/** The notice subscribed to the bus, over the same events/users/mailer the test publishes to. */
const TestLayer = ImpersonationOwnerNotice.layer.pipe(Layer.provideMerge(CoreLive));

const settle = Effect.gen(function* () {
  yield* TestClock.adjust(Duration.millis(50));
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
});

const startedBy = (adminUserId: Users.UserId, targetUserId: Users.UserId) => ({
  _tag: "auth.admin.impersonationStarted" as const,
  adminUserId,
  targetUserId,
  reason: "customer asked us to reproduce a billing bug",
  sessionId: Sessions.SessionId("session-secret-id"),
});

describe("ImpersonationOwnerNotice.layer (ARF-005)", () => {
  it.effect("mails the target's owner when impersonation starts, with the reason and no credential", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const events = yield* AuthEvents.AuthEvents;
      const mailer = yield* Mailer.Mailer;
      const admin = yield* users.create({
        identity: { _tag: "Email", email: "admin@example.com" },
        name: "Admin",
      });
      const target = yield* users.create({
        identity: { _tag: "Email", email: "owner@example.com" },
        name: "Owner",
      });
      yield* settle;
      yield* events.publish(startedBy(admin.id, target.id));
      yield* settle;

      const sent = yield* mailer.sent;
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0]?.to, "owner@example.com");
      assert.strictEqual(sent[0]?.template, "impersonation-started");
      assert.strictEqual(
        sent[0]?.data?.["reason"],
        "customer asked us to reproduce a billing bug",
      );
      assert.isString(sent[0]?.data?.["startedAt"]);
      // Never the session id, the admin's identity or a token.
      const text = JSON.stringify(sent[0]);
      for (const forbidden of ["session-secret-id", admin.id, "admin@example.com", "token"]) {
        assert.notInclude(text, forbidden);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a phone or anonymous account has no address, so nothing is sent (and nothing fails)", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const events = yield* AuthEvents.AuthEvents;
      const mailer = yield* Mailer.Mailer;
      const admin = yield* users.create({
        identity: { _tag: "Email", email: "admin2@example.com" },
        name: "Admin",
      });
      const anonymous = yield* users.create({ identity: { _tag: "Anonymous" }, name: "Anon" });
      yield* settle;
      yield* events.publish(startedBy(admin.id, anonymous.id));
      yield* settle;
      assert.strictEqual((yield* mailer.sent).length, 0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("other admin events do not mail anyone", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const events = yield* AuthEvents.AuthEvents;
      const mailer = yield* Mailer.Mailer;
      const target = yield* users.create({
        identity: { _tag: "Email", email: "quiet@example.com" },
        name: "Quiet",
      });
      yield* settle;
      yield* events.publish({
        _tag: "auth.admin.userUpdated",
        adminUserId: target.id,
        userId: target.id,
      });
      yield* settle;
      assert.strictEqual((yield* mailer.sent).length, 0);
    }).pipe(Effect.provide(TestLayer)),
  );
});
