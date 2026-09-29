# Resolution plan: all open audit issues

> ## Execution outcome (2026-09-29)
> **The plan has been executed** on branch `plan/resolve-audit-issues` (nothing pushed).
> Of 934 issue files (900 audited + 17 found during validation + 17 filed by implementing agents), **910 are `resolved`**, **23 are `wontfix`**
> (each with a written rationale in the issue), and **1 is `ready-for-human`**: **MW-005** (needs a human: git remote, npm org, trusted publisher,
> dropping `private` from `@awthaq/ports`; the release pipeline and a dormant canary workflow are prepared).
> - The 32 wontfix candidates were re-triaged: the worthwhile ones were implemented (e.g. OAuth bounce page PV-016, qadi 0.8.0 bump PV-230,
>   `Models.d.ts` declaration emit PV-380 with a smoke guard), the rest closed as wontfix.
> - Verified from a clean build on the final tree: `pnpm run check` exits 0 (workspace:check, typecheck incl. tests, package:smoke, lint, knip,
>   format:check, circular, check:readmes, check:error-tags, coverage with enforced thresholds, test:bdd, spec:verify:strict 30 PASS / 0 FAIL),
>   `pnpm run test:pg` (Docker Postgres 16) 596 tests.
> - Decisions adopted from `DECISIONS.md` are recorded as "adopted recommended option X per plan; user may revisit" in each issue comment.
>   Behavior changes worth reviewing: audit-write failures are best-effort by default (`AuditWritePolicy`, `required` restores fail-closed);
>   `client_secret_basic` is the OAuth token-endpoint default; passkeys registered before P08 must re-register (stored user handle);
>   CSRF cookie wire format changed and secrets must be ≥ 32 bytes; cookie-less native first sign-in is exempt from CSRF
>   (`CsrfConfig.requireTokenWithoutCookies` opts out); `Sessions.revoke*` require a `reason`; email-change confirmation revokes all sessions;
>   SAML is SP-only, IdP-initiated not offered.
> The sections below describe the plan as written *before* execution; per-issue outcomes are in each `.issues/*.md` **Resolved** comment.


**Scope:** every issue in `.issues/` that was still open on 2026-09-29, i.e. 799 of the 900 from the 2026-09-19 audit. The other 101 were already `resolved`/`wontfix`.
**Validated against:** HEAD `ec065a7` (effect-auth). qadi-side findings were also checked against `../qadi` HEAD `dd4d247` (v0.8.0; this repo installs `@qadi/*` 0.7.0).
**Status of this plan:** validation is complete and every issue has a verdict. Nothing in `src/`, `spec/` or `.issues/` has been changed yet. This directory is the plan.

---

## 1. How to read this directory

| File | What it is | Use it to |
|---|---|---|
| **`README.md`** (this) | Master plan: method, results, new findings, phases, priority queue, protocol | Decide what to do next |
| [`DECISIONS.md`](DECISIONS.md) | 39 open product/design calls, each with options and a recommendation | Unblock the `ready-for-human` issues |
| [`programs/P01…P20-*.md`](programs/) | The 497 still-open issues grouped into 20 programs, then workstreams; one table row per issue with fix summary, effort and blockers | Execute a program end to end |
| [`slices/NN-*.md`](slices/) | **Full per-issue dossiers**: verdict, evidence at HEAD (`path:line` + verbatim snippet), fix steps, files, TDD tests, acceptance criteria, BEH-EA refs, effort, dependencies | Implement a single issue without rereading the audit |
| [`slices/NN-*.json`](slices/) | Same data, machine-readable | Scripts and agents |
| [`INDEX.md`](INDEX.md) | All 799 issues in one table: verdict, workstream, effort, target status, link to dossier | Look up any ID |
| [`WORKSTREAMS.md`](WORKSTREAMS.md) | 209 workstreams ranked, plus the program roll-up | See cross-slice grouping |
| `plan.json` | Merged data for all of the above | Tooling |
| `_manifests/` | Slice manifests (`*.tsv`), the validator brief (`BRIEF.md`), `programs.json` (workstream → program map), `aggregate.py` | Regenerate: `python3 .plan/_manifests/aggregate.py` |

