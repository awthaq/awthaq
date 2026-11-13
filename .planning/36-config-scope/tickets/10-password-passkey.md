---
plan: 36-config-scope
ticket: 10
title: "Password and Passkey: declarations with verified boot fields"
type: execute
wave: 2
depends_on: ["04"]
files_modified:
  - packages/password/src/PasswordConfig.ts
  - packages/password/src/Password.ts
  - packages/password/src/PasswordCredential.ts
  - packages/passkey/src/PasskeyConfig.ts
  - packages/passkey/src/Passkey.ts
autonomous: true
requirements: [REQ-EA-1572, REQ-EA-1574, REQ-EA-1577]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "PasswordConfig and PasskeyConfig are declared Tenant.perTenant with boot fields that no operation reads per request"
    - "Every PasswordConfig and PasskeyConfig read goes through Tenant.inForce"
    - "Both config(...) constructors return the declaration's layer; both descriptors are made from it"
    - "The existing tenant pins pass unchanged"
  artifacts:
    - path: "packages/password/src/PasswordConfig.ts"
      provides: "PasswordConfigScoped"
    - path: "packages/passkey/src/PasskeyConfig.ts"
      provides: "PasskeyConfigScoped"
  key_links:
    - from: "Password.ts handlers group (427-428)"
      to: "Tenant.inForce(PasswordConfigScoped)"
      via: "the enumeration posture per tenant"
      pattern: "inForce\\(PasswordConfigScoped\\)"
---
Status: done (uncommitted)
Blocked by: 04

<objective>
Declare `PasswordConfig` and `PasskeyConfig` (PLAN.md §2.3 rows 3 and 9), each with its verified boot fields, and route every read through the accessor.
Purpose: ticket 14's flipped F1 test reads Password as tenant-scoped; the boot fields make the view truthful for values derived at boot (F8).
Output: five edited modules.
</objective>

<context>
@.planning/36-config-scope/PLAN.md (§2.3 rows 3, 9; §3.5 rule 3)
@packages/password/src/PasswordConfig.ts (lines 110-130)
@packages/password/src/Password.ts (lines 420-430, 540-560, 605-680)
@packages/password/src/PasswordCredential.ts (lines 195-250)
@packages/passkey/src/PasskeyConfig.ts (lines 140-160)
@packages/passkey/src/Passkey.ts (lines 735-835, 860-870)
@packages/passkey/src/PasskeyCeremony.ts (lines 60-75, 175-210, 305-315)
</context>

<tasks>
<task type="auto">
  <name>Task 1: decide the boot fields (rule 3) and record them</name>
  <files>packages/password/src/PasswordConfig.ts, packages/passkey/src/PasskeyConfig.ts</files>
  <read_first>PLAN.md §3.5 rule 3; the candidate lists in §2.3 rows 3 and 9</read_first>
  <action>For each candidate field run `grep -n "<field>" packages/<pkg>/src/*.ts` and read every hit. A field is boot only if every read is of the build value inside the module's build (or of a value computed there once). Expected outcome at HEAD: Password boot = `identifierDigestKey`, `rateLimitEmailKey` (`signInTimingFloor` is read per operation at `PasswordCredential.ts:243`, so it is NOT boot even though `:228` calibrates it at build). Passkey boot = `ceremonyTimeout`, `enumerationSecret`; `relatedOrigins`, `attestation` and `attestationPolicy` are boot only if the policy object `PasskeyCeremony` reads (`:178`, `:207`, `:311`) is built from the build value and never from the per-operation value: read `Passkey.ts:783-870` to decide, and include them only if so. Never declare a `can*`-style predicate boot. Add `PasswordConfigScoped` and `PasskeyConfigScoped` with the decided lists, and record each decision (field, verdict, the line that decided it) in this ticket's Comments.</action>
  <verify><automated>pnpm build</automated></verify>
  <acceptance_criteria>
    - `grep -c "perTenant(PasswordConfig" packages/password/src/PasswordConfig.ts` prints 1 and `grep -c "perTenant(PasskeyConfig" packages/passkey/src/PasskeyConfig.ts` prints 1 (baselines 0)
    - `grep -n "signInTimingFloor" packages/password/src/PasswordConfig.ts` does not show it inside the boot list
  </acceptance_criteria>
  <done>Two declarations whose boot lists are justified line by line in Comments.</done>
</task>

