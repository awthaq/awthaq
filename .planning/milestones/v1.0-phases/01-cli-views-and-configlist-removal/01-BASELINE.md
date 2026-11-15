# Phase 1 Gate Baseline

**HEAD at capture:** `65f9a73aebc018451e5e99467a1456353699fa5f` (branch `architecture/deepening-batch-3`)
**Captured:** 2026-11-14, on a tree where `git diff --quiet a5ab6311 -- packages/cli/src` exits 0 (no `packages/cli/src` change)
**Toolchain:** node v26.13.0, pnpm 11.20.0
**Method:** each gate run on its own from the worktree root in the order below, exit code taken from the command, wall time measured with `date +%s` around the command (whole seconds). `tsc -b` ran first because `test:bdd` and `package:smoke` read the built `lib/`.

## Gate results

| Gate | Command | Exit | Summary line printed | Wall time |
|------|---------|------|----------------------|-----------|
| tsc -b | `npx tsc -b tsconfig.json` | 0 | (no output) | 5 s |
| tests typecheck | `npx tsc -p tsconfig.test.json` | 0 | 0 `error TS`; 2 pre-existing `warning TS377149` in `features/step-definitions/TestingHarnessSteps.ts` (lines 851, 853) | 7 s |
| circular | `pnpm circular` | 0 | `$ node scripts/circular.mjs` (no findings) | 6 s |
| error tags | `pnpm check:error-tags` | 0 | `error-tags: 163 internal and 137 wire error tags, none shared` | 0 s (<1 s) |
| transactions | `pnpm check:transactions` | 0 | `check-transactions: no bare sql.withTransaction in packages/*/src` | 1 s |
| lint | `pnpm lint` | 0 | oxlint: warnings only (87 under untracked `.claude/`, 7 in `features/step-definitions/RequestContextSteps.ts`), no errors | 3 s |
| format | `pnpm format:check` | 0 | `All matched files use the correct format. ... on 1204 files` | 1 s |
| readmes | `pnpm check:readmes` | 0 | `readme-status: every package README matches its package's shipped state` | 1 s |
| workspace | `pnpm workspace:check` | 0 | `sync-workspace: 29 packages and 3 examples match every roster` | 1 s |
| bdd | `pnpm test:bdd` | 0 | Test Files 39 passed (39); Tests 1576 passed, 44 skipped (1620) | 16 s |
| unit | `pnpm test` | 0 | Test Files 409 passed, 4 skipped (413); Tests 6390 passed, 1 expected fail, 15 skipped (6406) | 98 s |
| coverage | `pnpm coverage` | 0 | Statements 91.61, Branches 85.08, Functions 86.8, Lines 92.14 (floors 89 / 83 / 84 / 90); same 6390 / 1 expected fail / 15 skipped | 105 s |
| spec | `pnpm spec:verify:strict` | 0 | `PASS: 32   FAIL: 0   SKIP: 0 (strict: skips count as failures)` | 58 s |
| knip | `pnpm knip` | **1 (pre-existing)** | `Unused files (39)` (all under untracked `.claude/`), `Unlisted dependencies (3)` | 91 s |
| package smoke | `pnpm package:smoke` | 0 | `package:smoke: PASS <pkg>` for each of the 30 packages | 81 s |

Not run locally: `Migration.postgres.test.ts` and any other Postgres-gated test (`AWTHAQ_POSTGRES_URL` unset; they are skipped inside the counts above).

Difference from the orchestrator's earlier orientation numbers: knip reports 39 unused files here, not 140. `.reports/` does not exist in this worktree (`ls .reports` fails), so the 101 `.reports/` entries of the earlier run are absent; the 39 `.claude/` entries (4 + 25 + 10) are the same as before. The three unlisted dependencies are the same. All other gates match the earlier numbers (test counts, coverage percentages, spec PASS 32); wall times differ by machine load (unit 98 s vs about 125 s, spec 58 s vs about 98 s).

## knip (raw)

Full `pnpm knip` output, exit code 1:

