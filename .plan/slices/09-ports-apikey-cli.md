# Slice 09-ports-apikey-cli — validation & fix plan

- Validated at `ec065a7` on 2026-09-29 (57 issues: packages/ports, packages/api-key, packages/cli)
- Wayfinder decisions followed: 06 (CLI login), 07 (CLI tooling), 10 (machine identity), 21 (legacy verifiers), 22 (KeyProvider rotation), 23 (trusted proxy — already shipped), 35 (hasher offload)

| Verdict | high | medium | low | info | total |
|---|---|---|---|---|---|
| CONFIRMED | 8 | 10 | 8 | 3 | 29 |
| PARTIAL | 2 | 3 | 0 | 0 | 5 |
| ALREADY-FIXED | 0 | 0 | 0 | 0 | 0 |
| INVALID | 0 | 0 | 0 | 0 | 0 |
| DUPLICATE | 2 | 9 | 4 | 6 | 21 |
| WONTFIX-CANDIDATE | 0 | 1 | 0 | 1 | 2 |
| **total** | 12 | 23 | 12 | 10 | 57 |

**What is really wrong here.** `@awthaq/api-key` and `@awthaq/cli` are still literal `export {}` placeholders, so every
finding against them is real but collapses into four canonical builds already designed by wayfinder decisions 06/07/10
(API keys, service principals, CLI manifest tooling, CLI session commands). In `@awthaq/ports` the live defects are:
an unbounded in-memory rate-limit store keyed by attacker input (RBS-003), a store contract that cannot express an outage
and no shared store for multi-replica deployments (RBS-004), a Mailer port with no error channel (EEM-002), a single-key
KeyProvider that makes rotation destructive (KRS-002), argon2 verification that is neither constant-time (PHS-001, verified
in hash-wasm 4.12.0) nor parameter-clamped (ACS-006), unbounded main-thread KDF work (ERS-001), and ordinary passkey
registrations that skip the user-presence check (CB-002). Several findings were overtaken by landed work: the
LegacyPasswordVerifiers port + bcrypt verifier (60947ff) turns SAM-001/FAMS-001/BAM-004 into partial fixes, and the
ClientAddress port + per-IP rules (a3b7255, 349e220) fixed AR-005's IP dimension. Two audit claims were wrong: SimpleWebAuthn
14 does enforce UP on authentication (CB-002/BPAS-004 half-invalid), and MM-002's 'byte-identical tsconfig' detail is stale.

## Workstreams

### 1. `ratelimit-memory-eviction` — Bound the in-memory stores (rate limiter + core memory twins)

- **IDs:** RBS-003, ERS-004, TMS-004
- **Why grouped:** Unauthenticated memory-exhaustion vector on the only shipped rate-limit store; the core memory layers share the pattern.
- **Effort:** M · **Depends on workstreams:** —
- **Ordered steps:**
  1. **RBS-003** (M) — Bound layerStoreMemory: periodic expiry sweep + hard cap, with an observable size.
  2. **TMS-004** (M) — Prune expired rows in the core memory layers (Sessions, Verification).
- **Test plan:** RBS-003: FIRST (red): packages/ports/test/RateLimiter.test.ts — 'after the window plus one sweep interval elapses (TestClock), RateLimiterMemoryStats.size returns to 0'. TMS-004: FIRST (red): packages/core/test/pruneExpired.test.ts — 'drops only entries whose expiry ≤ now'.
- **Acceptance:** RBS-003: Spraying distinct keys cannot grow memory beyond maxBuckets. TMS-004: No core memory layer retains expired attacker-keyed state indefinitely.
- **Cross-workstream issue deps:** —

### 2. `mailer-typed-delivery-errors` — Typed Mailer delivery failures

- **IDs:** EEM-002, SOS-002, SOS-003
- **Why grouped:** One port signature change plus its three caller families; SMS findings fold in or are deferred.
- **Effort:** M · **Depends on workstreams:** —
- **Ordered steps:**
  1. **EEM-002** (M) — Give Mailer.send a typed MailDeliveryFailed error and make every caller choose a policy.
- **Test plan:** EEM-002: FIRST (red): packages/ports/test/Mailer.test.ts — 'a provider failure surfaces as MailDeliveryFailed in the error channel, not a defect' (type-level + runtime with a failing Mailer.of).
- **Acceptance:** EEM-002: Mailer implementations can report delivery failure without dying.
- **Cross-workstream issue deps:** —

### 3. `keyprovider-rotation` — Multi-key KeyProvider, AAD binding and key hygiene

- **IDs:** KRS-002, ACS-009, AR-007, SMS-005, ACS-008
- **Why grouped:** Decision 22's keyset + staleKid change the envelope/decrypt contract once; kid-in-AAD and key-copy hygiene belong in the same change; multi-replica docs follow.
- **Effort:** L · **Depends on workstreams:** —
- **Ordered steps:**
  1. **KRS-002** (L) — Multi-key layerEnv + staleKid-driven lazy re-encryption, exactly as decision 22 specifies.
  2. **SMS-005** (S) — Minimise raw key-byte lifetime and document the residual exposure.
  3. **ACS-008** (S) — Bind envelope version and kid into the GCM AAD (envelope v2), keeping v1 decryptable.
  4. **AR-007** (S) — Document a multi-replica deployment contract once KRS-002 (keyset) and RBS-004 (shared rate-limit store) exist.
- **Test plan:** KRS-002: FIRST (red): packages/ports/test/KeyProvider.test.ts — 'getKey returns a retired key listed in AWTHAQ_ENCRYPTION_KEYS' (ConfigProvider.fromMap). SMS-005: FIRST (red): packages/ports/test/Encryption.test.ts — 'KeyProvider.getKey/currentKey key bytes are unwrapped once per kid across 10 encrypt+decrypt calls' (KeyProvider test double counting Redacted.value via a getter-backed Redacted, or counting getKey calls after caching). ACS-008: FIRST (red): packages/ports/test/Encryption.test.ts — 'a v2 envelope whose kid field is rewritten to another known kid fails DecryptionFailed' (keyset with two kids sharing the same key bytes, so only AAD binding can catch it). AR-007: Doc-only; pnpm run test (README snippets unaffected).
- **Acceptance:** KRS-002: Rotating AWTHAQ_ENCRYPTION_KEY_ID no longer orphans existing ciphertext. SMS-005: Encryption no longer copies raw key bytes per operation. ACS-008: Swapping kid/v in an envelope fails authentication even when the substituted key would otherwise decrypt. AR-007: An operator can list every secret/stateful port that must be shared across replicas from the README.
- **Cross-workstream issue deps:** RBS-004

### 4. `password-hasher-verify-hardening` — Constant-time, clamped, non-downgrading, timing-uniform password verify

- **IDs:** PHS-001, PHS-002, ACS-006, PHS-007, TSS-006
- **Why grouped:** All touch PasswordHasher.verify/needsRehash (and signIn timing); PHS-001's own-parse path is the prerequisite for clamping argon2.
- **Effort:** M · **Depends on workstreams:** —
- **Ordered steps:**
  1. **PHS-001** (M) — Stop delegating argon2 comparison to hash-wasm: parse, recompute, compare in constant time.
  2. **PHS-002** (S) — (Recommended option C) Add a rehash policy knob defaulting to floor semantics, amend BEH-EA-116, fix the header comment.
  3. **TSS-006** (M) — Add a calibrated minimum-duration floor to signIn's credential check and document the residual.
  4. **ACS-006** (S) — Clamp stored-hash KDF parameters to configurable ceilings before any recomputation.
- **Test plan:** PHS-001: FIRST (red): packages/ports/test/PasswordHasher.test.ts — 'argon2id verify accepts a hash with a non-default hashLength (64 bytes) and rejects a one-bit-flipped digest' (proves own parse/compare path). PHS-002: FIRST (red): packages/ports/test/PasswordHasher.test.ts — 'under floor policy needsRehash is false for a hash stronger than the configured target'. TSS-006: FIRST (red): packages/password/test/Password.test.ts — with a fake PasswordHasher whose verify sleeps 5ms for a 'legacy' hash and 50ms for the dummy, under TestClock: 'signIn for a legacy-hash account takes no less time than for an unknown email'. ACS-006: FIRST (red): packages/ports/test/PasswordHasher.test.ts — 'scrypt verify of a $scrypt$ln=25,... hash returns false without running the KDF' (with a 2s vitest timeout — the unfixed code allocates ~4 GiB and hangs/throws).
- **Acceptance:** PHS-001: No argon2Verify call remains in PasswordHasher.ts. PHS-002: Lowering hasher config never silently downgrades stored hashes by default. TSS-006: Unknown-user and legacy-hash sign-ins are indistinguishable by latency below the floor. ACS-006: A corrupted/malicious stored hash cannot force a KDF above the deployment's ceiling.
- **Cross-workstream issue deps:** —

### 5. `password-hasher-offload` — Bound and offload KDF work (decision 35)

- **IDs:** ERS-001, ACS-001, ECF-004, PHS-003, ERAS-004
- **Why grouped:** Four duplicates of one root cause plus the edge-runtime doc note.
- **Effort:** L · **Depends on workstreams:** password-hasher-verify-hardening
- **Ordered steps:**
  1. **ERS-001** (L) — Bound hashing concurrency on the WASM layers and add opt-in Node worker-pool PasswordHasher layers (decision 35).
  2. **ERAS-004** (S) — Document where password hashing should run.
- **Test plan:** ERS-001: FIRST (red): packages/ports/test/PasswordHasher.test.ts — 'with AUTH_PASSWORD_HASH_CONCURRENCY=1 at most one verify runs at a time' (install a LegacyPasswordVerifier whose verify increments an in-flight counter and awaits a Deferred; fork 3 verifies; assert max in-flight === 1). ERAS-004: Doc-only.
- **Acceptance:** ERS-001: No unbounded concurrent KDF work on the main thread. ERAS-004: Edge deployment guidance is explicit next to the hasher config.
- **Cross-workstream issue deps:** —

### 6. `webauthn-user-presence` — Enforce UP on ordinary passkey registrations

- **IDs:** BPAS-004, CB-002
- **Why grouped:** Port + plugin change in one PR; authentication UP already enforced by the library.
- **Effort:** M · **Depends on workstreams:** —
- **Ordered steps:**
  1. **CB-002** (M) — Enforce UP on ordinary registrations by letting the plugin choose requireUserPresence per ceremony; surface userPresent.
- **Test plan:** CB-002: FIRST (red): packages/passkey/test/Passkey.test.ts — 'ordinary registerVerify rejects a UP=0 response with PasskeyVerificationFailed' (fixture helper clearing the UP bit in a 'none'-attestation authData).
- **Acceptance:** CB-002: UP=0 is accepted only for challenges from the conditional-create scope.
- **Cross-workstream issue deps:** —

### 7. `ratelimit-distributed-store` — Store error channel, fail-open, SQL store, enforcing quickstart

- **IDs:** AR-005, CSD-007, NHS-005, RBS-004
- **Why grouped:** The multi-instance story and the quickstart default depend on the same store work.
- **Effort:** L · **Depends on workstreams:** ratelimit-memory-eviction
- **Ordered steps:**
  1. **RBS-004** (L) — Give the store an error channel, implement BEH-EA-105's fail-open default, and ship a SQL-backed store.
  2. **AR-005** (S) — Close when RBS-004 and NHS-005 land; no additional code.
  3. **NHS-005** (S) — Make the quickstart enforce limits and flag the permissive layer.
- **Test plan:** RBS-004: FIRST (red): packages/ports/test/RateLimiter.test.ts — 'consume fails open and logs when the store fails RateLimiterStoreUnavailable'; 'reject policy fails RateLimited'. AR-005: Covered by RBS-004/NHS-005 tests. NHS-005: scripts/package-smoke.mjs / README snippet typecheck if available; otherwise doc-only.
- **Acceptance:** RBS-004: A store outage cannot 5xx the app by default. AR-005: Quickstart uses a shared, enforcing store. NHS-005: README's real default enforces the registered RATE_LIMITS rules.
- **Cross-workstream issue deps:** RBS-003

### 8. `legacy-password-migration` — Legacy password verifiers for Firebase, better-auth, Supabase

- **IDs:** FAMS-001, SAM-001, BAM-004
- **Why grouped:** All plug into the LegacyPasswordVerifiers port shipped in 60947ff.
- **Effort:** L · **Depends on workstreams:** password-hasher-verify-hardening
- **Ordered steps:**
  1. **FAMS-001** (L) — Ship @awthaq/migrate-firebase with a firebase-scrypt LegacyPasswordVerifier (decision 21).
  2. **SAM-001** (S) — Document and pin the Supabase/GoTrue bcrypt path on top of the existing verifier.
  3. **BAM-004** (M) — Add a better-auth scrypt LegacyPasswordVerifier to @awthaq/migrate-better-auth.
- **Test plan:** FAMS-001: FIRST (red): packages/migrate-firebase/test/FirebaseScryptVerifier.test.ts — 'verifies the published firebase/scrypt README test vector' (password/salt/signer key/salt separator/rounds=8/mem_cost=14 → expected hash). SAM-001: FIRST (red): packages/migrate-auth0/test/BcryptVerifier.test.ts — 'a GoTrue-style $2a$10$ hash verifies through layerArgon2id + BcryptVerifier.layer and needsRehash is true' (derive via bcryptjs then rewrite the $2b$ prefix to $2a$, which is algorithm-identical). BAM-004: FIRST (red): packages/migrate-better-auth/test/BetterAuthScryptVerifier.test.ts — 'verifies a hash produced by better-auth's hashPassword for a known password' (fixture string from a real better-auth install).
- **Acceptance:** FAMS-001: Firebase-exported password users sign in without reset and are rehashed on first login. SAM-001: A Supabase migrator can find and use the bcrypt verifier from the docs; the $2a$ path is covered by a test. BAM-004: better-auth users sign in after import without a password reset.
- **Cross-workstream issue deps:** —

### 9. `ratelimit-signal-and-escalation` — Rate-limit breach signal, error naming and opt-in escalation

- **IDs:** EOTS-007, RBS-009, RBS-010
- **Why grouped:** Rename first (RBS-010), then centralise enforcement with events/metrics (EOTS-007), then escalation (RBS-009) on top of the store primitive.
- **Effort:** M · **Depends on workstreams:** ratelimit-distributed-store
- **Ordered steps:**
  1. **RBS-010** (S) — Rename the port error and drop its raw key.
  2. **EOTS-007** (M) — Emit an auth.rateLimit.exceeded event, a warning log and a counter on every breach, via one shared helper.
  3. **RBS-009** (M) — Opt-in per-rule exponential escalation.
- **Test plan:** RBS-010: FIRST (red): packages/ports/test/RateLimiter.test.ts — 'exceeding a limit fails with _tag RateLimitExceeded and no key field'. EOTS-007: FIRST (red): packages/password/test/Password.test.ts — 'exceeding the signIn limit publishes auth.rateLimit.exceeded whose payload does not contain the email'. RBS-009: FIRST (red): packages/ports/test/RateLimiter.test.ts — 'with escalation factor 2, the second consecutive limited window doubles retryAfterMillis (TestClock)'.
- **Acceptance:** RBS-010: No two error classes share the 'RateLimited' tag. EOTS-007: Every breach is observable via event, log and metric without leaking identifiers. RBS-009: Attacker cost rises across windows when enabled; default unchanged.
- **Cross-workstream issue deps:** RBS-004

### 10. `tsconfig-paths-drift` — tsconfig paths drift check

- **IDs:** MM-002
- **Why grouped:** Independent build-hygiene fix; land before new packages (migrate-firebase, api-key) add more edges.
- **Effort:** S · **Depends on workstreams:** —
- **Ordered steps:**
  1. **MM-002** (S) — Remove the stale edges and add a tsconfig-vs-package.json drift check to `pnpm check`.
- **Test plan:** MM-002: FIRST (red): run the new script before the cleanup — it must report ports→api and sql→api; after cleanup it passes.
- **Acceptance:** MM-002: No package maps an @awthaq alias it does not depend on.
- **Cross-workstream issue deps:** —

### 11. `spec-model-drift` — Stale JWT/Bearer model doc

- **IDs:** JJS-010
- **Why grouped:** Doc-only correction.
- **Effort:** S · **Depends on workstreams:** —
- **Ordered steps:**
  1. **JJS-010** (S) — Correct spec/models/08-jwt-bearer.md so it distinguishes the shipped Jwt plugin from the still-missing Bearer strategy.
- **Test plan:** JJS-010: pnpm run spec:verify:strict (no code test; doc-only).
- **Acceptance:** JJS-010: spec/models/08-jwt-bearer.md no longer claims no Jwt plugin exists.
- **Cross-workstream issue deps:** —

### 12. `apikey-machine-identity` — @awthaq/api-key: API keys + client_credentials service identity (decision 10)

- **IDs:** MAPS-003, OCM-002, SCP-002, AR-006, SMS-008, TRBS-009
- **Why grouped:** Every api-key finding collapses into two canonical builds: API-key credentials (OCM-002) and service principals (MAPS-003).
- **Effort:** XL · **Depends on workstreams:** tsconfig-paths-drift
- **Ordered steps:**
  1. **OCM-002** (L) — Implement the long-lived API-key credential kind of @awthaq/api-key exactly as decision 10 specifies, and make it a third Authentication scheme.
  2. **MAPS-003** (L) — Give ServicePrincipal a construction path: client_credentials M2M clients in @awthaq/api-key minting short-lived JWTs via @awthaq/jwt, verified back into ServicePrincipal.
- **Test plan:** OCM-002: FIRST (red): packages/api-key/test/ApiKey.test.ts — 'create returns a show-once key whose only persisted form is its SHA-256 digest' (read the record back; assert no field equals the secret). MAPS-003: FIRST (red): packages/api-key/test/ServiceToken.test.ts — 'client_credentials with a valid secret mints a JWT whose bearer resolves to ServicePrincipal with the negotiated scopes'.
- **Acceptance:** OCM-002: `packages/api-key/src/index.ts` exports ApiKey, ApiKeyApi, ApiKeyConfig; package no longer a placeholder. MAPS-003: A service-to-service caller can obtain and use a short-lived token without any user session.
- **Cross-workstream issue deps:** —

### 13. `cli-manifest-tooling` — @awthaq/cli manifest tooling (decision 07)

- **IDs:** BE-003, ECS-004, FAMS-010, MW-006, CTA-007, ELC-008, ERS-008, RRM-011
- **Why grouped:** Every CLI-absence finding except login; ADR first, then sub-tickets A–F.
- **Effort:** XL · **Depends on workstreams:** legacy-password-migration
- **Ordered steps:**
  1. **ECS-004** (S) — Record the CLI-framework choice as an ADR and retire the stale @effect/cli recommendation.
  2. **BE-003** (XL) — Build the @awthaq/cli command tree per decision 07 (doctor, plugin list --graph, routes, migration status|apply, openapi, seed admin, import mechanism).
  3. **FAMS-010** (M) — Ship a Firebase import recipe in @awthaq/migrate-firebase and expose it as `awthaq import --from firebase`.
- **Test plan:** ECS-004: pnpm run spec:verify:strict (doc-only). BE-003: FIRST (red): packages/cli/test/Routes.test.ts — 'routes lists every endpoint of a TestAuth composition with its owning plugin' against an in-test Auth.make([...]) value (no listener). FAMS-010: FIRST (red): packages/migrate-firebase/test/ImportFirebaseUser.test.ts — 'an imported email-verified password user signs in via the firebase-scrypt legacy verifier and is rehashed to argon2id on first sign-in'.
- **Acceptance:** ECS-004: ADR-EA-017 exists and is indexed. BE-003: `awthaq routes|openapi|plugin list --graph|migration status|apply --yes|doctor|seed admin` all run against an app's awthaq.config.ts without starting an HTTP server. FAMS-010: A Firebase auth.listUsers export can be imported programmatically and via the CLI without forced password resets.
- **Cross-workstream issue deps:** FAMS-001

### 14. `cli-session-commands` — CLI login/logout/whoami (decision 06)

- **IDs:** CTA-001, DAG-002, CTA-005
- **Why grouped:** Needs the CLI skeleton, the BEH-EA-208 amendment (cross-slice CTA-002/DAG-003) and API keys for CI.
- **Effort:** L · **Depends on workstreams:** cli-manifest-tooling, apikey-machine-identity
- **Ordered steps:**
  1. **CTA-001** (L) — Add the login/logout/whoami command family to @awthaq/cli per decision 06 (token path now, device flow later).
