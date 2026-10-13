---
"@awthaq/password": patch
"@awthaq/admin": patch
"@awthaq/oauth": patch
---

A store outage while minting the replacement session in `changePassword`, or the impersonation session in `Admin.impersonate`, is now the typed `StoreUnavailable` the Shape already declared instead of a defect (ADR-EA-028). OAuth answers a concurrent first login that linked the same provider identity as the one opaque callback failure instead of a defect.
