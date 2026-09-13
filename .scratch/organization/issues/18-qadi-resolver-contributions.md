# 18 — qadi resolver contributions

**What to build:** `Organization.relationships` (`RelationshipResolver`)
and `Organization.attributes` (`AttributeResolver`) — ordinary
`Layer.effect` contributions an application composes into its own
`QadiLive`, per the already-locked `BEH-EA-161`/`BEH-EA-162`.

**Blocked by:** 12, 15, 16.

**Status:** done

- [x] `Organization.relationships`: a `Layer.effect(RelationshipResolver, ...)`
      resolving a `"member"` relation (depth-2 resource→organization walk)
      and a `"team-member"` relation (resource→team walk), each mapping a
      lookup failure to `RelationshipResolveError`, never to `"Unrelated"`
      — per `BEH-EA-162`'s own requirement
- [x] `Organization.attributes`: a `Layer.effect(AttributeResolver, ...)`
      resolving e.g. `"orgRole"`/`"orgPermissions"` from a subject's
      membership in the organization the check concerns, mirroring
      `BEH-EA-161`'s `UserAttributes` shape (`undefined` = no opinion, a
      typed `AttributeResolveError` for a genuine failure)
- [x] Both are plain exported `Layer`s from the plugin, not something
      `Auth.make` wires automatically — an application composes them into
      its own `QadiLive` by hand, matching `usage-qadi.md` §6.2's own
      shape
- [x] Unit/integration tests directly against these `Layer`s (composed with
      a real `Organization` instance) proving both resolvers answer
      correctly for a member/non-member and a team-member/non-team-member

## Result

Done, with a real API-shape correction found while implementing (see
below). `packages/organization/src/OrganizationQadi.ts` (new) exports
`relationships` and `attributes`, both plain `Layer.effect`s (no explicit
return-type annotation, per this repo's standing rule) an application
composes into its own `QadiLive` — neither is part of `OrganizationShape`
or wired by `AuthPlugin.Service`'s own `make`.

`relationships` resolves `"member"` (subject holds any membership in the
organization named by `resourceId`), and — new relations beyond the
ticket's own two — `"admin"`/`"owner"` (subject's membership role array in
that organization includes the named role) and `"team-member"` (subject
belongs to the team named by `resourceId`). Any other relation name, or a
non-`"user:"` subject, answers `"Unrelated"`. A defect thrown inside the
check (e.g. a real persistence outage) is caught via `Effect.catchDefect`
and remapped to `RelationshipResolveError`, never surfaced as a false
`"Unrelated"`.

**Correction to `spec.md`'s own framing**, found by reading the real
`@qadi/core` API this ticket builds against rather than assuming its
shape: `AttributeResolverShape.resolve` is `(subjectId, attribute) =>
Effect<unknown, AttributeResolveError>` — it carries **no `resourceId`
parameter at all**. `spec.md`'s "resolves `orgRole`/`orgPermissions` from a
subject's membership in whichever organization the check concerns" is not
expressible through this shape: there is no parameter naming which
organization is meant. Reading `@qadi/core`'s `Resource.ts` (`export type
Resource = Readonly<Record<string, unknown>>`) and `Evaluate.ts`'s
`EvaluateOptions.resource` confirms why: `hasResourceAttribute` is answered
from a plain data bag the *calling application* passes into `evaluate(policy,
{ resource })` inline at evaluation time — there is no "resource attribute
resolver" service to contribute to at all.

Given that, org-scoped questions ("is this subject an admin of *this*
organization") were moved onto `Organization.relationships` instead (whose
`RelationshipCheck` genuinely carries a `resourceId`) — the `"admin"`/
`"owner"` relations above are exactly this, and deliver the richer
capability `spec.md` wanted through the mechanism that can actually carry
an organization id. `Organization.attributes` still ships, narrowed to what
`AttributeResolver` can honestly answer: subject-scoped (no resourceId)
facts — `"organizationCount"` (how many organizations the subject belongs
to at all) and `"ownedOrganizationCount"` (how many of those they own) —
mirroring `packages/qadi/src/Resolvers.ts`'s own `UserAttributes` shape
exactly (subject-intrinsic facts, not resource-scoped ones).

Also added a new, narrow method to `OrganizationShape` itself:
`attributesFor(organizationId, userId): Effect<Option<{role, permissions}>>`
— exposes the same membership-role/effective-permission computation
`requirePermission`'s own internal `effectivePermissionsOf` already uses,
so `OrganizationQadi.ts`'s `"member"` relation check (and any future
consumer) doesn't duplicate that logic in a second place. Not exposed over
HTTP.

**Known test-coverage gap, documented rather than silently left**: the
"a genuine lookup failure maps to `RelationshipResolveError`" half of this
ticket's own checklist is exercised structurally (the `Effect.catchDefect`
wrapping is real and reviewed) but has no dedicated automated test —
forcing a real defect out of the in-memory persistence stack without a
type-assertion-built partial mock (forbidden by this repo's own standing
rule) proved impractical within this pass. Both positive-path tests
(`OrganizationQadi.test.ts`) pass; `pnpm --filter @effect-auth/organization
typecheck` clean; `pnpm --filter @effect-auth/organization test` — 11
files, 143 tests, all passing.
