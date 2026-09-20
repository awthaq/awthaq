---
ID: "CSG-002"
Title: "BeforeUserDelete hook point relied on by spec and BDD does not exist in code"
Level: high
Category: "docs"
Status: resolved
Package: "core"
Source: "packages/core/src/HookPoint.ts:54"
Auditor: "compliance-soc2-gdpr-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSG-002 — BeforeUserDelete hook point relied on by spec and BDD does not exist in code

`HIGH` · `docs` · `core` · reported by **Compliance (SOC2/GDPR) Specialist** (`compliance-soc2-gdpr-specialist`)

Status: **resolved**

## Summary

spec/overview.md:107 lists BeforeUserDelete among the hook points it claims live in `Hooks.ts` (a file that does not exist; the actual files are HookPoint.ts/Slots.ts), and features/features/04-cross-cutting/12-hooks.feature:138-140 builds an entire scenario on Invite purging its rows 'through the tap on BeforeUserDelete'. A repo-wide grep finds BeforeUserDelete only in spec and feature docs, and HookPoint.ts's own header says no concrete flows or hook points ship yet. The plugin-side purge path that the erasure design depends on is therefore documentation-only, which over-states the control set a compliance mapping would count.

## Evidence

Source: `packages/core/src/HookPoint.ts:54`

```
// comment). What ships here is the mechanism every future hook point is
// built from, exercised directly in `test/HookPoint.test.ts` rather than
```

## Recommended fix

Either implement the concrete hook points (at minimum BeforeUserDelete, fired inside deleteUser) or annotate spec/overview.md and the feature files as design-intent-only so control coverage is not double-counted.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: Compliance & Data Protection
- Full dossier: [`compliance-soc2-gdpr-specialist`](../../.reports/compliance-soc2-gdpr-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 28 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-006` — Zero hook points wired into real auth flows: no Auth0 Action/Rule insertion point exists](high/AOMS-006-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`BCR-004` — Password sign-in declares no divert hook point — the exact enabler the challenge flow needs](high/BCR-004-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`BE-005` — Core lifecycle hook points are declared but never fired by signUp/signIn](medium/BE-005-bereket-engida.md) `_(bereket-engida, medium)_`
- [`ECF-006` — HookPoint.observe runs taps with concurrency "unbounded", making declared tap order advisory only](low/ECF-006-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`ELC-001` — HookPoint tap registry is module-scoped mutable state, contradicting the codebase's own per-composition service convention](medium/ELC-001-effect-layer-context-architect.md) `_(effect-layer-context-architect, medium)_`
- [`ERS-005` — Hook-point taps run with unbounded concurrency, making tap order cosmetic](low/ERS-005-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, low)_`
- [`GC-006` — Module-level mutable tap-sequence counter contradicts the scoped-registry convention](low/GC-006-giulio-canti.md) `_(giulio-canti, low)_`
- [`GC-009` — Hook point input schemas are phantom witnesses, never decoded](info/GC-009-giulio-canti.md) `_(giulio-canti, info)_`
- … 14 more findings touch `packages/core/src/HookPoint.ts`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [Hook point wiring completeness across auth flows](../../.scratch/resolve-ready-for-human-findings/issues/03-hook-point-wiring-completeness.md) — implement, not annotate-away: new `packages/core/src/Hooks.ts` (matching `spec/overview.md`'s existing file name) declares `BeforeUserDelete` as a real `HookPoint.veto`, fired inside `Users.ts`'s `delete_` (both layers) before the row is removed. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `spec/overview.md:107` and `features/features/04-cross-cutting/12-hooks.feature:138-148` both reference `BeforeUserDelete`, but a repo-wide grep for the identifier across `packages/**/*.ts` returns zero hits; it exists only in `spec/`, `features/`, `archive/design/plugins-as-layers.md`, and other audit files. `packages/core/src/HookPoint.ts:50-56` confirms no concrete hook point is wired into real flows yet. Whether to implement the point (with its `deleteUser` firing site) or reclassify the docs as design-intent-only is a scope decision, not a pure mechanical fix. Status → ready-for-human.

**Investigation note (2026-09-19):** while resolving the adjacent Account.ts:76 cluster (CSG-001/DRS-002/WPS-001), confirmed this finding's premise and found the reason no concrete hook point has been wired yet goes deeper than "not done": `HookPoint.veto<Self>()(id, schema)`'s registry is backed by per-class-instance closures that freeze permanently after the first `.run()` call (BEH-EA-024) — fine for a hook point instantiated fresh per composition, but a concrete point declared once in library source (as `BeforeUserDelete` would be, to be tappable by an independently-composed plugin) has no way to support different compositions wanting different tap sets; they would all collide on one frozen, shared registry. Implementing this finding well likely needs either (a) `Auth.make`'s `AuthCore`/session-account composition (MW-002) to exist first, so hook points can be instantiated per-composition and threaded to both the firing site and each plugin's own `.tap()` call, or (b) a different mechanism than the current singleton-class `HookPoint` factories. Not resolved here — flagging the real blocker for whoever picks this up next. Status unchanged: ready-for-agent.

**Resolved (2026-09-20):** Duplicate of [`AOMS-006`](AOMS-006-auth0-okta-migration-specialist.md), which carries the full resolution. Directly addresses this finding's own recommended fix's first branch ("implement the concrete hook points... at minimum `BeforeUserDelete`, fired inside `deleteUser`"): `Hooks.BeforeUserDelete` is a real `HookPoint.veto` in the new `packages/core/src/Hooks.ts` (matching `spec/overview.md:107`'s own existing file name exactly, resolving the doc/code name mismatch as a side effect), fired inside `Users.ts`'s `delete_` for both `layerMemory` and `layerSql`, verified by dedicated mutation-tested `packages/core/test/HooksWiring{Memory,Sql}.test.ts`.

On this finding's own **investigation note**: the frozen-singleton-registry concern it raised is real (confirmed empirically while writing this ticket's own tests — a second test in the same module wanting a *different* tap on an already-`run()` point dies with `HookPointFrozen`), but it is not the blocker the note feared. It does not need `AuthCore`/MW-002 or a different mechanism — `OrganizationHooks.ts` already ships this exact singleton-class shape in production, and it works correctly for its actual intended usage: **one** application composes **one** fixed tap set, once, at startup, which is exactly what a singleton registry supports. The freeze only bites *multiple, differently-tapped test compositions sharing one module load* — a testing-discipline concern (worked around here the same way `OrganizationHooks.test.ts` already does: one dedicated test file per distinct tap scenario), not a production one. `ELC-001`/`GC-006` (medium, not part of this ticket's cluster) already track the module-scoped-mutable-state design question on its own merits; this resolution neither depends on nor blocks them.