> **ID collisions.** Four auditor-prefix pairs reuse IDs: `AH-` (anders-hejlsberg / aslak-hellesoy), `ESS-` (effect-schema / effect-stream), `SMS-` (secrets- / session-management), `TS-` (tim-smart / torin-sandall). Twenty-five IDs are ambiguous. Throughout `.plan/` the unique key is the **issue file stem** (e.g. `TS-001-tim-smart`). Bare IDs are used only where unambiguous. Commit messages that touch these must use the stem.

---

## 2. Method

1. **Partition.** The 799 open issues were split into 13 slices by package or source-file hotspot, so findings on the same file and their duplicates were judged together (`_manifests/*.tsv`).
2. **Validate each issue against the code, not the audit's quote.** One validator per slice, all following `_manifests/BRIEF.md`. Each one:
   - opened the cited construct at HEAD (line numbers had drifted over 100+ commits);
   - ran `git log --grep/-S` to find fixes, and read sibling issues' resolution comments and the wayfinder decisions in `.scratch/resolve-ready-for-human-findings/issues/NN-*.md`, which were **followed, not re-litigated**;
   - assigned exactly one verdict;
   - recorded evidence, which is mandatory for every verdict.
3. **Plan each still-real issue.** Each gets fix steps with exact files and symbols, a failing test to write first (TDD), acceptance criteria, BEH-EA references, an effort estimate (S < 1h, M ≈ ½ day, L 1–2 days, XL multi-day and decomposed into steps), blockers, and a workstream slug.
4. **Constraints baked into every fix plan:**
   - no `as` / `as unknown as` / `as any` in library source;
   - no return-type annotations on new Effect/Layer consts;
   - type-system-first plugin composition via Layer types;
   - no "API stability" arguments, since the library is pre-release;
   - flexibility over complexity, without speculative unused infrastructure;
   - Effect v4 APIs checked against `../effect`.
5. **Mechanical checks on the validators' output** (run by the orchestrator):
   - All **1,604 evidence references** resolve. The 6 that aren't file paths are recorded command outputs, e.g. test runs.
   - Every snippet's first line appears **verbatim** in the cited file. The 6 exceptions are command-output or directory-listing evidence, or deliberately shortened with `…`.
   - All **62 ALREADY-FIXED** verdicts cite a SHA that `git cat-file` confirms is a real commit.
   - Every DUPLICATE points to a canonical issue that is itself CONFIRMED or PARTIAL. There are no chains and no dangling references.
   - Every CONFIRMED/PARTIAL issue has a fix plan and a target status.
   - Semantic spot-checks by hand: PIL-007 reuse-before-secret (`Sessions.ts:439-470`), rotation lost on typed error (`Authentication.ts:270-290`), React client has no CSRF (`packages/react/src`), RBS-003 unbounded memory store, RRM-001 `canGrant` bypass, TS-001 `BooleanFromBit` on Postgres. **All hold.**

---

## 3. Results

### Verdicts × level

| Level | CONFIRMED | PARTIAL | DUPLICATE | ALREADY-FIXED | INVALID | WONTFIX-CANDIDATE | Total |
|---|---|---|---|---|---|---|---|
| high | 60 | 9 | 8 | 4 | 0 | 0 | 81 |
| medium | 196 | 59 | 86 | 38 | 2 | 9 | 390 |
| low | 129 | 22 | 72 | 17 | 2 | 5 | 247 |
| info | 19 | 3 | 42 | 3 | 1 | 13 | 81 |
| **total** | **404** | **93** | **208** | **62** | **5** | **27** | **799** |

**What is left to do:**
- **497 issues need code, spec or doc work** (404 confirmed + 93 partial), in 20 programs and about 200 workstreams.
- **270 close with no work.**
  - 208 are duplicates; the canonical fix closes them.
  - 62 are already fixed by commits since the audit.
- **32 close as wontfix** (27 wontfix candidates + 5 invalid), pending your confirmation (§7).

**Target statuses:** `ready-for-agent` 457 · `ready-for-human` 40 · `resolved` 270 · `wontfix` 32.

Summed per-issue effort for the 497 is **about 2,060 hours as an upper bound**. Grouped fixes overlap heavily; for example, one THS-001 build closes about 10 MFA findings. A realistic figure is roughly 50–60% of that.

### Program roll-up

