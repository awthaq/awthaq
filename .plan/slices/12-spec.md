# Slice 12-spec — validation & fix plan

- **Slice:** `12-spec` (64 issues whose source is under `spec/` — behaviors, models, decisions, roadmap, invariants, appendices, process)
- **Validated at:** `ec065a7` · **Date:** 2026-09-29
- **Manifest:** `.plan/_manifests/12-spec.tsv` · machine-readable twin: `.plan/slices/12-spec.json`

## Counts (verdict × level)

| Verdict | high | medium | low | info | Total |
|---|---|---|---|---|---|
| CONFIRMED | 8 | 19 | 12 | 5 | 44 |
| PARTIAL | 0 | 5 | 1 | 2 | 8 |
| ALREADY-FIXED | 0 | 0 | 0 | 0 | 0 |
| INVALID | 0 | 0 | 0 | 0 | 0 |
| DUPLICATE | 2 | 1 | 4 | 4 | 11 |
| WONTFIX-CANDIDATE | 0 | 0 | 0 | 1 | 1 |
| **Total** | 10 | 25 | 17 | 12 | **64** |

## Summary

What is really wrong in the spec/ area splits three ways. (1) **Stale status prose everywhere**: the tree-level banners (README, overview, glossary, urs, invariants, traceability), the adoption matrix, the roadmap's gate section, definitions-of-done, and roughly two dozen behavior/model headers still say 'pre-implementation / no code exists' while ~18 packages ship tested code — and several behavior examples (BEH-EA-189 `withNextCookies`, BEH-EA-185 `getSession`, BEH-EA-161 `u.plan`) no longer compile against the shipped API; a mechanical stale-phrase check in `spec/scripts/verify-traceability.sh` stops it regressing. (2) **Decided-but-unwritten design**: the 2026-09-19 decision tickets (06 CLI login carve-out, 07 CLI/import, 08 SAML/SCIM, 12 qadi cache scope, 18 tenancy, 05 MFA, 21 legacy verifiers) resolved most open questions, but none of those outcomes has reached spec/ yet — BEH-EA-208 still bars login, the qadi appendix still wires an app-scoped cache with no invalidation (the one live security hazard in this slice, PCS-001), 06-two-factor-totp.md still lists secret encryption/challenge/lockout/SMS as undecided, 07-api-keys.md still leaves rotation and transport open (the only genuinely open decision, OCM-005). (3) **Real code gaps surfaced through spec findings**: Sessions.layerSql supersession is still two unwrapped statements (RRS-004 — now a false reuse-detection trigger), session lifecycle events are published only by Password (ESA-006), the BEH-EA-199 redaction check was never built (SMS-003), plugins capture config at Layer build so per-tenant config is impossible (EP-007), jwt/organization ship without behaviors or features (BDD-005), and the A2 group found `UserAttributes` lacks the BEH-EA-161 defect catch and `KeyRing.rotateNow` keeps a compromised key valid for the full grace period. Note BDD-005's premise is overstated: two-factor, magic-link and api-key are still empty placeholders.

## Workstreams

Order hint = suggested execution order across the slice (1 = first). Workstreams from the docs-drift groups are rendered from their own authoring; all share the same schema in the JSON.

| # | Workstream | IDs | Effort | Depends on |
|---|---|---|---|---|
| 1 | `session-supersede-atomicity` — Transactional session supersession | RRS-004 | S | — |
| 2 | `qadi-decision-cache-invalidation` — Request-scoped qadi decision cache + opt-in invalidation bridge | PCS-001, RZS-002, RZS-008 | M | — |
| 3 | `spec-status-banner-sweep` — Replace stale 'pre-implementation / no code exists' banners across spec/ and guard them mechanically | DTWS-001, AOMS-011, OCM-008, IDS-009 | M | — |
| 4 | `spec-bdd-traceability-refresh` — Make the BDD/traceability/invariants records describe the suite and tests that actually exist | DTWS-006, BDD-003, TMS-009, DTWS-007 | M | spec-status-banner-sweep |
| 5 | `spec-behavior-code-reconcile` — Reconcile behavior/model spec text with shipped code semantics (next, react, passkey, qadi resolvers) | NAM-010, BO-008, IC-006, BPAS-007, HSK-009, RSC-008, AAPS-007, RZS-007 | M | spec-status-banner-sweep |
| 6 | `session-lifecycle-events` — Sessions publishes issue/revoke/expire events for every path | ESA-006 | M | — |
| 7 | `cli-session-login-carveout` — BEH-EA-208 session-command carve-out and CLI credential storage | CTA-002, DAG-003, CTA-004 | M | — |
| 8 | `cli-exit-code-and-arg-contract` — CLI process contract: typed exit codes and Schema-bound arguments | ECS-001, ECS-007 | M | — |
| 9 | `spec-roadmap-status-reconcile` — Reconcile gate/milestone status between definitions-of-done.md and roadmap.md | MM-005, DTWS-005 | S | — |
| 10 | `spec-surface-inventory-reconcile` — Reconcile ADR/overview surface inventories with shipped exports and endpoints (DoD gate 10) | AVS-008, DTWS-008 | M | spec-status-banner-sweep |
| 11 | `jwt-key-rotation-runbook` — ADR-EA-017 for JWT signing-key rotation + emergency retire-now + model 08 rewrite | KRS-008, MAPS-009, VB-007 | M | spec-status-banner-sweep |
| 12 | `mfa-two-factor-hardening` — Two-factor state ADRs (secret encryption, challenge, lockout, SMS posture) + coverage | THS-004, THS-007, BCR-006, SOS-006, BCR-010 | M | — |
| 13 | `cli-doctor-hardening` — doctor redaction + static config descriptors + effective-config view (ADR-006 reconciliation) | ECS-005, ECS-008, EP-009 | L | cli-exit-code-and-arg-contract |
| 14 | `cli-migration-guardrails` — migration status/apply plan preview and drift refusal | ECS-009 | M | cli-exit-code-and-arg-contract |
| 15 | `cli-seed-admin-audit` — seed admin publishes audited admin-grant events | ECS-006 | S | — |
| 16 | `redaction-guarantee-check` — BEH-EA-199 canary-based redaction probe in @awthaq/test | SMS-003 | L | — |
| 17 | `device-authorization-design` — Device-authorization security parameters and scenarios | DAG-004, DAG-007, DAG-006 | S | cli-session-login-carveout |
| 18 | `m2m-client-secret-lifecycle` — API-key / client-secret rotation and transport ADR | OCM-005 | S | — |
| 19 | `bdd-plugin-coverage` — Behaviors + features for shipped jwt and organization | BDD-005 | L | jwt-key-rotation-runbook |
| 20 | `cli-import-tooling` — better-auth import via SourceAdapter (decision 07) | BAM-001 | XL | cli-exit-code-and-arg-contract |
| 21 | `native-bearer-bootstrap` — Native/mobile bearer path: document what exists now, finish issuance under MNA-001 | MNA-009 | S | — |
| 22 | `verification-timing-uniformity` — BEH-EA-064 latency-uniformity clause | MLO-008 | S | — |
| 23 | `password-hasher-legacy-recipes` — ADR-010 correction + Supabase bcrypt recipe | SAM-002 | S | — |
| 24 | `sqlite-ops-docs` — Embedded SQLite operations guide | SEA-003 | S | — |
| 25 | `multi-tenant-composition` — Tenancy = Organization row, per-request tenant config (decision 18) | EP-001, EP-007 | XL | — |
| 26 | `enterprise-federation-saml-scim` — SAML SP + SCIM packages: ADR, contracts, port, validation chain (decision 08) | AOMS-009, CWM-002, SFS-003, SFS-006, SFS-007, SFS-001, SFS-008, SCP-009 | XL | multi-tenant-composition |

### Workstream: `session-supersede-atomicity` — Transactional session supersession

- **IDs closed:** RRS-004
- **Effort:** S · **Order hint:** 1 · **Depends on workstreams:** none
- **Why grouped:** Single-file correctness fix + ADR-016 reference.

**Ordered steps**

_RRS-004:_ Wrap the tombstone + insert pair in one transaction via the SqlTransaction port, and update ADR-016's reference.
1. packages/core/src/Sessions.ts layerSql: add `SqlTransaction.SqlTransaction` to the Layer requirements (type param at line ~645) and wrap the supersedes tombstone and `repo.insert` in `sqlTransaction.withTransaction(Effect.gen(...))` (only when supersedes is set). Verify composition roots/TestAuth already provide SqlTransaction (packages/sql provides a live layer; ports has layerNoop for memory).
2. Alternatively (if adding a requirement ripples too far) push the pair into a single repository method `SessionsRepository.supersede(tombstoneInput, insertInput)` in packages/sql/src/Repositories.ts that runs both inside `sql.withTransaction` — pick the port route to match ADR-016 rev 1.0's validated mechanism.
3. spec/decisions/016-verification-sql-claiming.md: bump revision; change line 48 to note Sessions' supersedes is now transactional (RRS-004).
4. spec/behaviors/07-sessions.md: add to the rotation behavior (BEH-EA-053) that supersession is atomic.

**Test plan:**
- First failing test: packages/sql/test/Repositories.test.ts (or packages/core/test/Sessions.test.ts with the SQLite layer) 'issue({supersedes}) rolls back the tombstone when the insert fails' — inject a SessionsRepository whose insert fails, then assert the old token still verifies and no auth.session.reuse is published.

**Acceptance:**
- No code path can leave a tombstoned session without its successor; ADR-016 no longer cites an unwrapped precedent.

**Cross-issue / cross-slice deps:** none

### Workstream: `qadi-decision-cache-invalidation` — Request-scoped qadi decision cache + opt-in invalidation bridge

- **IDs closed:** PCS-001, RZS-002, RZS-008
- **Effort:** M · **Order hint:** 2 · **Depends on workstreams:** none
- **Why grouped:** Same appendix line and decision ticket 12; RZS-008's consistency-contract doc belongs beside it.

**Ordered steps**

