---
plan: 39-hashed-credential
ticket: 04
title: The remaining hex encoders onto Hmac.toHex
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/saml/src/Saml.ts
  - packages/saml/src/SamlSlo.ts
  - packages/ports/src/PasswordHasher.ts
autonomous: true
requirements: [REQ-EA-1601]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "scrypt PHC strings encode and verify exactly as before (PasswordHasher scrypt vectors pass unchanged)"
    - "A SAML assertion id, and a Single Logout request id, is refused on replay exactly as before (the replay key is byte-identical)"
    - "After tickets 02, 03 and 04, Hmac.toHex is the only hex encoder in packages/*/src"
  artifacts:
    - "packages/saml/src/Saml.ts, packages/saml/src/SamlSlo.ts (local encoder deleted)"
    - "packages/ports/src/PasswordHasher.ts (local toHex deleted)"
  key_links:
    - "Saml.ts assertion replay digest -> Hmac.toHex (from @awthaq/ports)"
    - "SamlSlo.ts request replay digest -> Hmac.toHex (from @awthaq/ports)"
    - "PasswordHasher.ts scrypt encode/verify -> Hmac.toHex (./Hmac.ts, already imported at line 117)"
---
Status: done (uncommitted)
Blocked by: none

<objective>
Delete the three hex encoders that remain outside `Hmac.ts`: `saml/src/Saml.ts:361-362`, `saml/src/SamlSlo.ts:89-90` and `ports/src/PasswordHasher.ts:258-259`. Use `Hmac.toHex` instead. None of them is a hashed credential, but they are the same function, and PLAN §1.3 goal 2 is one encoder.

Purpose: PLAN §2.5 and §2.6 item 5. Batch-4 plan 40 must not also do this (PLAN §8).

Output: three local helpers deleted, four call sites changed. No behaviour change.
</objective>

<context>
@.planning/39-hashed-credential/PLAN.md (§2.5)
@packages/ports/src/Hmac.ts (lines 15-16 `toHex`)
@packages/ports/src/PasswordHasher.ts (lines 110-120 imports; 255-262; 550-576 scrypt)
@packages/saml/src/Saml.ts (line 48 ports import; 359-363; 1015-1030)
@packages/saml/src/SamlSlo.ts (lines 20-30 imports; 87-91; 335-345)
</context>

<tasks>
  <task type="auto">
    <name>Task 1: PasswordHasher uses Hmac.toHex</name>
    <files>packages/ports/src/PasswordHasher.ts</files>
    <read_first>packages/ports/src/PasswordHasher.ts (lines 110-120, 255-262, 550-576), packages/ports/src/Hmac.ts (lines 15-16)</read_first>
    <action>Delete the module-private `toHex` const at lines 258-259. Change its two uses (the scrypt PHC encoding at line 555, and the constant-time compare at line 574) to `Hmac.toHex`. `Hmac` is already imported from `./Hmac.ts` at line 117. Change nothing else: the argon2 path, the base64 helpers and the PHC parsing are out of scope.</action>
    <verify><automated>test "$(grep -c 'padStart' packages/ports/src/PasswordHasher.ts)" = 0 && npx vitest run packages/ports/test/PasswordHasher.test.ts packages/ports/test/PasswordHasherParsing.property.test.ts</automated></verify>
    <acceptance_criteria>`grep -c 'padStart' packages/ports/src/PasswordHasher.ts` = 0 (baseline at HEAD: 1). `grep -c 'Hmac.toHex' packages/ports/src/PasswordHasher.ts` = 2 (baseline: 0). Both test files pass unchanged.</acceptance_criteria>
    <done>PasswordHasher has no hex encoder of its own, and its scrypt vectors pass.</done>
  </task>

  <task type="auto">
    <name>Task 2: SAML uses Hmac.toHex for its replay digests</name>
    <files>packages/saml/src/Saml.ts, packages/saml/src/SamlSlo.ts</files>
    <read_first>packages/saml/src/Saml.ts (line 48, 359-363, 1015-1030), packages/saml/src/SamlSlo.ts (lines 20-30, 87-91, 335-345)</read_first>
    <action>In `Saml.ts`, add `Hmac` to the existing `@awthaq/ports` import at line 48, delete the local encoder at lines 361-362, and call `Hmac.toHex` at the replay digest (line 1021). In `SamlSlo.ts`, add `Hmac` to the existing `@awthaq/ports` import at line 25, delete the local encoder at lines 89-90, and call `Hmac.toHex` at line 339. The digested input (`idpEntityId|assertion.id` and the SLO equivalent) and the replay-store calls stay untouched. These digests are replay keys, not credentials, so do not route them through `SecretHash`.</action>
    <verify><automated>test "$(grep -c 'padStart' packages/saml/src/Saml.ts)" = 0 && test "$(grep -c 'padStart' packages/saml/src/SamlSlo.ts)" = 0 && npx vitest run packages/saml/test/Saml.test.ts packages/saml/test/SamlSlo.test.ts packages/saml/test/SamlSloHttp.test.ts</automated></verify>
    <acceptance_criteria>`grep -c 'padStart'` is 0 in both files (baseline at HEAD: 1 each). After tickets 02 and 03 have also landed, `grep -rn 'toString(16).padStart(2' packages/*/src | grep -v 'packages/ports/src/Hmac.ts' | wc -l` = 0 (baseline: 5). The three SAML test files pass unchanged.</acceptance_criteria>
    <done>SAML has no hex encoder of its own, and its replay tests pass.</done>
  </task>
</tasks>

<threat_model>
| Where untrusted input crosses | Description |
|---|---|
| presented password → scrypt verify | an imported scrypt credential is checked against the presented password |
| IdP assertion / SLO request → replay check | an attacker may replay a captured assertion inside its time window |

| Threat ID | Category | Target | Severity | Disposition | Mitigation Plan |
|---|---|---|---|---|---|
| T-39-09 | Spoofing | `PasswordHasher` scrypt verify | high | mitigate | A changed hex form would fail every imported scrypt password, or would need to stay consistent with stored PHC strings. `Hmac.toHex` has an identical body. The scrypt vectors in `PasswordHasher.test.ts` must pass unchanged |
| T-39-10 | Spoofing (replay) | SAML replay key | medium | mitigate | A changed key would let an assertion seen before the deploy be replayed once after it. The body is identical. `Saml.test.ts` and `SamlSlo.test.ts` replay cases must pass unchanged |
</threat_model>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
- 0 hex encoders in `Saml.ts`, `SamlSlo.ts` and `PasswordHasher.ts` (1 each at HEAD).
- PasswordHasher and SAML tests pass unchanged.
- The per-ticket gate is green.
</success_criteria>

## Comments

Done (uncommitted). PasswordHasher.ts, Saml.ts, SamlSlo.ts local hex encoders deleted; Hmac.toHex used (SAML imports Hmac from @awthaq/ports). Only Hmac.ts has padStart(2) hex now (SamlKeys.ts padStart is a date helper). PasswordHasher and packages/saml tests pass.
