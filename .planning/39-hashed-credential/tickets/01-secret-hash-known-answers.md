---
plan: 39-hashed-credential
ticket: 01
title: SecretHash known-answer tests, its real contract, and Verification on the one recipe
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/core/test/SecretHash.test.ts
  - packages/core/src/SecretHash.ts
  - packages/core/src/Verification.ts
  - spec/traceability.md
autonomous: true
requirements: [REQ-EA-1600]
estimate: {tasks: 3, size: S}
must_haves:
  truths:
    - "SecretHash.digest equals Node's createHash('sha256') lower-case hex for every input in the test set, and the FIPS 180-2 'abc' vector"
    - "SecretHash.NEVER_MATCHES is 64 characters and equals no digest in the test set"
    - "Verification stores and claims byte-identical value hashes before and after the change (Verification.test.ts and VerificationLink.test.ts pass unchanged)"
    - "SecretHash's header states the real contract and names every caller kind"
  artifacts:
    - "packages/core/test/SecretHash.test.ts (new)"
    - "packages/core/src/SecretHash.ts (header comment rewritten; exports unchanged)"
    - "packages/core/src/Verification.ts (hashOf and hash delegate to SecretHash.digest)"
    - "spec/traceability.md (one §5 row + Document Control revision)"
  key_links:
    - "packages/core/src/Verification.ts imports ./SecretHash.ts (no cycle: SecretHash imports only @awthaq/ports and effect)"
    - "spec/traceability.md row cites packages/core/test/SecretHash.test.ts, checked by pnpm spec:verify"
---
Status: ready-for-agent
Blocked by: none

<objective>
Pin the at-rest form of every hash-at-rest credential (SHA-256, lower-case hex) with a known-answer test. Make `SecretHash`'s header say what it is really for and who uses it. Move core's own `Verification` onto `SecretHash.digest`, so core spells the recipe once.

Purpose: tickets 02 and 03 move SCIM and organization onto `SecretHash.digest`. This test is the proof that the bytes do not change, and that stored tokens keep matching. The header today says "these secrets are 256 random bits", but the device user code (34.6 bits) already uses it correctly, so the header is wrong, not the caller (PLAN §2.6 item 7).

Output: one new test file, a rewritten header comment, two inline hash spellings removed from `Verification.ts`, one traceability row. No exported signature changes.
</objective>

<context>
@.planning/39-hashed-credential/PLAN.md (§2.3, §2.5, §2.6, §3.5)
@packages/core/src/SecretHash.ts
@packages/core/src/Verification.ts (lines 24-45 imports and `toHex`; 316-339 `makeTokenFlows`/`hashOf`; 396-414 `layer`/`hash`)
@packages/ports/test/Hmac.test.ts (the Node-oracle pattern this test copies)
@packages/core/test/Verification.test.ts (line 13 and 43: how a core test provides `Digest` with `NodeCrypto.layer`)
@packages/device-authorization/src/UserCode.ts (lines 1-16: the 34.6-bit caller the header must admit)
@spec/traceability.md (lines 8-13 Document Control; lines 213-214 the §5 row format)
</context>

<tasks>
  <task type="auto" tdd="true">
    <name>Task 1: Known-answer tests for SecretHash</name>
    <files>packages/core/test/SecretHash.test.ts</files>
    <read_first>packages/ports/test/Hmac.test.ts, packages/core/test/Verification.test.ts, packages/core/src/SecretHash.ts</read_first>
    <behavior>
      - digest of "abc" is ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad (FIPS 180-2)
      - digest of each input equals node:crypto createHash("sha256").update(input, "utf8").digest("hex") for: a 64-char lower-case hex secret, the empty string, a multi-byte string (for example "pässwörd-ключ-🔑"), a `scim_`-prefixed token, and a normalised device user code "BCDFGHJK"
      - every digest is 64 characters of [0-9a-f]
      - NEVER_MATCHES has length 64, and equals(d, NEVER_MATCHES) is false for every digest d above
      - equals(d, d) is true; equals(d, d with its last character changed) is false
    </behavior>
    <action>Create the test file with `describe`/`it.effect` from `@effect/vitest`, importing `SecretHash` from `../src/SecretHash.ts` and `createHash` from `node:crypto`. Get `Digest.Digest` inside `Effect.gen` and provide `NodeCrypto.layer` from `@effect/platform-node/NodeCrypto`, the same way `Verification.test.ts` does. Write one `it.effect` per behaviour bullet. Compare with `assert.strictEqual`. The test pins today's behaviour, so it passes at HEAD. That is intended: it is the safety net for tickets 01 task 3, 02 and 03. Do not add a timing test: timing assertions are flaky, and the uniform-answer tests listed in PLAN §5.2 already cover the observable rule.</action>
    <verify><automated>npx vitest run packages/core/test/SecretHash.test.ts</automated></verify>
    <acceptance_criteria>The file exists (baseline at HEAD: absent). It has at least 5 passing tests. `grep -c 'createHash' packages/core/test/SecretHash.test.ts` ≥ 1 (baseline: file absent).</acceptance_criteria>
    <done>`npx vitest run packages/core/test/SecretHash.test.ts` passes with ≥ 5 tests.</done>
  </task>

  <task type="auto">
    <name>Task 2: State SecretHash's real contract and callers; add the traceability row</name>
    <files>packages/core/src/SecretHash.ts, spec/traceability.md</files>
    <read_first>packages/core/src/SecretHash.ts, packages/device-authorization/src/UserCode.ts (lines 1-16), spec/traceability.md (lines 8-13 and 213-214)</read_first>
    <action>Rewrite only the leading comment block of `SecretHash.ts`. Keep the three exports and their doc comments byte-for-byte. The new header must say:
