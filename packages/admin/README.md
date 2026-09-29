# @awthaq/admin

Admin plugin: **impersonation** (off by default, admin-gated, reason required, hard expiry, dual identity, fully audited — NFR-EA-007) and **user and session administration**. Everything is fail-closed: an unconfigured deployment denies every operation.

Behavior is specified in [`spec/behaviors/27-admin-impersonation.md`](../../spec/behaviors/27-admin-impersonation.md) (BEH-EA-209 through 224); [`spec/overview.md`](../../spec/overview.md) has the package map.

## Configure the gates

```ts
Admin.config({
  maxDuration: Duration.hours(1), // hard expiry of every impersonation session
  canImpersonate: ({ admin, target }) => Effect.succeed(/* your policy */ false),
  canManageEpisode: ({ admin, episode }) => Effect.succeed(false), // optional; defaults to canImpersonate(admin, episode.target)
  canManageUsers: ({ admin, target }) => Effect.succeed(false), // target is None for listUsers
});
```

Every predicate defaults to "deny", and every one **sees the target** — so a host can refuse to impersonate or administer a more privileged account (or another tenant's). Subjects are identity-only (`{ id }`); a predicate that needs roles or tenant looks them up itself by id. `list` filters impersonation episodes through `canManageEpisode` row by row, so a caller who may manage none sees an empty history.

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

Not shipped yet (tracked under BAM-005): ban/unban and the sign-in gate, user deletion, admin email/password change, and the superadmin tenant-administration surface. **There is deliberately no `setRole` endpoint** — role assignment is a qadi/application concern (ADR-EA-009), not the admin plugin's.

## Serving the admin surface separately

The `admin` group is an admin-tier group (any group id with an `admin` segment is). `Auth.make` returns `api` (everything — serving it is the default, co-hosted setup), `publicApi` and `adminApi`; serve `adminApi` on its own listener or port and firewall it. The group sits behind `Api.AdminAuthentication`, whose default (`Authentication.AdminAuthenticationLive`) just delegates to the ordinary session authentication — provide your own layer to put the admin surface behind mTLS or a service principal without touching the contract.

## Audit integrity

`admin_impersonation` rejects DELETE and any UPDATE other than closing an open episode (database triggers), and every start/end is appended to a hash-chained ledger (`admin_impersonation_chain`). `ImpersonationRecords.verifyChain` reports the first tampered row. Supply a secret with `AuditChain.config({ key })` to make the chain forgery-evident; without one it is an unkeyed hash chain (catches casual edits only). The Postgres trigger DDL is untested in this repository (SQLite only).

## Migrating from better-auth's admin plugin

better-auth swaps the session cookie server-side and restores it on stop; awthaq never touches the admin's session, audits every episode, and adds force-stop and history.

| better-auth                                                                      | awthaq                                                                                     |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `impersonateUser`                                                                | `POST /admin/impersonate/:userId` (a `reason` is required)                                 |
| `stopImpersonating`                                                              | `POST /admin/stop-impersonating`                                                           |
| `listUsers`                                                                      | `GET /admin/users`                                                                         |
| `getUser`                                                                        | `GET /admin/users/:userId`                                                                 |
| `adminUpdateUser`                                                                | `PATCH /admin/users/:userId` (`name`, `metadata`)                                          |
| `listUserSessions`                                                               | `GET /admin/users/:userId/sessions`                                                        |
| `revokeUserSession` / `revokeUserSessions`                                       | `DELETE /admin/users/:userId/sessions/:sessionId` / `DELETE /admin/users/:userId/sessions` |
| `banUser`, `unbanUser`, `removeUser`, `setUserPassword`, `setRole`, `createUser` | not shipped (see above)                                                                    |
