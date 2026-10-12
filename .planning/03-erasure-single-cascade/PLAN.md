# 03 — Erasure is the only way to delete a User

> **Cross-plan reconciliation (orchestrator):** plan 03 lands first and adds `Users.createWith` (abandon-on-failure creation). Plan 01's `SignUp.createWith` is built on that primitive, and SCIM provisioning moves from it to `SignUp` in plan 01. See `.planning/README.md`.


> Strength: **Strong** · Dependency category: **in-process** · Wave **A** (lands before 01 and 02)
> Fixes live bugs: SCIM `erase` skips the ADR-EA-031 cascade (GDPR Art. 17 gap, organization seat
> leak, a SAML sign-in that dies for a re-provisioned user); `BeforeUserDelete` runs twice per erasure;
> self/admin erasure leaves the user's SCIM mapping (directory `userName`, usually the email) behind.
> Ticket slug when work starts: `.scratch/erasure-single-cascade/issues/NN-*.md`.

---

## 1. Summary, goals, non-goals

### Summary

Today the `Users` module has a public `delete` that removes one row and consults the
`BeforeUserDelete` veto (`packages/core/src/Users.ts:332-340`, implementations `:799-805` and
`:1195-1199`). Its own doc pushes the cascade onto "the caller that also calls `Users.delete`"
(`Users.ts:548`). `AccountErasure.eraseAccount` (`packages/core/src/Erasure.ts:112-143`) is the one
caller that does the whole job. SCIM's `deleteUser` in `erase` mode (`packages/scim/src/Scim.ts:884-906`)
is a second caller that does only a slice of it.

This plan makes the deep module the only way in. `Users` loses `delete`. The row deletion becomes a
store primitive, `UserRemoval.remove`, which needs an `ErasureClearance`. Only `AccountErasure` can
mint one, and it does so only after the veto has passed. SCIM `erase` goes through `eraseAccount`
with a new `Directory` initiator. SCIM adds an erasure contribution (and a matching export
contribution) for its own `scim_resource` rows. The veto runs exactly once, because nothing else
consults it any more.

### Goals

1. **G1 — one cascade.** Every deletion of a committed user runs `AccountErasure.eraseAccount`:
   registry contributions, accounts, sessions, verification tokens, the user row and audit
   pseudonymization, in one `SqlTransaction`, followed by `auth.user.deleted`.
2. **G2 — misuse does not compile.** Outside `@awthaq/core`, no code can delete a user row without
   `AccountErasure`. Calling `users.delete(...)` is a compile error. So is calling
   `UserRemoval.remove(...)` without a clearance, or forging a clearance. No `as` anywhere.
3. **G3 — the veto runs once.** `Hooks.BeforeUserDelete` is consulted once per erasure, before
   anything is touched. Erasure.ts no longer tells tap authors to be idempotent "because it runs
   twice" (`Erasure.ts:23-24`).
4. **G4 — directory erasure is attributed.** `eraseAccount` takes a required, tagged
   `ErasureInitiator` (`Self` | `Admin` | `Directory`). `auth.user.deleted` gains
   `deletedBy: "directory"` and the initiator's ids.
5. **G5 — SCIM keeps its contract.** BEH-EA-250 still holds: a veto is `403` with nothing touched
   (P20a), the external id is free again afterwards, and `auth.scim.userDeleted` is still published.
6. **G6 — SCIM rows take part in erasure and export.** Self and admin erasure also remove the user's
   `scim_resource` rows. The data-subject export lists them (ADR-EA-031 §5: export mirrors erasure).

### Non-goals

- Not redesigning `UserStore`/persistence. Plan 02 owns that. This plan adds a narrow
  `UserRemoval` store primitive that 02 folds into `UserStore`.
- Not routing SCIM `createUser` through a core `SignUp`. Plan 01 owns that. This plan only replaces
  the compensating `users.delete` in SCIM's rollback.
- Not changing SCIM `deactivate` mode (`applyActive(false)`, `Scim.ts:610-628`). It is suspension,
  not deletion, and stays as it is.
- Not changing the audit actor of `auth.user.deleted` (it stays the erased `userId`; see §3.6).
- Not sealing `@awthaq/sql`'s `Repositories.UsersRepository.delete` (`packages/sql/src/Repositories.ts:267`).
  That is persistence-stratum work for plan 02 (see §7, R7).
- Not fixing the other erasure gaps found while verifying (api-key, saml; see §10). They are recorded
  for a follow-up.
- Not changing self-service delete's `HookAborted → die` (500) mapping
  (`packages/server/src/Account.ts:117-120`). Recorded for plan 10.

---

## 2. Verified current state

All line numbers were checked against the working tree on 2026-10-13.

### 2.1 The two modules and their seam

| Fact | Evidence |
|---|---|
| `UsersShape.delete` is public: "consults `Hooks.BeforeUserDelete` … after the existence check, before the row is actually removed" | `packages/core/src/Users.ts:332-340` |
| The `Users` module puts the cascade on callers: "cascading to `Accounts`/`Sessions` is each of those services' own responsibility, triggered by the caller that also calls `Users.delete`" | `Users.ts:548` |
| Memory `delete_`: `findById` → `beforeUserDeleteVeto(beforeDelete.run(...))` → unindex → drop held fields | `Users.ts:799-805` |
| SQL `delete_`: `findById` → veto → `repo.delete(id)` | `Users.ts:1195-1199` |
| Both layers need the veto point: `layerMemory: Layer<Users, never, Crypto \| Hooks.BeforeUserDelete>`, `layerSql: Layer<Users, never, UsersRepository \| Hooks.BeforeUserDelete>` | `Users.ts:550`, `Users.ts:952-956` |
| Helpers that exist only for `delete`: `beforeUserDeleteVeto` and `deleteHookInput` | `Users.ts:39`, `Users.ts:468-473` |
| `eraseAccount(userId, options?: { deletedBy?: "self" \| "admin" })` | `packages/core/src/Erasure.ts:88-91` |
| The veto runs first (`:117-120`), then inside the transaction `users.delete` (`:131`) runs it **again** | `Erasure.ts:118`, `Erasure.ts:131` → `Users.ts:802` / `:1197` |
| The header accepts the double run: "`Users.delete` consults the point again at the end; a veto tap must therefore be idempotent" | `Erasure.ts:20-24` |
| A test pins the double run: "a veto raised late, inside Users.delete, undoes …" asserts `probe.consults === 2` | `packages/core/test/AccountErasure.test.ts:367-385` |
| `auth.user.deleted` schema: `deletedBy: Schema.Literals(["self", "admin"])` | `packages/core/src/AuthEventSchemas.ts:108-112` |
| Audit actor of `auth.user.deleted` is `event.userId` | `packages/core/src/AuditLog.ts:169` (in the `actorOf` switch at `:162-249`) |
| SCIM events have no audit actor ("a directory acts, not a user") | `AuditLog.ts:246-251` |
| Webhooks derive publishable tags from `AuthEventSchema.members[*].fields._tag`, so every union member must stay a `TaggedStruct` | `packages/webhooks/src/WebhookPayload.ts:151-156` |
| `BeforeUserDelete` input: `{ id: string; email?: string }` | `packages/core/src/Hooks.ts:115-124` |
| `ErasureSubject` is `{ userId; email? }`. The erasure registry is provided by `Hooks.HooksLive` | `packages/core/src/ErasureRegistry.ts:18-21`, `Hooks.ts:170-186` |

### 2.2 Every caller of `users.delete` / `Users.delete`

Search: `grep -rnE "users\.delete|Users\)\.delete|\.delete\(" packages examples features tools` with
user-scoped matches only (`credentials.delete`, `secrets.delete`, `claims.delete` and HTTP
`HttpApiEndpoint.delete` are other modules). `migrate-*`, `cli`, `client`, `react`, `web`,
`examples` and `Retention`/`UserImport` contain **no** caller.

| # | Caller | file:line | Kind | What it runs today | Target in this plan |
|---|---|---|---|---|---|
| C1 | `AccountErasure.eraseAccount` | `packages/core/src/Erasure.ts:131` | the cascade itself | full ADR-EA-031 cascade, veto twice | `removal.remove(clearance)`; veto once (Phase 2) |
| C2 | SCIM `deleteUser`, `erase` mode | `packages/scim/src/Scim.ts:890` | domain deletion | user row (veto inside) → `sessions.revokeAll` → `records.unlink` (this connection only) → `auth.scim.userDeleted` | `erasure.eraseAccount(id, ErasureInitiator.Directory(…))` then `auth.scim.userDeleted` (Phase 1) |
| C3 | SCIM `createUser` rollback | `packages/scim/src/Scim.ts:740-743` | compensation for a half-made provisioning | `records.unlink` then user row (veto inside), all errors swallowed | `users.createWith(input, complete)`: abandon-on-failure creation, no veto, no cascade (Phase 2). **Not** `eraseAccount`, see §3.5 |
| C4 | `Users.test.ts` not-found contract | `packages/core/test/Users.test.ts:142` | test | `delete(missing)` flips `UserNotFound` | `UserRemoval.remove(clearanceFor(missing))` flips `UserNotFound` |
| C5 | `UserFields.test.ts` "a deleted user's fields do not resurrect on a re-created id" | `packages/core/test/UserFields.test.ts:364-376` | test | `delete` drops held fields | same assertion through `UserRemoval.remove` |
| C6 | `HooksWiringMemory.test.ts` | `packages/core/test/HooksWiringMemory.test.ts:35` | test of "Users consults the veto" | the behaviour being removed | **delete file**; replaced by AccountErasure "veto once" |
| C7 | `HooksWiringSql.test.ts` | `packages/core/test/HooksWiringSql.test.ts:46` | same, SQL | same | **delete file** |
| C8 | Passkey "WPS-001: a credential surviving its own deleted user cannot mint a session for that dead user" | `packages/passkey/test/Passkey.test.ts:233-276` | test, deliberate orphan | user row only | orphan via `AccountErasure` over a fresh, empty `ErasureRegistry` (§5.3) |
| C9 | Device "a user deleted after approving leaves an unredeemable grant: invalid_grant, and the row is dropped" | `packages/device-authorization/test/DeviceAuthorization.test.ts:656-666` | test, deliberate orphan | user row only | same orphaning erasure |
| C10 | qadi "a deleted user's subject resolves to undefined, not a failure" | `packages/qadi/test/Resolvers.test.ts:63-75` | test | user row only | a never-created id (observably the same) |
| C11 | BDD BEH-EA-095 step "{string} taps {string} to purge its own {string} rows for that user" | `features/step-definitions/HooksSteps.ts:634-639` | BDD | user row (veto once) | `AccountErasure.eraseAccount(id, ErasureInitiator.Self())` |

