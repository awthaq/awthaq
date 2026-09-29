---
"@awthaq/oauth": minor
"@awthaq/core": minor
---

The OAuth callback lands through a same-site interstitial while the session cookie is `SameSite=Strict` (PV-016).

A `Strict` session cookie set on a redirect chain the provider began cross-site is stored but withheld from the first landing request, so a server-rendered landing page saw an anonymous request once. `OAuthConfig.bounce` (default `true`) makes a browser callback answer `200 text/html`, a small `no-store` page that meta-refreshes to the `callbackURL`, in place of the `302`; the session cookie is set on that response as before and the follow-up navigation (initiated by a page of your own site) carries it. The native deep-link return (`mode=native`) and `Lax`/`None` session cookies never bounce. `@awthaq/core` exports `SessionCookie.isStrict`; the callback's declared success type is now `302` or `text/html`; the native outcome of `OAuth.callback` gains `native: true`.

Migration: a host or test that asserted the callback's `302` under the default `Strict` cookie now sees a `200` interstitial with the same `Set-Cookie`; set `OAuth.config({ bounce: false })` to keep the plain `302`. BEH-EA-122, BEH-EA-055.
