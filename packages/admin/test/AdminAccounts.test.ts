// BAM-005/BAM-009 (BEH-EA-221, BEH-EA-225): AdminAccounts — delete a user through the one erasure
// cascade, set a user's email through the mailed change-email flow, set a user's password through
// the PasswordHasher port with every session revoked. Every capability behind its own fail-closed
// predicate.
//
// Domain-level like `AdminUsers.test.ts`: real in-memory stores and a real argon2id hasher.
import { Api } from "@awthaq/api";
import {
  Accounts,
  AuthEvents,
  EmailChange,
  Erasure,
  HookPoint,
  Hooks,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import { Mailer, PasswordHasher, SqlTransaction } from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Admin from "../src/Admin.ts";
import * as AdminAccounts from "../src/AdminAccounts.ts";
import { TestAuth } from "@awthaq/test";

const CoreLive = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  Sessions.layerMemory,
  Verification.layerMemory,
).pipe(Layer.provideMerge(TestAuth.memoryFoundation));

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);
const AdminAuthenticationLive = Authentication.AdminAuthenticationLive.pipe(
  Layer.provide(AuthenticationLive),
);
const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("admin-accounts-test-csrf-secret-padded-to-thirty-two-bytes"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const failingMailer = Layer.succeed(
  Mailer.Mailer,
  Mailer.Mailer.of({
    send: (message) =>
      Effect.fail(
        new Mailer.MailDeliveryFailed({
          template: message.template,
          reason: "provider down",
          retryable: false,
        }),
      ),
    sent: Effect.succeed([]),
  }),
);

/** A legal hold: `BeforeUserDelete` refuses `hold@example.com`. */
const legalHold = Hooks.BeforeUserDelete.tap((input) =>
  input.email === "hold@example.com"
    ? Effect.fail(new HookPoint.HookAbort({ code: "LEGAL_HOLD" }))
    : Effect.succeed(input),
);

/** What `@awthaq/two-factor`'s `credentialResetGate` does for an enrolled user asked with no code. */
const secondFactorGate = Hooks.BeforeCredentialReset.tap(() =>
  Effect.fail(new HookPoint.HookAbort({ code: "TWO_FACTOR_REQUIRED" })),
);

const buildLayer = (
  config: Partial<Admin.AdminConfigShape>,
  options: {
    readonly mailer?: Layer.Layer<Mailer.Mailer>;
    readonly veto?: boolean;
    readonly resetVeto?: boolean;
  } = {},
) => {
  const withHold = options.veto ? legalHold.pipe(Layer.provideMerge(CoreLive)) : CoreLive;
  const stores = options.resetVeto ? secondFactorGate.pipe(Layer.provideMerge(withHold)) : withHold;
  return AdminAccounts.AdminAccounts.layer.pipe(
    Layer.provide(Admin.config(config)),
    Layer.provide(AdminAuthenticationLive),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(Erasure.layer.pipe(Layer.provideMerge(stores))),
    Layer.provideMerge(
      Layer.mergeAll(
        PasswordHasher.layerArgon2id,
        options.mailer ?? Mailer.layerMemory,
        SqlTransaction.layerNoop,
      ).pipe(Layer.provideMerge(NodeCrypto.layer)),
    ),
  );
};

const manageAll = {
  canDeleteUsers: () => Effect.succeed(true),
  canManageCredentials: () => Effect.succeed(true),
};

const asCaller = (id: string): Api.UserPrincipal =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id }),
    sessionId: "admin-session",
  });

const seed = Effect.gen(function* () {
  const users = yield* Users.Users;
  const accounts = yield* Accounts.Accounts;
  const hasher = yield* PasswordHasher.PasswordHasher;
  const admin = yield* users.create({
    identity: { _tag: "Email", email: "admin@example.com" },
    name: "Admin",
  });
  const target = yield* users.create({
    identity: { _tag: "Email", email: "target@example.com" },
    name: "Target",
  });
  const oldPassword = Redacted.make("the old password of the target");
  yield* accounts.link({
    userId: target.id,
    providerId: Accounts.PASSWORD_PROVIDER_ID,
    subject: target.id,
    credentialHash: Redacted.make(yield* hasher.hash(oldPassword)),
  });
  return { adminId: admin.id, targetId: target.id, users, accounts, hasher, oldPassword };
});

