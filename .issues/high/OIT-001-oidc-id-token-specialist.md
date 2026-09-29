---
ID: "OIT-001"
Title: "Userinfo claims override the signed id_token with no sub cross-check"
Level: high
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:612"
Auditor: "oidc-id-token-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OIT-001 — Userinfo claims override the signed id_token with no sub cross-check

`HIGH` · `security` · `oauth` · reported by **OIDC ID Token Specialist** (`oidc-id-token-specialist`)

Status: **resolved**

## Summary

When the provider publishes a userinfo endpoint, its response is merged over the verified id_token claims and wins on every overlap (the preceding comment explicitly justifies this as 'the more current of the two'). OIDC Core 5.3.2 makes this a MUST: the sub in the UserInfo response MUST exactly match the id_token sub, and if it does not, the UserInfo values MUST NOT be used. There is no comparison anywhere. profile.subject — which keys accounts.findByProviderSubject and account linking (OAuth.ts:614-620) — can silently come from the unsigned-ish userinfo response instead of the signed token, and this is precisely the persona red flag: treating userinfo as more authoritative than the id_token without justification. Under provider-side drift or misconfiguration, account bindings silently re-anchor onto a different subject.

## Evidence

Source: `packages/oauth/src/OAuth.ts:612`

```
const profile = provider.mapProfile({ ...idClaims, ...userinfoClaims });
```

## Recommended fix

After fetching userinfoClaims, compare userinfoClaims["sub"] to claims["sub"] from the verified id_token; on mismatch fail with OAuthCallbackFailed (or at minimum drop userinfo claims entirely and proceed on id_token claims alone). Add a regression test with an okta provider whose discovery advertises a userinfo_endpoint returning a different sub.

## Context

- Auditor verdict on this domain: **needs-work** (score 61/100), domain: OIDC id_token validation
- Full dossier: [`oidc-id-token-specialist`](../../.reports/oidc-id-token-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 7 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — packages/oauth/src/OAuth.ts:612 still reads `const profile = provider.mapProfile({ ...idClaims, ...userinfoClaims });` exactly as quoted, with userinfo spread last so it wins on key overlap. `idClaims` comes from `verifyIdToken` (line 590) and `userinfoClaims` from the provider's userinfo endpoint (lines 598-610); a grep of the whole file for `"sub"`/`.sub`/`userinfoClaims`/`idClaims` shows no comparison between the two anywhere, and `profile.subject` (from the merged object) feeds `accounts.findByProviderSubject` at line 614-620, so a mismatched userinfo `sub` would silently re-anchor account lookup/linking. No OIDC Core 5.3.2 sub equality check exists in this flow or any nearby helper. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `oauth-oidc-claims-integrity`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:717`. Fix: For oidc providers, fail when userinfo.sub differs from the verified id_token sub, and let the signed id_token win for identity-bearing claims (sub, email, email_verified). userinfo only enriches the profile. (effort M). Full dossier: `.plan/slices/03-oauth-flow.md`.

**Resolved (2026-09-29):** For `oidc` providers the userinfo `sub` must now equal the verified id_token `sub` (mismatch → `OAuthCallbackFailed`, nothing created/linked), and `sub`/`email`/`email_verified` are taken from the signed id_token whenever it carries them (`mergeClaims` in `packages/oauth/src/OAuth.ts`); userinfo only enriches (name etc.). The userinfo body is now decoded with a Schema (`UserinfoSchema`) instead of a `body as Record<string, unknown>` cast. Spec: BEH-EA-127 gains a claim-precedence paragraph. TDD: `packages/oauth/test/OAuth.test.ts` — 'OIT-001: a userinfo response whose sub differs…is rejected' and '…id_token's email_verified wins over userinfo for the trusted auto-link decision' (both confirmed red before the fix), plus an enrichment regression guard. Gates: typecheck, test (812), test:bdd (104), spec:verify:strict green. Note: the dossier's optional BDD scenario is deferred (needs new step infrastructure).
