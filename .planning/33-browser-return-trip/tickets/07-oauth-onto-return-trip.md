---
plan: 33-browser-return-trip
ticket: 07
title: "OAuth authorize and callback onto ReturnTrip"
type: execute
wave: 3
depends_on: [02, 06]
files_modified:
  - packages/oauth/src/OAuth.ts
  - packages/oauth/test/AuthHttp.test.ts
autonomous: true
requirements: [REQ-EA-1545, REQ-EA-1547]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "OAuth.ts sets, expires and reads __Host-oauth-state only through one ReturnTrip, and registers no Referrer-Policy itself"
    - "The OAuth HTTP suite's wiring cases (state cookie present, expired on success and failure, no-referrer on authorize, callback and a failed callback, the PV-016 landings) pass unchanged"
  artifacts:
    - "OAuth.ts: const oauthTrip = ReturnTrip.make({ cookie: \"__Host-oauth-state\", returnsBy: \"redirect\" })"
  key_links:
    - "authorize -> oauthTrip.start(..., FLOW_TTL)"
    - "callback -> oauthTrip.back(request, cookieState => oauth.callback(...) -> SessionDelivery.land(...))"
---
Status: ready-for-agent
Blocked by: 02, 06

<objective>
Move OAuth's browser trip onto `ReturnTrip` (PLAN.md §3.3). Delete `noReferrer`, `expireStateCookie` and both attribute literals from `OAuth.ts`. Delete the test assertions that re-test what `ReturnTrip.test.ts` now owns, and the escaping case that moved in ticket 02.

Purpose: OAuth supplies only its payloads (the provider URL, the flow state, its `bounce` knob).
Output: a smaller `OAuth.ts` (C1–C5 = 0) and a narrowed `AuthHttp.test.ts`.
</objective>

<context>
@.planning/33-browser-return-trip/PLAN.md (sections 2.1 C1–C5, 3.3, 5)
@packages/server/src/ReturnTrip.ts (from ticket 06)
@packages/oauth/src/OAuth.ts (:80-107, :133 FLOW_TTL, :436-530 the flow handlers after ticket 02)
@packages/oauth/test/AuthHttp.test.ts (:176-196, :425-514)
</context>