Indirect callers of the cascade (they change only because `eraseAccount`'s signature changes):

| Caller | file:line | Today | Target |
|---|---|---|---|
| Self-service `DELETE /user` | `packages/server/src/Account.ts:116` | `{ deletedBy: "self" }` | `ErasureInitiator.Self()` |
| `AdminAccounts.deleteUser` | `packages/admin/src/AdminAccounts.ts:208-215` | `{ deletedBy: "admin" }` | `ErasureInitiator.Admin({ adminUserId: Users.UserId(caller.ref.id) })` |
| BDD "{string}'s account is erased" | `features/step-definitions/TwoFactorSecuritySteps.ts:132-137` | no options (defaults to "self") | `ErasureInitiator.Self()` |
| BDD organization erasure step | `features/step-definitions/OrganizationSteps.ts:676-685` | no options | `ErasureInitiator.Self()` |
| `AccountErasure.test.ts` | `:206`, `:229` | `{ deletedBy: "admin" }` | `ErasureInitiator.Admin({ adminUserId })`, and assert `adminUserId` |
| `AdminAccounts.test.ts` | `packages/admin/test/AdminAccounts.test.ts:249` | asserts `deletedBy === "admin"` | also asserts `adminUserId` |

Compositions that build `Users` layers (they compile unchanged once `UserRemoval` rides on the same
layer): `packages/test/src/TestAuth.ts:130-147`/`:178`, `examples/sql-server/app.ts:110-119`/`:143`, and
roughly 40 test files that provide `Users.layerMemory`/`layerSql`. Two **doubles** of `Users` are
typed `typeof Users.layerMemory` and must change from `Layer.provide` to `Layer.provideMerge`:
`packages/scim/test/ScimHttp.test.ts:371-382` and `features/step-definitions/ScimWorld.ts:41-52`. (In
Effect v4, `provideMerge` is `Context.merge(that, self)`, so the double's `Users` wins: `../effect/packages/effect/src/Layer.ts:1609-1617`,
`Context.ts:1164-1171`.)

### 2.3 AccountErasure vs SCIM `erase`, step by step

| # | Step | `AccountErasure.eraseAccount` (`Erasure.ts:112-143`) | SCIM `deleteUser` erase (`Scim.ts:884-906`) | Consequence of the gap |
|---|---|---|---|---|
| 1 | Resolve | `users.findById` → `UserNotFound` | `ownedUser` (`:570-582`): link, then `findById`; a stale link is dropped and the result is `404` | — |
| 2 | Veto | `BeforeUserDelete` before anything (`:118-120`), **then again** inside `users.delete` (`:131`) | only inside `users.delete` (`:890`), first write (P20a) | double veto; taps must be idempotent |
| 3 | Transaction | one `SqlTransaction.withTransaction` (`:122-136`) | none | partial erasure on failure |
| 4 | Plugin contributions | every `ErasureRegistry` contribution (`:121-127`): organization, passkey, roles, claims, two-factor, webhooks, device-authorization | **none** | memberships, team memberships, active context, invitations, passkeys and handles, role assignments, claims, 2FA secrets and codes, webhook deliveries and device grants all survive the user. The organization's `maximumMembers` seat stays taken by a ghost |
| 5 | Accounts | `accounts.deleteAllByUser` (`:128`) | **none** | linked accounts survive. After a SCIM erase and re-provision, SAML sign-in finds the stale link (`packages/saml/src/Saml.ts:949-956`) and then `users.findById(targetUserId).pipe(Effect.orDie, …)` (`Saml.ts:1025-1027`) **dies**: every SAML sign-in for that NameID becomes a 500 |
| 6 | Sessions | `revokeAll(userId, "userDeleted")` inside the transaction (`:129`) | after the row is gone, outside any transaction (`:897`) | — |
| 7 | Verification tokens | `deleteAllByUser` (`:130`) | **none** | pending tokens survive (identifier rows can hold the address) |
| 8 | User row | `users.delete` (`:131`) | `users.delete` (`:890`) | — |
| 9 | SCIM mapping | — (no SCIM contribution exists) | `records.unlink(connection.id, "User", id)` (`:898`) | self/admin erasure leaves `scim_resource` rows. `name` holds the directory `userName`, usually the email (`ScimRecords.ts:48-58`) |
| 10 | Audit | `pseudonymizeActor` unless `ErasureConfig.auditLog: "retain"` (`:133`) | **none** | the audit trail keeps naming the person |
| 11 | Events | `auth.user.deleted` after commit (`:137-142`) | `auth.scim.userDeleted` only (`:899-904`) | `auth.user.deleted` subscribers (webhooks: ADR-EA-030, BEH-EA-282) never learn of directory deletions |
| 12 | Errors | `UserNotFound \| HookAborted \| StoreUnavailable`; `SqlError` dies | `UserNotFound` is swallowed: it goes on to revoke, unlink and publish `userDeleted` for a deletion it did not do. `HookAborted` → `403` | — |

The `Scim.ts:24-25` header says erase runs "the `BeforeUserDelete` erasure taps". That is true only of
the veto. Since ADR-EA-031, erasure is a registry and not a set of taps, so the claim is stale.
`spec/behaviors/30-scim.md:100-107` (BEH-EA-250), `spec/models/12-scim.md:62`,
`spec/decisions/023-enterprise-federation-packages.md:45` and `packages/scim/README.md:29` all repeat
"`Users.delete`".

### 2.4 Other surfaces checked

- **Admin delete** (`AdminAccounts.ts:201-222`) already uses `eraseAccount` and then publishes
  `auth.admin.userDeleted`. The SCIM fix copies this pattern: the core cascade first, then the
  plugin's own event naming who did it.
- **SCIM deactivate** (`Scim.ts:610-628`, `:907`) is `setStatus("suspended")` + `revokeAll("suspended")`
  + `auth.scim.userDeactivated`. It is unaffected.
- **DataExport** (`DataExport.ts`, `DataExportRegistry.ts:74-90`) has no SCIM section. This plan adds
  `scimExport`.
- **Retention** (`Retention.ts`) purges sessions, tokens and audit rows by age and never deletes users.
  It is unaffected.
- **Plugins with tables but no erasure contribution:** `scim` (fixed here), `api-key`
  (`apikey_key."ownerId"` / `ApiKeyClientRecords.ownerId: Users.UserId`, `ApiKeyClientRecords.ts:24`),
  `saml` (`saml_session."nameId"`, `Saml.ts:262-289`), `jwt` (key ids; ADR-EA-031 §4 says not personal)
  and `admin` (ledger retained by decision). `docs/plugin-authoring.md:72` says "every table keyed by a
  user id needs one". api-key and saml are out of scope (§10, Q9).

---

## 3. Target design

### 3.1 Module map after the change

```
                         ┌──────────────────────────────────────────────┐
  server  DELETE /user ──┤                                              │
  admin   deleteUser   ──┤  Erasure.AccountErasure.eraseAccount(        │
  scim    DELETE erase ──┤      userId, initiator: ErasureInitiator)    │  ← the only interface that
  (CLI/retention later) ─┤                                              │    deletes a committed user
                         └───┬──────────────────────────────────────────┘
                             │ veto once → mint ErasureClearance → one SqlTransaction
                             ▼
     ErasureRegistry contributions (organization, passkey, roles, claims, two-factor,
     webhooks, device-authorization, **scim**) → Accounts → Sessions → Verification
     → **UserRemoval.remove(clearance)** → AuditLog.pseudonymizeActor
                             │ after commit
                             ▼
     auth.user.deleted { userId, deletedBy, adminUserId? | connectionId? organizationId? }

  scim createUser ── Users.createWith(input, complete)   ← abandon-on-failure creation (no veto,
                                                           no cascade, nothing announced)
```

The depth gain: one interface (`eraseAccount`) hides the veto, the transaction, the registry, four
core stores, audit policy and the event. The `Users` interface gets smaller (it loses `delete`), and
the store primitive is no longer callable from outside.

### 3.2 The clearance (new, core-internal module)

`packages/core/src/internal/erasureClearance.ts`. It is not re-exported from `src/index.ts`. The
package `exports` map has only `"."` (`packages/core/package.json`), and the workspace `paths` map
`@awthaq/core` to `src/index.ts` only, so no other package can import this file.

```ts
// @awthaq/core — internal/erasureClearance
//
// ADR-EA-031 (rev 1.1): proof that `AccountErasure` consulted `Hooks.BeforeUserDelete` for one user
// and no tap vetoed. `UserRemoval.remove` takes nothing else, so the only way to delete a user row
// is to have passed the veto inside `AccountErasure`. Three locks, none an assertion:
//   - the ES-private field makes the class nominal: no object literal satisfies it;
//   - the constructor is private: `new` fails to compile outside the class;
//   - this module is not exported from the package barrel, and `Erasure.ts` re-exports the *type*
//     only, so code outside core cannot even reach `afterVeto`. Inside core,
//     `ErasureClearance.boundary.test.ts` pins `Erasure.ts` as the single value importer.
import type { Models as SqlModels } from "@awthaq/sql";
import * as Effect from "effect/Effect";

export class ErasureClearance {
  readonly #userId: SqlModels.UserId;

  private constructor(userId: SqlModels.UserId) {
    this.#userId = userId;
  }

  get userId() {
    return this.#userId;
  }

  /** The clearance for `userId`, issued only once `veto` has succeeded. */
  static afterVeto<E, R>(userId: SqlModels.UserId, veto: Effect.Effect<unknown, E, R>) {
    return veto.pipe(Effect.as(new ErasureClearance(userId)));
  }
}
```

The mechanism compared with the alternatives the brief listed:

| Mechanism | Misuse is a compile error? | Test doubles / future adapters can implement the primitive? | Survives plan 02 (store as a public port)? |
|---|---|---|---|
| Separate **internal service tag**, unexported | yes | **no**: a double of `Users` cannot provide a tag it cannot name, so every composition with a double loses `AccountErasure` | **no**: adapter authors must implement the primitive |
| **Non-exported module** holding a plain function | yes | no | no |
| **Capability token** (`ErasureClearance`) on a **public** `UserRemoval` tag | **yes** | **yes**: implementers receive a clearance, they never mint one | **yes**: becomes `UserStore.delete(clearance)` unchanged |

So: a public `UserRemoval` service whose single method needs a clearance minted only in core. This
is the "branded clearance type" the shared conventions prefer, combined with the "removed interface
member" (`UsersShape.delete`).

### 3.3 `Users` module (changed interface)

`packages/core/src/Users.ts`:

```ts
import type { ErasureClearance } from "./internal/erasureClearance.ts";

export interface UsersShape {
  // create, createOrGet, findById, findByEmail, findByPhone, updateProfile, verifyEmail,
  // verifyPhone, promoteIdentity, changeEmail, setStatus, list, getFields, setFields: unchanged.
  //
  // `delete` is REMOVED. A committed user is deleted only by `Erasure.AccountErasure.eraseAccount`.

  /**
   * Creates a user and runs `complete` with it. If `complete` fails, dies or is interrupted, the user
   * is abandoned: its row and declared fields are removed, no veto runs and nothing is announced,
   * because nobody outside this call has been told the user exists. This is how a multi-step
   * provisioning (SCIM `POST /Users`: create, link, add to the organization) leaves nothing behind.
   * It cannot remove any user it did not just create; for that, use `Erasure.AccountErasure`.
   */
  readonly createWith: <A, E, R>(
    input: CreateInput,
    complete: (user: UserRecord) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<
    { readonly user: UserRecord; readonly value: A },
    E | EmailAlreadyExists | PhoneAlreadyExists | StoreUnavailable,
    R
  >;
}

/**
 * ADR-EA-031: the user row's store primitive. Removes the row and its declared fields only: no veto,
 * no cascade, no event (`AccountErasure` owns those). The clearance can only be minted by
 * `AccountErasure` after the `BeforeUserDelete` veto passed, so nothing else can call this.
 * Plan 02 folds this into `UserStore.delete(clearance)`.
 */
export interface UserRemovalShape {
  readonly remove: (
    clearance: ErasureClearance,
  ) => Effect.Effect<void, UserNotFound | StoreUnavailable>;
}

export class UserRemoval extends Context.Service<UserRemoval, UserRemovalShape>()(
  "awthaq/core/UserRemoval",
) {}
```

Both layers provide both services from one build, so the row store is shared (`Layer.effectContext`,
`../effect/packages/effect/src/Layer.ts:1099`):

```ts
// The existing annotations are updated in place. They are pre-existing; add no new ones.
export const layerMemory: Layer.Layer<Users | UserRemoval, never, Crypto.Crypto> =
  Layer.effectContext(
    Effect.gen(function* () {
      // …state, crypto, announce, registry, heldFields exactly as today; `beforeDelete` is gone…

      /** The row and its declared fields. The only deleter, shared by `remove` and `createWith`. */
      const removeRow = (id: UserId) =>
        Effect.gen(function* () {
          const existing = yield* findById(id);
          yield* Ref.update(state, (s) => unindexRecord(s, existing));
          yield* Ref.update(heldFields, HashMap.remove(id));
        });

      const createWith: UsersShape["createWith"] = (input, complete) =>
        Effect.gen(function* () {
          const user = yield* create(input);
          const value = yield* complete(user).pipe(
            Effect.onError(() => removeRow(user.id).pipe(Effect.ignoreCause({ log: true }))),
          );
          return { user, value };
        });

      const users: UsersShape = { create, createOrGet, /* … */ createWith };
      const removal: UserRemovalShape = { remove: (clearance) => removeRow(clearance.userId) };
      return Context.make(Users, users).pipe(Context.add(UserRemoval, removal));
    }),
  );

export const layerSql: Layer.Layer<Users | UserRemoval, never, SqlRepositories.UsersRepository> =
  Layer.effectContext(/* same shape; removeRow = findById → repo.delete(id).pipe(orStoreUnavailable("UserRemoval.remove")) */);
```

If TypeScript does not infer the generic contextual signature of `createWith` from
`UsersShape["createWith"]`, write it as `function createWith<A, E, R>(input: CreateInput, complete: …)`.
Parameter annotations are fine. Never an `as`.

Deleted from `Users.ts`: `delete_` (both layers), `beforeUserDeleteVeto` (`:39`), `deleteHookInput`
(`:468-473`), the `Hooks.BeforeUserDelete` requirement and its `yield*` (`:556`, `:960`), the
`HookPoint` import if it becomes unused, and the BEH-EA-046 paragraph at `:548`. That paragraph is
replaced by: "Deleting a user is `Erasure.AccountErasure`'s job; this module holds the row store
(`UserRemoval`) it calls with a clearance."

### 3.4 `Erasure` module (changed interface)

`packages/core/src/Erasure.ts`:

```ts
import * as Data from "effect/Data";
import { ErasureClearance } from "./internal/erasureClearance.ts";
import { emailOf, UserRemoval, Users, type UserId, type UserNotFound } from "./Users.ts";

export type { ErasureClearance } from "./internal/erasureClearance.ts";

/** Who asked for the erasure. Required, so no caller is silently labelled "self". */
export type ErasureInitiator = Data.TaggedEnum<{
  /** The account holder (`DELETE /user`). */
  Self: {};
  /** An administrator (`AdminAccounts.deleteUser`). */
  Admin: { readonly adminUserId: UserId };
  /** A directory connection (`@awthaq/scim` `DELETE /Users/:id`, `deleteBehavior: "erase"`). */
  Directory: { readonly connectionId: string; readonly organizationId: string };
}>;
export const ErasureInitiator = Data.taggedEnum<ErasureInitiator>();
// (If the lint ever objects to `{}`, use `Record<never, never>`.)

export interface AccountErasureShape {
  /**
   * Erases `userId` everywhere (module header has the order). The `BeforeUserDelete` veto is
   * consulted exactly once, before anything is touched. Fails `UserNotFound` for an unknown user,
   * `HookAborted` when a tap vetoes, `StoreUnavailable` on a store outage; anything else dies and
   * rolls back.
   */
  readonly eraseAccount: (
    userId: UserId,
    initiator: ErasureInitiator,
  ) => Effect.Effect<void, UserNotFound | HookPoint.HookAborted | StoreUnavailable>;
}

/** The `deletedBy` half of `auth.user.deleted`, one case per initiator. */
const deletedByOf = (initiator: ErasureInitiator) => {
  switch (initiator._tag) {
    case "Self":
      return { deletedBy: "self" } as const;
    case "Admin":
      return { deletedBy: "admin", adminUserId: initiator.adminUserId } as const;
    case "Directory":
      return {
        deletedBy: "directory",
        connectionId: initiator.connectionId,
        organizationId: initiator.organizationId,
      } as const;
  }
};

export const layer = Layer.effect(
  AccountErasure,
  Effect.gen(function* () {
    const users = yield* Users;
    const removal = yield* UserRemoval;
    // accounts, sessions, verification, auditLog, events, registry, sqlTransaction, beforeDelete,
    // auditPolicy: as today

    const eraseAccount: AccountErasureShape["eraseAccount"] = (userId, initiator) =>
      Effect.gen(function* () {
        const user = yield* users.findById(userId);
        const email = Option.getOrUndefined(emailOf(user));
        const subject: ErasureSubject = { userId, email };
        // The one consult of the veto, before anything is touched. The clearance is its receipt.
        const clearance = yield* ErasureClearance.afterVeto(
          userId,
          HookPoint.aborted(Hooks.BeforeUserDelete)(
            beforeDelete.run({ id: userId, ...(email === undefined ? {} : { email }) }),
          ),
        );
        const contributions = yield* registry.contributions;
        yield* sqlTransaction
          .withTransaction(
            Effect.gen(function* () {
              for (const contribution of contributions) yield* contribution.erase(subject);
              yield* accounts.deleteAllByUser(userId);
              yield* sessions.revokeAll(userId, "userDeleted");
              yield* verification.deleteAllByUser(userId);
              yield* removal.remove(clearance);
              if (auditPolicy === "pseudonymize") yield* auditLog.pseudonymizeActor(userId);
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die));
        yield* events.publish({ _tag: "auth.user.deleted", userId, ...deletedByOf(initiator) });
      });

    return AccountErasure.of({ eraseAccount });
  }),
);
```

`Erasure.layer`'s requirements gain `UserRemoval`. Every composition gets it from the `Users` layer
it already provides. The module header (`Erasure.ts:16-31`) is rewritten: step 1 loses "`Users.delete`
consults the point again … must therefore be idempotent", step 2 names `UserRemoval.remove(clearance)`,
and a line notes that the clearance is the only way to remove a row.

`AccountErasure` remains a public, swappable service. A host can provide its own (for example a
remote-erasure queue), but outside core it can only delete user rows through `eraseAccount` of the
real layer, so a replacement must delegate. This is intended: the guarantee is that the cascade
cannot be skipped.

### 3.5 Why SCIM's rollback must not call `eraseAccount`

`organizationErasure` deletes "the invitations they sent or that were addressed to their email"
(`packages/organization/src/Organization.ts:1730-1747` → `InvitationRecords.removeAllForUser(userId, email)`,
`InvitationRecords.ts:231-241`). A SCIM `POST` that fails after `users.create` (membership limit, an
organization veto, a link race) would then delete pending invitations addressed to that email **in
every organization**, invitations that an administrator sent before the user existed. The rollback
would also publish an `auth.user.deleted` for a user nobody was ever told about, and the veto could
refuse it.

So abandoning an unfinished creation is a different act from erasure. `Users.createWith` captures
that: removing the row is only possible for the user this same call created, and the type gives
no handle to any other user. Plan 01 is expected to build `SignUp` on this primitive or replace it
(§8).

### 3.6 Event and audit shape

`packages/core/src/AuthEventSchemas.ts:103-112`:

```ts
/**
 * SCP-006: published once a user's erasure has committed (`Erasure.AccountErasure`, the only path).
 * No email (ESA-005). `deletedBy` names the initiator kind; the initiator's own ids ride along
 * (identifiers only, ADR-EA-029): `adminUserId` for "admin", `connectionId`/`organizationId` for
 * "directory". Rows written before these fields existed decode unchanged (all optional).
 */
export const UserDeletedEvent = Schema.TaggedStruct("auth.user.deleted", {
  userId: UserIdSchema,
  deletedBy: Schema.Literals(["self", "admin", "directory"]),
  adminUserId: Schema.optionalKey(UserIdSchema),
  connectionId: Schema.optionalKey(Schema.String),
  organizationId: Schema.optionalKey(Schema.String),
});
```

- It stays a single `TaggedStruct`, so `WebhookPayload.knownEventTags` (`member.fields._tag`) keeps
  working. A union of three structs under one tag would break it and would clash with plan 09.
  The link between `deletedBy` and its ids is enforced where the event is built, by the
  `ErasureInitiator` union and `deletedByOf`, which is the only place this event is constructed.
- `EVENT_VERSION` stays `1`: the change is additive, and stored rows decode (`AuthEventSchemas.ts:1100-1112`).
- `PII_FIELDS` gets no entry (ids only). `pseudonymizeActor` already rewrites ids anywhere in a
  payload, so a later erasure of the administrator also aliases `adminUserId`.
- **`AuditLog.actorOf` is unchanged**: `auth.user.deleted` → `event.userId` (`AuditLog.ts:169`).
  ADR-EA-029 §4 makes this row the receipt that keeps the id, and `listByActor(erasedId)` is how an
  operator proves the erasure happened. Who acted is already recorded by `auth.admin.userDeleted`
  (actor = admin) and `auth.scim.userDeleted` (no actor, connection in payload, BEH-EA-253).
- `auth.scim.userDeleted` is kept and still published by SCIM **after** `eraseAccount` returns, the
  same pattern as `auth.admin.userDeleted` (`AdminAccounts.ts:216-220`).

### 3.7 SCIM

**Records** (`packages/scim/src/ScimRecords.ts`): two new members in `ScimRecordsShape` (`:75-134`),
with memory and SQL implementations.

```ts
  /** ADR-EA-031: every link to `resourceId` of `kind`, across all connections (erasure and export). */
  readonly linksOfResource: (
    kind: ResourceKind,
    resourceId: string,
  ) => Effect.Effect<ReadonlyArray<ResourceLink>>;
  /** ADR-EA-031: drops every link to `resourceId` of `kind`, across all connections. Idempotent. */
  readonly unlinkResource: (kind: ResourceKind, resourceId: string) => Effect.Effect<void>;
```

SQL:
`SELECT * FROM scim_resource WHERE kind = ${kind} AND "resourceId" = ${resourceId} ORDER BY "createdAt", "scimConnectionId"`
and `DELETE FROM scim_resource WHERE kind = ${kind} AND "resourceId" = ${resourceId}`. Both use
`Effect.orDie`, like the existing statements (`:631-688`). Plan 05 moves all of them to the substrate.

**Migration** (append a third entry to `scimMigrations`, `Scim.ts:~340-412`). The primary key
starts with `"scimConnectionId"`, so a lookup by resource alone would scan the table:

```ts
  {
    // ADR-EA-031: erasure and export look a user up across every connection.
    name: "index_scim_resource_by_resource",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE INDEX scim_resource_by_resource ON scim_resource(kind, "resourceId")`;
    }),
  },
