---
plan: 37-store-contract-runner
ticket: 02
title: pnpm test:pg runs every suite, as CI does
type: execute
wave: 0
depends_on: []
files_modified:
  - scripts/test-pg.sh
  - scripts/check-contract-tests.mjs
  - features/features/08-tooling/25-testing-harness.feature
  - features/step-definitions/TestingHarnessComposeSteps.ts
  - features/traceability.md
autonomous: true
requirements: [REQ-EA-1580, REQ-EA-1581]
estimate: {tasks: 3, size: S}
must_haves:
  truths:
    - "scripts/test-pg.sh names no test file"
    - "pnpm test:pg with no argument runs every vitest project and then pnpm test:bdd against AWTHAQ_POSTGRES_URL"
    - "pnpm test:pg <paths> runs only those paths"
    - "pnpm check:contract-tests fails, naming the file and scripts/test-pg.sh, when the script names a test file"
  artifacts:
    - path: "scripts/test-pg.sh"
      provides: "the local Postgres run, same scope as CI's pnpm check"
    - path: "scripts/check-contract-tests.mjs"
      provides: "rule 3: the script names no *.test.ts"
  key_links:
    - from: "scripts/check-contract-tests.mjs"
      to: "scripts/test-pg.sh"
      via: "reads the script; any trimmed line ending .test.ts is a problem"
      pattern: "test-pg.sh"
---
Status: ready-for-agent
Blocked by: none (PLAN.md §10 Q1 default A; if the human answers B or C, see Q1 before starting)

<objective>
`scripts/test-pg.sh` hard-codes 63 test files (`grep -c '\.test\.ts$' scripts/test-pg.sh` = 63 at `04fa3526`). At least 9 files that build a database through `TestSql` under `AWTHAQ_POSTGRES_URL` are missing (PLAN.md §2.4), and `packages/core/test/Users.test.ts` is listed but never touches SQL. CI does not use the list. `.github/workflows/check.yml:49-50` sets the URL for the whole job, and `pnpm check` runs every vitest project (`pnpm coverage`) and the BDD suite. So the list only narrows the local run.

Purpose: make local `pnpm test:pg` run what CI runs, and make the list impossible to bring back silently.

Output: a list-free script, rule 3 rewritten, and two BDD scenarios (REQ-EA-1580/1581) replacing the retired REQ-EA-1500/1501.
</objective>

<context>
@.planning/37-store-contract-runner/PLAN.md (§2.4, §2.5, §3.5)
@scripts/test-pg.sh
@scripts/check-contract-tests.mjs (rule 3 at lines 44-52 and 94-99)
@features/features/08-tooling/25-testing-harness.feature (lines 300-327)
@features/step-definitions/TestingHarnessComposeSteps.ts (lines 210-320)
@features/scripts/allocate-req-ea.py (header: tags are permanent; removed ids retired)
@.github/workflows/check.yml (lines 30-60)
</context>

