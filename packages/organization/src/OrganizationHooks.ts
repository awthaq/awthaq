// @effect-auth/organization — OrganizationHooks
//
// Ticket 19 / spec.md's "Lifecycle hooks": one `veto` (before) + `observe`
// (after) `HookPoint` per mutating operation this plugin exposes —
// `Organization` is the first real plugin consumer of the core
// `HookPoint` mechanism (`packages/core/src/HookPoint.ts`,
// `BEH-EA-089`–`096`); there is no prior plugin example to mirror.
//
// Each `Input` is a plain `Schema.Struct` carrying that operation's own
// payload/context (a type carrier only — `HookPoint.ts`'s own header
// comment: never decoded here). Each `observe` point's schema additionally
// carries the resulting record, per the ticket's own requirement.
//
// A `veto` tap may fail with `HookPoint.HookAbort` (BEH-EA-090). This
// plugin's own design decision (documented in ticket 19's `## Result`):
// an abort is converted to a defect (`Effect.orDie`) right where the veto
// runs, inside `Organization.ts`'s own operation — never propagated as a
// typed `OrganizationShape`/`OrganizationApi` contract error. This keeps
// the wire contract's error surface exactly what it already was (no new
// per-operation "aborted" error to design and thread through 15 endpoints)
// while still giving an application a real way to block an operation
// outright by tapping the veto point and failing.
import { HookPoint } from "@effect-auth/core";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const RoleArray = Schema.Array(Schema.String);

// ---- organization ---------------------------------------------------------

const CreateOrganizationInput = Schema.Struct({
  callerId: Schema.String,
  name: Schema.String,
  slug: Schema.String,
});
const CreateOrganizationResult = Schema.Struct({
  ...CreateOrganizationInput.fields,
  organizationId: Schema.String,
});
export class BeforeCreateOrganization extends HookPoint.veto<BeforeCreateOrganization>()(
  "organization.create.before",
  CreateOrganizationInput,
) {}
export class AfterCreateOrganization extends HookPoint.observe<AfterCreateOrganization>()(
  "organization.create.after",
  CreateOrganizationResult,
) {}

const UpdateOrganizationInput = Schema.Struct({
  organizationId: Schema.String,
  name: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
});
export class BeforeUpdateOrganization extends HookPoint.veto<BeforeUpdateOrganization>()(
  "organization.update.before",
  UpdateOrganizationInput,
) {}
export class AfterUpdateOrganization extends HookPoint.observe<AfterUpdateOrganization>()(
  "organization.update.after",
  UpdateOrganizationInput,
) {}

const DeleteOrganizationInput = Schema.Struct({ organizationId: Schema.String });
export class BeforeDeleteOrganization extends HookPoint.veto<BeforeDeleteOrganization>()(
  "organization.delete.before",
  DeleteOrganizationInput,
) {}
export class AfterDeleteOrganization extends HookPoint.observe<AfterDeleteOrganization>()(
  "organization.delete.after",
  DeleteOrganizationInput,
) {}

// ---- membership -------------------------------------------------------------

const AddMemberInput = Schema.Struct({
  organizationId: Schema.String,
  userId: Schema.String,
  role: RoleArray,
});
export class BeforeAddMember extends HookPoint.veto<BeforeAddMember>()(
  "organization.member.add.before",
  AddMemberInput,
) {}
export class AfterAddMember extends HookPoint.observe<AfterAddMember>()(
  "organization.member.add.after",
  AddMemberInput,
) {}

const RemoveMemberInput = Schema.Struct({ organizationId: Schema.String, userId: Schema.String });
export class BeforeRemoveMember extends HookPoint.veto<BeforeRemoveMember>()(
  "organization.member.remove.before",
  RemoveMemberInput,
) {}
export class AfterRemoveMember extends HookPoint.observe<AfterRemoveMember>()(
  "organization.member.remove.after",
  RemoveMemberInput,
) {}