const collectEvents = Effect.gen(function* () {
  const events = yield* AuthEvents.AuthEvents;
  const seen = yield* Ref.make<ReadonlyArray<AuthEvents.AuthEvent>>([]);
  yield* events.stream.pipe(
    Stream.runForEach((event) => Ref.update(seen, (all) => [...all, event])),
    Effect.forkScoped({ startImmediately: true }),
  );
  return seen;
});

describe("AdminAccounts: gates (BAM-005)", () => {
  it.effect("every capability is fail-closed by default and publishes actionDenied", () =>
    Effect.gen(function* () {
      const { adminId, targetId } = yield* seed;
      const accounts = yield* AdminAccounts.AdminAccounts;
      const seen = yield* collectEvents;
      const caller = asCaller(adminId);
      // Sequential, so the events come in this order.
      const failures = yield* Effect.all({
        deleteUser: accounts.deleteUser(caller, targetId).pipe(Effect.flip),
        setUserEmail: accounts
          .setUserEmail(caller, targetId, { email: "new@example.com" })
          .pipe(Effect.flip),
        setUserPassword: accounts
          .setUserPassword(caller, targetId, {
            password: Redacted.make("a brand new strong password"),
          })
          .pipe(Effect.flip),
      });
      for (const [action, failure] of Object.entries(failures)) {
        assert.strictEqual(failure._tag, "AdminActionDenied", action);
      }
      yield* TestClock.adjust(Duration.millis(10));
      const denied = (yield* Ref.get(seen)).flatMap((e) =>
        e._tag === "auth.admin.actionDenied" ? [e.action] : [],
      );
      assert.deepStrictEqual(denied, Object.keys(failures));
    }).pipe(Effect.scoped, Effect.provide(buildLayer({}))),
  );

  it.effect(
    "the predicates are separate: managing users grants neither deleting nor credentials",
    () =>
      Effect.gen(function* () {
        const { adminId, targetId } = yield* seed;
        const accounts = yield* AdminAccounts.AdminAccounts;
        const caller = asCaller(adminId);
        const deleted = yield* accounts.deleteUser(caller, targetId).pipe(Effect.flip);
        assert.strictEqual(deleted._tag, "AdminActionDenied");
        const credentials = yield* accounts
          .setUserPassword(caller, targetId, {
            password: Redacted.make("a brand new strong password"),
          })
          .pipe(Effect.flip);
        assert.strictEqual(credentials._tag, "AdminActionDenied");
      }).pipe(
        Effect.provide(
          buildLayer({
            canManageUsers: () => Effect.succeed(true),
            canBanUsers: () => Effect.succeed(true),
          }),
        ),
      ),
  );

  it.effect(
    "the gate runs before existence: only a gate-passing caller learns a user is unknown",
    () =>
      Effect.gen(function* () {
        const { adminId } = yield* seed;
        const accounts = yield* AdminAccounts.AdminAccounts;
        const missing = yield* accounts
          .deleteUser(asCaller(adminId), Users.UserId("ghost"))
          .pipe(Effect.flip);
        assert.strictEqual(missing._tag, "AdminTargetNotFound");
      }).pipe(Effect.provide(buildLayer(manageAll))),
  );
});

