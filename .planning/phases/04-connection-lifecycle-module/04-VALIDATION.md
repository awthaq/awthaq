---
phase: "04"
slug: "connection-lifecycle-module"
status: validated
nyquist_compliant: true
wave_0_complete: true
created: "2026-11-14"
---

# Phase 04 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Source: `04-RESEARCH.md` § Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest with `@effect/vitest`; Cucumber BDD (`pnpm test:bdd`) |
| **Config file** | root `vitest.config.ts` (`projects`); no new config |
| **Quick run command** | `npx tsc -b tsconfig.json && npx vitest run packages/organization/test/OrganizationConnections.test.ts packages/organization/test/DomainClaims.test.ts packages/saml/test/SamlDomainClaims.test.ts` |
| **Postgres run** | `AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq npx vitest run packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts packages/organization/test/Contract.test.ts` (Debian `postgres:16` container, same image CI uses) |
| **Full suite command** | `pnpm test`, `pnpm test:bdd`, then the gate list in `04-BASELINE.md` |
| **Estimated runtime** | about 10 minutes for the full phase gate |

---

## Sampling Rate

- **After every task commit:** `npx tsc -b tsconfig.json` plus the quick run
- **After every plan wave:** add `npx tsc -p tsconfig.test.json`, `pnpm circular`, `pnpm lint`, `pnpm format:check`, `pnpm check:transactions`, `pnpm check:error-tags`, `pnpm check:contract-tests`, the Postgres run
- **Before `/gsd-verify-work`:** the full gate list compared with the Wave 0 baseline in `04-BASELINE.md`
- **Max feedback latency:** 15 seconds per task for the quick loop

---

## Per-Task Verification Map

| Requirement | Behavior | Test Type | Automated Command | File Exists | Status |
|-------------|----------|-----------|-------------------|-------------|--------|
| CONN-02 | SAML create/update refuse a suspended organization, remove works, suspended and missing refuse with the same text | BDD (failing first) | `pnpm test:bdd` filtered to `29-saml-sp` | ❌ W0 (new rows) | ✅ green: 29-saml-sp.feature REQ-EA-1569..1572 (4 scenarios; features vitest 109/109) |
| CONN-02 | OIDC create/update refuse suspended, remove works | unit | `OrganizationConnections.test.ts` | extend | ✅ green: OrganizationConnections.test.ts (organization suite green) |
| CONN-03 | claim then row atomic; memory compensation on create, update, remove; no event for a rolled-back claim | unit (memory, SQLite) | `DomainClaims.test.ts` plus the lifecycle test | extend | ✅ green: DomainClaims.test.ts, OrganizationConnectionLifecycle.test.ts |
| CONN-03, CONN-05 | update-vs-remove outcome counts; two organizations claiming domains in opposite order | integration (Postgres) | the Postgres run | ❌ W0 (red first) | ✅ green: OrganizationConnectionLifecycle.sql.test.ts update-vs-remove race + Contract.test.ts DomainClaims [race] sql cases (543/543 on Postgres; run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)) |
| CONN-01, CONN-04 | one service and descriptor; error tags and `onTaken` byte-identical | unit plus `check:error-tags` | gate | pin in W0 | ✅ green: ConnectionLifecyclePins, SamlLifecyclePins; check:error-tags 163/137 |
| CONN-05 | `DomainClaims` not exported from the organization root; `organization` imports no SAML types | grep, `tsc -b`, `pnpm circular`, knip | scoped grep in the plan | exists | ✅ green: no root DomainClaims export (records.ts only); no-SAML grep = 2 baseline comment hits; tsc -b clean |
| CONN-04 | `SqlTransaction` taken as a service | `pnpm check:transactions` | gate | exists | ✅ green: pnpm check:transactions clean |
| CONN-06 | SCIM unchanged; orphan case recorded as a finding | `git diff --stat -- packages/scim` empty, characterization test | git | n/a | ✅ green: git diff --stat c683a1bc HEAD over scim src/package.json/README empty; ScimConnectionOrphan.test.ts passes |
| GATE-04 | Postgres verified; local run recorded, CI confirmation open | Postgres run | the Postgres run | ❌ W0 | ✅ green: Postgres run 543/543 green, local CI image, CI confirmation open |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `04-BASELINE.md` recorded at HEAD (every gate, the pin matrix, the Postgres record)
- [x] Pin tests for claim input-order, `withClaim` compensation, `onTaken` mapping, missing-vs-suspended text, deletion frees domains, no event for a rejected create, SCIM unknown-organization insert (characterization)
- [x] New scenarios in `29-saml-sp.feature` under `@BEH-EA-318` plus the "organization is suspended" step; BDD red by exactly those rows
- [x] `packages/organization/test/OrganizationConnectionLifecycle.sql.test.ts` (update-vs-remove race, opposite-order two-organization claims), red against unfixed `src`, red output recorded

---

## Manual-Only Verifications

None expected. The Postgres legs run on the local Debian `postgres:16` container; hosted CI cannot run (no git remote), so the record says "run locally on the CI image, CI confirmation open".

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 15s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** validated 2026-11-14

## Validation Audit 2026-11-14

| Metric | Count |
|---|---|
| Gaps found | 0 |
| Resolved | 0 |
| Escalated | 0 |
