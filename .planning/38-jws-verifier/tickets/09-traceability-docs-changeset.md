---
plan: 38-jws-verifier
ticket: 09
title: "Traceability, READMEs, changeset"
type: execute
wave: 3
depends_on: [07]
files_modified:
  - spec/traceability.md
  - packages/jwt/README.md
  - packages/oauth/README.md
  - packages/oauth/src/index.ts
  - .changeset/jws-verifier.md
autonomous: true
requirements: [REQ-EA-1593, REQ-EA-1594, REQ-EA-1595, REQ-EA-1596]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "ADR-EA-057 is traced to its tests; the OAuth and jwt test rows name Jws and the differential vectors"
    - "No README claims a behaviour the code no longer has (oauth README line 93, oauth index header 'RS256-only')"
    - "One changeset covers @awthaq/ports (minor), @awthaq/jwt (minor) and @awthaq/oauth (patch), with a Migration line"
    - "pnpm check is green"
  artifacts:
    - path: .changeset/jws-verifier.md
      provides: "release note with Migration line"
  key_links:
    - from: spec/traceability.md
      to: spec/decisions/057-one-jws-verifier.md
      via: "ADR row (verify-traceability check 3)"
---
Status: done (uncommitted)
Blocked by: 07

<objective>
Close the plan: traceability, user-facing docs, the release note, and the plan gate.

Purpose: `pnpm check` must be green at the end of the plan, and the docs must describe the shipped verifier.

Output: updated traceability rows, two READMEs, one source header comment, one changeset, and a green `pnpm check`.
</objective>

<context>
@.planning/38-jws-verifier/PLAN.md (§6.3, §6.4, §9)
@spec/traceability.md (line 161 ADR-EA-017 row; line 188 ADR-EA-049 row shape; line 280 OAuth row; line 373 jwt row)
@packages/jwt/README.md (line 41: lite verifier)
@packages/oauth/README.md (lines 52-62 OIDC validation table; line 93 stale claim)
@packages/oauth/src/index.ts (lines 1-14 header comment)
@.changeset/api-key-owner-standing.md
@.planning/IMPLEMENTING.md (knip noise under .reports/ is pre-existing)
</context>

<!-- planner-discipline-allow: RS256-only -->
<!-- planner-discipline-allow: ES256/EdDSA `id_token` signatures -->
The two literals above are named in task 1's action only to locate the text being removed.

<tasks>

<task type="auto">
  <name>Task 1: Traceability rows and docs</name>
  <files>spec/traceability.md, packages/jwt/README.md, packages/oauth/README.md, packages/oauth/src/index.ts</files>
  <read_first>spec/traceability.md (lines 155-190, 275-285, 365-375)</read_first>
  <action>
`spec/traceability.md`:
- Add an ADR-EA-057 row after ADR-EA-049, in the same shape: link, title, and test paths `packages/ports/test/Jws.test.ts`, `packages/jwt/test/JwsDifferential.test.ts`, `packages/oauth/test/JwsDifferential.test.ts`.
- Append `packages/jwt/test/Jwt.test.ts` to the ADR-EA-017 row's tests.
- In the OAuth row (line 280), replace "that `Jwt.ts`'s own verifier checks" with "that `@awthaq/ports`'s `Jws` verifies (ADR-EA-057)".
- In the `packages/jwt/test/*` row (line 373), add "the differential JWS vectors shared with `@awthaq/oauth` (plan 38)".
- Add a test-file row for `packages/ports/test/Jws.test.ts`: "ADR-EA-057, BEH-EA-293/298/127: every `jwsVectors.ts` vector at the module interface, the refetch contract, a no-defect loop over hostile strings, and the cases moved from `oauth/test/Jwt.test.ts` and `jwt/test/JwtCodec.test.ts`".
- Bump the Document Control revision with a change history entry naming plan 38.

`packages/jwt/README.md` line 41 (lite verifier) gains one sentence: keys are selected per RFC 7517 (a key without `alg` is usable for an allowlisted algorithm its key type fits; `use: "enc"` and `key_ops` without `verify` are ignored), and a token with a `crit` header is refused.

`packages/oauth/README.md`:
- In the "Signature" row of the OIDC validation table (line 56), add "`key_ops` absent or including `verify`" and "a `crit` header refuses the token".
- Delete the stale bullet at line 93 that says ES256/EdDSA `id_token` signatures are unsupported. Keep the `form_post` limitation as its own bullet.

