# Cookies and CSRF

> Reads against `02-hooks-and-middleware.md` §5 (the origin/CSRF path
> middleware is one of the five extension mechanisms named there) and
> `00-methodology/03-theory-of-contracts-and-blame.md`. This document
> specifies cookie issuance/invalidation as contracts on the session
> entity's carrier, and CSRF protection as a precondition on every
> state-changing HTTP-surface request.

---

## 1. The cookie family and what each one is for

better-auth issues up to four distinct cookies per session, each with a
different contract. None of them is the session record itself — the
session record lives in the persistence layer (`01-core-domain`); every
cookie here is a **carrier** of a reference to it, or a **cache** of a
recent read of it.

```
┌────────────────────────────────────────────────────────────────────────┐
│                         THE COOKIE FAMILY                                │
│                                                                           │
│  session-token cookie                                                    │
│    Carries the opaque reference to the session record. This is the      │
│    ONLY cookie that is authoritative — every other cookie below is       │
│    disposable and is reconstructed or discarded without consequence.     │
│    Lifetime: session's configured lifetime, UNLESS the "don't remember   │
│    me" marker (below) is in effect, in which case it carries no          │
│    explicit lifetime (a session-only cookie in the browser sense).       │
│                                                                           │
│  session-data cookie (cache; optional feature)                           │
│    Carries a recent snapshot of the session + user, to avoid a           │
│    persistence-layer read on every request. Short-lived (minutes,        │
│    not days) independently of the session-token's own lifetime.          │
│    NEVER authoritative — always re-validated on read (§3), and a         │
│    deployment may re-derive it from the persistence layer at any time    │
│    without the cache being "wrong," only "absent."                       │
│                                                                           │
│  don't-remember-me marker                                                │
│    A small signed marker recording that this browser session asked to   │
│    NOT persist login across a browser restart. Consulted when deciding   │
│    the session-token cookie's lifetime, so it must itself be readable    │
│    even after the browser session restarts a fresh request cycle before  │
│    the caller repeats their preference.                                  │
│                                                                           │
│  account-data cookie (cache; optional feature)                           │
│    Carries a recent snapshot of a linked external account/credential,    │
│    analogous to the session-data cache but scoped to account-linking     │
│    data rather than the session itself. Bound to the current session's   │
│    user when the deployment opts into that binding (§4); if the bound    │
│    user and the account snapshot's owning user diverge, the cache is     │
│    discarded rather than served across identities.                       │
└────────────────────────────────────────────────────────────────────────┘
```

A fifth, transient carrier (a federation-flow state marker) exists only
for deployments that choose to carry OAuth/OIDC flow state in a cookie
rather than server-side storage; it is invalidated alongside the session
family on sign-out and is otherwise specified in `04-oauth-and-federation`.

---

## 2. Cookie issuance — the postcondition of a successful authentication

```
Operation:      issue a session to a successfully authenticated caller
Requires:       a session record already exists in the persistence layer
                (this operation is never the thing that creates it — it
                only publishes a reference to an already-created record)
Ensures:        the session-token cookie is set, scoped and attributed
                per §4; if the cookie-cache feature is enabled, the
                session-data cookie is also set, encoded per one of the
                three interchangeable strategies below; if the caller
                indicated a "don't remember me" preference, that
                preference's marker cookie is (re-)set and the
                session-token cookie's lifetime is shortened to a
                browser-session lifetime instead of the configured
                duration
Invariant:      a cookie set by this operation is internally consistent
                with the session record it names — no cookie is ever
                issued that could be replayed to authenticate as a
                DIFFERENT session or user than the one just established
On violation:   n/a for a normal call — this operation does not have a
                caller-facing precondition beyond "a session already
                exists"; a failure to persist the cookie once decided is
                an ADAPTER/transport-level fault, not a client fault
```

### 2.1 Cache encoding — three interchangeable strategies, one contract

