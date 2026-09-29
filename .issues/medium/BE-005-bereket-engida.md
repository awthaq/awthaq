---
ID: "BE-005"
Title: "Core lifecycle hook points are declared but never fired by signUp/signIn"
Level: medium
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/HookPoint.ts:50"
Auditor: "bereket-engida"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# BE-005 — Core lifecycle hook points are declared but never fired by signUp/signIn

`MEDIUM` · `architecture` · `core` · reported by **Bereket Engida — Creator of better-auth** (`bereket-engida`)

Status: **resolved**

## Summary

The veto/observe/divert mechanism is real and Organization already uses it for its own operations, but the core user/session flows fire nothing. better-auth's databaseHooks (user.create.before, session.create.after, ...) are the primary way plugins and applications intercept the lifecycle — without fired core points, a plugin cannot observe or veto sign-up/sign-in at all, and the plugin-ecosystem story is routes-only. The mechanism being proven in one plugin while the core flows ignore it is an inconsistency worth closing before third parties build against the wrong shape.

## Evidence

Source: `packages/core/src/HookPoint.ts:50`

```
// Also scoped smaller in not yet wiring any concrete hook point into
// `Users.ts`/`Sessions.ts`'s real `signUp`/`signIn` flows (BEH-EA-090's
// `BeforeSignUp`, BEH-EA-092's `AfterSignIn`)
```

## Recommended fix

Wire the declared BeforeSignUp/AfterSignIn points into the Users/Sessions flows when AuthCore lands; until then, document that hook points are currently plugin-local (organization.*), so no one assumes core hooks are observable.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: plugin architecture parity
- Full dossier: [`bereket-engida`](../../.reports/bereket-engida/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-006` — Zero hook points wired into real auth flows: no Auth0 Action/Rule insertion point exists](high/AOMS-006-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`BCR-004` — Password sign-in declares no divert hook point — the exact enabler the challenge flow needs](high/BCR-004-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`CSG-002` — BeforeUserDelete hook point relied on by spec and BDD does not exist in code](high/CSG-002-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`ECF-006` — HookPoint.observe runs taps with concurrency "unbounded", making declared tap order advisory only](low/ECF-006-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`ELC-001` — HookPoint tap registry is module-scoped mutable state, contradicting the codebase's own per-composition service convention](medium/ELC-001-effect-layer-context-architect.md) `_(effect-layer-context-architect, medium)_`
- [`ERS-005` — Hook-point taps run with unbounded concurrency, making tap order cosmetic](low/ERS-005-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, low)_`
- [`GC-006` — Module-level mutable tap-sequence counter contradicts the scoped-registry convention](low/GC-006-giulio-canti.md) `_(giulio-canti, low)_`
- [`GC-009` — Hook point input schemas are phantom witnesses, never decoded](info/GC-009-giulio-canti.md) `_(giulio-canti, info)_`
- … 14 more findings touch `packages/core/src/HookPoint.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `None`. Already fixed by commit 3e298c8. Evidence at HEAD ec065a7: `packages/core/src/HookPoint.ts:50`. Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → resolved.
