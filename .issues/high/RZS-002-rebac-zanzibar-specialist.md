---
ID: "RZS-002"
Title: "Revoked membership keeps deciding Allows under the canonical application-scoped decision cache, with no invalidation wiring"
Level: high
Category: "security"
Status: resolved
Package: "—"
Source: "spec/appendices/02-qadi-path-a-end-to-end.md:59"
Auditor: "rebac-zanzibar-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RZS-002 — Revoked membership keeps deciding Allows under the canonical application-scoped decision cache, with no invalidation wiring

`HIGH` · `security` · `—` · reported by **ReBAC / Zanzibar-style Specialist** (`rebac-zanzibar-specialist`)

Status: **resolved**

## Summary

@qadi/core's DecisionCache.ts (v0.7.0, lines 259-266) states the exact Zanzibar "new enough" problem: "A grant revoked only in a store this evaluation consults — an AttributeResolver value, a relationship edge, a history event — is invisible to the key, so that decision does stay cached until the cache is discarded. An application-scoped cache is therefore safe against token downgrade and unsafe against backend revocation." The repo's own canonical wiring instantiates exactly that unsafe scope: QadiLive (appendix 02, line 59) is a long-lived layer holding decisionCacheLayer({capacity: 512}) with FIFO eviction. Because OrganizationQadi.relationships answers from MembershipRecords/TeamRecords (relationship edges in the consulted store), a membership removal or role change is invisible to the cache key: the removed member's Allow keeps being served until 512 *distinct* subsequent decisions evict the entry — unbounded in time in a small deployment. The organization plugin already emits observe hooks for every mutation (OrganizationHooks.AfterRemoveMember etc., OrganizationHooks.ts:94-97), and DecisionCache exposes a clear operation, yet a repo-wide search finds zero references to DecisionCache/decisionCache/.clear under packages/ — no zookie, revision token, or invalidation subscriber exists anywhere to bound staleness.

## Evidence

Source: `spec/appendices/02-qadi-path-a-end-to-end.md:59`

```
export const QadiLive = Layer.mergeAll(EvaluationServicesNone, EvaluationIdLive, decisionCacheLayer({ capacity: 512 }))
```

## Recommended fix

Ship a first-class invalidation layer that taps the existing OrganizationHooks observe points (AfterRemoveMember, AfterUpdateMemberRole, AfterDeleteOrganization, team-membership hooks) and calls DecisionCache.clear, and make it the documented default whenever decisionCacheLayer is provided at application scope; document per-request cache scope as the safe alternative. Longer term, adopt write-token semantics in the spirit of Zanzibar zookies: membership mutations return a revision, and relationship-dependent checks can demand a minimum revision so staleness is bounded by policy rather than by eviction luck.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Relationship-based authorization
- Full dossier: [`rebac-zanzibar-specialist`](../../.reports/rebac-zanzibar-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`PCS-001` — Spec's reference wiring recommends an application-scoped decision cache with no invalidation path](high/PCS-001-permission-caching-specialist.md) `_(permission-caching-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [Qadi authorization decision-cache invalidation](../../.scratch/resolve-ready-for-human-findings/issues/12-qadi-decision-cache-invalidation.md) — the canonical reference wiring moves `decisionCacheLayer` from application scope to per-request scope (safe against both token downgrade and backend revocation, per `DecisionCache`'s own doc comment and qadi's ADR-QD-031), with an opt-in `DecisionCacheInvalidationLive` bridge in `@awthaq/qadi` for teams that still want app-scoped caching. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — spec/appendices/02-qadi-path-a-end-to-end.md:59 matches verbatim, and a repo-wide grep of `packages/` finds zero references to `DecisionCache`/`decisionCache`/`.clear`; OrganizationHooks.ts (lines 68/94/108) does define the `AfterRemoveMember`/`AfterUpdateMemberRole`/`AfterDeleteOrganization` hook points the auditor cites, but nothing consumes them for cache invalidation. Designing the invalidation layer (hook-driven clear vs. zookie/revision semantics) is an architecture decision. Status → ready-for-human.

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `qadi-decision-cache-invalidation`. Duplicate of `PCS-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `spec/appendices/02-qadi-path-a-end-to-end.md:59`. Full dossier: `.plan/slices/12-spec.md`. Status → resolved.
