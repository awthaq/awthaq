# ADR-EA-019: Encryption-at-Rest Keys Rotate by Retirement, With Lazy Re-Encryption

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-019 |
> | Revision | 1.3 |
> | Effective Date | 2026-10-18 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-29): Initial release (KRS-002, ACS-008, SMS-005; wayfinder ticket 22) <br> 1.1 (2026-10-13): Decision 6: one sealed-column interface for plugin columns, lazy re-seal, typed Unreadable, sweep (plan 05) <br> 1.2 (2026-10-14): Decision 6: the legacy-AAD read is removed (plan 05 phase 14); `legacyAad` and the Legacy AAD column are gone, and the old spellings no longer open <br> 1.3 (2026-10-18): Decision 6 covers core's six columns (plan 17): `CoreSealedColumns`, the core store ports carry `Sealed` values, a third treatment (a typed domain failure), `SealedColumn.Deployed` and `sweepDeployed`, `sqlSwap` in a savepoint; `AccountsRepositoryConfig` is removed |

---

## Context

`@awthaq/ports`' `Encryption` (AES-256-GCM) wraps a swappable `KeyProvider`. Every envelope records the `kid` it was written under, but the only shipped `KeyProvider.layerEnv` held exactly one key, so `getKey` on any other `kid` failed `UnknownKeyId`: rotating `AWTHAQ_ENCRYPTION_KEY_ID` orphaned every existing ciphertext (provider tokens, PKCE state, and now the JWT signing keys). Envelope version and `kid` were also unauthenticated (only the caller's `aad` reached GCM).

## Decision

1. **`KeyProvider.layerEnv` reads a keyset.** `AWTHAQ_ENCRYPTION_KEYS` is a JSON array of `{ kid, key }` (`key` base64, exactly 32 bytes; at least one entry; no duplicate `kid`). `AWTHAQ_ENCRYPTION_KEY_ID` names the entry that is `currentKey` and is required with a keyset (no `"env"` default, and it must name a kid in the set). `getKey(kid)` is a lookup over the whole set. Misconfiguration dies at layer build. The pre-keyset single-key form (`AWTHAQ_ENCRYPTION_KEY`) is still read when `AWTHAQ_ENCRYPTION_KEYS` is unset, as a one-entry keyset that cannot rotate.
2. **Retirement, not a grace window.** A retired key stays decryptable for as long as any envelope written under it exists. There is no timer: the operator (a) rotates `AWTHAQ_ENCRYPTION_KEY_ID` to a new kid, leaving the old entry in the keyset, (b) waits until nothing references the old kid, (c) removes the entry. This is deliberately different from JWT signing-key rotation, whose retired keys are dropped after a grace period sized to the maximum token lifetime (ADR-EA-017). The two models must not be conflated.
3. **Lazy re-encryption.** `Encryption.decrypt` succeeds with `{ plaintext, staleKid }`. `staleKid` is `Some(kid)` when the envelope was written under a key other than `currentKey`, or in the legacy v1 format; callers re-`encrypt` and persist on the next successful read (the `PasswordHasher.needsRehash` convention). Batch re-encryption of rows that are never read again is an operational job on the consumer side and out of scope here.
4. **Envelope v2 binds `v` and `kid` into the GCM additional data** (`awthaq-enc:v2:<len(kid)>:<kid>:<aad>`), so rewriting either field fails authentication even when the substituted key would otherwise decrypt. v1 envelopes remain decryptable and are always reported stale, so they upgrade to v2 through decision 3.
5. **Key-byte hygiene.** `Encryption.layer` imports one non-extractable `CryptoKey` per (kid, usage) instead of unwrapping the raw bytes on every call, and zeroes the transient copy passed to WebCrypto. JavaScript cannot guarantee zeroization and `Redacted` only prevents accidental logging, so production deployments that must not hold raw key bytes in-process implement `KeyProvider` over a KMS/HSM.
6. **One sealed-column interface (plan 05).** A plugin declares an encrypted table column once (`@awthaq/sql` `SealedColumn.column`) and its records hand out `Sealed<A>` values whose `open` effect is the only place a plaintext appears. The AAD is `<table>:<rowKey>:<column>` (plugin and core columns alike, revision 1.3); there is one spelling and no fallback: an envelope sealed under any older spelling (`webhooks-endpoint:`, `organization-oauth-connection:`, `saml-sp-key:`, `two_factor_secret:<id>` without the field suffix) no longer opens (revision 1.2). Decision 3 now ships for plugin columns: when `staleKid` is set, `open` writes the fresh envelope back by compare-and-swap on the stored value (a concurrent writer always wins; a lost or failed swap is logged with ids only and never fails the read; `SealedColumnConfig.resealOnRead: false` opts out). A value that does not open is the typed `SealedColumn/Unreadable` (`DecryptionFailed`, `UnknownKeyId` or `Malformed`), never `null` and never a defect, and each call site chooses exactly one treatment: `SealedColumn.orDie` (fail closed, for a signing key or a TOTP secret), `SealedColumn.option` / `Sealed.optional` (degrade one value with a warning), or, since revision 1.3, map it to the domain's own typed failure (provider tokens: `ProviderTokensUnreadable`, "re-consent"). `SealedColumn.sweep` is the operator's batch job that re-seals every stale value of a column (key rotation); `SealedColumn.sweepAll` runs it over a list of columns and logs one summary per column; `SealedColumn.sweepDeployed` runs it over the columns a composition seals (`Persistence.sql(options)` provides `SealedColumn.Deployed`) plus the caller's own; it narrows decision 3's "batch is out of scope": the library ships the job, and running it stays operational. ~~Core's own columns keep their formats and null-and-warn policy and run on the same primitive (`SealedColumn.reveal`).~~ *Superseded by revision 1.3:* core's columns are declared too (`CoreSealedColumns`), under the same AAD; the core store ports carry `Sealed` values (`@awthaq/ports` `Sealed`) and the domain picks the treatment.

