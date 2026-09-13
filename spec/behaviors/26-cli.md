# CLI
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-26 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | effect-auth Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Softened BEH-EA-207 to a deferred, unvalidated CLI feature, matching BEH-EA-039's hedged framing (CCR-EA-002) |
---

> This file describes planned behavior. No code implementing it exists yet; effect-auth is pre-implementation.

## BEH-EA-201: `doctor` checks link, config, and insecure defaults

```bash
effect-auth doctor   # link + config + insecure defaults (sameSite lax, csrf off, dev mailer in prod)
```

```text
REQUIREMENT: `effect-auth doctor` MUST report every plugin-graph linking
             problem, every configuration value it can validate, and every
             known insecure-default combination (relaxed `SameSite`, CSRF
             disabled, a development mailer configured in a production
             environment); it MUST NOT require the application to be running
             to produce this report.
```

`usage-examples-v4.md` §23 lists exactly this scope. Running against the statically derived manifest (BEH-EA-208) rather than a live process means `doctor` can be run in CI, before deploy, and catch a `sameSite: "lax"` or a `Mailer.layerMemory` left in production configuration before either one reaches a real user.

_Previous: [BEH-EA-200](25-testing-harness.md#beh-ea-200-veto-only-in-veto-points-and-observer-isolation) | Next: [BEH-EA-202](26-cli.md#beh-ea-202-plugin-list---graph-shows-topology-ports-and-hook-chains)_

## BEH-EA-202: `plugin list --graph` shows topology, ports, and hook chains

```bash
effect-auth plugin list --graph   # topo order, ports, hook chains
```

```text
REQUIREMENT: `plugin list --graph` MUST print the installed plugins in
             topological (dependency) order together with each plugin's
             required ports and its resolved hook-tap chain; the ordering
             printed MUST match the order the linker actually uses for
             migrations and hook resolution.
```

PRD §21 and `usage-examples-v4.md` §14's "Resolved order is printable: `effect-auth plugin list --hooks`" both point at the same need: the composition order that determines behavior (which hook tap runs first, which migration applies first) must be inspectable as data, not something a developer has to infer by reading `Auth.make`'s plugin array and reasoning about `dependsOn` by hand.

_Previous: [BEH-EA-201](26-cli.md#beh-ea-201-doctor-checks-link-config-and-insecure-defaults) | Next: [BEH-EA-203](26-cli.md#beh-ea-203-routes-lists-every-endpoint-with-its-owning-plugin-and-middleware)_

## BEH-EA-203: `routes` lists every endpoint with its owning plugin and middleware

```bash
effect-auth routes   # method, path, group, plugin, middleware
```

```text
REQUIREMENT: `routes` MUST list every endpoint in the composed `AuthApi`,
             each row carrying its HTTP method, path, owning group, owning
             plugin, and applied middleware chain; it MUST reflect the
             compiled contract exactly, with no endpoint present in the
             contract omitted from the listing.
```

PRD §21 names this among the core operating commands. Because the contract is static (ADR-EA-005, ADR-EA-008), `routes` is a pure read of `auth.api` — no request needs to be made, no handler needs to run — which is what lets an operator audit exactly which middleware (CSRF, `RequirePermission`, a custom rate-limit rule) actually applies to a given path before the application ever serves traffic.

_Previous: [BEH-EA-202](26-cli.md#beh-ea-202-plugin-list---graph-shows-topology-ports-and-hook-chains) | Next: [BEH-EA-204](26-cli.md#beh-ea-204-migration-status-and-apply-read-and-advance-the-ledger)_

## BEH-EA-204: `migration status` and `apply` read and advance the ledger

```bash
effect-auth migration status     # applied / pending against the Migrator ledger
effect-auth migration apply --yes
```

```text
REQUIREMENT: `migration status` MUST report applied and pending migrations by
             comparing the linker's ordered, re-keyed migration record against
             the driver's `Migrator` ledger; `migration apply` MUST require an
             explicit confirmation flag and MUST apply migrations in the
             linker's fixed order (core first, then topological, keyed
             `NNNN_<plugin>_<name>`).
```

PRD §21 lists both commands, and PRD §12/§9.2 fix the ordering guarantee `status` and `apply` both rely on: migration order is not left to filesystem or alphabetical ordering, it is the linker's own deterministic key scheme, checked as one of the runtime invariants `Auth.make` maintains (alongside cycle detection) even though most plugin-graph legality is a compile-time property.

_Previous: [BEH-EA-203](26-cli.md#beh-ea-203-routes-lists-every-endpoint-with-its-owning-plugin-and-middleware) | Next: [BEH-EA-205](26-cli.md#beh-ea-205-openapi-exports-the-aggregated-document)_

## BEH-EA-205: `openapi` exports the aggregated document

```bash
effect-auth openapi > openapi.json
```

```text
REQUIREMENT: `effect-auth openapi` MUST emit one OpenAPI document covering
             core and every installed plugin's contract; it MUST NOT require
             a non-Effect consumer to assemble multiple per-plugin documents
             themselves.
```

research/11-client-frontend.md's Q39 names this the deliberate escape hatch for consumers who "refuse Effect": "exposing the aggregated OpenAPI document... plus letting them codegen is the escape hatch, no extra client code from us." One document, generated from the same merged `AuthApi` the Effect client is generated from, is what lets `openapi-typescript`, `hey-api` or `orval` produce a usable client for a team that will never import `effect` itself.

_Previous: [BEH-EA-204](26-cli.md#beh-ea-204-migration-status-and-apply-read-and-advance-the-ledger) | Next: [BEH-EA-206](26-cli.md#beh-ea-206-seed-admin-provisions-the-first-privileged-account)_

## BEH-EA-206: `seed admin` provisions the first privileged account

```bash
effect-auth seed admin
```

```text
REQUIREMENT: `seed admin` MUST create or promote one account to an
             administrative role through the same domain services an
             application would use at runtime (`Users`, `Roles`), never by
             writing rows directly to the database; it MUST refuse to run
             against a target that already has an administrative account
             unless explicitly forced.
```

Every other write path in the system goes through typed domain services with their own invariants (password hashing, uniqueness checks, role-graph validity); a seeding command that bypassed those services with raw SQL would risk producing an account the rest of the system's own invariants do not actually hold for. Requiring `Roles` to be installed for this command to do anything is also a direct instance of BEH-EA-137's rule: without a roles plugin, there is no "admin" concept for `seed admin` to grant.

_Previous: [BEH-EA-205](26-cli.md#beh-ea-205-openapi-exports-the-aggregated-document) | Next: [BEH-EA-207](26-cli.md#beh-ea-207-import-migrates-users-from-a-named-source-framework)_

## BEH-EA-207: `import` migrates users from a named source framework

```bash
effect-auth import --from better-auth|authjs|lucia
```

```text
REQUIREMENT: `effect-auth import` MUST support at least `better-auth`,
             `authjs`, and `lucia` as named source formats, translating each
             framework's user/account/session tables into effect-auth's own
             `Model.Class` shapes; it MUST NOT silently drop a source field
             effect-auth has no equivalent for without reporting it.
```

PRD §21 names these three sources explicitly, reflecting the ecosystem effect-auth positions itself against (PRD §2's discussion of better-auth) and alongside (Auth.js/Lucia as prior art). Reporting rather than silently dropping unmapped fields (a provider-specific column, a plugin-specific table the target framework had no equivalent for) keeps a migration auditable — an operator moving a production user base needs to know what, if anything, did not carry over.

Like `behaviors/05-persistence-stratum.md`'s BEH-EA-039 (schema diffing and destructive-change guardrails are "a deferred CLI feature, not a v1 runtime requirement"), this requirement names a real target without claiming it is validated today: no source-framework schema mapping (`better-auth`, `authjs`, `lucia`) has been built or tested against a real export from any of the three, and the exact set of fields each framework's schema carries that effect-auth's `Model.Class` shapes have no equivalent for is not yet enumerated. `effect-auth import` is planned CLI tooling, not a v1 runtime requirement — nothing in `Auth.make`, `auth.layer`, or `auth.migrations` depends on it existing — and, like BEH-EA-039's diff planner, it is expected to be built and validated against real exported data from each named source before it is relied on for a production migration, not assumed correct from this specification alone.

_Previous: [BEH-EA-206](26-cli.md#beh-ea-206-seed-admin-provisions-the-first-privileged-account) | Next: [BEH-EA-208](26-cli.md#beh-ea-208-the-cli-reads-the-manifest-it-never-runs-the-application)_

## BEH-EA-208: The CLI reads the manifest; it never runs the application

```ts
export const auth = Auth.make([Password, Passkey, OAuth, Organization, Roles])
// auth.manifest   derived, for the CLI
```

```text
REQUIREMENT: Every CLI command MUST operate on `Auth.make`'s statically
             derived manifest (contract, tables, migrations, plugin graph); no
             CLI command MUST start an HTTP listener, accept a request, or
             otherwise run the application it is inspecting.
```

PRD §21 states this as the CLI's defining boundary: "The CLI reads `Auth.make`'s derived manifest; it never runs the application." Because contracts, tables and migrations are static class members (ADR-EA-005, ADR-EA-008), the manifest a command like `doctor`, `routes`, or `plugin list --graph` needs already exists the moment `Auth.make` is evaluated — no server needs to be listening, no database connection needs to be live, for any of these commands to answer correctly. This keeps the CLI usable in CI and in pre-deploy checks, where standing up the full application merely to inspect it would be exactly the kind of accidental coupling the rest of this specification's Layer-boundary discipline (file 04, the Contract Stratum) is designed to avoid.

_Previous: [BEH-EA-207](26-cli.md#beh-ea-207-import-migrates-users-from-a-named-source-framework) | Next: none — this is the final behavior file._