(a) The recipe is for a secret the server mints and shows once, never a human-chosen one (that is `PasswordHasher`'s job). Its guessing is bounded either by its entropy (256-bit session secrets, API keys, client secrets, SCIM tokens, invitation tokens, device codes) or by its short lifetime plus an attempt or rate budget (the 34.6-bit device user code, RFC 8628 §6.1 and DAG-004; OTP-format verification values, SOS-004).
(b) SHA-256 is deliberately not a KDF. Keep the existing sentence about not burning password-grade CPU on an unauthenticated endpoint.
(c) There are two lookup shapes. By a public id, then `equals` against the stored hash or `NEVER_MATCHES` before any branch on record state (PIL-007, BEH-EA-050). Or by the hash itself, where no compare is needed.
(d) The callers by kind: core Sessions and Verification, api-key keys and clients, device-authorization, organization invitations, SCIM connections.
(e) Hashing is for a value the server only recognises. A value it must read again is sealed (`SealedColumn`, ADR-EA-019).
Keep the header in the file's existing `//` style and under about 25 lines.
Then, in `spec/traceability.md` §5 (the test-path table, near the `SessionVerdict.test.ts` row at line 213), add one row. First cell: `packages/core/test/SecretHash.test.ts`. Second cell: BEH-EA-050 and INV-EA-007, "the one at-rest recipe: SHA-256 lower-case hex checked against a Node oracle and the FIPS 180-2 vector; the never-matching fallback (plan 39)". Bump the Document Control revision to the next free one after whatever is current when you land (1.77 at planning time), set the effective date, and append a Change History entry naming plan 39 ticket 01.</action>
    <verify><automated>grep -ciE 'device|invitation|scim|verification' packages/core/src/SecretHash.ts && grep -c 'packages/core/test/SecretHash.test.ts' spec/traceability.md && pnpm spec:verify</automated></verify>
    <acceptance_criteria>`grep -ciE 'device|invitation|scim|verification' packages/core/src/SecretHash.ts` ≥ 4 (baseline at HEAD: 0). `grep -c 'packages/core/test/SecretHash.test.ts' spec/traceability.md` ≥ 1 (baseline: 0). `pnpm spec:verify` exits 0. `git diff packages/core/src/SecretHash.ts` touches no line from the first `export` down.</acceptance_criteria>
    <done>The header states the contract, both lookup shapes, hash versus seal, and the callers. Traceability cites the new test, and spec verification passes.</done>
  </task>

  <task type="auto" tdd="true">
    <name>Task 3: Verification hashes through SecretHash.digest</name>
    <files>packages/core/src/Verification.ts</files>
    <read_first>packages/core/src/Verification.ts (lines 24-45, 316-339, 396-414)</read_first>
    <behavior>
      - Verification.test.ts and VerificationLink.test.ts pass unchanged: an issued value redeems, a wrong value misses and spends a budgeted attempt, replay is published once
      - The stored valueHash for an issued value equals SecretHash.digest of that value (byte-identical to before)
    </behavior>
    <action>Import `* as SecretHash from "./SecretHash.ts"`. In `makeTokenFlows`, make `hashOf` return `SecretHash.digest(hasher, Redacted.value(value))`. In `layer`, make the local `hash` return `SecretHash.digest(hasher, value)`, or inline that call at its one use and delete `hash`. Remove both inline SHA-256 spellings. Keep the `Digest` import, because `Digest.Digest["Service"]` and `yield* Digest.Digest` still use it. Keep the `toHex` alias, because `mintValue` at line 259 uses it. Change nothing in the claim, redeem, release or store protocol. Do not touch `VerificationStore`, its adapters, or `VerificationLink.ts` (plans 07/18 own them).</action>
    <verify><automated>test "$(grep -c 'Digest.sha256' packages/core/src/Verification.ts)" = 0 && npx vitest run packages/core/test/Verification.test.ts packages/core/test/VerificationLink.test.ts packages/core/test/SecretHash.test.ts && pnpm circular</automated></verify>
    <acceptance_criteria>`grep -c 'Digest.sha256' packages/core/src/Verification.ts` = 0 (baseline at HEAD: 2). `grep -c 'SecretHash.digest' packages/core/src/Verification.ts` ≥ 1 (baseline: 0). The three test files pass. `pnpm circular` passes.</acceptance_criteria>
    <done>`Verification.ts` spells no hash of its own, and every verification test passes unchanged.</done>
  </task>
</tasks>

<threat_model>
| Where untrusted input crosses | Description |
|---|---|
| presented verification value → `Verification.consume`/`redeem` | an attacker-supplied value is hashed and claimed against the store |

| Threat ID | Category | Target | Severity | Disposition | Mitigation Plan |
|---|---|---|---|---|---|
| T-39-01 | Denial of service | `Verification.ts` hashing | high | mitigate | If the recipe drifted by one byte, every live reset, verify-email and magic-link token would miss. Task 1's oracle test, plus `Verification.test.ts`, must pass before and after task 3 |
| T-39-02 | Information disclosure | `SecretHash` header | low | accept | Comment only; it widens no caller. Device user code and OTP use are existing behaviour, now documented |
</threat_model>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
- `packages/core/test/SecretHash.test.ts` passes with ≥ 5 tests.
- `grep -c 'Digest.sha256' packages/core/src/Verification.ts` = 0 (was 2).
- `pnpm spec:verify` passes with the new traceability row.
- The per-ticket gate is green.
</success_criteria>

## Comments
