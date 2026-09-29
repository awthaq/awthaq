---
ID: "PERS-007"
Title: "HasCustom name typos fail at enforcement time; no registry-policy cross-check exists"
Level: low
Category: "dx"
Status: resolved
Package: "qadi"
Source: "packages/qadi/node_modules/@qadi/core/src/CustomPredicate.ts:105"
Auditor: "policy-engine-rego-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PERS-007 — HasCustom name typos fail at enforcement time; no registry-policy cross-check exists

`LOW` · `dx` · `qadi` · reported by **Policy Engine / Rego Specialist** (`policy-engine-rego-specialist`)

Status: **resolved**

## Summary

A populated registry treats an unregistered name as a wiring mistake and fails rather than denies — the right fail-closed instinct — but the mistake is discovered only when a request traverses that node, surfacing as an EvaluationError (5xx-class at enforcement) on the hot path. Both sides of the contract are statically known at composition time: the registry table's keys and the HasCustom names in any decoded policy. A policy-engine specialist expects bundle validation to catch dangling references before rollout, the way OPA rejects bundles with undefined rule references.

## Evidence

Source: `packages/qadi/node_modules/@qadi/core/src/CustomPredicate.ts:105`

```
return registered === undefined
  ? Effect.fail(
      new CustomPredicateError({
```

## Recommended fix

Add a composition-time validator (or a debug-mode check) that walks registered policies' HasCustom names against the CustomPredicate table and reports dangling names before the first evaluation.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: Policy Extension Points
- Full dossier: [`policy-engine-rego-specialist`](../../.reports/policy-engine-rego-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 28 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`PERS-006` — Retrying wrapper re-executes custom predicates with no idempotency contract](low/PERS-006-policy-engine-rego-specialist.md) `_(policy-engine-rego-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `qadi-upstream`. Evidence at HEAD ec065a7: `../qadi/packages/core/src/CustomPredicate.ts:105`. Fix: In ../qadi: a composition-time validator for HasCustom names against the registry. (effort S). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** In ../qadi: danglingCustomPredicates(policies, table) walks policy trees (childrenOf) for HasCustom names absent from the table; customPredicateFromRecordChecked(table, policies) fails layer build with the new DanglingCustomPredicates error (Data.TaggedError, joins QadiError, ERROR_CODES ACL018, listed in spec/overview.md). Tests: core/test/CustomPredicate.test.ts 'danglingCustomPredicates / customPredicateFromRecordChecked (PERS-007)' x3 (red before). Fixed UPSTREAM in ../qadi on branch plan/audit-fixes, commit b4b9270 (not merged, not released; ../qadi's checkout was returned to main). Gates run in ../qadi: typecheck, vitest (2254 tests), tstyche, lint+house-style, spec:api, spec:verify:strict, spec:examples. Still to do in awthaq after qadi releases (0.9.0 changeset included): bump @qadi/* from ^0.7.0 and let Path A/B pass request context (ip, userAgent) into EvaluateOptions.context; awthaq's QadiLive examples should then use customPredicateFromRecordChecked.
