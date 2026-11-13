---
"@awthaq/core": minor
---

`CurrentUser.current` returns a `CurrentUser.Caller` only; the transitional `principal` field is gone. `CurrentUser.of` is the one re-brand of a verified user principal.

Migration: CurrentUser.current no longer returns principal; read userId, sessionId, actingAs, or Api.CurrentPrincipal if the wire principal is needed.
