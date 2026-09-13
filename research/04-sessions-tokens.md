# Sessions & Tokens — Research

Domain owner: research agent 04. Answers Q45–Q47, Q60–Q62, and the session-related parts of Q35 (CSRF), Q61 (strategy chain), Q88 (threat model). Verified against sources as of 2026-09.

## TL;DR

- **Opaque random tokens, not JWTs, should be the default session credential.** The canonical critique (Sven Slootweg's "Stop using JWT for sessions") shows stateless JWTs cannot be revoked, go stale, and bloat cookies; stateful JWTs are just session cookies without battle-tested implementations. Counterarguments (Duck Type Labs) concede the core point: revocation and staleness are properties of *statelessness*, and cookie-based sessions win the XSS-storage tradeoff.
- **Token format winner: composite `id.secret`** (Lucia/Pilcrow design): unguessable ID + 32-byte CSPRNG secret, joined for transport, secret SHA-256-hashed at rest, verified with constant-time comparison. The ID lets the server reference/log a session without handling the live credential.
- **Cookie hardening is a solved checklist**: `__Host-` (or the newer `__Host-Http-`) prefix, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, no `Domain` — all verifiable browser-enforced guarantees (MDN, RFC 10017 §6.1.3.2, OWASP).
- **Rotation**: mandatory new session at every authentication and privilege/permission change (session-fixation defense, OWASP); sliding idle expiry (Lucia `active/idle`, better-auth `updateAge`) plus an absolute ceiling (Clerk/OAuth-style "max lifetime"); at least one of idle/absolute must be enabled.
- **Reuse detection, not just rotation**: for refresh/step-up token families, issuing a new token per exchange *and* invalidating the whole family when an already-used token reappears is the RFC 9700 §4.14 requirement and what Auth0 implements; effect-auth should copy the pattern for any multi-token chains.
- **JWT plugin**: EdDSA/Ed25519 (OKP) default with a JWKS endpoint and `kid`-driven key cache refresh — exactly what better-auth ships — under RFC 8725 rules (explicit algorithm allowlist, `iss`/`aud`/`exp` validation, explicit `typ`, mutually exclusive validation per token kind). JWTs are for *delegation at a distance*, never the primary session.
- **CSRF default for a library**: `SameSite=Strict` + signed (session-bound HMAC) double-submit token + Origin/`Sec-Fetch-Site` validation on unsafe methods; bearer/api-key requests are CSRF-exempt because they carry no ambient credentials. Naive (unsigned) double-submit is now OWASP-discouraged.
- **Impersonation** has a converging industry spec: opt-in + admin-gated, mandatory reason, 60-minute hard expiry, dual identity (`sub` = user, `act` = impersonator, RFC 8693 style), distinct audit events, visible staff bar (WorkOS AuthKit; Auth0 Session Delegation, Aug 2026).
- **Strategy chain**: one resolution surface, ordered candidate credentials (session cookie → bearer → API key), first match wins, memoized per request. Better-auth and Lucia both funnel cookie and bearer through the same `getSession`/`validateSession` path; caching must be short-lived and revocation-aware.
- **DPoP (RFC 9449) is out of scope for v1** — it sender-constrains *OAuth* access/refresh tokens; our browser story is an HttpOnly-cookie session where DPoP's threat model does not apply, and DPoP explicitly lists in-browser proxying attacks as out of scope.

---

## Questions answered

### Q45 — Session model: token format, storage, device metadata, rotation, concurrency, revocation

**Evidence.**

- The foundational debate: joepie91's *Stop using JWT for sessions* ([part 1](http://cryto.net/~joepie91/blog/2016/06/13/stop-using-jwt-for-sessions/), [part 2](http://cryto.net/~joepie91/blog/2016/06/19/stop-using-jwt-for-sessions-part-2-why-your-solution-doesnt-work/)) dismantles each claimed JWT advantage (scale, CSRF immunity, mobile) and documents the structural flaws: stateless JWTs "cannot be invalidated" and their claims "go stale" (a revoked `admin` role stays valid until expiry); storage forces a choice between cookies (no benefit over opaque IDs) or localStorage (XSS-exfiltratable). His verdict — "Stateless JWT tokens cannot be invalidated or updated… Stateful JWT tokens are functionally the same as session cookies, but without the battle-tested implementations" — has aged well; the 2026 [Hacker News thread](https://news.ycombinator.com/item?id=48558147) still runs on the same logic. He grants JWT a legitimate niche: short-lived, single-use delegation tokens between services.
- Balance: [Duck Type Labs' review](https://www.ducktypelabs.com/review-stop-using-jwt-for-sessions/) notes the invalidation/staleness critique applies to *any* stateless session store (e.g., Rails' default cookie store) and frames the real tradeoff: XSS + localStorage lets an attacker exfiltrate a long-lived credential; XSS + HttpOnly cookie merely lets them ride the session while the tab lives. CSRF is the cheaper defense of the two.
- OWASP Session Management Cheat Sheet ([cheatsheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)): ≥64 bits of entropy from a CSPRNG; IDs must be meaningless; accept **only** session IDs the server itself generated ("strict" management); cookies are the only recommended exchange channel; renew the ID at every privilege level change; idle + absolute timeouts enforced **server-side**; users should be able to view and remotely terminate their active sessions; log a salted hash of the session ID, never the ID.
- Token format precedent (Lucia lineage): [Pilcrow's auth book, Sessions](https://auth.pilcrowonpaper.com/sessions) — "I would recommend generating both an ID and a secret for your sessions… The ID and secret is combined to a single token… hashed before storage… compare… using a constant-time comparison. I recommend using a 32-byte secret and hashing it with SHA-256." Lucia v2 implemented this ([v2 docs](https://v2.lucia-auth.com/basics/sessions/): 40-char `[a-z0-9]` session ID; `activePeriodExpiresAt` + `idlePeriodExpiresAt`; `state: active|idle|dead`; `fresh` flag). The rationale for splitting ID from secret: you can reference the session in logs/admin UIs without touching the credential ([lucia discussion #1746](https://github.com/lucia-auth/lucia/discussions/1746)).
- Mainstream-framework reality check: better-auth stores a plain `token` field that doubles as the cookie value plus `ipAddress`/`userAgent` metadata, default `expiresIn` 7 days refreshed on use via `updateAge` (1 day), a `freshAge` (1 day) freshness gate for sensitive endpoints, and revocation helpers `revokeSession`/`revokeOtherSessions`/`revokeSessions` ([session management](https://better-auth.com/docs/concepts/session-management)). Its optional `cookieCache` (signed/JWT/JWE client-side cache) ships with a documented revocation caveat: revoked sessions stay usable on other devices until the cache TTL lapses — a direct demonstration of why server-side lookup remains the revocation source of truth.
- Clerk exposes exactly two lifetime knobs — **inactivity timeout** and **maximum lifetime** (default 7 days) — and forbids disabling both; also documents the browser-enforced 400-day `Max-Age` ceiling (Chrome) ([session options](https://clerk.com/docs/guides/secure/session-options)). WorkOS sessions carry server-side revocation, custom expirations, and device profile info, and expose a queryable session object (`ip_address`, `user_agent`, `created_at`, `ended_at`, `status`) ([AuthKit sessions](https://workos.com/blog/march-updates), [session shape](https://workos.com/blog/support-impersonation-delegated-sessions)).

**Recommendation.**

1. Sessions are **opaque composite tokens**: `id.secret` (secret = 32 CSPRNG bytes, base64url; `id` = 16–20 random bytes). Persist `{ id, secretHash: SHA-256(secret), userId, createdAt, lastActiveAt, absoluteExpiresAt, idleExpiresAt, ipAddress, userAgent, … }`. Never store the raw secret. Unique index on `secretHash`.
2. Verification = extract `id.secret` → look up by `id` → SHA-256(secret) → **constant-time compare** → check both expiries. All comparisons via `node:crypto.timingSafeEqual` (or an audited pure-JS constant-time fallback on WebCrypto-only runtimes, which exposes no such primitive — [INFERENCE] from the WebCrypto surface; the OWASP CSRF sheet's own pseudo-code mandates `constantTimeEquals` for exactly this class of comparison).
3. Cookie default: name `__Host-session` (respect `__Host-Http-` on supporting UAs), `Secure; HttpOnly; SameSite=Strict; Path=/`, no `Domain`; `Max-Age` mirrors server expiry, capped at 400 days.
4. Rotation policy: **new session issued** (new id+secret, old row deleted) at every login, every privilege/permission change, and after password/email change (OWASP renewal rule). Sliding refresh is an *expiry update*, not a token rotation, throttled like better-auth's `updateAge` to avoid a write per request.
5. Concurrency: unlimited sessions by default with a user-facing "devices" list (browser/OS derived from UA, IP, created/last-active) and per-session revoke + "revoke all others" (better-auth/OWASP pattern). `maxSessions` is an opt-in plugin knob.
6. Revocation is a server-side row delete — authoritative on the next request. Any cookie-cached session data must carry a small TTL (≤5 min) and be documented as revocation-lagging, per better-auth's caveat.
7. Telemetry: log `id` (not `secret`, not the full token); hash the ID if logs are exported to untrusted sinks (OWASP salted-hash rule).

**Confidence:** high. Token format, rotation, and revocation semantics are convergent across OWASP, the Lucia/Pilcrow lineage, better-auth, Clerk, and WorkOS; only the exact lifetime numbers are product judgment.

---

### Q46 — Verification/tokens: purpose-scoped tokens, TTLs, single-use, replay protection

**Evidence.**

- PRD §28.3 already fixes the shape: "All security-sensitive tokens must use cryptographically secure randomness… expiration, purpose, optional audience, one-time-use semantics where appropriate" (PRD.md).
- OWASP's strict-management rule — never accept a session/token value the server did not issue, and treat unexpected presented values as a suspicious event to alert on ([Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)) — generalizes to verification tokens: unknown-token lookups should be loggable security events, not silent 404s.
- Single-use enforcement has an explicit normative precedent in RFC 6238 §5.2: "The verifier MUST NOT accept the second attempt of the OTP after the successful validation has been issued for the first OTP, which ensures one-time only use" ([RFC 6238](https://www.rfc-editor.org/rfc/rfc6238)). The same consumed-token state machine applies to email-verification/reset/invite tokens.
- Replay *detection* (vs mere prevention) is the upgrade worth copying from OAuth refresh-token rotation: RFC 9700 §4.14.2 requires public-client refresh tokens to be sender-constrained **or** rotated with retained lineage, so that presenting an invalidated token reveals a breach and revokes the family ([RFC 9700](https://www.rfc-editor.org/rfc/rfc9700)); Auth0 implements this as automatic "token family" invalidation plus a `ferrt` log event ([refresh token rotation](https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation)).
- Pilcrow models flows like email verification as their own purpose-scoped server-side session ("a sign-up session to keep track of the user's email address and the email address verification process") rather than a different token technology ([Sessions](https://auth.pilcrowonpaper.com/sessions)) — one mechanism, many purposes.

**Recommendation.**

1. One `Verification` (or `Token`) table for all purposes: `{ id, userId?, purpose: Schema.Literal("email_verify" | "password_reset" | "invite" | "email_otp" | …), tokenHash (SHA-256), audience?, expiresAt, consumedAt?, createdAt }`. Purpose is a closed union so plugins extend it by declaration (compile-time exhaustiveness), matching PRD's typed-error philosophy.
2. Delivery format follows Q45's composite design; hashing at rest means a database leak never yields usable tokens.
3. TTL defaults: email verification 24 h, password reset 1 h, invite 7 days, email OTP 10 min — all `Duration`-typed config, enforced server-side.
4. Single-use: verification consumes the row in the same transaction that applies the state change; `consumedAt` is kept (not deleted) for a retention window.
5. Replay of a consumed token = security event: emit `auth.token.replay` (redacted: purpose + token id, per PRD §30) and, when the token is chained to a session family (e.g., password-reset initiated sessions), revoke the family — the RFC 9700/Auth0 reuse-detection posture.
6. Do **not** reuse this table for refresh-token rotation if we ever add refresh tokens; rotation needs lineage (parent/child), which is a separate concern (see Q60/Q61 notes and RFC 9700 §4.14).

**Confidence:** high. The state machine is standard; only TTL numbers are tunable defaults.

---

### Q47 — Time handling: Duration + TestClock, clock skew, claims times

**Evidence.**

- Two-clock model: Lucia tracks `activePeriodExpiresAt` and `idlePeriodExpiresAt` independently, with `validateSession` *resetting* an idle session by extending expiry — "Active sessions are your access tokens, and idle sessions are your refresh tokens" ([Lucia v2 sessions](https://v2.lucia-auth.com/basics/sessions/)).
- OWASP gives the anchors: idle timeouts 2–5 min for high-value apps, 15–30 min for low risk; absolute timeouts 4–8 h for an office-worker app; a "renewal timeout" variant rotates the ID mid-session, with an explicitly noted race window; timeouts "must be enforced server-side" because client-tracked time is attacker-malleable ([Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)).
- Commercial defaults cluster around 7 days max lifetime (better-auth `expiresIn` 7 d + `updateAge` 1 d; Clerk max lifetime 7 d default, inactivity optional but one must stay enabled) ([better-auth](https://better-auth.com/docs/concepts/session-management), [Clerk](https://clerk.com/docs/guides/secure/session-options)). PRD's own example config is `session: { expiration: Duration.days(30) }` (PRD.md §31).
- Browser reality: cookies obey a 400-day `Max-Age` cap (Chrome, per RFC 6265bis work) and browsers may restore "session" cookies via session-restore features, so client-side lifetime is advisory only ([Clerk browser limitations](https://clerk.com/docs/guides/secure/session-options), [MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie)).
- Clock skew: RFC 6238 §5.2 — validators SHOULD compare against past timestamps within a transmission-delay window, "We RECOMMEND that at most one time step is allowed as the network delay" (X = 30 s), may allow a configured backward-step limit, and MUST reject reuse of an OTP within its window ([RFC 6238](https://www.rfc-editor.org/rfc/rfc6238)).
- For issued-JWT times, RFC 8725 requires validating `iss`, `sub`, `aud` and rejecting tokens failing `exp`/`nbf` checks; all seven-date handling (`iat`/`exp`/`nbf`) should use a single injected clock ([RFC 8725](https://www.rfc-editor.org/rfc/rfc8725)).

**Recommendation.**

1. All expiry configuration is `Duration` (PRD already does this); all stored instants are UTC epoch millis through `Schema.UnixTime`-style schemas; **the only time source in the runtime is an injected `Clock` service** — production `Clock.default`, tests `TestClock`. Expiry tests then look like "advance clock past idleExpiresAt → expect SessionExpired," which is PRD Q18's stated testing model.
2. Session row carries `createdAt`, `absoluteExpiresAt`, `idleExpiresAt`, `lastActiveAt`. Sliding refresh updates `idleExpiresAt = now + idleTtl` (throttled); `absoluteExpiresAt` never moves. Defaults: absolute 30 days (PRD example), idle 7 days; both configurable; API refuses a config with neither bound ("at least one must be enabled," Clerk's rule).
3. Cookie `Max-Age` is set from the server's expiry at issue time and capped at 400 days; the server remains the enforcement point.
4. TOTP/OTP skew: default acceptance window = current step ±1 (30 s steps), configurable 0–2, with per-code single-use enforcement; record drift per credential as RFC 6238 suggests (feeds Q58 owners).
5. JWT plugin times: set `iat`/`exp` from the same Clock; on verify, require `exp`, honor `nbf`, reject missing/invalid temporal claims, and treat `exp` as the only trust boundary (no client-side extension logic).

**Confidence:** high.

---

### Q60 — JWT plugin: algorithm policy, JWKS rotation, claims mapping, JWT vs opaque

**Evidence.**

- RFC 8725 (JWT BCP) is the floor: perform algorithm verification against an explicit allowlist (the `alg` header is attacker-controlled — the `none` attack and RS256→HS256 confusion are §2.1's documented history); use appropriate algorithms; validate issuer/subject/audience; do not trust received claims; use explicit typing (`typ`) and "mutually exclusive validation rules for different kinds of JWTs" to stop cross-JWT confusion (§3.8/3.11/3.12) ([RFC 8725](https://www.rfc-editor.org/rfc/rfc8725)).
- Asymmetric > symmetric: HS256 invites weak shared secrets (§2.2) and is useless for third-party verification; the deployed TS precedent — better-auth's JWT plugin — defaults to **EdDSA/Ed25519 (OKP `crv`)** with a `/jwks` endpoint, `kid` in the header, and "if a JWT with a different `kid` is received, fetch the JWKS again," while its own docs insist the plugin "is not meant as a replacement for the session" ([better-auth JWT](https://www.better-auth.com/docs/plugins/jwt)).
- Scope discipline: joepie91's constructive conclusion — JWTs fit "Hello Server B, Server A told me I could do X, here's the proof" patterns: short-lived, single-use, per-operation tokens issued by a sessionful server ([part 1, closing section](http://cryto.net/~joepie91/blog/2016/06/13/stop-using-jwt-for-sessions/)). PRD similarly lists JWT as a phase-2 plugin, with sessions in core.
- If bearer JWTs leave the cookie perimeter, sender-constraining is the RFC 9700 §2.2.1 expectation for high-value tokens, via mTLS (RFC 8705) or DPoP (RFC 9449) ([RFC 9700](https://www.rfc-editor.org/rfc/rfc9700)); see DPoP note below.

**DPoP — does it matter for effect-auth?** For our primary architecture (HttpOnly-cookie browser session), no: DPoP sender-constrains *OAuth-style bearer* access/refresh tokens, its headline win is making exfiltrated tokens unusable outside the holder's key, and it cannot stop an XSS'd page from *using* the session in-place — RFC 9449 §2 explicitly scopes "proxying requests via the user's browser" attacks out ([RFC 9449](https://www.rfc-editor.org/rfc/rfc9449)). It becomes relevant only if/when we ship OAuth-provider features minting bearer access tokens for third-party clients; then it's a phase-3 consideration, ideally opt-in behind the OAuth plugin.

**Recommendation.**

1. `@effect-auth/plugin-jwt` (phase 2, per PRD §26): default **EdDSA (Ed25519)**, keypair generated at first boot and persisted via the configured key store; HS256 allowed only as explicit opt-in with a ≥32-byte generated secret and a config warning.
2. Sign with `kid`; serve `GET /auth/jwks`; verifiers cache JWKS and refresh on unknown `kid` (better-auth's documented client behavior); support scheduled rotation by publishing two keys (new + old) and retiring old signing after a grace period.
3. Strict verify policy, non-negotiable: fixed allowlist `["EdDSA","ES256"]` (+HS256 only if enabled), reject tokens whose `alg`/`typ`/`kid` don't match the expected kind, require and check `iss`, `aud`, `exp`; require explicit `typ` (e.g., `JWT+effect-auth`) and keep validation rules mutually exclusive per token kind (access vs ID vs plugin-issued) per RFC 8725 §3.12.
4. Claims mapping: stable core (`sub` = principal id, `sid` = session id, `iat`, `exp`, `iss`, `aud`, optional `act` for impersonation — see Q62), plugin-configurable extra claims; `sid` gives any resource server an optional "check session still valid" escalation path, restoring revocability.
5. Default TTL short (15 min); position the plugin exactly as better-auth does — a bridge for services that can't consult the session store — and keep the opaque session as the source of truth (PRD: JWT is phase 2).
6. Library: build on `jose` (the de-facto TS JOSE implementation, used in better-auth's own docs examples) rather than hand-rolled JOSE; isolate it behind a capability so edge runtimes can swap in `@noble/*`-based signers if needed.

**Confidence:** high on algorithm policy/JWKS/verify rules; medium on default TTL and claims set (product judgment).

---

### Q61 — Strategy chain: session → api key → bearer, ambiguity, caching

**Evidence.**

- Both major TS precedents route every credential through **one resolution surface**: better-auth's bearer plugin makes `Authorization: Bearer <session token>` flow into the same `auth.api.getSession({ headers })` used by cookies, flags itself "Use this cautiously; it is intended only for APIs that don't support cookies," and offers `requireSignature` to require signed tokens ([bearer plugin](https://www.better-auth.com/docs/plugins/bearer)); Lucia similarly supports cookie and bearer transports over one `validateSession`, with guidance "Cookies are preferred for regular websites and web-apps, whereas bearer tokens are preferred for standalone servers for mobile/desktop apps" ([Lucia v2 sessions](https://v2.lucia-auth.com/basics/sessions/)).
- OWASP's "used vs accepted" principle: an application must enumerate and intentionally constrain *which* transport mechanisms it accepts — accepting an unlisted mechanism is a fixation vector ([Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)). A strategy chain is exactly this enumeration, made type-level.
- Credential shapes can be made mutually unambiguous by construction: opaque session `id.secret` (base64url, one dot), API keys `prefix_secret` with a vendor prefix (the `(provider, providerAccountId)`-style uniqueness is the Q59 owner's domain), JWTs `xxx.yyy.zzz` + `Authorization: Bearer`. Ambiguity then lives only in policy (does a revoked-but-uncached key win over a live session?), not in parsing.
- Bearer tokens are replayable by anyone who steals them; RFC 9700's attacker model (§3, §4.10) treats access-token theft as assumed and pushes sender-constraining/audience restriction for high-value bearer usage ([RFC 9700](https://www.rfc-editor.org/rfc/rfc9700)) — the practical consequence for us: bearer-in-the-chain must be an explicit, documented downgrade from cookie sessions.
- Caching: better-auth's cookieCache documents the exact failure mode of careless caching — other devices keep honoring a revoked session until cache expiry ([session management](https://better-auth.com/docs/concepts/session-management)).

**Recommendation.**

1. `SessionResolver` = ordered list of strategies installed by plugins: default `cookieSession() → bearer() → apiKey()`; each strategy returns `Option<ResolvedPrincipal>` with a typed `CredentialKind`, and the first `Some` wins. Install order is compile-time visible (PRD's `Auth.make`), so "which credential beats which" is a config review question, not a runtime surprise.
2. Dispatch by cheap shape sniffing first (cookie name always present; `Authorization: Bearer` present only when configured), then strategy-internal verification. Because token formats are disjoint by construction, "first match wins" is deterministic; document that explicitly.
3. Ambiguity policy: no fallback chaining *within* a request after a successful resolution; a failed verification of a *present* credential (bad API key) is a typed error, not a silent fallthrough to the next strategy — otherwise attackers can downgrade probes ("is this a valid API key?") through the chain.
4. Per-request memoization, not cross-request caching: resolve once per request into the request context (FiberRef/`Effect.cachedInvalidate`-style within the request scope), so a handler and its authorization checks share one resolution and one DB hit. Cross-request caching (cookieCache-style) is an opt-in plugin with revocation-lag documentation and a ≤5 min default TTL.
5. Bearer strategy inherits all session semantics (same rows, same revocation) rather than minting a parallel token universe; `requireSignature`-style hardening and per-strategy enablement stay config-driven.

**Confidence:** medium-high. Composition shape is well-precedented; the "presented-but-invalid credential = error, not fallthrough" rule is my inference from OWASP's accepted-mechanisms principle and should be ADR'd.

---

### Q62 — Impersonation / admin "login as"

**Evidence.**

- WorkOS AuthKit's documented implementation is the cleanest public spec ([impersonation docs](https://workos.com/docs/authkit/impersonation)): disabled by default in every environment; enabling requires an Admin role; starting a session **requires a reason** which is stored; sessions **auto-expire after 60 minutes** (a ceiling, not configurable); the session record carries an `impersonator` object (email + reason); a `session.created` event is emitted and visible to the customer; the access token carries an **`act` claim** with the impersonator's email; apps are encouraged to render a distinct "staff bar" (`<Impersonation />` in `authkit-nextjs`) with an exit control; revocation is an explicit API call.
- Auth0's August 2026 *Session Delegation* (Custom Token Exchange) converges on the same primitive: `sub` = the user, `act` = the acting identity (RFC 8693 delegation model), short-lived sessions, **no refresh tokens**, MFA/consent skipped by design, optional IP binding, and "delegated logins written as distinct tenant log events" ([WorkOS analysis of Auth0's changelog](https://workos.com/blog/support-impersonation-delegated-sessions)).
- The same WorkOS write-up distills the enterprise-review checklist: "a scoped entry point, dual identity in the token, a session that expires on its own, and a separate audit record" — and stresses reason + session_id must be *schema-required* in audit events so an event that forgets who authorized the access fails at emit time.
- OWASP independently flags the audit angle: admin interfaces used for impersonation "must be thoroughly protected," and full session lifecycle logging is expected ([Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)).

**Recommendation.**

1. `Admin`/`Impersonation` plugin (phase 2 per PRD §26), **off by default**; enabling is a typed config flag requiring an `admin`-gated permission on the acting principal.
2. Impersonation creates a **dedicated session row**, never mutates the admin's own session: `userId` = target, `actingPrincipalId` = admin (the `act` slot), `impersonationReason` (required at the API level, `Schema`-nonempty), `expiresAt = now + 60 min` (hard ceiling, no sliding refresh, no family renewal — Auth0's "no refresh tokens" posture).
3. `CurrentPrincipal` exposes the dual identity: `{ user: target, act?: impersonator }`; authorization policies can branch on `act` (e.g., force read-only or redact billing views).
4. Events: `auth.session.create` with `impersonator` metadata on start, `auth.session.revoke` on end (WorkOS parity); document the "actor = human, targets = user" audit-event convention for application-level actions.
5. Client surface: `impersonated: true` in the session payload so UIs render a staff bar + "stop impersonating" control; revocation endpoint for early exit.
6. Tests (feeds Q88/Q94): impersonation blocked when disabled; blocked without permission; reason enforced; expiry enforced via TestClock; target-user revocation kills the impersonation session; audit events emitted with both ids.

**Confidence:** high — two independent 2026 industry implementations agree on the pattern; effect-auth's only novel decision is plugin placement.

---

### Q35 (session-related parts) — Default CSRF strategy for cookie flows, and server-to-server interaction

**Evidence.**

- OWASP's current decision tree ([CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)): stateful software → synchronizer (per-session server-stored) tokens; stateless → **signed double-submit** (HMAC-bound to a session-dependent value, compared with `constantTimeEquals`); the **naive** double-submit cookie is now explicitly DISCOURAGED (an attacker who can write cookies — sibling subdomain, DNS takeover — forges a match); SameSite is "defense in depth… not a replacement for a CSRF token"; Fetch Metadata (`Sec-Fetch-Site`, >98% browser coverage, all majors since March 2023) is a sanctioned primary signal **with mandatory Origin-header fallback**; custom request headers force CORS preflight and are "more secure" carriers; GETs must never change state.
- RFC 10017, *OAuth 2.0 for Browser-Based Applications* (published **August 2026**, BCP 212 — authors Parecki, De Ryck, Waite) makes BFF the benchmark architecture and pins the cookie + CSRF combo: BFF cookies MUST be `Secure` + `HttpOnly`, SHOULD be `SameSite=Strict` with `Path=/`, no `Domain`, and a `__Host-Http-`-style prefix; the BFF "MUST implement a proper CSRF defense"; `SameSite=Strict` suffices only when nothing else shares the site (eTLD+1) — sibling-subdomain attacks are cross-*origin* but same-*site*; requiring a custom header from the SPA turns CORS into an effective CSRF defense; anti-forgery/double-submit is the listed alternative ([RFC 10017 §6.1.3](https://www.rfc-editor.org/info/rfc10017)).
- Cookie attribute ground truth: `__Host-` requires `Secure` + no `Domain` + `Path=/` and yields "a cookie that is as close as can be to treating the origin as a security boundary"; the newer `__Host-Http-` additionally guarantees HttpOnly ([MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie)); OWASP recommends `__Host-` for session IDs ([Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)).
- Server-to-server clients: CSRF is by definition an attack on **ambient** credentials (cookies the browser attaches). A request authenticated by `Authorization` bearer or API key carries no ambient credentials and is CSRF-immune by construction; RFC 10017's threat analysis reaches the same boundary — its CSRF defenses exist precisely and only because the BFF session is cookie-carried.

**Recommendation.**

1. Core middleware (cookie flows only): `SameSite=Strict` session cookie + **signed double-submit CSRF token** — random value `r`, `token = HMAC-SHA256(csrfKey, sessionTokenHash + r) + "." + r`, set in a non-HttpOnly `__Host-csrf` cookie, echoed by clients in an `X-Csrf-Token` header, verified with constant-time compare against the session-bound HMAC. Session-bound signing is what OWASP calls RECOMMENDED and closes the cookie-injection bypass that killed naive double-submit.
2. Defense in depth (same middleware, no client changes): reject unsafe methods when `Origin` mismatches the deployment origin or `Sec-Fetch-Site: cross-site`; treat missing headers per config (fail-closed default for sensitive endpoints, fail-open allowed for compatibility).
3. Synchronizer (server-stored per-session) tokens: support as an opt-in mode for server-rendered form apps, but don't make it the library default — double-submit composes with SPA/JSON clients and needs no server state.
4. Non-cookie strategies (bearer, API key, Basic) skip CSRF middleware entirely; document this loudly because it's also the reason bearer mode is a security posture change (Q61).
5. Ship the hardening as defaults, not docs: `__Host-`-prefixed cookie names, `Secure; HttpOnly; SameSite=Strict; Path=/`, no `Domain`, with a single documented escape hatch (`sameSite: "lax"` for OAuth-redirect flows that need top-level POST returns).

**Confidence:** high. OWASP + RFC 10017 agree on every load-bearing element; the signed-double-submit default is the one place where "RECOMMENDED" (OWASP) rather than "MUST" (RFC 10017 leaves mechanism open).

---

### Q88 (session-related parts) — Threat model: session abuse cases → controls → tests

**Evidence.** OWASP's session-threat taxonomy frames the surface: "disclosure, capture, prediction, brute force, or fixation of the session ID will lead to session hijacking" ([Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)); RFC 9700 provides the token-replay attacker model and mitigations ([RFC 9700](https://www.rfc-editor.org/rfc/rfc9700)); PRD's definition-of-done already demands "session security tests" and "token security tests" (PRD.md checklist).

| Abuse case | Control (default) | Test |
|---|---|---|
| **Session hijacking via storage/XSS** | `HttpOnly` + `Secure` + `__Host-` prefix (browser-enforced, MDN); never return the raw token in JSON; OWASP's hard "do not store tokens in localStorage" guidance | Cookie flags asserted on every issuing response; token absent from session API payloads |
| **Session prediction/brute force** | 32-byte CSPRNG secrets (256-bit ≫ OWASP's 64-bit floor), rate limiting hook (Q91 owner) | Entropy property test on generator; rejected-guess rate-limit test |
| **Session fixation** | Strict management — only accept server-issued token ids; new session minted at login and every privilege change; old row deleted | Presenting an attacker-chosen token fails; login rotates id+secret |
| **Token replay (verification/refresh-style tokens)** | Single-use with `consumedAt`; reuse of consumed token revokes family + emits `auth.token.replay` (RFC 9700 §4.14 pattern; Auth0 `ferrt` precedent) | Replayed reset token: rejected, family revoked, event emitted |
| **CSRF** | Q35 stack (SameSite=Strict + signed double-submit + Origin/Sec-Fetch-Site) | Cross-site POST without header → 403; with forged cookie only → 403; with session-bound HMAC → pass |
| **Timing attacks on token comparison** | Constant-time compare for every secret (Node `crypto.timingSafeEqual` — [docs](https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b); OWASP's pseudo-code mandates `constantTimeEquals` for CSRF HMACs) | Contract test that the compare helper is the only equality path for secrets (lint/semgrep, Q94 owner) |
| **Database leak of credentials** | SHA-256 hash at rest (Pilcrow: "even if your database is leaked, a malicious actor can't derive a valid session credential") | No column stores raw tokens; leak-simulation test can't authenticate |
| **Log/telemetry leakage** | Log token `id` only; salted-hash option for exported logs (OWASP); PRD §30 redaction | Log-snapshot test shows no secret material |
| **Long-lived stolen sessions** | Absolute ceiling + idle expiry enforced server-side (OWASP); password change revokes other sessions (better-auth's `revokeOtherSessions` pattern) | TestClock-driven expiry; password-change revokes other sessions but keeps current when configured |
| **Stale JWT claims after revocation** | JWTs short-lived + `sid` claim for optional live-check (Q60) | Revoked session's JWT rejected when verifier opts into live-check |
| **Impersonation abuse** | Q62's gate/reason/60-min/audit controls | Q62 test list |

**Recommendation.** Encode the table as an in-repo abuse-case suite (PRD checklist item), where every row's control is exercised by a deterministic TestClock/HTTP-level test; publish the table itself in SECURITY docs as the session/token slice of the threat model.

**Confidence:** high for the mapping; medium that the listed tests stay exhaustive as plugins add flows (plugins should extend the table — contract-test seam, Q31 owner).

---

## Technologies & libraries

| Name | What it is | License | Maturity | Relevance to effect-auth |
|---|---|---|---|---|
| `node:crypto` | CSPRNG (`randomBytes`, `getRandomValues`), `timingSafeEqual`, HMAC, Ed25519 keys | Node built-in (MIT-licensed runtime) | Stable (docs current to v26.x) | Token generation + constant-time compare on Node/Bun ([docs](https://nodejs.org/api/crypto.html)) |
| WebCrypto (`globalThis.crypto`) | `getRandomValues`, `randomUUID`, Ed25519 in modern engines | WHATWG standard | Stable | Edge/Workers token generation; no timing-safe compare primitive — needs audited JS fallback |
| `jose` | JOSE/JWS/JWT sign+verify, `createRemoteJWKSet`, explicit-alg verification | MIT | Very mature, ubiquitous in TS | JWT plugin engine (used in better-auth's own verification examples) |
| `@noble/ed25519`, `@noble/hashes` | Audited, dependency-free Ed25519 + SHA/HMAC primitives | MIT | Mature, widely audited | Edge signing path / SHA-256 for token hashing where `node:crypto` is unavailable |
| `@oslojs/crypto`, `@oslojs/encoding` | Pilcrow's (Lucia author) crypto + encoding utils | MIT | Stable | Reference implementations for the `id.secret` + SHA-256 pattern |
| Lucia | Session-management library; deprecated as a library, guidance lives in the author's book | MIT | Archived (docs superseded) | Source of the composite token design and active/idle model ([lucia-auth.com](https://github.com/lucia-auth/lucia)) |
| better-auth | TS auth framework; session + bearer + JWT + multi-session plugins | MIT | Active, fast-moving | Primary feature-parity benchmark; same-`getSession` strategy-chain precedent |
| WorkOS AuthKit | Hosted auth with documented impersonation/session APIs | Commercial | Active | Best public impersonation spec (Q62) |
| Clerk | Hosted auth; session lifetime UX, multi-session | Commercial | Active | Lifetime-knob UX reference (Q47) |
| Auth0 | IdP; refresh-token rotation with reuse detection; 2026 Session Delegation | Commercial | Active | Token-family rotation spec (Q46), impersonation convergence (Q62) |

## Books, papers, blogs, talks

- Sven Slootweg (joepie91), *Stop using JWT for sessions* (2016) + [part 2](http://cryto.net/~joepie91/blog/2016/06/19/stop-using-jwt-for-sessions-part-2-why-your-solution-doesnt-work/) — the load-bearing critique; still the clearest articulation of why stateless credentials can't be sessions. [Link](http://cryto.net/~joepie91/blog/2016/06/13/stop-using-jwt-for-sessions/)
- Duck Type Labs, *Review: Stop Using JWT for Sessions* — the best-natured counterpoint; clarifies that the flaws belong to statelessness generally and frames XSS-vs-CSRF storage tradeoffs. [Link](https://www.ducktypelabs.com/review-stop-using-jwt-for-sessions/)
- OWASP Cheat Sheet Series: [Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) and [CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) — the normative checklists this file's defaults compile to.
- RFC 9700, *Best Current Practice for OAuth 2.0 Security* (Jan 2025) — refresh-token rotation/reuse-detection requirements, sender-constraining, updated attacker model. [Link](https://www.rfc-editor.org/rfc/rfc9700)
- RFC 10017, *OAuth 2.0 for Browser-Based Applications* (Aug 2026, BCP 212) — BFF/token-mediating/browser-client architectures with per-pattern threat analysis; the cookie-hardening and CSRF MUSTs. [Link](https://www.rfc-editor.org/info/rfc10017)
- RFC 8725, *JWT Best Current Practices* — algorithm verification, cross-JWT confusion, explicit typing. [Link](https://www.rfc-editor.org/rfc/rfc8725)
- RFC 9449, *DPoP* — what sender-constraining actually buys, and its explicit XSS-proxying out-of-scope. [Link](https://www.rfc-editor.org/rfc/rfc9449)
- RFC 6238, *TOTP* — skew windows and one-time-use MUST. [Link](https://www.rfc-editor.org/rfc/rfc6238)
- Pilcrow, *auth.pilcrowonpaper.com* — Sessions & browser-storage chapters; the successor to Lucia's docs and the direct source for `id.secret` token design. [Link](https://auth.pilcrowonpaper.com/sessions)
- WorkOS, *How to let support agents act as a user without losing the audit trail* (Aug 2026) — impersonation as delegation: `sub`/`act`, four enterprise-review controls. [Link](https://workos.com/blog/support-impersonation-delegated-sessions)
- MDN, *Set-Cookie* — cookie prefixes (`__Host-`, new `__Http-`/`__Host-Http-`) and attribute semantics. [Link](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie)

## People & projects to follow

- **Sven Slootweg (joepie91)** — JWT-for-sessions critique; crypto-adjacent writing. [Blog](http://cryto.net/~joepie91/blog/), [GitHub](https://github.com/joepie91)
- **Pilcrow (pilcrowonpaper)** — Lucia author; auth book + Oslo libraries; the closest thing to a "sessions done right" school in TS. [Site](https://auth.pilcrowonpaper.com), [GitHub](https://github.com/pilcrowonpaper)
- **Philippe De Ryck (Pragmatic Web Security)** — RFC 10017 co-author; browser-app security/BFF pedagogy. [Site](https://www.pragmaticwebsecurity.com)
- **Aaron Parecki** — RFC 10017 co-author, OAuth 2.1 editor; token-lifetime/rotation guidance. [Site](https://aaronparecki.com)
- **Filip Skokan (panva)** — `oidc-provider`/`openid-client`/`jose` maintainer; where JOSE correctness lands first in Node. [GitHub](https://github.com/panva)
- **better-auth team (Bekacru et al.)** — the ecosystem we benchmark against; their plugin docs are a running changelog of session/security defaults. [GitHub](https://github.com/better-auth/better-auth)
- **Effect team (Michael Arnaldi, Tim Smart)** — `Clock`/`TestClock`, `Duration`, `Redacted` primitives this design leans on. [GitHub](https://github.com/Effect-TS/effect)

## Recommended defaults for effect-auth

1. **Token format**: opaque `id.secret`; secret = 32 CSPRNG bytes base64url; persist `SHA-256(secret)` with a unique index; all verification constant-time (`node:crypto.timingSafeEqual`; audited JS fallback on WebCrypto-only runtimes).
2. **Cookie**: `__Host-session`; `Secure; HttpOnly; SameSite=Strict; Path=/`; no `Domain`; `Max-Age` mirrors server expiry, capped at 400 days; escape hatch `sameSite: "lax"` for OAuth redirect UX only.
3. **Lifetimes**: absolute 30 d default (never extendable) + idle 7 d default (sliding, throttled like better-auth's `updateAge`); config must include at least one bound; enforcement 100% server-side via injected `Clock` (TestClock in tests).
4. **Rotation**: new session row at login, privilege change, password/email change; sliding refresh only updates expiry, never re-keys by default (periodic re-key = opt-in "renewal timeout," OWASP §Renewal).
5. **Revocation & concurrency**: server-side delete is authoritative; user-facing device list (`ipAddress`, `userAgent`, created/last-active) with revoke + revoke-others; `maxSessions` opt-in; any cookie-cached session data ≤5 min TTL and documented as revocation-lagging.
6. **Verification tokens**: one purpose-scoped table (`purpose` closed union, hashed token, optional audience, TTL defaults 24 h / 1 h / 7 d / 10 min), single-use via `consumedAt` consumed in-transaction; replaying a consumed token emits `auth.token.replay` and revokes any chained family.
7. **JWT plugin** (phase 2): EdDSA/Ed25519 default, HS256 opt-in with ≥32-byte secret; `kid` + JWKS endpoint with refresh-on-unknown-`kid`; verify with fixed alg allowlist, required `iss`/`aud`/`exp`, explicit `typ`, kind-specific validation rules; 15 min default TTL; `sid` claim links back to the revocable session.
8. **Strategy chain**: `cookieSession → bearer → apiKey`, first match wins, disjoint token shapes by construction, presented-but-invalid credential = typed error (no silent fallthrough), one resolution per request memoized in request scope.
9. **CSRF**: signed double-submit (HMAC bound to session-token hash, constant-time compare) + `Origin`/`Sec-Fetch-Site` rejection on unsafe methods; non-cookie strategies exempt; naive double-submit forbidden in code review and lint.
10. **Impersonation plugin**: off by default; admin permission gate; required reason; hard 60-min expiry, no refresh; dual principal (`user` + `act`); `session.create/revoke` audit events with both ids; `impersonated` flag in session payload for staff-bar UIs.
11. **Threat-model suite**: every row of the Q88 table ships as a deterministic test (TestClock for all expiry paths); suite is plugin-extensible.
12. **DPoP**: not in v1; revisit only when minting OAuth bearer tokens for third-party clients (phase 3, opt-in).

## Open questions for the user

1. **Default session lifetime posture** — PRD example is 30 days, but ecosystem defaults (better-auth, Clerk) are 7 days with sliding refresh:
   - (a) 30 d absolute + 7 d idle (PRD-aligned, consumer-friendly)
   - (b) 7 d absolute + 1 d idle refresh (ecosystem-aligned, safer)
   - (c) configurable with (a) as default and a "strict" preset matching (b)
2. **CSRF default mechanism** —
   - (a) signed double-submit + SameSite=Strict + Origin check (recommended; SPA-friendly, stateless)
   - (b) synchronizer tokens only (strongest for MPA/server-rendered, needs server state)
   - (c) SameSite-only by default with double-submit opt-in (simplest, weaker on shared eTLD+1)
3. **Bearer mode in v1** —
   - (a) session-token bearer built into core (better-auth parity, warned)
   - (b) deferred to the phase-2 JWT/bearer plugin (core stays cookie-only)
   - (c) cookie-only core + API-key plugin as the only non-cookie v1 surface
4. **JWT plugin timing** — PRD lists JWT in phase 2; confirm it should not ship in MVP even though JWKS endpoints are commonly expected by enterprise evaluators.
5. **Impersonation scope** —
   - (a) phase-2 official plugin with WorkOS-style 60-min fixed ceiling (recommended)
   - (b) phase-3, behind the enterprise plugins umbrella
   - (c) v1 core primitive (dual-principal session support) + plugin later
6. **Concurrent-session cap** — unlimited + user-visible device list (recommended), or a default hard cap (e.g., 10) with auto-eviction of oldest?

## Sources

- http://cryto.net/~joepie91/blog/2016/06/13/stop-using-jwt-for-sessions/
- http://cryto.net/~joepie91/blog/2016/06/19/stop-using-jwt-for-sessions-part-2-why-your-solution-doesnt-work/
- https://www.ducktypelabs.com/review-stop-using-jwt-for-sessions/
- https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- https://owasp.org/www-community/vulnerabilities/Insufficient_Session-ID_Length
- https://owasp.org/www-community/attacks/Session_fixation
- https://auth.pilcrowonpaper.com/sessions
- https://auth.pilcrowonpaper.com/
- https://v2.lucia-auth.com/basics/sessions/
- https://github.com/lucia-auth/lucia/discussions/1746
- https://better-auth.com/docs/concepts/session-management
- https://www.better-auth.com/docs/plugins/bearer
- https://www.better-auth.com/docs/plugins/jwt
- https://www.better-auth.com/docs/plugins/multi-session
- https://clerk.com/docs/guides/secure/session-options
- https://auth0.com/docs/manage-users/sessions
- https://auth0.com/docs/secure/tokens/refresh-tokens
- https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation
- https://www.rfc-editor.org/rfc/rfc9700 (OAuth 2.0 Security BCP, Jan 2025)
- https://www.rfc-editor.org/info/rfc10017 (OAuth 2.0 for Browser-Based Applications, Aug 2026)
- https://datatracker.ietf.org/doc/rfc10017/
- https://www.rfc-editor.org/rfc/rfc8725 (JWT BCP)
- https://www.rfc-editor.org/rfc/rfc9449 (DPoP)
- https://www.rfc-editor.org/rfc/rfc6238 (TOTP)
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie
- https://workos.com/docs/authkit/impersonation
- https://workos.com/blog/support-impersonation-delegated-sessions
- https://workos.com/blog/launch-week-spring-2024-day-5-impersonation
- https://workos.com/blog/march-updates
- https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b
- https://news.ycombinator.com/item?id=48558147
