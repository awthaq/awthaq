# 03 — Organization/membership core schema and CRUD semantics

**Type:** grilling
**Status:** resolved
**Blocked by:** None — can start immediately

## Question

Lock the exact table shapes and CRUD behavior for the non-team,
non-dynamic-ac core of the plugin, translating better-auth's
`organization`/`member` schema (ticket 00) into effect-auth's own
conventions (plugin-prefixed table names, `Schema.TaggedError` contract
errors, a `Context.Reference` config pattern like `AdminConfig`):

- Exact fields on `organization` and `organization_membership` (effect-auth's
  own naming, not necessarily better-auth's `member`), including whether
  role is a single value or effect-auth's own multi-role shape
- `create`/`update`/`delete`/`list`/`get`(-full)/`check-slug`/`set-active`
  semantics and error cases (slug collision, not-found, not-a-member)
- `organizationLimit`/`membershipLimit` config knobs and where each is
  enforced
- The owner invariant (map decision: enforce natively, stricter than
  better-auth) — exactly which operations check it (remove-member,
  update-member-role, leave) and what typed error it fails with
- `creatorRole` config (owner|admin, default owner)

## Answer

Resolved directly by `/to-spec`, folded into `.scratch/organization/spec.md`'s
"Implementation Decisions" (§ Organization entity & CRUD; § Membership).
Summary: `organization` (id/name/slug-unique/logo?/metadata?/createdAt),
`organization_membership` (id/userId/organizationId/role-as-array/createdAt).
Multi-role membership (array, not a single value). Owner invariant enforced
natively — remove-member/update-member-role/leave all reject if the target
is the organization's last `owner`. `creatorRole`/`organizationLimit`/
`membershipLimit` config knobs as decided in the spec.
