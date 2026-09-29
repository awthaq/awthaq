# Slice 13 — repo-features-tooling: validation & fix plan

**Validated at:** `ec065a7` (HEAD) · **Date:** 2026-09-29 · **Rows:** 86 · **Machine-readable:** [`13-repo-features-tooling.json`](13-repo-features-tooling.json)

> **ID collisions.** Two different auditors use each of the prefixes `AH-`, `ESS-`, `SMS-` and `TS-`. This manifest contains both issues of the `AH-004`, `AH-005`, `AH-008` and `AH-009` pairs, one by `anders-hejlsberg` and one by `aslak-hellesoy`. They are written here as `AH-00N (persona)`. In the JSON, `issue_file` is the unique key. Every `duplicate_of`, `duplicates` or `depends_on` value, and every workstream `ids` entry, that uses one of these prefixes is written as the issue-file stem, for example `AH-004-aslak-hellesoy`, `TS-005-torin-sandall`, `SMS-006-secrets-management-specialist`, `ESS-008-effect-stream-specialist`, or `ESS-002-effect-schema-specialist` for the oauth-cast finding AH-004 (anders-hejlsberg) depends on. Where dossier prose uses a bare ID, read it this way: AH-003, AH-005, AH-006, AH-007 and AH-008 in the BDD dossiers mean the `aslak-hellesoy` issues, AH-005 in the quality-metrics dossiers means `anders-hejlsberg`, TS-006 means `tim-smart`, TS-005 means `torin-sandall`, and SMS-006 means `secrets-management-specialist`.

## Counts (verdict × level)

| Verdict | high | medium | low | info | total |
|---|---|---|---|---|---|
| CONFIRMED | 2 | 25 | 24 | 2 | 53 |
| PARTIAL | 0 | 4 | 2 | 1 | 7 |
| ALREADY-FIXED | 0 | 1 | 0 | 0 | 1 |
| INVALID | 0 | 1 | 1 | 0 | 2 |
| DUPLICATE | 0 | 6 | 8 | 6 | 20 |
| WONTFIX-CANDIDATE | 0 | 1 | 0 | 2 | 3 |
| **total** | 2 | 38 | 35 | 11 | **86** |

Recommended statuses: `ready-for-agent` 55, `ready-for-human` 5, `resolved` 21, `wontfix` 5.

## What is really wrong in this area

The area's defects fall into four groups.

- **BDD suite.** Since BDD-002 (ba24ce5) every `.feature` file has a `*.steps.test.ts`, but 22 of the 28 files are zero-step `@skip @unwired` placeholders. The measured run is 104 passed and 591 skipped out of 695 scenarios. Even the four wired files carry heavy scenario-level `@skip` debt, for example 18 of 24 in sessions. Their step glue fakes coverage in several ways: vacuous `Effect.void` Thens, Givens that perform the action, a bare `{string}` catch-all step, a hardcoded `"alice"`, and per-World copies of every helper. The suite's own README and STYLE still describe a pre-implementation world.
- **Release and tooling.** The release path has never run. It tag-pins actions under `id-token: write`, is not gated on CI, and publishes with `access: restricted` while leaving 2 of the 23 packages out of the lockstep group. There is no versioning policy. Five hand-synced package rosters have already drifted. The declared no-`as` rule is unenforced, with 11 casts in library source. Madge skips type imports and so misses a real `AuditLog` ↔ `AuthEvents` type cycle. Coverage is collected but never gated. The `.quality-metrics` dashboard is one stale snapshot, and the extractor that produced it no longer exists.
- **Docs and examples.** The README quickstart no longer type-checks: the Mailer is missing `sent`, and it never provides the `AuditLog` or `CsrfProtection` layers. The README also misstates SameSite, the stub list and the package inventory. The memory example cannot complete a sign-in, and it runs with throttling off.
- **Runtime gaps in this slice.** There is no default request-body size limit on the serving path (NHS-004). There is no event replay by sequence (ESA-003, half-fixed by 6bd3f1d). The WebAuthn Signals API is absent (TC-004).

The CLI rows are spec-contract fixes only, because `packages/cli` is still `export {}`. Findings against `node_modules/@qadi` are routed to `../qadi` or to wayfinder ticket 12, or closed as deliberate qadi design.

## Workstreams

| # | Workstream | IDs | Effort | Depends on workstreams |
|---|---|---|---|---|
| 1 | `server-request-limits` — Default request-body cap with 413 on the serving path | NHS-004 | M | — |
| 2 | `ci-release-hardening` — Release workflow supply-chain hardening, publishability and versioning policy | MM-006, MW-005, MTS-006, AVS-009 | M | — |
| 3 | `cli-contract` — CLI spec contract: import write-safety, exit codes, and BEH-EA-208 command classes | CTA-003, ECS-002, ECS-003 | M | — |
| 4 | `workspace-roster-sync` — Single source of truth for the package roster and honest stub manifests | MTS-003, MTS-004, MTS-005 | M | — |
| 5 | `dev-scripts-tooling` — Root dev scripts: root-anchored, fail-loud, cross-platform, single-source config | MM-010, MM-003, MTS-009, MM-009, ELC-003, MM-007 | M | — |
| 6 | `tooling-typecheck-lint` — Enforce the type-safety profile the repo claims (lint rule for assertions, strict index access, DOM lib scoping) | AH-004 (anders-hejlsberg), AH-008 (anders-hejlsberg), AH-009 (anders-hejlsberg) | M | oauth-untrusted-json-decoding (cross-slice: ESS-002/TTE-002/TTE-003) |
| 7 | `coverage-enforcement` — Enforce coverage thresholds (DoD gate 6) | MM-004, ETVS-007 | S | — |
| 8 | `quality-metrics-regeneration` — Retire or guard the stale, unreproducible quality-metrics dashboard | MTS-011, TTE-007, NSA-009, AH-005 (anders-hejlsberg), WPS-011, DESS-005, TS-006, SSMS-010 | S | — |
| 9 | `bdd-suite-docs` — Bring features/README.md, STYLE.md, the REQ manifest gate and contract-stratum spec in line with reality | AH-006, BDD-006, BDD-004, TIR-006, AH-010 | M | — |
| 10 | `bdd-step-definition-quality` — BDD step-definition honesty: no vacuous steps, no Given/When inversion, shared harness | AH-004 (aslak-hellesoy), AH-008 (aslak-hellesoy), TIR-005, AH-009 (aslak-hellesoy), AH-007, CSD-009, BDD-008, BDD-007 | L | — |
| 11 | `bdd-skip-debt` — Pay down scenario-level @skip debt in the 4 wired feature files | SMS-008, AH-005 (aslak-hellesoy), BDD-009, PHS-005, ESS-009 | L | — |
| 12 | `bdd-feature-wiring` — Wire the 22 @unwired feature files per decision 36's risk tiers | OCM-004, ESS-008, THS-006, TS-005, AH-003, ETVS-008 | XL | bdd-suite-docs |
| 13 | `bdd-organization-feature` — Specify and wire an organization BDD feature with an adversarial cross-tenant Rule | MTI-011, CWM-006 | L | bdd-suite-docs |
| 14 | `examples-memory-server` — Make the memory example a complete, secure-by-default showcase | DESS-002, CSD-010 | S | — |
| 15 | `readme-docs-accuracy` — Root README accuracy + typechecked quickstart example | NHS-009, DESS-008, IC-010, CSS-005, IC-005, DTWS-003, CWM-007, DTWS-004, SMS-006, SEA-007 | M | examples-memory-server |
| 16 | `design-docs-archive` — Correct ADR-EA-008's AuthPlugin.layer description | ELC-005 | S | — |
| 17 | `observability-substrate` — HTTP tracer/request-logger re-exports and example wiring (wayfinder 27) | EOTS-006 | S | — |
| 18 | `events-delivery-durability` — Replayable durable event log (AuditLog.replay by sequence) | ESA-003 | M | — |
| 19 | `qadi-decision-cache-invalidation` — qadi DecisionCache scope + invalidation (wayfinder ticket 12) | PCS-005, YL-007, AAPS-005 | M | PCS-001/RZS-002 implementation (cross-slice) |
| 20 | `roles-permission-modeling` — Document exact-key permission modeling and definition-time bundling | YL-006, RRM-008 | S | — |
| 21 | `property-based-testing` — Schema-derived property tests via @effect/vitest it.prop | ETVS-002 | M | — |
| 22 | `passkey-browser-signals` — WebAuthn Signals API in @awthaq/client | TC-004 | M | — |
| 23 | `device-authorization-grant` — Normative RFC 8628 spec before Phase 3 | DAG-001, DAG-005 | M | — |

### 1. `server-request-limits` — Default request-body cap with 413 on the serving path

**IDs:** NHS-004 · **Effort:** M · **Depends on workstreams:** none

**Rationale:** Standalone memory-exhaustion DoS fix in @awthaq/server; Effect's Node body reader already honors MaxBodySize.

- **IDs:** NHS-004
- **Why grouped:** Standalone memory-exhaustion DoS fix in @awthaq/server; Effect's Node body reader already honors MaxBodySize.
- **Effort:** M · **Order hint:** 1 · **Depends on:** none
- **Ordered steps:**
  1. packages/server/src/BodyLimit.ts: global HttpRouter middleware providing HttpIncomingMessage.MaxBodySize from a Context.Reference config (default 256 KiB).
  2. Map oversize body failure to 413 (new tagged error with httpApiStatus 413 in the api error taxonomy).
  3. Include in canonical composition + example; new BEH-EA in spec/behaviors/11-http-error-mapping.md.
- **Test plan:** packages/server/test/BodyLimit.test.ts: 1 MiB body -> 413 on Node server and toWebHandler paths; normal body OK.
- **Acceptance:** Default wiring rejects oversize bodies with 413; configurable.

### 2. `ci-release-hardening` — Release workflow supply-chain hardening, publishability and versioning policy

**IDs:** MM-006, MW-005, MTS-006 (dup → MM-006), AVS-009 · **Effort:** M · **Depends on workstreams:** none

**Rationale:** All concern the never-run release path (release.yml + changesets): pin actions and gate on CI first, then fix changeset config (access, fixed group), write the versioning policy, then canary-publish.

- **Closes:** MM-006 (canonical; MTS-006 is its duplicate), MW-005, AVS-009
- **Why grouped:** these are the unexercised release path, and the steps are ordered.
- **Ordered steps:**
  1. MM-006: SHA-pin all 4 release.yml actions. Add `.github/zizmor.yml` with `unpinned-uses` set to hash-pin `*`. Gate release on a green Check run (`workflow_run`).
  2. MW-005 agent prep: set `.changeset/config.json` `access` to public (or per-package `publishConfig`). Add migrate-auth0 and migrate-better-auth to `fixed`. Add a `release:dry-run` script.
  3. AVS-009: write the versioning/deprecation ADR and the CONTRIBUTING section. Enforce with `changeset status` in PR CI once a remote exists.
  4. MW-005 human step: create the remote, the npm org and the trusted publisher. Then canary-publish `@awthaq/ports`.
- **Test plan:** static grep for `@v[0-9]` pins; zizmor clean; `pnpm release:dry-run`; `pnpm spec:verify:strict`. After the canary, check the npm provenance attestation.
- **Acceptance:** every action is SHA-pinned; release is gated on Check; the changeset config covers all 23 packages with public access; the policy ADR exists; one package is published with provenance.
- **Effort:** M.
- **Cross-workstream dependencies:** the fixed-group list overlaps MTS-004 (tooling-typecheck-lint, sibling fork: hand-synced package lists). AVS-002 (other slice) relies on the AVS-009 policy.

### 3. `cli-contract` — CLI spec contract: import write-safety, exit codes, and BEH-EA-208 command classes

**IDs:** CTA-003, ECS-002, ECS-003 · **Effort:** M · **Depends on workstreams:** none

