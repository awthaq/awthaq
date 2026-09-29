---
ID: "ELC-004"
Title: "Every memory layer requires Crypto.Crypto, forcing repeated Layer.provide(NodeCrypto.layer) boilerplate at ~40 composition sites"
Level: low
Category: "dx"
Status: ready-for-agent
Package: "core"
Source: "packages/core/test/Users.test.ts:17"
Auditor: "effect-layer-context-architect"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ELC-004 — Every memory layer requires Crypto.Crypto, forcing repeated Layer.provide(NodeCrypto.layer) boilerplate at ~40 composition sites

`LOW` · `dx` · `core` · reported by **Effect Layer/Context Architect** (`effect-layer-context-architect`)

Status: **ready-for-agent**

## Summary

Users/Accounts/Sessions/Verification.layerMemory all require Crypto.Crypto, and Organization's six record layerMemory variants repeat the pattern, so nearly every test file and the memory-server example hand-pipes Layer.provide(NodeCrypto.layer) per layer (grep finds the idiom across ~40 sites in packages/*/test plus examples/memory-server). TestAuth.ts already solved this once with its MemoryPorts aggregate (TestAuth.ts:84-92), but package-local tests predate or bypass it. The repetition is harmless at runtime (NodeCrypto.layer is a stateless Layer.succeed-style effect) but it is pure noise that a new plugin author will copy.

## Evidence

Source: `packages/core/test/Users.test.ts:17`

```
const MemoryLayer = Users.layerMemory.pipe(Layer.provide(NodeCrypto.layer));
```

## Recommended fix

Ship a shared `@awthaq/test` aggregate (or a `layerMemoryProvided` alias per module) that merges the memory repositories with NodeCrypto.layer, and migrate package tests to it; keep the raw layers for consumers who inject a custom Crypto.

## Context

- Auditor verdict on this domain: **pass** (score 84/100), domain: Layer/Context architecture
- Full dossier: [`effect-layer-context-architect`](../../.reports/effect-layer-context-architect/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 52 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `build-tooling-hygiene`. Evidence at HEAD ec065a7: `packages/core/test/Users.test.ts:18`. Fix: Provide ready-made crypto-provided memory aggregates and migrate tests. (effort M). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.
