# P03 — JWT, signing keys & key rotation

Phase 1 · 23 open issues to fix (4 high, 11 medium, 7 low, 1 info) · 13 closed by validation · ~92h summed per-issue estimate (upper bound) · 2 need a decision first.

Each issue below links to its full dossier (evidence at HEAD `ec065a7`, fix steps, tests, acceptance) in its slice file. Work workstream by workstream, top to bottom; within a workstream do the canonical issue first — its fix closes the listed duplicates.

## `keyprovider-rotation` — Multi-key KeyProvider, AAD binding and key hygiene

Slices: [09-ports-apikey-cli](../slices/09-ports-apikey-cli.md) · ~15h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [KRS-002](../slices/09-ports-apikey-cli.md) | high | architecture | CONFIRMED | L | — | Multi-key layerEnv + staleKid-driven lazy re-encryption, exactly as decision 22 specifies. |
| [AR-007](../slices/09-ports-apikey-cli.md) | low | dx | CONFIRMED | S | KRS-002, RBS-004 | Document a multi-replica deployment contract once KRS-002 (keyset) and RBS-004 (shared rate-limit store) exist. |
| [SMS-005-secrets-management-specialist](../slices/09-ports-apikey-cli.md) | low | security | CONFIRMED | S | KRS-002 | Minimise raw key-byte lifetime and document the residual exposure. |
| [ACS-008](../slices/09-ports-apikey-cli.md) | info | security | CONFIRMED | S | KRS-002 | Bind envelope version and kid into the GCM AAD (envelope v2), keeping v1 decryptable. |

Closed by validation in this workstream: ACS-009 (DUPLICATE → KRS-002)

## `jwt-lite-verifier-jwks-cache` — Single-flight, TTL'd JWKS caching (lite verifier + OAuth id_token)

Slices: [04-oauth-provider-jwt](../slices/04-oauth-provider-jwt.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ECF-002](../slices/04-oauth-provider-jwt.md) | high | security | CONFIRMED | M | — | Single-flight, TTL'd JWKS caches with a rate-limited unknown-kid refetch in both the lite verifier and OAuth's id_token verifier; publish Cache-Control on /jwt/jwks. |

Closed by validation in this workstream: JJS-002 (DUPLICATE → ECF-002), KRS-010 (DUPLICATE → ECF-002)

## `jwt-signing-key-at-rest-encryption` — Encrypt JWT private signing keys at rest

