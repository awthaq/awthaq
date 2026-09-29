---
ID: "DTWS-001"
Title: "spec/README.md's honesty banner asserts there is no source tree, no CI, no package.json — all false"
Level: high
Category: "docs"
Status: resolved
Package: "—"
Source: "spec/README.md:17"
Auditor: "documentation-technical-writing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DTWS-001 — spec/README.md's honesty banner asserts there is no source tree, no CI, no package.json — all false

`HIGH` · `docs` · `—` · reported by **Documentation & Technical Writing Specialist** (`documentation-technical-writing-specialist`)

Status: **resolved**

## Summary

The canonical specification's banner describes the repo as having no package.json, no source tree, and no CI. In reality there are 21 packages with real source and tests under packages/, a vitest+oxlint CI matrix in .github/workflows/check.yml, and a root README (line 5) stating 'every plugin below has a real, tested implementation'. The same false banner text is repeated verbatim in spec/overview.md:17, spec/glossary.md:17, and spec/invariants.md:19. A future agent or engineer who does what spec/README.md says ('Read this first') is fed false facts about the repository on page one — precisely the spec/code drift this spec tree's own Document-Control discipline exists to prevent.

## Evidence

Source: `spec/README.md:17`

```
> **This describes a planned system.** awthaq is pre-implementation: there is no package.json, no source tree, no CI, and no shipped code.
```

## Recommended fix

Add a CCR-EA revision that replaces the pre-implementation banners in all four documents with the roadmap.md:17-style status paragraph ('packages/ has a real, tested implementation through M4 and beyond; this tree remains the normative why'), or generate the banner from a single status include so it cannot diverge per-file again.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: Documentation & Spec Drift
- Full dossier: [`documentation-technical-writing-specialist`](../../.reports/documentation-technical-writing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`DTWS-006` — spec/README.md claims the BDD suite has 'no test runner, no step-definition layer' — features/ has both](medium/DTWS-006-documentation-technical-writing-specialist.md) `_(documentation-technical-writing-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `spec/README.md:17` matches the quoted "no package.json, no source tree, no CI" banner verbatim, while `.github/workflows/check.yml` exists, `package.json` exists at repo root, and 21 packages under `packages/` ship real source. Replacing the four stale banners with an accurate status paragraph (or a shared include) is a well-scoped mechanical change. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `spec-status-banner-sweep`. Evidence at HEAD ec065a7: `spec/README.md:17`. Fix: Replace the five tree-level 'planned system / pre-implementation' banners (README, overview, glossary, urs, invariants) with one accurate status paragraph modelled on roadmap.md:17, and add a verify-traceability check that fails on the stale phrases so the drift cannot recur. (effort M). Full dossier: `.plan/slices/12-spec.md`.

**Resolved (2026-09-29):** Replaced the five tree-level banners (spec/README.md, overview.md, glossary.md, urs.md, invariants.md) plus every behavior, model, traceability, roadmap, DoD, requirement-id-scheme, docs/ and features/README status claim with the shipped state, verified against packages/ at HEAD (25 packages; two-factor and magic-link are placeholders; SAML specified only), not against the dossier. New check 9 in spec/scripts/check-drift.mjs (called from verify-traceability.sh) fails on present-tense 'nothing is built' phrases across spec/, docs/, README.md and features/README.md; it listed dozens of files (every behavior and model banner among them) before the sweep and none after. Revisions bumped with Change History rows (CCR-EA-006). Gates: pnpm run typecheck clean, pnpm run spec:verify:strict 28/28, pnpm run check:readmes green.
