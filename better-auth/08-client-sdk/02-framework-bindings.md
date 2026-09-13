# Framework Binding Contract — Generic Contract Plus Platform Deltas

> Reads against `01-client-core-contract.md` (assumed known — this document
> restates none of the session store's internal invariants, only how a
> UI-framework or native-runtime binding is permitted to expose them) and
> against `00-methodology/01-design-by-contract.md` §5 (the Liskov-style
> rule that a specialization may weaken preconditions and strengthen
> postconditions, but never the reverse) and `03-theory-of-contracts-and-
> blame.md`.

## 0. Why this is one contract, not five (plus two)

Every UI-framework integration (and the two native-runtime integrations)
constructs a client through the *identical* construction operation and
transport pipeline specified in `01-client-core-contract.md` — same base
action set, same session store, same refresh-signal wiring. The only thing
that differs, for the five UI-framework bindings, is which native
reactive primitive the framework's binding wraps the store's subscription
mechanism in — an external-store-subscription-style hook, a reactive
reference cell, a fine-grained accessor function, a plain reactive value
passed to a template-level subscription sigil, and so on, depending on the
host framework's own idiom. That is a **syntactic**
difference over an **identical** underlying contract, and is specified once
here (§1–§2), with platform sections (§3) stating only genuine deltas.

The two native-runtime deltas (§4–§5) are a different kind of thing
entirely: they change an actual **precondition** — how a redirect/callback
is delivered back to the running application, and what is required to
persist a session across app restarts — not merely how the result is
exposed to a rendering layer. Those are specified at the same level of
rigor as the core contract, because they are real contract differences.

---

## 1. The generic framework-binding contract

```
Operation:     construct-client (framework variant)
Requires:      identical to 01-client-core-contract.md §1 — no additional
               precondition is introduced merely by choosing a framework
               binding.
Ensures:       returns everything the core construction contract promises
               (§1 of the core document), with the reactive session store
               and every plugin-contributed reactive value additionally
               exposed as a value/hook/composable native to the host
               framework's own reactivity model, in place of the bare
               store primitive.
Invariant:     the wrapped value carries EXACTLY the observable states the
               underlying store can be in (01-client-core-contract.md
               §5.1) — a framework binding introduces no additional state
               of its own and drops none, except where a named delta below
               says otherwise.
```

### 1.1 The wrapping is itself an arrow contract

Per `02-higher-order-contracts.md` §2, the wrapping a framework binding
performs is a function contract, checked at the point it is actually
invoked (rendered/read), not at the point the client was constructed:

```
Contract:      session-observation-hook : () -> FrameworkNativeReactiveValue
Applies at:    every point the host application's own rendering/reactivity
               system invokes the hook/composable/accessor.
Domain:        no arguments in the common case (see the one Vue delta,
               §3.2, which is genuinely two-argument-shaped).
Range:         a value, in the host framework's own idiom, that:
                 (a) synchronously reflects the store's CURRENT state at
                     the moment of the call — never an initial placeholder
                     distinct from what a direct read of the store would
                     give at that same instant;
                 (b) updates, through the host framework's own scheduling,
                     whenever (and only whenever) the underlying store
                     notifies subscribers (01-client-core-contract.md
                     §5.5's equality gate applies transitively — a
                     no-op store update never causes a re-render/re-
                     computation through this wrapping either).
```

### 1.2 Generic invariants (apply to every framework binding unless a delta says otherwise)

**(a) Synchronous initial read.** The very first read of the wrapped value
reflects the store's state at that instant — there is no framework-level
"not yet initialized" placeholder state layered on top of the store's own
`isPending`-driven loading state (`01-client-core-contract.md` §5.1). If the
store is currently loading, the wrapped value says so through the store's
own `isPending` field, immediately, on the first read.

**(b) Lifecycle-bound subscription.** Every binding attaches its
subscription to the underlying store at the point the host framework
considers the consuming unit (component, effect scope) to become active,
and detaches it at the point the host framework considers that unit
disposed — using whatever mount/cleanup primitive is idiomatic for that
framework.

