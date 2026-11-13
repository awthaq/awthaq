---
"@awthaq/saml": minor
---

The SAML ACS lands through the same-site interstitial while the session cookie is `SameSite=Strict` (BEH-EA-350).

The IdP's POST is cross-site, so a `302` kept the landing request in a cross-site redirect chain and the browser withheld the `Strict` session cookie: the first page after sign-in looked signed out. The ACS now answers a `200 text/html` page whose meta refresh starts a fresh same-site navigation, which carries the cookie, exactly as the OAuth callback does (PV-016). The ACS contract's success is now `302` or `text/html`.

Migration: a host or test that asserted the ACS's `302` under the default cookie now sees a `200` interstitial with the same `Set-Cookie`; `SessionCookie.config({ mode: SessionCookie.HostLax })` keeps the `302`. A deployment that worked around the signed-out first landing (a client-rendered landing route, a re-navigating page) can drop the workaround. BEH-EA-350, BEH-EA-055.