```

**Contributions** (new, in `Scim.ts` next to the plugin class, following `organizationErasure`/`passkeyErasure`):

```ts
/**
 * ADR-EA-031/CSG-001: this plugin's part of `AccountErasure.eraseAccount`. A `scim_resource` user
 * row holds the directory's `userName` (usually the email) and `externalId`; it goes with the user,
 * whoever started the erasure, inside the erasure's transaction.
 */
export const scimErasure = Erasure.contribute({
  id: "scim",
  make: Effect.gen(function* () {
    const records = yield* ScimRecords.ScimRecords;
    return (subject: Erasure.ErasureSubject) => records.unlinkResource("User", subject.userId);
  }),
});

/** CSG-005: which directory connections provisioned the person, under which userName/externalId. */
export const scimExport = DataExport.contribute({
  id: "scim",
  make: Effect.gen(function* () {
    const records = yield* ScimRecords.ScimRecords;
    return (subject: DataExport.DataExportSubject) =>
      records.linksOfResource("User", subject.userId).pipe(
        Effect.map((links) => ({
          provisionedBy: links.map((link) => ({
            connectionId: link.connectionId,
            userName: Option.getOrNull(link.name),
            externalId: Option.getOrNull(link.externalId),
            createdAt: DateTime.formatIso(link.createdAt),
          })),
        })),
      );
  }),
});
```

`Scim.layer` (`Scim.ts:420-421`) gains `contributes: Layer.mergeAll(scimErasure, scimExport)`.
`Group` links are team mappings, not personal data, so they are not touched.

**`deleteUser`** (`Scim.ts:884-908`). `make` gains `const erasure = yield* Erasure.AccountErasure;`
(the same pattern as `AdminAccounts.ts:163`):

```ts
const deleteUser: ScimShape["deleteUser"] = Effect.fnUntraced(function* (connection, id) {
  const owned = yield* ownedUser(connection, id);
  if (cfg.deleteBehavior === "erase") {
    // BEH-EA-250 (P20a): the veto is consulted inside `eraseAccount` before anything is touched, so a
    // refused erasure (a legal hold) leaves the sessions, the mapping and the memberships in place.
    yield* erasure
      .eraseAccount(
        owned.user.id,
        Erasure.ErasureInitiator.Directory({
          connectionId: connection.id,
          organizationId: connection.organizationId,
        }),
      )
      .pipe(
        Effect.catchTags({
          // Erased by someone else since `ownedUser` read it; their erasure dropped the mapping too.
          UserNotFound: () => Effect.fail(ScimApi.notFound(`User ${id} not found`)),
          HookAborted: (aborted) => Effect.fail(ScimApi.forbidden(aborted.message)),
        }),
      );
    yield* events.publish({
      _tag: "auth.scim.userDeleted",
      connectionId: connection.id,
      organizationId: connection.organizationId,
      userId: owned.user.id,
    });
    return;
  }
  yield* applyActive(connection, owned.user, false);
});
```

The explicit `sessions.revokeAll` and `records.unlink` go: both now run inside the erasure
transaction. `StoreUnavailable` passes through to the handler's existing
`catchTag("StoreUnavailable", outage)` (`Scim.ts:474-478`), giving `503`. The `ScimShape["deleteUser"]`
error union (`:123-126`) does not change.

**`createUser`** (`Scim.ts:714-797`, Phase 2): the separate `users.create` plus the `rollBack`
closure become one `users.createWith`:

```ts
const { user: created, value: link } = yield* users.createWith(
  { identity: /* as today */, name: nameFromInput(input) },
  (user) =>
    Effect.gen(function* () {
      const link = yield* records.link({ connectionId: connection.id, kind: "User", resourceId: user.id, name: userName, externalId: /* as today */ })
        .pipe(Effect.catchTag("ScimLinkConflict", (error) => Effect.fail(ScimApi.conflict(/* as today */))));
      yield* membershipAdded(connection, user.id).pipe(
        // The link was written above; abandoning the user must not leave the mapping behind.
        Effect.tapError(() => records.unlink(connection.id, "User", user.id)),
        Effect.catchTags({ /* MembershipLimitReached, HookAborted, OrganizationNotFound, UnknownOrgRole → ScimForbidden, as today */ }),
      );
      return link;
    }),
).pipe(Effect.catchTags({ "Users/EmailAlreadyExists": /* as today */, "Users/PhoneAlreadyExists": /* as today */ }));
```

`Users.createWith` removes the row when `complete` fails. Nothing is vetoed or announced, and
invitations are not touched. Behaviour is otherwise the same as today's `rollBack` (REQ-EA-926).

**Docs in code**: `Scim.ts:24-25` becomes "`DELETE` is configurable: `deactivate` (default) or `erase`
(`AccountErasure.eraseAccount` with a `Directory` initiator, the ADR-EA-031 cascade; a `BeforeUserDelete`
veto is `403` and touches nothing)."

### 3.8 Transaction boundaries

| Path | Outside the transaction | Inside one `SqlTransaction` | After commit |
|---|---|---|---|
| `eraseAccount` (all initiators) | `findById`; veto, which mints the clearance; `registry.contributions` | contributions (now including `scim`) → accounts → sessions (`"userDeleted"`) → verification → `UserRemoval.remove` → pseudonymize | `auth.user.deleted` |
| SCIM `erase` | `ownedUser` | (the row above) | `auth.user.deleted` (from core), then `auth.scim.userDeleted` |
| SCIM `createWith` | `create`, `link`, `addMember`, abandonment on failure: as today, no transaction (plan 01 may add one) | — | `auth.scim.userProvisioned` (unchanged) |

With `SqlTransaction.layerNoop` (in-memory compositions) nothing is atomic, which is why the veto
runs before anything is touched (ADR-EA-031 §1). That is unchanged.

### 3.9 Error mapping

| Source error | `eraseAccount` | SCIM `DELETE` (erase) | Admin `DELETE /admin/users/:id` | Self `DELETE /user` |
|---|---|---|---|---|
| unknown user | `UserNotFound` | `404` `ScimNotFound` (**was**: swallowed, then `204` plus a spurious `auth.scim.userDeleted`) | `AdminTargetNotFound` 404 (unchanged) | defect (unchanged) |
| veto | `HookAborted` (consulted once) | `403` `ScimForbidden(aborted.message)` (unchanged) | `HookAborted` 403 (unchanged) | defect (unchanged, Q8) |
| store outage | `StoreUnavailable` | `503` RFC 7644 body (unchanged) | unchanged | unchanged |
| `SqlError` / contribution death | defect, rolled back | 500 | 500 | 500 |

---

## 4. Phased migration

Every phase ends with the per-phase gate. Because "a plugin's own tests run against the built `lib`"
(`docs/plugin-authoring.md`, House rules), every gate starts with a build:

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
```

