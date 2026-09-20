---
ID: "AOMS-006"
Title: "Zero hook points wired into real auth flows: no Auth0 Action/Rule insertion point exists"
Level: high
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/HookPoint.ts:50"
Auditor: "auth0-okta-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AOMS-006 — Zero hook points wired into real auth flows: no Auth0 Action/Rule insertion point exists

`HIGH` · `architecture` · `core` · reported by **Auth0/Okta Migration Specialist** (`auth0-okta-migration-specialist`)

Status: **resolved**

## Summary

Migrating off Auth0 means re-creating every login-affecting Rule/Action (email-domain allow-lists, subscription gates, provisioning webhooks, claims enrichment) as explicit code. The mechanism for that is real and well-typed (veto/observe/divert with frozen ordering), but the header admits no point is wired into any real signUp/signIn/session-issue path — only tests exercise it directly. The cross-checked spec (spec/behaviors/12-hooks.md BEH-EA-093) names BeforeSessionIssue as the canonical divert point with the two-factor worked example; none of it runs in production flows today. Concretely: there is currently no supported way to reproduce even the persona's canonical 'only allow login if the user has an active subscription' Rule, nor to route it into qadi where it belongs.

## Evidence

Source: `packages/core/src/HookPoint.ts:50`

```
// Also scoped smaller in not yet wiring any concrete hook point into
// `Users.ts`/`Sessions.ts`'s real `signUp`/`signIn` flows (BEH-EA-090's
// `BeforeSignUp`, BEH-EA-092's `AfterSignIn`) — `AuthCore`, the fixed tuple
```

## Recommended fix

Wire BeforeSignUp/AfterSignIn/BeforeSessionIssue into the real password and OAuth flows as the next core change (the header names AuthCore as the prerequisite); until then, publish an explicit 'hooks are mechanism-only' notice so migration planners do not assume Actions parity.

## Context