| # | Program | Phase | Open | high | med | low | info | Decisions | ~h (upper) |
|---|---|---|---|---|---|---|---|---|---|
| P19 | [Spec & documentation truthfulness](programs/P19-spec-documentation-truthfulness.md) | 0 | 27 | 1 | 7 | 15 | 4 | 0 | 42 |
| P20 | [Test suite, tooling & CI](programs/P20-test-suite-tooling-ci.md) | 0 | 49 | 1 | 24 | 22 | 2 | 3 | 152 |
| P01 | [Session integrity & cookie/CSRF correctness](programs/P01-session-integrity-cookie-csrf-correctness.md) | 1 | 44 | 0* | 22 | 21 | 1 | 3 | 125 |
| P02 | [OAuth / OIDC flow hardening](programs/P02-oauth-oidc-flow-hardening.md) | 1 | 35 | 3 | 21 | 10 | 1 | 4 | 64 |
| P03 | [JWT, signing keys & key rotation](programs/P03-jwt-signing-keys-key-rotation.md) | 1 | 23 | 4 | 11 | 7 | 1 | 2 | 92 |
| P04 | [Authorization: organizations, roles, qadi](programs/P04-authorization-organizations-roles-qadi.md) | 1 | 54 | 8 | 32 | 11 | 3 | 4 | 198 |
| P05 | [Admin & impersonation](programs/P05-admin-impersonation.md) | 1 | 12 | 3 | 7 | 1 | 1 | 3 | 91 |
| P06 | [Rate limiting & abuse resistance](programs/P06-rate-limiting-abuse-resistance.md) | 1 | 10 | 1 | 7 | 2 | 0 | 0 | 39 |
| P07 | [Password, hashing, mail & verification tokens](programs/P07-password-hashing-mail-verification-tokens.md) | 2 | 37 | 4 | 20 | 12 | 1 | 3 | 86 |
| P08 | [Passkeys / WebAuthn](programs/P08-passkeys-webauthn.md) | 2 | 25 | 0 | 16 | 8 | 1 | 2 | 58 |
| P09 | [Persistence: SQL dialects, repositories, replicas](programs/P09-persistence-sql-dialects-repositories-replicas.md) | 2 | 19 | 2 | 7 | 8 | 2 | 1 | 79 |
| P10 | [Events, hooks & observability](programs/P10-events-hooks-observability.md) | 2 | 33 | 6 | 19 | 8 | 0 | 1 | 133 |
| P11 | [Compliance: erasure, export, retention, redaction](programs/P11-compliance-erasure-export-retention-redaction.md) | 2 | 7 | 2 | 4 | 1 | 0 | 3 | 57 |
| P12 | [Composition, API surface & error taxonomy](programs/P12-composition-api-surface-error-taxonomy.md) | 2 | 16 | 1 | 10 | 5 | 0 | 1 | 73 |
| P13 | [Frontend: Next.js, React, client](programs/P13-frontend-next-js-react-client.md) | 2 | 29 | 5 | 10 | 13 | 1 | 1 | 78 |
| P14 | [Identity model & user lifecycle](programs/P14-identity-model-user-lifecycle.md) | 3 | 10 | 3 | 5 | 2 | 0 | 1 | 134 |
| P15 | [MFA, passwordless & authentication assurance](programs/P15-mfa-passwordless-authentication-assurance.md) | 3 | 19 | 6 | 10 | 3 | 0 | 1 | 131 |
| P16 | [Native, bearer & machine identity](programs/P16-native-bearer-machine-identity.md) | 3 | 16 | 8 | 7 | 0 | 1 | 2 | 120 |
| P17 | [CLI tooling](programs/P17-cli-tooling.md) | 3 | 16 | 6 | 9 | 1 | 0 | 0 | 115 |
| P18 | [Multi-tenancy, residency & enterprise federation](programs/P18-multi-tenancy-residency-enterprise-federation.md) | 4 | 16 | 5 | 7 | 1 | 3 | 4 | 194 |

\* P01 contains no audit-rated highs, but it holds the most severe **new** finding (N1 below). Re-rate PIL-007 to **high**.

---

## 4. New defects found during validation (not in the audit)

Validators found these while checking evidence. Each one is already folded into the fix plan of the named host issue, but it should also be **filed as its own issue** in Phase 0 so it is tracked. ✅ means the orchestrator re-verified it at HEAD.

