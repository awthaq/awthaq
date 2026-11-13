---
"@awthaq/saml": minor
---

SAML admin operations take the domain caller instead of the wire principal.

Migration: `SamlAdmin` operations take `CurrentUser.Caller` (`CurrentUser.of(principal)` from a principal).
