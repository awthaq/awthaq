# ADR-EA-017: JWT Signing Keys Rotate on a Grace Period Sized to Token Lifetime, With an Emergency Retire-Now Path

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-017 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-29): Initial release (KRS-008, JJS-004, KRS-006, JJS-003, N12) |

---

## Context

`@awthaq/jwt` signs short-lived tokens with a key held in the `jwt_signing_key` table and publishes the public halves as a JWKS. A signing key that lives forever is a liability, so keys rotate; but every token a key signed stays valid until its own `exp`, and verifiers cache the JWKS, so a rotated-out key cannot simply vanish. Three things were unspecified or wrong before this decision:

1. **Grace sizing.** Nothing tied `keyGracePeriod` to the token lifetime, so a mistaken configuration could invalidate live tokens on every rotation.
2. **Multi-process behaviour.** Several processes share one store. Rotation was find-then-mark-then-mint with no guard, so two rotators could mint two current keys and re-extend a grace period, and a busy process never noticed a rotation made elsewhere.
3. **Emergency rotation.** `KeyRing.rotateNow` was documented as the "suspected key compromise" path but kept the old key published and verifying for the full grace period (30 days by default), which is precisely wrong for a compromised key.

Encryption-at-rest key rotation (ADR-EA-019) is a different shape (a retired key must stay usable until nothing references it); the two must not be conflated.

## Decision

1. **Routine rotation.** A key is current until it is `keyRotationInterval` old (default 90 days) or `JwtConfig.algorithm` names a different algorithm. Rotating marks it rotated and mints its replacement; the rotated key keeps signature verification and JWKS publication until `retiresAt = rotatedAt + keyGracePeriod` (default 30 days).
2. **Grace sizing.** `keyGracePeriod` must be at least the maximum token lifetime (`ttl`), and in practice ttl plus the longest JWKS cache a verifier keeps (`jwksMaxAge` / the lite verifier's `cacheTtl`). `JwtConfig.config` rejects `keyGracePeriod < ttl` at layer build. Per-call `signJWT` TTLs above `ttl` are the caller's responsibility to size against.
3. **One current key, safely.** The store enforces at most one current row (a partial unique index in `layerSql`, an atomic check in `layerMemory`). `markRotated` is a compare-and-swap that reports whether the caller won; mark plus mint run in one `SqlTransaction`, so a crash between them leaves the previous key current; a loser (of a rotation or of the very first mint) re-reads and adopts the winner's key. `KeyRing` therefore requires `SqlTransaction`.
4. **Visibility across processes.** A process caches its key snapshot for at most `keyCacheMaxAge` (default 5 minutes) and forces one rate-limited re-read (`keyMinRefreshInterval`, default 30 seconds) when a token names an unknown `kid`, so a peer's or the CLI's rotation is honoured promptly. Downstream verifiers cache the JWKS for `cacheTtl` (default 10 minutes) and refetch at most once per `minRefetchInterval` on an unknown `kid`; the served JWKS carries `Cache-Control: public, max-age=<jwksMaxAge>`.
5. **Emergency retire-now.** `KeyRing.rotateNow({ gracePeriod: Duration.zero })` rotates the current key out and drops it from the JWKS and from verification immediately; `KeyRing.revoke(kid)` does the same for a key that was already rotated out (it only ever shortens a grace period). Tokens signed by the retired key stop verifying in-process at once and at downstream verifiers once their JWKS cache refreshes (at most `cacheTtl`). Deployments that cannot tolerate that residual window run verifiers with a short `cacheTtl` or check `introspect`.
6. **Algorithm changes** rotate immediately (the old key stays verifiable for its grace period under its own algorithm; verification is per-key-algorithm under an allowlist).

## Operator runbook

- **Routine:** nothing to do; rotation is automatic. Watch that `keyGracePeriod` stays at least `ttl` plus JWKS cache time.
- **Suspected compromise of the current key:** `KeyRing.rotateNow({ gracePeriod: Duration.zero })`; then revoke any session-bound tokens that matter with `introspect` denylisting.
- **Compromise found later (key already rotated out but still in its grace period):** `KeyRing.revoke(kid)`.
- **Migration from another issuer:** `KeyRing.importKey` adds the foreign public key as a verification-only key with its own retirement time.
- **Private-key custody:** `layerSql` stores the private JWK as an `Encryption` envelope bound to the row's `kid` (KRS-001); keep the encryption keyset retired-key-complete per ADR-EA-019, or register a KMS/HSM key with `KeyRing.registerRemoteKey`.

## Alternatives considered

**A rotation timer that deletes keys automatically.** Rejected: deletion is what makes an emergency retire-now safe to reason about, but an automatic timer racing token TTLs is what a sized grace period already provides without a background job.

**Sharing the encryption-key retirement model (keys stay until unreferenced).** Rejected: a signing key's outstanding references are bounded by token TTL, so a time-bounded grace period is both sufficient and lets the JWKS shrink.

**Advisory locks for rotation.** Rejected in favour of the store-enforced single-current-key invariant plus compare-and-swap, which needs nothing dialect-specific beyond a partial unique index and works the same in memory.

## Consequences

**Positive**: concurrent processes cannot mint duplicate current keys or extend a grace period; a crash mid-rotation is harmless; emergency rotation actually retires the key; algorithm changes no longer strand new tokens.

**Negative**: `KeyRing` gained a `SqlTransaction` requirement, and the plugin migrations gained a unique index (existing databases with several current rows must be repaired before applying it). Emergency retirement still has a residual window equal to downstream JWKS cache lifetimes.
