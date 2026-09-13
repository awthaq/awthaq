# Bearer-Carried Sessions and JWT Session-Representation

> Extends: `01-core-domain/02-session-lifecycle.md` (the base session
> contract).
> Read `00-methodology/01`, `02` (higher-order/arrow contracts), and `03`
> (blame theory) before this document — §4 of this document is a direct
> application of doc 01 §5 and doc 03 §4 to a case where a specialization
> is *permitted* to weaken a postcondition, provided it is documented.

This document covers two distinct extensions that are grouped together
because they answer the same underlying question — "how else may a session
be carried across the wire, besides a cookie?" — with two very different
answers: bearer tokens are an **equivalence** contract (same guarantees, new
carrier), while JWTs are a **representation** contract with a **known,
documented weakening** relative to the base contract's revocation
postcondition.

---

## Part A — Bearer-carried sessions

### A.1 What is being extended

The base session contract is silent on *how* the session credential
travels — in its reference form it travels as a cookie. The bearer
extension adds a second carrier — an `Authorization: Bearer <token>` header
— and its entire purpose is to make that second carrier **behaviorally
indistinguishable**, to every downstream consumer of the session, from the
cookie carrier.

```
Operation:     bearer-to-cookie translation (before-hook, matches any
               request whose Authorization header is present)
Requires:      an `Authorization` header matching the `Bearer ` scheme,
               case-insensitively, with optional surrounding whitespace
               (RFC 7235 §2.1: the auth-scheme token is case-insensitive).
Ensures:       IF the token, once normalized, verifies as a genuine
                 signed-cookie value for THIS server's secret:
                   the request's cookie header is rewritten (a new Headers
                   object; the original request is not mutated) to ALSO
                   carry the primary session-token cookie, with this
                   token as its value — and the base session pipeline
                   (session middleware, findSession, expiry check) runs
                   UNCHANGED, on THIS derived cookie, exactly as it would
                   for a native cookie-carried request.
               IF the header is present but does not match the Bearer
                 scheme, is empty after the scheme, or fails signature
                 verification:
                   the hook is a no-op — it neither rejects the request
                   nor raises an error. The request proceeds exactly as if
                   no Authorization header had been sent; a valid session
                   cookie already present on the SAME request still
                   authenticates normally.
Invariant:     bearer never implements a second, parallel validity check.
               It is strictly a translation step that runs BEFORE the base
               pipeline and produces an artifact (a synthesized cookie
               header) the base pipeline consumes through its one, unique
               validation path. There is no code path by which a
               bearer-carried credential is considered valid without also
               having passed through the exact same `findSession` /
               expiry / revocation check a cookie-carried credential
               passes through.
On violation:  an invalid/unverifiable bearer token never itself produces an
               error response — it degrades to "as if absent." Any
               resulting UNAUTHORIZED comes from the BASE pipeline finding
               no valid session at all (no cookie, no usable bearer token),
               and is blamed exactly as an ordinary missing-credential
               request would be: CLIENT, recoverable by presenting a valid
               credential via either carrier.
```

```
SEQUENCE: bearer-carried request
──────────────────────────────────────────────────────────────────
  client                 bearer before-hook           base session pipeline
    │  GET /get-session                                     │
    │  Authorization: Bearer <token>                         │
    ├──────────────▶│                                        │
    │                 │ scheme check, trim, HMAC-verify        │
    │                 │ signature against server secret        │
    │           ┌─────┴─────┐                                 │
    │        invalid?    valid?                                │
    │           │            │                                  │
    │      no-op, pass   synthesize cookie header carrying       │
    │      request        the recovered token under the SAME    │
    │      through        cookie NAME the base pipeline expects  │
    │      unmodified          │                                  │
    │           └──────┬───────┘                                  │
    │                    ▼                                        │
    │                                 base pipeline: findSession, │
    │                                 expiry/revocation check —   │
    │                                 IDENTICAL to a native cookie│
    │                                 request from this point on  │
    │◀── same response shape as a cookie-carried call ────────────┘
```

