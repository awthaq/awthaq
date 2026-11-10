---
plan: 36-config-scope
ticket: 15
title: "Magic link, email OTP, api-key, device authorization: deployment-scoped declarations"
type: execute
wave: 2
depends_on: ["04", "02"]
files_modified:
  - packages/magic-link/src/MagicLink.ts
  - packages/magic-link/src/EmailOtp.ts
  - packages/api-key/src/ApiKey.ts
  - packages/device-authorization/src/DeviceAuthorization.ts
  - packages/magic-link/test/MagicLink.test.ts
autonomous: true
requirements: [REQ-EA-1572, REQ-EA-1573, REQ-EA-1576]
estimate: {tasks: 3, size: S}
must_haves:
  truths:
    - "MagicLinkConfig, EmailOtpConfig, ApiKeyConfig and DeviceAuthorizationConfig are declared Tenant.perDeployment"
    - "Each config(...) returns its declaration's layer, so it also provides Tenant.DeploymentConfigApplied"
    - "MagicLink and EmailOtp gain descriptors; ApiKey and DeviceAuthorization descriptors are made from the declarations"
    - "Ticket 02's deployment pins (a calling-fiber MagicLink/EmailOtp config is ignored) pass unchanged"
  artifacts:
    - path: "packages/magic-link/src/MagicLink.ts"
      provides: "MagicLinkConfigScoped and its descriptor"
      contains: "Tenant.perDeployment(MagicLinkConfig)"
    - path: "packages/magic-link/src/EmailOtp.ts"
      provides: "EmailOtpConfigScoped and its descriptor"
      contains: "Tenant.perDeployment(EmailOtpConfig)"
  key_links:
    - from: "MagicLink.config"
      to: "Tenant.DeploymentConfigApplied"
      via: "PerDeployment.layer"
      pattern: "MagicLinkConfigScoped\\.layer\\("
---
Status: done (uncommitted)
Blocked by: 04, 02

<objective>
Declare the four deployment-scoped plugin keys of the passwordless and machine-credential packages (PLAN.md §2.3 rows 10-15), route their build reads through the accessor, and give MagicLink and EmailOtp the descriptors they lack.
Purpose: G1 (the declaration is the list) and G3 (a deployment `config(...)` in a tenant lookup is refused) for four plugins.
Output: four edited modules and one test.
</objective>

