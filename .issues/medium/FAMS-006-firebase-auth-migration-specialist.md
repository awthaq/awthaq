---
ID: "FAMS-006"
Title: "Provider-subject mismatches in imported links silently JIT-duplicate accounts"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:686"
Auditor: "firebase-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# FAMS-006 — Provider-subject mismatches in imported links silently JIT-duplicate accounts

`MEDIUM` · `correctness` · `oauth` · reported by **Firebase Auth Migration Specialist** (`firebase-auth-migration-specialist`)

Status: **ready-for-agent**

## Summary

Preserving Google/Apple linkage from Firebase depends on the importer writing the exact (providerId, subject, issuer) triple the callback will later look up (packages/oauth/src/OAuth.ts:614-620). Firebase exports providerUid/providerId per user and has no issuer concept; if an importer writes the Firebase uid as subject or omits the issuer the oauth plugin resolves under, the first post-migration sign-in misses the link and falls through: auto-link by email only when the provider is in trustedProviders AND the provider asserts emailVerified (packages/oauth/src/OAuth.ts:650-657), otherwise a brand-new duplicate user with a synthetic email. That failure mode is silent — the user ends up with two accounts and their history split.

## Evidence

Source: `packages/oauth/src/OAuth.ts:686`

```
const user = yield* users
  .create({ email: profile.email ?? `${providerId}:${profile.subject}`, name })
  .pipe(
```

## Recommended fix

Document the exact import recipe: providerId must equal the effect-auth oauth provider id, subject must be the Firebase providerUid, issuer must be the same Option the provider carries. Add an import-time dry-run that replays findByProviderSubject for every exported federated identity and reports rows that would fall through to autoLink/JIT.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: Firebase migration parity
- Full dossier: [`firebase-auth-migration-specialist`](../../.reports/firebase-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-001` — Scheme-relative //host callbackURL bypasses the trusted-origin allowlist (open redirect)](high/AP-001-aaron-parecki.md) `_(aaron-parecki, high)_`
- [`AP-003` — id_token aud accepted only as an exact string; array-form audiences rejected](medium/AP-003-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-004` — Userinfo claims merged over id_token claims without the required sub equality check](medium/AP-004-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-006` — Token endpoint auth hardwired to client_secret_post; basic unsupported and discovery metadata ignored](medium/AP-006-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-008` — Provider-controlled discovery and JWKS documents consumed via unchecked casts; JWKS cache never expires](low/AP-008-aaron-parecki.md) `_(aaron-parecki, low)_`
- [`AH-002` — JWKS response cast wholesale with as unknown as and cached unvalidated](medium/AH-002-anders-hejlsberg.md) `_(anders-hejlsberg, medium)_`
- [`AGA-001` — OAuth callback rate limiting collapses to one global 20/min bucket behind any gateway or load balancer](high/AGA-001-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, high)_`
- [`AGA-005` — redirect_uri is config-derived only: spoof-proof against gateway Host headers, but silently breaks when baseUrl lags the public URL](low/AGA-005-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, low)_`
- … 65 more findings touch `packages/oauth/src/OAuth.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `oauth-account-linking-policy`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:719`. Fix: Document the exact federated-identity import recipe now. Defer the dry-run tool to the CLI import work. (effort S). Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-agent.
