---
"@awthaq/test": minor
---

`TestAuth.layer` now also provides `Authentication.PrincipalResolver` (the one its derived middleware uses, or `options.principalResolver`), so a test that calls `Authentication.resolvePrincipal` directly reads it from the composition instead of hand-building `PrincipalResolverLive`.