<tasks>
<task type="auto">
  <name>Task 1: authorize and callback through oauthTrip</name>
  <files>packages/oauth/src/OAuth.ts</files>
  <read_first>packages/oauth/src/OAuth.ts lines 75-135 and 430-530; packages/server/src/ReturnTrip.ts</read_first>
  <action>
    Replace `OAUTH_STATE_COOKIE` (`:81`) with `const oauthTrip = ReturnTrip.make({ cookie: "__Host-oauth-state", returnsBy: "redirect" })`, importing `ReturnTrip` from `@awthaq/server` next to `Session` and `SessionDelivery`. Keep a one-line comment: "CSS-006/PDR-004/CSS-001: the state cookie's attributes, its single-use expiry and no-referrer are `ReturnTrip`'s". Delete `noReferrer` (`:84-93`) and `expireStateCookie` (`:95-107`) with their doc comments.

    In `authorize`, wrap the whole existing body in `oauthTrip.start(Effect.gen(...), FLOW_TTL)`. That body runs from `Api.CurrentPrincipal` through `oauth.authorize(...)`. The inner effect returns `{ navigation: { _tag: "redirect", location: url.location }, state: Redacted.make(url.state) }`. The `Unauthenticated` and `InvalidNativeRequest` failures stay inside the inner effect, so they still carry no-referrer. Delete the old `setCookie` call and its CSS-001 comment; the comment now lives in `ReturnTrip.ts`.

    In `callback`, replace the `noReferrer`, `expireStateCookie` and `request.cookies[...]` lines with `return yield* oauthTrip.back(request, (cookieState) => Effect.gen(function* () { ... }))`. Its body is the `oauth.callback(...)` call with `cookieState`, followed by ticket 02's `SessionDelivery.land(...)`.

    Remove now-unused imports (`HttpEffect` if nothing else uses it: grep first).
  </action>
  <verify><automated>npx tsc -b tsconfig.json && npx vitest run packages/oauth/test/AuthHttp.test.ts packages/oauth/test/OAuthNative.test.ts packages/oauth/test/OAuth.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -c -F '"referrer-policy"' packages/oauth/src/OAuth.ts` = 0 (baseline at HEAD: 1).
    - `grep -c -F 'expireCookie(' packages/oauth/src/OAuth.ts` = 0 (baseline: 1).
    - `grep -c -F 'setCookie(' packages/oauth/src/OAuth.ts` = 0 (baseline: 1).
    - `grep -c -F 'sameSite:' packages/oauth/src/OAuth.ts` = 0 (baseline: 2).
    - `grep -c 'oauthTrip\.' packages/oauth/src/OAuth.ts` = 2 (start and back; baseline: 0).
    - The three suites pass with no test edited (task 2 edits come after).
  </acceptance_criteria>
  <done>OAuth's trip is declared once and used twice; the wire is unchanged.</done>
</task>

<task type="auto">
  <name>Task 2: delete OAuth assertions that re-test ReturnTrip and BrowserPage (replace, don't layer)</name>
  <files>packages/oauth/test/AuthHttp.test.ts</files>
  <read_first>packages/oauth/test/AuthHttp.test.ts lines 170-200 and 455-515</read_first>
  <action>
    Make three deletions.
    1. In the "BEH-EA-121/128: authorize answers a 302 with a Location and sets the correlation cookie" case (`:176-196`), delete the CSS-001 attribute assertions (`cookie.path`, `cookie.secure`, `cookie.domain`) and their comment. Keep the `302`, `location` and `code_challenge_method=S256` assertions, plus a presence check, `CookieAssertions.findSetCookie(response, "__Host-oauth-state")`. ReturnTrip.test R1 owns the attributes.
    2. In "CSS-006: a successful callback expires __Host-oauth-state alongside the session cookie" (`:468-484`), delete the `assertHostPrefixedCookie(state, { httpOnly: true, sameSite: "lax" })` line and its "Cleared with the attributes" comment. Keep `assertExpiredCookie` and the session-cookie presence check. ReturnTrip.test R7 owns the attributes.
    3. Delete "PV-016: the landing URL is HTML-escaped into the interstitial" (`:458-466`). Ticket 02's `SessionLifecycle.test.ts` escaping case replaced it.

    Keep unchanged: the PDR-004 case (`:498-514`, the wiring proof that OAuth's failures carry no-referrer), the failed-callback expiry (`:486-496`), and the PV-016 landing cases (`:382-456`).
  </action>
  <verify><automated>npx vitest run packages/oauth/test/AuthHttp.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -c "HTML-escaped into the interstitial" packages/oauth/test/AuthHttp.test.ts` = 0 (baseline at HEAD: 1).
    - `grep -c "PV-016" packages/oauth/test/AuthHttp.test.ts` = 6 (baseline at HEAD: 7).
    - `grep -c "PDR-004" packages/oauth/test/AuthHttp.test.ts` = 1 (baseline at HEAD: 1; it stays).
    - The suite passes.
  </acceptance_criteria>
  <done>OAuth's suite tests OAuth's wiring; the attribute rules live in ReturnTrip.test.ts.</done>
</task>
</tasks>

<threat_model>
Same trust boundary as ticket 06 (the state cookie and the Referer header), now for OAuth's real flow.

| Threat ID | Category | Target | Severity | Disposition | Mitigation Plan |
|---|---|---|---|---|---|
| T-33-08 | Spoofing (login CSRF) | __Host-oauth-state | high | mitigate | attributes from ReturnTrip (Lax for a GET return, identical to today); presence asserted in AuthHttp; server-side state binding (Verification consume, BEH-EA-122) unchanged |
| T-33-10 | Information disclosure (Referer of code/state) | authorize and callback | medium | mitigate | no-referrer registered by start/back before any OAuth effect; PDR-004 test kept, covering a failed callback |
| T-33-12 | Repudiation/regression | refactor drops expiry on the failure path | medium | mitigate | CSS-006 failed-callback test kept (:486-496) |
</threat_model>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
C1–C5 are 0 for `OAuth.ts`. The OAuth package's tests pass, with three deletions and no additions in `AuthHttp.test.ts`. `OAuth.ts` is at least 35 lines shorter than at `04fa3526` (1,213).
</success_criteria>

## Comments
