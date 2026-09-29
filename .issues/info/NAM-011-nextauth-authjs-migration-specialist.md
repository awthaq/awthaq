---
ID: "NAM-011"
Title: "Edge-runtime core is WebCrypto-clean, but SQL persistence ships Node-only drivers"
Level: info
Category: "architecture"
Status: resolved
Package: "sql"
Source: "packages/sql/package.json:39"
Auditor: "nextauth-authjs-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NAM-011 — Edge-runtime core is WebCrypto-clean, but SQL persistence ships Node-only drivers

`INFO` · `architecture` · `sql` · reported by **NextAuth.js/Auth.js Migration Specialist** (`nextauth-authjs-migration-specialist`)

Status: **resolved**

## Summary

Audited for edge compatibility (the deciding factor for many Next.js Auth.js deployments): the hot paths are all edge-safe — Sessions verifies via effect/Crypto's WebCrypto digest (Sessions.ts:35-39), JWT sign/verify uses globalThis.crypto.subtle (KeyRing.ts:9-11), password hashing uses pure-WASM hash-wasm explicitly chosen because it 'brings argon2id to edge runtimes' (PasswordHasher.ts:23-25), and packages/next has zero Node imports (the one node:crypto reference in oauth/Jwt.ts:16 is a type-only import, erased at runtime). The gap is persistence: repositories are driver-agnostic over SqlClient, but the only drivers in the workspace are Node TCP/native (@effect/sql-pg, @effect/sql-sqlite-node) and dialect support in CoreMigrations is pg/sqlite only — so a Vercel Edge/Cloudflare deployment falls back to the per-process memory layer, which is not a session store. Auth.js solves this with HTTP drivers (Neon, D1, Upstash); effect-auth has no documented equivalent path.

## Evidence

Source: `packages/sql/package.json:39`

```
"@effect/platform-node": "catalog:",
"@effect/sql-pg": "catalog:",
"@effect/sql-sqlite-node": "catalog:",
```

## Recommended fix

Add (or document) an HTTP-driver recipe for edge deployments (e.g. Postgres-over-HTTP), and verify MySQL exclusion doesn't block the common Auth.js PlanetScale cohort.

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: Auth.js Migration Parity
- Full dossier: [`nextauth-authjs-migration-specialist`](../../.reports/nextauth-authjs-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `sql-docs-operations`. Duplicate of `ERAS-006` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/sql/package.json:31`. Full dossier: `.plan/slices/05-sql.md`. Status → resolved.
