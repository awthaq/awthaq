---
ID: "YL-003"
Title: "Closed matcher DSL and fixed combining algorithms cap model flexibility"
Level: medium
Category: "architecture"
Status: wontfix
Package: "—"
Source: "node_modules/.pnpm/@qadi+core@0.7.0/node_modules/@qadi/core/src/Policy.ts:90"
Auditor: "yang-luo"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# YL-003 — Closed matcher DSL and fixed combining algorithms cap model flexibility

`MEDIUM` · `architecture` · `—` · reported by **Yang Luo — Creator of Casbin** (`yang-luo`)

Status: **wontfix**

## Summary

Casbin's model file lets a deployment define its own matcher expression and effect string; qadi fixes both in code: the Matcher union is a closed 12-variant Schema (Matcher.ts:69-81) and Combining is exactly three literals (PermitOverrides being the third). Consumers cannot express priority-ordered rules, negative-rule-weighting, or a custom majority algorithm without forking the engine. The tradeoff is deliberate and defensible — total evaluation, exhaustive traces, untrusted-JSON decodability — and the HasCustom named-predicate service is a well-designed serializable escape hatch for missing leaf logic (CustomPredicate.ts:3-7), but it cannot extend composition semantics, only predicates.

## Evidence

Source: `node_modules/.pnpm/@qadi+core@0.7.0/node_modules/@qadi/core/src/Policy.ts:90`

```
export const Combining = Schema.Literals([
  "FirstApplicable",
  "DenyOverrides",
```

## Recommended fix

Keep the closed core, but consider one sanctioned extension point for rule-table semantics (e.g. a registered Combining strategy keyed by name, same shape as CustomPredicate) so new algorithms are configuration, not forks; until then, document explicitly which combining algorithms exist and why the set is closed.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: Authorization modeling
- Full dossier: [`yang-luo`](../../.reports/yang-luo/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** WONTFIX-CANDIDATE (confidence high); workstream `None`. Evidence at HEAD ec065a7: `node_modules/.pnpm/@qadi+core@0.7.0/node_modules/@qadi/core/src/Policy.ts:90`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/13-repo-features-tooling.md`.

**Wontfix (2026-09-29):** Upstream, deliberate: qadi's ADR-QD-023 fixes the combining algorithms (FirstApplicable, DenyOverrides, PermitOverrides) and the matcher set so evaluation stays total, traces stay exhaustive and policies stay decodable from untrusted JSON (a custom combiner or matcher is code, which a JSON policy cannot carry); the ADR states parity with XACML is not a goal. The auditor itself called it deliberate and defensible, and no awthaq consumer needs a custom combiner. An extension point would be new upstream API in ../qadi with its own ADR, not an awthaq defect. What a user does instead: express the model with the existing predicates (`hasCustom` predicates take the evaluation context, PERS-002) and compose policies with the three algorithms; a genuinely new algorithm is an upstream feature request against ADR-QD-023.
