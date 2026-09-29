# P17 — CLI tooling

Phase 3 · 16 open issues to fix (6 high, 9 medium, 1 low) · 9 closed by validation · ~115h summed per-issue estimate (upper bound) · 0 need a decision first.

Each issue below links to its full dossier (evidence at HEAD `ec065a7`, fix steps, tests, acceptance) in its slice file. Work workstream by workstream, top to bottom; within a workstream do the canonical issue first — its fix closes the listed duplicates.

## `cli-contract` — CLI spec contract: import write-safety, exit codes, and BEH-EA-208 command classes

Slices: [13-repo-features-tooling](../slices/13-repo-features-tooling.md) · ~6h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ECS-002](../slices/13-repo-features-tooling.md) | high | security | CONFIRMED | M | BE-003, BAM-001, CTA-003 | Extend BEH-EA-207 (and 26-cli.feature's @BEH-EA-207 Rule) with a write-side contract: default plan/preview mode, explicit --yes confirmation before any write, per-batch transactions with failure reporting and a resumable checkpoint (the `awthaq_import_runs` ledger already decided in wayfinder ticket 07 §6), and a typed AuthEvents audit event per completed/aborted run. Then honor it in the ticket-07 `Import.ts` implementation. |
| [CTA-003](../slices/13-repo-features-tooling.md) | medium | dx | CONFIRMED | S | — | Add a normative exit-code contract to 26-cli.md (new cross-cutting section/requirement) and assert codes in 26-cli.feature; implement later via tagged errors carrying `Runtime.errorExitCode`. |
| [ECS-003](../slices/13-repo-features-tooling.md) | medium | correctness | CONFIRMED | S | CTA-002, DAG-003 | Rewrite BEH-EA-208 to state the true invariant (no HTTP listener, no inbound request, no application serving) and partition commands into three classes with explicit Layer requirements: manifest-only, database-backed, and (per ticket 06) session/outbound-client. Apply together with ticket 06's pending 1.3 amendment so the REQUIREMENT is edited once. |

## `cli-session-login-carveout` — BEH-EA-208 session-command carve-out and CLI credential storage

Slices: [12-spec](../slices/12-spec.md) · ~5h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [CTA-002](../slices/12-spec.md) | high | architecture | CONFIRMED | M | — | Apply decision ticket 06 verbatim: amend BEH-EA-208 so it scopes to *inspection* commands and carve out a `login`/`logout`/`whoami` session-command family that is an outbound-only client of a running server (never a listener, never inbound), add a new behavior for that family, and cross-link spec/models/13-device-authorization.md. |
| [CTA-004](../slices/12-spec.md) | medium | security | CONFIRMED | S | CTA-002 | Record ticket 06's CredentialStore decision normatively (new behavior next to the session-command BEH) so the login implementation cannot default to a plaintext dotfile. |

Closed by validation in this workstream: DAG-003 (DUPLICATE → CTA-002)

## `cli-manifest-tooling` — @awthaq/cli manifest tooling (decision 07)

Slices: [09-ports-apikey-cli](../slices/09-ports-apikey-cli.md) · ~37h · depends on workstreams: `legacy-password-migration`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [BE-003](../slices/09-ports-apikey-cli.md) | high | api | CONFIRMED | XL | ECS-004 | Build the @awthaq/cli command tree per decision 07 (doctor, plugin list --graph, routes, migration status/apply, openapi, seed admin, import mechanism). |
| [ECS-004](../slices/09-ports-apikey-cli.md) | medium | architecture | CONFIRMED | S | — | Record the CLI-framework choice as an ADR and retire the stale @effect/cli recommendation. |
| [FAMS-010](../slices/09-ports-apikey-cli.md) | medium | dx | CONFIRMED | M | FAMS-001, BE-003 | Ship a Firebase import recipe in @awthaq/migrate-firebase and expose it as `awthaq import --from firebase`. |

Closed by validation in this workstream: MW-006 (DUPLICATE → BE-003), CTA-007 (WONTFIX-CANDIDATE), ELC-008 (DUPLICATE → BE-003), ERS-008 (DUPLICATE → BE-003), RRM-011 (DUPLICATE → BE-003)

## `cli-exit-code-and-arg-contract` — CLI process contract: typed exit codes and Schema-bound arguments

Slices: [12-spec](../slices/12-spec.md) · ~5h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ECS-001](../slices/12-spec.md) | high | dx | CONFIRMED | M | — | Add a normative process contract for every CLI command: a fixed exit-code table derived mechanically from each command's TaggedError `_tag` via Effect v4's `Runtime.errorExitCode`, plus one scenario per class. |
| [ECS-007](../slices/12-spec.md) | medium | api | CONFIRMED | S | ECS-001 | Make 'every CLI option/argument decodes through a Schema, reusing the HTTP contract's Schemas where one exists' normative, so invalid input fails as a typed usage error (exit 2). |

