# Client Core Contract — Construction, Base Actions, Reactive Session Store

> Reads against `00-methodology/01-design-by-contract.md`,
> `02-higher-order-contracts.md`, and `03-theory-of-contracts-and-blame.md`.
> In this document **CLIENT** always means the calling application / frontend
> code that embeds the SDK, and **SUPPLIER** always means the SDK itself
> (the code documented here). Where a failure originates in the backend the
> client talks to, this document says so explicitly rather than using the
> bare word "server."

## 0. Scope and boundary

This document specifies the part of the client SDK that exists **before any
plugin is registered**: how a client is constructed, what the fixed set of
session-lifecycle actions promises, and the contract of the reactive session
store every other piece of client-side reactivity is built on top of.

It deliberately excludes:

* the plugin **extension** mechanism itself — how a plugin contributes new
  actions, new reactive values, or new fetch-time behavior — specified by
  the peer document `03-plugin-system/03-client-plugin-contract.md`. This
  document treats "a plugin may attach actions and reactive values to the
  client" as a given capability and specifies only what the *core* uses that
  capability for (the two internal listeners it registers on itself).
* per-framework reactive bindings (a session-observation hook/composable) —
  specified once, generically, in `02-framework-bindings.md`, since every
  framework binding is a thin adapter over exactly the store contract
  specified here.
* the shape of any individual action's request/response body (email format,
  password policy, session/user field shapes) — those preconditions are
  owned by the backend endpoint the action calls and are out of scope for a
  client-side contract; this document specifies the **transport and
  reactivity contract** around an action, not its domain payload.

---

## 1. Construction contract

```
Operation:     construct-client
Requires:      a configuration value (possibly empty/omitted) that may
               supply: an origin/base-path for the backend, transport-level
               options (custom headers, retry policy, lifecycle callbacks),
               and a list of plugins.
Ensures:       returns a single client value exposing:
                 (a) the base action set (§2–§3),
                 (b) a reactive session store (§5),
                 (c) an SSR hydration operation (§7),
                 (d) every action/reactive-value any registered plugin
                     contributed (specified elsewhere), merged in.
Invariant:     construction never contacts the backend. No network request
               is made as a side effect of building the client — only of
               later observing the session store (§5) or invoking an
               action (§2–§3).
On violation:  construction itself has no failure mode that reaches the
               caller as a thrown error under normal configuration — see
               §1.1 for the one exception (native mobile scheme resolution,
               which is a platform delta, not a core-client concern).
```

### 1.1 Base-origin resolution is total, not partial

The precondition on "where is the backend" is deliberately **soft**: the
construction operation never refuses to build a client for lack of an
explicit origin. It resolves the effective origin through an ordered
fallback chain — an explicitly supplied origin, then an explicitly supplied
base path combined with environment-inferred origin, then a small number of
well-known hosting-environment conventions, and finally a fixed default
path assumed to be co-located with the calling application. Only if none of
these apply does resolution fall through to the default.

```
REQUIRE (soft): none — resolution always terminates in a value.
ENSURE:         baseOrigin = explicit-origin
                            ?? env-inferred-from-base-path
                            ?? hosting-platform-convention
                            ?? "co-located default path"
INVARIANT:      resolution is a pure function of the supplied configuration
                and process-level environment state at construction time —
                it is computed once, not re-resolved per request.
```

This means a *misconfigured* origin is never caught as a construction-time
contract violation — it manifests later, as ordinary network failures on
every action (§8), and is blamed on the **CLIENT** (the calling application
supplied or implied the wrong origin) even though the observable symptom is
a generic connection/timeout error rather than a dedicated diagnostic.

### 1.2 Transport composition is a staged contract

Every action (§2) ultimately funnels through one shared transport pipeline.
That pipeline is composed, at construction time, from an ordered sequence of
transport-level extensions: an internal stage wiring the caller's own
lifecycle callbacks (on-request/on-response/on-success/on-error), any
transport extensions the calling application supplied directly, an internal
navigation-following stage (§8.3), and finally each registered plugin's own
transport extensions, in registration order.

This is exactly the **staged/dependent contract** shape described in
`02-higher-order-contracts.md` §3: each stage may observe and further
transform what the previous stage already produced (a request about to be
sent, or a response about to be handed back), and a later stage's contract
is stated in terms of "whatever the earlier stages actually, observably,
produced" — not in terms of the original, unmodified request.