| # | Sev. | Defect | Evidence | Planned under |
|---|---|---|---|---|
| N1 ✅ | **high** | `Sessions.verify` runs the RRS-003 tombstone/reuse branch **before** checking the secret. Presenting `<supersededSessionId>.<anything>` revokes the user's whole live session family and emits a false `auth.session.reuse`. Session IDs are the public half of the token and appear in cookies, JWT `sid` and error messages, so this is a targeted log-out-anyone attack. | `packages/core/src/Sessions.ts:439-458` (reuse branch) vs `:470-479` (secret compare) | PIL-007 → `session-verify-hardening` (P01) |
| N2 ✅ | high | `@awthaq/react`'s `ReactAuthClient` never provides the CSRF client middleware, so every React mutation gets **403** now that 409334e enforces CSRF on all mutating groups. | no `Csrf` reference in `packages/react/src`; see slice 11 NF-11-1 | `react-client-atoms-factory` (P13), with an interim fix in step 1 |
| N3 ✅ | high | A rotated session secret is **lost when the handler fails with a typed error**. `deliverRotation` is chained on the handler's success, so the user is silently logged out, since there is no grace window. | `packages/server/src/Authentication.ts:270-290` | PIL-005 → `session-rotation-delivery` (P01) |
| N4 | high | Decision 24 §2's CSRF exemption for bearer requests was never implemented, so bearer/native clients get 403 on sign-out, revoke and delete-user. | slice 06, MNA-008 dossier | `csrf-hardening` (P01) |
| N5 | medium | `GET /session/current` returns **500** past 200 sessions, because `list` returns the oldest rows first, expired ones included, and the lookup goes through the capped list. | slice 01, ESS-005-effect-stream-specialist; slice 05, TIR-003 | `session-list-correctness` (P01) |
| N6 | medium | A failed `issue(supersedes)` now raises a false reuse alarm, because RRS-003 turned the delete into a tombstone. The non-transactional two-statement supersede (RRS-004) makes a crash look like token theft. | slice 01 / slice 12 RRS-004 | `session-supersede-atomicity` (P01) |
| N7 | medium | Hook `tap()` layers carry no requirement on their hook point, so the INV-EA-005 / BEH-EA-094 compile-time guarantee that `spec/traceability.md:112` claims is **not enforced**. | slice 02, ELC-001 dossier | `hook-registry-per-composition` (P10) |
| N8 | medium | A dynamic org role named `owner` or `admin` overwrites that org's built-in statements. | slice 08, RZS-005 | `org-qadi-relationships` (P04) |
| N9 | medium | `removeMember` and `leave` leave the user's **team memberships** behind, so qadi still answers `team-member`. `leave()` also runs no remove-member hooks, which PCS-002's invalidation depends on. | slice 08, CWM-003 / PCS-002 | `org-active-context-lifecycle`, `qadi-decision-cache-invalidation` (P04) |
| N10 | medium | The same Postgres decode failure as TS-001 exists in the admin, jwt, organization, passkey and migrate-better-auth record stores, which use SQLite-only field types. | slice 05, TS-001-tim-smart | `sql-dialect-neutral-models` (P09) |
| N11 | medium | Running `coreMigrations` (ids 1–17) and the index-numbered plugin migrations separately against the same `effect_sql_migrations` table **silently skips plugin migrations**. The CLI must not do that. | slice 05, SSMS-005 → BE-003 | `cli-manifest-tooling` (P17) |
| N12 | medium | `KeyRing.rotateNow` keeps a *compromised* key valid for the full 30-day grace period, because there is no revoke-now path. | slice 12, KRS-008 | `jwt-key-rotation-runbook` / `jwt-key-rotation-integrity` (P03) |
| N13 | medium | The README quickstart no longer type-checks: Mailer lacks `sent`, and there are no AuditLog or CsrfProtection layers. The five package rosters have drifted (21 of 23 packages listed). | slice 13 | `readme-docs-accuracy`, `workspace-roster-sync` (P19/P20) |
| N14 | medium | GC-001 is marked `resolved`, but `OAuth.ts:250`, `:712`, `OAuthTokenAccess.ts:93`, `isFlowPayload` (`OAuth.ts:144-146`) and `packages/oauth/src/Jwt.ts:90` still use `as` on untrusted input. Validators counted **11 `as` casts** left in library source. | slices 03, 04, 13 | `oauth-provider-response-decoding`, AOMS-005 (P02/P03) |
| N15 | low | `applyRotatedSession` isn't exported from `@awthaq/next`, although the README imports it. `makeVerifier` isn't exported from `@awthaq/jwt` since 387838f. | slice 11, RRS-002 / NF-11-2/3 | `next-getsession-hardening` (P13), P03 |
| N16 | low | Session cookie is `SameSite=Strict` but is set on a redirect chain the provider started cross-site, so the first landing request after an OAuth sign-in may look signed out. | slice 03 observations | P02, and the IC-007 cookie decision in DECISIONS.md |
| N17 | low | Type-level import cycle between AuditLog and AuthEvents that `pnpm circular` doesn't detect. Nothing ever retains or erases `audit_log` rows. | slices 13, 02 | `tooling-typecheck-lint` (P20), `data-retention-sweep` (P11) |