| Plugin column | Canonical AAD | Unreadable treatment |
|---|---|---|
| `webhooks_endpoint.secret` | `webhooks_endpoint:<id>:secret` | `option`: the attempt fails as `secret` |
| `webhooks_endpoint.previousSecret` | `webhooks_endpoint:<id>:previousSecret` | `option`: dropped |
| `webhooks_endpoint.headers` | `webhooks_endpoint:<id>:headers` | `option`: no custom headers |
| `organization_oauth_connection.clientSecret` | `organization_oauth_connection:<id>:clientSecret` | `option`: the connection is dropped alone |
| `saml_sp_key.privateKey` | `saml_sp_key:<id>:privateKey` | `orDie` |
| `jwt_signing_key.privateKeyJwk` | `jwt_signing_key:<kid>:privateKeyJwk` | `orDie` |
| `two_factor_secret.secret` | `two_factor_secret:<userId>:secret` | `orDie` |
| `users.metadata` (`encryptPii`) | `users:<id>:metadata` | `Sealed.optional`: absent |
| `sessions.ipAddress` (`encryptPii`) | `sessions:<id>:ipAddress` | `Sealed.optional`: absent |
| `sessions.userAgent` (`encryptPii`) | `sessions:<id>:userAgent` | `Sealed.optional`: absent |
| `accounts.accessToken` | `accounts:<id>:accessToken` | `ProviderTokensUnreadable` (re-consent) |
| `accounts.refreshToken` | `accounts:<id>:refreshToken` | `ProviderTokensUnreadable` |
| `accounts.idToken` | `accounts:<id>:idToken` | `ProviderTokensUnreadable` |

**Revision 1.2: the legacy-AAD read is removed.** Decision 6 first shipped with `legacyAad` fallbacks and `SealedColumn.sweepAll` so an operator could re-seal old spellings; the fallback is now deleted, in the same unreleased batch, and values are sealed under the canonical AAD only. Recorded reasons:

