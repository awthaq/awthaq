# Slice 04-oauth-provider-jwt — validation & fix plan

- **Validated at:** `ec065a7` (HEAD) on 2026-09-29
- **Scope:** `packages/oauth/src/{OAuthProvider,Jwt}.ts` and the `packages/jwt` plugin (codec, JWKS, KeyRing, signing-key storage, lite verifier) — 52 issues
- **Collision note:** IDs with prefixes AH-/ESS-/SMS-/TS- are shared by two auditors; cross-references below use the file stem (e.g. `SMS-001-secrets-management-specialist`).

| Verdict | high | medium | low | info | total |
|---|---|---|---|---|---|
| CONFIRMED | 4 | 11 | 9 | 0 | 24 |
| PARTIAL | 0 | 1 | 1 | 0 | 2 |
| ALREADY-FIXED | 0 | 8 | 2 | 1 | 11 |
| INVALID | 0 | 0 | 0 | 0 | 0 |
| DUPLICATE | 1 | 6 | 5 | 3 | 15 |
| WONTFIX-CANDIDATE | 0 | 0 | 0 | 0 | 0 |
| **total** | 5 | 26 | 17 | 4 | 52 |

**What is really wrong here.** The audit predates a burst of jwt/oauth work: `jti` + a revocation store + RFC 7662 introspection (2ebd195), a keyed idle-aware `Sessions.isLive` (6629fd2), production migrations for `jwt_signing_key`, and the OAuth `findKey` kid-fallback/TTL fix (fd8e5e9) and header/JWKS schema decoding (e3059f2, e364411) — 11 findings are already fixed. What remains is real: (1) private signing keys are still stored as plaintext JWK JSON (two highs); (2) the lite verifier's JWKS cache never expires and has no single-flight or negative cache (high; the OAuth twin has a TTL but the same amplification); (3) the OIDC discovery document is still cast, not decoded, and `resolve()` misses openid-scope and skipPkce-on-public-client guards; (4) the JWT claims contract is an untyped bag — no Schema, no `typ`/`nbf` enforcement, no token-class separation, `sub` wrongly mandatory for `signJWT` tokens; (5) key rotation is not safe across instances or algorithm changes; (6) response mirroring is unconditional; (7) wayfinder-33's stateless bearer decision is not implemented; plus DX/interop gaps (algorithms, presets, amr, avatars) and the unenforced ports rule.

## Workstreams

### 1. `jwt-signing-key-at-rest-encryption` — Encrypt JWT private signing keys at rest

