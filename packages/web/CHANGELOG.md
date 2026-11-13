# @awthaq/web

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
- d8b7f18: `UserAgent` and `makeCookieStore`: an in-process user agent over a web handler, with an RFC 6265bis cookie store (`browser` and `trusted` policies), the CSRF echo, bearer delivery that follows `set-auth-token` and `x-awthaq-session-ended`, and cross-site simulation (`site`, `navigation`) (BEH-EA-344). `UserAgent.client(agent, api)` is a typed `HttpApiClient` over an agent. `inProcessClient`/`makeInProcessClient` are built on it (`trusted` policy) and now honour `Expires` and `Path` within an action. `parseSetCookie` also returns `rawValue` and `options.partitioned`; `parseCookieHeader` and `decodeCookieValue` are exported.
  
  Migration: none for the API. A server action that relied on a cookie expired by `Expires` alone, or scoped to another `Path`, still reaching the action's later calls no longer gets it.

### Patch Changes

- Updated dependencies
- Updated dependencies [a95959c]
- Updated dependencies [89fb48c]
- Updated dependencies [f810dcd]
- Updated dependencies [a06b7c5]
- Updated dependencies [1cef4be]
- Updated dependencies [1cef4be]
- Updated dependencies [d7351b7]
- Updated dependencies [b97c8c2]
- Updated dependencies [9416e17]
- Updated dependencies [fe9dc94]
- Updated dependencies [2706762]
- Updated dependencies [50a23f8]
- Updated dependencies [85c9e47]
- Updated dependencies [8dd72b6]
- Updated dependencies [1cef4be]
- Updated dependencies [2c3c400]
- Updated dependencies [3514b28]
- Updated dependencies [349acb4]
- Updated dependencies [cb155d4]
- Updated dependencies [3b99770]
- Updated dependencies [14bc1bc]
- Updated dependencies [2dff755]
- Updated dependencies [f831b6c]
- Updated dependencies [1cef4be]
- Updated dependencies [6070f7f]
- Updated dependencies [e073887]
- Updated dependencies [a305c26]
- Updated dependencies [3917b38]
- Updated dependencies [81d4323]
- Updated dependencies [f4cf736]
- Updated dependencies
- Updated dependencies [7f3f6bf]
- Updated dependencies [273f910]
- Updated dependencies [8eef209]
- Updated dependencies [5a3998d]
- Updated dependencies [8fda479]
- Updated dependencies [40c84f1]
- Updated dependencies [4f65d9e]
- Updated dependencies [6355450]
- Updated dependencies [fcdb168]
- Updated dependencies [f0f2f3e]
- Updated dependencies [2e56459]
- Updated dependencies [ef9846c]
- Updated dependencies [72a2e78]
- Updated dependencies [ae1175d]
- Updated dependencies [161d66c]
- Updated dependencies [d3a548f]
- Updated dependencies [93f2469]
- Updated dependencies [f005a91]
- Updated dependencies [75cc655]
- Updated dependencies [4379a62]
- Updated dependencies [9e6302f]
- Updated dependencies [4688890]
- Updated dependencies [3d00f58]
- Updated dependencies
- Updated dependencies [38ca611]
- Updated dependencies [4d9fed1]
- Updated dependencies [1371d7b]
- Updated dependencies [6a28c4d]
- Updated dependencies [6cebb31]
- Updated dependencies [d82b7a4]
- Updated dependencies [28a78b0]
- Updated dependencies [0e74d59]
- Updated dependencies [36951f5]
- Updated dependencies [7e9834e]
- Updated dependencies [01b82ea]
- Updated dependencies [1cef4be]
- Updated dependencies [401a719]
- Updated dependencies [a232d8e]
- Updated dependencies [fc20f74]
- Updated dependencies [2be1097]
- Updated dependencies [4cd6174]
- Updated dependencies [6a06f06]
- Updated dependencies [6d797b0]
- Updated dependencies [b0b6a4d]
- Updated dependencies [f58b51f]
- Updated dependencies [0304c39]
- Updated dependencies [79909fa]
- Updated dependencies [e3cf8fe]
- Updated dependencies [896a1de]
- Updated dependencies [1c01e7f]
- Updated dependencies [942e1d8]
- Updated dependencies [2f1b966]
- Updated dependencies [b4ab289]
- Updated dependencies [2ab9920]
- Updated dependencies [b4b0de9]
- Updated dependencies [40a32a1]
- Updated dependencies
- Updated dependencies [e6c3620]
- Updated dependencies [37e5cdd]
- Updated dependencies [c0e7bd9]
- Updated dependencies [020abf8]
- Updated dependencies [9cdebdd]
  - @awthaq/core@0.2.0
  - @awthaq/server@0.2.0
  - @awthaq/client@0.2.0
  - @awthaq/api@0.2.0
