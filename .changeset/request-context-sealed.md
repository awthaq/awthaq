---
"@awthaq/core": minor
"@awthaq/admin": minor
"@awthaq/test": minor
---

The request context is required by core (ADR-EA-047). `Sessions.issue` takes no `request` and requires `Api.AuthRequestContext`, recording the facts of the request that minted the session (none under `noRequest`); `SignIn.clear`, `resume`, `issue`, `complete` and `failed` and `SignUp.createSignedIn` take no request facts and require it too; `SignIn.SessionRequest` is gone. `Admin.impersonate` requires it (the impersonation session records the administrator's request). `TestAuth.signInAs` provides it itself.

Migration: drop `request` from `Sessions.issue` calls and the second argument of `SignIn.issue`/`complete` and the third of `SignUp.createSignedIn`; provide `Api.AuthRequestContext` to an in-process call (`Api.AuthRequestContext.noRequest` for a job, `RequestContext.capture(request)` on a host route, `TestAuth.withRequest`/`withoutRequest` in a test).
