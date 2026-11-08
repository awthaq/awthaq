---
"@awthaq/cli": minor
---

`awthaq doctor` warns about an endpoint whose last (outermost) middleware is not `RequestContext` (`request-context-missing`, ADR-EA-047): such a group compiles when nothing in it reads the request context, but its events and audit rows carry no correlation id, address or user agent.

Migration: declare `.middleware(Api.RequestContext)` last on your own groups (`extraGroups`) to clear the warning.
