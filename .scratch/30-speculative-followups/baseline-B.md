# Plan 30, ticket 21: batch-2 plan 17 verified on the merged base (R2)

Run on 2026-11-08 against `main` @ `85cf71da` (PR #46, which carried the merge of `main` into
`architecture/deepening-plans-2`, is merged; so are Wave 0's PRs #48–#52).

**Verdict: GO, no regression.** Every §2.1 Part B expectation holds and the three proof runs are green.
R1 (re-key rows sealed before ADR-EA-019 rev 1.3): **NO-GO**. The maintainer named no such environment, so
tickets 22–23 stay closed.

## §2.1 Part B

| # | Check | Expected | Observed | Holds |
|---|---|---|---|---|
| 1 | `ls packages/sql/src/Repositories.ts` | No such file | No such file | yes |
| 2 | old codec / AAD / re-seal names in `packages/*/src` | 2 lines, `SessionStoreSql.ts:115`, `:120` (`PiiCodecs`) | the same 2 lines | yes |
| 3 | `SealedColumn.column(` in `CoreSealedColumns.ts` | 6 | 6 | yes |
| 4 | `CoreSealedColumns.*` users | AccountStoreSql 5, SessionStoreSql 4, UserStoreSql 3, CoreStoresSql 2, index 2 | the same | yes |
| 5 | `runSealedColumnTests` in `CoreSealedColumns.test.ts`; listed in `test-pg.sh` | 3; `:29` | 3; `:29` | yes |
| 6 | `Deployed` / `sweepDeployed` in `SealedColumn.ts`; `sealedColumns:` declarers | `:350`, `:370`; jwt, organization, saml, two-factor, webhooks, core Auth/AuthPlugin | `:350`, `:370`; the same seven files | yes |
| 7 | ADR-EA-019 revision; BEH-EA-339 heading | 1.3; `05-persistence-stratum.md:217` | 1.3; `:248` | yes (the heading moved down: plan 15 added behaviours above it) |
| 8 | `rekey` / `previousAad` in `packages/*/src` | nothing | nothing | yes |
| 9 | what the merge changed under the sealed columns (`git diff 0d023b66^1 85cf71da --stat`) | `Encryption.ts` rewritten (effect 4.1) | `ports/src/Encryption.ts` 163 lines (83+/82−), `sql/src/SealedColumn.ts` 2 lines; `CoreSealedColumns.ts` unchanged | yes |
| 10 | release state | no tags; 0.1.0 | 0 tags; core and sql `0.1.0` | yes |

## Proof runs

- `pnpm exec vitest run packages/test/test/CoreSealedColumns.test.ts packages/sql/test/SealedColumn.test.ts`
  (SQLite, after `tsc -b`): **2 files, 50 tests passed** (29 + 21).
- Postgres: the local `awthaq-pg` container was down, so the Postgres half is CI's. `.github/workflows/check.yml`
  runs all of `pnpm check` with `AWTHAQ_POSTGRES_URL` set to a `postgres:16` service, which puts every
  `TestSql`-built suite on Postgres. Run `42444884626` on `85cf71da` is green, including
  `sql test/SealedColumn.test.ts (21 tests)` and `test test/CoreSealedColumns.test.ts (29 tests)`.
- `pnpm test:bdd` (REQ-EA-1320 included): 36 of 39 files passed locally on the first full run. The three failures were
  the known React `useInvalidate` flake, `13-events` (bounded `PubSub`) and `28-device-authorization` (RFC 8628
  fields). The last two passed alone (2 files, 58 tests). CI's `test:bdd` on `85cf71da` is green.

## R1 answer (§10 Q8)

Asked 2026-11-08: "Does any environment hold data awthaq encrypted before plan 17 changed the core encrypted
columns (ADR-EA-019 rev 1.3)?" Answer: **no such environment.** Tickets 22–23 (`SealedColumn.rekey`,
`CoreSealedColumns.previousAad`) are not built; plan 17 Q1's clean break stands.
