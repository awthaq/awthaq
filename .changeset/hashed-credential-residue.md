---
"@awthaq/core": patch
"@awthaq/scim": patch
"@awthaq/organization": patch
"@awthaq/saml": patch
"@awthaq/ports": patch
---

SCIM tokens, organization invitation tokens and verification values are now hashed through `SecretHash.digest`, and every hex encoding goes through `Hmac.toHex`. The stored hashes are byte-identical (pinned by known-answer tests), so existing tokens, invitations and imported scrypt passwords keep working.

Migration: none.
