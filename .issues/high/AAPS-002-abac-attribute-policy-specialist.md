---
ID: "AAPS-002"
Title: "Multiple AttributeResolver producers compose by silent shadowing, not merge"
Level: high
Category: "architecture"
Status: resolved
Package: "qadi"
Source: "packages/qadi/src/Resolvers.ts:54"
Auditor: "abac-attribute-policy-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AAPS-002 — Multiple AttributeResolver producers compose by silent shadowing, not merge

`HIGH` · `architecture` · `qadi` · reported by **ABAC Attribute-Based Policy Specialist** (`abac-attribute-policy-specialist`)

Status: **resolved**

## Summary

UserAttributes (qadi) and `attributes` (packages/organization/src/OrganizationQadi.ts:131) both provide the same `AttributeResolver` tag. Because qadi's tag is a plain Context.Service — not an awthaq slot with registry conflict detection — composing both, as spec/models/14-organization.md:141-143 instructs ("compose into its own QadiLive alongside the fail-closed resolver defaults"), silently drops one implementation: spec/behaviors/21 line 85 itself admits "the later-provided Layer shadows the earlier one for that tag ... the losing resolver's contribution is silently unreachable". An application that believes it evaluates `emailVerified` and `organizationCount` attributes actually evaluates whichever resolver was layered last; the other attribute resolves `undefined` and every dependent policy denies. qadi ships no combiner (only None, fromRecord, retrying, bounded wrappers), so the only correct wiring today is a hand-written dispatching resolver.

## Evidence

Source: `packages/qadi/src/Resolvers.ts:54`

```
export const UserAttributes: Layer.Layer<AttributeResolver, never, Users.Users> = Layer.effect(
  AttributeResolver,
```

## Recommended fix

Ship a fan-out combiner (e.g. `attributeResolverCombine([UserAttributes, OrganizationAttributes])` that tries producers in order and fails if all return undefined for a known attribute), or promote the resolver to an awthaq slot with Slots.override registry semantics so a second claim is at least a detectable conflict.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: ABAC attributes & policy
- Full dossier: [`abac-attribute-policy-specialist`](../../.reports/abac-attribute-policy-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AAPS-001` — reauth obligation measures session-mint age with no authenticatedAt and no discharge path](high/AAPS-001-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, high)_`
- [`AAPS-004` — One store round trip per attribute reference, no per-evaluation memoization](medium/AAPS-004-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, medium)_`
- [`ALF-001` — BEH-EA-100 unimplemented: no durable audit table exists — 24 of 25 event types are volatile memory only](high/ALF-001-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, high)_`
- [`EEM-005` — ReauthRequired typed error never crosses the wire — the documented 'confirm your password' client prompt is unimplementable](medium/EEM-005-effect-error-management-specialist.md) `_(effect-error-management-specialist, medium)_`
- [`ESS-002` — The durable audit table (BEH-EA-100, 'the record of record') does not exist — events are in-memory only](high/ESS-002-effect-stream-specialist.md) `_(effect-stream-specialist, high)_`
- [`FAMS-004` — No per-user custom-claims store; Firebase setCustomUserClaims has no qadi-routed equivalent](medium/FAMS-004-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, medium)_`
- [`TS-001` — Reauth obligation handler silently discharges a malformed obligation](medium/TS-001-torin-sandall.md) `_(torin-sandall, medium)_`
- [`TS-002` — AttributeResolver cannot express outage vs no-opinion; BEH-EA-452/453 unimplementable](medium/TS-002-torin-sandall.md) `_(torin-sandall, medium)_`
- … 1 more findings touch `packages/qadi/src/Resolvers.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/qadi/src/Resolvers.ts:54-55` and `packages/organization/src/OrganizationQadi.ts:131-132` both `Layer.effect(AttributeResolver, ...)` on the same plain qadi tag; `spec/models/14-organization.md:141-143` itself confirms this is an "honestly...unhandled case today" with "the later-provided Layer shadows the earlier one." Fixing it means choosing between an aggregating combinator or promoting the tag to an awthaq-recognized slot — a design decision the spec explicitly declines to make today. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [AttributeResolver composition/merge semantics](../../.scratch/resolve-ready-for-human-findings/issues/14-attributeresolver-composition.md) — Resolved via a new conflict-checked `attributeResolverRegistry` combinator in `packages/qadi` that indexes contributions by declared attribute name and fails composition on overlap, instead of two `AttributeResolver` Layers silently shadowing each other whole. Status → ready-for-agent.

**Resolved (2026-09-20):** Implemented the wayfinder ticket's decision exactly:

- New `packages/qadi/src/AttributeResolvers.ts`: `AttributeResolverContribution<E, R>` (`names` + `layer`), `DuplicateAttributeResolver` typed error, and `attributeResolverRegistry(contributions)` — builds each contribution's own `Layer` once in isolation via the same `Layer.build`/`Context.get` ceremony `@qadi/core`'s own `wrapService`/`wrapServiceEffect` use, indexes by declared attribute name, and fails the whole composed `Layer` with `DuplicateAttributeResolver` (naming both contributors) if two contributions claim the same name. `resolve` does an O(1) index lookup and delegates to exactly one producer — no fan-out, no per-attribute shadowing, and an attribute nobody declared resolves `undefined` (the same "no opinion" answer any single resolver already gives).
- `packages/qadi/src/Resolvers.ts`: exports `UserAttributeNames = ["email", "emailVerified", "name"]` alongside `UserAttributes`.
- `packages/organization/src/OrganizationQadi.ts`: exports `OrganizationAttributeNames = ["organizationCount", "ownedOrganizationCount"]` alongside `attributes`.
- `packages/qadi/src/index.ts`: barrel-exports the new module.

TDD (`packages/qadi/test/AttributeResolvers.test.ts`): dispatch to the correct contribution; an undeclared attribute resolves `undefined`; two contributions naming the same attribute fail composition with `DuplicateAttributeResolver` naming both; and the actual AAPS-002 scenario — composing the real `Resolvers.UserAttributes` with a second contribution answers both `email` and `organizationCount` correctly through one composed resolver, which a plain `Layer.merge`/`Layer.provide` of the two real `AttributeResolver` Layers could never do (whichever built last would silently win for both). Verified to genuinely fail: disabling the duplicate check reproduces a layer that builds successfully instead of failing. Full monorepo `pnpm run typecheck` and `pnpm run test` both green (688 passed, 7 skipped).