_PCS-001:_ Implement decision ticket 12: move decisionCacheLayer to per-request scope in the canonical wiring (Path A middleware / Path B extractor), and ship an opt-in `DecisionCacheInvalidationLive` in @awthaq/qadi that taps every OrganizationHooks observe point and calls DecisionCache.clear, documented as mandatory for app-scoped caches, with the coverage caveat.
1. spec/appendices/02-qadi-path-a-end-to-end.md: remove `decisionCacheLayer` from QadiLive (line 59); show it provided around each request's handler (in the AuthorizedSubject middleware's request scope) with a comment quoting DecisionCache's own 'per-request scope is safe against both' note; add a boxed 'Application-scoped cache' variant that also provides DecisionCacheInvalidationLive, plus the caveat that application-owned AttributeResolver/RelationshipResolver data must clear the cache itself. Bump appendix revision.
2. packages/qadi/src/DecisionCacheInvalidation.ts (new): `DecisionCacheInvalidationLive` = Layer that `yield*`s DecisionCache from @qadi/core and taps AfterAddMember, AfterRemoveMember, AfterUpdateMemberRole, AfterDeleteOrganization, AfterAddTeamMember, AfterRemoveTeamMember, AfterUpdateTeam, AfterDeleteTeam via HookPoint `.tap`, each calling `cache.clear`. Doc comment carries the coverage caveat. Export from packages/qadi/src/index.ts. (packages/qadi must then depend on @awthaq/organization's hook points — if that creates a cycle, place the module in packages/organization as `OrganizationQadi.DecisionCacheInvalidationLive` instead, next to OrganizationQadi.relationships.)
3. Path A/Path B helpers: add an optional `decisionCache: { capacity }` option to AuthorizedSubjectLive / SubjectExtractorLive (packages/qadi/src/AuthorizedSubject.ts, SubjectExtractor.ts) that provides decisionCacheLayer per request, so the safe scope is one flag rather than hand-wiring.
4. spec/behaviors/19-qadi-bridge-path-a.md / 20-qadi-bridge-path-b.md: add a requirement (next free BEH id) that the bridge's decision cache, when enabled, is request-scoped unless paired with DecisionCacheInvalidationLive.

_RZS-008:_ Document the consistency contract at the resolver seam alongside the cache fix: relationship answers are as fresh as the records layer; a request-scoped cache preserves that, an app-scoped one needs the invalidation bridge; swapping in a Zanzibar engine = replacing OrganizationQadi.relationships.
5. spec/behaviors/21-qadi-resolvers-obligations.md: add a 'Consistency' paragraph (non-normative) stating the above and linking PCS-001's requirement.
6. packages/qadi/README.md + packages/organization/README.md: short 'Bringing your own graph engine' section — replace the `OrganizationQadi.relationships` RelationshipResolver layer with one backed by OpenFGA/SpiceDB `check`; note membership tuples must be exported on AfterAddMember/AfterRemoveMember hooks; no worked adapter shipped (no speculative infra).

**Test plan:**
- First failing test: packages/qadi/test/DecisionCacheInvalidation.test.ts 'removing a member clears an app-scoped cache so the next check denies' — compose Organization + OrganizationQadi + app-scoped decisionCacheLayer + DecisionCacheInvalidationLive, Allow, removeMember, assert Deny.
- Control test: same without the bridge demonstrates the stale Allow (documents the hazard).
- packages/qadi/test/AuthorizedSubject.test.ts 'per-request decision cache does not survive across requests'.
- Doc-only; spec:verify:strict.

**Acceptance:**
- The canonical appendix no longer wires an app-scoped cache without invalidation.
- A revoked membership is denied on the next request under both supported wirings.
- The freshness contract and the replacement seam are written down next to the resolver behaviors.

**Cross-issue / cross-slice deps:** none

### Workstream: `spec-status-banner-sweep` — Replace stale 'pre-implementation / no code exists' banners across spec/ and guard them mechanically

- **IDs closed:** DTWS-001, AOMS-011, OCM-008
- **Effort:** M · **Order hint:** 3 · **Depends on workstreams:** none
- **Why grouped:** One root cause: every spec document was authored before code and its banner was never flipped when packages shipped. DTWS-001 owns the tree-level banners + the verify-traceability stale-phrase check; per-file IDs (AOMS-011, OCM-008 here; BPAS-007, RZS-007, RSC-008, NAM-010, BO-008, IC-006, IDS-009, HSK-009, KRS-008, MAPS-009, VB-007 in the sibling A2 group) ride on the same check.

**Ordered steps**

1. Add check 9 'stale implementation-status phrases' to `spec/scripts/verify-traceability.sh` (TDD: it fails first). Phrase list: `awthaq is pre-implementation`, `awthaq is currently **pre-implementation**`, `This describes a planned system`, `No code implementing it exists yet`, `no line of runtime source exists`, `no package.json, no source tree`, `no step-definition layer`, `no test runner`, `no milestone above has begun`, `there is no code for any gate to check`. Past tense ('was pre-implementation') is not matched. Also fix the script's own stale header comments (lines 8, 18).
2. DTWS-001: rewrite tree-level banners — spec/README.md:17 (+ :122 REQ-EA 'reserved' clause), spec/overview.md:17, spec/glossary.md:17, spec/urs.md:17, spec/invariants.md:19 (invariants banner coordinated with TMS-009) — to the roadmap.md:17 status paragraph.
3. AOMS-011: spec/models/00-adoption-matrix.md rev 1.2 — add a `Shipped-Unpublished` status; flip Password, OAuth/OIDC, Passkey, JWT, Organization, Admin; rewrite lines 17-22, 33-40, 44-48, 128-139.
4. OCM-008: spec/models/07-api-keys.md:23 and :99-101 — plugin still unimplemented, but ApiKeyPrincipal/CurrentPrincipal exist.
5. Un-audited files with the same banner that check 9 will also flag (sweep them in the same PR so the check can go green): behaviors/01,02,03,04,05,06,07,08,09,10,11,12,13,14,15,16,18,19,20,22,25,26 (line 15 or 17 each) and models/05-email-otp.md:22, 06-two-factor-totp.md:21, 14-organization.md:25, 15-admin-impersonation.md:22; spec/traceability.md:17 and :255 (§7 coverage — `pnpm coverage` exists); features/README.md:5. For genuinely unimplemented subjects (magic-link, email-otp, two-factor, api-key, cli behaviors 26) keep an accurate 'this plugin is not implemented yet' line instead of 'awthaq is pre-implementation'.
6. Sibling-group IDs BPAS-007, RZS-007, RSC-008, NAM-010/BO-008/IC-006, IDS-009, HSK-009, KRS-008/MAPS-009/VB-007 edit behaviors/17,21,23,24,27 and models/03,08 under this same check.
7. Every touched document: bump Revision + Change History row with the next free CCR id (CCR-EA-006 is the next unused at HEAD; one CCR for the whole sweep is fine).

**Test plan:** `pnpm run spec:verify:strict` — check 9 red before, green after. No BEH/feature changes (banners are non-normative).

**Acceptance:** `grep -rn 'awthaq is pre-implementation\|This describes a planned system\|No code implementing it exists yet' spec/ features/README.md` is empty; `pnpm check` green.

**Cross-workstream deps:** None upstream. spec-bdd-traceability-refresh and spec-surface-inventory-reconcile reuse check 9's framework and the overview/invariants revision bumps.

### Workstream: spec-status-banner-sweep (A2 contribution)

**Title:** Replace stale pre-implementation banners across spec/, package READMEs and feature headers
**IDs closed (from A2):** IDS-009 — the rest of this workstream (spec/README.md, overview, glossary, invariants banner, adoption matrix) comes from sibling issues DTWS-001, TMS-009, DTWS-007, AOMS-011.
**Why grouped:** one convention ("Implemented in packages/X (files); tests …" replacing "No code implementing it exists yet") should be defined once and applied everywhere. At HEAD, 20 of 21 package READMEs, 26 feature-file headers and ~20 behavior/model files still carry the banner (`grep -rln "pre-implementation" spec packages/*/README.md features/features`). The only README already fixed is `packages/next/README.md`.
**Ordered steps (A2 part):**
1. `spec/behaviors/27-admin-impersonation.md`: bump Revision to 1.1 and replace the line-15 banner with pointers to `packages/admin` and its tests.
2. `spec/invariants.md` INV-EA-014 Enforcement (line 157): name the existing tests. Land this in the same invariants.md revision as DTWS-007/TMS-009.
3. `spec/models/15-admin-impersonation.md`: replace the "Nothing described here exists yet" status text.
4. `packages/admin/README.md`: replace the banner.
**Test plan:** doc-only; `pnpm run spec:verify:strict`.
**Acceptance:** `grep -n "pre-implementation\|remains unimplemented" spec/behaviors/27-admin-impersonation.md spec/invariants.md spec/models/15-admin-impersonation.md packages/admin/README.md` returns nothing about Admin.
**Effort:** S for the A2 part (M for the whole sweep). **Cross-deps:** it defines the model-status value "Implemented" that HSK-009 and KRS-008 use (AOMS-011 adds it to `00-adoption-matrix.md` §1).

### Workstream: `spec-bdd-traceability-refresh` — Make the BDD/traceability/invariants records describe the suite and tests that actually exist

- **IDs closed:** DTWS-006, BDD-003, TMS-009, DTWS-007
- **Effort:** M · **Order hint:** 4 · **Depends on workstreams:** spec-status-banner-sweep
- **Why grouped:** All four are verification-record drift: README/traceability/features README say the suite doesn't run; manifest headers/ranges lag the 6887fb5 re-allocation; invariants Enforcement cells call existing tests missing. Same files (spec/traceability.md, spec/invariants.md, verify-traceability.sh) and the same fix pattern (rewrite + add a mechanical check).

**Ordered steps**

1. DTWS-006: rewrite spec/README.md:126, spec/traceability.md:215, features/README.md:5, spec/process/definitions-of-done.md:88-91 to describe the running suite (vitest + @effect-cucumber/vitest, `pnpm test:bdd` in `pnpm check`, 6 wired / 22 `@skip @unwired` feature files per ticket 36); re-state which of BEH-EA-193..200 packages/test actually implements.
2. BDD-003: bump features/traceability.md Document Control to 1.1 (and make allocate-req-ea.py emit it); fix spec/traceability.md:8-9 Revision/Effective Date to 1.4/2026-09-20; replace residual '602' ranges (requirement-id-scheme.md:36,:47; definitions-of-done.md:86; verify-traceability.sh:167,:173); add `allocate-req-ea.py --check` and wire it as check 4b.
3. TMS-009 (+DTWS-007 dup): rewrite invariants.md:19/:77/:79 and every Enforcement cell INV-EA-007..016 against real tests (existing: core Sessions/Verification, qadi AuthorizedSubject, admin Admin, oauth OAuth; missing: client Csrf.test-d.ts → cite Csrf.test.ts; qadi RequirePermission.test.ts; sql MigrationOwnership.test.ts); mirror in spec/traceability.md §1/§5 (e.g. :206-207); add check 10 (cited test paths vs filesystem).

**Test plan:** TDD via verify-traceability.sh: check 4b (manifest drift) and check 10 (enforcement-cell paths) written first and red; `pnpm run spec:verify:strict` and `pnpm run test:bdd` green after.

**Acceptance:** No doc says the BDD suite can't run; manifest + traceability Revision fields match their Change History; every invariant Enforcement cell cites a file that exists or explicitly says no test exists; manifest drift fails CI.

**Cross-workstream deps:** After spec-status-banner-sweep (shares check 9 phrase list and the invariants banner). Related cross-slice: AH-003/BDD-002 (wiring the 22 unwired files, ticket 36) — README counts must be updated again as files get wired.

### Workstream: spec-behavior-code-reconcile

**Title:** Reconcile behavior/model spec text with shipped code semantics (next, react, passkey, qadi resolvers)
**IDs closed:** NAM-010 (canonical; BO-008 and IC-006 are duplicates), BPAS-007, HSK-009, RSC-008, AAPS-007, RZS-007
**Why grouped:** in each of these files the banner is stale, and at least one normative example or claim also contradicts shipped code:
- BEH-EA-185/189/190 show call shapes that don't match `@awthaq/next`.
- BEH-EA-177's example uses Providers props that `@awthaq/react` doesn't have.
- The passkey Conditional Create and UV policy have no BEH id.
- Model 03 quotes a 2-minute TTL; the code uses 5 minutes.
- BEH-EA-161 resolves `u.plan`, and UserRecord has no `plan` field.

Handle each file in one pass with one Revision bump, and use the banner wording that spec-status-banner-sweep sets.

**Direction of each fix (spec or code):**
- **next / react:** the spec follows the code. The implementation decisions are recorded in `.scratch/next-package/spec.md` ("withNextCookies shape and scope") and in `packages/react/src/index.ts`.
- **Passkey:** the spec follows the code. CB-001 already made the UV policy config-gated in commit 1f2df3a.
- **BEH-EA-161:**
  - The attribute set: the spec follows the code. There is no billing plugin, so don't invent a `plan` field.
  - The failure contract: the code follows the spec. `UserAttributes` lets a SqlError defect escape instead of returning `AttributeResolveError`.
- **BEH-EA-162:** the code follows the spec. Ticket 13 / RZS-001 implement the depth walk.

**Ordered steps:**
1. AAPS-007 code fix. Write the red test in `packages/qadi/test/Resolvers.test.ts`, then add `catchDefect` to `UserAttributes`.
2. Spec edits, one file each: 24-nextjs-ssr.md (NAM-010), 23-react.md plus the react README (RSC-008), 17-passkey.md plus the README and feature (BPAS-007), models/03 (HSK-009), and 21-qadi-resolvers-obligations.md BEH-EA-161 plus the line-85 paragraph (AAPS-007).
3. After RZS-001 lands: fix the 21-qadi-resolvers-obligations.md banner and the BEH-EA-162 prose (RZS-007).
4. Allocate the new passkey BEH ids (BEH-EA-221+ at HEAD; re-check the max, because the CLI carve-out may take ids too). Then update `spec/behaviors/index.yaml`, `spec/traceability.md` and the REQ-EA allocation (`features/scripts/allocate-req-ea.py`).

**Test plan:**
- New unit test: `packages/qadi/test/Resolvers.test.ts` — "a Users.findById defect surfaces as AttributeResolveError, never undefined".
- New BDD characterization scenarios in `17-passkey.feature` for Conditional Create.
- Commands: `pnpm run test`, `pnpm run test:bdd`, `pnpm run spec:verify:strict` (check #8 requires contiguous BEH-EA ids).

**Acceptance:**
- No pre-implementation banner remains in 17/21/23/24.
- No `u.plan`, `withNextCookies(Users`, `getSession({` or `two-minute` anywhere in spec/.
- The Conditional Create and UV policy have a BEH id.
- `pnpm check` passes.

**Effort:** M in total. **Cross-deps:**
- Needs spec-status-banner-sweep (banner convention and the "Implemented" status value, via AOMS-011).
- RZS-007 is blocked by RZS-001 (another slice, organization/qadi).

### Workstream: `session-lifecycle-events` — Sessions publishes issue/revoke/expire events for every path

- **IDs closed:** ESA-006
- **Effort:** M · **Order hint:** 6 · **Depends on workstreams:** none
- **Why grouped:** Completes ALF-004's password-only publication.

**Ordered steps**

_ESA-006:_ Move session lifecycle publication into the Sessions service itself (both layers) so every issuance/revocation path — OAuth, passkey, admin impersonation, sign-out, revokeAll — emits, with a reason, and drop the plugin-level duplicates in Password.
1. packages/core/src/AuthEvents.ts: widen `SessionIssuedEvent` with `familyId` and optional `actingAs`; widen `SessionRevokedEvent` to `{ userId; sessionId?: string; scope: "one" | "others" | "all"; reason: "signOut" | "passwordChanged" | "passwordReset" | "admin" | "reuseDetected" | "superseded" | "userDeleted" }`; add `SessionExpiredEvent` (`auth.session.expired`, published lazily when verify observes idle/absolute expiry).
2. packages/core/src/Sessions.ts: `issue`, `revoke`, `revokeOthers`, `revokeAll` in layerMemory and layerSql publish via the already-injected `events` (layerSql line ~653). Add an optional `reason` to revoke/revokeOthers/revokeAll inputs (default "signOut"/"admin") so callers can label; verify publishes expired.
3. packages/password/src/Password.ts: delete the now-duplicate publishes at 766, 873, 1033, 1139, 1147, passing reasons instead.
4. AuditLog `actorOf` (packages/core/src/AuditLog.ts:74) updated for the widened tags (compiler-forced).
5. spec/behaviors/13-events.md BEH-EA-101: refresh the example registry list to the shipped tags and add a requirement (or note) that session issue/revoke/expiry events are published by Sessions itself; spec/behaviors/07-sessions.md: cross-link.

**Test plan:**
- First failing test: packages/core/test/Sessions.test.ts 'revoke publishes auth.session.revoked with reason signOut' and 'issue publishes auth.session.issued' for both layerMemory and layerSql (collect AuthEvents.stream).
- packages/oauth/test: 'OAuth callback sign-in emits exactly one auth.session.issued' (guards against double-publish).
- BDD: features/features/02-domain/07-sessions.feature new scenario 'signing out records a session-revoked audit entry'.

**Acceptance:**
- Every session create/end path emits exactly one typed event and lands in AuditLog.
- Password no longer publishes session events itself.

**Cross-issue / cross-slice deps:** none

### Workstream: `cli-session-login-carveout` — BEH-EA-208 session-command carve-out and CLI credential storage

- **IDs closed:** CTA-002, DAG-003, CTA-004
- **Effort:** M · **Order hint:** 7 · **Depends on workstreams:** none
- **Why grouped:** Decision ticket 06 resolves the boundary and the CredentialStore together; both are spec prerequisites for the CLI login build (CTA-001/DAG-002 cross-slice).

**Ordered steps**

_CTA-002:_ Apply decision ticket 06 verbatim: amend BEH-EA-208 so it scopes to *inspection* commands and carve out a `login`/`logout`/`whoami` session-command family that is an outbound-only client of a running server (never a listener, never inbound), add a new behavior for that family, and cross-link spec/models/13-device-authorization.md.
1. spec/behaviors/26-cli.md: bump Revision 1.2 -> 1.3, Effective Date 2026-09-29, Change History '1.3: Scoped BEH-EA-208 to inspection commands and carved out the session command family (login/logout/whoami) as outbound-only network clients, resolving CTA-002/DAG-003 (CCR-EA-00N)'.
2. Replace BEH-EA-208's REQUIREMENT block with the exact wording in .scratch/resolve-ready-for-human-findings/issues/06-cli-login-vs-beh-ea-208.md §'BEH-EA-208 amendment' (inspection commands listed explicitly: doctor, plugin list --graph, routes, migration status, migration apply, openapi, seed admin, import; session commands exempt but MUST NOT start a listener or accept an inbound request). Add the explanatory sentence contrasting 'manifest-derivable' vs 'needs a live process'.
3. Add a new behavior 'BEH-EA-226: session commands (`login`, `logout`, `whoami`) are outbound-only clients of a running auth server' after BEH-EA-208 (re-check the next free id at implementation time; A2 allocates 221-223, this slice's CLI group 224-227). Content per ticket 06: `login` = device-authorization flow (POST /device/code, poll /device/token on a Schedule starting at server `interval`, `slow_down` widens the delay, `expired_token` exits non-zero with 'run awthaq login again'); `login --token <t>` / `AWTHAQ_TOKEN` non-interactive path validated against the session-introspection endpoint; `logout` clears the CredentialStore and revokes server-side; `whoami` introspects. Wire transport via `@awthaq/client`'s generated HttpApiClient (not the React/atom surface).
4. Update BEH-EA-208/226 prev/next footers, spec/behaviors/index.yaml, spec/traceability.md (new BEH row -> planned test packages/cli/test/Login.test.ts), spec/urs.md if the CLI URS row enumerates behaviors.
5. spec/models/13-device-authorization.md: bump revision; in 'What is missing' add that the CLI session-command family (BEH-EA-226) is the first consumer of `/device/code`/`/device/token`, and that the poll's eventual session issuance runs through the same `Hooks.BeforeSessionIssue` divert point (packages/core/src/Hooks.ts:69) as every other login method (ticket 03).
6. features/features/08-tooling/26-cli.feature: rewrite the 'No CLI command starts an HTTP listener or accepts a request' Scenario Outline (line ~236) to iterate only inspection commands, and add Scenarios 'login polls the device endpoint as an outbound client and never opens a listener', 'login honors slow_down', 'login exits non-zero on expired_token', 'AWTHAQ_TOKEN bypasses the device flow and the credential store' (all @skip @unwired until the CLI ships).

_CTA-004:_ Record ticket 06's CredentialStore decision normatively (new behavior next to the session-command BEH) so the login implementation cannot default to a plaintext dotfile.
7. spec/behaviors/26-cli.md: add 'BEH-EA-227: CLI credentials live in a CredentialStore, never a plaintext dotfile by default' (next free id). REQUIREMENT: session-command credentials MUST be stored through a `CredentialStore` port (get/set/clear) whose default Layer resolves, in order, macOS Keychain, Linux Secret Service (libsecret), Windows Credential Manager; only when none is reachable MAY it fall back to `$XDG_CONFIG_HOME/awthaq/credentials.json` created with mode 0600 in a 0700 directory, and the CLI MUST warn once when using the fallback; `AWTHAQ_TOKEN` (CI) always wins and MUST never be written to any store; tokens MUST be carried as `Redacted` in memory and never printed (ties to ECS-005's redaction clause).
8. Cross-reference BEH-EA-227 from spec/behaviors/09-authentication-middleware.md:55 (replace 'pulled from a keychain' with a link to BEH-EA-227 for the CLI case; mobile storage stays the app's job per ticket 17).
9. features/features/08-tooling/26-cli.feature: add @skip @unwired scenarios 'login stores the credential in the OS keychain when available', 'fallback credentials file is created 0600 and a warning is printed', 'AWTHAQ_TOKEN is never persisted'.
10. Traceability: add the BEH row -> planned test packages/cli/test/CredentialStore.test.ts.

**Test plan:**
- Spec-only change: `pnpm run spec:verify:strict` must pass with the new BEH id traced; the new Gherkin scenarios are registered (skipped) by features/features/08-tooling/26-cli.steps.test.ts so `pnpm run test:bdd` reports them.
- When the CLI lands (BE-003/CTA-001/DAG-002, cross-slice): packages/cli/test/Login.test.ts 'login never binds a socket' (assert no net.Server is created via a spy on node:net createServer) is the failing test to write first.
- Spec-only now; the first failing test at implementation time: packages/cli/test/CredentialStore.test.ts 'layerFile writes credentials.json with mode 0600' (fs.stat mode & 0o777 === 0o600) and 'AWTHAQ_TOKEN short-circuits get and set is never called'.

**Acceptance:**
- BEH-EA-208's REQUIREMENT names inspection commands explicitly and exempts login/logout/whoami with the no-listener/no-inbound clause intact.
- A BEH for the session-command family exists, is in index.yaml and traceability.md, and spec:verify:strict passes.
- 13-device-authorization.md names the CLI as its first consumer and points poll-issued sessions at BeforeSessionIssue.
- 26-cli.feature no longer asserts the blanket rule over session commands.
- 26-cli.md contains a normative CredentialStore requirement with keychain-first order, 0600 fallback, env-var precedence and a no-plaintext-by-default rule.
- spec:verify:strict passes with the new id traced.

**Cross-issue / cross-slice deps:** none

### Workstream: `cli-exit-code-and-arg-contract` — CLI process contract: typed exit codes and Schema-bound arguments

- **IDs closed:** ECS-001, ECS-007
- **Effort:** M · **Order hint:** 8 · **Depends on workstreams:** none
- **Why grouped:** Argument decode failures are one of the exit-code classes; both are cross-command contracts to fix before the CLI ships.

**Ordered steps**

_ECS-001:_ Add a normative process contract for every CLI command: a fixed exit-code table derived mechanically from each command's TaggedError `_tag` via Effect v4's `Runtime.errorExitCode`, plus one scenario per class.
1. spec/behaviors/26-cli.md: add 'BEH-EA-224: every CLI command exits with a stable, typed exit code' (next free id). Table: 0 success/clean; 1 unexpected defect; 2 usage error (CliError / argument Schema decode failure, see BEH-EA-225); 3 doctor found problems (DoctorFindings); 4 nothing to apply (`migration apply` with no pending — distinct from success so CI can branch; expose `--allow-empty` to map it to 0); 5 apply failed (MigrationFailed); 6 refused without confirmation (ConfirmationRequired: `apply` without --yes, `seed admin` against an existing admin without --force); 7 drift/ledger mismatch (LedgerDrift, ECS-009); 8 authentication required/expired (session commands, BEH-EA-226). REQUIREMENT: each typed CLI error class MUST carry its code as `[Runtime.errorExitCode]` so the mapping is compile-time, never parsed from prose; `--json` output MUST include the same `_tag` and code.
2. Amend BEH-EA-201 (doctor), 204 (migration), 206 (seed) prose to reference the table (e.g. 'doctor exits 3 when it reports any finding').
3. features/features/08-tooling/26-cli.feature: add a 'Rule: exit codes' block with one @skip @unwired Scenario per class (doctor clean -> 0; doctor finding -> 3; apply without --yes -> 6; apply with nothing pending -> 4; bad --from value -> 2).
4. Implementation (lands with the CLI skeleton BE-003): packages/cli/src/CliErrors.ts defines `DoctorFindings`, `NothingToApply`, `MigrationFailed`, `ConfirmationRequired`, `LedgerDrift`, `AuthenticationRequired` as `Schema.TaggedError` classes each with `readonly [Runtime.errorExitCode] = N` (no `as` casts; the symbol property is declared on the class). The bin entry runs the Command with `NodeRuntime.runMain`, which honors errorExitCode.
5. spec/traceability.md: map BEH-EA-224 -> packages/cli/test/ExitCodes.test.ts.

_ECS-007:_ Make 'every CLI option/argument decodes through a Schema, reusing the HTTP contract's Schemas where one exists' normative, so invalid input fails as a typed usage error (exit 2).
6. spec/behaviors/26-cli.md: add 'BEH-EA-225: CLI arguments decode through the contract's Schemas' (next free id). REQUIREMENT: every flag/argument MUST be declared with `Flag.withSchema`/`Argument.withSchema` (effect/unstable/cli); `seed admin --email` MUST reuse the same email Schema the password sign-up payload uses (packages/api); `import --from` MUST be a `Schema.Literals(["better-auth","authjs","lucia"])` whose members are the registered SourceAdapter names (decision ticket 07); `--config` MUST be a path Schema; decode failures MUST surface as the usage-error class of BEH-EA-224.
7. Amend BEH-EA-206 to name the account identifier (email, via the shared Schema) and BEH-EA-207's example to reference the literal enum.
8. features/features/08-tooling/26-cli.feature: add @skip @unwired Scenarios 'seed admin rejects a malformed email with a usage error' and 'import rejects an unknown --from value listing the supported sources'.
9. Implementation (with BE-003): export the email Schema from packages/api if it is not already exported (check packages/api/src for the sign-up payload Schema) and import it in packages/cli/src/Seed.ts; `ImportSource` literal Schema in packages/cli/src/Import.ts derived from the adapter registry keys.

**Test plan:**
- First failing test (with BE-003): packages/cli/test/ExitCodes.test.ts 'migration apply without --yes fails with ConfirmationRequired whose errorExitCode is 6' and 'doctor on an insecure config fails with exit code 3' — run the Command in-process and assert `Exit` failure's error[Runtime.errorExitCode].
- BDD: the new 26-cli.feature exit-code Rule (skipped until wired).
- First failing test (with BE-003): packages/cli/test/Arguments.test.ts 'seed admin --email not-an-email fails with a usage error (exit 2) before any service is built'.

**Acceptance:**
- 26-cli.md has one exit-code table referenced by BEH-EA-201/204/206/207/226.
- Every CLI error class carries its exit code as a typed property; no command sets `process.exitCode` by hand.
- spec:verify:strict passes.
- 26-cli.md requires Schema-bound arguments and names the shared Schemas.
- No hand-rolled string parsing in packages/cli (review + `grep -n "split(\|parseInt" packages/cli/src` clean).

**Cross-issue / cross-slice deps:** none

### Workstream: `spec-roadmap-status-reconcile` — Reconcile gate/milestone status between definitions-of-done.md and roadmap.md

- **IDs closed:** MM-005, DTWS-005
- **Effort:** S · **Order hint:** 9 · **Depends on workstreams:** none
- **Why grouped:** roadmap.md's gate table is a projection of definitions-of-done.md's Active? column; fixing MM-005's gate→script mapping first gives DTWS-005 the values to copy.

**Ordered steps**

1. MM-005: definitions-of-done.md — rewrite :19-26, :76-103; add a 'Wired as' column to the gate table with the HEAD mapping (1 typecheck ✓, 2 lint ✓, 3 ✗, 4 circular ✓, 5 partial (@ts-expect-error in AuthPlugin.test.ts), 6 partial (coverage runs, no thresholds in vitest.config.ts), 7 ✗, 8 ✗, 9 spec:verify:strict ✓, 10 ✗, 11 package:smoke ✓, 12 release.yml ✓-no-op (private packages), 13 ✗, 14 ✗; plus test:bdd, knip, format:check as extra rows); add check 11 (Active gate ⇒ named pnpm script exists in `check`).
2. DTWS-005: roadmap.md:84 last sentence and the lines 88-98 gate table → separate Implementation vs Gates columns, gate values copied from MM-005.

**Test plan:** Check 11 red first; `pnpm run spec:verify:strict` green after.

**Acceptance:** Both documents state identical gate statuses; neither claims no code / no CI / no milestone begun.

**Cross-workstream deps:** None. (Optional follow-up outside this slice: enforce a coverage threshold to turn gate 6 fully Active.)

### Workstream: `spec-surface-inventory-reconcile` — Reconcile ADR/overview surface inventories with shipped exports and endpoints (DoD gate 10)

- **IDs closed:** AVS-008, DTWS-008
- **Effort:** M · **Order hint:** 10 · **Depends on workstreams:** spec-status-banner-sweep
- **Why grouped:** Both are 'surface table vs real exports' drift (ADR-EA-003 endpoint inventory; overview Ports table). One script (check-surface.mjs) mechanizes DoD gate 10 for both.

**Ordered steps**

1. AVS-008: ADR-EA-003 rev 1.1 — shipped inventory (session incl. revokeAll; account updateProfile/deleteUser; subject owned by @awthaq/qadi), status 'Accepted — implemented', drop line-39 footer; sweep spec/decisions/index.yaml + footers of ADR 001-016, flipping only those verified in code; add the 'endpoint change touches owning ADR' checklist item.
2. Write spec/scripts/check-surface.mjs (DoD gate 10) — uses `HttpApi.reflect` (../effect/packages/effect/src/unstable/httpapi/HttpApi.ts:247) on built AuthCoreApi to diff group/endpoint names against a machine-readable inventory block; second half diffs `packages/ports/src/index.ts` `export * as` names against the overview Ports table. Wire into verify-traceability.sh.
3. DTWS-008: overview.md:47 and :90-96 — nine ports modules with real layer constructors, Kind = Context.Service/Context.Reference; reconcile line 55 plugin list (migrate-auth0, migrate-better-auth; placeholders marked); rename 'Planned public API surface'.

**Test plan:** check-surface.mjs red first (missing session.revokeAll, account.*, 6 ports modules); `pnpm run spec:verify:strict` green after.

**Acceptance:** ADR-EA-003 and overview Ports table match code; adding an endpoint or port without updating the spec fails `pnpm check`; DoD gate 10 can be marked Active in MM-005's table.

**Cross-workstream deps:** After spec-status-banner-sweep (overview banner shares the revision bump). Feeds spec-roadmap-status-reconcile (gate 10 flips to Active).

### Workstream: jwt-key-rotation-runbook

**Title:** ADR-EA-017 for JWT signing-key rotation, an emergency retire-now option, and a rewrite of model 08
**IDs closed:** KRS-008 (canonical; MAPS-009 and VB-007 are duplicates)
**Why grouped:** all three cite `spec/models/08-jwt-bearer.md:80`. Writing KRS-008's runbook exposes a real code gap: `KeyRing.rotateNow` is documented as the "suspected key compromise" path, but it keeps the old key verifying and published in JWKS for the full `keyGracePeriod` (30 days by default).
**Ordered steps:**
1. Red test in `packages/jwt/test/KeyRing.test.ts`: `rotateNow({ gracePeriod: Duration.zero })` drops the old kid immediately.
2. Implement the optional `gracePeriod` parameter on `rotateNow`.
3. Optional hardening: `JwtConfig` rejects a `keyGracePeriod` shorter than `ttl`, with its own test.
4. Write the ADR `spec/decisions/017-jwt-signing-key-rotation.md` and add it to `spec/decisions/index.yaml` and the `spec/traceability.md` decisions table.
5. Rewrite `spec/models/08-jwt-bearer.md` to the shipped surface, covering:
   - the `dependsOn: []` design;
   - the lite-verifier limitation;
   - the open gaps: Bearer half, `typ` validation (JJS-008) and audience separation (VB-005).
6. `packages/jwt/README.md` banner.
**Test plan:** the new KeyRing test plus the JwtConfig validation test; `pnpm run test -- packages/jwt`; `pnpm run spec:verify:strict`.
**Acceptance:**
- ADR-EA-017 is present and indexed.
- Emergency rotation retires the old key immediately.
- Model 08 describes the shipped Jwt plugin.
- `pnpm check` passes.
**Effort:** M. **Cross-deps:**
- Related findings in the jwt slice that the ADR should cite:
  - KRS-006: busy servers don't notice an external rotateNow.
  - KRS-009: markRotated+mint is not atomic.
  - KRS-010: the lite verifier's JWKS cache never expires keys.
  - JJS-008: the `typ` header is never validated.
- None of them blocks this work.

---

### Workstream: `mfa-two-factor-hardening` — Two-factor state ADRs (secret encryption, challenge, lockout, SMS posture) + coverage

- **IDs closed:** THS-004, THS-007, BCR-006, SOS-006, BCR-010
- **Effort:** M · **Order hint:** 12 · **Depends on workstreams:** none
- **Why grouped:** All are undecided items in 06-two-factor-totp.md's 'What is missing'; decision 05 resolves most; land ADR-EA-020/021 before the two-factor build (THS-001/AOMS-003 cross-slice).

**Ordered steps**

_THS-004:_ Record in a new ADR (with THS-007/BCR-006) that TOTP secrets are stored only as Encryption-port envelopes with AAD bound to the user, reusing packages/ports/src/Encryption.ts instead of the SecretBox port ticket 05 proposed (same intent, already shipped).
1. spec/decisions/020-two-factor-state.md (new ADR-EA-020; next free number): Decision 1 — `two_factor_secret.secret` holds an Encryption envelope (AES-256-GCM, kid-tagged) with AAD `two-factor:<userId>`; plaintext column forbidden; migration creates the encrypted column from day one; KeyProvider rotation re-encrypts lazily on verify. Alternatives: plaintext (rejected), a new SecretBox port (superseded — Encryption already exists).
2. spec/models/06-two-factor-totp.md: remove 'TOTP secret encryption at rest' from the undecided list and link ADR-EA-020; bump revision.
3. Code phase (two-factor build, cross-slice THS-001): packages/two-factor two_factor_secret model uses the same transparent-encryption pattern as AccountsRepository (packages/sql/src/Repositories.ts:147-151).

_BCR-006:_ Add to ADR-EA-020 a shared per-account second-factor failure budget through the RateLimiter port (research/07 Q58 recommendation 3), layered on top of ticket 05's per-challenge limit.
4. ADR-EA-020 Decision 3: key `2fa-fail:<userId>` in the RateLimiter port, consumed on every failed TOTP, email-OTP or recovery-code verification (any challenge), 5 failures per 15 minutes -> typed `SecondFactorLocked` (429 via ADR-EA-013's httpApiStatus) with Retry-After; success does not reset the window (prevents interleaving attacks) — document the choice; per-challengeId 3/10 s limit from ticket 05 retained; lockout publishes `auth.twoFactor.locked` (audited).
5. spec/models/06-two-factor-totp.md: move the counter question from undecided to decided (link ADR).

_SOS-006:_ Codify decision ticket 05 §3 as ADR-EA-021: SMS OTP is a separate, explicitly restricted plugin over the EmailOtp channel substrate, never an account's sole factor, emitting a `factor.sms.used` audit event, with a SIM-swap risk-indicator hook as a documented extension point.
6. spec/decisions/021-sms-otp-restricted-plugin.md (new ADR-EA-021; next free number): Context (NIST SP 800-63B-4 §3.1.3.3 per research/07-passwords-2fa.md:132/:142), Decision (separate `@awthaq/sms-otp` plugin, deferred; channel substrate = EmailOtp's; installable only alongside a non-restricted factor — enforced at enroll time: cannot be the only confirmed factor; operator must acknowledge restricted status via config `acknowledgeRestricted: true` or the Layer fails to build with a typed error; publishes `auth.factor.smsUsed`; `SimSwapRiskCheck` optional port consulted before send — a documented extension point, no implementation shipped), Consequences.
7. spec/models/06-two-factor-totp.md + 05-email-otp.md: link ADR-EA-021, remove SMS from undecided list; spec/models/00-adoption-matrix.md: if an SMS row exists, mark it 'Deferred — restricted (ADR-EA-021)'.

_THS-007:_ Write ticket 05's challenge design into ADR-EA-020: challengeId minted by Verification.issue (identifier bound to userId, 10-minute TTL, single-consume, replay event), one live challenge per account, revoked when 2FA is disabled.
8. ADR-EA-020 Decision 2: on BeforeSessionIssue divert, TwoFactor calls `verification.issue({ identifier: "2fa-challenge:<userId>", ttl: "10 minutes" })` (issuing supersedes any prior live challenge for that identifier — single live challenge); `challengeId` returned in TwoFactorRequired; /two-factor/verify and /verify-recovery call `verification.consume` with the identifier derived from the claimed userId, so a challenge for user A cannot verify user B; consumption is single-use and failed/replayed consumes publish auth.token.replay (BEH-EA-059); disabling 2FA revokes outstanding challenges. If a browser-binding cookie is also used, it carries only the challengeId with BEH-EA-055's fixed attributes (HttpOnly, Secure, SameSite=Lax, Path=/auth/two-factor).
9. spec/models/06-two-factor-totp.md: replace line 28-30's cookie description with a link to ADR-EA-020 and remove the TTL from the undecided list.

_BCR-010:_ Write the two-factor behaviors + feature (including recovery codes) as the first artifact of the TwoFactor build decided in ticket 05, mirroring BEH-EA-057/058's reset-token scenarios.
10. spec/behaviors/31-two-factor.md (new, next free BEH ids): TOTP enable/confirm/verify, recovery codes (10 x 10 chars, hashed via PasswordHasher, single-use), challenge via Verification (ADR-EA-020), BeforeSessionIssue divert, BeforeCredentialReset veto (ticket 05 Fix B), per-account attempt counter (BCR-006).
11. features/features/05-authentication-methods/31-two-factor.feature: 'a recovery code consumes exactly once under concurrency', 'regenerating codes keeps the old set valid until the new set persists', 'a consumed code never both succeeds and replays silently (auth.token.replay published)', 'sign-in with 2FA enabled diverts with TwoFactorRequired and mints no session', 'password reset for a 2FA account requires a second factor'.
12. Traceability rows; spec/models/06-two-factor-totp.md 'Verification' section links the feature.

**Test plan:**
- Code phase first failing test: packages/two-factor/test/TwoFactor.test.ts 'the stored secret column is an Encryption envelope and does not contain the base32 secret'; 'an envelope moved to another userId fails AAD verification'.
- Code phase: packages/two-factor/test/TwoFactor.test.ts 'a challenge issued for user A cannot be consumed for user B', 'a second divert invalidates the first challenge', 'challenge expires after 10 minutes (TestClock)'.
- Code phase: packages/two-factor/test/TwoFactor.test.ts 'five failures across TOTP and recovery codes lock the account's second factor for the window even across fresh challenges'.
- spec:verify:strict (ADR traced).
- Scenarios authored before the plugin code (red), wired as the plugin lands (green).

**Acceptance:**
- ADR-EA-020 exists; 06-two-factor-totp.md lists encryption-at-rest as decided.
- Challenge TTL, binding, single-live and consumption semantics are decided in spec.
- The cross-factor counter, threshold, window and error are decided and documented.
- An ADR fixes SMS OTP's restricted posture; the model doc no longer says undecided.
- Two-factor ships with a behaviors file and wired recovery-code concurrency scenarios.

**Cross-issue / cross-slice deps:** THS-001 (cross-slice: two-factor build)

### Workstream: `cli-doctor-hardening` — doctor redaction + static config descriptors + effective-config view (ADR-006 reconciliation)

- **IDs closed:** ECS-005, ECS-008, EP-009
- **Effort:** L · **Order hint:** 13 · **Depends on workstreams:** cli-exit-code-and-arg-contract
- **Why grouped:** All three are about what configuration the tooling can see and how it prints it.

**Ordered steps**

_ECS-005:_ Add a CLI-wide output-redaction requirement: configuration inputs that are Config.Redacted (or declared sensitive in the ECS-008 descriptors) are reported only as present/valid/invalid, never as values, enforced by a BDD scenario and a unit test.
1. spec/behaviors/26-cli.md BEH-EA-201: append to the REQUIREMENT 'it MUST NOT print the value of any configuration input carried as `Redacted` or declared sensitive; such inputs are reported only as present, valid, or invalid (with the validation message, never the value).' Add a sentence that the same rule applies to `config list`, `--json` output and error messages of every CLI command.
2. features/features/08-tooling/26-cli.feature: add @skip @unwired Scenario 'doctor never prints a secret configuration value' (Given an OAuth client secret 'sk-canary-123' and a DATABASE_URL with a password, Then the output does not contain 'sk-canary-123' nor the password, And reports the client secret as 'present, valid').
3. Implementation (with BE-003 + ECS-008): packages/cli/src/Doctor.ts renders descriptor values through a single `renderValue(descriptor, value)` that returns `<redacted>` for sensitive keys and for any `Redacted.isRedacted(value)`; DATABASE_URL-like strings are passed through a URL credential scrubber.

_ECS-008:_ Resolve the contradiction toward the richer option: introduce an effective-configuration descriptor that plugins declare statically (Schema + default + sensitivity), that `doctor` validates and a guarded operator view can dump, and amend ADR-006's Negative consequence accordingly. EP-009's per-tenant effective-config dump is folded in.
4. packages/core/src/AuthPlugin.ts: add an optional static `config` descriptor to the plugin definition: `{ reference: Context.Reference<A>, schema: Schema.Codec<A>, sensitive: ReadonlyArray<keyof A> }` (sensitive keys hold Config.Redacted values). Populate it for Password (PasswordConfig), Sessions (SessionConfig in packages/core/src/Sessions.ts), OAuth, Passkey, Organization, Jwt (JwtConfig), Admin, Roles — each already has a Context.Reference with default (grep `Context.Reference` in packages/*/src).
5. packages/core/src/Auth.ts: extend `Built<P>.manifest` with `config: ReadonlyArray<{ pluginId, key, schema, default, sensitive }>` computed in buildManifest (static, no Layer evaluated) — satisfies BEH-EA-208.
6. packages/core/src/EffectiveConfig.ts (new): `EffectiveConfig.snapshot` = an Effect that, *inside* the running application (or a TenantConfig scope, EP-001/EP-007), reads every declared reference and returns `{ pluginId, key, value | "<redacted>", source: "default" | "override" }`; sensitive keys are rendered via `Redacted` and never unwrapped. Expose it on an admin-guarded endpoint in packages/admin's contract (`GET /admin/config`, RequirePermission-gated) so operators can dump effective config per tenant (EP-009).
7. spec/decisions/006-runtime-config-separate-from-installation.md: bump to Revision 1.2 and rewrite the Negative paragraph: configuration *shape* is now in the static manifest (doctor validates declared defaults and overrides it can see), effective *values* are introspectable at runtime via EffectiveConfig (redacted); remaining gap = overrides computed dynamically at request time cannot be validated pre-deploy.
8. spec/behaviors/26-cli.md BEH-EA-201: replace 'every configuration value it can validate' with 'every configuration value declared in the manifest's config descriptors that the loaded awthaq.config.ts statically provides, decoded through its Schema' and add `awthaq config list` (prints manifest config descriptors + statically visible overrides, redacted) as part of doctor or as a sibling inspection command (listed in BEH-EA-208's inspection set).
9. Add a new behavior for the runtime effective-config view (next free id) in spec/behaviors/27-admin-impersonation.md's neighbour or a new admin behavior, referencing ADR-006 rev 1.2.
10. features: 26-cli.feature 'doctor reports every configuration value it can validate' scenario rewritten to the descriptor wording; add 'config list never prints a sensitive value'.

**Test plan:**
- First failing test (with the CLI): packages/cli/test/Doctor.test.ts 'doctor output contains no canary secret' — capture stdout/`--json` and assert the canary string is absent.
- packages/core/test/Auth.test.ts (or AuthPlugin.test.ts) 'manifest.config lists Password.minLength with its Schema and default without building any Layer' — failing first.
- packages/core/test/EffectiveConfig.test.ts 'snapshot reports an overridden Password.minLength as source=override and renders sensitive keys as <redacted>'.
- packages/admin/test: 'GET /admin/config is denied without the admin permission'.

**Acceptance:**
- BEH-EA-201 carries an explicit no-secret-values clause covering human and JSON output.
- A scenario asserts a canary secret never appears in doctor output.
- ADR-006 and BEH-EA-201 no longer contradict each other.
- `auth.manifest.config` exists and is derived statically.
- An operator can dump effective config (redacted) through a permission-gated endpoint; no Redacted value is ever unwrapped in output.

**Cross-issue / cross-slice deps:** none

### Workstream: `cli-migration-guardrails` — migration status/apply plan preview and drift refusal

- **IDs closed:** ECS-009
- **Effort:** M · **Order hint:** 14 · **Depends on workstreams:** cli-exit-code-and-arg-contract
- **Why grouped:** BEH-EA-039 promises CLI guardrails; ship the minimal set with the first apply.

**Ordered steps**

_ECS-009:_ Give the first shipped `migration apply` the minimum guardrails BEH-EA-039 promises the CLI owns: print the ordered pending plan, refuse on ledger drift (applied ids unknown to the linker, or out-of-order gaps), and make `status` fail loudly on divergence.
1. spec/behaviors/26-cli.md BEH-EA-204: extend REQUIREMENT — `migration status` MUST exit with the drift code (BEH-EA-224) when the ledger contains an applied key the linker's record does not know, or when a pending key sorts before an applied one; `migration apply` MUST print the ordered pending set before applying (and `--dry-run` MUST print it and exit 0/4 without applying) and MUST refuse to run when status would report drift.
2. spec/behaviors/05-persistence-stratum.md BEH-EA-039: add a sentence that the ordered-plan preview and key-level drift refusal are the first (v1) CLI guardrails; checksums and snapshot diffing remain deferred.
3. features/features/08-tooling/26-cli.feature: add @skip @unwired Scenarios 'migration apply prints the ordered pending plan before applying', 'migration apply --dry-run applies nothing', 'migration status reports drift when the ledger has an unknown applied key', 'migration apply refuses on drift'.
4. Implementation (with BE-003): packages/cli/src/Migration.ts reads the Migrator tracking table (effect_sql_migrations) via SqlClient, diffs against `CoreMigrations` + `built.migrations` keys (renumberMigrations in packages/core/src/Auth.ts), returns `{ applied, pending, unknown, outOfOrder }`; `LedgerDrift` TaggedError carries exit code 7.

**Test plan:**
- First failing test (with the CLI): packages/cli/test/Migration.test.ts over an in-memory SQLite: seed effect_sql_migrations with an id the linker doesn't produce -> `status` fails with LedgerDrift; `apply --dry-run` leaves the ledger unchanged.

**Acceptance:**
- BEH-EA-204 requires plan preview + drift refusal; the scenarios exist; apply never runs against a drifted ledger.

**Cross-issue / cross-slice deps:** ECS-001

### Workstream: `cli-seed-admin-audit` — seed admin publishes audited admin-grant events

- **IDs closed:** ECS-006
- **Effort:** S · **Order hint:** 15 · **Depends on workstreams:** none
- **Why grouped:** Small, independent; relies on the shipped AuditLog.

**Ordered steps**

_ECS-006:_ Require `seed admin` to publish a typed `auth.admin.seeded` event (and a refusal event) through AuthEvents, which AuditLog persists inline.
1. packages/core/src/AuthEvents.ts: add `AdminSeededEvent { _tag: "auth.admin.seeded"; targetUserId: UserId; outcome: "created" | "promoted"; forced: boolean; role: string; via: "cli" }` and `AdminSeedRefusedEvent { _tag: "auth.admin.seedRefused"; reason: "adminExists"; attemptedEmail?: never }` (no PII beyond the user id); extend the `AuthEvent` union and AuditLog's exhaustive `actorOf` switch (packages/core/src/AuditLog.ts:74) — the compiler forces it.
2. spec/behaviors/26-cli.md BEH-EA-206: add 'it MUST publish `auth.admin.seeded` (target account id, created vs promoted, forced flag) on success and `auth.admin.seedRefused` on refusal, so the grant lands in the durable audit table (BEH-EA-100)'.
3. spec/behaviors/13-events.md: add both tags to the BEH-EA-101 registry list (coordinate with ESA-006's registry refresh).
4. features/features/08-tooling/26-cli.feature: @skip @unwired Scenarios 'seed admin records an auth.admin.seeded audit entry' and 'a refused seed records auth.admin.seedRefused'.
5. Implementation (with BE-003): packages/cli/src/Seed.ts publishes via `AuthEvents.publish` after the Roles grant succeeds.

**Test plan:**
- packages/core/test/AuditLog.test.ts 'auth.admin.seeded is recorded with actorUserId none and the target in payload' (failing until the tag exists).
- With the CLI: packages/cli/test/Seed.test.ts 'seed admin --force over an existing admin publishes auth.admin.seeded with forced=true'.

**Acceptance:**
- Every successful or refused seed produces exactly one durable audit row.
- BEH-EA-206 and the 13-events registry name the tags.

**Cross-issue / cross-slice deps:** none

### Workstream: `redaction-guarantee-check` — BEH-EA-199 canary-based redaction probe in @awthaq/test

- **IDs closed:** SMS-003
- **Effort:** L · **Order hint:** 16 · **Depends on workstreams:** none
- **Why grouped:** Standalone test-infrastructure deliverable.

**Ordered steps**

_SMS-003:_ Build the BEH-EA-199 interceptor in @awthaq/test using canary secrets: run the plugin's flows with known canary passwords/tokens under a recording Tracer, Logger and AuthEvents/AuditLog subscriber, and fail if any canary string (or an unwrapped Redacted payload) appears in span attributes/events, log messages/annotations, or published events.
1. packages/test/src/RedactionProbe.ts (new): `RecordingTracer` via `Tracer.make` (effect/Tracer) capturing span names, attributes and span events; `RecordingLogger` via `Logger.make` capturing message + annotations; a fiber collecting `AuthEvents.stream`; `assertNoLeak(canaries)` deep-walks every captured value (JSON-safe traversal, handling Redacted.isRedacted -> treated as safe, raw strings -> substring check) and fails with the path of the leak.
2. packages/test/src/TestAuth.ts runPluginContractTests: add the redaction case — it takes an optional `exercise: (client) => Effect` per plugin (sign-up/sign-in/reset for Password, callback for OAuth, etc.) run with canaries under the probe; remove the 'not built' header note.
3. Adopt it in the existing contract-test callers (packages/organization/test/AuthHttp.test.ts, packages/jwt/test/AuthHttp.test.ts) and add Password/OAuth/Passkey exercises.
4. spec/behaviors/25-testing-harness.md BEH-EA-199: replace the 'Stated honestly... not built' paragraph with a description of the canary-based check and its limits (it detects raw secret material, not semantic leaks); bump revision; traceability row -> packages/test/test/RedactionProbe.test.ts.

**Test plan:**
- First failing test: packages/test/test/RedactionProbe.test.ts 'fails when a plugin logs the raw password' (a fixture plugin that does Effect.log(Redacted.value(pw))) and 'passes when only Redacted is logged'.
- Then packages/password/test: runPluginContractTests with the redaction exercise must pass.

**Acceptance:**
- runPluginContractTests fails a plugin that leaks a canary secret into a span, log or event.
- BEH-EA-199 no longer admits the check is unbuilt.

**Cross-issue / cross-slice deps:** none

### Workstream: `device-authorization-design` — Device-authorization security parameters and scenarios

- **IDs closed:** DAG-004, DAG-007, DAG-006
- **Effort:** S · **Order hint:** 17 · **Depends on workstreams:** cli-session-login-carveout
- **Why grouped:** Spec work that makes the device plugin (CLI login backend per decision 06) implementable safely.

**Ordered steps**

_DAG-004:_ Now that decision 06 makes the device plugin the CLI's login backend, write its security parameters into the model doc (and later BEHs): user-code alphabet/length/entropy, TTL, normalization, constant-time lookup, RateLimiter rules on /device/code, /device/token and the approval endpoint.
1. spec/models/13-device-authorization.md: bump revision; add a 'Security parameters' section — user code: 8 chars from a 20-symbol unambiguous consonant alphabet `BCDFGHJKLMNPQRSTVWXZ` (≈34.6 bits, RFC 8628 §6.1 example), displayed as XXXX-XXXX, normalized on input (uppercase, strip `-`/spaces) with exact match only; stored hashed (SHA-256) and looked up by hash (constant-time by construction); device_code 32 CSPRNG bytes, hashed at rest; TTL 15 minutes (configurable via DeviceAuthorizationConfig Context.Reference); poll `interval` 5 s, `slow_down` +5 s per RFC 8628 §3.5.
2. Rate limits (BEH-EA-105 RateLimiter port, registered through the plugin's rule registry like Password.ts's RATE_LIMITS): /device/code 5 per TTL per IP; approval/verification endpoint 5 failed user-code lookups per 15 min per IP and per session; /device/token enforces `interval` per device_code (slow_down on violation).
3. Session issuance: the approved poll calls Sessions.issue for the claimed userId through Hooks.BeforeSessionIssue (DAG-006's constraint, ticket 03).
4. When the plugin is specified as behaviors, lift these into BEH ids (next free).

_DAG-007:_ Author the device-authorization feature file (scenarios before code) and its traceability, registered as @skip @unwired until the plugin exists.
5. features/features/05-authentication-methods/NN-device-authorization.feature (new): Scenarios — authorization_pending then approved -> tokens issued once; denied -> access_denied; polling faster than interval -> slow_down; expired code -> expired_token and row cleanup; two concurrent /device/token polls after approval -> exactly one wins, the other gets invalid_grant; verification-page claim is idempotent for the same session and rejected for a different session; approve without claim is denied; wrong user code attempts are rate-limited (DAG-004 numbers); issued session appears in the user's session list with the device's ip/userAgent (BEH-EA-054).
6. features/features/05-authentication-methods/NN-device-authorization.steps.test.ts placeholder (zero steps) mirroring features/features/08-tooling/26-cli.steps.test.ts so vitest reports them as skipped.
7. spec/traceability.md + features/traceability.md: map MOD-EA-013 to the new feature; 13-device-authorization.md 'Verification' section points at it.

**Test plan:**
- spec:verify:strict; the parameters become assertions in DAG-007's feature file.
- `pnpm run test:bdd` lists the new scenarios as skipped; spec:verify:strict passes.

**Acceptance:**
- 13-device-authorization.md fixes alphabet, length, entropy, TTL, normalization, hashed lookup and per-endpoint rate limits.
- Race/idempotency semantics are pinned as executable (skipped) scenarios before implementation.

**Cross-issue / cross-slice deps:** CTA-002

### Workstream: `m2m-client-secret-lifecycle` — API-key / client-secret rotation and transport ADR

- **IDs closed:** OCM-005
- **Effort:** S · **Order hint:** 18 · **Depends on workstreams:** none
- **Why grouped:** Open design call needed before the api-key build (OCM-002).

**Ordered steps**

_OCM-005:_ Decide and record (ADR-EA-022) API-key and client-secret rotation with a bounded dual-validity grace window and the transport header, then carry it into the api-key build (OCM-002, cross-slice).
1. spec/decisions/022-api-key-rotation-and-transport.md (new): rotation = `rotate(keyId, { gracePeriod? })` mints a successor (same name/scopes, `rotatedFrom`), sets the predecessor's `expiresAt = now + gracePeriod` (default 24 h, configurable in ApiKeyConfig, max bounded e.g. 30 d mirroring JwtConfig.keyGracePeriod), publishes `auth.apiKey.rotated`; `revoke` remains immediate. Client secrets: `rotateClientSecret(clientId, { gracePeriod? })` keeps at most two valid secret hashes per client. Transport: API keys via `x-api-key` header (configurable header name), `Authorization: Bearer` reserved for JWTs (M2M tokens, jwt plugin) so strategies never double-try; client_credentials accepts client_secret_post (per ticket 10) and client_secret_basic.
2. spec/models/07-api-keys.md: move rotation/transport out of the undecided list, link ADR-EA-022.
3. Code (with OCM-002): packages/api-key rotate/rotateClientSecret + tests.

**Test plan:**
- Code phase first failing test: packages/api-key/test/ApiKey.test.ts 'after rotate both keys resolve until the grace window elapses (TestClock), then only the successor'.

**Acceptance:**
- Rotation/grace and transport are decided in an ADR; the model doc references it.

**Cross-issue / cross-slice deps:** OCM-002 (cross-slice: api-key build)

### Workstream: `bdd-plugin-coverage` — Behaviors + features for shipped jwt and organization

- **IDs closed:** BDD-005
- **Effort:** L · **Order hint:** 19 · **Depends on workstreams:** jwt-key-rotation-runbook
- **Why grouped:** Real acceptance gap is jwt/organization; placeholders gated behaviors-first.

**Ordered steps**

_BDD-005:_ Close the real gap — jwt and organization ship without behaviors or acceptance scenarios — by writing their spec/behaviors files and .feature restatements; record magic-link/api-key/two-factor as 'behaviors-before-code' prerequisites of their builds.
1. spec/behaviors/29-organization.md (new; BEH ids next free): restate shipped organization semantics (create/update/delete org, membership add/remove/role, invitations, teams, membership-required list endpoints per MTI-002 commit 234756f, hook points in OrganizationHooks.ts, events auth.organization.*).
2. spec/behaviors/30-jwt-bearer.md (new): restate Jwt plugin behavior (token issuance, KeyRing rotation/grace — coordinate with A2's KRS-008/ADR-EA-017, JWKS, RevocationStore, verify rules).
3. features/features/02-domain/29-organization.feature and features/features/05-authentication-methods/30-jwt-bearer.feature with steps files; wire at least the security-critical scenarios per ticket 36's tiering (membership enforcement, JWT signature/alg/exp/revocation).
4. features/README.md mapping table + features/traceability.md + spec/traceability.md rows; spec/behaviors/index.yaml.
5. For two-factor/magic-link/api-key: add to each plugin's build ticket (AOMS-003/THS-001, BAM-007, OCM-002 cross-slice) the gate 'behaviors file + feature file land in the same PR as the plugin' (definitions-of-done).

**Test plan:**
- Write the scenarios first against the shipped code — e.g. 'a non-member cannot list an organization's teams' and 'a JWT signed by a retired key past its grace period is rejected' — and wire them with step definitions (they should pass immediately; failures indicate spec/code drift).

**Acceptance:**
- jwt and organization each have a behaviors file with BEH ids and a wired feature file; spec:verify:strict and test:bdd pass.
- Placeholder plugins carry an explicit behaviors-first gate in their build tickets.

**Cross-issue / cross-slice deps:** KRS-008

### Workstream: `cli-import-tooling` — better-auth import via SourceAdapter (decision 07)

- **IDs closed:** BAM-001
- **Effort:** XL · **Order hint:** 20 · **Depends on workstreams:** cli-exit-code-and-arg-contract
- **Why grouped:** Standalone deliverable on top of the CLI skeleton (BE-003).

**Ordered steps**

_BAM-001:_ Follow decision ticket 07 §6: a generic `SourceAdapter` interface and `import --from <source>` command, only the better-auth adapter implemented and validated against a real export fixture; authjs/lucia registered but refusing with a typed NotImplemented error; rows go through Users/Accounts domain services; unmapped fields reported; resumable via an import-runs table.
1. Prereq: CLI skeleton + ManifestLoader (awthaq.config.ts) from BE-003 (cross-slice canonical for 'CLI is an empty placeholder').
2. packages/migrate-better-auth/src/BetterAuthSource.ts (new): Schemas for better-auth's `user`, `account`, `session`, `verification` rows (decode, never cast); pure mapping functions `mapUser(row) -> Effect<{ user: Users.CreateInput, accounts: ReadonlyArray<Accounts.LinkInput>, unmapped: ReadonlyArray<UnmappedField> }>` onto the existing Model.Class insert shapes; credential accounts keep better-auth's scrypt hash, verified through a `LegacyPasswordVerifierShape` (pattern from packages/migrate-auth0/src/BcryptVerifier.ts) so rehashOnLogin retires it.
3. packages/cli/src/Import.ts (new): `SourceAdapter { name; read: (src) => Stream<RawSourceRow, ImportError>; map: (row) => Effect<MappedInput, UnmappableFieldError> }`; registry { 'better-auth': BetterAuthSource, 'authjs': notImplemented, 'lucia': notImplemented }; `--from` Schema literal from the registry keys (ECS-007); `--report <path>` writes per-row unmapped-field JSON; `--dry-run`.
4. Resumability: a first-party migration adding `awthaq_import_runs (run_id, source, source_row_id, status, imported_user_id, error)`; skip rows already `done` on re-run.
5. spec/behaviors/26-cli.md BEH-EA-207: revise per decision 07 — 'MUST support better-auth; authjs and lucia MUST be accepted by the --from Schema and MUST fail with a typed not-yet-validated error until their adapters are validated against real exports'; describe the report and resumability; bump revision.
6. features/features/08-tooling/26-cli.feature: update the 'import supports each named source framework' Scenario Outline accordingly; add 'a re-run after partial failure skips imported rows'.

**Test plan:**
- First failing test: packages/migrate-better-auth/test/BetterAuthSource.test.ts 'maps a better-auth user+credential account into Users.create + Accounts.link input and reports unmapped columns' over a checked-in fixture exported from a real better-auth SQLite DB.
- packages/cli/test/Import.test.ts 'import is resumable: second run imports 0 rows and reports N skipped'; 'import --from lucia fails with NotYetValidated (exit 2/usage class)'.
- Integration: an imported credential signs in through Password.signIn and is rehashed (needsRehash) on first login.

**Acceptance:**
- `awthaq import --from better-auth` imports users/accounts from a real fixture through domain services, emits an unmapped-field report, and is resumable.
- authjs/lucia are typed, refused, and documented as not validated.
- BEH-EA-207 matches the shipped scope.

**Cross-issue / cross-slice deps:** BE-003, ECS-007

### Workstream: `native-bearer-bootstrap` — Native/mobile bearer path: document what exists now, finish issuance under MNA-001

- **IDs closed:** MNA-009
- **Effort:** S · **Order hint:** 21 · **Depends on workstreams:** none
- **Why grouped:** Doc half of the native-client gap; the code half (token acquisition) is MNA-001 in another slice, decided in .scratch ticket 17.

**Ordered steps**

1. MNA-009 (doc half, now): amend BEH-EA-066 prose at spec/behaviors/09-authentication-middleware.md:55 — resolution + `set-auth-token` rotation exist; acquisition missing (MNA-001); `{ csrf: false }` variant not built (BEH-EA-171). Optionally add a normative clause + scenario for `set-auth-token`.
2. MNA-001 (code half, other slice): implement ticket 17's opt-in `X-Awthaq-Token-Delivery: bearer` + OAuth one-time exchange code; then rewrite the paragraph positively.

**Test plan:** Spec-only now; if the set-auth-token clause is added, allocate a REQ id and add an (@unwired-acceptable) scenario to 09-authentication-middleware.feature.

**Acceptance:** BEH-EA-066 no longer implies a finished native path; spec:verify:strict green.

**Cross-workstream deps:** Code completion depends on MNA-001 (cross-slice).


---

### Workstream: `verification-timing-uniformity` — BEH-EA-064 latency-uniformity clause

- **IDs closed:** MLO-008
- **Effort:** S · **Order hint:** 22 · **Depends on workstreams:** none
- **Why grouped:** Spec catches up with bd1625c.

**Ordered steps**

_MLO-008:_ Extend BEH-EA-064 so latency uniformity is normative (mail dispatch asynchronous to the response; equal work in both branches), matching what bd1625c implemented.
1. spec/behaviors/08-verification-tokens.md BEH-EA-064: append 'and MUST NOT make response latency depend on whether it resolves: token issuance and mail dispatch for a known identifier MUST run detached from the response, so both branches perform the same synchronous work (one user lookup)'. Cite research/05 Q48 and BEH-EA-113; bump revision.
2. features/features/02-domain/08-verification-tokens.feature (or the password reset feature): add a scenario 'requestReset returns before a slow mailer completes' (TestClock/latched mailer — deterministic, not wall-clock).
3. Reference the existing Password.test.ts coverage from bd1625c in traceability.

**Test plan:**
- BDD scenario with a mailer that blocks on a Deferred: the response completes while the Deferred is unresolved.

**Acceptance:**
- BEH-EA-064 names the timing channel; a deterministic scenario guards it.

**Cross-issue / cross-slice deps:** none

### Workstream: `password-hasher-legacy-recipes` — ADR-010 correction + Supabase bcrypt recipe

- **IDs closed:** SAM-002
- **Effort:** S · **Order hint:** 23 · **Depends on workstreams:** none
- **Why grouped:** Mechanism shipped (60947ff); only spec/docs remain.

**Ordered steps**

_SAM-002:_ Correct ADR-010's example to the shipped LegacyPasswordVerifiers mechanism and publish a GoTrue/Supabase migration recipe that reuses the bcrypt verifier.
1. spec/decisions/010-plugins-require-ports-never-provide.md: bump revision; replace '`BcryptHasher.layer`' with 'a verify-only `LegacyPasswordVerifiers` entry such as `@awthaq/migrate-auth0`'s `bcryptVerifier` — argon2id/scrypt stay the only algorithms `hash()` produces (ticket 21)'.
2. packages/migrate-auth0/README.md (or a new docs section in packages/password/README.md): 'Migrating from Supabase (GoTrue)' — export auth.users (encrypted_password is bcrypt $2a$), import via Users.create + Accounts.link({ credentialHash }) + verifyEmail when email_confirmed_at is set, compose `PasswordHasher.layerArgon2id` with the bcrypt verifier, rehashOnLogin (default true) upgrades on first sign-in, unknown emails still cost real work (dummy hash path). Note: consider re-exporting bcryptVerifier from a neutral name later if a third bcrypt source appears (not now).
3. spec/overview.md ports table: mention LegacyPasswordVerifiers (coordinate with DTWS-008).

**Test plan:**
- Existing packages/migrate-auth0/test/BcryptVerifier.test.ts covers the mechanism; add a doc-test style case 'a GoTrue $2a$10$ hash signs in and is rehashed to argon2id' if not already covered.

**Acceptance:**
- ADR-010 no longer names a phantom BcryptHasher.layer; a Supabase recipe exists.

**Cross-issue / cross-slice deps:** none

### Workstream: `sqlite-ops-docs` — Embedded SQLite operations guide

- **IDs closed:** SEA-003
- **Effort:** S · **Order hint:** 24 · **Depends on workstreams:** none
- **Why grouped:** Doc-only.

**Ordered steps**

_SEA-003:_ Add an embedded-SQLite operations section: WAL default and -wal/-shm sidecars, live backup via the client's `backup(destination)`, checkpointing, busy timeout, single-writer/single-instance constraint.
1. packages/sql/README.md: new 'Embedded SQLite in production' section covering the five topics with a snippet using `SqliteClient.SqliteClient` `backup`, and a note that copying auth.db without -wal is unsafe.
2. spec/appendices/01-password-signup-to-session-view.md:51: add a one-line comment linking that section.

**Test plan:**
- Doc-only.

**Acceptance:**
- The WAL/backup/checkpoint guidance exists and the appendix links it.

**Cross-issue / cross-slice deps:** none

### Workstream: `multi-tenant-composition` — Tenancy = Organization row, per-request tenant config (decision 18)

- **IDs closed:** EP-001, EP-007
- **Effort:** XL · **Order hint:** 25 · **Depends on workstreams:** none
- **Why grouped:** EP-007's per-tenant config needs EP-001's TenantContext/middleware; one ADR covers both. Shares substrate with DRS-001/CWM-001/EP-004 (other slices).

**Ordered steps**

_EP-001:_ Implement decision ticket 18: tenant = Organization row; ambient `TenantContext` in core; nullable indexed `tenant_id` on the five core tables stamped on every write; `TenantResolver` port + opt-in `Organization.tenantMiddleware`; Postgres RLS; per-org OAuth connections via a LayerMap-backed `OrganizationConnections`. Record it as an ADR first.
1. spec/decisions/018-tenancy-is-an-organization.md (new, ADR-EA-018; re-check next free number — A2 takes 017): Decision = tenant is an Organization row, expressed as runtime configuration/data within installed plugins (ADR-EA-005's reserved seam), host-per-tenant rejected; consequences: opaque core `tenant_id`, TenantResolver port (ADR-EA-010: app provides it), RLS on Postgres, WHERE-discipline only on SQLite. Update spec/decisions/index.yaml and ADR-005 line 39 to link it.
2. packages/core/src/TenantContext.ts (new): `TenantContext = Context.Reference<Option.Option<string>>("awthaq/core/TenantContext", { defaultValue: () => Option.none() })`; export from packages/core/src/index.ts.
3. packages/sql/src/CoreMigrations.ts: forward-only migration adding `tenant_id TEXT NULL` + index to users, accounts, sessions, verification_tokens, verification_reservations (both dialect branches); packages/sql/src/Models.ts + Repositories.ts gain the column; Users.create, Accounts.link, Sessions.issue, Verification.issue read TenantContext and stamp it; finders filter by it when Some.
4. Postgres: RLS policies `USING (tenant_id = current_setting('awthaq.tenant_id', true) OR current_setting('awthaq.tenant_id', true) IS NULL)` on the five tables; SqlTransaction layer issues `SET LOCAL awthaq.tenant_id` when TenantContext is Some.
5. packages/organization/src/TenantResolver.ts (new port, required only by the middleware): `(request) => Effect<Option<OrganizationId>>`; `Organization.tenantMiddleware` provides TenantContext per request.
6. packages/organization: `organization_oauth_connection` table (client secret encrypted via the existing Encryption/KeyProvider ports), `OrganizationConnections` as `LayerMap.Service` keyed by org id building an OAuthProvider with the same `OAuthProvider.resolve` used for static providers; OAuth.authorize/callback fall through static map -> OrganizationConnections (this sub-step is CWM-001/EP-004's canonical fix in other slices — coordinate, don't duplicate).
7. Docs: spec/models/14-organization.md gains a 'Tenancy' section; examples/memory-server shows two tenants.

_EP-007:_ Make per-tenant configuration real: plugins read their config Reference per operation (not once at Layer build), and a `TenantConfig` LayerMap.Service keyed by tenant id supplies each tenant's config Layers, provided per request by the tenant middleware — ADR-005/006's own prescription.
8. Refactor every plugin that captures config in `make` to read it inside each operation: packages/password/src/Password.ts:541 (`const config = yield* PasswordConfig` -> read in signUp/signIn/changePassword/etc.), packages/core/src/Sessions.ts (`const config = yield* SessionConfig` in layerMemory/layerSql), OAuth, Passkey, Organization, Jwt, Admin. Context.Reference reads are cheap; this is what makes `Effect.provideService` overrides effective.
9. packages/core/src/TenantConfig.ts (new): `TenantConfig` = `LayerMap.Service<TenantConfig>()("awthaq/core/TenantConfig", { lookup: (tenantId: string) => Layer<never> , idleTimeToLive })` where lookup is supplied by the app (a function from tenant id to a merged `Password.config(...)`/`Sessions.config(...)` Layer, e.g. loaded from the organization's settings). Default: no TenantConfig -> global config.
10. Organization.tenantMiddleware (EP-001) additionally does `Effect.provide(TenantConfig.get(tenantId))` around the handler when TenantConfig is installed.
11. spec/decisions/006 & 005: link to ADR-EA-018's config section; add a behavior (next free id) 'per-tenant configuration overrides apply per request without changing the plugin tuple'.

**Test plan:**
- First failing test: packages/core/test/Users.test.ts 'Users.create stamps TenantContext into tenant_id and findByEmail does not see another tenant's user' (memory + SQL layers).
- packages/sql/test/Repositories.postgres.test.ts 'RLS blocks a cross-tenant read when awthaq.tenant_id is set' (CI-only Postgres).
- packages/organization/test 'tenantMiddleware resolves the org and provides TenantContext for the handler fiber'.
- BDD: a new @skip-until-wired scenario in features/features/02-domain/06-users-accounts.feature 'two tenants may register the same email independently'.
- First failing test (the issue's own acceptance): packages/password/test/Password.test.ts 'two tenants with different Password.config({ minLength }) in one composition' — tenant A (minLength 8) accepts an 10-char password, tenant B (minLength 16) rejects it with WeakPassword, same Password layer instance.
- packages/core/test/Sessions.test.ts 'SessionConfig override provided per request changes idle expiry'.

**Acceptance:**
- A single-tenant app with no middleware behaves exactly as today (all tenant_id NULL).
- Two organizations in one composition have isolated users/sessions, enforced by RLS on Postgres.
- ADR-EA-018 recorded; ADR-005 no longer says 'Not yet implemented' without a pointer.
- One composition serves two tenants with different plugin config; no plugin captures config at build time (grep `yield\* .*Config;` inside `make` bodies is empty).

**Cross-issue / cross-slice deps:** CWM-001, DRS-001

### Workstream: `enterprise-federation-saml-scim` — SAML SP + SCIM packages: ADR, contracts, port, validation chain (decision 08)

- **IDs closed:** AOMS-009, CWM-002, SFS-003, SFS-006, SFS-007, SFS-001, SFS-008, SCP-009
- **Effort:** XL · **Order hint:** 26 · **Depends on workstreams:** multi-tenant-composition
- **Why grouped:** One decision ticket (08) and one ADR resolve all SAML/SCIM/SSO spec gaps; code follows ticket 09's deactivation state.

**Ordered steps**

_AOMS-009:_ Execute decision ticket 08's spec half now (ADR + contracts + resequenced roadmap) and its code half in order: UserRecord deactivation (ticket 09) -> packages/scim -> packages/saml (SP-only), SAML runnable in parallel with SCIM substrate.
1. spec/decisions/019-enterprise-federation-packages.md (new ADR-EA-019; next free number): SAML ships as `packages/saml` (SP only; IdP/E5 out of scope), SCIM as `packages/scim` (inbound RFC 7644 server), each an AuthPlugin.Service; SSO is a connection resolver dispatching to the standalone Saml/OAuth plugins (SFS-006); `SamlSigner` port (SFS-003); org connections table reserves kind `saml` (ticket 18). Update spec/decisions/index.yaml.
2. spec/models/00-adoption-matrix.md rows 123-126 + spec/roadmap.md:125: replace 'Planned-Phase3 / not v1 scope' for SAML/SCIM with the scheduled sequence (after ticket 09's deactivation state) and link ADR-EA-019; keep OIDC Provider and Device Authorization rows as-is unless their own tickets move them.
3. spec/models/10-saml.md + 12-scim.md: bump revisions; replace 'No design beyond this row exists yet' with the ADR's package/contract shape: SamlApi (`GET /auth/saml/metadata`, `POST /auth/saml/acs`, `saml_connection` table), ScimApi (`/scim/v2/Users`, `/scim/v2/Groups`, connection bearer token, `scim_external_id(scimConnectionId, externalId, userId)`), deactivation -> Sessions.revokeAll.
4. Code (separate follow-up tickets, each ready-for-agent after the ADR lands): packages/saml with SamlSigner port + ordered validation chain (SFS-007); packages/scim (CWM-002 owns its fix plan).

_CWM-002:_ Per decision 08: after ticket 09's UserRecord deactivation state lands, ship `packages/scim` (inbound RFC 7644) with an external-id mapping table and Sessions.revokeAll on deactivation; publish the interim deprovisioning recipe now.
5. Now (doc, S): add an 'Interim deprovisioning recipe' section to spec/models/12-scim.md and packages/organization/README.md: subscribe `AuthEvents.on("auth.organization.memberRemoved", ...)` (packages/core/src/AuthEvents.ts on()) and call `Sessions.revokeAll(userId)` when the user has no remaining memberships.
6. Prereq (cross-slice, ticket 09): `UserRecord.status: "active" | "deactivated"` + `Users.deactivate/reactivate`, sign-in and Sessions.verify refusing deactivated users.
7. packages/scim (new plugin, AuthPlugin.Service, dependsOn [Users, Sessions, Organization]): tables `scim_connection(id, organizationId, tokenHash)` and `scim_external_id(scimConnectionId, externalId, userId)`; ScimApi group `scim` with `/scim/v2/Users` (GET filter eq userName/externalId, POST, GET/{id}, PUT, PATCH replace active, DELETE -> deactivate not delete) and `/scim/v2/Groups` mapped to organization teams; bearer auth via connection token (SHA-256 at rest, constant-time compare); idempotent PATCH; `active:false` -> Users.deactivate + Sessions.revokeAll; publishes `auth.scim.userDeactivated`.
8. Spec: 12-scim.md graduates to contracts (see AOMS-009 step 3); add a behaviors file for SCIM with BEH ids at implementation time; features/features/05-authentication-methods/NN-scim.feature.

_SFS-003:_ Design the `SamlSigner` port in spec before any plugin code, with fused parse+verify semantics, then implement it in packages/saml (port lives in @awthaq/ports per ADR-EA-010).
9. spec/models/10-saml.md: replace the 'not yet designed' comment with a 'SamlSigner port' section: `verifyResponse(xml: string, trust: IdpTrustSet) => Effect<VerifiedAssertion, SamlVerificationError>` — parse and verify fused (no unverified intermediate DOM escapes), DTD/external entities disabled inside the port, exclusive C14N handled internally, returns only the *signed* Assertion element's data (anti-XSW), algorithm allow-list (RSA-SHA256+, no SHA-1), `IdpTrustSet` = array of certs keyed by fingerprint with `notBefore/notAfter` for rotation overlap, metadata-ingest helper `trustFromMetadata(xml)`. Signing (AuthnRequest/metadata) as a separate optional `sign` method.
10. Add this port to ADR-EA-019 and spec/overview.md's ports-stratum table (coordinate with DTWS-008's reconciliation).
11. Code phase: packages/ports/src/SamlSigner.ts (service tag + shape, no implementation); packages/saml/src/SamlSignerLive.ts implementation over a maintained XML-DSig library (e.g. xml-crypto + @xmldom/xmldom with entity resolution disabled) — audited before adoption, no home-grown crypto.

_SFS-006:_ Record the dispatch shape implied by decisions 08 and 18 in ADR-EA-019: standalone `Saml` and `OAuth` plugins own their protocol routes; `Sso` is a thin connection-resolver plugin (routes under `sso.*`) that resolves an organization's connection (by email domain or org id) and redirects into the owning plugin.
12. ADR-EA-019: section 'SSO dispatch' — Sso plugin (dependsOn [Sessions, Users, Organization]) exposes `POST /auth/sso/start {email|organizationId}` which looks up `organization_oauth_connection` (kinds oidc/oauth2/saml) and returns the redirect produced by OAuth.authorize or Saml.authnRequest; protocol endpoints stay under the `oauth.*`/`saml.*` groups (BEH-EA-004 group naming).
13. spec/models/09-sso.md: replace the open-question sentence at line 65 with a link to ADR-EA-019; bump revision.

_SFS-007:_ Adopt the ordered SAML validation chain as normative behaviors before implementation (cheap checks before crypto), naming canonicalization and signature wrapping explicitly.
14. spec/behaviors/28-saml-sp.md (new, BEH ids allocated at write time): one BEH per ordered step — (1) size cap before parse; (2) structural parse with DTD/entities disabled; (3) exactly one Assertion (cardinality — anti-XSW); (4) signature verified over that same Assertion node via SamlSigner, algorithm allow-list, exclusive C14N; (5) Issuer matches connection; (6) Audience/Recipient/Destination; (7) NotBefore/NotOnOrAfter with bounded skew; (8) InResponseTo matches a stored, single-consume request id (Verification reserve/consume) — replay defense; (9) NameID -> account link via (connectionId, NameID).
15. Source the chain from better-auth/04-oauth-and-federation/05-sso.md:182-253 (cited by the issue) and cite it.
16. spec/models/10-saml.md 'What is missing': add canonicalization and signature-wrapping and link the behaviors file; spec/behaviors/index.yaml; traceability rows -> planned packages/saml tests; features/features/05-authentication-methods/28-saml-sp.feature with @skip @unwired scenarios per step.

**Test plan:**
- Spec phase: `pnpm run spec:verify:strict` (new ADR traced, no orphan).
- Code phase first failing tests: packages/saml/test/SamlSigner.test.ts 'rejects an assertion whose signed element is not the processed element (XSW)'; packages/scim (see CWM-002).
- First failing test (code phase): packages/scim/test/Scim.test.ts 'PATCH active=false deactivates the user and revokes every live session'; 'repeat POST with the same externalId is idempotent'; 'a token for connection A cannot read connection B's users'.
- Code phase first failing tests: packages/saml/test/SamlSigner.test.ts — 'rejects XML with a DOCTYPE/external entity', 'rejects a response where a second unsigned Assertion is injected (XSW1-8 corpus)', 'accepts an assertion signed by the previous cert during the overlap window'.
- spec:verify:strict.
- spec:verify:strict; the skipped feature is registered by a new 28-saml-sp.steps.test.ts placeholder (pattern: features/features/08-tooling/26-cli.steps.test.ts).

**Acceptance:**
- ADR-EA-019 exists and the adoption matrix/roadmap show SAML/SCIM as scheduled with the ticket-09 prerequisite.
- 10-saml.md/12-scim.md describe the contracts instead of 'no design exists'.
- An IdP can create, update, deactivate users via /scim/v2 and deactivation kills sessions immediately.
- The interim recipe is documented before the package ships.
- 10-saml.md specifies the port contract (fused parse+verify, XXE off, signed-element-only, rotation-aware trust set).
- 09-sso.md no longer lists the dispatch question as open; ADR-EA-019 records the group-naming consequence.
- An ordered, normative SAML validation chain with BEH ids exists before packages/saml code.

**Cross-issue / cross-slice deps:** ticket-09 UserRecord deactivation (cross-slice)

## Decisions needed

### OCM-005 — API-key / client-secret rotation window and transport

No existing decision covers it (ticket 10 fixed format/hashing/token endpoint only).

- A: dual-validity rotation with configurable bounded grace window (default 24 h, max 30 d) + x-api-key transport only for API keys, Bearer reserved for JWT (recommended)
- B: dual-validity rotation + accept both x-api-key and Authorization: Bearer for API keys (prefix-sniffed)
- C: no grace window — rotation is revoke+create (hard cut), x-api-key only

**Recommendation:** A — richer rotation (configurable grace, bounded) while keeping one unambiguous transport per credential type; B's dual transport adds strategy ambiguity for little gain, C causes rotation outages. Record as ADR-EA-022; target status `ready-for-human` until confirmed.

### Scope calls already decided but flagged by their decision tickets for the user's confirmation (not re-litigated here)

- **BAM-001** — decision 07: ship the `SourceAdapter` surface generically, implement/validate only `better-auth` first (`authjs`/`lucia` typed-but-refusing).
- **AOMS-009 / CWM-002** — decision 08: SAML (SP-only) and SCIM ship as first-party packages, sequenced behind ticket 09's `UserRecord` deactivation state.
- **SOS-006** — decision 05 §3: SMS OTP deferred as a separate, explicitly restricted plugin (ADR-EA-021 records the posture).
- **THS-004** — decision 05 proposed a new `SecretBox` port believing none existed; `@awthaq/ports`' `Encryption` (AES-256-GCM, kid envelopes, AAD) now satisfies the same intent, so the plan reuses it. Flag only if the user wants a separate port anyway.

### Numbering allocations used by this slice (re-check at implementation time; other slices may allocate too)

- ADRs: ADR-EA-017 JWT signing-key rotation (A2/KRS-008), 018 tenancy = organization (EP-001), 019 enterprise federation packages + SSO dispatch (AOMS-009/SFS-003/SFS-006), 020 two-factor state (THS-004/THS-007/BCR-006), 021 SMS OTP restricted (SOS-006), 022 API-key rotation/transport (OCM-005).
- BEH ids: 221–223 passkey (A2/BPAS-007), 224 CLI exit codes, 225 CLI argument Schemas, 226 CLI session commands, 227 CLI credential storage; new behavior files 28-saml-sp, 29-organization, 30-jwt-bearer, 31-two-factor allocate ids when written.
- `spec/behaviors/26-cli.md` is amended by six workstreams (carve-out, exit codes/args, doctor, migration, import, seed) plus the banner sweep: land them as one Revision 1.3 / single CCR where possible, otherwise bump sequentially.

## Per-issue dossiers

Grouped by workstream (ordered by the workstream's highest-severity member, then order hint); highest severity first within each group.

### Workstream `qadi-decision-cache-invalidation`

#### PCS-001 — Spec's reference wiring recommends an application-scoped decision cache with no invalidation path

`high` · `security` · `—` · [.issues/high/PCS-001-permission-caching-specialist.md](../../.issues/high/PCS-001-permission-caching-specialist.md) · current status: `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high) — canonical for RZS-002

**Evidence at HEAD (ec065a7)**

- `spec/appendices/02-qadi-path-a-end-to-end.md:59` — Unchanged; `grep -rn 'DecisionCache\|decisionCache' packages/*/src` returns nothing.
  ```
  export const QadiLive = Layer.mergeAll(EvaluationServicesNone, EvaluationIdLive, decisionCacheLayer({ capacity: 512 }))
  ```
- `packages/organization/src/OrganizationHooks.ts:94` — Observe points exist (also AfterUpdateMemberRole:108, AfterDeleteOrganization:68, AfterAddTeamMember:248, AfterRemoveTeamMember:257) but nothing taps them for cache invalidation.
  ```
  export class AfterRemoveMember extends HookPoint.observe<AfterRemoveMember>()(
  ```

**Fix plan**

_Implement decision ticket 12: move decisionCacheLayer to per-request scope in the canonical wiring (Path A middleware / Path B extractor), and ship an opt-in `DecisionCacheInvalidationLive` in @awthaq/qadi that taps every OrganizationHooks observe point and calls DecisionCache.clear, documented as mandatory for app-scoped caches, with the coverage caveat._

Steps:
1. spec/appendices/02-qadi-path-a-end-to-end.md: remove `decisionCacheLayer` from QadiLive (line 59); show it provided around each request's handler (in the AuthorizedSubject middleware's request scope) with a comment quoting DecisionCache's own 'per-request scope is safe against both' note; add a boxed 'Application-scoped cache' variant that also provides DecisionCacheInvalidationLive, plus the caveat that application-owned AttributeResolver/RelationshipResolver data must clear the cache itself. Bump appendix revision.
2. packages/qadi/src/DecisionCacheInvalidation.ts (new): `DecisionCacheInvalidationLive` = Layer that `yield*`s DecisionCache from @qadi/core and taps AfterAddMember, AfterRemoveMember, AfterUpdateMemberRole, AfterDeleteOrganization, AfterAddTeamMember, AfterRemoveTeamMember, AfterUpdateTeam, AfterDeleteTeam via HookPoint `.tap`, each calling `cache.clear`. Doc comment carries the coverage caveat. Export from packages/qadi/src/index.ts. (packages/qadi must then depend on @awthaq/organization's hook points — if that creates a cycle, place the module in packages/organization as `OrganizationQadi.DecisionCacheInvalidationLive` instead, next to OrganizationQadi.relationships.)
3. Path A/Path B helpers: add an optional `decisionCache: { capacity }` option to AuthorizedSubjectLive / SubjectExtractorLive (packages/qadi/src/AuthorizedSubject.ts, SubjectExtractor.ts) that provides decisionCacheLayer per request, so the safe scope is one flag rather than hand-wiring.
4. spec/behaviors/19-qadi-bridge-path-a.md / 20-qadi-bridge-path-b.md: add a requirement (next free BEH id) that the bridge's decision cache, when enabled, is request-scoped unless paired with DecisionCacheInvalidationLive.

Files: `spec/appendices/02-qadi-path-a-end-to-end.md`, `packages/qadi/src/DecisionCacheInvalidation.ts (new)`, `packages/qadi/src/AuthorizedSubject.ts`, `packages/qadi/src/SubjectExtractor.ts`, `packages/qadi/src/index.ts`, `spec/behaviors/19-qadi-bridge-path-a.md`, `spec/behaviors/20-qadi-bridge-path-b.md`

Tests (write first):
- First failing test: packages/qadi/test/DecisionCacheInvalidation.test.ts 'removing a member clears an app-scoped cache so the next check denies' — compose Organization + OrganizationQadi + app-scoped decisionCacheLayer + DecisionCacheInvalidationLive, Allow, removeMember, assert Deny.
- Control test: same without the bridge demonstrates the stale Allow (documents the hazard).
- packages/qadi/test/AuthorizedSubject.test.ts 'per-request decision cache does not survive across requests'.

Acceptance:
- The canonical appendix no longer wires an app-scoped cache without invalidation.
- A revoked membership is denied on the next request under both supported wirings.

Spec refs: BEH-EA-151..160 (qadi bridge), new BEH id · Effort: **M** · Depends on: none · Workstream: `qadi-decision-cache-invalidation`

**Recommended status:** `ready-for-agent`

#### RZS-002 — Revoked membership keeps deciding Allows under the canonical application-scoped decision cache, with no invalidation wiring

`high` · `security` · `—` · [.issues/high/RZS-002-rebac-zanzibar-specialist.md](../../.issues/high/RZS-002-rebac-zanzibar-specialist.md) · current status: `ready-for-agent`

**Verdict:** DUPLICATE (confidence: high) — duplicate of **PCS-001**

**Evidence at HEAD (ec065a7)**

- `spec/appendices/02-qadi-path-a-end-to-end.md:59` — Same line, same decision ticket 12 as PCS-001.
  ```
  export const QadiLive = Layer.mergeAll(EvaluationServicesNone, EvaluationIdLive, decisionCacheLayer({ capacity: 512 }))
  ```

**No fix** — Identical root cause and resolution (ticket 12). Zookie/revision semantics (its longer-term suggestion) were not adopted by the decision and are not planned.

**Recommended status:** `resolved`

#### RZS-008 — Zanzibar-grade consistency machinery absent by explicit delegation — the seam to fill is the resolver port

`info` · `architecture` · `—` · [.issues/info/RZS-008-rebac-zanzibar-specialist.md](../../.issues/info/RZS-008-rebac-zanzibar-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: medium)

**Evidence at HEAD (ec065a7)**

- `spec/decisions/009-authorization-delegated-to-qadi.md:19` — Delegation is deliberate (not a defect); what is missing is the documented consistency contract at the seam: `grep -rni 'consistency\|staleness\|spicedb\|openfga' spec/behaviors spec/appendices packages/qadi/README.md` finds none.
  ```
  relationship-graph storage, policy DSL parsing, policy distribution, reverse-index list queries — these are what SpiceDB/OpenFGA/Cedar/OPA do
  ```

**Fix plan**

_Document the consistency contract at the resolver seam alongside the cache fix: relationship answers are as fresh as the records layer; a request-scoped cache preserves that, an app-scoped one needs the invalidation bridge; swapping in a Zanzibar engine = replacing OrganizationQadi.relationships._

Steps:
1. spec/behaviors/21-qadi-resolvers-obligations.md: add a 'Consistency' paragraph (non-normative) stating the above and linking PCS-001's requirement.
2. packages/qadi/README.md + packages/organization/README.md: short 'Bringing your own graph engine' section — replace the `OrganizationQadi.relationships` RelationshipResolver layer with one backed by OpenFGA/SpiceDB `check`; note membership tuples must be exported on AfterAddMember/AfterRemoveMember hooks; no worked adapter shipped (no speculative infra).

Files: `spec/behaviors/21-qadi-resolvers-obligations.md`, `packages/qadi/README.md`, `packages/organization/README.md`

Tests (write first):
- Doc-only; spec:verify:strict.

Acceptance:
- The freshness contract and the replacement seam are written down next to the resolver behaviors.

Spec refs: ADR-EA-009, BEH-EA-161 · Effort: **S** · Depends on: PCS-001 · Workstream: `qadi-decision-cache-invalidation`

**Recommended status:** `ready-for-agent`

### Workstream `spec-status-banner-sweep`

#### DTWS-001 — spec/README.md's honesty banner asserts there is no source tree, no CI, no package.json — all false

`high` · `docs` · `—` · [.issues/high/DTWS-001-documentation-technical-writing-specialist.md](../../.issues/high/DTWS-001-documentation-technical-writing-specialist.md) · current status: `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/README.md:17` — Verbatim at HEAD; spec/README.md Revision 1.2 has never been touched since the audit.
  ```
  > **This describes a planned system.** awthaq is pre-implementation: there is no package.json, no source tree, no CI, and no shipped code.
  ```
- `spec/overview.md:17` — Not verbatim with README (audit said 'verbatim') but the same false claim; 'no code compiles against it' is false.
  ```
  > **This describes a planned system.** No package in this document has been published, no code compiles against it, and no API listed below has shipped.
  ```
- `spec/glossary.md:17` — Same false banner.
  ```
  > **This describes a planned system.** Every term below names a concept in a design that has not been implemented.
  ```
- `spec/urs.md:17` — Fifth copy of the banner not named by the audit.
  ```
  > **This describes a planned system.** No requirement below has been verified against a running awthaq; there is no implementation to verify it against yet.
  ```
- `spec/invariants.md:19` — Fourth copy named by the audit (TMS-009 owns the enforcement-cell half of this file).
  ```
  > **Banner — read before relying on anything below.** awthaq is pre-implementation (see `archive/PRD.md` and `spec/README.md`): no package has been published, no line of runtime source exists.
  ```
- `package.json:27` — package.json exists; .github/workflows/check.yml:51 runs `pnpm check`; 23 packages under packages/ (19 with real src; api-key/cli/magic-link/two-factor are 10-line `export {}` placeholders).
  ```
  "check": "pnpm typecheck && pnpm package:smoke && pnpm lint && pnpm knip && pnpm format:check && pnpm circular && pnpm coverage && pnpm test:bdd && pnpm spec:verify:strict",
  ```
- `spec/roadmap.md:17` — The model paragraph the fix should reuse (commit 0d035d4 already corrected roadmap).
  ```
  Current state: this specification remains the normative source of *why* things are built the way they are, but it is no longer the only artifact — `packages/` has a real, tested implementation of every milestone through M4 (Core, Password, the qadi bridge, OAuth and Passkey), plus Organization, Admin, and Jwt ...
  ```

**Fix plan** — Replace the five tree-level 'planned system / pre-implementation' banners (README, overview, glossary, urs, invariants) with one accurate status paragraph modelled on roadmap.md:17, and add a verify-traceability check that fails on the stale phrases so the drift cannot recur.

Steps:
1. spec/README.md: rewrite the line-17 banner to the roadmap.md:17 status wording (packages/ has a real, tested implementation through M4 plus Organization/Admin/Jwt; no package published to npm; api-key, cli, magic-link, two-factor are still placeholders; this tree is the normative *why*). Also fix README:122 ('REQ-EA-NNN (reserved — no BDD suite exists yet …)') to say REQ-EA-001..627 are allocated from features/. Bump Revision 1.2→1.3 with a Change History row citing the next free CCR id (CCR-EA-006 at HEAD) and DTWS-001.
2. spec/overview.md:17: replace the banner with the same status paragraph; keep the 'planned surface' framing only for rows that are genuinely unshipped. Bump Revision 1.1→1.2 (coordinate the same revision with DTWS-008's Ports-row reconciliation).
3. spec/glossary.md:17: replace 'names a concept in a design that has not been implemented' with a note that terms describe the shipped design unless marked planned. Bump Revision 1.1→1.2.
4. spec/urs.md:17: reword to 'requirements are verified by the tests/scenarios traced in traceability.md; untraced ones remain unverified'. Bump revision.
5. spec/invariants.md:19 and :79: replace the banner and the 'Runtime invariants (planned)' preface — coordinated with TMS-009, which rewrites the Enforcement cells in the same revision.
6. Per-file behavior/model headers (behaviors/01..27, models/05,06,07,14,15, 00-adoption-matrix) are handled by the same workstream under their own IDs (AOMS-011, OCM-008 here; BPAS-007, RZS-007, RSC-008, NAM-010/BO-008/IC-006, IDS-009, HSK-009, KRS-008/MAPS-009/VB-007 in the sibling group). Behavior files with NO audit finding but the same stale banner must also be swept: behaviors/01,02,03,04,05,06,07,08,09,10,11,12,13,14,15,16,18,19,20,22,25,26 (see workstream list).
7. Add a check to spec/scripts/verify-traceability.sh (new check 9, 'stale implementation-status phrases'): grep spec/ and features/README.md for present-tense phrases `awthaq is pre-implementation`, `awthaq is currently **pre-implementation**`, `no line of runtime source exists`, `no package.json, no source tree`, `No code implementing it exists yet`, `This describes a planned system` and FAIL listing file:line. Past-tense history (e.g. requirement-id-scheme.md:42 'was pre-implementation') is not matched. Also update the script's own stale header comments (lines 8, 18: 'no packages/ source tree yet', 'no CI reads this yet').

Files: `spec/README.md`, `spec/overview.md`, `spec/glossary.md`, `spec/urs.md`, `spec/invariants.md`, `spec/scripts/verify-traceability.sh`

Tests:
- TDD: add check 9 to spec/scripts/verify-traceability.sh FIRST and run `pnpm run spec:verify:strict` — it must FAIL listing spec/README.md:17, overview.md:17, glossary.md:17, urs.md:17, invariants.md:19 (and every behavior/model banner). It turns green only when the whole workstream lands.
- No BDD/BEH change: banners are non-normative prose.

Acceptance:
- `grep -rn 'pre-implementation\|This describes a planned system\|no line of runtime source' spec/README.md spec/overview.md spec/glossary.md spec/urs.md spec/invariants.md` returns nothing.
- Each edited document has a bumped Revision and a Change History row naming DTWS-001 and a CCR-EA id.
- `pnpm run spec:verify:strict` passes with the new stale-phrase check enabled.

Spec refs: — · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### IDS-009 — Spec docs still claim impersonation is unimplemented while shipping code exists
`low` · docs · — · [issue](../../.issues/low/IDS-009-impersonation-delegation-specialist.md)

**Verdict:** CONFIRMED (high confidence)

**Evidence at HEAD**

`spec/behaviors/27-admin-impersonation.md:15`: the standard pre-implementation banner.

`spec/invariants.md:157`:
```
**Enforcement**: Planned against [BEH-EA-209/210](behaviors/27-admin-impersonation.md) — `packages/core/test/Sessions.test.ts` (the `actingAs` idle-refresh-skip behavior) and `packages/admin/test/Admin.test.ts` (the end-to-end impersonation session), neither of which exists yet; `Admin` itself remains unimplemented.
```

`packages/core/test/Sessions.test.ts:431` (BEH-EA-209 is at :388):
```ts
it.effect("BEH-EA-210: verify never advances idleExpiresAt for an actingAs session", () =>
```

`packages/admin/README.md:3`: `> **This describes a planned package.** … no line of source in this package has shipped yet.` At HEAD, packages/admin ships Admin.ts, AdminApi.ts and ImpersonationRecords.ts plus 4 test files.

`spec/models/15-admin-impersonation.md:22` is also stale: `described here exists yet — awthaq is pre-implementation, and this`

**Fix plan**
1. `27-admin-impersonation.md`: bump to Revision 1.1 and replace the banner with pointers to `packages/admin` (files and tests), `Sessions.test.ts:388-431` and `features/features/09-admin-and-impersonation/27-admin-impersonation.feature`. Verify each of BEH-EA-209..220 against Admin.test.ts and name any that are still unimplemented.
2. INV-EA-014 Enforcement: name the existing tests. Put it in the same invariants.md revision (1.3) as DTWS-007/TMS-009.
3. Fix the status text in `spec/models/15-admin-impersonation.md` and set it to Implemented.
4. Replace the banner in `packages/admin/README.md`.
- **Files:** `spec/behaviors/27-admin-impersonation.md`, `spec/invariants.md`, `spec/models/15-admin-impersonation.md`, `packages/admin/README.md`
- **Tests:** doc-only; `pnpm run spec:verify:strict`.
- **Acceptance:** no pre-implementation or "remains unimplemented" text about Admin remains in these four files.
- **Effort:** S · **Deps:** DTWS-007 (same invariants.md edit) · **Spec refs:** BEH-EA-209, 210, INV-EA-014

**Recommended status:** ready-for-agent

#### AOMS-011 — Adoption matrix still claims 'no code exists anywhere' while seven packages are implemented

`info` · `docs` · `—` · [.issues/info/AOMS-011-auth0-okta-migration-specialist.md](../../.issues/info/AOMS-011-auth0-okta-migration-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/models/00-adoption-matrix.md:17` — Verbatim at HEAD; Revision still 1.1 (2026-09-12).
  ```
  This document is **not normative**. awthaq is currently **pre-implementation**:
  no code exists yet, anywhere in this repository. This matrix records, for each
  ```
- `spec/models/00-adoption-matrix.md:46` — Its own promotion criterion is now met for Password, OAuth/OIDC, Passkey, JWT, Organization, Admin.
  ```
  There is no **Shipped** value in this matrix, and there will not be one until
  this repository contains actual runtime code, a plugin implementing the
  method, and a passing test suite.
  ```
- `spec/models/00-adoption-matrix.md:113` — Every row still 'Planned-*'.
  ```
  | Password | Planned-MVP | P0 | E1 | [01-password.md](01-password.md) |
  | OAuth and OIDC | Planned-MVP | P0 | E2 | [02-oauth-oidc.md](02-oauth-oidc.md) |
  | Passkey and WebAuthn | Planned-MVP | P1 | E2 | [03-passkey-webauthn.md](03-passkey-webauthn.md) |
  ```
- `spec/models/00-adoption-matrix.md:130` — §5 also stale; also line 35-40 claims no entry has a normative behavior file, but behaviors/15,16,17,27 exist.
  ```
  Every "Verification" cell across the fifteen files linked above reads **None
  yet — no test exists**, without exception. ... because awthaq is pre-implementation in its entirety.
  ```
- `packages/jwt/src/Jwt.ts:1` — Shipped: password 1483/5 tests, oauth 1566/6, passkey 2093/8, jwt 1628/7, organization 5978/14, admin 796/4. Placeholders: api-key, magic-link, two-factor (10-line `export {}`).
  ```
  packages/jwt/src: Jwt.ts JwtApi.ts JwtCodec.ts JwtConfig.ts KeyRing.ts RevocationStore.ts SigningKeyRecords.ts verify.ts  (1628 src lines, 7 test files)
  ```

**Fix plan** — Cut adoption-matrix Revision 1.2: add a 'Shipped (unpublished)' status, flip the six implemented rows, rewrite §0/§1/§5 prose, keep the unimplemented rows Planned.

Steps:
1. spec/models/00-adoption-matrix.md lines 17-22: replace the pre-implementation paragraph with a current-state line mirroring roadmap.md:17.
2. Lines 33-40: amend the graduation sentence — Password (behaviors/15), OAuth (16), Passkey (17), Admin/Impersonation (27) HAVE graduated to normative behavior files; JWT and Organization are implemented without a behavior file yet (note that as a gap).
3. §1 status vocabulary (lines 44-55): add `**Shipped-Unpublished**` — 'a plugin package with real source and a passing test suite exists in packages/; not yet published to npm' — and drop the 'There is no Shipped value' sentence.
4. §4 table (lines 113-127): Password, OAuth and OIDC, Passkey and WebAuthn, JWT and Bearer, Organization, Admin/Impersonation → Shipped-Unpublished, each citing its package + test dir. Magic Link, Email OTP, Two-Factor, API Keys → keep Planned-Phase2 (placeholders). SSO/SAML/OIDC Provider/SCIM/Device Authorization → keep Planned-Phase3.
5. §5 (lines 128-139): rewrite 'A note on honesty' to say the Verification cells of shipped entries now point at real tests (per-model files are updated under their own findings: HSK-009, KRS-008/MAPS-009/VB-007, OCM-008 etc.).
6. Bump Revision 1.1→1.2, Change History row citing AOMS-011 and the CCR id.

Files: `spec/models/00-adoption-matrix.md`

Tests:
- Covered by the stale-phrase check added under DTWS-001 (`pnpm run spec:verify:strict` must fail on 00-adoption-matrix.md:17/:135 before the edit).

Acceptance:
- Matrix lists exactly six Shipped-Unpublished rows matching packages with real src + tests; four Phase2 placeholders and five Phase3 rows remain Planned.
- No 'pre-implementation' / 'no code exists' phrase remains in the file.

Spec refs: — · Effort: **S** · Depends on: DTWS-001

**Recommended status:** `ready-for-agent`

#### OCM-008 — Spec and code agree on non-implementation — docs claim verified against code

`info` · `docs` · `—` · [.issues/info/OCM-008-oauth2-client-credentials-m2m-specialist.md](../../.issues/info/OCM-008-oauth2-client-credentials-m2m-specialist.md) · current status: `needs-triage`

**Verdict:** PARTIAL (confidence: high)

**Evidence at HEAD (ec065a7)**

- `packages/api-key/src/index.ts:8` — HOLDS: the api-key plugin is still unimplemented, so the model doc's 'no hashing/storage, no SubjectResolver wiring, no test' is accurate.
  ```
  // Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
  
  export {};
  ```
- `spec/models/07-api-keys.md:23` — STALE half: the plugin doesn't exist, but 'awthaq is pre-implementation' is false.
  ```
  Nothing described here exists yet — awthaq is pre-implementation.
  ```
- `spec/models/07-api-keys.md:101` — STALE: the union and the ApiKey case both exist at HEAD.
  ```
  Everything: no contract, no `ApiKeyPrincipal` case in a `CurrentPrincipal`
  union that does not yet exist, no hashing/storage implementation, no
  ```
- `packages/api/src/Api.ts:27` — ApiKeyPrincipal is in the Principal union (Api.ts:38-43) and CurrentPrincipal exists (Api.ts:58).
  ```
  export class ApiKeyPrincipal extends Schema.TaggedClass<ApiKeyPrincipal>()("ApiKey", {
    ref: PrincipalRef,
  }) {}
  ```

**Fix plan** — Positive finding is correct about the plugin, but 07-api-keys.md carries two stale sentences; fix them in the banner sweep. (Rotation/transport decisions are OCM-005's, not this ID's.)

Steps:
1. spec/models/07-api-keys.md:23: replace with 'The ApiKey plugin (packages/api-key) is not implemented yet; the ApiKeyPrincipal contract case already exists in @awthaq/api.'
2. Lines 99-101 ('What is missing'): drop 'no ApiKeyPrincipal case in a CurrentPrincipal union that does not yet exist'; state instead that `ApiKeyPrincipal { ref }` exists in packages/api/src/Api.ts but carries no scopes field, so qadi's SubjectResolver has no scope source (the gap OCM-008's own summary names).
3. Bump the doc revision + Change History (OCM-008).

Files: `spec/models/07-api-keys.md`

Tests:
- Stale-phrase check from DTWS-001 flags 07-api-keys.md:23 before the edit.

Acceptance:
- 07-api-keys.md no longer claims the Principal union or ApiKeyPrincipal is missing; still states the plugin is unimplemented.

Spec refs: — · Effort: **S** · Depends on: DTWS-001

**Recommended status:** `ready-for-agent`

### Workstream `cli-session-login-carveout`

#### CTA-002 — BEH-EA-208 normatively bars every CLI login flow shape, with no documented carve-out

`high` · `architecture` · `—` · [.issues/high/CTA-002-cli-tool-auth-specialist.md](../../.issues/high/CTA-002-cli-tool-auth-specialist.md) · current status: `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high) — canonical for DAG-003

**Evidence at HEAD (ec065a7)**

- `spec/behaviors/26-cli.md:156` — Unamended at HEAD; file still Revision 1.2 (line 7). `grep -ci login spec/behaviors/26-cli.md` = 0.
  ```
  REQUIREMENT: Every CLI command MUST operate on `Auth.make`'s statically
               derived manifest (contract, tables, migrations, plugin graph); no
               CLI command MUST start an HTTP listener, accept a request, or
               otherwise run the application it is inspecting.
  ```
- `spec/models/13-device-authorization.md:60` — The device model doc has no note tying CLI login to the device endpoints either.
  ```
  no decision on how the divert/poll outcome interacts with the `BeforeSessionIssue` hook point
  ```
- `packages/cli/src/index.ts:8` — The CLI package ships no command at HEAD, so every CLI contract below is spec-only; code lands with BE-003 (cross-slice).
  ```
  // Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
  
  export {};
  ```

**Fix plan**

_Apply decision ticket 06 verbatim: amend BEH-EA-208 so it scopes to *inspection* commands and carve out a `login`/`logout`/`whoami` session-command family that is an outbound-only client of a running server (never a listener, never inbound), add a new behavior for that family, and cross-link spec/models/13-device-authorization.md._

Steps:
1. spec/behaviors/26-cli.md: bump Revision 1.2 -> 1.3, Effective Date 2026-09-29, Change History '1.3: Scoped BEH-EA-208 to inspection commands and carved out the session command family (login/logout/whoami) as outbound-only network clients, resolving CTA-002/DAG-003 (CCR-EA-00N)'.
2. Replace BEH-EA-208's REQUIREMENT block with the exact wording in .scratch/resolve-ready-for-human-findings/issues/06-cli-login-vs-beh-ea-208.md §'BEH-EA-208 amendment' (inspection commands listed explicitly: doctor, plugin list --graph, routes, migration status, migration apply, openapi, seed admin, import; session commands exempt but MUST NOT start a listener or accept an inbound request). Add the explanatory sentence contrasting 'manifest-derivable' vs 'needs a live process'.
3. Add a new behavior 'BEH-EA-226: session commands (`login`, `logout`, `whoami`) are outbound-only clients of a running auth server' after BEH-EA-208 (re-check the next free id at implementation time; A2 allocates 221-223, this slice's CLI group 224-227). Content per ticket 06: `login` = device-authorization flow (POST /device/code, poll /device/token on a Schedule starting at server `interval`, `slow_down` widens the delay, `expired_token` exits non-zero with 'run awthaq login again'); `login --token <t>` / `AWTHAQ_TOKEN` non-interactive path validated against the session-introspection endpoint; `logout` clears the CredentialStore and revokes server-side; `whoami` introspects. Wire transport via `@awthaq/client`'s generated HttpApiClient (not the React/atom surface).
4. Update BEH-EA-208/226 prev/next footers, spec/behaviors/index.yaml, spec/traceability.md (new BEH row -> planned test packages/cli/test/Login.test.ts), spec/urs.md if the CLI URS row enumerates behaviors.
5. spec/models/13-device-authorization.md: bump revision; in 'What is missing' add that the CLI session-command family (BEH-EA-226) is the first consumer of `/device/code`/`/device/token`, and that the poll's eventual session issuance runs through the same `Hooks.BeforeSessionIssue` divert point (packages/core/src/Hooks.ts:69) as every other login method (ticket 03).
6. features/features/08-tooling/26-cli.feature: rewrite the 'No CLI command starts an HTTP listener or accepts a request' Scenario Outline (line ~236) to iterate only inspection commands, and add Scenarios 'login polls the device endpoint as an outbound client and never opens a listener', 'login honors slow_down', 'login exits non-zero on expired_token', 'AWTHAQ_TOKEN bypasses the device flow and the credential store' (all @skip @unwired until the CLI ships).

Files: `spec/behaviors/26-cli.md`, `spec/models/13-device-authorization.md`, `spec/behaviors/index.yaml`, `spec/traceability.md`, `features/features/08-tooling/26-cli.feature`

Tests (write first):
- Spec-only change: `pnpm run spec:verify:strict` must pass with the new BEH id traced; the new Gherkin scenarios are registered (skipped) by features/features/08-tooling/26-cli.steps.test.ts so `pnpm run test:bdd` reports them.
- When the CLI lands (BE-003/CTA-001/DAG-002, cross-slice): packages/cli/test/Login.test.ts 'login never binds a socket' (assert no net.Server is created via a spy on node:net createServer) is the failing test to write first.

Acceptance:
- BEH-EA-208's REQUIREMENT names inspection commands explicitly and exempts login/logout/whoami with the no-listener/no-inbound clause intact.
- A BEH for the session-command family exists, is in index.yaml and traceability.md, and spec:verify:strict passes.
- 13-device-authorization.md names the CLI as its first consumer and points poll-issued sessions at BeforeSessionIssue.
- 26-cli.feature no longer asserts the blanket rule over session commands.

Spec refs: BEH-EA-208, BEH-EA-226 (new) · Effort: **M** · Depends on: none · Workstream: `cli-session-login-carveout`

**Recommended status:** `ready-for-agent`

#### DAG-003 — Normative CLI boundary (BEH-EA-208) forbids exactly the network behavior a device-flow login client needs

`high` · `architecture` · `—` · [.issues/high/DAG-003-device-authorization-grant-specialist.md](../../.issues/high/DAG-003-device-authorization-grant-specialist.md) · current status: `ready-for-agent`

**Verdict:** DUPLICATE (confidence: high) — duplicate of **CTA-002**

**Evidence at HEAD (ec065a7)**

- `spec/behaviors/26-cli.md:156` — Same REQUIREMENT block as CTA-002; decision ticket 06 resolves both with one amendment.
  ```
  REQUIREMENT: Every CLI command MUST operate on `Auth.make`'s statically
               derived manifest (contract, tables, migrations, plugin graph); no
               CLI command MUST start an HTTP listener, accept a request, or
  ```

**No fix** — Same root cause and same decision (ticket 06) as CTA-002; its extra ask (note in 13-device-authorization.md) is folded into CTA-002's fix plan step 5.

**Recommended status:** `resolved`

#### CTA-004 — Credential storage is an open question — no keychain integration, no fallback decision, no prohibition

`medium` · `security` · `—` · [.issues/medium/CTA-004-cli-tool-auth-specialist.md](../../.issues/medium/CTA-004-cli-tool-auth-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/behaviors/09-authentication-middleware.md:55` — Still the only spec mention of CLI credential storage; no decision record in spec/decisions/.
  ```
  `archive/design/usage-examples-v4.md` §11.3 documents the native-client path this handler serves: a mobile or CLI client with no cookie jar reaches the same contract via `Auth.api(..., { csrf: false })` and a bearer token pulled from a keychain
  ```
- `.scratch/resolve-ready-for-human-findings/issues/06-cli-login-vs-beh-ea-208.md:70` — The storage design IS decided (ticket 06) but has not been written into spec/; repo-wide grep for keychain/keytar/libsecret in packages/*/src returns only an AAGUID label in Passkey.ts:105.
  ```
  **Credential storage** (per the specialist persona's core expertise, "won't default to a plaintext token file"): a `CredentialStore` port in `packages/cli` with OS-specific backends
  ```

**Fix plan**

_Record ticket 06's CredentialStore decision normatively (new behavior next to the session-command BEH) so the login implementation cannot default to a plaintext dotfile._

Steps:
1. spec/behaviors/26-cli.md: add 'BEH-EA-227: CLI credentials live in a CredentialStore, never a plaintext dotfile by default' (next free id). REQUIREMENT: session-command credentials MUST be stored through a `CredentialStore` port (get/set/clear) whose default Layer resolves, in order, macOS Keychain, Linux Secret Service (libsecret), Windows Credential Manager; only when none is reachable MAY it fall back to `$XDG_CONFIG_HOME/awthaq/credentials.json` created with mode 0600 in a 0700 directory, and the CLI MUST warn once when using the fallback; `AWTHAQ_TOKEN` (CI) always wins and MUST never be written to any store; tokens MUST be carried as `Redacted` in memory and never printed (ties to ECS-005's redaction clause).
2. Cross-reference BEH-EA-227 from spec/behaviors/09-authentication-middleware.md:55 (replace 'pulled from a keychain' with a link to BEH-EA-227 for the CLI case; mobile storage stays the app's job per ticket 17).
3. features/features/08-tooling/26-cli.feature: add @skip @unwired scenarios 'login stores the credential in the OS keychain when available', 'fallback credentials file is created 0600 and a warning is printed', 'AWTHAQ_TOKEN is never persisted'.
4. Traceability: add the BEH row -> planned test packages/cli/test/CredentialStore.test.ts.

Files: `spec/behaviors/26-cli.md`, `spec/behaviors/09-authentication-middleware.md`, `spec/behaviors/index.yaml`, `spec/traceability.md`, `features/features/08-tooling/26-cli.feature`

Tests (write first):
- Spec-only now; the first failing test at implementation time: packages/cli/test/CredentialStore.test.ts 'layerFile writes credentials.json with mode 0600' (fs.stat mode & 0o777 === 0o600) and 'AWTHAQ_TOKEN short-circuits get and set is never called'.

Acceptance:
- 26-cli.md contains a normative CredentialStore requirement with keychain-first order, 0600 fallback, env-var precedence and a no-plaintext-by-default rule.
- spec:verify:strict passes with the new id traced.

Spec refs: BEH-EA-227 (new), BEH-EA-065 · Effort: **S** · Depends on: CTA-002 · Workstream: `cli-session-login-carveout`

**Recommended status:** `ready-for-agent`

### Workstream `cli-exit-code-and-arg-contract`

#### ECS-001 — No exit-code contract despite CI-first design

`high` · `dx` · `—` · [.issues/high/ECS-001-effect-cli-specialist.md](../../.issues/high/ECS-001-effect-cli-specialist.md) · current status: `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/behaviors/26-cli.md:32` — `grep -ni exit spec/behaviors/26-cli.md features/features/08-tooling/26-cli.feature` returns nothing at HEAD.
  ```
  `usage-examples-v4.md` §23 lists exactly this scope. Running against the statically derived manifest (BEH-EA-208) rather than a live process means `doctor` can be run in CI, before deploy
  ```
- `../effect/packages/effect/src/Runtime.ts:228` — Effect v4 already supports per-error exit codes via the `Runtime.errorExitCode` symbol (and CliError sets it, CliError.ts:624), so the contract is mechanically implementable.
  ```
      readonly [errorExitCode]?: number
  ```
- `packages/cli/src/index.ts:8` — The CLI package ships no command at HEAD, so every CLI contract below is spec-only; code lands with BE-003 (cross-slice).
  ```
  // Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
  
  export {};
  ```

**Fix plan**

_Add a normative process contract for every CLI command: a fixed exit-code table derived mechanically from each command's TaggedError `_tag` via Effect v4's `Runtime.errorExitCode`, plus one scenario per class._

Steps:
1. spec/behaviors/26-cli.md: add 'BEH-EA-224: every CLI command exits with a stable, typed exit code' (next free id). Table: 0 success/clean; 1 unexpected defect; 2 usage error (CliError / argument Schema decode failure, see BEH-EA-225); 3 doctor found problems (DoctorFindings); 4 nothing to apply (`migration apply` with no pending — distinct from success so CI can branch; expose `--allow-empty` to map it to 0); 5 apply failed (MigrationFailed); 6 refused without confirmation (ConfirmationRequired: `apply` without --yes, `seed admin` against an existing admin without --force); 7 drift/ledger mismatch (LedgerDrift, ECS-009); 8 authentication required/expired (session commands, BEH-EA-226). REQUIREMENT: each typed CLI error class MUST carry its code as `[Runtime.errorExitCode]` so the mapping is compile-time, never parsed from prose; `--json` output MUST include the same `_tag` and code.
2. Amend BEH-EA-201 (doctor), 204 (migration), 206 (seed) prose to reference the table (e.g. 'doctor exits 3 when it reports any finding').
3. features/features/08-tooling/26-cli.feature: add a 'Rule: exit codes' block with one @skip @unwired Scenario per class (doctor clean -> 0; doctor finding -> 3; apply without --yes -> 6; apply with nothing pending -> 4; bad --from value -> 2).
4. Implementation (lands with the CLI skeleton BE-003): packages/cli/src/CliErrors.ts defines `DoctorFindings`, `NothingToApply`, `MigrationFailed`, `ConfirmationRequired`, `LedgerDrift`, `AuthenticationRequired` as `Schema.TaggedError` classes each with `readonly [Runtime.errorExitCode] = N` (no `as` casts; the symbol property is declared on the class). The bin entry runs the Command with `NodeRuntime.runMain`, which honors errorExitCode.
5. spec/traceability.md: map BEH-EA-224 -> packages/cli/test/ExitCodes.test.ts.

Files: `spec/behaviors/26-cli.md`, `spec/behaviors/index.yaml`, `spec/traceability.md`, `features/features/08-tooling/26-cli.feature`, `packages/cli/src/CliErrors.ts (new, with BE-003)`, `packages/cli/test/ExitCodes.test.ts (new)`

Tests (write first):
- First failing test (with BE-003): packages/cli/test/ExitCodes.test.ts 'migration apply without --yes fails with ConfirmationRequired whose errorExitCode is 6' and 'doctor on an insecure config fails with exit code 3' — run the Command in-process and assert `Exit` failure's error[Runtime.errorExitCode].
- BDD: the new 26-cli.feature exit-code Rule (skipped until wired).

Acceptance:
- 26-cli.md has one exit-code table referenced by BEH-EA-201/204/206/207/226.
- Every CLI error class carries its exit code as a typed property; no command sets `process.exitCode` by hand.
- spec:verify:strict passes.

Spec refs: BEH-EA-224 (new), BEH-EA-201, BEH-EA-204, BEH-EA-206, BEH-EA-027 · Effort: **M** · Depends on: none · Workstream: `cli-exit-code-and-arg-contract`

**Recommended status:** `ready-for-agent`

#### ECS-007 — CLI argument validation not tied to the repo's Schema contracts

`medium` · `api` · `—` · [.issues/medium/ECS-007-effect-cli-specialist.md](../../.issues/medium/ECS-007-effect-cli-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/behaviors/26-cli.md:131` — The source enum exists only as prose; BEH-EA-206 (lines 116-121) names no Schema for the seed-admin account identifier either.
  ```
  awthaq import --from better-auth|authjs|lucia
  ```
- `../effect/packages/effect/src/unstable/cli/Flag.ts:1100` — Effect v4's CLI already binds a Schema to a flag/argument (`Flag.withSchema`), so reusing the API's Schemas costs nothing.
  ```
  export const withSchema: {
  ```

**Fix plan**

_Make 'every CLI option/argument decodes through a Schema, reusing the HTTP contract's Schemas where one exists' normative, so invalid input fails as a typed usage error (exit 2)._

Steps:
1. spec/behaviors/26-cli.md: add 'BEH-EA-225: CLI arguments decode through the contract's Schemas' (next free id). REQUIREMENT: every flag/argument MUST be declared with `Flag.withSchema`/`Argument.withSchema` (effect/unstable/cli); `seed admin --email` MUST reuse the same email Schema the password sign-up payload uses (packages/api); `import --from` MUST be a `Schema.Literals(["better-auth","authjs","lucia"])` whose members are the registered SourceAdapter names (decision ticket 07); `--config` MUST be a path Schema; decode failures MUST surface as the usage-error class of BEH-EA-224.
2. Amend BEH-EA-206 to name the account identifier (email, via the shared Schema) and BEH-EA-207's example to reference the literal enum.
3. features/features/08-tooling/26-cli.feature: add @skip @unwired Scenarios 'seed admin rejects a malformed email with a usage error' and 'import rejects an unknown --from value listing the supported sources'.
4. Implementation (with BE-003): export the email Schema from packages/api if it is not already exported (check packages/api/src for the sign-up payload Schema) and import it in packages/cli/src/Seed.ts; `ImportSource` literal Schema in packages/cli/src/Import.ts derived from the adapter registry keys.

Files: `spec/behaviors/26-cli.md`, `spec/behaviors/index.yaml`, `spec/traceability.md`, `features/features/08-tooling/26-cli.feature`, `packages/cli/src/Seed.ts (new)`, `packages/cli/src/Import.ts (new)`

Tests (write first):
- First failing test (with BE-003): packages/cli/test/Arguments.test.ts 'seed admin --email not-an-email fails with a usage error (exit 2) before any service is built'.

Acceptance:
- 26-cli.md requires Schema-bound arguments and names the shared Schemas.
- No hand-rolled string parsing in packages/cli (review + `grep -n "split(\|parseInt" packages/cli/src` clean).

Spec refs: BEH-EA-225 (new), BEH-EA-206, BEH-EA-207, BEH-EA-027 · Effort: **S** · Depends on: ECS-001 · Workstream: `cli-exit-code-and-arg-contract`

**Recommended status:** `ready-for-agent`

### Workstream `cli-import-tooling`

#### BAM-001 — better-auth import tooling is spec-only; the cli package ships nothing

`high` · `dx` · `—` · [.issues/high/BAM-001-better-auth-migration-specialist.md](../../.issues/high/BAM-001-better-auth-migration-specialist.md) · current status: `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/behaviors/26-cli.md:131` — BEH-EA-207 unchanged (Revision 1.2).
  ```
  awthaq import --from better-auth|authjs|lucia
  ```
- `packages/cli/src/index.ts:8` — The CLI package ships no command at HEAD, so every CLI contract below is spec-only; code lands with BE-003 (cross-slice).
  ```
  // Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
  
  export {};
  ```
- `packages/migrate-better-auth/src/index.ts:10` — The better-auth migration package ships only the session cutover bridge (BAM-003), no user/account import.
  ```
  export * as AliasLegacyCookieMiddleware from "./AliasLegacyCookieMiddleware.ts";
  export * as LegacySessionBridgeLive from "./LegacySessionBridgeLive.ts";
  ```

**Fix plan**

_Follow decision ticket 07 §6: a generic `SourceAdapter` interface and `import --from <source>` command, only the better-auth adapter implemented and validated against a real export fixture; authjs/lucia registered but refusing with a typed NotImplemented error; rows go through Users/Accounts domain services; unmapped fields reported; resumable via an import-runs table._

Steps:
1. Prereq: CLI skeleton + ManifestLoader (awthaq.config.ts) from BE-003 (cross-slice canonical for 'CLI is an empty placeholder').
2. packages/migrate-better-auth/src/BetterAuthSource.ts (new): Schemas for better-auth's `user`, `account`, `session`, `verification` rows (decode, never cast); pure mapping functions `mapUser(row) -> Effect<{ user: Users.CreateInput, accounts: ReadonlyArray<Accounts.LinkInput>, unmapped: ReadonlyArray<UnmappedField> }>` onto the existing Model.Class insert shapes; credential accounts keep better-auth's scrypt hash, verified through a `LegacyPasswordVerifierShape` (pattern from packages/migrate-auth0/src/BcryptVerifier.ts) so rehashOnLogin retires it.
3. packages/cli/src/Import.ts (new): `SourceAdapter { name; read: (src) => Stream<RawSourceRow, ImportError>; map: (row) => Effect<MappedInput, UnmappableFieldError> }`; registry { 'better-auth': BetterAuthSource, 'authjs': notImplemented, 'lucia': notImplemented }; `--from` Schema literal from the registry keys (ECS-007); `--report <path>` writes per-row unmapped-field JSON; `--dry-run`.
4. Resumability: a first-party migration adding `awthaq_import_runs (run_id, source, source_row_id, status, imported_user_id, error)`; skip rows already `done` on re-run.
5. spec/behaviors/26-cli.md BEH-EA-207: revise per decision 07 — 'MUST support better-auth; authjs and lucia MUST be accepted by the --from Schema and MUST fail with a typed not-yet-validated error until their adapters are validated against real exports'; describe the report and resumability; bump revision.
6. features/features/08-tooling/26-cli.feature: update the 'import supports each named source framework' Scenario Outline accordingly; add 'a re-run after partial failure skips imported rows'.

Files: `packages/cli/src/Import.ts (new)`, `packages/migrate-better-auth/src/BetterAuthSource.ts (new)`, `packages/migrate-better-auth/test/fixtures/better-auth-export.sqlite (new)`, `packages/sql/src (import-runs migration)`, `spec/behaviors/26-cli.md`, `features/features/08-tooling/26-cli.feature`

Tests (write first):
- First failing test: packages/migrate-better-auth/test/BetterAuthSource.test.ts 'maps a better-auth user+credential account into Users.create + Accounts.link input and reports unmapped columns' over a checked-in fixture exported from a real better-auth SQLite DB.
- packages/cli/test/Import.test.ts 'import is resumable: second run imports 0 rows and reports N skipped'; 'import --from lucia fails with NotYetValidated (exit 2/usage class)'.
- Integration: an imported credential signs in through Password.signIn and is rehashed (needsRehash) on first login.

Acceptance:
- `awthaq import --from better-auth` imports users/accounts from a real fixture through domain services, emits an unmapped-field report, and is resumable.
- authjs/lucia are typed, refused, and documented as not validated.
- BEH-EA-207 matches the shipped scope.

Spec refs: BEH-EA-207, BEH-EA-039, BEH-EA-225 (new) · Effort: **XL** · Depends on: BE-003, ECS-007 · Workstream: `cli-import-tooling`

Note / recommendation: Decision 07 flags better-auth-first as a scope call worth the user's confirmation; this plan follows it (not re-litigated).

**Recommended status:** `ready-for-agent`

### Workstream `multi-tenant-composition`

#### EP-001 — No tenant model exists; one static composition per process is the only deployment shape

`high` · `architecture` · `—` · [.issues/high/EP-001-eugenio-pace.md](../../.issues/high/EP-001-eugenio-pace.md) · current status: `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/decisions/005-static-composition.md:23` — Decision section already prescribes per-tenant config via Context.Reference / LayerMap.Service.
  ```
  The plugin set passed to `Auth.make` is fixed at composition time and is not runtime-reconfigurable
  ```
- `spec/decisions/005-static-composition.md:39`
  ```
  Not yet implemented — see spec/roadmap.md for milestone.
  ```
- `packages/core/src/RateLimits.ts:15` — `grep -rn -i 'tenantId\|tenant_id\|TenantContext\|LayerMap' packages/*/src` returns nothing at HEAD.
  ```
  // `Auth.make` call in the same process (two unrelated test suites, or two
  // tenants, polluting each other's rule list,
  ```

**Fix plan**

_Implement decision ticket 18: tenant = Organization row; ambient `TenantContext` in core; nullable indexed `tenant_id` on the five core tables stamped on every write; `TenantResolver` port + opt-in `Organization.tenantMiddleware`; Postgres RLS; per-org OAuth connections via a LayerMap-backed `OrganizationConnections`. Record it as an ADR first._

Steps:
1. spec/decisions/018-tenancy-is-an-organization.md (new, ADR-EA-018; re-check next free number — A2 takes 017): Decision = tenant is an Organization row, expressed as runtime configuration/data within installed plugins (ADR-EA-005's reserved seam), host-per-tenant rejected; consequences: opaque core `tenant_id`, TenantResolver port (ADR-EA-010: app provides it), RLS on Postgres, WHERE-discipline only on SQLite. Update spec/decisions/index.yaml and ADR-005 line 39 to link it.
2. packages/core/src/TenantContext.ts (new): `TenantContext = Context.Reference<Option.Option<string>>("awthaq/core/TenantContext", { defaultValue: () => Option.none() })`; export from packages/core/src/index.ts.
3. packages/sql/src/CoreMigrations.ts: forward-only migration adding `tenant_id TEXT NULL` + index to users, accounts, sessions, verification_tokens, verification_reservations (both dialect branches); packages/sql/src/Models.ts + Repositories.ts gain the column; Users.create, Accounts.link, Sessions.issue, Verification.issue read TenantContext and stamp it; finders filter by it when Some.
4. Postgres: RLS policies `USING (tenant_id = current_setting('awthaq.tenant_id', true) OR current_setting('awthaq.tenant_id', true) IS NULL)` on the five tables; SqlTransaction layer issues `SET LOCAL awthaq.tenant_id` when TenantContext is Some.
5. packages/organization/src/TenantResolver.ts (new port, required only by the middleware): `(request) => Effect<Option<OrganizationId>>`; `Organization.tenantMiddleware` provides TenantContext per request.
6. packages/organization: `organization_oauth_connection` table (client secret encrypted via the existing Encryption/KeyProvider ports), `OrganizationConnections` as `LayerMap.Service` keyed by org id building an OAuthProvider with the same `OAuthProvider.resolve` used for static providers; OAuth.authorize/callback fall through static map -> OrganizationConnections (this sub-step is CWM-001/EP-004's canonical fix in other slices — coordinate, don't duplicate).
7. Docs: spec/models/14-organization.md gains a 'Tenancy' section; examples/memory-server shows two tenants.

Files: `spec/decisions/018-tenancy-is-an-organization.md (new)`, `spec/decisions/005-static-composition.md`, `spec/decisions/index.yaml`, `packages/core/src/TenantContext.ts (new)`, `packages/core/src/{Users,Accounts,Sessions,Verification}.ts`, `packages/sql/src/{CoreMigrations,Models,Repositories}.ts`, `packages/organization/src/TenantResolver.ts (new)`, `packages/organization/src/Organization.ts`, `packages/oauth/src/OAuth.ts`

Tests (write first):
- First failing test: packages/core/test/Users.test.ts 'Users.create stamps TenantContext into tenant_id and findByEmail does not see another tenant's user' (memory + SQL layers).
- packages/sql/test/Repositories.postgres.test.ts 'RLS blocks a cross-tenant read when awthaq.tenant_id is set' (CI-only Postgres).
- packages/organization/test 'tenantMiddleware resolves the org and provides TenantContext for the handler fiber'.
- BDD: a new @skip-until-wired scenario in features/features/02-domain/06-users-accounts.feature 'two tenants may register the same email independently'.

Acceptance:
- A single-tenant app with no middleware behaves exactly as today (all tenant_id NULL).
- Two organizations in one composition have isolated users/sessions, enforced by RLS on Postgres.
- ADR-EA-018 recorded; ADR-005 no longer says 'Not yet implemented' without a pointer.

Spec refs: ADR-EA-005, ADR-EA-006, ADR-EA-010, ADR-EA-018 (new), BEH-EA-017 · Effort: **XL** · Depends on: DRS-001, CWM-001 · Workstream: `multi-tenant-composition`

Note / recommendation: XL — decompose into (1) ADR + TenantContext + columns/stamping, (2) RLS, (3) TenantResolver/middleware, (4) per-org connections (CWM-001/EP-004 cross-slice). DRS-001 (tenant/shard key, other slice) shares step (1); whichever slice runs first owns it.

**Recommended status:** `ready-for-agent`

#### EP-007 — Per-tenant configuration mechanism designed but unimplemented

`medium` · `architecture` · `—` · [.issues/medium/EP-007-eugenio-pace.md](../../.issues/medium/EP-007-eugenio-pace.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/decisions/005-static-composition.md:39`
  ```
  Not yet implemented — see spec/roadmap.md for milestone.
  ```
- `packages/password/src/Password.ts:541` — Worse than 'unimplemented': plugins read their Context.Reference once inside `make` (Layer build), so even a per-request `Effect.provideService(PasswordConfig, ...)` cannot vary it; LayerMap appears nowhere in packages/*/src.
  ```
        const config = yield* PasswordConfig;
  ```
- `packages/password/src/Password.ts:58`
  ```
  export const config = (partial: Partial<PasswordConfigShape>): Layer.Layer<never> =>
    Layer.succeed(PasswordConfig, { ...defaultPasswordConfig, ...partial });
  ```

**Fix plan**

_Make per-tenant configuration real: plugins read their config Reference per operation (not once at Layer build), and a `TenantConfig` LayerMap.Service keyed by tenant id supplies each tenant's config Layers, provided per request by the tenant middleware — ADR-005/006's own prescription._

Steps:
1. Refactor every plugin that captures config in `make` to read it inside each operation: packages/password/src/Password.ts:541 (`const config = yield* PasswordConfig` -> read in signUp/signIn/changePassword/etc.), packages/core/src/Sessions.ts (`const config = yield* SessionConfig` in layerMemory/layerSql), OAuth, Passkey, Organization, Jwt, Admin. Context.Reference reads are cheap; this is what makes `Effect.provideService` overrides effective.
2. packages/core/src/TenantConfig.ts (new): `TenantConfig` = `LayerMap.Service<TenantConfig>()("awthaq/core/TenantConfig", { lookup: (tenantId: string) => Layer<never> , idleTimeToLive })` where lookup is supplied by the app (a function from tenant id to a merged `Password.config(...)`/`Sessions.config(...)` Layer, e.g. loaded from the organization's settings). Default: no TenantConfig -> global config.
3. Organization.tenantMiddleware (EP-001) additionally does `Effect.provide(TenantConfig.get(tenantId))` around the handler when TenantConfig is installed.
4. spec/decisions/006 & 005: link to ADR-EA-018's config section; add a behavior (next free id) 'per-tenant configuration overrides apply per request without changing the plugin tuple'.

Files: `packages/password/src/Password.ts`, `packages/core/src/Sessions.ts`, `packages/oauth/src/OAuth.ts`, `packages/passkey/src/Passkey.ts`, `packages/organization/src/Organization.ts`, `packages/jwt/src/Jwt.ts`, `packages/core/src/TenantConfig.ts (new)`, `spec/decisions/005-static-composition.md`, `spec/decisions/006-runtime-config-separate-from-installation.md`

Tests (write first):
- First failing test (the issue's own acceptance): packages/password/test/Password.test.ts 'two tenants with different Password.config({ minLength }) in one composition' — tenant A (minLength 8) accepts an 10-char password, tenant B (minLength 16) rejects it with WeakPassword, same Password layer instance.
- packages/core/test/Sessions.test.ts 'SessionConfig override provided per request changes idle expiry'.

Acceptance:
- One composition serves two tenants with different plugin config; no plugin captures config at build time (grep `yield\* .*Config;` inside `make` bodies is empty).

Spec refs: ADR-EA-005, ADR-EA-006, ADR-EA-011, BEH-EA-017, BEH-EA-018 · Effort: **L** · Depends on: EP-001 · Workstream: `multi-tenant-composition`

**Recommended status:** `ready-for-agent`

### Workstream `enterprise-federation-saml-scim`

#### AOMS-009 — SAML and SCIM are Phase-3 plans with no code: enterprise IdP interop and directory sync absent

`high` · `architecture` · `—` · [.issues/high/AOMS-009-auth0-okta-migration-specialist.md](../../.issues/high/AOMS-009-auth0-okta-migration-specialist.md) · current status: `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high) — canonical for SFS-001, SFS-008

**Evidence at HEAD (ec065a7)**

- `spec/models/00-adoption-matrix.md:124` — Unchanged; `ls packages` has no saml/scim/sso package.
  ```
  | SAML | Planned-Phase3 | P3 | E2, E5 | [10-saml.md](10-saml.md) |
  | OIDC Provider | Planned-Phase3 | P3 | E2, E5 | [11-oidc-provider.md](11-oidc-provider.md) |
  | SCIM | Planned-Phase3 | P4 | E5 | [12-scim.md](12-scim.md) |
  ```
- `spec/roadmap.md:125` — Roadmap still unscheduled despite decision ticket 08 resequencing SAML/SCIM.
  ```
  - Implement every enterprise protocol in v1 (SSO, SAML, an OIDC provider, SCIM and device authorization are M(3) roadmap items, not v1 scope
  ```

**Fix plan**

_Execute decision ticket 08's spec half now (ADR + contracts + resequenced roadmap) and its code half in order: UserRecord deactivation (ticket 09) -> packages/scim -> packages/saml (SP-only), SAML runnable in parallel with SCIM substrate._

Steps:
1. spec/decisions/019-enterprise-federation-packages.md (new ADR-EA-019; next free number): SAML ships as `packages/saml` (SP only; IdP/E5 out of scope), SCIM as `packages/scim` (inbound RFC 7644 server), each an AuthPlugin.Service; SSO is a connection resolver dispatching to the standalone Saml/OAuth plugins (SFS-006); `SamlSigner` port (SFS-003); org connections table reserves kind `saml` (ticket 18). Update spec/decisions/index.yaml.
2. spec/models/00-adoption-matrix.md rows 123-126 + spec/roadmap.md:125: replace 'Planned-Phase3 / not v1 scope' for SAML/SCIM with the scheduled sequence (after ticket 09's deactivation state) and link ADR-EA-019; keep OIDC Provider and Device Authorization rows as-is unless their own tickets move them.
3. spec/models/10-saml.md + 12-scim.md: bump revisions; replace 'No design beyond this row exists yet' with the ADR's package/contract shape: SamlApi (`GET /auth/saml/metadata`, `POST /auth/saml/acs`, `saml_connection` table), ScimApi (`/scim/v2/Users`, `/scim/v2/Groups`, connection bearer token, `scim_external_id(scimConnectionId, externalId, userId)`), deactivation -> Sessions.revokeAll.
4. Code (separate follow-up tickets, each ready-for-agent after the ADR lands): packages/saml with SamlSigner port + ordered validation chain (SFS-007); packages/scim (CWM-002 owns its fix plan).

Files: `spec/decisions/019-enterprise-federation-packages.md (new)`, `spec/decisions/index.yaml`, `spec/models/00-adoption-matrix.md`, `spec/roadmap.md`, `spec/models/09-sso.md`, `spec/models/10-saml.md`, `spec/models/12-scim.md`, `packages/saml (new)`, `packages/scim (new)`

Tests (write first):
- Spec phase: `pnpm run spec:verify:strict` (new ADR traced, no orphan).
- Code phase first failing tests: packages/saml/test/SamlSigner.test.ts 'rejects an assertion whose signed element is not the processed element (XSW)'; packages/scim (see CWM-002).

Acceptance:
- ADR-EA-019 exists and the adoption matrix/roadmap show SAML/SCIM as scheduled with the ticket-09 prerequisite.
- 10-saml.md/12-scim.md describe the contracts instead of 'no design exists'.

Spec refs: ADR-EA-019 (new), ADR-EA-008, ADR-EA-010, MOD-EA-009, MOD-EA-010, MOD-EA-012 · Effort: **XL** · Depends on: ticket-09 UserRecord deactivation (cross-slice) · Workstream: `enterprise-federation-saml-scim`

Note / recommendation: Decision 08 flags SAML+SCIM-as-first-party as a scope call for the user's sanity check; the plan follows it.

**Recommended status:** `ready-for-agent`

#### CWM-002 — SCIM directory sync entirely absent — WorkOS's SCIM wedge has no provisioning surface to migrate onto

`high` · `architecture` · `—` · [.issues/high/CWM-002-clerk-workos-migration-specialist.md](../../.issues/high/CWM-002-clerk-workos-migration-specialist.md) · current status: `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high) — canonical for SCP-009

**Evidence at HEAD (ec065a7)**

- `spec/models/00-adoption-matrix.md:126`
  ```
  | SCIM | Planned-Phase3 | P4 | E5 | [12-scim.md](12-scim.md) |
  ```
- `packages/core/src/Users.ts:107` — Still only a destructive delete — no active/suspended state (`grep -n -i 'deactivat\|suspend' packages/core/src/Users.ts` is empty); no scim code anywhere.
  ```
    readonly delete: (id: UserId) => Effect.Effect<void, UserNotFound | HookPoint.HookAborted>;
  ```

**Fix plan**

_Per decision 08: after ticket 09's UserRecord deactivation state lands, ship `packages/scim` (inbound RFC 7644) with an external-id mapping table and Sessions.revokeAll on deactivation; publish the interim deprovisioning recipe now._

Steps:
1. Now (doc, S): add an 'Interim deprovisioning recipe' section to spec/models/12-scim.md and packages/organization/README.md: subscribe `AuthEvents.on("auth.organization.memberRemoved", ...)` (packages/core/src/AuthEvents.ts on()) and call `Sessions.revokeAll(userId)` when the user has no remaining memberships.
2. Prereq (cross-slice, ticket 09): `UserRecord.status: "active" | "deactivated"` + `Users.deactivate/reactivate`, sign-in and Sessions.verify refusing deactivated users.
3. packages/scim (new plugin, AuthPlugin.Service, dependsOn [Users, Sessions, Organization]): tables `scim_connection(id, organizationId, tokenHash)` and `scim_external_id(scimConnectionId, externalId, userId)`; ScimApi group `scim` with `/scim/v2/Users` (GET filter eq userName/externalId, POST, GET/{id}, PUT, PATCH replace active, DELETE -> deactivate not delete) and `/scim/v2/Groups` mapped to organization teams; bearer auth via connection token (SHA-256 at rest, constant-time compare); idempotent PATCH; `active:false` -> Users.deactivate + Sessions.revokeAll; publishes `auth.scim.userDeactivated`.
4. Spec: 12-scim.md graduates to contracts (see AOMS-009 step 3); add a behaviors file for SCIM with BEH ids at implementation time; features/features/05-authentication-methods/NN-scim.feature.

Files: `spec/models/12-scim.md`, `packages/organization/README.md`, `packages/scim (new)`, `packages/core/src/AuthEvents.ts`

Tests (write first):
- First failing test (code phase): packages/scim/test/Scim.test.ts 'PATCH active=false deactivates the user and revokes every live session'; 'repeat POST with the same externalId is idempotent'; 'a token for connection A cannot read connection B's users'.

Acceptance:
- An IdP can create, update, deactivate users via /scim/v2 and deactivation kills sessions immediately.
- The interim recipe is documented before the package ships.

Spec refs: ADR-EA-019 (new), MOD-EA-012, BEH-EA-054 · Effort: **XL** · Depends on: AOMS-009, ticket-09 UserRecord deactivation (cross-slice) · Workstream: `enterprise-federation-saml-scim`

**Recommended status:** `ready-for-agent`

#### SFS-003 — No XML-signature port exists despite the spec sketch depending on one

`medium` · `architecture` · `—` · [.issues/medium/SFS-003-saml-federation-specialist.md](../../.issues/medium/SFS-003-saml-federation-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/models/10-saml.md:43`
  ```
        const signer = yield* SamlSigner        // port: XML signature verification/signing, not yet designed
  ```
- `packages/ports/src/index.ts:27` — Full port export list at HEAD (plus WebAuthn at :35): no signature/X.509 port.
  ```
  export * as ClientAddress from "./ClientAddress.ts";
  export * as Encryption from "./Encryption.ts";
  export * as KeyProvider from "./KeyProvider.ts";
  export * as LegacySessionBridge from "./LegacySessionBridge.ts";
  export * as Mailer from "./Mailer.ts";
  export * as PasswordHasher from "./PasswordHasher.ts";
  export * as RateLimiter from "./RateLimiter.ts";
  export * as SqlTransaction from "./SqlTransaction.ts";
  ```

**Fix plan**

_Design the `SamlSigner` port in spec before any plugin code, with fused parse+verify semantics, then implement it in packages/saml (port lives in @awthaq/ports per ADR-EA-010)._

Steps:
1. spec/models/10-saml.md: replace the 'not yet designed' comment with a 'SamlSigner port' section: `verifyResponse(xml: string, trust: IdpTrustSet) => Effect<VerifiedAssertion, SamlVerificationError>` — parse and verify fused (no unverified intermediate DOM escapes), DTD/external entities disabled inside the port, exclusive C14N handled internally, returns only the *signed* Assertion element's data (anti-XSW), algorithm allow-list (RSA-SHA256+, no SHA-1), `IdpTrustSet` = array of certs keyed by fingerprint with `notBefore/notAfter` for rotation overlap, metadata-ingest helper `trustFromMetadata(xml)`. Signing (AuthnRequest/metadata) as a separate optional `sign` method.
2. Add this port to ADR-EA-019 and spec/overview.md's ports-stratum table (coordinate with DTWS-008's reconciliation).
3. Code phase: packages/ports/src/SamlSigner.ts (service tag + shape, no implementation); packages/saml/src/SamlSignerLive.ts implementation over a maintained XML-DSig library (e.g. xml-crypto + @xmldom/xmldom with entity resolution disabled) — audited before adoption, no home-grown crypto.

Files: `spec/models/10-saml.md`, `spec/overview.md`, `spec/decisions/019-enterprise-federation-packages.md`, `packages/ports/src/SamlSigner.ts (new)`, `packages/saml/src/SamlSignerLive.ts (new)`

Tests (write first):
- Code phase first failing tests: packages/saml/test/SamlSigner.test.ts — 'rejects XML with a DOCTYPE/external entity', 'rejects a response where a second unsigned Assertion is injected (XSW1-8 corpus)', 'accepts an assertion signed by the previous cert during the overlap window'.

Acceptance:
- 10-saml.md specifies the port contract (fused parse+verify, XXE off, signed-element-only, rotation-aware trust set).

Spec refs: MOD-EA-010, ADR-EA-010, ADR-EA-019 (new) · Effort: **M** · Depends on: AOMS-009 · Workstream: `enterprise-federation-saml-scim`

**Recommended status:** `ready-for-agent`

#### SFS-006 — SSO facade vs standalone Saml plugin dispatch is undecided

`info` · `api` · `—` · [.issues/info/SFS-006-saml-federation-specialist.md](../../.issues/info/SFS-006-saml-federation-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/models/09-sso.md:65` — Still open in the spec at HEAD. Decisions 08 (packages/saml as its own plugin) and 18 (organization_oauth_connection with kind oidc/oauth2, `saml` reserved for the SSO plugin) together imply the dispatch shape but neither records it.
  ```
  no decision on whether SSO wraps SAML and OIDC-based enterprise connections under one plugin or dispatches to the separate `Saml`/`OAuth` plugins underneath
  ```

**Fix plan**

_Record the dispatch shape implied by decisions 08 and 18 in ADR-EA-019: standalone `Saml` and `OAuth` plugins own their protocol routes; `Sso` is a thin connection-resolver plugin (routes under `sso.*`) that resolves an organization's connection (by email domain or org id) and redirects into the owning plugin._

Steps:
1. ADR-EA-019: section 'SSO dispatch' — Sso plugin (dependsOn [Sessions, Users, Organization]) exposes `POST /auth/sso/start {email|organizationId}` which looks up `organization_oauth_connection` (kinds oidc/oauth2/saml) and returns the redirect produced by OAuth.authorize or Saml.authnRequest; protocol endpoints stay under the `oauth.*`/`saml.*` groups (BEH-EA-004 group naming).
2. spec/models/09-sso.md: replace the open-question sentence at line 65 with a link to ADR-EA-019; bump revision.

Files: `spec/decisions/019-enterprise-federation-packages.md`, `spec/models/09-sso.md`

Tests (write first):
- spec:verify:strict.

Acceptance:
- 09-sso.md no longer lists the dispatch question as open; ADR-EA-019 records the group-naming consequence.

Spec refs: BEH-EA-004, MOD-EA-009, ADR-EA-019 (new) · Effort: **S** · Depends on: AOMS-009 · Workstream: `enterprise-federation-saml-scim`

**Recommended status:** `ready-for-agent`

#### SFS-007 — Spec row lists its gaps but omits canonicalization and signature-wrapping

`info` · `docs` · `—` · [.issues/info/SFS-007-saml-federation-specialist.md](../../.issues/info/SFS-007-saml-federation-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/models/10-saml.md:56` — `grep -ci 'canonicaliz\|wrapping' spec/models/10-saml.md` = 0.
  ```
  No design beyond this row exists yet — there is no `SamlApi` contract, no XML-signing port, no metadata format decision,
  ```

**Fix plan**

_Adopt the ordered SAML validation chain as normative behaviors before implementation (cheap checks before crypto), naming canonicalization and signature wrapping explicitly._

Steps:
1. spec/behaviors/28-saml-sp.md (new, BEH ids allocated at write time): one BEH per ordered step — (1) size cap before parse; (2) structural parse with DTD/entities disabled; (3) exactly one Assertion (cardinality — anti-XSW); (4) signature verified over that same Assertion node via SamlSigner, algorithm allow-list, exclusive C14N; (5) Issuer matches connection; (6) Audience/Recipient/Destination; (7) NotBefore/NotOnOrAfter with bounded skew; (8) InResponseTo matches a stored, single-consume request id (Verification reserve/consume) — replay defense; (9) NameID -> account link via (connectionId, NameID).
2. Source the chain from better-auth/04-oauth-and-federation/05-sso.md:182-253 (cited by the issue) and cite it.
3. spec/models/10-saml.md 'What is missing': add canonicalization and signature-wrapping and link the behaviors file; spec/behaviors/index.yaml; traceability rows -> planned packages/saml tests; features/features/05-authentication-methods/28-saml-sp.feature with @skip @unwired scenarios per step.

Files: `spec/behaviors/28-saml-sp.md (new)`, `spec/behaviors/index.yaml`, `spec/models/10-saml.md`, `spec/traceability.md`, `features/features/05-authentication-methods/28-saml-sp.feature (new)`

Tests (write first):
- spec:verify:strict; the skipped feature is registered by a new 28-saml-sp.steps.test.ts placeholder (pattern: features/features/08-tooling/26-cli.steps.test.ts).

Acceptance:
- An ordered, normative SAML validation chain with BEH ids exists before packages/saml code.

Spec refs: MOD-EA-010, new BEH ids · Effort: **M** · Depends on: SFS-003 · Workstream: `enterprise-federation-saml-scim`

**Recommended status:** `ready-for-agent`

#### SCP-009 — Absence is deliberate and well-governed: Planned-Phase3/P4 with an honest least-designed self-assessment

`info` · `docs` · `—` · [.issues/info/SCP-009-scim-provisioning-specialist.md](../../.issues/info/SCP-009-scim-provisioning-specialist.md) · current status: `needs-triage`

**Verdict:** DUPLICATE (confidence: medium) — duplicate of **CWM-002**

**Evidence at HEAD (ec065a7)**

- `spec/models/12-scim.md:57` — Its ask (convert 'What is missing' into tracked decisions: mapping table, bearer auth, deactivation-vs-delete) is exactly CWM-002's plan under decision 08.
  ```
  This is the least-designed row in the whole matrix. Beyond the one-line mention in `archive/PRD.md` §17 and the landscape evidence in `research/03-auth-landscape.md`, there is no `ScimApi` contract
  ```

**No fix** — Positive/observational finding whose only recommendation is covered by CWM-002 + ADR-EA-019.

**Recommended status:** `resolved`

#### SFS-001 — SAML support is entirely absent; OAuth2/OIDC is the only federation surface

`info` · `architecture` · `—` · [.issues/info/SFS-001-saml-federation-specialist.md](../../.issues/info/SFS-001-saml-federation-specialist.md) · current status: `needs-triage`

**Verdict:** DUPLICATE (confidence: high) — duplicate of **AOMS-009**

**Evidence at HEAD (ec065a7)**

- `spec/models/10-saml.md:24` — Same absence AOMS-009 (high) reports; decision 08 resolves both.
  ```
  | Status | Planned-Phase3 |
  | Priority | P3 |
  ```

**No fix** — Same root cause (no SAML package) as AOMS-009; its recommendation (seed packages/saml from 10-saml.md's sketch) is AOMS-009's code phase.

**Recommended status:** `resolved`

#### SFS-008 — Deferral is explicit, justified, and consistent across roadmap artifacts

`info` · `compliance` · `—` · [.issues/info/SFS-008-saml-federation-specialist.md](../../.issues/info/SFS-008-saml-federation-specialist.md) · current status: `needs-triage`

**Verdict:** DUPLICATE (confidence: medium) — duplicate of **AOMS-009**

**Evidence at HEAD (ec065a7)**

- `spec/roadmap.md:125` — Accurate description of HEAD, but decision 08 has since resequenced SAML/SCIM; the roadmap edit and the 'pull SamlSigner + validation chain forward' recommendation are AOMS-009 step 2 and SFS-003/SFS-007.
  ```
  SSO, SAML, an OIDC provider, SCIM and device authorization are M(3) roadmap items, not v1 scope
  ```

**No fix** — Reports no defect beyond what AOMS-009 (roadmap resequencing) and SFS-003/SFS-007 (port + validation chain spec work) already plan.

**Recommended status:** `resolved`

### Workstream `session-supersede-atomicity`

#### RRS-004 — layerSql issue({supersedes}) is an unwrapped delete-then-insert, the exact pattern ADR-EA-016 rejected

`medium` · `correctness` · `—` · [.issues/medium/RRS-004-refresh-token-rotation-specialist.md](../../.issues/medium/RRS-004-refresh-token-rotation-specialist.md) · current status: `needs-triage`

**Verdict:** PARTIAL (confidence: high) — fixed/partly fixed by `9017a8a (partial: delete -> tombstone)`

**Evidence at HEAD (ec065a7)**

- `packages/core/src/Sessions.ts:671` — Delete became a tombstone UPDATE (RRS-003, commit 9017a8a) — the 'row destroyed' half of the claim is fixed.
  ```
        if (input.supersedes !== undefined) {
          const ancestor = yield* repo
            .tombstone({ id: input.supersedes, supersededBy: id, supersededAt: now })
  ```
- `packages/core/src/Sessions.ts:710` — Still a second, independent statement; layerSql's requirements (line 645) include no SqlTransaction. A crash between them now leaves the old row tombstoned with no successor — the next presentation of the old token is treated as refresh-token *reuse* and revokes the whole family.
  ```
        const row = yield* repo.insert(insert).pipe(Effect.orDie);
  ```
- `spec/decisions/016-verification-sql-claiming.md:48` — ADR still cites the unfixed precedent.
  ```
  matching `Sessions.layerSql`'s own unwrapped `supersedes` precedent
  ```

**Fix plan**

_Wrap the tombstone + insert pair in one transaction via the SqlTransaction port, and update ADR-016's reference._

Steps:
1. packages/core/src/Sessions.ts layerSql: add `SqlTransaction.SqlTransaction` to the Layer requirements (type param at line ~645) and wrap the supersedes tombstone and `repo.insert` in `sqlTransaction.withTransaction(Effect.gen(...))` (only when supersedes is set). Verify composition roots/TestAuth already provide SqlTransaction (packages/sql provides a live layer; ports has layerNoop for memory).
2. Alternatively (if adding a requirement ripples too far) push the pair into a single repository method `SessionsRepository.supersede(tombstoneInput, insertInput)` in packages/sql/src/Repositories.ts that runs both inside `sql.withTransaction` — pick the port route to match ADR-016 rev 1.0's validated mechanism.
3. spec/decisions/016-verification-sql-claiming.md: bump revision; change line 48 to note Sessions' supersedes is now transactional (RRS-004).
4. spec/behaviors/07-sessions.md: add to the rotation behavior (BEH-EA-053) that supersession is atomic.

Files: `packages/core/src/Sessions.ts`, `packages/sql/src/Repositories.ts (if repository route)`, `spec/decisions/016-verification-sql-claiming.md`, `spec/behaviors/07-sessions.md`

Tests (write first):
- First failing test: packages/sql/test/Repositories.test.ts (or packages/core/test/Sessions.test.ts with the SQLite layer) 'issue({supersedes}) rolls back the tombstone when the insert fails' — inject a SessionsRepository whose insert fails, then assert the old token still verifies and no auth.session.reuse is published.

Acceptance:
- No code path can leave a tombstoned session without its successor; ADR-016 no longer cites an unwrapped precedent.

Spec refs: BEH-EA-053, ADR-EA-016 · Effort: **S** · Depends on: none · Workstream: `session-supersede-atomicity`

**Recommended status:** `ready-for-agent`

### Workstream `spec-bdd-traceability-refresh`

#### BDD-003 — features/traceability.md and spec/traceability.md §6 no longer describe the suite

`medium` · `docs` · `—` · [.issues/medium/BDD-003-bdd-gherkin-acceptance-testing-specialist.md](../../.issues/medium/BDD-003-bdd-gherkin-acceptance-testing-specialist.md) · current status: `needs-triage`

**Verdict:** PARTIAL (confidence: high) — partly fixed by `6887fb5`

**Evidence at HEAD (ec065a7)**

- `spec/traceability.md:247` — FIXED by 6887fb5 (AH-001/BDD-001/IDS-010): the 27-admin crosswalk row now exists and §6 says REQ-EA-001..627.
  ```
  | [09-admin-and-impersonation/27-admin-impersonation.feature](../features/features/09-admin-and-impersonation/27-admin-impersonation.feature) | 209–220 | 603–627 |
  ```
- `features/traceability.md:17` — FIXED: count now matches the suite (627 unique @REQ-EA tags in 27 tagged files + untagged _smoke).
  ```
  ... 627 `REQ-EA-NNN` ids allocated across 27 `.feature` files.
  ```
- `features/traceability.md:8` — STILL OPEN: the regenerated manifest kept its 1.0 Document Control header (the audit's explicit ask).
  ```
  > | Revision       | 1.0                                                                                             |
  ...
  > | Change History | 1.0 (2026-09-12): Initial release, generated from `features/features/**/*.feature` (CCR-EA-003) |
  ```
- `spec/traceability.md:8` — STILL OPEN (new): Change History (line 13) has a 1.4 (2026-09-20) row but the Revision/Effective Date fields say 1.3/2026-09-13.
  ```
  > | Revision | 1.3 |
  > | Effective Date | 2026-09-13 |
  ```
- `spec/process/requirement-id-scheme.md:36` — STILL OPEN: allocation range stale (also :47 'through REQ-EA-602', definitions-of-done.md:86, verify-traceability.sh:167/173).
  ```
  | `REQ-EA-NNN` | BDD-testable acceptance requirement | `features/features/**/*.feature` (`Scenario:`/`Scenario Outline:` tags) | 001–602 (allocated) |
  ```

**Fix plan** — The substantive drift (missing 27-admin row, 602 vs 627) was fixed by 6887fb5. Finish the job: bump the manifest's and spec/traceability.md's Document Control, fix every residual '602' range, and make manifest freshness a CI-checked property.

Steps:
1. features/traceability.md: bump Revision 1.0→1.1, Effective Date 2026-09-20, add Change History row '1.1: re-allocated 27-admin-impersonation.feature (REQ-EA-603..627), CCR-EA-005'. Teach features/scripts/allocate-req-ea.py to emit this header from a constant so regeneration never resets it.
2. spec/traceability.md:8-9: set Revision 1.4 / Effective Date 2026-09-20 to match its own Change History row.
3. Replace residual '602' ranges: spec/process/requirement-id-scheme.md:36 and :47, spec/process/definitions-of-done.md:86 (and its 1.2 Change History prose is historical — leave it), spec/scripts/verify-traceability.sh comments :167/:173 → '627' (or better, phrase without a hard count).
4. Add check 4b to spec/scripts/verify-traceability.sh: run `python3 features/scripts/allocate-req-ea.py --check` (add a --check/dry-run mode that recomputes the manifest and diffs it against features/traceability.md, exiting non-zero on drift). Since `pnpm check` runs spec:verify:strict, this puts 'regenerate the manifest when a feature file changes' into CI — the audit's DoD ask.
5. Add the per-change checklist item to spec/process/definitions-of-done.md: 'A new/changed .feature file is followed by `python3 features/scripts/allocate-req-ea.py` and the regenerated manifest is committed.'

Files: `features/traceability.md`, `features/scripts/allocate-req-ea.py`, `spec/traceability.md`, `spec/process/requirement-id-scheme.md`, `spec/process/definitions-of-done.md`, `spec/scripts/verify-traceability.sh`

Tests:
- TDD: implement `allocate-req-ea.py --check` and wire check 4b; prove it fails by temporarily adding an untagged Scenario to a scratch copy (or by editing a manifest row locally), then passes on the committed tree.
- `pnpm run spec:verify:strict` green.

Acceptance:
- features/traceability.md Revision ≥ 1.1 with a Change History row for the 27-admin re-allocation.
- spec/traceability.md Revision field equals the latest Change History row.
- `grep -rn '602' spec/process spec/scripts` returns only historical Change History text.
- Manifest drift fails `pnpm check`.

Spec refs: — · Effort: **S** · Depends on: DTWS-006

**Recommended status:** `ready-for-agent`

#### DTWS-006 — spec/README.md claims the BDD suite has 'no test runner, no step-definition layer' — features/ has both

`medium` · `docs` · `—` · [.issues/medium/DTWS-006-documentation-technical-writing-specialist.md](../../.issues/medium/DTWS-006-documentation-technical-writing-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/README.md:126` — Verbatim at HEAD.
  ```
  it is **not** itself proof that anything holds at runtime: there is still no test runner, no step-definition layer, and no Cucumber configuration (see [`behaviors/25-testing-harness.md`](behaviors/25-testing-harness.md), `BEH-EA-193`–`200`, which remain unimplemented).
  ```
- `features/package.json:8` — Runner exists; root package.json:15 `test:bdd` and `pnpm check` run it in CI.
  ```
  "test": "vitest run",
  ...
  "@effect-cucumber/vitest": "^0.10.1",
  ```
- `features/step-definitions/PasswordSteps.ts:1` — Step layer exists. 28 *.steps.test.ts files; 6 feature files wired (07-sessions, 15-password, 16-oauth, 17-passkey, 27-admin, _smoke), 22 tagged `@skip @unwired` (e.g. features/features/08-tooling/26-cli.steps.test.ts:1-19).
  ```
  features/step-definitions: AdminSteps.ts AdminWorld.ts CsrfTestSupport.ts OAuthSteps.ts OAuthWorld.ts PasskeySteps.ts PasskeyWorld.ts PasswordSteps.ts PasswordWorld.ts SessionSteps.ts SessionWorld.ts SmokeSteps.ts SmokeWorld.ts
  ```
- `spec/traceability.md:215` — Same stale claim duplicated; also features/README.md:5 and definitions-of-done.md:90.
  ```
  **This allocation does not mean the suite runs.** awthaq is still pre-implementation: there is no `package.json`, no Cucumber configuration, and no step-definition layer, so no `.feature` file here currently passes or fails anything
  ```

**Fix plan** — Rewrite every 'no runner / no step layer' claim to describe the real suite: vitest + @effect-cucumber/vitest, features/step-definitions/, 6 wired / 22 `@skip @unwired` feature files, run by `pnpm test:bdd` inside `pnpm check`.

Steps:
1. spec/README.md:126: replace the last sentence with: suite runs via `pnpm test:bdd` (features/vitest.config.ts, @effect-cucumber/vitest, step definitions in features/step-definitions/); 6 feature files are wired (sessions, password, oauth, passkey, admin-impersonation, smoke), the other 22 are registered but `@skip @unwired` (prioritized by .scratch/resolve-ready-for-human-findings/issues/36-bdd-feature-wiring-prioritization.md); a wired scenario passing IS runtime evidence, an unwired one is not.
2. spec/traceability.md:215: same rewrite (bundle with BDD-003's revision bump).
3. features/README.md:5: replace 'This suite is pre-implementation … no package.json, no Cucumber configuration, no step-definition layer' with the same current-state statement.
4. spec/process/definitions-of-done.md:88-91: drop 'there is still no step-definition layer or Cucumber configuration' (bundled with MM-005's revision).
5. Re-check BEH-EA-193..200 status (packages/test/src/TestAuth.ts exists): reword 'which remain unimplemented' to name which of 193-200 packages/test actually implements (do not claim more than TestAuth.ts provides).

Files: `spec/README.md`, `spec/traceability.md`, `features/README.md`, `spec/process/definitions-of-done.md`

Tests:
- Covered by DTWS-001's stale-phrase check — extend its phrase list with 'no step-definition layer' and 'no test runner' so README.md:126, traceability.md:215, features/README.md:5, definitions-of-done.md:90 fail first.

Acceptance:
- `grep -rn 'no step-definition layer\|no test runner' spec/ features/README.md` returns nothing.
- README names the wired vs unwired split with counts that match `grep -L @unwired features/features/**/*.feature`.

Spec refs: BEH-EA-193, BEH-EA-194, BEH-EA-195, BEH-EA-196, BEH-EA-197, BEH-EA-198, BEH-EA-199, BEH-EA-200 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### TMS-009 — spec/invariants.md banner claims 'no line of runtime source exists' while 17 packages ship enforcing code

`low` · `docs` · `—` · [.issues/low/TMS-009-threat-modeling-specialist.md](../../.issues/low/TMS-009-threat-modeling-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high) — canonical for DTWS-007

**Evidence at HEAD (ec065a7)**

- `spec/invariants.md:19` — Verbatim at HEAD (Revision 1.2, 2026-09-13).
  ```
  > **Banner — read before relying on anything below.** awthaq is pre-implementation (see `archive/PRD.md` and `spec/README.md`): no package has been published, no line of runtime source exists. None of the invariants in this document has a real enforcing artifact yet
  ```
- `spec/invariants.md:87` — Same pattern at :97 (Sessions), :107/:117 (Verification), :137 (qadi AuthorizedSubject), :157 (Admin), :167 (OAuth) — all those files EXIST.
  ```
  **Enforcement**: Planned: `packages/core/test/Sessions.test.ts` (no test exists yet).
  ```
- `packages/core/test/Sessions.test.ts:159` — Existing test that already names INV-EA-008.
  ```
      it.effect("BEH-EA-051/INV-EA-008: idle refresh never pushes past the absolute expiry", () =>
  ```
- `packages/client/test/Csrf.test.ts:46` — INV-EA-011 is tested, but under Csrf.test.ts (+ packages/server/test/Csrf.test.ts:59), not the named Csrf.test-d.ts (missing).
  ```
  describe("CsrfClientLive (BEH-EA-170/INV-EA-011)", () => {
  ```
- `packages/sql/src/CoreMigrations.ts:93` — INV-EA-015 code enforcement; packages/oauth/test/OAuth.test.ts:268 'REQ-EA-333: a replayed callback using an already-consumed state fails'.
  ```
            UNIQUE ("providerId", subject, issuer)
  ```

**Fix plan** — Regenerate every INV-EA-007..016 Enforcement cell against the real tree (cite the actual test + BEH id, or state honestly 'no test') and add a verify-traceability check that fails when a cell says '(no test exists yet)' for a file that exists, or names a file that doesn't.

Steps:
1. spec/invariants.md:19 banner + :77/:79 section title/preface: rewrite (coordinated with DTWS-001's banner wording) — type-level invariants enforced by tsc via packages/core/test/AuthPlugin.test.ts @ts-expect-error cases; runtime invariants each cite their enforcing test below.
2. Rewrite each Enforcement cell: INV-EA-007 → packages/core/test/Sessions.test.ts (hashing assertions; grep for hashSecret/BEH-EA-049) + packages/core/src/Sessions.ts hashSecret/constantTimeEqual; INV-EA-008 → Sessions.test.ts:159 'BEH-EA-051/INV-EA-008'; INV-EA-009/010 → packages/core/test/Verification.test.ts:99 'BEH-EA-058/062 … replay is refused' (+ replay-event assertion if present; else say event observability untested); INV-EA-011 → packages/client/test/Csrf.test.ts:46 and packages/server/test/Csrf.test.ts:59 (the named Csrf.test-d.ts does not exist — drop it); INV-EA-012 → packages/qadi/test/AuthorizedSubject.test.ts / Resolvers.test.ts (cite the resolver-failure case); INV-EA-013 → packages/qadi/test/RequirePermission.test.ts does NOT exist — state 'no dedicated test' and point at the enforcing code in packages/qadi/src/AuthorizedSubject.ts; INV-EA-014 → packages/admin/test/Admin.test.ts + ImpersonationRecords.test.ts (Admin IS implemented — remove ''Admin' itself remains unimplemented'); INV-EA-015 → packages/sql/src/CoreMigrations.ts:93 UNIQUE + packages/oauth/test/OAuth.test.ts:268; INV-EA-016 → packages/sql/test/MigrationOwnership.test.ts does NOT exist — keep as genuinely unenforced by test.
3. Rename '## Runtime invariants (planned)' to '## Runtime invariants'. Bump Revision 1.2→1.3 with Change History citing TMS-009/DTWS-007/DTWS-001.
4. Mirror the same cell changes in spec/traceability.md §1/§5 rows that repeat 'Planned — no test exists yet' (e.g. traceability.md:206 Impersonation.test.ts, :207 MigrationOwnership.test.ts) so the two docs agree.
5. Add check 10 to spec/scripts/verify-traceability.sh: for every backticked `packages/**/test/**` path in invariants.md and traceability.md, FAIL if the line says 'no test exists yet' and the file exists, or if the line cites it as enforcing and the file is missing.

Files: `spec/invariants.md`, `spec/traceability.md`, `spec/scripts/verify-traceability.sh`

Tests:
- TDD: add check 10 first; `bash spec/scripts/verify-traceability.sh --strict` must FAIL on invariants.md:87,97,107,117,137,157,167 (existing files marked missing).
- Optional: add explicit `INV-EA-00N` names to the existing test titles that enforce INV-EA-007/009/010/012/015 so the citation is greppable (test-name-only change, no behavior change).

Acceptance:
- `grep -n 'no test exists yet' spec/invariants.md` returns only INV-EA-013/016 lines whose named test genuinely does not exist (or none, if reworded).
- Every cited test path in invariants.md exists on disk; check 10 passes under --strict.

Spec refs: INV-EA-007, INV-EA-008, INV-EA-009, INV-EA-010, INV-EA-011, INV-EA-012, INV-EA-013, INV-EA-014, INV-EA-015, INV-EA-016 · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### DTWS-007 — spec/invariants.md enforcement cells say tests 'do not exist yet' for files that now exist

`low` · `docs` · `—` · [.issues/low/DTWS-007-documentation-technical-writing-specialist.md](../../.issues/low/DTWS-007-documentation-technical-writing-specialist.md) · current status: `needs-triage`

**Verdict:** DUPLICATE (confidence: high) — duplicate of **TMS-009**

**Evidence at HEAD (ec065a7)**

- `spec/invariants.md:87` — Defect real and verbatim at HEAD.
  ```
  **Enforcement**: Planned: `packages/core/test/Sessions.test.ts` (no test exists yet).
  ```
- `packages/core/test/Sessions.test.ts:586` — The file the cell calls missing exists (the audit's line 343 has drifted to 586).
  ```
    it("BEH-EA-055: the session cookie name and attributes are fixed", () => {
  ```

**No separate fix** — closed by the canonical TMS-009 fix plan (same file, same cells, same check).

**Recommended status:** `resolved`

### Workstream `spec-behavior-code-reconcile`

#### NAM-010 — Spec banner and BEH-EA-189 example contradict shipped code — migrators following the spec write non-compiling calls
`medium` · docs · — · [issue](../../.issues/medium/NAM-010-nextauth-authjs-migration-specialist.md)

**Verdict:** CONFIRMED (high confidence). Canonical for BO-008 and IC-006.

**Evidence at HEAD**

`spec/behaviors/24-nextjs-ssr.md:15` — the banner is unchanged (Revision still 1.0):
```
> This file describes planned behavior. No code implementing it exists yet; awthaq is pre-implementation.
```

`spec/behaviors/24-nextjs-ssr.md:99` — the BEH-EA-189 example:
```ts
  return runtime.runPromise(withNextCookies(Users.use((u) => u.rename(String(form.get("name"))))))
```

`packages/next/src/WithNextCookies.ts:110` — the shipped contract:
```ts
export const withNextCookies = (response: Response, jar: CookieJarLike): void => {
  for (const header of response.headers.getSetCookie()) {
    const { name, value, options } = parseSetCookie(header);
    jar.set(name, value, options);
  }
};
```

`spec/behaviors/24-nextjs-ssr.md:20` — the BEH-EA-185 example. Line 120 (BEH-EA-190) has the same call shape.
```ts
const session = await getSession({ headers: await headers() })   // SessionView | undefined, database-verified
```

`packages/next/src/GetSession.ts:135`:
```ts
export const getSession = <Extra = never>(
  headers: HeadersLike,
  runtime: ManagedRuntime.ManagedRuntime<
    Sessions.Sessions | Users.Users | Authentication.PrincipalResolver | Extra,
    never
  >,
): Promise<Session | undefined> => {
```

`features/features/07-client-integration/24-nextjs-ssr.feature:1`: `# awthaq is pre-implementation (see spec/README.md). Every scenario in`

`git log --grep=NAM-010` finds nothing, so no fix has landed.

**Fix plan.** The spec follows the code; the decision is recorded in `.scratch/next-package/spec.md` ("withNextCookies shape and scope") and in the WithNextCookies.ts header.
1. `spec/behaviors/24-nextjs-ssr.md`: bump to Revision 1.1 and add a Change History row citing NAM-010/BO-008/IC-006 (next free CCR-EA id; CCR-EA-005 is the latest at HEAD).
2. Replace the line-15 banner with: "BEH-EA-185, 188, 189 implemented in packages/next (GetSession.ts, HasSessionCookie.ts, WithNextCookies.ts; tests packages/next/test/*.test.ts); remaining behaviors planned." Grep before claiming the status of 186/187/190–192.
3. Change the BEH-EA-185 (line 20) and BEH-EA-190 (line 120) examples to `await getSession(await headers(), runtime)`.
4. Replace the BEH-EA-189 example (lines 96–100) with the Response→jar shape: `withNextCookies(await handler(request), await cookies())`. Add a prose sentence: only `HttpApiBuilder.securitySetCookie` produces Set-Cookie, so wrapping a domain Effect writes nothing. Leave the REQUIREMENT text at lines 104–108 unchanged.
5. Remove the pre-implementation header from `features/features/07-client-integration/24-nextjs-ssr.feature` (coordinate with spec-status-banner-sweep).
- **Files:** `spec/behaviors/24-nextjs-ssr.md`, `features/features/07-client-integration/24-nextjs-ssr.feature`
- **Tests:** doc-only. `pnpm run spec:verify:strict`. The existing `packages/next/test/WithNextCookies.test.ts:51-62` and `GetSession.test.ts:74` already use the shipped shapes the new examples must match.
- **Acceptance:** none of `pre-implementation`, `withNextCookies(Users` or `getSession({` appears in `24-nextjs-ssr.md`; the Change History has a 1.1 row; spec:verify:strict is green.
- **Effort:** S · **Deps:** none · **Spec refs:** BEH-EA-185, 188, 189, 190

**Recommended status:** ready-for-agent

#### AAPS-007 — Spec's BEH-EA-161 illustration resolves u.plan; UserRecord has no plan field
`low` · docs · — · [issue](../../.issues/low/AAPS-007-abac-attribute-policy-specialist.md)

**Verdict:** CONFIRMED (high confidence). Validation also turned up a related code gap: the issue claims the code satisfies the REQUIREMENT, but that is only partly true.

**Evidence at HEAD**

`spec/behaviors/21-qadi-resolvers-obligations.md:26`:
```ts
resolve: (subjectId, attribute) => users.byId(id).pipe(
  Effect.map((u) => attribute === "plan" ? u.plan : undefined),
  Effect.mapError((cause) => new AttributeResolveError({ subjectId, attribute, cause }))
```

`packages/core/src/Users.ts:51` — there is no `plan` field:
```ts
export interface UserRecord {
  readonly id: UserId;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string;
  readonly metadata: Option.Option<string>;
```

`packages/qadi/src/Resolvers.ts:60`: `export const UserAttributeNames = ["email", "emailVerified", "name"] as const;`

`packages/qadi/src/Resolvers.ts:73` — a defect is not mapped:
```ts
return users.findById(userId).pipe(
  Effect.map((user): unknown => { switch (attribute) { … } }),
  Effect.catchTag("UserNotFound", () => Effect.succeed(undefined)),
);
```

`Users.findById` (packages/core/src/Users.ts:306-312) maps `SqlError: Effect.die`. A user-table outage therefore dies instead of becoming `AttributeResolveError`, which is BEH-EA-161's MUST. By contrast, `OrganizationQadi.ts:115-117` does `catchDefect → RelationshipResolveError`.

`spec/behaviors/21-qadi-resolvers-obligations.md:85` is also stale. It says: "**Two plugins both wiring a resolver for the same attribute or relation** is, honestly, an unhandled case today…". In fact `packages/qadi/src/AttributeResolvers.ts` ships `attributeResolverRegistry` and `DuplicateAttributeResolver` (AAPS-002 / ticket 14).

**Fix plan**
1. **Red test:** in `packages/qadi/test/Resolvers.test.ts`, `describe("UserAttributes (BEH-EA-161)")`, add "a Users.findById defect surfaces as AttributeResolveError, never undefined". Use a stub Users service whose `findById` dies.
2. **Code:** in `packages/qadi/src/Resolvers.ts` `UserAttributes.resolve`, add `Effect.catchDefect((cause) => Effect.fail(new AttributeResolveError({ attribute, cause })))`, mirroring OrganizationQadi.ts. Check the real constructor fields in `@qadi/core`. No type assertions.
3. **Spec example:** rewrite the BEH-EA-161 example to the shipped shape: `findById`, a switch over email/emailVerified/name, `UserNotFound → undefined`, `catchDefect → AttributeResolveError`. In the line-41 prose, change "this subject has no plan" to "has no such attribute". Keep the REQUIREMENT unchanged.
4. Add a sentence that a deleted user resolves `undefined`, a legitimate "no opinion" answer.
5. Rewrite the line-85 paragraph around the shipped `attributeResolverRegistry` and each producer's exported name list. Keep the relationship half marked unhandled unless a registry exists (grep first).
6. Bump the revision; share the bump with RZS-007 if the two land together.
- **Files:** `packages/qadi/src/Resolvers.ts`, `packages/qadi/test/Resolvers.test.ts`, `spec/behaviors/21-qadi-resolvers-obligations.md`
- **Tests:** the Resolvers.test.ts case above (red first). Optionally a BDD scenario "A user-table outage surfaces as a resolver failure, not a denial" (INV-EA-012) in `21-qadi-resolvers-obligations.feature`.
- **Acceptance:** no `u.plan` in spec/; the defect maps to `AttributeResolveError`; the line-85 paragraph cites the registry; test, typecheck and spec:verify:strict are green.
- **Effort:** S · **Deps:** none · **Spec refs:** BEH-EA-161, INV-EA-012

**Recommended status:** ready-for-agent

#### BPAS-007 — Docs claim the passkey plugin is pre-implementation while it ships; spec omits implemented behaviors
`low` · docs · — · [issue](../../.issues/low/BPAS-007-biometric-platform-authenticator-specialist.md)

**Verdict:** CONFIRMED (high confidence)

**Evidence at HEAD**

`spec/behaviors/17-passkey.md:15` — the banner is unchanged, and the file ends at BEH-EA-136 with no Conditional Create or UV-policy behavior:
```
> This file describes planned behavior. No code implementing it exists yet; awthaq is pre-implementation.
```

`packages/passkey/src/Passkey.ts:606` — shipped Conditional Create with no spec behavior:
```ts
const registerOptionsConditional: PasskeyShape["registerOptionsConditional"] =
  Effect.fnUntraced(function* (userId, sessionId) {
    yield* requireFreshSession(userId, sessionId);
    if (!config.conditionalCreate) {
      return yield* Effect.fail(new PasskeyApi.PasskeyConditionalCreateDisabled());
    }
```

`packages/passkey/src/Passkey.ts:625` — the code cites a non-existent id:
```ts
// BEH-EA-relaxed: Chrome's Conditional Create flow produces
// UP=0/UV=0 — a `residentKey: "required"` discoverable
authenticatorSelection: { ...config.authenticatorSelection, residentKey: "required", userVerification: "discouraged" },
```

`packages/passkey/src/Passkey.ts:662` — the config-gated UV policy (CB-001) is unspecified:
```ts
let enforceUserVerification =
  consumedOrdinary && config.authenticatorSelection.userVerification === "required";
if (!consumedOrdinary) {
  const consumedConditional = yield* challengeStore.consume(conditionalScope(sessionId), ...
```

`packages/passkey/README.md:3`: `> **This describes a planned package.** awthaq is pre-implementation …; no line of source in this package has shipped yet.`

`features/features/05-authentication-methods/17-passkey.feature:1`: `# awthaq is pre-implementation (see spec/README.md). Every scenario in`

**Fix plan**
1. `17-passkey.md`: bump to Revision 1.1 and add a Change History row. Replace the banner with implementation pointers: Passkey.ts, ChallengeStore.ts, PasskeyApi.ts and `packages/passkey/test/*`.
2. Amend the BEH-EA-130/131 REQUIREMENTs:
   - UV is enforced only when `authenticatorSelection.userVerification === "required"` (WebAuthn §7.1 conveyed policy, CB-001).
   - UP is always required on the ordinary scope.
3. Add new behaviors at the next free ids (BEH-EA-221 at HEAD; re-check at implementation time):
   - **(a) Conditional Create:**
     - config-gated (`PasskeyConditionalCreateDisabled`);
     - requires a fresh session;
     - uses its own challenge scope `passkey.register.conditional:<sessionId>`;
     - forces residentKey=required and UV=discouraged;
     - accepts UP=0/UV=0 **only** for a challenge consumed from that scope.
   - **(b) Registration options require a fresh session** (`requireFreshSession` → `PasskeyReauthRequired`).
   - **(c) webauthnUserId** is 32 random bytes minted per registration ceremony (Passkey.ts:591/615).
4. Update `spec/behaviors/index.yaml`, `spec/traceability.md` §1, and `features/traceability.md` (via `features/scripts/allocate-req-ea.py`).
5. Replace `BEH-EA-relaxed` at Passkey.ts:625 with the new id.
6. Fix the banners in `packages/passkey/README.md` and the 17-passkey.feature header.
7. Add BDD scenarios. `PasskeyWorld.ts:150` already accepts `conditionalCreate`:
   - "Conditional Create accepts a UP=0/UV=0 registration only under its own challenge scope"
   - "Conditional Create is refused when conditionalCreate is disabled"
- **Files:** `spec/behaviors/17-passkey.md`, `spec/behaviors/index.yaml`, `spec/traceability.md`, `features/features/05-authentication-methods/17-passkey.feature`, `features/step-definitions/PasskeyWorld.ts`, `features/traceability.md`, `packages/passkey/src/Passkey.ts`, `packages/passkey/README.md`
- **Tests:** the BDD scenarios above. They are characterization tests: the unit coverage already exists per `spec/traceability.md:183`. Run `pnpm run test:bdd` and `pnpm run spec:verify:strict`.
- **Acceptance:**
  - No banner remains.
  - Conditional Create, UV gating, registration freshness and webauthnUserId generation each have a BEH-EA id.
  - No `BEH-EA-relaxed` comment remains.
  - BDD and spec:verify:strict are green.
- **Effort:** M · **Deps:** none (coordinate id allocation with the CLI workstream) · **Spec refs:** BEH-EA-130, 131, 132, new 221–223

**Recommended status:** ready-for-agent

#### HSK-009 — spec/models/03-passkey-webauthn.md is stale: claims pre-implementation and a two-minute challenge TTL
`low` · docs · — · [issue](../../.issues/low/HSK-009-hardware-security-key-specialist.md)

**Verdict:** CONFIRMED (high confidence)

**Evidence at HEAD**

`spec/models/03-passkey-webauthn.md:67`:
```
"Challenges are single-use verification rows with a two-minute TTL; attestation defaults to `none`" is stated alongside it in the source
```

`packages/passkey/src/ChallengeStore.ts:55`:
```ts
/** BEH-EA-132: five minutes, non-configurable — the one value the behavior itself fixes. */
const TTL = Duration.minutes(5);
```

`spec/models/03-passkey-webauthn.md:70`: `Everything beyond the one-line mention in the plugin tuple: no Passkey class, no WebAuthn port implementation, no passkey_credential table or migration, no challenge/replay handling, …`

`spec/models/03-passkey-webauthn.md:25`: `| Status | Planned-MVP |`. Line 73 says "None yet — no test exists", but `packages/passkey/test/` has 7 test files.

The storage claim is also wrong: challenges live in a dedicated `passkey_challenge` table (ChallengeStore.ts:142), not in "verification rows".

**Fix plan**
1. Bump Revision to 1.1.
2. Rewrite line 67: dedicated `passkey_challenge` store, single-use, fixed five-minute TTL (BEH-EA-132), attestation `none` (BEH-EA-135). Note that the archive's 2-minute figure is superseded.
3. Set Status to the "Implemented" value that AOMS-011 adds to `00-adoption-matrix.md` §1.
4. Replace "What is missing" with the gaps that genuinely remain; verify them before writing.
5. Point Verification at `packages/passkey/test/*` and the BDD feature.
- **Files:** `spec/models/03-passkey-webauthn.md` (and `spec/models/00-adoption-matrix.md` for the status value, if AOMS-011 hasn't landed)
- **Tests:** doc-only; `grep -rn "two-minute" spec` must return nothing; `pnpm run spec:verify:strict`.
- **Acceptance:** "two-minute" is gone; the status is Implemented; "What is missing" no longer denies the shipped code.
- **Effort:** S · **Deps:** AOMS-011 (status vocabulary) · **Spec refs:** BEH-EA-132, 135

**Recommended status:** ready-for-agent

#### RSC-008 — Spec and READMEs still claim pre-implementation while the RSC layer ships
`low` · docs · — · [issue](../../.issues/low/RSC-008-react-server-components-auth-specialist.md)

**Verdict:** CONFIRMED (high confidence). The finding's secondary mention of 24-nextjs-ssr.md is handled under NAM-010.

**Evidence at HEAD**

`spec/behaviors/23-react.md:15`: the standard pre-implementation banner (Revision 1.0).

`packages/react/README.md:3`: `> **This describes a planned package.** … no line of source in this package has shipped yet.` `packages/next/README.md` has since been fixed and no longer carries the banner.

`packages/react/src/index.ts:5`:
```ts
// Implemented: AuthClientAtom.ts (spec/behaviors/22-client-effect.md's
// BEH-EA-169 reactive `AtomHttpApi.Service` alternative; BEH-EA-177/178),
// Subject.ts (BEH-EA-179's `AuthSubject` derivation), Providers.tsx
// (BEH-EA-177/178/179's `RegistryProvider`/`QadiProvider` composition).
```

`spec/behaviors/23-react.md:21`:
```tsx
<RegistryProvider initialValues={[[sessionAtom, AsyncResult.success(initialSession)]]}>
  <Authz decisions={decisions}>{children}</Authz>
```

By contrast, `Providers.tsx:39,99-101` seeds `subjectDtoAtom` from `initialSubject` and has no `decisions` prop.

**Fix plan**
1. `23-react.md`: bump to Revision 1.1. Replace the banner with pointers: BEH-EA-177/178/179 are implemented (AuthClientAtom.ts, Subject.ts, Providers.tsx, test Providers.test.tsx); BEH-EA-180–184 are `@qadi/react` re-exports.
2. Rewrite the BEH-EA-177 example to `<Providers initialSubject={dto} atoms={qadiAtoms}>`. Note that decision hydration belongs to BEH-EA-192.
3. BEH-EA-179: document the two-atom design (`sessionAtom` at AuthClientAtom.ts:71, `subjectDtoAtom` at :97). If the code's single source of truth is `subjectDtoAtom`, change the REQUIREMENT wording from "sessionAtom's current value" to "the subject query atom".
4. Replace the banner in `packages/react/README.md` and add a `"use client"` boundary note for Providers.
5. Remove the 23-react.feature header.
- **Files:** `spec/behaviors/23-react.md`, `packages/react/README.md`, `features/features/07-client-integration/23-react.feature`
- **Tests:** doc-only; `pnpm run spec:verify:strict`; the packages/react tests must stay green.
- **Acceptance:** no banner remains; the BEH-EA-177 example matches Providers' real props.
- **Effort:** S · **Deps:** none · **Spec refs:** BEH-EA-177, 178, 179

**Recommended status:** ready-for-agent

#### RZS-007 — Behavior spec claims pre-implementation while the resolver ships, hiding the spec/code divergence
`low` · docs · — · [issue](../../.issues/low/RZS-007-rebac-zanzibar-specialist.md)

**Verdict:** PARTIAL (high confidence).
- **Still true:** the banner is stale.
- **Already present:** the recommended "deviation note in OrganizationQadi.ts" exists at HEAD.
- **Not this issue's fix:** the REQUIREMENT/code divergence belongs to RZS-001. Decision ticket 13 keeps the spec text and implements the walk (the ResourceOrganizationLookup port), so the spec should not be weakened here.

**Evidence at HEAD**

`spec/behaviors/21-qadi-resolvers-obligations.md:15`: the standard pre-implementation banner.

`packages/organization/src/OrganizationQadi.ts:62`:
```ts
 * organization/team directly — see this module's own header comment for
 * why the richer "arbitrary application resource → organization" walk
 * `spec/models/14-organization.md`'s own worked example shows (via a
 * `Projects.use(...)` call this plugin cannot make) is out of scope
```

`spec/behaviors/21-qadi-resolvers-obligations.md:60`:
```
REQUIREMENT: `Organization.relationships` MUST resolve a `"member"` relation
             by walking from the resource to its owning organization and
             checking membership there;
```

`features/traceability.md:474`: REQ-EA-454 has no status annotation. It becomes accurate once RZS-001 lands. RZS-001 is still `ready-for-agent`, and `git log --grep=RZS-001` finds nothing.

**Fix plan**
1. Sequence this after RZS-001.
2. Replace the banner with per-behavior pointers:
   - BEH-EA-161 → `Resolvers.UserAttributes`
   - BEH-EA-162 → `OrganizationQadi.relationships` plus `ResourceOrganizationLookup`
   - BEH-EA-163 → `@qadi/core relationshipResolverFromEdges`
   - BEH-EA-165 → `Resolvers.reauth`
   - Grep before claiming the status of 164.
3. In BEH-EA-162 prose, name the `ResourceOrganizationLookup` port and its `layerNone` default.
4. RZS-001 itself replaces the "out of scope" sentence in the code.
5. Fallback if RZS-001 slips: add a "Deviation (RZS-001, open)" callout to BEH-EA-162 and mark REQ-EA-454 as pending. Choose one path, not both.
- **Files:** `spec/behaviors/21-qadi-resolvers-obligations.md`, `features/features/06-roles-and-authorization-bridge/21-qadi-resolvers-obligations.feature` (header)
- **Tests:** doc-only; RZS-001 owns the walk tests. `pnpm run spec:verify:strict`.
- **Acceptance:** no banner remains; BEH-EA-162 prose and code agree.
- **Effort:** S · **Deps:** RZS-001 (cross-slice), AAPS-007 (same file, shared revision bump) · **Spec refs:** BEH-EA-161, 162, 163, 165

**Recommended status:** ready-for-agent

#### BO-008 — Behavior spec claims pre-implementation while packages/next ships; BEH-EA-189 snippet contradicts the implemented contract

`low` · `docs` · `—` · [.issues/low/BO-008-balazs-orban.md](../../.issues/low/BO-008-balazs-orban.md) · current status: `needs-triage`

**Verdict:** DUPLICATE (confidence: high) — duplicate of **NAM-010**

**Evidence at HEAD (ec065a7)**

- `spec/behaviors/24-nextjs-ssr.md:15` — Same source line and same two defects (banner + BEH-EA-189 snippet) as NAM-010.
  ```
  > This file describes planned behavior. No code implementing it exists yet; awthaq is pre-implementation.
  ```
- `packages/next/src/WithNextCookies.ts:23` — Code explicitly rejects the spec's call shape.
  ```
  // all, so wrapping one here writes nothing into the jar. (The archive design
  // cookbook's illustrative `withNextCookies(Users.use(...))` snippet is
  // treated as loose, superseded shorthand for "some mutations need cookie
  // bridging" — not a literal contract this module tries to satisfy for
  // arbitrary domain calls.)
  ```

**No fix** — closed by the canonical NAM-010 fix plan.

**Recommended status:** `resolved`

#### IC-006 — Behavior spec header still claims pre-implementation over shipped Next.js code

`info` · `docs` · `—` · [.issues/info/IC-006-iain-collins.md](../../.issues/info/IC-006-iain-collins.md) · current status: `needs-triage`

**Verdict:** DUPLICATE (confidence: high) — duplicate of **NAM-010**

**Evidence at HEAD (ec065a7)**

- `spec/behaviors/24-nextjs-ssr.md:15` — Banner-only subset of NAM-010.
  ```
  > This file describes planned behavior. No code implementing it exists yet; awthaq is pre-implementation.
  ```
- `packages/next/src/index.ts:9` — BEH-EA-185/188/189 are shipped, with packages/next/test/{GetSession,HasSessionCookie,WithNextCookies}.test.ts.
  ```
  export { getSession } from "./GetSession.ts";
  export type { HeadersLike, Session } from "./GetSession.ts";
  export { hasSessionCookie } from "./HasSessionCookie.ts";
  export { withNextCookies } from "./WithNextCookies.ts";
  ```

**No fix** — closed by the canonical NAM-010 fix plan.

**Recommended status:** `resolved`

### Workstream `session-lifecycle-events`

#### ESA-006 — Session lifecycle events are absent from the registry — revocation, the event that must never be silently dropped, is unobservable

`medium` · `architecture` · `—` · [.issues/medium/ESA-006-event-sourcing-audit-trail-specialist.md](../../.issues/medium/ESA-006-event-sourcing-audit-trail-specialist.md) · current status: `needs-triage`

**Verdict:** PARTIAL (confidence: high) — fixed/partly fixed by `45325bb (partial)`

**Evidence at HEAD (ec065a7)**

- `packages/core/src/AuthEvents.ts:90` — FIXED part: session tags now exist (auth.session.issued/revoked/reuse) — commits 45325bb (ALF-004) and 9017a8a (RRS-003).
  ```
  export interface SessionRevokedEvent {
    readonly _tag: "auth.session.revoked";
    readonly userId: UserId;
    readonly reason: "passwordChanged" | "passwordReset";
  }
  ```
- `packages/password/src/Password.ts:766` — OPEN part: only @awthaq/password publishes issued/revoked; `grep -rn '_tag: "auth.session' packages/*/src` shows no publisher in Sessions.issue/revoke, OAuth (OAuth.ts:853 sessions.issue), Passkey, Admin (Admin.ts:288) or sign-out (packages/server/src/Session.ts:87 .revoke).
  ```
            _tag: "auth.session.issued",
  ```
- `spec/behaviors/13-events.md:76` — Spec registry example is stale too.
  ```
  "auth.user.created" | "auth.user.signedIn" | "auth.token.replay" | "auth.session.issued"
  ```

**Fix plan**

_Move session lifecycle publication into the Sessions service itself (both layers) so every issuance/revocation path — OAuth, passkey, admin impersonation, sign-out, revokeAll — emits, with a reason, and drop the plugin-level duplicates in Password._

Steps:
1. packages/core/src/AuthEvents.ts: widen `SessionIssuedEvent` with `familyId` and optional `actingAs`; widen `SessionRevokedEvent` to `{ userId; sessionId?: string; scope: "one" | "others" | "all"; reason: "signOut" | "passwordChanged" | "passwordReset" | "admin" | "reuseDetected" | "superseded" | "userDeleted" }`; add `SessionExpiredEvent` (`auth.session.expired`, published lazily when verify observes idle/absolute expiry).
2. packages/core/src/Sessions.ts: `issue`, `revoke`, `revokeOthers`, `revokeAll` in layerMemory and layerSql publish via the already-injected `events` (layerSql line ~653). Add an optional `reason` to revoke/revokeOthers/revokeAll inputs (default "signOut"/"admin") so callers can label; verify publishes expired.
3. packages/password/src/Password.ts: delete the now-duplicate publishes at 766, 873, 1033, 1139, 1147, passing reasons instead.
4. AuditLog `actorOf` (packages/core/src/AuditLog.ts:74) updated for the widened tags (compiler-forced).
5. spec/behaviors/13-events.md BEH-EA-101: refresh the example registry list to the shipped tags and add a requirement (or note) that session issue/revoke/expiry events are published by Sessions itself; spec/behaviors/07-sessions.md: cross-link.

Files: `packages/core/src/AuthEvents.ts`, `packages/core/src/Sessions.ts`, `packages/core/src/AuditLog.ts`, `packages/password/src/Password.ts`, `packages/server/src/Session.ts`, `spec/behaviors/13-events.md`, `spec/behaviors/07-sessions.md`

Tests (write first):
- First failing test: packages/core/test/Sessions.test.ts 'revoke publishes auth.session.revoked with reason signOut' and 'issue publishes auth.session.issued' for both layerMemory and layerSql (collect AuthEvents.stream).
- packages/oauth/test: 'OAuth callback sign-in emits exactly one auth.session.issued' (guards against double-publish).
- BDD: features/features/02-domain/07-sessions.feature new scenario 'signing out records a session-revoked audit entry'.

Acceptance:
- Every session create/end path emits exactly one typed event and lands in AuditLog.
- Password no longer publishes session events itself.

Spec refs: BEH-EA-101, BEH-EA-100, BEH-EA-053, BEH-EA-054 · Effort: **M** · Depends on: none · Workstream: `session-lifecycle-events`

**Recommended status:** `ready-for-agent`

### Workstream `spec-roadmap-status-reconcile`

#### DTWS-005 — spec/roadmap.md contradicts itself: current-state paragraph says M4+ is implemented, gate-status section says no milestone has begun

`medium` · `docs` · `—` · [.issues/medium/DTWS-005-documentation-technical-writing-specialist.md](../../.issues/medium/DTWS-005-documentation-technical-writing-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/roadmap.md:84` — Verbatim at HEAD (end of line 84).
  ```
  ... As of this revision, **every gate is Not yet active** — there is no code for any gate to check, and no milestone above has begun.
  ```
- `spec/roadmap.md:90` — Lines 90-98: every milestone 'Not yet active'.
  ```
  | M0 Architecture | 1-3 | Not yet active |
  | M1 Core | 4-6 | Not yet active |
  | M2 Password | none directly — certified via M6's gates | Not yet active |
  ```
- `spec/roadmap.md:17` — The contradicting (correct) paragraph from rev 1.2 (commit 0d035d4).
  ```
  Current state: ... `packages/` has a real, tested implementation of every milestone through M4 (Core, Password, the qadi bridge, OAuth and Passkey), plus Organization, Admin, and Jwt ...
  ```

**Fix plan** — Finish the rev-1.2 pass: rewrite roadmap line 84 and the gate table (lines 88-98) to separate 'implementation status' from 'gate status', deriving gate status from MM-005's gate→script mapping.

Steps:
1. spec/roadmap.md:84: replace the last sentence with 'Implementation has progressed through M4 (see Current state); gate activation is tracked separately in definitions-of-done.md's Wired-as column.'
2. Gate table lines 88-98: split into two columns — 'Implementation' (M0-M4 Implemented; M5 Client/React implemented (packages/client, react, next); M6 Tooling partial (packages/test yes, cli placeholder); M7 partial (Jwt/Organization/Admin yes; api-key/magic-link/two-factor placeholders); M8 not started) and 'Gates' (M0 gates 1-2 Active, 3 Not wired; M1 gates 4 Active, 5/6 Active-partial; M6 gate 9 Active, 7/8/10 Not wired; M8 gate 11 Active, 12 Active-no-op, 13/14 Not wired) — values copied from MM-005's table so both docs agree.
3. Bump Revision 1.2→1.3 with Change History row (DTWS-005, CCR id).

Files: `spec/roadmap.md`

Tests:
- DTWS-001's stale-phrase check: add 'no milestone above has begun' / 'there is no code for any gate to check' to its phrase list so roadmap.md:84 fails first.

Acceptance:
- roadmap.md makes no statement that no milestone has begun or that no code exists.
- Gate statuses in roadmap.md and definitions-of-done.md are identical.

Spec refs: — · Effort: **S** · Depends on: MM-005

**Recommended status:** `ready-for-agent`

#### MM-005 — definitions-of-done ground-truth claims drifted: 'no pnpm check, no check.yml' is now false

`low` · `docs` · `—` · [.issues/low/MM-005-mattia-manzati.md](../../.issues/low/MM-005-mattia-manzati.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/process/definitions-of-done.md:95` — Verbatim at HEAD.
  ```
  This table is not itself wired to anything: there is no `pnpm check`, no
  `.github/workflows/check.yml`, and no script that verifies this table matches
  a real command chain, because none of those exist to drift from yet.
  ```
- `spec/process/definitions-of-done.md:19` — Also stale (line 81 repeats 'there is no CI, no package.json').
  ```
  This document is **forward-looking**. No package, build, or CI exists yet in
  this repository: there is no `package.json`, no lockfile, no git history, and
  no workflow file.
  ```
- `spec/process/definitions-of-done.md:32` — Every gate's Active? cell says 'Not yet'.
  ```
  | 1 | Typecheck (`tsc`) | Sources compile | Not yet — planned for M0 |
  | 2 | Lint (`oxlint` or equivalent) | Style and correctness lint is clean | Not yet — planned for M0 |
  ```
- `.github/workflows/check.yml:51` — CI exists; package.json:27 chains typecheck, package:smoke, lint, knip, format:check, circular, coverage, test:bdd, spec:verify:strict.
  ```
        - run: pnpm check
  ```

**Fix plan** — Add a 'Wired as' column mapping each of the 14 gates to the exact `pnpm check` step (or 'not wired'), flip Active? cells to the truth, and delete the 'nothing exists' prose; add a spec:verify check that every gate marked Active names a script present in package.json.

Steps:
1. Rewrite spec/process/definitions-of-done.md:19-26 intro and :76-91/:93-103 notes to describe the real state (package.json, pnpm-lock.yaml, .github/workflows/check.yml running `pnpm check`, release.yml).
2. Gate table (:30-45): add column 'Wired as'. Mapping at HEAD: 1 Typecheck → `pnpm typecheck` (Active); 2 Lint → `pnpm lint` (oxlint, Active); 3 House-style → not wired (knip + format:check are adjacent but not house-style — list them as extra, un-numbered gates or add rows 15/16); 4 Circular → `pnpm circular` (scripts/circular.mjs, madge; Active); 5 Type-level compile-error tests → partially: `@ts-expect-error` cases in packages/core/test/AuthPlugin.test.ts compiled by `tsc -p tsconfig.test.json` inside `pnpm typecheck` (Active-partial, no tstyche); 6 Unit/integration + coverage threshold → `pnpm coverage` runs tests, but vitest.config.ts has no thresholds (Active-partial: threshold not enforced); 7 Plugin contract harness → not wired; 8 Doc-example compilation → not wired; 9 Traceability → `pnpm spec:verify:strict` (Active); 10 API-surface-vs-source → not wired (see spec-surface-inventory-reconcile); 11 Packed-tarball → `pnpm package:smoke` (npm pack --dry-run + publint + attw; Active); 12 Changesets/provenance → .github/workflows/release.yml (changesets/action, id-token: write) — Active but no-op while packages are private; 13 Security checklist → not wired; 14 Consumer app → not wired. Also record `pnpm test:bdd` (acceptance suite) as its own gate row.
3. Bump Revision 1.2→1.3 with Change History (MM-005, CCR id).
4. Add check 11 to spec/scripts/verify-traceability.sh: parse the gate table; every row whose Active? is 'Active' must name a backticked `pnpm <script>` that exists in root package.json and appears in the `check` script chain.

Files: `spec/process/definitions-of-done.md`, `spec/scripts/verify-traceability.sh`

Tests:
- TDD: write check 11 first; it must fail on the current table (no gate names a script) and pass after the rewrite.

Acceptance:
- No 'no pnpm check / no check.yml / no package.json' claim remains in definitions-of-done.md.
- Each of the 14 gates shows Active / Active-partial / Not wired with the exact command; check 11 passes.

Spec refs: — · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

### Workstream `spec-surface-inventory-reconcile`

#### AVS-008 — ADR-EA-003's endpoint inventory already stale against shipped contract code

`medium` · `docs` · `—` · [.issues/medium/AVS-008-api-design-versioning-specialist.md](../../.issues/medium/AVS-008-api-design-versioning-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/decisions/003-httpapi-as-contract.md:25` — Verbatim at HEAD; Revision still 1.0.
  ```
  core owns the root groups (`session`: current, list, signOut, revoke, revokeOthers, per PRD §10)
  ```
- `spec/decisions/003-httpapi-as-contract.md:9` — Also index.yaml:16; and line 39 'Not yet implemented — see spec/roadmap.md for milestone.'
  ```
  > | Status | Accepted — design; implementation deferred |
  ```
- `packages/api/src/Session.ts:58` — Endpoint missing from the ADR.
  ```
    .add(HttpApiEndpoint.post("revokeAll", "/session/revoke-all"))
  ```
- `packages/api/src/Account.ts:27` — Whole group missing; composed into core at packages/api/src/AuthCore.ts:16 `HttpApi.make("auth").add(SessionGroup).add(AccountGroup)`.
  ```
  export const AccountGroup = HttpApiGroup.make("account")
    .add(
      HttpApiEndpoint.patch("updateProfile", "/user", {
  ...
    .add(HttpApiEndpoint.delete("deleteUser", "/user"))
  ```
- `packages/api/src/Subject.ts:54` — Contract lives in @awthaq/api but is composed by @awthaq/qadi (packages/qadi/src/SubjectApi.ts:48 `HttpApi.make("auth-subject")`) — so it is NOT a core root group; the ADR should say who owns it.
  ```
  export const SubjectGroup = HttpApiGroup.make("subject").add(
    HttpApiEndpoint.get("current", "/subject", { success: SubjectDto }),
  ```
- `spec/decisions/index.yaml:16` — All 16 ADRs carry this status and 15 carry the 'Not yet implemented' footer (001-015).
  ```
      status: "Accepted — design; implementation deferred"
  ```

**Fix plan** — Revise ADR-EA-003 to 1.1 with the shipped core inventory (session incl. revokeAll; account: updateProfile, deleteUser; subject owned by @awthaq/qadi), flip status to implemented across all ADRs whose decision has shipped, and mechanize DoD gate 10 so contract inventory drift fails CI.

Steps:
1. spec/decisions/003-httpapi-as-contract.md:25: replace the parenthetical with: core (`@awthaq/api` AuthCoreApi, packages/api/src/AuthCore.ts) owns `session` (current, list, signOut, revoke, revokeOthers, revokeAll) and `account` (updateProfile, deleteUser); `subject` (current) is declared in @awthaq/api/Subject.ts but composed by the qadi bridge (packages/qadi/src/SubjectApi.ts). Point to packages/api/src/AuthCore.ts as the canonical, living inventory rather than re-listing per-plugin groups.
2. Remove the 'Not yet implemented' footer (line 39), set Status to 'Accepted — implemented', bump Revision 1.0→1.1, Change History row (AVS-008, CCR id).
3. spec/decisions/index.yaml: update ADR-EA-003's status; audit the other 15 ADRs in the same pass — each whose decision is visible in code (001 layers, 002 plugin graph, 004 db-neutral models, 005 static composition, 006 runtime config, 007 Effect v4, 008 Context.Service class, 009 qadi, 010 ports, 011 config service, 012 slots/registries, 013 error taxonomy, 014 session storage, 015 qadi path selection, 016 verification claiming) → 'Accepted — implemented' + drop footer; any still unimplemented stays 'deferred'. Verify each against packages/ before flipping.
4. Add the standing rule to spec/process/definitions-of-done.md per-change checklist: 'Adding/removing an HttpApiGroup or endpoint in packages/api or a plugin's *Api.ts touches the owning ADR/behavior inventory in the same change.'
5. Mechanize DoD gate 10 (API-surface-vs-source): add spec/scripts/check-surface.mjs (run from verify-traceability.sh) that imports built `@awthaq/api` AuthCoreApi, walks its groups/endpoints (HttpApi reflection — confirm the v4 API in ../effect/packages/effect/src/unstable/httpapi/HttpApi.ts, e.g. `HttpApi.reflect`), and diffs the names against a machine-readable block in ADR-EA-003 (or behaviors/04-contract-stratum.md). Shares its export-walk with DTWS-008's ports check.

Files: `spec/decisions/003-httpapi-as-contract.md`, `spec/decisions/index.yaml`, `spec/decisions/0*.md`, `spec/process/definitions-of-done.md`, `spec/scripts/verify-traceability.sh`, `spec/scripts/check-surface.mjs (new)`

Tests:
- TDD: write check-surface.mjs first against the current ADR text — it must FAIL reporting missing `session.revokeAll`, `account.updateProfile`, `account.deleteUser`; passes after the ADR revision.
- `pnpm run spec:verify:strict` green.

Acceptance:
- ADR-EA-003 lists every endpoint in AuthCoreApi and names subject's owner.
- index.yaml has no 'implementation deferred' status for an ADR whose decision is implemented.
- Adding an endpoint to SessionGroup without touching the ADR fails `pnpm check`.

Spec refs: ADR-EA-003, BEH-EA-025 · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### DTWS-008 — spec/overview.md's ports-stratum surface was never reconciled with the shipped @awthaq/ports exports

`low` · `docs` · `—` · [.issues/low/DTWS-008-documentation-technical-writing-specialist.md](../../.issues/low/DTWS-008-documentation-technical-writing-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/overview.md:47` — Verbatim at HEAD; also wrong about variants (PasswordHasher has layerArgon2id/layerScrypt, WebAuthn layerSimpleWebAuthn).
  ```
  | 2 Ports | `@awthaq/ports` | `PasswordHasher`, `Mailer`, `WebAuthn`, each with `layer`, `layerNoop`, `layerMemory` variants. |
  ```
- `spec/overview.md:92` — The Ports surface table lists 3 of 9 modules; 'Context.Tag' is also wrong (code uses Context.Service / Context.Reference).
  ```
  | Export | Kind | Source |
  |---|---|---|
  | `PasswordHasher` (`layerArgon2id`, `layerScrypt`) | `Context.Tag` + Layers | `PasswordHasher.ts` |
  | `Mailer` (`layerNoop`, `layerMemory`) | `Context.Tag` + Layers | `Mailer.ts` |
  | `WebAuthn` (`layerSimpleWebAuthn`) | `Context.Tag` + Layers | `WebAuthn.ts` |
  ```
- `packages/ports/src/index.ts:1` — Nine modules shipped (plus WebAuthn); the audit named 4 missing, HEAD has 6 missing (ClientAddress, LegacySessionBridge also added since).
  ```
  export * as ClientAddress from "./ClientAddress.ts";
  export * as Encryption from "./Encryption.ts";
  export * as KeyProvider from "./KeyProvider.ts";
  export * as LegacySessionBridge from "./LegacySessionBridge.ts";
  export * as Mailer from "./Mailer.ts";
  export * as PasswordHasher from "./PasswordHasher.ts";
  export * as RateLimiter from "./RateLimiter.ts";
  export * as SqlTransaction from "./SqlTransaction.ts";
  ```
- `spec/overview.md:130` — The overview's own worked example already uses a port its surface table omits.
  ```
    Layer.provide(RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))),
  ```

**Fix plan** — Reconcile overview.md's Ports row (line 47) and Ports stratum surface table (lines 90-96) with the nine shipped modules and their real layer constructors; fix 'Context.Tag' → 'Context.Service'/'Context.Reference'; reuse AVS-008's surface script to keep it honest.

Steps:
1. spec/overview.md:47: list PasswordHasher, Mailer, WebAuthn, Encryption, KeyProvider, RateLimiter, SqlTransaction, ClientAddress, LegacySessionBridge; drop the incorrect 'each with layer/layerNoop/layerMemory' clause.
2. spec/overview.md:92-96: one row per module with its actual exported layers: PasswordHasher (layerArgon2id, layerScrypt), Mailer (layerNoop, layerMemory), WebAuthn (layerSimpleWebAuthn), Encryption (layer; requires KeyProvider|Crypto), KeyProvider (layerEnv), RateLimiter (layer, layerStoreMemory, layerPermissive), SqlTransaction (layerNoop, layerSql), ClientAddress (layerDirect, layerTrustedProxy(config)), LegacySessionBridge (Context.Reference with default). Kind column: `Context.Service` (LegacySessionBridge: `Context.Reference`).
3. While there, reconcile line 55's plugin list with packages/ (add migrate-auth0, migrate-better-auth import packages; mark api-key, magic-link, two-factor, cli as placeholders) and sweep the other surface tables (§ Composition/Plugin contract/Contract/Domain/Qadi bridge) for the same drift.
4. Rename '## Planned public API surface' (line 57) / its line-59 disclaimer to reflect shipped status (coordinated with DTWS-001's overview banner rewrite; same revision bump 1.1→1.2).
5. Extend AVS-008's spec/scripts/check-surface.mjs to compare the `export * as X` names of packages/ports/src/index.ts to the Ports table's Export column.

Files: `spec/overview.md`, `spec/scripts/check-surface.mjs`

Tests:
- TDD: the ports half of check-surface.mjs fails listing Encryption, KeyProvider, RateLimiter, SqlTransaction, ClientAddress, LegacySessionBridge before the table edit.

Acceptance:
- overview.md Ports tables name all nine @awthaq/ports modules with their real layer constructors and kinds.
- check-surface passes in `pnpm check`.

Spec refs: — · Effort: **S** · Depends on: DTWS-001, AVS-008

**Recommended status:** `ready-for-agent`

### Workstream `jwt-key-rotation-runbook`

#### KRS-008 — No rotation runbook in spec/decisions and the model doc contradicts the shipped implementation
`medium` · docs · — · [issue](../../.issues/medium/KRS-008-key-rotation-specialist.md)

**Verdict:** CONFIRMED (high confidence). Canonical for MAPS-009 and VB-007.

**Evidence at HEAD**

`spec/models/08-jwt-bearer.md:80`:
```
Everything: no `Jwt` or `Bearer` plugin class exists, no `JwtApi`/`BearerApi` contract, no signer, no JWKS endpoint, no key-rotation implementation, no test.
```

`packages/jwt/src/JwtConfig.ts:47`:
```ts
keyRotationInterval: options.keyRotationInterval ?? Duration.days(90),
keyGracePeriod: options.keyGracePeriod ?? Duration.days(30),
```

`packages/jwt/src/KeyRing.ts:217`. The only design record for this is `.scratch/jwt/issues/11-key-rotation.md`; `spec/decisions/` 001–016 has none on rotation.
```ts
 * .scratch/jwt/issues/11-key-rotation.md: forces an immediate rotation,
 * independent of `keyRotationInterval` — e.g. suspected key compromise.
```

`packages/jwt/src/KeyRing.ts:223` — the "compromise" path keeps the old key verifying for the full grace period:
```ts
export const rotateNow = Effect.gen(function* () {
  …
  if (Option.isSome(existing)) {
    yield* markRotated(existing.value, now, config.keyGracePeriod);
  }
  yield* mint(config.algorithm);
```

**Fix plan**
1. **Red test:** in `packages/jwt/test/KeyRing.test.ts`, add "rotateNow with gracePeriod: Duration.zero drops the old kid from verifiable and JWKS immediately".
2. **Code:** make `rotateNow` accept `options?: { gracePeriod?: Duration }`, defaulting to `config.keyGracePeriod`, and thread it into `markRotated`. Keep the default call behaving as today and update the callers. No type assertions, no return-type annotation.
3. **Optional:** `JwtConfig` fails construction when `keyGracePeriod < ttl`, with test "JwtConfig rejects a keyGracePeriod shorter than ttl". This follows the flexibility-over-complexity preference: a validated config error rather than a silent footgun.
4. **ADR:** add `spec/decisions/017-jwt-signing-key-rotation.md` (ADR-EA-017) and its entries in `spec/decisions/index.yaml` and the `spec/traceability.md` decisions table. Contents:
   - **Routine rotation:** 90-day interval, 30-day grace.
   - **Sizing rule:** grace ≥ max token ttl, including the `mint`/`signJWT` ttl override.
   - **Emergency rotation:** `rotateNow({ gracePeriod: Duration.zero })`, which invalidates all outstanding tokens.
   - **Consequences, referencing:** KRS-006 (other processes only notice on refresh), KRS-009 (non-atomic rotate), KRS-010 (lite-verifier JWKS cache).
   - **Operator runbook:** routine, emergency, and verifying via JWKS kids.
5. **Model 08 rewrite:**
   - Status: Implemented for Jwt, Planned for Bearer.
   - Document the shipped surface: sign, verify, verifyLive, signJWT, verifyJWT, jwks, mint, and the JwtConfig fields.
   - Document the deliberate `dependsOn: []` (Jwt.ts:24-33), versus the sketch's `dependsOn: [Sessions]` at lines 52/68.
   - Document the lite-verifier revocation limitation.
   - "What is missing" lists the Bearer half, `typ` validation (JJS-008) and audience separation (VB-005).
   - Point Verification at `packages/jwt/test/*` and link ADR-EA-017.
6. Replace the banner in `packages/jwt/README.md`.
- **Files:** `packages/jwt/src/KeyRing.ts`, `packages/jwt/src/JwtConfig.ts`, `packages/jwt/test/KeyRing.test.ts`, `spec/decisions/017-jwt-signing-key-rotation.md`, `spec/decisions/index.yaml`, `spec/traceability.md`, `spec/models/08-jwt-bearer.md`, `packages/jwt/README.md`
- **Tests:** the KeyRing emergency-rotation test (red first); the JwtConfig validation test; `pnpm run spec:verify:strict`.
- **Acceptance:**
  - ADR-EA-017 exists and is indexed.
  - Emergency rotation retires the old key immediately.
  - Model 08 describes the shipped plugin plus its open gaps.
  - `pnpm check` passes.
- **Effort:** M · **Deps:** none blocking (related, cross-slice: KRS-006, KRS-009, KRS-010, JJS-008, VB-005) · **Spec refs:** ADR-EA-017 (new)

**Recommended status:** ready-for-agent

---

#### MAPS-009 — spec/models/08-jwt-bearer.md describes the shipped Jwt plugin as nonexistent

`medium` · `docs` · `—` · [.issues/medium/MAPS-009-microservices-auth-propagation-specialist.md](../../.issues/medium/MAPS-009-microservices-auth-propagation-specialist.md) · current status: `needs-triage`

**Verdict:** DUPLICATE (confidence: high) — duplicate of **KRS-008**

**Evidence at HEAD (ec065a7)**

- `spec/models/08-jwt-bearer.md:80` — Same source line as KRS-008; the model-08 rewrite is step 5 of KRS-008's plan.
  ```
  Everything: no `Jwt` or `Bearer` plugin class exists, no `JwtApi`/`BearerApi` contract, no signer, no JWKS endpoint, no key-rotation implementation, no test.
  ```
- `spec/models/08-jwt-bearer.md:52` — Sketch dependency the code deliberately inverts.
  ```
      dependsOn: [Sessions],
  ```
- `packages/jwt/src/Jwt.ts:27` — MAPS-009's distinct point (dependsOn: [] divergence) is folded into KRS-008's model rewrite.
  ```
  // dependency of installing `Jwt` at all (`dependsOn: []`; ordinary
  // sign/verify/jwks work with zero other plugins installed).
  ```

**No fix** — closed by the canonical KRS-008 fix plan.

**Recommended status:** `resolved`

#### VB-007 — JWT bearer spec claims the plugin does not exist; docs lag the code

`low` · `docs` · `—` · [.issues/low/VB-007-vittorio-bertocci.md](../../.issues/low/VB-007-vittorio-bertocci.md) · current status: `needs-triage`

**Verdict:** DUPLICATE (confidence: high) — duplicate of **KRS-008**

**Evidence at HEAD (ec065a7)**

- `spec/models/08-jwt-bearer.md:80` — Same source line as KRS-008.
  ```
  Everything: no `Jwt` or `Bearer` plugin class exists, ...
  ```
- `packages/jwt/src/JwtCodec.ts:136` — typ is minted; verify path (JwtCodec.ts:225-243) checks alg/kid/signature/iss/aud/exp but never typ — the code gap VB-007 mentions is owned by JJS-008 (cross-slice), and is listed as an open item in KRS-008's model rewrite.
  ```
  const header = { alg: params.alg, kid: params.kid, typ: "JWT" };
  ```

**No fix** — closed by the canonical KRS-008 fix plan.

**Recommended status:** `resolved`

### Workstream `mfa-two-factor-hardening`

#### BCR-006 — Shared per-account lockout counter for code brute-force is undecided and unowned

`medium` · `security` · `—` · [.issues/medium/BCR-006-backup-codes-recovery-specialist.md](../../.issues/medium/BCR-006-backup-codes-recovery-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/models/06-two-factor-totp.md:104` — Undecided in spec; decision ticket 05 set only a per-challenge limit (3 attempts / 10 s per challengeId) and did not address a cross-factor per-account counter.
  ```
  (better-auth's 10-minute default is cited, not adopted), whether failed
  attempts across TOTP/OTP/recovery-code share one per-account counter, and
  ```

**Fix plan**

_Add to ADR-EA-020 a shared per-account second-factor failure budget through the RateLimiter port (research/07 Q58 recommendation 3), layered on top of ticket 05's per-challenge limit._

Steps:
1. ADR-EA-020 Decision 3: key `2fa-fail:<userId>` in the RateLimiter port, consumed on every failed TOTP, email-OTP or recovery-code verification (any challenge), 5 failures per 15 minutes -> typed `SecondFactorLocked` (429 via ADR-EA-013's httpApiStatus) with Retry-After; success does not reset the window (prevents interleaving attacks) — document the choice; per-challengeId 3/10 s limit from ticket 05 retained; lockout publishes `auth.twoFactor.locked` (audited).
2. spec/models/06-two-factor-totp.md: move the counter question from undecided to decided (link ADR).

Files: `spec/decisions/020-two-factor-state.md (new)`, `spec/models/06-two-factor-totp.md`

Tests (write first):
- Code phase: packages/two-factor/test/TwoFactor.test.ts 'five failures across TOTP and recovery codes lock the account's second factor for the window even across fresh challenges'.

Acceptance:
- The cross-factor counter, threshold, window and error are decided and documented.

Spec refs: ADR-EA-020 (new), BEH-EA-105, ADR-EA-013 · Effort: **S** · Depends on: THS-004 · Workstream: `mfa-two-factor-hardening`

Note / recommendation: Adopt research/07's shared per-account counter (richer, safer) rather than per-challenge limiting alone; not re-litigating ticket 05, which is silent on it.

**Recommended status:** `ready-for-agent`

#### SOS-006 — SIM-swap / NIST restricted-authenticator policy exists only in research; zero ADRs, decision explicitly undecided in spec

`medium` · `compliance` · `—` · [.issues/medium/SOS-006-sms-otp-specialist.md](../../.issues/medium/SOS-006-sms-otp-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/models/06-two-factor-totp.md:106` — No SMS/OTP ADR in spec/decisions (001-016). Decision ticket 05 §3 decided the posture (substrate now, SMS later as a separate degraded plugin) but it is not in spec.
  ```
  whether SMS OTP ships as a separate, explicitly "restricted" plugin per NIST
  800-63B-4 guidance. None of this has been decided beyond the row in
  `archive/PRD.md` §17.
  ```

**Fix plan**

_Codify decision ticket 05 §3 as ADR-EA-021: SMS OTP is a separate, explicitly restricted plugin over the EmailOtp channel substrate, never an account's sole factor, emitting a `factor.sms.used` audit event, with a SIM-swap risk-indicator hook as a documented extension point._

Steps:
1. spec/decisions/021-sms-otp-restricted-plugin.md (new ADR-EA-021; next free number): Context (NIST SP 800-63B-4 §3.1.3.3 per research/07-passwords-2fa.md:132/:142), Decision (separate `@awthaq/sms-otp` plugin, deferred; channel substrate = EmailOtp's; installable only alongside a non-restricted factor — enforced at enroll time: cannot be the only confirmed factor; operator must acknowledge restricted status via config `acknowledgeRestricted: true` or the Layer fails to build with a typed error; publishes `auth.factor.smsUsed`; `SimSwapRiskCheck` optional port consulted before send — a documented extension point, no implementation shipped), Consequences.
2. spec/models/06-two-factor-totp.md + 05-email-otp.md: link ADR-EA-021, remove SMS from undecided list; spec/models/00-adoption-matrix.md: if an SMS row exists, mark it 'Deferred — restricted (ADR-EA-021)'.

Files: `spec/decisions/021-sms-otp-restricted-plugin.md (new)`, `spec/decisions/index.yaml`, `spec/models/06-two-factor-totp.md`, `spec/models/05-email-otp.md`, `spec/models/00-adoption-matrix.md`

Tests (write first):
- spec:verify:strict (ADR traced).

Acceptance:
- An ADR fixes SMS OTP's restricted posture; the model doc no longer says undecided.

Spec refs: ADR-EA-021 (new), MOD-EA-005, MOD-EA-006 · Effort: **S** · Depends on: none · Workstream: `mfa-two-factor-hardening`

Note / recommendation: Decision 05 flags 'ship SMS at all?' as a maintainer scope call; the ADR records the recommended posture and keeps the plugin deferred.

**Recommended status:** `ready-for-agent`

#### THS-004 — TOTP secret encryption-at-rest left undecided despite a proven Encryption port

`medium` · `security` · `—` · [.issues/medium/THS-004-totp-hotp-mfa-specialist.md](../../.issues/medium/THS-004-totp-hotp-mfa-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/models/06-two-factor-totp.md:103` — Still listed as undecided in spec.
  ```
  Q58 include: TOTP secret encryption at rest, the exact challenge-cookie TTL
  ```
- `packages/ports/src/Encryption.ts:46` — The port exists (commit b2fb622) — decision ticket 05 asked for a new 'SecretBox' port believing none existed; the existing Encryption port satisfies that decision's intent (AEAD, Layer-configured key).
  ```
  const ALGORITHM = "AES-GCM";
  const IV_LENGTH = 12;
  ```

**Fix plan**

_Record in a new ADR (with THS-007/BCR-006) that TOTP secrets are stored only as Encryption-port envelopes with AAD bound to the user, reusing packages/ports/src/Encryption.ts instead of the SecretBox port ticket 05 proposed (same intent, already shipped)._

Steps:
1. spec/decisions/020-two-factor-state.md (new ADR-EA-020; next free number): Decision 1 — `two_factor_secret.secret` holds an Encryption envelope (AES-256-GCM, kid-tagged) with AAD `two-factor:<userId>`; plaintext column forbidden; migration creates the encrypted column from day one; KeyProvider rotation re-encrypts lazily on verify. Alternatives: plaintext (rejected), a new SecretBox port (superseded — Encryption already exists).
2. spec/models/06-two-factor-totp.md: remove 'TOTP secret encryption at rest' from the undecided list and link ADR-EA-020; bump revision.
3. Code phase (two-factor build, cross-slice THS-001): packages/two-factor two_factor_secret model uses the same transparent-encryption pattern as AccountsRepository (packages/sql/src/Repositories.ts:147-151).

Files: `spec/decisions/020-two-factor-state.md (new)`, `spec/decisions/index.yaml`, `spec/models/06-two-factor-totp.md`

Tests (write first):
- Code phase first failing test: packages/two-factor/test/TwoFactor.test.ts 'the stored secret column is an Encryption envelope and does not contain the base32 secret'; 'an envelope moved to another userId fails AAD verification'.

Acceptance:
- ADR-EA-020 exists; 06-two-factor-totp.md lists encryption-at-rest as decided.

Spec refs: ADR-EA-020 (new), MOD-EA-006 · Effort: **S** · Depends on: none · Workstream: `mfa-two-factor-hardening`

**Recommended status:** `ready-for-agent`

#### BCR-010 — No BDD or behavior-spec coverage for backup codes despite the suite's own hook for it

`low` · `testing` · `—` · [.issues/low/BCR-010-backup-codes-recovery-specialist.md](../../.issues/low/BCR-010-backup-codes-recovery-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/models/06-two-factor-totp.md:112` — True at HEAD; the two-factor plugin itself is still a placeholder (packages/two-factor/src/index.ts:8), so coverage must land with the build (decision ticket 05).
  ```
  None yet — no test exists.
  ```

**Fix plan**

_Write the two-factor behaviors + feature (including recovery codes) as the first artifact of the TwoFactor build decided in ticket 05, mirroring BEH-EA-057/058's reset-token scenarios._

Steps:
1. spec/behaviors/31-two-factor.md (new, next free BEH ids): TOTP enable/confirm/verify, recovery codes (10 x 10 chars, hashed via PasswordHasher, single-use), challenge via Verification (ADR-EA-020), BeforeSessionIssue divert, BeforeCredentialReset veto (ticket 05 Fix B), per-account attempt counter (BCR-006).
2. features/features/05-authentication-methods/31-two-factor.feature: 'a recovery code consumes exactly once under concurrency', 'regenerating codes keeps the old set valid until the new set persists', 'a consumed code never both succeeds and replays silently (auth.token.replay published)', 'sign-in with 2FA enabled diverts with TwoFactorRequired and mints no session', 'password reset for a 2FA account requires a second factor'.
3. Traceability rows; spec/models/06-two-factor-totp.md 'Verification' section links the feature.

Files: `spec/behaviors/31-two-factor.md (new)`, `features/features/05-authentication-methods/31-two-factor.feature (new)`, `features/traceability.md`, `spec/traceability.md`, `spec/models/06-two-factor-totp.md`

Tests (write first):
- Scenarios authored before the plugin code (red), wired as the plugin lands (green).

Acceptance:
- Two-factor ships with a behaviors file and wired recovery-code concurrency scenarios.

Spec refs: BEH-EA-057, BEH-EA-058, BEH-EA-059 · Effort: **M** · Depends on: THS-004, THS-007, BCR-006, THS-001 (cross-slice: two-factor build) · Workstream: `mfa-two-factor-hardening`

**Recommended status:** `ready-for-agent`

#### THS-007 — Pre-session challenge state (challenge cookie) has no implementation and an undecided TTL/binding design

`low` · `security` · `—` · [.issues/low/THS-007-totp-hotp-mfa-specialist.md](../../.issues/low/THS-007-totp-hotp-mfa-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/models/06-two-factor-totp.md:29` — Spec still describes better-auth's cookie; decision ticket 05 chose Verification.issue/consume for challenge state instead, not yet written into spec.
  ```
  minted until the second factor succeeds; a signed, HttpOnly 10-minute
  challenge cookie binds the challenge to the browser; recovery codes are 10 ×
  ```
- `packages/core/src/Hooks.ts:62` — The divert outcome exists; nothing mints/consumes a challenge yet.
  ```
  export class TwoFactorRequired extends Schema.TaggedError<TwoFactorRequired>()(
  ```

**Fix plan**

_Write ticket 05's challenge design into ADR-EA-020: challengeId minted by Verification.issue (identifier bound to userId, 10-minute TTL, single-consume, replay event), one live challenge per account, revoked when 2FA is disabled._

Steps:
1. ADR-EA-020 Decision 2: on BeforeSessionIssue divert, TwoFactor calls `verification.issue({ identifier: "2fa-challenge:<userId>", ttl: "10 minutes" })` (issuing supersedes any prior live challenge for that identifier — single live challenge); `challengeId` returned in TwoFactorRequired; /two-factor/verify and /verify-recovery call `verification.consume` with the identifier derived from the claimed userId, so a challenge for user A cannot verify user B; consumption is single-use and failed/replayed consumes publish auth.token.replay (BEH-EA-059); disabling 2FA revokes outstanding challenges. If a browser-binding cookie is also used, it carries only the challengeId with BEH-EA-055's fixed attributes (HttpOnly, Secure, SameSite=Lax, Path=/auth/two-factor).
2. spec/models/06-two-factor-totp.md: replace line 28-30's cookie description with a link to ADR-EA-020 and remove the TTL from the undecided list.

Files: `spec/decisions/020-two-factor-state.md (new)`, `spec/models/06-two-factor-totp.md`

Tests (write first):
- Code phase: packages/two-factor/test/TwoFactor.test.ts 'a challenge issued for user A cannot be consumed for user B', 'a second divert invalidates the first challenge', 'challenge expires after 10 minutes (TestClock)'.

Acceptance:
- Challenge TTL, binding, single-live and consumption semantics are decided in spec.

Spec refs: ADR-EA-020 (new), BEH-EA-055, BEH-EA-059, BEH-EA-061 · Effort: **S** · Depends on: THS-004 · Workstream: `mfa-two-factor-hardening`

**Recommended status:** `ready-for-agent`

### Workstream `cli-doctor-hardening`

#### ECS-005 — doctor has no secret-redaction requirement for reported configuration

`medium` · `security` · `—` · [.issues/medium/ECS-005-effect-cli-specialist.md](../../.issues/medium/ECS-005-effect-cli-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/behaviors/26-cli.md:24` — No redaction clause anywhere in BEH-EA-201..208 (`grep -ni redact spec/behaviors/26-cli.md` is empty).
  ```
  REQUIREMENT: `awthaq doctor` MUST report every plugin-graph linking
               problem, every configuration value it can validate, and every
               known insecure-default combination
  ```

**Fix plan**

_Add a CLI-wide output-redaction requirement: configuration inputs that are Config.Redacted (or declared sensitive in the ECS-008 descriptors) are reported only as present/valid/invalid, never as values, enforced by a BDD scenario and a unit test._

Steps:
1. spec/behaviors/26-cli.md BEH-EA-201: append to the REQUIREMENT 'it MUST NOT print the value of any configuration input carried as `Redacted` or declared sensitive; such inputs are reported only as present, valid, or invalid (with the validation message, never the value).' Add a sentence that the same rule applies to `config list`, `--json` output and error messages of every CLI command.
2. features/features/08-tooling/26-cli.feature: add @skip @unwired Scenario 'doctor never prints a secret configuration value' (Given an OAuth client secret 'sk-canary-123' and a DATABASE_URL with a password, Then the output does not contain 'sk-canary-123' nor the password, And reports the client secret as 'present, valid').
3. Implementation (with BE-003 + ECS-008): packages/cli/src/Doctor.ts renders descriptor values through a single `renderValue(descriptor, value)` that returns `<redacted>` for sensitive keys and for any `Redacted.isRedacted(value)`; DATABASE_URL-like strings are passed through a URL credential scrubber.

Files: `spec/behaviors/26-cli.md`, `features/features/08-tooling/26-cli.feature`, `packages/cli/src/Doctor.ts (new)`

Tests (write first):
- First failing test (with the CLI): packages/cli/test/Doctor.test.ts 'doctor output contains no canary secret' — capture stdout/`--json` and assert the canary string is absent.

Acceptance:
- BEH-EA-201 carries an explicit no-secret-values clause covering human and JSON output.
- A scenario asserts a canary secret never appears in doctor output.

Spec refs: BEH-EA-201, BEH-EA-126 · Effort: **S** · Depends on: none · Workstream: `cli-doctor-hardening`

**Recommended status:** `ready-for-agent`

#### ECS-008 — doctor's config-validation mandate conflicts with ADR-006 and the no-Layer boundary

`medium` · `correctness` · `—` · [.issues/medium/ECS-008-effect-cli-specialist.md](../../.issues/medium/ECS-008-effect-cli-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high) — canonical for EP-009

**Evidence at HEAD (ec065a7)**

- `spec/decisions/006-runtime-config-separate-from-installation.md:33` — ADR-006 is still Revision 1.1 and still accepts 'no config-validation-CLI story'.
  ```
  **Negative**: There is no single artifact that lists "every configuration value this application has set," and this is a real operational gap, not a stylistic nit. ... there is no `awthaq config list` or equivalent ... no config-validation-CLI story that could catch a malformed override before deploy
  ```
- `spec/behaviors/26-cli.md:24` — BEH-EA-201 still mandates universal config validation, contradicting the ADR.
  ```
  REQUIREMENT: `awthaq doctor` MUST report every plugin-graph linking
               problem, every configuration value it can validate, and every
  ```
- `packages/password/src/Password.ts:541` — Config is a Context.Reference read inside a Layer's make; nothing outside a built Layer can observe the effective value today.
  ```
        const config = yield* PasswordConfig;
  ```

**Fix plan**

_Resolve the contradiction toward the richer option: introduce an effective-configuration descriptor that plugins declare statically (Schema + default + sensitivity), that `doctor` validates and a guarded operator view can dump, and amend ADR-006's Negative consequence accordingly. EP-009's per-tenant effective-config dump is folded in._

Steps:
1. packages/core/src/AuthPlugin.ts: add an optional static `config` descriptor to the plugin definition: `{ reference: Context.Reference<A>, schema: Schema.Codec<A>, sensitive: ReadonlyArray<keyof A> }` (sensitive keys hold Config.Redacted values). Populate it for Password (PasswordConfig), Sessions (SessionConfig in packages/core/src/Sessions.ts), OAuth, Passkey, Organization, Jwt (JwtConfig), Admin, Roles — each already has a Context.Reference with default (grep `Context.Reference` in packages/*/src).
2. packages/core/src/Auth.ts: extend `Built<P>.manifest` with `config: ReadonlyArray<{ pluginId, key, schema, default, sensitive }>` computed in buildManifest (static, no Layer evaluated) — satisfies BEH-EA-208.
3. packages/core/src/EffectiveConfig.ts (new): `EffectiveConfig.snapshot` = an Effect that, *inside* the running application (or a TenantConfig scope, EP-001/EP-007), reads every declared reference and returns `{ pluginId, key, value | "<redacted>", source: "default" | "override" }`; sensitive keys are rendered via `Redacted` and never unwrapped. Expose it on an admin-guarded endpoint in packages/admin's contract (`GET /admin/config`, RequirePermission-gated) so operators can dump effective config per tenant (EP-009).
4. spec/decisions/006-runtime-config-separate-from-installation.md: bump to Revision 1.2 and rewrite the Negative paragraph: configuration *shape* is now in the static manifest (doctor validates declared defaults and overrides it can see), effective *values* are introspectable at runtime via EffectiveConfig (redacted); remaining gap = overrides computed dynamically at request time cannot be validated pre-deploy.
5. spec/behaviors/26-cli.md BEH-EA-201: replace 'every configuration value it can validate' with 'every configuration value declared in the manifest's config descriptors that the loaded awthaq.config.ts statically provides, decoded through its Schema' and add `awthaq config list` (prints manifest config descriptors + statically visible overrides, redacted) as part of doctor or as a sibling inspection command (listed in BEH-EA-208's inspection set).
6. Add a new behavior for the runtime effective-config view (next free id) in spec/behaviors/27-admin-impersonation.md's neighbour or a new admin behavior, referencing ADR-006 rev 1.2.
7. features: 26-cli.feature 'doctor reports every configuration value it can validate' scenario rewritten to the descriptor wording; add 'config list never prints a sensitive value'.

Files: `packages/core/src/AuthPlugin.ts`, `packages/core/src/Auth.ts`, `packages/core/src/EffectiveConfig.ts (new)`, `packages/*/src/<Plugin>.ts config descriptors`, `packages/admin/src/AdminApi.ts`, `spec/decisions/006-runtime-config-separate-from-installation.md`, `spec/behaviors/26-cli.md`, `features/features/08-tooling/26-cli.feature`

Tests (write first):
- packages/core/test/Auth.test.ts (or AuthPlugin.test.ts) 'manifest.config lists Password.minLength with its Schema and default without building any Layer' — failing first.
- packages/core/test/EffectiveConfig.test.ts 'snapshot reports an overridden Password.minLength as source=override and renders sensitive keys as <redacted>'.
- packages/admin/test: 'GET /admin/config is denied without the admin permission'.

Acceptance:
- ADR-006 and BEH-EA-201 no longer contradict each other.
- `auth.manifest.config` exists and is derived statically.
- An operator can dump effective config (redacted) through a permission-gated endpoint; no Redacted value is ever unwrapped in output.

Spec refs: BEH-EA-201, BEH-EA-208, BEH-EA-017, ADR-EA-006 · Effort: **L** · Depends on: ECS-005 · Workstream: `cli-doctor-hardening`

Note / recommendation: Option (a) — enumerate a statically declared config surface and amend ADR-006 — over (b) narrowing BEH-EA-201; per the flexibility-over-complexity preference and decision ticket 07 §4 (doctor reads what awthaq.config.ts can statically expose).

**Recommended status:** `ready-for-agent`

#### EP-009 — No operational artifact of effective configuration — an ADR-acknowledged multi-tenant blind spot

`low` · `dx` · `—` · [.issues/low/EP-009-eugenio-pace.md](../../.issues/low/EP-009-eugenio-pace.md) · current status: `needs-triage`

**Verdict:** DUPLICATE (confidence: high) — duplicate of **ECS-008**

**Evidence at HEAD (ec065a7)**

- `spec/decisions/006-runtime-config-separate-from-installation.md:33` — Same ADR sentence and same root cause as ECS-008; the effective-config snapshot + guarded endpoint in ECS-008's plan is EP-009's recommended fix.
  ```
  **Negative**: There is no single artifact that lists "every configuration value this application has set,"
  ```

**No fix** — ECS-008's plan ships the static config descriptors, EffectiveConfig.snapshot and the admin-guarded dump that EP-009 asks for; per-tenant dumps come from running the snapshot inside a TenantConfig scope (multi-tenant-composition).

**Recommended status:** `resolved`

### Workstream `cli-seed-admin-audit`

#### ECS-006 — No audit trail for seed admin privilege promotion

`medium` · `compliance` · `—` · [.issues/medium/ECS-006-effect-cli-specialist.md](../../.issues/medium/ECS-006-effect-cli-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/behaviors/26-cli.md:116` — No event/audit requirement.
  ```
  REQUIREMENT: `seed admin` MUST create or promote one account to an
               administrative role through the same domain services an
               application would use at runtime (`Users`, `Roles`), never by
               writing rows directly to the database; it MUST refuse to run
               against a target that already has an administrative account
               unless explicitly forced.
  ```
- `packages/core/src/AuthEvents.ts:280` — The closed union has admin impersonation events but no admin-seeded/role-granted event. The durable AuditLog (packages/core/src/AuditLog.ts:61, commit 6bd3f1d) records every published AuthEvent, so adding a tag gives a durable trail for free.
  ```
  export type AuthEvent =
    | TokenReplayEvent
    | UserCreatedEvent
    | UserSignedInEvent
    | UserSignInFailedEvent
  ```

**Fix plan**

_Require `seed admin` to publish a typed `auth.admin.seeded` event (and a refusal event) through AuthEvents, which AuditLog persists inline._

Steps:
1. packages/core/src/AuthEvents.ts: add `AdminSeededEvent { _tag: "auth.admin.seeded"; targetUserId: UserId; outcome: "created" | "promoted"; forced: boolean; role: string; via: "cli" }` and `AdminSeedRefusedEvent { _tag: "auth.admin.seedRefused"; reason: "adminExists"; attemptedEmail?: never }` (no PII beyond the user id); extend the `AuthEvent` union and AuditLog's exhaustive `actorOf` switch (packages/core/src/AuditLog.ts:74) — the compiler forces it.
2. spec/behaviors/26-cli.md BEH-EA-206: add 'it MUST publish `auth.admin.seeded` (target account id, created vs promoted, forced flag) on success and `auth.admin.seedRefused` on refusal, so the grant lands in the durable audit table (BEH-EA-100)'.
3. spec/behaviors/13-events.md: add both tags to the BEH-EA-101 registry list (coordinate with ESA-006's registry refresh).
4. features/features/08-tooling/26-cli.feature: @skip @unwired Scenarios 'seed admin records an auth.admin.seeded audit entry' and 'a refused seed records auth.admin.seedRefused'.
5. Implementation (with BE-003): packages/cli/src/Seed.ts publishes via `AuthEvents.publish` after the Roles grant succeeds.

Files: `packages/core/src/AuthEvents.ts`, `packages/core/src/AuditLog.ts`, `spec/behaviors/26-cli.md`, `spec/behaviors/13-events.md`, `features/features/08-tooling/26-cli.feature`, `packages/cli/src/Seed.ts (new)`

Tests (write first):
- packages/core/test/AuditLog.test.ts 'auth.admin.seeded is recorded with actorUserId none and the target in payload' (failing until the tag exists).
- With the CLI: packages/cli/test/Seed.test.ts 'seed admin --force over an existing admin publishes auth.admin.seeded with forced=true'.

Acceptance:
- Every successful or refused seed produces exactly one durable audit row.
- BEH-EA-206 and the 13-events registry name the tags.

Spec refs: BEH-EA-206, BEH-EA-100, BEH-EA-101 · Effort: **S** · Depends on: none · Workstream: `cli-seed-admin-audit`

**Recommended status:** `ready-for-agent`

### Workstream `redaction-guarantee-check`

#### SMS-003 — The mechanically-checked 'no Redacted reaches spans/events' guarantee does not exist

`medium` · `testing` · `—` · [.issues/medium/SMS-003-secrets-management-specialist.md](../../.issues/medium/SMS-003-secrets-management-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/behaviors/25-testing-harness.md:145`
  ```
  Stated honestly: the first check is not mechanically verifiable today, and this specification should not imply otherwise. Asserting "no `Redacted` value reaches a span or event" requires instrumentation this project has not built
  ```
- `packages/test/src/TestAuth.ts:29` — Header confirms runPluginContractTests (line 262) implements only the contract-hash half.
  ```
  // - BEH-EA-199's "no `Redacted` value reaches a span or event" check is
  ```

**Fix plan**

_Build the BEH-EA-199 interceptor in @awthaq/test using canary secrets: run the plugin's flows with known canary passwords/tokens under a recording Tracer, Logger and AuthEvents/AuditLog subscriber, and fail if any canary string (or an unwrapped Redacted payload) appears in span attributes/events, log messages/annotations, or published events._

Steps:
1. packages/test/src/RedactionProbe.ts (new): `RecordingTracer` via `Tracer.make` (effect/Tracer) capturing span names, attributes and span events; `RecordingLogger` via `Logger.make` capturing message + annotations; a fiber collecting `AuthEvents.stream`; `assertNoLeak(canaries)` deep-walks every captured value (JSON-safe traversal, handling Redacted.isRedacted -> treated as safe, raw strings -> substring check) and fails with the path of the leak.
2. packages/test/src/TestAuth.ts runPluginContractTests: add the redaction case — it takes an optional `exercise: (client) => Effect` per plugin (sign-up/sign-in/reset for Password, callback for OAuth, etc.) run with canaries under the probe; remove the 'not built' header note.
3. Adopt it in the existing contract-test callers (packages/organization/test/AuthHttp.test.ts, packages/jwt/test/AuthHttp.test.ts) and add Password/OAuth/Passkey exercises.
4. spec/behaviors/25-testing-harness.md BEH-EA-199: replace the 'Stated honestly... not built' paragraph with a description of the canary-based check and its limits (it detects raw secret material, not semantic leaks); bump revision; traceability row -> packages/test/test/RedactionProbe.test.ts.

Files: `packages/test/src/RedactionProbe.ts (new)`, `packages/test/src/TestAuth.ts`, `packages/test/src/index.ts`, `packages/test/test/RedactionProbe.test.ts (new)`, `packages/password/test`, `spec/behaviors/25-testing-harness.md`, `spec/traceability.md`

Tests (write first):
- First failing test: packages/test/test/RedactionProbe.test.ts 'fails when a plugin logs the raw password' (a fixture plugin that does Effect.log(Redacted.value(pw))) and 'passes when only Redacted is logged'.
- Then packages/password/test: runPluginContractTests with the redaction exercise must pass.

Acceptance:
- runPluginContractTests fails a plugin that leaks a canary secret into a span, log or event.
- BEH-EA-199 no longer admits the check is unbuilt.

Spec refs: BEH-EA-199, BEH-EA-126 · Effort: **L** · Depends on: none · Workstream: `redaction-guarantee-check`

**Recommended status:** `ready-for-agent`

### Workstream `device-authorization-design`

#### DAG-004 — No user-code entropy/format or rate-limit design exists for the verification surface

`medium` · `security` · `—` · [.issues/medium/DAG-004-device-authorization-grant-specialist.md](../../.issues/medium/DAG-004-device-authorization-grant-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/models/13-device-authorization.md:60` — Unchanged; no device code under packages/.
  ```
  no rate-limiting or user-code entropy design, and no research file in this repository treats device-code flow as its primary subject
  ```

**Fix plan**

_Now that decision 06 makes the device plugin the CLI's login backend, write its security parameters into the model doc (and later BEHs): user-code alphabet/length/entropy, TTL, normalization, constant-time lookup, RateLimiter rules on /device/code, /device/token and the approval endpoint._

Steps:
1. spec/models/13-device-authorization.md: bump revision; add a 'Security parameters' section — user code: 8 chars from a 20-symbol unambiguous consonant alphabet `BCDFGHJKLMNPQRSTVWXZ` (≈34.6 bits, RFC 8628 §6.1 example), displayed as XXXX-XXXX, normalized on input (uppercase, strip `-`/spaces) with exact match only; stored hashed (SHA-256) and looked up by hash (constant-time by construction); device_code 32 CSPRNG bytes, hashed at rest; TTL 15 minutes (configurable via DeviceAuthorizationConfig Context.Reference); poll `interval` 5 s, `slow_down` +5 s per RFC 8628 §3.5.
2. Rate limits (BEH-EA-105 RateLimiter port, registered through the plugin's rule registry like Password.ts's RATE_LIMITS): /device/code 5 per TTL per IP; approval/verification endpoint 5 failed user-code lookups per 15 min per IP and per session; /device/token enforces `interval` per device_code (slow_down on violation).
3. Session issuance: the approved poll calls Sessions.issue for the claimed userId through Hooks.BeforeSessionIssue (DAG-006's constraint, ticket 03).
4. When the plugin is specified as behaviors, lift these into BEH ids (next free).

Files: `spec/models/13-device-authorization.md`

Tests (write first):
- spec:verify:strict; the parameters become assertions in DAG-007's feature file.

Acceptance:
- 13-device-authorization.md fixes alphabet, length, entropy, TTL, normalization, hashed lookup and per-endpoint rate limits.

Spec refs: MOD-EA-013, BEH-EA-105 · Effort: **S** · Depends on: CTA-002 · Workstream: `device-authorization-design`

**Recommended status:** `ready-for-agent`

#### DAG-007 — Zero test or BDD coverage allocated to the device domain

`medium` · `testing` · `—` · [.issues/medium/DAG-007-device-authorization-grant-specialist.md](../../.issues/medium/DAG-007-device-authorization-grant-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/models/13-device-authorization.md:63` — `grep -rli device features/features` hits only sessions/users/passkey features (device *listing*), no device-authorization scenarios.
  ```
  None yet — no test exists.
  ```

**Fix plan**

_Author the device-authorization feature file (scenarios before code) and its traceability, registered as @skip @unwired until the plugin exists._

Steps:
1. features/features/05-authentication-methods/NN-device-authorization.feature (new): Scenarios — authorization_pending then approved -> tokens issued once; denied -> access_denied; polling faster than interval -> slow_down; expired code -> expired_token and row cleanup; two concurrent /device/token polls after approval -> exactly one wins, the other gets invalid_grant; verification-page claim is idempotent for the same session and rejected for a different session; approve without claim is denied; wrong user code attempts are rate-limited (DAG-004 numbers); issued session appears in the user's session list with the device's ip/userAgent (BEH-EA-054).
2. features/features/05-authentication-methods/NN-device-authorization.steps.test.ts placeholder (zero steps) mirroring features/features/08-tooling/26-cli.steps.test.ts so vitest reports them as skipped.
3. spec/traceability.md + features/traceability.md: map MOD-EA-013 to the new feature; 13-device-authorization.md 'Verification' section points at it.

Files: `features/features/05-authentication-methods/NN-device-authorization.feature (new)`, `features/features/05-authentication-methods/NN-device-authorization.steps.test.ts (new)`, `features/traceability.md`, `spec/traceability.md`, `spec/models/13-device-authorization.md`

Tests (write first):
- `pnpm run test:bdd` lists the new scenarios as skipped; spec:verify:strict passes.

Acceptance:
- Race/idempotency semantics are pinned as executable (skipped) scenarios before implementation.

Spec refs: MOD-EA-013, BEH-EA-054 · Effort: **S** · Depends on: DAG-004 · Workstream: `device-authorization-design`

**Recommended status:** `ready-for-agent`

#### DAG-006 — Session-issuance integration point is well-prepared for a future device flow

`info` · `architecture` · `—` · [.issues/info/DAG-006-device-authorization-grant-specialist.md](../../.issues/info/DAG-006-device-authorization-grant-specialist.md) · current status: `needs-triage`

**Verdict:** WONTFIX-CANDIDATE (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/models/13-device-authorization.md:44`
  ```
      dependsOn: [Sessions, Users],
  ```
- `packages/core/src/Sessions.ts:171` — Sessions.issue already carries ip/userAgent as the finding says — nothing is broken.
  ```
      readonly request?: { readonly ip?: string; readonly userAgent?: string };
  ```

**No fix** — Positive observation, no defect. Its one constraint (the poll must call Sessions.issue through BeforeSessionIssue, never a parallel credential path) is written into DAG-004's model-doc section and DAG-007's scenarios, so nothing separate to action.

**Recommended status:** `wontfix`

### Workstream `m2m-client-secret-lifecycle`

#### OCM-005 — Rotation-with-grace-window and transport for client secrets are explicitly undecided

`medium` · `compliance` · `—` · [.issues/medium/OCM-005-oauth2-client-credentials-m2m-specialist.md](../../.issues/medium/OCM-005-oauth2-client-credentials-m2m-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/models/07-api-keys.md:106` — Still undecided; decision ticket 10 (M2M) fixed key format/hashing and the client_credentials token endpoint but not rotation or transport. packages/api-key/src/index.ts is still a placeholder.
  ```
  human-readable `start` prefix for list UX, rotation-with-grace-window
  behavior, and whether the transport is `x-api-key`, `Authorization: Bearer`,
  or both.
  ```
- `packages/jwt/src/JwtConfig.ts:48` — Existing precedent for grace-window rotation in the repo.
  ```
      keyGracePeriod: options.keyGracePeriod ?? Duration.days(30),
  ```

**Fix plan**

_Decide and record (ADR-EA-022) API-key and client-secret rotation with a bounded dual-validity grace window and the transport header, then carry it into the api-key build (OCM-002, cross-slice)._

Steps:
1. spec/decisions/022-api-key-rotation-and-transport.md (new): rotation = `rotate(keyId, { gracePeriod? })` mints a successor (same name/scopes, `rotatedFrom`), sets the predecessor's `expiresAt = now + gracePeriod` (default 24 h, configurable in ApiKeyConfig, max bounded e.g. 30 d mirroring JwtConfig.keyGracePeriod), publishes `auth.apiKey.rotated`; `revoke` remains immediate. Client secrets: `rotateClientSecret(clientId, { gracePeriod? })` keeps at most two valid secret hashes per client. Transport: API keys via `x-api-key` header (configurable header name), `Authorization: Bearer` reserved for JWTs (M2M tokens, jwt plugin) so strategies never double-try; client_credentials accepts client_secret_post (per ticket 10) and client_secret_basic.
2. spec/models/07-api-keys.md: move rotation/transport out of the undecided list, link ADR-EA-022.
3. Code (with OCM-002): packages/api-key rotate/rotateClientSecret + tests.

Files: `spec/decisions/022-api-key-rotation-and-transport.md (new)`, `spec/decisions/index.yaml`, `spec/models/07-api-keys.md`

Tests (write first):
- Code phase first failing test: packages/api-key/test/ApiKey.test.ts 'after rotate both keys resolve until the grace window elapses (TestClock), then only the successor'.

Acceptance:
- Rotation/grace and transport are decided in an ADR; the model doc references it.

Spec refs: ADR-EA-022 (new), MOD-EA-007 · Effort: **S** · Depends on: OCM-002 (cross-slice: api-key build) · Workstream: `m2m-client-secret-lifecycle`

Note / recommendation: A — richer rotation (configurable grace, bounded) while keeping one unambiguous transport per credential type; B's dual transport adds strategy ambiguity for little gain, C causes rotation outages.

**Needs decision** — options:
- A: dual-validity rotation with configurable bounded grace window (default 24 h, max 30 d) + x-api-key transport only for API keys, Bearer reserved for JWT (recommended)
- B: dual-validity rotation + accept both x-api-key and Authorization: Bearer for API keys (prefix-sniffed)
- C: no grace window — rotation is revoke+create (hard cut), x-api-key only

**Recommended status:** `ready-for-human`

### Workstream `bdd-plugin-coverage`

#### BDD-005 — Acceptance suite absent for 4 shipped plugins (magic-link, api-key, two-factor, jwt)

`medium` · `testing` · `—` · [.issues/medium/BDD-005-bdd-gherkin-acceptance-testing-specialist.md](../../.issues/medium/BDD-005-bdd-gherkin-acceptance-testing-specialist.md) · current status: `needs-triage`

**Verdict:** PARTIAL (confidence: high)

**Evidence at HEAD (ec065a7)**

- `packages/two-factor/src/index.ts:8` — OVERSTATED: two-factor, magic-link (packages/magic-link/src/index.ts:8) and api-key (packages/api-key/src/index.ts:8) are empty placeholders — nothing ships, so no acceptance gap exists for them yet.
  ```
  // Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
  
  export {};
  ```
- `packages/jwt/src/Jwt.ts:1` — HOLDS for jwt — and for organization (5.4k LOC), which the issue only mentions in passing: spec/behaviors has no jwt or organization file (01..27 cover neither) and features/features has no jwt/organization feature.
  ```
  // @awthaq/jwt — Jwt
  //
  // .scratch/jwt/spec.md. Tickets 08 (sign/verify), 09 (JWKS endpoint), 10
  ```
- `spec/models/00-adoption-matrix.md:118`
  ```
  | Two-Factor (TOTP) | Planned-Phase2 | P1 | E4 | [06-two-factor-totp.md](06-two-factor-totp.md) |
  ```

**Fix plan**

_Close the real gap — jwt and organization ship without behaviors or acceptance scenarios — by writing their spec/behaviors files and .feature restatements; record magic-link/api-key/two-factor as 'behaviors-before-code' prerequisites of their builds._

Steps:
1. spec/behaviors/29-organization.md (new; BEH ids next free): restate shipped organization semantics (create/update/delete org, membership add/remove/role, invitations, teams, membership-required list endpoints per MTI-002 commit 234756f, hook points in OrganizationHooks.ts, events auth.organization.*).
2. spec/behaviors/30-jwt-bearer.md (new): restate Jwt plugin behavior (token issuance, KeyRing rotation/grace — coordinate with A2's KRS-008/ADR-EA-017, JWKS, RevocationStore, verify rules).
3. features/features/02-domain/29-organization.feature and features/features/05-authentication-methods/30-jwt-bearer.feature with steps files; wire at least the security-critical scenarios per ticket 36's tiering (membership enforcement, JWT signature/alg/exp/revocation).
4. features/README.md mapping table + features/traceability.md + spec/traceability.md rows; spec/behaviors/index.yaml.
5. For two-factor/magic-link/api-key: add to each plugin's build ticket (AOMS-003/THS-001, BAM-007, OCM-002 cross-slice) the gate 'behaviors file + feature file land in the same PR as the plugin' (definitions-of-done).

Files: `spec/behaviors/29-organization.md (new)`, `spec/behaviors/30-jwt-bearer.md (new)`, `spec/behaviors/index.yaml`, `features/features/02-domain/29-organization.feature (new)`, `features/features/05-authentication-methods/30-jwt-bearer.feature (new)`, `features/README.md`, `features/traceability.md`, `spec/traceability.md`

Tests (write first):
- Write the scenarios first against the shipped code — e.g. 'a non-member cannot list an organization's teams' and 'a JWT signed by a retired key past its grace period is rejected' — and wire them with step definitions (they should pass immediately; failures indicate spec/code drift).

Acceptance:
- jwt and organization each have a behaviors file with BEH ids and a wired feature file; spec:verify:strict and test:bdd pass.
- Placeholder plugins carry an explicit behaviors-first gate in their build tickets.

Spec refs: new BEH ids · Effort: **L** · Depends on: KRS-008 · Workstream: `bdd-plugin-coverage`

**Recommended status:** `ready-for-agent`

### Workstream `password-hasher-legacy-recipes`

#### SAM-002 — BcryptHasher.layer is the architecture's named escape hatch but nothing ships it or the recipe

`medium` · `dx` · `—` · [.issues/medium/SAM-002-supabase-auth-migration-specialist.md](../../.issues/medium/SAM-002-supabase-auth-migration-specialist.md) · current status: `needs-triage`

**Verdict:** PARTIAL (confidence: high) — fixed/partly fixed by `60947ff (partial)`

**Evidence at HEAD (ec065a7)**

- `packages/migrate-auth0/src/BcryptVerifier.ts:30` — FIXED part: a bcrypt verifier now ships (commit 60947ff, AOMS-001, decision ticket 21) and plugs into PasswordHasher's LegacyPasswordVerifiers, so needsRehash/rehashOnLogin retire bcrypt on first login.
  ```
  export const bcryptVerifier: PasswordHasher.LegacyPasswordVerifierShape = {
    id: "bcrypt",
    recognizes: (phc) => BCRYPT_TAG.test(phc),
  ```
- `spec/decisions/010-plugins-require-ports-never-provide.md:23` — OPEN part: ADR-010 still names a non-existent `BcryptHasher.layer`; no Supabase/GoTrue recipe exists anywhere (grep supabase/gotrue in packages/*/README.md empty), and the verifier lives in an Auth0-named package.
  ```
  it is simply `BcryptHasher.layer`, a Layer the application provides like any port implementation
  ```

**Fix plan**

_Correct ADR-010's example to the shipped LegacyPasswordVerifiers mechanism and publish a GoTrue/Supabase migration recipe that reuses the bcrypt verifier._

Steps:
1. spec/decisions/010-plugins-require-ports-never-provide.md: bump revision; replace '`BcryptHasher.layer`' with 'a verify-only `LegacyPasswordVerifiers` entry such as `@awthaq/migrate-auth0`'s `bcryptVerifier` — argon2id/scrypt stay the only algorithms `hash()` produces (ticket 21)'.
2. packages/migrate-auth0/README.md (or a new docs section in packages/password/README.md): 'Migrating from Supabase (GoTrue)' — export auth.users (encrypted_password is bcrypt $2a$), import via Users.create + Accounts.link({ credentialHash }) + verifyEmail when email_confirmed_at is set, compose `PasswordHasher.layerArgon2id` with the bcrypt verifier, rehashOnLogin (default true) upgrades on first sign-in, unknown emails still cost real work (dummy hash path). Note: consider re-exporting bcryptVerifier from a neutral name later if a third bcrypt source appears (not now).
3. spec/overview.md ports table: mention LegacyPasswordVerifiers (coordinate with DTWS-008).

Files: `spec/decisions/010-plugins-require-ports-never-provide.md`, `packages/migrate-auth0/README.md`, `packages/password/README.md`, `spec/overview.md`

Tests (write first):
- Existing packages/migrate-auth0/test/BcryptVerifier.test.ts covers the mechanism; add a doc-test style case 'a GoTrue $2a$10$ hash signs in and is rehashed to argon2id' if not already covered.

Acceptance:
- ADR-010 no longer names a phantom BcryptHasher.layer; a Supabase recipe exists.

Spec refs: ADR-EA-010, BEH-EA-114 · Effort: **S** · Depends on: none · Workstream: `password-hasher-legacy-recipes`

**Recommended status:** `ready-for-agent`

### Workstream `cli-migration-guardrails`

#### ECS-009 — migration apply ships without the plan/drift guardrails deferred to the CLI

`low` · `dx` · `—` · [.issues/low/ECS-009-effect-cli-specialist.md](../../.issues/low/ECS-009-effect-cli-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/behaviors/05-persistence-stratum.md:130` — BEH-EA-039 defers guardrails to the CLI.
  ```
  REQUIREMENT: The runtime (`Auth.make`, `auth.layer`, `auth.migrations`) MUST
               NOT depend on a snapshot-diff planner, a checksum ledger, or a
               live-database drift check to function; those capabilities, when
               built, MUST live in the CLI, consuming the same `auth.migrations`
  ```
- `spec/behaviors/26-cli.md:80` — BEH-EA-204 has only --yes: no plan preview, no drift/unknown-key refusal. Decision ticket 07 §3 plans status/apply as a thin wrapper without adding these guardrails.
  ```
  REQUIREMENT: `migration status` MUST report applied and pending migrations by
               comparing the linker's ordered, re-keyed migration record against
               the driver's `Migrator` ledger; `migration apply` MUST require an
               explicit confirmation flag
  ```

**Fix plan**

_Give the first shipped `migration apply` the minimum guardrails BEH-EA-039 promises the CLI owns: print the ordered pending plan, refuse on ledger drift (applied ids unknown to the linker, or out-of-order gaps), and make `status` fail loudly on divergence._

Steps:
1. spec/behaviors/26-cli.md BEH-EA-204: extend REQUIREMENT — `migration status` MUST exit with the drift code (BEH-EA-224) when the ledger contains an applied key the linker's record does not know, or when a pending key sorts before an applied one; `migration apply` MUST print the ordered pending set before applying (and `--dry-run` MUST print it and exit 0/4 without applying) and MUST refuse to run when status would report drift.
2. spec/behaviors/05-persistence-stratum.md BEH-EA-039: add a sentence that the ordered-plan preview and key-level drift refusal are the first (v1) CLI guardrails; checksums and snapshot diffing remain deferred.
3. features/features/08-tooling/26-cli.feature: add @skip @unwired Scenarios 'migration apply prints the ordered pending plan before applying', 'migration apply --dry-run applies nothing', 'migration status reports drift when the ledger has an unknown applied key', 'migration apply refuses on drift'.
4. Implementation (with BE-003): packages/cli/src/Migration.ts reads the Migrator tracking table (effect_sql_migrations) via SqlClient, diffs against `CoreMigrations` + `built.migrations` keys (renumberMigrations in packages/core/src/Auth.ts), returns `{ applied, pending, unknown, outOfOrder }`; `LedgerDrift` TaggedError carries exit code 7.

Files: `spec/behaviors/26-cli.md`, `spec/behaviors/05-persistence-stratum.md`, `features/features/08-tooling/26-cli.feature`, `packages/cli/src/Migration.ts (new)`

Tests (write first):
- First failing test (with the CLI): packages/cli/test/Migration.test.ts over an in-memory SQLite: seed effect_sql_migrations with an id the linker doesn't produce -> `status` fails with LedgerDrift; `apply --dry-run` leaves the ledger unchanged.

Acceptance:
- BEH-EA-204 requires plan preview + drift refusal; the scenarios exist; apply never runs against a drifted ledger.

Spec refs: BEH-EA-204, BEH-EA-039, BEH-EA-224 (new) · Effort: **M** · Depends on: ECS-001 · Workstream: `cli-migration-guardrails`

**Recommended status:** `ready-for-agent`

### Workstream `sqlite-ops-docs`

#### SEA-003 — File-backed SQLite quickstart exists but WAL, backup, and checkpointing are undocumented

`low` · `dx` · `—` · [.issues/low/SEA-003-sqlite-embedded-auth-specialist.md](../../.issues/low/SEA-003-sqlite-embedded-auth-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/appendices/01-password-signup-to-session-view.md:51`
  ```
  const Sql = SqliteClient.layer({ filename: "auth.db" })
  ```
- `../effect/packages/sql/sqlite-node/src/SqliteClient.ts:150` — WAL is on by default; `backup` exists on the client (line 64). `grep -rli 'WAL\|busy_timeout'` over repo docs (excluding research/archive/.issues) hits only .agents persona files.
  ```
        if (options.disableWAL !== true) {
          db.exec("PRAGMA journal_mode = WAL")
  ```

**Fix plan**

_Add an embedded-SQLite operations section: WAL default and -wal/-shm sidecars, live backup via the client's `backup(destination)`, checkpointing, busy timeout, single-writer/single-instance constraint._

Steps:
1. packages/sql/README.md: new 'Embedded SQLite in production' section covering the five topics with a snippet using `SqliteClient.SqliteClient` `backup`, and a note that copying auth.db without -wal is unsafe.
2. spec/appendices/01-password-signup-to-session-view.md:51: add a one-line comment linking that section.

Files: `packages/sql/README.md`, `spec/appendices/01-password-signup-to-session-view.md`

Tests (write first):
- Doc-only.

Acceptance:
- The WAL/backup/checkpoint guidance exists and the appendix links it.

Spec refs: — · Effort: **S** · Depends on: none · Workstream: `sqlite-ops-docs`

**Recommended status:** `ready-for-agent`

### Workstream `native-bearer-bootstrap`

#### MNA-009 — Docs promise a native bearer path the code does not finish

`info` · `docs` · `—` · [.issues/info/MNA-009-mobile-native-auth-specialist.md](../../.issues/info/MNA-009-mobile-native-auth-specialist.md) · current status: `needs-triage`

**Verdict:** PARTIAL (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/behaviors/09-authentication-middleware.md:55` — Verbatim at HEAD (BEH-EA-066 prose); file Revision 1.0.
  ```
  `archive/design/usage-examples-v4.md` §11.3 documents the native-client path this handler serves: a mobile or CLI client with no cookie jar reaches the same contract via `Auth.api(..., { csrf: false })` and a bearer token pulled from a keychain, and is expected to be resolved to the same `Principal` shape a browser session would be.
  ```
- `packages/client/src/AuthClient.ts:27` — HOLDS: the `{ csrf: false }` variant the spec cites does not exist.
  ```
  // **BEH-EA-171's `{ csrf: false }` contract variant has nothing to build
  // against yet.** No plugin's `HttpApiGroup` in this repository currently
  // declares `.middleware(Api.CsrfProtection)` at all
  ```
- `packages/magic-link/src/index.ts:8` — HOLDS: magic-link is a placeholder.
  ```
  // Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
  
  export {};
  ```
- `packages/server/src/Authentication.ts:219` — OVERSTATED: bearer resolution (line 305) AND bearer rotation delivery exist (commit 0f99db7, 2026-09-14, pre-audit). Only token ACQUISITION is missing — no `X-Awthaq-Token-Delivery`/token-in-body anywhere (grep packages/*/src empty), which is MNA-001, decided in .scratch/resolve-ready-for-human-findings/issues/17-native-mobile-session-bootstrap.md.
  ```
   * `issue`; `bearer` gets a `set-auth-token` response header, upstream's
   * own mechanism and the only way a bearer client (presenting the raw
   * secret directly, not through a plugin like `@awthaq/jwt`) can learn its
   * token rotated.
  ```

**Fix plan** — Doc-side only here: amend BEH-EA-066's native-client paragraph to state what exists (bearer resolution + `set-auth-token` rotation header) and what doesn't (token issuance → MNA-001 per decision ticket 17; `{ csrf: false }` variant → BEH-EA-171; magic-link unimplemented). Rewrite it again as a positive statement when MNA-001 lands.

Steps:
1. spec/behaviors/09-authentication-middleware.md:55: replace with: 'Native clients: resolution is implemented — a bearer-presented session token resolves identically to the cookie (BEH-EA-066) and a rotated token is returned in the `set-auth-token` response header (packages/server/src/Authentication.ts deliverRotation). Token *acquisition* for native clients (opt-in bearer delivery on session-minting responses, one-time exchange code for OAuth) is not yet implemented — see MNA-001 / decision ticket 17. The `{ csrf: false }` client variant (BEH-EA-171) has no CSRF-carrying contract to strip yet.' Add a Change History row (Revision 1.0→1.1, MNA-009).
2. Also consider documenting the `set-auth-token` header as a normative clause of BEH-EA-066 (it is shipped behavior with no BEH text) — REQUIREMENT: 'When verify rotates a bearer-presented session, the response carries the new token in `set-auth-token`.' and add a scenario to features/features/03-http-layer/09-authentication-middleware.feature (unwired file — allocate a REQ id via allocate-req-ea.py).
3. When MNA-001 lands (other slice), replace the 'not yet implemented' sentence with the X-Awthaq-Token-Delivery contract.

Files: `spec/behaviors/09-authentication-middleware.md`, `features/features/03-http-layer/09-authentication-middleware.feature`, `features/traceability.md`

Tests:
- If the set-auth-token clause is added: a scenario 'A rotated bearer session returns its new token in set-auth-token' (can stay @unwired until 09 is wired per ticket 36); existing unit coverage in packages/server/test should be cited.

Acceptance:
- BEH-EA-066 prose no longer implies a complete native path; it names MNA-001 as the missing leg.
- `pnpm run spec:verify:strict` passes (new REQ id allocated if a scenario is added).

Spec refs: BEH-EA-066, BEH-EA-171 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

### Workstream `verification-timing-uniformity`

#### MLO-008 — Spec's uniform-response requirement stops at status/body and does not cover the timing channel the code itself names

`info` · `docs` · `—` · [.issues/info/MLO-008-magic-link-email-otp-specialist.md](../../.issues/info/MLO-008-magic-link-email-otp-specialist.md) · current status: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD (ec065a7)**

- `spec/behaviors/08-verification-tokens.md:120` — No latency clause at HEAD.
  ```
  REQUIREMENT: A verification-token-issuing endpoint (password reset,
               email-verification resend) MUST return the same status and
               body whether or not the submitted identifier (email) resolves
               to an existing account.
  ```
- `packages/password/src/Password.ts:771` — Code already implements latency uniformity (commit bd1625c, MLO-001/TSS-001) — spec lags.
  ```
          // BEH-EA-113: dispatched, never awaited — response latency must
          // not depend on mail-provider latency, and per
          // research/05-oauth-oidc.md Q48, a slow-vs-fast response is
  ```

**Fix plan**

_Extend BEH-EA-064 so latency uniformity is normative (mail dispatch asynchronous to the response; equal work in both branches), matching what bd1625c implemented._

Steps:
1. spec/behaviors/08-verification-tokens.md BEH-EA-064: append 'and MUST NOT make response latency depend on whether it resolves: token issuance and mail dispatch for a known identifier MUST run detached from the response, so both branches perform the same synchronous work (one user lookup)'. Cite research/05 Q48 and BEH-EA-113; bump revision.
2. features/features/02-domain/08-verification-tokens.feature (or the password reset feature): add a scenario 'requestReset returns before a slow mailer completes' (TestClock/latched mailer — deterministic, not wall-clock).
3. Reference the existing Password.test.ts coverage from bd1625c in traceability.

Files: `spec/behaviors/08-verification-tokens.md`, `features/features/02-domain/08-verification-tokens.feature`, `spec/traceability.md`

Tests (write first):
- BDD scenario with a mailer that blocks on a Deferred: the response completes while the Deferred is unresolved.

Acceptance:
- BEH-EA-064 names the timing channel; a deterministic scenario guards it.

Spec refs: BEH-EA-064, BEH-EA-113 · Effort: **S** · Depends on: none · Workstream: `verification-timing-uniformity`

**Recommended status:** `ready-for-agent`

## Closed without work

| ID | Level | Verdict | Reason | Evidence |
|---|---|---|---|---|
| DAG-003 | high | DUPLICATE of CTA-002 | Same root cause and same decision (ticket 06) as CTA-002; its extra ask (note in 13-device-authorization.md) is folded into CTA-002's fix plan step 5. | `spec/behaviors/26-cli.md:156` |
| RZS-002 | high | DUPLICATE of PCS-001 | Identical root cause and resolution (ticket 12). Zookie/revision semantics (its longer-term suggestion) were not adopted by the decision and are not planned. | `spec/appendices/02-qadi-path-a-end-to-end.md:59` |
| MAPS-009 | medium | DUPLICATE of KRS-008 | Same model-08 line. Its `dependsOn: []` point is folded into step 5 of KRS-008's plan. | `spec/models/08-jwt-bearer.md:52,80`, `packages/jwt/src/Jwt.ts:27` |
| BO-008 | low | DUPLICATE of NAM-010 | Same source line (24-nextjs-ssr.md:15) and the same two defects: stale banner and the BEH-EA-189 snippet. | `spec/behaviors/24-nextjs-ssr.md:15`, `packages/next/src/WithNextCookies.ts:23-27` |
| DTWS-007 | low | DUPLICATE of TMS-009 | Same file and cells as TMS-009's invariants.md refresh; closed by TMS-009's plan. | `spec/invariants.md:87`, `packages/core/test/Sessions.test.ts:586` |
| EP-009 | low | DUPLICATE of ECS-008 | ECS-008's plan ships the static config descriptors, EffectiveConfig.snapshot and the admin-guarded dump that EP-009 asks for; per-tenant dumps come from running the snapshot inside a TenantConfig scope (multi-tenant-composition). | `spec/decisions/006-runtime-config-separate-from-installation.md:33` |
| VB-007 | low | DUPLICATE of KRS-008 | Same model-08 line. The `typ`-validation code gap belongs to JJS-008 (cross-slice) and is listed as an open item in the model rewrite. | `spec/models/08-jwt-bearer.md:80`, `packages/jwt/src/JwtCodec.ts:136` vs `:225-243` |
| DAG-006 | info | WONTFIX-CANDIDATE | Positive observation, no defect. Its one constraint (the poll must call Sessions.issue through BeforeSessionIssue, never a parallel credential path) is written into DAG-004's model-doc section and DAG-007's scenarios, so nothing separate to action. | `spec/models/13-device-authorization.md:44`, `packages/core/src/Sessions.ts:171` |
| IC-006 | info | DUPLICATE of NAM-010 | A banner-only subset of NAM-010. | `spec/behaviors/24-nextjs-ssr.md:15`, `packages/next/src/index.ts:9-13` |
| SCP-009 | info | DUPLICATE of CWM-002 | Positive/observational finding whose only recommendation is covered by CWM-002 + ADR-EA-019. | `spec/models/12-scim.md:57` |
| SFS-001 | info | DUPLICATE of AOMS-009 | Same root cause (no SAML package) as AOMS-009; its recommendation (seed packages/saml from 10-saml.md's sketch) is AOMS-009's code phase. | `spec/models/10-saml.md:24` |
| SFS-008 | info | DUPLICATE of AOMS-009 | Reports no defect beyond what AOMS-009 (roadmap resequencing) and SFS-003/SFS-007 (port + validation chain spec work) already plan. | `spec/roadmap.md:125` |