Slices: [04-oauth-provider-jwt](../slices/04-oauth-provider-jwt.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [KRS-001](../slices/04-oauth-provider-jwt.md) | high | security | CONFIRMED | M | — | Encrypt `privateKeyJwk` at rest through the existing `@awthaq/ports` Encryption port (AAD bound to the row's kid) and decode both JWK columns with Schema instead of `JSON.parse`. |

Closed by validation in this workstream: SMS-001 (DUPLICATE → KRS-001)

## `sql-encrypted-token-read-path` — Typed, rotation-safe encrypted token reads

Slices: [05-sql](../slices/05-sql.md) · ~13h · depends on workstreams: `encryption-key-rotation (ports slice, KRS-002)`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [SMS-002-secrets-management-specialist](../slices/05-sql.md) | high | correctness | CONFIRMED | L | KRS-002 | Replace `Effect.orDie` on decrypt with a typed, per-row failure policy. Point token reads surface a typed error; identity/list reads degrade the unreadable column to null and log. Token-only writes stop decrypting the old value. Add lazy re-encryption once KRS-002's multi-key provider and `staleKid` result land (ticket 22). |
| [SMS-007-secrets-management-specialist](../slices/05-sql.md) | low | docs | CONFIRMED | S | — | Amend the spec to match the real, deliberate boundary. Do not retype the repository: a `Schema.Redacted` encoded form cannot be bound as a SQL parameter (Models.ts:77-86), and core already re-wraps tokens as `Redacted` at the domain boundary (`ProviderTokenSet.accessToken: Redacted.Redacted<string>`, core Accounts.ts:85-87). |

Closed by validation in this workstream: ESR-004 (DUPLICATE → SMS-002-secrets-management-specialist), KRS-003 (DUPLICATE → SMS-002-secrets-management-specialist), TS-005-tim-smart (DUPLICATE → SMS-002-secrets-management-specialist)

## `jwt-claims-codec-hardening` — Schema-driven JWT claims, typ/nbf enforcement, token-class separation

Slices: [04-oauth-provider-jwt](../slices/04-oauth-provider-jwt.md) · ~11h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [GC-002](../slices/04-oauth-provider-jwt.md) | medium | architecture | CONFIRMED | M | — | One `RegisteredClaims` Schema used by both `JwtCodec.sign` (encode) and `parse` (decode); `verify` keeps only relational/temporal checks; `aud` accepts string or array. |
| [VB-005](../slices/04-oauth-provider-jwt.md) | medium | architecture | CONFIRMED | M | GC-002, JJS-008 | Separate token classes by header `typ` (principal/delegation tokens vs general signJWT tokens) and allow per-call audience on signJWT, per wayfinder ticket 33's `signJWT({ audience })` decision. |
| [JJS-007](../slices/04-oauth-provider-jwt.md) | low | api | CONFIRMED | S | VB-005 | Move the `sub` requirement out of `JwtCodec.verify` into the principal-scoped verifiers; give `verifyJWT` its own implementation. |
| [JJS-008](../slices/04-oauth-provider-jwt.md) | low | security | CONFIRMED | S | GC-002 | Decode and enforce `typ` (RFC 8725 §3.11) and honour `nbf`/`iat` in `JwtCodec.verify` and the lite verifier. |
| [JJS-009](../slices/04-oauth-provider-jwt.md) | low | testing | CONFIRMED | S | — | Add pinning tests for algorithm confusion and unknown-kid fail-closed. |

## `jwt-response-mirroring-opt-in` — Make x-jwt-token response mirroring opt-in

Slices: [04-oauth-provider-jwt](../slices/04-oauth-provider-jwt.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [PDR-003](../slices/04-oauth-provider-jwt.md) | medium | security | CONFIRMED ⚖️ decision | M | — | Make response mirroring a `JwtConfig` choice (`"off" / "bearer" / "always"`), pass the auth scheme to `PostAuthResponseHook.decorate`, and log rather than silently swallow sign failures. |

Closed by validation in this workstream: MAPS-005 (DUPLICATE → PDR-003), VB-009 (DUPLICATE → PDR-003)

## `jwt-revocation-propagation` — Session revocation reaches HTTP introspection

Slices: [04-oauth-provider-jwt](../slices/04-oauth-provider-jwt.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [TIR-007](../slices/04-oauth-provider-jwt.md) | medium | security | PARTIAL | M | — | Finish ticket 11's intent: let `/jwt/introspect` apply the session-liveness check whenever `Sessions` is composed (captured via `Effect.serviceOption`, keeping R = never), and document the bare-`verify` revocation-lag bound. |

Closed by validation in this workstream: SCP-007 (DUPLICATE → TIR-007)

## `jose-algorithm-coverage` — Broaden asymmetric JOSE algorithm support

Slices: [04-oauth-provider-jwt](../slices/04-oauth-provider-jwt.md) · ~12h · depends on workstreams: `jwt-key-rotation-integrity`, `oauth-provider-boot-validation`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AOMS-005](../slices/04-oauth-provider-jwt.md) | medium | api | CONFIRMED | M | ESS-002-effect-schema-specialist | Generalize OAuth id_token verification to RS256/PS256/ES256/ES384/EdDSA under a per-provider allowlist seeded from discovery, checked at boot. |
| [FAMS-005](../slices/04-oauth-provider-jwt.md) | medium | api | CONFIRMED ⚖️ decision | M | BAM-010 | With BAM-010's RS256 support, document and test a Firebase dual-run recipe using `makeVerifier`; state that `/jwt/token` is not an RFC 8693 exchange. Whether to ship an inbound exchange endpoint is open (see decision). |
| [BAM-010](../slices/04-oauth-provider-jwt.md) | low | api | CONFIRMED | M | JJS-003 | Widen the jwt plugin to the common asymmetric JOSE set (EdDSA, ES256, ES384, RS256, PS256) via one algorithm table; still no HS*. |

## `jwt-key-rotation-integrity` — Multi-instance-safe key rotation

Slices: [04-oauth-provider-jwt](../slices/04-oauth-provider-jwt.md) · ~20h · depends on workstreams: `jwt-signing-key-at-rest-encryption`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [JJS-003](../slices/04-oauth-provider-jwt.md) | medium | correctness | CONFIRMED | M | — | Rotate immediately when the current key's alg differs from config, and verify against each key's own alg under an allowlist so grace-period keys of the old alg keep verifying. |
| [JJS-004](../slices/04-oauth-provider-jwt.md) | medium | correctness | CONFIRMED | L | KRS-001 | Enforce one current signing key at the store (unique partial index + conditional markRotated), and run mark+mint atomically in `SqlTransaction`, with losers re-reading the winner. |
| [KRS-006](../slices/04-oauth-provider-jwt.md) | medium | architecture | CONFIRMED | M | JJS-004 | Bound snapshot staleness with a max-age refresh and refresh once (rate-limited) on an unknown kid so peer/external rotations converge. |

Closed by validation in this workstream: KRS-009 (DUPLICATE → JJS-004)

## `jwt-act-claim` — RFC 8693 act claim

Slices: [10-passkey-admin](../slices/10-passkey-admin.md) · ~1h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [JR-005](../slices/10-passkey-admin.md) | medium | architecture | PARTIAL | S | — | Emit an RFC 8693-compliant `act` claim (`act.sub`) while keeping type/id as private extensions. |

## `jwt-key-rotation-runbook` — ADR-EA-017 for JWT signing-key rotation + emergency retire-now + model 08 rewrite

Slices: [12-spec](../slices/12-spec.md) · ~4h · depends on workstreams: `spec-status-banner-sweep`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [KRS-008](../slices/12-spec.md) | medium | docs | CONFIRMED | M | — | Add ADR-EA-017 'JWT signing-key rotation' (routine vs emergency, grace sizing vs max token TTL, multi-process visibility), give emergency rotation a real retire-immediately knob in code, and rewrite spec/models/08-jwt-bearer.md to the shipped Jwt plugin (absorbing MAPS-009's dependsOn:[] divergence and VB-007's remaining typ/audience deltas). |

Closed by validation in this workstream: MAPS-009 (DUPLICATE → KRS-008), VB-007 (DUPLICATE → KRS-008)

