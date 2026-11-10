---
plan: 38-jws-verifier
ticket: 05
title: "OIDC id_token verifies through Jws"
type: execute
wave: 2
depends_on: [04]
files_modified:
  - packages/oauth/src/IdToken.ts
  - packages/oauth/src/OAuthProvider.ts
  - packages/oauth/src/Jwt.ts
  - packages/oauth/test/Jwt.test.ts
  - packages/oauth/test/JwsDifferential.test.ts
autonomous: true
requirements: [REQ-EA-1591, REQ-EA-1594, REQ-EA-1595, REQ-EA-1596]
estimate: {tasks: 2, size: M}
must_haves:
  truths:
    - "IdToken.verify's signature, its JWKS fetch, its per-provider cache, its claim order and its logged reasons are unchanged"
    - "An id_token with a crit header, or signed by a key whose key_ops lacks verify, fails with OAuthCallbackFailed"
    - "A disallowed header alg still fails before any JWKS fetch"
    - "oauth/src/Jwt.ts and oauth/test/Jwt.test.ts no longer exist; JwtVerificationError appears nowhere in packages/*/src"
  artifacts:
    - path: packages/oauth/src/IdToken.ts
      provides: "fetch + cache + OIDC claim policy over Jws.verify and Jws.timeProblem"
  key_links:
    - from: packages/oauth/src/IdToken.ts
      to: packages/ports/src/Jws.ts
      via: "Jws.verify({ token, keys: cache, algorithms: provider.idTokenSigningAlgs, requireKid: false })"
    - from: packages/oauth/src/OAuthProvider.ts
      to: packages/ports/src/Jws.ts
      via: "idTokenSigningAlgs: ReadonlyArray<Jws.Algorithm>; Jws.algorithms replaces SIGNING_ALGS"
---
Status: ready-for-agent
Blocked by: 04

<objective>
Move the OIDC caller onto `Jws` and delete the OIDC copy of JWS verification.

Purpose: the OIDC copy keeps only its policy: issuer, subject, audience/`azp`, nonce, `maxIdTokenAge`, an optional `kid`, its JWKS fetch with the EEM-004 error split, and its cache (PLAN.md §3.4).

Output: a smaller `IdToken.ts`, a deleted `oauth/src/Jwt.ts`, a deleted `oauth/test/Jwt.test.ts` (its 20 cases now live in `ports/test/Jws.test.ts`), and an empty oauth drift list.
</objective>

<context>
@.planning/38-jws-verifier/PLAN.md (§3.4 "OIDC", §5.3)
@packages/oauth/src/IdToken.ts
@packages/oauth/src/OAuthProvider.ts (lines 22, 110-120, 155-165, 365-400)
@packages/oauth/src/CallbackFailure.ts (CallbackFailureReason, callbackFailed, providerFailure)
@packages/oauth/src/ProviderHttp.ts (decodeBody)
@packages/ports/src/Jws.ts
@packages/oauth/test/JwsDifferential.test.ts
@packages/oauth/test/OAuth.test.ts (the id_token tests between lines 2032 and 3110 must pass unchanged)
</context>

<tasks>

<task type="auto">
  <name>Task 1: IdToken.verify over Jws; OAuthProvider types over Jws.Algorithm</name>
  <files>packages/oauth/src/IdToken.ts, packages/oauth/src/OAuthProvider.ts, packages/oauth/test/JwsDifferential.test.ts</files>
  <read_first>packages/oauth/src/IdToken.ts, packages/oauth/src/OAuthProvider.ts, packages/ports/src/Jws.ts</read_first>
  <action>
First remove `key-ops-encrypt-only` and `crit-unknown` from `driftList` in `packages/oauth/test/JwsDifferential.test.ts`, and run it: two failures (RED).

In `IdToken.ts`:
- Import `Jws` from `@awthaq/ports` (already a dependency; `RefreshingCache` is imported from there at line 13).
- The cache type becomes `RefreshingCache.RefreshingCache<Jws.JwkSet, JwksFailure>`.
- `fetchJwks` decodes with `ProviderHttp.decodeBody(Jws.JwkSet)`; the rest of its pipe is unchanged.
- Delete the `Jwt.decode` call, the header-`alg` allowlist check, the `findKey` call with its refetch `catch`, and the `verifySignature` call (lines 182-232 at HEAD). In their place, one `Jws.verify` with:
  - the id_token;
  - `keys` set to the cache, which satisfies `KeySource` structurally;
  - `algorithms` set to `provider.idTokenSigningAlgs`;
  - `requireKid: false`.
- Keep the `jwksUri` presence check and the cache creation through `jwksCaches.forProvider` before the call.
- Map a `Jws/Rejected` failure with `Effect.catchTag` to `CallbackFailure.callbackFailed`:
  - `malformed` and `crit` give `"jwt-malformed"`, with the detail equal to the Jws reason;
  - `alg` gives `"alg"` with no detail. `JwsRejected` carries only its reason, so the header value the old log line printed is dropped; the reason itself is unchanged;
  - `unknown-kid` and `key-mismatch` give `"kid"`;
  - `signature` gives `"signature"`;
  - `missing-kid` cannot occur under `requireKid: false`. Map it to `"kid"` so the match stays exhaustive with no `never` assertion.