```
REQUIRE (of the calling application, not of the SDK): the hook/composable
        is invoked in a context the host framework itself recognizes as an
        active reactive scope (a rendering component, an active effect/
        computation). This precondition belongs to the HOST FRAMEWORK's
        own contract, not to this SDK — the SDK neither enforces nor can
        enforce it.
ON VIOLATION (invoked outside such a context — e.g., outside any component
        instance, outside any effect scope): the automatic subscribe/
        unsubscribe wiring described above cannot attach at all in some
        frameworks, or attaches but is never automatically released in
        others. Either way:
      Blamed party:  CLIENT (the calling application code chose where to
                      invoke the hook) — but the DEFECT this produces (a
                      subscription that leaks, or a value that never
                      updates) is a symptom of the host framework's own
                      rules being violated, not of this SDK's contract
                      being violated. This SDK's part of the contract (§1.1)
                      is unaffected either way.
```

**(c) Change propagation is exactly the store's own emission.** A framework
binding fires a re-render/re-computation once per store notification that
survives the store's own equality gate (`01-client-core-contract.md` §5.5)
— never more often (no framework binding introduces its own additional
polling or re-derivation) and never less often (no framework binding
introduces its own additional equality/memoization layer on top of the
store's, UNLESS a delta below documents a deliberate, permitted
*strengthening* of this, per the Liskov rule in
`01-design-by-contract.md` §5).

**(d) Loading/error shape is preserved, not reinterpreted.** Whatever
shape the underlying store's observable state has (`01-client-core-
contract.md` §5.1) is preserved through the wrapping — a framework binding
never collapses `error` and `data` into a single field, never infers
`isPending` from `data`'s nullability instead of reading the store's own
flag, and never introduces a fourth, "quietly stale" combination the core
store itself does not have.

**(e) SSR is deferred to the core contract, not reimplemented.** A
framework binding performs no network access of its own during
server-side rendering — the core store already guards this
(`01-client-core-contract.md` §5.2, §7). Rendering the hook/composable
during server-side rendering yields whatever the store's default,
not-yet-fetched state is, without throwing; hydration to real data is the
core `hydrate-session` operation's job (`01-client-core-contract.md` §7),
not the binding's.

### 1.3 The canonical operation contract

```
Operation:     session-observation-hook()      [generic — every framework's
                                                 concrete name/idiom for this
                                                 is a syntactic detail]
Requires:      called within the host framework's own reactive-scope rules
               (§1.2.b) — a precondition owned by the host framework.
Ensures:       returns the live, subscribed view of the session store
               (01-client-core-contract.md §5), expressed as the host
               framework's native reactive value type, satisfying §1.2
               (a)–(e).
Invariant:     identical to the core session-store invariant
               (01-client-core-contract.md §5.1) — carried through
               unchanged, because the binding performs no independent
               caching, no independent equality logic beyond what §1.2.c
               permits, and no independent state of its own.
On violation:
  - calling code violates the HOST FRAMEWORK's own reactivity rules
    (conditional invocation, invocation outside a reactive scope):
      Blamed party:   CLIENT, but enforcement (if any) belongs to the host
                       framework — see §1.2.b.
  - calling code assumes a field the GENERIC contract does not promise for
    the specific binding in use (see the Lynx delta, §3.5):
      Blamed party:   CLIENT — coding against an assumed shape instead of
                       the documented per-binding contract.
