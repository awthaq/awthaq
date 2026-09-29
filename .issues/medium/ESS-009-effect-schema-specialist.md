---
ID: "ESS-009"
Title: "Redacted encode/decode failure pruned from the BDD suite instead of root-caused"
Level: medium
Category: "testing"
Status: resolved
Package: "—"
Source: "features/features/05-authentication-methods/16-oauth.feature:166"
Auditor: "effect-schema-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESS-009 — Redacted encode/decode failure pruned from the BDD suite instead of root-caused

`MEDIUM` · `testing` · `—` · reported by **Effect Schema Specialist** (`effect-schema-specialist`)

Status: **resolved**

## Summary

REQ-EA-346 (Config.Redacted inside provider Layer construction) is @skip because of a real, reproducible Schema "Encoding" failure when building a provider Layer from a process.env-set secret — explicitly documented as 'not yet root-caused'. An unresolved encode-direction incompatibility in the Redacted round-trip is exactly the class of schema bug that silently resurfaces in user code, and the suite currently cannot catch it.

## Evidence

Source: `features/features/05-authentication-methods/16-oauth.feature:166`

```
# force-implemented — hit a real `Config.Redacted`/`Schema.Redacted`
# decode failure ("Encoding" schema issue) building a provider Layer
```

## Recommended fix

Reproduce the Encoding failure in a minimal Schema/Config test, fix the annotation or field definition, and un-skip REQ-EA-346.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Schema discipline
- Full dossier: [`effect-schema-specialist`](../../.reports/effect-schema-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `bdd-skip-debt`. Evidence at HEAD ec065a7: `features/features/05-authentication-methods/16-oauth.feature:166`. Fix: Reproduce the Encoding failure in a minimal packages/oauth unit test (Config.Redacted read from an env ConfigProvider inside a provider Layer), fix the root cause (awthaq usage or an upstream Effect v4 issue), then un-skip REQ-EA-346. (effort M). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** P20a: root cause was the harness, not the product: the scenario runtime ConfigProvider is not process.env, so the step never supplied the variable and Effect reported the missing variable as an Encoding issue. Unit test packages/oauth/test/OAuthProviderConfig.test.ts covers present and absent variables; REQ-EA-346 now runs against an explicit ConfigProvider layer.
