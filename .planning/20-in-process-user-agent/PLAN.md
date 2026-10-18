# Plan 20: One in-process user agent keeps the cookie state, the CSRF echo and the bearer token

| Property | Value |
|---|---|
| Strength | Worth exploring (README index). The finding is wider than the candidate: four hand-made cookie jars, seven Set-Cookie parsers and twenty-one hand-threaded reads, and one harness bug that makes a supported cookie mode untestable |
| Dependency category | in-process (a `(Request) => Promise<Response>` handler is the seam; the cookie store is a local-substitutable module with two policies) |
| Wave / order | After **21** (session lifecycle on the contract), so the agent's bearer mode follows `set-auth-token`/`x-awthaq-session-ended` and its React world needs no `reactivityKeys` (§8). Independent of 11–19 otherwise; coordinate with **11** (configured cookie names) and **15** (host composition under `TestAuth.layer`) |
| Fixes live bugs | Harness: **`TestAuth.signIn`/`signInAs` hand back a `__Host-session` cookie that a `SecureDomain` composition ignores** (reproduced: 401, §2.7). Test fidelity: `headers.get("set-cookie")` reads that depend on header order; `__Host-`/`__Secure-` acceptance rules applied by one plugin's suite only; a hard-coded `document.cookie` in the React world. Production (latent): `InProcessClient` forwards cookies an `Expires` attribute or a `Path` should have withheld |
| Execution tickets | `.scratch/in-process-user-agent/issues/NN-*.md`, one per phase below (`docs/agents/issue-tracker.md`) |
| New ADR | none (no number reserved; nothing here reverses a decision) |

Every `file:line` below was checked against the tree at `fc990c88` (2026-10-17). Re-check the line numbers before editing: plan 21 lands first and moves `SessionDelivery`, `AuthClient` and `ReactClient` code; plans 11–19 may move more.

---

## 1. Summary, goals, non-goals

### Summary

Two pieces of code already behave like a browser against an awthaq handler:

- `@awthaq/web`'s `InProcessClient` (`packages/web/src/InProcessClient.ts:110-154`) keeps the server action's cookies in a `Map`, drops one on `Max-Age<=0`, forwards the rest as `Cookie`, echoes `__Host-csrf` as `x-csrf-token` through `AuthClient.csrfClientLayer`, and mirrors every `Set-Cookie` into the framework's jar.
- The React BDD world's `browserFetch` (`features/step-definitions/ReactWorld.ts:71-94`) keeps a jar, applies `Set-Cookie`, and fakes `document.cookie`.

Everything else talks to `TestAuth.app(...).request` (`packages/test/src/TestAuth.ts:659-683`), which has no cookie state at all. So every wire test that signs in and then makes a request threads cookies by hand: it reads `Set-Cookie`, cuts the first `name=value`, and passes it back as `cookie`. That knowledge is copied into four local jars, seven parsers and a dozen helpers (§2). The copies disagree on what a browser does (an empty value deletes, a `Max-Age=0` regex, the first of several joined cookies), and none of them applies the rules that make a browser *refuse* a cookie, which is the class of bug CSS-001 was (`packages/test/src/CookieAssertions.ts:3-7`).

The module is **shallow**: each test re-implements the user agent it needs. This plan extracts one **in-process user agent** into `@awthaq/web`: an RFC 6265 cookie store with two policies (`browser` for tests, `trusted` for a server action), plus the request recipe (CSRF echo, delivery and bearer headers, cross-site simulation). `InProcessClient` becomes a thin adapter over it. `TestAuth.app` hands out agents (`app.agent()`, `app.signIn(email)` → an agent already holding the session), BDD worlds and examples use the same agent, and `CookieAssertions` keeps only assertions over the one parser.

### Goals

1. One cookie store and one `Set-Cookie` parser for the server-action client, the test harness, the BDD worlds and the React world.
2. A test that signs in and then makes requests never reads `Set-Cookie` to thread a cookie; it holds an agent.
3. In tests, a cookie a conforming browser would refuse (a `__Host-` cookie with a `Domain` or a narrowed `Path`, a `Secure` cookie from an insecure origin, `SameSite=None` without `Secure`, a `Domain` that does not match) fails the test by default instead of working silently.
4. `SameSite` and expiry are honoured the way a browser honours them, so a cross-site landing (PV-016) or a `TestClock` expiry is modelled by the agent, not by each test.
5. `TestAuth`'s minted session is rendered under the composition's own `SessionCookieConfig` (the `SecureDomain` bug).
6. Bearer mode is the same agent with a token instead of cookies: it sends the delivery header and `Authorization`, and follows `set-auth-token` and `x-awthaq-session-ended` (plan 21).

### Non-goals

