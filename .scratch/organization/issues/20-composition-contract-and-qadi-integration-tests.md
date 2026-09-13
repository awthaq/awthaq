# 20 — Composition, plugin contract tests, and qadi integration

**What to build:** certify the whole `Organization` plugin as a legal,
composable, fully-wired unit — the same closing role
`packages/admin/test/AuthHttp.test.ts` played for `Admin`, plus the one
genuinely new seam this plugin needs: proving ticket 18's contributed
resolvers actually work once composed into a real policy.

**Blocked by:** 10, 11, 12, 13, 14, 15, 16, 17, 18, 19.

**Status:** done

- [x] `AuthComposition.test.ts`: `Auth.make([Organization])` composes;
      manifest's `tables`/`dependsOn` are correct
- [x] `TestAuth.runPluginContractTests` passes for `Organization` (table
      prefixes, no host-id collision, deterministic migrations, contract
      stability across config option values — mirroring
      `packages/admin/test/AuthHttp.test.ts`'s own `runPluginContractTests`
      block)
- [x] A qadi-integration test: compose ticket 18's `Organization.relationships`/
      `Organization.attributes` `Layer`s into a real (or realistically
      test-shaped) qadi policy layer and prove `hasRelationship`/
      `hasResourceAttribute`-style checks answer correctly for a real
      `Organization` instance with real membership/team data — mirroring
      `usage-qadi.md` §7's own worked example
- [x] Full `packages/organization` test suite passes; `pnpm typecheck`/
      `pnpm lint`/`pnpm format:check` clean workspace-wide

## Result

Done. `AuthComposition.test.ts` already asserted `Auth.make([Organization])`
composes with the correct manifest (all 7 `organization_*` tables,
`dependsOn: []`) since ticket 09's own landing — verified still accurate,
no changes needed. `AuthHttp.test.ts` already carried a
`TestAuth.runPluginContractTests` block (added during ticket 11's own wire-
level test work) using the same `vitestFramework` adapter pattern
`packages/admin/test/AuthHttp.test.ts` establishes — verified it passes
(table prefixes, no host-id collision, deterministic migrations, contract
stability). `options: [{}]` (a single entry) is correct as-is, not an
omission: `Organization`'s `HttpApi` contract is a fixed value regardless of
config (config gates runtime *behavior* — e.g. whether `teams`/
`dynamicAccessControl` endpoints actually do anything — never which
endpoints exist on the contract), so multiple option entries would assert
the same fixed-contract property redundantly.

Added `packages/organization/test/OrganizationQadiPolicy.test.ts` (new,
this ticket's own genuinely new seam): two tests evaluating a real
`@qadi/core` policy (`hasRelationship("member")`/`hasRelationship("team-member")`
via the real `evaluate` function, `EvaluationServicesNone` for every other
optional port's fail-closed default, `Organization.relationships` shadowing
the default `RelationshipResolverNever`) against a real `Organization`
instance with real membership/team data — proving a real member is
`isAllowed`, a real stranger is not, mirroring `usage-qadi.md` §7's own
worked example. (`hasResourceAttribute` was not exercised here — per
ticket 18's own documented API-shape correction, `AttributeResolver` in the
real `@qadi/core` carries no `resourceId` at all, so `Organization.attributes`
answers only subject-scoped facts and was already fully proven via direct
`.resolve()` calls in `OrganizationQadi.test.ts`; there is no
`hasResourceAttribute`-over-`Organization.attributes` case to write, since
that policy leaf reads a resource data bag the caller supplies inline, not
any contributed resolver.)

**Full verification gate** (workspace-wide):
- `pnpm --filter @effect-auth/organization typecheck` — clean
- `pnpm exec tsc -p tsconfig.test.json` — clean
- `pnpm --filter @effect-auth/organization test` — 13 files, 147 tests, all
  passing
- Full workspace `pnpm typecheck` / `pnpm lint` / `pnpm format:check` /
  `pnpm test` — see this effort's own final commit for the exact numbers;
  all green with no regressions outside `packages/organization`.

## Code review fixes (applied after all 12 tickets landed)

Two parallel reviews (Standards, Spec-fidelity) ran against the full diff.
All four confirmed findings were fixed and re-verified (workspace-wide
`pnpm typecheck`/`pnpm lint`/`pnpm format:check`/`pnpm test` — 61 files, 519
tests, all green):

- **Standards**: two `Effect.Effect<...>`-annotated locals in `Organization.ts`
  (`requireDynamicAccessControlEnabled`, `requireTeamsEnabled`) had their
  explicit return-type annotations removed, per this repo's standing rule.
- **Standards**: `OrganizationSlugTaken`/`OrgRoleNameTaken` were each defined
  twice — once as a persistence-layer `Data.TaggedError`
  (`OrganizationRecords.ts`/`OrgRoleRecords.ts`) and once as the contract-layer
  `Schema.TaggedError` (`OrganizationApi.ts`) — sharing the same `_tag`
  string, the exact class of bug this codebase already hit once during the
  `Admin` plugin. Renamed the persistence-layer classes to
  `OrganizationRecordSlugTaken`/`OrgRoleRecordNameTaken` (matching the
  `*RecordNotFound` naming convention every other persistence error in this
  plugin already follows) and updated every `catchTag`/test call site.
- **Spec (real correctness bug)**: `getFull`, `listMembers`, and
  `listInvitationsForOrganization` performed no membership check at all —
  any authenticated user of the host app, not just a member, could read
  another organization's full member roster and pending invitation emails
  by id. Added a `requireMembership` check (any member may read; no
  statement-level permission required) to all three, threaded a `caller`
  parameter through `listMembers`/`listInvitationsForOrganization` (`getFull`
  already had one, unused), added `OrganizationPermissionDenied` to all
  three contract endpoints' error unions, and added a regression test
  proving a non-member is denied and a real member is not.
- **Spec (real correctness bug)**: `organizationLimit` counted a caller's
  existing memberships by filtering on the literal role name `"owner"`,
  so the cap became silently unenforceable whenever `creatorRole` was
  configured to `"admin"` (a documented, supported config value). Fixed to
  filter on `orgConfig.creatorRole` instead, with a regression test
  combining both config knobs.
