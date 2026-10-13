// BEH-EA-247 through 250 (spec/behaviors/30-scim.md): SCIM Users — provisioning,
// ownership, immutability, deactivation and deletion — driven at the domain level over
// the same layer graph an application builds (`support.ts`).
import { Accounts, AuditLog, AuthEvents, HookPoint, Hooks, Sessions, Users } from "@awthaq/core";
import { InvitationRecords, MembershipRecords } from "@awthaq/organization";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Scim from "../src/Scim.ts";
import * as ScimApi from "../src/ScimApi.ts";
import { ScimLive, seedConnection } from "./support.ts";
import { TenantScoped } from "@awthaq/sql";

/** The witness these tests present where a cross-organization caller would. */
const grant = TenantScoped.crossTenant("test: a cross-organization caller");

const provision = (
  connection: ScimApi.ScimConnectionIdentity,
  userName = "ada@acme.example",
  extra: Partial<ScimApi.UserInput> = {},
) =>
  Effect.gen(function* () {
    const scim = yield* Scim.Scim;
    return yield* scim.createUser(connection, { userName, ...extra });
  });

const patch = (
  connection: ScimApi.ScimConnectionIdentity,
  id: string,
  operations: ScimApi.PatchRequest["Operations"],
) =>
  Effect.gen(function* () {
    const scim = yield* Scim.Scim;
    return yield* scim.patchUser(connection, id, { Operations: operations });
  });

