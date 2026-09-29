# CSRF Protection

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-10 |
> | Revision | 1.3 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Added a paragraph on the double-submit-cookie vs. synchronizer-token tradeoff (CCR-EA-002) <br> 1.2 (2026-09-29): Replaced the pre-implementation banner with implementation pointers (DTWS-001, CCR-EA-006) <br> 1.3 (2026-09-29): Added the cookie-less exemption and its threat model to BEH-EA-077 (native first sign-in) |

---

> Implemented in `@awthaq/server` (`packages/server/src/Csrf.ts`) and `@awthaq/client`; tests `packages/server/test/Csrf.test.ts`, `packages/client/test/Csrf.test.ts`; the tests behind each behavior are mapped in [`spec/traceability.md`](../traceability.md) §5, and a behavior whose text differs from the shipped code carries an *Implementation* or *Deviation* note. The design was drawn from `archive/PRD.md` §14 and §18.

## BEH-EA-073: `Sec-Fetch-Site` is the primary CSRF signal

```text
REQUIREMENT: `CsrfProtection` MUST inspect the `Sec-Fetch-Site` request
             header, when present, as its first signal, rejecting a
             cross-site request (`cross-site`) on an unsafe method before
             any other CSRF check runs.
```

`archive/PRD.md` §14 names `Sec-Fetch-Site` first among the mechanisms `CsrfProtection` composes. Because this header is set by the browser itself and cannot be forged by page script, it is a stronger signal than anything derived from request body or query content, and the design intent is to prefer it whenever the requesting browser sends it.

## BEH-EA-074: `Origin` is the fallback signal when `Sec-Fetch-Site` is absent

```text
REQUIREMENT: When a request carries no `Sec-Fetch-Site` header,
             `CsrfProtection` MUST fall back to comparing the `Origin`
             header against the application's configured allowed origins,
             rejecting a mismatch on an unsafe method.
```

`archive/PRD.md` §14 lists "Origin fallback" as the second layer of the same check, covering older or non-browser clients that do not send `Sec-Fetch-Site` at all. The two checks are designed to compose, not substitute for each other: `Sec-Fetch-Site` is preferred when available, and `Origin` is the documented fallback rather than an alternative a deployment must choose between.

**CORS posture (AGA-002).** awthaq ships **no CORS by default**: without `AuthHttp.cors` no response carries `Access-Control-Allow-Origin`, so a browser refuses to let any other origin read a response (same-origin, default-deny). `AuthHttp.cors()` (`@awthaq/server`) is the only supported way to open cross-origin access to a separate SPA origin, and its origin allowlist *is* `CsrfConfig.allowedOrigins`, the same value this behavior's `Origin` fallback compares against, so the edge policy and the CSRF policy cannot drift. It allows credentials, the methods `GET`/`POST`/`PATCH`/`DELETE`, the request headers `content-type`, the CSRF header and `authorization`, and exposes the rotated-token response header; an empty allowlist opens nothing. Opening CORS never relaxes `CsrfProtection`: a cross-site mutation still needs the double-submit pair.

## BEH-EA-075: A signed double-submit `__Host-csrf` cookie backs the header-based check

```
__Host-csrf=<signed-token>; Secure; SameSite=Strict; Path=/
x-csrf-token: <token read from the __Host-csrf cookie>
```

```text
REQUIREMENT: `CsrfProtection` MUST issue a signed `__Host-csrf` cookie
             readable by client-side script, and MUST require an unsafe
             request to echo that same token in an `x-csrf-token` header;
             a request presenting a mismatched or missing header value MUST
             be rejected.
```

`archive/PRD.md` §14 names "signed double-submit `__Host-csrf`" as the third mechanism `CsrfProtection` composes alongside `Sec-Fetch-Site`/`Origin`. The double-submit pattern's guarantee is that only a script running on the application's own origin can read the cookie and therefore reproduce it in a header — signing the cookie value additionally prevents a network attacker who cannot read the cookie from forging a plausible-looking token of their own.