- Partitioned-cookie (CHIPS) keying. The agent has one top-level site; `Partitioned` is recorded, not keyed (§3.1).
- Public-suffix checks for `Domain`. No awthaq cookie can be set on a public suffix, and a test origin never is one.
- Migrating every one of the 364 `cookie:` literals in 78 test files. Only reads that thread a cookie back, local jars and per-suite CSRF recipes are in scope; a test that *forges* a cookie (a tampered token, a legacy name) keeps writing it, through `extraCookies`.
- `server/test/Authentication.test.ts:506` (`cookieOf` over an Effect `HttpServerResponse`'s `Cookies`, not a web `Response`). It unit-tests the rotation writer and stays.
- The `@awthaq/client` `readCookie` (`client/src/AuthClient.ts:79-87`): it reads `document.cookie`, a different source with its own `"; "` grammar, in a package `@awthaq/web` depends on. It stays (§3.6).

---

## 2. Verified current state

### 2.1 The transports that already behave like a browser

| Where | Store | Expiry | Path/Domain/Secure/SameSite | CSRF | Out |
|---|---|---|---|---|---|
| `InProcessClient.ts:110-154` (production) | `Map` seeded from the action's `Cookie` header (`:111`, `parseCookieHeader` `:62-70`) | `maxAge <= 0` deletes (`:133`); `Expires` ignored | ignored | `csrfClientLayer({ readCookie })` over the map, decoded with `decodeCookie` (`:72-78`, `:146-151`) | every cookie on every request (`:117-120`); `Set-Cookie` mirrored to the framework jar (`:136`) |
| `ReactWorld.ts:71-94` (BDD) | `browser.jar: Map` | `/max-age=0/i` regex or empty value (`:89`) | ignored | the real `CsrfClientLive` reading a fake `document.cookie` that exposes exactly `__Host-csrf` by name (`:107-115`, `:111`), not "the non-`HttpOnly` cookies" its comment promises (`:97`) | every cookie (`:77`) |
| `admin/test/AuthHttp.test.ts:109-138` (`makeJar`, APS-006) | `Map` | `max-age=0` regex or empty value (`:130-131`) | ignored | the suite's own `withCsrfCookie` (`:24`) | every cookie (`:135`) |
| `features/step-definitions/AdminSteps.ts:1158-1174` (`jarHeader`, `applySetCookies`) with the Given at `:1105-1125` | `Map` | same regex/empty rule (`:1168`) | ignored | the world's `request` | every cookie |
| `features/step-definitions/SessionWorld.ts:505-516` | one `cookie` string per actor | n/a | n/a | the world's | replaces the actor's cookie only when the response's `Set-Cookie` *starts with* `__Host-session=` |
| `oauth/test/AuthHttp.test.ts:366-403` (`browserLanding`, "a browser model" for PV-016) | inline | n/a | hand-applies "a `SameSite=Strict` cookie is withheld from a cross-site redirect chain" (`:367-370`, `:398-399`) | n/a | by hand |

### 2.2 `TestAuth.app` has no cookie state

- `request` (`TestAuth.ts:659-683`) builds one `Request`: the caller's `init.cookie` string with a minted `__Host-csrf` appended (`:662-664`), `x-csrf-token` (`:665`), a JSON or form body, extra headers. Nothing of the response is kept.
- `signIn` (`:684`) → `signInAs` (`:497-521`) mints a user and session through `Users`/`Sessions` and returns `cookieHeader: \`${Sessions.SESSION_COOKIE_NAME}=${token}\`` (`:519`): the default name, whatever `SessionCookieConfig` the composition runs.
- The header comment (`:39-54`) records why: `HttpApiTest.groups` has no seam for a cookie header, so "every wire-level test … threads a `Set-Cookie`/`cookie` header by hand", and `signInAs` returns a string "for exactly that pattern".
- 44 test and BDD files call `TestAuth.app(` (`grep -rln "TestAuth.app(" packages/*/test features/step-definitions examples`); `.cookieHeader` is read 54 times in 15 files (`grep -rnE "\.cookieHeader\b"`); `signInAs(` is called 27 times.

### 2.3 Every `Set-Cookie` read (63 lines in 31 files; the candidate's "~47 across ~20" undercounts)

`grep -rnE 'get\("set-cookie"\)|getSetCookie\(\)|\.getSetCookie$' packages examples features` (excluding `lib/`): 3 in library code, 60 in 28 test, BDD and example files. Classified by what the read is for:

| File | Lines | Threads a cookie back | Asserts | Jar |
|---|---|---|---|---|
| `packages/password/test/AuthHttp.test.ts` | `:121` (`cookieFrom`), `:209`, `:621`, `:622`, `:731`, `:756`, `:812`, `:877` | 1 | 7 | |
| `packages/oauth/test/AuthHttp.test.ts` | `:96`, `:124`, `:145`, `:161`, `:188`, `:201`, `:382`, `:455`, `:604` | 6 (`:96`, `:145`, `:188`, `:382`, `:455`, `:604`) | 3 | |
| `packages/jwt/test/AuthHttp.test.ts` | `:377`, `:385`, `:407`, `:420` | | 4 | |
| `packages/admin/test/AuthHttp.test.ts` | `:104` (`cookieFrom`), `:124` (`makeJar`), `:388` | 1 | 1 | 1 |
| `packages/passkey/test/AuthHttp.test.ts` | `:84` (`cookieFrom`), `:323` | 1 | 1 | |
| `packages/two-factor/test/AuthHttp.test.ts` | `:43` (`cookieOf`), `:116`, `:132` | 1 | 2 | |
| `packages/qadi/test/SubjectApi.test.ts` | `:77` (`loginCookie`), `:158` | 2 | | |
| `packages/qadi/test/AuthorizedSubject.test.ts` | `:97` | 1 | | |
| `packages/qadi/test/ReauthHttp.test.ts` | `:117` | 1 | | |
| `packages/saml/test/SamlHttp.test.ts` | `:53` (`cookieHeaderOf`) | 1 | | |
| `packages/saml/test/SamlSloHttp.test.ts` | `:48` (`cookieHeaderOf`) | 1 | | |
| `packages/magic-link/test/AuthHttp.test.ts` | `:77` | | 1 | |
| `packages/device-authorization/test/AuthHttp.test.ts` | `:193` | | 1 | |
| `packages/server/test/SessionDelivery.test.ts` | `:83`, `:94`, `:108` | | 3 | |
| `examples/memory-server/test/smoke.test.ts` | `:74` (`sessionCookie`, over a real listening server) | 1 | | |
| `examples/sql-server/test/smoke.test.ts` | `:86` | | 1 | |
| `features/step-definitions/shared/Harness.ts` | `:39` (`cookieFrom`), `:46` (`setCookieFrom`) | 1 | 1 | |
| `features/step-definitions/SessionWorld.ts` | `:511` | 1 | | |
| `features/step-definitions/OrganizationSteps.ts` | `:390` | 1 | | |
| `features/step-definitions/ContractStratumSteps.ts` | `:148`, `:347` | 1 | 1 | |
| `features/step-definitions/AdminSteps.ts` | `:200`, `:413`, `:1163` | | 2 | 1 |
| `features/step-definitions/ReactWorld.ts` | `:69` | | | 1 |
| `features/step-definitions/CsrfWorld.ts` | `:277` | | 1 | |
| `features/step-definitions/DeviceAuthorizationSteps.ts` | `:946` | | 1 | |
| `features/step-definitions/EmailOtpSteps.ts` | `:388`, `:398` | | 2 | |
| `features/step-definitions/MagicLinkSteps.ts` | `:109`, `:119` | | 2 | |
| `features/step-definitions/NextSsrSteps.ts` | `:567`, `:601` | | 2 | |
| library: `web/src/InProcessClient.ts:129`, `web/src/CookieJar.ts:144`, `test/src/CookieAssertions.ts:47` | | | | |
| **Total** (60 outside library code) | | **21** | **36** | **3** |

`Harness.cookieFrom`/`setCookieFrom` are themselves called 37 times from 7 step files (`DomainSupport.ts`, `AdminSteps.ts`, `UsersAccountsSteps.ts`, `SessionWorld.ts`, `PasskeySteps.ts`, `PasswordSteps.ts`, `SessionSteps.ts`).

### 2.4 Local cookie helpers

- `cookieFrom` (first `name=value` of `get("set-cookie")`): `password/test/AuthHttp.test.ts:120-124`, `passkey/test/AuthHttp.test.ts:83-87`, `admin/test/AuthHttp.test.ts:103-107`, `features/step-definitions/shared/Harness.ts:38-42` (+ `setCookieFrom` `:45-49`).
- `cookieOf`: `two-factor/test/AuthHttp.test.ts:42-43`.
- `cookieHeaderOf` (the raw `Set-Cookie` named `name`): `saml/test/SamlHttp.test.ts:52-53`, `saml/test/SamlSloHttp.test.ts:47-48`. `ReactWorld.ts:65-66` has the same name but writes a `Cookie` header from its jar.
- `loginCookie`: `qadi/test/SubjectApi.test.ts:74-78` (a fake `/login` route that calls core's `SessionCookie.set`, `:48`; also `AuthorizedSubject.test.ts:52`, `ReauthHttp.test.ts:73`).
- `sessionCookie`: `examples/memory-server/test/smoke.test.ts:73-76`, `api-key/test/harness.ts:86`, `webhooks/test/WebhooksHttp.test.ts:18-19`, `saml/test/SamlSloHttp.test.ts:269`, `features/step-definitions/WebhooksWorld.ts:257`, `UsersAccountsSteps.ts:116`.

### 2.5 Parsers and readers (the candidate's counts corrected)

**`Set-Cookie` parsers: 2 attribute parsers and 5 inline ones** (the candidate said three):

1. `web/src/CookieJar.ts:86-135` `parseSetCookie`: percent-decodes the value (NSA-006), all attributes, drops a non-numeric `Max-Age` and an unparseable `Expires`; no `Partitioned`.
2. `test/src/CookieAssertions.ts:24-43` `parseSetCookie`: raw value, booleans for `Secure`/`HttpOnly`, `Number(maxAge)` (a non-numeric one becomes `NaN`), no `Expires`, no `Partitioned`.
3. `ReactWorld.ts:83-91`: pair + `/max-age=0/i` over the whole line.
4. `admin/test/AuthHttp.test.ts:124-133`: pair + `/^\s*max-age=0\s*$/i` per attribute.
5. `AdminSteps.ts:1163-1172`: the same rule again.
6. `AdminSteps.ts:413-420`: a `max-age=0` check on the impersonation cookie.
7. `InProcessClient.ts:129-135`: parser 1 for the name and `maxAge`, then re-splits the raw line for the still-encoded value.

**`Cookie` request-header readers: 4** (the candidate's fourth, ReactWorld, is a writer; the fourth is `HttpErrorWorld`):

1. `client/src/AuthClient.ts:79-87` `readCookie` (`document.cookie`, split on `"; "`, decoded).
2. `web/src/CookieHeader.ts:23-33` `findCookieValue` (split on `";"`, raw). `web/src/Session.ts:78-86` `cookieValue` wraps it with a decode; it is not a second parser.
3. `web/src/InProcessClient.ts:62-70` `parseCookieHeader` (+ `decodeCookie` `:72-78`).
4. `features/step-definitions/HttpErrorWorld.ts:224-227` (split on `"; "` and `"="`).

**`Cookie` request-header writers: 5** (`InProcessClient.ts:117-120`, `TestAuth.ts:662-664`, `ReactWorld.ts:65-66`, `admin/test/AuthHttp.test.ts:135`, `AdminSteps.ts:1159-1160`), plus the per-suite CSRF recipes below.

**Per-suite CSRF recipes.** `CSRF_TEST_COOKIE_VALUE` is minted locally in `admin/test/AuthHttp.test.ts:22`, `passkey/test/AuthHttp.test.ts:37`, `password/test/AuthHttp.test.ts:39`, `server/test/AuthHttp.test.ts:68` and `features/step-definitions/shared/Csrf.ts` (which also exports `withCsrfCookie`, `:41`); `withCsrfCookie` is redefined at `admin/test/AuthHttp.test.ts:24`, `passkey/test/AuthHttp.test.ts:39`, `password/test/AuthHttp.test.ts:40-43`. 24 files use one of these recipes or `TestAuth.csrfToken` directly.

**Attribute assertions.** `CookieAssertions.assertHostPrefixedCookie`/`findSetCookie` are called from exactly one plugin suite, `oauth/test/AuthHttp.test.ts` (15 calls), plus their own test. Every other suite threads cookies whose attributes nothing checks.

### 2.6 What the server actually sets (the cookie semantics the agent must model)

| Cookie | Set by | Attributes |
|---|---|---|
| `__Host-session` / `__Secure-session` | `SessionCookie.render`/`set` (`core/src/SessionCookie.ts:148-198`) via `SessionDelivery` and the rotation (`server/src/Authentication.ts:426-439`) | `Secure; HttpOnly; Path=/`; `SameSite=Strict` (`Host`), `Lax` (`HostLax`), `None; Partitioned` (`HostEmbedded`), or the configured value with `Domain=<d>` and the `__Secure-` prefix (`SecureDomain`, `:120-137`); `Max-Age` = the remaining absolute lifetime unless `persistence: "browserSession"` (`:156-163`) |
| `__Host-impersonation` / `__Secure-impersonation` | `SessionCookie.set(…, "impersonation")` (`admin/src/Admin.ts:466`) | as the session cookie |
| `__Host-csrf` | `CsrfProtection` on any guarded response lacking a valid token, and at half-life (`server/src/Csrf.ts:241-253`) | `HttpOnly=false; Path=/`; `SameSite=Strict`, or `None; Partitioned` under `HostEmbedded` (`SessionCookie.csrfCookieOptions`, `core/src/SessionCookie.ts:227-232`) |
| `__Host-oauth-state` | `oauth/src/OAuth.ts:514-523` | `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age` |
| `__Host-saml-request`, the SLO state cookie | options `saml/src/Saml.ts:410-415`; set at `:454-459` (request) and `:602-607` (logout) | `HttpOnly; Secure; SameSite=None; Path=/; Max-Age` |
| JWT mirror (`__Host-…`) | `jwt/src/Jwt.ts:384-393` | `Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age` |
| any expiry | Effect `HttpServerResponse.expireCookie` (rc.116 `unstable/http/Cookies.ts:687`) | empty value, `Max-Age=0`, epoch `Expires` |

CSRF scheme (`server/src/Csrf.ts:1-28`): `Sec-Fetch-Site` first, `Origin` fallback, a signed double-submit `__Host-csrf`; a request with a non-empty `Authorization` is exempt; a request with **no `Cookie` header at all** skips the double-submit and gets a stricter site check (BEH-EA-077 cookie-less exemption). `InProcessClient` deliberately sends neither `Origin` nor `Sec-Fetch-Site` (`InProcessClient.ts:17-20`).

### 2.7 Defects (bugs and fidelity gaps), with repro sketches

1. **`TestAuth.signIn` under `SecureDomain` (reproduced).** Scratchpad `probe20/signin-name.test.ts` (run with `npx vitest run --root <scratchpad>/probe20`): `TestAuth.app(TestAuth.layer(Auth.make([Password]), { services: SessionCookie.config({ mode: SecureDomain({ domain: "example.com", sameSite: "lax" }) }) }), { baseUrl: "https://app.example.com" })`; `signIn(...).cookieHeader` names `__Host-session`; `GET /session` with it → **401**; the same token under `__Secure-session` → 200. The server reads the configured name (`server/src/Authentication.ts:610-613`); `signInAs` hard-codes the default (`TestAuth.ts:519`). A suite cannot sign in a user under three of the four `SessionCookie` modes' names without re-deriving the name itself.
2. **Order-dependent reads.** `Headers.get("set-cookie")` joins every `Set-Cookie` with `", "` (Fetch), and the helpers take `split(";")[0]`, the first cookie. `oauth/test/AuthHttp.test.ts:161-163` asserts `/^__Host-session=/` on a callback response that also expires `__Host-oauth-state`; it passes only because the session cookie is serialised first. `Harness.cookieFrom` returns whichever cookie comes first.
3. **Acceptance rules never applied.** A threaded cookie works whether or not a browser would store it; only the OAuth suite asserts prefix rules (§2.5). A regression of CSS-001's kind (a `__Host-` cookie with a narrowed `Path`) on any other endpoint passes every test.
4. **Rotations dropped.** A hand-threaded cookie never follows a rotated `Set-Cookie`; `SessionWorld.ts:511-514` refreshes only a header that *starts with* `__Host-session=`. Long scenarios survive only because `rotationGrace` keeps the previous secret alive.
5. **React world `document.cookie`.** Hard-codes `__Host-csrf` (`ReactWorld.ts:111`) instead of the cookies without `HttpOnly`.
6. **`InProcessClient` (production, latent).** It deletes a cookie only on `Max-Age<=0` (`:133`), so a cookie expired by `Expires` alone is still forwarded on the action's later calls; and it forwards every cookie on every path (`:117-120`). Not observable with awthaq's own routes (every expiry carries `Max-Age=0`, every cookie is `Path=/`), observable with an application route mounted on the same handler. Repro sketch: a handler route answering `Set-Cookie: app=1; Path=/app` then `Set-Cookie: app=; Expires=Thu, 01 Jan 1970 00:00:00 GMT`; a second call through the same client still sends `app=1`.

### 2.8 Package facts the placement rests on

- `@awthaq/web` depends on `api`, `client`, `core`, `server` (`packages/web/package.json`); its `./cookies` subpath is edge-safe, with no import at all (`web/src/cookies.ts:1-6`). `@awthaq/next` depends on `web`.
- `@awthaq/test` depends on `api`, `core`, `ports`, `server`, `sql` and three `@effect/*` drivers; it is a `devDependency` everywhere, and plan 08's guard G7 fails CI when a package `src` imports it or a manifest lists it under `dependencies` (`.planning/08-test-composition/PLAN.md:87`, `:878-879`). `examples/memory-server` lists it under `devDependencies` only.
- `packages/*/tsconfig.src.json` `paths`/`references` must list exactly the workspace packages a package's `src` imports; `node scripts/sync-workspace.mjs --write` regenerates them and `--check` runs in `pnpm check` (`scripts/sync-workspace.mjs:1-25`). `pnpm circular` runs madge over `packages/*/src` with and without type imports (`scripts/circular.mjs`).
- So `@awthaq/test` → `@awthaq/web` → `@awthaq/client` → `@awthaq/passkey` is acyclic at the `src` level (`passkey`'s own `@awthaq/test` is a dev dependency, used only by its tests).

---

## 3. Target design

### 3.1 The cookie store (`packages/web/src/CookieStore.ts`, new; edge-safe, no imports)

An RFC 6265bis §5.3–§5.4 subset: receive a `Set-Cookie` for a request URL, answer the `Cookie` header for the next request.

```ts
// @awthaq/web — CookieStore. Edge-safe (`@awthaq/web/cookies`): no import.
import { parseSetCookie } from "./CookieJar.ts";

export type SameSite = "strict" | "lax" | "none";

export interface StoredCookie {
  readonly name: string;
  /** Still percent-encoded: the bytes a browser sends back. */
  readonly value: string;
  readonly domain: string;
  readonly hostOnly: boolean;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  /** An absent attribute reads as `lax` (RFC 6265bis §5.4.7). */
  readonly sameSite: SameSite;
  /** Recorded, not keyed: an in-process agent has one top-level site. */
  readonly partitioned: boolean;
  /** Epoch ms; `undefined` is a session cookie. */
  readonly expiresAt: number | undefined;
  readonly createdAt: number;
}

/**
 * `browser`: a conforming browser's acceptance and sending rules (tests).
 * `trusted`: the handler is the application itself (a server action): every cookie is kept and
 * sent on every matching path; `Domain`, `Secure` and `SameSite` are not enforced. Expiry and
 * `Path` are honoured in both.
 */
export type Policy = "browser" | "trusted";

export type Refusal =
  | "HostPrefix" // `__Host-` without Secure, with a Domain, or with Path other than /
  | "SecurePrefix" // `__Secure-` without Secure
  | "InsecureOrigin" // a Secure cookie from a non-secure origin
  | "DomainMismatch" // Domain does not domain-match the request host
  | "SameSiteNoneWithoutSecure";

export type Received =
  | { readonly _tag: "Stored"; readonly cookie: StoredCookie }
  | { readonly _tag: "Removed"; readonly name: string }
  | { readonly _tag: "Refused"; readonly name: string; readonly refusal: Refusal; readonly header: string };

/** What the request is, as far as cookie sending cares (§5.4). */
export interface Outgoing {
  readonly url: URL;
  readonly method: string;
  readonly site: "same-origin" | "same-site" | "cross-site";
  /** A top-level navigation: a `Lax` cookie travels on a cross-site GET only then. */
  readonly navigation: boolean;
}

/** `https:`, or a loopback host (browsers treat http://localhost as a secure context). */
export const isSecureOrigin = (url: URL) =>
  url.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

export const makeCookieStore = (options: { readonly policy: Policy; readonly now: () => number }) => {
  const cookies = new Map<string, StoredCookie>();
  const keyOf = (cookie: Pick<StoredCookie, "domain" | "path" | "name">) =>
    `${cookie.domain};${cookie.path};${cookie.name}`;

  const receive = (url: URL, header: string): Received => {
    const parsed = parseSetCookie(header);
    const now = options.now();
    // §5.2.2: Max-Age wins over Expires; <= 0 expires now.
    const expiresAt =
      parsed.options.maxAge !== undefined
        ? now + parsed.options.maxAge * 1000
        : parsed.options.expires?.getTime();
    const domainAttribute = parsed.options.domain?.replace(/^\./, "").toLowerCase();
    const host = url.hostname.toLowerCase();
    const domain = domainAttribute ?? host;
    const path = parsed.options.path?.startsWith("/") === true ? parsed.options.path : defaultPath(url);
    // §5.3 step 11: an overwrite keeps the creation time of the cookie it replaces.
    const existing = cookies.get(keyOf({ name: parsed.name, domain, path }));
    const cookie: StoredCookie = {
      name: parsed.name,
      value: parsed.rawValue,
      domain,
      hostOnly: domainAttribute === undefined,
      path,
      secure: parsed.options.secure === true,
      httpOnly: parsed.options.httpOnly === true,
      sameSite: parsed.options.sameSite ?? "lax",
      partitioned: parsed.options.partitioned === true,
      expiresAt,
      createdAt: existing?.createdAt ?? now,
    };
    if (options.policy === "browser") {
      const refusal = refusalOf(cookie, parsed.options.domain !== undefined, url, host);
      if (refusal !== undefined) return { _tag: "Refused", name: cookie.name, refusal, header };
    }
    if (expiresAt !== undefined && expiresAt <= now) {
      cookies.delete(keyOf(cookie));
      return { _tag: "Removed", name: cookie.name };
    }
    cookies.set(keyOf(cookie), cookie);
    return { _tag: "Stored", cookie };
  };

  /** §5.4: the `Cookie` header for `request`, or `undefined` when nothing matches. */
  const header = (request: Outgoing) => {
    const now = options.now();
    const matching = [...cookies.values()]
      .filter((cookie) => {
        if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) return false;
        if (!pathMatches(request.url.pathname, cookie.path)) return false;
        if (options.policy === "trusted") return true;
        if (!domainMatches(request.url.hostname, cookie)) return false;
        if (cookie.secure && !isSecureOrigin(request.url)) return false;
        if (request.site !== "cross-site") return true;
        return cookie.sameSite === "none" ||
          (cookie.sameSite === "lax" && request.navigation && request.method === "GET");
      })
      // §5.4.2: longer paths first, then earlier creation.
      .sort((a, b) => b.path.length - a.path.length || a.createdAt - b.createdAt);
    return matching.length === 0
      ? undefined
      : matching.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  };

  /** A server action's incoming `Cookie` header: host-only, `Path=/`, attributes unknown (`trusted` only). */
  const seed = (url: URL, cookieHeader: string) => { /* one Stored entry per pair, findCookieValue's grammar */ };

  /** `document.cookie` as a page script on `url` sees it: matching cookies without `HttpOnly`. */
  const scriptVisible = (url: URL) => { /* header({ url, method: "GET", site: "same-origin", navigation: false }) over non-HttpOnly cookies */ };

  /** The most specific live cookie named `name` (longest path), for assertions and the CSRF echo. */
  const get = (name: string) => { /* … */ };

  return { receive, header, seed, scriptVisible, get, all: () => [...cookies.values()] };
};

export type CookieStore = ReturnType<typeof makeCookieStore>;
```

Module-private helpers: `defaultPath` (§5.1.4), `pathMatches` (§5.1.4), `domainMatches` (host-only: exact; otherwise the host equals the domain or ends with `.domain`, never for an IP literal), and `refusalOf`:

```ts
const refusalOf = (cookie: StoredCookie, hadDomain: boolean, url: URL, host: string) => {
  if (cookie.secure && !isSecureOrigin(url)) return "InsecureOrigin";
  if (cookie.name.startsWith("__Secure-") && !cookie.secure) return "SecurePrefix";
  if (cookie.name.startsWith("__Host-") && (!cookie.secure || hadDomain || cookie.path !== "/")) {
    return "HostPrefix";
  }
  if (cookie.sameSite === "none" && !cookie.secure) return "SameSiteNoneWithoutSecure";
  if (!cookie.hostOnly && !(host === cookie.domain || host.endsWith(`.${cookie.domain}`))) {
    return "DomainMismatch";
  }
  return undefined;
};
```

- **One parser.** `CookieJar.parseSetCookie` (`web/src/CookieJar.ts:86-135`) gains `rawValue` (the still-encoded value) and `options.partitioned`. Its decoded `value` stays (NSA-006, the framework-jar bridge needs it). `CookieAssertions`' own parser is deleted (§3.5).
- **Why `trusted` exists.** `InProcessClient` addresses `http://internal` (`InProcessClient.ts:58`, `:181`), which is not a secure origin, and a `SecureDomain` session cookie's `Domain` never matches `internal`. Under `browser` rules the action's later calls would lose every awthaq cookie. A server action calls its own application, so it keeps what its own handler set; the framework jar remains the browser-facing store (`mirror`, §3.2).
- **No return-type annotations.** `refusalOf` infers `"InsecureOrigin" | … | undefined` from its branches, which is `Refusal | undefined`; `receive`'s literal `_tag`s may need `as const` (allowed) or a `Received`-typed local for the union to stay narrow. That is a local's type, not an assertion.

### 3.2 The user agent (`packages/web/src/UserAgent.ts`, new)

```ts
// @awthaq/web — UserAgent
import { Api } from "@awthaq/api";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type { HeadersLike } from "./CookieHeader.ts";
import { applyResponseCookies, type CookieJarLike } from "./CookieJar.ts";
import { makeCookieStore, type Policy, type Received } from "./CookieStore.ts";

export interface UserAgentOptions {
  /** The application's web handler; `fetch` itself for a server over the network. */
  readonly handler: (request: Request) => Promise<Response>;
  /** Default `http://localhost`. Relative targets resolve against it. */
  readonly origin?: string | undefined;
  /** Default `browser`. */
  readonly policy?: Policy | undefined;
  /** Default `Date.now`; `TestAuth.app({ testClock: true })` passes the composition's clock. */
  readonly now?: (() => number) | undefined;
  /** A `Cookie` header to start from (a server action's incoming cookies). */
  readonly cookies?: string | undefined;
  /** Every `Set-Cookie` also lands here (BEH-EA-189), e.g. Next's `cookies()`. */
  readonly mirror?: CookieJarLike | undefined;
  /** Headers copied from an incoming request when the outgoing one lacks them (`user-agent`, `x-forwarded-for`). */
  readonly forward?: { readonly from: HeadersLike; readonly names: ReadonlyArray<string> } | undefined;
  /** `bearer`: no cookies; `X-Awthaq-Token-Delivery: bearer` and `Authorization` instead. Default `cookie`. */
  readonly delivery?: "cookie" | "bearer" | undefined;
  /** `throw` (default under `browser`): a refused `Set-Cookie` rejects the request's promise. `record`: kept in `refused`. */
  readonly onRefused?: "throw" | "record" | undefined;
  /** Requests to these URLs never complete (a fetch still in flight). */
  readonly hold?: ((url: URL) => boolean) | undefined;
}

export interface RequestInit {
  readonly json?: unknown;
  readonly form?: Readonly<Record<string, string>>;
  readonly body?: BodyInit;
  /** Win over everything the agent sets. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Default `same-origin` (no `Sec-Fetch-Site`/`Origin` sent, today's posture). */
  readonly site?: "same-origin" | "same-site" | "cross-site";
  readonly navigation?: boolean;
  /** Forged or legacy cookies for this request only, appended after the store's. */
  readonly extraCookies?: Readonly<Record<string, string>>;
}

export interface SentRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
}

/**
 * BEH-EA-<new>: one in-process user agent. `request` is a page script: it echoes `__Host-csrf` as
 * `x-csrf-token` on unsafe methods. `fetch` and `httpClient` are the network: no echo (the
 * application's own CSRF client half does it, as in a browser).
 */
export const make = (options: UserAgentOptions) => {
  const origin = new URL(options.origin ?? "http://localhost");
  const policy = options.policy ?? "browser";
  const store = makeCookieStore({ policy, now: options.now ?? Date.now });
  if (options.cookies !== undefined) store.seed(origin, options.cookies);
  const sent: Array<SentRequest> = [];
  const refused: Array<Extract<Received, { _tag: "Refused" }>> = [];
  let bearerToken: string | undefined;

  const dispatch = async (request: Request, init: Pick<RequestInit, "site" | "navigation" | "extraCookies">) => {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    if (options.delivery === "bearer") {
      headers.set(Api.TOKEN_DELIVERY_HEADER, "bearer");
      if (bearerToken !== undefined && !headers.has("authorization")) {
        headers.set("authorization", `Bearer ${bearerToken}`);
      }
    } else {
      const fromStore = store.header({
        url,
        method: request.method,
        site: init.site ?? "same-origin",
        navigation: init.navigation ?? false,
      });
      const extra = Object.entries(init.extraCookies ?? {}).map(([name, value]) => `${name}=${value}`);
      const cookie = [fromStore, ...extra].filter((part) => part !== undefined && part !== "").join("; ");
      if (cookie !== "") headers.set("cookie", cookie);
    }
    siteHeaders(headers, url, init.site);
    for (const name of options.forward?.names ?? []) {
      const value = options.forward?.from.get(name);
      if (value !== null && value !== undefined && !headers.has(name)) headers.set(name, value);
    }
    sent.push({ method: request.method, url, headers });
    if (options.hold?.(url) === true) return new Promise<Response>(() => undefined);
    const response = await options.handler(new Request(request, { headers }));
    for (const line of response.headers.getSetCookie()) {
      const received = store.receive(url, line);
      if (received._tag === "Refused") {
        refused.push(received);
        if ((options.onRefused ?? (policy === "browser" ? "throw" : "record")) === "throw") {
          throw new Error(`awthaq user agent: refused ${received.name} (${received.refusal}): ${line}`);
        }
      }
    }
    if (options.mirror !== undefined) applyResponseCookies(response, options.mirror);
    // ADR-EA-045 (plan 21): the server says what a declared response did to the session.
    if (response.headers.has(Api.SESSION_ENDED_HEADER)) bearerToken = undefined;
    else {
      const rotated = response.headers.get(Api.ROTATED_TOKEN_HEADER);
      if (rotated !== null && rotated !== "") bearerToken = rotated;
    }
    return response;
  };

  const request = (method: string, target: string, init: RequestInit = {}) => {
    const url = new URL(target, origin);
    const headers = new Headers();
    let body: BodyInit | undefined = init.body;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    } else if (init.form !== undefined) {
      headers.set("content-type", "application/x-www-form-urlencoded");
      body = new URLSearchParams(init.form).toString();
    }
    const csrf = store.get(Api.CSRF_COOKIE_NAME);
    if (options.delivery !== "bearer" && csrf !== undefined && UNSAFE.has(method.toUpperCase())) {
      headers.set(Api.CSRF_HEADER_NAME, decode(csrf.value));
    }
    for (const [name, value] of Object.entries(init.headers ?? {})) headers.set(name, value);
    return dispatch(new Request(url, { method, headers, ...(body === undefined ? {} : { body }) }), init);
  };

  const fetch = (input: RequestInfo | URL, init?: globalThis.RequestInit) =>
    dispatch(new Request(input instanceof Request ? input : new URL(String(input), origin), init), {});

  /** The same transport as an Effect `HttpClient` (what `InProcessClient` used to build, `:113-144`). */
  const httpClient = HttpClient.make((clientRequest, url) =>
    Effect.tryPromise({
      try: async () =>
        HttpClientResponse.fromWeb(
          clientRequest,
          await dispatch(
            new Request(url, {
              method: clientRequest.method,
              headers: new Headers(clientRequest.headers),
              body: toBodyInit(clientRequest.body),
            }),
            {},
          ),
        ),
      catch: (cause) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request: clientRequest, cause }),
        }),
    }),
  );

  return {
    request,
    fetch,
    httpClient,
    cookies: {
      get: store.get,
      all: store.all,
      /** The decoded value of the most specific live cookie (`csrfClientLayer`'s `readCookie`). */
      value: (name: string) => { const found = store.get(name); return found === undefined ? undefined : decode(found.value); },
      scriptVisible: () => store.scriptVisible(origin),
      /** Takes a `Set-Cookie` as if `origin` had answered it (a session `TestAuth` minted directly). */
      receive: (header: string) => store.receive(origin, header),
    },
    bearer: {
      current: () => bearerToken,
      set: (token: string) => { bearerToken = token; },
      clear: () => { bearerToken = undefined; },
    },
    sent,
    refused,
  };
};

