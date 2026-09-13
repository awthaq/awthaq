# Hooks and Middleware — The Canonical Hook Contract

> This is the canonical home of every hook/middleware-shaped contract in
> better-auth. Every other document in this tree that mentions a hook,
> matcher, or lifecycle callback cites this document rather than
> re-deriving its shape. Read `00-methodology/02-higher-order-contracts.md`
> first — every arrow contract below is a direct instance of the
> domain→range pattern defined there.

---

## 1. The five distinct extension points, disambiguated

better-auth offers five mechanisms that all look, at a glance, like "code
that runs around an endpoint." They are not interchangeable, they compose
in a fixed order, and only some of them apply to both invocation surfaces
from `01-http-endpoint-contract.md` §1. Confusing them is the single
easiest way to mis-specify this system, so this document names them once,
precisely, before writing any contract:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  1. onRequest / onResponse   — HTTP-surface-only request/response        │
│     (lifecycle hooks)          interceptors, once per HTTP request        │
│                                                                            │
│  2. path middleware           — HTTP-surface-only, matched by path,       │
│     (router-level)              runs before route dispatch begins         │
│                                                                            │
│  3. endpoint precondition     — declared BY an endpoint, part of that     │
│     chain ("use")               endpoint's own definition, runs on both   │
│                                  surfaces, unconditionally for that one   │
│                                  endpoint (session checks, ownership      │
│                                  checks — see 01-http-endpoint-contract   │
│                                  §3 and §8 of this document)              │
│                                                                            │
│  4. before/after hooks        — global, cross-cutting, declared          │
│     (the "hook pipeline")       independently of any one endpoint,       │
│                                  matched per-request by a predicate,      │
│                                  runs on BOTH surfaces                    │
│                                                                            │
│  5. request-scoped state      — not a hook at all: an ambient, per-      │
│     cells                       request-scoped value cells that hooks    │
│                                  and endpoint bodies read/write to pass   │
│                                  data across pipeline stages without      │
│                                  threading it through every signature     │
└─────────────────────────────────────────────────────────────────────────┘
```

§2 specifies (4), the richest contract. §3 specifies (3) as it relates to
(4). §4 specifies (1). §5 specifies (2). §6 specifies (5). §7 gives the
full assembled sequence diagram. §8 states the ordering guarantees (and
non-guarantees) that cut across all five.

---

## 2. The before/after hook pipeline

### 2.1 The matcher — a domain→range arrow

```
matcher  :  request/call context  ->  boolean
```

```
Contract:     request/call context -> boolean
Applies at:   once per registered hook, per endpoint invocation, before
              that hook's handler is considered at all
Requires:     the matcher is a pure predicate over the context it is
              handed — it may read anything the context exposes (path,
              method, body, an already-attached session from an earlier
              hook) but must not depend on anything outside that context
Ensures:      a boolean; true means this hook's handler applies to this
              call, false means it is skipped entirely for this call
On mismatch:  a matcher that throws instead of returning a boolean is
              treated as a hook-authoring defect, not a per-request
              condition
              Blamed party: SUPPLIER — the plugin (or user configuration)
              that registered this hook
              Recoverable by: the hook author fixing the predicate; the
              call is failed with an internal-error status in the
              meantime rather than silently treated as "does not match"
              (silently swallowing it would let a broken matcher quietly
              disable a security-relevant hook)
```

### 2.2 The before-hook handler — a domain→range arrow with three outcomes

```
before-hook  :  call context  ->  { continue }
                               |  { modify(context-delta) }
                               |  { halt(response) }
```

```
Contract:     call context -> { continue } | { modify(delta) } | { halt(response) }
Applies at:   for every registered before-hook whose matcher (§2.1)
              returned true for this call, in the order fixed by §8,
              strictly before the endpoint's own precondition chain and
              handler body run