### A.2 Token-format normalization — what "verification" actually gates

Two accepted input shapes exist for the bearer token, and they are **not**
equally security-relevant:

```
Operation:     token normalization (inside A.1)
Requires:      the raw token string extracted from the header.
Ensures:       IF the token contains a `.` (already in "value.signature"
                 form, i.e. the same shape a signed session cookie takes):
                   it is decoded (URL-decoded if it appears encoded) and
                   its embedded signature is checked against the server
                   secret over its value segment — a GENUINE cryptographic
                   gate: a tampered or foreign-signed token fails here.
               IF the token contains no `.` (a "bare" token):
                   IF `requireSignature` is configured true:
                     rejected outright (no-op — see A.1) — bare tokens are
                     not an accepted format under this configuration.
                   ELSE (default):
                     the plugin computes, itself, what a signed-cookie
                     value for this bare token WOULD be (using the same
                     HMAC construction the base contract uses when it
                     first issues a session cookie) and proceeds as if the
                     caller had presented that reconstructed value.
Invariant:     for a BARE token, this step is a FORMAT NORMALIZATION, not a
               security check — the plugin is deterministically re-deriving
               the canonical signed form of whatever string it was handed,
               which will always "verify" against a signature the plugin
               itself just computed. The actual security-relevant gate for
               a bare token is downstream: the base pipeline's
               `findSession` lookup, which only succeeds if the bare
               string is itself a real, live session token. `requireSignature:
               true` exists precisely to CLOSE this normalization path for
               deployments that want to require callers to already possess
               the full signed-cookie-shaped value (e.g. because they copy
               it verbatim from a `set-auth-token` response header, see
               A.3) rather than accepting a bare token at face value.
On violation:  a bare token that does not correspond to any live session
               fails at the base pipeline's lookup, exactly like a cookie
               carrying a made-up value would — blame CLIENT.
```

### A.3 Mirroring the session token back to a bearer client (`set-auth-token`)

```
Operation:     set-auth-token exposure (after-hook, every request)
Requires:      the response the base pipeline just produced carries a
               Set-Cookie for the primary session-token cookie.
Ensures:       IF that Set-Cookie represents an ACTIVE token (its Max-Age
                 is not 0 — i.e. this is not a clearing/sign-out response):
                   the same token value is additionally exposed via a
                   `set-auth-token` response header, and that header name
                   is added to `Access-Control-Expose-Headers` so a
                   cross-origin bearer-style client can actually read it.
               IF the Set-Cookie is a CLEARING cookie (Max-Age 0, e.g.
                 sign-out):
                   `set-auth-token` is NOT set — a bearer client must never
                   be handed what looks like a live token value for a
                   session that was just invalidated.
Invariant:     a bearer-only client (one that never honors Set-Cookie, e.g.
               a native mobile app or a server-to-server caller) has no
               OTHER way to learn that its session token was rotated by a
               rolling-refresh inside the base contract, except by reading
               this header on every response and persisting the latest
               value. The base contract's rolling-refresh postcondition
               ("a session may be transparently re-issued a fresh token
               before expiry") is therefore only observable to a bearer
               client if the client itself upholds this obligation.
On violation:  a bearer client that discards `set-auth-token` and keeps
               presenting an old, rotated-away token will eventually see
               its (superseded) token stop resolving to a live session.
               Blamed party: CLIENT — the equivalence contract in §A.1
               guarantees a bearer-carried session is checked exactly as a
               cookie-carried one, but a browser's cookie jar updates
               itself automatically on Set-Cookie, and an explicit bearer
               client MUST replicate that behavior itself; failing to do so
               is a client-side integration defect, not a break of the
               equivalence contract.
```

### A.4 The equivalence contract, summarized