- JWKS failures (`OAuthCallbackFailed` and `ProviderUnavailable`) pass through untouched.

In `claimProblem`:
- Replace the hand-written `exp`, `nbf` and `iat`-future checks with one call to `Jws.timeProblem(claims, { nowMs: expected.nowMs, skewMs: expected.skewMs })` at the same position: after `aud`/`azp`, before nonce. Return its value when defined.
- Keep the `maxIdTokenAge` branch, both the missing-`iat` arm and the too-old arm, right after it.
- The module header comment loses "RS256 signature against the provider's JWKS (`Jwt.ts`)" and says the JWS step is `@awthaq/ports`'s `Jws` (ADR-EA-057).

In `OAuthProvider.ts`:
- Replace the `./Jwt.ts` import with `Jws` from `@awthaq/ports`.
- `idTokenSigningAlgs` becomes `ReadonlyArray<Jws.Algorithm>` on both interfaces.
- `Jwt.SIGNING_ALGS` becomes `Jws.algorithms` in the three places at lines 374-381. Same order, so the boot defect message is byte-identical.
  </action>
  <verify><automated>npx vitest run packages/oauth/test/JwsDifferential.test.ts packages/oauth/test/OAuth.test.ts packages/oauth/test/OAuthPresets.test.ts packages/oauth/test/OAuthProviderConfig.test.ts</automated></verify>
  <acceptance_criteria>
- `sed -n '/^const driftList/,/^\]/p' packages/oauth/test/JwsDifferential.test.ts | grep -c '^  "'` = 0 (baseline after ticket 01: 2).
- Every test in `OAuth.test.ts` passes with no edit to that file: `git diff --stat packages/oauth/test/OAuth.test.ts` is empty.
- `grep -c 'Jws\.timeProblem' packages/oauth/src/IdToken.ts` = 1 and `grep -c 'Jws\.verify' packages/oauth/src/IdToken.ts` = 1.
  </acceptance_criteria>
  <done>The OIDC caller verifies through `Jws` with its policy and logged reasons intact. The oauth drift list is empty.</done>
</task>

<task type="auto">
  <name>Task 2: Delete the OIDC copy and its tests</name>
  <files>packages/oauth/src/Jwt.ts, packages/oauth/test/Jwt.test.ts</files>
  <read_first>packages/ports/test/Jws.test.ts (confirm the 20 moved cases are there, by their ACS-004/AH-001/AOMS-005 names)</read_first>
  <action>
- Delete `packages/oauth/src/Jwt.ts`, and delete `packages/oauth/test/Jwt.test.ts` (replace, don't layer: its 20 cases run against `Jws` in `packages/ports/test/Jws.test.ts`).
- Grep `packages/oauth` for any remaining `./Jwt.ts` import or `Jwt.` member use, and fix each one onto `Jws`.
- Leave `packages/oauth/test/FakeProvider.ts` unchanged.
  </action>
  <verify><automated>test ! -e packages/oauth/src/Jwt.ts && test ! -e packages/oauth/test/Jwt.test.ts && test "$(grep -rn 'JwtVerificationError' packages/*/src | wc -l | tr -d ' ')" = 0</automated></verify>
  <acceptance_criteria>
- Both files are gone (baseline at HEAD: both exist).
- `grep -rn 'JwtVerificationError' packages/*/src | wc -l` = 0 (baseline at HEAD: 13).
- `grep -rln 'RSASSA-PKCS1-v1_5' packages/oauth/src | wc -l` = 0 (baseline at HEAD: 1).
- `pnpm check:error-tags` passes.
  </acceptance_criteria>
  <done>No JWS verification code remains in `@awthaq/oauth`.</done>
</task>

</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| provider → callback (`id_token`) | the token arrives from the token endpoint; its header and claims are untrusted until verified |
| provider JWKS → cache | network-fetched, schema-decoded by `ProviderHttp.decodeBody(Jws.JwkSet)` |

## STRIDE threat register

| Threat ID | Category | Target | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-38-12 | Spoofing | `id_token` signature | critical | mitigate | Same allowlist (`idTokenSigningAlgs`), now under `Jws`'s stricter selection (`key_ops`, `crit`); the AOMS-005, OIT-009 and tamper tests in `OAuth.test.ts` stay green unchanged |
| T-38-13 | Denial of service | JWKS fetch on a refused `alg` | low | mitigate | `Jws.verify` checks `alg` before calling `KeySource.get`, so a refused algorithm still costs no fetch (refetch contract test in ticket 04) |
| T-38-14 | Repudiation | operator diagnostics | low | mitigate | The logged `CallbackFailureReason` set is unchanged; `crit` is logged as `jwt-malformed` with detail `crit` |
| T-38-15 | Information disclosure | wire answer | low | accept | Every failure remains the field-less `OAuthCallbackFailed` (BEH-EA-127) |
</threat_model>

<verification>
npx vitest run packages/oauth
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm check:error-tags
</verification>

<success_criteria>
- The oauth drift list is 0; `OAuth.test.ts` is untouched and green.
- `packages/oauth/src/Jwt.ts` is deleted; no `JwtVerificationError` remains.
</success_criteria>

## Comments
