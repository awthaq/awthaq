# ADR-EA-019: Encryption-at-Rest Keys Rotate by Retirement, With Lazy Re-Encryption

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-019 |
> | Revision | 1.2 |
> | Effective Date | 2026-10-13 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-29): Initial release (KRS-002, ACS-008, SMS-005; wayfinder ticket 22) <br> 1.1 (2026-10-13): Decision 6: one sealed-column interface for plugin columns, lazy re-seal, typed Unreadable, sweep (plan 05) <br> 1.2 (2026-10-14): Decision 6: the legacy-AAD read is removed (plan 05 phase 14); `legacyAad` and the Legacy AAD column are gone, and the old spellings no longer open |

---

## Context

`@awthaq/ports`' `Encryption` (AES-256-GCM) wraps a swappable `KeyProvider`. Every envelope records the `kid` it was written under, but the only shipped `KeyProvider.layerEnv` held exactly one key, so `getKey` on any other `kid` failed `UnknownKeyId`: rotating `AWTHAQ_ENCRYPTION_KEY_ID` orphaned every existing ciphertext (provider tokens, PKCE state, and now the JWT signing keys). Envelope version and `kid` were also unauthenticated (only the caller's `aad` reached GCM).

## Decision

1. **`KeyProvider.layerEnv` reads a keyset.** `AWTHAQ_ENCRYPTION_KEYS` is a JSON array of `{ kid, key }` (`key` base64, exactly 32 bytes; at least one entry; no duplicate `kid`). `AWTHAQ_ENCRYPTION_KEY_ID` names the entry that is `currentKey` and is required with a keyset (no `"env"` default, and it must name a kid in the set). `getKey(kid)` is a lookup over the whole set. Misconfiguration dies at layer build. The pre-keyset single-key form (`AWTHAQ_ENCRYPTION_KEY`) is still read when `AWTHAQ_ENCRYPTION_KEYS` is unset, as a one-entry keyset that cannot rotate.
2. **Retirement, not a grace window.** A retired key stays decryptable for as long as any envelope written under it exists. There is no timer: the operator (a) rotates `AWTHAQ_ENCRYPTION_KEY_ID` to a new kid, leaving the old entry in the keyset, (b) waits until nothing references the old kid, (c) removes the entry. This is deliberately different from JWT signing-key rotation, whose retired keys are dropped after a grace period sized to the maximum token lifetime (ADR-EA-017). The two models must not be conflated.
3. **Lazy re-encryption.** `Encryption.decrypt` succeeds with `{ plaintext, staleKid }`. `staleKid` is `Some(kid)` when the envelope was written under a key other than `currentKey`, or in the legacy v1 format; callers re-`encrypt` and persist on the next successful read (the `PasswordHasher.needsRehash` convention). Batch re-encryption of rows that are never read again is an operational job on the consumer side and out of scope here.
4. **Envelope v2 binds `v` and `kid` into the GCM additional data** (`awthaq-enc:v2:<len(kid)>:<kid>:<aad>`), so rewriting either field fails authentication even when the substituted key would otherwise decrypt. v1 envelopes remain decryptable and are always reported stale, so they upgrade to v2 through decision 3.
5. **Key-byte hygiene.** `Encryption.layer` imports one non-extractable `CryptoKey` per (kid, usage) instead of unwrapping the raw bytes on every call, and zeroes the transient copy passed to WebCrypto. JavaScript cannot guarantee zeroization and `Redacted` only prevents accidental logging, so production deployments that must not hold raw key bytes in-process implement `KeyProvider` over a KMS/HSM.
6. **One sealed-column interface (plan 05).** A plugin declares an encrypted table column once (`@awthaq/sql` `SealedColumn.column`) and its records hand out `Sealed<A>` values whose `open` effect is the only place a plaintext appears. The AAD is `<table>:<rowKey>:<column>` (matching core's `<entity>:<id>:<field>` shape); there is one spelling and no fallback: an envelope sealed under any older spelling (`webhooks-endpoint:`, `organization-oauth-connection:`, `saml-sp-key:`, `two_factor_secret:<id>` without the field suffix) no longer opens (revision 1.2). Decision 3 now ships for plugin columns: when `staleKid` is set, `open` writes the fresh envelope back by compare-and-swap on the stored value (a concurrent writer always wins; a lost or failed swap is logged with ids only and never fails the read; `SealedColumnConfig.resealOnRead: false` opts out). A value that does not open is the typed `SealedColumn/Unreadable` (`DecryptionFailed`, `UnknownKeyId` or `Malformed`), never `null` and never a defect, and each call site chooses exactly one treatment: `SealedColumn.orDie` (fail closed, for a signing key or a TOTP secret) or `SealedColumn.option` (degrade one value with a warning). `SealedColumn.sweep` is the operator's batch job that re-seals every stale value of a column (key rotation); `SealedColumn.sweepAll` runs it over a list of columns and logs one summary per column; it narrows decision 3's "batch is out of scope": the library ships the job, and running it stays operational. Core's own columns keep their formats and null-and-warn policy and run on the same primitive (`SealedColumn.reveal`).

| Plugin column | Canonical AAD | Unreadable treatment |
|---|---|---|
| `webhooks_endpoint.secret` | `webhooks_endpoint:<id>:secret` | `option`: the attempt fails as `secret` |
| `webhooks_endpoint.previousSecret` | `webhooks_endpoint:<id>:previousSecret` | `option`: dropped |
| `webhooks_endpoint.headers` | `webhooks_endpoint:<id>:headers` | `option`: no custom headers |
| `organization_oauth_connection.clientSecret` | `organization_oauth_connection:<id>:clientSecret` | `option`: the connection is dropped alone |
| `saml_sp_key.privateKey` | `saml_sp_key:<id>:privateKey` | `orDie` |
| `jwt_signing_key.privateKeyJwk` | `jwt_signing_key:<kid>:privateKeyJwk` | `orDie` |
| `two_factor_secret.secret` | `two_factor_secret:<userId>:secret` | `orDie` |

**Revision 1.2: the legacy-AAD read is removed.** Decision 6 first shipped with `legacyAad` fallbacks and `SealedColumn.sweepAll` so an operator could re-seal old spellings; the fallback is now deleted, in the same unreleased batch, and values are sealed under the canonical AAD only. Recorded reasons:

- **Timing.** No git tags exist, every package is 0.1.0, and neither sealed columns nor `sweepAll` has shipped, so no outside operator can hold rows sealed under an old spelling. The plan's "one minor release has shipped" criterion is vacuous and is waived. Caveat: an internal environment running a pre-release build with sealed rows must run `SealedColumn.sweepAll` before upgrading.
- **Gate.** No reference deployment exists (the examples are private). The criterion was replaced by an executable gate test (a second `sweepAll` reports `legacy: 0`), kept until the removal commit deleted it; sign-off is the maintainer's. There is no boot-time gate.
- **No `awthaq migration reseal` CLI.** `packages/cli` only has `migration status/apply`; re-sealing stays a library effect. Revisit only if a real operator asks.
- **`unreadable` rows.** The library never deletes them (`sweep` does not touch them; deleting would destroy a signing key or a TOTP secret). A row formerly sealed under an old spelling now fails `DecryptionFailed` on the canonical AAD and surfaces as the existing typed `SealedColumn/Unreadable` (ids and reason only), and each call site keeps its treatment (`orDie` for `saml_sp_key.privateKey` and `two_factor_secret.secret`; `option` for the webhook secrets and headers and `organization_oauth_connection.clientSecret`). The warning of `SealedColumn.option` gains a hint: it may be sealed under a retired legacy AAD; restore from backup or re-enter the secret. No new error shape.
- **`adoptPlaintext` stays.** It is the plaintext-to-sealed migration for core PII, not a legacy-AAD mechanism: a permanent explicit opt-in. `reveal` keeps it; only its `legacyAad` option goes. Its own sunset is a separate ticket, gated on a future `plaintext` count in `SweepReport`.
- **`legacy: 0` was advisory.** No boot gate. If a hard gate is ever wanted, it is a read-only `SealedColumn.countLegacy` (not built).

**Data-loss note.** Nothing is deleted. A row still sealed under an old spelling stops opening after this revision; rolling back or restoring a backup and running the sweep recovers it.

## Consequences

**Positive**: rotating the current kid no longer orphans data; stale rows migrate as they are read; envelope tampering across kid/version is detected.

**Negative**: `Encryption.decrypt`'s success type changed (breaking, accepted: pre-release library). A retired key must be kept in the keyset until an operator has verified nothing references it.
