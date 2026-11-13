---
plan: 38-jws-verifier
ticket: 01
title: Red tests for B1–B5 and the differential vector table
type: tdd
wave: 0
depends_on: []
files_modified:
  - packages/ports/test/jwsVectors.ts
  - packages/jwt/test/JwsDifferential.test.ts
  - packages/oauth/test/JwsDifferential.test.ts
  - packages/jwt/test/AuthHttp.test.ts
  - packages/jwt/test/Jwt.test.ts
autonomous: true
requirements: [REQ-EA-1590, REQ-EA-1591, REQ-EA-1592, REQ-EA-1593, REQ-EA-1594, REQ-EA-1595]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "One vector table is consumed unchanged by the jwt runner, the oauth runner and (later) ports/test/Jws.test.ts"
    - "At HEAD the jwt runner's drift list holds exactly 6 names and the oauth runner's exactly 2, and every test passes (drift rows as it.effect.fails)"
    - "B1 (introspection of a non-base64url token) and B4 (remote key served without kid/alg) are expected-failure tests that pass at HEAD"
    - "A characterization test proves a peer-minted key of a new algorithm verifies through Jwt.verify after one forced refresh, and it is green at HEAD"
  artifacts:
    - path: packages/ports/test/jwsVectors.ts
      provides: "vectors: ReadonlyArray<Vector>, NOW_MS, ISSUER, AUDIENCE, NONCE, SKEW_MS"
    - path: packages/jwt/test/JwsDifferential.test.ts
      provides: "the vectors through Verify.makeVerifier, driftList"
    - path: packages/oauth/test/JwsDifferential.test.ts
      provides: "the vectors through IdToken.verify, driftList"
  key_links:
    - from: packages/jwt/test/JwsDifferential.test.ts
      to: packages/ports/test/jwsVectors.ts
      via: "relative import ../../ports/test/jwsVectors.ts (precedent: passkey tests import ../../ports/test/webauthnFixtures.ts)"
    - from: packages/oauth/test/JwsDifferential.test.ts
      to: packages/oauth/src/IdToken.ts
      via: "IdToken.verify with a literal ResolvedProvider and FakeProvider.fakeHttpClient"
---
Status: done (uncommitted)
Blocked by: none

<objective>
Turn every bug in PLAN.md §2.4 into a test before anything is fixed, and build the one vector table that both callers run before the merge and after it.

Purpose: B1 and B2 were confirmed by running the code. B3, B4 and B5 were confirmed only by reading. The drift between the two copies must become measurable (the drift lists) before the deepening, so that "same verdict" is a gate and not a claim.

Output: a vector table in `packages/ports/test/`, two differential runners, two expected-failure tests in jwt, and one characterization test. The tree stays green: rows that currently diverge run as `it.effect.fails`.
</objective>

<context>
@.planning/38-jws-verifier/PLAN.md (§2.3, §2.4, §5)
@packages/oauth/test/Jwt.test.ts (lines 130-210: how node:crypto keys sign JWS for all five algorithms; reuse that technique)
@packages/jwt/test/verifyForeignIssuer.test.ts (lines 16-28: jwksClient, a fake HttpClient serving a JWKS)
@packages/oauth/test/FakeProvider.ts (fakeHttpClient)
@packages/oauth/src/IdToken.ts (VerifyInput, makeJwksCaches)
@packages/oauth/src/OAuthProvider.ts (lines 147-165: ResolvedProvider is a plain interface)
@packages/jwt/src/verify.ts (VerifierOptions)
@packages/jwt/test/AuthHttp.test.ts (how a signed-in caller calls POST /jwt/introspect)
@packages/jwt/test/Jwt.test.ts (buildLayer at line 34)
@packages/jwt/test/RemoteSigning.test.ts (lines 20-45 and 84-113: a remote key with a raw public JWK)
@packages/jwt/test/KeyRing.test.ts (lines 176-190: anotherProcess, KRS-006 convergence)
</context>

