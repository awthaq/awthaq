# P19 — Spec & documentation truthfulness

Phase 0 · 27 open issues to fix (1 high, 7 medium, 15 low, 4 info) · 5 closed by validation · ~42h summed per-issue estimate (upper bound) · 0 need a decision first.

Each issue below links to its full dossier (evidence at HEAD `ec065a7`, fix steps, tests, acceptance) in its slice file. Work workstream by workstream, top to bottom; within a workstream do the canonical issue first — its fix closes the listed duplicates.

## `spec-status-banner-sweep` — Replace stale 'pre-implementation / no code exists' banners across spec/ and guard them mechanically

Slices: [12-spec](../slices/12-spec.md) · ~7h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [DTWS-001](../slices/12-spec.md) | high | docs | CONFIRMED | M | — | Replace the five tree-level 'planned system / pre-implementation' banners (README, overview, glossary, urs, invariants) with one accurate status paragraph modelled on roadmap.md:17, and add a verify-traceability check that fails on the stale phrases so the drift cannot recur. |
| [IDS-009](../slices/12-spec.md) | low | docs | CONFIRMED | S | DTWS-007 | Replace the 27-admin-impersonation.md banner with implementation pointers, rewrite INV-EA-014's Enforcement cell to name the existing tests, and refresh packages/admin/README.md and model 15. |
| [AOMS-011](../slices/12-spec.md) | info | docs | CONFIRMED | S | DTWS-001 | Cut adoption-matrix Revision 1.2: add a 'Shipped (unpublished)' status, flip the six implemented rows, rewrite §0/§1/§5 prose, keep the unimplemented rows Planned. |
| [OCM-008](../slices/12-spec.md) | info | docs | PARTIAL | S | DTWS-001 | Positive finding is correct about the plugin, but 07-api-keys.md carries two stale sentences; fix them in the banner sweep. (Rotation/transport decisions are OCM-005's, not this ID's.) |

## `readme-docs-accuracy` — Root README accuracy + typechecked quickstart example

