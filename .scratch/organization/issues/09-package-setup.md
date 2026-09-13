# 09 — Package setup & scaffolding

**What to build:** `@effect-auth/organization`'s real dependencies and skeleton
in place — the `Organization` plugin class, `OrganizationApi.ts` contract
shell, and persistence module stubs exist and compose with `Auth.make`,
mirroring `@effect-auth/admin`'s own package shape exactly (`package.json`
deps, `AuthPlugin.Service` skeleton, `HttpApiGroup`/`HttpApi` shell).

**Blocked by:** None — can start immediately.

**Status:** done

- [x] `packages/organization/package.json` gains `@qadi/core` (dependency)
      and whatever devDependencies its own tests need
      (`@effect/platform-node`, `@effect/sql-sqlite-node`,
      `@effect-auth/test`), mirroring `@effect-auth/admin`'s own
      `package.json`
- [x] `OrganizationApi.ts` exists with an empty-but-real `HttpApiGroup`/
      `HttpApi`, ready for later tickets to add endpoints to
- [x] `Organization extends AuthPlugin.Service<...>()("organization", {...})`
      exists (`dependsOn: []`, matching `Admin`'s/`Passkey`'s corrected
      convention), with an empty `OrganizationShape` and a passing
      `AuthComposition.test.ts` proving `Auth.make([Organization])` composes
- [x] `OrganizationConfig` (`Context.Reference`, fail-open defaults per
      `spec.md`) and its `config(partial)` override exist, mirroring
      `AdminConfig`/`PasswordConfig`
- [x] `index.ts` exports `Organization`, `OrganizationApi`

## Result

Done, in the same pass as tickets 10–12 (the plugin skeleton, config, and
first real operations landed together rather than as a genuinely empty
stub, since `OrganizationShape` needed real members almost immediately).
`package.json` gained `@qadi/core`, `@effect-auth/test`,
`@effect/platform-node`, `@effect/sql-sqlite-node` exactly mirroring
`@effect-auth/admin`'s own. `OrganizationConfig` is a fail-open
`Context.Reference` (unlike `AdminConfig`'s fail-closed `canImpersonate` —
ordinary organization management is meant to work out of the box per
spec.md) covering the plugin's full documented config surface up front
(`creatorRole`, `allowUserToCreateOrganization`, `organizationLimit`,
`membershipLimit`, `disableOrganizationDeletion`, `permissionStatements`,
`dynamicAccessControl`, `teams`, invitation knobs) rather than growing the
shape ticket-by-ticket — a deliberate front-loading decision (config knobs
not yet consumed by tickets 09–12, i.e. `dynamicAccessControl`/`teams`/
invitation fields, are present but inert until their own later phase).
`Organization extends AuthPlugin.Service<...>()("organization", {...})`
composes; `AuthComposition.test.ts` passes.

**Correction**: every table this plugin owns must be prefixed with its own
plugin id per `AuthPlugin.ts`'s `tables: ReadonlyArray<\`${Id}_${string}\`>`
type — the primary entity table could not be named plain `"organization"`
(no `_` suffix). Named it `organization_org` instead; every other table
(`organization_membership`, `organization_invitation`,
`organization_team`, `organization_team_membership`, `organization_role`,
`organization_active_context`) already satisfied the convention as
originally planned.
