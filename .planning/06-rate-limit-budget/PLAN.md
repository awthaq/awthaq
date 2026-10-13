# 06 — A rate-limit budget in core: register rules once, spend by name

| | |
|---|---|
| Strength | Strong (duplication; six copied wrappers, three copied rule modules, eight copied registration blocks) |
| Dependency category | local-substitutable (the `RateLimiter` port is unchanged; the memory and SQL stores are untouched) |
| Wave | A (independent). **Must land before 01**: README "06 before 01" |
| Fixes live bugs | none listed in the README. This plan does close nine smaller defects (§2.5 D1–D9). |
| Tracking | `.scratch/06-rate-limit-budget/issues/NN-*.md`, one ticket per phase in §4 (`01-spike.md` … `12-cleanup.md`) |
| Verified against | `main` at `38bcd1b` (2026-10-13). Every `file:line` below was read for this plan. |

Vocabulary: **module, interface, implementation, depth, seam, adapter, leverage, locality** (codebase-design glossary).
Domain terms: `spec/glossary.md`, `spec/overview.md`.

---

## 1. Summary, goals, non-goals

### Summary

Today every credential plugin carries its own copy of the same small machine. It has a rule table, a `Rule<I>`
type with `keyOf`/`registryKey`/`metaOf`/`registryEntries`, a registration loop with the same "annotated to break
the inference cycle" comment, and a wrapper that calls `RateLimits.enforce`, provides `RateLimiter` and
`AuthEvents`, and maps `RateLimitExceeded` onto `Api.RateLimited`. Seven more call sites inline the same wrapper
(OAuth ×3, ApiKey ×2, SAML ×4, Webhooks, server account export). Core already has an unused generic path
(`RateLimits.rule`, `enforceRule`, `bucketKey`, `registerDeclared`); only device-authorization uses
`registerDeclared`, and no plugin uses `enforceRule`.

This plan makes the rate-limit **module** deep. A plugin's **interface** to it shrinks to two things:

1. **Declare once.** A typed table of rules on the plugin class:
   `AuthPlugin.Service(id, { rateLimitRules: { signIn: RateLimits.rule({...}), ... } })`. The static
   `rateLimits` declaration that `awthaq plugin list --rules` prints is *derived* from this table.
2. **Spend by name.** Inside `make`: `const limits = yield* RateLimits.budget(Self, { tune })`, then
   `yield* limits.spend(["signInByIp", "signIn"], input)`. The compiler checks the names and the input shape.

All of the following moves behind the **seam**, written once in core:

- registration
- bucket-key derivation, including one email normaliser
- event, log and metric publication
- the wire-error mapping
- per-call tuning, including the tenant config in force
- application overrides (`RateLimits.overrides`)
- the failure-budget pair `guard`/`charge`

Drift between what is declared and what is registered becomes impossible by construction:

- **Undeclared rules.** The budget can only register and spend the owner's own declared table, and that is a type
  error to get wrong.
- **Declared but never registered.** `AuthPlugin.layer` refuses at build any plugin that declares rules but never
  opens its budget.

The inference cycle is solved once. `budget` takes a narrow `RateLimits.Owner` interface that has no `layer` member,
the same move `AuthPlugin.layer` already makes with `Class<Self, …>`. A scratch reproduction of the cycle and of the
fix is in §3.9.

### Goals

- G1. One `Rule<Group, I, Mode>` in core whose key strategy is narrowed with `Schema` (no `as`, no `any`). This
  replaces `PasswordRule<I>` (`password/src/PasswordRateLimits.ts:48-90`), `TwoFactorRule<I>`
  (`two-factor/src/TwoFactorRateLimits.ts:24-61`), `Rule<I>` (`magic-link/src/RateLimitRules.ts:16-53`), device's
  `Budget<Input>` (`device-authorization/src/DeviceAuthorization.ts:255-273`), and passkey's `RATE_LIMITS`
  (`passkey/src/Passkey.ts:429-472`).
- G2. One budget **implementation** in `@awthaq/core` (`RateLimits.budget`/`budgetOf`). It replaces the 17
  `RateLimits.enforce(...).pipe(provideService, provideService, catchTag)` sites (§2.3).
- G3. The static declaration is derived from the same table the budget registers. The per-plugin
  `RateLimitDeclaration` drift tests (seven files, §5.3) are deleted. A build-time guard in `AuthPlugin.layer` plus
  type-level name checking replace them.
- G4. One email key normaliser, `RateLimits.Key.emailKey`. It replaces `PasswordRateLimits.defaultEmailRateKey`,
  `Channel.emailRateKey`, and passkey's bare `.toLowerCase()`. `RateLimits.phoneKey` becomes `RateLimits.Key.phone`.
- G5. Rich application overrides. Every shipped rule's limit, window and escalation can be tuned per application or
  per tenant: `RateLimits.overrides(RateLimits.tune(Password, { signIn: { limit: 3 } }))`. The plugin-specific
  knobs that exist today keep working and feed the same path.
- G6. The rules that are enforced today but never declared become declared and registered: SAML
  `login`/`acs`/`slo`/`admin`, SSO `start`, Webhooks `admin`, and the server account export. BEH-EA-111
  introspection then shows everything that is enforced.
- G7. The "annotated to break inference cycle" comment and its explicit `Effect.Effect<…>` annotation are deleted
  from all eight sites (§2.4).

### Non-goals

- N1. The `RateLimiter` port, its stores (`layerStoreMemory`, `RateLimiterStoreSql`), `RateLimiterConfig`
  fail-open/closed, escalation arithmetic and `layerPermissive` are **unchanged** (`ports/src/RateLimiter.ts`).
- N2. Webhook **delivery pacing** stays a raw `limiter.consume` (`webhooks/src/WebhookDelivery.ts:162-172`). It is
  outbound shaping that defers a delivery, not a request throttle, and it publishes nothing (Q8).
- N3. `SecondFactor`'s failure budget keeps its own semantics: `SecondFactorLocked`, `auth.twoFactor.locked`, and no
  `auth.rateLimit.exceeded`. Only its bucket key comes from the shared rule (§3.12.3, Q5).
- N4. No new rate limits on admin, organization, SCIM, JWT or roles. These have none today; verified by grep. Q9
  asks the user.
- N5. The order of rate-limit checks against the sign-in timing floor does not change. Rate limits run before
  `withTimingFloor` (`password/src/Password.ts:1147-1150`), and a 429 is keyed independently of whether the
  account exists. The server has no timing floors (`grep -i timing packages/server/src` finds none). The only
  floor is `Password.withTimingFloor` (`Password.ts:907-926`).
- N6. The `auth.rateLimit.exceeded` schema (`core/src/AuthEventSchemas.ts:806-818`) is unchanged. Plans 09 and 10
  change how events are defined and delivered; §8 covers that.

---

## 2. Verified inventory

### 2.1 Core today

| What | Where | Callers in `packages/*/src` |
|---|---|---|
| `RateLimitKey = "principal" \| "ip" \| fn` | `core/src/RateLimits.ts:64-65` | registry entries only |
| `RuleInput` | `RateLimits.ts:67-76` | password, two-factor, magic-link, passkey, oauth, api-key, device (via `register`) |
| `RateLimitScopeViolation`, `RateLimitsFrozen` | `RateLimits.ts:78-88` | all eight `orDie` it |
| `RegisteredRule`, `RateLimitsRegistryShape`, `RateLimitsRegistry` | `RateLimits.ts:90-107` | `register` from 8 plugins; `registered` read by **no src**, only tests + BDD |
| `layer` (registry) | `RateLimits.ts:109-162` | TestAuth (`test/src/TestAuth.ts:140`), apps |
| `rule(owner, input)` (Layer form) | `RateLimits.ts:172-178` | **none** (core test + BDD `RegistriesSteps.ts:858-900`) |
| `registerDeclared(owner, {key, tune})` | `RateLimits.ts:188-215` | device only (`DeviceAuthorization.ts:762-771`) |
| `DeclarationDrift`, `declarationDrift` | `RateLimits.ts:217-266` | tests only (7 plugin tests + `core/test/PluginDeclarations.test.ts:127-167`) |
| `exceededCounter` | `RateLimits.ts:268-272` | `enforce` |
| `EnforceMeta`, `EnforceInput`, `enforce` | `RateLimits.ts:274-328` | 17 sites, §2.3 |
| `phoneKey` (SOS-007) | `RateLimits.ts:344-354` | **none** (core test only; doc refs `ports/src/SmsSender.ts:11`, `spec/overview.md:124`) |
| `bucketKey` (ambient `"principal"`/`"ip"`) | `RateLimits.ts:356-417` | **none** (core test + BDD `RateLimitingSteps.ts:640-643`) |
| `enforceRule` | `RateLimits.ts:419-488` | **none** |
| `RateLimitDimension`, `RateLimitDeclaration` | `core/src/AuthPlugin.ts:112-131` | all plugins |
| `declareRateLimits(groups, rules)` (throws at module load) | `AuthPlugin.ts:133-162` | password, two-factor, magic-link ×2, passkey, device |
| `Service` `rateLimits` option (group confined at type level) | `AuthPlugin.ts:287-292`, assigned `:323` | all declaring plugins |
| `Class.rateLimits`, `Any.rateLimits?` | `AuthPlugin.ts:93-94`, `:206-207` | manifest |
| `Manifest.rateLimits` | `core/src/Auth.ts:314-319`, built `:677-679` | CLI `cli/src/Plugin.ts:126-150` (`plugin list --rules`) |
| `RateLimitExceededEvent` | `core/src/AuthEventSchemas.ts:806-818`; audited actor-less `core/src/AuditLog.ts:243` | `enforce`, device `assertBudget` |
| `AuthRequestContext` (`ip: Option<string>`, a `Context.Reference`) | `core/src/AuthRequestContext.ts:17-34`, populated by `server/src/RequestContext.ts:40-71` (optional middleware) | `AuthEvents.publish` stamps `ip` (`core/src/AuthEvents.ts:211-224`) |
| `ClientAddress` port | `ports/src/ClientAddress.ts:48-62` | handlers resolve the IP and pass `ip` into service methods (e.g. `Password.ts:480-650`) |
| `RateLimiter` port: `consume`/`check`/`permissive` | `ports/src/RateLimiter.ts:85-106` | unchanged (N1) |
| `RateLimiterConfig` (`onStoreUnavailable`) | `RateLimiter.ts:127-149` | unchanged |

**Circular-import constraint.** `RateLimits.ts:60` already does `import type * as AuthPlugin`, and
`scripts/circular.mjs` fails on type-only cycles too (pass 2). So `AuthPlugin.ts` **cannot** import
`RateLimits.ts`. The design in §3.1 adds leaf modules for this reason.

### 2.2 Every rule in every plugin

Columns:

- **Name**: what `EnforceMeta.rule` and the event report.
- **Dim**: the dimension label.
- **Key today**: the bucket string that enforcement consumes.
- **Registered key**: what the registry records; ≠ marks a mismatch.
- **Mode**: `att` means consume on every call. `fail` means check before and charge on failure (BCR-006).

#### Password (`group: password` unless marked `.account`)

Rules: `PasswordRateLimits.ts:105-316`. Declared: `Password.ts:700-705`. Registered: `Password.ts:865-880`. Wrapper:
`Password.ts:928-953`. Configurable: only the email normaliser, `PasswordConfig.rateLimitEmailKey`
(`Password.ts:86-92`, default `:141`). It is also used for the CSD-004 identifier digest (`:807-812`).

| Name | Endpoint | Dim | Key today | Default | Enforced at |
|---|---|---|---|---|---|
| signUp | signUp | identity | `password:signup:<emailKey>` | 5 / 1h | `Password.ts:995` |
| signUpByIp | signUp | ip | `password:signup:ip:<ip\|unknown>` | 20 / 1h | `:994` |
| signIn | signIn | identity | `password:signin:<emailKey>` | 5 / 15m | `:1148` |
| signInByIp | signIn | ip | `password:signin:ip:…` | 30 / 15m | `:1147` |
| requestReset | requestReset | identity | `password:reset-request:<emailKey>` | 5 / 15m | `:1262` |
| requestResetByIp | requestReset | ip | `password:reset-request:ip:…` | 30 / 15m | `:1261` |
| confirmReset | confirmReset | identity | `password:reset-confirm:<publicId>` | 5 / 15m | `:1350` |
| changePassword (.account) | changePassword | identity | `password:change-password:<userId>` | 5 / 15m | `:1629` |
| reauthenticate (.account) | reauthenticate | identity | `password:reauthenticate:<userId>` | 5 / 15m | `:1684` |
| resendVerification | resendVerification | identity | `password:resend-verification:<emailKey>` | 3 / 15m | `:1323` |
| resendVerificationByIp | resendVerification | ip | `…:ip:…` | 20 / 15m | `:1322` |
| verifyEmail | verifyEmail | identity | `password:verify-email:<publicId>` | 5 / 15m | `:1476` |
| verifyEmailByIp | verifyEmail | ip | `…:ip:…` | 30 / 15m | `:1468` |
| changeEmail (.account) | changeEmail | identity | `password:change-email:<userId>` | 5 / 1h | `:1528` |
| changeEmailTarget (.account) | changeEmail | identity | `password:change-email-target:<emailKey(newEmail)>` | 3 / 15m | `:1529` |
| confirmEmailChange | confirmEmailChange | identity | `password:change-email-confirm:<publicId>` | 5 / 15m | `:1564` |
| confirmEmailChangeByIp | confirmEmailChange | ip | `…:ip:…` | 30 / 15m | `:1558` |

All modes are `att`. Registered key = enforced key (one table, RBS-006). The inert key for wrong-shape input is
`password:<name>:unknown` (`PasswordRateLimits.ts:84-88`).

#### Two-factor

Rules: `TwoFactorRateLimits.ts:66-97`. Declared: `TwoFactor.ts:420-424`. Registered: `TwoFactor.ts:462-473`.
Wrapper: `TwoFactor.ts:475-492`.

| Name | Group.endpoint | Dim | Key today | Default | Mode | Enforced at |
|---|---|---|---|---|---|---|
| verifyByIp | two_factor.verify | ip | `two_factor:verify:ip:…` | 30 / 15m | att | `TwoFactor.ts:566` |
| manageByUser | two_factor.account.**manage** (not a real endpoint: covers enable/confirm/disable/regenerateRecoveryCodes) | principal | `two_factor:manage:<userId>` | 20 / 15m | att | `:595` (enable), `:615` (confirm), `:640` (disable/regenerate helper) |
| failureBudget | two_factor.verify | identity | `two_factor:fail:<userId>` (`SecondFactor.ts:133-134`) | `TwoFactorConfig.failureLimit` 5 / `failureWindow` 15m (`TwoFactorConfig.ts:37-54`) | fail | **in `SecondFactor.ts:152-185`**: `limiter.check`→`SecondFactorLocked`; `limiter.consume().ignore`; publishes `auth.twoFactor.challengeFailed`/`.locked`, never `auth.rateLimit.exceeded` |

#### Magic link (group `magicLink`)

Rules: `MagicLink.ts:92-134`. Declared: `:228`. Registered: `:248-258`. Wrapper: `:260-277`.

| Name | Endpoint | Dim | Key today | Default | Enforced at |
|---|---|---|---|---|---|
| requestByIp | request | ip | `magic-link:request:ip:…` | 30 / 15m | `MagicLink.ts:283` |
| requestByEmail | request | identity | `magic-link:request:email:<Channel.emailRateKey>` | 5 / 15m | `:284` |
| verifyByIp | verify | ip | `magic-link:verify:ip:…` | 30 / 15m | `:324` |
| verifyByToken | verify | identity | `magic-link:verify:<publicId>` | 5 / 15m | `:337` |

#### Email OTP (group `emailOtp`)

Rules: `EmailOtp.ts:93-135`. Declared: `:233`. Registered: `:251-258`. Wrapper: `:259-276`.

| Name | Endpoint | Dim | Key today | Default | Enforced at |
|---|---|---|---|---|---|
| requestByIp | request | ip | `email-otp:request:ip:…` | 30 / 15m | `EmailOtp.ts:283` |
| requestByEmail | request | identity | `email-otp:request:email:<emailRateKey>` | 5 / 15m | `:284` |
| verifyByIp | verify | ip | `email-otp:verify:ip:…` | 30 / 15m | `:316` |
| verifyByEmail | verify | identity | `email-otp:verify:email:<emailRateKey>` | 10 / 15m | `:317` |

None of the magic-link or email-OTP limits can be configured.

#### Passkey (group `passkey.authenticate`)

Table: `Passkey.ts:429-460`. Declared: `:1021-1030`. Registered: `:1131-1179`. Wrapper: `:1181-1199`. Nothing can
be configured.

| Name | Endpoint | Dim | Key today | Registered key | Default | Enforced at |
|---|---|---|---|---|---|---|
| authenticateOptionsByIp | authenticateOptions | ip | `passkey:authenticate-options:ip:…` | **≠** built-in `"ip"` | 60 / 15m | `Passkey.ts:1450-1453` |
| authenticateOptionsByEmail | authenticateOptions | identity | `passkey:authenticate-options:<email.toLowerCase()>` (no trim, **no `+tag` strip**) | fn via `emailFromRateLimitInput` (`:469-472`) | 10 / 15m | `:1454-1459` (only when `email` given) |
| authenticateVerifyByIp | authenticateVerify | ip | `passkey:authenticate-verify:ip:…` | **≠** `"ip"` | 60 / 15m | `:1526-1529` |

#### Device authorization

Budgets: `DeviceAuthorization.ts:253-341`. Config: `:76-127`. Declared: `:715-718` (declaration of `makeBudgets(defaultConfig)`).
Registered: `registerDeclared` at `:757-771`. Helpers: `spend` `:773-787`, `assertBudget` `:789-805`, `charge` `:808-812`.