describe("AdminAccounts: deleteUser (BAM-005)", () => {
  it.effect(
    "runs the one erasure cascade: user, credential and sessions go, both events name who and what",
    () =>
      Effect.gen(function* () {
        const { adminId, targetId, users, accounts } = yield* seed;
        const sessions = yield* Sessions.Sessions;
        const admin = yield* AdminAccounts.AdminAccounts;
        const seen = yield* collectEvents;
        const session = yield* sessions.issue({ userId: targetId });

        yield* admin.deleteUser(asCaller(adminId), targetId);

        const lookup = yield* users.findById(targetId).pipe(Effect.flip);
        assert.strictEqual(lookup._tag, "UserNotFound");
        assert.isTrue(
          Option.isNone(
            yield* accounts.findByProviderSubject(Accounts.PASSWORD_PROVIDER_ID, targetId),
          ),
        );
        const verify = yield* sessions.verify(session.token).pipe(Effect.flip);
        assert.strictEqual(verify._tag, "Sessions/NotFound");
        yield* TestClock.adjust(Duration.millis(10));
        const events = yield* Ref.get(seen);
        assert.isTrue(
          events.some(
            (e) =>
              e._tag === "auth.user.deleted" && e.userId === targetId && e.deletedBy === "admin",
          ),
        );
        assert.isTrue(
          events.some(
            (e) =>
              e._tag === "auth.admin.userDeleted" &&
              e.adminUserId === adminId &&
              e.userId === targetId,
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(buildLayer(manageAll))),
  );

  it.effect("an administrator cannot delete their own account", () =>
    Effect.gen(function* () {
      const { adminId, users } = yield* seed;
      const admin = yield* AdminAccounts.AdminAccounts;
      const failure = yield* admin.deleteUser(asCaller(adminId), adminId).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "AdminSelfActionRefused");
      assert.strictEqual((yield* users.findById(adminId)).id, adminId);
    }).pipe(Effect.provide(buildLayer(manageAll))),
  );

  it.effect("a BeforeUserDelete veto surfaces as HookAborted and nothing is deleted", () =>
    Effect.gen(function* () {
      const { adminId, users } = yield* seed;
      const held = yield* users.create({
        identity: { _tag: "Email", email: "hold@example.com" },
        name: "Held",
      });
      const admin = yield* AdminAccounts.AdminAccounts;
      const failure = yield* admin.deleteUser(asCaller(adminId), held.id).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "HookAborted");
      assert.strictEqual((yield* users.findById(held.id)).id, held.id);
    }).pipe(Effect.provide(buildLayer(manageAll, { veto: true }))),
  );
});

describe("AdminAccounts: setUserEmail (BAM-005/BAM-009)", () => {
  it.effect("mails a change-email token to the new address only; the address is not changed", () =>
    Effect.gen(function* () {
      const { adminId, targetId, users } = yield* seed;
      const admin = yield* AdminAccounts.AdminAccounts;
      const mailer = yield* Mailer.Mailer;
      const verification = yield* Verification.Verification;
      const seen = yield* collectEvents;

      yield* admin.setUserEmail(asCaller(adminId), targetId, { email: "new@example.com" });

      const [mail, ...rest] = (yield* mailer.sent).filter(
        (m) => m.template === EmailChange.TEMPLATE,
      );
      assert.strictEqual(rest.length, 0);
      assert.strictEqual(mail?.to, "new@example.com");
      assert.strictEqual(
        Option.getOrThrow(Users.emailOf(yield* users.findById(targetId))),
        "target@example.com",
      );
      // The token is the shared purpose: consuming it yields the account and the new address.
      const raw = mail?.data?.["token"];
      assert.isTrue(Redacted.isRedacted(raw));
      const token = Redacted.isRedacted(raw) ? String(Redacted.value(raw)) : "";
      assert.include(token, `${EmailChange.PURPOSE}:`);
      const separator = token.lastIndexOf(".");
      const consumed = yield* verification.consume(
        token.slice(0, separator),
        Redacted.make(token.slice(separator + 1)),
      );
      assert.strictEqual(Option.getOrNull(consumed.userId), targetId);
      assert.deepStrictEqual(
        EmailChange.newEmailOf(consumed.payload),
        Option.some("new@example.com"),
      );
      yield* TestClock.adjust(Duration.millis(10));
      assert.isTrue(
        (yield* Ref.get(seen)).some(
          (e) => e._tag === "auth.admin.userEmailChangeRequested" && e.userId === targetId,
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(buildLayer(manageAll))),
  );

  it.effect("the same address is a no-op; a taken address is refused to the administrator", () =>
    Effect.gen(function* () {
      const { adminId, targetId } = yield* seed;
      const admin = yield* AdminAccounts.AdminAccounts;
      const mailer = yield* Mailer.Mailer;
      yield* admin.setUserEmail(asCaller(adminId), targetId, { email: "TARGET@example.com" });
      assert.strictEqual((yield* mailer.sent).length, 0);
      const taken = yield* admin
        .setUserEmail(asCaller(adminId), targetId, { email: "admin@example.com" })
        .pipe(Effect.flip);
      assert.strictEqual(taken._tag, "AdminEmailAlreadyExists");
      assert.strictEqual((yield* mailer.sent).length, 0);
    }).pipe(Effect.provide(buildLayer(manageAll))),
  );

  it.effect("a link builder puts the confirmation URL in the mail", () =>
    Effect.gen(function* () {
      const { adminId, targetId } = yield* seed;
      const admin = yield* AdminAccounts.AdminAccounts;
      const mailer = yield* Mailer.Mailer;
      yield* admin.setUserEmail(asCaller(adminId), targetId, { email: "new@example.com" });
      const mail = (yield* mailer.sent)[0];
      assert.match(
        String(mail?.data?.["url"]),
        /^https:\/\/app\.example\/confirm-email#change-email:/,
      );
    }).pipe(
      Effect.provide(
        buildLayer({
          ...manageAll,
          links: { changeEmail: (token) => `https://app.example/confirm-email#${token}` },
        }),
      ),
    ),
  );

  it.effect(
    "a delivery failure is the typed AdminEmailDeliveryFailed and no event is published",
    () =>
      Effect.gen(function* () {
        const { adminId, targetId } = yield* seed;
        const admin = yield* AdminAccounts.AdminAccounts;
        const seen = yield* collectEvents;
        const failure = yield* admin
          .setUserEmail(asCaller(adminId), targetId, { email: "new@example.com" })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "AdminEmailDeliveryFailed");
        yield* TestClock.adjust(Duration.millis(10));
        assert.isFalse(
          (yield* Ref.get(seen)).some((e) => e._tag === "auth.admin.userEmailChangeRequested"),
        );
      }).pipe(Effect.scoped, Effect.provide(buildLayer(manageAll, { mailer: failingMailer }))),
  );

  it.effect("a user with no email identity has no address to replace", () =>
    Effect.gen(function* () {
      const { adminId, users } = yield* seed;
      const admin = yield* AdminAccounts.AdminAccounts;
      const guest = yield* users.create({ identity: { _tag: "Anonymous" }, name: "Guest" });
      const failure = yield* admin
        .setUserEmail(asCaller(adminId), guest.id, { email: "new@example.com" })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "AdminNoEmailIdentity");
    }).pipe(Effect.provide(buildLayer(manageAll))),
  );
});

describe("AdminAccounts: setUserPassword (BAM-005)", () => {
  const newPassword = Redacted.make("a brand new strong password");

  /** The stored hash of a user's password credential. */
  const storedHash = (accounts: Accounts.AccountsShape, userId: Users.UserId) =>
    Effect.gen(function* () {
      const account = Option.getOrThrow(
        yield* accounts.findByProviderSubject(Accounts.PASSWORD_PROVIDER_ID, userId),
      );
      return Redacted.value(Option.getOrThrow(yield* accounts.findCredentialHash(account.id)));
    });

  it.effect(
    "hashes through the port, replaces the credential, revokes every session and audits both events",
    () =>
      Effect.gen(function* () {
        const { adminId, targetId, accounts, hasher, oldPassword } = yield* seed;
        const admin = yield* AdminAccounts.AdminAccounts;
        const sessions = yield* Sessions.Sessions;
        const seen = yield* collectEvents;
        const first = yield* sessions.issue({ userId: targetId });
        const second = yield* sessions.issue({ userId: targetId });

        yield* admin.setUserPassword(asCaller(adminId), targetId, { password: newPassword });

        const stored = yield* storedHash(accounts, targetId);
        assert.isTrue(yield* hasher.verify(newPassword, stored));
        assert.isFalse(yield* hasher.verify(oldPassword, stored));
        for (const issued of [first, second]) {
          const failure = yield* sessions.verify(issued.token).pipe(Effect.flip);
          assert.strictEqual(failure._tag, "Sessions/NotFound");
        }
        yield* TestClock.adjust(Duration.millis(10));
        const events = yield* Ref.get(seen);
        assert.isTrue(
          events.some((e) => e._tag === "auth.password.changed" && e.userId === targetId),
        );
        assert.isTrue(
          events.some(
            (e) =>
              e._tag === "auth.admin.userPasswordSet" &&
              e.adminUserId === adminId &&
              e.userId === targetId,
          ),
        );
        // No event carries the password.
        assert.notInclude(JSON.stringify(events), Redacted.value(newPassword));
      }).pipe(Effect.scoped, Effect.provide(buildLayer(manageAll))),
  );

  it.effect("creates the password credential of a user who had none", () =>
    Effect.gen(function* () {
      const { adminId, users, accounts, hasher } = yield* seed;
      const admin = yield* AdminAccounts.AdminAccounts;
      const oauthOnly = yield* users.create({
        identity: { _tag: "Email", email: "oauth@example.com" },
        name: "OAuth only",
      });
      yield* admin.setUserPassword(asCaller(adminId), oauthOnly.id, { password: newPassword });
      assert.isTrue(yield* hasher.verify(newPassword, yield* storedHash(accounts, oauthOnly.id)));
    }).pipe(Effect.provide(buildLayer(manageAll))),
  );

  it.effect("a password violating the policy is refused with its hints, and nothing changes", () =>
    Effect.gen(function* () {
      const { adminId, targetId, accounts, hasher, oldPassword } = yield* seed;
      const admin = yield* AdminAccounts.AdminAccounts;
      const failure = yield* admin
        .setUserPassword(asCaller(adminId), targetId, { password: Redacted.make("short") })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "AdminWeakPassword");
      if (failure._tag === "AdminWeakPassword") assert.isAbove(failure.hints.length, 0);
      assert.isTrue(yield* hasher.verify(oldPassword, yield* storedHash(accounts, targetId)));
    }).pipe(Effect.provide(buildLayer(manageAll))),
  );

  it.effect("a host policy replaces the default", () =>
    Effect.gen(function* () {
      const { adminId, targetId } = yield* seed;
      const admin = yield* AdminAccounts.AdminAccounts;
      const failure = yield* admin
        .setUserPassword(asCaller(adminId), targetId, { password: newPassword })
        .pipe(Effect.flip);
      assert.deepStrictEqual(failure._tag === "AdminWeakPassword" ? failure.hints : [], [
        "no passphrases here",
      ]);
    }).pipe(
      Effect.provide(
        buildLayer({ ...manageAll, passwordPolicy: () => Effect.succeed(["no passphrases here"]) }),
      ),
    ),
  );

  it.effect("an administrator cannot set their own password through the admin surface", () =>
    Effect.gen(function* () {
      const { adminId } = yield* seed;
      const admin = yield* AdminAccounts.AdminAccounts;
      const failure = yield* admin
        .setUserPassword(asCaller(adminId), adminId, { password: newPassword })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "AdminSelfActionRefused");
    }).pipe(Effect.provide(buildLayer(manageAll))),
  );
});

