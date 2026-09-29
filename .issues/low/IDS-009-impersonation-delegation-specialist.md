---
ID: "IDS-009"
Title: "Spec docs still claim impersonation is unimplemented while shipping code exists"
Level: low
Category: "docs"
Status: ready-for-agent
Package: "—"
Source: "spec/behaviors/27-admin-impersonation.md:15"
Auditor: "impersonation-delegation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# IDS-009 — Spec docs still claim impersonation is unimplemented while shipping code exists

`LOW` · `docs` · `—` · reported by **Impersonation & Delegation Specialist** (`impersonation-delegation-specialist`)

Status: **ready-for-agent**

## Summary

The behavior spec's banner and INV-EA-014's Enforcement section ('`Admin` itself remains unimplemented', spec/invariants.md:157) predate the shipped packages/admin plugin - the very feature file that audits it notes it was 'authored against the real, already-implemented @awthaq/admin plugin'. A reader trusting the spec header would conclude the entire audited surface is aspirational. The stale banner sits directly above requirements the code does implement, the worst of both worlds for spec-as-ground-truth.

## Evidence

Source: `spec/behaviors/27-admin-impersonation.md:15`

```
> This file describes planned behavior. No code implementing it exists yet; awthaq is pre-implementation.
```

## Recommended fix

Replace pre-implementation banners with the effective-behavior status (matching the 1.2 pattern already used in invariants.md' change history), and align INV-EA-014's Enforcement with the existing Sessions.test/Admin.test coverage.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 71/100), domain: Impersonation & Delegation
- Full dossier: [`impersonation-delegation-specialist`](../../.reports/impersonation-delegation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `spec-status-banner-sweep`. Evidence at HEAD ec065a7: `spec/behaviors/27-admin-impersonation.md:15`. Fix: Replace the 27-admin-impersonation.md banner with implementation pointers, rewrite INV-EA-014's Enforcement cell to name the existing tests, and refresh packages/admin/README.md and model 15. (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.