```
INVARIANT:  transport-stage order is fixed and deterministic for a given
            construction call: internal lifecycle wiring, then caller
            transport extensions, then internal navigation-following
            (unless explicitly disabled), then plugin transport extensions
            in registration order.
ON VIOLATION (a plugin's transport extension reads a request field an
            earlier stage was expected to have already normalized, and it
            has not been): blamed on whichever stage's own contract
            promised the normalization — per `03-theory-of-contracts-and-
            blame.md` §3, blame is attributed to the originating stage, not
            to the stage that merely observes the not-yet-normalized value.
```

### 1.3 Process-wide singleton facilities

Three facilities the store's refresh contract depends on — window-focus
observation, network-online observation, and cross-tab broadcast (§9) — are
**not** per-client-instance state. They are looked up (and lazily created)
against a process-wide slot, keyed identically regardless of how many times
`construct-client` is called in the same runtime.

```
INVARIANT:  all client instances constructed within the same JavaScript
            realm (the same browser tab, the same Node process) observe
            focus/online transitions through the SAME underlying observer,
            and post/receive cross-tab broadcasts through the SAME channel.
```

Consequence for a multi-instance embedding (two independent clients
constructed in the same tab, e.g. by two independently-loaded widgets):
their **session stores are NOT the same store** (each construction call
builds its own), but they share the same focus/online triggers and the same
cross-tab broadcast bus. A mutation performed through instance A causes
instance A's own store to refresh (via its own action→signal wiring, §3)
but does **not** directly refresh instance B's store — same-tab convergence
between two independently constructed clients, if it happens at all, is
opportunistic (the next focus/online event both happen to react to), not
guaranteed. Cross-*tab* convergence (§9) is unaffected by this, because it
is keyed on the shared broadcast bus, not on which client instance
performed the write.

---

## 2. The generic dynamic action contract

The base action set is not a fixed, enumerable list of named operations
baked into the client. It is a **generic arrow contract** over whatever
surface the backend the client was pointed at actually exposes: an action
is invoked by a path (a route the backend registered, itself following a
directory-like segment convention), an optional payload, and optional
per-call transport overrides.

```
Contract:      invoke(path, payload?, transportOverrides?)
                  ->  { data, error }  |  data  (throws on error)
Applies at:    any point calling code invokes an action reachable on the
               constructed client (including one added by a plugin).
Requires:      `path` corresponds to a route the backend this client is
               configured against actually registers (as base surface, or
               via a plugin active on BOTH sides — client and backend);
               `payload`, if present, is well-formed enough to be
               transmitted as request data — its DOMAIN shape (e.g. "email
               must look like an email") is a precondition owned by the
               backend endpoint, not restated here.
Ensures:       exactly one request is sent to the resolved origin (§1.1) at
               the given path; the request method is chosen automatically —
               a small set of known mutating paths always uses one method,
               an explicit per-call override is honored next, and otherwise
               presence of a payload selects the mutating method and its
               absence selects the read method; on success the settled
               value is either the raw response payload (if the caller
               opted into throw-on-error semantics) or a `{ data, error }`
               pair where at most one of the two is non-null.
Invariant:     the client performs NO validation of `payload` shape beyond
               separating declared query parameters from the request body
               and choosing a method — all domain validation is delegated
               to, and owned by, the backend.
On violation:
  - `path` does not correspond to any route the backend registers:
      Raised as:      a not-found-class error surfaced through the normal
                       `{ data, error }` (or throw) channel — the client
                       does not special-case this locally; the request is
                       still sent and the backend's own "no such route"
                       response is what the caller observes.
      Blamed party:   CLIENT — calling code invoked an operation that does
                       not exist for this backend/plugin configuration.
      Recoverable by: calling an operation that is actually registered.
  - `payload` fails the backend endpoint's own precondition (malformed
    shape, policy violation):
      Raised as:      a client-error-class response through the same
                       channel, carrying a typed error code (§8.1).
      Blamed party:   CLIENT — per `03-theory-of-contracts-and-blame.md`
                       §2, fault lies with whoever originated the bad
                       value, i.e. the calling application.
  - the network is unreachable, or the backend fails for a reason internal
    to it (an unhandled exception, a downing dependency):
      Raised as:      a server-error-class response, or a network-failure
                       error object, through the same channel.
      Blamed party:   SUPPLIER-side, propagated unchanged — per
                       `03-theory-of-contracts-and-blame.md` §3, this blame
                       is NOT re-attributed to the client SDK merely
                       because the client SDK is the thing that surfaced it;
                       it remains attributable to whichever backend
                       component actually failed.
```