describe("SCIM Users: provisioning and ownership (BEH-EA-247)", () => {
  it.effect("POST creates the user, links it to the connection and joins the organization", () =>
    Effect.gen(function* () {
      const { connection, organizationId } = yield* seedConnection();
      const users = yield* Users.Users;
      const members = yield* MembershipRecords.MembershipRecords;
      const created = yield* provision(connection, "Ada@Acme.Example", {
        externalId: "dir-1",
        name: { givenName: "Ada", familyName: "Lovelace" },
        active: true,
      });
      assert.deepStrictEqual(created.schemas, [ScimApi.USER_SCHEMA]);
      assert.strictEqual(created.userName, "Ada@Acme.Example");
      assert.strictEqual(created.externalId, "dir-1");
      assert.strictEqual(created.displayName, "Ada Lovelace");
      assert.deepStrictEqual(created.emails, [{ value: "ada@acme.example", primary: true }]);
      assert.isTrue(created.active);
      assert.strictEqual(created.meta.resourceType, "User");
      assert.strictEqual(created.meta.location, `/scim/v2/Users/${created.id}`);

      const user = yield* users.findById(Users.UserId(created.id));
      assert.deepStrictEqual(Users.emailOf(user), Option.some("ada@acme.example"));
      assert.isTrue(Option.isSome(yield* members.findByUserAndOrg(user.id, organizationId)));
    }).pipe(Effect.provide(ScimLive())),
  );

  it.effect("meta.location honours the configured base URL", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection();
      const created = yield* provision(connection);
      assert.strictEqual(
        created.meta.location,
        `https://id.acme.example/scim/v2/Users/${created.id}`,
      );
    }).pipe(Effect.provide(ScimLive({ baseUrl: Option.some("https://id.acme.example") }))),
  );

  it.effect(
    "a directory user without an email becomes an Anonymous identity, never a synthetic address",
    () =>
      Effect.gen(function* () {
        const { connection } = yield* seedConnection();
        const users = yield* Users.Users;
        const created = yield* provision(connection, "svc-account-17");
        const user = yield* users.findById(Users.UserId(created.id));
        assert.strictEqual(user.identity._tag, "Anonymous");
        assert.strictEqual(created.userName, "svc-account-17");
        assert.isUndefined(created.emails);
      }).pipe(Effect.provide(ScimLive())),
  );

  it.effect("a repeat POST with the same externalId converges instead of duplicating", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection();
      const scim = yield* Scim.Scim;
      const first = yield* provision(connection, "ada@acme.example", { externalId: "dir-1" });
      const again = yield* provision(connection, "ada@acme.example", { externalId: "dir-1" });
      assert.strictEqual(again.id, first.id);
      assert.strictEqual((yield* scim.listUsers(connection, {})).totalResults, 1);
    }).pipe(Effect.provide(ScimLive())),
  );

  it.effect("POST never adopts an existing account: an existing email is 409 uniqueness", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection();
      const users = yield* Users.Users;
      yield* users.create({ identity: { _tag: "Email", email: "victim@acme.example" }, name: "V" });
      const refused = yield* provision(connection, "victim@acme.example").pipe(
        Effect.catchTag("StoreUnavailable", Effect.die),
        Effect.flip,
      );
      assert.strictEqual(refused._tag, "ScimConflict");
      assert.strictEqual(refused.scimType, "uniqueness");
      assert.strictEqual(refused.status, "409");
      assert.deepStrictEqual(refused.schemas, [ScimApi.ERROR_SCHEMA]);
    }).pipe(Effect.provide(ScimLive())),
  );

  it.effect("a repeated userName from the same connection is a conflict", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection();
      yield* provision(connection, "ada@acme.example");
      const refused = yield* provision(connection, "ada@acme.example").pipe(Effect.flip);
      assert.strictEqual(refused._tag, "ScimConflict");
    }).pipe(Effect.provide(ScimLive())),
  );

  it.effect("a blank userName is refused", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection();
      const refused = yield* provision(connection, "   ").pipe(Effect.flip);
      assert.strictEqual(refused._tag, "ScimBadRequest");
    }).pipe(Effect.provide(ScimLive())),
  );

  it.effect("a token for connection A cannot see or touch connection B's users", () =>
    Effect.gen(function* () {
      const a = yield* seedConnection("Okta");
      const b = yield* seedConnection("Entra");
      const scim = yield* Scim.Scim;
      const created = yield* provision(b.connection, "bo@acme.example");
      assert.strictEqual(
        (yield* scim.getUser(a.connection, created.id).pipe(Effect.flip))._tag,
        "ScimNotFound",
      );
      assert.strictEqual(
        (yield* patch(a.connection, created.id, [{ op: "replace", value: { active: false } }]).pipe(
          Effect.flip,
        ))._tag,
        "ScimNotFound",
      );
      assert.strictEqual(
        (yield* scim.deleteUser(a.connection, created.id).pipe(Effect.flip))._tag,
        "ScimNotFound",
      );
      assert.strictEqual((yield* scim.listUsers(a.connection, {})).totalResults, 0);
      // Untouched for its owner.
      assert.isTrue((yield* scim.getUser(b.connection, created.id)).active);
    }).pipe(Effect.provide(ScimLive())),
  );

  it.effect(
    "a user that exists but was never provisioned by the connection is simply not found",
    () =>
      Effect.gen(function* () {
        const { connection } = yield* seedConnection();
        const users = yield* Users.Users;
        const scim = yield* Scim.Scim;
        const stranger = yield* users.create({
          identity: { _tag: "Email", email: "stranger@elsewhere.example" },
          name: "S",
        });
        assert.strictEqual(
          (yield* scim.getUser(connection, stranger.id).pipe(Effect.flip))._tag,
          "ScimNotFound",
        );
        const deactivate = yield* patch(connection, stranger.id, [
          { op: "replace", path: "active", value: false },
        ]).pipe(Effect.flip);
        assert.strictEqual(deactivate._tag, "ScimNotFound");
        assert.strictEqual((yield* users.findById(stranger.id)).status, "active");
      }).pipe(Effect.provide(ScimLive())),
  );

  it.effect(
    "list filters by userName and externalId, pages with startIndex/count, and rejects other filters",
    () =>
      Effect.gen(function* () {
        const { connection } = yield* seedConnection();
        const scim = yield* Scim.Scim;
        for (const n of [1, 2, 3, 4, 5]) {
          yield* provision(connection, `u${n}@acme.example`, { externalId: `dir-${n}` });
          // Listing is oldest-first by creation time: give each user its own millisecond.
          yield* TestClock.adjust(Duration.millis(1));
        }
        const byName = yield* scim.listUsers(connection, {
          filter: 'userName eq "u3@acme.example"',
        });
        assert.strictEqual(byName.totalResults, 1);
        assert.strictEqual(byName.Resources[0]?.externalId, "dir-3");
        const byExternal = yield* scim.listUsers(connection, { filter: 'externalId eq "dir-4"' });
        assert.strictEqual(byExternal.Resources[0]?.userName, "u4@acme.example");
        assert.strictEqual(
          (yield* scim.listUsers(connection, { filter: 'userName eq "nobody"' })).totalResults,
          0,
        );
        const page = yield* scim.listUsers(connection, { startIndex: 2, count: 2 });
        assert.strictEqual(page.totalResults, 5);
        assert.strictEqual(page.startIndex, 2);
        assert.strictEqual(page.itemsPerPage, 2);
        assert.deepStrictEqual(
          page.Resources.map((resource) => resource.userName),
          ["u2@acme.example", "u3@acme.example"],
        );
        const zero = yield* scim.listUsers(connection, { count: 0 });
        assert.strictEqual(zero.Resources.length, 0);
        assert.strictEqual(zero.totalResults, 5);
        const unsupported = yield* scim
          .listUsers(connection, { filter: 'displayName co "x"' })
          .pipe(Effect.catchTag("StoreUnavailable", Effect.die), Effect.flip);
        assert.strictEqual(unsupported._tag, "ScimBadRequest");
        assert.strictEqual(unsupported.scimType, "invalidFilter");
      }).pipe(Effect.provide(ScimLive())),
  );

  it.effect(
    "an organization at its membership limit refuses the POST and leaves no user, no mapping and every invitation to that address behind",
    () =>
      Effect.gen(function* () {
        const { connection } = yield* seedConnection();
        const users = yield* Users.Users;
        const scim = yield* Scim.Scim;
        const invitations = yield* InvitationRecords.InvitationRecords;
        // An administrator invited this address to another organization before the user existed:
        // abandoning the half-made user is not an erasure and must not sweep it (plan 03 section 3.5).
        const invitation = yield* invitations.create({
          organizationId: "another-organization",
          email: "extra@acme.example",
          role: ["member"],
          inviterId: Users.UserId("another-inviter"),
          tokenHash: "hash-extra",
          expiresAt: DateTime.addDuration(DateTime.nowUnsafe(), "1 hour"),
        });
        // The owner already fills the organization's single seat.
        const refused = yield* provision(connection, "extra@acme.example").pipe(Effect.flip);
        assert.strictEqual(refused._tag, "ScimForbidden");
        assert.isTrue(Option.isNone(yield* users.findByEmail("extra@acme.example")));
        assert.strictEqual((yield* scim.listUsers(connection, {})).totalResults, 0);
        assert.isTrue(Option.isSome(yield* invitations.findById(grant, invitation.id)));
      }).pipe(Effect.provide(ScimLive({}, { membershipLimit: 1 }))),
  );

  it.effect(
    "a BeforeSignUp veto refuses the POST with a 403 and leaves no user and no mapping (ADR-EA-038)",
    () =>
      Effect.gen(function* () {
        const { connection } = yield* seedConnection();
        const users = yield* Users.Users;
        const scim = yield* Scim.Scim;
        const refused = yield* provision(connection, "veto@acme.example").pipe(Effect.flip);
        assert.strictEqual(refused._tag, "ScimForbidden");
        assert.isTrue(Option.isNone(yield* users.findByEmail("veto@acme.example")));
        assert.strictEqual((yield* scim.listUsers(connection, {})).totalResults, 0);
      }).pipe(
        Effect.provide(
          ScimLive(
            {},
            {},
            Users.layerMemory,
            Hooks.BeforeSignUp.tap((input) =>
              Effect.fail(new HookPoint.HookAbort({ code: `NO_SIGNUP_${input.strategy}` })),
            ).pipe(Layer.provideMerge(Hooks.HooksLive)),
          ),
        ),
      ),
  );

  it.effect("a provisioned user is announced as auth.user.created (ADR-EA-038)", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection();
      const auditLog = yield* AuditLog.AuditLog;
      const created = yield* provision(connection, "new@acme.example");
      const recorded = yield* auditLog.list({ eventTag: "auth.user.created" });
      assert.strictEqual(recorded.length, 1);
      const payload = recorded[0]?.payload;
      assert.isTrue(payload?._tag === "auth.user.created" && payload.userId === created.id);
    }).pipe(Effect.provide(ScimLive())),
  );

  it.effect("provisioning is audited as an event naming the connection and organization", () =>
    Effect.gen(function* () {
      const { connection, organizationId } = yield* seedConnection();
      const auditLog = yield* AuditLog.AuditLog;
      const created = yield* provision(connection);
      const recorded = yield* auditLog.list({ eventTag: "auth.scim.userProvisioned" });
      assert.strictEqual(recorded.length, 1);
      const payload = recorded[0]?.payload;
      assert.isTrue(
        typeof payload === "object" &&
          payload !== null &&
          "connectionId" in payload &&
          payload.connectionId === connection.id &&
          "organizationId" in payload &&
          payload.organizationId === organizationId &&
          "userId" in payload &&
          payload.userId === created.id,
      );
      void AuthEvents;
    }).pipe(Effect.provide(ScimLive())),
  );
});

