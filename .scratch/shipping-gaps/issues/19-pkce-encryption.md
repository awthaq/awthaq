# 19 — PKCE verifier/nonce encryption

**What to build:** PKCE verifier/nonce state is encrypted wherever it's
persisted — in the `__Host-oauth-state` cookie and in the `Verification`
`FlowPayload` — using the same encryption service as provider tokens.

**Blocked by:** 17, 18

**Status:** ready-for-agent

- [ ] The encryption service from ticket 18 is called from both the SQL
      persistence path and the cookie/`FlowPayload` path, proving it's
      genuinely shared rather than duplicated
- [ ] PKCE verifier/nonce values are ciphertext in the
      `__Host-oauth-state` cookie and in any persisted `FlowPayload`
- [ ] Round-trip test: an OAuth flow using an encrypted PKCE value still
      completes correctly end-to-end
- [ ] A test asserts the cookie's raw PKCE-carrying value is not the
      plaintext verifier/nonce
