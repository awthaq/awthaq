# @awthaq/oauth

## 0.2.0

### Minor Changes

- e073887: The OAuth callback lands through a same-site interstitial while the session cookie is `SameSite=Strict` (PV-016).
  
  A `Strict` session cookie set on a redirect chain the provider began cross-site is stored but withheld from the first landing request, so a server-rendered landing page saw an anonymous request once. `OAuthConfig.bounce` (default `true`) makes a browser callback answer `200 text/html`, a small `no-store` page that meta-refreshes to the `callbackURL`, in place of the `302`; the session cookie is set on that response as before and the follow-up navigation (initiated by a page of your own site) carries it. The native deep-link return (`mode=native`) and `Lax`/`None` session cookies never bounce. `@awthaq/core` exports `SessionCookie.isStrict`; the callback's declared success type is now `302` or `text/html`; the native outcome of `OAuth.callback` gains `native: true`.
  
  Migration: a host or test that asserted the callback's `302` under the default `Strict` cookie now sees a `200` interstitial with the same `Set-Cookie`; set `OAuth.config({ bounce: false })` to keep the plain `302`. BEH-EA-122, BEH-EA-055.

### Patch Changes

- 4688890: Plugins declare their rate-limit rules and required ports statically, and `awthaq plugin list` prints them (PV-241).
  
  - `@awthaq/core`: `AuthPlugin.Service`'s `rateLimits` (each rule's `group` is confined to the plugin's own contract groups by the compiler; `AuthPlugin.declareRateLimits`, `RateLimits.registerDeclared` and `RateLimits.declarationDrift` keep the declaration and the registry from drifting) and `AuthPlugin.layer`'s `ports` (port classes that join the layer's `RIn`; a required `.../ports/...` service that is not declared fails to type-check). Both reach `Auth.make(...).manifest` as `rateLimits` and `ports`, and as the class statics `Plugin.rateLimits` / `Plugin.ports`.
  - `@awthaq/cli`: `plugin list --rules` prints the declared rules; `plugin list --graph` now prints each plugin's required ports and where its declared taps sit in each hook chain (BEH-EA-202, BEH-EA-111).
  - Every shipped plugin that requires ports now declares them; password, oauth, passkey, api-key, magic-link (and email-otp) and two-factor declare their rate-limit rules. `@awthaq/api-key` also registers its per-client token budget, which was enforced but not listed.
  
  Migration: a plugin that calls `AuthPlugin.layer` and requires an `@awthaq/ports` service (`Mailer`, `RateLimiter`, `PasswordHasher`, ...) must add `ports: [...]` naming it, or it no longer type-checks (the message lists the missing keys). A hand-built `Manifest` value (a test fixture) needs `rateLimits: []` and `ports: []`. BEH-EA-111, BEH-EA-202.
- Updated dependencies
- Updated dependencies [d7351b7]
- Updated dependencies [8dd72b6]
- Updated dependencies [3514b28]
- Updated dependencies [cb155d4]
- Updated dependencies [f831b6c]
- Updated dependencies [e073887]
- Updated dependencies
- Updated dependencies [4688890]
- Updated dependencies
- Updated dependencies [4cd6174]
- Updated dependencies [5d5b3c6]
- Updated dependencies
  - @awthaq/core@0.2.0
  - @awthaq/server@0.2.0
  - @awthaq/api@0.2.0
  - @awthaq/ports@0.2.0

## 0.1.0

### Patch Changes

- @awthaq/api@0.1.0
  - @awthaq/core@0.1.0
  - @awthaq/ports@0.1.0
  - @awthaq/server@0.1.0
  - @awthaq/sql@0.1.0
