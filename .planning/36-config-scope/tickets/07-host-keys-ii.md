---
plan: 36-config-scope
ticket: 07
title: "Host-level keys II: SecuritySignals, RateLimiter, BodyLimit, SealedColumn, SubjectApi"
type: execute
wave: 2
depends_on: ["04"]
files_modified:
  - packages/core/src/SecuritySignals.ts
  - packages/ports/src/RateLimiter.ts
  - packages/server/src/BodyLimit.ts
  - packages/sql/src/SealedColumn.ts
  - packages/qadi/src/SubjectApi.ts
autonomous: true
requirements: [REQ-EA-1572, REQ-EA-1573]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "The five keys are declared Tenant.perDeployment next to their references"
    - "SecuritySignals.config, RateLimiter.config, BodyLimit.config and SubjectApi.config return the declaration's layer"
    - "Build reads go through Tenant.inForce; SubjectApi's handler read stays ambient"
    - "BodyLimit's descriptor is made from its declaration"
  artifacts:
    - path: "packages/ports/src/RateLimiter.ts"
      provides: "RateLimiterConfigScoped"
  key_links:
    - from: "BodyLimit.descriptor"
      to: "BodyLimitConfigScoped"
      via: "ConfigDescriptor.make(declaration)"
      pattern: "make\\(BodyLimitConfigScoped"
---
Status: done (uncommitted)
Blocked by: 04; Q2 answered or at its default (SubjectApiConfig per deployment)

<objective>
Declare the remaining host-level keys (PLAN.md §2.3 rows 25–29) per deployment and mark their constructors.
Purpose: completes G1 for the keys outside plugins.
Output: five edited modules in five packages (one line of change each, plus reads).
</objective>

<context>
@.planning/36-config-scope/PLAN.md (§2.3 rows 25-29, §3.5)
@packages/core/src/SecuritySignals.ts (lines 170-215)
@packages/ports/src/RateLimiter.ts (lines 140-170)
@packages/server/src/BodyLimit.ts (lines 40-90)
@packages/sql/src/SealedColumn.ts (lines 95-105, 180-190)
@packages/qadi/src/SubjectApi.ts (lines 70-110)
</context>

<tasks>
<task type="auto">
  <name>Task 1: declarations and constructors</name>
  <files>packages/core/src/SecuritySignals.ts, packages/ports/src/RateLimiter.ts, packages/server/src/BodyLimit.ts, packages/sql/src/SealedColumn.ts, packages/qadi/src/SubjectApi.ts</files>
  <read_first>each file at the lines in context</read_first>
  <action>Add `<Key>Scoped = Tenant.perDeployment(<Key>)` next to each reference (`RateLimiter.ts` is inside ports: import from `./Tenant.ts`). Make `SecuritySignals.config` (`:177`), `RateLimiter.config` (`:148`), `BodyLimit.config` (`:49`) and `SubjectApi.config` (`:82`) return the declaration's `layer`. `SealedColumnConfig` has no constructor; declare it only. Make `BodyLimit.descriptor` (`:57`) from `BodyLimitConfigScoped`.</action>
  <verify><automated>pnpm build && npx tsc -p tsconfig.test.json</automated></verify>
  <acceptance_criteria>
    - `grep -c "Tenant.perDeployment(\|perDeployment(" packages/core/src/SecuritySignals.ts packages/ports/src/RateLimiter.ts packages/server/src/BodyLimit.ts packages/sql/src/SealedColumn.ts packages/qadi/src/SubjectApi.ts` totals 5 (baseline 0)
  </acceptance_criteria>
  <done>Five declarations, four marked constructors, one declaration-based descriptor.</done>
</task>

<task type="auto">
  <name>Task 2: route build reads</name>
  <files>packages/core/src/SecuritySignals.ts, packages/ports/src/RateLimiter.ts, packages/server/src/BodyLimit.ts, packages/sql/src/SealedColumn.ts</files>
  <read_first>the read sites: SecuritySignals.ts:211, RateLimiter.ts:167, BodyLimit.ts:82, SealedColumn.ts:186</read_first>
  <action>Replace each build read with the accessor (`yield* yield* Tenant.inForce(<Key>Scoped)`, or bind the inner effect and yield it once). Leave `SubjectApi.ts:108` (a per-request handler read of a host-provided key) as an ambient read with a one-line comment (PLAN.md §1.4).</action>
  <verify><automated>npx vitest run packages/core/test/SecuritySignals.test.ts packages/ports/test/RateLimiter.test.ts packages/server/test/BodyLimit.test.ts packages/sql/test/SealedColumn.test.ts packages/qadi/test/SubjectApi.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -rnE 'yield\* *(SecuritySignalsConfig|RateLimiterConfig|BodyLimitConfig|SealedColumnConfig)\b' packages/core/src packages/ports/src packages/server/src packages/sql/src | wc -l` prints 0 (baseline 4)
  </acceptance_criteria>
  <done>Every build read of these keys goes through the accessor.</done>
</task>
</tasks>

<verification>
pnpm build
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
Raw build reads 4 → 0; five declarations; gate green.
</success_criteria>

## Comments

Result: five keys declared perDeployment; four configs return `.layer`; BodyLimit.descriptor made from BodyLimitConfigScoped; build reads via the accessor; SubjectApi handler read stays ambient (commented). Tests green.
