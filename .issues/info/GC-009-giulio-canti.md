---
ID: "GC-009"
Title: "Hook point input schemas are phantom witnesses, never decoded"
Level: info
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/HookPoint.ts:171"
Auditor: "giulio-canti"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# GC-009 — Hook point input schemas are phantom witnesses, never decoded

`INFO` · `architecture` · `core` · reported by **Giulio Canti — Creator of fp-ts and io-ts** (`giulio-canti`)

Status: **resolved**

## Summary

The `Schema.Schema<Input>` argument exists only to carry the static type into the service class and is explicitly discarded at runtime; the header's rationale (hook input is already-typed in-process data, never unknown wire data) is sound, so this is an observation, not a defect. It does mark the deliberate edge of the codebase's decode discipline: the one abstraction where a schema value is accepted and its codec power declined, which a future plugin author may misread as precedent for accepting-and-ignoring schemas elsewhere.

## Evidence

Source: `packages/core/src/HookPoint.ts:171`

```
    void input; // type carrier only — see this module's own header comment
```

## Recommended fix

No change needed now; if hook points ever guard an externally-originated operation, decode at `run` using the already-passed schema rather than adding a second validation path.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: functional design
- Full dossier: [`giulio-canti`](../../.reports/giulio-canti/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `hook-run-semantics`. Duplicate of `JH-004` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/HookPoint.ts:197`. Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `JH-004-jared-hanson` — closed by its fix (see that issue's Resolved comment).
