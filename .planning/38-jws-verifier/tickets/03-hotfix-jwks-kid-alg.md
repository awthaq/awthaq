---
plan: 38-jws-verifier
ticket: 03
title: "Hotfix B4: the served JWKS names every key's kid and alg"
type: tdd
wave: 0
depends_on: [01]
files_modified:
  - packages/jwt/src/Jwt.ts
  - packages/jwt/test/Jwt.test.ts
  - .changeset/jwt-jwks-remote-key.md
autonomous: true
requirements: [REQ-EA-1592]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "GET /jwt/jwks (Jwt.jwks) lists kid and alg for every verifiable key, a key registered through KeyRing.registerRemoteKey with a bare public JWK included"
    - "Re-registering the same remote key at boot is still a no-op (BEH-EA-296 rev 1.2): storage is not changed, only what is served"
    - "No private member is ever served (BEH-EA-292)"
  artifacts:
    - path: packages/jwt/src/Jwt.ts
      provides: "jwks maps each key to { ...publicKeyJwk, kid, alg }"
  key_links:
    - from: packages/jwt/src/Jwt.ts (jwks)
      to: packages/jwt/src/KeyRing.ts (SigningKey.kid / .alg)
      via: "the record's own kid and alg override whatever the stored JWK carries"
---
Status: ready-for-agent
Blocked by: 01

<objective>
Fix B4 by serving each key's record `kid` and `alg` in the JWKS. Leave what `registerRemoteKey` stores unchanged.

Purpose: BEH-EA-292 already requires every served key to carry `kid` and `alg`. A remote (KMS/HSM) key registered with a bare public JWK is served without either, so every downstream lite verifier refuses its tokens (PLAN.md §2.4 B4).

Output: a one-expression change in `Jwt.ts`'s `jwks`. Ticket 01's B4 test becomes a plain test.
</objective>

<context>
@.planning/38-jws-verifier/PLAN.md (§2.4 B4, §8 on BEH-EA-296)
@packages/jwt/src/Jwt.ts (lines 829-831: jwks)
@packages/jwt/src/KeyRing.ts (lines 94-100 toSigningKey; 233-262 registerRemoteKey stores input unchanged; 279-313 importKey merges kid/alg)
@packages/jwt/src/SigningKeyRecords.ts (lines 40-48 and 280-292: isSameKey compares the stored public JWK, the reason storage must not change)
@packages/jwt/test/Jwt.test.ts (the plan 38 B4 test from ticket 01)
</context>

<tasks>

<task type="tdd">
  <name>Task 1: Serve kid and alg from the record</name>
  <files>packages/jwt/src/Jwt.ts, packages/jwt/test/Jwt.test.ts</files>
  <read_first>packages/jwt/src/Jwt.ts (lines 820-835), packages/jwt/src/KeyRing.ts (lines 230-313)</read_first>
  <action>
RED: in `Jwt.test.ts`, make the "plan 38 B4" test a plain test. Run it and see it fail on the missing `kid`.

GREEN: in `Jwt.ts`, the `jwks` effect maps each verifiable key to the public JWK spread first, then `kid` set to the key's `kid` and `alg` set to the key's `alg`. The record wins over anything the stored JWK says.

Do NOT change `KeyRing.registerRemoteKey` or `importKey`. Merging at registration would make `SigningKeyRecords.isSameKey` see a stored bare JWK and a merged input as different keys. Every deployment that re-registers its remote key at boot would then fail `KidTaken` (BEH-EA-296 rev 1.2).

Add a one-line comment above the mapping: "BEH-EA-292: every served key names its kid and alg from the record, whatever JWK was registered (plan 38 B4)".
  </action>
  <verify><automated>npx vitest run packages/jwt/test/Jwt.test.ts packages/jwt/test/AuthHttp.test.ts packages/jwt/test/KeyRing.test.ts packages/jwt/test/RemoteSigning.test.ts</automated></verify>
  <acceptance_criteria>
- `grep -c 'plan 38 B4' packages/jwt/test/Jwt.test.ts` = 1, and it is a plain test.
- `AuthHttp.test.ts`'s "GET /jwt/jwks returns the current public key, no private material" passes unchanged.
- `KeyRing.test.ts`'s re-registration tests (lines 296-330 at HEAD: same key again is a no-op; a different key fails `KidTaken`) pass unchanged.
- `git diff --stat packages/jwt/src/KeyRing.ts packages/jwt/src/SigningKeyRecords.ts` is empty.
  </acceptance_criteria>
  <done>A remote-registered key is served with `kid` and `alg`. Nothing stored changes.</done>
</task>

<task type="auto">
  <name>Task 2: Changeset</name>
  <files>.changeset/jwt-jwks-remote-key.md</files>
  <read_first>.changeset/api-key-owner-standing.md</read_first>
  <action>
Write a patch changeset for `@awthaq/jwt`. Its text:
- `GET /jwt/jwks` now names `kid` and `alg` for a key registered with `KeyRing.registerRemoteKey` from a bare public JWK (BEH-EA-292).
- Downstream verifiers, including `@awthaq/jwt/verify` and `@awthaq/next/edge`, can now verify tokens signed by a remote key.
- Last line: "Migration: none; a downstream verifier picks the corrected set up within its JWKS cache lifetime (`cacheTtl`, default 10 minutes)."
  </action>
  <verify><automated>grep -c '^Migration:' .changeset/jwt-jwks-remote-key.md</automated></verify>
  <acceptance_criteria>The grep prints 1.</acceptance_criteria>
  <done>The changeset exists.</done>
</task>

</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| server → public JWKS | the served set is public; what it carries must be public members plus identifiers only |

## STRIDE threat register

| Threat ID | Category | Target | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-38-03 | Information disclosure | `Jwt.jwks` mapping | high | mitigate | Only `kid` and `alg` are added to the stored public JWK; the existing "no private material" test (`AuthHttp.test.ts`) stays green; `importKey` already refuses a JWK carrying `d` |
| T-38-04 | Spoofing | downstream key selection | low | accept | Serving the record's `alg` narrows a downstream verifier to the one algorithm the key signs with (RFC 8725 §3.1), which is strictly safer than an `alg`-less entry |
</threat_model>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
- The B4 test is plain and green; KeyRing re-registration tests are unchanged and green.
</success_criteria>

## Comments
