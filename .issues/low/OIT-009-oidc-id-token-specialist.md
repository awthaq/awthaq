---
ID: "OIT-009"
Title: "id_token test suite omits alg confusion, kid rotation, azp/array-aud, and userinfo sub mismatch"
Level: low
Category: "testing"
Status: resolved
Package: "oauth"
Source: "packages/oauth/test/OAuth.test.ts:784"
Auditor: "oidc-id-token-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OIT-009 — id_token test suite omits alg confusion, kid rotation, azp/array-aud, and userinfo sub mismatch

`LOW` · `testing` · `oauth` · reported by **OIDC ID Token Specialist** (`oidc-id-token-specialist`)

Status: **resolved**

## Summary

The suite is genuinely strong on what it covers — real RSA keypairs, real signature verification, per-flow nonce capture from the authorize redirect — with five scenarios (valid token, tampered signature, wrong iss, expired, wrong nonce). But every scenario uses the same single-key JWKS, string aud, and no userinfo endpoint on the oidc provider (oktaDiscovery publishes no userinfo_endpoint), so none of the findings above (OIT-001/002/003/006) could ever fail a test today. The discovery issuer mismatch is the only boot-path id_token-adjacent test.

## Evidence

Source: `packages/oauth/test/OAuth.test.ts:784`

```
describe("OIDC id_token: real RS256 signature + claim verification", () => {
```

## Recommended fix

Add scenarios: header alg HS256/none rejected; token whose kid is absent from a cached JWKS that still contains an older RSA key (currently fails only by signature accident — pin the refetch behavior once OIT-002 lands); userinfo sub differing from id_token sub (currently passes — should fail once OIT-001 lands); array aud containing clientId accepted; azp mismatch rejected.

## Context

- Auditor verdict on this domain: **needs-work** (score 61/100), domain: OIDC id_token validation
- Full dossier: [`oidc-id-token-specialist`](../../.reports/oidc-id-token-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 7 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`PDR-006` — CallbackURL validation tests never exercise protocol-relative or backslash variants](low/PDR-006-philippe-de-ryck.md) `_(philippe-de-ryck, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `oauth-oidc-claims-integrity`. Evidence at HEAD ec065a7: `packages/oauth/test/OAuth.test.ts:1056`. Fix: Add the remaining negative scenarios. Most arrive as the red-first tests of OIT-001 and OIT-003, and alg confusion is added standalone. (effort S). Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Negative scenarios added to the OIDC id_token describe: alg HS256 signed with the RSA modulus as HMAC key and alg:none are rejected (pins: both already failed at the RS256 gate), plus array aud/azp (OIT-003), userinfo sub mismatch (OIT-001) and kid rotation (fd8e5e9) already covered. Gates as MA-002.