```text
$ knip
Unused files (39)
.claude/gsd-core/bin/check-latest-version.cjs     
.claude/gsd-core/bin/ensure-runtime-build.cjs     
.claude/gsd-core/bin/gsd-tools.cjs                
.claude/gsd-core/bin/verify-reapply-patches.cjs   
.claude/hooks/gsd-agent-isolation-guard.js        
.claude/hooks/gsd-check-update-worker.js          
.claude/hooks/gsd-check-update.js                 
.claude/hooks/gsd-config-reload.js                
.claude/hooks/gsd-context-monitor.js              
.claude/hooks/gsd-cursor-post-tool.js             
.claude/hooks/gsd-cursor-pre-tool.js              
.claude/hooks/gsd-cursor-session-start.js         
.claude/hooks/gsd-cursor-stop.js                  
.claude/hooks/gsd-cursor-subagent-start.js        
.claude/hooks/gsd-cursor-subagent-stop.js         
.claude/hooks/gsd-ensure-canonical-path.js        
.claude/hooks/gsd-path-export.js                  
.claude/hooks/gsd-prompt-guard.js                 
.claude/hooks/gsd-read-guard.js                   
.claude/hooks/gsd-read-injection-scanner.js       
.claude/hooks/gsd-secret-read-guard.js            
.claude/hooks/gsd-statusline.js                   
.claude/hooks/gsd-update-banner.js                
.claude/hooks/gsd-windsurf-pre-command.js         
.claude/hooks/gsd-windsurf-pre-write.js           
.claude/hooks/gsd-workflow-guard.js               
.claude/hooks/gsd-worktree-path-guard.js          
.claude/hooks/gsd-write-guard.js                  
.claude/hooks/managed-hooks-registry.cjs          
.claude/scripts/changeset/cli.cjs                 
.claude/scripts/changeset/github-release-notes.cjs
.claude/scripts/changeset/lint.cjs                
.claude/scripts/changeset/new.cjs                 
.claude/scripts/changeset/parse.cjs               
.claude/scripts/changeset/render.cjs              
.claude/scripts/changeset/serialize.cjs           
.claude/scripts/fix-slash-commands.cjs            
.claude/scripts/gen-capability-registry.cjs       
.claude/scripts/gen-loop-host-contract.cjs        
Unlisted dependencies (3)
@awthaq/core      packages/sql/test/fixtures/readme-quickstart.ts:2:10 
@awthaq/password  packages/sql/test/fixtures/readme-quickstart.ts:11:10
@awthaq/server    packages/sql/test/fixtures/readme-quickstart.ts:12:10
[ELIFECYCLE] Command failed with exit code 1.
```

No unused exports, no unused dependencies, nothing under `packages/` other than the three unlisted-dependency rows.

## Working tree at capture

`git status --short` (verbatim, before and after the gates; identical, the gates created no tracked or untracked paths):

```text
 M .planning/STATE.md
?? .claude/.gsd-profile
?? .claude/agents/
?? .claude/commands/
?? .claude/gsd-core/
?? .claude/gsd-file-manifest.json
?? .claude/gsd-install-state.json
?? .claude/hooks/
?? .claude/scripts/
?? .planning/config.json
?? .planning/state.json
```

`git diff --stat knip.json` (verbatim):

```text
(empty: knip.json is unmodified at capture)
```

Recorded as found; nothing was reverted or edited (STATE.md: "record it, do not fix it"; threat T-01-02).

## Phase-close comparison rule

Every gate must exit as it did here: all gates 0 except `pnpm knip`, which exits 1 for the pre-existing reasons above.

knip must report no line outside `.claude/` and `.reports/` other than the same three `Unlisted dependencies` rows, checked with:

```text
pnpm knip 2>&1 | grep -v '^\.claude/' | grep -v '^\.reports/'
```

Expected remainder: the `$ knip` banner, the `Unused files (N)` and `Unlisted dependencies (3)` headings, the three `readme-quickstart.ts` rows, and the `[ELIFECYCLE]` line. Any new unused export, unused file or unlisted/unused dependency under `packages/` is a regression. `git diff --stat knip.json` must still be empty at phase close.

Test counts at phase close may only grow (new matrix and pin cases); coverage must stay at or above the floors 89 / 83 / 84 / 90; `pnpm spec:verify:strict` must stay `PASS 32 / FAIL 0`.

`.planning/IMPLEMENTING.md`'s "~101 files under .reports/" sentence is superseded by this file.