## `cli-import-tooling` — better-auth import via SourceAdapter (decision 07)

Slices: [12-spec](../slices/12-spec.md) · ~32h · depends on workstreams: `cli-exit-code-and-arg-contract`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [BAM-001](../slices/12-spec.md) | high | dx | CONFIRMED | XL | BE-003, ECS-007 | Follow decision ticket 07 §6: a generic `SourceAdapter` interface and `import --from <source>` command, only the better-auth adapter implemented and validated against a real export fixture; authjs/lucia registered but refusing with a typed NotImplemented error; rows go through Users/Accounts domain services; unmapped fields reported; resumable via an import-runs table. |

## `cli-session-commands` — CLI login/logout/whoami (decision 06)

Slices: [09-ports-apikey-cli](../slices/09-ports-apikey-cli.md) · ~12h · depends on workstreams: `apikey-machine-identity`, `cli-manifest-tooling`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [CTA-001](../slices/09-ports-apikey-cli.md) | high | architecture | CONFIRMED | L | BE-003, OCM-002 | Add the login/logout/whoami command family to @awthaq/cli per decision 06 (token path now, device flow later). |

Closed by validation in this workstream: DAG-002 (DUPLICATE → CTA-001), CTA-005 (DUPLICATE → CTA-001)

## `cli-doctor-hardening` — doctor redaction + static config descriptors + effective-config view (ADR-006 reconciliation)

Slices: [12-spec](../slices/12-spec.md) · ~13h · depends on workstreams: `cli-exit-code-and-arg-contract`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ECS-005](../slices/12-spec.md) | medium | security | CONFIRMED | S | — | Add a CLI-wide output-redaction requirement: configuration inputs that are Config.Redacted (or declared sensitive in the ECS-008 descriptors) are reported only as present/valid/invalid, never as values, enforced by a BDD scenario and a unit test. |
| [ECS-008](../slices/12-spec.md) | medium | correctness | CONFIRMED | L | ECS-005 | Resolve the contradiction toward the richer option: introduce an effective-configuration descriptor that plugins declare statically (Schema + default + sensitivity), that `doctor` validates and a guarded operator view can dump, and amend ADR-006's Negative consequence accordingly. EP-009's per-tenant effective-config dump is folded in. |

Closed by validation in this workstream: EP-009 (DUPLICATE → ECS-008)

## `cli-seed-admin-audit` — seed admin publishes audited admin-grant events

Slices: [12-spec](../slices/12-spec.md) · ~1h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ECS-006](../slices/12-spec.md) | medium | compliance | CONFIRMED | S | — | Require `seed admin` to publish a typed `auth.admin.seeded` event (and a refusal event) through AuthEvents, which AuditLog persists inline. |

## `cli-migration-guardrails` — migration status/apply plan preview and drift refusal

Slices: [12-spec](../slices/12-spec.md) · ~4h · depends on workstreams: `cli-exit-code-and-arg-contract`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ECS-009](../slices/12-spec.md) | low | dx | CONFIRMED | M | ECS-001 | Give the first shipped `migration apply` the minimum guardrails BEH-EA-039 promises the CLI owns: print the ordered pending plan, refuse on ledger drift (applied ids unknown to the linker, or out-of-order gaps), and make `status` fail loudly on divergence. |

