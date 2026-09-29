---
ID: "NAM-002"
Title: "Auth.js signIn-callback logic has no wired landing spot: hook points are mechanism-only"
Level: high
Category: "architecture"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/HookPoint.ts:51"
Auditor: "nextauth-authjs-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NAM-002 — Auth.js signIn-callback logic has no wired landing spot: hook points are mechanism-only

`HIGH` · `architecture` · `core` · reported by **NextAuth.js/Auth.js Migration Specialist** (`nextauth-authjs-migration-specialist`)

Status: **ready-for-agent**

## Summary

The persona's core migration hazard is authorization logic buried in Auth.js `signIn`/`jwt`/`session` callbacks (e.g. blocking sign-in for unverified email domains). effect-auth's intended landing spots for that logic — veto-style hook points run inside the real flows — exist only as a tested mechanism: grep shows BeforeSignIn/BeforeSignUp/AfterSignIn appear solely in HookPoint.ts comments and test/HookPoint.test.ts; neither the password plugin's signIn (packages/password/src/Password.ts:516) nor the OAuth callback runs any hook. A migrating app's signIn-callback domain allow-list has nowhere declarative to go today and must be hand-wrapped around every flow or deferred. This silently drops exactly the embedded business logic a naive migration is famous for dropping.

## Evidence

Source: `packages/core/src/HookPoint.ts:51`

```
// `Users.ts`/`Sessions.ts`'s real `signUp`/`signIn` flows (BEH-EA-090's
// `BeforeSignUp`, BEH-EA-092's `AfterSignIn`) — `AuthCore`, the fixed tuple
// those flows would run inside, does not exist yet (`Auth.ts`'s own header
```

## Recommended fix

Land AuthCore's hook wiring (BEH-EA-089..096) so Password.signIn, OAuth.callback and Sessions.issue run BeforeSignIn/BeforeSessionIssue veto points, and add a migration note mapping Auth.js `signIn` callback returns (true/false/error) to HookAbort codes.

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: Auth.js Migration Parity
- Full dossier: [`nextauth-authjs-migration-specialist`](../../.reports/nextauth-authjs-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-006` — Zero hook points wired into real auth flows: no Auth0 Action/Rule insertion point exists](high/AOMS-006-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`BCR-004` — Password sign-in declares no divert hook point — the exact enabler the challenge flow needs](high/BCR-004-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`BE-005` — Core lifecycle hook points are declared but never fired by signUp/signIn](medium/BE-005-bereket-engida.md) `_(bereket-engida, medium)_`
- [`CSG-002` — BeforeUserDelete hook point relied on by spec and BDD does not exist in code](high/CSG-002-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`ECF-006` — HookPoint.observe runs taps with concurrency "unbounded", making declared tap order advisory only](low/ECF-006-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`ELC-001` — HookPoint tap registry is module-scoped mutable state, contradicting the codebase's own per-composition service convention](medium/ELC-001-effect-layer-context-architect.md) `_(effect-layer-context-architect, medium)_`
- [`ERS-005` — Hook-point taps run with unbounded concurrency, making tap order cosmetic](low/ERS-005-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, low)_`
- [`GC-006` — Module-level mutable tap-sequence counter contradicts the scoped-registry convention](low/GC-006-giulio-canti.md) `_(giulio-canti, low)_`
- … 14 more findings touch `packages/core/src/HookPoint.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — evidence quote matches HookPoint.ts:50-56 near-verbatim (comment states hook points are "not yet wiring any concrete hook point into Users.ts/Sessions.ts's real signUp/signIn flows"). Repo-wide grep for HookPoint usage in packages/*/src shows only RateLimits.ts, core/index.ts, organization/src/OrganizationHooks.ts, and test/src — none define/fire BeforeSignIn/BeforeSignUp/AfterSignIn; those identifiers appear only in HookPoint.ts comments and core/test/HookPoint.test.ts. Password.ts's signIn and the OAuth callback run no hook. Fix (wiring hook points into existing flows per already-named tickets BEH-EA-089..096) is a well-scoped mechanical change. Status → ready-for-agent.

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `core-hook-point-coverage`. Evidence at HEAD ec065a7: `packages/core/src/HookPoint.ts:50`. Fix: Complete the core hook-point set the spec lists: add a `BeforeSignIn` veto consulted by every sign-in-completing flow, consult `BeforeSignUp` on OAuth (and any other) first-login user creation, add `AfterSignUp`, and document the Auth.js mapping. (effort M). Full dossier: `.plan/slices/02-core-events-hooks.md`.
