---
plan: 38-jws-verifier
ticket: 06
title: "jwt codec, lite verifier and plugin verify through Jws"
type: execute
wave: 2
depends_on: [02, 03, 04]
files_modified:
  - packages/jwt/src/JwtCodec.ts
  - packages/jwt/src/verify.ts
  - packages/jwt/src/Jwt.ts
  - packages/jwt/test/JwtCodec.test.ts
  - packages/jwt/test/JwsDifferential.test.ts
autonomous: true
requirements: [REQ-EA-1591, REQ-EA-1593, REQ-EA-1594, REQ-EA-1595, REQ-EA-1596]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "The jwt drift list is empty: alg-less keys verify, a sig key sharing an enc key's kid verifies, crit is refused"
    - "No caller retries by matching the string 'unknown kid'; the refetch is JwtCodec.verify's refetch input"
    - "Every existing JwtCodec.verify call site (AuthHttp, KeyRing, RemoteSigning, JwtCodec tests) compiles and passes unchanged"
    - "The ticket-01 characterization (peer-minted key of a new algorithm) stays green"
    - "@awthaq/jwt/verify still imports no core/server/sql/api, no ./Jwt.ts, no ./KeyRing.ts; EdgeImports.test.ts is green"
    - "Asserted reason strings are unchanged: 'algorithm not allowed', 'typ mismatch', 'jwks fetch failed'"
  artifacts:
    - path: packages/jwt/src/JwtCodec.ts
      provides: "sign side + claim policy; verify delegates to Jws.verify / Jws.timeProblem; aliases Algorithm/isAlgorithm/AlgorithmLiterals/keyTypeFor"
    - path: packages/jwt/src/verify.ts
      provides: "lite verifier passing keys.refreshOnMiss as refetch"
  key_links:
    - from: packages/jwt/src/JwtCodec.ts
      to: packages/ports/src/Jws.ts
      via: "Jws.verify with requireKid: true; Jws.webCryptoParams for localSigner"
    - from: packages/jwt/src/Jwt.ts
      to: packages/jwt/src/JwtCodec.ts
      via: "verifyWith: refetch = keyRefresh.refreshOnMiss then verifiableKeys; algorithms = Jws.algorithms"
---
Status: done (uncommitted)
Blocked by: 02, 03, 04