const UpdateMemberRoleInput = Schema.Struct({
  organizationId: Schema.String,
  userId: Schema.String,
  role: RoleArray,
});
export class BeforeUpdateMemberRole extends HookPoint.veto<BeforeUpdateMemberRole>()(
  "organization.member.updateRole.before",
  UpdateMemberRoleInput,
) {}
export class AfterUpdateMemberRole extends HookPoint.observe<AfterUpdateMemberRole>()(
  "organization.member.updateRole.after",
  UpdateMemberRoleInput,
) {}

// ---- invitations --------------------------------------------------------------

const CreateInvitationInput = Schema.Struct({
  organizationId: Schema.String,
  email: Schema.String,
  role: RoleArray,
});
const CreateInvitationResult = Schema.Struct({
  ...CreateInvitationInput.fields,
  invitationId: Schema.String,
});
export class BeforeCreateInvitation extends HookPoint.veto<BeforeCreateInvitation>()(
  "organization.invitation.create.before",
  CreateInvitationInput,
) {}
export class AfterCreateInvitation extends HookPoint.observe<AfterCreateInvitation>()(
  "organization.invitation.create.after",
  CreateInvitationResult,
) {}

const InvitationIdInput = Schema.Struct({ invitationId: Schema.String });
const AcceptInvitationResult = Schema.Struct({
  invitationId: Schema.String,
  organizationId: Schema.String,
  userId: Schema.String,
});
export class BeforeAcceptInvitation extends HookPoint.veto<BeforeAcceptInvitation>()(
  "organization.invitation.accept.before",
  InvitationIdInput,
) {}
export class AfterAcceptInvitation extends HookPoint.observe<AfterAcceptInvitation>()(
  "organization.invitation.accept.after",
  AcceptInvitationResult,
) {}

export class BeforeRejectInvitation extends HookPoint.veto<BeforeRejectInvitation>()(
  "organization.invitation.reject.before",
  InvitationIdInput,
) {}
export class AfterRejectInvitation extends HookPoint.observe<AfterRejectInvitation>()(
  "organization.invitation.reject.after",
  InvitationIdInput,
) {}

export class BeforeCancelInvitation extends HookPoint.veto<BeforeCancelInvitation>()(
  "organization.invitation.cancel.before",
  InvitationIdInput,
) {}
export class AfterCancelInvitation extends HookPoint.observe<AfterCancelInvitation>()(
  "organization.invitation.cancel.after",
  InvitationIdInput,
) {}

// ---- dynamic roles --------------------------------------------------------------

const CreateRoleInput = Schema.Struct({
  organizationId: Schema.String,
  role: Schema.String,
});
const CreateRoleResult = Schema.Struct({ ...CreateRoleInput.fields, roleId: Schema.String });
export class BeforeCreateRole extends HookPoint.veto<BeforeCreateRole>()(
  "organization.role.create.before",
  CreateRoleInput,
) {}
export class AfterCreateRole extends HookPoint.observe<AfterCreateRole>()(
  "organization.role.create.after",
  CreateRoleResult,
) {}

const UpdateRoleInput = Schema.Struct({ organizationId: Schema.String, roleId: Schema.String });
export class BeforeUpdateRole extends HookPoint.veto<BeforeUpdateRole>()(
  "organization.role.update.before",
  UpdateRoleInput,
) {}
export class AfterUpdateRole extends HookPoint.observe<AfterUpdateRole>()(
  "organization.role.update.after",
  UpdateRoleInput,
) {}

const DeleteRoleInput = Schema.Struct({ organizationId: Schema.String, roleId: Schema.String });
export class BeforeDeleteRole extends HookPoint.veto<BeforeDeleteRole>()(
  "organization.role.delete.before",
  DeleteRoleInput,
) {}
export class AfterDeleteRole extends HookPoint.observe<AfterDeleteRole>()(
  "organization.role.delete.after",
  DeleteRoleInput,
) {}

// ---- teams --------------------------------------------------------------------

