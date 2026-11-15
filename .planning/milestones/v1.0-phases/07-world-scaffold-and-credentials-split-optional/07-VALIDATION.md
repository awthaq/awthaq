---
phase: "07"
slug: "world-scaffold-and-credentials-split-optional"
status: validated
nyquist_compliant: true
wave_0_complete: true
created: "2026-11-15"
---

# Phase 07 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Source: `07-RESEARCH.md` § Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest with `@effect/vitest` (packages); `@effect-cucumber/vitest` for `features/` (`pnpm test:bdd`) |
| **Config file** | root `vitest.config.ts` (`projects`), `features/vitest.config.ts` (LeakGuard setup file); no new config |
| **Quick run command** | `npx tsc -b tsconfig.json && npx tsc -p tsconfig.test.json && npx vitest run packages/server/test/CredentialsSurface.test.ts packages/server/test/Credentials.test.ts packages/server/test/Authentication.test.ts packages/server/test/CredentialResolvers.test.ts && npx vitest run --root features features/_guard/world-table` (192 + 1 passed, run this audit) |
| **Postgres run** | `AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq npx vitest run` (recorded in `07-BASELINE.md` "Postgres at the close") |
| **Full suite command** | `pnpm test`, `pnpm test:bdd`, then the gate list in `07-BASELINE.md` |
| **Estimated runtime** | about 10 minutes for the full phase gate; quick run under 30 s |

---

## Sampling Rate

- **After every task commit:** `npx tsc -b tsconfig.json` plus the quick run
- **After every plan wave:** `pnpm test`, `pnpm test:bdd`, the leak-guard line diff, the probe diff
- **Before `/gsd-verify-work`:** every gate in `07-BASELINE.md` at or equal to the Wave 0 baseline
- **Max feedback latency:** 30 seconds per task for the quick loop

---

## Per-Task Verification Map

| Requirement | Behavior | Test Type | Automated Command | File Exists | Status |
|-------------|----------|-----------|-------------------|-------------|--------|
| WORLD-01 | every World is classified; set on disk equals the classified set (a new World without a row turns the suite red); the table is committed with 31 rows | guard (bdd) + artifact | `npx vitest run --root features features/_guard/world-table` (1/1, this audit); `07-WORLD-TABLE.md` | `features/features/_guard/world-table.steps.test.ts`, `07-WORLD-TABLE.md` | ✅ green |
| WORLD-01 | adopters (Admin, Password, Domain) lost the inline subscriber and import `shared/EventCapture` | static (guard pins the scaffolded Worlds) | same guard case; `07-REVIEW-FIX.md` WR-02 (comment-aware scan, `captureEvents` call, import statement match) | guard | ✅ green |
| WORLD-01 | same scenario count after adoption | bdd | `pnpm test:bdd`: 40 files, 1581 passed, 44 skipped (baseline 39 / 1580 / 44 plus the guard) on SQLite and Postgres | bdd | ✅ green (recorded at close) |
| WORLD-02 | five hand-wired Worlds untouched, each header keeps `Hand-wired on purpose` | guard + diff | guard checks the header of each hand-wired World; `git diff --name-only ee8b80a1 HEAD -- <five files>` empty (this audit) | guard, command | ⚠️ partial: header is pinned, byte-identity is a one-time diff |
| WORLD-02 | no second host composer; `packages/test` untouched; scaffold calls no `AuthHost.layer` / `TestAuth.makeLayer` | diff + static | `git diff --name-only ee8b80a1 HEAD -- packages/test` empty (this audit); `07-BASELINE.md` rule 8 and path allowlist residue 0 | command | ⚠️ partial: one-time diff, no standing test (compile coupling to `TestAuth.layer` in `EventCapture.types.ts` is the only durable pin) |
| WORLD-02 | `LeakGuard` accounting unchanged | bdd | sorted `[leak-guard]` lines equal `07-LEAK-GUARD-BEFORE.txt` plus the guard line, all `apps=0 sqlClients=0` (SQLite and Postgres) | `07-LEAK-GUARD-BEFORE.txt` | ⚠️ partial: one-time before/after diff; `LeakGuard.ts` itself enforces zero leaks per file on every bdd run |
| WORLD-02 | the scaffold composes with `TestAuth.layer` and stays closed | type | `npx tsc -b tsconfig.json` (`EventCapture.types.ts`, `stillClosed`, `completeServes`; exit 0, this audit) | `EventCapture.types.ts` | ✅ green |
| WORLD-02 | omitting a required service (breach `HttpClient`, as on `DomainWorld`) is still a compile error | type (negative control + positive control) | `@ts-expect-error` on `TestAuth.serve(withoutBreachClient)`; if the gate weakens, `tsc -b` fails with an unused directive (WR-01) | `EventCapture.types.ts` | ✅ green |
| CRED-01 | export-name and shape surface identical (30 headings) | probe snapshot | `07-CRED-SURFACE-BEFORE.txt` vs `07-CRED-SURFACE-AFTER.txt` identical sha (`07-BASELINE.md` Integrity) | snapshots | ✅ green |
| CRED-01 | runtime keys of `Credentials.*` unchanged, Rotation, Scope, Resolved shapes and type-name set frozen (WR-03) | unit | `npx vitest run packages/server/test/CredentialsSurface.test.ts` (in the 192, this audit) | `packages/server/test/CredentialsSurface.test.ts` | ✅ green |
| CRED-01 | behaviour unchanged (unedited suites) | unit | `Credentials.test.ts`, `Authentication.test.ts`, `CredentialResolvers.test.ts` (192/192 with the surface test, this audit) | existing | ✅ green |
| CRED-01 | consumers compile without edits (`api-key`, `jwt`, `qadi`, `web`, `test`, `next`) | type + diff | `npx tsc -b tsconfig.json` exit 0 (this audit); `git diff --name-only ee8b80a1 HEAD -- packages/{api-key,jwt,qadi,web,test,next}` empty (this audit) | command | ✅ green (compile is standing) |
| CRED-01 | ADR-EA-042 untouched; no cycle; no knip delta | diff + gate | `git diff --name-only ee8b80a1 HEAD -- spec/decisions/042-credential-resolution-module.md` empty (this audit); `pnpm circular`; filtered `pnpm knip` (`07-BASELINE.md` rules 3, 4) | gates | ⚠️ partial: one-time diff, gates re-run at close only |
| GATE-04 | full unit and bdd on Postgres; failing list not growing | integration (Postgres) | `07-BASELINE.md` "Postgres at the close" (known intermittent 3 fired twice, third run green) | local CI image, CI confirmation open (no git remote) | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky or partial*

