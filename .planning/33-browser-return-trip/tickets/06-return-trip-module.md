---
plan: 33-browser-return-trip
ticket: 06
title: "ReturnTrip: one state cookie, no-referrer on both legs, the navigation response"
type: tdd
wave: 2
depends_on: [02]
files_modified:
  - packages/server/src/ReturnTrip.ts
  - packages/server/src/index.ts
  - packages/server/test/ReturnTrip.test.ts
autonomous: true
requirements: [REQ-EA-1544, REQ-EA-1545]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "A trip's state cookie is __Host-<name>, Secure, HttpOnly, Path=/, no Domain, SameSite=Lax when the provider returns by redirect and None when it returns by form POST, with Max-Age from start"
    - "The return leg expires that cookie with identical attributes on success and on a typed failure"
    - "Every response of both legs, including a typed failure raised inside the caller's effect, carries Referrer-Policy: no-referrer"
    - "A cookie name without the __Host- prefix does not compile"
  artifacts:
    - "packages/server/src/ReturnTrip.ts exporting make, navigate, Navigation, Trip"
    - "packages/server/test/ReturnTrip.test.ts with >= 8 cases"
  key_links:
    - "ReturnTrip.make -> attributes(returnsBy) used by both setCookie (start) and expireCookie (back)"
    - "ReturnTrip.navigate postForm -> internal/BrowserPage.page"
    - "packages/server/src/index.ts -> export * as ReturnTrip"
---
Status: ready-for-agent
Blocked by: 02

<objective>
Build the deep module of PLAN.md §3.1–3.2. A plugin declares a trip once (`ReturnTrip.make({ cookie, returnsBy })`) and supplies only its payloads. The module owns the state cookie's single attribute set, its write on the outbound leg, its read and expiry on the return leg (success and typed failure alike), `Referrer-Policy: no-referrer` on every response of both legs, and the navigation response (`302`, or a `no-store` HTML page).

Purpose: OAuth (ticket 07) and SAML (ticket 08) stop hand-writing cookie attributes, expiries, the no-referrer handler and HTML responses.
Output: `ReturnTrip.ts`, its export, and its test file. It has no callers yet; 07 and 08 add them.
</objective>

<context>
@.planning/33-browser-return-trip/PLAN.md (sections 3.1–3.5, 5)
@packages/server/src/internal/BrowserPage.ts (from ticket 02: page)
@packages/server/src/internal/SessionCookie.ts (the pre-response-handler pattern for an expiry, and its best-effort error policy)
@packages/oauth/src/OAuth.ts (:81-107 noReferrer/expireStateCookie, :474-484 the state cookie write: the behaviour to reproduce)
@packages/saml/src/Saml.ts (:418-460 requestCookieOptions/expire/noReferrer/login, :533-581 SLO and logout: the behaviour to reproduce)
@packages/server/test/SessionLifecycle.test.ts (:1-142 the served-HttpApi test harness to copy)
@packages/test/src/CookieAssertions.ts (findSetCookie, assertExpiredCookie, assertHostPrefixedCookie)
@packages/server/src/index.ts
</context>

