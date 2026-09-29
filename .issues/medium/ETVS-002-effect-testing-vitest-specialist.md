---
ID: "ETVS-002"
Title: "Property-based testing entirely absent despite STACK.md committing to it"
Level: medium
Category: "testing"
Status: ready-for-agent
Package: "—"
Source: "STACK.md:35"
Auditor: "effect-testing-vitest-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ETVS-002 — Property-based testing entirely absent despite STACK.md committing to it

`MEDIUM` · `testing` · `—` · reported by **Effect Testing & @effect/vitest Specialist** (`effect-testing-vitest-specialist`)

Status: **ready-for-agent**

## Summary

No test file in any package imports effect's Arbitrary (grep for 'Arbitrary' across packages/ returns zero matches) and no fast-check dependency exists in the workspace catalog. STACK.md explicitly promises Schema-derived fuzz/property tests for LoginRequest, TotpCode and ApiKey; the testing harness behavior BEH-EA-193..200 is cited as their home. Auth inputs (emails, tokens, recovery codes, config Durations) are exactly where hand-written examples miss boundary inputs, and Effect v4 makes the generators free from the same Schemas the wire already decodes.

## Evidence

Source: `STACK.md:35`

```
- `unstable/arbitrary/Arbitrary.ts` — `Arbitrary.schema(schema)` derives property-based test generators straight from the same `Schema` used at runtime, so BEH-EA-193–200's fuzz/property tests for `LoginRequest`/`TotpCode`/`ApiKey` stay in sync with validation logic automatically instead of drifting from hand-written generators.
```

## Recommended fix

Add property tests via @effect/vitest's property support + Arbitrary.schema for: SessionConfig boundary decoding, verification-token encode/decode round-trip (Password.ts encodeVerificationToken/decodeVerificationToken), Principal union decoding (packages/api/src/Api.ts), and plugin contract option fuzzing in runPluginContractTests. Start with the token round-trip - it is pure and currently covered only by examples.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 74/100), domain: Test architecture & determinism
- Full dossier: [`effect-testing-vitest-specialist`](../../.reports/effect-testing-vitest-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 44 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `property-based-testing`. Evidence at HEAD ec065a7: `STACK.md:35`. Fix: Introduce Schema-derived property tests with @effect/vitest `it.prop`/`it.effect.prop`, starting with pure codecs and wire schemas. (effort M). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.
