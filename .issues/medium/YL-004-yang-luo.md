---
ID: "YL-004"
Title: "Zero enforcement wired anywhere: no endpoint in the repo uses RequirePermission"
Level: medium
Category: "security"
Status: ready-for-agent
Package: "qadi"
Source: "packages/qadi/src/SubjectApi.ts:45"
Auditor: "yang-luo"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# YL-004 — Zero enforcement wired anywhere: no endpoint in the repo uses RequirePermission

`MEDIUM` · `security` · `qadi` · reported by **Yang Luo — Creator of Casbin** (`yang-luo`)

Status: **ready-for-agent**

## Summary

The only middleware the monorepo attaches is AuthorizedSubject, which propagates a subject and enforces nothing; grep across packages/ and examples/ finds RequirePermission/requiresPermission only in doc comments. Enforcement is therefore fail-open by default at the route level: a developer who forgets one requiresPermission call ships an unprotected endpoint, and the shipped example app demonstrates zero protected business routes. @qadi/http mitigates with publicEndpoint declarations and a permission registry route, but nothing in awthaq exercises either, so the framework's advertised authorization boundary is unproven on its own surface.

## Evidence

Source: `packages/qadi/src/SubjectApi.ts:45`

```
  .middleware(AuthorizedSubject)
  .middleware(Api.OptionalAuthentication);
```

## Recommended fix

Attach requiresPermission to at least one representative endpoint in the example server (and in an admin route), wire the permission-registry audit into the example's startup, and consider an Auth.make option that requires every non-public group endpoint to carry either a permission or a publicEndpoint declaration.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: Authorization modeling
- Full dossier: [`yang-luo`](../../.reports/yang-luo/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AAPS-008` — SubjectDto exposes only subject-embedded attributes, hiding resolver-resolved ones from clients](low/AAPS-008-abac-attribute-policy-specialist.md) `_(abac-attribute-policy-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `qadi-bridge-hardening`. Evidence at HEAD ec065a7: `packages/qadi/src/SubjectApi.ts:45`. Fix: Dogfood enforcement on the shipped surface and make an un-annotated endpoint detectable at startup. (effort L). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.
