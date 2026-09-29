---
ID: "MM-008"
Title: "no-unused-internal lint rule dark under TS7 (honestly documented)"
Level: info
Category: "dx"
Status: needs-triage
Package: "—"
Source: "tools/oxc/index.ts:12"
Auditor: "mattia-manzati"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MM-008 — no-unused-internal lint rule dark under TS7 (honestly documented)

`INFO` · `dx` · `—` · reported by **Mattia Manzati — Effect Developer Tooling** (`mattia-manzati`)

Status: **needs-triage**

## Summary

The vendored Effect oxlint plugin registers five rules but only four are enabled: `no-unused-internal` drives the classic compiler API, which the pinned typescript 7.0.2 no longer exposes (root export is just ./lib/version.cjs), so enabling it would crash oxlint. The handling is exemplary — the constraint is documented at the registration site with the exact reason and the unblock condition (upstream rewrite or pin-back), not suppressed silently. But it does mean one Effect-specific hygiene rule (internal-symbol leakage) is not actually enforced in this repo's dev loop, and nothing tracks the debt.

## Evidence

Source: `tools/oxc/index.ts:12`

```
// Registered but NOT enabled in .oxlintrc.json — it drives TypeScript's
// classic compiler API (ts.createSourceFile, ts.SyntaxKind, ...), which no
// longer exists at `typescript`'s top-level import under the tsgo/Corsa
```

## Recommended fix

Track it as a follow-up issue with the unblock condition, and consider a TS7-compatible rewrite using the new `typescript/unstable/ast` exports now present in the package.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 80/100), domain: dev tooling
- Full dossier: [`mattia-manzati`](../../.reports/mattia-manzati/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 33 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** WONTFIX-CANDIDATE (confidence high); workstream `None`. Evidence at HEAD ec065a7: `tools/oxc/index.ts:11`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/13-repo-features-tooling.md`.