- **Test plan:** CTA-001: FIRST (red): packages/cli/test/CredentialStore.test.ts — 'file fallback writes credentials.json with mode 0600' and 'AWTHAQ_TOKEN overrides the stored credential and never writes the store'.
- **Acceptance:** CTA-001: `awthaq login --token`, `logout`, `whoami` work non-interactively in CI with AWTHAQ_TOKEN/AWTHAQ_BASE_URL.
- **Cross-workstream issue deps:** BE-003, OCM-002

### 15. `webauthn-attestation-policy` — Attestation conveyance that means something

- **IDs:** HSK-002, TC-006, CB-008, HSK-006
- **Why grouped:** Open decision (HSK-002); 'indirect' rides along.
- **Effort:** M · **Depends on workstreams:** —
- **Ordered steps:**
  1. **HSK-002** (M) — (Recommended option B) Surface attestation format and add an optional AAGUID/format trust policy; warn when conveyance is requested without a policy.
  2. **HSK-006** (S) — Add 'indirect' to AttestationConveyance.
- **Test plan:** HSK-002: FIRST (red): packages/passkey/test/Passkey.test.ts — 'with attestationPolicy.trustedAaguids set, a none-format registration fails PasskeyAttestationRejected'. HSK-006: FIRST (red): packages/ports/test/WebAuthn.test.ts — 'registrationOptions with attestation indirect returns options.attestation === "indirect"'.
- **Acceptance:** HSK-002: Opting into direct/enterprise can be made enforceable; without a policy the operator is told it is not. HSK-006: The port's conveyance type matches the WebAuthn L3 enum.
- **Cross-workstream issue deps:** —

### 16. `phc-hash-branding` — PhcHash brand

- **IDs:** TTE-005
- **Why grouped:** Type-level change best made once the hasher shape settles.
- **Effort:** M · **Depends on workstreams:** password-hasher-verify-hardening, password-hasher-offload, legacy-password-migration
- **Ordered steps:**
  1. **TTE-005** (M) — Introduce a PhcHash brand and thread it through the hasher port and credential storage.
- **Test plan:** TTE-005: FIRST (red): packages/ports/test/PasswordHasher.test.ts — expectTypeOf/`// @ts-expect-error` 'verify rejects a plain string where a PhcHash is required'.
- **Acceptance:** TTE-005: A non-PHC string cannot be passed to verify/needsRehash without an explicit mint.
- **Cross-workstream issue deps:** ERS-001, PHS-001

## Decisions needed

### PHS-002 — needsRehash uses strict equality, enabling silent downgrade of stronger hashes

- A: keep equality (BEH-EA-116 as written); only fix the misleading header comment.
- B: switch to floor semantics unconditionally and amend BEH-EA-116.
- C: policy knob AUTH_PASSWORD_REHASH_POLICY=floor|exact, default floor; amend BEH-EA-116 (richer, keeps deliberate downgrade possible).

**Recommendation:** C — floor by default closes the silent-downgrade path, while 'exact' preserves the legitimate 'we over-tuned cost and must lower it' operation; both are one comparison each, so the richer option costs almost nothing.

### HSK-002 — Attestation conveyance ("direct"/"enterprise") exists but attestation is never verified anywhere

