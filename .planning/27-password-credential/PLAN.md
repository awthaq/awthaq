# Plan 27: One password credential module (verify, policy, set, rehash)

| | |
|---|---|
| Source | Architecture review of 2026-11-08 (`/improve-codebase-architecture`), candidate "one password credential module owns lookup, verify-with-timing-floor, policy and set" |
| Strength | **Worth exploring** (review). This plan's evidence argues for **Strong**: one confirmed policy defect (admin-set and seeded passwords skip breach screening and ignore `Password.config`), five ADR-EA-028 violations on the credential path, and a non-atomic credential change (§2.5). |
| Dependency category | **in-process** (no new port and no new adapter: the module sits over core `Accounts`, the `PasswordHasher` port and `HttpClient`, all already in `Password.layer`'s requirements) |
| Wave / position | Proposed **Wave E**, independent of plans 25, 28 and 30. Ticket 04 (ADR-EA-028 hotfix in place) has no dependency and can ship alone in Wave 0. Land after plan 26 if both are scheduled together (26 rewrites the `PasswordShape` inputs mechanically; this plan rewrites bodies), and before plan 29's password-events slice (§8). |
| Touches | `@awthaq/password` (new `PasswordCredential` module, `PasswordConfig` extracted, `Password.ts` slimmed), `@awthaq/admin` (`AdminAccounts dependsOn: [Password]`, `AdminConfig.passwordPolicy` removed), `@awthaq/cli` (`seed admin`), `@awthaq/migrate-better-auth` and `@awthaq/migrate-firebase` (the provider constant only), `spec/`, `features/` |
| Wire change | **None** to paths, payloads or error schemas. Behaviour: an administrator-set or seeded password is screened by the one policy (more `422 AdminWeakPassword` / exit-2 usage errors, hint `appears in known breaches`); `change-password`, `reauthenticate` and `confirm-reset` answer `503 StoreUnavailable` instead of `500` on a store outage; `change-password` commits as one unit. Composition: `Auth.make([Admin, AdminAccounts])` without `Password` no longer compiles. |
| ADRs | New **ADR-EA-048** (reserved for this plan). ADR-EA-040 gains a revision note (its second user). No ADR is contradicted (§6.2). |
| Verified at | **2026-11-08, `ede063d8` + working tree.** The brief named `6c5377f8`; HEAD has since moved one commit ("Upgrade effect to 4.1 stable and qadi to 0.11"). The uncommitted changes touch only `package.json` files, `pnpm-lock.yaml` and `pnpm-workspace.yaml`; no source file differs (`git diff --name-only \| grep -v 'package.json\|pnpm-'` is empty). |
| **Base drift (read first)** | **Orchestrator note: renumbered to plan 27; its ADR is ADR-EA-048 (042–047 taken) and its new behaviour is BEH-EA-345 (338–344 taken: 339 by plan 17, 340–342 by plan 15, 343 by plan 21, 344 by plan 20), and the batch-3 plans it cites are now 25 record-store-contract, 26 request-context, 28 sql-store-adapters, 29 plugin-owned-events, 30 speculative-followups.** While this plan was being written, the checkout changed. It is now branch `architecture/deepening-plans-2` (HEAD `5a0e8df4`), with a merge of `main` in progress (`.git/MERGE_HEAD` exists, ~467 paths changed). That branch carries a **second batch of plans 11–24** (review of 2026-10-17, partly implemented), which this batch's brief does not mention. Three facts from it matter here. (1) **ADR-EA-042 and ADR-EA-043 are already taken there**: `042-credential-resolution-module.md` and `043-federated-identity-resolution.md`, both "Accepted — implemented". The reservation of ADR-EA-043 for this plan collides, and the orchestrator must renumber; this plan's text says ADR-EA-043 throughout. (2) Batch-2 plan **13-admin-gate** is implemented there: `AdminAccounts` reads `passwordPolicy` per tenant through an `AdminGate` clearance (`cleared.config.passwordPolicy`). The breach-screening defect of §2.6 still holds on that branch; the "not tenant-aware" sub-point does not. (3) Batch-2 plan **18-verification-link-redeem** is implemented there: `confirmReset` runs `checkPolicy` as the redeemer's `beforeClaim` and has gained a per-source budget. Every `file:line` below is verified at `ede063d8`, the base the brief named. §8.1 lists what changes when this plan is rebased onto `architecture/deepening-plans-2`. |
| Effect | Catalog `effect: ^4.1.2` (dev) / `^4.1.0` (peer); installed `node_modules/.pnpm/effect@4.1.2`. The `.planning/README.md` line "the repo pins `effect@4.0.0-rc.116`" is stale. Every API in §3 was checked against the installed 4.1.2 sources: `Context.Service` (Context.ts:209), `Context.Reference` (:2118), `Brand.nominal` (Brand.ts:235), `Effect.fnUntraced` (Effect.ts:24100), `Effect.exit` (:3916), `Effect.succeedSome` (:1688), `Effect.cached` (:14530), `Redacted.make` (Redacted.ts:192), `isSqlError` (`effect/sql/SqlError`, used at core `SignUp.ts:28`). |

Conventions: everything in [`.planning/README.md` § Shared conventions](../README.md#shared-conventions-apply-to-every-plan) applies: no `as` (including `as const`), no return-type annotations on new Effect/Layer consts, type-system first, replace-don't-layer tests, spec + traceability + BDD updates, a changeset with a `Migration:` note for every package-visible change, the per-phase gate `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`, `pnpm check` per plan, and `pnpm test:pg` from ticket 11 on (this plan adds a Postgres suite). Track execution as `.scratch/27-password-credential/issues/NN-*.md`, one file per ticket in §4.

Vocabulary: **module, interface, implementation, depth, seam, adapter, leverage, locality**. Domain terms come from `spec/glossary.md` (User, Account, Session, Clearance). "Password credential" is added to the glossary by ticket 16: *the `accounts` row with `providerId = "password"` and `subject = userId`, plus its hash*.

---

## 1. Summary, goals, non-goals

### Summary

"The password credential of user X" has no home. Eight sites in three packages each write some prefix of the same sequence by hand:

1. find the account `(PASSWORD_PROVIDER_ID, userId)`;
2. read its hash;
3. verify the candidate, against a boot-time dummy hash when there is none, under a timing floor;
4. check the password policy (minimum length, breach screening);
5. hash, then update the stored hash or link a new account.

Six of the sites are in `packages/password/src/Password.ts` (1,780 lines, the most-churned source file in the repo). The others are `AdminAccounts.setUserPassword` and `awthaq seed admin`. The comments at `Password.ts:1689` and `:1742` say "same uniform-cost shape as …", which is a copy waiting to drift, and it has drifted (§2.4): three password policies, three answers to a store outage, two placements of the KDF relative to the transaction, and two scopes for the timing floor.

This plan makes one deep module, `PasswordCredential` in `@awthaq/password`, exposed to trusted callers under ADR-EA-040. Its interface is small and its implementation holds every rule:

- `verify(claimant, candidate)`: uniform cost, dummy hash and timing floor, answering `Refused` or `Verified` with a branded `Proof`;
- `rehashIfStale(proof)`: BEH-EA-116 on a proof only `verify` can mint;
- `accept(candidate)`: the one policy, minting a branded `Accepted`, the only input a write takes;
- `set` / `replace` (update-or-link / update-only) inside the caller's unit of work, `linkFor` for the sign-up unit, and `has` for the reset mail.

Every caller is migrated onto it. `AdminConfig.passwordPolicy` and the seed's own minimum are deleted, so an administrator-set password obeys `Password.config` (minimum length, breach screening, per-tenant overrides) like every other password. The per-endpoint tests of the floor, the dummy hash, the breach check and the rehash move to the module's interface and are deleted where they were.

### Goals

- **G1. One module owns the credential.** After the plan, `PASSWORD_PROVIDER_ID`, `Accounts.findCredentialHash`, `Accounts.updateCredentialHash` and `hasher.{hash,verify,needsRehash}` on the password credential appear in library source only in `packages/password/src/PasswordCredential.ts` (plus core's own definitions and the operator importers ADR-EA-038 §3 already exempts). A static seam test enforces it (ticket 15).
- **G2. One policy.** Every path that sets a password (sign-up in both modes, reset, change, an administrator's set, `seed admin`) runs `PasswordCredential.accept`, which reads `PasswordConfig` in force for the calling fiber (EP-007). `AdminConfig.passwordPolicy`, `defaultPasswordHints` and `Seed.MIN_PASSWORD_LENGTH` are gone.
- **G3. Order enforced by types.** A write accepts only an `Accepted` (the policy ran); a rehash accepts only a `Proof` (a verify succeeded). Neither brand can be forged without `as`, which the repo forbids.
- **G4. Uniform cost tested once.** The timing floor, the dummy hash and its calibration are tested at `verify`, including the paths no test reaches today (the floor on `changePassword`/`reauthenticate`, and the fact that the dummy hash is actually verified).
- **G5. ADR-EA-028 on the whole credential path.** No `orDie`/`Effect.die` on a credential read or write; a store outage on `change-password`, `reauthenticate`, `confirm-reset`, `setUserPassword` and `seed admin` is `StoreUnavailable` (503 / the CLI's retryable usage error).
- **G6. Writes inside the caller's unit, policy outside it.** No breach-check network call runs inside a transaction (BEH-EA-117); `changePassword`'s hash write, revocation and rotation commit together.
- **G7. Measured shrinkage** (§5.4): `Password.ts` from 1,780 to at most 1,590 lines; `onUnavailable` tested in 2 files instead of 3; zero "same uniform-cost shape" comments; policies from 3 to 1.

### Non-goals

- **No schema or wire change.** The password credential stays an ordinary `accounts` row (BEH-EA-044). Endpoint paths, payloads and error classes are unchanged (`AdminWeakPassword` keeps its shape and status).
- **No change to `PasswordHasher`** (BEH-EA-115, ADR-EA-010): it stays a port the application provides.
- **No change to operator imports.** `UserImport.importUser`, `@awthaq/migrate-auth0`, `-better-auth` and `-firebase` store a *foreign hash*; they set no password and run no policy. Only the provider literal is replaced by the constant (ticket 14).
- **No rate-limit change.** Budgets stay with the endpoints (plan 06); the module never spends one. Admin and the CLI stay unthrottled (plan 06 Q9).
- **No request facts in the module.** It takes no `ip`/`userAgent` (consistent with plan 26 from the start).
- **No new hook point.** `BeforeCredentialReset` stays the caller's veto, run inside the caller's unit before `set`/`replace`.
- **Not moving `AdminAccounts`' gate reads to per-operation config.** `AdminAccounts.ts:169` reads `AdminConfig` once at build, unlike `AdminTenants.ts:189-190` (`Tenant.configInForce`). Noted, out of scope.

---

## 2. Verified current state

### 2.1 Re-measurement commands

```bash
# churn: Password.ts is the most-churned *source* file (71); spec/traceability.md (112) and pnpm-lock.yaml (93) churn more repo-wide
git log --no-merges --format= --name-only | grep -v '^$' | sort | uniq -c | sort -rn | head -4
git log --no-merges --format= --name-only -- 'packages/*/src/*.ts' | sort | uniq -c | sort -rn | head -3

# the open-coded credential sequence (library source)
for p in 'PASSWORD_PROVIDER_ID' '\.findCredentialHash\(' '\.updateCredentialHash\(' \
         '\bhasher\s*\.\s*(verify|hash|needsRehash)\(' 'providerId: "password"'; do
  echo "== $p"; grep -rncE "$p" packages/*/src --include=*.ts | grep -v ':0$'
done

# the uniform-cost machinery and its copies
grep -n 'dummyHash\|withTimingFloor\|verifyPassword(\|same uniform-cost' packages/password/src/Password.ts

# the three policies
grep -rn 'checkPolicy\|passwordPolicy\|defaultPasswordHints\|MIN_PASSWORD_LENGTH' packages/*/src --include=*.ts

# ADR-EA-028 on the credential path (defects where the Shape declares StoreUnavailable)
grep -n 'orDie\|Effect.die' packages/password/src/Password.ts packages/admin/src/AdminAccounts.ts packages/cli/src/Seed.ts

# where the policy, the floor and the rehash are tested today
for p in onUnavailable breachCheck signInTimingFloor needsRehash; do
  echo "$p: $(grep -l "$p" packages/password/test/*.ts | tr '\n' ' ')"
done
wc -l packages/password/src/Password.ts packages/password/test/*.ts
```

### 2.2 Counts (2026-11-08)

| Measure | Count | Where |
|---|---:|---|
| `PASSWORD_PROVIDER_ID` uses in library source | 12 (+1 comment) | `Password.ts` 6 (`:1139, :1221, :1326, :1441, :1682, :1735`), `AdminAccounts.ts` 2 (`:284, :299`), `Seed.ts` 2 (`:131, :139`), `ImportAuth0User.ts` 1 (`:52`), `Accounts.ts` 1 (definition `:28`); `sql/src/Models.ts:272` is a comment |
| `.findCredentialHash(` | 3 | `Password.ts:1228, :1687, :1740` |
| `.updateCredentialHash(` | 4 | `Password.ts:1271, :1456, :1712`; `AdminAccounts.ts:289` |
| `hasher.hash/verify/needsRehash(` | 10 (+2 unrelated) | `Password.ts` 8 (`:979, :1035, :1045, :1133, :1268, :1269, :1454, :1711`), `AdminAccounts.ts:275`, `Seed.ts:135`; `two-factor/src/SecondFactor.ts:306, :391` hash recovery codes, not the password credential |
| Literal `providerId: "password"` | 2 | `BetterAuthSource.ts:196`, `ImportFirebaseUser.ts:219` |
| Password policies | **3** | `Password.ts:604-625` (`checkPolicy`), `Admin.ts:122-131, :167-173, :183` (`AdminConfig.passwordPolicy`), `Seed.ts:41-42, :64-71` (`MIN_PASSWORD_LENGTH`) |
| "same uniform-cost shape" comments | 2 | `Password.ts:1689, :1742` |
| Defects on the credential path | 9 | see §2.5 |
| Files testing `onUnavailable` / `breachCheck` | 3 / 4 | `Password.test.ts`, `PasswordPolicy.test.ts`, `PasswordRecovery.test.ts` (+ `PasswordConfigAudit.test.ts` for `breachCheck`) |
| Timing-floor tests | 2, signIn only | `Password.test.ts:1503-1544`; BDD `15-password.feature:70` (end to end, 250 ms) |
| Tests asserting the dummy hash is verified | **0** | `PasswordNoCredential.test.ts` checks only the error tag |
| Password `src` / `test` lines | 2,195 / 4,163 | `Password.ts` 1,780; `Password.test.ts` 1,650 |

### 2.3 The sites, one by one

`packages/password/src/Password.ts`:

- **Shared machinery, `make` (`:937-1073`).** `verifyPassword` wraps `hasher.verify` in the `awthaq.password.verify` span (`:978-983`). The dummy is `Redacted.make("awthaq/password/dummy")`, hashed once at boot (`:1029-1035`). The floor is calibrated as 1.25 × one timed dummy verify, unless the built config says `"off"` (`:1042-1047`). `timingFloorFor` picks off / Duration / calibrated from the config in force (`:1048-1052`). `withTimingFloor` captures the exit and sleeps to the floor, success and failure alike (`:1059-1073`).
- **`signIn` (`:1207-1288`).** Budget (`:1213`), then **lookup + verify under the floor**: `users.findByEmail` → `findByProviderSubject` → `findCredentialHash` (`AccountNotFound` dies, `:1229`) → `verifyPassword` against the stored hash or `dummyHash` (`:1215-1239`). Uniform refusal (`:1240-1253`). Verified-email gate (`:1263-1266`). **Rehash** if `rehashOnLogin && needsRehash` (`:1268-1273`, `AccountNotFound` dies). Then `SignIn.complete` (ADR-EA-038).
- **`signUp` / `signUpConcealed` via `prepareSignUp` (`:1106-1135`).** Budget, `checkPolicy` (`:1115`), `BeforeSignUp` veto (`:1128`), **then** the hash (`:1133`): "before the (comparatively expensive) password hash is even computed". `passwordLink` builds the `LinkInput` (`:1138-1142`), linked inside `SignUp.createSignedIn`/`create`'s unit (`:1151`, `:1178`). Conceal mode relies on the hash running in both branches (TMS-005, `:1175-1177`).
- **`requestReset` (`:1290-1349`).** Inside the dispatched mail work, `findByProviderSubject(PASSWORD_PROVIDER_ID, user.id)` decides between `reset-password` and `reset-password-unavailable` (ARF-004, `:1325-1332`). **The review missed this site.**
- **`confirmReset` (`:1369-1497`).** `checkPolicy` before the token is touched (ARF-002, `:1383-1390`). Inside `Verification.redeem`'s unit: the `BeforeCredentialReset` veto (`:1419-1438`), find (`:1440-1453`, none → `TokenConsumed`), **the hash inside the transaction** (`:1454`), then `updateCredentialHash(...).pipe(Effect.orDie)` (`:1455-1457`).
- **`changePassword` (`:1675-1728`).** Budget, then find + hash read **outside the floor**, with `orDie` (`:1681-1688`). Verify under the floor (`:1695-1700`), `checkPolicy` (`:1706`), hash (`:1711`), `updateCredentialHash(...).pipe(Effect.orDie)` (`:1712`), event (`:1713`), `revokeOthers` (`:1720`), `issue` (`:1721`). **No unit of work**: four independent commits.
- **`reauthenticate` (`:1730-1763`).** The same find-outside-the-floor shape with `orDie` (`:1734-1741`), verify under the floor (`:1747-1752`), then `Sessions.reauthenticate`.

`packages/admin/src/AdminAccounts.ts` **`setUserPassword` (`:259-321`).** Gate → self-refusal → existence → email identity. Then `adminConfig.passwordPolicy` (`:270-273`; `adminConfig` read once at build, `:169`). Then the hash **before** the transaction, on purpose: "The expensive hash is computed before the transaction opens" (`:274-275`). Inside `sqlTransaction.withTransaction`: veto (`:279-282`), find (`:283-286`), update (`:287-294`) or link (`:295-305`, `AccountAlreadyLinked` dies), `revokeAll(userId, "admin")` (`:308`). The transaction's `SqlError` dies (`:311`). Then `auth.password.changed` and `auth.admin.userPasswordSet`.

`packages/admin/src/Admin.ts`. `AdminConfigShape.passwordPolicy` (`:122-131`) is documented as "`Admin` cannot depend on the password plugin, so this is its own knob; the default is the password plugin's default floor (12 to 1024 characters), and a host that screens against a breach corpus … supplies it here". Default `defaultPasswordHints` (`:167-173`, `:183`). `setUserPassword` itself is not in `Admin.ts`.

`packages/cli/src/Seed.ts` **`seedAdmin` (`:61-185`).** Its own minimum, `MIN_PASSWORD_LENGTH = 12` (`:41-42`, checked at `:64-71`, no breach check, `Password.config` ignored). Then find (`:130-133`). **Only if none**: hash (`:135`) and link (`.pipe(Effect.orDie)`, `:136-143`). An existing credential is kept silently, and the operator's password is dropped.

The operator importers are **not** the sequence. `ImportAuth0User.ts:44-56` maps an Auth0 bcrypt string into `UserImport.importUser`'s `credentials` (`Redacted.make(PasswordHasher.PhcHash(input.passwordHash))`, a TTE-005 trust boundary). `BetterAuthSource.ts:187-196` and `ImportFirebaseUser.ts:213-227` do the same. Core `UserImport.ts:114-150` does a generic find-then-link for any provider. No lookup-and-verify, no policy, no KDF.

### 2.4 Drift matrix

| Site | Lookup | Floor covers | Dummy verify | Policy | KDF placement | Write | Outage on the credential | Unit of work |
|---|---|---|---|---|---|---|---|---|
| `signIn` | email → user → account → hash | lookup + verify | yes | none | (rehash) after the gate, no unit | `updateCredentialHash` | typed; `AccountNotFound` race dies (`:1229, :1272`) | none |
| `changePassword` | account → hash, **outside** the floor | verify only | yes | `checkPolicy` | outside any unit | `updateCredentialHash` | **dies** (`:1687, :1712`) | **none** (4 commits) |
| `reauthenticate` | account → hash, outside the floor | verify only | yes | none | none | none | **dies** (`:1740`) | none |
| `signUp` (both modes) | none | none | none | `checkPolicy`, before the veto | after the veto, **before** the unit | `link` in `SignUp`'s unit | typed (`SignUp`) | `SignUp` |
| `requestReset` | account (dispatched work) | none | none | none | none | none | typed | none |
| `confirmReset` | account, in the unit | none | none | `checkPolicy`, before the token | **inside** the redeem unit | `updateCredentialHash` | **dies** on write (`:1457`) | `redeem` |
| admin `setUserPassword` | account, in the unit | none | none | **`AdminConfig.passwordPolicy`**: length only, build-time, not per tenant | **before** the unit | update or link (link race dies) | **`SqlError` dies** (`:311`) | `SqlTransaction` |
| `seed admin` | account | none | none | **`MIN_PASSWORD_LENGTH`**: length only | before the link | link **only if absent** | **dies** (`:143`) | none (idempotent re-run) |

### 2.5 Evidence corrections

Each item of the review's evidence, checked against the working tree:

1. **"Most-churned file in the repo."** True of *source* files: 71 non-merge commits, ahead of `OAuth.ts` (55) and `Passkey.ts` (53). Repo-wide, `spec/traceability.md` (112) and `pnpm-lock.yaml` (93) churn more.
2. **The five-step sequence** is right, with three omissions. (a) In `signIn`, step 1 starts from an email (`users.findByEmail`), and that lookup is inside the floor. (b) A sixth site, `requestReset`'s ARF-004 presence check (`:1325-1332`), does step 1 alone. (c) There are **three** policies, not two: `seed admin` has its own (`Seed.ts:41-42, :64-71`).
3. **Line references.** Dummy hash `:1029-1035` (calibration and floor `:1042-1073`): correct. signIn verify `:1215-1239`: correct. signUp policy/hash `:1115`/`:1133`: correct. Rehash `:1268-1273`: correct. confirmReset `:1440-1457`: correct, and the hash at `:1454` runs **inside** the transaction while admin deliberately hashes outside (`AdminAccounts.ts:274-275`). changePassword starts at `:1675`, and its lookup (`:1681-1688`) is **outside** the floor, while signIn's is inside. reauthenticate `:1734-1752`: correct. "Same uniform-cost shape": 2 comments (`:1689`, `:1742`).
4. **"`Admin.ts:129,183` (setUserPassword)".** `Admin.ts` holds `AdminConfig.passwordPolicy` (`:122-131`) and its default (`:167-173`, `:183`). `setUserPassword` is `AdminAccounts.ts:259-321`. `AdminAccounts.ts:258-305` is right for the body.
5. **`ImportAuth0User.ts:52` is not an open-coded credential sequence.** It is the provider id inside a `UserImport.ImportCredential` carrying a foreign hash; there is no lookup, verify, policy or KDF. `migrate-better-auth` (`BetterAuthSource.ts:187-196`) and `migrate-firebase` (`ImportFirebaseUser.ts:213-227`) are the same, and use the literal `"password"` instead of the constant. They stay outside the module (ADR-EA-038 §3 exempts operator migrations from `SignUp` for the same reason: they store a credential, they do not create one).
6. **Test coverage is thinner than the code suggests.** The floor is tested on `signIn` only (`Password.test.ts:1503-1544`); BEH-EA-114 claims `changePassword` and `reauthenticate` "hold their verify to the same floor" and nothing tests it. No test asserts that the dummy hash is verified at all: `PasswordNoCredential.test.ts:27-56` checks the error tag only.
7. **New: ADR-EA-028 violations on the credential path (live).** The Shapes declare `Errors.StoreUnavailable`, but:
   - `Password.ts:1687` and `:1740`: `findCredentialHash(...).pipe(Effect.orDie)` in `changePassword` and `reauthenticate`;
   - `:1712` and `:1457`: `updateCredentialHash(...).pipe(Effect.orDie)` in `changePassword` and `confirmReset`. A store outage there is a `500` defect, not a `503`.
   - `AdminAccounts.ts:311`: `catchTag("SqlError", Effect.die)` on the transaction; `SignUp.ts:214` and `UserImport.ts:150` map the same error to `StoreUnavailable`.
   - `Seed.ts:143`: `link(...).pipe(Effect.orDie)` escapes the command's own `StoreUnavailable` → `UsageError` mapping (`:177`).
   - Also `Password.ts:1229, :1272` and `AdminAccounts.ts:304`: a concurrent unlink or link between a read and a write dies. That is a race, not an invariant this code broke (ADR-EA-028 §3).
8. **New: `changePassword` is not one unit (live).** Hash write (`:1712`), `auth.password.changed` (`:1713`), `revokeOthers` (`:1720`) and `issue` (`:1721`) are four commits. A crash after `:1712` leaves every other session alive under the new password: the "attacker holds a hijacked session through a password change" gap that the method's own doc (`:499-508`) says it closes, and the ARF-001 class `confirmReset` closed.
9. **New: `seed admin` silently keeps an existing password (live, minor).** `Seed.ts:130-145` links only when none exists. For a promoted user who already has a password, the operator's password is dropped while the command reports success. That contradicts BEH-EA-206's implementation note ("so a seeded administrator can sign in with the password the operator set").
10. **New: spec drift.** BEH-EA-221's prose (`27-admin-impersonation.md:352`) says `setUserPassword` "does not yet consult `Hooks.BeforeCredentialReset`". It does (`AdminAccounts.ts:279-282`, tested at `AdminAccounts.test.ts:473-503`). `AdminAccounts.ts:3` and `AdminAccounts.test.ts:1` cite "BEH-EA-225", which is the CLI exit-code behaviour (`26-cli.md:256`). `MAX_PASSWORD_LENGTH = 1024` is declared twice (`AdminAccountsApi.ts:62-63`, `PasswordApi.ts:125`).

### 2.6 Verdict: the admin path skipping breach screening is a live defect

**It is specified, so it is not a BEH-EA-221 violation.** BEH-EA-221 says `setUserPassword` "checks the password against `AdminConfig.passwordPolicy`", and `Admin.ts:122-128` documents the length-only default.

**It is a live security-posture defect**, for four reasons:

- **The rationale is a dependency workaround, and it is obsolete.** The doc says "`Admin` cannot depend on the password plugin, so this is its own knob". ADR-EA-040 (2026-10-13) removed that constraint, and `@awthaq/admin` already depends on a feature plugin for exactly this reason: `AdminTenants dependsOn: [Organization]` (`AdminTenants.ts:182`, `packages/admin/package.json`).
- **It contradicts the other normative text.** BEH-EA-119 and PHS-006 make screening "on by default", citing NIST SP 800-63B §3.1.1.2, which applies when a memorized secret is *established or changed*, whoever types it. BEH-EA-120 makes the policy "`Password`'s `Context.Reference` configuration". A host that sets `Password.config({ minLength: 16 })` still has 12-character admin-set passwords accepted.
- **It is not tenant-aware.** `AdminConfig` is read once at build (`AdminAccounts.ts:169`); the password policy is decided per operation (EP-007, `Password.ts:945-951`).
- **The CLI repeats it.** `seed admin`, the most privileged password in a deployment, gets a third, weaker policy.

**Impact.** A gated administrator (`canManageCredentials`) can set a breached or short password, such as `Password123!`, for any user, and that user signs in with it. **Fix:** one policy (G2), via the module (§3). Recommended default for the remaining choice (keep an admin-only *extra* restriction or not): remove it (§10 Q2).

---

## 3. Target design

### 3.1 Placement: `@awthaq/password`, exposed under ADR-EA-040 (not core)

| Criterion | Core module (`make`, like `SignIn`) | `@awthaq/password`, exposed (chosen) |
|---|---|---|
| Who verifies | only the password plugin (3 operations) | same, so locality is in the plugin |
| Who sets | password plugin, `AdminAccounts`, the CLI | same: two trusted callers reach it through `dependsOn` / the app context |
| The policy | must move out of `PasswordConfig` into a core reference, contradicting BEH-EA-120 ("MUST be `Password`'s `Context.Reference` configuration"), or `Password.config` must write two references | stays `PasswordConfig`, per tenant (EP-007), exactly as BEH-EA-119/120 specify |
| The breach check | core (the domain stratum) would make its first outbound HTTP call (HIBP) and require `HttpClient`; or screening becomes a port and `breachCheck` stops being config (breaking BEH-EA-119/120 and `password({ breachCheck })`) | stays where it is; `HttpClient` is already in `Password.layer`'s requirements |
| The timing floor | calibrated per `make` (once per plugin that resolves it) | calibrated once, beneath `Password`'s `make` |
| ADR-EA-010 | fine | fine: `PasswordHasher` stays a port the application provides; an exposed module is not a port (its key is `awthaq/plugin/password/Credential`, not `awthaq/ports/...`; ADR-EA-040 §4) |
| ADR-EA-038's reason for core | eight flows needed `SignIn` | does not apply: one plugin verifies, and the two outside setters are trusted callers, ADR-EA-040's stated use case |
| Cost | none for admin | `AdminAccounts` must list `Password` in `dependsOn` (§10 Q1) |

**Decision (ADR-EA-048): `@awthaq/password` owns `PasswordCredential` and exposes it.** `AdminAccounts` declares `dependsOn: [Password]`, as `AdminTenants` does for `Organization`. The CLI reads it from the application context (`requireService`), as it already reads `Roles`.

### 3.2 The interface (`packages/password/src/PasswordCredential.ts`)

```ts
// @awthaq/password — PasswordCredential (ADR-EA-048, BEH-EA-345)
//
// The password credential of a user is the `accounts` row (`providerId = "password"`, `subject =
// userId`, no issuer, BEH-EA-044) and its hash. This module is the only code that reads or writes it
// or runs the `PasswordHasher` on it. Exposed by `Password.layer` (ADR-EA-040); trusted callers
// (`AdminAccounts`, `awthaq seed admin`) reach it through `dependsOn` or the application context.

import { Accounts, Errors, Observability, type SignUp, Tenant, type Users } from "@awthaq/core";
import { PasswordHasher } from "@awthaq/ports";
import * as Brand from "effect/Brand";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as PasswordApi from "./PasswordApi.ts";
import { PasswordConfig, type PasswordConfigShape } from "./PasswordConfig.ts";

/** A candidate the one policy accepted (BEH-EA-119/120). Only `accept` mints one; every write takes nothing else. */
export type Accepted = { readonly candidate: Redacted.Redacted<string> } & Brand.Brand<"awthaq/password/Accepted">;
const accepted = Brand.nominal<Accepted>();

/** What a successful `verify` proved. Only `verify` mints one, so a rehash cannot target an unproven credential. */
export type Proof = {
  readonly accountId: Accounts.AccountId;
  readonly hash: PasswordHasher.PhcHash;
  readonly candidate: Redacted.Redacted<string>;
} & Brand.Brand<"awthaq/password/Proof">;
const proof = Brand.nominal<Proof>();

/** One answer for "no such user", "no password credential" and "wrong password" (BEH-EA-114). */
export type Verdict<U> =
  | { readonly _tag: "Refused" }
  | { readonly _tag: "Verified"; readonly claimant: U; readonly proof: Proof };

export interface PasswordCredentialShape {
  /**
   * BEH-EA-114/TSS-006: resolves the claimant, reads its password credential, and runs exactly one
   * real verify (against the boot-time dummy hash when there is no credential), with the whole
   * effect, success or failure, held to the timing floor in force. Never says which refusal applied.
   */
  readonly verify: <U extends { readonly id: Users.UserId }, E>(
    claimant: Effect.Effect<Option.Option<U>, E>,
    candidate: Redacted.Redacted<string>,
  ) => Effect.Effect<Verdict<U>, E | Errors.StoreUnavailable>;
  /** BEH-EA-116: rewrites the proven credential when its hash is below the hasher's target and `rehashOnLogin` holds. */
  readonly rehashIfStale: (proven: Proof) => Effect.Effect<void, Errors.StoreUnavailable>;
  /** BEH-EA-119/120: the one policy (minimum length, breach screening) in force for the calling fiber. Never inside a unit. */
  readonly accept: (
    candidate: Redacted.Redacted<string>,
  ) => Effect.Effect<Accepted, PasswordApi.WeakPassword>;
  /** The sign-up unit's credential: hashes now (before the unit, TMS-005), links inside it. */
  readonly linkFor: (password: Accepted) => Effect.Effect<(user: Users.UserRecord) => SignUp.LinkInput>;
  /** Replaces the user's password credential, or links one if there is none. Runs inside the caller's unit. */
  readonly set: (userId: Users.UserId, password: Accepted) => Effect.Effect<void, Errors.StoreUnavailable>;
  /** Replaces the user's password credential; `false` (and no hash computed) when there is none. Inside the caller's unit. */
  readonly replace: (
    userId: Users.UserId,
    password: Accepted,
  ) => Effect.Effect<boolean, Errors.StoreUnavailable>;
  /** Whether the user has a password credential (ARF-004: which reset mail to send). */
  readonly has: (userId: Users.UserId) => Effect.Effect<boolean, Errors.StoreUnavailable>;
}

export class PasswordCredential extends Context.Service<PasswordCredential, PasswordCredentialShape>()(
  "awthaq/plugin/password/Credential",
) {
  static readonly layer = Layer.effect(PasswordCredential, make); // `make`: §3.3
}
```

**Why seven members, when the brief named three** (verify, set, rehash-if-stale). Each split is a constraint already in the spec, not a convenience:

| Member | Callers | Why it cannot merge into a neighbour |
|---|---|---|
| `verify` | signIn, changePassword, reauthenticate | as briefed; the claimant is an effect so `signIn`'s email lookup stays inside the floor (TSS-006) |
| `rehashIfStale` | signIn | as briefed; it must bypass the policy (a stale hash of a now-breached or now-short password is still upgraded, BEH-EA-116). It runs after the verified-email gate, as today (`:1263-1273`) |
| `accept` | all six setters | a "policy-checked `set` inside the caller's unit" would run the breach check's network call inside a transaction, which BEH-EA-117 and ARF-002 forbid; so the policy is its own step, before the unit, and its brand carries the result into the write |
| `linkFor` | signUp (both modes) | `SignUp.CreateOptions.link` is synchronous and runs inside the unit; the KDF must run before the unit, in both conceal branches (TMS-005, ADR-EA-026: equal work whether or not the address exists) |
| `set` | admin, seed | update-or-link |
| `replace` | confirmReset, changePassword | must **not** link: a reset token for a credential-less account is `TokenConsumed` (ARF-004, BEH-EA-117) |
| `has` | requestReset | ARF-004's mail choice, inside the dispatched work |

**Where the KDF runs** follows from the interface. `linkFor` hashes before the sign-up unit (enumeration). `set`/`replace` hash inside the caller's unit, once a write is certain, so `confirmReset` keeps today's placement: a well-formed but unknown reset token costs no KDF. Hashing before `redeem` would let any caller burn an argon2 slot per request with fresh token ids, since `confirmReset`'s only budget is per token id. The one regression is admin's KDF moving inside its transaction (§7 R3, §10 Q6).

### 3.3 Behind the seam (the implementation, sketch)

```ts
interface Stored {
  readonly accountId: Accounts.AccountId;
  readonly hash: PasswordHasher.PhcHash;
}

const refused: Verdict<never> = { _tag: "Refused" };
const verified = <U>(claimant: U, proven: Proof): Verdict<U> => ({ _tag: "Verified", claimant, proof: proven });

const make = Effect.gen(function* () {
  const accounts = yield* Accounts.Accounts;
  const hasher = yield* PasswordHasher.PasswordHasher;
  const httpClient = yield* HttpClient.HttpClient;
  const digest = yield* Digest.Digest;
  // EP-007: decided per operation; boot-scoped only for the calibration below.
  const builtConfig = yield* PasswordConfig;
  const configNow = Tenant.configInForce(PasswordConfig, builtConfig);

  // EOTS-001: the hash check is its own span; no attribute is derived from the password or hash.
  const verifyHash = (candidate: Redacted.Redacted<string>, hash: PasswordHasher.PhcHash) =>
    hasher.verify(candidate, hash).pipe(
      Observability.authSpan(Observability.Span.passwordVerify, { [Observability.Field.strategy]: "password" }),
    );

  // BEH-EA-114: paid once at boot (moved verbatim from Password.ts:1029-1035).
  const dummyPassword = Redacted.make("awthaq/password/dummy");
  const dummyHash = yield* hasher.hash(dummyPassword);
  // TSS-006 (moved from :1042-1052): 1.25 × one steady-state dummy verify, unless the built value is "off".
  const calibratedFloorMillis = yield* Effect.gen(function* () {
    if (builtConfig.signInTimingFloor === "off") return 0;
    const start = DateTime.toEpochMillis(yield* DateTime.now);
    yield* hasher.verify(dummyPassword, dummyHash);
    return 1.25 * (DateTime.toEpochMillis(yield* DateTime.now) - start);
  });
  const floorMillis = (floor: PasswordConfigShape["signInTimingFloor"]) =>
    floor === "off" ? 0 : Duration.isDuration(floor) ? Duration.toMillis(floor) : calibratedFloorMillis;
  /** TSS-006 (moved from :1059-1073): the exit, success or failure, is held back until the floor in force. */
  const withTimingFloor = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(configNow, (config) => {
      const floor = floorMillis(config.signInTimingFloor);
      return floor <= 0
        ? effect
        : Effect.gen(function* () {
            const start = DateTime.toEpochMillis(yield* DateTime.now);
            const exit = yield* Effect.exit(effect);
            const elapsed = DateTime.toEpochMillis(yield* DateTime.now) - start;
            if (elapsed < floor) yield* Effect.sleep(Duration.millis(floor - elapsed));
            return yield* exit;
          });
    });

  /** The password account and its hash. An account unlinked between the two reads is no credential: a race, not a defect. */
  const stored = (userId: Users.UserId) =>
    Effect.gen(function* () {
      const account = yield* accounts.findByProviderSubject(Accounts.PASSWORD_PROVIDER_ID, userId);
      if (Option.isNone(account)) return Option.none<Stored>();
      const hash = yield* accounts
        .findCredentialHash(account.value.id)
        .pipe(Effect.catchTag("AccountNotFound", () => Effect.succeedNone));
      return Option.map(hash, (value) => ({ accountId: account.value.id, hash: Redacted.value(value) }));
    });

  const verify: PasswordCredentialShape["verify"] = (claimant, candidate) =>
    withTimingFloor(
      Effect.gen(function* () {
        const found = yield* claimant;
        const credential = Option.isSome(found) ? yield* stored(found.value.id) : Option.none<Stored>();
        // BEH-EA-114: one real verify on every attempt.
        const matched = yield* verifyHash(
          candidate,
          Option.match(credential, { onNone: () => dummyHash, onSome: (c) => c.hash }),
        );
        return matched && Option.isSome(found) && Option.isSome(credential)
          ? verified(found.value, proof({ ...credential.value, candidate }))
          : refused;
      }),
    );

  const rehashIfStale: PasswordCredentialShape["rehashIfStale"] = Effect.fnUntraced(function* (proven) {
    const config = yield* configNow;
    if (!config.rehashOnLogin || !hasher.needsRehash(proven.hash)) return;
    const rehashed = yield* hasher.hash(proven.candidate);
    yield* accounts
      .updateCredentialHash(proven.accountId, Redacted.make(rehashed))
      // Unlinked since the proof: nothing left to upgrade.
      .pipe(Effect.catchTag("AccountNotFound", () => Effect.void));
  });

  const accept: PasswordCredentialShape["accept"] = Effect.fnUntraced(function* (candidate) {
    const config = yield* configNow;
    const hints = yield* policyHints(httpClient, digest, candidate, config); // checkPolicy + isBreached, moved verbatim (:547-625)
    if (hints.length > 0) return yield* new PasswordApi.WeakPassword({ hints });
    return accepted({ candidate });
  });

  const linkFor: PasswordCredentialShape["linkFor"] = (password) =>
    Effect.map(hasher.hash(password.candidate), (hash) => (user: Users.UserRecord) =>
      ({
        providerId: Accounts.PASSWORD_PROVIDER_ID,
        subject: user.id,
        credentialHash: Redacted.make(hash),
      }) satisfies SignUp.LinkInput,
    );

  /**
   * Find, then update (or, when `link`, link). The KDF runs at most once, and only once a write is
   * certain. A concurrent link or unlink of this account between the read and the write is re-read
   * (the `AccountStore` SQL adapter's `insertIfAbsent` is `ON CONFLICT DO NOTHING`, so a lost race
   * never aborts the caller's Postgres transaction); three lost races are contention, reported as
   * `StoreUnavailable` (the plan 02 `casIdentity` precedent).
   */
  const write = (userId: Users.UserId, password: Accepted, ifAbsent: "link" | "refuse") =>
    Effect.gen(function* () {
      const hashed = yield* Effect.cached(Effect.map(hasher.hash(password.candidate), Redacted.make));
      for (let attempt = 1; attempt <= 3; attempt++) {
        const account = yield* accounts.findByProviderSubject(Accounts.PASSWORD_PROVIDER_ID, userId);
        if (Option.isNone(account) && ifAbsent === "refuse") return false;
        const written = yield* Option.match(account, {
          onSome: (found) =>
            hashed.pipe(
              Effect.flatMap((hash) => accounts.updateCredentialHash(found.id, hash)),
              Effect.as(true),
              Effect.catchTag("AccountNotFound", () => Effect.succeed(false)),
            ),
          onNone: () =>
            hashed.pipe(
              Effect.flatMap((hash) =>
                accounts.link({ userId, providerId: Accounts.PASSWORD_PROVIDER_ID, subject: userId, credentialHash: hash }),
              ),
              Effect.as(true),
              Effect.catchTag("AccountAlreadyLinked", () => Effect.succeed(false)),
            ),
        });
        if (written) return true;
      }
      return yield* new Errors.StoreUnavailable({ operation: "PasswordCredential.write" });
    });

  const set: PasswordCredentialShape["set"] = (userId, password) => Effect.asVoid(write(userId, password, "link"));
  const replace: PasswordCredentialShape["replace"] = (userId, password) => write(userId, password, "refuse");
  const has: PasswordCredentialShape["has"] = (userId) =>
    Effect.map(accounts.findByProviderSubject(Accounts.PASSWORD_PROVIDER_ID, userId), Option.isSome);

  return PasswordCredential.of({ verify, rehashIfStale, accept, linkFor, set, replace, has });
});
```

What sits behind the seam, and is therefore no caller's business:

- the dummy hash, its warm-up and the calibration;
- the floor's three modes and its per-tenant choice;
- the account key convention (`PASSWORD_PROVIDER_ID`, `subject = userId`, no issuer);
- the HIBP k-anonymity check: SHA-1 prefix only, the range-line grammar, `filterStatusOk`, the timeout, `onUnavailable` (PHS-004, CSD-001);
- where the KDF runs relative to the unit;
- races mapped to answers instead of defects, and the verify span.

Typing notes for the spike (ticket 02):

- `const verify: PasswordCredentialShape["verify"] = (claimant, candidate) => …` relies on contextual typing by a generic signature (the arrow becomes generic in `U`, `E`). If inference fails, write `verify` as a generic `function` declaration; no assertion is needed either way.
- `refused` and `verified` carry type annotations because they are plain values and functions (allowed); they keep `_tag` literal without `as const`.
- `Brand.nominal` over an object intersection is the `SignUp.Vetted` precedent (`SignUp.ts:60-61`).

### 3.4 `PasswordConfig` moves to its own file (no cycle)

`PasswordCredential.ts` needs `PasswordConfig`, and `Password.ts` needs `PasswordCredential`. If the config stayed in `Password.ts` the two would import each other and `pnpm circular` would fail. `PasswordConfigShape`, `defaultPasswordConfig`, `PasswordConfig` and `config` (`Password.ts:60-144, :311-334`) move verbatim to `packages/password/src/PasswordConfig.ts`. `Password.ts` re-exports them (`export { PasswordConfig, config } from "./PasswordConfig.ts"; export type { PasswordConfigShape } from "./PasswordConfig.ts";`), so `Password.config(...)`, `Password.PasswordConfig` and `Password.PasswordConfigShape` keep working for every caller and test. The `ConfigDescriptor.make(PasswordConfig, …)` audit (`:887-919`) stays on the class.

### 3.5 The callers after the move

**`Password.layer`** exposes the module and resolves it in `make`:

```ts
static readonly layer = AuthPlugin.layer(Password, {
  ports: [ClientAddress.ClientAddress, Mailer.Mailer, PasswordHasher.PasswordHasher, RateLimiter.RateLimiter, SqlTransaction.SqlTransaction],
  // ADR-EA-040/043: the password credential, built once beneath `make`, for this plugin and its trusted dependents.
  exposes: { services: [PasswordCredential.PasswordCredential], layer: PasswordCredential.PasswordCredential.layer },
  handlers: Layer.mergeAll(PasswordHandlers, PasswordAccountHandlers),
  make: Effect.gen(function* () {
    const credential = yield* PasswordCredential.PasswordCredential;
    const sqlTransaction = yield* SqlTransaction.SqlTransaction;
    // … `hasher`, `digest`, `httpClient`, `dummyHash`, the floor and `checkPolicy` are gone from here
  }),
});
```

`PasswordHasher` stays in `ports`: the exposed layer requires it, and it joins `Password.layer`'s `RIn` through `exposes.layer` (`AuthPlugin.ts:866`). ADR-EA-040's caveat (an inline `Layer.succeed` as the sole `exposes.layer` does not infer) does not apply: `PasswordCredential.layer` is a bound static.

**`signIn`** (`:1207-1288`):

```ts
yield* limits.spend(["signInByIp", "signIn"], input);
// BEH-EA-114/TSS-006: lookup plus verify, one answer, held to the floor.
const verdict = yield* credential.verify(users.findByEmail(input.email), input.password);
if (verdict._tag === "Refused") {
  yield* publishSignInFailed("invalidCredentials", input);
  return yield* new Api.InvalidCredentials();
}
const user = verdict.claimant;
yield* Effect.annotateCurrentSpan("user.id", user.id);
if (config.requireVerifiedEmail && !Users.isEmailVerified(user)) { /* unchanged */ }
yield* credential.rehashIfStale(verdict.proof);
return yield* completion.complete(/* unchanged */);
```

**`changePassword`** (one unit, G6):

```ts
yield* limits.spend("changePassword", input);
const verdict = yield* credential.verify(Effect.succeedSome({ id: input.userId }), input.currentPassword);
if (verdict._tag === "Refused") return yield* new PasswordApi.WrongPassword();
const password = yield* credential.accept(input.newPassword);     // outside the unit: no network call inside it
return yield* sqlTransaction
  .withTransaction(
    Effect.gen(function* () {
      // The credential the caller just proved is gone (a concurrent unlink): nothing changes.
      if (!(yield* credential.replace(input.userId, password))) return yield* new PasswordApi.WrongPassword();
      yield* events.publish({ _tag: "auth.password.changed", userId: input.userId }); // released on commit (ADR-EA-037)
      yield* sessions.revokeOthers(input.userId, input.currentSessionId, "passwordChanged");
      return yield* sessions.issue({ userId: input.userId, supersedes: input.currentSessionId, request: sessionRequest(input), amr: ["pwd"] });
    }),
  )
  .pipe(Effect.catchIf(isSqlError, Errors.storeUnavailable("Password.changePassword")));
```

**`reauthenticate`**: `verify` with `Effect.succeedSome({ id: input.userId })`, `Refused` → `WrongPassword`, then `Sessions.reauthenticate` as today.

**`signUp` / `signUpConcealed`**: `prepareSignUp` keeps today's order (budget → policy → veto → KDF):

```ts
yield* limits.spend(["signUpByIp", "signUp"], input);
const password = yield* credential.accept(input.password);
const vetted = yield* creation.vet({ identity: { _tag: "Email", email: input.email }, name, strategy: "password" });
const link = yield* credential.linkFor(password); // the KDF: after the veto, before the unit, in both conceal branches
return { vetted, link };
// signUp:          creation.createSignedIn(vetted, { link, amr: ["pwd"] }, sessionRequest(input))
// signUpConcealed: creation.create(vetted, { link })
```

`passwordLink` (`:1137-1142`) is deleted.

**`confirmReset`**: `const password = yield* credential.accept(input.password)` replaces `checkPolicy` at `:1387` (still before the token is touched). Inside `use`, after the veto, `if (!(yield* credential.replace(userId, password))) return yield* new PasswordApi.TokenConsumed();` replaces `:1440-1457` (ARF-004 unchanged; the `orDie` is gone).

**`requestReset`**: `if (!(yield* credential.has(user.id))) { mail "reset-password-unavailable"; return; }` replaces `:1325-1332`.

**`AdminAccounts.setUserPassword`** (`dependsOn: [Password]`, `ports: [Mailer, SqlTransaction]`, no `PasswordHasher`):

```ts
yield* authorize(caller, "setUserPassword", userId, "canManageCredentials");
if (caller.ref.id === userId) return yield* new AdminAccountsApi.AdminSelfActionRefused();
const user = yield* existing(userId);
if (Option.isNone(Users.emailOf(user))) return yield* new AdminAccountsApi.AdminNoEmailIdentity();
// BEH-EA-120 (ADR-EA-048): Password's policy in force for this request's tenant, breach screening included.
const password = yield* credential
  .accept(input.password)
  .pipe(Effect.catchTag("WeakPassword", (weak) => new AdminAccountsApi.AdminWeakPassword({ hints: weak.hints })));
yield* sqlTransaction
  .withTransaction(
    Effect.gen(function* () {
      yield* HookPoint.aborted(Hooks.BeforeCredentialReset)(beforeCredentialReset.run({ userId }));
      yield* credential.set(userId, password);
      yield* sessions.revokeAll(userId, "admin");
    }),
  )
  .pipe(Effect.catchIf(isSqlError, Errors.storeUnavailable("AdminAccounts.setUserPassword")));
// events unchanged
```

**`seed admin`**:

```ts
// First, before anything is written (as today's length check): the one policy, from the application's Password plugin.
const password = Option.isSome(input.password)
  ? Option.some(
      yield* (yield* requireService(context, PasswordCredential.PasswordCredential, "PasswordCredential (the Password plugin)", "seed admin"))
        .accept(input.password.value)
        .pipe(Effect.catchTag("WeakPassword", (weak) => new UsageError({ message: `the seeded password is refused: ${weak.hints.join("; ")}` }))),
    )
  : Option.none();
// … create or promote, verifyEmail …
if (Option.isSome(password)) {
  yield* credential.set(user.id, password.value); // §10 Q3: replace an existing credential instead of silently keeping it
  yield* events.publish({ _tag: "auth.password.changed", userId: user.id }); // as AdminAccounts does
}
```

The `Effect.orDie` at `Seed.ts:143` is gone, so an outage reaches the existing `StoreUnavailable` → `UsageError` mapping (`:177`). The sketch shows the order; the executor binds `credential` once.

### 3.6 Type-system invariants

| Invariant | Enforced by |
|---|---|
| No password credential is written without the policy | `set`/`replace`/`linkFor` take only `Accepted`, which only `accept` mints (`Brand.nominal`, constructor not exported) |
| No rehash without a successful verify | `rehashIfStale` takes only `Proof` |
| `AdminAccounts` cannot compose without `Password` | it requires `awthaq/plugin/password/Credential`; `Validate<P>`'s `ExposerNotDependedOn`/`MissingDep` (BEH-EA-329) refuses a tuple without `Password` before it |
| `AdminAccounts` cannot hash a password itself | `PasswordHasher` is removed from its `ports` (`PortsComplete` rejects a port it lists but does not require, and vice versa); the seam test (ticket 15) catches a re-added `hasher.` |
| The rest of the discipline | `packages/password/test/PasswordCredentialSeams.test.ts` (ticket 15), counted allowlist in the `SignInSeams.test.ts` style |

---

## 4. Phased migration

Every phase is one mergeable PR, green on the phase gate `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`. Add `pnpm test:bdd` when a feature file or world changes, `pnpm workspace:check` when a `package.json` dependency changes, `pnpm spec:verify:strict` when spec files change, and `pnpm test:pg` from ticket 11 on. The plan's final gate is `pnpm check` plus `pnpm test:pg`. Line numbers are as of `ede063d8`; re-locate by symbol before editing.

### Phase 0: preconditions, baseline, spikes, red tests (tickets 01-04)

#### 01 — Baseline

- **Files:** `.scratch/27-password-credential/baseline.md` (new).
- **Change:** run §2.1 and record every count. Also record: `pnpm vitest run --project @awthaq/password` test count and wall time, `@awthaq/admin` and `@awthaq/cli` likewise; `wc -l packages/password/src/Password.ts` (1,780); the number of `it(`/`it.effect(` per file in `packages/password/test`. Record whether plan 26 has landed (it changes the `PasswordShape` inputs this plan's sketches show with `ip`/`userAgent`).
- **Done when:** `baseline.md` holds every §2.2 number, re-measured.
- **Gate:** none (no code change).

#### 02 — Spike: exposure and brand typing

- **Files:** `packages/password/test/PasswordCredential.types.test.ts` (new; the `*.types.test.ts` convention of `packages/two-factor/test/TwoFactor.types.test.ts`); a throwaway `PasswordCredential.ts` skeleton (interface + `Layer.succeed` stub) on the spike branch only.
- **Change:** prove, before any caller moves:
  1. `AuthPlugin.layer(Password, { exposes: { services: [PasswordCredential], layer } })` compiles **without `as const`** (`Organization` uses `as const` at `OrganizationSystem.ts:31`; this plan may not). `ExposesComplete` reads `Exposed[number]["key"]` (`AuthPlugin.ts:624`), which a one-element array type satisfies.
  2. `Auth.make([Admin, AdminAccounts])` with `AdminAccounts` requiring the tag and `dependsOn: [Password]` fails `Validate` (`// @ts-expect-error`), and `Auth.make([Admin, Password, AdminAccounts])` compiles.
  3. `Accepted` and `Proof` cannot be built from object literals (`// @ts-expect-error`); `set(userId, Redacted.make("x"))` is an error.
  4. The generic `verify` property accepts `users.findByEmail(email)` (`U = UserRecord`, `E = StoreUnavailable`) and `Effect.succeedSome({ id })`.
  5. `TestAuth.layer(Auth.make([Password]))` provides `PasswordCredential` to a test (`yield*` it).
- **Done when:** the five properties hold under `tsc -p tsconfig.test.json`. Any fallback taken (e.g. `verify` as a `function` declaration) is recorded in the ticket.
- **Gate:** per-phase gate.

#### 03 — Red tests for the confirmed defects

- **Files:** `packages/password/test/PasswordStoreOutage.test.ts`, `packages/admin/test/AdminAccounts.test.ts`, `packages/cli/test/Seed.test.ts`.
- **Change:** write, and see fail:
  - ADR-EA-028: with `accountsDownWhen` (`PasswordStoreOutage.test.ts:12-25`) extended to `updateCredentialHash`: "changePassword during a credential-store outage is StoreUnavailable", "reauthenticate …", "confirmReset during a credential-write outage is StoreUnavailable and the token is not spent". Today all three die.
  - Admin: "setUserPassword whose transaction fails with a SqlError is StoreUnavailable" (a `SqlTransaction` double whose `withTransaction` fails `SqlError`). Today it dies.
  - The policy defect: "an administrator-set password that appears in a breach corpus is refused with AdminWeakPassword ['appears in known breaches']" and "an administrator-set password shorter than Password.config's minLength (16) is refused". Today both pass the length-12 default.
  - Seed: "seed admin with a password over an account that already has one replaces it" (§10 Q3 default) and "a seeded password that appears in a breach corpus is a usage error (exit 2)".
- **Done when:** each test fails for the stated reason (record the failure in the ticket). They are committed with the ticket that turns them green (04, 12, 13), not alone.
- **Gate:** none (red by design).

#### 04 — Hotfix: ADR-EA-028 on the credential path, in place (independent, Wave 0)

- **Files:** `packages/password/src/Password.ts`, `packages/admin/src/AdminAccounts.ts`, `packages/cli/src/Seed.ts`, `.changeset/credential-store-outage.md` (C1).
- **Change:** no seam yet.
  - `Password.ts:1687, :1740`: `.pipe(Effect.orDie)` → `.pipe(Effect.catchTag("AccountNotFound", () => Effect.succeedNone))`.
  - `:1712, :1457`: `.pipe(Effect.orDie)` → `catchTag("AccountNotFound", …)` answering `WrongPassword` / `TokenConsumed`.
  - `AdminAccounts.ts:311`: `catchTag("SqlError", Effect.die)` → `Effect.catchIf(isSqlError, Errors.storeUnavailable("AdminAccounts.setUserPassword"))`.
  - `Seed.ts:143`: `.pipe(Effect.orDie)` → `Effect.catchTag("AccountAlreadyLinked", () => Effect.void)`, so a concurrent seed already linked one and `StoreUnavailable` flows to `:177`.
  - The four ADR-EA-028 tests from ticket 03 go green.
- **Done when:** `grep -c 'orDie' packages/password/src/Password.ts` is 1 (the identifier digest at `:972`, out of scope); the four tests pass.
- **Gate:** per-phase gate. If tickets 06-12 land in the same release, this ticket may be folded into them (the module carries the same behaviour); keep the tests either way.

### Phase 1: tracer, the module proves one sign-in end to end (tickets 05-07)

#### 05 — Extract `PasswordConfig.ts`

- **Files:** `packages/password/src/PasswordConfig.ts` (new), `packages/password/src/Password.ts`.
- **Change:** move `PasswordConfigShape` (`:60-144`), `defaultPasswordConfig` (`:311-324`), `PasswordConfig` (`:326-330`) and `config` (`:332-334`) verbatim; re-export from `Password.ts` (§3.4). No behaviour change.
- **Done when:** no file outside `packages/password/src` changes; `pnpm circular` passes; `grep -n 'export interface PasswordConfigShape' packages/password/src/*.ts` names only `PasswordConfig.ts`.
- **Gate:** per-phase gate.

#### 06 — `PasswordCredential` with `verify` and `rehashIfStale`, exposed; `signIn` through it (tracer)

- **Files:** `packages/password/src/PasswordCredential.ts` (new), `packages/password/src/Password.ts`, `packages/password/src/index.ts` (`export * as PasswordCredential from "./PasswordCredential.ts"`), `packages/password/test/PasswordCredential.test.ts` (new), `packages/password/test/PasswordCredential.types.test.ts` (from 02), `packages/password/test/Password.test.ts`.
- **Change:**
  1. The module with `verify` and `rehashIfStale` and the machinery behind them (§3.3), moved verbatim from `:974-983` and `:1029-1073`. The other five members land in tickets 08, 09 and 11.
  2. `Password.layer` gains `exposes` (§3.5).
  3. `signIn` uses `verify` and `rehashIfStale` (§3.5). `verifyPassword`, `dummyPassword`, `dummyHash`, `calibratedFloorMillis`, `timingFloorFor` and `withTimingFloor` stay in `Password.ts` only as long as `changePassword`/`reauthenticate` use them (deleted in 07).
  4. Tests: move "a sign-in completes no sooner than the floor, even when verify is instant" and "signInTimingFloor: off restores the unpadded behaviour" (`Password.test.ts:1503-1544`) to `PasswordCredential.test.ts` as verify cases F1 and F4 (§5.1), and **delete** them from `Password.test.ts`. Move "BEH-EA-116: signIn against a hash stored under outdated parameters rehashes to current parameters" (`:229`) and "BEH-EA-116/PHS-002: … stronger … does not rehash it" (`:266`) to rehash cases R1/R2, and delete them there. Add V1-V7, F2, F3, F5, R3, R4.
- **Done when:** the signIn BEH-EA-114 uniform test (`Password.test.ts:361`), the erased-user test (`:1606`), `PasswordStoreOutage`'s signIn case and the BDD scenario "Response latency does not vary across the three failure reasons" (`15-password.feature:70`) pass unchanged. `grep -n 'findCredentialHash\|needsRehash' packages/password/src/Password.ts` shows no `signIn` hit.
- **Gate:** per-phase gate plus `pnpm test:bdd`. Changeset C2 (opened here, extended through ticket 11).

#### 07 — `changePassword` and `reauthenticate` verify through the module

- **Files:** `packages/password/src/Password.ts`, `packages/password/test/PasswordNoCredential.test.ts` (deleted), `packages/password/test/PasswordCredential.test.ts`.
- **Change:** both use `credential.verify(Effect.succeedSome({ id: input.userId }), …)`; `Refused` → `WrongPassword`. Delete `verifyPassword`, the dummy, the calibration, `timingFloorFor` and `withTimingFloor` from `Password.ts`, and both "same uniform-cost shape" comments. The floor now covers the account lookup too (strictly no faster than before; §6.1 BEH-EA-114 note). Delete `PasswordNoCredential.test.ts`: its header says it holds "the uniform-cost fallbacks … that no other test reaches", and V2/V3 now reach them at the interface. The endpoint answer stays covered by "shipping-gaps/11: changePassword rotates the hash and rejects a wrong current password" (`Password.test.ts:1007`) and "ticket 15 (AAPS-001): reauthenticate rejects a wrong current password" (`:1187`).
- **Done when:** `grep -c 'dummyHash\|withTimingFloor\|verifyPassword(\|same uniform-cost' packages/password/src/Password.ts` is 0; the three outage tests of ticket 03 for these endpoints pass.
- **Gate:** per-phase gate.

### Phase 2: one policy, and every write inside `@awthaq/password` (tickets 08-11)

#### 08 — `accept` and `linkFor`: the policy moves into the module; sign-up through it

- **Files:** `PasswordCredential.ts`, `Password.ts`, `PasswordCredential.test.ts`, `Password.test.ts`, `PasswordPolicy.test.ts` (split), `packages/password/test/harness.ts`.
- **Change:**
  1. Move `MalformedBreachResponse`, `HIBP_LINE`, `isBreached` and `checkPolicy` (`Password.ts:547-625`) into `PasswordCredential.ts` as module-private `policyHints`; add `accept` and `linkFor`.
  2. `prepareSignUp` keeps the order budget → `accept` → veto → `linkFor` (§3.5); delete `passwordLink`.
  3. Temporarily, `confirmReset` and `changePassword` call `credential.accept` in place of `checkPolicy` and unwrap the candidate for their old write (one commit's life; replaced in 09/10).
  4. Tests: move the policy matrix to `PasswordCredential.test.ts` (P1-P11, one table-driven `describe`). Delete it from `Password.test.ts`: `:918` "BEH-EA-119: a breached password is rejected …", `:943`, `:955`, `:977`, `:992`. Delete it from `PasswordPolicy.test.ts`: the PHS-004 `describe` (`:21-104`, 5 tests) and the PHS-006 `describe` (`:105-132`, 2 tests). The FAMS-003 `describe` (`:133-162`, signIn behaviour) moves into `Password.test.ts` and `PasswordPolicy.test.ts` is deleted.
  5. Keep as caller wiring, one each: "BEH-EA-120: signUp rejects a too-short password with WeakPassword" (`:163`), "shipping-gaps/11: changePassword rejects a weak new password" (`:1138`), and `PasswordRecovery.test.ts`'s ARF-002 pair (ordering is the endpoint's job).
- **Done when:** `grep -l 'onUnavailable' packages/password/test/*.ts` lists only `PasswordCredential.test.ts` and `PasswordRecovery.test.ts`; `grep -c 'checkPolicy\|isBreached' packages/password/src/Password.ts` is 0; the BDD BEH-EA-119/120 scenarios pass.
- **Gate:** per-phase gate plus `pnpm test:bdd`.

#### 09 — `replace` and `has`: `confirmReset` and `requestReset`

- **Files:** `PasswordCredential.ts`, `Password.ts`, `PasswordCredential.test.ts`, `PasswordRecovery.test.ts`.
- **Change:**
  1. Add `replace`, `has` and the shared `write` (§3.3).
  2. `confirmReset`: inside `use`, `replace` returning `false` → `TokenConsumed` replaces `:1440-1457`; the KDF stays after the consume.
  3. `requestReset`: `has` replaces `:1325-1332`.
  4. Add W3, W4, W5, W7 and the outage case W8.
  5. Add "a well-formed reset token for no live row costs no password hash" to `PasswordRecovery.test.ts` (a counting hasher; `hash` count unchanged after the `TokenConsumed`). This pins §3.2's placement.
- **Done when:** ARF-004 "confirmReset for a credential-less user fails TokenConsumed, not a defect" (`PasswordRecovery.test.ts:160`), BEH-EA-117 (`Password.test.ts:790`) and the BDD scenarios "A failure after the credential hash update rolls back the token, the new password and the session revocation together" (`15-password.feature:149`) and `VerificationSteps.ts:290-350`'s in-transaction sighting of `Accounts.updateCredentialHash` pass. That sighting still holds: `replace` calls `Accounts.updateCredentialHash` inside `use`.
- **Gate:** per-phase gate plus `pnpm test:bdd`.

#### 10 — `changePassword` is one unit of work

- **Files:** `Password.ts`, `packages/password/test/PasswordCredentialSql.test.ts` (new; shared with 11), `Password.test.ts`.
- **Change:** `changePassword` as in §3.5: `accept` outside, then `replace` + `auth.password.changed` + `revokeOthers` + `issue` inside `sqlTransaction.withTransaction`, with `SqlError` → `StoreUnavailable("Password.changePassword")`. `make` yields `SqlTransaction`. `SignInSeams.test.ts`'s allowlist entry for `password/src/Password.ts` (1 `sessions.issue`, "changePassword rotates the caller's own session") is unchanged.
- **Tests:**
  - SQL (`TestAuth.layer(Auth.make([Password]), { records: "sql", suite: "password_credential", services })`): "a changePassword that fails after the hash write keeps the old password and every other session". A `decorate` on `Sessions` fails `issue` once; afterwards the old password verifies and both other sessions verify.
  - "ALF-004: changePassword publishes auth.password.changed, auth.session.revoked(reason: passwordChanged), and auth.session.issued for the rotated session" (`Password.test.ts:1081`) still passes. The events are now released on commit, in the same order.
- **Done when:** both tests pass on SQLite; `PasswordCredentialSql.test.ts` is in `scripts/test-pg.sh` (from ticket 11).
- **Gate:** per-phase gate. Skip this ticket only if §10 Q4 is answered "defer".

#### 11 — `set`, and the SQL suite in `test:pg`

- **Files:** `PasswordCredential.ts`, `PasswordCredential.test.ts`, `PasswordCredentialSql.test.ts`, `scripts/test-pg.sh`, `packages/test/src/StoreContract.ts` (one case).
- **Change:**
  1. Add `set`; add W1, W2, W6.
  2. SQL cases: S1 "two concurrent sets for a user with no password credential leave exactly one password account, holding one of the two hashes" (`Effect.all([...], { concurrency: 2 })`); S2 "replace inside a unit that rolls back leaves the old hash".
  3. Add `StoreContract.accounts` case "insertIfAbsent that loses a race inside an enclosing transaction leaves it usable". The users store has this case (U-7, `StoreContract.ts:1019`); accounts does not, and `set`'s retry depends on it.
  4. Add `packages/password/test/PasswordCredentialSql.test.ts` to `scripts/test-pg.sh`.
- **Done when:** S1 and S2 pass on SQLite and under `pnpm test:pg` on Postgres; the new contract case passes on Ref, SQLite and Postgres.
- **Gate:** per-phase gate plus `pnpm test:pg`. C2 complete.

### Phase 3: the other callers (tickets 12-14)

#### 12 — `AdminAccounts` through the module: one policy, typed outages

- **Files:** `packages/admin/src/AdminAccounts.ts`, `packages/admin/src/Admin.ts`, `packages/admin/src/AdminAccountsApi.ts`, `packages/admin/package.json` and tsconfigs (`pnpm workspace:sync`), `packages/admin/test/{AdminAccounts,AdminAccountsHttp,AuthComposition,Contract}.test.ts`, `.changeset/admin-accounts-password-policy.md` (C3).
- **Change:**
  1. `AdminAccounts.layer`: `dependsOn: [Password.Password]`; `ports: [Mailer.Mailer, SqlTransaction.SqlTransaction]`; resolve `PasswordCredential`; `setUserPassword` as in §3.5. Fix the header's "BEH-EA-225" to BEH-EA-221/224 and rewrite its `setUserPassword` paragraph.
  2. `Admin.ts`: delete `passwordPolicy` from `AdminConfigShape`, `defaultPasswordHints` and the default entry.
  3. `AdminAccountsApi.ts`: `AdminWeakPassword`'s doc names `Password.config`; replace the local `MAX_PASSWORD_LENGTH` with `PasswordApi.MAX_PASSWORD_LENGTH`.
  4. Add `@awthaq/password` to `packages/admin/package.json` `dependencies`, then run `pnpm workspace:sync`.
- **Tests:**
  - Compositions become `Auth.make([Admin.Admin, Password.Password, AdminAccounts.AdminAccounts])`, with `TestAuth.httpClient.noBreach` in `services` where breach screening is not under test.
  - `AuthComposition.test.ts` gains the `// @ts-expect-error` refusal of `[Admin, AdminAccounts]`.
  - Ticket 03's admin policy tests go green. They are the **admin-path policy test** (breach, and `Password.config({ minLength: 16 })`), plus "a tenant's Password.config applies to an administrator-set password".
  - Delete "a host policy replaces the default" (`AdminAccounts.test.ts:444-459`): the knob is gone. Keep "a password violating the policy is refused with its hints, and nothing changes" (`:431`).
- **Done when:** `grep -rn 'passwordPolicy\|defaultPasswordHints' packages/*/src` is empty; `grep -c 'PasswordHasher' packages/admin/src/AdminAccounts.ts` is 0; all admin tests pass.
- **Gate:** per-phase gate plus `pnpm workspace:check`.

#### 13 — `awthaq seed admin` through the module

- **Files:** `packages/cli/src/Seed.ts`, `packages/cli/package.json` and tsconfigs (`pnpm workspace:sync`), `packages/cli/test/Seed.test.ts`, `packages/cli/test/support/SqlApp.ts`, `.changeset/cli-seed-password-policy.md` (C4).
- **Change:** as §3.5:
  - `accept` first, before anything is written; `set` after the create or promote; `auth.password.changed` when a password was set.
  - Delete `MIN_PASSWORD_LENGTH`, the `PasswordHasher`/`Accounts` lookups and the `orDie`.
  - A password given to an application without the Password plugin is `ApplicationUnavailable` (exit 9) naming it (§10 Q9).
  - `SqlApp.ts` gains `PasswordCredential.PasswordCredential.layer` with `TestAuth.httpClient.noBreach` (and `Password.config` defaults).
- **Tests:**
  - Keep "stores a hashed password credential, never the plaintext, and rejects a short one" (`Seed.test.ts:156`; the short password is still exit 2, now with the policy's hint).
  - Ticket 03's seed tests go green.
  - Add "a password with no Password plugin in the application is ApplicationUnavailable (exit 9), writing nothing".
- **Done when:** `grep -rn 'MIN_PASSWORD_LENGTH\|hasher\.' packages/cli/src` is empty; the Seed suite passes.
- **Gate:** per-phase gate plus `pnpm workspace:check`.

#### 14 — The importers name the constant

- **Files:** `packages/migrate-better-auth/src/BetterAuthSource.ts:196`, `packages/migrate-firebase/src/ImportFirebaseUser.ts:219`.
- **Change:** `providerId: "password"` → `providerId: Accounts.PASSWORD_PROVIDER_ID`. Both files import `@awthaq/core` only as types today: `BetterAuthSource.ts:35` has `type Accounts`, and `ImportFirebaseUser.ts:31` has `import type { UserImport }`. Make `Accounts` a value import in each. No behaviour change; no changeset (internal).
- **Done when:** `grep -rn 'providerId: "password"' packages/*/src` is empty.
- **Gate:** per-phase gate.

### Phase 4: seal, specify, document (tickets 15-18)

#### 15 — The credential seam test

- **Files:** `packages/password/test/PasswordCredentialSeams.test.ts` (new).
- **Change:** the `SignInSeams.test.ts` approach (filesystem read of `packages/*/src/**/*.ts`, comment lines stripped, counted allowlist with a reason per entry):
  - `PASSWORD_PROVIDER_ID` occurs only in `core/src/Accounts.ts` (1, the definition), `password/src/PasswordCredential.ts` (N), `migrate-auth0/src/ImportAuth0User.ts`, `migrate-better-auth/src/BetterAuthSource.ts` and `migrate-firebase/src/ImportFirebaseUser.ts` (1 each, "an operator import stores a foreign hash, ADR-EA-038 §3").
  - `.findCredentialHash(` and `.updateCredentialHash(` occur only in `password/src/PasswordCredential.ts`.
  - `\bhasher\s*\.\s*(verify|hash|needsRehash)\(` occurs only in `password/src/PasswordCredential.ts` and `two-factor/src/SecondFactor.ts` (2, "recovery codes, not the password credential").
  - `providerId: "password"` occurs nowhere.
- **Done when:** the test passes, and fails when a deliberate `accounts.findCredentialHash(` is added to `Password.ts` (check locally, revert).
- **Gate:** per-phase gate.

#### 16 — Spec: BEH-EA-345, ADR-EA-048, notes, glossary, traceability

- **Files:** `spec/behaviors/15-password.md`, `27-admin-impersonation.md`, `26-cli.md`, `07-sessions.md`, `spec/decisions/043-password-credential-module.md` (new), `spec/decisions/040-plugin-exposes-domain-services.md`, `spec/decisions/index.yaml`, `spec/glossary.md`, `spec/traceability.md`.
- **Change:** exactly §6.1-§6.4.
- **Done when:** `pnpm spec:verify:strict` passes; every row in §6.1 has its Document Control bump.
- **Gate:** per-phase gate plus `pnpm spec:verify:strict`.

#### 17 — BDD: an administrator-set password obeys `Password.config`

- **Files:** `features/features/05-authentication-methods/15-password.feature`, `features/step-definitions/PasswordWorld.ts`, `PasswordSteps.ts`, `features/traceability.md` (via `features/scripts/allocate-req-ea.py`).
- **Change:** under BEH-EA-120, add the scenario "Password.config's policy also governs a password an administrator sets". Given `password({ breachCheck: true, minLength: 12 })` with AdminAccounts installed beside it; when an administrator sets a user's password to one that appears in a known breach; then the response is 422 `AdminWeakPassword` with hints including "appears in known breaches", and the user's password is unchanged. `PasswordWorld` gains a second composition `Auth.make([Password, Admin, AdminAccounts])` used only by the step "AdminAccounts is installed beside Password". Allocate REQ-EA-1307 (next free at writing; reconcile with plans 11-16).
- **Done when:** the scenario passes under `pnpm test:bdd`; `features/traceability.md` lists it.
- **Gate:** per-phase gate plus `pnpm test:bdd`.

#### 18 — READMEs and changeset review

- **Files:**
  - `packages/password/README.md`: a "Password credential" section on `PasswordCredential` for trusted callers, the brands, and "every password goes through `accept`".
  - `packages/admin/README.md`:
    - `:20`: drop `passwordPolicy`;
    - `:50`: `Auth.make([Admin, Password, AdminAccounts])`;
    - `:54`: the policy is `Password.config`'s.
  - `packages/cli/README.md` if it states the 12-character minimum.
  - `.changeset/*` from tickets 04, 06-11, 12 and 13.
- **Done when:** `pnpm check:readmes` passes; each changeset has its `Migration:` text from §6.5.
- **Gate:** `pnpm check` plus `pnpm test:pg` (the plan gate).

### Ticket table

Maps 1:1 onto `.scratch/27-password-credential/issues/NN-<slug>.md` (`Status: ready-for-agent`, `Blocked by:` from the last column).

| # | Title | Phase | Depends on |
|---|---|---|---|
| 01 | Baseline | 0 | none |
| 02 | Spike: exposure and brand typing | 0 | 01 |
| 03 | Red tests for the confirmed defects | 0 | 01 |
| 04 | Hotfix: ADR-EA-028 on the credential path, in place | 0 | 03 |
| 05 | Extract `PasswordConfig.ts` | 1 | 02 |
| 06 | `PasswordCredential` with `verify`/`rehashIfStale`, exposed; `signIn` through it (tracer) | 1 | 05 |
| 07 | `changePassword` and `reauthenticate` verify through the module | 1 | 06 |
| 08 | `accept` and `linkFor`: the policy moves; sign-up through it | 2 | 07 |
| 09 | `replace` and `has`: `confirmReset` and `requestReset` | 2 | 08 |
| 10 | `changePassword` is one unit of work | 2 | 09 |
| 11 | `set`, and the SQL suite in `test:pg` | 2 | 09 |
| 12 | `AdminAccounts` through the module | 3 | 11, 03 |
| 13 | `awthaq seed admin` through the module | 3 | 11, 03 |
| 14 | The importers name the constant | 3 | none |
| 15 | The credential seam test | 4 | 12, 13, 14 |
| 16 | Spec: BEH-EA-345, ADR-EA-048, notes, glossary, traceability | 4 | 12, 13 |
| 17 | BDD: an administrator-set password obeys `Password.config` | 4 | 12 |
| 18 | READMEs and changeset review | 4 | 15, 16, 17 |

---

## 5. Test plan

### 5.1 At the new interface (`packages/password/test/PasswordCredential.test.ts`)

**Composition.** Through `makeTestLayer` (`harness.ts`), which already swaps the hasher, the HIBP transport, the config and a wrapped `Accounts`. Tests `yield* PasswordCredential.PasswordCredential` from the context (ticket 02 proves it is there).

**Doubles.**

- A **recording hasher**: `hash(p) = PhcHash("h:" + p)`; `verify(p, phc)` records `phc` in a `Ref` and answers `phc === "h:" + p`; `needsRehash` is configurable.
- An **instant hasher** (the existing `InstantHasher`, `Password.test.ts:1506-1513`).
- A **clock-advancing hasher** for calibration. Its first `verify` (the boot calibration) runs `TestClock.adjust(Duration.millis(80))`; later calls are instant. If `TestClock.adjust` inside a layer build is not usable, test the Duration path only and unit-test `floorMillis` (record the fallback in ticket 06).

| Id | Case | Origin |
|---|---|---|
| V1 | An unknown claimant runs exactly one verify, against the boot-time dummy hash, and is `Refused` | new (no test asserts the dummy today) |
| V2 | A claimant with no password account: one verify against the dummy hash, `Refused` | replaces `PasswordNoCredential.test.ts` |
| V3 | A password account with no hash stored: the same | new |
| V4 | A wrong password: one verify against the stored hash, `Refused` | new at this level |
| V5 | The right password: `Verified`, carrying the claimant value and a proof of that account | new |
| V6 | An account unlinked between the account read and the hash read is `Refused`, not a defect | new (`Password.ts:1229` dies today) |
| V7 | A failing claimant lookup passes its failure through; an `Accounts` outage is `StoreUnavailable` | new |
| F1 | A `Refused` verdict is held to a `Duration` floor (instant hasher; `TestClock` +60 ms pending, +60 ms done) | moved from `Password.test.ts:1518` |
| F2 | A `Verified` verdict is held to the floor too | new |
| F3 | A failing claimant lookup is held to the floor ("success and failure alike") | new |
| F4 | `"off"` adds nothing | moved from `Password.test.ts:1535` |
| F5 | `"calibrated"` pads to 1.25 × the boot-time dummy verify (80 ms → 100 ms) | new |
| R1 | A stale hash is rewritten with current parameters | moved from `Password.test.ts:229` |
| R2 | A hash stronger than the target is untouched (PHS-002) | moved from `Password.test.ts:266` |
| R3 | `rehashOnLogin: false` leaves a stale hash | new |
| R4 | An account unlinked since the proof: no write, no defect | new (`:1272` dies today) |
| P1 | Shorter than `minLength` in force → `WeakPassword` with the length hint | from `Password.test.ts:163`'s mechanism |
| P2 | A breached password → `"appears in known breaches"`; only a 5-character SHA-1 prefix is requested | moved from `Password.test.ts:918` |
| P3-P9 | Table: transport failure, 429, 503, HTML 200, empty 200, timeout past `breachCheckTimeout` × `onUnavailable` allow/reject | moved from `Password.test.ts:943, :955, :977, :992` and `PasswordPolicy.test.ts:21-104` |
| P10 | `breachCheck: false` makes no request | moved from `PasswordPolicy.test.ts:120` |
| P11 | The default config screens (PHS-006) | moved from `PasswordPolicy.test.ts:112` |
| W1 | `set` links a credential for a user with none (`subject = userId`, no issuer) | new at this level |
| W2 | `set` replaces an existing credential's hash | new at this level |
| W3 | `replace` for a user with none answers `false`, writes nothing and computes no hash | new |
| W4 | `replace` replaces | new |
| W5 | `has` | new |
| W6 | `linkFor`'s function builds the password `LinkInput` for the user it is given | new |
| W7 | Each of `set`/`replace` computes at most one hash | new |
| W8 | An `Accounts` outage during `set`/`replace`/`has` is `StoreUnavailable` | new |

**Types** (`PasswordCredential.types.test.ts`, from ticket 02):

- `Accepted` and `Proof` cannot be forged;
- `set`/`replace`/`linkFor` refuse a raw `Redacted`;
- `rehashIfStale` refuses a non-proof;
- `[Admin, AdminAccounts]` is refused by `Validate`.

### 5.2 Caller wiring (kept, one per concern, not re-testing the mechanism)

| Caller | Kept test | What it proves |
|---|---|---|
| `signIn` | `Password.test.ts:361` (uniform InvalidCredentials ×3), `:182` (success, no spurious rehash), `:1606` (erased between proof and session) | the verdict's mapping and the gate order |
| `signUp` | `:163` (too short → WeakPassword), `PasswordHooksSignUp.test.ts` | the policy surfaces; the veto precedes the KDF |
| `changePassword` | `:1007`, `:1138`, `:1053`, `:1081`, plus ticket 10's SQL rollback case | refusal, weak password, revocation, events, atomicity |
| `reauthenticate` | `:1187`, `:1203` | refusal; a dead session is 401 |
| `confirmReset` | `PasswordRecovery.test.ts` ARF-002 ×2, ARF-004 `:160`, ticket 09's "no hash for a dead token" | ordering, credential-less refusal, KDF placement |
| `requestReset` | `PasswordRecovery.test.ts:135` (ARF-004 mail) | `has` |
| outage | `PasswordStoreOutage.test.ts`: signIn (existing) + changePassword + reauthenticate + confirmReset (ticket 03) | no endpoint converts `StoreUnavailable` into a defect (ADR-EA-028 is about the wire answer) |
| tenant | `PasswordTenantConfig.test.ts` (5 tests, unchanged; `:99` covers a tenant's floor) | EP-007 through the module |
| admin | the admin-path policy tests (breach, `minLength: 16`, tenant), `:431`, ARF-005 `:473`, SqlError → StoreUnavailable | one policy on the admin path |
| seed | `Seed.test.ts:156`, ticket 03's two, no-plugin exit 9 | one policy on the CLI path |
| BDD | `15-password.feature:50-78` (uniform, latency floor 250 ms end to end), `:138-175` (reset in one transaction), new REQ-EA-1307 | acceptance |

### 5.3 Concurrency and real Postgres

`PasswordCredentialSql.test.ts` runs under `TestAuth` `records: "sql"` (SQLite `:memory:`, or a per-suite Postgres schema under `AWTHAQ_POSTGRES_URL`) and is added to `scripts/test-pg.sh`:

- **S1:** two concurrent `set`s for a credential-less user leave one account. This exercises `insertIfAbsent`'s `ON CONFLICT DO NOTHING` and the re-read under READ COMMITTED.
- **S2:** `replace` inside a rolled-back unit leaves the old hash.
- **S3 (ticket 10):** a failed `changePassword` keeps the old password and the other sessions.

The new `StoreContract.accounts` case runs on Ref, SQLite and Postgres through the existing runners.

### 5.4 Deleted tests and measurable shrinkage

**Deleted (by name).**

- `Password.test.ts`:
  - "BEH-EA-116: signIn against a hash stored under outdated parameters rehashes to current parameters";
  - "BEH-EA-116/PHS-002: signIn against a hash stronger than the current parameters does not rehash it";
  - "BEH-EA-119: a breached password is rejected with WeakPassword when breachCheck is on";
  - "BEH-EA-119: an unreachable breach check fails open by default";
  - "BEH-EA-119: an unreachable breach check fails closed when configured";
  - "CSD-001: a 429 from the breach check fails open by default";
  - "CSD-001: a 503 from the breach check fails closed when configured";
  - the `describe("Password signIn timing floor (TSS-006)")` block (2 tests).
- `PasswordPolicy.test.ts`: whole file (PHS-004 ×5 and PHS-006 ×2 moved to the module; FAMS-003 ×2 moved to `Password.test.ts`).
- `PasswordNoCredential.test.ts`: whole file (2).
- `AdminAccounts.test.ts`: "a host policy replaces the default".
- `harness.ts`: `UnavailableHttpClient`/`httpClientReturning` aliases if knip reports them unused.

That is **19 tests deleted**. Added: **35** at the interface (§5.1), **4** SQL or contract cases (S1-S3 and the accounts contract case), and **11** at the callers (ticket 03's 8, ticket 09's dead-token case, ticket 12's tenant case, ticket 13's no-plugin case). Every new caller test covers a defect or a path with no test today; none re-tests a mechanism the interface suite covers.

**Targets (acceptance):**

| Measure | Before | After |
|---|---:|---:|
| `wc -l packages/password/src/Password.ts` | 1,780 | ≤ 1,590 |
| `grep -cE 'dummyHash\|withTimingFloor\|checkPolicy\|isBreached\|findCredentialHash\|updateCredentialHash\|PASSWORD_PROVIDER_ID\|hasher\.' packages/password/src/Password.ts` | 39 | 0 |
| `grep -c 'orDie' packages/password/src/Password.ts` | 5 | 1 (`:972`, the identifier digest) |
| Files in `packages/password/test` mentioning `onUnavailable` | 3 | 2 (`PasswordCredential.test.ts`, `PasswordRecovery.test.ts`) |
| Files in `packages/password/test` mentioning `signInTimingFloor` | 2 | 2 (`PasswordCredential.test.ts`, `PasswordTenantConfig.test.ts`), and `Password.test.ts` drops out |
| "same uniform-cost shape" comments | 2 | 0 |
| Password policies in library source | 3 | 1 |
| Library files calling `findCredentialHash`/`updateCredentialHash` | 2 | 1 |
| Tests asserting the dummy hash is verified | 0 | 2 (V1, V2) |
| Tests of the floor on a non-signIn path | 0 | covered once at `verify` (F1-F3), and every caller uses `verify` |

---

## 6. Spec, ADR, traceability, BDD, docs, changesets

### 6.1 Behaviours

| Artifact | Change |
|---|---|
| **New BEH-EA-345** in `spec/behaviors/15-password.md` (after BEH-EA-120): "Every path that verifies, sets or rehashes a password goes through one module" | REQUIREMENT: "`PasswordCredential` MUST be the only code that reads or writes a password credential or runs the `PasswordHasher` on it. Every path that sets a password (sign-up in either enumeration mode, reset, change, `AdminAccounts.setUserPassword`, `awthaq seed admin`) MUST pass `PasswordConfig`'s policy in force (`accept`) before anything is written, and MUST NOT run the breach check inside a transaction. A write MUST run inside the caller's unit of work. `changePassword`'s hash write, the revocation of the caller's other sessions and the rotation of its own MUST commit as one unit. A store outage on any of these paths MUST be `StoreUnavailable`, never a defect." Prose: the brands, the KDF placement (§3.2) and the operator-import exemption. Test pointers: `PasswordCredential.test.ts`, `PasswordCredentialSql.test.ts`, `PasswordCredentialSeams.test.ts`. BEH-EA-345 is the next free id at writing; the orchestrator reconciles if plans 11-16 claim it. |
| BEH-EA-114 | The timing-floor paragraph names `PasswordCredential.verify`. "`changePassword` and `reauthenticate` hold their verify to the same floor" becomes "… hold their lookup and verify to the same floor". The dummy hash is verified on every refusal (V1/V2). |
| BEH-EA-116 | Rehash is `rehashIfStale` on a verify's proof; an account unlinked since the proof is left alone. |
| BEH-EA-117 | "MUST evaluate the password policy before consuming the token" is unchanged. Add: "the new password is hashed only once the token is consumed, so an unknown token costs no KDF". |
| BEH-EA-119 | REQUIREMENT: "sign-up MUST proceed (fail-open)" becomes "setting a password (sign-up, reset, change, an administrator's set, `seed admin`) MUST proceed (fail-open) …". |
| BEH-EA-120 | Add to the REQUIREMENT: "… and MUST govern every path that sets a password, including `AdminAccounts.setUserPassword` and `awthaq seed admin`; no other policy exists." |
| Document control `15-password.md` | 1.5 → 1.6, change history "BEH-EA-345; one policy for every password; `changePassword` is one unit (plan 27)" |
| BEH-EA-221 prose (`27-admin-impersonation.md:352`) | `setUserPassword` checks the password against **`Password.config`'s policy** (the `AdminAccounts` plugin lists `Password` in `dependsOn`), consults `Hooks.BeforeCredentialReset` (replacing the stale "does not yet consult"), and answers `StoreUnavailable` on an outage. Revision 1.4 → 1.5. |
| BEH-EA-206 implementation note (`26-cli.md`) | "is at least 12 characters, and is stored as a hash through `PasswordHasher`" becomes "passes the application's `Password` policy (`Password.config`: minimum length, breach screening) and is stored through `PasswordCredential.set`, replacing an existing password credential (§10 Q3). A password given to an application without the Password plugin is `ApplicationUnavailable`." Revision 1.4 → 1.5. |
| BEH-EA-053 (`07-sessions.md`) | One sentence: "`changePassword`'s supersede, the revocation of the caller's other sessions and the credential write are one unit (plan 27)." Revision bump. |
| `spec/glossary.md` | New entry **Password credential** (§0 definition, see ADR-EA-048). Revision 1.5 → 1.6. |

### 6.2 ADRs

**New `spec/decisions/043-password-credential-module.md`** (status "Accepted", becoming "Accepted — implemented" with ticket 15), plus an `index.yaml` entry. Draft:

> **ADR-EA-048: The Password Credential Is One Module of `@awthaq/password`, Under One Policy**
>
> *Context.* Eight sites in three packages open-coded "the password credential of user X" (find the account, read the hash, verify under a timing floor against a dummy, check the policy, hash, update or link). They drifted:
> - three policies, of which the administrator's and the CLI's skipped breach screening and ignored `Password.config` and its tenant overrides;
> - three outage answers, with four `orDie` sites returning 500 where the Shape declares 503;
> - two KDF placements and two floor scopes;
> - one non-atomic credential change.
>
> The administrator's knob existed because "`Admin` cannot depend on the password plugin", a constraint ADR-EA-040 removed.
>
> *Decision.*
> 1. `PasswordCredential` (`awthaq/plugin/password/Credential`) is the only code that reads or writes the password credential (the `accounts` row with `providerId = "password"`, `subject = userId`) or runs the `PasswordHasher` on it. Its interface is `verify` (uniform cost: one real verify, against a boot-time dummy hash when there is no credential, held to the timing floor in force), `rehashIfStale`, `accept` (the policy), `linkFor`, `set`, `replace` and `has`.
> 2. It lives in `@awthaq/password` and is exposed under ADR-EA-040. A trusted dependent lists `Password` in `dependsOn` (`AdminAccounts`), or reads it from the application context (`awthaq seed admin`). It is not a core module:
>    - one plugin verifies;
>    - the policy is `Password`'s configuration (BEH-EA-120), decided per tenant (EP-007);
>    - its breach check is an outbound HTTP integration the domain stratum does not make.
>
>    ADR-EA-010 is untouched: `PasswordHasher` stays a port the application provides, and an exposed module is not a port.
> 3. One policy: `PasswordConfig`'s minimum length and breach screening govern every path that sets a password. `AdminConfig.passwordPolicy` and the CLI's own minimum are removed.
> 4. Order is typed. A write takes only an `Accepted`, which only `accept` mints; a rehash takes only a `Proof`, which only `verify` mints.
> 5. The policy never runs inside a transaction (no network call, BEH-EA-117). A write runs inside the caller's unit. Sign-up hashes before its unit (equal work in both enumeration-concealing branches, ADR-EA-026). A reset hashes only after its token is consumed (an unknown token costs no KDF).
> 6. Operator imports (`UserImport`, `@awthaq/migrate-*`) store a foreign hash and set no password. They are exempt, as ADR-EA-038 §3 exempts them from `SignUp`.
> 7. `PasswordCredentialSeams.test.ts` pins the discipline the compiler cannot.
>
> *Consequences.*
> - (+) One place to change or audit how a password is checked or set. Uniform cost and the policy are tested once. An administrator-set password is screened.
> - (−) `AdminAccounts` requires `Password`. Administrator and CLI hosts now call the breach-check provider (configurable, fail-open by default). An administrator's KDF runs inside its transaction.
>
> *Alternatives.*
> - (a) A core module resolved by `make`, like `SignIn`. Rejected: it moves the policy out of `Password`'s configuration or breach screening into a port, and brings HIBP into core.
> - (b) Core mechanism with the policy injected by each caller. Rejected: it keeps one policy per caller.
> - (c) A `PasswordPolicy` port. Rejected: ADR-EA-010 makes ports application wiring, while the policy is plugin configuration with per-tenant overrides.
> - (d) Keep `AdminConfig.passwordPolicy` and document it. Rejected: its default silently skips screening.
> - (e) Split `setUserPassword` into its own plugin so only it depends on `Password`. Deferred to the user (plan 27 Q1).

**ADR-EA-040** rev 1.0 → 1.1: a revision note under *Consequences*: "Second user: `@awthaq/password` exposes `PasswordCredential` (ADR-EA-048); `AdminAccounts` lists `Password` in `dependsOn`, as `AdminTenants` lists `Organization`." No decision text changes.

**No ADR is contradicted.**

- ADR-EA-010: `PasswordHasher` is still required, never provided.
- ADR-EA-028: this plan removes violations.
- ADR-EA-037: `changePassword`'s events are released on commit.
- ADR-EA-038 §3: seed stays exempt from `SignUp`; the password policy is a different concern.
- ADR-EA-026: conceal mode's equal-work property is preserved by `linkFor`.
- ADR-EA-011: `PasswordConfig` stays a `Context.Reference` with a default.

### 6.3 Traceability (`spec/traceability.md`, 1.32 → 1.33)

- **§1 (behaviour → source module):** BEH-EA-345 → `packages/password/src/PasswordCredential.ts`. BEH-EA-114/116/119/120 rows also name it.
- **§4 (decision table):** ADR-EA-048 row (affects BEH-EA-114, 116, 117, 119, 120, 206, 221, 338).
- **§5 (test file table):**
  - new rows for `PasswordCredential.test.ts`, `PasswordCredential.types.test.ts`, `PasswordCredentialSql.test.ts` and `PasswordCredentialSeams.test.ts`;
  - the `Password.test.ts` row (`:240`) drops "`breachCheck`'s fail-open-by-default …" (moved);
  - the `cli/test/Seed.test.ts` row (`:292`) names the policy;
  - the ADR-EA-028 row (`:170`) adds `PasswordStoreOutage.test.ts`'s new cases.
- **§6 (BDD):** REQ-EA-1307.

### 6.4 BDD

- `15-password.feature`: one new scenario under BEH-EA-120 (ticket 17), allocated with `features/scripts/allocate-req-ea.py`.
- Unchanged scenarios that must stay green:
  - `:50-78`: uniform refusal and the latency floor, end to end;
  - `:107-125`: rehash;
  - `:138-175`: reset in one transaction;
  - `:202-260`: breach check and policy configuration.
- No admin-accounts feature exists today; this plan adds none beyond REQ-EA-1307.

### 6.5 Changesets (ADR-EA-034; all packages are in the fixed group)

| # | File | Packages | Text and `Migration:` |
|---|---|---|---|
| C1 | `credential-store-outage.md` (ticket 04) | `@awthaq/password`, `@awthaq/admin`, `@awthaq/cli` patch | "A store outage while reading or writing a password credential is `StoreUnavailable` (503) in `change-password`, `reauthenticate`, `confirm-reset` and the administrator's `setUserPassword`, and a retryable usage error in `seed admin`, instead of a 500 defect." `Migration:` none (compatible); alerting that keyed on 500s from these endpoints sees 503s. |
| C2 | `password-credential-module.md` (tickets 06-11) | `@awthaq/password` minor | "`PasswordCredential` (exposed by `Password.layer`, ADR-EA-048) is the one module for verifying, setting and rehashing a password: `verify`, `rehashIfStale`, `accept`, `linkFor`, `set`, `replace`, `has`. `changePassword` now commits the new hash, the revocation of the caller's other sessions and the rotated session as one unit." `Migration:` none in the API (`Password.config`, `Password.PasswordConfig` and `Password.PasswordConfigShape` are unchanged; they now live in `PasswordConfig.ts` and are re-exported). Trusted code that read or wrote the password credential through `Accounts` should use `PasswordCredential`. |
| C3 | `admin-accounts-password-policy.md` (ticket 12) | `@awthaq/admin` minor (breaking, pre-1.0) | "`AdminAccounts` lists `Password` in `dependsOn`: an administrator-set password passes `Password.config`'s policy (minimum length, breach screening, per-tenant overrides). `AdminConfig.passwordPolicy` is removed." `Migration:` compose `Auth.make([Admin, Password, AdminAccounts])` and provide the `HttpClient` the breach check uses, or set `Password.config({ breachCheck: false })` to opt out. Move a custom `passwordPolicy` to `Password.config({ minLength, breachCheck })`; an administrator-only extra rule is no longer supported (plan 13 Q2). `AdminWeakPassword` may now carry `"appears in known breaches"`. |
| C4 | `cli-seed-password-policy.md` (ticket 13) | `@awthaq/cli` minor | "`seed admin` checks a password with the application's `Password` policy and replaces an existing password credential instead of silently keeping it; it publishes `auth.password.changed` when it sets one." `Migration:` an application without the Password plugin can still seed an account, but not with a password (exit 9). An operator script that relied on re-runs leaving an existing password alone should omit the password. |

---

## 7. Risks, mitigations, rollback

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Composition break.** A host composing `AdminAccounts` without `Password` no longer compiles. | Compile-time, with `Validate`'s message naming `password`. C3's `Migration:` text. No shipped example composes `AdminAccounts` (`grep -rln AdminAccounts examples` is empty). §10 Q1 offers the split instead. |
| R2 | **New egress and new refusals.** Administrator and CLI hosts now call `api.pwnedpasswords.com` when setting a password; admins see 422s they did not see before. | The same `breachCheck` knob and fail-open default as sign-up (BEH-EA-119). The CLI builds the application's own layer, so an air-gapped deployment's `breachCheck: false` applies. C3/C4 say so. |
| R3 | **KDF inside a transaction.** `set`/`replace` hash inside the caller's unit: admin's KDF moves inside (it was outside), and changePassword's is now inside its new unit. A pooled connection is held for one derivation. | Both paths are low volume. Admin is gated and rare; changePassword is authenticated and budgeted at 5 per 15 minutes per user. `confirmReset` was already so. If measured as a problem, §10 Q6 adds a pre-hash variant. |
| R4 | **Floor regression while moving code.** Something stops being floored, or the dummy stops being verified. | V1-V3, F1-F5 at the interface, and the BDD 250 ms scenario end to end (`15-password.feature:70`) in every Phase 1-2 gate. |
| R5 | **Typing of `exposes` and the brands.** | Ticket 02 spike before any caller moves; fallbacks named there. |
| R6 | **Import cycle** `Password.ts` ↔ `PasswordCredential.ts`. | Ticket 05 extracts `PasswordConfig.ts` first; `pnpm circular` in every gate. |
| R7 | **`changePassword` in a unit changes event timing.** | ADR-EA-037 releases `auth.password.changed`, `auth.session.revoked` and `auth.session.issued` after the commit, in order. ALF-004 (`Password.test.ts:1081`) guards the order. Memory compositions (`layerNoop`) behave exactly as before. |
| R8 | **BDD worlds observe repository calls.** `DomainWorld.ts:126-134` decorates `Accounts.updateCredentialHash`; `VerificationSteps.ts:290-350` asserts it runs inside the transaction. | `replace` still calls `Accounts.updateCredentialHash` inside `redeem`'s `use`. `pnpm test:bdd` in tickets 06-09. |
| R9 | **Textual conflicts with plan 26** in `Password.ts` (inputs and handlers versus bodies). | §8 ordering. The module takes no request facts, so a rebase touches call sites only. |
| R10 | **Seed semantics change** (replace instead of keep). | §10 Q3 decides before ticket 13; C4's `Migration:` text. |

**Rollback.** No migration or column changes, so every ticket reverts with `git revert` alone.

- Tickets 04-11 are internal to `@awthaq/password` except the outage fix.
- Reverting ticket 12 restores `AdminConfig.passwordPolicy` and admin's own path; it is independent of 13.
- Ticket 15's seam test must be reverted with any ticket that re-opens a site.

---

## 8. Interactions with other plans

| Plan | Interaction | Decision |
|---|---|---|
| **01** sign-in/sign-up (done) | `signIn` ends in `SignIn.complete`; sign-up links inside `SignUp`'s unit. | Unchanged. The module produces the proof `signIn` hands to `SignIn`, and `linkFor` feeds `SignUp.CreateOptions.link`. ADR-EA-038 §3's import exemption is reused. |
| **02** domain store seam (done) | `Accounts` over `AccountStore`. | `set`'s race handling relies on `insertIfAbsent`'s `ON CONFLICT DO NOTHING` (`AccountStoreSql.ts:8-9`); ticket 11 adds the missing accounts contract case. Retry-then-`StoreUnavailable` follows plan 02's `casIdentity` precedent. |
| **06** rate-limit budget (done) | Budgets stay at the endpoints. | The module never spends a budget, and callers spend before `verify`/`accept` (signIn, signUp, changePassword, reauthenticate, confirmReset as today). Admin and CLI stay unthrottled (plan 06 Q9). A future failure rule (`guard`/`charge`) for password sign-in would charge on `Refused`; the verdict is the hook, nothing to add now. |
| **07** `Verification.redeem` (done) | `confirmReset`'s write runs inside `redeem`'s `use`. | `replace` runs there; a `false` fails `TokenConsumed`, and `redeem` gives the token back. |
| **08** test composition (done) | `TestAuth.layer`, `records: "sql"`, `TestAuth.httpClient`. | The module and SQL suites use them. Admin test compositions add `Password`. |
| **10** standalone fixes (done) | `reauthenticate` on dead sessions (BEH-EA-319). | Unchanged; `reauthenticate` keeps the `Sessions/NotFound` → 401 mapping. |
| **11** record-store contract | Plugin record stores; `Password` owns no tables. | No interaction. |
| **12** request context | Drops `ip`/`userAgent` from `PasswordShape` inputs and reads them from `AuthRequestContext`. | The module takes no request facts. Conflicts are textual in `Password.ts` (`sessionRequest(input)`, `publishSignInFailed`, `limits.spend(..., input)`). Recommended order: **12 first if both are in flight** (a mechanical signature sweep); 13 rebases its bodies. Neither blocks the other's design. |
| **14** SQL store adapters | Folds `Repositories` into `*StoreSql`. | `AccountStoreSql.insertIfAbsent` must keep `ON CONFLICT DO NOTHING`; ticket 11's contract case pins it for 14. |
| **15** plugin-owned events | May move `auth.password.*` definitions into `@awthaq/password`. | `AdminAccounts` publishes `auth.password.changed`. After this plan it depends on `@awthaq/password` legitimately, so 15 can import a password-owned event there without a new edge. Recommended: **13 before 15's password slice**. |
| **16** speculative follow-ups | Organization authorize primitive; sealed columns. | No interaction. |

### 8.1 Rebasing onto `architecture/deepening-plans-2` (batch 2, plans 11–24)

The branch now checked out carries plans 11–24 from the 2026-10-17 review (see the header's base-drift row). None of them owns the password credential: a scan of their `PLAN.md` files for `dummyHash`, `timing floor`, `checkPolicy`, `PASSWORD_PROVIDER_ID` and `passwordPolicy` finds hits only in 13, 18 and 15. The candidate therefore stands. Rebasing onto that branch changes the following:

| Batch-2 plan (on that branch) | What it changed that this plan touches | Adjustment |
|---|---|---|
| **13-admin-gate** (implemented) | `AdminAccounts` resolves every gate through an `AdminGate` clearance, and `passwordPolicy` is read per tenant as `cleared.config.passwordPolicy`. `AdminConfig` is module-private to `AdminGate.ts`. | Ticket 12 deletes `passwordPolicy` from the clearance's config instead of from a build-time read, and keeps the gate exactly as plan 13-admin-gate left it. §2.6's "not tenant-aware" sub-point and the §1 non-goal about build-time gate reads are already resolved there; the breach-screening and `minLength` drift remain. Plan 13-admin-gate's test "a tenant's passwordPolicy governs an administrator-set password" becomes "a tenant's `Password.config` governs an administrator-set password". |
| **18-verification-link-redeem** (implemented) | `confirmReset` redeems through `VerificationLink`'s redeemer; `checkPolicy` runs as `beforeClaim` (an `Effect<void, …>`); a per-source budget was added (the DoS hole of §3.2 is narrowed there). | `accept` returns a value that `use` needs, but `beforeClaim` returns `void`. Either the redeemer's `beforeClaim` gains a result passed to `use` (`beforeClaim: Effect<B>`, `use: (consumed, b) => …`), or `accept` is run inside `beforeClaim` and its `Accepted` is captured in a `Ref`. Prefer the first: it is typed, and it is a small change to batch-2's redeemer. Ticket 09 records the choice. |
| **11-credential-resolution** (implemented) | `CurrentUser`, `Sessions.IssuedSession`, `ClientAddress.facts` replace plugin copies in `Password.ts`. | Textual only; the module takes no request facts. |
| **15-host-composition** | Mentions the password policy in host wiring (3 hits). | Re-read before ticket 12: `AuthHost` wiring must compose `Password` wherever it composes `AdminAccounts`. |
| ADR numbers | ADR-EA-042 (credential resolution) and ADR-EA-043 (federated identity resolution) exist there. | The orchestrator renumbers this plan's ADR (the next free number on that branch). Ticket 16 and §6.2 use whatever is assigned. |
| Plan numbering | `13-admin-gate` and `16-sql-store-adapters` exist there; this batch's 14 (sql store adapters) duplicates batch-2's 16. | Out of this plan's scope; reported to the orchestrator. |

---

## 9. Acceptance checklist

- [ ] `packages/password/src/PasswordCredential.ts` exists, exports `PasswordCredential` (key `awthaq/plugin/password/Credential`) with exactly `verify`, `rehashIfStale`, `accept`, `linkFor`, `set`, `replace`, `has`, and is re-exported from `packages/password/src/index.ts`.
- [ ] `Password.layer` declares `exposes: { services: [PasswordCredential.PasswordCredential], … }`, and `pnpm vitest run packages/password/test/PasswordCredential.types.test.ts` passes (no `as const`).
- [ ] `PasswordCredentialSeams.test.ts` passes: `PASSWORD_PROVIDER_ID`, `.findCredentialHash(`, `.updateCredentialHash(` and `hasher.(hash|verify|needsRehash)(` occur only at the allow-listed sites of ticket 15.
- [ ] `grep -cE 'dummyHash|withTimingFloor|checkPolicy|isBreached|findCredentialHash|updateCredentialHash|PASSWORD_PROVIDER_ID|hasher\.' packages/password/src/Password.ts` prints `0`.
- [ ] `wc -l packages/password/src/Password.ts` ≤ 1,590.
- [ ] `grep -rn 'passwordPolicy\|defaultPasswordHints\|MIN_PASSWORD_LENGTH' packages/*/src` prints nothing.
- [ ] `grep -c 'orDie' packages/password/src/Password.ts` prints `1`; `grep -n 'Effect.die' packages/admin/src/AdminAccounts.ts` shows no `SqlError` or `AccountAlreadyLinked` site.
- [ ] `grep -rn 'same uniform-cost' packages/password/src` prints nothing.
- [ ] `PasswordCredential.test.ts` contains V1-V7, F1-F5, R1-R4, P1-P11 and W1-W8 (§5.1), all passing.
- [ ] `PasswordStoreOutage.test.ts` passes for signIn, changePassword, reauthenticate and confirmReset (StoreUnavailable, token not spent).
- [ ] `AdminAccounts.test.ts` has the admin-path policy tests (a breached password → `AdminWeakPassword` including "appears in known breaches"; `Password.config({ minLength: 16 })` refuses a 12-character password; a tenant's config applies), and SqlError → `StoreUnavailable`; "a host policy replaces the default" is gone.
- [ ] `Auth.make([Admin.Admin, AdminAccounts.AdminAccounts])` is a compile error asserted by `// @ts-expect-error` in `packages/admin/test/AuthComposition.test.ts`.
- [ ] `Seed.test.ts`: a short or breached seeded password exits 2; a password over an existing credential replaces it (per Q3); a password with no Password plugin exits 9.
- [ ] `PasswordNoCredential.test.ts` and `PasswordPolicy.test.ts` are deleted; `grep -l onUnavailable packages/password/test/*.ts` lists exactly `PasswordCredential.test.ts` and `PasswordRecovery.test.ts`.
- [ ] `PasswordCredentialSql.test.ts` (S1, S2, S3) passes on SQLite and is listed in `scripts/test-pg.sh`; `pnpm test:pg` passes.
- [ ] The `StoreContract.accounts` case "insertIfAbsent that loses a race inside an enclosing transaction leaves it usable" passes on every runner.
- [ ] `15-password.feature` has the REQ-EA-1307 scenario and `pnpm test:bdd` passes, including "Response latency does not vary across the three failure reasons".
- [ ] ADR-EA-048 exists and is indexed. ADR-EA-040 has rev 1.1. BEH-EA-345 exists. BEH-EA-114/116/117/119/120/206/221/053 and the glossary carry Document Control bumps. `pnpm spec:verify:strict` passes.
- [ ] Changesets C1-C4 exist with their `Migration:` text.
- [ ] `pnpm check` passes.

---

## 10. Open questions only the user can answer

1. **Q1. `AdminAccounts` depends on `Password` as a whole, or split `setUserPassword` out?**
   - Context: `dependsOn: [Password]` makes `deleteUser`/`setUserEmail` require the password plugin too. The alternative is a new `AdminCredentials` plugin (same path `POST /admin/users/:userId/password`, new group id) that alone depends on `Password`.
   - **Recommended: depend as a whole.** `setUserEmail` already needs Password's `POST /change-email/confirm` to complete (`AdminAccounts.ts:13-17`), no shipped or example composition uses `AdminAccounts` without `Password`, and the split adds a plugin and a group for a deployment shape nobody has.
2. **Q2. Remove `AdminConfig.passwordPolicy` entirely, or keep it as an *extra* administrator-only rule on top of the one policy?**
   - **Recommended: remove.** Only a test uses a custom one (`AdminAccounts.test.ts:456`); keeping it reintroduces a second policy surface; per-tenant `Password.config` covers stricter needs.
   - Do you know of a host that sets it?
3. **Q3. `seed admin --password` over an account that already has a password.**
   - Today it is silently kept (the operator's password is dropped). The options are replace (`set`), refuse with a usage error, or keep.
   - **Recommended: replace, and publish `auth.password.changed`** (as `AdminAccounts` does), with no session revocation. This matches BEH-EA-206's stated intent that the seeded administrator can sign in with the password the operator set.
   - If you want the seeded account's sessions revoked too, say so (reason `admin`).
4. **Q4. Make `changePassword` one unit of work in this plan (ticket 10), or defer it?**
   - **Recommended: in this plan.** It is the same crash-window class ARF-001 closed for reset, and `replace` is designed to run inside a unit.
5. **Q5. Should an administrator's set follow `breachCheck.onUnavailable` like every other path, or fail closed regardless?**
   - **Recommended: follow it.** One policy means one posture; a deployment that wants fail-closed sets `{ onUnavailable: "reject" }` for everyone.
6. **Q6. Accept the KDF inside admin's transaction (R3), or add a pre-hash step so admin keeps hashing before it opens?**
   - **Recommended: accept.** The path is rare and gated, and the interface stays smaller. Revisit only with a measured pool problem.
7. **Q7. Should the importers' literal `"password"` become the constant, and the seam test forbid the literal (ticket 14)?**
   - **Recommended: yes.** It is cheap and closes a spelling-drift hole.
8. **Q8. Password sign-in lockout on failed verifications (a plan 06 failure rule charging on `Refused`)?**
   - **Recommended: not in this plan.** The verdict makes it a one-line follow-up if you want it.
9. **Q9. `seed admin` with a password against an application that has no Password plugin.**
   - Today it hashes through `PasswordHasher` and links a credential nobody can sign in with.
   - **Recommended: refuse with `ApplicationUnavailable` (exit 9)** naming the Password plugin.
   - The alternative, keeping a raw hash path in the CLI, would be a second, policy-free writer.

---

## Decisions taken (implementation record)

### Wave 0: ticket 04, PR #50 (merged 2026-11-08)

- Shipped: six sites (not the plan's five) pass `StoreUnavailable` through instead of `orDie`: the `findCredentialHash` reads of `changePassword` and `reauthenticate`, the `updateCredentialHash` writes of `changePassword` and `confirmReset`, `AdminAccounts.setUserPassword`'s transaction (`catchTag("SqlError", …)` as in `UserImport`, not the plan's `catchIf(isSqlError, …)`), and `awthaq seed admin` (a racing `AccountAlreadyLinked` counts as done; an outage is the usage error, exit 2). A failed `confirmReset` keeps its token, proven on Postgres too. ADR-EA-028 rev 1.8.
- No open question applied to ticket 04.
- Not fixed (outside the ticket): `Seed.ts` `verifyEmail(...).pipe(Effect.orDie)` still turns an outage into a defect.
- Renumbered: this plan's new behaviour is BEH-EA-345, not 340 (340–344 were taken by plans 15, 21 and 20 before batch 3 landed).

### Wave E: tickets 01–03, 05–11 (branch `feat/password-credential`, on `main` @ `0229a228`)

**Ticket 01, baseline re-taken on `0229a228`** (plans 25 and 26 merged; plan 26's `Api.AuthRequestContext` had already removed `ip`/`userAgent` from `PasswordShape` and the `ClientAddress` port from `Password.layer`, so §3.5's sketches apply without request facts):

| Measure (§2.2) | Plan (`ede063d8`) | `0229a228` |
|---|---:|---:|
| `Password.ts` lines | 1,780 | **1,561** (plan 26 shrank it; G7's "≤ 1,590" was met before this wave) |
| password `src` / `test` lines | 2,195 / 4,163 | 1,978 / 4,268 |
| `Password.ts` source commits (non-merge) | 71 | 78 (still the most churned; `OAuth.ts`, `Passkey.ts` 61) |
| `PASSWORD_PROVIDER_ID` (library src, by file) | 12 | `Password.ts` 6, `AdminAccounts.ts` 2, `Seed.ts` 2, `ImportAuth0User.ts` 1, `Accounts.ts` 1, `sql/Models.ts` 1 (comment) |
| `.findCredentialHash(` / `.updateCredentialHash(` | 3 / 4 | 3 / 4 (`Password.ts` 3+3, `AdminAccounts.ts` 0+1) |
| `hasher.(hash\|verify\|needsRehash)(` | 10 (+2) | `Password.ts` 8, `AdminAccounts.ts` 1, `Seed.ts` 1 (+ `SecondFactor.ts` 2) |
| literal `providerId: "password"` | 2 | 2 |
| policies | 3 | 3 (`checkPolicy`; `AdminGate`'s `passwordPolicy`/`defaultPasswordHints`, read per tenant as `cleared.config.passwordPolicy` (§8.1, batch-2 plan 13 is on `main`); `Seed.MIN_PASSWORD_LENGTH`) |
| "same uniform-cost shape" comments | 2 | 2 |
| `orDie` in `Password.ts` | 5 | 1 (ticket 04 removed four; the identifier digest remains) |
| §5.4 grep on `Password.ts` | 39 | 39 |
| files testing `onUnavailable` / `signInTimingFloor` | 3 / 2 | 3 / 2 |
| tests: `@awthaq/password` / `admin` / `cli` | n/a | 146 (15 files, 3.0 s) / 202 (2.7 s) / 120 + 1 skipped (2.6 s) |
| `it(` per password test file | n/a | `Password.test.ts` 49, `AuthHttp` 28, `PasswordChangeEmail` 12, `PasswordPolicy` 9, `PasswordStoreOutage` 5, `PasswordRecovery` 5, `PasswordTenantConfig` 5, `PasswordMail` 5, `PasswordRateLimitBehaviour` 4, `PasswordHooksBeforeCredentialReset` 4, `PasswordConfigAudit` 3, `PasswordNoCredential` 2, one each `AuthComposition`, `Contract`, `PasswordHooksSignUp` |

**Ticket 02, spike: settled in place, no fallback.** `exposes: { services: [PasswordCredential.PasswordCredential], layer: PasswordCredential.PasswordCredential.layer }` compiles without `as const`. `const verify: PasswordCredentialShape["verify"] = (claimant, candidate) => …` infers generically (no `function` declaration needed). `Brand.nominal` over object intersections works for `Proof` and `Accepted`. `PasswordCredential.types.test.ts` holds the five properties: a test plugin `Steward` (`dependsOn: [Password]`, requires the module) composes with `Password` and is refused without it, a `Stowaway` that requires it without `dependsOn` is refused, `Proof`/`Accepted` cannot be forged and `linkFor`/`set`/`replace` refuse a raw `Redacted`, `verify` takes `users.findByEmail(...)` and `Effect.succeedSome({ id })`, and `makeTestLayer()` provides the module. Property 2 uses a test plugin, not `AdminAccounts` (that is ticket 12's `AuthComposition.test.ts` case). Hosts whose layer type is emitted must name the exposed service: both examples gained `export type PasswordServices = PasswordCredential.PasswordCredential` (TS2883 otherwise), as they do for Organization's.

**Ticket 03, red tests.** The four ADR-EA-028 cases shipped green with ticket 04. Seed "replace an existing credential" was written and seen red for the stated reason (`the operator's second password was dropped: expected false to be true`); it is kept, uncommitted, as `.scratch/27-password-credential/ticket-03-red-seed-replace.patch` (in this worktree) for ticket 13 (apply with `git apply`; note it re-seeds with `force: true`). The admin policy cases (breached → `AdminWeakPassword ["appears in known breaches"]`; `Password.config({ minLength: 16 })` refuses 12 characters) cannot be written red today: `@awthaq/admin` has no `@awthaq/password` dependency to compose `Password.config` with, so they are red by construction and land with ticket 12. The breached seeded password case needs `PasswordCredential` in `SqlApp`, so it also lands with ticket 13.

**Shipped (tickets 05–11).**
- 05 `PasswordConfig.ts` (verbatim; re-exported from `Password.ts`).
- 06 `PasswordCredential` with `verify`/`rehashIfStale`, exposed; `signIn` through it; V1–V7, F1–F5 (F5 with the clock-advancing hasher, no fallback), R1–R4 (R1/R2 keep the real argon2 parameter checks).
- 07 `changePassword`/`reauthenticate` verify through it; the dummy, calibration and floor leave `Password.ts`; `PasswordNoCredential.test.ts` deleted.
- 08 `accept`/`linkFor`; `checkPolicy`/`isBreached` moved verbatim as private `policyHints`; P1–P11 (the unavailable modes as one table, 10 cases) and W6; `PasswordPolicy.test.ts` deleted, FAMS-003 moved to `Password.test.ts`.
- 09 `replace`, `has` and the shared `write`; `confirmReset`, `requestReset` through them; W3, W4/W7, W5, W8; "a well-formed reset token for no live row costs no password hash" in `PasswordRecovery.test.ts`.
- 10 `changePassword` is one `SqlTransaction` unit (`SqlError` → `StoreUnavailable("Password.changePassword")`); S3 in the new `PasswordCredentialSql.test.ts` (seen red first: the old password no longer signed in).
- 11 `set`; W1, W2 (W7 and W8 extended to `set`); S1, S2; `StoreContract.accounts` "insertIfAbsent that loses a race inside an enclosing transaction leaves it usable" (Ref, SQLite, WAL file, libSQL; Postgres in CI); `PasswordCredentialSql.test.ts` in `scripts/test-pg.sh`. Changeset C2 (`password-credential-module.md`) is complete for these tickets.

**After the wave.** `Password.ts` 1,208 lines (§5.4 grep 0, `orDie` 1); `PasswordCredential.ts` 381. `findCredentialHash`/`updateCredentialHash` in library source: `PasswordCredential.ts` plus `AdminAccounts.ts`'s one update (ticket 12). Files testing `onUnavailable`: `PasswordCredential.test.ts`, `PasswordRecovery.test.ts`. `signInTimingFloor` appears in `PasswordCredential.test.ts`, `PasswordTenantConfig.test.ts` and `PasswordCredentialSql.test.ts` (the last only sets `"off"`). Password tests 146 → 174.

**Deviations.**
- `Proof.hash` is `Redacted<PhcHash>` (the stored value as read), not a bare `PhcHash`; `rehashIfStale` unwraps it for `needsRehash`.
- `confirmReset`: §8.1's choice for batch-2's redeemer. `beforeClaim` answers `void`, so `accept` runs there and hands its `Accepted` to `use` through a `Deferred` (`Deferred.await` inside `use`; the redeemer always runs `beforeClaim` first). Chosen over widening core's `VerificationLink.redeemer` (an overloaded `beforeClaim: Effect<B>`/`use(link, b)` needs either a cast or a rewrite of the returned generic arrow; not worth a core change for one caller). Typed, no defect path.
- `StoreContract`'s `AccountCase` now requires `SqlTransaction` (as `UserCase` does), so the `Ref` runner provides `SqlTransaction.layerNoop`; changeset line for `@awthaq/test`.
- `Password.layer` keeps `PasswordHasher` in `ports` although `make` no longer reads it (the exposed layer does; it joins `RIn` through `exposes.layer`, §3.5).
- `requestReset` asks `has` only after the `to`-address check, as before (an address-less user gets no mail either way).
- `scripts/test-pg.sh` gained the suite, but `pnpm test:pg` was not run locally (no Postgres; see below).

**Only Postgres CI proves:** S1 under READ COMMITTED (both `set`s see no account, one `insertIfAbsent` loses `ON CONFLICT DO NOTHING` and re-reads to an update); S2's and S3's rollback on a real Postgres transaction; the new `StoreContract.accounts` case (a refused insert does not abort the enclosing Postgres transaction, the property `set`'s retry relies on).

**Open questions applied.** Q4 (changePassword one unit): in this plan, ticket 10. Q1, Q2, Q3, Q5, Q6, Q9 are for tickets 12–13; nothing in 05–11 depends on them. Q6's regression (KDF inside the unit) now also covers `changePassword`'s new unit (R3).

**For tickets 12–18.** `AdminAccounts` reads the policy via `AdminGate` (`cleared.config.passwordPolicy`, `internal/AdminGate.ts:107, :146, :161`) and writes through `AccountStore` (not `Accounts`) inside its own `SqlTransaction`; ticket 12 deletes `passwordPolicy` from the gate's config. `PasswordCredential.set` takes only an `Accepted` from `credential.accept`, which fails `PasswordApi.WeakPassword`. The React BDD `useInvalidate` scenario fails on this base with or without these changes (re-run alone, three times).

### Wave F: tickets 12–18 (branch `feat/password-credential`, draft PR #59)

**Shipped.**
- 12 `d0e8f8e7` `AdminAccounts` lists `Password` in `dependsOn`; `setUserPassword` is `credential.accept` before the transaction (`WeakPassword` → `AdminWeakPassword`, same hints) and `credential.set` inside it, beside the `BeforeCredentialReset` veto and `revokeAll`. `PasswordHasher` left its `ports`; `passwordPolicy`/`defaultPasswordHints` left `AdminGate`; the payload ceiling is `PasswordApi.MAX_PASSWORD_LENGTH`. Tests (seen red: the set went through): a breached password, `Password.config({ minLength: 16 })`, a tenant's `Password.config`; `AuthComposition.test.ts` refuses `[Admin, AdminAccounts]` with `@ts-expect-error`; "a host policy replaces the default" deleted. Changeset C3.
- 13 `1be1af12` `seed admin`: `accept` first (a refusal is `UsageError`, exit 2, with the hints), `set` after the create or promote, `auth.password.changed` published; `MIN_PASSWORD_LENGTH` and the hasher/accounts lookups gone; `@awthaq/password` moved from dev to runtime dependencies. `SqlApp` composes `PasswordCredential.layer` over `TestAuth.httpClient.noBreach` (option `httpClient`), plus `sqlAppWithoutPassword`. Tests: ticket 03's replace (applied from the saved patch, seen red), breached exits 2 writing nothing, no Password plugin exits 9 writing nothing (both seen red). Changeset C4.
- 14 `cdd68082` both importers name `Accounts.PASSWORD_PROVIDER_ID`.
- 15 `0398a726` `PasswordCredentialSeams.test.ts`; fails on a planted `accounts.findCredentialHash(` in `Password.ts` (checked, reverted).
- 16 `0e5fd5cf` ADR-EA-048 and BEH-EA-345 (both the next free ids on this base), §6.1–§6.3.
- 17 `60559598` REQ-EA-1502 under BEH-EA-120, over the real admin route; seen to fail without the breach corpus.
- 18 `f75825fa` READMEs (password: "The password credential"; admin; cli: "Seeding an administrator"); changesets C2 and C3 name TS2883 and `export type PasswordServices = PasswordCredential.PasswordCredential`.

**Deviations.**
- Ticket 12 also touched what plan 13-admin-gate left on the admin policy: the tenancy BDD scenario REQ-EA-1308 ("a tenant's administration configuration supplies its own password policy") now sets the tenant's `Password.config({ minLength: 40 })` and is retitled "A tenant's Password configuration governs a password an administrator sets"; `AdminGate.test.ts`'s BEH-EA-236 per-operation test lost its `passwordPolicy` leg (the tenant case lives in `AdminAccounts.test.ts`). Every admin composition with `AdminAccounts` (`AdminAccountsHttp`, `AdminGate`, `Contract`, the tenancy world) now adds `Password` and a breach transport.
- `setUserPassword` keeps the plan 13 gate (`gate.user`), not §3.5's `authorize`. The old `AccountNotFound` → `AdminTargetNotFound` and `AccountAlreadyLinked` → defect mappings are gone: `set` re-reads, three lost races are `StoreUnavailable`.
- Seed: because `accept` runs first, a password given to an application without the Password plugin is exit 9 before the Roles check. `verifyEmail(...).pipe(Effect.orDie)` (Wave 0's leftover) is untouched.
- Ticket 14 also changed `StoreContract.accounts`' lost-race case (ticket 11) from the literal `providerId: "password"` to a neutral provider: the property is per `(providerId, subject)`, and the seam test forbids the literal in `packages/*/src`. Firebase's own `"password"` provider id (skipped by the import) stays, with a comment.
- Seam counts: `PasswordCredential.ts` names `PASSWORD_PROVIDER_ID` 5 times, calls the hasher 7 times and the hash reads/writes 3 times; `sql/src/Models.ts`'s mention is a comment and is stripped.
- Ticket 16: the ADR file is `spec/decisions/048-password-credential-module.md` (the plan said `043-…`). Revisions as found on this base: `15-password.md` 1.9, `27-admin-impersonation.md` 1.10, `26-cli.md` 1.6, `07-sessions.md` 1.11, `glossary.md` 1.14, `spec/README.md` 1.13 (catalog to 345), ADR-EA-040 1.1, `traceability.md` 1.71 (ticket 16) and 1.72 (ticket 17). The ADR row does not list BEH-EA-338 (federated identity; unrelated). The ADR is "Accepted — implemented" from the start (ticket 15 had landed).
- Ticket 17: REQ-EA-1502, not 1307 (1307 is plan 13's). The request goes over the real `POST /admin/users/:userId/password` with an administrator's session cookie; the corpus lists only the breached password, so the victim's own sign-up passes.

**Open questions applied (the plan's recommended defaults).** Q1: `AdminAccounts` depends on `Password` as a whole (no split plugin). Q2: `AdminConfig.passwordPolicy` removed, no administrator-only rule. Q3: `seed admin --password` replaces an existing credential and publishes `auth.password.changed`; no session revocation. Q5: the administrator's set follows `breachCheck.onUnavailable` like every path (it is the same `accept`; no special case). Q6: the KDF inside admin's transaction is accepted (no pre-hash step). Q9: a password without the Password plugin is `ApplicationUnavailable` (exit 9) naming it.

**Only Postgres CI proves** (Postgres was down locally; `pnpm test:pg` not run): S1–S3 and the `StoreContract.accounts` lost-race case on a real Postgres transaction (now with the neutral key). The administrator's `set` inside its `SqlTransaction` and `seed admin`'s replace run on memory and SQLite only; neither suite is in `test:pg`.

**Acceptance (§9).** Every grep target met: `passwordPolicy|defaultPasswordHints|MIN_PASSWORD_LENGTH` in `packages/*/src` is empty; `PasswordHasher` in `AdminAccounts.ts` is 0; `providerId: "password"` in `packages/*/src` is empty; the seam test passes. `pnpm test:pg` is CI's.

**Gate.** `pnpm check` (under the shared lock) passes at `f75825fa`: unit 5,812 passed, 1 expected fail, 16 skipped; BDD 1,552 passed, 44 skipped (the React `useInvalidate` flake did not reproduce); `spec:verify:strict` 32/32.
