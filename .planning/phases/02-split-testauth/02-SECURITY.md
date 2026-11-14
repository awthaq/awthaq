---
phase: "02"
slug: split-testauth
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on (high) severity (the blocking gate)
threats_open: 0
asvs_level: 1
block_on: high
created: "2026-11-14"
---

# Phase 2 — Security (Split TestAuth)

> Per-phase security contract: threat register, accepted risks, and audit trail.
> Audited against the original with `git show d4282e31:packages/test/src/TestAuth.ts` (1869 lines) and `d4282e31:packages/test/src/internal/foundation.ts`.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| working tree -> committed planning record | 02-BASELINE.md pastes gate output (VCS status, knip file lists) into a committed file | paths and counts only |
| measuring instrument -> repo | a one-off probe reads the tree through an undeclared transitive TypeScript copy | none (never committed) |
| @awthaq/test -> third-party plugin test suites | plugin authors build contract and wire tests on `TestAuth.layer` and `runPluginContractTests` | test composition, fixed CSRF secret, cheap argon2id hasher |
| test-only fixtures -> production code | the cheap hasher and fixed CSRF secret must stay reachable only from tests | `Redacted` secret, hasher cost |
| test harness -> code under test | `signInAs` mints a real session; `csrfToken` computes an independent HMAC | session token (`Redacted`), CSRF HMAC |
| harness lifecycle -> CI leak gate | LeakGuard reads `openApps()` | open-app counter |
| facade -> package consumers | `TestAuth.*` is the only public route (`package.json` exports `.` only; `index.ts` exposes the `TestAuth` namespace) | value and type names |
| spec -> maintainers and auditors | spec and traceability cite the code that enforces a behavior | file paths |
| gate output -> phase sign-off | knip filter and allowlist decide whether noise hides an out-of-scope edit | file lists |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation / Evidence | Status |
|-----------|----------|-----------|----------|-------------|------------------------|--------|
| T-02-01 | Information disclosure | 02-BASELINE.md raw output | low | mitigate | `.planning/phases/02-split-testauth/02-BASELINE.md`, `02-SURFACE-BEFORE.txt`, `02-SURFACE-AFTER.txt`: regex scan for key/token/PEM/URL-credential/`secret =`/`password =` patterns finds only type signatures (`token: Redacted<string>`), no values. `git diff --name-only d4282e31 HEAD` touches only `.planning/`, `packages/core/test` (2), `packages/test/src` (6), `packages/test/test` (1), `spec/` (3); nothing under `.claude/`, `.reports/` or `.scratch/`. | closed |
| T-02-02 | Tampering | probe instrument and knip baseline | low | mitigate | No `.cjs`/`.mjs` added since d4282e31 (`git diff --name-only` filtered on `\.(cjs\|mjs)$` returns none). No `package.json`, `pnpm-lock.yaml`, `knip.json` or `.changeset` in the diff (`git diff --stat d4282e31 HEAD` over those paths is empty). `02-SURFACE-BEFORE.txt` has 47 entries (23 `[value]`, 24 `[type]`) and is byte-identical to `02-SURFACE-AFTER.txt` (`cmp`). | closed |
| T-02-SC | Tampering | npm/pip/cargo installs | low | accept | Accepted risk AR-02-01 below. Supported by the empty manifest/lockfile diff above: no package installed or bumped. | closed |
| T-02-03 | Information disclosure | `makeLayer` (redaction guard, undeclared-event policy) | medium | mitigate | `packages/test/src/internal/composition.ts:197` `decorate: (options.decorate ?? Layer.empty).pipe(Layer.provideMerge(GuardLive))`; `:207` `Layer.provideMerge(Layer.succeed(AuthEvents.UndeclaredEventPolicy, "die"))`; `:75` `GuardLive = RedactionGuard.layerEvents.pipe(...RedactionGuard.layer)`. Both sit inside `makeLayer` (`:178`), the single body behind every `layer` overload (`:292` `return makeLayer(built, options)`) and behind the contract `build` check (`contractRunner.ts:737,742`). Block is a contiguous verbatim move (composition.ts 183-293 = orig 318-428); multiset diff of all non-import code lines vs the original shows no changed line. `runPluginContractTests.test.ts` and `TestAuthDecorate.test.ts` green (vitest run, 34 files / 628 tests pass in `packages/test`). | closed |
| T-02-04 | Tampering | facade surface | low | mitigate | `makeLayer` is `export const` in composition.ts:178 but named in no re-export: `packages/test/src/TestAuth.ts:77-83` re-exports `TestCsrfConfig, encryption, httpClient, layer, recordModes` only; star re-export count in TestAuth.ts = 0; the only other references to `makeLayer` are `contractRunner.ts:5,737,742` (internal). `packages/test/test/TestAuthSurface.test.ts:32-58` pins the exact 23-name key array (no `makeLayer`); unedited since 5ae0ef19. | closed |
| T-02-05 | Elevation of privilege | `TestHasher`, `TestCsrfConfig` | low | mitigate | Values verbatim: `composition.ts:35-44` (`AUTH_ARGON2_MEMORY_KIB: "1024"`, `AUTH_ARGON2_ITERATIONS: "1"`, `Layer.orDie`) = orig 138-147; `composition.ts:82-85` (`secret: Redacted.make("test-auth-csrf-secret-padded-to-at-least-thirty-two-bytes")`, `allowedOrigins: []`) = orig 221-224; same single literal, no second secret. `node scripts/check-contract-tests.mjs` run in this audit: exit 0, "@awthaq/test stays dev-only". Independent grep: the 5 `packages/*/src` hits for `@awthaq/test` outside packages/test (core Observability.ts/Auth.ts, ports Mailer.ts/SmsSender.ts, web UserAgent.ts) are comments/error-message strings, no import; consumers list it under `devDependencies`. | closed |
| T-02-06 | Spoofing | `signInAs`, `csrfToken`, `csrfSetCookie` (session.ts) | low | mitigate | `packages/test/src/internal/session.ts:68-93` (`signInAs`), `:100-110` (`csrfToken`: `createHmac("sha256", key)` over `<iat>.<randomBytes(32) hex>`, `Redacted.isRedacted(secret) ? Redacted.value(secret) : secret`), `:117-140` (`csrfSetCookie`: `secure: true`, `httpOnly: false`, `sameSite: options?.sameSite ?? "strict"`, `path: "/"`). Verbatim (session.ts 32-140 = orig 430-538). Census: `SignInSeams.test.ts` regexes for `sessions.issue(` and `users.create(` count 1 each in `test/src/internal/session.ts` (`session.ts:80-81` and `:86-87`); the only two core-test edits retarget `test/src/TestAuth.ts` to `test/src/internal/session.ts` / `composition.ts` with counts unchanged. SignInSeams, RequestContextSeams, TestAuthApp/Request suites green. | closed |
| T-02-07 | Repudiation | `openAppCount` and LeakGuard | medium | mitigate | `packages/test/src/internal/appHarness.ts:113` `let openAppCount = 0`, `:114` `openApps = () => openAppCount`, `:149` `openAppCount++`, `:247` `openAppCount--`: exactly 4 occurrences, all in one module, none elsewhere in the repo. LeakGuard reads it through the facade (`features/step-definitions/shared/LeakGuard.ts:11,16` `TestAuth.openApps()`; facade `TestAuth.ts:96`). `TestAuthLifetime`, `TestAuthLazy`, `TestAuthListen` tests assert `openApps()` +1/restore: green. | closed |
| T-02-08 | Tampering | `runPluginContractTests` checks (table prefix, redaction canaries, undeclared events, records parity, Postgres parity) | medium | mitigate | `packages/test/src/internal/contractRunner.ts` is verbatim (orig 974-1103 and 1108-1856 map to new 25-154 and 157-905; no original code line absent from the new set, no new code line beyond imports): table prefix `:303-312,536-540`; redaction canary `:853-878` (`guard.assertNoLeaks` at `:868`, `RedactionLeak` handling); records parity `:399,710`; Postgres parity `:631-659` (`AWTHAQ_POSTGRES_URL`, `TestSql.parityDifferences`); undeclared-event policy reached via `makeLayer` (`:737,742`). `packages/test` tests (incl. `runPluginContractTests.test.ts`) green. The Postgres parity case cannot run without `AWTHAQ_POSTGRES_URL`; 02-05-SUMMARY.md:106 records it "not run locally" as the plan requires (code present, run deferred to `pnpm test:pg` / CI). | closed |
| T-02-09 | Tampering | facade surface | low | mitigate | Star re-export count in `packages/test/src/TestAuth.ts` = 0 (every re-export is named); `02-SURFACE-AFTER.txt` identical to `02-SURFACE-BEFORE.txt` (`cmp`); `TestAuthSurface.test.ts` has a single commit (5ae0ef19) and passes; `packages/test/src/index.ts` unchanged and exports only the `TestAuth` namespace, never `internal/*`; `package.json` `exports` is `.` only. | closed |
| T-02-10 | Repudiation | spec citations (BEH-EA-342/351-353, INV-EA-016, traceability) | low | mitigate | All 10 distinct `packages/test/src` / `@awthaq/test/src` paths cited in `spec/behaviors/25-testing-harness.md`, `spec/traceability.md`, `spec/invariants.md` match the tracked-file listing of `packages/test/src` exactly (case-sensitive; 0 misses). `bash spec/scripts/verify-traceability.sh --strict`: PASS 32, FAIL 0, SKIP 0 (run in this audit). Change History rows added: 25-testing-harness rev 1.16, invariants rev 1.10, traceability rev 1.90 (all dated 2026-11-14). | closed |
| T-02-11 | Tampering | phase-close comparison | medium | mitigate | Outcome verified rather than process re-run: `knip.json` and `.changeset/` have no diff from d4282e31; the full changed-file set (29 files) lies inside the allowlist (`.planning/`, `packages/core/test` x2, `packages/test/src` x6, `packages/test/test` x1, `spec/` x3); no manifest, lockfile or script change. The passkey intermittent and Postgres gating are recorded in 02-05-SUMMARY.md:106-107 (one re-run policy, no masking edit). | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low. Only open threats at or above `block_on: high` count toward `threats_open`.*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