---

## 3. The session-lifecycle actions and the refresh-signal contract

A fixed, small set of well-known paths — sign-in, sign-up, sign-out,
profile/user update, session update, email verification, session
revocation (single, all, or all-but-current), email change, password
change, account deletion — are additionally wired, by the core client
itself (not by a plugin), into a **refresh signal**: a shared boolean
toggle the reactive session store (§5) listens on.

```
Contract:      session-mutating-action -> refresh-signal-flip
Applies at:    immediately after any of the well-known paths above (or any
               path a plugin registers against the same signal, using the
               identical mechanism) completes successfully.
Requires:      the action completed with a success-class response (§2).
Ensures:       the refresh signal is flipped shortly after the response is
               observed (a small, deliberate delay — not the same tick —
               to avoid a request that is itself mid-flight incorrectly
               racing the refresh it is about to trigger); a sign-out
               additionally posts a cross-tab broadcast (§9) tagged with
               its own trigger reason.
Invariant:     the refresh signal is a pure trigger — it carries no payload
               describing WHAT changed, only THAT something that plausibly
               changed session state just happened. Every subscriber
               reacts identically (by re-querying session state from
               scratch) regardless of which of the well-known actions
               caused the flip.
On violation:  none of the above steps can fail independently of the
               action's own success/failure (§2) — this is a postcondition
               of a successful action, not a separately-invokable
               operation with its own precondition.
```

### 3.1 The bounded window where the invariant is "in transit," not broken

Per `01-design-by-contract.md` §2.3, an invariant need only hold **at
stable observation points** — after construction, and before/after each
operation — not throughout a multi-step flow. The mutate → flip-signal →
re-query round trip described above is exactly such a flow: for a bounded
interval between "the mutating action's own response was observed" and "the
triggered session re-query has itself resolved," the store may still be
reporting the pre-mutation session data as though it were the last
confirmed state.

This is not a violation of the store's "never stale-but-unmarked" invariant
(§5.4) — it is the store correctly reporting **its own last confirmed
state**, which has not yet been superseded. The invariant is restored, as
required, by the time the triggered re-query settles; it was never required
to hold mid-flight. A consumer that needs to react to "this specific
mutation, synchronously" (rather than "the store, eventually") must await
the mutating action's own response directly rather than infer completion
from the store.

---

## 4. Diagram — reactive propagation of session state to subscribers

```
                     ┌────────────────────────────────────────┐
                     │        calling application code          │
                     │  invokes a session-mutating action        │
                     │  (sign-in, sign-out, update-user, ...)     │
                     └───────────────────┬────────────────────┘
                                         │  (1) one HTTP request
                                         ▼
                     ┌────────────────────────────────────────┐
                     │              backend                      │
                     └───────────────────┬────────────────────┘
                                         │  (2) success response
                                         ▼
                     ┌────────────────────────────────────────┐
                     │   transport pipeline, post-response       │
                     │   stage (§1.2): path matched against       │
                     │   the fixed well-known-path list (§3)      │
                     └───────────────────┬────────────────────┘
                                         │  (3) after a short,
                                         │      deliberate delay
                                         ▼
                     ┌────────────────────────────────────────┐
                     │           refresh signal (shared,          │
                     │           boolean, no payload)             │
                     └───────┬───────────────────────┬─────────┘
                              │                        │
              (4a) local listener           (4b) cross-tab broadcast
              (always, same tab)             (sign-out only, §9)
                              │                        │
                              ▼                        ▼
              ┌───────────────────────────┐  ┌───────────────────────┐
              │  session re-query is       │  │  OTHER tabs/windows'   │
              │  scheduled (§5)             │  │  broadcast listener    │
              └─────────────┬─────────────┘  │  receives the message  │
                              │                └───────────┬───────────┘
                              │                             │ re-enters
                              │                             │ this same
                              │                             ▼ diagram at (4a)
                              ▼
              ┌───────────────────────────────────────────────┐
              │   session re-query settles: store transitions   │
              │   through {isRefetching: true} to the settled    │
              │   {data | error, isPending:false} state (§5)     │
              └─────────────────────┬─────────────────────────┘
                                    │  (5) store's own equality
                                    │      gate (§5.5): only fires
                                    │      if the new value is NOT
                                    │      structurally identical
                                    │      to the current one
                                    ▼
              ┌───────────────────────────────────────────────┐
              │   every current subscriber of the store is       │
              │   notified — this fan-out is what a framework    │
              │   binding's hook/composable is built on           │
              │   (see 02-framework-bindings.md §2)                │
              └───────────────────────────────────────────────┘
```

