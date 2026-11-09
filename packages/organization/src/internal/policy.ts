// @awthaq/organization — the authorization policy of every authorized method (package-private)
//
// Plan 30 Part A. One entry per `OrganizationShape` method; `satisfies Record<keyof OrganizationShape,
// Policy>` refuses a missing and an extra key, so a new endpoint cannot ship without one. The table is
// the oracle of `AuthorizationMatrix.test.ts`, not a dispatcher: each method calls its `OrganizationAccess`
// entry point itself (`internal/access.ts` says why), and the matrix generates the probes each entry's
// `_tag`, `feature` and `scope` imply, so the implementation and the table cannot drift apart unseen.
//
// Never re-exported by `index.ts`.

import type { OrganizationShape } from "../OrganizationShape.ts";
import { type Statement, statement } from "./access.ts";

/** The optional feature an entry sits behind (PV-300: gated after membership). */
type Feature = "teams" | "roles" | undefined;

export type Policy =
  /** Anyone signed in (`checkSlug`). */
  | { readonly _tag: "Open" }
  /** The caller's own rows (`list`, `listInvitationsForUser`). */
  | { readonly _tag: "Own" }
  /** The configured creation policy (`allowUserToCreateOrganization`). */
  | { readonly _tag: "Creator" }
  /** The caller's session pointers; the active-context module holds the membership witness. */
  | { readonly _tag: "Session" }
  /** The invitee's own acts: the emailed token and the invitee's address are the capability (MTI-010). */
  | { readonly _tag: "Invitee" }
  /** Any member (`OrganizationAccess.member`, or `teamMember` behind the teams gate). */
  | { readonly _tag: "Member"; readonly feature: Feature }
  /** A statement held in scope; `confers` marks a role-conferring call bounded by the proof's ceiling. */
  | {
      readonly _tag: "Statement";
      readonly statement: Statement;
      readonly feature: Feature;
      readonly scope: "organization" | "team" | "parent" | "teamAndParent";
      readonly confers: boolean;
    }
  /** A statement on an invitation's organization, every miss answered `InvitationNotFound`. */
  | { readonly _tag: "InvitationStatement"; readonly statement: Statement }
  /** A member holding `invitation:create`, or the invitee; unaudited. */
  | { readonly _tag: "InvitationReader" };

export const policy = {
  create: { _tag: "Creator" },
  checkSlug: { _tag: "Open" },
  list: { _tag: "Own" },
  get: { _tag: "Member", feature: undefined },
  getFull: { _tag: "Member", feature: undefined },
  update: {
    _tag: "Statement",
    statement: statement("organization", "update"),
    feature: undefined,
    scope: "organization",
    confers: false,
  },
  delete: {
    _tag: "Statement",
    statement: statement("organization", "delete"),
    feature: undefined,
    scope: "organization",
    confers: false,
  },
  listMembers: { _tag: "Member", feature: undefined },
  removeMember: {
    _tag: "Statement",
    statement: statement("member", "delete"),
    feature: undefined,
    scope: "organization",
    confers: false,
  },
  updateMemberRole: {
    _tag: "Statement",
    statement: statement("member", "update"),
    feature: undefined,
    scope: "organization",
    confers: true,
  },
  leave: { _tag: "Member", feature: undefined },
  getActiveMember: { _tag: "Session" },
  getActiveMemberRole: { _tag: "Session" },
  setActive: { _tag: "Session" },
  getActive: { _tag: "Session" },
  invite: {
    _tag: "Statement",
    statement: statement("invitation", "create"),
    feature: undefined,
    scope: "organization",
    confers: true,
  },
  acceptInvitation: { _tag: "Invitee" },
  rejectInvitation: { _tag: "Invitee" },
  cancelInvitation: {
    _tag: "InvitationStatement",
    statement: statement("invitation", "cancel"),
  },
  getInvitation: { _tag: "InvitationReader" },
  getInvitationByToken: { _tag: "Invitee" },
  // Q6 (plan 30): any member may list; reading one invitation needs `invitation:create` or being the invitee.
  listInvitationsForOrganization: { _tag: "Member", feature: undefined },
  listInvitationsForUser: { _tag: "Own" },
  createRole: {
    _tag: "Statement",
    statement: statement("role", "create"),
    feature: "roles",
    scope: "organization",
    confers: true,
  },
  listRoles: {
    _tag: "Statement",
    statement: statement("role", "read"),
    feature: "roles",
    scope: "organization",
    confers: false,
  },
  getRole: {
    _tag: "Statement",
    statement: statement("role", "read"),
    feature: "roles",
    scope: "organization",
    confers: false,
  },
  updateRole: {
    _tag: "Statement",
    statement: statement("role", "update"),
    feature: "roles",
    scope: "organization",
    confers: true,
  },
  deleteRole: {
    _tag: "Statement",
    statement: statement("role", "delete"),
    feature: "roles",
    scope: "organization",
    confers: false,
  },
  createTeam: {
    _tag: "Statement",
    statement: statement("team", "create"),
    feature: "teams",
    scope: "parent",
    confers: false,
  },
  moveTeam: {
    _tag: "Statement",
    statement: statement("team", "update"),
    feature: "teams",
    scope: "teamAndParent",
    confers: false,
  },
  listTeamAncestors: { _tag: "Member", feature: "teams" },
  listTeamDescendants: { _tag: "Member", feature: "teams" },
  listTeams: { _tag: "Member", feature: "teams" },
  listUserTeams: { _tag: "Member", feature: "teams" },
  updateTeam: {
    _tag: "Statement",
    statement: statement("team", "update"),
    feature: "teams",
    scope: "team",
    confers: false,
  },
  removeTeam: {
    _tag: "Statement",
    statement: statement("team", "delete"),
    feature: "teams",
    scope: "team",
    confers: false,
  },
  listTeamMembers: { _tag: "Member", feature: "teams" },
  addTeamMember: {
    _tag: "Statement",
    statement: statement("team", "update"),
    feature: "teams",
    scope: "team",
    confers: true,
  },
  updateTeamMemberRole: {
    _tag: "Statement",
    statement: statement("team", "update"),
    feature: "teams",
    scope: "team",
    confers: true,
  },
  removeTeamMember: {
    _tag: "Statement",
    statement: statement("team", "update"),
    feature: "teams",
    scope: "team",
    confers: false,
  },
  setActiveTeam: { _tag: "Session" },
} satisfies Record<keyof OrganizationShape, Policy>;