Requires:     the handler may read the call context (including anything
              an earlier before-hook's { modify } already merged in) and
              may perform its own effects (issue/clear cookies, read the
              database) before deciding its outcome
Ensures:      exactly one of the three outcomes below
On mismatch:  an outcome that is none of the three recognized shapes is
              treated as { continue } with no modification — the return
              value is only meaningful when it is one of the recognized
              shapes
              Blamed party: n/a for an unrecognized shape (defined as a
              no-op, not a violation); see §2.4 for genuine failures
```

The three outcomes, precisely:

```
┌───────────────────────────────────────────────────────────────────────┐
│                    BEFORE-HOOK OUTCOME SEMANTICS                       │
│                                                                          │
│  { continue }                                                           │
│     No change. The next matching before-hook runs against the same     │
│     context this hook received.                                        │
│                                                                          │
│  { modify(context-delta) }                                              │
│     The delta is merged into the call context for every subsequent     │
│     before-hook, the endpoint's own precondition chain, and the         │
│     handler body. Any response headers the hook already set (e.g. a     │
│     cookie) are captured separately and always survive, even though     │
│     the rest of the delta is merged as data. The pipeline CONTINUES —   │
│     modify is not a way to stop the pipeline.                          │
│                                                                          │
│  { halt(response) }                                                     │
│     The pipeline stops immediately. No further before-hooks run, the   │
│     endpoint's precondition chain and handler body never run, and       │
│     — critically — the after-hook stage (§2.3) never runs either.      │
│     The halted value becomes the call's entire result, carrying         │
│     forward only the response headers accumulated so far.               │
└───────────────────────────────────────────────────────────────────────┘
```

```
Invariant:  a before-hook that halts pre-empts everything downstream of
            it in THIS call, including after-hooks — after-hooks are a
            property of "the handler ran," and a halted call never
            reaches the handler
```

This is the mechanism by which a cross-cutting policy (a global
maintenance-mode gate, a request-shape guard a plugin wants applied to
every endpoint, not just its own) can veto any endpoint without that
endpoint knowing the policy exists — precisely the class of behavior
Findler & Felleisen's arrow contracts exist to describe: the pipeline
cannot know in advance whether a given hook will halt; it can only wrap
every call in the check and discover the outcome lazily, per invocation.

### 2.3 The after-hook handler — asymmetric with before-hooks

```
after-hook  :  call context (endpoint has already produced a result)
                  ->  { continue }  |  { replace(response) }
```

```
Contract:     call context (with the handler's result already attached)
              -> { continue } | { replace(response) }
Applies at:   for every registered after-hook whose matcher returned true,
              in the order fixed by §8, strictly after the endpoint's
              handler body has produced a result — but note that a
              handler body that itself produced a fully-formed response
              (01-http-endpoint-contract.md §4, form (b)) skips the
              after-hook stage entirely, the same way a halted before-hook
              does
Requires:     the handler may read the endpoint's result and the
              accumulated response headers; if the handler's own
              invocation raises a recognized error value instead of
              returning normally, that error is treated as if the hook
              had returned { replace(that error) } — an after-hook can
              turn a success into a failure this way, but cannot turn an
              unrecognized exception into anything except an internal
              failure (05-error-model-and-blame.md)
Ensures:      exactly one of the two outcomes below
```

```
┌───────────────────────────────────────────────────────────────────────┐
│              AFTER-HOOK OUTCOME SEMANTICS — THE KEY ASYMMETRY           │
│                                                                          │
│  { continue }                                                           │
│     The result in flight is left untouched for the next after-hook.    │
│                                                                          │
│  { replace(response) }                                                  │
│     The result in flight is replaced. Response headers this hook set   │
│     are merged onto the accumulated set. UNLIKE a before-hook's halt,  │
│     replacing the result does NOT stop the loop: every remaining        │
│     after-hook still runs, in order, each seeing whatever the most      │
│     recent replacement left in flight. The FINAL value after every      │
│     after-hook has run is what the call actually returns.               │
└───────────────────────────────────────────────────────────────────────┘
```

```
Invariant:  after-hooks always run to completion once the handler has
            produced a result — there is no "halt" concept at this stage,
            only "replace and keep going." A later after-hook can
            observe, and further replace, an earlier after-hook's
            replacement.
```

This asymmetry — before-hooks can short-circuit the remaining pipeline,
after-hooks cannot — is deliberate and load-bearing: a before-hook is
gating *whether the operation happens at all*; an after-hook is
*reacting to an operation that already happened*, and every registered
reactor is owed the chance to react, even if an earlier reactor already
decided to change the outcome (e.g., a second-factor policy rejecting a
credential sign-in that an earlier hook had already begun to approve must
still be able to downgrade a successful sign-in into a challenge,
regardless of what any other after-hook already did).

### 2.4 Header accumulation — the invariant that survives every outcome

```
Invariant (holds across the entire before/after pipeline, regardless of
which outcome any individual hook produces):

  - a "set a cookie" instruction, once issued by ANY hook or the handler
    body, accumulates onto the response — multiple cookies from
    different hooks are ALL preserved, never overwritten by each other
  - every other response header follows last-write-wins: the most
    recent hook (or the handler) to set a given header name is the value
    that survives
```

```
On violation:   n/a — this is a pipeline-level guarantee, not something a
                hook author can violate from inside a single hook; a
                pipeline implementation that drops an earlier hook's
                cookie when a later hook sets an unrelated header would
                itself be the SUPPLIER defect, not any hook's fault
```

---

## 3. How the endpoint precondition chain (§1 mechanism 3) relates to hooks

An endpoint's own precondition chain (session checks, ownership checks —
`01-http-endpoint-contract.md` §3) is **not** part of the global
before/after hook pipeline. It is private to that one endpoint's
definition and always runs, unconditionally, for every call to that
endpoint — there is no matcher, because there is nothing to match against
beyond "this endpoint was called." Ordering between the two mechanisms is
fixed:

```
global before-hooks (matched)  ─▶  endpoint's own precondition chain  ─▶  handler body  ─▶  global after-hooks (matched)
```

A global before-hook therefore runs *before* the target endpoint has even
checked whether the caller has a session — a before-hook that needs a
session itself must resolve one independently rather than assume the
target endpoint has already done so. This is a precondition on hook
authors, not an automatic guarantee:

```
Operation:      a before-hook depends on the caller's session
Requires:       the hook resolves the session itself (the same resolution
                step an endpoint's own precondition chain would use) —
                it must not assume the target endpoint's own chain has
                already run, because it has not, yet
On violation:   a hook that reads a session field without resolving it
                first observes an absent value, not a stale or wrong one
                — there is no silent fallback to "whatever the endpoint
                would have resolved later"
                Blamed party: SUPPLIER — the hook author, for an
                incorrect assumption about pipeline ordering
```

---

## 4. `onRequest` / `onResponse` — router-level lifecycle hooks

These apply **only** on the HTTP surface (`01-http-endpoint-contract.md`
§1, Surface A). They run once per HTTP request, outside of and prior to
any endpoint-specific pipeline, and their two directions compose
**differently from each other** — this asymmetry is easy to miss and is
stated explicitly here because a reimplementation that assumes symmetry
will be wrong.

```
onRequest  :  (incoming request, shared context)
                 ->  { pass-through }
                 |   { replace(request) }
                 |   { respond(response) }
```

```
Contract:     incoming request -> pass-through | replace(request) | respond(response)
Applies at:   once per configured request-lifecycle contributor, in
              registration order, after the rate limiter (§ see
              04-rate-limiting.md) has already run and BEFORE route
              matching, path middleware, or any endpoint pipeline begins
Ensures:      { pass-through } or { replace(request) } both allow the
              chain to continue to the next contributor, with the request
              each subsequent contributor sees being whichever replacement
              is currently in flight (this direction CHAINS — every
              contributor sees the cumulative effect of every earlier
              one); { respond(response) } stops the chain immediately and
              that response is returned as the entire result of the HTTP
              call — no later onRequest contributor runs, and neither does
              route matching, path middleware, the hook pipeline, or the
              endpoint
Invariant:    request replacement is cumulative and ordered; a
              short-circuit response is terminal
```

```
onResponse  :  (outgoing response, shared context)
                 ->  { pass-through }  |  { replace(response) }
```

```
Contract:     outgoing response -> pass-through | replace(response)
Applies at:   once the endpoint pipeline (route match through after-hooks)
              has produced a response, in registration order — but see
              the invariant below
Invariant:    UNLIKE onRequest, this direction does NOT chain across
              multiple contributors. The FIRST configured contributor
              that produces { replace(response) } wins outright: its
              replacement becomes the final response, and every
              remaining contributor in registration order is skipped
              entirely — it never even sees the response, let alone the
              first contributor's replacement of it. A contributor late
              in registration order can only ever act if every
              contributor before it passed through.
On violation: n/a — this asymmetry (onRequest chains, onResponse does
              not) is a documented, deliberate property of this pipeline,
              not a defect; a plugin author relying on "my onResponse
              will see what an earlier plugin's onResponse already did"
              has made an incorrect assumption
              Blamed party (for that incorrect assumption): SUPPLIER —
              the plugin author
```

```
┌──────────────────────────────────────────────────────────────────────┐
│         onRequest CHAINS, onResponse DOES NOT — SIDE BY SIDE           │
│                                                                        │
│   onRequest:  P1 ──▶ P2 ──▶ P3 ──▶ (route match / pipeline / handler) │
│               each Pn sees the request as shaped by P1..P(n-1)         │
│               any Pn may short-circuit straight to a response          │
│                                                                        │
│   onResponse: (handler result) ──▶ P1 ──▶ P2 ──▶ P3 ──▶ caller         │
│               if P1 replaces the response, P2 and P3 NEVER RUN         │
│               only if P1 passes through does P2 even get a turn        │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 5. Path middleware — router-level, path-matched

A path middleware is contributed with a path pattern and a handler; it
runs once route matching has selected a matching path, before the
endpoint pipeline for that path begins. A single fixed, always-present
path middleware validates the request's origin and CSRF posture for
every path (`03-cookies-and-csrf.md` §3) and runs first; any
plugin-contributed path middleware for a more specific pattern runs after
it, in registration order.

```
path-middleware  :  (call context, matched by path)  ->  { pass-through } | { halt(response) }
```

```
Contract:     call context -> pass-through | halt(response)
Applies at:   HTTP surface only, after route matching, before the target
              endpoint's before-hooks
On violation: a path middleware that halts behaves exactly like a halted
              before-hook (§2.2) with respect to everything downstream —
              the endpoint's precondition chain, handler, and after-hooks
              never run for this call
              Blamed party: depends entirely on which precondition the
              middleware is enforcing — see 05-error-model-and-blame.md
              for the origin/CSRF instance specifically
```

---

## 6. Request-scoped state cells

Distinct from every hook shape above: a **state cell** is a small, typed,
per-request value with a default, readable and writable from anywhere in
the dynamic extent of one top-level call — a before-hook can leave a
value for the handler body to pick up, or the handler can leave a value
for an after-hook, without threading it through every intermediate
signature.

```
state-cell  :  ( )  ->  T                          [lazy default]
   get  :  ( )  ->  T
   set  :  T  ->  ( )
```

```
Contract:     a cell is defined once with a default-producing thunk;
              get() and set(value) act against whichever call's dynamic
              extent they are invoked from
Requires:     get()/set() are only meaningful when invoked from within
              the dynamic extent of a top-level call — invoking one
              outside any call is a defect in the calling code, not a
              per-request condition
Ensures:      the first get() within a given call's extent evaluates the
              default thunk exactly once and remembers the result for
              the rest of that call's extent; every subsequent get() (or
              a prior set()) is what is returned thereafter, for that
              call only
Invariant:    a state cell's value in one top-level call is never visible
              to, and never interferes with, a concurrent, unrelated
              top-level call — cells are isolated per call, not global
              mutable state
              A call that itself triggers a NESTED call to another
              capability from inside a hook or handler body (a
              plugin resuming a multi-step flow by re-invoking another
              endpoint through the supported re-entry mechanism, rather
              than calling its handler body directly) shares the SAME
              cell values as the outer call — nested calls do not get a
              fresh, isolated set of cells; only a genuinely new
              top-level call does
On violation:   invoking get()/set() with no enclosing call is raised as
                an internal failure
                Blamed party: SUPPLIER — the calling code failed to
                establish a call context first
```

This is the mechanism used, for example, to let a plugin attach
server-trusted data to a multi-step flow that survives a round trip
through an external redirect, and to let one part of the pipeline tell a
later part "skip the refresh you would otherwise perform" — both are
cross-cutting, ambient facts about *this one call*, not data that belongs
in the persistent session or user record.

---

## 7. The full assembled sequence (HTTP surface)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Client                Router-level                 Endpoint pipeline     │
│    │                                                                       │
│    │  HTTP request                                                        │
│    ├──────────────────▶│                                                  │
│    │                    │ 1. disabled-path check (404 if disabled)        │
│    │                    │ 2. pending schema check (awaited if any)        │
│    │                    │ 3. rate limiter — see 04-rate-limiting.md       │
│    │                    │    ✗ over limit ──▶ 429, pipeline never reached │
│    │                    │ 4. onRequest chain (§4) — may replace request   │
│    │                    │    or short-circuit to a response               │
│    │                    │ 5. route match                                  │
│    │                    │ 6. origin/CSRF path middleware (§5,             │
│    │                    │    03-cookies-and-csrf.md)                      │
│    │                    │ 7. plugin path middleware(s), registration order│
│    │                    │        │                                        │
│    │                    │        ▼                                        │
│    │                    │  ┌─────────────────────────────────────────┐   │
│    │                    │  │ 8. global before-hooks (user, then       │   │
│    │                    │  │    plugins) — §2.2; may halt here        │   │
│    │                    │  │ 9. endpoint's own precondition chain     │   │
│    │                    │  │    (session/ownership/freshness) — §3    │   │
│    │                    │  │ 10. handler body — may call the adapter  │   │
│    │                    │  │ 11. global after-hooks (user, then       │   │
│    │                    │  │     plugins) — §2.3; all run, may replace│   │
│    │                    │  └─────────────────────────────────────────┘   │
│    │                    │ 12. onResponse chain (§4) — first replace wins  │
│    │◀───────────────────┤                                                 │
│    │  HTTP response     │                                                 │
└──────────────────────────────────────────────────────────────────────────┘
```

For the in-process surface (Surface B), only stages 8–11 apply — stages
1–7 and 12 belong exclusively to the HTTP router (see
`01-http-endpoint-contract.md` §1). A plugin that needs a request-lifecycle
guarantee for in-process calls too must express it as a before/after hook,
not as `onRequest`/`onResponse` or path middleware.

---

## 8. Ordering guarantees — and the explicit absence of others

```
GUARANTEED:
  - user-configured before-hooks run before plugin-configured before-hooks
  - user-configured after-hooks run before plugin-configured after-hooks
  - among plugin-configured hooks of the same kind (before, after,
    onRequest, path middleware), execution order follows the order the
    plugins themselves were registered in — a deterministic, but
    deployer-controlled, order
  - the fixed origin/CSRF path middleware always runs before any
    plugin-contributed path middleware, for every path
  - within one endpoint invocation: before-hooks always precede the
    endpoint's own precondition chain, which always precedes the handler
    body, which always precedes after-hooks

NOT GUARANTEED — an explicit absence, not an oversight:
  - there is no priority, weight, or "run first/last" declaration a
    plugin can attach to an individual hook; the ONLY lever a plugin has
    over its position relative to another plugin's hook of the same kind
    is where it sits in the registration order
  - a hook must not assume it runs before or after a SPECIFIC other
    plugin's hook unless that ordering is guaranteed by registration
    order in this deployment's own configuration — portable plugin code
    cannot assume a particular other plugin is even present
  - onResponse contributors additionally cannot assume they will be
    reached at all (§4) — a plugin that must unconditionally observe
    every response should use an after-hook, not onResponse
```

This absence is itself part of the contract, per
`00-methodology/03-theory-of-contracts-and-blame.md` §4: if two plugins'
hooks interact incompatibly because one silently assumed an ordering
this document does not guarantee, the blame lands on the hook that made
the unwarranted assumption — "first cause," not "first observer."