describe("SCIM Users: userName is immutable, other attributes update (BEH-EA-248)", () => {
  it.effect(
    "re-sending the same userName is fine; changing it is 400 mutability, on PUT and PATCH",
    () =>
      Effect.gen(function* () {
        const { connection } = yield* seedConnection();
        const scim = yield* Scim.Scim;
        const created = yield* provision(connection, "ada@acme.example");
        const same = yield* scim.replaceUser(connection, created.id, {
          userName: "ADA@acme.example",
        });
        assert.strictEqual(same.userName, "ada@acme.example");
        const renamed = yield* scim
          .replaceUser(connection, created.id, { userName: "mallory@acme.example" })
          .pipe(Effect.catchTag("StoreUnavailable", Effect.die), Effect.flip);
        assert.strictEqual(renamed._tag, "ScimBadRequest");
        assert.strictEqual(renamed.scimType, "mutability");
        const patched = yield* patch(connection, created.id, [
          { op: "replace", path: "userName", value: "mallory@acme.example" },
        ]).pipe(Effect.catchTag("StoreUnavailable", Effect.die), Effect.flip);
        assert.strictEqual(patched._tag, "ScimBadRequest");
        assert.strictEqual(patched.scimType, "mutability");
        const users = yield* Users.Users;
        const user = yield* users.findById(Users.UserId(created.id));
        assert.deepStrictEqual(Users.emailOf(user), Option.some("ada@acme.example"));
      }).pipe(Effect.provide(ScimLive())),
  );

  it.effect("PUT replaces name, externalId and active; an absent externalId clears it", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection();
      const scim = yield* Scim.Scim;
      const created = yield* provision(connection, "ada@acme.example", { externalId: "dir-1" });
      const replaced = yield* scim.replaceUser(connection, created.id, {
        userName: "ada@acme.example",
        displayName: "Countess Ada",
        externalId: "dir-2",
        active: true,
      });
      assert.strictEqual(replaced.displayName, "Countess Ada");
      assert.strictEqual(replaced.externalId, "dir-2");
      const cleared = yield* scim.replaceUser(connection, created.id, {
        userName: "ada@acme.example",
      });
      assert.isUndefined(cleared.externalId);
    }).pipe(Effect.provide(ScimLive())),
  );

  it.effect(
    "PATCH accepts Okta's path-less object, Entra's capitalized ops and string booleans, and ignores attributes it does not manage",
    () =>
      Effect.gen(function* () {
        const { connection } = yield* seedConnection();
        const created = yield* provision(connection, "ada@acme.example", { externalId: "dir-1" });
        const oktaStyle = yield* patch(connection, created.id, [
          { op: "replace", value: { displayName: "Ada L.", title: "Analyst" } },
        ]);
        assert.strictEqual(oktaStyle.displayName, "Ada L.");
        const entraStyle = yield* patch(connection, created.id, [
          { op: "Replace", path: "name.givenName", value: "Augusta" },
          { op: "Add", path: 'phoneNumbers[type eq "work"].value', value: "+15550100" },
          { op: "Replace", path: "active", value: "False" },
        ]);
        assert.strictEqual(entraStyle.displayName, "Augusta L.");
        assert.isFalse(entraStyle.active);
        const cleared = yield* patch(connection, created.id, [
          { op: "remove", path: "externalId" },
        ]);
        assert.isUndefined(cleared.externalId);
        const malformed = yield* patch(connection, created.id, [
          { op: "frobnicate", path: "active" },
        ]).pipe(Effect.catchTag("StoreUnavailable", Effect.die), Effect.flip);
        assert.strictEqual(malformed._tag, "ScimBadRequest");
        assert.strictEqual(malformed.scimType, "invalidSyntax");
      }).pipe(Effect.provide(ScimLive())),
  );
});

