---
"@awthaq/password": minor
---

`Password` reads no request facts (ADR-EA-047). `signUp`, `signUpConcealed`, `signIn`, `requestReset`, `resendVerification`, `confirmReset`, `verifyEmail`, `confirmEmailChange` and `changePassword` take no `ip` or `userAgent` and require `Api.AuthRequestContext`, which the `RequestContext` middleware provides per request: the session records the request's address and user agent, the per-source rules key on its address, and `auth.user.signInFailed` is published through core's `SignIn.failed`. The plugin layer no longer requires `ClientAddress`.

Migration: drop `ip` and `userAgent` from calls to `Password.signUp`, `signUpConcealed`, `signIn`, `requestReset`, `resendVerification`, `confirmReset`, `verifyEmail`, `confirmEmailChange` and `changePassword`. An in-process caller provides the context: `Effect.provideService(Api.AuthRequestContext, Api.AuthRequestContext.noRequest)` for a job, `RequestContext.capture(request)` for a host route, or `TestAuth.withRequest`/`withoutRequest` in a test.