<tasks>
  <task type="auto">
    <name>Task 1: test-pg.sh without a list</name>
    <files>scripts/test-pg.sh</files>
    <read_first>scripts/test-pg.sh; package.json scripts test, test:bdd, coverage, check</read_first>
    <action>Delete the suites array. Keep the container start block unchanged: the default port, the trap, the pg_isready loop and the URL export (docker vs podman is plan 25 Q6, not ours). After it, if the script got arguments, run pnpm exec vitest run with --testTimeout=60000 and the arguments passed through quoted. Otherwise run pnpm exec vitest run with --testTimeout=60000, then pnpm test:bdd. Keep set -euo pipefail so a vitest failure stops before BDD. Rewrite the header comment. It must say: the script runs every vitest project and the BDD suite against Postgres, the set CI's pnpm check runs with AWTHAQ_POSTGRES_URL. A suite that builds its database through TestSql (directly, through TestAuth's records "sql", RecordsContract or runPluginContractTests) runs on a per-suite schema, and the rest run unchanged. Arguments narrow the run to paths. It must keep the warning to point the URL at a scratch database. No line of the script may end in ".test.ts", including comment lines, because rule 3 reads trimmed lines.</action>
    <verify><automated>bash -n scripts/test-pg.sh &amp;&amp; test "$(grep -c '\.test\.ts$' scripts/test-pg.sh)" -eq 0 &amp;&amp; grep -q 'test:bdd' scripts/test-pg.sh &amp;&amp; grep -q '"\$@"' scripts/test-pg.sh</automated></verify>
    <acceptance_criteria>The `.test.ts` line count goes from 63 (baseline) to 0. The script parses. It passes arguments through and calls test:bdd.</acceptance_criteria>
    <done>Local test:pg has CI's scope.</done>
  </task>

  <task type="auto">
    <name>Task 2: rule 3 refuses a list</name>
    <files>scripts/check-contract-tests.mjs</files>
    <read_first>scripts/check-contract-tests.mjs whole file</read_first>
    <action>Replace rule 3. Delete the per-Contract.test.ts membership check, which is the block that pushes "passes records: … but is not listed in scripts/test-pg.sh". Add a check run once: for every trimmed line of scripts/test-pg.sh that ends with ".test.ts", push a problem naming the line and the script. It reads: "scripts/test-pg.sh names <file>: it runs every suite, as CI does; delete the list". Keep reading the script through the AWTHAQ_CONTRACT_TESTS_ROOT root, so the BDD can drive it. Rewrite the rule 3 paragraph of the header comment the same way, and cite plan 37 and BEH-EA-336. Leave rules 1, 2 and 4 untouched.</action>
    <verify><automated>node scripts/check-contract-tests.mjs</automated></verify>
    <acceptance_criteria>The check exits 0 on the repo after Task 1. Done by hand, not committed: add a line "  packages/x/test/A.test.ts" to the script and the check exits 1, naming it and scripts/test-pg.sh. Revert that edit.</acceptance_criteria>
    <done>A hand list cannot come back without failing pnpm check.</done>
  </task>

  <task type="auto">
    <name>Task 3: BDD REQ-EA-1580/1581 replace the retired 1500/1501</name>
    <files>features/features/08-tooling/25-testing-harness.feature, features/step-definitions/TestingHarnessComposeSteps.ts, features/traceability.md</files>
    <read_first>features/features/08-tooling/25-testing-harness.feature lines 296-327; features/step-definitions/TestingHarnessComposeSteps.ts lines 210-320 (runCheck, the "passes {string} to {string}" Given, the "is listed in" When, "it exits non-zero, naming {string} and {string}", "it exits zero")</read_first>
    <action>Replace the two scenarios tagged @REQ-EA-1500 and @REQ-EA-1501 under BEH-EA-336 with two new ones. @REQ-EA-1580 "A scripts/test-pg.sh that names a test file fails pnpm check": Given a plugin package whose "test/Contract.test.ts" runs the contract suite and whose "scripts/test-pg.sh" names "packages/demo/test/Contract.test.ts"; When the script "scripts/check-contract-tests.mjs" runs; Then it exits non-zero, naming "packages/demo/test/Contract.test.ts" and "scripts/test-pg.sh". @REQ-EA-1581 "The same repository passes once scripts/test-pg.sh names no test file": same Given; When "scripts/test-pg.sh" names no test file; Then it exits zero. Write the @REQ-EA tags by hand before running the allocator, so it keeps them. In the step file, change the plan-25 Given: it writes a Contract.test.ts that calls runPluginContractTests for Demo (so rule 1 passes) and a test-pg.sh whose suites list holds the named file. Replace the When "{string} is listed in {string}" with When "{string} names no test file", which writes a test-pg.sh with no .test.ts line and runs the check. Reuse "it exits non-zero, naming {string} and {string}" and "it exits zero" unchanged. Delete any step no scenario uses any more. Update the plan-25 comment above the steps to cite plan 37. Then run python3 features/scripts/allocate-req-ea.py to regenerate features/traceability.md. REQ-EA-1500/1501 are retired, never reused.</action>
    <verify><automated>python3 features/scripts/allocate-req-ea.py --check &amp;&amp; pnpm --filter @awthaq/features exec vitest run features/08-tooling/25-testing-harness.steps.test.ts &amp;&amp; ! grep -q 'REQ-EA-1500\b' features/features/08-tooling/25-testing-harness.feature</automated></verify>
    <acceptance_criteria>The feature file carries @REQ-EA-1580 and @REQ-EA-1581, and no @REQ-EA-1500/1501 (baseline: both present). The allocator check passes. The steps file passes.</acceptance_criteria>
    <done>The rule is specified by an executable scenario.</done>
  </task>
</tasks>

<threat_model>
## Where trust changes

| Crossing | Description |
|---|---|
| Developer environment to database | `AWTHAQ_POSTGRES_URL` is taken from the environment; every TestSql-backed suite runs `DROP SCHEMA … CASCADE` on its own `t_<suite>_w<n>` schema there |

## STRIDE register

| Threat ID | Category | Target | Severity | Disposition | Mitigation |
|---|---|---|---|---|---|
| T-37-01 | Tampering | `scripts/test-pg.sh` run against a non-scratch database | medium | mitigate | Header keeps "point the URL at a scratch database". `TestSql` only drops its own prefixed schemas. Running every suite instead of the list adds no new kind of statement, because the same suites already run this way in CI. Ticket 10 removes the one suite that dropped tables in the connection's default schema |
| T-37-02 | Denial of service | Local wall time of a full run | low | accept | `pnpm test:pg <paths>` narrows the run |
</threat_model>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm check:contract-tests && pnpm test:bdd
If a Postgres is reachable: AWTHAQ_POSTGRES_URL=… pnpm test:pg packages/organization/test/DecisionReads.test.ts. Otherwise the report says Postgres was unavailable.
</verification>

<success_criteria>
- `.test.ts` lines in `scripts/test-pg.sh`: 63 → 0.
- `pnpm check:contract-tests` passes, and fails on a reintroduced list entry.
- REQ-EA-1580/1581 pass; REQ-EA-1500/1501 no longer appear in `features/`.
</success_criteria>

## Comments
