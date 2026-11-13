---
plan: 39-hashed-credential
ticket: 02
title: SCIM tokens hashed and encoded through SecretHash and Hmac.toHex
type: execute
wave: 2
depends_on: [01]
files_modified:
  - packages/scim/test/ScimHttp.test.ts
  - packages/scim/src/ScimConnections.ts
autonomous: true
requirements: [REQ-EA-1600, REQ-EA-1601]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "A SCIM connection's stored tokenHash is the SHA-256 lower-case hex of the returned bearer token, before and after the change"
    - "A token minted before the change still authenticates after it (the at-rest form is unchanged)"
    - "A missing, wrong, malformed or revoked token is still a 401 in the RFC 7644 error schema"
  artifacts:
    - "packages/scim/test/ScimHttp.test.ts (one new it.effect pinning the at-rest form)"
    - "packages/scim/src/ScimConnections.ts (no local hex encoder, no local hash helper)"
  key_links:
    - "ScimConnections.layerStore.create and ScimAuthenticationLive.bearer -> SecretHash.digest (from @awthaq/core)"
    - "ScimConnections.layerStore.create token minting -> Hmac.toHex (from @awthaq/ports)"
---
Status: done (uncommitted)
Blocked by: 01

<objective>
Remove SCIM's private copy of the hash recipe and of the hex encoder (`ScimConnections.ts:40-41, 87-89`). Use `SecretHash.digest` and `Hmac.toHex`. First pin the at-rest form with a Node-oracle test, so the swap is proven byte-identical.

Purpose: PLAN §2.5. SCIM is a lookup-by-hash credential. Its protocol is correct and stays as it is (PLAN §2.4). Only the spelling of the recipe moves.

Output: one new test, two local helpers deleted, three call sites changed.
</objective>

<context>
@.planning/39-hashed-credential/PLAN.md (§2.3 SCIM row, §2.4, §2.5)
@packages/scim/src/ScimConnections.ts (lines 17-41 imports and encoder; 86-118 `hashToken` and `layerStore`; 124-156 `ScimAuthenticationLive`)
@packages/scim/test/ScimHttp.test.ts (lines 75-130)
@packages/scim/test/support.ts (lines 66-83 `seedConnection`)
@packages/scim/src/ScimRecords.ts (lines 88-95: `findConnectionByTokenHash`, `listConnections`)
@packages/core/test/SecretHash.test.ts (from ticket 01)
</context>