const CreateTeamInput = Schema.Struct({ organizationId: Schema.String, name: Schema.String });
const CreateTeamResult = Schema.Struct({ ...CreateTeamInput.fields, teamId: Schema.String });
export class BeforeCreateTeam extends HookPoint.veto<BeforeCreateTeam>()(
  "organization.team.create.before",
  CreateTeamInput,
) {}
export class AfterCreateTeam extends HookPoint.observe<AfterCreateTeam>()(
  "organization.team.create.after",
  CreateTeamResult,
) {}

const UpdateTeamInput = Schema.Struct({
  organizationId: Schema.String,
  teamId: Schema.String,
  name: Schema.String,
});
export class BeforeUpdateTeam extends HookPoint.veto<BeforeUpdateTeam>()(
  "organization.team.update.before",
  UpdateTeamInput,
) {}
export class AfterUpdateTeam extends HookPoint.observe<AfterUpdateTeam>()(
  "organization.team.update.after",
  UpdateTeamInput,
) {}

const DeleteTeamInput = Schema.Struct({ organizationId: Schema.String, teamId: Schema.String });
export class BeforeDeleteTeam extends HookPoint.veto<BeforeDeleteTeam>()(
  "organization.team.delete.before",
  DeleteTeamInput,
) {}
export class AfterDeleteTeam extends HookPoint.observe<AfterDeleteTeam>()(
  "organization.team.delete.after",
  DeleteTeamInput,
) {}

const TeamMemberInput = Schema.Struct({
  organizationId: Schema.String,
  teamId: Schema.String,
  userId: Schema.String,
});
export class BeforeAddTeamMember extends HookPoint.veto<BeforeAddTeamMember>()(
  "organization.team.member.add.before",
  TeamMemberInput,
) {}
export class AfterAddTeamMember extends HookPoint.observe<AfterAddTeamMember>()(
  "organization.team.member.add.after",
  TeamMemberInput,
) {}

export class BeforeRemoveTeamMember extends HookPoint.veto<BeforeRemoveTeamMember>()(
  "organization.team.member.remove.before",
  TeamMemberInput,
) {}
export class AfterRemoveTeamMember extends HookPoint.observe<AfterRemoveTeamMember>()(
  "organization.team.member.remove.after",
  TeamMemberInput,
) {}

/**
 * Every hook point's own default (no-tap) layer, merged into one. An
 * application composing `Organization.layer` needs this once — no
 * individual point's `.layer` needs providing separately unless the app
 * also wants to `.tap(...)` it, which merges in alongside this (taps and
 * a point's own `.layer` are independent Effects over the same shared,
 * module-scoped registry — see `HookPoint.ts`'s own header comment).
 */
export const OrganizationHooksLive = Layer.mergeAll(
  BeforeCreateOrganization.layer,
  AfterCreateOrganization.layer,
  BeforeUpdateOrganization.layer,
  AfterUpdateOrganization.layer,
  BeforeDeleteOrganization.layer,
  AfterDeleteOrganization.layer,
  BeforeAddMember.layer,
  AfterAddMember.layer,
  BeforeRemoveMember.layer,
  AfterRemoveMember.layer,
  BeforeUpdateMemberRole.layer,
  AfterUpdateMemberRole.layer,
  BeforeCreateInvitation.layer,
  AfterCreateInvitation.layer,
  BeforeAcceptInvitation.layer,
  AfterAcceptInvitation.layer,
  BeforeRejectInvitation.layer,
  AfterRejectInvitation.layer,
  BeforeCancelInvitation.layer,
  AfterCancelInvitation.layer,
  BeforeCreateRole.layer,
  AfterCreateRole.layer,
  BeforeUpdateRole.layer,
  AfterUpdateRole.layer,
  BeforeDeleteRole.layer,
  AfterDeleteRole.layer,
  BeforeCreateTeam.layer,
  AfterCreateTeam.layer,
  BeforeUpdateTeam.layer,
  AfterUpdateTeam.layer,
  BeforeDeleteTeam.layer,
  AfterDeleteTeam.layer,
  BeforeAddTeamMember.layer,
  AfterAddTeamMember.layer,
  BeforeRemoveTeamMember.layer,
  AfterRemoveTeamMember.layer,
);
