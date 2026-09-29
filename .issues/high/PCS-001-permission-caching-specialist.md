---
ID: "PCS-001"
Title: "Spec's reference wiring recommends an application-scoped decision cache with no invalidation path"
Level: high
Category: "security"
Status: resolved
Package: "—"
Source: "spec/appendices/02-qadi-path-a-end-to-end.md:59"
Auditor: "permission-caching-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PCS-001 — Spec's reference wiring recommends an application-scoped decision cache with no invalidation path

`HIGH` · `security` · `—` · reported by **Permission Caching Specialist** (`permission-caching-specialist`)

Status: **resolved**

## Summary

The appendix's QadiLive is a module-scope Layer, so the decision cache lives for the whole process. The cache's own contract (packages/qadi/node_modules/@qadi/core/src/DecisionCache.ts:259-266) states the exact consequence: a grant revoked only in a store the evaluation consults (an AttributeResolver value or a relationship edge) is invisible to the key, so an application-scoped cache is 'safe against token downgrade and unsafe against backend revocation'. In awthaq that store-backed class is precisely @awthaq/organization's facts: the RelationshipResolver answers member/admin/owner/team-member from MembershipRecords/TeamRecords per check (packages/organization/src/OrganizationQadi.ts:89-113). After an admin removes a member, every hasRelationship('member')-backed Allow already in the cache keeps being served until the process restarts or someone calls clear — and nothing in the repo ever does. This is the textbook stale-privilege window the persona exists to prevent, printed as the reference wiring.

## Evidence

Source: `spec/appendices/02-qadi-path-a-end-to-end.md:59`

```
export const QadiLive = Layer.mergeAll(EvaluationServicesNone, EvaluationIdLive, decisionCacheLayer({ capacity: 512 }))
```

## Recommended fix

Change the appendix to scope decisionCacheLayer to the unit of work (per request in Path A middleware / Path B extractor), or keep app scope but pair it with a mandatory invalidation bridge (see PCS-002) and an explicit warning quoting the cache's own application-scope caveat. A one-line comment 'capacity: 512' is not a staleness budget.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: decision caching
- Full dossier: [`permission-caching-specialist`](../../.reports/permission-caching-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`RZS-002` — Revoked membership keeps deciding Allows under the canonical application-scoped decision cache, with no invalidation wiring](high/RZS-002-rebac-zanzibar-specialist.md) `_(rebac-zanzibar-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [Qadi authorization decision-cache invalidation](../../.scratch/resolve-ready-for-human-findings/issues/12-qadi-decision-cache-invalidation.md) — the canonical reference wiring moves `decisionCacheLayer` from application scope to per-request scope (safe against both token downgrade and backend revocation, per `DecisionCache`'s own doc comment and qadi's ADR-QD-031), with an opt-in `DecisionCacheInvalidationLive` bridge in `@awthaq/qadi` for teams that still want app-scoped caching. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `spec/appendices/02-qadi-path-a-end-to-end.md:59` matches the evidence verbatim, and `packages/qadi/node_modules/@qadi/core/src/DecisionCache.ts:259-266`'s own doc comment confirms an app-scoped cache is "safe against token downgrade and unsafe against backend revocation"; `packages/organization/src/OrganizationQadi.ts:89-113`'s relationship resolver answers member/admin/owner from store-backed records, matching the unsafe case exactly. Fixing this means choosing the canonical caching posture for the reference wiring (per-request scope vs. app scope paired with a mandatory invalidation bridge), which is a design decision for the spec's blessed pattern, not a mechanical edit. Status → ready-for-human.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `qadi-decision-cache-invalidation`. Evidence at HEAD ec065a7: `spec/appendices/02-qadi-path-a-end-to-end.md:59`. Fix: Implement decision ticket 12: move decisionCacheLayer to per-request scope in the canonical wiring (Path A middleware / Path B extractor), and ship an opt-in `DecisionCacheInvalidationLive` in @awthaq/qadi that taps every OrganizationHooks observe point and calls DecisionCache.clear, documented as mandatory for app-scoped caches, with the coverage caveat. (effort M). Full dossier: `.plan/slices/12-spec.md`.

**Resolved (2026-09-29):** Per-request decision cache is now the default: new packages/qadi/src/RequestDecisionCache.ts (HttpApiMiddleware RequestDecisionCache + RequestDecisionCacheLive({capacity}) providing a fresh decisionCacheLayer around each request's handler pipeline; declare last/outermost on Path A and Path B groups); opt-in packages/qadi/src/DecisionCacheInvalidation.ts DecisionCacheInvalidationLive taps every OrganizationHooks observe point (add/remove/updateRole member, accept invitation, delete org, team add/remove member, update/delete team, role CRUD) and calls DecisionCache.clear, with the coverage caveat in its doc. spec/appendices/02 (rev 1.2) no longer wires an app-scoped cache; BEH-EA-145/153/162 prose updated (no new BEH id: avoids cross-agent numbering collisions). Tests: packages/qadi/test/DecisionCacheInvalidation.test.ts (7 tests; 5 red with a stub Live returning stale Allow, green after; control test shows the stale Allow without the bridge) and RequestDecisionCache.test.ts (real HTTP: 1 lookup for 2 evaluations in a request, revocation visible on the next request). Gates: tsc -b (only pre-existing packages/react errors), tsconfig.test clean, pnpm test 827 pass, test:bdd green, spec:verify:strict PASS, oxlint clean. Not done here: AAPS-005 (user-attribute hook), README sections (folded into authz-docs-truthfulness).
