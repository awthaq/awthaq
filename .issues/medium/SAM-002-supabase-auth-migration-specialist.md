---
ID: "SAM-002"
Title: "BcryptHasher.layer is the architecture's named escape hatch but nothing ships it or the recipe"
Level: medium
Category: "dx"
Status: resolved
Package: "—"
Source: "spec/decisions/010-plugins-require-ports-never-provide.md:23"
Auditor: "supabase-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SAM-002 — BcryptHasher.layer is the architecture's named escape hatch but nothing ships it or the recipe

`MEDIUM` · `dx` · `—` · reported by **Supabase Auth Migration Specialist** (`supabase-auth-migration-specialist`)

Status: **resolved**

## Summary

ADR-EA-010 correctly relocates hash-format choice to the application (a bcrypt verifier is a Layer, not a plugin), and all the machinery a lazy migration needs exists: needsRehash returns true for any hash the layer cannot parse (packages/ports/src/PasswordHasher.ts:148-156) and rehashOnLogin defaults true (packages/password/src/Password.ts:44). But no bcrypt implementation ships anywhere in the repo, and no doc connects these dots for an incoming GoTrue workload. A migration team must independently discover the port contract, the rehash semantics, and the signIn ordering (verify succeeds before rehash, packages/password/src/Password.ts:552-557) to avoid hand-rolling a wrong solution such as a blocking batch rehash.

## Evidence

Source: `spec/decisions/010-plugins-require-ports-never-provide.md:23`

```
it is simply `BcryptHasher.layer`, a Layer the application provides like any port implementation
```

## Recommended fix

Add a migration guide chapter (or a packages/ports layer, e.g. PasswordHasher.layerBcryptBridge) that documents the exact composition: bcrypt-capable verify, argon2id hash, needsRehash true on legacy formats, and the per-first-login upgrade behavior, with the caveat that verify must cost-real-work on unknown emails (the dummyHash pattern at packages/password/src/Password.ts:442-447 already enforces this).

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: Supabase migration readiness
- Full dossier: [`supabase-auth-migration-specialist`](../../.reports/supabase-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `password-hasher-legacy-recipes`. Already fixed by commit 60947ff (partial). Evidence at HEAD ec065a7: `packages/migrate-auth0/src/BcryptVerifier.ts:30`. Fix: Correct ADR-010's example to the shipped LegacyPasswordVerifiers mechanism and publish a GoTrue/Supabase migration recipe that reuses the bcrypt verifier. (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** spec/decisions/010 revised to 1.1: the phantom BcryptHasher.layer is replaced by the shipped verify-only LegacyPasswordVerifiers mechanism; migrate-auth0 README gains a Supabase/GoTrue recipe (SAM-001); spec/overview.md ports table mentions LegacyPasswordVerifiers and the worker-pool variants.
