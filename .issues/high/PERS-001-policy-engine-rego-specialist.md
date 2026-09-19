---
ID: "PERS-001"
Title: "Every wired veto denial is erased into a defect, violating the typed HookAbort contract"
Level: high
Category: "architecture"
Status: resolved
Package: "organization"
Source: "packages/organization/src/Organization.ts:1050"
Auditor: "policy-engine-rego-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PERS-001 — Every wired veto denial is erased into a defect, violating the typed HookAbort contract

`HIGH` · `architecture` · `organization` · reported by **Policy Engine / Rego Specialist** (`policy-engine-rego-specialist`)

Status: **resolved**

## Summary

All 11 before*.run call sites (27 Effect.orDie occurrences in this file) pipe the veto point's run through Effect.orDie, converting the typed HookAbort into a defect. BEH-EA-090 and REQ-EA-246 require the abort to reach the caller as a structured code+message, and the BDD scenario asserts 'the failure is not a generic or untyped error'. For the policy-engine lens this is the primary externalization seam: an external policy engine plugged in as a veto tap has no way to express a structured denial — every deny surfaces as a 500-class defect indistinguishable from a crash, with no code, no policy identifier, and no client-recoverable semantics. The comment in OrganizationHooks.ts:14-22 documents this as a deliberate wire-contract-simplification tradeoff, but it silently defeats the spec guarantee that makes hook-based policy enforcement auditable.

## Evidence

Source: `packages/organization/src/Organization.ts:1050`

```
const vetoed = yield* beforeCreate.run({ callerId, name, slug }).pipe(Effect.orDie);
```

## Recommended fix

Stop erasing HookAbort at veto call sites. Either propagate it typed (add a per-operation contract error, or one shared OrganizationAborted error carrying the tap's code), or map HookAbort at the HttpApi boundary to a 403/422 with the structured code. Keep the narrow wire contract only if the abort code is still surfaced in a structured error body.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: Policy Extension Points
- Full dossier: [`policy-engine-rego-specialist`](../../.reports/policy-engine-rego-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 28 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AR-004` — Multi-tenancy is a plugin bolt-on, absent from the core identity model](medium/AR-004-aeneas-rekkas.md) `_(aeneas-rekkas, medium)_`
- [`CWM-003` — removeMember/leave delete the membership row but leave the removed user's active-organization pointer stale and never touch their session](medium/CWM-003-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, medium)_`
- [`EP-005` — No branding or custom-domain surface beyond org logo/metadata fields](medium/EP-005-eugenio-pace.md) `_(eugenio-pace, medium)_`
- [`EP-006` — Organization configuration is deployment-wide; SaaS-facing defaults fail open and unbounded](medium/EP-006-eugenio-pace.md) `_(eugenio-pace, medium)_`
- [`EP-010` — Invitations accepted from unverified emails by default](low/EP-010-eugenio-pace.md) `_(eugenio-pace, low)_`
- [`JH-001` — Typed veto HookAbort is rewritten to a defect at every real run site](high/JH-001-jared-hanson.md) `_(jared-hanson, high)_`
- [`MTI-002` — listTeams and listTeamMembers leak any organization's team structure and rosters to any authenticated user](high/MTI-002-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, high)_`
- [`MTI-004` — Organization plugin ships seven tables but zero migrations; core migrations carry zero tenant columns](high/MTI-004-multi-tenant-isolation-specialist.md) `_(multi-tenant-isolation-specialist, high)_`
- … 9 more findings touch `packages/organization/src/Organization.ts`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [HookAbort typed-veto contract enforcement](../../.scratch/resolve-ready-for-human-findings/issues/04-hookabort-veto-contract.md) — add a shared `HookPoint.HookAborted` `Schema.TaggedError` (code/message/point) in core, translate `HookAbort` into it at each veto call site instead of `Effect.orDie`, and add it to each guarded endpoint's `error:` union. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `packages/organization/src/Organization.ts:1050` matches the evidence exactly (`beforeCreate.run(...).pipe(Effect.orDie)`), and the same `Effect.orDie` pattern recurs at every veto call site in the file. `packages/organization/src/OrganizationHooks.ts:14-22` documents this as a deliberate design decision (ticket 19), which conflicts with `spec/behaviors/12-hooks.md` BEH-EA-090/REQ-EA-246's requirement that a `HookAbort` reach the caller as a structured code+message. Reconciling the plugin's already-considered simplicity trade-off against the spec's structured-error requirement is an architecture decision, not a mechanical fix. Status → ready-for-human.

**Resolved (2026-09-19):** Same fix as `JH-001` (shared root cause, same decision ticket) — see that finding's comment.
