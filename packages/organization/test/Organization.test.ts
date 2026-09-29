// spec.md. Domain-level tests (no HTTP layer here — see `AuthHttp.test.ts`
// for the wire-level equivalent): real `AuthEvents`/`OrganizationRecords`/
// `MembershipRecords`, a hand-built `Api.UserPrincipal` the same way
// `@awthaq/admin`'s own `Admin.test.ts` does.
import { Api } from "@awthaq/api";
import { AuditLog, Hooks, AuthEvents, Sessions, Users } from "@awthaq/core";
import { Mailer, SqlTransaction } from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as ActiveContextRecords from "../src/ActiveContextRecords.ts";
import * as InvitationRecords from "../src/InvitationRecords.ts";
import * as MembershipRecords from "../src/MembershipRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as OrganizationHooks from "../src/OrganizationHooks.ts";
import * as OrganizationRecords from "../src/OrganizationRecords.ts";
import * as OrgRoleRecords from "../src/OrgRoleRecords.ts";
import * as TeamRecords from "../src/TeamRecords.ts";

const CoreLive = Layer.mergeAll(Sessions.layerMemory, Users.layerMemory).pipe(
  // RRS-003: `Sessions.layerMemory` now also needs `AuthEvents` (session
  // reuse publishes `auth.session.reuse`) — `provideMerge`, not a sibling
  // inside `mergeAll` above, so it also satisfies that need rather than
  // merely sitting alongside it unsatisfied.
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("organization-test-csrf-secret-padded-to-thirty-two-bytes"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const buildLayer = (
  configOverrides: Partial<Organization.OrganizationConfigShape> = {},
  mailerLayer: Layer.Layer<Mailer.Mailer> = Mailer.layerMemory,
) =>
  Organization.Organization.layer.pipe(
    Layer.provide(Organization.config(configOverrides)),
    Layer.provide(AuthenticationLive),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(OrganizationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(MembershipRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(ActiveContextRecords.layerMemory),
    Layer.provideMerge(InvitationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(OrgRoleRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(TeamRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(mailerLayer),
    Layer.provideMerge(SqlTransaction.layerNoop),
    Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
  );

const asCaller = (id: string): Api.UserPrincipal =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id }),
    sessionId: `${id}-session`,
  });

/** An audit record's `payload` is opaque (`unknown`); narrow it to a plain record for assertions. */
const payloadOf = (record: { readonly payload: unknown } | undefined): Record<string, unknown> =>
  typeof record?.payload === "object" && record.payload !== null
    ? Object.fromEntries(Object.entries(record.payload))
    : {};

/**
 * MTI-010: the invitation capability only ever travels by email — read it back
 * from the recording `Mailer`, exactly as an invitee would receive it.
 */
const mailedToken = (invitationId: string) =>
  Effect.gen(function* () {
    const mailer = yield* Mailer.Mailer;
    const sent = yield* mailer.sent;
    for (const message of sent.toReversed()) {
      const data = message.data;
      if (
        data !== undefined &&
        data["invitationId"] === invitationId &&
        typeof data["token"] === "string"
      ) {
        return data["token"];
      }
    }
    return yield* Effect.die(new Error(`no invitation mail was sent for ${invitationId}`));
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

      const fetched = yield* organization.get(owner, record.id);
      assert.strictEqual(fetched.slug, "acme");
      const notFound = yield* organization.get(owner, "does-not-exist").pipe(Effect.flip);
      assert.strictEqual(notFound._tag, "OrganizationNotFound");
      // MTI-008: organization metadata is member-only; a non-member gets the
      // same 404 an unknown id gets.
      const outsiderGet = yield* organization.get(outsider, record.id).pipe(Effect.flip);
      assert.strictEqual(outsiderGet._tag, "OrganizationNotFound");

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

      // MTI-009: a non-member cannot tell an existing organization from a missing one.
      const fullDenied = yield* organization.getFull(outsider, record.id).pipe(Effect.flip);
      assert.strictEqual(fullDenied._tag, "OrganizationNotFound");

      const membersDenied = yield* organization.listMembers(outsider, record.id).pipe(Effect.flip);
      assert.strictEqual(membersDenied._tag, "OrganizationNotFound");

      const invitationsDenied = yield* organization
        .listInvitationsForOrganization(outsider, record.id)
        .pipe(Effect.flip);
      assert.strictEqual(invitationsDenied._tag, "OrganizationNotFound");

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
      const gone = yield* organization.get(owner, record.id).pipe(Effect.flip);
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

  // EEM-002: the inviter is authenticated, so a mail outage is surfaced —
  // with the invitation kept pending so a resend can succeed later.
  it.effect("invite fails with InvitationDeliveryFailed when mail fails; resend succeeds once mail recovers", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });

      const failure = yield* organization
        .invite(owner, org.id, { email: "invitee@example.com", role: ["member"] })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "InvitationDeliveryFailed");

      const pending = yield* organization.listInvitationsForOrganization(owner, org.id);
      assert.strictEqual(pending.length, 1);
      assert.strictEqual(pending[0]?.status, "pending");
      assert.strictEqual(pending[0]?.id, failure._tag === "InvitationDeliveryFailed" ? failure.invitationId : "");

      const resent = yield* organization.invite(owner, org.id, {
        email: "invitee@example.com",
        role: ["member"],
        resend: true,
      });
      assert.strictEqual(resent.id, pending[0]?.id);
      assert.strictEqual(resent.status, "pending");
    }).pipe(
      Effect.provide(
        buildLayer(
          {},
          Layer.effect(
            Mailer.Mailer,
            Effect.gen(function* () {
              const attempts = yield* Ref.make(0);
              return Mailer.Mailer.of({
                send: (message) =>
                  Ref.getAndUpdate(attempts, (n) => n + 1).pipe(
                    Effect.flatMap((n) =>
                      n === 0
                        ? Effect.fail(
                            new Mailer.MailDeliveryFailed({
                              template: message.template,
                              reason: "provider down",
                              retryable: true,
                            }),
                          )
                        : Effect.void,
                    ),
                  ),
                sent: Effect.succeed([]),
              });
            }),
          ),
        ),
      ),
    ),
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
      const membership = yield* organization.acceptInvitation(
        inviteeCaller,
        invitation.id,
        yield* mailedToken(invitation.id),
      );
      assert.strictEqual(membership.userId, invitee.id);
      assert.deepStrictEqual(membership.role, ["member"]);

      const stored = yield* organization.getInvitation(owner, invitation.id);
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

      yield* organization.rejectInvitation(
        asCaller(invitee.id),
        invitation.id,
        yield* mailedToken(invitation.id),
      );
      const stored = yield* organization.getInvitation(owner, invitation.id);
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

      // MTI-009: a non-member sees the same answer as for an unknown invitation.
      const denied = yield* organization
        .cancelInvitation(outsider, invitation.id)
        .pipe(Effect.flip);
      assert.strictEqual(denied._tag, "InvitationNotFound");

      yield* organization.cancelInvitation(owner, invitation.id);
      const stored = yield* organization.getInvitation(owner, invitation.id);
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

      const stale = yield* organization.getInvitation(owner, first.id);
      assert.strictEqual(stale.status, "canceled");
    }).pipe(Effect.provide(buildLayer({ cancelPendingInvitationsOnReInvite: true }))),
  );

  // OHS-006: re-inviting a member is refused (it used to mint a second invitation).
  it.effect(
    "inviting an existing member fails AlreadyMember and keeps their accepted invitation",
    () =>
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
        yield* organization.acceptInvitation(
          asCaller(invitee.id),
          invitation.id,
          yield* mailedToken(invitation.id),
        );

        const failure = yield* organization
          .invite(owner, org.id, { email: invitee.email, role: ["member"] })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "AlreadyMember");
        const stored = yield* organization.getInvitation(owner, invitation.id);
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
        .acceptInvitation(asCaller(invitee.id), invitation.id, yield* mailedToken(invitation.id))
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
        .acceptInvitation(
          asCaller(someoneElse.id),
          invitation.id,
          yield* mailedToken(invitation.id),
        )
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

  // RRM-001/RRM-002: every role-assignment path (updateMemberRole, invite,
  // addMember) applies the same grant guard as createRole/updateRole — a
  // caller can only confer statements it holds, only known role names are
  // stored, and a lower tier cannot alter a higher one.
  describe("RRM-001/RRM-002: role assignment respects canGrant", () => {
    const hrConfig = {
      permissionStatements: { hr: { member: ["update"], invitation: ["create"] } },
    };

    const setup = Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      yield* organization.addMember({
        organizationId: org.id,
        userId: Users.UserId("hr-1"),
        role: ["hr"],
      });
      return { organization, owner, hr: asCaller("hr-1"), org };
    });

    it.effect("a custom role holding member:update cannot promote itself to owner", () =>
      Effect.gen(function* () {
        const { organization, hr, org } = yield* setup;
        const failure = yield* organization
          .updateMemberRole(hr, org.id, Users.UserId("hr-1"), ["owner"])
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "RolePermissionEscalation");
      }).pipe(Effect.provide(buildLayer(hrConfig))),
    );

    it.effect("updateMemberRole with an undefined role name fails UnknownOrgRole", () =>
      Effect.gen(function* () {
        const { organization, owner, org } = yield* setup;
        const failure = yield* organization
          .updateMemberRole(owner, org.id, Users.UserId("hr-1"), ["no-such-role"])
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "UnknownOrgRole");
      }).pipe(Effect.provide(buildLayer(hrConfig))),
    );

    it.effect("a lower tier cannot change the role of a member who out-privileges it", () =>
      Effect.gen(function* () {
        const { organization, hr, org } = yield* setup;
        yield* organization.addMember({
          organizationId: org.id,
          userId: Users.UserId("owner-2"),
          role: ["owner"],
        });
        const failure = yield* organization
          .updateMemberRole(hr, org.id, Users.UserId("owner-2"), ["member"])
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "RolePermissionEscalation");
      }).pipe(Effect.provide(buildLayer(hrConfig))),
    );

    it.effect("a caller can still assign a role it fully covers (no over-blocking)", () =>
      Effect.gen(function* () {
        const { organization, hr, org } = yield* setup;
        yield* organization.addMember({
          organizationId: org.id,
          userId: Users.UserId("plain-1"),
          role: ["member"],
        });
        const updated = yield* organization.updateMemberRole(hr, org.id, Users.UserId("plain-1"), [
          "hr",
        ]);
        assert.deepStrictEqual(updated.role, ["hr"]);
      }).pipe(Effect.provide(buildLayer(hrConfig))),
    );

    it.effect(
      "an inviter holding invitation:create but not owner statements cannot invite an owner",
      () =>
        Effect.gen(function* () {
          const { organization, hr, org } = yield* setup;
          const failure = yield* organization
            .invite(hr, org.id, { email: "new@example.com", role: ["owner"] })
            .pipe(Effect.flip);
          assert.strictEqual(failure._tag, "RolePermissionEscalation");
        }).pipe(Effect.provide(buildLayer(hrConfig))),
    );

    it.effect("an inviter can invite at or below its own privilege", () =>
      Effect.gen(function* () {
        const { organization, hr, org } = yield* setup;
        const invitation = yield* organization.invite(hr, org.id, {
          email: "new@example.com",
          role: ["member"],
        });
        assert.deepStrictEqual(invitation.role, ["member"]);
      }).pipe(Effect.provide(buildLayer(hrConfig))),
    );

    it.effect("invite and addMember reject an undefined role name", () =>
      Effect.gen(function* () {
        const { organization, owner, org } = yield* setup;
        const inviteFailure = yield* organization
          .invite(owner, org.id, { email: "x@example.com", role: ["ghost"] })
          .pipe(Effect.flip);
        assert.strictEqual(inviteFailure._tag, "UnknownOrgRole");
        const addFailure = yield* organization
          .addMember({ organizationId: org.id, userId: Users.UserId("u-2"), role: ["ghost"] })
          .pipe(Effect.flip);
        assert.strictEqual(addFailure._tag, "UnknownOrgRole");
      }).pipe(Effect.provide(buildLayer(hrConfig))),
    );
  });

  // OHS-005: owner is strictly above admin.
  describe("OHS-005: admin is not owner", () => {
    const setup = Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      yield* organization.addMember({
        organizationId: org.id,
        userId: Users.UserId("admin-1"),
        role: ["admin"],
      });
      yield* organization.addMember({
        organizationId: org.id,
        userId: Users.UserId("member-1"),
        role: ["member"],
      });
      return { organization, owner, admin: asCaller("admin-1"), org };
    });

    it.effect("an admin cannot delete the organization", () =>
      Effect.gen(function* () {
        const { organization, admin, org } = yield* setup;
        const failure = yield* organization.delete(admin, org.id).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "OrganizationPermissionDenied");
      }).pipe(Effect.provide(buildLayer())),
    );

    it.effect("an admin cannot promote a member (or themselves) to owner", () =>
      Effect.gen(function* () {
        const { organization, admin, org } = yield* setup;
        const promote = yield* organization
          .updateMemberRole(admin, org.id, Users.UserId("member-1"), ["owner"])
          .pipe(Effect.flip);
        assert.strictEqual(promote._tag, "RolePermissionEscalation");
        const self = yield* organization
          .updateMemberRole(admin, org.id, Users.UserId("admin-1"), ["owner"])
          .pipe(Effect.flip);
        assert.strictEqual(self._tag, "RolePermissionEscalation");
      }).pipe(Effect.provide(buildLayer())),
    );

    it.effect("an admin cannot invite an owner, but can invite an admin", () =>
      Effect.gen(function* () {
        const { organization, admin, org } = yield* setup;
        const failure = yield* organization
          .invite(admin, org.id, { email: "boss@example.com", role: ["owner"] })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "RolePermissionEscalation");
        const ok = yield* organization.invite(admin, org.id, {
          email: "peer@example.com",
          role: ["admin"],
        });
        assert.deepStrictEqual(ok.role, ["admin"]);
      }).pipe(Effect.provide(buildLayer())),
    );

    it.effect("an admin can still update the organization", () =>
      Effect.gen(function* () {
        const { organization, admin, org } = yield* setup;
        const updated = yield* organization.update(admin, org.id, { name: "Acme 2" });
        assert.strictEqual(updated.name, "Acme 2");
      }).pipe(Effect.provide(buildLayer())),
    );
  });

  // RZS-005/N8: dynamic and custom roles can never shadow a built-in tier.
  describe("RZS-005/N8: reserved role names", () => {
    const dac = {
      dynamicAccessControl: {
        enabled: true,
        maximumRolesPerOrganization: Number.POSITIVE_INFINITY,
      },
    };

    it.effect("createRole named owner/admin/member fails ReservedOrgRoleName", () =>
      Effect.gen(function* () {
        const organization = yield* Organization.Organization;
        const owner = asCaller("owner-1");
        const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
        for (const role of ["owner", "admin", "member"]) {
          const failure = yield* organization
            .createRole(owner, org.id, { role, permission: {} })
            .pipe(Effect.flip);
          assert.strictEqual(failure._tag, "ReservedOrgRoleName");
        }
      }).pipe(Effect.provide(buildLayer(dac))),
    );

    it.effect("createRole named after a static custom role fails ReservedOrgRoleName", () =>
      Effect.gen(function* () {
        const organization = yield* Organization.Organization;
        const owner = asCaller("owner-1");
        const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
        const failure = yield* organization
          .createRole(owner, org.id, { role: "hr", permission: {} })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "ReservedOrgRoleName");
      }).pipe(
        Effect.provide(
          buildLayer({ ...dac, permissionStatements: { hr: { member: ["update"] } } }),
        ),
      ),
    );

    it.effect("a stored dynamic role named owner cannot change the owner's statements", () =>
      Effect.gen(function* () {
        const organization = yield* Organization.Organization;
        const orgRoles = yield* OrgRoleRecords.OrgRoleRecords;
        const owner = asCaller("owner-1");
        const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
        // A row that predates the reservation (or was written around the plugin).
        yield* orgRoles.create({
          organizationId: org.id,
          role: "owner",
          permission: { member: [] },
        });
        const attrs = yield* organization.attributesFor(org.id, Users.UserId("owner-1"));
        assert.isTrue(Option.isSome(attrs));
        if (Option.isSome(attrs)) {
          assert.isTrue((attrs.value.permissions["organization"] ?? []).includes("delete"));
        }
      }).pipe(Effect.provide(buildLayer(dac))),
    );

    it.effect("Organization.config refuses permissionStatements that redefine a built-in", () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            return yield* Organization.OrganizationConfig;
          }).pipe(Effect.provide(Organization.config({ permissionStatements: { owner: {} } }))),
        );
        assert.isTrue(exit._tag === "Failure");
      }),
    );
  });

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
      // RRM-001: a role must exist before a membership can name it.
      yield* organization.createRole(owner, org.id, {
        role: "custom-updater",
        permission: { organization: ["update"] },
      });
      yield* organization.addMember({
        organizationId: org.id,
        userId: Users.UserId("member-1"),
        role: ["custom-updater"],
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

      const listed = yield* organization.listTeams(owner, org.id);
      assert.strictEqual(listed.length, 1);

      const updated = yield* organization.updateTeam(owner, org.id, team.id, "Eng");
      assert.strictEqual(updated.name, "Eng");

      yield* organization.createTeam(owner, org.id, "Sales");
      yield* organization.removeTeam(owner, org.id, team.id);
      const afterRemove = yield* organization.listTeams(owner, org.id);
      assert.strictEqual(afterRemove.length, 1);
    }).pipe(Effect.provide(withTeams())),
  );

  // OHS-001 (ticket 34): teams nest; structure changes need team:update; reads are member-only.
  describe("team hierarchy (OHS-001)", () => {
    const tree = Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      const eng = yield* organization.createTeam(owner, org.id, "Engineering");
      const platform = yield* organization.createTeam(owner, org.id, "Platform", eng.id);
      const infra = yield* organization.createTeam(owner, org.id, "Infra", platform.id);
      const sales = yield* organization.createTeam(owner, org.id, "Sales");
      return { organization, owner, org, eng, platform, infra, sales };
    });
    const names = (rows: ReadonlyArray<{ readonly name: string }>) => rows.map((row) => row.name);

    it.effect("nested create, ancestors/descendants, and move re-parent a subtree", () =>
      Effect.gen(function* () {
        const { organization, owner, org, eng, platform, infra, sales } = yield* tree;
        assert.deepStrictEqual(platform.parentId, Option.some(eng.id));
        assert.deepStrictEqual(
          names(yield* organization.listTeamAncestors(owner, org.id, infra.id)),
          ["Platform", "Engineering"],
        );
        assert.deepStrictEqual(
          names(yield* organization.listTeamDescendants(owner, org.id, eng.id)),
          ["Platform", "Infra"],
        );

        const moved = yield* organization.moveTeam(
          owner,
          org.id,
          platform.id,
          Option.some(sales.id),
        );
        assert.deepStrictEqual(moved.parentId, Option.some(sales.id));
        assert.deepStrictEqual(
          names(yield* organization.listTeamAncestors(owner, org.id, infra.id)),
          ["Platform", "Sales"],
        );
        yield* organization.moveTeam(owner, org.id, platform.id, Option.none());
        assert.deepStrictEqual(
          names(yield* organization.listTeamDescendants(owner, org.id, eng.id)),
          [],
        );
      }).pipe(Effect.provide(withTeams())),
    );

    it.effect("a cycle is TeamHierarchyCycle; a parent with children cannot be removed", () =>
      Effect.gen(function* () {
        const { organization, owner, org, eng, platform, infra } = yield* tree;
        const cycle = yield* organization
          .moveTeam(owner, org.id, eng.id, Option.some(infra.id))
          .pipe(Effect.flip);
        assert.strictEqual(cycle._tag, "TeamHierarchyCycle");

        const blocked = yield* organization
          .removeTeam(owner, org.id, platform.id)
          .pipe(Effect.flip);
        assert.strictEqual(blocked._tag, "TeamHasChildren");
        yield* organization.removeTeam(owner, org.id, infra.id);
        yield* organization.removeTeam(owner, org.id, platform.id);
      }).pipe(Effect.provide(withTeams())),
    );

    it.effect("a parent from another organization is TeamNotFound", () =>
      Effect.gen(function* () {
        const { organization, owner, org, eng } = yield* tree;
        const other = yield* organization.create({ caller: owner, name: "Other", slug: "other" });
        const foreign = yield* organization.createTeam(owner, other.id, "Foreign");
        const onCreate = yield* organization
          .createTeam(owner, org.id, "Nested", foreign.id)
          .pipe(Effect.flip);
        assert.strictEqual(onCreate._tag, "TeamNotFound");
        const onMove = yield* organization
          .moveTeam(owner, org.id, eng.id, Option.some(foreign.id))
          .pipe(Effect.flip);
        assert.strictEqual(onMove._tag, "TeamNotFound");
      }).pipe(Effect.provide(withTeams())),
    );

    it.effect("moving needs team:update; reading relatives is member-only", () =>
      Effect.gen(function* () {
        const { organization, org, eng, platform } = yield* tree;
        const member = asCaller("member-1");
        const outsider = asCaller("outsider-1");
        yield* organization.addMember({
          organizationId: org.id,
          userId: Users.UserId("member-1"),
          role: ["member"],
        });
        const denied = yield* organization
          .moveTeam(member, org.id, platform.id, Option.none())
          .pipe(Effect.flip);
        assert.strictEqual(denied._tag, "OrganizationPermissionDenied");

        yield* organization.listTeamDescendants(member, org.id, eng.id);
        const hidden = yield* organization
          .listTeamAncestors(outsider, org.id, platform.id)
          .pipe(Effect.flip);
        assert.strictEqual(hidden._tag, "OrganizationNotFound");
      }).pipe(Effect.provide(withTeams())),
    );
  });

  // OHS-004 (decision: option 2): a team membership carries a role; team-scoped
  // statements (`teamStatements`, default `lead` -> team:update) apply to that
  // team and its subtree, on top of the org-level statements, canGrant-guarded.
  describe("team roles (OHS-004)", () => {
    const teamsOn = {
      enabled: true,
      maximumTeams: Number.POSITIVE_INFINITY,
      maximumMembersPerTeam: Number.POSITIVE_INFINITY,
      allowRemovingAllTeams: true,
    };
    const layerWith = (teamStatements?: Organization.OrganizationConfigShape["teamStatements"]) =>
      buildLayer({ teams: teamsOn, ...(teamStatements === undefined ? {} : { teamStatements }) });

    const setup = Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      for (const id of ["lead-1", "worker-1", "worker-2"]) {
        yield* organization.addMember({
          organizationId: org.id,
          userId: Users.UserId(id),
          role: ["member"],
        });
      }
      const eng = yield* organization.createTeam(owner, org.id, "Engineering");
      const platform = yield* organization.createTeam(owner, org.id, "Platform", eng.id);
      const sales = yield* organization.createTeam(owner, org.id, "Sales");
      yield* organization.addTeamMember(owner, org.id, eng.id, Users.UserId("lead-1"), ["lead"]);
      return { organization, owner, org, eng, platform, sales, lead: asCaller("lead-1") };
    });

    it.effect("a team lead can manage their own team's roster but not another team's", () =>
      Effect.gen(function* () {
        const { organization, org, eng, sales, lead } = yield* setup;
        const added = yield* organization.addTeamMember(
          lead,
          org.id,
          eng.id,
          Users.UserId("worker-1"),
        );
        assert.deepStrictEqual(added.role, ["member"]);
        yield* organization.removeTeamMember(lead, org.id, eng.id, Users.UserId("worker-1"));

        const denied = yield* organization
          .addTeamMember(lead, org.id, sales.id, Users.UserId("worker-1"))
          .pipe(Effect.flip);
        assert.strictEqual(denied._tag, "OrganizationPermissionDenied");
        // A plain org member with no team role has no authority anywhere.
        const plain = yield* organization
          .addTeamMember(asCaller("worker-2"), org.id, eng.id, Users.UserId("worker-1"))
          .pipe(Effect.flip);
        assert.strictEqual(plain._tag, "OrganizationPermissionDenied");
      }).pipe(Effect.provide(layerWith())),
    );

    it.effect("a lead's authority flows down the subtree, never up or sideways", () =>
      Effect.gen(function* () {
        const { organization, org, eng, platform, sales, lead } = yield* setup;
        // Down: the lead of Engineering renames and staffs its child team.
        yield* organization.updateTeam(lead, org.id, platform.id, "Platform Eng");
        yield* organization.addTeamMember(lead, org.id, platform.id, Users.UserId("worker-1"));
        // Up/sideways: a lead of the child cannot touch the parent.
        yield* organization.addTeamMember(
          asCaller("owner-1"),
          org.id,
          platform.id,
          Users.UserId("worker-2"),
          ["lead"],
        );
        const up = yield* organization
          .updateTeam(asCaller("worker-2"), org.id, eng.id, "Nope")
          .pipe(Effect.flip);
        assert.strictEqual(up._tag, "OrganizationPermissionDenied");
        const sideways = yield* organization
          .updateTeam(lead, org.id, sales.id, "Nope")
          .pipe(Effect.flip);
        assert.strictEqual(sideways._tag, "OrganizationPermissionDenied");
      }).pipe(Effect.provide(layerWith())),
    );

    it.effect("org admin retains authority over every team", () =>
      Effect.gen(function* () {
        const { organization, org, eng, sales } = yield* setup;
        yield* organization.addMember({
          organizationId: org.id,
          userId: Users.UserId("admin-1"),
          role: ["admin"],
        });
        const admin = asCaller("admin-1");
        yield* organization.addTeamMember(admin, org.id, eng.id, Users.UserId("worker-1"));
        yield* organization.addTeamMember(admin, org.id, sales.id, Users.UserId("worker-1"), [
          "lead",
        ]);
      }).pipe(Effect.provide(layerWith())),
    );

    it.effect("team roles are canGrant-guarded and must be known", () =>
      Effect.gen(function* () {
        const { organization, org, eng, lead } = yield* setup;
        // Peer grant: the lead holds everything `lead` confers.
        yield* organization.addTeamMember(lead, org.id, eng.id, Users.UserId("worker-1"), ["lead"]);
        const escalation = yield* organization
          .addTeamMember(lead, org.id, eng.id, Users.UserId("worker-2"), ["chief"])
          .pipe(Effect.flip);
        assert.strictEqual(escalation._tag, "RolePermissionEscalation");
        const unknown = yield* organization
          .addTeamMember(lead, org.id, eng.id, Users.UserId("worker-2"), ["no-such-role"])
          .pipe(Effect.flip);
        assert.strictEqual(unknown._tag, "UnknownTeamRole");
        // The org owner may confer the stronger role.
        yield* organization.addTeamMember(
          asCaller("owner-1"),
          org.id,
          eng.id,
          Users.UserId("worker-2"),
          ["chief"],
        );
      }).pipe(
        Effect.provide(
          layerWith({ lead: { team: ["update"] }, chief: { team: ["update", "delete"] } }),
        ),
      ),
    );

    it.effect("updateTeamMemberRole changes the role under the same guards", () =>
      Effect.gen(function* () {
        const { organization, owner, org, eng, lead } = yield* setup;
        yield* organization.addTeamMember(owner, org.id, eng.id, Users.UserId("worker-1"), [
          "chief",
        ]);
        // The lead cannot demote a member who out-privileges them.
        const outranked = yield* organization
          .updateTeamMemberRole(lead, org.id, eng.id, Users.UserId("worker-1"), ["member"])
          .pipe(Effect.flip);
        assert.strictEqual(outranked._tag, "RolePermissionEscalation");

        yield* organization.addTeamMember(owner, org.id, eng.id, Users.UserId("worker-2"));
        const promoted = yield* organization.updateTeamMemberRole(
          lead,
          org.id,
          eng.id,
          Users.UserId("worker-2"),
          ["lead"],
        );
        assert.deepStrictEqual(promoted.role, ["lead"]);
        const missing = yield* organization
          .updateTeamMemberRole(owner, org.id, eng.id, Users.UserId("nobody"), ["lead"])
          .pipe(Effect.flip);
        assert.strictEqual(missing._tag, "TeamMembershipNotFound");
      }).pipe(
        Effect.provide(
          layerWith({ lead: { team: ["update"] }, chief: { team: ["update", "delete"] } }),
        ),
      ),
    );

    it.effect("a lead cannot delete a team, or move one outside their own subtree", () =>
      Effect.gen(function* () {
        const { organization, org, platform, sales, lead } = yield* setup;
        const remove = yield* organization.removeTeam(lead, org.id, platform.id).pipe(Effect.flip);
        assert.strictEqual(remove._tag, "OrganizationPermissionDenied");
        const toSales = yield* organization
          .moveTeam(lead, org.id, platform.id, Option.some(sales.id))
          .pipe(Effect.flip);
        assert.strictEqual(toSales._tag, "OrganizationPermissionDenied");
        const toRoot = yield* organization
          .moveTeam(lead, org.id, platform.id, Option.none())
          .pipe(Effect.flip);
        assert.strictEqual(toRoot._tag, "OrganizationPermissionDenied");
      }).pipe(Effect.provide(layerWith())),
    );
  });

  // MTI-002: listTeams/listTeamMembers used to take no caller at all — any
  // authenticated principal of the deployment could enumerate another
  // tenant's team names and rosters. Mirrors the identical
  // "getFull/listMembers/... denied to a non-member" test above.
  it.effect("listTeams/listTeamMembers are denied to a non-member", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const outsider = asCaller("outsider-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      const team = yield* organization.createTeam(owner, org.id, "Engineering");

      const teamsDenied = yield* organization.listTeams(outsider, org.id).pipe(Effect.flip);
      assert.strictEqual(teamsDenied._tag, "OrganizationNotFound");

      const membersDenied = yield* organization
        .listTeamMembers(outsider, org.id, team.id)
        .pipe(Effect.flip);
      assert.strictEqual(membersDenied._tag, "OrganizationNotFound");

      // A real member (not just owner/admin) may still read both.
      yield* organization.addMember({
        organizationId: org.id,
        userId: Users.UserId("outsider-1"),
        role: ["member"],
      });
      yield* organization.listTeams(outsider, org.id);
      yield* organization.listTeamMembers(outsider, org.id, team.id);
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

      const members = yield* organization.listTeamMembers(owner, org.id, team.id);
      assert.strictEqual(members.length, 1);

      yield* organization.removeTeamMember(owner, org.id, team.id, Users.UserId("member-1"));
      const afterRemove = yield* organization.listTeamMembers(owner, org.id, team.id);
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
      yield* organization.acceptInvitation(
        asCaller(invitee.id),
        invitation.id,
        yield* mailedToken(invitation.id),
      );

      const members = yield* organization.listTeamMembers(owner, org.id, team.id);
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

  // MTI-003/OHS-006/OHS-003: membership uniqueness is enforced at the
  // records layer and surfaced as typed errors on every add path.
  describe("membership uniqueness (MTI-003, OHS-006, OHS-003)", () => {
    it.effect("addMember for an existing member fails AlreadyMember and keeps the roles", () =>
      Effect.gen(function* () {
        const organization = yield* Organization.Organization;
        const owner = asCaller("owner-1");
        const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
        const failure = yield* organization
          .addMember({
            organizationId: org.id,
            userId: Users.UserId("owner-1"),
            role: ["member"],
          })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "AlreadyMember");
        const members = yield* organization.listMembers(owner, org.id);
        assert.strictEqual(members.length, 1);
        assert.deepStrictEqual(members[0]?.role, ["owner"]);
      }).pipe(Effect.provide(buildLayer())),
    );

    it.effect("inviting an existing member fails AlreadyMember and creates no invitation", () =>
      Effect.gen(function* () {
        const organization = yield* Organization.Organization;
        const users = yield* Users.Users;
        const owner = asCaller("owner-1");
        const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
        const existing = yield* users.create({ email: "member@example.com", name: "Member" });
        yield* organization.addMember({
          organizationId: org.id,
          userId: existing.id,
          role: ["member"],
        });
        const failure = yield* organization
          .invite(owner, org.id, { email: existing.email, role: ["admin"] })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "AlreadyMember");
        const listed = yield* organization.listInvitationsForOrganization(owner, org.id);
        assert.strictEqual(listed.length, 0);
      }).pipe(Effect.provide(buildLayer())),
    );

    it.effect(
      "accepting an invitation while already a member fails AlreadyMember and leaves the roles unchanged",
      () =>
        Effect.gen(function* () {
          const organization = yield* Organization.Organization;
          const users = yield* Users.Users;
          const owner = asCaller("owner-1");
          const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
          const invitee = yield* users.create({ email: "invitee@example.com", name: "Invitee" });
          const invitation = yield* organization.invite(owner, org.id, {
            email: invitee.email,
            role: ["admin"],
          });
          // Added directly (e.g. SCIM) after the invitation went out.
          yield* organization.addMember({
            organizationId: org.id,
            userId: invitee.id,
            role: ["member"],
          });
          const failure = yield* organization
            .acceptInvitation(
              asCaller(invitee.id),
              invitation.id,
              yield* mailedToken(invitation.id),
            )
            .pipe(Effect.flip);
          assert.strictEqual(failure._tag, "AlreadyMember");
          const attrs = yield* organization.attributesFor(org.id, invitee.id);
          assert.isTrue(Option.isSome(attrs));
          if (Option.isSome(attrs)) assert.deepStrictEqual(attrs.value.role, ["member"]);
          const stale = yield* organization.getInvitation(owner, invitation.id);
          assert.strictEqual(stale.status, "canceled");
        }).pipe(Effect.provide(buildLayer())),
    );

    it.effect("addTeamMember for an existing team member fails AlreadyTeamMember", () =>
      Effect.gen(function* () {
        const organization = yield* Organization.Organization;
        const owner = asCaller("owner-1");
        const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
        const team = yield* organization.createTeam(owner, org.id, "Engineering");
        yield* organization.addTeamMember(owner, org.id, team.id, Users.UserId("owner-1"));
        const failure = yield* organization
          .addTeamMember(owner, org.id, team.id, Users.UserId("owner-1"))
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "AlreadyTeamMember");
        const teams = yield* organization.listTeams(owner, org.id);
        assert.strictEqual(teams[0]?.memberCount, 1);
      }).pipe(Effect.provide(withTeams())),
    );
  });

  // CWM-003/N9/OHS-007: the active-context pointers (and team memberships) never
  // outlive the membership/team/organization they point at.
  describe("active context lifecycle (CWM-003)", () => {
    const setup = Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const owner = asCaller("owner-1");
      const member = asCaller("member-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      yield* organization.addMember({
        organizationId: org.id,
        userId: Users.UserId("member-1"),
        role: ["member"],
      });
      const team = yield* organization.createTeam(owner, org.id, "Engineering");
      yield* organization.createTeam(owner, org.id, "Design");
      yield* organization.addTeamMember(owner, org.id, team.id, Users.UserId("member-1"));
      yield* organization.setActive(member, org.id);
      yield* organization.setActiveTeam(member, team.id);
      return { organization, owner, member, org, team };
    });

    it.effect(
      "removeMember clears the removed user's active organization, team and team memberships",
      () =>
        Effect.gen(function* () {
          const { organization, owner, member, org, team } = yield* setup;
          yield* organization.removeMember(owner, org.id, Users.UserId("member-1"));

          const active = yield* organization.getActive(member);
          assert.isTrue(Option.isNone(active.activeOrganizationId));
          assert.isTrue(Option.isNone(active.activeTeamId));
          const roster = yield* organization.listTeamMembers(owner, org.id, team.id);
          assert.strictEqual(roster.length, 0);
          const teams = yield* organization.listTeams(owner, org.id);
          assert.strictEqual(teams.find((t) => t.id === team.id)?.memberCount, 0);
        }).pipe(Effect.provide(withTeams())),
    );

    it.effect("leave clears the caller's active organization, team and team memberships", () =>
      Effect.gen(function* () {
        const { organization, owner, member, org, team } = yield* setup;
        yield* organization.leave(member, org.id);

        const active = yield* organization.getActive(member);
        assert.isTrue(Option.isNone(active.activeOrganizationId));
        assert.isTrue(Option.isNone(active.activeTeamId));
        assert.strictEqual((yield* organization.listTeamMembers(owner, org.id, team.id)).length, 0);
      }).pipe(Effect.provide(withTeams())),
    );

    it.effect("delete clears every session's active organization", () =>
      Effect.gen(function* () {
        const { organization, owner, member, org } = yield* setup;
        yield* organization.setActive(owner, org.id);
        yield* organization.delete(owner, org.id);

        for (const caller of [owner, member]) {
          const active = yield* organization.getActive(caller);
          assert.isTrue(Option.isNone(active.activeOrganizationId));
          assert.isTrue(Option.isNone(active.activeTeamId));
        }
      }).pipe(Effect.provide(withTeams({ allowRemovingAllTeams: true }))),
    );

    it.effect("removeTeam clears activeTeamId but keeps the active organization", () =>
      Effect.gen(function* () {
        const { organization, owner, member, org, team } = yield* setup;
        yield* organization.removeTeam(owner, org.id, team.id);

        const active = yield* organization.getActive(member);
        assert.isTrue(Option.isNone(active.activeTeamId));
        assert.deepStrictEqual(active.activeOrganizationId, Option.some(org.id));
      }).pipe(Effect.provide(withTeams())),
    );

    it.effect(
      "getActive re-validates: a pointer at an organization the user is no longer in reads as cleared",
      () =>
        Effect.gen(function* () {
          const { organization, member, org } = yield* setup;
          const members = yield* MembershipRecords.MembershipRecords;
          const activeContext = yield* ActiveContextRecords.ActiveContextRecords;
          // Membership removed around the plugin (a stale pointer, or a row that
          // predates the userId column): the read itself must not name the org.
          yield* members.remove(Users.UserId("member-1"), org.id);

          const active = yield* organization.getActive(member);
          assert.isTrue(Option.isNone(active.activeOrganizationId));
          assert.isTrue(Option.isNone(active.activeTeamId));
          const row = yield* activeContext.findBySessionId(member.sessionId);
          assert.isTrue(Option.isSome(row) && Option.isNone(row.value.activeOrganizationId));
        }).pipe(Effect.provide(withTeams())),
    );
  });

  // MTI-010: knowing an invitation's id grants nothing — reading it needs the
  // invitee's identity (or invitation rights), accepting/rejecting needs the
  // emailed secret as well, and the secret is not the REST id.
  describe("invitation capability (MTI-010)", () => {
    const setup = Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const users = yield* Users.Users;
      const mailer = yield* Mailer.Mailer;
      const owner = asCaller("owner-1");
      const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
      const invitee = yield* users.create({ email: "invitee@example.com", name: "Invitee" });
      const stranger = yield* users.create({ email: "stranger@example.com", name: "Stranger" });
      yield* organization.addMember({
        organizationId: org.id,
        userId: Users.UserId("plain-1"),
        role: ["member"],
      });
      const invitation = yield* organization.invite(owner, org.id, {
        email: invitee.email,
        role: ["member"],
      });
      return {
        organization,
        mailer,
        owner,
        org,
        invitation,
        inviteeCaller: asCaller(invitee.id),
        strangerCaller: asCaller(stranger.id),
        plain: asCaller("plain-1"),
      };
    });

    it.effect(
      "a stranger cannot read an invitation by id (404); the invitee and an inviter can",
      () =>
        Effect.gen(function* () {
          const { organization, owner, invitation, inviteeCaller, strangerCaller, plain } =
            yield* setup;
          const strangerFailure = yield* organization
            .getInvitation(strangerCaller, invitation.id)
            .pipe(Effect.flip);
          assert.strictEqual(strangerFailure._tag, "InvitationNotFound");
          const plainFailure = yield* organization
            .getInvitation(plain, invitation.id)
            .pipe(Effect.flip);
          assert.strictEqual(plainFailure._tag, "InvitationNotFound");
          const unknown = yield* organization
            .getInvitation(strangerCaller, "no-such-invitation")
            .pipe(Effect.flip);
          assert.strictEqual(unknown._tag, "InvitationNotFound");

          assert.strictEqual(
            (yield* organization.getInvitation(inviteeCaller, invitation.id)).id,
            invitation.id,
          );
          assert.strictEqual(
            (yield* organization.getInvitation(owner, invitation.id)).id,
            invitation.id,
          );
        }).pipe(Effect.provide(buildLayer())),
    );

    it.effect("accepting without the emailed token fails even with a matching email", () =>
      Effect.gen(function* () {
        const { organization, org, invitation, inviteeCaller, owner } = yield* setup;
        const failure = yield* organization
          .acceptInvitation(inviteeCaller, invitation.id, "not-the-token")
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "InvitationNotFound");
        // The invitation's own id is not the secret either.
        const withId = yield* organization
          .acceptInvitation(inviteeCaller, invitation.id, invitation.id)
          .pipe(Effect.flip);
        assert.strictEqual(withId._tag, "InvitationNotFound");
        const members = yield* organization.listMembers(owner, org.id);
        assert.strictEqual(members.length, 2);
      }).pipe(Effect.provide(buildLayer())),
    );

    it.effect("the invitee can read by token and accept with it; a stranger cannot", () =>
      Effect.gen(function* () {
        const { organization, org, invitation, inviteeCaller, strangerCaller } = yield* setup;
        const token = yield* mailedToken(invitation.id);
        assert.notStrictEqual(token, invitation.id);
        const strangerFailure = yield* organization
          .getInvitationByToken(strangerCaller, token)
          .pipe(Effect.flip);
        assert.strictEqual(strangerFailure._tag, "InvitationNotFound");
        const landing = yield* organization.getInvitationByToken(inviteeCaller, token);
        assert.strictEqual(landing.id, invitation.id);

        const membership = yield* organization.acceptInvitation(
          inviteeCaller,
          invitation.id,
          token,
        );
        assert.strictEqual(membership.organizationId, org.id);
      }).pipe(Effect.provide(buildLayer())),
    );

    it.effect("reject also requires the token", () =>
      Effect.gen(function* () {
        const { organization, invitation, inviteeCaller } = yield* setup;
        const failure = yield* organization
          .rejectInvitation(inviteeCaller, invitation.id, "not-the-token")
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "InvitationNotFound");
        yield* organization.rejectInvitation(
          inviteeCaller,
          invitation.id,
          yield* mailedToken(invitation.id),
        );
      }).pipe(Effect.provide(buildLayer())),
    );

    it.effect("the mail names the organization; resend rotates the token", () =>
      Effect.gen(function* () {
        const { organization, mailer, owner, org, invitation, inviteeCaller } = yield* setup;
        const first = yield* mailedToken(invitation.id);
        const sentFirst = yield* mailer.sent;
        assert.strictEqual(sentFirst[0]?.data?.["organizationName"], "Acme");

        yield* organization.invite(owner, org.id, {
          email: invitation.email,
          role: ["member"],
          resend: true,
        });
        const second = yield* mailedToken(invitation.id);
        assert.notStrictEqual(first, second);

        const stale = yield* organization
          .acceptInvitation(inviteeCaller, invitation.id, first)
          .pipe(Effect.flip);
        assert.strictEqual(stale._tag, "InvitationNotFound");
        yield* organization.acceptInvitation(inviteeCaller, invitation.id, second);
      }).pipe(Effect.provide(buildLayer())),
    );
  });

  // PERS-005: the plugin authorizes itself (no qadi round trip), so its denials
  // are published into the durable AuditLog.
  describe("permission denials are audited (PERS-005)", () => {
    it.effect(
      "a denied updateMemberRole publishes auth.organization.permissionDenied (missingStatement)",
      () =>
        Effect.gen(function* () {
          const organization = yield* Organization.Organization;
          const auditLog = yield* AuditLog.AuditLog;
          const owner = asCaller("owner-1");
          const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
          yield* organization.addMember({
            organizationId: org.id,
            userId: Users.UserId("member-1"),
            role: ["member"],
          });
          yield* organization.addMember({
            organizationId: org.id,
            userId: Users.UserId("member-2"),
            role: ["member"],
          });
          const failure = yield* organization
            .updateMemberRole(asCaller("member-1"), org.id, Users.UserId("member-2"), ["member"])
            .pipe(Effect.flip);
          assert.strictEqual(failure._tag, "OrganizationPermissionDenied");

          const recorded = yield* auditLog.list({ eventTag: "auth.organization.permissionDenied" });
          assert.strictEqual(recorded.length, 1);
          assert.deepStrictEqual(recorded[0]?.actorUserId, Option.some("member-1"));
          assert.strictEqual(payloadOf(recorded[0])["reason"], "missingStatement");
          assert.strictEqual(payloadOf(recorded[0])["resource"], "member");
          assert.strictEqual(payloadOf(recorded[0])["action"], "update");
        }).pipe(Effect.provide(buildLayer())),
    );

    // ESA-005/ADR-EA-029: events carry identifiers, never the invitee's address.
    it.effect("an invitation is announced without the invitee's email", () =>
      Effect.gen(function* () {
        const organization = yield* Organization.Organization;
        const auditLog = yield* AuditLog.AuditLog;
        const owner = asCaller("owner-1");
        const org = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });
        yield* organization.invite(owner, org.id, { email: "private@example.com", role: ["member"] });

        const recorded = yield* auditLog.list({ eventTag: "auth.organization.invitationCreated" });
        assert.strictEqual(recorded.length, 1);
        assert.isFalse(JSON.stringify(recorded).includes("private@example.com"));
        assert.isFalse("email" in payloadOf(recorded[0]));
      }).pipe(Effect.provide(buildLayer())),
    );

    it.effect("a non-member's denied delete is recorded with reason notMember", () =>
      Effect.gen(function* () {
        const organization = yield* Organization.Organization;
        const auditLog = yield* AuditLog.AuditLog;
        const org = yield* organization.create({
          caller: asCaller("owner-1"),
          name: "Acme",
          slug: "acme",
        });
        yield* organization.delete(asCaller("outsider-1"), org.id).pipe(Effect.flip);
        const recorded = yield* auditLog.list({ eventTag: "auth.organization.permissionDenied" });
        assert.strictEqual(payloadOf(recorded[0])["reason"], "notMember");
      }).pipe(Effect.provide(buildLayer())),
    );
  });
});