```
              cookie-carried session          bearer-carried session
   carrier:   Set-Cookie / Cookie header       Authorization: Bearer <token>
   validity:  base findSession + expiry        SAME base findSession + expiry
              check, invoked once               check, invoked once, on a
                                                 TRANSLATED cookie header
   rotation:  automatic (browser honors          requires the CLIENT to read
              Set-Cookie)                        `set-auth-token` and resend it
   revocation: next lookup of deleted token      IDENTICAL — bearer never
              fails immediately                  bypasses the live lookup
```

No core session invariant (identity binding, expiry, revocation-effective-
immediately) is weaker for a bearer-carried session than for a
cookie-carried one — the only genuine difference is an OPERATIONAL one
(who is responsible for persisting a rotated token), not a validity one, and
it is placed squarely on the CLIENT by design.

---

## Part B — JWT session representation

### B.1 What is being added

The JWT extension issues a **self-contained, cryptographically-signed
representation** of an already-established session (RFC 7519), exposed
through three surfaces:

* an on-demand `GET /token` endpoint (requires an already-valid session —
  `sessionMiddleware` — and mints a fresh JWT from it);
* an automatic `set-auth-jwt` response header mirrored onto every
  successful `/get-session` response (opt-out via
  `disableSettingJwtHeader`) — the same "translate the validated session
  into another representation, without re-validating" pattern used by
  bearer's `set-auth-token` (Part A.3) and by custom-session's `fn` (see
  `02-custom-session.md`);
* an optional `sessionCookieCache` mode where the plugin's own JWT
  machinery IS the cookie-cache signer for the base contract's rolling
  session cache (see B.6) — a narrower, time-bounded use of the same
  primitive.

None of these surfaces replace the base session record. A JWT minted here
is always a DERIVED artifact of a session that, at mint time, satisfied the
base contract.

### B.2 Claims contract

```
Operation:     JWT issuance (signJWT / getJwtToken)
Requires:      a payload (developer-suppliable via `jwt.definePayload`,
               default: the session's user record).
Ensures:       the signed token's registered claims (RFC 7519 §4.1) are
               populated as follows, in this precedence — an explicit value
               in the supplied payload wins, else a plugin-computed default:
                 iat  — now, unless the payload supplied one
                 exp  — payload's `exp`, else `iat + expirationTime`
                        (default 15 minutes)
                 iss  — `jwt.issuer`, else the server's own baseURL origin
                 aud  — `jwt.audience`, else the server's own baseURL origin
                 sub  — `jwt.getSubject(session)`, else the session's
                        user id (`getJwtToken` path only — the low-level
                        `signJWT` primitive does not impose a default sub)
               `nbf`/`jti` are carried through only if explicitly supplied.
Invariant:     the ISSUANCE side places no artificial floor under
               `expirationTime` — an operator may configure arbitrarily
               long-lived tokens. Doing so is exactly the configuration
               knob that widens the exposure window of the tension
               documented in §B.5; this is discussed there, not here.
On violation:  a `jwt.sign` remote-signing callback that is misconfigured
               to run without a corresponding `jwks.remoteUrl` fails at
               PLUGIN-CONSTRUCTION time (not per-request), raising a
               configuration error attributable to the deployer (SUPPLIER
               in the sense of "the party assembling this auth
               instance," not the end caller) — see B.3.
```

```
Operation:     JWT verification (verifyJWT)
Requires:      a token with exactly three dot-separated segments, whose
               protected header carries a `kid`.
Ensures:       returns `null` (never throws to the caller) if ANY of:
                 the format precondition fails; no `kid`; no JWKS key
                 matching that `kid` is currently known; the cryptographic
                 signature does not verify under that key and its
                 algorithm; `iss`/`aud` do not match the configured
                 (or overridden, e.g. per-issuer `verifyJWT` endpoint
                 call) expected values; the token's `exp` has passed;
                 OR the payload lacks `sub` or `aud` after all other
                 checks pass.
               Otherwise returns the payload, with `sub` and `aud`
               statically guaranteed present.
Invariant:     verification is PURELY a function of the token's own bytes
               plus the currently-known JWKS key set and configured
               issuer/audience — it never consults the session store. This
               is the load-bearing fact for §B.5.
On violation:  n/a for the caller — every failure mode above collapses to
               the SAME `null`, deliberately, so that a caller cannot
               distinguish "expired" from "revoked-key" from "malformed"
               from raw response shape alone (avoids leaking which
               specific check failed).
```