describe("AdminAccounts: setUserPassword consults BeforeCredentialReset (ARF-005)", () => {
  it.effect(
    "an admin cannot replace the password of an account a second factor protects: HookAborted, nothing written, sessions kept",
    () =>
      Effect.gen(function* () {
        const { adminId, targetId, accounts, hasher, oldPassword } = yield* seed;
        const admin = yield* AdminAccounts.AdminAccounts;
        const sessions = yield* Sessions.Sessions;
        const live = yield* sessions.issue({ userId: targetId });

        const failure = yield* admin
          .setUserPassword(asCaller(adminId), targetId, {
            password: Redacted.make("a brand new strong password"),
          })
          .pipe(Effect.flip);

        assert.strictEqual(failure._tag, "HookAborted");
        if (failure._tag === "HookAborted") {
          assert.strictEqual(failure.code, "TWO_FACTOR_REQUIRED");
        }
        const account = Option.getOrThrow(
          yield* accounts.findByProviderSubject(Accounts.PASSWORD_PROVIDER_ID, targetId),
        );
        const stored = Redacted.value(
          Option.getOrThrow(yield* accounts.findCredentialHash(account.id)),
        );
        assert.isTrue(yield* hasher.verify(oldPassword, stored));
        yield* sessions.verify(live.token);
      }).pipe(Effect.provide(buildLayer(manageAll, { resetVeto: true }))),
  );
});