```

Every other reactive value a plugin contributes (specified in the peer
plugin-contract document) is wrapped identically — the naming convention
and wrapping mechanism described here generalize to any store the client
exposes, not only the session store.

---

## 2. Diagram — the generic subscribe/notify/unsubscribe lifecycle across bindings

```
   host framework's mount/               underlying session store
   activation point                       (01-client-core-contract.md §5)
        │                                          │
        │  (1) hook/composable invoked for          │
        │      the first time in this scope          │
        ├──────────────────────────────────────────▶│  synchronous read of
        │                                          │  current state (§1.2.a)
        │◀─────────────────────────────────────────┤
        │  current state returned immediately        │
        │                                          │
        │  (2) subscription attached, using          │
        │      whichever mount/cleanup primitive       │
        │      the host framework provides             │
        ├──────────────────────────────────────────▶│  store adds this as
        │                                          │  a subscriber
        │                                          │
        │           ...time passes; the store        │
        │           settles a new observation         │
        │           that survives its own              │
        │           equality gate (§1.2.c)...          │
        │                                          │
        │◀─────────────────────────────────────────┤  notify
        │  (3) host framework's own scheduler is      │
        │      informed a re-render/re-computation      │
        │      is due                                  │
        │                                          │
        │  (4) host framework's disposal point        │
        │      is reached (unmount / scope end)         │
        ├──────────────────────────────────────────▶│  subscription removed
        │                                          │  (store keeps running
        │                                          │  for any OTHER
        │                                          │  remaining subscriber)
```

This diagram is identical for every UI-framework binding — only step (2)'s
"whichever mount/cleanup primitive" and step (3)'s "own scheduler" are
framework-specific, and neither changes what is observable to the calling
application (§1.2).

---

## 3. Per-framework deltas (syntactic bindings — deltas only)

### 3.1 The one hook covering four of the five bindings

Four of the five UI-framework bindings — the fourth being effectively
byte-identical to the first in its subscription mechanics — differ from
each other only in: the name of the native reactive primitive returned,
and (for one of them) whether the wrapped value is additionally marked
read-only at the type level in non-production builds for tooling/devtool
registration purposes. None of this is an observable contract difference
from the calling application's point of view; it is not restated per
framework.

### 3.2 Delta — an additional, alternate operation exists for one binding

One binding (the one targeting a full-stack meta-framework built on its
underlying UI framework) exposes a SECOND, alternate form of the
session-observation operation, in addition to the generic one (§1.3):

```
Operation:     session-observation-hook(hostFrameworkFetchFunction)
Requires:      the caller supplies a function matching that meta-
               framework's own conventional data-fetching shape (its own
               cache-key, watch-dependency, and result-shape conventions).
Ensures:       performs its OWN request to the session-read endpoint,
               scoped by a cache key derived from this client's configured
               origin, and re-runs whenever the shared refresh signal
               (01-client-core-contract.md §3) changes — but returns a
               result shaped according to the HOST META-FRAMEWORK's own
               data/error convention, not the generic shape of §1.2.d.
Invariant:     this alternate form does NOT go through the core store's
               dedup/freshness/equality machinery
               (01-client-core-contract.md §5.4–§5.5) — it is delegated
               entirely to the host meta-framework's own fetch/cache
               semantics.
On violation (staleness or duplicate-request behavior specific to this
               alternate form): blame shifts, for exactly this alternate
               form, from this SDK to the host meta-framework's own
               fetch/cache implementation — a caller who opts into this
               form has opted OUT of the SDK's own store contract for that
               specific read.
```

This is a genuine second contract, not a restatement — it exists precisely
because that meta-framework has its own, independently-relevant
server-rendering data contract that the generic form (§1.3) does not
integrate with.

### 3.3 Delta — one binding returns the underlying store value directly, deferring the live-binding to the host language's own syntax

One binding's session-observation operation returns the underlying
reactive store value itself, rather than a value already wrapped in a
framework-native reactive primitive.

```
INVARIANT:  the live-update guarantee of §1.2(a)–(c) holds ONLY once the
            calling application applies that host framework's own
            store-subscription language construct to the returned value at
            the point of use. Calling the operation and reading the result
            as a plain, static value (without that construct) yields a
            correct SNAPSHOT at that instant, but NOT a live-updating one.
```

```
REQUIRE (unique to this binding, additional to §1.2.b): the calling code
        must apply the host framework's own store-subscription syntax at
        each point it wants a live value. This SDK's contract stops at
        "returns a value that syntax correctly subscribes to"; the live
        binding itself is a host-language-level contract, not one this SDK
        enforces or can enforce.