---

## Wave 0 Requirements

- [x] `07-BASELINE.md` recorded at the planning HEAD (both backends, leak-guard list)
- [x] `07-WORLD-TABLE.md` and the guard test, green against untouched Worlds
- [x] `CredentialsSurface.test.ts` runtime-key pin, green against the untouched file
- [x] `EventCapture.ts` and `EventCapture.types.ts` compiled before any World adopted the helper
- [x] `07-CRED-SURFACE-BEFORE.txt` (30 headings) and `07-LEAK-GUARD-BEFORE.txt`

---

## Manual-Only Verifications

None. The Postgres legs ran on the local Debian `postgres:16` container; hosted CI cannot run (no git remote), recorded as "CI confirmation open".

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 30s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** validated 2026-11-15

## Validation Audit 2026-11-15

| Metric | Count |
|--------|-------|
| Rows audited | 14 |
| Covered | 10 |
| Partial | 4 |
| Missing | 0 |
| Gaps filled by new tests | 0 |
| Escalated | 0 |

Findings (WARNING, not BLOCKER; no test added):

- **Empty-diff claims have no standing test.** Hand-wired World byte-identity, `packages/test` untouched, ADR-EA-042 untouched and the leak-guard line equality were checked by diff at close and re-run this audit (all empty or equal), but a later edit would not fail a test. A test that pins a git base would be non-durable (the base moves), so these stay phase-close checks by design. The durable halves are pinned: hand-wired headers by the guard, the compile gate by `EventCapture.types.ts`, per-file leak zero by `LeakGuard.ts`.
- The `.d.ts`-style surface snapshots (`07-CRED-SURFACE-*.txt`) are a one-time probe; the standing equivalent is `CredentialsSurface.test.ts` (runtime keys and frozen type-name set).
- Re-run this audit: `tsc -b` exit 0, `tsc -p tsconfig.test.json` exit 0 (two pre-existing TS377149 warnings in `TestingHarnessSteps.ts`, not Phase 7 files).
