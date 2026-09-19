---
ID: "JH-001"
Title: "Typed veto HookAbort is rewritten to a defect at every real run site"
Level: high
Category: "architecture"
Status: resolved
Package: "organization"
Source: "packages/organization/src/Organization.ts:1050"
Auditor: "jared-hanson"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# JH-001 — Typed veto HookAbort is rewritten to a defect at every real run site

`HIGH` · `architecture` · `organization` · reported by **Jared Hanson — Creator of Passport.js** (`jared-hanson`)

Status: **resolved**

## Summary

BEH-EA-090 requires a veto tap's HookAbort to be "surfaced to the caller as a typed error naming the abort's code". The organization plugin — the first and only real consumer of the hook mechanism — deliberately inverts this: its own header (OrganizationHooks.ts:16-18) states "an abort is converted to a defect (`Effect.orDie`) right where the veto runs ... never propagated as a typed contract error", and all 18 veto run sites pipe Effect.orDie. An application that taps BeforeCreateOrganization to enforce a business rule gets a 500-style defect for its trouble, not a pattern-matchable outcome; the abort's code (e.g. SLUG_FORBIDDEN) is lost to the client. This guts the headline failure-mode convention of the hook system at its only integration point, and it sets the precedent every future plugin consumer will copy.

## Evidence

Source: `packages/organization/src/Organization.ts:1050`

```
const vetoed = yield* beforeCreate.run({ callerId, name, slug }).pipe(Effect.orDie);
```

## Recommended fix

Remove Effect.orDie from veto run sites and thread a typed outcome through each operation — either add a HookAborted/{code} error to the affected contract groups or return a discriminated union (the same shape divert's DivertResult already models). If the wire contract must stay frozen, expose the abort code via a typed error envelope rather than a defect; a defect should mean a broken invariant, not a policy denial.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: plugin strategy architecture
- Full dossier: [`jared-hanson`](../../.reports/jared-hanson/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-004` — Multi-tenancy is a plugin bolt-on, absent from the core identity model](medium/AR-004-aeneas-rekkas.md) `_(aeneas-rekkas, medium)_`
- [`CWM-003` — removeMember/leave delete the membership row but leave the removed user's active-organization pointer stale and never touch their session](medium/CWM-003-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, medium)_`
- [`EP-005` — No branding or custom-domain surface beyond org logo/metadata fields](medium/EP-005-eugenio-pace.md) `_(eugenio-pace, medium)_`
- [`EP-006` — Organization configuration is deployment-wide; SaaS-facing defaults fail open and unbounded](medium/EP-006-eugenio-pace.md) `_(eugenio-pace, medium)_`
- [`EP-010` — Invitations accepted from unverified emails by default](low/EP-010-eugenio-pace.md) `_(eugenio-pace, low)_`
- [`MTI-002` — listTeams and listTeamMembers leak any organization's team structure and rosters to any authenticated user](high/MTI-002-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, high)_`
- [`MTI-004` — Organization plugin ships seven tables but zero migrations; core migrations carry zero tenant columns](high/MTI-004-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, high)_`
- [`MTI-008` — GET /organization/:organizationId serves org metadata, including free-form metadata, without any membership check](medium/MTI-008-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, medium)_`
- … 9 more findings touch `packages/organization/src/Organization.ts`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [HookAbort typed-veto contract enforcement](../../.scratch/resolve-ready-for-human-findings/issues/04-hookabort-veto-contract.md) — add a shared `HookPoint.HookAborted` `Schema.TaggedError` (code/message/point) in core, translate `HookAbort` into it at each veto call site instead of `Effect.orDie`, and add it to each guarded endpoint's `error:` union. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `packages/organization/src/Organization.ts:1050` matches verbatim, and a repo grep confirms 27 `Effect.orDie` call sites in that file, including every `beforeX.run(...)` veto hook (lines 1050, 1151, 1205, 1306, 1483, 1561, 1581, 1716, 1741, 1783, 1843). `packages/organization/src/OrganizationHooks.ts:14-21` confirms this is an explicit, documented design decision, and `spec/behaviors/12-hooks.md:44-48` (BEH-EA-090) confirms the spec does require the abort to surface as a typed error naming its code — so the documented decision genuinely conflicts with the spec's MUST. Reversing it requires deciding a typed-error contract shape threaded through 15+ endpoints (wire-contract-affecting), which is architectural judgment, not a mechanical patch. Status → ready-for-human.

**Resolved (2026-09-19):** Implemented the design recorded in [HookAbort typed-veto contract enforcement](../../.scratch/resolve-ready-for-human-findings/issues/04-hookabort-veto-contract.md): a new shared `HookPoint.HookAborted` `Schema.TaggedError` (`point`/`code`/`message`, `httpApiStatus: 403`) in `@awthaq/core`. `Organization.ts`'s new `veto(point, effect)` helper translates `HookAbort` into it at all 18 `before*.run(...)` call sites (every other `Effect.orDie` in that file — genuine DB-layer invariant violations — is untouched), each naming its own point id (e.g. `organization.create.before`). Every affected operation's error union (`OrganizationShape` in `Organization.ts`, `error:` arrays in `OrganizationApi.ts`) now declares `HookPoint.HookAborted`. Strengthened `OrganizationHooks.test.ts`'s two existing veto tests to assert the typed `_tag`/`point`/`code` instead of just "some failure happened" — verified to genuinely fail (an uncaught defect) with the fix reverted on both call sites exercised there. Full monorepo typecheck and test suite (621 tests) pass.
