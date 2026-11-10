---
plan: 33-browser-return-trip
ticket: 03
title: "Hotfix: the SAML ACS lands through the same-site interstitial while the session cookie is Strict"
type: tdd
wave: 1
depends_on: [01, 02]
files_modified:
  - packages/saml/src/Saml.ts
  - packages/saml/src/SamlApi.ts
  - packages/saml/test/SamlHttp.test.ts
autonomous: true
requirements: [REQ-EA-1540, REQ-EA-1541, REQ-EA-1542]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "Under the default Host cookie, the ACS answers 200 text/html (the interstitial) with the session cookie, and the first landing request is signed in"
    - "Under HostLax the ACS answers 302 and the landing is signed in"
    - "The ACS contract declares 302 or text/html"
  artifacts:
    - "packages/saml/src/SamlApi.ts acs success = [HttpApiSchema.Empty(302), Schema.String.pipe(HttpApiSchema.asText({ contentType: \"text/html\" }))]"
  key_links:
    - "Saml.ts acs handler -> SessionDelivery.land(outcome.callbackURL, outcome.session) with no options"
---
Status: done (uncommitted)
Blocked by: 01, 02

<objective>
Fix live bug B1 (PLAN.md §2.3). Ticket 02 left the ACS calling `SessionDelivery.land(…, { bounce: false })` to keep its `302`. This ticket drops the option, so the ACS gets the same PV-016 landing as the OAuth callback. The contract then says the ACS may answer `text/html`, and the existing `302` assertions are rewritten to the new default.

Purpose: a server-rendered landing page behind an auth check sees the SAML user as signed in on the first request, under the default cookie mode.
Output: the green ticket 01 cases, the ACS contract union, and the rewritten ACS tests. Commit 01 and 03 together, with ticket 01's red output in the commit body.
</objective>