export type UserAgent = ReturnType<typeof make>;
```

Module-private: `UNSAFE` (`POST`/`PUT`/`PATCH`/`DELETE`, the set of `server/src/Csrf.ts:48`), `decode` (one `decodeURIComponent` that falls back to the raw value, replacing `InProcessClient.ts:72-78` and `CookieJar.ts:99-105`'s inline copy), `toBodyInit` (moved verbatim from `InProcessClient.ts:81-104`), and `siteHeaders`: `same-origin` sets nothing; `same-site`/`cross-site` set `sec-fetch-site` and an `origin` of `https://elsewhere.example` (cross-site) or the parent domain's sibling (same-site), so `CsrfSteps.ts`' and the PV-016 test's hand-built headers come from one place.

- **Bearer capture follows the headers** plan 21 makes the server send. If plan 21 has not landed (order changed), the agent keeps only the `set-auth-token` rule and a test of a bearer mint reads `token` from the response body itself: no body duck typing is added to the agent (§8).
- **No CSRF bootstrap retry in `request`.** A fresh agent's first unsafe request carries no `Cookie` header, so the server's cookie-less exemption (§2.6) passes it, and the response mints `__Host-csrf` into the store. `TestAuth` agents are seeded (§3.4). The bootstrap retry stays where it is, in `AuthClient.csrfClientLayer` (`client/src/AuthClient.ts:136-166`), which `client(...)` below and `InProcessClient` use.
- **The typed client over an agent:**