A synchronizer-token pattern (a per-session, server-stored token embedded in every rendered form and checked against server-side state on submission) was the alternative available here, and it is not what awthaq chose. Synchronizer tokens require the server to hold per-session token state and require every response that could lead to a subsequent unsafe request to embed that token in the page — a model that fits a server-rendered form naturally but fits poorly against `HttpApi`'s JSON contract surface, where a client is a generated `HttpApiClient`/`AtomHttpApi.Service`, not a rendered HTML form with a hidden field to embed a token into. The signed double-submit cookie needs no server-side token store at all (the signature is what a synchronizer token's server-side lookup would otherwise verify), composes naturally with the same `Redacted`/stateless design the rest of the session and CSRF surface already uses, and lets the client-side requirement be enforced at the type level (BEH-EA-076) by a client library reading a cookie and setting a header — an operation a synchronizer token's "read the token out of the last rendered page" model has no equivalent of for a pure API client that never rendered a page in the first place. **The token is time-bound (CDS-006).** The signed value is `<iatSeconds>.<random>.<hmac(iat.random)>`: it is valid only while `now - iat <= CsrfConfig.maxAge` (default 24 hours; an `iat` more than 60 seconds in the future is rejected as clock skew), and the HMAC covers `iat`, so a token cannot be aged forward. `CsrfProtection` re-mints proactively — on any request, safe or unsafe, once a valid token is older than half of `maxAge` — so an active user never meets the expiry mid-session; a token past `maxAge` is invalid (`403` on an unsafe request, with the fresh cookie on that response). It is deliberately *not* bound to the session: the session secret rotates every `touchEvery` ([BEH-EA-052](07-sessions.md)), so a binding would answer every user with a `403` each hour.