The plan gate (end of Phase 3) is `pnpm check && pnpm test:pg` (the SQL adapters of `Users` and
`ScimRecords` change).

Tickets: `.scratch/erasure-single-cascade/issues/01-hotfix-scim-erase-through-account-erasure.md`,
`02-seal-user-deletion.md`, `03-spec-and-docs-sweep.md` (each with `Status:` per
`docs/agents/triage-labels.md`).

### Phase 0 — baseline (no code)

1. Create the three tickets with this plan as their spec.
2. Run the plan gate on `main` and record the baseline (test counts, `spec:verify:strict` result).
3. Re-run `grep -rnE "users\.delete|Users\)\.delete|\.delete\(" packages examples features tools | grep -iv "credentials\|secrets\|claims\|HttpApiEndpoint\|searchParams"`
   and confirm the list in §2.2 is still complete. Any new caller is classified with the same table
   before continuing.

### Phase 1 — HOTFIX: SCIM erase runs the ADR-EA-031 cascade (shippable alone)

`Users.delete` stays public in this phase and the double veto remains (taps are already
idempotent per `Erasure.ts:23-24`). This phase closes the GDPR gap, the seat leak and the SAML
dead link first, and touches the smallest surface.

**1.1 Core: initiator and event** (`@awthaq/core`)
- `packages/core/src/Erasure.ts`: add `ErasureInitiator` and `deletedByOf` (§3.4); change
  `eraseAccount`'s second parameter to the required `initiator: ErasureInitiator`; publish
  `{ _tag: "auth.user.deleted", userId, ...deletedByOf(initiator) }`. Keep `users.delete(userId)` at `:131`
  for now.