<tasks>

<task type="tdd">
  <name>Task 1: The vector table</name>
  <files>packages/ports/test/jwsVectors.ts</files>
  <read_first>packages/oauth/test/Jwt.test.ts, packages/jwt/test/JwtCodec.test.ts (lines 73-85, withHeader/b64 helpers)</read_first>
  <action>
Create `packages/ports/test/jwsVectors.ts`. It is plain test data and must not import from `@awthaq/jwt`, `@awthaq/oauth` or a not-yet-existing `Jws`. It imports only `node:crypto` and `node:buffer`.

Export these constants:
- `NOW_MS = 1_700_000_000_000`, and `NOW_S` as the same value in seconds;
- `ISSUER = "https://idp.test"`, `AUDIENCE = "client-1"`, `NONCE = "n-1"`, `SKEW_MS = 60_000`;
- `JWKS_URL = "https://idp.test/jwks"`.

Export a local union type `VectorAlg` of the five algorithm names (RS256, PS256, ES256, ES384, EdDSA). Export an interface `Vector` with:
- `name: string`;
- `token: string`;
- `jwks: { keys: ReadonlyArray<Record<string, unknown>> }`;
- `algorithms: ReadonlyArray<VectorAlg>`;
- `expected: "accept" | "reject"` (the RFC-correct verdict after this plan);
- `jwsReason?: "malformed" | "crit" | "alg" | "missing-kid" | "unknown-kid" | "key-mismatch" | "signature"` (the `Jws`-level reason ticket 04 asserts);
- `timeProblem?: "exp" | "nbf" | "iat"`;
- `policy?: { jwt?: "accept" | "reject"; oauth?: "accept" | "reject" }` (a caller-policy override, not drift).

Export `vectors: ReadonlyArray<Vector>`, built synchronously at module load. Keys come from `generateKeyPairSync` (RSA 2048 for RS256/PS256, EC P-256, EC P-384, Ed25519). Public JWKs come from `KeyObject.export({ format: "jwk" })`. Signatures come from `crypto.sign`:
- `dsaEncoding: "ieee-p1363"` for EC;
- `padding: constants.RSA_PKCS1_PSS_PADDING` with `saltLength: 32` for PS256;
- a null digest for Ed25519.

So no vector depends on either verifier's signing code. Default header: `{ alg, kid: "k-<alg lowercase>", typ: "JWT" }`. Default claims:
- `iss` ISSUER, `aud` AUDIENCE, `sub` "user-1", `nonce` NONCE;
- `iat` NOW_S, `exp` NOW_S + 600;
- all integers.

