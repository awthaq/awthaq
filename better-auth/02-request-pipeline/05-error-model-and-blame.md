# The Error Model as a Blame Taxonomy

> This document is the direct operationalization of
> `00-methodology/03-theory-of-contracts-and-blame.md` for better-auth: it
> enumerates every category of error this system raises, states which
> party is blamed for each per that document's model, and states what the
> blamed party must do differently before a retry can succeed. Read that
> document first — this one adds no new vocabulary, only instances.

---

## 1. The shape every raised error has, and what survives it

Before the taxonomy: every error this system raises across the request
pipeline shares one shape and one guarantee, independent of which
category it falls into.

```
Operation:      any operation in the pipeline raises an error
Ensures:        the error carries (a) a status category (one of the
                HTTP-status-class families named throughout this
                document), (b) a short machine-readable named condition
                distinguishing it from siblings in the same status
                category (e.g. distinguishing "session expired" from
                "no session presented" within the unauthenticated
                family), (c) a human-readable message, and (d) any
                response headers the pipeline had already legitimately
                accumulated before the error was raised
Invariant:      (d) holds regardless of which category the error falls
                into — a session-cookie deletion a hook had already
                decided to perform before a LATER stage failed is not
                undone by that later failure; the error surfaces WITH
                that deletion still attached, per the invalidation
                invariant in 03-cookies-and-csrf.md §7
On violation:   an operation that raises something that is NOT in this
                shape (an unrecognized thrown value) is not treated as a
                domain error at all — see §8 (internal/unexpected)
```

One named condition is explicitly **not** a violation despite reusing the
same mechanism as every error in this taxonomy: a controlled redirect (a
federation flow handing control to an external provider, a completed flow
returning the caller to a configured destination) is signaled through the
same channel as an error but is exempted from every failure-handling
concern in this document (logging, blame, retry guidance) — it is normal
control flow wearing an error-shaped mechanism for engineering
convenience, not a contract violation. A reimplementation is free to give
successful redirects their own channel instead of reusing the error
channel; nothing in this taxonomy depends on the two being the same
mechanism.

---

## 2. The taxonomy

Each entry follows: what triggers it · the blamed party · what changes
before a retry can succeed.

### 2.1 Validation / bad request (400-class)

```
Operation:      an endpoint receives a request whose body/query does not
                conform to its declared shape, or conforms in shape but
                violates an explicitly-stated field-level rule (a
                required field is absent where a caller-supplied value
                was mandatory, a value's type does not match, a value is
                present that this operation explicitly does not accept,
                a request body is not itself an object)
On violation:   Blamed party: CLIENT
                Recoverable by: correcting the request to conform to the
                declared shape and rule set, then resubmitting — the
                SAME malformed input will never succeed on retry
```

One member of this family is blamed the other way, because its cause
lives entirely on the far side of the boundary from the request itself:

```
Operation:      a declared field-level rule requires asynchronous
                evaluation in a position this system only evaluates
                synchronously
On violation:   Blamed party: SUPPLIER (the endpoint or plugin author who
                declared the rule in a position that cannot support it)
                Recoverable by: the endpoint/plugin author relocating the
                check into a position that supports asynchronous
                evaluation — no request-level retry changes anything,
                because the request was never the problem
```

### 2.2 Unauthenticated (401-class)

```
Operation:      a capability that requires a resolvable session
                (01-http-endpoint-contract.md §3) is invoked without one,
                or with one whose underlying record has expired
On violation:   Blamed party: CLIENT — no valid credential was presented
                Recoverable by: authenticating (or re-authenticating, if
                the prior session expired) and retrying with the
                resulting session attached
```

### 2.3 Unauthorized / forbidden (403-class)

This family is the widest, because "forbidden" covers several distinct
underlying preconditions:

```
┌────────────────────────────────────────────────────────────────────────┐
│              FORBIDDEN — FOUR DISTINCT PRECONDITIONS, ONE STATUS         │
│                                                                           │
│  (a) resource ownership / role                                          │
│      a resolvable session exists, but the session's owner does not      │
│      hold the specific ownership or role relationship the capability    │
│      requires over the target resource                                  │
│         Blamed party: CLIENT — retry as a caller who actually holds     │
│         the required relationship, or acquire it first                  │
│                                                                           │
│  (b) session freshness                                                   │
│      a resolvable session exists but was established too long ago for   │
│      this specific, sensitive capability's freshness requirement         │
│      (01-http-endpoint-contract.md §3)                                  │
│         Blamed party: CLIENT — re-authenticate to obtain a fresh         │
│         session, then retry                                             │
│                                                                           │
│  (c) origin / CSRF posture                                               │
│      the request's declared or inferred origin, or a caller-supplied     │
│      redirect-style target, is not on this deployment's trusted list     │
│      (03-cookies-and-csrf.md §6)                                        │
│         Blamed party: ordinarily CLIENT — issue the request from a       │
│         trusted context. BUT if the rejected origin is one this          │
│         deployment SHOULD have trusted and simply forgot to configure,   │
│         the true first cause is the deployer's configuration, per        │
│         00-methodology/03 §4 ("first cause, not first observer") — see  │
│         the worked example below                                        │
│                                                                           │
│  (d) detected cross-site navigation pattern                              │
│      a request shape matching the canonical hostile-page-submits-a-      │
│      login-form CSRF attack was detected (03-cookies-and-csrf.md §6.1)   │
│         Blamed party: CLIENT in the narrow technical sense (this         │
│         specific request is refused), but the ACTOR responsible for      │
│         the request existing at all is presumed hostile, not a           │
│         legitimate caller who merely made a mistake — there is nothing   │
│         for a legitimate caller to "fix" here; a legitimate integration  │
│         simply would not produce this shape                              │
└────────────────────────────────────────────────────────────────────────┘
```

**Worked example of "first cause, not first observer" (case c):** a
deployer runs a legitimate second front-end origin but never added it to
the trusted-origin list. A genuine user's browser, acting completely
correctly, sends a state-changing request from that origin. The pipeline
observes an untrusted origin and raises a 403, which — read
superficially — looks exactly like a client-blamed condition. But the
*first cause* is the deployer's incomplete configuration; the browser did
nothing wrong. Per `00-methodology/03-theory-of-contracts-and-blame.md`
§4, the correct blame assignment is SUPPLIER (the deployer), and the
correct recovery is a configuration change, not any different behavior
from the browser. The 403's *observable shape* does not, by itself, tell
you which of these two situations you are in — that determination
requires knowing whether the rejected origin was *supposed* to be
trusted. This is exactly why this taxonomy documents blame per
*condition*, not per *status code*: the status code alone is
under-determined.

### 2.4 Not found (404-class)

```
Operation:      a request names an identifier (a user, an account, a
                linked provider, an owned resource) that does not resolve
                to an existing record — including a record that DOES
                exist but is deliberately not distinguished from
                "does not exist" when doing so would leak its existence
                to a caller who should not be able to tell the difference
                (an ownership check that returns not-found rather than
                forbidden for a resource belonging to someone else)
On violation:   Blamed party: CLIENT — the caller supplied an identifier
                it had no valid basis to expect would resolve
                Recoverable by: supplying a valid, existing identifier
                the caller actually has a basis to reference; retrying
                the identical request never succeeds
```

### 2.5 Conflict (409-class in spirit; 400-class in this system's status vocabulary)

```
Operation:      a request is well-formed and the caller is authorized,
                but the requested transition is one the target entity's
                own invariant forbids given its CURRENT state (creating
                an account that already exists under a claimed identity;
                linking a credential already linked elsewhere; verifying
                an already-verified identity; removing the only
                remaining way to authenticate as an account; setting a
                credential an account already has one of)
On violation:   Blamed party: CLIENT — the request's INTENT does not
                match the entity's actual current state
                Recoverable by: changing intent to match reality (sign in
                instead of sign up; unlink a different, non-final
                credential first; do not attempt to re-verify) — NOT by
                retrying the identical request, which will fail
                identically every time because the entity's state, not
                the request, is the obstacle
```

### 2.6 Rate-limited (429-class)

```
Operation:      see 04-rate-limiting.md §3 in full
On violation:   Blamed party: CLIENT (or, under the fail-closed shared
                bucket, the aggregate of callers sharing that bucket —
                04-rate-limiting.md §2.1)
                Recoverable by: waiting the hinted duration and retrying
                with the same key — this is the one category in this
                entire taxonomy where retrying the IDENTICAL request,
                after waiting, is the correct and expected recovery
```