```ts
/** `HttpApiClient.make` over the agent's transport, with the CSRF client half reading its store. */
export const client = <ApiId extends string, Groups extends HttpApiGroup.Constraint>(
  agent: UserAgent,
  api: HttpApi.HttpApi<ApiId, Groups>,
  options?: { readonly baseUrl?: string },
) =>
  HttpApiClient.make(api, { baseUrl: options?.baseUrl ?? "http://localhost" }).pipe(
    Effect.provide(
      Layer.merge(
        Layer.succeed(HttpClient.HttpClient, agent.httpClient),
        AuthClient.csrfClientLayer({ readCookie: agent.cookies.value }),
      ),
    ),
  );
```

### 3.3 `InProcessClient` is an adapter over the agent

```ts
const makeLayers = (options: InProcessClientOptions) => {
  const agent = UserAgent.make({
    handler: options.handler,
    origin: options.origin ?? "http://internal",
    policy: "trusted",
    cookies: options.headers.get("cookie") ?? undefined,
    mirror: options.jar,
    forward: { from: options.headers, names: ["user-agent", "x-forwarded-for"] },
  });
  return Layer.merge(
    Layer.succeed(HttpClient.HttpClient, agent.httpClient),
    AuthClient.csrfClientLayer({ readCookie: agent.cookies.value }),
  );
};
```