### Security-relevant default comparison (moved code vs original)

Method: multiset diff (whitespace-trimmed) of every line of `TestAuth.ts` + `internal/{composition,session,appHarness,contractRunner,foundation}.ts` against the d4282e31 `TestAuth.ts` + `internal/foundation.ts`, then contiguous-range mapping of each new file to original line ranges.

| Item | Original | Now | Result |
|------|----------|-----|--------|
| Code lines present only in the new files | n/a | `export const makeLayer = <` (was `const makeLayer = <P ...>(`, generics re-wrapped over 3 lines), named re-exports, import lines, two type-only aliases in foundation.ts (`RetentionRegistryService`, `FoundationServices`) | no behavioural line added |
| Code lines present only in the original | n/a | none besides the old import block, the old `makeLayer` signature line and the two type aliases (now in foundation.ts) | nothing dropped |
| CSRF config | `TestCsrfConfig` fixed secret, `allowedOrigins: []`, spread-merged with `options.csrf` (orig 221-224, 323) | composition.ts:82-85, :189 | unchanged |
| Cookie flags (`csrfSetCookie`) | `secure: true`, `httpOnly: false`, `sameSite` default `"strict"` | session.ts:133-137 | unchanged |
| Hasher cost | argon2id `AUTH_ARGON2_MEMORY_KIB "1024"`, `AUTH_ARGON2_ITERATIONS "1"` | composition.ts:39 | unchanged |
| Redacted handling | `Redacted.make`, `isRedacted`/`value` unwrap, `token: Redacted<string>`, bearer set via `Redacted.value` | composition.ts:83, session.ts:34,101,108,118, appHarness.ts:50,173,216 | unchanged (token-count growth 12 to 14 is the two added `import * as Redacted` lines) |
| `listen` binding | `NodeHttpServer.layer(() => http.createServer(), { port: 0, host: "127.0.0.1" })`, url `http://127.0.0.1:<port>` | appHarness.ts:304,315 | unchanged, loopback only; no `0.0.0.0`/hostname literal anywhere |
| Default app origin | `http://localhost` | appHarness.ts:135 | unchanged |
| Undeclared-event policy | `"die"` | composition.ts:207 | unchanged |
| Redaction guard in every composition | `Layer.provideMerge(GuardLive)` | composition.ts:197 | unchanged |
| Env read | one `process.env["AWTHAQ_POSTGRES_URL"]` | contractRunner.ts:631 | unchanged (1 read, opt-in) |
| New secret/credential literals | n/a | none: the only secret-like literal is the pre-existing fixed CSRF test secret, already in the original | none introduced |
| Network/process/FS surface | no `fetch`, `exec`, `child_process`, `eval`, file IO | same counts (0) | unchanged |

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-02-01 | T-02-SC | No package is installed or bumped in this phase; the probe used a TypeScript copy already pinned in `pnpm-lock.yaml`. Confirmed: no `package.json`, `pnpm-lock.yaml` or `pnpm-workspace.yaml` change between d4282e31 and HEAD. Residual supply-chain risk is the pre-existing lockfile state, unchanged by this phase. | plan 02-01 threat model (disposition `accept`) | 2026-11-14 |