```

### 3.4 Delta — one binding offers a strictly finer-grained re-render guarantee

One binding wraps the store's value using a structural, per-field diffing
mechanism rather than whole-value replacement, giving calling code that
reads only a nested sub-field of the session value a STRICTLY NARROWER
re-render/re-computation trigger than §1.2.c's baseline "any surviving
store notification re-renders":

```
INVARIANT (this binding only): a computation that reads only one nested
            leaf field of the session value (e.g. a display name nested
            under the confirmed user record) does NOT re-run when a
            SIBLING leaf field changes (e.g. the session's own expiry
            timestamp) and the read field itself did not.
```

This is a permitted **strengthening** of §1.2.c under the Liskov rule of
`01-design-by-contract.md` §5 (a specialization may promise MORE, never
less) — it is documented as a delta only because a caller relying on the
generic contract's coarser guarantee (§1.2.c) would not be surprised by
fewer re-renders than expected, but a caller relying specifically on this
binding's finer guarantee would be surprised to find it absent in any
other binding.

### 3.5 Delta — one binding's session-observation result omits a field the generic contract otherwise always includes

One binding's session-observation operation returns a result that omits
the "a background refresh is currently in flight while previously-fetched
data is still shown" flag that every other binding (and the underlying
store itself) exposes.

```
ON VIOLATION (calling code, migrating from any other binding, assumes this
            flag is present): 
      Blamed party:   CLIENT, per §1.3's generic "on violation" clause —
                       but flagged here explicitly because this is an
                       inherited inconsistency in the existing SDK rather
                       than a deliberate design choice, and a downstream
                       reimplementation should decide consciously whether
                       to preserve this narrower contract for this
                       binding or to close the gap so all bindings satisfy
                       the identical generic contract of §1.2(d).
```

---

## 4. Mobile delta — a distinct session-persistence and OAuth-redirect precondition

Unlike a browser-hosted binding, a native mobile runtime has **no ambient
cookie jar** shared between its network stack and its embedded/system
browser sessions. This produces two genuine precondition changes, not
merely an implementation detail.

### 4.1 Secure-storage precondition on session persistence

```
Operation:     construct-client (mobile variant)
Requires (ADDITIONAL to 01-client-core-contract.md §1): the calling
               application supplies a concrete secure-storage backend
               (an object exposing synchronous and asynchronous get/set
               operations, matching the host platform's secure-credential-
               storage shape) at construction time. There is no built-in
               fallback — construction does not fail for its absence, but
               every subsequent action that depends on persisted session
               state behaves as if no session ever persists across app
               launches.
Ensures:       every response is inspected for session-establishing
               response headers; when present, the resulting cookie-like
               state is manually serialized into the supplied secure
               storage, and manually re-attached as a request header on
               every SUBSEQUENT request — this manual round trip is what
               REPLACES the ambient cookie jar a browser-hosted binding
               gets for free.
Invariant:     large serialized session state is split across multiple
               storage entries to respect the host secure-storage
               backend's own per-item size limit, up to a fixed maximum
               number of such entries.
On violation (the serialized session state would require MORE entries
               than the fixed maximum):
      Raised as:      the write is abandoned and an error is logged
                       internally; the response the write was
                       piggy-backing on has ALREADY been treated as
                       successful by the time this is discovered (the
                       write happens inside a post-response, best-effort
                       hook) — so the calling application observes a
                       successful action whose session persistence
                       silently failed.
      Blamed party:   split between the SUPPLIER's chosen storage
                       backend's size limits and the CLIENT's own session
                       payload size (e.g. an oversized additional session
                       field contributed by a plugin) — this is flagged
                       explicitly as an ambiguous-blame case a downstream
                       reimplementation should resolve by surfacing this
                       failure to the caller rather than swallowing it.
