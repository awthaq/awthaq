---
ID: "PV-380"
Title: "@awthaq/sql's emitted Models.d.ts references unresolved names (Extended_1, NewFields_1, S, Self, Brand_1), so a consumer with skipLibCheck off gets ~220 type errors"
Level: medium
Category: "correctness"
Status: open
Package: "sql"
Source: "packages/sql/lib/Models.d.ts:1414"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-380 — @awthaq/sql's emitted Models.d.ts references unresolved names

`MEDIUM` · `correctness` · `sql` · found while verifying AH-006 (P22): a `nodenext` consumer with `skipLibCheck: false`

Status: **open**

## Summary

`packages/sql/lib/Models.d.ts`, as emitted by the tsgo build, mentions type names that are not in scope in the declaration file (`Extended_1`, `NewFields_1`, `Extension_1`, `Brand_1`, `S`, `Self`, ...), around lines 1414 and 1642 (the `Model.Class` generic surface). A consumer that type-checks its dependencies (`skipLibCheck: false`) gets roughly 220 `TS2552`/`TS2304` errors from that one file; with `skipLibCheck: true` (the default in most setups, and this repo's own base config) nothing is reported, so `package:smoke`, attw and every in-repo typecheck stay green. It is unrelated to the `.ts` relative specifiers AH-006 was about (those resolve fine: `scripts/package-smoke.mjs` now has a guard for that).

## Evidence

Reproduce: link `packages/core`, `ports`, `api` (which pull in `sql`) into a temp project, `tsc -p` with `module: nodenext`, `moduleResolution: nodenext`, `skipLibCheck: false`, importing `@awthaq/core`; every error is in `packages/sql/lib/Models.d.ts`.

## Recommended fix

Check whether the gap is in tsgo's declaration emit for the `Model.Class` generics (then give `Models.ts` explicit exported types for the affected declarations so the emitted `.d.ts` can name them, without a return-type annotation on an Effect/Layer const) or an upstream `effect/unstable/schema` type; add a `skipLibCheck: false` declaration check for the emitted `.d.ts` of `@awthaq/sql` to `package:smoke` once it is clean.

## Comments

_Triage notes and discussion append here._