### B.3 Signing-key and JWKS contracts

```
Operation:     key resolution for signing (resolveSigningKey)
Requires:      (default path, no per-call override) — nothing beyond the
               plugin being configured with local (non-remote) signing.
Ensures:       the most recently created, still-live key matching the
               PRIMARY configured algorithm is used; if none exists yet,
               a key is lazily minted on first use. This default-path
               selection is pinned to the primary algorithm specifically
               so that provisioning ADDITIONAL algorithms for other
               purposes (see below) can never silently change which key
               unpinned tokens are signed with.
Invariant:     an explicit `signingKeyId` override REQUIRES that exact key
               to already be provisioned — it is never auto-minted on miss
               (an admin-named key that does not exist is a configuration
               error, not a signal to fabricate one). An explicit
               `signingAlgorithm` override without a `signingKeyId` mints a
               key on demand ONLY if that algorithm is either the primary
               `keyPairConfig.alg` or explicitly listed in
               `keyPairConfigs`; otherwise it throws, naming the
               algorithms that ARE provisioned, so the misconfiguration is
               diagnosable rather than silent.
On violation:  `signingKeyId` naming a non-existent key → configuration
               error, blame SUPPLIER (deployer/integrator who supplied a
               bad kid, typically an OAuth-provider-plugin caller pinning a
               per-resource key). `signingAlgorithm` naming an
               unprovisioned, non-default algorithm → configuration error
               naming the gap, same blame.
               DOCUMENTED WEAKENING: the lazy-mint path for an
               algorithm-only override performs a read-then-create with NO
               transactional/locking guarantee at the adapter level. Two
               concurrent requests that are first to pin the same
               not-yet-provisioned algorithm can each observe "no key" and
               each mint one, producing two live keys for that algorithm.
               Both remain independently valid for verification afterward
               (verification is per-`kid`, not per-algorithm), so this
               never causes a spurious verification failure — but it
               weakens "exactly one signing key per algorithm" down to "at
               least one." This is a SUPPLIER-documented tradeoff (per
               methodology doc 01 §5): tightening it would require a
               transactional mint primitive the base adapter contract does
               not currently offer.
```

```
Operation:     JWKS exposure (GET /jwks or configured jwksPath)
Requires:      `jwks.remoteUrl` is NOT configured (when it is, this
               endpoint is disabled and answers NOT_FOUND — exposure is
               understood to be delegated elsewhere, e.g. a CDN-hosted,
               externally-signed key set).
               The configured `jwksPath` itself is validated once, at
               plugin construction (not per-request): it must be a
               non-empty string starting with `/` and must not contain
               `..` — violated at construction, this throws immediately
               rather than becoming a request-time surprise.
Ensures:       returns every key not YET past its grace period — a key
               past its hard rotation `expiresAt` is retained in the
               exposed set for `gracePeriod` seconds afterward (default 30
               days) specifically so that a token signed just before
               rotation does not immediately become unverifiable the
               moment the key rotates.
Invariant:     JWKS exposure NEVER includes private key material (only the
               public half is ever serialized to this endpoint).
On violation:  a malformed `jwksPath` is a construction-time
               (deploy-time) BetterAuthError — blame SUPPLIER (the
               integrator who configured it), never a request-time client
               fault.
```

```
TIMELINE: key rotation and the grace period
──────────────────────────────────────────────────────────────────────
  t0                    t0+rotationInterval              t0+rotationInterval
  key minted,           key's `expiresAt` reached;        +gracePeriod
  live for signing      NO LONGER used to sign NEW        key finally
  and verification      tokens, but STILL exposed in       excluded from
       │                JWKS and STILL verifies             JWKS/verification
       │                tokens signed before this point           │
       ▼                        │                                  ▼
  ████████████████████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░
  signs + verifies         verifies only (grace)         neither — a token
                                                          still bearing this
                                                          key's kid now
                                                          fails verification
                                                          (returns null)
```

