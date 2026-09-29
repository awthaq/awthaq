# CLI
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-26 |
> | Revision | 1.3 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Softened BEH-EA-207 to a deferred, unvalidated CLI feature, matching BEH-EA-039's hedged framing (CCR-EA-002) <br> 1.2 (2026-09-13): Retargeted BEH-EA-208's footer link now that [27-admin-impersonation.md](27-admin-impersonation.md) follows it (CCR-EA-004) <br> 1.3 (2026-09-29): Scoped BEH-EA-208 to what a command acts on and partitioned the CLI into manifest-only, database-backed and session commands, carving `login`/`logout`/`whoami` out as outbound-only clients (CTA-002/DAG-003/ECS-003); added the typed exit-code table BEH-EA-225 (ECS-001/CTA-003), Schema-bound arguments BEH-EA-226 (ECS-007), the session-command family BEH-EA-227 and its CredentialStore BEH-EA-228 (CTA-001/CTA-004), and configuration descriptors BEH-EA-229 (ECS-008); extended BEH-EA-201 with a no-secret-values clause (ECS-005), BEH-EA-204 with plan preview and drift refusal (ECS-009), BEH-EA-206 with an audit event (ECS-006) and BEH-EA-207 with a write-side contract and the SourceAdapter registry (ECS-002/BAM-001/FAMS-010) (CCR-EA-006) |
---

> This file specifies the `awthaq` CLI (`@awthaq/cli`, built on `effect/unstable/cli`, ADR-EA-027). The commands are implemented; each behavior's *Implementation* note below says what ships and what is deliberately still open.

## BEH-EA-201: `doctor` checks link, config, and insecure defaults

```bash
awthaq doctor           # link + config + insecure defaults (sameSite lax, csrf off, dev mailer in prod)
awthaq doctor --build   # additionally build the application Layer once, never serving it
```

```text
REQUIREMENT: `awthaq doctor` MUST report every plugin-graph linking
             problem, every configuration value declared in the manifest's
             configuration descriptors (BEH-EA-229) that the loaded
             configuration module statically provides, audited through its
             descriptor, and every known insecure-default combination
             (relaxed `SameSite`, a mutating endpoint without
             `CsrfProtection`, an oversized body limit and, with `--build`,
             a development mailer or a permissive rate limiter in a
             production environment); it MUST NOT require the application to
             be running to produce this report. It MUST NOT print the value
             of any configuration input carried as `Redacted` or declared
             sensitive: such an input is reported only as present, valid or
             invalid (with the validation message, never the value), and the
             same rule binds `config list`, every `--json` output and the
             error message of every CLI command. It MUST exit with the
             findings code of BEH-EA-225 when it reports any finding.
```

`usage-examples-v4.md` §23 lists exactly this scope. Running against the statically derived manifest (BEH-EA-208) rather than a live process means `doctor` can be run in CI, before deploy, and catch a `sameSite: "lax"` or a `Mailer.layerMemory` left in production configuration before either one reaches a real user. `--build` is the one opt-in step past the manifest: it evaluates the application's own Layer once, in a scope that is closed straight away, so an unprovided port or a malformed `Config` value (a CSRF secret under 32 bytes, an absent encryption key) surfaces as a finding instead of a crash at first boot; it is a database-backed command in BEH-EA-208's sense and still never starts the HTTP server. A finding is data (a code, a severity, a plugin id, a message), so the same list backs the human report and `--json`.