**Signing-secret hygiene (SMS-004, ACS-005).** The HMAC-SHA256 (RFC 2104), constant-time comparison and hex encoding are one tested module in `@awthaq/ports` (`Hmac`, RFC 4231 vectors and Node's `createHmac` as an oracle) shared by this middleware, the passkey challenge cookie and the session hash comparison — not per-plugin copies. `Csrf.layerConfig` reads the secret from `AWTHAQ_CSRF_SECRET` (and allowed origins from `AWTHAQ_CSRF_ALLOWED_ORIGINS`) the way `KeyProvider.layerEnv` reads the encryption key, so the obvious composition never puts a literal secret in source; a present secret under 32 UTF-8 bytes dies with `WeakSigningSecret` at boot — enforced by `CsrfProtectionLive` itself (ACS-007), so no composition, `layerConfig` or not, can run CSRF signing on a guessable key.

The cost accepted in choosing double-submit over a synchronizer token is that double-submit's security rests entirely on the cookie's signature and on `Secure`/`HttpOnly`-adjacent isolation of the origin (an attacker who can read cookies via a same-origin script bug reads a valid token directly), whereas a synchronizer token stored only server-side is not readable through a cookie-read primitive at all — a narrower, but real, difference in what a same-origin script-injection bug exposes.

## BEH-EA-076: `requiredForClient: true` is enforced at the type level, not merely documented

> **Invariant:** [INV-EA-011](../invariants.md#inv-ea-011-csrf-protection-is-required-by-the-generated-clients-type-not-merely-documented)

```ts
export const CsrfClient = HttpApiMiddleware.layerClient(CsrfProtection, ({ next, request }) =>
  next(HttpClientRequest.setHeader(request, "x-csrf-token", readCookie("__Host-csrf") ?? "")))
```

```text
REQUIREMENT: An `HttpApiClient` / `AtomHttpApi.Service` built over a
             contract group carrying `CsrfProtection` MUST fail to
             type-check unless `HttpApiMiddleware.layerClient(CsrfProtection,
             ...)` is supplied to the client build.
```

`archive/design/usage-examples-v4.md` §11.1 shows the intended failure directly: removing the `CsrfClient` layer from the client program's provided layers is designed to produce a compile error ("`ForClient<CsrfProtection>` is required"), not a runtime 403 a user discovers by submitting a form. This restates BEH-EA-030 from the client's point of view, since the same requirement governs both the server-side middleware definition and every client generated against it.

## BEH-EA-077: Only unsafe methods are protected; safe methods are exempt by construction

```text
REQUIREMENT: `CsrfProtection` MUST enforce its checks only on state-changing
             (unsafe) HTTP methods — `POST`, `PUT`, `PATCH`, `DELETE`; a
             `GET` or `HEAD` request MUST NOT be subject to CSRF rejection.
```

`archive/design/usage-examples-v4.md` §1.1 shows an unauthenticated `GET /auth/session` succeeding with no CSRF header at all, while §1.2's `POST /auth/password/sign-up` requires one — the standard CSRF scoping rule (only requests that change state are worth protecting against forgery) applied consistently across every group that carries the middleware, so a read-only endpoint never needs a client to manage the CSRF header at all.

**Bearer exemption (MNA-008, decision 24 §2).** A request carrying a non-empty `Authorization` header is exempt from both minting and enforcement, even on an unsafe method:

```text
REQUIREMENT: `CsrfProtection` MUST NOT reject, and MUST NOT mint a cookie
             for, an unsafe request that carries a non-empty `Authorization`
             header.
```

The double-submit and site checks exist to stop a browser *automatically* attaching an ambient credential (a cookie) to a forged cross-site request. A cross-site page cannot set `Authorization` without a CORS preflight the server's own policy must separately allow, so an explicitly-bearer request is outside CSRF's threat model, and a cookie-less native or server-to-server client must not be 403'd on sign-out, revoke or delete-user. A cookie-authenticated request with no `Authorization` header stays fully protected. (`Auth.make(..., { csrf })`, decision 24 §1, is still unimplemented and tracked with APS-001/PDR-002.)

**Cookie-less exemption (native first sign-in).** An unsafe request that carries **no `Cookie` header at all** (and no `Authorization`) is exempt from the double-submit pair, but not from the site checks:

```text
REQUIREMENT: `CsrfProtection` MUST NOT demand the `__Host-csrf` double-submit
             pair of an unsafe request that carries no `Cookie` header (a blank
             header counts as none) and no `Authorization` header, and MUST
             instead admit it only through the cookie-less site check: a
             `Sec-Fetch-Site` of `same-origin` or `none`; a `same-site` request
             only when its `Origin` is in `CsrfConfig.allowedOrigins`;
             `cross-site` never; when `Sec-Fetch-Site` is absent, an absent
             `Origin` (a non-browser caller) or an allowed one, never a foreign
             or `null` `Origin`. A request carrying any cookie, however
             unrelated, keeps the full check. `CsrfConfig.requireTokenWithoutCookies:
             true` withdraws the exemption.
```

*Decision record (ADR-worthy reasoning; 2026-09-29, adopted as recommended, the user may revisit).* Before this rule a native client's **first** sign-in or sign-up (no cookie jar, no bearer token yet, so neither the bearer exemption nor a double-submit cookie applied) answered `403 CsrfRejected`, and the only way out was a warm-up `GET` to receive a cookie the client had no jar to keep. CSRF is a defence of *ambient* credentials: it exists because a browser attaches cookies to a request an attacker's page caused. A request that arrives with no `Cookie` header has no ambient credential on it, so there is nothing for a forged request to ride, and the double-submit pair (a proof of "this request came from a script that could read our cookie") protects nothing that is not already absent. What the pair *would* still catch is the residual threat of a cookie-less forged request, **login CSRF** (an attacker's page makes the victim's browser sign in as the attacker); that is answered by the site checks, which is why they are kept and made stricter, not by the pair.

| Threat | Outcome |
|---|---|
| Native / CLI / server client, first sign-in, sign-up, reset, `POST /oauth/token`; no cookies, no site headers | Allowed: no ambient credential; the unguessable credentials in the body are the whole authorization. |
| Browser, first visit, same-origin page (`Sec-Fetch-Site: same-origin`) | Allowed: our own origin. |
| Browser with a **stale or unrelated cookie** (an expired `__Host-session`, an analytics cookie) | Still needs the pair: a `Cookie` header means an ambient credential may ride, and the rule is deliberately the coarse "no `Cookie` header at all" rather than "no session cookie". The client's cold-start bootstrap (CDS-007) covers it. |
| Login CSRF from another site: the victim's browser withholds `SameSite=Strict` cookies from a cross-site request, so it arrives cookie-less | Refused: `Sec-Fetch-Site: cross-site`, or a foreign/`null` `Origin`, fails the cookie-less site check. |
| Login CSRF from a same-site sibling (a takeover-prone subdomain; `Sec-Fetch-Site: same-site`) | Refused unless the sibling's `Origin` is allow-listed: `same-site` is not our origin. |
| A browser too old to send either `Sec-Fetch-Site` or (on a cross-origin `POST`) `Origin` | **Accepted, documented residual.** Indistinguishable from a native caller. No supported browser omits both; a deployment that must cover one sets `requireTokenWithoutCookies: true`. |
| Credentials that are ambient but not cookies (mTLS client certificates, an intranet network position, HTTP Basic) | Out of scope: none of awthaq's own strategies authenticate that way. A deployment that fronts awthaq with such an ambient credential sets `requireTokenWithoutCookies: true`. |

Minting is unchanged (`__Host-csrf` is still set on a cookie-less response, so a browser that arrives cookie-less holds a token for its next request). The client half for a program with no jar is `CsrfClientNative` (`@awthaq/client`): it sends no header and never retries. Tests: `packages/server/test/Csrf.test.ts` ("Csrf cookie-less requests"), `packages/password/test/AuthHttp.test.ts` (native first sign-up and sign-in over HTTP), `packages/client/test/Csrf.test.ts`.

## BEH-EA-078: A rejected CSRF check fails with a typed `CsrfRejected` error at `403`

```ts
class CsrfRejected extends Schema.TaggedError<CsrfRejected>()("CsrfRejected", {}, { httpApiStatus: 403 }) {}
```

```text
REQUIREMENT: A request failing any of `CsrfProtection`'s checks (BEH-EA-073
             through BEH-EA-075) MUST fail with a `Schema.TaggedError`
             tagged `CsrfRejected`, annotated `httpApiStatus: 403`, uniformly
             across every group the middleware protects.
```

This follows BEH-EA-027's general rule (every contract error is a `Schema.TaggedError` with its own `httpApiStatus`) applied to the specific failure `CsrfProtection` produces, so that a client's `Effect.catchTag("CsrfRejected", ...)` (`archive/design/usage-examples-v4.md` §11.2 shows the same pattern for other tagged errors) works identically regardless of which group or which of the three underlying checks caused the rejection.

## BEH-EA-079: A client may opt out of CSRF by choosing a bearer-only contract variant

```ts
const NativeApi = Auth.api(plugins.map((p) => p.contract), { csrf: false })   // groups without CsrfProtection
```

```text
REQUIREMENT: A native (bearer-token) client MUST be able to make unsafe
             requests with no CSRF header and no double-submit cookie: a request
             carrying a non-empty `Authorization` header is exempt from CSRF
             minting and enforcement, while an empty `Authorization` header is
             not.
```

**First sign-in of a bearer client.** The exemption above needs a bearer token, which a client does not have until it has signed in; that first request is covered by the cookie-less exemption of BEH-EA-077 (no `Cookie` header, so no ambient credential), not by the `Authorization` one.

**Superseded in part (PV-262, decision 24 / MNA-008).** The `Auth.api(..., { csrf: false })` contract variant this behavior originally specified is not built and is retired; the exemption is a runtime rule of `CsrfProtectionLive` instead (REQ-EA-689, `packages/server/test/Csrf.test.ts`). The trade-off the original text argued against (a check that is present in the type but skipped at runtime) is accepted deliberately: a header a cross-site page cannot set without a CORS preflight is what makes the skip safe. REQ-EA-219/220 describe the retired variant and stay skipped, marked superseded.

`archive/design/usage-examples-v4.md` §11.3 documents this as the native-client path: because bearer-token clients (mobile apps, CLIs, service-to-service callers) have no cookie jar and no double-submit cookie to echo, the design removes `CsrfProtection` from the contract entirely for that variant rather than adding a runtime bypass flag to the middleware itself — a bypassable check is a weaker design than no check being present in the type at all, since only the latter is visible in `auth.api`'s own type.

## BEH-EA-080: The CSRF cookie name and header name are fixed, not per-plugin configurable

```
__Host-csrf   (cookie name)
x-csrf-token  (header name)
```

```text
REQUIREMENT: `__Host-csrf` and `x-csrf-token` MUST be the fixed cookie and
             header names for every application composed through
             `Auth.make`; no plugin or configuration override MAY rename
             either, since the client-side CSRF layer (BEH-EA-076) is
             written once, against these fixed names, and reused by every
             application.
```

Fixing these names is what makes `HttpApiMiddleware.layerClient(CsrfProtection, ...)` (BEH-EA-076) a single, reusable implementation rather than something every application must rewrite against its own naming choices — the same reasoning `archive/PRD.md` §5 (Design principle 5, "one source of truth per concept") applies to contracts and models applies here to a security-relevant name that must match exactly between server and client.

_Previous: [BEH-EA-072](09-authentication-middleware.md#beh-ea-072-the-security-records-declaration-order-is-the-entire-strategy-chain--no-separate-ordering-mechanism-exists)_
_Next: [BEH-EA-081](11-http-error-mapping.md#beh-ea-081-a-plugins-handlers-are-built-with-httpapibuildergroup-against-its-own-contract)_
