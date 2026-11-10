---
"@awthaq/saml": minor
---

`Saml.logout` takes the domain caller.

Migration: `Saml.logout` takes `CurrentUser.Caller` (`CurrentUser.of(principal)` from a principal).