---

## 5. The session store contract

The reactive session store is the client's single authoritative, observable
answer to "what does the backend currently believe about this caller's
session." It is not merely a cache of the last `get-session`-style response
— it additionally owns the dedup, freshness, cancellation, and equality
behavior described below.

### 5.1 Shape of every observation

At any moment a subscriber may observe the store, it is in exactly one of
these mutually exclusive states:

```
{ data: SessionOrNull, error: null,       isPending: bool, isRefetching: bool }   — confirmed (data may be null = "no session")
{ data: last-known,     error: ErrorValue, isPending: false, isRefetching: false } — degraded: last-known data retained, but flagged as unconfirmed
{ data: null,           error: ErrorValue, isPending: false, isRefetching: false } — confirmed logged-out (see §5.3)
```

```
INVARIANT:  the store is NEVER observed with `data` present, `error` null,
            AND `isPending`/`isRefetching` both false, unless that `data`
            value is the most recently backend-confirmed value the store
            has seen. There is no fourth, "quietly stale" combination:
            staleness is always visible as either a non-null `error` or a
            true `isPending`/`isRefetching` flag.
```

This is the concrete form of the postcondition this whole document is
organized around: **the store always reflects the last known
backend-confirmed session state, or an explicit loading/error state — never
a stale-but-unmarked one.**

### 5.2 The get-session query operation

```
Operation:     query-session(queryOptions?)
Requires:      none — this operation carries NO authentication
               precondition; it is always safe to call, including with no
               session at all.
Ensures:       issues a read request; if the response indicates the
               backend wants the caller to immediately perform a refresh
               (a distinct signal embedded in the response, independent of
               HTTP status), a second, mutating-method request is issued
               transparently before the operation settles — the caller
               observes only the FINAL settled outcome, never the
               intermediate one.
Invariant:     a response reporting no session at all (both the session
               and user fields absent/null) is normalized to `data: null`
               — this is NOT treated as an error. Absence of a session is
               a legitimate, first-class successful outcome of this
               operation.
On violation (the transparent second/refresh request itself fails):
      Raised as:      the operation still settles — using the FIRST
                       response's data, not as an error — the refresh
                       failure is swallowed rather than surfaced.
      Blamed party:   ambiguous by design: this is a deliberate
                       availability-over-strictness choice by the SUPPLIER
                       (prefer showing slightly-behind-but-real data over
                       failing outright on a housekeeping refresh); a
                       consuming application that needs to detect this case
                       has no first-class signal to key on and must treat
                       it identically to "nothing needed refreshing."
```

### 5.3 The 401 special case

```
INVARIANT:  if the backend responds to a session read with an explicit
            unauthorized-class status (as opposed to the ordinary
            "no session" success body of §5.2), the store treats this as
            AUTHORITATIVE: `data` is forced to null, overriding whatever
            was previously cached — this is the one case where an error
            response is allowed to clear, rather than merely flag, prior
            data.
ON VIOLATION: any OTHER error class (network failure, backend-internal
            failure) explicitly does NOT clear `data` — it is retained
            alongside the now-non-null `error` field (the degraded state
            of §5.1). A consuming application that reads `data` without
            first checking `error` risks treating retained-but-unconfirmed
            data as fresh; this is a documented CLIENT-side obligation —
            `error` must be checked before `data` is trusted as current.
```

### 5.4 Dedup, freshness, and cancellation