- `packages/core/src/AuthEventSchemas.ts:103-112`: the schema and doc in §3.6.
- `packages/core/src/AuditLog.ts`: no code change. Add a one-line comment at `:169`: "receipt: the
  erased id stays the actor, whoever initiated (ADR-EA-029 §4)."

**1.2 Callers of `eraseAccount`**
- `packages/server/src/Account.ts:116` → `erasure.eraseAccount(userId, Erasure.ErasureInitiator.Self())`.
- `packages/admin/src/AdminAccounts.ts:208-209` → `Erasure.ErasureInitiator.Admin({ adminUserId: Users.UserId(caller.ref.id) })`.
  Update its doc at `:9-12` and `:56-60`.
- `features/step-definitions/TwoFactorSecuritySteps.ts:135`, `features/step-definitions/OrganizationSteps.ts:680`
  → pass `Erasure.ErasureInitiator.Self()`.
- `packages/core/test/AccountErasure.test.ts:206`, `:229` → the `Admin` initiator, and assert `adminUserId`.
- `packages/admin/test/AdminAccounts.test.ts:249` → also assert `e.adminUserId === adminId`.

**1.3 SCIM records, migration, contributions** (`@awthaq/scim`)
- `packages/scim/src/ScimRecords.ts`: `linksOfResource`, `unlinkResource` (memory and SQL, §3.7).
- `packages/scim/src/Scim.ts`: append migration `index_scim_resource_by_resource`; add `scimErasure`
  and `scimExport`; `Scim.layer` → `contributes: Layer.mergeAll(scimErasure, scimExport)`; import
  `DataExport`, `Erasure` from `@awthaq/core`.
- `packages/scim/src/index.ts`: export nothing new beyond what `Scim.ts` exports (the contributions are
  reachable as `Scim.scimErasure`/`Scim.scimExport`, matching `Organization.organizationErasure`).

**1.4 SCIM `deleteUser`**
- `packages/scim/src/Scim.ts:884-906` → §3.7. Header `:24-25` → §3.7 "Docs in code".
- `make` yields `Erasure.AccountErasure`.

**1.5 SCIM harnesses** (they must now provide `AccountErasure` and its stores)
- `packages/scim/test/support.ts`: `CoreLive` becomes
  `Layer.mergeAll(Sessions.layerMemory, Accounts.layerMemory, Verification.layerMemory, users)` (same
  `provideMerge` tail). In `ScimLive`, insert `Layer.provideMerge(Erasure.layer)` immediately **before**
  `Layer.provideMerge(CoreLive(users, hooks))`, so `Erasure.layer`'s needs come from `CoreLive`, its
  output reaches `Scim.layer`, and it shares the one `ErasureRegistry` from `hooks` with the
  organization and scim contributions.
- `features/step-definitions/ScimWorld.ts:84-117`: the same two edits in `buildLive`; extend
  `AppServices` (`:119-129`) with `Accounts.Accounts | Erasure.AccountErasure` for the new Thens.
- `packages/scim/test/ScimHttp.test.ts` needs no change in Phase 1. It uses `ScimLive`.

**1.6 Tests**: §5.1 (T1-T9), §5.4 (BDD), and the rewrites in §5.2 marked "Phase 1".

**1.7 Spec, traceability, changeset**: §6 items S1, S2, S3, S5, S6 (Phase 1 halves), and changeset
CS1.

**Gate**: per-phase gate, then also
`pnpm vitest run packages/scim packages/core/test/AccountErasure.test.ts packages/admin/test/AdminAccounts.test.ts`,
`pnpm --filter @awthaq/features exec vitest run features/13-enterprise-federation/30-scim.steps.test.ts`,
`pnpm test:pg` (new SCIM SQL), `pnpm spec:verify:strict`.

### Phase 2 — seal user deletion behind the clearance (breaking)

**2.1 The clearance**
- New `packages/core/src/internal/erasureClearance.ts` (§3.2).

**2.2 `Users` module** (§3.3)
- Add `UserRemoval`/`UserRemovalShape`, `createWith`, `removeRow` in both layers; switch both layers to
  `Layer.effectContext`; update both layer annotations; drop the `BeforeUserDelete` requirement.
- Remove `delete` from `UsersShape`, both `delete_` implementations, `beforeUserDeleteVeto`,
  `deleteHookInput`; rewrite the `Users.ts:548` paragraph.

**2.3 `Erasure` module** (§3.4)
- Yield `UserRemoval`; mint via `ErasureClearance.afterVeto`; replace `users.delete(userId)` with
  `removal.remove(clearance)`; `export type { ErasureClearance }`; rewrite the header (`:16-31`).

**2.4 SCIM `createUser`** (§3.7) → `users.createWith`; delete the `rollBack` closure (`Scim.ts:739-743`).

**2.5 Doubles of `Users`**
- `packages/scim/test/ScimHttp.test.ts:371-382` and `features/step-definitions/ScimWorld.ts:41-52`:
  `.pipe(Layer.provide(Users.layerMemory))` → `.pipe(Layer.provideMerge(Users.layerMemory))`, with the
  comment "provideMerge: the real `UserRemoval` rides along; this double's `Users` wins (`Context.merge`
  keeps the later entry)."

**2.6 Remaining `users.delete` callers** (§2.2 C4-C11) → §5.2.

