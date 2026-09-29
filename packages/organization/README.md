# @awthaq/organization

Multi-tenancy: organizations, memberships with built-in / static / dynamic per-organization roles, teams, invitations, lifecycle hooks and a qadi relationship/attribute resolver — the capability set of better-auth's organization plugin. Design: [`.scratch/organization/spec.md`](../../.scratch/organization/spec.md); the record model is in [`spec/models/14-organization.md`](../../spec/models/14-organization.md).

**Roles.** `owner` is strictly above `admin` (only an owner may delete the organization); `member` holds no mutating statements. Every role-assignment path — `updateMemberRole`, `invite`, `createRole`/`updateRole` — is bounded by `PermissionEngine.canGrant` (a caller confers only statements it holds) and rejects unknown role names. `owner`/`admin`/`member` and `OrganizationConfig.permissionStatements` names are reserved: a dynamic role cannot take them. `addMember` is a trusted server-side primitive (SCIM/import): it skips the grant guard but still rejects unknown roles and existing members.

**Configuration** (`Organization.config({...})`): `creatorRole`, `allowUserToCreateOrganization`, `organizationLimit`, `membershipLimit`, `disableOrganizationDeletion`, `permissionStatements` (custom static roles), `dynamicAccessControl` (`enabled`, `maximumRolesPerOrganization`), `teams` (`enabled`, `maximumTeams`, `maximumMembersPerTeam`, `allowRemovingAllTeams`), `invitationExpiresIn`, `invitationLimit`, `cancelPendingInvitationsOnReInvite`, `requireEmailVerificationOnInvitation`.

**HTTP surface** (`OrganizationApi`, all behind `Api.Authentication`): create / list / `check-slug` / get / `full` / update / delete; members (list, remove, `PATCH` role, `leave`); active context (`active`, `active-team`, `active-member`, `active-member/role`); invitations (create, list, get, `by-token/:token`, accept, reject, cancel — accept/reject need the emailed token); dynamic roles (CRUD); teams (CRUD, members, `mine`). A non-member gets `404 OrganizationNotFound` for every `/organization/:id/*` (byte-identical to an unknown id); `403` is reserved for a member lacking a statement.

**Persistence and atomicity.** `layerMemory` / `layerSql` records, plus `Organization.migrations` (`UNIQUE(userId, organizationId)`, `UNIQUE(teamId, userId)`, an indexed `userId` on `organization_active_context`, hashed invitation tokens). `Organization.layer` requires `SqlTransaction` (`layerNoop` in memory): organization/team deletion and member removal are one transaction, and removing a member also clears their active context and team memberships.

**The qadi contribution** (`OrganizationQadi`, composed by hand into your `QadiLive`):

| Relation | Meaning |
|---|---|
| `member` | a membership in the organization (`resourceId`; at `depth >= 1`, the organization your `ResourceOrganizationLookup` resolves it to) |
| `has-role:<name>` (and `admin` / `owner`) | the membership holds that role, of any kind |
| `<resource>:<action>` (e.g. `member:update`) | the membership's effective statements include it — the same computation the plugin's own gating uses |
| `team-member` | the subject is on the team `resourceId` names |

Anything else, or an id that names no organization/team, answers `"Unknown"`. `relationships` **requires** a `ResourceOrganizationLookup` — provide `ResourceOrganizationLookup.layerNone` if you never walk from non-organization resources. `attributes` answers `organizationCount` / `ownedOrganizationCount`. Denials of the plugin's own gating are published as `auth.organization.permissionDenied` into the `AuditLog`.

Erasure: `Organization.beforeUserDeleteErasure` (provide once, application-wide) sweeps a deleted user's memberships and active-context rows.

Global roles versus organization roles: [ADR-EA-017](../../spec/decisions/017-global-roles-vs-organization-roles.md).