_Previous: [BEH-EA-200](25-testing-harness.md#beh-ea-200-veto-only-in-veto-points-and-observer-isolation) | Next: [BEH-EA-202](26-cli.md#beh-ea-202-plugin-list---graph-shows-topology-ports-and-hook-chains)_

## BEH-EA-202: `plugin list --graph` shows topology, ports, and hook chains

```bash
awthaq plugin list --graph   # topo order, ports, hook chains
```

```text
REQUIREMENT: `plugin list --graph` MUST print the installed plugins in
             topological (dependency) order together with each plugin's
             required ports and its resolved hook-tap chain; the ordering
             printed MUST match the order the linker actually uses for
             migrations and hook resolution. `--format json|dot` MUST emit
             the same graph as data.
```

PRD §21 and `usage-examples-v4.md` §14's "Resolved order is printable: `awthaq plugin list --hooks`" both point at the same need: the composition order that determines behavior (which hook tap runs first, which migration applies first) must be inspectable as data, not something a developer has to infer by reading `Auth.make`'s plugin array and reasoning about `dependsOn` by hand.

_Previous: [BEH-EA-201](26-cli.md#beh-ea-201-doctor-checks-link-config-and-insecure-defaults) | Next: [BEH-EA-203](26-cli.md#beh-ea-203-routes-lists-every-endpoint-with-its-owning-plugin-and-middleware)_

## BEH-EA-203: `routes` lists every endpoint with its owning plugin and middleware

```bash
awthaq routes   # method, path, group, plugin, middleware
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
awthaq migration status     # applied / pending against both Migrator ledgers
awthaq migration apply --dry-run
awthaq migration apply --yes
```

```text
REQUIREMENT: `migration status` MUST report applied and pending migrations by
             comparing the linker's ordered, re-keyed migration record against
             the driver's `Migrator` ledgers (core's `effect_sql_migrations`
             and the plugin ledger `awthaq_plugin_migrations`, which are two
             id spaces, BEH-EA-038), and MUST exit with the drift code of
             BEH-EA-225 when a ledger holds an applied id or name the linker's
             record does not know, or when a pending id sorts before an
             applied one; `migration apply` MUST print the ordered pending
             set before applying, MUST refuse to run when `status` would
             report drift, MUST require an explicit confirmation flag
             (`--yes`) and otherwise apply nothing, and MUST apply migrations
             in the linker's fixed order (core first, then topological, keyed
             `NNNN_<plugin>_<name>`); `--dry-run` MUST print the same plan and
             apply nothing.
```

PRD §21 lists both commands, and PRD §12/§9.2 fix the ordering guarantee `status` and `apply` both rely on: migration order is not left to filesystem or alphabetical ordering, it is the linker's own deterministic key scheme, checked as one of the runtime invariants `Auth.make` maintains (alongside cycle detection) even though most plugin-graph legality is a compile-time property.

The confirmation, plan-preview and drift guardrails are the minimum BEH-EA-039 promises the CLI owns (checksums and snapshot diffing stay deferred): Effect's `Migrator` silently skips any id at or below the newest one recorded, so an applied id the linker no longer produces, or a plugin added *before* an already-applied one, would otherwise change what `apply` does without saying so. `apply` is the one command that changes the schema, so it shows what it is about to run, refuses on a ledger it cannot reconcile, and exits with a distinct code when there is nothing to apply so CI can branch on it (`--allow-empty` maps that case to success).

_Previous: [BEH-EA-203](26-cli.md#beh-ea-203-routes-lists-every-endpoint-with-its-owning-plugin-and-middleware) | Next: [BEH-EA-205](26-cli.md#beh-ea-205-openapi-exports-the-aggregated-document)_

## BEH-EA-205: `openapi` exports the aggregated document

```bash
awthaq openapi > openapi.json
```

```text
REQUIREMENT: `awthaq openapi` MUST emit one OpenAPI document covering
             core and every installed plugin's contract; it MUST NOT require
             a non-Effect consumer to assemble multiple per-plugin documents
             themselves.
```

research/11-client-frontend.md's Q39 names this the deliberate escape hatch for consumers who "refuse Effect": "exposing the aggregated OpenAPI document... plus letting them codegen is the escape hatch, no extra client code from us." One document, generated from the same merged `AuthApi` the Effect client is generated from, is what lets `openapi-typescript`, `hey-api` or `orval` produce a usable client for a team that will never import `effect` itself.

_Previous: [BEH-EA-204](26-cli.md#beh-ea-204-migration-status-and-apply-read-and-advance-the-ledger) | Next: [BEH-EA-206](26-cli.md#beh-ea-206-seed-admin-provisions-the-first-privileged-account)_

## BEH-EA-206: `seed admin` provisions the first privileged account

```bash
awthaq seed admin --email ops@acme.com --name "Ops"
```

```text
REQUIREMENT: `seed admin` MUST create or promote one account, identified by
             an email decoded through the same Schema the password sign-up
             payload uses (BEH-EA-226), to an administrative role through the
             same domain services an application would use at runtime
             (`Users`, `Roles`), never by writing rows directly to the
             database; it MUST refuse to run against a target that already
             has an administrative account unless explicitly forced. It MUST
             publish `auth.admin.seeded` (target account id, created versus
             promoted, the forced flag, the role) on success and
             `auth.admin.seedRefused` on refusal, so the grant lands in the
             durable audit table (BEH-EA-100); a password, when one is given,
             MUST come from the environment or a prompt, never from argv.
```

Every other write path in the system goes through typed domain services with their own invariants (password hashing, uniqueness checks, role-graph validity); a seeding command that bypassed those services with raw SQL would risk producing an account the rest of the system's own invariants do not actually hold for. Requiring `Roles` to be installed for this command to do anything is also a direct instance of BEH-EA-137's rule: without a roles plugin, there is no "admin" concept for `seed admin` to grant, and the command fails with the capability-unavailable code of BEH-EA-225. A privilege grant made outside any HTTP request has no session to attribute it to, which is exactly why it publishes its own event: an operator reconstructing "who became an admin, and by which path" reads one audit row (`via: "cli"`) instead of inferring it from a role table.

_Previous: [BEH-EA-205](26-cli.md#beh-ea-205-openapi-exports-the-aggregated-document) | Next: [BEH-EA-207](26-cli.md#beh-ea-207-import-migrates-users-from-a-named-source-framework)_

## BEH-EA-207: `import` migrates users from a named source framework

```bash
awthaq import --from better-auth|firebase|authjs|lucia
```

```text
REQUIREMENT: `awthaq import` MUST accept `better-auth`, `firebase`, `authjs`
             and `lucia` as named source formats (the `--from` Schema,
             BEH-EA-226, is derived from the registered `SourceAdapter`
             names), translating a validated source's user/account rows into
             awthaq's own `Model.Class` shapes through the `Users` and
             `Accounts` domain services, never by writing rows directly; it
             MUST NOT silently drop a source field awthaq has no equivalent
             for without reporting it. A source whose adapter has not been
             validated against a real export (`authjs`, `lucia`) MUST be
             accepted and then refused with a typed not-yet-validated error.

             Write side: without `--yes` (or with `--dry-run`) `import` MUST
             run in plan mode, reading and mapping the whole export and
             printing per-table row counts, the unmapped-field report and
             conflict counts, and MUST write nothing; with `--yes` it MUST
             write in bounded batches, each in one transaction, so a failed
             batch rolls back only itself, is reported with its source row ids
             and error tag, and stops the run (or, with `--continue-on-error`,
             continues) leaving a checkpoint at the last committed batch;
             re-running against the same source MUST resume from that
             checkpoint and never insert a row twice; each run MUST publish
             one `auth.import.completed` or `auth.import.failed` event
             carrying the source, the run id and the imported, skipped, failed
             and unmapped counts.
```

PRD §21 names the first three sources explicitly, reflecting the ecosystem awthaq positions itself against (PRD §2's discussion of better-auth) and alongside (Auth.js/Lucia as prior art); Firebase joins them because `@awthaq/migrate-firebase` ships the export recipe and the `firebase-scrypt` legacy verifier that lets its users sign in without a forced reset. Reporting rather than silently dropping unmapped fields (a provider-specific column, a plugin-specific table the target framework had no equivalent for) keeps a migration auditable — an operator moving a production user base needs to know what, if anything, did not carry over.

Importing is the largest write the CLI performs and the one an operator cannot easily undo, so it follows the same shape as the other two write commands (`migration apply` requires `--yes`, BEH-EA-204; `seed admin` requires `--force` over an existing admin, BEH-EA-206) and adds the two things a bulk write needs that a single write does not: a preview, and a resumable checkpoint. The checkpoint is the `awthaq_import_runs` table (one row per source row: run id, source, source row id, status, imported user id, error), created by a first-party migration `import` ships; a resumed run skips rows already `done`, so a partial failure is repaired by running the same command again rather than by hand-editing a database.

Like `behaviors/05-persistence-stratum.md`'s BEH-EA-039 (schema diffing and destructive-change guardrails are "a deferred CLI feature, not a v1 runtime requirement"), this requirement names a real target without claiming every part of it is validated today: the exact set of fields each framework's schema carries that awthaq's `Model.Class` shapes have no equivalent for is enumerated only for the adapters that have been built against a real export. `awthaq import` is CLI tooling, not a v1 runtime requirement — nothing in `Auth.make`, `auth.layer`, or `auth.migrations` depends on it existing — and, like BEH-EA-039's diff planner, a mapping is expected to be built and validated against real exported data from its source before it is relied on for a production migration, not assumed correct from this specification alone. Decision 07 ships the `better-auth` adapter first, validated against a checked-in export produced by a real better-auth database, alongside `firebase` (users and `hash_config` from `auth.listUsers`); `authjs` and `lucia` are registered so the command surface names the full target, and refuse rather than fabricate a best-effort mapping.

_Previous: [BEH-EA-206](26-cli.md#beh-ea-206-seed-admin-provisions-the-first-privileged-account) | Next: [BEH-EA-208](26-cli.md#beh-ea-208-the-cli-reads-the-manifest-it-never-runs-the-application)_

## BEH-EA-208: The CLI reads the manifest; it never runs the application

```ts
export const auth = Auth.make([Password, Passkey, OAuth, Organization, Roles])
// auth.manifest   derived, for the CLI
```

```text
REQUIREMENT: Every CLI command MUST derive what it acts on from `Auth.make`'s
             statically derived manifest (contract, tables, migrations,
             plugin graph) and MUST NOT start an HTTP listener, accept an
             inbound request, or otherwise serve the application it
             inspects. Commands fall into three classes with different Layer
             requirements:

             1. Manifest-only (`doctor`, `config list`, `plugin list
                --graph`, `routes`, `openapi`): MUST NOT evaluate the
                application's runtime `make` Layer and MUST NOT open a
                database connection.
             2. Database-backed (`migration status`, `migration apply`,
                `seed admin`, `import`, `doctor --build`): MAY construct a
                `SqlClient` and, for `seed admin`, `import` and `doctor
                --build`, the application's own domain-service Layers
                (`Users`, `Roles`, `Accounts`) on a short-lived runtime;
                MUST NOT build the HTTP server Layer.
             3. Session (`login`, `logout`, `whoami`, BEH-EA-227): act only
                as an outbound network client of an already-running auth
                server; exempt from deriving anything from the manifest, and
                MUST NOT start a listener or accept an inbound request either
                (no CLI-hosted redirect callback, no loopback server).
```

PRD §21 states this as the CLI's defining boundary: "The CLI reads `Auth.make`'s derived manifest; it never runs the application." The property that boundary protects is narrower than "no Layer, no database": it is that no CLI command *serves* the application (no socket is bound, no request is answered), so a command is safe to run in CI and in a pre-deploy check, where standing up the full application merely to inspect it would be exactly the kind of accidental coupling the rest of this specification's Layer-boundary discipline (file 04, the Contract Stratum) is designed to avoid. Because contracts, tables and migrations are static class members (ADR-EA-005, ADR-EA-008), the manifest a command like `doctor`, `routes`, or `plugin list --graph` needs already exists the moment `Auth.make` is evaluated — no server needs to be listening, no database connection needs to be live, for any *manifest-only* command to answer correctly. `migration status` cannot be manifest-only (it reads the driver's ledgers), and `seed admin` and `import` need the domain services to keep their invariants (BEH-EA-206, BEH-EA-207), so they are database-backed: they construct services, they do not serve.

The session family is the one place "needs a live process" is the entire point, the way `seed admin` is the one place "writes data" is the point: there is no manifest-only answer to "who am I logged in as". It narrows this requirement's *scope*, not its *content*: a session command is a client of a server that is already running, it never becomes one. The transport is `@awthaq/client`'s generated `HttpApiClient` (the plain, non-reactive binding), not the React or atom surface, and the poll's eventual session issuance runs through the same `BeforeSessionIssue` divert point as any other login method ([13-device-authorization.md](../models/13-device-authorization.md)).

_Previous: [BEH-EA-207](26-cli.md#beh-ea-207-import-migrates-users-from-a-named-source-framework) | Next: [BEH-EA-225](26-cli.md#beh-ea-225-every-cli-command-exits-with-a-stable-typed-exit-code)_

## BEH-EA-225: Every CLI command exits with a stable, typed exit code

```text
0  success, or a clean report                       (no error)
1  unexpected defect                                (a bug, never an expected refusal)
2  usage error                                      (UsageError: bad flag/argument, unknown or not-yet-validated --from)
3  doctor found problems                            (DoctorFindings)
4  nothing to apply                                 (NothingToApply; --allow-empty maps it to 0)
5  a write failed                                   (MigrationFailed, ImportFailed)
6  refused without confirmation                     (ConfirmationRequired: apply/import without --yes, seed admin over an existing admin without --force)
7  ledger drift                                     (LedgerDrift, BEH-EA-204)
8  authentication required or expired               (AuthenticationRequired, BEH-EA-227)
9  environment or capability unavailable            (ConfigUnavailable, DatabaseUnavailable, RolesNotInstalled)
```

```text
REQUIREMENT: Every CLI command MUST exit with the code this table assigns to
             the typed error it failed with, and each typed CLI error class
             MUST carry its code as `[Runtime.errorExitCode]` so the mapping
             is fixed at compile time and never parsed from a message; no
             command MUST set the process exit status by hand. With `--json`,
             the failure document MUST carry the same `_tag` and code.
```

`awthaq doctor` is explicitly a CI gate, and a CI job can only branch on what the process reports. Effect v4's runtime already honors a per-error exit code (`Runtime.errorExitCode`, the same marker its own `CliError` carries), so the contract costs one property per error class: a failing job can tell "found problems" (3) from "could not reach the database" (9) from "you forgot `--yes`" (6) without scraping text, and `migration apply` can tell "nothing to do" (4) from success. The parser's own failures are remapped to code 2 so a mistyped flag and a refused write never share a status. BEH-EA-201, BEH-EA-204, BEH-EA-206, BEH-EA-207 and BEH-EA-227 each name the code they use.

_Previous: [BEH-EA-208](26-cli.md#beh-ea-208-the-cli-reads-the-manifest-it-never-runs-the-application) | Next: [BEH-EA-226](26-cli.md#beh-ea-226-cli-arguments-decode-through-the-contracts-schemas)_

## BEH-EA-226: CLI arguments decode through the contract's Schemas

```bash
awthaq seed admin --email not-an-email   # exit 2, before any service is built
awthaq import --from mystery             # exit 2, listing the registered sources
```

```text
REQUIREMENT: Every CLI flag and argument MUST be declared with a Schema
             (`Flag.withSchema` / `Argument.withSchema`), reusing the HTTP
             contract's own Schema where one exists: `seed admin --email`
             MUST decode through the email Schema the password sign-up
             payload uses, `import --from` MUST be a literal Schema whose
             members are the registered `SourceAdapter` names, and `--config`
             a path Schema. A decode failure MUST surface as the usage-error
             class of BEH-EA-225 before any service is constructed and
             without any hand-rolled string parsing.
```

An argument the command line accepts but the server would reject is a defect waiting for the write: an email that `seed admin` takes and the sign-up endpoint would refuse produces an account the rest of the system's own invariants do not hold for. Reusing the contract's Schema means the two entry points can never disagree, and deriving `--from`'s literal from the adapter registry means the help text, the validation and the registry cannot drift apart.

_Previous: [BEH-EA-225](26-cli.md#beh-ea-225-every-cli-command-exits-with-a-stable-typed-exit-code) | Next: [BEH-EA-227](26-cli.md#beh-ea-227-session-commands-login-logout-whoami-are-outbound-only-clients-of-a-running-auth-server)_

## BEH-EA-227: Session commands (`login`, `logout`, `whoami`) are outbound-only clients of a running auth server

```bash
awthaq login --token "$AWTHAQ_TOKEN" --base-url https://auth.acme.com
awthaq login                      # device-authorization flow (requires the DeviceAuthorization plugin)
awthaq whoami
awthaq logout
```

```text
REQUIREMENT: `login`, `logout` and `whoami` MUST act only as outbound
             clients of a running auth server, carried over
             `@awthaq/client`'s generated `HttpApiClient`; none MUST start a
             listener or accept an inbound request. `login --token <t>` (or
             `AWTHAQ_TOKEN`) MUST validate the token against the server's
             session-introspection endpoint and store it only when it is
             valid, and MUST be usable non-interactively (`--base-url` or
             `AWTHAQ_BASE_URL`). The interactive `login` MUST use the device
             authorization grant: request a device code, print the user code
             and verification URI, and poll on a schedule that starts at the
             server's `interval`, widens on `slow_down` and ends with a
             non-zero exit and "run `awthaq login` again" on `expired_token`;
             until the `DeviceAuthorization` plugin exists it MUST fail with
             a typed error naming that requirement. `logout` MUST clear the
             stored credential and revoke it server-side on a best-effort
             basis; `whoami` MUST print the resolved principal or fail with
             the authentication code of BEH-EA-225 when not logged in.
```

CI usage needs a non-interactive path from day one (a service token in an environment variable, no browser, no prompt); an interactive terminal wants the device flow (RFC 8628) instead, because a CLI has no way to receive a redirect without binding a listener, which BEH-EA-208 forbids for every class. The token path needs nothing beyond the session endpoint every deployment already has; the device path is gated on the plugin that serves `/device/code` and `/device/token` ([13-device-authorization.md](../models/13-device-authorization.md), where the CLI is the first consumer). The transport reuses the generated client's typed HTTP calls rather than the React-facing package boundary: `@awthaq/client` is the isomorphic, UI-facing client library, and a terminal surface borrows its transport without inheriting its role.

_Previous: [BEH-EA-226](26-cli.md#beh-ea-226-cli-arguments-decode-through-the-contracts-schemas) | Next: [BEH-EA-228](26-cli.md#beh-ea-228-cli-credentials-live-in-a-credentialstore-never-a-plaintext-dotfile-by-default)_

## BEH-EA-228: CLI credentials live in a `CredentialStore`, never a plaintext dotfile by default

```ts
interface CredentialStore { get; set; clear }   // Effect-returning, Redacted in memory
```

```text
REQUIREMENT: Session-command credentials MUST be stored through a
             `CredentialStore` port (`get`/`set`/`clear`) whose default Layer
             resolves the OS-native store first (macOS Keychain, Linux Secret
             Service, Windows Credential Manager). Only when none is
             reachable MAY it fall back to
             `$XDG_CONFIG_HOME/awthaq/credentials.json` created with mode
             0600 inside a 0700 directory, and the CLI MUST warn once when it
             uses the fallback. `AWTHAQ_TOKEN` MUST always win over the
             stored credential and MUST never be written to any store. A
             token MUST be carried as `Redacted` in memory and never printed.
```

A CLI token is a bearer credential to a user's account, and the ecosystem's recurring failure is a plaintext dotfile in the home directory that any process of that user (or a backup tool) can read. Keychain-first with a 0600 file as the last resort (a headless Linux CI runner, a container) is the order that keeps the common desktop case safe and the constrained case working; the environment override exists precisely so CI never needs the store at all. This is the CLI-side counterpart of [BEH-EA-066](09-authentication-middleware.md#beh-ea-066-the-bearer-handler-is-tried-after-the-cookie-handler-fails-over-the-same-session-resolution-logic)'s note that a native client carries a bearer token from a keychain: mobile storage stays the application's job, the CLI's is specified here.

_Previous: [BEH-EA-227](26-cli.md#beh-ea-227-session-commands-login-logout-whoami-are-outbound-only-clients-of-a-running-auth-server) | Next: [BEH-EA-229](26-cli.md#beh-ea-229-plugins-declare-their-configuration-statically-and-config-list-prints-it-redacted)_

## BEH-EA-229: Plugins declare their configuration statically, and `config list` prints it redacted

```bash
awthaq config list          # every declared configuration input, default and statically visible override
awthaq config list --json
```

```text
REQUIREMENT: A plugin MAY declare its configuration inputs as descriptors
             (the `Context.Reference` that carries them, the keys holding
             secrets, and an audit of a value against the insecure-default
             rules), and `Auth.make` MUST expose every installed plugin's
             descriptors in `auth.manifest.config`, derived without
             evaluating any Layer. `awthaq config list` MUST print each
             descriptor's default and, when the loaded configuration module
             provides a configuration Layer, the value that Layer sets and
             whether it is the default or an override; a value declared
             sensitive MUST be printed as `<redacted>` and never unwrapped.
```

[ADR-EA-006](../decisions/006-runtime-config-separate-from-installation.md) keeps configuration out of the static plugin graph and, in its first revision, accepted having no artifact that lists it. Revision 1.2 closes that gap without giving up the design: the *shape* of configuration is now part of the manifest (which inputs exist, which are secret), while the *values* remain ordinary `Context.Reference` overrides, so a configuration Layer (`Password.config(...)`, `Sessions.config(...)`) built on its own, with no ports and no database, is enough for a tool to read the effective values it sets. What stays out of reach is an override computed dynamically per request or per tenant, which cannot be validated before deploy; the same descriptors let a running application dump its effective configuration (`EffectiveConfig.snapshot`), with sensitive values still redacted.

_Previous: [BEH-EA-228](26-cli.md#beh-ea-228-cli-credentials-live-in-a-credentialstore-never-a-plaintext-dotfile-by-default) | Next: [BEH-EA-209](27-admin-impersonation.md#beh-ea-209-actingas-becomes-a-real-generic-field-on-session-issuance)_
