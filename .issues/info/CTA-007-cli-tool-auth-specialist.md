---
ID: "CTA-007"
Title: "Absence of the entire domain is documented honestly in every artifact"
Level: info
Category: "docs"
Status: needs-triage
Package: "cli"
Source: "packages/cli/README.md:3"
Auditor: "cli-tool-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CTA-007 — Absence of the entire domain is documented honestly in every artifact

`INFO` · `docs` · `cli` · reported by **CLI Tool Auth Specialist** (`cli-tool-auth-specialist`)

Status: **needs-triage**

## Summary

Every relevant artifact disclaims itself: the README marks the package planned, src/index.ts declares 'Empty placeholder — awthaq is pre-implementation', spec/behaviors/26-cli.md:15 states 'No code implementing it exists yet', and the feature file's header says every scenario specifies intended behavior of a system that does not exist. Device flow is consistently deferred (Phase 3 in archive/PRD.md:279) and ApiKey to M7, with the deferrals cross-referenced in change history (CCR-EA-002, CCR-EA-004). No README, spec, or code claims CLI authentication capability that does not exist — the audit found zero phantom claims in this domain.

## Evidence

Source: `packages/cli/README.md:3`

```
no line of source in this package has shipped yet. This README states intent, not shipped behavior.
```

## Recommended fix

Keep this discipline as the domain is built: when login lands, update the README/spec claims in the same change, and add the storage and exit-code decisions to spec/decisions so the intent-versus-reality gap never silently reopens.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 32/100), domain: CLI Authentication
- Full dossier: [`cli-tool-auth-specialist`](../../.reports/cli-tool-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** WONTFIX-CANDIDATE (confidence high); workstream `cli-manifest-tooling`. Evidence at HEAD ec065a7: `packages/cli/README.md:3`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/09-ports-apikey-cli.md`.