**Divergence from a recorded decision:** CSG-001/DRS-002 (commit `ec065a7`) built GDPR erasure as opt-in `BeforeUserDelete` hook taps, but wayfinder ticket 30 chose an `ErasureRegistry` domain service. CSG-001 is therefore only PARTIAL. Its plan in `gdpr-erasure-export` (P11) migrates the taps into the registry. ELC-001 (per-composition hook registries) removes the reason the taps had to be opt-in.

**Wayfinder tickets that don't match HEAD** (the plans adapt; the decisions aren't reopened):
- Ticket 05's proposed `SecretBox` port is unnecessary, because `ports/Encryption.ts` already does AES-GCM with row-bound additional data.
- Ticket 17's "KeyValueStore port" doesn't exist, so the plan uses core `Verification` for the exchange code.
- Ticket 28 cites a nonexistent `SessionsRepository.findByTokenHash`.
- Ticket 27 assumed hand-written queries already get named spans; they don't.

---

## 5. Execution phases

The phases follow risk and dependency. A phase doesn't have to finish before the next starts; independent programs can run in parallel, one agent per workstream.

### Phase 0: Bookkeeping, truth and decisions (no behavior change)
1. **Apply the validation to `.issues/`.** For each of the 799, set `Status:` to the recommended status and append a `**Validation (2026-09-29):**` comment with the verdict, the evidence pointer (`.plan/slices/<slice>.md#…`), and for duplicates the canonical ID and for already-fixed the SHA. This can be scripted from `plan.json`, whose fields map one-to-one. Do the 32 wontfix only after §7 is confirmed.
2. **File N1–N17** as new `.issues/` entries, using the same format with a `Found-in: plan validation` provenance line, or as `.scratch/` tickets per `docs/agents/issue-tracker.md`. Re-rate PIL-007 to high.
3. **Regenerate `.issues/README.md` totals.** They still say 175 high, and 93 of those are resolved.
4. **Answer the 39 decisions** in [`DECISIONS.md`](DECISIONS.md). Each answered one flips its issue to `ready-for-agent`.
5. **P19 (spec/doc truthfulness) and the cheap P20 items:**
   - spec banners (DTWS-001/002), README quickstart, roster sync, stale `.quality-metrics`;
   - the BDD wiring program (AH-003-aslak-hellesoy, decision 36) starts here and continues throughout, since every later program adds scenarios to it.

### Phase 1: Security and correctness in shipped code (P01–P06)
Fix defects in code that already ships. Most are S/M and self-contained. The first-wave queue is in §6.

### Phase 2: Robustness of existing subsystems (P07–P13)
Hashing and mail typed errors, passkey ceremony policy, **Postgres decode (TS-001, blocks any Postgres user)**, event envelope, hook registries, observability, erasure/retention, HttpApi surface consolidation (MW-002), and frontend composition.

### Phase 3: Missing subsystems (P14–P17)
Mostly XL work, each decomposed into steps inside its dossier: the UserIdentity model (ticket 09), TwoFactor + MagicLink + EmailOtp (ticket 05), native/bearer/M2M (tickets 10, 17, 33), and the CLI (tickets 06, 07).

### Phase 4: Multi-tenancy and enterprise federation (P18)
Tenancy (ticket 18) is a schema-wide change. Do it after the Phase 2 SQL work and after the identity model, then SAML/SCIM (ticket 08).

