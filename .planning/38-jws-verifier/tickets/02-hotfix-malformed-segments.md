---
plan: 38-jws-verifier
ticket: 02
title: "Hotfix B1: a malformed segment fails typed, never dies"
type: tdd
wave: 0
depends_on: [01]
files_modified:
  - packages/jwt/src/JwtCodec.ts
  - packages/jwt/test/AuthHttp.test.ts
  - packages/jwt/test/JwsDifferential.test.ts
  - .changeset/jwt-malformed-segment.md
autonomous: true
requirements: [REQ-EA-1590]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "JwtCodec.verify answers a token with a non-base64url header, payload or signature segment with JwtInvalidError, never a defect"
    - "POST /jwt/introspect with '!!.e30.e30' answers 200 {\"active\":false}"
    - "Verify.makeVerifier(...).verify on such a token fails with JwtInvalidError, so verifySessionJwt resolves undefined"
  artifacts:
    - path: packages/jwt/src/JwtCodec.ts
      provides: "segment decoding through effect/encoding/Base64Url.decode (Result), no atob"
    - path: .changeset/jwt-malformed-segment.md
      provides: "patch changeset with Migration line"
  key_links:
    - from: packages/jwt/src/JwtCodec.ts
      to: effect/encoding/Base64Url
      via: "Base64Url.decode returns Result; Failure maps to JwtInvalidError('malformed token')"
---
Status: done (uncommitted)
Blocked by: 01

<objective>
Fix B1 in place, independently of the deepening, so it can ship in the wave-0 PR.

Purpose: an attacker-controlled cookie or bearer token currently makes the edge proxy throw and the server answer 500 (PLAN.md §2.4 B1).

Output: `JwtCodec`'s segment decoding uses Effect's strict `Base64Url.decode`, which returns a `Result`. Ticket 01's B1 tests flip from expected-failure to plain tests.
</objective>

<context>
@.planning/38-jws-verifier/PLAN.md (§2.3 "Segment decoding", §2.4 B1)
@packages/jwt/src/JwtCodec.ts (lines 183-193 base64Url helpers; 304-339 decodeHeader/decodePayload/parse)
@node_modules/effect/dist/encoding/Base64Url.d.ts (decode: (str: string) => Result.Result<Uint8Array, EncodingError>), resolved from packages/jwt/node_modules/effect
@packages/jwt/test/AuthHttp.test.ts (the plan 38 B1 test from ticket 01)
@packages/jwt/test/JwsDifferential.test.ts (driftList)
@.changeset/api-key-owner-standing.md (changeset format)
</context>

<tasks>

<task type="tdd">
  <name>Task 1: Decode segments with Base64Url.decode and flip the B1 tests</name>
  <files>packages/jwt/src/JwtCodec.ts, packages/jwt/test/AuthHttp.test.ts, packages/jwt/test/JwsDifferential.test.ts</files>
  <read_first>packages/jwt/src/JwtCodec.ts, packages/jwt/test/AuthHttp.test.ts</read_first>
  <action>
RED first:
- In `AuthHttp.test.ts`, turn the "plan 38 B1" test from the expected-failure form into a plain test.
- In `JwsDifferential.test.ts`, remove `sig-not-base64url` and `header-not-base64url` from `driftList`.
- Run both files and see three failures. The defect surfaces as a test error, because the runner uses `Effect.result`.

GREEN:
- In `JwtCodec.ts`, delete the `atob`-based `base64UrlDecode` helper (lines 189-193).
- `decodeHeader`, `decodePayload` and the signature step of `parse` decode their segment with `Base64Url.decode`, which is already imported as `Base64Url` at line 52 for `peekTyp`.
- A `Failure` becomes `JwtInvalidError({ reason: "malformed token" })`. Use `Result.match` or an `Effect` constructor from a `Result`; check the installed names in `node_modules/effect/dist/Effect.d.ts` (search "Result").
- The signature bytes must be a `Uint8Array<ArrayBuffer>` for `crypto.subtle.verify`. Copy with `new Uint8Array(bytes)` to get one without an assertion.
- Keep `base64UrlEncode` for `sign`.
- Leave the header comment's GC-002/RFC 8725 paragraphs. Add one line under the AH-001 note: "Segments decode through `Base64Url.decode` (a `Result`): malformed input is a typed failure, never a defect (plan 38 B1)".
  </action>
  <verify><automated>npx vitest run packages/jwt/test/AuthHttp.test.ts packages/jwt/test/JwsDifferential.test.ts packages/jwt/test/JwtCodec.test.ts packages/jwt/test/verify.test.ts</automated></verify>
  <acceptance_criteria>
- `grep -c 'atob(' packages/jwt/src/JwtCodec.ts` = 0 (baseline at HEAD: 1).
- `sed -n '/^const driftList/,/^\]/p' packages/jwt/test/JwsDifferential.test.ts | grep -c '^  "'` = 4 (baseline after ticket 01: 6).
- `grep -c 'plan 38 B1' packages/jwt/test/AuthHttp.test.ts` = 1, and that test is a plain test (not `.fails`).
- The 25 `JwtCodec.test.ts` tests and the 7 `verify.test.ts` tests pass unchanged.
  </acceptance_criteria>
  <done>No malformed segment reaches a defect. Introspection answers inactive, and the lite verifier fails typed.</done>
</task>

<task type="auto">
  <name>Task 2: Changeset</name>
  <files>.changeset/jwt-malformed-segment.md</files>
  <read_first>.changeset/api-key-owner-standing.md</read_first>
  <action>
Write a patch changeset for `@awthaq/jwt`. Its text:
- A token whose header, payload or signature segment is not base64url is now refused like every other bad token.
- `POST /jwt/introspect` answers `{"active":false}` instead of 500; an opted-in bearer request answers 401 instead of 500; `verifySessionJwt` resolves `undefined` instead of rejecting.
- Name BEH-EA-293.
- Last line: "Migration: none."
  </action>
  <verify><automated>grep -c '^Migration:' .changeset/jwt-malformed-segment.md</automated></verify>
  <acceptance_criteria>The grep prints 1. The front matter names `"@awthaq/jwt": patch`.</acceptance_criteria>
  <done>The changeset exists.</done>
</task>

</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| request → JwtCodec.verify | the bearer token, introspection body and session-mirror cookie are attacker-controlled strings |

## STRIDE threat register

| Threat ID | Category | Target | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-38-01 | Denial of service | `JwtCodec.parse` segment decoding | medium | mitigate | Strict `Base64Url.decode` returning a `Result`; a failure is `JwtInvalidError`; tests on introspection and the lite verifier |
| T-38-02 | Information disclosure | introspection and bearer answers | low | mitigate | A malformed token now gets the same `{active:false}`/401 as every other failure (BEH-EA-293); a 500 previously told the caller "this input crashes the parser" |
</threat_model>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
- B1 tests are plain and green; jwt drift list is 4.
- No `atob(` remains in `packages/jwt/src`.
</success_criteria>

## Comments
Result: `JwtCodec` decodes header, payload and signature through `Base64Url.decode` (`decodeSegment`, a `Result`); `atob(` count 0 in packages/jwt/src. B1 test in AuthHttp is plain; jwt driftList 6 -> 4 (`alg-less-okp`, `alg-less-rsa`, `enc-key-shares-kid`, `crit-unknown`). Gate run: AuthHttp, JwsDifferential, JwtCodec (25), verify, next Edge tests all green. Changeset `.changeset/jwt-malformed-segment.md` (names BEH-EA-293, Migration: none). The explicit red run was reached via ticket 01's expected-failure form (the `.fails` tests passed, i.e. the body failed, before the fix).
