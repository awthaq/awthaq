# P20 — Test suite, tooling & CI

Phase 0 · 49 open issues to fix (1 high, 24 medium, 22 low, 2 info) · 16 closed by validation · ~152h summed per-issue estimate (upper bound) · 3 need a decision first.

Each issue below links to its full dossier (evidence at HEAD `ec065a7`, fix steps, tests, acceptance) in its slice file. Work workstream by workstream, top to bottom; within a workstream do the canonical issue first — its fix closes the listed duplicates.

## `tooling-typecheck-lint` — Enforce the type-safety profile the repo claims (lint rule for assertions, strict index access, DOM lib scoping)

Slices: [13-repo-features-tooling](../slices/13-repo-features-tooling.md) · ~6h · depends on workstreams: `oauth-untrusted-json-decoding (cross-slice: ESS-002-effect-schema-specialist/TTE-002/TTE-003)`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AH-004-anders-hejlsberg](../slices/13-repo-features-tooling.md) | medium | dx | CONFIRMED | M | ESS-002-effect-schema-specialist, TTE-002, TTE-003 | Make the no-type-assertion rule a checked property: enable oxlint's built-in `typescript/consistent-type-assertions` with `assertionStyle: "never"` (still permits `as const`) scoped to library source, and remove the 11 remaining src assertion sites. |
| [AH-008-anders-hejlsberg](../slices/13-repo-features-tooling.md) | low | dx | CONFIRMED | S | — | Flip `noPropertyAccessFromIndexSignature` to true in tsconfig.base.json and convert the resulting dot-access-on-index-signature sites to bracket access (which `noUncheckedIndexedAccess` then types as `T / undefined`). |
| [AH-009-anders-hejlsberg](../slices/13-repo-features-tooling.md) | info | dx | CONFIRMED | S | — | Base lib becomes ["ESNext"]; DOM is added only in the browser-facing packages' tsconfig.src.json (client, react, next) and in tsconfig.test.json (react .tsx tests run in that shared program). |

## `workspace-roster-sync` — Single source of truth for the package roster and honest stub manifests

