---
plan: 33-browser-return-trip
ticket: 01
title: "Red: the SAML ACS's first landing request is signed out under a Strict session cookie"
type: tdd
wave: 0
depends_on: []
files_modified:
  - packages/saml/test/SamlHttp.test.ts
autonomous: true
requirements: [REQ-EA-1540, REQ-EA-1541, REQ-EA-1542]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "A test follows the ACS response the way a browser does and asserts the first landing request (GET /session) is signed in under the default Host cookie; it fails at HEAD with 401"
    - "A test asserts that under HostLax the ACS answers 302 and the landing is signed in; it passes at HEAD (regression guard)"
  artifacts:
    - "packages/saml/test/SamlHttp.test.ts: helper acsLandingChain and three new it.effect cases tagged PV-016 / BEH-EA-353"
  key_links:
    - "postToAcs (cross-site POST navigation) -> response -> follow: a 302 Location as a cross-site navigation, a 200 interstitial's meta refresh as same-origin -> GET /session"
---
Status: done (uncommitted)
Blocked by: none

<objective>
Reproduce live bug B1 (PLAN.md §2.3) as failing tests, before any fix. The SAML ACS answers a plain `302` whatever the session cookie mode. Under the default `Host` mode (`SameSite=Strict`), the browser withholds the cookie from the first landing request, because the redirect chain began with the IdP's cross-site POST. OAuth's PV-016 tests (`packages/oauth/test/AuthHttp.test.ts:397-456`) already prove that this repo's browser model behaves this way.

Purpose: the hotfix (ticket 03) needs a red test that a browser-faithful model turns green. If the default-mode test **passes** at HEAD, stop: the reading was wrong, and plan 33's gate is NO-GO for tickets 02–09 (PLAN.md §1). Keep the tests as regression tests and report.

Output: three new cases in `SamlHttp.test.ts`. One is red at HEAD and two are green. They are not committed red: the red run's output goes in the commit body of the commit that lands ticket 03 (plan 30 precedent).
</objective>

<context>
@.planning/33-browser-return-trip/PLAN.md (sections 2.2, 2.3, 5)
@packages/saml/test/SamlHttp.test.ts (buildApp, postToAcs, requestIdOf, the ACS success test at :198-233)
@packages/oauth/test/AuthHttp.test.ts (:397-456 landingChain: how the agent follows a 302 vs an interstitial)
@packages/saml/test/support.ts (SamlLive, seedConnection, BASE_URL, IDP_ENTITY_ID)
@packages/saml/test/samlFixtures.ts (signedResponse, responseXml, SP_ENTITY_ID_PREFIX)
@packages/core/src/SessionCookie.ts (config, HostLax)
@packages/web/src/UserAgent.ts (request options: site, navigation)
</context>

<tasks>
<task type="tdd">
  <name>Task 1: the ACS landing-chain helper and the default-mode red case</name>
  <files>packages/saml/test/SamlHttp.test.ts</files>
  <read_first>packages/saml/test/SamlHttp.test.ts; packages/oauth/test/AuthHttp.test.ts lines 397-466; packages/saml/test/support.ts</read_first>
  <behavior>
    - Under the default composition, after login with callbackURL=/session and a valid IdP POST to the ACS, following the ACS response yields GET /session status 200 (signed in).
    - The ACS response under the default mode is status 200, content-type starts with text/html, has no location header, has cache-control no-store and referrer-policy no-referrer, carries a Set-Cookie for __Host-session with SameSite=Strict, and its body contains the meta refresh content="0;url=/session".
  </behavior>
  <action>
    Give `buildApp` an optional `layer` argument, so a case can pass `SamlLive()` merged with `SessionCookie.config({ mode: SessionCookie.HostLax })` through `Layer.provideMerge`, as `AuthHttp.test.ts:386-388` does for OAuth. The default stays `SamlLive()`. Import `SessionCookie` from `@awthaq/core` and `Layer` from `effect/Layer` if not already imported.

    Add a helper `acsLandingChain(layer?)` next to `postToAcs`. It builds the app, seeds a connection, takes a fresh `agent()` browser, and runs `GET /auth/saml/login?connection=<id>&callbackURL=/session`. It builds the signed response from `requestIdOf(login)` exactly as the test at `:204-221` does (audience `SP_ENTITY_ID_PREFIX + connection.id`, issuer `IDP_ENTITY_ID`, `around()` times), then posts it with `postToAcs`. To follow the response: when it is `200`, extract the meta-refresh target with the regex `/http-equiv="refresh" content="0;url=([^"]*)"/` and request it with `{ site: "same-origin" }`. Otherwise, request the `location` header with `{ site: "cross-site", navigation: true }`. This is the same rule as `AuthHttp.test.ts:410-422`. Return `{ acs, body, landing }`.

    Add `it.effect("PV-016/BEH-EA-353: under the default Strict cookie the ACS answers the same-site interstitial and the first landing request is signed in", …)`. It asserts every point in `<behavior>`. Use `CookieAssertions.findSetCookie(acs, "__Host-session")` and `CookieAssertions.assertHostPrefixedCookie(…, { httpOnly: true, sameSite: "strict" })`, and assert `landing.status` is `200`.

    Do not change the existing `302` assertions at `:176` and `:223` in this ticket. Ticket 03 rewrites them.
  </action>
  <verify><automated>npx vitest run packages/saml/test/SamlHttp.test.ts -t "BEH-EA-353: under the default Strict cookie"</automated></verify>
  <acceptance_criteria>
    - The new case FAILS at HEAD, and the first failing assertion is either `acs.status` (302 vs 200) or `landing.status` (401 vs 200). Record the failure output for ticket 03's commit body.
    - `grep -c "acsLandingChain" packages/saml/test/SamlHttp.test.ts` is at least 3 (baseline at HEAD: 0).
  </acceptance_criteria>
  <done>The default-mode case exists and is red for the reason B1 predicts. If it is green, stop and report NO-GO (PLAN.md §1).</done>
