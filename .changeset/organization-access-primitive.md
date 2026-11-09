---
"@awthaq/organization": minor
---

The organization's authorized interface authorizes through one primitive, and every statement-gated endpoint audits a non-member's attempt.

- Every organization-scoped method of `Organization` takes an access proof from one package-private module before it calls a system interface. The order (the organization is active, the caller is a member, the feature gate, the statement) is written once, so a non-member's answer never depends on the endpoint or on an optional feature (ADR-EA-040 decision 6).
- `removeMember`, `updateMemberRole`, `cancelInvitation` and the seven team writes now record a non-member's attempt as `auth.organization.permissionDenied` with reason `notMember`, as `update`, `delete`, `invite` and the role endpoints already did (PERS-005).
- A team role held in another organization no longer counts toward a team statement checked under this organization's path. A team write naming another organization's team now answers `403 OrganizationPermissionDenied` to a member lacking the statement at this organization's level (it was `404 TeamNotFound`); nothing was ever written (BEH-EA-284).
- `OrganizationActor.user` is removed, and `OrganizationActor.Bound.Ceiling(…)` needs `OrganizationActor.CeilingStatements`, which only `OrganizationAuthority` mints. `OrganizationAuthority` gains `scopedStatements`, `scopedCeiling` and `holds`.

Migration: build a user actor with `OrganizationActor.ActorSchema.cases.User.make({ userId, sessionId })` if a system call needs one. Replace `OrganizationActor.Bound.Ceiling({ statements })` with `OrganizationAuthority.ceilingOf(organizationId, roles)`; `Bound.Unbounded()` is unchanged. Expect additional `auth.organization.permissionDenied` audit rows with reason `notMember`.