<task type="auto">
  <name>Task 2: constructors, descriptors, reads</name>
  <files>packages/password/src/PasswordConfig.ts, packages/password/src/Password.ts, packages/password/src/PasswordCredential.ts, packages/passkey/src/PasskeyConfig.ts, packages/passkey/src/Passkey.ts</files>
  <read_first>the read sites: Password.ts:427-428, :613-614; PasswordCredential.ts:202-203; Passkey.ts:783-784</read_first>
  <action>Make `PasswordConfig.config` (`:122`) and `PasskeyConfig.config` (`:151`) return the declaration's `layer` and drop their `Layer.Layer<never>` annotations. Make the descriptors (`Password.ts:546`, `Passkey.ts:741`) from the declarations. At each hybrid site write `const configNow = yield* Tenant.inForce(<Declared>)` for the per-operation reads. Where the module also derives a value once at build (`Password.ts:625-632`, `:677`, `PasswordCredential.ts:228`, `Passkey.ts:796-829`), add `const builtConfig = yield* configNow` right after it, in the build: run in the build fiber, the accessor resolves to the build value. Comment that line: "read once at build: the build value (BEH-EA-362 boot fields)". Keep the local names `builtConfig` and `configNow` so the bodies do not change.</action>
  <verify><automated>npx vitest run packages/password/test/PasswordTenantConfig.test.ts packages/password/test/Password.test.ts packages/password/test/PasswordCredential.test.ts packages/passkey/test/PasskeyTenantConfig.test.ts packages/passkey/test/Passkey.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -rnE 'yield\* *PasswordConfig\b' packages/password/src | wc -l` prints 0 (baseline 3)
    - `grep -rnE 'yield\* *PasskeyConfig\b' packages/passkey/src | wc -l` prints 0 (baseline 1)
    - `grep -rn 'configInForce' packages/password/src packages/passkey/src | wc -l` prints 0 (baseline 4)
  </acceptance_criteria>
  <done>Password and Passkey read only through the accessor.</done>
</task>

<task type="auto">
  <name>Task 3: the administrator's and the CLI's password paths still obey the tenant</name>
  <files>packages/password/src/PasswordCredential.ts</files>
  <read_first>features/features/12-multi-tenancy/28-tenancy.feature (REQ-EA-1308); packages/admin/test/AdminAccounts.test.ts lines 430-470</read_first>
  <action>No code change is expected. Run the suites that exercise `PasswordCredential` from other packages (ADR-EA-048): a tenant's `Password.config` governs an administrator-set password.</action>
  <verify><automated>pnpm build && npx vitest run packages/admin/test/AdminAccounts.test.ts packages/cli/test/Seed.test.ts</automated></verify>
  <acceptance_criteria>
    - Both suites pass unchanged
  </acceptance_criteria>
  <done>Plan 27's guarantees hold.</done>
</task>
</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| application `TenantConfig` lookup → password and passkey policy | a tenant's stricter policy applies to its own sign-ups, sign-ins and registrations |

## STRIDE threat register

| Threat ID | Category | Component | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-36-03 | Elevation | a policy field wrongly declared boot (a tenant's `minLength`, `requireVerifiedEmail` or `origins` ignored) | high | mitigate | Task 1's per-field grep verdicts recorded in Comments; the tenant pins (`PasswordTenantConfig.test.ts:40-85`, `PasskeyTenantConfig.test.ts:49-60`) run unchanged |
| T-36-04 | Information disclosure | `identifierDigestKey`, `enumerationSecret` in the view | medium | mitigate | both are `Redacted` or declared sensitive in the existing descriptors; unchanged by this ticket |
</threat_model>

<verification>
pnpm build
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
Raw reads 4 → 0 across both packages; boot lists justified; all tenant pins green.
</success_criteria>

## Comments

### Result (uncommitted)
Boot decisions (rule 3). Password: `identifierDigestKey` (Password.ts digestKey, build-only), `rateLimitEmailKey` (identifierDigest + RateLimits.budget, build-only) = boot; `signInTimingFloor` read per operation (PasswordCredential withTimingFloor) = NOT boot. Passkey: `enumerationSecret` (build-only derivation) = boot; `ceremonyTimeout` = boot per the ticket's expected outcome: it is validated against the challenge TTL at build and the per-operation `ceremonyKnobsOf` would otherwise let a tenant's value skip that validation; `relatedOrigins`, `attestation`, `attestationPolicy` are read per operation (ceremony policy, Passkey.ts relatedOrigins/creation options) = NOT boot (boot checks stay on the build value).
Added `PasswordConfigScoped`/`PasskeyConfigScoped` (also exported from the plugin modules); `config(...)` returns the declaration's layer; descriptors made from them; reads via `Tenant.inForce` + `builtConfig = yield* configNow` at build. Raw reads/configInForce in both packages: 0. Tests: password 180, passkey 314 pass. Task 3 suites (AdminAccounts) pass; cli Seed.test not run.
