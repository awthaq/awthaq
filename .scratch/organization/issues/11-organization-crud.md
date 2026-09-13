# 11 — Organization CRUD

**What to build:** the first full tracer bullet — create an organization
over real HTTP, read it back, update and delete it — establishing the
`organization` table, its persistence layer (`layerMemory` + `layerSql`,
mirroring `ImpersonationRecords.ts`'s own pattern), and the contract
endpoints, gated by ticket 10's permission engine.

**Blocked by:** 10.

**Status:** done

- [x] `organization` table/persistence module: `id`, `name`, `slug`
      (unique), `logo?`, `metadata?`, `createdAt` — both `layerMemory` and
      `layerSql`, table name plugin-prefixed
- [x] `create` assigns the creator a membership with the configured
      `creatorRole` (default `owner`) — note: this ticket may stub a
      minimal internal membership-creation call ticket 12 will fully own;
      keep the seam narrow (creating an org always produces exactly one
      membership row for its creator)
- [x] `create` rejects a slug collision with a typed contract error;
      `checkSlug` exists as its own endpoint
- [x] `update`/`delete`/`list`(caller's own orgs)/`get`(metadata only)/
      `getFull` (metadata + paginated members + pending invitations) all
      exist; `delete` is gated by the permission engine and can be
      disabled entirely via `disableOrganizationDeletion`
- [x] `organizationLimit` (max orgs per creator) and
      `allowUserToCreateOrganization` config knobs are enforced on `create`
- [x] Publishes `auth.organization.created`/`updated`/`deleted` audit
      events (new entries in `AuthEvents.ts`'s closed union)
- [x] Persistence-layer contract-suite test (both layers) +
      `packages/organization/test/Organization.test.ts` domain-level
      coverage for every case above + a wire-level HTTP test
      (`AuthHttp.test.ts`, started here, extended by later tickets) proving
      create→get→update→delete over a real `HttpRouter`

## Result

Done. `OrganizationRecords.ts` persists the `organization_org` table
(`id`/`name`/`slug`-unique/`logo?`/`metadata?`/`createdAt`), both layers,
mirroring `ImpersonationRecords.ts`'s own `layerMemory`/`layerSql` shape.
`Organization.ts`'s `create` builds the org row then immediately creates
the creator's own membership (ticket 12's `MembershipRecords`, landed in
the same pass) with role `[creatorRole]`; `organizationLimit` counts the
caller's existing owned memberships, `allowUserToCreateOrganization` gates
up front. `checkSlug`/`list`/`get`/`getFull`/`update`/`delete` all exist;
`delete` is gated by the permission engine, respects
`disableOrganizationDeletion`, and cascades `MembershipRecords.removeAllForOrganization`
before removing the org row. `auth.organization.created`/`updated`/`deleted`
(plus `memberAdded`/`memberRemoved`/`memberRoleUpdated` for ticket 12's own
operations) added to `AuthEvents.ts`'s closed union. Covered by
`OrganizationRecords.test.ts` (both layers), `Organization.test.ts`
(domain-level), and `AuthHttp.test.ts` (wire-level: full create→get→update→delete,
slug-collision 409, permission-denied 403, plus `runPluginContractTests`).

**Correction**: `getFull` currently returns `{organization, members}` only
— the "pending invitations" half of the checklist can't be built yet since
`InvitationRecords` doesn't exist until ticket 14 (a later phase of this
same implementation effort, not yet run). `getFull`'s return shape and its
`GetFullResult` DTO are structured so ticket 14 can add an `invitations`
field additively without reshaping anything already shipped.

**Deviation**: the persistence-layer error class and the contract-layer
error class both happened to be named `OrganizationSlugTaken` (same
`_tag`, different shape — one carries a `slug` field, the API one carries
none). Because they share a tag string, this slipped past the type
checker without a compile error but failed at runtime (`SchemaError:
Expected OrganizationSlugTaken`) until `Organization.ts`'s `create`/`update`
explicitly `catchTag`s the persistence error and re-raises the
contract-layer one. Worth a note for later tickets: never let a
persistence-layer error and its contract-layer counterpart share a tag
string without an explicit remap at the boundary.
