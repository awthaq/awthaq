# @awthaq/next

## 0.2.0

### Minor Changes

- 85c9e47: `@awthaq/server`'s `Credentials` module is the one place a request's credentials are read, ordered, resolved, admitted and their rotation handed off (ADR-EA-042). `Authentication`, `SubjectExtractorLive` and `getSession` are adapters over it. A tier now also refuses a session-derived principal it does not admit. A claimed credential (API key, JWT) is resolved at most once per request.
  
  Migration: `Authentication.PrincipalResolver*`, `Authentication.contribute`, `Authentication.CredentialResolvers*` -> `Credentials.*` (same names; `Authentication.CredentialCarrier` is `Credentials.ClaimCarrier`). `Authentication.resolvePrincipal`/`resolveSession`/`ResolvedSession` are gone: use `Credentials.make` and `step`/`resolve` with `Credentials.httpScope(request)`, and `Sessions.VerifiedSession`. Web: `verifySessionToken`/`VerifySessionToken` -> `resolveSessionCookies`/`ResolveSessionCookies` (the whole cookie header is the dedup unit); `Session.principal` is `Api.UserPrincipal`.
- 349acb4: awthaq now builds on stable effect 4.1 and takes effect, `@effect/*`, qadi and React from the host application instead of bundling them.
  
  - **effect 4.0.0-rc.116 → 4.1.2, qadi 0.8 → 0.11.** Module paths follow effect's stable layout (`effect/http`, `effect/http-api`, `effect/sql`, `effect/encoding/*`).
  - **Peer dependencies.** Every package except `@awthaq/cli` declares `effect` (and, where used, `@effect/*`, `@qadi/*`, React) as `peerDependencies` with a range (`effect: ^4.1.0`, `@qadi/*: ^0.11.0`), so an application has exactly one copy of each. Install them next to awthaq. `pnpm package:smoke` now fails a package that bundles one of them or publishes an exact or prerelease peer.
  - **Crypto services (breaking).** effect 4.1 removed the `Crypto` service. Layers now require effect's `SecureRandom`, `Digest` and/or `Mac` (`effect/crypto/*`) instead; `NodeCrypto.layer` provides all of them, and `@awthaq/ports`' `WebCrypto.layer` now provides the same three over `globalThis.crypto` (`WebCrypto.Services`). Helpers that took a `Crypto` take the specific service: `Hmac.hmacSha256(mac, ...)`, `SecretHash.digest(hasher, ...)`, `Totp.hotp/totp/verifyTotp(mac, ...)`, `RecoveryCodes.generate(random, ...)`, `UserCode.generate(random)` / `hash(hasher, ...)`, and `VerificationLink.issue`/`EmailChange.request` deps take `random` instead of `crypto`. Random bytes and digests no longer fail, so the `PlatformError` → `StoreUnavailable` paths they fed are gone.
  - **`@awthaq/react`** re-exports qadi 0.11's seeded-decision API (`DecisionOutcome`, `SeededAllow`, `SeededDeny`, `isSeeded`, `outcomeOf`, `permits`, `ClientDecision`, `SeededDecision`); the new gate-registry instrumentation (`makeGateRegistry`, `useGateInstances`) is left to `@qadi/react`.
- b771d36: Extract the framework-neutral adapter core into a new `@awthaq/web` package (BO-004): the cookie-jar bridge (`applyResponseCookies`), database-verified `getSession`/`makeGetSession`/`applyRotatedSession`, `hasSessionCookie`, and the CSRF-echoing in-process client (`makeInProcessClient`/`inProcessClient`), plus an edge-safe `@awthaq/web/cookies` subpath. `@awthaq/next` is now the Next adapter over it and keeps its public names (`getSession`, `withNextCookies`, `serverActionClient`, ...), so an Astro or SvelteKit adapter can reuse the core.
  
  `CookieJarLike.set` now receives an explicit `path` (BO-010; defaulted to `/` when a `Set-Cookie` omits it), so SvelteKit's `Cookies.set` and Astro's `AstroCookies.set` are structurally accepted.
  
  Migration: `@awthaq/next` no longer depends on `@awthaq/client`/`@awthaq/core` directly; import framework-neutral helpers from `@awthaq/web` in non-Next code. A custom jar whose `set` declared `options?: CookieSetOptions` keeps working unchanged.
- 9cdebdd: `getSession` and `applyRotatedSession` honour the configured `SessionCookieConfig`: under `SessionCookie.SecureDomain` the session is read from `__Secure-session` (and `__Secure-impersonation`) and a rotation is written with the configured name, `Domain` and `SameSite` (BEH-EA-055/185). `hasSessionCookie` checks the configured name (BEH-EA-188). `Api.sessionCookieName` is the one naming rule; `hasSessionCookie` is also exported from `@awthaq/web/cookies`.
  
  Migration: `hasSessionCookie(request)` -> `hasSessionCookie(request, cookie)`, passing the same partial you give `SessionCookie.config(...)` (`{}` for the default). `Session.rotated` is now `{ token, cookie }`; read `rotated.token` where you read the raw secret.

### Patch Changes

- 09d61ca: README recipes point at `AuthHost.layer`: the CLI's `app` is the served composition with `migrations: "verify"` (a `seed admin` or `import` run never migrates behind `migration apply --yes`), the Next adapter's in-process handler serves an `AuthHost` layer, and the SQL package's "Two ledgers" note says `AuthHost` and `awthaq migration apply` run core then plugins through `Migrations.apply`, refusing a drifted ledger.
  
  Migration: none (documentation only).
- Updated dependencies [89fb48c]
- Updated dependencies [f810dcd]
- Updated dependencies [1cef4be]
- Updated dependencies [1cef4be]
- Updated dependencies [85c9e47]
- Updated dependencies [8dd72b6]
- Updated dependencies [2c3c400]
- Updated dependencies [3514b28]
- Updated dependencies [349acb4]
- Updated dependencies [1cef4be]
- Updated dependencies [1cef4be]
- Updated dependencies [60ffc76]
- Updated dependencies [1cef4be]
- Updated dependencies [4353896]
- Updated dependencies
- Updated dependencies [40c84f1]
- Updated dependencies [9e6302f]
- Updated dependencies [3d00f58]
- Updated dependencies
- Updated dependencies [1371d7b]
- Updated dependencies [f8df2e4]
- Updated dependencies [d82b7a4]
- Updated dependencies [36951f5]
- Updated dependencies [7e9834e]
- Updated dependencies [01b82ea]
- Updated dependencies [1cef4be]
- Updated dependencies [401a719]
- Updated dependencies [a232d8e]
- Updated dependencies [fc20f74]
- Updated dependencies [0304c39]
- Updated dependencies [40a32a1]
- Updated dependencies [b771d36]
- Updated dependencies [9cdebdd]
- Updated dependencies [d8b7f18]
  - @awthaq/server@0.2.0
  - @awthaq/api@0.2.0
  - @awthaq/jwt@0.2.0
  - @awthaq/web@0.2.0

## 0.1.0

### Patch Changes

- @awthaq/api@0.1.0
  - @awthaq/core@0.1.0
  - @awthaq/react@0.1.0
  - @awthaq/server@0.1.0
