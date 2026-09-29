---
ID: "BPAS-007"
Title: "Docs claim the passkey plugin is pre-implementation while it ships; spec omits implemented behaviors"
Level: low
Category: "docs"
Status: ready-for-agent
Package: "—"
Source: "spec/behaviors/17-passkey.md:15"
Auditor: "biometric-platform-authenticator-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BPAS-007 — Docs claim the passkey plugin is pre-implementation while it ships; spec omits implemented behaviors

`LOW` · `docs` · `—` · reported by **Biometric / Platform Authenticator Specialist** (`biometric-platform-authenticator-specialist`)

Status: **ready-for-agent**

## Summary

The stale banner is contradicted by a complete packages/passkey implementation; packages/passkey/README.md:3 repeats it ('no line of source in this package has shipped yet') and the BDD feature header (features/features/05-authentication-methods/17-passkey.feature:1-4) too. Worse for this domain: spec 17 documents none of the shipped Conditional Create (ticket 07), the ordinary-vs-conditional UV policy, or the UP posture, so the spec cannot serve as the review baseline for the ceremony logic that actually guards accounts. The BDD feature file itself is the only honest artifact — it even documents the PasskeyCounterAnomaly divergence.

## Evidence

Source: `spec/behaviors/17-passkey.md:15`

```
> This file describes planned behavior. No code implementing it exists yet; awthaq is pre-implementation.
```

## Recommended fix

Refresh the three banners, and add spec behaviors for Conditional Create (dedicated endpoint, UP=0/UV=0 scope-binding), registration/authentication UV policy, and the webauthnUserId lifetime so future changes have a normative reference.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: Platform authenticators
- Full dossier: [`biometric-platform-authenticator-specialist`](../../.reports/biometric-platform-authenticator-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 13 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `spec-behavior-code-reconcile`. Evidence at HEAD ec065a7: `spec/behaviors/17-passkey.md:15`. Fix: Replace the three stale banners and give the shipped passkey ceremony logic a normative home: new BEH ids for Conditional Create, registration-freshness (reauth) and webauthnUserId generation, and an amended BEH-EA-130/131 for the config-gated UV policy. (effort M). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.