**2.7 Clean-up of now-pointless provisions** (replace, don't layer): drop
`Layer.provide(Hooks.BeforeUserDelete.layer)` where it was there only for a `Users` layer:
`packages/core/test/Users.test.ts:24,38,598,665`, `packages/core/test/UserFields.test.ts:177,193`,
`packages/cli/test/support/SqlApp.ts:54`, `features/step-definitions/CliWorld.ts:154`. Keep it wherever
`Erasure.layer` or a tap needs it, and compile to confirm. `features/step-definitions/CrossCuttingApp.ts:89`:
remove `Hooks.BeforeUserDelete` from the union if no member still requires it.
`features/step-definitions/HooksWorld.ts:3` comment: "`Users.delete` (BeforeUserDelete)" →
"`AccountErasure.eraseAccount` (BeforeUserDelete)".

**2.8 Type gate and boundary guard**: §5.5.

**2.9 Spec, traceability, changeset**: §6 S1 (Phase 2 half), S4, S7, S8, and changeset CS2.

**Gate**: per-phase gate, then also `pnpm vitest run packages/core packages/scim packages/passkey packages/device-authorization packages/qadi`,
`pnpm test:bdd`, `pnpm test:pg`, `pnpm spec:verify:strict`. The type gates are checked by
`tsc -p tsconfig.test.json`, which is part of `pnpm typecheck`.

### Phase 3 — docs sweep and plan gate

- `packages/scim/README.md:29` → "`Scim.config({ deleteBehavior: "erase" })` runs the account erasure
  (`AccountErasure.eraseAccount`, `Directory` initiator): every plugin's rows, accounts, sessions,
  tokens, the user and the audit pseudonymization, in one transaction."
- `packages/admin/README.md:52` → `eraseAccount(userId, ErasureInitiator.Admin({ adminUserId }))`.
- `docs/plugin-authoring.md`, section "Personal data: erasure and export": add "A plugin never deletes
  a user. To remove an account it calls `Erasure.AccountErasure.eraseAccount(userId, initiator)`
  (`@awthaq/scim`'s `DELETE` is the worked example); to abandon a user it is creating, it uses
  `Users.createWith`." Add `scim` to the list of contributing plugins wherever one exists.
- `spec/decisions/031…` revision note (S5), `spec/overview.md:149` (`Erasure` row): add "the only
  deletion path; `Users` has no `delete`".
- Run the **plan gate**: `pnpm check && pnpm test:pg`.

---

## 5. Test plan

The repo rule is "replace, don't layer": a test that pinned the old behaviour is deleted or rewritten,
never kept next to its replacement.

### 5.1 New tests

| ID | File · `describe` › `it` | Phase | Proves |
|---|---|---|---|
| T1 | `packages/scim/test/ScimUsers.test.ts` · "SCIM Users: DELETE (BEH-EA-250)" › "configured to erase, DELETE runs the account erasure: memberships, accounts, tokens and the mapping go with the user" | 1 | After `deleteUser`: `users.findById` → `UserNotFound`; `members.listByUser(id)` is empty (seat freed: a new `provision` succeeds under `membershipLimit` that was full); `accounts.findByProviderSubject(...)` for a seeded `accounts.link({ userId, providerId: "saml:x", subject: "nameid-1" })` is `None`; the session verifies as `Sessions/NotFound`; `scim.getUser` → `ScimNotFound`. **Rewrites** "configured to erase, DELETE removes the user, its sessions and the mapping" (`:465-490`) |
| T2 | same file › "an erasing DELETE is announced as auth.user.deleted by the directory, then auth.scim.userDeleted" | 1 | `auditLog.list({ eventTag: "auth.user.deleted" })` has one row with `deletedBy: "directory"`, `connectionId`, `organizationId`, `userId`; the `auth.scim.userDeleted` row's `eventId` sorts after it |
| T3 | same file › "an erasing DELETE pseudonymizes the user's audit trail" | 1 | the `auth.scim.userProvisioned` row no longer contains the user id (alias); `auth.user.deleted` still does (receipt) |
| T4 | `packages/scim/test/ScimBddRegressions.test.ts` · "SCIM DELETE with erasure configured (BEH-EA-250)" › "a beforeDelete veto is a 403 that leaves the user, its sessions, its mapping and its membership in place" | 1 | extends the existing test (`:26-49`): also `members.listByUser(id).length === 1`, no `auth.user.deleted`, no `auth.scim.userDeleted`. With a counting tap in Phase 2, the tap ran **once** |
| T5 | `packages/scim/test/ScimRecords.test.ts` › "unlinkResource drops a user's links across connections and leaves groups and other users" (memory + SQLite, the suite's existing two-layer pattern) | 1 | the store primitive |
| T6 | `packages/scim/test/ScimErasure.test.ts` (new; copy `packages/organization/test/OrganizationErasure.test.ts`) › "a self-service erasure removes the user's SCIM mapping" and "the SCIM export lists the connection, userName and externalId and nothing secret" | 1 | the contribution runs for **every** initiator (closes the self/admin residue) |
| T7 | `packages/core/test/AccountErasure.test.ts` (inside `suite`, so memory and SQLite) › "auth.user.deleted names the initiator: self, admin with adminUserId, directory with connectionId and organizationId" | 1 | `deletedByOf` for all three; decode round-trip via `AuthEventSchemas.payloadOf` |
| T8 | `packages/core/test/AuditLog.test.ts` › "an auth.user.deleted row written before the initiator fields existed still decodes" | 1 | insert `{ _tag, userId, deletedBy: "self" }` as a raw stored payload and replay it |
| T9 | `packages/scim/test/ScimUsers.test.ts` › "DELETE of a user erased in between is 404 and publishes nothing" | 1 | the race made deterministic with a `Users` double (the `UsersDownOnLookup` pattern, built with `provideMerge`) whose first `findById` for the id succeeds and whose later ones fail `UserNotFound`; assert `ScimNotFound` and no `auth.scim.userDeleted` row. Two concurrent `deleteUser` calls would not be deterministic |
| T10 | `packages/core/test/AccountErasure.test.ts` › "the veto is consulted exactly once, before anything is touched" | 2 | a successful erasure leaves `probe.consults === 1`; a vetoing one also `=== 1` with every row intact. **Replaces** "a veto raised late, inside Users.delete, undoes …" (`:367-385`) |
| T11 | `packages/core/test/Users.test.ts` · new `describe` "UserRemoval (the row store primitive)" over memory and SQL (the file's existing two-layer `suite`) › "remove with a clearance drops the row and its fields; an unknown id is UserNotFound" | 2 | the primitive. Core tests may import `../src/internal/erasureClearance.ts` and mint with `ErasureClearance.afterVeto(id, Effect.void)`; the boundary guard (T14) covers `src/` only |
| T12 | `packages/core/test/Users.test.ts` › "createWith abandons the user when completion fails, dies or is interrupted, and keeps it when it succeeds" (memory and SQL) | 2 | `Effect.fail`, `Effect.die`, `Effect.interrupt` → `findByEmail` is `None`, fields gone; success returns `{ user, value }`. No `BeforeUserDelete` consult (count with a tap) |
| T13 | `packages/scim/test/ScimUsers.test.ts` › "an organization at its membership limit refuses the POST and leaves no user, no mapping and every invitation to that address behind" | 2 | **extends** `:221-233`: seed an invitation to `extra@acme.example` in another organization first; after the refused `POST` it still exists. This regression-guards §3.5 |
| T14 | `packages/core/test/ErasureClearance.boundary.test.ts` (new, static guard modelled on `packages/organization/test/TenantScoping.test.ts`) | 2 | across `packages/*/src/**/*.ts`, the only file importing `internal/erasureClearance` as a value is `packages/core/src/Erasure.ts`; `packages/core/src/Users.ts` imports it type-only (`import type`); no other file mentions it |
| T15 | `packages/core/test/UserDeletion.types.test.ts` (new type gate) | 2 | §5.5 |

### 5.2 Tests deleted or rewritten (by name)

| File › test | Phase | Action |
|---|---|---|
| `packages/core/test/HooksWiringMemory.test.ts` (whole file, "Users.layerMemory delete hook (BEH-EA-095)") | 2 | **delete**. The behaviour (Users consults the veto) is removed; T10 covers the veto |
| `packages/core/test/HooksWiringSql.test.ts` (whole file, "Users.layerSql delete hook (BEH-EA-095)") | 2 | **delete** |
| `AccountErasure.test.ts` › "a veto raised late, inside Users.delete, undoes the accounts, sessions and tokens already removed" | 2 | **delete**, replaced by T10. Keep `probe.vetoAfter` only if T10 uses it; otherwise remove the field |
| `AccountErasure.test.ts` › "erases the core rows, runs every contribution in order, then announces once" (`:189-234`) | 1 | rewrite the call to `Admin({ adminUserId })`, assert `adminUserId` |
| `Users.test.ts` › the not-found test containing `users.delete(missing)` (`:130-145`) | 2 | drop the two `delete` lines; the not-found contract for removal moves to T11 |
| `UserFields.test.ts` › "a deleted user's fields do not resurrect on a re-created id" (`:364-376`) | 2 | rewrite through `UserRemoval.remove(clearance)` (memory layer, as today) |
| `ScimUsers.test.ts` › "configured to erase, DELETE removes the user, its sessions and the mapping" | 1 | rewritten as T1 |
| `ScimBddRegressions.test.ts` › "a beforeDelete veto is a 403 that leaves the user, its sessions and its mapping in place" | 1 → 2 | extended as T4; rename it to T4's title |
| `Passkey.test.ts` › "WPS-001: a credential surviving its own deleted user cannot mint a session for that dead user" | 2 | replace `users.delete(user.id)` (`:276`) with the orphaning erasure (§5.3); update the comment at `:270-275` (the cascade now exists; the orphan is produced on purpose) |
| `DeviceAuthorization.test.ts` › "a user deleted after approving leaves an unredeemable grant: invalid_grant, and the row is dropped" | 2 | same technique; the harness (`packages/device-authorization/test/support/harness.ts:133-165`) also needs `Accounts.layerMemory` in the core merge |
| `packages/qadi/test/Resolvers.test.ts` › "a deleted user's subject resolves to undefined, not a failure" | 2 | rename to "a subject naming no user (never created, or erased) resolves to undefined, not a failure"; use `Users.UserId(crypto.randomUUID())`, never created |
| `features/step-definitions/HooksSteps.ts` "{string} taps {string} to purge its own {string} rows for that user" (`:634-639`) | 2 | `host.run(Erasure.AccountErasure.use((erasure) => erasure.eraseAccount(Users.UserId(alice.userId), Erasure.ErasureInitiator.Self())).pipe(Effect.orDie))`. The following Then (`:643-656`) already asserts `seenBy("Invite")` is exactly `[alice]`, which now also proves "once" |
| `ScimHttp.test.ts` `UsersDownOnLookup` (`:371-382`), `ScimWorld.ts` `UsersDownOnLookup` (`:41-52`) | 2 | `provide` → `provideMerge` (§4 2.5) |

### 5.3 The orphaning erasure (for the two defence-in-depth tests)

C8 and C9 deliberately produce a plugin row whose user is gone. With `Users.delete` removed, they
produce it through the real cascade, with the plugin's contribution left out. Each test file defines
this locally (no shared infrastructure, two callers):

```ts
/** An erasure that runs the core cascade but none of the plugins' contributions: a deliberate orphan. */
const OrphaningErasure = Erasure.layer.pipe(
  // `Layer.fresh`: the composition's own registry (holding this plugin's contribution) is memoized by
  // reference and `Effect.provide` forks the current memo map, so without `fresh` it would be reused.
  Layer.provide(Layer.fresh(Erasure.registryLayer)),
);
// in the test:
yield* Erasure.AccountErasure.use((erasure) =>
  erasure.eraseAccount(user.id, Erasure.ErasureInitiator.Self()),
).pipe(Effect.provide(OrphaningErasure));
```

(`Layer.fresh`: `../effect/packages/effect/src/Layer.ts:2207`; memo-map inheritance: `Layer.ts:723`, `:791`.)

### 5.4 BDD changes (`features/features/13-enterprise-federation/30-scim.feature` and others)

New scenario ids take the next free `REQ-EA-*` ids **at execution time**. Today that is 1268 and
up (`features/traceability.md` ends at REQ-EA-1267). Other plans allocate from the same pool, so
check again before tagging.

| Scenario | Rule | Change |
|---|---|---|
| REQ-EA-949 "Configured to erase, DELETE ends the sessions, removes the mapping and deletes the user" | BEH-EA-250 | add `And "ada@acme.example" is no longer a member of "Acme"` |
| **new** "An erasing DELETE runs the whole account erasure" | BEH-EA-250 | Given erase, a provisioned user with a linked account and an organization membership; When deleted; Then no user, no linked account, no membership, and the mapping is gone |
| **new** "An erasing DELETE frees the organization seat" | BEH-EA-250 | organization limited to 2 members (owner + ada); after the erasing DELETE, provisioning "bob" is 201 |
| REQ-EA-951 "A beforeDelete hook that vetoes the erasure makes DELETE a 403 and the user stays" | BEH-EA-250 | add `And the user "ada@acme.example" has 1 live sessions` (Given) and `And every live session of "ada@acme.example" is still accepted` and `And "ada@acme.example" is still a member of "Acme"` (Then) |
| REQ-EA-982 "An erasing DELETE publishes userDeleted" | BEH-EA-253 | add `And the audit log records 1 "auth.user.deleted" events deleted by the directory "Okta"` |
| **new** "A user who deletes their own account loses the directory's mapping too" | BEH-EA-250 | provisioned by "Okta"; the account is erased through `AccountErasure` (Self); as seen by "Okta", 0 users are listed and a repeat POST with the same externalId is 201 with a new user |
| REQ-EA-926 "A failed provisioning leaves neither the user nor a mapping behind" | BEH-EA-247 | add `And an invitation to "extra@acme.example" from another organization still exists` (needs a Given seeding it) |
| `04-cross-cutting/12-hooks.feature` BEH-EA-095 scenario (`:140`) | BEH-EA-095 | step rewrite only (§5.2) |

New steps live in `features/step-definitions/ScimSteps.ts`, using `withContext` with
`MembershipRecords`, `Accounts`, `AuditLog`, `Erasure.AccountErasure` and `OrganizationRecords`
(extend `AppServices`).

### 5.5 Type gate (proves `Users.delete` is not callable)

`packages/core/test/UserDeletion.types.test.ts`. It imports through the **barrel**, so it checks the
public surface. Nothing executes: the assertions are the `@ts-expect-error` directives, checked by
`tsc -p tsconfig.test.json`. This is the same pattern as `RateLimits.types.test.ts`.

```ts
// ADR-EA-031 (rev 1.1), BEH-EA-046 (rev 1.3): a committed user is deleted only by
// `AccountErasure.eraseAccount`. Each line below must fail to compile.
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Erasure, Users } from "../src/index.ts";

declare const users: Users.UsersShape;
declare const removal: Users.UserRemovalShape;
declare const erasure: Erasure.AccountErasureShape;
declare const id: Users.UserId;

// Never called: the `declare`d values have no runtime existence, only types.
const gates = () => {
    // @ts-expect-error — `Users` has no `delete`: erasure is the only way to remove a user
    void users.delete(id);
    // @ts-expect-error — a user id is not a clearance
    void removal.remove(id);
    // @ts-expect-error — nor is a look-alike object: the clearance's private field makes it nominal
    void removal.remove({ userId: id });
    // @ts-expect-error — the clearance is exported as a type only; there is no value to construct
    void new Erasure.ErasureClearance(id);
    // @ts-expect-error — and no minting function on the public surface
    void Erasure.ErasureClearance.afterVeto(id, Effect.void);
    // @ts-expect-error — the initiator is required: no erasure is silently attributed to the user
    void erasure.eraseAccount(id);
};

describe("user deletion is sealed behind AccountErasure (BEH-EA-046)", () => {
  it("Users has no delete; UserRemoval needs a clearance nobody outside core can make", () => {
    // The assertions are the `@ts-expect-error` lines above, checked by `tsc -p tsconfig.test.json`.
    void gates;
  });
});
```

A positive type assertion belongs in the same file:
`Layer.Success<typeof Users.layerMemory>` extends `Users.Users | Users.UserRemoval`, and
`Layer.Services<typeof Users.layerMemory>` no longer includes `Hooks.BeforeUserDelete`.

---

## 6. Spec, ADR, traceability, changesets

Every edited spec document gets a revision bump and a Change History line (Document Control table).

| ID | Document | Phase | Change |
|---|---|---|---|
| S1 | `spec/behaviors/06-domain-users-accounts.md` → **BEH-EA-046** (`:134-145`), revision 1.2 → 1.3 | 1 (wording on SCIM) and 2 (main) | REQUIREMENT unchanged in substance; add a "Revision 1.3" paragraph: deleting a User means `Erasure.AccountErasure.eraseAccount(userId, initiator)`, the only path; `Users` has no `delete`; the row store primitive `UserRemoval.remove` takes an `ErasureClearance` minted only after the `BeforeUserDelete` veto passes; `Users.createWith` abandons a user whose creation did not complete (no veto, no event). In `:143`, replace "`delete` keeps the destructive cascade above unchanged" with "erasure (`AccountErasure`) keeps …" |
| S2 | `spec/behaviors/30-scim.md` → **BEH-EA-250** (`:97-111`), revision 1.0 → 1.1 | 1 | New REQUIREMENT text: "When `deleteBehavior` is `"erase"`, it MUST erase the user through `AccountErasure.eraseAccount` with a `Directory` initiator naming the connection and its organization: every registered erasure contribution (organization memberships and invitations, the connection's mapping, …), accounts, sessions, verification tokens, the user and the audit pseudonymization, in one transaction. A `BeforeUserDelete` veto MUST be `403` and leave the user, its sessions, its memberships and the mapping as they were; a user erased in the meantime is `404`. Afterwards the external id is free to be provisioned again." Rationale paragraph: the cascade is the same one a self or admin deletion runs. Also add to BEH-EA-247 (REQ-EA-926 context) that a failed `POST` abandons the user without touching invitations |
| S3 | same file → **BEH-EA-253** (`:155-167`) | 1 | add "An erasing `DELETE` is also announced by core's `auth.user.deleted` (`deletedBy: "directory"`, with the connection and organization ids), which precedes `auth.scim.userDeleted`." |
| S4 | `spec/behaviors/12-hooks.md` → **BEH-EA-095** "As shipped" (`:144`), header pointer (`:17`), revision 1.1 → 1.2 | 2 | "runs the `BeforeUserDelete` veto **once**, first"; the test pointer `HooksWiringMemory.test.ts` becomes `AccountErasure.test.ts` (the file is deleted, and `spec:verify` checks that test paths exist) |
| S5 | `spec/decisions/031-erasure-registry-and-retention.md`, revision 1.0 → 1.1 | 1 and 2 | Decision 1 text: `eraseAccount(userId, initiator)` with `ErasureInitiator` (`Self`/`Admin`/`Directory`); the veto is consulted once and its passing mints the `ErasureClearance` that `UserRemoval.remove` requires, so no other path can delete a row (type gate `UserDeletion.types.test.ts`). Decision 2: `scim` ships a contribution. New "Revision 1.1 note": SCIM `erase` previously bypassed the cascade (organization rows, accounts, tokens, plugin rows, audit, event); fixed. Consequences: the clearance seals the domain interface; the SQL repository beneath (`Repositories.UsersRepository.delete`) is sealed by plan 02's store seam |
| S6 | `spec/behaviors/13-events.md` taxonomy (`:106`), revision 1.1 → 1.2 | 1 | "`auth.user.deleted` (after the erasure commits, no email, SCP-006; `deletedBy` `self`/`admin`/`directory` with the initiator's ids)" |
| S7 | `spec/behaviors/27-admin-impersonation.md` (`:352`), revision 1.1 → 1.2 | 2 | `eraseAccount(userId, ErasureInitiator.Admin({ adminUserId }))` |
| S8 | `spec/models/12-scim.md:62` (revision 1.2 → 1.3) and `spec/decisions/023-enterprise-federation-packages.md:45` (revision 1.1 → 1.2) | 1 | replace "(`Users.delete`, BEH-EA-46's cascade, running the `BeforeUserDelete` erasure taps)" with "(`AccountErasure.eraseAccount`, the ADR-EA-031 cascade)"; in model 12 also drop "unlinks the `scim_external_id` mapping and then", since the mapping is removed by the erasure |
| S9 | `spec/traceability.md` | 1 and 2 | row `:179` (ADR-EA-031): add `packages/scim/test/ScimErasure.test.ts`, `packages/core/test/UserDeletion.types.test.ts`, `packages/core/test/ErasureClearance.boundary.test.ts`; row `:281` (`packages/scim/test/*`): mention erasure through `AccountErasure`; row `:328` (30-scim.feature): extend the REQ range and the scenario count (`101 / 101` → the new total); row `:189` (`Users.test.ts`): add "the `UserRemoval` primitive and `createWith` abandonment" |
| S10 | `features/traceability.md` | 1 | a row per new REQ-EA id (BEH-EA-250/253 anchors, as at `:960-996`) |
| S11 | `spec/glossary.md` | 2 | add **Erasure initiator** and **Erasure clearance** (one line each) |

The event schema change is S6, plus the code in §3.6. No ADR-EA-029 edit is needed: identifiers
only, and the receipt keeps the id.

### Changesets (ADR-EA-034: every package-visible change, `Migration:` for each break)

**CS1** `.changeset/scim-erase-runs-account-erasure.md` (Phase 1):

```md
---
"@awthaq/core": minor
"@awthaq/scim": minor
"@awthaq/admin": minor
"@awthaq/server": minor
---

SCIM `DELETE /Users/:id` with `deleteBehavior: "erase"` now runs the account erasure (ADR-EA-031,
BEH-EA-250): every plugin's rows (organization memberships and invitations, passkeys, roles, …),
linked accounts, sessions, verification tokens, the user and the audit pseudonymization, in one
transaction, announced by `auth.user.deleted` with `deletedBy: "directory"`. It previously deleted
only the user row and its sessions, leaving memberships (a taken seat), linked accounts (a SAML
sign-in for the same NameID then failed) and the audit trail behind. `@awthaq/scim` also takes part
in every erasure (`scimErasure`: the user's `scim_resource` rows) and in the data-subject export
(`scimExport`), and adds a `scim_resource(kind, "resourceId")` index migration.

Migration: `AccountErasure.eraseAccount(userId, options?)` is now
`eraseAccount(userId, initiator)` with a required `Erasure.ErasureInitiator`: `{ deletedBy: "self" }` →
`ErasureInitiator.Self()`, `{ deletedBy: "admin" }` → `ErasureInitiator.Admin({ adminUserId })`, and a
call with no options (which meant "self") → `ErasureInitiator.Self()`. `auth.user.deleted.deletedBy`
gains `"directory"` and optional `adminUserId`/`connectionId`/`organizationId`: an exhaustive switch on
`deletedBy` needs a `"directory"` case. A composition of `Scim.layer` must now provide
`Erasure.AccountErasure` (`Erasure.layer`; `AuthHttp` compositions already do). A SCIM `DELETE` racing
another erasure of the same user now answers 404 instead of 204. Run the new SCIM migration.
```

**CS2** `.changeset/users-delete-removed.md` (Phase 2):

```md
---
"@awthaq/core": minor
"@awthaq/scim": minor
---

A user can only be deleted by `Erasure.AccountErasure.eraseAccount` (BEH-EA-046, ADR-EA-031). `Users`
no longer has `delete`; the row store primitive is the new `Users.UserRemoval` service, whose `remove`
takes an `Erasure.ErasureClearance` that only `AccountErasure` can mint, after the `BeforeUserDelete`
veto passes. The veto therefore runs exactly once per erasure (it ran twice). New:
`Users.createWith(input, complete)` creates a user and abandons it (no veto, no event) if `complete`
fails; `@awthaq/scim`'s provisioning uses it, so a refused `POST` no longer consults the delete veto.

Migration: replace `users.delete(id)` with `erasure.eraseAccount(id, Erasure.ErasureInitiator.…)`; a
caller that deleted a user it had just created as a rollback uses `users.createWith`. `Users.layerMemory`
/ `layerSql` now provide `Users | UserRemoval` and no longer require `Hooks.BeforeUserDelete`; a test
double of `Users` built as `Layer.effect(Users.Users, …).pipe(Layer.provide(Users.layerMemory))` must use
`Layer.provideMerge` so the real `UserRemoval` comes along. A `BeforeUserDelete` tap no longer needs to
be idempotent across one erasure.
```

---

## 7. Risks, mitigations, rollback

| # | Risk | Mitigation |
|---|---|---|
| R1 | SCIM `erase` now removes much more (invitations addressed to the email, passkeys, roles, 2FA, …). An operator who relied on "erase = row only" sees more go | This is the documented intent of `erase` (BEH-EA-250 already says "a deleted user's row, accounts and history are gone"). CS1 states it. `deactivate` stays the default |
| R2 | `auth.user.deleted` webhook subscribers start receiving directory deletions | The goal (ADR-EA-030: the event is the consumer's cue to erase). Announced in CS1 |
| R3 | An exhaustive `switch (event.deletedBy)` in a consumer stops compiling | The Migration note. Pre-1.0 (ADR-EA-034 §2) |
| R4 | `eraseAccount`'s required initiator breaks host code calling it | Migration note. In-repo callers fixed in 1.2 |
| R5 | A `Users` test double typed `typeof Users.layerMemory` stops compiling | 2.5; CS2 note; the error names `UserRemoval` |
| R6 | Another core module mints a clearance | T14 boundary guard fails CI |
| R7 | `Repositories.UsersRepository.delete` (`@awthaq/sql`, `Repositories.ts:267`) still deletes a row for anyone composing the SQL repositories | It is an adapter, not a domain interface, and plugins do not compose it. Plan 02 seals it (UserStore takes the clearance). Recorded in ADR-EA-031 rev 1.1 Consequences |
| R8 | `createWith`'s abandonment fails (store outage during cleanup): a ghost user with no mapping | Same as today's swallowed `rollBack`. The cleanup cause is logged (`ignoreCause({ log: true })`). Plan 01 can make SCIM provisioning transactional |
| R9 | SCIM `DELETE` latency grows (the full cascade in one transaction) during bulk deprovisioning | Erasure is rare. All contributions are keyed deletes; the new index covers the SCIM one |
| R10 | In-memory (`layerNoop`) compositions: a contribution failing mid-erasure leaves a partial state | Unchanged from every other erasure. The veto runs first (ADR-EA-031 §1) |
| R11 | Generic contextual typing of `createWith` does not infer | Fall back to a generic `function` declaration (§3.3). Never `as` |
| R12 | Two receipts keep the erased id (`auth.scim.userDeleted`, `auth.admin.userDeleted`) in addition to `auth.user.deleted` | Pre-existing for admin. Identifiers only (ADR-EA-029). Noted in S5 |
| R13 | A pre-release deployment that already ran SCIM `erase` holds orphans (memberships, accounts, …) | Nothing is published (`spec/overview.md` status banner). If one exists, Q6 |

**Rollback.**
- *Phase 1*: revert the Phase 1 commits. Code only, apart from the appended migration
  `index_scim_resource_by_resource`. Migrations are append-only and forward-only
  (`docs/plugin-authoring.md`, Migrations), and the index is harmless if left. Erasures already
  performed cannot be undone; that is by design.
- *Phase 2*: revert the Phase 2 commits (pure code: interfaces, layers, tests, spec). Phase 1 stays.
  Rolling back Phase 2 restores the double veto but keeps the SCIM fix.
- Each phase is its own changeset, so a revert also reverts its release note.

---

## 8. Interactions with other plans

| Plan | Shared seam | What 03 hands over / requires |
|---|---|---|
| **01 Sign-in and sign-up in core** | user creation; SCIM `createUser` | 03 lands first (README ordering). 01's `SignUp` must not delete users: a sign-up that fails after `create` uses `Users.createWith` (03 adds it) or a transaction. 01 may absorb `createWith` into `SignUp` and make it non-public; then SCIM's provisioning becomes `SignUp` + `complete` and the abandonment moves with it. When 01 makes SCIM publish `auth.user.created`, abandonment must keep publishing nothing (the user was never announced). 03 leaves `Scim.ts:714-797` in the `createWith` shape so 01 rewrites one call |
| **02 One domain implementation over a store seam** | `UserRemoval` → `UserStore.delete` | 02 replaces `UserRemoval` with a `UserStore` port method `delete(clearance: ErasureClearance)`. The **clearance type stays** and remains core-minted, so 02 needs no new sealing design even if `UserStore` is a public port that adapter authors implement. 02 also seals `Repositories.UsersRepository.delete` (R7), for example by making the repository a `UserStore` adapter that takes the clearance. 02 keeps T11/T12 as the store's contract tests (memory/SQL parity). `createWith` becomes a domain operation over `UserStore.insert` + `delete` |
| **04 Organization system modules** | `organizationErasure` (`Organization.ts:1730-1747`) | SCIM `erase` now triggers it, which is what frees the seat. 04 must move the contribution with the membership, team, invitation and active-context modules it touches, keep it registered from `Organization.layer`'s `contributes`, and keep T1's "seat freed" assertion green. Open for 04: erasing an organization's **sole owner** leaves an ownerless organization (no `BeforeUserDelete` tap enforces transfer, despite `Erasure.ts:20-21` citing that use). 04 should either tap the veto or document the outcome. Erasure also publishes no `auth.organization.memberRemoved`; 04 decides whether membership removal by erasure is announced |
| **05 Plugin table substrate** | the new `scim_resource` statements | 03's `linksOfResource`/`unlinkResource` follow the existing `ScimRecords` style (`orDie`, tenant-blind). 05 migrates them with the rest. 05's RLS on `scim_resource` must allow the cross-connection erasure delete (it runs inside `AccountErasure`'s transaction, under the erasing request's tenant context) |
| **09 Event metadata travels with the event schema** | `UserDeletedEvent`, `AuditLog.actorOf` | Whichever lands second carries: the `"directory"` literal and the three optional ids; the actor rule "`auth.user.deleted` → `userId`, whatever `deletedBy`"; no `PII_FIELDS` entry; and the single-`TaggedStruct` constraint (`WebhookPayload.knownEventTags`). If 09 introduces discriminated per-variant definitions, the `deletedByOf` correlation can move into the schema |
| **10 Standalone fixes** | self-delete veto → 500 (`packages/server/src/Account.ts:117-120`) | Not changed here. 10 may give the `account` contract a typed `403` for a vetoed self-deletion |

---

## 9. Acceptance checklist

- [ ] `grep -rnE "users\.delete\(|Users\)\.delete\(" packages features examples tools` returns nothing
      outside `lib/` and `.planning/`.
- [ ] `UsersShape` has no `delete`; `Users.layerMemory`/`layerSql` provide `Users | UserRemoval` and do
      not require `Hooks.BeforeUserDelete`.
- [ ] `packages/core/src/internal/erasureClearance.ts` exists, is not exported from `src/index.ts`, and
      contains no `as`; `Erasure.ts` re-exports its type only.
- [ ] `UserDeletion.types.test.ts` passes under `tsc -p tsconfig.test.json` (every `@ts-expect-error`
      line is an error).
- [ ] `ErasureClearance.boundary.test.ts` passes: `Erasure.ts` is the only value importer.
- [ ] `eraseAccount(userId, initiator)` with a required `ErasureInitiator`; every caller passes one.
- [ ] The veto is consulted exactly once per erasure (T10); `Erasure.ts` no longer asks taps to be
      idempotent because of a second consult.
- [ ] SCIM `erase` calls `eraseAccount(…, Directory)` and publishes `auth.scim.userDeleted` after it;
      no `users.delete`, `sessions.revokeAll` or `records.unlink` is left in `deleteUser`.
- [ ] SCIM erase removes memberships, accounts, tokens and the mapping, frees the seat, pseudonymizes
      the audit trail, and publishes `auth.user.deleted` with `deletedBy: "directory"`, `connectionId`
      and `organizationId` (T1-T3).
- [ ] A legal-hold veto is `403` and leaves the user, its sessions, its mapping and its membership
      intact; no event is published (T4).
- [ ] `scimErasure` and `scimExport` are registered via `Scim.layer`'s `contributes`; a self erasure
      removes SCIM links (T6); the export lists them without secrets.
- [ ] A failed SCIM `POST` leaves no user and no mapping, and **does not** remove invitations to the
      address (T13).
- [ ] Old `auth.user.deleted` rows decode (T8); `EVENT_VERSION` is still 1.
- [ ] `HooksWiringMemory.test.ts` and `HooksWiringSql.test.ts` are deleted; nothing references them
      (`spec/behaviors/12-hooks.md:17` updated).
- [ ] BDD: the new and changed scenarios are tagged and listed in `features/traceability.md`;
      `spec/traceability.md:328` counts updated; `pnpm test:bdd` green.
- [ ] Spec documents S1-S11 edited with revision and Change History; `pnpm spec:verify:strict` green.
- [ ] Changesets CS1 and CS2 present, each with `Migration:`.
- [ ] READMEs (`scim`, `admin`) and `docs/plugin-authoring.md` updated.
- [ ] `pnpm check && pnpm test:pg` green.

---

## 10. Open questions (only the user can answer)

1. **Should `BeforeUserDelete`'s input carry the initiator** (`deletedBy`, optional key), so a tap can
   decide per initiator? Example: a legal hold that refuses a directory erasure but lets an
   administrator override. Default in this plan: **no**, because no current tap needs it (richness
   only with a real caller). Adding it later is additive.
2. **Deprecate `auth.admin.userDeleted` and `auth.scim.userDeleted`** now that `auth.user.deleted` names
   the initiator and its ids? Default: **keep both**. They carry the audit actor (admin) and the
   "directory acted" record (BEH-EA-253) that `auth.user.deleted` deliberately does not.
3. **Initiator ids on `auth.user.deleted`** (`adminUserId`, `connectionId`, `organizationId`): this plan
   adds them, the richer option. The alternative is `deletedBy: "directory"` only, leaving the ids
   to the plugin events. Confirm.
4. **SCIM `DELETE` of a user erased in between**: `404` (this plan; RFC 7644 treats a missing resource
   as 404) or `204` (idempotent-delete reading)? Either way nothing is published for a deletion this
   request did not perform.
5. **Ship `scimExport` with the hotfix** (this plan, since it mirrors the erasure contribution), or as a
   separate change?
6. **Pre-release deployments** that already used SCIM `erase`: is an orphan repair needed? It could be
   driven by `auth.scim.userDeleted` audit rows whose user no longer exists. Default: **none**,
   because nothing is published.
7. **`Directory` vs `Scim`** as the initiator tag: this plan uses the generic `Directory` (a future
   LDAP or HRIS sync fits it). Confirm the name.
8. **Self-service delete vetoed → 500** (`packages/server/src/Account.ts:117-120`): give `DELETE /user`
   a typed `403` in plan 10?
9. **api-key and saml erasure gaps**: `apikey_key."ownerId"`/`apikey_client."ownerId"` (a `UserId`) and
   `saml_session."nameId"` have no `Erasure.contribute`. Whether an erased user's API key still
   authenticates was **not** verified. Open a separate plan, or fold into 10?
10. **`createWith` naming and lifetime**: keep it as a public `Users` operation, or have plan 01
    privatize it behind `SignUp` once SCIM provisioning moves there?
