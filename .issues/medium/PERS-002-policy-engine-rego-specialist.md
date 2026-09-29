---
ID: "PERS-002"
Title: "External-engine seam (HasCustom/CustomPredicate) receives no action and no request context"
Level: medium
Category: "architecture"
Status: resolved
Package: "qadi"
Source: "packages/qadi/node_modules/@qadi/core/src/Evaluate.ts:728"
Auditor: "policy-engine-rego-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PERS-002 — External-engine seam (HasCustom/CustomPredicate) receives no action and no request context

`MEDIUM` · `architecture` · `qadi` · reported by **Policy Engine / Rego Specialist** (`policy-engine-rego-specialist`)

Status: **resolved**

## Summary

A policy plugged in through HasCustom — the designated escape hatch (ADR-QD-055) and the realistic place an OPA-style sidecar call would live — is invoked with the subject, the optional resource, and policy.params, which is static data authored into the policy document itself. The requested action (an EvaluateOptions field, ADR-QD-018) and any per-request environment (time, IP, risk signals, tenant context) never reach the predicate; EvaluateOptions has no context field at all (Evaluate.ts:200-250). A Rego policy of even modest sophistication needs input = {subject, action, resource, context}; here an external engine can only decide on a third of that, so action- or context-dependent rules are inexpressible without smuggling state through subject attributes.

## Evidence

Source: `packages/qadi/node_modules/@qadi/core/src/Evaluate.ts:728`

```
const allowed = yield* CustomPredicate.evaluate(policy.name, subject, resource, policy.params).pipe(
```

## Recommended fix

Extend CustomPredicateShape.evaluate with the evaluation's action and an opaque caller-supplied context record, and add a context field to EvaluateOptions threaded through to custom predicates. Keep it schema-free (unknown) to avoid re-introducing the closed-vocabulary problem, but make the inputs complete.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: Policy Extension Points
- Full dossier: [`policy-engine-rego-specialist`](../../.reports/policy-engine-rego-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 28 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `qadi-upstream`. Evidence at HEAD ec065a7: `../qadi/packages/core/src/Evaluate.ts:801`. Fix: In ../qadi: pass the evaluation's action and an opaque caller context to custom predicates. (effort M). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** In ../qadi: EvaluateOptions.context (opaque, passed unread) and CustomPredicateShape.evaluate's optional fifth input {action, context, attempt} (Evaluate threads action/context through the Evaluation request; static accessor, customPredicateFromRecord, Retrying and Bounded pass it through); an evaluation carrying a context bypasses the DecisionCache (context is not in the key). ADR-QD-055 amended (rev 1.1). Test: core/test/Evaluate.test.ts 'HasCustom input (PERS-002)' x3 (red: predicate got no input). Fixed UPSTREAM in ../qadi on branch plan/audit-fixes, commit b4b9270 (not merged, not released; ../qadi's checkout was returned to main). Gates run in ../qadi: typecheck, vitest (2254 tests), tstyche, lint+house-style, spec:api, spec:verify:strict, spec:examples. Still to do in awthaq after qadi releases (0.9.0 changeset included): bump @qadi/* from ^0.7.0 and let Path A/B pass request context (ip, userAgent) into EvaluateOptions.context; awthaq's QadiLive examples should then use customPredicateFromRecordChecked.