</task>

<task type="tdd">
  <name>Task 2: the HostLax guard and the escaping case</name>
  <files>packages/saml/test/SamlHttp.test.ts</files>
  <read_first>packages/saml/test/SamlHttp.test.ts (after task 1)</read_first>
  <behavior>
    - Under SessionCookie.config({ mode: HostLax }) the ACS answers 302 with location /session, the __Host-session cookie is SameSite=Lax, and the landing GET /session (cross-site navigation) is 200.
    - Under the default mode, a callbackURL of /session?x=1&y=2 appears in the interstitial body as /session?x=1&amp;y=2 and never as the raw x=1&y=2.
  </behavior>
  <action>
    Add `it.effect("PV-016/BEH-EA-353: under HostLax the ACS stays a 302 and the landing is signed in", …)` using `acsLandingChain` with the HostLax layer. It must pass at HEAD: it guards that the hotfix bounces only under `Strict`. It also validates the probe. If it is red at HEAD, `GET /session` is the wrong oracle, not the ACS. The likely cause is the default `tenantScoped: true` session (`SamlConfig.ts:142`) not resolving on a tenant-less request. In that case, build all three cases on `SamlLive({ tenantScoped: false })` and say so in a test comment. If the guard is still red, stop and report: the oracle needs a human decision.

    Add `it.effect("PV-016/BEH-EA-353: the ACS interstitial HTML-escapes the landing URL", …)`. Give `acsLandingChain` an optional `callbackURL` parameter (default `/session`) and pass the URL-encoded value of `/session?x=1&y=2` on the login query. Assert on the body only. This case is red at HEAD, because the ACS answers a `302` with an empty body.
  </action>
  <verify><automated>npx vitest run packages/saml/test/SamlHttp.test.ts</automated></verify>
  <acceptance_criteria>
    - At HEAD the file reports exactly 2 failing tests (the default-mode case and the escaping case) and 9 passing (the 8 that existed plus the HostLax guard).
    - `grep -c "BEH-EA-353" packages/saml/test/SamlHttp.test.ts` = 3 (baseline at HEAD: 0).
  </acceptance_criteria>
  <done>Two red cases reproduce B1, and one green case pins HostLax. The red output is saved for ticket 03's commit body.</done>
</task>
</tasks>

<threat_model>
Tests only; no trust boundary changes. The cases pin the security-relevant properties of the landing response that ticket 03 will introduce at the ACS: no-store, no-referrer, and HTML escaping of an attacker-influenced URL.

| Threat ID | Category | Target | Severity | Disposition | Mitigation Plan |
|---|---|---|---|---|---|
| T-33-01 | Information disclosure | ACS interstitial cached by an intermediary with its Set-Cookie | medium | mitigate | the default-mode case asserts cache-control no-store |
| T-33-02 | Tampering (HTML injection) | callbackURL rendered into the interstitial | high | mitigate | the escaping case asserts &amp; encoding |
</threat_model>

<verification>
npx vitest run packages/saml/test/SamlHttp.test.ts (expected at HEAD: 2 failed, 9 passed)
npx tsc -p tsconfig.test.json --noEmit
</verification>

<success_criteria>
Two red, one green, all three named with BEH-EA-353. No source file is changed.
</success_criteria>

## Comments