Default JWK: the public JWK plus `kid`, `alg` and `use: "sig"`. A row's `jwks` is `{ keys: [default JWK of the key its token names] }` and its `algorithms` is `[that key's alg]`, unless the row says otherwise.

The rows, with their name, construction, expected verdict and jwsReason or timeProblem:
1. `valid-rs256`, `valid-ps256`, `valid-es256`, `valid-es384`, `valid-eddsa`: default key and token, algorithms equal to that one algorithm. Accept.
2. `alg-less-okp`: an EdDSA key whose JWK omits `alg`. Accept.
3. `alg-less-rsa`: an RS256 key whose JWK omits `alg`, algorithms `["RS256"]`. Accept.
4. `enc-key-shares-kid`: the set is `[{ another RSA public key, kid "k-rs256", alg "RS256", use "enc" }, { the signing key, kid "k-rs256", alg "RS256", use "sig" }]`, in that order. Accept.
5. `enc-only`: the set holds only the signing key's JWK with `use: "enc"`. Reject, `unknown-kid`.
6. `key-ops-encrypt-only`: the set holds the signing key's JWK with `key_ops: ["encrypt"]` and no `use`. Reject, `unknown-kid`.
7. `crit-unknown`: header adds `crit: ["x-unknown"]` and `x-unknown: true`, correctly signed. Reject, `crit`.
8. `sig-not-base64url`: a valid token whose third segment is replaced by two exclamation marks. Reject, `malformed`.
9. `header-not-base64url`: a valid token whose first segment gets an exclamation mark prepended. Reject, `malformed`.
10. `alg-not-allowed`: an ES256 token, algorithms `["EdDSA"]`. Reject, `alg`.
11. `alg-none`: header alg `none`, empty third segment. Reject, `alg`.
12. `alg-hs256`: header alg `HS256` with kid `k-rs256`, signed with HMAC-SHA256 keyed by the JSON of the RSA public JWK, algorithms `["RS256"]`. Reject, `alg`.
13. `unknown-kid`: a valid EdDSA token whose kid is `k-missing`. Reject, `unknown-kid`.
14. `key-alg-mismatch`: a PS256-signed token whose kid names an RSA JWK carrying `alg: "RS256"`, algorithms `["RS256", "PS256"]`. Reject, `key-mismatch`.
15. `curve-mismatch`: an EC P-384 key whose JWK omits `alg`, a header alg ES256 with that kid (the signature is irrelevant), algorithms `["ES256"]`. Reject, `key-mismatch`.
16. `tampered-payload`: a valid EdDSA token whose payload segment is re-encoded with `sub` "user-admin". Reject, `signature`.
17. `expired`: exp NOW_S − 120. Reject, timeProblem `exp`.
18. `expired-within-skew`: exp NOW_S − 30. Accept.
19. `nbf-future`: nbf NOW_S + 120. Reject, timeProblem `nbf`.
20. `iat-future`: iat NOW_S + 120. Reject, timeProblem `iat`.
21. `kid-less`: an EdDSA token whose header has no kid, against a one-key set. Accept, policy `{ jwt: "reject" }`.
22. `typ-less`: an EdDSA token whose header has no typ. Accept, policy `{ jwt: "reject" }`.

The time rows use EdDSA. Use no `as` casts. Narrow the `export` result of `KeyObject` with a plain object spread.
  </action>
  <verify><automated>node --input-type=module -e "const m = await import('./packages/ports/test/jwsVectors.ts'); if (m.vectors.length !== 26 || new Set(m.vectors.map((v) => v.name)).size !== 26) { console.error(m.vectors.length); process.exit(1) }"</automated></verify>
  <acceptance_criteria>
- The node check above prints nothing and exits 0: 26 vectors with unique names. Baseline at HEAD: the module does not exist, so the check fails. Node 26 strips the TypeScript types natively; the file must therefore use only erasable syntax (no enums, no parameter properties).
- Type correctness is proven in task 2, when the runners import the file into the `tsconfig.test.json` program (`pnpm typecheck`).
- No import from `@awthaq/*` in the file: `grep -c '@awthaq/' packages/ports/test/jwsVectors.ts` = 0.
  </acceptance_criteria>
  <done>The table compiles under `tsconfig.test.json` and builds 26 vectors at import time with no network and no clock read.</done>
</task>

<task type="tdd">
  <name>Task 2: Both differential runners, drift marked as expected failures</name>
  <files>packages/jwt/test/JwsDifferential.test.ts, packages/oauth/test/JwsDifferential.test.ts</files>
  <read_first>packages/jwt/test/verifyForeignIssuer.test.ts, packages/oauth/test/FakeProvider.ts, packages/oauth/src/IdToken.ts</read_first>
  <action>
Each runner declares its drift list exactly as a top-level `const driftList: ReadonlyArray<string> = [`, one quoted vector name per line indented two spaces, and a closing `];` in column 0. The plan's count gate parses that shape. For every vector the runner registers a test: `it.effect.fails` when `driftList` includes its name, `it.effect` otherwise. Each test first sets the TestClock to `NOW_MS` with `TestClock.setTime`. The expected caller verdict is the vector's policy entry for that caller when present, otherwise `expected`. The runner obtains the outcome with `Effect.result`, so a defect is never converted into a pass in the normal mode. Then:
- an accept verdict asserts `Result.isSuccess`;
- a reject verdict asserts `Result.isFailure` and that the failure's `_tag` is the caller's typed error.

jwt runner (`packages/jwt/test/JwsDifferential.test.ts`):
- Build `Verify.makeVerifier` with:
  - jwksUrl `JWKS_URL`, issuer `ISSUER`, audience `AUDIENCE`;
  - algorithms from the vector, expectedTyp `"JWT"`, clockSkew `"60 seconds"`;
  - a fake `HttpClient` that serves the vector's `jwks`, built like `jwksClient` in `verifyForeignIssuer.test.ts`.
- One verifier per test. The typed error is `JwtInvalidError`.
- Initial driftList: `alg-less-okp`, `alg-less-rsa`, `enc-key-shares-kid`, `crit-unknown`, `sig-not-base64url`, `header-not-base64url`.

oauth runner (`packages/oauth/test/JwsDifferential.test.ts`):
- Build a literal `OAuthProvider.ResolvedProvider` with:
  - id `"idp"`, kind `"oidc"`, issuer `Option.some(ISSUER)`, jwksUri `Option.some(JWKS_URL)`, clientId `AUDIENCE`;
  - idTokenSigningAlgs from the vector;
  - the remaining members from the first oidc provider built in `OAuth.test.ts`, or minimal literal values: endpoints as strings, `Option.none()` secrets, `skipPkce` false, an identity `mapProfile`.
- Obtain the `HttpClient` from `fakeHttpClient({ "/jwks": vector.jwks })`.
- Call `IdToken.verify` with:
  - `jwksCaches` from a fresh `IdToken.makeJwksCaches`;
  - nonce `NONCE`, jwksTimeout 5 seconds, clockSkew 60 seconds, maxIdTokenAge `Option.none()`.
- The typed error is `OAuthCallbackFailed`.
- Initial driftList: `key-ops-encrypt-only`, `crit-unknown`.

Header comment of each runner: "plan 38: the same vectors through both callers; a name in driftList is known drift, removed by the ticket that fixes it". Import the vectors with the relative path `../../ports/test/jwsVectors.ts`.
  </action>
  <verify><automated>npx vitest run packages/jwt/test/JwsDifferential.test.ts packages/oauth/test/JwsDifferential.test.ts</automated></verify>
  <acceptance_criteria>
- Both files pass at HEAD: 26 tests each.
- `sed -n '/^const driftList/,/^\]/p' packages/jwt/test/JwsDifferential.test.ts | grep -c '^  "'` = 6 (baseline at HEAD: file absent).
- `sed -n '/^const driftList/,/^\]/p' packages/oauth/test/JwsDifferential.test.ts | grep -c '^  "'` = 2.
- Prove each drift row is real once: temporarily remove one name from each list, rerun, and see that test fail. Record the run in this ticket's Comments.
  </acceptance_criteria>
  <done>Both runners are green with the stated drift lists. Removing any drift name turns its test red.</done>
</task>

<task type="tdd">
  <name>Task 3: B1 and B4 expected failures, and the peer-algorithm characterization</name>
  <files>packages/jwt/test/AuthHttp.test.ts, packages/jwt/test/Jwt.test.ts</files>
  <read_first>packages/jwt/test/AuthHttp.test.ts, packages/jwt/test/Jwt.test.ts, packages/jwt/test/RemoteSigning.test.ts, packages/jwt/test/KeyRing.test.ts (anotherProcess)</read_first>
  <action>
In `AuthHttp.test.ts`, add `it.effect.fails` (or `it.fails` for the async style that file uses): "plan 38 B1: introspection of a token whose header is not base64url answers {active:false}, not a defect". A signed-in caller POSTs `/jwt/introspect` with token `!!.e30.e30`. Assert status 200 and the body exactly `{"active":false}`. At HEAD the answer is a 500, so the expected failure passes.

In `Jwt.test.ts`, add two tests.

(a) Expected failure "plan 38 B4: a key registered with KeyRing.registerRemoteKey is served by Jwt.jwks with its kid and alg":
- Generate an Ed25519 pair with `JwtCodec.generateKeyJwks("EdDSA")`. Its public JWK has no kid or alg, exactly like `RemoteSigning.test.ts:28`.
- Register it as kid `remote-1`, alg `EdDSA`.
- Read `(yield* Jwt.Jwt).jwks`.
- Assert the entry whose `x` equals the public key's `x` has `kid` "remote-1" and `alg` "EdDSA".
- If `buildLayer()` does not expose `SigningKeyRecords`/`SqlTransaction`/`JwtConfig` to the test body, register the key the way `RemoteSigning.test.ts:100-113` does, before the ring is first read.

(b) A plain `it.effect` characterization test (green at HEAD) "a token signed by a peer's freshly minted key of another algorithm verifies through Jwt.verify after one forced refresh (KRS-006, JJS-003)":
- Two processes share one `SigningKeyRecords` store. Build them the way `KeyRing.test.ts` builds `anotherProcess`.
- This process reads its ring once, so its snapshot holds only the EdDSA key.
- The peer, configured with `JwtConfig` algorithm `ES256`, rotates and signs a principal token.
- Without advancing the clock past `keyCacheMaxAge`, this process's `Jwt.verify` accepts that token.

This test is what ticket 06's choice of allowlist (PLAN.md §3.4, Q6) must keep green.
  </action>
  <verify><automated>npx vitest run packages/jwt/test/AuthHttp.test.ts packages/jwt/test/Jwt.test.ts</automated></verify>
  <acceptance_criteria>
- Both files pass at HEAD, including the two expected-failure tests and the green characterization test.
- `grep -c 'plan 38 B1' packages/jwt/test/AuthHttp.test.ts` = 1 and `grep -c 'plan 38 B4' packages/jwt/test/Jwt.test.ts` = 1 (baseline 0 / 0).
  </acceptance_criteria>
  <done>B1 and B4 are reproduced as expected failures. The peer-algorithm behaviour is pinned green.</done>
</task>

</tasks>

<verification>
npx vitest run packages/jwt/test/JwsDifferential.test.ts packages/oauth/test/JwsDifferential.test.ts packages/jwt/test/AuthHttp.test.ts packages/jwt/test/Jwt.test.ts
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
- 26 + 26 differential tests pass; drift lists hold 6 (jwt) and 2 (oauth).
- B1 and B4 are each one expected-failure test that passes.
- No source file changed (`git diff --stat -- 'packages/*/src'` is empty).
</success_criteria>

## Comments

Result: 26 vectors (node check ok); jwt runner 20 pass + 6 expected-fail (drift 6), oauth runner 24 pass + 2 expected-fail (drift 2). Drift proof: with both driftLists emptied, exactly the 6 jwt and 2 oauth names failed (run recorded, lists restored). AuthHttp B1 and Jwt B4 are `it.fails`/`it.effect.fails` and pass.
Deviation (plan error): the peer-algorithm characterization is NOT green at HEAD for a new algorithm. `JwtCodec.verify` checks the allowlist (algorithms of the keys held before the refetch) before the kid lookup, so an ES256 key added by a peer fails "algorithm not allowed" and never reaches the refetch. Pinned instead as two tests: same algorithm (EdDSA) after one forced refresh, plain green; new algorithm (ES256), `it.effect.fails` "plan 38 Q6", to be flipped to plain by ticket 06 (Q6's `Jws.algorithms` allowlist fixes it, so Q6 is an improvement, not just "no regression"). The peer key is added with `KeyRing.importKey` (the minted private half is sealed in the store, so a rotated key cannot sign in a test).
