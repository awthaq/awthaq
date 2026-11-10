---
plan: 39-hashed-credential
ticket: 03
title: Invitation tokens through SecretHash; internal/tokens.ts deleted
type: execute
wave: 2
depends_on: [01]
files_modified:
  - packages/organization/test/OrganizationInvitations.test.ts
  - packages/organization/src/OrganizationInvitations.ts
  - packages/organization/src/internal/tokens.ts
autonomous: true
requirements: [REQ-EA-1600, REQ-EA-1601, REQ-EA-1602]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "An invitation's stored tokenHash is the SHA-256 lower-case hex of the mailed token, before and after the change"
    - "An unknown invitation id, a wrong token and an invitation with no stored hash still all answer InvitationNotFound, after the same hash and compare work"
    - "packages/organization/src has no hex encoder and no never-matching constant of its own"
  artifacts:
    - "packages/organization/test/OrganizationInvitations.test.ts (one assertion pinning the at-rest form)"
    - "packages/organization/src/OrganizationInvitations.ts (SecretHash.digest, SecretHash.NEVER_MATCHES, Hmac.toHex)"
    - "packages/organization/src/internal/tokens.ts (deleted)"
  key_links:
    - "OrganizationInvitations requireInvitationToken -> SecretHash.equals against the stored hash or SecretHash.NEVER_MATCHES"
    - "OrganizationInvitations mintToken / findByToken / holdsToken -> SecretHash.digest"
---
Status: done (uncommitted)
Blocked by: 01

<objective>
Remove organization's private copies of the hash recipe (`OrganizationInvitations.ts:209-211`), of the hex encoder, and of the never-matching hash (`internal/tokens.ts:5-6, 13`). Delete `internal/tokens.ts`. First pin the at-rest form with a Node-oracle assertion.

Purpose: PLAN §2.5 and §2.6 item 3. The invitation's id-plus-token protocol (MTI-010) is correct and keeps its order: lookup, hash, compare, then branch.

Output: one new assertion, one file deleted, one module re-pointed at the shared recipe.
</objective>

<context>
@.planning/39-hashed-credential/PLAN.md (§2.2 invitation row, §2.4, §2.5)
@packages/organization/src/internal/tokens.ts
@packages/organization/src/OrganizationInvitations.ts (lines 15-50 imports; 205-325 token helpers, `findByToken`, `holdsToken`)
@packages/organization/test/OrganizationInvitations.test.ts (lines 80-126)
@packages/organization/test/Organization.test.ts (lines 1030-1095: the uniform InvitationNotFound tests that must stay green)
@packages/core/src/SecretHash.ts
</context>