### 2.7 Upstream / adapter failure (500-class)

```
Operation:      the caller's precondition was fully satisfied — a
                well-formed, authorized, non-conflicting request — but a
                dependency this operation delegates to (the persistence
                layer, an external identity provider, a background
                verification-record write) failed to honor ITS OWN
                postcondition
On violation:   Blamed party: ADAPTER — whichever dependency failed to
                keep its promise, which per 00-methodology/03 §3 is where
                blame is anchored even though the failure surfaces
                through the endpoint that merely called it, and even
                though the endpoint is the thing the caller directly
                observes
                Recoverable by: the deployer or dependency operator
                resolving the underlying fault (connectivity, schema
                drift, provider outage, quota); whether an IDENTICAL
                retry by the original caller succeeds depends entirely on
                whether the underlying fault was transient — this
                category, uniquely, does not tell the caller in advance
                which is true
```

### 2.8 Internal / unexpected (500-class)

```
Operation:      a pipeline-internal invariant is violated in a way that
                does not correspond to any of the above — a hook's own
                matcher throws instead of returning a boolean
                (02-hooks-and-middleware.md §2.1), or any code anywhere
                in the pipeline throws a value this system does not
                recognize as one of the shapes in §1
On violation:   Blamed party: SUPPLIER — better-auth itself, a plugin
                author, or (see the exception immediately below) the
                integrator's own server-side calling code
                Recoverable by: the responsible party fixing the defect;
                this category carries no retry guidance for the ORIGINAL
                caller, because the original caller did nothing wrong and
                has nothing to change
```

**The one deliberate exception in this category:** a direct, in-process
invocation whose target capability needs to resolve this deployment's own
address per-request, but which was invoked without either the raw request
context or a configured fallback address, is raised in THIS category
(internal/unexpected) even though its blamed party is closer to a
precondition violation than to a genuine internal defect. The reason is
structural, not sloppiness: per
`00-methodology/03-theory-of-contracts-and-blame.md` §1, a contract
boundary always has exactly two parties, and the party in the "client"
position for THIS particular sub-contract is not the end user's browser
at all — it is the integrator's own server-side code that chose to call
this capability directly without supplying what it needs. Status-code
conventions map "the client got it wrong" to 400-class and "the supplier
got it wrong" to 500-class, but those conventions are calibrated around
the END USER as client; when the client in a given sub-contract is
instead trusted first-party server code, that convention does not hold,
and this system's own choice here is to surface it as an internal failure
regardless.

```
Blamed party: the DIRECT CALLER (the integrator's server-side code) —
              which is, confusingly but correctly by the boundary
              analysis above, still a case of blaming "the client of
              THIS particular boundary," even though the HTTP status
              family used (500-class) is the one this document otherwise
              reserves for supplier-blamed failures
Recoverable by: the integrator's code supplying the request context or a
              configured fallback address, then retrying — this is, in
              every respect except its status-code family, a
              precondition-violation recovery, not a bug-fix recovery
```

---

## 3. Blame propagation through composed layers

Per `00-methodology/03-theory-of-contracts-and-blame.md` §3, a violation
surfacing through several composed layers must retain the blame
assignment of whichever layer actually caused it — not the layer that
merely observed or re-raised it. The following instantiates that pattern
with three concrete, real layers from this system: an endpoint, an
authorization precondition step it composes in
(`01-http-endpoint-contract.md` §3), and the persistence-layer adapter
that step calls.