<tasks>
<task type="tdd">
  <name>Task 1: ReturnTrip.test.ts, red</name>
  <files>packages/server/test/ReturnTrip.test.ts</files>
  <read_first>packages/server/test/SessionLifecycle.test.ts lines 1-142; packages/test/src/CookieAssertions.ts</read_first>
  <behavior>
    - R1: start on a "redirect" trip with a state answers 302 to the navigation's location and sets __Host-t-lax with Secure, HttpOnly, Path=/, no Domain, SameSite=Lax and Max-Age = maxAge in seconds.
    - R2: start on a "post" trip with a postForm navigation answers 200 text/html, cache-control no-store, with the form html as body, and sets __Host-t-post with SameSite=None.
    - R3: start with no state sets no cookie at all.
    - R4: a typed failure inside begin answers the failure's status and still carries referrer-policy no-referrer and no state cookie.
    - R5: every R1–R3 response carries referrer-policy no-referrer.
    - R6: back hands finish the cookie value the request carried, or undefined when absent.
    - R7: back's response expires the cookie (Max-Age=0 or a past Expires) with the same Path, Secure, HttpOnly, SameSite and no Domain as the write, on success and when finish fails with a typed error; both carry no-referrer.
    - R8: navigate({ _tag: "redirect" }) answers 302 with location; navigate({ _tag: "postForm" }) answers 200 text/html no-store.
    - R9 (type level): ReturnTrip.make({ cookie: "t-plain", returnsBy: "redirect" }) is a compile error, marked // @ts-expect-error.
  </behavior>
  <action>
    Create `packages/server/test/ReturnTrip.test.ts`. Start with a header comment naming plan 33, REQ-EA-1544/1545 and the PDR-004/CSS-001/CSS-006 rules it pins. Copy the harness shape of `SessionLifecycle.test.ts:1-142`: one `HttpApi` with one group, served through `HttpRouter.toWebHandler` with `HttpServer.layerServices`. Declare two trips at module level, `ReturnTrip.make({ cookie: "__Host-t-lax", returnsBy: "redirect" })` and `ReturnTrip.make({ cookie: "__Host-t-post", returnsBy: "post" })`, plus one `Schema.TaggedError` with `httpApiStatus: 400` for the failure cases.

    Endpoints, using `handleRaw` where the handler returns an `HttpServerResponse`:
    - `GET /out/lax`: start with a redirect to `https://idp.example/authorize` and state `Redacted.make("s-lax")`, `maxAge` 10 minutes.
    - `GET /out/post`: start with a postForm whose html is `<form id="f"></form>` and state `s-post`, `maxAge` 5 minutes.
    - `GET /out/local`: start with a redirect to `/home` and no state.
    - `GET /out/fail`: begin fails with the tagged error.
    - `GET /back/lax`: back, where finish returns `HttpServerResponse.text(cookieState ?? "none")`.
    - `GET /back/fail`: back, where finish fails with the tagged error.
    - `GET /back/post`: like `/back/lax`, on the post trip.
    - `GET /nav/redirect` and `GET /nav/form`: `ReturnTrip.navigate`.

    Requests to `/back/*` send the cookie with a `cookie` header (`__Host-t-lax=s-lax`). Assert with `CookieAssertions.findSetCookie`, `assertExpiredCookie` and `assertHostPrefixedCookie(cookie, { httpOnly: true, sameSite: "lax" | "none" })`, and assert `Max-Age` from the parsed cookie (600 and 300). For R9, put `// @ts-expect-error a state cookie must be __Host- prefixed (CSS-001)` above a `ReturnTrip.make({ cookie: "t-plain", returnsBy: "redirect" })` statement; `pnpm typecheck` (via `tsconfig.test.json`) is the check.

    Import `ReturnTrip` from `../src/ReturnTrip.ts`. The file does not exist yet, so the run fails at import. That is the red step.
  </action>
  <verify><automated>npx vitest run packages/server/test/ReturnTrip.test.ts</automated></verify>
  <acceptance_criteria>
    - The run FAILS (module not found) before task 2.
    - The file has at least 8 `it` or `it.effect` cases (`grep -cE '^\s*it(\.effect)?\(' packages/server/test/ReturnTrip.test.ts` is at least 8; baseline: no file).
  </acceptance_criteria>
  <done>R1–R9 are written and red.</done>
</task>