| Name (today) | Group.endpoint | Dim | Key today | Registered key | Default (config knob) | Mode | Enforced at |
|---|---|---|---|---|---|---|---|
| code-ip | device_authorization.code | ip | `device:code:ip:…` | **≠** `"ip"` | 5/15m (`codeRateLimit.ip`) | att | `:883` |
| code-client | device_authorization.code | custom | `device:code:client:<clientId>` | **≠** `device:code-client` | 600/15m (`codeRateLimit.client`) | att | `:890` |
| token-invalid-ip | device_authorization.token | ip | `device:token-invalid:ip:…` | **≠** | 50/15m (`invalidGrantRateLimit`) | fail | `:1097` guard, `:1099` charge |
| verify-ip / approve-ip / deny-ip | `.verification.verify`, `.decision.approve`, `.decision.deny` | ip | **one shared** `device:user-code:ip:…` | **≠** | 5/15m (`userCodeRateLimit.ip`) | fail | `:947` guard, `:951` charge |
| verify-session / approve-session / deny-session | same three | principal | **one shared** `device:user-code:session:<sid>` | **≠** | 5/15m (`userCodeRateLimit.session`) | fail | `:949`, `:953` |

#### OAuth

Declared by hand from `defaultRateLimits` (`OAuthConfig.ts:121-126`) at `OAuth.ts:703-727`. Registered separately at
`:831-882`. Enforced inline. Config: `OAuthConfig.rateLimits` is merged partially (`OAuthConfig.ts:118`, `:159`) and
read per request through `configNow` (`OAuth.ts:753`, EP-007). The registry records boot values.

| Name | Group.endpoint | Dim | Key today | Registered key | Default | Enforced at |
|---|---|---|---|---|---|---|
| callback | oauth.callback | ip | `oauth:callback:<ip>` (no `ip:` segment) | **≠** `"ip"` | 20 / 1m | `OAuth.ts:992-1005` |
| authorize | oauth.authorize | ip | `oauth:authorize:<ip>` | **≠** | 30 / 1m | `:905-919` |
| token | oauth.exchange.token | ip | `oauth:token:<ip>` | **≠** | 20 / 1m | `:1465-1477` |

#### API key

Declared by hand at `ApiKey.ts:694-718`. Registered separately at `:758-797`. Config: `ApiKeyConfig.tokenRateLimit`
and `resolveRateLimit` (`:105-110`, defaults `:119-123`), read at boot.

| Name (today) | Group.endpoint | Dim | Key today | Registered key | Default | Enforced at |
|---|---|---|---|---|---|---|
| token-ip | apikey.token.token | ip | `apikey:token:ip:…` | **≠** `"ip"` | 60 / 1m | handler `ApiKey.ts:557-562` (helper `:535-548`) |
| token-client | apikey.token.token | custom | `apikey:token:client:<clientId>` | **≠** `apikey:token:client:${String(input)}`, which is `[object Object]` for any object (`:780`) | 30 / 1m | `:580-585` |
| resolve-ip | apikey.**resolve** (credential resolver, not an endpoint) | ip | `apikey:resolve:ip:…` | **≠** | 3000 / 1m | `CredentialContributionsLive` `:618-633`; a refusal becomes `Api.Unauthenticated` (`:640-642`) |

#### SAML and SSO (`@awthaq/saml`)

**Not declared, not registered.** Config: `SamlConfig.rateLimits` is replaced **as a whole object**
(`SamlConfig.ts:40-48`, default `:132-137`), plus `adminRate` (`:72`, default `:144`).

| Name | Group.endpoint | Dim | Key today | Default | Enforced at |
|---|---|---|---|---|---|
| login | saml.login | ip | `saml:login:<ip>` | 30 / 1m | `Saml.ts:742` (helper `:690-704`) |
| acs | saml.acs | ip | `saml:acs:<ip>` | 30 / 1m | `:1068` |
| slo | saml.slo (covers `slo` + `sloPost`) | ip | `saml:slo:<ip>` | 30 / 1m | `SamlSlo.ts:373` (helper `:114-127`, dep `limiter` `:107`) |
| admin | saml.admin.`<action>` (dynamic) | principal | `saml:admin:<userId>` | 60 / 1m | `SamlAdmin.ts:146-158` |
| start (Sso plugin) | sso.start | ip | `sso:start:<ip>` | 30 / 1m (`rateLimits.sso`) | `Sso.ts:236-249` |

#### Webhooks

**Not declared, not registered.**

| Name | Group.endpoint | Dim | Key today | Default | Enforced at |
|---|---|---|---|---|---|
| admin | webhooks.admin.`<action>` | principal | `webhooks:admin:<userId>` | `adminRate` 60 / 1m, read per request (`Webhooks.ts:432-433`) | `Webhooks.ts:453-470` |
| (delivery pacing) | — | — | `webhooks:deliver:<endpointId>` | `deliveryRate` 300 / 1m | `WebhookDelivery.ts:162-172`, raw, out of scope (N2) |

#### Server (core HTTP `account` group)

**Not declared, not registered.**

| Name | Group.endpoint | Dim | Key today | Default | Enforced at |
|---|---|---|---|---|---|
| exportData | account.exportData | principal | `account:export:<userId>` | 5 / 1h (constant `server/src/Account.ts:50`) | `Account.ts:141-157` |

**No rate limits** in admin, organization, scim, jwt, roles, qadi, next, web or client.

### 2.3 Every wrapper: the 17 `enforce` sites and their wire mapping

Each site below does the same thing: `RateLimits.enforce({...}).pipe(Effect.provideService(RateLimiter…),
Effect.provideService(AuthEvents…), Effect.catchTag("RateLimitExceeded", → Api.RateLimited))`. That is 17
`provideService(RateLimiter.RateLimiter` occurrences, counted by grep:

1. `password/src/Password.ts:936-953` (`rateLimit<I>`)
2. `two-factor/src/TwoFactor.ts:475-492`
3. `magic-link/src/MagicLink.ts:260-277`
4. `magic-link/src/EmailOtp.ts:259-276`
5. `passkey/src/Passkey.ts:1181-1199`
6. `device-authorization/src/DeviceAuthorization.ts:773-787` (`spend`)
7. `DeviceAuthorization.ts:789-805` (`assertBudget`). This copy calls `limiter.check` and publishes the event by hand. It does **not** log or count the breach.
8. `oauth/src/OAuth.ts:905-919`
9. `OAuth.ts:992-1005`
10. `OAuth.ts:1465-1477`
11. `api-key/src/ApiKey.ts:535-548` (handler-local `enforce`)
12. `ApiKey.ts:621-632` (resolve `throttle`). No `catchTag` here; it is mapped to `Unauthenticated` at `:642`.
13. `saml/src/Saml.ts:690-704`
14. `saml/src/SamlSlo.ts:114-127`
15. `saml/src/SamlAdmin.ts:146-158`
16. `saml/src/Sso.ts:236-249`
17. `webhooks/src/Webhooks.ts:453-470`
18. `server/src/Account.ts:141-157`

Sites 7 and 12 are variants of the pattern, which is why there are 18 entries for 17 counted sites.

Two raw-port users stay as they are: `two-factor/src/SecondFactor.ts:160-185` (N3) and
`webhooks/src/WebhookDelivery.ts:162-172` (N2).

### 2.4 The copied registration blocks ("inference cycle")

These eight sites each pass `Self` to `registry.register(owner: AuthPlugin.Any, …)` or to
`registerDeclared(owner: AuthPlugin.Any, …)`. `Any` requires `layer`, so each site carries an explicit
`Effect.Effect<…>` annotation and a comment:

| Site | Comment | Annotation |
|---|---|---|
| `Password.ts:873-880` | `:874-875` | callback `(entry): Effect.Effect<void, RateLimits.RateLimitScopeViolation>` |
| `TwoFactor.ts:466-473` | `:467-468` | same |
| `MagicLink.ts:251-258` | `:252-253` | same |
| `EmailOtp.ts:251-258` | `:252-253` | same |
| `Passkey.ts:1131-1179` | `:1145-1149` | same |
| `OAuth.ts:843-882` | `:843-850` | `const registerRateLimitRules: Effect.Effect<…>` |
| `ApiKey.ts:758-797` | `:758-764` | same |
| `DeviceAuthorization.ts:757-771` | `:760-761` | `Effect.Effect<void, …, RateLimitsRegistry>` |

All eight end in `Effect.orDie`.

### 2.5 Divergences between the copies

