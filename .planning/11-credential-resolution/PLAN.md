# Plan 11: One credential-resolution module beneath every entry point

| Property | Value |
|---|---|
| Strength | Strong (review of 2026-10-17). Two live bugs, one of them total for a supported configuration: every `@awthaq/next`/`@awthaq/web` deployment on `SessionCookie.SecureDomain` gets `undefined` from `getSession` |
| Dependency category | in-process (one module in `@awthaq/server`; its HTTP and cookie-jar adapters), plus three local housekeeping helpers |
| Wave / order | Phase 0 (both hotfixes) is Wave 0, shippable alone. Phase 1 (helpers) before **plan 13** (admin gate). Phases 2 to 6 after Phase 1, independent of plans 12, 14, 16 to 24 except where §8 says |
| Fixes live bugs | **A:** web/next `getSession`, `hasSessionCookie` and `applyRotatedSession` ignore `SessionCookieConfig`: under `SecureDomain` (`__Secure-session`) `getSession` always resolves `undefined`, `hasSessionCookie` always answers `false`, and a rotation is written as `__Host-session` with `SameSite=Strict` and no `Domain`. **B:** qadi Path B (`SubjectExtractorLive`) takes the first *present* credential and never falls through: a stale cookie plus a valid bearer is anonymous on Path B and the user on Path A; a failing `x-api-key` plus a valid bearer is anonymous on Path B and the user on Path A's machine tier |
| Execution tickets | `.scratch/credential-resolution/issues/NN-*.md`, one per phase below (`docs/agents/issue-tracker.md`) |

Every `file:line` below was checked against the tree at `fc990c88` (2026-10-17). Both live bugs were reproduced with throwaway scripts run from the scratchpad (not committed): the outputs are quoted in §2.4 and §2.5. Re-check line numbers before editing: plans 13, 15 and 21 touch some of the same files.

---

## 1. Summary, goals, non-goals

### Summary

"Which credential on this request names the caller, and what is it allowed to be" is one policy:

1. the impersonation cookie, counted only when its session carries `actingAs` (APS-006);
2. the session cookie (its name comes from `SessionCookieConfig`, IC-007);
3. `x-api-key`, on the machine tier only (OCM-002);
4. `Authorization: Bearer`, offered to the claimed-credential registry first and to `Sessions` otherwise (MAPS-001);
5. a credential that does not resolve falls through to the next one; a store outage stops the chain with 503 (MA-004);
6. the tier admits only some principals (the user tier only `User`, BEH-EA-066);
7. a rotated session secret is delivered back the way it came (a `Set-Cookie` under the configured name and attributes, or `set-auth-token`; PIL-005).

Today the policy is written **four times**, and the copies have drifted:

- `packages/server/src/Authentication.ts:642-746` (`makeSessionTierHandlers`, the user and machine tiers) and `:797-908` (`OptionalAuthenticationLive`). The optional tier re-declares `authenticate` (`:806-822`, a copy of `:646-665`) and `authenticateBearer` (`:825-843`, a copy of `authenticateCarried` `:670-692` with the machine flag fixed to `false`), and re-runs the whole chain by hand inside its first handler (`:861-905`).
- `packages/qadi/src/SubjectExtractor.ts:31-60` (`extractCredential`, whose comment says the order is "replicated here") and `:84-135` (the impersonation preamble and the single resolution). It falls through on nothing (**bug B**).
- `packages/web/src/Session.ts:143-162` (`makeGetSession`) and `:190-208` (`applyRotatedSession`), plus `packages/web/src/HasSessionCookie.ts:32-33`. They read the *default* cookie names from `Api.SessionCookie.key`/`Api.ImpersonationCookie.key` and render the rotation under `SessionCookieConfig.defaultValue()` (**bug A**). `@awthaq/next` (`GetSession.ts:32`, `index.ts:20`) re-exports them.

