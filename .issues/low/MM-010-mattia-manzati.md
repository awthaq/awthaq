---
ID: "MM-010"
Title: "format/format:check hand-duplicate their explicit target lists (drift already visible)"
Level: low
Category: "dx"
Status: resolved
Package: "—"
Source: "package.json:22"
Auditor: "mattia-manzati"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MM-010 — format/format:check hand-duplicate their explicit target lists (drift already visible)

`LOW` · `dx` · `—` · reported by **Mattia Manzati — Effect Developer Tooling** (`mattia-manzati`)

Status: **resolved**

## Summary

Both format and format:check enumerate the same 13 targets inline; they must be edited in lockstep forever, and the list is already incomplete: knip.json (a formatted-JSON candidate sitting next to the other tsconfig/lint configs), examples/, and .github/ are absent, while vitest.config.ts made it in. A future contributor adding a root config will likely update one script and not the other, making `format` and `format:check` disagree — the classic check-formats-differently-than-fixes trap.

## Evidence

Source: `package.json:22`

```
"format": "oxfmt packages features scripts vitest.config.ts package.json pnpm-workspace.yaml tsconfig.json tsconfig.base.json tsconfig.packages.json tsconfig.test.json .oxlintrc.json .changeset/config.json",
```

## Recommended fix

Move the target list into oxfmt's own config file (or a shared package.json field) so both scripts reference one source, and add knip.json while at it.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 80/100), domain: dev tooling
- Full dossier: [`mattia-manzati`](../../.reports/mattia-manzati/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 33 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`MM-003` — @effect/tsgo pinned exact but typescript caret — patched pair can drift](low/MM-003-mattia-manzati.md) `_(mattia-manzati, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `dev-scripts-tooling`. Evidence at HEAD ec065a7: `package.json:22`. Fix: Move target selection into `.oxfmtrc.json` (ignorePatterns) so `format` = `oxfmt` and `format:check` = `oxfmt --check` with no lists. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Added .oxfmtrc.json (ignorePatterns: agent/plan/issue dirs, archive, better-auth, docs, research, spec, tools, markdown, html, feature files, lockfile, lib/node_modules). `format` is `oxfmt`, `format:check` is `oxfmt --check`, no path lists; examples/, .github/ and knip.json are now covered. Markdown and .feature stay out of scope (prose belongs to the docs work; reformatting tables causes conflicts). The tree was reformatted in a separate formatting-only commit.
