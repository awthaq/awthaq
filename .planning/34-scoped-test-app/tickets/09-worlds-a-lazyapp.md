---
plan: 34-scoped-test-app
ticket: 09
title: Worlds onto `lazyApp` (DeviceAuthorization, MagicLink, Jwt, Organization, Scim)
type: execute
wave: 3
depends_on: [04]
files_modified:
  - features/step-definitions/DeviceAuthorizationWorld.ts
  - features/step-definitions/MagicLinkWorld.ts
  - features/step-definitions/JwtWorld.ts
  - features/step-definitions/OrganizationWorld.ts
  - features/step-definitions/ScimWorld.ts
autonomous: true
requirements: [REQ-EA-1551]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "Each World holds one `app: TestAuth.LazyApp<Options, Handle>` and no app Ref, Option cell, close field, dispose field, finalizer or configure guard of its own"
    - "DeviceAuthorization and MagicLink pass alignStepClock instead of calling TestClock.setTime(Date.now())"
    - "Organization keeps its 'configure before signing anyone in' rule as the cell's rule (configure after the first build is a defect)"
    - "28-device-authorization, 32-magic-link, 33-email-otp, 36-jwt, 35-organization, 30-scim pass with unchanged counts; guard 0/0"
  artifacts:
    - path: features/step-definitions/DeviceAuthorizationWorld.ts
    - path: features/step-definitions/MagicLinkWorld.ts
    - path: features/step-definitions/JwtWorld.ts
    - path: features/step-definitions/OrganizationWorld.ts
    - path: features/step-definitions/ScimWorld.ts
  key_links:
    - from: "appOf / currentApp / appHandle"
      to: "LazyApp.get"
      via: "M5"
---
Status: done (uncommitted)
Blocked by: 04

<objective>
Apply recipe M5 (PLAN §4.2) to five Worlds that each hand-write a cell, a configure rule and a release idiom (§2.3 F2/F3), two of them with hand clock alignment (F4).

Purpose: one lifetime rule and one configure rule across these Worlds.

Output: five Worlds, each with one `LazyApp` field.
</objective>

<context>
@.planning/34-scoped-test-app/PLAN.md (§2.3, §4.2 M5/M7, §7 R3)
@packages/test/src/TestAuth.ts (serve, lazyApp)
@features/step-definitions/DeviceAuthorizationWorld.ts (:52-58 AppOptions, :96-106 App/startApp, :108-157 World, :159-200 configureApp/appOf/direct)
@features/step-definitions/MagicLinkWorld.ts (:135-235)
@features/step-definitions/JwtWorld.ts (:32-135)
@features/step-definitions/OrganizationWorld.ts (:110-240)
@features/step-definitions/ScimWorld.ts (:120-225)
</context>

<tasks>
<task type="auto">
  <name>Task 1 (tracer): DeviceAuthorization and MagicLink (Option cell, setTime)</name>
  <files>features/step-definitions/DeviceAuthorizationWorld.ts, features/step-definitions/MagicLinkWorld.ts</files>
  <read_first>both files in full (the regions in context)</read_first>
  <action>In each World, apply M5.
- **Cell.** `app: TestAuth.LazyApp<AppOptions, App>`, created with `yield* TestAuth.lazyApp({}, build, { name: "<World>", alignStepClock: true })`.
- **`build(options)`.** Today's `startApp` without the promise: `const app = yield* TestAuth.serve(appLayer)`, then `const ctx = yield* Effect.promise(() => app.context())`. It returns the `App` handle without `dispose`, and keeps `sentMail`/`vetoed`/`sessionOutage` in MagicLink.
- **`configureApp`.** Becomes `world.app.configure(<today's merge>)`.
- **`appOf()`.** Becomes `world.app.get`.
- **Delete** the `Option` cell, the `options` Ref, the finalizer, the `dispose` field, the configure `Effect.die` and the `TestClock.setTime(Date.now())` (now `alignStepClock`).
- **Unchanged:** `direct`/`directExit` keep providing `ctx` on the step's fiber.

