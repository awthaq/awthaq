# @awthaq/admin

## 0.1.0

### Minor Changes

- Add the `Admin` plugin: config-gated, fail-closed-by-default user
  impersonation with a durable, queryable audit trail
  (`admin.impersonate`/`stopImpersonating`/`forceStop`/`list`). Impersonation
  sessions carry a hard expiry with no idle refresh and never touch the
  target user's own sessions.

### Patch Changes

- @awthaq/api@0.1.0
  - @awthaq/core@0.1.0
  - @awthaq/ports@0.1.0
  - @awthaq/server@0.1.0
  - @awthaq/sql@0.1.0
