# 00 — better-auth Organization plugin feature inventory

**Type:** research
**Status:** resolved
**Blocked by:** None — can start immediately

## Question

What is the full, exhaustive feature/schema/config surface of better-auth's
real Organization plugin (organizations, members, invitations, roles &
permissions incl. dynamic access control, teams, hooks, client API, config
options, documented edge cases)? This grounds every other ticket's scope so
"cover all the better-auth features" has a concrete checklist to work from.

## Answer

Source: `https://better-auth.com/docs/plugins/organization` (single page;
also covers Dynamic Access Control and Teams — no separate pages). The
better-auth `admin` plugin is confirmed unrelated (site-wide user admin,
not organization roles).

- **Entities**: `organization` (`id`, `name`, `slug` unique, `logo?`,
  `metadata?`, `createdAt`); `member` (`id`, `userId`, `organizationId`,
  `role` — comma-separated string, can hold multiple roles, `createdAt`);
  `invitation` (`id`, `email`, `inviterId`, `organizationId`, `role?`,
  `status`, `createdAt`, `expiresAt`, `teamId?` if teams enabled);
  `organizationRole` (dynamic-ac only: `id`, `organizationId`, `role` name,
  `permission` serialized, timestamps); `team` (`id`, `name`,
  `memberCount`, `organizationId`, timestamps); `teamMember` (`id`,
  `teamId`, `userId`, `membershipKey?`, `createdAt?`); `session` gains
  `activeOrganizationId?`/`activeTeamId?`. All tables support
  `additionalFields` via `schema.<table>`.

- **Org CRUD**: create (`name`/`slug`/`logo?`/`metadata?`/`userId?`
  server-only/`keepCurrentActiveOrganization?`), check-slug, list, get
  (metadata only) vs get-full-organization (+members/invitations,
  `membersLimit?`), update, delete (cascades; `disableOrganizationDeletion`
  can disable entirely; `beforeDeleteOrganization`/`afterDeleteOrganization`
  hooks), set-active (`organizationId?`/`organizationSlug?`/`null`).
  Limits: `organizationLimit` (max per user), `membershipLimit` (max
  members per org, default 100).

- **Membership**: list-members (pagination/sort/filter), remove-member,
  update-member-role (gated by caller permission), add-member
  (server-only, no invite), get-active-member(-role), leave. **No built-in
  "org must have ≥1 owner" enforcement** — better-auth leaves this to the
  app (only shows a `beforeUpdateMemberRole` example pattern). `creatorRole`
  config: role assigned to creator, `admin`|`owner`, default `owner`.

- **Roles & permissions**: default roles `owner` (full control incl.
  delete/ownership-transfer), `admin` (full control except delete/ownership),
  `member` (read-only). Multi-role via comma-separated `member.role`.
  Default permission statements: `organization:[update,delete]`,
  `member:[create,update,delete]`, `invitation:[create,cancel]`. Custom via
  `createAccessControl(statement)` (from `better-auth/plugins/access`) +
  `ac.newRole(...)`; custom roles override defaults unless merged back in.
  `hasPermission` (server, async, dynamic-role-aware) vs
  `checkRolePermission` (client, sync, **not** dynamic-role-aware).
  **Dynamic Access Control** (`dynamicAccessControl: {enabled, maximumRolesPerOrganization}`):
  runtime-created custom roles persisted in `organizationRole`
  (create/delete/update/list/get, gated by `ac:create`/`ac:read`
  permissions, default only `admin`/`owner` have `ac:create`; **cannot
  self-grant permissions beyond what the creator already holds**).

- **Invitations**: app supplies `sendInvitationEmail(data)`; invite (email,
  role, `organizationId?`, `resend?`, `teamId?` — re-inviting an existing
  invite is a no-op unless `resend`; inviting an existing member cancels
  any prior invite), accept (session email must match), reject, cancel,
  get, list(org), list(user) (client requires verified session email;
  server variant takes arbitrary `email`). Config: `invitationExpiresIn`
  (default 48h/172800s), `invitationLimit` (default 100),
  `cancelPendingInvitationsOnReInvite` (default false),
  `requireEmailVerificationOnInvitation` (heuristic: auto-required when
  invitation IDs are guessable/predictable). Not documented: what happens
  to a pending invitation if its org is deleted mid-flight.

- **Teams**: `teams.enabled` (+ `maximumTeams`, `maximumMembersPerTeam`,
  `allowRemovingAllTeams` default false — blocks deleting the last team).
  create/list/update/remove-team, set-active-team, list-user-teams (gated
  by `member:update` for others), list/add/remove-team-member. Permissions
  `team:create/update/delete` default to owner/admin only. Teams do **not**
  get their own resource ACL in better-auth — they reuse the org's overall
  permission system, only team *management* actions are separately gated.

- **Hooks**: `organizationHooks.before*/after*` for every org/member/
  invitation/team operation (before-hooks can throw to abort, or return
  `{data}` to amend the payload); separately, `databaseHooks.session.create.before`
  is the documented mechanism for seeding `activeOrganizationId` at session
  creation.

- **Client API**: `authClient.organization.*` mirrors every server
  endpoint 1:1, plus `useActiveOrganization()`/`useListOrganizations()`
  reactive hooks, `inferOrgAdditionalFields`. Not directly relevant to this
  map — effect-auth derives its client from the plugin's own `HttpApi`
  contract rather than a bespoke per-plugin client SDK surface.

- **Full config option list**: `allowUserToCreateOrganization`,
  `organizationLimit`, `creatorRole`, `membershipLimit`,
  `sendInvitationEmail`, `invitationExpiresIn`, `invitationLimit`,
  `cancelPendingInvitationsOnReInvite`, `requireEmailVerificationOnInvitation`,
  `disableOrganizationDeletion`, `organizationHooks`, `ac`/`roles`,
  `dynamicAccessControl`, `teams`, `schema`.

This inventory is the checklist tickets 02–08 scope their own decisions
against — see the map's own Notes section.