`session.cookieCache.maxAge` (when `sessionCookieCache: true`, see B.6)
**must** be shorter than `gracePeriod`, or a cache cookie can outlive the
grace window and start failing verification before its own stated
lifetime elapses — the plugin logs a warning at construction time when this
relationship is violated, but does not refuse to start (a documented,
non-fatal misconfiguration hazard, blame SUPPLIER for not correcting it
once warned).

### B.4 `signJWT` / `verifyJWT` as general-purpose primitives

The plugin also exposes `signJWT` and `verifyJWT` as server-only endpoints
operating on an ARBITRARY caller-supplied payload — these carry no session
semantics of their own; they reuse exactly the claims (§B.2) and key (§B.3)
contracts, but the "subject" of the token is whatever the caller puts in
the payload, not necessarily a session's user. Any code (e.g. the OAuth
provider extension, out of scope here) building tokens for a DIFFERENT
purpose on top of this plugin inherits the same signing-key and grace-period
contracts described above, unchanged.

### B.5 THE KNOWN TENSION — JWT revocation is weaker than the base contract's

This is the single most important contract note in this document.

**The base session contract's revocation postcondition** (established
elsewhere in this tree, and honored by every other carrier discussed so
far — cookie in the base contract itself, and bearer in Part A): once a
session is revoked (deleted, signed out, expired), the VERY NEXT
presentation of its credential, by any carrier, is rejected. This holds
because validity is always determined by a live lookup against the session
store.

**A JWT issued by this plugin is stateless by construction** (§B.2/§B.3):
`verifyJWT` never performs a session-store lookup. It is a pure function of
the token's bytes and the currently-known JWKS/issuer/audience
configuration. Therefore:

```
Operation:     JWT-carried authorization, post-revocation
Requires:      a JWT was minted (via /token, or via set-auth-jwt on a
               /get-session response) while its underlying session was
               still valid.
Ensures:       IF the underlying session is later revoked (sign-out,
                 explicit deletion, admin action) BEFORE the JWT's `exp`:
                   the JWT CONTINUES to pass `verifyJWT` — it remains
                   usable as proof of "this subject was authenticated as
                   of `iat`" for anyone who checks only the signature and
                   registered claims — until `exp` is reached naturally.
Invariant:     this is a STRICTLY WEAKER revocation postcondition than the
               base session contract's. It is not a bug: it is the
               unavoidable consequence of choosing a stateless,
               self-verifying token FORMAT as a session representation.
               Bounding the exposure window is exactly what
               `jwt.expirationTime` (default 15 minutes) is for.
On violation:  per methodology doc 01 §5 and doc 03 §4, a specialization
               that weakens a postcondition the general contract promised
               is only legitimate if it is DOCUMENTED rather than silently
               shipped as if it were an equivalent representation (contrast
               with bearer, Part A, which achieves TRUE equivalence and
               required no such note). Blame framing:
                 - SUPPLIER (better-auth / this plugin) is responsible for
                   documenting this weakening prominently — which this
                   section discharges — and for providing a mitigating
                   knob (short `expirationTime`; the `sessionCookieCache`
                   mode in B.6, which re-anchors to the live session on a
                   short cycle). Failing to document this would itself be
                   the contract violation, attributable to SUPPLIER,
                   independent of any specific deployer's outcome.
                 - CLIENT (the deploying application) is responsible, ONCE
                   this tension is documented, for choosing an
                   `expirationTime` and an authorization architecture (e.g.
                   never relying on a bare JWT alone for a
                   high-privilege, revocation-sensitive decision without
                   an additional live check) appropriate to their own
                   risk tolerance. A deployer who issues long-lived JWTs
                   without such mitigation and is later bitten by a
                   "revoked but still-verifies" token owns that outcome.
```