```
Requires:      none — this is entirely internal bookkeeping, invisible to
               the calling application except through its effects.
Ensures:
  - Only one query-session request is ever in flight at a time per store;
    triggering a new one (any of: mount, an explicit refetch call, the
    refresh signal flipping, a focus/online/broadcast trigger, §9)
    cancels any request already in flight before starting the new one.
    A cancelled request's eventual outcome, if it arrives late anyway, is
    discarded — it can never overwrite the store with stale data.
  - A short freshness window is tracked (bounded by the session's own
    reported expiry, if sooner): a query triggered by nothing more than
    "a subscriber just mounted" is skipped entirely if the store is still
    within this window, avoiding a redundant network round trip for a
    component that mounts and unmounts in quick succession.
  - The refresh signal (§3) flipping ALWAYS invalidates the freshness
    window immediately, regardless of how fresh the cached value currently
    is — a known mutation is never served from a freshness cache that
    predates it.
Invariant:     the freshness/dedup optimization NEVER changes what the
               eventual, settled state looks like (§5.1) — it only changes
               whether a network round trip is skipped. It must never
               cause `isPending`/`isRefetching` to misreport (e.g. report
               "not pending" while a request that will change `data` is
               genuinely still in flight elsewhere).
```

### 5.5 Equality gate and referential stability

```
Ensures:  a store update whose new value is structurally (deep,
          value-wise) identical to the currently held value is discarded
          BEFORE any subscriber is notified — subscribers (and, through
          them, framework bindings, see 02-framework-bindings.md) never
          re-render for a "re-confirmed but unchanged" observation.
Ensures (referential stability): when a new observation is structurally
          equal to the current `data`, the store retains the OLD object
          reference for `data` rather than replacing it with the newly
          received (but equal) one. This is a deliberate postcondition,
          not an accident of the equality check: it lets consuming code
          rely on reference equality (e.g. memoized rendering) staying
          stable across a no-op refresh, not merely on "no re-render was
          scheduled."
```

---

## 6. Diagram — sign-in then read session, from the frontend's perspective

```
 frontend code                 client SDK (this doc)            backend
      │                              │                              │
      │  invoke sign-in(credentials) │                              │
      ├─────────────────────────────▶│                              │
      │                              │  POST /sign-in/...            │
      │                              ├─────────────────────────────▶│
      │                              │                              │  validates
      │                              │                              │  credentials,
      │                              │                              │  establishes
      │                              │                              │  session
      │                              │  success response             │
      │                              │◀─────────────────────────────┤
      │  promise settles (data)      │                              │
      │◀─────────────────────────────┤                              │
      │                              │                              │
      │                              │  (§3) matches sign-in against │
      │                              │  the well-known-path list;     │
      │                              │  after a short delay, flips    │
      │                              │  the refresh signal             │
      │                              │                              │
      │                              │  (§5.2) query-session          │
      │                              ├─────────────────────────────▶│
      │                              │  fresh session confirmed       │
      │                              │◀─────────────────────────────┤
      │                              │  store settles:                │
      │                              │  {data: session, isPending:    │
      │                              │   false, error: null}          │
      │                              │                              │
      │  frontend reads session      │                              │
      │  via the store (any          │                              │
      │  subscriber, e.g. a          │                              │
      │  framework binding's hook)   │                              │
      ├─────────────────────────────▶│                              │
      │  {data: session, ...}        │                              │
      │◀─────────────────────────────┤                              │
      │                              │                              │

 NOTE: between "promise settles" and "store settles," a read of the store
 (if one happened right then) would still show the PRE-sign-in state
 (§3.1) — this is expected, not a bug: the sign-in action's own promise is
 the authoritative signal that the mutation itself succeeded; the store is
 the authoritative signal for "what does a read of session state show
 right now," and the two settle at different points in this sequence.
```

---

## 7. SSR hydration contract

