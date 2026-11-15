# Milestones

## v1.0 Architecture Deepening, batch 3 (Shipped: 2026-11-15)

**Phases completed:** 7 phases, 52 plans, 24 tasks

**Key accomplishments:**
- Measured gate baseline committed first (knip exit 1 on 39 untracked `.claude/` files plus 3 unlisted deps), then an 88-case plugin-view matrix and openapi / migration apply / config list pins, all green against untouched `packages/cli/src`.
- Every `awthaq plugin list` view (default, `--graph`, `--hooks`, `--rules`, `--events`) now renders through one `PluginViews.render` that resolves `--format` and the global `--json` once, with the 88-case Wave 0 matrix green and unedited.
- `awthaq config list` is now an inline handler in Cli.ts (the ConfigList module and its barrel export are deleted), and `openapi` stdout plus `migration apply`'s plan document and applied line go through `Output.report`, all with the Wave 0 byte pins green and unedited.
- Mechanical 47-name TestAuth surface snapshot (TS 5.9.3 compiler API probe), the full gate baseline, and a permanent TestAuthSurface.test.ts that pins 23 values and 24 type names, all captured green on untouched packages/test/src.
- TestAuth's composition (test ports, redaction guard, makeLayer, the layer overloads, encryption and the HTTP client doubles) now lives verbatim in internal/composition.ts behind named facade re-exports, with the two foundation type names moved beside FoundationRegistries.
- TestAuth's request-fact scoping, session and CSRF minting now live verbatim in internal/session.ts, and the app harness (serve, listen, withApp, lazyApp, buildContext) with the open-app counter lives verbatim in internal/appHarness.ts, both behind named facade re-exports.
- The contract runner (runPluginContractTests, migratedSchema with its single `TestSql.schemaOf` call) now lives verbatim in internal/contractRunner.ts, and TestAuth.ts is a pure named-re-export facade whose public surface probes byte-identical to the pre-split snapshot.
- The spec now cites where the TestAuth composition, harness and contract runner live (Revisions 1.16 / 1.90 / 1.10), and every Wave 0 gate matches at phase close, with +1 file and +1 test from TestAuthSurface.test.ts and nothing lost.
- Phase 3 gate baseline measured on an untouched tree, plus a 12-case golden test that pins all three keyset cursor wire encodings (users and organizations createdAt, impersonations startedAt) byte for byte on memory and SQL.
- Wave 0 closes: 22 new cases pin today's caller-visible page behaviour of the three listings and the organization wire cursor against untouched src, so every later keyset plan proves it kept them.
- `@awthaq/ports` gains `Keyset`: one declared order per listing, one `paginate` that owns the 1..200 clamp, the only `limit + 1`, the trim and the next cursor, and a memory `window` derived from the same keys; no listing adopts it yet.
- `@awthaq/sql` gains `KeysetSql`: one row-value predicate `("c1", "c2") > (?, ?)` (or `<`) and one `ORDER BY` derived from the `Keyset.Declaration` a listing already declares, a mixed-direction declaration refused at `make`; no listing adopts it yet.
- Users page through one declaration (`UserStore.pageOrder`), one `Keyset.paginate` and one page contract on memory and SQL, with cursor bytes unchanged (golden green), core's clamp deleted, and the page field renamed `nextCursor` everywhere; the users StoreContract suite gains the KEY-05 page-order cases.
- Organizations page through one declaration (`pageOrder`) and one `Keyset.paginate` per adapter, with `limit + 1` applied once inside the store, the directory passing the page through, AdminTenants reduced to its gate, and cursor bytes unchanged (golden, pins and HTTP pins green unedited).
- Impersonation history pages through one declaration (`startedAt` desc / `id` desc) and one `Keyset.paginate` per adapter, the wire `limit` bound is the module's own constants, the last clamp copies are gone (KEY-06 scoped grep 0), and cursor bytes are unchanged (golden IMP_N1/IMP_N2, pins and HTTP pins green unedited).
- BEH-EA-036 now describes the shipped keyset module (core-port scope, one owner of the extra row, collation and whole-millisecond declarations), traceability cites all six new test files, and one changeset ships the six-package minor with its Migration paragraph.
- Every local gate matches or improves on the Wave 0 baseline (files 411 to 417, tests 6491 to 6593, coverage up on all four axes), the phase diff stays inside its allowlist with the KEY-07 paths untouched, the clamp copies and hand-written seeks are gone, and every Postgres confirmation is listed as an open CI item rather than a pass.
- Gate and Postgres baseline at an untouched tree, plus green-on-today's-src pins for OIDC (memory and SQL), SAML and the DomainClaims first-foreign-domain rule, and the SCIM orphan recorded as finding F-04-01 with a characterization test.
- Four SAML scenarios (REQ-EA-1569..1572) and a three-case Postgres race test land before any src change: the BDD suite is red by exactly the three suspended-organization rows, and the race file is red 3 of 3 on Postgres 16 (deadlock victim as StoreUnavailable, orphan connection, claim and owner rows).
- DomainClaims.layerSql now takes an organization-scoped Postgres advisory lock around claim, release and release-all (`SqlStore.atomically`) and inserts owner rows in sorted order while still refusing on the first foreign domain in input order; the opposite-order race case is green on Postgres 16.
- OrganizationConnectionLifecycle: one exposed organization service owning the suspended-organization gate, claim-then-write atomicity with in-transaction compensation, claims-first removal, the single domain normaliser and the order -1 claim release on organization deletion, parameterised by a protocol descriptor (no store uses it yet).
- The OIDC connection store is now one `oauthProtocol` descriptor and three lifecycle calls; its own gate, claim wrapper, domain regex and normaliser are deleted, and all three Postgres race cases pass.
- The SAML connection store is now one `samlProtocol` descriptor and four lifecycle calls; a suspended organization can no longer gain, update or refresh a SAML connection (it can still delete one), and the BDD red window is closed.
- `DomainClaims` is gone from the organization root export, a boundary test keeps it that way, and the two sequence helpers (`withClaim`, `withRelease`) are deleted so the lifecycle is the only claim-and-write sequence.
- BEH-EA-317's Postgres known limit is replaced by the lifecycle's guarantee (one unit, advisory lock, sorted owner rows, claims first on removal, create re-check), BEH-EA-318/237/235 state that a suspended organization's SAML and OIDC connections cannot be created, updated or refreshed but can be removed, and a changeset carries the migration.
- The phase meets every 04-01 baseline gate on SQLite and on the CI Postgres image: allowlist clean, SCIM untouched except the characterization test, census at its expected end state, no oracle edited; CI confirmation stays open (no git remote).
- 05-BASELINE.md records every gate, the Postgres full suite and the four-list census at HEAD, and CoreTablePins.test.ts freezes the RLS coverage matrix, the six sealed AADs and the created-table set before any src change.
- 06-BASELINE.md records every gate at HEAD `567c6985` on SQLite, the nine record-store Contract suites (RC9) on SQLite (1334 tests) and Postgres (1346 tests), the full Postgres unit and bdd runs, and fixes the close rule and path allowlist before the spike.
- ADR-EA-041 is Revision 1.7: a revision note and alternative (e) record plan 24 Track A (SQLite as the memory adapter) closed and ADR-EA-046 released, with decision text unchanged.

---

**Follow-up (2026-11-15):** the audit tech-debt items were taken on after the close; outcomes and remaining open items are in `.planning/milestones/v1.0-FOLLOWUP.md`.