```
TIMELINE: the tension, contrasted with a cookie/bearer session
──────────────────────────────────────────────────────────────────────
  t0: session valid, JWT minted (exp = t0 + 15m)
  t1: session REVOKED (sign-out)                    t1 < t2 < exp
  t2: same credential presented again

  cookie/bearer path:
    t2 → base findSession(token) → NOT FOUND (deleted at t1) → REJECTED
         (base contract's revocation postcondition: upheld)

  JWT path:
    t2 → verifyJWT(token) → signature valid, iss/aud valid, exp not yet
         reached → payload RETURNED, i.e. "authenticated" — the session
         store is never consulted, so t1's revocation is invisible here
         (base contract's revocation postcondition: DOES NOT HOLD for
          this carrier — a documented, deliberate weakening, not a defect)
```

### B.6 `sessionCookieCache` — the mitigation, and its own residual tension

```
Operation:     JWT as the base contract's cookie-cache signer
Requires:      `session.cookieCache.strategy === "jwt"` on the base
               session configuration AND local (non-remote) JWT signing
               (incompatible with a `jwt.sign` remote signer — enforced at
               plugin init, throws otherwise).
Ensures:       the base contract's OWN rolling session-cache mechanism
               (elsewhere specified) uses this plugin's local JWKS keys to
               sign/verify its short-lived cache payload, instead of
               whatever default cache-signing mechanism the base contract
               otherwise uses. The cache payload's own claims (`sid` bound
               to the real session token, fixed issuer/audience/typ
               distinct from a general-purpose JWT) are checked strictly —
               a cache token with the wrong `typ` or `aud` is rejected
               outright, never silently accepted as a general JWT.
Invariant:     this narrows, but does not eliminate, §B.5's tension: the
               cache token is still verified WITHOUT a live session lookup
               for its own lifetime (bounded by
               `session.cookieCache.maxAge`, typically minutes, versus a
               general-purpose JWT's `expirationTime`), and the base
               contract re-validates against the live session store once
               the cache token itself expires. The residual exposure
               window after a revocation is therefore bounded by
               `cookieCache.maxAge`, not by `jwt.expirationTime` — smaller
               by design, but still nonzero, and still subject to the same
               documentation obligation as §B.5.
On violation:  a cache-mode JWT failing to verify (expired, wrong typ, key
               rotated past grace) causes the base contract to fall back to
               a live session-store lookup — i.e. failure of THIS
               representation degrades to the base contract's stronger
               guarantee, never the other way around. This asymmetry (fail
               open to the SAFER path, never to the WEAKER one) is the
               correctness property that makes cookie-cache mode an
               acceptable mitigation rather than a second, independent
               tension.
```

## 7. Liskov compliance check

```
Bearer (Part A):
  REQUIRE  P' = P  (same credential validity notion; new carrier, not a
                     new/relaxed requirement)
  ENSURE   Q' = Q  (identical validity/expiry/revocation guarantees;
                     the only difference — token-refresh propagation — is
                     an operational CLIENT obligation, not a weaker
                     postcondition)
  → full equivalence; no documented weakening required.

JWT (Part B):
  REQUIRE  P' = P  (issuance requires nothing beyond an already-valid
                     session; verification's format/claim requirements are
                     ADDITIONAL structure this representation imposes on
                     itself, not a narrowing of what the base contract
                     accepts as a session credential elsewhere)
  ENSURE   Q'  ⊊  Q  for the revocation clause specifically:
                     Q  = "revoked ⟹ next presentation, any carrier,
                           rejected immediately"
                     Q' = "revoked ⟹ next presentation rejected immediately,
                           UNLESS the credential is a not-yet-expired JWT,
                           in which case it remains accepted until exp"
  → this is a genuine postcondition WEAKENING relative to the base
    contract, licensed only because it is explicitly documented here (per
    doc 01 §5 / doc 03 §4) rather than presented as an unqualified
    equivalent representation. Every other postcondition of the base
    contract (identity binding, signature/tamper integrity, issuer/audience
    scoping) is preserved or strengthened by this representation.
```