<tasks>
  <task type="auto" tdd="true">
    <name>Task 1: Pin the at-rest form of an invitation token</name>
    <files>packages/organization/test/OrganizationInvitations.test.ts</files>
    <read_first>packages/organization/test/OrganizationInvitations.test.ts (lines 1-30 imports; 80-126)</read_first>
    <behavior>
      - In "mails the capability with the organization's name, and stores only its hash", the invitation's tokenHash equals Option.some(createHash("sha256").update(token, "utf8").digest("hex")) for the mailed token
      - The mailed token matches /^[0-9a-f]{64}$/
    </behavior>
    <action>In the existing test at lines 107-126, after the `mailedToken` line, add two assertions: `invitation.tokenHash` deep-equals `Option.some` of the Node oracle hash of `token`, and `token` matches the 64-lower-hex regex. Import `createHash` from `node:crypto`. Keep the existing assertions (the not-equal-to-token check and both `holdsToken` checks). The test must pass at HEAD, before task 2.</action>
    <verify><automated>npx vitest run packages/organization/test/OrganizationInvitations.test.ts</automated></verify>
    <acceptance_criteria>`grep -c 'createHash' packages/organization/test/OrganizationInvitations.test.ts` ≥ 1 (baseline at HEAD: 0). The file passes at HEAD.</acceptance_criteria>
    <done>The invitation token's at-rest form is pinned by a passing assertion.</done>
  </task>

  <task type="auto">
    <name>Task 2: Use SecretHash and Hmac.toHex; delete internal/tokens.ts</name>
    <files>packages/organization/src/OrganizationInvitations.ts, packages/organization/src/internal/tokens.ts</files>
    <read_first>packages/organization/src/OrganizationInvitations.ts (lines 15-50 and 205-325), packages/organization/src/internal/tokens.ts</read_first>
    <action>Add `SecretHash` to the existing `@awthaq/core` import at line 20. `Hmac` is already imported from `@awthaq/ports`. Delete the line-44 import of the two helpers from `./internal/tokens.ts`, then delete `packages/organization/src/internal/tokens.ts` with `git rm`. Inside the `Layer.effect` body: make the local hash helper (line 210) return `SecretHash.digest(hasher, token)`, or replace its uses with that call and delete it. In `mintToken`, build the token with `Hmac.toHex` of the 32 random bytes. In `requireInvitationToken`, use `SecretHash.NEVER_MATCHES` as the fallback in the `Option.getOrElse`. Keep the order exactly: `findById`, then hash, then compare, then the single branch on found, stored and matches. Keep using `Hmac.constantTimeEqualString`, or switch both compares (`requireInvitationToken` and `holdsToken`) to `SecretHash.equals`. Both are the same function, so pick `SecretHash.equals` for consistency with api-key and Sessions. Keep the MTI-010 doc comment, and change its wording only where it named the deleted constant. Do not touch `findByToken`'s lookup-by-hash logic beyond the hash call. Do not touch any other part of the file (plan 29 edits its events).</action>
    <verify><automated>test ! -e packages/organization/src/internal/tokens.ts && test "$(grep -rn 'padStart' packages/organization/src | wc -l)" = 0 && test "$(grep -rn 'Digest.sha256' packages/organization/src | wc -l)" = 0 && npx vitest run packages/organization/test/OrganizationInvitations.test.ts packages/organization/test/Organization.test.ts packages/organization/test/AuthorizationMatrix.test.ts</automated></verify>
    <acceptance_criteria>`internal/tokens.ts` is absent (baseline at HEAD: present). `grep -rn 'padStart' packages/organization/src | wc -l` = 0 (baseline: 1). `grep -rn 'Digest.sha256' packages/organization/src | wc -l` = 0 (baseline: 1). Across the repo, `grep -rn '"0".repeat(64)' packages/*/src | grep -v AuditChain | wc -l` = 1 (baseline: 2). `grep -c 'SecretHash.NEVER_MATCHES' packages/organization/src/OrganizationInvitations.ts` = 1 (baseline: 0). `Organization.test.ts:1042-1088` passes unchanged.</acceptance_criteria>
    <done>Organization has no hash recipe, hex encoder or fallback constant of its own. Every invitation test, including the uniform-answer tests, passes unchanged.</done>
  </task>
</tasks>

<threat_model>
| Where untrusted input crosses | Description |
|---|---|
| `(invitationId, token)` → accept/reject | an invitee, or anyone who knows an invitation id, presents a token |
| `token` → `getInvitationByToken` | a token alone is looked up by its hash |

| Threat ID | Category | Target | Severity | Disposition | Mitigation Plan |
|---|---|---|---|---|---|
| T-39-06 | Information disclosure | `requireInvitationToken` | medium | mitigate | An unknown id, a wrong token and a hash-less invitation must do the same hash and compare work and answer the same `InvitationNotFound` (MTI-010, PIL-007 style). The action fixes the order. `Organization.test.ts:1042-1088` must pass unchanged |
| T-39-07 | Denial of service | stored `tokenHash` | high | mitigate | A drift would kill every pending invitation. Task 1's oracle assertion is written before task 2 |
| T-39-08 | Tampering | fallback constant | low | mitigate | `SecretHash.NEVER_MATCHES` equals the deleted constant in value (64 zeros). Ticket 01's test proves no digest equals it |
</threat_model>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
- `packages/organization/src/internal/tokens.ts` deleted.
- Repo-wide all-zero hash constants outside `AuditChain`: 1 (was 2).
- The at-rest assertion passes before and after the swap.
- The per-ticket gate is green.
</success_criteria>

## Comments

Done (uncommitted). OrganizationInvitations.test.ts: oracle assertion added (passed at HEAD first). OrganizationInvitations.ts uses SecretHash.digest/equals/NEVER_MATCHES and Hmac.toHex; internal/tokens.ts deleted (plain rm). Deviation: oxfmt reformatted the whole test file (it was not oxfmt-clean at HEAD), so its diff is large; assertions unchanged. packages/organization tests pass.
