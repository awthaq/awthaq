# The HTTP Endpoint Contract

> Reads against `00-methodology/01-design-by-contract.md` (Hoare-triple
> vocabulary) and `00-methodology/03-theory-of-contracts-and-blame.md`
> (blame). This document is the base contract every endpoint — core or
> plugin-contributed — must satisfy. `02-hooks-and-middleware.md` specifies
> what wraps an endpoint; this document specifies the endpoint itself.

---

## 1. What an "endpoint" is, contractually

An endpoint is a named, independently invocable unit of behavior with:

* a declared set of **accepted inputs** (a body shape, a query shape, a set
  of required request headers) — its precondition surface;
* a declared **response shape** on success — its postcondition surface;
* an optional ordered chain of **sub-preconditions** it delegates to before
  its own body runs (session presence, resource ownership, freshness — see
  §3);
* a **reachability** classification: routable over HTTP, or reachable only
  from trusted in-process server code.

An endpoint is *not* a raw request handler. It is always discharged through
one of exactly two invocation surfaces, and both surfaces owe it the same
sub-contract:

```
┌───────────────────────────────────────────────────────────────────────┐
│                    TWO INVOCATION SURFACES, ONE ENDPOINT CONTRACT       │
│                                                                          │
│   Surface A — HTTP router                Surface B — in-process call    │
│   (an inbound HTTP request)              (trusted server code calling   │
│                                            the capability directly)     │
│        │                                        │                       │
│        ▼                                        ▼                       │
│   route match, rate limiter,             dynamic base-URL resolution,   │
│   origin/CSRF middleware,                pending schema check           │
│   onRequest plugin hooks    ◀── NOT shared with Surface B ──▶           │
│        │                                        │                       │
│        └───────────────────┬────────────────────┘                       │
│                             ▼                                           │
│              endpoint's own before/after hook pipeline                  │
│              endpoint's own precondition chain (session, etc.)          │
│              endpoint's own handler body                                │
│                             │                                           │
│        ┌────────────────────┴────────────────────┐                     │
│        ▼                                          ▼                     │
│   onResponse plugin hooks                  (no onResponse — the         │
│   (Surface A only)                          direct caller receives      │
│                                              the raw result/response)   │
└───────────────────────────────────────────────────────────────────────┘
```

**This split is itself a contract clause**, not an implementation detail:
rate limiting, origin/CSRF validation, and the request/response lifecycle
hooks (`onRequest`/`onResponse`, `02-hooks-and-middleware.md` §4) apply only
to requests that cross the HTTP boundary. A capability invoked in-process by
trusted server code is **not** re-validated against those protections —
the precondition for Surface B is instead "the calling code is itself
trusted," which is why some in-process-only endpoints exist at all (§5).
Every other stage — the before/after hook pipeline, the endpoint's own
declared precondition chain, schema validation — is shared by both
surfaces, because it protects invariants the *entity* (session, user,
account) depends on regardless of who is calling.

---

## 2. Request validation — the endpoint's own precondition

```
Operation:      invoke an endpoint with a candidate input
Requires:       the input's body/query conforms to the endpoint's declared
                shape; if the endpoint declares that it needs the raw
                request (to read headers/cookies), a request or headers
                value is supplied even for an in-process call
Ensures:        on success, the handler body observes a value that already
                satisfies the declared shape — it is never handed a
                partially-validated or coerced-but-unchecked input
Invariant:      a request that fails shape validation never reaches the
                endpoint's hook pipeline or handler body
On violation:   raised as a request-validation failure (400-class); some
                endpoint authors additionally reject a value that is
                shape-valid but semantically wrong for the operation with
                a domain-specific 400 (e.g. "email already in use" is a
                conflict, not a validation failure — see 05)
                Blamed party: CLIENT — the caller supplied the value
                Recoverable by: correcting the input's shape/type and
                resubmitting; no retry with the same input succeeds
```

