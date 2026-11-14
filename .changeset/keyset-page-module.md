---
"@awthaq/ports": minor
"@awthaq/sql": minor
"@awthaq/admin": minor
"@awthaq/organization": minor
"@awthaq/core": minor
"@awthaq/test": minor
---

Users, organizations and impersonation history now page through one keyset module: `Keyset` in `@awthaq/ports` (`paginate`, `window`, `limit`, `Page`, `Request`, `MIN_LIMIT`, `MAX_LIMIT`, `DEFAULT_LIMIT`) owns the limit rule, the one extra row and the next cursor, and `KeysetSql` in `@awthaq/sql` owns the row-value seek and its `ORDER BY`. Wire cursors, limits and order are unchanged (BEH-EA-036). The users `StoreContract` suite gains page-order cases.

Migration: a `UserStore.listPage` page now has the field `nextCursor` where it had `next`, and `listPage` takes a `Keyset.Request` (`after`, `limit`); sort users with `Keyset.window(UserStore.pageOrder, rows, fetch)` in place of the removed `UserStore.byCreation`; `Users.UsersPage` and `Users.UserCursor` are aliases of the shared page and cursor (shape unchanged). `OrganizationRecords.listPage` and `OrganizationDirectory.listPage` answer a `Keyset.Page` (`items`, `nextCursor`) instead of an array and normalise the limit themselves, so pass the caller's limit straight through and stop adding one and trimming. Use `Keyset.limit` and `Keyset.DEFAULT_LIMIT` in place of the removed `ImpersonationRecords.pageLimit` and `ImpersonationRecords.DEFAULT_PAGE_SIZE`, and `Keyset.MAX_LIMIT` in place of the removed `AdminApi.MAX_PAGE_SIZE`; `ImpersonationRecords.ImpersonationPage`, `AdminTenants.OrganizationCursor` and `AdminTenants.OrganizationPage` are aliases of the shared page. A third-party `UserStore` implements `listPage` with `Keyset.paginate` and must pass the new `StoreContract` page-order cases.