The session-data cache cookie's payload is produced by exactly one of
three interchangeable encodings, selected by deployment configuration.
All three satisfy the same **domain→range arrow**:

```
cache-encode  :  (session snapshot, freshness window)  ->  opaque cookie value
cache-decode  :  opaque cookie value  ->  session snapshot  |  invalid
```

```
Contract:     session snapshot -> tamper-evident opaque value, and back
Requires:     the snapshot is a value already produced by a successful
              session resolution — this is never handed raw caller input
Ensures:      decoding a value this operation produced, before its
              freshness window elapses and with the encoding secret
              unchanged, recovers the same snapshot; decoding ANYTHING
              ELSE — a tampered value, an expired value, a value produced
              under a rotated secret, a value whose embedded format
              version does not match what this deployment currently
              expects — yields `invalid`, never a partially-trusted
              result and never a thrown error visible to the caller
Invariant:    `invalid` is treated identically to "cache absent": the
              caller falls through to re-resolving the session from the
              authoritative source, exactly as if no cache cookie had
              ever been set
On violation: there is no caller-facing violation here — a forged or
              stale cache value degrades gracefully to a cache miss
              Blamed party: n/a (this is a designed degrade-to-safe path,
              not an error condition); a decoder that instead trusted a
              tampered value would be a SUPPLIER defect of the highest
              severity, since it would let a forged cookie substitute for
              re-authentication
```

The three encodings (a compact signed form, a signed-token form, and an
encrypted-token form) differ only in wire format and in whether the
payload is merely tamper-evident (signed) or also confidential
(encrypted) — a deployment migrating between them is changing an
implementation detail, not this contract. A signed-token variant may
additionally be verified against a rotatable public-key set rather than a
single shared secret; this only changes *which* signer is trusted, not
the arrow's shape.

### 2.2 Cache size — chunking as a graceful-degradation contract

```
Operation:      write a cache cookie whose encoded value exceeds one
                cookie's practical size ceiling
Ensures:        the value is split across multiple numbered cookies
                sharing a common name prefix, each individually under
                the size ceiling, up to a bounded number of chunks
Invariant:      reading a chunked cache cookie back reassembles it in
                chunk order before decoding; a partial set of chunks
                (some expired independently, a proxy dropped one) is
                treated as `invalid` in the sense of §2.1, not as a
                corrupted-but-partially-usable value
On violation:   a value that would require MORE chunks than the bounded
                maximum is not written at all — the cache is skipped
                for this response, and the caller falls through to the
                authoritative source on the next read, exactly as if
                caching were disabled
                Blamed party: n/a — this is a deliberate size guard, not
                a violation; a deployment whose session/user snapshot is
                so large it routinely exceeds the bound should treat that
                as a signal to shrink what it caches, not as an error to
                handle per-request
```

```
┌───────────────────────────────────────────────────────────────┐
│           CACHE COOKIE SIZE DECISION (per write)                │
│                                                                   │
│   encoded value  ──▶  fits one cookie?  ── yes ──▶ single cookie │
│                              │ no                                 │
│                              ▼                                    │
│                     fits within the bounded chunk count?          │
│                         │ yes            │ no                     │
│                         ▼                ▼                        │
│                  N numbered chunks   skip the cache entirely for  │
│                  written, prior      this response (fall back to  │
│                  chunks expired      the authoritative source)    │
│                  first                                             │
└───────────────────────────────────────────────────────────────┘
```

---

## 3. Reading a session cookie — never trusted blindly

```
Operation:      resolve a caller's session from its cookie(s)
Requires:       (no precondition on the caller — this operation is
                defined for any incoming cookie header, including an
                absent or malformed one)
Ensures:        IF the session-token cookie is present and its signature
                verifies, a reference to a session record is obtained; IF
                the cache cookie is present and decodes successfully
                (§2.1) AND matches the session-token cookie's reference
                AND has not exceeded its own freshness window AND (when
                the deployment versions its cache payloads) matches the
                currently expected version, the cached snapshot MAY be
                used in place of a fresh read; in every other case, the
                caller falls through to an authoritative read
Invariant:      a cache snapshot is never served for a DIFFERENT session
                reference than the one the session-token cookie currently
                names — if the two disagree, the cache is discarded, not
                preferred
On violation:   an absent or unverifiable session-token cookie resolves
                to "no session," not to an error — this is the normal,
                expected shape of an anonymous request, and is exactly
                the CLIENT-blamed "unauthenticated" condition specified
                in 01-http-endpoint-contract.md §3 when a capability
                requires a session
```

