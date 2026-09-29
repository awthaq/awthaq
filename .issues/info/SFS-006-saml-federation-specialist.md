---
ID: "SFS-006"
Title: "SSO facade vs standalone Saml plugin dispatch is undecided"
Level: info
Category: "api"
Status: resolved
Package: "—"
Source: "spec/models/09-sso.md:65"
Auditor: "saml-federation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SFS-006 — SSO facade vs standalone Saml plugin dispatch is undecided

`INFO` · `api` · `—` · reported by **SAML Federation Specialist** (`saml-federation-specialist`)

Status: **resolved**

## Summary

The dispatch decision determines the public API surface (BEH-EA-004 confines a plugin's contract groups to its own id or a dotted sub-id, so sso.* vs saml routes are a real fork), the dependsOn graph, and the connection-resolver port shape. The 09-sso row is additionally blocked on Organization becoming normative (its dependsOn [Sessions, Users, Organization] is flagged unresolved at 09-sso.md:52-59), so neither enterprise row can harden until this is settled.

## Evidence

Source: `spec/models/09-sso.md:65`

```
no decision on whether SSO wraps SAML and OIDC-based enterprise connections under one plugin or dispatches to the separate `Saml`/`OAuth` plugins underneath
```

## Recommended fix

Decide before either spec row is promoted: standalone Saml plugin behind an Sso connection resolver is the lower-coupling shape; document the choice as an ADR with the group-naming consequence spelled out.

## Context

- Auditor verdict on this domain: **needs-work** (score 46/100), domain: SAML Federation
- Full dossier: [`saml-federation-specialist`](../../.reports/saml-federation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 14 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `enterprise-federation-saml-scim`. Evidence at HEAD ec065a7: `spec/models/09-sso.md:65`. Fix: Record the dispatch shape implied by decisions 08 and 18 in ADR-EA-019: standalone `Saml` and `OAuth` plugins own their protocol routes; `Sso` is a thin connection-resolver plugin (routes under `sso.*`) that resolves an organization's connection (by email domain or org id) and redirects into the owning plugin. (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Recorded in ADR-EA-023 Decision 4 and spec/models/09-sso.md: Saml and OAuth stay standalone plugins that own saml.* and oauth.* routes; Sso is a thin connection-resolver plugin (sso.* routes, POST /auth/sso/start { email | organizationId }) that resolves the organization connection and redirects into the owning plugin. The resolver half already exists (OrganizationConnectionStore.discover, BEH-EA-230). The open-question sentence in 09-sso.md is replaced with what exists and what is decided.
