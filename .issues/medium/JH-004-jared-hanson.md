---
ID: "JH-004"
Title: "Hook input schemas are required but never decoded — no runtime check at the tap boundary"
Level: medium
Category: "security"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/HookPoint.ts:29"
Auditor: "jared-hanson"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# JH-004 — Hook input schemas are required but never decoded — no runtime check at the tap boundary

`MEDIUM` · `security` · `core` · reported by **Jared Hanson — Creator of Passport.js** (`jared-hanson`)

Status: **ready-for-agent**

## Summary

Every hook point forces a Schema at declaration, which reads as a validated boundary; it is dead weight at runtime (`void input`, HookPoint.ts:171). A veto tap is an arbitrary third-party-supplied function whose return value flows unchecked into the guarded operation — Organization.ts:1053 then reads vetoed.name/vetoed.slug straight off whatever object the tap returned. For a community-plugin extension seam this is the classic unsanitized-callback-input problem Passport strategies hit: the host trusts every installed strategy's verify output. The type system covers honest TypeScript authors, not JS consumers, `as any` taps, or schema drift between point and operation.

## Evidence

Source: `packages/core/src/HookPoint.ts:29`

```
// `input` (and `divert`'s `diverted`) are accepted as `Schema.Schema`
// values purely as type carriers, matching BEH-EA-089's own
// `{ input: SignUpInput }` — never decoded here.
```

## Recommended fix

Decode tap amendments against the point's own schema inside run() (one decode per veto run is cheap), failing with a defect that names the offending tap — this also future-proofs input evolution. If the cost is unacceptable for hot paths, at minimum validate in Organization-style consumers and document taps as fully trusted host code in the authoring guide.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: plugin strategy architecture
- Full dossier: [`jared-hanson`](../../.reports/jared-hanson/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `hook-run-semantics`. Evidence at HEAD ec065a7: `packages/core/src/HookPoint.ts:29`. Fix: Validate every veto tap's returned value (and every divert tap's diverted value) against the point's own schema inside `run`, using `Schema.is` (a type guard over the already-passed schema — no decoding services, no type assertions). (effort S). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.
