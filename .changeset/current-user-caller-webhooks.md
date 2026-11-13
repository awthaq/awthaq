---
"@awthaq/webhooks": minor
---

The webhooks admin operations take `CurrentUser.Caller` instead of `Api.UserPrincipal`.

Migration: the webhooks admin operations take CurrentUser.Caller; pass CurrentUser.of(principal) or yield* CurrentUser.current.