```
Operation:     hydrate-session(sessionOrNull)
Requires:      called with either a concrete, already-confirmed session
               value, or `null`.
Ensures:       IF the store has not yet been written to by anything else
               (no prior hydration, no prior network response) AND the
               call is occurring in a browser-like runtime (not during
               server-side rendering itself) AND the supplied value is not
               `null`, the store's `data` is set directly from the
               supplied value, `error` cleared, `isPending` cleared —
               without a network round trip.
Invariant:     hydration NEVER overwrites data the store has already
               obtained by any other means (a real network fetch, an
               earlier hydration call) — it is a one-shot, first-write-wins
               operation, not an assignment.
Invariant (SSR safety): a call occurring during server-side rendering
               itself is UNCONDITIONALLY a no-op. This is a supplier-owned
               safety property, not an optimization: a server-rendering
               runtime commonly reuses one long-lived process across many
               concurrent requests from different end users: writing one
               request's session into a shared, process-level store during
               that phase would leak it into a DIFFERENT, concurrent
               request being rendered in the same process.
On violation (calling code passes a session value from the wrong request,
               e.g. copy-paste across two concurrently rendered requests'
               serialized state):
      Raised as:      no error — the store simply hydrates with the wrong
                       data; nothing about this shape of misuse is
                       detectable by the SDK.
      Blamed party:   CLIENT — this is a server-rendering integration bug
                       in the calling application, and a security-relevant
                       one (session confusion between two end users), not a
                       contract the SDK can enforce from the client side.
      Recoverable by: never serializing one request's session payload
                       into another request's hydration call.
```

`null` is intentionally **not** a way to force-clear an already-populated
store to a logged-out state through this operation — the "not yet
populated" guard above applies before the `null` check is even reached, so
passing `null` is only ever a no-op, never a clear. Logging out is
performed through the sign-out action (§3), not through this operation.

---

## 8. Error surface and blame preservation

### 8.1 Typed error identifiers vs. human-readable messages

Every error surfaced through the `{ data, error }` (or throw) channel of
§2 carries both a stable, enumerable identifier and a human-readable
message. Only the identifier is part of the contract.

```
INVARIANT:  identifiers are drawn from a fixed, enumerable set (the base
            set the core client defines, extended by whatever set each
            active plugin additionally declares) and are stable across
            releases in the sense that a given failure condition always
            maps to the same identifier.
ON VIOLATION (calling code branches on the human-readable message text
            instead of the identifier, and a later release rewords that
            message): blamed on the CLIENT — the message was never part of
            the contract; relying on it is relying on a value the contract
            explicitly does not promise stability for (per
            `01-design-by-contract.md` §6: "what is observable... when a
            contract is broken" only covers what the contract actually
            promised).
```

### 8.2 Blame is preserved through the transport pipeline

Per `03-theory-of-contracts-and-blame.md` §3, an error originating deep in
the backend (a downstream dependency failure, for instance) and merely
relayed by the transport pipeline's several stages (§1.2) must reach the
calling application with the SAME blame it originated with — a
client-error-class failure remains attributable to whatever produced the
bad input; a backend-internal failure remains attributable to the backend.
No stage in the pipeline is permitted to "launder" blame by re-wrapping an
error without preserving its original classification.

### 8.3 A successful action may mean "the caller's execution context ends"

```
INVARIANT:  for a subset of actions (chiefly: any sign-in path whose
            response indicates the backend wants the browser to navigate,
            e.g. certain federated/social flows), successful completion of
            the transport pipeline's own contract may consist of causing
            an actual page navigation, rather than a resolved value the
            calling application's own code goes on to observe.
```

Calling code invoking such an action must not assume its own subsequent
statements will run — "the action's postcondition was satisfied" and "my
code kept executing" are two different things for this subset of actions,
and the difference is not something the client SDK can flag ahead of time
(the calling code chooses which action to call; whether that action's
particular backend configuration triggers a navigation is not knowable from
the client alone).

---

## 9. Cross-tab / cross-window synchronization contract

```
Operation:     broadcast(trigger-reason)
Applies at:    after a sign-out (§3), and after any action a plugin
               registers against the same mechanism (specified in the
               peer plugin-contract document).
Requires:      none from the calling code — this is entirely internal.
Ensures:       a message is written to a channel visible to all OTHER
               same-origin tabs/windows currently open (never observed by
               the tab/window that wrote it — this is a property of the
               underlying browser mechanism, not a choice this SDK makes).
Invariant:     if the runtime cannot support this (no browser-level storage
               available, storage disabled/quota-exhausted, non-browser
               runtime), the write is silently discarded — it never throws,
               and it never blocks or fails the action that triggered it.
On violation (the broadcast never reaches other tabs, for the above
               reasons):
      Raised as:      nothing — no error is surfaced anywhere.
      Blamed party:   n/a by design — this is a deliberate
                       availability-over-consistency choice by the
                       SUPPLIER: cross-tab sync degrades to "no cross-tab
                       sync" rather than failing the local action. Calling
                       code must treat cross-tab convergence as
                       best-effort, never as a guarantee.
```