`parseCookieHeader` (`:62-70`), `decodeCookie` (`:72-78`), `toBodyInit` (`:81-104`) and the transport (`:113-144`) are deleted from the module. The header comment (`:1-33`) keeps the recipe, now pointing at `UserAgent`. Behaviour change: `Expires` and `Path` are honoured (§2.7 item 6).

`makeInProcessClient` stays the same function (`:177-183`) over `makeLayers`; the Promise form and its `UnsupportedClientMiddleware` gate (`:163-169`, `:196-215`) are unchanged. `UserAgent.client` is the same composition for an agent the caller holds; the executor may express `makeInProcessClient` as `UserAgent.client(agent, api, …)` if the types line up.

### 3.4 `TestAuth.app` hands out agents (`packages/test/src/TestAuth.ts`)

```ts
export interface AgentOptions {
  readonly delivery?: "cookie" | "bearer";
  readonly onRefused?: "throw" | "record";
  readonly hold?: (url: URL) => boolean;
}

export interface SignedInAgent extends UserAgent.UserAgent {
  readonly userId: Users.UserId;
  readonly token: Redacted.Redacted<string>;
}

export interface App<A, E = never> {
  readonly handler: (request: Request) => Promise<Response>;
  readonly run: /* unchanged */;
  /** A fresh browser (or native client) over this composition: its own cookie store, the composition's clock, a CSRF cookie already held. */
  readonly agent: (options?: AgentOptions) => UserAgent.UserAgent;
  /** Mints a user and session (as `signInAs`) and returns an agent holding it: the session cookie rendered under the composition's `SessionCookieConfig`, or the bearer token. */
  readonly signIn: (email: string, options?: SignInOptions & AgentOptions) => Promise<SignedInAgent>;
  /** One request from a fresh anonymous agent. */
  readonly request: (method: string, path: string, init?: UserAgent.RequestInit) => Promise<Response>;
  readonly context: /* unchanged */;
  readonly memoMap: /* unchanged */;
  readonly runtime: /* unchanged */;
  readonly advance: /* unchanged, also moves the agents' clock */;
  readonly dispose: /* unchanged */;
}
```