<objective>
Move the jwt codec and its two callers (the lite verifier and the plugin's verify) onto `Jws`. Delete the jwt copy of key selection, signature verification, time judgement and the string-matched retries.

Purpose: B2 and B3 are fixed here for jwt, and the three-way refetch becomes one input (PLAN.md §3.4).

Output: a smaller `JwtCodec.ts`, a lite verifier with no `catchIf`, a plugin `verifyWith` with no `catchIf`, 11 fewer `JwtCodec.test.ts` tests (moved to ports in ticket 04), and an empty jwt drift list.
</objective>

<context>
@.planning/38-jws-verifier/PLAN.md (§2.5 edge safety, §3.4 "jwt codec", "Lite verifier", "jwt plugin", Q6)
@packages/jwt/src/JwtCodec.ts
@packages/jwt/src/verify.ts
@packages/jwt/src/Jwt.ts (lines 725-790)
@packages/jwt/src/KeyRing.ts (line 288 keyTypeFor), packages/jwt/src/SigningKeyRecords.ts (lines 65-66), packages/jwt/src/JwtConfig.ts (line 23): the alias consumers that must not change
@packages/ports/src/Jws.ts
@packages/next/test/EdgeImports.test.ts
@packages/jwt/test/JwsDifferential.test.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: JwtCodec.verify delegates to Jws; the table moves out</name>
  <files>packages/jwt/src/JwtCodec.ts, packages/jwt/test/JwtCodec.test.ts</files>
  <read_first>packages/jwt/src/JwtCodec.ts, packages/ports/src/Jws.ts, packages/jwt/test/JwtCodec.test.ts</read_first>
  <action>
In `JwtCodec.ts`, import `Jws` from `@awthaq/ports`. `@awthaq/jwt` already depends on it, and `verify.ts:40` already imports from it.

Aliases, one line each, so `JwtConfig.ts`, `SigningKeyRecords.ts` and `KeyRing.ts` stay untouched:
- the `Algorithm` type is `Jws.Algorithm`;
- `isAlgorithm` is `Jws.isAlgorithm`;
- `AlgorithmLiterals` is `Jws.Algorithm`;
- `keyTypeFor` is `Jws.keyType`.

Delete the local `AlgorithmSchema`, the `AlgorithmSpec` interface and `specs`. Keep a local `generateParams` table keyed by `Algorithm`, with `rsaGenerate`, for `generateKeyJwks`. `localSigner` reads `Jws.webCryptoParams(alg)` for its import and sign parameters.

`VerificationKey.alg` becomes optional.

Rewrite `verify` over `Jws`, per PLAN.md §3.4 steps 1–6:
- It becomes generic in the error of a new optional input member `refetch?: Effect.Effect<ReadonlyArray<VerificationKey>, E>`, with the default `E` being `never`.
- Step 1: the typ check with `peekTyp`, before any crypto.
- Step 2: `Jws.verify`, with a `KeySource` built from `keys` and `refetch`, and `requireKid: true`. A key set entry is the public JWK spread first, then `kid`, then `alg` only when the key has one.
- Step 3: `Schema.decodeUnknownEffect(RegisteredClaims)` on the verified payload, failing with "malformed token".
- Step 4: `iss`/`aud`.
- Step 5: `Jws.timeProblem` with `nowMs` from `DateTime.now` and `skewMs` from `clockSkew`.
- Step 6: `requireSubject`.

Map `Jws/Rejected` to `JwtInvalidError` with the reasons in PLAN.md §3.4:
- `malformed` → "malformed token";
- `crit` → "critical header not understood";
- `alg` and `key-mismatch` → "algorithm not allowed";
- `missing-kid` → "missing kid";
- `unknown-kid` → "unknown kid";
- `signature` → "bad signature".

Delete `parse`, `decodeHeader`, `decodePayload`, `verifySignature` and the header schema's verify use. Keep `HeaderSchema` only if `peekTyp` still needs it.

Update the header comment: verification rules are `Jws` (ADR-EA-057); this module keeps signing and the jwt claim policy. Keep the import-freedom sentence and extend it: "the only workspace import is `@awthaq/ports`".

In `JwtCodec.test.ts`, delete the 11 tests that moved to `ports/test/Jws.test.ts` (PLAN.md §5.1):
- "an RS256 header against an ES256-only key fails";
- "a token with nbf in the future fails";
- "a token with iat far in the future fails, clockSkew forgives a little";
- the three JJS-003 tests;
- the five JJS-009 tests.

Delete the `describe` blocks they leave empty and any helper left unused (`withHeader`, `b64`, if so). Keep the 14 others, unchanged.
  </action>
  <verify><automated>npx vitest run packages/jwt/test/JwtCodec.test.ts packages/jwt/test/AuthHttp.test.ts packages/jwt/test/KeyRing.test.ts packages/jwt/test/RemoteSigning.test.ts</automated></verify>
  <acceptance_criteria>
- `npx vitest run packages/jwt/test/JwtCodec.test.ts` reports 14 tests (baseline at HEAD: 25).
- `grep -c 'subtle\.verify(' packages/jwt/src/JwtCodec.ts` = 0 (baseline at HEAD: 1).
- `grep -c 'RSASSA-PKCS1-v1_5' packages/jwt/src/JwtCodec.ts` = 0 (baseline at HEAD: 3).
- `git diff --stat packages/jwt/test/AuthHttp.test.ts packages/jwt/test/KeyRing.test.ts packages/jwt/test/RemoteSigning.test.ts packages/jwt/src/KeyRing.ts packages/jwt/src/SigningKeyRecords.ts packages/jwt/src/JwtConfig.ts` is empty, relative to the commit before this ticket.
  </acceptance_criteria>
  <done>The jwt codec keeps signing and claim policy only. Every existing call site still compiles and passes.</done>
</task>

<task type="auto">
  <name>Task 2: Lite verifier and plugin verify pass refetch; string-matched retries deleted</name>
  <files>packages/jwt/src/verify.ts, packages/jwt/src/Jwt.ts</files>
  <read_first>packages/jwt/src/verify.ts, packages/jwt/src/Jwt.ts (lines 725-790)</read_first>
  <action>
In `verify.ts`:
- `JwksDocumentSchema` becomes `Jws.JwkSet`; delete the local schema.
- `toVerificationKeys` keeps every entry with a string `kid`. It sets `alg` only when `JwtCodec.isAlgorithm` holds for the entry's `alg`, and `publicKeyJwk` is the whole entry, so `use`/`key_ops`/`alg` reach `Jws`' selection. It no longer drops `alg`-less entries.
- `verify` reads the current keys with `keys.get` and calls `JwtCodec.verify` with them, plus `refetch: keys.refreshOnMiss`.
- Delete the `Effect.catchIf` on the "unknown kid" reason.
- `VerifierOptions`, `Verifier` and `SESSION_MIRROR_COOKIE_NAME` are unchanged.
- Update the header comment: it now imports `Jws`/`RefreshingCache` from `@awthaq/ports`, and selection follows RFC 7517 (`alg` optional; `use`/`key_ops` honoured).

In `Jwt.ts` `verifyWith`:
- Pass `refetch` as `keyRefresh.refreshOnMiss` followed by `verifiableKeys`, mapped to `{ kid, alg, publicKeyJwk }`.
- Pass `algorithms: Jws.algorithms`.
- Delete the `Effect.catchIf` block (lines 763-767 at HEAD) and the `Array.from(new Set(...))` allowlist.

Add a two-line comment where `algorithms` is passed. Line 1: "every ring key declares its alg and Jws requires equality, so the accepted algorithms are exactly those of the keys present". Line 2: "the allowlist must not be computed before the refetch, or a peer's key of a new algorithm is refused (plan 38 Q6)".

Then remove the six remaining jwt drift names in `JwsDifferential.test.ts` (`alg-less-okp`, `alg-less-rsa`, `enc-key-shares-kid`, `crit-unknown`; the two B1 names went in ticket 02). The list must be empty.
  </action>
  <verify><automated>npx vitest run packages/jwt packages/next/test/EdgeImports.test.ts packages/next/test/Edge.test.ts</automated></verify>
  <acceptance_criteria>
- `sed -n '/^const driftList/,/^\]/p' packages/jwt/test/JwsDifferential.test.ts | grep -c '^  "'` = 0 (baseline after ticket 02: 4).
- `grep -rn 'reason === "unknown kid"' packages/*/src | wc -l` = 0 (baseline at HEAD: 2).
- `grep -rn 'const JwksDocumentSchema' packages/*/src | wc -l` = 0 (baseline at HEAD: 2; ticket 05 removes the oauth one).
- `grep -E '^import' packages/jwt/src/verify.ts packages/jwt/src/JwtCodec.ts | grep -cE '@awthaq/(core|server|sql|api)|\./(Jwt|KeyRing)\.ts'` = 0 (baseline at HEAD: 0; must stay).
- The ticket-01 characterization test in `Jwt.test.ts` (peer-minted key of a new algorithm) passes.
- `verifyForeignIssuer.test.ts` still asserts the reason "algorithm not allowed" and passes.
  </acceptance_criteria>
  <done>All three jwt verification paths run through `Jws`. Both drift lists are empty.</done>
</task>

<task type="auto">
  <name>Task 3: One WebCrypto verify site, repo-wide</name>
  <files>packages/jwt/src/JwtCodec.ts</files>
  <read_first>PLAN.md §5.5</read_first>
  <action>
Run the plan's measurable-target greps (PLAN.md §5.5) and record each result in this ticket's Comments. If any target misses, fix it in the file it names. The only expected edit is in `JwtCodec.ts`, should a leftover helper remain. Do not edit `Jws.ts` here; a defect found in it reopens ticket 04.
  </action>
  <verify><automated>test "$(grep -rln 'subtle\.verify(' packages/*/src)" = "packages/ports/src/Jws.ts" && test "$(grep -rln 'RSASSA-PKCS1-v1_5' packages/*/src)" = "packages/ports/src/Jws.ts"</automated></verify>
  <acceptance_criteria>Both greps name exactly `packages/ports/src/Jws.ts` (baseline at HEAD: `packages/jwt/src/JwtCodec.ts` and `packages/oauth/src/Jwt.ts`). This requires ticket 05 to have landed; if it has not, record the jwt half and re-run after 05.</acceptance_criteria>
  <done>G1 from PLAN.md §1.3 holds.</done>
</task>

</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| request/cookie → JwtCodec.verify | bearer token, introspection body and session-mirror cookie |
| downstream JWKS → lite verifier | network-fetched issuer key set, possibly a foreign issuer's (FAMS-005) |
| shared store → plugin key ring | keys minted, imported or registered by any process |

## STRIDE threat register

| Threat ID | Category | Target | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-38-16 | Spoofing | plugin allowlist = `Jws.algorithms` | high | mitigate | Every ring key declares `alg` (minted, imported, registered; served since ticket 03); `Jws` requires key `alg` == header `alg`; the per-key cases moved to `Jws.test.ts` plus the characterization test pin it |
| T-38-17 | Spoofing | `alg`-less foreign keys in the lite verifier | medium | mitigate | Usable only for an allowlisted `alg` its `kty`/`crv` fits (ADR-EA-057 d2; Q1 records the stricter RSA reading) |
| T-38-18 | Elevation of privilege | token class confusion | high | mitigate | `typ` is still checked with `peekTyp` before `Jws.verify` (BEH-EA-294); `JwtTokenClasses.test.ts` stays green |
| T-38-19 | Denial of service | forced refetch | medium | mitigate | `refetch` runs only on `unknown-kid`, through the caller's `RefreshingCache` (`minRefetchInterval`); `verifyCache.test.ts` stays green |
| T-38-20 | Tampering | edge bundle reach | medium | mitigate | `EdgeImports.test.ts` and the import grep gate keep `@awthaq/jwt/verify` free of core/server |
</threat_model>

<verification>
npx vitest run packages/jwt packages/next
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm check:error-tags && pnpm package:smoke
</verification>

<success_criteria>
- The jwt drift list is 0; `JwtCodec.test.ts` has 14 tests; no string-matched retry remains.
- `EdgeImports.test.ts`, `Edge.test.ts`, `verify*.test.ts`, `KeyRing.test.ts`, `RemoteSigning.test.ts` and `AuthHttp.test.ts` pass.
- `pnpm package:smoke` passes (`@awthaq/jwt`'s declarations now name `@awthaq/ports`' `Jws` types).
</success_criteria>

## Comments

Result (uncommitted). `JwtCodec.verify` now delegates to `Jws.verify` (requireKid) and `Jws.timeProblem`; it is generic in a new optional `refetch` input. The lite verifier passes `keys.refreshOnMiss` as `refetch` and keeps alg-less keys; the plugin's `verifyWith` passes `Jws.algorithms` plus a refetch (`keyRefresh.refreshOnMiss` then `verifiableKeys`). Both `catchIf("unknown kid")` retries are gone. The jwt drift list is empty. The Q6 test is a plain `it.effect` now. `peekTyp` runs before any crypto; a non-parsable token now reports "typ mismatch" instead of "malformed token" (still refused, no test asserts it).
Tests: `JwtCodec.test.ts` 14 tests. Deleted the 11 moved to ports. The two "malformed exp" tests used to forge an unsigned payload; since signature now precedes claim decode, they sign the forged payload via a `signRaw` helper (same assertions). `npx vitest run packages/jwt packages/ports`: 515 pass; `tsc -p tsconfig.test.json` clean; circular clean.
Task 3 greps: `subtle.verify(` is only in ports/src/Jws.ts; `RSASSA-PKCS1-v1_5` is in Jws.ts plus JwtCodec.ts:124, a generateKey param in `generateParams` (needed for RS256 key generation, not a verify site). `reason === "unknown kid"` in src: 0. `JwksDocumentSchema` in src: 0. Import gate: 0. Not run (not allowed): EdDSA edge tests in packages/next, lint, knip, package:smoke. The oauth `RSASSA` copy is ticket 05's.