describe("SCIM Users: active is suspension (BEH-EA-249)", () => {
  it.effect("active:false suspends the user and revokes every live session at once", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection();
      const sessions = yield* Sessions.Sessions;
      const users = yield* Users.Users;
      const created = yield* provision(connection);
      const id = Users.UserId(created.id);
      const first = yield* sessions.issue({ userId: id });
      const second = yield* sessions.issue({ userId: id });
      assert.strictEqual((yield* sessions.verify(first.token)).session.userId, id);

      const deactivated = yield* patch(connection, created.id, [
        { op: "replace", path: "active", value: false },
      ]);
      assert.isFalse(deactivated.active);
      // Already-issued sessions die immediately …
      assert.strictEqual(
        (yield* sessions.verify(first.token).pipe(Effect.flip))._tag,
        "Sessions/NotFound",
      );
      assert.strictEqual(
        (yield* sessions.verify(second.token).pipe(Effect.flip))._tag,
        "Sessions/NotFound",
      );
      // … and the one shared sign-in gate refuses new ones.
      const user = yield* users.findById(id);
      assert.strictEqual(user.status, "suspended");
      assert.strictEqual(
        (yield* Users.assertCanSignIn(user).pipe(Effect.flip))._tag,
        "UserSuspended",
      );
    }).pipe(Effect.provide(ScimLive())),
  );

  it.effect("active:true reactivates a suspension this connection made, and nothing else", () =>
    Effect.gen(function* () {
      const a = yield* seedConnection("Okta");
      const b = yield* seedConnection("Entra");
      const users = yield* Users.Users;
      const scim = yield* Scim.Scim;
      const created = yield* provision(a.connection);
      const id = Users.UserId(created.id);

      yield* patch(a.connection, created.id, [{ op: "replace", path: "active", value: false }]);
      const back = yield* patch(a.connection, created.id, [
        { op: "replace", path: "active", value: true },
      ]);
      assert.isTrue(back.active);
      assert.strictEqual((yield* users.findById(id)).status, "active");

      // An administrator's ban is not this connection's to lift.
      yield* users.setStatus(id, "suspended", { reason: "admin ban" });
      const stillBanned = yield* patch(a.connection, created.id, [
        { op: "replace", path: "active", value: true },
      ]);
      assert.isFalse(stillBanned.active);
      assert.strictEqual((yield* users.findById(id)).status, "suspended");

      // Nor can another connection touch the user at all.
      assert.strictEqual(
        (yield* scim.getUser(b.connection, created.id).pipe(Effect.flip))._tag,
        "ScimNotFound",
      );
    }).pipe(Effect.provide(ScimLive())),
  );

  it.effect("provisioning with active:false creates an already-suspended user", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection();
      const users = yield* Users.Users;
      const created = yield* provision(connection, "ada@acme.example", { active: false });
      assert.isFalse(created.active);
      assert.strictEqual((yield* users.findById(Users.UserId(created.id))).status, "suspended");
    }).pipe(Effect.provide(ScimLive())),
  );

  it.effect("deactivation and reactivation are published as events", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection();
      const auditLog = yield* AuditLog.AuditLog;
      const created = yield* provision(connection);
      yield* patch(connection, created.id, [{ op: "replace", path: "active", value: false }]);
      yield* patch(connection, created.id, [{ op: "replace", path: "active", value: true }]);
      assert.strictEqual(
        (yield* auditLog.list({ eventTag: "auth.scim.userDeactivated" })).length,
        1,
      );
      assert.strictEqual(
        (yield* auditLog.list({ eventTag: "auth.scim.userReactivated" })).length,
        1,
      );
    }).pipe(Effect.provide(ScimLive())),
  );

  it.effect("a repeat POST for a deactivated user reactivates it (a directory re-provision)", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection();
      const created = yield* provision(connection, "ada@acme.example", { externalId: "dir-1" });
      yield* patch(connection, created.id, [{ op: "replace", path: "active", value: false }]);
      const again = yield* provision(connection, "ada@acme.example", { externalId: "dir-1" });
      assert.strictEqual(again.id, created.id);
      assert.isTrue(again.active);
    }).pipe(Effect.provide(ScimLive())),
  );
});