### Cross-program dependencies to respect
- **TS-001 `makeModels(dialect)` (P09) must come before** new SQL tables in P14/P15/P16/P18, or they inherit the Postgres decode bug (N10).
- **ELC-001 per-composition hook registry (P10)** comes before TwoFactor's gate taps (P15) and before the erasure migration into a registry (P11).
- **Ticket 09 identity model (P14)** comes before SCIM `active:false` (P18), SAM-003 and FAMS-002. BAM-005's `banned` gate and SCP-001's `status` share one sign-in gate and one migration.
- **KRS-002 multi-key KeyProvider (P03)** blocks the rotation half of SMS-002-secrets-management-specialist.
- **CSG-003 Retention (P11)** is needed by SMS-002-session-management-specialist, PPS-003 and ALF-010.
- **MNA-001/MNA-003 native delivery (P16)** blocks `client-native-bearer-mode` (P13) and WPS-004.
- **PCS-001 → PCS-002 → RZS-002/YL-007/AAPS-005/PCS-005**: one decision-cache invalidation chain (ticket 12).
- **CTA-002 (amend BEH-EA-208)** comes before CTA-001. All CLI rows edit `spec/behaviors/26-cli.md` and should land as **one revision**.
- **EP-001 (P18)** blocks EP-005, DRS-007 and AR-004.
- **ECF-001 outbound deadlines** span OAuth, the jwt verifier and the Password HIBP call. Implement it once as a shared policy.
- A **shared constant-time compare helper** is used by TSS-003, ACS-005 and the P01/P08 items. Add it once in `@awthaq/ports` or core.

---

## 6. Priority queue: first wave (Phase 1)

Ordered by exploitability, then blast radius, then effort. Every row is `ready-for-agent`, and the dossier has the failing test to write first.

| # | Issue | Why first | Effort | Program |
|---|---|---|---|---|
| 1 | **PIL-007** (+N1) | Unauthenticated revocation of any user's sessions with only the session ID. Move the secret check before the tombstone/expiry branches; the uniform `SessionNotFound` is preserved | M | P01 |
| 2 | **OIT-001** (+AP-004, APS-008) | Userinfo `sub` can re-anchor account lookup, an account-takeover class of bug. Require `userinfo.sub === id_token.sub` and let signed claims win | M | P02 |
| 3 | **RRM-001** (then RZS-005 / N8) | Role-assignment paths bypass `canGrant`, allowing privilege escalation inside an org | M | P04 |
| 4 | **IDS-001** (+MTI-006) | Impersonation gate never sees the target, so an admin can impersonate a more privileged or foreign-tenant account | M | P05 |
| 5 | **PCS-001** (+RZS-002, YL-007) | Revoked membership keeps returning Allow from the app-scoped decision cache. Move to per-request scope (ticket 12) | M | P04 |
| 6 | **N2** (React CSRF) | React mutations are broken in production today | S (interim) | P13 |
| 7 | **N3 / PIL-005** | Silent logouts on any typed handler error | M | P01 |
| 8 | **N4 / MNA-008** | Bearer clients can't sign out or revoke | S | P01 |
| 9 | **RBS-003** | Unauthenticated memory DoS through attacker-keyed buckets. Add a sweep and a hard cap | M | P06 |
| 10 | **KRS-001** (+SMS-001-secrets-management-specialist) | Plaintext JWT private keys in the database. Encrypt through the existing Encryption port | M | P03 |
| 11 | **ECF-002** | JWKS unknown-kid refetch on every request, which amplifies DoS. Add single-flight, TTL and a negative cache | M | P03 |
| 12 | **ECF-001** | No deadline on 5 outbound calls, so auth fibers can hang | M | P02 |
| 13 | **ESS-002-effect-schema-specialist** (+AH-003-anders-hejlsberg, AP-008, JR-010, TTE-003) | OIDC discovery document cast instead of decoded. Decode at boot; covers part of N14 | S | P02 |
| 14 | **RRS-004 / N6** | Crash during supersede looks like token theft and kills the family. Wrap it in one transaction | S | P01 |
| 15 | **N5** / ESS-005-effect-stream-specialist / TIR-003 | 500 past 200 sessions. Use a targeted lookup and fix pagination | M | P01 |
| 16 | **OHS-002, OHS-003** | Org-delete cascade isn't transactional, and duplicate team membership corrupts caps | M+M | P04 |
| 17 | **EOTS-003** | Failed session verification is unobservable (the password half is done in f5eb570) | S | P10 |
| 18 | **RRS-002** + N15 | Next.js RSC rotation hard-logs users out. Export `applyRotatedSession` | S | P13 |
| 19 | **EAR-001, EAR-002** | React subject never updates after mount, and leaks an anonymous subject after sign-out | M+M | P13 |
| 20 | **TS-001-tim-smart** (+N10) | Postgres users can't read any row. This blocks Phase 3 schema work | L | P09 |