Slices: [13-repo-features-tooling](../slices/13-repo-features-tooling.md) · ~11h · depends on workstreams: `examples-memory-server`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [DTWS-003](../slices/13-repo-features-tooling.md) | medium | dx | CONFIRMED | S | — | Correct the README's plugin/package inventory: remove `next` from the stub list, add a row describing what @awthaq/next ships, and fix the same claim in .scratch/shipping-gaps/map.md. |
| [DTWS-004](../slices/13-repo-features-tooling.md) | medium | docs | CONFIRMED | S | — | Bring the README's package inventory in line with packages/: add Roles to the repo map, plugin table and composition comment, and list the other unlisted packages (client, react, qadi, migrate-auth0, migrate-better-auth). |
| [CSS-005](../slices/13-repo-features-tooling.md) | low | docs | CONFIRMED | S | — | Correct the sample header to SameSite=Strict and add one sentence explaining why OAuth uses its own Lax __Host-oauth-state flow cookie (IC-005's addition). |
| [DESS-008](../slices/13-repo-features-tooling.md) | low | docs | CONFIRMED | S | DESS-002 | Add a 'No database handy?' callout at the top of the Quickstart pointing to examples/memory-server (and to examples/sql-server's SQLite default from SEA-007/SMS-006), once DESS-002 makes the example's sign-in completable. |
| [IC-010](../slices/13-repo-features-tooling.md) | low | dx | CONFIRMED | S | — | Add an explicit, opt-in `KeyProvider.layerEphemeral` (random 32-byte key generated at layer build, loud warning that ciphertext won't survive a restart) for dev/examples; keep layerEnv as the production path. Do not silently auto-fallback from layerEnv (that would lose encrypted data in a misconfigured prod). |
| [NHS-009](../slices/13-repo-features-tooling.md) | low | security | CONFIRMED | S | SMS-006-secrets-management-specialist | Keep AuthHttp.docs as specified (BEH-EA-084) but make the quickstart/example gate it behind a Config flag defaulting off, and document that production compositions should omit it or put it behind their own auth. |
| [SMS-006-secrets-management-specialist](../slices/13-repo-features-tooling.md) | low | dx | CONFIRMED | M | DESS-002 | Load DATABASE_URL through Config (`PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })`) — and, because validation shows the whole quickstart has drifted into not type-checking (Mailer shape, missing AuditLog, missing CsrfProtection), move the quickstart into a real, workspace-typechecked example that the README embeds/links so it can never drift again. |
| [SEA-007](../slices/13-repo-features-tooling.md) | info | architecture | CONFIRMED | S | SMS-006-secrets-management-specialist | Make examples/sql-server (created for SMS-006) default to a SQLite file and switch to Postgres when DATABASE_URL is set — a living proof of README.md:200's one-layer-swap claim. |

Closed by validation in this workstream: IC-005 (DUPLICATE → CSS-005), CWM-007 (DUPLICATE → DTWS-003)

## `spec-behavior-code-reconcile` — Reconcile behavior/model spec text with shipped code semantics (next, react, passkey, qadi resolvers)

Slices: [12-spec](../slices/12-spec.md) · ~9h · depends on workstreams: `spec-status-banner-sweep`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [NAM-010](../slices/12-spec.md) | medium | docs | CONFIRMED | S | — | Code is ground truth here (implementation decisions recorded in .scratch/next-package/spec.md §'withNextCookies shape and scope'): rewrite 24-nextjs-ssr.md's status banner and the BEH-EA-185/189/190 code examples to the shipped signatures; keep the REQUIREMENT texts (the code satisfies them). |
| [AAPS-007](../slices/12-spec.md) | low | docs | CONFIRMED | S | — | Spec follows code for the attribute set (no billing plugin exists; don't invent `plan`); code follows spec for the failure contract — UserAttributes must map a user-table defect to AttributeResolveError. Also refresh the stale 'unhandled resolver conflict' paragraph now that attributeResolverRegistry ships. |
| [BPAS-007](../slices/12-spec.md) | low | docs | CONFIRMED | M | — | Replace the three stale banners and give the shipped passkey ceremony logic a normative home: new BEH ids for Conditional Create, registration-freshness (reauth) and webauthnUserId generation, and an amended BEH-EA-130/131 for the config-gated UV policy. |
| [HSK-009](../slices/12-spec.md) | low | docs | CONFIRMED | S | AOMS-011 | Refresh model 03 to the shipped state and fix the TTL/storage misquote. |
| [RSC-008](../slices/12-spec.md) | low | docs | CONFIRMED | S | — | Replace 23-react.md's banner with implementation pointers and document the two shipped divergences (two-atom session/subject design; Providers' initialSubject seed prop) against BEH-EA-177/179; fix the react README. |
| [RZS-007](../slices/12-spec.md) | low | docs | PARTIAL | S | RZS-001, AAPS-007 | Only the banner needs fixing; the code deviation note already exists and the REQUIREMENT stays (ticket 13 makes the code meet it). Sequence after RZS-001 so the banner can truthfully say BEH-EA-161/162/163/165 are implemented. |

Closed by validation in this workstream: BO-008 (DUPLICATE → NAM-010), IC-006 (DUPLICATE → NAM-010)

## `spec-bdd-traceability-refresh` — Make the BDD/traceability/invariants records describe the suite and tests that actually exist

Slices: [12-spec](../slices/12-spec.md) · ~6h · depends on workstreams: `spec-status-banner-sweep`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [BDD-003](../slices/12-spec.md) | medium | docs | PARTIAL | S | DTWS-006 | The substantive drift (missing 27-admin row, 602 vs 627) was fixed by 6887fb5. Finish the job: bump the manifest's and spec/traceability.md's Document Control, fix every residual '602' range, and make manifest freshness a CI-checked property. |
| [DTWS-006](../slices/12-spec.md) | medium | docs | CONFIRMED | S | — | Rewrite every 'no runner / no step layer' claim to describe the real suite: vitest + @effect-cucumber/vitest, features/step-definitions/, 6 wired / 22 `@skip @unwired` feature files, run by `pnpm test:bdd` inside `pnpm check`. |
| [TMS-009](../slices/12-spec.md) | low | docs | CONFIRMED | M | — | Regenerate every INV-EA-007..016 Enforcement cell against the real tree (cite the actual test + BEH id, or state honestly 'no test') and add a verify-traceability check that fails when a cell says '(no test exists yet)' for a file that exists, or names a file that doesn't. |

Closed by validation in this workstream: DTWS-007 (DUPLICATE → TMS-009)

## `spec-roadmap-status-reconcile` — Reconcile gate/milestone status between definitions-of-done.md and roadmap.md

Slices: [12-spec](../slices/12-spec.md) · ~2h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [DTWS-005](../slices/12-spec.md) | medium | docs | CONFIRMED | S | MM-005 | Finish the rev-1.2 pass: rewrite roadmap line 84 and the gate table (lines 88-98) to separate 'implementation status' from 'gate status', deriving gate status from MM-005's gate→script mapping. |
| [MM-005](../slices/12-spec.md) | low | docs | CONFIRMED | S | — | Add a 'Wired as' column mapping each of the 14 gates to the exact `pnpm check` step (or 'not wired'), flip Active? cells to the truth, and delete the 'nothing exists' prose; add a spec:verify check that every gate marked Active names a script present in package.json. |

## `spec-surface-inventory-reconcile` — Reconcile ADR/overview surface inventories with shipped exports and endpoints (DoD gate 10)

Slices: [12-spec](../slices/12-spec.md) · ~5h · depends on workstreams: `spec-status-banner-sweep`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AVS-008](../slices/12-spec.md) | medium | docs | CONFIRMED | M | — | Revise ADR-EA-003 to 1.1 with the shipped core inventory (session incl. revokeAll; account: updateProfile, deleteUser; subject owned by @awthaq/qadi), flip status to implemented across all ADRs whose decision has shipped, and mechanize DoD gate 10 so contract inventory drift fails CI. |
| [DTWS-008](../slices/12-spec.md) | low | docs | CONFIRMED | S | DTWS-001, AVS-008 | Reconcile overview.md's Ports row (line 47) and Ports stratum surface table (lines 90-96) with the nine shipped modules and their real layer constructors; fix 'Context.Tag' → 'Context.Service'/'Context.Reference'; reuse AVS-008's surface script to keep it honest. |

## `design-docs-archive` — Correct ADR-EA-008's AuthPlugin.layer description

Slices: [13-repo-features-tooling](../slices/13-repo-features-tooling.md) · ~1h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ELC-005](../slices/13-repo-features-tooling.md) | low | docs | CONFIRMED | S | — | Fix the governing ADR-EA-008 text to the shipped two-step algebra and point to HookPoint `.tap` layers + per-plugin *HooksLive merges as the tap mechanism; leave archive/ as historical record but add a one-line correction note. |

## `spec-model-drift` — Stale JWT/Bearer model doc

Slices: [09-ports-apikey-cli](../slices/09-ports-apikey-cli.md) · ~1h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [JJS-010](../slices/09-ports-apikey-cli.md) | info | docs | CONFIRMED | S | — | Correct spec/models/08-jwt-bearer.md so it distinguishes the shipped Jwt plugin from the still-missing Bearer strategy. |

