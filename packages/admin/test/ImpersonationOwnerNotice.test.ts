// ARF-005 (wayfinder ticket 05 §2), BEH-EA-209: the one mitigation shipped for a zero-factor recovery —
// support-assisted impersonation stops being silent to the account owner. Opt-in; the notice carries
// the reason and the time, never a session id or token.
import { AuditLog, AuthEvents, Hooks, Persistence, Sessions, Users } from "@awthaq/core";
import { TestMailbox } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AdminEvents from "../src/AdminEvents.ts";
import * as ImpersonationOwnerNotice from "../src/ImpersonationOwnerNotice.ts";

const CoreLive = Users.layer
  .pipe(Layer.provide(Persistence.memory))
  .pipe(
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
    Layer.provideMerge(Hooks.BeforeUserDelete.layer),
    Layer.provideMerge(TestMailbox.layer),
    Layer.provideMerge(NodeCrypto.layer),
  );

/** The notice subscribed to the bus, over the same events/users/mailer the test publishes to. */
const TestLayer = ImpersonationOwnerNotice.layer.pipe(Layer.provideMerge(CoreLive));

const startedBy = (adminUserId: Users.UserId, targetUserId: Users.UserId) => ({
  adminUserId,
  targetUserId,
  reason: "customer asked us to reproduce a billing bug",
  sessionId: Sessions.SessionId("session-secret-id"),
});

describe("ImpersonationOwnerNotice.layer (ARF-005)", () => {
  it.effect(
    "mails the target's owner when impersonation starts, with the reason and no credential",
    () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const events = yield* AuthEvents.AuthEvents;
        const box = yield* TestMailbox.Mailbox;
        const admin = yield* users.create({
          identity: { _tag: "Email", email: "admin@example.com" },
          name: "Admin",
        });
        const target = yield* users.create({
          identity: { _tag: "Email", email: "owner@example.com" },
          name: "Owner",
        });
        yield* events.emit(
          AdminEvents.AdminImpersonationStartedEvent,
          startedBy(admin.id, target.id),
        );

        const mail = yield* box.mail.waitFor({
          to: "owner@example.com",
          template: "impersonation-started",
        });
        yield* box.mail.refute({}, { beyond: 1 });
        assert.strictEqual(mail.data?.["reason"], "customer asked us to reproduce a billing bug");
        assert.isString(mail.data?.["startedAt"]);
        // Never the session id, the admin's identity or a token.
        const text = JSON.stringify(mail);
        for (const forbidden of ["session-secret-id", admin.id, "admin@example.com", "token"]) {
          assert.notInclude(text, forbidden);
        }
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "a phone or anonymous account has no address, so nothing is sent (and nothing fails)",
    () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const events = yield* AuthEvents.AuthEvents;
        const box = yield* TestMailbox.Mailbox;
        const admin = yield* users.create({
          identity: { _tag: "Email", email: "admin2@example.com" },
          name: "Admin",
        });
        const anonymous = yield* users.create({
          identity: { _tag: "Anonymous" },
          name: "Anon",
        });
        yield* events.emit(
          AdminEvents.AdminImpersonationStartedEvent,
          startedBy(admin.id, anonymous.id),
        );
        yield* box.mail.refute({});
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("other admin events do not mail anyone", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const events = yield* AuthEvents.AuthEvents;
      const box = yield* TestMailbox.Mailbox;
      const target = yield* users.create({
        identity: { _tag: "Email", email: "quiet@example.com" },
        name: "Quiet",
      });
      yield* events.emit(AdminEvents.AdminUserUpdatedEvent, {
        adminUserId: target.id,
        userId: target.id,
      });
      yield* box.mail.refute({});
    }).pipe(Effect.provide(TestLayer)),
  );
});