```

### 4.2 An additional, provisional store state unique to this platform

This binding additionally persists the last confirmed session-read result
to a second secure-storage entry, and — on first mount, if the in-memory
store has not yet obtained real data and this optimization is not disabled
— seeds the store's `data` field from that cached value while explicitly
LEAVING `isPending` at its true value (still loading, since the
network-confirmed read has not yet returned).

```
INVARIANT (this platform's addition to 01-client-core-contract.md §5.1):
            a THIRD, provisional combination is possible here that the
            core web contract does not otherwise produce: `data` present
            (from the local cache) AND `isPending` simultaneously true
            (because the real network confirmation is still outstanding).
            This is a deliberate, ADDITIONAL state — not a violation of
            the core "never stale-but-unmarked" invariant, because
            `isPending` being true IS the mark: calling code is expected
            to treat `isPending` as the confirmation gate and `data`, when
            `isPending` is true, as a hint only, superseded unconditionally
            once the real read resolves.
```

A downstream reimplementation should treat this as an explicit,
documented three-state extension of the core contract for this platform
only — not something to silently fold into the ordinary two-state picture.

### 4.3 The OAuth redirect/deep-link precondition delta

A browser-hosted binding's job, for a redirect-based sign-in, ends at
triggering an ordinary same-document navigation (`01-client-core-
contract.md` §8.3) — the callback returns as an ordinary page load, and the
session-establishing response header arrives through the same ambient
cookie jar as any other request.

A mobile runtime has no such ambient jar reachable from a separate browser
session, so the flow is restructured:

```
Operation:     sign-in (redirect-based, mobile variant)
Requires (ADDITIONAL to 01-client-core-contract.md §2): a system/ephemeral
               browser-session capability is available to the running
               application (a peer capability the calling application must
               have installed); the application has a registered custom
               URL scheme resolvable at construction time — construction
               ITSELF throws if no scheme can be resolved (the one
               exception to 01-client-core-contract.md §1's "construction
               never fails" invariant, and it is native-platform-specific).
Ensures:       the system/ephemeral browser session is opened against an
               intermediary endpoint (rather than the true provider
               authorization URL directly), carrying the true target
               and, where one already exists, an existing cross-site-
               request-forgery state value as a query parameter — passed
               this way specifically BECAUSE the system browser session
               cannot read the application's own stored session state
               directly. When that browser session later hands control
               back to the application through the registered URL scheme,
               the session-establishing state is extracted from the
               deep-link's own parameters (not from a response header, no
               such header-bearing response ever reaches the app process
               for this leg) and is written into secure storage (§4.1)
               before the operation's own promise settles; the refresh
               signal (01-client-core-contract.md §3) is then flipped
               exactly as any other session-mutating action would.
Invariant:     if the browser session is dismissed or cancelled rather
               than completed, the operation resolves as a silent no-op —
               no signal flip, no storage write, no error — the
               application's session state is left exactly as it was.
On violation:
  - the peer browser-session capability is not actually installed in the
    running application: 
      Raised as:      a thrown error, at the moment this specific
                       operation is invoked (not at construction).
      Blamed party:   CLIENT — a native application's own dependency/setup
                       gap.
  - no resolvable URL scheme at construction:
      Raised as:      a thrown error, at CONSTRUCTION time — the one
                       documented exception to the core contract's
                       "construction never fails" invariant (§1 above).
      Blamed party:   CLIENT — missing native application configuration.
```

A second, independent sign-in path exists for providers that hand the
application an independently, server-verifiable identity token directly
(bypassing the browser session, the custom scheme, and the cookie-jar
substitute entirely): that path carries none of the preconditions above —
it is a plain action per `01-client-core-contract.md` §2, distinguished
only by its payload shape, which is out of this document's scope. The two
paths should not be conflated: only the redirect-based path carries the
deep-link precondition described here.

---

## 5. Desktop delta — process-boundary, secure storage, and native-shell redirect handling

### 5.1 The process-boundary precondition (a restructuring of the calling convention itself)

Unlike every binding above, a desktop-shell binding's underlying transport
is only permitted to run in the application's privileged background
process, never in a rendering/UI-surface process. This is not a storage
detail — it changes who is allowed to call the base action set at all.

```
Requires (REPLACES 01-client-core-contract.md §2's implicit "call it from
          your own code" assumption, for this platform): every action —
          the entire base action set, not merely the ones documented here
          — additionally requires execution in the privileged background
          process. A call attempted from a rendering/UI-surface process
          fails synchronously and immediately, before any request is sent.
Ensures:  the privileged process instead exposes a small, explicit set of
          bridged operations (fetching the current confirmed user,
          initiating the redirect-based sign-in of §5.3, completing it,
          and signing out) to the rendering/UI-surface process through an
          inter-process channel the privileged process itself sets up and
          the rendering process's own preload layer exposes.
Invariant: the reactive session STORE (01-client-core-contract.md §5)
          exists only in the privileged process's memory. The rendering/
          UI-surface process never holds a subscribable store of its own —
          it instead receives a PUSHED, one-way notification (a sanitized
          user snapshot, not the raw store shape) each time the privileged
          process's own store settles a new observation.
On violation (a rendering-process caller attempts to invoke an action
          directly rather than through the bridged operations):
      Raised as:      a thrown error, synchronously, before any request is
                       attempted.
      Blamed party:   CLIENT — invoking an operation from a process this
                       platform's contract does not permit it from.
```

Consequence for §1–§3 above: the generic framework-binding contract
(a session-observation hook subscribing directly to the store) applies
**only within the privileged background process**. A rendering/UI-surface
layer built with any of the frameworks in §3 must instead maintain its own
local reactive state fed by the pushed notification channel described
above — it is not, and cannot be, reading the store described in
`01-client-core-contract.md` §5 directly.

### 5.2 Secure storage delta, and an asymmetry worth flagging against the mobile delta

Session/cookie persistence on this platform is encrypted using the host
operating system's own credential-encryption facility where available.

```
INVARIANT: if OS-level encryption is UNAVAILABLE, persistence for
           session-scoped storage entries (specifically: the cookie-jar
           substitute and the local session-read cache, §4.1's mobile
           analogues) degrades to IN-MEMORY-ONLY storage — such data is
           NEVER written to disk unencrypted — while any other,
           non-session-scoped storage entry degrades to storing nothing at
           all.
```

This is a STRONGER security invariant than the mobile delta's (§4.1),
which persists to the host's secure-credential store unconditionally with
no documented in-memory-only degrade path. The practical cost of this
platform's stronger invariant: session persistence across an application
restart does NOT survive when OS-level encryption happens to be
unavailable, whereas the mobile platform's persistence is not documented to
have this gap. A downstream reimplementation should choose one of these
two behaviors deliberately for its own native-storage delta, rather than
inheriting the asymmetry unexamined.

### 5.3 The OAuth redirect/deep-link precondition delta

```
Operation:     request-authentication (desktop variant)
Requires:      a registered custom URL scheme (configured at construction);
               executed from the privileged background process (§5.1).
Ensures:       opens the system's own default external browser (not an
               embedded/ephemeral session, unlike the mobile delta) against
               either a configured sign-in target or, for a specific
               named provider, an intermediary endpoint analogous to the
               mobile delta's (§4.3); a proof-of-possession value pair
               (a challenge and a verifier) is generated and the verifier
               is held ONLY in the privileged process's own memory, keyed
               by a corresponding state value — never persisted to any
               storage backend (§5.2).
Invariant:     the application registers itself as the OS-level handler
               for its own custom scheme, and additionally acquires a
               single-instance lock so that a SECOND launch of the
               application (triggered by the OS handing it the deep link)
               is redirected into the ALREADY-RUNNING instance instead of
               starting a competing one.
On violation (the privileged process was fully terminated and later
               relaunched by the operating system specifically to handle
               the deep link, rather than remaining running throughout):
      Raised as:      the completion step throws, reporting that no
                       matching verifier can be found.
      Blamed party:   ambiguous, and explicitly flagged as such: this is
                       neither purely a CLIENT defect (the application did
                       not necessarily do anything wrong; the operating
                       system is permitted to terminate background
                       processes) nor purely a SUPPLIER defect (holding
                       the verifier only in memory is a deliberate choice
                       to avoid persisting a security-sensitive value) —
                       it is a structural limitation of in-memory-only
                       proof-of-possession storage across a process
                       lifetime that a downstream reimplementation must
                       decide how to handle (e.g. by documenting it as an
                       explicit failure mode the calling application should
                       recover from by re-initiating sign-in), not
                       something either party can unilaterally fix.
```

Regardless of which OS-level mechanism actually redelivers the deep link to
the running application (a "already running, here is a second launch
attempt" notification on some platforms, a direct "handle this URL"
notification on others), both are funneled into the SAME completion
operation before either reaches the point where §5.3's contract applies —
the OS-level delivery mechanism is normalized away before it becomes
observable to the auth-state contract, and no further per-OS delta exists
beyond this point.

### 5.4 Diagram — native-shell OAuth redirect, both native deltas side by side

```
                  MOBILE (§4.3)                          DESKTOP (§5.3)
                  ─────────────                          ──────────────
  app process         system/ephemeral       app's        OS default
  (single process)    browser session      privileged      external
       │                    │              process           browser
       │  open intermediary  │                 │                │
       │  endpoint URL        │                 │  open external  │
       ├──────────────────────▶│                 ├────────────────▶│
       │                     │                 │                │
       │                     │  user completes  │                │  user completes
       │                     │  provider flow    │                │  provider flow
       │                     │                 │                │
       │  hands back via      │                 │  OS delivers    │
       │  registered scheme    │                 │  via registered │
       │◀──────────────────────┤                 │  scheme          │
       │                     │                 │◀────────────────┘
       │  extracts session      │                 │  extracts proof-
       │  state from the         │                 │  of-possession
       │  deep link's own          │                 │  verifier from
       │  parameters;                │                 │  IN-MEMORY map
       │  writes secure storage         │                 │  keyed by state
       │  (§4.1); flips refresh            │                 │  value carried
       │  signal                             │                 │  in the deep link;
       │                                        │                 │  exchanges it for
       │                                        │                 │  a session server-
       │                                        │                 │  side; pushes the
       │                                        │                 │  result to the UI
       │                                        │                 │  process (§5.1)
```

---

## 6. Summary — what a downstream reimplementation must decide consciously, not inherit silently

1. The generic hook/composable contract (§1–§2) is a single specification;
   nothing about it varies per UI framework except the returned native
   reactive primitive's own idiom.
2. Two genuine per-binding contract variances exist among the UI-framework
   bindings and must be deliberate design choices, not accidents, in a
   reimplementation: an alternate, framework-native data-fetching path that
   opts out of the store's own dedup/freshness/equality machinery (§3.2),
   and a finer-grained re-render guarantee on one binding that the others
   do not share (§3.4) — both are permitted strengthenings/alternatives
   under the Liskov rule, not violations, but only if kept as *additions*
   to, never *replacements* of, the generic contract.
3. One existing inconsistency (§3.5, a missing field on one binding) is
   flagged explicitly as inherited, not intentional — a reimplementation
   should decide to either preserve it (documented) or close it.
4. Both native-runtime deltas change what "session persistence" and
   "OAuth completion" actually *require* of the calling application — a
   supplied secure-storage backend and a resolvable custom scheme
   (mobile, §4.1/§4.3), or execution from a privileged process plus the
   same scheme requirement (desktop, §5.1/§5.3) — these are preconditions,
   not implementation notes, and belong in any reimplementation's own
   construction contract for that platform.
5. The two native platforms currently make different security/availability
   trade-offs for storage-unavailable and process-restart-during-OAuth
   edge cases (§4.1 vs §5.2, §5.3's ambiguous-blame case) — a downstream
   reimplementation should pick one considered behavior per case rather
   than inheriting both asymmetries unexamined.