- Auditor verdict on this domain: **needs-work** (score 54/100), domain: IdP Migration Readiness
- Full dossier: [`auth0-okta-migration-specialist`](../../.reports/auth0-okta-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-004` — Password sign-in declares no divert hook point — the exact enabler the challenge flow needs](high/BCR-004-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`BE-005` — Core lifecycle hook points are declared but never fired by signUp/signIn](medium/BE-005-bereket-engida.md) `_(bereket-engida, medium)_`
- [`CSG-002` — BeforeUserDelete hook point relied on by spec and BDD does not exist in code](high/CSG-002-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`ECF-006` — HookPoint.observe runs taps with concurrency "unbounded", making declared tap order advisory only](low/ECF-006-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`ELC-001` — HookPoint tap registry is module-scoped mutable state, contradicting the codebase's own per-composition service convention](medium/ELC-001-effect-layer-context-architect.md) `_(effect-layer-context-architect, medium)_`
- [`ERS-005` — Hook-point taps run with unbounded concurrency, making tap order cosmetic](low/ERS-005-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, low)_`
- [`GC-006` — Module-level mutable tap-sequence counter contradicts the scoped-registry convention](low/GC-006-giulio-canti.md) `_(giulio-canti, low)_`
- [`GC-009` — Hook point input schemas are phantom witnesses, never decoded](info/GC-009-giulio-canti.md) `_(giulio-canti, info)_`
- … 14 more findings touch `packages/core/src/HookPoint.ts`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [Hook point wiring completeness across auth flows](../../.scratch/resolve-ready-for-human-findings/issues/03-hook-point-wiring-completeness.md) — new `packages/core/src/Hooks.ts` declares `BeforeSignUp`/`AfterSignIn`/`BeforeSessionIssue`/`BeforeUserDelete` and wires each directly into its owning flow (password/oauth/passkey sign-in, Users.delete), with no dependency on the not-yet-built `AuthCore` tuple. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `packages/core/src/HookPoint.ts:50-52` carries exactly the quoted comment, and a grep for `HookPoint.` in `packages/password/src`, `packages/oauth/src`, `Users.ts`, and `Sessions.ts` returns zero matches, confirming no hook point is wired into any real flow. The header itself names `AuthCore` (which does not yet exist) as the architectural prerequisite, so this is a design/architecture decision, not a mechanical patch. Status → ready-for-human.

**Resolved (2026-09-20):** Implemented exactly the design from [Hook point wiring completeness across auth flows](../../.scratch/resolve-ready-for-human-findings/issues/03-hook-point-wiring-completeness.md) (this finding's own decision ticket, which clusters `AOMS-006`/`BCR-004`/`CSG-002`/`THS-002`). The `AuthCore` blocker cited by `HookPoint.ts`'s own (now-corrected) header was stale: `packages/organization/src/OrganizationHooks.ts` already proved a module can depend on a `HookPoint` class as an ordinary `Context.Tag`, composed via `Layer.provide`/`Layer.merge`, with zero dependency on the not-yet-built `AuthCore` tuple — wiring hooks into real flows never needed to wait for it.

- New `packages/core/src/Hooks.ts`: declares all four points named across the cluster — `BeforeSignUp` (veto), `AfterSignIn` (observe), `BeforeSessionIssue` (divert, seeded with a `TwoFactorRequired` outcome — modeled as a `Schema.TaggedError` with `httpApiStatus: 401`, not the decision ticket's own illustrative `Schema.TaggedClass` snippet, since it needs to serialize over HTTP the same way every other typed `HttpApiEndpoint` error does), `BeforeUserDelete` (veto). Every field is a plain `Schema.String`, not a branded `Users.UserId` — the decision ticket's own snippet assumed `Users.UserId` was an `effect/Schema` value; it isn't (`Brand.nominal`, not `Schema.Schema`) — matching `OrganizationHooks.ts`'s own real, already-compiling precedent instead, which also means `Hooks.ts` has zero dependency on `Users.ts`, sidestepping any circularity concern entirely.
- `packages/core/src/Users.ts`: `delete_` (both `layerMemory`/`layerSql`) consults `Hooks.BeforeUserDelete` between the existence check and the actual removal, translating a veto's `HookAbort` into the wire-shaped `HookAborted` the same way `Organization.ts`'s own `veto` helper does. `layerMemory`'s single atomic `Ref.modify` had to split into read-then-hook-then-update, the decision ticket's own accepted, isolated trade-off.
- `packages/password/src/Password.ts`: `signUp` consults `BeforeSignUp` (may amend or reject) before hashing; `signIn` consults `BeforeSessionIssue` right before `sessions.issue` (diverting fails with the typed `TwoFactorRequired`) and `AfterSignIn` right after. `packages/oauth/src/OAuth.ts`'s `callback` and `packages/passkey/src/Passkey.ts`'s `authenticateVerify` consult the identical `BeforeSessionIssue`/`AfterSignIn` pair at their own sign-in-completing call sites only — never `OAuth`'s `flow.link` path (issues no new session) nor `Sessions.issue` itself (also called for admin impersonation and same-session token rotation, neither of which is "a first factor just succeeded"). Each plugin's own `*Api.ts` `error:` array grows the new outcome (`HookPoint.HookAborted` for `signUp`, `Hooks.TwoFactorRequired` for each sign-in endpoint).
- Every composition in the monorepo that builds `Users.layerMemory`/`layerSql` or any of the three plugins' own `.layer` now also provides `Hooks.HooksLive` (the four points' own default, no-tap layers) — `packages/test/src/TestAuth.ts`'s shared `MemoryPorts` covers most callers in one place; ~30 individual test/BDD-world files needed their own composition updated directly, the same scale of rollout `AuditLog.layerMemory` needed for ALF-001.
- **Breaking changes** (all acceptable per the standing directive): `PasswordApi.signUp` gains `HookPoint.HookAborted`; `PasswordApi.signIn`/`OAuthApi.callback`/`PasskeyApi.authenticateVerify` each gain `Hooks.TwoFactorRequired`; `UsersShape["delete"]` gains `HookPoint.HookAborted`. `HookPoint.ts`'s own stale header comment (naming `AuthCore` as the blocker) is deleted/corrected, as the decision ticket itself asked.
- **Out of scope**: `THS-002`'s own recommended fix additionally asks for "the missing steps test for the REQ-EA-251 scenario" in `features/features/04-cross-cutting/12-hooks.feature` — left untouched, deliberately, as part of the same BDD feature-file wiring gap `AH-003`/`BDD-002` already track as their own dedicated multi-session effort (500 of 628 scenarios never executed), not something to freelance one scenario of from inside this ticket.

TDD: 6 new tests, each in its own dedicated file — `HookPoint`'s tap registry is a shared, module-level singleton that freezes at its own first `run()` (BEH-EA-024), so a point already exercised untapped by an existing suite (or a differently-tapped test in the same module) cannot be re-tapped; `packages/organization/test/OrganizationHooks.test.ts` already established this same one-file-per-tap-scenario discipline. `packages/core/test/HooksWiring{Memory,Sql}.test.ts` prove `Users.ts`'s `BeforeUserDelete` veto for both layers; `packages/password/test/PasswordHooksSignUp.test.ts` proves `BeforeSignUp` veto+amend; `packages/password/test/PasswordHooksSignIn.test.ts` proves `BeforeSessionIssue` divert and `AfterSignIn` observe together (one tapped user diverts, another continues through, an always-failing observer never surfaces); `packages/oauth/test/OAuthHooksSignIn.test.ts` and `packages/passkey/test/PasskeyHooksSignIn.test.ts` each prove `BeforeSessionIssue` divert for their own flow. Verified genuinely load-bearing via 6 real mutations (one per call site: `Users.ts` ×2, `Password.ts` ×3, `OAuth.ts` ×1, `Passkey.ts` ×1), each confirmed to fail its corresponding test for exactly the expected reason, then reverted. Full monorepo `pnpm run typecheck` clean; `pnpm run test` green (720 passed, 7 skipped, up from 714); `pnpm run test:bdd` unaffected (same 2 pre-existing, unrelated `15-password.steps.test.ts` failures noted in prior resolutions).
