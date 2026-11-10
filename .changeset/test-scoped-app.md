---
"@awthaq/test": minor
---

`TestAuth.serve` and `TestAuth.withApp` serve a composition for as long as the caller's scope (or callback) is open and release everything it built (BEH-EA-351). `testClock: "now"` starts the simulated clock at the wall clock. `TestAuth.lazyApp` is a World's one lazy app cell (BEH-EA-352). `TestAuth.listen` also binds the app to `127.0.0.1` on an ephemeral port and logs the socket's requests (BEH-EA-353). `TestAuth.openApps` and `TestSql.openClients` count what is still open. `TestAuth.app` is now deprecated.

Migration: none yet; `TestAuth.app` keeps working (its `dispose` is unchanged) until a later release removes it.