- **D1. Three email normalisers.**
  - Password's `defaultEmailRateKey` lower-cases only (`PasswordRateLimits.ts:39-46`).
  - Magic-link's `Channel.emailRateKey` trims *and* lower-cases (`Channel.ts:33`, `:41-48`).
  - Passkey lower-cases but does **not** strip `+tag` (`Passkey.ts:1457`, `:1166`). So `victim+1@x.com` …
    `victim+N@x.com` each get a fresh passkey options budget. That violates TMS-006 / BEH-EA-108 ("SHOULD be
    normalized so subaddressed aliases share one bucket").
  - So the brief's claim that `Channel.emailRateKey` and `defaultEmailRateKey` are the same function is false:
    they differ by `.trim()`.
- **D2. The registry key differs from the enforced key** in passkey, OAuth, API key and device (tables above).
  BEH-EA-111 says "the runtime registry remains the source of truth for what is enforced", but for these four it
  is not. Two further faults sit inside this one:
  - API key's `token-client` registry key stringifies the whole input object (`ApiKey.ts:780`).
  - Device's registry keys come from `registerDeclared`'s generic fallbacks.
- **D3. Three inert-key spellings:** `password:<name>:unknown`, `two_factor:<name>:unknown`,
  `<group>:<name>:unknown`. Core's `phoneKey` and `bucketKey` use `invalid` and `unknown` buckets.
- **D4. Rule-label conventions are mixed:**
  - camelCase: password, two-factor, magic-link, passkey
  - kebab-case: device `code-ip`, API key `token-ip`
  - endpoint-as-name: OAuth, SAML, SSO
  - `${group}.${endpoint}`: `enforceRule`, `RateLimits.ts:362`
  - the literal `"admin"`: SAML, Webhooks
- **D5. The same key gets different dimension labels.**
  - Keys on `userId` are labelled `identity` in password `changePassword`/`reauthenticate`/`changeEmail` and in
    two-factor `failureBudget`.
  - They are labelled `principal` in two-factor `manageByUser`, SAML/Webhooks `admin` and account `exportData`.
  - `clientId` is labelled `custom`.
- **D6. The failure-budget refusal is observed differently.** Device `assertBudget` publishes the event but skips
  the warning log and the `awthaq.ratelimit.exceeded` metric (`DeviceAuthorization.ts:789-805`, compare with
  `RateLimits.ts:311-325`).
- **D7. Declaration and registration are two lists** in OAuth (`OAuth.ts:703-727` vs `:851-882`) and API key
  (`ApiKey.ts:694-718` vs `:765-797`). The PV-241 drift tests guard them by hand.
- **D8. Seven enforced rules are undeclared and unregistered:** SAML ×4, SSO, Webhooks, account export. They are
  invisible to `plugin list --rules` and to `RateLimitsRegistry.registered`.
- **D9. Configurability is bespoke, and escalation is unreachable.**
  - There are six per-plugin config shapes:
    - `OAuthRateLimits`
    - `DeviceAuthorizationConfig.*RateLimit`
    - `ApiKeyConfig.*RateLimit`
    - `SamlConfig.rateLimits` and `adminRate`
    - `WebhooksConfig.adminRate`
    - `TwoFactorConfig.failure*`
  - Password, magic-link, email-OTP, passkey and account export cannot be tuned at all.
  - No application can opt *any* shipped rule into escalation. Spec BEH-EA-105 says "an application opts a rule in
    explicitly" (`spec/behaviors/14-rate-limiting.md`, RBS-009 paragraph), but no plugin config exposes
    `escalation`.
- **D10. Partial-override behaviour differs.** SAML replaces the whole `rateLimits` object (`SamlConfig.ts:132`).
  OAuth merges partially (`OAuthConfig.ts:159`).
- **D11. Some limits are read per request, some at boot.** OAuth and Webhooks read the tenant config in force per
  request (EP-007). Password, two-factor, device, API key and SAML read it at boot.
- **D12. Some endpoint labels are not endpoints.** `two_factor.account.manage`, `apikey.resolve`, and `saml.slo`
  (which covers `sloPost` too). The SAML and Webhooks admin rules put the dynamic action into `endpoint`.
- **D13. Key sharing between modules needs an import.** `TwoFactorRateLimits.ts:22` imports `failureKey` from
  `SecondFactor.ts` to keep the two keys equal. Device shares one bucket across three endpoints in two groups by
  string prefix (`DeviceAuthorization.ts:286-288`).
- **D14. The error mapping differs.** API key resolve maps to `Unauthenticated`; everyone else maps to
  `RateLimited`.
- **D15. Dead generic path.** `enforceRule`, ambient `bucketKey` and `phoneKey` have zero production callers.
  `RateLimitsRegistry.registered` has no reader in `packages/*/src`. The CLI reads the static manifest
  (`cli/src/Plugin.ts:137-146`).

### 2.6 Tests today that touch this module

| File | What | Fate |
|---|---|---|
| `core/test/RateLimits.test.ts` (222 lines) | `rule` scope (`:40-74`), ordering + freeze (`:76-151`), `enforce` event/metric/log (`:153-222`) | Ordering and freeze stay, rewritten to `open`. The `rule` and `enforce` tests move to `RateLimitBudget.test.ts`. |
| `core/test/RateLimitKeys.test.ts` (198) | ambient `bucketKey` (`:41-107`), `enforceRule` (`:109-150`), `phoneKey` (`:152-197`) | Replaced by `RateLimitKey.test.ts` |
| `core/test/RateLimits.types.test.ts` (18) | `RateLimitKey` gate | Replaced by `RateLimitBudget.types.test.ts` |
| `core/test/PluginDeclarations.test.ts:86-168` | declaration static, compile-time group refusal, `registerDeclared`/`declarationDrift` | Rewritten to the `rateLimitRules` table; the drift tests are deleted |
| `password/test/PasswordRateLimits.test.ts` (199) | RBS-006 registry==enforcement (`:26-122`), MLO-003 (`:124-140`), TMS-006 (`:142-184`), drift (`:185-198`) | RBS-006 and drift deleted; MLO-003 and TMS-006 kept as behaviour |
| `two-factor/test/RateLimitDeclaration.test.ts` (23) | drift | Deleted |
| `passkey/test/RateLimitDeclaration.test.ts` (24) | drift | Deleted |
| `api-key/test/RateLimitDeclaration.test.ts` (23) | drift | Deleted |
| `magic-link/test/RateLimitDeclaration.test.ts` (25) | drift (MagicLink + EmailOtp) | Deleted |
| `device-authorization/test/Plugin.test.ts:129-~140` | drift | Case deleted |
| `oauth/test/OAuth.test.ts:1659-~1672` | drift `describe` | Block deleted |
| `ports/test/RateLimiter.test.ts`, `sql/test/RateLimiterStoreSql*.test.ts` | port and stores | Unchanged |
| BDD `features/features/04-cross-cutting/14-rate-limiting.feature` (REQ-EA-278…303, 691) | steps in `features/step-definitions/RateLimitingSteps.ts` (1107 lines), `RateLimitingWorld.ts` (477), `CompileTimeGates.ts:78-85`, `RegistriesSteps.ts:824-910` | Steps rewritten (§5.4) |

### 2.7 Surprising findings (for the user)

1. The two email normalisers are **not** identical (D1), and passkey has no `+tag` normalisation at all, which is a
   live TMS-006 gap.
2. API key registers `apikey:token:client:[object Object]` as the client rule's key (D2).
3. Four plugins' registry keys never match their enforced keys (D2). BEH-EA-111's "registry is the source of truth
   for what is enforced" is false for them today.
4. SAML, SSO, Webhooks and the account export enforce seven rules that are invisible to introspection (D8).
5. RBS-009 escalation cannot be enabled for any shipped rule, even though the spec says the application opts in
   (D9).
6. The whole PV-240 generic path (`enforceRule`, ambient `"ip"`/`"principal"`) has zero production callers, and
   nothing in `src` ever reads `RateLimitsRegistry.registered`.

---

## 3. Target design

### 3.1 Module placement and the import graph

```
core/src/RateLimitKey.ts     NEW leaf. Key strategies + the one email normaliser.
                             imports: effect/Schema, effect/Option, ./Phone.ts
core/src/RateLimitModel.ts   NEW leaf. Rule, Table, Owner, Mode, Sizing, Tuning, Budget types,
                             declare(table), RegisteredRule, RateLimitsRegistry tag + shape, errors.
                             imports: effect, @awthaq/api (Api.RateLimited type), @awthaq/ports (RateLimiter types),
                                      ./RateLimitKey.ts, type ./HookPoint.ts (TapOwner)
core/src/RateLimits.ts       IMPLEMENTATION. Registry `layer`, `budget`, `budgetOf`, `owner`, `bucketKey`,
                             RateLimitOverrides/tune/overrides, exceededCounter, private observe().
                             `export * from "./RateLimitModel.ts"` and `export * as Key from "./RateLimitKey.ts"`
                             (precedent: `AuthEvents.ts:52` re-exports `AuthEventSchemas.ts`;
                             `Erasure.ts:62` re-exports `ErasureRegistry.ts`).
                             imports: ./RateLimitModel.ts, ./RateLimitKey.ts, ./AuthEvents.ts, ./Tenant.ts, type ./AuthPlugin.ts
core/src/AuthPlugin.ts       imports ./RateLimitModel.ts (value: registry tag for the guard; types: Table, declare)
```

The public namespace stays `RateLimits.*` (`core/src/index.ts:54`). `RateLimitKey.ts` and `RateLimitModel.ts` are
not exported from `index.ts` on their own.

There are no cycles. `AuthPlugin → RateLimitModel → (HookPoint type)` is fine, and so is
`RateLimits → AuthPlugin (type)`. The `RateLimits → AuthPlugin` edge that exists today stays type-only. Neither leaf
imports `AuthPlugin` or `RateLimits`.

### 3.2 Key strategies (`RateLimitKey.ts`)

A key strategy names the one small, secret-free field it reads and carries the `Schema` that narrows `unknown` to
it. That is the "schema-narrowed" half of the old `Rule<I>`, written once. Field names are **fixed**: there is no
generic `field` parameter. A computed generic key would force a cast to type the `Schema.Struct`. Call sites already
build these small inputs, for example `{ identifier: publicId }` and `{ email: input.newEmail }`.

```ts
// core/src/RateLimitKey.ts
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Phone from "./Phone.ts";

/** What a breach is attributed to (`auth.rateLimit.exceeded.dimension`). */
export type Dimension = "identity" | "ip" | "principal" | "custom";

/** Per-budget settings a key may read; today only the email normaliser (`PasswordConfig.rateLimitEmailKey`). */
export interface KeyContext {
  readonly email: (address: string) => string;
}

/** A bucket-key strategy over input `I`: a printable name, a dimension, a guard, and the key part. */
export interface Key<I> {
  readonly strategy: "ip" | "email" | "identifier" | "user" | "session" | "client" | "phone" | "custom";
  readonly dimension: Dimension;
  /** `Schema.is` of the strategy's own input struct: narrows `unknown`, never a cast. */
  readonly accepts: (input: unknown) => input is I;
  readonly part: (input: I, context: KeyContext) => string;
}

const make = <S extends Schema.Constraint>(spec: {
  readonly strategy: Key<S["Type"]>["strategy"];
  readonly dimension: Dimension;
  readonly input: S;
  readonly part: (input: S["Type"], context: KeyContext) => string;
}) => {
  const key: Key<S["Type"]> = {
    strategy: spec.strategy,
    dimension: spec.dimension,
    accepts: Schema.is(spec.input),
    part: spec.part,
  };
  return key;
};

/**
 * TMS-006: THE per-address bucket normaliser (was PasswordRateLimits.defaultEmailRateKey,
 * Channel.emailRateKey and passkey's toLowerCase). Trim, lower-case, strip a `+tag` from a local part
 * that does not start with `+`. Only the key is normalised; delivery and storage keep the literal address.
 */
export const emailKey = (address: string) => {
  const lowered = address.trim().toLowerCase();
  const at = lowered.lastIndexOf("@");
  if (at === -1) return lowered;
  const local = lowered.slice(0, at);
  const plus = local.indexOf("+");
  return `${plus > 0 ? local.slice(0, plus) : local}${lowered.slice(at)}`;
};

/** The source address the handler resolved through `ClientAddress`; unresolvable → one shared `unknown` bucket. */
export const ip = make({
  strategy: "ip",
  dimension: "ip",
  input: Schema.Struct({ ip: Schema.optional(Schema.String) }),
  part: (input) => `ip:${input.ip ?? "unknown"}`,
});
/** A target address (mail-bombing, enumeration). Normalised by the budget's `KeyContext.email`. */
export const email = make({
  strategy: "email",
  dimension: "identity",
  input: Schema.Struct({ email: Schema.String }),
  part: (input, context) => `email:${context.email(input.email)}`,
});
/** A token's public id (never its secret half). */
export const identifier = make({
  strategy: "identifier",
  dimension: "identity",
  input: Schema.Struct({ identifier: Schema.String }),
  part: (input) => `identifier:${input.identifier}`,
});
/** The signed-in user the caller is (the handler passes `CurrentPrincipal`'s id). */
export const user = make({
  strategy: "user",
  dimension: "principal",
  input: Schema.Struct({ userId: Schema.String }),
  part: (input) => `user:${input.userId}`,
});
export const session = make({
  strategy: "session",
  dimension: "principal",
  input: Schema.Struct({ sessionId: Schema.String }),
  part: (input) => `session:${input.sessionId}`,
});
/** An OAuth/device client id: the target a secret- or code-guesser aims at. */
export const client = make({
  strategy: "client",
  dimension: "identity",
  input: Schema.Struct({ clientId: Schema.String }),
  part: (input) => `client:${input.clientId}`,
});
/** SOS-007 (was RateLimits.phoneKey): E.164-normalised; non-numbers share one `invalid` bucket. */
export const phone = (options?: Phone.NormalizeOptions) =>
  make({
    strategy: "phone",
    dimension: "identity",
    input: Schema.Struct({ phone: Schema.String }),
    part: (input) =>
      `phone:${Option.getOrElse(Phone.normalizePhone(input.phone, options), () => "invalid")}`,
  });
/** BEH-EA-108's explicit opt-in: the author names the dimension and the input schema and owns the reasoning. */
export const custom = <S extends Schema.Constraint>(
  dimension: Dimension,
  input: S,
  part: (input: S["Type"]) => string,
) => make({ strategy: "custom", dimension, input, part: (value) => `custom:${part(value)}` });
```

Ambient keys are removed: the old `"ip"` strategy read `HttpServerRequest` plus `ClientAddress`, and the old
`"principal"` strategy read `CurrentPrincipal`. Reasons:

- They had no production caller (D15).
- They would add an `R` requirement that a widened rule table cannot carry back to the typed handle without a
  cast.
- Every caller already resolves the IP or principal at the handler edge and passes it in.

BEH-EA-108's requirement still holds. The key derives from the principal, the network origin, or an explicit
function: the handler fills `ip`/`userId` from `ClientAddress`/`CurrentPrincipal`. §6.1 adds a *Deviation* note.

### 3.3 Rules and tables (`RateLimitModel.ts`)

```ts
// core/src/RateLimitModel.ts (excerpt)
import type { Api } from "@awthaq/api";
import type { RateLimiter } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as HookPoint from "./HookPoint.ts";
import type * as Key from "./RateLimitKey.ts";

/** `"attempts"`: every call is consumed (`spend`). `"failures"`: refused before evaluating, charged only on failure (BCR-006). */
export type Mode = "attempts" | "failures";

/** The numbers an application may tune. */
export interface Sizing {
  readonly limit: number;
  readonly window: Duration.Input;
  readonly escalation?: RateLimiter.Escalation | undefined;
}

export interface Rule<Group extends string = string, I = unknown, M extends Mode = Mode> {
  readonly group: Group;
  /** One of `group`'s endpoints, or `"*"` for a group-wide rule (the event then reports the endpoint `spend` names). */
  readonly endpoint: string;
  readonly strategy: Key.Key<I>["strategy"];
  readonly dimension: Key.Dimension;
  readonly mode: M;
  /** The declared default. */
  readonly sizing: Sizing;
  /** A bucket shared by several rules (or used outside a budget): must start with one of the owner's groups + ".". */
  readonly bucket: string | undefined;
  readonly order: number;
  /** Erased derivation: `ratelimit:<bucket>:<part>`, or `ratelimit:<bucket>:invalid` for input of the wrong shape. */
  readonly keyOf: (bucket: string, input: unknown, context: Key.KeyContext) => string;
  /** Phantom: the input type `spend` demands. Never assigned (the `"~userFields"` precedent, AuthPlugin.ts:109). */
  readonly "~input"?: I;
}

/** A plugin's rule table; the key of each entry IS the rule's name (`EnforceMeta.rule`, the event's `rule`). */
export type Table<Group extends string = string> = {
  readonly [name: string]: Rule<Group, unknown, Mode>;
};

interface RuleSpec<Group extends string, I> {
  readonly group: Group;
  readonly endpoint: string;
  readonly key: Key.Key<I>;
  readonly limit: number;
  readonly window: Duration.Input;
  readonly escalation?: RateLimiter.Escalation;
  readonly bucket?: string;
  readonly order?: number;
}

const build = <Group extends string, I, M extends Mode>(spec: RuleSpec<Group, I>, mode: M) => {
  const made: Rule<Group, I, M> = {
    group: spec.group,
    endpoint: spec.endpoint,
    strategy: spec.key.strategy,
    dimension: spec.key.dimension,
    mode,
    sizing: { limit: spec.limit, window: spec.window, escalation: spec.escalation },
    bucket: spec.bucket,
    order: spec.order ?? 0,
    keyOf: (bucket, input, context) =>
      `ratelimit:${bucket}:${spec.key.accepts(input) ? spec.key.part(input, context) : "invalid"}`,
  };
  return made;
};

/** A request throttle: every call spends one unit. */
export const rule = <const Group extends string, I>(spec: RuleSpec<Group, I>) => build(spec, "attempts");
/** A failure budget (BCR-006): `guard` before evaluating, `charge` on a failure. */
export const failureRule = <const Group extends string, I>(spec: RuleSpec<Group, I>) =>
  build(spec, "failures");
```

Two constructors, not a `mode?` option. With a defaulted `mode` the expression `spec.mode ?? "attempts"` has type
`M | "attempts"`, which is not `M`, and a cast would be needed. Two entry points need none.

### 3.4 The declaration is derived from the table, and can be checked by type

```ts
// RateLimitModel.ts
export interface RateLimitDeclaration<Group extends string = string> {
  readonly group: Group;
  readonly endpoint: string;
  readonly name: string;
  readonly dimension: Key.Dimension;
  readonly key: Key.Key<unknown>["strategy"]; // NEW (printed by `plugin list --rules`)
  readonly mode: Mode;                       // NEW
  readonly limit: number;
  readonly window: Duration.Input;
}

export const declare = (table: Table) =>
  Object.entries(table).map(([name, rule]) => ({
    group: rule.group,
    endpoint: rule.endpoint,
    name,
    dimension: rule.dimension,
    key: rule.strategy,
    mode: rule.mode,
    limit: rule.sizing.limit,
    window: rule.sizing.window,
  }));
```

`AuthPlugin.ts` changes:

- `RateLimitDimension` and `RateLimitDeclaration` move to the model. `AuthPlugin.ts` re-exports them as types
  (`export type { RateLimitDeclaration } from "./RateLimitModel.ts"`) so the names `AuthPlugin.RateLimitDeclaration`
  and `AuthPlugin.RateLimitDimension` are unchanged.
- `Class` gains a sixth type parameter, `Limits extends RateLimitModel.Table = {}`, and two members:
  `readonly rateLimitRules: RateLimitModel.Table` (the runtime table, widened) and
  `readonly "~rateLimits"?: Limits` (a phantom that carries the precise type). The phantom exists for the same
  reason as `"~userFields"` (`AuthPlugin.ts:104-109`): `options.rateLimitRules ?? {}` has type `Limits | {}`, not
  `Limits`.
- `Service` gains a generic parameter, `const Limits extends RateLimitModel.Table<GroupIdOf<Groups>> = {}`, and an
  option, `readonly rateLimitRules?: Limits`. A rule naming a group outside the contract is a **compile error**.
  This was checked in scratch (§3.9). It replaces both `declareRateLimits`' runtime `throw` (`AuthPlugin.ts:145-151`)
  and the old `rateLimits` option's typing.
- `Object.assign` (`AuthPlugin.ts:316-329`) gains `rateLimitRules: options.rateLimitRules ?? {}` and computes
  `rateLimits: RateLimitModel.declare(options.rateLimitRules ?? {})`. During migration the legacy array is used
  when there is no table (§4 Phase 1).
- `Any` gains `readonly rateLimitRules?: RateLimitModel.Table`.
- The manifest is unchanged in shape (`Auth.ts:677-679` spreads each declaration). `ManifestRateLimit` gains `key`
  and `mode` automatically.

### 3.5 The budget: interface and implementation

#### Types (`RateLimitModel.ts`)

```ts
/** What `budget` needs of its owner. No `layer` member: this is what breaks the inference cycle (§3.9). */
export interface Owner<Limits = Table> extends HookPoint.TapOwner {
  readonly contract: { readonly groups: { readonly [group: string]: unknown } };
  readonly rateLimitRules?: Table | undefined;
  readonly "~rateLimits"?: Limits;
}

export type InputOf<R> = R extends { readonly "~input"?: infer I } ? I : never;
export type NamesOf<Limits, M extends Mode> = {
  [N in keyof Limits]: Limits[N] extends Rule<string, unknown, M> ? N : never;
}[keyof Limits] & string;
type Picked<N> = N extends ReadonlyArray<infer X> ? X : N;
type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (i: infer I) => void ? I : never;
/** `spend(["signInByIp", "signIn"], input)`: the input must satisfy every named rule's key. */
export type InputsOf<Limits, N> = UnionToIntersection<
  Picked<N> extends infer K ? (K extends keyof Limits ? InputOf<Limits[K]> : never) : never
>;

export type Tuning<Limits> = { readonly [N in keyof Limits]?: Partial<Sizing> };

export interface SpendOptions {
  /** For a group-wide (`"*"`) rule: the endpoint the event and metric report. */
  readonly endpoint?: string;
}

/** The typed handle. Every refusal is published, logged and counted (EOTS-007) and answers `Api.RateLimited` (429). */
export interface Budget<Limits> {
  /** Consumes each named attempts-rule, in order, stopping at the first refusal. */
  readonly spend: <const N extends NamesOf<Limits, "attempts"> | ReadonlyArray<NamesOf<Limits, "attempts">>>(
    names: N,
    input: InputsOf<Limits, N>,
    options?: SpendOptions,
  ) => Effect.Effect<void, Api.RateLimited>;
  /** The read half of a failure budget: refuses once spent, never counts (RateLimiter.check). */
  readonly guard: <N extends NamesOf<Limits, "failures">>(
    name: N,
    input: InputOf<Limits[N]>,
    options?: SpendOptions,
  ) => Effect.Effect<void, Api.RateLimited>;
  /** Charges one failure; a race past the limit is ignored (the next `guard` refuses). */
  readonly charge: <N extends NamesOf<Limits, "failures">>(
    name: N,
    input: InputOf<Limits[N]>,
  ) => Effect.Effect<void>;
}

/** The runtime shape. Assignable to `Budget<Limits>` because its parameters are wider (checked in scratch). */
export interface ErasedBudget {
  readonly spend: (
    names: string | ReadonlyArray<string>,
    input: unknown,
    options?: SpendOptions,
  ) => Effect.Effect<void, Api.RateLimited>;
  readonly guard: (name: string, input: unknown, options?: SpendOptions) => Effect.Effect<void, Api.RateLimited>;
  readonly charge: (name: string, input: unknown) => Effect.Effect<void>;
}

export interface BudgetOptions<Limits> {
  /**
   * The plugin's own knobs, evaluated at open (for the registry) AND on every call, so a tenant's config in
   * force applies (EP-007): `Effect.map(configNow, (c) => c.rateLimits)`.
   */
  readonly tune?: Effect.Effect<Tuning<Limits>>;
  /** Default `RateLimits.Key.emailKey`. */
  readonly emailKey?: (address: string) => string;
}
```

#### Registry (`RateLimitModel.ts`: tag and shape; `RateLimits.ts`: `layer`)

```ts
export interface RegisteredRule {
  readonly plugin: string;
  readonly name: string;
  readonly group: string;
  readonly endpoint: string;
  readonly dimension: Key.Dimension;
  readonly key: Key.Key<unknown>["strategy"];  // a description, no longer a function (Phase 11)
  readonly mode: Mode;
  readonly bucket: string;
  readonly limit: number;
  readonly window: Duration.Input;
  readonly escalation?: RateLimiter.Escalation | undefined;
  readonly order: number;
  readonly sequence: number;
}

export interface Registration {
  readonly name: string;
  readonly rule: Rule;
  readonly bucket: string;
  readonly sizing: Sizing; // tuned, at open
}

export interface RateLimitsRegistryShape {
  /** Registers `owner`'s whole table and remembers its handle. Dies on: scope violation, frozen, double open, bucket conflict. */
  readonly open: (owner: Owner, registrations: ReadonlyArray<Registration>, handle: ErasedBudget) => Effect.Effect<void>;
  readonly handleOf: (ownerId: string) => Effect.Effect<Option.Option<ErasedBudget>>;
  /** BEH-EA-111, unchanged: dependency order, then `order`, then plugin id (HookPoint.compareTaps), then sequence; frozen at first read. */
  readonly registered: Effect.Effect<ReadonlyArray<RegisteredRule>>;
}

export class RateLimitsRegistry extends Context.Service<RateLimitsRegistry, RateLimitsRegistryShape>()(
  "awthaq/core/RateLimitsRegistry",
) {}

export class RateLimitScopeViolation extends Data.TaggedError("RateLimitScopeViolation")<{ readonly plugin: string; readonly group: string; readonly message: string }> {}
export class RateLimitsFrozen extends Data.TaggedError("RateLimitsFrozen")<{ readonly message: string }> {}
export class RateLimitBudgetAlreadyOpen extends Data.TaggedError("RateLimitBudgetAlreadyOpen")<{ readonly plugin: string; readonly message: string }> {}
export class RateLimitBudgetNotOpened extends Data.TaggedError("RateLimitBudgetNotOpened")<{ readonly plugin: string; readonly rules: ReadonlyArray<string>; readonly message: string }> {}
export class RateLimitBucketConflict extends Data.TaggedError("RateLimitBucketConflict")<{ readonly plugin: string; readonly bucket: string; readonly message: string }> {}
```

Every error is a **defect** (`Effect.die`), not a typed failure.

- For a class owner, a scope violation is impossible because `Service` confines the group at the type level.
- A hand-built owner can still hit one, and the BDD world reads it with `Cause.squash`
  (`RateLimitingWorld.ts:131-132` already does).
- So no plugin writes `.pipe(Effect.orDie)` again.

`open` validates three things:

1. Every `rule.group` is one of `owner.contract.groups` (BEH-EA-107; same check as `RateLimits.ts:121`).
2. Every explicit `rule.bucket` starts with one of those groups followed by `"."`, so no plugin can name another
   plugin's bucket.
3. Rules that share a bucket have equal mode and equal tuned `limit`/`window`.

#### Implementation (`RateLimits.ts`)

```ts
/** The app/tenant override path (G5). A Context.Reference, so a tenant middleware may provide its own per fiber. */
export interface OverridesShape {
  readonly [plugin: string]: { readonly [rule: string]: Partial<Sizing> | undefined } | undefined;
}
export const RateLimitOverrides = Context.Reference<OverridesShape>("awthaq/core/RateLimitOverrides", {
  defaultValue: () => ({}),
});
export interface OverrideEntry {
  readonly plugin: string;
  readonly tuning: { readonly [rule: string]: Partial<Sizing> | undefined };
}
/** Typed per plugin: `tune(Password, { signIn: { limit: 3 } })`; an unknown rule name is a compile error. */
export const tune = <Limits>(owner: Owner<Limits>, tuning: Tuning<Limits>) => {
  const entry: OverrideEntry = { plugin: owner.id, tuning };
  return entry;
};
/** One Layer for all of an application's overrides (two `Layer.succeed`s of one Reference would shadow, not merge). */
export const overrides = (...entries: ReadonlyArray<OverrideEntry>) =>
  Layer.succeed(
    RateLimitOverrides,
    entries.reduce<OverridesShape>(
      (acc, entry) => ({ ...acc, [entry.plugin]: { ...acc[entry.plugin], ...entry.tuning } }),
      {},
    ),
  );

/** EOTS-007's one observation site (the body of today's `enforce`, now private). */
const observe = (events: AuthEvents.AuthEventsShape, meta: EnforceMeta, retryAfterMillis: number) =>
  Effect.all(
    [
      events.publish({ _tag: "auth.rateLimit.exceeded", ...meta, retryAfterMillis }),
      Effect.logWarning("awthaq: rate limit exceeded").pipe(Effect.annotateLogs({ ...meta, retryAfterMillis })),
      Metric.update(Metric.withAttributes(exceededCounter, { ...meta }), 1),
    ],
    { discard: true },
  );

export const budget = <Limits extends Table>(owner: Owner<Limits>, options: BudgetOptions<Limits> = {}) =>
  Effect.gen(function* () {
    const registry = yield* RateLimitsRegistry;
    const limiter = yield* RateLimiter.RateLimiter;
    const events = yield* AuthEvents.AuthEvents;
    const table = owner.rateLimitRules ?? {};
    const context = { email: options.emailKey ?? Key.emailKey };
    const tuneNow = options.tune ?? Effect.succeed({});
    const builtOverrides = yield* RateLimitOverrides;
    const overridesNow = Tenant.configInForce(RateLimitOverrides, builtOverrides);

    const resolve = (name: string, tuning: ErasedTuning, applied: OverridesShape) => {
      const rule = table[name];
      // Unreachable through the typed handle; reachable only from a hand-built owner or a bad override.
      if (rule === undefined) return Effect.die(new UnknownRateLimitRule({ plugin: owner.id, name }));
      return Effect.map(
        validSizing(owner.id, name, { ...rule.sizing, ...tuning[name], ...applied[owner.id]?.[name] }),
        (sizing) => ({ rule, sizing, bucket: rule.bucket ?? `${rule.group}.${name}` }),
      );
    };
    const now = (name: string) =>
      Effect.flatMap(Effect.all([tuneNow, overridesNow]), ([tuning, applied]) => resolve(name, tuning, applied));
    const metaOf = (name: string, rule: Rule, options?: SpendOptions) => ({
      group: rule.group,
      endpoint: options?.endpoint ?? rule.endpoint,
      rule: name,
      dimension: rule.dimension,
    });
    const refuse = (name: string, rule: Rule, options: SpendOptions | undefined) =>
      Effect.catchTag("RateLimitExceeded", (error: RateLimiter.RateLimitExceeded) =>
        observe(events, metaOf(name, rule, options), error.retryAfterMillis).pipe(
          Effect.andThen(Effect.fail(new Api.RateLimited({ retryAfterMillis: error.retryAfterMillis }))),
        ),
      );

    const spendOne = (name: string, input: unknown, options?: SpendOptions) =>
      Effect.flatMap(now(name), ({ rule, sizing, bucket }) =>
        limiter
          .consume({ key: rule.keyOf(bucket, input, context), ...sizing })
          .pipe(refuse(name, rule, options)),
      );
    const erased: ErasedBudget = {
      spend: (names, input, options) =>
        Effect.forEach(typeof names === "string" ? [names] : names, (name) => spendOne(name, input, options), {
          discard: true,
        }),
      guard: (name, input, options) =>
        Effect.flatMap(now(name), ({ rule, sizing, bucket }) =>
          limiter.check({ key: rule.keyOf(bucket, input, context), ...sizing }).pipe(refuse(name, rule, options)),
        ),
      charge: (name, input) =>
        Effect.flatMap(now(name), ({ rule, sizing, bucket }) =>
          limiter.consume({ key: rule.keyOf(bucket, input, context), ...sizing }).pipe(Effect.ignore),
        ),
    };

    // The registry records what is in force at build: declared ⊕ tune ⊕ the built overrides (§3.6 levels 1-3).
    const tuningAtOpen = yield* tuneNow;
    const registrations = yield* Effect.forEach(Object.keys(table), (name) =>
      Effect.map(resolve(name, tuningAtOpen, builtOverrides), (resolved) => ({ name, ...resolved })),
    );
    yield* registry.open(owner, registrations, erased);
    const typed: Budget<Limits> = erased;
    return typed;
  });

/** The handle a plugin's layer already opened: for its handlers and contributions (ApiKey). Dies if not opened. */
export const budgetOf = <Limits extends Table>(owner: Owner<Limits>) =>
  Effect.gen(function* () {
    const registry = yield* RateLimitsRegistry;
    const handle = yield* registry.handleOf(owner.id);
    if (Option.isNone(handle)) return yield* Effect.die(new RateLimitBudgetNotOpened({ ... }));
    const typed: Budget<Limits> = handle.value;
    return typed;
  });

/** A rule's bucket key outside a budget (SecondFactor's failure budget). Needs an explicit `bucket`. */
export const bucketKey = <I>(
  rule: Rule<string, I, Mode> & { readonly bucket: string },
  input: NoInfer<I>,
  context: Key.KeyContext = { email: Key.emailKey },
) => rule.keyOf(rule.bucket, input, context);

/** A hand-built owner (core's own account group, tests, BDD): groups confined to `contract`'s at compile time. */
export const owner = <Groups extends HttpApiGroup.Constraint, const Limits extends Table<AuthPlugin.GroupIdOf<Groups>>>(spec: {
  readonly id: string;
  readonly contract: HttpApi.HttpApi<"auth", Groups>;
  readonly dependsOn?: ReadonlyArray<HookPoint.TapOwner>;
  readonly rateLimits: Limits;
}) => {
  const made: Owner<Limits> = {
    id: spec.id,
    contract: spec.contract,
    dependsOn: spec.dependsOn ?? [],
    rateLimitRules: spec.rateLimits,
  };
  return made;
};
```

Notes on the sketch:

- `validSizing` dies with `Defects.invalidConfiguration("rateLimits", …)` when `limit` is not a positive integer or
  `window` is not greater than 0 ms.
- `ErasedTuning` is `{ readonly [rule: string]: Partial<Sizing> | undefined }`.
- `EnforceMeta` stays as a module-private interface.
- There are no `as` casts.
- The only annotations are on two non-Effect consts, `typed` and `made`. They are needed for widening, and are
  allowed because the rule only forbids annotating Effect or Layer consts.
- `budget`, `budgetOf` and `overrides` are inferred.

### 3.6 Tuning and overrides: precedence

In force on every call, lowest precedence first:

1. The declared default (`rule.sizing`, from the table).
2. The plugin's own knob (`options.tune`). Evaluated per call, so OAuth and Webhooks keep EP-007 per-tenant
   behaviour.
3. The application's `RateLimits.overrides(...)` layer (the built `RateLimitOverrides` value).
4. A fiber-provided `RateLimitOverrides` (`Effect.provideService`, for example from a tenant middleware).
   `Tenant.configInForce` makes it win over 3 (`ports/src/Tenant.ts:60-63`).

The registry records levels 1–3 as they stood at build. `plugin list --rules` prints level 1 (the declaration).

Escalation (RBS-009) becomes reachable for every shipped rule:
`RateLimits.overrides(RateLimits.tune(Password, { signIn: { escalation: { factor: 2, maxPenalty: "1 hour" } } }))`.

The existing plugin knobs keep their shapes. `OAuthConfig.rateLimits`, `DeviceAuthorizationConfig.*RateLimit`,
`ApiKeyConfig.*RateLimit`, `SamlConfig.rateLimits`/`adminRate`, `WebhooksConfig.adminRate`,
`TwoFactorConfig.failure*` and `PasswordConfig.rateLimitEmailKey` each become that plugin's `tune` or `emailKey`.
Whether to deprecate them in favour of the generic path is Q4.

### 3.7 Event publication

There is one site, `observe` (§3.5), which is the body of today's `enforce` (`RateLimits.ts:299-328`). It publishes
`auth.rateLimit.exceeded` with `{group, endpoint, rule: <table key>, dimension, retryAfterMillis}`, logs a warning,
and increments `awthaq.ratelimit.exceeded`. It never carries the key (BEH-EA-108). `guard` goes through the same
`observe`, which fixes D6: device lookups are now logged and counted.

`charge` is silent. `SecondFactor` keeps `auth.twoFactor.*` (N3).

The event schema is unchanged (N6). Plan 10 classifies this as an "attempt" event, and plan 09 changes how it is
defined; both touch only the `events.publish` line inside `observe` (§8).

### 3.8 Bucket keys: one format

The format is `ratelimit:<bucket>:<part>`.

- `<bucket>` is `rule.bucket`, or `<group>.<name>` when the rule has none.
- `<part>` is one of `ip:<addr|unknown>`, `email:<emailKey>`, `identifier:<id>`, `user:<id>`, `session:<id>`,
  `client:<id>`, `phone:<e164|invalid>`, `custom:<fn>`, or `invalid`.
- Group ids are unique per composition and names are unique per table, so two rules never share a counter unless
  they name the same `bucket` on purpose.

| Old key (examples) | New key |
|---|---|
| `password:signin:alice@x.com` | `ratelimit:password.signIn:email:alice@x.com` |
| `password:signin:ip:1.2.3.4` | `ratelimit:password.signInByIp:ip:1.2.3.4` |
| `password:reset-confirm:<publicId>` | `ratelimit:password.confirmReset:identifier:<publicId>` |
| `password:change-password:<uid>` | `ratelimit:password.account.changePassword:user:<uid>` |
| `magic-link:request:email:<e>` | `ratelimit:magicLink.requestByEmail:email:<e>` |
| `two_factor:fail:<uid>` | `ratelimit:two_factor.failures:user:<uid>` (explicit bucket) |
| `two_factor:manage:<uid>` | `ratelimit:two_factor.account.manageByUser:user:<uid>` |
| `device:user-code:ip:<a>` (shared) | `ratelimit:device_authorization.userCode:ip:<a>` (explicit shared bucket) |
| `device:user-code:session:<s>` (shared) | `ratelimit:device_authorization.userCode:session:<s>` |
| `oauth:authorize:<a>` | `ratelimit:oauth.authorize:ip:<a>` |
| `apikey:token:client:<c>` | `ratelimit:apikey.token.tokenByClient:client:<c>` |
| `saml:admin:<uid>` | `ratelimit:saml.admin.admin:user:<uid>` |
| `account:export:<uid>` | `ratelimit:account.exportData:user:<uid>` |

The rename resets live counters once at deploy. For the SQL store, old rows simply expire, since every window is
1 hour or less. Q1 offers the alternative: keep today's strings using explicit `bucket`s.

### 3.9 The inference cycle, solved once

**Cause.** In `static readonly layer = AuthPlugin.layer(Password, { make: Effect.gen(… register(Password, entry) …) })`,
the type of `Password.layer` depends on the type of `make`. `make` contains a call whose parameter is typed
`AuthPlugin.Any`, and `Any` requires a `layer` member. Checking `Password` against `Any` therefore needs
`Password.layer`'s type, which is still being inferred. TypeScript reports this as TS7022/TS7024. The eight sites
in §2.4 dodge it by annotating the callback's return type.

**Reproduced in scratch** (`tsc --strict`, plain TS that models the shapes): `registerAny(Bad)` inside `Bad`'s
static initializer gives `TS7022: 'layer' implicitly has type 'any' … referenced directly or indirectly in its own
initializer`. `budget(Good)` with `budget: <L>(owner: Owner<L>) => …` gives no error, and it infers the rule names
from the phantom (`b.spend("c")` is a `@ts-expect-error`).

**Fix.**

- `budget`, `budgetOf`, `tune` and `owner` take `Owner<Limits>`, which has **no `layer`**. `Owner` extends
  `HookPoint.TapOwner` (`HookPoint.ts:147-150`), the same narrow owner the hook chain already orders by.
- The registry stores `Owner` (and orders with `HookPoint.compareTaps`, unchanged), not `AuthPlugin.Any`.
- `AuthPlugin.layer` already took `plugin: Class<Self, Id, Shape, Groups>` for exactly this reason
  (`AuthPlugin.ts:410-423`). This design applies that one rule to the rate-limit path.
- Result: zero annotations and zero comments across all plugins.

**Also checked in scratch:**

- The typed handle: multi-name intersection input, `failures`/`attempts` filtering, erased-to-typed assignment, and
  `Tuning<typeof table>` widening to an index-signature record.
- `Service`'s `const Limits extends Table<GroupIdOf<Groups>>` rejects a foreign group.

Phase 0 re-verifies all of this against the real `HttpApi`/`Effect` types.

### 3.10 The guard: declared means opened

`AuthPlugin.layer` (`AuthPlugin.ts:552-568`) wraps `withContributions`, before taps are merged:

```ts
const guarded = Layer.tap(withContributions, () =>
  Effect.flatMap(Effect.serviceOption(RateLimitModel.RateLimitsRegistry), (registry) =>
    Option.isNone(registry) || Object.keys(plugin.rateLimitRules).length === 0
      ? Effect.void
      : Effect.flatMap(registry.value.handleOf(plugin.id), (handle) =>
          Option.isSome(handle)
            ? Effect.void
            : Effect.die(
                new RateLimitModel.RateLimitBudgetNotOpened({
                  plugin: plugin.id,
                  rules: Object.keys(plugin.rateLimitRules),
                  message: `awthaq: plugin "${plugin.id}" declares rate-limit rules but its layer never opened RateLimits.budget(${plugin.id})`,
                }),
              ),
        ),
  ),
);
```

- `Layer.tap` (`../effect/packages/effect/src/Layer.ts:1735-1742`) keeps `ROut`. With `serviceOption`, `RIn2` and
  `E2` are `never`, so all three `AuthPlugin.layer` overload return types are unchanged.
- Every plugin suite that builds a plugin's layer now exercises this check. It is the generic replacement for the
  seven per-plugin drift tests.
- The other direction ("enforced but undeclared") is a type error: `spend` accepts only declared names. `enforce`
  stops being exported (Phase 11), so there is no other observable way to enforce.

### 3.11 What changes in the public interface

| Package | Added | Removed or renamed (Phase in §4) |
|---|---|---|
| `@awthaq/core` | `RateLimits.Key.{ip,email,identifier,user,session,client,phone,custom,emailKey}`, `RateLimits.rule`/`failureRule` (constructors), `Table`, `Rule`, `Mode`, `Sizing`, `Tuning`, `Owner`, `Budget`, `budget`, `budgetOf`, `owner`, `bucketKey(rule, input)`, `RateLimitOverrides`, `tune`, `overrides`, `declare`, errors `RateLimitBudgetNotOpened`/`AlreadyOpen`/`BucketConflict`; `AuthPlugin.Service` option `rateLimitRules`; `Class.rateLimitRules`; `RateLimitDeclaration.key`/`.mode`; registry `open`/`handleOf` | P1: old `rule(owner,input)` Layer, ambient `bucketKey`, `enforceRule`, `phoneKey`. P11: `RuleInput`, `RateLimitKey`, `registerDeclared`, `declarationDrift`/`DeclarationDrift`, exported `enforce`/`EnforceInput`/`EnforceMeta`, registry `register`, `RegisteredRule.key` as a function, `AuthPlugin.declareRateLimits`, `Service` option `rateLimits` (the static `rateLimits` stays, derived) |
| `@awthaq/magic-link` | — | `Channel.emailRateKey` (P2) |
| `@awthaq/two-factor` | `SecondFactor.failureRule` | `SecondFactor.failureKey` (P4) |
| `@awthaq/password` | — | `PasswordConfig.rateLimitEmailKey` default becomes `RateLimits.Key.emailKey` (now also trims) (P3) |
| `@awthaq/saml` | `SamlConfig.defaultRateLimits`; `rateLimits` input accepts a partial | — (P9) |
| `@awthaq/server` | — | `AuthHttp.CoreHandlerServices` gains `RateLimits.RateLimitsRegistry` (P10) |
| `@awthaq/cli` | `plugin list --rules`: KEY and MODE columns, and JSON `key`/`mode` | — (P11) |

`PasswordRateLimits`, `TwoFactorRateLimits` and magic-link's `RateLimitRules` are **not** exported from their
package indexes (`password/src/index.ts`, `two-factor/src/index.ts`, `magic-link/src/index.ts`). Deleting them is
internal.

### 3.12 Per-plugin target tables

Each table is a module-level `const rules = { … }` placed before the plugin class and passed as
`rateLimitRules: rules`. Entry order matches today's registration order, so the registry order is unchanged.
`minutes15 = Duration.minutes(15)`.

#### 3.12.1 Password

17 entries: the names, groups, endpoints and numbers in §2.2.

- `*ByIp` entries use `Key.ip`.
- `signUp`, `signIn`, `requestReset`, `resendVerification` and `changeEmailTarget` use `Key.email`.
- `confirmReset`, `verifyEmail` and `confirmEmailChange` use `Key.identifier`.
- `changePassword`, `reauthenticate` and `changeEmail` use `Key.user`. Their dimension changes from identity to
  principal (D5).

Budget: `RateLimits.budget(Password, { emailKey: builtConfig.rateLimitEmailKey })`. There is no `tune`; the limits
were never configurable, and the generic overrides now cover that.

#### 3.12.2 Magic link and email OTP

The four entries each from §2.2, using `Key.ip`, `Key.email` and `Key.identifier`. Budget:
`RateLimits.budget(MagicLink)` and `RateLimits.budget(EmailOtp)`.

#### 3.12.3 Two-factor

```ts
// SecondFactor.ts: replaces failureKey (:133-134). Locality: declared beside the code that charges it.
const failureDefaults = TwoFactorConfig.defaultValue();
export const failureRule = RateLimits.failureRule({
  group: "two_factor",
  endpoint: "verify",
  key: RateLimits.Key.user,
  limit: failureDefaults.failureLimit,
  window: failureDefaults.failureWindow,
  bucket: "two_factor.failures",
});
// …and in `layer`, budget.key becomes (userId) => RateLimits.bucketKey(failureRule, { userId })

// TwoFactor.ts
const rules = {
  verifyByIp: RateLimits.rule({ group: "two_factor", endpoint: "verify", key: RateLimits.Key.ip, limit: 30, window: minutes15 }),
  manageByUser: RateLimits.rule({ group: "two_factor.account", endpoint: "*", key: RateLimits.Key.user, limit: 20, window: minutes15 }),
  failureBudget: failureRule,
};
// make:
const limits = yield* RateLimits.budget(TwoFactor, {
  tune: Effect.succeed({ failureBudget: { limit: config.failureLimit, window: config.failureWindow } }),
});
```

#### 3.12.4 Passkey

`authenticateOptionsByIp` (`Key.ip`, 60/15m), `authenticateOptionsByEmail` (`Key.email`, 10/15m) and
`authenticateVerifyByIp` (`Key.ip`, 60/15m), all in `passkey.authenticate`. Fixes D1: the email key now uses the
TMS-006 normaliser.

#### 3.12.5 Device authorization

Rule names change: `code-ip` → `codeByIp`, `code-client` → `codeByClient`, `token-invalid-ip` →
`invalidGrantByIp`, `verify-ip` → `verifyByIp`, and so on (Q2). No test pins the old names (grep: none).

```ts
const userCode = "device_authorization.userCode";
const rules = {
  codeByIp: RateLimits.rule({ group: "device_authorization", endpoint: "code", key: RateLimits.Key.ip, ...defaultConfig.codeRateLimit.ip }),
  codeByClient: RateLimits.rule({ group: "device_authorization", endpoint: "code", key: RateLimits.Key.client, ...defaultConfig.codeRateLimit.client }),
  invalidGrantByIp: RateLimits.failureRule({ group: "device_authorization", endpoint: "token", key: RateLimits.Key.ip, ...defaultConfig.invalidGrantRateLimit }),
  verifyByIp: RateLimits.failureRule({ group: "device_authorization.verification", endpoint: "verify", key: RateLimits.Key.ip, bucket: userCode, ...defaultConfig.userCodeRateLimit.ip }),
  verifyBySession: RateLimits.failureRule({ group: "device_authorization.verification", endpoint: "verify", key: RateLimits.Key.session, bucket: userCode, ...defaultConfig.userCodeRateLimit.session }),
  approveByIp: RateLimits.failureRule({ group: "device_authorization.decision", endpoint: "approve", key: RateLimits.Key.ip, bucket: userCode, ...defaultConfig.userCodeRateLimit.ip }),
  approveBySession: RateLimits.failureRule({ group: "device_authorization.decision", endpoint: "approve", key: RateLimits.Key.session, bucket: userCode, ...defaultConfig.userCodeRateLimit.session }),
  denyByIp: RateLimits.failureRule({ group: "device_authorization.decision", endpoint: "deny", key: RateLimits.Key.ip, bucket: userCode, ...defaultConfig.userCodeRateLimit.ip }),
  denyBySession: RateLimits.failureRule({ group: "device_authorization.decision", endpoint: "deny", key: RateLimits.Key.session, bucket: userCode, ...defaultConfig.userCodeRateLimit.session }),
};
const lookupRules = {
  verify: { ip: "verifyByIp", session: "verifyBySession" },
  approve: { ip: "approveByIp", session: "approveBySession" },
  deny: { ip: "denyByIp", session: "denyBySession" },
} satisfies Record<"verify" | "approve" | "deny", { readonly ip: keyof typeof rules; readonly session: keyof typeof rules }>;
```

`satisfies` gives the string literals their contextual type, so no `as const` is needed. The shared bucket
`device_authorization.userCode` must start with one of the owner's groups. `device_authorization` qualifies, so
`open` accepts it.

#### 3.12.6 OAuth

`callback`, `authorize` and `token` (`Key.ip`, spread from `defaultRateLimits.*`). Budget:
`RateLimits.budget(OAuth, { tune: Effect.map(configNow, (config) => config.rateLimits) })`. `OAuthRateLimits`
(`OAuthConfig.ts:53-58`) is exactly `Tuning<typeof rules>`.

#### 3.12.7 API key

Names change: `token-ip` → `tokenByIp` (`Key.ip`), `token-client` → `tokenByClient` (`Key.client`), `resolve-ip` →
`resolveByIp` (`Key.ip`, endpoint stays `"resolve"`, D12).

- `make`: `yield* RateLimits.budget(ApiKey, { tune: Effect.succeed({ tokenByIp: settings.tokenRateLimit.ip, tokenByClient: settings.tokenRateLimit.client, resolveByIp: settings.resolveRateLimit }) })`.
- Handlers and `CredentialContributionsLive` call `RateLimits.budgetOf(ApiKey)`.

#### 3.12.8 SAML, SSO, Webhooks, account export (newly declared, G6)

- **Saml:**
  - Rules `login`, `acs`, `slo` (`Key.ip`) and `admin` (`saml.admin`, endpoint `"*"`, `Key.user`).
  - The defaults move into exported `SamlConfig.defaultRateLimits` and `SamlConfig.defaultAdminRate`, so the config
    default and the table share one source.
  - `tune: Effect.succeed({ ...settings.rateLimits, admin: settings.adminRate })`, minus `sso`, which belongs to
    Sso.
- **Sso:** `{ start: RateLimits.rule({ group: "sso", endpoint: "start", key: RateLimits.Key.ip, ...SamlConfig.defaultRateLimits.sso }) }`.
- **Webhooks:**
  - `{ admin: RateLimits.rule({ group: "webhooks.admin", endpoint: "*", key: RateLimits.Key.user, ...WebhooksConfig.WebhooksConfig.defaultValue().adminRate }) }`.
  - `tune: Effect.map(configNow, (settings) => ({ admin: settings.adminRate }))`.
- **Account export:**
  - A module-level owner, `RateLimits.owner({ id: "account", contract: AuthCore.AuthCoreApi, rateLimits: { exportData: RateLimits.rule({ group: "account", endpoint: "exportData", key: RateLimits.Key.user, limit: 5, window: Duration.hours(1) }) } })`.
  - It is opened in `AccountHandlers`.
  - It appears in the registry but not in the manifest (Q3).

---

## 4. Phased migration

**Rules for every phase.**

- One commit per phase (or a small stack).
- The gate is `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`. Add `pnpm test:bdd` in every
  phase that touches `features/`. The plan gate at the end is `pnpm check`.
- Each phase has a ticket `.scratch/06-rate-limit-budget/issues/NN-*.md` with `Status:` per
  `docs/agents/triage-labels.md`.
- Phase 1 is **additive**. It deletes only the four zero-caller APIs. Plugins migrate one at a time, and every phase
  is green. Phase 11 deletes the legacy APIs.

### Phase 0: Spike against the real types (throwaway branch, nothing merged)

Ticket `01-spike.md`. Timebox: half a day.

1. Add `RateLimitKey.ts` and `RateLimitModel.ts` as in §3.2–3.5, with `budget` stubbed to `Effect.die`. Wire
   `Service`'s `rateLimitRules` generic. Convert **Password** only: table, plus
   `const limits = yield* RateLimits.budget(Password, …)` with **no annotation**.
2. Confirm with `pnpm typecheck`:
   - (a) No TS7022/TS7024 in `Password.layer`.
   - (b) `limits.spend("nope", …)` and a missing input field are errors.
   - (c) `Service` rejects `group: "oauth"` in Password's table.
   - (d) `Class.contract: HttpApi<"auth", Groups>` is assignable to
     `Owner["contract"]` (`{ groups: { readonly [g: string]: unknown } }`).
   - (e) `Schema.is(Schema.Struct({ email: Schema.String }))` accepts an object with extra fields, and is assignable
     to `(input: unknown) => input is { readonly email: string }`.
   - (f) `Effect<Tuning<Limits>>` is assignable to `Effect<ErasedTuning>` with `Limits` generic.
   - (g) `RateLimits.budgetOf(ApiKey)` inside `ApiKeyHandlers`, which is declared before `class ApiKey`, compiles
     without a cycle.
3. **Fallbacks:**
   - If (a) fails, change `AuthPlugin.layer`'s `make` to accept `(limits: Budget<Limits>) => Effect<Shape, E, R>`.
     `AuthPlugin.layer` would then open the budget itself from `plugin.rateLimitRules`, and `tune`/`emailKey` move
     to a `rateLimits` option of `AuthPlugin.layer`. Record the decision in the ticket.
   - If (e) fails, `Key.make` takes an explicit guard written with `Predicate.hasProperty` plus `typeof` checks.
   - If (f) fails, type `BudgetOptions.tune` as `Effect<ErasedTuning>` and type-check plugin tuning through
     `RateLimits.tune`-style helper overloads.
4. Delete the branch. Phase 1 starts from `main`.

### Phase 1: Core module, additive

Ticket `02-core-budget.md`.

**Files.**

1. **NEW `packages/core/src/RateLimitKey.ts`.** Contents as in §3.2.
2. **NEW `packages/core/src/RateLimitModel.ts`.** Contents as in §3.3–3.5, with these moves:
   - Move `RateLimitsRegistry`, `RateLimitsRegistryShape`, `RegisteredRule`, `RateLimitScopeViolation` and
     `RateLimitsFrozen` here from `RateLimits.ts:78-107`.
   - Move `RateLimitDimension` and `RateLimitDeclaration` here from `AuthPlugin.ts:112-131`. During migration,
     `key` and `mode` are **optional** on the declaration.
   - Keep the legacy `RuleInput` and `RateLimitKey` here, marked
     `/** @deprecated removed in plan 06 phase 11 */` (a JSDoc note only, ADR-EA-034 §2).
   - The registry shape keeps the legacy `register(owner: Owner, input: RuleInput)`. `Owner` replaces
     `AuthPlugin.Any`, and `Any` still satisfies it.
   - `RegisteredRule` during migration:
     - legacy fields: `group`, `endpoint`, `key: RateLimitKey`, `limit`, `window`, `escalation?`, `order?`,
       `plugin`, `sequence`;
     - new optional fields: `name?`, `dimension?`, `strategy?`, `mode?`, `bucket?`;
     - entries from `open` set `key` to `(input) => rule.keyOf(bucket, input, context)`, so legacy tests that call
       `entry.key(input)` keep working until Phase 11.
3. **`packages/core/src/RateLimits.ts`.**
   - Add the header line `export * from "./RateLimitModel.ts"` and `export * as Key from "./RateLimitKey.ts"`.
   - Registry `layer` (`:109-162`): add `open` and `handleOf`. Validate scope (reuse the `:121` check), bucket
     prefix, bucket-sharing equality, double open and freeze. Keep `register`.
   - Add `budget`, `budgetOf`, `owner`, the new `bucketKey`, `RateLimitOverrides`, `tune`, `overrides`, `observe`,
     `validSizing` and `UnknownRateLimitRule` (die).
   - **Delete** `rule` (`:164-178`), the old `bucketKey` (`:356-417`), `enforceRule` (`:419-488`) and `phoneKey`
     (`:330-354`). None has a `src` caller, and the names are re-used.
   - Keep `enforce` exported for now. It is still used by unmigrated plugins, and its body calls `observe`.
   - The header comment (`:1-46`) is rewritten to describe the budget.
4. **`packages/core/src/AuthPlugin.ts`.**
   - `Class` gains `Limits`, `rateLimitRules` and `"~rateLimits"` (§3.4).
   - `Service` gains the `Limits` generic and the `rateLimitRules` option.
   - Compute: `rateLimits: options.rateLimitRules === undefined ? options.rateLimits ?? [] : RateLimitModel.declare(options.rateLimitRules)`.
     Legacy `rateLimits` stays until Phase 11.
   - `Any` gains `rateLimitRules?`.
   - The type re-exports `RateLimitDeclaration` and `RateLimitDimension`.
   - Add the guard from §3.10 in `layer` (`:552-568`).
   - Keep `declareRateLimits` (legacy) and fix its doc comment.
5. **`packages/core/src/index.ts:14-17` comment.** Mention the budget. The export line `:54` is unchanged.

**Tests (Phase 1).** See §5.1–5.2 for the cases.

- NEW `packages/core/test/RateLimitKey.test.ts`. Port `phoneKey` cases `RateLimitKeys.test.ts:152-197` to
  `Key.phone`.
- NEW `packages/core/test/RateLimitBudget.test.ts`. Move `RateLimits.test.ts:153-222` (the `enforce`
  event/metric/log cases) here, driven through `spend`.
- NEW `packages/core/test/RateLimitBudget.types.test.ts`.
- `packages/core/test/RateLimits.test.ts`:
  - Delete `:22-74`; the `rule` Layer scope cases are now budget scope cases.
  - Rewrite the ordering and freeze tests (`:76-151`) to use `registry.open` through `budget` with hand-built
    owners from `RateLimits.owner`.
  - Delete `:153-222`, which moved.
- **DELETE** `packages/core/test/RateLimitKeys.test.ts`. The ambient `bucketKey` and `enforceRule` tests are
  removed, and the `phoneKey` cases moved.
- `packages/core/test/PluginDeclarations.test.ts:86-125`: add `rateLimitRules` cases (static declaration derived,
  `key`/`mode` present, foreign group a compile error via `@ts-expect-error`). Leave `:127-167` until Phase 11.

**BDD (Phase 1, because `rule` and `bucketKey` were removed).**

- `features/step-definitions/RegistriesSteps.ts:824-910`: replace `RateLimits.rule(InviteOne, …)` and
  `RateLimits.rule(PasswordFixture, …)` with `Layer.effectDiscard(RateLimits.budget(owner))`. The owners are
  hand-built: `{ id, dependsOn, contract }` from the fixtures, plus a one-rule `rateLimitRules` with `order`.
  `RateLimiter.layerPermissive` and `AuthEvents` go into the test layer.
- `features/step-definitions/RateLimitingSteps.ts:620-650` (REQ-EA-290): derive with
  `RateLimits.bucketKey(RateLimits.rule({ group: "invite", endpoint: "create", key: RateLimits.Key.user /* or Key.ip */, limit: 5, window: "1 minute", bucket: "invite.create" }), { userId: principal.ref.id } /* or { ip: ORIGIN } */)`.
  The scenario wording is unchanged: the handler-resolved `CurrentPrincipal` and origin are what fill the input.
  The assertions (`:652-664`) still hold: `user:alice` is in the key, `alice` is not in the ip key, and the same
  origin gives one bucket.

**Gate.** Phase gate plus `pnpm test:bdd`.

**Changeset.** `.changeset/rate-limit-budget-core.md` (§6.3).

### Phase 2: magic-link and email-otp

Ticket `03-magic-link.md`. This is the simplest plugin; it validates the design end to end.

1. `magic-link/src/MagicLink.ts`:
   - Replace `rules` (`:92-134`) with the table from §3.12.2.
   - Change `rateLimits: AuthPlugin.declareRateLimits(["magicLink"], Object.values(rules))` (`:228`) to
     `rateLimitRules: rules`.
   - In `make`, delete `limiter` (`:241`), `rateLimitsRegistry` (`:242`) and `:247-277`. Add
     `const limits = yield* RateLimits.budget(MagicLink);`.
   - `:283-284` becomes `yield* limits.spend(["requestByIp", "requestByEmail"], input);`.
   - `:324` becomes `yield* limits.spend("verifyByIp", { ip: input.ip });`.
   - `:337` becomes `yield* limits.spend("verifyByToken", { identifier: decoded.value.publicId });`.
   - Drop the `RateLimitRules` import.
2. `magic-link/src/EmailOtp.ts`:
   - Same steps: `:93-135`, `:233`, `:245-276`.
   - `:283-284` becomes `limits.spend(["requestByIp", "requestByEmail"], input)`.
   - `:316-317` becomes `limits.spend(["verifyByIp", "verifyByEmail"], input)`.
3. **DELETE** `magic-link/src/RateLimitRules.ts`.
4. `magic-link/src/Channel.ts:35-48`: **delete** `emailRateKey` and its doc comment. Keep `normalizeEmail`, which
   is used for delivery.
5. `RateLimiter.RateLimiter` stays in `ports`. `budget` requires it, and `PortsComplete` checks that.
6. Tests:
   - **DELETE** `magic-link/test/RateLimitDeclaration.test.ts`.
   - Add one case to an existing magic-link test (e.g. `MagicLink.test.ts`): `requestLink` for `victim+1@x.com` …
     `victim+6@x.com` over `RateLimiter.layerMemory` hits 429 on the 6th. This proves the one normaliser.
7. Gate. Changeset `.changeset/rate-limit-budget-magic-link.md`.

### Phase 3: password (before plan 01)

Ticket `04-password.md`.

1. `password/src/Password.ts`:
   - Add the module-level `rules` table (§3.12.1) after the imports, before `defaultPasswordConfig`.
   - `:141` becomes `rateLimitEmailKey: RateLimits.Key.emailKey`.
   - Update the `rateLimitEmailKey` doc (`:86-92`): "trims, lower-cases, strips `+tag`".
   - `:700-705` becomes `rateLimitRules: rules,`.
   - Delete `limiter` (`:793`) and `rateLimitsRegistry` (`:795`).
   - Replace `:865-880` (registration) and `:928-953` (wrapper) with:
     `const limits = yield* RateLimits.budget(Password, { emailKey: builtConfig.rateLimitEmailKey });`.
     Keep the EP-007 comment (`:784-788`) and edit it to say the budget's email key is boot-scoped.
   - Rewrite the call sites:

     | Lines | New call |
     |---|---|
     | `:994-995` | `limits.spend(["signUpByIp", "signUp"], input)` |
     | `:1147-1148` | `limits.spend(["signInByIp", "signIn"], input)` |
     | `:1261-1262` | `limits.spend(["requestResetByIp", "requestReset"], input)` |
     | `:1322-1323` | `limits.spend(["resendVerificationByIp", "resendVerification"], input)` |
     | `:1350` | `limits.spend("confirmReset", { identifier: publicId })` |
     | `:1468` | `limits.spend("verifyEmailByIp", input)` |
     | `:1476` | `limits.spend("verifyEmail", { identifier: publicId })` |
     | `:1528-1529` | `limits.spend("changeEmail", input)` then `limits.spend("changeEmailTarget", { email: input.newEmail })` |
     | `:1558` | `limits.spend("confirmEmailChangeByIp", input)` |
     | `:1564` | `limits.spend("confirmEmailChange", { identifier: publicId })` |
     | `:1629` | `limits.spend("changePassword", input)` |
     | `:1684` | `limits.spend("reauthenticate", input)` |

   - Keep the RBS-001/AGA-001 ordering comments. Their order is now the array order.
   - Drop the `PasswordRateLimits` import (`:55`).
2. **DELETE** `password/src/PasswordRateLimits.ts`.
3. `password/test/PasswordRateLimits.test.ts`:
   - Delete the RBS-006 `describe` (`:26-122`); it is replaced by core §5.1 K4/K5 and B3.
   - Delete the `defaultEmailRateKey` unit (`:143-148`); it moved to core K1.
   - Delete the drift case (`:185-198`).
   - Keep MLO-003 (`:124-140`), TMS-006 behaviour (`:150-163`) and "rateLimitEmailKey is configurable"
     (`:165-184`).
   - Remove the `PasswordRateLimits` import. Rename the file to `PasswordRateLimitBehaviour.test.ts` so the name
     says what it now tests.
4. BDD `RateLimitingSteps.ts`:
   - `:99-100`: the expected keys become `ratelimit:password.signUp:email:alice@example.com` and
     `ratelimit:password.signIn:email:alice@example.com`.
   - `:717-731`: find the registered rule by `rule.plugin === "password" && rule.endpoint === "signUp" && rule.strategy === "ip"`.
   - `:750-764`: find it by `rule.endpoint === "signIn" && rule.strategy === "email"`.
5. Gate plus `pnpm test:bdd`. Changeset `.changeset/rate-limit-budget-password.md`.

### Phase 4: two-factor

Ticket `05-two-factor.md`.

1. `two-factor/src/SecondFactor.ts`:
   - Replace `failureKey` (`:133-134`) with `failureRule` (§3.12.3).
   - In the budget (`:152-156`), `key` becomes `(userId: Users.UserId) => RateLimits.bucketKey(failureRule, { userId })`.
   - Import `RateLimits` and `TwoFactorConfig` (the latter is already imported).
2. `two-factor/src/TwoFactor.ts`:
   - Add the table (§3.12.3), importing `failureRule`.
   - `:420-424` becomes `rateLimitRules: rules`.
   - Delete `:458-459` and `:462-492`, then add the `budget` call with `tune`.
   - Call sites:
     - `:566` becomes `limits.spend("verifyByIp", { ip: input.ip })`.
     - `:595` becomes `limits.spend("manageByUser", { userId }, { endpoint: "enable" })`.
     - `:615` becomes `{ endpoint: "confirm" }`.
     - `:640` becomes `{ endpoint: purpose === "disable" ? "disable" : "regenerateRecoveryCodes" }`. Read the
       helper's `purpose` union at `:636-639` first.
   - Remove the `TwoFactorRateLimits` import (`:55`).
3. **DELETE** `two-factor/src/TwoFactorRateLimits.ts` and `two-factor/test/RateLimitDeclaration.test.ts`.
4. BDD: `RateLimitingSteps.ts:180-198` filters `verify|` rules. `verifyByIp` (30/15m) and `failureBudget` are both
   on `verify`, so the assertions hold. Run it.
5. Gate. Changeset `.changeset/rate-limit-budget-two-factor.md`.

### Phase 5: passkey

Ticket `06-passkey.md`.

1. `passkey/src/Passkey.ts`:
   - Replace `:421-472` (`RATE_LIMITS`, `RateLimitRuleName`, `ruleMeta`, `emailFromRateLimitInput`) with the table
     from §3.12.4.
   - `:1021-1030` becomes `rateLimitRules: rules`.
   - Delete `:1081-1082`. First check that `limiter` has no other use; `tsc` reports unused locals.
   - Replace `:1131-1199` with `const limits = yield* RateLimits.budget(Passkey);`.
   - `:1450-1459` becomes
     `yield* limits.spend("authenticateOptionsByIp", { ip }); if (email !== undefined) yield* limits.spend("authenticateOptionsByEmail", { email });`.
   - `:1526-1529` becomes `limits.spend("authenticateVerifyByIp", { ip: input.ip })`.
2. **DELETE** `passkey/test/RateLimitDeclaration.test.ts`.
3. Add a case to `passkey/test/PasskeyEnumeration.test.ts`: `victim+1@x.com` … `+11` share the 10-per-15-min
   options budget (D1 fix).
4. Gate. Changeset `.changeset/rate-limit-budget-passkey.md`, which notes the TMS-006 tightening.

### Phase 6: device authorization

Ticket `07-device.md`.

1. `device-authorization/src/DeviceAuthorization.ts`:
   - Replace `:253-341` (`Budget`, `ipKey`, `metaOf`, `makeBudgets`, `allBudgets`) with `rules` and `lookupRules`
     (§3.12.5).
   - `:715-718` becomes `rateLimitRules: rules`.
   - Delete `limiter` (`:747`) and `:757-812`. Add:
     ```ts
     const limits = yield* RateLimits.budget(DeviceAuthorization, { tune: Effect.succeed({
       codeByIp: settings.codeRateLimit.ip, codeByClient: settings.codeRateLimit.client,
       invalidGrantByIp: settings.invalidGrantRateLimit,
       verifyByIp: settings.userCodeRateLimit.ip, approveByIp: settings.userCodeRateLimit.ip, denyByIp: settings.userCodeRateLimit.ip,
       verifyBySession: settings.userCodeRateLimit.session, approveBySession: settings.userCodeRateLimit.session, denyBySession: settings.userCodeRateLimit.session,
     }) });
     ```
   - Call sites:
     - `:883` becomes `limits.spend("codeByIp", { ip: input.ip })`.
     - `:890` becomes `limits.spend("codeByClient", { clientId: client.value.clientId })`.
     - `:945-953`: `const names = lookupRules[endpoint]`, then `limits.guard(names.ip, { ip: who.ip })`, and
       `limits.guard(names.session, { sessionId: who.sessionId })` inside the existing `if`. In `miss`, use
       `limits.charge(…)` the same way.
     - `:1097` becomes `limits.guard("invalidGrantByIp", { ip: input.ip })`.
     - `:1099` becomes `limits.charge("invalidGrantByIp", { ip: input.ip })`.
2. `device-authorization/test/Plugin.test.ts:129-~140`: **delete** the drift case.
3. Add a test that a refused lookup now increments `awthaq.ratelimit.exceeded` (D6). Use the
   `Metric.value(…)` pattern in `core/test/RateLimits.test.ts:188-207`.
4. Gate. Changeset `.changeset/rate-limit-budget-device.md`, with the rule-label renames.

### Phase 7: OAuth

Ticket `08-oauth.md`.

1. `oauth/src/OAuth.ts`:
   - Replace `:703-727` with `rateLimitRules: rules`. The table is module-level and spreads `defaultRateLimits`
     (imported from `OAuthConfig.ts`).
   - In `make`, delete `limiter` (`:813`), `rateLimitsRegistry` (`:816`) and `:821-882`. Keep the OAP-008 comment
     at `:823-830` and move it to the table.
   - Add `const limits = yield* RateLimits.budget(OAuth, { tune: Effect.map(configNow, (config) => config.rateLimits) });`.
     `configNow` is defined at `:753`, which comes first.
   - `:905-919` becomes `yield* limits.spend("authorize", { ip: input.ip });`.
   - `:992-1005` becomes `limits.spend("callback", { ip: input.ip })`.
   - `:1465-1477` becomes `limits.spend("token", { ip: input.ip })`.
   - Re-check the `config` local in each function. It may still be needed for other settings. Do not remove
     `const config = yield* configNow` where it is used elsewhere.
2. `oauth/test/OAuth.test.ts:1659-~1672`: **delete** the PV-241 `describe`. Keep the wire-level authorize 429 in
   `oauth/test/AuthHttp.test.ts`. Add one test: a tenant `OAuth.config` provided in the fiber with
   `rateLimits.authorize.limit: 1` refuses the second call (EP-007 through `tune`).
3. Gate. Changeset `.changeset/rate-limit-budget-oauth.md`.

### Phase 8: API key

Ticket `09-api-key.md`.

1. `api-key/src/ApiKey.ts`:
   - Add the module-level table (§3.12.7) before `ApiKeyHandlers` (`~:500`).
   - `:694-718` becomes `rateLimitRules: rules`.
   - In `make`, `:751` and `:758-797` become the `budget` call with `tune` (§3.12.7). The handle is unused in
     `make`; use `yield*` and discard it.
   - Token handler `:529-548`: delete `limiter`, `events` and `enforce`. Add
     `const limits = yield* RateLimits.budgetOf(ApiKey);`.
   - `:557-562` becomes `yield* limits.spend("tokenByIp", { ip: Option.getOrUndefined(address) });`.
   - `:580-585` becomes `yield* limits.spend("tokenByClient", { clientId: credentials.clientId });`.
   - `CredentialContributionsLive` `:618-633`: delete `limiter` and `events`, add
     `const limits = yield* RateLimits.budgetOf(ApiKey);`, and make `throttle` spend
     `limits.spend("resolveByIp", { ip: Option.getOrUndefined(address) })`.
   - Keep the `mapError(() => new Api.Unauthenticated())` at `:640-642` (D14, intentional).
   - Check whether `ClientAddress` is still needed in `ports`. It is: the handlers resolve the address.
2. **DELETE** `api-key/test/RateLimitDeclaration.test.ts`.
3. Gate. Changeset `.changeset/rate-limit-budget-api-key.md`, with the label renames.

### Phase 9: SAML and SSO

Ticket `10-saml.md`.

1. `saml/src/SamlConfig.ts`:
   - Export `defaultRateLimits` and `defaultAdminRate`, built from the inline defaults at `:132-137` and `:144`.
   - The input `rateLimits?` becomes `Partial<SamlConfigShape["rateLimits"]>`, merged as
     `{ ...defaultRateLimits, ...input.rateLimits }` (D10).
2. `saml/src/Saml.ts`:
   - Add the table (§3.12.8) and pass `rateLimitRules: rules` to `Service` (`:651-656`).
   - In `make`, delete `limiter` (`:678`) and the helper (`:690-704`).
   - Add `const limits = yield* RateLimits.budget(Saml, { tune: Effect.succeed({ login: settings.rateLimits.login, acs: settings.rateLimits.acs, slo: settings.rateLimits.slo, admin: settings.adminRate }) });`.
   - `:742` becomes `limits.spend("login", { ip: input.ip })`.
   - `:1068` becomes `limits.spend("acs", { ip: input.ip })`.
   - Pass closures to the helpers: `SamlAdmin.makeAdmin((adminId, action) => limits.spend("admin", { userId: adminId }, { endpoint: action }))`,
     and in the `makeSlo` deps, `rateLimit: (ip) => limits.spend("slo", { ip })`.
3. `saml/src/SamlSlo.ts`:
   - `SloDeps.limiter` (`:107`) becomes `readonly rateLimit: (ip: string | undefined) => Effect.Effect<void, Api.RateLimited>`.
   - Delete `:114-127`.
   - `:373` becomes `yield* deps.rateLimit(input.ip)`.
4. `saml/src/SamlAdmin.ts`:
   - `makeAdmin` (`:120`) becomes
     `(throttle: (adminId: string, action: string) => Effect.Effect<void, Api.RateLimited>) => Effect.gen(…)`.
   - Delete `limiter` (`:125`).
   - `:146-158` becomes `yield* throttle(caller.ref.id, action)`.
   - The seam is a closure, not the budget type. Passing the budget type would make `SamlAdmin.ts` import
     `Saml.ts` for `typeof rules`, a type cycle.
5. `saml/src/Sso.ts`:
   - Add the table and pass `rateLimitRules` (`:131`).
   - In `make`, delete `limiter` (`:167`).
   - Add `const limits = yield* RateLimits.budget(Sso, { tune: Effect.succeed({ start: settings.rateLimits.sso }) });`.
   - `:236-249` becomes `yield* limits.spend("start", { ip });`.
6. Tests: the existing SAML 429 tests must stay green. Add to a SAML test:
   - `Auth.make([…Saml, Sso]).manifest.rateLimits` lists `saml.login`/`acs`/`slo`/`admin` and `sso.start`;
   - a partial `rateLimits: { login: { limit: 1, … } }` config keeps the other defaults.
7. Gate plus `pnpm test:pg`. The SAML suite has Postgres variants, and the keys changed. Changeset
   `.changeset/rate-limit-budget-saml.md`.

### Phase 10: Webhooks and server account export

Ticket `11-webhooks-server.md`.

1. `webhooks/src/Webhooks.ts`:
   - Add the table and pass `rateLimitRules` to `Service` (`:332-338`).
   - In `make`, delete `limiter` (`:427`). Check that it is unused after the change; `WebhookDelivery` resolves its
     own.
   - Add `const limits = yield* RateLimits.budget(Webhooks, { tune: Effect.map(configNow, (settings) => ({ admin: settings.adminRate })) });`.
   - `:453-470` becomes `yield* limits.spend("admin", { userId: caller.ref.id }, { endpoint: action });`.
2. `server/src/Account.ts`:
   - Delete `EXPORT_RATE_LIMIT` (`:49-50`) and add the module-level `RateLimits.owner(...)` (§3.12.8).
   - In `AccountHandlers`, delete `limiter` (`:59`), add `const limits = yield* RateLimits.budget(accountRateLimits);`,
     and change `:141-157` to `yield* limits.spend("exportData", { userId });`.
3. `server/src/AuthHttp.ts:68-77`: add `| RateLimits.RateLimitsRegistry` to `CoreHandlerServices`.
4. Tests: the webhooks admin 429 and the account export 429 must stay green. Add: the registry lists
   `account.exportData` with `plugin: "account"`.
5. Gate. Changesets `.changeset/rate-limit-budget-webhooks.md` and `.changeset/rate-limit-budget-server.md`.

### Phase 11: Delete the legacy path; docs, spec and BDD

Ticket `12-cleanup.md`.

1. **Core:**
   - Delete `RuleInput`, `RateLimitKey`, registry `register` (shape and implementation), `registerDeclared`,
     `DeclarationDrift`/`declarationDrift`, the `EnforceInput` export, `enforce` (inline it into `observe` users),
     and the `EnforceMeta` export (keep it module-private).
   - `RegisteredRule`: drop `key` as a function, make `name`/`dimension`/`mode`/`bucket` required, rename
     `strategy` to `key` (§3.5), and make `order` a required number.
   - `RateLimitDeclaration.key`/`mode` become required.
   - Delete `AuthPlugin.declareRateLimits` (`AuthPlugin.ts:133-162`) and the `Service` `rateLimits` option
     (`:287-292`). The static `Class.rateLimits` stays, derived.
   - `grep -rn "RateLimits.enforce\|registerDeclared\|declareRateLimits\|declarationDrift\|RuleInput\|RateLimitKey" packages features examples docs`
     must return nothing.
2. `core/test/PluginDeclarations.test.ts:127-167`: delete `registerDeclared`/`declarationDrift`. The `Signal`
   fixture (`:40-60`) moves to `rateLimitRules`.
3. **CLI** `cli/src/Plugin.ts:126-160`:
   - `RuleRow` gains `key` and `mode`.
   - `RULE_HEADER` becomes `["PLUGIN", "RULE", "ENDPOINT", "DIMENSION", "KEY", "MODE", "LIMIT"]`.
   - `cli/test/Inspection.test.ts:208`: the header regex changes.
   - `features/step-definitions/CliSteps.ts` and `features/features/08-tooling/26-cli.feature`: update any
     column-specific assertion. Read them first.
4. **BDD** (§5.4):
   - `RateLimitingWorld.ts:56-90`: the Invite plugin uses `rateLimitRules` with a runtime-chosen group. Use a
     hand-built `Owner` object, not the `owner` helper, because the group is a runtime string. Open it with
     `RateLimits.budget(inviteOwner)` in `make`.
   - `RateLimitingWorld.ts:160-175`: rewrite.
   - `RateLimitingSteps.ts:670-705` (REQ-EA-291): `Key.custom("custom", Schema.Struct({ email: Schema.String }), (input) => `signin:${input.email}`)`.
     The expected values become `ratelimit:invite.signIn:custom:signin:alice@example.com`, or the step asserts on the
     suffix.
   - `CompileTimeGates.ts:78-85`: rewrite the `rate-limit-key-is-a-strategy-or-a-function` gate:
     ```ts
     export const builtInIp = RateLimits.rule({ group: "g", endpoint: "e", key: RateLimits.Key.ip, limit: 1, window: "1 minute" });
     export const customKey = RateLimits.rule({ group: "g", endpoint: "e", key: RateLimits.Key.custom("custom", Schema.Struct({ email: Schema.String }), (input) => input.email), limit: 1, window: "1 minute" });
     // @ts-expect-error - a bare string is not a key strategy: keying on caller-supplied data needs Key.custom
     export const arbitraryKey = RateLimits.rule({ group: "g", endpoint: "e", key: "x-forwarded-for", limit: 1, window: "1 minute" });
     ```
     Keep the `// type-gate:` marker name, because `assertTypeGate` looks it up.
   - New scenarios and gates: see §5.4.
5. **Docs:**
   - `docs/plugin-authoring.md:48-53, :97`: rewrite "Declaring ports and rate limits" (`rateLimitRules`,
     `RateLimits.budget(Self)`, `spend`/`guard`/`charge`, `Key.*`, the guard, no drift test needed).
   - `examples/plugin-template/src/Template.ts`: add one rule (`Key.ip` on its public endpoint) and a `spend`, with
     a test in `examples/plugin-template/test/Template.test.ts` that the 6th call over `RateLimiter.layerMemory`
     answers 429. AGENTS.md calls the template "the working, test-exercised" reference.
   - `packages/core/README.md:8`: replace `declareRateLimits`/`registerDeclared`.
   - `ports/src/SmsSender.ts:11` and `spec/overview.md:124`: `RateLimits.phoneKey` becomes `RateLimits.Key.phone`.
   - `test/src/TestAuth.ts:7-13`: stale header comment ("`Password` is the first real `RateLimits.rule` consumer").
   - `password/src/Password.ts:217-219` and `oauth/src/OAuth.ts:655-657`: comments that mention the limiter's
     unknown bucket. Check the wording.
6. Spec and traceability: §6.1–6.2.
7. Gate: **`pnpm check`** (the full plan gate) plus `pnpm test:pg`. Changeset
   `.changeset/rate-limit-budget-cleanup.md`.

---

## 5. Test plan

The rule is "replace, don't layer". Tests move to the deepened module's interface. Old per-plugin tests that
re-test the moved behaviour are deleted.

### 5.1 `packages/core/test/RateLimitKey.test.ts` (NEW)

| # | Case |
|---|---|
| K1 | `emailKey`: `"  Victim+1@X.com "` → `victim@x.com`; `victim@x.com` unchanged; `+odd@x.com` kept; `no-at-sign` lower-cased; tabs and spaces trimmed. Merges `PasswordRateLimits.test.ts:143-148` with `Channel`'s trim. |
| K2 | `ip`: `{}` and `{ ip: undefined }` → `ip:unknown`; `{ ip: "1.2.3.4" }` → `ip:1.2.3.4`. |
| K3 | `phone` (ported from `RateLimitKeys.test.ts:152-182`): spellings share; different numbers differ; a non-number gives `phone:invalid`. |
| K4 | **No secret reaches a key** (replaces `PasswordRateLimits.test.ts:86-107`). For every built-in key, `part` over a hostile `{ token, password, newPassword, currentPassword, email, identifier, userId, sessionId, clientId, ip, phone }` never contains `SECRET`, `{`, or `}`. |
| K5 | **Wrong-shape input is inert** (replaces `:109-121`). `rule.keyOf("g.n", { password: "SECRET" }, ctx)` is `ratelimit:g.n:invalid`. |
| K6 | `accepts` ignores extra fields (Phase 0 item e, now a regression test). |
| K7 | `custom` prefixes `custom:` and narrows with its own schema. |

### 5.2 `packages/core/test/RateLimitBudget.test.ts` (NEW) and `RateLimitBudget.types.test.ts` (NEW)

The fixtures are hand-built owners from `RateLimits.owner` over a tiny `HttpApi` with groups `invite` and
`invite.admin`, plus one `AuthPlugin.Service` fixture plugin for the guard and cycle tests.

| # | Case |
|---|---|
| B1 | `open` registers the table in table order with `name`, `key`, `mode`, `bucket` and tuned sizing. `registered` orders across owners by dependency, then `order`, then id (moved from `RateLimits.test.ts:77-133`). |
| B2 | Freeze: a `budget` opened after `registered` was read dies `RateLimitsFrozen` (moved from `:134-151`). |
| B3 | `spend` consumes exactly `bucketKey(rule, input)`, checked with a recording limiter (the pattern of `PasswordRateLimits.test.ts:16-24`). This replaces the RBS-006 "registry == enforcement" test structurally. |
| B4 | `spend([a, b])` consumes in order and stops at the first refusal. The second bucket is untouched. |
| B5 | A breach fails `Api.RateLimited` with `retryAfterMillis`. It publishes `auth.rateLimit.exceeded` with `{group, endpoint, rule: name, dimension}` and **no key**, logs a warning without the key, and increments `awthaq.ratelimit.exceeded` (moved from `RateLimits.test.ts:153-222`). |
| B6 | An admitted call emits nothing (moved). |
| B7 | `"*"` endpoint: the event reports `options.endpoint`. |
| B8 | `guard` never counts. It refuses once `charge` has spent the limit, and the refusal is published, logged and counted (D6). `charge` never fails. |
| B9 | Precedence: declared < `tune` < `overrides` layer < fiber `RateLimitOverrides`. Four layers, four limits, each observed. |
| B10 | `tune` is evaluated per call: a fiber-provided config (the `configInForce` pattern) changes the limit without a rebuild. |
| B11 | Escalation via `overrides` (`factor: 2`): the second breach's `retryAfterMillis` exceeds the window. Use `TestClock`, as `ports/test/RateLimiter.test.ts` does. |
| B12 | An invalid override (`limit: 0`, `window: "0 millis"`) dies with `invalidConfiguration` at open (built) and at spend (fiber). |
| B13 | Shared bucket: two rules naming one `bucket` share a counter. Unequal sizing dies `RateLimitBucketConflict`. A bucket outside the owner's groups dies at open. |
| B14 | Scope: a hand-built owner whose rule names a foreign group dies `RateLimitScopeViolation`, readable by `Cause.squash` (BEH-EA-107; replaces `RateLimits.test.ts:40-74`). |
| B15 | Double `budget(owner)` in one registry dies `RateLimitBudgetAlreadyOpen`. |
| B16 | `budgetOf` before open dies `RateLimitBudgetNotOpened`. After open it returns a working handle that shares buckets with the first. |
| B17 | **The guard (generic drift replacement):** an `AuthPlugin.Service` fixture declaring `rateLimitRules` whose `make` never calls `budget` fails `Layer.build` with `RateLimitBudgetNotOpened` naming the plugin and its rules. A plugin with no rules builds without `RateLimits.layer` in scope. |
| B18 | `RateLimiter.layerPermissive`: `spend` never refuses and logs the RBS-007 warning once (end-to-end sanity). |

`RateLimitBudget.types.test.ts` uses `@ts-expect-error` gates, checked by `tsc -p tsconfig.test.json`:

- T1. `spend("unknown", …)`.
- T2. `spend(["signInByIp", "signIn"], { ip })`, which is missing `email`.
- T3. `spend` on a `failureRule`.
- T4. `guard` on an attempts rule.
- T5. `AuthPlugin.Service("p", { contract, rateLimitRules: { x: RateLimits.rule({ group: "foreign", … }) } })`.
- T6. `RateLimits.tune(Fixture, { nope: { limit: 1 } })`.
- T7. `RateLimits.rule({ key: "ip", … })`, a string key.
- T8. **Cycle gate:** a fixture plugin whose `static readonly layer = AuthPlugin.layer(Fixture, { make: Effect.gen(function* () { const limits = yield* RateLimits.budget(Fixture); … }) })` compiles with no annotation. This is the positive check, and a regression guard for §3.9.

### 5.3 Per-plugin tests: deletions and additions

**Deleted** (all of them are drift or RBS-006 tests that the guard (B17) and the type gates now cover):

- `password/test/PasswordRateLimits.test.ts:26-122, :143-148, :185-198` (the file is kept and renamed, Phase 3)
- `two-factor/test/RateLimitDeclaration.test.ts`
- `passkey/test/RateLimitDeclaration.test.ts`
- `api-key/test/RateLimitDeclaration.test.ts`
- `magic-link/test/RateLimitDeclaration.test.ts`
- `device-authorization/test/Plugin.test.ts:129-~140`
- `oauth/test/OAuth.test.ts:1659-~1672`
- `core/test/PluginDeclarations.test.ts:127-167`

**Added** (behaviour that is new, or that the plan fixes):

- magic-link `+tag` sharing (Phase 2)
- passkey `+tag` sharing (Phase 5)
- device guard metric (Phase 6)
- OAuth tenant `tune` (Phase 7)
- SAML manifest listing and partial config (Phase 9)
- account rule registered (Phase 10)
- plugin-template 429 (Phase 11)

**Unchanged and must stay green** (behaviour-level 429s): `password/test/AuthHttp.test.ts`,
`oauth/test/AuthHttp.test.ts`, `passkey/test/PasskeyEnumeration.test.ts`, the device suites, the SAML and Webhooks
admin suites, the server account-export suite, and `two-factor` lockout tests (BEH-EA-266).

### 5.4 BDD changes (`features/`)

| Scenario | REQ | Change |
|---|---|---|
| 14 · 288/289 (BEH-EA-107) | REQ-EA-288, 289 | World `RateLimitingWorld.ts:56-140`: Invite plugin opens `budget` over a hand-built owner with a runtime group. The rejection is still read by `Cause.squash`. Wording unchanged. |
| 14 · 290 (BEH-EA-108) | REQ-EA-290 | Steps `:620-664` use `RateLimits.bucketKey` with `Key.user`/`Key.ip` (Phase 1). Wording unchanged. |
| 14 · 291 | REQ-EA-291 | `Key.custom` (Phase 11). |
| 14 · 292 type gate | REQ-EA-292 | `CompileTimeGates.ts` gate rewrite (Phase 11). |
| 14 · 293/294 | REQ-EA-293, 294 | Registered-rule lookup by `strategy` (Phase 3). |
| 14 · 278 | REQ-EA-278 | Spy keys become `ratelimit:password.*` (Phase 3). |
| 14 · 297 | REQ-EA-297 | Still holds (Phase 4). |
| 03 · registries (BEH-EA-024) | (RegistriesSteps) | `rule` Layer becomes `Layer.effectDiscard(RateLimits.budget(owner))` (Phase 1). |
| **NEW** 14 · BEH-EA-110 | allocated | "An application tunes a shipped rule's limit, or opts it into escalation, without changing the plugin". Password `signIn` with `RateLimits.overrides(tune(Password, { signIn: { limit: 2 } }))` gives 429 on the 3rd attempt. |
| **NEW** 14 · BEH-EA-108 | allocated | "Differently cased and subaddressed addresses share one per-address bucket in every plugin". Password and passkey: `Victim+1@X.com` and `victim+2@x.com` hit one bucket. |
| **NEW** 14 · BEH-EA-111 | allocated | "A plugin that declares rate-limit rules but never opens its budget is refused at composition". Uses the guard. |
| **NEW** 14 · BEH-EA-111 type gate | allocated | "A plugin cannot enforce a rule it did not declare". `// type-gate: spend-names-only-declared-rules` in `CompileTimeGates.ts`. |

New REQ-EA ids are allocated with `features/scripts/allocate-req-ea.py` (next free after REQ-EA-1267). The script
also updates `features/traceability.md`. Then run `pnpm spec:verify:strict` and `pnpm test:bdd`.

---

## 6. Spec, traceability, changesets

### 6.1 `spec/behaviors/14-rate-limiting.md`

Document Control: Revision **1.2 → 1.3**, Effective Date the merge date. Change History:
`1.3 (YYYY-MM-DD): Rate-limit budget (plan 06): rules declared once as a typed table, enforced through RateLimits.budget; key strategies, one email normaliser, application overrides; SAML/SSO/Webhooks/account rules declared (CCR-EA-0NN)`.
Take the next CCR number from the last change-history entries across `spec/`.

- **Banner** (line 16): add `RateLimitKey.ts` and `RateLimitModel.ts`, and the tests
  `packages/core/test/RateLimitBudget.test.ts`, `RateLimitKey.test.ts` and `RateLimitBudget.types.test.ts`.
- **BEH-EA-105** RBS-009 paragraph: replace "an application opts a rule in explicitly" with *As shipped (plan 06)*:
  `RateLimits.overrides(RateLimits.tune(Plugin, { rule: { escalation } }))`, for any shipped rule.
- **BEH-EA-106** "Every breach is observable": "A plugin enforces its rules through `RateLimits.enforce`" becomes
  "through its budget (`RateLimits.budget(...).spend`/`guard`). The one observation site publishes, logs and
  counts. `charge` (a failure-budget charge) is silent."
- **BEH-EA-107** *As shipped*:
  - The rules are a table on the plugin class (`AuthPlugin.Service`'s `rateLimitRules`). A foreign group is a
    compile error.
  - `RateLimits.budget` refuses one at layer build for a hand-built owner (`RateLimitScopeViolation`, a defect).
  - The `AuthRateLimits.rule(...) => Layer` shape in the code block is historical. Add an *Implementation* note
    rather than editing the normative block.
- **BEH-EA-108**:
  - Rewrite the *As shipped (PV-240)* paragraph as *As shipped (plan 06)*:
    - the key strategies `RateLimits.Key.{ip,email,identifier,user,session,client,phone,custom}`;
    - the bucket key format `ratelimit:<bucket>:<part>`;
    - the one normaliser `Key.emailKey` (trim, lower-case, strip `+tag`), with `PasswordConfig.rateLimitEmailKey` as
      the override;
    - an inert `invalid` bucket for wrong-shape input.
  - Add a **Deviation** note: the built-ins read fields that the endpoint's handler resolves from
    `ClientAddress`/`CurrentPrincipal` and passes in. They do not read the ambient request, because a non-HTTP
    caller (CLI, import job) has no request. The requirement text (derive from principal, origin or an explicit
    function; never an arbitrary caller value without opt-in) is satisfied: `Key.custom` is the explicit opt-in.
  - Replace the RBS-006/TMS-006 paragraph with the table-and-budget wording.
- **BEH-EA-110**: add a list of the rules each official plugin ships, a short version of §3.12. Name SAML, SSO,
  Webhooks and the core account export as covered.
- **BEH-EA-111** *As shipped (PV-241)*:
  - The declaration is derived from the same table that `budget` registers, so the two cannot differ except by
    tuning.
  - `declarationDrift` is removed.
  - `AuthPlugin.layer` refuses a plugin that declares rules and never opens its budget (`RateLimitBudgetNotOpened`).
  - The registry records tuned values plus `name`, `key`, `mode` and `bucket`.
  - `plugin list --rules` prints KEY and MODE.

No new BEH-EA ids are needed: every change is an *As shipped* or *Deviation* update of 105–111. The new scenarios
attach to the existing `Rule:` tags.

**Other spec files:**

- `spec/behaviors/31-two-factor.md:188` and `spec/decisions/020-two-factor-state.md:25`:
  `two_factor:fail:<userId>` becomes "the `SecondFactor.failureRule` bucket (`ratelimit:two_factor.failures:user:<userId>`)".
  Bump both Document Control revisions with a change-history line. ADR-020 is a key-name detail, not a decision
  change; say so.
- `spec/behaviors/03-ports-slots-hooks-registries.md:172-179` (BEH-EA-024 example): replace
  `RateLimits.rule({ group: "acme.invite", … })` inside `taps:` with a `rateLimitRules` table on `Service` and
  `RateLimits.budget(Invite)` in `make`. Bump the revision.
- `spec/behaviors/26-cli.md:72` (BEH-EA-202 *As shipped*): `--rules` columns gain KEY and MODE. Bump the revision.
- `spec/behaviors/29-saml-sp.md:294`, `34-webhooks.md:148`, `37-device-authorization.md:152`: add one sentence each
  saying these rules are now declared and can be tuned with `RateLimits.overrides`, with the knob names unchanged.
  Bump the revisions.
- `spec/overview.md:124`: `RateLimits.phoneKey` becomes `RateLimits.Key.phone`.

### 6.2 `spec/traceability.md`

- §1 row `:40` (`14 Rate Limiting | 105-112`): the implementation cell becomes
  `@awthaq/core/src/RateLimits.ts (with RateLimitModel.ts, RateLimitKey.ts)`.
- §5 test-file rows:
  - Replace the `packages/core/test/RateLimits.test.ts` row (`:195`) with its new scope (ordering and freeze over
    `open`).
  - Add rows for `RateLimitBudget.test.ts` (BEH-EA-105/106/107/110/111: B1–B18), `RateLimitKey.test.ts`
    (BEH-EA-108: K1–K7) and `RateLimitBudget.types.test.ts` (BEH-EA-107/108/111: T1–T8).
  - Remove the `RateLimitKeys.test.ts` row if there is one; grep for it.
- §6 crosswalk row `:311`: scenario counts change. Re-run the allocator and copy the totals.
- Bump `traceability.md`'s Document Control with a change-history line.

### 6.3 Changesets (ADR-EA-034: every package-visible change, with a `Migration:` section)

All packages are one `fixed` group (`.changeset/config.json`). Bump `minor` for packages with breaking changes
(pre-1.0) and `patch` for internal-only changes.

**`.changeset/rate-limit-budget-core.md`** (Phase 1, `@awthaq/core: minor`)

> Rate-limit rules are declared once and spent by name (BEH-EA-105–111, plan 06).
> `AuthPlugin.Service(id, { rateLimitRules: { name: RateLimits.rule({ group, endpoint, key: RateLimits.Key.ip, limit, window }) } })`
> declares a typed table (`RateLimits.failureRule` for a BCR-006 failure budget). The static `rateLimits`
> (`plugin list --rules`) is derived from it. `yield* RateLimits.budget(Self, { tune, emailKey })` in `make`
> registers it and returns a handle: `spend(names, input)`, `guard`, `charge`. A breach is published, logged,
> counted and answered with `Api.RateLimited`. `RateLimits.budgetOf(Self)` gets the handle elsewhere.
> `RateLimits.overrides(RateLimits.tune(Plugin, { rule: { limit, window, escalation } }))` tunes any shipped rule,
> and `RateLimitOverrides` can be provided per fiber (tenant). `AuthPlugin.layer` refuses a plugin that declares
> rules but never opens its budget.
>
> **Migration:**
> - `RateLimits.rule(owner, input)` (Layer) → the `rateLimitRules` table plus `RateLimits.budget(owner)`.
> - `RateLimits.bucketKey(rule, input?)` with `"ip"`/`"principal"` → `RateLimits.bucketKey(rule, input)` over
>   `RateLimits.Key.*`; the caller passes `{ ip }`/`{ userId }`.
> - `RateLimits.enforceRule` → `budget(...).spend`.
> - `RateLimits.phoneKey(read, options)` → `RateLimits.Key.phone(options)` reading `{ phone }`.

**`.changeset/rate-limit-budget-cleanup.md`** (Phase 11, `@awthaq/core: minor`, `@awthaq/cli: minor`)

> **Migration:** removed `RateLimits.enforce`, `EnforceInput`, `RuleInput`, `RateLimitKey`, `registerDeclared`,
> `declarationDrift`/`DeclarationDrift`, `RateLimitsRegistry.register`, `AuthPlugin.declareRateLimits`, and the
> `Service` option `rateLimits`.
> - Declare rules with `rateLimitRules`. Enforce with `RateLimits.budget`.
> - `RegisteredRule.key` is now the strategy name (`"ip"`, `"email"`, …), not a function.
> - `RateLimitDeclaration` gains `key` and `mode`.
> - `plugin list --rules` prints KEY and MODE columns, and JSON rows carry `key` and `mode`.
> - **Bucket keys are renamed** to `ratelimit:<group>.<rule>:<strategy>:<value>`. A deploy resets live counters
>   once (rows in `RateLimiterStoreSql` expire within their window, at most 1 hour). Two-factor lockouts in
>   progress are lifted.

**Per-plugin changesets** (each has a **Migration:** line):

- `-magic-link` (`minor`): `Channel.emailRateKey` removed → `RateLimits.Key.emailKey`.
- `-password` (`patch`): `rateLimitEmailKey`'s default now also trims. `changePassword`/`reauthenticate`/
  `changeEmail` breaches report `dimension: "principal"` (was `"identity"`).
- `-two-factor` (`minor`): `SecondFactor.failureKey` removed → `RateLimits.bucketKey(SecondFactor.failureRule, { userId })`.
  `failureBudget` reports `principal`. `manageByUser` events report the real endpoint
  (`enable`/`confirm`/`disable`/`regenerateRecoveryCodes`) instead of `manage`.
- `-passkey` (`patch`): the per-email options budget now normalises case, whitespace and `+tag` (TMS-006).
- `-device` (`minor`): rule labels renamed:
  - `code-ip` → `codeByIp`
  - `code-client` → `codeByClient` (dimension `identity`)
  - `token-invalid-ip` → `invalidGrantByIp`
  - `{verify,approve,deny}-ip` → `{verify,approve,deny}ByIp`
  - `-session` → `BySession`

  Refused lookups now also log and count.
- `-oauth` (`patch`): registry keys now match enforcement. No API change.
- `-api-key` (`minor`): labels `token-ip` → `tokenByIp`, `token-client` → `tokenByClient` (dimension `identity`),
  `resolve-ip` → `resolveByIp`.
- `-saml` (`minor`):
  - `login`/`acs`/`slo`/`admin` and SSO `start` are now declared and registered.
  - `SamlConfig.config({ rateLimits })` accepts a partial (the others keep defaults).
  - New exports `SamlConfig.defaultRateLimits`/`defaultAdminRate`.
  - Admin breaches report the action as `endpoint` (unchanged).
- `-webhooks` (`patch`): `admin` declared and registered.
- `-server` (`minor`): `AuthHttp.CoreHandlerServices` now includes `RateLimits.RateLimitsRegistry`. Every
  composition that installs a plugin already provides `RateLimits.layer`, and `TestAuth.layer` does. The account
  export rule is registered.

---

## 7. Risks, mitigations, rollback

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| R1 | The inference cycle reappears with real `HttpApi`/`Effect` types | low (scratch reproduces cause and fix) | Phase 0 (a). Fallback: `make: (limits) => …` inside `AuthPlugin.layer` (§4 Phase 0.3). |
| R2 | The bucket-key rename resets live counters, including in-progress 2FA lockouts, during a rolling deploy | certain, once | Windows are ≤ 1 h (2FA 15 min). Documented in the changeset. Q1 offers explicit `bucket`s that reproduce today's strings. |
| R3 | Dashboards keyed on rule labels or dimensions (device, api-key, password, two-factor) break | medium | Label and dimension mapping tables in the changesets. Q2 can keep old labels by naming table keys `"code-ip"` (valid quoted keys). |
| R4 | `Schema.is` on the hot path (every sign-in) | negligible | One-field struct check, compiled once per key at module load. B3/B5 run in the normal suite. Optional micro-bench in Phase 0. |
| R5 | Per-call `tune` and `overrides` reads add latency | negligible | Two `Context` reads plus an object spread per spend. |
| R6 | The guard fires for a legitimate plugin layer variant that does not enforce | low | The guard checks only plugins with a non-empty table. Two layers of one class both run `make`, so both open. |
| R7 | An app override tunes one rule of a shared bucket (device) and the spend dies `RateLimitBucketConflict` | low | Validated at open for built values. Documented on `tune`/`overrides`. Alternative: forbid overriding a shared-bucket rule individually (Q10). |
| R8 | Merge conflicts with plans 01/07/09/10, which touch the same plugin files | medium | Order 06 before 01 (README). §8 lists the exact seams. Each phase is small and per plugin. |
| R9 | Hidden callers of removed exports (examples, BDD `lib/`, archive) | low | Phase 11 grep. `features/lib/*.d.ts` are build outputs: rebuild them, never hand-edit. `archive/` and `.plan/` are historical and stay untouched. |
| R10 | `AuthHttp.CoreHandlerServices` gains a requirement and an app that served `coreHandlers` without `RateLimits.layer` stops compiling | low | Every composition with a plugin already needs it. Changeset migration line. Alternative: `Effect.serviceOption` in `AccountHandlers` (Q3). |
| R11 | `knip` flags new exports with no in-repo use (`overrides`, `tune`) | medium | Used by `RateLimitBudget.test.ts` and the new BDD scenario. If knip only counts `src`, add an `examples/memory-server` override as a documented real caller, or a knip ignore entry with a comment. |

**Rollback.**

- Phase 1 is additive, apart from four zero-caller APIs.
- Phases 2–10 are each one plugin, and each can be reverted on its own, because the legacy `register`/`enforce`
  stay until Phase 11.
- Phase 11 is pure deletion plus docs. Reverting it restores the legacy path with no data impact.
- The port and stores are untouched (N1), so no data migration is ever needed.
- Bucket-key renames are not reverted by a code revert. Counters re-key again, which has the same one-time cost as
  R2.

---

## 8. Interactions with other plans

- **01 Sign-in and sign-up in core.**
  - After this plan, the Password preambles are one line each: `yield* limits.spend(["signInByIp", "signIn"], input)`
    (`Password.ts:1147-1148`) and `limits.spend(["signUpByIp", "signUp"], input)` (`:994-995`). Passkey's
    `authenticateOptions`/`authenticateVerify` preambles shrink the same way.
  - When 01 moves sign-in completion into core `SignIn`, **the spends stay in the plugins**, before credential
    work. They are plugin-owned rules (BEH-EA-107), and core must not spend another plugin's budget. 01 needs no
    `Budget` type in core `SignIn`'s interface.
  - If 01 wants IP keys from `AuthRequestContext` rather than the handler-passed `ip`, two options:
    - (a) 01's preamble reads `AuthRequestContext.ip` and passes `{ ip }`. No change to this plan.
    - (b) Add an effectful `Key.requestIp`. That changes `Key.part` to return `Effect<string>`, which is internal to
      core, and adds one strategy.
  - Warning for (b): `server/src/RequestContext.layer` is **optional** middleware. Without it `ip` is `None`, and
    every caller would share the `unknown` bucket. Every user of the site would then be throttled together, the
    NATed-office failure BEH-EA-108 and REQ-EA-293 describe. (b) is safe only once `AuthHttp` installs
    RequestContext unconditionally.
  - Order: 06 before 01, so 01 rewrites one-liners, not wrappers.
- **07 `Verification.redeem` owns the transaction protocol.** The identifier-keyed rules spend on the token's
  **public id before** consumption: Password `confirmReset` `:1350`, `verifyEmail` `:1476`, `confirmEmailChange`
  `:1564`, and MagicLink `verifyByToken` `:337`. 07 must keep the order "decode → spend → redeem". Either
  `redeem` exposes the decoded public id before its transaction, or the plugin decodes first, as today. Spending
  inside the redeem transaction would roll back with a failed completion; the limiter is not transactional, but the
  order still matters for attempts. 07 needs nothing from 06 beyond keeping the spend at the plugin edge.
- **09 Event metadata travels with the event schema.** `auth.rateLimit.exceeded` is published only from
  `RateLimits.observe` after this plan (today: `enforce` plus device `assertBudget`). 09's `defineEvent` change to
  `RateLimitExceededEvent` (`AuthEventSchemas.ts:812`) touches no publish site. 09's table at line 60 lists this
  event's publishers as "core, device-authorization". After 06 it is core only. If 09 lands first, no conflict.
- **10 Standalone fixes, item 5 (events from rolled-back transactions).** It classifies `auth.rateLimit.exceeded`
  as an *attempt* event that is published `afterUnit`. That change sits inside `AuthEvents.publish`; `observe`
  calls `events.publish` unchanged. 10's interaction table (`10-standalone-fixes/PLAN.md:1045`) already says
  "06: none".
- **08 Test composition.** `TestAuth.layer` keeps providing `RateLimits.layer` and `RateLimiter.layerPermissive`
  (`test/src/TestAuth.ts:139-140`). The guard (§3.10) relies on the registry being in the bundle. 08's bundles
  should keep it.
- **02, 03, 04, 05:** no shared seam. Rate-limit store keys are opaque to the SQL store (`sql/src/RateLimiterStoreSql.ts`).

---

## 9. Acceptance checklist

- [ ] `packages/password/src/PasswordRateLimits.ts`, `packages/two-factor/src/TwoFactorRateLimits.ts` and
      `packages/magic-link/src/RateLimitRules.ts` are deleted.
- [ ] `grep -rn "RateLimits.enforce\b\|registerDeclared\|declareRateLimits\|declarationDrift\|RuleInput\|RateLimitKey\b\|emailRateKey\|defaultEmailRateKey\|failureKey\|phoneKey\|enforceRule" packages examples docs features/step-definitions`
      returns nothing.
- [ ] `grep -rn "inference cycle\|TS circularity" packages/*/src` returns no rate-limit site (§2.4's eight are
      gone).
- [ ] `grep -rn 'catchTag(\s*"RateLimitExceeded"' packages/*/src` returns only `core/src/RateLimits.ts`,
      `two-factor/src/SecondFactor.ts` and `webhooks/src/WebhookDelivery.ts`.
- [ ] No `as`, `as unknown as` or `as any` in any changed source file.
- [ ] No return-type annotation on a new Effect or Layer const.
- [ ] Every plugin in §2.2 declares its rules through `rateLimitRules`, including SAML, SSO and Webhooks.
      `Auth.make([...]).manifest.rateLimits` lists them with `key` and `mode`.
- [ ] Every enforced rule appears in `RateLimitsRegistry.registered` with a key derivation identical to what is
      consumed (B3).
- [ ] A plugin declaring rules without opening its budget fails layer build (B17). Undeclared names fail to compile
      (T1, T8).
- [ ] `RateLimits.overrides` tunes and escalates any shipped rule. A fiber-provided override wins (B9–B11, new BDD
      scenario).
- [ ] Passkey, password, magic-link and email-otp share one email normaliser. `+tag` aliases share a bucket in each
      (Phases 2, 3, 5 tests, new BDD scenario).
- [ ] Device guard refusals are logged and counted (Phase 6 test).
- [ ] `spec/behaviors/14-rate-limiting.md` is at rev 1.3 with the BEH-EA-105–111 updates.
      `31-two-factor.md`, ADR-020, `03-…`, `26-cli.md`, `29-…`, `34-…`, `37-…` and `overview.md` are updated with
      revision bumps.
- [ ] `spec/traceability.md` §1, §5 and §6 are updated. `pnpm spec:verify:strict` passes.
- [ ] Changesets exist for core, cli, password, two-factor, magic-link, passkey, device-authorization, oauth,
      api-key, saml, webhooks and server, each with a `Migration:` section where breaking.
- [ ] `docs/plugin-authoring.md` and `examples/plugin-template` show the budget. The template test proves a 429.
- [ ] `pnpm check` and `pnpm test:pg` are green.
- [ ] Tickets in `.scratch/06-rate-limit-budget/issues/` are all `Status:` resolved.

---

## 10. Open questions (only the user can answer)

- **Q1. Bucket-key rename.** Accept the uniform `ratelimit:<bucket>:<part>` format (a one-time counter reset,
  including lifting in-progress 2FA lockouts)? Or reproduce today's strings exactly with explicit `bucket`s and a
  per-strategy legacy formatter? The default in this plan is to rename.
- **Q2. Labels and dimensions.**
  - Rename the kebab-case rule labels (device, api-key) to camelCase table keys?
  - Re-label `userId`-keyed rules as `principal` and `clientId` rules as `identity`?
  - Both are observable in events and metrics. The default is yes to both.
- **Q3. Core-owned rules in the manifest.** The account export rule (owner `"account"`) is registered but not in
  `manifest.rateLimits` or `plugin list --rules`, because `Auth.make` folds only plugins. Should `Auth.make` add
  core's own table to the manifest?
- **Q4. Per-plugin knobs vs. the generic override.** Keep `OAuthConfig.rateLimits`,
  `DeviceAuthorizationConfig.*RateLimit`, `ApiKeyConfig.*RateLimit`, `SamlConfig.rateLimits`/`adminRate`,
  `WebhooksConfig.adminRate` and `TwoFactorConfig.failureLimit/Window` (this plan keeps them, as `tune`)? Or
  deprecate them in favour of `RateLimits.overrides` only, which is one path and less surface?
- **Q5. Second-factor lockout observability.** Should a refused second-factor attempt (budget spent) also publish
  `auth.rateLimit.exceeded` and count the metric (uniform EOTS-007)? Today it publishes only
  `auth.twoFactor.locked`, once, when the lock takes effect. This plan keeps today's behaviour.
- **Q6. Disabling a shipped rule.** Should `overrides` accept `false` to switch a rule off (e.g. behind a WAF)?
  BEH-EA-110 argues against it; this plan does not offer it.
- **Q7. Endpoint confinement at the type level.** Should a rule's `endpoint` be confined to its group's real
  endpoint names or `"*"`, as `group` already is? `apikey.resolve` would then need a different representation,
  since it is a credential resolver and not an endpoint.
- **Q8. Webhook delivery pacing.** Should `webhooks:deliver:<endpointId>` become a declared rule with a third mode
  (`"pacing"`, defers rather than refuses, publishes nothing)? Or stay a raw port use (this plan)?
- **Q9. Unthrottled surfaces.** Admin, organization and SCIM have no rate limits today. SCIM's bearer-token
  endpoints in particular are machine-to-machine. Is that intentional, or should a follow-up plan add rules?
- **Q10. Shared-bucket overrides.** Dying on a per-rule override of a shared bucket (device `userCode`) is strict.
  Alternatives: an override on any member applies to all members of the bucket, or overrides address the bucket by
  name.

---

## 11. Decisions taken (execution)

Open questions were answered with the plan's recommended default; where the plan gave none, the richest option with a real caller.

1. **Q1 bucket-key rename**: accepted (plan default). Every rule moved to a budget uses `ratelimit:<bucket>:<part>`; each per-plugin changeset lists the old and new spellings, and the counter reset (including second-factor lockouts in progress) is called out in the core and cleanup changesets.
2. **Q2 labels and dimensions**: renamed to camelCase table keys and re-labelled (`userId` rules `principal`, `clientId` rules `identity`), as planned.
3. **Q3 core-owned rules in the manifest**: no. The account export rule is in the registry (owner `account`) but not in `manifest.rateLimits`.
4. **Q4 per-plugin knobs**: kept as `tune` (`OAuthConfig.rateLimits`, `DeviceAuthorizationConfig.*RateLimit`, `ApiKeyConfig.*RateLimit`, `SamlConfig.rateLimits`/`adminRate`, `WebhooksConfig.adminRate`, `TwoFactorConfig.failure*`); no deprecation.
5. **Q5 second-factor lockout observability**: unchanged (`SecondFactorLocked`, `auth.twoFactor.*`, no `auth.rateLimit.exceeded`).
6. **Q6 disabling a rule**: not offered.
7. **Q7 endpoint confinement at the type level**: not done; `group` stays confined, `endpoint` is a free string (or `"*"`).
8. **Q8 webhook delivery pacing**: stays a raw `RateLimiter.consume`.
9. **Q9 unthrottled surfaces**: left as is (admin, organization, SCIM); a follow-up plan decides.
10. **Q10 shared-bucket overrides**: strict at open. Built values of rules sharing a (bucket, key strategy) must agree, otherwise `RateLimitBucketConflict`; see adaptation 2 below for the refinement.

Phase 0 (typing spike), done against the real `HttpApi`/`Effect` types while building phase 1:

- (a) no TS7022/TS7024 in `Password.layer`, `MagicLink.layer`, `ApiKey.layer`, `Sso.layer`, `TwoFactor.layer`; the cycle gate T8 compiles. (b) `spend("nope")`, a missing input field, `spend` of a failure rule and `guard` of an attempts rule are errors (T1-T4). (c) `Service` rejects a foreign group (T5). (d) `Class.contract` is assignable to `Owner["contract"]`. (e) `Schema.is` over a struct accepts extra fields and is assignable to the `accepts` guard. (f) `Effect<Tuning<Limits>>` is assignable to `Effect<ErasedTuning>` with `Limits` generic. (g) `RateLimits.budgetOf(ApiKey)` inside `ApiKeyHandlers` and `CredentialContributionsLive`, both declared before `class ApiKey`, compiles without a cycle. No fallback of section 4 phase 0.3 was needed.

Adaptations to the plan text, found while executing:

1. **`bucket` rides in the rule's type.** `bucketKey(rule, input)` needs an explicit bucket (it has no table name to derive a default from), and `bucket: string | undefined` on `Rule` cannot express that. `rule`/`failureRule` are overloaded on `bucket` (`Rule<...> & { readonly bucket: Bucket }`), so passing a rule without one to `bucketKey` is a compile error. Overloads, no assertions.
2. **A counter is a (bucket, key strategy) pair.** The plan's `open` required equal mode/limit/window for every rule naming one bucket. Device authorization's six user-code lookup rules share the bucket `device_authorization.userCode` but key on `ip:` and `session:` parts with independently configurable sizing (`userCodeRateLimit.ip` vs `.session`), so the plan's check would have died at build for a deployment configuring them differently. The conflict check now keys on (bucket, strategy); rules of different strategies share a bucket name with their own sizing, and the same strategy must agree. The bucket-prefix rule (must start with one of the owner's groups) is unchanged.
3. **Account export in the registry.** `AccountHandlers` opens `RateLimits.budget(accountRateLimits)`, so it appears in `registered` under owner `account`; BDD readers that assume "only plugin rules" (REQ-EA-289, REQ-EA-298) filter that owner out.
4. **Declaration-emit portability.** A plugin that only spends a budget (`Sso`, `AccountHandlers`) has `AuthEvents`/`RateLimiter` in its inferred `layer` type but no import to name them (TS2883). `RateLimits.Events` and `RateLimits.Limiter` re-export them so the `RateLimits` namespace every such plugin already imports is the path.
5. **Template rule keys on the user.** The plan said `Key.ip` on the template's public endpoint; the template's only throttled endpoint is authenticated (`create`), so the rule is `createByUser` on `Key.user` (5 a minute), and the test shows the sixth call answering 429 per caller.
6. **BEH-EA-108 alias scenario uses password only.** The new BDD scenario drives the password plugin; the magic-link and passkey `+tag` sharing are unit tests (`MagicLink.test.ts`, `EmailOtp.test.ts`, `PasskeyEnumeration.test.ts`), since the cross-cutting world composes only password.
7. **Tests of core's ordering and freeze** moved into `RateLimitBudget.test.ts` (B1/B2) rather than staying in a rewritten `RateLimits.test.ts`, which is deleted.
8. New BDD ids are REQ-EA-1271..1274 (BEH-EA-108 alias scenario, BEH-EA-110 override scenario, BEH-EA-111 guard and type-gate scenarios).
9. `pnpm-lock.yaml` and `examples/plugin-template/package.json`/`tsconfig.json` gained `@awthaq/ports` (the template's `ports: [RateLimiter.RateLimiter]`); the lockfile entry was edited by hand because the registry is unreachable offline and `pnpm install --frozen-lockfile` accepts it.
- `pnpm test:pg` ran against a throwaway Postgres container and passed (30 files, 648 tests); `pnpm knip` reports only the 101 untracked `.reports/` files; `pnpm package:smoke` passed on a retry (a first run hit a transient `ENOSPC` in the npm cache while the disk was full).
