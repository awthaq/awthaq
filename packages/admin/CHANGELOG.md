# @effect-auth/admin

## 0.1.0

### Minor Changes

- Add the `Admin` plugin: config-gated, fail-closed-by-default user
  impersonation with a durable, queryable audit trail
  (`admin.impersonate`/`stopImpersonating`/`forceStop`/`list`). Impersonation
  sessions carry a hard expiry with no idle refresh and never touch the
  target user's own sessions.

### Patch Changes

- @effect-auth/api@0.1.0
  - @effect-auth/core@0.1.0
  - @effect-auth/ports@0.1.0
  - @effect-auth/server@0.1.0
  - @effect-auth/sql@0.1.0
