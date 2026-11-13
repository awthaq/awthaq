---
"@awthaq/admin": minor
---

Migration: Admin, AdminAccounts and AdminTenants operations take CurrentUser.Caller; pass CurrentUser.of(principal) or yield* CurrentUser.current.