A capability that must not be satisfied by a possibly-stale cache read
(a sensitive state change) uses the *authoritative* strength from
`01-http-endpoint-contract.md` §3, which discards any cache read and
re-resolves from the persistence layer even when a valid-looking cache
snapshot is present — the cache is a performance optimization for
*ordinary* reads, never a substitute for the source of truth when the
stakes are high enough to matter.

---

## 4. Cookie attributes as contract properties

Every cookie this system issues carries the following properties, stated
as guarantees about observable behavior rather than as flag names:

```
┌────────────────────────────────────────────────────────────────────────┐
│                    COOKIE ATTRIBUTE GUARANTEES                          │
│                                                                           │
│  not readable by page script            (script-inaccessible by         │
│                                           default, for every cookie      │
│                                           this system issues)            │
│                                                                           │
│  not sent cross-site by default          (a same-site-lax posture:      │
│                                           sent on top-level navigation   │
│                                           to this origin, not sent as    │
│                                           part of a background          │
│                                           cross-site request)             │
│                                                                           │
│  transport-restricted when the           (when the deployment is        │
│  deployment is reachable over             reachable only over an        │
│  a secure transport                       encrypted transport, cookies  │
│                                            additionally carry a          │
│                                            name-level marker recognized  │
│                                            by browsers as "only ever     │
│                                            sent over that transport,     │
│                                            and only ever accepted from   │
│                                            a response that was itself    │
│                                            delivered over it")           │
│                                                                           │
│  scoped to one host by default,          (a deployment may instead      │
│  OR shared across a subdomain family      opt every cookie in this      │
│  when explicitly configured               family into a shared scope    │
│                                            across a configured parent    │
│                                            domain — see §5)              │
└────────────────────────────────────────────────────────────────────────┘
```

```
On violation:   n/a — these are supplier-side guarantees with no
                caller-facing precondition; a deployment that overrides
                one of them (e.g. relaxes the cross-site posture to allow
                a legitimate cross-origin embedding scenario) has made an
                explicit, informed trade-off in its own configuration,
                not violated a contract — but doing so widens the CSRF
                attack surface this document's §6 otherwise narrows, and
                that widening is the deployer's own responsibility
```

---

## 5. Cross-subdomain cookie scope — a configurable contract variation

```
Operation:      enable cross-subdomain cookie scope
Requires:       the deployment names a base host to derive the shared
                scope from — either an explicit parent domain, or (when
                the deployment's own address is fixed rather than
                resolved per-request) the host portion of that fixed
                address; a deployment whose address is resolved fresh
                per-request AND has not named an explicit parent domain
                cannot satisfy this precondition and is rejected at
                configuration time, not per-request
Ensures:        every cookie in the family (§1) is scoped to the named
                parent domain instead of the single host that issued it,
                so a session established on one subdomain is presented
                automatically on every other subdomain under the same
                parent
Invariant:      cross-subdomain scope is all-or-nothing across the
                cookie family for one deployment — there is no
                configuration that shares only some of the family across
                subdomains while keeping others host-scoped
On violation:   a deployment that enables this without being able to
                name a parent domain fails fast at startup
                Blamed party: SUPPLIER — the deployer's own
                configuration, caught before any request is served
                rather than discovered per-request
```

---

## 6. CSRF protection — the precondition on state-changing requests