```
┌────────────────────────────────────────────────────────────────────────┐
│   an endpoint requiring          an "authorized org role"               │
│   organization-role              precondition step                     the persistence-  │
│   authorization                  (composed via the                     layer adapter's    │
│   (outer layer)                   endpoint's precondition chain,        lookup operation   │
│                                    middle layer)                        (inner layer)      │
│        │                                  │                                    │           │
│        │  invoke                          │                                    │           │
│        ├─────────────────────────────────▶│                                    │           │
│        │                                  │  look up membership               │           │
│        │                                  ├───────────────────────────────────▶│           │
│        │                                  │                                    │           │
│  CASE 1: the caller supplied no           │                                    │           │
│  organization identifier at all           │                                    │           │
│        │                                  │◀── the step itself rejects        │           │
│        │◀── surfaces as a validation ─────┤    before ever calling the        │           │
│        │    failure, unchanged            │    adapter                        │           │
│        │    Blamed party: CLIENT          │                                    │           │
│        │    (the immediate caller of      │                                    │           │
│        │    the endpoint)                 │                                    │           │
│                                                                                              │
│  CASE 2: the identifier is well-formed,   │                                    │           │
│  but the adapter's connection to the      │                                    │           │
│  persistence layer is down                │                                    │           │
│        │                                  │                                    │           │
│        │                                  │◀───────────────── ✗ lookup fails ─┤           │
│        │                                  │    blame: ADAPTER                  │           │
│        │◀── surfaces with the SAME ───────┤    (the persistence layer          │           │
│        │    blame attribution             │    failed its own postcondition)   │           │
│        │    Blamed party: ADAPTER —       │                                    │           │
│        │    the endpoint did NOT cause    │                                    │           │
│        │    this and must not absorb      │                                    │           │
│        │    the blame for it              │                                    │           │
│                                                                                              │
│  CASE 3: the precondition step itself     │                                    │           │
│  has a bug and constructs a malformed     │                                    │           │
│  lookup filter                            │                                    │           │
│        │                                  │──── malformed filter ─────────────▶│           │
│        │                                  │                                    │           │
│        │                                  │◀── the adapter faithfully reports │           │
│        │                                  │    "no such record" for the        │           │
│        │                                  │    malformed filter (this is NOT   │           │
│        │                                  │    an adapter failure — the        │           │
│        │                                  │    adapter did exactly what it     │           │
│        │                                  │    was asked)                      │           │
│        │◀── surfaces as forbidden/        │                                    │           │
│        │    not-found — but the TRUE      │                                    │           │
│        │    blame is NOT the caller       │                                    │           │
│        │    Blamed party: the             │                                    │           │
│        │    PRECONDITION STEP (a          │                                    │           │
│        │    SUPPLIER-side defect in the   │                                    │           │
│        │    middle layer) — a caller who  │                                    │           │
│        │    actually held the correct     │                                    │           │
│        │    role was wrongly refused      │                                    │           │
│        │    because of a bug two layers   │                                    │           │
│        │    away from where the refusal   │                                    │           │
│        │    was observed                  │                                    │           │
└────────────────────────────────────────────────────────────────────────┘
```

The point of laying out all three cases side by side against the same two
composed layers is that **the observable status code alone (400, 403/404,
or 403/404 again) cannot distinguish case 1 from case 3** — both can
surface as the identical HTTP status. Only tracing which layer's own
precondition or postcondition actually failed identifies the true blamed
party, which is precisely why this taxonomy is organized by *condition*
and *cause*, never by status code alone, and why a reimplementation must
preserve enough internal distinction between these cases to route them to
the correct fix, even when it chooses to present them identically over
the wire.

---

## 4. Configuration-time errors — a fourth, non-per-request category

Distinct from every category above (all of which are raised while
handling a specific request), a small set of failures are raised once, at
deployment assembly time, before any request is ever served — a required
base address is missing when a feature that depends on it is enabled; a
cross-subdomain cookie scope is requested without a way to name the
shared parent domain (`03-cookies-and-csrf.md` §5); a rate-limit storage
backend is selected without the underlying primitive it depends on
(`04-rate-limiting.md` §5).

```
Operation:      assemble a deployment's configuration
On violation:   raised once, at assembly time, never per-request
                Blamed party: SUPPLIER — the deployer's own configuration
                Recoverable by: correcting the configuration and
                re-assembling; there is no "retry the same request" story
                for this category, because no request was ever in flight
                when it was raised
```

This category is called out separately because it is easy to conflate
with §2.8 (internal/unexpected): both are ultimately SUPPLIER-blamed, but
a configuration-time failure is caught before the system ever accepts
traffic, while §2.8 is discovered mid-request against a configuration
that was otherwise valid. A reimplementation should preserve this timing
distinction — failing fast at assembly is strictly better than deferring
the same defect to an unlucky first request.
