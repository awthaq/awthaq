---
ID: "MM-007"
Title: "package:smoke depends on typecheck's emit side effect with no lib/ precheck"
Level: low
Category: "dx"
Status: resolved
Package: "—"
Source: "scripts/package-smoke.mjs:12"
Auditor: "mattia-manzati"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MM-007 — package:smoke depends on typecheck's emit side effect with no lib/ precheck

`LOW` · `dx` · `—` · reported by **Mattia Manzati — Effect Developer Tooling** (`mattia-manzati`)

Status: **resolved**

## Summary

The smoke gates (publint, attw --pack, npm pack) all read `lib/`, which exists only because `pnpm typecheck` runs `tsc -b` in emit mode first — an ordering contract documented only in a comment. Run `pnpm package:smoke` standalone, after a fresh clone, or after `pnpm clean` (`rm -rf packages/*/lib`), and every package fails with opaque publint/attw 'file not found' noise instead of one actionable message. Same implicit ordering bites examples/memory-server: `pnpm start` resolves @awthaq/* through the exports maps to lib/*.js with no build step in its scripts. The one-command `check` chain hides this from CI but not from humans.

## Evidence

Source: `scripts/package-smoke.mjs:12`

```
// typecheck` in the `check` script chain, since typecheck's `tsc -b`
// project references are what produce the real `lib/` output these
// checks pack and inspect.
```

## Recommended fix

Open package-smoke with an explicit existence check per package (`lib/index.js` present, else fail with 'run pnpm typecheck first'), and give the example a `prestart` that runs its typecheck/build.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 80/100), domain: dev tooling
- Full dossier: [`mattia-manzati`](../../.reports/mattia-manzati/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 33 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `dev-scripts-tooling`. Evidence at HEAD ec065a7: `scripts/package-smoke.mjs:11`. Fix: Fail fast with an actionable message when lib/ is missing, and give the example a prestart build. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** package:smoke now checks once, up front, that every `exports` target exists and otherwise prints `run pnpm typecheck (or pnpm build) first` and exits 1; the memory example has `prestart` that builds the workspace (verified with `pnpm start`).