<context>
@.planning/33-browser-return-trip/PLAN.md (sections 2.3, 3.3, 6 BEH-EA-353)
@.planning/33-browser-return-trip/tickets/01-red-acs-landing.md
@packages/saml/src/Saml.ts (the acs handler, ~:462-482 after ticket 02)
@packages/saml/src/SamlApi.ts (:117-130 acs)
@packages/oauth/src/OAuthApi.ts (:187-195: the same success union, the pattern to copy)
@packages/saml/test/SamlHttp.test.ts (:136-196 the ADR-EA-047 probe, :198-233 the ACS success test, ticket 01's new cases)
</context>

<tasks>
<task type="tdd">
  <name>Task 1: drop bounce: false at the ACS and declare the text/html success</name>
  <files>packages/saml/src/Saml.ts, packages/saml/src/SamlApi.ts</files>
  <read_first>packages/saml/src/Saml.ts acs handler; packages/saml/src/SamlApi.ts lines 99-130; packages/oauth/src/OAuthApi.ts lines 185-196</read_first>
  <behavior>
    - Ticket 01's three cases pass: the default-mode landing is signed in, the escaping case passes, and the HostLax case still passes.
  </behavior>
  <action>
    In the `acs` handler of `Saml.ts`, call `SessionDelivery.land(outcome.callbackURL, outcome.session)` with no third argument, and delete ticket 02's `shortcut:` comment. Replace the comment above the call with: "BEH-EA-353 / PV-016: the IdP's POST is cross-site, so under a Strict session cookie the landing goes through the same-site interstitial (`SessionDelivery.land`); the session cookie rides it (ADR-EA-045, `Mints`)".

    In `SamlApi.ts`, change the `acs` endpoint's `success` from `HttpApiSchema.Empty(302)` to the array `[HttpApiSchema.Empty(302), Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/html" }))]`, copying `OAuthApi.ts:192-195`. Add a comment: "BEH-EA-353: a 302 to the landing URL, or, while the session cookie is SameSite=Strict, a 200 same-site interstitial that meta-refreshes there". Leave `slo`, `sloPost` and `logout` alone; ticket 08 does those.
  </action>
  <verify><automated>npx vitest run packages/saml/test/SamlHttp.test.ts -t "BEH-EA-353"</automated></verify>
  <acceptance_criteria>
    - `grep -c -F 'bounce: false' packages/saml/src/Saml.ts` = 0 (baseline after ticket 02: 1; at HEAD: 0).
    - `grep -c -F 'contentType: "text/html"' packages/saml/src/SamlApi.ts` = 1 (baseline at HEAD: 0).
    - All three BEH-EA-353 cases pass.
  </acceptance_criteria>
  <done>B1 is fixed and the contract describes the interstitial.</done>
</task>

<task type="auto">
  <name>Task 2: rewrite the ACS 302 assertions to the new default (replace, don't layer)</name>
  <files>packages/saml/test/SamlHttp.test.ts</files>
  <read_first>packages/saml/test/SamlHttp.test.ts lines 136-233</read_first>
  <action>
    The test at `:198-233` ("the ACS form post signs the browser in: 302 to the callback with a session cookie and the request cookie cleared") now sees `200`. Retitle it "the ACS form post signs the browser in: the session cookie is set and the request cookie cleared". Remove its `status`/`location` assertions, since ticket 01's default-mode case owns them. Keep the session-cookie and request-cookie-cleared assertions. Do not duplicate the landing assertions.

    In the ADR-EA-047 probe (`:176`), replace `assert.strictEqual(landed.status, 302)` with `assert.oneOf(landed.status, [200, 302])` and the comment "a landing: the redirect, or the same-site interstitial (BEH-EA-353)". This mirrors `AuthHttp.test.ts:150-151`.

    Update the file's header comment (`:1-3`): the ACS "answers the same-site interstitial (Strict) or a 302 (Lax/None) with a session cookie".
  </action>
  <verify><automated>npx vitest run packages/saml/test/SamlHttp.test.ts packages/saml/test/SamlSloHttp.test.ts</automated></verify>
  <acceptance_criteria>
    - `npx vitest run packages/saml/test/SamlHttp.test.ts` reports 11 passed, 0 failed (8 at HEAD plus 3 from ticket 01).
    - `grep -c "302 to the callback" packages/saml/test/SamlHttp.test.ts` = 0 (baseline at HEAD: 1).
    - `SamlSloHttp.test.ts` passes unedited: its sign-in helper (`:79-88`) reads the cookie from the agent, not the status.
  </acceptance_criteria>
  <done>The SAML HTTP suites describe the new default once.</done>
</task>
</tasks>

<threat_model>
Trust boundary: the cross-site IdP POST that ends in a minted session and a navigation to an application URL.

| Threat ID | Category | Target | Severity | Disposition | Mitigation Plan |
|---|---|---|---|---|---|
| T-33-02 | Tampering (HTML injection) | ACS interstitial renders callbackURL | high | mitigate | callbackURL comes from server-held state resolved by resolveCallbackURL (relative or trusted origin, Saml.ts:364-376); BrowserPage escapes it; ticket 01 escaping case |
| T-33-04 | Information disclosure | ACS interstitial cached with Set-Cookie | medium | mitigate | no-store from BrowserPage.page and from the Mints marker; ticket 01 asserts it |
| T-33-06 | Information disclosure (Referer) | landing navigation leaks the ACS URL or landing query | low | mitigate | the response carries Referrer-Policy no-referrer (existing pre-response handler) and the page's meta referrer no-referrer |
| T-33-07 | Spoofing (login CSRF) | ACS | high | accept | unchanged: the single-use request cookie and InResponseTo binding (BEH-EA-244) still gate the sign-in before any landing is built |
</threat_model>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
`SamlHttp.test.ts`: 11 passing, of which 3 are BEH-EA-353. C8 = 1. B1 is fixed at the default configuration; HostLax behaviour is unchanged.
</success_criteria>

## Comments

Done with deviations: tickets 02+03 landed together (SAML calls land without bounce:false from the start); BEH-EA-353 became BEH-EA-350 (catalog ended at 349); the Strict-cookie SAML test updates the existing ACS test, there is no separate HostLax SAML case (server-level land HostLax case covers it).