<tasks>
  <task type="auto" tdd="true">
    <name>Task 1: Pin the at-rest form of a SCIM token</name>
    <files>packages/scim/test/ScimHttp.test.ts</files>
    <read_first>packages/scim/test/ScimHttp.test.ts (lines 1-40 imports and buildApp; 75-130), packages/scim/test/support.ts (lines 66-83), packages/scim/src/ScimRecords.ts (lines 88-95)</read_first>
    <behavior>
      - After `seedConnection()`, `ScimRecords.listConnections(organizationId)` holds exactly one row, whose `tokenHash` equals node:crypto createHash("sha256").update(token, "utf8").digest("hex")
      - The token matches /^scim_[0-9a-f]{64}$/
    </behavior>
    <action>Add one `it.effect` next to the existing "a revoked connection's token stops working immediately" test, titled "a connection stores only the SHA-256 hex of its token (at-rest form pinned)". Use the file's existing `buildApp()` and `inside(seedConnection())`. Then, inside the same `inside(...)`, read `ScimRecords.ScimRecords` and call `listConnections(seeded.organizationId)`. Assert the one row's `tokenHash` equals the Node oracle hash of `seeded.token`, and that the token matches the format regex. Import `createHash` from `node:crypto`. The test must pass at HEAD, before task 2: it is the characterization that proves task 2 changes no bytes.</action>
    <verify><automated>npx vitest run packages/scim/test/ScimHttp.test.ts</automated></verify>
    <acceptance_criteria>`grep -c 'at-rest form pinned' packages/scim/test/ScimHttp.test.ts` = 1 (baseline at HEAD: 0). The file passes at HEAD with the new test included.</acceptance_criteria>
    <done>The at-rest form of a SCIM token is pinned by a passing test.</done>
  </task>

  <task type="auto">
    <name>Task 2: Use SecretHash.digest and Hmac.toHex in ScimConnections</name>
    <files>packages/scim/src/ScimConnections.ts</files>
    <read_first>packages/scim/src/ScimConnections.ts (whole file, 160 lines), packages/core/src/SecretHash.ts</read_first>
    <action>Add `SecretHash` to the imports from `@awthaq/core`, in a new `import { SecretHash } from "@awthaq/core"` line kept in the file's import order. `Hmac` is already imported from `@awthaq/ports`. Delete the module-level hex-encoder const at lines 40-41, and the hash helper with its doc comment at lines 87-89. In `create`, mint the token as `TOKEN_PREFIX` followed by `Hmac.toHex` of the 32 random bytes, and compute `tokenHash` with `SecretHash.digest(hasher, token)`. In `bearer`, compute `hash` with `SecretHash.digest(hasher, presented)`. Keep everything else as it is: the prefix check before hashing, the lookup by hash, the constant-time compare and its comment, the revoked check and the `findActive` check (PLAN §1.4: the redundant compare stays). Keep the `Digest` import: it is still used for `yield* Digest.Digest` and the hasher's type. Update the file header's sentence "only its SHA-256 is stored" to add "(`SecretHash`)", and change nothing else in the header.</action>
    <verify><automated>test "$(grep -c 'padStart' packages/scim/src/ScimConnections.ts)" = 0 && test "$(grep -c 'Digest.sha256' packages/scim/src/ScimConnections.ts)" = 0 && npx vitest run packages/scim/test/ScimHttp.test.ts packages/scim/test/ScimUsers.test.ts packages/scim/test/ScimGroups.test.ts</automated></verify>
    <acceptance_criteria>`grep -c 'padStart' packages/scim/src/ScimConnections.ts` = 0 (baseline at HEAD: 1). `grep -c 'Digest.sha256' packages/scim/src/ScimConnections.ts` = 0 (baseline: 1). `grep -c 'SecretHash.digest' packages/scim/src/ScimConnections.ts` = 2 (baseline: 0). Task 1's test and the existing 401 tests (`ScimHttp.test.ts:75`, `:114`) pass unchanged.</acceptance_criteria>
    <done>SCIM spells neither the hash nor the hex encoding itself. Every SCIM test passes, including the at-rest pin.</done>
  </task>
</tasks>

<threat_model>
| Where untrusted input crosses | Description |
|---|---|
| `Authorization: Bearer <token>` → `ScimAuthenticationLive.bearer` | an identity provider, or anyone, presents a bearer token before any tenant is known |

| Threat ID | Category | Target | Severity | Disposition | Mitigation Plan |
|---|---|---|---|---|---|
| T-39-03 | Spoofing | `bearer` lookup by hash | high | mitigate | The lookup key must stay the exact SHA-256 hex. Task 1 pins it with an oracle before task 2 changes the spelling. The lookup, compare, revoked and organization-active order is unchanged and covered by `ScimHttp.test.ts:75, 114` |
| T-39-04 | Denial of service | stored `tokenHash` | high | mitigate | A drift would 401 every existing directory. Same oracle test. No migration, because the bytes are identical |
| T-39-05 | Information disclosure | the 401 answer | low | accept | Unchanged: every refusal is the same generic `ScimApi.unauthorized()` |
</threat_model>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
- The at-rest pin passes before and after the swap.
- 0 hex encoders and 0 inline SHA-256 calls in `ScimConnections.ts` (both were 1).
- The per-ticket gate is green.
</success_criteria>

## Comments

Done (uncommitted). ScimHttp.test.ts: new at-rest pin test (passed at HEAD before the swap). ScimConnections.ts: local hexOf and hashToken deleted; SecretHash.digest x2, Hmac.toHex; compare kept (Q3). packages/scim tests all pass.