CSRF protection is enforced by the fixed path middleware named in
`02-hooks-and-middleware.md` §5, which therefore inherits that
middleware's scope: **HTTP-surface requests only** (see
`01-http-endpoint-contract.md` §1) — an in-process call from trusted
server code is never subject to it, because it was never a browser
acting on a cookie in the first place.

```
Operation:      accept a state-changing HTTP request (any method other
                than the safe, read-only ones)
Requires:       EITHER this request carries no session-authenticating
                cookie at all (in which case, see the graduated fallback
                below — the request may still need to prove non-hostile
                intent by other means), OR the request's declared origin
                (or a same-origin request-metadata signal, or — as a
                last resort — the referring page) names a trusted origin
                for this deployment
Ensures:        a request satisfying its applicable branch of the
                precondition proceeds to the next pipeline stage; every
                caller-supplied redirect-style target on the request
                (a post-login destination, an error destination, a
                post-signup destination) is independently checked against
                the same trusted-origin list before being honored, so a
                request cannot smuggle an open redirect through an
                otherwise-valid, same-origin call
Invariant:      the request's origin/CSRF posture is evaluated once, at
                the router boundary, before ANY endpoint-specific logic
                runs — no endpoint can be reached by a request that fails
                this precondition, regardless of what that endpoint
                itself would have required
On violation:   raised as forbidden (403-class), with a specific named
                condition depending on which check failed: an untrusted
                request origin; a missing/null origin on a request this
                deployment requires one from; an untrusted redirect-style
                target; or (see below) a detected cross-site navigation
                pattern
                Blamed party: CLIENT in the ordinary case — the request
                did not originate from, or did not declare itself as
                originating from, a trusted context
                Recoverable by: issuing the request from a trusted
                origin, or (for a redirect-style target) supplying one
                this deployment already trusts
```

### 6.1 The graduated fallback for requests without a session cookie

A request that carries no session-authenticating cookie at all cannot be
a cookie-riding CSRF attack in the classic sense (there is no ambient
credential for a hostile page to ride), so this deployment applies a
graduated, weaker check instead of the full origin check above:

```
┌──────────────────────────────────────────────────────────────────────┐
│         CSRF GRADUATED FALLBACK (no session cookie present)            │
│                                                                          │
│  does the request carry a session cookie?                              │
│      │ yes ──▶ apply the full origin check (§6, main clause)           │
│      │ no                                                               │
│      ▼                                                                  │
│  does the request carry browser fetch-context metadata                 │
│  (signals a browser attaches describing how a request was              │
│  initiated — same-origin navigation, cross-site navigation, etc.)?      │
│      │ yes                                                              │
│      │   ├─ metadata says "cross-site top-level navigation"            │
│      │   │      ──▶ BLOCK outright (this is the canonical CSRF-via-    │
│      │   │          bare-login-form-submission shape) — named          │
│      │   │          condition: cross-site navigation blocked           │
│      │   └─ any other metadata combination                             │
│      │          ──▶ apply the full origin check anyway (forced)        │
│      │ no metadata present                                              │
│      ▼                                                                  │
│  does the request carry an origin or referring-page header at all?     │
│      │ yes ──▶ apply the full origin check anyway (forced) — a         │
│      │         present origin/referrer is still trustworthy evidence   │
│      │         of where the request came from, even without metadata   │
│      │ no  ──▶ ALLOW — no session cookie, no fetch metadata, no        │
│      │         origin/referrer at all is the shape of a legitimate     │
│      │         non-browser caller (a server-to-server integration      │
│      │         call), not a browser CSRF attempt                       │
└──────────────────────────────────────────────────────────────────────┘
```

This graduated posture is a deliberate first-login exception: the very
first sign-in request of a session cannot yet carry the session cookie
the main clause keys its check on, so the fallback exists specifically to
still catch the cross-site-navigation attack shape (a hostile page
auto-submitting a login form) without blocking legitimate non-browser
callers that never send any of these signals at all.

### 6.2 Escape hatches — a configuration-time contract, not a per-request one