- **Timing.** No git tags exist, every package is 0.1.0, and neither sealed columns nor `sweepAll` has shipped, so no outside operator can hold rows sealed under an old spelling. The plan's "one minor release has shipped" criterion is vacuous and is waived. Caveat: an internal environment running a pre-release build with sealed rows must run `SealedColumn.sweepAll` before upgrading.
- **Gate.** No reference deployment exists (the examples are private). The criterion was replaced by an executable gate test (a second `sweepAll` reports `legacy: 0`), kept until the removal commit deleted it; sign-off is the maintainer's. There is no boot-time gate.
- **No `awthaq migration reseal` CLI.** `packages/cli` only has `migration status/apply`; re-sealing stays a library effect. Revisit only if a real operator asks.
- **`unreadable` rows.** The library never deletes them (`sweep` does not touch them; deleting would destroy a signing key or a TOTP secret). A row formerly sealed under an old spelling now fails `DecryptionFailed` on the canonical AAD and surfaces as the existing typed `SealedColumn/Unreadable` (ids and reason only), and each call site keeps its treatment (`orDie` for `saml_sp_key.privateKey` and `two_factor_secret.secret`; `option` for the webhook secrets and headers and `organization_oauth_connection.clientSecret`). The warning of `SealedColumn.option` gains a hint: it may be sealed under a retired legacy AAD; restore from backup or re-enter the secret. No new error shape.
- **`adoptPlaintext` stays.** It is the plaintext-to-sealed migration for core PII, not a legacy-AAD mechanism: a permanent explicit opt-in. `reveal` keeps it; only its `legacyAad` option goes. Its own sunset is a separate ticket, gated on a future `plaintext` count in `SweepReport`.
- **`legacy: 0` was advisory.** No boot gate. If a hard gate is ever wanted, it is a read-only `SealedColumn.countLegacy` (not built).

**Revision 1.3: core columns.** Plan 05 left core's six sealed columns on hand-written copies of the mechanism, and three live bugs followed. Recorded reasons and consequences:

- **Reasons.** (1) Following the runbook with a hand-declared core column made `sweep` count every healthy row `unreadable` and re-seal every plaintext row under an AAD the repository never read, so `users.metadata` read as `null`. (2) The provider-token AAD `<providerId>:<userId>:<field>` bound no account, so a token copied between two same-provider accounts of one user opened. (3) Nothing could sweep core rows, so a retired key could never be dropped safely for rows nobody reads.
- **The previous core spellings stop opening** (`user:<id>:metadata`, `session:<id>:<field>`, `<providerId>:<userId>:<field>`), with the same timing argument as revision 1.2 (no tags, everything 0.1.0, ADR-EA-034 decision 2) and the same caveat: an internal environment with sealed core rows either accepts re-consent (tokens heal on the next OAuth sign-in) and the loss of sealed `users.metadata`/session PII, or runs a one-off re-key it writes for itself. A shipped `SealedColumn.rekey` was considered and not built: no named environment needs it.
- **Rejected: a per-column AAD hook** that keeps each core column's historical spelling. It brings back the per-column spellings revision 1.2 deleted, so "one convention" would hold only by convention; `aadOf`, `sweep` and every future tool would have to thread the hook; and for tokens it keeps bug (2).
- **The unreadable decision moves to the domain.** The core store ports carry `Sealed` values for the six columns, so the meaning of a value that does not open is chosen where it is known: session PII and user metadata degrade (absent plus a warning), provider tokens fail typed. This adds a third sanctioned treatment to decision 6 (map `Unreadable` to the domain's own typed failure), because `orDie` would be a defect for an outage of trust in one row and `option` would be a silent "no tokens".
- **One re-seal switch.** `AccountsRepositoryConfig.reencryptOnRead` is removed; `SealedColumnConfig.resealOnRead` is the one switch. `sqlSwap` runs in a savepoint (`SqlTransaction.transactional`), so a failed re-seal inside a caller's Postgres transaction rolls back only itself.
- **Plugins declare theirs.** `AuthPlugin.Service` takes `sealedColumns`; `Auth.make` refuses a column on a table the plugin does not own or declared twice, and `auth.sealedColumns` is the `also` of the post-rotation sweep.
- **`Deployed`.** `Persistence.sql(options)` provides `SealedColumn.Deployed`, built from the same `options` that choose its repositories (three columns with `encryptPii` off, six with it on); a function the operator calls with options of their own would reproduce bug (1).

**Data-loss note.** Nothing is deleted. A row still sealed under an old spelling stops opening after this revision; rolling back or restoring a backup and running the sweep recovers it.

## Consequences

**Positive**: rotating the current kid no longer orphans data; stale rows migrate as they are read; envelope tampering across kid/version is detected.

**Negative**: `Encryption.decrypt`'s success type changed (breaking, accepted: pre-release library). A retired key must be kept in the keyset until an operator has verified nothing references it. Rows sealed under the pre-1.3 core spellings no longer open.
