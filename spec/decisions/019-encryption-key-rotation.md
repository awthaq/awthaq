# ADR-EA-019: Encryption-at-Rest Keys Rotate by Retirement, With Lazy Re-Encryption

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-019 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-29): Initial release (KRS-002, ACS-008, SMS-005; wayfinder ticket 22) |

---

## Context

`@awthaq/ports`' `Encryption` (AES-256-GCM) wraps a swappable `KeyProvider`. Every envelope records the `kid` it was written under, but the only shipped `KeyProvider.layerEnv` held exactly one key, so `getKey` on any other `kid` failed `UnknownKeyId`: rotating `AWTHAQ_ENCRYPTION_KEY_ID` orphaned every existing ciphertext (provider tokens, PKCE state, and now the JWT signing keys). Envelope version and `kid` were also unauthenticated (only the caller's `aad` reached GCM).

## Decision

1. **`KeyProvider.layerEnv` reads a keyset.** `AWTHAQ_ENCRYPTION_KEYS` is a JSON array of `{ kid, key }` (`key` base64, exactly 32 bytes; at least one entry; no duplicate `kid`). `AWTHAQ_ENCRYPTION_KEY_ID` names the entry that is `currentKey` and is required with a keyset (no `"env"` default, and it must name a kid in the set). `getKey(kid)` is a lookup over the whole set. Misconfiguration dies at layer build. The pre-keyset single-key form (`AWTHAQ_ENCRYPTION_KEY`) is still read when `AWTHAQ_ENCRYPTION_KEYS` is unset, as a one-entry keyset that cannot rotate.
2. **Retirement, not a grace window.** A retired key stays decryptable for as long as any envelope written under it exists. There is no timer: the operator (a) rotates `AWTHAQ_ENCRYPTION_KEY_ID` to a new kid, leaving the old entry in the keyset, (b) waits until nothing references the old kid, (c) removes the entry. This is deliberately different from JWT signing-key rotation, whose retired keys are dropped after a grace period sized to the maximum token lifetime (ADR-EA-017). The two models must not be conflated.
3. **Lazy re-encryption.** `Encryption.decrypt` succeeds with `{ plaintext, staleKid }`. `staleKid` is `Some(kid)` when the envelope was written under a key other than `currentKey`, or in the legacy v1 format; callers re-`encrypt` and persist on the next successful read (the `PasswordHasher.needsRehash` convention). Batch re-encryption of rows that are never read again is an operational job on the consumer side and out of scope here.
4. **Envelope v2 binds `v` and `kid` into the GCM additional data** (`awthaq-enc:v2:<len(kid)>:<kid>:<aad>`), so rewriting either field fails authentication even when the substituted key would otherwise decrypt. v1 envelopes remain decryptable and are always reported stale, so they upgrade to v2 through decision 3.
5. **Key-byte hygiene.** `Encryption.layer` imports one non-extractable `CryptoKey` per (kid, usage) instead of unwrapping the raw bytes on every call, and zeroes the transient copy passed to WebCrypto. JavaScript cannot guarantee zeroization and `Redacted` only prevents accidental logging, so production deployments that must not hold raw key bytes in-process implement `KeyProvider` over a KMS/HSM.

## Consequences

**Positive**: rotating the current kid no longer orphans data; stale rows migrate as they are read; envelope tampering across kid/version is detected.

**Negative**: `Encryption.decrypt`'s success type changed (breaking, accepted: pre-release library). A retired key must be kept in the keyset until an operator has verified nothing references it.