Slices: [13-repo-features-tooling](../slices/13-repo-features-tooling.md) · ~6h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [MTS-003](../slices/13-repo-features-tooling.md) | medium | dx | CONFIRMED | S | — | Trim the four stub manifests to what their `export {}` needs, drop next's unused @awthaq/react (or make it a peer if intentionally forwarded), and delete every per-package ignore block from knip.json. |
| [MTS-004](../slices/13-repo-features-tooling.md) | medium | dx | CONFIRMED | M | — | Add scripts/sync-workspace.mjs that derives every roster from packages/*/package.json (name, private flag) and either writes (`--write`) or verifies (`--check`) the five lists; run `--check` in `pnpm check`. |
| [MTS-005](../slices/13-repo-features-tooling.md) | low | dx | CONFIRMED | S | — | Delete the paths block (and its comment) from tsconfig.test.json; rely on inheritance. |

## `bdd-feature-wiring` — Wire the 22 @unwired feature files per decision 36's risk tiers

Slices: [13-repo-features-tooling](../slices/13-repo-features-tooling.md) · ~40h · depends on workstreams: `bdd-suite-docs`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AH-003-aslak-hellesoy](../slices/13-repo-features-tooling.md) | high | testing | CONFIRMED | XL | — | Execute decision 36 (.scratch/resolve-ready-for-human-findings/issues/36-bdd-feature-wiring-prioritization.md): wire real step definitions into the 22 @skip @unwired feature files in its 5-tier risk order with the tiered depth policy, and add a per-file wiring-status table to spec/traceability.md §6. |
| [ESS-008-effect-stream-specialist](../slices/13-repo-features-tooling.md) | medium | testing | CONFIRMED | M | — | Wire 13-events.feature fully (all 8 Rules, not just decision 36's Tier-3 happy path) with an EventsWorld that exposes a controllably slow subscriber, a capacity probe, AuditLog reads and a log capture. |
| [OCM-004](../slices/13-repo-features-tooling.md) | medium | testing | PARTIAL | M | AH-003-aslak-hellesoy, OCM-001, SCP-002 | Wire 09-authentication-middleware.feature as AH-003 Tier 1 now (all Rules except the ApiKey scenarios), keep REQ-EA-199/201 explicitly @skip'd as 'blocked by api-key plugin (OCM-001)', and wire them when packages/api-key ships ApiKeyAuthentication. |

Closed by validation in this workstream: THS-006 (DUPLICATE → THS-001), TS-005-torin-sandall (DUPLICATE → AH-003-aslak-hellesoy), ETVS-008 (DUPLICATE → AH-003-aslak-hellesoy)

## `bdd-step-definition-quality` — BDD step-definition honesty: no vacuous steps, no Given/When inversion, shared harness

Slices: [13-repo-features-tooling](../slices/13-repo-features-tooling.md) · ~14h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AH-004-aslak-hellesoy](../slices/13-repo-features-tooling.md) | medium | testing | CONFIRMED | M | BDD-007 | Move every request-issuing body from a Given into its matching When; make precondition Givens arrange state (store the attempt parameters in the World) or assert it (query the store / call an endpoint and assert absence). |
| [AH-007-aslak-hellesoy](../slices/13-repo-features-tooling.md) | medium | testing | CONFIRMED | S | — | Replace the bare {string} Given with a dedicated custom parameter type that maps the exact literal config expressions to Password.config values (failing on an unknown literal), delete the fallback branch, and add a lint guard forbidding bare-{string} step patterns. |
| [TIR-005](../slices/13-repo-features-tooling.md) | medium | testing | CONFIRMED | M | BDD-007, AH-008-aslak-hellesoy | Make REQ-EA-317's transaction and token-consumed Thens observable: run this scenario against a SQLite-backed World (real transactions) with a fault-injection hook, and assert both the happy commit and rollback-on-failure; implement 'the token is consumed' by replaying the token and expecting 410. |
| [AH-008-aslak-hellesoy](../slices/13-repo-features-tooling.md) | low | testing | CONFIRMED | S | BDD-007 | Track sessions by the Gherkin name in the Password World (as SessionWorld's aliasActor/sessionIdOf already do) and use the emails the feature text names; per-scenario World isolation removes the need for suffixed emails. |
| [AH-009-aslak-hellesoy](../slices/13-repo-features-tooling.md) | low | testing | PARTIAL | S | BDD-007 | Make 'the replayed action is not performed a second time' observable: snapshot the published-events log (and the user's verified state) before the replay and assert the replay added only `auth.token.replay` and changed no user state. |
| [BDD-007](../slices/13-repo-features-tooling.md) | low | dx | CONFIRMED | S | — | Extract the shared harness (cookieFrom, STRONG_PASSWORD, capturingMailer factory, TestServices, letForkedFibersRun, request helper, named-actor/session registry) into features/step-definitions/shared/ and import it from every World. |
| [BDD-008](../slices/13-repo-features-tooling.md) | low | correctness | CONFIRMED | S | BDD-007 | Introduce a 'current actor' cell in the World set by every step that names an actor, and have pronoun/implicit-subject Thens read it instead of the literal 'alice'. |
| [CSD-009](../slices/13-repo-features-tooling.md) | low | testing | PARTIAL | S | AH-007-aslak-hellesoy | Move the per-case failure wiring into the Given and add an acceptance-level fail-closed counterpart: a Scenario Outline over timeout/5xx/malformed under onUnavailable: "reject" expecting 422, which distinguishes 'unavailable' from 'not breached'. |

## `bdd-skip-debt` — Pay down scenario-level @skip debt in the 4 wired feature files

Slices: [13-repo-features-tooling](../slices/13-repo-features-tooling.md) · ~21h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AH-005-aslak-hellesoy](../slices/13-repo-features-tooling.md) | medium | testing | CONFIRMED | L | — | Extend SessionWorld with (a) a repository read handle, (b) a structured-log/span capture, (c) TestClock-driven time control, then un-skip every sessions scenario whose skip rationale is a World-capability gap; keep @skip only for timing side-channel (REQ-EA-157..159) and cookie-browser-behaviour (REQ-EA-156) prunes. |
| [ESS-009](../slices/13-repo-features-tooling.md) | medium | testing | CONFIRMED | M | — | Reproduce the Encoding failure in a minimal packages/oauth unit test (Config.Redacted read from an env ConfigProvider inside a provider Layer), fix the root cause (awthaq usage or an upstream Effect v4 issue), then un-skip REQ-EA-346. |
| [PHS-005](../slices/13-repo-features-tooling.md) | medium | testing | CONFIRMED | M | — | Add a positive domain test for BEH-EA-116 rehash-on-login, then un-skip REQ-EA-313/314 via a PasswordWorld credential-hash read handle (or correct the skip text to cite the new test). |
| [SMS-008-session-management-specialist](../slices/13-repo-features-tooling.md) | low | testing | CONFIRMED | S | — | Split the Outline: a plain Scenario for password change (wired, runs now) and keep an @skip'd scenario (or Outline) for email change with an explicit 'no changeEmail capability' rationale. |

Closed by validation in this workstream: BDD-009 (DUPLICATE → AH-005-aslak-hellesoy)

## `bdd-suite-docs` — Bring features/README.md, STYLE.md, the REQ manifest gate and contract-stratum spec in line with reality

Slices: [13-repo-features-tooling](../slices/13-repo-features-tooling.md) · ~3h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AH-006-aslak-hellesoy](../slices/13-repo-features-tooling.md) | medium | docs | CONFIRMED | S | — | Rewrite features/README.md and features/STYLE.md to the real operating model (wired/unwired split, @skip/@unwired conventions, allocator-owned REQ tags, run commands) and scope the pre-implementation banner to @unwired files only. |
| [TIR-006](../slices/13-repo-features-tooling.md) | low | docs | CONFIRMED | S | — | Amend BEH-EA-031 to six endpoints, add revokeAll to the 04-contract-stratum endpoint table, and add a wired sessions scenario for revoke-all under BEH-EA-054. |
| [AH-010](../slices/13-repo-features-tooling.md) | info | docs | PARTIAL | S | — | Harden spec/scripts/verify-traceability.sh check 4 into a bijection check between @REQ-EA tags in features/features and rows of features/traceability.md, and refresh its stale 602 comments. |

Closed by validation in this workstream: BDD-006 (DUPLICATE → AH-006-aslak-hellesoy), BDD-004 (DUPLICATE → AH-006-aslak-hellesoy)

## `build-tooling-hygiene` — Build/test tooling hygiene

Slices: [01-core-sessions-users](../slices/01-core-sessions-users.md) · ~6h · depends on workstreams: `httpapi-surface-consolidation`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AH-006-anders-hejlsberg](../slices/01-core-sessions-users.md) | medium | api | PARTIAL | S | — | Add a consumer-resolution guard to package:smoke rather than rewriting emitted declarations. |
| [MTS-001](../slices/01-core-sessions-users.md) | medium | correctness | CONFIRMED | S | MW-002 | Trim every tsconfig.src.json references list to its transitive src-import closure and add a CI guard. |
| [ELC-004](../slices/01-core-sessions-users.md) | low | dx | CONFIRMED | M | — | Provide ready-made crypto-provided memory aggregates and migrate tests. |

## `ci-release-hardening` — Release workflow supply-chain hardening, publishability and versioning policy

Slices: [13-repo-features-tooling](../slices/13-repo-features-tooling.md) · ~6h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AVS-009](../slices/13-repo-features-tooling.md) | medium | dx | CONFIRMED ⚖️ decision | S | — | Write a versioning & deprecation policy (pre-1.0 and post-1.0 rules) into CONTRIBUTING.md plus a short ADR, and make changesets mandatory for package-affecting PRs. |
| [MM-006](../slices/13-repo-features-tooling.md) | medium | compliance | CONFIRMED | S | — | SHA-pin every action in release.yml (reuse check.yml's SHAs; resolve changesets/action's v1 tag to a commit), make zizmor enforce hash-pinning repo-wide, and gate release on a green Check run. |
| [MW-005](../slices/13-repo-features-tooling.md) | medium | dx | CONFIRMED ⚖️ decision | M | MM-006 | Make the pipeline actually publishable, then exercise it with one canary leaf package once the human-only prerequisites (git remote + npm trusted publisher) exist. |

Closed by validation in this workstream: MTS-006 (DUPLICATE → MM-006)

## `examples-memory-server` — Make the memory example a complete, secure-by-default showcase

Slices: [13-repo-features-tooling](../slices/13-repo-features-tooling.md) · ~2h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [DESS-002](../slices/13-repo-features-tooling.md) | medium | dx | CONFIRMED | S | — | Ship a dev `Mailer.layerConsole` in @awthaq/ports (logs recipient/template/data incl. the token via Effect.logInfo, and records for `sent`), wire it into the memory example through TestAuth.layer's middleware slot, and extend the example README walkthrough with the verify-email step. |
| [CSD-010](../slices/13-repo-features-tooling.md) | low | dx | CONFIRMED | S | — | Compose the enforcing `RateLimiter.layer` over `RateLimiter.layerStoreMemory` and `Password.config({ breachCheck: { onUnavailable: "allow" } })` in both runnable compositions (memory example and the README/sql-server example), with a comment on swapping the store for production. |

## `quality-metrics-regeneration` — Retire or guard the stale, unreproducible quality-metrics dashboard

Slices: [13-repo-features-tooling](../slices/13-repo-features-tooling.md) · ~2h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [DESS-005](../slices/13-repo-features-tooling.md) | medium | docs | CONFIRMED | S | MTS-011 | Canonical for the seven 'stale .quality-metrics' findings: discard the Sep-12 snapshot and add the renderer freshness guard so stale numbers cannot be rendered silently. |
| [MTS-011](../slices/13-repo-features-tooling.md) | low | dx | CONFIRMED ⚖️ decision | S | — | Pick one side of the generated/committed boundary. Recommended: stop tracking the rendered HTML, keep inputs local, and make the renderer refuse stale inputs. |

Closed by validation in this workstream: TTE-007 (DUPLICATE → DESS-005), NSA-009 (DUPLICATE → DESS-005), AH-005-anders-hejlsberg (DUPLICATE → DESS-005), WPS-011 (DUPLICATE → DESS-005), TS-006-tim-smart (DUPLICATE → DESS-005), SSMS-010 (DUPLICATE → DESS-005)

## `test-harness-completeness` — TestAuth memory bundle completeness and real migration determinism

Slices: [02-core-events-hooks](../slices/02-core-events-hooks.md) · ~8h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ETVS-004](../slices/02-core-events-hooks.md) | medium | dx | PARTIAL | M | — | Complete the memory bundle, rename the second parameter, and migrate the hand-rolled suites onto TestAuth.layer. |
| [SSMS-004](../slices/02-core-events-hooks.md) | medium | testing | CONFIRMED | M | — | Run the built migrations twice against two fresh in-memory SQLite databases and compare resulting schemas; keep the cheap declaration check under an honest name. |

Closed by validation in this workstream: ETVS-005 (DUPLICATE → SSMS-004)

## `bdd-plugin-coverage` — Behaviors + features for shipped jwt and organization

Slices: [12-spec](../slices/12-spec.md) · ~12h · depends on workstreams: `jwt-key-rotation-runbook`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [BDD-005](../slices/12-spec.md) | medium | testing | PARTIAL | L | KRS-008 | Close the real gap — jwt and organization ship without behaviors or acceptance scenarios — by writing their spec/behaviors files and .feature restatements; record magic-link/api-key/two-factor as 'behaviors-before-code' prerequisites of their builds. |

## `property-based-testing` — Schema-derived property tests via @effect/vitest it.prop

Slices: [13-repo-features-tooling](../slices/13-repo-features-tooling.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ETVS-002](../slices/13-repo-features-tooling.md) | medium | testing | CONFIRMED | M | — | Introduce Schema-derived property tests with @effect/vitest `it.prop`/`it.effect.prop`, starting with pure codecs and wire schemas. |

## `tsconfig-paths-drift` — tsconfig paths drift check

Slices: [09-ports-apikey-cli](../slices/09-ports-apikey-cli.md) · ~1h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [MM-002](../slices/09-ports-apikey-cli.md) | medium | dx | CONFIRMED | S | — | Remove the stale edges and add a tsconfig-vs-package.json drift check to `pnpm check`. |

## `dev-scripts-tooling` — Root dev scripts: root-anchored, fail-loud, cross-platform, single-source config

Slices: [13-repo-features-tooling](../slices/13-repo-features-tooling.md) · ~6h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ELC-003](../slices/13-repo-features-tooling.md) | low | dx | CONFIRMED | S | — | Break the one existing type cycle, then make circular.mjs run a second, type-inclusive madge pass (and scan .tsx) so type-level cycles fail `pnpm circular`. |
| [MM-003](../slices/13-repo-features-tooling.md) | low | dx | CONFIRMED | S | — | Pin typescript exactly and make the pair move together. |
| [MM-007](../slices/13-repo-features-tooling.md) | low | dx | CONFIRMED | S | MTS-009 | Fail fast with an actionable message when lib/ is missing, and give the example a prestart build. |
| [MM-009](../slices/13-repo-features-tooling.md) | low | dx | CONFIRMED | S | MTS-009 | Make build/clean cross-platform using Node APIs instead of PATH lookups and POSIX shell. |
| [MM-010](../slices/13-repo-features-tooling.md) | low | dx | CONFIRMED | S | — | Move target selection into `.oxfmtrc.json` (ignorePatterns) so `format` = `oxfmt` and `format:check` = `oxfmt --check` with no lists. |
| [MTS-009](../slices/13-repo-features-tooling.md) | low | dx | CONFIRMED | S | — | Anchor build.mjs/circular.mjs (and package-smoke.mjs's empty-guard) at the repo root and turn the empty-glob skip into a hard failure. |

## `package-and-test-hygiene` — Dependency classification and typed HTTP test decoding

Slices: [10-passkey-admin](../slices/10-passkey-admin.md) · ~2h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [MTS-010](../slices/10-passkey-admin.md) | low | correctness | CONFIRMED | S | — | Reclassify test-only workspace deps and add a src-imports-vs-dependencies smoke check so the drift cannot recur. |
| [TTE-009](../slices/10-passkey-admin.md) | low | testing | CONFIRMED | S | — | Decode HTTP test responses through the contract schemas instead of casting. |

## `bdd-organization-feature` — Specify and wire an organization BDD feature with an adversarial cross-tenant Rule

Slices: [13-repo-features-tooling](../slices/13-repo-features-tooling.md) · ~12h · depends on workstreams: `bdd-suite-docs`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [MTI-011](../slices/13-repo-features-tooling.md) | low | testing | CONFIRMED | L | — | Author spec/behaviors/28-organization.md (BEH-EA-221..228) from spec/models/14-organization.md, a matching 10-organization/28-organization.feature covering lifecycle (owner invariant, invitation expire/re-invite/cancel, limits, DAC escalation guard, active context) plus an adversarial cross-tenant Rule, and wire it with OrganizationWorld/OrganizationSteps. |

Closed by validation in this workstream: CWM-006 (DUPLICATE → MTI-011)

## `coverage-enforcement` — Enforce coverage thresholds (DoD gate 6)

Slices: [13-repo-features-tooling](../slices/13-repo-features-tooling.md) · ~1h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [MM-004](../slices/13-repo-features-tooling.md) | low | testing | CONFIRMED | S | — | Add workspace-wide coverage thresholds (floor just under the measured values) plus per-package overrides following ../qadi's pattern, and fix the ambiguous comment. |

Closed by validation in this workstream: ETVS-007 (DUPLICATE → MM-004)

