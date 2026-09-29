---
ID: "KRS-007"
Title: "No production migration creates jwt_signing_key"
Level: medium
Category: "correctness"
Status: resolved
Package: "jwt"
Source: "packages/jwt/test/KeyRing.test.ts:27"
Auditor: "key-rotation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# KRS-007 — No production migration creates jwt_signing_key

`MEDIUM` · `correctness` · `jwt` · reported by **Key Rotation Specialist** (`key-rotation-specialist`)

Status: **resolved**

## Summary

The only DDL for the signing-key table lives in the test suite's in-memory SQLite setup. CoreMigrations covers just the five core tables, the Jwt plugin declares tables: ['jwt_signing_key'] but no migrations option (AuthPlugin.Service supports one; Migrations.ts confirms no plugin populates it yet), so deploying @awthaq/jwt with layerSql against a real database fails on the first lazy mint. The rotation machinery has no deployable persistence outside tests — key lifecycle operations cannot run in production as shipped.

## Evidence

Source: `packages/jwt/test/KeyRing.test.ts:27`

```
CREATE TABLE jwt_signing_key (
  kid TEXT PRIMARY KEY,
  alg TEXT NOT NULL,
```

## Recommended fix

Declare the CREATE TABLE migration on the Jwt plugin's AuthPlugin.Service options (per dialect, matching CoreMigrations' pattern) so Auth.make's renumbered migration runner creates the table.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: Key lifecycle & rotation
- Full dossier: [`key-rotation-specialist`](../../.reports/key-rotation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `None`. Already fixed by commit 2ebd195. Evidence at HEAD ec065a7: `packages/jwt/src/Jwt.ts:241`. Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → resolved.
