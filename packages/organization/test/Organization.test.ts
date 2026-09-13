// spec.md. Domain-level tests (no HTTP layer here — see `AuthHttp.test.ts`
// for the wire-level equivalent): real `AuthEvents`/`OrganizationRecords`/
// `MembershipRecords`, a hand-built `Api.UserPrincipal` the same way
// `@effect-auth/admin`'s own `Admin.test.ts` does.
import { Api } from "@effect-auth/api";
import { AuthEvents, Sessions, Users } from "@effect-auth/core";
import { Mailer } from "@effect-auth/ports";
import { Authentication } from "@effect-auth/server";
import { NodeCrypto } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import {
  ActiveContextRecords,
  InvitationRecords,
  MembershipRecords,
  Organization,
  OrganizationHooks,
  OrganizationRecords,
  OrgRoleRecords,
  TeamRecords,
} from "../src/index.ts";

const CoreLive = Layer.mergeAll(Sessions.layerMemory, AuthEvents.layer, Users.layerMemory).pipe(
  Layer.provideMerge(NodeCrypto.layer),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const buildLayer = (configOverrides: Partial<Organization.OrganizationConfigShape> = {}) =>
  Organization.Organization.layer.pipe(
    Layer.provide(Organization.config(configOverrides)),
    Layer.provide(AuthenticationLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(OrganizationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(MembershipRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(ActiveContextRecords.layerMemory),
    Layer.provideMerge(InvitationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(OrgRoleRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(TeamRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(Mailer.layerMemory),
    Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
  );

const asCaller = (id: string): Api.UserPrincipal =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id }),
    sessionId: `${id}-session`,
  });

describe("Organization", () => {
  it.effect("create makes the creator the owner automatically", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const caller = asCaller("user-1");
      const record = yield* organization.create({ caller, name: "Acme", slug: "acme" });

      const membership = yield* organization.listMembers(caller, record.id);
      assert.strictEqual(membership.length, 1);
      assert.deepStrictEqual(membership[0]?.role, ["owner"]);
      assert.strictEqual(membership[0]?.userId, Users.UserId("user-1"));
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("create honors a custom creatorRole", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const caller = asCaller("user-1");
      const record = yield* organization.create({ caller, name: "Acme", slug: "acme" });
      const membership = yield* organization.listMembers(caller, record.id);
      assert.deepStrictEqual(membership[0]?.role, ["admin"]);
    }).pipe(Effect.provide(buildLayer({ creatorRole: "admin" }))),
  );

  it.effect("create rejects a slug collision", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const caller = asCaller("user-1");
      yield* organization.create({ caller, name: "Acme", slug: "acme" });
      const failure = yield* organization
        .create({ caller, name: "Acme 2", slug: "acme" })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "OrganizationSlugTaken");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("create is refused when allowUserToCreateOrganization denies", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const caller = asCaller("user-1");
      const failure = yield* organization
        .create({ caller, name: "Acme", slug: "acme" })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "OrganizationCreationNotAllowed");
    }).pipe(
      Effect.provide(buildLayer({ allowUserToCreateOrganization: () => Effect.succeed(false) })),
    ),
  );

  it.effect("create is refused once organizationLimit is reached", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const caller = asCaller("user-1");
      yield* organization.create({ caller, name: "Acme", slug: "acme" });
      const failure = yield* organization
        .create({ caller, name: "Second", slug: "second" })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "OrganizationLimitReached");
    }).pipe(Effect.provide(buildLayer({ organizationLimit: 1 }))),
  );

  it.effect('organizationLimit is still enforced when creatorRole is not "owner"', () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const caller = asCaller("user-1");
      yield* organization.create({ caller, name: "Acme", slug: "acme" });
      const failure = yield* organization
        .create({ caller, name: "Second", slug: "second" })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "OrganizationLimitReached");
    }).pipe(Effect.provide(buildLayer({ organizationLimit: 1, creatorRole: "admin" }))),
  );

  it.effect("checkSlug/list/get/getFull answer correctly", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const outsider = asCaller("outsider-1");

      assert.isTrue(yield* organization.checkSlug("acme"));
      const record = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      assert.isFalse(yield* organization.checkSlug("acme"));

      const ownerOrgs = yield* organization.list(owner);
      assert.strictEqual(ownerOrgs.length, 1);
      const outsiderOrgs = yield* organization.list(outsider);
      assert.strictEqual(outsiderOrgs.length, 0);

      const fetched = yield* organization.get(record.id);
      assert.strictEqual(fetched.slug, "acme");
      const notFound = yield* organization.get("does-not-exist").pipe(Effect.flip);
      assert.strictEqual(notFound._tag, "OrganizationNotFound");

      const full = yield* organization.getFull(owner, record.id);
      assert.strictEqual(full.organization.id, record.id);
      assert.strictEqual(full.members.length, 1);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("getFull/listMembers/listInvitationsForOrganization are denied to a non-member", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const outsider = asCaller("outsider-1");
      const record = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });

      const fullDenied = yield* organization.getFull(outsider, record.id).pipe(Effect.flip);
      assert.strictEqual(fullDenied._tag, "OrganizationPermissionDenied");

      const membersDenied = yield* organization.listMembers(outsider, record.id).pipe(Effect.flip);
      assert.strictEqual(membersDenied._tag, "OrganizationPermissionDenied");

      const invitationsDenied = yield* organization
        .listInvitationsForOrganization(outsider, record.id)
        .pipe(Effect.flip);
      assert.strictEqual(invitationsDenied._tag, "OrganizationPermissionDenied");

      // A real member (not just owner/admin) may still read all three.
      yield* organization.addMember({
        organizationId: record.id,
        userId: Users.UserId("outsider-1"),
        role: ["member"],
      });
      yield* organization.getFull(outsider, record.id);
      yield* organization.listMembers(outsider, record.id);
      yield* organization.listInvitationsForOrganization(outsider, record.id);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("update requires permission and rejects a slug collision", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const member = asCaller("member-1");
      const record = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      yield* organization.addMember({
        organizationId: record.id,
        userId: Users.UserId("member-1"),
        role: ["member"],
      });
      yield* organization.create({ caller: asCaller("owner-2"), name: "Globex", slug: "globex" });

      const denied = yield* organization.update(member, record.id, { name: "x" }).pipe(Effect.flip);
      assert.strictEqual(denied._tag, "OrganizationPermissionDenied");

      const updated = yield* organization.update(owner, record.id, { name: "Acme Inc" });
      assert.strictEqual(updated.name, "Acme Inc");

      const collision = yield* organization
        .update(owner, record.id, { slug: "globex" })
        .pipe(Effect.flip);
      assert.strictEqual(collision._tag, "OrganizationSlugTaken");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("delete requires permission, can be disabled, and cascades memberships", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const member = asCaller("member-1");
      const record = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      yield* organization.addMember({
        organizationId: record.id,
        userId: Users.UserId("member-1"),
        role: ["member"],
      });

      const denied = yield* organization.delete(member, record.id).pipe(Effect.flip);
      assert.strictEqual(denied._tag, "OrganizationPermissionDenied");

      yield* organization.delete(owner, record.id);
      const gone = yield* organization.get(record.id).pipe(Effect.flip);
      assert.strictEqual(gone._tag, "OrganizationNotFound");
      const noMembers = yield* organization.listMembers(owner, record.id).pipe(Effect.flip);
      assert.strictEqual(noMembers._tag, "OrganizationNotFound");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("delete cascades dynamic roles", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const record = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      yield* organization.createRole(owner, record.id, {
        role: "billing-admin",
        permission: { organization: ["update"] },
      });

      yield* organization.delete(owner, record.id);

      const noRoles = yield* organization.listRoles(owner, record.id).pipe(Effect.flip);
      assert.strictEqual(noRoles._tag, "OrganizationNotFound");
    }).pipe(
      Effect.provide(
        buildLayer({
          dynamicAccessControl: {
            enabled: true,
            maximumRolesPerOrganization: Number.POSITIVE_INFINITY,
          },
        }),
      ),
    ),
  );

  it.effect("delete answers OrganizationDeletionDisabled when configured off", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const record = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      const failure = yield* organization.delete(owner, record.id).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "OrganizationDeletionDisabled");
    }).pipe(Effect.provide(buildLayer({ disableOrganizationDeletion: true }))),
  );

  it.effect(
    "the owner invariant rejects removeMember, updateMemberRole, and leave for the last owner",
    () =>
      Effect.gen(function* () {
        const organization = yield* Organization.Organization;
        const owner = asCaller("owner-1");
        const record = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
        const ownerId = Users.UserId("owner-1");

        const removeFailure = yield* organization
          .removeMember(owner, record.id, ownerId)
          .pipe(Effect.flip);
        assert.strictEqual(removeFailure._tag, "OwnerInvariantViolation");

        const roleFailure = yield* organization
          .updateMemberRole(owner, record.id, ownerId, ["member"])
          .pipe(Effect.flip);
        assert.strictEqual(roleFailure._tag, "OwnerInvariantViolation");

        const leaveFailure = yield* organization.leave(owner, record.id).pipe(Effect.flip);
        assert.strictEqual(leaveFailure._tag, "OwnerInvariantViolation");
      }).pipe(Effect.provide(buildLayer())),
  );

  it.effect(
    "removeMember/updateMemberRole succeed once another owner exists, and require permission",
    () =>
      Effect.gen(function* () {
        const organization = yield* Organization.Organization;
        const owner = asCaller("owner-1");
        const member = asCaller("member-1");
        const record = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
        yield* organization.addMember({
          organizationId: record.id,
          userId: Users.UserId("owner-2"),
          role: ["owner"],
        });
        yield* organization.addMember({
          organizationId: record.id,
          userId: Users.UserId("member-1"),
          role: ["member"],
        });

        const denied = yield* organization
          .updateMemberRole(member, record.id, Users.UserId("owner-2"), ["member"])
          .pipe(Effect.flip);
        assert.strictEqual(denied._tag, "OrganizationPermissionDenied");

        const updated = yield* organization.updateMemberRole(
          owner,
          record.id,
          Users.UserId("owner-2"),
          ["member"],
        );
        assert.deepStrictEqual(updated.role, ["member"]);

        yield* organization.removeMember(owner, record.id, Users.UserId("member-1"));
        const members = yield* organization.listMembers(owner, record.id);
        assert.strictEqual(members.length, 2);
      }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("removeMember/updateMemberRole fail MembershipNotFound for a non-member", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const record = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      const notFound = yield* organization
        .removeMember(owner, record.id, Users.UserId("nobody"))
        .pipe(Effect.flip);
      assert.strictEqual(notFound._tag, "MembershipNotFound");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("leave succeeds for a non-owner without touching the owner invariant", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const member = asCaller("member-1");
      const record = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      yield* organization.addMember({
        organizationId: record.id,
        userId: Users.UserId("member-1"),
        role: ["member"],
      });
      yield* organization.leave(member, record.id);
      const members = yield* organization.listMembers(owner, record.id);
      assert.strictEqual(members.length, 1);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("addMember respects membershipLimit", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const record = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      const failure = yield* organization
        .addMember({
          organizationId: record.id,
          userId: Users.UserId("member-1"),
          role: ["member"],
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "MembershipLimitReached");
    }).pipe(Effect.provide(buildLayer({ membershipLimit: 1 }))),
  );

  it.effect(
    "getActiveMember/getActiveMemberRole answer NoActiveOrganization with no active org set",
    () =>
      Effect.gen(function* () {
        const organization = yield* Organization.Organization;
        const caller = asCaller("owner-1");
        const memberFailure = yield* organization.getActiveMember(caller).pipe(Effect.flip);
        assert.strictEqual(memberFailure._tag, "NoActiveOrganization");
        const roleFailure = yield* organization.getActiveMemberRole(caller).pipe(Effect.flip);
        assert.strictEqual(roleFailure._tag, "NoActiveOrganization");
      }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("setActive then getActiveMember/getActiveMemberRole resolve against it", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const caller = asCaller("owner-1");
      const record = yield* organization.create({ caller, name: "Acme", slug: "acme" });

      yield* organization.setActive(caller, record.id);
      const active = yield* organization.getActive(caller);
      assert.deepStrictEqual(active.activeOrganizationId, Option.some(record.id));

      const membership = yield* organization.getActiveMember(caller);
      assert.strictEqual(membership.organizationId, record.id);
      const role = yield* organization.getActiveMemberRole(caller);
      assert.deepStrictEqual(role, ["owner"]);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("setActive rejects an organization the caller isn't a member of", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const outsider = asCaller("outsider-1");
      const record = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });

      const failure = yield* organization.setActive(outsider, record.id).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "MembershipNotFound");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("setActive with null unsets the active organization", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const caller = asCaller("owner-1");
      const record = yield* organization.create({ caller, name: "Acme", slug: "acme" });
      yield* organization.setActive(caller, record.id);
      yield* organization.setActive(caller, null);
      const active = yield* organization.getActive(caller);
      assert.deepStrictEqual(active.activeOrganizationId, Option.none());
      const failure = yield* organization.getActiveMember(caller).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "NoActiveOrganization");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("invite sends an email via Mailer and creates a pending invitation", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const mailer = yield* Mailer.Mailer;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });

      const invitation = yield* organization.invite(owner, org.id, {
        email: "invitee@example.com",
        role: ["member"],
      });
      assert.strictEqual(invitation.status, "pending");

      const sent = yield* mailer.sent;
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0]?.to, "invitee@example.com");
      assert.strictEqual(sent[0]?.template, "organization-invite");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("full invite -> accept round trip creates a real membership", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const users = yield* Users.Users;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });

      const invitee = yield* users.create({ email: "invitee@example.com", name: "Invitee" });
      const invitation = yield* organization.invite(owner, org.id, {
        email: invitee.email,
        role: ["member"],
      });

      const inviteeCaller = asCaller(invitee.id);
      const membership = yield* organization.acceptInvitation(inviteeCaller, invitation.id);
      assert.strictEqual(membership.userId, invitee.id);
      assert.deepStrictEqual(membership.role, ["member"]);

      const stored = yield* organization.getInvitation(invitation.id);
      assert.strictEqual(stored.status, "accepted");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("reject marks the invitation rejected and creates no membership", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const users = yield* Users.Users;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      const invitee = yield* users.create({ email: "invitee@example.com", name: "Invitee" });
      const invitation = yield* organization.invite(owner, org.id, {
        email: invitee.email,
        role: ["member"],
      });

      yield* organization.rejectInvitation(asCaller(invitee.id), invitation.id);
      const stored = yield* organization.getInvitation(invitation.id);
      assert.strictEqual(stored.status, "rejected");

      const members = yield* organization.listMembers(owner, org.id);
      assert.strictEqual(members.length, 1);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("cancel requires invitation:cancel permission and marks it canceled", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const outsider = asCaller("outsider-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      const invitation = yield* organization.invite(owner, org.id, {
        email: "invitee@example.com",
        role: ["member"],
      });

      const denied = yield* organization
        .cancelInvitation(outsider, invitation.id)
        .pipe(Effect.flip);
      assert.strictEqual(denied._tag, "OrganizationPermissionDenied");

      yield* organization.cancelInvitation(owner, invitation.id);
      const stored = yield* organization.getInvitation(invitation.id);
      assert.strictEqual(stored.status, "canceled");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("re-inviting a pending email without resend is a no-op", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const mailer = yield* Mailer.Mailer;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });

      const first = yield* organization.invite(owner, org.id, {
        email: "invitee@example.com",
        role: ["member"],
      });
      const second = yield* organization.invite(owner, org.id, {
        email: "invitee@example.com",
        role: ["member"],
      });
      assert.strictEqual(first.id, second.id);
      const sent = yield* mailer.sent;
      assert.strictEqual(sent.length, 1);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("re-inviting with resend sends again against the same invitation", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const mailer = yield* Mailer.Mailer;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });

      const first = yield* organization.invite(owner, org.id, {
        email: "invitee@example.com",
        role: ["member"],
      });
      const second = yield* organization.invite(owner, org.id, {
        email: "invitee@example.com",
        role: ["member"],
        resend: true,
      });
      assert.strictEqual(first.id, second.id);
      const sent = yield* mailer.sent;
      assert.strictEqual(sent.length, 2);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("cancelPendingInvitationsOnReInvite cancels the old one and creates a new one", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });

      const first = yield* organization.invite(owner, org.id, {
        email: "invitee@example.com",
        role: ["member"],
      });
      const second = yield* organization.invite(owner, org.id, {
        email: "invitee@example.com",
        role: ["member"],
      });
      assert.notStrictEqual(first.id, second.id);

      const stale = yield* organization.getInvitation(first.id);
      assert.strictEqual(stale.status, "canceled");
    }).pipe(Effect.provide(buildLayer({ cancelPendingInvitationsOnReInvite: true }))),
  );

  it.effect("inviting an existing member cancels their prior pending invitation", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const users = yield* Users.Users;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      const invitee = yield* users.create({ email: "invitee@example.com", name: "Invitee" });

      const invitation = yield* organization.invite(owner, org.id, {
        email: invitee.email,
        role: ["member"],
      });
      yield* organization.acceptInvitation(asCaller(invitee.id), invitation.id);

      yield* organization.invite(owner, org.id, { email: invitee.email, role: ["member"] });
      const stored = yield* organization.getInvitation(invitation.id);
      assert.strictEqual(stored.status, "accepted");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("accepting an expired invitation fails InvitationExpired", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const users = yield* Users.Users;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      const invitee = yield* users.create({ email: "invitee@example.com", name: "Invitee" });
      const invitation = yield* organization.invite(owner, org.id, {
        email: invitee.email,
        role: ["member"],
      });

      yield* TestClock.adjust(Duration.hours(49));
      const failure = yield* organization
        .acceptInvitation(asCaller(invitee.id), invitation.id)
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "InvitationExpired");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("accepting with a mismatched email fails InvitationEmailMismatch", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const users = yield* Users.Users;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      const invitation = yield* organization.invite(owner, org.id, {
        email: "invitee@example.com",
        role: ["member"],
      });
      const someoneElse = yield* users.create({ email: "someone-else@example.com", name: "X" });

      const failure = yield* organization
        .acceptInvitation(asCaller(someoneElse.id), invitation.id)
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "InvitationEmailMismatch");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("invitationLimit rejects a caller who has too many pending invitations", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      yield* organization.invite(owner, org.id, { email: "a@example.com", role: ["member"] });
      const failure = yield* organization
        .invite(owner, org.id, { email: "b@example.com", role: ["member"] })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "InvitationLimitReached");
    }).pipe(Effect.provide(buildLayer({ invitationLimit: 1 }))),
  );

  it.effect("getFull includes pending invitations", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      yield* organization.invite(owner, org.id, { email: "a@example.com", role: ["member"] });
      const full = yield* organization.getFull(owner, org.id);
      assert.strictEqual(full.invitations.length, 1);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("createRole is rejected when dynamic access control is disabled", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      const failure = yield* organization
        .createRole(owner, org.id, { role: "billing-admin", permission: {} })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "DynamicAccessControlDisabled");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("createRole/listRoles/getRole/updateRole/deleteRole round-trip", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });

      const role = yield* organization.createRole(owner, org.id, {
        role: "billing-admin",
        permission: { organization: ["update"] },
      });
      const listed = yield* organization.listRoles(owner, org.id);
      assert.strictEqual(listed.length, 1);

      const fetched = yield* organization.getRole(owner, org.id, role.id);
      assert.strictEqual(fetched.role, "billing-admin");

      const updated = yield* organization.updateRole(owner, org.id, role.id, {
        organization: ["update", "delete"],
      });
      assert.deepStrictEqual(updated.permission, { organization: ["update", "delete"] });

      yield* organization.deleteRole(owner, org.id, role.id);
      const afterDelete = yield* organization.listRoles(owner, org.id);
      assert.strictEqual(afterDelete.length, 0);
    }).pipe(
      Effect.provide(
        buildLayer({
          dynamicAccessControl: {
            enabled: true,
            maximumRolesPerOrganization: Number.POSITIVE_INFINITY,
          },
        }),
      ),
    ),
  );

  it.effect("createRole rejects granting a permission the caller doesn't hold", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });

      const failure = yield* organization
        .createRole(owner, org.id, {
          role: "super-role",
          permission: { somethingNoOneHas: ["do-anything"] },
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "RolePermissionEscalation");
    }).pipe(
      Effect.provide(
        buildLayer({
          dynamicAccessControl: {
            enabled: true,
            maximumRolesPerOrganization: Number.POSITIVE_INFINITY,
          },
        }),
      ),
    ),
  );

  it.effect("a member holding a custom role has that role's permissions", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const member = asCaller("member-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      yield* organization.addMember({
        organizationId: org.id,
        userId: Users.UserId("member-1"),
        role: ["custom-updater"],
      });
      yield* organization.createRole(owner, org.id, {
        role: "custom-updater",
        permission: { organization: ["update"] },
      });

      const updated = yield* organization.update(member, org.id, { name: "Acme Inc" });
      assert.strictEqual(updated.name, "Acme Inc");
    }).pipe(
      Effect.provide(
        buildLayer({
          dynamicAccessControl: {
            enabled: true,
            maximumRolesPerOrganization: Number.POSITIVE_INFINITY,
          },
        }),
      ),
    ),
  );

  it.effect("maximumRolesPerOrganization caps the number of custom roles", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      yield* organization.createRole(owner, org.id, { role: "r1", permission: {} });
      const failure = yield* organization
        .createRole(owner, org.id, { role: "r2", permission: {} })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "RoleLimitReached");
    }).pipe(
      Effect.provide(
        buildLayer({ dynamicAccessControl: { enabled: true, maximumRolesPerOrganization: 1 } }),
      ),
    ),
  );

  it.effect("createTeam is rejected when teams is disabled", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      const failure = yield* organization
        .createTeam(owner, org.id, "Engineering")
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "TeamsDisabled");
    }).pipe(Effect.provide(buildLayer())),
  );

  const withTeams = (
    overrides: Partial<Organization.OrganizationConfigShape["teams"]> = {},
  ): ReturnType<typeof buildLayer> =>
    buildLayer({
      teams: {
        enabled: true,
        maximumTeams: Number.POSITIVE_INFINITY,
        maximumMembersPerTeam: Number.POSITIVE_INFINITY,
        allowRemovingAllTeams: false,
        ...overrides,
      },
    });

  it.effect("createTeam/listTeams/updateTeam/removeTeam round-trip", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });

      const team = yield* organization.createTeam(owner, org.id, "Engineering");
      assert.strictEqual(team.memberCount, 0);

      const listed = yield* organization.listTeams(org.id);
      assert.strictEqual(listed.length, 1);

      const updated = yield* organization.updateTeam(owner, org.id, team.id, "Eng");
      assert.strictEqual(updated.name, "Eng");

      yield* organization.createTeam(owner, org.id, "Sales");
      yield* organization.removeTeam(owner, org.id, team.id);
      const afterRemove = yield* organization.listTeams(org.id);
      assert.strictEqual(afterRemove.length, 1);
    }).pipe(Effect.provide(withTeams())),
  );

  it.effect("addTeamMember requires the target already be an organization member", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      const team = yield* organization.createTeam(owner, org.id, "Engineering");

      const failure = yield* organization
        .addTeamMember(owner, org.id, team.id, Users.UserId("not-a-member"))
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "MembershipNotFound");

      yield* organization.addMember({
        organizationId: org.id,
        userId: Users.UserId("member-1"),
        role: ["member"],
      });
      const membership = yield* organization.addTeamMember(
        owner,
        org.id,
        team.id,
        Users.UserId("member-1"),
      );
      assert.strictEqual(membership.userId, Users.UserId("member-1"));

      const members = yield* organization.listTeamMembers(org.id, team.id);
      assert.strictEqual(members.length, 1);

      yield* organization.removeTeamMember(owner, org.id, team.id, Users.UserId("member-1"));
      const afterRemove = yield* organization.listTeamMembers(org.id, team.id);
      assert.strictEqual(afterRemove.length, 0);
    }).pipe(Effect.provide(withTeams())),
  );

  it.effect("allowRemovingAllTeams (default false) blocks removing the last team", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      const team = yield* organization.createTeam(owner, org.id, "Engineering");

      const failure = yield* organization.removeTeam(owner, org.id, team.id).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "LastTeamCannotBeRemoved");
    }).pipe(Effect.provide(withTeams())),
  );

  it.effect("setActiveTeam round-trips and rejects a non-member", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const outsider = asCaller("outsider-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      const team = yield* organization.createTeam(owner, org.id, "Engineering");
      yield* organization.addTeamMember(owner, org.id, team.id, Users.UserId("owner-1"));

      const failure = yield* organization.setActiveTeam(outsider, team.id).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "TeamMembershipNotFound");

      yield* organization.setActiveTeam(owner, team.id);
      const active = yield* organization.getActive(owner);
      assert.deepStrictEqual(active.activeTeamId, Option.some(team.id));

      yield* organization.setActiveTeam(owner, null);
      const cleared = yield* organization.getActive(owner);
      assert.deepStrictEqual(cleared.activeTeamId, Option.none());
    }).pipe(Effect.provide(withTeams())),
  );

  it.effect("a team-targeted invitation joins the accepting user to that team", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const users = yield* Users.Users;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      const team = yield* organization.createTeam(owner, org.id, "Engineering");
      const invitee = yield* users.create({ email: "invitee@example.com", name: "Invitee" });

      const invitation = yield* organization.invite(owner, org.id, {
        email: invitee.email,
        role: ["member"],
        teamId: team.id,
      });
      yield* organization.acceptInvitation(asCaller(invitee.id), invitation.id);

      const members = yield* organization.listTeamMembers(org.id, team.id);
      assert.strictEqual(members.length, 1);
      assert.strictEqual(members[0]?.userId, invitee.id);
    }).pipe(Effect.provide(withTeams())),
  );

  it.effect("inviting with an unknown teamId fails TeamNotFound", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      const failure = yield* organization
        .invite(owner, org.id, { email: "a@example.com", role: ["member"], teamId: "no-such-team" })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "TeamNotFound");
    }).pipe(Effect.provide(withTeams())),
  );
});
