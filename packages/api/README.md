# @awthaq/api

Contract stratum (1): the isomorphic HTTP contract — no server code, importable in the browser.

**Shipped**

- `Api` (`Api.ts`, BEH-EA-025/027/028/029/030): the `Principal` variants (`UserPrincipal`, `ApiKeyPrincipal`, `ServicePrincipal`, `anonymousPrincipal`), the contract errors (`Unauthenticated`, `InvalidCredentials`, `CsrfRejected`, `ReauthRequired`, ...) and the `Authentication` / `OptionalAuthentication` / `CsrfProtection` middleware _declarations_.
- `SessionContract` (`Session.ts`, BEH-EA-031): the core `session` group (`/session`, `/session/list`, `/session/sign-out`, `/session/revoke*`).
- `AccountContract`, `AuthCore` (the shared `"auth"` HttpApi id the core groups mount under) and `SubjectContract` (`SubjectDto`, the wire shape of qadi's `AuthSubject`).

**Composition** (MW-002): `Auth.make(...).api` always carries `AuthCore.AuthCoreApi`'s `session`/`account` groups beside the plugins' (BEH-EA-032), so `AuthCoreApi` is the typed input `@awthaq/server`'s handlers are built against, not a second served document.

**Not yet**: `SessionView` as one combined struct (BEH-EA-026).

See [`spec/behaviors/04-contract-stratum.md`](../../spec/behaviors/04-contract-stratum.md) and [`spec/overview.md`](../../spec/overview.md).
