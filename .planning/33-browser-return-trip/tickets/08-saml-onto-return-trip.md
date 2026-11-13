---
plan: 33-browser-return-trip
ticket: 08
title: "SAML login, ACS, SLO and logout onto ReturnTrip; the logout contracts declare their text/html success"
type: execute
wave: 3
depends_on: [03, 05, 06]
files_modified:
  - packages/saml/src/Saml.ts
  - packages/saml/src/SamlApi.ts
  - packages/saml/test/SamlSloHttp.test.ts
  - spec/behaviors/29-saml-sp.md
  - .changeset/saml-return-trip.md
autonomous: true
requirements: [REQ-EA-1545, REQ-EA-1546]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "Saml.ts sets, expires and reads __Host-saml-request and __Host-saml-logout only through two ReturnTrips, registers no Referrer-Policy itself, and builds no text/html response"
    - "slo, sloPost and saml.account.logout declare [302, text/html] on the contract, so the OpenAPI document lists the 200 form"
    - "The SAML HTTP and SLO HTTP suites pass with unchanged wire behaviour"
  artifacts:
    - "Saml.ts: requestTrip and logoutTrip from ReturnTrip.make({ returnsBy: \"post\" })"
    - "SamlSloHttp.test.ts: an OpenAPI case asserting text/html under 200 for the three logout operations"
  key_links:
    - "login -> requestTrip.start; acs -> requestTrip.back -> SessionDelivery.land"
    - "slo/sloPost -> logoutTrip.back -> ReturnTrip.navigate; account logout -> logoutTrip.start (SessionDelivery.end inside begin)"
---
Status: ready-for-agent
Blocked by: 03, 05, 06

<objective>
Move SAML's two browser trips onto `ReturnTrip` (PLAN.md §3.3). Delete `requestCookieOptions`, `expireRequestCookie`, `expireLogoutCookie`, `noReferrer` and `respondToBrowser`'s HTML literal, and the logout handler's HTML literal. Then fix live bug B2: the three logout endpoints declare the `200 text/html` form they already send.

Purpose: SAML supplies only its payloads (AuthnRequest location, LogoutRequest form, state, TTL).
Output: a smaller `Saml.ts` (C1–C5 = 0), the contract union on three endpoints (C8 = 4), a contract test, BEH-EA-315's history, and a changeset.
</objective>

<context>
@.planning/33-browser-return-trip/PLAN.md (sections 2.2, 2.3 B2, 3.3, 6)
@packages/server/src/ReturnTrip.ts (from ticket 06)
@packages/saml/src/Saml.ts (:104-107 cookie names, :416-582 handlers after ticket 03)
@packages/saml/src/SamlSlo.ts (:76-87 SloOutcome, LogoutStart)
@packages/saml/src/SamlApi.ts (:131-170)
@packages/saml/test/SamlSloHttp.test.ts (:120-135 no-referrer case, :185-207 the postForm case)
@packages/api/test/Contracts.test.ts (:73-76: the OpenApi.fromApi assertion pattern)
@spec/behaviors/29-saml-sp.md (BEH-EA-315 at :198, Document Control)
</context>

