---
"@awthaq/qadi": patch
---

`SubjectExtractorLive` falls through to the next credential when one does not resolve, as `Authentication` does: a stale session cookie beside a valid bearer token, or an unresolvable `x-api-key` beside one, is now the bearer's subject instead of anonymous (BEH-EA-153). An impersonation cookie is judged on its session's `actingAs`.