A **shape** violation (missing field, wrong type, malformed body) is
distinguished in this tree from a **domain-rule** violation (an
otherwise-well-shaped value the operation refuses on business grounds,
e.g. a password that is well-typed but too short). Both are 400-class and
both are client-blamed, but only the first is a *precondition* failure in
Meyer's strict sense — the second is closer to a postcondition the
operation additionally guarantees ("I will refuse to create an account
with a re-used email"), documented per-capability in later trees (e.g.
`01-core-domain`, `05-mfa-and-verification`).

One category of shape failure is not client-blamed: an endpoint or plugin
that declares a value-checking rule requiring asynchronous work in a
position the validation layer only evaluates synchronously is a defect in
that endpoint's own declaration, not in the caller's input.

```
On violation of "a validator can be evaluated where it is declared":
   Blamed party:   SUPPLIER (the endpoint or plugin author)
   Recoverable by: the endpoint author moving the check into the handler
                   body, where asynchronous work is permitted
```

---

## 3. Session-requiring endpoints

An endpoint that needs an authenticated caller declares this by inserting
a **named precondition step** ahead of its handler body, rather than
re-implementing the check inline. Four such steps exist, each a
progressively stronger precondition over the same underlying fact (a
resolvable session):

```
┌────────────────────────────────────────────────────────────────────────┐
│              SESSION PRECONDITION STRENGTH (weakest → strongest)        │
│                                                                          │
│  optional-session   any-valid-session   fresh-session                   │
│  ───────────────    ─────────────────   ─────────────                  │
│  no session is        a resolvable       a resolvable session AND      │
│  required when        session is         it was established within    │
│  invoked in-process;  required           the configured "freshness"    │
│  required only when                      window (age since creation    │
│  a request/headers                       under a configured threshold; │
│  value accompanies                       a threshold of zero disables  │
│  the call                                the freshness check entirely) │
│                                                                          │
│                    authoritative-session                                │
│                    ──────────────────────                               │
│                    same as any-valid-session, but the session is        │
│                    re-read from the server-side source of truth even    │
│                    when a faster cached copy (§ cookie cache, see 03)   │
│                    would otherwise be trusted — used ahead of           │
│                    sensitive state changes (credential changes,         │
│                    account deletion) where a stale cached session       │
│                    must not authorize the action                       │
└────────────────────────────────────────────────────────────────────────┘
```

```
Operation:      resolve the caller's session (any strength above)
Requires:       a session token is presented in the way this deployment
                expects to receive one (cookie, bearer credential — see
                07-session-extensions), unless the "optional" strength is
                used from an in-process call with no request context
Ensures:        on success, a session and its owning user are attached to
                the call's context, readable without another lookup by
                the handler body and by every later hook in the pipeline
Invariant:      a session, once attached to a call's context, does not
                change identity mid-call — a later step that needs a
                guaranteed-fresh read (authoritative strength) re-resolves
                explicitly rather than trusting an attachment an earlier,
                weaker step made
On violation:   raised as unauthenticated (401-class) when no session
                resolves at all; raised as forbidden (403-class) when a
                session resolves but fails the freshness threshold
                Blamed party: CLIENT — the caller did not present a valid
                (or sufficiently fresh) credential
                Recoverable by: authenticating (or re-authenticating, for
                the freshness case) and retrying with the resulting
                session
```

This is a first-order instance of the higher-order pattern used throughout
`02-hooks-and-middleware.md`: the precondition step is itself an arrow —
`(call context) -> session-or-halt` — installed once per endpoint via its
declared precondition chain, checked lazily on every invocation rather
than once at registration.

---

## 4. Response shape — the postcondition, and how it varies by surface

