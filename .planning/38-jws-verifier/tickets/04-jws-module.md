---
plan: 38-jws-verifier
ticket: 04
title: "Jws in @awthaq/ports"
type: tdd
wave: 1
depends_on: [01]
files_modified:
  - packages/ports/src/Jws.ts
  - packages/ports/src/index.ts
  - packages/ports/test/Jws.test.ts
  - spec/overview.md
autonomous: true
requirements: [REQ-EA-1591, REQ-EA-1593, REQ-EA-1594, REQ-EA-1596]
estimate: {tasks: 3, size: L}
must_haves:
  truths:
    - "Every vector of ports/test/jwsVectors.ts gets its expected Jws-level outcome (reason, or acceptance plus timeProblem) through Jws.verify and Jws.timeProblem"
    - "Jws.verify never dies on any string input"
    - "unknown-kid calls KeySource.refreshOnMiss exactly once; alg/crit/malformed/missing-kid never touch the KeySource; key-mismatch reads get once and never refetches"
    - "Only Jws.ts calls crypto.subtle.verify in packages/ports/src"
  artifacts:
    - path: packages/ports/src/Jws.ts
      provides: "Algorithm, algorithms, isAlgorithm, keyType, webCryptoParams, JwkSet, KeySource, Reason, JwsRejected, Verified, verify, TimeProblem, timeProblem"
    - path: packages/ports/test/Jws.test.ts
      provides: "tests at the interface, including the cases moved from oauth/test/Jwt.test.ts and JwtCodec.test.ts"
  key_links:
    - from: packages/ports/src/index.ts
      to: packages/ports/src/Jws.ts
      via: "export * as Jws"
    - from: spec/overview.md
      to: packages/ports/src/index.ts
      via: "the surface:ports block lists Jws (drift check 13)"
---
Status: ready-for-agent
Blocked by: 01

<objective>
Build the one JWS verification module, test-first, against the shared vector table.

Purpose: every RFC 7515/7517/8725 rule the two copies hold, and the rules neither holds (`crit`, `key_ops`, strict base64url), live in one file with a small interface (PLAN.md §3.2–3.3).

Output: `packages/ports/src/Jws.ts`, exported as `Jws`, with its tests. No caller changes in this ticket.
</objective>

<context>
@.planning/38-jws-verifier/PLAN.md (§3.2 interface, §3.3 key selection, §5.1)
@packages/oauth/src/Jwt.ts (the structural JWK schemas, usableFor, publicMembers, the parameter table: the implementation to carry over)
@packages/jwt/src/JwtCodec.ts (lines 124-178 table, 341-360 verifySignature, 427-441 time checks)
@packages/oauth/src/IdToken.ts (lines 125-144 time checks; the comparisons must stay identical)
@packages/ports/src/RefreshingCache.ts (get / refreshOnMiss: the shape KeySource mirrors)
@packages/ports/src/XmlSignature.ts (header comment style for a security module in ports)
@packages/ports/test/jwsVectors.ts
@packages/oauth/test/Jwt.test.ts and packages/jwt/test/JwtCodec.test.ts (cases to move; PLAN.md §5.1 lists them)
@spec/overview.md (lines 47, 84-128 surface:ports block, 156)
</context>

<tasks>

<task type="tdd">
  <name>Task 1 (tracer): verify one valid EdDSA vector end to end through the module's interface</name>
  <files>packages/ports/src/Jws.ts, packages/ports/src/index.ts, packages/ports/test/Jws.test.ts</files>
  <read_first>packages/oauth/src/Jwt.ts, packages/ports/src/RefreshingCache.ts, packages/ports/src/index.ts</read_first>
  <action>
RED: create `packages/ports/test/Jws.test.ts`.
- It imports `Jws` from `../src/index.ts`, and `vectors`, `NOW_MS`, `SKEW_MS` from `./jwsVectors.ts`.
- It defines a helper `staticKeys(set)` that returns a `KeySource` whose `get` and `refreshOnMiss` both succeed with `set`.
- For now, one test: `valid-eddsa` through `Jws.verify` with `requireKid: true` accepts, and its payload `sub` is "user-1".
- Run it and see it fail: the module does not exist.

GREEN: create `packages/ports/src/Jws.ts`.

Header comment, in the voice of `XmlSignature.ts`. It cites ADR-EA-057 and RFC 7515 §4.1.1/§4.1.4/§4.1.11, RFC 7517 §4.2–4.5, RFC 8725 §3.1, and states that it imports only `effect` and `node:crypto` types (edge-safe; `@awthaq/jwt/verify` reaches it).

