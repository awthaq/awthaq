# Plan 14: Federated identity resolution is a core module

| Property | Value |
|---|---|
| Strength | Strong. Two plugins hand-write the same five-step resolution, the copies have drifted, and the drift is a live 500 |
| Dependency category | in-process (a new core Domain module beside `SignIn`/`SignUp`, over the `Accounts`/`Users` interfaces and the atomic store primitives plan 02 shipped) |
| Wave / order | After plans 01, 02 and 10 item 7 (all merged). Independent of plans 11 to 24, except the small ordering notes in §8 (16, 17, 22). Phase 0 is a hotfix that can ship alone, first |
| Fixes live bugs | **SAML: two concurrent ACS for one new NameID answer 500** (`Saml.ts:1169` dies on `AccountAlreadyLinked`; `:1189` turns `IdentityTaken{Account}` into an invariant defect) · SAML and OAuth refuse a legitimately proven identity that merely lost a race (`emailInUse`; `AccountExists{providers:["acme"]}`, telling the person to sign in with the provider they just used; `OAuthCallbackFailed`) · OAuth's explicit link of an identity already linked to another user reports success, links nothing and overwrites that other user's provider tokens · OAuth's returning sign-in dies when the account is unlinked or erased between its read and its token refresh (`OAuth.ts:1108`) |
| Execution tickets | `.scratch/federated-identity/issues/NN-*.md`, one per phase (`docs/agents/issue-tracker.md`) |
| New ADR | ADR-EA-043 (reserved for this plan), extending ADR-EA-038 |

Every `file:line` below was checked against the tree at `fc990c88` (2026-10-17). Each live bug was reproduced with a throwaway test in the session scratchpad (not in the repo), against the real `TestAuth.layer` compositions both plugins' suites use. Re-check line numbers before editing: siblings in this batch (16, 17) touch the same stores.

---

## 1. Summary, goals, non-goals

### Summary

A federated sign-in (an OAuth provider, an organization's OIDC connection, an organization's SAML connection) ends with the same question: *which local user is this external identity?* Both federated plugins answer it by hand, with the same five steps:

1. read the account anchored at `(providerId, subject, issuer)` (INV-EA-015);
2. none: read the local user holding the asserted email;
3. a holder: auto-link if the caller's policy trusts the asserting party **and** both sides have the address verified (TMS-007, BEH-EA-245), else refuse;
4. no holder: vet and create the user through `SignUp`, linking the identity in the same unit;
5. hand the user to `SignIn`.

The copies are `oauth/src/OAuth.ts:1092-1244` (153 lines) and `saml/src/Saml.ts:1144-1194` (51 lines). Each step is a read followed by a write on another row, so each pair is a race. Neither copy owns the race: steps 1 to 3 read in the plugin, step 4 writes in `SignUp`, and the unique constraints that make the write safe report the loss as an error the plugin then maps to whatever was at hand. SAML maps it to a defect (500). OAuth maps it to a refusal. Both answers are wrong. Two requests that proved the **same** `(providerId, subject, issuer)` proved the same person, and INV-EA-015 says that tuple names exactly one account. The loser's own plan (create a user, auto-link into a holder) is moot once the anchor exists: the correct outcome of a lost race is to **read the anchor again and sign in as its user**, which is exactly what the same request would have got one millisecond later.

This plan moves the resolution into a **deep module** in `@awthaq/core`, `FederatedIdentity`, next to `SignIn` and `SignUp`. Its **interface** is two functions:

- `resolve(identity, trust)` → `Linked | AutoLinked | Created` (or a typed refusal);
- `attach(identity, userId)` → `Attached` (the explicit "link this provider to my account" flow).

Behind that interface sit the anchor read, the email match, the trust decision (one function, both sides proven, optionally bounded to the domains the caller trusts), the just-in-time sign-up through `SignUp`, the token set the account carries (BE-002), the image rule (NAM-009), the name fallback, the new `auth.account.linked` announcement, and the **one bounded re-read after a lost race**, implemented once. OAuth and SAML keep what is theirs: the protocol (state, PKCE, token exchange, `id_token`, XML signature, replay cache), the **trust verdict** derived from their own configuration (`linking.trustedProviders`; a connection's `trustsEmail` and claimed domains), the wire answer for each refusal, and everything after resolution (`SignIn.complete`, SAML's continuation, OAuth's native exchange).

### Why plan 01 left linking in the plugins, and why that reasoning does not stand here

Plan 01 (`.planning/01-sign-in-sign-up/PLAN.md:43`) listed as a non-goal: "Account linking that does not create a user (OAuth `flow.link`, OAuth/SAML auto-link to an existing verified account). These stay in their plugins. They are not sign-ups." That was a statement about **`SignUp`'s scope**, and it remains true: linking is not a sign-up, and this plan does not widen `SignUp` (no new member, no new error kind). What plan 01 did not consider is that the *decision between* linking and signing up is one policy, and splitting it across the seam is what made the race unowned:

- The read that decides "no account, no holder, so create" happens in the plugin; the write that discovers "someone else just created it" happens in `SignUp`. `SignUp` cannot recover, because it does not know an anchor exists or what the caller would have done with it. The plugin cannot recover either, because it sees `IdentityTaken` with a `kind` and nothing else, and both plugins mapped it to the nearest refusal (`Saml.ts:1185-1190`, `OAuth.ts:1212-1240`).
- The auto-link copies diverged in exactly the places a single module would have fixed once: SAML never marks a created user verified while OAuth does (AOMS-007); SAML dies on the auto-link race while OAuth refuses; OAuth refreshes tokens and dies on an unlink race while SAML has no tokens; neither announces a link.

So the module boundary plan 01 drew (sign-up vs not sign-up) was the wrong cut for this question. The right cut is "a proven external identity becomes a local user", which *uses* `SignUp` for one of its three outcomes. `FederatedIdentity` sits above `SignUp`, in the same stratum, and plan 01's non-goal stands for `SignUp`.

### Goals

1. One implementation of federated identity resolution, used by OAuth (static providers and organization OIDC connections, which flow through the same `callbackFlow`) and SAML.
2. A lost race resolves to the anchor's user in every path (create vs create, auto-link vs auto-link, link vs unlink), over memory and SQL, proven by tests that force the interleaving.
3. Typed outcomes and typed refusals with closed unions, so each caller must map each refusal (`catchTags` exhaustiveness), and a new refusal kind is a compile error in every caller.
4. The trust decision is decided once: an asserting party is trusted or not by the caller's verdict; auto-link and verify-on-create need the party trusted, the address inside the trusted domains, the claim verified, and (for auto-link) the local address verified.
5. The explicit link flow refuses an identity already linked to another user (the silent-success bug), is idempotent for the same user, and refuses a target user who vanished.
6. Replace, don't layer: about 16 per-plugin linking tests move to one resolver suite parameterized by trust policy; each plugin keeps its protocol tests, its verdict wiring, its refusal mapping and one race regression.
7. A static guard keeps the seam: no file under `oauth/src` or `saml/src` reads an anchor, links an account, or makes a `SignUp`.

### Non-goals

- Changing the protocols: OAuth state/PKCE/`id_token`/userinfo, SAML's validation chain, the assertion replay cache, the SAML continuation (plan 01), OAuth's native exchange (MNA-003), token *refresh* against the provider (`OAuthTokenAccess.withAccessToken`). These stay in the plugins.
- Wrapping resolution in one serializable transaction. Rejected in ADR-EA-043 (§6.2): it needs dialect-specific isolation, turns every federated sign-in into a retry loop on serialization failure, and the unique constraints plus one re-read already give the right answer.
- `UserImport`, `awthaq seed admin`, `migrate-*` importers (`OAuth.accountAnchorFor` stays): operator paths, not federated sign-ins.
- SCIM: directory provisioning by `externalId`, not a federated sign-in.
- Making a SAML connection's `entityId` edit safe for existing links (§2.6 F7): recorded as a follow-up, Q7.
- Passkey, password and device accounts: not federated (no issuer, no email claim).

---

## 2. Verified current state

### 2.1 The two hand-written copies, step by step

| Step | OAuth `callbackFlow` (`oauth/src/OAuth.ts`) | SAML `signIn` (`saml/src/Saml.ts`) |
|---|---|---|
| Plugin makes | `completion = SignIn.make` `:828`, `creation = SignUp.make` `:830` | `creation = SignUp.make` `:847`, `completion = SignIn.make` `:848` |
| Identity extraction | `profile = provider.mapProfile(...)` `:1084`; empty subject refused `:1088-1090` | `providerIdOf` `:1141`, `subject = nameId.value` `:1142`, `emailOf` `:1143` (`emailOf` `:400-407` lower-cases and shape-checks) |
| Issuer | `Option.getOrUndefined(provider.issuer)` `:1095`; `issuerField` `:257-258` (none for a plain OAuth2 provider) | `connection.idpEntityId` `:1147` (always) |
| 1. Anchor read | `accounts.findByProviderSubject` `:1092-1096` | `:1144-1148` |
| Anchor found | refresh tokens `:1104-1109`; **`AccountNotFound` → `Effect.die`** `:1108` | `Effect.succeed(account.userId)` `:1151` |
| Explicit link (`flow.link`) | `accounts.link` to `flow.link.userId` `:1112-1128`; `AccountAlreadyLinked` → `callbackFailed("account-already-linked")` `:1123-1125`; target user never read | n/a |
| 2. Email holder | `users.findByEmail(profile.email)` `:1130-1133` | `:1154-1155` |
| 3. Trust decision | `trustedProvidersOf(config).includes(providerId) && profile.emailVerified === true && Users.isEmailVerified(holder)` `:1142-1145` (`trustedProvidersOf` `:844-845`) | `connection.trustsEmail && Users.isEmailVerified(holder)` `:1159` (no claim, no domain bound) |
| Refusal | `AccountExists{ providers: conflictingProviders(holder, claimVerified) }` `:1146-1155` (`conflictingProviders` `:852-857`, NAM-006) | `AssertionInvalid{ emailInUse }` `:1160` |
| Auto-link | `accounts.link` `:1156-1163` with tokens; **race → `callbackFailed("account-already-linked")`** `:1164-1169` | `accounts.link` `:1162-1168`; **race → `Effect.die`** `:1169` |
| Name | `profile.name ?? profile.email ?? profile.subject` `:1179` | `attributeOf(NAME_ATTRIBUTES) ?? email ?? subject` `:1172` |
| 4. Vet | `creation.vet({ identity: Email \| Anonymous, name, strategy: providerId })` `:1180-1189` | `:1175-1179` |
| Create | `creation.create(vetted, { verified: email && claimVerified && trusted, image (NAM-009 `isImageUrl` `:142`), link + tokens })` `:1190-1210` | `creation.create(vetted, { link })` `:1180-1183`: **never verified, no image** |
| Create lost race | `IdentityTaken{Account}` → `callbackFailed` `:1215-1218`; `{Phone}` → invariant `:1220-1225`; `{Email}` → winner's providers → **`AccountExists`** `:1228-1238` | `{Email}` → **`emailInUse`** `:1186-1187`; anything else → **`Defects.invariantViolation("SamlSignUpConflict")`** `:1188-1189` |
| Early return | `flow.link` → no session `:1246-1250` | n/a |
| 5. Sign-in | `completion.complete({ userId, strategy: providerId, amr: ["fed"] })` `:1256-1265` | `completion.complete(..., continuation)` `:1200-1225`, under `Tenant.withTenant(org)` when `tenantScoped` `:1254-1257` |

OAuth's config is read per request in the connection's tenant (`const config = yield* configNow` `:933`, `configNow` `:765`), so its verdict can differ per tenant; that stays OAuth's.

### 2.2 The live bugs, each reproduced

The reproduction forces both requests past the anchor read before either writes. `TestAuth.layer`'s `decorate` wraps `Users` (both plugins' suites already expose it: `saml/test/support.ts:79-104` `coreOverride`, `oauth/test/OAuth.test.ts` `buildLayer`'s `coreOverride`) with a two-party rendezvous before `findByEmail` (email paths) or `createWith` (anonymous path), then runs two ACS / callbacks with `Effect.all([...], { concurrency: "unbounded" })`. Observed on HEAD:

| # | Flow | Path | Exits observed | Correct outcome |
|---|---|---|---|---|
| B1 | SAML ACS ×2, same NameID `opaque-123`, no email attribute (Anonymous) | create vs create | `[success, die: Defects/InvariantViolation "awthaq: that credential is already linked to an account"]` (`Saml.ts:1189`) | both sign in as one user |
| B2 | SAML ACS ×2, same NameID `ada@acme.example` (email) | create vs create | `[success, fail: SamlAssertionRejected]` (`emailInUse`, `:1186-1187`) | both sign in as one user |
| B3 | SAML ACS ×2, `trustsEmail` connection, verified local `ada@acme.example` | auto-link vs auto-link | `[success, die: AccountAlreadyLinked]` (`:1169`) | both sign in as the local user |
| B4 | OAuth callback ×2, `{ id: "anon-1" }` (no email) | create vs create | `[success, fail: OAuthCallbackFailed]` (`:1215-1218`) | both sign in as one user |
| B5 | OAuth callback ×2, `{ id, email, email_verified: true }` | create vs create | `[success, fail: AccountExists{ providers: ["acme"] }]` (`:1228-1238`): a 409 telling the person to sign in with the provider they are signing in with | both sign in as one user |
| B6 | OAuth callback ×2, trusted provider, verified local user | auto-link vs auto-link | `[success, fail: OAuthCallbackFailed]` (`:1164-1169`) | both sign in as the local user |
| B7 | OAuth explicit link: Alice starts `authorize(link: { userId: alice })`; the identity `shared-sub` is already linked to Bob | anchor found → `onSome` | **success**, `session: undefined`; Alice has 0 accounts, Bob 1, and **Bob's provider tokens were overwritten** (`:1104-1109`, then `:1246-1250`) | refusal `account-already-linked`; Bob untouched |
| B8 | OAuth returning sign-in; the account is unlinked (or its user erased) between `:1092` and `:1105` | refresh race | `Effect.die` on `AccountNotFound` (`:1108`), a 500 | read the anchor again: here no anchor, so the email policy decides |

B1/B3 are the 500s ("concurrent assertions for one subject"): a double-submitted ACS form, a user with two tabs on the IdP, a load balancer retry. B2/B4/B5/B6 are refusals of a proven identity. B7 tells a signed-in person "linked" when nothing was linked. B8 is a defect where ADR-EA-028 and ADR-EA-038 decision 4 say a race with erasure is a refusal, never a defect.

Why the re-read is safe on every backend (verified):

- `Accounts.link` is `store.insertIfAbsent` (`core/src/Accounts.ts:233-255`); over SQL that is one `INSERT ... ON CONFLICT ("providerId", subject, issuer) DO NOTHING` (`sql/src/AccountStoreSql.ts:8`, `:97-110`), so a lost link never poisons a Postgres transaction. `Users.create` is `store.insertOrHolder` (`core/src/Users.ts:632-638`; `sql/src/UserStoreSql.ts:7`: `ON CONFLICT DO NOTHING RETURNING *`), same property. Plan 02 made both atomic primitives; memory adapters do each in one `Ref.modify`.
- `SignUp.create`'s unit (`core/src/SignUp.ts:157-232`) fails as a whole on `IdentityTaken`; a SQL rollback (or `Users.createWith`'s abandon, `Users.ts:805-813`, plus the account cleanup `SignUp.ts:206-208`, in memory) leaves nothing. The re-read happens after that unit, outside it.
- Under Postgres READ COMMITTED a conflicting `INSERT ... ON CONFLICT DO NOTHING` waits for the other transaction to end; the next statement takes a fresh snapshot and sees the winner's committed row. SQLite has one writer. So the second read sees the anchor unless the winner itself rolled back, in which case the second attempt simply proceeds.

