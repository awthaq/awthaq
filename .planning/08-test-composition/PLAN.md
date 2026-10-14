# Plan 08: Per-plugin record bundles and a deeper `TestAuth.layer`

Source: the architecture review of 2026-10-13. Strength: **worth exploring**. Dependency category:
**local-substitutable** (in-memory and SQLite/Postgres implementations of the same record interfaces).
Wave D, after plans 02 and 05 (see [`.planning/README.md`](../README.md#execution-order)).

Every count and `file:line` below was re-measured on 2026-10-13 against `main` at `38bcd1b`. The commands are
given so an executor can re-run them. Where the review's numbers were wrong, the
[Evidence corrections](#evidence-corrections) section says so.

Conventions: everything in [`.planning/README.md` § Shared conventions](../README.md#shared-conventions-apply-to-every-plan)
applies. That means no `as` (and no `as const`), no return type annotations on new Effect/Layer consts,
type-system first, replace-don't-layer tests, spec + traceability + BDD updates, a changeset with a
`Migration:` note for every package-visible change, the per-phase gate
`pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`, `pnpm check` per plan, and
`pnpm test:pg` whenever a SQL adapter changes. This plan changes SQL record layers (keys) and adds a SQL mode to
the harness, so `pnpm test:pg` is part of every phase gate from Phase 2 on. Track execution as
`.scratch/08-test-composition/issues/NN-*.md` tickets. The ticket numbers are given per step below.

Vocabulary: **module, interface, implementation, depth, seam, adapter, leverage, locality**.

---

## 1. Summary, goals, non-goals

### Summary

`TestAuth.layer` is meant to be "the whole pipeline over memory" (BEH-EA-193). Its interface is shallow at the
places where wiring is hardest:

- **The caller builds the host middleware.** Every composed api carries core's `session`/`account` groups, and
  those declare `Api.Authentication` and `Api.CsrfProtection`. So every caller has to build
  `AuthenticationLive` over `PrincipalResolverLive`, plus `CsrfProtectionLive` over a hand-written `CsrfConfig`,
  and pass them as `services`. The doc comment at `packages/test/src/TestAuth.ts:205-231` explains this. The
  overload is at `:244-268` and the implementation at `:269-296`.
- **The caller assembles the plugin's own record stores.** The harness cannot see a plugin's stores, so `services`
  has to carry them, layer by layer.
- **The `services` output is advertised but not delivered.** The overload's `ROut` includes `MR`
  (`TestAuth.ts:260`), but the implementation folds `services` in with `Layer.provide` (`:286`). So a test that
  `yield*`s a service only `services` provides type-checks and then dies at runtime. A port that both `services`
  and the bundle provide (a capturing `Mailer`, say) has two instances: the plugin uses the one from `services`
  and the test reads the bundle's.

Because the harness costs more to use than to bypass, most suites bypass it. **105** test and feature files
build `PrincipalResolverLive` by hand, **79** build `CsrfProtectionLive`, and only **19** use `TestAuth.layer`.
That is 14 outside `packages/test`, plus `examples/memory-server`. Each plugin's suites rebuild the same
graph: core stores, memory foundation, plugin records, Encryption over a fixed key, `SqlTransaction.layerNoop`,
`ClientAddress.layerDirect`, `RateLimits.layer`, `HttpServer` services, and a CSRF double-submit token computed
with `node:crypto`. Measured repetition is in the [inventory](#2-verified-inventory).

The fix has four parts:

1. **Records bundles (a new seam on the plugin interface).** Every plugin that owns tables declares
   `records: { memory, sql }` on `AuthPlugin.Service`. These are two matched layers that provide its record
   stores. The compiler enforces three rules. A plugin whose layer requires a `/records/` store that no bundle (its
   own or a `dependsOn` plugin's) provides does not compile. A `memory` and a `sql` that provide different stores
   do not compile. A bundle that provides anything except record stores does not compile. Plugin-owned hook
   points are declared the same way (`hookPoints`).
2. **A deeper `TestAuth.layer(built, options)`.** It derives the host middleware (`Authentication`,
   `OptionalAuthentication`, `MachineAuthentication`, `AdminAuthentication`, `CsrfProtection`) from the groups
   the composed api declares, through a new `AuthHttp.middlewareFor` in `@awthaq/server`. It selects every
   composed plugin's records bundle, provides declared hook points, and runs either over memory
   (`records: "memory"`, the default) or over a real migrated database (`records: "sql"`: SQLite `:memory:`, or a
   per-suite Postgres schema under `AWTHAQ_POSTGRES_URL`). `TestAuth.app(layer)` returns the handler, a context
   runner and a CSRF-aware `request`. It replaces the 40 hand-rolled memo-map handles.
3. **Contract tests are cheap and required.** `runPluginContractTests` defaults `host` to the plugin's
   transitive `dependsOn` and gains a records-parity check. Every plugin package gets a `test/Contract.test.ts`.
   A new `scripts/check-contract-tests.mjs` (in `pnpm check`) fails when a plugin class has no contract-test
   call. Today 13 of 20 plugin classes have none in their own package.
4. **Migrate.** Plugins get bundles one at a time. Then the suites and BDD worlds move onto `TestAuth.layer`,
   biggest first. The plugin template and `docs/plugin-authoring.md` teach the new shape.

### Goals

- G1. A plugin's record stores are reachable as one declared, compile-checked pair (`Plugin.records.memory`,
  `Plugin.records.sql`). A missing or mismatched bundle is a compile error.
- G2. A test needs no `PrincipalResolverLive`, `AuthenticationLive`, `CsrfProtectionLive`, `CsrfConfig`, core
  store or plugin record layer to stand up a composition. It writes
  `TestAuth.layer(Auth.make([...]), { services })`, where `services` holds only what is genuinely the test's own
  (plugin config, adapters such as `XmlSignature`/`WebAuthn`/`HttpClient`, test doubles).
- G3. The same suite can run over SQL with one option, and `pnpm test:pg` runs it on Postgres.
- G4. `TestAuth.layer`'s type tells the truth. Its `RIn` is `never` exactly when the composition is complete, and
  every service in `ROut` is present at runtime.
- G5. Every shipped plugin runs `runPluginContractTests` from `test/Contract.test.ts`, and `pnpm check` enforces it.
- G6. Measured shrinkage (see [§5](#5-test-plan)): hand-built `PrincipalResolverLive` goes from 105 files to 12 or
  fewer, and layer-wiring calls in package tests from 2,373 to 1,300 or fewer.
- G7. `@awthaq/test` stays dev-only. No package `src/` imports it, and no package lists it in `dependencies`. The
  check script enforces both.

### Non-goals

- Changing what production composes. `Auth.make` does not start providing records, hook points or middleware.
  Records bundles are production code (memory deployments use `records.memory`), but selecting them stays the
  host's choice. The one production-visible changes are the record-key rename, `Roles`/`UserClaims` moving to
  record stores, and absorbing plugin-owned derived services into their plugin layers
  ([Phase 2](#phase-2--records-bundles-plugin-by-plugin)).
- Rewriting the record stores themselves. Plan 05 owns the substrate (tenant scoping, RLS, re-seal, typed
  errors), and plan 02 owns the core stores.
- Changing `TestAuth.layer`'s first parameter to a raw plugin tuple. See [Q4](#10-open-questions-only-the-user-can-answer).
- Moving the middleware's own suites (`packages/server/test/Authentication.test.ts`, `Csrf.test.ts`,
  `CredentialResolvers.test.ts`, `features/.../CsrfWorld.ts`) onto the harness. When the wiring is what a test is
  testing, it stays hand-built ([exemptions](#phase-3--migrate-suites-and-bdd-worlds)).

---

## 2. Verified inventory

### 2.1 Re-measurement commands

```bash
# files that build a piece of host wiring by hand (test, feature and example files; src excluded)
for p in PrincipalResolverLive CsrfProtectionLive 'TestAuth.layer(' TestAuth.memoryFoundation runPluginContractTests; do
  echo "$p: $(grep -rlF --include='*.ts' --include='*.tsx' "$p" packages/*/test features/step-definitions examples/*/test examples/*/app.ts | wc -l)"
done
# layer-wiring calls (proxy for hand-assembled graphs)
grep -rhoE 'Layer\.(provide|provideMerge|mergeAll|merge)\(' packages/*/test | wc -l      # 2,373
grep -rhoE 'Layer\.(provide|provideMerge|mergeAll|merge)\(' features/step-definitions | wc -l   # 795
# exact requirements of each plugin layer: see §2.4 (type probe)
```

### 2.2 Repo-wide repetition (2026-10-13)

| Idiom built by hand | Files (tests + features + examples) | What replaces it |
|---|---:|---|
| `Authentication.PrincipalResolverLive` | 105 (74 pkg tests, 31 features) + 3 examples | `TestAuth.layer` derives it |
| `Csrf.CsrfProtectionLive` | 79 (52 pkg tests, 27 features) + 3 examples | derived |
| `Layer.succeed(Csrf.CsrfConfig, { … })` literal | 60 | `TestAuth` default CSRF config (`options.csrf` to tune) |
| CSRF token minted with `createHmac("sha256", …)` | 22 | `TestAuth.app(...).request` / `TestAuth.csrfToken` |
| `Layer.makeMemoMapUnsafe` handle (`handler` + `withContext`) | 40 | `TestAuth.app` |
| `HttpRouter.toWebHandler` | 58 | `TestAuth.app` |
| `SqlTransaction.layerNoop` | 63 | in the base (memory mode) |
| `RateLimits.layer` | 44 | in the base |
| `ClientAddress.layerDirect` | 40 | in the base |
| `Mailer.layerMemory` | 35 | in the base |
| `KeyProvider.layerEnv` (fixed test `AWTHAQ_ENCRYPTION_KEY`) | 34 (32 `AWTHAQ_ENCRYPTION_KEY`) | `TestAuth` test `Encryption` in the base |
| `Etag.layerWeak` (no-op HTTP platform services) | 31 | already in `TestAuth` (`HttpServer.layerServices`) |
| `support/TestSql.ts` imported across packages by relative path | 31 files in 15 packages | `TestSql` exported from `@awthaq/test` |
| `NoBreachHttpClient` / `"F".repeat(35)` stub | 23 / 5 | `TestAuth.httpClient.noBreach` (named helper, **not** in the base) |
| `OrganizationHooks.OrganizationHooksLive` | 17 | `Organization` declares `hookPoints` |
| `OrganizationMemory.layer` | 13 | `Organization.records.memory` |
| `AUTH_ARGON2_MEMORY_KIB` cheap hasher | 8 | already in `TestAuth` base |
| `TwoFactorStore.layerSecretsMemory` | 7 | `TwoFactor.records.memory` |

`TestAuth.layer(` call sites: 36 calls in 19 files, plus the definition. They are
`packages/magic-link/test/AuthHttp.test.ts:39`, `packages/two-factor/test/AuthHttp.test.ts:50`,
`packages/test/test/{TestAuth.test.ts:86,159, TestAuthDocs.test.ts:53, UserFields.test.ts:55, runPluginContractTests.test.ts:310}`,
`features/step-definitions/{ContractStratumWorld.ts:160,169, HttpErrorWorld.ts:201,206,209,214,217,221,225, ReactWorld.ts:54, CompositionSteps.ts:198,207,425,447, NextSsrWorld.ts:89, RateLimitingWorld.ts:111, TestingHarnessWorld.ts:63,95,146,166, TestingHarnessSteps.ts:249, CrossCuttingApp.ts:114, HooksWorld.ts:163, RateLimitingSteps.ts:995,1015, CsrfWorld.ts:171,173,174}`
and `examples/memory-server/app.ts:132`. One file shows what adoption is worth: `HttpErrorWorld.ts` (7 calls)
has **8** layer-wiring calls, while worlds of similar size that hand-wire have 30 to 62.

### 2.3 Per-plugin inventory

Legend: **PRL / CSRF / recM / recS** = number of that package's test files that build `PrincipalResolverLive`,
`CsrfProtectionLive`, a memory record layer, or a SQL record layer by hand. **TAL** = files using
`TestAuth.layer`. **Contract** = whether the package's own tests call `runPluginContractTests` (file:line).

| Package | Plugin classes | Record stores (current key) | Memory layers | SQL layers | Existing bundle | Own non-record services the layer requires | Test files / lines | Support files (lines) | PRL | CSRF | recM | recS | TAL | Contract | BDD world / steps (lines) |
|---|---|---|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---|---|
| admin | `Admin`, `AdminAccounts`, `AdminTenants` | `ImpersonationRecords` (`awthaq/admin/ImpersonationRecords`); `AdminTenants` reads `OrganizationRecords` | `ImpersonationRecords.layerMemory` (`:324`) | `.layerSql` (`:521`) | none | none | 12 / 3,996 | none | 9 | 9 | 8 | 1 | 0 | `Admin` only (`AuthHttp.test.ts:771`); **not** `AdminAccounts`, `AdminTenants` | `AdminWorld` 346 / `AdminSteps` 1,174 |
| api-key | `ApiKey` | `ApiKeyRecords`, `ApiKeyClientRecords` | `:66`, `:64` | `:119`, `:114` | none | `CredentialResolvers` (server registry); `dependsOn: [Jwt]` | 6 / 1,264 | `harness.ts` (210) | 1 | 1 | 1 | 1 | 0 | **no** | shared `AuthenticationWorld` 611 |
| device-authorization | `DeviceAuthorization` | `DeviceGrantRecords`, `DeviceClientRecords` | `:104`, `:54` | `:221`, `:92` | `recordsLayer({store})` inside `test/support/harness.ts:109` | 2 hook points (`DeviceAuthorizationHooksLive`, `DeviceAuthorization.ts:162`) | 5 / 1,728 | `support/harness.ts` (239) | 1 | 1 | 2 | 1 | 0 | yes (`Plugin.test.ts:149`) | `DeviceAuthorizationWorld` 331 / `…Steps` 1,140 |
| jwt | `Jwt` | `SigningKeyRecords`, `RevocationStore` | `:134`, `:54` | `:228`, `:83` | none | `KeyRing` (`LayerRef` over `SigningKeyRecords`), `JwtConfig` | 14 / 3,259 | none | 8 | 1 | 11 | 2 | 0 | yes (`AuthHttp.test.ts:599`) | `JwtWorld` 392 / `JwtSteps` 726 |
| magic-link | `MagicLink`, `EmailOtp` | none (core `Verification`) | - | - | - | none | 6 / 853 | `support/harness.ts` (117) | 2 | 2 | 1 | 0 | 1 | yes (`Contract.test.ts:16-17`) | `MagicLinkWorld` 368 + `MagicLinkSupport` 210 / `MagicLinkSteps` 479 + `EmailOtpSteps` 453 |
| oauth | `OAuth` | none (`tables: []`) | - | - | - | `OAuthConfig` | 12 / 6,333 | none | 6 | 0 | 0 | 0 | 0 | **no** | `OAuthWorld` 297 / `OAuthSteps` 1,310 |
| organization | `Organization` | `Organization`/`Membership`/`ActiveContext`/`Invitation`/`OrgRole`/`Team` `Records` (required) + `ConnectionRecords` (owned tables `organization_oauth_connection*`, **not** required by `Organization.layer`) | 7 × `layerMemory` | 7 × `layerSql` | `OrganizationMemory.layer` (`OrganizationMemory.ts:19`, 6 stores, no `ConnectionRecords`); **no SQL bundle** (`OrganizationSql.test.ts:71-76` lists six by hand) | 46 hook points (`OrganizationHooksLive`, `OrganizationHooks.ts:304`) | 24 / 7,310 | none | 8 | 7 | 18 | 9 | 0 | yes (`AuthHttp.test.ts:852`) | `OrganizationWorld` 374 / `…Steps` 951; `TenancyWorld` 549 / `TenancySteps` 1,336 |
| passkey | `Passkey` | `PasskeyCredentials`, `PasskeyUserHandles`, `ChallengeStore` | `:117`, `:53`, `:118` | `:303`, `:80`, `:174` | none | `WebAuthn` port | 19 / 4,687 | `passkeyTestFixtures.ts` (196, mostly WebAuthn fixtures) | 5 | 5 | 9 | 3 | 0 | **no** | `PasskeyWorld` 505 / `PasskeySteps` 1,392 + `PasskeyRegistrationSteps` 488 |
| password | `Password` | none | - | - | - | `HttpClient` (breach check) | 16 / 4,706 | `harness.ts` (118) | 7 | 7 | 0 | 0 | 0 | **no** in-package (only `packages/test/test/runPluginContractTests.test.ts:70` and BDD) | `PasswordWorld` 658 / `PasswordSteps` 1,007 |
| qadi | `UserClaims` | **none**: storage chosen at plugin level (`UserClaims.layer` = `memoryMake`, `.layerSql` = `sqlMake`, `UserClaims.ts:263-272`) | - | - | - | none | 12 / 2,354 | none | 6 | 1 | 1 | 1 | 0 | **no** | `QadiBridgeWorld` 996 / Path A 647, Path B 944, Resolvers 823, Client 539 |
| roles | `Roles`, `RolesAdmin` | **none**: `Roles.layer`/`Roles.layerSql` (`Roles.ts:494,508`) pick `rolesMake`/`rolesMakeSql` | - | - | - | `RolesAdmin`: `qadi/http/RequirePermission` | 4 / 810 | none | 1 | 1 | 0 | 1 | 0 | **no** | `RolesSubjectResolverSteps` 745 |
| saml | `Saml`, `Sso` | `SamlRecords` (+ `OrganizationRecords` via `dependsOn`); `Sso` needs `OrganizationConnectionStore` (over `ConnectionRecords`) | `:255` | `:491` | none | `SamlConnectionStore`, `SamlSpKeys`, `SamlMetadataFetcher` (adapter), `SamlConfig`; port `XmlSignature` | 17 / 6,667 | `support.ts` (258), `samlFixtures.ts` (237) | 1 | 1 | 3 | 1 | 0 | **no** | `SamlWorld` 706 + `SamlFixtures` 231 / `SamlSteps` 1,129 + `SamlFederationSteps` 1,406 |
| scim | `Scim` | `ScimRecords` (+ org `Membership`/`ActiveContext`/`Team` via `dependsOn`) | `:161` | `:427` | none | `ScimAuthentication` middleware (`ScimConnections.ScimAuthenticationLive`, `:113`), `ScimConfig`; tests also need `ScimConnectionStore` (`:81`) | 7 / 1,652 | `support.ts` (97) | 1 | 1 | 2 | 1 | 0 | **no** | `ScimWorld` 345 / `ScimSteps` 1,162 |
| two-factor | `TwoFactor` | `TwoFactorSecrets`, `TwoFactorRecoveryCodes` | `layerSecretsMemory` `:109`, `layerRecoveryCodesMemory` `:196` | `layerSecretsSql` `:280`, `layerRecoveryCodesSql` `:408` | none | `SecondFactor`; `GateInstalled`, `ResetGuard` (deliberate gates: BEH-EA-261, keep explicit) | 9 / 1,639 | `support/harness.ts` (146) | 2 | 2 | 2 | 1 | 1 | yes (`Contract.test.ts:8`) | `TwoFactorWorld` 566 / `TwoFactorSteps` 760 + `…SecuritySteps` 606 + `…ResetSteps` 170 |
| webhooks | `Webhooks` | `WebhookRecords` | `:219` | `:554` | none | none (the delivery worker needs `WebhookTransport`; ports `Encryption`, `HostResolver`) | 12 / 3,102 | `support.ts` (245) | 3 | 3 | 3 | 1 | 0 | **no** | `WebhooksWorld` 575 / `WebhooksSteps` 1,426 + `WebhooksOperationsSteps` 581 |
| plugin-template | `Notes` | `NoteRecords` (`example/notes/NoteRecords`) | **none** (`layerSql` only) | `Template.layerSql` | - | 2 hook points (`NotesHooksLive`, `Template.ts:54`) | 1 / 196 | - | 1 | 1 | 0 | 1 | 0 | yes (`Template.test.ts:186`) | - |

### 2.4 What each plugin layer actually requires (compiler output)

These requirements were read with a throwaway type probe (`K<Layer.Services<typeof X.layer>>`, printed by the
compiler), not by grepping. Grouped:

- **Host middleware.** `Authentication`: api-key, device, jwt, organization, passkey, password, saml,
  two-factor. `Admin.layer` requires only `AdminAuthentication`, even though `AdminApi.ts` mentions
  `Api.Authentication`. `OptionalAuthentication`: device, oauth. `AdminAuthentication`: admin,
  admin-accounts, admin-tenants, saml, webhooks. `CsrfProtection`: all except jwt, oauth, scim, sso, roles,
  claims. **No shipped group declares `MachineAuthentication`**. It exists for app-owned `extraGroups`.
  Plugin-owned middleware: `ScimAuthentication`.
- **Record stores**, as in the table. `Organization.layer` does **not** require `ConnectionRecords`. `Sso.layer`
  requires `OrganizationConnectionStore`, which is built over `ConnectionRecords`.
- **Keyless requirements.** `Crypto`: most plugins. `HttpClient`: password and oauth.
- **Ports.** `Mailer`, `PasswordHasher`, `SqlTransaction`, `RateLimiter`, `ClientAddress`, `Encryption`,
  `HostResolver`, `XmlSignature`, `WebAuthn`.
- **Registries.** `RateLimitsRegistry`, `ErasureRegistry`, `DataExportRegistry`, `SlotsRegistry` (roles),
  `CredentialResolvers` (api-key).

### 2.5 Evidence corrections

- "Webhooks, saml, scim, roles never call `runPluginContractTests`" understates the gap. Of the 20 shipped
  plugin classes, **13** have no call in their own package: `AdminAccounts`, `AdminTenants`, `ApiKey`, `OAuth`,
  `Passkey`, `Password` (covered only from `@awthaq/test`'s own suite), `UserClaims`, `Roles`, `RolesAdmin`,
  `Saml`, `Sso`, `Scim`, `Webhooks`. Covered: `Admin`, `MagicLink`, `EmailOtp`, `DeviceAuthorization`, `Jwt`,
  `Organization`, `TwoFactor`, plus the template's `Notes`.
- `ScimWorld.ts:73-117` lists **six** organization record layers (plus `ScimRecords`) one by one, not seven. It
  repeats `Layer.provide(NodeCrypto.layer)` on five of them even though `OrganizationMemory.layer` exists.
- "105 files wire `PrincipalResolverLive`" is exact for test plus feature files (74 + 31). There are 110
  occurrences if `src` and examples are counted. "~80 wire CSRF" is 79.
- `TestAuth.ts` lines are as stated: `services` doc at `:205-231`, overload and implementation at `:244-296`.
- **New: a type/runtime mismatch in the harness.** `ROut` advertises `| MR`, but `services` is
  `Layer.provide`d, so those services are absent from the built context. See §1.
- **New: the plugin template teaches the hand-wired pattern.** `examples/plugin-template/test/Template.test.ts`
  does not use `TestAuth.layer`. It makes 22 layer-wiring calls and mints its own CSRF token (`:51-55`).
- **New: `examples/memory-server` lists `@awthaq/test` in `dependencies`.** The test harness is its runtime.
- **New: `TestSql` lives in `packages/sql/test/support/TestSql.ts`.** 31 files in 15 packages import it by a
  cross-package relative path (`../../../sql/test/support/TestSql.ts`).
- **New: record-store keys follow no convention.** Ports are recognised by a `/ports/` key segment (PV-241,
  `AuthPlugin.ts:376-381`). A record store's key (`awthaq/scim/ScimRecords`) cannot be told apart from a
  derived service (`awthaq/scim/ScimConnectionStore`) or a config (`awthaq/saml/Config`), so the type system
  cannot ask "are all its record stores bundled?" until keys say so.

---

## 3. Target design

### 3.1 The record-store key convention

A record store is a `Context.Service` whose key contains a `/records/` segment, the same mechanism PV-241 uses for
ports (`${string}/ports/${string}`). Rename every record store's key:

| Current key | New key |
|---|---|
| `awthaq/admin/ImpersonationRecords` | `awthaq/admin/records/ImpersonationRecords` |
| `awthaq/api-key/ApiKeyRecords`, `…/ApiKeyClientRecords` | `awthaq/api-key/records/ApiKeyRecords`, `…/records/ApiKeyClientRecords` |
| `awthaq/device-authorization/DeviceGrantRecords`, `…/DeviceClientRecords` | `…/records/DeviceGrantRecords`, `…/records/DeviceClientRecords` |
| `awthaq/jwt/SigningKeyRecords`, `awthaq/jwt/RevocationStore` | `awthaq/jwt/records/SigningKeyRecords`, `awthaq/jwt/records/RevocationStore` |
| `awthaq/organization/{Organization,Membership,ActiveContext,Invitation,OrgRole,Team,Connection}Records` | `awthaq/organization/records/…` |
| `awthaq/passkey/{PasskeyCredentials,PasskeyUserHandles,ChallengeStore}` | `awthaq/passkey/records/…` |
| `awthaq/saml/SamlRecords` | `awthaq/saml/records/SamlRecords` |
| `awthaq/scim/ScimRecords` | `awthaq/scim/records/ScimRecords` |
| `awthaq/two-factor/{TwoFactorSecrets,TwoFactorRecoveryCodes}` | `awthaq/two-factor/records/…` |
| `awthaq/webhooks/WebhookRecords` | `awthaq/webhooks/records/WebhookRecords` |
| (new) roles assignments | `awthaq/roles/records/RoleAssignments` |
| (new) user claims | `awthaq/qadi/records/UserClaims` |
| `example/notes/NoteRecords` | `example/notes/records/NoteRecords` |

Derived services (`KeyRing`, `SamlConnectionStore`, `ScimConnectionStore`, `OrganizationConnectionStore`,
`SecondFactor`, `SamlSpKeys`) keep their keys. They are not record stores. If plan 05 has introduced a substrate
helper that mints record-store classes, the `/records/` segment is set **there**, once.

### 3.2 `records` and `hookPoints` on `AuthPlugin.Service` (`packages/core/src/AuthPlugin.ts`)

Both are declared where `contract`/`tables`/`userFields` are, so they are static facts about the class,
readable without building a layer. Their exact types flow into `Class`, the same way `Fields` does today.

```ts
// packages/core/src/AuthPlugin.ts (sketch)
import type * as Hooks from "./Hooks.ts"; // type-only; Hooks.ts does not import AuthPlugin (no cycle)

/** 08: a record store is a Context.Service whose key names a `/records/` service (cf. PortKeysOf). */
export type RecordKeysOf<R> = R extends { readonly key: infer K extends string }
  ? K extends `${string}/records/${string}`
    ? K
    : never
  : never;

/** 08: a hook point's key (`HookPoint.veto/observe/divert` mint `awthaq/hook/<id>`). */
export type HookKeysOf<R> = R extends { readonly key: infer K extends string }
  ? K extends `awthaq/hook/${string}`
    ? K
    : never
  : never;

/** 08: the widest records declaration; `never` in ROut is what a contravariant slot accepts from any bundle. */
export interface AnyRecords {
  readonly memory: Layer.Layer<never, never, unknown>;
  readonly sql: Layer.Layer<never, never, unknown>;
}

/** 08: a plugin that owns no tables declares nothing; `Service` fills this in. */
export interface NoRecords {
  readonly memory: Layer.Layer<never>;
  readonly sql: Layer.Layer<never>;
}

/** 08: memory and sql provide exactly the same stores, and nothing but stores. Unknown when legal. */
export type RecordsLegal<R extends AnyRecords> = [Layer.Success<R["memory"]>] extends [Layer.Success<R["sql"]>]
  ? [Layer.Success<R["sql"]>] extends [Layer.Success<R["memory"]>]
    ? [Exclude<Layer.Success<R["memory"]>, RecordServices<Layer.Success<R["memory"]>>>] extends [never]
      ? unknown
      : { readonly "~records": { readonly "a records bundle provides only /records/ stores, not": Exclude<Layer.Success<R["memory"]>, RecordServices<Layer.Success<R["memory"]>>> } }
    : { readonly "~records": { readonly "sql provides stores memory does not": Exclude<RecordKeysOf<Layer.Success<R["sql"]>>, RecordKeysOf<Layer.Success<R["memory"]>>> } }
  : { readonly "~records": { readonly "memory provides stores sql does not": Exclude<RecordKeysOf<Layer.Success<R["memory"]>>, RecordKeysOf<Layer.Success<R["sql"]>>> } };

type RecordServices<S> = S extends { readonly key: `${string}/records/${string}` } ? S : never;

/** 08: what a set of plugins' bundles provide (distributes over a union of classes). */
export type RecordsOut<P> = P extends { readonly records: { readonly memory: infer M extends Layer.Any } }
  ? Layer.Success<M>
  : never;
export type RecordsIn<P, Mode extends "memory" | "sql"> = P extends { readonly records: infer B }
  ? B extends { readonly memory: infer M extends Layer.Any; readonly sql: infer S extends Layer.Any }
    ? Layer.Services<Mode extends "memory" ? M : S>
    : never
  : never;
export type HookPointsOut<P> = P extends { readonly hookPoints: infer H extends Layer.Any } ? Layer.Success<H> : never;

/** 08: completeness, checked at `AuthPlugin.layer` like PortsComplete (BEH-EA-T4). */
export type MissingRecords<R, Provided> = Exclude<RecordKeysOf<R>, RecordKeysOf<Provided>>;
export type RecordsComplete<R, Provided> = [MissingRecords<R, Provided>] extends [never]
  ? unknown
  : { readonly "~missingRecords": { readonly "declare these record stores in AuthPlugin.Service's records": MissingRecords<R, Provided> } };

type CorePoints = Layer.Success<typeof Hooks.HooksLive>;
export type MissingHookPoints<R, Provided> = Exclude<HookKeysOf<R>, HookKeysOf<Provided | CorePoints>>;
export type HookPointsComplete<R, Provided> = [MissingHookPoints<R, Provided>] extends [never]
  ? unknown
  : { readonly "~missingHookPoints": { readonly "declare these hook points in AuthPlugin.Service's hookPoints": MissingHookPoints<R, Provided> } };
```

`Service` gains two inferred type parameters and two options. `Class` gains `Records` and `Points`:

```ts
export interface Class<Self, Id extends string, Shape, Groups extends HttpApiGroup.Constraint,
  Fields extends UserFields.Declarations = {}, Records extends AnyRecords = NoRecords,
  Points extends Layer.Layer<never, never, unknown> = Layer.Layer<never>>
  extends Context.ServiceClass<Self, Key<Id>, Shape> {
  // ...existing members...
  /** 08 (BEH-EA-T4): the plugin's record stores, one memory and one SQL implementation, matched. */
  readonly records: Records;
  /** 08 (BEH-EA-T5): the plugin's own hook points' default (no-tap) layers, provided once per composition by the host. */
  readonly hookPoints: Points;
}

export const Service =
  <Self, Shape>() =>
  <const Id extends string, Groups extends GroupsFor<Id>, const Fields extends UserFields.Declarations = {},
   const Records extends AnyRecords = NoRecords, Points extends Layer.Layer<never, never, unknown> = Layer.Layer<never>>(
    id: Id,
    options: {
      // ...existing options...
      readonly records?: Records & RecordsLegal<Records>;
      readonly hookPoints?: Points;
    },
  ): Class<Self, Id, Shape, Groups, Fields, Records, Points> => {
    // ...existing body; add to the Object.assign source:
    //   records: options.records ?? noRecords,          // const noRecords = { memory: Layer.empty, sql: Layer.empty }
    //   hookPoints: options.hookPoints ?? Layer.empty,
  };
```

> Typing note for the executor (Phase 0 spike, ticket 02). `options.records ?? noRecords` must type as `Records`
> without an assertion. If TS widens the default, give `Service` two overloads (with `records` / without), the
> same way `AuthPlugin.layer` has two (handlers / none). The "without" overload returns
> `Class<…, NoRecords, …>`. The `Service` implementation's return type is the existing annotated function
> return. That is a function, not a new Effect/Layer const, so the convention allows it.

`Any` gains optional `records?: AnyRecords` and `hookPoints?: Layer.Layer<never, never, unknown>`. A hand-built
fixture need not declare them.

`AuthPlugin.layer` takes the class with its `Records`/`Points` inferred and intersects the two new checks next
to `PortsComplete`:

```ts
export function layer<Self, Id extends string, Shape, Groups extends HttpApiGroup.Constraint,
  Fields extends UserFields.Declarations, Records extends AnyRecords, Points extends Layer.Layer<never, never, unknown>,
  E, R, HE, HR, Deps extends ReadonlyArray<Any> = readonly [], Taps extends ReadonlyArray<HookPoint.TapDeclaration<unknown>> = readonly [],
  Ports extends ReadonlyArray<PortClass> = readonly [], CE = never, CR = never>(
  plugin: Class<Self, Id, Shape, Groups, Fields, Records, Points>,
  options: { /* unchanged */ }
    & PortsComplete<R | HR | CR, Ports>
    & RecordsComplete<R | HR | CR, Layer.Success<Records["memory"]> | RecordsOut<Deps[number]>>
    & HookPointsComplete<R | HR | CR | TapPoints<Taps>, Layer.Success<Points> | HookPointsOut<Deps[number]>>,
): /* return type unchanged */;
```

The same change goes on the second overload (no handlers) and on the implementation's generics. Records owned by
a `dependsOn` plugin count as provided, so `Scim` (which reads organization records) declares only `ScimRecords`.
`RecordsComplete` checks coverage and nothing else. A bundle may carry a store the plugin layer does not require
itself, if it backs one of the plugin's own `tables`. `Organization.records` carries `ConnectionRecords`
for `organization_oauth_connection*`, which `OrganizationConnections` and `Sso` use. `RecordsLegal` already
guarantees the bundle provides only record stores.

### 3.3 `Auth.Built.plugins` (`packages/core/src/Auth.ts`)

`Built<P, Extra>` gains `readonly plugins: P`, the tuple as given (`make` returns its `plugins` argument). This
gives `TestAuth` the bundles at runtime with no dependency on any plugin package, which matters because
`@awthaq/test` sits in the stratum below the plugins. The type is `P`, so `RecordsOut<P[number]>` is exact.

### 3.4 `AuthHttp.middlewareFor` (`packages/server/src/AuthHttp.ts`)

The derivation lives in `@awthaq/server`, not in the test package, so a host gets the same leverage
(`examples/sql-server` adopts it in Phase 5).

```ts
// packages/server/src/AuthHttp.ts (sketch)
import type * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";

/** 08 (BEH-EA-T1): the five host middleware `@awthaq/server` implements. */
export type HostMiddleware =
  | Api.Authentication | Api.OptionalAuthentication | Api.MachineAuthentication | Api.AdminAuthentication | Api.CsrfProtection;

/** 08: the host middleware the groups of a contract declare (group and endpoint middleware, merged). */
export type DeclaredMiddleware<Groups extends HttpApiGroup.Constraint> = Extract<
  HttpApiEndpoint.Middleware<HttpApiGroup.Endpoints<Groups>>,
  HostMiddleware
>;

export interface MiddlewareOptions<CR, PR> {
  /** The CSRF secret and allowed origins (`Csrf.layerConfig` in production; a fixed test config in TestAuth). */
  readonly csrf: Layer.Layer<Csrf.CsrfConfig, never, CR>;
  /** Defaults to `Authentication.PrincipalResolverLive`; `PrincipalResolverWithUserFactsLive` opts into emailVerified. */
  readonly principalResolver?: Layer.Layer<Authentication.PrincipalResolver, never, PR>;
}

export function middlewareFor<Groups extends HttpApiGroup.Constraint, CR = never, PR = never>(
  api: HttpApi.HttpApi<"auth", Groups>,
  options: MiddlewareOptions<CR, PR>,
): Layer.Layer<DeclaredMiddleware<Groups>, never, Sessions.Sessions | Crypto.Crypto | CR | PR>;
export function middlewareFor(
  api: HttpApi.HttpApi<"auth", HttpApiGroup.Constraint>,
  options: MiddlewareOptions<unknown, unknown>,
): Layer.Layer<never, never, unknown> {
  const declared = new Set<string>();
  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ middleware }) => {
      for (const service of middleware) declared.add(service.key);
    },
  });
  const resolver = options.principalResolver ?? Authentication.PrincipalResolverLive;
  const user = Authentication.AuthenticationLive.pipe(Layer.provide(resolver));
  const table = [
    { key: Api.Authentication.key, layer: user },
    { key: Api.OptionalAuthentication.key, layer: Authentication.OptionalAuthenticationLive.pipe(Layer.provide(resolver)) },
    { key: Api.MachineAuthentication.key, layer: Authentication.MachineAuthenticationLive.pipe(Layer.provide(resolver)) },
    { key: Api.AdminAuthentication.key, layer: Authentication.AdminAuthenticationLive.pipe(Layer.provide(user)) },
    { key: Api.CsrfProtection.key, layer: Csrf.CsrfProtectionLive.pipe(Layer.provide(options.csrf)) },
  ];
  return table.reduce<Layer.Layer<never, never, unknown>>(
    (acc, entry) => (declared.has(entry.key) ? Layer.merge(acc, entry.layer) : acc),
    Layer.empty,
  );
}
```

The type and the runtime agree. `ROut` is exactly the declared host middleware, and the walk builds exactly
those. If a plugin layer needs host middleware for some reason other than a group declaration, it stays in
`RIn` and fails to compile. It is never silently absent. Plugin-owned middleware (`ScimAuthentication`, qadi's
`AuthorizedSubject`/`RequestDecisionCache`) is not host middleware and is never derived. `AdminAuthenticationLive`
gets its own `Authentication` internally, so an admin-only composition works. `CredentialResolvers` is not built
here. `Authentication` reads it through `Effect.serviceOption`, so the host (or `TestAuth`) provides one
registry below both the plugins that contribute and the middleware that reads.

### 3.5 `TestAuth.layer(built, options)` (`packages/test/src/TestAuth.ts`)

```ts
// packages/test/src/TestAuth.ts (sketch; overload = public precise type, implementation = widened, as today)
export interface CommonOptions<S, SE, SR, D, DR> {
  /** What is genuinely the test's own: plugin config, adapters (XmlSignature, WebAuthn, HttpClient), doubles. Merged into the output. */
  readonly services?: Layer.Layer<S, SE, SR>;
  /** Wraps base services in place (an outage, a spy): built over the base, shadows it for plugins and the test alike. */
  readonly decorate?: Layer.Layer<D, never, DR>;
  /** Application taps; they receive the same point instances the plugins run (core + declared hookPoints). */
  readonly taps?: Layer.Layer<never, never, unknown>;
  readonly csrf?: Partial<Csrf.CsrfConfigShape>;
  readonly principalResolver?: Layer.Layer<Authentication.PrincipalResolver, never, Users.Users>;
  readonly rateLimiter?: "permissive" | "enforcing";
  readonly openapiPath?: `/${string}`;
  readonly docsPath?: `/${string}`;
}
export type LayerOptions<S, SE, SR, D, DR> = CommonOptions<S, SE, SR, D, DR> &
  ({ readonly records?: "memory" } | { readonly records: "sql"; /** TestSql schema; one per test file. */ readonly suite: string });

type Provided<P extends ReadonlyArray<AuthPlugin.Any>, Extra extends HttpApiGroup.Constraint, Mode extends "memory" | "sql", S, D> =
  | BaseOut<Mode>                                   // Persistence.<mode> + test ports + registries + RedactionGuard + HttpServer/HttpRouter
  | AuthPlugin.RecordsOut<P[number]>
  | AuthPlugin.HookPointsOut<P[number]>
  | AuthHttp.DeclaredMiddleware<Auth.AllGroups<P, Extra>>
  | S | D;

export function layer<P extends ReadonlyArray<AuthPlugin.Any>, Extra extends HttpApiGroup.Constraint,
  S = never, SE = never, SR = never, D = never, DR = never>(
  built: Auth.Built<P, Extra>,
  options?: CommonOptions<S, SE, SR, D, DR> & { readonly records?: "memory" },
): Layer.Layer<
  Exclude<Provided<P, Extra, "memory", S, D>, AuthHttp.HostMiddleware> | Layer.Success<Auth.Built<P, Extra>["layer"]>,
  SE,
  Exclude<
    | Layer.Services<Auth.Built<P, Extra>["layer"]> | Layer.Services<typeof AuthHttp.coreHandlers>
    | AuthPlugin.RecordsIn<P[number], "memory"> | SR | DR,
    Provided<P, Extra, "memory", S, D>
  >
>;
export function layer</* same */>(
  built: Auth.Built<P, Extra>,
  options: CommonOptions<S, SE, SR, D, DR> & { readonly records: "sql"; readonly suite: string },
): Layer.Layer</* same shape, Mode = "sql"; BaseOut<"sql"> adds SqlClient.SqlClient */>;
export function layer(
  built: Auth.Built<ReadonlyArray<AuthPlugin.Any>, HttpApiGroup.Constraint>,
  options: AnyOptions = {},
): Layer.Layer<never, unknown, unknown> {
  const mode = options.records ?? "memory";
  const records = built.plugins.reduce<Layer.Layer<never, unknown, unknown>>(
    (acc, plugin) => plugin.records === undefined ? acc : Layer.merge(acc, mode === "sql" ? plugin.records.sql : plugin.records.memory),
    Layer.empty,
  );
  const points = built.plugins.reduce<Layer.Layer<never, unknown, unknown>>(
    (acc, plugin) => plugin.hookPoints === undefined ? acc : Layer.merge(acc, plugin.hookPoints),
    Layer.empty,
  );
  const middleware = AuthHttp.middlewareFor(built.api, {
    csrf: Layer.succeed(Csrf.CsrfConfig, { ...TestCsrfConfig, ...options.csrf }),
    principalResolver: options.principalResolver,
  });
  const base = mode === "sql" ? sqlBase(built, options.suite) : memoryBase(options.rateLimiter);
  const docs = options.docsPath === undefined ? Layer.empty : AuthHttp.docs(built.api, { path: options.docsPath });
  return Layer.merge(AuthHttp.routes(built.api, { openapiPath: options.openapiPath }), docs).pipe(
    Layer.provide(AuthHttp.coreHandlers),
    Layer.provideMerge(built.layer),
    // services sit closest to the plugins so they override the derived middleware and the base, and are
    // *merged*, so the output holds the very instances the plugins used (fixes the MR mismatch).
    Layer.provideMerge(options.services ?? Layer.empty),
    Layer.provide(middleware),
    Layer.provideMerge((options.taps ?? Layer.empty).pipe(Layer.provideMerge(points))),
    Layer.provideMerge(records),
    Layer.provideMerge(options.decorate ?? Layer.empty),
    Layer.provideMerge(GuardLive),
    Layer.provideMerge(base),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provideMerge(HttpRouter.layer),
    Layer.provideMerge(built.userFieldsLayer),
  );
}
```

The base, per mode:

```ts
// memory: plan 02's core bundle, plus the test ports. Until 02 lands, Persistence.memory is spelled as today's
// MemoryStores (Users/Accounts/Sessions/Verification .layerMemory) over memoryFoundation.
const memoryBase = (limiter: "permissive" | "enforcing" | undefined) =>
  Layer.mergeAll(Erasure.layer, DataExport.layer).pipe(
    Layer.provideMerge(Persistence.memory),          // plan 02: Users, Accounts, Sessions, Verification, AuditLog over memory
    Layer.provideMerge(TestPorts(limiter)),          // TestHasher, Mailer.layerMemory, RateLimiter, RateLimits.layer, Slots.layer,
                                                     // SqlTransaction.layerNoop, ClientAddress.layerDirect, TestEncryption,
                                                     // Authentication.CredentialResolversLive
    Layer.provideMerge(memoryFoundation),            // AuthEvents, Hooks.HooksLive (+ plan 10's RetentionRegistry), Crypto
  );

// sql: the same services over a migrated database. The ROut is identical plus SqlClient (BEH-EA-T2).
const sqlBase = (built: Auth.Built<ReadonlyArray<AuthPlugin.Any>, HttpApiGroup.Constraint>, suite: string) => {
  const SqlLive = TestSql.layer(suite);
  const Migrated = Layer.effectDiscard(
    Effect.gen(function* () {
      yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations, table: "effect_sql_migrations" });
      yield* Migrations.run(built.migrations);
    }),
  ).pipe(Layer.provide(SqlLive));
  return Layer.mergeAll(Erasure.layer, DataExport.layer).pipe(
    Layer.provideMerge(Persistence.sql),             // plan 02: the same stores over SQL (incl. AuditLog.layerSql)
    Layer.provideMerge(TestPortsSql),                // TestPorts with SqlTransaction.layerSql instead of layerNoop
    Layer.provideMerge(memoryFoundationSansAudit),   // AuthEvents over AuditLog.layerSql, Hooks, Crypto
    Layer.provideMerge(Migrated),
    Layer.provideMerge(SqlLive),
  );
};
```

New `TestAuth` exports. Every one has a real caller in Phase 3.

| Export | What | Replaces |
|---|---|---|
| `TestAuth.layer(built, options)` | above | positional `(built, services, options)` |
| `TestAuth.app(layer)` | `{ handler, run, request, signIn, dispose }` over one memo map. `request(method, path, { cookie, json, form, headers })` adds the double-submit CSRF pair, minted from the composition's own `CsrfConfig`, read once through `run`. `signIn(email, { amr?, onSignedUp? })` returns `SignedInSession`. | 40 memo-map handles, 22 HMAC token mints |
| `TestAuth.csrfToken(secret)` | the signed `<iat>.<random>.<hmac>` token (computed with `node:crypto`, independently of `Csrf.ts`, as `CsrfTestSupport.ts` does now) | `CsrfTestSupport.ts`, per-suite copies |
| `TestAuth.TestCsrfConfig` | the default config (32-byte+ fixed secret, no allowed origins) | 60 literals |
| `TestAuth.encryption` | `Encryption.layer` over a fixed `KeyProvider` (also in the base) | 34 copies |
| `TestAuth.httpClient.noBreach` / `.returning(body)` / `.unavailable` | `HttpClient` doubles for the breach check | 23 copies (not in the base: a test that forgets its receiver must fail to compile, not silently get a stub) |
| `TestAuth.TestSql` (module) | moved from `packages/sql/test/support/TestSql.ts` unchanged (`layer(suite)`, `injectFailure`, `regclassTypes`) | cross-package relative import |
| `TestAuth.recordModes` | `["memory", "sql"]` for `for (const records of TestAuth.recordModes)` suites | `device-authorization` `HarnessOptions.store` |
| `TestAuth.throwingFramework(describe, it)` | `TestFramework` whose `fail` throws | 6 hand-written adaptors |

`TestAuth.memoryFoundation` stays. It is the low-level seam for a store suite that builds one store alone
(`packages/core/test/*`, the plugin `*Records.test.ts` files).

#### How the harness stays dev-only

- Bundles live in plugin `src`, as production code (memory deployments use them). `@awthaq/test` only
  *selects* them, through `built.plugins`, so it depends on no plugin package.
- `@awthaq/test` gains `@effect/sql-pg` in `dependencies`, for `TestSql`. It stays a `devDependency` everywhere
  else.
- `examples/memory-server/app.ts` stops importing `@awthaq/test`. It composes `Persistence.memory` (plan 02), each
  plugin's `records.memory` and `hookPoints`, and `AuthHttp.middlewareFor` with `Csrf.layerConfig`. That shows a
  production memory server needs nothing from the harness.
- `scripts/check-contract-tests.mjs` also fails if any `packages/*/src` file (other than `packages/test`)
  imports `@awthaq/test`, or if any `packages/*/package.json` or `examples/*/package.json` lists it under
  `dependencies`.

### 3.6 `runPluginContractTests` changes

- `host` defaults to the transitive `dependsOn` closure when omitted. `{ options: [{}] }` is then enough for every
  plugin. `host: []` still exercises `E_PLUGIN_MISSING_DEP`.
- **Records parity (always, when `plugin.records` is present).** Build `records.memory` over `memoryFoundation`,
  and `records.sql` over a fresh SQLite migrated with core plus `Auth.make([...host, plugin]).migrations`. Both
  must build, and the two contexts must hold the same set of service keys. This is the runtime half of
  `RecordsLegal`, for hand-built `Any` values. A failure names the extra or missing keys.
- **Composition builds (opt-in `build: { services }`).**
  `Layer.build(TestAuth.layer(Auth.make([...host, plugin]), { records, suite, services }))` for both
  `recordModes`. It catches a plugin that composes over memory but not SQL. It is opt-in because adapters such as
  `XmlSignature`, `WebAuthn` and `HttpClient` must come from the caller.
- Existing checks are unchanged (BEH-EA-198/199/200).

### 3.7 Absorbing plugin-owned derived services

These are storage-agnostic, always required, built over the plugin's own records, and wired by hand by every
caller. They move **into** the plugin's layer (`Layer.provideMerge`, so they stay in `ROut`):

| Plugin | Absorbed into `Plugin.layer` | Stays a requirement (and why) |
|---|---|---|
| scim | `ScimConnections.ScimAuthenticationLive` (plugin-owned middleware), `ScimConnections.layerStore` | - |
| saml | `SamlConnections.layerStore`, `SamlSpKeys.layer` (needs `Encryption`, a port) | `SamlMetadataFetcher` (network adapter, `layerPinned` in production, a fake in tests) |
| sso | - | `OrganizationConnectionStore`: absorb into `Organization.layer` **only if** plan 04 makes OAuth connections non-optional; otherwise the host composes `OrganizationConnections.layerStore` (Q1) |
| jwt | `KeyRing.KeyRing.layer` | `JwtConfig` (config) |
| two-factor | `SecondFactor.layer` | gates `sessionGate`/`credentialResetGate`/`noCredentialReset` (deliberate choices that are compile errors when missing, BEH-EA-261) |
| webhooks | - | `WebhookTransport` (delivery worker only; an adapter) |

This is a production-visible change (Q1). It is scheduled per plugin in Phase 2, each with its own changeset.

---

## 4. Phased migration

Ordering inside the plan: Phase 0 → 1 → 2 (per plugin, any order after organization) → 3 (per suite, biggest
first, each suite after its plugin's Phase 2 step) → 4 → 5. Phases 3 and 4 can interleave per plugin.

### Phase 0: preconditions, baseline, spikes (tickets 01-03)

**01-baseline.** Record in `.scratch/08-test-composition/baseline.md`:
- the §2.1 counts;
- `pnpm test -- --reporter=json --outputFile=.scratch/08-test-composition/baseline-test.json` wall time and test
  count, the same for `pnpm test:bdd`, and the `pnpm test:pg` time;
- per-package `pnpm vitest run --project <pkg>` time for saml, webhooks, organization, device-authorization.

**02-spike-records-types.** In `packages/core/test/AuthPlugin.records.types.test.ts` (the `*.types.test.ts`
convention of `packages/two-factor/test/TwoFactor.types.test.ts`), prove the following before touching any
plugin:
- `records` on `Service` infers exact layer types without an assertion. Use overloads if `??` widens.
- No circularity when `Organization.layer` and `Organization.records` coexist.
- `RecordsComplete` and `HookPointsComplete` produce errors that name the key.
- `RecordsLegal` rejects a mismatched bundle and a bundle that provides a `/ports/` service.

Use `// @ts-expect-error` lines and `Includes<…>` constants. Exit criterion: the four properties compile or fail
exactly as intended under `tsc -p tsconfig.test.json`.

**03-spike-declared-middleware.** In `packages/server/test/MiddlewareFor.types.test.ts`, prove two things. First,
`HttpApiEndpoint.Middleware<HttpApiGroup.Endpoints<G>>` resolves to the middleware identifier types
(`Api.Authentication` and the rest) for a group with `.middleware(Api.Authentication).middleware(Api.CsrfProtection)`.
Second, `Extract<…, HostMiddleware>` drops `ScimAuthentication`. If Effect's `Middleware<Endpoint>` yields keys
rather than identifiers, map through `HttpApiMiddleware.Provides`/identifier types instead, and record the
finding in the ticket.

**Precondition check.** Plan 02 has shipped `Persistence.memory`/`Persistence.sql` (record their actual module
and names in ticket 01), and plan 05 has settled the plugin record-store layer names. If 02 has not shipped,
Phase 1 builds `memoryBase`/`sqlBase` from today's `Users/Accounts/Sessions/Verification/AuditLog` `layerMemory`
and `layerSql` (over `Repositories.*` from `@awthaq/sql`, as `examples/sql-server/app.ts:99-118` does), and a
follow-up ticket swaps in `Persistence.*`.

Gate: per-phase gate (type tests only, nothing else changes).

### Phase 1: core seam, server derivation, deeper harness (tickets 04-08)

**04-core-records-hookpoints.** `packages/core/src/AuthPlugin.ts`:
1. Add `RecordKeysOf`, `HookKeysOf`, `AnyRecords`, `NoRecords`, `RecordsLegal`, `RecordsOut`, `RecordsIn`,
   `HookPointsOut`, `MissingRecords`, `RecordsComplete`, `MissingHookPoints` and `HookPointsComplete` (§3.2).
2. `Class` gains `Records`, `Points`, `records` and `hookPoints`. `Any` gains the optional pair.
3. `Service` gains the two options (and overloads if the spike needed them), and stores them in the
   `Object.assign` source (`AuthPlugin.ts:312-325`).
4. Both `layer` overloads and the implementation (`:426-520`) infer `Fields`/`Records`/`Points` from `plugin`
   and intersect `RecordsComplete` and `HookPointsComplete`.

`packages/core/src/Auth.ts`: `Built` gains `plugins: P` (`:444-487`), and `make` returns it (`:895-904`).
`packages/core/src/index.ts` already re-exports `AuthPlugin`/`Auth`, so nothing to add there.

Expected compile fallout: none yet. No record key has `/records/`, so `RecordsComplete` is vacuous until Phase 2.
`HookPointsComplete` is **not** vacuous. `Organization`, `DeviceAuthorization` and `Notes` require plugin hook
points today. So in this ticket also add `hookPoints: OrganizationHooks.OrganizationHooksLive` (Organization),
`hookPoints: DeviceAuthorizationHooksLive` (DeviceAuthorization) and `hookPoints: NotesHooksLive` (template).
Each is a one-line, production-neutral declaration. Re-run the type probe to confirm no other plugin requires a
non-core point.

Tests: the Phase 0 spike file becomes the permanent type test. Add runtime
`packages/core/test/AuthPlugin.records.test.ts`: `Service` exposes `records`/`hookPoints` (defaults are
`Layer.empty`), and `Auth.make([...]).plugins` is the given tuple.

**05-server-middlewarefor.** `packages/server/src/AuthHttp.ts`: add `HostMiddleware`, `DeclaredMiddleware`,
`MiddlewareOptions` and `middlewareFor` (§3.4). Tests in `packages/server/test/MiddlewareFor.test.ts`:
- a composition declaring only `Authentication` + `CsrfProtection` builds exactly those two (inspect the context
  with `Context.getOption`);
- `OptionalAuthentication` answers anonymous;
- `AdminAuthentication` alone (an `adminApi`-only composition) builds with its internal `Authentication`;
- `MachineAuthentication` on an `extraGroups` group admits an `ApiKey` principal from a contributed resolver;
- `principalResolver: PrincipalResolverWithUserFactsLive` puts `emailVerified` on the principal.

Type test in `MiddlewareFor.types.test.ts`: `Layer.Success` equals `DeclaredMiddleware`.

**06-testsql-move.** `git mv packages/sql/test/support/TestSql.ts packages/test/src/TestSql.ts`. Export it as
`export * as TestSql from "./TestSql.ts"` in `packages/test/src/index.ts`. Add `@effect/sql-pg: "catalog:"` to
`packages/test/package.json` `dependencies`. Rewrite the 31 importers:
- plugin and feature files: `import { TestSql } from "@awthaq/test"`. Add `@awthaq/test` as a `devDependency`
  where missing: api-key, passkey, roles, saml, scim (verify with
  `node -e` over `package.json`; admin, device-authorization, jwt, magic-link, oauth, organization, qadi,
  two-factor and webhooks already have it).
- `packages/core/test/{Users,UserFields,UserImport}.test.ts` and
  `packages/sql/test/Repositories.postgres.test.ts`: import `../../test/src/TestSql.ts` by relative path. Core
  and sql cannot take a package dependency on `@awthaq/test`, which depends on them.

Then update the comments in `scripts/test-pg.sh:10-12` and `packages/sql/README.md:81` (path). Run `pnpm test:pg`.

**07-testauth-layer.** `packages/test/src/TestAuth.ts`:
1. Replace `layer`'s signature and implementation (§3.5). Delete the `services` doc block (`:205-243`) and
   write the new doc once.
2. `MemoryStores`/`MemoryPorts` (`:130-182`) become `memoryBase`. Add `TestEncryption` and
   `Authentication.CredentialResolversLive`. Add `sqlBase`.
3. Add `app`, `csrfToken`, `TestCsrfConfig`, `encryption`, `httpClient`, `recordModes` and `throwingFramework`.
4. Update the header comment (`:1-61`) and `packages/test/src/index.ts`'s stale header (it still says the
   rate limiter and hook isolation are "deferred").
5. `packages/test/package.json`: add `@awthaq/api` to `dependencies` if `app`/middleware typing needs it (it is a
   `devDependency` today).

**08-migrate-existing-calls.** Mechanically rewrite the 36 existing calls listed in §2.2. In the same commit
(the signature is breaking, and the shared conventions forbid a shim):
- `TestAuth.layer(built, X)` → `TestAuth.layer(built, { services: X' })`, where `X'` drops
  `AuthenticationLive`/`PrincipalResolverLive`/`CsrfProtectionLive`/`CsrfConfig` and anything the base now
  provides (`Mailer.layerMemory`, `RateLimiter.layerPermissive`, encryption).
- `TestAuth.layer(built, X, { openapiPath })` → `{ services: X', openapiPath }`.
- `TestAuth.layer(built, Layer.empty)` → `TestAuth.layer(built)`.
- `features/step-definitions/ServeComposition.ts`: its only export (`services`) becomes `Layer.empty`. Delete the
  file and its imports.
- `CsrfWorld.ts:171-174` passes explicit `csrf` options where its scenarios need non-default origins.

Tests for the harness: [§5.1](#51-proving-the-harness).

Gate: per-phase gate, plus `pnpm test:bdd` (12 feature files changed), plus `pnpm test:pg` (TestSql moved).
Changeset C1 (§6.4).

### Phase 2: records bundles, plugin by plugin (tickets 09-22)

Each ticket follows the same recipe, as one commit per plugin:
1. **Rename record keys** to `/records/` (§3.1). Grep the old key string repo-wide
   (`grep -rn '"awthaq/<pkg>/<Name>"'`) for any hard-coded use in tests or docs.
2. **Create the bundles** next to the record modules:
   `src/<Plugin>Records.ts` (or extend the existing `*Memory.ts`), exporting
   `memory = Layer.mergeAll(A.layerMemory, B.layerMemory)` and `sql = Layer.mergeAll(A.layerSql, B.layerSql)`.
   No type annotations.
3. **Declare** `records: { memory, sql }` (and `hookPoints` where the plugin owns points) in the
   `AuthPlugin.Service` options. The compiler now enforces completeness.
4. **Absorb** the derived services in §3.7, where listed.
5. **Contract test.** Create or move to `test/Contract.test.ts` (Phase 4 detail, done here per plugin).
6. **Tests for the bundle.** One `describe.each(TestAuth.recordModes)` in the plugin's existing store suite. It
   builds `Plugin.records[mode]` over `memoryFoundation` (memory) or a migrated `TestSql` (sql) and runs the
   suite's existing store assertions against both. This replaces any per-store memory/sql duplication in that
   file (replace, don't layer).
7. Gate: per-phase gate plus `pnpm test:pg`. Changeset per plugin (§6.4 C3).

Per-plugin specifics, in execution order:

| Ticket | Plugin | Bundle contents | Notes |
|---|---|---|---|
| 09 | organization | memory: `OrganizationMemory.layer` + `ConnectionRecords.layerMemory`; sql: new `OrganizationSql.layer` (7 × `layerSql`) | Rename `OrganizationMemory.ts` → `OrganizationRecordsBundle.ts` exporting `memory`/`sql` (or keep the module name and add `sql`, whichever plan 04 left). Delete `OrganizationMemory.layer` once Phase 3 has moved its 13 callers (it is `Organization.records.memory`). `hookPoints` already declared in ticket 04. Coordinate with plan 04: any record store 04 added joins the bundle, and the compiler will say so. |
| 10 | two-factor | `layerSecretsMemory` + `layerRecoveryCodesMemory` / `layerSecretsSql` + `layerRecoveryCodesSql` | absorb `SecondFactor.layer`; gates stay |
| 11 | webhooks | `WebhookRecords.layerMemory` / `.layerSql` | `WebhookTransport` stays with the delivery worker |
| 12 | saml (`Saml`, `Sso`) | `SamlRecords.layerMemory` / `.layerSql` on `Saml`; `Sso` declares none | absorb `SamlConnections.layerStore`, `SamlSpKeys.layer`; `Sso`'s `OrganizationConnectionStore` per Q1 |
| 13 | scim | `ScimRecords.layerMemory` / `.layerSql` | absorb `ScimAuthenticationLive` and `layerStore` |
| 14 | device-authorization | grant + client records | `hookPoints: DeviceAuthorizationHooksLive` (ticket 04); delete `recordsLayer` from `test/support/harness.ts` |
| 15 | api-key | `ApiKeyRecords` + `ApiKeyClientRecords` | `CredentialResolvers` comes from the TestAuth base / host |
| 16 | jwt | `SigningKeyRecords` + `RevocationStore` | absorb `KeyRing.KeyRing.layer` |
| 17 | passkey | `PasskeyCredentials` + `PasskeyUserHandles` + `ChallengeStore` | `WebAuthn` stays a port (tests `Layer.mock` it) |
| 18 | admin | `ImpersonationRecords` on `Admin`; `AdminTenants` reads org records through `dependsOn` | |
| 19 | roles | **new** `RoleAssignments` record store (`src/RoleAssignments.ts`, key `awthaq/roles/records/RoleAssignments`) extracted from `rolesMake`/`rolesMakeSql` (`Roles.ts`) with `layerMemory`/`layerSql`; `Roles.layer` requires it; **delete `Roles.layerSql`** | production API change (Q3); migration note: `Roles.layerSql` → `Roles.layer` + `Roles.records.sql` |
| 20 | qadi `UserClaims` | **new** `UserClaimsRecords` (key `awthaq/qadi/records/UserClaims`) from `memoryMake`/`sqlMake`; **delete `UserClaims.layerSql`** | same pattern as roles (Q3) |
| 21 | plugin-template | add `NoteRecords.layerMemory`; `records: { memory: layerMemory, sql: layerSql }`; key → `example/notes/records/NoteRecords` | doc checklist item 4 now true for the template |
| 22 | oauth, password, magic-link | no records: verify `records` defaults and nothing to declare | contract tests only (Phase 4) |

### Phase 3: migrate suites and BDD worlds (tickets 23-45)

**Rules for every migrated file.**
- Build the composition with `Auth.make([...])`, even for service-level suites. The routes cost little and the
  graph is then the production graph.
- `services` holds only plugin config (`Plugin.config(...)`), adapters (`XmlSignatureNode.layer`, a
  `WebAuthn` mock, `TestAuth.httpClient.*`, fake fetchers, transports and receivers), and test doubles. Never a
  core store, a record layer, host middleware or a base port. An outage or spy on a core store goes in
  `decorate`. Taps go in `taps`.
- Replace the hand-rolled handle with `TestAuth.app(layer)`.
- `records: "sql"` where the suite exercises SQL behaviour today (OrganizationSql, device-authorization `store:
  "sql"`, tests listed in `scripts/test-pg.sh`). Add the migrated suites to `scripts/test-pg.sh`'s `suites`
  array.
- Delete what the harness replaced. A support file that is left with only domain helpers (seeders, IdP/receiver
  fakes, fixtures) keeps them and loses its composition.
- Keep the test count identical. The PR description lists `before → after` test counts for the file
  (`pnpm vitest run <file> --reporter=json`). No `it.skip` may be added.
- **Exempt (stay hand-wired, because the wiring is under test):** `packages/server/test/{Authentication,Csrf,CredentialResolvers}.test.ts`,
  `packages/core/test/*` store suites, `packages/sql/test/*`, `packages/next/test/*` and `packages/web/test/*`
  where they test the adapter's own wiring, `features/step-definitions/CsrfWorld.ts` (CSRF-specific), and the
  middleware-specific parts of `AuthenticationWorld.ts`/`AuthenticationSteps.ts`/`SessionAssuranceSteps.ts`. Each
  exempt file gets a one-line header comment: `// Hand-wired on purpose: <what wiring is under test> (plan 08 exemption).`

**Order** (biggest first; each after its plugin's Phase 2 ticket):

| Ticket | Package-test target (lines / wiring calls) | Expected result |
|---|---|---|
| 23 | `packages/saml/test/support.ts` (258 / 34) + 17 suites | `SamlLive(config, limiter, fetcher)` → `TestAuth.layer(Auth.make([Organization, Saml]), { services: Layer.mergeAll(Saml.config(...), Organization.config({}), fetcher, XmlSignatureNode.layer), rateLimiter })`; keep `fakeFetcher`, `seedConnection`, `startLogin`, `idpResponse`, `atNow`; ≤ 150 lines |
| 24 | `packages/webhooks/test/support.ts` (245 / 15) + 12 suites | `deliveryLayer`/`adminLayer` collapse into `TestAuth.layer(Auth.make([Webhooks]), { services: Layer.mergeAll(Webhooks.config(...), receiver, transport, resolver) })`; `EncryptionLive`, `CoreLive`, `AdminAuthenticationLive`, `CsrfProtectionLive` deleted; ≤ 140 lines |
| 25 | `packages/device-authorization/test/support/harness.ts` (239 / 39) | `buildLayer`/`makeApp` → `TestAuth.layer(Auth.make([TwoFactor, DeviceAuthorization]), { records, suite, taps, rateLimiter, services: Layer.mergeAll(DeviceAuthorization.config(...), TwoFactor.sessionGate, TwoFactor.credentialResetGate) })` + `TestAuth.app`; `CSRF_TOKEN`, `TestHasher`, `EncryptionLive`, `TestServices` deleted; ≤ 100 lines |
| 26 | `packages/api-key/test/harness.ts` (210 / 38) | ≤ 90 lines |
| 27 | `packages/two-factor/test/support/harness.ts` (146 / 28) + `AuthHttp.test.ts` | ≤ 50 lines; delete the file if what remains is under 30 lines and inline it into its users |
| 28 | `packages/password/test/harness.ts` (118 / 19) | keep `email`, `strongPassword`, `tokenOf`; `NoBreachHttpClient`/`httpClientReturning`/`UnavailableHttpClient` → `TestAuth.httpClient.*`; ≤ 60 lines |
| 29 | `packages/magic-link/test/support/harness.ts` (117 / 28) | delete if under 30 lines remain (`letForkedFibersRun`, `secretOf` move to their users) |
| 30 | `packages/scim/test/support.ts` (97 / 22) | `ScimLive(...)` → `TestAuth.layer(Auth.make([Organization, Scim]), { services: Layer.mergeAll(Scim.config(...), Organization.config(...)), decorate: users, taps: hooks })`; keep `seedConnection`; ≤ 40 lines |
| 31 | organization (24 files; 8 PRL, 18 recM, 9 recS) incl. `OrganizationSql.test.ts:46-82` → `records: "sql", suite: "organization_OrganizationSql"` | |
| 32 | jwt (14 files; 8 PRL, 11 recM) | |
| 33 | admin (12 files; 9 PRL, 8 recM) | |
| 34 | passkey (19 files; 5 PRL, 9 recM) | `passkeyTestFixtures.ts` keeps WebAuthn fixtures; composition moves |
| 35 | oauth (12 files; 6 PRL) and qadi (12 files; 6 PRL) | qadi bridge suites keep `RequirePermissionLive`/`SubjectExtractorLive` in `services` |
| 36 | roles, remaining password / magic-link / two-factor files | |

| Ticket | BDD target (lines / wiring calls) | Notes |
|---|---|---|
| 37 | `TenancyWorld.ts` (549 / 62) | organization `records: "sql"` scenarios use `suite` per scenario world |
| 38 | `DomainWorld.ts` (441 / 44) | keeps its `Users` outage via `decorate` |
| 39 | `SamlWorld.ts` (706 / 43) + `SamlFixtures.ts` | share the package's IdP helpers if their signatures match |
| 40 | `PasswordWorld.ts` (658 / 36), `MagicLinkWorld.ts` (368 / 33) + `MagicLinkSupport.ts` | `makeCapturingMailer` → `services: mailer.layer`, read back through `app.run` (the MR fix makes this the same instance) |
| 41 | `TwoFactorWorld.ts` (566 / 32), `SessionWorld.ts` (603 / 32), `SessionServer.ts` (166 / 20) | |
| 42 | `ScimWorld.ts` (345 / 32) | `UsersDownOnLookup` → `decorate`; `VetoDelete` → `taps` |
| 43 | `DeviceAuthorizationWorld.ts` (331 / 32), `OrganizationWorld.ts` (374 / 28), `QadiOrganizationFixture.ts` (89 / 15) | |
| 44 | `QadiBridgeWorld.ts` (996 / 30), `OAuthWorld.ts` (297 / 22), `WebhooksWorld.ts` (575 / 21), `PasskeyWorld.ts` (505 / 21) | |
| 45 | `AdminWorld.ts` (346 / 19), `JwtWorld.ts` (392 / 16), `ContractStratumWorld.ts` (321 / 14), `AuthenticationWorld.ts` (non-exempt parts, 611 / 37) | then delete `features/step-definitions/CsrfTestSupport.ts` and `shared/Harness.ts`'s `TestServices`/`cheapArgon2id` if no importer remains (`grep -rl`) |

The BDD step files (`*Steps.ts`, 453-1,474 lines) change only where they compose a layer
(`RateLimitingSteps.ts:995,1015`, `CompositionSteps.ts:198-447`, `TestingHarnessSteps.ts:249`). Their scenario
logic is untouched. Exit check per BDD ticket: `pnpm test:bdd` reports the same passed/skipped scenario counts as
the baseline (`@skip @unwired` features unchanged).

Gate per ticket: per-phase gate; `pnpm test:bdd` for BDD tickets; `pnpm test:pg` when the ticket adds
`records: "sql"` suites. No changeset (tests only), except for ticket 31's deletion of `OrganizationMemory.layer`
(C3 organization note).

### Phase 4: contract tests everywhere, enforced (tickets 46-48)

**46-contract-suite-deepening.** `packages/test/src/TestAuth.ts` `runPluginContractTests`: add the default
`host` closure, the records-parity check and the opt-in `build` (§3.6). Tests in
`packages/test/test/runPluginContractTests.test.ts`:
- a hand-built `Any` with `records.memory` ≠ `records.sql` keys fails, naming the key;
- a well-formed records plugin passes in both modes;
- omitting `host` for a plugin with `dependsOn` passes, while `host: []` still reports `E_PLUGIN_MISSING_DEP`;
- `build` reports a plugin whose `records.sql` needs a service the base lacks.

**47-contract-files.** One `test/Contract.test.ts` per plugin package, calling
`TestAuth.runPluginContractTests(TestAuth.throwingFramework(describe, it), () => X, { options: [{}] })` for
**every** plugin class:
- create: api-key (`ApiKey`), oauth (`OAuth`), passkey (`Passkey`), password (`Password`), qadi (`UserClaims`),
  roles (`Roles`, `RolesAdmin`), saml (`Saml`, `Sso`), scim (`Scim`), webhooks (`Webhooks`);
- move into `Contract.test.ts` (delete the old call): admin (`AuthHttp.test.ts:762-771`, and add
  `AdminAccounts`, `AdminTenants`), jwt (`AuthHttp.test.ts:599`), organization (`AuthHttp.test.ts:852`),
  device-authorization (`Plugin.test.ts:149-153`), template (`Template.test.ts:186`);
- already there: magic-link (`MagicLink`, `EmailOtp`), two-factor (`TwoFactor`). Swap the hand-written
  framework adaptor for `throwingFramework`.

Pass `hooks: [...]` stubs where a plugin declares taps. A missing stub is not an error, but the stub is what runs
BEH-EA-200's kind checks. Pass `build: { services }` where adapters are cheap (password: `TestAuth.httpClient.noBreach`;
saml: `XmlSignatureNode.layer` + `fakeFetcher({}).layer`; passkey: a `Layer.mock(WebAuthn)`).

**48-check-script.** `scripts/check-contract-tests.mjs` (style of `scripts/check-readme-status.mjs`, anchored with
`_root.mjs`):
1. Collect plugin classes:
   `/export class (\w+) extends AuthPlugin\.Service</g` over `packages/*/src/**/*.ts` and
   `examples/plugin-template/src/**/*.ts`. Exit 1 if **zero** are found (anchoring guard).
2. For each owning package, require `test/Contract.test.ts` to exist. Split its text on
   `runPluginContractTests(`, read each segment's makePlugin argument (`/=>\s*(?:[\w$]+\.)*([\w$]+)/`), and
   require every class name to appear.
3. Fail if any `packages/*/src/**/*.{ts,tsx}` outside `packages/test` imports `@awthaq/test`, or any
   `packages/*/package.json` / `examples/*/package.json` lists `@awthaq/test` under `dependencies`.
4. Print one line per problem. Exit 1 on any problem.

`package.json`: add `"check:contract-tests": "node scripts/check-contract-tests.mjs"` and insert
`pnpm check:contract-tests` into `check` right after `pnpm check:error-tags`. Verify the script's teeth by hand
in the ticket: comment out one call → exit 1, naming the class. Restore it → exit 0.

Gate: per-phase gate plus `pnpm check`. Changeset C4 (`@awthaq/test` contract-suite changes).

### Phase 5: docs, template, examples, spec (tickets 49-52)

**49-template.** `examples/plugin-template/`:
- `src/Template.ts`: records bundle (ticket 21), `hookPoints: NotesHooksLive`.
- `test/Template.test.ts`: rewrite on `TestAuth.layer(Auth.make([Notes]), { records: "sql", suite: "template", services: Template.config({ maxLength: 20 }), taps: ForbiddenTap })`
  plus `TestAuth.app`. It runs `for (const records of TestAuth.recordModes)` so the template proves both bundles.
  Delete `TestServices`, `CoreLive`, `AuthenticationLive`, `CsrfProtectionLive`, `CSRF_TOKEN`, `SqlLive`,
  `Migrated`, `RecordsLive`, the memo-map block and `issueSessionCookie` (→ `app.signIn`).
- `test/Contract.test.ts`: the contract call, moved out of `Template.test.ts`.
- Target: `Template.test.ts` ≤ 110 lines (from 196), ≤ 6 wiring calls (from 22).

**50-docs.** `docs/plugin-authoring.md`:
- "The shape of a plugin" table: the Persistence row says "records stores keyed `…/records/…`, declared as
  `records: { memory, sql }` on `AuthPlugin.Service` (compile-checked: complete, matched, records only)". Add a
  "Hook points" row: `hookPoints`.
- New section **"Record stores and bundles"** after "Ports are required, never provided": the key convention,
  the bundle declaration, the three compile errors and what each message says, and "a store another plugin owns
  comes from its bundle through `dependsOn`".
- New section **"Testing a plugin"** before "House rules": `TestAuth.layer(Auth.make([...]), { services })`, what
  belongs in `services`/`decorate`/`taps`, `records: "sql"` + `suite`, `TestAuth.app`, `pnpm test:pg`, and the
  "hand-wire only what is under test" rule.
- Migrations section: replace the `packages/sql/test/support/TestSql.ts` reference with `TestSql` from
  `@awthaq/test`.
- Checklist (`:95-103`): item 4 → "Record stores keyed `<pkg>/records/<Name>`, each with `layerMemory` and
  `layerSql`, declared as `records: { memory, sql }` on `AuthPlugin.Service` (the compiler rejects a missing
  or mismatched bundle)". Item 5 → "Hook points with a `.layer` each, merged into one layer declared as
  `hookPoints`". Item 6 → "`test/Contract.test.ts` calls `TestAuth.runPluginContractTests` for every plugin class
  in the package (`pnpm check:contract-tests` enforces it), plus a suite built with `TestAuth.layer` that runs
  in both `TestAuth.recordModes`".
- `packages/test/README.md`: the new interface in five lines and a pointer to the doc section.
- `packages/sql/README.md:81` and `scripts/test-pg.sh` header: the new `TestSql` location.

**51-examples.** `examples/memory-server/app.ts` composes without `@awthaq/test` (§3.5, Q6). Remove the
dependency from `examples/memory-server/package.json`. `examples/sql-server/app.ts:121-145`: replace the
hand-built `AuthenticationLive`/`CsrfProtectionLive` with `AuthHttp.middlewareFor(auth.api, { csrf: Csrf.layerConfig })`.

**52-spec.** See §6.

Gate: `pnpm check` (the plan gate), `pnpm test:pg`, `pnpm test:bdd`.

---

## 5. Test plan

### 5.1 Proving the harness

All tests live in `packages/test/test/`. They replace and extend `TestAuth.test.ts`, whose `Whoami` fixture stays.

| File | Proves |
|---|---|
| `TestAuth.test.ts` (rewritten) | BEH-EA-193/197 as today, written as `TestAuth.layer(built)` with **no** `services`; `signInAs` authenticates; 401 without credential |
| `TestAuthMiddleware.test.ts` | BEH-EA-T1. One fixture api per host middleware. `Authentication` 401/200; `OptionalAuthentication` anonymous 200; `AdminAuthentication` delegates; `MachineAuthentication` on an `extraGroups` group admits an `ApiKey` principal from a test-contributed resolver; `CsrfProtection` 403 without the pair, 2xx with `app.request`. `services` providing `Api.AdminAuthentication` overrides the derived one (a fixed-principal admin layer proves it). `principalResolver` puts `emailVerified` on the principal. |
| `TestAuthRecords.test.ts` | BEH-EA-T2. A fixture plugin `Pins` (table `pins_pin`, records `{ memory, sql }`, one endpoint). `records: "memory"` round-trips. `records: "sql"` round-trips and the row is visible through `yield* SqlClient.SqlClient` (`SELECT * FROM pins_pin`). Two `suite` names do not share rows. Under `pnpm test:pg` the same file runs on Postgres (add it to `scripts/test-pg.sh`). |
| `TestAuthRecords.types.test.ts` | BEH-EA-T4/T5 at the harness boundary. `TestAuth.layer(Auth.make([Pins]))` has `RIn = never` (assigned to `Layer.Layer<…, …, never>`). The same for `records: "sql"`. `// @ts-expect-error` on `records: "sql"` without `suite`. `// @ts-expect-error` on a plugin requiring `x/records/Missing` with no bundle (at its `AuthPlugin.layer`). `// @ts-expect-error` on a mismatched bundle. `// @ts-expect-error` on a bundle that provides a `/ports/` service. `// @ts-expect-error` on a plugin requiring a non-core hook point it does not declare. |
| `TestAuthServices.test.ts` | Regression for the `MR` mismatch. A capturing `Mailer` in `services` is the instance `yield* Mailer.Mailer` returns **and** the one the plugin sent through. A service that only `services` provides is `yield*`-able. |
| `TestAuthDecorate.test.ts` | `decorate` with a `Users` whose `findByEmail` fails: the plugin's sign-in sees the outage (503) and the test's `yield* Users` sees the decorated one. |
| `TestAuthApp.test.ts` | BEH-EA-T3. `app.run` and `app.handler` share instances (a session minted through `run` authenticates a `handler` request). `app.request` passes CSRF on POST. `app.signIn` returns a working cookie. `dispose` releases the scope. |
| `MemoryFoundation.test.ts` | unchanged |
| `runPluginContractTests.test.ts` | the four new cases in ticket 46 |
| `packages/server/test/MiddlewareFor.test.ts`, `MiddlewareFor.types.test.ts` | ticket 05 |
| `packages/core/test/AuthPlugin.records.test.ts`, `AuthPlugin.records.types.test.ts` | ticket 04 |

### 5.2 Equivalence while migrating (hidden differences)

For the eight biggest compositions (tickets 23-27, 37-39), the ticket records a one-off comparison, run locally
and not committed. Build the old and the new layer and list the `Context` keys of each. Every key the old
graph had that the new one lacks must be explained (expected: `Api.*` middleware, which is now provided rather
than merged). The suite's test count must match. Then delete the old composition.

### 5.3 Measured shrinkage targets (acceptance)

Re-run the §2.1 commands at the end of Phase 5:

| Metric | Baseline | Target |
|---|---:|---:|
| test + feature files building `PrincipalResolverLive` | 105 | ≤ 12 (exempt files) |
| test + feature files building `CsrfProtectionLive` | 79 | ≤ 8 |
| test + feature files building a `CsrfConfig` literal | 60 | ≤ 8 |
| files using `TestAuth.layer(` (tests, features, examples) | 19 | ≥ 90 |
| `Layer.provide/provideMerge/mergeAll/merge(` in `packages/*/test` | 2,373 | ≤ 1,300 |
| same in `features/step-definitions` | 795 | ≤ 380 |
| `makeMemoMapUnsafe` in tests/features | 40 | ≤ 4 |
| `createHmac("sha256"` CSRF mints in tests/features | 22 | ≤ 2 (`packages/server/test/Csrf.test.ts`; `TestAuth.csrfToken`) |
| plugin support files (the 9 in §2.3), total lines | 1,863 | ≤ 900 |
| `packages/*/test` total lines | 82,390 | ≤ 79,900 |
| `features/step-definitions` total lines | 54,756 | ≤ 53,200 |
| plugin classes without an in-package contract test | 13 of 20 | 0 (enforced) |
| `pnpm test` wall time | baseline | ≤ baseline + 10 % |
| `pnpm test:bdd` wall time | baseline | ≤ baseline + 10 % |

### 5.4 Files deleted

- `packages/sql/test/support/TestSql.ts` (moved, ticket 06)
- `features/step-definitions/ServeComposition.ts` (ticket 08)
- `features/step-definitions/CsrfTestSupport.ts` (ticket 45, if no importer remains; `CsrfWorld` uses `TestAuth.csrfToken`)
- `TestServices` and `cheapArgon2id` in `features/step-definitions/shared/Harness.ts` (ticket 45; the file keeps `cookieFrom`, `makeNamedRegistry`, …)
- `packages/magic-link/test/support/harness.ts` and `packages/two-factor/test/support/harness.ts`, when the
  under-30-lines rule applies (tickets 27, 29)
- `packages/organization/src/OrganizationMemory.ts`'s `layer` export (ticket 31, once
  `Organization.records.memory` replaces its 13 callers)
- `Roles.layerSql`, `UserClaims.layerSql` (tickets 19, 20)
- the `recordsLayer` helper in `packages/device-authorization/test/support/harness.ts` (ticket 14)

---

## 6. Spec, traceability, docs, changesets

### 6.1 BEH ids

New ids are appended at execution time from the next free number. `spec/scripts/verify-traceability.sh` check 8
fails on gaps. As of 2026-10-13 the maximum is BEH-EA-318, and plans 01-07 and 09-10 also allocate, so do not
pre-assign numbers. Run
`grep -rhoE '^## BEH-EA-[0-9]+' spec/behaviors/*.md | sort -t- -k3 -n | tail -1` first. Placeholders below:
**T1-T6**. Out-of-range ids in a file already have precedent (`06-domain-users-accounts.md` holds BEH-EA-254).

| Placeholder | File | Title | Requirement (summary) |
|---|---|---|---|
| T1 | `25-testing-harness.md` | `TestAuth.layer` derives the host middleware from the composed contract | Every host middleware the composed groups declare MUST be provided, and only those. A test MUST NOT need to build `Authentication`, `CsrfProtection` or their configuration. `services` MUST be able to override any of them. |
| T2 | `25-testing-harness.md` | `TestAuth.layer` runs the same composition over SQL | `records: "sql"` MUST serve the same services over a database migrated with core and composition migrations, using each plugin's `records.sql`. Under `AWTHAQ_POSTGRES_URL` it MUST use a per-suite Postgres schema. Omitting `suite` MUST be a compile error. |
| T3 | `25-testing-harness.md` | `TestAuth.app` serves the composition and its context together | Handler and context runner MUST share one instance of every service. `request` MUST satisfy CSRF double-submit for the composition's own config. |
| T4 | `01-plugin-contract.md` | A plugin declares its record stores as matched memory and SQL bundles | A plugin whose layer requires a `/records/` store that neither its bundle nor a `dependsOn` plugin's bundle provides MUST fail to compile. `memory` and `sql` providing different stores MUST fail to compile. A bundle providing anything other than record stores MUST fail to compile. |
| T5 | `03-ports-slots-hooks-registries.md` | A plugin declares the hook points it owns | A plugin requiring a hook point that is neither core's nor declared (by it or a `dependsOn` plugin) MUST fail to compile. The harness MUST provide declared points once, below application taps. |
| T6 | `25-testing-harness.md` | Every shipped plugin runs the contract suite, which checks its records | Every `AuthPlugin.Service` class in the repository MUST be exercised by `runPluginContractTests` from its package's `test/Contract.test.ts` (enforced by `pnpm check`). The suite MUST check that `records.memory` and `records.sql` build and provide the same stores. |

Revisions to existing entries:
- **BEH-EA-193**: its code block becomes `TestAuth.layer(Auth.make(plugins), { services })`. Add an *As shipped
  (plan 08)* note on derived middleware, bundles, the base's contents (including `Encryption` and
  `CredentialResolvers`), `decorate`/`taps`, and `@awthaq/test` being dev-only.
- **BEH-EA-198**: add the default `host` closure and a pointer to T6.

Document Control rows (revision + change history line, effective date = execution date):
`25-testing-harness.md` 1.2 → 1.3; `01-plugin-contract.md` 1.1 → 1.2; `03-ports-slots-hooks-registries.md`
1.2 → 1.3. Update the Previous/Next navigation lines of the neighbours of every appended id.

### 6.2 Traceability

- `spec/traceability.md` §1: add the new ids to the rows for files 01, 03 and 25.
- `spec/traceability.md` §5 test mapping: rewrite the `packages/test/test/TestAuth.test.ts` row (`:246`). It
  currently records the `middleware` parameter finding, which this plan supersedes. Add rows for each new test
  file in §5.1, `packages/server/test/MiddlewareFor*.test.ts`, `packages/core/test/AuthPlugin.records*.test.ts`,
  and every new `packages/*/test/Contract.test.ts` (BEH-EA-198-200, T6).
- `spec/traceability.md` §2 (URS crosswalk): add T1-T3 to URS-EA-009's row, beside BEH-EA-193.
- Gates table: add `pnpm check:contract-tests` wherever the gates are listed (`grep -n "check:error-tags" spec/`).

### 6.3 BDD

`features/features/08-tooling/25-testing-harness.feature`: one `Rule` per new harness id (T1, T2, T3, T6), with
scenarios:
- T1: "A composition declaring the admin tier is served with no hand-built middleware"; "A test's own
  AdminAuthentication overrides the derived one".
- T2: "The same plugin composition answers identically over memory and SQL".
- T3: "A session minted through the app's context authenticates a request through its handler".
- T6: "A plugin package without a contract-test call fails pnpm check" (drives the script against a temp copy;
  steps in `TestingHarnessSteps.ts`).

`features/features/00-foundations/01-plugin-contract.feature` (T4) and `03-ports-slots-hooks-registries.feature`
(T5) get compile-time scenarios through the existing `CompileTimeGates.ts`/`CompileTimeSteps.ts` mechanism.
Allocate REQ ids with `python3 features/scripts/allocate-req-ea.py` (never by hand). `--check` must pass, and it
regenerates `features/traceability.md`.

### 6.4 Changesets (ADR-EA-034; all packages are in the fixed group)

| # | Packages | Bump | Content and `Migration:` note |
|---|---|---|---|
| C1 (Phase 1) | `@awthaq/core`, `@awthaq/server`, `@awthaq/test` | minor | `AuthPlugin.Service` `records`/`hookPoints`; `Auth.Built.plugins`; `AuthHttp.middlewareFor`/`DeclaredMiddleware`; `TestAuth.layer(built, options)`, `app`, `TestSql`, `encryption`, `httpClient`, `csrfToken`. **Migration:** `TestAuth.layer(built, services, opts)` → `TestAuth.layer(built, { services, ...opts })`; drop `Authentication`/`CSRF` from `services`; `TestSql` now `import { TestSql } from "@awthaq/test"`; a plugin owning hook points adds `hookPoints`. |
| C2 (Phase 1, ticket 04) | `@awthaq/organization`, `@awthaq/device-authorization` | patch | `hookPoints` declared (no behaviour change). |
| C3 (Phase 2, one per ticket) | each plugin | minor | record keys gain `/records/` (any code that built a `Context` by key string must use the class); `records` bundle declared; absorbed services (scim, saml, jwt, two-factor) are now provided by the plugin layer. **Migration:** remove your own `ScimAuthenticationLive`/`SamlConnections.layerStore`/`SamlSpKeys.layer`/`KeyRing.layer`/`SecondFactor.layer` from the host graph (keeping them is harmless but redundant); `OrganizationMemory.layer` → `Organization.records.memory`; roles/qadi: `Roles.layerSql` → `Roles.layer` + `Roles.records.sql`, `UserClaims.layerSql` → `UserClaims.layer` + `UserClaims.records.sql`. |
| C4 (Phase 4) | `@awthaq/test` | minor | `runPluginContractTests`: default `host`, records parity, `build`; `throwingFramework`. **Migration:** none required. A plugin whose bundles disagree now fails its contract test. |

---

## 7. Risks, mitigations, rollback

| Risk | Where it shows | Mitigation |
|---|---|---|
| **Provide vs merge of middleware.** Hand-wired suites often `provideMerge(AuthenticationLive)`, so `Api.Authentication` was in their context. The harness *provides* it. | a test that `yield* Api.Authentication` | `grep -rn "yield\* Api\.\(Authentication\|CsrfProtection\|AdminAuthentication\)" packages/*/test features` before each ticket (0 today). The §5.2 key diff lists them. |
| **Services shadowing changes which instance a test reads** (the `MR` fix) | suites passing a capturing mailer or custom limiter | This is the intended fix. `TestAuthServices.test.ts` pins it. Suites that worked around it (reading through the plugin instead) keep passing. |
| **Base ports under core stores.** A port replaced via `services` is seen by plugins but **not** by core stores built in the base. | e.g. a custom `Crypto` | Document it in the `services` doc. Core-store-level substitution goes through `decorate` or `TestAuth.memoryFoundation` (store suites stay hand-wired, exempt). |
| **Permissive limiter by default** | suites using `realLimiter` (magic-link, two-factor, device-authorization, webhooks) | `rateLimiter: "enforcing"`. Grep `realLimiter\|layerStoreMemory` per ticket. |
| **More built per suite.** Routes, all declared middleware and the `RedactionGuard` tracer/logger, which were absent in service-level suites. | test runtime | Measured against the Phase 0 baseline at every Phase 3 ticket, with a +10 % budget overall. `@effect/vitest`'s `layer(...)` builds once per `describe`. BDD worlds build once per world through `TestAuth.app`'s memo map. If over budget: add `redactionGuard: false` (Q8) and memoise `Auth.make` per module. |
| **SQL mode cost** (core + plugin migrations per suite; Postgres schema drop and create) | `records: "sql"` suites | Only suites that exercised SQL before get `sql`. SQLite `:memory:` migrations are milliseconds. Postgres stays under `pnpm test:pg`. |
| **Route conflicts.** Service-level suites now build HTTP routes. | `Auth.make` of plugins never composed together before | `Auth.make` already validates. A conflict is a real finding: fix the contract. |
| **`CredentialResolvers` freezing.** The base registry freezes on first read. | suites that contribute after build | Contributions are layers, so they register at build. `packages/server/test/CredentialResolvers.test.ts` (exempt) keeps the freeze test. |
| **Record-key rename** breaks something matching keys as strings | logs, docs, `awthaq plugin list --graph` output, tests asserting messages | Grep each old key in ticket step 1. Only Context lookups use keys. |
| **Type-level checks are slow or opaque** (`RecordsLegal` over large unions) | `pnpm typecheck` time, error messages | The Phase 0 spike measures typecheck time before and after on `packages/organization` (46 points, 7 stores). Messages use the `~missing…` property pattern already proven by `PortsComplete`. |
| **Plan 02 or 05 not landed** | `Persistence.*` or record layer names | Phase 0 precondition plus a fallback composition (§4 Phase 0). |

**Rollback.** Each ticket is one commit (or one PR per phase), and each is revertible on its own:
- Phase 1 is one breaking commit (ticket 07 + 08 together). Revert both to restore the positional signature.
- Each Phase 2 plugin commit is self-contained: keys, bundle, absorption, contract file. Reverting one plugin
  re-exposes its hand wiring requirement. Any Phase 3 suites for that plugin must be reverted with it (the ticket
  table orders them so this is local).
- Phase 3 commits are test-only.
- Phase 4's script can be removed from `check` without touching tests.

---

## 8. Interactions with other plans

| Plan | Shared seam | Order and contract |
|---|---|---|
| **02** store seam | core stores' memory/SQL implementations | **02 before 08.** 08's base is `Persistence.memory` / `Persistence.sql`. Ask 02 to give them identical `ROut` (core's own "records bundle"). If 02 exposes them as `{ memory, sql }`, `TestAuth` treats core and plugins uniformly, and `RecordsLegal` can type-check 02's pair too. 02's merged `Sessions` (incl. plan 10's `requireFresh`) needs no harness change. |
| **05** plugin table substrate | plugin record-store layers and their classes | **05 before 08.** If 05 introduces a record-store class helper, the `/records/` key segment (§3.1) goes there, and ticket step 1 becomes "adopt 05's helper". If 05 already added `Plugin.records.*`, 08 keeps 05's names and adds `RecordsLegal`/`RecordsComplete`, the TestAuth selection and the contract parity check. If 05's typed errors replace `orDie` in records, nothing here changes. 05's RLS/tenant scoping must hold in `records: "sql"` mode: a tenant-scoped TestAuth suite in ticket 37 (`TenancyWorld`) proves it. |
| **04** organization system modules | `Organization`'s records, `ConnectionRecords`, system modules used by SCIM | **04 before ticket 09.** Every record store 04 adds or splits joins `Organization.records`, and the compiler enforces it. `ConnectionRecords` is in the bundle (owned tables). 04 decides whether OAuth connections stay optional, which settles `Sso`'s `OrganizationConnectionStore` (Q1). If 04 gives SCIM a system-module service that needs its own wiring, it must be part of `Organization.layer` (or declared), not hand-wired in tests. |
| **01** sign-in / sign-up in core | new core services (`SignIn`, `SignUp`) | If 01 adds core services that plugin layers require, they belong in `Persistence.*` or the harness base. Add them to `memoryBase`/`sqlBase` in ticket 07 (or a follow-up), so no suite hand-wires them. |
| **03** erasure | `AccountErasure`, `Erasure.layer` in the base | No conflict. The base keeps `Erasure.layer`/`DataExport.layer` over the base stores. |
| **06** rate-limit budget | `RateLimits`, `RateLimiter` | `rateLimiter: "permissive" \| "enforcing"` maps to whatever 06 names its layers. |
| **07** `Verification.redeem` | none | none |
| **09** event definitions | `TestAuth.layer` provides `EventRegistry` (09 phase 5) | **08 before 09 phase 5.** 09 adds `EventRegistry` to `memoryBase`/`sqlBase` in one place. |
| **10** standalone fixes | `RetentionRegistry` via `Hooks.HooksLive` | Arrives automatically through `memoryFoundation`. If 10 adds a retention check to `runPluginContractTests`, it sits beside the records-parity check (ticket 46). Coordinate edits to `TestAuth.ts`. |

---

## 9. Acceptance checklist

- [ ] `AuthPlugin.Service` accepts `records` and `hookPoints`. `Class`/`Any` carry them. `Auth.Built.plugins` exists.
- [ ] Type tests prove all of these: a missing record store is a compile error naming its key; mismatched
      memory/sql is a compile error; a non-record service in a bundle is a compile error; an undeclared plugin hook
      point is a compile error; `records: "sql"` without `suite` is a compile error; `TestAuth.layer(Auth.make([...]))`
      has `RIn = never` for every shipped plugin composition used in a suite.
- [ ] Every record-store key contains `/records/`, and every plugin owning tables declares `records`.
      `Roles`/`UserClaims` have record stores, and their `layerSql` variants are deleted.
- [ ] `AuthHttp.middlewareFor` derives exactly the declared host middleware (tests + types).
- [ ] `TestAuth.layer(built, options)` ships with memory and SQL modes, `services` merged into the output,
      `decorate`, `taps`, `csrf`, `principalResolver`, `rateLimiter`. `TestAuth.app` and the helpers are exported
      and used.
- [ ] `TestSql` lives in `@awthaq/test`. No cross-package `support/TestSql.ts` import remains.
- [ ] Absorbed services (scim, saml, jwt, two-factor) are provided by their plugin layers. No test builds them.
- [ ] Every plugin class has a call in its package's `test/Contract.test.ts`. `pnpm check:contract-tests` is
      in `pnpm check` and was shown to fail when a call is removed.
- [ ] No `packages/*/src` outside `packages/test` imports `@awthaq/test`, and no package or example lists it in
      `dependencies`. `examples/memory-server` composes without it.
- [ ] §5.3 targets met. The numbers are recorded in `.scratch/08-test-composition/result.md` beside the baseline.
- [ ] Plugin template uses `TestAuth.layer` in both record modes. `docs/plugin-authoring.md` (table, two new
      sections, checklist 4-6) and `packages/test/README.md` are updated.
- [ ] Spec: T1-T6 appended with real ids, BEH-EA-193/198 revised, Document Control rows bumped,
      `spec/traceability.md` §1/§2/§5 updated, the BDD feature updated with allocated REQ ids, and
      `pnpm spec:verify:strict` passes.
- [ ] Changesets C1-C4 present with `Migration:` notes.
- [ ] `pnpm check`, `pnpm test:pg` and `pnpm test:bdd` are green. Test and BDD wall time are within +10 % of the
      baseline.

---

## 10. Open questions only the user can answer

- **Q1: Absorb plugin-owned derived services into plugin layers?** The candidates are `ScimAuthenticationLive`
  and `ScimConnections.layerStore`, `SamlConnections.layerStore` and `SamlSpKeys.layer`, `KeyRing.layer` and
  `SecondFactor.layer`. Absorbing them is a production-visible change: every host stops wiring them. The
  alternative is a second declared bundle (`support`) that only the harness selects. Recommendation: absorb. They
  are always required and storage-agnostic, so a host that omits one only gets a compile error to fix. Also
  decide whether `Sso`'s `OrganizationConnectionStore` is absorbed into `Organization.layer`; this depends on
  plan 04 making OAuth connections non-optional.
- **Q2: Key segment or brand?** The plan renames record keys to `<pkg>/records/<Name>`, which mirrors the
  `/ports/` convention. A key change is visible in error messages. The alternative is a type-level brand property
  on record-store classes. Recommendation: key segment, because it is one mechanism for ports and records.
- **Q3: `Roles.layerSql` and `UserClaims.layerSql`.** Should they become record stores with bundles, which
  removes the `layerSql` variants (breaking)? Or should they stay as storage-choosing plugin layers that
  `records: "sql"` cannot switch? Recommendation: record stores, so every plugin follows one convention.
- **Q4: Raw plugin tuple?** Should `TestAuth.layer` also accept `TestAuth.layer([A, B], options)`? That needs a
  way to forward `Auth.Validate<P>`, which TS cannot simplify generically (see the existing doc comment,
  `TestAuth.ts:190-203`), or a second, parallel validation. Recommendation: keep `built`.
- **Q5: Production `hookPoints`.** Should `Auth.make` also provide declared hook points in production? It would
  remove the host's `OrganizationHooksLive` line. The risk is that an app tap provided outside would bind a
  second instance and silently never run. Recommendation: no. Use the declaration for the harness and for
  `manifest` only.
- **Q6: `examples/memory-server`.** Its README says it "runs the same machinery as a real listening server". Is
  it acceptable to move it off `TestAuth` onto `Persistence.memory` plus bundles plus `middlewareFor`, keeping
  the same behaviour but dropping the harness dependency?
- **Q7: Make `build` mandatory in contract tests?** It proves every plugin composes in both modes, but each
  package must supply its adapters. Recommendation: opt-in, used everywhere it is cheap.
- **Q8: `RedactionGuard` always on?** EOTS-002 puts it in every `TestAuth` composition. With roughly five times
  more suites on the harness, should there be a `redactionGuard: false` escape hatch for runtime, or should it
  stay mandatory? Recommendation: keep it mandatory unless Phase 3 measurements exceed the budget.
- **Q9: Flip all suites to SQL in `pnpm test:pg`?** An env switch (`AWTHAQ_TEST_RECORDS=sql`) could make every
  `TestAuth.layer` without an explicit `records` run over Postgres, with an auto-generated `suite` per layer
  build. That would mean full-suite SQL coverage. It is richer, but it would multiply `test:pg` time.

---

## Decisions taken (implementation record)

Executed on `architecture/deepening-plans` after plans 01-07 and 09 (commit history: `git log --grep 'plan 08'`). `pnpm test:pg` could not be run (Docker unavailable): every SQL-mode case ran over SQLite here, and the new SQL-mode suites (`TestAuthRecords`, the plugin template) are added to `scripts/test-pg.sh`.

### Open questions: the recommended default was taken

| Q | Decision |
|---|---|
| Q1 | **Absorb**, where it is possible: `SamlConnections.layerStore` and `SamlSpKeys.layer` into `Saml.layer`; `ScimAuthenticationLive` and `ScimConnections.layerStore` into `Scim.layer`; `KeyRing.KeyRing.layer` into `Jwt.layer`, each by `AuthPlugin.layer(...).pipe(Layer.provideMerge(derived))` so it stays in `ROut`. **Not absorbed**: `SecondFactor.layer` (the two gates a host provides beneath the plugin require `SecondFactor` themselves, so they would have nothing to read it from: plan error), and Sso's `OrganizationConnectionStore` (`Organization.layer` does not require `ConnectionRecords`: OAuth connections stay optional, so the host composes `OrganizationConnections.layerStore`). |
| Q2 | **Key segment**: every record store is keyed `<pkg>/records/<Name>`; `RecordKeysOf` reads it like `PortKeysOf` reads `/ports/`. |
| Q3 | **Record stores**: new `RoleAssignments` (`awthaq/roles/records/RoleAssignments`) and `UserClaimsRecords` (`awthaq/qadi/records/UserClaims`); `Roles` and `UserClaims` are written once over them and `layerSql` is deleted from both. |
| Q4 | **Keep `built`** as `TestAuth.layer`'s first parameter. |
| Q5 | **No**: `Auth.make` does not provide declared hook points in production; the declaration serves the harness and the manifest. |
| Q6 | **Yes**: `examples/memory-server` composes `Persistence.memory`, each plugin's `records.memory` and `hookPoints` and `AuthHttp.middlewareFor`, and no longer depends on `@awthaq/test` (it now runs the production-cost hasher). `examples/sql-server` uses `middlewareFor` too. |
| Q7 | **Opt-in** `build: { services }`, used by 12 plugin packages (admin x3, api-key, device-authorization, jwt, magic-link x2, oauth, organization, passkey, password, qadi, roles (not `RolesAdmin`), scim, two-factor, webhooks). Saml/Sso and `RolesAdmin` opt out (they need adapters the suites build: an XML-signature adapter and a metadata fetcher; a host-built `RequirePermission`). |
| Q8 | **Mandatory** `RedactionGuard`; no escape hatch: the measured suites stayed within budget. |
| Q9 | **No** `AWTHAQ_TEST_RECORDS` switch: no caller needs it yet (speculative infrastructure); `TestAuth.recordModes` and `records: "sql"` are the per-suite dial. |

### Deviations from the plan's text

- **Phase 0 spikes** became the permanent type tests (`AuthPlugin.records.types.test.ts`, `MiddlewareFor.types.test.ts`) in the same commit as Phase 1; no separate baseline commit. `Class` takes `Records` and `Points` after `Limits` (the plan's order predates plan 06's `Limits`). `records`/`hookPoints` infer without an assertion through an overloaded local function declaration inside `Service` (the implementation signature is the widened one), not through two overloads of `Service` itself.
- `RecordsLegal` is intersected on the options object, not on the `records` property: the property form did not infer.
- **`MemoryEnvelopes`** (the sealed stores' test seam) is projected out of the bundles (`Layer.effect(Store, Effect.service(Store)).pipe(Layer.provide(layerMemory))`); a suite that plants envelopes adds the `layerMemory` itself to `services` (the same layer object, one instance).
- `AuthHttp.middlewareFor` builds each derived layer with `Layer.fresh`: the module-level `...Live` constants are memoized by reference, so a test that also built one over its own config shared whichever instance was built first (found by the CSRF BDD world). Its `csrf` option may fail with `ConfigError` (`Csrf.layerConfig`).
- `TestAuth.layer`'s base also provides `AuditChain` (`Admin`'s records read it); `TestAuth.app` takes `{ baseUrl }`; `csrfToken` takes `{ issuedAt }` (a suite under `TestClock` mints at 0).
- **Bundle tests**: the per-plugin `describe.each(recordModes)` over the store suites was not written; the matched-pair guarantee is the compile-time `RecordsLegal`/`RecordsComplete` plus the contract suite's runtime parity check (`runPluginContractTests`), which builds both bundles for every plugin, and the existing per-store suites (unchanged).
- `NoteRecords.layerMemory` already existed (plan 05), so the template only gained the declaration and the key rename. The contract-test files were created in Phase 4 in one commit, not per plugin in Phase 2.
- **Coverage**: moving `TestSql` into `@awthaq/test`'s `src` put its Postgres-only branches inside `vitest.config.ts`'s coverage `include`; the file is excluded there (it only executes under `pnpm test:pg`). `CookieAssertions.ts` (`@awthaq/test`'s `src`, exercised by other packages only through the built `lib`, so 0% in its own package) got a direct suite. The global branch floor (83%) already read 82.71% at the password-coverage fix (before this plan's first commit) and reads 83.14% after.
- `scripts/check-contract-tests.mjs` reads `AWTHAQ_CONTRACT_TESTS_ROOT` so its BDD scenario can run it against a throwaway tree.

### Plan errors found during Phase 3

- **`services` vs the base.** The plan says `services` override the base. They shadow it only for the plugins: for a key both provide, the base instance wins in the output, so a test reading the service sees the base's. A suite that must replace a base service for the test too uses `decorate`; replacing a layer the base already built on the shared memo map needs `Layer.fresh` (the password rehash suites: `decorate: Layer.orDie(Layer.fresh(PasswordHasher.layerArgon2id))`).
- **Roles guard ordering.** `RequirePermission` reads the `SubjectResolver` slot when it is built, so a suite that overrides the slot must build the guard above `Roles.layer`; `TestAuth.layer` cannot order that, so those suites are exemptions, not migration candidates.
- **`TestClock` vs `TestAuth.app`.** `app.run` runs on a separate fiber on the real clock. A BDD scenario whose direct steps adjust the step's `TestClock` (the device-authorization and domain expiry scenarios, OAuth flow TTLs) keeps a built context and `HttpRouter.toWebHandler` on one memo map instead.
- **Migration numbering is global.** `Auth.make` numbers every plugin's migrations in one list, so a migration inserted into a non-last plugin shifts the later ids; a backfill test therefore runs the two `up`s through `Migrations.run([m], { table })`.
- **`PrincipalResolver` was not in `TestAuth.layer`'s output**, so every suite that called `Authentication.resolvePrincipal` hand-built `PrincipalResolverLive`. The output now carries it (changeset `test-auth-exposes-principal-resolver`).
- **Declaration emit.** The BDD `features` project emits declarations, so a World that exports a layer over the organization plugin needs the namespaces its inferred type mentions in scope (`OrganizationServiceNames`, the pre-existing trick).

### What was not done

- **Phase 3 is complete except the documented exemptions and the shrinkage numbers below.** Every plugin suite and every BDD World that composes plugins now goes through `TestAuth.layer`/`TestAuth.app`. `OrganizationMemory` (module, test and root export) is deleted (changeset `remove-organization-memory`), `CsrfTestSupport.ts` is now `shared/Csrf.ts` (no hand-built `CsrfConfig`; the token is `TestAuth.csrfToken`) and `TestServices` is deleted from `shared/Harness.ts` (the five hand-wired Worlds that needed it use `HttpServer.layerServices`, which is what `TestAuth` itself uses). `cheapArgon2id`/`cheapScrypt` stay: three hand-wired Worlds and `PasswordSteps` still pass them.
- **Shrinkage (before Phase 3 continuation -> now; target):** files building `PrincipalResolverLive` 75 -> 20 (12); `CsrfProtectionLive` 47 -> 13 (8); hand-built memo maps 30 -> 14 (4); `createHmac("sha256"` CSRF mints 16 -> 10 (2); `Layer.succeed(Csrf.CsrfConfig` 12 literals (8); files using `TestAuth.layer(` 37 -> 97 (90, met); layer-wiring calls in the BDD worlds 380 (380, met); layer-wiring calls under `packages/*/test` 1,563 (1,300, not met). **The 12 / 8 / 4 / 2 / 8 / 1,300 targets are not met.** What is left is hand-wired on purpose, each file headed `// Hand-wired on purpose: ... (plan 08 exemption).`: the server package's own suites (`@awthaq/server` sits below `@awthaq/test`, so its suites cannot import the harness: `AuthHttp`, `Authentication`, `Csrf`, `Cors`, `CredentialResolvers`), the middleware-under-test Worlds (`AuthenticationWorld`, `CsrfWorld`, `ContractStratumWorld`'s probe app, `SessionServer` with a real socket, the cli `TestServer`), the Roles-guard-above-`Roles.layer` cases (`RolesAdmin`, `QadiBridgeWorld`, `TestingHarnessWorld`, `SubjectExtractor`), the one-memo-map-for-handler-and-`ManagedRuntime` cases (`NextSsrWorld`, `GetSession`, the web `Session`/`InProcessClient` suites, `HttpErrorWorld.makeRuntimeAndRouted`), `TenancyWorld` (three stacks on separate memo maps on the real clock), `AdminTier` (public-API-only), `JwtIntrospection` (no `Sessions`), `BearerReentry` (no registry), and `saml/Sso.test.ts` (one hand-built router). `packages/sql/test/fixtures/readme-quickstart.ts` is not headed: a test asserts it equals the README verbatim. Getting to 12 needs either `@awthaq/test` below `@awthaq/server` or those suites moved to a package above both; neither was a safe unrequested change.
- **Wall clock** (this machine, warm cache): `pnpm test` 42 s, `pnpm test:bdd` 10 s. The previous agent measured `pnpm test` at about 90 s before and after; the baseline taken at the start of this continuation was about 61 s, so the suite is not slower. The `.scratch/08-test-composition/baseline.md`/`result.md` files were not written (nothing under `.scratch/` is committed); the numbers above are the record.
- **`pnpm test:pg` could not be run** (no Docker).