<context>
@.planning/36-config-scope/PLAN.md (§2.3 rows 10-15, §3.2, §3.5)
@packages/magic-link/src/MagicLink.ts (lines 70-90, 190-200, and the plugin class's `config:` list if any)
@packages/magic-link/src/EmailOtp.ts (lines 80-95, 185-195)
@packages/api-key/src/ApiKey.ts (lines 128-140, 595-602, 760-795)
@packages/device-authorization/src/DeviceAuthorization.ts (lines 130-142, 510-517, 710-750)
@packages/core/src/ConfigDescriptor.ts (after ticket 04)
@packages/magic-link/test/MagicLink.test.ts (ticket 02's pin)
</context>

<tasks>
<task type="auto">
  <name>Task 1: declarations and constructors</name>
  <files>packages/magic-link/src/MagicLink.ts, packages/magic-link/src/EmailOtp.ts, packages/api-key/src/ApiKey.ts, packages/device-authorization/src/DeviceAuthorization.ts</files>
  <read_first>each module's reference and `config` (MagicLink.ts:77-82, EmailOtp.ts:83-88, ApiKey.ts:132-137, DeviceAuthorization.ts:134-140)</read_first>
  <action>Next to each reference add an exported `<Key>Scoped = Tenant.perDeployment(<Key>)` (import `Tenant` from `@awthaq/core` as the package already imports core modules). Make each `config(...)` return `<Key>Scoped.layer({ ...defaults, ...partial })`, keeping its merge exactly. Add no return-type annotation.</action>
  <verify><automated>pnpm build</automated></verify>
  <acceptance_criteria>
    - `grep -rnE 'Tenant\.perDeployment\((MagicLinkConfig|EmailOtpConfig|ApiKeyConfig|DeviceAuthorizationConfig)\)' packages/magic-link/src packages/api-key/src packages/device-authorization/src | wc -l` prints 4 (baseline 0)
    - `grep -rnE 'Layer\.succeed\((MagicLinkConfig|EmailOtpConfig|ApiKeyConfig|DeviceAuthorizationConfig)\b' packages/magic-link/src packages/api-key/src packages/device-authorization/src | wc -l` prints 0 (baseline 4)
  </acceptance_criteria>
  <done>Four declarations; every constructor goes through one.</done>
</task>

<task type="auto">
  <name>Task 2: reads and descriptors</name>
  <files>packages/magic-link/src/MagicLink.ts, packages/magic-link/src/EmailOtp.ts, packages/api-key/src/ApiKey.ts, packages/device-authorization/src/DeviceAuthorization.ts</files>
  <read_first>the read sites MagicLink.ts:198, EmailOtp.ts:192, ApiKey.ts:600, :792, DeviceAuthorization.ts:515, :745; the descriptors ApiKey.ts:766, DeviceAuthorization.ts:716</read_first>
  <action>Each read site is a build read. Replace `const settings = yield* <Key>` with `const settings = yield* yield* Tenant.inForce(<Key>Scoped)` (the accessor returns the per-operation effect; yielding it once in the build gives the build value for a deployment key). Make the two existing descriptors from the declarations (same options). Add a descriptor for MagicLink and for EmailOtp in each plugin's `config:` list (mirror the api-key plugin's placement); mark as `sensitive` any field whose value is a secret or a `Redacted` (read the shape; if none, pass no `sensitive`). If a plugin class has no `config:` list yet, add one.</action>
  <verify><automated>npx vitest run packages/magic-link/test/MagicLink.test.ts packages/magic-link/test/EmailOtp.test.ts packages/api-key/test/ApiKey.test.ts packages/api-key/test/Plugin.test.ts packages/device-authorization/test/DeviceAuthorization.test.ts packages/device-authorization/test/Plugin.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -rnE 'yield\* *(MagicLinkConfig|EmailOtpConfig)\b' packages/magic-link/src | wc -l` prints 0 (baseline 2)
    - `grep -rnE 'yield\* *ApiKeyConfig\b' packages/api-key/src | wc -l` prints 0 (baseline 2)
    - `grep -rnE 'yield\* *DeviceAuthorizationConfig\b' packages/device-authorization/src | wc -l` prints 0 (baseline 2)
    - `grep -rn 'ConfigDescriptor.make(' packages/magic-link/src | wc -l` prints 2 (baseline 0)
  </acceptance_criteria>
  <done>Every read goes through the accessor; four descriptors exist.</done>
</task>

<task type="auto">
  <name>Task 3: the constructor carries the marker</name>
  <files>packages/magic-link/test/MagicLink.test.ts</files>
  <read_first>packages/magic-link/test/MagicLink.test.ts (ticket 02's case); packages/ports/src/Tenant.ts (DeploymentConfigApplied, after ticket 03)</read_first>
  <action>Add one case beside ticket 02's pin: build `MagicLink.config({})` and assert that `Tenant.DeploymentConfigApplied` is provided with `key` equal to `MagicLinkConfig.key`. Bind the layer to a const typed `Layer.Layer<Tenant.DeploymentConfigApplied>`: that line compiles only while the constructor carries the marker (a `Layer.Layer<never>` is not assignable to it), so a later annotation that hides the marker breaks `pnpm typecheck`. The cross-package refusal (a real deployment `config(...)` in a `TenantConfig` lookup) is ticket 16's, because `@awthaq/saml` already depends on `@awthaq/organization` and magic-link does not.</action>
  <verify><automated>npx vitest run packages/magic-link/test/MagicLink.test.ts</automated></verify>
  <acceptance_criteria>
    - The new case passes, and ticket 02's deployment pin passes unchanged
    - `pnpm typecheck` passes
  </acceptance_criteria>
  <done>The marker is pinned on a real plugin constructor.</done>
</task>
</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| application `TenantConfig` lookup → deployment-scoped plugin settings | a tenant lookup could previously carry a magic-link, OTP, api-key or device setting that no operation ever applied |

## STRIDE threat register

| Threat ID | Category | Component | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-36-02 | Tampering | an operator believes a tenant's stricter magic-link TTL or api-key policy is in force when it is not | medium | mitigate | the marker makes such a lookup a type error; ticket 02's runtime pins prove the setting was never applied per tenant; Task 3 pins the marker |
| T-36-04 | Information disclosure | a new MagicLink/EmailOtp descriptor rendering a secret | medium | mitigate | Task 2 marks secret fields `sensitive`; `GET /admin/config` redacts them (ticket 04's case) |
</threat_model>

<verification>
pnpm build
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
Raw reads 6 → 0 across the three packages; 4 declarations; descriptors 2 → 4; ticket 02's pins green.
</success_criteria>

## Comments

Result: four perDeployment declarations, config() via .layer, reads via yield* yield* Tenant.inForce, descriptors for all four (MagicLink/EmailOtp `config:` placed in AuthPlugin.Service options, not layer options; no sensitive fields). Marker case added in MagicLink.test.ts (imports Tenant from @awthaq/ports: core re-exports DeploymentConfigApplied as a value only). Raw reads 6 -> 0. Tests green, tsc clean. The saml-style type-test case was left to ticket 16 per the ticket.