### 9.1 Receiving side

```
Ensures:   a received broadcast message is only acted upon if it matches
           this exact channel's own message shape (guards against
           unrelated code sharing the same underlying storage mechanism in
           the same origin); a matching message causes exactly the same
           re-query as any other refresh-signal trigger (§3) — subject to
           the SAME online/offline gating as every other refresh trigger
           (§9.2) — no special "this refresh was caused by another tab"
           information is exposed to the receiving tab's own subscribers.
```

### 9.2 Diagram — cross-tab convergence sequence

```
   Tab A                          shared broadcast bus            Tab B
     │                                    │                          │
     │  sign-out succeeds                 │                          │
     │  (§3: local refresh-signal flip     │                          │
     │   AND broadcast post)               │                          │
     ├────────────────────────────────────▶│                          │
     │                                    │  (never delivered         │
     │  local session store re-queries     │   back to Tab A)          │
     │  and settles to logged-out           │                          │
     │  independently of the broadcast      │                          │
     │                                    │   delivered as a           │
     │                                    │   'storage'-class event    │
     │                                    ├─────────────────────────▶│
     │                                    │                          │  message shape
     │                                    │                          │  validated (§9.1)
     │                                    │                          │
     │                                    │                          │  is the runtime
     │                                    │                          │  currently online
     │                                    │                          │  (or configured to
     │                                    │                          │  refresh while
     │                                    │                          │  offline)?
     │                                    │                          │       │ no
     │                                    │                          │       ▼
     │                                    │                          │  refresh SKIPPED —
     │                                    │                          │  Tab B stays stale
     │                                    │                          │  until its own next
     │                                    │                          │  focus/online event
     │                                    │                          │       │ yes
     │                                    │                          │       ▼
     │                                    │                          │  Tab B's session
     │                                    │                          │  store re-queries
     │                                    │                          │  and settles to
     │                                    │                          │  logged-out too
```

Note the branch: cross-tab convergence is **not unconditional** — it is
gated by the same online/offline policy every other refresh trigger obeys
(§5.4 / §9.1). An offline tab that receives a cross-tab sign-out broadcast
does not immediately reflect it; it converges only once it next satisfies
the online-refresh gate (or is otherwise re-triggered, e.g. by regaining
focus).

---

## 10. Summary of invariants a downstream (e.g. Effect-native) reimplementation must preserve

1. Construction never contacts the network and never fails on a
   missing/ambiguous origin (§1.1) — misconfiguration surfaces later, as
   ordinary request failures, blamed on the CLIENT.
2. The dynamic action contract performs no domain validation of its own
   (§2) — all such validation, and its blame attribution, is owned by the
   backend endpoint.
3. A fixed set of session-lifecycle actions is wired to a payload-free
   refresh signal (§3); the resulting re-query is allowed a bounded,
   observable "in transit" window before the store invariant is restored
   (§3.1) — this window is a documented relaxation, not a bug.
4. The session store is never observed in a fourth, "quietly stale"
   combination of `data`/`error`/`isPending`/`isRefetching` (§5.1).
5. `error` must be checked before `data` is trusted as current, except in
   the one case where an authoritative unauthorized response clears `data`
   outright (§5.3).
6. In-flight session queries are single-flight and cancellation-safe: a
   superseded query's late result can never overwrite the store (§5.4).
7. A no-op (structurally-equal) store update is discarded before
   notification, and referential identity of unchanged data is preserved
   (§5.5) — both are contractual, not incidental.
8. SSR hydration is first-write-wins and unconditionally inert during the
   server-rendering phase itself, to prevent cross-request session leakage
   in a shared rendering process (§7).
9. Error identifiers, not messages, are the contractual surface (§8.1);
   blame is preserved, not re-attributed, as an error crosses transport
   stages (§8.2).
10. Cross-tab synchronization is best-effort, never observed by the
    originating tab, and gated by the same online/offline policy as every
    other refresh trigger (§9).
