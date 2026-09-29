---
ID: "PERS-006"
Title: "Retrying wrapper re-executes custom predicates with no idempotency contract"
Level: low
Category: "correctness"
Status: ready-for-agent
Package: "qadi"
Source: "packages/qadi/node_modules/@qadi/core/src/CustomPredicate.ts:118"
Auditor: "policy-engine-rego-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PERS-006 — Retrying wrapper re-executes custom predicates with no idempotency contract

`LOW` · `correctness` · `qadi` · reported by **Policy Engine / Rego Specialist** (`policy-engine-rego-specialist`)

Status: **ready-for-agent**

## Summary

customPredicateRetrying re-invokes the registered predicate function on CustomPredicateError under a caller schedule. A predicate backed by an external engine (a sidecar HTTP call is the intended shape) is exactly the kind of effect that can partially succeed — the remote evaluated and denied but the response timed out. Re-execution is safe only if predicates are idempotent/read-only, and neither the shape's doc comment nor the wrapper states that requirement; a predicate with its own side effect (risk-score increment, step-up registration) gets double-applied on retry with no warning.

## Evidence

Source: `packages/qadi/node_modules/@qadi/core/src/CustomPredicate.ts:118`

```
 * Wraps a registry layer so every `evaluate` call retries on
```

## Recommended fix

State the read-only/idempotent requirement on CustomPredicateShape.evaluate's contract (and in customPredicateRetrying's doc), or pass a retry-attempt/invalidation token so predicates can distinguish a fresh question from a replay.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: Policy Extension Points
- Full dossier: [`policy-engine-rego-specialist`](../../.reports/policy-engine-rego-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 28 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`PERS-007` — HasCustom name typos fail at enforcement time; no registry-policy cross-check exists](low/PERS-007-policy-engine-rego-specialist.md) `_(policy-engine-rego-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `qadi-upstream`. Evidence at HEAD ec065a7: `../qadi/packages/core/src/CustomPredicate.ts:117`. Fix: In ../qadi: state the read-only/idempotent contract and give predicates a replay signal. (effort S). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.
