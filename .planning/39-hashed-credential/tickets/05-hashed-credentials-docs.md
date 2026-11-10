---
plan: 39-hashed-credential
ticket: 05
title: The hashed-credential protocol for plugin authors, and the changeset
type: execute
wave: 3
depends_on: [02, 03, 04]
files_modified:
  - docs/plugin-authoring.md
  - .changeset/hashed-credential-residue.md
autonomous: true
requirements: [REQ-EA-1603]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "A plugin author reading docs/plugin-authoring.md learns: mint with SecureRandom, store only SecretHash.digest, pick one of two lookup shapes, compare with SecretHash.equals against the stored hash or NEVER_MATCHES before any branch on record state, and hash rather than seal a value the server only recognises"
    - "The changeset names every package the plan touched and says Migration: none."
    - "pnpm check is green on the plan's last commit"
  artifacts:
    - "docs/plugin-authoring.md (## Hashed credentials, plus checklist item 11)"
    - ".changeset/hashed-credential-residue.md (new)"
  key_links:
    - "docs/plugin-authoring.md '## Hashed credentials' cites @awthaq/api-key (id lookup, grace slot), @awthaq/scim (lookup by hash) and core Sessions (RRS-005) as worked examples"
---
Status: ready-for-agent
Blocked by: 02, 03, 04

<objective>
Write the hashed-credential protocol down where the next plugin author will read it, and add the plan's changeset.

Purpose: the risk that justified the candidate is a new credential that forgets "compare before branching" (PLAN §1.2, the evidence for GO). A five-step module would not prevent that cheaply (G4). A short, exact section in `docs/plugin-authoring.md`, next to "Contributing a credential type", does. This ticket is the plan's real deliverable for that risk.

Output: one new docs section, one checklist line, one changeset.
</objective>

<context>
@.planning/39-hashed-credential/PLAN.md (§2.3, §3.4, §3.5)
@docs/plugin-authoring.md (lines 96-108 "Contributing a credential type"; 159-167 "Sealed columns"; 279-300 checklist)
@packages/core/src/SecretHash.ts (the header ticket 01 rewrote)
@packages/api-key/src/ApiKey.ts (lines 971-984 and 1080-1106: the worked examples)
@packages/scim/src/ScimConnections.ts (the lookup-by-hash example)
@spec/decisions/022-api-key-rotation-and-transport.md (decisions 1 and 2)
@.changeset/plugin-ddl-locality.md (the changeset format for an internal move)
</context>

<tasks>
  <task type="auto">
    <name>Task 1: Add "## Hashed credentials" to docs/plugin-authoring.md</name>
    <files>docs/plugin-authoring.md</files>
    <read_first>docs/plugin-authoring.md (lines 96-108, 159-167, 279-300), packages/core/src/SecretHash.ts</read_first>
    <action>Insert a new `## Hashed credentials` section directly after "Contributing a credential type" (before "Personal data: erasure and export"). Keep the file's style: short paragraphs and bullets, one example per rule, and no code block longer than about 6 lines. It must say, in this order:
(1) A credential the server mints and only needs to *recognise* when presented back (a key, a client secret, a directory token, an invitation token, a device code) is stored as `SecretHash.digest(hasher, secret)` only, shown once, and never logged. A secret a person chooses goes to `PasswordHasher`. A value the server must read again is sealed instead (link to "Sealed columns"). Never both. A sealed bearer credential is a working credential for whoever holds the table and the key; a hashed one is not.
(2) Mint 32 bytes with `SecureRandom` and encode them with `Hmac.toHex`. An optional prefix makes `claims` cheap.
(3) Pick one of two lookup shapes. *By the hash* when the credential has no public id: look up the row by `SecretHash.digest`, and a found row has matched (`@awthaq/scim`). *By a public id* when the token carries one (`id.secret`) or the id arrives separately: hash the presented secret, read the row, then compare with `SecretHash.equals` against the stored hash, or `SecretHash.NEVER_MATCHES` when there is no row, *before* any branch on the row's state, and answer every refusal the same way (PIL-007; `@awthaq/api-key`'s `resolve`).
(4) Rotation with overlap keeps a second, previous hash with its own expiry, and compares both slots on every presentation, found or not (ADR-EA-022 decision 2, RRS-005; `issueServiceToken` and core `Sessions` are the examples). The alternative is a successor row (ADR-EA-022 decision 1).
(5) Prove the at-rest form with a test against Node's `createHash("sha256")`, and the uniform answer with one test that presents an unknown id, a wrong secret and a revoked credential.
Then append checklist item 11 to "Checklist for a new plugin": "A credential the plugin mints is stored only as `SecretHash.digest` and verified as in 'Hashed credentials' (one lookup shape; compare before any state branch; uniform refusals)." Do not edit any other section.</action>
    <verify><automated>test "$(grep -c '^## Hashed credentials' docs/plugin-authoring.md)" = 1 && test "$(grep -c 'SecretHash' docs/plugin-authoring.md)" -ge 3 && pnpm format:check</automated></verify>
    <acceptance_criteria>`grep -c '^## Hashed credentials' docs/plugin-authoring.md` = 1 (baseline at HEAD: 0). `grep -c 'SecretHash' docs/plugin-authoring.md` ≥ 3 (baseline: 0). The checklist ends at item 11 (baseline: 10). `pnpm format:check` passes.</acceptance_criteria>
    <done>The protocol, the two lookup shapes, the grace slot and hash versus seal are documented next to "Contributing a credential type".</done>
  </task>

  <task type="auto">
    <name>Task 2: Changeset and the plan gate</name>
    <files>.changeset/hashed-credential-residue.md</files>
    <read_first>.changeset/plugin-ddl-locality.md</read_first>
    <action>Create `.changeset/hashed-credential-residue.md` with `patch` bumps for `@awthaq/core`, `@awthaq/scim`, `@awthaq/organization`, `@awthaq/saml` and `@awthaq/ports`. In the body, say in two or three sentences: SCIM tokens, organization invitation tokens and verification values are now hashed through `SecretHash.digest`, and every hex encoding goes through `Hmac.toHex`; the stored hashes are byte-identical (pinned by known-answer tests), so existing tokens, invitations and imported scrypt passwords keep working. End with the line `Migration: none.` Then run the per-plan gate.</action>
    <verify><automated>test -e .changeset/hashed-credential-residue.md && grep -c '^Migration: none\.' .changeset/hashed-credential-residue.md && pnpm check</automated></verify>
    <acceptance_criteria>The changeset exists (baseline at HEAD: absent) and lists exactly the five packages. `grep -c '^Migration: none\.'` = 1. `pnpm check` exits 0.</acceptance_criteria>
    <done>The changeset is present, and the whole plan passes `pnpm check`.</done>
  </task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm check
</verification>

<success_criteria>
- `## Hashed credentials` present once; checklist item 11 present.
- The changeset is present with `Migration: none.`
- `pnpm check` is green.
</success_criteria>

## Comments
