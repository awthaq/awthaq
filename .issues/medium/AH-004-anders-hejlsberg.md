---
ID: "AH-004"
Title: "Declared no-as-in-library-source invariant is unenforced and already violated"
Level: medium
Category: "dx"
Status: ready-for-agent
Package: "—"
Source: ".oxlintrc.json:5"
Auditor: "anders-hejlsberg"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AH-004 — Declared no-as-in-library-source invariant is unenforced and already violated

`MEDIUM` · `dx` · `—` · reported by **Anders Hejlsberg — Creator/Lead Architect of TypeScript** (`anders-hejlsberg`)

Status: **ready-for-agent**

## Summary

packages/password/src/Password.ts:133 states 'this repo forbids as/as unknown as/as any in library source', but the lint config only enables no-explicit-any (which bans `any` annotations, not `as` assertions), and no custom rule exists in tools/oxc for assertions. The census found assertion sites in packages/core/src/Sessions.ts:228 and six untrusted-JSON sites in packages/oauth/src — the invariant is aspirational documentation, not a checked property, which is precisely how a soundness discipline regresses.

## Evidence

Source: `.oxlintrc.json:5`

```
"no-explicit-any": "error",
```

## Recommended fix

Add an oxlint JS-plugin rule (the tools/oxc plugin mechanism already exists) banning assertion expressions under packages/*/src/** with an allowlist for `as const`, and let tests keep their narrow assertions; every existing src site is individually removable per the other findings.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 74/100), domain: Type system design
- Full dossier: [`anders-hejlsberg`](../../.reports/anders-hejlsberg/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `tooling-typecheck-lint`. Evidence at HEAD ec065a7: `.oxlintrc.json:5`. Fix: Make the no-type-assertion rule a checked property: enable oxlint's built-in `typescript/consistent-type-assertions` with `assertionStyle: "never"` (still permits `as const`) scoped to library source, and remove the 11 remaining src assertion sites. (effort M). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.
