---
plan: 36-config-scope
ticket: 02
title: "Pin today's per-scope behaviour: deployment-scoped plugins ignore a calling-fiber override, Webhooks honours one"
type: tdd
wave: 0
depends_on: []
files_modified:
  - packages/magic-link/test/MagicLink.test.ts
  - packages/magic-link/test/EmailOtp.test.ts
  - packages/webhooks/test/WebhooksTenant.test.ts
autonomous: true
requirements: [REQ-EA-1575, REQ-EA-1576]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "A calling-fiber MagicLink.config({ allowSignUp: false }) does not stop a link being mailed to an unknown address when the build value allows sign-up"
    - "The same holds for EmailOtp.config({ allowSignUp: false })"
    - "A calling-fiber Webhooks.config({ maxEndpoints: 1 }) limits createEndpoint in that fiber; a fiber without it is not limited"
  artifacts:
    - path: "packages/magic-link/test/MagicLink.test.ts"
      provides: "deployment-scope pin"
    - path: "packages/webhooks/test/WebhooksTenant.test.ts"
      provides: "tenant-scope pin for webhooks"
  key_links:
    - from: "MagicLink pin"
      to: "packages/magic-link/src/MagicLink.ts:198,230"
      via: "the build-time capture the pin relies on"
      pattern: "allowSignUp"
---
Status: done (uncommitted)
Blocked by: none

<objective>
Pin, at HEAD and unchanged through the migration, that deployment-scoped plugins ignore a configuration provided in the calling fiber, and that Webhooks (the one tenant-scoped plugin with no such pin, PLAN.md §2.5, F7) honours one.
Purpose: Wave 2 reroutes every read; these pins catch a scope that flips by accident.
Output: three passing cases. They are not red: they describe today's correct behaviour.
</objective>

<context>
@.planning/36-config-scope/PLAN.md (§2.5, §5.2)
@packages/magic-link/test/MagicLink.test.ts (lines 40-85: the sign-up-off case and its mail assertions)
@packages/magic-link/test/EmailOtp.test.ts (line 70)
@packages/magic-link/test/support (buildLayer)
@packages/webhooks/test/WebhooksTenant.test.ts (lines 150-165)
@packages/webhooks/test/support.ts (adminLayer, line 170)
</context>

<tasks>
<task type="tdd">
  <name>Task 1: magic link and email OTP ignore a calling-fiber override</name>
  <files>packages/magic-link/test/MagicLink.test.ts, packages/magic-link/test/EmailOtp.test.ts</files>
  <read_first>packages/magic-link/test/MagicLink.test.ts lines 1-90; packages/magic-link/test/EmailOtp.test.ts lines 40-80</read_first>
  <behavior>
    - MagicLink: `buildLayer()` (sign-up on by default). `requestLink({ email: "stranger@example.com" })` piped through `Effect.provide(MagicLink.config({ allowSignUp: false }))`. After `awaitMails(mailer.sent, 1)`, one `magic-link` mail went to the stranger: the deployment-scoped value applied, the calling fiber's did not.
    - EmailOtp: the same shape with `EmailOtp.config({ allowSignUp: false })` and the OTP request operation the file's sign-up-off case uses.
  </behavior>
  <action>Add one case to each file, named "ADR-EA-018 D8 (plan 36): magic link configuration is per deployment; a calling-fiber override is not read" and the email OTP equivalent. Reuse each file's existing helpers (`buildLayer`, `awaitMails`, `letForkedFibersRun`, `TestAuth.withoutRequest`). Do not touch the existing sign-up-off cases. If plan 35 has replaced the mailbox helpers when this runs, use whatever the suite's current mail observation is.</action>
  <verify><automated>npx vitest run packages/magic-link/test/MagicLink.test.ts packages/magic-link/test/EmailOtp.test.ts</automated></verify>
  <acceptance_criteria>
    - Both new cases pass at HEAD
    - Changing `MagicLink.ts:230` to read a calling-fiber value (a throwaway local edit) makes the MagicLink pin fail (prove once, record in Comments, revert)
  </acceptance_criteria>
  <done>Both pins pass and are proven sensitive to a scope flip.</done>
</task>

<task type="tdd">
  <name>Task 2: Webhooks honours a calling-fiber override</name>
  <files>packages/webhooks/test/WebhooksTenant.test.ts</files>
  <read_first>packages/webhooks/test/WebhooksTenant.test.ts lines 1-60 and 150-165; packages/webhooks/test/support.ts lines 160-200</read_first>
  <behavior>
    - `adminLayer()` with the default `maxEndpoints`.
    - Under `Tenant.withTenant("org-a")` and `Effect.provide(Webhooks.config({ maxEndpoints: 1 }))` (the shape the tenant middleware produces), the first `createEndpoint` succeeds and the second fails with `WebhookEndpointLimitReached`.
    - In a fiber under `Tenant.withTenant("org-b")` with no override, two creations succeed.
  </behavior>
  <action>Add one case "EP-007 (plan 36): a tenant's Webhooks.config in the calling fiber governs its own operations". Reuse the file's `create()` helper. Note: a per-call `Webhooks.config(...)` is a whole configuration (BEH-EA-236), so `canManageWebhooks` in the override must still admit the test's administrator; pass the same predicate `adminLayer` uses (read support.ts to find it).</action>
  <verify><automated>npx vitest run packages/webhooks/test/WebhooksTenant.test.ts</automated></verify>
  <acceptance_criteria>
    - The new case passes at HEAD
    - `grep -c "plan 36" packages/webhooks/test/WebhooksTenant.test.ts` prints 1 (baseline 0)
  </acceptance_criteria>
  <done>Webhooks has a calling-fiber pin like the other nine tenant-scoped keys.</done>
</task>
</tasks>

<verification>
npx vitest run packages/magic-link/test/MagicLink.test.ts packages/magic-link/test/EmailOtp.test.ts packages/webhooks/test/WebhooksTenant.test.ts
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
Three new passing cases; the magic link pin proven sensitive to a scope flip.
</success_criteria>

## Comments
Result (uncommitted): three pins added (MagicLink.test.ts, EmailOtp.test.ts, WebhooksTenant.test.ts), all pass at HEAD. Not done: the throwaway "flip MagicLink.ts:230 to a fiber read" sensitivity proof (src edits were off-limits for this run); do it when ticket 12/13 touches that read.
