---
ID: "TS-005"
Title: "94 authorization-bridge BDD scenarios have no executable step definitions"
Level: medium
Category: "testing"
Status: resolved
Package: "—"
Source: "features/features/06-roles-and-authorization-bridge/19-qadi-bridge-path-a.feature:2"
Auditor: "torin-sandall"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# TS-005 — 94 authorization-bridge BDD scenarios have no executable step definitions

`MEDIUM` · `testing` · `—` · reported by **Torin Sandall — Co-creator of Open Policy Agent (OPA)** (`torin-sandall`)

Status: **resolved**

## Summary

The authorization bridge is the repo's central design bet (ADR-EA-009), specified as 94 scenarios across features 18-21, but features/step-definitions/ contains only Admin/OAuth/Passkey/Password/Session/Smoke worlds — zero qadi steps. The 23 unit tests in packages/qadi/test cover real behavior (middleware ordering, extractor fallback, obligation discharge), yet the behavioral contract that matters most for a policy boundary — deny-vs-outage mapping, enforceProjected trimming, witness unforgeability, unannotated-endpoint fail-closed — exists only as prose no harness can execute. Policy logic is exactly where specification/test drift is most dangerous, because a stale spec reads as a security guarantee.

## Evidence

Source: `features/features/06-roles-and-authorization-bridge/19-qadi-bridge-path-a.feature:2`

```
# awthaq is pre-implementation (see spec/README.md). Every scenario in
# this file specifies intended behavior of a system that does not exist yet
# — a target the future testing harness (BEH-EA-193..200) is meant to
```

## Recommended fix

Before adding any new bridge surface, generate step definitions for features 18-21 (the scenario bodies already name the exact qadi calls and status mappings); until then, mark the group as non-executable in the harness manifest so '94 scenarios passing' can never be claimed.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Authorization architecture
- Full dossier: [`torin-sandall`](../../.reports/torin-sandall/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `bdd-feature-wiring`. Duplicate of `AH-003-aslak-hellesoy` — closed by that issue's fix. Evidence at HEAD ec065a7: `features/features/06-roles-and-authorization-bridge/19-qadi-bridge-path-a.feature:7`. Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `AH-003-aslak-hellesoy` — closed by its fix (see that issue's Resolved comment).
