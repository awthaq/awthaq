# Plan 10: Standalone fixes and loose findings

Source: the architecture review of 2026-10-13. This plan collects the findings that are not a deepening
candidate in their own right, plus two hotfixes that must land *before* plan 01 because they are live bugs on
the sign-in hot path. Every file:line below was re-read on 2026-10-13 against `main` at `38bcd1b`; where the
review's claim was wrong or imprecise, the section says so under **Evidence corrections**.

Conventions: everything in [`.planning/README.md` § Shared conventions](../README.md#shared-conventions-apply-to-every-plan)
applies (no `as`, no return type annotations on new Effect/Layer consts, type-system first, replace-don't-layer
tests, spec + traceability + BDD updates, a changeset with a `Migration:` note for every package-visible change,
the per-phase gate `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`, `pnpm check` per
plan, `pnpm test:pg` whenever a SQL adapter changes). Track execution as `.scratch/10-standalone-fixes/issues/NN-*.md`
tickets, one per item below (ticket number = item number).

Vocabulary: **module, interface, implementation, depth, seam, adapter, leverage, locality** (codebase-design
glossary). Domain terms from `spec/glossary.md` / `spec/overview.md`.

> Note on plans 01-09: when this plan was written only `.planning/README.md` existed; the sibling PLAN.md files
> were being written in parallel. "Absorbed by plan NN" below is derived from the README's one-line scope of each
> plan. The executor of this plan must re-read the sibling plans before starting and move any item whose scope
> they claim (see [Interactions](#interactions-with-plans-01-09)).

---

## Summary

Ten items (item 0 added after review), four of which are live correctness bugs:

- **Item 0 (P0 security):** API keys keep authenticating after their owner is suspended, banned or erased.
  `ApiKey.resolve` never reads the owner, and `api-key` contributes nothing to `ErasureRegistry`.

- **Item 1 (P0):** a SAML sign-in that is diverted to a second factor loses `"fed"` from its `amr`. SAML calls
  `BeforeSessionIssue.run` without `amr`, and the two-factor gate stores the `amr` it receives in the challenge.
  SAML is the only one of the six divert call sites that omits it. Investigating it turned up a second,
  larger SAML-plus-2FA gap (no Single Logout record and no role mapping for a 2FA-completed SAML session). That
  gap is reported here and handed to plan 01.
- **Item 2 (P0):** ADR-EA-028 says an outage is a typed `StoreUnavailable` (503). Four sign-in flows turn it into
  a defect (500) with `.pipe(Effect.orDie)` on `sessions.issue` and `users.findById`. The Shapes and the HTTP
  middleware already declare `StoreUnavailable`, so the fix only deletes the `orDie`s. Nothing needs widening.
- **Item 3 (P1):** `Sessions.reauthenticate` advances `authenticatedAt` on a tombstoned or expired row in both
  layers. It also takes no `userId`, so the interface cannot express "my own session".
- **Item 4 (P1):** three copies of the "fresh session" gate. The plan adds one `Sessions.requireFresh` interface
  member. It also found a fourth place that *should* have the gate and doesn't: `requestEmailChange`. That is a
  user decision.
- **Item 5 (P1, new ADR):** `AuthEvents.publish` hands the event to live subscribers inside transactions that can
  still roll back. This happens in erasure, `confirmReset`, and **every request of a tenanted Postgres deployment**
  (`TenantScope.withTenant` wraps the whole request). The survey also found the reverse bug: a wrong second-factor
  code during `confirmReset` publishes `auth.twoFactor.challengeFailed`, and then the rollback **erases its audit
  row**. The fix is a two-lane unit of work at the transaction seam (`onCommit` for state changes, `afterUnit` for
  attempts), drafted as ADR-EA-037.
- **Items 6-9 (P2):** retention has no plugin registry; OIDC and SAML domain claims can clash across protocols
  (a user decision); spec, index and doc drift; ADR-EA-028's index status is stale. Item 9's premise ("AuditLog
  pending") is **false in code**: only `spec/decisions/index.yaml` is stale.

---

## Item table

Priority order. Effort: **S** ≤ half a day, **M** 1-2 days, **L** 3+ days.

| # | Item | Priority | Effort | Would otherwise be absorbed by | Do it here? |
|---|---|---|---|---|---|
| 0 | API keys of an erased or suspended User keep authenticating | **P0 security hotfix** | S-M | 03 (erasure contributions) for the erase half only | **Yes, first.** Added by the orchestrator after plan 03's survey; see [Item 0](#item-0-api-keys-outlive-their-owner-p0-security-hotfix). |
| 1 | SAML `amr` lost in the `BeforeSessionIssue` divert | **P0 hotfix** | S | 01 (sign-in completion in core) | **Yes, ahead of 01.** 01 inherits the regression test and moves it to `SignIn`'s interface. |
| 2 | ADR-EA-028 `orDie` on `sessions.issue` / `users.findById` in sign-in flows | **P0 hotfix** | S | 01 (collapses the issue call sites) | **Yes, ahead of 01.** Only the sign-in sites listed. Adjacent `orDie`s go to 01/05 (see item). |
| 3 | `Sessions.reauthenticate` accepts a dead session; takes no `userId` | P1 | S-M | 02 (memory/SQL drift in `reauthenticate`) | **Yes**: a behaviour fix in both twins now. 02 merges the twins later and keeps the contract test. |
| 4 | Fresh-session gate duplicated in passkey, two-factor and qadi (and missing on email change) | P1 | M | none | **Yes.** Lands after item 3 (same interface). |
| 5 | Events published to live subscribers from transactions that later roll back | P1 | L | none (touches 02, 03, 07, 09) | **Yes**: ADR-EA-037 + seam change. Must land before 07 changes the redeem transaction protocol. |
| 6 | Retention covers core tables only; no plugin contribution | P2 | M | 05 (plugin table substrate) could host it | **Design here, build with or after 05.** |
| 7 | OIDC/SAML email-domain claims unique only per table | P2 (decision) | S (A) / M (B) | 04 (organization system modules) | Decision here; option B, if chosen, is built inside 04. |
| 8 | Docs and index drift (index.yaml, overview, roadmap, BEH-EA-093, plugin-authoring, `sealed`, `readsTables`, Retention header) | P2 | S | parts to 01, 04, 05 | **Yes** for the docs. Code renames go to 05/04. |
| 9 | ADR-EA-028 index status "AuditLog pending" | P2 | S | none | **Yes**, folded into item 8's doc commit plus a drift check. |

Execution order inside this plan: **0** (security hotfix, own PR, first) → **1 → 2** (one PR, "sign-in hotfixes", before plan 01 starts) → **3 → 4** (one
PR, Sessions interface) → **8 + 9** (docs PR, any time) → **5** (ADR first, then code) → **6** (after plan 05) →
**7** (after the user answers).

---

## Item 0: API keys outlive their owner (P0 security hotfix)

> Added after the parallel plans were written: plan 03's survey noted that `api-key` has no erasure
> contribution; the orchestrator confirmed it and found the suspension half. Re-verify line numbers before
> starting.

### Verified evidence

- `packages/api-key/src/ApiKey.ts:929-958` (`resolve`) checks only the key's shape, its hash (constant time,
  PIL-007), and `isLive(record, now)` (expiry and `revokedAt`). It never reads the owning User: no existence
  check, no `Users.assertCanSignIn`. The resulting `ApiKeyPrincipal` (`:953-957`) carries the key id and scopes
  only, so nothing downstream (`server/src/Authentication.ts` machine authentication, the qadi bridge) can
  notice either.
- `api-key` contributes nothing to `ErasureRegistry` (`grep -rln ErasureRegistry packages/*/src` lists admin,
  device-authorization, organization, passkey, qadi, roles, scim, two-factor; not api-key). `apikey_key` and
  `apikey_client` (`ApiKey.ts:305-368`) hold `"ownerId" TEXT NOT NULL` with no foreign key, so deleting the
  `users` row leaves both tables untouched.
- Ban/suspension: `spec/behaviors/27-admin-impersonation.md:350` says a ban revokes "every session of the user
  … since the account's access ends as a whole", and BEH-EA-046 (`06-domain-users-accounts.md:143`) makes
  `Users.assertCanSignIn` the one gate. `banUser` runs `Users.setStatus` + `Sessions.revokeAll`; API keys are
  not sessions, so they keep working for a banned user. SCIM `active:false` (suspension) has the same gap.

**Consequence.** An erased user's keys keep authenticating forever (until expiry), against ADR-EA-031's "the one
cascade". A banned or SCIM-deactivated user keeps machine access, against BEH-EA-046/BAM-005's intent.

### Fix design

Two independent halves; ship both in one PR.

1. **Gate at resolve (covers suspension, and erasure defensively).** After the hash and liveness checks,
   `resolve` reads the owner and applies the shared gate. Keep the constant-time shape: the user lookup happens
   only after a matching hash, so it leaks nothing about unknown key ids.

   ```ts
   // inside resolve, after `if (!isLive(record, now)) return Option.none();`
   const owner = yield* users.findById(record.ownerId).pipe(
     Effect.catchTag("UserNotFound", () => Effect.succeed(undefined)),
   );
   if (owner === undefined) return Option.none();
   const permitted = yield* Users.assertCanSignIn(owner).pipe(
     Effect.as(true),
     Effect.catchTag("UserSuspended", () => Effect.succeed(false)),
   );
   if (!permitted) return Option.none();
   ```

   `StoreUnavailable` from `findById` propagates typed (ADR-EA-028: 503, never a silent "no principal"). Widen
   `ApiKeyShape["resolve"]`'s error channel to `Api.StoreUnavailable` if it isn't already, and check the machine
   authentication middleware maps it to 503. Check `resolveClient` / the client-credentials path
   (`ApiKey.ts:~997-1043`) for the same gap and apply the same gate.

   Decide (open question 0a): should a suspended owner's key fail as "no principal" (401, indistinguishable from
   a bad key) or as `UserSuspended` (403)? Recommended: 401, matching the "a wrong credential never learns
   whether an account is suspended" posture of BEH-EA-046, since an API key *is* the credential.

2. **Erasure contribution (the cascade).** `ApiKey`'s layer contributes to `ErasureRegistry`: inside the
   erasure transaction, delete `apikey_key` and `apikey_client` rows where `"ownerId" = subject.userId` (add
   `deleteByOwner` to `ApiKeyRecords` and `ApiKeyClientRecords`, both adapters). Also contribute to
   `DataExportRegistry` (key names, `start` prefixes, scopes, created/last-used timestamps; never hashes).
   Plan 03 assumes this contribution exists; plan 05's substrate will later own the record mapping.

### Steps

1. `packages/api-key/src/ApiKeyRecords.ts`, `ApiKeyClientRecords.ts`: add `deleteByOwner(ownerId)` to the
   interface, `layerMemory` and `layerSql`; extend the shared record suite to cover it.
2. `packages/api-key/src/ApiKey.ts`: require `Users` in `make`; add the gate to `resolve` (and the client path);
   register the erasure and export contributions the way `passkey/src/Passkey.ts` does.
3. Check `AuthPlugin` `dependsOn`/ports declarations still type-check (`Users` is core, so no new plugin
   dependency).
4. Spec: add the gate and the cascade to the API-key behaviour (find its BEH id via `spec/traceability.md`;
   the API-key contract lives in `spec/behaviors/04-contract-stratum.md` / `09-authentication-middleware.md`),
   extend BEH-EA-046's list of gated paths, extend the ADR-EA-031 contribution list, update
   `spec/traceability.md`.
5. Changeset (`@awthaq/api-key`, patch): "API keys stop authenticating when their owner is suspended, banned or
   erased; erasure deletes the owner's keys and clients. Migration: none; keys of already-erased users are now
   refused at resolve, and an operator may purge orphans with `DELETE FROM apikey_key WHERE "ownerId" NOT IN
   (SELECT id FROM users)`."

### Regression tests

- `ApiKey.test.ts`: a key resolves; ban the owner (`Users.setStatus(…, "suspended")`) → `resolve` is
  `Option.none()`; unban → resolves again; timed suspension lapsed → resolves.
- Erase the owner through `AccountErasure.eraseAccount` → `listByOwner` is empty and the presented key resolves
  to `Option.none()`.
- `StoreUnavailable` from `Users.findById` surfaces as 503 through the machine authentication middleware
  (`AuthHttp` test), not 401.
- An unknown key id still costs one digest and no user lookup (spy on `Users.findById`).
- BDD: add a scenario to the API-key feature: "a banned user's API key is refused".

---

## Item 1: SAML `amr` is lost in the second-factor divert (P0 hotfix)

### Verified evidence

`packages/saml/src/Saml.ts:1036` runs the divert without `amr`:

```ts
const point = yield* beforeSessionIssue.run({ userId: targetUserId, strategy: providerId });
if (point._tag === "Diverted") return yield* Effect.fail(point.value);
yield* applyRoleMapping(connection, assertion, targetUserId);
const issued = yield* sessions.issue({ ..., amr: ["fed"] });            // Saml.ts:1039-1046
```

`packages/two-factor/src/TwoFactor.ts:185-192` (the `sessionGate` tap) stores whatever `amr` the caller passed:

```ts
if ((input.amr ?? []).includes("mfa")) return Option.none();
...
const challengeId = yield* factor.issueChallenge({ userId, strategy: input.strategy,
  amr: (input.amr ?? []).filter(Sessions.isAuthMethod), attempt: 0 });
```

`finalizeSignIn` (`TwoFactor.ts:522-548`) mints the session with `Sessions.unionAmr(challenge.amr, ["otp", "mfa"])`
(`:540`). For a SAML sign-in `challenge.amr` is `[]`, so the session records `["otp","mfa"]`, with no `"fed"`.
Anything gating on `fed` sees the wrong value: a qadi policy, `Assurance`, a JWT `amr` claim (`Jwt.ts:194`), or the
`SessionDto.amr` a client reads.

**Every `BeforeSessionIssue.run` caller and the `amr` it passes, against the `amr` it issues with:**

| Caller | `run` passes `amr` | issues with `amr` | Match |
|---|---|---|---|
| `password/src/Password.ts:1237-1241` (`signIn`) | `["pwd"]` | `["pwd"]` (`:1246`) | yes |
| `oauth/src/OAuth.ts:1370-1374` (`callback`) | `["fed"]` | `["fed"]` (`:1387`) | yes |
| `passkey/src/Passkey.ts:1645-1650` (`authenticateVerify`) | `passkeyAmr(verified)` | the same `amr` const (`:1663`) | yes |
| `magic-link/src/Channel.ts:174-178` (magic link + email OTP) | `completion.amr` | `completion.amr` (`:186`) | yes |
| `device-authorization/src/DeviceAuthorization.ts:1157` (`poll`) | `grant.amr` | `claimed.value.amr` (`:1171`), the same row re-read by the atomic `consume` | yes (same stored value) |
| `saml/src/Saml.ts:1036` (`acs` completion) | **omitted** | `["fed"]` (`:1045`) | **no** |

Callers of `sessions.issue` that do **not** consult the divert, which is correct for each: `Password.ts:1054-1056`
(sign-up auto-session: a brand-new user has no second factor), `Password.ts:1670-1677` (`changePassword`
supersede), `admin/src/Admin.ts:1100-1106` (impersonation, BEH-EA-209), `TwoFactor.ts:534` (the second factor
itself).

### Additional finding (not in the review): a 2FA-completed SAML session skips SLO and role mapping

On `Diverted`, `acs` returns before `applyRoleMapping` (`Saml.ts:1038`), before `records.saveSession` (`:1048-1054`)
and before `pruneSessions`. `finalizeSignIn` in two-factor knows nothing of SAML. So a SAML user with a confirmed
second factor ends up with a session that:

- has **no `saml_session` row**, so an IdP-initiated Single Logout (BEH-EA-315) cannot find and end it;
- **was never role-mapped** from this assertion (BEH-EA-316 role mapping is skipped on every 2FA sign-in).

This needs a continuation that survives the second request (the challenge would have to carry "after issue,
record SLO identity X"), which is exactly what plan 01's core sign-in completion should own. **It is not fixed
here.** Ticket 01 records it and hands it to plan 01 as a must-fix (see [Interactions](#interactions-with-plans-01-09)).
Interim mitigation, cheap and safe: move `applyRoleMapping` **before** the divert. The IdP has already proven the
identity, role mapping is a function of the signed assertion, and the second factor gates the *session*, not the
directory facts. That closes the role-mapping half. Ask the user (see [Open questions](#open-questions-only-the-user-can-answer), Q1).

### Root cause

The divert context and the issue call are two separate literal arguments at every call site, so nothing makes
them agree. SAML's call predates `amr` on `SessionIssueContext` (`core/src/Hooks.ts:102-106`, `amr` is
`Schema.optionalKey`). Because the field is optional, the omission type-checks.

### Fix design

Minimal hotfix: one const, used twice, the same way passkey already does it.

```ts
// Saml.ts, inside the completion, replacing :1036 and :1045
const amr = ["fed"] satisfies ReadonlyArray<Sessions.AuthMethod>;
const point = yield* beforeSessionIssue.run({ userId: targetUserId, strategy: providerId, amr });
if (point._tag === "Diverted") return yield* Effect.fail(point.value);
yield* applyRoleMapping(connection, assertion, targetUserId);   // or moved above, per Q1
const issued = yield* sessions.issue({ userId: targetUserId, request: { ... }, amr });
```

(`satisfies` is not an assertion, so it is allowed. If `ReadonlyArray<AuthMethod>` inference from the literal
already works without it, drop it.)

**Not in this hotfix** (plan 01's job): making `amr` *required* on `SessionIssueContext`, or deriving the divert
context and the issue input from one value, so the next omission fails to compile. Plan 01's single sign-in
completion makes this structural. Record it in ticket 01 as an acceptance item for plan 01.

### Steps

1. `packages/saml/src/Saml.ts`: introduce the `amr` const, pass it to `beforeSessionIssue.run` and `sessions.issue`.
2. (If Q1 = yes) move `yield* applyRoleMapping(...)` above `beforeSessionIssue.run`.
3. Tests (below).
4. Spec: `spec/behaviors/29-saml-sp.md`: add a sentence to the ACS completion behaviour (BEH-EA-240's sign-in
   paragraph): "the divert context carries `amr: ["fed"]`, the same methods the session records". Bump its Document
   Control (revision + change history). `spec/behaviors/31-two-factor.md` BEH-EA-261: name SAML among the first
   factors that pass `amr`.
5. `spec/traceability.md`: add the new test file/case to the SAML row (§ test map) under BEH-EA-240 and BEH-EA-261.
6. Changeset (`@awthaq/saml: patch`): "A SAML sign-in completed by a second factor now records `fed` in its
   `amr`." `Migration:` sessions minted before the fix keep `["otp","mfa"]` until they end; a policy gating on
   `fed` should not assume old 2FA'd SAML sessions carry it.

### Regression tests

- **Unit, `packages/saml/test/Saml.test.ts`** (no new dependency): compose a `Hooks.BeforeSessionIssue.tap` that
  records its input into a `Ref` and returns `Option.none()`. Run a full ACS and assert the recorded input is
  `{ userId, strategy: <providerId>, amr: ["fed"] }`. Pattern: `packages/oauth/test/OAuthHooksSignIn.test.ts:79`.
- **Composition, BDD** (`features/` already depends on both `@awthaq/saml` and `@awthaq/two-factor`): add to
  `features/features/14-mfa-passwordless/31-two-factor.feature` a scenario next to `@REQ-EA-1038` ("The session
  finally minted records how both factors were proven"):
  `Scenario: A SAML sign-in completed by a second factor records fed, otp and mfa`. Given an enrolled user, a
  SAML connection and a signed assertion: the ACS diverts, the user presents a TOTP, the session's `amr` equals
  `["fed","otp","mfa"]`. Also add `saml` and `device` rows to the `Scenario Outline: Every first-factor strategy
  that consults BeforeSessionIssue is diverted` examples table. Allocate the next free `@REQ-EA-` tags (the drift
  check `REQ-EA tags are unique` enforces uniqueness).
- If Q1 = yes: a SAML test asserting a diverted ACS has applied role mapping (the user's mapped role is present
  before the second factor completes).

---

## Item 2: ADR-EA-028 `orDie` on the sign-in hot path (P0 hotfix)

### Verified evidence

ADR-EA-028 (Decision 2, 5) says a store outage is `StoreUnavailable` (503), and "a plugin Shape that composes a
core service adds `StoreUnavailable` to its own `E`". The core interfaces already say so:
`Sessions.issue` → `E = StoreUnavailable` (`core/src/Sessions.ts:354-375`); `Users.findById` →
`UserNotFound | StoreUnavailable` (`core/src/Users.ts:265`).

The sign-in flows throw it away:

| Site | Code | Effect today |
|---|---|---|
| `password/src/Password.ts:1245-1247` (`signIn`) | `sessions.issue(...).pipe(Effect.orDie)` | outage → 500 defect |
| `passkey/src/Passkey.ts:1654-1665` (`authenticateVerify`) | `sessions.issue(...).pipe(Effect.orDie)` | same |
| `oauth/src/OAuth.ts:1380-1389` (`callback`) | `sessions.issue(...).pipe(Effect.orDie)` | same |
| `oauth/src/OAuth.ts:1354-1356` | `users.findById(...).pipe(Effect.orDie, Effect.tap(Users.assertCanSignIn))` | outage **and** `UserNotFound` → defect |
| `saml/src/Saml.ts:1025-1027` | same `findById` + `orDie` | same |

The Shapes already declare `StoreUnavailable`: `Password.signIn` (`Password.ts:208-233`), `Passkey.authenticateVerify`
(`Passkey.ts:585-599`), `OAuth.callback` (`OAuth.ts:640-682`), `Saml.acs` (`Saml.ts:116-129`, via `ServerError`).

The HTTP mapping already answers 503. `Api.StoreUnavailable` is `httpApiStatus: 503` (`api/src/Api.ts:128-132`) and is
declared on `CsrfProtection` (`Api.ts:306-311`, "so the public, unauthenticated mutating endpoints (sign-up,
sign-in, reset) can answer a store outage 503 too") and on `OptionalAuthentication` (`Api.ts:295-303`).
Password's public group (`PasswordApi.ts:331`) and `passkey.authenticate` (`PasskeyApi.ts:450`) sit behind
`CsrfProtection`. `oauth` sits behind `OptionalAuthentication` (`OAuthApi.ts:214`). The SAML ACS endpoint lists
`Api.StoreUnavailable` itself (`SamlApi.ts:126`). So once the `orDie` goes, the handlers type-check unchanged and
the wire answer becomes 503.

**Evidence corrections:** the line numbers in the review were right to within ±2. In addition, these sign-in-path
`orDie`s on **core** services also violate ADR-EA-028 and are cheap to fix in the same commit:

- `Password.ts:1161` `accounts.findCredentialHash(...).pipe(Effect.orDie)`. Its `E` is `AccountNotFound | StoreUnavailable`
  (`core/src/Accounts.ts:181-186`).
- `Password.ts:1214-1217` `accounts.updateCredentialHash(...).pipe(Effect.orDie)` (rehash on login).

Out of scope here, with the plan that owns each:

- `Password.ts:1053/1056` (sign-up, inside a transaction, plus `catchTag("SqlError", Effect.die)` at `:1059`) → **plan 01**
  (sign-up moves to core).
- `Password.ts:1677` (`changePassword`) → **plan 01**.
- `admin/src/Admin.ts:1106` (impersonation `issue`) → **plan 01**, since it collapses every `sessions.issue` caller.
- Plugin-records `orDie` (`Passkey.ts:1614` `credentials.recordUsage`, whose interface has no `StoreUnavailable`
  yet: `PasskeyCredentials.ts:89-93`) → **plan 05**.

### Root cause

These sites were written before ADR-EA-028 converted `Sessions`/`Users`/`Accounts`. When the core `E` widened,
`orDie` kept compiling, so nothing flagged them.

### Fix design

Delete the `orDie`. Where a *domain* error is impossible by construction, die on that tag only:

```ts
// OAuth.ts:1354 and Saml.ts:1025
const user = yield* users
  .findById(targetUserId)
  .pipe(Effect.catchTag("UserNotFound", Effect.die), Effect.tap(Users.assertCanSignIn));

// Password.ts / Passkey.ts / OAuth.ts
const issued = yield* sessions.issue({ ... });          // StoreUnavailable flows into the Shape's E

// Password.ts:1161 / :1214
accounts.findCredentialHash(account.id).pipe(Effect.catchTag("AccountNotFound", Effect.die))
```

The tags are `"UserNotFound"` (`core/src/Users.ts:193`) and `"AccountNotFound"` (`core/src/Accounts.ts:61`).
Passkey's `findById` at `Passkey.ts:1624-1626` already does it right; copy its shape. No Shape changes and no wire changes.

### Steps

1. Edit the five listed sites plus the two `Password.ts` `Accounts` sites.
2. `grep -n "orDie" packages/{password,passkey,oauth,saml}/src/*.ts` and confirm that every remaining hit is either
   crypto/codec (not ADR-028 scope), in the plan 01/05 lists above, or justified in a comment.
3. Tests (below).
4. Spec: `spec/behaviors/11-http-error-mapping.md` gets an *Implementation* note on the StoreUnavailable behaviour:
   "every sign-in completion answers 503 on a session-store outage (`password`, `passkey`, `oauth`, `saml`,
   `magic-link`, `email-otp`, `device`)". Bump Document Control. `spec/decisions/028-infrastructure-error-policy.md`
   Rollout paragraph: add "the sign-in completions of the first-party plugins" (revision 1.2).
5. `spec/traceability.md`: list the new tests under the BEH-EA covering 503 mapping.
6. Changeset (`@awthaq/password`, `@awthaq/passkey`, `@awthaq/oauth`, `@awthaq/saml`: patch): "A session-store
   outage during sign-in answers 503 `StoreUnavailable` instead of 500." `Migration:` clients that retried only on
   500 should also retry 503, and alerting keyed on 500s for sign-in outages should add 503.

### Regression tests

One test per flow, using the layer-override pattern already in the repo (`packages/scim/test/ScimHttp.test.ts:370-382`):
wrap the real `Sessions.layerMemory` and replace `issue` with
`() => Effect.fail(new Errors.StoreUnavailable({ operation: "Sessions.issue" }))`.

- `packages/password/test/Password.test.ts`: `signIn` with a correct password fails with `_tag === "StoreUnavailable"`
  (assert on `Effect.flip`, not on a defect).
- `packages/passkey/test/Passkey.test.ts`: `authenticateVerify` likewise.
- `packages/oauth/test/OAuth.test.ts`: `callback` likewise, plus a `Users.findById` outage variant.
- `packages/saml/test/Saml.test.ts`: `acs` likewise, plus `findById`.
- One HTTP-level test (`packages/password/test/AuthHttp.test.ts`): `POST /password/sign-in` answers **503** with a
  body that does not contain the operation's internal cause (mirror the SCIM assertion at `ScimHttp.test.ts:401-404`).

Plan 01 replaces these four per-plugin tests with one test on the core sign-in completion and deletes them
(replace, don't layer). Name each test `"ADR-EA-028: ... outage is StoreUnavailable"` so 01 finds them by grep.

---

## Item 3: `Sessions.reauthenticate` accepts a dead session (P1)

### Verified evidence

- Interface `core/src/Sessions.ts:519-533`: `reauthenticate(id, amr?) => Effect<SessionView, SessionNotFound | StoreUnavailable>`.
  **There is no `userId` parameter**, unlike `findOwned`/`isLive`/`revokeOwned`.
- Memory, `Sessions.ts:1185-1208`: `Ref.modify` on `HashMap.get(s, id)`. It writes whenever the row exists, with no
  `isLiveAt` check.
- SQL, `Sessions.ts:1722-1748` → `sql/src/Repositories.ts:1670-1690`:
  `UPDATE sessions SET "authenticatedAt" = …, "amr" = COALESCE(…) WHERE "id" = ${id} RETURNING *`. There is no
  `"supersededAt" IS NULL`, no expiry predicate and no `"userId"` predicate. Also, when `amr` is non-empty, it
  first runs `repo.findById` and then the update (`Sessions.ts:1728-1736`). That read-then-write is not atomic, and
  plan 02 should fold it into one statement.
- The single liveness predicate already exists: `isLiveAt` (`Sessions.ts:540-553`), used by `findOwned` in both
  layers (`:1173-1180`, `:1700-1712`). SQL liveness predicates already exist in the repository (`Repositories.ts:1477-1484`,
  `:1613-1616`).
- Callers: `password/src/Password.ts:1707-1717` and `passkey/src/Passkey.ts:1855-1862`. Both pass the session the
  `Authentication` middleware just verified. Both map `"Sessions/NotFound"` to a **defect**
  (`Defects.invariantViolation("RowVanished", …)`).

Consequences today: (a) a session superseded or expired between the middleware's `verify` and the reauth write
gets `authenticatedAt = now` on a dead row. That is harmless only while the row stays dead, and a tombstoned row
is kept for reuse detection (RRS-003). (b) Any direct library caller can step up *any* session id, because the
interface has no ownership. (c) The window is real: the password reauth path runs a full hash verify
(hundreds of ms, held to the timing floor) between `verify` and the write.

### Decision (per spec)

The spec has no behaviour for `reauthenticate` beyond `07-sessions.md:38` (amr union). The existing
liveness rule is "a tombstoned row is not live, and past either expiry is not live" (`isLiveAt`, TIR-003/SMS-002).
`findOwned`/`isLive` treat a dead row as **absent**. Apply the same rule:

- **A dead or foreign session fails `SessionNotFound`**, not `SessionExpired`. That keeps `E` unchanged and agrees
  with `findOwned`. `SessionExpired` is `verify`'s answer to a *presented credential* and carries a different
  client meaning (cookie clearing).
- **Add `userId`**: `reauthenticate(userId, id, amr?)`. The row must belong to `userId`. This is a breaking
  interface change (changeset `minor` with migration), consistent with `revokeOwned`/`findOwned`.
- Callers stop treating it as an invariant violation. The window is reachable, so answer what the caller needs:
  `Api.Unauthenticated` (401), the same answer `server/src/Session.ts:69-77` (EHA-009) gives for "revoked between
  middleware verify and this read". Both endpoints sit behind group-level `Authentication`, which declares
  `Unauthenticated`, so no endpoint error list changes. Each plugin Shape's `reauthenticate` `E` gains
  `Api.Unauthenticated`.

### Fix design

```ts
// Sessions.ts, interface
readonly reauthenticate: (
  userId: UserId,
  id: SessionId,
  amr?: ReadonlyArray<AuthMethod>,
) => Effect.Effect<SessionView, SessionNotFound | StoreUnavailable>;

// layerMemory
const reauthenticate: SessionsShape["reauthenticate"] = Effect.fnUntraced(function* (userId, id, amr) {
  const now = yield* DateTime.now;
  const updated = yield* Ref.modify(state, (s) => {
    const live = Option.filter(HashMap.get(s, id), (r) => r.userId === userId && isLiveAt(now, r));
    if (Option.isNone(live)) return [Option.none<SessionRow>(), s] satisfies [Option.Option<SessionRow>, typeof s];
    const refreshed: SessionRow = { ...live.value, authenticatedAt: now, amr: unionAmr(live.value.amr, amr ?? []) };
    return [Option.some(refreshed), HashMap.set(s, id, refreshed)] satisfies [Option.Option<SessionRow>, typeof s];
  });
  ...
});
```

(The existing code uses `as const` tuples here. New code uses a `satisfies` tuple, or an explicit
`Ref.modify` type argument, so no new `as` is introduced. Whether `as const` counts as a forbidden assertion is
not settled; see [Open questions](#open-questions-only-the-user-can-answer), Q6.)

SQL: the repository takes `userId` and `now` and guards in the `WHERE`, in one statement:

```sql
UPDATE sessions
SET "authenticatedAt" = ${authenticatedAt}, "amr" = COALESCE(${amr}, "amr")
WHERE "id" = ${id} AND "userId" = ${userId}
  AND "supersededAt" IS NULL
  AND "absoluteExpiresAt" > ${now} AND "idleExpiresAt" > ${now}
RETURNING *
```

Keep the `NoSuchElementError → SessionNotFound` mapping (`Sessions.ts:1737-1741`). Fix the amr pre-read the same
way, using `repo.findById` + `isLiveAt` + owner check, or leave it to plan 02 if it folds the union into SQL.

Callers:

```ts
// Password.ts:1707 and Passkey.ts:1855
yield* sessions.reauthenticate(input.userId, input.currentSessionId, ["pwd"]).pipe(
  Effect.catchTag("Sessions/NotFound", () => Effect.fail(new Api.Unauthenticated())),
);
```

The HTTP handlers should also expire the session cookie on this path, as `server/src/Session.ts:74` does
(`expireSessionCookie`). Check whether the password/passkey handler modules can reach that helper. If they
can't, return `Unauthenticated` only; the next request clears it anyway.

### Steps

1. `core/src/Sessions.ts`: interface + both layers.
2. `sql/src/Repositories.ts:1326-1337, 1670-1690`: repository signature `(id, userId, authenticatedAt, now, amr?)` and the query.
3. `password/src/Password.ts` (`reauthenticate` Shape `E` at `:347-351` + `:1707`), `passkey/src/Passkey.ts`
   (`reauthenticateVerify` `E` at `:559-…` + `:1855`).
4. Tests (below). `pnpm test:pg` (SQL adapter changed).
5. Spec: `spec/behaviors/07-sessions.md`: add **BEH-EA-319** (next free id; re-check at execution time, since other
   plans may allocate ids): "`reauthenticate` advances `authenticatedAt` only on a live session owned by the
   caller; a dead or foreign session is `SessionNotFound`". Add a REQUIREMENT block, Document Control 1.3.
   `spec/behaviors/15-password.md` and `17-passkey.md`: the reauth endpoint answers 401 when the session ended
   mid-request. `spec/traceability.md`: add the new BEH id to the 07 range and map it to the tests.
   `features/features/02-domain/07-sessions.feature`: add a scenario
   "Reauthenticating a revoked session is refused and leaves it unchanged".
6. Changeset (`@awthaq/core` minor, `@awthaq/sql` minor, `@awthaq/password` patch, `@awthaq/passkey` patch).
   `Migration:` `Sessions.reauthenticate(id, amr)` becomes `reauthenticate(userId, id, amr)`; a dead or foreign
   session now fails `SessionNotFound`; the password/passkey reauth endpoints answer 401 instead of 500 when the
   session ended during the request.

### Regression tests

In the shared contract `suite` (`core/test/Sessions.test.ts:134-788`, run against both layers at `:787-788`):

- `reauthenticate` on a superseded session fails `Sessions/NotFound` and leaves `authenticatedAt` unchanged
  (issue A, issue B with `supersedes: A`, reauth A).
- `reauthenticate` on an idle-expired session (use `ShortLivedMemoryLayer`/`ShortLivedSqlLayer` + `TestClock.adjust`)
  fails `Sessions/NotFound`.
- `reauthenticate` with another user's id fails `Sessions/NotFound`.
- Update the existing cases at `:331-365` and `:645-655` for the new signature.
- Plugin: `password/test/Password.test.ts`: revoke the current session between the middleware and the
  `reauthenticate` call (call the Shape directly with a revoked id) → `Unauthenticated`. Same in passkey.

---

## Item 4: one fresh-session gate (P1)

### Verified evidence

Three copies of the same five lines (`findOwned` → `None` fails; `isStale(authenticatedAt, maxAge, now)` fails),
each failing with its own error, all of which carry `{ maxAgeSeconds }`:

| Copy | Location | Error |
|---|---|---|
| passkey | `passkey/src/Passkey.ts:1201-1226` (`requireFreshSession`; the comment at `:1204-1206` says it "mirrors `@awthaq/qadi`'s own `reauthHandler`") | `PasskeyApi.PasskeyReauthRequired` (`PasskeyApi.ts:150`) |
| two-factor | `two-factor/src/TwoFactor.ts:494-513` (`requireFreshSession`) | `TwoFactorApi.TwoFactorReauthRequired` |
| qadi | `qadi/src/Resolvers.ts:229-271` (`reauthHandler`: findOwned at `:269`, isStale at `:274`) | `Api.ReauthRequired` (`api/src/Api.ts:109-113`) |

`Sessions.isStale` (`core/src/Sessions.ts:270-280`) is already shared. Its doc comment admits the pair is
duplicated. `findOwned` callers that are *not* freshness gates: `server/src/Session.ts:69`, `jwt/src/Jwt.ts:763`
(`isLive`).

**Searched for other copies:** admin, api-key, organization, jwt, device-authorization, `core/src/EmailChange.ts`.
There are none. **But one place that should gate does not.** `Password.requestEmailChange`
(`password/src/Password.ts:1524-1560`, endpoint `POST /change-email` in the authenticated `password.account`
group) has no freshness check. A hijacked session can therefore point the account's email at an attacker's
mailbox, confirm it, and then reset the password. BEH-EA-165's own worked example (`spec/behaviors/21-qadi-resolvers-obligations.md:147`)
is exactly "`changeEmail` requires `reauth`", but only through a qadi policy the host must write. `Password`'s
built-in endpoint does not apply it. This is a security posture choice → [Open questions](#open-questions-only-the-user-can-answer), Q2.

### Design: `Sessions.requireFresh`

An interface member on `Sessions`, with **one implementation** shared by both layers (built from `findOwned`), so
plan 02's merge has nothing extra to reconcile:

```ts
// core/src/Sessions.ts
/** BEH-EA-320: the session is live, owned by `userId`, and proved a credential within `maxAge`. */
export class SessionStale extends Data.TaggedError("Sessions/Stale")<{
  readonly maxAgeSeconds: number;
  /** `notLive`: absent, foreign, tombstoned or expired. `stale`: live but `authenticatedAt` is older than `maxAge`. */
  readonly reason: "notLive" | "stale";
}> {}

// in SessionsShape
readonly requireFresh: (
  userId: UserId,
  id: SessionId,
  maxAge: Duration.Duration,
) => Effect.Effect<SessionListItem, SessionStale | StoreUnavailable>;

// one implementation, module-private, used by both layers
const requireFreshVia =
  (findOwned: SessionsShape["findOwned"]): SessionsShape["requireFresh"] =>
  (userId, id, maxAge) =>
    Effect.gen(function* () {
      const maxAgeSeconds = Duration.toSeconds(maxAge);
      const current = yield* findOwned(userId, id);
      if (Option.isNone(current)) return yield* new SessionStale({ maxAgeSeconds, reason: "notLive" });
      if (isStale(current.value.authenticatedAt, maxAgeSeconds, yield* DateTime.now)) {
        return yield* new SessionStale({ maxAgeSeconds, reason: "stale" });
      }
      return current.value;
    });
// layerMemory / layerSql:  requireFresh: requireFreshVia(findOwned),
```

(`requireFreshVia`'s annotation is on a plain function returning an interface member type, which is how the
existing code types Shape members (`SessionsShape["findOwned"]`). It is not a return-type annotation on an
Effect/Layer const. If the reviewer reads the rule more strictly, inline it in each layer as
`const requireFresh: SessionsShape["requireFresh"] = (userId, id, maxAge) => …`, the form used for every other member.)

Why a `Sessions` member and not a free function: callers already hold `sessions`, the gate is a property of the
session store's liveness rule (`isLiveAt`), and a member gives a test seam (a test can stub it). The `reason`
field is kept because qadi's handler and the clients don't need it, but logs and future step-up UX ("your session
ended" vs "confirm your password") do. It costs one field.

Callers map it to their own wire error. That keeps the error *contract* per plugin (an existing client decodes
`PasskeyReauthRequired`, `TwoFactorReauthRequired`, `ReauthRequired`) and moves only the *rule* into one place:

```ts
// passkey
yield* sessions
  .requireFresh(userId, Sessions.SessionId(sessionId), config.reauthMaxAgeSeconds)
  .pipe(Effect.catchTag("Sessions/Stale", (e) => new PasskeyApi.PasskeyReauthRequired({ maxAgeSeconds: e.maxAgeSeconds })));
// two-factor: same with config.reauthMaxAge → TwoFactorApi.TwoFactorReauthRequired
// qadi reauthHandler: Duration.seconds(maxAgeSeconds) → Api.ReauthRequired
```

Unifying the three wire errors into `Api.ReauthRequired` is tempting (one client branch) but breaks the wire
contract of two plugins. Not done here; asked as Q3.

### Steps

1. `core/src/Sessions.ts`: `SessionStale`, interface member, `requireFreshVia`, wire into both layers. Export
   `SessionStale` from the module (it's already re-exported through `core/src/index.ts` as `Sessions.*`).
2. Replace the three copies (passkey, two-factor, qadi). Delete `requireFreshSession` in passkey and two-factor.
   Update `isStale`'s doc comment (`Sessions.ts:268-274`) to point at `requireFresh`.
3. Q2 = yes: `Password.requestEmailChange` calls `sessions.requireFresh(userId, currentSessionId, config.reauthMaxAge)`
   with a new `PasswordConfig.reauthMaxAge` (default 5 minutes, matching passkey's `reauthMaxAgeSeconds` default at
   `Passkey.ts:193`) and a new `PasswordApi.PasswordReauthRequired { maxAgeSeconds }` (403), declared on the
   `requestEmailChange` endpoint (`PasswordApi.ts:~360-366`). The request input needs `currentSessionId` (the
   handler has it from `CurrentPrincipal`). This follows the "richness" rule: it's a config knob with a real
   caller, and `"off"` (no gate) is possible via `Duration.infinity`.
4. Tests (below).
5. Spec: `07-sessions.md`: **BEH-EA-320** `requireFresh` (REQUIREMENT: live, owned, and `authenticatedAt` within
   `maxAge`, else `SessionStale` with `reason`). `17-passkey.md:219`, `31-two-factor.md` BEH-EA-263,
   `21-qadi-resolvers-obligations.md` BEH-EA-165: "uses `Sessions.requireFresh`". If Q2 = yes, `15-password.md:144`
   change-email paragraph gains the freshness requirement. Traceability rows for all.
6. Changeset (`@awthaq/core` minor: new interface member, so any hand-written `Sessions` test double must add it;
   `@awthaq/passkey`, `@awthaq/two-factor`, `@awthaq/qadi` patch; `@awthaq/password` minor if Q2 = yes, with
   `Migration:` "`POST /change-email` now needs a session that proved a credential within `reauthMaxAge` (default
   5 min); handle `PasswordReauthRequired` by running `POST /password/reauthenticate` and retrying, or set
   `reauthMaxAge: Duration.infinity` to keep the old behaviour").

### Tests (replace, don't layer)

- Move the behaviour to the contract suite in `core/test/Sessions.test.ts`: fresh → succeeds with the item; stale
  (TestClock past `maxAge`) → `Sessions/Stale` `reason: "stale"`; revoked → `reason: "notLive"`; foreign user →
  `notLive`; boundary at exactly `maxAge` is *not* stale (`isStale` uses strict `isGreaterThan`). Both layers.
- In passkey, two-factor and qadi, **delete** the tests that re-test staleness edge cases. Keep exactly one
  test per caller asserting the mapping (stale → its own error with `maxAgeSeconds`). Find them by grepping
  `ReauthRequired` under each package's `test/`.
- Q2 = yes: `password/test/PasswordChangeEmail.test.ts`: a stale session gets `PasswordReauthRequired`, and
  reauthenticating then retrying succeeds.

---

## Item 5: live subscribers see events from transactions that roll back (P1, new ADR)

### Verified evidence

`AuthEvents.publish` (`core/src/AuthEvents.ts:205-270`) does two things inline, in the caller's fiber:

1. `auditLog.record(published)` (`:227`) writes the durable row through the ambient `SqlClient`. Inside a
   transaction this row is part of the transaction and **rolls back with it**. That is correct and is what makes the
   ADR-EA-030 relay safe, because the relay tails only committed rows.
2. `PubSub.publish(pubsub, published)` (`:245`) hands the event to every live subscriber (`AuthEvents.on`,
   `stream`, `subscribe`) **immediately**. That cannot be undone.

So any publish inside a transaction that later fails tells live subscribers about something that never happened.
The audit log, the relay and webhooks never see it. Live in-process consumers (a cache invalidator, a session
kill-switch, `AuthEvents.on` reactions a host wrote, the observability counters) act on a phantom.

`AuditLog.layerSql.record` → `repo.insert` (`core/src/AuditLog.ts:498-507`) runs on the `SqlClient` captured at
`sql/src/Repositories.ts:2169` (insert at `:2283-2286`). Effect's sql resolves the transaction connection from the
fiber context, so the row joins the caller's transaction. Webhooks never subscribe to the bus: delivery tails the
committed log (`webhooks/src/WebhookDelivery.ts:103-133, 353` → `core/src/EventRelay.ts:132, 148-164`).

**Survey: every publish or observe-hook run inside a transaction** (all 33 `withTransaction` sites read; sites with
nothing inside are omitted):

| Transaction site | Operation | Published / run inside | Can it roll back afterwards? |
|---|---|---|---|
| `core/src/Erasure.ts:122-135` | `eraseAccount` | `sessions.revokeAll` (`:129`) → `auth.session.revoked` (`Sessions.ts:1628`); roles contribution → `auth.roles.revoked` per role (`roles/src/Roles.ts:292`); claims contribution → `auth.user.claimsUpdated` + `AfterUserAttributesChanged` (`qadi/src/UserClaims.ts:119, 126`) | **Yes.** `users.delete` (`:131`) re-runs the `BeforeUserDelete` veto (`Users.ts:1197`) and can fail, then `pseudonymizeActor` and COMMIT. This is the review's example, confirmed. |
| `password/src/Password.ts:1371` | `confirmReset` | the two-factor `BeforeCredentialReset` tap → `SecondFactor.check`: on a wrong code `auth.twoFactor.challengeFailed` / `auth.twoFactor.locked` (`two-factor/src/SecondFactor.ts:179, 186`), then `refuse` fails (`:193-194`) → `HookAbort` → **rollback**; on success `auth.twoFactor.verified` (`:337`) etc.; `users.verifyEmail` hook (`:1429`); `sessions.revokeAll` (`:1450`) | **Yes, deterministically on a wrong code.** And in the reverse direction: the `challengeFailed` audit row is **erased by the rollback**, so a brute force of the second factor through the reset form leaves **no audit trail** (the bus copy is the only trace). The comment at `:1447-1449` ("publishes … after this transaction's own write") is wrong: it runs inside. |
| `admin/src/AdminAccounts.ts:274` | `setUserPassword` | `sessions.revokeAll` (`:305`) | only on COMMIT failure |
| `password/src/Password.ts:1031` | `signUp` | `sessions.issue` (`:1054`) → `auth.session.issued` (`Sessions.ts:1376/601`), the nested `Sessions` transaction being a savepoint | only on COMMIT failure |
| `password/src/Password.ts:1486` | `verifyEmail` | `Users.verifyEmail` observe hook (`Users.ts:1112`) | only on COMMIT failure |
| `password/src/Password.ts:1569` | `confirmEmailChange` | `Users.changeEmail`/`verifyEmail` hooks (`Users.ts:1172, 1112`), `sessions.revokeAll` (`:1603`) | only on COMMIT failure |
| `oauth/src/OAuth.ts:1260`, `core/src/UserImport.ts:155`, `cli/src/Import.ts:231` | just-in-time create + link / import | `Users.verifyEmail` observe hook | yes (a later `link`/`ImportConflict` failure); the only tap today is a cache clear (`qadi/src/DecisionCacheInvalidation.ts:66`), so it is harmless now but not by design |
| **`sql/src/TenantScope.ts:127`** via `organization/src/TenantMiddleware.ts:113, 156` (`layerWithRls`, `layerWithConfigAndRls`) | **the whole HTTP request** of a tenanted Postgres deployment | **every** publish and observe hook of the request, including the ones every flow carefully places "after the commit" (`auth.user.created`, `auth.user.deleted`, `auth.user.signedIn`, `AfterSignIn`, …) | yes, whenever the handler exits with a failure or defect, or COMMIT fails (`SqlError` → 503) |

`Sessions.issue`'s own `sql.withTransaction(persist)` (`core/src/Sessions.ts:1354`) publishes *after* its
transaction (`:1358, 1367, 1376`), which is correct on its own, but it nests in any outer one. Password's token
miss already uses a hand-rolled version of the fix this item generalises: `consume(…, { deferMiss })` and then
`settleMiss` after the transaction (`Password.ts:769-779`).

**Two kinds of event, not one.** The survey shows events that record a *state change* (`session.revoked`,
`roles.revoked`, `user.created`) must appear **only if the unit commits**. Events that record an *attempt*
(`twoFactor.challengeFailed`, `twoFactor.locked`, `token.replay`, `user.signInFailed`, `rateLimit.exceeded`) must
appear **whether or not it commits**, including their audit row. Today the first kind leaks to the bus on
rollback, and the second kind loses its audit row on rollback. The design below handles both.

**Side hazard (inference, verify in `pnpm test:pg`):** on Postgres, a failed audit `INSERT` inside a transaction
aborts the transaction even though `"bestEffort"` catches the error (`AuthEvents.ts:228-240`), because there is no
savepoint around the insert. The fix is to wrap the in-transaction audit insert in a savepoint (a nested
`transactional`), or to document that `"bestEffort"` only holds outside transactions.

### Root cause

The transaction seam (`ports/src/SqlTransaction.ts`) is a pure pass-through: `withTransaction(effect)`. Nothing
inside the effect can learn whether it will commit. `AuthEvents.publish` is designed for "inline and never
suspends" (BEH-EA-098), with no notion of a unit of work.

### Design: an after-commit buffer at the transaction seam

**Interface** (in `@awthaq/ports`, next to `SqlTransaction`, since it belongs to the transaction seam and
`@awthaq/sql`'s `TenantScope` must use it without depending on core):

```ts
// ports/src/SqlTransaction.ts
export interface UnitOfWorkShape {
  /** Runs `effect` once the enclosing unit has committed, and never if it rolls back. Immediately when there is no unit. */
  readonly onCommit: (effect: Effect.Effect<void>) => Effect.Effect<void>;
  /**
   * Runs `effect` once the *outermost* unit has ended, committed or not, outside any transaction.
   * Immediately when there is no unit. For facts about an attempt that must survive a rollback.
   */
  readonly afterUnit: (effect: Effect.Effect<void>) => Effect.Effect<void>;
}
const noUnit: UnitOfWorkShape = { onCommit: (effect) => effect, afterUnit: (effect) => effect };
/** The ambient unit of work. Default: none, so run now. */
export const UnitOfWork = Context.Reference<UnitOfWorkShape>("awthaq/ports/SqlTransaction/UnitOfWork", {
  defaultValue: () => noUnit,
});
export const onCommit = (effect: Effect.Effect<void>) =>
  Effect.flatMap(UnitOfWork.asEffect(), (unit) => unit.onCommit(effect));
export const afterUnit = (effect: Effect.Effect<void>) =>
  Effect.flatMap(UnitOfWork.asEffect(), (unit) => unit.afterUnit(effect));

/**
 * The one way to open a real transaction in awthaq: `sql.withTransaction` plus a unit-of-work buffer.
 * A nested call (a savepoint) hands its commit lane to the parent on success and drops it on rollback;
 * its `afterUnit` lane always goes to the parent. Only the outermost call runs the lanes.
 */
export const transactional = (sql: SqlClient.SqlClient) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const parent = yield* UnitOfWork;
        const committed: Array<Effect.Effect<void>> = [];
        const always: Array<Effect.Effect<void>> = [];
        const unit: UnitOfWorkShape = {
          onCommit: (deferred) => Effect.sync(() => { committed.push(deferred); }),
          afterUnit: (deferred) => Effect.sync(() => { always.push(deferred); }),
        };
        const exit = yield* Effect.exit(
          sql.withTransaction(restore(Effect.provideService(effect, UnitOfWork, unit))),
        );
        // A success exit means COMMIT (outermost) or a kept savepoint (nested): makeWithTransaction turns a
        // failed COMMIT into a failure, so `committed` is dropped for every rolled-back unit.
        if (Exit.isSuccess(exit)) for (const deferred of committed) yield* parent.onCommit(deferred);
        for (const deferred of always) yield* parent.afterUnit(deferred);
        return yield* exit;
      }),
    );
```

The `afterUnit` work runs after `sql.withTransaction` has returned. At that point the fiber's context no longer
holds the transaction connection, so an audit `INSERT` made there lands on its own connection and commits by
itself. Verify this in the `ports` tests below.

Check `Context.Reference`'s accessor in the installed `effect@4.0.0-rc.116`. It may be `yield* UnitOfWork`
directly rather than `.asEffect()`. Note that `../effect` is 4.0.1, where `unstable/sql` has moved to `effect/sql`.
The repo is pinned to rc.116 (`pnpm-workspace.yaml:17`), so read
`node_modules/.pnpm/effect@4.0.0-rc.116/node_modules/effect/src/unstable/sql/SqlClient.ts` (`:162`, `:284-300`).
The commit/rollback behaviour relied on above is `makeWithTransaction` (in 4.0.1 at
`../effect/packages/effect/src/sql/SqlClient.ts:372-470`): commit failure → `orDie` → the exit is a failure;
a nested call is a savepoint and its rollback is `rollbackSavepoint`.

**Adapters:**

- `SqlTransaction.layerSql`: `withTransaction: transactional(sql)`.
- `SqlTransaction.layerNoop`: unchanged (`(effect) => effect`). The default `UnitOfWork` runs deferred work
  immediately. That is the honest answer for a memory composition, because its writes are not rolled back either
  (DRS-006 in the same file), and dropping the event would hide a write that did happen.
- Every direct `sql.withTransaction` in library source moves to `SqlTransaction.transactional(sql)`. The list is
  in the survey above; the important ones are `sql/src/TenantScope.ts:127` (the per-request Postgres tenant
  transaction, which wraps entire request handlers) and `core/src/Sessions.ts:1354`.

**Consumer:** `AuthEvents.publish` picks the lane from the event's kind:

- **State-change events (the default):** the audit row stays inline, inside the transaction, so it is atomic with
  the change. That is the transactional-outbox property ADR-EA-030 depends on. Only the bus hand-off is deferred:
  `yield* auditLog.record(published); yield* SqlTransaction.onCommit(publishToBus(published));`
- **Attempt events** (`auth.user.signInFailed`, `auth.token.replay`, `auth.twoFactor.challengeFailed`,
  `auth.twoFactor.locked`, `auth.rateLimit.exceeded`, and the rest of that family; the exact set is decided in the
  ADR): the audit row and the bus hand-off both run in `afterUnit`, so a rollback cannot erase the forensic record.
  `Password`'s `deferMiss`/`settleMiss` dance (`Password.ts:769-779`) then becomes unnecessary, and is deleted
  (replace, don't layer).

Where the "attempt" flag lives: in the event's own definition. That is **plan 09**'s subject ("event metadata
travels with the event schema"), so this flag is one more field in 09's metadata. If item 5 lands before 09, keep a
`ReadonlySet<AuthEventTag>` of attempt tags next to `AuthEventSchemas.ts` with a test that every tag is
classified, and let 09 move it into the definitions.

**Observe hooks** (`Hooks.After*`, `HookPoint.observe`) are the same problem one level up. Under the tenant
transaction, `afterSignUp.run` tells a host tap about a user whose sign-up may still roll back. `HookPoint.observe`'s
`run` gets the commit-lane deferral (`onCommit(runTaps(input))`). Observe taps are already fail-isolated
(BEH-EA-092) and their result is `void`, so deferring changes no caller's types. Veto and divert taps must stay
inline, because they decide the outcome.

**Guard so it stays fixed** (type-system first where possible, a test where not):

- Raw `sql.withTransaction` cannot be banned by types, because `SqlClient` is effect's own. Add an architecture
  test, `packages/core/test/Architecture.test.ts`, or extend `scripts/check-error-tags.mjs`'s pattern into a new
  `scripts/check-transactions.mjs` wired into `pnpm check`. It fails on any `\bsql\.withTransaction\(` in
  `packages/*/src` outside `ports/src/SqlTransaction.ts`.
- `SqlTransactionShape` is unchanged, so no plugin's types change.

### ADR draft

**ADR-EA-037: A Unit of Work Releases State-Change Events on Commit and Attempt Events Either Way**
(the next free number; `spec/decisions/index.yaml` ends at 036. Re-check at execution, since sibling plans may claim 037.)

- *Context*: `publish` writes the audit row inside the caller's transaction (atomic, correct for a state change)
  but hands the bus copy to live subscribers at once, so a rolled-back unit leaks phantom events: erasure,
  `confirmReset`, and every tenanted Postgres request. The same placement *erases* the audit row of an attempt
  event when the unit rolls back (a wrong second-factor code during `confirmReset`). Observe hooks leak like the bus.
- *Decision*: (1) Every real transaction is opened through `SqlTransaction` (`layerSql` or `transactional(sql)`),
  and that installs a `UnitOfWork` with two lanes: `onCommit` and `afterUnit`. (2) A state-change event records its
  audit row inline and releases its bus copy `onCommit`. An attempt event records both `afterUnit`, outside the
  transaction. The classification belongs to the event's definition (ADR from plan 09). (3) `HookPoint.observe`
  runs its taps `onCommit`; veto and divert taps stay inline. (4) A nested transaction hands its commit lane to the
  parent on success and drops it on savepoint rollback; its `afterUnit` lane always goes to the parent. Only the
  outermost unit runs the lanes. (5) With no transaction (memory composition, or code outside any unit), both lanes
  run immediately. (6) Raw `sql.withTransaction` in library source fails `pnpm check`.
- *Consequences*: positive: subscribers, observers, the audit log and the relay agree on what happened, and
  forensic events survive rollbacks. The ad-hoc `deferMiss`/`settleMiss` goes. Negative: inside a transaction a
  live subscriber learns of a state change after the commit rather than mid-transaction. BEH-EA-098 "never suspends"
  still holds, since buffering is a push. The lanes run on the committing fiber at the end of the unit. An attempt
  event's audit row takes its own connection. A host's own raw `sql.withTransaction` around awthaq calls is not
  covered; the docs tell hosts to use `SqlTransaction.transactional(sql)`.
- *Alternatives*: (a) feed in-process subscribers only from the relay. Rejected: adds `settleDelay` + poll latency
  to every in-process reaction, contrary to BEH-EA-097/098. (b) Move each publish after its transaction by hand.
  Rejected: no locality, already done inconsistently, and impossible inside a request wrapped by the tenant
  transaction. (c) One lane only (commit). Rejected: it would also drop the bus copy of attempt events and keep
  erasing their audit rows.
- Related: ADR-EA-030 (the relay reads committed rows, unchanged), ADR-EA-031 (erasure in one transaction),
  ADR-EA-028 (audit-write policy; the Postgres "aborted transaction" hazard above), plan 09 (event metadata).

### Steps

1. Write `spec/decisions/037-unit-of-work-event-release.md` (Document Control: Revision 1.0, Status "Accepted — not
   yet implemented" until step 7), and add it to `index.yaml`.
2. `ports/src/SqlTransaction.ts`: `UnitOfWork`, `onCommit`, `afterUnit`, `transactional`; `layerSql` uses it. Export
   from `ports/src/index.ts` and update `spec/overview.md`'s Ports surface block (`<!-- surface:ports -->`, which
   `check-drift.mjs` diffs).
3. Move every raw `sql.withTransaction` to `transactional(sql)`: `core/src/Sessions.ts:1354`,
   `sql/src/TenantScope.ts:127`, `admin/src/ImpersonationRecords.ts:566`, `cli/src/Import.ts:231`. Leave plain
   `SqlTransaction` call sites unchanged; they get it through `layerSql`.
4. `core/src/AuthEventSchemas.ts`: the attempt-tag set + a classification test (or plan 09's field).
   `core/src/AuthEvents.ts`: lane selection. `core/src/HookPoint.ts`: observe taps `onCommit`.
5. Delete `Verification.consume`'s `deferMiss` option and Password's `settleMiss` (`Password.ts:769-779`) if
   `auth.token.replay` is an attempt event. Fix the wrong comment at `Password.ts:1447-1449`.
6. Wrap the in-transaction audit insert in a savepoint, or document the `"bestEffort"` limitation, after confirming
   the Postgres hazard in `pnpm test:pg`.
7. Add `scripts/check-transactions.mjs` and wire it into `package.json`'s `check` script. Tests (below).
   `pnpm test:pg` (TenantScope and the hazard are Postgres-only). Flip the ADR status to implemented.
8. Spec: `spec/behaviors/13-events.md`: new behaviour (next free BEH id): "a live subscriber never observes a
   state-change event whose unit rolled back; an attempt event is recorded and delivered whether or not its unit
   commits". `12-hooks.md` BEH-EA-092: observe taps run after commit. `31-two-factor.md` BEH-EA-266 ("every outcome
   is audited"): now true through `confirmReset` too. Traceability rows. BDD: `features/features/04-cross-cutting/`
   events feature gets "An erasure vetoed after its sessions were revoked publishes no session.revoked", and
   `31-two-factor.feature` gets "A wrong second-factor code during a password reset is audited".
9. Changeset (`@awthaq/ports` minor: new exports; `@awthaq/core` minor: observable timing change + `deferMiss`
   removal; `@awthaq/sql`, `@awthaq/admin`, `@awthaq/cli`, `@awthaq/password` patch). `Migration:` "an
   `AuthEvents.on` handler or observe tap for an operation that runs in a transaction now runs after the commit,
   and not at all when the operation rolls back; failure/attempt events are now recorded even when the operation
   rolls back; `Verification.consume`'s `deferMiss` option is gone; host code that opens its own
   `sql.withTransaction` around awthaq calls should use `SqlTransaction.transactional(sql)`".

### Tests

- `ports/test/SqlTransaction.test.ts` (SQLite in-memory): `onCommit` work runs after commit and is dropped on
  failure; `afterUnit` work runs on both; a nested savepoint's `onCommit` is dropped when it rolls back while the
  outer one commits, but its `afterUnit` still runs; nothing runs before the outermost unit ends; with no
  transaction and on `layerNoop`, both run immediately; an `afterUnit` SQL write after a rollback persists.
- `core/test/AuthEvents.test.ts`: subscribe, then inside `transactional(sql)(… then Effect.fail)` publish one
  state-change and one attempt event. The subscriber gets only the attempt event, and `AuditLog.list` has only its
  row. The success path delivers both exactly once.
- `core/test/Erasure.test.ts`: a failing erasure step after `sessions.revokeAll` → no `auth.session.revoked` on the
  bus (the review's example).
- `password/test/PasswordHooksBeforeCredentialReset.test.ts` with SQL + two-factor: a wrong code → the reset
  rolls back, and `auth.twoFactor.challengeFailed` is both on the bus and in `AuditLog`.
- `core/test/HookPoint.test.ts`: an observe tap inside a rolled-back unit does not run.
- `sql/test/TenantScope.test.ts` (pg): a tenanted request that fails delivers no state-change event.

---

## Item 6: retention has no plugin contribution (P2)

### Verified evidence

- `core/src/Retention.ts:104-137` (`sweep`) purges exactly three core stores: `sessions.purgeExpired` (`:111`),
  `verification.purgeExpired` (`:112-114`), and `auditLog.purge` per rule and default (`:116-134`). There is no
  registry and no contribution type. `layerScheduled` (`:145-154`) is opt-in and is composed by nothing in
  library source. The CLI never runs it.
- By contrast `ErasureRegistry.contribute({ id, order?, make })` (`core/src/ErasureRegistry.ts:73-88`) and
  `DataExportRegistry.contribute` (`DataExportRegistry.ts:79-93`) are aggregating registries. They are built on
  `internal/contributionRegistry.ts`, provided by `Hooks.HooksLive` (per composition, ADR-EA-033), and plugged in
  through `AuthPlugin.layer(Self, { contributes })` (`core/src/AuthPlugin.ts:455-560`). Example:
  `organization/src/Organization.ts:1730/1756/1822`.
- ADR-EA-031 Decision 6 defines retention as "`Retention.sweep`, opt-in … never a side effect of a request" and
  never mentions plugin tables. Decision 4 notes passkey challenges and the JWT revocation store as not covered by
  *erasure*.

**Inventory of plugin tables that accumulate expirable or terminal rows** (verified by a source survey):

| Plugin | Table | Expiry signal | Pruned today | In `Retention`? |
|---|---|---|---|---|
| saml | `saml_session` (`saml/src/Saml.ts:269-278`) | `createdAt` older than `sessionRecordRetention` (default 90 d, `SamlConfig.ts:139`) | **inline on every SAML sign-in** (`Saml.ts:1055-1057` → `SamlRecords.ts:801-805`). That is a request-path side effect, contrary to ADR-031 D6's spirit | no |
| saml | `saml_sp_key` (`Saml.ts:236-247`) | `notAfter` | never | no |
| saml | AuthnRequest / assertion / LogoutRequest ids | core `Verification` TTL | yes, via `verification.purgeExpired` | **yes** |
| webhooks | `webhooks_delivery` (`webhooks/src/Webhooks.ts:225-242`) | terminal `status` + `completedAt` older than `deliveryRetention` (30 d) | own hourly loop in the opt-in worker (`WebhookDelivery.ts:299-347`) | no |
| device-authorization | `device_authorization_grant` (`DeviceAuthorization.ts:188-203`) | `expiresAt` | method only, `purgeExpired` (`:457`, `:1178-1181`), scheduled by nothing | no |
| admin | `admin_impersonation`, `admin_impersonation_chain` | `endedAt` | **never, by decision** (ADR-EA-031 D3, hash chain) | excluded |
| organization | `organization_invitation` (`Organization.ts:1371-1383`) | `expiresAt`, terminal `status` | never (only org delete / erasure) | no |
| passkey | `passkey_challenge` (`Passkey.ts:895-902`) | `expiresAt` (minutes) | inline on every `issue` (`ChallengeStore.ts:240-242`); `sweepExpired` (`:83`) is called by nothing | no |
| two-factor | `two_factor_recovery_code` | `usedAt` (terminal) | never (until regeneration or erasure) | no |
| api-key | `apikey_key`, `apikey_client` (`ApiKey.ts:305-355`) | `expiresAt` / `revokedAt` / `previousExpiresAt` | never | no |
| jwt | `jwt_signing_key` (`Jwt.ts:474-484`) | `retiresAt` | never | no |
| jwt | `jwt_token_revocation` (`Jwt.ts:503-508`) | `expiresAt` = token `exp` (expired rows read as absent) | never: grows by one row per revoked token, forever | no |
| oauth, magic-link, email-otp, two-factor challenges | (no own tables) | core `Verification` | yes | **yes** |

The review's examples need two corrections: **impersonation records are retained by decision**, so they are not a
candidate. **Verification-like stores** (SAML ids, 2FA challenges, magic link, OTP) are already covered, because
they live in core `Verification`. The real unbounded growers are `jwt_token_revocation`,
`device_authorization_grant`, `organization_invitation` and `apikey_*`.

Also drift: `Retention.ts:24` says impersonation retention is "by decision (ADR-EA-033)". The decision is
**ADR-EA-031** Decision 3. ADR-EA-033 is hook registries per composition. Fixed in item 8.

### Decision: add a `RetentionRegistry` (recommended), don't keep retention core-only

Keeping it core-only means every plugin invents its own pruning: inline on requests (saml, passkey), its own
loop (webhooks), a method nobody calls (device, passkey), or nothing (jwt, invitations, api-key). One registry
gives **leverage** (one scheduled sweep covers every installed plugin) and **locality** (each plugin's expiry
rule lives next to its table). It matches the Erasure/DataExport pattern a plugin author already knows
(`docs/plugin-authoring.md`).

```ts
// core/src/RetentionRegistry.ts, a copy of ErasureRegistry's shape on internal/contributionRegistry.ts
export interface RetentionContribution {
  readonly id: string;                   // "saml.sessions", "jwt.revocations"
  readonly order?: number;
  /** Deletes rows past this contribution's own window as of `now`; returns how many went. Bounded batches. */
  readonly purge: (now: DateTime.Utc) => Effect.Effect<number, StoreUnavailable>;
}
export class RetentionRegistry extends Context.Service<RetentionRegistry, RetentionRegistryShape>()(
  "awthaq/core/RetentionRegistry",
) {}
export const contribute = <E, R>(options: {
  readonly id: string;
  readonly order?: number;
  readonly make: Effect.Effect<RetentionContribution["purge"], E, R>;
}) => Layer.effectDiscard(/* same as ErasureRegistry.contribute */);
```

The window stays the plugin's config (`SamlConfig.sessionRecordRetention`, `WebhooksConfig.deliveryRetention`,
and new `…Retention` knobs where none exists). The registry passes only `now`. `Retention.sweep` gains
`plugins: ReadonlyArray<{ id, deleted }>` in `SweepReport`, runs each contribution after the core purges, and
isolates failures per contribution (log and count, continue). One plugin's outage must not stop core retention.
`Hooks.HooksLive` provides the registry. `sweep`'s R gains `RetentionRegistry`.

Per-plugin follow-through. These are separate small commits, each with its own changeset:

| Plugin | Contribution | Also |
|---|---|---|
| saml | `saml.sessions` → `records.pruneSessions(now - sessionRecordRetention)` | **remove the inline prune** at `Saml.ts:1055-1057` (keeps the request path free of maintenance, per ADR-031 D6). Migration note: SAML session records now age out only when the host runs `Retention.sweep` / `layerScheduled`. |
| device-authorization | `device.grants` → `grants.purgeExpired(now)` | keep `DeviceAuthorization.purgeExpired` as the public method (it is documented) |
| passkey | `passkey.challenges` → `sweepExpired` | keep the inline prune (it bounds a table on an anonymous endpoint) |
| jwt | `jwt.revocations` → delete rows with `expiresAt < now` | new repository method |
| organization | `organization.invitations` → delete terminal or expired invitations older than a new `invitationRetention` (default 30 d) | new knob + repository method (lands in plan 04's module split if 04 is in flight) |
| webhooks | `webhooks.deliveries` → `pruneFinished` | keep the worker's hourly prune, or remove it in favour of the sweep (Q4) |
| api-key, jwt signing keys, 2FA recovery codes | not contributed: they are credentials or audit-relevant state with no clear "safe to delete" point | document in ADR |

Plan 05 (plugin table substrate) may give plugins a declarative way to say "this table has an expiry column".
If it does, a contribution could be *derived* from the declaration instead of hand-written. Build the registry
here so the interface exists, and let 05 add the derivation.

### Steps

1. ADR: amend ADR-EA-031 (revision 1.x, Decision 6 gains "plugins contribute through `RetentionRegistry`")
   rather than a new ADR. It is the same decision, extended.
2. `core/src/RetentionRegistry.ts`, `HooksLive` provides it, `Retention.sweep` runs it, and `core/src/index.ts`
   exports it. `AuthPlugin`'s `contributes` already accepts any `Layer<never, …>`.
3. One commit per plugin row above.
4. `docs/plugin-authoring.md` gets a "Retention" bullet next to Erasure/Export. `examples/plugin-template` contributes
   one (the template's notes table, if it has a time column; otherwise document only).
5. `runPluginContractTests` (`packages/test`): if it already checks erasure and export contributions, add a
   retention check (a contribution's `purge` with `now` far in the future must not fail).
6. Spec: `spec/behaviors/13-events.md` or wherever retention behaviour lives (grep `Retention.sweep` in `spec/behaviors`);
   new BEH: "`Retention.sweep` runs every installed plugin's retention contribution; one failing contribution
   does not stop the others". Traceability.
7. Changeset: `@awthaq/core` minor (new module, `SweepReport` widened); each plugin minor or patch with a migration note.

### Tests

- `core/test/Retention.test.ts`: two fake contributions, one failing. `sweep` reports both, core purges still
  run, and the failure is logged.
- Per plugin: its contribution deletes only rows past the window (SQLite + memory where the records have twins).
- `features/`: a scenario in the retention feature, "an installed plugin's expired rows are swept".

---

## Item 7: email-domain claims are unique per protocol, not across protocols (P2, decision)

### Verified evidence

- OIDC/OAuth2 connections: `organization/src/ConnectionRecords.ts:15-17` (header: domains in their own table,
  "unique across *all* organizations", "asserted by the organization, not verified (no DNS-proof step)"),
  `ConnectionDomainTaken` (`:91-94`), the memory uniqueness check `firstTakenDomain` (`:166-180`), and the SQL
  lookup joining `organization_oauth_connection_domain` (`:375-381`).
- SAML connections: `saml/src/SamlRecords.ts:11-13` (`saml_connection_domain` "UNIQUE across all connections"),
  `SamlDomainTaken` (`:133-135`), the memory check `takenDomain` (`:259-268`, used `:290-293`), and the SQL `DomainRow` (`:503`).
- Each table is unique only **within itself**. Nothing stops org A claiming `acme.com` via OIDC and org B
  claiming it via SAML.
- `saml/src/Sso.ts:9-11`: when both protocols route a hint, `SsoConfig.preferred` wins (default `saml`) and
  `discoverAll` lists every match.

**Evidence correction:** the clash policy is **not** in ADR-EA-023. ADR-023 does not mention `discoverAll` or
clashes. Its Decision 4 (`023-…md:43`) still calls `Sso` "still Planned", which is item 8 drift. The policy is
specified in **BEH-EA-317** (`spec/behaviors/29-saml-sp.md:273-274`: "the configured `preferred` protocol MUST win
and `Sso.discoverAll` MUST list every match").

### The risk

Domains are unverified. With one table each, the cross-org case within a protocol is refused (`…DomainTaken`).
Across protocols it is accepted silently. Org B can add a SAML connection for `acme.com` while org A (the real
Acme) routes `acme.com` over OIDC. With the default `preferred: "saml"`, every `ada@acme.com` who clicks "Sign
in with SSO" is now routed to **org B's IdP**. The IdP still has to authenticate, so this is not an account
takeover by itself. It is, however, a phishing and denial-of-service lever controlled by any org admin. A
same-org clash, where Acme migrates OIDC → SAML, is legitimate and is the one case `preferred` exists for.

### Options

- **A: keep and document.** Write the cross-protocol, cross-org case into BEH-EA-317 and the security notes, and
  rely on `discoverAll` for visibility. Effort S. The hole stays open.
- **B: one shared domain-claim module enforcing uniqueness across protocols.** A deep module, `DomainClaims`,
  in `@awthaq/organization` (both protocols already depend on Organization: `Saml.ts:664` `dependsOn`). It has
  one table `organization_domain_claim(domain PK, organizationId, protocol, connectionId)`, and both
  `ConnectionRecords` and `SamlRecords` claim through it inside their create/update transaction. Rule: a domain
  belongs to **one organization**. The same org may route it over both protocols (`preferred` still picks),
  another org may not (`DomainClaimTaken`). This kills the cross-org lever, keeps the legitimate migration case,
  and is the natural place for the missing DNS-proof step later (a `verifiedAt` column). Effort M, with a
  migration that backfills from the two existing domain tables and **fails loudly** if existing data already
  holds a cross-org clash. The migration needs a decision on what to do then (Q5).

**Recommendation: B**, scoped to "one organization per domain". It removes a security-relevant asymmetry rather
than documenting it, and gives domain verification a home. Build it inside **plan 04** (organization system
modules), which is already splitting Organization's records. If 04 is not doing it, build it here after 04 lands.

### Steps (if B)

1. `organization/src/DomainClaims.ts`: interface `claim(org, protocol, connectionId, domains)`,
   `release(connectionId)`, `ownerOf(domain)`; memory + SQL twins; migration + backfill.
2. `ConnectionRecords.create/update` and `SamlRecords.create/update` call it in their transaction. The per-table
   uniqueness stays as defence in depth, or is dropped if the shared table makes it redundant (plan 04 decides).
3. `Sso.discover` unchanged (same-org clashes still use `preferred`).
4. Spec: BEH-EA-317 + `spec/models/09-sso.md` + `10-saml.md`; ADR-EA-023 Decision 4 refreshed (it's stale anyway).
5. Tests: cross-org cross-protocol claim refused (both directions), same-org both protocols allowed, release on
   connection delete, migration clash detection.
6. Changeset `@awthaq/organization`, `@awthaq/saml` minor, with a migration note about the backfill and the clash failure.

---

## Item 8: docs and index drift (P2)

Each line below was re-verified. Fix them all in one docs commit, apart from the code renames noted.

| # | Drift | Evidence | Fix |
|---|---|---|---|
| 8a | `index.yaml` says ADR-EA-023 "SCIM implemented; SAML specified, not yet built" | `spec/decisions/index.yaml:96`. The ADR file itself says "Accepted — SCIM and SAML (SP) implemented" (`023-…md:9`) | copy the file's status |
| 8b | ADR-EA-023 Decision 4 calls `Sso` "still Planned" | `023-…md:43`. Implemented: `saml/src/Sso.ts`, `spec/models/09-sso.md:24` | revise Decision 4 (revision 1.2) |
| 8c | `spec/overview.md` banner: two-factor and magic-link are "placeholder packages with no exports yet", SAML is "not built" | `overview.md:17`. All three ship real modules (`two-factor/src` 10 files, `magic-link/src` 7, `saml/src` 18) | rewrite the banner; Document Control 1.3 |
| 8d | Overview plugin roster: `magic-link`, `two-factor` "(placeholders)"; `saml` "(specified only)"; **`webhooks` missing** | `overview.md:55` | list all shipped plugins: password, oauth, passkey, jwt, api-key, organization, roles, admin, scim, device-authorization, magic-link (with email-otp), two-factor, saml (with Sso), webhooks |
| 8e | `spec/roadmap.md` repeats it: TwoFactor/MagicLink "placeholder", EmailOtp "no package", SAML "specified but not built", M7 "Partly implemented (TwoFactor, MagicLink, EmailOtp not built)" | `roadmap.md:22, 25, 123` | update all three lines (not in the review) |
| 8f | BEH-EA-093 "As shipped": says `Hooks.BeforeSignIn` returns `TwoFactorRequired { challenge }` and every first-factor sign-in handles it "through the shared finalisation step" | `spec/behaviors/12-hooks.md:109`. The divert is **`Hooks.BeforeSessionIssue`** (`core/src/Hooks.ts:109`); the payload is `{ userId, challengeId }` (`Hooks.ts:91-95`); there is no shared finalisation step today, because each of six plugins runs the divert itself; and the list omits OAuth, passkey, SAML, device | interim wording below; plan 01 then makes "shared" true |
| 8g | plugin-authoring says the template's veto helper "is five lines; copy it" | `docs/plugin-authoring.md:41`. `HookPoint.aborted(point)` (`core/src/HookPoint.ts:124-138`) is that helper, exported; core plugins use it (`OAuth.ts:1359`, `Channel.ts:165`, `Erasure.ts:118`) | doc: "use `HookPoint.aborted(Point)(point.run(…))`"; the template (`examples/plugin-template/src/Template.ts:213-227`) drops its local `veto` and uses `HookPoint.aborted`. `Organization.ts:1897-1907` has the same local copy → **plan 04** |
| 8h | `webhooks/src/WebhookRecords.ts:736` `const sealed = <A, E>(effect) => Effect.orDie(effect)`: the name suggests encryption ("seal"), but it turns every store error into a defect (36 uses) | verified | **plan 05** replaces plugin `orDie` with `StoreUnavailable`, which removes `sealed` altogether. If 05 slips, rename to `dieOnStoreError` with a comment pointing at ADR-EA-028. Not done here, to avoid touching 36 lines twice |
| 8i | SCIM, SAML and AdminTenants read Organization's data but don't declare `readsTables` | `readsTables` exists (`core/src/AuthPlugin.ts:92, 205, 322`). Its only consumer is JH-007's `checkTableDependencies` (`core/src/Auth.ts:545-566`), which only requires the owner in `dependsOn`. All three already declare `dependsOn: [Organization]` (`scim/src/Scim.ts:421`, `saml/src/Saml.ts:664`, `admin/src/AdminTenants.ts:173`). They read through Organization's **records services** (`OrganizationRecords`, `TeamRecords`), not raw SQL, and contain no `organization_*` SQL | **No observable gap today.** Declaring `readsTables` would make the dependency survive someone deleting `dependsOn`. Recommended as a P2 one-liner each, listing the tables each reaches (SCIM: `organization_org`, `organization_team*`, `organization_membership`; SAML: `organization_org`; AdminTenants: `organization_org`, `organization_membership`). Plan 04's module split may change which records modules they use, so **leave to plan 04** and note it there |
| 8j | `Retention.ts:24` cites ADR-EA-033 for impersonation retention | the decision is ADR-EA-031 D3 (`031-…md:25`) | fix the comment |
| 8k | `index.yaml` ADR-EA-028 status "AuditLog pending" | item 9 | item 9 |

**Interim wording for BEH-EA-093 (8f)**, true today and still true after plan 01:

> **As shipped (ARF-005, THS-001).** `@awthaq/two-factor` is the first divert consumer: it taps
> `Hooks.BeforeSessionIssue`, which every first-factor sign-in (password, OAuth, passkey, SAML, magic link, email
> OTP, device authorization) consults immediately before it issues a session. For a user with a confirmed second
> factor the tap answers `TwoFactorRequired { userId, challengeId }`, and no session exists until the challenge is
> proved. The divert context carries `amr`, the methods already proved, so the session minted by the second
> factor records both. *(Plan 01 moves this consultation into one shared sign-in completion in core; this
> paragraph then names it.)*

Then 12-hooks.md Document Control 1.2.

**Prevent recurrence** (cheap and mechanical, in `spec/scripts/check-drift.mjs`, which `pnpm check` already runs
via `spec:verify:strict`):

- **Check 15, "ADR index status matches the ADR":** for each `index.yaml` entry, normalise both statuses (strip
  backticks; cut at the first ` (`) and compare. Run on today's tree, this flags exactly 023 and 028. The four
  other differences (010, 025, 034, 035) are abbreviations that normalise equal.
- **Check 16, "plugin roster matches packages":** every `packages/*` whose `src` defines an `AuthPlugin.Service`
  appears in `overview.md`'s plugin row, and no row entry is annotated `placeholder`/`specified only` when the
  package's `src/index.ts` has exports. (Simpler alternative: add `/placeholder packages? with no exports/i` and
  `/\(specified only\)/i` to the `STALE` list at `check-drift.mjs:50-65`.)

Changeset: none for pure spec/doc changes (they are outside `packages/`). The template change is under `examples/`.
If CI's `changeset status` complains, use `pnpm changeset --empty` (CONTRIBUTING.md:92).

---

## Item 9: ADR-EA-028 status (P2)

### Verified evidence: the premise is false in code, true only in the index

- `core/src/AuditLog.ts`: every method's `E` carries `StoreUnavailable`: `record` (`:119`), `list` (`:123`),
  `replay` (`:133`), `pseudonymizeActor` (`:142`), `purge` (`:153`), with `orStoreUnavailable(...)` at
  `:518, 531, 549, 556, 571`. Only `SchemaError`/`NoSuchElementError` die (`:503-505`), which ADR-028 Decision 3 allows.
- The ADR file already says "implemented for `Sessions`, `Verification`, `Users`, `Accounts` and `AuditLog`"
  (`028-…md:9`, revision 1.1 "`AuditLog` converted").
- Only `spec/decisions/index.yaml:116` still says "AuditLog pending".

### Fix

Update `index.yaml:116` to the file's status. Check 15 above keeps it from drifting again. While there, extend
the ADR's Rollout with item 2's sign-in sites (revision 1.2). Nothing to plan in code.

---

## Interactions with plans 01-09

| Plan | Shared seam | What this plan does first / leaves | What the other plan must do |
|---|---|---|---|
| **01** sign-in/sign-up in core | the six `BeforeSessionIssue` call sites; `sessions.issue` callers | Items 1 and 2 hotfix the per-plugin sites **before** 01 | 01 **moves** the item 1 and 2 tests to its core `SignIn` interface and deletes the per-plugin ones; makes `amr` structurally shared between divert and issue (required field or one value); **owns the SAML + 2FA continuation gap** (SLO record + role mapping after `finalizeSignIn`); converts the remaining `orDie` on `Password.ts:1053/1056/1677` and `Admin.ts:1106`; writes BEH-EA-093's final wording (8f) |
| **02** store seam | `Sessions` interface and twins | Item 3 changes `reauthenticate`'s signature and liveness in both twins; item 4 adds `requireFresh` built once from `findOwned` | 02 keeps item 3's contract tests as the merged module's tests; folds the `reauthenticate` amr read-then-write into one statement; carries `requireFresh` over unchanged |
| **03** erasure single cascade | `Erasure.ts` transaction | none | if 03 lands before item 5, item 5's erasure test targets 03's cascade; if after, 03 must open its transaction through `SqlTransaction` (not raw `sql`) |
| **04** organization modules | `ConnectionRecords`, the `veto` copy at `Organization.ts:1897` | Item 7 decision; 8g fixes the template only | 04 builds `DomainClaims` if Q5/item 7 = B; replaces its local `veto` with `HookPoint.aborted`; decides `readsTables` (8i) |
| **05** plugin table substrate | plugin `orDie`; plugin tables | 8h deferred; item 6 builds `RetentionRegistry` | 05 removes `sealed` and other plugin `orDie`s (incl. `PasskeyCredentials.recordUsage`); may derive retention contributions from declared expiry columns |
| **06** rate-limit budget | none | none | none |
| **07** `Verification.redeem` | the redeem transaction | Item 5 must land first, or 07 must use `SqlTransaction`/`transactional`, so redeem's events are after-commit | 07's completion transaction publishes through the buffer automatically |
| **08** test composition | `TestAuth.layer` | none | `TestAuth` should include `RetentionRegistry` (via `HooksLive`) |
| **09** event definitions | `AuthEvents.publish`, `AuthEventSchemas.ts` | Item 5 changes *when* the bus copy and audit row are released and needs a per-event "attempt vs state change" flag | 09 adds that flag to each event's definition (replacing item 5's interim tag set); coordinate edits to `AuthEvents.ts` |

---

## Acceptance checklist

- [ ] Item 0: `ApiKey.resolve` (and the client path) refuse a suspended or missing owner; `api-key` contributes to `ErasureRegistry` and `DataExportRegistry`; regression tests and BDD scenario pass; changeset added.
- [ ] Item 1: SAML passes `amr: ["fed"]` to `BeforeSessionIssue`; unit test + BDD scenario (`fed`,`otp`,`mfa`) green; the SLO/role-mapping gap is recorded in ticket 01 and handed to plan 01.
- [ ] Item 2: no `orDie` on `sessions.issue` / `users.findById` / `accounts.*` in the password, passkey, oauth and saml sign-in paths; four Shape-level tests + one HTTP 503 test green.
- [ ] Item 3: `reauthenticate(userId, id, amr?)` refuses dead and foreign sessions in both layers (contract suite green on memory + SQLite + `pnpm test:pg`); password/passkey answer 401 on the race.
- [ ] Item 4: `Sessions.requireFresh` exists, both layers share one implementation, the three copies are deleted, and per-caller tests only assert the mapping. Q2 is answered and implemented or explicitly declined.
- [ ] Item 5: ADR-EA-037 accepted; `UnitOfWork` (`onCommit`/`afterUnit`) + `transactional` in ports; the four raw `sql.withTransaction` sites migrated; state-change bus copies and observe taps released on commit; attempt events recorded either way (`confirmReset` wrong-code test green); `deferMiss` removed; transaction check in `pnpm check`; `pnpm test:pg` green.
- [ ] Item 6: `RetentionRegistry` + `sweep` integration; ADR-EA-031 amended; at least saml, device, jwt revocations and invitations contribute; SAML's inline prune removed.
- [ ] Item 7: user decision recorded; A documented in BEH-EA-317, or B built (in 04 or here).
- [ ] Item 8: all rows 8a-8k fixed or explicitly handed to 01/04/05; check-drift checks 15 and 16 pass.
- [ ] Item 9: `index.yaml` matches ADR-EA-028.
- [ ] Every behaviour change has its `spec/behaviors` entry (revision + change history), `spec/traceability.md` row and BDD scenario; every package-visible change has a changeset with `Migration:`.
- [ ] `pnpm check` green; `pnpm test:pg` green (items 3, 5, 6, 7).

---

## Open questions only the user can answer

0a. **Suspended owner's API key (item 0):** refuse as "no principal" (401, indistinguishable from a bad key; recommended, matching BEH-EA-046's "a wrong credential never learns whether an account is suspended") or as `UserSuspended` (403)?
1. **SAML role mapping before the second factor (item 1).** Move `applyRoleMapping` ahead of the divert as an
   interim fix, so a 2FA'd SAML user's roles stay in step with the IdP? It writes directory facts before the second
   factor is proven. The SLO-record half needs plan 01 regardless.
2. **Freshness on `POST /change-email` (item 4).** Add a `reauthMaxAge` gate (default 5 min, `Duration.infinity`
   to disable) to `Password.requestEmailChange`? It closes a hijacked-cookie → email swap → password reset chain,
   and it is a breaking change for clients.
3. **One wire error for "reauthenticate first" (item 4).** Keep the three per-plugin errors
   (`PasskeyReauthRequired`, `TwoFactorReauthRequired`, `Api.ReauthRequired`), or converge on `Api.ReauthRequired`
   (one client branch, breaking two plugins' wire contracts)? The plan keeps them.
4. **Webhooks pruning (item 6).** Once `RetentionRegistry` exists, should webhooks' own hourly prune in the
   worker go (one mechanism), or stay (deliveries can churn faster than a daily sweep)?
5. **Domain claims (item 7).** A (document the cross-org, cross-protocol clash) or B (one organization per domain
   across protocols)? If B: when the backfill finds an existing cross-org clash, should the migration fail, or
   keep the older claim and disable the newer connection's domain?
6. **`as const`** in existing tuple returns (e.g. `Sessions.ts:1193-1201`, `ConnectionRecords.ts:183`): does the
   no-assertions rule cover const assertions? This plan avoids adding new ones either way, and does not strip
   existing ones.
7. **Observe hooks after commit (item 5).** Defer `HookPoint.observe` taps as well as the bus? Recommended for
   consistency. It changes when a host's `AfterSignUp`/`AfterSignIn` taps run inside a transaction (after commit,
   and not at all on rollback).
8. **Which events are "attempt" events (item 5)?** The proposal: `auth.user.signInFailed`, `auth.token.replay`,
   `auth.twoFactor.challengeFailed`, `auth.twoFactor.locked`, `auth.rateLimit.exceeded`, and the denial family (`auth.admin.actionDenied`,
   `auth.admin.impersonationDenied`, `auth.authz.denied`, `auth.organization.permissionDenied`,
   `auth.deviceAuthorization.denied`).
   These are recorded even when the surrounding operation rolls back. Is that the right set?

---

## Decisions taken (execution of items 3, 4, 8 and 9)

Open questions answered with the plan's recommended default; Q2 and Q3 below.

1. **Q2, freshness on `POST /change-email`: yes.** `Password.requestEmailChange` calls `Sessions.requireFresh` with the new `PasswordConfig.reauthMaxAge` (default 5 minutes, `Duration.infinity` turns it off) and fails the new `PasswordApi.PasswordReauthRequired { maxAgeSeconds }` (403), declared on the endpoint. The input gained `currentSessionId`. The gate runs after the requester's own rate-limit spend and before the target inbox's, so a stale session never burns the target's budget.
2. **Q3, one wire error: no.** The three per-plugin errors stay (`PasskeyReauthRequired`, `TwoFactorReauthRequired`, `Api.ReauthRequired`), plus the new `PasswordReauthRequired`. Only the rule moved, into `Sessions.requireFresh`.
3. **Q6 (`as const`)**: no new const assertion added; the existing `as const` tuples in `layerMemory`'s `reauthenticate` were kept as they were.

Deviations and details found while executing:

- BEH ids: `BEH-EA-319` (reauthenticate) and `BEH-EA-320` (requireFresh), in `07-sessions.md`; BDD `REQ-EA-1276` and `REQ-EA-1277`.
- The SQL repository signature is `reauthenticate(id, userId, now, amr?)`: the plan's separate `authenticatedAt` and `now` are the same instant, so they are one parameter.
- The amr read-then-write in `layerSql.reauthenticate` is left for plan 02 (as the plan allows); the guard is in the `UPDATE`'s own `WHERE`, so a row that dies between the read and the write is still refused.
- The password/passkey handlers answer `Unauthenticated` without expiring the session cookie (the plan allowed this; the next request clears it).
- `requireFreshVia` has no return-type annotation (inferred); the per-plugin `requireFreshSession` helpers stay as thin error mappers over `requireFresh` instead of being deleted, because three passkey entry points and two two-factor ones share the mapping. No per-caller test re-tested staleness edge cases (they test that each entry point applies the gate and maps its error), so none was deleted; the edges are in the Sessions contract suite.
- No HTTP-level 403 test for `PasswordReauthRequired` (the web-handler harness uses the real clock and a zero window would be timing-fragile); the Shape-level tests and the wire annotation cover it.
- Item 8: check-drift got two new checks (numbered 18 and 19 there; 15-17 were taken): ADR index status equals the ADR file, and the overview plugin roster names every package that defines an `AuthPlugin.Service`. Adding the `placeholder` / `(specified only)` phrases to `STALE` surfaced more stale text than the plan listed: root `README.md` (status, package map, plugin table: now lists device-authorization, magic-link, two-factor), `spec/models/00-adoption-matrix.md`, `05-email-otp.md`, `06-two-factor-totp.md`. Fixed. The retention-sweep citations of "ADR-EA-033" (Retention.ts header, BEH-EA-051 and BEH-EA-057 notes) are ADR-EA-031 Decision 6; fixed with 8j.
- Not done, as the plan says: 8g's `Organization.ts` local `veto` copy (plan 04), 8h `sealed` (plan 05), 8i `readsTables` (plan 04).
- Item 9: only `spec/decisions/index.yaml` changed; ADR-EA-028 already carried revision 1.2 for item 2's sign-in sites.

## Decisions taken (execution of item 5)

1. **Q7, observe hooks after commit: yes.** `HookPoint.observe`'s `run` defers its whole tap chain to `SqlTransaction.onCommit`; veto and divert taps stay inline. Because the chain then runs after the transaction has returned, `run` captures the call's `TenantContext` and `AuthRequestContext` and re-provides them to the deferred chain.
2. **Q8, attempt events: the plan's set, exactly:** `auth.user.signInFailed`, `auth.token.replay`, `auth.twoFactor.challengeFailed`, `auth.twoFactor.locked`, `auth.rateLimit.exceeded`, `auth.admin.actionDenied`, `auth.admin.impersonationDenied`, `auth.authz.denied`, `auth.organization.permissionDenied`, `auth.deviceAuthorization.denied`. The flag lives in plan 09's definition: `defineEvent(..., { attempt: true })`, stamped as `attempt: boolean` on the event metadata and read by `AuthEvents.isAttemptEvent(tag)`. It is an **optional** declaration key (default: state change), not required like `actor`/`pii`: the default is the safe one (a missed attempt event is merely delayed to commit) and requiring it would touch ~140 declarations for one `true`. A test pins the exact set.
3. **ADR-EA-037** is `spec/decisions/037-unit-of-work-releases-events-on-commit.md` (the file name differs from the plan's draft; the README reservation holds). BEH-EA-321 in `13-events.md`; BDD `REQ-EA-1278`/`1279` (13-events.feature) and `REQ-EA-1280` (the two-factor reset audit, in 15-password.feature under BEH-EA-259, because the reset steps are wired only over that feature's World; `31-two-factor.feature` defines the same "a new time step begins" step).
4. **More than four raw sites migrated.** The plan counted four; the grep found nine files with a bare `sql.withTransaction(` (`Accounts`, `Sessions`, `TeamRecords` x8, `ConnectionRecords` x3, `UserClaims`, `TwoFactorStore`, `ImpersonationRecords`, `cli/Import`, `TenantScope`). All moved to `SqlTransaction.transactional(sql)`, because the `check-transactions` guard bans every one.
5. **`deferMiss`/`recordMiss` removed, but the attempt spend moved too.** Plan step 5 only mentioned the event. `consume` also spent a budgeted token's attempt on a miss, which would roll back with the transaction, so the SQL layer runs that spend in `afterUnit`, **best effort** (a store failure is logged, not surfaced: the miss must keep answering uniformly, BEH-EA-116). `Verification.recordMiss` and `ConsumeOptions` are gone from the interface; Password's `TokenMissed`/`settleMiss` are deleted.
6. **Postgres hazard confirmed and fixed.** Confirmed against `postgres:16` (`current transaction is aborted`): a failing audit `INSERT` aborts the transaction even under `"bestEffort"`. Fixed in `AuditLogRepository.insert` (a savepoint when `sql.transactionService` is present), not in `AuditLog.layerSql`, so the layer's requirements did not change.
7. **Lanes run interruptibly.** `transactional` runs the unit under `uninterruptibleMask` but each deferred lane item under `restore`, so a host's observe tap cannot make a fiber unkillable.
8. **Test layout.** The unit-of-work contract tests are in `packages/sql/test/UnitOfWork.test.ts` (`@awthaq/ports` has no SQL driver; the file is also in `scripts/test-pg.sh`), not `ports/test`. `packages/core/test/AuthEventsUnitOfWork.test.ts` (also in `test-pg.sh`) covers the bus, the audit log, the savepoint and (Postgres only) a failed `TenantScope.withTenant` request; there is no separate `sql/test/TenantScope.test.ts`. The two-factor harness gained `buildDurableAuditLayer` (SQLite audit log + real `SqlTransaction.layerSql`) for the `confirmReset` wrong-code test.
9. **Notes for plans 07 and 02.** `redeem`'s completion transaction should open through `SqlTransaction.transactional`/the port and publish normally; its events follow the commit with no extra code, and a miss/replay is an attempt event handled by `consume`. A store seam (02) that offers its own transaction must build it on `transactional` (the guard script checks `packages/*/src`).