<tasks>
<task type="auto">
  <name>Task 1: the two SAML trips</name>
  <files>packages/saml/src/Saml.ts</files>
  <read_first>packages/saml/src/Saml.ts lines 100-110 and 410-585; packages/saml/src/SamlSlo.ts lines 70-90; packages/server/src/ReturnTrip.ts</read_first>
  <action>
    Keep the exported names `REQUEST_COOKIE` and `LOGOUT_COOKIE` (`:106-107`), since 19 test references use them. Below them, declare `const requestTrip = ReturnTrip.make({ cookie: REQUEST_COOKIE, returnsBy: "post" })` and `const logoutTrip = ReturnTrip.make({ cookie: LOGOUT_COOKIE, returnsBy: "post" })`, importing `ReturnTrip` from `@awthaq/server`. Comment: "BEH-EA-244/315: the IdP comes back by a cross-site POST, so the state cookies are `SameSite=None`; attributes, expiry and no-referrer are `ReturnTrip`'s". If `REQUEST_COOKIE` is inferred as `string` rather than its literal, the `__Host-` constraint will not accept it. In that case make the declaration a literal-typed const without `as`, for example by keeping the string literal inline in `make` and exporting `requestTrip.cookie` as `REQUEST_COOKIE`.

    Delete `requestCookieOptions` (`:417-424`), `expireRequestCookie` (`:426-430`), `noReferrer` (`:432-434`), `expireLogoutCookie` (`:532-535`) and `respondToBrowser` (`:537-549`).

    Handlers:
    - `login`: `requestTrip.start(saml.authnRequest(...).pipe(Effect.map((started) => ({ navigation: { _tag: "redirect", location: started.location }, state: started.state }))), settings.requestTtl)`.
    - `acs`: `requestTrip.back(request, (cookieState) => saml.acs({ samlResponse: payload.SAMLResponse, cookieState }).pipe(Effect.flatMap((outcome) => SessionDelivery.land(outcome.callbackURL, outcome.session))))`. Keep ticket 03's BEH-EA-353 comment.
    - `slo` and `sloPost`: `logoutTrip.back(request, (cookieState) => saml.slo({ ..., cookieState }).pipe(Effect.map(toNavigation), Effect.map(ReturnTrip.navigate)))`. `toNavigation` is a small local function mapping `SloOutcome`: `done` becomes `{ _tag: "redirect", location: callbackURL }`, and the others pass through. Keep the raw-query comment in `slo`.
    - `saml.account.logout`: `logoutTrip.start(Effect.gen(function* () { ... }), settings.requestTtl)`. The body runs `CurrentUser.current`, `saml.logout`, then `SessionDelivery.end`, in that order, as today. It returns `{ navigation: { _tag: "redirect", location: started.callbackURL } }` (no state) for `local`, and otherwise `{ navigation: started, state: started.state }`. Keep the comments about `Ends` and the IdP's cross-site LogoutResponse.

    Remove imports left unused (`HttpEffect`, maybe `HttpServerResponse`, `Redacted`): grep before removing.
  </action>
  <verify><automated>npx tsc -b tsconfig.json && npx vitest run packages/saml/test/SamlHttp.test.ts packages/saml/test/SamlSloHttp.test.ts packages/saml/test/Sso.test.ts packages/saml/test/Contract.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -c -F '"referrer-policy"' packages/saml/src/Saml.ts` = 0 (baseline at HEAD: 1).
    - `grep -c -F 'expireCookie(' packages/saml/src/Saml.ts` = 0 (baseline: 2).
    - `grep -c -F 'setCookie(' packages/saml/src/Saml.ts` = 0 (baseline: 2).
    - `grep -c -F 'text/html' packages/saml/src/Saml.ts` = 0 (baseline: 2).
    - `grep -c -F 'sameSite:' packages/saml/src/Saml.ts` = 0 (baseline: 1).
    - `grep -cE 'requestTrip\.|logoutTrip\.' packages/saml/src/Saml.ts` = 5 (login, acs, slo, sloPost, logout; baseline: 0).
    - The four suites pass with no test edited.
  </acceptance_criteria>
  <done>SAML's two trips are declared once each; the wire is unchanged.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: the logout contracts declare text/html (B2)</name>
  <files>packages/saml/src/SamlApi.ts, packages/saml/test/SamlSloHttp.test.ts</files>
  <read_first>packages/saml/src/SamlApi.ts lines 117-170; packages/api/test/Contracts.test.ts lines 70-77; packages/saml/test/SamlSloHttp.test.ts lines 1-30</read_first>
  <behavior>
    - OpenApi.fromApi(SamlApi.SamlApi) lists a "200" response with "text/html" content for GET and POST on the /auth/saml/slo/ path and POST /auth/saml/logout, and still lists "302" for each.
    - The same holds for POST /auth/saml/acs (from ticket 03).
  </behavior>
  <action>
    In `SamlApi.ts`, give `slo` (`:138`), `sloPost` (`:146`) and `logout` (`:167`) the same `success` array the ACS got in ticket 03: `[HttpApiSchema.Empty(302), Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/html" }))]`. Rewrite the comment at `:133-134` so it says the declaration now matches ("… a self-submitting HTML form (200), declared").

    In `SamlSloHttp.test.ts`, add `it("BEH-EA-315/353: the contract declares the 302 and the text/html form for the ACS, slo, sloPost and logout", …)`. Use `OpenApi.fromApi(SamlApi.SamlApi)` from `effect/http-api/OpenApi`. Find each path key with `Object.keys(spec.paths).find((path) => path.startsWith("/auth/saml/slo/"))` and the literal `/auth/saml/acs` and `/auth/saml/logout`. Assert that `responses["200"].content` has a `text/html` key and that `responses["302"]` exists. Write the test first and run it to confirm it fails on the three logout operations before editing `SamlApi.ts`.
  </action>
  <verify><automated>npx vitest run packages/saml/test/SamlSloHttp.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -c -F 'contentType: "text/html"' packages/saml/src/SamlApi.ts` = 4 (baseline at HEAD: 0; after ticket 03: 1).
    - `grep -c -F 'HttpApiSchema.Empty(302)' packages/saml/src/SamlApi.ts` = 5 (baseline at HEAD: 5; the 302 member stays).
    - The new case was red before the SamlApi edit and is green after.
  </acceptance_criteria>
  <done>The OpenAPI document tells the truth about the SAML navigation endpoints.</done>
</task>

<task type="auto">
  <name>Task 3: BEH-EA-315 history, changeset, ticket gate</name>
  <files>spec/behaviors/29-saml-sp.md, .changeset/saml-return-trip.md</files>
  <read_first>spec/behaviors/29-saml-sp.md lines 1-15 and 198-240</read_first>
  <action>
    In `29-saml-sp.md`, add one sentence to BEH-EA-315's prose after its requirement block: "The `slo`, `sloPost` and `saml.account.logout` operations declare both answers on the contract: the `302` and the `200 text/html` self-submitting form (architecture plan 33)." Bump Revision 1.13 to 1.14 (ticket 05 made it 1.13) with a Change History entry naming BEH-EA-315 and plan 33.

    Create `.changeset/saml-return-trip.md` with frontmatter `"@awthaq/saml": patch`. Body: "SAML's browser trips use `@awthaq/server`'s `ReturnTrip`; `slo`, `sloPost` and `saml.account.logout` declare their `200 text/html` form on the contract." Then: "Migration: none on the wire; a client generated from the OpenAPI document gains the `200 text/html` response for those three operations."
  </action>
  <verify><automated>pnpm spec:verify:strict && pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular</automated></verify>
  <acceptance_criteria>
    - `grep -c -F '| Revision | 1.14 |' spec/behaviors/29-saml-sp.md` = 1 (baseline: 0).
    - `.changeset/saml-return-trip.md` has a `Migration:` line.
    - All gate commands exit 0 (knip: `.reports/` only).
  </acceptance_criteria>
  <done>SAML is on the module and the spec records the contract change.</done>
</task>
</tasks>

<threat_model>
Trust boundary: the IdP's cross-site POSTs (ACS, SLO) and the browser cookie jar.

| Threat ID | Category | Target | Severity | Disposition | Mitigation Plan |
|---|---|---|---|---|---|
| T-33-08 | Spoofing (login CSRF / logout CSRF) | __Host-saml-request, __Host-saml-logout | high | mitigate | attributes from ReturnTrip (None, as today, required for a cross-site POST); InResponseTo and single-use Verification binding unchanged (BEH-EA-244/315); SamlHttp login test keeps the cookie presence check |
| T-33-09 | Tampering (state replay) | state cookies after the return leg | medium | mitigate | back expires on success and typed failure (ReturnTrip R7); the SLO HTTP suite runs unchanged |
| T-33-10 | Information disclosure (Referer of SAMLRequest/landing) | login, acs, slo, sloPost, logout | medium | mitigate | no-referrer from start/back; SamlHttp :97 and SamlSloHttp :131 assertions kept |
| T-33-13 | Elevation (session not ended) | account logout ordering | high | mitigate | SessionDelivery.end stays inside begin, before the navigation is built; the EndGrant gate is unchanged; the SamlSloHttp logout cases run unchanged |
</threat_model>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
pnpm spec:verify:strict
</verification>

<success_criteria>
C1–C5 are 0 for `Saml.ts`; C8 = 4. Both SAML HTTP suites pass with one added contract case. `Saml.ts` is at least 30 lines shorter than after ticket 03.
</success_criteria>

## Comments
