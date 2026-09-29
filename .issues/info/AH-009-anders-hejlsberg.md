---
ID: "AH-009"
Title: "Global DOM lib in base config lets server packages type-check DOM references"
Level: info
Category: "dx"
Status: resolved
Package: "—"
Source: "tsconfig.base.json:9"
Auditor: "anders-hejlsberg"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AH-009 — Global DOM lib in base config lets server packages type-check DOM references

`INFO` · `dx` · `—` · reported by **Anders Hejlsberg — Creator/Lead Architect of TypeScript** (`anders-hejlsberg`)

Status: **resolved**

## Summary

The base config enables DOM globals monorepo-wide (self-documented as a workaround for @awthaq/react's @types/react). The tradeoff is that server-only packages (core, sql, server) compile against window/document/fetch typings they never intend to use, so an accidental DOM reference in server code type-checks instead of failing at the earliest possible moment. This is a deliberate, documented tradeoff rather than an oversight — recording it as an observation with a cheap hardening option.

## Evidence

Source: `tsconfig.base.json:9`

```
"lib": ["ESNext", "DOM"],
```

## Recommended fix

Move lib: ["ESNext", "DOM"] into packages/react and packages/next tsconfig.src.json overrides (both already deviate via their own compilerOptions), keeping the base lib at ["ESNext"]; then a stray DOM reference in server code becomes a compile error.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 74/100), domain: Type system design
- Full dossier: [`anders-hejlsberg`](../../.reports/anders-hejlsberg/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-008` — noPropertyAccessFromIndexSignature disabled in an otherwise maximal strict profile](low/AH-008-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`MTS-004` — Adding a package requires hand-syncing five 21-entry lists with no enforcement](medium/MTS-004-monorepo-tooling-specialist.md) `_(monorepo-tooling-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `tooling-typecheck-lint`. Evidence at HEAD ec065a7: `tsconfig.base.json:9`. Fix: Base lib becomes ["ESNext"]; DOM is added only in the browser-facing packages' tsconfig.src.json (client, react, next) and in tsconfig.test.json (react .tsx tests run in that shared program). (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Base lib is now [ESNext]; DOM added only in packages/{client,react,next}/tsconfig.src.json, features/tsconfig{,.test}.json and tsconfig.test.json. Proof the guard works: a `document.title` in packages/core/src fails tsc. The WebCrypto types that leaned on the DOM lib (jwt JwtCodec, oauth Jwt, ports Encryption's CryptoKey) use node:crypto's `webcrypto` namespace. Note: tsgo's incremental build does not invalidate on a lib change; a clean build is needed once. Gates: pnpm typecheck (clean build, 0 errors), oxlint clean, knip clean, format:check clean, circular, package:smoke, coverage thresholds, test:bdd, spec:verify:strict.