This plan makes credential resolution a **deep** module, `Credentials`, in `@awthaq/server`. Its interface is small: read what a request presents (`presented`), pick a tier derived from the middleware *declaration* (so BEH-EA-072's "the record is the chain" holds for every entry point), and run either one carrier (`step`, for Path A's per-scheme handlers, where Effect's security loop is the chain) or the whole chain (`resolve`, for the optional tier, Path B and the web adapter). Its implementation holds everything the four copies share: the per-request single-flight memo (now covering claimed credentials too), the outage short-circuit, the impersonation rule, tier admission, the rotation hand-off, spans and logs. Two adapters sit at its seam, a `Scope`: an HTTP scope (memo keyed on `request.source`, rotation delivered by a pre-response handler, claims through the `CredentialResolvers` registry) and a collecting scope (a web call: rotations collected and rendered under the configured cookie for a framework jar). `Authentication.ts`, `SubjectExtractor.ts` and web's `Session.ts` become thin adapters.

The plan also folds in three pieces of housekeeping on the same request path: one exported `CurrentUser.current` (eleven hand-written copies of "the principal must be a `User`"), one `Sessions.IssuedSession` (six identical plugin interfaces and one derived alias), and one request-facts reader `ClientAddress.facts`/`ClientAddress.address` (three identical `currentClient` helpers and about thirty inline `ip`/`userAgent` spreads). Plan 01 Q1 decided that plugin Shapes keep taking `ip`/`userAgent` explicitly. The reader only builds those explicit arguments, so it is consistent with that decision.

### Goals

1. One implementation of credential precedence, tier admission and rotation hand-off, in `packages/server/src/Credentials.ts`. `grep -rn "request.cookies\[\|\"authorization\"\|API_KEY_HEADER_NAME" packages/{server,qadi,web}/src` finds credential reads only in `Credentials.ts`.
2. Every entry point derives its order from an `Api` middleware declaration: `Record.keys(Api.MachineAuthentication.security)` for Path B, `Api.Authentication` for the web adapter, `Api.OptionalAuthentication` for the optional tier. A test fails if a declared key is not a known carrier.
3. Bug A fixed: web/next read and rotate the configured cookie under every `SessionCookie` mode, and `hasSessionCookie` checks the configured name.
4. Bug B fixed: Path B falls through exactly as Path A does. One table of about 30 rows runs against `Credentials.resolve` and against Path A served over `HttpApiTest`, so the two cannot drift again.
5. The per-request memo covers claimed credentials as well as sessions. One request through Path A and Path B spends one `apiKey` throttle charge (`ApiKey.ts:611-615`) and verifies one JWT once.
6. Replace, don't layer: about 30 scattered precedence tests in five files move into the table. Each adapter keeps only its own mapping tests (§5).
7. Housekeeping: `CurrentUser.current` in core replaces eleven copies and server's private `currentUser`; `Sessions.IssuedSession` replaces seven declarations; `ClientAddress.facts`/`address` replace the `currentClient` triplet and the inline spreads.

### Non-goals

- Changing the declared security records (`Api.ts:235-302`) or OpenAPI output. BEH-EA-072 stays literally true.
- A configurable precedence. The module derives order from declarations and offers no knob (BEH-EA-072).
- Reading `Authorization: Bearer` in the web adapter. `getSession` stays cookie-only (BEH-EA-185). §10 Q5 asks whether a Route Handler should accept a bearer.
- `Sessions.verify` itself (rotation, grace, reuse detection). Plan 19 owns the verdict. This plan calls `verify` once per credential, as today.
- Session *minting* delivery (`SessionDelivery.respond`) and the "a handler-written cookie wins" rule, which plan 21 owns. The rotation sink keeps today's rule unchanged (`Authentication.ts:432-434`).
- The in-process cookie jar of `TestAuth.signInAs` (`packages/test/src/TestAuth.ts:519` writes the default name). That belongs to plan 20, which reads the name from the module this plan exports.
- `AliasLegacyCookieMiddleware` (`migrate-better-auth/src/AliasLegacyCookieMiddleware.ts:32-47`). It rewrites the request before any reader runs, and already uses the configured name. It keeps working because `request.modify` keeps `source`.

---

## 2. Verified current state

### 2.1 The four copies, side by side

| Concern | Path A user/machine (`Authentication.ts`) | Path A optional (`Authentication.ts`) | Path B (`qadi/src/SubjectExtractor.ts`) | Web (`web/src/Session.ts`, `HasSessionCookie.ts`) |
|---|---|---|---|---|
| Order | Effect's security loop over the declaration (`HttpApiBuilder.ts:927-975` in rc.116: decode, call, on *any* typed failure try the next key, answer the last failure) | By hand inside the first handler: `impersonation` (`:893-901`) → `cookieChain` (`:861-882`) → `authenticateBearer` (`:825-843`) → anonymous (`:853-859`) | By hand: impersonation preamble (`:89-115`), then `extractCredential` (`:39-60`): cookie if non-empty, else `x-api-key`, else bearer | By hand: impersonation, then own cookie (`:151-161`) |
| Falls through on a credential that does not resolve | Yes (Effect's loop) | Yes (`catchTag("Unauthenticated")` at `:871`, `:879`, `:896`) | **Only from the impersonation cookie.** A non-empty cookie is chosen and its `Unauthenticated` becomes anonymous (`:46-48`, `:133`). The same holds for `x-api-key` (`:50-53`) | From the impersonation cookie only (no other carriers) |
| Session-cookie name | Configured (`cookieCredential`, `:608-619`) | Configured (same helper, `:869`, `:894`) | Configured (`:87-92`) | **Default** `Api.SessionCookie.key` (`Session.ts:150`, `HasSessionCookie.ts:33`) |
| Impersonation-cookie name | Configured (`:611`, `:711`) | Configured (`:894`) | Configured (`:92`) | **Default** `Api.ImpersonationCookie.key` (`Session.ts:154`) |
| Impersonation rule | `session.actingAs` before the resolver (`requireImpersonationSession`, `:630-633`) | Same (`:816`) | `principal.actingAs` **after** the `PrincipalResolver` (`:108-112`). This diverges under a custom resolver | `session.actingAs` (`:158`) |
| `x-api-key` | Machine tier only (`:716-717`) | Not declared | **Always**, on every Path-B route | No |
| Bearer parsing | Effect's `getAuthorizationCredential` (`HttpApiBuilder.ts:615-635`): case-insensitive scheme, one or more spaces, the rest verbatim | Same, via `securityDecode(Api.BearerToken)` (`:872`) | Its own: lowercase `"bearer "` prefix, then `.trim()` (`:54-58`). Trailing whitespace is trimmed here and not by Effect | n/a |
| API-key value | Raw header (`securityDecode`, `HttpApiBuilder.ts:545-563`) | n/a | Trimmed (`:51-52`) | n/a |
| Tier admission | Claimed: `machine \|\| principal._tag === "User"` (`:683`). Session-derived: **unchecked** | Claimed: `User` only (`:837`). Session-derived: unchecked | **None.** Any claimed principal is admitted, which matches the machine tier | n/a |
| Outage | `requestOutages` WeakMap (`:363`, set at `:287` and `:524`, read at `:279` and `:480`): later schemes fail with the recorded 503 | Same | `StoreUnavailable` → `SubjectExtractionFailed` (`:136-143`) | A rejection (not caught, `:100-111`) |
| Rotation delivery | Pre-response handler by the memo owner (`rotationDelivery`, `:410-442`; registered at `:527-531`) | Same | Same (through `resolvePrincipal` → `resolveSession`) | `Session.rotated` + `applyRotatedSession` rendered under **`SessionCookieConfig.defaultValue()`**, with the **wall clock** `DateTime.nowUnsafe()` (`:196-201`) and always the `session` kind |
| Per-request memo | `sessionResolutionCache` (`:350-353`, `claimResolution` `:370-387`) for sessions only. Claimed credentials (`resolveClaimed`, `:268-292`) run once per call | Same | Shares the session memo via `provideService(HttpServerRequest)` (`:100`, `:132`) | `React.cache(verifySessionToken)` in next (`GetSession.ts:32`); none in web |
| `PostAuthResponseHook` | `serve` (`:302-314`) | Same; never on the anonymous path (`:874-878`) | n/a (no response) | n/a |

Shared helpers that exist only to serve the copies:

- `resolvePrincipal` (`:580-600`), exported for Path B and the BDD worlds.
- `resolveSession` (`:472-544`), exported for Path B and four tests.
- `ResolvedSession` (`:317-320`), which is `Sessions.verify`'s success type (`core/src/Sessions.ts:407-412`) written a second time.
- `cookieCredential` (`:608-619`).
- `requireImpersonationSession` (`:630-633`).

### 2.2 Who calls the shared helpers

`grep -rn "resolvePrincipal\|resolveSession\|resolveClaimed\|ResolvedSession" --include='*.ts' packages features examples`:

- Source: `qadi/src/SubjectExtractor.ts:94`, `:120`.
- Unit tests: `server/test/Authentication.test.ts:436`, `:725`, `:744`, `:762`; `qadi/test/SubjectExtractor.test.ts:188`.
- BDD worlds: `features/step-definitions/AdminWorld.ts:238-260`, `HttpErrorWorld.ts:217-240`, `AuthenticationWorld.ts:563-600`, `QadiBridgePathBSteps.ts:237`.
- A source tripwire: `QadiBridgePathBSteps.ts:358-365` requires at least two `Authentication.resolvePrincipal(` calls in `SubjectExtractor.ts`.
- Comments: `core/src/Sessions.ts:380-397`, `test/src/TestAuth.ts:387-388`, `spec/traceability.md:261`, `spec/decisions/028-infrastructure-error-policy.md:28`, `spec/behaviors/27-admin-impersonation.md:55-58` (BEH-EA-211 is titled after `resolvePrincipal`).

Names that move with the module (§3.5). Counts are of files that reference them across `packages`, `examples`, `features`, `docs` and `README.md`:

| Name | Files |
|---|---|
| `Authentication.PrincipalResolver` | 16 |
| `Authentication.PrincipalResolverLive` | 17 |
| `Authentication.PrincipalResolverWithUserFactsLive` | 3 |
| `Authentication.contribute` | 8 |
| `Authentication.CredentialResolvers` / `CredentialResolversLive` | 9 |

`Authentication.PostAuthResponseHook` (5 files) stays where it is.

### 2.3 Dependency graph (where the module may live)

| Package | Workspace deps (from `package.json`) |
|---|---|
| `api` | none |
| `core` | api, ports, sql |
| `server` | api, core, ports |
| `qadi` | api, core, organization, ports, **server** |
| `web` | api, client, core, **server** |
| `next` | api, jwt, **server**, web |

`web` and `qadi` already depend on `server` (`web/src/Session.ts:38`, `qadi/src/SubjectExtractor.ts:19`), so `@awthaq/server` is the module's home and no edge is added. It cannot live in `core`: the tiers are `Api` middleware declarations, and `PrincipalResolver` and the `CredentialResolvers` registry are server modules. `api` is ruled out too, because it holds no implementation (ADR-EA-003).

The edge-safe surface is `@awthaq/web/cookies` and `@awthaq/next/edge` (`next/test/EdgeImports.test.ts` walks `edge.ts`). It must not reach `@awthaq/core` or `@awthaq/server` at runtime. That constrains `hasSessionCookie` (§3.7).

### 2.4 Live bug A: web/next ignore `SessionCookieConfig`

Code:

- `web/src/Session.ts:149-154` reads `Api.SessionCookie.key` (`__Host-session`) and `Api.ImpersonationCookie.key` (`__Host-impersonation`).
- `HasSessionCookie.ts:33` reads `Api.SessionCookie.key`.
- `Session.ts:196-201` renders with `SessionCookie.SessionCookieConfig.defaultValue()`, because "this adapter has no Effect context to read a custom one from". That comment is wrong: `getSession` is handed the `ManagedRuntime`, which carries the configured `Context.Reference`. `core/src/SessionCookie.ts:93` says "the name every reader … adapters must use for this config".

The spec records it as a limitation. `spec/behaviors/07-sessions.md` (BEH-EA-055, `SecureDomain` bullet) says "`@awthaq/next` renders and reads under the default config only".

Repro (Bun script over the real modules, runtime = memory `Users`/`Sessions` + `PrincipalResolverLive` + `SessionCookie.config({ mode: SecureDomain({ domain: "example.com", sameSite: "lax" }) })`):

```
A: configured name __Secure-session
A: getSession with configured cookie -> undefined (BUG)
A: hasSessionCookie with configured cookie -> false
A: rotation write (default-name cookie presented) -> [{"n":"__Host-session","o":{"secure":true,"httpOnly":true,"path":"/","sameSite":"strict","maxAge":0}}]
```

So under `SecureDomain`:

- `getSession` never resolves (every page redirects to sign-in).
- `proxy.ts` (`hasSessionCookie`) redirects everyone.
- If a host aliased the cookie to the default name, a rotation would write a host-only `Strict` cookie that never reaches the subdomains.

The `maxAge: 0` in that output comes from the script's `TestClock`: `applyRotatedSession` uses the wall clock (`DateTime.nowUnsafe()`, `:200`), not the runtime's `Clock`. In production both clocks agree. It still makes the rendering untestable under `TestClock`, and the fix renders inside the runtime.

Coverage: the only runtime `SecureDomain` test anywhere is `server/test/Authentication.test.ts:583` (Path A). No web or next test uses a non-default `SessionCookieConfig`. `web/test/Session.test.ts:284-310` asserts the rotated name equals the default.

**Checked and refuted (latent only):** "an impersonation session's rotation is written into the session cookie". `applyRotatedSession` always renders the `session` kind, but an `actingAs` session never idle-refreshes (BEH-EA-210, `core/src/Sessions.ts:856-858`), so it never rotates. The repro confirms this ("C: resolved as impersonation? true rotated? false"). The design still carries the carrier on every rotation, so the renderer picks the right kind if BEH-EA-210 ever changes.

### 2.5 Live bug B: Path B never falls through

`extractCredential` (`SubjectExtractor.ts:39-60`) returns the first *present* carrier. `resolvePrincipal` then fails `Unauthenticated` on a stale one, and `:133` maps that to `anonymousPrincipal`. Path A tries the next scheme on any typed failure (`HttpApiBuilder.ts:952-967`).

Repro (Bun script, `SubjectExtractorLive` over memory core, `CredentialResolversLive`, a bearer contribution claiming `svc.*` → `ServicePrincipal`, an `apiKey` contribution claiming `ak_*` that fails `Unauthenticated`):

```
B1 stale cookie + valid session bearer -> anonymous
B2 stale cookie + claimed svc bearer -> anonymous
B3 failing api key + valid bearer -> anonymous
B4 valid bearer alone -> user:01a14c55-…
```

Path A (`Api.Authentication`) answers B1 with the user: `server/test/Authentication.test.ts:802-836` pins exactly that under `OptionalAuthentication`, with a garbage cookie and a valid bearer. Path A's machine tier answers B3 with the user.

On a route behind both bridges (BEH-EA-160 `AuthzLive`), a browser whose cookie went stale while a native-client header is present is therefore authorised as anonymous by `RequirePermission` and served as the user by `Authentication`. The decision and the identity disagree.

Coverage: no test pairs a stale cookie with a valid bearer on Path B. `qadi/test/SubjectExtractor.test.ts:87` is titled "…cookie taking priority when both are present", but its body sends only a bearer.

Further Path B divergences found while verifying:

1. **Impersonation is judged after the resolver** (`:108-112`), on `principal.actingAs`, while Path A judges `session.actingAs` before it. A custom `PrincipalResolver` that drops `actingAs` makes Path B evaluate the admin and Path A serve the target. The module judges the session, as Path A does.
2. **Parsing.** Trailing whitespace on the bearer and the API key is trimmed on Path B only (`:51-52`, `:56`). Node's HTTP parser already strips optional whitespace, so this is behaviour-neutral on the wire. The module adopts Effect's parsing and pins it with a parity test (§5.1 group P).
3. **Tier.** Path B admits any claimed principal, i.e. it behaves as the machine tier. The extractor test suite pins this (`SubjectExtractor.test.ts:283-302`). The plan keeps it explicitly as `Credentials.machineTier` (§10 Q2).

### 2.6 The housekeeping copies

**"The principal must be a `User`."** Eleven hand-written copies, plus server's own private one:

| Site | Shape | Defect |
|---|---|---|
| `admin/src/Admin.ts:431-440` | module const `currentUserPrincipal` | `Defects.invariantViolation("NonUserPrincipal", …)` |
| `admin/src/AdminAccounts.ts:103-112` | same | same |
| `admin/src/AdminTenants.ts:103-112` | same | same |
| `passkey/src/Passkey.ts:617-627` | same, with an explicit `Effect.Effect<…>` annotation | same |
| `two-factor/src/TwoFactor.ts:294-303` | same | same |
| `organization/src/OrganizationHandlers.ts:103-112` | same | same |
| `webhooks/src/Webhooks.ts:365-374` | same | same |
| `saml/src/Saml.ts:694-703` | same (**not in the candidate list**) | same |
| `password/src/Password.ts:805-814`, `:839-845`, `:858-864` | inline, three times | same |
| `saml/src/Saml.ts:580-586` | inline (`logout`) | same |
| `api-key/src/ApiKey.ts:415-424` | `currentUserId` (returns the brand) | same |
| `examples/plugin-template/src/Template.ts:271-280` | module const (the documented template) | same |
| `server/src/internal/CurrentUser.ts:16-31` | `currentUser` → `{ principal, userId, sessionId }`, unexported; used by `Account.ts:85,130,155` and `Session.ts:65-133` | **a different defect**, `HandlerInvariantViolation` (`server/src/internal/Defects.ts:10-14`) |

`organization`, `webhooks` and `saml` do **not** depend on `@awthaq/server`, so the shared helper must live in `@awthaq/core`. Every plugin depends on core, and core depends on `api`, where `Api.CurrentPrincipal` lives.

**`IssuedSession`.**

- Six structurally identical `interface IssuedSession { session: Sessions.SessionView; token: Redacted<string> }` declarations: `admin/src/Admin.ts:203-206`, `magic-link/src/EmailOtp.ts:137-140`, `magic-link/src/MagicLink.ts:138-141`, `passkey/src/Passkey.ts:494-497`, `password/src/Password.ts:334-337`, `two-factor/src/TwoFactor.ts:87-90`.
- One derived alias, `saml/src/Saml.ts:125` (`Effect.Success<ReturnType<Sessions.SessionsShape["issue"]>>`).
- The canonical one, `core/src/internal/signInSteps.ts:59-63`, exported as `SignIn.IssuedSession` (`core/src/SignIn.ts:35`) and already aliased by `magic-link/src/Channel.ts:56`.
- The shape also appears inline in `Sessions.issue`'s own signature (`core/src/Sessions.ts:352-355`) and in `server/src/SessionDelivery.ts:53-57` and `:78-85`.

So "seven copies" is right: six interfaces plus Saml's alias. The source of truth should be `Sessions`, where `issue` returns it.

**Request facts.**

`currentClient` is defined three times, identically:

- `magic-link/src/MagicLink.ts:163-175`
- `magic-link/src/EmailOtp.ts:166-177`
- `device-authorization/src/DeviceAuthorization.ts:465-476`

The inline `ip`/`userAgent` builders, by package:

| Package | Sites |
|---|---|
| `password/src/Password.ts` | `requestUserAgent` (`:631-636`); `{ ip }` spreads at `:669`, `:707`, `:725`, `:739`, `:761`, `:775`, `:820`; user-agent spreads at `:673`, `:711`, `:827` |
| `oauth/src/OAuth.ts` | `:501`, `:544-558`, `:603` |
| `saml/src/Saml.ts` | `:449-452`, `:472-480`, `:501`, `:527`, `:587-590` |
| `saml/src/Sso.ts` | `:171-172` |
| `passkey/src/Passkey.ts` | `:682-686`, `:701-706` |
| `two-factor/src/TwoFactor.ts` | `:325-330` |
| `api-key/src/ApiKey.ts` | `:557-558`, `:613-614` |

That is 24 `clientAddress.resolve(request)` calls and 9 user-agent header reads in plugin source (`grep -rnE "clientAddress\.resolve\(request\)|\"user-agent\"" packages/*/src`).

Plan 01's "Decisions taken" item 7 says Q1 = no: `RequestContext.layer` stays opt-in and plugin Shapes keep explicit `ip`/`userAgent`. A reader that *builds* those explicit arguments leaves that decision intact.

### 2.7 Tests that pin this behaviour today

An exploration pass over the test tree counted about 92 unit tests and 32 BDD scenarios on precedence, tiers or rotation.

| File | Tests | What becomes of them in this plan (§5.3) |
|---|---|---|
| `server/test/Authentication.test.ts` | 31 core: precedence `:153-302`, hook `:348`, `:393`, outage `:431`, `:526`, rotation `:539-688`, memo `:719-778`, declared keys `:780`, OpenAPI `:794`, optional order `:802`, challenge `:838-890` | precedence, outage unit, memo and declared-keys tests move to `Credentials.test.ts`; the rest stays as adapter tests |
| `server/test/CredentialResolvers.test.ts` | 12 core: tier rows `:133`, `:143`, `:153`, `:221`, `:233`, `:250`, `:260`, `:270`; registry `:172`, `:186`, `:204`, `:305-345`; hook `:282` | tier rows move; registry and hook stay |
| `qadi/test/SubjectExtractor.test.ts` | 10 core: `:56`, `:65`, `:87`, `:109`, `:148`, `:161`, `:207`, `:283`, `:290`, `:297` | 7 move into the table (§5.3); `:56`, `:161` and `:207` stay as adapter tests |
| `web/test/Session.test.ts` | 5 core: `:95`, `:130`, `:241`, `:284`, `:320` | `:130` moves; the rest are rewritten for the new seam |
| `web/test/HasSessionCookie.test.ts` | 4, default name only | rewritten for the config argument |
| `next/test/GetSession.test.ts` | `:33`, `:39`, `:51` | stay |
| `api/test/Api.test.ts` | `:127` pins the declared order (the same assertion as `Authentication.test.ts:780`) | stays |
| `jwt/test/BearerReentry.test.ts` | 8 | unchanged: the claimed-bearer integration, a plugin's own subject |
| `api-key/test/AuthHttp.test.ts` | 7 titles × 2 suites | unchanged: integration |
| `admin/test/AuthHttp.test.ts` | `:140`, `:204`, `:359` | unchanged |
| `admin/test/AdminTier.test.ts` | `:136`, `:169` | unchanged |
| `test/test/TestAuthMiddleware.test.ts` | 5 | unchanged |

Gaps the inventory found:

- No test sends both `x-api-key` and a bearer on the machine tier.
- No test sends an impersonation cookie together with a bearer, or to the machine tier.
- No runtime outage test exists for the optional tier or for Path B.
- No `WWW-Authenticate` test exists on the machine tier.
- The impersonation cookie name is never checked under `SecureDomain`.

The table in §5.1 closes all five.

BDD scenarios:

| Feature | Scenarios |
|---|---|
| `03-http-layer/09-authentication-middleware.feature` | REQ-EA-185 to 203, 15 core. REQ-EA-186, 188 and 203 observe per-scheme handler attempts through `AuthenticationWorld.ts:162-185` |
| `06-roles-and-authorization-bridge/20-qadi-bridge-path-b.feature` | REQ-EA-428, 429, 430 (the tripwire), 450 |
| `09-admin-and-impersonation/27-admin-impersonation.feature` | REQ-EA-605, 609, 613, 616, 630 |
| `11-jwt/36-jwt.feature` | REQ-EA-802 to 807 |
| `07-client-integration/24-nextjs-ssr.feature` | REQ-EA-522 to 524 and 531 to 533, default cookie only |

---

## 3. Target design

### 3.1 Where the seam sits

```
                    ┌─────────────────────────────── @awthaq/server/Credentials ───────────────────────────────┐
 request / cookie   │ presented(source) ─► Presented ─► step(carrier, …) ◄── resolve(…) = fold over tier.carriers │
 header (adapter)   │                                     │  session memo · claim memo · outage short-circuit      │
                    │ tier(declaration, admits)           │  impersonation rule · admission · span/log            │
                    │                                     ▼                                                         │
                    │                         Scope { key, deliver, claim }  ◄── the seam                           │
                    └─────────────────────────────▲──────────────────────────▲──────────────────────────────────────┘
                                                  │                          │
                          httpScope(request)  ────┘                          └──── collecting (web call)
                          memo on request.source,                                 memo on a fresh object,
                          rotation → pre-response                                 rotation → collected, rendered
                          handler, claim → registry                               into Session.rotated.cookie
 Adapters:
   Authentication.ts  — Path A: one handler per declared scheme calls step(thatCarrier); Effect's loop is the chain.
                        Optional: every handler calls resolve(optionalTier) then falls back to anonymous.
                        Keeps PostAuthResponseHook, WWW-Authenticate (JR-007), serve.
   qadi SubjectExtractor.ts — resolve(machineTier, httpScope(request)); Unauthenticated → anonymous; outage → SubjectExtractionFailed.
   web Session.ts      — resolve(userTier, collecting) inside the host's runtime; renders the rotation under the configured cookie.
```

Path A keeps **one handler per declared scheme**, each running exactly one carrier. Two reasons:

- REQ-EA-203 redeclares the record as `{ bearer, cookie }` over the same handlers (`AuthenticationWorld.ts:187-193`) and expects the order to change. A handler that ran the whole chain would ignore its declaration.
- Effect's loop *is* the chain for Path A. `resolve` folds over the same declaration's keys with the same fall-through rule, and the parity group in §5.1 proves the two agree row by row.

### 3.2 The interface (`packages/server/src/Credentials.ts`)

```ts
// @awthaq/server — Credentials
//
// ADR-EA-042: the one place a request's credentials are read, ordered, resolved to a principal, admitted by a tier
// and (on a rotating verify) handed to a delivery sink. Path A (Authentication.ts), Path B (@awthaq/qadi's
// SubjectExtractor) and the web adapter (@awthaq/web getSession) are adapters over it.

/** APS-006/OCM-002: every credential carrier an awthaq middleware declares. */
export type Carrier = "impersonation" | "cookie" | "apiKey" | "bearer";
/** The carriers that resolve to a session row (and so can rotate). */
export type SessionCarrier = "impersonation" | "cookie" | "bearer";
/** MAPS-001: the carriers a plugin may claim through the registry. */
export type ClaimCarrier = "apiKey" | "bearer";

const isCarrier = (key: string): key is Carrier =>
  key === "impersonation" || key === "cookie" || key === "apiKey" || key === "bearer";

/** What one request presents. An absent or empty value is `None` (BEH-EA-065: an empty credential never resolves). */
export type Presented = { readonly [K in Carrier]: Option.Option<Redacted.Redacted<string>> };

/** How an adapter exposes its request: a parsed cookie lookup and a case-insensitive header lookup. */
export interface Source {
  readonly cookie: (name: string) => string | undefined;
  readonly header: (name: string) => string | undefined;
}

/**
 * IC-007: reads every carrier, the cookie names from the ambient `SessionCookieConfig`. The one reader:
 * no adapter names a cookie or a header itself.
 */
export const presented = Effect.fnUntraced(function* (source: Source) {
  const config = yield* SessionCookie.SessionCookieConfig;
  return {
    impersonation: nonEmpty(source.cookie(SessionCookie.cookieName(config, "impersonation"))),
    cookie: nonEmpty(source.cookie(SessionCookie.cookieName(config, "session"))),
    apiKey: nonEmpty(source.header(Api.API_KEY_HEADER_NAME)),
    bearer: nonEmpty(bearerCredential(source.header("authorization"))),
  } satisfies Presented;
});

/** The HTTP source: Effect's parsed cookies (the same map `HttpApiSecurity.apiKey({ in: "cookie" })` decodes). */
export const fromRequest = (request: HttpServerRequest.HttpServerRequest) =>
  presented({
    cookie: (name) => request.cookies[name],
    header: (name) => Option.getOrUndefined(Headers.get(request.headers, name)),
  });

/** A tier: the carriers its declaration lists, in declaration order (BEH-EA-072), and the principals it admits. */
export interface Tier<P extends Api.Principal> {
  readonly carriers: ReadonlyArray<Carrier>;
  readonly admits: (principal: Api.Principal) => principal is P;
}

export const tier = <P extends Api.Principal>(
  declaration: { readonly security: Readonly<Record<string, HttpApiSecurity.HttpApiSecurity>> },
  admits: (principal: Api.Principal) => principal is P,
) => ({ carriers: Record.keys(declaration.security).filter(isCarrier), admits }) satisfies Tier<P>;

const isUser = (principal: Api.Principal): principal is Api.UserPrincipal => principal._tag === "User";
const isAny = (principal: Api.Principal): principal is Api.Principal => true;

/** OCM-002: the user tier admits a `User` only; the machine tier admits whatever a claimed credential resolves to. */
export const userTier = tier(Api.Authentication, isUser);
export const optionalTier = tier(Api.OptionalAuthentication, isUser);
export const machineTier = tier(Api.MachineAuthentication, isAny);

/** PIL-005: a verify that rotated, and the carrier its credential came in on (the delivery's channel and cookie kind). */
export interface Rotation {
  readonly carrier: SessionCarrier;
  readonly session: Sessions.SessionView;
  readonly token: Redacted.Redacted<string>;
}

/** The seam. One implementation per entry point kind (HTTP request, framework call). */
export interface Scope {
  /** PCS-006: the identity the per-request memo and outage record hang off. HTTP: `request.source` (NHS-006). */
  readonly key: object;
  /** Called once, by the one verify that rotated (the memo owner). */
  readonly deliver: (rotation: Rotation) => Effect.Effect<void>;
  /** MAPS-001: the registry's principal for a claimed credential; `None` when nobody claims it. */
  readonly claim: (
    carrier: ClaimCarrier,
    credential: Redacted.Redacted<string>,
  ) => Effect.Effect<Option.Option<Api.Principal>, Api.Unauthenticated | Api.StoreUnavailable>;
}

/** What a request resolved to. `Session` carries the row the web adapter needs; `Claimed` has none (no rotation). */
export type Resolved<P extends Api.Principal> =
  | {
      readonly _tag: "Session";
      readonly carrier: SessionCarrier;
      readonly principal: P;
      readonly session: Sessions.SessionView;
    }
  | { readonly _tag: "Claimed"; readonly carrier: ClaimCarrier; readonly principal: P };

/** Built once per adapter layer (or per web call); `R` = `Sessions | PrincipalResolver`. */
export const make = Effect.gen(function* () {
  const sessions = yield* Sessions.Sessions;
  const resolver = yield* PrincipalResolver;
  // … §3.3
  return { step, resolve };
});
```

Notes for the executor:

- `Record.keys` (`effect/Record`, rc.116 `Record.ts:1493`) returns `Array<K & string>`. `.filter(isCarrier)` narrows it to `Carrier[]` with a guard, not an assertion. `HttpApiMiddleware.Service`'s static `security` keeps the declared record type (`HttpApiMiddleware.ts:305`).
- `satisfies` is not an annotation; `tier`'s return type is inferred. `make` and the tiers are unannotated consts.
- `isAny` is a type guard whose body is `true`. That is legal and states the machine tier's intent in the type.
- `nonEmpty = (value: string | undefined) => value === undefined || value === "" ? Option.none() : Option.some(Redacted.make(value))`. Give it an explicit generic at the `none` (`Option.none<Redacted.Redacted<string>>()`) so the union infers.
- `bearerCredential` reproduces rc.116's private `getAuthorizationCredential(header, "Bearer")` (`HttpApiBuilder.ts:615-635`) exactly:

  ```ts
  /** RFC 9110 §11.1, identical to `HttpApiBuilder.securityDecode(Api.BearerToken)` (pinned by §5.1 group P). */
  const bearerCredential = (authorization: string | undefined) => {
    const scheme = "bearer";
    if (
      authorization === undefined ||
      authorization.length <= scheme.length ||
      authorization.charCodeAt(scheme.length) !== 32 ||
      authorization.slice(0, scheme.length).toLowerCase() !== scheme
    ) {
      return undefined;
    }
    const credential = authorization.slice(scheme.length + 1).replace(/^ +/, "");
    return credential === "" ? undefined : credential;
  };
  ```

### 3.3 The implementation: `step` and `resolve`

```ts
type Failure = Api.Unauthenticated | Api.StoreUnavailable;

// PCS-006/TS-003: single-flight per (scope, slot). One Deferred per credential, created in one synchronous
// get-or-create step, exactly today's `claimResolution` (Authentication.ts:370-387), now for two tables.
const sessionMemo = new WeakMap<object, Map<string, Deferred.Deferred<Sessions.VerifiedSession, Failure>>>();
const claimMemo = new WeakMap<object, Map<string, Deferred.Deferred<Option.Option<Api.Principal>, Failure>>>();
// MA-004: the first carrier that sees an outage records it; every later step of the same scope fails with it.
const outages = new WeakMap<object, Api.StoreUnavailable>();

const once = <A>(
  table: WeakMap<object, Map<string, Deferred.Deferred<A, Failure>>>,
  key: object,
  slot: string,
  effect: Effect.Effect<A, Failure>,
) => /* today's claimResolution + Deferred.into + onInterrupt(delete), generic in A */;

// inside `make`:
const verified = (carrier: SessionCarrier, credential: Redacted.Redacted<string>, scope: Scope) =>
  once(
    sessionMemo,
    scope.key,
    Redacted.value(credential),
    sessions.verify(credential).pipe(
      // EOTS-003 debug line + span outcome, unchanged from Authentication.ts:501-517
      Effect.catchTags({
        "Sessions/NotFound": () => Effect.fail(new Api.Unauthenticated()),
        SessionExpired: () => Effect.fail(new Api.Unauthenticated()),
      }),
      Effect.tap(({ session, rotated }) =>
        Option.isSome(rotated) ? scope.deliver({ carrier, session, token: rotated.value }) : Effect.void,
      ),
    ),
  );

const viaSession = (carrier: SessionCarrier, credential: Redacted.Redacted<string>, scope: Scope) =>
  verified(carrier, credential, scope).pipe(
    // APS-006: only a session carrying `actingAs` counts from the impersonation cookie — judged on the session,
    // before the resolver, for every entry point (Path B used to judge the resolved principal).
    Effect.filterOrFail(
      ({ session }) => carrier !== "impersonation" || Option.isSome(session.actingAs),
      () => new Api.Unauthenticated(),
    ),
    Effect.flatMap(({ session }) =>
      resolver.resolve(session).pipe(
        Effect.map((principal) => ({ _tag: "Session", carrier, principal, session }) as const),
      ),
    ),
  );

const viaClaim = (carrier: ClaimCarrier, credential: Redacted.Redacted<string>, scope: Scope) =>
  once(claimMemo, scope.key, `${carrier}:${Redacted.value(credential)}`, scope.claim(carrier, credential)).pipe(
    Effect.flatMap(
      Option.match({
        onSome: (principal) => Effect.succeed({ _tag: "Claimed", carrier, principal } as const),
        // MAPS-001: an unclaimed bearer is an opaque session token; an unclaimed api key is nothing.
        onNone: () =>
          carrier === "bearer" ? viaSession("bearer", credential, scope) : Effect.fail(new Api.Unauthenticated()),
      }),
    ),
  );

/** One carrier: what Path A's handler for that declared scheme runs. */
const step = <P extends Api.Principal>(carrier: Carrier, presented: Presented, tier: Tier<P>, scope: Scope) =>
  Effect.gen(function* () {
    const outage = outages.get(scope.key);
    if (outage !== undefined) return yield* Effect.fail(outage);
    const credential = presented[carrier];
    if (Option.isNone(credential)) return yield* Effect.fail(new Api.Unauthenticated());
    const resolved =
      carrier === "impersonation" || carrier === "cookie"
        ? yield* viaSession(carrier, credential.value, scope)
        : yield* viaClaim(carrier, credential.value, scope);
    const principal = resolved.principal;
    // OCM-002: admission applies to every principal, session-derived or claimed (today only claimed ones are checked).
    if (!tier.admits(principal)) return yield* Effect.fail(new Api.Unauthenticated());
    yield* annotatePrincipal(principal); // MAPS-007, unchanged
    return resolved._tag === "Session" ? { ...resolved, principal } : { ...resolved, principal };
  }).pipe(
    Effect.tapError((error) =>
      Predicate.isTagged(error, "StoreUnavailable") ? Effect.sync(() => outages.set(scope.key, error)) : Effect.void,
    ),
    Effect.withSpan(Observability.Span.principalResolve, { attributes: { "auth.scheme": carrier } }),
  );

/**
 * The whole chain, for entry points with no security loop of their own (the optional tier, Path B, the web adapter):
 * the tier's carriers in declaration order, falling through on `Unauthenticated` exactly as Effect's loop does
 * (HttpApiBuilder.ts:952-967). An outage stops it: `step` records it, so every later carrier fails with it.
 */
const resolve = <P extends Api.Principal>(presented: Presented, tier: Tier<P>, scope: Scope) =>
  tier.carriers.reduce<Effect.Effect<Resolved<P>, Failure>>(
    (previous, carrier) =>
      previous.pipe(Effect.catchTag("Unauthenticated", () => step(carrier, presented, tier, scope))),
    Effect.fail(new Api.Unauthenticated()),
  );
```

- `as const` on the object literals is the allowed literal form (`.oxlintrc.json` override), not an assertion of a wider type.
- The final `return` respreads `principal` so TypeScript sees the guard-narrowed `P` in each union member. The two branches look identical, but each spreads a different union member. If inference already accepts a single `{ ...resolved, principal }`, keep the single form.
- `reduce<…>` gives the generic argument explicitly; it is not a return-type annotation.
- **Why `outages` stays.** After a cookie outage, Effect's loop still calls the `bearer` handler with a *different* credential, so no memo hit stops it from answering 401. The scope-level record makes it answer the same 503 (MA-004). `resolve` would stop anyway, but `step` must stop too.
- **Spans.** `step` opens one `principalResolve` span per carrier tried. Today `resolveSession` opens one per session attempt (`Authentication.ts:541-543`), so the trace shape on the success path is unchanged. On the failure path a claimed credential now gets its span too, which is an improvement.
- **Delivery semantics are unchanged.** The memo owner hands every rotation to `scope.deliver` at verify time, before any later failure (a resolver outage) can lose it. That includes a planted ordinary session in the impersonation cookie, exactly as `Authentication.ts:527-531` does today.

### 3.4 The two scopes

```ts
/** PIL-005/NHS-007: today's `rotationDelivery` (Authentication.ts:410-442), moved verbatim, keyed by the rotation. */
const rotationDelivery = (rotation: Rotation): HttpEffect.PreResponseHandler => /* bearer → ROTATED_TOKEN_HEADER;
  cookie/impersonation → SessionCookie.render(rotation.session, rotation.token, kind) under the ambient config;
  a handler-written cookie of that name wins; encoding failure logged, never a defect; no-store */;

/** The HTTP scope: one per request (keyed on `source`, so `request.modify` re-wraps share it — NHS-006). */
export const httpScope = (request: HttpServerRequest.HttpServerRequest) =>
  ({
    key: request.source,
    deliver: (rotation) =>
      Effect.sync(() => HttpEffect.appendPreResponseHandlerUnsafe(request, rotationDelivery(rotation))),
    claim: (carrier, credential) =>
      resolveClaimed(carrier, credential).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request)),
  }) satisfies Scope;

/** A framework call (web `getSession`): its own memo identity; rotations are collected, never written here. */
export const collecting = Effect.gen(function* () {
  const seen = yield* Ref.make<ReadonlyArray<Rotation>>([]);
  const scope = {
    key: {},
    deliver: (rotation) => Ref.update(seen, (all) => [...all, rotation]),
    // A cookie-only call presents no claimable carrier; if one ever does, it is unclaimed.
    claim: () => Effect.succeedNone,
  } satisfies Scope;
  return { scope, rotations: Ref.get(seen) };
});
```

- `HttpEffect.appendPreResponseHandlerUnsafe(request, handler)` exists in rc.116 (`HttpEffect.ts:255-258`) and writes the same `requestPreResponseHandlers` WeakMap the `Effect`-returning variant does. Path B therefore no longer needs `provideService(HttpServerRequest)` for delivery, only for `claim`.
- `resolveClaimed` (`Authentication.ts:268-292`) moves here unchanged, except that its own outage check and record (`:278-280`, `:285-289`) are deleted: `step` owns the outage record now.

### 3.5 What moves into `Credentials.ts`, and what stays in `Authentication.ts`

Moved verbatim (locality: "who is this request" in one file; `Authentication.ts` imports `Credentials.ts`, never the reverse, so `pnpm circular` stays clean):

- `PrincipalResolver`, `PrincipalResolverLive`, `PrincipalResolverWithUserFactsLive`, `userPrincipalOf` (`:27-98`)
- `CredentialCarrier` (renamed to `ClaimCarrier`), `CredentialResolverContribution`, `DuplicateCredentialResolver`, `CredentialResolversFrozen`, `CredentialResolversShape`, `CredentialResolvers`, `CredentialResolversLive`, `contribute` (`:135-261`)
- `resolveClaimed` (`:268-292`, made module-private)
- the memo machinery (`:322-387`, generalised in §3.3)
- `rotationDelivery` (`:389-442`)
- `principalFields`/`annotatePrincipal` (`:546-562`; `principalFields` is exported for `serve`)

Deleted (replaced by `step`/`resolve`):

- `Scheme` (`:136`)
- `ResolvedSession` (`:316-320`; becomes `Sessions.VerifiedSession`, §3.8)
- `resolveSession` (`:444-544`)
- `resolveAndAnnotate` (`:564-565`)
- `resolvePrincipal` (`:567-600`)
- `cookieCredential` (`:602-619`)
- `requireImpersonationSession` (`:624-633`)
- `requestOutages` (`:355-363`)
- the optional tier's private copies (`:806-882`)

Stays in `Authentication.ts`, as the Path A adapter (about 230 lines, down from 908):

- `PostAuthResponseHook` (`:100-133`), with `context.scheme` typed `Credentials.Carrier`
- `serve` (`:302-314`)
- `CHALLENGE_REALM` and the JR-007 challenge (`:621-622`, `:718-744`)
- the four layers (`AuthenticationLive`, `MachineAuthenticationLive`, `AdminAuthenticationLive` unchanged, `OptionalAuthenticationLive`)

```ts
type Handler = HttpApiMiddleware.HttpApiMiddlewareSecurity<
  typeof Api.MachineAuthentication.security,
  Api.CurrentPrincipal,
  typeof Api.Unauthenticated | typeof Api.StoreUnavailable,
  never
>["cookie"];

/** BEH-EA-065/072: one handler per declared scheme, each one carrier; Effect's loop over the declaration is the chain. */
const tierHandlers = <P extends Api.Principal>(tier: Credentials.Tier<P>) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials.make;
    const handler =
      (carrier: Credentials.Carrier): Handler =>
      (httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const presented = yield* Credentials.fromRequest(request);
          const resolved = yield* credentials.step(carrier, presented, tier, Credentials.httpScope(request));
          return yield* serve(resolved.carrier, httpEffect, resolved.principal);
        });
    return {
      impersonation: handler("impersonation"),
      cookie: handler("cookie"),
      apiKey: handler("apiKey"),
      bearer: withChallenge(handler("bearer")), // JR-007, unchanged; "presented" = Option.isSome(presented.bearer)
    };
  });

export const AuthenticationLive = Layer.effect(
  Api.Authentication,
  Effect.map(tierHandlers(Credentials.userTier), ({ impersonation, cookie, bearer }) => ({ impersonation, cookie, bearer })),
);
export const MachineAuthenticationLive = Layer.effect(Api.MachineAuthentication, tierHandlers(Credentials.machineTier));

/** BEH-EA-068/EHA-006: every handler runs the whole optional chain and falls back to anonymous, so none can fail 401. */
export const OptionalAuthenticationLive = Layer.effect(
  Api.OptionalAuthentication,
  Effect.gen(function* () {
    const credentials = yield* Credentials.make;
    const handler: OptionalHandler = (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const presented = yield* Credentials.fromRequest(request);
        return yield* credentials.resolve(presented, Credentials.optionalTier, Credentials.httpScope(request)).pipe(
          Effect.matchEffect({
            onSuccess: (resolved) => serve(resolved.carrier, httpEffect, resolved.principal),
            onFailure: (error) =>
              error._tag === "Unauthenticated"
                ? Effect.provideService(httpEffect, Api.CurrentPrincipal, Api.anonymousPrincipal) // no hook (:874-878)
                : Effect.fail(error),
          }),
        );
      });
    return { impersonation: handler, cookie: handler, bearer: handler };
  }),
);
```

- **Keep the `Layer.Layer<…>` annotations on the four exported layers.** They exist today (`:748-752`, `:766-770`, `:780-784`, `:797-801`), and the memory rule is "new code only, not a retroactive strip". The new `tierHandlers`, `handler` and `Credentials.make` stay unannotated. `Handler` is a type alias for the handler record member, which is how today's code names it (`:693-703`); it is not a return annotation of an Effect const.
- `Effect.matchEffect`: if the handler error type widens awkwardly, use `Effect.catchTag("Unauthenticated", () => anonymous)` as today. The behaviour is the same.
- The redundant decoded `credential` that Effect passes each handler is ignored. The module's reader is the single parser, and the §5.1 group P parity tests prove it equals Effect's decode for the three schemes.

### 3.6 Path B adapter (`packages/qadi/src/SubjectExtractor.ts`, about 60 lines)

```ts
export const SubjectExtractorLive: Layer.Layer<SubjectExtractor, never, Sessions.Sessions | Credentials.PrincipalResolver> =
  Layer.effect(
    SubjectExtractor,
    Effect.gen(function* () {
      const credentials = yield* Credentials.make;
      const subjectResolver = yield* SubjectResolver;
      return {
        extract: (request) =>
          Credentials.fromRequest(request).pipe(
            // BEH-EA-153/ADR-EA-042: Path B's chain is the machine tier's declaration (it admits what Path A's
            // machine tier admits); a credential that does not resolve falls through exactly as on Path A.
            Effect.flatMap((presented) =>
              credentials.resolve(presented, Credentials.machineTier, Credentials.httpScope(request)),
            ),
            Effect.map((resolved) => resolved.principal),
            Effect.catchTag("Unauthenticated", () => Effect.succeed(Api.anonymousPrincipal)),
            Effect.flatMap(subjectResolver.resolve),
            Effect.catchTag("StoreUnavailable", (error) =>
              Effect.fail(
                new SubjectExtractionFailed({ reason: `awthaq: session store unavailable (${error.operation})` }),
              ),
            ),
          ),
      };
    }),
  );
```

The `Layer.Layer<…>` annotation is kept, because it exists today. The `BEARER_PREFIX` constant and `extractCredential` are deleted.

### 3.7 Web/next adapter (`packages/web/src/Session.ts`, `HasSessionCookie.ts`)

**The memo seam moves up one level.** Today the unit `next` wraps in `React.cache` is `verifySessionToken(token, runtime)`. It becomes the whole cookie-header resolution, `resolveSessionCookies(cookieHeader, runtime)`, so the precedence, both verifies and the rendering are deduped as one unit within a render. `React.cache` keys on argument identity: within one render `headers().get("cookie")` is the same string and the runtime is the same object.

```ts
export interface Session {
  readonly principal: Api.UserPrincipal; // was Api.Principal; the user tier admits only User (Credentials.userTier)
  readonly user: Users.UserRecord;
  readonly session: Sessions.SessionView;
  /**
   * BO-001/IC-001: the resolved session's rotation, rendered under the runtime's `SessionCookieConfig` (name,
   * `Domain`, `SameSite`, `Max-Age` from the runtime `Clock`) and the cookie kind it came in on. `undefined` when
   * nothing rotated. `applyRotatedSession` writes `cookie` into a framework jar.
   */
  readonly rotated:
    | { readonly token: Redacted.Redacted<string>; readonly cookie: SessionCookie.RenderedCookie }
    | undefined;
}

const resolveCookies = (cookieHeader: string | null) =>
  Effect.gen(function* () {
    const users = yield* Users.Users;
    const base = yield* Credentials.PrincipalResolver;
    // RSC-007: the user lookup runs beside the principal resolution, not after it, by decorating the resolver the
    // module uses for this one call (no interface change to Credentials).
    const user = yield* Ref.make(Option.none<Users.UserRecord>());
    const alongside = Credentials.PrincipalResolver.of({
      resolve: (session) =>
        Effect.all(
          [base.resolve(session), users.findById(session.userId).pipe(Effect.option)],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.tap(([, found]) => Ref.set(user, found)),
          Effect.map(([principal]) => principal),
        ),
    });
    const credentials = yield* Credentials.make.pipe(Effect.provideService(Credentials.PrincipalResolver, alongside));
    const { scope, rotations } = yield* Credentials.collecting;
    const presented = yield* Credentials.presented({ cookie: (name) => cookieValue(cookieHeader, name), header: () => undefined });
    const resolved = yield* credentials.resolve(presented, Credentials.userTier, scope);
    if (resolved._tag === "Claimed") return undefined; // a cookie-only call presents nothing claimable
    const found = yield* Ref.get(user);
    if (Option.isNone(found)) return undefined; // BEH-EA-185: the session's user is gone
    const own = (yield* rotations).find((rotation) => rotation.session.id === resolved.session.id);
    return {
      principal: resolved.principal,
      user: found.value,
      session: resolved.session,
      rotated:
        own === undefined
          ? undefined
          : {
              token: own.token,
              cookie: yield* SessionCookie.render(own.session, own.token, own.carrier === "impersonation" ? "impersonation" : "session"),
            },
    };
  }).pipe(Effect.catchTag("Unauthenticated", () => Effect.succeed(undefined)));
// A `StoreUnavailable` propagates (a rejection), as BEH-EA-185 says.

/** The unit an adapter dedupes per render (`@awthaq/next`: `React.cache(resolveSessionCookies)`). */
export type ResolveSessionCookies = (cookieHeader: string | null, runtime: SessionRuntime) => Promise<Session | undefined>;
export const resolveSessionCookies: ResolveSessionCookies = (cookieHeader, runtime) =>
  runtime.runPromise(resolveCookies(cookieHeader));

export const makeGetSession =
  (resolveCookieHeader: ResolveSessionCookies) =>
  <Extra = never>(headers: HeadersLike, runtime: ManagedRuntime.ManagedRuntime<SessionServices | Extra, never>) =>
    resolveCookieHeader(headers.get("cookie"), runtime);

export const getSession = makeGetSession(resolveSessionCookies);

/** BO-001: writes the already-rendered rotation; no config lookup, no clock, nothing to get wrong here. */
export const applyRotatedSession = (session: Session | undefined, jar: CookieJarLike): void => {
  if (session?.rotated === undefined) return;
  const { maxAge, partitioned, ...rest } = session.rotated.cookie.options;
  setCookie(jar, session.rotated.cookie.name, session.rotated.cookie.value, {
    ...rest,
    ...(maxAge === undefined ? {} : { maxAge: Math.floor(Duration.toSeconds(maxAge)) }),
    ...(partitioned === undefined ? {} : { partitioned }),
  });
};
```

- The function names and the `ResolveSessionCookies` type are public API. `resolveCookies` (module-private) and `alongside` are unannotated.
- `runtime.runPromise` takes the host's runtime with the subtype `ManagedRuntime<SessionServices | Extra, never>`. That is assignable as today, because `SessionRuntime` is the required lower bound.
- A planted ordinary session in the impersonation cookie that rotates is *collected* but not rendered (only `own` is). This is the one deliberate difference from the HTTP sink, and it is the better outcome: the planted cookie fails after `rotationGrace` and the request falls through for good. BEH-EA-185 states it.
- `@awthaq/next/src/GetSession.ts:32` becomes `export const getSession = makeGetSession(cache(resolveSessionCookies));`.

**`hasSessionCookie`** (`HasSessionCookie.ts`) must stay free of `@awthaq/core` and `@awthaq/server` at runtime, so an edge bundle can take it. The pure naming rule therefore moves to `@awthaq/api`, the stratum that already owns both cookie names (CSS-007, `Api.ts:155-161`, `:194-205`):

```ts
// packages/api/src/Api.ts
/** CSS-007/IC-007: the one naming rule. Only a domain-scoped cookie (`SessionCookie.SecureDomain`) drops `__Host-`. */
export const SECURE_SESSION_COOKIE_NAME = "__Secure-session";
export const SECURE_IMPERSONATION_COOKIE_NAME = "__Secure-impersonation";
export const sessionCookieName = (mode: { readonly _tag: string }, kind: "session" | "impersonation") =>
  mode._tag === "SecureDomain"
    ? kind === "session" ? SECURE_SESSION_COOKIE_NAME : SECURE_IMPERSONATION_COOKIE_NAME
    : kind === "session" ? SESSION_COOKIE_NAME : IMPERSONATION_COOKIE_NAME;

// packages/core/src/SessionCookie.ts:94-101 becomes a delegate
export const cookieName = (cfg: SessionCookieConfigShape, kind: CookieKind = "session") => Api.sessionCookieName(cfg.mode, kind);

// packages/web/src/HasSessionCookie.ts (recommended default of Q1: a required config argument)
import type { SessionCookie } from "@awthaq/core"; // type-only: erased, edge-safe
export const hasSessionCookie = (
  request: { readonly headers: HeadersLike },
  cookie: { readonly mode?: SessionCookie.Mode },
): boolean => hasCookie(request.headers.get("cookie"), Api.sessionCookieName(cookie.mode ?? SessionCookie_HOST, "session"));
```

`SessionCookie_HOST` stands for a literal `{ _tag: "Host" }`. It is written inline, so no core value is imported. A host passes the same partial it gives `SessionCookie.config(...)`. The default host passes `{}`. The argument is required, so a `SecureDomain` host cannot forget it, which is the type-system-first answer to bug A's `hasSessionCookie` half. Also export `hasSessionCookie` from `@awthaq/web/cookies` (the edge-safe subpath, `cookies.ts`), and extend `EdgeImports.test.ts`-style coverage to `HasSessionCookie.ts`. Q1 offers the alternative: probe both names and keep the signature.

### 3.8 Housekeeping helpers

**`CurrentUser`** (`packages/core/src/CurrentUser.ts`, exported as `CurrentUser` from `core/src/index.ts`):

```ts
/**
 * GC-003: the caller of a user-tier group, re-branded into the domain. `Authentication` (the user tier) admits only a
 * `User` (Credentials.userTier), so anything else here is a wiring defect, never a request-level condition.
 */
export const current = Effect.gen(function* () {
  const principal = yield* Api.CurrentPrincipal;
  if (principal._tag !== "User") {
    return yield* Defects.invariantViolation(
      "NonUserPrincipal",
      `awthaq: a user-tier group was reached with a non-User principal: ${principal._tag}`,
    );
  }
  return { principal, userId: Users.UserId(principal.ref.id), sessionId: Sessions.SessionId(principal.sessionId) };
});
```

Callers write `const { principal } = yield* CurrentUser.current` (or `{ userId, sessionId }`). The defect class unifies on ports' `Defects/InvariantViolation` (`ports/src/Defects.ts:31`, `:50-51`), which ten of the eleven copies already use. `server/src/internal/Defects.ts` (`HandlerInvariantViolation`) is deleted, and its three `AuthenticatedUserMissing` uses in `server/src/Account.ts:89-95`, `:136-143` and `:158-165` become `Defects.invariantViolation("AuthenticatedUserMissing", …)`, as `TwoFactor.ts:625` already does. The per-group wording of today's messages ("admin group", "passkey group") is dropped. The route is on the request span (`http.route`), so the message need not repeat it.

**`Sessions.IssuedSession` and `Sessions.VerifiedSession`** (`core/src/Sessions.ts`, next to `SessionView`):

```ts
/** What `issue` returns: the session and the raw token to deliver (cookie or bearer, `SessionDelivery`). */
export interface IssuedSession {
  readonly session: SessionView;
  readonly token: Redacted.Redacted<string>;
}
/** What `verify` returns: the session and, when this call rotated it (BEH-EA-052), the fresh token. */
export interface VerifiedSession {
  readonly session: SessionView;
  readonly rotated: Option.Option<Redacted.Redacted<string>>;
}
```

`SessionsShape.issue` and `verify` name them (`:352-355`, `:409-412`). `signInSteps.ts:59-63` becomes `export type IssuedSession = Sessions.IssuedSession` (the `SignIn.IssuedSession` re-export stays). The six plugin interfaces and `Saml.ts:125` are deleted, and each Shape names `Sessions.IssuedSession`. `SessionDelivery.ts:53-57` and `:78-85` name it too. `magic-link/src/Channel.ts:56` keeps its alias only if `Channel` exports it today; otherwise it is deleted.

**`ClientAddress.facts` and `ClientAddress.address`** (`packages/ports/src/ClientAddress.ts`):

```ts
/**
 * CSD-003/AGA-001: what a request says about its client, as the explicit `ip`/`userAgent` arguments plugin Shapes
 * take (plan 01 Q1: they stay explicit). Omitted keys, never `undefined` (`exactOptionalPropertyTypes`).
 */
export const facts = (clientAddress: ClientAddressShape, request: HttpServerRequest.HttpServerRequest) =>
  Effect.map(clientAddress.resolve(request), (ip) => ({
    ...(Option.isSome(ip) ? { ip: ip.value } : {}),
    ...Option.match(Headers.get(request.headers, "user-agent"), {
      onNone: () => ({}),
      onSome: (userAgent) => ({ userAgent }),
    }),
  }));

/** The address alone, for a call that keys a rate limit on it and takes no user agent. */
export const address = (clientAddress: ClientAddressShape, request: HttpServerRequest.HttpServerRequest) =>
  Effect.map(clientAddress.resolve(request), (ip) => (Option.isSome(ip) ? { ip: ip.value } : {}));
```

A Shape that takes `(ip, context)` separately (magic link, email OTP, device authorization, passkey `authenticateVerify`, two-factor `run`) destructures it: `const { ip, ...context } = yield* ClientAddress.facts(clientAddress, request)`. Under `exactOptionalPropertyTypes`, `ip` is `string | undefined` and `context` is `{ userAgent?: string }`, which are exactly the parameter types those Shapes declare. Sites that pass `Option.getOrUndefined(resolved)` positionally (`Sso.ts:172`, `Passkey.ts:685`, `Saml.ts:590`, `ApiKey.ts:558`, `ApiKey.ts:614`) keep `clientAddress.resolve`. `facts` and `address` serve the spread forms.

---

## 4. Phased migration

Phase gate: `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`. Phases 0, 4 and 5 also run `pnpm test:bdd`. Plan gate: `pnpm check`. No SQL adapter changes, so `pnpm test:pg` is not required. Create one ticket per phase under `.scratch/credential-resolution/issues/` when work starts.

### Phase 0: hotfix both live bugs in place, tests first (Wave 0; each step its own commit)

**0.1 Bug A, web/next.** Write the tests first, watch them fail, then fix.

1. `packages/web/test/Session.test.ts`: add `SecureDomainLayer` (the `ShortTouchLayer` composition plus `SessionCookie.config({ mode: SessionCookie.SecureDomain({ domain: "example.com", sameSite: "lax" }) })`). Add three tests:
   - "IC-007: under SecureDomain, getSession resolves the session from __Secure-session and ignores __Host-session" (fails today: `undefined`).
   - "IC-007: under SecureDomain, an impersonation session in __Secure-impersonation shadows __Secure-session" (fails today).
   - "IC-007/BO-005: applyRotatedSession writes the rotation as __Secure-session with the Domain, the configured SameSite and a Max-Age from the runtime Clock" (fails today: `__Host-session`, `Strict`, no `Domain`, `Max-Age=0` under `TestClock`).
2. `packages/web/test/HasSessionCookie.test.ts`: add "IC-007: under SecureDomain, a __Secure-session cookie is present, and a bare __Host-session is not" (fails today).
3. Fix, using the final shapes so later phases don't change them again:
   - `Session.ts`: `Session.rotated` becomes `{ token, cookie }`, rendered inside the runtime with `SessionCookie.render` (§3.7). `makeGetSession` reads `SessionCookie.cookieName(config, kind)` from the runtime: one `runtime.runPromise(Effect.service(SessionCookie.SessionCookieConfig))` before the verifies, keeping today's `verify` seam for this phase only. `applyRotatedSession` writes `rotated.cookie`.
   - `HasSessionCookie.ts`: add `Api.sessionCookieName` (§3.7) and the required `cookie` argument (Q1 default). Delegate `SessionCookie.cookieName` to it.
   - Update `web/test/Session.test.ts:284-310` (now asserts `rotated.cookie.name`), `next/test/Seed.test.ts:45` (`rotated` fixture shape), the `HasSessionCookie` tests (pass `{}`), `next/README.md:76-91` and `:320-340`, `web/README.md:7-10`, and the `next` re-export comment.
4. Spec: BEH-EA-055 (drop "`@awthaq/next` renders and reads under the default config only"), BEH-EA-185 and BEH-EA-188 (§6.1). Changeset `.changeset/web-session-cookie-config.md` (§6.4).

**0.2 Bug B, Path B.** Tests first in `packages/qadi/test/SubjectExtractor.test.ts`:

- "BEH-EA-153: a stale session cookie falls through to a valid bearer session, exactly as Authentication does" (B1). It fails today with `anonymous`.
- "BEH-EA-153: a stale session cookie falls through to a claimed bearer credential" (B2).
- "BEH-EA-153/OCM-002: an x-api-key that does not resolve falls through to the bearer" (B3).
- Fix the misnamed `:87` test: send a cookie *and* a bearer of two different users and assert the cookie's user.

Fix `extractCredential` to return the present carriers in order (`ReadonlyArray<{ scheme, credential }>`), and fold `resolvePrincipal` over them with `catchTag("Unauthenticated", next)`, then `anonymousPrincipal`. Judge impersonation on the session via `Authentication.resolveSession` (divergence 1). BEH-EA-153 gets an *As shipped* line (§6.1). Changeset `.changeset/qadi-path-b-fall-through.md`. BDD: add `@REQ-EA-<next>` "A stale session cookie beside a valid bearer token resolves the same subject on both paths" to `20-qadi-bridge-path-b.feature` under BEH-EA-153, with a step in `QadiBridgePathBSteps.ts` that compares `extract` against Path A (`AuthenticationWorld`).

Gate: phase gate and `pnpm test:bdd`. Each step ships alone.

### Phase 1: housekeeping helpers (unblocks plan 13)

1. `core/src/CurrentUser.ts` (§3.8) plus the index export. Migrate every row of §2.6's first table, including `examples/plugin-template/src/Template.ts:271-280` and the matching passage of `docs/plugin-authoring.md` (the template is cited there). Delete `server/src/internal/CurrentUser.ts` and `server/src/internal/Defects.ts`. `server/test/AuthHttp.test.ts:632-655` now asserts `Defects.InvariantViolation` with `invariant === "NonUserPrincipal"`. `pnpm check:error-tags` must still pass (one internal tag fewer).
2. `Sessions.IssuedSession`/`VerifiedSession` (§3.8). Delete the six interfaces and the Saml alias, and fix the Shapes. Regenerate nothing by hand: `features/lib/**/*.d.ts` is build output.
3. `ClientAddress.facts`/`address` (§3.8). Migrate the three `currentClient` helpers and every spread site in §2.6. Delete Password's `requestUserAgent` (`:631-636`). `Password.ts:625-629`'s `sessionRequest` stays (it serialises a Shape's input, not a request).
4. Unit test `packages/ports/test/ClientAddress.test.ts` (extend it if it exists): "facts omits both keys for a bare request, carries ip and userAgent when present, and never carries undefined" and "address carries only ip".
5. Acceptance greps: `grep -rn '_tag !== "User"' packages/*/src` lists only non-guard reads (`DeviceAuthorization.ts:488`, `OAuth.ts:486`, `qadi/src/Resolvers.ts:261`, `roles/src/Roles.ts:253`) and `core/src/CurrentUser.ts`. `grep -rn '"user-agent"' packages/*/src` lists only `ports/src/ClientAddress.ts`, `server/src/RequestContext.ts:85`, `web/src/InProcessClient.ts:121` and the webhooks outbound headers.
6. Changeset `.changeset/current-user-issued-session.md` (§6.4).

### Phase 2: `Credentials` in `@awthaq/server` (behaviour-neutral move, new module, table tests)

1. Write `packages/server/test/Credentials.test.ts` groups T (table), M (memo), O (outage), D (tier derivation) and P (parsing) against `Credentials.make`, `Credentials.httpScope` over `HttpServerRequest.fromWeb(new Request(...))`, and `Credentials.collecting` (§5.1). Every row must fail to compile until step 2 lands, then pass.
2. Create `packages/server/src/Credentials.ts` (§3.2 to §3.5). Move `PrincipalResolver*`, the registry and `contribute`, and update every reference in §2.2's table. That is mechanical: `Authentication.PrincipalResolver` → `Credentials.PrincipalResolver` and so on, in packages, examples, features and docs (`docs/plugin-authoring.md:97-104`). Add `export * as Credentials from "./Credentials.ts"` to `server/src/index.ts` and to its header comment.
3. `Authentication.ts` keeps its handlers for this phase, now importing `PrincipalResolver`/`resolveClaimed` from `Credentials.ts` (no cycle: `Credentials.ts` imports nothing from `Authentication.ts`). `PostAuthResponseHook`'s `context.scheme` becomes `Credentials.Carrier`.
4. `server/README.md` (if present) and `README.md:434-435`: the module list.

Gate: phase gate. Every existing test still passes unchanged, which is the point of the phase.

### Phase 3: Path A onto the module

1. Rewrite the four layers (§3.5). Delete everything listed under "Deleted" in §3.5.
2. Run the §5.1 group A parity tests (every table row through `HttpApiTest` against `Api.Authentication`, `Api.MachineAuthentication` and `Api.OptionalAuthentication`). They must agree with group T row for row.
3. Delete the moved tests (§5.3) from `Authentication.test.ts` and `CredentialResolvers.test.ts`. Keep the adapter tests listed in §5.2.
4. `features/step-definitions/AuthenticationWorld.ts:563-600` (`resolveSessionPrincipal`), `AdminWorld.ts:230-260` and `HttpErrorWorld.ts:217-240`: replace `Authentication.resolvePrincipal(sessions, resolver, credential, scheme)` with a shared step helper `features/step-definitions/support/resolveCredential.ts`. The helper builds `Credentials.make`, `Credentials.httpScope(request)` and a `Presented` holding the token in the right carrier, runs `step`, and maps `Unauthenticated` as the world needs. REQ-EA-186, 188 and 203 keep observing per-scheme handler attempts through `TracedAuthentication` (`AuthenticationWorld.ts:162-185`): the per-scheme handlers still exist (§3.1).
5. Comments: `core/src/Sessions.ts:380-397` (name `Credentials` and its per-scope memo) and `test/src/TestAuth.ts:387-388`.

Gate: phase gate and `pnpm test:bdd` (REQ-EA-185 to 203, 605, 609, 613, 616, 630 and 802 to 807 must pass unchanged in meaning).

### Phase 4: Path B onto the module

1. `SubjectExtractor.ts` becomes §3.6. The Phase 0.2 loop is deleted.
2. `SubjectExtractor.test.ts`: delete the rows the table now owns (§5.3). Keep the adapter tests and add the two missing ones (§5.2).
3. `QadiBridgePathBSteps.ts:216-315` (REQ-EA-429): compare `extract` against `Credentials.resolve(…, machineTier, …)` instead of `resolvePrincipal`. `:358-365` (REQ-EA-430, the tripwire): require that `SubjectExtractor.ts` calls `credentials.resolve(` exactly once, contains no `request.cookies[`, no `"authorization"` and no `sessions.verify(`, and imports `Credentials` from `@awthaq/server`. Update the scenario wording in `20-qadi-bridge-path-b.feature:30` ("goes through the one credential module").
4. `qadi/README.md:8`: nothing to change. Check `examples/memory-server/app.ts:87` still builds.

Gate: phase gate and `pnpm test:bdd`.

### Phase 5: web/next onto the module

1. `web/src/Session.ts` becomes §3.7: `resolveSessionCookies`, the new `makeGetSession` and the `Session.principal` narrowing. Delete `verifySessionToken`, `VerifySessionToken`, `resolve` and the Phase 0.1 interim config read.
2. `next/src/GetSession.ts:9-32`: `cache(resolveSessionCookies)`. `next/src/index.ts` is unchanged.
3. `web/src/index.ts:20-21` exports. `web/test/Session.test.ts`: rewrite `:95-127` for the new seam ("routes the whole cookie header through the injected resolver, so an adapter can dedupe per render: two calls in one render verify once"). Delete `:129-164` (now table row T7/T8 in the web describe of §5.1). `:320-345` (RSC-007) must pass unchanged.
4. `24-nextjs-ssr.feature` under BEH-EA-185: add `@REQ-EA-<next>` "Under a domain-scoped session cookie getSession verifies the configured cookie", with steps in `NextSsrSteps.ts` (the world gains a `SecureDomain` variant).

Gate: phase gate and `pnpm test:bdd`.

### Phase 6: spec, ADR, docs, sweep

1. Every edit in §6 (BEH revisions, ADR-EA-042, ADR-EA-028 rev 1.6, ADR-EA-015 rev 1.2 consequences line, glossary, traceability).
2. Re-run the Goal 1 grep and §9's greps.
3. `pnpm check`, `pnpm spec:verify:strict`, `pnpm check:readmes`, `pnpm package:smoke` (server, web, api and ports exports changed).

---

## 5. Test plan

**Replace, don't layer.** The policy is tested once, at `Credentials`' interface, as a table. Each adapter keeps only what it adds: Path A's hook, challenge and OpenAPI; Path B's anonymous and outage mapping; web's rendering and jar.

### 5.1 `packages/server/test/Credentials.test.ts` (new)

Fixtures: memory `Users`/`Sessions` (the `ShortTouchLayer` shape of `web/test/Session.test.ts:64-85`), `CredentialResolversLive` with three test contributions (`svc.*` bearer → `ServicePrincipal`, `jwtu.*` bearer → `UserPrincipal`, `ak_*` api key → `ApiKeyPrincipal`; `ak_bad*` fails `Unauthenticated`), and an outage `Sessions` decorator for group O. Sessions: `own` (user A), `other` (user B), `imp` (B acting as A, `actingAs`), `planted` (an ordinary session of B), `stale` (an unknown or expired token).

**Group T (table), run through `credentials.resolve(presented, tier, httpScope(request))`:**

| # | impersonation | cookie | apiKey | bearer | user tier | machine tier | optional tier |
|---|---|---|---|---|---|---|---|
| T1 | – | – | – | – | Unauthenticated | Unauthenticated | Unauthenticated (anonymous at the adapter) |
| T2 | – | own | – | – | A via cookie | A via cookie | A via cookie |
| T3 | – | own | – | other | A via cookie | A via cookie | A via cookie |
| T4 | – | stale | – | other | **B via bearer** (bug B row) | B via bearer | B via bearer |
| T5 | – | stale | – | `jwtu.*` | User via bearer (Claimed) | same | same |
| T6 | – | stale | – | `svc.*` | Unauthenticated | Service via bearer | Unauthenticated |
| T7 | imp | own | – | – | B acting as A, carrier impersonation | same | same |
| T8 | planted | own | – | – | A via cookie | A via cookie | A via cookie |
| T9 | planted | – | – | – | Unauthenticated | Unauthenticated | Unauthenticated |
| T10 | stale | own | – | – | A via cookie | same | same |
| T11 | – | – | `ak_1` | – | Unauthenticated (not declared) | ApiKey via apiKey | Unauthenticated |
| T12 | – | – | `nope` | own | A via bearer | **A via bearer** (unclaimed key falls through) | A via bearer |
| T13 | – | – | `ak_bad` | own | A via bearer | **A via bearer** (bug B3 row) | A via bearer |
| T14 | – | own | `ak_1` | – | A via cookie | A via cookie | A via cookie |
| T15 | – | – | – | `ak_1` | Unauthenticated (not a session, not claimed) | same | same |
| T16 | – | – | – | own (opaque) | A via bearer (Session) | same | same |
| T17 | – | – | – | `jwtu.bad` (claimed, fails) | Unauthenticated, and `Sessions.verify` never ran | same | same |
| T18 | imp | – | – | own | B acting as A | same | same |
| T19 | – | – | `ak_1` | `svc.*` | Unauthenticated | ApiKey (apiKey before bearer) | Unauthenticated |
| T20 | (under `SecureDomain`) `__Host-session=own` only | – | – | – | Unauthenticated | same | same |
| T21 | (under `SecureDomain`) `__Secure-session=own` | – | – | – | A via cookie | same | same |
| T22 | (under `SecureDomain`) `__Secure-impersonation=imp` + `__Secure-session=own` | – | – | – | B acting as A | same | same |
| T23 | – | own, under a `PrincipalResolver` that answers a `ServicePrincipal` | – | – | **Unauthenticated** (admission now applies to session principals) | Service via cookie | Unauthenticated |

Each row asserts `_tag`, `carrier` and principal id. Write it as `describe.each`/`it.effect.each` over one `const rows = [...] as const` table (the `as const` literal form), one test per (row, tier) pair, titled `T<n> <tier>: <expectation>`.

**Group A (Path A parity, Phase 3):** the same `rows`, served through `HttpApiTest` with `AuthenticationLive`, `MachineAuthenticationLive` and `OptionalAuthenticationLive`, asserting the same principal (`who` endpoint) or 401. Optional rows that expect `Unauthenticated` must see `Anonymous`. This is the proof that Effect's loop plus `step` equals `resolve`.

**Group M (memo):**

- M1 "PCS-006: two concurrent steps for one scope and credential call verify exactly once" (from `Authentication.test.ts:719`).
- M2 "a re-wrapped request (request.modify) shares the original's scope" (from `:736`).
- M3 "an interrupted first step does not wedge a second caller" (from `:756`).
- M4 (new) "a claimed credential resolves once per scope across two tiers": count contribution `resolve` calls over `resolve(…, userTier)` then `resolve(…, machineTier)` on one request.
- M5 (new) "a rotating verify hands exactly one Rotation to scope.deliver, carrying the carrier it came in on".

**Group O (outage, MA-004):**

- O1 "a cookie-carrier outage fails StoreUnavailable and the bearer step on the same scope fails with it, not Unauthenticated" (the unit form of `:431`).
- O2 "a claimed-credential outage stops resolve; later carriers are not tried".
- O3 (new) "optional tier: an outage is StoreUnavailable, never anonymous".

**Group D (derivation, BEH-EA-072):**

- D1 "every declared key of Authentication, AdminAuthentication, OptionalAuthentication and MachineAuthentication is a carrier, so the tier lists every scheme". `Record.keys(declaration.security).length === tier.carriers.length`.
- D2 "the tiers' carriers equal the declarations' key order" (replaces `Authentication.test.ts:780`, which duplicated `api/test/Api.test.ts:127`).
- D3 "a redeclared record ({ bearer, cookie }) yields a tier in that order".

**Group P (parsing):**

- P1 "the bearer reader equals HttpApiBuilder.securityDecode(Api.BearerToken)" over `["Bearer t", "bearer t", "BEARER  t", "Bearer", "Bearer ", "Basic t", "Bearert", "Bearer t ", ""]`.
- P2 "the cookie reader equals securityDecode(Api.SessionCookie) under the default config, and reads the configured name otherwise".
- P3 "x-api-key is read raw, an empty value is absent".

**`describe("collecting scope")`:**

- C1 "rotations are collected with their carrier and never delivered to a response".
- C2 "claim is never consulted".

That gives 23 rows × 3 tiers (69 cases) plus groups A, M, O, D, P and C (about 25 cases).

### 5.2 Adapter tests that stay or are added

- `server/test/Authentication.test.ts` keeps:
  - the `PostAuthResponseHook` tests (`:311`, `:348`, `:393`)
  - the served 503 (`:526`)
  - rotation delivery through the HTTP sink (`:539`, `:562`, `:583`, `:619`, `:642`, `:658`, `:676`): these exercise `rotationDelivery` end to end and are not duplicated in the table
  - OpenAPI (`:794`)
  - the JR-007 challenge (`:838-890`), plus **new** "the machine tier's 401 carries the same challenge" (gap)
  - logging (`:984-1030`)
  - the `PrincipalResolverWithUserFactsLive` tests (`:893-925`)
- The BEH-EA-211 mapping tests (`:226`, `:243`) move to `Credentials.test.ts` under `describe("PrincipalResolverLive")`, next to the resolver.
- `server/test/CredentialResolvers.test.ts` keeps the registry mechanics (`:172`, `:186`, `:204`, `:305-345`) and the hook (`:282`).
- `qadi/test/SubjectExtractor.test.ts` keeps:
  - `:56` (anonymous mapping)
  - `:161` (Path A + Path B on one route share the memo)
  - `:207` (a Path-B-only route delivers the rotation)
  - Phase 0.2's B1 to B3 regressions, which are the adapter-level proof the bug stays fixed
  - **new** "a store outage is SubjectExtractionFailed, never anonymous" (gap)
  - **new** "an impersonation session is judged on the session, not the resolved principal": a resolver that drops `actingAs` still evaluates the target (divergence 1)
- `web/test/Session.test.ts` keeps or rewrites:
  - the seam test (rewritten, `:95`)
  - the basic cases (`:167`, `:173`, `:182`, `:191`, `:219`)
  - the rotation and jar cases (`:241`, `:284`, rewritten for `rotated.cookie`)
  - RSC-007 (`:320`, unchanged)
  - the three Phase 0.1 `SecureDomain` tests
  - **new** "a planted ordinary session's rotation in the impersonation cookie is not rendered into Session.rotated"
- `web/test/HasSessionCookie.test.ts`: the four tests take `{}`; the `SecureDomain` test from Phase 0.1 is added.
- `next/test/GetSession.test.ts`: `:33`, `:39` and `:51` unchanged. Add "React.cache dedupes the whole cookie-header resolution: two getSession calls in one render verify once", ported from the web seam test.

### 5.3 Tests deleted or moved, by name

From `packages/server/test/Authentication.test.ts`:

| Line | Test | Now |
|---|---|---|
| `:153` | "BEH-EA-067: fails Unauthenticated when neither cookie nor bearer resolves" | T1 |
| `:161` | "BEH-EA-065: a valid session cookie resolves CurrentPrincipal…" | T2 |
| `:175` | "BEH-EA-066: a valid bearer token resolves the same UserPrincipal…" | T16 |
| `:187` | "BEH-EA-065/072: cookie is tried before bearer…" | T3 |
| `:204` | "BEH-EA-068/029: OptionalAuthentication resolves Anonymous…" | T1 optional + group A |
| `:212` | "BEH-EA-068: OptionalAuthentication still resolves a real principal from a valid bearer token" | T16 optional |
| `:257` | "APS-006: a session carrying actingAs authenticates from the __Host-impersonation cookie…" | T7 |
| `:277` | "APS-006: an ordinary session planted in __Host-impersonation never authenticates…" | T8, T9 |
| `:431` | "resolveSession fails StoreUnavailable…" | O1 |
| `:719` | "two concurrent resolveSession calls…" | M1 |
| `:736` | "a re-wrapped request…" | M2 |
| `:756` | "an interrupted first resolver…" | M3 |
| `:780` | "NHS-010: the security middlewares declare their keys in order…" | D2 (and `api/test/Api.test.ts:127`) |
| `:802` | "EHA-006: OptionalAuthentication tries the cookie, then the bearer, then anonymous…" | T4, T1 optional |

From `packages/server/test/CredentialResolvers.test.ts`:

| Line | Test | Now |
|---|---|---|
| `:133` | "with no contribution a JWT-shaped bearer is a session lookup miss" | T15/T16 family; keep one served 401 in group A |
| `:143` | "a claimed bearer credential's User principal becomes CurrentPrincipal" | T5 |
| `:153` | "the user tier never admits a machine principal; the machine tier does" | T6 |
| `:221` | "no contribution claims an opaque bearer: it still resolves through Sessions" | T16 |
| `:233` | "the apiKey carrier reads x-api-key on the machine tier; cookie still wins" | T11, T14 |
| `:250` | "an unclaimed x-api-key is Unauthenticated…" | T12 |
| `:260` | "the user tier ignores x-api-key entirely…" | T11 user/optional |
| `:270` | "OptionalAuthentication: a claimed User credential resolves, a failed one is anonymous" | T5, T17 optional |

From `packages/qadi/test/SubjectExtractor.test.ts`:

| Line | Test | Now |
|---|---|---|
| `:65` | "BEH-EA-153: a valid session cookie resolves the real user…" | T2 machine |
| `:87` | "BEH-EA-153: a bearer credential is accepted too, cookie taking priority…" (its body never tested the priority) | T3, T16 machine |
| `:109` | "APS-006: an __Host-impersonation cookie shadows __Host-session…" | T7, T8 |
| `:148` | "BEH-EA-153: an unknown session resolves to anonymous…" | T10/T1 + `:56` |
| `:283` | "a claimed bearer credential resolves to its principal's subject" | T6 machine |
| `:290` | "an x-api-key credential resolves through the apiKey carrier" | T11 machine |
| `:297` | "an unclaimed x-api-key is anonymous…" | T12 machine |

From `packages/web/test/Session.test.ts`:

| Line | Test | Now |
|---|---|---|
| `:130` | "APS-006: an impersonation cookie shadows the session cookie…" | T7, T8 (the web's resolution is `resolve(userTier)`) |

That is 30 tests deleted. The table and its groups add about 95 cases, plus group A's served parity.

### 5.4 BDD (`features/`)

New REQ ids are the next free ones at execution time (above `REQ-EA-1306` today; plans 12 to 24 also allocate).

- `20-qadi-bridge-path-b.feature`, BEH-EA-153: "A stale session cookie beside a valid bearer token resolves the same subject on both paths" (Phase 0.2). REQ-EA-429 and REQ-EA-430 are rewritten (Phase 4).
- `24-nextjs-ssr.feature`, BEH-EA-185: "Under a domain-scoped session cookie getSession verifies the configured cookie" (Phase 5). BEH-EA-188: "hasSessionCookie checks the configured cookie name" (Phase 0.1).
- `09-authentication-middleware.feature`, BEH-EA-066: "A stale session cookie beside a valid bearer token authenticates as the bearer's user" (a gap: REQ-EA-188 sends no cookie). BEH-EA-071: "The machine tier tries x-api-key before the bearer and falls through when the key does not resolve" (a gap).
- These must keep passing unchanged in meaning:
  - REQ-EA-185 to 203; 186, 188 and 203 observe per-scheme attempts, which §3.1 preserves
  - REQ-EA-428 and 450
  - REQ-EA-605, 609, 613, 616 and 630
  - REQ-EA-802 to 807
  - REQ-EA-1295 and 1296
  - REQ-EA-522 to 534

---

## 6. Spec, ADR, traceability and changesets

### 6.1 Behaviour specs (each gets a Document Control revision and a change-history line)

- `spec/behaviors/09-authentication-middleware.md` → rev 1.5.
  - BEH-EA-065 APS-006 paragraph: replace "`@awthaq/qadi`'s Path B extractor and `@awthaq/next`'s `getSession` apply the same precedence" with "**As shipped (ADR-EA-042):** every entry point resolves through `@awthaq/server`'s `Credentials`: Path A's handlers run one carrier each (`step`), and the optional tier, Path B and the web adapter run the declaration's whole chain (`resolve`). The impersonation rule is judged on the session, before the `PrincipalResolver`."
  - BEH-EA-066 resolvers paragraph: "On every tier a principal is admitted only if the tier admits it, whether claimed or session-derived." Also: "`@awthaq/qadi`'s Path B extractor resolves credentials through the same module, over the machine tier's declaration, and falls through identically."
  - BEH-EA-070 PCS-006 paragraph: the memo is per (request, credential) for sessions **and** for claimed credentials (one throttle charge, one JWT verify per request).
  - BEH-EA-072: "The chain is read from the declaration by every entry point, Path A by Effect's loop and the others by `Credentials.tier(declaration, …)`; a test fails if a declared key is not a carrier."
- `spec/behaviors/20-qadi-bridge-path-b.md` → rev 1.3. BEH-EA-153: an *As shipped* paragraph: "`SubjectExtractorLive` is an adapter over `Credentials.resolve(presented, machineTier, httpScope(request))`. A credential that does not resolve falls through exactly as on Path A (a stale cookie beside a valid bearer is the bearer's user, not anonymous); only when every carrier fails is the subject anonymous; an outage is `SubjectExtractionFailed`."
- `spec/behaviors/24-nextjs-ssr.md` → rev 1.2.
  - BEH-EA-185: "`getSession` reads the session and impersonation cookies under the runtime's `SessionCookieConfig` and resolves through `Credentials` (the user tier). `Session.rotated` carries the rotation already rendered under that config; `applyRotatedSession` writes it. A planted ordinary session's rotation in the impersonation cookie is not rendered. The dedup unit an adapter injects is the whole cookie-header resolution (`resolveSessionCookies`)."
  - BEH-EA-188: "`hasSessionCookie(request, cookie)` takes the session-cookie mode (the same partial given to `SessionCookie.config`) and checks its name; it imports nothing from `@awthaq/core`/`@awthaq/server` at runtime and is also exported from `@awthaq/web/cookies`." (Or the Q1 alternative.)
- `spec/behaviors/07-sessions.md` → rev 1.8. BEH-EA-055 `SecureDomain` bullet: replace "Readers (`Authentication`'s cookie handler, `SubjectExtractor`, the legacy-cookie alias middleware) resolve the configured name … `@awthaq/next` renders and reads under the default config only." with "Every reader (the one credential reader `Credentials.presented`, the legacy-cookie alias middleware, `hasSessionCookie`) and every renderer, including the web adapter's rotation, uses the configured name; the naming rule is `Api.sessionCookieName`."
- `spec/behaviors/27-admin-impersonation.md` → rev 1.5. BEH-EA-211's title and requirement: "`resolvePrincipal`" → "`Credentials`' session resolution". The anchor changes, so fix the inbound links (`grep -rn "beh-ea-211" spec`).
- `spec/glossary.md` → rev 1.6. Add **Credential carrier**: "One of the four places a request may present a credential (`impersonation` and `cookie` cookies, the `x-api-key` header, `Authorization: Bearer`). A middleware's security declaration lists its carriers in order; that list is the strategy chain (BEH-EA-072)." Add **Tier**: "Which principals an authentication middleware admits: the user tier (`Authentication`, `OptionalAuthentication`, `AdminAuthentication`) only a `User`, the machine tier (`MachineAuthentication`) any." Update **CurrentPrincipal** to name `CurrentUser.current` as the user-tier read.

### 6.2 Decisions

- **New ADR-EA-042** (`spec/decisions/042-credential-resolution-module.md`, plus an `index.yaml` entry), "Credential Resolution Is One Module; Every Entry Point Derives Its Chain From a Middleware Declaration". It contains:
  - Context: §1 and §2.1, both bugs.
  - Decision:
    - the module and its `Scope` seam (§3.2 to §3.4)
    - Path A keeps per-scheme handlers so Effect's loop over the declaration remains the chain (REQ-EA-203)
    - the other entry points fold over the same declaration
    - tier admission applies to every principal
    - the impersonation rule is judged on the session
    - claimed credentials join the per-request memo
    - the web adapter renders inside the host runtime
    - the cookie naming rule lives in `@awthaq/api`
  - Alternatives considered:
    - (a) A whole-chain handler for Path A too. Rejected: a redeclared record would stop changing the order, against BEH-EA-072/REQ-EA-203.
    - (b) Making the precedence a `Context.Service` a host may override. Rejected: BEH-EA-072 forbids a second ordering mechanism, and no caller needs it.
    - (c) Living in `core`. Rejected: the tiers are `Api` declarations, and `PrincipalResolver` and the registry are server modules (§2.3).
    - (d) Keeping per-adapter copies with a shared test table only. Rejected: the copies would still drift between test runs, as they did.
    - (e) A per-request whole-resolution memo. Not needed: the per-credential memos and the outage record make reruns of the chain free, and a whole-chain memo would have to be per tier.
  - Consequences: §7.
- **ADR-EA-028 rev 1.6**, decision 4: "the first scheme to see an outage records it against the request" → "the outage is recorded against the request's credential scope (`Credentials`), so every later carrier of that request (Path A's later handlers, Path B, the web adapter) fails with it". The Path B sentence stays.
- **ADR-EA-015 rev 1.2**: one Consequences line: "Both bridges resolve the caller through the same `Credentials` module (ADR-EA-042), so the identity Path A serves and the subject Path B authorises are the same for every credential combination."
- ADR-EA-009, ADR-EA-003, ADR-EA-013 and ADR-EA-014: no change (checked: 009 delegates authorisation, which is unaffected; 003's contract is unchanged; 013's error mapping is unchanged; 014's storage neutrality is untouched).

### 6.3 Traceability

`spec/traceability.md`:

- `:223` (`Authentication.test.ts`): narrow it to the adapter (hook, challenge, OpenAPI, served outage, rotation delivery).
- Add a row for `packages/server/test/Credentials.test.ts`: "ADR-EA-042, BEH-EA-065/066/068/070/072/153/211: the credential table over three tiers (T1 to T23), Path A parity, memo, outage, declaration-derived tiers, parsing parity with `securityDecode`, the collecting scope".
- `:261` (`SubjectExtractor.test.ts`): "the Path B adapter: anonymous and outage mapping, fall-through regressions B1 to B3, Path A + B memo, rotation on a Path-B-only route".
- `:271` and `:273`: name `SecureDomain`.
- The ADR-EA-028 row (`:170`): add `Credentials.test.ts`.
- Add a row for ADR-EA-042.

`features/traceability.md`: add the new REQ rows (§5.4) and update REQ-EA-429 and 430.

### 6.4 Changesets (ADR-EA-034: breaking ones carry a `Migration:` line)

- Phase 0.1, `.changeset/web-session-cookie-config.md`, `"@awthaq/web": minor`, `"@awthaq/next": minor`, `"@awthaq/api": minor`, `"@awthaq/core": patch`:

  > `getSession` and `applyRotatedSession` honour the configured `SessionCookieConfig`: under `SessionCookie.SecureDomain` the session is read from `__Secure-session` (and `__Secure-impersonation`) and a rotation is written with the configured name, `Domain` and `SameSite` (BEH-EA-055/185). `hasSessionCookie` checks the configured name (BEH-EA-188). `Api.sessionCookieName` is the one naming rule.
  >
  > Migration: `hasSessionCookie(request)` → `hasSessionCookie(request, cookie)`, passing the same partial you give `SessionCookie.config(...)` (`{}` for the default). `Session.rotated` is now `{ token, cookie }`; read `rotated.token` where you read the raw secret.

- Phase 0.2, `.changeset/qadi-path-b-fall-through.md`, `"@awthaq/qadi": patch`:

  > `SubjectExtractorLive` falls through to the next credential when one does not resolve, as `Authentication` does: a stale session cookie beside a valid bearer token, or an unresolvable `x-api-key` beside one, is now the bearer's subject instead of anonymous (BEH-EA-153). An impersonation cookie is judged on its session's `actingAs`.

- Phase 1, `.changeset/current-user-issued-session.md`, `"@awthaq/core": minor`, `"@awthaq/ports": minor`, `"@awthaq/server": minor`, and `minor` for admin, passkey, password, two-factor, magic-link, organization, webhooks, saml and api-key:

  > `CurrentUser.current` is the one read of a user-tier caller; `Sessions.IssuedSession`/`Sessions.VerifiedSession` name what `issue`/`verify` return; `ClientAddress.facts`/`address` build a Shape's explicit `ip`/`userAgent` from a request.
  >
  > Migration: `Password.IssuedSession`, `Passkey.IssuedSession`, `TwoFactor.IssuedSession`, `MagicLink.IssuedSession`, `EmailOtp.IssuedSession` and `Admin.IssuedSession` → `Sessions.IssuedSession`. A non-`User` principal on a user-tier group now dies with `Defects/InvariantViolation` (`invariant: "NonUserPrincipal"`), never `HandlerInvariantViolation`.

- Phases 2 to 5, `.changeset/credentials-module.md`, `"@awthaq/server": minor`, `"@awthaq/qadi": minor`, `"@awthaq/web": minor`, `"@awthaq/next": minor`, plus `patch` for jwt and api-key (import renames):

  > `@awthaq/server`'s `Credentials` module is the one place a request's credentials are read, ordered, resolved, admitted and their rotation handed off (ADR-EA-042). `Authentication`, `SubjectExtractorLive` and `getSession` are adapters over it. A tier now also refuses a session-derived principal it does not admit. A claimed credential (API key, JWT) is resolved at most once per request.
  >
  > Migration: `Authentication.PrincipalResolver*`, `Authentication.contribute`, `Authentication.CredentialResolvers*` → `Credentials.*` (same names). `Authentication.resolvePrincipal`/`resolveSession`/`ResolvedSession` are gone: use `Credentials.make` and `step`/`resolve` with `Credentials.httpScope(request)`, and `Sessions.VerifiedSession`. Web: `verifySessionToken`/`VerifySessionToken` → `resolveSessionCookies`/`ResolveSessionCookies` (the whole cookie header is the dedup unit); `Session.principal` is `Api.UserPrincipal`.

---

## 7. Risks, mitigations, rollback

| Risk | Mitigation |
|---|---|
| **Path A's behaviour changes subtly** when its handlers move from Effect's decoded `credential` to the module's reader | Group P proves byte equality with `securityDecode` for every scheme. Group A runs the whole table through the real middleware. Phase 2 lands the module before any adapter uses it |
| **Stricter admission** (T23): a deployment whose custom `PrincipalResolver` maps a session to a non-`User` principal now gets 401 on user-tier groups instead of a `NonUserPrincipal` defect in the handler | It was already a wiring defect: every user-tier handler dies on it (§2.6). The changeset says so. The machine tier still admits it |
| **Path B now admits more** (a fall-through can authorise as the bearer's principal where it was anonymous) | That is the fix, and it is what Path A already serves. On a route behind both bridges the two now agree. A route behind Path B alone gains the bearer's subject, which is what a request carrying both credentials meant |
| **`hasSessionCookie` signature break** | Pre-1.0 (ADR-EA-034), with a changeset migration line. Q1 offers the non-breaking alternative |
| **The web dedup unit widens** (`React.cache` on the cookie header, not on each token) | Within a render the header is one string, so it dedupes strictly more. Across renders `React.cache` never spans (NSA-002, unchanged). The rewritten seam test plus the next test pin it |
| **RSC-007 concurrency lost** (the user lookup now follows the module's resolution) | The decorated `PrincipalResolver` (§3.7) keeps `findById` beside `resolver.resolve`; `web/test/Session.test.ts:320` must stay green. Fallback if the decoration fights inference: run them sequentially and record the decision |
| **Memo key collision**: claimed and session memos keyed by the raw credential | Separate tables. Claimed slots are prefixed with the carrier (`apiKey:` vs `bearer:`), so one string presented as both a key and a bearer resolves per carrier |
| **Circular imports** | `Credentials.ts` imports nothing from `Authentication.ts`; `pnpm circular` runs every phase. Plan 04's lesson: type-only cycles count too |
| **Edge bundle grows** (`HasSessionCookie.ts`) | Type-only import of `SessionCookie.Mode`, runtime import of `@awthaq/api` only. Extend `EdgeImports.test.ts` to walk `HasSessionCookie.ts` |
| **BDD helper drift** (four worlds rebuilt on `step`) | One shared helper (Phase 3 step 4). REQ-EA-605, 195 and 429 compare outcomes, not mechanisms |
| **Plan 13 lands first** and edits the admin `currentUserPrincipal` copies | §8: plan 13 consumes `CurrentUser.current`. If it lands first, Phase 1 migrates whatever copies remain |

**Rollback.** Phase 0's two steps each revert alone. Phase 1 reverts as a unit (helpers and call sites). Phase 2 is additive except for the renames, so reverting it restores `Authentication.*`. Phases 3, 4 and 5 are each one adapter and revert independently, because the module stays. If the Path A rewrite misbehaves in production, reverting Phase 3 restores the old handlers over the moved `PrincipalResolver`.

---

## 8. Interactions with other plans

- **01 (sign-in, done)**: decision 7 (Q1 = no) keeps `ip`/`userAgent` explicit. `ClientAddress.facts` builds those arguments and changes no Shape. Decision 8's `SessionDelivery.respond` names `Sessions.IssuedSession` after Phase 1.
- **08 (test composition, done)**: `TestAuth.layer` (`test/src/TestAuth.ts:356-398`) provides `PrincipalResolverLive`; it becomes `Credentials.PrincipalResolverLive`. `AuthHttp.middlewareFor` (`server/src/AuthHttp.ts:154-196`) keeps the four layer names.
- **10 (standalone fixes, done)**: item 0 (API-key owner standing) lives inside the `apikey.key` contribution. It is unaffected, and is now invoked once per request (M4).
- **12 (passkey ceremony)**: touches `Passkey.ts`. Phase 1 changes its `currentUserPrincipal` (`:617-627`), `IssuedSession` (`:494-497`) and request facts (`:682`, `:701-706`). Whichever lands second rebases. No semantic overlap.
- **13 (admin gate)**: plan 11 **owns exporting** `CurrentUser.current` (Phase 1). Plan 13 **consumes** it in `Admin.ts`, `AdminAccounts.ts` and `AdminTenants.ts` and does not define its own. Recommended order: plan 11 Phase 1 before plan 13. If 13 goes first, it leaves the three admin copies as they are and Phase 1 migrates them.
- **14 (federated identity)**: `OAuth.ts` and `Saml.ts` request-facts sites (`OAuth.ts:544-558`, `Saml.ts:472-480`) are edited by both plans. Rebase only.
- **15 (host composition)**: derives the servable layer from `Auth.make`, including middleware. It consumes `Authentication.AuthenticationLive` and the other layers (names unchanged) and `Credentials.PrincipalResolver` (renamed in Phase 2). If 15 lands first, Phase 2's rename sweep includes its files.
- **19 (session verdict)**: extracts the verdict from `Sessions.verify`. `Credentials` calls `verify` once per credential and maps only `Sessions/NotFound`/`SessionExpired` to `Unauthenticated`. If plan 19 adds verdict tags, `verified` (§3.3) maps them in that one place instead of four.
- **20 (in-process user agent)**: its cookie jar must present the *configured* names. It should use `Api.sessionCookieName`/`SessionCookie.cookieName`, and for bearer capture `Api.ROTATED_TOKEN_HEADER`, which `Credentials.httpScope` writes. `TestAuth.signInAs` (`TestAuth.ts:519`) and web `InProcessClient` are plan 20's to fix. The collecting scope (§3.4) is reusable if plan 20 needs in-process resolution.
- **21 (session-minting annotation)**: owns *minting* delivery. The rotation sink's rule "a handler-written cookie of the same name wins" (moved verbatim into `rotationDelivery`) is the contract between them. If plan 21 changes how minting writes the cookie, the sink's `Cookies.get(response.cookies, name)` check must still see it.
- **16, 17, 18, 22, 23, 24**: no overlap.

---

## 9. Acceptance checklist

- [ ] Phase 0: the `SecureDomain` web tests, the `hasSessionCookie` test and the Path B fall-through tests (B1 to B3) fail before their fix and pass after. The misnamed `SubjectExtractor.test.ts:87` test asserts cookie priority.
- [ ] `packages/server/src/Credentials.ts` exists. `Authentication.ts` is the Path A adapter (no `resolveSession`, `resolvePrincipal`, `cookieCredential`, `requireImpersonationSession` or `requestOutages`).
- [ ] `grep -rnE "request\.cookies\[|Headers\.get\(request\.headers, \"authorization\"\)|API_KEY_HEADER_NAME" packages/{server,qadi,web}/src` finds only `Credentials.ts`.
- [ ] `grep -rn "Api.SessionCookie.key\|Api.ImpersonationCookie.key\|defaultValue()" packages/web/src packages/next/src` finds nothing.
- [ ] `grep -rn "resolvePrincipal\|resolveSession\|ResolvedSession\|HandlerInvariantViolation\|currentUserPrincipal\|currentClient\|requestUserAgent" packages examples features --include='*.ts'` finds nothing, apart from build output under `features/lib`.
- [ ] `grep -rn "interface IssuedSession" packages/*/src` finds only `core/src/Sessions.ts`.
- [ ] The §5.1 table (T1 to T23 × three tiers) and groups A, M, O, D, P and C pass. Group A agrees with group T on every row.
- [ ] The 30 tests in §5.3 are deleted. The adapter tests in §5.2 pass, including the new machine-tier challenge, the Path B outage and the session-judged impersonation.
- [ ] RSC-007 (`web/test/Session.test.ts:320`) passes unchanged. The next dedup test passes.
- [ ] The edge import walk covers `HasSessionCookie.ts` and finds no `@awthaq/core`/`@awthaq/server` runtime import.
- [ ] No `as` (other than `as const`), no new return-type annotations, and no new `orDie` in touched source.
- [ ] BEH-EA-055/065/066/070/072/153/185/188/211 are updated with revision bumps. ADR-EA-042 is added and indexed. ADR-EA-028 is at rev 1.6 and ADR-EA-015 at rev 1.2. The glossary has Credential carrier and Tier.
- [ ] `spec/traceability.md` and `features/traceability.md` are updated, and the new REQ scenarios pass in `pnpm test:bdd`.
- [ ] Changesets exist with `Migration:` lines (§6.4).
- [ ] `pnpm check` is green on the final commit.

---

## 10. Open questions only the user can answer

1. **`hasSessionCookie`'s signature.**
   - (a, recommended) A required second argument, the cookie mode (the same partial passed to `SessionCookie.config`). It is edge-safe through the `@awthaq/api` naming rule, and a `SecureDomain` host cannot forget it.
   - (b) Keep `hasSessionCookie(request)` and answer `true` when either `__Host-session` or `__Secure-session` is present. It is presence-only and never the boundary, so the looser check costs no security. But it does not read the configuration, and a stray cookie from a sibling subdomain passes `proxy.ts`.
2. **Path B's tier.**
   - (a, recommended) The machine tier's declaration and admission, as today: x-api-key is read, and any claimed principal is a subject.
   - (b) Make it a layer argument (`SubjectExtractor.layer(Credentials.userTier)`) so a user-only deployment refuses machine principals at the authorisation step too.

   No caller asks for (b) today.
3. **Stricter admission for session-derived principals** (T23). Accept that a custom `PrincipalResolver` returning a non-`User` from a session is a 401 on user-tier groups (recommended: today it is a defect in every handler)? Or keep admission for claimed credentials only?
4. **Delivery of a planted session's rotation.** On HTTP, keep delivering the rotation of an ordinary session planted in the impersonation cookie, as today? Recommended: yes, the sink is unchanged. The web adapter renders only the resolved session's rotation either way. Alternatively, deliver only the resolved session's rotation on HTTP too, which makes a planted cookie die after `rotationGrace` everywhere.
5. **Bearer in the web adapter.** Should `getSession` also read `Authorization: Bearer`, so a Route Handler serving a native client resolves it? Recommended: no (BEH-EA-185 is cookie-only, and rotation then has no jar to land in). If yes, the presented source gains `header: (name) => headers.get(name)` and the rotation needs a header sink.
6. **Plugin `IssuedSession` names.** Delete them in favour of `Sessions.IssuedSession` (recommended: one name), or keep one-line `export type IssuedSession = Sessions.IssuedSession` aliases per plugin for discoverability?
