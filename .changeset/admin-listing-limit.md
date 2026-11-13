---
"@awthaq/admin": patch
---

An in-process `limit` outside 1..200 on the impersonation listing and `AdminTenants.listOrganizations` is normalised (truncated, clamped, 50 when absent or non-finite) instead of answering an empty page or a store failure.

Migration: none.