*Accepted risks do not resurface in future audit runs.*

---

## Unregistered Flags

None. All five SUMMARY `## Threat Flags` sections (02-01 to 02-05) state "None" and map to registered threats (T-02-01/02, 03/04, 06/07, 08/09, 10/11). No new attack surface found in the diff: no new network, auth, file or schema surface.

---

## Verification Notes and Limits

- ASVS level 1: grep-level presence checks plus the verbatim-move proof above. Not re-run in this audit: `pnpm knip`, `pnpm coverage`, `pnpm test:bdd`, `pnpm package:smoke`, `pnpm test:pg` (recorded by 02-05, cited only). Re-run in this audit: `check-contract-tests.mjs`, `verify-traceability.sh --strict` (32/0/0), `vitest run packages/test` (34 files, 628 passed, 1 expected fail), and the seam/surface suites (7 files, 63 tests).
- Postgres-only cases (`TestAuthHost.test.ts`, the contract runner's parity case) did not execute (`AWTHAQ_POSTGRES_URL` unset); the code is present and unchanged.
- The pre-existing fixed CSRF secret and `Redacted.make(...)` literal are test fixtures by design and live only in `@awthaq/test`, a dev-only package (enforced by `check-contract-tests.mjs`).

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-11-14 | 12 | 12 | 0 | gsd-security-auditor (/gsd-secure-phase 2) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-11-14
