---
ID: "TS-007"
Title: "External-policy PEP seam (HookPoint) ships as mechanism with zero real flows"
Level: low
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/HookPoint.ts:50"
Auditor: "torin-sandall"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# TS-007 — External-policy PEP seam (HookPoint) ships as mechanism with zero real flows

`LOW` · `architecture` · `core` · reported by **Torin Sandall — Co-creator of Open Policy Agent (OPA)** (`torin-sandall`)

Status: **resolved**

## Summary

The veto/observe/divert triad is the natural place an external policy engine (or qadi itself) aborts or redirects auth operations, and its failure semantics are correctly fixed at point definition — but no hook point is declared in any real flow, and a search of examples/ finds no AuthorizedSubject/SubjectExtractor/RequirePermission wiring at all. The declared integration surface is therefore unexercised end-to-end: Path A/B exist as middleware with tests, yet no application in-repo proves the whole chain (request to subject to evaluator to handler) assembles, which is where integration seams like this historically hide their first real bugs.

## Evidence

Source: `packages/core/src/HookPoint.ts:50`

```
// Also scoped smaller in not yet wiring any concrete hook point into
// `Users.ts`/`Sessions.ts`'s real `signUp`/`signIn` flows (BEH-EA-090's
// `BeforeSignUp`, BEH-EA-092's `AfterSignIn`)
```

## Recommended fix

Wire BeforeSignUp as a veto point in the core signUp flow and add an examples/ app that composes Auth + Path A + one RequirePermission endpoint; freeze no further hook API until both exist.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Authorization architecture
- Full dossier: [`torin-sandall`](../../.reports/torin-sandall/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `core-hook-point-coverage`. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:550`. Fix: Extend examples/memory-server (or add examples/qadi-path-a) to compose Auth + AuthorizedSubject/SubjectExtractor (Path A) + one RequirePermission-protected endpoint + one BeforeSignUp domain-allow-list tap, and smoke-test it. (effort M). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** examples/memory-server is now split into app.ts (the composition, no side effects; exports buildApp, main, demoCsrfSecret) and index.ts (starts it), with test/smoke.test.ts booting the very same layers in-process via HttpRouter.toWebHandler (the example's vitest project and tsconfig.test.json entry are added; run by `pnpm run test`). The smoke test proves: (1) a BeforeSignUp email-domain allow-list tap (SignUpAllowList in app.ts, installed through TestAuth's `services`, so it registers in the same per-composition registry the sign-up flow consults - ADR-EA-028) refuses `intruder@evil.test` with the typed HookAborted (403, code EMAIL_DOMAIN_NOT_ALLOWED) and creates no user, and lets `ada@example.com` through; (2) qadi Path B `RequirePermission` on GET /roles/catalog answers 403 for an anonymous caller and for a signed-in user without roles:read/manage, and 200 once `platform:admin` is assigned. The smoke test found a real defect in the example: its Path B guard was inert. SubjectResolver is a slot (a Context.Reference with a fail-closed default) that Roles.layer overrides, and the guard was built beside Roles instead of on top of it, so it read the default and refused everybody; a second `Roles.Roles.layer` in `services` had also created a second Roles instance the plugin never saw. Fixed: the guard is built with Roles.layer beneath it (the same layer reference Auth.make installs, so the graph builds one shared instance) and Roles.config is provided with provideMerge. The breach-check transport is a parameter of buildApp so the suite is hermetic (the example's default is the real FetchHttpClient; the default Password config performs a pwnedpasswords lookup on sign-up). The README curl examples used a password that the breach corpus rejects and now use another. Deviation: dossier step 1 said 'Path A + RequirePermission'; the repo's dogfood is Path B (RequirePermission resolving the subject itself), which is what is exercised.
