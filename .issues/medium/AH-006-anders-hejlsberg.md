---
ID: "AH-006"
Title: "Emitted .d.ts keeps ./.ts relative specifiers while emitted .js is rewritten to .js"
Level: medium
Category: "api"
Status: resolved
Package: "core"
Source: "packages/core/lib/Sessions.d.ts:12"
Auditor: "anders-hejlsberg"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AH-006 — Emitted .d.ts keeps ./.ts relative specifiers while emitted .js is rewritten to .js

`MEDIUM` · `api` · `core` · reported by **Anders Hejlsberg — Creator/Lead Architect of TypeScript** (`anders-hejlsberg`)

Status: **resolved**

## Summary

rewriteRelativeImportExtensions rewrote the emitted JS (packages/core/lib/Sessions.js:23 imports './Users.js') but every emitted declaration still says './Users.ts', './AuthPlugin.ts', etc. Consumers therefore depend on TypeScript's declaration-extension substitution (.ts -> .d.ts) and on skipLibCheck-style leniency; under node16/nodenext resolution with skipLibCheck off, or in non-tsc type resolvers, the types condition ('./lib/index.d.ts' per package.json exports) fails to resolve cleanly for a library that advertises published types. This is likely a tsgo/Corsa emit-parity gap rather than intent — the on-disk artifact is what consumers receive.

## Evidence

Source: `packages/core/lib/Sessions.d.ts:12`

```
import { UserId } from "./Users.ts";
```

## Recommended fix

Pin down whether @effect/tsgo honors rewriteRelativeImportExtensions for declaration emit; if not, post-process lib/*.d.ts in scripts/build.mjs (rewrite .ts to .js) or verify with @arethetypeswrong/cli plus a no-skipLibCheck nodenext consumer in scripts/package-smoke.mjs.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 74/100), domain: Type system design
- Full dossier: [`anders-hejlsberg`](../../.reports/anders-hejlsberg/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence medium); workstream `build-tooling-hygiene`. Evidence at HEAD ec065a7: `packages/core/lib/Accounts.d.ts:12`. Fix: Add a consumer-resolution guard to package:smoke rather than rewriting emitted declarations. (effort S). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Verified against the current build: emitted .d.ts keeps ./X.ts specifiers (verbatim), .js is rewritten; TypeScript maps a .ts specifier in a declaration to its .d.ts. A nodenext consumer with skipLibCheck off resolves every package (only unrelated declaration errors remain: see note). Added a guard to scripts/package-smoke.mjs that builds such a consumer over every package export and fails on module-resolution codes 2307/2792/2691/5097/7016; no emit rewriting needed. Note (new defect, not fixed): with skipLibCheck off, packages/sql/lib/Models.d.ts has ~220 TS2552/TS2304 errors (tsgo emits unresolved names Extended_1/NewFields_1/S/Self/Brand_1 for Model.Class generics).