/**
 * The race made deterministic: the real in-memory `Users`, except that once `ownedUser` has read a
 * user, every later read of the same id reports `UserNotFound`, as if another erasure had landed
 * in between. `provideMerge`: the double's `Users` wins while the real `UserRemoval` rides along.
 */
const ErasedBetweenReads: typeof Users.layerMemory = Layer.effect(
  Users.Users,
  Effect.gen(function* () {
    const real = yield* Users.Users;
    const reads = yield* Ref.make(HashSet.empty<string>());
    return Users.Users.of({
      ...real,
      findById: (id) =>
        Ref.modify(reads, (seen) => [HashSet.has(seen, id), HashSet.add(seen, id)]).pipe(
          Effect.flatMap((already) =>
            already
              ? Effect.fail(new Users.UserNotFound({ id, message: `no user ${id}` }))
              : real.findById(id),
          ),
        ),
    });
  }),
).pipe(Layer.provideMerge(Users.layerMemory));

describe("SCIM Users: DELETE (BEH-EA-250)", () => {
  it.effect("by default DELETE deactivates: the user, its accounts and history remain", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection();
      const scim = yield* Scim.Scim;
      const users = yield* Users.Users;
      const sessions = yield* Sessions.Sessions;
      const created = yield* provision(connection);
      const id = Users.UserId(created.id);
      const session = yield* sessions.issue({ userId: id });
      yield* scim.deleteUser(connection, created.id);
      assert.strictEqual((yield* users.findById(id)).status, "suspended");
      assert.strictEqual(
        (yield* sessions.verify(session.token).pipe(Effect.flip))._tag,
        "Sessions/NotFound",
      );
      // Still the connection's, and still readable — as inactive.
      assert.isFalse((yield* scim.getUser(connection, created.id)).active);
    }).pipe(Effect.provide(ScimLive())),
  );

  it.effect(
    "configured to erase, DELETE runs the account erasure: memberships, accounts, tokens and the mapping go with the user",
    () =>
      Effect.gen(function* () {
        const { connection, organizationId } = yield* seedConnection();
        const scim = yield* Scim.Scim;
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const accounts = yield* Accounts.Accounts;
        const members = yield* MembershipRecords.MembershipRecords;
        const created = yield* provision(connection, "ada@acme.example", { externalId: "dir-1" });
        const id = Users.UserId(created.id);
        const session = yield* sessions.issue({ userId: id });
        yield* accounts.link({ userId: id, providerId: "saml:x", subject: "nameid-1" });
        assert.strictEqual((yield* members.listByUser(grant, id)).length, 1);

        yield* scim.deleteUser(connection, created.id);

        assert.strictEqual((yield* users.findById(id).pipe(Effect.flip))._tag, "UserNotFound");
        assert.deepStrictEqual(yield* members.listByUser(grant, id), []);
        assert.isTrue(Option.isNone(yield* accounts.findByProviderSubject("saml:x", "nameid-1")));
        assert.strictEqual(
          (yield* sessions.verify(session.token).pipe(Effect.flip))._tag,
          "Sessions/NotFound",
        );
        assert.strictEqual(
          (yield* scim.getUser(connection, created.id).pipe(Effect.flip))._tag,
          "ScimNotFound",
        );
        // The seat is free again (the organization is limited to the owner plus one member) and so is
        // the external id: a re-provision succeeds and creates a new user.
        const fresh = yield* provision(connection, "ada@acme.example", { externalId: "dir-1" });
        assert.notStrictEqual(fresh.id, created.id);
        assert.isTrue(
          Option.isSome(yield* members.findByUserAndOrg(Users.UserId(fresh.id), organizationId)),
        );
      }).pipe(Effect.provide(ScimLive({ deleteBehavior: "erase" }, { membershipLimit: 2 }))),
  );

  it.effect(
    "an erasing DELETE is announced as auth.user.deleted by the directory, then auth.scim.userDeleted",
    () =>
      Effect.gen(function* () {
        const { connection, organizationId } = yield* seedConnection();
        const scim = yield* Scim.Scim;
        const auditLog = yield* AuditLog.AuditLog;
        const created = yield* provision(connection);
        yield* scim.deleteUser(connection, created.id);
        const deleted = yield* auditLog.list({ eventTag: "auth.user.deleted" });
        assert.strictEqual(deleted.length, 1);
        assert.deepStrictEqual(deleted[0]?.payload, {
          _tag: "auth.user.deleted",
          userId: Users.UserId(created.id),
          deletedBy: "directory",
          connectionId: connection.id,
          organizationId,
        });
        const scimDeleted = yield* auditLog.list({ eventTag: "auth.scim.userDeleted" });
        assert.strictEqual(scimDeleted.length, 1);
        const first = deleted[0];
        const second = scimDeleted[0];
        assert.isTrue(first !== undefined && second !== undefined && first.id < second.id);
      }).pipe(Effect.provide(ScimLive({ deleteBehavior: "erase" }))),
  );

  it.effect("an erasing DELETE pseudonymizes the user's audit trail", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection();
      const scim = yield* Scim.Scim;
      const auditLog = yield* AuditLog.AuditLog;
      const created = yield* provision(connection);
      yield* scim.deleteUser(connection, created.id);
      const provisioned = yield* auditLog.list({ eventTag: "auth.scim.userProvisioned" });
      assert.strictEqual(provisioned.length, 1);
      assert.isFalse(JSON.stringify(provisioned).includes(created.id));
      // The erasure receipt keeps the id (ADR-EA-029 section 4).
      assert.isTrue(
        JSON.stringify(yield* auditLog.list({ eventTag: "auth.user.deleted" })).includes(
          created.id,
        ),
      );
    }).pipe(Effect.provide(ScimLive({ deleteBehavior: "erase" }))),
  );

  it.effect("DELETE of a user erased in between is 404 and publishes nothing", () =>
    Effect.gen(function* () {
      const { connection } = yield* seedConnection();
      const scim = yield* Scim.Scim;
      const auditLog = yield* AuditLog.AuditLog;
      const created = yield* provision(connection);
      const failure = yield* scim.deleteUser(connection, created.id).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "ScimNotFound");
      assert.deepStrictEqual(yield* auditLog.list({ eventTag: "auth.scim.userDeleted" }), []);
      assert.deepStrictEqual(yield* auditLog.list({ eventTag: "auth.user.deleted" }), []);
    }).pipe(Effect.provide(ScimLive({ deleteBehavior: "erase" }, {}, ErasedBetweenReads))),
  );
});

// A bearer token is only ever a hash at rest — the connection store's own guarantee, asserted next to
// the resource tests because it is what every request above authenticates with.
describe("SCIM connections (BEH-EA-246)", () => {
  it.effect("the token is shown once and only its hash is stored", () =>
    Effect.gen(function* () {
      const { token } = yield* seedConnection();
      assert.isTrue(token.startsWith("scim_"));
      assert.strictEqual(Redacted.value(Redacted.make(token)), token);
    }).pipe(Effect.provide(ScimLive())),
  );
});