- **Closes:** KRS-001, SMS-001-secrets-management-specialist
- **Why grouped:** Both highs name the same plaintext `privateKeyJwk` column; one change to SigningKeyRecords.layerSql closes both. First because JJS-004 edits the same file.
- **Effort:** M · **Depends on workstreams:** none
- **Ordered steps:**
  1. (KRS-001) packages/jwt/src/SigningKeyRecords.ts `layerSql`: `const encryption = yield* Encryption.Encryption` (import from `@awthaq/ports`; add the workspace dependency to packages/jwt/package.json if missing). Add `const privateKeyAad = (kid: string) => `jwt_signing_key:${kid}:privateKeyJwk``.
  2. (KRS-001) In `create`, replace `JSON.stringify(Redacted.value(redacted))` with `encryption.encrypt(Redacted.make(JSON.stringify(Redacted.value(redacted))), privateKeyAad(input.kid))` (the envelope string is what goes into the column).
  3. (KRS-001) Replace the synchronous `toRecord` (lines 149-159, which also launders `JSON.parse`'s `any` into `Jwk`) with an effectful `decodeRow`: decode `publicKeyJwk` via `Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))`; for a non-null `privateKeyJwk`, `encryption.decrypt(envelope, privateKeyAad(row.kid))`, then schema-decode the plaintext JSON and wrap in `Redacted.make`. Map `DecryptionFailed`/`UnknownKeyId`/SchemaError to `Effect.die(new Error(`awthaq/jwt: signing key "${kid}" could not be decrypted`))` — an undecryptable signing key is a deployment fault. Use it in create/findCurrent/listVerifiable/markRotated.
  4. (KRS-001) Let `layerSql`'s type be inferred (no annotation); it becomes `Layer<SigningKeyRecords, never, SqlClient | Encryption>`. Keep `layerMemory` plaintext (in-process only) and say so in the header comment (rewrite lines 10-17, which currently justify the plaintext JSON convention).
  5. (KRS-001) Rewrite packages/jwt/README.md (currently a 'planned package' stub): document at-rest encryption, the Encryption/KeyProvider requirement for `layerSql`, and recommend `KeyRing.registerRemoteKey` + `JwtCodec.RemoteSigner` (KMS/HSM) for production so private material never lands in the DB at all.
  6. (KRS-001) No legacy-plaintext shim: the library is pre-release and unpublished.
- **Test plan (write first):**
  - (KRS-001) packages/jwt/test/KeyRing.test.ts (sql suite, write first): 'layerSql never stores the private JWK in plaintext' — after first `KeyRing.current`, `SELECT privateKeyJwk FROM jwt_signing_key` must not contain `"d"` and must decode as an Encryption envelope (`v`/`kid`/`iv`/`ciphertext`). Provide `Encryption.layer` + `KeyProvider.layerEnv` exactly like packages/core/test/Accounts.test.ts:37-40.
  - (KRS-001) Same file: 'a privateKeyJwk ciphertext copied onto another kid's row fails to decrypt (AAD binding)' — UPDATE one row's column with another's, then `findCurrent` dies.
  - (KRS-001) Existing sign/verify round-trips over layerSql stay green.
- **Acceptance:**
  - (KRS-001) `jwt_signing_key.privateKeyJwk` holds an Encryption envelope, never JWK JSON.
  - (KRS-001) Swapping ciphertext between rows is detected (die), not silently accepted.
  - (KRS-001) No `JSON.parse` result flows into a typed `Jwk` without a Schema decode; no `as` in SigningKeyRecords.ts.
  - (KRS-001) `pnpm run typecheck`, `pnpm run test`, `pnpm lint`, `pnpm knip` pass.

### 2. `jwt-lite-verifier-jwks-cache` — Single-flight, TTL'd JWKS caching (lite verifier + OAuth id_token)

- **Closes:** ECF-002, JJS-002, KRS-010
- **Why grouped:** Three findings on the same never-expiring, non-coalesced cache in verify.ts; KRS-010's Cache-Control ask rides along. OAuth.ts's twin cache is fixed in the same pass.
- **Effort:** M · **Depends on workstreams:** none
- **Ordered steps:**
  1. (ECF-002) packages/jwt/src/verify.ts: build the key source with `Effect.cachedInvalidateWithTTL(fetchKeys, options.cacheTtl ?? "10 minutes")` (Effect v4 Effect.ts:7279 returns `[get, invalidate]`); `currentKeys = get` — concurrent cold starts share one in-flight fetch and entries expire (closes JJS-002/KRS-010's 'never expires').
  2. (ECF-002) Unknown-kid path: guard the forced refetch with `Effect.Semaphore` (1 permit) + a `Ref<number>` of the last forced refetch time read from `Clock`; inside the permit, if the last forced refetch is younger than `options.minRefetchInterval ?? "30 seconds"`, fail `unknown kid` immediately (negative cache); otherwise `invalidate` then `get` and retry verification once.
  3. (ECF-002) Extend `VerifierOptions` with optional `cacheTtl?: Duration.Input` and `minRefetchInterval?: Duration.Input`; document defaults relative to the issuer's `keyGracePeriod` in the module header.
  4. (ECF-002) packages/jwt/src/Jwt.ts `JwtHandlers` `jwks` handler: return an `HttpServerResponse` (HttpApiBuilder passes a returned response through untouched — ../effect/packages/effect/src/unstable/httpapi/HttpApiBuilder.ts:855) with `cache-control: public, max-age=<JwtConfig.jwksMaxAge seconds>`; add `jwksMaxAge: Duration` to `JwtConfig` (default 10 minutes).
  5. (ECF-002) packages/oauth/src/OAuth.ts `verifyIdToken`: replace the `Ref<HashMap<providerId, JwksCacheEntry>>` + `Date.now()` logic (lines 325-347) with one `Effect.cachedInvalidateWithTTL` per resolved provider, created once in the plugin `make` (providers are resolved at boot), plus the same min-refetch-interval guard around the kid-miss refetch; use `Clock` instead of `Date.now()` so TestClock drives it.
- **Test plan (write first):**
  - (ECF-002) packages/jwt/test/verify.test.ts: 'N concurrent first verifications perform exactly one JWKS fetch' (count requests in the fake HttpClient, `Effect.all(..., { concurrency: 'unbounded' })`).
  - (ECF-002) verify.test.ts: 'a burst of tokens with garbage kids within minRefetchInterval performs at most one refetch'.
  - (ECF-002) verify.test.ts: 'a key removed from the JWKS stops verifying once cacheTtl elapses' (TestClock.adjust past the TTL) — also JJS-009's third requested test.
  - (ECF-002) packages/jwt/test/AuthHttp.test.ts: 'GET /jwt/jwks carries Cache-Control max-age'.
  - (ECF-002) packages/oauth/test/OAuth.test.ts: 'concurrent callbacks presenting an unknown kid cause one JWKS refetch, not one per request'.
- **Acceptance:**
  - (ECF-002) Outbound JWKS fetches are bounded by 1 per cacheTtl plus 1 per minRefetchInterval, regardless of request rate or kid values.
  - (ECF-002) Keys dropped from the JWKS stop verifying within cacheTtl without a restart.
  - (ECF-002) /jwt/jwks responses carry Cache-Control.
  - (ECF-002) Full gate `pnpm check` passes.

### 3. `oauth-provider-boot-validation` — Validate OAuth provider configuration at boot

- **Closes:** ESS-002-effect-schema-specialist, TTE-003, AH-003-anders-hejlsberg, JR-009, OAP-005, AP-007
- **Why grouped:** All are missing checks inside `OAuthProvider.resolve()` (discovery decode, openid scope, skipPkce-on-public-client); one small PR, one test file.
- **Effort:** S · **Depends on workstreams:** none
- **Ordered steps:**
  1. (ESS-002-effect-schema-specialist) packages/oauth/src/OAuthProvider.ts: replace `interface DiscoveryDocument` (lines 100-106) with `DiscoveryDocumentSchema = Schema.Struct({ issuer: Schema.String, authorization_endpoint: Schema.optional(Schema.String), token_endpoint: Schema.optional(Schema.String), jwks_uri: Schema.optional(Schema.String), userinfo_endpoint: Schema.optional(Schema.String), id_token_signing_alg_values_supported: Schema.optional(Schema.Array(Schema.String)), code_challenge_methods_supported: Schema.optional(Schema.Array(Schema.String)) })` (extra members ignored).
  2. (ESS-002-effect-schema-specialist) Fetch via `Effect.flatMap(HttpIncomingMessage.schemaBodyJson(DiscoveryDocumentSchema))`; map failures to `Effect.die(new Error(`awthaq/oauth: provider "${config.id}" discovery document is invalid: ${issue}`))` keeping BEH-EA-127's die-at-boot semantics.
  3. (ESS-002-effect-schema-specialist) Optionally validate endpoints parse as absolute URLs (Schema check with `URL.canParse`).
  4. (JR-009) OAuthProvider.ts `resolve()`: next to the issuer check, `if (config.kind === "oidc" && !config.scopes.includes("openid")) return yield* Effect.die(new Error(`awthaq/oauth: provider "${config.id}" is oidc but its scopes omit "openid"`))`.
  5. (OAP-005) OAuthProvider.ts `resolve()`: `if (config.quirks?.skipPkce === true && Option.isNone(clientSecret)) die(`awthaq/oauth: provider "${config.id}" sets quirks.skipPkce but has no clientSecret — a public client must use PKCE (RFC 9700 §2.1.1)`)`.
  6. (OAP-005) When skipPkce is set (and allowed), `Effect.logWarning` naming the provider id once at boot.
  7. (OAP-005) Amend BEH-EA-121's requirement text: the skipPkce quirk is permitted only for confidential clients.
- **Test plan (write first):**
  - (ESS-002-effect-schema-specialist) OAuth.test.ts (first): 'a discovery document whose token_endpoint is not a string dies at boot naming the field'; 'a JSON array discovery body dies at boot'.
  - (JR-009) OAuth.test.ts (first): 'an oidc provider configured without openid scope dies at boot'.
  - (OAP-005) OAuth.test.ts (first): 'skipPkce without clientSecret dies at boot'; existing 'apple' skipPkce scenario (with clientSecret) stays green.
- **Acceptance:**
  - (ESS-002-effect-schema-specialist) No `as` in OAuthProvider.ts; malformed discovery fails boot with a diagnostic message; BEH-EA-127 scenarios stay green.
  - (JR-009) Mis-scoped OIDC providers fail at registration, not as an opaque callback 400.
  - (OAP-005) No configuration can produce a PKCE-less public-client code flow.

### 4. `jwt-claims-codec-hardening` — Schema-driven JWT claims, typ/nbf enforcement, token-class separation

- **Closes:** JJS-009, GC-002, JJS-008, VB-005, JJS-007
- **Why grouped:** All reshape JwtCodec.sign/verify's contract; VB-005 also delivers ticket 33's `signJWT({ audience })`, which the stateless-bearer workstream consumes. JJS-009's pinning tests go first.
- **Effort:** L · **Depends on workstreams:** none
- **Ordered steps:**
  1. (JJS-009) Create packages/jwt/test/JwtCodec.test.ts with hand-assembled tokens (base64url header/payload + a real signature from a generated key) exercising `JwtCodec.verify` directly.
  2. (JJS-009) These are characterization tests: they should pass on HEAD; confirm red by temporarily loosening the alg comparison / adding a first-key fallback locally before committing.
  3. (JJS-009) The 'retired key stops verifying after cache refresh' case is delivered by ECF-002's TTL test.
  4. (GC-002) packages/jwt/src/JwtCodec.ts: define `RegisteredClaims = Schema.StructWithRest(Schema.Struct({ iss: Schema.String, aud: Schema.Union([Schema.String, Schema.NonEmptyArray(Schema.String)]), exp: Schema.Int, iat: Schema.optional(Schema.Int), nbf: Schema.optional(Schema.Int), jti: Schema.optional(Schema.String), sub: Schema.optional(Schema.NonEmptyString) }), [Schema.Record(Schema.String, Schema.Unknown)])` (Effect v4: `StructWithRest` Schema.ts:4031, `NonEmptyArray` :4528, `Int` :7581 — confirm the exact rest-argument shape there).
  5. (GC-002) `sign`: take `claims: typeof RegisteredClaims.Type`, encode via `Schema.encodeEffect(Schema.fromJsonString(RegisteredClaims))` → base64url, replacing `encodeJson`'s raw `JSON.stringify` for the payload.
  6. (GC-002) `parse`/`decodePayload`: decode with `Schema.fromJsonString(RegisteredClaims)` (decode failure → `JwtInvalidError('malformed token')`).
  7. (GC-002) `verify`: keep `iss === issuer`; `aud` passes when equal to, or an array containing, `params.audience`; `exp`/`nbf` against `DateTime.now` with an optional `clockSkew` param (default 0). Return the decoded claims (typed) — callers that want `Record<string, unknown>` still get a supertype.
  8. (GC-002) packages/jwt/src/Jwt.ts `signClaims`: build a value typed against `RegisteredClaims.Type` (registered claims still win over extras); no casts.
  9. (JJS-008) JwtCodec.ts `HeaderSchema`: add `typ: Schema.optional(Schema.String)`.
  10. (JJS-008) `verify` params gain `expectedTyp: string`; reject when `header.typ !== expectedTyp` (case-insensitive per RFC 7515 §4.1.9 media-type rules) with the undifferentiated `JwtInvalidError`.
  11. (JJS-008) Reject `nbf` in the future and `iat` further in the future than `clockSkew` (uses GC-002's decoded claims).
  12. (JJS-008) packages/jwt/src/verify.ts `VerifierOptions`: `expectedTyp?: string` (default matches the principal-token typ chosen in VB-005).
  13. (VB-005) `JwtCodec.sign` takes `typ: string`. `Jwt.sign(principal)` (mint endpoint, mirroring, ticket-33 re-entry) stamps `typ: "at+jwt"` (RFC 9068); `signJWT` stamps `typ: "JWT"` by default with an `options.typ?: string` override.
  14. (VB-005) `signJWT` options gain `audience?: string | ReadonlyArray<string>` (ticket 33); `signClaims` uses `options.audience ?? config.audience` (registered claims still set only here).
  15. (VB-005) `Jwt.verify`, `verifyLive`, `introspectLive`, and NAM-001's `BearerCredentialResolverLive` require `expectedTyp: "at+jwt"`; `verifyJWT` becomes its own function requiring `"JWT"` (or a caller-supplied typ) — a signJWT token with a forged `sid` can no longer pass verifyLive.
  16. (VB-005) Lite verifier: `expectedTyp` default `"at+jwt"`; document per-consumer audience pinning (each downstream service constructs `makeVerifier({ audience: "svc-a" })`).
  17. (VB-005) Update .scratch/jwt/spec.md 'Claims' and README.
  18. (JJS-007) JwtCodec.ts: delete the `sub` check from `verify`; add `requireSubject: boolean` to its params (principal callers pass true).
  19. (JJS-007) Jwt.ts: `verify` (principal) passes `requireSubject: true`; `verifyJWT` becomes a distinct function (`requireSubject: false`, `expectedTyp` per VB-005). Fix the JwtShape doc comments at lines 90-93 and 428-431.
  20. (JJS-007) verify.ts `VerifierOptions.requireSubject?: boolean` (default true).
- **Test plan (write first):**
  - (JJS-009) 'header alg "none" fails'; 'header alg missing fails'; 'header alg "HS256" signed with the public key bytes as HMAC secret fails'; 'ES256 header against an EdDSA configuration fails'.
  - (JJS-009) 'a kid matching no key fails closed even when other keys exist (no first-key fallback)'.
  - (GC-002) packages/jwt/test/JwtCodec.test.ts (new, first): 'an aud array containing the expected audience verifies'; 'an aud array without it fails'; 'a non-integer/absent exp fails as malformed'.
  - (GC-002) Existing Jwt.test.ts/verify.test.ts round-trips stay green.
  - (JJS-008) JwtCodec.test.ts: 'a token whose header typ differs from expectedTyp fails'; 'a token with nbf in the future fails'; 'a token with iat far in the future fails'.
  - (VB-005) packages/jwt/test/Jwt.test.ts (first): 'signJWT({ sub, sid }) is rejected by verifyLive (typ mismatch)'.
  - (VB-005) Jwt.test.ts: 'signJWT(payload, { audience: "svc-a" }) fails Jwt.verify at the origin'; verify.test.ts: 'the same token verifies via makeVerifier({ audience: "svc-a", expectedTyp: "JWT" })'.
  - (VB-005) Jwt.test.ts: 'sign(principal) produces header typ at+jwt'.
  - (JJS-007) Jwt.test.ts (first): 'signJWT({ machine: "etl-job" }) verifies via verifyJWT'; 'Jwt.verify still rejects a principal token without sub'.
- **Acceptance:**
  - (JJS-009) Loosening either pin in JwtCodec.verify turns the suite red.
  - (GC-002) The claims contract exists once, as a Schema, on both sides of the codec.
  - (GC-002) Array `aud` is accepted per RFC 7519 §4.1.3.
  - (GC-002) No `as` introduced; `pnpm run typecheck` + `pnpm run test` green.
  - (JJS-008) typ/nbf/iat enforced by both in-process verify and the lite verifier; tests green.
  - (VB-005) Principal and general-purpose tokens are not interchangeable at any verifier; per-call audiences work; tests green.
  - (JJS-007) Every token signJWT can mint, verifyJWT can verify; principal verification unchanged.

### 5. `jwt-key-rotation-integrity` — Multi-instance-safe key rotation

- **Closes:** JJS-004, KRS-009, JJS-003, KRS-006
- **Why grouped:** All concern KeyRing/SigningKeyRecords rotation correctness (atomicity, uniqueness, cross-process convergence, alg changes).
- **Effort:** L · **Depends on workstreams:** jwt-signing-key-at-rest-encryption
- **Ordered steps:**
  1. (JJS-004) packages/jwt/src/Jwt.ts `jwtMigrations`: append `create_jwt_signing_key_single_current_index`: `CREATE UNIQUE INDEX jwt_signing_key_single_current ON jwt_signing_key ((rotatedAt IS NULL)) WHERE rotatedAt IS NULL` (expression + partial unique index; valid on pg and sqlite >= 3.9 — verify both in the migration test).
  2. (JJS-004) packages/jwt/src/SigningKeyRecords.ts: `markRotated` becomes `UPDATE … WHERE kid = ? AND rotatedAt IS NULL RETURNING *` via `SqlSchema.findOneOption` and returns `Effect<boolean>` (won/lost); `layerMemory` mirrors it (only modifies a row whose rotatedAt is None). `create` maps a unique-constraint `SqlError` to a typed `CurrentKeyConflict` (Data.TaggedError) instead of `orDie`.
  3. (JJS-004) packages/jwt/src/KeyRing.ts: wrap `markRotated + mint` in `SqlTransaction.withTransaction` (packages/ports/src/SqlTransaction.ts; `layerNoop` for memory) in both `layerFromStore` and `rotateNow`; on a lost `markRotated` or `CurrentKeyConflict`, re-read `findCurrent` and adopt the winner (covers the concurrent lazy first-mint race too). `KeyRing` then requires `SqlTransaction` — document in README.
  4. (JJS-004) `registerRemoteKey`: in the same transaction, mark the existing current key rotated so the remote key becomes the single current key (otherwise it violates the new index).
  5. (JJS-004) With the guard, a repeated rotation can no longer rewrite `retiresAt` (grace window no longer re-extended).
  6. (JJS-003) KeyRing.ts `layerFromStore` and `rotateIfDue`: treat `current.alg !== config.algorithm` as due (rotate now).
  7. (JJS-003) JwtCodec.ts `verify`: replace `algorithm: Algorithm` with `algorithms: ReadonlyArray<Algorithm>`; require `header.alg === key.alg && algorithms.includes(key.alg)`; import/verify with `key.alg`.
  8. (JJS-003) Jwt.ts `verify`: pass `algorithms` = distinct algs of the verifiable key set (trusted server-side data).
  9. (JJS-003) verify.ts: `VerifierOptions.algorithm` → `algorithms: ReadonlyArray<Algorithm>` (pre-release breaking change is fine).
  10. (JJS-003) Single `Algorithm` type exported from JwtCodec.ts; JwtConfig.ts imports it (drop the duplicate at JwtConfig.ts:23).
  11. (KRS-006) KeyRing.ts: add `loadedAt: DateTime.Utc` to `SigningKeysShape`, set in `layerFromStore`.
  12. (KRS-006) JwtConfig.ts: add `keyCacheMaxAge: Duration` (default 5 minutes).
  13. (KRS-006) `rotateIfDue`: also `ref.refresh` when `now - loadedAt >= keyCacheMaxAge` (still one in-memory comparison per call).
  14. (KRS-006) Jwt.ts `verify`: on `JwtInvalidError` with reason `unknown kid`, perform one `ref.refresh` (single-flighted via a Semaphore and rate-limited like ECF-002's minRefetchInterval) and retry once — peer-minted keys verify immediately instead of after maxAge.
- **Test plan (write first):**
  - (JJS-004) packages/jwt/test/KeyRing.test.ts, both memory and sql suites (first): 'two concurrent rotations of a stale key leave exactly one current key' (Effect.all two `rotateNow`/two KeyRing instances over one store).
  - (JJS-004) Same file: 'concurrent lazy first-mint yields exactly one current key'; 'markRotated on an already-rotated kid leaves retiresAt unchanged'; 'a failing mint after markRotated rolls back (layerSql + SqlTransaction.layerSql)'.
  - (JJS-004) packages/jwt/test/RevocationStore.test.ts migrations block: 'creates the single-current unique index'.
  - (JJS-003) KeyRing.test.ts (first): 'switching JwtConfig.algorithm EdDSA→ES256 rotates on next access'.
  - (JJS-003) Jwt.test.ts: 'a token minted before an algorithm switch keeps verifying during grace; tokens minted after use ES256 and verify'.
  - (KRS-006) KeyRing.test.ts (first): 'an out-of-band rotateNow on the shared store is picked up by a busy KeyRing within keyCacheMaxAge' (two KeyRings over one store + TestClock.adjust).
  - (KRS-006) Jwt.test.ts: 'a token signed by a peer's freshly rotated key verifies via the unknown-kid refresh'.
- **Acceptance:**
  - (JJS-004) `SELECT count(*) FROM jwt_signing_key WHERE rotatedAt IS NULL` is ≤ 1 under any interleaving.
  - (JJS-004) A crash between mark and mint leaves the previous key current (transaction rolled back).
  - (JJS-004) `pnpm run test` green on memory and sqlite suites.
  - (JJS-003) Changing `algorithm` never breaks sign/verify; header alg must equal the matched key's alg.
  - (KRS-006) Signers converge on externally-triggered rotations within keyCacheMaxAge; verifiers accept peer keys immediately.

### 6. `jose-algorithm-coverage` — Broaden asymmetric JOSE algorithm support

- **Closes:** BAM-010, FAMS-005, AOMS-005
- **Why grouped:** Same limitation (EdDSA/ES256-only in jwt, RS256-only in oauth) seen from three migration angles. Each package keeps its own algorithm table (per .scratch/jwt/spec.md's independence decision) but the vocabulary is aligned.
- **Effort:** L · **Depends on workstreams:** jwt-key-rotation-integrity, oauth-provider-boot-validation
- **Ordered steps:**
  1. (BAM-010) JwtCodec.ts: `Algorithm = "EdDSA" | "ES256" | "ES384" | "RS256" | "PS256"`; replace `importParams`/`signParams` ternaries with one `AlgorithmSpec` record (import, sign, generateKey params per alg; PS256 saltLength 32).
  2. (BAM-010) KeyRing.ts `generateKeyPair`: use the table (RSA modulusLength 2048 default, `JwtConfig.rsaModulusLength?` for 3072/4096).
  3. (BAM-010) SigningKeyRecords.ts: widen `Schema.Literals([...])` at lines 141 and 169 (derive from one exported `Algorithms` tuple).
  4. (BAM-010) verify.ts `toVerificationKeys`: accept any `Algorithm` via a type guard over the tuple (no cast).
  5. (BAM-010) Add `KeyRing.importKey({ kid, alg, publicKeyJwk, privateKeyJwk })` so migrators can import better-auth signing keys and keep outstanding tokens verifiable; document in README (migration section).
  6. (FAMS-005) After BAM-010: verify.ts already takes an arbitrary `jwksUrl`/`issuer`/`audience`; with `algorithms: ["RS256"]` it can verify Firebase ID tokens (Firebase's published securetoken JWKS; `iss` = `https://securetoken.google.com/<projectId>`, `aud` = `<projectId>`).
  7. (FAMS-005) README migration section: dual-run recipe — an app handler verifies the Firebase ID token with `makeVerifier`, resolves/creates the user, then calls `Sessions.issue`; explicitly state `/jwt/token` is a self-decoration mint, not a token-exchange bootstrap.
  8. (FAMS-005) If the decision picks option B: add `POST /jwt/exchange` accepting a foreign JWT from a configured `trustedIssuers` list (per-issuer jwksUrl/audience/algorithms), mapping claims to a user via an app-supplied `resolveUser` and issuing a session.
  9. (AOMS-005) packages/oauth/src/Jwt.ts: replace `verifyRs256` with `verifySignature(alg, jwk, signingInput, signature)` over an alg table; `findKey(jwks, kid, alg)` filters candidates by the kty the alg requires (RSA / EC+crv / OKP) instead of `kty === "RSA"`; rewrite the header comment (lines 3-14).
  10. (AOMS-005) Remove `parts as [string, string, string]` (line 90): destructure then guard each segment `=== undefined`, exactly like packages/jwt/src/JwtCodec.ts:164-175.
  11. (AOMS-005) packages/oauth/src/OAuthProvider.ts: `OAuthProviderConfig.idTokenSigningAlgs?: ReadonlyArray<IdTokenAlg>`; `resolve()` computes the effective allowlist = explicit list ?? (discovery `id_token_signing_alg_values_supported` ∩ supported) ?? `["RS256"]` and dies at boot when it is empty (needs ESS-002's schema field). Store on `ResolvedProvider`.
  12. (AOMS-005) packages/oauth/src/OAuth.ts:313: replace the RS256 literal check with `provider.idTokenSigningAlgs.includes(decoded.header.alg)`.
  13. (AOMS-005) Optional (only if a provider explicitly lists it and a clientSecret exists): HS256 via HMAC with the client secret (OIDC Core §10.1) for legacy Auth0 connections — keep behind the explicit allowlist.
- **Test plan (write first):**
  - (BAM-010) JwtCodec.test.ts (first): parameterized 'sign/verify round-trip' for each algorithm.
  - (BAM-010) 'an RS256 header against an ES256-only key fails' (cross-alg confusion).
  - (BAM-010) KeyRing.test.ts: 'imports a foreign RS256 key and verifies a token signed by it'.
  - (FAMS-005) verify.test.ts (first, after BAM-010): 'an RS256 token with Firebase-shaped iss/aud verifies via makeVerifier against a fake JWKS'.
  - (AOMS-005) packages/oauth/test/OAuth.test.ts (first): 'an ES256-signed id_token verifies for a provider advertising ES256'.
  - (AOMS-005) 'an RS256 id_token is rejected for a provider whose allowlist is [ES256]'; 'resolve dies at boot when discovery advertises only unsupported algs'.
- **Acceptance:**
  - (BAM-010) All five algorithms sign/verify via WebCrypto; HS* remains unrepresentable; imported keys verify.
  - (FAMS-005) Firebase-issued ID tokens can be verified during a dual-run with shipped code; README documents the recipe and the mint endpoint's scope.
  - (AOMS-005) ES256/EdDSA/PS256 providers federate; allowlist enforced per provider; no `as` left in packages/oauth/src/Jwt.ts.

### 7. `jwt-response-mirroring-opt-in` — Make x-jwt-token response mirroring opt-in

- **Closes:** PDR-003, MAPS-005, VB-009
- **Why grouped:** Three auditors flag the same unconditional PostAuthResponseHook; one config knob plus a scheme parameter closes all three. Default value needs a decision.
- **Effort:** M · **Depends on workstreams:** none
- **Ordered steps:**
  1. (PDR-003) packages/jwt/src/JwtConfig.ts: add `mirrorResponses: "off" | "bearer" | "always"` to `JwtConfigShape`/`config()`; default per the decision below (recommended `"off"`).
  2. (PDR-003) packages/server/src/Authentication.ts: extend `PostAuthResponseHookShape.decorate` to `(principal, response, context: { readonly scheme: "cookie" | "bearer" })`; pass the scheme at both call sites (~lines 288 and 345); keep the default no-op.
  3. (PDR-003) packages/jwt/src/Jwt.ts `PostAuthResponseHookLive`: read `JwtConfig`; `"off"` returns the response unchanged, `"bearer"` decorates only when `context.scheme === "bearer"`, `"always"` keeps today's behavior. Replace `Effect.catch(() => Effect.succeed(response))` with `Effect.catch((error) => Effect.logWarning("awthaq/jwt: response mirroring failed", error).pipe(Effect.as(response)))`.
  4. (PDR-003) Rewrite the Jwt.ts block comment (lines 192-210) and packages/jwt/README.md: response headers are log/proxy/APM capture surface; cross-origin JS needs `Access-Control-Expose-Headers`; the explicit mint endpoint is the recommended delivery. Update .scratch/jwt/spec.md 'Automatic response mirroring' to record the opt-in decision.
  5. (PDR-003) When VB-005 lands, mirrored tokens carry the principal-token `typ` like any `sign(principal)` output (no extra work).
- **Test plan (write first):**
  - (PDR-003) packages/jwt/test/AuthHttp.test.ts (first): 'default config: GET /session carries no x-jwt-token header'.
  - (PDR-003) Same file: update the existing cross-plugin mirroring test (line 298) to opt into `mirrorResponses: "always"`.
  - (PDR-003) Same file: 'mirrorResponses: "bearer" — a cookie-authenticated request gets no header, a bearer-authenticated one does'.
  - (PDR-003) packages/server/test: 'PostAuthResponseHook.decorate receives the authenticating scheme'.
- **Acceptance:**
  - (PDR-003) With the default config no authenticated response carries x-jwt-token.
  - (PDR-003) Each of the three modes behaves as specified; sign failures are logged.
  - (PDR-003) `pnpm run test`, `pnpm run typecheck` pass.

### 8. `jwt-revocation-propagation` — Session revocation reaches HTTP introspection

- **Closes:** TIR-007, SCP-007
- **Why grouped:** Both are the bare-verify revocation lag; the remaining concrete gap is /jwt/introspect ignoring session liveness, contrary to wayfinder ticket 11.
- **Effort:** M · **Depends on workstreams:** none
- **Ordered steps:**
  1. (TIR-007) packages/jwt/src/Jwt.ts `make`: `const sessions = yield* Effect.serviceOption(Sessions.Sessions)` (Effect v4 `serviceOption: (key) => Effect<Option<S>>` adds no requirement — ../effect/packages/effect/src/Effect.ts:6103).
  2. (TIR-007) Add an internal `introspectForHandler(token)`: `introspect(token)`, then when `Option.isSome(sessions)` and the claims carry `sid`/`sub`, apply `sessions.value.isLive` exactly as `introspectLive` does; wire the `/jwt/introspect` handler to it. Keep public `verifyLive`/`introspectLive` signatures (per-call `Sessions` R) for explicit callers; refactor `sidStillLive` to accept the Sessions shape so both share one implementation.
  3. (TIR-007) Document in the Jwt.ts header and README: session revocation cascades immediately to verifyLive/introspectLive/`/jwt/introspect`; bare `verify` (and ticket-33 bearer re-entry) lags by at most `JwtConfig.ttl` (default 15m) — the documented, bounded tradeoff.
  4. (TIR-007) Note for SCIM (SCP-007): the future deactivation contract should call `Sessions.revokeAll` and require `verifyLive`/`introspect*` on security-sensitive JWT consumers; record this in spec/models/12-scim.md's open question when SCIM is specified (wayfinder ticket 08).
- **Test plan (write first):**
  - (TIR-007) packages/jwt/test/AuthHttp.test.ts (first): 'POST /jwt/introspect reports active:false once the minting session is revoked (Sessions composed)'.
  - (TIR-007) Same file: 'POST /jwt/introspect still works (denylist only) in a composition without Sessions'.
- **Acceptance:**
  - (TIR-007) Revoking a session makes every JWT minted from it introspect `active:false` over HTTP immediately when Sessions is composed.
  - (TIR-007) `Jwt.dependsOn` stays `[]`; handler R stays dischargeable.
  - (TIR-007) README states the bare-verify lag bound.

### 9. `jwt-stateless-bearer-reentry` — Stateless JWT-as-bearer strategy (wayfinder 33)

- **Closes:** NAM-001, IC-008
- **Why grouped:** Decided in wayfinder ticket 33 (shared with cross-slice MAPS-001); needs VB-005's typ/audience separation first so only principal tokens can re-enter.
- **Effort:** L · **Depends on workstreams:** jwt-claims-codec-hardening
- **Ordered steps:**
  1. (NAM-001) packages/server/src/Authentication.ts: add `BearerCredentialResolverShape { resolve: (credential: Redacted<string>) => Effect<Api.Principal, Api.Unauthenticated> }` and `BearerCredentialResolver = Context.Reference("awthaq/server/BearerCredentialResolver", { defaultValue: () => ({ resolve: () => Effect.fail(new Api.Unauthenticated()) }) })`, sibling to `PostAuthResponseHook` (lines 78-88).
  2. (NAM-001) Same file, both `AuthenticationLive` and `OptionalAuthenticationLive` `bearer` closures: if `Redacted.value(credential).split(".").length === 3` route to `BearerCredentialResolver.resolve`, skip `deliverRotation`, still run `PostAuthResponseHook.decorate`; otherwise the existing `resolveSession` path (opaque `id.secret`). `cookie` untouched.
  3. (NAM-001) packages/jwt/src/JwtConfig.ts: add `acceptAsBearer: boolean` (default `false`) to `JwtConfigShape` and `config()`.
  4. (NAM-001) packages/jwt/src/Jwt.ts: add `claimsToPrincipal` — the Schema-decoded inverse of `principalClaims` (sub → `PrincipalRef({ type: "user", id })`, sid → `sessionId`, act → `actingAs`; decode failure → `Unauthenticated`; no casts) — and `BearerCredentialResolverLive = Layer.effect(Authentication.BearerCredentialResolver, ...)` calling bare `jwt.verify` (not verifyLive), failing closed unless `config.acceptAsBearer`. Merge it into `Jwt.layer` with the existing `Layer.provideMerge` chain.
  5. (NAM-001) `signJWT` options gain `audience?: string` (implemented in VB-005's step; a propagation token minted with a downstream audience is rejected at the origin by the existing aud check).
  6. (NAM-001) Replace packages/jwt/README.md with real docs: acceptAsBearer + its revocation-lag bound (= `JwtConfig.ttl`), the stateless recipe `Sessions.layerMemory` + `acceptAsBearer: true` (no SQL, no migrations), and `signJWT(payload, { audience })` for downstream-only tokens.
  7. (NAM-001) Spec: amend BEH-EA-066 (bearer handler now routes 3-segment credentials to `BearerCredentialResolver`; opaque tokens unchanged) and note the spec/models/08-jwt-bearer.md drift the decision flags.
- **Test plan (write first):**
  - (NAM-001) packages/jwt/test/AuthHttp.test.ts (first): 'with acceptAsBearer: true, a minted JWT sent as Authorization: Bearer authenticates GET /session'.
  - (NAM-001) Same file: 'with the default acceptAsBearer: false the same JWT is 401'; 'a signJWT token minted with audience "inventory" is 401 at the origin'.
  - (NAM-001) Same file: 'stateless recipe: Auth.make([Jwt]) over Sessions.layerMemory with no SqlClient serves a JWT-bearer request'.
  - (NAM-001) packages/server/test/AuthHttp.test.ts: 'an opaque id.secret bearer still resolves via Sessions (BEH-EA-066 regression)'.
- **Acceptance:**
  - (NAM-001) A JWT presented as a bearer credential authenticates iff `acceptAsBearer` is on and `jwt.verify` passes; opaque session bearers behave exactly as before.
  - (NAM-001) `AuthenticationLive`'s R is unchanged (the resolver is a Context.Reference).
  - (NAM-001) README documents the stateless profile and revocation-lag bound.
  - (NAM-001) `pnpm run test`, `pnpm run test:bdd`, `pnpm run spec:verify:strict` pass.

### 10. `plugin-api-surface-conventions` — Consistent HTTP contract conventions

- **Closes:** AVS-005, AVS-007
- **Why grouped:** Two small contract-shape fixes (group-level auth middleware, POST for credential issuance) best reviewed together before first publish.
- **Effort:** S · **Depends on workstreams:** none
- **Ordered steps:**
  1. (AVS-005) packages/password/src/PasswordApi.ts: create `PasswordAccountGroup = HttpApiGroup.make("password.account")` holding `changePassword` and `reauthenticate` (paths unchanged), `.middleware(Api.Authentication)` plus the same group-level CSRF middleware the `password` group carries; add it to `PasswordApi`.
  2. (AVS-005) packages/password/src/Password.ts: split handlers into `HttpApiBuilder.group(PasswordApi, "password.account", …)` and merge into `PasswordHandlers`.
  3. (AVS-005) Update the JwtApi.ts header (lines 12-17) to cite passkey and password as examples; mention the convention in the plugin-authoring docs if present.
  4. (AVS-007) JwtApi.ts:64 → `HttpApiEndpoint.post("mint", "/jwt/token", { success: TokenResponse })`; update the header comment.
  5. (AVS-007) Once wayfinder-24's CSRF attachment lands, the unsafe method is covered by CsrfProtection (bearer requests exempt per that decision).
- **Test plan (write first):**
  - (AVS-005) packages/password AuthHttp tests stay green unchanged (same paths/status codes); add 'POST /change-password without a session is 401 via the password.account group middleware'.
  - (AVS-007) AuthHttp.test.ts (first): convert the three `GET /jwt/token` tests (lines 182-196, 221) to POST and add 'GET /jwt/token is 404/405'.
- **Acceptance:**
  - (AVS-005) No shipped plugin contract uses per-endpoint `.middleware(Api.Authentication)` inside a mixed public group; `pnpm run test` + `pnpm run test:bdd` green.
  - (AVS-007) Minting is POST-only; tests green.

### 11. `oauth-provider-presets` — OAuth vendor presets and friendlier provider config

- **Closes:** IC-003, NAM-003, MW-010, BO-009
- **Why grouped:** Four findings on the absence of vendor presets; BO-009's plain-string ergonomics half is independent and can ship first.
- **Effort:** L · **Depends on workstreams:** oauth-provider-boot-validation
- **Ordered steps:**
  1. (IC-003) New packages/oauth/src/presets/*.ts (index re-export) and a `./presets` entry in packages/oauth/package.json `exports`: `google`, `github`, `apple`, `microsoft` (Entra; `tenant` param), `gitlab`, `discord` to start (Auth.js top usage). Each: `(input: { clientId, clientSecret, scopes?, mapProfile? }) => OAuthProviderConfig` pre-filling id/issuer/discoveryUrl or endpoints/scopes/mapProfile/quirks.
  2. (IC-003) Discovery-based presets rely on BEH-EA-127's exact-issuer match, so a stale preset fails loudly at boot.
  3. (IC-003) mapProfile per vendor maps picture/avatar_url into `image` once NAM-009 lands.
  4. (IC-003) Rewrite OAuthProvider.ts header (lines 4-11). Add a migration table (Auth.js provider id → preset, and quirks) to packages/oauth/README.md.
  5. (BO-009) OAuthProvider.ts: type `issuer`, `discoveryUrl`, `clientId` as `string | Config.Config<string>`; normalize in `resolve()` with a helper `const lift = (v) => typeof v === "string" ? Config.succeed(v) : v` (Effect v4 Config.succeed, Config.ts:966) — type narrowing, no casts.
  6. (BO-009) Leave `clientSecret?: Config.Config<Redacted.Redacted<string>>` unchanged (BEH-EA-126).
  7. (BO-009) Update the BEH-EA-127 example in docs to show both forms.
- **Test plan (write first):**
  - (IC-003) packages/oauth/test/OAuthPresets.test.ts (first): each preset resolves against a fake discovery/endpoints and its mapProfile maps a recorded vendor claim sample (e.g. GitHub numeric `id` → string subject).
  - (BO-009) OAuth.test.ts (first): 'oidc({ issuer: "https://…", clientId: "abc", … }) with plain strings resolves'; a type-level test that a plain-string clientSecret is rejected (`// @ts-expect-error`).
- **Acceptance:**
  - (IC-003) `OAuthPresets.github({ clientId, clientSecret })` is a complete provider; all BEH-EA-121..128 guarantees still apply; factories remain the escape hatch.
  - (BO-009) Non-secret fields accept plain strings; secrets still require Config.Redacted.

### 12. `session-authentication-methods` — amr/auth_time on sessions and JWTs

- **Closes:** AOMS-012
- **Why grouped:** Cross-package (sql, core, api, server, password, oauth, passkey, jwt) session-schema change.
- **Effort:** L · **Depends on workstreams:** none
- **Ordered steps:**
  1. (AOMS-012) packages/sql/src/Models.ts `Session`: add `authMethods` (JSON text array, `update` variant for reauthenticate) + a CoreMigrations migration; mirror in `Sessions.layerMemory`'s row.
  2. (AOMS-012) packages/core/src/Sessions.ts `issue` input: `authMethods: ReadonlyArray<string>`; `reauthenticate` appends; expose on `SessionView`.
  3. (AOMS-012) Callers: password signIn → ["pwd"]; OAuth callback → ["fed"] plus `idp` = providerId; passkey → ["hwk", "user"]; MFA (wayfinder 05) appends "otp"/"mfa".
  4. (AOMS-012) packages/api `UserPrincipal` gains `authMethods` and `authenticatedAt`; `PrincipalResolverLive` maps them (BEH-EA-069).
  5. (AOMS-012) packages/jwt/src/Jwt.ts `principalClaims`: emit `amr` and `auth_time` (epoch seconds of authenticatedAt) for User principals.
- **Test plan (write first):**
  - (AOMS-012) packages/jwt/test/Jwt.test.ts (first): 'a JWT for a password-issued session carries amr ["pwd"] and auth_time'.
  - (AOMS-012) packages/oauth/test/OAuth.test.ts: 'an OAuth sign-in session carries amr ["fed"]'; packages/core/test/Sessions.test.ts: 'reauthenticate appends the method'.
- **Acceptance:**
  - (AOMS-012) Downstream verifiers can distinguish password vs federated vs passkey logins from the token alone.

### 13. `user-profile-image` — User.image / OAuthProfile.image

- **Closes:** NAM-009
- **Why grouped:** Schema addition best batched with wayfinder-09's UserRecord revision (cross-slice FAMS-002).
- **Effort:** M · **Depends on workstreams:** none
- **Ordered steps:**
  1. (NAM-009) packages/oauth/src/OAuthProvider.ts `OAuthProfile`: `readonly image?: string`.
  2. (NAM-009) packages/sql/src/Models.ts `User`: nullable `image` column + migration; packages/core/src/Users.ts `UserRecord.image?`; `create` accepts it. Ship in the same migration wave as wayfinder-09's UserRecord identity revision to avoid two schema churns.
  3. (NAM-009) packages/oauth/src/OAuth.ts callback: pass `profile.image` on user creation (never overwrite on link).
  4. (NAM-009) Expose on the session/user DTO the client reads; document in the Auth.js migration table.
- **Test plan (write first):**
  - (NAM-009) packages/oauth/test/OAuth.test.ts (first): 'mapProfile image lands on the newly created user'.
- **Acceptance:**
  - (NAM-009) Avatars survive OAuth sign-up; field optional everywhere.

### 14. `plugin-port-boundary-enforcement` — Compile-time enforcement of 'plugins never provide ports'

- **Closes:** JH-008
- **Why grouped:** Core `Validate<P>` change implementing ADR-EA-010/BEH-EA-020; independent of the jwt work.
- **Effort:** M · **Depends on workstreams:** none
- **Ordered steps:**
  1. (JH-008) packages/ports/src/index.ts: export a type-only `ReservedPort` union of the port service identifiers (PasswordHasher, Mailer, RateLimiter, WebAuthn, KeyProvider, Encryption, SqlTransaction, ClientAddress, LegacySessionBridge) plus `SqlClient.SqlClient` and `Crypto.Crypto` (BEH-EA-020's list).
  2. (JH-008) packages/core/src/Auth.ts `Validate<P>`: add a `PortsProvidedByPlugin` check — for each plugin, `Extract<Layer.Success<P[i]["layer"]>, ReservedPort>` must be `never`, else the tuple position resolves to a branded error type naming the plugin id and port, mirroring the existing DuplicateId/MissingDep/SlotConflict encodings (BEH-EA-010..012).
  3. (JH-008) Seams (`PostAuthResponseHook`, future `BearerCredentialResolver`) and slots (`SubjectResolver`, already SlotConflict-checked) are Context.References/slots, not ports — unaffected.
  4. (JH-008) Flip ADR-EA-010's status to implemented and extend BEH-EA-020 with the compile-time enforcement sentence.
- **Test plan (write first):**
  - (JH-008) packages/core/test (type-level, first): '`Auth.make([Evil])` where Evil.layer provides PasswordHasher is a compile error (`// @ts-expect-error`) naming PortsProvidedByPlugin'; Jwt/Roles compositions still typecheck.
- **Acceptance:**
  - (JH-008) A plugin smuggling a port implementation cannot be composed; `pnpm run typecheck` + `pnpm run spec:verify:strict` green.

### 15. `m2m-machine-credentials` — Machine credentials (owned cross-slice by OCM-001/OCM-002)

- **Closes:** OCM-006, OCM-007
- **Why grouped:** No in-slice work: both close as duplicates of the api-key/client_credentials plan decided in wayfinder ticket 10.
- **Effort:** S · **Depends on workstreams:** none
- **No in-slice work** — closes as duplicates of cross-slice canonicals.

## Decisions needed

### PDR-003 — JWT plugin mirrors a bearer token onto every authenticated response via x-jwt-token with no opt-out

- A. Keep always-on mirroring (better-auth `set-auth-jwt` parity, today's behavior).
- B. Config knob `mirrorResponses: "off" | "bearer" | "always"`, default `"off"`.
- C. Same knob, default `"bearer"` (only clients that already hold a bearer credential receive the header; cookie sessions never leak a portable token).

**Recommendation:** B — the knob gives every deployment the richer choice (flexibility), and default-off removes the silent cookie→portable-bearer conversion four independent auditors flagged; apps wanting better-auth parity opt into "always" with one line.

### FAMS-005 — JWT plugin cannot interop with Firebase tokens in either direction

- A. Verification-only interop: RS256 in the lite verifier + a documented app-level recipe (verify Firebase token → Sessions.issue). No new endpoint.
- B. Ship an inbound `POST /jwt/exchange` (RFC 8693-style) with a configurable trusted-issuer list.

**Recommendation:** A now — it unblocks dual-running with no new trust surface; revisit B only if a concrete migrator needs signInWithCustomToken parity (avoid speculative infra).

### IC-003 — Zero OAuth provider presets — every app hand-assembles issuer/endpoints/mapProfile

- A. Keep mechanism-only; publish a docs table of per-vendor config.
- B. Ship data presets in an `@awthaq/oauth/presets` subpath (same package, same version).
- C. Ship presets as a separate, independently-versioned package (`@awthaq/oauth-presets`).

**Recommendation:** B — highest product value for the smallest surface; exact-issuer discovery makes stale presets fail loudly, and a subpath keeps the core import graph unchanged. C only if vendor churn later demands a separate release cadence.

Everything else is covered by existing decisions (wayfinder 10, 11, 33) or is mechanically specified.

## Per-issue dossiers

### Workstream `jwt-signing-key-at-rest-encryption`

#### KRS-001 — JWT private signing keys stored as plaintext JSON in the database

`high` · `security` · `jwt` · [.issues/high/KRS-001-key-rotation-specialist.md](../../.issues/high/KRS-001-key-rotation-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high)
  · canonical for: SMS-001-secrets-management-specialist

**Evidence at HEAD:**

- `packages/jwt/src/SigningKeyRecords.ts:221` — Redacted is unwrapped and the private JWK (incl. `d`) is written as plaintext JSON.

  ```ts
          publicKeyJwk: JSON.stringify(input.publicKeyJwk),
          privateKeyJwk: Option.match(input.privateKeyJwk, {
            onNone: () => null,
            onSome: (redacted) => JSON.stringify(Redacted.value(redacted)),
          }),
  ```

- `packages/jwt/src/SigningKeyRecords.ts:143` — Column is a plain string; no Encryption envelope anywhere in the package.

  ```ts
    privateKeyJwk: Schema.NullOr(Schema.String),
  ```

- `packages/ports/src/Encryption.ts:101` — The reusable, kid-versioned AES-GCM port already used by packages/sql/src/Repositories.ts:200 for provider tokens.

  ```ts
    readonly encrypt: (plaintext: Redacted.Redacted<string>, aad: string) => Effect.Effect<string>;
    readonly decrypt: (
      envelope: string,
      aad: string,
    ) => Effect.Effect<Redacted.Redacted<string>, DecryptionFailed | UnknownKeyId>;
  ```

**Fix plan:** Encrypt `privateKeyJwk` at rest through the existing `@awthaq/ports` Encryption port (AAD bound to the row's kid) and decode both JWK columns with Schema instead of `JSON.parse`.

Steps:
1. packages/jwt/src/SigningKeyRecords.ts `layerSql`: `const encryption = yield* Encryption.Encryption` (import from `@awthaq/ports`; add the workspace dependency to packages/jwt/package.json if missing). Add `const privateKeyAad = (kid: string) => `jwt_signing_key:${kid}:privateKeyJwk``.
2. In `create`, replace `JSON.stringify(Redacted.value(redacted))` with `encryption.encrypt(Redacted.make(JSON.stringify(Redacted.value(redacted))), privateKeyAad(input.kid))` (the envelope string is what goes into the column).
3. Replace the synchronous `toRecord` (lines 149-159, which also launders `JSON.parse`'s `any` into `Jwk`) with an effectful `decodeRow`: decode `publicKeyJwk` via `Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))`; for a non-null `privateKeyJwk`, `encryption.decrypt(envelope, privateKeyAad(row.kid))`, then schema-decode the plaintext JSON and wrap in `Redacted.make`. Map `DecryptionFailed`/`UnknownKeyId`/SchemaError to `Effect.die(new Error(`awthaq/jwt: signing key "${kid}" could not be decrypted`))` — an undecryptable signing key is a deployment fault. Use it in create/findCurrent/listVerifiable/markRotated.
4. Let `layerSql`'s type be inferred (no annotation); it becomes `Layer<SigningKeyRecords, never, SqlClient | Encryption>`. Keep `layerMemory` plaintext (in-process only) and say so in the header comment (rewrite lines 10-17, which currently justify the plaintext JSON convention).
5. Rewrite packages/jwt/README.md (currently a 'planned package' stub): document at-rest encryption, the Encryption/KeyProvider requirement for `layerSql`, and recommend `KeyRing.registerRemoteKey` + `JwtCodec.RemoteSigner` (KMS/HSM) for production so private material never lands in the DB at all.
6. No legacy-plaintext shim: the library is pre-release and unpublished.

Files: `packages/jwt/src/SigningKeyRecords.ts`, `packages/jwt/package.json`, `packages/jwt/README.md`, `packages/jwt/test/KeyRing.test.ts`, `packages/jwt/test/RevocationStore.test.ts`

Tests:
- packages/jwt/test/KeyRing.test.ts (sql suite, write first): 'layerSql never stores the private JWK in plaintext' — after first `KeyRing.current`, `SELECT privateKeyJwk FROM jwt_signing_key` must not contain `"d"` and must decode as an Encryption envelope (`v`/`kid`/`iv`/`ciphertext`). Provide `Encryption.layer` + `KeyProvider.layerEnv` exactly like packages/core/test/Accounts.test.ts:37-40.
- Same file: 'a privateKeyJwk ciphertext copied onto another kid's row fails to decrypt (AAD binding)' — UPDATE one row's column with another's, then `findCurrent` dies.
- Existing sign/verify round-trips over layerSql stay green.

Acceptance:
- `jwt_signing_key.privateKeyJwk` holds an Encryption envelope, never JWK JSON.
- Swapping ciphertext between rows is detected (die), not silently accepted.
- No `JSON.parse` result flows into a typed `Jwk` without a Schema decode; no `as` in SigningKeyRecords.ts.
- `pnpm run typecheck`, `pnpm run test`, `pnpm lint`, `pnpm knip` pass.

Spec: none · Effort: **M** · Depends on: none

**Recommended status:** `ready-for-agent`

#### SMS-001-secrets-management-specialist — JWT private signing keys persisted as plaintext JWK JSON in the database

`high` · `security` · `jwt` · [.issues/high/SMS-001-secrets-management-specialist.md](../../.issues/high/SMS-001-secrets-management-specialist.md) · current status `ready-for-agent`

**Verdict:** DUPLICATE of **KRS-001** (confidence: high)

**Evidence at HEAD:**

- `packages/jwt/src/SigningKeyRecords.ts:224` — Identical construct and root cause as KRS-001 (same file/line, same recommended Encryption-port fix).

  ```ts
            onSome: (redacted) => JSON.stringify(Redacted.value(redacted)),
  ```

**No separate fix** — resolved by KRS-001's plan.

**Recommended status:** `resolved`

### Workstream `jwt-lite-verifier-jwks-cache`

#### ECF-002 — Unknown-kid JWKS refetch runs once per request with no single-flight, TTL, or negative caching

`high` · `security` · `jwt` · [.issues/high/ECF-002-effect-concurrency-fiber-specialist.md](../../.issues/high/ECF-002-effect-concurrency-fiber-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high)
  · canonical for: JJS-002, KRS-010

**Evidence at HEAD:**

- `packages/jwt/src/verify.ts:83` — No TTL, no in-flight coalescing: cache fill is check-then-Ref.set.

  ```ts
      const fetchKeys = httpClient.get(options.jwksUrl).pipe(
        Effect.flatMap(HttpIncomingMessage.schemaBodyJson(JwksDocumentSchema)),
        Effect.map(toVerificationKeys),
        Effect.tap((keys) => Ref.set(cache, Option.some(keys))),
  ```

- `packages/jwt/src/verify.ts:105` — Every request with a garbage kid triggers one outbound JWKS fetch; no negative cache.

  ```ts
          const keys = yield* currentKeys;
          return yield* verifyAgainst(token, keys).pipe(
            Effect.catchIf(
              (error) => error.reason === "unknown kid",
              () => Effect.flatMap(fetchKeys, (refetched) => verifyAgainst(token, refetched)),
  ```

- `packages/oauth/src/OAuth.ts:335` — OAuth side: fd8e5e9 added a 15-min TTL, but still no single-flight, and `findKey` failure (line 342-346) refetches once per request with no negative cache.

  ```ts
      const cachedEntry = HashMap.get(yield* Ref.get(jwksCache), provider.id);
      const jwks =
        Option.isSome(cachedEntry) &&
        Date.now() - cachedEntry.value.fetchedAt < Duration.toMillis(JWKS_CACHE_TTL)
          ? cachedEntry.value.jwks
          : yield* fetchAndCacheJwks;
  ```

**Fix plan:** Single-flight, TTL'd JWKS caches with a rate-limited unknown-kid refetch in both the lite verifier and OAuth's id_token verifier; publish Cache-Control on /jwt/jwks.

Steps:
1. packages/jwt/src/verify.ts: build the key source with `Effect.cachedInvalidateWithTTL(fetchKeys, options.cacheTtl ?? "10 minutes")` (Effect v4 Effect.ts:7279 returns `[get, invalidate]`); `currentKeys = get` — concurrent cold starts share one in-flight fetch and entries expire (closes JJS-002/KRS-010's 'never expires').
2. Unknown-kid path: guard the forced refetch with `Effect.Semaphore` (1 permit) + a `Ref<number>` of the last forced refetch time read from `Clock`; inside the permit, if the last forced refetch is younger than `options.minRefetchInterval ?? "30 seconds"`, fail `unknown kid` immediately (negative cache); otherwise `invalidate` then `get` and retry verification once.
3. Extend `VerifierOptions` with optional `cacheTtl?: Duration.Input` and `minRefetchInterval?: Duration.Input`; document defaults relative to the issuer's `keyGracePeriod` in the module header.
4. packages/jwt/src/Jwt.ts `JwtHandlers` `jwks` handler: return an `HttpServerResponse` (HttpApiBuilder passes a returned response through untouched — ../effect/packages/effect/src/unstable/httpapi/HttpApiBuilder.ts:855) with `cache-control: public, max-age=<JwtConfig.jwksMaxAge seconds>`; add `jwksMaxAge: Duration` to `JwtConfig` (default 10 minutes).
5. packages/oauth/src/OAuth.ts `verifyIdToken`: replace the `Ref<HashMap<providerId, JwksCacheEntry>>` + `Date.now()` logic (lines 325-347) with one `Effect.cachedInvalidateWithTTL` per resolved provider, created once in the plugin `make` (providers are resolved at boot), plus the same min-refetch-interval guard around the kid-miss refetch; use `Clock` instead of `Date.now()` so TestClock drives it.

Files: `packages/jwt/src/verify.ts`, `packages/jwt/src/Jwt.ts`, `packages/jwt/src/JwtConfig.ts`, `packages/oauth/src/OAuth.ts`, `packages/jwt/test/verify.test.ts`, `packages/jwt/test/AuthHttp.test.ts`, `packages/oauth/test/OAuth.test.ts`

Tests:
- packages/jwt/test/verify.test.ts: 'N concurrent first verifications perform exactly one JWKS fetch' (count requests in the fake HttpClient, `Effect.all(..., { concurrency: 'unbounded' })`).
- verify.test.ts: 'a burst of tokens with garbage kids within minRefetchInterval performs at most one refetch'.
- verify.test.ts: 'a key removed from the JWKS stops verifying once cacheTtl elapses' (TestClock.adjust past the TTL) — also JJS-009's third requested test.
- packages/jwt/test/AuthHttp.test.ts: 'GET /jwt/jwks carries Cache-Control max-age'.
- packages/oauth/test/OAuth.test.ts: 'concurrent callbacks presenting an unknown kid cause one JWKS refetch, not one per request'.

Acceptance:
- Outbound JWKS fetches are bounded by 1 per cacheTtl plus 1 per minRefetchInterval, regardless of request rate or kid values.
- Keys dropped from the JWKS stop verifying within cacheTtl without a restart.
- /jwt/jwks responses carry Cache-Control.
- Full gate `pnpm check` passes.

Spec: no BEH-EA id covers @awthaq/jwt yet (M7); update .scratch/jwt/spec.md and spec/models/08-jwt-bearer.md instead, BEH-EA-127 (OAuth id_token verification path, unchanged semantics) · Effort: **M** · Depends on: none

**Recommended status:** `ready-for-agent`

#### JJS-002 — Lite-verifier JWKS cache never expires: keys removed from the JWKS stay trusted indefinitely

`medium` · `security` · `jwt` · [.issues/medium/JJS-002-jwt-jwk-specialist.md](../../.issues/medium/JJS-002-jwt-jwk-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **ECF-002** (confidence: high)

**Evidence at HEAD:**

- `packages/jwt/src/verify.ts:92` — Still no expiry; ECF-002's `cachedInvalidateWithTTL` plan (validated earlier as ready-for-agent) adds the TTL and single-flight this finding asks for.

  ```ts
      const currentKeys = Ref.get(cache).pipe(
        Effect.flatMap(Option.match({ onSome: Effect.succeed, onNone: () => fetchKeys })),
      );
  ```

**No separate fix** — resolved by ECF-002's plan.

**Recommended status:** `resolved`

#### KRS-010 — Lite verifier's JWKS cache never expires keys and the served JWKS sets no caching guidance

`low` · `security` · `jwt` · [.issues/low/KRS-010-key-rotation-specialist.md](../../.issues/low/KRS-010-key-rotation-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **ECF-002** (confidence: high)

**Evidence at HEAD:**

- `packages/jwt/src/verify.ts:92` — Same never-expiring cache as ECF-002/JJS-002.

  ```ts
      const currentKeys = Ref.get(cache).pipe(
        Effect.flatMap(Option.match({ onSome: Effect.succeed, onNone: () => fetchKeys })),
  ```

- `packages/jwt/src/JwtApi.ts:56` — No Cache-Control on the served JWKS — folded into ECF-002's plan as an explicit step.

  ```ts
  export const JwtGroup = HttpApiGroup.make("jwt").add(
    HttpApiEndpoint.get("jwks", "/jwt/jwks", {
      success: JwksResponse,
    }),
  );
  ```

**No separate fix** — resolved by ECF-002's plan.

**Recommended status:** `resolved`

### Workstream `oauth-provider-boot-validation`

#### ESS-002-effect-schema-specialist — OIDC discovery document cast, not decoded, at plugin boot

`high` · `correctness` · `oauth` · [.issues/high/ESS-002-effect-schema-specialist.md](../../.issues/high/ESS-002-effect-schema-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high)
  · canonical for: TTE-003, AH-003-anders-hejlsberg

**Evidence at HEAD:**

- `packages/oauth/src/OAuthProvider.ts:140` — Untrusted wire data asserted, not decoded; only `issuer` is checked (line 145).

  ```ts
        const document = yield* httpClient.get(discoveryUrl).pipe(
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as DiscoveryDocument),
          Effect.orDie,
        );
  ```

- `packages/oauth/src/OAuthProvider.ts:153` — Non-string endpoints flow straight into URL construction.

  ```ts
        authorizationEndpoint ??= document.authorization_endpoint;
        tokenEndpoint ??= document.token_endpoint;
  ```

**Fix plan:** Decode the discovery document with a Schema at boot; a shape error dies with a message naming provider and field.

Steps:
1. packages/oauth/src/OAuthProvider.ts: replace `interface DiscoveryDocument` (lines 100-106) with `DiscoveryDocumentSchema = Schema.Struct({ issuer: Schema.String, authorization_endpoint: Schema.optional(Schema.String), token_endpoint: Schema.optional(Schema.String), jwks_uri: Schema.optional(Schema.String), userinfo_endpoint: Schema.optional(Schema.String), id_token_signing_alg_values_supported: Schema.optional(Schema.Array(Schema.String)), code_challenge_methods_supported: Schema.optional(Schema.Array(Schema.String)) })` (extra members ignored).
2. Fetch via `Effect.flatMap(HttpIncomingMessage.schemaBodyJson(DiscoveryDocumentSchema))`; map failures to `Effect.die(new Error(`awthaq/oauth: provider "${config.id}" discovery document is invalid: ${issue}`))` keeping BEH-EA-127's die-at-boot semantics.
3. Optionally validate endpoints parse as absolute URLs (Schema check with `URL.canParse`).

Files: `packages/oauth/src/OAuthProvider.ts`, `packages/oauth/test/OAuth.test.ts`

Tests:
- OAuth.test.ts (first): 'a discovery document whose token_endpoint is not a string dies at boot naming the field'; 'a JSON array discovery body dies at boot'.

Acceptance:
- No `as` in OAuthProvider.ts; malformed discovery fails boot with a diagnostic message; BEH-EA-127 scenarios stay green.

Spec: BEH-EA-127 · Effort: **S** · Depends on: none

**Recommended status:** `ready-for-agent`

#### OAP-005 — No boot-time guard against quirks.skipPkce on a public client (no clientSecret): bare authorization code exchange

`medium` · `security` · `oauth` · [.issues/medium/OAP-005-oauth2-authorization-code-pkce-specialist.md](../../.issues/medium/OAP-005-oauth2-authorization-code-pkce-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)
  · canonical for: AP-007

**Evidence at HEAD:**

- `packages/oauth/src/OAuthProvider.ts:28`

  ```ts
  /** BEH-EA-121: a provider that rejects PKCE outright (documented per-provider, never a general escape hatch). */
  export interface OAuthProviderQuirks {
    readonly skipPkce?: boolean;
  }
  ```

- `packages/oauth/src/OAuthProvider.ts:180` — Accepted regardless of whether `clientSecret` is configured — a public client can run a bare code exchange.

  ```ts
        skipPkce: config.quirks?.skipPkce ?? false,
  ```

**Fix plan:** Gate `quirks.skipPkce` to confidential clients at boot and log whenever it is used.

Steps:
1. OAuthProvider.ts `resolve()`: `if (config.quirks?.skipPkce === true && Option.isNone(clientSecret)) die(`awthaq/oauth: provider "${config.id}" sets quirks.skipPkce but has no clientSecret — a public client must use PKCE (RFC 9700 §2.1.1)`)`.
2. When skipPkce is set (and allowed), `Effect.logWarning` naming the provider id once at boot.
3. Amend BEH-EA-121's requirement text: the skipPkce quirk is permitted only for confidential clients.

Files: `packages/oauth/src/OAuthProvider.ts`, `spec/behaviors/16-oauth.md`, `packages/oauth/test/OAuth.test.ts`

Tests:
- OAuth.test.ts (first): 'skipPkce without clientSecret dies at boot'; existing 'apple' skipPkce scenario (with clientSecret) stays green.

Acceptance:
- No configuration can produce a PKCE-less public-client code flow.

Spec: BEH-EA-121 · Effort: **S** · Depends on: none

**Recommended status:** `ready-for-agent`

#### JR-009 — oidc() factory does not require the openid scope; a mis-scoped provider surfaces only as an undifferentiated runtime 400

`low` · `dx` · `oauth` · [.issues/low/JR-009-justin-richer.md](../../.issues/low/JR-009-justin-richer.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `packages/oauth/src/OAuthProvider.ts:127` — The sibling boot check exists…

  ```ts
      if (config.kind === "oidc" && Option.isNone(configuredIssuer)) {
        return yield* Effect.die(
          new Error(`awthaq/oauth: provider "${config.id}" is oidc but declares no issuer`),
        );
      }
  ```

- `packages/oauth/src/OAuthProvider.ts:179` — …but scopes pass through verbatim; nothing requires `openid` for kind oidc.

  ```ts
        scopes: config.scopes,
  ```

**Fix plan:** Die at boot when an `oidc` provider's scopes omit `openid`.

Steps:
1. OAuthProvider.ts `resolve()`: next to the issuer check, `if (config.kind === "oidc" && !config.scopes.includes("openid")) return yield* Effect.die(new Error(`awthaq/oauth: provider "${config.id}" is oidc but its scopes omit "openid"`))`.

Files: `packages/oauth/src/OAuthProvider.ts`, `packages/oauth/test/OAuth.test.ts`

Tests:
- OAuth.test.ts (first): 'an oidc provider configured without openid scope dies at boot'.

Acceptance:
- Mis-scoped OIDC providers fail at registration, not as an opaque callback 400.

Spec: BEH-EA-127 (boot-time registration failure pattern) · Effort: **S** · Depends on: none

**Recommended status:** `ready-for-agent`

#### TTE-003 — OIDC discovery document asserted to DiscoveryDocument, only issuer checked

`medium` · `correctness` · `oauth` · [.issues/medium/TTE-003-typescript-type-level-engineer.md](../../.issues/medium/TTE-003-typescript-type-level-engineer.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **ESS-002-effect-schema-specialist** (confidence: high)

**Evidence at HEAD:**

- `packages/oauth/src/OAuthProvider.ts:142` — Same cast, same Schema-decode fix as ESS-002 (the high-severity canonical).

  ```ts
          Effect.map((body) => body as DiscoveryDocument),
  ```

**No separate fix** — resolved by ESS-002-effect-schema-specialist's plan.

**Recommended status:** `resolved`

#### AP-007 — quirks.skipPkce is not gated to confidential clients, so a public client can run code flow without PKCE

`medium` · `security` · `oauth` · [.issues/medium/AP-007-aaron-parecki.md](../../.issues/medium/AP-007-aaron-parecki.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **OAP-005** (confidence: high)

**Evidence at HEAD:**

- `packages/oauth/src/OAuthProvider.ts:29` — Same missing public-client guard and same boot-time fix as OAP-005.

  ```ts
  export interface OAuthProviderQuirks {
    readonly skipPkce?: boolean;
  }
  ```

**No separate fix** — resolved by OAP-005's plan.

**Recommended status:** `resolved`

#### AH-003-anders-hejlsberg — Discovery document asserted without validation at provider boot

`low` · `correctness` · `oauth` · [.issues/low/AH-003-anders-hejlsberg.md](../../.issues/low/AH-003-anders-hejlsberg.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **ESS-002-effect-schema-specialist** (confidence: high)

**Evidence at HEAD:**

- `packages/oauth/src/OAuthProvider.ts:142` — Same cast, same Schema-decode fix as ESS-002 (the high-severity canonical).

  ```ts
          Effect.map((body) => body as DiscoveryDocument),
  ```

**No separate fix** — resolved by ESS-002-effect-schema-specialist's plan.

**Recommended status:** `resolved`

### Workstream `jwt-claims-codec-hardening`

#### GC-002 — JWT claims have no schema on either side of the codec

`medium` · `architecture` · `jwt` · [.issues/medium/GC-002-giulio-canti.md](../../.issues/medium/GC-002-giulio-canti.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `packages/jwt/src/JwtCodec.ts:53` — Decode side validates only 'object of unknowns'.

  ```ts
  const PayloadSchema = Schema.Record(Schema.String, Schema.Unknown);
  ```

- `packages/jwt/src/JwtCodec.ts:129` — Encode side is an untyped bag, JSON.stringify'd (line 78).

  ```ts
  export const sign = (params: {
    readonly kid: string;
    readonly alg: Algorithm;
    readonly signer: Signer;
    readonly claims: Record<string, unknown>;
  }) =>
  ```

- `packages/jwt/src/JwtCodec.ts:242` — Hand-rolled claim checks; an RFC 7519 §4.1.3 array `aud` is rejected.

  ```ts
      if (payload["iss"] !== params.issuer || payload["aud"] !== params.audience) {
        return yield* Effect.fail(new JwtInvalidError({ reason: "iss/aud mismatch" }));
      }
      const exp = payload["exp"];
      if (typeof exp !== "number") {
  ```

**Fix plan:** One `RegisteredClaims` Schema used by both `JwtCodec.sign` (encode) and `parse` (decode); `verify` keeps only relational/temporal checks; `aud` accepts string or array.

Steps:
1. packages/jwt/src/JwtCodec.ts: define `RegisteredClaims = Schema.StructWithRest(Schema.Struct({ iss: Schema.String, aud: Schema.Union([Schema.String, Schema.NonEmptyArray(Schema.String)]), exp: Schema.Int, iat: Schema.optional(Schema.Int), nbf: Schema.optional(Schema.Int), jti: Schema.optional(Schema.String), sub: Schema.optional(Schema.NonEmptyString) }), [Schema.Record(Schema.String, Schema.Unknown)])` (Effect v4: `StructWithRest` Schema.ts:4031, `NonEmptyArray` :4528, `Int` :7581 — confirm the exact rest-argument shape there).
2. `sign`: take `claims: typeof RegisteredClaims.Type`, encode via `Schema.encodeEffect(Schema.fromJsonString(RegisteredClaims))` → base64url, replacing `encodeJson`'s raw `JSON.stringify` for the payload.
3. `parse`/`decodePayload`: decode with `Schema.fromJsonString(RegisteredClaims)` (decode failure → `JwtInvalidError('malformed token')`).
4. `verify`: keep `iss === issuer`; `aud` passes when equal to, or an array containing, `params.audience`; `exp`/`nbf` against `DateTime.now` with an optional `clockSkew` param (default 0). Return the decoded claims (typed) — callers that want `Record<string, unknown>` still get a supertype.
5. packages/jwt/src/Jwt.ts `signClaims`: build a value typed against `RegisteredClaims.Type` (registered claims still win over extras); no casts.

Files: `packages/jwt/src/JwtCodec.ts`, `packages/jwt/src/Jwt.ts`, `packages/jwt/src/verify.ts`, `packages/jwt/test/JwtCodec.test.ts (new)`

Tests:
- packages/jwt/test/JwtCodec.test.ts (new, first): 'an aud array containing the expected audience verifies'; 'an aud array without it fails'; 'a non-integer/absent exp fails as malformed'.
- Existing Jwt.test.ts/verify.test.ts round-trips stay green.

Acceptance:
- The claims contract exists once, as a Schema, on both sides of the codec.
- Array `aud` is accepted per RFC 7519 §4.1.3.
- No `as` introduced; `pnpm run typecheck` + `pnpm run test` green.

Spec: no BEH-EA id covers @awthaq/jwt yet (M7); update .scratch/jwt/spec.md and spec/models/08-jwt-bearer.md instead · Effort: **M** · Depends on: none

**Recommended status:** `ready-for-agent`

#### VB-005 — Single shared audience and no token-type separation across all minted JWTs

`medium` · `architecture` · `jwt` · [.issues/medium/VB-005-vittorio-bertocci.md](../../.issues/medium/VB-005-vittorio-bertocci.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `packages/jwt/src/JwtConfig.ts:44` — One audience for every token class.

  ```ts
      audience: options.audience ?? options.issuer,
  ```

- `packages/jwt/src/Jwt.ts:391` — `signClaims` overwrites any per-call aud; signJWT has no audience option.

  ```ts
                claims: { ...claims, iat, exp, jti, iss: config.issuer, aud: config.audience },
  ```

- `packages/jwt/src/Jwt.ts:409` — An arbitrary signJWT payload may carry `sub`/`sid` and is indistinguishable from a principal token (same typ "JWT"), so it passes verifyLive.

  ```ts
          const signJWT: JwtShape["signJWT"] = (payload, options) =>
            signClaims({ ...payload }, options?.ttl);
  ```

**Fix plan:** Separate token classes by header `typ` (principal/delegation tokens vs general signJWT tokens) and allow per-call audience on signJWT, per wayfinder ticket 33's `signJWT({ audience })` decision.

Steps:
1. `JwtCodec.sign` takes `typ: string`. `Jwt.sign(principal)` (mint endpoint, mirroring, ticket-33 re-entry) stamps `typ: "at+jwt"` (RFC 9068); `signJWT` stamps `typ: "JWT"` by default with an `options.typ?: string` override.
2. `signJWT` options gain `audience?: string | ReadonlyArray<string>` (ticket 33); `signClaims` uses `options.audience ?? config.audience` (registered claims still set only here).
3. `Jwt.verify`, `verifyLive`, `introspectLive`, and NAM-001's `BearerCredentialResolverLive` require `expectedTyp: "at+jwt"`; `verifyJWT` becomes its own function requiring `"JWT"` (or a caller-supplied typ) — a signJWT token with a forged `sid` can no longer pass verifyLive.
4. Lite verifier: `expectedTyp` default `"at+jwt"`; document per-consumer audience pinning (each downstream service constructs `makeVerifier({ audience: "svc-a" })`).
5. Update .scratch/jwt/spec.md 'Claims' and README.

Files: `packages/jwt/src/JwtCodec.ts`, `packages/jwt/src/Jwt.ts`, `packages/jwt/src/verify.ts`, `packages/jwt/src/JwtConfig.ts`, `packages/jwt/test/Jwt.test.ts`, `packages/jwt/test/verify.test.ts`

Tests:
- packages/jwt/test/Jwt.test.ts (first): 'signJWT({ sub, sid }) is rejected by verifyLive (typ mismatch)'.
- Jwt.test.ts: 'signJWT(payload, { audience: "svc-a" }) fails Jwt.verify at the origin'; verify.test.ts: 'the same token verifies via makeVerifier({ audience: "svc-a", expectedTyp: "JWT" })'.
- Jwt.test.ts: 'sign(principal) produces header typ at+jwt'.

Acceptance:
- Principal and general-purpose tokens are not interchangeable at any verifier; per-call audiences work; tests green.

Spec: no BEH-EA id covers @awthaq/jwt yet (M7); update .scratch/jwt/spec.md and spec/models/08-jwt-bearer.md instead · Effort: **M** · Depends on: GC-002, JJS-008

**Recommended status:** `ready-for-agent`

#### JJS-008 — typ header minted but never validated; spec's RFC 8725 strict alg/typ/iss/aud posture only partially implemented

`low` · `security` · `jwt` · [.issues/low/JJS-008-jwt-jwk-specialist.md](../../.issues/low/JJS-008-jwt-jwk-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `packages/jwt/src/JwtCodec.ts:48` — `typ` never decoded or checked.

  ```ts
  const HeaderSchema = Schema.Struct({
    alg: Schema.optional(Schema.String),
    kid: Schema.optional(Schema.String),
  });
  ```

- `packages/jwt/src/JwtCodec.ts:136` — Minted but unverified; `nbf` likewise never checked anywhere in `verify`.

  ```ts
      const header = { alg: params.alg, kid: params.kid, typ: "JWT" };
  ```

**Fix plan:** Decode and enforce `typ` (RFC 8725 §3.11) and honour `nbf`/`iat` in `JwtCodec.verify` and the lite verifier.

Steps:
1. JwtCodec.ts `HeaderSchema`: add `typ: Schema.optional(Schema.String)`.
2. `verify` params gain `expectedTyp: string`; reject when `header.typ !== expectedTyp` (case-insensitive per RFC 7515 §4.1.9 media-type rules) with the undifferentiated `JwtInvalidError`.
3. Reject `nbf` in the future and `iat` further in the future than `clockSkew` (uses GC-002's decoded claims).
4. packages/jwt/src/verify.ts `VerifierOptions`: `expectedTyp?: string` (default matches the principal-token typ chosen in VB-005).

Files: `packages/jwt/src/JwtCodec.ts`, `packages/jwt/src/verify.ts`, `packages/jwt/src/Jwt.ts`, `packages/jwt/test/JwtCodec.test.ts (new)`

Tests:
- JwtCodec.test.ts: 'a token whose header typ differs from expectedTyp fails'; 'a token with nbf in the future fails'; 'a token with iat far in the future fails'.

Acceptance:
- typ/nbf/iat enforced by both in-process verify and the lite verifier; tests green.

Spec: no BEH-EA id covers @awthaq/jwt yet (M7); update .scratch/jwt/spec.md and spec/models/08-jwt-bearer.md instead · Effort: **S** · Depends on: GC-002

**Recommended status:** `ready-for-agent`

#### JJS-009 — No negative tests for algorithm confusion or core unknown-kid fail-closed

`low` · `testing` · `jwt` · [.issues/low/JJS-009-jwt-jwk-specialist.md](../../.issues/low/JJS-009-jwt-jwk-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `packages/jwt/src/JwtCodec.ts:225` — Pins exist in code…

  ```ts
      if (parsed.header.alg !== params.algorithm) {
        return yield* Effect.fail(new JwtInvalidError({ reason: "algorithm not allowed" }));
      }
      const key = params.keys.find((candidate) => candidate.kid === kid);
      if (key === undefined) {
        return yield* Effect.fail(new JwtInvalidError({ reason: "unknown kid" }));
      }
  ```

- `packages/jwt/test/verify.test.ts:170` — …but the only kid test is the lite verifier's happy refetch; no test in packages/jwt/test/*.ts exercises alg none/HS256/cross-alg or core unknown-kid fail-closed (grep for `none`/`HS256`/`algorithm not allowed` is empty).

  ```ts
    it.effect("refetches once on an unknown kid, then succeeds", () =>
  ```

**Fix plan:** Add pinning tests for algorithm confusion and unknown-kid fail-closed.

Steps:
1. Create packages/jwt/test/JwtCodec.test.ts with hand-assembled tokens (base64url header/payload + a real signature from a generated key) exercising `JwtCodec.verify` directly.
2. These are characterization tests: they should pass on HEAD; confirm red by temporarily loosening the alg comparison / adding a first-key fallback locally before committing.
3. The 'retired key stops verifying after cache refresh' case is delivered by ECF-002's TTL test.

Files: `packages/jwt/test/JwtCodec.test.ts (new)`

Tests:
- 'header alg "none" fails'; 'header alg missing fails'; 'header alg "HS256" signed with the public key bytes as HMAC secret fails'; 'ES256 header against an EdDSA configuration fails'.
- 'a kid matching no key fails closed even when other keys exist (no first-key fallback)'.

Acceptance:
- Loosening either pin in JwtCodec.verify turns the suite red.

Spec: no BEH-EA id covers @awthaq/jwt yet (M7); update .scratch/jwt/spec.md and spec/models/08-jwt-bearer.md instead · Effort: **S** · Depends on: none

**Recommended status:** `ready-for-agent`

#### JJS-007 — signJWT/verifyJWT asymmetry: the general-purpose verifier mandates sub, rejecting tokens signJWT can mint

`low` · `api` · `jwt` · [.issues/low/JJS-007-jwt-jwk-specialist.md](../../.issues/low/JJS-007-jwt-jwk-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `packages/jwt/src/JwtCodec.ts:253` — Codec-level sub requirement.

  ```ts
      if (typeof payload["sub"] !== "string" || payload["sub"].length === 0) {
        return yield* Effect.fail(new JwtInvalidError({ reason: "missing sub" }));
      }
  ```

- `packages/jwt/src/Jwt.ts:431` — verifyJWT is literally `verify`, so `signJWT({ machine: "etl" })` mints a token its own verifyJWT rejects.

  ```ts
          const verifyJWT: JwtShape["verifyJWT"] = verify;
  ```

**Fix plan:** Move the `sub` requirement out of `JwtCodec.verify` into the principal-scoped verifiers; give `verifyJWT` its own implementation.

Steps:
1. JwtCodec.ts: delete the `sub` check from `verify`; add `requireSubject: boolean` to its params (principal callers pass true).
2. Jwt.ts: `verify` (principal) passes `requireSubject: true`; `verifyJWT` becomes a distinct function (`requireSubject: false`, `expectedTyp` per VB-005). Fix the JwtShape doc comments at lines 90-93 and 428-431.
3. verify.ts `VerifierOptions.requireSubject?: boolean` (default true).

Files: `packages/jwt/src/JwtCodec.ts`, `packages/jwt/src/Jwt.ts`, `packages/jwt/src/verify.ts`, `packages/jwt/test/Jwt.test.ts`

Tests:
- Jwt.test.ts (first): 'signJWT({ machine: "etl-job" }) verifies via verifyJWT'; 'Jwt.verify still rejects a principal token without sub'.

Acceptance:
- Every token signJWT can mint, verifyJWT can verify; principal verification unchanged.

Spec: no BEH-EA id covers @awthaq/jwt yet (M7); update .scratch/jwt/spec.md and spec/models/08-jwt-bearer.md instead · Effort: **S** · Depends on: VB-005

**Recommended status:** `ready-for-agent`

### Workstream `jwt-key-rotation-integrity`

#### JJS-003 — Changing JwtConfig.algorithm desynchronizes sign and verify until the next time-based rotation

`medium` · `correctness` · `jwt` · [.issues/medium/JJS-003-jwt-jwk-specialist.md](../../.issues/medium/JJS-003-jwt-jwk-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `packages/jwt/src/Jwt.ts:387` — Sign uses the stored key's alg…

  ```ts
              return yield* JwtCodec.sign({
                kid: key.kid,
                alg: key.alg,
  ```

- `packages/jwt/src/Jwt.ts:422` — …verify pins the configured alg.

  ```ts
                algorithm: config.algorithm,
  ```

- `packages/jwt/src/KeyRing.ts:160` — Rotation is age-only; an alg change never triggers it, so every new token fails 'algorithm not allowed' until the interval elapses.

  ```ts
        : isStale(existing.value.createdAt, now, config.keyRotationInterval)
  ```

- `packages/jwt/src/JwtConfig.ts:23` — `Algorithm` is also declared a second time at JwtCodec.ts:36.

  ```ts
  export type Algorithm = "EdDSA" | "ES256";
  ```

**Fix plan:** Rotate immediately when the current key's alg differs from config, and verify against each key's own alg under an allowlist so grace-period keys of the old alg keep verifying.

Steps:
1. KeyRing.ts `layerFromStore` and `rotateIfDue`: treat `current.alg !== config.algorithm` as due (rotate now).
2. JwtCodec.ts `verify`: replace `algorithm: Algorithm` with `algorithms: ReadonlyArray<Algorithm>`; require `header.alg === key.alg && algorithms.includes(key.alg)`; import/verify with `key.alg`.
3. Jwt.ts `verify`: pass `algorithms` = distinct algs of the verifiable key set (trusted server-side data).
4. verify.ts: `VerifierOptions.algorithm` → `algorithms: ReadonlyArray<Algorithm>` (pre-release breaking change is fine).
5. Single `Algorithm` type exported from JwtCodec.ts; JwtConfig.ts imports it (drop the duplicate at JwtConfig.ts:23).

Files: `packages/jwt/src/KeyRing.ts`, `packages/jwt/src/JwtCodec.ts`, `packages/jwt/src/Jwt.ts`, `packages/jwt/src/verify.ts`, `packages/jwt/src/JwtConfig.ts`, `packages/jwt/test/KeyRing.test.ts`, `packages/jwt/test/Jwt.test.ts`, `packages/jwt/test/verify.test.ts`

Tests:
- KeyRing.test.ts (first): 'switching JwtConfig.algorithm EdDSA→ES256 rotates on next access'.
- Jwt.test.ts: 'a token minted before an algorithm switch keeps verifying during grace; tokens minted after use ES256 and verify'.

Acceptance:
- Changing `algorithm` never breaks sign/verify; header alg must equal the matched key's alg.

Spec: no BEH-EA id covers @awthaq/jwt yet (M7); update .scratch/jwt/spec.md and spec/models/08-jwt-bearer.md instead · Effort: **M** · Depends on: none

**Recommended status:** `ready-for-agent`

#### KRS-006 — KeyRing only notices rotations visible to its own process; external rotateNow is invisible to busy servers

`medium` · `architecture` · `jwt` · [.issues/medium/KRS-006-key-rotation-specialist.md](../../.issues/medium/KRS-006-key-rotation-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `packages/jwt/src/KeyRing.ts:186` — Only the local snapshot's key age triggers a refresh.

  ```ts
  const rotateIfDue = Effect.gen(function* () {
    const ref = yield* KeyRing;
    const config = yield* JwtConfig;
    const cache = yield* Effect.provide(SigningKeysCache, ref.get);
    const now = yield* DateTime.now;
    if (isStale(cache.current.createdAt, now, config.keyRotationInterval)) {
      yield* ref.refresh;
    }
  ```

- `packages/jwt/src/KeyRing.ts:175` — idleTimeToLive never fires on a busy server; external rotateNow / peer rotations are invisible.

  ```ts
  export class KeyRing extends LayerRef.Service<KeyRing>()("awthaq/jwt/KeyRing", {
    layer: layerFromStore,
    idleTimeToLive: "1 hour",
  }) {}
  ```

**Fix plan:** Bound snapshot staleness with a max-age refresh and refresh once (rate-limited) on an unknown kid so peer/external rotations converge.

Steps:
1. KeyRing.ts: add `loadedAt: DateTime.Utc` to `SigningKeysShape`, set in `layerFromStore`.
2. JwtConfig.ts: add `keyCacheMaxAge: Duration` (default 5 minutes).
3. `rotateIfDue`: also `ref.refresh` when `now - loadedAt >= keyCacheMaxAge` (still one in-memory comparison per call).
4. Jwt.ts `verify`: on `JwtInvalidError` with reason `unknown kid`, perform one `ref.refresh` (single-flighted via a Semaphore and rate-limited like ECF-002's minRefetchInterval) and retry once — peer-minted keys verify immediately instead of after maxAge.

Files: `packages/jwt/src/KeyRing.ts`, `packages/jwt/src/JwtConfig.ts`, `packages/jwt/src/Jwt.ts`, `packages/jwt/test/KeyRing.test.ts`, `packages/jwt/test/Jwt.test.ts`

Tests:
- KeyRing.test.ts (first): 'an out-of-band rotateNow on the shared store is picked up by a busy KeyRing within keyCacheMaxAge' (two KeyRings over one store + TestClock.adjust).
- Jwt.test.ts: 'a token signed by a peer's freshly rotated key verifies via the unknown-kid refresh'.

Acceptance:
- Signers converge on externally-triggered rotations within keyCacheMaxAge; verifiers accept peer keys immediately.

Spec: no BEH-EA id covers @awthaq/jwt yet (M7); update .scratch/jwt/spec.md and spec/models/08-jwt-bearer.md instead · Effort: **M** · Depends on: JJS-004

**Recommended status:** `ready-for-agent`

#### JJS-004 — Key rotation has no concurrency guard: multi-instance rotation mints duplicate current keys and re-extends grace periods

`medium` · `correctness` · `jwt` · [.issues/medium/JJS-004-jwt-jwk-specialist.md](../../.issues/medium/JJS-004-jwt-jwk-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)
  · canonical for: KRS-009

**Evidence at HEAD:**

- `packages/jwt/src/SigningKeyRecords.ts:209` — No `rotatedAt IS NULL` guard: a second rotator re-extends retiresAt.

  ```ts
        execute: (r) => sql`
            UPDATE jwt_signing_key SET rotatedAt = ${r.rotatedAt}, retiresAt = ${r.retiresAt}
            WHERE kid = ${r.kid}
            RETURNING *
          `,
  ```

- `packages/jwt/src/KeyRing.ts:157` — Find → mark → mint, untransactioned and unlocked.

  ```ts
      const existing = yield* records.findCurrent();
      const current = yield* Option.isNone(existing)
        ? mint(config.algorithm)
        : isStale(existing.value.createdAt, now, config.keyRotationInterval)
          ? markRotated(existing.value, now, config.keyGracePeriod).pipe(
              Effect.andThen(mint(config.algorithm)),
            )
  ```

- `packages/jwt/src/Jwt.ts:300` — The partial index added by 402d7f5 (SSMS-001) is non-unique — nothing enforces a single current key.

  ```ts
        yield* sql`
          CREATE INDEX jwt_signing_key_active_idx ON jwt_signing_key (createdAt)
          WHERE rotatedAt IS NULL`;
  ```

**Fix plan:** Enforce one current signing key at the store (unique partial index + conditional markRotated), and run mark+mint atomically in `SqlTransaction`, with losers re-reading the winner.

Steps:
1. packages/jwt/src/Jwt.ts `jwtMigrations`: append `create_jwt_signing_key_single_current_index`: `CREATE UNIQUE INDEX jwt_signing_key_single_current ON jwt_signing_key ((rotatedAt IS NULL)) WHERE rotatedAt IS NULL` (expression + partial unique index; valid on pg and sqlite >= 3.9 — verify both in the migration test).
2. packages/jwt/src/SigningKeyRecords.ts: `markRotated` becomes `UPDATE … WHERE kid = ? AND rotatedAt IS NULL RETURNING *` via `SqlSchema.findOneOption` and returns `Effect<boolean>` (won/lost); `layerMemory` mirrors it (only modifies a row whose rotatedAt is None). `create` maps a unique-constraint `SqlError` to a typed `CurrentKeyConflict` (Data.TaggedError) instead of `orDie`.
3. packages/jwt/src/KeyRing.ts: wrap `markRotated + mint` in `SqlTransaction.withTransaction` (packages/ports/src/SqlTransaction.ts; `layerNoop` for memory) in both `layerFromStore` and `rotateNow`; on a lost `markRotated` or `CurrentKeyConflict`, re-read `findCurrent` and adopt the winner (covers the concurrent lazy first-mint race too). `KeyRing` then requires `SqlTransaction` — document in README.
4. `registerRemoteKey`: in the same transaction, mark the existing current key rotated so the remote key becomes the single current key (otherwise it violates the new index).
5. With the guard, a repeated rotation can no longer rewrite `retiresAt` (grace window no longer re-extended).

Files: `packages/jwt/src/SigningKeyRecords.ts`, `packages/jwt/src/KeyRing.ts`, `packages/jwt/src/Jwt.ts`, `packages/jwt/test/KeyRing.test.ts`, `packages/jwt/test/RevocationStore.test.ts`

Tests:
- packages/jwt/test/KeyRing.test.ts, both memory and sql suites (first): 'two concurrent rotations of a stale key leave exactly one current key' (Effect.all two `rotateNow`/two KeyRing instances over one store).
- Same file: 'concurrent lazy first-mint yields exactly one current key'; 'markRotated on an already-rotated kid leaves retiresAt unchanged'; 'a failing mint after markRotated rolls back (layerSql + SqlTransaction.layerSql)'.
- packages/jwt/test/RevocationStore.test.ts migrations block: 'creates the single-current unique index'.

Acceptance:
- `SELECT count(*) FROM jwt_signing_key WHERE rotatedAt IS NULL` is ≤ 1 under any interleaving.
- A crash between mark and mint leaves the previous key current (transaction rolled back).
- `pnpm run test` green on memory and sqlite suites.

Spec: no BEH-EA id covers @awthaq/jwt yet (M7); update .scratch/jwt/spec.md and spec/models/08-jwt-bearer.md instead · Effort: **L** · Depends on: KRS-001

**Recommended status:** `ready-for-agent`

#### KRS-009 — Rotation mutation (markRotated + mint) is not atomic and has no single-current-key guard

`low` · `correctness` · `jwt` · [.issues/low/KRS-009-key-rotation-specialist.md](../../.issues/low/KRS-009-key-rotation-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **JJS-004** (confidence: high)

**Evidence at HEAD:**

- `packages/jwt/src/KeyRing.ts:227` — Same non-atomic, unguarded mark+mint as JJS-004; JJS-004's plan adds the transaction (KRS-009's atomicity point) and the unique partial index (its single-current guard).

  ```ts
    const existing = yield* records.findCurrent();
    if (Option.isSome(existing)) {
      yield* markRotated(existing.value, now, config.keyGracePeriod);
    }
    yield* mint(config.algorithm);
  ```

**No separate fix** — resolved by JJS-004's plan.

**Recommended status:** `resolved`

### Workstream `jose-algorithm-coverage`

#### FAMS-005 — JWT plugin cannot interop with Firebase tokens in either direction

`medium` · `api` · `jwt` · [.issues/medium/FAMS-005-firebase-auth-migration-specialist.md](../../.issues/medium/FAMS-005-firebase-auth-migration-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `packages/jwt/src/JwtConfig.ts:23` — Firebase tokens are RS256 — unverifiable by either the plugin or the lite verifier.

  ```ts
  export type Algorithm = "EdDSA" | "ES256";
  ```

- `packages/jwt/src/JwtApi.ts:62` — Mint is authenticated self-decoration (group `.middleware(Api.Authentication)` line 76); no inbound token-exchange.

  ```ts
  export const JwtTokenGroup = HttpApiGroup.make("jwt.token")
    .add(
      HttpApiEndpoint.get("mint", "/jwt/token", {
        success: TokenResponse,
      }),
    )
  ```

**Fix plan:** With BAM-010's RS256 support, document and test a Firebase dual-run recipe using `makeVerifier`; state that `/jwt/token` is not an RFC 8693 exchange. Whether to ship an inbound exchange endpoint is open (see decision).

Steps:
1. After BAM-010: verify.ts already takes an arbitrary `jwksUrl`/`issuer`/`audience`; with `algorithms: ["RS256"]` it can verify Firebase ID tokens (Firebase's published securetoken JWKS; `iss` = `https://securetoken.google.com/<projectId>`, `aud` = `<projectId>`).
2. README migration section: dual-run recipe — an app handler verifies the Firebase ID token with `makeVerifier`, resolves/creates the user, then calls `Sessions.issue`; explicitly state `/jwt/token` is a self-decoration mint, not a token-exchange bootstrap.
3. If the decision picks option B: add `POST /jwt/exchange` accepting a foreign JWT from a configured `trustedIssuers` list (per-issuer jwksUrl/audience/algorithms), mapping claims to a user via an app-supplied `resolveUser` and issuing a session.

Files: `packages/jwt/src/verify.ts`, `packages/jwt/README.md`, `packages/jwt/test/verify.test.ts`

Tests:
- verify.test.ts (first, after BAM-010): 'an RS256 token with Firebase-shaped iss/aud verifies via makeVerifier against a fake JWKS'.

Acceptance:
- Firebase-issued ID tokens can be verified during a dual-run with shipped code; README documents the recipe and the mint endpoint's scope.

Spec: no BEH-EA id covers @awthaq/jwt yet (M7); update .scratch/jwt/spec.md and spec/models/08-jwt-bearer.md instead · Effort: **M** · Depends on: BAM-010

Needs decision — see *Decisions needed*. Recommendation: A now — it unblocks dual-running with no new trust surface; revisit B only if a concrete migrator needs signInWithCustomToken parity (avoid speculative infra).

**Recommended status:** `ready-for-human`

#### AOMS-005 — Upstream id_token verification is RS256-only

`medium` · `api` · `oauth` · [.issues/medium/AOMS-005-auth0-okta-migration-specialist.md](../../.issues/medium/AOMS-005-auth0-okta-migration-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:313`

  ```ts
      if (decoded.header.alg !== "RS256") {
        return yield* Effect.fail(new OAuthApi.OAuthCallbackFailed());
      }
  ```

- `packages/oauth/src/Jwt.ts:152` — Key selection is RSA-only too; header (lines 3-14) documents ES256/EdDSA as not implemented.

  ```ts
    const candidates = jwks.keys.filter((key) => key.kty === "RSA" || key.kty === undefined);
  ```

- `packages/oauth/src/Jwt.ts:90` — Residual type assertion in the same file (left by TTE-002's fix) — remove while here, per the no-assertions rule.

  ```ts
          const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];
  ```

**Fix plan:** Generalize OAuth id_token verification to RS256/PS256/ES256/ES384/EdDSA under a per-provider allowlist seeded from discovery, checked at boot.

Steps:
1. packages/oauth/src/Jwt.ts: replace `verifyRs256` with `verifySignature(alg, jwk, signingInput, signature)` over an alg table; `findKey(jwks, kid, alg)` filters candidates by the kty the alg requires (RSA / EC+crv / OKP) instead of `kty === "RSA"`; rewrite the header comment (lines 3-14).
2. Remove `parts as [string, string, string]` (line 90): destructure then guard each segment `=== undefined`, exactly like packages/jwt/src/JwtCodec.ts:164-175.
3. packages/oauth/src/OAuthProvider.ts: `OAuthProviderConfig.idTokenSigningAlgs?: ReadonlyArray<IdTokenAlg>`; `resolve()` computes the effective allowlist = explicit list ?? (discovery `id_token_signing_alg_values_supported` ∩ supported) ?? `["RS256"]` and dies at boot when it is empty (needs ESS-002's schema field). Store on `ResolvedProvider`.
4. packages/oauth/src/OAuth.ts:313: replace the RS256 literal check with `provider.idTokenSigningAlgs.includes(decoded.header.alg)`.
5. Optional (only if a provider explicitly lists it and a clientSecret exists): HS256 via HMAC with the client secret (OIDC Core §10.1) for legacy Auth0 connections — keep behind the explicit allowlist.

Files: `packages/oauth/src/Jwt.ts`, `packages/oauth/src/OAuthProvider.ts`, `packages/oauth/src/OAuth.ts`, `packages/oauth/test/OAuth.test.ts`

Tests:
- packages/oauth/test/OAuth.test.ts (first): 'an ES256-signed id_token verifies for a provider advertising ES256'.
- 'an RS256 id_token is rejected for a provider whose allowlist is [ES256]'; 'resolve dies at boot when discovery advertises only unsupported algs'.

Acceptance:
- ES256/EdDSA/PS256 providers federate; allowlist enforced per provider; no `as` left in packages/oauth/src/Jwt.ts.

Spec: BEH-EA-127 · Effort: **M** · Depends on: ESS-002-effect-schema-specialist

**Recommended status:** `ready-for-agent`

#### BAM-010 — JWT algorithm vocabulary is EdDSA/ES256 only

`low` · `api` · `jwt` · [.issues/low/BAM-010-better-auth-migration-specialist.md](../../.issues/low/BAM-010-better-auth-migration-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `packages/jwt/src/JwtCodec.ts:36`

  ```ts
  export type Algorithm = "EdDSA" | "ES256";
  ```

- `packages/jwt/src/JwtCodec.ts:55` — Two-way ternaries hard-code the vocabulary; .scratch/jwt/spec.md only rules out symmetric (HS*) algorithms, not RSA/other asymmetric ones.

  ```ts
  const importParams = (algorithm: Algorithm) =>
    algorithm === "EdDSA"
      ? ({ name: "Ed25519" } as const)
      : ({ name: "ECDSA", namedCurve: "P-256" } as const);
  ```

**Fix plan:** Widen the jwt plugin to the common asymmetric JOSE set (EdDSA, ES256, ES384, RS256, PS256) via one algorithm table; still no HS*.

Steps:
1. JwtCodec.ts: `Algorithm = "EdDSA" | "ES256" | "ES384" | "RS256" | "PS256"`; replace `importParams`/`signParams` ternaries with one `AlgorithmSpec` record (import, sign, generateKey params per alg; PS256 saltLength 32).
2. KeyRing.ts `generateKeyPair`: use the table (RSA modulusLength 2048 default, `JwtConfig.rsaModulusLength?` for 3072/4096).
3. SigningKeyRecords.ts: widen `Schema.Literals([...])` at lines 141 and 169 (derive from one exported `Algorithms` tuple).
4. verify.ts `toVerificationKeys`: accept any `Algorithm` via a type guard over the tuple (no cast).
5. Add `KeyRing.importKey({ kid, alg, publicKeyJwk, privateKeyJwk })` so migrators can import better-auth signing keys and keep outstanding tokens verifiable; document in README (migration section).

Files: `packages/jwt/src/JwtCodec.ts`, `packages/jwt/src/KeyRing.ts`, `packages/jwt/src/SigningKeyRecords.ts`, `packages/jwt/src/verify.ts`, `packages/jwt/src/JwtConfig.ts`, `packages/jwt/README.md`, `packages/jwt/test/JwtCodec.test.ts (new)`

Tests:
- JwtCodec.test.ts (first): parameterized 'sign/verify round-trip' for each algorithm.
- 'an RS256 header against an ES256-only key fails' (cross-alg confusion).
- KeyRing.test.ts: 'imports a foreign RS256 key and verifies a token signed by it'.

Acceptance:
- All five algorithms sign/verify via WebCrypto; HS* remains unrepresentable; imported keys verify.

Spec: no BEH-EA id covers @awthaq/jwt yet (M7); update .scratch/jwt/spec.md and spec/models/08-jwt-bearer.md instead · Effort: **M** · Depends on: JJS-003

**Recommended status:** `ready-for-agent`

### Workstream `jwt-response-mirroring-opt-in`

#### PDR-003 — JWT plugin mirrors a bearer token onto every authenticated response via x-jwt-token with no opt-out

`medium` · `security` · `jwt` · [.issues/medium/PDR-003-philippe-de-ryck.md](../../.issues/medium/PDR-003-philippe-de-ryck.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)
  · canonical for: MAPS-005, VB-009

**Evidence at HEAD:**

- `packages/jwt/src/Jwt.ts:215` — Unconditional: every authenticated response (cookie or bearer, any plugin) gets a fresh bearer JWT; failures swallowed silently.

  ```ts
      const decorate: Authentication.PostAuthResponseHookShape["decorate"] = (principal, response) =>
        jwt.sign(principal).pipe(
          Effect.map((token) => HttpServerResponse.setHeader(response, "x-jwt-token", token)),
          Effect.catch(() => Effect.succeed(response)),
        );
  ```

- `packages/jwt/src/JwtConfig.ts:25` — No config knob to disable/scope mirroring.

  ```ts
  export interface JwtConfigShape {
    readonly issuer: string;
    readonly audience: string;
  ```

- `packages/server/src/Authentication.ts:288` — `decorate` receives no scheme, so a bearer-only mode is not even expressible today.

  ```ts
                        Effect.flatMap(PostAuthResponseHook, (hook) =>
                          hook.decorate(principal, withRotation),
  ```

**Fix plan:** Make response mirroring a `JwtConfig` choice (`"off" | "bearer" | "always"`), pass the auth scheme to `PostAuthResponseHook.decorate`, and log rather than silently swallow sign failures.

Steps:
1. packages/jwt/src/JwtConfig.ts: add `mirrorResponses: "off" | "bearer" | "always"` to `JwtConfigShape`/`config()`; default per the decision below (recommended `"off"`).
2. packages/server/src/Authentication.ts: extend `PostAuthResponseHookShape.decorate` to `(principal, response, context: { readonly scheme: "cookie" | "bearer" })`; pass the scheme at both call sites (~lines 288 and 345); keep the default no-op.
3. packages/jwt/src/Jwt.ts `PostAuthResponseHookLive`: read `JwtConfig`; `"off"` returns the response unchanged, `"bearer"` decorates only when `context.scheme === "bearer"`, `"always"` keeps today's behavior. Replace `Effect.catch(() => Effect.succeed(response))` with `Effect.catch((error) => Effect.logWarning("awthaq/jwt: response mirroring failed", error).pipe(Effect.as(response)))`.
4. Rewrite the Jwt.ts block comment (lines 192-210) and packages/jwt/README.md: response headers are log/proxy/APM capture surface; cross-origin JS needs `Access-Control-Expose-Headers`; the explicit mint endpoint is the recommended delivery. Update .scratch/jwt/spec.md 'Automatic response mirroring' to record the opt-in decision.
5. When VB-005 lands, mirrored tokens carry the principal-token `typ` like any `sign(principal)` output (no extra work).

Files: `packages/jwt/src/JwtConfig.ts`, `packages/jwt/src/Jwt.ts`, `packages/server/src/Authentication.ts`, `packages/jwt/test/AuthHttp.test.ts`, `packages/jwt/README.md`

Tests:
- packages/jwt/test/AuthHttp.test.ts (first): 'default config: GET /session carries no x-jwt-token header'.
- Same file: update the existing cross-plugin mirroring test (line 298) to opt into `mirrorResponses: "always"`.
- Same file: 'mirrorResponses: "bearer" — a cookie-authenticated request gets no header, a bearer-authenticated one does'.
- packages/server/test: 'PostAuthResponseHook.decorate receives the authenticating scheme'.

Acceptance:
- With the default config no authenticated response carries x-jwt-token.
- Each of the three modes behaves as specified; sign failures are logged.
- `pnpm run test`, `pnpm run typecheck` pass.

Spec: no BEH-EA id covers @awthaq/jwt yet (M7); update .scratch/jwt/spec.md and spec/models/08-jwt-bearer.md instead, BEH-EA-065/066 (hook runs after scheme resolution; wording unchanged) · Effort: **M** · Depends on: none

Needs decision — see *Decisions needed*. Recommendation: B — the knob gives every deployment the richer choice (flexibility), and default-off removes the silent cookie→portable-bearer conversion four independent auditors flagged; apps wanting better-auth parity opt into "always" with one line.

**Recommended status:** `ready-for-human`

#### MAPS-005 — x-jwt-token mirrored onto every authenticated response hands out a portable credential silently

`medium` · `security` · `jwt` · [.issues/medium/MAPS-005-microservices-auth-propagation-specialist.md](../../.issues/medium/MAPS-005-microservices-auth-propagation-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **PDR-003** (confidence: high)

**Evidence at HEAD:**

- `packages/jwt/src/Jwt.ts:217` — Same unconditional mirroring construct and same opt-in recommendation as PDR-003.

  ```ts
          Effect.map((token) => HttpServerResponse.setHeader(response, "x-jwt-token", token)),
  ```

**No separate fix** — resolved by PDR-003's plan.

**Recommended status:** `resolved`

#### VB-009 — A fresh bearer JWT is mirrored onto every authenticated response

`low` · `security` · `jwt` · [.issues/low/VB-009-vittorio-bertocci.md](../../.issues/low/VB-009-vittorio-bertocci.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **PDR-003** (confidence: high)

**Evidence at HEAD:**

- `packages/jwt/src/Jwt.ts:217` — Same unconditional mirroring construct and same opt-in recommendation as PDR-003.

  ```ts
          Effect.map((token) => HttpServerResponse.setHeader(response, "x-jwt-token", token)),
  ```

**No separate fix** — resolved by PDR-003's plan.

**Recommended status:** `resolved`

### Workstream `jwt-revocation-propagation`

#### TIR-007 — Every authenticated response mints a JWT that survives session revocation

`medium` · `security` · `jwt` · [.issues/medium/TIR-007-token-introspection-revocation-specialist.md](../../.issues/medium/TIR-007-token-introspection-revocation-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence: high)
  · canonical for: SCP-007

**Evidence at HEAD:**

- `packages/jwt/src/Jwt.ts:361` — FIXED part: tokens now carry a jti and a RevocationStore/introspect path exists (commit 2ebd195); verifyLive/introspectLive use the keyed, idle-aware Sessions.isLive (6629fd2).

  ```ts
              // TRBS-001/TIR-001: every minted token gets a UUIDv7 `jti`,
  ```

- `packages/jwt/src/Jwt.ts:181` — HOLDS: the HTTP /jwt/introspect path never consults session liveness, so a revoked session's mirrored JWT still introspects active:true — contrary to wayfinder ticket 11 item 4 ('wired to introspectLive when the composing app has Sessions installed').

  ```ts
          introspect: Effect.fnUntraced(function* ({ payload }) {
            const result = yield* jwt.introspect(payload.token);
  ```

- `packages/jwt/src/Jwt.ts:215` — HOLDS: every authenticated response still mints a token that plain `verify` honours until `exp` (mirroring half is tracked under PDR-003).

  ```ts
      const decorate: Authentication.PostAuthResponseHookShape["decorate"] = (principal, response) =>
        jwt.sign(principal).pipe(
  ```

**Fix plan:** Finish ticket 11's intent: let `/jwt/introspect` apply the session-liveness check whenever `Sessions` is composed (captured via `Effect.serviceOption`, keeping R = never), and document the bare-`verify` revocation-lag bound.

Steps:
1. packages/jwt/src/Jwt.ts `make`: `const sessions = yield* Effect.serviceOption(Sessions.Sessions)` (Effect v4 `serviceOption: (key) => Effect<Option<S>>` adds no requirement — ../effect/packages/effect/src/Effect.ts:6103).
2. Add an internal `introspectForHandler(token)`: `introspect(token)`, then when `Option.isSome(sessions)` and the claims carry `sid`/`sub`, apply `sessions.value.isLive` exactly as `introspectLive` does; wire the `/jwt/introspect` handler to it. Keep public `verifyLive`/`introspectLive` signatures (per-call `Sessions` R) for explicit callers; refactor `sidStillLive` to accept the Sessions shape so both share one implementation.
3. Document in the Jwt.ts header and README: session revocation cascades immediately to verifyLive/introspectLive/`/jwt/introspect`; bare `verify` (and ticket-33 bearer re-entry) lags by at most `JwtConfig.ttl` (default 15m) — the documented, bounded tradeoff.
4. Note for SCIM (SCP-007): the future deactivation contract should call `Sessions.revokeAll` and require `verifyLive`/`introspect*` on security-sensitive JWT consumers; record this in spec/models/12-scim.md's open question when SCIM is specified (wayfinder ticket 08).

Files: `packages/jwt/src/Jwt.ts`, `packages/jwt/README.md`, `packages/jwt/test/AuthHttp.test.ts`, `packages/jwt/test/Jwt.test.ts`

Tests:
- packages/jwt/test/AuthHttp.test.ts (first): 'POST /jwt/introspect reports active:false once the minting session is revoked (Sessions composed)'.
- Same file: 'POST /jwt/introspect still works (denylist only) in a composition without Sessions'.

Acceptance:
- Revoking a session makes every JWT minted from it introspect `active:false` over HTTP immediately when Sessions is composed.
- `Jwt.dependsOn` stays `[]`; handler R stays dischargeable.
- README states the bare-verify lag bound.

Spec: no BEH-EA id covers @awthaq/jwt yet (M7); update .scratch/jwt/spec.md and spec/models/08-jwt-bearer.md instead · Effort: **M** · Depends on: none

**Recommended status:** `ready-for-agent`

#### SCP-007 — Deprovisioning propagation depends on opt-in verifyLive: plain verify keeps accepting revoked-session JWTs until exp

`medium` · `security` · `jwt` · [.issues/medium/SCP-007-scim-provisioning-specialist.md](../../.issues/medium/SCP-007-scim-provisioning-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **TIR-007** (confidence: medium)

**Evidence at HEAD:**

- `packages/jwt/src/Jwt.ts:443` — Same root cause as TIR-007 (bare `verify` lags revocation; the live path is opt-in). The primitives SCP-007 praises are now also idle-correct. The SCIM-contract half has no code to change until SCIM is specified (wayfinder 08) — captured as a doc step in TIR-007's plan.

  ```ts
          const sidStillLive = (sub: string, sid: string) =>
            Effect.gen(function* () {
              const sessions = yield* Sessions.Sessions;
              return yield* sessions.isLive(Users.UserId(sub), Sessions.SessionId(sid));
            });
  ```

**No separate fix** — resolved by TIR-007's plan.

**Recommended status:** `resolved`

### Workstream `jwt-stateless-bearer-reentry`

#### NAM-001 — No stateless JWT session strategy: Jwt plugin still requires the live Sessions store

`high` · `architecture` · `jwt` · [.issues/high/NAM-001-nextauth-authjs-migration-specialist.md](../../.issues/high/NAM-001-nextauth-authjs-migration-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high)
  · canonical for: IC-008

**Evidence at HEAD:**

- `packages/jwt/src/JwtConfig.ts:25` — No `acceptAsBearer` flag (grep for `acceptAsBearer`/`BearerCredentialResolver` across packages/*/src is empty) — the ticket-33 decision is not implemented.

  ```ts
  export interface JwtConfigShape {
    readonly issuer: string;
    readonly audience: string;
    readonly algorithm: Algorithm;
    readonly ttl: Duration.Duration;
  ```

- `packages/jwt/src/Jwt.ts:81` — Only delegation semantics exist; a JWT can never authenticate a request.

  ```ts
    /** Ticket 12: `verify` plus a live check that the token's `sid` still names an unrevoked, unexpired session. The documented, deliberate weakening `verify` alone carries (a revoked session's JWT keeps verifying until its own `exp`) does not apply here. */
    readonly verifyLive: (
      token: string,
    ) => Effect.Effect<Record<string, unknown>, JwtCodec.JwtInvalidError, Sessions.Sessions>;
  ```

- `packages/jwt/README.md:3` — The README recipe the decision requires does not exist; README is a stale stub.

  ```ts
  > **This describes a planned package.** awthaq is pre-implementation (see [`../../spec/README.md`](../../spec/README.md)); no line of source in this package has shipped yet.
  ```

**Fix plan:** Implement .scratch/resolve-ready-for-human-findings/issues/33-stateless-jwt-session-strategy.md verbatim: a `BearerCredentialResolver` slot on `Authentication`, a default-off `JwtConfig.acceptAsBearer`, `signJWT({ audience })`, and a README stateless recipe.

Steps:
1. packages/server/src/Authentication.ts: add `BearerCredentialResolverShape { resolve: (credential: Redacted<string>) => Effect<Api.Principal, Api.Unauthenticated> }` and `BearerCredentialResolver = Context.Reference("awthaq/server/BearerCredentialResolver", { defaultValue: () => ({ resolve: () => Effect.fail(new Api.Unauthenticated()) }) })`, sibling to `PostAuthResponseHook` (lines 78-88).
2. Same file, both `AuthenticationLive` and `OptionalAuthenticationLive` `bearer` closures: if `Redacted.value(credential).split(".").length === 3` route to `BearerCredentialResolver.resolve`, skip `deliverRotation`, still run `PostAuthResponseHook.decorate`; otherwise the existing `resolveSession` path (opaque `id.secret`). `cookie` untouched.
3. packages/jwt/src/JwtConfig.ts: add `acceptAsBearer: boolean` (default `false`) to `JwtConfigShape` and `config()`.
4. packages/jwt/src/Jwt.ts: add `claimsToPrincipal` — the Schema-decoded inverse of `principalClaims` (sub → `PrincipalRef({ type: "user", id })`, sid → `sessionId`, act → `actingAs`; decode failure → `Unauthenticated`; no casts) — and `BearerCredentialResolverLive = Layer.effect(Authentication.BearerCredentialResolver, ...)` calling bare `jwt.verify` (not verifyLive), failing closed unless `config.acceptAsBearer`. Merge it into `Jwt.layer` with the existing `Layer.provideMerge` chain.
5. `signJWT` options gain `audience?: string` (implemented in VB-005's step; a propagation token minted with a downstream audience is rejected at the origin by the existing aud check).
6. Replace packages/jwt/README.md with real docs: acceptAsBearer + its revocation-lag bound (= `JwtConfig.ttl`), the stateless recipe `Sessions.layerMemory` + `acceptAsBearer: true` (no SQL, no migrations), and `signJWT(payload, { audience })` for downstream-only tokens.
7. Spec: amend BEH-EA-066 (bearer handler now routes 3-segment credentials to `BearerCredentialResolver`; opaque tokens unchanged) and note the spec/models/08-jwt-bearer.md drift the decision flags.

Files: `packages/server/src/Authentication.ts`, `packages/jwt/src/JwtConfig.ts`, `packages/jwt/src/Jwt.ts`, `packages/jwt/README.md`, `spec/behaviors/09-authentication-middleware.md`, `packages/jwt/test/AuthHttp.test.ts`, `packages/server/test/AuthHttp.test.ts`

Tests:
- packages/jwt/test/AuthHttp.test.ts (first): 'with acceptAsBearer: true, a minted JWT sent as Authorization: Bearer authenticates GET /session'.
- Same file: 'with the default acceptAsBearer: false the same JWT is 401'; 'a signJWT token minted with audience "inventory" is 401 at the origin'.
- Same file: 'stateless recipe: Auth.make([Jwt]) over Sessions.layerMemory with no SqlClient serves a JWT-bearer request'.
- packages/server/test/AuthHttp.test.ts: 'an opaque id.secret bearer still resolves via Sessions (BEH-EA-066 regression)'.

Acceptance:
- A JWT presented as a bearer credential authenticates iff `acceptAsBearer` is on and `jwt.verify` passes; opaque session bearers behave exactly as before.
- `AuthenticationLive`'s R is unchanged (the resolver is a Context.Reference).
- README documents the stateless profile and revocation-lag bound.
- `pnpm run test`, `pnpm run test:bdd`, `pnpm run spec:verify:strict` pass.

Spec: BEH-EA-066, BEH-EA-069 · Effort: **L** · Depends on: VB-005

**Recommended status:** `ready-for-agent`

#### IC-008 — Single session strategy: no JWT-session option for edge/serverless render paths

`info` · `architecture` · `jwt` · [.issues/info/IC-008-iain-collins.md](../../.issues/info/IC-008-iain-collins.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **NAM-001** (confidence: high)

**Evidence at HEAD:**

- `packages/jwt/src/index.ts:3` — Same gap (no JWT-session/stateless option for edge) that wayfinder ticket 33 resolved for NAM-001/MAPS-001; the decision's `Sessions.layerMemory` + `acceptAsBearer` recipe is the edge answer IC-008 asks to document.

  ```ts
  // Short-lived, self-contained, cryptographically signed JWTs representing
  // an already-authenticated caller — EdDSA/ES256, JWKS with grace-period
  ```

**No separate fix** — resolved by NAM-001's plan.

**Recommended status:** `resolved`

### Workstream `plugin-api-surface-conventions`

#### AVS-005 — jwt package states a middleware convention that password's own contract violates

`medium` · `api` · `jwt` · [.issues/medium/AVS-005-api-design-versioning-specialist.md](../../.issues/medium/AVS-005-api-design-versioning-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `packages/jwt/src/JwtApi.ts:12`

  ```ts
  // Two groups, not one — `jwks` is public (JWKS is public by definition),
  // `token` requires an authenticated caller. This codebase's own established
  // pattern for a plugin mixing public and authenticated endpoints is a
  // second, dotted-sub-id group carrying its own `.middleware(Api.Authentication)`
  // (see `PasskeyApi.ts`'s `passkey`/`passkey.authenticate` split), never a
  // per-endpoint middleware inside one shared group.
  ```

- `packages/password/src/PasswordApi.ts:230` — …and at line 239 `}).middleware(Api.Authentication),` (also `reauthenticate` at 252) — per-endpoint middleware inside the public `password` group.

  ```ts
      HttpApiEndpoint.post("changePassword", "/change-password", {
        payload: ChangePasswordPayload,
  ```

**Fix plan:** Make password follow the stated convention: move its two authenticated endpoints into a dotted `password.account` sub-group with group-level Authentication; keep paths.

Steps:
1. packages/password/src/PasswordApi.ts: create `PasswordAccountGroup = HttpApiGroup.make("password.account")` holding `changePassword` and `reauthenticate` (paths unchanged), `.middleware(Api.Authentication)` plus the same group-level CSRF middleware the `password` group carries; add it to `PasswordApi`.
2. packages/password/src/Password.ts: split handlers into `HttpApiBuilder.group(PasswordApi, "password.account", …)` and merge into `PasswordHandlers`.
3. Update the JwtApi.ts header (lines 12-17) to cite passkey and password as examples; mention the convention in the plugin-authoring docs if present.

Files: `packages/password/src/PasswordApi.ts`, `packages/password/src/Password.ts`, `packages/jwt/src/JwtApi.ts`, `packages/client (regenerate if it enumerates groups)`

Tests:
- packages/password AuthHttp tests stay green unchanged (same paths/status codes); add 'POST /change-password without a session is 401 via the password.account group middleware'.

Acceptance:
- No shipped plugin contract uses per-endpoint `.middleware(Api.Authentication)` inside a mixed public group; `pnpm run test` + `pnpm run test:bdd` green.

Spec: BEH-EA-053 (behavior unchanged; contract shape only) · Effort: **S** · Depends on: none

**Recommended status:** `ready-for-agent`

#### AVS-007 — Token minting declared as GET with an action-verb id, breaking the POST-for-actions convention

`low` · `api` · `jwt` · [.issues/low/AVS-007-api-design-versioning-specialist.md](../../.issues/low/AVS-007-api-design-versioning-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `packages/jwt/src/JwtApi.ts:64` — Credential-issuing action exposed as GET; every other action endpoint is POST.

  ```ts
      HttpApiEndpoint.get("mint", "/jwt/token", {
        success: TokenResponse,
      }),
  ```

**Fix plan:** Make token minting `POST /jwt/token`.

Steps:
1. JwtApi.ts:64 → `HttpApiEndpoint.post("mint", "/jwt/token", { success: TokenResponse })`; update the header comment.
2. Once wayfinder-24's CSRF attachment lands, the unsafe method is covered by CsrfProtection (bearer requests exempt per that decision).

Files: `packages/jwt/src/JwtApi.ts`, `packages/jwt/test/AuthHttp.test.ts`

Tests:
- AuthHttp.test.ts (first): convert the three `GET /jwt/token` tests (lines 182-196, 221) to POST and add 'GET /jwt/token is 404/405'.

Acceptance:
- Minting is POST-only; tests green.

Spec: no BEH-EA id covers @awthaq/jwt yet (M7); update .scratch/jwt/spec.md and spec/models/08-jwt-bearer.md instead · Effort: **S** · Depends on: none

**Recommended status:** `ready-for-agent`

### Workstream `oauth-provider-presets`

#### IC-003 — Zero OAuth provider presets — every app hand-assembles issuer/endpoints/mapProfile

`medium` · `dx` · `oauth` · [.issues/medium/IC-003-iain-collins.md](../../.issues/medium/IC-003-iain-collins.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)
  · canonical for: NAM-003, MW-010

**Evidence at HEAD:**

- `packages/oauth/src/OAuthProvider.ts:5` — Deliberate at implementation time, but no ADR/wayfinder decision covers it — a genuine product call.

  ```ts
  // runnable. Two factories only — `oidc`/`oauth2` — not per-vendor presets
  // (`google()`/`github()`/`apple()`): nothing in BEH-EA-121 through 128
  // requires a shipped Google/GitHub/Apple integration, only the mechanism
  ```

**Fix plan:** Ship data-only vendor presets built on `oidc`/`oauth2` (zero new mechanism) in an `@awthaq/oauth/presets` subpath, plus an Auth.js provider-id → preset mapping table.

Steps:
1. New packages/oauth/src/presets/*.ts (index re-export) and a `./presets` entry in packages/oauth/package.json `exports`: `google`, `github`, `apple`, `microsoft` (Entra; `tenant` param), `gitlab`, `discord` to start (Auth.js top usage). Each: `(input: { clientId, clientSecret, scopes?, mapProfile? }) => OAuthProviderConfig` pre-filling id/issuer/discoveryUrl or endpoints/scopes/mapProfile/quirks.
2. Discovery-based presets rely on BEH-EA-127's exact-issuer match, so a stale preset fails loudly at boot.
3. mapProfile per vendor maps picture/avatar_url into `image` once NAM-009 lands.
4. Rewrite OAuthProvider.ts header (lines 4-11). Add a migration table (Auth.js provider id → preset, and quirks) to packages/oauth/README.md.

Files: `packages/oauth/src/presets/ (new)`, `packages/oauth/package.json`, `packages/oauth/src/OAuthProvider.ts`, `packages/oauth/README.md`, `packages/oauth/test/OAuthPresets.test.ts (new)`

Tests:
- packages/oauth/test/OAuthPresets.test.ts (first): each preset resolves against a fake discovery/endpoints and its mapProfile maps a recorded vendor claim sample (e.g. GitHub numeric `id` → string subject).

Acceptance:
- `OAuthPresets.github({ clientId, clientSecret })` is a complete provider; all BEH-EA-121..128 guarantees still apply; factories remain the escape hatch.

Spec: BEH-EA-121, BEH-EA-126, BEH-EA-127 · Effort: **L** · Depends on: ESS-002-effect-schema-specialist, OAP-005

Needs decision — see *Decisions needed*. Recommendation: B — highest product value for the smallest surface; exact-issuer discovery makes stale presets fail loudly, and a subpath keeps the core import graph unchanged. C only if vendor churn later demands a separate release cadence.

**Recommended status:** `ready-for-human`

#### BO-009 — OAuth provider config: no vendor presets and Effect Config descriptions leak into user-facing typing

`low` · `dx` · `oauth` · [.issues/low/BO-009-balazs-orban.md](../../.issues/low/BO-009-balazs-orban.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence: high)

**Evidence at HEAD:**

- `packages/oauth/src/OAuthProvider.ts:55` — HOLDS: non-secret fields force the Config DSL; presets half duplicates IC-003.

  ```ts
    readonly issuer?: Config.Config<string>;
    /** BEH-EA-127: when given, `discoveryUrl`'s fetched `issuer` MUST exact-match `issuer` above. */
    readonly discoveryUrl?: Config.Config<string>;
    /** Required when `discoveryUrl` is absent. */
    readonly endpoints?: OAuthEndpoints;
    readonly clientId: Config.Config<string>;
  ```

- `spec/behaviors/16-oauth.md:111` — INVALID part: accepting a plain-string clientSecret would violate BEH-EA-126.

  ```ts
  REQUIREMENT: A provider's client secret MUST be read via `Config.Redacted`
               inside the provider's own Layer construction; it MUST NOT appear
               as a plaintext option, a plugin argument, or in application
               source alongside plugin wiring.
  ```

**Fix plan:** Accept `string | Config.Config<string>` for non-secret provider fields (issuer, discoveryUrl, clientId); keep clientSecret Config.Redacted-only per BEH-EA-126; presets tracked by IC-003.

Steps:
1. OAuthProvider.ts: type `issuer`, `discoveryUrl`, `clientId` as `string | Config.Config<string>`; normalize in `resolve()` with a helper `const lift = (v) => typeof v === "string" ? Config.succeed(v) : v` (Effect v4 Config.succeed, Config.ts:966) — type narrowing, no casts.
2. Leave `clientSecret?: Config.Config<Redacted.Redacted<string>>` unchanged (BEH-EA-126).
3. Update the BEH-EA-127 example in docs to show both forms.

Files: `packages/oauth/src/OAuthProvider.ts`, `packages/oauth/test/OAuth.test.ts`

Tests:
- OAuth.test.ts (first): 'oidc({ issuer: "https://…", clientId: "abc", … }) with plain strings resolves'; a type-level test that a plain-string clientSecret is rejected (`// @ts-expect-error`).

Acceptance:
- Non-secret fields accept plain strings; secrets still require Config.Redacted.

Spec: BEH-EA-126, BEH-EA-127 · Effort: **S** · Depends on: none

**Recommended status:** `ready-for-agent`

#### NAM-003 — Zero vendor provider presets — every Auth.js provider must be hand-translated

`medium` · `dx` · `oauth` · [.issues/medium/NAM-003-nextauth-authjs-migration-specialist.md](../../.issues/medium/NAM-003-nextauth-authjs-migration-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **IC-003** (confidence: high)

**Evidence at HEAD:**

- `packages/oauth/src/OAuthProvider.ts:5` — Same gap; its Auth.js mapping-table ask is folded into IC-003's plan.

  ```ts
  // runnable. Two factories only — `oidc`/`oauth2` — not per-vendor presets
  ```

**No separate fix** — resolved by IC-003's plan.

**Recommended status:** `resolved`

#### MW-010 — OAuth providers are mechanism-only: no shipped preset catalog raises per-customer integration cost

`info` · `dx` · `oauth` · [.issues/info/MW-010-matias-woloski.md](../../.issues/info/MW-010-matias-woloski.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **IC-003** (confidence: high)

**Evidence at HEAD:**

- `packages/oauth/src/OAuthProvider.ts:5` — Same gap (integration-cost framing); its 'separately-versioned module' variant is option C in IC-003's decision.

  ```ts
  // runnable. Two factories only — `oidc`/`oauth2` — not per-vendor presets
  ```

**No separate fix** — resolved by IC-003's plan.

**Recommended status:** `resolved`

### Workstream `session-authentication-methods`

#### AOMS-012 — Sessions and JWTs carry no authentication-method record (no amr/acr equivalent)

`low` · `api` · `jwt` · [.issues/low/AOMS-012-auth0-okta-migration-specialist.md](../../.issues/low/AOMS-012-auth0-okta-migration-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `packages/jwt/src/Jwt.ts:133` — Only sub/sid/act; no amr/acr/auth_time.

  ```ts
  const principalClaims = (principal: Api.Principal): Record<string, unknown> =>
    principal._tag === "User"
      ? {
          sub: principal.ref.id,
          sid: principal.sessionId,
  ```

- `packages/sql/src/Models.ts:153` — Sessions record *when* a credential was proven (ticket 15) but not *how*; no amr-like column exists.

  ```ts
    authenticatedAt: Model.DateTimeUpdate,
  ```

**Fix plan:** Record RFC 8176-style authentication methods on the session, carry them on the UserPrincipal, and emit `amr` + `auth_time` in principal JWTs.

Steps:
1. packages/sql/src/Models.ts `Session`: add `authMethods` (JSON text array, `update` variant for reauthenticate) + a CoreMigrations migration; mirror in `Sessions.layerMemory`'s row.
2. packages/core/src/Sessions.ts `issue` input: `authMethods: ReadonlyArray<string>`; `reauthenticate` appends; expose on `SessionView`.
3. Callers: password signIn → ["pwd"]; OAuth callback → ["fed"] plus `idp` = providerId; passkey → ["hwk", "user"]; MFA (wayfinder 05) appends "otp"/"mfa".
4. packages/api `UserPrincipal` gains `authMethods` and `authenticatedAt`; `PrincipalResolverLive` maps them (BEH-EA-069).
5. packages/jwt/src/Jwt.ts `principalClaims`: emit `amr` and `auth_time` (epoch seconds of authenticatedAt) for User principals.

Files: `packages/sql/src/Models.ts`, `packages/sql/src/CoreMigrations.ts`, `packages/core/src/Sessions.ts`, `packages/api/src/Api.ts`, `packages/server/src/Authentication.ts`, `packages/password/src/Password.ts`, `packages/oauth/src/OAuth.ts`, `packages/passkey/src/Passkey.ts`, `packages/jwt/src/Jwt.ts`

Tests:
- packages/jwt/test/Jwt.test.ts (first): 'a JWT for a password-issued session carries amr ["pwd"] and auth_time'.
- packages/oauth/test/OAuth.test.ts: 'an OAuth sign-in session carries amr ["fed"]'; packages/core/test/Sessions.test.ts: 'reauthenticate appends the method'.

Acceptance:
- Downstream verifiers can distinguish password vs federated vs passkey logins from the token alone.

Spec: BEH-EA-069, BEH-EA-053 · Effort: **L** · Depends on: none

**Recommended status:** `ready-for-agent`

### Workstream `user-profile-image`

#### NAM-009 — User.image / OAuth picture dropped: avatar data has no destination

`low` · `dx` · `oauth` · [.issues/low/NAM-009-nextauth-authjs-migration-specialist.md](../../.issues/low/NAM-009-nextauth-authjs-migration-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD:**

- `packages/oauth/src/OAuthProvider.ts:33` — No image/picture field; grep for image|picture|avatar in Models.ts/Users.ts/oauth src is empty.

  ```ts
  export interface OAuthProfile {
    readonly subject: string;
    readonly email?: string;
    readonly emailVerified?: boolean;
    readonly name?: string;
  }
  ```

**Fix plan:** Add an optional `image` to OAuthProfile and the User model so mapProfile can carry avatars (Auth.js/better-auth parity).

Steps:
1. packages/oauth/src/OAuthProvider.ts `OAuthProfile`: `readonly image?: string`.
2. packages/sql/src/Models.ts `User`: nullable `image` column + migration; packages/core/src/Users.ts `UserRecord.image?`; `create` accepts it. Ship in the same migration wave as wayfinder-09's UserRecord identity revision to avoid two schema churns.
3. packages/oauth/src/OAuth.ts callback: pass `profile.image` on user creation (never overwrite on link).
4. Expose on the session/user DTO the client reads; document in the Auth.js migration table.

Files: `packages/oauth/src/OAuthProvider.ts`, `packages/sql/src/Models.ts`, `packages/sql/src/CoreMigrations.ts`, `packages/core/src/Users.ts`, `packages/oauth/src/OAuth.ts`

Tests:
- packages/oauth/test/OAuth.test.ts (first): 'mapProfile image lands on the newly created user'.

Acceptance:
- Avatars survive OAuth sign-up; field optional everywhere.

Spec: BEH-EA-041 (User record shape; additive) · Effort: **M** · Depends on: FAMS-002

**Recommended status:** `ready-for-agent`

### Workstream `plugin-port-boundary-enforcement`

#### JH-008 — Ports-never-provided sandboxing rule is convention, not an enforced boundary

`low` · `architecture` · `jwt` · [.issues/low/JH-008-jared-hanson.md](../../.issues/low/JH-008-jared-hanson.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: medium)

**Evidence at HEAD:**

- `packages/jwt/src/Jwt.ts:313` — A plugin's static layer can merge any service into its ROut.

  ```ts
    static readonly layer = Layer.provideMerge(
      PostAuthResponseHookLive,
      AuthPlugin.layer(Jwt, {
        handlers: JwtHandlers,
  ```

- `spec/decisions/010-plugins-require-ports-never-provide.md:10` — ADR-EA-010 / BEH-EA-020 are unenforced; Auth.make's `Validate<P>` checks DuplicateId/MissingDep/SlotConflict only.

  ```ts
  | Status | Accepted — design; implementation deferred |
  ```

**Fix plan:** Enforce BEH-EA-020 at the type level: `Auth.make`'s `Validate<P>` rejects any plugin whose layer's ROut contains a port tag.

Steps:
1. packages/ports/src/index.ts: export a type-only `ReservedPort` union of the port service identifiers (PasswordHasher, Mailer, RateLimiter, WebAuthn, KeyProvider, Encryption, SqlTransaction, ClientAddress, LegacySessionBridge) plus `SqlClient.SqlClient` and `Crypto.Crypto` (BEH-EA-020's list).
2. packages/core/src/Auth.ts `Validate<P>`: add a `PortsProvidedByPlugin` check — for each plugin, `Extract<Layer.Success<P[i]["layer"]>, ReservedPort>` must be `never`, else the tuple position resolves to a branded error type naming the plugin id and port, mirroring the existing DuplicateId/MissingDep/SlotConflict encodings (BEH-EA-010..012).
3. Seams (`PostAuthResponseHook`, future `BearerCredentialResolver`) and slots (`SubjectResolver`, already SlotConflict-checked) are Context.References/slots, not ports — unaffected.
4. Flip ADR-EA-010's status to implemented and extend BEH-EA-020 with the compile-time enforcement sentence.

Files: `packages/ports/src/index.ts`, `packages/core/src/Auth.ts`, `packages/core/test/ (type test)`, `spec/decisions/010-plugins-require-ports-never-provide.md`, `spec/behaviors/03-ports-slots-hooks-registries.md`

Tests:
- packages/core/test (type-level, first): '`Auth.make([Evil])` where Evil.layer provides PasswordHasher is a compile error (`// @ts-expect-error`) naming PortsProvidedByPlugin'; Jwt/Roles compositions still typecheck.

Acceptance:
- A plugin smuggling a port implementation cannot be composed; `pnpm run typecheck` + `pnpm run spec:verify:strict` green.

Spec: BEH-EA-020, BEH-EA-010, BEH-EA-012 · Effort: **M** · Depends on: none

**Recommended status:** `ready-for-agent`

### Workstream `m2m-machine-credentials`

#### OCM-007 — No immediate revocation story exists for machine credentials; the only revocation-aware verify is session-scoped

`low` · `security` · `jwt` · [.issues/low/OCM-007-oauth2-client-credentials-m2m-specialist.md](../../.issues/low/OCM-007-oauth2-client-credentials-m2m-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **OCM-002** (confidence: high)

**Evidence at HEAD:**

- `packages/jwt/src/Jwt.ts:472` — The 'only revocation-aware verify is session-scoped' claim is now false: jti-denylist introspection (2ebd195) works for any token, machine ones included.

  ```ts
          const introspect: JwtShape["introspect"] = (token) =>
            Effect.gen(function* () {
              const outcome = yield* Effect.result(verify(token));
              if (Result.isFailure(outcome)) return { active: false };
              const claims = outcome.success;
              const jti = claims["jti"];
  ```

- `packages/api-key/src/index.ts:8` — The API-key half (immediate store-write revoke) is OCM-002's ready-for-agent plan under wayfinder ticket 10, which also explicitly accepts TTL lag for client_credentials JWTs.

  ```ts
  // Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
  ```

**No separate fix** — resolved by OCM-002's plan.

**Recommended status:** `resolved`

#### OCM-006 — JWT mint is exclusively session-bound — no path issues a token to a machine credential

`info` · `api` · `jwt` · [.issues/info/OCM-006-oauth2-client-credentials-m2m-specialist.md](../../.issues/info/OCM-006-oauth2-client-credentials-m2m-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **OCM-001** (confidence: high)

**Evidence at HEAD:**

- `packages/jwt/src/Jwt.ts:167` — Still session/principal-bound; wayfinder ticket 10 (decision on OCM-001) places machine-token issuance in `packages/api-key`'s `POST auth/apiKey/token`, minting via this plugin's signer with `sub: "service:<clientId>"` and `scope` — exactly OCM-006's ask.

  ```ts
          mint: Effect.fnUntraced(function* () {
            const principal = yield* Api.CurrentPrincipal;
            const token = yield* jwt.sign(principal).pipe(Effect.orDie);
  ```

**No separate fix** — resolved by OCM-001's plan.

**Recommended status:** `resolved`

### Already fixed (no workstream)

#### TRBS-002 — No jti is ever minted, so a per-token denylist is not even expressible today

`medium` · `security` · `jwt` · [.issues/medium/TRBS-002-token-revocation-blacklist-specialist.md](../../.issues/medium/TRBS-002-token-revocation-blacklist-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED by `2ebd195` (confidence: high)

**Evidence at HEAD:**

- `packages/jwt/src/Jwt.ts:366` — Every minted token carries a UUIDv7 jti (line 391 puts it in the claims); RevocationStore keys the denylist on it; Jwt.test.ts:259 'every minted token carries a jti claim'.

  ```ts
              const jti = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
  ```

**No fix needed** — see evidence.

**Recommended status:** `resolved`

#### TRBS-004 — verifyLive liveness check scans a 200-row oldest-first page and can reject live tokens

`medium` · `correctness` · `jwt` · [.issues/medium/TRBS-004-token-revocation-blacklist-specialist.md](../../.issues/medium/TRBS-004-token-revocation-blacklist-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED by `6629fd2` (confidence: high)

**Evidence at HEAD:**

- `packages/jwt/src/Jwt.ts:443` — verifyLive no longer lists-and-scans; keyed lookup.

  ```ts
          const sidStillLive = (sub: string, sid: string) =>
            Effect.gen(function* () {
              const sessions = yield* Sessions.Sessions;
              return yield* sessions.isLive(Users.UserId(sub), Sessions.SessionId(sid));
            });
  ```

- `packages/core/src/Sessions.ts:888` — SQL isLive: findById, then userId/supersededAt/absolute/idle checks (lines 895-905); memory twin at Sessions.ts:586-599.

  ```ts
      const isLive: SessionsShape["isLive"] = (userId, id) =>
        Effect.gen(function* () {
          const row = yield* repo.findById(id).pipe(
  ```

- `packages/jwt/test/Jwt.test.ts:193` — The 200-row oldest-first page cliff is gone — no `sessions.list` call remains in Jwt.ts.

  ```ts
    it.effect(
      "verifyLive fails for an idle-expired session even though absolute expiry is far off",
  ```

**No fix needed** — see evidence.

**Recommended status:** `resolved`

#### VB-002 — verifyLive scans only the first page of sessions (200 rows)

`medium` · `correctness` · `jwt` · [.issues/medium/VB-002-vittorio-bertocci.md](../../.issues/medium/VB-002-vittorio-bertocci.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED by `6629fd2` (confidence: high)

**Evidence at HEAD:**

- `packages/jwt/src/Jwt.ts:443` — verifyLive no longer lists-and-scans; keyed lookup.

  ```ts
          const sidStillLive = (sub: string, sid: string) =>
            Effect.gen(function* () {
              const sessions = yield* Sessions.Sessions;
              return yield* sessions.isLive(Users.UserId(sub), Sessions.SessionId(sid));
            });
  ```

- `packages/core/src/Sessions.ts:888` — SQL isLive: findById, then userId/supersededAt/absolute/idle checks (lines 895-905); memory twin at Sessions.ts:586-599.

  ```ts
      const isLive: SessionsShape["isLive"] = (userId, id) =>
        Effect.gen(function* () {
          const row = yield* repo.findById(id).pipe(
  ```

- `packages/jwt/test/Jwt.test.ts:193` — Same: O(1) id lookup replaces the first-page scan.

  ```ts
    it.effect(
      "verifyLive fails for an idle-expired session even though absolute expiry is far off",
  ```

**No fix needed** — see evidence.

**Recommended status:** `resolved`

#### TRBS-007 — verifyLive checks absolute expiry only and accepts idle-expired sessions

`medium` · `security` · `jwt` · [.issues/medium/TRBS-007-token-revocation-blacklist-specialist.md](../../.issues/medium/TRBS-007-token-revocation-blacklist-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED by `6629fd2` (confidence: high)

**Evidence at HEAD:**

- `packages/jwt/src/Jwt.ts:443` — verifyLive no longer lists-and-scans; keyed lookup.

  ```ts
          const sidStillLive = (sub: string, sid: string) =>
            Effect.gen(function* () {
              const sessions = yield* Sessions.Sessions;
              return yield* sessions.isLive(Users.UserId(sub), Sessions.SessionId(sid));
            });
  ```

- `packages/core/src/Sessions.ts:888` — SQL isLive: findById, then userId/supersededAt/absolute/idle checks (lines 895-905); memory twin at Sessions.ts:586-599.

  ```ts
      const isLive: SessionsShape["isLive"] = (userId, id) =>
        Effect.gen(function* () {
          const row = yield* repo.findById(id).pipe(
  ```

- `packages/jwt/test/Jwt.test.ts:193` — isLive checks `idleExpiresAt` as well as `absoluteExpiresAt`; pinned by Jwt.test.ts:193 'verifyLive fails for an idle-expired session even though absolute expiry is far off'.

  ```ts
    it.effect(
      "verifyLive fails for an idle-expired session even though absolute expiry is far off",
  ```

**No fix needed** — see evidence.

**Recommended status:** `resolved`

#### KRS-007 — No production migration creates jwt_signing_key

`medium` · `correctness` · `jwt` · [.issues/medium/KRS-007-key-rotation-specialist.md](../../.issues/medium/KRS-007-key-rotation-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED by `2ebd195` (confidence: high)

**Evidence at HEAD:**

- `packages/jwt/src/Jwt.ts:241` — Plugin now declares dialect-branched production migrations (and `migrations: jwtMigrations` at line 311).

  ```ts
  const jwtMigrations: Migrations.Migrations = [
    {
      name: "create_jwt_signing_key",
  ```

- `packages/jwt/test/KeyRing.test.ts:33` — The test's hand-rolled CREATE TABLE was replaced by the real migrations (994412d).

  ```ts
  const Migrated = Layer.effectDiscard(Migrations.run(Jwt.Jwt.migrations)).pipe(
    Layer.provide(SqlLive),
  );
  ```

**No fix needed** — see evidence.

**Recommended status:** `resolved`

#### AP-002 — Jwt.findKey falls back to the first RSA key on kid mismatch, making the rotation refetch unreachable

`medium` · `correctness` · `oauth` · [.issues/medium/AP-002-aaron-parecki.md](../../.issues/medium/AP-002-aaron-parecki.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED by `fd8e5e9` (confidence: high)

**Evidence at HEAD:**

- `packages/oauth/src/Jwt.ts:148` — A present-but-unmatched kid now fails, making OAuth.ts's kid-miss refetch reachable; regression tests OAuth.test.ts:1048/1057.

  ```ts
  export const findKey = (
    jwks: Jwks,
    kid: string | undefined,
  ): Effect.Effect<Jwk, JwtVerificationError> => {
    const candidates = jwks.keys.filter((key) => key.kty === "RSA" || key.kty === undefined);
    const matched = kid === undefined ? candidates[0] : candidates.find((key) => key.kid === kid);
  ```

**No fix needed** — see evidence.

**Recommended status:** `resolved`

#### VB-003 — OAuth id_token key selection falls back to the first JWKS key on kid mismatch

`medium` · `security` · `oauth` · [.issues/medium/VB-003-vittorio-bertocci.md](../../.issues/medium/VB-003-vittorio-bertocci.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED by `fd8e5e9` (confidence: high)

**Evidence at HEAD:**

- `packages/oauth/src/Jwt.ts:148` — A present-but-unmatched kid now fails, making OAuth.ts's kid-miss refetch reachable; regression tests OAuth.test.ts:1048/1057. Residual (by design): a kid-less token still uses the first RSA candidate; the optional 'try all keys when kid absent' suggestion is not required by RFC 8725 and can ride along with AOMS-005's findKey rewrite.

  ```ts
  export const findKey = (
    jwks: Jwks,
    kid: string | undefined,
  ): Effect.Effect<Jwk, JwtVerificationError> => {
    const candidates = jwks.keys.filter((key) => key.kty === "RSA" || key.kty === undefined);
    const matched = kid === undefined ? candidates[0] : candidates.find((key) => key.kid === kid);
  ```

**No fix needed** — see evidence.

**Recommended status:** `resolved`

#### TTE-002 — Decoded JWT header/payload claimed by assertion after JSON.parse

`medium` · `correctness` · `oauth` · [.issues/medium/TTE-002-typescript-type-level-engineer.md](../../.issues/medium/TTE-002-typescript-type-level-engineer.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED by `e3059f2` (confidence: high)

**Evidence at HEAD:**

- `packages/oauth/src/Jwt.ts:100` — Header/payload are Schema-decoded. The finding explicitly exempted the length-guarded `parts as [string, string, string]` (still at line 90); it nevertheless violates the repo's no-assertion rule, so its removal is scheduled as a step of AOMS-005.

  ```ts
      const header = Schema.decodeUnknownOption(JwtHeaderSchema)(decoded.header);
      const payload = Schema.decodeUnknownOption(JwtPayloadSchema)(decoded.payload);
      if (Option.isNone(header) || Option.isNone(payload)) {
        return yield* Effect.fail(new JwtVerificationError({ reason: "malformed JWT" }));
      }
  ```

**No fix needed** — see evidence.

**Recommended status:** `resolved`

#### ESS-007-effect-schema-specialist — kid-mismatch falls back to first JWKS key, contradicting the repo's own key-selection rule

`low` · `correctness` · `oauth` · [.issues/low/ESS-007-effect-schema-specialist.md](../../.issues/low/ESS-007-effect-schema-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED by `fd8e5e9` (confidence: high)

**Evidence at HEAD:**

- `packages/oauth/src/Jwt.ts:148` — A present-but-unmatched kid now fails, making OAuth.ts's kid-miss refetch reachable; regression tests OAuth.test.ts:1048/1057.

  ```ts
  export const findKey = (
    jwks: Jwks,
    kid: string | undefined,
  ): Effect.Effect<Jwk, JwtVerificationError> => {
    const candidates = jwks.keys.filter((key) => key.kty === "RSA" || key.kty === undefined);
    const matched = kid === undefined ? candidates[0] : candidates.find((key) => key.kid === kid);
  ```

**No fix needed** — see evidence.

**Recommended status:** `resolved`

#### ACS-003 — OIDC key selection falls back to the first RSA key on kid mismatch

`low` · `security` · `oauth` · [.issues/low/ACS-003-applied-cryptography-specialist.md](../../.issues/low/ACS-003-applied-cryptography-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED by `fd8e5e9` (confidence: high)

**Evidence at HEAD:**

- `packages/oauth/src/Jwt.ts:148` — A present-but-unmatched kid now fails, making OAuth.ts's kid-miss refetch reachable; regression tests OAuth.test.ts:1048/1057. Same residual note as VB-003 for kid-less tokens.

  ```ts
  export const findKey = (
    jwks: Jwks,
    kid: string | undefined,
  ): Effect.Effect<Jwk, JwtVerificationError> => {
    const candidates = jwks.keys.filter((key) => key.kty === "RSA" || key.kty === undefined);
    const matched = kid === undefined ? candidates[0] : candidates.find((key) => key.kid === kid);
  ```

**No fix needed** — see evidence.

**Recommended status:** `resolved`

#### ERAS-007 — The single node: reference in shipped src is a type-only import (edge-safe, but worth pinning)

`info` · `api` · `oauth` · [.issues/info/ERAS-007-edge-runtime-auth-specialist.md](../../.issues/info/ERAS-007-edge-runtime-auth-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED by `e364411` (confidence: high)

**Evidence at HEAD:**

- `packages/oauth/src/Jwt.ts:16` — The `import type { webcrypto } from "node:crypto"` line is gone; `grep -rn "node:" packages/oauth/src` finds no node: imports.

  ```ts
  import * as Data from "effect/Data";
  import * as Effect from "effect/Effect";
  import * as Option from "effect/Option";
  import * as Schema from "effect/Schema";
  ```

**No fix needed** — see evidence.

**Recommended status:** `resolved`

## Closed without work

| ID | Level | Verdict | Reason | Evidence |
|---|---|---|---|---|
| TRBS-002 | medium | ALREADY-FIXED | fixed by `2ebd195` | `packages/jwt/src/Jwt.ts:366` |
| TRBS-004 | medium | ALREADY-FIXED | fixed by `6629fd2` | `packages/jwt/src/Jwt.ts:443` |
| VB-002 | medium | ALREADY-FIXED | fixed by `6629fd2` | `packages/jwt/src/Jwt.ts:443` |
| TRBS-007 | medium | ALREADY-FIXED | fixed by `6629fd2` | `packages/jwt/src/Jwt.ts:443` |
| KRS-007 | medium | ALREADY-FIXED | fixed by `2ebd195` | `packages/jwt/src/Jwt.ts:241` |
| AP-002 | medium | ALREADY-FIXED | fixed by `fd8e5e9` | `packages/oauth/src/Jwt.ts:148` |
| VB-003 | medium | ALREADY-FIXED | fixed by `fd8e5e9` | `packages/oauth/src/Jwt.ts:148` |
| TTE-002 | medium | ALREADY-FIXED | fixed by `e3059f2` | `packages/oauth/src/Jwt.ts:100` |
| ESS-007-effect-schema-specialist | low | ALREADY-FIXED | fixed by `fd8e5e9` | `packages/oauth/src/Jwt.ts:148` |
| ACS-003 | low | ALREADY-FIXED | fixed by `fd8e5e9` | `packages/oauth/src/Jwt.ts:148` |
| ERAS-007 | info | ALREADY-FIXED | fixed by `e364411` | `packages/oauth/src/Jwt.ts:16` |
| SMS-001-secrets-management-specialist | high | DUPLICATE | duplicate of KRS-001 | `packages/jwt/src/SigningKeyRecords.ts:224` |
| MAPS-005 | medium | DUPLICATE | duplicate of PDR-003 | `packages/jwt/src/Jwt.ts:217` |
| SCP-007 | medium | DUPLICATE | duplicate of TIR-007 | `packages/jwt/src/Jwt.ts:443` |
| JJS-002 | medium | DUPLICATE | duplicate of ECF-002 | `packages/jwt/src/verify.ts:92` |
| TTE-003 | medium | DUPLICATE | duplicate of ESS-002-effect-schema-specialist | `packages/oauth/src/OAuthProvider.ts:142` |
| AP-007 | medium | DUPLICATE | duplicate of OAP-005 | `packages/oauth/src/OAuthProvider.ts:29` |
| NAM-003 | medium | DUPLICATE | duplicate of IC-003 | `packages/oauth/src/OAuthProvider.ts:5` |
| VB-009 | low | DUPLICATE | duplicate of PDR-003 | `packages/jwt/src/Jwt.ts:217` |
| OCM-007 | low | DUPLICATE | duplicate of OCM-002 | `packages/jwt/src/Jwt.ts:472` |
| KRS-009 | low | DUPLICATE | duplicate of JJS-004 | `packages/jwt/src/KeyRing.ts:227` |
| KRS-010 | low | DUPLICATE | duplicate of ECF-002 | `packages/jwt/src/verify.ts:92` |
| AH-003-anders-hejlsberg | low | DUPLICATE | duplicate of ESS-002-effect-schema-specialist | `packages/oauth/src/OAuthProvider.ts:142` |
| OCM-006 | info | DUPLICATE | duplicate of OCM-001 | `packages/jwt/src/Jwt.ts:167` |
| IC-008 | info | DUPLICATE | duplicate of NAM-001 | `packages/jwt/src/index.ts:3` |
| MW-010 | info | DUPLICATE | duplicate of IC-003 | `packages/oauth/src/OAuthProvider.ts:5` |

## Cross-slice notes

- **MAPS-001** (server slice) shares wayfinder 33 with NAM-001 — implement together in `jwt-stateless-bearer-reentry`.
- **OCM-001 / OCM-002** (api-key, wayfinder 10) are canonical for OCM-006 / OCM-007.
- **FAMS-002 / SAM-003 / SCP-001** (wayfinder 09 UserRecord revision) should carry NAM-009's `image` column in the same migration wave.
- **ECF-002**'s plan also edits `packages/oauth/src/OAuth.ts` (id_token JWKS cache); coordinate with whichever slice owns OAuth.ts.
- **JH-008**'s fix lands in `packages/core/src/Auth.ts` / `packages/ports` (core slice).
- **AVS-005**'s fix lands in `packages/password` (password slice).
- **AOMS-012** touches sql/core/api/server/password/oauth/passkey — cross-slice schema work.