```
Operation:      an endpoint completes normally
Ensures:        a value is produced that is one of:
                  (a) a JSON-serializable success body, or
                  (b) a fully-formed response (used by endpoints that must
                      control the wire format directly — e.g. redirects,
                      an HTML error page) — this form is returned as-is
                      and is NOT passed through the after-hook stage
                      (02-hooks-and-middleware.md §2.3)
                On the HTTP surface, (a) is serialized into a response
                with a 2xx status; on the in-process surface, the caller
                receives the value in the shape it asked for: bare data,
                or data paired with the accumulated response headers
                and/or numeric status, depending on what the caller
                requested when invoking the capability
Invariant:      whichever shape is produced, any headers accumulated
                during the call (cookies set or cleared, cache-control
                directives, a redirect location) are attached to it — a
                response is never returned stripped of headers the call
                legitimately accumulated, including when the call ends in
                a raised error (05-error-model-and-blame.md §"error shape")
On violation:   an endpoint handler that throws anything other than a
                recognized error value is treated as an internal failure
                (500-class) rather than surfaced as the thrown value's own
                shape — see 05
                Blamed party: SUPPLIER (the endpoint author) for an
                unrecognized throw; see 05 for the full taxonomy
```

---

## 5. Reachability: routable vs. in-process-only endpoints

An endpoint may declare itself reachable **only** from trusted in-process
server code — it takes no path at all, so nothing can route an HTTP
request to it, and it is left out of any published API description.

```
Operation:      declare an in-process-only endpoint
Requires:       the endpoint author asserts this deliberately, not by
                omission — declaring no path is layered with an explicit
                "never route this" marker, so a later change that
                accidentally adds a path does not silently expose it
Ensures:        the capability remains callable by trusted server code
                through the in-process surface (Surface B, §1) at all
                times, while never appearing on the HTTP surface
Invariant:      "in-process-only" is a property of the endpoint's
                declaration, independent of whether it happens to also
                carry a path — the explicit marker wins over path
                presence
On violation:   n/a — this is a declarative property, not something a
                caller can violate; a defect here (an in-process-only
                capability becoming reachable over HTTP) is a SUPPLIER
                defect in the routing layer itself, not a per-request
                contract violation
```

This exists for capabilities whose precondition is "the caller is trusted
server code," which no request-shape validation or session check can
establish on its own (e.g. directly setting a credential without the
normal challenge/response flow, on behalf of an already-authenticated
administrative operation).

---

## 6. Method semantics and idempotency

better-auth's endpoints do not carry a general idempotency guarantee by
default — this is a deliberate absence, documented here rather than left
implicit:

```
┌─────────────────────────────────────────────────────────────────────┐
│                      METHOD SEMANTICS OBSERVED                        │
│                                                                        │
│  read-only capability   →  GET (no side effect; safe to retry,        │
│                             cache, or prefetch — subject to the       │
│                             no-store rule in §7 when it carries        │
│                             credential material)                      │
│                                                                        │
│  state-changing         →  POST (sign-in, sign-up, sign-out, credential│
│  capability                 changes, session revocation, linking)     │
│                             NOT guaranteed idempotent: resubmitting an │
│                             identical create-style request is not      │
│                             promised to be a no-op — the operation's   │
│                             own postcondition (05, "conflict" category)│
│                             is what decides whether a duplicate        │
│                             attempt is rejected or silently repeated   │
│                                                                        │
│  dual-method capability →  a capability that reads session state may  │
│                             additionally accept a state-mutating       │
│                             method (session refresh as a side effect   │
│                             of reading) ONLY when the deployment has   │
│                             explicitly opted into that side effect;    │
│                             without that opt-in, the mutating method   │
│                             is refused outright (405-class) rather     │
│                             than silently treated as the safe method   │
└─────────────────────────────────────────────────────────────────────┘
```

```
Operation:      invoke a dual-method (read + optional-refresh) capability
                with the mutating method
Requires:       the deployment has explicitly configured this capability
                to allow deferring/performing a session refresh as a side
                effect of what is otherwise a read
Ensures:        when the precondition holds, the mutating call behaves
                exactly as the safe method would, plus the configured
                refresh side effect
On violation:   raised as method-not-allowed (405-class)
                Blamed party: CLIENT — the caller used a method the
                deployment has not opted into for this capability
                Recoverable by: using the safe method, or by the deployer
                enabling the refresh side effect in configuration (a
                configuration-time action, not a per-request retry)
```