**Rationale:** All three are defects in the same spec/behaviors/26-cli.md + 26-cli.feature contract for a CLI that is still an empty placeholder; they must land as one coherent 26-cli.md revision (shared with wayfinder ticket 06's pending BEH-EA-208 carve-out) before ticket 07's implementation (BE-003/BAM-001) builds against it. Exit codes (CTA-003) are referenced by ECS-002's refusal semantics.

- **Closes:** ECS-002 (high), CTA-003, ECS-003.
- **Why grouped:** one `26-cli.md` revision + one `26-cli.feature` edit; must also absorb wayfinder ticket 06's pending BEH-EA-208 session-command carve-out (CTA-002/DAG-003) so the REQUIREMENT is rewritten once. Ticket 07 (BE-003/BAM-001) implements against the result.
- **Ordered steps:**
  1. CTA-003 — add the CLI-wide exit-status table (0 ok / 1 findings / 2 usage / 3 refused-without-confirmation / 4 infrastructure / 130 interrupt) + `doctor --json`.
  2. ECS-003 + ticket 06 — rewrite BEH-EA-208 into three command classes (manifest-only: doctor, plugin list, routes, openapi; database-backed: migration status/apply, seed admin, import; session: login/logout/whoami), fix REQ-EA-600/601/602 examples and wording, fix `packages/cli` description strings.
  3. ECS-002 — extend BEH-EA-207 with plan-by-default, `--yes`, per-batch transactions + failure report, resumable `awthaq_import_runs` checkpoint (ticket 07 §6), `auth.import.completed|failed` event.
  4. New scenarios REQ-EA-628+ in 26-cli.feature (file stays `@skip @unwired`), traceability rows, `pnpm run spec:verify:strict`.
  5. When ticket 07 lands: tagged CLI errors with `[Runtime.errorExitCode]`, Import plan/confirm/batch/resume, boundary tests.
- **Test plan:** spec-first Gherkin (skipped until CLI exists); later `packages/cli/test/{ExitCodes,Import,Boundary}.test.ts` against SQLite.
- **Acceptance:** 26-cli.md has exit-code table, 3-class BEH-EA-208, write-side BEH-EA-207; every refusal scenario asserts an exit status; spec:verify:strict green.
- **Effort:** M (spec) + implementation folded into ticket 07. **Deps:** coordinates with ticket 06 (CTA-001/CTA-002/DAG-002/DAG-003) and ticket 07 (BE-003/BAM-001) — cross-slice.

### 4. `workspace-roster-sync` — Single source of truth for the package roster and honest stub manifests

**IDs:** MTS-003, MTS-004, MTS-005 · **Effort:** M · **Depends on workstreams:** none

**Rationale:** MTS-005 removes one of MTS-004's five rosters; MTS-003's stub-manifest cleanup touches the same package.json set the sync script reads. The rosters have already drifted (tsconfig.packages.json/.changeset have 21 of 23 packages).

- **IDs:** MTS-004, MTS-005, MTS-003
- **Why grouped:** MTS-005 removes one of MTS-004's five rosters; MTS-003's stub-manifest cleanup touches the same package.json set the sync script reads. The rosters have already drifted (tsconfig.packages.json/.changeset have 21 of 23 packages).
- **Effort:** M · **Order hint:** 1 · **Depends on:** none
- **Ordered steps:**
  1. MTS-005: delete tsconfig.test.json's duplicated `paths`.
  2. MTS-003: trim stub manifests (api-key, magic-link, two-factor, cli) to no runtime deps, drop next's unused @awthaq/react, delete knip per-package ignores.
  3. MTS-004: add scripts/sync-workspace.mjs (`--write`/`--check`) deriving tsconfig.base paths, tsconfig.json refs, tsconfig.packages.json refs (public only) and .changeset fixed group (public only) from packages/*/package.json; wire `--check` into `pnpm check`.
- **Test plan:** `node scripts/sync-workspace.mjs --check` fails on a scratch package dir; `pnpm knip` fails before trimming manifests; `pnpm package:smoke` stays green.
- **Acceptance:** Adding a package without syncing fails `pnpm check`; knip has no per-package ignores.

### 5. `dev-scripts-tooling` — Root dev scripts: root-anchored, fail-loud, cross-platform, single-source config

**IDs:** MM-010, MM-003, MTS-009, MM-009, ELC-003, MM-007 · **Effort:** M · **Depends on workstreams:** none

**Rationale:** All touch scripts/*.mjs, root package.json scripts or the toolchain pins; MTS-009 and MM-009 edit the same build.mjs lines and MM-007 edits package-smoke.mjs's same guard. ELC-003 edits scripts/circular.mjs, the same file as MTS-009's cwd-relative glob fix; do them in one pass.

*Plan from validation part A (dev-scripts-tooling: root dev scripts that are root-anchored, fail loudly, work cross-platform and use single-source config):*

- **Closes:** MTS-009, MM-009, MM-007, MM-010, MM-003. MTS-007 is INVALID.
- **Why grouped:** they share files. MTS-009 and MM-009 edit the same `build.mjs` lines, and MM-007 edits the same empty-guard in `package-smoke.mjs`.
- **Ordered steps:**
  1. MTS-009: anchor `build.mjs` and `circular.mjs` at `rootDir` (from `import.meta.url`). Empty glob exits 1. circular also scans `.tsx` and handles madge rejections. Make package-smoke's empty guard fail too.
  2. MM-009: build runs `process.execPath` with the resolved `typescript/bin/tsc`. Checked: in TS7 this is a node script that imports `../lib/tsc.js`. Add a new `scripts/clean.mjs` using `fs.rmSync`.
  3. MM-007: package-smoke checks that each `exports` target exists before calling publint/attw, and fails with "run pnpm typecheck first". Add a `prestart` build to the example.
  4. MM-010: add `.oxfmtrc.json` with `ignorePatterns`, then `format`: `oxfmt` and `format:check`: `oxfmt --check`. Reformat the newly covered files in a separate commit.
  5. MM-003: pin `typescript: 7.0.2` exactly and move `@effect/tsgo` into the catalog. Add a dependabot `typescript-toolchain` group.
- **Test plan:** run the scripts from `/tmp` and they now fail loudly; `pnpm clean && pnpm package:smoke` gives one actionable error; `pnpm format:check` catches `knip.json`; `pnpm check` is green.
- **Acceptance:** no script under `scripts/` exits 0 after matching zero packages; there is no `rm -rf` and no PATH `tsc`; format targets have a single source; typescript and tsgo are pinned as a pair.
- **Effort:** M.
- **Dependencies:** ELC-003 (sibling fork, madge `skipTypeImports`) edits `circular.mjs` too, so sequence them after MTS-009.

*Plan from validation part B (dev-scripts-tooling — Dev scripts correctness (shared with sibling fork's MTS-009/MM-009/MM-007)):*

- **IDs:** ELC-003
- **Why grouped:** ELC-003 edits scripts/circular.mjs, the same file as MTS-009's cwd-relative glob fix; do them in one pass.
- **Effort:** S · **Order hint:** 3 · **Depends on:** none
- **Ordered steps:**
  1. Extract `AuthEvent` types to packages/core/src/AuthEvent.ts to break the AuditLog<->AuthEvents type cycle.
  2. scripts/circular.mjs: scan .ts+.tsx, add a type-inclusive second madge pass; coordinate with MTS-009 (import.meta.dirname-relative globs) in the same edit.
- **Test plan:** `pnpm circular` fails with pass 2 before the extraction, passes after.
- **Acceptance:** Type-only cycles fail `pnpm circular`; zero cycles at HEAD after refactor.

### 6. `tooling-typecheck-lint` — Enforce the type-safety profile the repo claims (lint rule for assertions, strict index access, DOM lib scoping)

**IDs:** AH-004 (anders-hejlsberg), AH-008 (anders-hejlsberg), AH-009 (anders-hejlsberg) · **Effort:** M · **Depends on workstreams:** oauth-untrusted-json-decoding (cross-slice: ESS-002/TTE-002/TTE-003)

**Rationale:** All three are compiler/lint-profile hardening of the same 'soundness as a checked property' promise; each surfaces a handful of source sites and is verified by the same `pnpm typecheck`/`pnpm lint` gates. MM-008 (dark vendored rule) was reviewed here and closed as wontfix.

- **IDs:** AH-004, AH-008, AH-009
- **Why grouped:** All three are compiler/lint-profile hardening of the same 'soundness as a checked property' promise; each surfaces a handful of source sites and is verified by the same `pnpm typecheck`/`pnpm lint` gates. MM-008 (dark vendored rule) was reviewed here and closed as wontfix.
- **Effort:** M · **Order hint:** 2 · **Depends on:** oauth-untrusted-json-decoding (cross-slice: ESS-002/TTE-002/TTE-003)
- **Ordered steps:**
  1. Land oauth decode fixes first or together (ESS-002 discovery doc, TTE-002 Jwt segments, TTE-003) — AH-004's lint rule cannot go green while oauth casts remain.
  2. AH-004: swap Password.ts:571/583/599 to `emailFromRateLimitInput`; remove the residual OAuth casts (OAuth.ts:144-146, :250, :712; OAuthTokenAccess.ts:93; Jwt.ts:90); add `typescript/consistent-type-assertions` (`assertionStyle: "never"`) as an oxlint override on `packages/*/src/**`.
  3. AH-008: flip `noPropertyAccessFromIndexSignature` to true; fix TS4111 sites with bracket access + explicit undefined handling.
  4. AH-009: base lib -> ["ESNext"]; add DOM to client/react/next tsconfig.src.json and tsconfig.test.json; fix jwt/KeyRing.ts `CryptoKey` via `webcrypto.CryptoKey`.
- **Test plan:** Red steps are the gates themselves: `pnpm lint` (11 assertion sites), `pnpm typecheck` (TS4111 sites; KeyRing CryptoKey). Plus one oauth test: malformed token-endpoint body -> OAuthCallbackFailed, not a defect.
- **Acceptance:** `pnpm check` green with the new rule/flags on; no `as` (except `as const`) under packages/*/src.

### 7. `coverage-enforcement` — Enforce coverage thresholds (DoD gate 6)

**IDs:** MM-004, ETVS-007 (dup → MM-004) · **Effort:** S · **Depends on workstreams:** none

**Rationale:** Same missing `coverage.thresholds` in vitest.config.ts.

- **Closes:** MM-004 (canonical; ETVS-007 is its duplicate).
- **Ordered steps:**
  1. Measure with `pnpm coverage`.
  2. Add workspace `thresholds` at floor(measured) minus 2. The stale Sep-14 run showed 92.7/82.0/89.5/92.8 for statements/branches/functions/lines.
  3. Add per-package overrides for core, password, jwt and server, following `../qadi/vitest.config.ts:31-38`.
  4. Reword the comment so it points at `../qadi` explicitly.
  5. Mark DoD gate 6 active.
- **Test plan:** set `lines` to 99 temporarily and confirm it fails; `pnpm check` is green.
- **Effort:** S.
- **Dependencies:** none.

### 8. `quality-metrics-regeneration` — Retire or guard the stale, unreproducible quality-metrics dashboard

**IDs:** MTS-011, TTE-007 (dup → DESS-005), NSA-009 (dup → DESS-005), AH-005 (anders-hejlsberg) (dup → DESS-005), WPS-011 (dup → DESS-005), DESS-005, TS-006 (dup → DESS-005), SSMS-010 (dup → DESS-005) · **Effort:** S · **Depends on workstreams:** none

**Rationale:** One root cause: a single Sep-12 KPI snapshot produced by an out-of-repo extractor, gitignored, rendered into a committed HTML. One decision (MTS-011) + one freshness guard closes all eight.

- **Closes:** MTS-011 (canonical for the tracking boundary) and DESS-005 (canonical for staleness). DESS-005's duplicates are TTE-007, NSA-009, AH-005 (anders-hejlsberg), WPS-011 (metrics half), TS-006 and SSMS-010.
- **Why grouped:** all eight have one root cause.
- **Ordered steps:**
  1. Decide MTS-011 (recommended: option A).
  2. `git rm --cached type-quality-dashboard.html` and gitignore it.
  3. Document the JSON contract in-repo, replacing the `/tmp/awthaq-kpi/CONTRACT.md` pointer.
  4. Add a freshness guard to `scripts/generate-quality-dashboard.mjs`. It requires `sourceSha` equal to HEAD, requires `D.fileCount`/`totalLoc` to match the live glob, rejects phantom `@effect-auth/` names and unknown packages, and exits 1 unless `--allow-stale` (which adds a visible STALE banner).
  5. Delete the local stale `.quality-metrics/`.
- **Test plan:** running the renderer against the Sep-12 JSONs exits 1 with a message like `oauth: fileCount 1 != 6`.
- **Acceptance:** the HTML is untracked, and stale inputs can't be rendered silently.
- **Effort:** S.
- **Dependencies:** none. Type-safety KPIs should instead come from lint rules (AH-004 anders-hejlsberg, sibling fork tooling-typecheck-lint).

### 9. `bdd-suite-docs` — Bring features/README.md, STYLE.md, the REQ manifest gate and contract-stratum spec in line with reality

**IDs:** AH-006, BDD-006 (dup → AH-006), BDD-004 (dup → AH-006), TIR-006, AH-010 · **Effort:** M · **Depends on workstreams:** none

**Rationale:** The suite's own docs and spec/feature tables describe a pre-implementation, 5-endpoint, un-gated world; fixing them first gives implementers of the other BDD workstreams a correct contract (banner lifecycle, allocator-owned tags, @unwired convention).

- **IDs closed:** AH-006, BDD-006, BDD-004, AH-010, TIR-006
- **Why grouped:** The suite's own docs and spec/feature tables describe a pre-implementation, 5-endpoint, un-gated world; fixing them first gives implementers of the other BDD workstreams a correct contract (banner lifecycle, allocator-owned tags, @unwired convention).
- **Effort:** M · **order_hint:** 1 · **depends on workstreams:** none
- **Ordered steps:**
  1. AH-006: rewrite features/README.md (run story, wired/unwired, @skip/@unwired) and features/STYLE.md (banner lifecycle, allocator-owned REQ tags, skip conventions); strip banner from the 4 wired files; add banner<->@unwired consistency check to verify-traceability.sh (closes BDD-006, BDD-004).
  2. AH-010: harden verify-traceability.sh check 4 to a tag<->manifest bijection + header-count check; drop stale 602 comments.
  3. TIR-006: amend BEH-EA-031 (six endpoints) + BEH-EA-054 revoke-all semantics, extend 04-contract-stratum.feature table, add a wired revoke-all scenario to 07-sessions.feature, re-run the allocator.
- **Test plan:** New verify-traceability.sh checks fail at HEAD (banner on wired files) then pass; new 07-sessions revoke-all scenario red→green.
- **Acceptance:** `pnpm run spec:verify:strict` and `pnpm run test:bdd` green; README/STYLE contain no pre-implementation claims for wired files.

### 10. `bdd-step-definition-quality` — BDD step-definition honesty: no vacuous steps, no Given/When inversion, shared harness

**IDs:** AH-004 (aslak-hellesoy), AH-008 (aslak-hellesoy), TIR-005, AH-009 (aslak-hellesoy), AH-007, CSD-009, BDD-008, BDD-007 · **Effort:** L · **Depends on workstreams:** none

**Rationale:** All eight are glue-layer defects in the wired PasswordSteps/SessionSteps/World files that make scenarios report coverage they don't verify. BDD-007's shared harness (actor/session registry, current actor, cookie helpers) is the substrate AH-008/BDD-008/TIR-005/AH-009 fixes use; AH-007's parameter type is reused by CSD-009's new outline.

- **Closes:** BDD-007, AH-004, AH-007, TIR-005, AH-008, AH-009, CSD-009, BDD-008.
- **Why grouped:** all in `features/step-definitions/{Password,Session}Steps.ts` + Worlds; BDD-007's shared harness (named actor/session registry, current actor, cookie helpers) is the substrate for AH-008/BDD-008/TIR-005/AH-009; AH-007's `{passwordConfig}` parameter type is reused by CSD-009.
- **Ordered steps:**
  1. BDD-007 — extract `features/step-definitions/shared/Harness.ts` (cookieFrom, STRONG_PASSWORD, TestServices, letForkedFibersRun, capturing mailer factory, actor/session registry with currentActor).
  2. AH-004 — move actions from Givens into Whens (REQ-EA-307/308, SessionSteps cookie/issue steps); make precondition Givens arrange or assert.
  3. BDD-008 + AH-008 — replace hardcoded `"alice"` with currentActor/named lookups; track session "s1" by name; use the feature's literal emails.
  4. AH-007 — `{passwordConfig}` custom parameter type via `loadFeature(path, parameterTypes)`; delete bare `{string}` step; lint guard.
  5. CSD-009 — fail-closed outline over timeout/5xx/malformed (expects 422).
  6. AH-009 — events-delta + unchanged-state assertion for "not performed a second time".
  7. TIR-005 — SQLite-backed World variant + fault injection; real "token consumed" and "one transaction" Thens + rollback scenario.
- **Test plan:** each fix is proven by a scratch mutation (revert the product guard / rename the actor) that makes the scenario fail, then `pnpm run test:bdd` green; `pnpm run spec:verify:strict` for new REQ ids.
- **Acceptance:** no `Effect.void` When/Then in Password/SessionSteps without a justification comment; no bare `{string}` pattern; no `getActor("alice")`; removing `withTransaction` from `confirmReset` or `filterStatusOk` from `isBreached` fails a BDD scenario.
- **Effort:** L overall (BDD-007 S, AH-004 M, TIR-005 M, rest S). **Deps:** none cross-workstream; should precede the `bdd-feature-wiring` workstream's new wiring so new Worlds use the shared harness.

### 11. `bdd-skip-debt` — Pay down scenario-level @skip debt in the 4 wired feature files

**IDs:** SMS-008, AH-005 (aslak-hellesoy), BDD-009 (dup → AH-005), PHS-005, ESS-009 · **Effort:** L · **Depends on workstreams:** none

**Rationale:** Wired files skip security-critical scenarios for World-capability or unexplained reasons (sessions 18/24, password rehash, OAuth Config.Redacted). Fixes extend existing Worlds (row read handles, log capture, TestClock) rather than adding new files.

- **IDs closed:** AH-005, BDD-009, SMS-008, PHS-005, ESS-009
- **Why grouped:** Wired files skip security-critical scenarios for World-capability or unexplained reasons (sessions 18/24, password rehash, OAuth Config.Redacted). Fixes extend existing Worlds (row read handles, log capture, TestClock) rather than adding new files.
- **Effort:** L · **order_hint:** 2 · **depends on workstreams:** none
- **Ordered steps:**
  1. SMS-008 first (S; unblocked by 2761e8d): split REQ-EA-148 Outline, wire password-change rotation.
  2. AH-005 (closes BDD-009): add readSessionRow/log-capture/TestClock to SessionWorld; un-skip REQ-EA-136..146, decide 152/153 individually; replace ticket-pointer skip comments with concrete rationale + covering unit test.
  3. PHS-005: positive rehash-on-login unit test in packages/password/test/Password.test.ts, then PasswordWorld credential-hash accessor and un-skip REQ-EA-313..315.
  4. ESS-009: minimal Config.Redacted repro in packages/oauth/test, root-cause, fix, un-skip REQ-EA-346.
- **Test plan:** Each un-skipped scenario is first un-skipped red (undefined step / failing assertion), then made green; mutation spot-check (revert the fix commit) for SMS-008 and PHS-005.
- **Acceptance:** Scenario-level @skip count in the wired files drops from 33 to <= ~12, every remaining skip has a non-capability rationale; `pnpm run test:bdd` green.

### 12. `bdd-feature-wiring` — Wire the 22 @unwired feature files per decision 36's risk tiers

**IDs:** OCM-004, ESS-008, THS-006 (dup → THS-001), TS-005 (dup → AH-003), AH-003, ETVS-008 (dup → AH-003) · **Effort:** XL · **Depends on workstreams:** bdd-suite-docs

**Rationale:** All are the same gap — placeholder *.steps.test.ts with zero steps under Feature-level @skip @unwired (visibility landed in BDD-002/ba24ce5). AH-003 carries the resolved tiering decision; ESS-008 and OCM-004 add file-specific depth/blocking constraints; THS-006 closes via the two-factor build-out (THS-001).

- **IDs closed:** AH-003, ETVS-008, TS-005, ESS-008, OCM-004, THS-006
- **Why grouped:** All are the same gap — placeholder *.steps.test.ts with zero steps under Feature-level @skip @unwired (visibility landed in BDD-002/ba24ce5). AH-003 carries the resolved tiering decision; ESS-008 and OCM-004 add file-specific depth/blocking constraints; THS-006 closes via the two-factor build-out (THS-001).
- **Effort:** XL · **order_hint:** 3 · **depends on workstreams:** bdd-suite-docs
- **Ordered steps:**
  1. Add the §6 wiring-status table to spec/traceability.md (AH-003).
  2. Tier 1: 09-authentication-middleware (with REQ-EA-199/201 skipped as blocked by OCM-001 — OCM-004), 10-csrf, 11-http-error-mapping, 08-verification-tokens, 06-users-accounts — happy + failure per Rule.
  3. Tier 2: 19, 20, 21, 18 qadi bridge (closes TS-005).
  4. Tier 3: 14-rate-limiting (REQ-EA-297 waits for THS-001), 12-hooks, 13-events — 13-events wired in full per ESS-008.
  5. Tier 4: 04, 05, 01, 02, 03 (compile-time Rules may stay @skip with an INV-EA rationale).
  6. Tier 5: 22, 23, 24, 25, 26 (closes ETVS-008's residue incl. REQ-EA-566).
  7. After OCM-001 ships api-key: un-skip REQ-EA-199/201. After THS-001 ships TwoFactor: un-skip REQ-EA-297 and reconcile BEH-EA-110's key (principal vs challengeId).
- **Test plan:** Per file: remove @skip @unwired → run → undefined-step failures (red) → implement World/Steps → green.
- **Acceptance:** No Feature-level @unwired left (except any explicitly deferred with a §6 row); per-tier depth met; `pnpm check` green.

### 13. `bdd-organization-feature` — Specify and wire an organization BDD feature with an adversarial cross-tenant Rule

**IDs:** MTI-011, CWM-006 (dup → MTI-011) · **Effort:** L · **Depends on workstreams:** bdd-suite-docs

**Rationale:** Organization is the largest shipped plugin but has no behavior spec file and no feature file; both findings ask for the same new spec+feature, MTI-011 adding the isolation Rule.

- **IDs closed:** MTI-011, CWM-006
- **Why grouped:** Organization is the largest shipped plugin but has no behavior spec file and no feature file; both findings ask for the same new spec+feature, MTI-011 adding the isolation Rule.
- **Effort:** L · **order_hint:** 4 · **depends on workstreams:** bdd-suite-docs
- **Ordered steps:**
  1. Write spec/behaviors/28-organization.md (BEH-EA-221..228) from spec/models/14-organization.md; register in index.yaml and spec/traceability.md.
  2. Author features/features/10-organization/28-organization.feature (lifecycle Rules + adversarial cross-tenant Rule); add to allocate-req-ea.py ORDER; allocate ids.
  3. OrganizationWorld/OrganizationSteps + 28-organization.steps.test.ts; update features/README.md table.
- **Test plan:** Cross-tenant scenario 'A member of organization A cannot list organization B's members' written first; owner-invariant scenario next.
- **Acceptance:** New feature runs green; spec:verify:strict traces BEH-EA-221..228.

### 14. `examples-memory-server` — Make the memory example a complete, secure-by-default showcase

**IDs:** DESS-002, CSD-010 · **Effort:** S · **Depends on workstreams:** none

**Rationale:** Both edit examples/memory-server/index.ts's middleware merge and README walkthrough; DESS-002 introduces Mailer.layerConsole that the README workstream reuses.

**IDs closed:** DESS-002, CSD-010

**Why grouped:** both edit `examples/memory-server/index.ts`'s `middleware` merge (line 96) and its README walkthrough; DESS-002 adds `Mailer.layerConsole`, which the README workstream then reuses.

**Ordered steps:** (1) add `Mailer.layerConsole` to `packages/ports/src/Mailer.ts` + test; (2) wire it, the enforcing `RateLimiter.layer`/`layerStoreMemory`, and `Password.config({ breachCheck: { onUnavailable: "allow" } })` into the example's middleware merge; if TestAuth's sealed MemoryPorts still wins, add override options to `TestAuth.layer` (keeping permissive as the test default, BEH-EA-193); (3) rewrite the example README walkthrough: sign-up → token from log → verify-email → sign-in 200, plus a 429 demo.

**Test plan:** `packages/ports/test/Mailer.test.ts` (layerConsole logs + records); an example walkthrough test driving `HttpRouter.toWebHandler` over the example's AppLayer (sign-up → `Mailer.sent` token → verify-email → sign-in 200; N+1 bad sign-ins → 429).

**Acceptance:** the example README, followed verbatim, ends in a successful sign-in; neither limiter nor breach check is disabled in the showcase.

**Effort:** S. **Deps:** none.

### 15. `readme-docs-accuracy` — Root README accuracy + typechecked quickstart example

**IDs:** NHS-009, DESS-008, IC-010, CSS-005, IC-005 (dup → CSS-005), DTWS-003, CWM-007 (dup → DTWS-003), DTWS-004, SMS-006, SEA-007 · **Effort:** M · **Depends on workstreams:** examples-memory-server

**Rationale:** All cite README.md; validation found the quickstart no longer compiles (Mailer shape, AuditLog, CsrfProtection), so the root fix is moving it into a workspace-typechecked examples/sql-server (SQLite default, Postgres via DATABASE_URL) and editing the inventory/cookie/docs text once.

**IDs closed:** DTWS-003, CWM-007, DTWS-004, SMS-006, CSS-005, IC-005, NHS-009, DESS-008, IC-010, SEA-007

**Why grouped:** every row cites `README.md`. Validation found a bigger problem than any single finding: the quickstart (README.md:44-162) **no longer type-checks** — its `consoleMailer` omits `MailerShape.sent` and reads a non-existent `message.subject`, `AuthEvents.layer` now requires `AuditLog` (6bd3f1d) which the quickstart never provides, and Password's group requires `Api.CsrfProtection` which it never implements. The root fix is to move the quickstart into a workspace-typechecked example so it cannot drift again, then do one text pass over the inventory.

**Ordered steps:**
1. (SMS-006) Create `examples/sql-server/` (package.json/tsconfig modeled on memory-server; add a reference in root `tsconfig.json` next to line 77). Paste README.md:44-162 verbatim → `pnpm run typecheck` fails (red) → fix: `PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })`, `Mailer.layerConsole`, `AuditLog.layerSql` + `AuditLogRepositoryLive`, `Csrf.CsrfProtectionLive` with Config-read secret, `Hooks.HooksLive`, enforcing limiter (CSD-010).
2. (SEA-007) SQLite file default when DATABASE_URL is absent; Postgres otherwise — same composition.
3. (IC-010) Add `KeyProvider.layerEphemeral` (dev-only, warns) and use it explicitly on the example's SQLite path.
4. (NHS-009) Gate `AuthHttp.docs`/`openapiPath` behind `AWTHAQ_EXPOSE_DOCS` (default false) in the example; document production posture.
5. README text pass: replace the inline quickstart with an excerpt + link (or add a readme-sync check); add verify-email to "Running it"; SameSite=Strict + OAuth Lax flow-cookie sentence (CSS-005/IC-005); stub list without `next` + next's exports (DTWS-003/CWM-007, also `.scratch/shipping-gaps/map.md`); Roles row/repo map/composition comment + all unlisted packages (DTWS-004); "No database handy?" callout + Examples row (DESS-008); Configuration table rows for Mailer/RateLimiter/KeyProvider.

**Test plan:** red-first typecheck of the pasted quickstart; `packages/ports/test/KeyProvider.test.ts` for layerEphemeral; smoke run of examples/sql-server (SQLite and, in CI, Postgres) following the README curl sequence; `for p in $(ls packages); do grep -q "$p" README.md || echo MISSING $p; done` prints nothing.

**Acceptance:** quickstart code is compiled by `pnpm run typecheck`; README walkthrough ends in a 200 sign-in; README inventory matches `ls packages`; no `SameSite=Lax` claim for the session cookie; no `process.env.DATABASE_URL!`.

**Effort:** M (L if a readme-sync script is added). **Deps:** examples-memory-server (Mailer.layerConsole).

### 16. `design-docs-archive` — Correct ADR-EA-008's AuthPlugin.layer description

**IDs:** ELC-005 · **Effort:** S · **Depends on workstreams:** none

**Rationale:** Archive drift that leaked into a governing ADR.

**IDs closed:** ELC-005

**Why grouped:** single row; archive drift that leaked into governing ADR-EA-008.

**Steps:** amend `spec/decisions/008-plugin-is-context-service-class.md:19` to the shipped two-step `AuthPlugin.layer` (AuthPlugin.ts:255-256) and name `HookPoint.tap`/`*HooksLive` as the tap mechanism; add a correction pointer at `archive/design/plugins-as-layers.md:142`.

**Test plan / acceptance:** `pnpm run spec:verify:strict` passes; ADR no longer claims taps are merged by AuthPlugin.layer. **Effort:** S. **Deps:** none.

### 17. `observability-substrate` — HTTP tracer/request-logger re-exports and example wiring (wayfinder 27)

**IDs:** EOTS-006 · **Effort:** S · **Depends on workstreams:** none

**Rationale:** Shares wayfinder ticket 27's decision with MW-001 (other slice); this slice only owns the example/server re-export part.

**IDs closed:** EOTS-006

**Why grouped:** EOTS-006 shares wayfinder ticket 27's decision with MW-001 (another slice). This slice owns only the `AuthHttp.tracer`/`requestLogger` re-exports (if MW-001 hasn't landed them) and wiring them + a JSON/pretty `Logger.layer` into the examples.

**Steps:** re-export `HttpMiddleware.tracer`/`logger` from `packages/server/src/AuthHttp.ts`; in the examples, wrap the served app with them, provide `Logger.layer([Logger.consoleJson])` (prod) / pretty (dev), replace `console.log` with an `Effect.logInfo` startup layer.

**Test plan:** `packages/server/test/AuthHttp.test.ts` — request logger annotates http.method/status; tracer opens a span per request. **Acceptance:** no bare console.log in examples; AuthHttp exports tracer/requestLogger. **Effort:** S. **Deps:** MW-001 (cross-slice); touches the same example file as examples-memory-server — sequence after it.

### 18. `events-delivery-durability` — Replayable durable event log (AuditLog.replay by sequence)

**IDs:** ESA-003 · **Effort:** M · **Depends on workstreams:** none

**Rationale:** Remaining half of ESA-003 after the AuditLog landed (6bd3f1d).

- **IDs:** ESA-003
- **Why grouped:** Remaining half of ESA-003 after the AuditLog landed (6bd3f1d).
- **Effort:** M · **Order hint:** 5 · **Depends on:** none
- **Ordered steps:**
  1. Add monotonic `sequence` to auth_audit_log (migration), `AuditLog.replay({ after })` ascending Stream in memory+sql layers; document checkpoint/replay/tail pattern in 13-events.md.
- **Test plan:** AuditLog.test.ts replay-after-checkpoint ordering across layerMemory and layerSql (sqlite).
- **Acceptance:** Late consumer reconstructs all prior events in order.

### 19. `qadi-decision-cache-invalidation` — qadi DecisionCache scope + invalidation (wayfinder ticket 12)

**IDs:** PCS-005, YL-007 (dup → PCS-001), AAPS-005 · **Effort:** M · **Depends on workstreams:** PCS-001/RZS-002 implementation (cross-slice)

**Rationale:** Both are downstream of PCS-001/RZS-002 (cross-slice, ready-for-agent): per-request cache wiring closes YL-007; AAPS-005 adds the awthaq-owned user-attribute invalidation that ticket 12's bridge omits. TTL is rejected upstream (ADR-QD-031). Regression net for PCS-001/RZS-002's decision (other slice).

*Plan from validation part B (qadi-decision-cache-invalidation — qadi DecisionCache scope + invalidation (wayfinder ticket 12)):*

- **IDs:** AAPS-005, YL-007
- **Why grouped:** Both are downstream of PCS-001/RZS-002 (cross-slice, ready-for-agent): per-request cache wiring closes YL-007; AAPS-005 adds the awthaq-owned user-attribute invalidation that ticket 12's bridge omits. TTL is rejected upstream (ADR-QD-031).
- **Effort:** M · **Order hint:** 4 · **Depends on:** PCS-001/RZS-002 implementation (cross-slice)
- **Ordered steps:**
  1. Implement PCS-001/RZS-002 per wayfinder ticket 12 (per-request decisionCacheLayer; DecisionCacheInvalidationLive tapping OrganizationHooks) — closes YL-007.
  2. AAPS-005: add `AfterUserAttributesChanged` observe hook fired by Users.verifyEmail/updateProfile; tap it in DecisionCacheInvalidationLive; document covered vs application-owned attribute sources. No TTL (ADR-QD-031).
- **Test plan:** packages/qadi/test/DecisionCacheInvalidation.test.ts: app-scoped cached Deny on emailVerified flips to Allow after verifyEmail.
- **Acceptance:** Awthaq-owned attribute changes invalidate an app-scoped cache; appendix defaults to per-request scope.

*Plan from validation part C (Decision-cache scope + invalidation tests (wayfinder 12) (`qadi-decision-cache-invalidation`)):*

**IDs closed:** PCS-005

**Why grouped:** PCS-005 is the regression net for wayfinder ticket 12 (PCS-001/RZS-002, another slice): per-request cache scope by default + opt-in `DecisionCacheInvalidationLive` tapping Organization's After* hooks.

**Steps:** after/with PCS-001, add `packages/qadi/test/DecisionCache.test.ts` with four cases (hit on repeat; memberRemoved → deny with invalidation bridge under app scope; roles.revoke → deny; per-request scope needs no bridge).

**Acceptance:** tests pass; deleting the bridge from the app-scoped case makes the memberRemoved case fail. **Effort:** M. **Deps:** PCS-001, RZS-002.

### 20. `roles-permission-modeling` — Document exact-key permission modeling and definition-time bundling

**IDs:** YL-006, RRM-008 (dup → YL-006) · **Effort:** S · **Depends on workstreams:** none

**Rationale:** Same root cause (qadi HasPermission is exact membership); fix is awthaq-side docs + an executable example using qadi's existing createPermissionGroup — no qadi change.

- **IDs:** YL-006, RRM-008
- **Why grouped:** Same root cause (qadi HasPermission is exact membership); fix is awthaq-side docs + an executable example using qadi's existing createPermissionGroup — no qadi change.
- **Effort:** S · **Order hint:** 8 · **Depends on:** none
- **Ordered steps:**
  1. Rewrite packages/roles/README.md (currently a 'planned package' stub) with a 'Modeling permissions' section: exact keys, `createPermissionGroup` bundling, attribute policies instead of wildcards.
- **Test plan:** Executable README example test in packages/roles/test.
- **Acceptance:** README documents the boundary; example test green.

### 21. `property-based-testing` — Schema-derived property tests via @effect/vitest it.prop

**IDs:** ETVS-002 · **Effort:** M · **Depends on workstreams:** none

**Rationale:** Standalone test-infrastructure gap; STACK.md commitment.

- **IDs:** ETVS-002
- **Why grouped:** Standalone test-infrastructure gap; STACK.md commitment.
- **Effort:** M · **Order hint:** 6 · **Depends on:** none
- **Ordered steps:**
  1. Extract verification-token codec to its own module; add it.prop round-trip; add Principal union and SessionConfig property suites; correct STACK.md:35.
- **Test plan:** Three new *.prop.test.ts suites.
- **Acceptance:** >=3 property suites run in `pnpm test`.

### 22. `passkey-browser-signals` — WebAuthn Signals API in @awthaq/client

**IDs:** TC-004 · **Effort:** M · **Depends on workstreams:** none

**Rationale:** Remaining half of TC-004 after BPAS-002's browser layer (0441226); needs one decision on signalUnknownCredential vs enumeration safety.

- **IDs:** TC-004
- **Why grouped:** Remaining half of TC-004 after BPAS-002's browser layer (0441226); needs one decision on signalUnknownCredential vs enumeration safety.
- **Effort:** M · **Order hint:** 7 · **Depends on:** none
- **Ordered steps:**
  1. Server signals endpoint (rpId, userHandle, accepted credential ids); client `sendSignal` wrappers fired after delete and successful authenticate; capabilities extended; signalUnknownCredential per decision.
- **Test plan:** Client tests for post-delete allAcceptedCredentials and graceful no-support; server endpoint auth/ownership tests.
- **Acceptance:** Signals sent where supported, never alter ceremony outcomes, no enumeration regression.

### 23. `device-authorization-grant` — Normative RFC 8628 spec before Phase 3

**IDs:** DAG-001 (dup → DAG-005), DAG-005 · **Effort:** M · **Depends on workstreams:** none

**Rationale:** DAG-001 closes as duplicate of DAG-005 (cross-fork/slice canonical); no own work. Spec-only graduation of the better-auth analysis; shares the slug with DAG-001 (other fork).

*Plan from validation part B (device-authorization-grant — Normative RFC 8628 spec before Phase 3):*

- **IDs:** DAG-001
- **Why grouped:** DAG-001 closes as duplicate of DAG-005 (cross-fork/slice canonical); no own work.
- **Effort:** S · **Order hint:** 9 · **Depends on:** none
- **Ordered steps:**
  1. No work for DAG-001; tracked by DAG-005's spec-porting fix.
- **Test plan:** n/a
- **Acceptance:** n/a

*Plan from validation part C (Normative RFC 8628 design constraints in spec/models/13 (`device-authorization-grant`)):*

**IDs closed:** DAG-005

**Why grouped:** DAG-005 here; DAG-001 (another fork) uses the same slug; DAG-002/DAG-003 are resolved via wayfinder 06.

**Steps:** add a 'Design constraints' section to `spec/models/13-device-authorization.md` graduating better-auth §A.1–A.6 (pending→approved|denied only; CAS approve; all fallible checks before an atomic conditional consume; server slow_down with lastPolledAt on every poll; GC on discovery; user-code entropy + rate limits; client +5 s on slow_down per RFC 8628 §3.5); link wayfinder 06 (CLI login) and 03 (BeforeSessionIssue).

**Acceptance:** `pnpm run spec:verify:strict` passes; model no longer "speculative in its entirety". **Effort:** M. **Deps:** none (Phase 3 spec work).

## Decisions needed

4 genuinely open product calls; all other rows follow existing decisions (wayfinder tickets 01, 05, 06, 07, 10, 12, 27, 36) or are mechanical.

### MW-005 — Zero published artifacts: release pipeline designed and wired but never exercised

- A: Publish a canary leaf (@awthaq/ports) now, as soon as a remote + npm org exist, to de-risk OIDC/provenance early.
- B: Keep everything private until M8 per roadmap; only do the agent-side prep (access, fixed group, dry-run script).
- C: Publish all packages at once under a 0.x `next` dist-tag.

**Recommendation:** A, with the agent-side prep (steps 1-3) done immediately regardless. Publishing a zero-dep leaf proves the pipeline without committing any plugin API; pre-release 0.x versioning means no stability promise is implied.

### MTS-011 — Generated quality dashboard is committed while its inputs are gitignored

- A: Untrack the HTML, keep JSON local-only, add a freshness guard to the renderer (cheap; keeps the tool available).
- B: Build a deterministic in-repo KPI extractor (TS-AST based: fileCount/LOC/`as` casts excluding `as const`/Brand.nominal/non-null `!`), commit the JSONs, and gate freshness in CI.
- C: Delete the dashboard toolchain entirely (script, package.json script, HTML).

**Recommendation:** A. Nothing in `pnpm check` consumes these KPIs, and the type-safety KPIs that matter (no `as`, no `!`) are better enforced as lint rules (see sibling AH-004 anders-hejlsberg / tooling-typecheck-lint) than as a dashboard. B is speculative infra with no consumer; revisit only if a gate wants KPI trends.

### TC-004 — Signals API entirely absent; no browser-side passkey surface in any shipped package

- A: Ship allAcceptedCredentials (after delete + after each successful sign-in) and currentUserDetails only; never signalUnknownCredential.
- B: A + signalUnknownCredential only in authenticated contexts (e.g. re-auth of a signed-in user whose presented credential is not theirs), where no enumeration leak exists.
- C: A + signalUnknownCredential on any unauthenticated failure with an unknown credential id, relaxing BEH-EA-136's uniform response for that one case.

**Recommendation:** B — richer than A at small cost and still enumeration-safe; allAcceptedCredentials after every successful sign-in already prunes stale credentials for the common case, so C's leak buys little.

### AVS-009 — No deprecation/breaking-change policy; versioning tooling wired but never exercised

- A: Pre-1.0 'breaking allowed in minors, always documented with changeset + migration note'; deprecation windows start at 1.0.
- B: Strict one-minor deprecation windows with runtime warnings starting now.
- C: Defer any policy until M8.

**Recommendation:** A. It follows the standing 'product value wins over API stability' preference for a pre-release library while still guaranteeing every break is communicated; B would slow the ongoing API consolidation (e.g. AVS-002's fold-in) for zero current consumers.

## Per-issue dossiers

### Workstream: `server-request-limits`

#### NHS-004 — No request-body size limit anywhere on the serving path
`medium` / `security` / `repo` · [.issues/medium/NHS-004-node-http-server-integration-specialist.md](../../.issues/medium/NHS-004-node-http-server-integration-specialist.md)

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `../effect/packages/effect/src/unstable/http/HttpIncomingMessage.ts:133` — Unlimited by default in Effect v4 source too.
  ```
  export const MaxBodySize = Context.Reference<ByteSize.ByteSize | undefined>(
    "effect/http/HttpIncomingMessage/MaxBodySize",
    { defaultValue: () => undefined }
  )
  ```
- `../effect/packages/platform/node/src/NodeHttpIncomingMessage.ts:120` — The Node JSON/text body path honors the reference (text→arrayBuffer), so setting it is sufficient; exceeding fails via `onError` ('maxBytes exceeded').
  ```
  NodeStream.toArrayBuffer(() => this.source, {
          onError: this.onError,
          maxBytes: fiber.getRef(IncomingMessage.MaxBodySize)
        })
  ```
- `packages/server/src/AuthHttp.ts:25` — awthaq's serving surface is a bare re-export; `grep -rn 'MaxBodySize|maxBodySize|PayloadTooLarge|413' packages/*/src examples/*/*.ts` returns nothing.
  ```
  export const routes: typeof HttpApiBuilder.layer = HttpApiBuilder.layer;
  ```

**Fix plan:** Ship a default request-body cap in @awthaq/server: a global HttpRouter middleware layer that provides `HttpIncomingMessage.MaxBodySize` (configurable, default ~256 KiB) and maps the resulting parse failure to a typed 413, and wire it into the canonical composition.

Steps:
1. packages/server/src/BodyLimit.ts (new): `BodyLimitConfig` as a `Context.Reference` with default `{ maxBytes: ByteSize.kibibytes(256) }` (ADR-EA-011 config-as-service); `layer` = `HttpRouter.middleware((app) => Effect.provideService(app, HttpIncomingMessage.MaxBodySize, cfg.maxBytes), { global: true })` (check exact v4 signature at ../effect/packages/effect/src/unstable/http/HttpRouter.ts:931).
2. Map the body-read failure (`RequestParseError` whose cause is 'maxBytes exceeded') to a 413 `PayloadTooLarge` response — add a tagged error to @awthaq/api's error taxonomy (ADR-EA-013) with `httpApiStatus: 413`, or a middleware-level response if HttpApi decoding swallows the cause; verify which in a test first.
3. packages/server/src/AuthHttp.ts — make `routes`'s documented composition include `BodyLimit.layer` (or export `AuthHttp.serve` helper that merges it) so the default is on; allow opt-out/override via `BodyLimit.config({ maxBytes })`.
4. examples/memory-server/index.ts and README quickstart — include the layer.
5. spec/behaviors/11-http-error-mapping.md — new BEH-EA (next free id) 'request bodies are bounded by default; oversize → 413', and cross-reference BEH-EA-083/085.

Files: `packages/server/src/BodyLimit.ts (new)`, `packages/server/src/index.ts`, `packages/server/src/AuthHttp.ts`, `packages/api/src (error taxonomy)`, `examples/memory-server/index.ts`, `spec/behaviors/11-http-error-mapping.md`, `spec/traceability.md`

Tests (write first):
- packages/server/test/BodyLimit.test.ts — 'POST /password/sign-up with a 1 MiB JSON body returns 413 and never reaches the handler' (red first), and 'a normal payload still succeeds'; run against a real NodeHttpServer test layer so the Node body path is exercised, plus the toWebHandler path (BEH-EA-085).

Acceptance:
- Default composition rejects bodies > configured cap with 413.
- Cap is configurable per deployment.
- `pnpm check` and `pnpm spec:verify:strict` green.

Spec refs: BEH-EA-083, BEH-EA-085, BEH-EA-088 · Effort: **M** · Depends on: none

**Recommended status:** `ready-for-agent`

### Workstream: `ci-release-hardening`

#### MM-006 — Privileged release workflow uses tag-pinned actions while check.yml pins SHAs
medium · compliance · repo · [.issues/medium/MM-006-mattia-manzati.md](../../.issues/medium/MM-006-mattia-manzati.md)
**Verdict:** CONFIRMED (high confidence). Canonical for MTS-006.
**Evidence at HEAD:**
`.github/workflows/release.yml:32`
```yaml
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
```
`.github/workflows/release.yml:20` has `contents: write` and `id-token: write`. Line 45 has `uses: changesets/action@v1`.
`.github/workflows/check.yml:44`
```yaml
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
      - uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5
```
`.github/workflows/zizmor.yml:3-6,22-23` triggers on pull_request and on push to main with no path filter, so zizmor already scans release.yml. That makes the recommendation's "add zizmor to release.yml" half already done. No zizmor config enforces hash-pinning, though.
**Fix plan:**
1. Swap the three actions for check.yml's SHAs.
2. Resolve `changesets/action` v1 to a commit (`git ls-remote https://github.com/changesets/action 'refs/tags/v1*'`) and pin `@<sha> # vX.Y.Z`.
3. Add a new `.github/zizmor.yml` with `rules.unpinned-uses.config.policies."*": hash-pin`.
4. Gate release on Check: `on: workflow_run: {workflows:[Check], types:[completed], branches:[main]}` plus `if: github.event.workflow_run.conclusion == 'success'`, checking out `workflow_run.head_sha`. Alternatively add a `needs: check` job.
5. Review `persist-credentials` (changesets/action pushes the version branch with GITHUB_TOKEN). Keep it, with a justified zizmor ignore.

- **Files:** `.github/workflows/release.yml`, `.github/zizmor.yml`.
- **Tests:** `grep -nE 'uses: [^@]+@v[0-9]' .github/workflows/*.yml` returns nothing; `uvx zizmor .github/workflows` is clean.
- **Acceptance:** all pins are 40-hex SHAs with a version comment; zizmor enforces this; release can't run after a red Check.
- **Spec:** DoD gate 12.
- **Effort:** S.
- **Dependencies:** none.

**Recommended status:** ready-for-agent

#### MW-005 — Zero published artifacts: release pipeline designed and wired but never exercised
medium · dx · repo · [.issues/medium/MW-005-matias-woloski.md](../../.issues/medium/MW-005-matias-woloski.md)
**Verdict:** CONFIRMED (high confidence).
**Evidence at HEAD:**
`.github/workflows/release.yml:4`
```yaml
# not run as part of this ticket. Every `@awthaq/*` package is still
# `"private": true`, so `changeset publish` has nothing publishable yet;
```
`packages/ports/package.json:4` has `"private": true`. All **23** packages are private at 0.1.0; the audit said 21, and migrate-auth0 and migrate-better-auth have been added since.

Two latent blockers the audit didn't mention:
- `.changeset/config.json:31`: `"access": "restricted"` would publish the scoped packages as paid-private.
- `.changeset/config.json:5-27`: the `fixed` group lists only 21 names and misses `@awthaq/migrate-auth0` and `@awthaq/migrate-better-auth`.

`spec/roadmap.md:17`: "No package is published to npm yet". Gates 11-14 sit at M8.
**Fix plan:**
1. (Agent) Set `access: "public"`, or per-package `publishConfig: {access: "public", provenance: true}` (preferred).
2. (Agent) Add the two missing packages to `fixed`, coordinating with MTS-004's single-source list.
3. (Agent) Add a `release:dry-run` script: `changeset status --verbose` plus `npm publish --dry-run` for each non-private package.
4. (Human) Set up the git remote, the @awthaq npm org and the trusted publisher for release.yml.
5. (Agent) Make `@awthaq/ports` public, add the first changeset, merge the Version PR, and verify `npm view @awthaq/ports dist.attestations` plus attw from the registry.
6. Update the README "Publishing status" section.

- **Files:** `.changeset/config.json`, `packages/*/package.json`, `package.json`, `README.md`.
- **Tests:** dry-run passes; after the canary, provenance is present and a scratch consumer install plus tsc passes.
- **Acceptance:** at least one package is on npm with provenance via OIDC, and the config covers all 23 packages.
- **Effort:** M.
- **Blocked by:** MM-006.

**Decision needed:** yes. Options A/B/C are listed above; the recommendation is A.
**Recommended status:** ready-for-human

#### AVS-009 — No deprecation/breaking-change policy; versioning tooling wired but never exercised
medium · dx · repo · [.issues/medium/AVS-009-api-design-versioning-specialist.md](../../.issues/medium/AVS-009-api-design-versioning-specialist.md)
**Verdict:** CONFIRMED (high confidence).
**Evidence at HEAD:** `CONTRIBUTING.md:48`
```md
## Commit and changeset conventions

This repository uses [Changesets](https://github.com/changesets/changesets)
to manage versioning and changelogs across the workspace. If your change
affects the published behavior of any `@awthaq/*` package, add a
changeset describing it:
```
- `ls .changeset` shows only `config.json`, so no changeset has ever been written.
- `spec/decisions/003-httpapi-as-contract.md:37`: "a breaking change to `HttpApi` between v4 milestones is a breaking change to every awthaq plugin's contract". The ADR accepts this, but nothing says how such a break is communicated.
- A grep of CONTRIBUTING.md, spec/decisions and spec/process for `deprecat`/`breaking` finds no policy.

**Fix plan:**
1. Add a new ADR `spec/decisions/0NN-versioning-and-deprecation-policy.md`. It classifies changes to Schema shapes, HttpApi paths/status codes and Layer/Service signatures as additive, compatible or breaking.
2. Pre-1.0 rule: breaking changes are allowed in minors, but each needs a changeset with a `Migration:` section naming the ADR/BEH-EA ids.
3. Post-1.0 rule: a one-minor window with JSDoc `@deprecated` and a one-time `Effect.logWarning` at Layer build.
4. Rule for Effect rc bumps: an rc bump that changes a public type counts as breaking.
5. Summarize the policy in CONTRIBUTING.md.
6. Add `pnpm changeset status --since=origin/main` for PRs in check.yml once a remote exists.
7. Register the ADR in `spec/traceability.md`, reference it from DoD gate 12, and run `pnpm spec:verify:strict`.

- **Tests:** `spec:verify:strict` passes; a PR that changes `packages/*/src` without a changeset fails.
- **Acceptance:** the written policy covers all three surfaces and the pre/post-1.0 rules, and it is enforced in CI.
- **Spec:** ADR-EA-003, ADR-EA-007, DoD gate 12.
- **Effort:** S.
- **Related:** AVS-002 (other slice) depends on this policy.

**Decision needed:** yes (A/B/C above; the recommendation is A).
**Recommended status:** ready-for-human

#### MTS-006 — Release workflow drops the SHA-pinning discipline while holding the most privileges
medium · security · repo · [.issues/medium/MTS-006-monorepo-tooling-specialist.md](../../.issues/medium/MTS-006-monorepo-tooling-specialist.md)
**Verdict:** DUPLICATE of MM-006 (high confidence).
**Evidence at HEAD:** `.github/workflows/release.yml:44`
```yaml
      - name: Version or publish
        uses: changesets/action@v1
```
`release.yml:12-14`: `on: push: branches: [main]`. There is no dependency on Check, so this issue's extra "gate on check" recommendation is also real. It's folded into MM-006 step 4.
**Fix plan:** none separately; covered by MM-006.
**Recommended status:** resolved (duplicate of MM-006)

### Workstream: `cli-contract`

#### ECS-002 — Bulk `import` migration has no confirmation, dry-run, or partial-failure semantics
`high` · `security` · `cli` · [.issues/high/ECS-002-effect-cli-specialist.md](../../.issues/high/ECS-002-effect-cli-specialist.md) · current: `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7):**

- `spec/behaviors/26-cli.md:135` — BEH-EA-207 governs only formats + unmapped-field reporting; nothing on preview, confirmation, batching, resume, or audit.
  ```
  REQUIREMENT: `awthaq import` MUST support at least `better-auth`,
               `authjs`, and `lucia` as named source formats, translating each
               framework's user/account/session tables into awthaq's own
               `Model.Class` shapes; it MUST NOT silently drop a source field
               awthaq has no equivalent for without reporting it.
  ```
- `features/features/08-tooling/26-cli.feature:186` — REQ-EA-596..599 (lines 185-215) are the only import scenarios; none cover the write side.
  ```
  Scenario Outline: import supports each named source framework
    Given a user/account/session export from "<framework>"
    When "awthaq import --from <framework>" runs
    Then the export's tables are translated into awthaq's own Model.Class shapes
  ```
- `features/features/08-tooling/26-cli.feature:107` — In-file precedent: the other two write commands (migration apply --yes; seed admin --force at :163-173) have confirmation scenarios; import does not.
  ```
  Scenario: migration apply refuses to run without an explicit confirmation flag
    Given pending migrations reported by "awthaq migration status"
    When "awthaq migration apply" is run without the "--yes" flag
    Then it refuses to apply any migration
  ```
- `packages/cli/src/index.ts:8` — The CLI is still an empty placeholder at HEAD, so every CLI finding is a spec/acceptance-contract gap to close before (or as part of) the BE-003/BAM-001 implementation (wayfinder ticket 07).
  ```
  // Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
  
  export {};
  ```

**Fix plan:** Extend BEH-EA-207 (and 26-cli.feature's @BEH-EA-207 Rule) with a write-side contract: default plan/preview mode, explicit --yes confirmation before any write, per-batch transactions with failure reporting and a resumable checkpoint (the `awthaq_import_runs` ledger already decided in wayfinder ticket 07 §6), and a typed AuthEvents audit event per completed/aborted run. Then honor it in the ticket-07 `Import.ts` implementation.

Steps:
1. spec/behaviors/26-cli.md: bump revision (1.3/1.4 — coordinate with ticket 06's pending 1.3 bump), add a Change History entry, and append to BEH-EA-207's REQUIREMENT: (a) `awthaq import` without `--yes` MUST run in plan mode: read + map the whole export, print per-table row counts, per-field unmapped report, and conflict counts (e.g. email already present), and write nothing; `--dry-run` is an explicit alias; (b) writes only happen with `--yes`; (c) rows are written in bounded batches, each batch in one `SqlTransaction.withTransaction`; a failed batch rolls back only itself, is reported with source row ids + error tag, and the run stops (or continues with `--continue-on-error`) leaving the `awthaq_import_runs` checkpoint at the last committed batch; (d) re-running with the same source resumes from the checkpoint and never double-inserts; (e) each run publishes one `auth.import.completed` (or `auth.import.failed`) AuthEvents event carrying source framework, counts imported/skipped/failed/unmapped, and run id, and writes the same to AuditLog.
2. Add the matching explanatory paragraph citing the in-file precedents (BEH-EA-204 --yes, BEH-EA-206 --force) and ticket 07 §6's resumable ledger.
3. features/features/08-tooling/26-cli.feature: add new scenarios under @BEH-EA-207 with fresh ids REQ-EA-628.. (current max is REQ-EA-627): 'import without --yes reports a plan and writes nothing', 'import --yes writes the previewed rows', 'a failing batch is rolled back and reported with its source row ids', 'a re-run resumes from the last committed batch without duplicating rows', 'a completed import publishes auth.import.completed'. Keep the file-level @skip @unwired until the CLI exists.
4. features/traceability.md + spec/traceability.md: add the new REQ-EA rows and bump the counts; run `pnpm run spec:verify:strict`.
5. packages/core/src/AuthEvents.ts: add `ImportCompleted`/`ImportFailed` tagged events (`auth.import.completed`/`auth.import.failed`) to the registry union (BEH-EA-101) — can land with the Import.ts implementation.
6. When ticket 07's `packages/cli/src/Import.ts` is built (BE-003/BAM-001), implement: `Flag.boolean("yes")` + `Flag.boolean("dry-run")` via effect/unstable/cli; plan mode as the default branch; batch loop with `SqlTransaction.withTransaction`; checkpoint writes into `awthaq_import_runs`; the refusal as a tagged error carrying `Runtime.errorExitCode` per the CTA-003 exit-code contract.

Files: `spec/behaviors/26-cli.md`, `features/features/08-tooling/26-cli.feature`, `features/traceability.md`, `spec/traceability.md`, `packages/core/src/AuthEvents.ts`, `packages/cli/src/Import.ts (new, ticket 07)`

Tests (write first):
- Spec-first: new Gherkin scenarios REQ-EA-628..632 in 26-cli.feature (tagged @skip @unwired until packages/cli exists; wired by the 26-cli.steps.test.ts placeholder).
- When Import.ts lands, write first: packages/cli/test/Import.test.ts — 'import without --yes writes no rows and reports per-table counts' (SQLite via @effect/sql-sqlite-node, as packages/core/test/*.test.ts already do), then 'a failing batch rolls back and the checkpoint stays at the last committed batch', then 'resume skips already-imported source ids', then 'publishes auth.import.completed with counts'.

Acceptance:
- BEH-EA-207's REQUIREMENT names plan mode, --yes confirmation, per-batch transaction + failure report, resumable checkpoint, and an audit event.
- 26-cli.feature has one scenario per clause, each with a new REQ-EA id present in features/traceability.md; `pnpm run spec:verify:strict` passes.
- Once implemented: `awthaq import --from better-auth` with no flags exits 0 having written zero rows and printed a plan; `--yes` writes; a forced batch failure leaves prior batches committed and is resumable.

Spec refs: BEH-EA-207, BEH-EA-204, BEH-EA-206, BEH-EA-101 · Effort: **M** · Depends on: BE-003, BAM-001, CTA-003

**Recommended status:** `ready-for-agent`

#### CTA-003 — No exit-code contract despite doctor being explicitly a CI tool
`medium` · `dx` · `cli` · [.issues/medium/CTA-003-cli-tool-auth-specialist.md](../../.issues/medium/CTA-003-cli-tool-auth-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7):**

- `spec/behaviors/26-cli.md:32` — Spec promotes doctor as a CI gate; `grep -in exit spec/behaviors/26-cli.md features/features/08-tooling/26-cli.feature` returns nothing.
  ```
  Running against the statically derived manifest (BEH-EA-208) rather than a live process means `doctor` can be run in CI, before deploy, and catch a `sameSite: "lax"` or a `Mailer.layerMemory` left in production configuration before either one reaches a real user.
  ```
- `features/features/08-tooling/26-cli.feature:107` — Outcomes are prose ('refuses', 'reports'); no process exit status is specified anywhere.
  ```
  Scenario: migration apply refuses to run without an explicit confirmation flag
    Given pending migrations reported by "awthaq migration status"
    When "awthaq migration apply" is run without the "--yes" flag
    Then it refuses to apply any migration
  ```
- `../effect/packages/effect/src/Runtime.ts:78` — Effect v4 already supports per-error exit codes via the `Runtime.errorExitCode` marker (used by unstable/cli's CliError at CliError.ts:624), so the contract is cheap to implement.
  ```
   * - The squashed error's {@link errorExitCode} value for other failures when
   *   present.
   * - `1` for other failures.
  ```
- `packages/cli/src/index.ts:8` — The CLI is still an empty placeholder at HEAD, so every CLI finding is a spec/acceptance-contract gap to close before (or as part of) the BE-003/BAM-001 implementation (wayfinder ticket 07).
  ```
  // Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
  
  export {};
  ```

**Fix plan:** Add a normative exit-code contract to 26-cli.md (new cross-cutting section/requirement) and assert codes in 26-cli.feature; implement later via tagged errors carrying `Runtime.errorExitCode`.

Steps:
1. spec/behaviors/26-cli.md: add a CLI-wide 'Exit status' REQUIREMENT (either appended to BEH-EA-208 or as a new BEH id after 208 if the spec numbering allows — prefer appending to BEH-EA-201/208 to avoid renumbering BEH-EA-209+). Recommended table: 0 = success / no findings; 1 = doctor (or any validation command) completed and reported findings; 2 = usage error (bad flags/args — Effect CLI's own CliError path); 3 = refused: a destructive command ran without its confirmation flag (`migration apply` w/o --yes, `seed admin` against an existing admin w/o --force, `import` w/o --yes per ECS-002); 4 = runtime/infrastructure failure (DB unreachable, manifest/config module failed to load); 130 = interrupted (Effect runtime default). Also require machine-readable output (`--json`) for doctor so CI need not parse prose.
2. features/features/08-tooling/26-cli.feature: add `And the process exits with status N` to REQ-EA-585 (3), REQ-EA-593 (3), the doctor scenarios under @BEH-EA-201 (1 when findings, 0 when clean), and add new scenarios REQ-EA-6xx for 'doctor exits 0 on a clean config', 'doctor exits 1 on an insecure default', 'a command whose database is unreachable exits 4'.
3. Traceability: add the new REQ ids to features/traceability.md/spec/traceability.md; run `pnpm run spec:verify:strict`.
4. Implementation (with ticket 07's packages/cli/src/*): define tagged errors in packages/cli/src/CliErrors.ts (`DoctorFindings`, `ConfirmationRequired`, `InfrastructureFailure`) each with a `[Runtime.errorExitCode]` field set per the table (no `as` casts — plain class fields); run the root Command with NodeRuntime.runMain so the Effect runtime maps them.

Files: `spec/behaviors/26-cli.md`, `features/features/08-tooling/26-cli.feature`, `features/traceability.md`, `spec/traceability.md`, `packages/cli/src/CliErrors.ts (new, ticket 07)`

Tests (write first):
- Spec-first: Gherkin exit-status Thens/scenarios in 26-cli.feature (@skip @unwired until the CLI exists).
- When the CLI lands: packages/cli/test/ExitCodes.test.ts — spawn/run the built Command and assert exit 0/1/3/4 for clean doctor, insecure-default doctor, `migration apply` without --yes, unreachable DB.

Acceptance:
- 26-cli.md contains a normative exit-code table covering success, findings, refusal, usage error, infrastructure error.
- Every refusal/report scenario in 26-cli.feature asserts an exit status.
- Once implemented, `awthaq doctor` in CI fails the job (non-zero) iff findings exist, distinguishable from infra errors.

Spec refs: BEH-EA-201, BEH-EA-204, BEH-EA-206, BEH-EA-207, BEH-EA-208 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### ECS-003 — BEH-EA-208 'never runs the application' boundary contradicts its own examples
`medium` · `correctness` · `cli` · [.issues/medium/ECS-003-effect-cli-specialist.md](../../.issues/medium/ECS-003-effect-cli-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7):**

- `spec/behaviors/26-cli.md:156` — Unscoped 'every CLI command'.
  ```
  REQUIREMENT: Every CLI command MUST operate on `Auth.make`'s statically
               derived manifest (contract, tables, migrations, plugin graph); no
               CLI command MUST start an HTTP listener, accept a request, or
               otherwise run the application it is inspecting.
  ```
- `spec/behaviors/26-cli.md:116` — seed admin requires live domain-service Layers + a database — contradicts 'operate on the manifest'.
  ```
  REQUIREMENT: `seed admin` MUST create or promote one account to an
               administrative role through the same domain services an
               application would use at runtime (`Users`, `Roles`), never by
               writing rows directly to the database;
  ```
- `features/features/08-tooling/26-cli.feature:243` — REQ-EA-601 examples list DB-writing commands under 'does not ... otherwise run the application'.
  ```
  | awthaq doctor                |
  | awthaq plugin list --graph   |
  | awthaq routes                |
  | awthaq migration apply --yes |
  | awthaq openapi               |
  | awthaq seed admin            |
  ```
- `features/features/08-tooling/26-cli.feature:255` — REQ-EA-602: unscoped; false for migration status/apply, seed admin, import.
  ```
  And no HTTP listener needs to be started and no database connection needs to be live for a CLI command to answer correctly
  ```
- `features/features/08-tooling/26-cli.feature:225` — Additional contradiction the audit missed: REQ-EA-600 lists `migration status`, but BEH-EA-204 (26-cli.md:80) requires it to read the driver's Migrator ledger — a live DB read. The audit's proposed partition wrongly puts `migration status` in 'manifest-only'.
  ```
  Then it operates on the manifest's contract, tables, migrations, or plugin graph without evaluating the plugin set's runtime "make" Layer
  ...
  | awthaq migration status      |
  ```
- `.scratch/resolve-ready-for-human-findings/issues/07-cli-schema-migration-tooling.md:150` — Existing wayfinder decision already adopts the auditor's reading (the invariant is 'no listener / no inbound request', not 'no Layers/DB'); the spec text was never amended. Ticket 06 also plans a 26-cli.md 1.3 rewrite of this same REQUIREMENT (session-command carve-out) — ECS-003's partition must be folded into that same edit.
  ```
  `Effect.runPromise`/`Effect.runPromiseExit` against a short-lived runtime —
  this is the one command where "reads the manifest, never runs the
  application" (BEH-EA-208) is satisfied by *not standing up the HTTP server*
  while still constructing the domain-service layer, ... BEH-EA-208 bars starting a listener or
  accepting a request, not constructing services).
  ```

**Fix plan:** Rewrite BEH-EA-208 to state the true invariant (no HTTP listener, no inbound request, no application serving) and partition commands into three classes with explicit Layer requirements: manifest-only, database-backed, and (per ticket 06) session/outbound-client. Apply together with ticket 06's pending 1.3 amendment so the REQUIREMENT is edited once.

Steps:
1. spec/behaviors/26-cli.md BEH-EA-208: replace the REQUIREMENT with: every command MUST be derivable from `Auth.make`'s manifest for *what* it acts on; no command MUST start an HTTP listener or accept an inbound request. Then a class table: (1) manifest-only — `doctor`, `plugin list --graph`, `routes`, `openapi`: MUST NOT evaluate the runtime `make` Layer nor open a DB connection; (2) database-backed — `migration status` (ledger read), `migration apply --yes`, `seed admin`, `import`: MAY construct `SqlClient` and (seed/import) the domain-service Layers (`Users`, `Roles`, `Accounts`) on a short-lived runtime, never the HTTP server Layer; (3) session — `login`, `logout`, `whoami` per ticket 06: outbound client only.
2. Rewrite the explanatory paragraph at 26-cli.md:162 so 'no database connection needs to be live' is scoped to class (1); fix the BEH-EA-201 sentence consistently (doctor stays manifest-only).
3. Fix packages/cli/src/index.ts:3 and packages/cli/package.json description ('reads the plugin manifest, never runs the application') and the README summary to the narrowed wording (or drop the clause).
4. features/features/08-tooling/26-cli.feature @BEH-EA-208 Rule: REQ-EA-600 outline — remove `awthaq migration status` from the no-Layer examples; REQ-EA-601 — keep all rows (the no-listener claim is true for all) but reword the Then to 'does not start an HTTP listener or accept an inbound request' (drop 'otherwise run the application'); REQ-EA-602 — scope the final And to 'for a manifest-only command'; add a new scenario (REQ-EA-6xx) 'database-backed commands construct only SqlClient/domain-service Layers, never the HTTP server Layer'.
5. Update traceability rows for REQ-EA-600..602 (+ new id); `pnpm run spec:verify:strict`.

Files: `spec/behaviors/26-cli.md`, `features/features/08-tooling/26-cli.feature`, `packages/cli/src/index.ts`, `packages/cli/package.json`, `packages/cli/README.md`, `features/traceability.md`, `spec/traceability.md`

Tests (write first):
- Spec-first: amended REQ-EA-600/601/602 + new class-(2) scenario in 26-cli.feature (@skip @unwired until the CLI exists).
- When the CLI lands: packages/cli/test/Boundary.test.ts — assert manifest-only commands run with a Layer graph containing no SqlClient/HttpServer (provide none; the program must still typecheck and run), and database-backed commands require SqlClient but never HttpServer (type-level: the command's requirement channel excludes HttpServer).

Acceptance:
- No sentence in 26-cli.md, 26-cli.feature, or packages/cli metadata claims every command runs without a database.
- BEH-EA-208 lists the three command classes and each class's permitted Layers; `migration status` is classed database-backed.
- The edit is the same revision as ticket 06's session-command carve-out (one coherent REQUIREMENT).

Spec refs: BEH-EA-208, BEH-EA-204, BEH-EA-206, BEH-EA-207, BEH-EA-201 · Effort: **S** · Depends on: CTA-002, DAG-003

**Recommended status:** `ready-for-agent`

### Workstream: `workspace-roster-sync`

#### MTS-003 — knip blanket ignoreDependencies silences 5 of 21 workspaces
`medium` / `dx` / `repo` · [.issues/medium/MTS-003-monorepo-tooling-specialist.md](../../.issues/medium/MTS-003-monorepo-tooling-specialist.md)

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `knip.json:9` — Same 7-entry block for two-factor (:20) and magic-link (:31); cli (:42) ignores 8 incl. `effect`; next (:54) ignores @awthaq/react.
  ```
  "packages/api-key": {
        "ignoreDependencies": [
          "@awthaq/api",
          "@awthaq/core",
  ```
- `packages/api-key/src/index.ts:10` — Still an empty placeholder (same for magic-link, two-factor, cli), while package.json declares @awthaq/api, core, ports, server, sql + effect as runtime deps.
  ```
  export {};
  ```
- `packages/next/package.json:30` — Declared, but `grep @awthaq/react packages/next/src` returns nothing — knip's ignore hides a genuinely unused dependency.
  ```
  "@awthaq/react": "workspace:*",
  ```

**Fix plan:** Trim the four stub manifests to what their `export {}` needs, drop next's unused @awthaq/react (or make it a peer if intentionally forwarded), and delete every per-package ignore block from knip.json.

Steps:
1. packages/{api-key,magic-link,two-factor,cli}/package.json — remove all `dependencies`; keep devDependencies `typescript`/`vitest` only if a test/vitest config exists, else remove `@effect/vitest` too. Re-add real deps when each package gets its first module.
2. Update each stub's tsconfig.src.json `references`/`paths` if they list the removed @awthaq/* packages (keep build graph consistent).
3. packages/next/package.json — drop `@awthaq/react` unless next/src re-exports it; if it is meant for consumers, move to `peerDependencies`.
4. knip.json — delete the `packages/api-key`, `packages/two-factor`, `packages/magic-link`, `packages/cli`, `packages/next` blocks.
5. scripts/package-smoke.mjs:6-7 — update the comment: stubs are publish-realistic by having honest (empty) manifests.
6. Run `pnpm install` to refresh the lockfile.

Files: `knip.json`, `packages/api-key/package.json`, `packages/magic-link/package.json`, `packages/two-factor/package.json`, `packages/cli/package.json`, `packages/next/package.json`, `scripts/package-smoke.mjs`, `pnpm-lock.yaml`

Tests (write first):
- Red: delete the knip.json ignore blocks first and run `pnpm knip` — it must list the unused deps. Green after trimming manifests. `pnpm package:smoke` must stay green (publint/attw on the stubs).

Acceptance:
- knip.json has no per-package `ignoreDependencies` except the root's `@arethetypeswrong/cli`.
- `pnpm knip` and `pnpm package:smoke` green.

Spec refs: none · Effort: **S** · Depends on: none

**Recommended status:** `ready-for-agent`

#### MTS-004 — Adding a package requires hand-syncing five 21-entry lists with no enforcement
`medium` / `dx` / `repo` · [.issues/medium/MTS-004-monorepo-tooling-specialist.md](../../.issues/medium/MTS-004-monorepo-tooling-specialist.md)

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `tsconfig.base.json:41` — Manual step still documented; paths now has 23 entries (:45-69).
  ```
  // Workspace packages resolve to source, not to built output, via `paths`
  // below — one entry per packages/* package, the same way qadi's
  // tsconfig.base.json lists every @qadi/* package. Add a new entry here
  // whenever a new package is scaffolded.
  ```
- `tsconfig.packages.json:65` — Last of only 21 references — packages/migrate-auth0 and packages/migrate-better-auth (both `private: true`) are absent, while root tsconfig.json has all 23 (+features, examples). The rosters have already diverged.
  ```
  "path": "packages/jwt/tsconfig.src.json"
  ```
- `.changeset/config.json:5` — 21 names; migrate-* absent. Whether that is intentional (private) is undocumented — nothing checks it either way.
  ```
  "fixed": [
      [
        "@awthaq/admin",
        ...
        "@awthaq/two-factor"
      ]
  ```

**Fix plan:** Add scripts/sync-workspace.mjs that derives every roster from packages/*/package.json (name, private flag) and either writes (`--write`) or verifies (`--check`) the five lists; run `--check` in `pnpm check`.

Steps:
1. scripts/sync-workspace.mjs: glob `packages/*/package.json` (resolve relative to `import.meta.dirname`, not cwd — see MTS-009), read `name` and `private`.
2. Derive: tsconfig.base.json `paths` (all packages), tsconfig.json `references` (all packages + features + examples/*), tsconfig.packages.json `references` (all packages whose `private !== true` — document this rule in the script header), .changeset/config.json `fixed[0]` (public packages, sorted).
3. `--check` mode: parse each file (strip JSONC comments), diff against derived lists, exit 1 naming the file and missing/extra entries. `--write` mode rewrites only the roster arrays preserving comments.
4. package.json: add `"workspace:sync": "node scripts/sync-workspace.mjs --write"`, `"workspace:check": "node scripts/sync-workspace.mjs --check"`; prepend `pnpm workspace:check &&` to `check`.
5. Delete the tsconfig.test.json paths duplicate (MTS-005) so only four rosters remain.
6. Replace the tsconfig.base.json:41-44 comment with 'generated by pnpm workspace:sync'.
7. knip.json: add `scripts/sync-workspace.mjs` is already covered by the `scripts/*.mjs` entry — no change.

Files: `scripts/sync-workspace.mjs (new)`, `package.json`, `tsconfig.base.json`, `tsconfig.json`, `tsconfig.packages.json`, `.changeset/config.json`, `tsconfig.test.json`

Tests (write first):
- Red: run `node scripts/sync-workspace.mjs --check` at HEAD — it must fail naming migrate-auth0/migrate-better-auth for any roster whose rule includes private packages (or pass if the private rule is applied, which then documents the current state). Then add a fake `packages/zz-tmp/package.json` locally and confirm `--check` fails naming all four files; remove it.

Acceptance:
- `pnpm check` fails when a package directory is added without running `pnpm workspace:sync`.
- The public/private inclusion rule is written down in the script header and matches tsconfig.packages.json + .changeset.

Spec refs: none · Effort: **M** · Depends on: none

**Recommended status:** `ready-for-agent`

#### MTS-005 — tsconfig.test.json duplicates the identical paths block it already inherits
`low` / `dx` / `repo` · [.issues/low/MTS-005-monorepo-tooling-specialist.md](../../.issues/low/MTS-005-monorepo-tooling-specialist.md)

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `tsconfig.test.json:2` — Inherits base's paths; both files live in the repo root so relative resolution is identical.
  ```
  "extends": "./tsconfig.base.json",
  ```
- `tsconfig.test.json:25` — Verbatim 23-entry copy of tsconfig.base.json:45-69 (same order).
  ```
  "paths": {
        "@awthaq/api": ["./packages/api/src/index.ts"],
        "@awthaq/ports": ["./packages/ports/src/index.ts"],
  ```

**Fix plan:** Delete the paths block (and its comment) from tsconfig.test.json; rely on inheritance.

Steps:
1. tsconfig.test.json:23-49 — remove the `// Same rationale…` comment and the `paths` object.

Files: `tsconfig.test.json`

Tests (write first):
- `pnpm run typecheck` (runs `tsc -p tsconfig.test.json`) and `pnpm run test` stay green — resolution is unchanged.

Acceptance:
- tsconfig.test.json contains no `paths` key; typecheck green.

Spec refs: none · Effort: **S** · Depends on: none

**Recommended status:** `ready-for-agent`

### Workstream: `dev-scripts-tooling`

#### MM-010 — format/format:check hand-duplicate their explicit target lists (drift already visible)
low · dx · repo · [.issues/low/MM-010-mattia-manzati.md](../../.issues/low/MM-010-mattia-manzati.md)
**Verdict:** CONFIRMED (high confidence).
**Evidence at HEAD:** `package.json:22-23`
```json
"format": "oxfmt packages features scripts vitest.config.ts package.json pnpm-workspace.yaml tsconfig.json tsconfig.base.json tsconfig.packages.json tsconfig.test.json .oxlintrc.json .changeset/config.json",
"format:check": "oxfmt --check packages features scripts vitest.config.ts package.json ...",
```
`knip.json`, `examples/`, `tools/` and `.github/` are missing from both lists. oxfmt 0.67 supports `.oxfmtrc.json` `ignorePatterns` (`node_modules/oxfmt/configuration_schema.json`) and honors `.gitignore` by default.
**Fix plan:**
1. Add a new `.oxfmtrc.json` whose `ignorePatterns` cover `.issues`, `.scratch`, `.plan`, `.reports`, `.agents`, `.claude`, `archive`, `research`, `better-auth`, `spec`, `docs`, `*.html`, `pnpm-lock.yaml` and `CHANGELOG.md`.
2. Set `format` to `oxfmt` and `format:check` to `oxfmt --check`.
3. Reformat the newly covered files in a separate formatting-only commit.

- **Effort:** S.

**Recommended status:** ready-for-agent

#### MM-003 — @effect/tsgo pinned exact but typescript caret — patched pair can drift
low · dx · repo · [.issues/low/MM-003-mattia-manzati.md](../../.issues/low/MM-003-mattia-manzati.md)
**Verdict:** CONFIRMED (high confidence).
**Evidence at HEAD:**
- `package.json:36` has `"@effect/tsgo": "0.45.0",` and `package.json:9` has `"prepare": "effect-tsgo patch",`.
- `pnpm-workspace.yaml:25` has `typescript: ^7.0.0`, which the lockfile resolves to 7.0.2 (`pnpm-lock.yaml:54-56`).

**Fix plan:**
1. Pin the catalog `typescript: 7.0.2` exactly.
2. Move `@effect/tsgo` into the catalog next to it.
3. Add a dependabot npm group `typescript-toolchain` with the patterns `typescript`, `@effect/tsgo` and `@effect/language-service`.
4. Optionally add a version-equality assertion script to `check`.

- **Effort:** S.

**Recommended status:** ready-for-agent

#### MTS-009 — build.mjs and circular.mjs use cwd-relative globs and silently succeed from the wrong directory
low · dx · repo · [.issues/low/MTS-009-monorepo-tooling-specialist.md](../../.issues/low/MTS-009-monorepo-tooling-specialist.md)
**Verdict:** CONFIRMED (high confidence).
**Evidence at HEAD:** `scripts/build.mjs:11-14`
```js
const packages = globSync(["packages/*/package.json"]);

if (packages.length === 0) {
  console.log("build: no packages/* yet, skipping");
```
`scripts/circular.mjs:9,16-17` shows the same pattern. `scripts/package-smoke.mjs:22-26` already anchors correctly with `rootDir` from `import.meta.url` and `{ cwd: rootDir, absolute: true }`.
**Fix plan:**
1. Anchor both scripts at `rootDir`, and make an empty glob call `process.exit(1)`. Remove the "until M1 Core" comments.
2. In circular: also glob `.tsx` (react's `Providers.tsx` is currently unscanned), pass `baseDir: rootDir`, and add a `.catch` that exits 1.
3. Make package-smoke's empty branch fail too, and fix its "bare stub packages" comment.

- **Tests:** running from `/tmp` fails loudly; `pnpm build` and `pnpm circular` pass from the repo root.
- **Effort:** S.

**Recommended status:** ready-for-agent

#### MM-009 — Dev scripts are POSIX/tsc-on-PATH only; Windows contributors break
low · dx · repo · [.issues/low/MM-009-mattia-manzati.md](../../.issues/low/MM-009-mattia-manzati.md)
**Verdict:** CONFIRMED (high confidence).
**Evidence at HEAD:** `scripts/build.mjs:16`
```js
  const result = spawnSync("tsc", ["-b", "tsconfig.packages.json"], { stdio: "inherit" });
```
`package.json:11`: `"clean": "tsc -b --clean && rm -rf packages/*/lib features/lib",`
**Fix plan:**
1. Resolve `typescript/bin/tsc` with `createRequire`. It is a node script (`import "../lib/tsc.js"`), so run it via `spawnSync(process.execPath, [tscJs, "-b", ...], {cwd: rootDir})`. This also guarantees the tsgo-patched workspace compiler is the one used.
2. Add a new `scripts/clean.mjs` that uses `fs.rmSync(..., {recursive: true, force: true})`, and point `clean` at it.
3. Optionally add a `windows-latest` build/clean smoke job.

- **Effort:** S.
- **Blocked by:** MTS-009 (same file).

**Recommended status:** ready-for-agent

#### ELC-003 — Madge cycle guard skips type imports, leaving type-level cycles undetected
`low` / `dx` / `repo` · [.issues/low/ELC-003-effect-layer-context-architect.md](../../.issues/low/ELC-003-effect-layer-context-architect.md)

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `scripts/circular.mjs:19` — Unchanged; the glob at :9 is also `.ts`-only, so react's .tsx files are never scanned.
  ```
  madge(files, {
      detectiveOptions: {
        ts: {
          skipTypeImports: true,
        },
      },
  ```
- `packages/core/src/AuditLog.ts:32` — Running madge over packages/*/src with skipTypeImports:false at HEAD reports exactly one cycle: [core/src/AuditLog.ts, core/src/AuthEvents.ts]...
  ```
  import type { AuthEvent } from "./AuthEvents.ts";
  ```
- `packages/core/src/AuthEvents.ts:21` — ...closed by this value import (introduced by 6bd3f1d). The guard is blind to a real cycle today.
  ```
  import { AuditLog } from "./AuditLog.ts";
  ```

**Fix plan:** Break the one existing type cycle, then make circular.mjs run a second, type-inclusive madge pass (and scan .tsx) so type-level cycles fail `pnpm circular`.

Steps:
1. Move the `AuthEvent` union and its member interfaces out of packages/core/src/AuthEvents.ts into a new leaf module packages/core/src/AuthEvent.ts (types + any schemas only, no imports of AuditLog); AuthEvents.ts and AuditLog.ts both import from it; re-export from AuthEvents.ts / index.ts so the public surface is unchanged.
2. scripts/circular.mjs — glob `packages/*/src/**/*.{ts,tsx}`; run madge twice: pass 1 as today (value cycles), pass 2 with `ts.skipTypeImports:false` and `tsx.skipTypeImports:false`; fail if either reports cycles, labelling which kind.
3. Add a header comment documenting both passes' scope.
4. Coordinate with MTS-009 (same file: make the glob relative to `import.meta.dirname`).

Files: `packages/core/src/AuthEvent.ts (new)`, `packages/core/src/AuthEvents.ts`, `packages/core/src/AuditLog.ts`, `packages/core/src/index.ts`, `scripts/circular.mjs`

Tests (write first):
- Red: add pass 2 first — `pnpm circular` must fail naming AuditLog.ts/AuthEvents.ts. Green after extracting AuthEvent.ts. Existing core tests (AuthEvents/AuditLog) stay green.

Acceptance:
- `pnpm circular` fails on an `import type` cycle.
- No cycles reported at HEAD after the refactor; `pnpm check` green.

Spec refs: none · Effort: **S** · Depends on: none

**Recommended status:** `ready-for-agent`

#### MM-007 — package:smoke depends on typecheck's emit side effect with no lib/ precheck
low · dx · repo · [.issues/low/MM-007-mattia-manzati.md](../../.issues/low/MM-007-mattia-manzati.md)
**Verdict:** CONFIRMED (high confidence).
**Evidence at HEAD:** `scripts/package-smoke.mjs:11-14`
```js
// typecheck` in the `check` script chain, since typecheck's `tsc -b`
// project references are what produce the real `lib/` output these
// checks pack and inspect.
```
- The loop at `:38` never checks that `lib/` exists.
- `packages/ports/package.json:14-18` resolves `import` to `./lib/index.js`.
- `examples/memory-server/package.json:7-8` has `"start": "node --experimental-strip-types index.ts"` and no prestart build.

**Fix plan:**
1. Before running publint/attw, check that every `exports` import/types target exists. If one is missing, print "run `pnpm typecheck` first" and exit 1.
2. Give the example a `"prestart": "pnpm -w build"` and note it in its README.

- **Tests:** `pnpm clean && pnpm package:smoke` gives one actionable error; `pnpm clean && pnpm --filter @awthaq/example-memory-server start` boots.
- **Effort:** S.
- **Blocked by:** MTS-009.

**Recommended status:** ready-for-agent

### Workstream: `tooling-typecheck-lint`

#### AH-004 (anders-hejlsberg) — Declared no-as-in-library-source invariant is unenforced and already violated
`medium` / `dx` / `repo` · [.issues/medium/AH-004-anders-hejlsberg.md](../../.issues/medium/AH-004-anders-hejlsberg.md)

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `.oxlintrc.json:5` — Only type-related lint rule; bans `any` annotations, not `as` assertions. No `typescript/consistent-type-assertions` entry and no custom assertion rule in tools/oxc/rules (5 vendored effect rules only).
  ```
  "no-explicit-any": "error",
  ```
- `packages/password/src/Password.ts:191` — The invariant is declared in source...
  ```
  * assertion (this repo forbids `as`/`as unknown as`/`as any` in library
   * source).
  ```
- `packages/password/src/Password.ts:571` — ...and violated 380 lines later in the same file (also :583 signIn, :599 requestReset), next to the narrowing helper `emailFromRateLimitInput` (:195) that already exists for exactly this.
  ```
  key: (input) => `password:signup:${(input as { readonly email: string }).email}`,
  ```
- `packages/oauth/src/OAuthProvider.ts:142` — Untrusted IdP JSON cast. Other live src sites at HEAD: OAuth.ts:144-146 (isFlowPayload), OAuth.ts:250 (token response), OAuth.ts:712 (userinfo), OAuthTokenAccess.ts:93 (refresh response), Jwt.ts:90 (`parts as [string, string, string]`). Sessions.ts:228 no longer has one.
  ```
  Effect.map((body) => body as DiscoveryDocument),
  ```

**Fix plan:** Make the no-type-assertion rule a checked property: enable oxlint's built-in `typescript/consistent-type-assertions` with `assertionStyle: "never"` (still permits `as const`) scoped to library source, and remove the 11 remaining src assertion sites.

Steps:
1. packages/password/src/Password.ts:571/583/599 — replace `(input as { readonly email: string }).email` with the existing `emailFromRateLimitInput(input)` helper (:195).
2. packages/oauth/src/Jwt.ts:90 — replace `parts as [string, string, string]` with a destructure after a length guard that narrows (e.g. `const [h, p, s] = parts; if (h === undefined || p === undefined || s === undefined) throw ...`).
3. packages/oauth/src/OAuth.ts:144-146 `isFlowPayload` — replace with `Schema.is(FlowPayloadSchema)` (or `Predicate.hasProperty` + `typeof` narrowing).
4. packages/oauth/src/OAuth.ts:250, :712 and packages/oauth/src/OAuthTokenAccess.ts:93 — decode `response.json` with `Schema.decodeUnknownEffect(TokenResponse)` / a `Schema.Record(Schema.String, Schema.Unknown)` for userinfo, mapping decode failure to `OAuthCallbackFailed` (these are GC-001's residue — GC-001 is marked resolved but three token/userinfo casts remain).
5. packages/oauth/src/OAuthProvider.ts:142 — decode the discovery document with a `DiscoveryDocument` Schema (this is ESS-002/TTE-003's fix; land together).
6. .oxlintrc.json — add `"overrides": [{ "files": ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx"], "rules": { "typescript/consistent-type-assertions": ["error", { "assertionStyle": "never" }] } }]` (tests keep narrow assertions).
7. Update the comment at Password.ts:186-193 to cite the lint rule as the enforcement mechanism.

Files: `.oxlintrc.json`, `packages/password/src/Password.ts`, `packages/oauth/src/Jwt.ts`, `packages/oauth/src/OAuth.ts`, `packages/oauth/src/OAuthTokenAccess.ts`, `packages/oauth/src/OAuthProvider.ts`

Tests (write first):
- Red first: enable the override and run `pnpm lint` — it must report exactly the 11 sites listed above (this is the failing check).
- packages/oauth/test: add a case where the token endpoint returns a non-object / `access_token: 42` body and assert `OAuthCallbackFailed` (not a defect) — proves the decode replaced the cast.
- Existing password rate-limit tests (packages/password/test) must stay green after swapping in `emailFromRateLimitInput`.

Acceptance:
- `pnpm lint` fails on any new `x as T` (other than `as const`) under packages/*/src.
- `grep -rnE '\bas (unknown|any|[A-Z{\[])' packages/*/src` returns only comments/imports.
- `pnpm check` green.

Spec refs: none · Effort: **M** · Depends on: ESS-002, TTE-002, TTE-003

**Recommended status:** `ready-for-agent`

#### AH-008 (anders-hejlsberg) — noPropertyAccessFromIndexSignature disabled in an otherwise maximal strict profile
`low` / `dx` / `repo` · [.issues/low/AH-008-anders-hejlsberg.md](../../.issues/low/AH-008-anders-hejlsberg.md)

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `tsconfig.base.json:36` — Still explicitly off at HEAD, between `noUnusedParameters: true` and `sourceMap`; every other correctness flag (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes) is on.
  ```
  "noPropertyAccessFromIndexSignature": false,
  ```

**Fix plan:** Flip `noPropertyAccessFromIndexSignature` to true in tsconfig.base.json and convert the resulting dot-access-on-index-signature sites to bracket access (which `noUncheckedIndexedAccess` then types as `T | undefined`).

Steps:
1. tsconfig.base.json:36 — set to `true` (tsconfig.test.json inherits it).
2. Run `pnpm run typecheck`; convert each TS4111 site to `obj["key"]` and handle the `undefined` case explicitly (Option.fromNullishOr / early fail) — do not add assertions.
3. If a generated/erasure-sensitive file genuinely needs the escape hatch, override it in that package's tsconfig.src.json only, with a comment.

Files: `tsconfig.base.json`, `(sites reported by tsc, expected in packages/*/src and features/step-definitions)`

Tests (write first):
- The typecheck itself is the test: `pnpm run typecheck` with the flag on is the red step; green once sites are fixed. No behavior change, existing suites must stay green.

Acceptance:
- tsconfig.base.json has `noPropertyAccessFromIndexSignature: true`.
- `pnpm run typecheck` and `pnpm check` green with no new assertions.

Spec refs: none · Effort: **S** · Depends on: none

**Recommended status:** `ready-for-agent`

#### AH-009 (anders-hejlsberg) — Global DOM lib in base config lets server packages type-check DOM references
`info` / `dx` / `repo` · [.issues/info/AH-009-anders-hejlsberg.md](../../.issues/info/AH-009-anders-hejlsberg.md)

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `tsconfig.base.json:9` — Still monorepo-wide; comment at :6-8 justifies it for @awthaq/react only.
  ```
  "lib": ["ESNext", "DOM"],
  ```
- `packages/jwt/src/KeyRing.ts:95` — Proof the leak is real: a server package already depends on the DOM-lib global `CryptoKey` (@types/node 22 only declares it inside the `webcrypto` namespace, crypto.d.ts:4171), so dropping DOM will surface this site.
  ```
  const exportJwk = (key: CryptoKey) =>
  ```
- `packages/client/src/passkey/PasskeyClient.ts:272` — Since 0441226 @awthaq/client is a genuine browser package too, so DOM must move to client/react/next, not just react/next as the audit suggested.
  ```
  const getClientCapabilities: Effect.Effect<PasskeyClientCapabilities> = Effect.promise(async () => {
  ```

**Fix plan:** Base lib becomes ["ESNext"]; DOM is added only in the browser-facing packages' tsconfig.src.json (client, react, next) and in tsconfig.test.json (react .tsx tests run in that shared program).

Steps:
1. tsconfig.base.json:9 — `"lib": ["ESNext"]`; rewrite the :5-8 comment.
2. packages/client/tsconfig.src.json, packages/react/tsconfig.src.json, packages/next/tsconfig.src.json — add `"lib": ["ESNext", "DOM"]` under compilerOptions.
3. tsconfig.test.json — add `"lib": ["ESNext", "DOM"]` (single program includes react/client browser tests).
4. packages/jwt/src/KeyRing.ts:95 (and any other site tsc reports) — use `import type { webcrypto } from "node:crypto"` and `webcrypto.CryptoKey`, or the Effect crypto service type, instead of the DOM global.
5. Keep `jsx: react-jsx` global (harmless for .ts) or move it alongside DOM — optional.

Files: `tsconfig.base.json`, `tsconfig.test.json`, `packages/client/tsconfig.src.json`, `packages/react/tsconfig.src.json`, `packages/next/tsconfig.src.json`, `packages/jwt/src/KeyRing.ts`

Tests (write first):
- Red: change the base lib and run `pnpm run typecheck` — KeyRing.ts `CryptoKey` must error (proves the guard now works). Green after the fix. Add nothing else; `pnpm run test` + `pnpm run test:bdd` stay green.

Acceptance:
- A `document.title` reference added to packages/core/src fails typecheck.
- `pnpm check` green.

Spec refs: none · Effort: **S** · Depends on: none

**Recommended status:** `ready-for-agent`

### Workstream: `coverage-enforcement`

#### MM-004 — Coverage is reported but never threshold-enforced, against the DoD's own gate 6
low · testing · repo · [.issues/low/MM-004-mattia-manzati.md](../../.issues/low/MM-004-mattia-manzati.md)
**Verdict:** CONFIRMED (high confidence). Canonical for ETVS-007.
**Evidence at HEAD:** `vitest.config.ts:17-24`
```ts
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx"],
      // Per-package thresholds belong here once a package needs a bar other
      // than the workspace-wide default (see qadi's own vitest.config.ts for
      // that pattern).
    },
```
`spec/process/definitions-of-done.md:37`: "| 6 | Unit and integration tests | Tests pass, with a coverage threshold enforced rather than merely reported | Not yet — planned for M1 |"

`../qadi/vitest.config.ts:31-38` contains the pattern ("A shortfall is a failure, not a report." `thresholds: { lines: 90, ...` plus `"packages/core/src/**"` overrides).
**Fix plan:**
1. Run `pnpm coverage` to measure.
2. Set workspace `thresholds` at floor minus 2. The stale Sep-14 local run showed statements 92.66, branches 82.04, functions 89.5 and lines 92.79.
3. Add per-package overrides for core, password, jwt and server.
4. Reword the comment to point at `../qadi` (the sibling repo, not `packages/qadi`).
5. Mark DoD gate 6 active and run `spec:verify:strict`.

- **Tests:** temporarily set `lines: 99` and confirm it fails; `pnpm check` is green.
- **Effort:** S.

**Recommended status:** ready-for-agent

#### ETVS-007 — Coverage collected but never enforced, with a stale pointer to qadi's 'threshold pattern'
low · dx · repo · [.issues/low/ETVS-007-effect-testing-vitest-specialist.md](../../.issues/low/ETVS-007-effect-testing-vitest-specialist.md)
**Verdict:** DUPLICATE of MM-004 (high confidence).
**Evidence at HEAD:** `vitest.config.ts:21-23` is the same comment and still has no thresholds. The "stale pointer" half is overstated. The auditor checked `packages/qadi/vitest.config.ts`, but the comment means the sibling qadi repo, whose `../qadi/vitest.config.ts:32` has `thresholds: { lines: 90, ...`. The comment is ambiguous, and MM-004's plan rewords it.
**Recommended status:** resolved (duplicate of MM-004)

### Workstream: `quality-metrics-regeneration`

#### DESS-005 — Per-package quality metrics describe empty placeholders from the old naming era
medium · docs · repo · [.issues/medium/DESS-005-developer-experience-sdk-specialist.md](../../.issues/medium/DESS-005-developer-experience-sdk-specialist.md)
**Verdict:** CONFIRMED (high confidence). Canonical for TTE-007, NSA-009, AH-005 (anders-hejlsberg), WPS-011, TS-006 and SSMS-010.
**Evidence at HEAD:** `.quality-metrics/react.json:73`
```json
        "title": "Entire package is an unimplemented placeholder — zero type-level API surface",
        "evidence": "packages/react/src/index.ts:8-10",
        "detail": "... Declared runtime dep on @effect-auth/client (package.json:33) is currently unused."
```
`packages/react/src/index.ts:19`
```ts
export * from "@qadi/react";
export * as AuthClientAtom from "./AuthClientAtom.ts";
export * from "./Providers.tsx";
```
Measured at HEAD, react is 3 files and 277 LOC, and client is 4 files and 635 LOC. The metrics say fileCount 1 and totalLoc 9. All 21 JSONs are dated Sep 12 16:14, gitignored (`.gitignore:6`) and untracked, so they exist only on this machine.
**Fix plan:**
1. Delete the local `.quality-metrics/`.
2. Add the renderer freshness guard (MTS-011 step 3): `sourceSha` must equal HEAD, and `D.fileCount`/`totalLoc` must equal the live glob per package. Reject unknown package keys and any `@effect-auth/` string. Exit 1 unless `--allow-stale`.

- **Files:** `scripts/generate-quality-dashboard.mjs`.
- **Tests:** manual: rendering the Sep-12 JSONs exits 1.
- **Acceptance:** stale data can't be rendered silently.
- **Effort:** S.
- **Blocked by:** MTS-011's decision.

**Recommended status:** ready-for-human (follows MTS-011)

#### MTS-011 — Generated quality dashboard is committed while its inputs are gitignored
low · dx · repo · [.issues/low/MTS-011-monorepo-tooling-specialist.md](../../.issues/low/MTS-011-monorepo-tooling-specialist.md)
**Verdict:** CONFIRMED (high confidence).
**Evidence at HEAD:** `.gitignore:4-6`
```
coverage/
*.tsbuildinfo
.quality-metrics/
```
`type-quality-dashboard.html:201` (tracked): `const DATA = {"generated":"2026-09-12T14:29:41.027Z", ... "overall":64.4`
`scripts/generate-quality-dashboard.mjs:1-4`
```js
// Generates a self-contained HTML type-system quality dashboard for the
// awthaq monorepo from per-package KPI JSON files (see
// /tmp/awthaq-kpi/CONTRACT.md for the 50-KPI contract).
```
It's worse than reported: the script only renders, and nothing in the repo produces the inputs. Nothing in `pnpm check` consumes the output.
**Fix plan (option A):**
1. `git rm --cached type-quality-dashboard.html` and add it to `.gitignore`.
2. Document the JSON contract in-repo.
3. Add the freshness guard (shared with DESS-005).
4. Write one paragraph in CONTRIBUTING.

- **Tests:** manual renderer run against stale data exits 1.
- **Acceptance:** `git ls-files type-quality-dashboard.html` is empty.
- **Effort:** S.

**Decision needed:** yes (A/B/C above; the recommendation is A).
**Recommended status:** ready-for-human

#### AH-005 (anders-hejlsberg) — Shipped type-KPI metrics are stale and contradict the source
medium · dx · repo · [.issues/medium/AH-005-anders-hejlsberg.md](../../.issues/medium/AH-005-anders-hejlsberg.md)
**Verdict:** DUPLICATE of DESS-005 (high confidence).
**Evidence at HEAD:**
- `.quality-metrics/oauth.json:8` has `"typeAssertions": 0,` and lines 42-43 have `fileCount: 1, totalLoc: 9`.
- `packages/oauth/src/OAuthProvider.ts:142`:
  ```ts
          Effect.map((body) => body as DiscoveryDocument),
  ```
  oauth is 6 files and 1566 LOC. "Shipped" is overstated: the JSONs are gitignored and have never been committed.

**Recommended status:** resolved (duplicate of DESS-005)

#### TTE-007 — Quality-metrics JSON is stale in both directions on type-safety KPIs
low · compliance · repo · [.issues/low/TTE-007-typescript-type-level-engineer.md](../../.issues/low/TTE-007-typescript-type-level-engineer.md)
**Verdict:** DUPLICATE of DESS-005 (high confidence).
**Evidence at HEAD:** `.quality-metrics/core.json:8,15` has `"typeAssertions": 0` and `"brandedTypes": 0`. Against that, `packages/core/src/Users.ts:48-49`:
```ts
export type UserId = string & Brand.Brand<"UserId">;
export const UserId = Brand.nominal<UserId>();
```
There are four brands in total (Users:48, Accounts:27, Sessions:30, Verification:51). core is 15 files and 4662 LOC versus the recorded 4 files and 611 LOC. The "fix the extractor" half is moot because there is no in-repo extractor. Cast counting belongs in lint (AH-004 anders-hejlsberg, sibling fork).
**Recommended status:** resolved (duplicate of DESS-005)

#### TS-006 — Per-package quality-metrics JSONs describe a 9-LOC placeholder, not the real packages
low · dx · repo · [.issues/low/TS-006-tim-smart.md](../../.issues/low/TS-006-tim-smart.md). This is the tim-smart TS-006; a different torin-sandall TS-006 exists in another slice.
**Verdict:** DUPLICATE of DESS-005 (high confidence).
**Evidence at HEAD:** `.quality-metrics/server.json:42-44`
```json
      "fileCount": 1,
      "totalLoc": 9,
      "avgFileLoc": 9.0,
```
`packages/server/src/index.ts:10-12` exports Account, Authentication and AuthHttp (6 files, 868 LOC). `sql.json` shows the same pattern.
**Recommended status:** resolved (duplicate of DESS-005)

#### NSA-009 — Per-package quality metrics describe the package as an empty export-{} placeholder - badly stale
info · testing · repo · [.issues/info/NSA-009-nextjs-server-actions-auth-specialist.md](../../.issues/info/NSA-009-nextjs-server-actions-auth-specialist.md)
**Verdict:** DUPLICATE of DESS-005 (high confidence).
**Evidence at HEAD:** `.quality-metrics/next.json:21` says "The package exports nothing (`export {};`) ... (@effect-auth/react, effect) are entirely unexercised." Compare `packages/next/src/index.ts:9-12`:
```ts
export { getSession } from "./GetSession.ts";
export type { HeadersLike, Session } from "./GetSession.ts";
export { hasSessionCookie } from "./HasSessionCookie.ts";
export { withNextCookies } from "./WithNextCookies.ts";
```
**Recommended status:** resolved (duplicate of DESS-005)

#### WPS-011 — Package quality metrics and behavior-spec banner still describe passkey as an empty scaffold
info · docs · repo · [.issues/info/WPS-011-webauthn-passkeys-specialist.md](../../.issues/info/WPS-011-webauthn-passkeys-specialist.md)
**Verdict:** DUPLICATE of DESS-005 (high confidence), for the metrics half.
**Evidence at HEAD:** `.quality-metrics/passkey.json:41-43` shows `fileCount: 1, totalLoc: 9`; passkey is actually 5 files and 2093 LOC. `spec/behaviors/17-passkey.md:15`:
```md
> This file describes planned behavior. No code implementing it exists yet; awthaq is pre-implementation.
```
The banner half is also real. It is the repo-wide stale-banner problem (53 spec/feature files carry "pre-implementation"), which belongs cross-slice to **BPAS-007 / DTWS-001**. The orchestrator should make sure that sweep includes `spec/behaviors/17-passkey.md:15`.
**Recommended status:** resolved (duplicate of DESS-005; banner half tracked by BPAS-007/DTWS-001)

#### SSMS-010 — Stale quality metrics describe packages/sql as a 9-line placeholder
info · docs · repo · [.issues/info/SSMS-010-sql-schema-migration-specialist.md](../../.issues/info/SSMS-010-sql-schema-migration-specialist.md)
**Verdict:** DUPLICATE of DESS-005 (high confidence).
**Evidence at HEAD:** `.quality-metrics/sql.json:42-43` shows `fileCount: 1, totalLoc: 9`, and `sql.json:73` says "Placeholder keeps the module a valid ES module via `export {}`". Compare `packages/sql/src/index.ts:13-15`:
```ts
export * as CoreMigrations from "./CoreMigrations.ts";
export * as Models from "./Models.ts";
export * as Repositories from "./Repositories.ts";
```
sql is 4 files and 1538 LOC.
**Recommended status:** resolved (duplicate of DESS-005)

### Workstream: `bdd-suite-docs`

#### AH-006 (aslak-hellesoy) — Suite self-description is stale: README and STYLE claim pre-implementation with no runner
`medium` · `docs` · `repo` · [.issues/medium/AH-006-aslak-hellesoy.md](../../.issues/medium/AH-006-aslak-hellesoy.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence high) — canonical for BDD-006, BDD-004

**Evidence at HEAD:**

- `features/README.md:5` — Unchanged at HEAD although features/package.json, vitest.config.ts and 13 step-definition modules (5,191 lines) exist.

  ```
  **This suite is pre-implementation, same as the rest of the repository.** There is no `package.json`, no Cucumber configuration, and no step-definition layer wiring these scenarios to real code
  ```
- `features/STYLE.md:9` — Banner mandate still in force.

  ```
  `awthaq` is pre-implementation: no package, no source, no test runner. Every `.feature` file therefore opens with the same banner comment
  ```
- `features/STYLE.md:35` — Contradicts the 627 allocated tags.

  ```
  - **`Scenario:` gets no `@REQ-EA` tag from you.** `REQ-EA-NNN` ids are allocated in one later deterministic pass
  ```
- `features/features/05-authentication-methods/15-password.feature:1` — 26 of 28 .feature files (all except _smoke and 27-admin) still carry the banner, including the 4 wired ones.

  ```
  # awthaq is pre-implementation (see spec/README.md). Every scenario in
  # this file specifies intended behavior of a system that does not exist yet
  ```

**Fix plan:** Rewrite features/README.md and features/STYLE.md to the real operating model (wired/unwired split, @skip/@unwired conventions, allocator-owned REQ tags, run commands) and scope the pre-implementation banner to @unwired files only.

Steps:
1. features/README.md: replace line 5's paragraph with a 'Running the suite' section (`pnpm run test:bdd` / `pnpm --filter @awthaq/features test`, @effect-cucumber/vitest, one <feature>.steps.test.ts per .feature, World+Steps modules in step-definitions/), a 'Wired vs unwired' section (Feature-level `@skip @unwired` = never wired; scenario-level `@skip` + rationale comment = pruned; link spec/traceability.md §6 wiring table from AH-003), and a pointer to .scratch/shipping-gaps for prune rationales. Keep the (already-correct) 10-directory/27-file table.
2. features/STYLE.md: rewrite line 9 to describe the lifecycle (banner required only while a Feature is @unwired; removed when wired — 27-admin is the model); update the banner template (lines ~41-44, ~95-98) accordingly; replace line 35 and line 236 with 'REQ-EA tags are mandatory and allocator-owned: run features/scripts/allocate-req-ea.py after adding scenarios; never hand-tag'; add an @skip/@only/@unwired conventions section requiring a rationale comment above every scenario-level @skip; update line 240's 'does not exist yet' framing.
3. Remove the banner from the 4 wired feature files that still carry it (07-sessions, 15-password, 16-oauth, 17-passkey) and from every file as AH-003 wires it.
4. Add a spec:verify check (spec/scripts/verify-traceability.sh) that fails if a Feature without @unwired still contains 'does not exist yet' — keeps docs and suite in lockstep.

Files: `features/README.md`, `features/STYLE.md`, `features/features/02-domain/07-sessions.feature`, `features/features/05-authentication-methods/15-password.feature`, `features/features/05-authentication-methods/16-oauth.feature`, `features/features/05-authentication-methods/17-passkey.feature`, `spec/scripts/verify-traceability.sh`

Tests (write first):
- verify-traceability.sh new check 'features banner <-> @unwired consistency' — write it first; it fails on the 4 wired files at HEAD, passes after banner removal.

Acceptance:
- `grep -n 'no \`package.json\`' features/README.md` returns nothing; STYLE.md no longer forbids @REQ-EA tags.
- Every .feature containing 'does not exist yet' carries @unwired, and vice versa; `pnpm run spec:verify:strict` green.

Spec refs: — · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### TIR-006 — revokeAll missing from BEH-EA-031 spec and BDD endpoint table
`low` · `docs` · `repo` · [.issues/low/TIR-006-token-introspection-revocation-specialist.md](../../.issues/low/TIR-006-token-introspection-revocation-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `spec/behaviors/04-contract-stratum.md:142` — Five endpoints in the normative text.

  ```
  REQUIREMENT: The core `session` group MUST mount at the root of the
               composed `HttpApi` (not under any plugin's namespace prefix)
               and MUST expose `current`, `list`, `signOut`, `revoke`, and
               `revokeOthers` as its endpoints.
  ```
- `features/features/01-contract-and-persistence/04-contract-stratum.feature:202` — Table stops at revokeOthers.

  ```
          | revoke        | POST   | /auth/session/revoke        |
          | revokeOthers  | POST   | /auth/session/revoke-others |
  ```
- `packages/api/src/Session.ts:58` — Shipped sixth endpoint.

  ```
    .add(HttpApiEndpoint.post("revokeAll", "/session/revoke-all"))
  ```
- `packages/server/src/Session.ts:120` — Implemented handler; no BDD scenario references /revoke-all anywhere in features/.

  ```
        revokeAll: Effect.fnUntraced(function* () {
  ```

**Fix plan:** Amend BEH-EA-031 to six endpoints, add revokeAll to the 04-contract-stratum endpoint table, and add a wired sessions scenario for revoke-all under BEH-EA-054.

Steps:
1. spec/behaviors/04-contract-stratum.md BEH-EA-031: heading, endpoint block (add `POST /auth/session/revoke-all`) and REQUIREMENT text → six endpoints incl. `revokeAll`, noting it kills the caller's own session too (used by password reset).
2. spec/behaviors/07-sessions.md BEH-EA-054: add a sentence defining revoke-all semantics (all sessions incl. current; response clears cookie).
3. 04-contract-stratum.feature: add `| revokeAll | POST | /auth/session/revoke-all |` to the table at ~line 203 and 'revokeAll' to the Rule title at line 182.
4. 07-sessions.feature (wired): add `Scenario: Revoking all sessions also ends the caller's current session` under the BEH-EA-054 Rule; re-run features/scripts/allocate-req-ea.py to allocate its REQ id and regenerate features/traceability.md; update spec/traceability.md REQ-EA-079 row text if it enumerates five endpoints.
5. SessionSteps.ts: 'alice revokes all her sessions' → POST /session/revoke-all; 'her previous cookie is rejected' → GET /session → 401; 'her other sessions are rejected' likewise.

Files: `spec/behaviors/04-contract-stratum.md`, `spec/behaviors/07-sessions.md`, `features/features/01-contract-and-persistence/04-contract-stratum.feature`, `features/features/02-domain/07-sessions.feature`, `features/step-definitions/SessionSteps.ts`, `features/traceability.md`, `spec/traceability.md`

Tests (write first):
- 07-sessions.feature 'Revoking all sessions also ends the caller's current session' — write first (red: undefined step), then green.

Acceptance:
- BEH-EA-031 lists six endpoints; the new scenario passes in `pnpm run test:bdd`; `pnpm run spec:verify:strict` green.

Spec refs: BEH-EA-031, BEH-EA-054 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### AH-010 (aslak-hellesoy) — Traceability manifest stale: 602/26 documented vs 627 tags in 27 spec files
`info` · `docs` · `repo` · [.issues/info/AH-010-aslak-hellesoy.md](../../.issues/info/AH-010-aslak-hellesoy.md) · current: `needs-triage`

**Verdict:** PARTIAL (confidence high) — partially fixed by `6887fb5`

**Evidence at HEAD:**

- `features/traceability.md:17` — Fixed: manifest regenerated by 6887fb5 (AH-001/BDD-001/IDS-010); 627 rows, 627 unique tags, no duplicates (only extra grep hit is a comment in 27-admin-impersonation.feature:8).

  ```
  627 `REQ-EA-NNN` ids allocated across 27 `.feature` files.
  ```
- `features/scripts/allocate-req-ea.py:151` — Fixed: allocator refuses duplicates and unlisted files — but only when someone runs it.

  ```
  def check_no_duplicate_req_ids(manifest):
  ```
- `spec/scripts/verify-traceability.sh:166` — Remaining: the CI check (spec:verify:strict) only asserts every tag is *defined somewhere*; it does not assert each tag appears exactly once or that tag count == manifest row count, and its comments are stale (602).

  ```
  # A Gherkin suite now exists (features/features/*.feature, REQ-EA-001 through
  # REQ-EA-602), so this check runs for real rather than SKIPping.
  ```

**Fix plan:** Harden spec/scripts/verify-traceability.sh check 4 into a bijection check between @REQ-EA tags in features/features and rows of features/traceability.md, and refresh its stale 602 comments.

Steps:
1. In verify-traceability.sh check 4: compute tags (with duplicates) from features/features/**/*.feature excluding comment lines; FAIL if any tag occurs more than once across files; compute manifest ids from `^| REQ-EA-` rows of features/traceability.md; FAIL on any id in one set but not the other (reports both directions).
2. Also parse the header count sentence ('N `REQ-EA-NNN` ids allocated across M `.feature` files') and FAIL if N != row count.
3. Update comments at lines 166-174 to drop the hard-coded 602.

Files: `spec/scripts/verify-traceability.sh`

Tests (write first):
- Temporarily duplicate a @REQ-EA tag in a scratch copy / run the script against a fixture dir and confirm FAIL; confirm PASS at HEAD (`pnpm run spec:verify:strict`).

Acceptance:
- `pnpm run spec:verify:strict` fails when a REQ tag is duplicated, missing from the manifest, or a manifest row has no tag; passes at HEAD.

Spec refs: — · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### BDD-006 — README's pre-implementation claims contradict the wired suite it introduces
`medium` · `docs` · `repo` · [.issues/medium/BDD-006-bdd-gherkin-acceptance-testing-specialist.md](../../.issues/medium/BDD-006-bdd-gherkin-acceptance-testing-specialist.md) · current: `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **AH-006**

**Evidence at HEAD:**

- `features/README.md:5` — Pre-implementation paragraph still present — same root cause as AH-006.

  ```
  There is no `package.json`, no Cucumber configuration, and no step-definition layer wiring these scenarios to real code
  ```
- `features/README.md:9` — Fixed part: the '26 total / 9 directories' table was updated (09-admin-and-impersonation, BEH-EA 209-220 at line 22) by 6887fb5.

  ```
  One `.feature` file per `spec/behaviors/NN-*.md` file (27 total), grouped into 10 directories under `features/features/`
  ```

**No separate fix:** README half of AH-006. Directory table already fixed by 6887fb5; the pre-implementation paragraph is rewritten by AH-006 step 1.

**Recommended status:** `resolved`

#### BDD-004 — STYLE.md's central premise and prohibitions are falsified by current practice
`medium` · `docs` · `repo` · [.issues/medium/BDD-004-bdd-gherkin-acceptance-testing-specialist.md](../../.issues/medium/BDD-004-bdd-gherkin-acceptance-testing-specialist.md) · current: `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **AH-006**

**Evidence at HEAD:**

- `features/STYLE.md:9` — Unchanged.

  ```
  `awthaq` is pre-implementation: no package, no source, no test runner.
  ```
- `features/STYLE.md:236` — Unchanged; folded into AH-006's STYLE rewrite (allocator-owned tags, @skip/@unwired conventions).

  ```
  - Don't tag scenarios with `@REQ-EA-*`.
  ```

**No separate fix:** STYLE half of AH-006 (banner premise, REQ-tag prohibition, @skip conventions) — AH-006 step 2.

**Recommended status:** `resolved`

### Workstream: `bdd-step-definition-quality`

#### AH-004 (aslak-hellesoy) — Given/When inversion: Given performs the action while When is a stub
`medium` · `testing` · `repo` · [.issues/medium/AH-004-aslak-hellesoy.md](../../.issues/medium/AH-004-aslak-hellesoy.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7):**

- `features/step-definitions/PasswordSteps.ts:132` — The Given issues the sign-in request itself (lines 132-162).
  ```
  Given("a sign-in attempt where {string}", function* (reason: string) {
      if (reason === "the email is unknown") {
        const response = yield* request("/password/sign-in", {
  ```
- `features/step-definitions/PasswordSteps.ts:164` — The When is a no-op.
  ```
  When('"password.signIn" is called', function* () {
      yield* Effect.void;
    });
  ```
- `features/step-definitions/PasswordSteps.ts:80` — Precondition Given neither arranges nor asserts.
  ```
  Given("no user exists with email {string}", function* (_email: string) {
      yield* Effect.void;
    });
  ```
- `features/step-definitions/SessionSteps.ts:137` — Same inversion in SessionSteps: the session was already issued by `signUp` in the Given at :133-135.
  ```
  When("a session is issued for {string}", function* (_name: string) {
      yield* Effect.void;
    });
  ```
- `features/step-definitions/SessionSteps.ts:22` — Additional instance not in the audit.
  ```
  Given("{string} has no existing session", function* (_name: string) {
      yield* Effect.void;
    });
  ```
- `features/step-definitions/PasswordSteps.ts:202` — Additional instance (REQ-EA-308): the Given at :177 performs all three requests.
  ```
  When("each is handled", function* () {
      yield* Effect.void;
    });
  ```

**Fix plan:** Move every request-issuing body from a Given into its matching When; make precondition Givens arrange state (store the attempt parameters in the World) or assert it (query the store / call an endpoint and assert absence).

Steps:
1. PasswordSteps.ts REQ-EA-307: Given 'a sign-in attempt where {string}' only arranges (for 'the password is wrong' it signs the user up; for every reason it stores the {email,password} pair under an `outline` actor); When '"password.signIn" is called' performs the POST /password/sign-in and stores the response.
2. PasswordSteps.ts REQ-EA-308 (:177-204): Given arranges the three attempts; When 'each is handled' issues the three requests.
3. PasswordSteps.ts:80 'no user exists with email {string}': assert absence — e.g. POST /password/request-reset is useless (uniform); instead read the World's `Users` store through a new World helper `userExists(email)` (expose `Users.findByEmail` via the ManagedRuntime the World already builds) and `assert.equal(false)`.
4. SessionSteps.ts:133-139: Given 'a signed-in user {string}' only registers the actor's credentials; When 'a session is issued for {string}' performs signUp/signIn and captures the Set-Cookie. Same for '{string} has no existing session' (:22) — assert the actor has no cookie / GET /sessions returns 401.
5. Sweep all *Steps.ts for `When(... Effect.void)` / `Given(... Effect.void)` and classify each (grep -n 'Effect.void' features/step-definitions/*.ts); any remaining void step must carry a comment justifying why it is a pure narrative step.

Files: `features/step-definitions/PasswordSteps.ts`, `features/step-definitions/SessionSteps.ts`, `features/step-definitions/PasswordWorld.ts`, `features/step-definitions/SessionWorld.ts`

Tests (write first):
- Mutation-style check (TDD): temporarily make the When throw — with the inversion fixed, REQ-EA-307/308 (15-password.feature) and the BEH-EA-049/055 cookie scenarios (07-sessions.feature:23, :233) must fail; today they pass. Then run `pnpm run test:bdd` green.

Acceptance:
- No When in PasswordSteps.ts/SessionSteps.ts is `yield* Effect.void`.
- No Given issues the HTTP action its scenario's When names.
- 'no user exists with email' fails if a user with that email exists.
- `pnpm run test:bdd` passes.

Spec refs: BEH-EA-113, BEH-EA-114, BEH-EA-049, BEH-EA-055 · Effort: **M** · Depends on: BDD-007

**Recommended status:** `ready-for-agent`

#### TIR-005 — BDD step asserting the reset transaction is an empty stub
`medium` · `testing` · `repo` · [.issues/medium/TIR-005-token-introspection-revocation-specialist.md](../../.issues/medium/TIR-005-token-introspection-revocation-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7):**

- `features/step-definitions/PasswordSteps.ts:384` — Still a no-op at HEAD; REQ-EA-317 is not @skip (15-password.feature:150-157), so it reports phantom coverage.
  ```
  Then("all three effects commit under one transaction", function* () {
      yield* Effect.void;
    });
  ```
- `features/step-definitions/PasswordSteps.ts:358` — Same scenario's 'token is consumed' clause is also vacuous (not in the audit).
  ```
  Then("the token is consumed", function* () {
      yield* Effect.void;
    });
  ```
- `features/step-definitions/PasswordWorld.ts:132` — The underlying defect TIR-004 is fixed (commit 90a2ddf, via ARF-001's withTransaction at packages/password/src/Password.ts:984), but the BDD World composes memory stores + SqlTransaction.layerNoop, so atomicity is unobservable in the current harness.
  ```
      // ARF-001: `confirmReset` now runs inside a `SqlTransaction` — a
      ...
      Layer.provide(SqlTransaction.layerNoop),
  ```

**Fix plan:** Make REQ-EA-317's transaction and token-consumed Thens observable: run this scenario against a SQLite-backed World (real transactions) with a fault-injection hook, and assert both the happy commit and rollback-on-failure; implement 'the token is consumed' by replaying the token and expecting 410.

Steps:
1. PasswordWorld.ts: add a `layerSqlite` composition variant (Users/Accounts/Sessions/Verification `.layerSql` + `@effect/sql-sqlite-node` in-memory client + `SqlTransaction` real layer + CoreMigrations run on boot) selectable via `configureApp({ storage: "sqlite" })`; add `@effect/sql-sqlite-node` to features/package.json devDependencies (already used by packages/core tests).
2. Add a fault-injection option `configureApp({ failAfter: "updateCredentialHash" })` that wraps the Sessions service so `revokeAll` fails with a SqlError (Layer override — no casts).
3. PasswordSteps.ts 'the token is consumed': re-POST /password/confirm-reset with the same token and assert 410 TokenConsumed.
4. PasswordSteps.ts 'all three effects commit under one transaction': in the SQLite World, assert (a) old password no longer signs in, (b) token replay → 410, (c) pre-reset session → 401 — all observed together; then add a companion scenario REQ-EA-6xx 'a failure after the hash update rolls back all three effects' (Given the fault injection; Then the old password still signs in, the token is still redeemable, session s1 still valid) in 15-password.feature under @BEH-EA-117.
5. Update features/traceability.md for the new REQ id; `pnpm run spec:verify:strict`.

Files: `features/step-definitions/PasswordSteps.ts`, `features/step-definitions/PasswordWorld.ts`, `features/package.json`, `features/features/05-authentication-methods/15-password.feature`, `features/traceability.md`, `spec/traceability.md`

Tests (write first):
- Write first: the new rollback scenario in 15-password.feature — it must fail if Password.ts:984's withTransaction wrap is removed (verify by temporarily reverting it), then pass with it.

Acceptance:
- No Then in the REQ-EA-317 scenario is `Effect.void`.
- Removing the `sqlTransaction.withTransaction` wrap in packages/password/src/Password.ts confirmReset makes a BDD scenario fail.
- `pnpm run test:bdd` passes.

Spec refs: BEH-EA-117 · Effort: **M** · Depends on: BDD-007, AH-008

**Recommended status:** `ready-for-agent`

#### AH-007 (aslak-hellesoy) — Catch-all Given("{string}") step dispatches on substring content
`medium` · `testing` · `repo` · [.issues/medium/AH-007-aslak-hellesoy.md](../../.issues/medium/AH-007-aslak-hellesoy.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7):**

- `features/step-definitions/PasswordSteps.ts:492` — Bare {string} step routing on substrings, as reported.
  ```
  Given("{string}", function* (configExpr: string) {
      if (configExpr.includes("onUnavailable")) {
        yield* configureApp({
          config: Password.config({ breachCheck: { onUnavailable: "reject" } }),
        });
      } else if (configExpr.includes("minLength: 12")) {
  ```
- `features/step-definitions/PasswordSteps.ts:503` — Admitted-unreachable fallback branch still present.
  ```
        // REQ-EA-322/324's own bare `"password({ breachCheck: true })"` line —
        // reachable on its own only if this ever ran without the " with no
        // ... override" suffix (below), which currently never happens.
  ```
- `features/step-definitions/PasswordSteps.ts:510` — Overlapping specific step coexists; both discard their parameters' meaning.
  ```
  Given("{string} with no {string} override", function* (_configExpr: string, _knob: string) {
  ```

**Fix plan:** Replace the bare {string} Given with a dedicated custom parameter type that maps the exact literal config expressions to Password.config values (failing on an unknown literal), delete the fallback branch, and add a lint guard forbidding bare-{string} step patterns.

Steps:
1. features/features/05-authentication-methods/15-password.steps.test.ts: pass a custom `ParameterTypeStore` layer to `loadFeature(path, parameterTypes)` (supported by @effect-cucumber/vitest loadFeature's 2nd arg; ParameterTypeDefinition{name, regexp, transformer} in @effect-cucumber/gherkin ParameterTypes.ts) registering `passwordConfig` with regexp `"password\(\{[^"]*\}\)"` (quoted literal) and a transformer that looks the literal up in a `Record<string, PasswordConfig>` of the three known expressions, failing loudly on a miss.
2. PasswordSteps.ts: replace `Given("{string}", ...)` and `Given("{string} with no {string} override", ...)` with `Given("{passwordConfig}", (config) => configureApp({ config, ... }))` and `Given("{passwordConfig} with no {string} override", ...)` that asserts the knob is absent from the resolved config; move the breach HttpClient choice for REQ-EA-326 into its own explicit Given or the When.
3. Delete the unreachable else-branch.
4. Add a guard: a custom oxlint rule in tools/oxc (the repo's existing lint plugin) or a small vitest check under features/ that fails if any Given/When/Then pattern is exactly "{string}" (or starts with "{string}" and nothing else anchors it).

Files: `features/step-definitions/PasswordSteps.ts`, `features/features/05-authentication-methods/15-password.steps.test.ts`, `tools/oxc/index.ts`

Tests (write first):
- Write first: add a deliberately unknown config literal in a scratch copy of the scenario and assert the step fails (transformer miss) instead of silently configuring a default; then `pnpm run test:bdd` green for REQ-EA-322/323/324/326.
- Lint rule unit test in tools/oxc if the rule route is chosen.

Acceptance:
- No step pattern in features/step-definitions is a bare "{string}".
- Config Givens resolve by exact literal via a named parameter type; an unrecognised literal fails the scenario.
- `pnpm run test:bdd` and `pnpm lint` pass.

Spec refs: BEH-EA-119, BEH-EA-120 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### AH-008 (aslak-hellesoy) — Scenario text documents fiction: named sessions and emails are silently replaced in wiring
`low` · `testing` · `repo` · [.issues/low/AH-008-aslak-hellesoy.md](../../.issues/low/AH-008-aslak-hellesoy.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7):**

- `features/step-definitions/PasswordSteps.ts:320` — Session name "s1" discarded; email silently rewritten.
  ```
  Given(
      "a live password-reset token for {string} and an existing session {string} for {string}",
      function* (name: string, _sessionName: string, _forName: string) {
        const signUp = yield* request("/password/sign-up", {
          email: `${name}-reset-flow@example.com`,
  ```
- `features/step-definitions/PasswordSteps.ts:371` — Verified by a proxy via a hardcoded 'alice' actor, not by the named session.
  ```
  Then("session {string} is revoked", function* (_sessionName: string) {
      const actor = yield* getActor("alice");
      // ... — re-derived here from the sign-up response captured in the Given step.
  ```
- `features/step-definitions/PasswordSteps.ts:285` — REQ-EA-316: feature says alice@example.com, wiring signs up alice-reset@example.com.
  ```
  'an email "alice@example.com" with an existing account and an email "nobody@example.com" with no account',
      function* () {
        const response = yield* request("/password/sign-up", {
          email: "alice-reset@example.com",
  ```

**Fix plan:** Track sessions by the Gherkin name in the Password World (as SessionWorld's aliasActor/sessionIdOf already do) and use the emails the feature text names; per-scenario World isolation removes the need for suffixed emails.

Steps:
1. Move the named-session registry (aliasActor/sessionIdOf pattern from SessionWorld.ts) into the shared harness module created by BDD-007 and use it from PasswordWorld.
2. PasswordSteps.ts:320-342: register the sign-up cookie under `sessionName` ("s1") and the actor under `name`; use `${name}@example.com` (the feature's own naming) — if cross-scenario collisions are the reason for suffixes, reset the World per scenario (describeFeature's per-scenario layer) instead of mangling emails.
3. 'session {string} is revoked' (:371) and 'the new password is set' (:362): resolve by the parameter, not hardcoded 'alice'; assert via GET /sessions (or the session endpoint) with the named session's cookie → 401.
4. PasswordSteps.ts:285-306 (REQ-EA-316): sign up the literal alice@example.com and request reset for the literal emails in the step text (parameterize the step with {string} placeholders).

Files: `features/step-definitions/PasswordSteps.ts`, `features/step-definitions/PasswordWorld.ts`, `features/step-definitions/shared/ (new, BDD-007)`

Tests (write first):
- Rename the session in the feature to "s9" in a scratch run: the Then must still resolve it (fails today only by accident of hardcoding). `pnpm run test:bdd` green.

Acceptance:
- Every quoted entity in 15-password.feature REQ-EA-316/317/318 is the entity the wiring creates/asserts.
- No step in PasswordSteps.ts discards a named-entity parameter (no `_sessionName`/`_forName`).

Spec refs: BEH-EA-117 · Effort: **S** · Depends on: BDD-007

**Recommended status:** `ready-for-agent`

#### AH-009 (aslak-hellesoy) — Replay scenario asserts the same status twice and no-ops its non-repetition claim
`low` · `testing` · `repo` · [.issues/low/AH-009-aslak-hellesoy.md](../../.issues/low/AH-009-aslak-hellesoy.md) · current: `needs-triage`

**Verdict:** PARTIAL (confidence: high)

**Evidence at HEAD (ec065a7):**

- `features/step-definitions/PasswordSteps.ts:473` — HOLDS: the only information-bearing clause of REQ-EA-321 asserts nothing.
  ```
  Then("the replayed action is not performed a second time", function* () {
      yield* Effect.void;
    });
  ```
- `features/features/05-authentication-methods/15-password.feature:181` — OVERSTATED: REQ-EA-321 has two Thens, not three; the other 410 check ('the request fails with "410 TokenConsumed"', PasswordSteps.ts:463) belongs to the separate REQ-EA-319 scenario (15-password.feature:169-173). Two scenarios each asserting 410 is legitimate, not a duplicate within one scenario.
  ```
  @REQ-EA-321
  Scenario: A replayed verification token never silently succeeds or silently no-ops
    Given a verification token that has already been consumed
    When the same token is presented to "verification.confirm" again
    Then the replayed action is not performed a second time
    And the caller receives the "410 TokenConsumed" failure rather than an apparent success
  ```

**Fix plan:** Make 'the replayed action is not performed a second time' observable: snapshot the published-events log (and the user's verified state) before the replay and assert the replay added only `auth.token.replay` and changed no user state.

Steps:
1. PasswordSteps.ts When 'the same token is presented to "verification.confirm" again' (:457): before the POST, store `publishedEvents()` length and the user's `emailVerified` value (via a World helper reading Users) in the World.
2. Then 'the replayed action is not performed a second time' (:473): assert the new events delta is exactly one event with `_tag === "auth.token.replay"` (no second verification-success/user-updated event), and emailVerified timestamp unchanged.
3. Optionally rename the 410 Then of REQ-EA-321 to reuse the REQ-EA-319 step text for less duplication (keep one step definition).

Files: `features/step-definitions/PasswordSteps.ts`, `features/step-definitions/PasswordWorld.ts`

Tests (write first):
- Temporarily make the verify-email handler re-apply on a consumed token (scratch patch) — the Then must fail. `pnpm run test:bdd` green.

Acceptance:
- The REQ-EA-321 middle Then has a real assertion that fails if the replay re-performs the action.

Spec refs: BEH-EA-118 · Effort: **S** · Depends on: BDD-007

**Recommended status:** `ready-for-agent`

#### CSD-009 — 5xx breach-check scenario passes coincidentally and cannot detect the CSD-001 defect
`low` · `testing` · `repo` · [.issues/low/CSD-009-credential-stuffing-defense-specialist.md](../../.issues/low/CSD-009-credential-stuffing-defense-specialist.md) · current: `needs-triage`

**Verdict:** PARTIAL (confidence: high)

**Evidence at HEAD (ec065a7):**

- `features/step-definitions/PasswordSteps.ts:541` — HOLDS: the Given is still a no-op; the three failure modes are wired inside the When (:548-576).
  ```
  Given(
      "the breach-database provider fails by timeout in one attempt, by a 5xx response in another, and with a malformed response in a third",
      function* () {
        yield* Effect.void;
      },
    );
  ```
- `features/step-definitions/PasswordSteps.ts:578` — HOLDS: under the default allow posture, 'unavailable' and 'not breached' both yield 200 — the scenario cannot distinguish them, and no BDD scenario pairs a 5xx with onUnavailable: "reject".
  ```
  'sign-up proceeds in all three cases, each treated as "unavailable" rather than handled inconsistently by cause',
      function* () {
        ...
        assert.equal(fiveHundred.status, 200);
  ```
- `packages/password/src/Password.ts:313` — FIXED part: the CSD-001 production defect (503 read as not-breached) was fixed in 25d991e, with a unit test at packages/password/test/Password.test.ts:779 ('CSD-001: a 503 from the breach check fails closed when configured'). The 503 now genuinely takes the unavailable path.
  ```
      // `onUnavailable: "reject"`. `filterStatusOk` turns any non-2xx into a
      // failure, routed to `onUnavailable` by the same catch-all below a
      ...
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
  ```

**Fix plan:** Move the per-case failure wiring into the Given and add an acceptance-level fail-closed counterpart: a Scenario Outline over timeout/5xx/malformed under onUnavailable: "reject" expecting 422, which distinguishes 'unavailable' from 'not breached'.

Steps:
1. PasswordSteps.ts:541: make the Given store the three HttpClient fakes (unreachable, respondingWith(503), malformed) in the World; the When iterates them.
2. 15-password.feature @BEH-EA-119: add Scenario Outline REQ-EA-6xx 'Every failure mode is rejected under fail-closed' with Examples | failure | timeout | 5xx | malformed |, Given the reject config (via AH-007's {passwordConfig} type) and a provider failing by <failure>, Then sign-up is rejected (422).
3. Add step `Given the breach-database provider fails by {breachFailure}` with a custom parameter type mapping to the three fakes.
4. Traceability row for the new REQ id; `pnpm run spec:verify:strict`.

Files: `features/step-definitions/PasswordSteps.ts`, `features/features/05-authentication-methods/15-password.feature`, `features/traceability.md`, `spec/traceability.md`

Tests (write first):
- Write the reject-outline first; verify it would fail by reverting the `filterStatusOk` pipe in Password.ts (the 5xx row goes 200) — then restore; `pnpm run test:bdd` green.

Acceptance:
- A BDD scenario fails if a 5xx breach-check response is ever treated as not-breached under onUnavailable: "reject".
- The REQ-EA-324 Given is no longer a no-op.

Spec refs: BEH-EA-119 · Effort: **S** · Depends on: AH-007

**Recommended status:** `ready-for-agent`

#### BDD-008 — SessionSteps Then-step hardcodes actor 'alice' inside a parameterized assertion
`low` · `correctness` · `repo` · [.issues/low/BDD-008-bdd-gherkin-acceptance-testing-specialist.md](../../.issues/low/BDD-008-bdd-gherkin-acceptance-testing-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7):**

- `features/step-definitions/SessionSteps.ts:52` — Hardcoded actor as reported.
  ```
  Then(
      'she sees {int} sessions, each with its own userAgent and a "current" flag on the session serving the request',
      function* (count: number) {
        const response = yield* getLastResponse("alice");
  ```
- `features/step-definitions/SessionSteps.ts:141` — Cookie-attribute Thens (:141-161) hardcode 'alice' too.
  ```
  Then('the response sets a cookie named "__Host-session"', function* () {
      const actor = yield* getActor("alice");
  ```
- `features/step-definitions/PasswordSteps.ts:362` — Same anti-pattern also in PasswordSteps.ts (:362, :372) — fix together.
  ```
  Then("the new password is set", function* () {
      const actor = yield* getActor("alice");
  ```

**Fix plan:** Introduce a 'current actor' cell in the World set by every step that names an actor, and have pronoun/implicit-subject Thens read it instead of the literal 'alice'.

Steps:
1. Shared harness (BDD-007): add `setCurrentActor(name)` / `currentActor` to the World.
2. SessionSteps.ts: every Given/When with a {string} actor calls setCurrentActor; ':52' Then and cookie Thens ':141-161' read `currentActor`; alternatively capture the Set-Cookie of the last issuing response in a `lastSetCookie` cell (set in the When fixed by AH-004).
3. PasswordSteps.ts ':362' and ':372': same replacement.

Files: `features/step-definitions/SessionSteps.ts`, `features/step-definitions/PasswordSteps.ts`, `features/step-definitions/SessionWorld.ts`, `features/step-definitions/shared/ (new, BDD-007)`

Tests (write first):
- Scratch-rename 'alice' to 'bob' in 07-sessions.feature (BEH-EA-054/055 scenarios) and 15-password.feature REQ-EA-317: scenarios must still pass (they fail today). `pnpm run test:bdd` green.

Acceptance:
- `grep -n 'getActor("alice")\|getLastResponse("alice")' features/step-definitions/*.ts` returns nothing.

Spec refs: BEH-EA-054, BEH-EA-055, BEH-EA-117 · Effort: **S** · Depends on: BDD-007

**Recommended status:** `ready-for-agent`

#### BDD-007 — World harness helpers duplicated per plugin instead of shared
`low` · `dx` · `repo` · [.issues/low/BDD-007-bdd-gherkin-acceptance-testing-specialist.md](../../.issues/low/BDD-007-bdd-gherkin-acceptance-testing-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7):**

- `features/step-definitions/SessionWorld.ts:71` — Line drifted from :52 to :71; still an admitted copy.
  ```
   * Mirrors `PasswordWorld.ts`'s own `capturingMailer` — a capture cell
  ```
- `features/step-definitions/PasswordWorld.ts:212` — cookieFrom defined 4x: PasswordWorld.ts:212, SessionWorld.ts:189, AdminWorld.ts:182, PasskeyWorld.ts:277.
  ```
  export const cookieFrom = (response: Response): string => {
  ```
- `features/step-definitions/SessionWorld.ts:156` — Duplicate of PasswordWorld.ts:288; letForkedFibersRun duplicated at PasswordWorld.ts:256 / SessionWorld.ts:207; `const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer)` duplicated at Password:40, Session:38, Admin:41, Passkey:126.
  ```
  const STRONG_PASSWORD = "correct horse battery staple";
  ```

**Fix plan:** Extract the shared harness (cookieFrom, STRONG_PASSWORD, capturingMailer factory, TestServices, letForkedFibersRun, request helper, named-actor/session registry) into features/step-definitions/shared/ and import it from every World.

Steps:
1. Create features/step-definitions/shared/Harness.ts exporting `cookieFrom`, `setCookieFrom`, `STRONG_PASSWORD`, `TestServices`, `letForkedFibersRun`, `makeCapturingMailer()` (returns {layer, messages}), and `makeActorRegistry()` (actors, sessions-by-name, currentActor — used by AH-008/BDD-008).
2. Replace the local copies in PasswordWorld.ts, SessionWorld.ts, AdminWorld.ts, PasskeyWorld.ts (and OAuthWorld/SmokeWorld where equivalent helpers exist); keep each World's Layer composition and actor state per-file.
3. Run `pnpm knip` to ensure no now-unused exports remain; `pnpm run typecheck`.

Files: `features/step-definitions/shared/Harness.ts (new)`, `features/step-definitions/PasswordWorld.ts`, `features/step-definitions/SessionWorld.ts`, `features/step-definitions/AdminWorld.ts`, `features/step-definitions/PasskeyWorld.ts`, `features/step-definitions/OAuthWorld.ts`

Tests (write first):
- Pure refactor: `pnpm run test:bdd` stays green with identical scenario counts before/after; add a tiny unit check for cookieFrom (Set-Cookie with attributes → name=value) if desired.

Acceptance:
- `grep -n 'cookieFrom = \|STRONG_PASSWORD = \|letForkedFibersRun = \|const TestServices' features/step-definitions/*World.ts` returns no hits (only shared/Harness.ts defines them).
- `pnpm run test:bdd`, `pnpm run typecheck`, `pnpm knip` pass.

Spec refs: — · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

### Workstream: `bdd-skip-debt`

#### AH-005 (aslak-hellesoy) — Sessions feature is 75% @skip'd — harness cannot observe what the spec demands
`medium` · `testing` · `repo` · [.issues/medium/AH-005-aslak-hellesoy.md](../../.issues/medium/AH-005-aslak-hellesoy.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence high) — canonical for BDD-009

**Evidence at HEAD:**

- `features/features/02-domain/07-sessions.feature:20` — Still skipped; 18 of 24 scenarios in the file carry @skip at HEAD (counted).

  ```
      @skip
      @REQ-EA-136
      Scenario: Issuing a session returns a token composed of a public id and a secret
  ```
- `features/features/02-domain/07-sessions.feature:97` — Time-dependent cluster (REQ-EA-141..146) blocked on World capability, not on product.

  ```
  # force-implemented — the same unverified-TestClock-propagation reason as REQ-EA-141.
  ```
- `features/step-definitions/SessionWorld.ts:42` — World already builds the memory repositories — a row-read handle is one accessor away, as the finding says.

  ```
  const CoreLive = Layer.mergeAll(
    Users.layerMemory,
    Accounts.layerMemory,
    Sessions.layerMemory,
    Verification.layerMemory,
  )
  ```

**Fix plan:** Extend SessionWorld with (a) a repository read handle, (b) a structured-log/span capture, (c) TestClock-driven time control, then un-skip every sessions scenario whose skip rationale is a World-capability gap; keep @skip only for timing side-channel (REQ-EA-157..159) and cookie-browser-behaviour (REQ-EA-156) prunes.

Steps:
1. SessionWorld.ts: build the memory Sessions/Users repositories outside the layer graph (capture-cell pattern of PasswordWorld.capturingMailer, PasswordWorld.ts:86-126) and expose `readSessionRow(id)` / `listSessionRows(userId)` accessors to steps.
2. Add a Logger capture layer (Logger.replace / Logger.layer with an in-memory Ref) and expose `capturedLogs()` so REQ-EA-136..140 'secret never appears in logs' clauses can be asserted.
3. Drive time via TestClock: run the World's HttpRouter handler inside the same scope as `TestClock.adjust` (the REQ-EA-141 rationale is 'unverified TestClock propagation' — prove it with one scenario first: issue, adjust 31 days, request → 401).
4. Un-skip REQ-EA-136..146 and REQ-EA-148 (see SMS-008) in 07-sessions.feature; implement their steps in SessionSteps.ts.
5. Concurrency scenarios REQ-EA-152/153: implement with a Deferred-gated handler (fiber interleaving control) or keep @skip with a rationale that names the unit test covering it; decide per scenario, don't blanket-skip.
6. Replace each surviving skip comment's '.scratch/shipping-gaps ticket NN' pointer with the concrete reason + the unit test that covers it (BDD-009's durability ask).

Files: `features/step-definitions/SessionWorld.ts`, `features/step-definitions/SessionSteps.ts`, `features/features/02-domain/07-sessions.feature`

Tests (write first):
- 07-sessions.feature 'The persisted session row alone never yields the secret' (REQ-EA-137) — un-skip first, red on undefined step, then green via readSessionRow.
- 07-sessions.feature 'A session's absolute expiry is fixed at issuance and unaffected by activity' (REQ-EA-141) — proves TestClock propagation.

Acceptance:
- 07-sessions.feature has <= 5 @skip scenarios (157, 158, 159, 156 and at most one concurrency scenario), each with a non-capability rationale.
- `pnpm run test:bdd` green.

Spec refs: BEH-EA-049, BEH-EA-050, BEH-EA-051, BEH-EA-052, BEH-EA-053, BEH-EA-055, BEH-EA-056 · Effort: **L** · Depends on: —

**Recommended status:** `ready-for-agent`

#### PHS-005 — Rehash-on-login upgrade path has no positive test; @skip'd BDD scenarios claim coverage that does not exist
`medium` · `testing` · `repo` · [.issues/medium/PHS-005-password-hashing-specialist.md](../../.issues/medium/PHS-005-password-hashing-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `features/features/05-authentication-methods/15-password.feature:108` — Skip justification still claims plural rehash tests.

  ```
      # already covered at the domain level by
      # packages/password/test/Password.test.ts's own rehash-on-login tests.
      @skip
      @REQ-EA-313
  ```
- `packages/password/test/Password.test.ts:251` — Only rehash test in packages/password/test is the negative case; grep -i rehash finds no positive signIn-rehash test (ports/test/PasswordHasher.test.ts:77 only tests needsRehash() itself).

  ```
  "BEH-EA-114/116: signIn succeeds with correct credentials and does not spuriously rehash",
  ```

**Fix plan:** Add a positive domain test for BEH-EA-116 rehash-on-login, then un-skip REQ-EA-313/314 via a PasswordWorld credential-hash read handle (or correct the skip text to cite the new test).

Steps:
1. packages/password/test/Password.test.ts: new it.effect — sign up under a PasswordHasher layer with weak params (low memory/iterations), rebuild Password with stronger params sharing the same memory Accounts store, signIn, then `accounts.findCredentialHash(userId)` returns a PHC whose parsed params equal the new config, differs from the old hash, and `hasher.verify(newHash, password)` succeeds.
2. Also assert the downgrade direction does not rehash to weaker params (guards PHS-002 once decided).
3. features/step-definitions/PasswordWorld.ts: expose a stored-credential-hash accessor (capture-cell of the memory Accounts repo) and a way to configure 'previous' vs 'current' hasher params; implement REQ-EA-313/314 steps in PasswordSteps.ts and remove their @skip. REQ-EA-315 (synchronous) can be asserted by reading the hash immediately after the sign-in response.
4. If any of 313-315 remain skipped, rewrite the comment to cite the exact new test name.

Files: `packages/password/test/Password.test.ts`, `features/step-definitions/PasswordWorld.ts`, `features/step-definitions/PasswordSteps.ts`, `features/features/05-authentication-methods/15-password.feature`

Tests (write first):
- Password.test.ts 'BEH-EA-116: signIn against a hash stored under outdated parameters rehashes to current parameters' (write first).
- 15-password.feature REQ-EA-313 'A sign-in against a hash stored under outdated parameters triggers a rehash with current parameters'.

Acceptance:
- New unit test fails if Password.signIn's needsRehash branch is removed.
- No @skip comment in 15-password.feature cites a test that does not exist.

Spec refs: BEH-EA-116 · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### ESS-009 (effect-schema-specialist) — Redacted encode/decode failure pruned from the BDD suite instead of root-caused
`medium` · `testing` · `repo` · [.issues/medium/ESS-009-effect-schema-specialist.md](../../.issues/medium/ESS-009-effect-schema-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `features/features/05-authentication-methods/16-oauth.feature:166` — Still skipped and still not root-caused.

  ```
      # force-implemented — hit a real `Config.Redacted`/`Schema.Redacted`
      # decode failure ("Encoding" schema issue) building a provider Layer
      # from a `process.env`-set var in this harness, not yet root-caused
  ```
- `packages/oauth/src/OAuthProvider.ts:62` — Product path that the skipped scenario guards.

  ```
    readonly clientSecret?: Config.Config<Redacted.Redacted<string>>;
  ```
- `../effect/packages/effect/src/Config.ts:1489` — Effect v4 Config.Redacted is Config.schema over Schema.Redacted — the declared Redacted codec is where an 'Encoding' issue would originate.

  ```
  export function Redacted(name?: string) {
    return schema(Schema.Redacted(Schema.String), name)
  ```

**Fix plan:** Reproduce the Encoding failure in a minimal packages/oauth unit test (Config.Redacted read from an env ConfigProvider inside a provider Layer), fix the root cause (awthaq usage or an upstream Effect v4 issue), then un-skip REQ-EA-346.

Steps:
1. packages/oauth/test/OAuthProvider.test.ts (or new ConfigRedacted.test.ts): build a provider Layer with `clientSecret: Config.Redacted("AUTH_OAUTH_OKTA_CLIENT_SECRET")` under `ConfigProvider.fromEnv({ env: { AUTH_OAUTH_OKTA_CLIENT_SECRET: "s" } })` (or ConfigProvider.fromUnknown) and assert Redacted.value === "s".
2. If it reproduces: bisect between Config.Redacted vs Config.schema(Schema.Redacted(...)) vs Schema.RedactedFromValue; check whether the harness's code path encodes (e.g. a Schema.encode of the provider options/Config for logging) — Schema.Redacted's declared codec disallows/fails encoding. Fix awthaq's usage (no type assertions) or file upstream in ../effect with the minimal repro.
3. If it does not reproduce: the defect is in the step-definition setup (e.g. process.env mutation after ConfigProvider snapshot) — fix OAuthWorld accordingly.
4. Implement REQ-EA-346 steps in OAuthSteps.ts and remove the @skip + comment.

Files: `packages/oauth/test/OAuthProvider.test.ts`, `features/step-definitions/OAuthWorld.ts`, `features/step-definitions/OAuthSteps.ts`, `features/features/05-authentication-methods/16-oauth.feature`

Tests (write first):
- Unit: 'BEH-EA-126: a provider clientSecret read via Config.Redacted from the environment builds the Layer' (write first).
- BDD: 16-oauth.feature REQ-EA-346 'A provider's client secret is read via Config.Redacted inside its own Layer construction'.

Acceptance:
- REQ-EA-346 runs and passes; root cause documented in the commit message (and upstream issue link if Effect-side).

Spec refs: BEH-EA-126 · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### SMS-008 — The only wire-testable BEH-EA-053 scenario is @skip'd, leaving privilege-change rotation unguarded
`low` · `testing` · `repo` · [.issues/low/SMS-008-session-management-specialist.md](../../.issues/low/SMS-008-session-management-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `features/features/02-domain/07-sessions.feature:167` — Still skipped wholesale because of the 'email change' row.

  ```
      @skip
      @REQ-EA-148
      Scenario Outline: A privilege-changing operation issues a new session and deletes the superseded row
  ```
- `features/features/02-domain/07-sessions.feature:177` — No changeEmail endpoint exists in any packages/*/src.

  ```
          | password change |
          | email change    |
  ```
- `packages/password/src/Password.ts:1137` — SMS-001 (the blocker) is resolved by 2761e8d 'Rotate the session on changePassword (BEH-EA-053)' — the password-change row is now implementable and would pass.

  ```
          yield* sessions.revokeOthers(input.userId, input.currentSessionId);
  ```

**Fix plan:** Split the Outline: a plain Scenario for password change (wired, runs now) and keep an @skip'd scenario (or Outline) for email change with an explicit 'no changeEmail capability' rationale.

Steps:
1. In 07-sessions.feature replace the REQ-EA-148 Outline with `Scenario: A password change issues a new session and deletes the superseded row` keeping @REQ-EA-148; add a separate `@skip` scenario for email change and allocate its new REQ id by re-running features/scripts/allocate-req-ea.py (never hand-tag).
2. SessionSteps.ts (or PasswordSteps.ts reuse): 'alice performs a "password change"' → POST /change-password with the s0 cookie; 'a newly minted session replaces s0' → response Set-Cookie differs from s0 and GET /session with it → 200; 's0's row no longer exists' → GET /session with s0 → 401 and (once AH-005's readSessionRow exists) the row is absent.
3. Regenerate features/traceability.md via the allocator.

Files: `features/features/02-domain/07-sessions.feature`, `features/step-definitions/SessionSteps.ts`, `features/step-definitions/SessionWorld.ts`, `features/traceability.md`

Tests (write first):
- 07-sessions.feature 'A password change issues a new session and deletes the superseded row' — red first (undefined step), then green.

Acceptance:
- REQ-EA-148 runs and passes in `pnpm run test:bdd`; reverting 2761e8d's rotation makes it fail.
- `pnpm run spec:verify:strict` green after manifest regeneration.

Spec refs: BEH-EA-053 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### BDD-009 — Sessions acceptance file is 75% @skip — mostly intent, little executable verification
`info` · `testing` · `repo` · [.issues/info/BDD-009-bdd-gherkin-acceptance-testing-specialist.md](../../.issues/info/BDD-009-bdd-gherkin-acceptance-testing-specialist.md) · current: `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **AH-005**

**Evidence at HEAD:**

- `features/features/02-domain/07-sessions.feature:97` — Same 18/24 skip set as AH-005 (aslak-hellesoy).

  ```
  # force-implemented — the same unverified-TestClock-propagation reason as REQ-EA-141.
  ```
- `.scratch/shipping-gaps/issues/01-account-lifecycle-http-gaps.md:1` — Overstated part: the shipping-gap ledger the skip comments cite is already a committed file, not an ephemeral one.

  ```
  (git ls-files lists .scratch/shipping-gaps/issues/*.md — 30 files committed)
  ```

**No separate fix:** Same 18/24 sessions skip set as AH-005 (aslak-hellesoy); its TestClock-through-World ask is step 3 of AH-005's plan. Its 'non-durable ledger' concern is overstated: .scratch/shipping-gaps/issues/*.md is committed.

**Recommended status:** `resolved`

### Workstream: `bdd-feature-wiring`

#### AH-003 (aslak-hellesoy) — Only 6 of 28 feature files are executable; ~15% of the specification runs
`high` · `testing` · `repo` · [.issues/high/AH-003-aslak-hellesoy.md](../../.issues/high/AH-003-aslak-hellesoy.md) · current: `ready-for-agent`

**Verdict:** CONFIRMED (confidence high) — canonical for ETVS-008, TS-005

**Evidence at HEAD:**

- `features/vitest.config.ts:32` — Glob now matches all 28 files because BDD-002 (ba24ce5) added a zero-step placeholder *.steps.test.ts per unwired feature — visibility fixed, execution not.

  ```
  include: ["features/**/*.steps.test.ts"],
  ```
- `features/features/04-cross-cutting/13-events.steps.test.ts:19` — Representative placeholder: registers zero steps. 22 such placeholders exist (00-04 except 07-sessions, 06-*, 07-*, 08-*).

  ```
  describeFeature(feature, Layer.empty, () => {});
  ```
- `features/features/03-http-layer/09-authentication-middleware.feature:7` — 22 of 28 .feature files carry Feature-level @skip @unwired; only smoke, 07-sessions, 15-password, 16-oauth, 17-passkey, 27-admin are wired.

  ```
  @skip @unwired
  ```
- `features (pnpm vitest run at ec065a7)` — Measured at HEAD: 104 of 695 scenario nodes (15%) execute — the audit's ~15% figure still holds.

  ```
  Test Files  6 passed | 22 skipped (28)
       Tests  104 passed | 591 skipped (695)
  ```
- `spec/traceability.md:211` — No wiring-status column exists yet (grep for wired/unwired in spec/traceability.md returns nothing) — decision 36's tracking deliverable is still open.

  ```
  ## 6. Acceptance scenarios (REQ-EA)
  ```

**Fix plan:** Execute decision 36 (.scratch/resolve-ready-for-human-findings/issues/36-bdd-feature-wiring-prioritization.md): wire real step definitions into the 22 @skip @unwired feature files in its 5-tier risk order with the tiered depth policy, and add a per-file wiring-status table to spec/traceability.md §6.

Steps:
1. Add a wiring-status table to spec/traceability.md §6: one row per .feature file with columns File | BEH-EA range | Tier (1-5 per decision 36) | Status (unwired / happy-path / happy+failure / full) | Wired scenarios / total. Seed it from the current state (6 wired, 22 unwired).
2. Tier 1 (happy-path + one failure-mode scenario per Rule): 03-http-layer/09-authentication-middleware, 10-csrf, 11-http-error-mapping, 02-domain/08-verification-tokens, 02-domain/06-users-accounts. Add features/step-definitions/AuthenticationWorld.ts + AuthenticationSteps.ts, CsrfSteps.ts (reuse CsrfTestSupport.ts), HttpErrorSteps.ts, VerificationSteps.ts, UsersAccountsSteps.ts — following SessionWorld/PasswordWorld's buildApp()/HttpRouter pattern; import them in each placeholder <feature>.steps.test.ts and replace Layer.empty/() => {} with the World layer and step registration.
3. For each wired file: remove `@skip @unwired` from the Feature header, replace the pre-implementation banner (see AH-006), and add per-scenario `@skip` + rationale comment only for scenarios the tier does not require yet (so remaining gaps stay visible as skipped nodes).
4. Tier 2 (happy-path per Rule + failure-mode for guard Rules, e.g. INV-EA-012 resolver-failure-never-denies): 06-roles-and-authorization-bridge/19, 20, 21, 18. Add QadiBridgeWorld.ts/QadiBridgeSteps.ts composing @awthaq/qadi + @awthaq/roles with @qadi/core (already a features devDependency); add @awthaq/qadi and @awthaq/roles to features/package.json devDependencies.
5. Tier 3 (happy-path per Rule): 04-cross-cutting/14-rate-limiting, 12-hooks, 13-events (13-events gets deeper coverage per ESS-008).
6. Tier 4 (happy-path per Rule; compile-time Rules may be asserted via a type-level fixture or kept @skip with an explicit 'compiler-enforced, INV-EA-00x' rationale): 01-contract-and-persistence/04, 05; 00-foundations/01, 02, 03.
7. Tier 5 (happy-path per Rule): 07-client-integration/22, 23, 24; 08-tooling/25, 26.
8. After each tier: update the §6 wiring-status table and run the full gate.

Files: `features/features/**/<NN>-*.steps.test.ts (22 placeholders)`, `features/features/**/<NN>-*.feature (remove @skip @unwired, banner)`, `features/step-definitions/AuthenticationWorld.ts (new)`, `features/step-definitions/AuthenticationSteps.ts (new)`, `features/step-definitions/CsrfSteps.ts (new)`, `features/step-definitions/HttpErrorSteps.ts (new)`, `features/step-definitions/VerificationSteps.ts (new)`, `features/step-definitions/UsersAccountsSteps.ts (new)`, `features/step-definitions/QadiBridgeWorld.ts (new)`, `features/step-definitions/QadiBridgeSteps.ts (new)`, `features/step-definitions/EventsWorld.ts (new)`, `features/step-definitions/RateLimitSteps.ts (new)`, `features/step-definitions/HooksSteps.ts (new)`, `features/package.json`, `spec/traceability.md`

Tests (write first):
- Per file, TDD: remove @skip @unwired first and run `pnpm --filter @awthaq/features test -- <file>` — every scenario fails as 'undefined step' (red); implement steps until green.
- Tier 1 failure-mode examples: 10-csrf 'A rejected CSRF check fails with a typed CsrfRejected error at 403'; 09-authentication-middleware 'no scheme succeeds under required authentication' → 401.

Acceptance:
- `grep -rl '@unwired' features/features --include=*.feature` returns nothing (or only files explicitly deferred with a §6 row explaining why).
- `pnpm run test:bdd` reports >= 1 passed scenario per Rule for every Tier 3-5 file, and >= 2 (happy + failure) per Rule for Tier 1 files.
- spec/traceability.md §6 has a wiring-status row for all 28 files and it matches the suite.
- `pnpm check` green.

Spec refs: BEH-EA-001..BEH-EA-208 (acceptance coverage only; no behavior change), BEH-EA-193..BEH-EA-200 · Effort: **XL** · Depends on: —

**Recommended status:** `ready-for-agent`

#### OCM-004 — M2M BDD acceptance (REQ-EA-199) has no step definitions — the machine path is unexecuted prose
`medium` · `testing` · `repo` · [.issues/medium/OCM-004-oauth2-client-credentials-m2m-specialist.md](../../.issues/medium/OCM-004-oauth2-client-credentials-m2m-specialist.md) · current: `needs-triage`

**Verdict:** PARTIAL (confidence high)

**Evidence at HEAD:**

- `features/features/03-http-layer/09-authentication-middleware.feature:136` — Holds: still no step definitions (Feature is @skip @unwired at line 7).

  ```
  @REQ-EA-199
      Scenario: A machine-to-machine group under ApiKeyAuthentication resolves a ServicePrincipal
        Given a group "machine" carrying "ApiKeyAuthentication"
  ```
- `packages/api-key/src/index.ts:8` — Holds: the middleware the scenario needs is unimplemented — REQ-EA-199/201 are blocked on OCM-001/SCP-002 (wayfinder decision 10: api-key plugin).

  ```
  // Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
  
  export {};
  ```
- `features/features/03-http-layer/09-authentication-middleware.feature:7` — Fixed part: the 'dashboard reads REQ-EA-199 as verified' concern is closed — BDD-002 (ba24ce5) makes every scenario of this file report as skipped, never passing.

  ```
  @skip @unwired
  ```

**Fix plan:** Wire 09-authentication-middleware.feature as AH-003 Tier 1 now (all Rules except the ApiKey scenarios), keep REQ-EA-199/201 explicitly @skip'd as 'blocked by api-key plugin (OCM-001)', and wire them when packages/api-key ships ApiKeyAuthentication.

Steps:
1. As part of AH-003 Tier 1, add AuthenticationWorld/AuthenticationSteps covering REQ-EA-183..203 for cookie + bearer strategies (server/src/Authentication.ts chain).
2. Put scenario-level `@skip` on REQ-EA-199 and REQ-EA-201 with a comment `# blocked: ApiKeyAuthentication ships with packages/api-key (OCM-001 / wayfinder 10)`; record them as 'blocked' in the spec/traceability.md §6 wiring table.
3. When OCM-001 lands: add steps for 'a group carrying ApiKeyAuthentication', 'a request presents a valid x-api-key header', 'resolves to a ServicePrincipal' (assert Principal._tag === "Service" from packages/api/src/Api.ts:31) and un-skip both scenarios.

Files: `features/step-definitions/AuthenticationWorld.ts (new)`, `features/step-definitions/AuthenticationSteps.ts (new)`, `features/features/03-http-layer/09-authentication-middleware.steps.test.ts`, `features/features/03-http-layer/09-authentication-middleware.feature`, `spec/traceability.md`

Tests (write first):
- 09-authentication-middleware.feature 'An application group under Authentication resolves the ordinary Principal union' (REQ-EA-200) — first, green now.
- REQ-EA-199 'A machine-to-machine group under ApiKeyAuthentication resolves a ServicePrincipal' — after OCM-001.

Acceptance:
- 09-authentication-middleware.feature no longer @unwired; only REQ-EA-199/201 skipped, each with a 'blocked: OCM-001' rationale.
- After OCM-001: all 19 scenarios run.

Spec refs: BEH-EA-065..BEH-EA-072, BEH-EA-071 · Effort: **M** · Depends on: AH-003, OCM-001, SCP-002

**Recommended status:** `ready-for-agent`

#### ESS-008 (effect-stream-specialist) — 13-events.feature's stream-behavior scenarios have no step definitions — the tests that would catch ESS-001 are unwired
`medium` · `testing` · `repo` · [.issues/medium/ESS-008-effect-stream-specialist.md](../../.issues/medium/ESS-008-effect-stream-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `features/features/04-cross-cutting/13-events.feature:7` — Whole events feature is unwired.

  ```
  @skip @unwired
  ```
- `features/features/04-cross-cutting/13-events.feature:30` — The structural scenarios the finding names are still prose.

  ```
    Rule: A publisher never awaits its subscribers
  
      @REQ-EA-261
      Scenario: Publishing an event returns without waiting for any subscriber to finish handling it
  ```
- `packages/core/src/AuthEvents.ts:363` — Blockers are gone: ESS-001 (non-suspending publish, 4b48cb2) and ESS-002 (durable AuditLog written inline, 6bd3f1d) are resolved, so these scenarios are now wireable and should pass.

  ```
  const pubsub = yield* PubSub.dropping<AuthEvent>(CAPACITY);
  ```

**Fix plan:** Wire 13-events.feature fully (all 8 Rules, not just decision 36's Tier-3 happy path) with an EventsWorld that exposes a controllably slow subscriber, a capacity probe, AuditLog reads and a log capture.

Steps:
1. Create features/step-definitions/EventsWorld.ts: compose AuthEvents.layer + AuditLog.layerMemory (+ a Logger capture layer, reuse the capture-cell pattern of PasswordWorld.capturingMailer) and expose helpers: publish(event), subscribeSlow(latch) via AuthEvents.on, auditRecords(), capturedLogs().
2. Create features/step-definitions/EventsSteps.ts implementing the steps of the 8 Rules (BEH-EA-097..104): bounded PubSub/capacity (publish CAPACITY+N with a stalled subscriber, assert publish returns and memory bound = dropping), publisher-never-awaits (publish completes while subscriber's Deferred is unresolved), fork isolation (dying subscriber does not affect publisher/peer), durable audit record (AuditLog contains the record with no subscriber), registry tags, raw stream, on(tag) sugar, observer-error log name `auth.event.observer.error`.
3. Fill features/features/04-cross-cutting/13-events.steps.test.ts with the World + steps; remove `@skip @unwired` and the pre-implementation banner from 13-events.feature; per-scenario @skip + rationale only where genuinely non-deterministic.
4. Update spec/traceability.md §6 wiring-status row (Tier 3, status full).

Files: `features/step-definitions/EventsWorld.ts (new)`, `features/step-definitions/EventsSteps.ts (new)`, `features/features/04-cross-cutting/13-events.steps.test.ts`, `features/features/04-cross-cutting/13-events.feature`, `spec/traceability.md`

Tests (write first):
- 13-events.feature 'Publishing an event returns without waiting for any subscriber to finish handling it' — write first (red: undefined steps), then green.
- 13-events.feature 'The audit record does not depend on any AuthEvents subscriber being present, running, or succeeding'.

Acceptance:
- 13-events.feature has no Feature-level @skip/@unwired and >= 17 of 19 scenarios pass in `pnpm run test:bdd`.
- Reverting 4b48cb2's PubSub.dropping to PubSub.bounded makes the publisher-never-awaits scenario fail (mutation check, done once locally).

Spec refs: BEH-EA-097, BEH-EA-098, BEH-EA-099, BEH-EA-100, BEH-EA-101, BEH-EA-102, BEH-EA-103, BEH-EA-104 · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### THS-006 — BEH-EA-110 default rate-limit rule for /two-factor/verify exists only in spec, BDD, and a fake-plugin fixture
`medium` · `compliance` · `repo` · [.issues/medium/THS-006-totp-hotp-mfa-specialist.md](../../.issues/medium/THS-006-totp-hotp-mfa-specialist.md) · current: `needs-triage`

**Verdict:** DUPLICATE (confidence medium) — duplicate of **THS-001**

**Evidence at HEAD:**

- `packages/two-factor/src/index.ts:8` — Root cause is the unbuilt two-factor plugin (THS-001, ready-for-agent).

  ```
  // Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
  
  export {};
  ```
- `.scratch/resolve-ready-for-human-findings/issues/05-mfa-two-factor-subsystem.md:40` — Resolved decision already scopes this rule into the TwoFactor build-out.

  ```
  - **Rate limiting**: `/two-factor/verify` limited to 3 attempts per 10 s per `challengeId`, reusing whatever rate-limit rule registry the password plugin's own `RATE_LIMITS` convention already establishes
  ```
- `spec/behaviors/14-rate-limiting.md:127` — Carry-over for THS-001: spec snippet keys on "principal" while decision 05 keys on challengeId (the endpoint is pre-session) — reconcile the BEH-EA-110 snippet when THS-001 lands.

  ```
  AuthRateLimits.rule({ group: "two-factor", endpoint: "verify", key: "principal", limit: 3, window: "10 seconds" })
  ```
- `features/features/04-cross-cutting/14-rate-limiting.feature:174` — Unwired (file @skip @unwired).

  ```
  Then "/two-factor/verify" is rate limited to 3 attempts per 10 seconds by a rule the plugin itself ships
  ```

**No separate fix:** Root cause is the empty @awthaq/two-factor placeholder; THS-001's build-out (resolved decision 05, line 40) already includes the 3/10s `/two-factor/verify` rule keyed per challengeId. THS-001's implementer must also: register the rule via the password plugin's RATE_LIMITS/RateLimitsRegistry pattern, reconcile BEH-EA-110's `key: "principal"` snippet, and wire REQ-EA-297 in 14-rate-limiting.feature.

**Recommended status:** `resolved`

#### TS-005 (torin-sandall) — 94 authorization-bridge BDD scenarios have no executable step definitions
`medium` · `testing` · `repo` · [.issues/medium/TS-005-torin-sandall.md](../../.issues/medium/TS-005-torin-sandall.md) · current: `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **AH-003**

**Evidence at HEAD:**

- `features/features/06-roles-and-authorization-bridge/19-qadi-bridge-path-a.feature:7` — Files 18-21 all carry Feature-level @skip @unwired — the 'mark the group non-executable' half of the fix landed via BDD-002 (ba24ce5).

  ```
  @skip @unwired
  ```
- `features/features/06-roles-and-authorization-bridge/19-qadi-bridge-path-a.steps.test.ts:21` — Zero qadi steps registered — exactly AH-003's Tier 2 (decision 36 items 6-9).

  ```
  describeFeature(feature, Layer.empty, () => {});
  ```

**No separate fix:** Files 18-21 are AH-003 Tier 2 exactly; the 'mark non-executable' ask landed via BDD-002's @skip @unwired. Its quoted stale banner is handled by AH-006.

**Recommended status:** `resolved`

#### ETVS-008 — BDD↔unit layering exemplary where wired, but 21 of 27 feature files never execute
`low` · `testing` · `repo` · [.issues/low/ETVS-008-effect-testing-vitest-specialist.md](../../.issues/low/ETVS-008-effect-testing-vitest-specialist.md) · current: `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **AH-003**

**Evidence at HEAD:**

- `features/vitest.config.ts:20` — The CI-visibility half of the recommended fix landed in ba24ce5 (BDD-002): unwired scenarios now report as skipped nodes.

  ```
  // BDD-002 (.issues/high): every .feature file now has a matching
  // *.steps.test.ts, so `include` above genuinely covers the whole suite —
  ```
- `features/features/08-tooling/25-testing-harness.feature:181` — Still unwired (file is @skip @unwired) — same root cause as AH-003.

  ```
  @REQ-EA-566
      Scenario: runPluginContractTests fails when a Redacted value reaches a span or event the plugin emits
  ```

**No separate fix:** Same root cause as AH-003 (unwired feature files); its CI-visibility ask landed via BDD-002 (ba24ce5); the remaining wiring (incl. 25-testing-harness REQ-EA-566) is AH-003 Tier 5.

**Recommended status:** `resolved`

### Workstream: `bdd-organization-feature`

#### MTI-011 — No adversarial cross-tenant test suite; the BDD suite has no organization feature at all
`low` · `testing` · `repo` · [.issues/low/MTI-011-multi-tenant-isolation-specialist.md](../../.issues/low/MTI-011-multi-tenant-isolation-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence high) — canonical for CWM-006

**Evidence at HEAD:**

- `features/README.md:9` — Still no organization feature; spec/behaviors/ ends at 27-admin-impersonation.md (no organization behavior file either, though spec/models/14-organization.md exists).

  ```
  One `.feature` file per `spec/behaviors/NN-*.md` file (27 total), grouped into 10 directories
  ```
- `packages/organization/test` — Only per-method unit tests; no suite composes two tenants and attempts every read/write across the boundary.

  ```
  ActiveContextRecords.test.ts  AuthHttp.test.ts  InvitationRecords.test.ts  MembershipRecords.test.ts  OrgRoleRecords.test.ts  Organization.test.ts ...
  ```

**Fix plan:** Author spec/behaviors/28-organization.md (BEH-EA-221..228) from spec/models/14-organization.md, a matching 10-organization/28-organization.feature covering lifecycle (owner invariant, invitation expire/re-invite/cancel, limits, DAC escalation guard, active context) plus an adversarial cross-tenant Rule, and wire it with OrganizationWorld/OrganizationSteps.

Steps:
1. spec/behaviors/28-organization.md: 8 BEH-EA ids (221-228) mirroring the admin precedent (models/15 → behaviors/27): owner invariant, invitation lifecycle, membership/team limits, dynamic-role DAC escalation guard, active-organization context, organization-scoped reads are tenant-filtered (cross-tenant isolation), hooks/events, erasure cascade. Register them in spec/behaviors/index.yaml and spec/traceability.md §1/§6.
2. features/features/10-organization/28-organization.feature: one Rule per BEH-EA; the isolation Rule contains adversarial scenarios — tenant-A principal against every tenant-B endpoint of the organization HTTP group (list members, get invitation, update role, create team, set active org) asserting 403/404/empty, and 'an impersonating admin sees only the target user's organizations'.
3. Add the file to features/scripts/allocate-req-ea.py ORDER and run it to allocate REQ ids; regenerate features/traceability.md.
4. features/step-definitions/OrganizationWorld.ts (+ OrganizationSteps.ts) composing @awthaq/organization's HTTP group via the SessionWorld buildApp pattern; add @awthaq/organization to features/package.json.
5. Add features/features/10-organization/28-organization.steps.test.ts; update features/README.md directory table.
6. Optionally (flexibility-over-complexity): parametrize the isolation Rule's World over memory and SQL-backed layers once a SQLite test layer exists in features.

Files: `spec/behaviors/28-organization.md (new)`, `spec/behaviors/index.yaml`, `spec/traceability.md`, `features/features/10-organization/28-organization.feature (new)`, `features/features/10-organization/28-organization.steps.test.ts (new)`, `features/step-definitions/OrganizationWorld.ts (new)`, `features/step-definitions/OrganizationSteps.ts (new)`, `features/scripts/allocate-req-ea.py`, `features/traceability.md`, `features/package.json`, `features/README.md`

Tests (write first):
- 28-organization.feature 'A member of organization A cannot list organization B's members' — write first.
- 28-organization.feature 'The last owner cannot leave or be demoted'.

Acceptance:
- 28-organization.feature runs in `pnpm run test:bdd` with every isolation scenario passing; `pnpm run spec:verify:strict` green with BEH-EA-221..228 traced.

Spec refs: BEH-EA-221..BEH-EA-228 (new), BEH-EA-162, BEH-EA-209..BEH-EA-220 · Effort: **L** · Depends on: —

**Recommended status:** `ready-for-agent`

#### CWM-006 — Organization plugin has no BDD feature file — the deepest plugin's lifecycle contract is specified only by unit tests and code
`low` · `testing` · `repo` · [.issues/low/CWM-006-clerk-workos-migration-specialist.md](../../.issues/low/CWM-006-clerk-workos-migration-specialist.md) · current: `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **MTI-011**

**Evidence at HEAD:**

- `features/traceability.md:474` — Organization still appears only via qadi resolver obligations; no organization .feature under features/features/ (find returns none).

  ```
  | REQ-EA-454 | [BEH-EA-162](../spec/behaviors/21-qadi-resolvers-obligations.md#beh-ea-162-relationships-resolved-from-organization-membership)
  ```

**No separate fix:** Same missing organization spec+feature as MTI-011; MTI-011's plan includes the lifecycle Rules CWM-006 lists (owner invariant, invitation expiry/re-invite/cancel, limits, DAC escalation guard, active context).

**Recommended status:** `resolved`

### Workstream: `examples-memory-server`

#### DESS-002 — Memory example cannot complete a sign-in: verification token is unrecoverable
`medium` · `dx` · `repo` · [.issues/medium/DESS-002-developer-experience-sdk-specialist.md](../../.issues/medium/DESS-002-developer-experience-sdk-specialist.md)

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `examples/memory-server/README.md:27` — Unchanged at HEAD.

```
# -> 403 EmailNotVerified — signIn hard-blocks until the mailed token is
#    consumed via POST /verify-email (the memory Mailer just drops the
#    mail; there is no console-log stand-in wired into this example)
```

- `packages/test/src/TestAuth.ts:94` — TestAuth hardwires Mailer.layerMemory; the example never reads `sent`.

```
const MemoryPorts = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  Sessions.layerMemory,
  Mailer.layerMemory,
  RateLimiter.layerPermissive,
```

- `packages/password/src/Password.ts:783` — The token lives only in the mail's `data.token`.

```
            yield* mailer.send({
              to: user.email,
              template: "verify-email",
              data: { token: encodeVerificationToken(identifier, value) },
            });
```

- `packages/password/src/Password.ts:841` — Sign-in hard-blocks unverified users.

```
        if (!user.emailVerified) {
          ...
          return yield* Effect.fail(new PasswordApi.EmailNotVerified());
```

**Fix plan:** Ship a dev `Mailer.layerConsole` in @awthaq/ports (logs recipient/template/data incl. the token via Effect.logInfo, and records for `sent`), wire it into the memory example through TestAuth.layer's middleware slot, and extend the example README walkthrough with the verify-email step.

Steps:
1. packages/ports/src/Mailer.ts — add `export const layerConsole = Layer.effect(Mailer, ...)`: Ref-backed like layerMemory, and `send` also does `Effect.logInfo("awthaq mail").pipe(Effect.annotateLogs({ to, template, ...data }))`. Doc comment: dev only — logs verification/reset tokens, never use in production.
2. examples/memory-server/index.ts — add Mailer.layerConsole to the `middleware` merge at line 96 (it is provided before MemoryPorts, so the plugin's make resolves it first — the same mechanism PasswordExtras relies on). Confirm with the smoke test below; if TestAuth's MemoryPorts still wins, add a `mailer` option to TestAuth.layer instead.
3. examples/memory-server/README.md — replace lines 27-29 with: sign-up → copy the token from the `awthaq mail template=verify-email` log line → `curl -X POST localhost:3001/verify-email -d '{"token":"..."}'` → sign-in returns 200. Include whatever CSRF header/Origin the mutating endpoints require.
4. Update the example's header comment (index.ts:44-53) to mention the console mailer.

Files: `packages/ports/src/Mailer.ts`, `packages/ports/test/Mailer.test.ts`, `examples/memory-server/index.ts`, `examples/memory-server/README.md`

Tests (write first):
- packages/ports/test/Mailer.test.ts — 'layerConsole logs recipient, template and data and records the message for sent' (test Logger capturing annotations).
- Example smoke (new examples/memory-server/test/walkthrough.test.ts using HttpRouter.toWebHandler over the same AppLayer, or a manual script): sign-up → read token from Mailer.sent → POST /verify-email → POST /password/sign-in returns 200.

Acceptance:
- Following examples/memory-server/README.md verbatim ends in a successful sign-in.
- Mailer.layerConsole exported, tested, and documented as dev-only.

Spec refs: BEH-EA-113, BEH-EA-193 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### CSD-010 — The only runnable example composes a permissive limiter — out-of-the-box showcase has throttling off
`low` · `dx` · `repo` · [.issues/low/CSD-010-credential-stuffing-defense-specialist.md](../../.issues/low/CSD-010-credential-stuffing-defense-specialist.md)

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `examples/memory-server/index.ts:46` — Example inherits TestAuth's permissive limiter.

```
//    own bundled memory ports (`Users`/`Accounts`/`Sessions`/`Mailer`/a
//    permissive rate limiter) are deliberately lean
```

- `packages/test/src/TestAuth.ts:99` — BEH-EA-112 never-rejects limiter hardwired.

```
  RateLimiter.layerPermissive,
```

- `examples/memory-server/index.ts:51` — Breach checking off.

```
//    `AuthEvents`/`HttpClient` (the breach-check transport, unused since
//    `breachCheck` defaults `false`, but still a required service)
```

- `README.md:139` — The README's 'real' quickstart also ships permissive limiting.

```
    Layer.mergeAll(PasswordHasher.layerArgon2id, consoleMailer, RateLimiter.layerPermissive).pipe(
```

- `packages/ports/src/RateLimiter.ts:86` — Enforcing limiter + layerStoreMemory (line 111) exist.

```
export const layer: Layer.Layer<RateLimiter, never, RateLimiterStore> = Layer.effect(
```

**Fix plan:** Compose the enforcing `RateLimiter.layer` over `RateLimiter.layerStoreMemory` and `Password.config({ breachCheck: { onUnavailable: "allow" } })` in both runnable compositions (memory example and the README/sql-server example), with a comment on swapping the store for production.

Steps:
1. examples/memory-server/index.ts — add `RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))` and `Password.config({ breachCheck: { onUnavailable: "allow" } })` to the middleware merge (line 96); rewrite the header comment (lines 44-53) accordingly. If TestAuth's MemoryPorts permissive limiter still wins, add an option to TestAuth.layer to override the limiter (keep permissive as TestAuth's default for tests, BEH-EA-193).
2. examples/sql-server/index.ts (SMS-006) and README.md:139/216 — use the enforcing limiter; README Configuration row for RateLimiter becomes 'layer over layerStoreMemory (single process) — swap the store for a shared one in multi-instance deployments'.
3. Example README: note the demo now returns 429 after the Password sign-in rule's limit.

Files: `examples/memory-server/index.ts`, `examples/memory-server/README.md`, `examples/sql-server/index.ts`, `README.md`, `packages/test/src/TestAuth.ts (only if an override option is needed)`

Tests (write first):
- Example smoke: N+1 wrong-password sign-ins (N = RATE_LIMITS.signIn.limit in packages/password/src/Password.ts) → the last returns 429.
- If TestAuth gains an override option: packages/test/test/TestAuth.test.ts 'rateLimiter override replaces the permissive default'.

Acceptance:
- Neither runnable composition uses RateLimiter.layerPermissive.
- Breach checking is enabled (allow posture) in the showcase.
- TestAuth's default for tests remains permissive.

Spec refs: BEH-EA-112, BEH-EA-193 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

### Workstream: `readme-docs-accuracy`

#### DTWS-003 — Root README lists @awthaq/next as a stub package; it has a real implementation
`medium` · `dx` · `repo` · [.issues/medium/DTWS-003-documentation-technical-writing-specialist.md](../../.issues/medium/DTWS-003-documentation-technical-writing-specialist.md)

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `README.md:232` — Stale claim still present at HEAD.

```
`two-factor`, `magic-link`, `api-key`, `cli`, and `next` remain stub packages — see [`.scratch/shipping-gaps/map.md`](.scratch/shipping-gaps/map.md)'s "Out of scope" section
```

- `packages/next/src/GetSession.ts:5` — packages/next/src has CookieHeader.ts, GetSession.ts, HasSessionCookie.ts, WithNextCookies.ts, index.ts (358 LOC); two-factor/magic-link/api-key/cli are still 10-line index.ts stubs.

```
// The real, database-verified boundary: called from a React Server
// Component or a server action, it resolves the incoming request's session
// cookie against `@awthaq/core`'s `Sessions` service and returns the
// principal, user, and session
```

- `.scratch/shipping-gaps/map.md:137` — Same stale claim in the shipping-gaps map (CWM-007's second citation).

```
  `jwt`) are no longer stubs as of this charting round anyway; the
  remainder (`api-key`, `two-factor`, `magic-link`, `next`, `cli`) stay
```

**Fix plan:** Correct the README's plugin/package inventory: remove `next` from the stub list, add a row describing what @awthaq/next ships, and fix the same claim in .scratch/shipping-gaps/map.md.

Steps:
1. README.md:232 — change the stub list to `two-factor`, `magic-link`, `api-key`, `cli` (re-verify each is still a 10-line `export {}` index.ts at implementation time).
2. README.md Plugins section — add an 'Integrations' sub-table (not a plugin row; next is not an AuthPlugin) with `@awthaq/next`: getSession (DB-verified session resolution, BEH-EA-185), hasSessionCookie (presence-only proxy check), withNextCookies (cookie bridging, BEH-EA-189); note what is still missing (route middleware, client provider glue).
3. .scratch/shipping-gaps/map.md:132-138 — update the parenthetical so `next` is listed among the no-longer-stubs.
4. Fold with DTWS-004's repo-map rewrite (same README table rows) so the inventory is edited once.

Files: `README.md`, `.scratch/shipping-gaps/map.md`

Tests (write first):
- No code test; verification = `grep -n 'remain stub packages' README.md` lists only api-key/cli/magic-link/two-factor, and `for p in api-key cli magic-link two-factor; do wc -l packages/$p/src/*.ts; done` confirms each is still a stub.

Acceptance:
- README.md no longer calls `next` a stub package.
- README names @awthaq/next's shipped exports (getSession, hasSessionCookie, withNextCookies).
- .scratch/shipping-gaps/map.md no longer lists `next` among the remaining stubs.

Spec refs: BEH-EA-185, BEH-EA-189 · Effort: **S** · Depends on: — · Also closes: CWM-007

**Recommended status:** `ready-for-agent`

#### DTWS-004 — Implemented @awthaq/roles plugin is absent from the root README's repo map, plugin table, and composition comment
`medium` · `docs` · `repo` · [.issues/medium/DTWS-004-documentation-technical-writing-specialist.md](../../.issues/medium/DTWS-004-documentation-technical-writing-specialist.md)

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `README.md:26` — Repo map omits roles — and also omits client, react, qadi, migrate-auth0, migrate-better-auth (all present under packages/).

```
and one package per plugin (`password`, `oauth`, `organization`, `admin`, `passkey`, `jwt`, plus stub packages not yet built out
```

- `README.md:69` — Composition comment omits Roles.

```
//    `[Password, OAuth, Organization, Admin, Passkey, Jwt]` unchanged.
```

- `README.md:223` — Plugins table (README.md:223-230) has no Roles row.

```
| Plugin | Package | What it adds |
|---|---|---|
| Password | `@awthaq/password` | ...
| Jwt | `@awthaq/jwt` | JWT issuance/verification for stateless callers |
```

- `packages/roles/src/Roles.ts:209` — Real plugin; header (Roles.ts:26-32) documents a shipped layerSql (BAM-006) — so the issue's 'layerMemory-only' caveat is itself outdated.

```
export class Roles extends AuthPlugin.Service<Roles, RolesShape>()("roles", {
```

**Fix plan:** Bring the README's package inventory in line with packages/: add Roles to the repo map, plugin table and composition comment, and list the other unlisted packages (client, react, qadi, migrate-auth0, migrate-better-auth).

Steps:
1. README.md:26 — rewrite the packages/ row: core strata (core, api, server, sql, ports, qadi), plugins (password, oauth, organization, admin, passkey, jwt, roles), client/integration packages (client, react, next), migration tooling (migrate-auth0, migrate-better-auth), test harness (test), and stubs (api-key, cli, magic-link, two-factor). Derive the list with `ls packages` at implementation time.
2. README.md:223-230 — add row `| Roles | @awthaq/roles | Role assignment flattened through qadi's role DAG into AuthSubject roles/permissions (overrides qadi's SubjectResolver slot); layerMemory and layerSql persistence |`. Do NOT copy the issue's 'memory-only' caveat — Roles.ts:26-32 documents layerSql.
3. README.md:69 — change the comment tuple to `[Password, OAuth, Organization, Admin, Passkey, Jwt, Roles]` (verify Roles' dependsOn at implementation time; if it requires another plugin, say so).
4. Coordinate with DTWS-003 (same table region) — one edit pass.

Files: `README.md`

Tests (write first):
- Doc-only; verification script: `for p in $(ls packages); do grep -q "$p" README.md || echo MISSING $p; done` prints nothing.

Acceptance:
- Every directory under packages/ is named at least once in README.md.
- Plugins table contains a Roles row that matches Roles.ts (no stale memory-only caveat).
- README.md:69's composition comment includes Roles.

Spec refs: BEH-EA-137, BEH-EA-138 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### NHS-009 — OpenAPI/Scalar docs served unauthenticated in the canonical composition
`low` · `security` · `repo` · [.issues/low/NHS-009-node-http-server-integration-specialist.md](../../.issues/low/NHS-009-node-http-server-integration-specialist.md)

**Verdict:** CONFIRMED (confidence: medium)

**Evidence at HEAD:**

- `README.md:128` — Unconditional docs + /openapi.json in the 'production' quickstart; nothing marks it dev-only.

```
const AppLayer = Layer.mergeAll(
  AuthHttp.routes(auth.api, { openapiPath: "/openapi.json" }).pipe(Layer.provide(auth.layer)),
  ...
  AuthHttp.docs(auth.api),
```

- `packages/server/src/AuthHttp.ts:32` — docs is a plain re-export — gating is the composition's job.

```
export const docs: typeof HttpApiScalar.layer = HttpApiScalar.layer;
```

- `spec/behaviors/11-http-error-mapping.md:72` — Serving docs is specified behavior (and `awthaq openapi`, BEH-EA-205, is the offline alternative), so the defect is the quickstart's framing, not the library.

```
## BEH-EA-084: `AuthHttp.docs` serves generated OpenAPI/Scalar documentation from the same contract
```

**Fix plan:** Keep AuthHttp.docs as specified (BEH-EA-084) but make the quickstart/example gate it behind a Config flag defaulting off, and document that production compositions should omit it or put it behind their own auth.

Steps:
1. In examples/sql-server/index.ts (SMS-006) compose docs as `Layer.unwrap(Effect.map(Config.Boolean("AWTHAQ_EXPOSE_DOCS").pipe(Config.withDefault(false)), (expose) => expose ? AuthHttp.docs(auth.api) : Layer.empty))` (check Config.Boolean/Config.withDefault spelling in ../effect/packages/effect/src/Config.ts) and likewise make `openapiPath` conditional.
2. README: one paragraph under Configuration — 'OpenAPI/Scalar docs: enabled only when AWTHAQ_EXPOSE_DOCS=true; production deployments should omit AuthHttp.docs or mount it behind an admin-only router; `awthaq openapi` (BEH-EA-205) exports the document offline.'
3. Add the same one-line caution to AuthHttp.docs's doc comment (packages/server/src/AuthHttp.ts:28).

Files: `examples/sql-server/index.ts`, `README.md`, `packages/server/src/AuthHttp.ts`

Tests (write first):
- Smoke in the example: with AWTHAQ_EXPOSE_DOCS unset, GET /openapi.json and GET /docs return 404; with it =true they return 200. (Optional unit test in packages/server/test/AuthHttp.test.ts isn't needed — the library behavior is unchanged.)

Acceptance:
- Quickstart/example serves no docs by default.
- README documents the production posture for AuthHttp.docs.

Spec refs: BEH-EA-084, BEH-EA-205 · Effort: **S** · Depends on: SMS-006

**Recommended status:** `ready-for-agent`

#### DESS-008 — Quickstart offers no zero-database path and does not mention the runnable example
`low` · `docs` · `repo` · [.issues/low/DESS-008-developer-experience-sdk-specialist.md](../../.issues/low/DESS-008-developer-experience-sdk-specialist.md)

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `README.md:170` — Only run path in README requires Postgres + key.

```
export DATABASE_URL="postgres://user:pass@localhost:5432/awthaq"
export AWTHAQ_ENCRYPTION_KEY="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))")"
node --experimental-strip-types server.ts
```

- `README.md` — `grep -c 'memory-server\|examples/' README.md` = 0 at HEAD.

```
(no occurrence of `memory-server` or `examples/` anywhere in README.md)
```

- `examples/memory-server/README.md:9` — The zero-config path exists but is not linked.

```
No `DATABASE_URL`, no migration run, no `AWTHAQ_ENCRYPTION_KEY`. Just:
```

**Fix plan:** Add a 'No database handy?' callout at the top of the Quickstart pointing to examples/memory-server (and to examples/sql-server's SQLite default from SEA-007/SMS-006), once DESS-002 makes the example's sign-in completable.

Steps:
1. README.md Quickstart intro (~line 36) — callout: 'Zero-setup: `pnpm install && pnpm --filter @awthaq/example-memory-server start` → a Password + Organization server on :3001 (memory backend, no env vars). For a real SQL backend without Postgres, run examples/sql-server with no DATABASE_URL (SQLite file).'
2. Add an 'Examples' row to the repository map table (README.md ~line 26-31) listing examples/memory-server and examples/sql-server.

Files: `README.md`

Tests (write first):
- Doc-only; manual: follow the callout from a fresh clone and complete sign-up → verify-email → sign-in against :3001.

Acceptance:
- README.md links examples/memory-server from the Quickstart and repo map.
- The linked path completes a sign-in (DESS-002 landed).

Spec refs: — · Effort: **S** · Depends on: DESS-002

**Recommended status:** `ready-for-agent`

#### IC-010 — First real run requires hand-generating a base64 32-byte key; no dev auto-generation
`low` · `dx` · `repo` · [.issues/low/IC-010-iain-collins.md](../../.issues/low/IC-010-iain-collins.md)

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `README.md:171` — Still required by hand.

```
export AWTHAQ_ENCRYPTION_KEY="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))")"
```

- `packages/ports/src/KeyProvider.ts:74` — layerEnv is the only KeyProvider layer (grep `^export const` in KeyProvider.ts); no dev/ephemeral variant.

```
export const layerEnv: Layer.Layer<KeyProvider, Config.ConfigError> = Layer.effect(
  KeyProvider,
  Effect.gen(function* () {
    ...
    const encoded = yield* Config.Redacted("AWTHAQ_ENCRYPTION_KEY");
```

**Fix plan:** Add an explicit, opt-in `KeyProvider.layerEphemeral` (random 32-byte key generated at layer build, loud warning that ciphertext won't survive a restart) for dev/examples; keep layerEnv as the production path. Do not silently auto-fallback from layerEnv (that would lose encrypted data in a misconfigured prod).

Steps:
1. packages/ports/src/KeyProvider.ts — add `export const layerEphemeral = Layer.effect(KeyProvider, Effect.gen(function* () { ... }))` (no return-type annotation) generating 32 bytes via the platform Crypto service already used by PasswordHasher.layerArgon2id (check the randomBytes API on effect's Crypto in ../effect) — kid `"ephemeral"`, getKey fails UnknownKeyId for other kids, and `yield* Effect.logWarning("awthaq: KeyProvider.layerEphemeral — encryption key is random per process; encrypted columns written now are unreadable after restart. Dev only.")`.
2. Use layerEphemeral in examples/sql-server when AWTHAQ_ENCRYPTION_KEY is absent AND the example is on the SQLite dev path (explicit in the example's composition, not in the library).
3. README Configuration table (README.md:217) — add `layerEphemeral (dev only)` to the Encryption/KeyProvider 'Other options' column; keep the key-generation one-liner for production.

Files: `packages/ports/src/KeyProvider.ts`, `packages/ports/test/KeyProvider.test.ts`, `examples/sql-server/index.ts`, `README.md`

Tests (write first):
- packages/ports/test/KeyProvider.test.ts — 'layerEphemeral yields a 32-byte key under kid "ephemeral" and logs a warning' (capture logs with a test Logger).
- Same file — 'layerEphemeral: two separate builds produce different keys' and 'getKey("env") fails UnknownKeyId'.
- Round-trip: Encryption.layer over layerEphemeral encrypts/decrypts within one layer lifetime.

Acceptance:
- `KeyProvider.layerEphemeral` exported and documented as dev-only.
- An example boots with no AWTHAQ_ENCRYPTION_KEY and prints the warning.
- layerEnv behavior unchanged.

Spec refs: — · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### CSS-005 — README quickstart shows the session cookie as SameSite=Lax; every code path and the BDD suite enforce Strict
`low` · `docs` · `repo` · [.issues/low/CSS-005-cookie-security-specialist.md](../../.issues/low/CSS-005-cookie-security-specialist.md)

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `README.md:182` — Still Lax at HEAD.

```
# set-cookie: __Host-session=...; Path=/; Secure; HttpOnly; SameSite=Lax
```

- `packages/core/src/Sessions.ts:152` — The only session cookie attribute set is Strict (BEH-EA-055).

```
export const SESSION_COOKIE_ATTRIBUTES = {
  secure: true,
  httpOnly: true,
  sameSite: "strict",
  path: "/",
} as const;
```

- `features/step-definitions/SessionSteps.ts:146` — BDD pins Strict.

```
Then('the cookie carries "Secure", "HttpOnly", and "SameSite=Strict"', function* () {
```

- `packages/oauth/src/OAuth.ts:398` — OAuth's own flow cookie is Lax — the division of labor IC-005 asks the README to explain.

```
          sameSite: "lax",
```

**Fix plan:** Correct the sample header to SameSite=Strict and add one sentence explaining why OAuth uses its own Lax __Host-oauth-state flow cookie (IC-005's addition).

Steps:
1. README.md:182 — `# set-cookie: __Host-session=...; Path=/; Secure; HttpOnly; SameSite=Strict` (ideally pasted from a real captured response of examples/sql-server once SMS-006 lands).
2. Add after the Running-it block: 'The session cookie is SameSite=Strict (BEH-EA-055), so it is not sent on cross-site top-level navigations; the OAuth plugin therefore carries its callback state in its own short-lived SameSite=Lax __Host-oauth-state cookie (packages/oauth/src/OAuth.ts) rather than relying on the session cookie.'
3. Grep the rest of the docs (`grep -rn 'SameSite=Lax' README.md packages/*/README.md examples/`) and correct any other session-cookie Lax claims.

Files: `README.md`

Tests (write first):
- Doc-only; `grep -n 'SameSite=Lax' README.md` matches only the OAuth flow-cookie explanation.

Acceptance:
- README's session set-cookie sample reads SameSite=Strict.
- README explains the Strict session cookie vs Lax OAuth flow cookie split.

Spec refs: BEH-EA-055 · Effort: **S** · Depends on: — · Also closes: IC-005

**Recommended status:** `ready-for-agent`

#### SMS-006 — README quickstart loads DATABASE_URL via non-null assertion instead of Effect Config
`low` · `dx` · `repo` · [.issues/low/SMS-006-secrets-management-specialist.md](../../.issues/low/SMS-006-secrets-management-specialist.md)

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `README.md:75` — Unchanged at HEAD. NB: SMS-006 is also the ID of an unrelated session-management finding (.issues/low/SMS-006-session-management-specialist.md) — this row is the secrets-management one.

```
const SqlLive = PgClient.layer({ url: Redacted.make(process.env.DATABASE_URL!) });
```

- `node_modules/.pnpm/@effect+sql-pg@4.0.0-rc.116_effect@4.0.0-rc.116/node_modules/@effect/sql-pg/src/PgClient.ts:357` — The Config-driven constructor the quickstart should use exists in the pinned @effect/sql-pg.

```
export const layerConfig = (
  config: Config.Wrap<PgPoolConfig>
): Layer.Layer<PgClient | Client.SqlClient, Config.ConfigError | SqlError> =>
```

- `README.md:117` — Quickstart's Mailer omits the required `sent` field and reads a non-existent `subject` field — does not type-check against MailerShape.

```
const consoleMailer = Layer.succeed(
  Mailer.Mailer,
  Mailer.Mailer.of({
    send: (message) => Effect.sync(() => console.log(`[mail] to=${message.to} subject=${message.subject}`)),
  }),
);
```

- `packages/ports/src/Mailer.ts:30` — Real MailerShape: `template` not `subject`, and `sent` is required.

```
export interface MailMessage {
  readonly to: string;
  readonly template: string;
  readonly data?: Record<string, unknown>;
}

export interface MailerShape {
  readonly send: (message: MailMessage) => Effect.Effect<void>;
  readonly sent: Effect.Effect<ReadonlyArray<MailMessage>>;
```

- `packages/core/src/AuthEvents.ts:347` — Since 6bd3f1d AuthEvents.layer requires AuditLog; README.md:105 provides AuthEvents.layer with no AuditLog (and README.md:89-95 has no AuditLogRepository), so the quickstart's CoreLive has an unsatisfied requirement.

```
export const layer: Layer.Layer<AuthEvents, never, AuditLog> = Layer.effect(
```

- `packages/password/src/PasswordApi.ts:261` — Password's group requires Api.CsrfProtection; README AppLayer (README.md:128-151) never provides Csrf.CsrfProtectionLive (the memory example does, examples/memory-server/index.ts:64).

```
  .middleware(Api.CsrfProtection);
```

**Fix plan:** Load DATABASE_URL through Config (`PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })`) — and, because validation shows the whole quickstart has drifted into not type-checking (Mailer shape, missing AuditLog, missing CsrfProtection), move the quickstart into a real, workspace-typechecked example that the README embeds/links so it can never drift again.

Steps:
1. Create examples/sql-server/ (package.json modeled on examples/memory-server/package.json; add `{ "path": "examples/sql-server" }` to root tsconfig.json references next to line 77; pnpm-workspace.yaml already globs examples/*).
2. examples/sql-server/index.ts = the README quickstart, fixed: `PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })` (no `!`, no manual Redacted.make); SQLite fallback per SEA-007 when DATABASE_URL is absent.
3. Fix the drift found during validation: replace the hand-rolled consoleMailer with `Mailer.layerConsole` (added by DESS-002); add `AuditLog.layerSql` + `Repositories.AuditLogRepositoryLive` beside AuthEvents.layer (BEH-EA-100); add `Csrf.CsrfProtectionLive` with a Config-read `CsrfConfig` secret; add `Hooks.HooksLive` and any other requirement the compiler reports (let `pnpm run typecheck` drive the list).
4. README.md:44-163 — replace the inline code block with a short excerpt + link to examples/sql-server/index.ts (or keep the full block but add a CI check that diff-compares it to the example file, e.g. a small scripts/readme-sync.mjs run from `pnpm check`).
5. README.md 'Running it' (175-198) — add the verify-email step (token from Mailer.layerConsole's log line) before sign-in, since Password.signIn fails EmailNotVerified for unverified users (packages/password/src/Password.ts:841-847); include the x-csrf/Origin requirements for mutating calls.
6. README.md:215 — Configuration table's Mailer row: point at Mailer.layerConsole for dev and `Mailer.Mailer.of({ send, sent })` for custom providers.

Files: `examples/sql-server/index.ts`, `examples/sql-server/package.json`, `examples/sql-server/tsconfig.json`, `examples/sql-server/README.md`, `tsconfig.json`, `README.md`, `scripts/readme-sync.mjs (optional)`

Tests (write first):
- Red first: create examples/sql-server/index.ts as a verbatim copy of README.md:44-162 and run `pnpm run typecheck` — it must fail (Mailer `sent` missing, `subject` unknown, AuditLog/CsrfProtection unsatisfied). Then fix until green.
- Smoke: `cd examples/sql-server && node --experimental-strip-types index.ts` with no DATABASE_URL boots on SQLite; the README curl sequence (sign-up → verify-email → sign-in → PATCH /user → DELETE /user) returns the documented statuses.

Acceptance:
- No `process.env.DATABASE_URL!` in README.md or examples/.
- Missing DATABASE_URL on the Postgres path fails at layer construction with a Config.ConfigError naming DATABASE_URL.
- The quickstart code is type-checked by `pnpm run typecheck` (lives in examples/sql-server).
- Following the README 'Running it' section verbatim yields a successful sign-in.

Spec refs: BEH-EA-100, BEH-EA-113, ADR-EA-004 · Effort: **M** · Depends on: DESS-002

**Recommended status:** `ready-for-agent`

#### SEA-007 — The one runnable example deliberately avoids any SQL backend, so no end-to-end SQLite composition is demonstrated
`info` · `architecture` · `repo` · [.issues/info/SEA-007-sqlite-embedded-auth-specialist.md](../../.issues/info/SEA-007-sqlite-embedded-auth-specialist.md)

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `examples/memory-server/index.ts:5` — Only example; examples/ contains memory-server alone.

```
// together), running through `@awthaq/test`'s real, production-quality
// memory backend instead of Postgres — no `DATABASE_URL`, no migration
// run, no `AWTHAQ_ENCRYPTION_KEY`.
```

- `README.md:200` — The one-layer-swap claim is prose only; no runnable SQLite composition exists.

```
(against an in-memory SQLite `SqlClient` locally, ...). Swapping `SqliteClient.layer({...})` for `PgClient.layer({ url })` is the only change between the two
```

- `packages/sql/test/Repositories.test.ts:27` — SQLite path is proven at package level only.

```
const SqlLive = SqliteClient.layer({ filename: ":memory:" });
```

**Fix plan:** Make examples/sql-server (created for SMS-006) default to a SQLite file and switch to Postgres when DATABASE_URL is set — a living proof of README.md:200's one-layer-swap claim.

Steps:
1. examples/sql-server/index.ts — `const SqlLive = Layer.unwrap(Effect.map(Config.option(Config.Redacted("DATABASE_URL")), Option.match({ onNone: () => SqliteClient.layer({ filename: "./awthaq.sqlite" }), onSome: (url) => PgClient.layer({ url }) })))` (verify Config.option naming in ../effect), then the same Migrator.make + CoreMigrations + domain layerSql composition for both.
2. Add @effect/sql-sqlite-node and @effect/sql-pg (catalog:) to examples/sql-server/package.json.
3. examples/sql-server/README.md — document both modes and that restarting on the SQLite file preserves users/sessions (durability check).
4. README.md:200 — replace the 'was run as a smoke test while writing this document' prose with a link to examples/sql-server.

Files: `examples/sql-server/index.ts`, `examples/sql-server/package.json`, `examples/sql-server/README.md`, `README.md`

Tests (write first):
- Smoke: boot with no DATABASE_URL, sign up, restart, sign in succeeds (file durability).
- Typecheck via root tsconfig reference.

Acceptance:
- A runnable example exercises SQLite client + CoreMigrations + encryption wiring end-to-end.
- Setting DATABASE_URL switches to Postgres with no other code change.

Spec refs: ADR-EA-004 · Effort: **S** · Depends on: SMS-006

**Recommended status:** `ready-for-agent`

#### IC-005 — Quickstart copy-paste output shows SameSite=Lax where the code sets Strict
`low` · `docs` · `repo` · [.issues/low/IC-005-iain-collins.md](../../.issues/low/IC-005-iain-collins.md)

**Verdict:** DUPLICATE of **CSS-005** (confidence: high)

**Evidence at HEAD:**

- `README.md:182` — Identical line and root cause as CSS-005; IC-005's extra ask (explain the Lax OAuth flow cookie) is folded into CSS-005's fix plan.

```
# set-cookie: __Host-session=...; Path=/; Secure; HttpOnly; SameSite=Lax
```

**No fix:** Duplicate of CSS-005; its fix plan covers this row.

**Recommended status:** `resolved`

#### CWM-007 — README shipping-status claims next remains a stub package, contradicting the implemented four-module adapter
`low` · `docs` · `repo` · [.issues/low/CWM-007-clerk-workos-migration-specialist.md](../../.issues/low/CWM-007-clerk-workos-migration-specialist.md)

**Verdict:** DUPLICATE of **DTWS-003** (confidence: high)

**Evidence at HEAD:**

- `README.md:232` — Exact same line/root cause as DTWS-003; CWM-007's extra citation (.scratch/shipping-gaps/map.md:137) is folded into DTWS-003's fix plan.

```
`two-factor`, `magic-link`, `api-key`, `cli`, and `next` remain stub packages
```

**No fix:** Duplicate of DTWS-003; its fix plan covers this row.

**Recommended status:** `resolved`

### Workstream: `design-docs-archive`

#### ELC-005 — Design doc claims AuthPlugin.layer merges taps; shipped implementation does two things, not three
`low` · `docs` · `repo` · [.issues/low/ELC-005-effect-layer-context-architect.md](../../.issues/low/ELC-005-effect-layer-context-architect.md)

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `archive/design/plugins-as-layers.md:142` — Unchanged.

```
`AuthPlugin.layer` only does three things: `Layer.effect(plugin, make)`, `Layer.provideMerge` of the handlers so they see the plugin service, and `Layer.mergeAll` of the taps.
```

- `packages/core/src/AuthPlugin.ts:255` — Two steps; no tap merge.

```
  const own = Layer.effect<Self, Shape, E, R>(plugin, options.make);
  return options.handlers ? Layer.provideMerge(options.handlers, own) : own;
```

- `spec/decisions/008-plugin-is-context-service-class.md:19` — The stale claim is quoted in a governing ADR — archive/ is superseded (spec/README.md:132-134) but ADR-EA-008 is normative, so this is a real spec drift.

```
...a `static readonly layer` built by `AuthPlugin.layer`, which composes `Layer.effect(plugin, make)` with the handler layer and any hook taps (`archive/design/plugins-as-layers.md` §2.2: "`AuthPlugin.layer` only does three things: ...and `Layer.mergeAll` of the taps")
```

- `packages/organization/src/OrganizationHooks.ts:270` — Actual tap/point composition happens outside AuthPlugin.layer.

```
export const OrganizationHooksLive = Layer.mergeAll(
  BeforeCreateOrganization.layer,
  AfterCreateOrganization.layer,
```

**Fix plan:** Fix the governing ADR-EA-008 text to the shipped two-step algebra and point to HookPoint `.tap` layers + per-plugin *HooksLive merges as the tap mechanism; leave archive/ as historical record but add a one-line correction note.

Steps:
1. spec/decisions/008-plugin-is-context-service-class.md:19 — replace 'with the handler layer and any hook taps (... three things ...)' with: '`Layer.effect(plugin, make)` plus an optional `Layer.provideMerge` of the handlers (packages/core/src/AuthPlugin.ts); hook taps are separate layers produced by `HookPoint.tap`/`.observe` and merged by the plugin or application (e.g. `OrganizationHooks.OrganizationHooksLive`, `Hooks.HooksLive`)'. Keep the archive citation but mark it as the pre-implementation design.
2. archive/design/plugins-as-layers.md:142 — append a bracketed note '[Superseded: shipped AuthPlugin.layer does the first two; taps compose via HookPoint layers — see ADR-EA-008]' (archive is historical; a note, not a rewrite).
3. Run `pnpm run spec:verify:strict` to keep ADR formatting/traceability valid (bump the ADR's revision/change-history row if the spec tooling requires it).

Files: `spec/decisions/008-plugin-is-context-service-class.md`, `archive/design/plugins-as-layers.md`

Tests (write first):
- `pnpm run spec:verify:strict` passes.

Acceptance:
- ADR-EA-008 no longer claims AuthPlugin.layer merges taps.
- The archive doc carries a correction pointer.

Spec refs: ADR-EA-008, BEH-EA-024 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

### Workstream: `observability-substrate`

#### EOTS-006 — packages/server ships no logging/observability surface; example app uses bare console.log
`medium` · `dx` · `repo` · [.issues/medium/EOTS-006-effect-observability-tracing-specialist.md](../../.issues/medium/EOTS-006-effect-observability-tracing-specialist.md)

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `examples/memory-server/index.ts:106` — Still bare console.log (line drifted from :88).

```
console.log("awthaq example (memory-backed, Password + Organization) listening on :3001");
```

- `packages/server/src/AuthHttp.ts:32` — `grep -rn 'Effect.log\|Logger\|HttpMiddleware\|withSpan' packages/server/src` returns nothing; no tracer/requestLogger re-exports yet.

```
export const docs: typeof HttpApiScalar.layer = HttpApiScalar.layer;
```

- `../effect/packages/effect/src/unstable/http/HttpMiddleware.ts:139` — Upstream request logger (and `tracer` at :186) the decision says to re-export.

```
export const logger: <E, R>(
```

**Fix plan:** Follow wayfinder ticket 27 (MW-001's decision): re-export HttpMiddleware.tracer/logger from AuthHttp (not a bespoke AuthObservability logger — the decision leaves logging/metrics backends to the host), and make the example demonstrate the recommended composition: structured JSON logging + request logger + Effect.logInfo startup line.

Steps:
1. If MW-001 has not landed: packages/server/src/AuthHttp.ts — `export const tracer: typeof HttpMiddleware.tracer = HttpMiddleware.tracer;` and `export const requestLogger: typeof HttpMiddleware.logger = HttpMiddleware.logger;` (the file's direct-re-export idiom; typeof-alias, not an assertion).
2. examples/memory-server/index.ts — serve with `HttpRouter.serve(AppLayer, { middleware: (app) => AuthHttp.tracer(AuthHttp.requestLogger(app)) })` or the equivalent HttpRouter middleware hook (check HttpRouter.serve's options in ../effect/packages/effect/src/unstable/http/HttpRouter.ts); provide `Logger.layer([Logger.consoleJson])` when NODE_ENV=production else consolePretty; replace console.log with a `Layer.effectDiscard(Effect.logInfo(...))` merged into ServerLive.
3. Mirror the same composition in examples/sql-server (SMS-006) and mention it in README's Configuration section.
4. Out of scope here (other slices): .quality-metrics/server.json staleness (quality-metrics-regeneration workstream, TS-006) and business-logic spans/metrics (MW-001).

Files: `packages/server/src/AuthHttp.ts`, `packages/server/test/AuthHttp.test.ts`, `examples/memory-server/index.ts`, `examples/sql-server/index.ts`, `README.md`

Tests (write first):
- packages/server/test/AuthHttp.test.ts — 'AuthHttp.requestLogger emits one log per request annotated with http.method/http.status' (test Logger) and 'AuthHttp.tracer creates a span per request' (test Tracer).

Acceptance:
- AuthHttp exports tracer and requestLogger.
- The example emits structured request logs and no bare console.log.
- No new logging backend opinion baked into library code.

Spec refs: BEH-EA-199 · Effort: **S** · Depends on: MW-001

**Recommended status:** `ready-for-agent`

### Workstream: `events-delivery-durability`

#### ESA-003 — Delivery is at-most-once with no replay: late or restarted consumers silently lose all prior events
`medium` / `architecture` / `repo` · [.issues/medium/ESA-003-event-sourcing-audit-trail-specialist.md](../../.issues/medium/ESA-003-event-sourcing-audit-trail-specialist.md)

**Verdict:** PARTIAL (confidence: high) · fixed-in-part-by `6bd3f1d`

**Evidence at HEAD:**

- `packages/core/src/AuthEvents.ts:365` — FIXED part: since 6bd3f1d (ALF-001/ESA-001) every event is durably written to AuditLog before the bus — the bus is no longer the only history.
  ```
  const publish: AuthEventsShape["publish"] = (event) =>
        Effect.gen(function* () {
          yield* auditLog.record(event);
          const accepted = yield* PubSub.publish(pubsub, event);
  ```
- `packages/core/src/AuthEvents.ts:378` — Still true: the live stream is at-most-once (now PubSub.dropping) with no resume point — intended per wayfinder ticket 02.
  ```
  stream: Stream.fromPubSub(pubsub),
  ```
- `packages/core/src/AuditLog.ts:62` — REMAINING part: the durable log has no replay-by-sequence/cursor read (newest-first, unpaged, time filters only; `id` is UUIDv7 with no monotonic sequence column), so a projection cannot backfill and then tail.
  ```
  /** Newest-first; every filter is optional and combines with AND. */
    readonly list: (input?: AuditLogListInput) => Effect.Effect<ReadonlyArray<AuditLogRecord>>;
  ```

**Fix plan:** Keep the bus at-most-once; make the durable AuditLog the recovery path: add a monotonic sequence and an ascending, cursor-based `replay` read (Stream) so consumers can backfill from a checkpoint.

Steps:
1. packages/sql/src/CoreMigrations.ts — new migration adding a monotonic `sequence` to auth_audit_log (pg/mysql: `BIGINT GENERATED ALWAYS AS IDENTITY` / AUTO_INCREMENT; sqlite: expose `rowid` as `sequence` in queries), plus an index on it.
2. packages/core/src/AuditLog.ts — add `sequence: bigint`/number to `AuditLogRecord`; add `replay: (input: { readonly after?: sequence; readonly batchSize?: number }) => Stream.Stream<AuditLogRecord>` (ascending, paged internally); implement in layerMemory (append counter) and layerSql.
3. Document in AuthEvents.ts header + spec/behaviors/13-events.md: bus = observation only, at-most-once; durable replay = AuditLog.replay; recommended consumer pattern = checkpoint sequence, replay, then tail the stream (dedupe by sequence).
4. Do not build the durable outbox plugin (SqlPersistedQueue) now — no cross-process consumer exists; note it as the future extension point.

Files: `packages/sql/src/CoreMigrations.ts`, `packages/sql/src/Repositories.ts`, `packages/core/src/AuditLog.ts`, `packages/core/src/AuthEvents.ts`, `spec/behaviors/13-events.md`

Tests (write first):
- packages/core/test/AuditLog.test.ts — 'replay({ after }) yields every event recorded after the checkpoint in publish order, across both layerMemory and layerSql (sqlite)' — red first.
- Migration test in packages/sql/test for the new column on sqlite + pg dialect branches.

Acceptance:
- A consumer started after N events can reconstruct all N from AuditLog.replay in order.
- `pnpm check` and `pnpm spec:verify:strict` green.

Spec refs: BEH-EA-097, BEH-EA-098, BEH-EA-100, BEH-EA-102 · Effort: **M** · Depends on: none

**Recommended status:** `ready-for-agent`

### Workstream: `qadi-decision-cache-invalidation`

#### PCS-005 — Zero tests exercise the cached-decision path or any invalidation trigger in this repo
`medium` · `testing` · `repo` · [.issues/medium/PCS-005-permission-caching-specialist.md](../../.issues/medium/PCS-005-permission-caching-specialist.md)

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `spec/appendices/02-qadi-path-a-end-to-end.md:59` — The only occurrence of decisionCacheLayer/DecisionCache in packages/, examples/, spec/, features/ — no test composes it.

```
export const QadiLive = Layer.mergeAll(EvaluationServicesNone, EvaluationIdLive, decisionCacheLayer({ capacity: 512 }))
```

- `packages/qadi/test/` — No cache test; decision ticket 12's DecisionCacheInvalidation.ts does not exist yet in packages/qadi/src.

```
AttributeResolvers.test.ts AuthorizedSubject.test.ts Resolvers.test.ts SubjectApi.test.ts SubjectExtractor.test.ts SubjectResolver.test.ts
```

- `examples/memory-server/index.ts:42` — Example composes no qadi/cache at all.

```
const built = Auth.make([Password.Password, Organization.Organization]);
```

**Fix plan:** Write the regression net that wayfinder ticket 12's decision (PCS-001/RZS-002) needs: tests for per-request cache scope and for DecisionCacheInvalidationLive clearing on organization membership/role hooks.

Steps:
1. Implement alongside (or immediately after) PCS-001/RZS-002: packages/qadi/src/DecisionCacheInvalidation.ts taps AfterAddMember/AfterRemoveMember/AfterUpdateMemberRole/AfterDeleteOrganization/AfterAddTeamMember/AfterRemoveTeamMember/AfterUpdateTeam/AfterDeleteTeam and calls DecisionCache.clear (per ticket 12).
2. New test file packages/qadi/test/DecisionCache.test.ts (or in packages/organization/test if the Organization plugin is needed): compose Organization memory records + OrganizationQadi RelationshipResolver + decisionCacheLayer({capacity}) + DecisionCacheInvalidationLive.
3. Also a roles case: Roles.layerMemory + cache; assert behavior after roles.revoke (roles change the subject → key changes; the test pins that the next decision denies).
4. Per-request-scope case: provide decisionCacheLayer per request (as the rewritten appendix will) and assert a membership removal between two requests is visible without any invalidation layer.

Files: `packages/qadi/test/DecisionCache.test.ts`, `packages/qadi/src/DecisionCacheInvalidation.ts (from PCS-001)`, `spec/appendices/02-qadi-path-a-end-to-end.md (from PCS-001)`

Tests (write first):
- 'second identical decision is served from the cache' (spy resolver call count stays at 1).
- 'after organization memberRemoved, the next decision denies under an application-scoped cache with DecisionCacheInvalidationLive'.
- 'after roles.revoke, the next decision denies'.
- 'request-scoped cache: removal between requests is visible with no invalidation layer'.

Acceptance:
- All four tests exist and pass in `pnpm run test`.
- Removing DecisionCacheInvalidationLive from the app-scoped test makes the memberRemoved test fail (demonstrates it guards the invariant).

Spec refs: BEH-EA-145, BEH-EA-164 · Effort: **M** · Depends on: PCS-001, RZS-002

**Recommended status:** `ready-for-agent`

#### AAPS-005 — DecisionCache has no TTL: cached verdicts can outlive an attribute change
`medium` / `security` / `qadi-upstream` · [.issues/medium/AAPS-005-abac-attribute-policy-specialist.md](../../.issues/medium/AAPS-005-abac-attribute-policy-specialist.md)

**Verdict:** PARTIAL (confidence: high)

**Evidence at HEAD:**

- `node_modules/.pnpm/@qadi+core@0.7.0/node_modules/@qadi/core/src/DecisionCache.ts:289` — Still true (also in ../qadi v0.8.0 at :291). No TTL.
  ```
  * **Unbounded by default** — `entries` is never evicted unless `capacity` is
  ```
- `../qadi/spec/decisions/031-decision-cache.md:166` — The TTL half of the recommended fix is rejected upstream; wayfinder ticket 12 (resolved) follows that ADR and chooses per-request scope + an invalidation bridge instead — do not re-litigate.
  ```
  **A TTL on entries.** Rejected: a time-bounded cache needs a clock, so it needs a
  determinism story against
  [INV-QD-008]...
  ```
- `spec/appendices/02-qadi-path-a-end-to-end.md:59` — The app-scoped wiring the finding cites is still the canonical example (PCS-001 not yet implemented).
  ```
  export const QadiLive = Layer.mergeAll(EvaluationServicesNone, EvaluationIdLive, decisionCacheLayer({ capacity: 512 }))
  ```
- `packages/qadi/src/Resolvers.ts:78` — The residual real gap: `emailVerified`/`email`/`name` are awthaq-owned attributes, yet ticket 12's DecisionCacheInvalidationLive only taps OrganizationHooks — Users.verifyEmail/updateProfile (core/src/Users.ts:96-100) publish no event/hook the bridge could tap.
  ```
  case "emailVerified":
                  return user.emailVerified;
  ```

**Fix plan:** No TTL (ADR-QD-031 / ticket 12). Close the part ticket 12 misses: awthaq-owned user attributes must also invalidate an application-scoped cache — add a user-attribute-change signal and tap it in DecisionCacheInvalidationLive.

Steps:
1. Land PCS-001/RZS-002 first (per-request `decisionCacheLayer` in Path A middleware / Path B extractor; new packages/qadi/src/DecisionCacheInvalidation.ts).
2. packages/core/src/Hooks.ts — add an observe hook point `AfterUserAttributesChanged` (payload: userId, changed attribute names) fired by Users.verifyEmail and Users.updateProfile (packages/core/src/Users.ts:187, :210); alternatively an `auth.user.updated` AuthEvent — prefer the hook point, matching ticket 12's `.tap` design.
3. packages/qadi/src/DecisionCacheInvalidation.ts — also tap `AfterUserAttributesChanged` → `DecisionCache.clear`.
4. Doc comment on DecisionCacheInvalidationLive + spec appendix: list covered sources (org/team membership, awthaq UserAttributes) and the explicit caveat that application-owned AttributeResolver data needs its own `clear`.

Files: `packages/core/src/Hooks.ts`, `packages/core/src/Users.ts`, `packages/qadi/src/DecisionCacheInvalidation.ts`, `spec/appendices/02-qadi-path-a-end-to-end.md`, `spec/behaviors/21-qadi-resolvers-obligations.md`

Tests (write first):
- packages/qadi/test/DecisionCacheInvalidation.test.ts — 'an app-scoped cached Deny on hasAttribute(emailVerified) becomes Allow after Users.verifyEmail' (red until the hook + tap exist).

Acceptance:
- With app-scoped `decisionCacheLayer` + `DecisionCacheInvalidationLive`, a decision depending on `emailVerified` reflects verifyEmail on the next ask.
- No TTL option is added to qadi.

Spec refs: BEH-EA-161, BEH-EA-162, BEH-EA-163, BEH-EA-164 · Effort: **M** · Depends on: PCS-001, RZS-002

**Recommended status:** `ready-for-agent`

#### YL-007 — Per-request role-DAG walk with the engine's decision cache unwired
`low` / `performance` / `qadi-upstream` · [.issues/low/YL-007-yang-luo.md](../../.issues/low/YL-007-yang-luo.md)

**Verdict:** DUPLICATE (confidence: high) · duplicate of **PCS-001**

**Evidence at HEAD:**

- `packages/roles/src/Roles.ts:198` — Still flattens per resolution — which BEH-EA-139 mandates; memoizing it is not warranted.
  ```
  const subject = fromRoles({ id: `user:${userId}`, roles: matched });
  ```
- `spec/appendices/02-qadi-path-a-end-to-end.md:59` — The only `decisionCacheLayer` reference in the repo (none in packages/ or examples/). Wiring it per request inside AuthorizedSubjectLive (packages/qadi/src/AuthorizedSubject.ts:64) is exactly PCS-001's resolved decision (wayfinder ticket 12), which pulls this lever.
  ```
  export const QadiLive = Layer.mergeAll(EvaluationServicesNone, EvaluationIdLive, decisionCacheLayer({ capacity: 512 }))
  ```

**Fix plan:** No separate fix — closed by PCS-001's plan.

**Recommended status:** `resolved`

### Workstream: `roles-permission-modeling`

#### YL-006 — No wildcard or pattern matching on permission keys
`low` / `api` / `qadi-upstream` · [.issues/low/YL-006-yang-luo.md](../../.issues/low/YL-006-yang-luo.md)

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `node_modules/.pnpm/@qadi+core@0.7.0/node_modules/@qadi/core/src/Evaluate.ts:823` — Exact set membership; unchanged in ../qadi v0.8.0 (Evaluate.ts:908).
  ```
  subject.permissions.has(key)
            ? allow("HasPermission", policy.fields)
            : deny("HasPermission", `subject lacks permission '${key}'`),
  ```
- `node_modules/.pnpm/@qadi+core@0.7.0/node_modules/@qadi/core/src/Permission.ts:102` — qadi already ships a definition-time bundling helper (resource × actions) — the audit's 'expand at role-definition time' option exists; awthaq's roles docs never point at it.
  ```
  export function createPermissionGroup<
    const TResource extends string,
    const TActions extends ReadonlyArray<string>,
  >(resource: TResource, actions: TActions): PermissionGroup<TResource, TActions>;
  ```
- `packages/roles/README.md:3` — The whole roles README is a stale 9-line placeholder (overlaps sibling readme-docs-accuracy work) with no permission-modeling guidance at all.
  ```
  > **This describes a planned package.** awthaq is pre-implementation (see [`../../spec/README.md`](../../spec/README.md)); no line of source in this package has shipped yet.
  ```

**Fix plan:** Keep qadi's exact O(1) membership (deliberate engine design; no matcher change in ../qadi). Document the modeling boundary in @awthaq/roles and show definition-time expansion via qadi's `createPermissionGroup`, plus attribute policies for the 'wildcard instinct'.

Steps:
1. packages/roles/README.md — add a 'Modeling permissions' section: keys are exact `resource:action`; bundle with `createPermissionGroup(resource, actions)` when defining a role; reach for `hasAttribute`/`hasResourceAttribute` policies instead of wildcards; explain why `docs:*` is an inert literal.
2. packages/roles/src/Roles.ts header or `config` JSDoc — one-line pointer to that section.
3. Optional (only if a consumer asks): a qadi-side issue in ../qadi proposing a catalog-time pattern expander; not planned here.

Files: `packages/roles/README.md`, `packages/roles/src/Roles.ts`

Tests (write first):
- packages/roles/test: add a doc-example test 'a role defined with createPermissionGroup grants every expanded key and HasPermission(docs:*) grants nothing' so the README's claims are executable.

Acceptance:
- README section exists and its example compiles/runs as a test.

Spec refs: BEH-EA-139 · Effort: **S** · Depends on: none

**Recommended status:** `ready-for-agent`

#### RRM-008 — No wildcard or namespace permission support anywhere in the model
`info` / `architecture` / `qadi-upstream` · [.issues/info/RRM-008-rbac-role-modeling-specialist.md](../../.issues/info/RRM-008-rbac-role-modeling-specialist.md)

**Verdict:** DUPLICATE (confidence: high) · duplicate of **YL-006**

**Evidence at HEAD:**

- `node_modules/.pnpm/@qadi+core@0.7.0/node_modules/@qadi/core/src/Evaluate.ts:823` — Same construct and same root cause as YL-006; its recommended fix (state the boundary in the roles README, expand at flatten/definition time) is YL-006's plan.
  ```
  subject.permissions.has(key)
  ```

**Fix plan:** No separate fix — closed by YL-006's plan.

**Recommended status:** `resolved`

### Workstream: `property-based-testing`

#### ETVS-002 — Property-based testing entirely absent despite STACK.md committing to it
`medium` / `testing` / `repo` · [.issues/medium/ETVS-002-effect-testing-vitest-specialist.md](../../.issues/medium/ETVS-002-effect-testing-vitest-specialist.md)

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `STACK.md:35` — The commitment still stands.
  ```
  - `unstable/arbitrary/Arbitrary.ts` — `Arbitrary.schema(schema)` derives property-based test generators straight from the same `Schema` used at runtime, so BEH-EA-193–200's fuzz/property tests ...
  ```
- `packages/*/test` — Zero property tests at HEAD.
  ```
  grep -rln 'Arbitrary|fast-check|it.prop|.prop(' packages/*/test  →  (no matches)
  ```
- `../effect/packages/vitest/src/index.ts:265` — @effect/vitest's `it.prop`/`it.effect.prop` accept Schemas directly (Arbitraries derived via effect/unstable/arbitrary/Arbitrary) — no new dependency needed.
  ```
  export const prop: Vitest.Methods["prop"] = internal.prop
  ```
- `packages/password/src/Password.ts:271` — Pure codec pair (with decodeVerificationToken :274) covered only by examples; module-private today.
  ```
  const encodeVerificationToken = (identifier: string, value: Redacted.Redacted<string>): string =>
  ```

**Fix plan:** Introduce Schema-derived property tests with @effect/vitest `it.prop`/`it.effect.prop`, starting with pure codecs and wire schemas.

Steps:
1. Extract `encodeVerificationToken`/`decodeVerificationToken` from Password.ts into packages/password/src/VerificationTokenCodec.ts (exported internally, not from the barrel) so it is testable.
2. packages/password/test/VerificationTokenCodec.prop.test.ts — `it.prop` round-trip: for any identifier/value, decode(encode(x)) ≡ x; and decode never throws on arbitrary strings (returns failure).
3. packages/api/test/Principal.prop.test.ts — encode→decode round-trip over the Principal union Schema (packages/api/src/Api.ts).
4. packages/core/test/SessionConfig.prop.test.ts — boundary decoding of SessionConfig Durations (valid values decode, invalid rejected, never a defect).
5. packages/test (runPluginContractTests) — add an optional property pass fuzzing plugin option Schemas (follow-up, can be a separate commit).
6. Correct STACK.md:35 — BEH-EA-193–200 (spec/behaviors/25-testing-harness.md) define TestAuth/contract-harness behaviors, not property tests, and LoginRequest/TotpCode/ApiKey schemas do not exist (two-factor/api-key are stubs); cite the real prop-test files instead. Add a BEH-EA entry only if the contract harness gains the fuzz pass.

Files: `packages/password/src/VerificationTokenCodec.ts (new)`, `packages/password/src/Password.ts`, `packages/password/test/VerificationTokenCodec.prop.test.ts (new)`, `packages/api/test/Principal.prop.test.ts (new)`, `packages/core/test/SessionConfig.prop.test.ts (new)`, `STACK.md`

Tests (write first):
- The new prop tests are the deliverable; write the round-trip property first against the extracted codec (it should pass; then mutate the codec's delimiter handling locally to confirm the property catches it).

Acceptance:
- At least three `it.prop`/`it.effect.prop` suites in packages/*/test.
- `pnpm run test` green; `pnpm knip` clean (no unused exports from the extraction).

Spec refs: none · Effort: **M** · Depends on: none

**Recommended status:** `ready-for-agent`

### Workstream: `passkey-browser-signals`

#### TC-004 — Signals API entirely absent; no browser-side passkey surface in any shipped package
`medium` / `dx` / `repo` · [.issues/medium/TC-004-tim-cappalli.md](../../.issues/medium/TC-004-tim-cappalli.md)

**Verdict:** PARTIAL (confidence: high) · fixed-in-part-by `0441226`

**Evidence at HEAD:**

- `packages/client/src/passkey/PasskeyClient.ts:284` — FIXED part (0441226, BPAS-002): a browser passkey surface now ships — conditional create, autofill/conditional-get authenticate, getClientCapabilities (:272).
  ```
  export const passkeyClient = (client: PasskeyApiClient) => ({
    registerPasskey: () => registerPasskey(client),
    registerPasskeyConditional: () => registerPasskeyConditional(client),
    authenticate: (options?: { readonly autoFill?: boolean; readonly email?: string }) =>
  ```
- `packages/client/src/passkey/PasskeyClient.ts:263` — REMAINING part: no Signals API anywhere — `grep -rn signal(Unknown|AllAccepted|CurrentUser) packages/*/src` is empty; delete does not call signalAllAcceptedCredentials although @simplewebauthn/browser v14 (already a dep) exports `sendSignal`.
  ```
  const deletePasskey = (client: PasskeyApiClient, id: string) =>
    client["passkey.credentials"].remove({ params: { id } });
  ```
- `packages/passkey/src/PasskeyApi.ts:41` — Constraint on the signalUnknownCredential half: BEH-EA-136 enumeration safety means the client cannot currently learn 'unknown credential'.
  ```
  // every other authentication failure (unknown credential id, a wrong
  // signature, an origin/rpId mismatch) *would* leak that distinction, so
  // `Passkey.ts`'s handler collapses all of them into the same
  // `Api.InvalidCredentials` uniform response
  ```

**Fix plan:** Add a typed, fire-and-forget Signals layer to @awthaq/client's passkeyClient: signalAllAcceptedCredentials after delete and after every successful authenticate, signalCurrentUserDetails after a profile-name change; expose signal capabilities in getClientCapabilities. Server supplies the needed rpId/userHandle/credential-id list.

Steps:
1. packages/passkey/src/PasskeyApi.ts — add an authenticated `GET /passkey/signals` endpoint (or extend `list`) returning `{ rpId, userHandle (base64url), acceptedCredentialIds: string[] (WebAuthn credential IDs, base64url), userName, displayName }`; implement in Passkey.ts from PasskeyCredentials + config.rpId.
2. packages/client/src/passkey/PasskeyClient.ts — `signalAcceptedCredentials()` calling `sendSignal({ signalName: 'allAcceptedCredentials', rpID, userID, allAcceptedCredentialIDs })`, swallowing unsupported/failed signals (Effect.ignore + debug log); call it after `deletePasskey` succeeds and after `authenticate` succeeds; `signalCurrentUserDetails()` exported for apps to call after a name change.
3. Extend `PasskeyClientCapabilities` with `signalAllAcceptedCredentials`/`signalCurrentUserDetails`/`signalUnknownCredential`/`relatedOrigins` (getBrowserCapabilities already returns them).
4. Do NOT emit signalUnknownCredential on uniform authentication failure unless the decision below picks option C.
5. spec/behaviors/17-passkey.md — new BEH-EA (next free id in the passkey range or a client behavior) documenting the signal contract; update .scratch/passkey/spec.md out-of-scope list is not needed (scratch).
6. packages/client README / docs: autocomplete='username webauthn' guidance next to the autofill option.

Files: `packages/passkey/src/PasskeyApi.ts`, `packages/passkey/src/Passkey.ts`, `packages/client/src/passkey/PasskeyClient.ts`, `packages/client/test/passkey/PasskeyClient.test.ts`, `spec/behaviors/17-passkey.md`, `spec/traceability.md`

Tests (write first):
- packages/client/test/passkey: 'deletePasskey then signals allAcceptedCredentials with the remaining ids' and 'a browser without PublicKeyCredential.signalAllAcceptedCredentials never fails the delete' (red first; fake the platform boundary as the existing tests do).
- packages/passkey/test: signals endpoint returns only the caller's credential ids and 401 when unauthenticated.

Acceptance:
- After deleting a passkey in a Signals-capable browser, the credential manager is told the remaining accepted set.
- Signals never change ceremony outcomes or error types.
- No enumeration-safety regression (BEH-EA-136).

Spec refs: BEH-EA-134, BEH-EA-136 · Effort: **M** · Depends on: none

**Decision needed:** see 'Decisions needed' above.

**Recommended status:** `ready-for-human`

### Workstream: `device-authorization-grant`

#### DAG-005 — Strongest RFC 8628 design in the repo is non-normative third-party analysis
`medium` · `architecture` · `repo` · [.issues/medium/DAG-005-device-authorization-grant-specialist.md](../../.issues/medium/DAG-005-device-authorization-grant-specialist.md)

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `better-auth/05-mfa-and-verification/08-device-authorization-and-one-tap.md:104` — Rigorous design lives only in non-normative evidence (spec/README.md:130).

```
ALL fallible checks (grant authorization, user
                    lookup) complete BEFORE the destructive step —
                    ONLY THEN: ATOMIC CONDITIONAL CONSUME
                    (id + ownershipWhere + status="approved")
```

- `spec/models/13-device-authorization.md:54` — awthaq's own model is a stub.

```
This sketch is speculative in its entirety — it is not drawn from any PRD or cookbook text naming this plugin's shape
```

- `spec/models/13-device-authorization.md:60` — No race-safety/slow_down invariants recorded.

```
... no rate-limiting or user-code entropy design, and no research file in this repository treats device-code flow as its primary subject
```

**Fix plan:** Graduate the better-auth §A.1–A.6 polling state machine into awthaq's own spec/models/13-device-authorization.md as a 'Design constraints' section (normative intent for Phase 3), adding RFC 8628 §3.5's client slow_down +5 s duty and the BEH-EA-208/CLI-login linkage; allocate a BEH-EA range when the plugin enters a roadmap milestone.

Steps:
1. spec/models/13-device-authorization.md — new section 'Design constraints (from better-auth §A, adopted)': (1) state advances only pending→approved|denied; (2) approve is a compare-and-swap on status=pending; (3) redemption runs every fallible check first, then an atomic conditional consume (id + owner + status=approved) → at-most-once session issuance under concurrent polls; (4) server-side slow_down with lastPolledAt updated on every poll incl. rejected ones; (5) expired rows GC'd on first discovery, denied rows deleted on observation; (6) user-code entropy/charset and per-user-code rate limits; (7) client MUST add 5 s to its interval on slow_down (RFC 8628 §3.5).
2. Link the section to wayfinder ticket 06's CLI login decision (DAG-002/DAG-003: login in @awthaq/cli as outbound-only client) and to ticket 03's BeforeSessionIssue for the poll's session issuance.
3. Update the model's 'What is missing' paragraph and Change History row; keep Status Planned-Phase3.
4. Optionally add invariants to spec/invariants.md as INV-EA-### 'planned' entries if the invariants file supports planned status (check its conventions).

Files: `spec/models/13-device-authorization.md`, `spec/invariants.md (optional)`

Tests (write first):
- `pnpm run spec:verify:strict` passes; no code tests (Phase 3, no plugin yet).

Acceptance:
- spec/models/13 states the conditional-consume, CAS-approve, slow_down (server + client +5 s) and GC invariants in awthaq's own words with RFC 8628 references.
- The model no longer calls itself 'speculative in its entirety'.

Spec refs: EFAUTH-MOD-13, BEH-EA-208 · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### DAG-001 — RFC 8628 device authorization grant is entirely unimplemented and deferred to Phase 3
`info` / `compliance` / `repo` · [.issues/info/DAG-001-device-authorization-grant-specialist.md](../../.issues/info/DAG-001-device-authorization-grant-specialist.md)

**Verdict:** DUPLICATE (confidence: medium) · duplicate of **DAG-005**

**Evidence at HEAD:**

- `spec/roadmap.md:125` — Unimplemented by design (no device_code/DeviceAuthorization in packages/*/src); spec/models/13-device-authorization.md:25 Status 'Planned-Phase3'.
  ```
  - Implement every enterprise protocol in v1 (SSO, SAML, an OIDC provider, SCIM and device authorization are M(3) roadmap items, not v1 scope — see `archive/PRD.md` §17, Phase 3).
  ```
- `.issues/medium/DAG-005-device-authorization-grant-specialist.md:35` — DAG-001's only actionable ask ('promote the corpus design into a normative BEH-EA range and invariants before Phase 3') is DAG-005's fix verbatim; wayfinder ticket 06 also recommends a follow-up to scope the DeviceAuthorization contract.
  ```
  Port §A.1–A.6 into spec/behaviors as a numbered BEH-EA range with matching invariants
  ```

**Fix plan:** No separate fix — closed by DAG-005's plan.

**Recommended status:** `resolved`

### No workstream (closed without work)

#### BCR-007 — better-auth design contract keeps a plaintext backup-code read path that contradicts the repo's own recommendation
`medium` · `docs` · `repo` · [.issues/medium/BCR-007-backup-codes-recovery-specialist.md](../../.issues/medium/BCR-007-backup-codes-recovery-specialist.md)

**Verdict:** INVALID (confidence: high)

**Evidence at HEAD:**

- `better-auth/05-mfa-and-verification/01-two-factor.md:304` — This is a faithful description of *better-auth's* behavior, not an awthaq design contract.

```
Operation:     viewBackupCodes  — server-only, no HTTP surface, no client
               method
...
Ensures:       returns the plaintext backup-code array for that user
```

- `spec/README.md:130` — better-auth/ is explicitly non-normative evidence.

```
`better-auth/` (a design-by-contract analysis of the competing better-auth framework) ... neither directory is itself normative
```

- `spec/models/06-two-factor-totp.md:93` — awthaq's own plan already reconciles the two: hashed, single-use, no read-back.

```
Recovery codes are hashed and single-use; `/two-factor/verify` is rate limited
```

- `.scratch/resolve-ready-for-human-findings/issues/05-mfa-two-factor-subsystem.md:38` — Resolved decision for the TwoFactor build: hashed storage, no plaintext column exists to read back.

```
**Recovery codes**: table `two_factor_recovery_code` (`id`, `userId`, `codeHash`, `usedAt` nullable) — hashed via the existing `PasswordHasher` port
```

**No fix:** No action. Optional: when the TwoFactor plugin is built (wayfinder ticket 05), add one sentence to spec/models/06-two-factor-totp.md stating codes are shown once at mint time and there is deliberately no view/read-back operation.

**Recommended status:** `wontfix`

#### ALF-008 — Zero subscribers shipped anywhere — a default install records security events nowhere
`medium` · `architecture` · `repo` · [.issues/medium/ALF-008-audit-logging-forensics-specialist.md](../../.issues/medium/ALF-008-audit-logging-forensics-specialist.md)

**Verdict:** ALREADY-FIXED by `6bd3f1d` (confidence: high)

**Evidence at HEAD:**

- `packages/core/src/AuthEvents.ts:341` — Every published event is recorded without any subscriber (commit 6bd3f1d, per wayfinder ticket 01 which explicitly rejects a subscriber as the record of record).

```
 * BEH-EA-100: `AuditLog` is a hard dependency — `publish` writes the
 * durable row inline, before the event ever reaches the `PubSub`.
 ...
export const layer: Layer.Layer<AuthEvents, never, AuditLog> = Layer.effect(
```

- `examples/memory-server/index.ts:88` — The example now records every event into AuditLog (memory, matching the example's memory backend); AuditLog.layerSql exists for durable deployments (packages/core/src/AuditLog.ts:185).

```
).pipe(Layer.provideMerge(AuthEvents.layer), Layer.provideMerge(AuditLog.layerMemory));
```

**No fix:** Close as fixed by 6bd3f1d. Residual found during validation: the README quickstart (README.md:105) composes AuthEvents.layer without AuditLog.layerSql/AuditLogRepository and no longer type-checks — tracked in SMS-006's fix plan (readme-docs-accuracy).

**Recommended status:** `resolved`

#### YL-003 — Closed matcher DSL and fixed combining algorithms cap model flexibility
`medium` / `architecture` / `qadi-upstream` · [.issues/medium/YL-003-yang-luo.md](../../.issues/medium/YL-003-yang-luo.md)

**Verdict:** WONTFIX-CANDIDATE (confidence: high)

**Evidence at HEAD:**

- `node_modules/.pnpm/@qadi+core@0.7.0/node_modules/@qadi/core/src/Policy.ts:90` — Closed set, as described.
  ```
  export const Combining = Schema.Literals([
    "FirstApplicable",
    "DenyOverrides",
    "PermitOverrides",
  ]);
  ```
- `../qadi/spec/decisions/023-combining-algorithms.md:173` — Deliberate, ADR-recorded upstream design (total evaluation, exhaustive traces, untrusted-JSON decodability); the auditor itself calls it 'deliberate and defensible'. Belongs to ../qadi, not awthaq; no consumer demand for custom combining exists in this repo.
  ```
  ### What is not added
  
  No new error, no new matcher, no service, nothing in `@qadi/react`, and **not the
  full XACML catalogue**. ... *parity with a standard is not a goal; expressiveness is.*
  ```

**Fix plan:** No fix planned — see evidence notes for the rationale.

**Recommended status:** `wontfix`

#### MTS-007 — minimumReleaseAgeExclude block configures exclusions for a gate that is not enabled
low · compliance · repo · [.issues/low/MTS-007-monorepo-tooling-specialist.md](../../.issues/low/MTS-007-monorepo-tooling-specialist.md)
**Verdict:** INVALID (high confidence).
**Evidence at HEAD:** `package.json:52` has `"packageManager": "pnpm@11.20.0"`. pnpm 11.20.0's `CHANGELOG.md:1176` (installed toolchain) says:
```
- Changed default values: ... `minimumReleaseAge` is now `1440` (1 day) ... Newly published packages will not be resolved until they are at least 1 day old. ... To opt out, set `minimumReleaseAge: 0`
```
`CHANGELOG.md:888` adds: "**Loose mode** — the default, in effect whenever `minimumReleaseAge` keeps its built-in 24-hour value — auto-adds the immature picks to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`". The block at `pnpm-workspace.yaml:38-50` is exactly that auto-written list, so the gate is active by default.
**Rationale:** there's no defect. Optional hygiene: add a YAML comment saying the list is auto-maintained by pnpm 11's default 1440-minute gate, and consider `minimumReleaseAgeStrict: true`.
**Recommended status:** wontfix

#### TC-008 — No Related Origin Requests support for multi-origin passkey deployments
`info` / `api` / `repo` · [.issues/info/TC-008-tim-cappalli.md](../../.issues/info/TC-008-tim-cappalli.md)

**Verdict:** WONTFIX-CANDIDATE (confidence: high)

**Evidence at HEAD:**

- `.scratch/passkey/spec.md:357` — Accurate, documented deferral; no `/.well-known/webauthn` anywhere in packages/*/src.
  ```
  - Related Origin Requests (multi-domain passkeys via
    `/.well-known/webauthn`) — not mentioned in `spec/behaviors/17-passkey.md`
    and not requested; revisit if a real multi-domain deployment need arises.
  ```
- `packages/passkey/src/Passkey.ts:145` — Multi-registrable-domain origins are outside the current normative model entirely, so ROR is a new feature, not a gap; the auditor labels it 'an observation, not a defect'. Building it now would be speculative infra with no consumer.
  ```
  /** BEH-EA-133: `rpId` MUST be validated as a registrable-domain suffix of the origin, never a bare host match. */
  ```

**Fix plan:** No fix planned — see evidence notes for the rationale.

**Recommended status:** `wontfix`

#### MM-008 — no-unused-internal lint rule dark under TS7 (honestly documented)
`info` / `dx` / `repo` · [.issues/info/MM-008-mattia-manzati.md](../../.issues/info/MM-008-mattia-manzati.md)

**Verdict:** WONTFIX-CANDIDATE (confidence: high)

**Evidence at HEAD:**

- `tools/oxc/index.ts:11` — Still accurate at HEAD; typescript 7.0.2 root export is only `.`/`./unstable/*`.
  ```
  // Registered but NOT enabled in .oxlintrc.json — it drives TypeScript's
  // classic compiler API (ts.createSourceFile, ts.SyntaxKind, ...), which no
  // longer exists at `typescript`'s top-level import under the tsgo/Corsa
  ```
- `tools/oxc/rules/no-unused-internal.ts:4` — Vendored verbatim from ../effect/packages/tools/oxc (upstream still uses the classic API at its HEAD).
  ```
  import ts from "typescript"
  ```
- `packages/*/src` — The rule only polices `@internal`-tagged exports; this repo has zero, so enabling it would enforce nothing today. Unused exports are already caught by `pnpm knip`.
  ```
  grep -rn '@internal' packages/*/src | wc -l  →  0
  ```

**Fix plan:** No fix planned — see evidence notes for the rationale.

**Recommended status:** `wontfix`

## Closed without work

| ID | level | verdict | reason | evidence |
|---|---|---|---|---|
| MTS-006 | medium | DUPLICATE of MM-006 | Same tag-pinned release.yml actions; its CI-gating recommendation is folded into MM-006 | `.github/workflows/release.yml:44-45` |
| AH-005 (anders-hejlsberg) | medium | DUPLICATE of DESS-005 | Same stale Sep-12 metrics snapshot | `.quality-metrics/oauth.json:8`; `packages/oauth/src/OAuthProvider.ts:142` |
| TTE-007 | low | DUPLICATE of DESS-005 | Same stale snapshot; no in-repo extractor to fix | `.quality-metrics/core.json:8,15`; `packages/core/src/Users.ts:48-49` |
| TS-006 (tim-smart) | low | DUPLICATE of DESS-005 | Same stale snapshot | `.quality-metrics/server.json:42-44` |
| ETVS-007 | low | DUPLICATE of MM-004 | Same missing thresholds; the qadi pointer is ambiguous, not wrong | `vitest.config.ts:21-23`; `../qadi/vitest.config.ts:32` |
| NSA-009 | info | DUPLICATE of DESS-005 | Same stale snapshot | `.quality-metrics/next.json:21` |
| WPS-011 | info | DUPLICATE of DESS-005 | Same stale snapshot; banner half belongs to cross-slice BPAS-007/DTWS-001 | `.quality-metrics/passkey.json:41-43`; `spec/behaviors/17-passkey.md:15` |
| SSMS-010 | info | DUPLICATE of DESS-005 | Same stale snapshot | `.quality-metrics/sql.json:42-43` |
| MTS-007 | low | INVALID | pnpm 11 enables `minimumReleaseAge: 1440` by default, and the exclude list is its auto-written loose-mode output | `package.json:52`; pnpm 11.20.0 `CHANGELOG.md:1176`, `:888` |
| MM-008 | info | WONTFIX-CANDIDATE | Vendored rule polices `@internal` tags; repo has zero; knip covers unused exports; documented at registration site. | `packages/*/src` |
| YL-007 | low | DUPLICATE (-> PCS-001) | Per-request decisionCacheLayer wiring is PCS-001's resolved plan (wayfinder 12); flattenAll-per-resolution is mandated by BEH-EA-139. | `spec/appendices/02-qadi-path-a-end-to-end.md:59` |
| RRM-008 | info | DUPLICATE (-> YL-006) | Same root cause/fix as YL-006. | `node_modules/.pnpm/@qadi+core@0.7.0/node_modules/@qadi/core/src/Evaluate.ts:823` |
| YL-003 | medium | WONTFIX-CANDIDATE | Deliberate, ADR-QD-023-recorded qadi design; upstream repo; no awthaq demand. | `../qadi/spec/decisions/023-combining-algorithms.md:173` |
| TC-008 | info | WONTFIX-CANDIDATE | Documented deferral; multi-registrable-domain RPs outside BEH-EA-133's model; speculative without a deployment. | `packages/passkey/src/Passkey.ts:145` |
| DAG-001 | info | DUPLICATE (-> DAG-005) | Phase-3 per roadmap; its only actionable ask equals DAG-005's fix. | `.issues/medium/DAG-005-device-authorization-grant-specialist.md:35` |
| CWM-007 | low | DUPLICATE | Same line/root cause as DTWS-003; extra asks folded into its plan | `README.md:232` |
| IC-005 | low | DUPLICATE | Same line/root cause as CSS-005; extra asks folded into its plan | `README.md:182` |
| BCR-007 | medium | INVALID | better-auth/ is non-normative; awthaq's spec/models/06 + wayfinder 05 already mandate hashed single-use recovery codes | `better-auth/05-mfa-and-verification/01-two-factor.md:304` |
| ALF-008 | medium | ALREADY-FIXED | AuditLog written inline by AuthEvents.publish (6bd3f1d); example composes AuditLog.layerMemory. README residual → SMS-006 | `packages/core/src/AuthEvents.ts:341` |
| TS-005 (torin-sandall) | medium | DUPLICATE → AH-003 | 94 authorization-bridge BDD scenarios have no executable step definiti… same root cause as AH-003 | `features/features/06-roles-and-authorization-bridge/19-qadi-bridge-path-a.feature:7` |
| THS-006 | medium | DUPLICATE → THS-001 | BEH-EA-110 default rate-limit rule for /two-factor/verify exists only … same root cause as THS-001 | `packages/two-factor/src/index.ts:8` |
| BDD-006 | medium | DUPLICATE → AH-006 | README's pre-implementation claims contradict the wired suite it intro… same root cause as AH-006 | `features/README.md:5` |
| BDD-004 | medium | DUPLICATE → AH-006 | STYLE.md's central premise and prohibitions are falsified by current p… same root cause as AH-006 | `features/STYLE.md:9` |
| ETVS-008 | low | DUPLICATE → AH-003 | BDD↔unit layering exemplary where wired, but 21 of 27 feature files ne… same root cause as AH-003 | `features/vitest.config.ts:20` |
| CWM-006 | low | DUPLICATE → MTI-011 | Organization plugin has no BDD feature file — the deepest plugin's lif… same root cause as MTI-011 | `features/traceability.md:474` |
| BDD-009 | info | DUPLICATE → AH-005 | Sessions acceptance file is 75% @skip — mostly intent, little executab… same root cause as AH-005 | `features/features/02-domain/07-sessions.feature:97` |

## Cross-slice notes

- **Duplicates pointing outside this manifest:** THS-006 → THS-001 (two-factor slice), YL-007 → PCS-001 (qadi-bridge slice, wayfinder 12).
- **Blocked by other slices:** AAPS-005 and PCS-005 are blocked by PCS-001/RZS-002. OCM-004 is blocked by OCM-001/SCP-002 (api-key). EOTS-006 is blocked by MW-001 (wayfinder 27). AH-004 (anders-hejlsberg) is blocked by oauth ESS-002/TTE-002/TTE-003: GC-001 is marked resolved, yet `OAuth.ts:250`, `:712` and `OAuthTokenAccess.ts:93` still cast untrusted JSON.
- **Must be edited together:** ECS-003 and ECS-002/CTA-003 have to land in the same `spec/behaviors/26-cli.md` edit as wayfinder 06 (CTA-002/DAG-003), and they feed wayfinder 07 (BE-003/BAM-001). AVS-002 depends on AVS-009's versioning policy. WPS-011's stale spec banner half overlaps BPAS-007/DTWS-001.
- **Shared file:** `scripts/circular.mjs` is touched by both MTS-009 and ELC-003 (dev-scripts-tooling), so do MTS-009 first.
- **Possibly already fixed elsewhere:** AH-007 (anders-hejlsberg, not in this manifest) cites a construct that is no longer in `packages/core/src`.

*From validation part B:*

- YL-007 -> PCS-001 (and RZS-002); AAPS-005 depends on them. DAG-001 -> DAG-005 (sibling fork part C).
- AH-004 depends on oauth-slice ESS-002 / TTE-002 / TTE-003; GC-001 is marked resolved but OAuth.ts:250, :712 and OAuthTokenAccess.ts:93 still cast untrusted JSON — flag for the oauth slice.
- AH-007 (anders-hejlsberg, not in this manifest) cites a Sessions supersedes-path assertion that no longer appears in packages/core/src — likely already fixed.
- ELC-003 shares scripts/circular.mjs with MTS-009 (sibling fork part A, dev-scripts-tooling).
- packages/roles/README.md is a stale 'planned package' stub — overlaps readme-docs-accuracy (sibling fork part C).
- ESA-003's fixed half came from 6bd3f1d (ALF-001/ESA-001/ESS-002/CSG-004/EP-002); TC-004's fixed half from 0441226 (BPAS-002).

*From validation part E:*

- Related, already resolved elsewhere: TIR-004 (closed as dup of ARF-001, 90a2ddf — the transaction TIR-005 should test), CSD-001 (fixed 25d991e — the defect CSD-009's scenario should guard).
- ECS-003 must be applied in the same 26-cli.md edit as ticket 06's BEH-EA-208 amendment (CTA-002/DAG-003); ECS-002/CTA-003 feed ticket 07's implementation (BE-003/BAM-001). Not duplicates — distinct clauses of the same spec section.
