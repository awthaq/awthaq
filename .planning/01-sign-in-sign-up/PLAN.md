# Plan 01: One sign-in completion module and one sign-up module in core

> **Cross-plan reconciliation (orchestrator):** plan 03 lands first and adds `Users.createWith` (abandon-on-failure creation). This plan's `SignUp.createWith` is built on that primitive, and SCIM provisioning moves from it to `SignUp` here. ADR number reserved: ADR-EA-038. See `.planning/README.md`.


| | |
|---|---|
| Strength | Strong |
| Dependency category | in-process |
| Wave | B (after 03, 06 and plan 10's items 1-2; before 07 and 02) |
| Fixes live bugs | SAML + second factor loses `fed`, its Single Logout record, its role mapping and its tenant · ADR-EA-028 `orDie` left on sign-up and `changePassword` · SCIM skips `BeforeSignUp` and `auth.user.created` · a vetoed SCIM rollback strands a half-provisioned user · `auth.user.signInFailed{suspended}` only from password · password sign-up mints a session without the sign-in veto/divert |
| Tickets | `.scratch/sign-in-sign-up/issues/NN-*.md`, one per phase step below (see `docs/agents/issue-tracker.md`) |

Vocabulary: **module, interface, implementation, depth, seam, adapter, leverage, locality** (codebase-design glossary). Domain terms follow `spec/glossary.md` and `spec/overview.md`.

---

## 1. Summary

Eight flows turn a proven credential into a session, and six flows create a user. Each one writes the same steps by hand, and the copies have drifted. The sign-in steps are: look up the user, run the suspension gate, run the `BeforeSignIn` veto, run the `BeforeSessionIssue` divert, issue the session, publish `auth.user.signedIn`, run `AfterSignIn`. The sign-up steps are: run the `BeforeSignUp` veto, then create, verify and link in one transaction, then publish `auth.user.created` and run `AfterSignUp`. Every bug in the header comes from one copy differing from the others.

This plan moves both sequences into two **deep modules** in `@awthaq/core` (stratum 4, Domain):

- **`SignIn`**: `clear(attempt)` returns a branded `SignIn.Clearance`. That covers the user lookup, the gate, the suspended event, the veto and the divert. `issue(clearance)` mints the session, runs any continuation the first factor registered, publishes the event and runs `AfterSignIn`. `complete = clear + issue`. `resume(attempt)` is for the one plugin that finished a divert (two-factor). The `amr` the divert sees and the `amr` the session records come from the same field of the clearance, so they cannot disagree.
- **`SignUp`**: `vet(application)` returns a branded `SignUp.Vetted`. `create`, `createWith` and `createSignedIn` own the transaction, the compensation, the single `IdentityTaken` error and the after-commit announcements.

After this plan, a plugin calls a small **interface** with a lot behind it. Each policy (missing user, suspended event, `amr`, tenant, request context, typed outages) is decided in one place. The **seam** is checked by the compiler (brands) and by one static test: no plugin may call `Sessions.issue` or `Users.create` directly.

### Goals

1. One implementation of sign-in completion, used by password, passkey, OAuth, SAML, device authorization, magic link, email OTP and two-factor.
2. One implementation of user creation, used by password (reveal and conceal), OAuth, SAML, magic link/email OTP and **SCIM**.
3. The compiler enforces that a session for a proven credential needs a clearance (`issue` accepts only a `Clearance`), and that a user can only be created after a vetted application (`create*` accepts only `Vetted`).
4. Uniform policies, decided once (section 3.6): a missing user, the suspended event, the sign-up session, the `amr` hand-off, tenant continuity across a divert, request context, and `StoreUnavailable`.
5. Fix the SAML + second-factor gap that plan 10 hands over: the Single Logout record (BEH-EA-315), role mapping (BEH-EA-316) and the session's tenant after `finalizeSignIn`. Do it with a typed **continuation** that crosses the divert.
6. Replace about 1,300 lines of per-plugin hook tests with tests at the two interfaces, plus one small "wiring probe" assertion per plugin.
7. Make the spec true. BEH-EA-093's "shared finalisation step" becomes a real module, and ADR-EA-033 Decision 5's "every user-creating path consults `BeforeSignUp`" becomes true, with named exemptions.

### Non-goals

- Rate limiting and the sign-in preamble (plan 06 owns it; this plan assumes it has landed).
- The credential checks themselves: password hashing and timing floor, WebAuthn verification, OAuth token exchange, SAML assertion validation, device polling throttle, token consumption (plan 07 owns `Verification.redeem`).
- Account linking that does not create a user (OAuth `flow.link`, OAuth/SAML auto-link to an existing verified account). These stay in their plugins. They are not sign-ups.
- Non-sign-in session minting: `changePassword` rotation, admin impersonation, `TestAuth`. These keep calling `Sessions.issue` directly and are allow-listed by name. This plan only removes their `orDie`.
- Operator imports: `UserImport.importUser` and `awthaq seed admin`. Decision 3.6.4 records them as exempt from `SignUp`.
- Changing what `auth.user.created` / `auth.user.signedIn` carry. Their schemas are untouched (plan 09 owns event metadata).
- The `UnitOfWork` after-commit buffer (plan 10 item 5). This plan publishes after commit explicitly, so it is correct with or without that buffer.

---

## 2. Verified current state

Every line below was re-read on 2026-10-13 against `main` (`38bcd1b`). Paths are relative to `packages/`.

### 2.1 Sign-in completion: eight hand-written copies

| Site | Lookup / missing user | Gate + suspended event | `BeforeSignIn` veto | `BeforeSessionIssue` divert (`amr`) | Issue (`amr`, outage) | After |
|---|---|---|---|---|---|---|
| `password/src/Password.ts:1186-1254` (`signIn`) | user from `findByEmail` (`:1152`) | `:1203-1211` gate **+ `signInFailed{suspended}`** (the only plugin that publishes it) | `:1223-1230`, hand-rolled `Option.isSome(emailOf) ? {email}` | `:1237-1244`, `["pwd"]` | `:1245-1247` `["pwd"]`, **`orDie`** | `:1248-1253` |
| `passkey/src/Passkey.ts:1624-1672` (`authenticateCeremony`) | `:1624-1626` `UserNotFound` → `Api.InvalidCredentials` | `:1630`, no event | `:1633-1640`, hand-rolled | `:1645-1653`, `passkeyAmr(verified)` | `:1654-1665` same const, **`orDie`** | `:1666-1671` |
| `oauth/src/OAuth.ts:1352-1395` (`callbackFlow`) | `:1354-1356` **`orDie`** (outage and missing user both become defects) | `:1356`, no event | `:1358-1365`, hand-rolled | `:1370-1377`, `["fed"]` | `:1380-1389` `["fed"]`, **`orDie`** | `:1390-1395` |
| `saml/src/Saml.ts:1024-1064` (`signIn`) | `:1025-1027` **`orDie`** | `:1027`, no event | `:1028-1035`, hand-rolled | **`:1036` no `amr`** | `:1039-1046` `["fed"]` (typed) | role mapping `:1038` before issue; `saveSession` + prune `:1048-1057`; event `:1058-1063` |
| `device-authorization/src/DeviceAuthorization.ts:1140-1175` (`poll`) | `:1142-1150` `UserNotFound` → remove grant + `InvalidGrant` | `:1151`, no event | `:1152-1154`, `Users.emailField` | `:1157-1161` `grant.amr`; divert → remove grant + `AccessDenied` | atomic `consume` `:1163-1164` **between divert and issue**; issue `:1165-1172` `claimed.value.amr` | `:1173-1174` |
| `magic-link/src/Channel.ts:152-195` (`complete`, shared by magic link and email OTP) | `resolveUser` `:100-107` falls back to the address; `verifyEmail` `UserNotFound` → `ChannelInvalid{userMissing}` `:156-161` | `:163`, no event | `:165-171`, `Users.emailField` | `:174-179`, `completion.amr` | `:180-187` (typed) | `:188-193` |
| `two-factor/src/TwoFactor.ts:522-549` (`finalizeSignIn`) | `:526-532` `UserNotFound` → `InvalidTwoFactorCode` | `:533` re-check, no event | none (correct: it ran at the first factor) | none (correct) | `:534-541` `unionAmr(challenge.amr, ["otp","mfa"])` | `:542-547` |
| `password/src/Password.ts:1030-1060` (`signUp`, reveal) | — | **none** | **none** | **none** | `:1054-1056` inside the sign-up transaction, `["pwd"]`, **`orDie`** | **no `auth.user.signedIn`, no `AfterSignIn`** |

The divert tap `two-factor/src/TwoFactor.ts:174-200` stores whatever `amr` it is given (`:191`). It skips the divert when `amr` contains `mfa` (`:185`), and its `bypassStrategies` check is an exact-string `includes` (`:181`).

### 2.2 How the copies diverge (the bugs)

| # | Divergence | Evidence | Consequence |
|---|---|---|---|
| D1 | SAML divert has no `amr` | `Saml.ts:1036` vs `:1045`; `Hooks.ts:102-106` makes `amr` `optionalKey`, so the omission type-checks | After 2FA the session records `["otp","mfa"]` and loses `fed` (plan 10 item 1 hotfixes the literal) |
| D2 | **SAML + 2FA loses its continuation** | on `Diverted`, `Saml.ts:1037` returns before `applyRoleMapping` (`:1038`), `saveSession` (`:1048-1054`) and `pruneSessions`; `finalizeSignIn` knows nothing about SAML | A 2FA-completed SAML session has no `saml_session` row, so IdP Single Logout cannot end it (BEH-EA-315), and it is never role-mapped (BEH-EA-316). Plan 10 hands this to plan 01 as a must-fix |
| D3 | **Tenant is lost across the divert** (new finding) | SAML runs `signIn` under `Tenant.withTenant(org)` when `tenantScoped` (`Saml.ts:1093-1096`); `Sessions.issue` stamps `tenantId` from the ambient `TenantContext` (`core/src/Sessions.ts:732`); `/two-factor/verify` runs in whatever tenant its own request has | A tenant-scoped SAML session completed by 2FA is stamped with the wrong (usually absent) tenant |
| D4 | `signInFailed{suspended}` only from password | `Password.ts:1203-1210`; no other site publishes it; `AuthEventSchemas.ts:63-64` defines the reason for "the credential was right but `assertCanSignIn` refused" | A stuffing or abuse detector sees suspended-account hits from one strategy in eight |
| D5 | Missing-user handling: five different answers | passkey `InvalidCredentials`; OAuth/SAML defect (`orDie`); device remove + `InvalidGrant`; channel `ChannelInvalid`; two-factor `InvalidTwoFactorCode` | OAuth/SAML answer 500 to a race with erasure, which is legitimate (an erasure can run between proof and issue) |
| D6 | ADR-EA-028 `orDie` | `sessions.issue` `Password.ts:1056, 1247, 1677`, `Passkey.ts:1665`, `OAuth.ts:1389`, `admin/src/Admin.ts:1106`; `findById` `OAuth.ts:1356`, `Saml.ts:1027`; sign-up `accounts.link` `Password.ts:1053, 1107`, `OAuth.ts:1232`; `verifyEmail` `OAuth.ts:1315`; `catchTag("SqlError", Effect.die)` `Password.ts:1060, 1114`, `OAuth.ts:1335`, `Saml.ts:1013` | An outage answers 500 instead of 503. Plan 10 item 2 fixes the sign-in sites. Sign-up, `changePassword` and `Admin` are left to this plan |
| D7 | Email spread hand-rolled | `Password.ts:1223-1228`, `Passkey.ts:1633-1638`, `OAuth.ts:1358-1363`, `Saml.ts:1028-1033` vs `Users.emailField` (`core/src/Users.ts:141-144`) used by device and channel | Cosmetic, but four more places to drift |
| D8 | Password sign-up is not a sign-in | `Password.ts:1054-1056` issues inside the sign-up transaction with no gate, veto or divert, and no `signedIn`/`AfterSignIn`. OAuth, SAML and channel sign-ups run the full sign-in after creating the user | A risk-based divert tap or a `BeforeSignIn` policy does not apply to the first session of a password account. `auth.session.issued` is published before the outer transaction commits |
| D9 | `SessionDelivery.mode` must precede minting | `Password.ts:494, 522, 639`, `Passkey.ts:708`, `MagicLink.ts:207`, `TwoFactor.ts:302` | Ordering is owned by each handler (MNA-001). Only two-factor wraps it in a helper (`complete`, `TwoFactor.ts:295-315`) |
| D10 | Request context is threaded by hand | `clientAddress.resolve(request)`: Password ×7 (`:495, 527, 548, 562, 584, 598, 640`), `Saml.ts` ×5, `OAuth.ts` ×3 (`:499, 542, 601`), `Passkey.ts` ×2 (`:693, 709`); `sessionRequest` helper `Password.ts:451-454`; `userAgent` fields on every Shape | Duplication. See correction E1: the "already filled per request" premise is only half true |

### 2.3 Sign-up: six user-creating paths, five hand-written

| Site | Veto | Transaction | Conflict handling | Announce |
|---|---|---|---|---|
| `Password.ts:986-1018, 1020-1075` (reveal) | `:1009-1011` **before the hash** | `:1030-1060` create + link (`orDie`) + issue (`orDie`); `SqlError` dies | `EmailAlreadyExists` → `PasswordApi.EmailAlreadyExists`; phone → die | `:1061-1066` after commit |
| `Password.ts:1077-1139` (conceal, ADR-EA-026) | shared `prepareSignUp` | `:1084-1115` create + link | duplicate → `Option.none()` → `account-exists` mail | `:1116-1124` only when created |
| `OAuth.ts:1236-1342` (silent first-login) | `:1252-1258` strategy = provider id | `:1259-1335` create (Anonymous when no email) + `verifyEmail` for a trusted provider (`orDie`) + link | `EmailAlreadyExists` → look up the winner → `AccountExists{providers}` | `:1336-1341`, then the common sign-in |
| `Saml.ts:977-1021` | `:978-984` strategy `saml:<org>:<conn>` (`Saml.ts:89-90`) | `:985-1013` create + link | `EmailAlreadyExists` → `AssertionInvalid{emailInUse}` | `:1014-1019` |
| `magic-link/src/Channel.ts:117-148` | `:119-121` | **none** (single write, no link) | `EmailAlreadyExists` → use the concurrent winner (`fresh: false`) | `:141-148` only when fresh |
| `scim/src/Scim.ts:709-797` (`createUser`) | **none** | **none**; compensating `rollBack` `:740-743` = `records.unlink` + **`users.delete`** | `EmailAlreadyExists` → 409 | **no `auth.user.created`, no `AfterSignUp`**; only `auth.scim.userProvisioned` `:791-796` |
| `core/src/UserImport.ts:100` (`createOrGet`) | none | yes | idempotent | none (operator import) |
| `cli/src/Seed.ts:101` | none | no | `UsageError` | `auth.admin.seed*` (operator) |

Two more SCIM facts:

- `rollBack` calls `users.delete`, which runs the `BeforeUserDelete` veto (`core/src/Users.ts:332-340`), and wraps it in `Effect.catch(() => Effect.void)` (`Scim.ts:742`). **A vetoing tap (a legal hold) silently strands a half-provisioned user**, which breaks BEH-EA-247 ("leave neither user nor mapping behind").
- `Scim.ts:717-718` builds the identity with `"Anonymous" as const` / `"Email" as const`. That is a const assertion, which `.oxlintrc.json` allows, but `SignUp`'s typed input removes the need for it.

### 2.4 Spec and docs that state otherwise

- `spec/behaviors/12-hooks.md:51` (BEH-EA-090 "As shipped"): sign-up veto covers "password sign-up and the OAuth first-login creation"; sign-in veto covers "password, OAuth, passkey". It omits SAML, magic link, email OTP, device and SCIM.
- `spec/behaviors/12-hooks.md:109` (BEH-EA-093 "As shipped"): says `Hooks.BeforeSignIn` returns `TwoFactorRequired { challenge }`, and names a "shared finalisation step". The divert is `BeforeSessionIssue` (`core/src/Hooks.ts:109`), the payload is `{ userId, challengeId }`, and no shared step exists.
- `spec/decisions/033-hook-registries-per-composition.md:27` (Decision 5): "every user-creating path consults `BeforeSignUp`". SCIM, `UserImport` and seed do not.
- `spec/behaviors/06-domain-users-accounts.md:143` and `core/src/Users.ts:220-230`: the gate is called by "password, passkey, oauth".
- `core/src/AuthEventSchemas.ts:41, 45`: name only password/OAuth (/passkey) as publishers.
- `spec/behaviors/15-password.md:17-27` (BEH-EA-113) and `features/.../15-password.feature` `@REQ-EA-304`, `@REQ-EA-692`: password sign-up MUST create user and session in one transaction, and a failure issuing the session leaves no user. **This plan keeps that guarantee** (`SignUp.createSignedIn`).

### 2.5 Test duplication

| File | Lines | What it re-tests |
|---|---:|---|
| `password/test/PasswordHooksBeforeSignIn.test.ts` | 159 | veto denies sign-in; `AfterSignUp` observes |
| `password/test/PasswordHooksSignIn.test.ts` | 169 | divert → `TwoFactorRequired`; `AfterSignIn` |
| `password/test/PasswordHooksSignUp.test.ts` | 120 | `BeforeSignUp` reject / amend |
| `passkey/test/PasskeyHooksBeforeSignIn.test.ts` | 164 | veto (setup `:32-75` stands up the whole ceremony); plus one *strategy-specific* `signInFailed{assertionInvalid}` case |
| `passkey/test/PasskeyHooksSignIn.test.ts` | 135 | divert |
| `passkey/test/PasskeySuspended.test.ts` | 127 | gate |
| `oauth/test/OAuthHooksSignIn.test.ts` | 164 | divert on a silent sign-up |
| `oauth/test/OAuthHooksVeto.test.ts` | 265 | `BeforeSignUp` veto, `BeforeSignIn` veto, `AfterSignUp`; plus one *strategy-specific* `signInFailed{callbackRejected}` case |
| **Total** | **1,303** | (the review's "~1,180" counted the seven sign-in files: 1,183) |

Plus scattered gate/suspension cases in `magic-link/test/MagicLink.test.ts:202` and `two-factor/test/TwoFactor.test.ts`. Plan 10 item 2 adds four per-plugin `"ADR-EA-028: … outage is StoreUnavailable"` tests that this plan must move.

### 2.6 Corrections to the review's evidence

- **E1 (false premise).** "`core/src/AuthRequestContext.ts` is filled per request by `server/RequestContext.ts`". It is filled **only when the host merges `RequestContext.layer`**. That is an opt-in global middleware (`server/src/RequestContext.ts:41-71`). It is installed in `examples/memory-server/app.ts:217` only: not in `examples/sql-server/app.ts`, not in `test/src/TestAuth.ts`, not in `server/README.md`. Its default is `AuthRequestContext.none` (`core/src/AuthRequestContext.ts:25-34`). So dropping explicit `ip`/`userAgent` threading today would silently empty the session device list (CSD-003) for most compositions. Section 3.6.6 and Phase 6 handle this.
- **E2.** Password does not call `users.findById`; it signs in with the `UserRecord` from `findByEmail`. `SignIn.clear` re-reads by id. That costs one primary-key lookup on a path that already pays an argon2id verify.
- **E3.** The sign-up total is six creating paths plus two operator paths (`UserImport`, seed), not five.
- **E4.** `../effect` is **4.0.1** (where `unstable/sql` became `effect/sql`), but the repo is pinned to **`effect@4.0.0-rc.116`**. Every API below was checked in both: `Brand.nominal` (`Brand.d.ts:187`), `Effect.fnUntraced`, `Effect.onError` (`../effect/packages/effect/src/Effect.ts:7000`), `Effect.catchTag(s)`, `Effect.tapError`, `Effect.annotateCurrentSpan`, `Ref.make`, `Schema.Json` (`Schema.d.ts:10553`), and `isSqlError` (`effect/unstable/sql/SqlError` in rc.116; `effect/sql/SqlError` `:471` in 4.0.1). Use the rc.116 import paths.

---

## 3. Target design

### 3.1 Placement, shape and dependencies

| File | Exported from `@awthaq/core` as | Holds |
|---|---|---|
| `core/src/SignIn.ts` | `SignIn` | public types, `make`, `continuation(...)` |
| `core/src/SignUp.ts` | `SignUp` | public types, `make` |
| `core/src/SignInContinuationRegistry.ts` | (internal leaf; carried by `Hooks.HooksLive` like `ErasureRegistry`) | the continuation registry |
| `core/src/internal/signInSteps.ts` | **not exported** (`core/package.json` exports only `"."`) | the `Clearance` brand constructor, gate/veto/divert/mint/announce |
| `core/src/internal/discardUnannounced.ts` | **not exported** | compensation for a user that was never announced |
| `core/src/Hooks.ts` | `Hooks` (existing) | `SessionIssueContext.amr` becomes **required**; new `Handoff` schema |

**Why `make`, not a `Context.Service`.** `SignIn.make` / `SignUp.make` are `Effect`s that resolve their core services once, inside a plugin's `make`, and return closures with no further requirements. That is the same pattern as `magic-link/src/Channel.ts:89` and `core/src/MailDispatch.ts:89`. Their requirements are already in every sign-in plugin's `RIn`: `Users`, `Sessions`, `Accounts`, `AuthEvents`, the hook points, `SqlTransaction` (a port), and `SignInContinuationRegistry` (via `HooksLive`). So **no host has to wire a new layer**. A composition that forgets a requirement fails to compile, as it does today. The cost is that `SqlTransaction` joins the `ports:` declaration of plugins that did not need it (magic-link, email OTP, SCIM). PV-241's completeness check makes that a compile error until it is declared, which is intended.

**Strata.** Both modules are Domain (4). They import only core siblings and `@awthaq/ports`. Nothing in `@awthaq/server` (5) is needed. HTTP delivery ordering stays in the server stratum (Phase 6).

### 3.2 Hook schema change (`core/src/Hooks.ts`)

```ts
// The first factor's context a divert must hand back, verbatim, to `SignIn.resume`
// so the session it finally mints is the session the first factor would have minted.
export const Continuation = Schema.Struct({ kind: Schema.String, payload: Schema.Json });
export const Handoff = Schema.Struct({
  /** The ambient tenant when the first factor cleared (DRS-001); re-applied when the session is minted. */
  tenantId: Schema.optionalKey(Schema.String),
  /** Work the first factor owes once the session exists (SAML: SLO record, role mapping). */
  continuation: Schema.optionalKey(Continuation),
});
export type Handoff = typeof Handoff.Type;

const SessionIssueContext = Schema.Struct({
  userId: Schema.String,
  strategy: Schema.String,
  amr: Schema.Array(Schema.String), // was optionalKey (D1's root cause). SignIn always passes it.
  handoff: Schema.optionalKey(Handoff),
});
```

`amr` becomes required. Making it required breaks no tap: every tap reads it as `input.amr ?? []`, which still compiles. If plan 10 item 1 has not landed, SAML's literal stops compiling, which is the point.

### 3.3 `SignIn`: interface

```ts
// core/src/internal/signInSteps.ts (package-private)
import * as Brand from "effect/Brand";
import * as Data from "effect/Data";
import type * as Option from "effect/Option";
import type * as Hooks from "../Hooks.ts";
import type * as Sessions from "../Sessions.ts";
import type * as Users from "../Users.ts";

/** What a first-factor flow proved: who, by which strategy, and how (RFC 8176). */
export interface Attempt {
  readonly userId: Users.UserId;
  /** `password`, `passkey`, an OAuth provider id, `saml:<org>:<conn>`, `magicLink`, `emailOtp`, `device`. */
  readonly strategy: string;
  readonly amr: ReadonlyArray<Sessions.AuthMethod>;
  /** Built by `SignIn.continuation(...).of(payload)`; omitted by every flow but SAML today. */
  readonly continuation?: typeof Hooks.Continuation.Type;
}

/**
 * The only input `SignIn.issue` accepts. Minted by `clear` (gate, veto, divert all passed)
 * or `resume` (gate re-passed after a resolved divert). The `amr` the divert saw is this `amr`.
 */
export type Clearance = {
  readonly user: Users.UserRecord;
  readonly strategy: string;
  readonly amr: ReadonlyArray<Sessions.AuthMethod>;
  readonly tenantId: Option.Option<string>;
  readonly continuation: Option.Option<typeof Hooks.Continuation.Type>;
} & Brand.Brand<"awthaq/SignIn/Clearance">;

/** Package-private: `internal/` is outside `@awthaq/core`'s exports map, so no plugin can mint one. */
export const clearance = Brand.nominal<Clearance>();

/** The user vanished between the credential proof and the session (a concurrent erasure). Never a defect. */
export class UserGone extends Data.TaggedError("SignIn/UserGone")<{
  readonly message: string;
  readonly userId: Users.UserId;
}> {}
```

```ts
// core/src/SignIn.ts (public)
export type { Attempt, Clearance } from "./internal/signInSteps.ts";
export { UserGone } from "./internal/signInSteps.ts";

export type ClearError =
  | UserGone
  | Users.UserSuspended
  | HookPoint.HookAborted
  | Hooks.TwoFactorRequired
  | StoreUnavailable;
export type ResumeError = UserGone | Users.UserSuspended | StoreUnavailable;

/** Explicit request facts; each field falls back to `AuthRequestContext` when omitted. */
export interface SessionRequest {
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

/** The one session-with-token type; `Password`/`Passkey`/`Channel`/`TwoFactor` alias theirs to it. */
export interface IssuedSession {
  readonly session: Sessions.SessionView;
  readonly token: Redacted.Redacted<string>;
}

export interface SignInShape {
  /** Gate (+ `signInFailed{suspended}`), `BeforeSignIn`, `BeforeSessionIssue` (with this `amr` + handoff). */
  readonly clear: (attempt: Attempt) => Effect.Effect<Clearance, ClearError>;
  /**
   * For the plugin that resolved a divert (two-factor) with the handoff the divert carried: re-runs the
   * gate only, because `BeforeSignIn` and `BeforeSessionIssue` already ran for this sign-in.
   * Call sites are allow-listed by the static guard (section 3.8).
   */
  readonly resume: (
    attempt: Attempt & { readonly handoff?: Hooks.Handoff | undefined },
  ) => Effect.Effect<Clearance, ResumeError>;
  /** Mints under the clearance's tenant, runs its continuation, publishes `auth.user.signedIn`, runs `AfterSignIn`. */
  readonly issue: (
    clearance: Clearance,
    request?: SessionRequest,
  ) => Effect.Effect<IssuedSession, StoreUnavailable>;
  /** `clear` then `issue`: every flow with nothing to do between the two. */
  readonly complete: (
    attempt: Attempt,
    request?: SessionRequest,
  ) => Effect.Effect<IssuedSession, ClearError>;
}
```

Interface member types are the contract (allowed by `docs/plugin-authoring.md`, "House rules"). No `const` below carries an Effect/Layer return annotation.

### 3.4 `SignIn`: implementation sketch

```ts
// core/src/internal/signInSteps.ts (continued)
export const makeSteps = Effect.gen(function* () {
  const users = yield* Users.Users;
  const sessions = yield* Sessions.Sessions;
  const events = yield* AuthEvents.AuthEvents;
  const beforeSignIn = yield* Hooks.BeforeSignIn;
  const beforeSessionIssue = yield* Hooks.BeforeSessionIssue;
  const afterSignIn = yield* Hooks.AfterSignIn;
  const continuations = yield* SignInContinuationRegistry;

  /** Lookup + THE gate (SCP-001). A suspended refusal is announced for every strategy (policy 3.6.2). */
  const gate = Effect.fnUntraced(function* (attempt: Attempt) {
    const user = yield* users.findById(attempt.userId).pipe(
      Effect.catchTag("UserNotFound", () =>
        new UserGone({ message: "awthaq: the signing-in user no longer exists", userId: attempt.userId }),
      ),
    );
    yield* Effect.annotateCurrentSpan("user.id", user.id); // EOTS-001, once for every strategy
    yield* Users.assertCanSignIn(user).pipe(
      Effect.tapError(() =>
        Effect.flatMap(AuthRequestContext, (request) =>
          events.publish({
            _tag: "auth.user.signInFailed",
            strategy: attempt.strategy,
            reason: "suspended",
            ...(Option.isSome(request.ip) ? { clientIp: request.ip.value } : {}),
          }),
        ),
      ),
    );
    return user;
  });

  const clear = Effect.fnUntraced(function* (attempt: Attempt) {
    const user = yield* gate(attempt);
    yield* HookPoint.aborted(Hooks.BeforeSignIn)(
      beforeSignIn.run({ userId: user.id, ...Users.emailField(user), strategy: attempt.strategy }),
    );
    const tenantId = yield* Tenant.TenantContext;
    const handoff = {
      ...(Option.isSome(tenantId) ? { tenantId: tenantId.value } : {}),
      ...(attempt.continuation === undefined ? {} : { continuation: attempt.continuation }),
    };
    const point = yield* beforeSessionIssue.run({
      userId: user.id,
      strategy: attempt.strategy,
      amr: attempt.amr, // the same value `issue` records: D1 cannot recur
      handoff,
    });
    if (point._tag === "Diverted") return yield* Effect.fail(point.value);
    return clearance({
      user,
      strategy: attempt.strategy,
      amr: attempt.amr,
      tenantId,
      continuation: Option.fromUndefinedOr(attempt.continuation),
    });
  });

  const resume = Effect.fnUntraced(function* (
    attempt: Attempt & { readonly handoff?: Hooks.Handoff | undefined },
  ) {
    const user = yield* gate(attempt);
    return clearance({
      user,
      strategy: attempt.strategy,
      amr: attempt.amr,
      tenantId: Option.fromUndefinedOr(attempt.handoff?.tenantId),
      continuation: Option.fromUndefinedOr(attempt.handoff?.continuation),
    });
  });

  /** Inside or outside a transaction: the row only (plus the core-owned `auth.session.issued`). */
  const mint = (cleared: Clearance, request: SessionRequest | undefined) =>
    Effect.gen(function* () {
      const context = yield* AuthRequestContext;
      const ip = request?.ip ?? Option.getOrUndefined(context.ip);
      const userAgent = request?.userAgent ?? Option.getOrUndefined(context.userAgent);
      const issue = sessions.issue({
        userId: cleared.user.id,
        request: { ...(ip === undefined ? {} : { ip }), ...(userAgent === undefined ? {} : { userAgent }) },
        amr: cleared.amr,
      });
      // D3: a resumed sign-in is minted in the first factor's tenant, not the verify request's.
      return yield* Option.match(cleared.tenantId, {
        onNone: () => issue,
        onSome: (tenantId) => issue.pipe(Tenant.withTenant(tenantId)),
      });
    });

  /** After the session exists (and, for a sign-up, after commit). */
  const announce = Effect.fnUntraced(function* (cleared: Clearance, issued: IssuedSession) {
    if (Option.isSome(cleared.continuation)) {
      const kind = cleared.continuation.value.kind;
      const handler = (yield* continuations.contributions).find((entry) => entry.kind === kind);
      if (handler === undefined) {
        return yield* Defects.invariantViolation(
          "SignInContinuationMissing",
          `awthaq: no sign-in continuation is registered for "${kind}"`,
        );
      }
      yield* handler.run(cleared.continuation.value.payload, { user: cleared.user, session: issued.session });
    }
    yield* events.publish({ _tag: "auth.user.signedIn", userId: cleared.user.id, strategy: cleared.strategy });
    yield* afterSignIn.run({ userId: cleared.user.id, strategy: cleared.strategy });
    return issued;
  });

  return { gate, clear, resume, mint, announce };
});
```

```ts
// core/src/SignIn.ts
export const make = Effect.map(Steps.makeSteps, (steps) => {
  const issue: SignInShape["issue"] = (cleared, request) =>
    Effect.flatMap(steps.mint(cleared, request), (issued) => steps.announce(cleared, issued));
  return {
    clear: steps.clear,
    resume: steps.resume,
    issue,
    complete: (attempt, request) => Effect.flatMap(steps.clear(attempt), (cleared) => issue(cleared, request)),
  } satisfies SignInShape;
});
```

Implementation checks to make during Phase 1:

- `Option.fromUndefinedOr` is the rc.116 name. The repo already uses `Option.fromNullishOr` (`server/src/RequestContext.ts:65`) and `Option.fromNullOr` (`core/src/Sessions.ts:1241`). Use whichever exists, and do not cast.
- `AuthRequestContext` and `Tenant.TenantContext` are `Context.Reference`s, read with `yield*` (precedent `core/src/AuthEvents.ts:211`, `core/src/Sessions.ts:732`).
- If `Effect.fnUntraced` with a generic parameter fights inference for `resume`, use a plain arrow returning `Effect.gen`, as `issue` does.

### 3.5 Continuations: the SAML + second-factor fix

A **continuation** is work a first-factor flow owes once the session exists, whichever request finally mints that session. It is a registry (ADR-EA-012: contributions aggregate, they never conflict). It is built on `core/src/internal/contributionRegistry.ts`, exactly like `ErasureRegistry` (`core/src/ErasureRegistry.ts`), and carried by `Hooks.HooksLive`, so every composition already provides it.

```ts
// core/src/SignInContinuationRegistry.ts (leaf, like ErasureRegistry.ts)
export interface ContinuationContext {
  readonly user: Users.UserRecord;
  readonly session: Sessions.SessionView;
}
export interface ContinuationContribution {
  readonly id: string;   // contributing plugin id (ContributionRegistry.Contribution)
  readonly kind: string; // what `Attempt.continuation.kind` names, e.g. "saml.acs"
  readonly run: (payload: Schema.Json, context: ContinuationContext) => Effect.Effect<void, StoreUnavailable>;
}
export class SignInContinuationRegistry extends Context.Service<
  SignInContinuationRegistry,
  ContributionRegistry.Store<ContinuationContribution>
>()("awthaq/core/SignInContinuationRegistry") {}
export const registryLayer = Layer.effect(
  SignInContinuationRegistry,
  Effect.map(
    ContributionRegistry.make<ContinuationContribution>((id) => new ContinuationRegistryFrozen({ id, message: "…" })),
    (store) => SignInContinuationRegistry.of(store),
  ),
);
```

```ts
// core/src/SignIn.ts: the typed front door a plugin uses
export const continuation = <P, I extends Schema.Json, E, R>(options: {
  readonly id: string;   // plugin id
  readonly kind: string;
  readonly payload: Schema.Codec<P, I>;
  readonly make: Effect.Effect<(payload: P, context: ContinuationContext) => Effect.Effect<void, StoreUnavailable>, E, R>;
}) => {
  const decode = Schema.decodeUnknownEffect(options.payload);
  const encode = Schema.encodeEffect(options.payload);
  return {
    /** What the first factor passes as `Attempt.continuation`. */
    of: (payload: P) =>
      encode(payload).pipe(
        Effect.map((encoded) => ({ kind: options.kind, payload: encoded })),
        Effect.catchTag("SchemaError", Effect.die), // ADR-EA-028 D3: a codec bug dies
      ),
    /** `AuthPlugin.layer(Self, { contributes })`. */
    layer: Layer.effectDiscard(
      Effect.gen(function* () {
        const registry = yield* SignInContinuationRegistry;
        const run = yield* options.make;
        yield* registry.register({
          id: options.id,
          kind: options.kind,
          run: (payload, context) =>
            decode(payload).pipe(Effect.catchTag("SchemaError", Effect.die), Effect.flatMap((p) => run(p, context))),
        });
      }),
    ),
  };
};
```

**SAML uses it:**

```ts
// saml/src/Saml.ts
const SamlContinuationPayload = Schema.Struct({
  connectionId: Schema.String,
  nameId: Schema.String,
  nameIdFormat: Schema.String,
  sessionIndex: Schema.optionalKey(Schema.String), // match SamlRecords.saveSession's input types
  roles: Schema.optionalKey(Schema.Array(Schema.String)),
});
export const samlContinuation = SignIn.continuation({
  id: "saml",
  kind: "saml.acs",
  payload: SamlContinuationPayload,
  make: Effect.gen(function* () {
    /* resolve records, organization, settings, usableConnection once */
    return (payload, { user, session }) => /* role mapping (if roles), saveSession, pruneSessions, under the connection's tenant when tenantScoped */;
  }),
});
```

The ACS completion becomes `signIn.complete({ userId, strategy: providerId, amr: ["fed"], continuation: yield* samlContinuation.of({...}) })`. The SLO record and role mapping now live in **one** place and run on both paths:

- **Direct.** Inside `issue`, after the mint and before `auth.user.signedIn`. This is today's order (`Saml.ts:1048-1063`).
- **After 2FA.** The divert receives `handoff.continuation`. `sessionGate` stores the handoff in the challenge payload. `finalizeSignIn` hands it back to `resume`, and `issue` runs it.

Role mapping moves from "before issue" to "inside issue". That is still before the session reaches the client, and now after the second factor too. So directory privileges are applied only to a fully authenticated sign-in. That also answers plan 10's Q1 ("move role mapping before the divert?"): no. With a continuation, the interim mitigation is unnecessary.

**Failure semantics.** A continuation fails only with `StoreUnavailable`. That makes `issue` fail after the row is minted, which is today's behaviour when `saveSession` fails. Role-mapping refusals keep being logged and skipped (`Saml.ts:931-936`). An unknown `kind` is a composition defect (`SignInContinuationMissing`). It can only happen when a plugin is removed while challenges are live (10-minute TTL). Failing closed is right, because IdP logout must be able to end every SAML session.

**Two-factor changes** (`two-factor/src/Challenge.ts`, `SecondFactor.ts`, `TwoFactor.ts`): `ChallengePayload` gains `handoff: Schema.optionalKey(Hooks.Handoff)`, and `ConsumedChallenge` gains `handoff: Hooks.Handoff | undefined`. `sessionGate` passes `handoff: input.handoff` to `issueChallenge`, and the re-issue on a wrong code carries `consumed.handoff` forward. Live challenges written before the change decode fine because the field is optional.

### 3.6 Uniform policies (decided once)

1. **Missing user.** `clear`/`resume` fail with the internal `SignIn/UserGone` (a `Data.TaggedError`, prefixed per ESS-008). It is never a defect, because erasure can legitimately race a sign-in. It is never its own wire answer either: each caller maps it with one `catchTag` onto **its existing uniform refusal**. So no new oracle appears:

   | Caller | `UserGone` → | Already publishes `signInFailed`? |
   |---|---|---|
   | password `signIn` | `Api.InvalidCredentials` | add `publishSignInFailed("invalidCredentials")` before failing |
   | passkey | `Api.InvalidCredentials` | yes (`tapError`, `Passkey.ts:1682-1696`, `assertionInvalid`) |
   | OAuth | `callbackFailed("account-missing")` (new `CallbackFailureReason`) | yes (`callbackRejected`, `OAuth.ts:1444-1455`) |
   | SAML | `AssertionInvalid({ reason: "accountMissing" })` | yes (`reject`, `Saml.ts:1071-1083`) |
   | device | `grants.remove(grant.id)` then `InvalidGrant` (today's behaviour) | no (unchanged) |
   | magic link / email OTP | `ChannelInvalid({ reason: "userMissing" })` → their `refused` | yes (`MagicLink.ts:327-335`) |
   | two-factor `resume` | `InvalidTwoFactorCode({})` (today's behaviour) | no (unchanged) |
   | password sign-up (`createSignedIn`) | invariant defect: the user was created in this same transaction | — |

2. **Suspended event.** Every refusal by the gate publishes `auth.user.signInFailed { strategy, reason: "suspended", clientIp? }`, for every strategy and for `resume`. That is safe: the gate runs only after the credential is proven, and the event carries no user id (ALF-003, ADR-EA-029). `HookAborted` and `TwoFactorRequired` are **not** failures and publish nothing (as `Passkey.ts:1677-1680` already argues).

3. **The `amr` hand-off.** The divert context's `amr` is `Attempt.amr`, and the session's `amr` is `Clearance.amr` (the same value). `SessionIssueContext.amr` is required. The handoff carries `tenantId` and `continuation`, and a divert owner must return it to `resume`. This is the documented contract on `Hooks.Handoff` for any third-party divert tap.

4. **What counts as a sign-up.** A sign-up is any flow where *a person or a directory* causes an account to exist: password, OAuth first login, SAML first login, magic link, email OTP, **SCIM**. They all go through `SignUp`, consult `BeforeSignUp`, and publish `auth.user.created` + `AfterSignUp` after commit. **Operator migrations are not sign-ups.** `UserImport.importUser` (a million-row import must not fire a million welcome mails or be vetoed by an app's sign-up policy) and `awthaq seed admin` (announced by `auth.admin.seed*`) stay outside, named as exemptions in ADR-EA-033 D5 and the static guard allowlist. SCIM's strategy is `scim:<organizationId>:<connectionId>`, mirroring SAML's `saml:<org>:<conn>` (`Saml.ts:89-90`), so a tap can recognise or exempt directory provisioning by prefix. A `BeforeSignUp` veto on SCIM answers **403** (`ScimApi.forbidden(abort.message)`), as SCIM already does for a vetoed membership (`Scim.ts:776-777`).

5. **A session minted at sign-up is a sign-in.** It goes through the clearance (gate, `BeforeSignIn`, `BeforeSessionIssue`), publishes `auth.user.signedIn`, and runs `AfterSignIn`. Password's reveal sign-up keeps BEH-EA-113's "user and session in one transaction" (`@REQ-EA-304/692`) through `SignUp.createSignedIn`:
   - **`BeforeSignIn` veto inside the transaction:** rolls back the user. Answer `HookAborted`, nothing persists.
   - **Divert inside the transaction:** caught as a value, so the user, credential and challenge commit. After commit, answer `TwoFactorRequired`.
   - **Session mint fails:** rolls back. Answer `StoreUnavailable` (503).

   OAuth, SAML and channel keep create-then-`complete` (two units), as today. Their specs do not require atomicity, and a returning user can sign in again. The uniform rule is stated once: *creation is atomic; a session at sign-up is always a cleared sign-in; flows whose behaviour spec demands user+session atomicity use `createSignedIn`*.

6. **Request context.** `issue(clearance, request?)` takes each field from `request` when given, else from `AuthRequestContext`. Until `RequestContext.layer` is guaranteed (E1, Q1), every HTTP-driven caller keeps passing `{ ip, userAgent }`, so nothing regresses. Phase 6 removes the threading once the context is guaranteed.

7. **Outages.** Nothing in either module dies on `StoreUnavailable`. A transaction's own `SqlError` becomes `StoreUnavailable("SignUp.create")` through `Errors.storeUnavailable` (`core/src/Errors.ts:31-34`). Only `SchemaError` and broken invariants die (ADR-EA-028 D3).

8. **Events after commit.** `SignUp` publishes `auth.user.created` and runs `AfterSignUp` only after its transaction returns. `SignIn.announce` (`signedIn`, `AfterSignIn`, the continuation) runs after the mint. In `createSignedIn` it runs after commit. `auth.session.issued` stays `Sessions.issue`'s own (ESA-006). Inside `createSignedIn` it is published inside the transaction, as today. Plan 10 item 5's `UnitOfWork` makes that bus copy after-commit with no change here.

9. **Identity after the veto** (`SignUp.vet`). A `BeforeSignUp` tap can amend `name` and `email`:
   - **Email application:** `Email(amended.email ?? original)`. A tap cannot remove the address. That matches password and channel today.
   - **Anonymous application:** `Email(amended.email)` if a tap supplied one, else `Anonymous`. That matches OAuth/SAML today for a profile without an email.
   - **Phone application:** unchanged (the hook has no phone field).
   - Behaviour change, deliberate and recorded: an OAuth/SAML profile *with* an email whose tap deletes `email` now keeps the email instead of becoming `Anonymous`.

### 3.7 `SignUp`: interface and implementation sketch

```ts
// core/src/SignUp.ts
export interface Application {
  readonly identity: Users.IdentityInput;
  readonly name: string;
  readonly strategy: string;
}
export type Vetted = Application & Brand.Brand<"awthaq/SignUp/Vetted">;
const vetted = Brand.nominal<Vetted>(); // module-private: only `vet` mints it

/** One conflict for every way a fresh account can collide; the caller picks its own wire answer. */
export class IdentityTaken extends Data.TaggedError("SignUp/IdentityTaken")<{
  readonly message: string;
  readonly kind: "Email" | "Phone" | "Account";
}> {}

export type LinkInput = Omit<Parameters<Accounts.AccountsShape["link"]>[0], "userId">;

export interface CreateOptions {
  /** The identity is already proven (trusted OAuth `email_verified`, a consumed mailbox proof). Same transaction. */
  readonly verified?: boolean;
  readonly image?: string;
  readonly metadata?: string;
  /** The credential account linked in the same transaction. */
  readonly link?: LinkInput;
}

export interface SignUpShape {
  readonly vet: (application: Application) => Effect.Effect<Vetted, HookPoint.HookAborted>;
  readonly create: (
    application: Vetted,
    options?: CreateOptions,
  ) => Effect.Effect<Users.UserRecord, IdentityTaken | StoreUnavailable>;
  /** `within` runs inside the same transaction after create/verify/link; a failure rolls everything back. */
  readonly createWith: <A, E, R>(
    application: Vetted,
    options: CreateOptions,
    within: (user: Users.UserRecord) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<{ readonly user: Users.UserRecord; readonly value: A }, IdentityTaken | E | StoreUnavailable, R>;
  /** Create + clear + mint in one transaction (BEH-EA-113); announce after commit (policy 3.6.5). */
  readonly createSignedIn: (
    application: Vetted,
    options: CreateOptions & { readonly amr: ReadonlyArray<Sessions.AuthMethod> },
    request?: SignIn.SessionRequest,
  ) => Effect.Effect<
    SignIn.IssuedSession,
    IdentityTaken | HookPoint.HookAborted | Hooks.TwoFactorRequired | StoreUnavailable
  >;
}
```

Implementation outline (`make`):

```ts
export const make = Effect.gen(function* () {
  const users = yield* Users.Users;
  const accounts = yield* Accounts.Accounts;
  const events = yield* AuthEvents.AuthEvents;
  const sqlTransaction = yield* SqlTransaction.SqlTransaction;
  const beforeSignUp = yield* Hooks.BeforeSignUp;
  const afterSignUp = yield* Hooks.AfterSignUp;
  const steps = yield* SignInSteps.makeSteps; // for createSignedIn only
  const discard = yield* DiscardUnannounced.make;

  const vet: SignUpShape["vet"] = Effect.fnUntraced(function* (application) {
    const original = application.identity._tag === "Email" ? application.identity.email : undefined;
    const amended = yield* HookPoint.aborted(Hooks.BeforeSignUp)(
      beforeSignUp.run({
        ...(original === undefined ? {} : { email: original }),
        name: application.name,
        strategy: application.strategy,
      }),
    );
    const identity: Users.IdentityInput =
      application.identity._tag === "Phone"
        ? application.identity
        : amended.email !== undefined
          ? { _tag: "Email", email: amended.email }
          : application.identity; // Email keeps its address (3.6.9); Anonymous stays Anonymous
    return vetted({ identity, name: amended.name, strategy: application.strategy });
  });

  /** The one transaction body every create shares. */
  const inTransaction = <A, E, R>(
    application: Vetted,
    options: CreateOptions,
    createdId: Ref.Ref<Option.Option<Users.UserId>>,
    within: (user: Users.UserRecord) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const created = yield* users
        .create({
          identity: application.identity,
          name: application.name,
          ...(options.image === undefined ? {} : { image: options.image }),
          ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
        })
        .pipe(
          Effect.catchTags({
            "Users/EmailAlreadyExists": () => new IdentityTaken({ kind: "Email", message: "awthaq: email taken" }),
            "Users/PhoneAlreadyExists": () => new IdentityTaken({ kind: "Phone", message: "awthaq: phone taken" }),
          }),
        );
      yield* Ref.set(createdId, Option.some(created.id));
      const user = options.verified === true ? yield* markVerified(created) : created; // verifyEmail|verifyPhone; UserNotFound/IdentityMismatch → invariant die
      if (options.link !== undefined) {
        yield* accounts.link({ ...options.link, userId: user.id }).pipe(
          Effect.catchTag("AccountAlreadyLinked", () =>
            new IdentityTaken({ kind: "Account", message: "awthaq: credential already linked" }),
          ),
        );
      }
      return { user, value: yield* within(user) };
    });

  const runCreate = <A, E, R>(application: Vetted, options: CreateOptions, within: (user: Users.UserRecord) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const createdId = yield* Ref.make(Option.none<Users.UserId>());
      const result = yield* sqlTransaction.withTransaction(inTransaction(application, options, createdId, within)).pipe(
        // `SqlTransaction` adds `SqlError` to the channel; it is the tx's own outage (ADR-EA-028).
        Effect.catchIf(isSqlError, Errors.storeUnavailable("SignUp.create")),
        // Memory compositions (`SqlTransaction.layerNoop`) roll nothing back; SQL already did, so this is a no-op there.
        Effect.onError(() =>
          Effect.flatMap(Ref.get(createdId), Option.match({ onNone: () => Effect.void, onSome: discard })),
        ),
      );
      yield* events.publish({ _tag: "auth.user.created", userId: result.user.id });
      yield* afterSignUp.run({ userId: result.user.id, ...Users.emailField(result.user), strategy: application.strategy });
      return result;
    });

  const createWith: SignUpShape["createWith"] = (application, options, within) => runCreate(application, options, within);
  const create: SignUpShape["create"] = (application, options) =>
    Effect.map(runCreate(application, options ?? {}, () => Effect.void), (created) => created.user);

  /** The two in-transaction outcomes of a sign-up that wants a session; plain constructors, no assertions. */
  type Outcome =
    | { readonly _tag: "Diverted"; readonly diverted: Hooks.TwoFactorRequired }
    | { readonly _tag: "Minted"; readonly cleared: SignIn.Clearance; readonly issued: SignIn.IssuedSession };
  const divertedOutcome = (diverted: Hooks.TwoFactorRequired): Outcome => ({ _tag: "Diverted", diverted });
  const mintedOutcome = (cleared: SignIn.Clearance, issued: SignIn.IssuedSession): Outcome => ({ _tag: "Minted", cleared, issued });

  const createSignedIn: SignUpShape["createSignedIn"] = (application, options, request) =>
    Effect.gen(function* () {
      // Inside the transaction: clear (a veto aborts → rollback; a divert becomes a value so the
      // account and the challenge commit), then mint. `runCreate` announces the *sign-up* after commit.
      const { value } = yield* runCreate(application, options, (fresh) =>
        steps.clear({ userId: fresh.id, strategy: application.strategy, amr: options.amr }).pipe(
          Effect.flatMap((cleared) => Effect.map(steps.mint(cleared, request), (issued) => mintedOutcome(cleared, issued))),
          Effect.catchTags({
            "SignIn/UserGone": (gone) => Defects.invariantViolation("SignUpUserGone", gone.message),
            UserSuspended: () => Defects.invariantViolation("SignUpUserSuspended", "awthaq: a fresh user is suspended"),
            TwoFactorRequired: (diverted) => Effect.succeed(divertedOutcome(diverted)),
          }),
        ),
      );
      if (value._tag === "Diverted") return yield* Effect.fail(value.diverted);
      return yield* steps.announce(value.cleared, value.issued); // the *sign-in* announcement, after commit
    });

  return { vet, create, createWith, createSignedIn } satisfies SignUpShape;
});
```

Notes for the implementer:

- The `Outcome` constructors carry an annotated return type. They are plain functions, not Effect/Layer consts, so the no-return-annotation rule does not apply. They exist so the sketch needs no `as const`; plan 10 Q6 asks whether the house rule covers const assertions, and this avoids the question.
- `HookAborted` from `BeforeSignIn` and `StoreUnavailable` from the mint are not caught. They fail the transaction body, so the account rolls back (SQL) or is discarded (memory), and `createSignedIn` answers them as is.
- `Effect.catchIf(isSqlError, …)`: with a generic `E` in the channel, `catchTag("SqlError")` may not narrow. `isSqlError` is exported by `effect/unstable/sql/SqlError` in rc.116 (`SqlError.d.ts:354`). If `catchTag` does narrow in practice, prefer it for uniformity.
- `discard` (`internal/discardUnannounced.ts`): if the user row still exists, delete its accounts (`Accounts.deleteAllByUser`) and its row, **without** `BeforeUserDelete` and **without** `auth.user.deleted`. Nobody was ever told the user existed, so there is nothing to veto and nothing to announce. Plugin rows written by `within` are the caller's to compensate (SCIM unlinks its mapping in its own `catch`). It must never fail the original error: wrap it in `Effect.catchCause(() => Effect.logError(...))`. Interaction with plan 03: section 8.

### 3.8 Seam guards

- **Types (compile-time).** `issue` accepts only `Clearance`, and the `create*` methods accept only `Vetted`. Their constructors are unreachable from other packages (`internal/` is not exported; `vetted` is module-private). `SessionIssueContext.amr` is required. A type-gate test (`core/test/SignIn.types.test.ts`) pins all three with `// @ts-expect-error`.
- **Static guard (runtime test).** `core/test/SignInSeams.test.ts`, in the style of `organization/test/TenantScoping.test.ts`, reads `packages/*/src/**/*.ts` from the filesystem (no cross-package import) and fails on:
  - `sessions` + `.issue(` outside an allowlist with expected counts: `core/src/internal/signInSteps.ts` (1), `password/src/Password.ts` (1, `changePassword` rotation), `admin/src/Admin.ts` (1, impersonation, BEH-EA-209), `test/src/TestAuth.ts` (1). A counted allowlist stops Password from quietly re-adding a sign-in mint next to its rotation.
  - `users.create(` / `.createOrGet(` outside `core/src/SignUp.ts`, `core/src/UserImport.ts`, `cli/src/Seed.ts`.
  - `.resume(` on a `SignIn` value outside `two-factor/src/TwoFactor.ts`.
  - `beforeSessionIssue.run(` / `beforeSignIn.run(` / `beforeSignUp.run(` outside `core/src/internal/signInSteps.ts` and `core/src/SignUp.ts`.

  Each allowlist entry carries a `why`, as `TenantScoping.test.ts:31-40` does.

### 3.9 The fourteen call sites, mapped

**Sign-in.**

| Site | After this plan | Edge cases kept |
|---|---|---|
| password `signIn` | `withTimingFloor` credential check → `EmailNotVerified` → rehash → `signIn.complete({ userId: user.id, strategy: "password", amr: ["pwd"] }, sessionRequest(input))`; `UserGone` → `publishSignInFailed("invalidCredentials")` + `InvalidCredentials` | gate now runs after the rehash (harmless); the plugin's own suspended publish is deleted |
| passkey `authenticateVerify` | ceremony + counter policy + `recordUsage` → `signIn.complete({ userId: stored.userId, strategy: "passkey", amr: passkeyAmr(verified) }, { ip: input.ip, userAgent: context?.userAgent })`; `UserGone` → `InvalidCredentials` | usernameless (discoverable) sign-in has no email at all: the user comes from the credential row, so nothing changes; WPS-001's defence in depth is now the module's |
| OAuth `callbackFlow` | `targetUserId` resolution unchanged (linked → tokens; `flow.link` → return early, **no sign-in**; auto-link; sign-up via `SignUp`) → `signIn.complete({ userId: targetUserId, strategy: providerId, amr: ["fed"] }, input)`; native exchange unchanged after it | auto-link (TMS-007) and explicit link stay in OAuth; `UserGone` → `callbackFailed("account-missing")`; the adjacent `orDie`s in the same function (`:1176, 1193, 1232`) become typed |
| SAML `signIn` | `signIn.complete({ userId, strategy: providerId, amr: ["fed"], continuation: yield* samlContinuation.of({...}) }, input)` | role mapping + SLO record + prune move into the continuation (section 3.5); `UserGone` → `AssertionInvalid{accountMissing}`; the `Tenant.withTenant` wrapper at `:1093-1096` stays and is captured into the clearance |
| device `poll` | `signIn.clear({ userId, strategy: STRATEGY, amr: grant.amr })` with `catchTags({ "SignIn/UserGone": remove + InvalidGrant, TwoFactorRequired: remove + AccessDenied })` → atomic `grants.consume` → lost → `invalidGrant` → `signIn.issue(cleared, { ip: input.ip, userAgent: context?.userAgent })` | the consume sits **between** the two steps, so exactly one concurrent poll wins; `UserSuspended` passes through and **keeps** the grant (`DeviceAuthorization.test.ts:645`); `grant.amr` is `claimed.value.amr` (same row), so `issue` records the clearance's |
| magic link / email OTP `Channel.complete` | `resolveUser` (existing user, or `SignUp.vet` + `create(…, { verified: true })`, with `IdentityTaken{Email}` → the concurrent winner) → `verifyEmail` for an existing user → `signIn.complete({ userId: user.id, strategy: completion.strategy, amr: completion.amr }, completion)`; `UserGone` → `ChannelInvalid{userMissing}` | the "named user vanished → fall back to the address" rule stays in `resolveUser`; `ChannelInvalid`'s reasons are unchanged |
| two-factor `finalizeSignIn` | `const cleared = yield* signIn.resume({ userId: challenge.userId, strategy: challenge.strategy, amr: Sessions.unionAmr(challenge.amr, ["otp","mfa"]), handoff: challenge.handoff })` → `signIn.issue(cleared, request)`; `UserGone` → `InvalidTwoFactorCode({})` | `finalizeSignIn` still accepts only a `VerifiedChallenge` (ADR-EA-020 D2): the plugin's own brand gates the *call*, core's brand gates the *mint*. Two brands, two seams |
| password sign-up (reveal) | `signUp.vet` → hash → `signUp.createSignedIn(vetted, { link: passwordLink(hash), amr: ["pwd"] }, sessionRequest(input))`; `IdentityTaken{Email}` → `PasswordApi.EmailAlreadyExists`, `{Phone,Account}` → invariant die → mail dispatch | veto still before the hash (ADR-EA-026's cost argument); `signUp`'s error union gains `Hooks.TwoFactorRequired` (contract change, section 6.4) |

**Sign-up.**

| Site | After this plan |
|---|---|
| password conceal | `vet` → hash (both branches) → `create(vetted, { link })`; `IdentityTaken` → `Option.none()` → `account-exists` mail. No session (ADR-EA-026 D3) |
| OAuth silent first login | `vet({ identity: profile.email ? Email : Anonymous, name, strategy: providerId })` → `create(vetted, { verified: trusted && profile.emailVerified, image, link: { providerId, subject, tokens, issuer } })`; `IdentityTaken{Email}` → winner lookup → `AccountExists{providers}`; `{Account}` → `callbackFailed("account-already-linked")` |
| SAML first login | `vet(...)` → `create(vetted, { link: { providerId, subject, issuer } })`; `IdentityTaken` → `AssertionInvalid{emailInUse}` |
| magic link / email OTP | `vet` → `create(vetted, { verified: true })` (the mailbox is proven, now in the same transaction); winner on `IdentityTaken` |
| **SCIM `createUser`** | ownership/convergence checks unchanged → `vet({ identity, name, strategy: \`scim:${org}:${conn}\` })` (`HookAborted` → 403) → `createWith(vetted, {}, (user) => records.link(...) + membershipAdded(...))`. Errors inside `within` become their SCIM answers inside the `catch`, which also unlinks the mapping. `IdentityTaken` → 409 → `applyActive` → `auth.scim.userProvisioned`. The `users.delete` rollback is **deleted** |

---

## 4. Phased migration

Each phase is one or more PRs. Each is green on its own, and each can be reverted on its own. **Phase gate** unless stated:

```sh
pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
```

(`pnpm build` first because plugin tests run against built `lib`, `docs/plugin-authoring.md` "House rules".) A phase that adds an error class also runs `pnpm check:error-tags`. A phase that touches `features/` or `spec/` also runs:

```sh
python3 features/scripts/allocate-req-ea.py && pnpm test:bdd && pnpm spec:verify:strict
```

**Plan gate:** `pnpm check && pnpm test:pg`. `test:pg` is required, because `SignUp`'s rollback is only real on a SQL transaction.

### Phase 0: prerequisites (plan 10 items 1 and 2)

Plan 10 owns the two hotfixes and lands them in Wave A: SAML `amr` (`Saml.ts:1036`) and ADR-EA-028 `orDie` on the sign-in sites. **Before starting Phase 1, confirm both are merged:**

```sh
grep -n "beforeSessionIssue.run" packages/saml/src/Saml.ts          # must pass amr
grep -nE "issue\(|findById" packages/{password,passkey,oauth,saml}/src/*.ts | grep orDie   # only Password.ts:1056/1677 and none else
```

If either is missing, land it from plan 10's text (items 1-2, steps and tests verbatim) as ticket `01-hotfixes`, and do not redesign it here. Gate: phase gate + `pnpm test:bdd`.

### Phase 1: core `SignIn` module (additive)

1. `core/src/Hooks.ts`: add `Continuation` and `Handoff`; make `SessionIssueContext.amr` required; add `handoff`. Fix any tap or test that constructs a context without `amr`.
2. `core/src/SignInContinuationRegistry.ts`: the registry and its frozen defect (`ContinuationRegistryFrozen`, tag prefixed per ESS-008 if it is a `Data.TaggedError`). Add `registryLayer` to `Hooks.HooksLive` (`core/src/Hooks.ts:174-189`).
3. `core/src/internal/signInSteps.ts`: `Attempt`, `Clearance`, `clearance`, `UserGone`, `makeSteps`.
4. `core/src/SignIn.ts`: public types, `make`, `continuation`; export `* as SignIn` from `core/src/index.ts` (and update its header comment).
5. Tests: `core/test/SignIn.test.ts`, `core/test/SignIn.types.test.ts` (section 5.1).
6. Spec: add the new behavior **BEH-EA-3S1** "Every sign-in completes through `SignIn`" to `spec/behaviors/06-domain-users-accounts.md` (section 6.1), with an *Implementation* note "callers migrating (plan 01 Phase 2)". Add ADR draft **ADR-EA-0NN** (section 6.2) with status `Accepted — in progress`. Add the `spec/traceability.md` row.
7. Changeset `.changeset/core-sign-in-module.md` (section 6.4).

If `knip` flags the new exports as unused before any caller exists, merge Phase 1 with Phase 2a. Gate: phase gate + `pnpm check:error-tags` + `pnpm spec:verify:strict`.

### Phase 2: migrate the sign-in sites (one PR per plugin, in this order)

The order puts the simplest first, and puts two-factor **before** SAML so that SAML's continuation is honoured on the 2FA path the moment it exists. Each PR deletes the per-plugin tests it supersedes (section 5.3) and updates the "As shipped" lists (section 6.1).

| Step | Files | Change | Extra gate |
|---|---|---|---|
| 2a | `magic-link/src/Channel.ts`, `MagicLink.ts`, `EmailOtp.ts` | `Channel.make` yields `SignIn.make`; lines `:162-194` become one `complete`; `UserGone` → `ChannelInvalid{userMissing}`; `Channel.IssuedSession` becomes an alias of `SignIn.IssuedSession` | `pnpm test:bdd` (32/33 features) |
| 2b | `device-authorization/src/DeviceAuthorization.ts` | `clear` → `consume` → `issue` (section 3.9); delete the inline `findById`/gate/veto/divert | — |
| 2c | `passkey/src/Passkey.ts` | `complete`; `UserGone` → `InvalidCredentials`; delete `:1624-1672` | — |
| 2d | `password/src/Password.ts` | `signIn` → `complete`; delete the plugin's suspended publish and the `Option.isSome(signInEmail)` spread; `UserGone` → `invalidCredentials` path | — |
| 2e | `oauth/src/OAuth.ts`, `CallbackFailure.ts` | `complete`; add `"account-missing"`; type the adjacent `orDie`s at `:1176, 1193, 1232` (`AccountNotFound`/`AccountAlreadyLinked` handled, `StoreUnavailable` flows) | — |
| 2f | `two-factor/src/Challenge.ts`, `SecondFactor.ts`, `TwoFactor.ts` | `ChallengePayload.handoff`; `sessionGate` stores `input.handoff`; re-issue carries it; `finalizeSignIn` → `resume` + `issue`; `TwoFactor.IssuedSession` aliased | `pnpm test:bdd` (31) |
| 2g | `saml/src/Saml.ts`, `index.ts` (export `samlContinuation` only if a test needs it) | `samlContinuation` + `contributes`; ACS → `complete` with continuation; remove the inline role mapping / `saveSession` / prune from `signIn`; `UserGone` → `AssertionInvalid{accountMissing}` | `pnpm test:bdd` (29, 31) |

After 2g, update BEH-EA-093 to its final wording (section 6.1) and mark ADR-EA-033 D5's sign-in half done.

### Phase 3: core `SignUp` module (additive)

1. `core/src/internal/discardUnannounced.ts` (section 3.7, and section 8 for plan 03).
2. `core/src/SignUp.ts`: `Application`, `Vetted`, `IdentityTaken`, `LinkInput`, `CreateOptions`, `make` (`vet`, `create`, `createWith`, `createSignedIn`); export `* as SignUp` from `index.ts`.
3. Tests: `core/test/SignUp.test.ts` (memory) and `core/test/SignUpSql.test.ts` (over `sql/test/support/TestSql.ts`, so `pnpm test:pg` covers Postgres); add `SignUp` cases to `SignIn.types.test.ts`.
4. Spec: add the new behavior **BEH-EA-3S2** "Every sign-up creates through `SignUp`" to `06-domain-users-accounts.md`.
5. Changeset `.changeset/core-sign-up-module.md`.

Gate: phase gate + `pnpm check:error-tags` + `pnpm test:pg`.

### Phase 4: migrate the sign-up sites (one PR each)

| Step | Files | Change | Extra gate |
|---|---|---|---|
| 4a | `password/src/Password.ts`, `PasswordApi.ts` | `prepareSignUp` keeps rate limits and policy, then `vet`, then hash; reveal → `createSignedIn`; conceal → `create`; delete `sessionRequest`'s second use inside the transaction and the `SqlError` dies; `signUp` endpoint `error` gains `Hooks.TwoFactorRequired`; `PasswordShape["signUp"]` error union likewise | `pnpm test:bdd` (`@REQ-EA-304`, `@REQ-EA-692` must stay green); `pnpm test:pg` |
| 4b | `oauth/src/OAuth.ts` | sign-up branch (`:1236-1342`) → `vet` + `create`; drop the `orDie` on `verifyEmail` | — |
| 4c | `saml/src/Saml.ts` | sign-up branch (`:977-1021`) → `vet` + `create` | — |
| 4d | `magic-link/src/Channel.ts` | `resolveUser` → `vet` + `create(…, { verified: true })`; `MagicLink`/`EmailOtp` `ports:` gain `SqlTransaction.SqlTransaction` | — |
| 4e | `scim/src/Scim.ts`, `ScimApi.ts` (only if `forbidden` needs a code), `scim/test/support.ts` | `vet` + `createWith`; delete `rollBack`'s `users.delete`; declare `ports: [SqlTransaction.SqlTransaction]`; spec 30 changes (section 6.1) | `pnpm test:bdd` (30); `pnpm test:pg` |

After 4e: ADR-EA-033 D5 amended (section 6.2); `AuthEventSchemas.ts:41, 45` doc comments say "published by `SignUp`/`SignIn`".

### Phase 5: seal the seams and finish the paperwork

1. `core/test/SignInSeams.test.ts` (section 3.8). Run it first in report-only mode and confirm the allowlist counts match the tree, then make it fail.
2. Remaining non-sign-in `orDie`: `Password.ts:1677` (`changePassword` `issue`) and `admin/src/Admin.ts:1106` (impersonation `issue`) become typed `StoreUnavailable`. Both Shapes already declare it, or add it where they do not.
3. `docs/plugin-authoring.md`: new section "Completing a sign-in and creating a user" (`SignIn.make`, `complete` vs `clear`/`issue`, `SignUp.vet`/`create*`, continuations, "never call `Sessions.issue` or `Users.create` for a sign-in/sign-up"). Add a checklist item.
4. `core/src/Users.ts:220-230` doc comment and `spec/behaviors/06-domain-users-accounts.md:143`: "called by `SignIn` for every flow".
5. ADR status → `Accepted — implemented`; `spec/decisions/index.yaml` entry.
6. Final `spec/traceability.md` pass; `features/traceability.md` regenerated.

Gate: plan gate (`pnpm check && pnpm test:pg`).

### Phase 6 (conditional on Q1 and plan 06): the HTTP edge

1. `server/src/SessionDelivery.ts`: `respond(request, mint)` resolves `mode` **before** running `mint`, then delivers. That makes MNA-001's ordering the helper's job instead of each handler's (D9). It is two-factor's local `complete` (`TwoFactor.ts:295-315`) promoted. Migrate the seven session-minting handlers.
2. If Q1 = "make `RequestContext.layer` required": add it to `TestAuth` (`test/src/TestAuth.ts`), `examples/sql-server/app.ts`, the BDD worlds (`features/step-definitions/*World.ts` that build an HTTP app) and `server/README.md`'s required middleware list. Then drop `userAgent` from the plugin Shapes and the explicit `request` argument at the eight call sites. Drop `ip` only where plan 06 already reads the rate-limit address from `AuthRequestContext`.
3. Changeset with a `Migration:` line telling hosts to add `RequestContext.layer`.

Gate: plan gate.

---

## 5. Test plan

### 5.1 New tests at the interface

**`core/test/SignIn.test.ts`** (memory: `Users.layerMemory`, `Sessions.layerMemory`, `TestAuth.memoryFoundation`-style foundation, recording taps):

1. `clear` for an active user returns a clearance carrying the user, strategy and `amr`; no session exists yet.
2. Suspended (indefinite): `UserSuspended`; `auth.user.signInFailed{ strategy, reason: "suspended", clientIp }` with `clientIp` from a provided `AuthRequestContext`; `BeforeSignIn` never ran; no session.
3. Suspended with a lapsed `suspendedUntil` (`TestClock`): clears.
4. Unknown id: `SignIn/UserGone`; no event; no tap ran.
5. `BeforeSignIn` abort: `HookAborted{ point: "auth.user.signIn", code }`; divert not consulted; no session.
6. `BeforeSignIn` input: `{ userId, email, strategy }` for an email user, and **no `email` key** for phone and anonymous users.
7. `BeforeSessionIssue` input is exactly `{ userId, strategy, amr: attempt.amr, handoff }` (D1's regression, moved from plan 10's SAML unit test). The handoff carries the ambient tenant and the continuation.
8. Divert: `TwoFactorRequired` surfaces; no session; no `signedIn`.
9. Outage: `Users.findById` failing `StoreUnavailable` surfaces typed (a wrapped memory layer, pattern `scim/test/ScimHttp.test.ts:370-382`).
10. `issue` records the clearance's `amr`. The audit log order is `auth.session.issued` → `auth.user.signedIn{ userId, strategy }`, then `AfterSignIn{ userId, strategy }`.
11. Request facts: from `AuthRequestContext`; an explicit `request` field overrides per field; neither gives an empty record.
12. Tenant: a clearance made under `Tenant.withTenant("t1")` and issued outside it records `tenantId = Some("t1")`.
13. `AfterSignIn` tap failure does not fail `issue` (BEH-EA-092).
14. `Sessions.issue` outage: typed `StoreUnavailable`; no `signedIn` (moved from plan 10 item 2's four `"ADR-EA-028: … outage is StoreUnavailable"` plugin tests).
15. `resume` skips both `BeforeSignIn` and `BeforeSessionIssue` (tap counters are zero), re-checks suspension (and publishes), maps a missing user to `UserGone`, and restores `tenantId` and `continuation` from the handoff.
16. Continuations: a registered continuation runs after the mint and before `signedIn`, with the decoded payload and the session; a `StoreUnavailable` from it fails `issue`; an unregistered `kind` dies `SignInContinuationMissing`; registering after the first read dies (frozen).
17. `complete` = `clear` + `issue` (happy path).

**`core/test/SignIn.types.test.ts`** (compiled by `tsc -p tsconfig.test.json`):

- `// @ts-expect-error` `signIn.issue({ user, strategy: "x", amr: [], tenantId: Option.none(), continuation: Option.none() })`. A structurally identical object is not a `Clearance`.
- `// @ts-expect-error` `signUp.create({ identity, name, strategy })`. An unvetted application.
- `// @ts-expect-error` `Hooks.BeforeSessionIssue` `run({ userId, strategy })` without `amr`.
- Add the same three as `// type-gate:` blocks in `features/step-definitions/CompileTimeGates.ts` for the BDD `@compile-time` rule.

**`core/test/SignUp.test.ts`** (memory) and **`core/test/SignUpSql.test.ts`** (`TestSql.layer("signup")`, run under `pnpm test:pg` on Postgres):

1. `vet` abort: `HookAborted{ point: "auth.user.signUp" }`; nothing created.
2. `vet` amendment: amended name and email are used; identity rules from section 3.6.9 (Email keeps its address when a tap drops it; Anonymous + amended email becomes Email; Phone unchanged).
3. `create`: user exists; `auth.user.created` and then `AfterSignUp{ userId, email, strategy }` happen after commit.
4. Duplicate email or phone: `IdentityTaken{ kind }`; no event; no `AfterSignUp`.
5. Link conflict: `IdentityTaken{ kind: "Account" }`, and **no user remains** (memory via `discard`, SQL via rollback).
6. `verified: true` flips `emailVerified` / `phoneVerified` in the same unit.
7. `createWith`: `within`'s value is returned; a `within` failure leaves no user and no account in both backends; `discard` publishes no `auth.user.deleted` and runs no `BeforeUserDelete` (a vetoing tap is installed and must not fire).
8. Transaction `SqlError` (a failing `SqlTransaction` adapter) becomes `StoreUnavailable("SignUp.create")`.
9. `createSignedIn`:
   - happy path: user and session, with the event order `created`, `AfterSignUp`, `session.issued`, `signedIn`, `AfterSignIn`;
   - `BeforeSignIn` abort: no user (`@REQ-EA-692`'s sibling);
   - divert: user and challenge committed, then `TwoFactorRequired`;
   - mint outage: no user, `StoreUnavailable`.
10. `AfterSignUp` tap failure does not fail the sign-up.

**`core/test/SignInSeams.test.ts`**: the static guard from section 3.8.

### 5.2 Per-plugin tests that stay (shrunk to what the plugin owns)

Add `SignInProbe` to `@awthaq/test` (`test/src/SignInProbe.ts`): a layer of recording taps on `BeforeSignUp`, `AfterSignUp`, `BeforeSignIn`, `BeforeSessionIssue` (never diverting) and `AfterSignIn`, plus `SignInProbe.recorded`. Each plugin then asserts **only its contract with the module**, in its main test file:

| Plugin test file | Assertions |
|---|---|
| `password/test/Password.test.ts` | probe: `strategy "password"`, `amr ["pwd"]`; sign-up publishes `signedIn`; `EmailNotVerified` precedes the gate; `UserGone` → `InvalidCredentials` + `signInFailed{invalidCredentials}`; reveal sign-up maps `IdentityTaken` → 409 |
| `password/test/AuthHttp.test.ts` | `POST /password/sign-up` answers `TwoFactorRequired` (401) when a test divert tap diverts |
| `passkey/test/Passkey.test.ts` | probe: `strategy "passkey"`, `amr` from `passkeyAmr`; `UserGone` → `InvalidCredentials`; **moved in** from `PasskeyHooksBeforeSignIn.test.ts:136-164`: a refused assertion publishes `signInFailed{assertionInvalid}` |
| `oauth/test/OAuth.test.ts` | probe: `strategy = providerId`, `amr ["fed"]`, silent sign-up reaches `BeforeSignUp` with the provider id; `UserGone` → `OAuthCallbackFailed`; **moved in** from `OAuthHooksVeto.test.ts:236-265`: state mismatch publishes `signInFailed{callbackRejected}` |
| `saml/test/Saml.test.ts` | probe: `strategy saml:<org>:<conn>`, `amr ["fed"]`; continuation: direct ACS writes the `saml_session` row and applies role mapping; `UserGone` → `SamlAssertionRejected` |
| `device-authorization/test/DeviceAuthorization.test.ts` | keep `:645` (suspended keeps the grant) and `:657` (deleted user → `invalid_grant`, row dropped); add divert → `access_denied` + row dropped; keep `:357` (one winner) |
| `magic-link/test/MagicLink.test.ts`, `EmailOtp.test.ts` | probe: strategy `magicLink`/`emailOtp`, `amr ["email"]`; concurrent create uses the winner; delete `MagicLink.test.ts:202` ("a suspended user gets no session"), which is now SignIn's case 2 |
| `two-factor/test/TwoFactor.test.ts` | `finalizeSignIn` records `[...first, "otp", "mfa"]` and forwards the handoff (a recorded continuation runs after verify); delete the suspended re-check case, which is now SignIn's case 15 |
| `scim/test/ScimUsers.test.ts` | probe: `strategy scim:<org>:<conn>`; `BeforeSignUp` veto → 403 and nothing left (user, mapping, membership); `auth.user.created` + `AfterSignUp` once, and **not** on a converging repeat POST; the existing "failed provisioning leaves nothing" test runs on memory **and** on `TestSql` |

### 5.3 Deleted (replace, don't layer)

| File | Lines | Superseded by |
|---|---:|---|
| `password/test/PasswordHooksBeforeSignIn.test.ts` | 159 | SignIn 5, SignUp 3 |
| `password/test/PasswordHooksSignIn.test.ts` | 169 | SignIn 8, 10 |
| `password/test/PasswordHooksSignUp.test.ts` | 120 | SignUp 1-2 |
| `passkey/test/PasskeyHooksBeforeSignIn.test.ts` | 164 | SignIn 5 (+ one case moved) |
| `passkey/test/PasskeyHooksSignIn.test.ts` | 135 | SignIn 8 |
| `passkey/test/PasskeySuspended.test.ts` | 127 | SignIn 2-3 |
| `oauth/test/OAuthHooksSignIn.test.ts` | 164 | SignIn 8, SignUp 9 |
| `oauth/test/OAuthHooksVeto.test.ts` | 265 | SignUp 1, SignIn 5 (+ one case moved) |
| plan 10 item 2's four `"ADR-EA-028: … outage is StoreUnavailable"` plugin tests | ~80 | SignIn 9, 14 (keep plan 10's **one** HTTP 503 test in `password/test/AuthHttp.test.ts`) |
| plan 10 item 1's SAML `BeforeSessionIssue` recording test | ~30 | SignIn 7 + the SAML probe |

Net: about −1,400 lines of plugin tests, about +700 at the two interfaces.

### 5.4 BDD (`features/`)

Tags are allocated by `python3 features/scripts/allocate-req-ea.py` (never by hand). Regenerate `features/traceability.md` in the same commit.

- `04-cross-cutting/12-hooks.feature`, Rule BEH-EA-090: + "Every sign-up path, directory provisioning included, consults BeforeSignUp" (Examples: password, oauth, saml, magic link, email OTP, SCIM). Rule BEH-EA-093: + "A first-factor sign-in completed by a second factor keeps its first factor's methods, tenant and continuation" (SAML: `amr = ["fed","otp","mfa"]`, a `saml_session` row exists, role mapped).
- `02-domain/06-users-accounts.feature`: new Rules for BEH-EA-3S1 (a suspended account's refusal is announced for every strategy; a vanished user is a refusal, not a server error; `@compile-time` "a session cannot be minted without a clearance") and BEH-EA-3S2 (sign-up is atomic; a failed provisioning leaves nothing behind in memory and SQL; `@compile-time` "a user cannot be created without a vetted application").
- `05-authentication-methods/15-password.feature`: `@REQ-EA-304/692` unchanged, and they must stay green. + "A password sign-up is announced as a sign-in" (`auth.user.signedIn` strategy `password`).
- `13-enterprise-federation/30-scim.feature`: Rule BEH-EA-247 + "A BeforeSignUp veto refuses provisioning with 403 and leaves neither user nor mapping"; Rule BEH-EA-253 + "Provisioning publishes auth.user.created once".
- `14-mfa-passwordless/31-two-factor.feature`: plan 10 adds the SAML `fed` scenario; extend its `Scenario Outline` examples with `saml` and `device` if plan 10 did not.
- Step definitions: `HooksSteps.ts`, `UsersAccountsSteps.ts`, `ScimSteps.ts`, `SamlSteps.ts`, `TwoFactorSteps.ts`; `CompileTimeGates.ts` for the three type gates.

---

## 6. Spec, ADR, traceability, changesets

### 6.1 Behaviour entries (each bumps its Document Control: revision + change history line "plan 01")

| File | Entry | Change |
|---|---|---|
| `spec/behaviors/06-domain-users-accounts.md` (1.2 → 1.3) | **new BEH-EA-3S1** "Every sign-in completes through `SignIn`" | Requirement: every flow that turns a proven credential into a session MUST mint it from a `SignIn.Clearance` (gate → suspended event → `BeforeSignIn` → `BeforeSessionIssue` with the same `amr` and a handoff → mint under the clearance's tenant → continuation → `auth.user.signedIn` → `AfterSignIn`); a vanished user is refused through the flow's own uniform refusal; `resume` is the divert owner's only entry |
| same | **new BEH-EA-3S2** "Every sign-up creates through `SignUp`" | Requirement: `BeforeSignUp` before any write; create, verify, link and the caller's work in one unit, with nothing left behind on failure in any backend; `auth.user.created` and `AfterSignUp` only after commit; one `IdentityTaken`; operator imports exempt |
| same | BEH-EA-046 (`:143`) | "password sign-in, passkey `authenticateVerify` and the OAuth callback each call it" → "`SignIn.clear`/`resume` call it for every strategy and publish `signInFailed{suspended}`" |
| `spec/behaviors/12-hooks.md` (1.1 → 1.2; plan 10 may take 1.2 first, then use 1.3) | BEH-EA-090 "As shipped" (`:51`) | list every sign-up path (password, OAuth, SAML, magic link, email OTP, SCIM) and every sign-in path (+ SAML, device, magic link, email OTP, two-factor's `resume`); name `SignUp`/`SignIn`; name the exemptions |
| same | BEH-EA-093 "As shipped" (`:109`) | final wording: "`@awthaq/two-factor` taps `Hooks.BeforeSessionIssue`, which `SignIn.clear` consults for every first factor with the attempt's `amr` and a `handoff` (tenant, continuation); `finalizeSignIn` hands the handoff back to `SignIn.resume`, so the session finally minted records both factors and runs the first factor's continuation (SAML's SLO record and role mapping)" |
| `spec/behaviors/15-password.md` (1.2 → 1.3) | BEH-EA-113 | requirement text unchanged; add *Implementation*: "`SignUp.createSignedIn`; the first session is a cleared sign-in (`BeforeSignIn`, `BeforeSessionIssue`, `auth.user.signedIn`); a `BeforeSignIn` abort rolls the account back; a divert commits the account and answers `TwoFactorRequired`" |
| `spec/behaviors/29-saml-sp.md` (1.2 → 1.3) | BEH-EA-315, 316 | "the SLO record and role mapping are a sign-in continuation (`saml.acs`), so they apply whether the session is minted by the ACS or after a second factor; a tenant-scoped connection's session keeps the connection's tenant across the divert" |
| `spec/behaviors/30-scim.md` (1.0 → 1.1) | BEH-EA-247 | add: "creation consults `BeforeSignUp` with strategy `scim:<organizationId>:<connectionId>`; a veto answers 403; user, mapping and membership commit as one unit"; BEH-EA-253: "+ `auth.user.created` and `AfterSignUp`, once per provisioned user, never on a converging repeat" |
| `spec/behaviors/31-two-factor.md` (1.0 → 1.1) | BEH-EA-261/262 | "`finalizeSignIn` = `SignIn.resume` + `issue`; the challenge stores the divert's handoff" |
| `spec/behaviors/32-magic-link.md`, `33-email-otp.md` | creation/sign-in paragraphs | "through `SignUp` (mailbox proof marks the identity verified in the same unit) and `SignIn`" |
| `spec/behaviors/37-device-authorization.md` | the poll behaviour (`:175` area) | "`SignIn.clear`, then the atomic consume, then `SignIn.issue`" |
| `spec/behaviors/13-events.md` (1.1 → 1.2) | taxonomy paragraph (`:106`) | "`signInFailed{suspended}` is published by every strategy (`SignIn`)"; "`auth.user.created` by every sign-up path (`SignUp`), operator imports excepted" |
| `spec/traceability.md` (1.5 → 1.6) | §1 row 06: range "041-048, 254, 3S1, 3S2", module "`Users.ts`, `SignIn.ts`, `SignUp.ts`"; test map rows for `SignIn.test.ts`, `SignIn.types.test.ts`, `SignUp.test.ts`, `SignUpSql.test.ts`, `SignInSeams.test.ts`; amend the password, passkey, OAuth, SAML, SCIM and two-factor rows (no deleted file is cited today, verified by grep) |

BEH numbers: the highest today is **BEH-EA-318**. Take the next two free numbers at merge time (`spec/scripts/check-drift.mjs` check 16 catches a collision with a sibling plan). `spec/README.md`'s file → range list (check 17) must list them.

### 6.2 ADRs

**New ADR-EA-038 (reserved in `.planning/README.md`).** File `spec/decisions/038-sign-in-and-sign-up-are-core-modules.md`, indexed in `spec/decisions/index.yaml`.

> **ADR-EA-0NN: Sign-in completion and sign-up are core modules; a session for a proven credential is minted only from a clearance**
>
> *Context.* Eight flows hand-wrote "gate, veto, divert, issue, announce", and six hand-wrote "veto, create, announce". The copies drifted: SAML's divert lost `amr`; a 2FA-completed SAML session lost its SLO record, role mapping and tenant; only password announced a suspended refusal; missing users had five answers; SCIM skipped `BeforeSignUp` and `auth.user.created`; password's first session skipped the sign-in hooks. The gate was deliberately a plain call, not a hook (SCP-001), because a tap can be left out of a composition. The same argument applies to the whole sequence.
>
> *Decision.*
> 1. `@awthaq/core`'s `SignIn` is the one implementation of sign-in completion: `clear` → branded `Clearance`, `issue(clearance)`, `complete`, and `resume` for a divert owner. `issue` accepts nothing but a `Clearance`, whose constructor is package-private. The `amr` the divert sees is the `amr` the session records. `SessionIssueContext.amr` is required.
> 2. A divert carries a **handoff** (ambient tenant + an optional typed **continuation**) that its owner returns to `resume`. Continuations are an aggregating registry (ADR-EA-012) carried by `HooksLive`.
> 3. `SignUp` is the one implementation of user creation for every *sign-up*: `vet` → branded `Vetted`, then `create` / `createWith` / `createSignedIn`. It owns the transaction, the compensation for backends without one, one `IdentityTaken`, and after-commit announcements. Operator imports (`UserImport`, `awthaq seed admin`) are not sign-ups.
> 4. Uniform policies: a vanished user is a refusal mapped to the flow's own uniform answer, never a defect; a suspended refusal is announced for every strategy; a session minted at sign-up is a cleared sign-in; neither module dies on `StoreUnavailable`.
> 5. A static test refuses `Sessions.issue`, `Users.create`, `SignIn.resume` and the sign-in/sign-up hook `run`s outside a counted allowlist.
>
> *Alternatives.* (a) A "finalisation" hook tap: rejected for the reason the gate is not a hook. (b) Put the sequence inside `Sessions.issue`: rejected because `issue` also serves rotation and impersonation (BCR-004's comment at `Password.ts:1232-1236`). (c) A `Context.Service` per module: rejected in favour of `make`, which needs no host wiring and matches `Channel.make`/`MailDispatch.make`. (d) One `complete` only: rejected because device authorization must consume its grant between clearing and issuing. (e) Move SAML role mapping before the divert (plan 10's interim Q1): superseded by continuations, which also restore the SLO record and tenant.
>
> *Consequences.* + One place to change or audit sign-in policy; bugs D1-D8 cannot recur structurally; about −1,400 lines of tests. − Plugins depend on two more core modules; magic-link, email OTP and SCIM now require the `SqlTransaction` port; password sign-up's contract gains `TwoFactorRequired`; a host's `BeforeSignUp` taps now see SCIM provisioning.

**Amend ADR-EA-033** (`spec/decisions/033-hook-registries-per-composition.md`, 1.0 → 1.1), Decision 5:

> Every sign-in-completing flow consults `BeforeSignIn` and `BeforeSessionIssue` through `SignIn.clear` … and every *sign-up* path (password, OAuth, SAML, magic link, email OTP, SCIM) consults `BeforeSignUp` through `SignUp.vet`; operator imports (`UserImport.importUser`, `awthaq seed admin`) are not sign-ups. See ADR-EA-0NN.

**Amend ADR-EA-028** (Rollout paragraph; revision 1.2 is plan 10's, so this is 1.3 if 10 landed first): "sign-up transactions (`SignUp`) map their `SqlError` to `StoreUnavailable`; `changePassword` and impersonation `issue` no longer die".

### 6.3 Glossary

`spec/glossary.md`: add **Clearance** (a sign-in that passed the gate, veto and divert, and the only thing a session can be minted from), **Handoff** (what a divert carries back to `resume`), **Sign-in continuation** (work a first factor owes once its session exists), and **Vetted sign-up**.

### 6.4 Changesets

`.changeset/config.json` puts every package in one `fixed` group, so they version together. Bump levels state intent.

**`.changeset/core-sign-in-module.md`** (Phases 1-2):

```md
---
"@awthaq/core": minor
"@awthaq/password": minor
"@awthaq/passkey": minor
"@awthaq/oauth": minor
"@awthaq/saml": minor
"@awthaq/device-authorization": minor
"@awthaq/magic-link": minor
"@awthaq/two-factor": minor
---

Sign-in completion is one core module, `SignIn` (BEH-EA-3S1, ADR-EA-0NN). Every first factor (password, passkey,
OAuth, SAML, device authorization, magic link, email OTP) and the second factor now finish through it.

- A suspended account's refusal publishes `auth.user.signInFailed { reason: "suspended" }` for every strategy, not
  only password.
- A SAML sign-in completed by a second factor now keeps `fed` in its `amr`, is recorded for Single Logout, is
  role-mapped, and keeps its connection's tenant.
- A user erased between credential proof and session issue is refused with the flow's own uniform error (OAuth:
  `OAuthCallbackFailed`; SAML: `SamlAssertionRejected`) instead of a 500.
- `Hooks.BeforeSessionIssue`'s input now always carries `amr` and may carry a `handoff`.

Migration: a custom `BeforeSessionIssue.run` caller must pass `amr`. A custom divert tap that later completes the
sign-in itself must return the `handoff` it received to `SignIn.resume`. A detector counting `signInFailed`
gains suspended refusals from every strategy. Plugin authors: finish a sign-in with `SignIn.make` (`complete`, or
`clear`/`issue`), never `Sessions.issue`.
```

**`.changeset/core-sign-up-module.md`** (Phases 3-4):

```md
---
"@awthaq/core": minor
"@awthaq/password": minor
"@awthaq/oauth": minor
"@awthaq/saml": minor
"@awthaq/magic-link": minor
"@awthaq/scim": minor
---

User creation is one core module, `SignUp` (BEH-EA-3S2). Every sign-up path vets with `BeforeSignUp`, creates in
one unit that leaves nothing behind on failure (memory compositions included), and announces
`auth.user.created` and `AfterSignUp` only after commit.

- SCIM provisioning is a sign-up: it consults `BeforeSignUp` with strategy `scim:<organizationId>:<connectionId>`
  (a veto answers 403) and publishes `auth.user.created` and `AfterSignUp` alongside `auth.scim.userProvisioned`.
- A password sign-up's first session is a full sign-in: `BeforeSignIn` and `BeforeSessionIssue` apply, and
  `auth.user.signedIn` / `AfterSignIn` fire. `POST /password/sign-up` may answer `TwoFactorRequired` (401)
  when a divert tap diverts; a `BeforeSignIn` abort creates no account.
- A sign-up transaction's database failure answers 503 `StoreUnavailable` instead of 500.
- A `BeforeSignUp` tap that removes `email` from an OAuth/SAML profile that had one no longer creates an anonymous
  user; the address is kept.

Migration: `MagicLink`, `EmailOtp` and `Scim` layers now require the `SqlTransaction` port: provide
`SqlTransaction.layerSql` (or `layerNoop` in memory). A `BeforeSignUp` tap that should not apply to directory
provisioning must exempt strategies starting with `scim:`. A `BeforeSignIn` tap now also sees password sign-ups
(strategy `password`); one that refuses unverified addresses will refuse every reveal-mode sign-up. Subscribers
counting `auth.user.signedIn` now see password sign-ups. Clients of `POST /password/sign-up` should handle
`TwoFactorRequired`.
```

**Phase 5** (`.changeset/no-die-on-session-issue.md`, `@awthaq/password`, `@awthaq/admin`: patch): "`changePassword` and admin impersonation answer 503 `StoreUnavailable` on a session-store outage instead of 500. Migration: retry or alert on 503 as well as 500."

**Phase 6**, if taken (`@awthaq/server` minor + plugins): `SessionDelivery.respond`; the `RequestContext.layer` requirement. Migration: "add `RequestContext.layer` to your router middleware, or sessions record no address or user agent".

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A host's `BeforeSignIn` tap written for returning users (for example "refuse unverified email") now refuses every password sign-up | Called out in the changeset; the abort rolls the account back, so the user can retry, and nothing half-exists; the strategy label is unchanged, so the tap can tell |
| SCIM provisioning breaks for a deployment with a domain allow-list `BeforeSignUp` tap | Q2; strategy prefix `scim:` documented as the exemption; 403 carries the abort message so the directory admin sees why |
| Compensation (`discard`) deletes a real user | It acts only on the id this very call created (held in a `Ref` set right after `users.create`), only after a failure, and only if the row still exists; SignUp case 7 asserts no `BeforeUserDelete`/`auth.user.deleted`; SQL backends never reach it with a live row |
| The continuation registry is read after a plugin registered late | `contributionRegistry` already dies on a late registration (frozen); SignIn case 16 |
| A 2FA challenge issued before Phase 2f lacks `handoff`; after 2g SAML expects one | Challenges live 10 minutes; a SAML sign-in diverted in the deploy window finishes without SLO/role mapping, which is today's behaviour; no failure |
| `amr` required on `SessionIssueContext` breaks a third-party caller of `run` | No such caller in the repo (the static guard proves it after Phase 5); changeset migration line |
| Generic `createWith` fights inference without `as` | Contextual typing of a generic function type by an arrow is supported; fall back to `Effect.fnUntraced` with explicit type parameters on the inner helper (`runCreate`), never a cast |
| `Effect.catchTag("SqlError")` does not narrow with a generic `E` | `Effect.catchIf(isSqlError, …)` (rc.116 exports it) |
| Ordering change: SAML's SLO record now written inside `issue` (before `signedIn`, same as today) but role mapping moves after the mint | The session is not yet delivered when role mapping runs, so no request sees a session before its roles; Saml.test asserts roles are present when `acs` returns |
| Plan 10's tests, which this plan deletes, are referenced by its acceptance list | Plan 10 says 01 moves them (its Interactions table); traceability rows are updated in the same PR |
| One extra `findById` in password and channel | Primary-key lookup, next to an argon2id verify or a token consume; no measurable cost |
| Phase 6 removes request threading before the context is guaranteed | Phase 6 is gated on Q1 and runs last; until then every call site passes its request explicitly |

**Rollback.** Phases 1 and 3 are additive: reverting them is safe once their callers are reverted. Each Phase 2/4 step is a single-plugin PR, and reverting it restores that plugin's hand-written copy, which still compiles because the hooks and services are unchanged. The exception is `amr` being required, which every reverted copy already passes after plan 10 item 1. Revert 2g (SAML) before 2f (two-factor) to keep the continuation honoured. 4e (SCIM) reverts to the compensating `users.delete`, so check plan 03's state first (section 8). Phase 5's static guard can be reverted alone.

---

## 8. Interactions with other plans

| Plan | Shared seam | What this plan assumes | What this plan leaves for it |
|---|---|---|---|
| **10** standalone fixes | the sign-in sites; BEH-EA-093; ADR numbering; `UnitOfWork` | **Items 1-2 merged** (Phase 0 checks); item 8f's interim BEH-EA-093 wording may be in place; ADR-EA-037 is item 5's | Moves item 1's SAML recording test and item 2's four plugin outage tests to `SignIn` (keeps the one HTTP 503 test); fixes the SAML + 2FA continuation gap item 1 hands over (no interim role-mapping move needed, which answers its Q1); converts `Password.ts:1053/1056/1677` and `Admin.ts:1106`; writes BEH-EA-093's final wording. With item 5's `UnitOfWork`, `createSignedIn`'s in-transaction `auth.session.issued` bus copy is released on commit automatically. Either order is correct |
| **03** erasure single cascade | deleting a user | `Users.delete` is no longer public (README: "03 before 01") and the `BeforeUserDelete` veto lives in `AccountErasure.eraseAccount`, not in the store primitive | `internal/discardUnannounced.ts` uses the **store-level** row removal 03 keeps for `AccountErasure` (no veto, no event). If 03 instead left the veto inside `Users.delete`, Phase 3 adds a core-internal vetoless remove next to 03's (same module, so it does not become a second public deletion path). If 03 rewrote SCIM's `rollBack` to `AccountErasure.eraseAccount`, Phase 4e deletes that too, since erasure would run a veto and announce a user nobody was told about |
| **06** rate-limit budget | the sign-in preamble in password/passkey | **Merged**: the per-plugin rate-limit wrappers are already core's; this plan does not touch them | Phase 6 drops `ip` from Shapes only where 06 reads the address from `AuthRequestContext` |
| **07** `Verification.redeem` | magic-link/email-OTP completion | Runs **after** 01 | Guidance for 07: inside `redeem(…, use)`, run `Channel`'s find-or-create (`SignUp.vet`/`create`) and `SignIn.clear`, so a refused completion rolls back the token's consumption, and call `SignIn.issue` after commit (it announces). A divert should commit the consumption (the second factor is owed; the link is spent). 07 can split `Channel.complete` along `clear`/`issue` without touching core |
| **02** store seam | `Sessions.issue`, `Users.create` | Runs after 01 | `Sessions.issue` has four callers (counted allowlist) and `Users.create` three; 02's store adapters swap underneath `SignIn`/`SignUp` unchanged, and `SignIn.test.ts`/`SignUp.test.ts` become contract tests run over both adapters |
| **04** organization/SCIM | SCIM `createUser`'s membership step | Runs after 01 (wave C) | 4e puts `membershipAdded` inside `createWith`'s `within`; 04 may replace it with an organization system module call in the same slot. 04 still owns SCIM team create/delete |
| **05** plugin table substrate | plugin records `orDie` | none | `PasskeyCredentials.recordUsage`'s `orDie` (`Passkey.ts:1614`) and SAML/SCIM record `orDie` stay 05's |
| **08** test composition | `@awthaq/test` | none | `SignInProbe` is a natural member of 08's bundles; 08 may fold it into `TestAuth.layer` |
| **09** event definitions | `auth.user.created`, `auth.user.signedIn`, `signInFailed` | Schemas unchanged here | If 09 classifies "attempt" events, `signInFailed{suspended}` from `SignIn.gate` is one; no code here depends on the classification |

---

## 9. Acceptance checklist

- [ ] Phase 0: plan 10 items 1-2 confirmed merged (or landed here verbatim).
- [ ] `core/src/SignIn.ts`, `SignUp.ts`, `SignInContinuationRegistry.ts`, `internal/signInSteps.ts`, `internal/discardUnannounced.ts` exist; `SignIn` and `SignUp` are exported from `core/src/index.ts`; no `as` (other than any existing `as const`), no return-type annotation on a new Effect/Layer const.
- [ ] `SessionIssueContext.amr` is required; `Handoff` exists; `HooksLive` carries the continuation registry.
- [ ] All eight session-minting sign-in sites go through `SignIn` (`complete`, `clear`+`issue`, or two-factor's `resume`+`issue`); `grep -rn "beforeSessionIssue.run\|beforeSignIn.run" packages/*/src` hits only `core/src/internal/signInSteps.ts`.
- [ ] All six sign-up sites go through `SignUp`; `grep -rnE "users\s*\.create\(|\.createOrGet\(" packages/*/src` hits only `SignUp.ts`, `UserImport.ts`, `Seed.ts`.
- [ ] `core/test/SignInSeams.test.ts` passes with the counted allowlist.
- [ ] Type gates pass (`SignIn.types.test.ts` + `CompileTimeGates.ts`).
- [ ] SAML + 2FA: `amr = ["fed","otp","mfa"]`, a `saml_session` row, role mapping applied, tenant preserved (unit + BDD).
- [ ] `signInFailed{suspended}` from every strategy (SignIn case 2 + probes).
- [ ] Missing user maps to each flow's uniform refusal; no defect path remains (`grep orDie` over the eight sites is clean).
- [ ] Password sign-up: `@REQ-EA-304` and `@REQ-EA-692` green; `signedIn` published; `TwoFactorRequired` declared on the endpoint.
- [ ] SCIM: `BeforeSignUp` consulted (403 on veto), `auth.user.created` + `AfterSignUp` once, nothing left behind on failure in memory and SQL; `users.delete` no longer called by SCIM's create path.
- [ ] The eight per-plugin hook test files are deleted, and the two strategy-specific cases are moved; plan 10's moved tests are deleted from the plugins.
- [ ] Spec: BEH-EA-3S1/3S2 added; BEH-EA-046, 090, 093, 113, 247, 253, 261/262, 315/316, the magic-link, email-OTP, device and events entries updated, each with a Document Control bump; ADR-EA-0NN added and indexed; ADR-EA-033 D5 and ADR-EA-028 Rollout amended; glossary terms added; `spec/traceability.md` and `features/traceability.md` regenerated.
- [ ] `docs/plugin-authoring.md` has the "Completing a sign-in and creating a user" section.
- [ ] Changesets with `Migration:` lines for Phases 1-2, 3-4, 5 (and 6 if taken).
- [ ] `pnpm check` and `pnpm test:pg` green.

---

## 10. Open questions (only the user can answer)

1. **Make `RequestContext.layer` a required middleware?** Today it is opt-in, and only `examples/memory-server` installs it (E1). If yes, Phase 6 removes `ip`/`userAgent` threading from every plugin Shape, and a host without the middleware records no address or user agent on sessions. If no, Phase 6 is limited to `SessionDelivery.respond`, and call sites keep passing their request.
2. **Should a host's `BeforeSignUp` taps apply to SCIM directory provisioning?** This plan says yes, under strategy `scim:<organizationId>:<connectionId>`, so a global sign-up policy (a banned domain, a legal block) cannot be bypassed by a directory. The alternative treats SCIM like an operator import (no veto), which ADR-EA-033 D5 would then have to name as an exemption.
3. **Should enterprise federation (SAML, and OIDC connections) be subject to the local second-factor divert at all?** The plan makes SAML + 2FA correct (continuation, `amr`, tenant). But `TwoFactorConfig.bypassStrategies` is an exact-string match (`TwoFactor.ts:181`), and SAML strategies are per connection (`saml:<org>:<conn>`), so an application cannot say "the IdP already did MFA" for all SAML at once. If you want that, a prefix match (`"saml:*"`) is a small two-factor change outside this plan's scope.