Members, exactly as sketched in PLAN.md §3.2:
- `Algorithm` is `Schema.Literals` over RS256, PS256, ES256, ES384, EdDSA, in that order. `algorithms` is the same list. `isAlgorithm` is `Schema.is(Algorithm)`.
- `keyType` and `webCryptoParams` read one private table keyed by `Algorithm`. Each entry holds `kty`, the curve for EC/OKP, `importParams` and `signParams`, with values identical to `oauth/src/Jwt.ts:216-239` and `JwtCodec.ts:147-178`.
- `JwkSet` is the struct of `keys` as an array of string-keyed unknown records.
- The `KeySource` interface; `Reason`; `JwsRejected` as `Data.TaggedError("Jws/Rejected")` carrying `reason`; the `Verified` interface.

`verify` follows PLAN.md §3.2 steps 1–6 in that order:
- Decode segments with `Base64Url.decode` from `effect/encoding/Base64Url` (it returns a `Result`).
- Decode the JSON with `Schema.decodeUnknownOption(Schema.fromJsonString(...))`. The header struct has `alg` as a string, `kid` and `typ` as optional strings, and `crit` as optional unknown. The payload is a string-keyed unknown record.
- Select keys per §3.3. Decode candidates with the RSA/EC/OKP schemas carried over from `oauth/src/Jwt.ts:51-77`, adding an optional `key_ops` array of strings.
- Import public members only.
- Use `Effect.tryPromise` for WebCrypto, with its catch giving `JwsRejected` `signature`.

Copy decoded bytes with `new Uint8Array(...)` to get `Uint8Array<ArrayBuffer>`. No `as`. No return-type annotations on exported Effect consts; `verify` is a generic function, so its type parameters are fine.

`timeProblem` is pure, and its comparisons are identical to `IdToken.ts:125-144`:
- `exp` missing or non-finite, or `nowMs >= exp*1000 + skewMs` → `exp`;
- a present `nbf` that is non-finite, or `nowMs + skewMs < nbf*1000` → `nbf`;
- a present `iat` that is non-finite, or `iat*1000 > nowMs + skewMs` → `iat`.

Add `export * as Jws from "./Jws.ts";` to `packages/ports/src/index.ts`, alphabetically between `Ids` and `KeyProvider`.
  </action>
  <verify><automated>npx vitest run packages/ports/test/Jws.test.ts</automated></verify>
  <acceptance_criteria>
- The tracer test passes.
- `grep -c 'Jws' packages/ports/src/index.ts` = 1 (baseline at HEAD: 0).
- `grep -E '^import' packages/ports/src/Jws.ts | grep -cvE 'from "effect/|from "node:crypto"'` = 0. Only `effect` and `node:crypto` are imported, and the latter only as a type.
  </acceptance_criteria>
  <done>One vector verifies through `Jws.verify` end to end, over real WebCrypto.</done>
</task>

<task type="tdd">
  <name>Task 2: All vectors, the refetch contract, and the moved cases</name>
  <files>packages/ports/test/Jws.test.ts, packages/ports/src/Jws.ts</files>
  <read_first>packages/ports/test/jwsVectors.ts, packages/oauth/test/Jwt.test.ts, packages/jwt/test/JwtCodec.test.ts</read_first>
  <action>
Extend `Jws.test.ts` (RED, then fix `Jws.ts` until GREEN).

(1) A loop over `vectors`. Use `requireKid: false`, so the kid-less policy row is accepted at this level, and `algorithms` from the vector. Then:
- a vector with `jwsReason` must fail with `Jws/Rejected` carrying that reason;
- otherwise it must succeed, and `Jws.timeProblem(payload, { nowMs: NOW_MS, skewMs: SKEW_MS })` must equal the vector's `timeProblem` (undefined when absent).

Add one extra test: `kid-less` with `requireKid: true` fails with `missing-kid`.

(2) The refetch contract, with a counting `KeySource` (two `Ref` counters around `get` and `refreshOnMiss`):
- `unknown-kid` with a source whose refetch returns a set holding the key → success, `refreshOnMiss` called exactly 1 time;
- `unknown-kid` against a static set → `unknown-kid`, refetch called 1 time;
- `key-alg-mismatch` → `get` 1 time, refetch 0;
- `alg-not-allowed`, `crit-unknown`, `sig-not-base64url` → `get` 0, refetch 0;
- a source whose `get` fails with a test error → that error is in the failure channel, unchanged.

(3) Never dies: a property-style loop over a fixed list of 20 hostile strings. Examples: empty, a single dot, four segments, `null` JSON, an array header, a 1 MB segment, non-ASCII, `%00`, a JSON header with `alg` as a number. Each yields `Jws/Rejected` with `malformed` or `alg`, observed through `Effect.result`, so a defect fails the test.

(4) Moved cases, re-expressed against `Jws.verify` (PLAN.md §5.1):
- from `oauth/test/Jwt.test.ts`, all 20, keeping the node:crypto signing for the five-algorithm block;
- from `JwtCodec.test.ts`, the 11 listed.