After the first wave, work the **55 medium-severity security issues** program by program. They're flagged `security` in each `programs/*.md` table.

---

## 7. Confirm before closing as wontfix (32)

These are recommended `wontfix`. Several deserve a second look because your "flexibility over complexity" preference might argue for doing them. Those are marked ⚑.

- **INVALID (5):**
  - BCR-007: describes better-auth's behavior, not awthaq's.
  - EAR-005: SSR and the client read the same seed.
  - MTS-007: pnpm 11 enables the release-age gate by default.
  - PPS-006: `@effect/sql-pg` auto-prepares statements.
  - RRC-006: the proposed fix would itself cause a dead-token bug.
- **Positive observations, nothing to fix:** BAM-011, BCR-008, CTA-007, DAG-006, RRC-007, PIL-008 (spec-backed), AGA-006, SFS-005.
- **Scope or design choices:**
  - BO-004 and BO-010: no second framework adapter is on the roadmap.
  - BO-007: argued from API stability, which your preferences exclude.
  - DRS-004: the tenancy plan makes it moot.
  - TC-008: documented deferral.
  - TS-007: no streaming route exists.
  - MM-008: a TS7 limitation, documented.
  - TTE-006: forced by upstream HttpApiGroup variance.
  - BCR-009, SOS-002, SOS-007: SMS/backup-code substrate is handled elsewhere.
  - PPS-008.
  - AAPS-009: goes with api-key.
- ⚑ **Worth reconsidering:**
  - **RRS-005**: zero grace window on rotation. This is a recorded design choice, but N3 and N4 show that missed delivery is common. A configurable grace window is the "richer option".
  - **PCS-004**: qadi decision cache has no TTL. A cheap opt-in `ttl` in `../qadi`.
  - **YL-003**: closed matcher DSL in qadi.
  - **MW-007**: all-or-nothing Users port shape, with no partial-adapter path.
  - **AR-002**: self-service flows aren't resumable state machines.
  - **PCS-007**: client-side decision invalidation.

---

## 8. Execution protocol (per issue or workstream)

1. **Pick** a workstream from a `programs/*.md` file, and do its canonical issue first. Read the dossier in `slices/<slice>.md`.
2. **Re-verify the evidence at current HEAD.** Lines drift, and this plan is pinned to `ec065a7`. If the evidence no longer holds, record that and close the issue.
3. **Red:** write the failing test named in the dossier (vitest under `packages/<pkg>/test/`, and a BDD scenario under `features/` when the dossier names one). Confirm that it fails for the stated reason.
4. **Green:** implement the planned steps. Respect the constraints in §2.4. Update any `spec/behaviors` BEH-EA text and `spec/traceability.md` the dossier names. New ADRs go in `spec/decisions/`; the numbers the dossiers assume (ADR-EA-017…022, BEH-EA-221…227) must be re-checked at implementation time.
5. **Gate:** targeted tests, then `pnpm run typecheck && pnpm run test && pnpm run test:bdd && pnpm run spec:verify:strict && pnpm lint && pnpm knip`. Run the full `pnpm check` before closing a program.
6. **Close:**
   - In the issue file, set `Status: resolved` and append a `**Resolved (date):**` comment with the files changed, the test names, and proof the test failed before, as in the existing resolved highs.
   - Mark each duplicate the dossier lists as resolved, pointing to the canonical issue.
   - Commit with `<imperative summary> (<ID or stem>[, …])`, matching recent history such as `ec065a7`.
7. **Regenerate** the index after a batch: rerun `python3 .plan/_manifests/aggregate.py` once `plan.json` statuses are refreshed. `slices/*.json` stays the validation snapshot; the issue files are the live state.
