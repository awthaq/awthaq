---
ID: "AH-008"
Title: "noPropertyAccessFromIndexSignature disabled in an otherwise maximal strict profile"
Level: low
Category: "dx"
Status: resolved
Package: "—"
Source: "tsconfig.base.json:36"
Auditor: "anders-hejlsberg"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AH-008 — noPropertyAccessFromIndexSignature disabled in an otherwise maximal strict profile

`LOW` · `dx` · `—` · reported by **Anders Hejlsberg — Creator/Lead Architect of TypeScript** (`anders-hejlsberg`)

Status: **resolved**

## Summary

Every other correctness flag in the base config is at its strictest — appropriate for an auth runtime — but dot-access on index signatures remains allowed, so `config.headers.authorization` style reads over Record<string, string> types compile without flagging that the property may be absent. For a codebase that otherwise pushes absence into the type system (Option, exactOptionalPropertyTypes), this flag quietly re-admits one class of undefined-at-runtime reads that noUncheckedIndexedAccess already catches for bracket access.

## Evidence

Source: `tsconfig.base.json:36`

```
"noPropertyAccessFromIndexSignature": false,
```

## Recommended fix

Flip it to true and fix the resulting sites (they will be few and are exactly the ones worth making explicit); if erasure-sensitive code needs the escape hatch, scope the exception to that file rather than the whole monorepo.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 74/100), domain: Type system design
- Full dossier: [`anders-hejlsberg`](../../.reports/anders-hejlsberg/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-009` — Global DOM lib in base config lets server packages type-check DOM references](info/AH-009-anders-hejlsberg.md) `_(anders-hejlsberg, info)_`
- [`MTS-004` — Adding a package requires hand-syncing five 21-entry lists with no enforcement](medium/MTS-004-monorepo-tooling-specialist.md) `_(monorepo-tooling-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `tooling-typecheck-lint`. Evidence at HEAD ec065a7: `tsconfig.base.json:36`. Fix: Flip `noPropertyAccessFromIndexSignature` to true in tsconfig.base.json and convert the resulting dot-access-on-index-signature sites to bracket access (which `noUncheckedIndexedAccess` then types as `T | undefined`). (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** tsconfig.base.json: noPropertyAccessFromIndexSignature true. Only five sites fired (migrate-better-auth AliasLegacyCookieMiddleware src + test, jwt verifyForeignIssuer test): converted to bracket access, no assertions. Gates: pnpm typecheck (clean build, 0 errors), oxlint clean, knip clean, format:check clean, circular, package:smoke, coverage thresholds, test:bdd, spec:verify:strict.
