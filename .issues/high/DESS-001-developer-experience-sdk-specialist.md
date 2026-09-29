---
ID: "DESS-001"
Title: "Client and React READMEs falsely claim the packages are pre-implementation"
Level: high
Category: "docs"
Status: ready-for-agent
Package: "client"
Source: "packages/client/README.md:3"
Auditor: "developer-experience-sdk-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DESS-001 — Client and React READMEs falsely claim the packages are pre-implementation

`HIGH` · `docs` · `client` · reported by **Developer Experience / SDK Specialist** (`developer-experience-sdk-specialist`)

Status: **ready-for-agent**

## Summary

packages/client ships 226 lines of implemented, tested source (AuthClient.ts: HttpApiClient re-exports, CsrfClientLive, ErrorCodes, SessionStore, toPromiseFacade) and packages/react ships 4 real modules, yet both package READMEs open by telling the reader the package is a plan with 'no line of source ... shipped yet' (identical banner at packages/react/README.md:3). The root README states the opposite ('actively implemented ... every plugin below has a real, tested implementation', README.md:5), so the repo contradicts itself, and the package-level doc — the one a consumer browsing packages/client/ actually reads — is the false one. Any evaluator or plugin author following the persona's 'write a plugin from scratch' walkthrough would skip these packages entirely; for packages/client it is also the ONLY README, meaning there is no accurate usage documentation at all.

## Evidence

Source: `packages/client/README.md:3`

```
> **This describes a planned package.** awthaq is pre-implementation (see [`../../spec/README.md`](../../spec/README.md)); no line of source in this package has shipped yet. This README states intent, not shipped behavior.
```

## Recommended fix

Regenerate both READMEs from the shipped modules (usage snippets for make/CsrfClientLive/ErrorCodes/sessionAtom/Providers), and add a doc-drift check (CI or repo-checks) that fails when a README claims pre-implementation while the package's src/ exceeds a placeholder.

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: consumer SDK DX
- Full dossier: [`developer-experience-sdk-specialist`](../../.reports/developer-experience-sdk-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 29 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/client/README.md:3` matches the quoted banner verbatim, while `packages/client/src/AuthClient.ts` (226 lines) and `packages/react/src/` (4 real modules) ship real, tested source; the root `README.md:5` states the opposite. Rewriting both banners from shipped modules is a well-scoped mechanical change. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `frontend-docs-truthfulness`. Evidence at HEAD ec065a7: `packages/client/README.md:3`. Fix: Rewrite both READMEs from the shipped modules and add a drift guard. (effort M). Full dossier: `.plan/slices/11-frontend-next-react-client.md`.
