---
plan: 33-browser-return-trip
ticket: 02
title: "SessionDelivery.land replaces redirect; the same-site interstitial moves to server; OAuth and SAML call it (no wire change)"
type: execute
wave: 0
depends_on: []
files_modified:
  - packages/server/src/internal/BrowserPage.ts
  - packages/server/src/SessionDelivery.ts
  - packages/server/test/SessionLifecycle.test.ts
  - packages/oauth/src/OAuth.ts
  - packages/saml/src/Saml.ts
autonomous: true
requirements: [REQ-EA-1542, REQ-EA-1543, REQ-EA-1547]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "SessionDelivery.land(location, issued, { bounce }) answers the same-site interstitial while the session cookie is Strict and bounce holds, a 302 otherwise, delivers issued on it, and declines Mints when issued is undefined"
    - "SessionDelivery.redirect no longer exists anywhere in packages/, features/ or examples/"
    - "No wire change: the OAuth suite and the SAML suite pass unchanged (SAML calls land with bounce: false until ticket 03)"
  artifacts:
    - "packages/server/src/internal/BrowserPage.ts exporting page and bounce"
    - "packages/server/src/SessionDelivery.ts exporting land"
  key_links:
    - "OAuth.ts callback -> SessionDelivery.land(outcome.callbackURL, outcome.session, { bounce: config.bounce && outcome.native !== true })"
    - "SessionDelivery.land -> core SessionCookie.isStrict(SessionCookieConfig) -> BrowserPage.bounce or HttpServerResponse.redirect"
---
Status: done (uncommitted)
Blocked by: none

<objective>
Move the PV-016 landing choice out of the OAuth plugin into `@awthaq/server`, where the session cookie is written. `SessionDelivery.land` replaces `SessionDelivery.redirect` (PLAN.md §3.1–3.2). Both of `redirect`'s production callers built the same response by hand before calling it. This ticket changes no bytes on the wire: OAuth passes its knob as before, and the SAML ACS passes `{ bounce: false }` to keep today's `302`. Ticket 03 removes that option, which is the hotfix.

Purpose: one place decides "interstitial or `302`", so no return trip can miss it again.
Output: `internal/BrowserPage.ts` (new), `SessionDelivery.land`, both callers moved, and five `land` cases.
</objective>

<context>
@.planning/33-browser-return-trip/PLAN.md (sections 2.2, 3.1–3.5)
@packages/server/src/SessionDelivery.ts (:86-102 redirect)
@packages/server/src/internal/SessionCookie.ts
@packages/core/src/SessionCookie.ts (:137-138 isStrict; SessionCookieConfig is a Context.Reference with a default)
@packages/oauth/src/OAuth.ts (:109-131 escapeHtml/bouncePage, :489-528 callback)
@packages/saml/src/Saml.ts (:462-482 acs)
@packages/server/test/SessionLifecycle.test.ts (:47-56 Behaviour union, :129-131 callback handler, :315-325 the redirect assertion)
@spec/decisions/045-session-lifecycle-on-the-contract.md (decision 2)
</context>

