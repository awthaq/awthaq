---
"@awthaq/organization": minor
---

Organization's authorized interface takes the domain caller instead of the wire principal.

Migration: Organization's authorized methods take `CurrentUser.Caller` (wrap a principal with `CurrentUser.of`); `OrganizationActiveContext.sessionOf` takes a Caller.