Name each moved test with its original requirement tag (ACS-004, AH-001/ESS-004, AOMS-005, JJS-003, JJS-009, BAM-010), so the traceability rows still find them.
  </action>
  <verify><automated>npx vitest run packages/ports/test/Jws.test.ts</automated></verify>
  <acceptance_criteria>
- All tests pass. The count is at least 26 (vectors) + 1 + 5 (refetch) + 1 (hostile loop) + 31 (moved). Record the exact count in Comments.
- `grep -c 'subtle\.verify(' packages/ports/src/Jws.ts` = 1.
- `grep -rn 'subtle\.verify(' packages/ports/src | wc -l` = 1 (baseline at HEAD: 0).
  </acceptance_criteria>
  <done>The module meets every vector and the refetch contract, and never dies.</done>
</task>

<task type="auto">
  <name>Task 3: Ports inventory in spec/overview.md</name>
  <files>spec/overview.md</files>
  <read_first>spec/overview.md (lines 40-160), spec/scripts/check-drift.mjs (check 13)</read_first>
  <action>
- Add `Jws` on its own line, alphabetically between `Ids` and `KeyProvider`, inside the `<!-- surface:ports -->` block.
- In the package table row for `@awthaq/ports` (line 47), add `Jws` to the helpers list.
- In the module table near line 156, add a row: `Jws` | helper | "compact-JWS verification for every verifier in the repo: strict decoding, `crit` refusal, the five-algorithm table, RFC 7517 key selection, one refetch on an unknown `kid` through a `KeySource`, and time-claim judgement ([ADR-EA-057](decisions/057-one-jws-verifier.md))".

The ADR link resolves once ticket 07 lands. If `pnpm spec:verify` fails on the link in this ticket's own gate, write the row without the link, and ticket 07 adds it.
  </action>
  <verify><automated>bash spec/scripts/verify-traceability.sh 2>&1 | grep -E 'ports inventory vs source' | grep -c PASS</automated></verify>
  <acceptance_criteria>
- The grep prints 1.
- `grep -c '^Jws$' spec/overview.md` = 1 (baseline at HEAD: 0).
  </acceptance_criteria>
  <done>The ports inventory check passes with `Jws` exported.</done>
</task>

</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| token → Jws.verify | header, payload and signature are attacker-controlled |
| JWKS document → Jws.verify | a provider's or issuer's network-fetched key set; the caller schema-decodes the document shape, and `Jws` narrows every entry |

## STRIDE threat register

| Threat ID | Category | Target | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-38-05 | Spoofing | algorithm selection | critical | mitigate | Header `alg` must be one of five asymmetric algorithms and in the caller's allowlist; a key's own `alg`, when present, must equal it; `kty`/`crv` must fit; HS* and `none` are unrepresentable (vectors `alg-none`, `alg-hs256`, `key-alg-mismatch`, `curve-mismatch`) |
| T-38-06 | Tampering | `crit` extensions | medium | mitigate | Any `crit` is refused (RFC 7515 §4.1.11), so no extension that changes the signing input (`b64`) can be silently ignored (vector `crit-unknown`) |
| T-38-07 | Spoofing | key purpose | medium | mitigate | `use` other than `sig` and `key_ops` without `verify` make a key invisible before `kid` matching (vectors `enc-only`, `key-ops-encrypt-only`, `enc-key-shares-kid`) |
| T-38-08 | Denial of service | refetch amplification | medium | mitigate | Refetch only on `unknown-kid`, at most once per call; the caller's `RefreshingCache` rate-limits it (`minRefetchInterval`); `alg`/`crit`/`malformed` touch no key source (refetch contract tests) |
| T-38-09 | Denial of service | malformed input | medium | mitigate | `Base64Url.decode` returns a `Result`, and JSON decodes through `Schema` options; the hostile-string loop proves no defect |
| T-38-10 | Tampering | key material import | high | mitigate | Only structurally decoded public members reach `importKey`; a private member (`d`) is never imported, because public members are rebuilt field by field |
| T-38-11 | Information disclosure | rejection reasons | low | accept | `Jws/Rejected.reason` is internal; each caller collapses it (BEH-EA-293 / opaque `OAuthCallbackFailed`) |
</threat_model>

<verification>
npx vitest run packages/ports/test/Jws.test.ts packages/ports/test/RefreshingCache.test.ts
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
- Every vector meets its Jws-level expectation; the refetch contract and the no-defect loop pass.
- `Jws` is exported from `@awthaq/ports` and listed in `spec/overview.md`.
- `pnpm circular` reports no new cycle (ports imports neither jwt nor oauth).
</success_criteria>

## Comments