- **Clock.** `app` keeps `let clockMs = 0` when `testClock: true` (`TestClock` starts at the epoch, `TestAuth.ts:616-618`) and adds `Duration.toMillis(Duration.fromInputUnsafe(by))` in `advance` (`:688-691`); every agent gets `now: () => clockMs`. Without the option, `Date.now`. So a session cookie's `Max-Age` and a `TestClock` expiry agree.
- **CSRF seed.** Each agent `receive`s a `__Host-csrf` minted with `csrfToken(config.secret, { issuedAt })` (`:528-538`, computed independently of `Csrf.ts`, BEH-EA-T3) and rendered with `SessionCookie.csrfCookieOptions` of the composition's config, read once through `run`. The echo then comes from the agent's store, like a browser's script would read it.
- **`signIn`** runs `signInAs` (`:497-521`), then renders the cookie with `SessionCookie.render(session, token)` under the composition's config inside `run`, serialises it with Effect's `Cookies.makeCookie`/`Cookies.serializeCookie` (rc.116 `unstable/http/Cookies.ts:374`, `:871`), and hands the line to `agent.cookies.receive`. A `SecureDomain` composition gets `__Secure-session; Domain=…` (§2.7 item 1). With `delivery: "bearer"` it calls `agent.bearer.set(token)` instead. Plan 21 Phase 4 moved the cookie *writers* out of core; `render` stays in core, which is all this needs.
- **`signInAs`** (the Effect form, BEH-EA-197) returns `{ userId, token, setCookie }`, `setCookie` rendered the same way; `cookieHeader` is removed (replace, don't layer; Q5).
- **`request`** is `app.agent().request(method, path, init)`: a fresh anonymous agent per call, so nothing leaks between unrelated requests. `RequestInit.cookie` (`:541-550`) is removed; a forged cookie travels in `extraCookies`.
- **Default `baseUrl`** stays `http://localhost` (`:624`), a secure context for the store, so `__Host-` cookies are accepted. A test of a `SecureDomain` mode passes `{ baseUrl: "https://app.example.com" }`; the agent then enforces the domain match the way a browser would.
- The header comment (`:39-54`) is rewritten: the agent is the "ambient session" BEH-EA-197's example implied.

### 3.5 Assertions keep only assertions (`packages/test/src/CookieAssertions.ts`)

`parseSetCookie` (`:24-43`) is deleted. `ParsedSetCookie` becomes web's parse result; `setCookiesOf`/`findSetCookie` map over `UserAgent`'s parser; `assertHostPrefixedCookie` and `assertExpiredCookie` stay, and gain overloads taking a `StoredCookie` (what an agent holds). Most suites no longer need them: an agent under `browser` already refuses a non-conforming prefixed cookie. They remain for asserting `SameSite`/`HttpOnly` *expectations* (the OAuth suite's 15 calls).

### 3.6 One `Cookie`-header reader in `@awthaq/web`

`CookieHeader.ts` gains `parseCookieHeader` (the pairs of a `Cookie` header, raw), which `CookieStore.seed` and `findCookieValue` share; `HttpErrorWorld.ts:224-227` calls `findCookieValue`. `client/src/AuthClient.ts:79-87` stays: it reads `document.cookie` in a browser, it cannot import `@awthaq/web` (web depends on client, and `@awthaq/web/cookies` must stay import-free), and its grammar is the browser's serialisation, not a request header's.

### 3.7 What sits outside the seam

- The framework jar (`CookieJarLike`, `applyResponseCookies`) is still the browser-facing store in production; the agent only mirrors into it.
- `CsrfProtection` itself, `Sessions.verify`'s rotation, `SessionCookie`'s rendering: the agent models a client and asserts nothing about them.
- Partition keys and public suffixes (non-goals).

---

## 4. Phased migration

Every phase gate is `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`; Phase 2 also `pnpm workspace:check` and `pnpm package:smoke` (a new dependency). Plan gate: `pnpm check`. One ticket per phase under `.scratch/in-process-user-agent/issues/`.

**Preconditions.** Plan 21 is merged (the agent's bearer rules and the React world's lack of keys depend on it; see §8 if it is not). Re-run the §2.3 grep and the §2.4/§2.5 helper greps; classify any new read the same way.

### Phase 0: pin the defects (failing tests)

1. `packages/test/test/TestAuthApp.test.ts`: "`signIn` under `SessionCookie.config({ mode: SecureDomain })` authenticates `GET /session`" (the §2.7 item 1 probe as a test, `baseUrl: "https://app.example.com"`). Fails today (401).
2. `packages/web/test/InProcessClient.test.ts`: "a cookie expired by `Expires` alone is not sent on the action's next call" and "a `Path=/app` cookie is not sent to `/session`", over a router with two application routes beside the guarded group (the file's existing harness, `:1-102`). Both fail today.
3. Record the order-dependence (§2.7 item 2) in the ticket; it is fixed by migration, not pinned (a test that depends on header order is the thing being removed).

### Phase 1: the store and the agent in `@awthaq/web`

1. `web/src/CookieJar.ts`: `parseSetCookie` returns `rawValue` and `options.partitioned`; `CookieSetOptions` already has `partitioned` (`:44`).
2. `web/src/CookieHeader.ts`: `parseCookieHeader` (§3.6); `findCookieValue` over it.
3. `web/src/CookieStore.ts` (§3.1); `web/src/cookies.ts` and `web/src/index.ts` export `makeCookieStore`, `isSecureOrigin` and the types.
4. `web/src/UserAgent.ts` (§3.2); `web/src/index.ts` exports it as `UserAgent`.
5. `web/src/InProcessClient.ts` (§3.3). The Phase 0 tests pass.
6. `web/test/CookieStore.test.ts` and `web/test/UserAgent.test.ts` (§5.1). `web/test/InProcessClient.test.ts` keeps its five tests.
7. `next/test/EdgeImports.test.ts` still passes (the `cookies` subpath stays import-free: `CookieStore.ts` imports only `CookieJar.ts`, which imports nothing).
8. `.changeset/web-user-agent.md` (§6.4).

### Phase 2: `TestAuth.app` hands out agents

1. `packages/test/package.json`: `"@awthaq/web": "workspace:*"` in `dependencies`; `node scripts/sync-workspace.mjs --write` (updates `test/tsconfig.src.json` `paths`/`references`).
2. `test/src/TestAuth.ts` per §3.4: `AgentOptions`, `SignedInAgent`, `agent`, `signIn`, `request` over a fresh agent, the clock, the CSRF seed; `signInAs` returns `setCookie`; delete `RequestInit.cookie` and `SignedInSession.cookieHeader`.
3. `test/src/CookieAssertions.ts` per §3.5; `test/src/index.ts` re-exports `UserAgent` for suites that only depend on `@awthaq/test`.
4. Every caller of `cookieHeader`/`init.cookie` compiles red now: fix the ones in `packages/test/test/*` here (`TestAuth.test.ts`, `TestAuthRecords.test.ts`, `TestAuthApp.test.ts`, `TestAuthMiddleware.test.ts`, `UserFields.test.ts`) and `examples/plugin-template/test/Template.test.ts:89-135`. The remaining callers are migrated in Phases 3 and 4 **in the same commit series**; to keep each phase green, Phase 2 may keep `cookieHeader` as a deprecated field computed from `setCookie` and delete it at the end of Phase 4.
5. `test/test/TestAuthApp.test.ts`: the §5.2 cases. Phase 0 item 1 passes.
6. `.changeset/test-auth-agents.md` (§6.4).

### Phase 3: plugin wire suites

Per suite: replace the hand-threading with agents, delete the local helpers and CSRF recipes; keep the 36 assertion reads (they assert wire facts) but move order-dependent ones to `CookieAssertions.findSetCookie`.

| Suite | Delete | Becomes |
|---|---|---|
| `password/test/AuthHttp.test.ts` | `CSRF_TEST_COOKIE_VALUE` `:39`, `withCsrfCookie` `:40-43`, `post` `:101-118`, `cookieFrom` `:120-124` | `const browser = app.agent(); await browser.request("POST", "/password/sign-in", { json })`; the session follows by itself |
| `passkey/test/AuthHttp.test.ts` | `:37`, `:39`, `post` `:64`, `cookieFrom` `:83-87` | agents |
| `admin/test/AuthHttp.test.ts` | `:22`, `:24`, `post` `:84`, `cookieFrom` `:103-107`, `makeJar` `:109-138` | `const admin = await app.signIn("admin-1@…")`; the APS-006 flow (`:365-399`) is `admin.request(...)` three times, and the assertion on the jar is `admin.cookies.get("__Host-impersonation")` |
| `two-factor/test/AuthHttp.test.ts` | `cookieOf` `:42-43` | agents |
| `oauth/test/AuthHttp.test.ts` | the six threading reads; `browserLanding` (`:366-403`) | `browser.request("GET", "/oauth/acme/callback?…", { site: "cross-site", navigation: true })` for the provider's redirect, then the interstitial's refresh as `site: "same-origin"`; `:161-163` → `CookieAssertions.findSetCookie` |
| `qadi/test/SubjectApi.test.ts`, `AuthorizedSubject.test.ts`, `ReauthHttp.test.ts` | the fake `/login` routes and `loginCookie` (`SubjectApi.test.ts:48`, `:74-78`; `AuthorizedSubject.test.ts:52`, `:97-101`; `ReauthHttp.test.ts:73`, `:117`) | `app.signIn(...)` (plan 21 already replaced their `SessionCookie.set` with `signInAs`; this phase turns them into agents) |
| `saml/test/SamlHttp.test.ts`, `SamlSloHttp.test.ts` | `cookieHeaderOf` (`:52-53`, `:47-48`), the session helper `SamlSloHttp.test.ts:269` | agents; the IdP's cross-site POST to the ACS is `site: "cross-site"` (the request cookie is `SameSite=None`, so it travels) |
| `jwt/test/AuthHttp.test.ts`, `BearerReentry.test.ts` | | bearer agents (`delivery: "bearer"`) where they hand-build `Authorization`; the mirror-cookie assertions stay |
| `api-key/test/harness.ts:86`, `webhooks/test/WebhooksHttp.test.ts:18-19`, `device-authorization/test/support/harness.ts` | `sessionCookie` helpers | `app.signIn` |
| `magic-link`, `organization`, `roles`, `scim`, `server/test/AuthHttp.test.ts` (`:68`) | `cookieHeader`/`init.cookie` uses, the server suite's CSRF const | agents |

Gate addition: `grep -rnE 'cookieFrom|cookieOf\b|cookieHeaderOf|loginCookie|makeJar|withCsrfCookie|CSRF_TEST_COOKIE_VALUE' packages/*/test` returns nothing.

### Phase 4: BDD worlds and examples

1. `features/step-definitions/shared/Harness.ts`: delete `cookieFrom`/`setCookieFrom`; the 37 callers in 7 step files hold agents in their actor registries (`makeNamedRegistry<UserAgent.UserAgent>`), and a cookie-hardening step reads `actor.cookies.get(name)` (attributes included).
2. `SessionWorld.ts:505-516`: actors are agents; the "refresh on rotation" branch disappears (the store follows every `Set-Cookie`).
3. `AdminSteps.ts:1105-1174`: the APS-006 jar scenario holds one agent; delete `jarHeader`/`applySetCookies`; `:413-420` asserts with `CookieAssertions.assertExpiredCookie`.
4. `OrganizationSteps.ts:385-392`, `ContractStratumSteps.ts:347`: agents.
5. `ReactWorld.ts:47-116`: `Browser` holds a `UserAgent` (`hold` replaces `hanging`, `sent` is the agent's); `browserFetch` is `agent.fetch`; `document.cookie` is `agent.cookies.scriptVisible()` (§2.7 item 5); delete `cookieHeaderOf`/`setCookiesOf`.
6. `HttpErrorWorld.ts:224-227`: `findCookieValue`.
7. `features/step-definitions/shared/Csrf.ts`: delete `withCsrfCookie` and `CSRF_TEST_COOKIE_VALUE` once no hand-wired world uses them; a world that still builds its handler by hand (not on `TestAuth.app`) takes `UserAgent.make({ handler })` and a seeded CSRF cookie from one helper here.
8. `CsrfSteps.ts`: cross-site/same-site requests use `site` instead of hand-set `sec-fetch-site`/`origin` where the scenario is "a browser on another site", and keep raw headers where the scenario is about a malformed header.
9. `NextSsrSteps.ts:524-601`: unchanged in meaning (it tests the `withNextCookies` bridge on a raw response); its change-password request takes its cookies from an agent instead of a hand-built header (`:549-553`).
10. `examples/memory-server/test/smoke.test.ts:73-76`: `UserAgent.make({ handler: fetch, origin: <listening url> })` over the real server (devDependency `@awthaq/web`). `examples/sql-server/test/smoke.test.ts:86`: unchanged (an assertion).
11. Delete `SignedInSession.cookieHeader` if Phase 2 kept it.
12. `docs/plugin-authoring.md:218-230` example and prose; `packages/test/README.md:7`; `packages/web/README.md` (a `UserAgent` section).

### Phase 5: final sweep

1. `grep -rnE 'get\("set-cookie"\)|getSetCookie\(\)' packages/*/test features examples` lists only assertion reads (≤ 36, §2.3) and no threading.
2. `grep -rn "parseSetCookie" packages features` lists only `web/src/CookieJar.ts` and its callers.
3. `pnpm check`.

---

## 5. Test plan

Replace, don't layer: cookie behaviour is tested once at the store and the agent; suites stop testing their own jars.

### 5.1 New tests at the deepened interface

`packages/web/test/CookieStore.test.ts` (pure, no handler):

1. A cookie is sent back on a request to a matching path, and not to a sibling path (`Path=/app` vs `/session`; §5.1.4 default path from `/x/y` is `/x`).
2. `Max-Age=0` removes; `Expires` in the past removes; `Max-Age` wins over `Expires`; a session cookie has no expiry; a `Max-Age` cookie expires when `now` passes it.
3. `__Host-` with `Domain`, with `Path=/a`, or without `Secure` is refused `HostPrefix`; `__Secure-` without `Secure` is refused `SecurePrefix`.
4. A `Secure` cookie from `http://example.test` is refused `InsecureOrigin`; from `http://localhost` and `https://…` it is stored.
5. `SameSite=None` without `Secure` is refused.
6. `Domain=example.com` from `app.example.com` is stored and sent to `api.example.com`; from `other.test` it is refused `DomainMismatch`; a host-only cookie is not sent to a subdomain.
7. Cross-site: `Strict` is withheld; `Lax` travels only on a `GET` navigation; `None` travels; an absent `SameSite` behaves as `Lax`.
8. Order: longer path first, then earlier creation; an overwrite keeps the creation time.
9. `scriptVisible` omits `HttpOnly` cookies.
10. `trusted`: a `Secure; Domain=example.com` cookie from `http://internal` is stored and sent; expiry and `Path` still apply.
11. `seed` from a `Cookie` header stores raw (still-encoded) values that round-trip byte for byte.

`packages/web/test/UserAgent.test.ts` (against a real `HttpRouter.toWebHandler` with `CsrfProtectionLive`, the `InProcessClient.test.ts` harness):

12. Sign in through `request`, then `GET /session` is `200` with no cookie handling in the test.
13. A fresh agent's first `POST` (no `Cookie` header) passes the cookie-less exemption, and the response's `__Host-csrf` is echoed on the next unsafe request.
14. A rotated session cookie replaces the stored one; a sign-out's expiry removes it.
15. `extraCookies` are sent after the store's and not stored.
16. `site: "cross-site"` sends `sec-fetch-site: cross-site` and an `origin`, and withholds a `Strict` session cookie.
17. A refused `Set-Cookie` rejects the promise under `browser` by default and is recorded under `onRefused: "record"`.
18. Bearer: the delivery header and `Authorization` are sent, no `Cookie`; `set-auth-token` replaces the token; `x-awthaq-session-ended` clears it (plan 21).
19. `mirror` receives every `Set-Cookie` (BEH-EA-189), and `forward` copies `user-agent`/`x-forwarded-for` only when absent.
20. `hold` leaves the promise pending and the request logged in `sent`.
21. `UserAgent.client(agent, api)` signs in typed and the session reaches the next call.

`packages/web/test/InProcessClient.test.ts`: the five existing tests stay; the two Phase 0 tests are added.

### 5.2 `TestAuth.app` (`packages/test/test/TestAuthApp.test.ts`)

- Keep: "a session minted through `run` authenticates a request through `handler`" (`:17`), `runtime`/`memoMap` (`:72`), `testClock` (`:97`), `advance` rejection (`:122`), shared `memoMap` (`:134`), `buildContext` (`:151`), `dispose` (`:164`).
- Rewrite: "`request` passes CSRF on POST" (`:35`) → "an agent's unsafe request passes CSRF with the seeded cookie, computed independently of `Csrf.ts`"; "`signIn` returns a working cookie, with the `amr` the test asked for" (`:58`) → "`signIn` returns an agent that is signed in, with the `amr`".
- Add: the Phase 0 `SecureDomain` case; "under `testClock`, a session cookie's `Max-Age` lapses when `advance` passes it"; "`signIn({ delivery: "bearer" })` authenticates with `Authorization` and sends no cookie"; "two agents of one app do not share cookies"; "`request` is a fresh anonymous agent each call".

### 5.3 BDD

New REQ ids are the next free ones at execution time (above `REQ-EA-1306` today; plans 11–24 also allocate).

- `08-tooling/25-testing-harness.feature`, BEH-EA-333: "Each agent of a `TestAuth.app` keeps its own cookies", "A signed-in agent's session follows the composition's cookie configuration" (the `SecureDomain` case).
- `07-client-integration/24-nextjs-ssr.feature`, BEH-EA-<new> (the agent): "A server action's client honours an expiring `Set-Cookie` within the action".
- Existing scenarios that must pass unchanged in meaning: every APS-006 jar scenario (`AdminSteps.ts:1105-1156`), the React scenarios (REQ-EA-504/505/698 as plan 21 rewrote them), the CSS-001/CSS-002 cookie-attribute scenarios that read `setCookieFrom` today, the BEH-EA-189/190 Next scenarios.

### 5.4 Tests deleted or moved, by name

- `packages/test/test/CookieAssertions.test.ts`, `describe("parseSetCookie")` (`:13-45`: "reads the name, the value and every attribute", "a bare pair has no attributes, and a pair without `=` is a name with an empty value"): the parser is gone; the same cases live in `web/test/CookieJar.test.ts` (which already covers `parseSetCookie`, `:55-184`) and `CookieStore.test.ts`. The `findSetCookie`/`assertHostPrefixedCookie`/`assertExpiredCookie` tests stay.
- Test code deleted (not tests): the helpers and jars of §2.4 and §2.1 rows 2–6.

---

## 6. Spec, ADR, traceability and changesets

### 6.1 Behaviour specs

- `spec/behaviors/24-nextjs-ssr.md` → rev 1.2.
  - New **BEH-EA-<new>** "An in-process user agent keeps cookie state the way a browser does". REQUIREMENT: `@awthaq/web`'s `UserAgent` MUST store a `Set-Cookie` per RFC 6265bis §5.3 (expiry by `Max-Age` over `Expires`, default path, host-only vs `Domain`) and send it per §5.4 (path and domain match, `Secure`, `SameSite` by request site); under the `browser` policy it MUST refuse a cookie a conforming browser refuses (the `__Host-`/`__Secure-` prefix rules, a `Secure` cookie from an insecure origin, `SameSite=None` without `Secure`, a mismatched `Domain`). Implementation pointer to `CookieStore.ts`/`UserAgent.ts`.
  - BEH-EA-189/190: "**As shipped:** `InProcessClient` is `UserAgent` under the `trusted` policy, mirroring into the framework jar."
- `spec/behaviors/25-testing-harness.md` → rev 1.5.
  - BEH-EA-197: the example and the *As shipped* note: `app.signIn(email)` returns an agent; `signInAs` returns the rendered `setCookie` under the composition's `SessionCookieConfig`.
  - BEH-EA-333: REQUIREMENT adds "`agent()` MUST return an agent with its own cookie store over the same instances, reading the composition's clock; `signIn` MUST return an agent holding a session rendered under the composition's `SessionCookieConfig`; `request` MUST be a fresh anonymous agent". The example (`:226-230`) changes; "This replaces … the per-suite CSRF token mints" gains "and the hand-threaded cookies (21 reads, four jars)".
- `spec/behaviors/10-csrf.md`: no change (the agent models the client; BEH-EA-077's exemption is what a fresh agent relies on, cite it in the new BEH).

### 6.2 Decisions

No new ADR. ADR-EA-003 and ADR-EA-005 are untouched. If the executor finds the placement (`@awthaq/test` → `@awthaq/web`) needs recording, it is a paragraph in `spec/overview.md`'s package map ("`@awthaq/test` builds on `@awthaq/web`'s user agent"), not an ADR.

### 6.3 Traceability and docs

- `spec/traceability.md:274` (`CookieJar.test.ts`): `parseSetCookie`'s `rawValue`/`partitioned`. `:276` (`InProcessClient.test.ts`): the two expiry/path cases, "built on `UserAgent` (`trusted`)". `:284` (`TestAuthApp.test.ts`): agents, the clock, the `SecureDomain` case. New rows: `web/test/CookieStore.test.ts`, `web/test/UserAgent.test.ts`. The `CookieAssertions.test.ts` row (if present) loses the parser.
- `features/traceability.md`: new REQ rows.
- `spec/overview.md:53-54`: the client and tools rows mention `UserAgent` and that `@awthaq/test` builds on it.
- `docs/plugin-authoring.md:218-230`, `packages/test/README.md:7`, `packages/web/README.md`, `packages/next/README.md` (the server-action section: unchanged API, honours `Expires`/`Path`).

### 6.4 Changesets (ADR-EA-034)

- Phase 1, `.changeset/web-user-agent.md`, `"@awthaq/web": minor`: "`UserAgent` and `makeCookieStore`: an in-process user agent with an RFC 6265 cookie store (`browser` and `trusted` policies), the CSRF echo, bearer delivery and cross-site simulation (BEH-EA-<new>). `inProcessClient` is built on it and now honours `Expires` and `Path` within an action. `parseSetCookie` also returns `rawValue` and `partitioned`. Migration: none; a server action that relied on a cookie expired by `Expires` alone, or scoped to another path, still reaching later calls no longer gets it."
- Phase 2, `.changeset/test-auth-agents.md`, `"@awthaq/test": minor`: "`TestAuth.app(...).agent()` and `signIn(email)` return user agents that keep cookies, echo CSRF and follow rotations; the minted session is rendered under the composition's `SessionCookieConfig` (BEH-EA-333, BEH-EA-197). `request` is a fresh agent per call. Migration: `const { cookieHeader } = await app.signIn(e); app.request(m, p, { cookie: cookieHeader })` → `const alice = await app.signIn(e); alice.request(m, p)`; a forged cookie → `extraCookies`; `signInAs(...).cookieHeader` → `setCookie` (or an agent); `CookieAssertions.parseSetCookie` → `@awthaq/web`'s `parseSetCookie`."

---

## 7. Risks, mitigations, rollback

| Risk | Mitigation |
|---|---|
| **The `browser` policy refuses a cookie an existing test relied on** (a test origin over `http://` other than localhost, a `SecureDomain` test on `localhost`) | That is the point (goal 3), but it lands as red tests in Phases 3–4. Each is either a real defect (file a ticket) or a test origin to fix (`baseUrl`). `onRefused: "record"` exists for a test *about* refusals, never as a blanket escape |
| **Migration size** (44 `TestAuth.app` files, 37 harness calls, 21 threading reads) | Mechanical and per suite; Phase 2 may keep `cookieHeader` deprecated until Phase 4 so every phase is green. The gates in Phases 3 and 5 make "done" a grep |
| **`trusted` hides a real production bug** in a server action | `trusted` changes nothing a server action could observe before except `Expires`/`Path` (now honoured). The browser itself still applies its rules to what the framework jar sends it |
| **`@awthaq/test` grows a dependency on `@awthaq/web`** (and through it `@awthaq/client`, `@awthaq/passkey`, `@simplewebauthn/browser`) | Dev-only everywhere (G7); acyclic at the `src` level (§2.8); `pnpm circular`, `workspace:check` and `package:smoke` gate it |
| **Clock drift between the agent and the composition** under `testClock` | One `clockMs` updated by `advance`; §5.2's `Max-Age` case pins it. A step that adjusts a *step's* `TestClock` directly (plan 08 decisions, "`TestClock` vs `TestAuth.app`") keeps its own context and passes `now` explicitly |
| **Plan 21 not merged first** | The agent's bearer mode keeps only the `set-auth-token` rule; the React world keeps passing `reactivityKeys` until 21 lands. No body duck typing is added to the agent |
| **Plan 11 renames cookie readers** in `web/src/Session.ts`/`HasSessionCookie.ts` | No conflict with the store; both edit `@awthaq/web` and whichever lands second rebases. The agent reads no session cookie by name |

**Rollback.** Phase 1 is additive except `InProcessClient`, which reverts to its own transport in one file. Phase 2 reverts with its callers (or keeps the deprecated `cookieHeader`). Phases 3 and 4 are per suite and revert independently.

---

## 8. Interactions with other plans

- **21 (session lifecycle on the contract)**: runs **first**. The agent's bearer mode is "store `set-auth-token`, clear on `x-awthaq-session-ended`", which needs 21's server headers; without 21 a bearer mint's token is only in the body and the agent would need body duck typing, which this plan refuses to add. The React world migration (Phase 4) assumes 21's automatic invalidation. 21's Phase 4 already moved the qadi/web test logins off core's `SessionCookie.set` onto `signInAs`; Phase 3 here turns them into agents.
- **11 (credential resolution)**: fixes configured cookie names in the readers (`web/src/Session.ts:150`, `:154`, `HasSessionCookie.ts` use `Api.SessionCookie.key`). This plan fixes the *writer* side of the same class in the harness (§2.7 item 1). The agent is name-agnostic. Both touch `@awthaq/web`; rebase, no design conflict.
- **15 (host composition)**: `TestAuth.layer` is rebuilt on 15's module; `TestAuth.app` takes a layer either way, so agents are unaffected.
- **08 (test composition, done)**: `TestAuth.app` is 08's; this plan extends its handle and keeps G7 (dev-only `@awthaq/test`). `memory-server` keeps `@awthaq/test` out of `dependencies`; its smoke test adds `@awthaq/web` as a dev dependency.
- **12, 13, 14, 18 (passkey, admin gate, federated identity, verification link)**: each rewrites wire tests in the suites Phase 3 migrates. Whichever lands second uses the other's form: if they land first, Phase 3 migrates their new tests too; if this plan lands first, they write agents.
- **10, 19, 16, 17, 22, 23, 24**: none.

---

## 9. Acceptance checklist

- [ ] `@awthaq/web` exports `UserAgent` and `makeCookieStore`; `@awthaq/web/cookies` stays import-free (`EdgeImports.test.ts`).
- [ ] `InProcessClient.ts` has no cookie parsing or transport of its own; the Phase 0 tests pass.
- [ ] `TestAuth.app` has `agent()`, `signIn` returns a `SignedInAgent`, `request` takes no `cookie`; the `SecureDomain` test passes.
- [ ] `grep -rnE 'cookieFrom|setCookieFrom|cookieOf\b|cookieHeaderOf|loginCookie|makeJar|jarHeader|applySetCookies|withCsrfCookie|CSRF_TEST_COOKIE_VALUE' packages features examples` returns nothing.
- [ ] `grep -rnE 'get\("set-cookie"\)|getSetCookie\(\)' packages/*/test features examples` lists only assertions; none feeds a later request.
- [ ] `grep -rn "parseSetCookie" packages/*/src` lists only `web/src/CookieJar.ts` (definition) and `web/src` callers.
- [ ] `CookieStore.test.ts` and `UserAgent.test.ts` cover §5.1 items 1–21.
- [ ] No `as` (other than `as const`), no return-type annotations on new Effect/Layer consts.
- [ ] BEH-EA-<new> added to `24-nextjs-ssr.md`; BEH-EA-189/190/197/333 revised; Document Control rows; traceability updated; `pnpm spec:verify:strict` passes.
- [ ] Changesets for `@awthaq/web` and `@awthaq/test` with `Migration:`.
- [ ] `pnpm check` is green on the final commit.

---

## 10. Open questions only the user can answer

1. **Placement.** The agent in `@awthaq/web` (recommended: its production caller is there, `@awthaq/web/cookies` already holds the parser, and `@awthaq/test` depending on it stays dev-only), in a new `@awthaq/user-agent` package (a package for one module), or in `@awthaq/test` (then `InProcessClient` keeps its own copy, which is the duplication this plan removes)?
2. **`TestAuth.app(...).request`'s `cookie` option.** Remove it (recommended: an agent carries cookies; a forged one goes in `extraCookies`), or keep it beside agents for raw wire tests?
3. **Refusals in tests.** Throw on a `Set-Cookie` a browser would refuse (recommended: it turns the CSS-001 class into a failing test everywhere), or record it silently and let suites assert?
4. **CSRF seeding.** Seed every `TestAuth` agent with a minted `__Host-csrf` (recommended: deterministic, and the echo still comes from the store), or make each agent earn it through the cookie-less first request like a cold browser (more faithful, one more request per test, and `signIn` agents would need the bootstrap retry the raw path does not have)?
5. **`signInAs`.** Return the rendered `setCookie` and drop `cookieHeader` (recommended: one representation, with attributes, under the composition's config), or keep `cookieHeader` too (computed from the configured name, which at least fixes the `SecureDomain` bug)?
6. **Example smoke tests.** Move `examples/memory-server`'s real-network smoke test onto `UserAgent.make({ handler: fetch })` (recommended: the same agent over a real socket, one dev dependency), or keep its hand-written helper as an independent check?
7. **Cross-site simulation.** Ship `site`/`navigation` on the agent (recommended: the PV-016 OAuth tests and `CsrfSteps.ts` build these headers and rules by hand today), or leave cross-site requests to raw `handler` calls?