- A: documentation + startup warning only.
- B: surface fmt + optional trustedAaguids/rejectSelfAttestation policy + warning (no MDS).
- C: narrow AttestationConveyance to 'none' until an MDS3 enterprise module exists (breaking BEH-EA-135's opt-in).

**Recommendation:** B — it turns a cosmetic knob into an enforceable one for the hardware-key use case with no MDS dependency, keeps BEH-EA-135's opt-in, and the warning covers operators who set the knob without a policy.

Other scope calls flagged (not blocking, already recommended by wayfinder decisions): device-flow `login` gated on a DeviceAuthorization plugin that does not exist (decision 06); client_credentials pulled into M7 ahead of Phase-3 (decision 10); better-auth-first import scope (decision 07).

## Per-issue dossiers

### Workstream `ratelimit-memory-eviction`

#### RBS-003 — Memory store never evicts buckets whose keys are attacker-controlled — unauthenticated memory-DoS

`high` · `security` · `ports` · [.issues/high/RBS-003-rate-limiting-brute-force-specialist.md](../../.issues/high/RBS-003-rate-limiting-brute-force-specialist.md) · current: `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high)

Unchanged (git-log hit 4b48cb2 is a TRBS-003 substring match, unrelated). Canonical for ERS-004.

**Evidence at HEAD:**

- `packages/ports/src/RateLimiter.ts:114` — Entries are only ever set, never removed; no size cap, no sweep fiber.

```
    const buckets = yield* Ref.make(HashMap.empty<string, Bucket>());
    const increment: RateLimiterStoreShape["increment"] = (key, window) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return yield* Ref.modify(buckets, (state) => {
          const existing = HashMap.get(state, key);
          ...
          return [next, HashMap.set(state, key, next)];
```
- `packages/password/src/Password.ts:593` — Keys embed attacker-chosen email/identifier/IP.

```
              key: (input) => `password:signin:ip:${ipFromRateLimitInput(input)}`,
```

**Fix plan** (M): Bound layerStoreMemory: periodic expiry sweep + hard cap, with an observable size.

Steps:
1. RateLimiter.ts: `layerStoreMemoryWith({ maxBuckets, sweepInterval })` (layerStoreMemory = defaults 100_000 / 1 minute): scoped sweeper fiber (`Effect.forkScoped` + `Schedule.spaced`) removes buckets whose resetAt ≤ now; inside `increment`'s Ref.modify, when size ≥ maxBuckets, first drop expired, then evict the earliest-resetAt bucket.
2. Same layer also provides `RateLimiterMemoryStats` (Context.Service `{ size: Effect<number> }`) for tests and saturation metrics (EOTS-007).
3. Header comment + BEH-EA-105 addendum: memory store is single-process and bounded.

Files: `packages/ports/src/RateLimiter.ts`, `spec/behaviors/14-rate-limiting.md`

Tests:
- FIRST (red): packages/ports/test/RateLimiter.test.ts — 'after the window plus one sweep interval elapses (TestClock), RateLimiterMemoryStats.size returns to 0'.
- 'with maxBuckets 3, a 4th distinct key evicts the earliest-expiring bucket and size stays 3'.
- Existing fixed-window/concurrency tests stay green.

Acceptance:
- Spraying distinct keys cannot grow memory beyond maxBuckets.
- Expired buckets are reclaimed without re-use of the same key.

Spec refs: BEH-EA-105, BEH-EA-109 · Depends on: — · Absorbs: ERS-004

**Recommended status:** `ready-for-agent`

#### ERS-004 — Memory rate-limiter store never evicts buckets: unbounded growth in a long-lived process

`medium` · `performance` · `ports` · [.issues/medium/ERS-004-effect-runtime-scheduler-specialist.md](../../.issues/medium/ERS-004-effect-runtime-scheduler-specialist.md) · current: `needs-triage`

**Verdict:** DUPLICATE of **RBS-003** (confidence: high)

Same finding as RBS-003.

**Evidence at HEAD:**

- `packages/ports/src/RateLimiter.ts:114` — Entries are only ever set, never removed; no size cap, no sweep fiber.

```
    const buckets = yield* Ref.make(HashMap.empty<string, Bucket>());
    const increment: RateLimiterStoreShape["increment"] = (key, window) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return yield* Ref.modify(buckets, (state) => {
          const existing = HashMap.get(state, key);
          ...
          return [next, HashMap.set(state, key, next)];
```

**No fix of its own** — closed by the canonical issue's plan.

**Recommended status:** `resolved`

#### TMS-004 — Memory stores never evict expired state — attacker-keyed unbounded growth in rate limiter, sessions, and verification reservations

`medium` · `security` · `ports` · [.issues/medium/TMS-004-threat-modeling-specialist.md](../../.issues/medium/TMS-004-threat-modeling-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

Broader than RBS-003: the same no-eviction pattern holds for the core memory twins of Sessions and Verification reservations. Rate-limiter half is fixed by RBS-003; this issue owns the core-layer halves.

**Evidence at HEAD:**

- `packages/ports/src/RateLimiter.ts:114` — Entries are only ever set, never removed; no size cap, no sweep fiber.

```
    const buckets = yield* Ref.make(HashMap.empty<string, Bucket>());
    const increment: RateLimiterStoreShape["increment"] = (key, window) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return yield* Ref.modify(buckets, (state) => {
          const existing = HashMap.get(state, key);
          ...
          return [next, HashMap.set(state, key, next)];
```
- `packages/core/src/Verification.ts:240` — Expired reservations are never removed.

```
      const reserve: VerificationShape["reserve"] = Effect.fnUntraced(function* (input) {
        ...
          return [
            true,
            HashMap.set(s, input.identifier, DateTime.addDuration(now, input.ttl)),
          ] as const;
```
- `packages/core/src/Sessions.ts:321` — Memory sessions are removed only on revoke (line 552), never on expiry.

```
      const state = yield* Ref.make(HashMap.empty<SessionId, SessionRow>());
```

**Fix plan** (M): Prune expired rows in the core memory layers (Sessions, Verification).

Steps:
1. packages/core/src/internal/pruneExpired.ts: pure helper `pruneExpired(map, now, expiryOf)`.
2. Verification.layerMemory: prune reservations and expired token rows inside the existing Ref.modify when size exceeds a threshold (e.g. 10_000) — keeps atomicity.
3. Sessions.layerMemory: prune rows past absoluteExpiresAt on issue when above threshold.
4. Doc on both layerMemory: single-process/dev semantics; SQL layers are the production path.

Files: `packages/core/src/internal/pruneExpired.ts (new)`, `packages/core/src/Verification.ts`, `packages/core/src/Sessions.ts`

Tests:
- FIRST (red): packages/core/test/pruneExpired.test.ts — 'drops only entries whose expiry ≤ now'.
- packages/core/test/Verification.test.ts — 'reserve still returns false for a live reservation and true after expiry' (regression) with pruning active.

Acceptance:
- No core memory layer retains expired attacker-keyed state indefinitely.

Spec refs: BEH-EA-057, BEH-EA-063 · Depends on: RBS-003

**Recommended status:** `ready-for-agent`

### Workstream `mailer-typed-delivery-errors`

#### EEM-002 — Mailer port types delivery as Effect<void> — an expected operational failure forced into the defect channel

`high` · `architecture` · `ports` · [.issues/high/EEM-002-effect-error-management-specialist.md](../../.issues/high/EEM-002-effect-error-management-specialist.md) · current: `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high)

Confirmed; the earlier validation comment already set it ready-for-agent. Canonical (SOS-003 duplicates).

**Evidence at HEAD:**

- `packages/ports/src/Mailer.ts:37` — No error channel; `grep -rn MailDeliveryFailed packages` → nothing.

```
export interface MailerShape {
  readonly send: (message: MailMessage) => Effect.Effect<void>;
  readonly sent: Effect.Effect<ReadonlyArray<MailMessage>>;
}
```
- `packages/password/src/Password.ts:905` — Callers now fork (enumeration fix), but Effect.ignore does not catch defects, and a die is the only failure a provider can express.

```
          yield* Effect.forkDetach(
            Effect.gen(function* () {
              ...
              yield* mailer.send({
                to: user.email,
                template: "reset-password",
                ...
            }).pipe(Effect.ignore),
```
- `README.md:117` — Quickstart mailer uses a nonexistent `subject` field and omits `sent` — fix alongside.

```
const consoleMailer = Layer.succeed(
  Mailer.Mailer,
  Mailer.Mailer.of({
    send: (message) => Effect.sync(() => console.log(`[mail] to=${message.to} subject=${message.subject}`)),
```

**Fix plan** (M): Give Mailer.send a typed MailDeliveryFailed error and make every caller choose a policy.

Steps:
1. Mailer.ts: `export class MailDeliveryFailed extends Data.TaggedError("MailDeliveryFailed")<{ readonly template: string; readonly reason: string; readonly cause?: unknown }>` (no recipient/data → no tokens or PII); `send: (message) => Effect.Effect<void, MailDeliveryFailed>`. layerNoop keeps Effect.die (misconfiguration is a defect); layerMemory unchanged.
2. Password.ts signUp (~783), requestReset (~913), resendVerification (~946): inside the forked blocks add `Effect.tapError((e) => Effect.logWarning("awthaq: mail delivery failed").pipe(Effect.annotateLogs({ template: e.template, reason: e.reason })))` before `Effect.ignore`; responses stay uniform (BEH-EA-064/114).
3. Organization.ts sendInvite (~1780): the inviter is authenticated, so surface failure: persist the invitation, then map MailDeliveryFailed to a new wire error `OrganizationApi.InvitationDeliveryFailed { invitationId }` (httpApiStatus 502) declared on the create/resend endpoints so the client can call resend.
4. README.md:117-122: fix the quickstart consoleMailer (`message.template`, add `sent: Effect.succeed([])`, show mapping a provider error to MailDeliveryFailed).
5. spec/overview.md Ports table (line 95): note the error channel.

Files: `packages/ports/src/Mailer.ts`, `packages/password/src/Password.ts`, `packages/organization/src/Organization.ts`, `packages/organization/src/OrganizationApi.ts`, `README.md`, `spec/overview.md`

Tests:
- FIRST (red): packages/ports/test/Mailer.test.ts — 'a provider failure surfaces as MailDeliveryFailed in the error channel, not a defect' (type-level + runtime with a failing Mailer.of).
- packages/password/test/Password.test.ts — 'requestReset returns success and logs a warning when Mailer.send fails with MailDeliveryFailed'.
- packages/organization/test — 'createInvitation returns InvitationDeliveryFailed when mail fails; invitation stays pending; resend succeeds once mail recovers'.

Acceptance:
- Mailer implementations can report delivery failure without dying.
- Password endpoints keep uniform responses; failures are logged.
- Invitation delivery failure is visible to the inviter.

Spec refs: BEH-EA-113, BEH-EA-114 · Depends on: — · Absorbs: SOS-003

**Recommended status:** `ready-for-agent`

#### SOS-002 — No SmsSender port: the archive design reserved auth.sms but the ports stratum never implemented it

`medium` · `architecture` · `ports` · [.issues/medium/SOS-002-sms-otp-specialist.md](../../.issues/medium/SOS-002-sms-otp-specialist.md) · current: `needs-triage`

**Verdict:** WONTFIX-CANDIDATE (confidence: medium)

True that no SmsSender port exists, but no plugin, roadmap milestone, or spec behavior consumes one, and the spec leaves SMS OTP undecided. Adding the port now is speculative infrastructure (user preference: no unused infra). Revisit when an SMS-OTP/phone plugin is scheduled; build it then with EEM-002's typed error channel.

**Evidence at HEAD:**

- `packages/ports/src/index.ts:27` — No SmsSender.

```
export * as ClientAddress from "./ClientAddress.ts";
export * as Encryption from "./Encryption.ts";
export * as KeyProvider from "./KeyProvider.ts";
export * as LegacySessionBridge from "./LegacySessionBridge.ts";
export * as Mailer from "./Mailer.ts";
```
- `spec/models/06-two-factor-totp.md:106` — No roadmap item or plugin consumes SMS today.

```
whether SMS OTP ships as a separate, explicitly "restricted" plugin per NIST
800-63B-4 guidance. None of this has been decided beyond the row in
`archive/PRD.md` §17.
```

**No fix of its own** — see rationale above.

**Recommended status:** `wontfix`

#### SOS-003 — Mailer.send has no error channel, so channel delivery failure is untypeable — fatal for SMS where provider failure is routine

`medium` · `api` · `ports` · [.issues/medium/SOS-003-sms-otp-specialist.md](../../.issues/medium/SOS-003-sms-otp-specialist.md) · current: `needs-triage`

**Verdict:** DUPLICATE of **EEM-002** (confidence: high)

Mailer half is EEM-002. The SmsSender half is moot until an SMS port exists (SOS-002 is a wontfix candidate); when it is built it must copy EEM-002's typed-error shape.

**Evidence at HEAD:**

- `packages/ports/src/Mailer.ts:37` — No error channel; `grep -rn MailDeliveryFailed packages` → nothing.

```
export interface MailerShape {
  readonly send: (message: MailMessage) => Effect.Effect<void>;
  readonly sent: Effect.Effect<ReadonlyArray<MailMessage>>;
}
```

**No fix of its own** — closed by the canonical issue's plan.

**Recommended status:** `resolved`

### Workstream `keyprovider-rotation`

#### KRS-002 — Only shipped KeyProvider implementation is single-key, making rotation destructive

`high` · `architecture` · `ports` · [.issues/high/KRS-002-key-rotation-specialist.md](../../.issues/high/KRS-002-key-rotation-specialist.md) · current: `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high)

Unchanged at HEAD. Decision 22 fixes it: replace layerEnv with a real multi-key keyset (AWTHAQ_ENCRYPTION_KEYS + AWTHAQ_ENCRYPTION_KEY_ID), and add a `staleKid` signal to Encryption.decrypt for lazy re-encryption. Canonical (ACS-009 duplicates it).

**Evidence at HEAD:**

- `packages/ports/src/KeyProvider.ts:96` — layerEnv is the only KeyProvider implementation; any retired kid fails UnknownKeyId.

```
    const material: KeyMaterial = { kid, key: Redacted.make(decoded.success) };
    const getKey: KeyProviderShape["getKey"] = (requestedKid) =>
      requestedKid === kid
        ? Effect.succeed(material)
        : Effect.fail(new UnknownKeyId({ kid: requestedKid }));
```
- `packages/ports/src/KeyProvider.ts:20`

```
// after `currentKey` has moved on to a newer one. `layerEnv` itself only
// ever knows one key, so `getKey` on any other `kid` fails with
// `UnknownKeyId` — real rotation support (multiple simultaneously live
// keys) is a property of a future multi-key implementation of this
// interface, not of this dev/test layer.
```

**Fix plan** (L): Multi-key layerEnv + staleKid-driven lazy re-encryption, exactly as decision 22 specifies.

Steps:
1. KeyProvider.ts layerEnv: read `AWTHAQ_ENCRYPTION_KEYS` (Config.Redacted JSON array of `{ kid, key }`), decode with a Schema (no casts), each key base64 → exactly 32 bytes (die otherwise), die on empty set / duplicate kid; `AWTHAQ_ENCRYPTION_KEY_ID` required (no more `"env"` default) and must name a kid in the set (die otherwise). `getKey` = lookup over the whole set; `currentKey` = the named kid. Update header comment lines 1-28.
2. Encryption.ts: `decrypt` success type becomes `{ readonly plaintext: Redacted.Redacted<string>; readonly staleKid: Option.Option<string> }` (Some(envelope.kid) when ≠ current kid).
3. Consumers: packages/sql/src/Repositories.ts:226 (provider tokens) — on `Some(staleKid)` re-encrypt under current key and persist in the same read path (lazy migration); packages/oauth/src/OAuth.ts:656,666 (short-lived PKCE/nonce) — just read `.plaintext`.
4. README.md lines 81, 171, 217: document the new env vars, one-entry migration `[{"kid":"env","key":"<old>"}]`, and the retirement procedure (rotate KEY_ID, keep old entry until nothing references it).
5. Add ADR spec/decisions/019-encryption-key-rotation.md (decision 22 asks for one): kid-keyed envelope, retirement-not-grace-window, lazy re-encryption; note it must not be reused for JWT signing-key rotation.

Files: `packages/ports/src/KeyProvider.ts`, `packages/ports/src/Encryption.ts`, `packages/sql/src/Repositories.ts`, `packages/oauth/src/OAuth.ts`, `packages/test/src/TestAuth.ts (env fixture)`, `README.md`, `spec/decisions/019-encryption-key-rotation.md (new)`, `spec/decisions/index.yaml`

Tests:
- FIRST (red): packages/ports/test/KeyProvider.test.ts — 'getKey returns a retired key listed in AWTHAQ_ENCRYPTION_KEYS' (ConfigProvider.fromMap).
- KeyProvider.test.ts — 'dies when AWTHAQ_ENCRYPTION_KEY_ID is not in the keyset', 'dies on duplicate kid', 'dies on a 31-byte key'.
- packages/ports/test/Encryption.test.ts — 'decrypt of an envelope written under a retired key returns staleKid Some(oldKid)'; 'current-key envelope returns None'.
- packages/sql/test (provider-token repository) — 'reading a stale-kid token re-encrypts it under the current kid'.

Acceptance:
- Rotating AWTHAQ_ENCRYPTION_KEY_ID no longer orphans existing ciphertext.
- Stale envelopes migrate lazily on read.
- Misconfiguration dies loudly at layer build.

Spec refs: — · Depends on: — · Absorbs: ACS-009

**Recommended status:** `ready-for-agent`

#### ACS-009 — Env KeyProvider makes key rotation destructive for data at rest

`low` · `security` · `ports` · [.issues/low/ACS-009-applied-cryptography-specialist.md](../../.issues/low/ACS-009-applied-cryptography-specialist.md) · current: `needs-triage`

**Verdict:** DUPLICATE of **KRS-002** (confidence: high)

Same finding as KRS-002 (single-key layerEnv makes rotation destructive).

**Evidence at HEAD:**

- `packages/ports/src/KeyProvider.ts:96` — layerEnv is the only KeyProvider implementation; any retired kid fails UnknownKeyId.

```
    const material: KeyMaterial = { kid, key: Redacted.make(decoded.success) };
    const getKey: KeyProviderShape["getKey"] = (requestedKid) =>
      requestedKid === kid
        ? Effect.succeed(material)
        : Effect.fail(new UnknownKeyId({ kid: requestedKid }));
```

**No fix of its own** — closed by the canonical issue's plan.

**Recommended status:** `resolved`

#### AR-007 — Multi-replica secret provisioning is dev-shaped: single env key, no rotation or KMS path shipped

`low` · `dx` · `ports` · [.issues/low/AR-007-aeneas-rekkas.md](../../.issues/low/AR-007-aeneas-rekkas.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

Rotation half is KRS-002; the multi-replica shared-secret checklist is a standalone doc gap.

**Evidence at HEAD:**

- `packages/ports/src/KeyProvider.ts:62`

```
/**
 * Dev/test seam: one key, read once from the environment at layer
 * construction.
```
- `README.md:217` — `grep -ni replica README.md` → no multi-replica deployment guidance.

```
| `Encryption`/`KeyProvider` | `layerEnv` (`AWTHAQ_ENCRYPTION_KEY`) | a KMS-backed `KeyProvider` (implement the port directly) |
```

**Fix plan** (S): Document a multi-replica deployment contract once KRS-002 (keyset) and RBS-004 (shared rate-limit store) exist.

Steps:
1. README.md: new 'Running more than one replica' section: every replica must share AWTHAQ_ENCRYPTION_KEYS/KEY_ID, the CsrfConfig secret (packages/server/src/Csrf.ts:26), the Jwt signing keys (SigningKeyRecords in the DB), and a shared RateLimiterStore (SQL store from RBS-004); rotation procedure from decision 22.

Files: `README.md`

Tests:
- Doc-only; pnpm run test (README snippets unaffected).

Acceptance:
- An operator can list every secret/stateful port that must be shared across replicas from the README.

Spec refs: — · Depends on: KRS-002, RBS-004

**Recommended status:** `ready-for-agent`

#### SMS-005 — Key material is never zeroized and raw bytes escape Redacted at the WebCrypto boundary

`low` · `security` · `ports` · [.issues/low/SMS-005-secrets-management-specialist.md](../../.issues/low/SMS-005-secrets-management-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

Accurate low-severity hygiene finding. JS cannot guarantee scrubbing, but the per-call unwrapped copies are avoidable and the limitation is undocumented.

**Evidence at HEAD:**

- `packages/ports/src/KeyProvider.ts:43`

```
  readonly key: Redacted.Redacted<Uint8Array>;
```
- `packages/ports/src/Encryption.ts:112` — Every encrypt/decrypt unwraps the key (lines 129, 158) and makes a fresh un-zeroed copy; `grep -rn 'fill(0)' packages/*/src` → none.

```
const toArrayBuffer = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(bytes);

const importAesKey = (bytes: Uint8Array, usage: "encrypt" | "decrypt") =>
  Effect.promise(() =>
    globalThis.crypto.subtle.importKey("raw", toArrayBuffer(bytes), ALGORITHM, false, [usage]),
  );
```

**Fix plan** (S): Minimise raw key-byte lifetime and document the residual exposure.

Steps:
1. Encryption.layer: cache the imported non-extractable CryptoKey per (kid, usage) in a Ref<HashMap> so raw bytes are unwrapped once per kid rather than per call; zero (`fill(0)`) the transient copy passed to importKey after the promise resolves.
2. KeyProvider.layerEnv: zero the decoded buffer on the wrong-length die path.
3. KeyProvider.ts header: document that JS runtimes cannot guarantee zeroization, that Redacted only prevents accidental logging, and that production should use a KMS-backed KeyProvider so raw bytes never enter the process (README.md:217 cross-link).

Files: `packages/ports/src/Encryption.ts`, `packages/ports/src/KeyProvider.ts`, `README.md`

Tests:
- FIRST (red): packages/ports/test/Encryption.test.ts — 'KeyProvider.getKey/currentKey key bytes are unwrapped once per kid across 10 encrypt+decrypt calls' (KeyProvider test double counting Redacted.value via a getter-backed Redacted, or counting getKey calls after caching).

Acceptance:
- Encryption no longer copies raw key bytes per operation.
- Zeroization limits are documented.

Spec refs: — · Depends on: KRS-002

**Recommended status:** `ready-for-agent`

#### ACS-008 — Envelope kid and version not bound into the GCM additional authenticated data

`info` · `security` · `ports` · [.issues/info/ACS-008-applied-cryptography-specialist.md](../../.issues/info/ACS-008-applied-cryptography-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

Accurate hardening gap; harmless with one key, relevant once KRS-002 ships multiple live keys. Do it in the same change as KRS-002 so envelopes change format once.

**Evidence at HEAD:**

- `packages/ports/src/Encryption.ts:131` — AAD = caller string only; envelope `v`/`kid` (lines 49-54) are unauthenticated.

```
          globalThis.crypto.subtle.encrypt(
            {
              name: ALGORITHM,
              iv: toArrayBuffer(iv),
              additionalData: new TextEncoder().encode(aad),
            },
```

**Fix plan** (S): Bind envelope version and kid into the GCM AAD (envelope v2), keeping v1 decryptable.

Steps:
1. Encryption.ts: new envelopes are `v: 2`; AAD bytes = UTF-8 of a length-prefixed header `awthaq-enc:v2:${kid.length}:${kid}:${aad}` (unambiguous framing).
2. decrypt: accept `v: 1` (legacy AAD = caller aad) and `v: 2` (framed AAD); treat a v1 envelope as stale (`staleKid` Some) so KRS-002's lazy re-encryption upgrades it to v2.
3. Update isEnvelope guard to accept `v: 1 | 2` (type guard, no casts).

Files: `packages/ports/src/Encryption.ts`

Tests:
- FIRST (red): packages/ports/test/Encryption.test.ts — 'a v2 envelope whose kid field is rewritten to another known kid fails DecryptionFailed' (keyset with two kids sharing the same key bytes, so only AAD binding can catch it).
- 'a v1 envelope still decrypts and reports stale'.

Acceptance:
- Swapping kid/v in an envelope fails authentication even when the substituted key would otherwise decrypt.

Spec refs: — · Depends on: KRS-002

**Recommended status:** `ready-for-agent`

### Workstream `password-hasher-verify-hardening`

#### PHS-001 — Argon2 verify is not constant-time: hash-wasm argon2Verify compares with plain ===

`medium` · `security` · `ports` · [.issues/medium/PHS-001-password-hashing-specialist.md](../../.issues/medium/PHS-001-password-hashing-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

Verified directly in the installed hash-wasm: argon2Verify ends with a plain `===`. BEH-EA-114 prose claims a constant-time comparison.

**Evidence at HEAD:**

- `packages/ports/src/PasswordHasher.ts:175` — Own-format argon2 verify delegates both parameter parsing and digest comparison to hash-wasm.

```
      const verify: PasswordHasherShape["verify"] = (plain, phc) => {
        const match = legacy.find((verifier) => verifier.recognizes(phc));
        if (match !== undefined) return match.verify(plain, phc);
        return Effect.tryPromise(() =>
          argon2Verify({ password: Redacted.value(plain), hash: phc }),
        ).pipe(Effect.orElseSucceed(() => false));
```
- `node_modules/.pnpm/hash-wasm@4.12.0/node_modules/hash-wasm/dist/index.esm.js:822` — argon2Verify compares with plain ===; params come from getHashParameters(options.hash) (line 820), i.e. the stored string.

```
        const hashStart = options.hash.lastIndexOf("$") + 1;
        const result = (yield argon2Internal(params));
        return result.substring(hashStart) === options.hash.substring(hashStart);
```
- `packages/ports/src/PasswordHasher.ts:66` — The comment's assumption is false for hash-wasm 4.12.0.

```
 * Constant-time equality for two equal-length hex digests — `hash-wasm`'s
 * `scrypt` has no built-in verify (unlike `argon2Verify`, which is expected
 * to compare in constant time internally),
```

**Fix plan** (M): Stop delegating argon2 comparison to hash-wasm: parse, recompute, compare in constant time.

Steps:
1. Extend ARGON2ID_PARAMS to capture version, m, t, p, salt and hash; decode unpadded base64 (re-pad before Encoding.decodeBase64).
2. layerArgon2id.verify: recompute with `argon2id({ password, salt, iterations, parallelism, memorySize, hashLength: storedHash.length, outputType: 'binary' })` and compare with a byte-level constant-time helper (generalise timingSafeEqualHex → `timingSafeEqualBytes`); reject non-argon2id / v≠19 strings as false.
3. Fix the misleading comment at PasswordHasher.ts:65-72 and keep argon2Verify out of the verify path entirely.
4. Coordinate with ERS-001: the worker returns digest bytes, comparison stays here.

Files: `packages/ports/src/PasswordHasher.ts`

Tests:
- FIRST (red): packages/ports/test/PasswordHasher.test.ts — 'argon2id verify accepts a hash with a non-default hashLength (64 bytes) and rejects a one-bit-flipped digest' (proves own parse/compare path).
- Unit test for timingSafeEqualBytes (equal, unequal, different lengths).
- Existing needsRehash/verify tests stay green.

Acceptance:
- No argon2Verify call remains in PasswordHasher.ts.
- Argon2 digests are compared in constant time, matching BEH-EA-114's claim.

Spec refs: BEH-EA-114 · Depends on: —

**Recommended status:** `ready-for-agent`

#### PHS-002 — needsRehash uses strict equality, enabling silent downgrade of stronger hashes

`medium` · `security` · `ports` · [.issues/medium/PHS-002-password-hashing-specialist.md](../../.issues/medium/PHS-002-password-hashing-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

The downgrade path is real, and the header comment contradicts the code — but the code implements BEH-EA-116 as written. Changing to floor semantics is a spec change, so this needs a decision.

**Evidence at HEAD:**

- `packages/ports/src/PasswordHasher.ts:183` — Same equality at 293-300 for scrypt.

```
      const needsRehash: PasswordHasherShape["needsRehash"] = (phc) => {
        const params = parseArgon2idParams(phc);
        if (params === undefined) return true;
        return (
          params.memorySize !== memorySize ||
          params.iterations !== iterations ||
          params.parallelism !== parallelism
```
- `packages/ports/src/PasswordHasher.ts:33` — Header promises floor semantics.

```
// research/07-passwords-2fa.md's "two triggers: (a) a legacy algorithm,
// (b) parameters below the current configured floor"
```
- `spec/behaviors/15-password.md:72` — …but BEH-EA-116 normatively requires equality semantics.

```
REQUIREMENT: On a successful sign-in, if the stored hash's parameters differ
             from the currently configured `PasswordHasher` parameters, the
             password MUST be rehashed with current parameters
```

**Fix plan** (S): (Recommended option C) Add a rehash policy knob defaulting to floor semantics, amend BEH-EA-116, fix the header comment.

Steps:
1. Config `AUTH_PASSWORD_REHASH_POLICY` = 'floor' | 'exact' (Config.Literal, default 'floor').
2. floor: needsRehash true iff foreign/unparseable, or any cost parameter strictly below target (argon2: m or t; scrypt: N or r); p differences alone never trigger. exact: current behaviour (for operators who deliberately lower cost).
3. Amend BEH-EA-116 REQUIREMENT to 'below the configured floor' with 'exact' as explicit opt-in; update header comment lines 31-40 to match.
4. Apply to both layerArgon2id and layerScrypt.

Files: `packages/ports/src/PasswordHasher.ts`, `spec/behaviors/15-password.md`, `features/features/05-authentication-methods/15-password.feature`

Tests:
- FIRST (red): packages/ports/test/PasswordHasher.test.ts — 'under floor policy needsRehash is false for a hash stronger than the configured target'.
- 'under exact policy it is true'.
- packages/password/test/Password.test.ts — 'signIn does not rewrite a stronger stored hash after config is lowered (floor)'.

Acceptance:
- Lowering hasher config never silently downgrades stored hashes by default.
- Spec, header comment and code agree.

Spec refs: BEH-EA-116 · Depends on: —

**Needs decision** — see 'Decisions needed'. Recommendation: C — floor by default closes the silent-downgrade path, while 'exact' preserves the legitimate 'we over-tuned cost and must lower it' operation; both are one comparison each, so the richer option costs almost nothing.

**Recommended status:** `ready-for-human`

#### ACS-006 — Embedded KDF parameters honored without a ceiling when verifying scrypt hashes

`low` · `security` · `ports` · [.issues/low/ACS-006-applied-cryptography-specialist.md](../../.issues/low/ACS-006-applied-cryptography-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

Accurate hardening gap on both layers (scrypt parses its own params unclamped; argon2Verify honours the stored m/t/p). Canonical for PHS-007.

**Evidence at HEAD:**

- `packages/ports/src/PasswordHasher.ts:229` — parseScryptHash accepts any ln/r/p; no ceiling.

```
    costFactor: 2 ** Number(costLog2Str),
    blockSize: Number(blockSizeStr),
    parallelism: Number(parallelismStr),
```
- `packages/ports/src/PasswordHasher.ts:276` — Recompute uses parsed (stored) parameters, unclamped.

```
          const parsed = parseScryptHash(phc);
          if (parsed === undefined) return false;
          const digest = yield* Effect.promise(() =>
            scrypt({
              password: Redacted.value(plain),
              salt: parsed.salt,
              costFactor: parsed.costFactor,
              blockSize: parsed.blockSize,
```
- `node_modules/.pnpm/hash-wasm@4.12.0/node_modules/hash-wasm/dist/index.esm.js:822` — argon2Verify compares with plain ===; params come from getHashParameters(options.hash) (line 820), i.e. the stored string.

```
        const hashStart = options.hash.lastIndexOf("$") + 1;
        const result = (yield argon2Internal(params));
        return result.substring(hashStart) === options.hash.substring(hashStart);
```

**Fix plan** (S): Clamp stored-hash KDF parameters to configurable ceilings before any recomputation.

Steps:
1. Config ceilings (Config.Int with defaults): AUTH_ARGON2_MAX_MEMORY_KIB=262144, AUTH_ARGON2_MAX_ITERATIONS=16, AUTH_ARGON2_MAX_PARALLELISM=8, AUTH_SCRYPT_MAX_COST_LOG2=20, AUTH_SCRYPT_MAX_BLOCK_SIZE=32, AUTH_SCRYPT_MAX_PARALLELISM=16; each must be ≥ the configured target (die at layer build otherwise).
2. parseScryptHash / new argon2 parser (PHS-001): require integer params within [1, ceiling]; `ln` must be an integer ≤ ceiling (guards `2 ** ln` → Infinity); outside → undefined ⇒ verify false, needsRehash true — without running the KDF.
3. Document the ceilings in the module header.

Files: `packages/ports/src/PasswordHasher.ts`

Tests:
- FIRST (red): packages/ports/test/PasswordHasher.test.ts — 'scrypt verify of a $scrypt$ln=25,... hash returns false without running the KDF' (with a 2s vitest timeout — the unfixed code allocates ~4 GiB and hangs/throws).
- 'argon2 verify of an m=4194304 hash returns false immediately' (after PHS-001).
- 'layer build dies when a ceiling is below the configured target'.

Acceptance:
- A corrupted/malicious stored hash cannot force a KDF above the deployment's ceiling.

Spec refs: BEH-EA-114 · Depends on: PHS-001 · Absorbs: PHS-007

**Recommended status:** `ready-for-agent`

#### PHS-007 — Scrypt verify recomputes with stored-hash parameters and no upper bound on cost

`low` · `correctness` · `ports` · [.issues/low/PHS-007-password-hashing-specialist.md](../../.issues/low/PHS-007-password-hashing-specialist.md) · current: `needs-triage`

**Verdict:** DUPLICATE of **ACS-006** (confidence: high)

Same root cause and fix as ACS-006 (unclamped stored-hash parameters).

**Evidence at HEAD:**

- `packages/ports/src/PasswordHasher.ts:276` — Recompute uses parsed (stored) parameters, unclamped.

```
          const parsed = parseScryptHash(phc);
          if (parsed === undefined) return false;
          const digest = yield* Effect.promise(() =>
            scrypt({
              password: Redacted.value(plain),
              salt: parsed.salt,
              costFactor: parsed.costFactor,
              blockSize: parsed.blockSize,
```
- `packages/ports/src/PasswordHasher.ts:229` — parseScryptHash accepts any ln/r/p; no ceiling.

```
    costFactor: 2 ** Number(costLog2Str),
    blockSize: Number(blockSizeStr),
    parallelism: Number(parallelismStr),
```

**No fix of its own** — closed by the canonical issue's plan.

**Recommended status:** `resolved`

#### TSS-006 — Dummy-hash uniformity degrades under parameter migration: verify runs at the stored hash's cost, not the configured cost

`low` · `security` · `ports` · [.issues/low/TSS-006-timing-side-channel-specialist.md](../../.issues/low/TSS-006-timing-side-channel-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: medium)

Accurate. The channel has actually widened since the audit: LegacyPasswordVerifiers (commit 60947ff) adds bcrypt-cost verifies with no dummy equivalent.

**Evidence at HEAD:**

- `packages/ports/src/PasswordHasher.ts:276` — Recompute uses parsed (stored) parameters, unclamped.

```
          const parsed = parseScryptHash(phc);
          if (parsed === undefined) return false;
          const digest = yield* Effect.promise(() =>
            scrypt({
              password: Redacted.value(plain),
              salt: parsed.salt,
              costFactor: parsed.costFactor,
              blockSize: parsed.blockSize,
```
- `packages/password/src/Password.ts:665` — Dummy is minted at boot under current params; real verifies run at the stored hash's params (and now also at bcrypt cost via @awthaq/migrate-auth0).

```
      const dummyHash = Redacted.make(yield* hasher.hash(Redacted.make("awthaq/password/dummy")));
```
- `packages/password/src/Password.ts:48` — Legacy-cost rows are expected to exist during migrations.

```
  rehashOnLogin: true,
```

**Fix plan** (M): Add a calibrated minimum-duration floor to signIn's credential check and document the residual.

Steps:
1. PasswordConfig gains `signInTimingFloor: 'calibrated' | Duration | 'off'` (default 'calibrated').
2. At layer build, time the dummyHash verify with Clock; floor = 1.25 × measured.
3. Wrap signIn's (and changePassword/deleteAccount's dummy-verify paths at Password.ts:~1109/~1166) lookup+verify so both success and InvalidCredentials complete no sooner than the floor (sleep the remainder via Clock).
4. BEH-EA-114 prose: document that hashes costlier than the floor (e.g. high-cost legacy bcrypt) remain distinguishable until rehashed.

Files: `packages/password/src/Password.ts`, `spec/behaviors/15-password.md`

Tests:
- FIRST (red): packages/password/test/Password.test.ts — with a fake PasswordHasher whose verify sleeps 5ms for a 'legacy' hash and 50ms for the dummy, under TestClock: 'signIn for a legacy-hash account takes no less time than for an unknown email'.
- 'signInTimingFloor: off restores current behaviour'.

Acceptance:
- Unknown-user and legacy-hash sign-ins are indistinguishable by latency below the floor.

Spec refs: BEH-EA-114 · Depends on: —

**Recommended status:** `ready-for-agent`

### Workstream `password-hasher-offload`

#### ERS-001 — argon2id/scrypt hashing blocks the main JS thread with no worker-pool offload

`high` · `performance` · `ports` · [.issues/high/ERS-001-effect-runtime-scheduler-specialist.md](../../.issues/high/ERS-001-effect-runtime-scheduler-specialist.md) · current: `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high)

Unchanged at HEAD (the git-log hit c648000 is a substring match on PERS-001, unrelated). Decision 35 fixes it: always-on Semaphore on the main-thread layers + opt-in Node worker-pool layers. Canonical for ACS-001, ECF-004, PHS-003.

**Evidence at HEAD:**

- `packages/ports/src/PasswordHasher.ts:159` — Bare Effect.promise around synchronous WASM; no Semaphore/Worker anywhere in packages/ports/src or packages/password/src (grep).

```
      const hash: PasswordHasherShape["hash"] = (plain) =>
        Effect.gen(function* () {
          const salt = yield* crypto.randomBytes(SALT_LENGTH);
          return yield* Effect.promise(() =>
            argon2id({
              password: Redacted.value(plain),
```
- `packages/ports/package.json:27` — No worker/pool; @effect/platform-node is a devDependency only.

```
  "dependencies": {
    "@simplewebauthn/server": "^14.0.1",
    "effect": "catalog:",
    "hash-wasm": "catalog:"
  },
```

**Fix plan** (L): Bound hashing concurrency on the WASM layers and add opt-in Node worker-pool PasswordHasher layers (decision 35).

Steps:
1. PasswordHasher.ts layerArgon2id/layerScrypt: `AUTH_PASSWORD_HASH_CONCURRENCY` (Config.Int, default 4) → `Semaphore.make(n)` per layer instance; wrap `hash` and `verify` (including the legacy-verifier dispatch — bcrypt is CPU work too) with `withPermits(1)`; not needsRehash.
2. New packages/ports/src/PasswordHasherWorkerPool.ts: `layerArgon2idNodeWorkerPool`/`layerScryptNodeWorkerPool` producing the same PasswordHasher, requiring `Worker.WorkerPlatform | Worker.Spawner` (effect/unstable/workers/Worker) — the app provides `NodeWorker.layer(spawn)`; internal `Pool.make({ acquire, size: AUTH_PASSWORD_HASH_WORKER_POOL_SIZE (default 4) })`; no extra semaphore.
3. New packages/ports/src/passwordHasherWorker.ts (worker entry, not exported from index): handles `{ id, op, ...params }` → derived digest; constant-time comparison stays on the main thread (coordinate with PHS-001: worker returns raw digest bytes).
4. Document per-hash latency/memory next to the AUTH_ARGON2_*/AUTH_SCRYPT_* knobs and the two new knobs (module header + packages/ports README + README.md Configuration table).

Files: `packages/ports/src/PasswordHasher.ts`, `packages/ports/src/PasswordHasherWorkerPool.ts (new)`, `packages/ports/src/passwordHasherWorker.ts (new)`, `packages/ports/src/index.ts`, `README.md`, `knip.json (worker entry)`

Tests:
- FIRST (red): packages/ports/test/PasswordHasher.test.ts — 'with AUTH_PASSWORD_HASH_CONCURRENCY=1 at most one verify runs at a time' (install a LegacyPasswordVerifier whose verify increments an in-flight counter and awaits a Deferred; fork 3 verifies; assert max in-flight === 1).
- packages/ports/test/PasswordHasherWorkerPool.test.ts — using @effect/platform-node NodeWorker: 'a hash produced in the worker pool verifies on the main-thread layer and vice versa'.

Acceptance:
- No unbounded concurrent KDF work on the main thread.
- Node deployments can offload hashing with one Layer swap.
- Edge-compatible default layers unchanged in type.

Spec refs: BEH-EA-115, BEH-EA-020 · Depends on: — · Absorbs: ACS-001, ECF-004, PHS-003

**Recommended status:** `ready-for-agent`

#### ACS-001 — Password KDF executes synchronously on the main event loop

`medium` · `performance` · `ports` · [.issues/medium/ACS-001-applied-cryptography-specialist.md](../../.issues/medium/ACS-001-applied-cryptography-specialist.md) · current: `needs-triage`

**Verdict:** DUPLICATE of **ERS-001** (confidence: high)

Same root cause as ERS-001 (synchronous WASM KDF on the event loop, no bound, no offload); decision 35's plan closes it.

**Evidence at HEAD:**

- `packages/ports/src/PasswordHasher.ts:159` — Bare Effect.promise around synchronous WASM; no Semaphore/Worker anywhere in packages/ports/src or packages/password/src (grep).

```
      const hash: PasswordHasherShape["hash"] = (plain) =>
        Effect.gen(function* () {
          const salt = yield* crypto.randomBytes(SALT_LENGTH);
          return yield* Effect.promise(() =>
            argon2id({
              password: Redacted.value(plain),
```

**No fix of its own** — closed by the canonical issue's plan.

**Recommended status:** `resolved`

#### ECF-004 — argon2id/scrypt hashing runs as main-thread WASM, serializing the cooperative scheduler

`medium` · `performance` · `ports` · [.issues/medium/ECF-004-effect-concurrency-fiber-specialist.md](../../.issues/medium/ECF-004-effect-concurrency-fiber-specialist.md) · current: `needs-triage`

**Verdict:** DUPLICATE of **ERS-001** (confidence: high)

Same root cause as ERS-001 (synchronous WASM KDF on the event loop, no bound, no offload); decision 35's plan closes it.

**Evidence at HEAD:**

- `packages/ports/src/PasswordHasher.ts:159` — Bare Effect.promise around synchronous WASM; no Semaphore/Worker anywhere in packages/ports/src or packages/password/src (grep).

```
      const hash: PasswordHasherShape["hash"] = (plain) =>
        Effect.gen(function* () {
          const salt = yield* crypto.randomBytes(SALT_LENGTH);
          return yield* Effect.promise(() =>
            argon2id({
              password: Redacted.value(plain),
```

**No fix of its own** — closed by the canonical issue's plan.

**Recommended status:** `resolved`

#### PHS-003 — CPU-bound WASM hashing runs on the main thread with no concurrency bound

`medium` · `performance` · `ports` · [.issues/medium/PHS-003-password-hashing-specialist.md](../../.issues/medium/PHS-003-password-hashing-specialist.md) · current: `needs-triage`

**Verdict:** DUPLICATE of **ERS-001** (confidence: high)

Same root cause as ERS-001 (synchronous WASM KDF on the event loop, no bound, no offload); decision 35's plan closes it.

**Evidence at HEAD:**

- `packages/ports/src/PasswordHasher.ts:159` — Bare Effect.promise around synchronous WASM; no Semaphore/Worker anywhere in packages/ports/src or packages/password/src (grep).

```
      const hash: PasswordHasherShape["hash"] = (plain) =>
        Effect.gen(function* () {
          const salt = yield* crypto.randomBytes(SALT_LENGTH);
          return yield* Effect.promise(() =>
            argon2id({
              password: Redacted.value(plain),
```

**No fix of its own** — closed by the canonical issue's plan.

**Recommended status:** `resolved`

#### ERAS-004 — WASM argon2id is edge-compatible but default cost exceeds Workers free-tier CPU budgets

`low` · `performance` · `ports` · [.issues/low/ERAS-004-edge-runtime-auth-specialist.md](../../.issues/low/ERAS-004-edge-runtime-auth-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

Doc gap confirmed; no code change needed (decision 35 keeps the WASM layers as the edge-compatible default).

**Evidence at HEAD:**

- `packages/ports/src/PasswordHasher.ts:24`

```
// own words: "hash-wasm v4.12.0 (MIT, zero-dep pure WASM, runs in
// browsers/Node/Deno/Web Workers) brings argon2id to edge runtimes" — the
```
- `README.md:153` — README promotes Workers deployment; nothing warns about per-verify CPU cost vs. Workers CPU limits.

```
// 7. `HttpRouter.serve` is the same real serving path `AuthHttp.ts`'s own
//    header comment documents alongside `HttpRouter.toWebHandler` (used
//    instead in tests, and in any Fetch-native runtime — Bun, Deno,
//    Cloudflare Workers — since it returns a portable `(Request) =>
```

**Fix plan** (S): Document where password hashing should run.

Steps:
1. PasswordHasher.ts header + packages/ports README + README.md near line 153: password hash/verify belongs on the origin (long-running) runtime; default argon2id m=19456,t=2 costs tens of ms CPU per verify, above Cloudflare Workers' free-tier CPU budget; the edge tier should do session/JWT verification and redirects. State that no cheaper 'edge storage profile' is offered on purpose.

Files: `packages/ports/src/PasswordHasher.ts`, `packages/ports/README.md`, `README.md`

Tests:
- Doc-only.

Acceptance:
- Edge deployment guidance is explicit next to the hasher config.

Spec refs: BEH-EA-115 · Depends on: ERS-001

**Recommended status:** `ready-for-agent`

### Workstream `webauthn-user-presence`

#### BPAS-004 — User-presence (UP) flag can never be enforced: port hard-codes requireUserPresence:false and hides the flag

`medium` · `security` · `ports` · [.issues/medium/BPAS-004-biometric-platform-authenticator-specialist.md](../../.issues/medium/BPAS-004-biometric-platform-authenticator-specialist.md) · current: `needs-triage`

**Verdict:** DUPLICATE of **CB-002** (confidence: high)

Same root cause as CB-002 (partially accurate the same way: authentication UP is enforced by the library; registration is not).

**Evidence at HEAD:**

- `packages/ports/src/WebAuthn.ts:204` — Every registration (ordinary and conditional) skips SimpleWebAuthn's UP check.

```
    verifyRegistration: (input) =>
      Effect.tryPromise({
        try: () =>
          verifyRegistrationResponse({
            ...
            requireUserPresence: false,
            requireUserVerification: false,
```
- `node_modules/.pnpm/@simplewebauthn+server@14.0.1/node_modules/@simplewebauthn/server/esm/authentication/verifyAuthenticationResponse.js:174` — Runs whenever advancedFIDOConfig is undefined — the port never passes it (WebAuthn.ts:254-271), so authentication UP IS enforced by the library.

```
        // WebAuthn only requires the user presence flag be true
        if (!flags.up) {
            throw new Error('User not present during authentication');
        }
```

**No fix of its own** — closed by the canonical issue's plan.

**Recommended status:** `resolved`

#### CB-002 — User-presence (UP) flag is never enforced in any ceremony

`medium` · `security` · `ports` · [.issues/medium/CB-002-christiaan-brand.md](../../.issues/medium/CB-002-christiaan-brand.md) · current: `needs-triage`

**Verdict:** PARTIAL (confidence: high)

Registration half CONFIRMED (UP never checked for ordinary registrations). Authentication half INVALID: SimpleWebAuthn 14.0.1 enforces flags.up whenever advancedFIDOConfig is absent, and the port never passes it. Canonical for BPAS-004.

**Evidence at HEAD:**

- `packages/ports/src/WebAuthn.ts:204` — Every registration (ordinary and conditional) skips SimpleWebAuthn's UP check.

```
    verifyRegistration: (input) =>
      Effect.tryPromise({
        try: () =>
          verifyRegistrationResponse({
            ...
            requireUserPresence: false,
            requireUserVerification: false,
```
- `node_modules/.pnpm/@simplewebauthn+server@14.0.1/node_modules/@simplewebauthn/server/esm/authentication/verifyAuthenticationResponse.js:174` — Runs whenever advancedFIDOConfig is undefined — the port never passes it (WebAuthn.ts:254-271), so authentication UP IS enforced by the library.

```
        // WebAuthn only requires the user presence flag be true
        if (!flags.up) {
            throw new Error('User not present during authentication');
        }
```
- `packages/passkey/src/Passkey.ts:662` — The plugin knows which scope was consumed but never checks UP.

```
          let enforceUserVerification =
            consumedOrdinary && config.authenticatorSelection.userVerification === "required";
          if (!consumedOrdinary) {
            const consumedConditional = yield* challengeStore.consume(
```

**Fix plan** (M): Enforce UP on ordinary registrations by letting the plugin choose requireUserPresence per ceremony; surface userPresent.

Steps:
1. WebAuthn.ts: `VerifyRegistrationInput.requireUserPresence: boolean` (required — each call site must choose); pass it through instead of the hard-coded `false` (line 212); update header comment lines 12-21.
2. Surface `userPresent: boolean` on VerifiedRegistration/VerifiedAuthentication by parsing authData flags with @simplewebauthn/server/helpers (`decodeAttestationObject(...).get('authData')` → `parseAuthenticatorData(...).flags.up`; for assertions `parseAuthenticatorData(isoBase64URL.toBuffer(response.response.authenticatorData))`).
3. Passkey.ts registerVerify (~674): pass `requireUserPresence: consumedOrdinary` (ordinary → true, conditional-create scope → false).
4. Add a regression test pinning the library's authentication-side UP enforcement (guards a future advancedFIDOConfig/library change).

Files: `packages/ports/src/WebAuthn.ts`, `packages/passkey/src/Passkey.ts`, `packages/ports/test/webauthnFixtures.ts`, `spec/behaviors/17-passkey.md`, `features/features/05-authentication-methods/17-passkey.feature`

Tests:
- FIRST (red): packages/passkey/test/Passkey.test.ts — 'ordinary registerVerify rejects a UP=0 response with PasskeyVerificationFailed' (fixture helper clearing the UP bit in a 'none'-attestation authData).
- Existing 'registerOptionsConditional's own challenge completes register/verify with UP=0/UV=0 accepted' (Passkey.test.ts:471) stays green.
- packages/ports/test/WebAuthn.test.ts — 'verifyAuthentication rejects a UP=0 assertion' and 'userPresent is surfaced'.

Acceptance:
- UP=0 is accepted only for challenges from the conditional-create scope.

Spec refs: BEH-EA-130, BEH-EA-131, BEH-EA-129 · Depends on: — · Absorbs: BPAS-004

**Recommended status:** `ready-for-agent`

### Workstream `ratelimit-distributed-store`

#### AR-005 — Rate limiting is per-process and identity-keyed only; the quickstart ships it disabled

`medium` · `architecture` · `ports` · [.issues/medium/AR-005-aeneas-rekkas.md](../../.issues/medium/AR-005-aeneas-rekkas.md) · current: `needs-triage`

**Verdict:** PARTIAL (partially fixed by `349e220`) (confidence: high)

Three claims: (1) email-only keys / no client IP — FIXED by a3b7255 + 349e220; (2) per-process store — still true (RBS-004); (3) quickstart ships layerPermissive — still true (NHS-005). No work beyond those two issues.

**Evidence at HEAD:**

- `README.md:216` — Quickstart composition at README.md:139 wires `RateLimiter.layerPermissive`.

```
| `RateLimiter` | `layerPermissive` (no real limiting) | `layer` over `layerStoreMemory`, or your own `RateLimiterStore` |
```
- `packages/password/src/Password.ts:593` — IP dimension now exists: ClientAddress port (a3b7255) + per-IP password rules (349e220); the quoted 'no client-IP-extraction mechanism' comment is gone.

```
              key: (input) => `password:signin:ip:${ipFromRateLimitInput(input)}`,
```

**Fix plan** (S): Close when RBS-004 and NHS-005 land; no additional code.

Steps:
1. Verify after RBS-004 + NHS-005 merge; add nothing else.

Files: —

Tests:
- Covered by RBS-004/NHS-005 tests.

Acceptance:
- Quickstart uses a shared, enforcing store.

Spec refs: BEH-EA-108, BEH-EA-109 · Depends on: RBS-004, NHS-005

**Recommended status:** `ready-for-agent`

#### CSD-007 — Only in-process rate-limit store ships — multi-replica deployments multiply every limit by node count

`medium` · `security` · `ports` · [.issues/medium/CSD-007-credential-stuffing-defense-specialist.md](../../.issues/medium/CSD-007-credential-stuffing-defense-specialist.md) · current: `needs-triage`

**Verdict:** DUPLICATE of **RBS-004** (confidence: high)

Same root cause as RBS-004 (only an in-process store exists); RBS-004 ships the SQL store.

**Evidence at HEAD:**

- `packages/ports/src/RateLimiter.ts:26` — `grep -rn RateLimiterStore packages/*/src` finds no implementation outside RateLimiter.ts; no layerStoreRedis*/layerStoreSql anywhere.

```
// not to a store: `layerStoreMemory` is a plain in-process `Ref` and cannot
// itself become unreachable, so there is no outage for it to fail open
// against today. A store that legitimately can go unreachable (Redis, a SQL
// pool) is a documented future `RateLimiterStore` implementation
```
- `features/features/04-cross-cutting/14-rate-limiting.feature:155` — Named in BDD, exists nowhere.

```
      And a second "Layer.provide" then supplies "RateLimiter.layerStoreRedisConfig(...)"
```

**No fix of its own** — closed by the canonical issue's plan.

**Recommended status:** `resolved`

#### NHS-005 — Canonical quickstart wires a no-op rate limiter while the contract advertises 429s

`medium` · `dx` · `ports` · [.issues/medium/NHS-005-node-http-server-integration-specialist.md](../../.issues/medium/NHS-005-node-http-server-integration-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

Confirmed: the canonical quickstart ships limiting disabled while PasswordApi advertises 429s.

**Evidence at HEAD:**

- `README.md:216` — Quickstart composition at README.md:139 wires `RateLimiter.layerPermissive`.

```
| `RateLimiter` | `layerPermissive` (no real limiting) | `layer` over `layerStoreMemory`, or your own `RateLimiterStore` |
```
- `README.md:139`

```
    Layer.mergeAll(PasswordHasher.layerArgon2id, consoleMailer, RateLimiter.layerPermissive).pipe(
```
- `packages/ports/src/RateLimiter.ts:136`

```
export const layerPermissive: Layer.Layer<RateLimiter> = Layer.succeed(
  RateLimiter,
  RateLimiter.of({ consume: () => Effect.void }),
);
```

**Fix plan** (S): Make the quickstart enforce limits and flag the permissive layer.

Steps:
1. README.md:139 → `RateLimiter.layer.pipe(Layer.provide(RateLimiterStoreSql.layerStoreSql))` (the quickstart already has Postgres) — or layerStoreMemory with a 'single instance only' comment if RBS-004 lands later; update the Configuration table row (README.md:216).
2. layerPermissive JSDoc: 'tests only — never in production'.
3. BE-003 doctor check flags layerPermissive in a production awthaq.config.ts (BEH-EA-201).

Files: `README.md`, `packages/ports/src/RateLimiter.ts`

Tests:
- scripts/package-smoke.mjs / README snippet typecheck if available; otherwise doc-only.
- Doctor test in BE-003 sub-ticket D.

Acceptance:
- README's real default enforces the registered RATE_LIMITS rules.

Spec refs: BEH-EA-112, BEH-EA-201 · Depends on: RBS-003, RBS-004

**Recommended status:** `ready-for-agent`

#### RBS-004 — Store contract cannot express an outage: no error channel, no fail-open path, no distributed store exists

`medium` · `architecture` · `ports` · [.issues/medium/RBS-004-rate-limiting-brute-force-specialist.md](../../.issues/medium/RBS-004-rate-limiting-brute-force-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

Confirmed; also canonical for CSD-007 (no shared store). A SQL store is justified now (Postgres + SQLite drivers are real, ADR-EA-016 rev 1.2); a Redis store would be speculative (no Redis dependency) and is not planned.

**Evidence at HEAD:**

- `packages/ports/src/RateLimiter.ts:72` — E = never: a networked store cannot report an outage; `layer` (lines 86-103) has no fail-open branch.

```
  readonly increment: (key: string, window: Duration.Input) => Effect.Effect<Bucket>;
```
- `packages/ports/src/RateLimiter.ts:26` — `grep -rn RateLimiterStore packages/*/src` finds no implementation outside RateLimiter.ts; no layerStoreRedis*/layerStoreSql anywhere.

```
// not to a store: `layerStoreMemory` is a plain in-process `Ref` and cannot
// itself become unreachable, so there is no outage for it to fail open
// against today. A store that legitimately can go unreachable (Redis, a SQL
// pool) is a documented future `RateLimiterStore` implementation
```
- `spec/behaviors/14-rate-limiting.md:43` — Spec-mandated behaviour with no implementation path.

```
`RateLimiter.layer`'s default posture in that case is **fail-open**: `consume` succeeds (the request proceeds unthrottled)
```

**Fix plan** (L): Give the store an error channel, implement BEH-EA-105's fail-open default, and ship a SQL-backed store.

Steps:
1. RateLimiter.ts: `RateLimiterStoreUnavailable` TaggedError; `increment: (key, window) => Effect.Effect<Bucket, RateLimiterStoreUnavailable>`.
2. `RateLimiterConfig` Context.Reference `{ onStoreUnavailable: 'allow' | 'reject' }` (default 'allow'); `layer` catches: allow → Effect.logWarning + succeed; reject → RateLimited with a short retryAfterMillis. consume's error type unchanged.
3. packages/sql/src/RateLimiterStoreSql.ts: `layerStoreSql` over SqlClient — single atomic upsert: `INSERT INTO rate_limit_buckets(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN rate_limit_buckets.reset_at > ? THEN rate_limit_buckets.count + 1 ELSE 1 END, reset_at = CASE WHEN rate_limit_buckets.reset_at > ? THEN rate_limit_buckets.reset_at ELSE excluded.reset_at END RETURNING count, reset_at` (SQLite ≥3.35 and Postgres); SqlError → RateLimiterStoreUnavailable; opportunistic `DELETE … WHERE reset_at < now` sweep.
4. Migration: export `RateLimiterStoreSql.migrations` (Migrator loader) apps add alongside CoreMigrations when they use the SQL store.
5. spec/behaviors/14-rate-limiting.md BEH-EA-109 example: show layerStoreSql as the shipped multi-instance store; keep Redis as an illustrative bring-your-own.

Files: `packages/ports/src/RateLimiter.ts`, `packages/sql/src/RateLimiterStoreSql.ts (new)`, `packages/sql/src/index.ts`, `spec/behaviors/14-rate-limiting.md`, `features/features/04-cross-cutting/14-rate-limiting.feature`

Tests:
- FIRST (red): packages/ports/test/RateLimiter.test.ts — 'consume fails open and logs when the store fails RateLimiterStoreUnavailable'; 'reject policy fails RateLimited'.
- packages/sql/test/RateLimiterStoreSql.test.ts (+ Postgres variant following Repositories.postgres.test.ts) — '20 concurrent increments return counts 1..20', 'window rollover resets count to 1 (TestClock)'.
- BDD 14-rate-limiting BEH-EA-105/109 scenarios.

Acceptance:
- A store outage cannot 5xx the app by default.
- Multi-replica deployments can share limits through the database they already run.

Spec refs: BEH-EA-105, BEH-EA-109 · Depends on: RBS-003 · Absorbs: CSD-007

**Recommended status:** `ready-for-agent`

### Workstream `legacy-password-migration`

#### FAMS-001 — No Firebase scrypt-variant password verification path; lazy rehash is impossible

`high` · `architecture` · `ports` · [.issues/high/FAMS-001-firebase-auth-migration-specialist.md](../../.issues/high/FAMS-001-firebase-auth-migration-specialist.md) · current: `ready-for-agent`

**Verdict:** PARTIAL (partially fixed by `60947ff`) (confidence: high)

Port half fixed by 60947ff (LegacyPasswordVerifiers, the extension point decision 21 specifies). Still missing: the @awthaq/migrate-firebase package with the firebase-scrypt verifier — imported Firebase hashes still cannot verify.

**Evidence at HEAD:**

- `packages/ports/src/PasswordHasher.ts:42` — The quoted 'Known non-goal' comment no longer exists; replaced by the LegacyPasswordVerifiers port (commit 60947ff).

```
// AOMS-001/FAMS-001 (.scratch/resolve-ready-for-human-findings, ticket 21):
// `LegacyPasswordVerifiers` below closes the "Known non-goal" this comment
// used to describe in full — an IdP-migration import (Auth0's bcrypt,
// Firebase's modified scrypt, …) lands a foreign hash format in
// `credentialHash` that neither shipped layer's own `verify` can parse.
```
- `packages/ports/src/PasswordHasher.ts:114`

```
export const LegacyPasswordVerifiers: Context.Reference<
  ReadonlyArray<LegacyPasswordVerifierShape>
> = Context.Reference("awthaq/ports/LegacyPasswordVerifiers", {
  defaultValue: (): ReadonlyArray<LegacyPasswordVerifierShape> => [],
});
```
- `packages/ports/src/PasswordHasher.ts:100` — Only mention of firebase anywhere under packages/*/src; no packages/migrate-firebase exists (ls packages).

```
  /** e.g. "bcrypt", "firebase-scrypt" — observability only. */
```

**Fix plan** (L): Ship @awthaq/migrate-firebase with a firebase-scrypt LegacyPasswordVerifier (decision 21).

Steps:
1. Scaffold packages/migrate-firebase (package.json, tsconfig.json/src/test, vitest.config.ts; add to tsconfig.base.json paths, root tsconfig references, knip).
2. src/FirebaseScryptVerifier.ts: `recognizes: /^\$firebase-scrypt\$/`; parse `$firebase-scrypt$k=<signerKeyB64>,ss=<saltSepB64>,r=<rounds>,mc=<memCost>$<saltB64>$<hashB64>` with clamps (mc ≤ 17, r ≤ 16) in the ACS-006 style; algorithm: derivedKey = scrypt(password, salt ‖ saltSeparator, N=2^mc, r=rounds, p=1, dkLen=32) (hash-wasm), then AES-256-CTR(key=derivedKey, iv=0) over the signer key (WebCrypto), compare with the stored hash in constant time. Prefer an audited implementation (evaluate the `firebase-scrypt` npm package; if it needs node:crypto only, acceptable — this path is off the hot path) else port faithfully from github.com/firebase/scrypt; no hand-invented crypto.
3. src/index.ts exports FirebaseScryptVerifier (`layer` = Layer.succeed(LegacyPasswordVerifiers, [firebaseScryptVerifier])) — note: provide a helper to merge with other verifiers since Layer.succeed on the Reference replaces (document composing with @awthaq/migrate-auth0).
4. README recipe (hash_config → tag encoding), log verifier id on match (decision 21's telemetry note).

Files: `packages/migrate-firebase/** (new)`, `tsconfig.base.json`, `tsconfig.json`, `tsconfig.test.json`, `knip.json`

Tests:
- FIRST (red): packages/migrate-firebase/test/FirebaseScryptVerifier.test.ts — 'verifies the published firebase/scrypt README test vector' (password/salt/signer key/salt separator/rounds=8/mem_cost=14 → expected hash).
- 'wrong password → false'; 'out-of-envelope mem_cost → false without running scrypt'.
- End-to-end: 'layerArgon2id + firebase verifier: legacy hash verifies, needsRehash true, argon2id format unaffected' (mirror packages/migrate-auth0/test).

Acceptance:
- Firebase-exported password users sign in without reset and are rehashed on first login.

Spec refs: BEH-EA-116, BEH-EA-115 · Depends on: —

**Recommended status:** `ready-for-agent`

#### SAM-001 — No bcrypt verification: migrated GoTrue password users are uniformly InvalidCredentials

`high` · `api` · `ports` · [.issues/high/SAM-001-supabase-auth-migration-specialist.md](../../.issues/high/SAM-001-supabase-auth-migration-specialist.md) · current: `ready-for-agent`

**Verdict:** PARTIAL (partially fixed by `60947ff`) (confidence: high)

The hard blocker (no bcrypt verification) is fixed by 60947ff for any $2a$/$2b$/$2y$ hash. What remains is discoverability: the only bcrypt verifier is Auth0-branded and nothing documents or tests the GoTrue path.

**Evidence at HEAD:**

- `packages/ports/src/PasswordHasher.ts:42` — The quoted 'Known non-goal' comment no longer exists; replaced by the LegacyPasswordVerifiers port (commit 60947ff).

```
// AOMS-001/FAMS-001 (.scratch/resolve-ready-for-human-findings, ticket 21):
// `LegacyPasswordVerifiers` below closes the "Known non-goal" this comment
// used to describe in full — an IdP-migration import (Auth0's bcrypt,
// Firebase's modified scrypt, …) lands a foreign hash format in
// `credentialHash` that neither shipped layer's own `verify` can parse.
```
- `packages/migrate-auth0/src/BcryptVerifier.ts:28` — GoTrue's $2a$ bcrypt now verifies when @awthaq/migrate-auth0's layer is installed (commit 60947ff).

```
const BCRYPT_TAG = /^\$2[aby]\$\d{2}\$/;

export const bcryptVerifier: PasswordHasher.LegacyPasswordVerifierShape = {
  id: "bcrypt",
  recognizes: (phc) => BCRYPT_TAG.test(phc),
  verify: (plain, phc) =>
    Effect.tryPromise(() => bcrypt.compare(Redacted.value(plain), phc)).pipe(
```
- `packages/migrate-auth0/src/index.ts:1` — `grep -rni 'supabase\|gotrue' packages spec README.md` → nothing: a Supabase adopter has no pointer to this verifier.

```
// @awthaq/migrate-auth0
```

**Fix plan** (S): Document and pin the Supabase/GoTrue bcrypt path on top of the existing verifier.

Steps:
1. packages/migrate-auth0/README.md: 'Other bcrypt sources' section — Supabase GoTrue `auth.users.encrypted_password` ($2a$10$…) imports byte-for-byte; install BcryptVerifier.layer; map email_confirmed_at → verifyEmail.
2. Root README plugin/migration table: list bcrypt sources (Auth0, Supabase) under @awthaq/migrate-auth0.

Files: `packages/migrate-auth0/README.md`, `README.md`

Tests:
- FIRST (red): packages/migrate-auth0/test/BcryptVerifier.test.ts — 'a GoTrue-style $2a$10$ hash verifies through layerArgon2id + BcryptVerifier.layer and needsRehash is true' (derive via bcryptjs then rewrite the $2b$ prefix to $2a$, which is algorithm-identical).

Acceptance:
- A Supabase migrator can find and use the bcrypt verifier from the docs; the $2a$ path is covered by a test.

Spec refs: BEH-EA-116 · Depends on: —

**Recommended status:** `ready-for-agent`

#### BAM-004 — Password digest import requires manual re-serialization; dual-format verify is a declared non-goal

`medium` · `dx` · `ports` · [.issues/medium/BAM-004-better-auth-migration-specialist.md](../../.issues/medium/BAM-004-better-auth-migration-specialist.md) · current: `needs-triage`

**Verdict:** PARTIAL (partially fixed by `60947ff`) (confidence: medium)

'Dual-format verify is a declared non-goal' is fixed (LegacyPasswordVerifiers, 60947ff). Still missing: any better-auth scrypt verifier/recipe; the re-serialization route the issue suggests is impossible because layerScrypt fixes hashLength=32.

**Evidence at HEAD:**

- `packages/ports/src/PasswordHasher.ts:42` — The quoted 'Known non-goal' comment no longer exists; replaced by the LegacyPasswordVerifiers port (commit 60947ff).

```
// AOMS-001/FAMS-001 (.scratch/resolve-ready-for-human-findings, ticket 21):
// `LegacyPasswordVerifiers` below closes the "Known non-goal" this comment
// used to describe in full — an IdP-migration import (Auth0's bcrypt,
// Firebase's modified scrypt, …) lands a foreign hash format in
// `credentialHash` that neither shipped layer's own `verify` can parse.
```
- `packages/migrate-better-auth/src/index.ts:10` — No password verifier or re-serialization helper in the better-auth migration package.

```
export * as AliasLegacyCookieMiddleware from "./AliasLegacyCookieMiddleware.ts";
export * as LegacySessionBridgeLive from "./LegacySessionBridgeLive.ts";
```
- `packages/ports/src/PasswordHasher.ts:63` — layerScrypt's fixed 32-byte output means better-auth's 64-byte scrypt keys cannot be re-serialized into $scrypt$ form — a verifier is required.

```
const HASH_LENGTH = 32;
```

**Fix plan** (M): Add a better-auth scrypt LegacyPasswordVerifier to @awthaq/migrate-better-auth.

Steps:
1. src/BetterAuthScryptVerifier.ts: `recognizes: /^[0-9a-f]{32}:[0-9a-f]{128}$/` (better-auth `${saltHex}:${keyHex}`); verify = scrypt(NFKC(password), salt, N=16384, r=16, p=1, dkLen=64) via hash-wasm, constant-time compare. Confirm salt encoding (hex string used as UTF-8 bytes) and params against better-auth's crypto/password.ts and a real export fixture before coding.
2. Export `layer`; README recipe: import credentialHash verbatim, rehashOnLogin upgrades to argon2id.
3. Note in README how to combine with other LegacyPasswordVerifiers (single Reference).

Files: `packages/migrate-better-auth/src/BetterAuthScryptVerifier.ts (new)`, `packages/migrate-better-auth/src/index.ts`, `packages/migrate-better-auth/README.md`

Tests:
- FIRST (red): packages/migrate-better-auth/test/BetterAuthScryptVerifier.test.ts — 'verifies a hash produced by better-auth's hashPassword for a known password' (fixture string from a real better-auth install).
- 'does not recognize argon2id/scrypt/bcrypt strings'; end-to-end rehash test as in migrate-auth0.

Acceptance:
- better-auth users sign in after import without a password reset.

Spec refs: BEH-EA-116 · Depends on: —

**Recommended status:** `ready-for-agent`

### Workstream `ratelimit-signal-and-escalation`

#### EOTS-007 — Rate-limit breaches emit no event, log, or metric

`medium` · `security` · `ports` · [.issues/medium/EOTS-007-effect-observability-tracing-specialist.md](../../.issues/medium/EOTS-007-effect-observability-tracing-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

Confirmed: a breach produces only the typed failure.

**Evidence at HEAD:**

- `packages/ports/src/RateLimiter.ts:45`

```
export class RateLimited extends Data.TaggedError("RateLimited")<{
  readonly key: string;
  readonly retryAfterMillis: number;
}> {}
```
- `packages/core/src/AuthEvents.ts:26` — `grep -in rate packages/core/src/AuthEvents.ts` → no rate-limit event; no Metric usage anywhere in packages/*/src.

```
  readonly _tag: "auth.token.replay";
...
  readonly _tag: "auth.organization.teamMemberRemoved";
```

**Fix plan** (M): Emit an auth.rateLimit.exceeded event, a warning log and a counter on every breach, via one shared helper.

Steps:
1. core RateLimits.ts: `RateLimits.enforce({ key, rule, meta: { group, endpoint, rule: string, dimension: 'email'|'ip'|'identifier'|'custom' } })` → consume; on RateLimitExceeded: publish AuthEvent `auth.rateLimit.exceeded` (group/endpoint/rule/dimension/retryAfterMillis — never the raw key, BEH-EA-108), `Effect.logWarning` annotated, increment `Metric.counter('awthaq.ratelimit.exceeded')` tagged by rule; map to Api.RateLimited.
2. Replace Password.ts's local `rateLimit` helper (~675-686) and OAuth.ts's mapping (~619) with RateLimits.enforce.
3. Add the event to AuthEvents union + spec/behaviors/13-events.md event list.

Files: `packages/core/src/RateLimits.ts`, `packages/core/src/AuthEvents.ts`, `packages/password/src/Password.ts`, `packages/oauth/src/OAuth.ts`, `spec/behaviors/13-events.md`

Tests:
- FIRST (red): packages/password/test/Password.test.ts — 'exceeding the signIn limit publishes auth.rateLimit.exceeded whose payload does not contain the email'.
- packages/core/test/RateLimits.test.ts — 'enforce increments the exceeded counter'.

Acceptance:
- Every breach is observable via event, log and metric without leaking identifiers.

Spec refs: BEH-EA-106, BEH-EA-108 · Depends on: RBS-010

**Recommended status:** `ready-for-agent`

#### RBS-009 — Fixed-window algorithm plus zero escalation: attacker cost never rises across windows

`low` · `security` · `ports` · [.issues/low/RBS-009-rate-limiting-brute-force-specialist.md](../../.issues/low/RBS-009-rate-limiting-brute-force-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: medium)

Accurate description of a documented design ceiling (BEH-EA-105 chose fixed window). Ship an opt-in escalation so the default stays simple.

**Evidence at HEAD:**

- `packages/ports/src/RateLimiter.ts:121` — Plain fixed window; no escalation anywhere (grep backoff/lockout → none).

```
            Option.isSome(existing) && DateTime.isLessThan(now, existing.value.resetAt)
              ? { count: existing.value.count + 1, resetAt: existing.value.resetAt }
              : { count: 1, resetAt: DateTime.addDuration(now, window) };
```

**Fix plan** (M): Opt-in per-rule exponential escalation.

Steps:
1. RateLimits rule option `escalation?: { factor: number; maxPenalty: Duration }` (default off).
2. RateLimiter.layer: when a rule with escalation is exceeded, increment a strike bucket `${key}#strikes` (window = maxPenalty) and set a block until now + window × factor^(strikes−1) (capped) via a new store primitive `block(key, until)` / checked before increment; retryAfterMillis reflects the block.
3. Implement the primitive in layerStoreMemory and RateLimiterStoreSql; BEH-EA-105 addendum.

Files: `packages/ports/src/RateLimiter.ts`, `packages/core/src/RateLimits.ts`, `packages/sql/src/RateLimiterStoreSql.ts`, `spec/behaviors/14-rate-limiting.md`

Tests:
- FIRST (red): packages/ports/test/RateLimiter.test.ts — 'with escalation factor 2, the second consecutive limited window doubles retryAfterMillis (TestClock)'.
- 'without escalation behaviour is unchanged'.

Acceptance:
- Attacker cost rises across windows when enabled; default unchanged.

Spec refs: BEH-EA-105 · Depends on: RBS-004, EOTS-007

**Recommended status:** `ready-for-agent`

#### RBS-010 — Two distinct RateLimited classes share the _tag 'RateLimited' with divergent payloads

`low` · `api` · `ports` · [.issues/low/RBS-010-rate-limiting-brute-force-specialist.md](../../.issues/low/RBS-010-rate-limiting-brute-force-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

Accurate; the port error also carries the raw key (emails) to any consumer that logs it.

**Evidence at HEAD:**

- `packages/ports/src/RateLimiter.ts:45`

```
export class RateLimited extends Data.TaggedError("RateLimited")<{
  readonly key: string;
  readonly retryAfterMillis: number;
}> {}
```
- `packages/api/src/Api.ts:91` — Same tag, different payload.

```
export class RateLimited extends Schema.TaggedError<RateLimited>()(
  "RateLimited",
  { retryAfterMillis: Schema.Number },
  { httpApiStatus: 429 },
) {}
```
- `packages/password/src/Password.ts:682` — Mapping relies on only the port error being in scope.

```
            Effect.catchTag(
              "RateLimited",
              (error) => new Api.RateLimited({ retryAfterMillis: error.retryAfterMillis }),
```

**Fix plan** (S): Rename the port error and drop its raw key.

Steps:
1. RateLimiter.ts: `RateLimitExceeded` (tag 'RateLimitExceeded') with only `retryAfterMillis`.
2. Update catchTag sites: packages/password/src/Password.ts (~681), packages/oauth/src/OAuth.ts (~619), packages/core/src/RateLimits.ts comments, packages/ports/test/RateLimiter.test.ts:20.
3. BEH-EA-106 prose: the wire error stays Api.RateLimited; the port's own is RateLimitExceeded.

Files: `packages/ports/src/RateLimiter.ts`, `packages/password/src/Password.ts`, `packages/oauth/src/OAuth.ts`, `packages/ports/test/RateLimiter.test.ts`, `spec/behaviors/14-rate-limiting.md`

Tests:
- FIRST (red): packages/ports/test/RateLimiter.test.ts — 'exceeding a limit fails with _tag RateLimitExceeded and no key field'.
- Password/OAuth tests asserting wire `RateLimited` stay green.

Acceptance:
- No two error classes share the 'RateLimited' tag.
- Raw bucket keys never leave the limiter.

Spec refs: BEH-EA-106 · Depends on: —

**Recommended status:** `ready-for-agent`

### Workstream `tsconfig-paths-drift`

#### MM-002 — Hand-curated per-package tsconfig paths; ports carries a stale copy of client's (false api dependency edge)

`medium` · `dx` · `ports` · [.issues/medium/MM-002-mattia-manzati.md](../../.issues/medium/MM-002-mattia-manzati.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

Core claim holds (stale ports→api and sql→api edges, no drift check). The 'byte-identical to client' detail is stale: client's tsconfig has since gained @awthaq/passkey (hashes differ).

**Evidence at HEAD:**

- `packages/ports/tsconfig.src.json:10` — ports/src has no @awthaq imports and ports/package.json declares no @awthaq dependency.

```
    "paths": {
      "@/*": ["./src/*"],
      "@awthaq/api": ["../api/src/index.ts"]
    }
  },
  "references": [
    {
      "path": "../api/tsconfig.src.json"
```
- `packages/sql/tsconfig.src.json:10` — sql/package.json depends only on @awthaq/ports; sql/src never imports @awthaq/api.

```
    "paths": {
      "@/*": ["./src/*"],
      "@awthaq/ports": ["../ports/src/index.ts"],
      "@awthaq/api": ["../api/src/index.ts"]
```

**Fix plan** (S): Remove the stale edges and add a tsconfig-vs-package.json drift check to `pnpm check`.

Steps:
1. Delete the `@awthaq/api` path + `../api` reference from packages/ports/tsconfig.src.json and packages/sql/tsconfig.src.json (check the matching tsconfig.test.json files too).
2. New scripts/tsconfig-deps.mjs: for every packages/*/tsconfig.src.json compare `@awthaq/*` keys in `paths` and `references` against workspace deps in package.json (dependencies + peerDependencies); exit 1 on extra or missing entries.
3. package.json: `"tsconfig:check": "node scripts/tsconfig-deps.mjs"`, append to the `check` chain.

Files: `packages/ports/tsconfig.src.json`, `packages/sql/tsconfig.src.json`, `scripts/tsconfig-deps.mjs (new)`, `package.json`

Tests:
- FIRST (red): run the new script before the cleanup — it must report ports→api and sql→api; after cleanup it passes.
- pnpm run typecheck stays green.

Acceptance:
- No package maps an @awthaq alias it does not depend on.
- pnpm check fails on future drift.

Spec refs: — · Depends on: —

**Recommended status:** `ready-for-agent`

### Workstream `spec-model-drift`

#### JJS-010 — API-key plugin and Bearer plugin absent; spec model 08 stale relative to the shipped Jwt implementation

`info` · `docs` · `api-key` · [.issues/info/JJS-010-jwt-jwk-specialist.md](../../.issues/info/JJS-010-jwt-jwk-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

Three claims, all true at HEAD: api-key absent (tracked by OCM-002), Bearer JWT strategy absent (MAPS-003 adds the service-token half), and spec/models/08-jwt-bearer.md:80 is stale. The actionable, not-otherwise-covered part is the doc drift.

**Evidence at HEAD:**

- `spec/models/08-jwt-bearer.md:80` — Stale: packages/jwt/src ships Jwt.ts, JwtApi.ts, JwtCodec.ts, KeyRing.ts, RevocationStore.ts, SigningKeyRecords.ts, verify.ts with tests.

```
Everything: no `Jwt` or `Bearer` plugin class exists, no `JwtApi`/`BearerApi` contract, no signer, no JWKS endpoint, no key-rotation implementation, no test.
```
- `packages/server/src/Authentication.ts:300` — Bearer scheme resolves session tokens only; no JWT-bearer strategy feeds Authentication (grep: no Jwt import in packages/server/src).

```
      { readonly cookie: typeof Api.SessionCookie; readonly bearer: typeof Api.BearerToken },
```
- `packages/api-key/src/index.ts:8` — Whole file is 10 lines; no other file under packages/api-key/src.

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

**Fix plan** (S): Correct spec/models/08-jwt-bearer.md so it distinguishes the shipped Jwt plugin from the still-missing Bearer strategy.

Steps:
1. Rewrite the Status table and 'What is missing' (line 80) of spec/models/08-jwt-bearer.md: list what packages/jwt ships (mint + x-jwt-token mirroring, KeyRing/JWKS, RevocationStore, lite verifier in verify.ts) and what is still missing (a Bearer strategy that accepts `Authorization: Bearer <jwt>` into Authentication for user principals).
2. Cross-link decision 10 / MAPS-003 for the machine (ServicePrincipal) JWT path and spec/models/07-api-keys.md for the token format decided by OCM-002.
3. Bump the model doc's revision + change-history row; run spec:verify:strict.

Files: `spec/models/08-jwt-bearer.md`, `spec/traceability.md`

Tests:
- pnpm run spec:verify:strict (no code test; doc-only).

Acceptance:
- spec/models/08-jwt-bearer.md no longer claims no Jwt plugin exists.
- The Bearer gap is described precisely.

Spec refs: — · Depends on: —

**Recommended status:** `ready-for-agent`

### Workstream `apikey-machine-identity`

#### MAPS-003 — Service identity is absent - ApiKey/Service principals are dead schema cases

`high` · `architecture` · `api-key` · [.issues/high/MAPS-003-microservices-auth-propagation-specialist.md](../../.issues/high/MAPS-003-microservices-auth-propagation-specialist.md) · current: `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high)

Service identity is still absent: nothing constructs ApiKeyPrincipal/ServicePrincipal. Decision 10 splits the fix: API keys (OCM-002, canonical for that half) and OAuth2 client_credentials M2M clients minting short-lived JWTs that resolve to ServicePrincipal (this issue). Cross-slice: OCM-001 (oauth slice) is the same client_credentials work — decision 10 places it in api-key, not oauth.

**Evidence at HEAD:**

- `packages/api-key/src/index.ts:8` — Whole file is 10 lines; no other file under packages/api-key/src.

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```
- `packages/api/src/Api.ts:27` — Only references outside Api.ts are comments (roles/src/Roles.ts:12, qadi/src/SubjectResolver.ts:28); nothing constructs either.

```
export class ApiKeyPrincipal extends Schema.TaggedClass<ApiKeyPrincipal>()("ApiKey", {
  ref: PrincipalRef,
}) {}

export class ServicePrincipal extends Schema.TaggedClass<ServicePrincipal>()("Service", {
  ref: PrincipalRef,
}) {}
```
- `packages/qadi/src/SubjectResolver.ts:26` — BEH-EA-140/141 explicitly unimplemented.

```
// **BEH-EA-140/141 (ApiKey/Service principal scopes → permissions) are also
// not implemented, for a different reason**: `@awthaq/api`'s
// `ApiKeyPrincipal`/`ServicePrincipal` (`Api.ts`) carry only a `ref`, no
// `scopes` field — there is no `@awthaq/api-key` plugin yet (M7,
```
- `packages/oauth/src/OAuth.ts:238` — The only grant_type literal in the repo; `grep -rn client_credentials packages/*/src` → none.

```
      grant_type: "authorization_code",
```

**Fix plan** (L): Give ServicePrincipal a construction path: client_credentials M2M clients in @awthaq/api-key minting short-lived JWTs via @awthaq/jwt, verified back into ServicePrincipal.

Steps:
1. Table `api_key_client` (client_id PK, name, secret_hash, scopes JSON, revoked_at, created_at) + migration, memory/SQL records mirroring ApiKeyRecords.
2. ApiKey service gains `registerClient(name, scopes) → { clientId, clientSecret: Redacted }` (shown once, SecretHash digest at rest — never argon2id, per OCM-002/decision 10) and `revokeClient(clientId)`.
3. ApiKeyApi: `POST /api-key/token` accepting `grant_type=client_credentials` + `client_id`/`client_secret` form body (client_secret_post); negotiated scope = requested ∩ registered (never more); errors are RFC 6749 §5.2 shaped (`invalid_client`, `invalid_scope`, `unsupported_grant_type`) as typed Schema errors; rate-limited per IP and per client_id.
4. Mint via @awthaq/jwt's signer (packages/jwt/src/Jwt.ts / KeyRing.ts): `sub: "service:<clientId>"`, `scope`, `exp` = `ApiKeyConfig.serviceTokenTtl` (default 15 minutes), `aud`/`iss` from Jwt config.
5. Resolution: the ApiKey plugin's bearer-side resolver verifies a JWT-shaped bearer credential against the local KeyRing (signature + exp + aud) and yields `ServicePrincipal { ref: { type: "service", id: clientId }, scopes }`; a non-JWT bearer still falls through to session resolution (BEH-EA-066). Document the accepted revocation lag (revoked client blocks new tokens immediately; minted tokens live until exp).
6. `ApiKey.subjectForPrincipal` handles ServicePrincipal (`id: "service:<clientId>"`, BEH-EA-141); default qadi resolver maps it.
7. Leave packages/server/src/Session.ts's die-on-non-User comment as-is (decision 10).
8. Flag in spec/roadmap.md M7 that client_credentials lands in M7 ahead of the Phase-3 OidcProvider (decision 10's scope note).

Files: `packages/api-key/src/ApiKey.ts`, `packages/api-key/src/ApiKeyApi.ts`, `packages/api-key/src/ApiKeyClientRecords.ts (new)`, `packages/api-key/src/ServiceToken.ts (new)`, `packages/api/src/Api.ts`, `packages/qadi/src/SubjectResolver.ts`, `spec/roadmap.md`, `spec/models/07-api-keys.md`

Tests:
- FIRST (red): packages/api-key/test/ServiceToken.test.ts — 'client_credentials with a valid secret mints a JWT whose bearer resolves to ServicePrincipal with the negotiated scopes'.
- 'requested scope outside the registered set fails invalid_scope'; 'revokeClient blocks new tokens but an already-minted token verifies until exp (TestClock)'; 'wrong client_secret fails invalid_client with uniform timing (constant-time compare)'.
- packages/qadi/test — 'ServicePrincipal scopes become permissions' (BEH-EA-141).

Acceptance:
- A service-to-service caller can obtain and use a short-lived token without any user session.
- Both previously dead Principal cases are reachable from a real HTTP request.
- Token endpoint is rate-limited and never uses password-grade KDF.

Spec refs: BEH-EA-141, BEH-EA-066, BEH-EA-108 · Depends on: OCM-002 · Absorbs: AR-006

**Recommended status:** `ready-for-agent`

#### OCM-002 — The M2M credential package is an empty placeholder — no key format, hash-at-rest, expiry, or revocation

`high` · `security` · `api-key` · [.issues/high/OCM-002-oauth2-client-credentials-m2m-specialist.md](../../.issues/high/OCM-002-oauth2-client-credentials-m2m-specialist.md) · current: `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high)

Still a literal empty placeholder at HEAD. Decision 10 (.scratch/resolve-ready-for-human-findings/issues/10-machine-service-identity-m2m.md) fixes the design: `{prefix}_{keyId}.{secret}`, SHA-256 at rest with constant-time compare, show-once Redacted, expiry, list/revoke, resolve-per-request to ApiKeyPrincipal. Canonical for the API-key credential kind (SCP-002, TRBS-009, SMS-008 fold in).

**Evidence at HEAD:**

- `packages/api-key/src/index.ts:8` — Whole file is 10 lines; no other file under packages/api-key/src.

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```
- `spec/models/07-api-keys.md:23` — Status Planned-Phase2 (line 38).

```
Nothing described here exists yet — awthaq is pre-implementation.
```
- `packages/core/src/Sessions.ts:37` — The SHA-256 + constant-time primitives decision 10 says to reuse exist but are module-private (lines 37, 50).

```
const hashSecret = (
...
const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
```

**Fix plan** (L): Implement the long-lived API-key credential kind of @awthaq/api-key exactly as decision 10 specifies, and make it a third Authentication scheme.

Steps:
1. Extract `hashSecret`/`constantTimeEqual` (packages/core/src/Sessions.ts:37,50, module-private today) into an exported `packages/core/src/SecretHash.ts` (`SecretHash.digest(crypto, secret)`, `SecretHash.equals(a, b)`); switch Sessions.ts to import it (pure refactor, existing Sessions tests must stay green).
2. packages/api/src/Api.ts: add `scopes: Schema.Array(Schema.String)` to `ApiKeyPrincipal` and `ServicePrincipal` (BEH-EA-140/141; pre-release wire change is acceptable) and export `ApiKeyHeader = HttpApiSecurity.apiKey({ key: "x-api-key", in: "header" })`.
3. New packages/api-key/src/ApiKeyApi.ts: `apiKey` HttpApiGroup — `POST /api-key` (create → `{ id, name, start, key: Redacted, expiresAt }`, key shown once), `GET /api-key` (list: id/name/start/scopes/expiresAt/lastUsedAt, never hash or secret), `DELETE /api-key/:id` (revoke) guarded by the session `Authentication` middleware; typed errors `ApiKeyNotFound`, `ApiKeyScopeNotGrantable`.
4. New packages/api-key/src/ApiKeyRecords.ts + migration for table `api_key` (id PK = keyId, owner_user_id, name, start, secret_hash, scopes JSON, expires_at, revoked_at, last_used_at, created_at), with `layerMemory` and `layerSql` (SQLite + Postgres, ADR-EA-004), following Sessions.ts/Repositories.ts patterns.
5. New packages/api-key/src/ApiKey.ts: `ApiKey` AuthPlugin.Service (id `apiKey`, `dependsOn: [Users]`, tables `['api_key']`), `ApiKeyConfig` Context.Reference (`prefix` default `ak_`, optional `defaultExpiresIn`, `maxExpiresIn`), service `create/list/revoke/resolve`. Key = `${prefix}${keyId}.${hex(32 CSPRNG bytes)}`; only `SecretHash.digest(secret)` persisted; `resolve` parses, looks up by keyId, constant-time compares, rejects revoked/expired, updates last_used_at, returns `Option<ApiKeyPrincipal>` with `ref: { type: "apikey", id: keyId }` — no cross-request cache (TRBS-009).
6. Authentication wiring (packages/server/src/Authentication.ts): add an `apiKey` scheme handler that delegates to an `ApiKeyResolver` Context.Reference (default: always-None → falls through, fail-closed) which the ApiKey plugin layer provides; groups that accept machine callers declare `security: { cookie, bearer, apiKey }` (BEH-EA-071/072 order). Session group behaviour in packages/server/src/Session.ts stays unchanged (decision 10).
7. Export `ApiKey.subjectForPrincipal(principal)` → qadi `AuthSubject` (`id: "apikey:<keyId>"`, permissions = scopes) and update packages/qadi/src/SubjectResolver.ts's default resolver + header comment (lines 26-40) to map scopes for ApiKey principals (BEH-EA-140). Do NOT claim the exclusive SubjectResolver slot (ADR-EA-012).
8. Rate-limit `resolve` failures per IP via RateLimits (`apikey:resolve:ip:<ip>`, BEH-EA-108) so key guessing is throttled.
9. Docs: packages/api-key/README.md (replace 'planned package' banner), spec/models/07-api-keys.md Status/What-is-missing (record decided format, x-api-key transport, show-once), spec/traceability.md rows; document that a SCIM directory token is an ordinary key scoped `scim:*` (SCP-002).

Files: `packages/core/src/SecretHash.ts (new)`, `packages/core/src/Sessions.ts`, `packages/api/src/Api.ts`, `packages/api-key/src/ApiKey.ts (new)`, `packages/api-key/src/ApiKeyApi.ts (new)`, `packages/api-key/src/ApiKeyRecords.ts (new)`, `packages/api-key/src/index.ts`, `packages/api-key/package.json`, `packages/api-key/tsconfig.src.json`, `packages/server/src/Authentication.ts`, `packages/qadi/src/SubjectResolver.ts`, `packages/api-key/README.md`, `spec/models/07-api-keys.md`, `spec/traceability.md`

Tests:
- FIRST (red): packages/api-key/test/ApiKey.test.ts — 'create returns a show-once key whose only persisted form is its SHA-256 digest' (read the record back; assert no field equals the secret).
- packages/api-key/test/ApiKey.test.ts — 'resolve fails immediately after revoke', 'resolve fails after expiresIn elapses (TestClock)', 'right keyId + wrong secret resolves None'.
- packages/api-key/test/AuthHttp.test.ts — 'x-api-key header resolves CurrentPrincipal to ApiKeyPrincipal carrying the key's scopes'; 'cookie still wins when both are present' (BEH-EA-072).
- packages/qadi/test — 'ApiKeyPrincipal scopes become AuthSubject permissions' (BEH-EA-140), including a `scim:users:write` scope (SCP-002).
- packages/core/test/Sessions.test.ts must stay green after the SecretHash extraction.
- features/features/06-roles-and-authorization-bridge/18-roles-subject-resolver.feature: wire the BEH-EA-140 scenarios.

Acceptance:
- `packages/api-key/src/index.ts` exports ApiKey, ApiKeyApi, ApiKeyConfig; package no longer a placeholder.
- No plaintext key or secret is ever persisted or returned after create.
- A revoked or expired key is rejected on the very next request.
- ApiKeyPrincipal is constructible via a real request and maps to qadi permissions.
- pnpm check passes (typecheck, knip, spec:verify:strict).

Spec refs: BEH-EA-140, BEH-EA-065, BEH-EA-071, BEH-EA-072, BEH-EA-108 · Depends on: — · Absorbs: SCP-002, TRBS-009, SMS-008-secrets-management-specialist

**Recommended status:** `ready-for-agent`

#### SCP-002 — No machine-credential substrate: api-key is an empty stub, leaving the SCIM bearer token with no home

`high` · `security` · `api-key` · [.issues/high/SCP-002-scim-provisioning-specialist.md](../../.issues/high/SCP-002-scim-provisioning-specialist.md) · current: `ready-for-agent`

**Verdict:** DUPLICATE of **OCM-002** (confidence: high)

Same root cause (empty api-key package). Decision 10 makes the SCIM directory token an ordinary API key scoped `scim:*`, so it closes with OCM-002; OCM-002's plan includes the scim-scope test and the doc note.

**Evidence at HEAD:**

- `packages/api-key/src/index.ts:8` — Whole file is 10 lines; no other file under packages/api-key/src.

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```
- `.scratch/resolve-ready-for-human-findings/issues/10-machine-service-identity-m2m.md:441`

```
**SCIM's bearer token (`SCP-002`) is an ordinary API key, not a third
credential kind.**
```

**No fix of its own** — closed by the canonical issue's plan.

**Recommended status:** `resolved`

#### AR-006 — Machine principals in the wire union are unreachable — the M2M half of the API story is a stub

`low` · `api` · `api-key` · [.issues/low/AR-006-aeneas-rekkas.md](../../.issues/low/AR-006-aeneas-rekkas.md) · current: `needs-triage`

**Verdict:** DUPLICATE of **MAPS-003** (confidence: high)

Same observation as MAPS-003 (machine principals unreachable); closes when MAPS-003 + OCM-002 land.

**Evidence at HEAD:**

- `packages/api/src/Api.ts:27` — Only references outside Api.ts are comments (roles/src/Roles.ts:12, qadi/src/SubjectResolver.ts:28); nothing constructs either.

```
export class ApiKeyPrincipal extends Schema.TaggedClass<ApiKeyPrincipal>()("ApiKey", {
  ref: PrincipalRef,
}) {}

export class ServicePrincipal extends Schema.TaggedClass<ServicePrincipal>()("Service", {
  ref: PrincipalRef,
}) {}
```
- `packages/qadi/src/SubjectResolver.ts:26` — BEH-EA-140/141 explicitly unimplemented.

```
// **BEH-EA-140/141 (ApiKey/Service principal scopes → permissions) are also
// not implemented, for a different reason**: `@awthaq/api`'s
// `ApiKeyPrincipal`/`ServicePrincipal` (`Api.ts`) carry only a `ref`, no
// `scopes` field — there is no `@awthaq/api-key` plugin yet (M7,
```

**No fix of its own** — closed by the canonical issue's plan.

**Recommended status:** `resolved`

#### SMS-008 — Persona-named secret surfaces (api-key salts, TOTP, CLI) are absent placeholders

`info` · `architecture` · `api-key` · [.issues/info/SMS-008-secrets-management-specialist.md](../../.issues/info/SMS-008-secrets-management-specialist.md) · current: `needs-triage`

**Verdict:** DUPLICATE of **OCM-002** (confidence: medium)

Informational absence note. API-key digest storage is covered by OCM-002 (SHA-256 at rest); the CLI 'seed admin' Config-based password source is folded into BE-003's seed-admin step; TOTP-seed encryption belongs to the two-factor slice (decision 05), not this one.

**Evidence at HEAD:**

- `packages/api-key/src/index.ts:8`

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
```
- `packages/two-factor/src/index.ts:8` — TOTP half belongs to the two-factor/MFA slice (wayfinder decision 05).

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
```

**No fix of its own** — closed by the canonical issue's plan.

**Recommended status:** `resolved`

#### TRBS-009 — API-key credentials are absent: the longest-lived tokens have no revocation path at all

`info` · `architecture` · `api-key` · [.issues/info/TRBS-009-token-revocation-blacklist-specialist.md](../../.issues/info/TRBS-009-token-revocation-blacklist-specialist.md) · current: `needs-triage`

**Verdict:** DUPLICATE of **OCM-002** (confidence: high)

No revocation path because no API-key credential exists. OCM-002's plan includes revoke/list from day one and resolve-per-request with no cross-request cache (this issue's own recommendation).

**Evidence at HEAD:**

- `packages/api-key/src/index.ts:8` — Whole file is 10 lines; no other file under packages/api-key/src.

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

**No fix of its own** — closed by the canonical issue's plan.

**Recommended status:** `resolved`

### Workstream `cli-manifest-tooling`

#### BE-003 — CLI is an empty placeholder — no schema/migration tooling exists

`high` · `api` · `cli` · [.issues/high/BE-003-bereket-engida.md](../../.issues/high/BE-003-bereket-engida.md) · current: `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high)

Still a 10-line placeholder. Decision 07 (07-cli-schema-migration-tooling.md) fixes the design: one `awthaq` binary on `effect/unstable/cli` (`../effect/packages/effect/src/unstable/cli/Command.ts` exists), `awthaq.config.ts` manifest loading, thin modules over Built<P> (packages/core/src/Auth.ts:259-263). Canonical for the whole manifest-tooling surface (MW-006, ELC-008, ERS-008, RRM-011 fold in). XL → decompose into the sub-tickets in the steps.

**Evidence at HEAD:**

- `packages/cli/src/index.ts:3` — Only file under packages/cli/src; the planned command list has no login/logout/whoami.

```
// doctor, plugin list --graph, routes, migration status|apply, openapi, seed admin, import — reads the plugin manifest, never runs the application.
//
// Planned first module: cli.ts (spec/behaviors/26-cli.md, BEH-EA-201–208)
// See spec/overview.md for the full package map.
//
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```
- `spec/behaviors/26-cli.md:15` — Revision still 1.2 (line 7); `grep -in login spec/behaviors/26-cli.md` → no matches, so decision 06's BEH-EA-208 amendment has not landed either.

```
> This file describes planned behavior. No code implementing it exists yet; awthaq is pre-implementation.
```
- `features/features/08-tooling/26-cli.feature:6` — All 30 CLI scenarios are skipped/unwired.

```
@tooling @cli
@skip @unwired
Feature: CLI
```

**Fix plan** (XL): Build the @awthaq/cli command tree per decision 07 (doctor, plugin list --graph, routes, migration status|apply, openapi, seed admin, import mechanism).

Steps:
1. Sub-ticket A (M) — skeleton: packages/cli/src/{index.ts (exports `run`), Cli.ts (Command.make('awthaq') + withSubcommands), internal/ManifestLoader.ts (dynamic import of `awthaq.config.ts` default export: `Built<P>` or `Effect<Built<P>>`, `--config <path>` override)}; add a `bin` entry to packages/cli/package.json; add `@effect/platform-node` runtime dep for the Node entrypoint. Depends on ECS-004's ADR.
2. Sub-ticket B (M) — pure reads: Routes.ts (walk `built.api` groups/endpoints/middleware, owning plugin; BEH-EA-203), Openapi.ts (OpenApi.fromApi over `built.api`, `--out`; BEH-EA-205), Plugin.ts `plugin list --graph` (render `built.manifest.plugins` id/dependsOn/tables in linkPlugins order, text + `--format dot|json`; BEH-EA-202 — ELC-008).
3. Sub-ticket C (M) — Migration.ts: `status` diffs the effect_sql_migrations ledger against `CoreMigrations.coreMigrations` + `built.migrations` (core first as `0000_core_*`, extending Auth.ts's renumberMigrations scheme); `apply` requires `--yes` (Flag.boolean + fail fast), needs only a DB URL (`--database-url` / Config) and never starts HTTP (BEH-EA-204, MW-006).
4. Sub-ticket D (M) — Doctor.ts: link problems from the manifest, insecure-default config values statically exposed by awthaq.config.ts (sameSite, CSRF, Mailer.layerMemory, RateLimiter.layerPermissive — NHS-005), unprovided ports / Config errors by building the layer to a scope without serving (ERS-008) (BEH-EA-201).
5. Sub-ticket E (M) — Seed.ts `seed admin` (RRM-011): runs through Users.create + Roles.assign from the app's own layer (short-lived runtime, no listener); requires @awthaq/roles installed (typed `RolesNotInstalled`), typed `AdminExists` refusal unless `--force`; admin role name from Roles config (default `admin`, defined in @awthaq/roles); password read from Config/prompt (`AWTHAQ_SEED_ADMIN_PASSWORD` / Prompt.password), never argv (SMS-008) (BEH-EA-206).
6. Sub-ticket F — Import.ts SourceAdapter mechanism is owned by BAM-001 (cross-slice, decision 07 §6); this ticket only registers the `import` subcommand and the adapter registry.
7. Update packages/cli/README.md and spec/behaviors/26-cli.md intro line 15 ('No code implementing it exists yet') in the same change as each command lands (CTA-007's discipline); un-skip the corresponding 26-cli.feature scenarios.

Files: `packages/cli/src/index.ts`, `packages/cli/src/Cli.ts (new)`, `packages/cli/src/internal/ManifestLoader.ts (new)`, `packages/cli/src/Routes.ts (new)`, `packages/cli/src/Openapi.ts (new)`, `packages/cli/src/Plugin.ts (new)`, `packages/cli/src/Migration.ts (new)`, `packages/cli/src/Doctor.ts (new)`, `packages/cli/src/Seed.ts (new)`, `packages/cli/src/Import.ts (new, registry only)`, `packages/cli/package.json`, `packages/cli/README.md`, `packages/core/src/Auth.ts (core-first migration numbering helper)`, `packages/roles/src (admin role name constant)`, `spec/behaviors/26-cli.md`, `features/features/08-tooling/26-cli.feature`, `features/features/08-tooling/26-cli.steps.test.ts`

Tests:
- FIRST (red): packages/cli/test/Routes.test.ts — 'routes lists every endpoint of a TestAuth composition with its owning plugin' against an in-test Auth.make([...]) value (no listener).
- packages/cli/test/Migration.test.ts — 'status on an empty sqlite DB lists core then plugin migrations as pending'; 'apply without --yes exits non-zero and applies nothing'.
- packages/cli/test/Plugin.test.ts — 'plugin list --graph prints dependsOn edges in link order'.
- packages/cli/test/Seed.test.ts — 'seed admin refuses with AdminExists when an admin exists, succeeds with --force'; 'fails RolesNotInstalled without @awthaq/roles'.
- packages/cli/test/Doctor.test.ts — 'doctor reports a missing declared dependency'.
- Wire 26-cli.feature BEH-EA-201..206 scenarios (remove @skip @unwired per rule as implemented).

Acceptance:
- `awthaq routes|openapi|plugin list --graph|migration status|apply --yes|doctor|seed admin` all run against an app's awthaq.config.ts without starting an HTTP server.
- 26-cli.feature scenarios for implemented commands pass under pnpm run test:bdd.
- README/spec no longer describe the package as pre-implementation once commands ship.

Spec refs: BEH-EA-201, BEH-EA-202, BEH-EA-203, BEH-EA-204, BEH-EA-205, BEH-EA-206, BEH-EA-207, BEH-EA-208 · Depends on: ECS-004 · Absorbs: MW-006, ELC-008, ERS-008, RRM-011

**Recommended status:** `ready-for-agent`

#### ECS-004 — CLI command framework unpinned; stale @effect/cli guidance persists

`medium` · `architecture` · `cli` · [.issues/medium/ECS-004-effect-cli-specialist.md](../../.issues/medium/ECS-004-effect-cli-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

Claim holds: no ADR, research/12 still recommends the v3-only package. Decision 07 already made the choice (effect/unstable/cli), so the fix is recording it, not deciding it.

**Evidence at HEAD:**

- `research/12-library-strategy.md:13` — Same stale advice at lines 49 and 257; the repo pins effect 4.0.0-rc.116 (pnpm-workspace.yaml:17).

```
- `@effect/cli` is still Effect-3-only (0.77.1); in Effect v4 the CLI moved to an unstable export (`effect/unstable/cli`). Build the MVP CLI on `@effect/cli`, keep the command layer thin.
```
- `research/19-dbc-to-effect-mapping.md:231` — Contradicting (correct) source.

```
| CLI (scaffolding, `generate`/`migrate` commands) | **Native, in-core**: `effect/unstable/cli` — `Command`, `Flag`, `Argument`, `Param`, `Prompt`, `CliConfig`, `Completions` |
```
- `research/12-library-strategy.md:257` — `ls spec/decisions` → ADRs 001-016, none records the CLI framework; decision 07 chose effect/unstable/cli without an ADR.

```
6. CLI: `@effect/cli` with a thin command-function layer; MVP = `doctor`, `schema generate|diff`, `migration create|status|apply`, `plugin list|validate`; `init`/codegen post-MVP.
```

**Fix plan** (S): Record the CLI-framework choice as an ADR and retire the stale @effect/cli recommendation.

Steps:
1. Add spec/decisions/017-cli-on-effect-unstable-cli.md (ADR-EA-017): `@awthaq/cli` parses with `effect/unstable/cli` (Command/Flag/Argument/Prompt), each command body is a plain Effect function taking typed args (the seam that isolates RC churn), rationale + consequences; register it in spec/decisions/index.yaml.
2. Edit research/12-library-strategy.md lines 13, 33, 49, 208-209, 257: mark the @effect/cli recommendation superseded, pointing to research/19:231 and ADR-EA-017.
3. grep .scratch/ and archive/ for live '@effect/cli' recommendations and annotate them as superseded (do not rewrite archive content).
4. Run spec:verify:strict.

Files: `spec/decisions/017-cli-on-effect-unstable-cli.md (new)`, `spec/decisions/index.yaml`, `research/12-library-strategy.md`

Tests:
- pnpm run spec:verify:strict (doc-only).

Acceptance:
- ADR-EA-017 exists and is indexed.
- No non-superseded text in research/ recommends @effect/cli.

Spec refs: BEH-EA-201, BEH-EA-208 · Depends on: —

**Recommended status:** `ready-for-agent`

#### FAMS-010 — No bulk user-import tooling; the planned CLI import command is unimplemented

`medium` · `dx` · `cli` · [.issues/medium/FAMS-010-firebase-auth-migration-specialist.md](../../.issues/medium/FAMS-010-firebase-auth-migration-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

No importer exists. Decision 21 places the Firebase export→import recipe in the new @awthaq/migrate-firebase package (with the firebase-scrypt verifier, FAMS-001); decision 07 gives the CLI a SourceAdapter registry. This issue wires the two.

**Evidence at HEAD:**

- `packages/cli/src/index.ts:3` — Only file under packages/cli/src; the planned command list has no login/logout/whoami.

```
// doctor, plugin list --graph, routes, migration status|apply, openapi, seed admin, import — reads the plugin manifest, never runs the application.
//
// Planned first module: cli.ts (spec/behaviors/26-cli.md, BEH-EA-201–208)
// See spec/overview.md for the full package map.
//
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```
- `spec/behaviors/26-cli.md:131` — Firebase is not a named source; `grep -rni firebase spec` finds nothing beyond this audit's scope.

```
awthaq import --from better-auth|authjs|lucia
```

**Fix plan** (M): Ship a Firebase import recipe in @awthaq/migrate-firebase and expose it as `awthaq import --from firebase`.

Steps:
1. packages/migrate-firebase/src/ImportFirebaseUser.ts (mirrors packages/migrate-auth0/src/ImportAuth0User.ts): input = one auth.listUsers export record + the project hash_config; users.create; accounts.link({ provider: 'password', credentialHash: `$firebase-scrypt$k=..,ss=..,r=..,mc=..$<salt>$<hash>` }); Users.verifyEmail when emailVerified; each providerUserInfo entry linked with the exact (providerId, subject=rawId, issuer) triple via packages/oauth account linking.
2. Email-less source users are collected into a report (never silently dropped) until FAMS-002 (other slice) lands.
3. Register a `firebase` SourceAdapter in packages/cli/src/Import.ts (BE-003 sub-ticket F / BAM-001 mechanism) reading users.json + hash_config.json.
4. Amend BEH-EA-207 to list firebase as a supported source (spec change), update 26-cli.feature.

Files: `packages/migrate-firebase/src/ImportFirebaseUser.ts (new)`, `packages/migrate-firebase/README.md`, `packages/cli/src/Import.ts`, `spec/behaviors/26-cli.md`, `features/features/08-tooling/26-cli.feature`

Tests:
- FIRST (red): packages/migrate-firebase/test/ImportFirebaseUser.test.ts — 'an imported email-verified password user signs in via the firebase-scrypt legacy verifier and is rehashed to argon2id on first sign-in'.
- 'an email-less export record is reported, not imported'; 'providerUserInfo google entry becomes a linked oauth account with the right subject'.

Acceptance:
- A Firebase auth.listUsers export can be imported programmatically and via the CLI without forced password resets.
- Unmappable records are reported.

Spec refs: BEH-EA-207, BEH-EA-116 · Depends on: FAMS-001, BE-003

**Recommended status:** `ready-for-agent`

#### MW-006 — Operational CLI is an empty stub; migrations apply only in-process at app startup

`medium` · `dx` · `cli` · [.issues/medium/MW-006-matias-woloski.md](../../.issues/medium/MW-006-matias-woloski.md) · current: `needs-triage`

**Verdict:** DUPLICATE of **BE-003** (confidence: high)

Operational CLI absence — same root as BE-003; BE-003 sub-ticket C (migration status|apply needing only a DB URL) is exactly this issue's fix.

**Evidence at HEAD:**

- `packages/cli/src/index.ts:3` — Only file under packages/cli/src; the planned command list has no login/logout/whoami.

```
// doctor, plugin list --graph, routes, migration status|apply, openapi, seed admin, import — reads the plugin manifest, never runs the application.
//
// Planned first module: cli.ts (spec/behaviors/26-cli.md, BEH-EA-201–208)
// See spec/overview.md for the full package map.
//
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

**No fix of its own** — closed by the canonical issue's plan.

**Recommended status:** `resolved`

#### CTA-007 — Absence of the entire domain is documented honestly in every artifact

`info` · `docs` · `cli` · [.issues/info/CTA-007-cli-tool-auth-specialist.md](../../.issues/info/CTA-007-cli-tool-auth-specialist.md) · current: `needs-triage`

**Verdict:** WONTFIX-CANDIDATE (confidence: high)

Positive observation, not a defect: every CLI artifact honestly declares its absence. Its recommendation (update README/spec in the same change; record storage/exit-code decisions) is written into BE-003's and CTA-001's acceptance criteria.

**Evidence at HEAD:**

- `packages/cli/README.md:3`

```
> **This describes a planned package.** awthaq is pre-implementation (see [`../../spec/README.md`](../../spec/README.md)); no line of source in this package has shipped yet. This README states intent, not shipped behavior.
```

**No fix of its own** — see rationale above.

**Recommended status:** `wontfix`

#### ELC-008 — Operator-facing layer-graph tooling (cli plugin list --graph) is an empty placeholder

`info` · `dx` · `cli` · [.issues/info/ELC-008-effect-layer-context-architect.md](../../.issues/info/ELC-008-effect-layer-context-architect.md) · current: `needs-triage`

**Verdict:** DUPLICATE of **BE-003** (confidence: high)

`plugin list --graph` absence; BE-003 sub-ticket B.

**Evidence at HEAD:**

- `packages/cli/src/index.ts:3` — Only file under packages/cli/src; the planned command list has no login/logout/whoami.

```
// doctor, plugin list --graph, routes, migration status|apply, openapi, seed admin, import — reads the plugin manifest, never runs the application.
//
// Planned first module: cli.ts (spec/behaviors/26-cli.md, BEH-EA-201–208)
// See spec/overview.md for the full package map.
//
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```
- `packages/core/src/Auth.ts:370` — Manifest exists; nothing consumes it.

```
const buildManifest = (order: ReadonlyArray<AuthPlugin.Any>): Manifest => ({
```

**No fix of its own** — closed by the canonical issue's plan.

**Recommended status:** `resolved`

#### ERS-008 — CLI package is an empty placeholder: no runtime-adjacent tooling exists

`info` · `dx` · `cli` · [.issues/info/ERS-008-effect-runtime-scheduler-specialist.md](../../.issues/info/ERS-008-effect-runtime-scheduler-specialist.md) · current: `needs-triage`

**Verdict:** DUPLICATE of **BE-003** (confidence: high)

Doctor/runtime tooling absence; BE-003 sub-ticket D grounds doctor in the same layer construction path (this issue's recommendation).

**Evidence at HEAD:**

- `packages/cli/src/index.ts:3` — Only file under packages/cli/src; the planned command list has no login/logout/whoami.

```
// doctor, plugin list --graph, routes, migration status|apply, openapi, seed admin, import — reads the plugin manifest, never runs the application.
//
// Planned first module: cli.ts (spec/behaviors/26-cli.md, BEH-EA-201–208)
// See spec/overview.md for the full package map.
//
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

**No fix of its own** — closed by the canonical issue's plan.

**Recommended status:** `resolved`

#### RRM-011 — Seed-admin path (BEH-EA-206) is absent — cli is a placeholder

`info` · `dx` · `cli` · [.issues/info/RRM-011-rbac-role-modeling-specialist.md](../../.issues/info/RRM-011-rbac-role-modeling-specialist.md) · current: `needs-triage`

**Verdict:** DUPLICATE of **BE-003** (confidence: high)

seed admin absence; its specifics (AdminExists + --force, Roles required, admin role name constant, contract tests) are written into BE-003 sub-ticket E.

**Evidence at HEAD:**

- `packages/cli/src/index.ts:3` — Only file under packages/cli/src; the planned command list has no login/logout/whoami.

```
// doctor, plugin list --graph, routes, migration status|apply, openapi, seed admin, import — reads the plugin manifest, never runs the application.
//
// Planned first module: cli.ts (spec/behaviors/26-cli.md, BEH-EA-201–208)
// See spec/overview.md for the full package map.
//
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```
- `spec/behaviors/26-cli.md:116` — No implementation; `grep -rn '"admin"' packages/roles/src` → no default admin role constant.

```
REQUIREMENT: `seed admin` MUST create or promote one account to an
```

**No fix of its own** — closed by the canonical issue's plan.

**Recommended status:** `resolved`

### Workstream `cli-session-commands`

#### CTA-001 — CLI package has zero auth surface and its planned command set contains no login command

`high` · `architecture` · `cli` · [.issues/high/CTA-001-cli-tool-auth-specialist.md](../../.issues/high/CTA-001-cli-tool-auth-specialist.md) · current: `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high)

Confirmed: no login surface and none planned in the package header. Decision 06 fixes it: login/logout/whoami live in @awthaq/cli, token path now (`--token`/AWTHAQ_TOKEN), device flow gated on a not-yet-existing DeviceAuthorization plugin, CredentialStore port with OS keychain + 0600 file fallback. Canonical for DAG-002 and CTA-005.

**Evidence at HEAD:**

- `packages/cli/src/index.ts:3` — Only file under packages/cli/src; the planned command list has no login/logout/whoami.

```
// doctor, plugin list --graph, routes, migration status|apply, openapi, seed admin, import — reads the plugin manifest, never runs the application.
//
// Planned first module: cli.ts (spec/behaviors/26-cli.md, BEH-EA-201–208)
// See spec/overview.md for the full package map.
//
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```
- `spec/behaviors/26-cli.md:15` — Revision still 1.2 (line 7); `grep -in login spec/behaviors/26-cli.md` → no matches, so decision 06's BEH-EA-208 amendment has not landed either.

```
> This file describes planned behavior. No code implementing it exists yet; awthaq is pre-implementation.
```
- `spec/behaviors/26-cli.md:156` — Decision 06's session-command carve-out not yet applied (still Revision 1.2).

```
REQUIREMENT: Every CLI command MUST operate on `Auth.make`'s statically
             derived manifest (contract, tables, migrations, plugin graph); no
             CLI command MUST start an HTTP listener, accept a request, or
             otherwise run the application it is inspecting.
```

**Fix plan** (L): Add the login/logout/whoami command family to @awthaq/cli per decision 06 (token path now, device flow later).

Steps:
1. Prerequisite (cross-slice CTA-002/DAG-003): apply decision 06's BEH-EA-208 amendment to spec/behaviors/26-cli.md (Revision 1.3, session-command exemption; no listener, no inbound request). If that slice has not landed it, do it here first.
2. Allocate new BEH-EA ids (next free after the current max in spec/traceability.md) for `login`, `logout`, `whoami` + credential storage + exit codes; add matching scenarios to 26-cli.feature.
3. packages/cli/src/internal/CredentialStore.ts: `CredentialStore` Context.Service `{ get, set, clear }` with layers: macOS (`security` CLI), Linux Secret Service (`secret-tool`), Windows Credential Manager, and a fallback JSON file at `$XDG_CONFIG_HOME/awthaq/credentials.json` created with mode 0600; `AWTHAQ_TOKEN` env override layer always wins and never writes the store.
4. packages/cli/src/Login.ts: `awthaq login --token <t>` / `AWTHAQ_TOKEN` + `--base-url` / `AWTHAQ_BASE_URL` (CTA-005): validate against the server's session/principal introspection endpoint via @awthaq/client's HttpApiClient, then store. Accepts a session token or an API key (OCM-002). Interactive device flow stubbed behind a clear 'requires the DeviceAuthorization plugin' error.
5. packages/cli/src/Logout.ts (clear store; best-effort server-side revoke via the session-delete endpoint) and Whoami.ts (print Principal id/type/scopes or 'not logged in' with non-zero exit).
6. Record storage + exit-code choices in an ADR (CTA-007's ask) and update packages/cli/README.md + package header comment to list the session commands.

Files: `spec/behaviors/26-cli.md`, `spec/traceability.md`, `packages/cli/src/internal/CredentialStore.ts (new)`, `packages/cli/src/Login.ts (new)`, `packages/cli/src/Logout.ts (new)`, `packages/cli/src/Whoami.ts (new)`, `packages/cli/src/Cli.ts`, `packages/cli/package.json (@awthaq/client dep)`, `packages/cli/README.md`, `features/features/08-tooling/26-cli.feature`, `spec/decisions/018-cli-credential-storage.md (new)`

Tests:
- FIRST (red): packages/cli/test/CredentialStore.test.ts — 'file fallback writes credentials.json with mode 0600' and 'AWTHAQ_TOKEN overrides the stored credential and never writes the store'.
- packages/cli/test/Whoami.test.ts — against a TestAuth app served via HttpRouter.toWebHandler: 'whoami prints the principal for a valid token', 'exits non-zero when not logged in'.
- packages/cli/test/Login.test.ts — 'login --token rejects an invalid token and stores nothing'.

Acceptance:
- `awthaq login --token`, `logout`, `whoami` work non-interactively in CI with AWTHAQ_TOKEN/AWTHAQ_BASE_URL.
- No command starts a listener (BEH-EA-208 as amended).
- Credentials never land in a world-readable file.

Spec refs: BEH-EA-208 · Depends on: BE-003, OCM-002 · Absorbs: DAG-002, CTA-005

**Recommended status:** `ready-for-agent`

#### DAG-002 — CLI package is an empty placeholder — no login flow exists to consume a future device flow

`high` · `dx` · `cli` · [.issues/high/DAG-002-device-authorization-grant-specialist.md](../../.issues/high/DAG-002-device-authorization-grant-specialist.md) · current: `ready-for-agent`

**Verdict:** DUPLICATE of **CTA-001** (confidence: high)

Same gap and same decision (06) as CTA-001; the device-flow consumer is documented there and gated on the DeviceAuthorization plugin.

**Evidence at HEAD:**

- `packages/cli/src/index.ts:3` — Only file under packages/cli/src; the planned command list has no login/logout/whoami.

```
// doctor, plugin list --graph, routes, migration status|apply, openapi, seed admin, import — reads the plugin manifest, never runs the application.
//
// Planned first module: cli.ts (spec/behaviors/26-cli.md, BEH-EA-201–208)
// See spec/overview.md for the full package map.
//
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

**No fix of its own** — closed by the canonical issue's plan.

**Recommended status:** `resolved`

#### CTA-005 — Non-interactive CI auth is blocked on a placeholder plugin in an inactive milestone

`medium` · `dx` · `api-key` · [.issues/medium/CTA-005-cli-tool-auth-specialist.md](../../.issues/medium/CTA-005-cli-tool-auth-specialist.md) · current: `needs-triage`

**Verdict:** DUPLICATE of **CTA-001** (confidence: high)

Decision 06 already specifies the CI env-var contract (AWTHAQ_TOKEN always wins, never touches the store); the long-lived credential it holds is an API key (OCM-002). Folded into CTA-001's plan (adds AWTHAQ_BASE_URL + 26-cli.md note).

**Evidence at HEAD:**

- `packages/api-key/src/index.ts:8` — Whole file is 10 lines; no other file under packages/api-key/src.

```
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```
- `.scratch/resolve-ready-for-human-findings/issues/06-cli-login-vs-beh-ea-208.md:67`

```
**Non-interactive path**, required from day one for CI ... `awthaq login --token <service-token>` or an `AWTHAQ_TOKEN` env var
```

**No fix of its own** — closed by the canonical issue's plan.

**Recommended status:** `resolved`

### Workstream `webauthn-attestation-policy`

#### HSK-002 — Attestation conveyance ("direct"/"enterprise") exists but attestation is never verified anywhere

`medium` · `security` · `ports` · [.issues/medium/HSK-002-hardware-security-key-specialist.md](../../.issues/medium/HSK-002-hardware-security-key-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

Accurate: the knob requests attestation but no trust decision exists. BEH-EA-135 defers MDS3 but no decision covers whether the knob should do anything in the meantime — genuinely open. Canonical for TC-006 and CB-008.

**Evidence at HEAD:**

- `packages/ports/src/WebAuthn.ts:73`

```
/** BEH-EA-135: `"none"` is the default; `"direct"`/`"enterprise"` are explicit opt-in. */
export type AttestationConveyance = "none" | "direct" | "enterprise";
```
- `packages/ports/src/WebAuthn.ts:109` — No attestation format / trust verdict / userPresent surfaced, although SimpleWebAuthn returns registrationInfo.fmt.

```
export interface VerifiedRegistration {
  readonly credentialId: string;
  readonly publicKey: Uint8Array_;
  readonly counter: number;
  readonly aaguid: string;
  ...
  readonly userVerified: boolean;
}
```
- `packages/passkey/src/Passkey.ts:103` — AAGUID used only for labels; `grep -rni 'mds\|trustedAaguid' packages/*/src` → nothing.

```
const KNOWN_AAGUID_LABELS: Record<string, string> = {
```
- `spec/behaviors/17-passkey.md:139` — MDS deferred; nothing says what opting in buys.

```
REQUIREMENT: The passkey plugin's default `attestation` conveyance MUST be
             `"none"`; `"direct"` and `"enterprise"` attestation MUST be
             available only as explicit opt-in configuration
```

**Fix plan** (M): (Recommended option B) Surface attestation format and add an optional AAGUID/format trust policy; warn when conveyance is requested without a policy.

Steps:
1. WebAuthn.ts VerifiedRegistration: add `attestationFormat: string` (registrationInfo.fmt).
2. PasskeyConfig: `attestationPolicy?: { trustedAaguids: ReadonlyArray<string>; rejectSelfAttestation: boolean }`; registerVerify rejects non-conforming registrations with a new typed `PasskeyAttestationRejected` (BEH-EA-136 style).
3. Optional `attestationRootCertificates` config forwarded to SimpleWebAuthn's SettingsService (global singleton — document).
4. When attestation ≠ 'none' and no policy: log a warning once at layer build; JSDoc on PasskeyConfigShape.attestation: 'conveyance ≠ verification' (TC-006/CB-008).
5. Amend BEH-EA-135 prose; MDS3 stays deferred.

Files: `packages/ports/src/WebAuthn.ts`, `packages/passkey/src/Passkey.ts`, `packages/passkey/src/PasskeyApi.ts`, `spec/behaviors/17-passkey.md`

Tests:
- FIRST (red): packages/passkey/test/Passkey.test.ts — 'with attestationPolicy.trustedAaguids set, a none-format registration fails PasskeyAttestationRejected'.
- 'a registration from a listed AAGUID with packed attestation succeeds' (needs a packed fixture in webauthnFixtures).
- 'no policy + direct conveyance logs one warning'.

Acceptance:
- Opting into direct/enterprise can be made enforceable; without a policy the operator is told it is not.

Spec refs: BEH-EA-135, BEH-EA-136 · Depends on: — · Absorbs: TC-006, CB-008

**Needs decision** — see 'Decisions needed'. Recommendation: B — it turns a cosmetic knob into an enforceable one for the hardware-key use case with no MDS dependency, keeps BEH-EA-135's opt-in, and the warning covers operators who set the knob without a policy.

**Recommended status:** `ready-for-human`

#### TC-006 — direct/enterprise attestation accepted with nothing behind it

`low` · `compliance` · `ports` · [.issues/low/TC-006-tim-cappalli.md](../../.issues/low/TC-006-tim-cappalli.md) · current: `needs-triage`

**Verdict:** DUPLICATE of **HSK-002** (confidence: high)

Same gap as HSK-002 (direct/enterprise with nothing behind it).

**Evidence at HEAD:**

- `packages/ports/src/WebAuthn.ts:73`

```
/** BEH-EA-135: `"none"` is the default; `"direct"`/`"enterprise"` are explicit opt-in. */
export type AttestationConveyance = "none" | "direct" | "enterprise";
```

**No fix of its own** — closed by the canonical issue's plan.

**Recommended status:** `resolved`

#### CB-008 — direct/enterprise attestation conveyance exposes no trust path — the knob is currently cosmetic

`info` · `compliance` · `ports` · [.issues/info/CB-008-christiaan-brand.md](../../.issues/info/CB-008-christiaan-brand.md) · current: `needs-triage`

**Verdict:** DUPLICATE of **HSK-002** (confidence: high)

Same gap as HSK-002; its 'surface fmt/trust path' ask is step 1 of HSK-002's plan.

**Evidence at HEAD:**

- `packages/ports/src/WebAuthn.ts:109` — No attestation format / trust verdict / userPresent surfaced, although SimpleWebAuthn returns registrationInfo.fmt.

```
export interface VerifiedRegistration {
  readonly credentialId: string;
  readonly publicKey: Uint8Array_;
  readonly counter: number;
  readonly aaguid: string;
  ...
  readonly userVerified: boolean;
}
```

**No fix of its own** — closed by the canonical issue's plan.

**Recommended status:** `resolved`

#### HSK-006 — "indirect" attestation conveyance is absent from the type

`info` · `api` · `ports` · [.issues/info/HSK-006-hardware-security-key-specialist.md](../../.issues/info/HSK-006-hardware-security-key-specialist.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

Accurate, zero behaviour change today; do it with HSK-002.

**Evidence at HEAD:**

- `packages/ports/src/WebAuthn.ts:73`

```
/** BEH-EA-135: `"none"` is the default; `"direct"`/`"enterprise"` are explicit opt-in. */
export type AttestationConveyance = "none" | "direct" | "enterprise";
```
- `node_modules/.pnpm/@simplewebauthn+server@14.0.1/node_modules/@simplewebauthn/server/esm/registration/generateRegistrationOptions.d.ts:38` — The wrapped library does not accept 'indirect' — the port must set it on the returned options itself.

```
    attestationType?: 'direct' | 'enterprise' | 'none';
```

**Fix plan** (S): Add 'indirect' to AttestationConveyance.

Steps:
1. WebAuthn.ts: `AttestationConveyance = 'none' | 'indirect' | 'direct' | 'enterprise'`; registrationOptions passes `attestationType: 'none'` to the library for 'indirect' and then returns `{ ...options, attestation: input.attestation }` (PublicKeyCredentialCreationOptionsJSON.attestation accepts 'indirect'; no cast).
2. BEH-EA-135 text lists 'indirect'.

Files: `packages/ports/src/WebAuthn.ts`, `spec/behaviors/17-passkey.md`

Tests:
- FIRST (red): packages/ports/test/WebAuthn.test.ts — 'registrationOptions with attestation indirect returns options.attestation === "indirect"'.

Acceptance:
- The port's conveyance type matches the WebAuthn L3 enum.

Spec refs: BEH-EA-135 · Depends on: HSK-002

**Recommended status:** `ready-for-agent`

### Workstream `phc-hash-branding`

#### TTE-005 — PHC password hashes are unbranded strings — branding stops at entity IDs

`low` · `api` · `ports` · [.issues/low/TTE-005-typescript-type-level-engineer.md](../../.issues/low/TTE-005-typescript-type-level-engineer.md) · current: `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

Accurate type-looseness; runtime fails closed. Worth doing under the type-system-first preference, after the hasher workstreams settle the shape.

**Evidence at HEAD:**

- `packages/ports/src/PasswordHasher.ts:82`

```
export interface PasswordHasherShape {
  readonly hash: (plain: Redacted.Redacted<string>) => Effect.Effect<string>;
  readonly verify: (plain: Redacted.Redacted<string>, phc: string) => Effect.Effect<boolean>;
  readonly needsRehash: (phc: string) => boolean;
}
```
- `packages/core/src/Accounts.ts:27` — Brand idiom exists for ids but not for hashes.

```
export type AccountId = string & Brand.Brand<"AccountId">;
export const AccountId = Brand.nominal<AccountId>();
```

**Fix plan** (M): Introduce a PhcHash brand and thread it through the hasher port and credential storage.

Steps:
1. ports: `export type PhcHash = string & Brand.Brand<"PhcHash">; export const PhcHash = Brand.nominal<PhcHash>()`; hash → Effect<PhcHash>; verify/needsRehash/LegacyPasswordVerifierShape take PhcHash.
2. core Accounts: credentialHash/credentialHashes carry Redacted<PhcHash>; sql model field decodes with a Schema brand (no casts).
3. Trust-boundary minting only: migrate-auth0/ImportAuth0User.ts, migrate-better-auth, migrate-firebase import paths call `PasswordHasher.PhcHash(...)`.
4. Optional follow-through in the same PR: `SecretDigest` brand for Sessions secretHash.

Files: `packages/ports/src/PasswordHasher.ts`, `packages/core/src/Accounts.ts`, `packages/sql/src/Repositories.ts`, `packages/password/src/Password.ts`, `packages/migrate-auth0/src/ImportAuth0User.ts`

Tests:
- FIRST (red): packages/ports/test/PasswordHasher.test.ts — expectTypeOf/`// @ts-expect-error` 'verify rejects a plain string where a PhcHash is required'.
- pnpm run typecheck across all packages.

Acceptance:
- A non-PHC string cannot be passed to verify/needsRehash without an explicit mint.
- No `as` introduced.

Spec refs: BEH-EA-115 · Depends on: PHS-001, ERS-001

**Recommended status:** `ready-for-agent`

## Closed without work

| ID | Level | Verdict | Reason | Evidence |
|---|---|---|---|---|
| SCP-002 | high | DUPLICATE | Duplicate of OCM-002. Same root cause (empty api-key package). | `packages/api-key/src/index.ts:8` |
| AR-006 | low | DUPLICATE | Duplicate of MAPS-003. Same observation as MAPS-003 (machine principals unreachable); closes when MAPS-003 + OCM-002 land. | `packages/api/src/Api.ts:27` |
| TRBS-009 | info | DUPLICATE | Duplicate of OCM-002. No revocation path because no API-key credential exists. | `packages/api-key/src/index.ts:8` |
| SMS-008 | info | DUPLICATE | Duplicate of OCM-002. Informational absence note. | `packages/api-key/src/index.ts:8` |
| CTA-005 | medium | DUPLICATE | Duplicate of CTA-001. Decision 06 already specifies the CI env-var contract (AWTHAQ_TOKEN always wins, never touches the store); the long-lived credential it holds is an API key (OCM-002). | `packages/api-key/src/index.ts:8` |
| MW-006 | medium | DUPLICATE | Duplicate of BE-003. Operational CLI absence — same root as BE-003; BE-003 sub-ticket C (migration status/apply needing only a DB URL) is exactly this issue's fix. | `packages/cli/src/index.ts:3` |
| ELC-008 | info | DUPLICATE | Duplicate of BE-003. `plugin list --graph` absence; BE-003 sub-ticket B. | `packages/cli/src/index.ts:3` |
| ERS-008 | info | DUPLICATE | Duplicate of BE-003. Doctor/runtime tooling absence; BE-003 sub-ticket D grounds doctor in the same layer construction path (this issue's recommendation). | `packages/cli/src/index.ts:3` |
| RRM-011 | info | DUPLICATE | Duplicate of BE-003. seed admin absence; its specifics (AdminExists + --force, Roles required, admin role name constant, contract tests) are written into BE-003 sub-ticket E. | `packages/cli/src/index.ts:3` |
| DAG-002 | high | DUPLICATE | Duplicate of CTA-001. Same gap and same decision (06) as CTA-001; the device-flow consumer is documented there and gated on the DeviceAuthorization plugin. | `packages/cli/src/index.ts:3` |
| CTA-007 | info | WONTFIX-CANDIDATE | Positive observation, not a defect: every CLI artifact honestly declares its absence. | `packages/cli/README.md:3` |
| ACS-009 | low | DUPLICATE | Duplicate of KRS-002. Same finding as KRS-002 (single-key layerEnv makes rotation destructive). | `packages/ports/src/KeyProvider.ts:96` |
| SOS-003 | medium | DUPLICATE | Duplicate of EEM-002. Mailer half is EEM-002. | `packages/ports/src/Mailer.ts:37` |
| SOS-002 | medium | WONTFIX-CANDIDATE | True that no SmsSender port exists, but no plugin, roadmap milestone, or spec behavior consumes one, and the spec leaves SMS OTP undecided. | `packages/ports/src/index.ts:27` |
| ACS-001 | medium | DUPLICATE | Duplicate of ERS-001. Same root cause as ERS-001 (synchronous WASM KDF on the event loop, no bound, no offload); decision 35's plan closes it. | `packages/ports/src/PasswordHasher.ts:159` |
| ECF-004 | medium | DUPLICATE | Duplicate of ERS-001. Same root cause as ERS-001 (synchronous WASM KDF on the event loop, no bound, no offload); decision 35's plan closes it. | `packages/ports/src/PasswordHasher.ts:159` |
| PHS-003 | medium | DUPLICATE | Duplicate of ERS-001. Same root cause as ERS-001 (synchronous WASM KDF on the event loop, no bound, no offload); decision 35's plan closes it. | `packages/ports/src/PasswordHasher.ts:159` |
| PHS-007 | low | DUPLICATE | Duplicate of ACS-006. Same root cause and fix as ACS-006 (unclamped stored-hash parameters). | `packages/ports/src/PasswordHasher.ts:276` |
| ERS-004 | medium | DUPLICATE | Duplicate of RBS-003. Same finding as RBS-003. | `packages/ports/src/RateLimiter.ts:114` |
| CSD-007 | medium | DUPLICATE | Duplicate of RBS-004. Same root cause as RBS-004 (only an in-process store exists); RBS-004 ships the SQL store. | `packages/ports/src/RateLimiter.ts:26` |
| BPAS-004 | medium | DUPLICATE | Duplicate of CB-002. Same root cause as CB-002 (partially accurate the same way: authentication UP is enforced by the library; registration is not). | `packages/ports/src/WebAuthn.ts:204` |
| TC-006 | low | DUPLICATE | Duplicate of HSK-002. Same gap as HSK-002 (direct/enterprise with nothing behind it). | `packages/ports/src/WebAuthn.ts:73` |
| CB-008 | info | DUPLICATE | Duplicate of HSK-002. Same gap as HSK-002; its 'surface fmt/trust path' ask is step 1 of HSK-002's plan. | `packages/ports/src/WebAuthn.ts:109` |

## Cross-slice notes

- OCM-001 (oauth slice) is the same client_credentials work as MAPS-003 — decision 10 puts it in @awthaq/api-key; merge.
- CTA-002 / DAG-003 (spec slice) carry decision 06's BEH-EA-208 amendment; CTA-001 depends on it.
- BAM-001 (other slice) owns the `import` SourceAdapter mechanism that FAMS-010 and BE-003 sub-ticket F plug into.
- AOMS-001 (resolved, 60947ff) is the bcrypt verifier SAM-001 reuses.
- TMS-004's Sessions/Verification memory-layer halves touch packages/core (core slice may also carry them).
- SMS-008's TOTP-seed half belongs to the two-factor/MFA slice (decision 05).