<tasks>
<task type="auto">
  <name>Task 1 (tracer): BrowserPage and SessionDelivery.land; OAuth callback and SAML ACS switched; redirect deleted</name>
  <files>packages/server/src/internal/BrowserPage.ts, packages/server/src/SessionDelivery.ts, packages/oauth/src/OAuth.ts, packages/saml/src/Saml.ts</files>
  <read_first>packages/oauth/src/OAuth.ts lines 80-135 and 485-530; packages/server/src/SessionDelivery.ts; packages/server/src/internal/SessionCookie.ts; packages/saml/src/Saml.ts lines 460-483</read_first>
  <action>
    Create `packages/server/src/internal/BrowserPage.ts`. Its header comment follows the house style: `// @awthaq/server — internal BrowserPage`, PV-016, and "the one text/html builder for browser navigations". It exports two functions.
    - `page(html: string)`: `HttpServerResponse.text(html, { contentType: "text/html; charset=utf-8" })` piped through `HttpServerResponse.setHeader("cache-control", "no-store")`.
    - `bounce(location: string)`: the body of `OAuth.ts:125-131`, moved with its doc comment from `:118-124` and the `escapeHtml` helper from `:109-115`, now built with `page`. The markup string must stay byte-identical.

    In `packages/server/src/SessionDelivery.ts`, replace `redirect(response, issued)` (`:86-102`) with `land(location: string, issued: Sessions.IssuedSession | undefined, options?: { readonly bounce?: boolean })`. Inside an `Effect.gen`:
    1. Read `SessionLifecycle.MintGrant` and the core `SessionCookieConfig`. Import core's module as `CoreSessionCookie` from `@awthaq/core`, because the local `./internal/SessionCookie.ts` import is already named `SessionCookie`.
    2. Build `BrowserPage.bounce(location)` when `options?.bounce !== false && CoreSessionCookie.isStrict(config)`, and `HttpServerResponse.redirect(location)` otherwise.
    3. If `issued` is undefined, run `grant.settle("declined")` and return the response.
    4. Otherwise set the session cookie exactly as `redirect` did (`SessionCookie.render`, then `HttpServerResponse.setCookie(...).pipe(Effect.orDie)`), settle `"delivered"`, and return.

    Do not annotate the return type. Rewrite the module header (`:18-21`) and the function's doc comment: "`land` lands a browser return trip (OAuth callback, SAML ACS): the same-site interstitial while the session cookie is `Strict` (PV-016), a `302` otherwise; it declines when nothing was minted".

    In `OAuth.ts`, delete `escapeHtml` and `bouncePage` (`:109-131`). In the callback (`:509-527`), replace the `cookieConfig`/`bounce`/`response` lines and the `if`/`decline` tail with one call: `return yield* SessionDelivery.land(outcome.callbackURL, outcome.session, { bounce: (yield* configNow).bounce && outcome.native !== true })`. Keep a one-line PV-016 comment saying the native deep link never bounces and the choice is `SessionDelivery.land`'s. Drop the `SessionCookie` (`@awthaq/core`) and `SessionLifecycle` (`@awthaq/api`) imports only if grep shows them unused afterwards. `noReferrer`, `expireStateCookie` and the authorize `setCookie` stay; ticket 07 moves them.

    In `Saml.ts:477-481`, replace the `SessionDelivery.redirect(HttpServerResponse.redirect(outcome.callbackURL), outcome.session)` call with `SessionDelivery.land(outcome.callbackURL, outcome.session, { bounce: false })`. Add the comment: "shortcut: keeps today's 302 for ticket 02's no-wire-change step; ticket 03 removes the option (BEH-EA-353)". Update the ADR-EA-045 comment above it (`redirect` becomes `land`).
  </action>
  <verify><automated>npx tsc -b tsconfig.json && npx vitest run packages/oauth/test/AuthHttp.test.ts packages/oauth/test/OAuthNative.test.ts packages/saml/test/SamlHttp.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -c -F 'bouncePage' packages/oauth/src/OAuth.ts` = 0 (baseline at HEAD: 2).
    - `grep -c -F 'text/html' packages/oauth/src/OAuth.ts` = 0 (baseline at HEAD: 1).
    - `grep -rn -F 'SessionDelivery.redirect' packages features examples --include='*.ts' | grep -v /lib/ | grep -v node_modules | wc -l` = 0 after task 2 (baseline at HEAD: 4).
    - `grep -c "export const land" packages/server/src/SessionDelivery.ts` = 1 (baseline: 0).
    - The OAuth, OAuthNative and SAML HTTP suites pass with no edit (if ticket 01 has already landed, its two red cases stay red and its HostLax case stays green).
  </acceptance_criteria>
  <done>Both callers land through `SessionDelivery.land`; no response byte changed; `redirect` is gone from source.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: land cases replace the redirect case in SessionLifecycle.test.ts</name>
  <files>packages/server/test/SessionLifecycle.test.ts</files>
  <read_first>packages/server/test/SessionLifecycle.test.ts (whole file, 328 lines)</read_first>
  <behavior>
    - Default config (Strict): the callback endpoint answers 200, content-type text/html, cache-control no-store, no location header, a __Host-session Set-Cookie, and a body that meta-refreshes to the location.
    - land with { bounce: false } under Strict: 302 with the location and the session cookie.
    - Under SessionCookie.config({ mode: HostLax }): 302 with the session cookie.
    - land with issued undefined: no __Host-session Set-Cookie, and the marker does not die (the grant was settled declined).
    - A location containing &, " and < is HTML-escaped in the interstitial body (this replaces oauth AuthHttp.test.ts:458-466, which ticket 07 deletes).
  </behavior>
  <action>
    Replace the `"redirect"` member of the `Behaviour` union (`:55`) and the `callback` handler (`:129-131`) with land variants. Add Behaviour members `"land"`, `"landNoBounce"`, `"landDecline"` and `"landEscaped"`, and have the `callback` handler switch on the test's `Ref` the way the other handlers already do. Keep `handleRaw`, since `land` returns an `HttpServerResponse`.

    For the `HostLax` case, build a second `HttpRouter.toWebHandler` from the same stack as `:135-142`, plus `Layer.provide(SessionCookie.config({ mode: SessionCookie.HostLax }))` with `SessionCookie` from `@awthaq/core`.

    Rewrite the case that asserts `location` is `http://localhost/landed` (`:315-325`) into the land cases. Do not keep both. Update the file header comment so the function list reads "`deliverBearer`, `deliverExchanged` and `land`".
  </action>
  <verify><automated>npx vitest run packages/server/test/SessionLifecycle.test.ts packages/server/test/SessionLifecycle.types.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -c -F '"redirect"' packages/server/test/SessionLifecycle.test.ts` = 0 (baseline at HEAD: 1).
    - `grep -c "SessionDelivery.land" packages/server/test/SessionLifecycle.test.ts` is at least 1 (baseline: 0).
    - At least 5 test titles in the file contain `land`.
  </acceptance_criteria>
  <done>`land`'s five behaviours are pinned at the server's interface.</done>
</task>

<task type="auto">
  <name>Task 3: ticket gate</name>
  <files>(none edited: gate only)</files>
  <read_first>package.json scripts</read_first>
  <action>
    Run the ticket gate. If `pnpm knip` reports anything outside `.reports/`, fix it (for example, an `escapeHtml` export left unused). Format the touched files with `npx oxfmt` on the five paths in `files_modified`.
  </action>
  <verify><automated>pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular</automated></verify>
  <acceptance_criteria>
    - All five commands exit 0 (knip: only `.reports/` entries, per `.planning/IMPLEMENTING.md`). If ticket 01's uncommitted red cases are in the working tree, `pnpm test` fails on exactly those two cases (`BEH-EA-353: under the default Strict cookie`, `BEH-EA-353: the ACS interstitial HTML-escapes`) and nothing else. Run ticket 02 before ticket 01 to avoid that.
  </acceptance_criteria>
  <done>The tree is green with `land` in place and no wire change.</done>
</task>
</tasks>

<threat_model>
Trust boundary: the browser navigation that carries a freshly minted session cookie, and an attacker-influenced landing URL rendered into HTML.

| Threat ID | Category | Target | Severity | Disposition | Mitigation Plan |
|---|---|---|---|---|---|
| T-33-02 | Tampering (HTML injection) | BrowserPage.bounce | high | mitigate | escapeHtml moved verbatim; task 2 escaping case with &, ", < |
| T-33-03 | Elevation of privilege | SessionDelivery.land writes the session cookie | high | mitigate | land requires SessionLifecycle.MintGrant, like redirect; SessionLifecycle.types.test.ts keeps the gate; no cookie writer outside SessionDelivery |
| T-33-04 | Information disclosure | interstitial cached with its Set-Cookie | medium | mitigate | page sets no-store; the Mints marker also sets it (ADR-EA-045 decision 3) |
| T-33-05 | Spoofing (open redirect via meta refresh) | land(location) | medium | accept | location is the plugin's already-resolved callbackURL (relative or trusted origin, OAuth.ts:258-294, Saml.ts:364-376); unchanged by this ticket |
</threat_model>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
C6 = 0 and C7 = 0. The OAuth, OAuthNative and SAML HTTP suites pass unedited. Five `land` cases pass in server. ADR-EA-045's grant gate (`SessionLifecycle.types.test.ts`) passes unedited.
</success_criteria>

## Comments