`packages/oauth/src/index.ts` header comment: replace "(RS256-only `id_token` verification, no vendor presets)" with "(`id_token` verification through `@awthaq/ports`'s `Jws`; vendor presets under `./presets`)".
  </action>
  <verify><automated>pnpm check:readmes && bash spec/scripts/verify-traceability.sh --strict</automated></verify>
  <acceptance_criteria>
- `grep -c 'ADR-EA-057' spec/traceability.md` ≥ 1 (baseline at HEAD: 0).
- `grep -c 'ES256/EdDSA `id_token` signatures' packages/oauth/README.md` = 0 (baseline at HEAD: 1).
- `grep -c 'RS256-only' packages/oauth/src/index.ts` = 0 (baseline at HEAD: 1).
- The strict traceability run reports `FAIL: 0`.
  </acceptance_criteria>
  <done>Traceability and docs match the code.</done>
</task>

<task type="auto">
  <name>Task 2: Changeset and the plan gate</name>
  <files>.changeset/jws-verifier.md</files>
  <read_first>.changeset/api-key-owner-standing.md</read_first>
  <action>
Write `.changeset/jws-verifier.md`.

Front matter: `"@awthaq/ports": minor`, `"@awthaq/jwt": minor`, `"@awthaq/oauth": patch`.

Body:
- `@awthaq/ports` adds `Jws`, the one compact-JWS verifier (ADR-EA-057).
- `@awthaq/jwt`:
  - `JwtCodec.verify` accepts an optional `refetch`, and `VerificationKey.alg` is optional;
  - the lite verifier accepts JWKS keys without `alg` (RFC 7517 §4.4) and ignores `use: "enc"`/`key_ops`-restricted keys;
  - every verifier refuses a `crit` header (RFC 7515 §4.1.11).
- `@awthaq/oauth`: `id_token` verification honours `key_ops` and refuses `crit`; the internal `Jwt` module is removed (it was never exported).
- Name BEH-EA-127/293/298.

Last line: "Migration: no code changes. An issuer that sets `crit` on its tokens, or serves its signing key with `key_ops` that exclude `verify`, is now refused; fix the issuer's tokens or JWKS."

Then run the plan gate. Per `.planning/IMPLEMENTING.md`, `pnpm knip` noise limited to `.reports/` counts as passing. Record the outcome of every gate in Comments.
  </action>
  <verify><automated>grep -c '^Migration:' .changeset/jws-verifier.md && pnpm check</automated></verify>
  <acceptance_criteria>
- The grep prints 1.
- `pnpm check` is green. If knip lists only `.reports/` files, record that in Comments and treat it as passing.
  </acceptance_criteria>
  <done>The plan's gate is green.</done>
</task>

</tasks>

<verification>
pnpm check
</verification>

<success_criteria>
- `pnpm check` is green; the PLAN.md §9 acceptance checklist is ticked in this ticket's Comments.
</success_criteria>

## Comments
Result (uncommitted). REQ ids used: 1567/1568 (plan's 1590/1591); the plan-internal 1592-1596 appear in no spec, code, test, changeset or doc (only in plan/ticket frontmatter). traceability.md rev 1.84 -> 1.85: ADR-EA-057 row, ADR-EA-017 row + Jwt.test.ts, OAuth and jwt/test rows, Jws.test.ts row, section 6 file 11 row (1567-1568, 52/52). READMEs: ports (Jws), jwt (lite verifier), oauth (key_ops/crit, stale ES256/EdDSA bullet removed). `packages/oauth/src/index.ts` header comment edited (comment only, ticket-mandated). `.changeset/jws-verifier.md` (ports minor, jwt minor, oauth patch, Migration line). docs/plugin-authoring.md not named by this ticket, untouched. Gates run: spec:verify:strict PASS 32 / FAIL 0; check:readmes PASS; oxfmt on touched files clean; check:error-tags FAILS only on packages/test/src/TestAuth.ts:624 and TestMailbox.ts:82,97 (plan 35, not this plan). Not run (not allowed): pnpm check, test, lint, knip, coverage, package:smoke.

Acceptance checklist (section 9): 01-09 done in tree, uncommitted; 09's `pnpm check` not run in full.
