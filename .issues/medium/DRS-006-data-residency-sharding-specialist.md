---
ID: "DRS-006"
Title: "Cross-table transactions assume one logical database; the SqlTransaction default can silently mean no transaction"
Level: medium
Category: "correctness"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:682"
Auditor: "data-residency-sharding-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DRS-006 — Cross-table transactions assume one logical database; the SqlTransaction default can silently mean no transaction

`MEDIUM` · `correctness` · `oauth` · reported by **Data Residency & Sharding Specialist** (`data-residency-sharding-specialist`)

Status: **resolved**

## Summary

OAuth first-sign-up wraps users.create + accounts.link in one withTransaction over the single ambient client (:682-710), exactly the colocation assumption the persistence contract tells repositories to preserve (spec/behaviors/05-persistence-stratum.md:71-72: a repository MUST NOT call withTransaction itself). The SqlTransaction port (packages/ports/src/SqlTransaction.ts:39) ships a layerMemory whose withTransaction is the identity function — correct for a Ref backend, but it means 'transaction' in the type system carries no guarantee of atomicity, so any future wiring that splits users and accounts across shards (or any region-scoped deployment) fails open: OAuth sign-up would silently lose its orphan-user protection rather than fail loudly.

## Evidence

Source: `packages/oauth/src/OAuth.ts:682`

```
const created = yield* sqlTransaction
                .withTransaction(
                  Effect.gen(function* () {
```

## Recommended fix

Document the colocation invariant explicitly ('users and their accounts always share a shard/transaction domain') in spec/decisions/014 or a new ADR, and consider making SqlTransaction's identity implementation log or assert when nested writes span more than one repository, so a shard split surfaces as a design error instead of silent partial writes.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: data residency readiness
- Full dossier: [`data-residency-sharding-specialist`](../../.reports/data-residency-sharding-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-001` — Scheme-relative //host callbackURL bypasses the trusted-origin allowlist (open redirect)](high/AP-001-aaron-parecki.md) `_(aaron-parecki, high)_`
- [`AP-003` — id_token aud accepted only as an exact string; array-form audiences rejected](medium/AP-003-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-004` — Userinfo claims merged over id_token claims without the required sub equality check](medium/AP-004-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-006` — Token endpoint auth hardwired to client_secret_post; basic unsupported and discovery metadata ignored](medium/AP-006-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-008` — Provider-controlled discovery and JWKS documents consumed via unchecked casts; JWKS cache never expires](low/AP-008-aaron-parecki.md) `_(aaron-parecki, low)_`
- [`AH-002` — JWKS response cast wholesale with as unknown as and cached unvalidated](medium/AH-002-anders-hejlsberg.md) `_(anders-hejlsberg, medium)_`
- [`AGA-001` — OAuth callback rate limiting collapses to one global 20/min bucket behind any gateway or load balancer](high/AGA-001-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, high)_`
- [`AGA-005` — redirect_uri is config-derived only: spoof-proof against gateway Host headers, but silently breaks when baseUrl lags the public URL](low/AGA-005-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, low)_`
- … 65 more findings touch `packages/oauth/src/OAuth.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `persistence-colocation-invariant`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:795`. Fix: Write the colocation invariant into the spec. No runtime assertion (that would be speculative infra). (effort S). Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Spec-only, as planned: new INV-EA-017 in spec/invariants.md (users/accounts/sessions/verification_tokens share one transaction domain; any partitioning must co-locate a user with its accounts; cites OAuth JIT create+link and Password.confirmReset/BEH-EA-058), a pointer from BEH-EA-035, a spec/traceability.md row (plus test rows for the new oauth/core/server test files), and an extended SqlTransaction.layerNoop doc comment (packages/ports) stating its atomicity is per-Ref only. No runtime assertion (speculative infra). INV-EA-017 may collide with another program's new invariant number (orchestrator: renumber). spec:verify:strict passes. Also recorded in spec/README (BEH-EA-122) and packages/oauth/README the N16 SameSite=Strict landing-request limitation.
