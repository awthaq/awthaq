---
ID: "MM-009"
Title: "Dev scripts are POSIX/tsc-on-PATH only; Windows contributors break"
Level: low
Category: "dx"
Status: resolved
Package: "—"
Source: "scripts/build.mjs:16"
Auditor: "mattia-manzati"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MM-009 — Dev scripts are POSIX/tsc-on-PATH only; Windows contributors break

`LOW` · `dx` · `—` · reported by **Mattia Manzati — Effect Developer Tooling** (`mattia-manzati`)

Status: **resolved**

## Summary

`spawnSync("tsc", ...)` without `shell: true` cannot execute the pnpm cmd-shim (`tsc.cmd`) on Windows, and the root `clean` script uses `rm -rf`. The toolchain otherwise supports Windows (typescript's optionalDependencies include @typescript/typescript-win32-*, engines only floor Node), and getExePath.js goes out of its way to handle win32 paths — but build, clean, and the format script's explicit target list all assume a POSIX shell. CI (ubuntu-only, single Node 22.12.0) never exercises Windows, so the breakage would surface only on a contributor machine.

## Evidence

Source: `scripts/build.mjs:16`

```
  const result = spawnSync("tsc", ["-b", "tsconfig.packages.json"], { stdio: "inherit" });
```

## Recommended fix

Use `spawnSync("tsc", args, { shell: process.platform === "win32" })` or invoke via `process.execPath` on the JS shim, and swap `rm -rf` for `node -e 'fs.rmSync(..., {recursive: true})'` (or rimraf) in clean.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 80/100), domain: dev tooling
- Full dossier: [`mattia-manzati`](../../.reports/mattia-manzati/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 33 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`MTS-009` — build.mjs and circular.mjs use cwd-relative globs and silently succeed from the wrong directory](low/MTS-009-monorepo-tooling-specialist.md) `_(monorepo-tooling-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `dev-scripts-tooling`. Evidence at HEAD ec065a7: `scripts/build.mjs:16`. Fix: Make build/clean cross-platform using Node APIs instead of PATH lookups and POSIX shell. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** build.mjs runs tsc through node on the workspace typescript (`node_modules/typescript/bin/tsc`), no PATH lookup or POSIX shell; new scripts/clean.mjs (fs.rmSync over lib/, tsbuildinfo) replaces `rm -rf`; release-dry-run spawns with a shell on win32. A windows CI smoke job was not added (optional in the dossier).
