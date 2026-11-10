---
plan: 31-admin-tier-gate
ticket: 10
title: "Admin contracts declare RateLimited (Q2)"
type: execute
wave: 0
depends_on: []
files_modified:
  - packages/admin/src/AdminApi.ts
  - packages/admin/src/AdminAccountsApi.ts
  - packages/admin/src/AdminTenantsApi.ts
  - packages/admin/test/AuthHttp.test.ts
  - .changeset/admin-rate-limit.md
autonomous: false
requirements: [REQ-EA-1523]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "Every admin endpoint that can answer AdminActionDenied or AdminImpersonationDenied also declares Api.RateLimited (429)"
    - "The served OpenAPI document lists a 429 response for a gated admin endpoint"
  artifacts:
    - path: "packages/admin/src/AdminApi.ts"
      contains: "Api.RateLimited"
    - path: ".changeset/admin-rate-limit.md"
      contains: "Migration:"
  key_links:
    - from: "packages/admin/src/AdminApi.ts"
      to: "packages/api (Api.RateLimited)"
      via: "error: [...gate, …] on gated endpoints"
      pattern: "RateLimited"
---
Status: ready-for-human (Q2: does admin get a throttle? If no, close this ticket as wontfix)
Blocked by: none

<objective>
Declare the 429 on admin's three contracts before ticket 11 makes the gate spend a rule.

Purpose: an `HttpApi` handler may fail only with errors its endpoint declares; declaring first keeps ticket 11 a pure wiring change. Declaring an error no handler raises yet is harmless.
Output: `Api.RateLimited` on every gated admin endpoint, an OpenAPI assertion, the changeset that covers tickets 10 and 11.
</objective>

<context>
@.planning/31-admin-tier-gate/PLAN.md (§6.6, §10 Q2)
@packages/webhooks/src/WebhooksApi.ts (line 198: `const gate = [WebhooksActionDenied, Api.RateLimited] as const` and its spread)
@packages/admin/src/AdminApi.ts (AdminGroup :256-…)
@packages/admin/src/AdminAccountsApi.ts (AdminAccountsGroup :71-…)
@packages/admin/src/AdminTenantsApi.ts (AdminTenantsGroup :83-…)
@packages/admin/test/AuthHttp.test.ts (lines 554-567, the OpenAPI case)
</context>

<tasks>
<task type="auto">
  <name>Task 1: Declare the 429</name>
  <files>packages/admin/src/AdminApi.ts, packages/admin/src/AdminAccountsApi.ts, packages/admin/src/AdminTenantsApi.ts</files>
  <read_first>packages/webhooks/src/WebhooksApi.ts, packages/admin/src/AdminApi.ts</read_first>
  <action>In each of the three files, add `Api.RateLimited` (import `Api` from `@awthaq/api` if absent) to the `error` list of every endpoint that lists `AdminActionDenied` or `AdminImpersonationDenied`. Do not add it to `stopImpersonating` (not gated). Follow the webhooks idiom only if it shortens the file (a local `const gate = [AdminActionDenied, Api.RateLimited] as const`); otherwise add the member inline. No other contract change.</action>
  <verify><automated>pnpm typecheck</automated></verify>
  <acceptance_criteria>
    - `grep -c 'RateLimited' packages/admin/src/AdminApi.ts packages/admin/src/AdminAccountsApi.ts packages/admin/src/AdminTenantsApi.ts` prints ≥ 1 per file (baseline 0, 0, 0).
    - `pnpm check:error-tags` passes.
  </acceptance_criteria>
  <done>Three contracts declare the 429 on gated endpoints.</done>
</task>

<task type="auto">
  <name>Task 2: OpenAPI assertion and changeset</name>
  <files>packages/admin/test/AuthHttp.test.ts, .changeset/admin-rate-limit.md</files>
  <read_first>packages/admin/test/AuthHttp.test.ts</read_first>
  <action>In the BEH-EA-084 OpenAPI case, decode `paths["/admin/users"]` (the `listUsers` path; confirm it in `AdminApi.ts`) far enough to assert its GET operation lists a `"429"` response. Create `.changeset/admin-rate-limit.md` with `"@awthaq/admin": minor`, the summary "Each administrator is rate limited on the `admin`, `admin.accounts` and `admin.tenants` groups (default 60 calls per minute per group, past the gate; refusals are not counted), tuned with `RateLimits.overrides`, which is read per request", and the `Migration:` line of PLAN §6.6 row 6. This changeset covers ticket 11 too.</action>
  <verify><automated>npx vitest run packages/admin/test/AuthHttp.test.ts && pnpm lint && pnpm knip && pnpm circular</automated></verify>
  <acceptance_criteria>
    - `grep -c '"429"' packages/admin/test/AuthHttp.test.ts` ≥ 1 (baseline 0).
    - `grep -c '^Migration:' .changeset/admin-rate-limit.md` → 1.
  </acceptance_criteria>
  <done>The contract change is visible and tested.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm check:error-tags
</verification>

<success_criteria>
- Gated admin endpoints declare 429; OpenAPI shows it.
</success_criteria>

## Comments
