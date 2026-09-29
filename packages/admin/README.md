# @awthaq/admin

Admin plugin: **impersonation** (off by default, admin-gated, reason required, hard expiry, dual identity, fully audited — NFR-EA-007) and **user and session administration**. Everything is fail-closed: an unconfigured deployment denies every operation.

Behavior is specified in [`spec/behaviors/27-admin-impersonation.md`](../../spec/behaviors/27-admin-impersonation.md) (BEH-EA-209 through 224); [`spec/overview.md`](../../spec/overview.md) has the package map.

## Configure the gates

See [`spec/overview.md`](../../spec/overview.md) for the full package map this fits into.

```ts
Admin.config({
  maxDuration: Duration.hours(1), // hard expiry of every impersonation session
  canImpersonate: ({ admin, target }) => Effect.succeed(/* your policy */ false),
  canManageEpisode: ({ admin, episode }) => Effect.succeed(false), // optional; defaults to canImpersonate(admin, episode.target)
  canManageUsers: ({ admin, target }) => Effect.succeed(false), // target is None for listUsers
  canBanUsers: ({ admin, target }) => Effect.succeed(false), // banUser / unbanUser
  canDeleteUsers: ({ admin, target }) => Effect.succeed(false), // AdminAccounts.deleteUser
  canManageCredentials: ({ admin, target }) => Effect.succeed(false), // AdminAccounts.setUserEmail / setUserPassword
  passwordPolicy: (password) => Effect.succeed([]), // hints an admin-set password violates; default: 12 to 1024 characters
  links: { changeEmail: (token) => `https://app.example/confirm-email#${token}` }, // the URL in the change-email mail
  canAdministerTenants: ({ admin, organizationId }) => Effect.succeed(false), // superadmin: cross-tenant episodes + AdminTenants
});
```

Every predicate defaults to "deny", and every one **sees the target** (and, for `canImpersonate`/`canManageUsers`, the request's ambient `tenantId`) — so a host can refuse to impersonate or administer a more privileged account (or another tenant's). Subjects are identity-only (`{ id }`); a predicate that needs roles or tenant looks them up itself by id. `list` filters impersonation episodes through `canManageEpisode` row by row, so a caller who may manage none sees an empty history.

**Tenant scoping (IDS-002, ADR-EA-018).** Each episode records the ambient `TenantContext` it started under, and `list`/`forceStop` are confined to the request's own tenant: another tenant's episode is `AdminImpersonationNotFound`, exactly like an unknown id. `canAdministerTenants` is the one predicate that lifts the confinement (a platform superadmin sees and ends every tenant's episodes, still subject to `canManageEpisode`). In a single-tenant deployment nothing provides a tenant, every episode is untenanted, and behavior is unchanged.

## Impersonation client contract

| Call        | Endpoint                                       | Result                                                                                                                               |
| ----------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| impersonate | `POST /admin/impersonate/:userId` `{ reason }` | a new session for the target with `actingAs` = the admin; 404 `AdminTargetNotFound` for an unknown user (only after the gate passes) |
| stop        | `POST /admin/stop-impersonating`               | revokes the caller's own impersonation session                                                                                       |
| force-stop  | `POST /admin/force-stop/:sessionId`            | ends another admin's episode (per-episode gate)                                                                                      |
| history     | `GET /admin?active&cursor&limit`               | `{ items, nextCursor }`, newest first, keyset-paginated                                                                              |

- **Cookie mode (browsers).** `impersonate` sets `__Host-impersonation` and never touches `__Host-session`. Authentication prefers `__Host-impersonation` (and only accepts a session that carries `actingAs` there), so the browser acts as the target while the admin's own session stays live underneath. `stop-impersonating` expires the cookie and the very next request is the admin again — no re-login, no handback session.
- **Bearer mode (native clients).** The session token is in the response; the client swaps its `Authorization` token and swaps back when done. The admin's own token is never invalidated.
- Impersonation sessions never idle-refresh; they end at `maxDuration`, and an expired episode is closed in the audit trail as `endedBy: "expired"` — lazily on every `list`/`forceStop`, or on a schedule with `Effect.repeat(Admin.sweepExpiredEpisodes, Schedule.spaced("1 minute"))`.
- `stop` and `force-stop` revoke first and idempotently; recording the episode's end is best-effort after that.

## User and session administration

`GET /admin/users` (keyset-paginated), `GET`/`PATCH /admin/users/:userId`, `GET /admin/users/:userId/sessions`, `DELETE /admin/users/:userId/sessions/:sessionId`, `DELETE /admin/users/:userId/sessions`. All behind `canManageUsers`; an unknown user is a 404 only after the gate passes. Impersonation sessions are never listed or revoked by these routes (use `force-stop`). Actions publish `auth.admin.*` events, recorded durably by `AuditLog`.

**Ban and unban** (`POST /admin/users/:userId/ban` `{ reason?, until? }`, `POST /admin/users/:userId/unban`) sit behind their own predicate, `canBanUsers` — being allowed to edit a user does not imply being allowed to lock them out. `banUser` is `Users.setStatus(userId, "suspended", …)` plus `Sessions.revokeAll(userId, "suspended")` (every session, impersonation sessions issued as the user included), publishes `auth.admin.userBanned`, and refuses to ban the calling admin (`AdminSelfBanRefused`). The block is the one shared sign-in gate, `Users.assertCanSignIn`, which password, passkey and OAuth sign-in each consult, so a banned user is refused `UserSuspended` (403) everywhere while `getUser`/`unbanUser` still resolve them; `until` makes a ban lapse by itself and `reason` is an operator note the banned user never sees. `unbanUser` is `setStatus("active")` — nothing was deleted, so the user just signs in again.

**Deletion and credentials (`AdminAccounts`).** An opt-in third plugin, `Auth.make([Admin, AdminAccounts])`, in the admin-tier group `admin.accounts`: `DELETE /admin/users/:userId` (`canDeleteUsers`), `POST /admin/users/:userId/email` `{ email }` and `POST /admin/users/:userId/password` `{ password }` (both `canManageCredentials`). It needs the erasure cascade, `PasswordHasher` and `Mailer`, so `Admin` alone still composes without them. Each is fail-closed with its own predicate, gate before existence, and publishes an audited `auth.admin.*` event.

- **`deleteUser`** is `AccountErasure.eraseAccount(userId, { deletedBy: "admin" })`: the same cascade a user's own account deletion runs (accounts, sessions, verification tokens, registered erasure contributions, audit pseudonymization, the `BeforeUserDelete` veto as `HookAborted`). You cannot delete yourself.
- **`setUserEmail`** mails a `change-email` token to the *new* address; the address changes, and becomes verified, only when its owner confirms it at `POST /change-email/confirm` in `@awthaq/password` (so the password plugin must be composed to complete the change). An address already in use is a 409 to the administrator; a failed mail is a typed 502 with nothing changed.
- **`setUserPassword`** hashes through the `PasswordHasher` port, replaces (or creates) the password credential, revokes every session of the user (reason `admin`) in one transaction, and publishes `auth.password.changed` and `auth.admin.userPasswordSet`. The password must satisfy `passwordPolicy` (422 with hints otherwise). You cannot set your own password here. It runs `Hooks.BeforeCredentialReset` with no second-factor code, like a self-service reset that has none: for a user with a confirmed second factor (`@awthaq/two-factor`'s `credentialResetGate`) it answers `403 HookAborted` (`TWO_FACTOR_REQUIRED`) and writes nothing, so an administrator cannot silently replace the password of an MFA-protected account.

Not shipped: `createUser` (create accounts through sign-up or the import tooling, `awthaq import`). **There is deliberately no `setRole` endpoint** — role assignment is a qadi/application concern (ADR-EA-009), not the admin plugin's: who holds which role belongs next to the authorization library, and a second authority here would drift from it.

## Tenant administration (`AdminTenants`)

An opt-in second plugin for a multi-tenant platform (EP-003, BEH-EA-237): `Auth.make([Organization, Admin, AdminTenants])`. It `dependsOn: [Organization]`, so `Admin` alone still composes without the organization plugin. `GET /admin/organizations` (keyset-paginated), `GET /admin/organizations/:organizationId`, `POST .../suspend` `{ reason? }` and `POST .../unsuspend`, all in the admin-tier group `admin.tenants` behind `Api.AdminAuthentication` and `canAdministerTenants` — fail-closed, gate before existence (a denied caller cannot probe which ids exist). Suspending marks the organization; the organization plugin's own checks then refuse every organization-scoped operation and every qadi relationship through it (members and outsiders both get `OrganizationNotFound`), until it is reinstated. Both actions publish audited `auth.admin.organization*` events.

## Serving the admin surface separately

The `admin` group is an admin-tier group (any group id with an `admin` segment is). `Auth.make` returns `api` (everything — serving it is the default, co-hosted setup), `publicApi` and `adminApi`; serve `adminApi` on its own listener or port and firewall it. The group sits behind `Api.AdminAuthentication`, whose default (`Authentication.AdminAuthenticationLive`) just delegates to the ordinary session authentication — provide your own layer to put the admin surface behind mTLS or a service principal without touching the contract.

## Audit integrity

`admin_impersonation` rejects DELETE and any UPDATE other than closing an open episode (database triggers), and every start/end is appended to a hash-chained ledger (`admin_impersonation_chain`). `ImpersonationRecords.verifyChain` reports the first tampered row. Supply a secret with `AuditChain.config({ key })` to make the chain forgery-evident; without one it is an unkeyed hash chain (catches casual edits only). The trigger DDL runs on SQLite and, under `pnpm run test:pg`, on Postgres; the `tenantId` column is frozen by the same triggers and joins the ledger payload only when set, so links written before tenancy still verify.

## Migrating from better-auth's admin plugin

better-auth swaps the session cookie server-side and restores it on stop; awthaq never touches the admin's session, audits every episode, and adds force-stop and history.

| better-auth                                              | awthaq                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `impersonateUser`                                        | `POST /admin/impersonate/:userId` (a `reason` is required)                                 |
| `stopImpersonating`                                      | `POST /admin/stop-impersonating`                                                           |
| `listUsers`                                              | `GET /admin/users`                                                                         |
| `getUser`                                                | `GET /admin/users/:userId`                                                                 |
| `adminUpdateUser`                                        | `PATCH /admin/users/:userId` (`name`, `metadata`)                                          |
| `listUserSessions`                                       | `GET /admin/users/:userId/sessions`                                                        |
| `revokeUserSession` / `revokeUserSessions`               | `DELETE /admin/users/:userId/sessions/:sessionId` / `DELETE /admin/users/:userId/sessions` |
| `banUser` / `unbanUser`                                  | `POST /admin/users/:userId/ban` `{ reason?, until? }` / `POST /admin/users/:userId/unban`  |
| `removeUser`                                             | `DELETE /admin/users/:userId` (`AdminAccounts`, `canDeleteUsers`)                          |
| `setUserPassword`                                        | `POST /admin/users/:userId/password` (`AdminAccounts`, `canManageCredentials`)             |
| email set through `adminUpdateUser`                      | `POST /admin/users/:userId/email` (`AdminAccounts`; the owner confirms by mail)            |
| `setRole`, `createUser`                                  | not shipped (see above)                                                                    |

## Impersonation authority and the JWT `act` claim

Impersonation grants the target's full authority; `actingAs` on the principal is a static attribute, not a scoped delegation. Restricting what an impersonating admin may do is a qadi policy over `subject.attributes.actingAs` (BEH-EA-142). A JWT minted from an impersonation session (`@awthaq/jwt`) carries `sub` = the target and an RFC 8693 `act` claim `{ "sub": "<admin id>", "awthaq_actor_type": "<principal type>" }` identifying who is really acting.