A deployment may configure specific paths, or its entire origin check, to
be skipped. This is a **deployer** decision made once, in configuration,
and applies identically to every request matching the configured scope —
it is not something any individual request can invoke.

```
On violation:   a deployment that disables the origin check for a path
                that actually needs it has widened its own attack surface
                Blamed party: SUPPLIER — the deployer, not any individual
                requester; per 00-methodology/03 §4 ("first cause, not
                first observer"), if this misconfiguration is later
                exploited by an attacker, the deployer's configuration
                choice is the first cause, even though the attacker is
                the immediate actor
```

A deployment may also declare origins as trusted through a function of
the incoming request rather than a fixed list, allowing per-tenant or
per-environment trust decisions:

```
trusted-origins-resolver  :  request  ->  additional trusted origin list
```

```
Contract:     request -> list of additional trusted origins
Applies at:   once per request that reaches the origin check, merged with
              this deployment's statically configured trusted origins
              before the check runs
On mismatch:  a resolver that names an origin this deployment did NOT
              actually intend to trust (a bug in the resolver's own
              logic) is a SUPPLIER defect — the request that is
              subsequently accepted because of that over-broad trust
              decision is not the requester's fault, even though the
              requester is the one whose request was, in effect,
              wrongly let through
              Blamed party: SUPPLIER — the deployer's own resolver
```

---

## 7. Cookie invalidation — sign-out and the "never leak a value you are also revoking" invariant

```
Operation:      sign a session out
Ensures:        every cookie in the family (§1) is expired on the
                response — instructed to be removed by the browser
                immediately — including every chunk of a chunked cache
                cookie (§2.2) and the federation flow-state cookie, if
                that carrier was in use for an in-flight federation flow
Invariant:      if THIS SAME response had, earlier in its own
                construction, already staged a valid value for one of
                these cookies (for example, a policy evaluated after an
                initial credential check decided to reject the sign-in
                after a session had provisionally been prepared), that
                earlier valid value is stripped from the response before
                the expiring instruction is added — a response must
                never simultaneously carry a still-usable cookie value
                and an instruction to discard it, because anything
                inspecting the raw response on the wire (rather than
                interpreting it the way a compliant browser would) could
                otherwise read and replay the still-usable value
On violation:   n/a for the caller — this is a pipeline-internal
                invariant with no caller-facing precondition
                Blamed party (if broken): SUPPLIER — a pipeline defect
                that let a revoked value remain observable on the wire is
                exactly the class of defect this invariant exists to rule
                out
```

```
┌──────────────────────────────────────────────────────────────────────┐
│     "REVOKE MUST WIN OVER AN EARLIER STAGE-VALUE" — CONCRETE CASE      │
│                                                                          │
│  credential sign-in         second-factor policy         final          │
│  (before-hook stage)        (after-hook stage)           response       │
│       │                            │                                    │
│       │ tentatively stages a       │                                    │
│       │ valid session cookie ─────▶│                                    │
│       │                            │ rejects the sign-in (factor        │
│       │                            │ not yet satisfied) and expires     │
│       │                            │ the SAME cookie name               │
│       │                            │        │                           │
│       │                            │        ▼                           │
│       │                            │  scrub the earlier valid value     │
│       │                            │  from the response FIRST, THEN     │
│       │                            │  append the expiring instruction   │
│       │                            │        │                           │
│       └────────────────────────────┴────────┴──────────────────────▶  final response carries
│                                                                        ONLY the expiring
│                                                                        instruction — the
│                                                                        valid value never
│                                                                        reaches the wire
└──────────────────────────────────────────────────────────────────────┘
```

This is the concrete reason header accumulation
(`02-hooks-and-middleware.md` §2.4) is specified as "last write wins
except cookies accumulate" *with* this invalidation invariant layered on
top for the specific case of the same cookie name being set and then
revoked within one response: accumulation alone would let both values
reach the wire; this invariant is the additional rule that prevents that
specific, security-relevant case.