---

## 7. The no-store contract for credential-bearing responses

```
Operation:      an endpoint's response body carries session, token, or
                other re-usable credential material
Requires:       (declarative — the endpoint author marks the response as
                credential-bearing, or sets the equivalent headers by
                hand for a response shape that bypasses the generic
                marker, e.g. one built as a fully-formed response per §4)
Ensures:        the response instructs every intermediary (proxy, CDN,
                shared browser cache) not to store the body — both a
                modern cache-control directive and a legacy-cache
                directive are set, so older intermediaries that only
                understand the legacy one are still covered
Invariant:      the no-store headers are applied uniformly to BOTH the
                success body and any error the handler raises while
                producing it — a credential-bearing endpoint that fails
                partway through must not leak a cacheable error response
                either
On violation:   a request rejected before the handler runs at all (shape
                validation, session precondition) is not itself
                credential-bearing and is not required to carry these
                headers — there is nothing to protect yet
                Blamed party: SUPPLIER — an endpoint author who marks a
                credential-bearing capability without the no-store
                property, or fails to set the equivalent headers by hand
                when constructing a response directly, has broken this
                document's postcondition, not the caller's
```

```
┌──────────────────────────────────────────────────────────────┐
│         NO-STORE HEADER APPLICATION (per response)             │
│                                                                  │
│   endpoint marked          ┌─────────────────────┐             │
│   credential-bearing? ────▶│ apply no-store        │──▶ success  │
│         │ yes              │ + legacy no-cache     │    body    │
│         │                  │ headers to whatever   │             │
│         │                  │ the handler produces  │──▶ raised   │
│         │                  └─────────────────────┘    error     │
│         │ no                                                    │
│         ▼                                                        │
│   headers untouched by this rule (an endpoint may still set      │
│   them by hand for a response shape the generic marker           │
│   cannot reach)                                                  │
└──────────────────────────────────────────────────────────────┘
```

The session-read capability (`02-request-pipeline` reads session state on
essentially every authenticated request) sets these headers by hand rather
than through the declarative marker, precisely because it also needs to
suppress them selectively on a narrower, related read path — a reminder
that the declarative marker is a *convenience* over the underlying
postcondition, not the postcondition itself. A reimplementation must
preserve the postcondition ("no intermediary stores a credential-bearing
response") regardless of which mechanism a given endpoint uses to satisfy
it.

---

## 8. Endpoint-path composition across plugins

Multiple plugins may contribute endpoints, and nothing prevents two
plugins from declaring the same path. This is a **composition-time**
concern, not a per-request one:

```
Operation:      assemble the full endpoint set from core + all plugins
Requires:       (no precondition on individual plugins — any plugin may
                declare any path)
Ensures:        every declared path/method combination is registered;
                when two or more plugins declare an overlapping
                path+method, the assembly still succeeds (later
                registrations take precedence in composition order), but
                the conflict is surfaced as a diagnostic naming the
                offending plugins and the overlapping methods
Invariant:      a path/method conflict is a static property of the
                configured plugin set — it does not depend on which
                requests actually arrive, and it does not change between
                requests once the deployment is assembled
On violation:   this is not a per-request contract violation and has no
                blamed party in the request sense — it is a deployment
                misconfiguration
                Blamed party: SUPPLIER — whoever assembled this
                combination of plugins
                Recoverable by: the deployer choosing non-overlapping
                plugins, reconfiguring one plugin's paths, or accepting
                the documented precedence order
```

This composition rule specializes `01-design-by-contract.md` §5 (a
plugin's contract may not narrow what the base system already promised):
a plugin that silently shadows another plugin's endpoint at the same path
has, in effect, narrowed the caller's ability to reach the shadowed
capability — the diagnostic exists so this narrowing is at least visible
rather than silent. See `03-plugin-system/01-plugin-contract.md` for the
general rule this instantiates.
