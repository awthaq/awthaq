---
"@awthaq/test": major
---

`TestAuth.app` and `App.dispose` are removed. An app is acquired only through `TestAuth.serve`, `withApp`, `lazyApp` or `listen`, so it cannot outlive the scope that served it (BEH-EA-351).

Migration: inside `it.effect`, `const app = yield* TestAuth.serve(layer, options)` (the test's scope releases it); in an async test, `await TestAuth.withApp(layer, options, async (app) => …)`; a World holds `TestAuth.lazyApp(...)`; a socket server is `TestAuth.listen(...)`.