### 2.3 Other divergences (not races)

| # | Divergence | Evidence | Consequence |
|---|---|---|---|
| D1 | SAML never marks a created user verified | `Saml.ts:1180-1183` vs OAuth AOMS-007 `OAuth.ts:1196-1199` | A user created by a `trustsEmail` connection keeps an unverified address, so a later trusted OAuth sign-in cannot auto-link into it (TMS-007 needs the local side verified). Unspecified either way (BEH-EA-245 is silent); Q1 |
| D2 | SAML's trust is not bounded by the connection's domains | `Saml.ts:1159` checks `trustsEmail` only; the connection's `emailDomains` (`saml/src/SamlRecords.ts:78-79`), claimed through `DomainClaims` so a domain belongs to one organization (BEH-EA-317, `organization/src/DomainClaims.ts:1-22`), are never consulted | A `trustsEmail` connection of organization B can assert `ceo@acme.com` and be auto-linked into Acme's verified local user. Whether that is reachable depends on who passes `SamlConfig.canManageSaml` (`saml/src/SamlConfig.ts:66-70`, deny by default; a host that lets tenant administrators manage their own connections makes it a cross-organization account-takeover lever). Q2 |
| D3 | OIDC organization connections can never be trusted | `OAuthConnections.ts:26-31` carries `config` and `revision` only; trust is the static `linking.trustedProviders` list (`OAuthConfig.ts:63`), and a connection's provider id is data (`org:<org>:<conn>`, `OrganizationConnections.ts:61-62`); `ConnectionRecord` (`organization/src/ConnectionRecords.ts:38-61`) has no trust field | SAML connections have per-connection trust; OIDC connections, the same "connection per organization" model, have none. Q4, Phase 5 |
| D4 | No event for a link | `grep -rn "account.linked" packages/*/src` finds nothing; `AuthEventSchemas.ts` defines no account event | An auto-link (an external identity joined to an existing account) and an explicit link leave no `AuthEvents` record and no durable audit row, while the sign-up path announces `auth.user.created`. Q3 |
| D5 | Explicit link never checks the target user | `OAuth.ts:1112-1128`; `Accounts.link` does not read the user (`Accounts.ts:233-255`) | A link flow started by a user erased before the callback writes an account for a user that no longer exists (memory), or fails on the foreign key as `StoreUnavailable` (SQL) |
| D6 | Image and name rules | NAM-009 `isImageUrl` (`OAuth.ts:141-142`, `AccountContract.ImageUrl`) applied by OAuth only; the name fallback written twice (`:1179`, `Saml.ts:1172`) | Cosmetic today (SAML passes no image), but two more places to drift |
| D7 | Email normalisation | SAML lower-cases (`Saml.ts:402`, `:404`); OAuth does not; `Users.findByEmail`/`create` lower-case (`Users.ts:597`, `:411-415`) | No bug today (the store folds case), but a domain bound (D2) must fold too, so it is decided in the module |

### 2.4 Callers of the anchor and of linking (completeness)

`grep -rn "findByProviderSubject\|\.link({" packages/*/src`:

