---
ID: "DTWS-008"
Title: "spec/overview.md's ports-stratum surface was never reconciled with the shipped @awthaq/ports exports"
Level: low
Category: "docs"
Status: ready-for-agent
Package: "—"
Source: "spec/overview.md:47"
Auditor: "documentation-technical-writing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DTWS-008 — spec/overview.md's ports-stratum surface was never reconciled with the shipped @awthaq/ports exports

`LOW` · `docs` · `—` · reported by **Documentation & Technical Writing Specialist** (`documentation-technical-writing-specialist`)

Status: **ready-for-agent**

## Summary

The planned surface table lists three ports, but the shipped packages/ports/src also contains Encryption.ts, KeyProvider.ts, RateLimiter.ts, and SqlTransaction.ts — and the root README's quickstart (lines 48, 84-87, 139) depends on Encryption/KeyProvider/RateLimiter. Because README.md:5 declares spec/ 'still the canonical specification', the canonical surface map is missing a quarter of the stratum's real exports, and the overview's own banner (line 17) still frames everything as unshipped, so nothing in the document signals that reconciliation is owed. STACK.md knew about RateLimiter (§3a recommends adopting it) — the spec never absorbed that.

## Evidence

Source: `spec/overview.md:47`

```
| 2 Ports | `@awthaq/ports` | `PasswordHasher`, `Mailer`, `WebAuthn`, each with `layer`, `layerNoop`, `layerMemory` variants. |
```

## Recommended fix

When revising the overview banner (DTWS-001), also reconcile the strata table with the real exports: add Encryption, KeyProvider, RateLimiter (and SqlTransaction) to the Ports row, marking which are shipped vs planned.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: Documentation & Spec Drift
- Full dossier: [`documentation-technical-writing-specialist`](../../.reports/documentation-technical-writing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `spec-surface-inventory-reconcile`. Evidence at HEAD ec065a7: `spec/overview.md:47`. Fix: Reconcile overview.md's Ports row (line 47) and Ports stratum surface table (lines 90-96) with the nine shipped modules and their real layer constructors; fix 'Context.Tag' → 'Context.Service'/'Context.Reference'; reuse AVS-008's surface script to keep it honest. (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.