Do not touch the mail capture helpers (plan 35).</action>
  <verify><automated>pnpm --filter @awthaq/features exec vitest run features/05-authentication-methods/28-device-authorization.steps.test.ts features/14-mfa-passwordless/32-magic-link.steps.test.ts features/14-mfa-passwordless/33-email-otp.steps.test.ts 2>&1 | tail -25</automated></verify>
  <acceptance_criteria>Same passed/skipped counts as before (record both); three guard lines 0/0; grep -c 'TestAuth\.app(\|\.dispose()\|close: Effect\|setTime(Date\.now' returns 0 for both files (baseline at HEAD: 3 and 3).</acceptance_criteria>
  <done>Two Worlds on the cell with aligned step clocks.</done>
</task>

<task type="auto">
  <name>Task 2: Jwt and Scim (eager cells that rebuild)</name>
  <files>features/step-definitions/JwtWorld.ts, features/step-definitions/ScimWorld.ts</files>
  <read_first>features/step-definitions/JwtWorld.ts:32-140, features/step-definitions/ScimWorld.ts:120-225</read_first>
  <action>Both build an app eagerly in `WorldLive` (`Ref.make(buildApp(DEFAULT))`) and rebuild on configure. Jwt drops the old app; Scim closes it first. Both also keep a `started` flag.

Apply M5: `build(config)` does `yield* TestAuth.serve(…)` and returns the handle without `close`. `configure` merges as today. `get` replaces `Ref.get(world.app)`. The `started` flag existed only to forbid a late configure, so delete it with its checks; the cell's defect replaces it. Keep it if anything else reads it, and say so in Comments.

Delete the `close` fields and the finalizers.</action>
  <verify><automated>pnpm --filter @awthaq/features exec vitest run features/11-jwt/36-jwt.steps.test.ts features/13-enterprise-federation/30-scim.steps.test.ts 2>&1 | tail -20</automated></verify>
  <acceptance_criteria>Same counts; guard 0/0; the gate grep returns 0 for both files (baseline at HEAD: 3 and 3).</acceptance_criteria>
  <done>Jwt and Scim on the cell.</done>
</task>

<task type="auto">
  <name>Task 3: Organization (rebuild guarded by the roster)</name>
  <files>features/step-definitions/OrganizationWorld.ts</files>
  <read_first>features/step-definitions/OrganizationWorld.ts:110-240</read_first>
  <action>Apply M5. Today `configureApp` dies only when the roster is non-empty, and otherwise rebuilds without releasing. The cell's rule is stricter: no configure after the first build. Signing anyone in builds the app, so the old rule is implied.

`build(options)` does `yield* TestAuth.serve(buildLayer(options))` and returns the handle without `close`. `currentApp` becomes `world.app.get`. Keep today's merge (config, `canImpersonate`, `hooks`) as the `configure` update. Delete the roster check, the `close` field and the finalizer. If a scenario configures after a request that made no user, it is a late configure: fix the step order or use `replace`, and record it in Comments (R3).</action>
  <verify><automated>pnpm --filter @awthaq/features exec vitest run features/10-organization/35-organization.steps.test.ts 2>&1 | tail -20</automated></verify>
  <acceptance_criteria>Same counts; guard 0/0; gate grep returns 0 (baseline at HEAD: 3).</acceptance_criteria>
  <done>Five Worlds on one cell.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm lint && pnpm knip && pnpm circular && pnpm test:bdd
</verification>

<success_criteria>
Six feature files green with unchanged counts; guard 0/0; 0 `setTime(Date.now` in these files.
</success_criteria>

## Comments

Result (uncommitted): DeviceAuthorization, MagicLink, Jwt, Organization, Scim Worlds on lazyApp. Guard 0/0 for 28-device-authorization, 32-magic-link, 33-email-otp, 36-jwt, 35-organization, 30-scim; 100 + 245 tests pass, no skips changed.
- DeviceAuthorization/MagicLink use `alignStepClock: true`; setTime gone.
- Jwt/Scim: `started` flags deleted (nothing else read them); the cell's defect replaces them. Behaviour change: the app is no longer built eagerly at World creation, but on first `get` (it was already lazy underneath).
- Organization: `OrganizationSteps.ts` read `world.options` in two Givens; now `world.app.options`. No scenario hit a late configure.