- Federated sign-in: `oauth/src/OAuth.ts:1092`, `:1114`, `:1156`, and through `SignUp` `:1190`; `saml/src/Saml.ts:1144`, `:1162`, and through `SignUp` `:1180`. **These move.**
- OIDC organization connections: no code of their own. `Organization.oauthConnections` (`organization/src/OrganizationConnections.ts:186-208`) installs a resolver `OAuthProviders` consults (`oauth/src/OAuthProviders.ts:174-183`); the callback is `OAuth.callbackFlow`. So the candidate's "third caller" is **not** a separate caller: it is OAuth's, and it differs only in its trust source (D3).
- Not federated, unchanged: `password/src/Password.ts:1217`, `:1321`, `:1437`, `:1677`, `:1730` (the `password` account), `passkey/src/Passkey.ts:1346`, `:1631`, `admin/src/AdminAccounts.ts:283`, `:297` (admin password reset), `core/src/SignUp.ts:186` (the sign-up's own link), `core/src/UserImport.ts:117`, `:134`, `cli/src/Seed.ts:130`, `:136` (operator).

### 2.5 Tests that re-test the resolution per plugin

| File:line | Test | Becomes |
|---|---|---|
| `oauth/test/OAuth.test.ts:456` | REQ-EA-335/336 unlinked email match → `AccountExists`, nothing linked | resolver §5.1 #3 row 1 (the wire mapping stays in `:924`) |
| `:492` | REQ-EA-338 a provider not named never auto-links | same claim as `:566`; resolver #3 row 1 |
| `:523` | REQ-EA-339 a named provider auto-links | **kept** as OAuth's verdict wiring |
| `:566` | REQ-EA-340 naming one provider does not extend to a second | **kept** as OAuth's verdict wiring |
| `:613` | REQ-EA-337 explicit link attaches to the caller's own user | **kept** as the `attach` wiring (no session) |
| `:671` | TMS-007 trusted, unverified local → `AccountExists` | resolver #3 row 3 |
| `:695` | TMS-007 trusted, verified local → auto-link | resolver #3 row 4 |
| `:716`, `:737`, `:763` | AOMS-007 verified-on-create (trusted+claim, untrusted+claim, trusted+no claim) | resolver #4 (one table) |
| `:782` | FAMS-002 no email → Anonymous; the next sign-in resolves the same user | resolver #5 |
| `:816`, `:849` | NAM-009 http(s) avatar kept, `javascript:` dropped | resolver #6 |
| `:924`, `:951` | NAM-006 `AccountExists.providers` lists real providers / nothing for an unverified claim | **kept** (OAuth's wire policy for `EmailInUse`) |
| `:973` | FAMS-006 `accountAnchorFor` is the callback's key | **kept** (OAuth's anchor computation for importers) |
| `:1024` | a returning user signs in without a second account | resolver #1 |
| `:3250`, `:3289`, `:3319` | BE-002 a new sign-up persists the exchanged token set; numeric `expires_in`; no token fields | **kept** (OAuth's token-set construction) |
| `:3353` | re-authenticating overwrites the stored token set | resolver #1 |
| `:3416` | explicit link persists the token set | resolver #15 |
| `:3449` | auto-link persists the token set | resolver #3 row 4 |
| `saml/test/Saml.test.ts:566` | an assertion never links by email alone | resolver #3 row 1 |
| `:589` | `trustsEmail` links only into a verified local account | **rewritten** as SAML's verdict wiring (trust, domain bound) |
| `:620`, `:646` | suspended user refused; `tenantScoped: false` unstamped | unchanged (sign-in gate and tenant, not resolution) |

BDD acceptance scenarios stay (they run through the plugins): `features/features/05-authentication-methods/16-oauth.feature:80-130` (REQ-EA-335 to 340, 685) and `13-enterprise-federation/29-saml-sp.feature:330-371` (REQ-EA-905 to 910).

### 2.6 Corrections to the candidate description, and further findings

- **Confirmed:** OAuth `:1092-1244` and SAML `:1144-1194` are the copies; plan 01's non-goal is at `PLAN.md:43`; SAML dies on the auto-link race at `:1169`; OAuth maps the races at `:1123`, `:1166`, `:1215`; the test anchors `OAuth.test.ts:492/695/716/951/3416` and `Saml.test.ts:566` are linking tests.
- **Refined:** SAML's `kind !== "Email"` invariant is at `:1188-1189`. It is the 500 only for an identity **without** an email (anonymous NameID). With an email the same race reaches `users.create` first and is answered `emailInUse` (B2), a refusal, not a 500. Both are wrong; the anonymous one is the 500.
- **Refined:** OAuth "handles" `IdentityTaken{Account}` only by refusing it (B4). With an email its race surfaces as `IdentityTaken{Email}` and answers `AccountExists{["acme"]}` (B5).
- **Wrong:** "a third caller, OIDC organization connections": they go through `OAuth.callbackFlow` (§2.4). They are a third **trust source** (D3), handled in Phase 5.
- **Wrong:** "events emitted (`auth.account.linked`?)": no such event exists (D4).
- **New F5 (B7):** the explicit link of an identity linked to another user silently succeeds and refreshes the other user's tokens.
- **New F6 (B8):** the token-refresh `AccountNotFound` die.
- **New F7 (out of scope):** a SAML connection's `entityId` is editable (`saml/src/SamlConnections.ts:419-429`, `SamlAdmin.ts:104-115` `UPDATE_FIELDS`), and it is the anchor's issuer (`Saml.ts:1147`, `:1167`), so an edit orphans every account linked through the connection: each user's next sign-in answers `emailInUse` or creates a second, anonymous user. The provider id already names the connection, so the issuer adds nothing a connection can keep stable. Q7.

---

## 3. Target design

### 3.1 Placement and seam

| File | Exported from `@awthaq/core` as | Holds |
|---|---|---|
| `core/src/FederatedIdentity.ts` | `FederatedIdentity` | public types, refusals, `trusted`/`untrusted`, `make` |
| `core/src/AuthEventSchemas.ts` | (existing) | `AccountLinkedEvent` (`auth.account.linked`), registered at `:1708` (Q3) |
| `packages/test/src/Rendezvous.ts` | `Rendezvous` from `@awthaq/test` | the two-party meeting point the race tests share (core, OAuth, SAML, BDD: four callers) |

`FederatedIdentity.make` follows `SignIn.make`/`SignUp.make` (ADR-EA-038 alternative (c)): an `Effect` a plugin yields once inside its own `make`, returning closures with no further requirements. Its requirements are `Users`, `Accounts`, `AuthEvents` and `SignUp.make`'s, all already in OAuth's and SAML's `RIn`, so **no host wires anything**. Like `SignUp.ts:38-49`, it re-exports the services and hook points its requirements mention, so a plugin whose inferred layer type names them can do so through the `FederatedIdentity` import (TS2883).

The **seam** is the module's interface: the plugin hands over data (an `ExternalIdentity`) and a verdict (`EmailTrust`), and gets back a user id or a typed refusal. Nothing about accounts, holders, sign-ups or races crosses it. The plugin then calls `SignIn` itself, because what happens next differs (SAML's continuation and tenant, OAuth's native exchange, `attach`'s no-session).

### 3.2 Interface (`packages/core/src/FederatedIdentity.ts`)

```ts
// @awthaq/core — FederatedIdentity (ADR-EA-043, BEH-EA-<new>)
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as HookPoint from "./HookPoint.ts";
import type { StoreUnavailable } from "./Errors.ts";
import type * as Accounts from "./Accounts.ts";
import type * as Users from "./Users.ts";

/** What an asserting party (an OAuth provider, an OIDC or SAML connection) proved about a person. */
export interface ExternalIdentity {
  /** The account's `providerId`, and the sign-up's `strategy`: a provider id, `org:<org>:<conn>`, `saml:<org>:<conn>`. */
  readonly providerId: string;
  /** OIDC `sub`, a provider's immutable id, a SAML NameID. Compared exactly, never case-folded. */
  readonly subject: string;
  /** BEH-EA-125: the anchor's third component. `None` for a plain OAuth2 provider. */
  readonly issuer: Option.Option<string>;
  readonly email: Option.Option<AssertedEmail>;
  readonly name: Option.Option<string>;
  /** NAM-009: kept only when it is an http(s) URL (`AccountContract.ImageUrl`); dropped here otherwise. */
  readonly image: Option.Option<string>;
  /** BE-002: stored on the account when it is linked or created, and replaces the stored set on a returning sign-in. */
  readonly tokens: Option.Option<Accounts.ProviderTokenSet>;
}

export interface AssertedEmail {
  readonly address: string;
  /**
   * Whether the asserting party vouches for the address (OIDC `email_verified`). A SAML assertion has
   * no per-claim flag: the signed assertion is the IdP's directory speaking, so SAML passes `true`
   * and whether that directory is believed is the trust verdict's business.
   */
  readonly verified: boolean;
}

/** The caller's verdict on the asserting party's email claims (BEH-EA-124, BEH-EA-245). Required: no default. */
export type EmailTrust =
  | { readonly _tag: "Untrusted" }
  | { readonly _tag: "Trusted"; readonly domains: "any" | ReadonlyArray<string> };

export const untrusted: EmailTrust = { _tag: "Untrusted" };
/** `"any"`: a provider trusted for every address it verifies (Google). A list: only addresses in these domains (a connection's claimed domains). */
export const trusted = (domains: "any" | ReadonlyArray<string>): EmailTrust => ({ _tag: "Trusted", domains });

/** Who the identity is, and how that was decided. */
export type Resolved =
  /** The anchor already named a user (a returning sign-in). */
  | { readonly _tag: "Linked"; readonly userId: Users.UserId }
  /** Linked into the existing holder of the address: trusted party, address in its domains, both sides verified. */
  | { readonly _tag: "AutoLinked"; readonly userId: Users.UserId }
  /** A user was created through `SignUp` with the identity linked in the same unit. */
  | { readonly _tag: "Created"; readonly userId: Users.UserId; readonly user: Users.UserRecord };

export interface Attached {
  readonly userId: Users.UserId;
  /** `true`: the identity was already linked to this very user (a repeated link): nothing new, tokens replaced. */
  readonly already: boolean;
}

/** Why a holder of the address was not linked into. The caller decides what (if anything) to reveal. */
export type EmailRefusal = "untrusted" | "outsideTrustedDomains" | "claimUnverified" | "localUnverified";

/** BEH-EA-123/245: the address belongs to a local user this identity may not be linked into. Internal; each caller maps it. */
export class EmailInUse extends Data.TaggedError("FederatedIdentity/EmailInUse")<{
  readonly message: string;
  readonly holder: Users.UserId;
  readonly reason: EmailRefusal;
  /** OAuth's NAM-006 reveals the holder's providers only when the party vouched for the address. */
  readonly claimVerified: boolean;
}> {}

/** `attach`: the identity is already linked to another user. */
export class LinkedElsewhere extends Data.TaggedError("FederatedIdentity/LinkedElsewhere")<{
  readonly message: string;
}> {}

/** `attach`: the user the link was started for no longer exists. */
export class TargetGone extends Data.TaggedError("FederatedIdentity/TargetGone")<{
  readonly message: string;
  readonly userId: Users.UserId;
}> {}

/** The anchor changed under the resolution twice in a row (a pathological interleaving). Never a defect. */
export class Contended extends Data.TaggedError("FederatedIdentity/Contended")<{
  readonly message: string;
}> {}

export type ResolveError = EmailInUse | Contended | HookPoint.HookAborted | StoreUnavailable;
export type AttachError = LinkedElsewhere | TargetGone | Contended | StoreUnavailable;

export interface FederatedIdentityShape {
  /**
   * The anchor's user, else the address holder if `trust` allows (auto-link), else a new user through
   * `SignUp` (`BeforeSignUp` with `strategy = providerId`; verified in the same unit when `trust`
   * allows). A lost race reads the anchor again, once: the winner's user is the answer.
   */
  readonly resolve: (identity: ExternalIdentity, trust: EmailTrust) => Effect.Effect<Resolved, ResolveError>;
  /** The explicit "link this provider to my account" flow (no email policy: the caller is signed in as `userId`). */
  readonly attach: (identity: ExternalIdentity, userId: Users.UserId) => Effect.Effect<Attached, AttachError>;
}
```

Type-system notes:

- `trust` is a required parameter, so no caller can forget its policy, and the policy is data the caller computes from its own configuration.
- `ResolveError` and `AttachError` are closed. OAuth and SAML map them with `Effect.catchTags`; `HookAborted` and `StoreUnavailable` pass through (both plugins' error unions already carry them). A new refusal added here is a type error at every caller until mapped.
- `Phone` collisions cannot happen (no federated party creates a phone identity, FAMS-002), so `SignUp/IdentityTaken{Phone}` is an invariant defect inside the module, not a member of `ResolveError`.
- `untrusted` and `trusted` are a plain constant and a plain function; the annotations on them are not Effect/Layer annotations.

### 3.3 Implementation sketch

```ts
import { AccountContract } from "@awthaq/api";
import { Defects } from "@awthaq/ports";
import * as Schema from "effect/Schema";
import * as Accounts from "./Accounts.ts";
import * as AuthEvents from "./AuthEvents.ts";
import * as SignUp from "./SignUp.ts";
import * as Users from "./Users.ts";

// TS2883: what `make`'s requirements mention rides this namespace, as in `SignUp.ts:38-49`.
export { Accounts } from "./Accounts.ts";
export { AfterSignIn, AfterSignUp, BeforeSessionIssue, BeforeSignIn, BeforeSignUp } from "./Hooks.ts";
export { SignInContinuationRegistry } from "./SignInContinuationRegistry.ts";

/** The anchor moved under this attempt (a concurrent link, create, unlink or erasure). Module-private: never escapes `make`. */
class Lost extends Data.TaggedError("FederatedIdentity/Lost")<{}> {}
const isLost = (error: unknown): error is Lost => error instanceof Lost;

/** One re-read after a lost race; a second loss is `Contended`. */
const onceMore = <A, E, R>(attempt: Effect.Effect<A, E | Lost, R>) =>
  attempt.pipe(
    Effect.catchIf(isLost, () => attempt),
    Effect.catchIf(isLost, () =>
      Effect.fail(new Contended({ message: "awthaq: the federated identity changed twice while it was resolved" })),
    ),
  );

const isImageUrl = Schema.is(AccountContract.ImageUrl); // moved from `OAuth.ts:141-142`

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();
const withinDomains = (domains: "any" | ReadonlyArray<string>, address: string) =>
  domains === "any" || domains.includes(domainOf(address));

/** TMS-007, BEH-EA-124, BEH-EA-245, decided once: trusted party, address in its domains, both sides verified. */
const refusalOf = (
  trust: EmailTrust,
  email: AssertedEmail,
  holder: Users.UserRecord,
): Option.Option<EmailRefusal> =>
  trust._tag === "Untrusted"
    ? Option.some("untrusted")
    : !withinDomains(trust.domains, email.address)
      ? Option.some("outsideTrustedDomains")
      : !email.verified
        ? Option.some("claimUnverified")
        : !Users.isEmailVerified(holder)
          ? Option.some("localUnverified")
          : Option.none();

/** AOMS-007: the same verdict, minus the local side, marks a created user verified in the sign-up's unit. */
const verifiesOnCreate = (trust: EmailTrust, email: Option.Option<AssertedEmail>) =>
  trust._tag === "Trusted" &&
  Option.isSome(email) &&
  email.value.verified &&
  withinDomains(trust.domains, email.value.address);

/** FAMS-002: no address, an Anonymous user (upgradeable through `Users.promoteIdentity`). */
const identityOf = (email: Option.Option<AssertedEmail>): Users.IdentityInput =>
  Option.match(email, {
    onNone: () => ({ _tag: "Anonymous" }),
    onSome: (asserted) => ({ _tag: "Email", email: asserted.address }),
  });

/** Case and image rules applied once, before any read (D6, D7). */
const normalized = (identity: ExternalIdentity): ExternalIdentity => ({
  ...identity,
  email: Option.map(identity.email, (asserted) => ({ ...asserted, address: asserted.address.toLowerCase() })),
  image: Option.filter(identity.image, isImageUrl),
});

export const make = Effect.gen(function* () {
  const users = yield* Users.Users;
  const accounts = yield* Accounts.Accounts;
  const events = yield* AuthEvents.AuthEvents;
  const signUp = yield* SignUp.make;

  const anchorOf = (identity: ExternalIdentity) =>
    accounts.findByProviderSubject(identity.providerId, identity.subject, Option.getOrUndefined(identity.issuer));

  const linkFor = (identity: ExternalIdentity): SignUp.LinkInput => ({
    providerId: identity.providerId,
    subject: identity.subject,
    ...Option.match(identity.issuer, { onNone: () => ({}), onSome: (issuer) => ({ issuer }) }),
    ...Option.match(identity.tokens, { onNone: () => ({}), onSome: (tokens) => ({ tokens }) }),
  });

  /** BE-002: a returning sign-in replaces the stored set; an account that vanished since the read is a lost race (was `OAuth.ts:1108`'s die). */
  const refresh = (account: Accounts.AccountRecord, identity: ExternalIdentity) =>
    Option.match(identity.tokens, {
      onNone: () => Effect.void,
      onSome: (tokens) =>
        accounts
          .updateProviderTokens(account.id, tokens)
          .pipe(Effect.catchTag("AccountNotFound", () => Effect.fail(new Lost()))),
    });

  /** A link this module made is announced (Q3); a lost link is a lost race (was `Saml.ts:1169`'s die). */
  const linkTo = (identity: ExternalIdentity, userId: Users.UserId, via: "emailMatch" | "explicit") =>
    accounts.link({ ...linkFor(identity), userId }).pipe(
      Effect.catchTag("AccountAlreadyLinked", () => Effect.fail(new Lost())),
      Effect.andThen(events.publish({ _tag: "auth.account.linked", userId, providerId: identity.providerId, via })),
    );

  const resolveOnce = Effect.fnUntraced(function* (identity: ExternalIdentity, trust: EmailTrust) {
    const anchored = yield* anchorOf(identity);
    if (Option.isSome(anchored)) {
      yield* refresh(anchored.value, identity);
      return linked(anchored.value.userId);
    }
    if (Option.isSome(identity.email)) {
      const holder = yield* users.findByEmail(identity.email.value.address);
      if (Option.isSome(holder)) {
        const refusal = refusalOf(trust, identity.email.value, holder.value);
        if (Option.isSome(refusal)) {
          return yield* new EmailInUse({
            message: "awthaq: the asserted address belongs to an account this identity is not linked to",
            holder: holder.value.id,
            reason: refusal.value,
            claimVerified: identity.email.value.verified,
          });
        }
        yield* linkTo(identity, holder.value.id, "emailMatch");
        return autoLinked(holder.value.id);
      }
    }
    const vetted = yield* signUp.vet({
      identity: identityOf(identity.email),
      name: Option.getOrElse(identity.name, () =>
        Option.match(identity.email, { onNone: () => identity.subject, onSome: (asserted) => asserted.address }),
      ),
      strategy: identity.providerId,
    });
    const user = yield* signUp
      .create(vetted, {
        verified: verifiesOnCreate(trust, identity.email),
        ...Option.match(identity.image, { onNone: () => ({}), onSome: (image) => ({ image }) }),
        link: linkFor(identity),
      })
      .pipe(
        Effect.catchTag("SignUp/IdentityTaken", (taken) =>
          taken.kind === "Phone"
            ? Defects.invariantViolation("FederatedSignUpPhone", taken.message)
            : // The address or the anchor was claimed between our reads and this insert: read again.
              Effect.fail(new Lost()),
        ),
      );
    return created(user);
  });

  const attachOnce = Effect.fnUntraced(function* (identity: ExternalIdentity, userId: Users.UserId) {
    const anchored = yield* anchorOf(identity);
    if (Option.isSome(anchored)) {
      if (anchored.value.userId !== userId) {
        return yield* new LinkedElsewhere({ message: "awthaq: that identity is linked to another account" });
      }
      yield* refresh(anchored.value, identity);
      return attached(userId, true);
    }
    yield* users
      .findById(userId)
      .pipe(Effect.catchTag("UserNotFound", () => Effect.fail(new TargetGone({ message: "awthaq: no such user", userId }))));
    yield* linkTo(identity, userId, "explicit");
    return attached(userId, false);
  });

  return {
    resolve: (identity, trust) => onceMore(resolveOnce(normalized(identity), trust)),
    attach: (identity, userId) => onceMore(attachOnce(normalized(identity), userId)),
  } satisfies FederatedIdentityShape;
});
```

Executor notes:

- `linked`, `autoLinked`, `created`, `attached` are module-private plain constructors with an annotated return type (`(userId: Users.UserId): Resolved => ({ _tag: "Linked", userId })`), as `SignUp.ts:251-259` does for its `Outcome`, so the generator's union return infers without `as const`.
- `Effect.catchIf(isLost, ...)` rather than `catchTag("FederatedIdentity/Lost")`: with a generic `E | Lost` the tag form may not narrow (the precedent is `SignUp.ts:214-222`). Inside `resolveOnce`/`attachOnce` the types are concrete, so `catchTag` is fine there.
- `Option.some("untrusted")` takes its literal type from `refusalOf`'s return annotation; if TS widens it, write `Option.some<EmailRefusal>("untrusted")` (a type argument, not an assertion).
- The re-read re-runs everything, including `signUp.vet`. That means a create race runs `BeforeSignUp` twice and announces `auth.user.created` once (only the winner's unit commits). Recorded in the BEH entry and Q6.
- No transaction is opened here: each write is one atomic primitive (or `SignUp`'s own unit), and correctness comes from the unique constraints plus the re-read (§2.2). A caller already inside a transaction (an RLS tenant transaction) gets savepoints from `SignUp`; the SQL suite pins that nesting (§5.1 #24).
- `Users.UserNotFound`'s tag is `UserNotFound` (as caught at `SignUp.ts:178`).

### 3.4 What each plugin keeps (call sites after the plan)

**OAuth** (`OAuth.ts:1092-1250` become about 45 lines):

```ts
const federation = yield* FederatedIdentity.make; // replaces `creation = SignUp.make` (`:830`)

/** BEH-EA-124: a named provider is trusted for any address it verifies. Phase 5 adds a connection's own verdict. */
const emailTrustOf = (config: OAuthConfigShape, providerId: string) =>
  trustedProvidersOf(config).includes(providerId) ? FederatedIdentity.trusted("any") : FederatedIdentity.untrusted;

// inside callbackFlow, after `no-subject` (`:1088-1090`):
const identity: FederatedIdentity.ExternalIdentity = {
  providerId,
  subject: profile.subject,
  issuer: provider.issuer,
  email: Option.map(Option.fromNullishOr(profile.email), (address) => ({
    address,
    verified: profile.emailVerified === true,
  })),
  name: Option.fromNullishOr(profile.name),
  image: Option.fromNullishOr(profile.image),
  tokens: Option.some(toProviderTokenSet(tokens, exchangedAt)),
};
if (flow.link !== undefined) {
  // An authenticated caller links their own account: no email policy, no new session.
  yield* federation.attach(identity, Users.UserId(flow.link.userId)).pipe(
    Effect.catchTags({
      "FederatedIdentity/LinkedElsewhere": () => CallbackFailure.callbackFailed("account-already-linked"),
      "FederatedIdentity/TargetGone": () => CallbackFailure.callbackFailed("account-missing"),
      "FederatedIdentity/Contended": () => CallbackFailure.callbackFailed("identity-contended"),
    }),
  );
  return { callbackURL: flow.callbackURL, session: undefined };
}
const resolved = yield* federation.resolve(identity, emailTrustOf(config, providerId)).pipe(
  Effect.catchTags({
    // BEH-EA-123, NAM-006: the holder's real providers, only when this provider vouched for the address.
    "FederatedIdentity/EmailInUse": (inUse) =>
      Effect.flatMap(conflictingProviders(inUse.holder, inUse.claimVerified), (providers) =>
        Effect.fail(new OAuthApi.AccountExists({ providers })),
      ),
    "FederatedIdentity/Contended": () => CallbackFailure.callbackFailed("identity-contended"),
  }),
);
const issued = yield* completion.complete({ userId: resolved.userId, strategy: providerId, amr: ["fed"] }, ...); // unchanged
```

`CallbackFailure.ts:30-50` gains the reason `"identity-contended"`. `isImageUrl` (`:141-142`) and the `AccountExists`-on-race lookup (`:1228-1238`) are deleted. `trustedProvidersOf` and `conflictingProviders` stay (verdict and wire policy).

**SAML** (`Saml.ts:1144-1194` become about 25 lines):

```ts
const federation = yield* FederatedIdentity.make; // replaces `creation = SignUp.make` (`:847`)

/** BEH-EA-245: a connection that trusts email is trusted only for the domains it claims (BEH-EA-317, Q2). */
const emailTrustOf = (connection: SamlRecords.ConnectionRecord) =>
  connection.trustsEmail ? FederatedIdentity.trusted(connection.emailDomains) : FederatedIdentity.untrusted;

// inside signIn:
const resolved = yield* federation
  .resolve(
    {
      providerId,
      subject: assertion.nameId.value,
      issuer: Option.some(connection.idpEntityId),
      email: Option.map(Option.fromNullishOr(emailOf(assertion)), (address) => ({ address, verified: true })),
      name: Option.fromNullishOr(attributeOf(assertion, NAME_ATTRIBUTES)),
      image: Option.none(),
      tokens: Option.none(),
    },
    emailTrustOf(connection),
  )
  .pipe(
    Effect.catchTags({
      "FederatedIdentity/EmailInUse": () => Effect.fail(new AssertionInvalid({ reason: "emailInUse" })),
      "FederatedIdentity/Contended": () => Effect.fail(new AssertionInvalid({ reason: "identityContended" })),
    }),
  );
// then `completion.complete({ userId: resolved.userId, ... continuation })` exactly as `:1199-1225`.
```

Both refusals stay the uniform `SamlAssertionRejected` on the wire (`acs` `:1261-1263`), with the reason logged and published.

### 3.5 Policies decided once

1. **A lost race resolves to the anchor.** One re-read. A second loss is `Contended`, mapped to each flow's uniform refusal (OAuth `OAuthCallbackFailed`, SAML `SamlAssertionRejected`): it is not an outage (ADR-EA-028 reserves `StoreUnavailable` for infrastructure) and not a defect (ADR-EA-038 decision 4).
2. **Trust is the caller's verdict; the rule is the module's.** Auto-link needs `Trusted` ∧ address in its domains ∧ claim verified ∧ local verified. Verify-on-create needs the first three. `Untrusted` never links and never verifies. Static OAuth providers named in `trustedProviders` are `trusted("any")`; a SAML connection with `trustsEmail` is `trusted(connection.emailDomains)` (Q2; an empty list then links nothing); an OIDC connection gets its own verdict in Phase 5 (Q4).
3. **The anchor wins over the email.** A returning identity resolves to its anchor's user whatever the address says now (an address changed at the provider never moves an account, BEH-EA-125).
4. **Explicit link is idempotent for the same user and refused for another.** Repeating a link refreshes tokens; an identity linked elsewhere is `LinkedElsewhere`; a vanished target is `TargetGone`.
5. **Announcements.** `Created` is announced by `SignUp` (`auth.user.created`, `AfterSignUp`), unchanged. An auto-link and a new explicit link publish `auth.account.linked { userId, providerId, via }` (Q3); `Linked` and `Attached{already}` publish nothing (nothing changed). The subject is not in the event: a SAML NameID is often an email address (ADR-EA-029).
6. **Tenancy.** The module is tenant-agnostic: `Users` and `Accounts` are global. A caller that resolves under a tenant (SAML `:1254-1257`) keeps doing so around both resolution and sign-in.

---

## 4. Phased migration

Every phase gate: `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`. Phases 1 and 5 also run `pnpm test:pg` (new SQL suite; a migration). Plan gate: `pnpm check && pnpm test:pg`. One ticket per phase under `.scratch/federated-identity/issues/`.

**Preconditions:** re-run `grep -rn "findByProviderSubject\|\.link({" packages/*/src` and confirm §2.4 is complete; re-verify the §2.1 line numbers.

### Phase 0: HOTFIX — SAML answers a lost race by reading the anchor again (shippable alone)

Tests first (they fail on HEAD with exactly B1 and B3, and B2 as a refusal):

1. `packages/test/src/Rendezvous.ts` (new, exported from `packages/test/src/index.ts` as `Rendezvous`):

   ```ts
   /** A one-shot meeting point: the first `parties - 1` arrivals wait for the last; later arrivals pass straight through. */
   export const make = (parties: number) =>
     Effect.gen(function* () {
       const arrived = yield* Ref.make(0);
       const open = yield* Deferred.make<void>();
       const arrive = Effect.flatMap(Ref.updateAndGet(arrived, (n) => n + 1), (n) =>
         n >= parties ? Effect.asVoid(Deferred.succeed(open, undefined)) : Deferred.await(open),
       );
       return { arrive };
     });

   /** `Accounts` whose anchor read meets `parties` callers before any of them goes on (no write can slip between the reads). */
   export const anchorReadsMeet = (parties: number) =>
     Layer.effect(
       Accounts.Accounts,
       Effect.gen(function* () {
         const inner = yield* Accounts.Accounts;
         const meeting = yield* make(parties);
         return Accounts.Accounts.of({
           ...inner,
           findByProviderSubject: (providerId, subject, issuer) =>
             Effect.tap(inner.findByProviderSubject(providerId, subject, issuer), () => meeting.arrive),
         });
       }),
     );
   ```

   The rendezvous sits at the anchor read, so the tests do not depend on what either implementation does next (the hotfix, then the resolver, pass the same tests).
2. `packages/saml/test/support.ts:79`: widen `SamlLive`'s `Wrapped extends Sessions.Sessions | Users.Users` to include `Accounts.Accounts`.
3. `packages/saml/test/Saml.test.ts`, new `describe("concurrent first sign-ins for one NameID (plan 14)")` with three cases, each two ACS with distinct AuthnRequests and assertion ids, `Effect.all(..., { concurrency: "unbounded" })`, over `SamlLive({}, undefined, undefined, Rendezvous.anchorReadsMeet(2))`:
   - "an anonymous NameID (no email) signs in once and resolves once: both ACS succeed as one user" (B1, today a defect);
   - "an email NameID: both ACS succeed as one user, one user row" (B2, today `SamlAssertionRejected`);
   - "a trustsEmail connection: both ACS sign in as the verified local user, one account" (B3, today a defect).

Fix (`saml/src/Saml.ts`, in place, deleted again in Phase 3):

```ts
/** Phase 0 (plan 14): a lost race is not a conflict: the anchor the winner wrote names the user. */
const anchoredOr = (fallback: AssertionInvalid) =>
  accounts.findByProviderSubject(providerId, subject, connection.idpEntityId).pipe(
    Effect.flatMap(
      Option.match({ onNone: () => Effect.fail(fallback), onSome: (account) => Effect.succeed(account.userId) }),
    ),
  );
```

- `:1169`: `Effect.catchTag("AccountAlreadyLinked", () => anchoredOr(new AssertionInvalid({ reason: "emailInUse" })))`, and return its user id instead of `existing.value.id` when it fires.
- `:1180-1192`: map `created` to `created.id` before the catch; `IdentityTaken{Phone}` stays the invariant; `{Email}` and `{Account}` become `anchoredOr(new AssertionInvalid({ reason: "emailInUse" }))`.
- Spec: `29-saml-sp.md` BEH-EA-245 Implementation paragraph gains "a first sign-in that loses a race to a concurrent one for the same NameID signs in as the user the winner linked (never a server error)"; revision 1.8 → 1.9.
- Changeset `.changeset/saml-acs-lost-race.md` (`@awthaq/saml`: patch): "Two concurrent ACS requests for one new NameID no longer answer 500 (or reject the second); the second signs in as the user the first created or linked (BEH-EA-245)."

### Phase 1: `FederatedIdentity` in core (additive)

1. `packages/core/src/FederatedIdentity.ts` (§3.2, §3.3). `packages/core/src/index.ts`: `export * as FederatedIdentity from "./FederatedIdentity.ts"`, and add the module to the header comment's list (`:17-21` pattern).
2. `packages/core/src/AuthEventSchemas.ts`: `AccountLinkedEvent = defineEvent("auth.account.linked", { userId: UserIdSchema, providerId: Schema.String, via: Schema.Literals(["emailMatch", "explicit"]) }, { actor: Actor.field("userId"), pii: [] })`, plus its `type`, and add it to `registry([...])` (`:1708`). (If Q3 is "no", drop this item and the `events.publish` in `linkTo`.)
3. Tests (§5.1): `packages/core/test/FederatedIdentity.test.ts` (memory), `packages/core/test/FederatedIdentitySql.test.ts` (SQLite; Postgres), `packages/core/test/FederatedIdentity.types.test.ts` (closed unions, required `trust`). Add the SQL file to `scripts/test-pg.sh`'s `suites` (beside `packages/core/test/SignUpSql.test.ts`).
4. Spec §6.1 for the new BEH, `13-events.md`, glossary, overview; ADR-EA-043 (§6.2) with status "Accepted — in progress".
5. Changeset `.changeset/federated-identity.md` (§6.4).

Gate: the phase gate plus `pnpm test:pg`.

### Phase 2: OAuth onto the resolver

Tests first, in `packages/oauth/test/OAuth.test.ts` (they fail on HEAD as B5, B7, B8):

- widen `buildLayer`'s `Wrapped` to include `Accounts.Accounts`;
- "two concurrent first callbacks for one provider identity sign in as one user" (B5, email; the race regression this plugin keeps);
- "an explicit link of an identity linked to another user is OAuthCallbackFailed and leaves that user's tokens unchanged" (B7);
- "an account unlinked between its read and the token refresh is resolved again (AccountExists), not a server error" (B8; an `Accounts` decorator that removes the account right after the first anchor read).

Then:

1. `oauth/src/OAuth.ts`: `federation = FederatedIdentity.make` replaces `creation = SignUp.make` (`:829-830`); `emailTrustOf` beside `trustedProvidersOf` (`:844-845`); `:1092-1250` become §3.4; delete `isImageUrl` (`:141-142`) and its `AccountContract` import if unused; keep `issuerField` only if another use remains (`accountAnchorFor` `:249-254` does not use it), else delete.
2. `oauth/src/CallbackFailure.ts`: add `"identity-contended"`.
3. Delete the moved tests (§2.5, §5.3).
4. Spec: `16-oauth.md` BEH-EA-123/124/125 (§6.1). README `packages/oauth/README.md:95-102`: the migration table gains "an explicit link of a provider identity already linked to another account answers `OAuthCallbackFailed` (`account-already-linked`)".
5. Changeset `.changeset/oauth-federated-identity.md` (§6.4).

Gate: phase gate, `pnpm test:bdd` (REQ-EA-335..340, 685 unchanged in meaning).

### Phase 3: SAML onto the resolver

1. `saml/src/Saml.ts`: `federation = FederatedIdentity.make` replaces `creation = SignUp.make` (`:847`); `emailTrustOf`; `:1144-1194` become §3.4; the Phase 0 `anchoredOr` is deleted.
2. `packages/saml/test/Saml.test.ts`: delete `:566` (moved); rewrite `:589` as "a trustsEmail connection links a verified local account inside its domains; an address outside them is rejected" (Q2); keep the Phase 0 anonymous-NameID case as this plugin's race regression and delete the other two Phase 0 cases (moved to §5.1 #10).
3. Add "a trustsEmail connection creates its first-time user with the address verified" (Q1).
4. Spec: `29-saml-sp.md` BEH-EA-245 (§6.1), `spec/models/10-saml.md:63` (`trustsEmail` bounded by `emailDomains`). README `packages/saml/README.md:35`.
5. Changeset `.changeset/saml-federated-identity.md` (§6.4, with `Migration:`).

Gate: phase gate, `pnpm test:bdd` (REQ-EA-905..910, 1306).

### Phase 4: seal the seam, docs, BDD

1. `packages/core/test/SignInSeams.test.ts`: new `it("a federated sign-in resolves its identity only through FederatedIdentity")`: over the sources whose path starts with `oauth/src/` or `saml/src/` (and `organization/src/`), `countOf(/\baccounts\s*\.\s*(link|findByProviderSubject|updateProviderTokens)\(|\bSignUp\.make\b/g)` must be `{}`. And `SignUp.make` callers anywhere are pinned with `assertExactly`: `core/src/FederatedIdentity.ts` (1), `password/src/Password.ts`, `magic-link/src/Channel.ts`, `scim/src/Scim.ts` (counts at execution), each with its `why`.
2. BDD (§5.4): scenarios in `16-oauth.feature` and `29-saml-sp.feature`; `SamlWorld.ts:183-192` and the OAuth world gain a `decorate` slot for `Rendezvous.anchorReadsMeet`.
3. `docs/plugin-authoring.md:181-187` ("Completing a sign-in and creating a user"): a new bullet, "**Federated identity.** A plugin whose credential is an external party's assertion builds an `ExternalIdentity` and its own `EmailTrust` verdict and calls `FederatedIdentity.resolve` (or `attach` for an explicit link). It never reads an account anchor, links an account or calls `SignUp` itself: the resolver owns the email policy and the lost-race re-read. Map `EmailInUse` and `Contended` to your uniform refusal." Checklist item 8 (`:249`) gains `FederatedIdentity`.
4. ADR-EA-043 → "Accepted — implemented"; ADR-EA-038 revision 1.2 (§6.2); traceability (§6.3).

### Phase 5: per-connection trust for OIDC organization connections (Q4; recommended)

1. `organization/src/ConnectionRecords.ts`: `trustsEmail: boolean` on `ConnectionRecord` (`:38-61`), the input and patch types (`:64-95`), memory twin (`:256-272`, `:336`), SQL row/insert/update (`:407`, `:424-438`, `:592`, `:617`); a migration in `organization/src/OrganizationMigrations.ts` adding `"trustsEmail" BOOLEAN NOT NULL DEFAULT FALSE` (pg) / `INTEGER NOT NULL DEFAULT 0` (sqlite), as SAML did (`Saml.ts:217-219`). If plan 22 has landed, the DDL goes where 22 put the table's DDL.
2. `organization/src/OrganizationConnections.ts`: `ConnectionView.trustsEmail` (`:220-240`), the store's create/update inputs (`:255-280`), the API payloads in `OrganizationApi.ts`; `buildSet` (`:155-172`) passes `emailTrust: record.trustsEmail ? FederatedIdentity.trusted(record.emailDomains) : FederatedIdentity.untrusted`.
3. `oauth/src/OAuthConnections.ts:26-31`: `OAuthConnection` gains `readonly emailTrust?: FederatedIdentity.EmailTrust` (absent = untrusted); `OAuthProviders.get` (`OAuthProviders.ts:41-46`) exposes it on the `ResolvedProvider` (`OAuthProvider.ts:147-163`) as `emailTrust: Option.Option<EmailTrust>`; `emailTrustOf(config, provider)` prefers the provider's own verdict, else `trustedProviders`.
4. Tests: `organization/test/ConnectionRecords.test.ts` (round-trip, both adapters, Postgres), `OrganizationConnections.test.ts` (the view and the resolver carry the verdict), and OAuth's `EP-004` describe (`OAuth.test.ts:3494`): "a connection that trusts email auto-links a verified local account inside its domains; outside them it is AccountExists".
5. Spec `35-organization.md` BEH-EA-235 and `spec/models/14-organization.md`; changeset (§6.4).

---

## 5. Test plan

Replace, don't layer: the resolution is tested once, at `FederatedIdentity`'s interface, over memory and SQL; plugins keep protocol, verdict wiring, refusal mapping and one race regression each.

### 5.1 `packages/core/test/FederatedIdentity.test.ts` (memory) and `FederatedIdentitySql.test.ts`

The environment is `SignUp.test.ts:61-90`'s (`Persistence.memory`, `AuthEvents.layer`, `SqlTransaction.layerNoop`, recording taps), plus `FederatedIdentity.make`. A `suite(name, env)` runs cases 1 to 20 against both envs; `FederatedIdentitySql.test.ts` builds the SQL env as `SignUpSql.test.ts:66-91` does (`TestSql.layer("core_FederatedIdentitySql")`, so Postgres under `test:pg`).

`describe("FederatedIdentity.resolve")`:

1. `Linked: a returning identity resolves to its anchor's user, creates nothing, runs no BeforeSignUp, and replaces the stored token set (BE-002)`
2. `BEH-EA-125/INV-EA-015: the anchor is the triple: the same subject under another issuer or providerId is another identity`
3. `TMS-007/BEH-EA-124/245: an address held by a local user` (table, each row asserting the outcome, that no account exists on a refusal, the `reason`, and `auth.account.linked{emailMatch}` exactly once on a link):

   | trust | claim verified | local verified | address domain | outcome |
   |---|---|---|---|---|
   | `untrusted` | yes | yes | any | `EmailInUse{untrusted}` |
   | `trusted("any")` | no | yes | any | `EmailInUse{claimUnverified}` |
   | `trusted("any")` | yes | no | any | `EmailInUse{localUnverified}` |
   | `trusted("any")` | yes | yes | any | `AutoLinked`, tokens stored |
   | `trusted(["acme.example"])` | yes | yes | `acme.example` | `AutoLinked` |
   | `trusted(["acme.example"])` | yes | yes | `other.example` | `EmailInUse{outsideTrustedDomains}` |
   | `trusted([])` | yes | yes | any | `EmailInUse{outsideTrustedDomains}` |

4. `AOMS-007: a created user is verified exactly when the party is trusted, the address is in its domains and the claim is verified` (table: untrusted+claim → unverified; trusted+claim → verified; trusted+no claim → unverified; trusted(domains)+outside → unverified)
5. `FAMS-002: no address creates an Anonymous user named after the subject, never a synthetic email; the next resolve is Linked to it`
6. `NAM-009: an http(s) image lands on the created user; javascript: and data: are dropped`
7. `the name falls back to the address, then the subject`
8. `BEH-EA-323: BeforeSignUp sees strategy = providerId; a veto is HookAborted and nothing is created`
9. `an address asserted in another case matches its holder, and the domain bound folds case`
10. `a lost race resolves to the anchor` (rendezvous at the anchor read, two concurrent resolves): (a) anonymous: one `Created` and one `Linked`, same user, one user, one account, `auth.user.created` once; (b) email: the same; (c) trusted auto-link: one `AutoLinked` and one `Linked`, one account, `auth.account.linked` once
11. `an account removed between the anchor read and the token refresh is resolved again (the email policy decides), never a defect`
12. `a resolution that loses twice is Contended` (an `Accounts` whose `link` always answers `AccountAlreadyLinked` while the anchor read stays `None`)
13. `ADR-EA-028: an outage of the anchor read or the holder read is StoreUnavailable`

`describe("FederatedIdentity.attach")`:

14. `REQ-EA-337: attaches to the target user whatever the address says, publishes auth.account.linked{explicit}`
15. `BE-002: the token set lands on the attached account`
16. `a repeated attach to the same user is already: true, replaces the tokens, and publishes nothing`
17. `an identity linked to another user is LinkedElsewhere, and that user's tokens are unchanged` (B7)
18. `a vanished target user is TargetGone and nothing is linked` (D5)
19. `two concurrent attaches to one user: one already: false, one already: true`
20. `two concurrent attaches to two users: one Attached, one LinkedElsewhere`

`FederatedIdentitySql.test.ts` only:

21. `over a real transaction, a create race leaves one user row, one account row and one auth.user.created audit row`
22. `over a real transaction, an auto-link race leaves one account row and one auth.account.linked audit row`
23. `the losing sign-up's unit leaves nothing behind (no second user, no orphan account)`
24. `a resolve nested in an outer transaction (the RLS tenant shape) that loses its create recovers: the savepoint rolls back and the outer transaction stays usable`

`FederatedIdentity.types.test.ts`: `// @ts-expect-error` that `resolve` without `trust` does not compile; that a `catchTags` map missing `"FederatedIdentity/EmailInUse"` leaves it in the error channel (asserted with `Effect.Effect<..., never>` assignment failing); and that `Lost` is not exported.

### 5.2 Plugin tests after the plan

- **OAuth** keeps: REQ-EA-339 (`:523`) and REQ-EA-340 (`:566`) as the `trustedProviders` verdict wiring; REQ-EA-337 (`:613`) as the `attach` wiring (no session); NAM-006 (`:924`, `:951`) as the `EmailInUse` wire mapping; FAMS-006 (`:973`); BE-002 token-set construction (`:3250`, `:3289`, `:3319`); the sign-in wiring describe (`:3679-3778`); and the three Phase 2 regressions (race, explicit link elsewhere, refresh race). Phase 5 adds the connection-trust case to `EP-004` (`:3494`).
- **SAML** keeps: the validation chain, the rewritten `:589` verdict wiring, `:620`, `:646`, `SamlSignIn.test.ts` (continuation, tenant, `accountMissing`), and the Phase 0 anonymous-NameID race regression; Phase 3 adds verify-on-create.

### 5.3 Tests deleted, by name

- `oauth/test/OAuth.test.ts`: "REQ-EA-335/336: an unlinked email match fails with AccountExists, nothing is linked" (`:456`); "REQ-EA-338: a provider not named in trustedProviders never auto-links" (`:492`); "TMS-007: a trusted provider does not auto-link into an unverified local account" (`:671`); "TMS-007: a trusted provider still auto-links into a verified local account" (`:695`); the three AOMS-007 cases (`:716`, `:737`, `:763`); "FAMS-002: a provider profile without an email creates an Anonymous user, never a synthetic email" (`:782`); the two NAM-009 cases (`:816`, `:849`); "a returning user (same provider/subject) signs in without creating a second account" (`:1024`); "re-authenticating an already-linked account overwrites the stored token set with the fresh one" (`:3353`); "an authenticated caller's explicit link also persists the exchanged token set" (`:3416`); "auto-linking a trusted provider to an existing user also persists the token set" (`:3449`). Fourteen tests, replaced by §5.1 #1, #3, #4, #5, #6, #15.
- `saml/test/Saml.test.ts`: "an assertion never links to an existing account by email alone" (`:566`), replaced by §5.1 #3 row 1; the Phase 0 email and trustsEmail race cases, replaced by §5.1 #10 (b) and (c).

### 5.4 BDD (`features/`)

New REQ ids are the next free ones at execution (above `REQ-EA-1306` today; sibling plans also allocate, so re-run `features/scripts/allocate-req-ea.py`).

- `13-enterprise-federation/29-saml-sp.feature`, rule BEH-EA-245: "Two concurrent first sign-ins for one NameID sign in as one user" (the live bug at acceptance level); "A connection that trusts email links only addresses in its own domains" (Q2).
- `05-authentication-methods/16-oauth.feature`, rule BEH-EA-125: "Two concurrent first callbacks for one provider identity sign in as one user"; rule BEH-EA-123: "Linking an identity already linked to another account is refused, and that account is untouched".
- Unchanged in meaning and still passing: REQ-EA-335 to 340, 685, 905 to 910, 1306.

---

## 6. Spec, ADR, traceability and changesets

### 6.1 Behaviour specs (each gets a Document Control revision and a change-history line)

- `spec/behaviors/06-domain-users-accounts.md` (1.9 → 1.10): **new BEH-EA-<next free, above 337>** "A federated sign-in resolves its identity through `FederatedIdentity`, and a lost race resolves to the anchor's user", after BEH-EA-323, in the same shape:

  ```text
  REQUIREMENT: Every flow that turns an external party's assertion into a
               local user (OAuth, an organization's OIDC or SAML connection)
               MUST resolve it through `FederatedIdentity`: the account at
               (providerId, subject, issuer) if one exists; else the local
               holder of the asserted address, linked only when the caller's
               verdict trusts the party, the address lies in the trusted
               domains, the party vouches for it and the holder's own address
               is verified; else a new user through `SignUp`, verified in the
               same unit under the same verdict minus the holder. A request
               that loses a race to a concurrent one for the same identity
               MUST read the anchor again and resolve to its user, never fail
               as a conflict or a defect. An explicit link MUST refuse an
               identity linked to another user and MUST be idempotent for the
               same user. A link the module makes MUST publish
               `auth.account.linked`.
  ```

  "As shipped" names the outcomes and refusals, `Contended` after a second loss, the double `BeforeSignUp` on a create race (Q6), and the tests.
- BEH-EA-322/323 "As shipped": one sentence each pointing at the new entry (federated callers reach `SignUp` through `FederatedIdentity`).
- `spec/behaviors/16-oauth.md` (1.3 → 1.4): BEH-EA-123 (an explicit link of an identity linked elsewhere is refused: `OAuthCallbackFailed`, reason `account-already-linked`); BEH-EA-124 ("Both sides must be proven" paragraph: decided by `FederatedIdentity`; a connection's own verdict after Phase 5); BEH-EA-125 (a lost race resolves to the anchor; a returning sign-in that finds its account gone is resolved again).
- `spec/behaviors/29-saml-sp.md` (1.9 from Phase 0 → 1.10): BEH-EA-245 requirement text adds "and the address lies in one of the connection's claimed domains (BEH-EA-317)" (Q2); Implementation paragraph: resolution through `FederatedIdentity`, verify-on-create for a trusting connection (Q1), the race.
- `spec/behaviors/35-organization.md` (1.7 → 1.8, Phase 5): BEH-EA-235, a connection's `trustsEmail` bounded by its `emailDomains`.
- `spec/behaviors/13-events.md` (1.7 → 1.8): taxonomy gains `auth.account.linked` (`userId`, `providerId`, `via: emailMatch | explicit`; no subject, ADR-EA-029).
- `spec/invariants.md` (1.5 → 1.6): INV-EA-015 Enforcement cell names `FederatedIdentity` as the one reader-then-writer of the anchor and `FederatedIdentity.test.ts`.
- `spec/glossary.md` (1.5 → 1.6): **External identity** (what an asserting party proved: provider id, subject, issuer, an asserted email, profile, tokens); **Email trust** (the caller's verdict: untrusted, or trusted for any domain or for a list); **Federated identity resolution** (anchor, else trusted email match, else sign-up; a lost race resolves to the anchor). Update **Account** (`:35`): keyed on `(provider, subject, issuer)`.
- `spec/overview.md` (1.9 → 1.10): core module table (`:158-160` area) gains `FederatedIdentity` (`make`, like `SignIn`/`SignUp`, `FederatedIdentity.ts`).
- `spec/models/10-saml.md:63` and `spec/models/02-oauth-oidc.md` linking paragraphs; `spec/models/14-organization.md` in Phase 5.

### 6.2 Decisions

- **New ADR-EA-043** `spec/decisions/043-federated-identity-resolution.md`, "Federated Identity Resolution Is a Core Module; a Lost Linking Race Resolves to the Anchor's User", plus its `index.yaml` entry.
  - *Context:* §1 summary, the two copies, B1 to B8, D1 to D4, and plan 01's non-goal.
  - *Decision:* 1. `FederatedIdentity.make` (`resolve`, `attach`) is the one implementation; plugins pass data and a verdict. 2. The trust rule is the module's, the verdict the caller's (a trusted party is trusted for any domain or for a list). 3. A lost race is resolved by one re-read of the anchor; a second loss is the typed `Contended` refusal. 4. Explicit link refuses an identity linked elsewhere and is idempotent. 5. A link is announced (`auth.account.linked`). 6. A static test pins that no federated plugin reads the anchor, links or signs up directly.
  - *Alternatives considered:* (a) fix each plugin's catch in place (Phase 0 does it for SAML as a hotfix; rejected as the end state because the third copy, an OIDC-connection trust source, and the divergences D1 to D4 would stay); (b) widen `SignUp` with a `linkOrCreate` (rejected: linking is not a sign-up, ADR-EA-038 decision 3 keeps `SignUp` about creation; the resolver *uses* `SignUp`); (c) one serializable transaction around steps 1 to 4 (rejected: dialect-specific isolation, serialization-failure retries on every federated sign-in, and it still needs a retry policy; constraints plus one re-read are enough); (d) a `Context.Service` (rejected as in ADR-EA-038 (c)); (e) map the second loss to `StoreUnavailable` (rejected: not an outage, ADR-EA-028).
  - *Consequences:* + one place for the federated linking policy; the race class cannot recur per plugin; about 16 plugin tests become one suite; OIDC connections can be trusted like SAML ones. − a create race runs `BeforeSignUp` twice; a trusting SAML connection with addresses outside its domains stops auto-linking them (Migration line); a new event tag reaches webhook consumers.
  - *Related:* ADR-EA-038 (extended), ADR-EA-028, ADR-EA-029, ADR-EA-041 (the atomic primitives), BEH-EA-317 (domains).
- **ADR-EA-038 revision 1.2**: Decision 3 gains "A federated sign-in reaches `SignUp` through `FederatedIdentity` (ADR-EA-043), which owns the decision between linking and creating"; Related adds ADR-EA-043.

### 6.3 Traceability

- `spec/traceability.md` (1.32 → next): an ADR-EA-043 row (`FederatedIdentity.test.ts`, `FederatedIdentitySql.test.ts`, `FederatedIdentity.types.test.ts`, the new BEH); file rows for the three new test files and `packages/test/src/Rendezvous.ts`; the `OAuth.test.ts` row (`:244`) drops the moved claims (explicit-by-default linking detail, TMS-007, AOMS-007, NAM-009, returning user) and names what stays (verdict wiring, NAM-006 mapping, explicit-link refusal, race regression); the `Saml.test.ts` rows name the race regression and the verdict wiring; the INV-EA-015 row (`:131`) and INV-EA-017 row (`:133`) add `FederatedIdentitySql.test.ts`; the `SignInSeams.test.ts` row (`:196`) adds the federated guard.
- `features/traceability.md`: the new REQ rows (§5.4).

### 6.4 Changesets (ADR-EA-034: breaking ones carry a `Migration:` line naming the ADR and BEH ids)

- Phase 0, `.changeset/saml-acs-lost-race.md`, `"@awthaq/saml": patch` (§4 Phase 0).
- Phase 1, `.changeset/federated-identity.md`, `"@awthaq/core": minor`, `"@awthaq/test": minor`:
  > `FederatedIdentity.make` resolves an external party's assertion to a local user (`resolve`: linked, auto-linked or created through `SignUp`; `attach`: an explicit link), deciding the email-linking policy once and resolving a lost race to the account the winner wrote (ADR-EA-043, BEH-EA-<new>). New event `auth.account.linked`. `@awthaq/test` gains `Rendezvous` for tests that force an interleaving.
- Phase 2, `.changeset/oauth-federated-identity.md`, `"@awthaq/oauth": minor`:
  > Concurrent first callbacks for one provider identity now sign in as one user instead of answering `AccountExists`/`OAuthCallbackFailed`. An explicit link of an identity already linked to another account now answers `OAuthCallbackFailed` (`account-already-linked`) and no longer refreshes that account's tokens. An account removed during a callback is resolved again instead of a 500. Auto-links and explicit links publish `auth.account.linked`.
  >
  > Migration: none for callers. A host that relied on an explicit link silently "succeeding" for an identity linked elsewhere now gets the refusal (BEH-EA-123, ADR-EA-043).
- Phase 3, `.changeset/saml-federated-identity.md`, `"@awthaq/saml": minor`:
  > A connection with `trustsEmail` now links only addresses in the domains it claims (`emailDomains`, BEH-EA-317), and the user it creates on a first sign-in has its address verified, as a trusted OAuth provider's does (BEH-EA-245, ADR-EA-043).
  >
  > Migration: a `trustsEmail` connection whose users sign in with addresses outside its `emailDomains` stops auto-linking them (they get `SamlAssertionRejected`, reason `emailInUse`): add the domains to the connection, or link those accounts explicitly. Find them with `SELECT c.id, a.subject FROM saml_connection c JOIN accounts a ON a."providerId" = 'saml:' || c."organizationId" || ':' || c.id WHERE c."trustsEmail"` and compare each linked user's address domain with the connection's domains.
- Phase 5, `.changeset/oidc-connection-email-trust.md`, `"@awthaq/organization": minor`, `"@awthaq/oauth": minor`:
  > An organization's OIDC/OAuth2 connection can trust its email claims (`trustsEmail`, default off), bounded to its claimed domains, like a SAML connection (BEH-EA-235, ADR-EA-043).
  >
  > Migration: run the new organization migration (it adds `organization_oauth_connection."trustsEmail"`, default false; migrations are numbered globally, so plugins composed after `Organization` shift ids, as `Migrations.run`'s header documents).

---

## 7. Risks, mitigations, rollback

| Risk | Mitigation |
|---|---|
| **The re-read answers with a user the loser did not expect** (it planned to create, and gets the winner's user) | That is the definition of the anchor (INV-EA-015): both requests proved the same `(providerId, subject, issuer)`. A sequential second request gets the same answer. ADR-EA-043 states it. No privilege is gained: the loser proved that very identity |
| **A create race runs `BeforeSignUp` twice** (a quota tap counts two) | Documented in the BEH entry and the changeset; the winner alone commits and announces. Q6 offers moving the re-read before `vet` is impossible (the race is only seen at the insert), so the alternative is "accept" or a dedicated tap input flag; recommended: accept |
| **Postgres: the loser waits on the winner's transaction** (an `INSERT ... ON CONFLICT` blocks until the other transaction ends; inside an RLS tenant transaction that is the whole winning request) | Inherent to any unique-constraint arbitration; bounded by the winner's request time. §5.1 #24 pins the nested shape. No lock is held across network I/O: the resolver runs after OAuth's token exchange and SAML's verification |
| **Domain-bound trust (Q2) stops existing auto-links** for a trusting SAML connection whose users sign in with other domains | `Migration:` line with the query; the refusal is the uniform `SamlAssertionRejected` with reason `emailInUse` logged, so an operator can see it |
| **SAML-created users become verified (Q1)**, which lets a later trusted OAuth sign-in auto-link into them | It is the same rule OAuth already applies (AOMS-007), applied to a party the deployment explicitly trusts, inside its claimed domains. An untrusting connection is unchanged |
| **A new event tag** reaches webhook subscribers and custom transports | Additive; `defineEvent` declares its PII posture (none: no subject, no address) so plan 09's erasure scrub and relay rules apply automatically |
| **The static guard is a regex** and can miss an aliased call (`const a = accounts; a.link(...)`) | Same accepted limit as `SignInSeams.test.ts`; plus the structural fact that OAuth and SAML no longer `yield* SignUp.make`, so a reintroduced sign-up needs a new, visible `yield*` the guard counts |
| **Declaration emit (TS2883)** in OAuth/SAML layers after replacing `SignUp.make` | `FederatedIdentity` re-exports what its requirements mention (§3.3), as `SignUp` does; plan 01 decision 3 recorded the same fix |
| **Phase 5 migration shifts migration ids** of plugins composed after `Organization` | Called out in the changeset (plan 10 item 7 decision 7 hit the same limit) |

**Rollback.** Phase 0 is a self-contained hotfix (revert restores the 500). Phase 1 is additive. Phases 2 and 3 are independent and each reverts to its plugin's hand-written copy; reverting Phase 3 must keep Phase 0's `anchoredOr` (re-apply it). Phase 4 is tests and docs. Phase 5 is behind a default-off column; reverting the code leaves a harmless column.

---

## 8. Interactions with other plans

**Done (01 to 10):**

- **01 (`SignIn`/`SignUp`, ADR-EA-038):** this plan builds on both and extends ADR-EA-038 (§1 addresses its `:43` non-goal). `SignUp`'s interface is unchanged; OAuth and SAML stop calling it directly and reach it through `FederatedIdentity`. The SAML continuation and tenant handling (plan 01 §3.5) are untouched.
- **02 (store seam, ADR-EA-041):** the race recovery relies on its atomic primitives `AccountStore.insertIfAbsent` and `UserStore.insertOrHolder` (non-poisoning `ON CONFLICT DO NOTHING`). `FederatedIdentity` is written once over the `Accounts`/`Users` interfaces, so it runs unchanged over both adapters.
- **03 (erasure):** an erasure racing a resolution is a lost race (the anchor or the target vanished) and resolves again or refuses (`TargetGone`), never a defect.
- **07 (`Verification.redeem`):** OAuth and SAML request state stay burn-first `consume` (plan 07 §3.7); the resolver runs after it, outside any redeem.
- **08 (`TestAuth.layer`):** the race tests use its `decorate` slot; `Rendezvous` joins `@awthaq/test`.
- **09 (event definitions):** `auth.account.linked` is declared through `defineEvent` with actor and PII posture.
- **10 item 7 (`DomainClaims`, BEH-EA-317):** the domain bound (Q2) uses the domains a connection claims, which item 7 made one organization's across protocols. The DNS-proof step item 7 left for later (a `verifiedAt` column) would make the bound stronger without changing this module: the verdict would list only verified domains.
- **04 (organization):** Phase 5 extends `ConnectionRecords`/`OrganizationConnections`, the modules 04 split.

**This batch (11 to 24):**

- **11 (credential resolution):** different question (request → credential → principal). If 11 exports one `IssuedSession`, OAuth's and SAML's `completion.complete` results use it; no overlap in `FederatedIdentity`.
- **16 (SQL store adapters):** folding `Repositories.ts` into the `*StoreSql` adapters must keep `insertIfAbsent`/`insertOrHolder` as single non-poisoning statements; 16's contract suite should pin "a conflicting insert inside a transaction leaves the transaction usable on Postgres", which §5.1 #24 relies on. Either order works.
- **17 (core sealed columns):** moves the three account token columns onto `SealedColumn`. The resolver writes tokens through `Accounts.link`/`updateProviderTokens`, whose interfaces 17 keeps; either order works.
- **22 (table DDL locality):** if 22 lands first, Phase 5's `trustsEmail` column goes into the connection records module's DDL rather than `OrganizationMigrations.ts`.
- **20 (in-process user agent):** the BDD scenarios in §5.4 use the worlds 20 may rebuild; the `decorate` slot they need should survive that.
- **21 (session-minting annotation):** the OAuth callback and SAML ACS endpoints still mint sessions; unchanged.
- **24 (memory records over SQLite):** plugin records only; core `Users`/`Accounts` memory stores keep their atomic `Ref.modify` primitives the memory races rely on.
- **12, 13, 15, 18, 19, 23:** no interaction (`AdminAccounts`' password-account link, §2.4, is not federated and stays).

---

## 9. Acceptance checklist

- [ ] Phase 0: the three SAML race tests pass; no `Effect.die` or `invariantViolation` remains on a lost race in `Saml.ts`.
- [ ] `core/src/FederatedIdentity.ts` exists and is exported; `resolve` and `attach` have closed error unions; no `as` (other than any existing `as const`), no return-type annotation on an Effect/Layer const.
- [ ] §5.1 cases 1 to 20 pass over memory and SQLite, 21 to 24 over SQLite and Postgres (`scripts/test-pg.sh` lists `FederatedIdentitySql.test.ts`).
- [ ] OAuth and SAML call `FederatedIdentity.resolve`/`attach`; `grep -rnE "accounts\s*\.\s*(link|findByProviderSubject|updateProviderTokens)\(|SignUp\.make" packages/oauth/src packages/saml/src packages/organization/src` returns nothing, and `SignInSeams.test.ts` pins it.
- [ ] B1 to B8 each have a passing regression test (plugin or resolver level), and the explicit link of an identity linked elsewhere is refused with the other user's tokens unchanged.
- [ ] The fourteen OAuth and three SAML tests of §5.3 are deleted, not kept beside the resolver suite.
- [ ] `auth.account.linked` is defined, registered and published once per new link (if Q3 = yes).
- [ ] SAML: a trusting connection is bounded to its domains and verifies the users it creates (if Q1/Q2 = yes).
- [ ] Phase 5 (if Q4 = yes): an OIDC connection's `trustsEmail` round-trips in both record adapters and drives OAuth's verdict.
- [ ] New BEH entry; BEH-EA-123/124/125/245/322/323 (and 235) updated with revision bumps; `13-events.md`, invariants, glossary, overview and models updated; ADR-EA-043 added and indexed; ADR-EA-038 at 1.2; `spec/traceability.md` and `features/traceability.md` updated; `pnpm spec:verify:strict` passes.
- [ ] `docs/plugin-authoring.md` has the federated-identity bullet; the OAuth and SAML READMEs are updated.
- [ ] A changeset per package-visible phase, with `Migration:` where behaviour changes for a host.
- [ ] `pnpm check && pnpm test:pg` green on the final commit (or `test:pg` reported as not run, with what ran over SQLite instead).

---

## 10. Open questions only the user can answer

1. **Should a SAML connection that trusts email mark the users it creates as verified** (AOMS-007 parity with a trusted OAuth provider)? Recommended: **yes**, inside its claimed domains. Today such users stay unverified, so a later trusted OAuth sign-in cannot auto-link into them, and the same deployment treats two trusted parties differently.
2. **Bound a connection's email trust to the domains it claims** (BEH-EA-317), so a trusting connection can never auto-link `ceo@another-company.com`? Recommended: **yes**, with an empty domain list meaning "links nothing". The alternative keeps `trustsEmail` unbounded and documents that `canManageSaml` must never be granted to tenant administrators. Static OAuth providers stay `trusted("any")` either way.
3. **Publish a new `auth.account.linked` event** for an auto-link and an explicit link? Recommended: **yes**. Joining an external identity to an existing account is the event a security team watches most, and today it leaves no event and no audit row, while a sign-up does.
4. **Give OIDC organization connections per-connection email trust** (Phase 5: a `trustsEmail` column bounded by the connection's domains)? Recommended: **yes**: it is the same "connection per organization" model SAML has, and today such connections can never auto-link (their ids are data, so they cannot be listed in the static `trustedProviders`). Answer "no" to drop Phase 5.
5. **A second lost race:** answer the typed `Contended` refusal mapped to each flow's uniform rejection (recommended), or `StoreUnavailable` (503, which a client retries)? The recommendation follows ADR-EA-028: it is not an outage.
6. **Is it acceptable that the losing request of a create race has run `BeforeSignUp`** (and only the winner announces `auth.user.created`)? Recommended: **accept and document**. The race is only visible at the insert, after the veto ran; the alternative is a flag on the hook input that no tap needs today.
7. **SAML anchor stability (follow-up, not this plan):** a connection's editable `entityId` is the anchor's issuer, so an edit orphans every linked account (§2.6 F7). Recommended: open a follow-up that either freezes `entityId` once accounts are linked or re-keys the connection's accounts in the same transaction as the edit. This plan leaves it as is.

---

## Decisions taken (implementation, 2026-10-18)

Open questions took the plan's recommended default:

1. **Q1, SAML-created users are verified under a trusting connection: yes**, inside its claimed domains (AOMS-007 parity). Two tests pin it (trusting and non-trusting).
2. **Q2, a connection's email trust is bounded to its claimed domains: yes.** `trusted(connection.emailDomains)`; an empty list links and verifies nothing. Static OAuth providers stay `trusted("any")`. The changeset carries the `Migration:` line with the query.
3. **Q3, `auth.account.linked` event: yes** (`userId`, `providerId`, `via`; no subject). Published for an auto-link and a new explicit link only.
4. **Q4, per-connection email trust for OIDC organization connections (Phase 5): NOT DONE.** It is the plan's recommended default, but it adds a `trustsEmail` column to `ConnectionRecords` with a migration across the organization package's memory and SQL adapters. Plan 22 (table DDL locality), which the plan says decides where that DDL goes, is not implemented. Skipped and listed here; `FederatedIdentity.EmailTrust` and OAuth's `emailTrustOf` are ready for it (add `emailTrust?` to `OAuthConnection` and prefer it in `emailTrustOf`).
5. **Q5, a second lost race is the typed `Contended`** (OAuth `OAuthCallbackFailed` with reason `identity-contended`; SAML `SamlAssertionRejected` with reason `identityContended`), not `StoreUnavailable`.
6. **Q6, a create race runs `BeforeSignUp` twice: accepted and documented** (BEH-EA-338).
7. **Q7, SAML anchor stability when `entityId` is edited: follow-up, not done.** Open a ticket when this plan is reviewed.

Implementation notes and deviations from the plan:

- **Phase 0** went in with one more branch than the plan names. The email-holder branch (`existing` found, connection not trusting or holder unverified) can be hit by the *loser* after the winner has created the user but before it has linked, so it also calls `anchoredOr` before refusing. The resolver does the same (a refusal first re-reads the anchor and, if it is now present, treats it as a lost race). Without this the plan's own test #10(b) (email create race) failed on memory.
- **Phases 0-1** also edit `@awthaq/test`: `Rendezvous` (`make`, `anchorReadsMeet`) is exported from the index. Core's own tests import `Rendezvous.make` through the relative path (`../../test/src/Rendezvous.ts`) because `@awthaq/core` cannot depend on `@awthaq/test`; they decorate `Accounts` themselves with the core-source tag.
- **Core test layout.** The 24 cases live in `packages/core/test/support/federatedIdentitySuite.ts` (`suite(name, env)`), run by `FederatedIdentity.test.ts` (memory) and `FederatedIdentitySql.test.ts` (SQLite, Postgres under `test:pg`, plus cases 21-24). Total 71 cases in the two files.
- **TS2883.** `FederatedIdentity.make` could not name `SqlTransaction` (it comes through `SignUp.make`); fixed without an annotation by importing it as a value and re-exporting it from the module.
- **`OAuthTokenAccess.updateProviderTokens` stays in OAuth** (the token refresh against the provider is a non-goal). The Phase 4 guard therefore forbids `link`, `findByProviderSubject` and `SignUp.make` under `oauth/src`, `saml/src`, `organization/src` and pins `updateProviderTokens` to exactly two callers (the resolver and `OAuthTokenAccess`), instead of forbidding it outright as §4 says.
- **Tests deleted** in OAuth: the 14 of §5.3 (OAuth 235 -> 221 with the 3 new regressions). In SAML: the `:566` test and the Phase 0 email and trustsEmail race cases; `:589` was rewritten (domain bound) and two verify-on-create cases added.
- **BDD.** Four scenarios (REQ-EA-1310 to 1313): OAuth concurrent first callbacks and an explicit link refused with the other account untouched; SAML concurrent first sign-ins and the domain-bounded trust. The OAuth and SAML worlds gained a `concurrentLookups`/`anchorMeeting` slot feeding `Rendezvous.anchorReadsMeet` through `TestAuth.layer`'s `decorate`.
- **Plan 11/16/17/18/22 dependencies:** none were needed except the Phase 5 DDL note above.
- **Gates run.** Typecheck, lint, knip (only `.reports/`), circular, format:check, spec:verify:strict, check:error-tags, check:readmes, test (full), test:bdd and test:pg (Docker).