<task type="tdd">
  <name>Task 2: ReturnTrip.ts, green</name>
  <files>packages/server/src/ReturnTrip.ts</files>
  <read_first>packages/server/src/internal/BrowserPage.ts; packages/server/src/internal/SessionCookie.ts; .planning/33-browser-return-trip/PLAN.md section 3.2</read_first>
  <action>
    Create `packages/server/src/ReturnTrip.ts`. The header comment says: "@awthaq/server — ReturnTrip (plan 33): a browser trip out to an identity provider and back. One module owns the state cookie (one attribute set, `SameSite` derived from how the provider returns), `Referrer-Policy: no-referrer` on both legs (PDR-004), the cookie's single-use expiry on every return-leg response (CSS-006), and the navigation response; a plugin supplies only its payloads." Implement exactly the interface of PLAN.md §3.2:
    - `Navigation`, the tagged union of `redirect` and `postForm`.
    - `navigate(navigation)`: `HttpServerResponse.redirect(location)` or `BrowserPage.page(html)`.
    - `interface Trip<Name extends `__Host-${string}`>` with `cookie`, `start` and `back`.
    - `make`, with a `const Name` type parameter.

    Implementation notes:
    1. A private `noReferrer` constant: the pre-response handler copied from `OAuth.ts:91-93`.
    2. Inside `make`, compute the attribute object once: `{ httpOnly: true, secure: true, path: "/", sameSite: returnsBy === "redirect" ? "lax" : "none" }`. Use it for both the write and the expiry. Keep the CSS-001 comment from `OAuth.ts:480-482` above it, and the SAML rationale ("a cross-site form POST carries only a `SameSite=None` cookie").
    3. `start(begin, maxAge)`: yield `noReferrer`, then `begin`, then build `navigate(navigation)`. When `state` is defined, `HttpServerResponse.setCookie(response, cookie, Redacted.value(state), { ...attributes, maxAge })` piped through `Effect.orDie`. The cookie and attributes are this library's own, as in both callers today.
    4. `back(request, finish)`: yield `noReferrer`, then a pre-response handler that runs `HttpServerResponse.expireCookie(response, cookie, attributes)`. Keep the plugins' `Effect.orDie`, because both callers die today and an unencodable fixed cookie is a defect. Then `finish(request.cookies[cookie])`.

    No `as`, no return-type annotations on the consts, no `as const` (use a typed local or a `satisfies` if a literal type is needed). Run task 1's suite until green.
  </action>
  <verify><automated>npx vitest run packages/server/test/ReturnTrip.test.ts && npx tsc -b tsconfig.json && npx tsc -p tsconfig.test.json --noEmit</automated></verify>
  <acceptance_criteria>
    - All ReturnTrip.test.ts cases pass, and the `@ts-expect-error` line is consumed (tsc reports no unused-directive error).
    - `grep -c -F 'setCookie(' packages/server/src/ReturnTrip.ts` = 1 and `grep -c -F 'expireCookie(' packages/server/src/ReturnTrip.ts` = 1.
    - `grep -cE '\bas (unknown|any|const)\b' packages/server/src/ReturnTrip.ts` = 0.
  </acceptance_criteria>
  <done>The module meets its interface tests.</done>
</task>

<task type="auto">
  <name>Task 3: export and ticket gate</name>
  <files>packages/server/src/index.ts</files>
  <read_first>packages/server/src/index.ts</read_first>
  <action>
    Add `export * as ReturnTrip from "./ReturnTrip.ts";` in alphabetical position (after `RequestContext`). Add `ReturnTrip.ts` (the browser return trip, plan 33) to the header comment's "Implemented:" list. `pnpm knip` may report `ReturnTrip`'s exports as unused until tickets 07 and 08. If it does, record the exact knip lines in this ticket's Comments, and treat the ticket as green only for those lines: 07/08 consume them in the same PR B. Do not add an ignore entry to the knip config.
  </action>
  <verify><automated>pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular</automated></verify>
  <acceptance_criteria>
    - `grep -c 'ReturnTrip' packages/server/src/index.ts` is at least 2 (export plus header; baseline: 0).
    - `pnpm circular` reports no new cycle (`ReturnTrip.ts` and `SessionDelivery.ts` both import `internal/BrowserPage.ts`; neither imports the other).
  </acceptance_criteria>
  <done>`ReturnTrip` is public from `@awthaq/server` and the tree is green.</done>
</task>
</tasks>

<threat_model>
Trust boundary: the browser's cookie jar across a cross-site navigation, and the Referer header leaving the site.

| Threat ID | Category | Target | Severity | Disposition | Mitigation Plan |
|---|---|---|---|---|---|
| T-33-08 | Spoofing (login CSRF) | state cookie attributes | high | mitigate | __Host- prefix enforced by type (R9) and asserted (R1/R2); Secure, HttpOnly, Path=/, no Domain |
| T-33-09 | Tampering (cookie replay) | state cookie after the return leg | medium | mitigate | back expires it on every response including typed failures (R7); single use is still enforced server-side by Verification consume in each plugin |
| T-33-10 | Information disclosure (Referer) | code/state/SAMLRequest in URLs | medium | mitigate | no-referrer registered before the caller's effect, so typed failures carry it (R4, R7) |
| T-33-11 | Elevation via weakened SameSite | returnsBy "post" yields SameSite=None | medium | accept | required for a cross-site form POST to carry the cookie; the value is a single-use random binding, not a credential (BEH-EA-244) |
| T-33-04 | Information disclosure | postForm page cached | low | mitigate | BrowserPage.page sets no-store (R2, R8) |
</threat_model>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
`ReturnTrip.test.ts` has 9 or more cases passing (R1–R9). `ReturnTrip.ts` holds the only `setCookie(` and `expireCookie(` of any return-trip state cookie in the repo once 07 and 08 land.
</success_criteria>

## Comments
