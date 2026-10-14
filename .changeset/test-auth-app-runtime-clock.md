---
"@awthaq/test": minor
---

`TestAuth.app` hands a World everything it used to build by hand, and `TestAuth.buildContext` builds any layer on the real clock (plan 08 follow-up).

- `app.runtime` (a `ManagedRuntime` over the same composition), `app.memoMap` and `app.context()` (the composition built once on the real clock, for effects run on the caller's own fiber) all resolve against the instances `app.handler` serves from.
- `TestAuth.app(layer, { testClock: true })` serves the composition over one `TestClock`; `app.advance(duration)` moves it for the handler, `run` and `runtime` alike, and `request` stamps its CSRF pair from that clock. Without the option `advance` rejects.
- `TestAuth.app(layer, { memoMap })` builds into a memo map the caller owns, so two apps share the instances they have in common.
- `TestAuth.buildContext(layer, { scope, memoMap? })` builds any layer into a context on the real clock.

Additive: existing `TestAuth.app` callers are unchanged (`App` gains an optional second type parameter, `E`, for `runtime`).
