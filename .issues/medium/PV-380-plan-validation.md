---
ID: "PV-380"
Title: "@awthaq/sql's emitted Models.d.ts references unresolved names (Extended_1, NewFields_1, S, Self, Brand_1), so a consumer with skipLibCheck off gets ~220 type errors"
Level: medium
Category: "correctness"
Status: resolved
Package: "sql"
Source: "packages/sql/lib/Models.d.ts:1414"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-380 — @awthaq/sql's emitted Models.d.ts references unresolved names

`MEDIUM` · `correctness` · `sql` · found while verifying AH-006 (P22): a `nodenext` consumer with `skipLibCheck: false`

Status: **resolved**

## Summary

`packages/sql/lib/Models.d.ts`, as emitted by the tsgo build, mentions type names that are not in scope in the declaration file (`Extended_1`, `NewFields_1`, `Extension_1`, `Brand_1`, `S`, `Self`, ...), around lines 1414 and 1642 (the `Model.Class` generic surface). A consumer that type-checks its dependencies (`skipLibCheck: false`) gets roughly 220 `TS2552`/`TS2304` errors from that one file; with `skipLibCheck: true` (the default in most setups, and this repo's own base config) nothing is reported, so `package:smoke`, attw and every in-repo typecheck stay green. It is unrelated to the `.ts` relative specifiers AH-006 was about (those resolve fine: `scripts/package-smoke.mjs` now has a guard for that).

## Evidence

Reproduce: link `packages/core`, `ports`, `api` (which pull in `sql`) into a temp project, `tsc -p` with `module: nodenext`, `moduleResolution: nodenext`, `skipLibCheck: false`, importing `@awthaq/core`; every error is in `packages/sql/lib/Models.d.ts`.

## Recommended fix

Check whether the gap is in tsgo's declaration emit for the `Model.Class` generics (then give `Models.ts` explicit exported types for the affected declarations so the emitted `.d.ts` can name them, without a return-type annotation on an Effect/Layer const) or an upstream `effect/unstable/schema` type; add a `skipLibCheck: false` declaration check for the emitted `.d.ts` of `@awthaq/sql` to `package:smoke` once it is clean.

## Comments

_Triage notes and discussion append here._

**Resolved (2026-09-29):** Cause: tsgo's declaration emit inlined each anonymous class returned by pgModels()/sqliteModels() (the whole Model.Class constructor type, including the generic 'extend' signature) into Models.d.ts, leaking unresolved type parameters (Extended_1, NewFields_1, Extension_1, Brand_1, S, Self; ~220 errors, a 1.2 MB / 17k-line file). Fix in packages/sql/src/Models.ts: the eight classes are declared at module scope (PgUser..SqliteVerificationReservation) and the per-dialect model sets are plain objects over them, so the emitted d.ts names 'typeof PgUser' (106 KB, 0 errors); no return-type annotation on an Effect/Layer const, no casts, makeModels(dialect) unchanged for callers. scripts/package-smoke.mjs: the nodenext consumer (skipLibCheck: false, now with @types/node) now fails on ANY diagnostic inside packages/*/lib declarations, not only module resolution, for every package; verified red by appending an unresolved name to lib/Models.d.ts. It flagged one other case, jwt's node:crypto webcrypto types, which the consumer now resolves via @types/node (a server library assumes platform types). sql tests 162 passed.
