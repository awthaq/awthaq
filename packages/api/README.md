# @awthaq/api

Contract stratum (1): the isomorphic HTTP contract — no server code, importable in the browser.

**Shipped**

- `Api` (`Api.ts`, BEH-EA-025/027/028/029/030): the `Principal` variants (`UserPrincipal`, `ApiKeyPrincipal`, `ServicePrincipal`, `anonymousPrincipal`), the contract errors (`Unauthenticated`, `InvalidCredentials`, `CsrfRejected`, `ReauthRequired`, ...) and the `Authentication` / `OptionalAuthentication` / `CsrfProtection` middleware *declarations*.
- `SessionContract` (`Session.ts`, BEH-EA-031): the core `session` group (`/session`, `/session/list`, `/session/sign-out`, `/session/revoke*`).
- `AccountContract`, `AuthCore` (the shared `"auth"` HttpApi id the core groups mount under) and `SubjectContract` (`SubjectDto`, the wire shape of qadi's `AuthSubject`).

**Not yet**: `SessionView` as one combined struct (BEH-EA-026) and folding the core groups into `Auth.make`'s composed `api` (BEH-EA-032) — the core groups are served standalone via `AuthCore.AuthCoreApi` today.

See [`spec/behaviors/04-contract-stratum.md`](../../spec/behaviors/04-contract-stratum.md) and [`spec/overview.md`](../../spec/overview.md).
