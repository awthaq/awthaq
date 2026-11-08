# Plan 26: Request facts are read from `AuthRequestContext` only

| | |
|---|---|
| Source | Architecture review of 2026-11-08 (`/improve-codebase-architecture`), candidate "request facts are read from `AuthRequestContext` only, instead of being threaded through every plugin call" |
| Strength | Strong |
| Dependency category | in-process (one per-request value; no new adapter, no new port) |
| Wave / position | Batch 3 (plans 25–30). Phases 0–3 depend on nothing in batch 3 and can start at once. Batch-2 plan 21 (session lifecycle markers) edits the same contract files and the same `middlewareFor` table: whichever lands second rebases, and `Api.RequestContext` stays the outermost declaration (§8). Phase 4's password ticket (13) lands before plan 27 starts; the whole plan lands before plan 29 (§8) |
| Touches | `@awthaq/api` (the request-context value and its middleware declaration), `@awthaq/core` (`Sessions`, `SignIn`, `SignUp`, `RateLimitKey`/`RateLimitModel`/`RateLimits`, `AuthEvents`, `HookPoint`; `VerificationLink` where present), `@awthaq/server` (`RequestContext`, `AuthHttp`, `Authentication`/`Credentials`), `@awthaq/test` (`TestAuth`), the ten plugin classes that thread request facts today (`password`, `passkey`, `oauth`, `saml` with `Sso`, `magic-link` with `EmailOtp`, `device-authorization`, `two-factor`, `api-key`), every other contract that declares a group (`admin`, `jwt`, `organization`, `roles`, `scim`, `webhooks`, `qadi`, `examples/plugin-template`): one middleware line each, `@awthaq/cli` (`doctor`), `examples/*`, `features/`, `docs/`, `spec/` |
| Wire change | **None.** No header, path, status or body changes, and the OpenAPI document is byte-identical (gated by ticket 01's snapshot). Observable differences: the audit/event envelope now carries the correlation id, address and user agent in every composition (it used to depend on an opt-in middleware), the user agent there is capped at 512 characters like the session row, and admin impersonation sessions record the administrator's address and user agent (Q5) |
| Fixes | The opt-in request context and its inaccurate build-time warning · admin impersonation sessions record no address or user agent in any composition · audit rows and webhook `client.userAgent` carry an uncapped user agent · a dead `ip` on `Saml.logout` · the latent `ip:unknown` lockout lever (an optional `ip` the compiler cannot make a caller supply) |
| Reserved ADR | **ADR-EA-047**, "Request facts are read from `AuthRequestContext`" (ADR-EA-042 to 046 are taken by batch 2) |
| Tickets | `.scratch/26-request-context/issues/NN-*.md`, one file per ticket in §4 (see `docs/agents/issue-tracker.md`) |
| Verified | Line numbers are **`main` at `935d15ee`** (2026-11-08; the effect-4.1 peer-deps branch merged as PR #47; no `packages/*/src` file differs from `ede063d8` plus the working tree the brief described). The checkout then became `architecture/deepening-plans-2` (`5a0e8df4`, a merge of `main` in progress, unstaged edits on top): every claim was re-measured there and §2.8 gives that tree's numbers wherever they differ. Effect is `^4.1.2` in the catalog and 4.1.2 is installed (`node_modules/.pnpm/effect@4.1.2`); the "rc.116" convention line in `.planning/README.md` is stale. APIs were checked against that copy, and §3.4's type mechanics were compiled against it in a scratch spike |

> **Numbering (orchestrator's course correction).** This is **plan 26** (`26-request-context`; the file is written at
> `12-request-context/` and the orchestrator moves it). Batch 3 is 25 record-store-contract, 26 this plan,
> 27 password-credential, 28 sql-store-adapters, 29 plugin-owned-events, 30 speculative-followups. Batch 2 (plans
> 11–24 of the 2026-10-17 review) is on `architecture/deepening-plans-2`; plans 11 (credential resolution, ADR-EA-042,
> implemented), 15 (host composition), 20 (in-process user agent) and 21 (session lifecycle on the contract) overlap
> this one and are reconciled in §2.8 and §8. Every ticket names symbols, so it executes on either tree.

Vocabulary: **module, interface, implementation, depth, seam, adapter, leverage, locality**. Domain terms follow
`spec/glossary.md`. Conventions are those of `.planning/README.md` § Shared conventions, in full: no `as` (and no
`as const`), no return-type annotation on a new Effect/Layer const, type-system first, replace-don't-layer tests,
spec + traceability + BDD for every behaviour change, a changeset with a `Migration:` note for every package-visible
change, the per-phase gate `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`, `pnpm check` per
plan, and `pnpm test:pg` whenever a SQL-backed path changes (Phases 3 and 5 here: the `Sessions` domain changes, and
`SignUpSql`, the store contract and the Postgres suites issue sessions).

---

## 1. Summary, goals, non-goals

### Summary

Two facts about the request a piece of work answers matter to awthaq: the **client address** (forensics, the
device list, the per-source rate-limit buckets, the `signInFailed` stuffing detector) and the **user agent**
(the device list, forensics). Today they travel two ways, and each consumer picked one:

- **The shared path.** `@awthaq/server`'s global router middleware `RequestContext.layer`
  (`server/src/RequestContext.ts:65-99`) resolves the address through the `ClientAddress` port, reads the
  `User-Agent` header and a correlation id, and provides `@awthaq/core`'s `AuthRequestContext`
  (`core/src/AuthRequestContext.ts:17-34`, a `Context.Reference` whose default is "nothing"). Event envelopes and
  audit rows read it (`core/src/AuthEvents.ts:213-225`), deferred observe hooks capture it
  (`core/src/HookPoint.ts:545-556`), and `SignIn` uses it as a per-field fallback
  (`core/src/internal/signInSteps.ts:148-166`). The middleware is **opt-in**: plan 01 decided so (decision 7), and
  `AuthHttp.coreHandlers` logs a build-time warning when it is missing (`server/src/AuthHttp.ts:88-118`).
- **The per-plugin path.** Ten plugin classes resolve the address again in their own handlers (24 calls of
  `clientAddress.resolve(request)` serving about 30 endpoints), parse the user agent again (8 copies), and pass both
  as `readonly ip?: string` / `readonly userAgent?: string` through 29 public interface members (32 `ip` and 17
  `userAgent` declarations) into `SignIn.complete/issue(…, request?)`, `SignUp.createSignedIn(…, request?)`,
  `Sessions.issue({ request? })` and the rate-limit `ip` key (`core/src/RateLimitKey.ts:72-78`).

The per-plugin path is authoritative for sessions and rate limits, the shared path for events and audit, and the
two can disagree. The `ip` field is optional everywhere, so a caller that forgets it is not a compile error: it
lands in the one shared `ip:unknown` bucket, a lever for locking every client out. And because the shared path is
opt-in, nothing makes a composition install it.

This plan makes `AuthRequestContext` the **one module** request facts are read from, and makes its presence a
**compiler-enforced** property of serving awthaq's routes:

1. The value moves to `@awthaq/api` (beside `CurrentPrincipal`, the other per-request value a middleware provides) and
   becomes a required `Context.Service` whose value is a tagged union: `Request { correlationId, ip, userAgent }` or
   `NoRequest`. There is no default. A non-HTTP caller states `NoRequest`.
2. It is populated by **one** endpoint middleware, `Api.RequestContext`, that every awthaq group declares outermost.
   `AuthHttp.middlewareFor` derives its implementation like the other host middleware. A composition that serves a
   group without it does not compile, in three distinct ways §3.4 demonstrates. The global router middleware, the
   router `WeakSet`, `warnWhenAbsent` and the build-time warning are deleted.
3. `Sessions.issue`, `SignIn`, `SignUp.createSignedIn`, the rate-limit `ip` strategy, `VerificationLink`'s source
   budget and the credential resolvers **require** it (it appears in their `R`). Events, audit rows and deferred
   observe hooks read it **optionally**, as enrichment, so publishing from a job needs nothing.
4. Plugin interfaces and handlers drop `ip`, `userAgent` and the `context` parameter. A plugin operation that records
   or keys on the request says so in its type: `Effect<…, …, Api.AuthRequestContext>`. Plugins stop requiring the
   `ClientAddress` port; the request-context middleware is its one consumer.
5. `auth.user.signInFailed` gets one publisher, `SignIn.failed`, which stamps `clientIp` from the request context.
6. `TestAuth` gains `withRequest`, `withoutRequest`, a fixed `clientAddress` option and `signInAs({ request })`.

### Goals

- **G1. One source.** Every read of the client address or user agent in library source goes through
  `Api.AuthRequestContext`. The only `ClientAddress.resolve` call and the only `User-Agent` read left in
  `packages/*/src` are inside `@awthaq/server`'s request-context capture (§5.4 counts).
- **G2. Compiler-enforced presence.** Serving an awthaq group whose handlers or authentication middleware read the
  request context, without its populator, does not compile (§3.4). No runtime warning remains.
- **G3. Explicit absence.** In-process callers (CLI, jobs, tests) provide `AuthRequestContext.noRequest`. Its effect on
  sessions, rate limits and events is defined once (§3.6) and tested once.
- **G4. Plugin interfaces carry no request facts.** Zero `readonly ip?`/`readonly userAgent?` members on plugin
  interfaces, zero `context?: { userAgent }` parameters, zero `ClientAddress` imports in plugin source.
- **G5. One cap, one publisher.** The user agent is capped at 512 characters once, by construction (a branded
  `UserAgentHeader`), for sessions, events, audit rows and webhooks alike. `auth.user.signInFailed` is published only by core.
- **G6. Tests at the interface.** The request-fact behaviour is tested at `Sessions`, `SignIn`, the rate-limit budget
  and the middleware, plus one HTTP wiring probe per plugin; the per-plugin "records ip and user agent" tests go.
- **G7. No wire change, no client change.** The OpenAPI document and the derived clients are unchanged (gated).
- **G8. The spec is true.** BEH-EA-108's deviation note, BEH-EA-054's CSD-003 paragraph, BEH-EA-322's "explicit
  `request` argument per field", BEH-EA-101's envelope paragraph and the server README describe the shipped design;
  ADR-EA-047 records the decision and supersedes plan 01's decision 7.

### Non-goals

- **Choosing a trusted-proxy topology.** `ClientAddress.layerDirect`/`layerTrustedProxy` and their parsing are
  unchanged. A request with no resolvable address keeps the shared `ip:unknown` bucket (§2.5, Q7).
- **Changing what events carry.** `auth.user.signInFailed.clientIp` stays in the schema (only its publisher changes);
  dropping it in favour of the envelope's `ip` is plan 29's territory (Q6).
- **Storage.** The session store ports, the SQL columns and their sealing (CSG-006; batch-2 plan 17, plan 30) are untouched.
- **New request facts.** Accept-Language, geo, device fingerprints: not added. The value is fixed-shape on purpose
  (`AuthRequestContext.ts:11-12`'s rule, kept).
- **Host routes outside awthaq's contracts.** A host route that calls a plugin operation uses `RequestContext.capture`
  or declares `Api.RequestContext` on its own group; awthaq does not intercept routes it does not own (Q9).
- **Rate-limit tuning, bucket names or rules.** Every rule, bucket and number stays; only where the `ip` part comes from
  changes.

---

## 2. Verified current state

Paths are relative to `packages/` unless they start with a top-level directory. Line numbers are `main` at
`935d15ee`; §2.8 gives the other tree's numbers where they differ. Re-locate by symbol before editing.

### 2.1 Re-measurement commands

Run from the repository root. The two numbers are `main@935d15ee` · `architecture/deepening-plans-2` (dp2, §2.8).

```bash
P='packages/{api-key,device-authorization,magic-link,oauth,passkey,password,saml,two-factor}/src'
# plugin source files that import the ClientAddress port                          (10 · 10; target 0)
grep -rln "ClientAddress" packages/*/src --include=*.ts | grep -vE "^packages/(ports|server|test|core)/" | wc -l
# address resolutions in plugin handlers                                          (24 · 31; target 0)
grep -rnE "\.resolve\(request\)|ClientAddress\.(facts|address)\(" packages/*/src --include=*.ts \
  | grep -vE "^packages/(ports|server)/|TenantMiddleware" | wc -l
# User-Agent header reads, excluding outbound webhooks and the web in-process client (9 · 2; target 1, in server)
grep -rn '"user-agent"' packages/*/src --include=*.ts | grep -vE "^packages/(webhooks|web)/" | wc -l
# request facts declared on plugin interfaces                                     (32 · 33; target 0)
eval grep -rnE "\"readonly ip\??: (string|undefined)\"" $P --include=*.ts | wc -l
#                                                                                  (17 · 17; target 0)
eval grep -rnE "\"readonly userAgent\??: \"" $P --include=*.ts | wc -l
# signInFailed.clientIp stamped outside core                                      (6 · 6; target 0)
grep -rn "clientIp:" packages/*/src --include=*.ts | grep -v "^packages/core/" | wc -l
# ip-keyed rate-limit rules (they stay; their enforcement stops taking an address) (27 · 28)
grep -rn "Key\.ip\b" packages/*/src --include=*.ts | wc -l
# the opt-in machinery                                                            (9 · 9; target 0)
grep -rn "warnWhenAbsent\|isInstalledOn\|requestContextCheck" packages/*/src --include=*.ts | wc -l
# explicit request arguments in core interfaces                                   (3 · 3; target 0)
grep -rnE "readonly request\?:|request\?: (Steps|SignIn)\.SessionRequest" packages/core/src --include=*.ts | wc -l
# Phase 5 sweep: test/feature files that issue sessions in-process                (79 · 84)
grep -rln "sessions\.issue(\|\.issue({" packages/*/test features/step-definitions --include=*.ts | wc -l
# ip/userAgent literals in tests and step definitions (churn indicator)           (199 · 211)
grep -rhoE "\b(ip|userAgent):" packages/*/test features/step-definitions examples/*/test --include=*.ts | wc -l
```

### 2.2 The shared path

| Piece | Evidence | What it does |
|---|---|---|
| The value | `core/src/AuthRequestContext.ts:17-34` | `{ correlationId, ip, userAgent }`, all `Option`; a `Context.Reference` with an all-`None` default, so reading it never appears in `R` |
| The populator | `server/src/RequestContext.ts:65-92` | A global `HttpRouter.middleware`: correlation id from `x-request-id`/`traceparent`/uuidv7 (`:73-76`), address through `ClientAddress` if provided, else the socket peer (`:77-80`), the **raw** `User-Agent` (`:85`), log annotation (`:87`) |
| Opt-in marker | `server/src/RequestContext.ts:42-63`, `:94-99` | A `WeakSet` of routers the layer was built on, `isInstalledOn`, the `warnWhenAbsent` reference |
| The warning | `server/src/AuthHttp.ts:88-106`, wired at `:114-118` | `coreHandlers` yields ten times, then warns "sessions minted over HTTP record no address or user agent" when the router has no `RequestContext.layer` |
| Silencing | `test/src/TestAuth.ts:372-378` | `TestAuth` provides `warnWhenAbsent = false`: the harness serves without the middleware |
| Hosts | `examples/memory-server/app.ts:252-262`, `examples/sql-server/app.ts:196-200` | Only the listening `serverLayer` merges it; both examples' in-process `buildApp` (what their tests use) does not |
| Readers | `core/src/AuthEvents.ts:213-225` | Every envelope and audit row: `correlationId`, `ip`, `userAgent` |
| | `core/src/HookPoint.ts:545-556` | Captures the whole value and re-provides it to observe taps deferred to commit (ADR-EA-037). No hook input carries an address |
| | `core/src/internal/signInSteps.ts:91-97` | The suspended gate's `signInFailed{suspended}` takes `clientIp` from here only |
| | `core/src/internal/signInSteps.ts:148-166` | `mint`: explicit `request.ip`/`request.userAgent` per field, else the context |

### 2.3 The per-plugin path

Each row is one plugin class: where its handlers resolve the address and read the user agent, which public members
take the facts, where they flow, which ip-keyed rules they feed and where `signInFailed.clientIp` is set.

| Plugin | Handler resolution (`main`) | Public members taking `ip` / `userAgent` | Flows into | ip-keyed rules | `clientIp` |
|---|---|---|---|---|---|
| `Password` (`password/src/Password.ts`) | 7 calls: `:671` (signUp), `:709` (signIn), `:727`, `:741`, `:763`, `:777`, `:822` (changePassword); UA helper `requestUserAgent` `:633-638`; `sessionRequest` `:627-631` | `signUp` (`:351`, `:353`), `signUpConcealed` (`:374`), `signIn` (`:401`, `:403`), `requestReset` (`:418`), `resendVerification` (`:428`), `verifyEmail` (`:455`), `confirmEmailChange` (`:485`), `changePassword` (`:515-516`) | `createSignedIn(…, sessionRequest(input))` `:1151`; `complete(…, sessionRequest(input))` `:1280`; `sessions.issue({ request })` `:1721-1726` | 6: `signUpByIp`, `signInByIp`, `requestResetByIp`, `resendVerificationByIp`, `verifyEmailByIp`, `confirmEmailChangeByIp` (`:170-305`); spent at `:1114`, `:1213`, `:1294`, `:1354`, `:1503`, `:1606` | `:1011` |
| `Passkey` (`passkey/src/Passkey.ts`) | `:683`, `:702`; UA `:703` | `authenticateOptions` (`:562`), `authenticateVerify` (`:571` input, `:573` `context`) | `complete(…, { ip, userAgent })` `:1559-1562` | 2: `authenticateOptionsByIp` `:1391`, `authenticateVerifyByIp` `:1464` | `:1586` |
| `OAuth` (`oauth/src/OAuth.ts`) | `:503` (authorize), `:546` (callback; UA `:557`), `:605` (exchange) | `authorize` (`:631`), `callback` (`:664`, `:666`), `exchange` (`:697`) | `complete(…, { ip, userAgent })` `:1258-1261` | 3: `authorize` `:864`, `callback` `:935`, `token` `:1335` | `:1323` |
| `Saml` (`saml/src/Saml.ts`, `SamlSlo.ts`) | `:450` (login), `:473` (acs; UA `:478`), `:502` (slo), `:528` (sloPost), `:588` (logout) | `authnRequest` (`:136`), `acs` (`:145-146`), `slo` (`SamlSlo.SloInput.ip`, `SamlSlo.ts:72`), `logout` (`:170`; **never read**, §2.7) | internal `signIn(connection, assertion, input)` `:1139`, `complete(…, input)` `:1201-1219` | 3: `login` `:903`, `acs` `:1229`, `slo` via `rateLimit: (ip) => …` `:1277` → `SamlSlo.ts:378` | `:1240` |
| `Sso` (`saml/src/Sso.ts`) | `:171` | `start(input, ip)` positional (`:120-123`) | — | 1: `start` `:255` | — |
| `MagicLink` (`magic-link/src/MagicLink.ts`) | helper `currentClient` `:164-175` (resolve `:169`, UA `:170`), used at `:191`, `:205` | `requestLink` (`:147`), `verify` (`:151`, `context` `:152`) | `Channel.complete` → `signIn.complete(…, { ip, userAgent })` (`Channel.ts:69-70`, `:151-153`) | 2: `requestByIp` `:250`, `verifyByIp` `:290` | `:298` |
| `EmailOtp` (`magic-link/src/EmailOtp.ts`) | helper `currentClient` `:167-178` (resolve `:172`, UA `:173`), 2 uses | `requestCode` (`:146`), `verify` (`:153`, `context` `:155`) | `Channel.complete` | 2: `requestByIp` `:255`, `verifyByIp` `:287` | `:294` |
| `DeviceAuthorization` (`device-authorization/src/DeviceAuthorization.ts`) | helper `currentClient` `:467-478` (resolve `:472`, UA `:473`), 5 uses (`:533`, `:561`, `:610`, `:641`, `:665`) | shared `Source { ip? }` (`:380-382`) on `requestCode`, `poll` (+ `context` `:419`), `verify`, `approve`, `deny` | `signIn.issue(cleared, { ip, userAgent })` `:1142-1145` | 5: `codeByIp` `:864`; `verifyByIp`/`approveByIp`/`denyByIp` through `lookupUserCode` `:928-934`; `invalidGrantByIp` `:1078-1080` | — |
| `TwoFactor` (`two-factor/src/TwoFactor.ts`) | local `complete` helper `:313-333` (resolve `:325`, UA `:326`), used by `verify` and `verifyRecovery` | `verify` (`:127`, `context` `:129`), `verifyRecovery` (`:136`, `context` `:138`) | `finalizeSignIn(challenge, request)` `:547-565` → `completion.issue(cleared, request)` | 1: `verifyByIp` `:582` | — |
| `ApiKey` (`api-key/src/ApiKey.ts`) | `:558` (token endpoint), `:614` (resolver `throttle`) | none (handler- and resolver-local) | — | 2: `tokenByIp` `:559`, `resolveByIp` `:615` | — |

Totals on `main`: 24 literal resolve calls in 10 files of 8 packages; 8 plugin user-agent copies (+1 in the
middleware); 32 `ip` and 17 `userAgent` declarations; 29 public members; 27 ip-keyed rules enforced at 27 call
sites; 6 plugin `clientIp` stamps. Every plugin's `AuthPlugin.layer` lists `ClientAddress.ClientAddress` in `ports`
(`Password.ts:930`, `Passkey.ts:1075`, `OAuth.ts:749`, `Saml.ts:825`, `Sso.ts:155`, `MagicLink.ts:225`,
`EmailOtp.ts:231`, `DeviceAuthorization.ts:762`, `TwoFactor.ts:498`, `ApiKey.ts:796`).

Core's own explicit-facts interfaces:

| Interface | Evidence | Reads the context? |
|---|---|---|
| `Sessions.issue({ userId, request?, … })` | `core/src/Sessions.ts:335-337`; recorded at `:714-715`; user agent capped at `:50-57` | **No.** Only the explicit `request` |
| `SignIn.issue(clearance, request?)`, `SignIn.complete(attempt, request?)`, `SessionRequest` | `core/src/SignIn.ts:35`, `:61-70`, `:74-80`; `internal/signInSteps.ts:53-57` | Yes, per-field fallback (`signInSteps.ts:150-152`) |
| `SignUp.createSignedIn(application, options, request?)` | `core/src/SignUp.ts:103-110`, `:261-269` | Yes, through `steps.mint` |
| `RateLimits.Key.ip` (`{ ip?: string }` → `ip:<addr>` or `ip:unknown`) | `core/src/RateLimitKey.ts:72-78`; budget `core/src/RateLimits.ts:332-450` | **No** |
| Legacy session bridge | `core/src/Sessions.ts:755-770` | Passes the legacy row's own address and user agent (correct: those facts belong to the migrated session) |
| Admin impersonation | `admin/src/Admin.ts:1116-1120` | Calls `sessions.issue` with **no** `request` |
| `TestAuth.signInAs` | `test/src/TestAuth.ts:497-523` | No `request` |

### 2.4 Which path is authoritative today

The review asked which path wins. It depends on the consumer, and the build-time warning describes the wrong one.

| Consumer | Source today | With the middleware | Without the middleware |
|---|---|---|---|
| Session row of the 8 sign-in flows + password sign-up | explicit `request` per field, else context (`signInSteps.ts:150-152`) | explicit wins (same value, resolved twice) | **still recorded** (explicit) |
| Session row of `changePassword` | explicit only (`Password.ts:1724`) | recorded | recorded |
| Session row of admin impersonation | nothing (`Admin.ts:1116-1120`) | **not recorded** | not recorded |
| Session row of the legacy bridge | the legacy row | legacy facts | legacy facts |
| Rate-limit `ip` buckets (27 rules) | explicit only | handler's resolution | handler's resolution |
| `signInFailed.clientIp` from 6 plugins | explicit only | recorded | recorded |
| `signInFailed{suspended}.clientIp` (core gate) | context only (`signInSteps.ts:91-97`) | recorded | **absent** |
| Event envelope + audit row (`correlationId`, `ip`, `userAgent`) | context only | recorded | **absent** |
| Deferred observe taps (`HookPoint.ts:545-556`) | context only | see it | see nothing |

So the warning added in `a232d8e6` ("SessionDelivery.respond and the RequestContext build-time warning") —
"sessions minted over HTTP record no address or user agent" (`AuthHttp.ts:103`, `RequestContext.ts:94-97`,
`server/README.md:15`, `docs/plugin-authoring.md:195`) — is **false for sessions** (every plugin passes the facts
explicitly and they win) except impersonation, which records nothing either way. It is **true for events, audit rows,
the suspended event and deferred taps**. The explicit path is authoritative wherever it exists; the context is
authoritative only where nothing explicit exists.

### 2.5 The bug class: a forgotten `ip` is one shared bucket

`RateLimitKey.ip` (`core/src/RateLimitKey.ts:72-78`) reads `{ ip?: string }` and keys `ip:${input.ip ?? "unknown"}`.
`ip` is optional at every level (plugin interface, handler, `spend` input), so the compiler cannot make anyone pass it.

**Forgotten-`ip` call sites in shipped code: none found.** Every one of the 27 ip-keyed rules was traced from its
enforcement site back to its handler, and every handler passes the address it resolved (table in §2.3). The claim
"callers that forget `ip` today" is refuted for shipped code. The bug class is latent: a host route, a CLI command, a
job or a future handler calling any of the 29 ip-carrying plugin members without `ip` compiles and shares one bucket.

**A live manifestation with a different cause: an unresolvable address.** For a web-handler request
(`HttpRouter.toWebHandler`, the path `@awthaq/next`, Workers and Bun hosts use) `HttpServerRequest.remoteAddress` is
always `None` unless the adapter sets it (`effect@4.1.2/src/http/HttpServerRequest.ts:577-578`). Under
`ClientAddress.layerDirect` (the default the port's own header calls "zero-config", `ports/src/ClientAddress.ts:16-19`)
every client of such a deployment resolves to `None` and shares `ip:unknown` on all 27 rules. This plan does not
change it (it is topology, not threading), but makes it one place to reason about (§3.6) and asks Q7.

**The other latent leak:** in-process callers. 42 plugin test files call plugin operations in-process and land in
`ip:unknown` today; none of them notices because the default test limiter is permissive. That is fine for tests and
would be a lockout lever for a host job that calls, say, `Password.requestReset` in a loop. `NoRequest` makes the
choice explicit (Q3).

### 2.6 Prior decisions this plan meets

| Decision | Where | Relation |
|---|---|---|
| Plan 01 Q1 = **no**: `RequestContext.layer` stays opt-in; a build-time warning instead (decision 7) | `.planning/01-sign-in-sign-up/PLAN.md:1150-1153`; commit `a232d8e6`; BEH doc `spec/behaviors/09-authentication-middleware.md:13` (rev 1.4) | **Superseded** (Q1). Plan 01's phase 6 step 2 ("drop `userAgent` from the plugin Shapes and the explicit `request` argument") is what Phase 4 and 5 execute. What changed since: the populator can be made required at zero host cost (it rides `AuthHttp.middlewareFor`, which every example and `TestAuth` already call), and the warning turned out to describe the wrong consumer (§2.4) |
| Plan 06: the built-in strategies do **not** read the ambient request "because a non-HTTP caller has no request" | `spec/behaviors/14-rate-limiting.md:121` (BEH-EA-108 deviation); `docs/plugin-authoring.md:90` | **Revised.** Plan 06 itself named the alternative, an `ip` key that reads the request, "safe only once `AuthHttp` installs RequestContext unconditionally" (`.planning/06-rate-limit-budget/PLAN.md:1962-1969`). This plan makes it unconditional (by type), and replaces "has no request" with an explicit `NoRequest` |
| ADR-EA-012: slots are `Context.Reference`s with fail-closed defaults; registries aggregate | `spec/decisions/012-slots-exclusive-registries-aggregate.md` | **No conflict.** `AuthRequestContext` is a `Context.Reference` today but not a slot: no plugin overrides it. It becomes a required `Context.Service` provided per request by the edge, like `CurrentPrincipal`. Neither a slot nor a registry |
| ADR-EA-010: plugins require ports, never provide | `spec/decisions/010-plugins-require-ports-never-provide.md` | Kept. Plugins stop requiring `ClientAddress`; the server's request-context middleware is its one consumer |
| ADR-EA-037: observe taps run on commit and see the captured request context | `spec/decisions/037-unit-of-work-releases-events-on-commit.md:34` | Kept. The capture switches to an optional read (§3.5.6) |
| ADR-EA-038: a session for a proven credential is minted only from a `Clearance` | `spec/decisions/038-sign-in-and-sign-up-are-core-modules.md` | Kept; `SignIn.issue` loses its `request` argument and gains the context in `R` |
| CSD-003: the persisted user agent is capped at 512 at the persistence edge | `core/src/Sessions.ts:50-57`; `spec/behaviors/07-sessions.md:127` | The cap moves to the one constructor of a branded `UserAgentHeader` (G5), so audit rows get it too |

### 2.7 Evidence corrections

| Review claim | Verified | Correction |
|---|---|---|
| Middleware at `RequestContext.ts:68-90`, `AuthHttp.ts:89-108` | `RequestContext.ts:65-92` (resolution `:77-80`), `AuthHttp.ts:88-106` + `:114-118` | Ranges shifted by a few lines; content as described |
| "Events (`AuthEvents.ts` ~:213) and hooks (`HookPoint.ts` ~:549) read from there" | Events: `:213`, yes. Hooks: `:549` | Hooks do not *read* request facts: no hook input carries one. `HookPoint.observe.run` captures the value and re-provides it to taps deferred to commit (ADR-EA-037) |
| Missing from the review | `signInSteps.ts:148-166`, `:91-97` | `SignIn` already reads the context: as a per-field fallback behind the explicit `request` (`mint`), and as the only source for the suspended gate's `clientIp`. Three arrangements exist, not two |
| `Sessions.issue({ request? })` (`Sessions.ts` ~:337) | `:335-337` | `Sessions.issue` never reads the context. Consequence the review missed: admin impersonation (`Admin.ts:1116-1120`) records no address or user agent in any composition |
| `clientAddress.resolve(request)` in "about 24–27 places across about 10 plugins (10 in Password alone)" | 24 calls, 10 files, 8 packages, 10 plugin classes | **Password has 7, not 10.** The 24 calls serve about 30 endpoints (helpers in `MagicLink`, `EmailOtp`, `DeviceAuthorization`, `TwoFactor`) |
| "About 9 copies of user-agent parsing (`Password.ts` ~:634, `Passkey.ts` ~:703, `OAuth.ts` ~:557, `Saml.ts` ~:478, `TwoFactor.ts` ~:326)" | 8 plugin copies + 1 middleware | Correct count. The other three are `MagicLink.ts:170`, `EmailOtp.ts:173`, `DeviceAuthorization.ts:473` |
| "About 33 plugin interfaces declare `readonly ip?: string`" | 32 declarations (33 on dp2) | They sit on **29 public members** of 10 plugin classes (Device's 5 share one `Source`); plus `Sso.start`'s positional `ip`. `ApiKey.ts:114` and `DeviceAuthorization.ts:105-107`/`:338` declare `ip: RateLimit` config fields, not request facts: excluded |
| "Find actual call sites that forget `ip`: those are live bugs" | none | **Refuted for shipped code** (§2.5). The live manifestation is the web-handler `None` address, a topology issue |
| The warning "says sessions record no address without it, even though handlers pass the address explicitly" | true | Confirmed and sharpened in §2.4: wrong for sessions, right for events/audit/suspended/taps |
| Plan 01 Q1's outcome | `01-sign-in-sign-up/PLAN.md:1150` | Q1 = **no** (opt-in, warn at build) |
| Not in the review | `RequestContext.ts:85` | The context's user agent is the raw header: event envelopes, audit `meta.userAgent` (`core/src/AuditLog.ts:193-197`) and webhook `client.userAgent` (`webhooks/src/WebhookPayload.ts:85-95`) are uncapped, while the session row is capped at 512 |
| Not in the review | `Saml.ts:170`, `SamlSlo.ts:175-177`, `Saml.ts:588` | `Saml.logout` takes an `ip` it never reads; the `saml.account` handler resolves an address for nothing |
| `.planning/README.md` conventions: "effect@4.0.0-rc.116" | catalog `^4.1.2`, installed 4.1.2 | Stale line in the README (not this plan's to edit) |

### 2.8 The checkout that replaced `main` during the run (`architecture/deepening-plans-2`)

The branch carries batch-2 plans 11, 13 (part), 14, 16, 17, 18, 19 and 22 of the 2026-10-17 review. For this plan's
subject it differs from `main` as follows; every other file cited above is identical (`AuthRequestContext.ts`,
`RequestContext.ts`, `RateLimitKey.ts`, `RateLimitModel.ts`, `RateLimits.ts`, `AuthEvents.ts`, `HookPoint.ts`,
`SignIn.ts`).

| Topic | dp2 | Effect on this plan |
|---|---|---|
| User-agent parsing | Consolidated into two port helpers, `ClientAddress.facts(port, request)` and `ClientAddress.address(port, request)` (`ports/src/ClientAddress.ts:60-81`), whose doc says "plan 01 Q1: they stay explicit" (commit `2c3c400d`, batch-2 plan 11 phase 1) | Half of the per-plugin copies are already one helper. Phase 4 deletes the helper calls; ticket 13–20 each delete their calls; ticket 24's seam test forbids both helpers; ticket 07 deletes the helpers from `ports` |
| Resolution sites | 24 helper calls + 7 raw `.resolve(request)` (`ApiKey.ts:551`, `:607`; `Passkey.ts:346`; `Sso.ts:171`; `Saml.ts:508`, `:534`, `:588`) | Same tickets; counts in §2.1 |
| `readonly ip?` | 33 (Password 12: `confirmReset` gained an `ip`) | Password ticket covers it |
| ip-keyed rules | 28: `confirmResetByIp` (`Password.ts:223`) | Spent through `VerificationLink.redeemer`'s `source` |
| `VerificationLink.redeemer` (batch-2 plan 18) | `LinkBudget.source: ((ip: string \| undefined) => Effect<void, E, R>) \| "caller"` and `presented.ip` (`core/src/VerificationLink.ts:248-284`); callers `Password.ts:1352-1369`, `MagicLink.ts:235-238`, `SecondFactor.ts:453-455` | One more core interface threads `ip`. Ticket 10 adds the context read; ticket 23 changes `source` to `Effect<void, E, R> \| "caller"` and drops `presented.ip` |
| Credential resolvers (batch-2 plan 11, implemented) | `CredentialResolverContribution` moved to `server/src/Credentials.ts:134-146` (same `R = HttpServerRequest`). One `Credentials` module now runs every chain: Path A (`Authentication.ts:96-112`, `:198-223`) and Path B (`qadi/src/SubjectExtractor.ts:36-62`) through `Credentials.httpScope(request)`, whose `claim` provides `HttpServerRequest` to the registry; the web adapter's `Credentials.collecting` scope claims nothing | Ticket 08 edits `Credentials.ts`: `httpScope` also provides the request context to a claim. Path A takes it from its own `R`; Path B's extractor implements `@qadi/http`'s `SubjectExtractor`, an interface that cannot carry a requirement, so it is the one place that reads the context optionally and captures it with `RequestContext.capture` when its group lacks the middleware (§3.5.5) |
| Batch-2 plan 15 (host composition, `AuthHost`) | not implemented (no `AuthHost` in `packages/*/src`) | When it lands it derives the servable layer, middleware included, from `Auth.make`; ticket 06's derivation moves with `middlewareFor` into it unchanged |
| Batch-2 plan 20 (in-process user agent) | not implemented; plans a browser-like `UserAgent` module in `@awthaq/web` and agents from `TestAuth.app` | Name clash avoided: this plan's capped header brand is `Api.UserAgentHeader`, not `UserAgent`. An agent's requests go through the request-context middleware like any other; ticket 12's `clientAddress` option and the agent's `user-agent` header are the two inputs a wire test sets (§8) |
| Batch-2 plan 21 (session lifecycle markers) | not implemented; plans five `HttpApiMiddleware` markers in `@awthaq/api` (`SessionLifecycle.Mints`/`Rotates`/`Ends`/`Swaps`/`Refreshes`) that provide grants and are derived by `middlewareFor` | The same mechanism as `Api.RequestContext` (a typed, reflectable endpoint middleware with `provides`). Both edit every session-changing contract group and the `middlewareFor` table; `Api.RequestContext` is declared after the markers so it stays outermost (§8) |
| `Sessions.issue` | same shape: `request?` at `core/src/Sessions.ts:321`, cap `:58-61`, bridge about `:758`; `IssuedSession` now lives in `Sessions` | Ticket 09 unchanged |
| Admin impersonation | `admin/src/Admin.ts:872`, still no `request` | Ticket 09 unchanged |
| `TestAuth` | `warnWhenAbsent` at `:385`, `signInAs` `:505-522` | Tickets 07, 12 unchanged |
| OAuth/SAML sign-in | identity resolution through core `FederatedIdentity` (batch-2 plan 14); no request facts in it | None |
| Planning | batch-2 plans 11–24 indexed; ADR-EA-042/043 written, 044–046 reserved | This plan is 26 and its ADR is 047 (header note) |
| Merge state | `MERGE_HEAD` present, unstaged edits in `Password.ts`, `Sessions.ts`, `Authentication.ts`, `Credentials.ts` and others at the time of reading | Re-run §2.1 when work starts |

---

## 3. Target design

### 3.1 Placement and the rule

| What | Where | Why there |
|---|---|---|
| The value `AuthRequestContext`, its two shapes, `noRequest`, `request(…)`, the capped `UserAgentHeader` brand | `@awthaq/api` (`packages/api/src/Api.ts`, beside `CurrentPrincipal`) | It is provided by an endpoint middleware the contract declares, so the contract stratum must name it (the `CurrentPrincipal` precedent). `@awthaq/core` and `@awthaq/server` both depend on `@awthaq/api`; nothing here is server code, so the browser import rule holds |
| The middleware declaration `Api.RequestContext` (`provides: AuthRequestContext`) | `@awthaq/api` (`Api.ts`) | Groups declare it; `HttpApi.reflect` and `middlewareFor` read it |
| `requires: AuthRequestContext` on `Authentication`, `MachineAuthentication`, `AdminAuthentication`, `OptionalAuthentication` | `@awthaq/api` (`Api.ts:235-302`) | Their implementations run credential claims that read the context (the api-key throttle); declaring it makes the order compile-checked (§3.4 form 3), the `AuthorizedSubject` precedent (`qadi/src/AuthorizedSubject.ts:54-57`, `requires: Api.CurrentPrincipal`) |
| The one capture, `RequestContext.capture(request)`, and the middleware implementation `RequestContext.RequestContextLive` | `@awthaq/server` (`packages/server/src/RequestContext.ts`, rewritten) | The only code that reads `ClientAddress`, `x-request-id`/`traceparent` and `User-Agent` |
| Derivation | `AuthHttp.middlewareFor` (`server/src/AuthHttp.ts:154-209`) | Every example and `TestAuth` already build host middleware through it (`examples/memory-server/app.ts:184`, `examples/sql-server/app.ts:131`, `test/src/TestAuth.ts:356-361`), so the populator costs a host nothing |
| Readers that **require** it (it is in `R`) | `Sessions.issue`, `SignIn.clear/resume/issue/complete/failed`, `SignUp.createSignedIn`, the `ip` rate-limit strategy (through `Budget.spend/guard/charge`), `VerificationLink`'s source budget (dp2), credential claims | A missing value would record or key on the wrong thing; the compiler must refuse it |
| Readers that read it **optionally** | `AuthEvents.publish`, `HookPoint.observe` (deferred taps), qadi's Path B extractor (§3.5.5) | Enrichment only (events, taps), or an external interface that cannot carry a requirement (Path B) |

**The rule (ADR-EA-047):** request facts are read from `Api.AuthRequestContext` and nowhere else. No public interface
takes an address or a user agent. The only `ClientAddress.resolve` and the only `User-Agent` read in library source
are in `RequestContext.capture`.

### 3.2 The value (`packages/api/src/Api.ts`)

```ts
import * as Brand from "effect/Brand";

/** CSD-003: `User-Agent` is a header the client controls; it is capped once, where it is captured. */
export const MAX_USER_AGENT_LENGTH = 512;

/** A `User-Agent` value that is at most `MAX_USER_AGENT_LENGTH` characters. Only `toUserAgentHeader` makes one. */
export type UserAgentHeader = string & Brand.Brand<"awthaq/UserAgentHeader">;
const brandUserAgentHeader = Brand.nominal<UserAgentHeader>();
export const toUserAgentHeader = (raw: string) =>
  brandUserAgentHeader(raw.slice(0, MAX_USER_AGENT_LENGTH));

/** The HTTP request a piece of work answers, captured once by `RequestContext` (ALF-006, CSD-003). */
export interface RequestFacts {
  readonly _tag: "Request";
  /** A sane `x-request-id`, else the `traceparent` trace id, else a fresh uuidv7. */
  readonly correlationId: string;
  /** What the `ClientAddress` port resolved; `None` when the platform reports no peer (a web handler under `layerDirect`). */
  readonly ip: Option.Option<string>;
  readonly userAgent: Option.Option<UserAgentHeader>;
}

/** Work that answers no HTTP request: a CLI command, a job, a test. Stated by the caller, never defaulted. */
export interface NoRequest {
  readonly _tag: "NoRequest";
}

/**
 * ADR-EA-047: the one source of request facts. A required service with no default: a session-minting,
 * address-keyed or sign-in operation names it in `R`, so serving one without `RequestContext`, or calling one
 * in-process without stating `noRequest`, does not compile.
 */
export class AuthRequestContext extends Context.Service<AuthRequestContext, RequestFacts | NoRequest>()(
  "awthaq/api/AuthRequestContext",
) {
  static readonly noRequest: NoRequest = { _tag: "NoRequest" };
  static readonly request = (input: {
    readonly correlationId: string;
    readonly ip?: string | undefined;
    readonly userAgent?: string | undefined;
  }): RequestFacts => ({
    _tag: "Request",
    correlationId: input.correlationId,
    ip: Option.fromUndefinedOr(input.ip),
    userAgent: Option.map(Option.fromUndefinedOr(input.userAgent), toUserAgentHeader),
  });
}

/** ADR-EA-047: declared last (outermost) on every awthaq group; captures the request and provides its facts. */
export class RequestContext extends HttpApiMiddleware.Service<
  RequestContext,
  { provides: AuthRequestContext }
>()("RequestContext") {}

export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: CurrentPrincipal; requires: AuthRequestContext }
>()("Authentication", {
  security: { impersonation: ImpersonationCookie, cookie: SessionCookie, bearer: BearerToken },
  error: [Unauthenticated, StoreUnavailable],
}) {}
// MachineAuthentication, AdminAuthentication, OptionalAuthentication: the same `requires` line.
```

`RequestContext` declares no `security` and no `error`, so it adds nothing to the OpenAPI document, and
`requiredForClient` defaults to `false`, so `HttpApiClient` asks for no client half
(`effect@4.1.2/src/http-api/HttpApiMiddleware.ts:258-262`, `MiddlewareClient` exists only for
`requiredForClient: true`). `core/src/AuthRequestContext.ts` and its `index.ts:40` export are deleted; core imports
`Api` from `@awthaq/api` as it already does elsewhere (`core/src/RateLimitModel.ts:11`).

### 3.3 The one populator (`packages/server/src/RequestContext.ts`, `AuthHttp.middlewareFor`)

```ts
// correlationIdFrom stays as it is (pure, tested).

const captureWith = (
  address: ClientAddress.ClientAddressShape,
  random: SecureRandom.SecureRandom["Service"],
  request: HttpServerRequest.HttpServerRequest,
) =>
  Effect.gen(function* () {
    const header = (name: string) => Option.getOrUndefined(Headers.get(request.headers, name));
    const correlationId = yield* Option.match(correlationIdFrom(header), {
      onSome: Effect.succeed,
      onNone: () => Effect.orDie(random.uuidV7()),
    });
    const ip = yield* address.resolve(request);
    return Api.AuthRequestContext.request({
      correlationId,
      ip: Option.getOrUndefined(ip),
      userAgent: header("user-agent"),
    });
  });

/** The facts of one request, for a host route outside awthaq's contracts that calls a plugin operation. */
export const capture = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
  const address = yield* ClientAddress.ClientAddress;
  const random = yield* SecureRandom.SecureRandom;
  return yield* captureWith(address, random, request);
});

/** ADR-EA-047: the implementation of `Api.RequestContext`. `AuthHttp.middlewareFor` derives it. */
export const RequestContextLive = Layer.effect(
  Api.RequestContext,
  Effect.gen(function* () {
    const address = yield* ClientAddress.ClientAddress;
    const random = yield* SecureRandom.SecureRandom;
    const middleware: HttpApiMiddleware.HttpApiMiddleware<Api.AuthRequestContext, never, never> = (
      httpEffect,
    ) =>
      Effect.gen(function* () {
        const facts = yield* captureWith(address, random, yield* HttpServerRequest.HttpServerRequest);
        return yield* httpEffect.pipe(
          Effect.provideService(Api.AuthRequestContext, facts),
          Effect.annotateLogs(Observability.Field.correlationId, facts.correlationId),
        );
      });
    return middleware;
  }),
);
```

The typed local `middleware` follows `RequestDecisionCacheLive` (`qadi/src/RequestDecisionCache.ts:40-44`); it is a
function value, not an Effect/Layer const. `ClientAddress` becomes a **required** dependency of the populator (today
it is optional and falls back to the socket peer, `RequestContext.ts:68`, `:77-80`): plugins stop requiring the port
in Phase 4, so the populator is where the deployment's topology choice must be made (Q2).

`AuthHttp.middlewareFor` gains one table entry and one requirement:

```ts
export type HostMiddleware =
  | Api.RequestContext
  | Api.Authentication
  | Api.OptionalAuthentication
  | Api.MachineAuthentication
  | Api.AdminAuthentication
  | Api.CsrfProtection;

// signature: RIn gains ClientAddress.ClientAddress
): Layer.Layer<DeclaredMiddleware<Groups>, CE, Sessions.Sessions | SecureRandom.SecureRandom | ClientAddress.ClientAddress | CR | PR>;

entry(Api.RequestContext.key, Layer.fresh(RequestContext.RequestContextLive)),
```

Deleted: `RequestContext.layer`, `registration`, `installedRouters`, `isInstalledOn`, `warnWhenAbsent`
(`RequestContext.ts:42-63`, `:94-99`), `AuthHttp.requestContextCheck` and its place in `coreHandlers`
(`AuthHttp.ts:88-118`), `TestAuth`'s `warnWhenAbsent` provision (`TestAuth.ts:372-378`),
`server/test/RequestContextWarning.test.ts`, and the `RequestContext.layer` merge in both examples' `serverLayer`. On
dp2 also `ClientAddress.facts`/`ClientAddress.address` (`ports/src/ClientAddress.ts:60-81`).

### 3.4 Why a missing populator is a compile error

`HttpApiBuilder.group` turns a handler's requirement `R` into the group layer's input in two ways
(`effect@4.1.2/src/http-api/HttpApiBuilder.ts:231-242`): a service some declared endpoint middleware **provides** is
excluded (`HttpApiEndpoint.ExcludeProvided`, `HttpApiEndpoint.ts:910-914`), and anything left becomes the marker
`HttpRouter.Request<"Requires", R>`, which no ordinary layer can satisfy. A declared middleware's own requirements
travel as `MiddlewareServices`, folded in declaration order by `ApplyServices = Exclude<R, Provides<I>> | Requires<I>`
(`HttpApiMiddleware.ts:209-215`, `HttpApiEndpoint.ts:342-353`). Middleware wraps in declaration order, so the last
declared is outermost (`HttpApiBuilder.ts:1079-1095`).

A scratch spike against effect 4.1.2 (reproduced as `packages/server/test/RequestContext.types.test.ts` in ticket 02)
compiled these gates, each with a negative control that failed as expected:

| Composition | Group layer's input | Served without `RequestContextLive` |
|---|---|---|
| Public group, handler reads the context, `.middleware(RequestContext)` last | `RequestContext` (the middleware id) only | **Form 1:** `RequestContext` is an unmet requirement of the app layer, exactly like a missing `Api.Authentication` today. Providing `RequestContextLive` closes it |
| Same group, the declaration forgotten | `HttpRouter.Request<"Requires", AuthRequestContext>` | **Form 2:** unsatisfiable marker; the plugin's own `TestAuth` composition fails to type-check |
| Authenticated group, `Authentication` then `RequestContext` (outermost) | `Authentication \| RequestContext` | Form 1 |
| Authenticated group, `RequestContext` declared *inside* `Authentication` | `… \| AuthRequestContext` (a plain requirement left by `requires`) | **Form 3:** the wrong order is a compile error, not a silent gap |

The one way to silence the compiler is to provide a fixed `AuthRequestContext` as a layer at the composition root. That
is a deliberate act (it would stamp one value on every request), it is documented as wrong, and the seam test of
ticket 24 forbids `AuthRequestContext.noRequest` or `Layer.succeed(Api.AuthRequestContext, …)` in `packages/*/src`
outside `@awthaq/test`.

A group whose handlers read nothing and that has no authentication middleware (a webhook admin list, say) would
compile without the declaration and only lose event correlation. Two runtime nets cover it: `runPluginContractTests`
asserts every endpoint of the plugin's contract has `RequestContext` outermost (ticket 06), and `awthaq doctor` reports
any endpoint of the composed api that does not (ticket 24).

### 3.5 Readers

#### 3.5.1 `Sessions.issue` (`core/src/Sessions.ts`)

```ts
readonly issue: (input: {
  readonly userId: UserId;
  readonly supersedes?: SessionId;
  readonly actingAs?: ActingAs;
  readonly amr?: ReadonlyArray<AuthMethod>;
  readonly absoluteDuration?: Duration.Duration;
}) => Effect.Effect<IssuedSession, StoreUnavailable, Api.AuthRequestContext>;

/** What a session row records of the request that minted it (CSD-003). */
const recordedFrom = (context: Api.RequestFacts | Api.NoRequest) =>
  context._tag === "Request"
    ? { ipAddress: context.ip, userAgent: context.userAgent }
    : { ipAddress: Option.none(), userAgent: Option.none() };

const issue: SessionsShape["issue"] = (input) =>
  Effect.flatMap(Effect.service(Api.AuthRequestContext), (context) =>
    issueRecording(input, recordedFrom(context)),
  );
```

`issueRecording` is today's body (`Sessions.ts:695-750`) with `ipAddress`/`userAgent` taken from its second argument
instead of `input.request` (`:714-715`); it is module-private. The legacy bridge (`:755-770`, inside `verify`, whose
type does not change) calls it with the legacy row's facts, `{ ipAddress: legacy.ipAddress, userAgent:
Option.map(legacy.userAgent, Api.toUserAgentHeader) }`: a migrated session keeps its own facts, and `verify` gains no
requirement. `cappedUserAgent` and `Sessions.MAX_USER_AGENT_LENGTH` (`:50-57`) are deleted (`Api.MAX_USER_AGENT_LENGTH`
replaces the export). The store port is unchanged: `UserAgentHeader` is a `string`.

#### 3.5.2 `SignIn` and `SignUp` (`core/src/SignIn.ts`, `internal/signInSteps.ts`, `SignUp.ts`)

```ts
export interface Failure {
  readonly strategy: string;
  readonly reason: typeof SignInFailureReason.Type;
  readonly identifierDigest?: string | undefined;
}

export interface SignInShape {
  readonly clear: (attempt: Attempt) => Effect.Effect<Clearance, ClearError, Api.AuthRequestContext>;
  readonly resume: (
    attempt: Attempt & { readonly handoff?: Hooks.Handoff | undefined },
  ) => Effect.Effect<Clearance, ResumeError, Api.AuthRequestContext>;
  readonly issue: (clearance: Clearance) => Effect.Effect<IssuedSession, StoreUnavailable, Api.AuthRequestContext>;
  readonly complete: (attempt: Attempt) => Effect.Effect<IssuedSession, ClearError, Api.AuthRequestContext>;
  /** ALF-003/CSD-004: the one publisher of `auth.user.signInFailed`; its `clientIp` is the request's address. */
  readonly failed: (failure: Failure) => Effect.Effect<void, never, Api.AuthRequestContext>;
}
```

`SessionRequest` (`signInSteps.ts:53-57`, re-exported at `SignIn.ts:35`) is deleted. `mint` loses its `request`
parameter and calls `sessions.issue` (which reads the context itself). The gate's suspended event (`:89-99`) calls
`failed({ strategy, reason: "suspended" })`. `failed` reads the context and publishes
`{ _tag: "auth.user.signInFailed", strategy, reason, identifierDigest?, clientIp? }` with `clientIp` present only for a
`Request` whose `ip` is `Some`. `SignUp.createSignedIn(application, options)` loses its third parameter
(`SignUp.ts:103-110`, `:261-269`) and gains the context in `R`.

#### 3.5.3 The `ip` rate-limit strategy (`core/src/RateLimitKey.ts`, `RateLimitModel.ts`, `RateLimits.ts`)

```ts
// RateLimitKey.ts
export interface KeyContext {
  readonly email: (address: string) => string;
  /** What the budget read from `Api.AuthRequestContext`, for a key whose `readsRequest` is true. */
  readonly request: Api.RequestFacts | Api.NoRequest;
}

export interface Key<I, R = never> {
  readonly strategy: "ip" | "email" | "identifier" | "user" | "session" | "client" | "phone" | "custom";
  readonly dimension: Dimension;
  readonly accepts: (input: unknown) => input is I;
  /** `None`: this rule does not apply to this call (only `ip`, under `NoRequest`; Q3). */
  readonly part: (input: I, context: KeyContext) => Option.Option<string>;
  readonly readsRequest: boolean;
  /** Phantom: the per-call service the key reads. Never assigned (the `"~input"` precedent, `RateLimitModel.ts:47`). */
  readonly "~requires"?: R;
}

/** The request's own address (ADR-EA-047). No input field: the address is not the caller's to supply. */
export const ip: Key<{}, Api.AuthRequestContext> = makeRequestKey({
  strategy: "ip",
  dimension: "ip",
  input: Schema.Struct({}),
  part: (_input, context) =>
    context.request._tag === "NoRequest"
      ? Option.none()
      : Option.some(`ip:${Option.getOrElse(context.request.ip, () => "unknown")}`),
});
```

(`ip`'s annotation is a value type on a plain constant, not a return-type annotation on an Effect/Layer; if the spike
shows `makeRequestKey`'s inference yields it exactly, drop the annotation.) The other strategies return
`Option.some(…)`, have `readsRequest: false` and `R = never`; `KeyContext.request` is `noRequest` for them.

`Rule<Group, I, M, R>` carries the same phantom; `rule()`/`failureRule()` infer `R` from `spec.key`. The typed handle:

```ts
export type RequiresOf<Limits, N> = Picked<N> extends infer K
  ? K extends keyof Limits
    ? Limits[K] extends { readonly "~requires"?: infer R } ? R : never
    : never
  : never;

readonly spend: <const N extends NamesOf<Limits, "attempts"> | ReadonlyArray<NamesOf<Limits, "attempts">>>(
  names: N,
  ...rest: {} extends InputsOf<Limits, N>
    ? [input?: InputsOf<Limits, N>, options?: SpendOptions]
    : [input: InputsOf<Limits, N>, options?: SpendOptions]
) => Effect.Effect<void, Api.RateLimited, RequiresOf<Limits, N>>;
// guard and charge: the same R; `input` optional when empty.
```

So `limits.spend(["signInByIp", "signIn"], { email })` needs `Api.AuthRequestContext` and an email, and
`limits.spend("changePassword", { userId })` needs nothing per call. The erased runtime (`ErasedBudget`) keeps `R =
never`: for a rule whose key `readsRequest`, `spendOne`/`guard`/`charge` read `Effect.serviceOption(Api.AuthRequestContext)`
and treat `None` as an invariant violation (unreachable through the typed handle, which requires it); a `None` part skips
the rule. `ErasedBudget` stays assignable to `Budget<Limits>` because its parameters are wider and `never` is a subtype
of any `R`. `RateLimits.bucketKey` (`RateLimits.ts:472-476`) accepts only a rule whose `R` is `never` (an ip rule there is a
compile error; its one caller, `SecondFactor.ts:205`, keys on `userId`).

#### 3.5.4 `VerificationLink.redeemer` (dp2 only)

```ts
export interface LinkBudget<E, R> {
  /** Spent first, before the token is decoded. Reads the request's address through the `ip` strategy. */
  readonly source: Effect.Effect<void, E, R> | "caller";
  readonly token: ((publicId: string) => Effect.Effect<void, E, R>) | "none";
}
// presented: { readonly token: Redacted.Redacted<string> & PresentedFor<Name> }   (no `ip`)
```

Callers become `source: limits.spend("confirmResetByIp")`, `source: limits.spend("verifyByIp")` (dp2
`Password.ts:1352-1369`, `MagicLink.ts:235-238`).

#### 3.5.5 Credential claims (`server/src/Credentials.ts` on dp2, `Authentication.ts` on `main`)

`CredentialResolverContribution.resolve`'s requirement widens to `HttpServerRequest | Api.AuthRequestContext`.
`Credentials.httpScope(request, context)` takes the context and its `claim` provides both services to
`resolveClaimed`. Path A (the four authentication middlewares) passes `yield* Api.AuthRequestContext`, legal because
their declarations `require` it. The web adapter's `Credentials.collecting` claims nothing, so it needs no context.

Path B, qadi's `SubjectExtractorLive` (dp2 `qadi/src/SubjectExtractor.ts:36-62`), implements `@qadi/http`'s
`SubjectExtractor`, whose `extract(request)` cannot carry a requirement. It reads
`Effect.serviceOption(Api.AuthRequestContext)` and, when its group declared no `Api.RequestContext`, captures the facts
with `RequestContext.capture(request)` (same function, so the same address), which adds `ClientAddress` and
`SecureRandom` to the extractor layer's requirements. qadi's own groups declare the middleware (ticket 06), so on awthaq's
routes the context is always the one the middleware captured.

On `main` (before batch-2 plan 11) the same change lands in `server/src/Authentication.ts`'s resolver registry and in
`qadi/src/SubjectExtractor.ts`.

#### 3.5.6 Events and deferred observe taps (optional reads)

```ts
// AuthEvents.ts deliver (:211-225)
const request = yield* Effect.serviceOption(Api.AuthRequestContext);
const facts = Option.filter(request, (value) => value._tag === "Request");
// correlationId: Option.map(facts, (f) => f.correlationId); ip: Option.flatMap(facts, (f) => f.ip);
// userAgent: Option.flatMap(facts, (f) => f.userAgent)
```

The narrowing uses a type guard (`(value): value is Api.RequestFacts => value._tag === "Request"`), never a cast.
`HookPoint.observe.run` (`:545-556`) captures `Effect.serviceOption(Api.AuthRequestContext)` and re-provides it only when
it is `Some`. `publish`'s and `run`'s types do not change, so a job, the relay or erasure publishes with nothing to
provide.

### 3.6 `NoRequest` and an unresolvable address

| Request context | Session row (`ipAddress`, `userAgent`) | `ip` rate-limit key | `signInFailed.clientIp` | Event envelope / audit row |
|---|---|---|---|---|
| `Request { ip: Some(a), userAgent: Some(u) }` | `a`, `u` (capped) | `ip:a` | `a` | `correlationId`, `a`, `u` |
| `Request { ip: None }` (web handler under `layerDirect`, §2.5) | none, `u` | `ip:unknown`, shared (unchanged; Q7) | absent | `correlationId`, `u` |
| `NoRequest` (CLI, job, test) | none | **rule not applied** (Q3); the identity and principal rules still are | absent | none |
| no value at all | does not compile | does not compile | does not compile | none (optional read) |

### 3.7 Plugin interfaces after

Password, as the worked example:

```ts
readonly signIn: (input: {
  readonly email: string;
  readonly password: Redacted.Redacted<string>;
}) => Effect.Effect<
  Sessions.IssuedSession,
  Api.InvalidCredentials | PasswordApi.EmailNotVerified | Users.UserSuspended | Api.RateLimited
    | HookPoint.HookAborted | Hooks.TwoFactorRequired | Errors.StoreUnavailable,
  Api.AuthRequestContext
>;

// the handler
signIn: Effect.fnUntraced(function* ({ payload, request }) {
  // Typed local (not inferred) so declaration emit can name `SessionDto` in the group's type (TS2883).
  const response: SessionContract.SessionDto = yield* SessionDelivery.respond(request, password.signIn(payload));
  return response;
}),
```

| Plugin | Members that lose `ip` / `userAgent` / `context` | Other removals |
|---|---|---|
| `Password` | `signUp`, `signUpConcealed`, `signIn`, `requestReset`, `resendVerification`, `verifyEmail`, `confirmEmailChange`, `changePassword` (dp2 also `confirmReset`) | `sessionRequest`, `requestUserAgent`, `publishSignInFailed`'s `ip`, `prepareSignUp`'s `ip`; `ports` drops `ClientAddress` |
| `Passkey` | `authenticateOptions`, `authenticateVerify` (and its `context`) | `ports` |
| `OAuth` | `authorize`, `callback`, `exchange` | `ports` |
| `Saml` / `SamlSlo` / `Sso` | `authnRequest`, `acs`, `slo` (`SloInput.ip`), `logout` (dead `ip`), `Sso.start`'s positional `ip` | internal `signIn`'s `input`; `SamlSlo` `deps.rateLimit` becomes an `Effect`; `ports` (both classes) |
| `MagicLink` / `EmailOtp` / `Channel` | `requestLink`, `verify` (+`context`); `requestCode`, `verify` (+`context`); `Channel.Completion.ip/userAgent` | two `currentClient` helpers; `ports` |
| `DeviceAuthorization` | `requestCode`, `poll` (+`context`), `verify`, `approve`, `deny` | `Source`; `currentClient`; `lookupUserCode`'s `who` keeps only `sessionId?`; `ports` |
| `TwoFactor` | `verify`, `verifyRecovery` (+`context`) | the local `complete` helper's address/user-agent read; `finalizeSignIn`'s `request`; `ports` |
| `ApiKey` | none (handler and resolver only) | `ports`; the resolver's `throttle` stops reading `HttpServerRequest` |

Each listed member gains `Api.AuthRequestContext` in `R` when it mints a session, spends an ip-keyed rule or
publishes `signInFailed`; `Saml.logout` and the others that do neither (after the dead `ip` goes) gain nothing.

### 3.8 `TestAuth` (`packages/test/src/TestAuth.ts`)

```ts
/** Runs `self` as if it answered an HTTP request with these facts (an in-process unit test of a plugin operation). */
export const withRequest =
  (facts: { readonly ip?: string; readonly userAgent?: string; readonly correlationId?: string } = {}) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.provideService(
      self,
      Api.AuthRequestContext,
      Api.AuthRequestContext.request({ correlationId: facts.correlationId ?? "test", ...facts }),
    );

/** Runs `self` as in-process work that answers no request (a job, a CLI command). */
export const withoutRequest = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.provideService(self, Api.AuthRequestContext, Api.AuthRequestContext.noRequest);
```

- `TestAuth.layer(built, { clientAddress?: string })`: the base's `ClientAddress.layerDirect`
  (`TestAuth.ts:196`) becomes a fixed resolver returning that address when the option is given, so a wire test through
  the real middleware records and keys on a known address. (Today a `toWebHandler` request resolves `None`; a test that
  needs an address over HTTP has no way to get one.)
- `TestAuth.app(composition, { request? })`: `run` provides `request ?? noRequest`, so `run(password.signIn(…))`
  type-checks. It is effect-level, never a layer, so it cannot mask form 3.
- `TestAuth.signInAs({ …, request? })`: provides the facts (or `noRequest`) around its `sessions.issue`, so the 36 test
  files that call it keep their signature (`Effect<SignedInSession, never, Users | Sessions>`).
- `TestAuth.layer` does **not** add `AuthRequestContext` to its output: a plugin's own suite must still fail to compile
  when its contract forgets the middleware (§3.4 form 2/3).

### 3.9 Contract and client impact

| Surface | Change |
|---|---|
| HTTP wire | none: no header read is added (the middleware reads the same three headers `RequestContext.layer` read) |
| OpenAPI | none: `RequestContext` declares no security and no error. Ticket 01 snapshots the composed document of `examples/memory-server` and ticket 24 diffs it |
| Contracts (`*Api.ts`) | every awthaq group adds `.middleware(Api.RequestContext)` as its last declaration (34 groups in 20 contract files, plus qadi's `SubjectGroup` and the template's `NotesGroup`; `api/src/Subject.ts` stays middleware-free by design, `qadi/src/SubjectApi.ts` declares it) |
| `@awthaq/client`, `@awthaq/react`, `@awthaq/web`, `@awthaq/next` | none: no `requiredForClient`, no change to any derived client type (typecheck + their suites in the Phase 2 gate) |
| Host-authored groups | a host group declaring an authentication middleware must declare `Api.RequestContext` after it (form 3 says so at compile time); migration note |
| Host compositions | `RequestContext.layer` is gone; `middlewareFor` derives the populator and needs `ClientAddress` |
| In-process callers of plugin operations | must provide the context (`noRequest` or captured facts); migration note |
| Webhook payloads | none (`clientIp` still in `data` with `includeClientContext`, `client.userAgent` now capped) |

### 3.10 What sits behind the seam

Before, every plugin knew three things about HTTP it had no business knowing: that the address comes from a port that
may consult forwarded headers, that the user agent is a header to be read and later capped, and which of its own
operations need either. After, a plugin knows one thing, in its types: "this operation answers a request". The
implementation behind `Api.AuthRequestContext` (correlation id rules, trusted-proxy resolution, the cap, `NoRequest`
semantics, the unknown-address bucket) has **locality**: one module, one test file. **Leverage**: ten plugin classes,
four core modules and every future plugin get it for nothing. **Depth**: the interface is one tag and one middleware
line per group; everything above is behind it.

---

## 4. Phased migration

Order: Phase 0 → 1 → 2 → 3 → 4 (one ticket per plugin package, any order) → 5 → 6. Phases 1–3 are additive or
behaviour-neutral except where a ticket says otherwise; Phase 4 removes plugin threading while core still accepts the
old explicit facts (a transitional override that exists only between tickets 09/10 and 22/23); Phase 5 removes the
overrides and turns the reads into requirements. Tickets 06 and 22–23 are each one atomic commit series (a contract
that declares a middleware needs its implementation in the same commit; a removed parameter needs its callers), and
the phase gate runs at their end, as plan 08's ticket 08 did.

Gates: **phase gate** = `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`; **+bdd** =
`pnpm test:bdd`; **+pg** = `pnpm test:pg`; **plan gate** = `pnpm check`. On dp2 also follow `.planning/IMPLEMENTING.md`
(format, `spec:verify:strict`, `check:error-tags`, `check:readmes`, `package:smoke`).

### Phase 0: preconditions, baseline, spikes (tickets 01–03)

**01 — Baseline.**
- Files: `.scratch/26-request-context/baseline.md`, `.scratch/26-request-context/openapi-before.json`.
- Change: record every §2.1 count on the tree the work starts on; the composed OpenAPI document of
  `examples/memory-server` (`buildApp` served, `GET /openapi.json`, written with sorted keys); the test count and wall
  time of `pnpm test` and `pnpm test:bdd`; the list of files the Phase 5 sweep will touch (§2.1's last two commands, plus
  `grep -rlE "yield\* (Password|Passkey|OAuth|Saml|Sso|MagicLink|EmailOtp|DeviceAuthorization|TwoFactor)\b" packages/*/test features/step-definitions`).
  Record whether batch-2 plans 15, 20 and 21 have landed (`grep -rl "AuthHost\|SessionLifecycle" packages/*/src`).
- Done when: the file exists with every number, and the OpenAPI snapshot is committed under `.scratch/`.
- Gate: none (no code).

**02 — Spike: the type mechanics, as permanent type tests.**
- Files: `packages/server/test/RequestContext.types.test.ts` (new), `packages/core/test/RateLimitBudget.types.test.ts`
  (cases added), `packages/test/test/TestAuthRequest.types.test.ts` (new).
- Change: with local declarations (no product code yet, like plan 08's ticket 02), prove: (a) §3.4's four rows and
  their negative controls (`// @ts-expect-error` on each forbidden composition), including that providing a
  `RequestContextLive` closes form 1; (b) `Key<I, R>`'s phantom makes `spend` on an ip rule require the context and on a
  user rule not, `RequiresOf` over a tuple of names unions, the optional `input` rest tuple accepts `spend("x")` and
  rejects `spend("signIn")` without an email, an erased budget is assignable to the typed one with no cast, and the
  lint rule on `{}` is satisfied (use `Schema.Struct({})["Type"]` or `Record<never, never>` if `{}` is rejected);
  (c) `withRequest`/`withoutRequest` remove exactly `Api.AuthRequestContext` from `R`.
- Done when: `pnpm typecheck` passes with every negative control failing as intended (verified once by deleting each
  `@ts-expect-error` and seeing the error, noted in the ticket).
- Gate: phase gate.

**03 — Decisions recorded.**
- Files: `.scratch/26-request-context/issues/03-decisions.md`.
- Change: record the answers to §10 Q1–Q9 (or the recommended defaults). Q1, Q2 and Q4 block Phase 2; Q3 blocks
  ticket 23; Q5 blocks ticket 09; Q6 blocks ticket 11; Q7 and Q9 block ticket 28's wording; Q8 blocks ticket 24.
- Done when: every question has an answer and the ticket links it from `§ Decisions taken` of this plan.
- Gate: none.

### Phase 1: one tag (tickets 04–05)

**04 — `@awthaq/api`: the request-context value and the middleware declaration.**
- Files: `packages/api/src/Api.ts`, `packages/api/src/index.ts` (header comment), `packages/api/test/RequestContext.test.ts` (new).
- Change: add `MAX_USER_AGENT_LENGTH`, `UserAgentHeader`, `toUserAgentHeader`, `RequestFacts`, `NoRequest`,
  `AuthRequestContext` (with `noRequest` and `request`) and `RequestContext` exactly as §3.2. Do **not** add the
  `requires` lines yet (ticket 08). Nothing declares `RequestContext` yet.
- Tests: `request` caps a 600-character user agent at 512 and keeps a short one; omitted `ip`/`userAgent` are `None`;
  `noRequest` is `{ _tag: "NoRequest" }`; a `UserAgentHeader` cannot be made from a bare string (type test).
- Done when: the tests pass and `pnpm --filter @awthaq/api build` emits declarations naming the new exports.
- Gate: phase gate.

**05 — Core and server read the one tag (optionally); the old core module goes.**
- Files: delete `packages/core/src/AuthRequestContext.ts` and its line in `packages/core/src/index.ts` (`:40`); edit
  `core/src/AuthEvents.ts` (`:50`, `:211-225`), `core/src/HookPoint.ts` (`:61`, `:545-556`),
  `core/src/internal/signInSteps.ts` (`:14`, `:89-99`, `:148-166`), `server/src/RequestContext.ts` (`:17`, `:81-86`),
  `core/test/AuthEvents.test.ts` (`:20`, `:412-440`), `core/test/SignIn.test.ts` (`:19`, `:170-180`, `:365-395`).
- Change: every reader switches to `Effect.serviceOption(Api.AuthRequestContext)` and narrows with a type guard on
  `_tag === "Request"` (§3.5.6); `signInSteps.mint` keeps its explicit per-field override for now. The still-global
  router middleware provides `Api.AuthRequestContext.request({ correlationId, ip, userAgent })`, which caps the user
  agent (G5's audit half lands here). Tests that provided `{ ...AuthRequestContext.none, … }` provide
  `Api.AuthRequestContext.request({ … })`.
- Done when: no file imports `../AuthRequestContext.ts` or `AuthRequestContext` from `@awthaq/core`
  (`grep -rn "AuthRequestContext" packages/*/src | grep -v "Api.AuthRequestContext\|api/src/Api.ts"` is empty);
  `AuthEvents.test.ts` gains "a 600-character user agent is stored as 512 on the audit row and the bus event".
- Gate: phase gate. Changeset C1 (§6.8).

### Phase 2: one populator, required by the type (tickets 06–08)

**06 — `RequestContextLive`, its derivation, and every contract declares it.** (one atomic commit series)
- Files: `packages/server/src/RequestContext.ts` (add `captureWith`, `capture`, `RequestContextLive`; keep the old
  global `layer` for one ticket), `packages/server/src/AuthHttp.ts` (`HostMiddleware`, the `middlewareFor` table and its
  `RIn`), every contract file: `api/src/Session.ts`, `api/src/Account.ts`, `admin/src/AdminApi.ts`,
  `admin/src/AdminTenantsApi.ts`, `admin/src/AdminAccountsApi.ts`, `api-key/src/ApiKeyApi.ts`,
  `device-authorization/src/DeviceAuthorizationApi.ts`, `jwt/src/JwtApi.ts`, `magic-link/src/MagicLinkApi.ts`,
  `magic-link/src/EmailOtpApi.ts`, `organization/src/OrganizationApi.ts`, `passkey/src/PasskeyApi.ts`,
  `password/src/PasswordApi.ts`, `oauth/src/OAuthApi.ts`, `roles/src/RolesAdminApi.ts`, `saml/src/SamlApi.ts`,
  `saml/src/Sso.ts`, `scim/src/ScimApi.ts`, `two-factor/src/TwoFactorApi.ts`, `webhooks/src/WebhooksApi.ts`,
  `qadi/src/SubjectApi.ts`, `examples/plugin-template/src/TemplateApi.ts`; hand-built compositions that the compiler
  then flags (server, qadi, features worlds that build `AuthenticationLive`/`CsrfProtectionLive` themselves; ticket 01's
  list); `packages/api/test/Contracts.test.ts:53-59`; `packages/test/src/TestAuth.ts` (`runPluginContractTests`).
- Change: `.middleware(Api.RequestContext)` as the **last** call on every group (after `CsrfProtection`, after qadi's
  `OptionalAuthentication`, after `RequestDecisionCache` where a host declares it; after batch-2 plan 21's lifecycle
  markers if they have landed). `middlewareFor` derives `RequestContextLive` (`Layer.fresh`, like its siblings) and
  requires `ClientAddress`. Hand-built test compositions provide `RequestContext.RequestContextLive` (and
  `ClientAddress.layerDirect` where absent). `runPluginContractTests` gains a case: every endpoint of the plugin's
  contract has `RequestContext` as its last middleware (`HttpApi.reflect`, `[...middleware].at(-1)?.key`).
  `Contracts.test.ts` expects `["Authentication", "CsrfProtection", "RequestContext"]`.
- Done when: `pnpm typecheck` passes; the composed `examples/memory-server` OpenAPI equals ticket 01's snapshot
  byte for byte; a `TestAuth.app` request's audit row carries a correlation id without any extra wiring (new case in
  `packages/test/test/TestAuth.test.ts`); every plugin's contract test passes the new case.
- Gate: phase gate +bdd.

**07 — Delete the opt-in machinery.**
- Files: `packages/server/src/RequestContext.ts` (delete `layer`, `registration`, `installedRouters`, `isInstalledOn`,
  `warnWhenAbsent`, and the global `HttpRouter.middleware`), `packages/server/src/AuthHttp.ts` (delete
  `requestContextCheck`; `coreHandlers` is `Layer.merge(Session.SessionHandlers, Account.AccountHandlers)`),
  `packages/server/src/index.ts` if it re-exports any of them, `packages/test/src/TestAuth.ts:372-378`,
  `examples/memory-server/app.ts:252-262`, `examples/sql-server/app.ts:196-200`, `packages/server/README.md:13-17`;
  delete `packages/server/test/RequestContextWarning.test.ts`; rewrite `packages/server/test/RequestContext.test.ts`
  (§5.1); on dp2 delete `ClientAddress.facts`/`ClientAddress.address` only after Phase 4 has removed their last caller
  (move that half to ticket 21 if Phase 4 has not finished; the ticket file says which).
- Done when: `grep -rn "warnWhenAbsent\|isInstalledOn\|requestContextCheck\|RequestContext.layer" packages examples features docs --include=*.ts --include=*.md`
  is empty (outside `.planning/` and changesets); the rewritten `RequestContext.test.ts` passes.
- Gate: phase gate +bdd. Changeset C2 (§6.8) covers 06–08.

**08 — The authentication middlewares require the context; claims receive it.**
- Files: `packages/api/src/Api.ts` (`requires: AuthRequestContext` on `Authentication`, `MachineAuthentication`,
  `AdminAuthentication`, `OptionalAuthentication`); `packages/server/src/Credentials.ts` on dp2
  (`CredentialResolverContribution.resolve`'s `R`, `httpScope(request, context)`), or `packages/server/src/Authentication.ts`
  on `main`; the Path A call sites (dp2 `Authentication.ts:96-112`, `:198-223`); `packages/qadi/src/SubjectExtractor.ts`
  (§3.5.5); test- and feature-defined groups that declare an authentication middleware (33 sites:
  `grep -rn "middleware(Api\.\(Authentication\|MachineAuthentication\|OptionalAuthentication\|AdminAuthentication\))" packages/*/test features examples`)
  add `.middleware(Api.RequestContext)` after it; tests that call `Credentials`/`resolvePrincipal` directly provide a context.
- Change: as §3.5.5. Add the ordering row (form 3) of the ticket 02 type test against the real `Api` classes.
- Done when: `pnpm typecheck` passes; a type test shows `Api.Authentication` declared outside `Api.RequestContext`
  leaves `Api.AuthRequestContext` in the group layer's input; qadi's Path B test "a group without the middleware still
  throttles by the captured address" passes.
- Gate: phase gate +bdd.

### Phase 3: core reads the context first (tickets 09–12)

**09 — `Sessions.issue` records the request context; admin impersonation records the administrator.**
- Files: `packages/core/src/Sessions.ts` (`:50-57`, `:335-337`, `:695-770`), `packages/core/test/Sessions.test.ts`,
  `packages/admin/test/` (one new case in the impersonation suite).
- Change: `issueRecording(input, recorded)` as §3.5.1; `issue` takes the facts from `input.request` per field when given
  (transitional, deleted in ticket 22), else from `Effect.serviceOption(Api.AuthRequestContext)`, else none. The bridge
  passes the legacy facts through `Api.toUserAgentHeader`. `cappedUserAgent` and `Sessions.MAX_USER_AGENT_LENGTH` go
  (re-point their two importers, `grep -rn "MAX_USER_AGENT_LENGTH" packages`). `Admin.impersonate` (`Admin.ts:1116`;
  dp2 `:872`) is untouched and now records the administrator's address and user agent (Q5).
- Done when: new `Sessions.test.ts` cases: facts from the context; an explicit `request` field wins (transitional);
  `NoRequest` records none; a 600-character user agent is stored as 512; the bridge keeps the legacy facts. The admin
  case asserts the impersonation session's `ipAddress`/`userAgent` over `TestAuth.app` with `clientAddress` (needs
  ticket 12; land 12 first or in the same PR).
- Gate: phase gate +pg. Changeset C3 covers 09–12.

**10 — The `ip` strategy reads the request context (transitional).**
- Files: `packages/core/src/RateLimitKey.ts`, `RateLimitModel.ts`, `RateLimits.ts`, `core/test/RateLimitKey.test.ts`,
  `core/test/RateLimitBudget.test.ts`; on dp2 `core/src/VerificationLink.ts` (`:248-284`) and its test.
- Change: `KeyContext` gains `request`; the budget fills it from `Effect.serviceOption(Api.AuthRequestContext)` for an
  ip-strategy rule (absent → treat as a `Request` with no address, today's `ip:unknown`). `Key.ip.part` uses the explicit
  `input.ip` when given (transitional) else the context's address else `unknown`. The input schema stays
  `{ ip?: string }` until ticket 23. On dp2, `VerificationLink.redeemer` calls `source(presented.ip)` unchanged (the
  callee falls back to the context when `ip` is undefined).
- Done when: new cases: a spend with no `ip` under `withRequest({ ip: "203.0.113.7" })` keys `ip:203.0.113.7`; with no
  context, `ip:unknown`; an explicit `ip` still wins.
- Gate: phase gate.

**11 — `SignIn.failed`: one publisher of `auth.user.signInFailed`.**
- Files: `packages/core/src/SignIn.ts`, `core/src/internal/signInSteps.ts`, `core/test/SignIn.test.ts`.
- Change: add `failed` to `SignInShape` (§3.5.2); the gate's suspended event uses it. During the transition it reads the
  context optionally (absent → no `clientIp`).
- Done when: `SignIn.test.ts` case: `failed({ strategy: "passkey", reason: "assertionInvalid" })` under
  `withRequest({ ip })` publishes `clientIp: ip`, under `withoutRequest` publishes none, and passes
  `identifierDigest` through.
- Gate: phase gate.

**12 — `TestAuth` request helpers.**
- Files: `packages/test/src/TestAuth.ts`, `packages/test/src/index.ts`, `packages/test/test/TestAuth.test.ts`,
  `packages/test/test/TestAuthRequest.types.test.ts`.
- Change: `withRequest`, `withoutRequest`, `TestAuth.layer`'s `clientAddress` option, `TestAuth.app`'s `request` option
  and `run` default, `signInAs({ request })` (§3.8). If batch-2 plan 20 has landed, its agent factories keep working
  unchanged (the agent sends headers; this ticket only fixes what the middleware resolves).
- Done when: tests: a wire request through `TestAuth.app` with `clientAddress: "198.51.100.4"` and a `user-agent` header
  yields a session with both; `signInAs({ request: { ip } })` records it; `run` without options provides `noRequest`.
- Gate: phase gate.

### Phase 4: per-plugin migration (tickets 13–21)

Each plugin ticket does the same five things, then the plugin-specific list:
1. Handlers stop reading the address and the user agent: delete `clientAddress` from the group builder, the
   `clientAddress.resolve` / `ClientAddress.facts` / `ClientAddress.address` calls and the local helpers; pass the payload.
2. The interface loses `ip`, `userAgent` and `context` (the members in §3.7); internal helpers lose them too; calls to
   `SignIn.complete/issue`, `SignUp.createSignedIn` and `sessions.issue` pass no facts (core reads the context since
   Phase 3).
3. Spends of ip-keyed rules pass no `ip` (`limits.spend("x", {})`, or the remaining fields only).
4. `auth.user.signInFailed` is published through `SignIn.failed`; the plugin's `events.publish({ _tag: "auth.user.signInFailed", … })` goes.
5. `ports` drops `ClientAddress.ClientAddress`; in-process tests that passed `ip`/`userAgent` use `TestAuth.withRequest`;
   the plugin's "records ip and user agent" tests are deleted and replaced by **one wiring probe** over HTTP
   (`TestAuth.app` with `clientAddress` + `user-agent` header): the minted session records both, and one ip-keyed rule
   refuses the (limit+1)th request from that address while a different `clientAddress` app instance is not refused.
   The spec signature snippets of the plugin (§6.1) and a changeset with its `Migration:` line (§6.8) ship in the ticket.

Done when (every plugin ticket): inside the package, `grep -rn "ClientAddress\|\"user-agent\"\|readonly ip?\|readonly userAgent?\|clientIp:" <pkg>/src`
is empty; the package's suite and the probe pass. Gate: phase gate +bdd (each plugin has features).

**13 — `password`.** `Password.ts` handlers (`:654-786`, `:792-833`; dp2 `:660-820`), members `:342-517` (and dp2's
`confirmReset`), `sessionRequest` (`:627-631`), `requestUserAgent` (`:633-638`), `publishSignInFailed` (`:1002-1013` →
`completion.failed`), `prepareSignUp` (`:1106-1110`), `createSignedIn(…, sessionRequest(input))` (`:1151`),
`complete(…, sessionRequest(input))` (`:1280`), `sessions.issue({ request })` (`:1721-1726`), `ports` (`:930`). Tests:
`Password.test.ts` (16 literals), `PasswordRateLimitBehaviour.test.ts` (3), delete `PasswordSessionContext.test.ts`
(52 lines; the probe replaces it in `password/test/AuthHttp.test.ts`), `password/test/harness.ts`. Features:
`PasswordWorld.ts`, `PasswordSteps.ts`. Spec: BEH-EA-113/114 snippets, `15-password.md:31`.

**14 — `passkey`.** Handlers (`:670-711`; dp2 `:340-370`), members `:558-575`, `authenticateOptions` (`:1389-1393`),
`authenticateVerifyByIp` (`:1464`), `complete(…, { ip, userAgent })` (`:1559-1562`), the failure tap (`:1575-1590` →
`signIn.failed`), `ports` (`:1075`). Tests: `PasskeyEnumeration.test.ts` (8), `Passkey.test.ts` (3+4), `features/…/PasskeyWorld.ts`.

**15 — `oauth`.** Handlers `authorize` (`:476-525`), `callback` (`:527-580`), `exchange` (`:593-618`); members
`:625-700`; spends `:864`, `:935`, `:1335`; `complete(…, { ip, userAgent })` (`:1258-1261`); the failure (`:1316-1326` →
`completion.failed`); `ports` (`:749`). On dp2 the identity step is `FederatedIdentity`, untouched. Tests: `OAuth.test.ts`
(7+7), `OAuthNative.test.ts`, `features/…/OAuthWorld.ts`, `OAuthSteps.ts`.

**16 — `saml` (`Saml`, `SamlSlo`, `Sso`).** `Saml.ts` handlers (`:430-610`), members `:134-172`, internal `signIn`
(`:1136-1220`), spends `:903`, `:1229`, the failure (`:1233-1245` → `completion.failed`), `rateLimit` (`:1277`);
`SamlSlo.ts` `SloInput.ip` (`:72`), `deps.rateLimit` (`:116`, becomes `Effect<void, Api.RateLimited, Api.AuthRequestContext>`),
`logout`'s dead `ip` (`:175-177`), `:378`; `Sso.ts` `start(input, ip)` (`:120-123`, `:254-255`), handler (`:160-175`),
`ports` (`:155`); `Saml.ts` `ports` (`:825`). Tests: `Saml.test.ts` (4), `SamlSlo.test.ts` (1 + 3 `request:`),
`SamlSloHttp.test.ts`, `Sso.test.ts`, `features/…/SamlWorld.ts`.

**17 — `magic-link` (`MagicLink`, `EmailOtp`, `Channel`).** `MagicLink.ts` members (`:144-161`), `currentClient`
(`:164-175`), handlers (`:177-212`), spends (`:250`, `:290`; dp2 the redeemer `source` `:235-238`), the failure
(`:292-300` → `channel`'s `signIn.failed`), `channel.complete` (`:315`), `ports` (`:225`); `EmailOtp.ts` the same shape
(`:143-160`, `:167-178`, `:185-215`, `:255`, `:287`, `:294`, `:308`, `:231`); `Channel.ts` `Completion` (`:69-70`) and
`signIn.complete(…, { ip, userAgent })` (`:151-153`). Tests: `MagicLink.test.ts`, `EmailOtp.test.ts`,
`features/…/MagicLinkSupport.ts` (2), `MagicLinkWorld.ts`, `EmailOtpSteps.ts`.

**18 — `device-authorization`.** `Source` (`:380-382`), members (`:405-455`), `currentClient` (`:467-478`), handlers
(`:520-674`), `requestCode` spend (`:864`), `lookupUserCode`'s `who` (`:922-934`, keeps `sessionId?`), `poll` (`:1076-1080`,
drops `context`), `signIn.issue(cleared, { … })` (`:1142-1145`), `ports` (`:762`). Tests: `DeviceAuthorization.test.ts`
(11), `Plugin.test.ts` (3), `features/…/DeviceAuthorizationSteps.ts` (5), `DeviceAuthorizationWorld.ts`. Spec:
`37-device-authorization.md:20`, `:51`, `:82`, `:103-104`.

**19 — `two-factor`.** Members (`:124-139`), the handler helper `complete` (`:313-333`; dp2 `:305-315`), `finalizeSignIn`
(`:547-565`), `attempt` (`:575-582`; dp2 the challenge redeemer, `SecondFactor.ts:453-455`), `ports` (`:498`). Tests:
`two-factor/test/*`, `features/…/TwoFactorWorld.ts`, `TwoFactorSteps.ts`. Spec: `31-two-factor.md` snippets.

**20 — `api-key`.** Token handler (`:547-560`: `limits.spend("tokenByIp", {})`), resolver `throttle` (`:608-616`:
`limits.spend("resolveByIp", {})`, no `HttpServerRequest` read; needs ticket 08's widened claim requirement), `ports`
(`:796`). No interface change. Tests: `api-key/test/harness.ts`, `ApiKey.test.ts`; one probe: two `x-api-key`
presentations from one `clientAddress` count against one bucket.

**21 — Plugin template, plugin-authoring guide, plugin READMEs.**
- Files: `examples/plugin-template/src/Template.ts:300` (the `Key.ip` comment), `docs/plugin-authoring.md:79-90`
  (the rate-limit paragraph: "`Key.ip` reads the request context; pass no address") and `:195` (the request-facts
  paragraph: "a session records the request's facts from `Api.AuthRequestContext`; declare `Api.RequestContext` last on
  every group"), a new short section "Request facts" (the rule, `withRequest`/`withoutRequest`, `RequestContext.capture`
  for host routes), the READMEs that mention `ClientAddress` for plugins (`saml`, `api-key`, `oauth`,
  `device-authorization`, `passkey`, `two-factor`), `packages/ports/src/ClientAddress.ts:1-41` (header: the port is read
  by the request-context middleware, not by plugins), `packages/ports/README.md`; on dp2 delete
  `ClientAddress.facts`/`address` here if ticket 07 deferred it.
- Done when: `grep -rn "ClientAddress" packages/*/README.md docs/plugin-authoring.md` mentions only the host's choice of
  topology and the middleware; `pnpm check:readmes` passes.
- Gate: phase gate.

### Phase 5: seal (tickets 22–24)

Tickets 22 and 23 flip optional reads into requirements; the call sites that then fail to compile are fixed in the
same commit series (ticket 01's sweep list is the expected set).

**22 — Seal sessions and sign-in: no explicit facts, the context required.**
- Files: `packages/core/src/Sessions.ts` (`issue` loses `request`; `Effect.service`), `core/src/SignIn.ts`,
  `core/src/internal/signInSteps.ts` (`SessionRequest` deleted; `mint`, `clear`, `resume`, `issue`, `complete`, `failed`
  require the context), `core/src/SignUp.ts` (`createSignedIn` loses `request`), `packages/test/src/TestAuth.ts`
  (`signInAs` provides), every test and step file that issues a session or calls a sign-in plugin operation in-process
  (ticket 01's list; expect about 80 files): add `.pipe(TestAuth.withoutRequest)` / `withRequest(…)`, or in core and sql
  tests (which cannot depend on `@awthaq/test`) `Effect.provideService(Api.AuthRequestContext, Api.AuthRequestContext.noRequest)`
  at the test layer's use site.
- Done when: `grep -rnE "readonly request\?:|SessionRequest" packages/core/src` is empty; `pnpm typecheck` passes.
- Gate: run with ticket 23.

**23 — Seal the `ip` strategy (and the redeemer's source).**
- Files: `packages/core/src/RateLimitKey.ts` (`Key<I, R>`, `readsRequest`, `part` → `Option`, `ip`'s input
  `Schema.Struct({})`), `RateLimitModel.ts` (`Rule`'s phantom, `RequiresOf`, the rest-tuple `spend`/`guard`/`charge`),
  `RateLimits.ts` (the erased runtime per §3.5.3, `NoRequest` skips per Q3, `bucketKey`'s `R = never` constraint); on dp2
  `VerificationLink.ts` (`LinkBudget.source` per §3.5.4, `presented` without `ip`); every ip-keyed spend that still passes
  `{ ip: … }` (none after Phase 4; the compiler confirms); `core/test/RateLimitKey.test.ts`, `RateLimitBudget.test.ts`,
  `RateLimitBudget.types.test.ts`, `features/step-definitions/CompileTimeGates.ts` (the `rate-limit-key-…` gate, `:99`
  on `main`), `features/step-definitions/RateLimitingWorld.ts`.
- Done when: `limits.spend("signInByIp", { ip: "x" })` is a compile error (excess property on a fresh literal) and
  `limits.spend("signInByIp")` outside a request context is a compile error (type tests); runtime cases: `NoRequest`
  skips an ip rule and still spends the email rule; `Request { ip: None }` keys `ip:unknown`.
- Gate: phase gate +bdd +pg (with ticket 22).

**24 — Seams, gates and `doctor`.**
- Files: `packages/core/test/RequestContextSeams.test.ts` (new, the `SignInSeams.test.ts` file-scan pattern,
  `core/test/SignInSeams.test.ts:1-50`), `core/test/SignInSeams.test.ts` (its `Sessions.issue` allowlist reasons),
  `features/step-definitions/CompileTimeGates.ts` (a `// type-gate: serving-without-request-context-does-not-compile`
  block: an `Auth.make([Password])` composition provided with every host middleware except `RequestContextLive`, under
  `@ts-expect-error`), `packages/cli/src/Doctor.ts` (check 6: an endpoint whose last middleware is not
  `RequestContext`, reported like the CSRF check at `:105-122`, as a warning per Q8), `packages/cli/test/` (its case).
- Change: the seam test scans `packages/*/src` (comment lines removed) and asserts zero of each in plugin and core
  source outside the named owners: `ClientAddress.ClientAddress` (owner: `server/src/RequestContext.ts`), `.resolve(request)`
  (same), `"user-agent"` (same; plus `webhooks` outbound and `web/src/InProcessClient.ts`, which forward, not read),
  `remoteAddress` (`ports/src/ClientAddress.ts`), `readonly ip?:` / `readonly userAgent?:` on an exported interface
  outside `api/src/Api.ts` and the store ports, `_tag: "auth.user.signInFailed"` (owner: `core/src/internal/signInSteps.ts`),
  `AuthRequestContext.noRequest` and `Layer.succeed(Api.AuthRequestContext` (owner: `packages/test/src`). Each allowlist
  entry carries a `why`.
- Done when: the seam test, the type gate and the doctor case pass; the composed OpenAPI still equals ticket 01's
  snapshot.
- Gate: phase gate +bdd. Changeset C12 (§6.8) covers 22–24.

### Phase 6: spec, ADR, BDD, docs, changesets (tickets 25–28)

**25 — ADR-EA-047 and the glossary.** `spec/decisions/047-request-facts-from-auth-request-context.md` (the §6.2 text),
`spec/decisions/index.yaml` entry, the "Related" lines of ADR-EA-010, 012, 037 and 038 (one sentence each, revision bump),
`spec/glossary.md` entries **Request context** and **No request** (revision bump). Done when `pnpm spec:verify:strict`
passes. Gate: plan gate.

**26 — Behaviour specs and traceability.** The §6.1 entries with Document Control bumps; `spec/traceability.md` rows for
every new or rewritten test file (§5). Done when `pnpm spec:verify:strict` passes. Gate: plan gate.

**27 — BDD.** The §6.5 scenarios and step definitions; `features/traceability.md` regenerated. Done when the new scenarios
pass in `pnpm test:bdd` and fail when `RequestContextLive` is replaced by a fixed value (checked once, noted). Gate: +bdd.

**28 — Docs, READMEs, changeset review.** `packages/server/README.md` (the request-context section rewritten: required,
derived by `middlewareFor`, `capture` for host routes, the unresolvable-address caveat for web handlers, Q7),
`README.md` quickstart if it shows `RequestContext.layer`, `docs/migrations/*` if they do; every changeset of §6.8
present with its `Migration:` line. Done when `pnpm check` passes. Gate: plan gate.

### Ticket table

| # | Title | Phase | Depends on |
|---|---|---|---|
| 01 | Baseline | 0 | — |
| 02 | Spike: type mechanics as permanent type tests | 0 | — |
| 03 | Decisions recorded (§10) | 0 | — |
| 04 | `@awthaq/api`: request-context value and middleware declaration | 1 | 02 |
| 05 | Core and server read the one tag; core module deleted | 1 | 04 |
| 06 | `RequestContextLive`, its derivation, every contract declares it | 2 | 03, 05 |
| 07 | Delete the opt-in machinery | 2 | 06 |
| 08 | Authentication middlewares require the context; claims receive it | 2 | 06 |
| 09 | `Sessions.issue` records the context; impersonation records the admin | 3 | 05, 12 |
| 10 | The `ip` strategy reads the context (transitional) | 3 | 05 |
| 11 | `SignIn.failed`, one publisher of `signInFailed` | 3 | 05 |
| 12 | `TestAuth` request helpers | 3 | 06 |
| 13 | Migrate `password` | 4 | 09, 10, 11, 12 |
| 14 | Migrate `passkey` | 4 | 09, 10, 11, 12 |
| 15 | Migrate `oauth` | 4 | 09, 10, 11, 12 |
| 16 | Migrate `saml` (`Saml`, `SamlSlo`, `Sso`) | 4 | 09, 10, 11, 12 |
| 17 | Migrate `magic-link` (`MagicLink`, `EmailOtp`, `Channel`) | 4 | 09, 10, 11, 12 |
| 18 | Migrate `device-authorization` | 4 | 09, 10, 12 |
| 19 | Migrate `two-factor` | 4 | 09, 10, 12 |
| 20 | Migrate `api-key` | 4 | 08, 10, 12 |
| 21 | Template, plugin-authoring guide, READMEs | 4 | 13–20 |
| 22 | Seal sessions and sign-in | 5 | 13–21 |
| 23 | Seal the `ip` strategy and the redeemer source | 5 | 13–21 |
| 24 | Seams, gates, `doctor` | 5 | 22, 23 |
| 25 | ADR-EA-047 and glossary | 6 | 24 |
| 26 | Behaviour specs and traceability | 6 | 24 |
| 27 | BDD | 6 | 24 |
| 28 | Docs, READMEs, changeset review | 6 | 25, 26, 27 |

The table maps 1:1 onto `.scratch/26-request-context/issues/NN-<slug>.md` (slug = the title, kebab-cased).

---

## 5. Test plan

### 5.1 New tests at the deepened interface

| File | Cases |
|---|---|
| `packages/api/test/RequestContext.test.ts` (new) | `request` caps the user agent at 512 and keeps a short one; omitted fields are `None`; `noRequest`'s shape; `UserAgentHeader` is unforgeable from a bare string (type case) |
| `packages/server/test/RequestContext.test.ts` (rewritten, served through a one-group `HttpApiBuilder` app with `RequestContextLive`) | a sane `x-request-id` is the correlation id; an insane one falls back to `traceparent`'s trace id, then to a uuidv7 (keep the existing pure `correlationIdFrom` cases); the address is what `ClientAddress` resolves (`layerTrustedProxy` with `x-forwarded-for`), and `None` under `layerDirect` for a web request; the user agent is capped; the handler's log lines carry `auth.correlation_id`; **two concurrent requests** (`Effect.all([...], { concurrency: "unbounded" })`) each see their own facts and their events carry their own correlation id; `capture(request)` returns the same facts the middleware provides |
| `packages/server/test/RequestContext.types.test.ts` (ticket 02, then pinned to the real classes) | §3.4's four rows with negative controls; `middlewareFor` over a contract that declares `RequestContext` outputs `Api.RequestContext` |
| `packages/server/test/MiddlewareFor.test.ts` | the derived layer includes `RequestContext`; it requires `ClientAddress` (type case in `MiddlewareFor.types.test.ts`) |
| `packages/core/test/Sessions.test.ts` | `issue` records the context's address and user agent; `NoRequest` records none; the user agent is stored capped; the legacy bridge keeps the legacy facts and `verify` needs no context; (transitional, deleted in 22) an explicit field wins |
| `packages/core/test/SignIn.test.ts` | replaces "request facts come from `AuthRequestContext`, an explicit field overrides per field" (`:365-395`) with "request facts come from the context only; `NoRequest` records none"; `failed` stamps `clientIp` only for a `Request` with an address; the suspended gate goes through `failed` |
| `packages/core/test/RateLimitKey.test.ts` | `Key.ip` under a `Request` keys `ip:<addr>`, under a `Request` with no address `ip:unknown`, under `NoRequest` yields `None`; the other strategies ignore the context |
| `packages/core/test/RateLimitBudget.test.ts` | under `NoRequest`, `spend(["signInByIp", "signIn"], { email })` skips the ip rule and spends the email rule; under a `Request`, two addresses get two buckets; `guard`/`charge` follow the same rule; a hand-built erased handle with no context on an ip rule dies with the invariant violation |
| `packages/core/test/RateLimitBudget.types.test.ts` | ip-rule spends require the context, user-rule spends do not; `input` is optional only when every named rule's input is empty; `bucketKey` rejects an ip rule |
| `packages/core/test/AuthEvents.test.ts` | the envelope reads a `Request`'s facts, nothing under `NoRequest` or with no context; a deferred observe tap sees the captured facts (existing ADR-EA-037 case, re-pointed) |
| `packages/core/test/RequestContextSeams.test.ts` (new) | ticket 24's counted allowlist |
| `packages/test/test/TestAuth.test.ts`, `TestAuthRequest.types.test.ts` | `clientAddress` + header → session facts over HTTP; `signInAs({ request })`; `run`'s `noRequest` default; `withRequest`/`withoutRequest` types |
| `packages/qadi/test/SubjectExtractor.test.ts` | Path B inside a group with the middleware uses its facts; without it, captures the same address (one `resolveByIp` charge either way) |
| One HTTP probe per plugin (tickets 13–20) | the session records the address and user agent; one ip-keyed rule counts per address |
| `packages/cli/test/Doctor*.test.ts` | an endpoint without `RequestContext` outermost is reported |

### 5.2 Deleted or replaced (replace, don't layer)

| Test | Why it goes | Replaced by |
|---|---|---|
| `packages/server/test/RequestContextWarning.test.ts` (64 lines) | the warning is gone | the type test (form 1–3) |
| `packages/password/test/PasswordSessionContext.test.ts` (52 lines) | per-plugin re-test of what `Sessions` records | `Sessions.test.ts` + the password HTTP probe |
| `SignIn.test.ts:365-395` (per-field override) | the override is gone | the context-only case |
| `RateLimitKey.test.ts:23-27`, `:57-63` (`Key.ip.part({ ip })`) | the key has no input field | the context cases |
| `clientIp` assertions in `password/test/Password.test.ts`, `passkey/test/Passkey.test.ts`, `oauth/test/OAuth.test.ts` (one each) | `clientIp` is stamped in one place | `SignIn.test.ts`'s `failed` cases |
| Every in-process test that passed `ip`/`userAgent` only to assert they were recorded (Phase 4 inventory per plugin) | re-tests core | the probes |

In-process tests that passed `ip` because a rate-limit rule needed it keep their assertion and change only how the
address arrives (`TestAuth.withRequest({ ip })`).

### 5.3 Concurrency and Postgres

- Correlation isolation under concurrent requests (server test above) and under concurrent in-process work
  (`Effect.all` of two `withRequest` blocks publishing events: each audit row carries its own facts).
- `pnpm test:pg` in Phases 3 and 5: the `Sessions` domain now reads the context; `SignUpSql.test.ts`, the store contract
  and `Repositories.postgres.test.ts`/`SessionStoreSql` suites issue sessions and must provide a context (no SQL adapter
  changes, so no new Postgres case; the existing PII-sealing cases in `packages/sql/test/PiiEncryption.test.ts`, 29
  `ipAddress`/`userAgent` lines, now provide the facts through the context and must still read them back sealed).

### 5.4 Measurable targets (re-run §2.1 at ticket 24)

| Measure | `main` | dp2 | Target |
|---|---:|---:|---:|
| plugin source files importing `ClientAddress` | 10 | 10 | 0 |
| address resolutions in plugin handlers | 24 | 31 | 0 |
| `User-Agent` reads (excluding webhooks/web forwarding) | 9 | 2 | 1 (`RequestContext.capture`) |
| `readonly ip?` on plugin interfaces | 32 | 33 | 0 |
| `readonly userAgent?` on plugin interfaces | 17 | 17 | 0 |
| public plugin members taking `ip` | 29 | 30 | 0 |
| `clientIp:` stamped outside core | 6 | 6 | 0 |
| explicit request arguments in core interfaces | 3 | 3 (+1 `VerificationLink`) | 0 |
| opt-in machinery references | 9 | 9 | 0 |
| test lines deleted (files in §5.2) | — | — | ≥ 116 |

---

## 6. Spec, ADR, traceability, BDD, docs, changesets

### 6.1 Behaviour specs (each bumps its Document Control revision and adds a change-history line "plan 26")

| Spec | Entry | Change |
|---|---|---|
| `spec/behaviors/09-authentication-middleware.md` (rev 1.4 → 1.5) | **new BEH-EA-RC1** (provisional id; take the next free number at write time) "Every request awthaq serves carries one request context, captured once at its edge" | `Api.RequestContext` declared outermost on every group, derived by `middlewareFor`, required by the type (forms 1–3), correlation id rules, the capped user agent; replaces the rev 1.4 sentence "`RequestContext.layer` stays opt-in and `AuthHttp.coreHandlers` warns at build when it is absent" |
| | BEH-EA-065/066/068/071 | the four authentication middlewares `require` the request context; credential claims receive it |
| `spec/behaviors/07-sessions.md` (rev 1.7 → 1.8) | BEH-EA-049 snippet (`:24`) | `sessions.issue({ userId })` (no `request`) |
| | BEH-EA-054 (CSD-003 paragraph, `:127`) | "every session records the facts of the request that minted it, read from `AuthRequestContext`; `NoRequest` records none; the user agent is capped at capture" |
| | **new BEH-EA-RC2** "An in-process caller states that there is no request" | §3.6's table: sessions, rate limits, `signInFailed`, envelopes |
| `spec/behaviors/14-rate-limiting.md` (rev 1.3 → 1.4) | BEH-EA-108 "As shipped" (`:119`) and the **Deviation** (`:121`) | `ip` reads the request's address from `AuthRequestContext` (no input field); `NoRequest` does not apply the rule; an unresolvable address shares `ip:unknown`. The deviation note is rewritten: "the `ip` strategy reads the network origin from the request context (ADR-EA-047); the principal strategies still take the principal the handler passes" |
| `spec/behaviors/13-events.md` (rev 1.7 → 1.8) | BEH-EA-101 envelope paragraph (`:106`) | "from `AuthRequestContext` (populated by the required `RequestContext` middleware; absent under `NoRequest` or outside a request)"; `signInFailed.clientIp` is stamped by `SignIn.failed` |
| `spec/behaviors/06-domain-users-accounts.md` (rev 1.9 → 1.10) | BEH-EA-322 (`:216` snippet, `:238`) | `signIn.issue(cleared)`; "request facts come from `AuthRequestContext` only"; `SignIn.failed` |
| `spec/behaviors/25-testing-harness.md` (rev 1.4 → 1.5) | BEH-EA-193, 197, 331, 333, **new BEH-EA-RC3** "`TestAuth` sets the request context" | `withRequest`, `withoutRequest`, `clientAddress`, `app({ request })`, `signInAs({ request })`; `TestAuth` no longer silences a warning |
| `spec/behaviors/27-admin-impersonation.md` (rev 1.4 → 1.5) | BEH-EA-209 (`:22` `IssueInput`) | no `request`; an impersonation session records the administrator's request facts (Q5) |
| `spec/behaviors/15-password.md` (1.5 → 1.6), `32-magic-link.md` (1.2 → 1.3), `33-email-otp.md` (1.2 → 1.3), `37-device-authorization.md` (1.3 → 1.4), and the oauth, passkey, saml, two-factor entries whose snippets show `ip`/`userAgent` | signature snippets (`32:41`, `:66`; `33:45`, `:67`; `37:20`, `:51`, `:82`, `:103-104`; `15:31`) | drop `ip`, `{ userAgent }`; one sentence: "the address and user agent come from the request context" |

### 6.2 ADR-EA-047 (draft text)

```markdown
# ADR-EA-047: Request Facts Are Read From `AuthRequestContext`

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-047 |
> | Revision | 1.0 |
> | Effective Date | <date of ticket 25> |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (<date>): Initial release (architecture plan 26) |

---

## Context

Two facts about the request a piece of work answers matter to awthaq: the client address (forensics, the device list,
per-source rate limits, the credential-stuffing signal) and the user agent (the device list, forensics). Until this
decision they travelled two ways. A global router middleware, `RequestContext.layer`, filled `AuthRequestContext` (a
`Context.Reference` defaulting to "nothing") for event envelopes and audit rows; it was opt-in (architecture plan 01,
decision 7), and `AuthHttp.coreHandlers` warned at build time when it was missing. Separately, ten plugin classes
resolved the address and read the user agent in their own handlers and threaded both, as optional `ip`/`userAgent`
fields on 29 interface members, into `SignIn`, `SignUp`, `Sessions.issue` and the `ip` rate-limit strategy. Each
consumer read one of the two: sessions and rate limits the explicit fields, events the context. The warning said
sessions would record nothing without the middleware, which was false for sessions and true for events. Because `ip`
was optional everywhere, a caller that forgot it compiled and landed in the one shared `ip:unknown` bucket. Admin
impersonation recorded nothing in any composition.

## Decision

1. **One source.** `AuthRequestContext` lives in `@awthaq/api` beside `CurrentPrincipal`. It is a required
   `Context.Service` with no default, whose value is `Request { correlationId, ip, userAgent }` or `NoRequest`. Request
   facts are read from it and nowhere else; no public interface takes an address or a user agent.
2. **One populator, required by the type.** The endpoint middleware `Api.RequestContext` (`provides:
   AuthRequestContext`) is declared outermost on every awthaq group; `@awthaq/server`'s `RequestContextLive` implements
   it (the only reader of `ClientAddress`, `x-request-id`/`traceparent` and `User-Agent`), and `AuthHttp.middlewareFor`
   derives it. Serving a group without it does not compile: the middleware is an unmet requirement, a forgotten
   declaration leaves an unsatisfiable `HttpRouter.Request<"Requires", AuthRequestContext>`, and the four
   authentication middlewares `require` the context, so declaring it inside them is an error.
3. **Required readers.** `Sessions.issue`, `SignIn` (`clear`, `resume`, `issue`, `complete`, `failed`),
   `SignUp.createSignedIn`, the `ip` rate-limit strategy (through the budget's typed handle), `VerificationLink`'s source
   budget and credential claims name `AuthRequestContext` in their requirements. A plugin operation that records or keys
   on the request says so in its type.
4. **Optional readers.** Event envelopes, audit rows and observe taps deferred to commit read it when present; publishing
   from a job needs nothing. qadi's Path B extractor, whose external interface cannot carry a requirement, reads it when
   present and otherwise captures it with the same function.
5. **Explicit absence.** In-process work states `AuthRequestContext.noRequest`. Under it a session records no address or
   user agent, the `ip` strategy does not apply (the identity and principal rules still do), and events carry no request
   facts. A request whose address cannot be resolved keys the shared `ip:unknown` bucket.
6. **One cap, one publisher.** The user agent is capped at 512 characters by the only constructor of the branded
   `UserAgentHeader`, so sessions, events, audit rows and webhooks agree. `auth.user.signInFailed` is published only by
   `SignIn.failed`, which takes `clientIp` from the context.

## Consequences

**Positive.** A composition that serves awthaq's routes cannot forget the request context; the warning and its router
registry are gone. Plugins know nothing about addresses, proxies or headers; the topology choice (`ClientAddress`) has
one consumer. A forgotten address is a compile error, not a shared bucket. Impersonation sessions record the
administrator's facts. The audit trail gets the same capped user agent as the session row.

**Negative.** Every awthaq group carries one more middleware declaration, and a host's own group that uses an
authentication middleware must declare `Api.RequestContext` after it. In-process callers of plugin operations (tests,
jobs, a host route outside awthaq's contracts) must provide the context explicitly; a host route does so with
`RequestContext.capture(request)`. Providing a fixed `AuthRequestContext` as a layer would silence the compiler and stamp
one value on every request; it is documented as wrong and forbidden in library source by a seam test.

**Trade-off accepted.** One required per-request value threaded by the type system, in exchange for the removal of the
opt-in path, the explicit path and their disagreement.

## Alternatives considered

- **Keep the middleware opt-in, keep the explicit fields, keep the warning** (architecture plan 01, decision 7).
  Rejected: two sources that disagree, a warning about the wrong consumer, and an optional `ip` the compiler cannot
  enforce.
- **A global router middleware that `provides` the context** (`HttpRouter.middleware<{ provides }>()`). It also makes
  handler requirements visible, but only `Layer.provide(app, middleware)` satisfies the `Request<"Requires">` marker, so
  the established host idiom (`Layer.mergeAll(BodyLimit.layer, RequestContext.layer)` over the app) would silently stop
  satisfying it, and it has no place in the declared contract that `middlewareFor`, `doctor` and contract tests can read.
- **Core installs a route-scoped provider inside `AuthPlugin.layer`.** No host step at all, but it couples core's plugin
  substrate to the HTTP router and to `ClientAddress`, and leaves host-declared groups and core's own groups to a second
  mechanism.
- **Keep `AuthRequestContext` a `Context.Reference` and check at run time.** A default that means "nothing" is exactly
  what made the middleware forgettable.
- **Make `ip` required on the plugin interfaces instead.** Enforces presence, but keeps two sources, ten copies of the
  resolution and the plugins' knowledge of HTTP.

## Related

ADR-EA-010 (plugins require ports; plugins no longer require `ClientAddress`), ADR-EA-012 (the context is neither a
slot nor a registry), ADR-EA-032 (the correlation id field), ADR-EA-037 (deferred observe taps see the captured
context), ADR-EA-038 (`SignIn.issue` mints from a clearance; it now reads the context), ADR-EA-042 (credential
resolution; claims receive the context). Supersedes architecture plan 01's decision 7. BEH-EA-RC1/RC2/RC3, BEH-EA-108,
BEH-EA-054, BEH-EA-101, BEH-EA-322.
```

### 6.3 Other ADR touchpoints

No existing ADR is contradicted. ADR-EA-010, 012, 037, 038 and 042 get one "Related" sentence each and a revision bump
(ticket 25). Plan 01's decision 7 is a plan decision, not an ADR: ADR-EA-047 supersedes it by name, and this plan's
"Decisions taken" says so; `.planning/01-sign-in-sign-up/PLAN.md` is not edited (the brief forbids editing other plans).

### 6.4 Traceability (`spec/traceability.md`)

Add rows for `api/test/RequestContext.test.ts`, `server/test/RequestContext.types.test.ts`,
`core/test/RequestContextSeams.test.ts`, `test/test/TestAuthRequest.types.test.ts` and each plugin probe; rewrite the
rows of `server/test/RequestContext.test.ts`, `core/test/SignIn.test.ts` (`:194`'s "request facts come from
`AuthRequestContext` with a per-field override"), `core/test/RateLimitKey.test.ts`, `core/test/Sessions.test.ts`;
delete the row of `server/test/RequestContextWarning.test.ts` (`:230`) and of `password/test/PasswordSessionContext.test.ts`.

### 6.5 BDD (`features/`)

- `features/features/03-http-layer/` or `09-authentication-middleware` feature (wherever BEH-EA-065's scenarios live):
  **BEH-EA-RC1** scenarios: "every event one request raises shares one correlation id" (two events from one sign-in);
  "a session minted over HTTP records the client's address and user agent" (with a trusted-proxy address);
  "a composition that serves awthaq's routes without the request-context middleware does not compile" (a
  `CompileTimeGates.ts` type-gate, the existing convention, `CompileTimeGates.ts:1-10`).
- `features/features/02-domain/07-sessions.feature`: **BEH-EA-RC2** "a session minted by in-process work with no request
  records no address".
- `features/features/04-cross-cutting/14-rate-limiting.feature`: REQ-EA-290's `ip` row ("the request's network origin",
  `:116-127`) is now literally what the step drives (through `withRequest`/a served request, not an `{ ip }` argument);
  new scenario "work that answers no request is not throttled per source, and is still throttled per identity".
- Step definitions touched: `RateLimitingWorld.ts`, `SessionWorld.ts`, `PasswordWorld.ts`, `DeviceAuthorizationSteps.ts`,
  `MagicLinkSupport.ts`, `SessionServer.ts`, `CompileTimeGates.ts`.
- New REQ ids: the next free numbers at write time; `pnpm spec:verify:strict` must pass.

### 6.6 Docs and READMEs

`packages/server/README.md` (request-context section), `docs/plugin-authoring.md` (`:79-90`, `:195`, new "Request facts"
section), `packages/ports/README.md` and `ports/src/ClientAddress.ts` header, plugin READMEs that mention `ClientAddress`,
`packages/qadi/src/RequestDecisionCache.ts:17-30` (declare it last *before* `Api.RequestContext`), `README.md` and
`docs/migrations/*` wherever they show `RequestContext.layer`.

### 6.7 Glossary (`spec/glossary.md`)

- **Request context.** The facts of the HTTP request a piece of work answers (correlation id, client address, user
  agent), captured once by the `RequestContext` middleware and read from `AuthRequestContext`. See ADR-EA-047.
- **No request.** The request context of in-process work (a CLI command, a job, a test), stated explicitly with
  `AuthRequestContext.noRequest`. See BEH-EA-RC2.

### 6.8 Changesets (ADR-EA-034; every package is in the fixed group)

| # | Ticket(s) | Packages | Content and `Migration:` |
|---|---|---|---|
| C1 | 04–05 | `@awthaq/api` minor, `@awthaq/core` minor, `@awthaq/server` patch | `AuthRequestContext` moves to `@awthaq/api` and becomes a tagged value; the audit user agent is capped. **Migration:** import `Api.AuthRequestContext` from `@awthaq/api` (the `AuthRequestContext` namespace of `@awthaq/core` is gone); `AuthRequestContext.none` → `Api.AuthRequestContext.noRequest`; a value you provide is `Api.AuthRequestContext.request({ correlationId, ip?, userAgent? })` |
| C2 | 06–08 | `@awthaq/api` minor, `@awthaq/server` minor, every package with a contract minor, `@awthaq/qadi` minor, `@awthaq/test` minor | every group declares `Api.RequestContext`; `middlewareFor` derives it; the four authentication middlewares require the context; credential claims receive it. **Migration:** delete `RequestContext.layer` from your server layer (`middlewareFor` now provides the request context, and it needs a `ClientAddress` layer: `ClientAddress.layerDirect` keeps the old socket-peer behaviour); if you build host middleware by hand, provide `RequestContext.RequestContextLive`; on your own `HttpApi` groups that declare `Api.Authentication`, `MachineAuthentication`, `AdminAuthentication` or `OptionalAuthentication`, add `.middleware(Api.RequestContext)` after the last middleware; `RequestContext.warnWhenAbsent` is gone (remove any provision of it); a custom credential resolver may read `Api.AuthRequestContext` |
| C3 | 09–12 | `@awthaq/core` minor, `@awthaq/admin` patch, `@awthaq/test` minor | sessions record the request context; impersonation sessions record the administrator; `SignIn.failed`; `TestAuth.withRequest`/`withoutRequest`/`clientAddress`. **Migration:** `Sessions.MAX_USER_AGENT_LENGTH` → `Api.MAX_USER_AGENT_LENGTH` |
| C4–C11 | 13–20 | one per plugin package, minor | **Migration** (per plugin, listing its members from §3.7): drop `ip`, `userAgent` and the `context` argument from calls to `<Plugin>.<member>`; the operation now requires `Api.AuthRequestContext` (provided per request by `RequestContext`; in-process callers provide `Api.AuthRequestContext.noRequest` or `RequestContext.capture(request)`); the plugin layer no longer requires `ClientAddress` |
| C12 | 22–24 | `@awthaq/core` minor, `@awthaq/server` patch, `@awthaq/test` minor, `@awthaq/cli` minor | the explicit facts are removed from core and the context is required. **Migration:** `Sessions.issue` takes no `request`; `SignIn.issue/complete` and `SignUp.createSignedIn` take no `request`, and `SignIn.SessionRequest` is gone; these and every ip-keyed `spend`/`guard`/`charge` require `Api.AuthRequestContext`; `RateLimits.Key.ip` takes no input (`spend("xByIp")`); under `noRequest` an ip rule is not applied; `RateLimits.bucketKey` no longer accepts an ip rule; `awthaq doctor` reports an endpoint without `RequestContext` outermost. BEH-EA-RC1/RC2/RC3, BEH-EA-108, ADR-EA-047 |

---

## 7. Risks, mitigations, rollback

| Risk | Likelihood | Mitigation |
|---|---|---|
| A contract group is missed in ticket 06 | medium (36 groups) | Form 2/3 compile errors for every group that reads the context; `runPluginContractTests`' new case per plugin; `doctor` in production compositions |
| Host breakage: `RequestContext.layer` removed; host groups with an authentication middleware; in-process callers | certain for some hosts | Each is a compile error with a named fix (C2, C12 `Migration:` lines); pre-1.0 policy (ADR-EA-034) |
| A host silences the compiler with a fixed `AuthRequestContext` layer | low | Documented as wrong in the ADR and the server README; library source is guarded by the seam test |
| `NoRequest` used in a host HTTP route to make it compile, skipping per-source limits there | low | `RequestContext.capture(request)` is the documented way; the docs say what `NoRequest` means; Q3 offers the conservative alternative (a shared `ip:none` bucket) |
| Web-handler deployments share `ip:unknown` (unchanged, §2.5) | already true | Documented in one place (server README, ClientAddress header); Q7 |
| Declaration emit (TS2883) in plugin layer types now naming `Api.RequestContext` / `Api.AuthRequestContext` | low | Every plugin already imports `Api`; plan 01's decision 3 and batch-2 plan 11's notes give the remedy (name the type through an existing import) |
| Effect changes middleware ordering or `ExcludeProvided` semantics | low | The type test pins the four forms against the installed effect; a regression fails `pnpm typecheck` |
| Test churn (about 80 files in Phase 5) | certain | `withoutRequest` is one pipe per test effect; ticket 01 lists the files; core and sql tests use one inline `provideService` |
| Conflicts with batch-2 plan 21 (same contract files, same `middlewareFor` table) and plan 20 (`TestAuth.app`) | high if concurrent | Whichever lands second rebases; the rules are written down (§8): `RequestContext` last, plan 20's agent untouched |
| Per-request cost | none | One capture per request, as the global middleware already did; plugins' duplicate resolutions disappear |

**Rollback.** Phases 1–3 are additive or transitional: revert per PR. Phase 4 is per plugin: a reverted plugin passes
its facts explicitly again, and core still accepts them until Phase 5. Phase 5 (tickets 22–23) is the one-way step:
revert it as one PR, which restores the explicit `request` parameters and the optional `ip` input; the contracts and the
populator (Phase 2) can stay.

---

## 8. Interactions with other plans

| Plan | Overlap | Ordering / resolution |
|---|---|---|
| **01** sign-in/sign-up (done) | decision 7 (Q1 = no) and phase 6 step 2 (drop the threading) | This plan supersedes decision 7 (ADR-EA-047) and executes phase 6 step 2 |
| **02** store seam (done) | `Sessions` is one domain module over `SessionStore` | Only the domain's `issue` changes; the port and both adapters are untouched |
| **06** rate-limit budget (done) | BEH-EA-108's deviation; `Key.ip` | Adopts plan 06's option (b) in typed form; every rule, bucket and number stays |
| **08** test composition (done) | `TestAuth.layer`, `middlewareFor` | Extends both (`HostMiddleware` gains `RequestContext`; `clientAddress`; request helpers) |
| **09**, **10** item 5 / ADR-EA-037 (done) | event envelope; deferred observe taps | Envelope semantics unchanged; the capture becomes an optional read |
| Batch-2 **11** credential resolution (done on dp2, ADR-EA-042) | `ClientAddress.facts`/`address` (built "because plan 01 Q1 keeps them explicit"); `Credentials.httpScope` claims | This plan deletes the two helpers (their premise is superseded) and passes the context through `httpScope` (ticket 08). Path B's optional read is the one exception, forced by `@qadi/http` |
| Batch-2 **15** host composition (`AuthHost`, not landed) | derives the servable layer, middleware included | If it lands first, ticket 06's derivation entry lives wherever 15 moved `middlewareFor`'s table; if after, 15 inherits it. Either way the populator is derived, never hand-wired |
| Batch-2 **18** link redeemer (done on dp2) | `LinkBudget.source(ip)`, `presented.ip`, `confirmResetByIp` | Tickets 10 and 23 change the redeemer (§3.5.4) |
| Batch-2 **20** in-process user agent (not landed) | `TestAuth.app` agents, `TestAuth.signIn(As)`; the word "user agent" | Disjoint concerns: the agent sends headers, this plan resolves them. Ticket 12's `clientAddress` option and `signInAs({ request })` are additive; whichever lands second merges `signInAs`'s two changes (configured cookie name + request facts). The header brand is named `UserAgentHeader` to keep "user agent" for plan 20's module |
| Batch-2 **21** session lifecycle markers (not landed) | the same mechanism (typed endpoint middleware derived by `middlewareFor`), the same contract files, the same `HostMiddleware` table; admin impersonation's delivery | Whichever lands second rebases. Rule: `Api.RequestContext` is declared **after** the lifecycle markers (outermost), so a marker's delivery and the handler's mint run inside the context. 21's grants and this plan's context are independent `provides` |
| Batch-2 **12**, **13**, **14**, **16**, **17**, **19**, **22**, **23**, **24** | file overlap only (`Passkey.ts`, `Admin*.ts`, `OAuth.ts`/`Saml.ts`, `Sessions.ts` sealing/verdict) | Re-locate by symbol; no semantic overlap |
| **25** record-store-contract | none | Independent |
| **27** password-credential | `Password.ts`; the new credential module's interface | Ticket 13 lands **before** plan 27 starts, so 27's module is born without `ip`/`userAgent`. If 27 starts first, it must not add request facts to its interface (it reads the context if it needs one) |
| **28** sql-store-adapters | `SessionStoreSql` row mapping; SQL test suites that issue sessions | No code overlap; after Phase 5 its suites provide a context (one line per suite) |
| **29** plugin-owned-events | `auth.user.signInFailed` | After this plan the event has one publisher, core's `SignIn.failed`, so it stays a core definition. Whether to drop its `clientIp` in favour of the envelope's `ip` is 29's call (Q6). Land 26 before 29 |
| **30** speculative follow-ups (core sealed columns) | `sessions.ipAddress`/`userAgent` sealing | Disjoint (this plan changes what is written, not how it is stored) |

---

## 9. Acceptance checklist

- [ ] `packages/api/src/Api.ts` exports `AuthRequestContext` (with `noRequest`, `request`), `RequestFacts`, `NoRequest`,
      `UserAgentHeader`, `toUserAgentHeader`, `MAX_USER_AGENT_LENGTH`, `RequestContext`; the four authentication
      middlewares declare `requires: AuthRequestContext`.
- [ ] `packages/core/src/AuthRequestContext.ts` does not exist; `grep -rn "AuthRequestContext" packages/*/src | grep -v "Api\.AuthRequestContext\|api/src/Api.ts"` is empty.
- [ ] `grep -rn "warnWhenAbsent\|isInstalledOn\|requestContextCheck\|RequestContext\.layer" packages examples features docs --include=*.ts --include=*.md` is empty.
- [ ] Every group of every shipped contract has `RequestContext` as its last middleware (`runPluginContractTests` case passes for every plugin; `api/test/Contracts.test.ts` expects it).
- [ ] `server/test/RequestContext.types.test.ts` passes, with the four §3.4 forms and their negative controls.
- [ ] `core/test/RequestContextSeams.test.ts` passes with its counted allowlist; §5.4's targets hold (re-run §2.1).
- [ ] `grep -rnE "readonly request\?:|SessionRequest" packages/core/src` is empty; `Sessions.issue`, `SignIn.*`, `SignUp.createSignedIn` require `Api.AuthRequestContext` (type tests).
- [ ] `RateLimits.Key.ip` has no input field; an ip-rule spend requires the context; `NoRequest` skips it and keeps the identity rule; `Request { ip: None }` keys `ip:unknown` (tests in `RateLimitBudget.test.ts`).
- [ ] `grep -rn "_tag: \"auth.user.signInFailed\"" packages/*/src` hits only `core/src/internal/signInSteps.ts`.
- [ ] A 600-character user agent is stored as 512 on the session row and the audit row (tests in `Sessions.test.ts`, `AuthEvents.test.ts`).
- [ ] Admin impersonation sessions record the administrator's address and user agent (admin probe).
- [ ] One HTTP probe per migrated plugin passes (8 packages).
- [ ] `TestAuth.withRequest`, `withoutRequest`, `layer({ clientAddress })`, `app({ request })`, `signInAs({ request })` exist and are tested.
- [ ] The composed OpenAPI document of `examples/memory-server` equals ticket 01's snapshot; `@awthaq/client`, `react`, `web`, `next` suites pass unchanged.
- [ ] `awthaq doctor` reports an endpoint without `RequestContext` outermost (CLI test).
- [ ] `server/test/RequestContextWarning.test.ts` and `password/test/PasswordSessionContext.test.ts` are deleted.
- [ ] ADR-EA-047 exists and is indexed; BEH-EA-RC1/RC2/RC3 exist (renumbered); BEH-EA-049/054/065/066/068/071/101/108/193/197/209/322/331/333 and the plugin snippets are updated with Document Control bumps; glossary entries added; `pnpm spec:verify:strict` passes.
- [ ] `spec/traceability.md` and `features/traceability.md` are updated; the new scenarios pass in `pnpm test:bdd`.
- [ ] Changesets C1–C12 exist with `Migration:` lines.
- [ ] `pnpm check` and `pnpm test:pg` are green on the final commit.

---

## 10. Open questions (only the user can answer)

1. **Reverse plan 01's decision 7: make the request context required, through the type?** Recommended: **yes**. The
   populator rides `middlewareFor`, which every example and `TestAuth` already call, so the host cost is one deleted line;
   the warning it replaces describes the wrong consumer. The alternative keeps the opt-in and limits this plan to removing
   the plugin threading, which then cannot be enforced.
2. **Make `ClientAddress` a required dependency of the populator** (today optional, falling back to the socket peer)?
   Recommended: **yes**. Once plugins stop requiring it, the populator is its only consumer, and "which proxy hops do I
   trust" should be a stated choice; `ClientAddress.layerDirect` restores today's behaviour in one line. Alternative: keep
   the optional read and the silent fallback.
3. **Under `NoRequest`, an ip-keyed rule:** (a, recommended) is **not applied**: there is no network source, and the
   identity/principal rules still apply; (b) keys one shared `ip:none` bucket, so in-process callers throttle each other
   (today's `ip:unknown` behaviour, a lockout lever for host jobs).
4. **Which middlewares `require` the context?** (a, recommended) all four authentication middlewares, with one widened
   credential-claim requirement: every awthaq group gets a compile-checked order, and a host's own authenticated group must
   declare `Api.RequestContext` (one line); (b) only `MachineAuthentication`, with a carrier-indexed claim type: fewer
   host edits, more type machinery, and no ordering check on user-tier groups.
5. **Impersonation sessions record the administrator's address and user agent** (new behaviour; today they record
   nothing)? Recommended: **yes** (forensics; the audit envelope already carries them). The session list exposes only the
   user agent, never the address. Alternative: provide `noRequest` around `Admin.impersonate`'s mint.
6. **`auth.user.signInFailed.clientIp`:** (a, recommended) keep the field, stamped by `SignIn.failed` from the context
   (no stored-event or webhook change); (b) drop it and key the stuffing signal on the envelope's `ip` (a stored-schema and
   webhook `data` change; better done in plan 29).
7. **A request whose address cannot be resolved** (every web-handler deployment under `layerDirect`): (a, recommended)
   keep the shared `ip:unknown` bucket and document the web-handler caveat in the server README and the `ClientAddress`
   header; (b) refuse ip-keyed endpoints with 503 until a topology is configured; (c) skip the rule. (b) is safest but
   breaks every zero-config Next.js host; (c) is unthrottled per source.
8. **A composed group without `Api.RequestContext`** (a host's `extraGroups` or a third-party plugin that reads nothing):
   (a, recommended) `awthaq doctor` warns; (b) `middlewareFor` refuses the composition at layer build.
9. **Correlation for host routes outside awthaq's contracts** (the global middleware annotated their logs too): (a,
   recommended) accept the loss; a host uses `RequestContext.capture` or declares `Api.RequestContext` on its own groups,
   and Effect's `HttpMiddleware.tracer`/`logger` (`AuthHttp.tracer`/`requestLogger`) give request-level correlation;
   (b) keep a thin, annotate-only global middleware beside the endpoint one.

---

## Decisions taken (implementation record)

