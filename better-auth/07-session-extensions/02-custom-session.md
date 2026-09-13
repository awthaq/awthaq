# Custom-Session Extension

> Extends: `01-core-domain/02-session-lifecycle.md` (the base session
> contract), specifically its session-retrieval operation (what this tree
> elsewhere calls "get current session").
> Read `00-methodology/01`, `02` (higher-order/arrow contracts), and `03`
> before this document.

## 1. What is being extended

The base session-retrieval operation, informally:

```
Operation:  get-current-session
Requires:   a session-carrier (cookie or, per 03-bearer-and-jwt.md, an
            equivalent bearer credential) is present.
Ensures:    IF the carrier resolves to a live, unexpired, unrevoked session
              record:
                the response conveys {user, session} for that record, AND
                any side-effecting cookie maintenance the base contract
                performs on read (rolling-expiry refresh, cookie-cache
                repopulation, etc.) has already been applied to the outgoing
                response.
            ELSE:
                the response conveys "no session" (null), with no side
                effects that could be mistaken for a valid one.
```

Custom-session does not touch *how* that determination is made. It
intercepts only the **shape of the value returned to the client** once the
determination has already been made, by requiring the developer to supply a
transform function:

```
fn : (session: {user, session}, ctx) -> Promise<Returns>
```

This is exactly the arrow-contract shape from methodology doc 02 §2 — a
domain contract on the input, a range contract on the output — instantiated
at exactly one point in the pipeline: **after** the base contract has
already produced a valid `{user, session}` pair, and **before** that pair is
serialized to the client.

```
        base get-current-session                custom-session's fn
   ┌────────────────────────────────┐    ┌───────────────────────────────┐
   │ REQUIRE: carrier present        │    │ REQUIRE: nothing beyond what  │
   │ ENSURE:  {user, session} valid, │───▶│   the base contract already   │
   │   OR null, cookie side-effects  │    │   guarantees about its input  │
   │   already applied               │    │ ENSURE: some Returns value,   │
   └────────────────────────────────┘    │   developer-defined shape     │
                                          └───────────────────────────────┘
```

## 2. Configuration

| Option | Default | Effect |
|---|---|---|
| `shouldMutateListDeviceSessionsEndpoint` | `false` | When `true`, the SAME `fn` is additionally applied, per-item, to `multi-session`'s `listDeviceSessions` output (see §5). When absent/`false`, custom-session touches only `get-current-session` and leaves the multi-session extension's own contract completely alone. |

## 3. The delegation invariant (why this is safe)

The defining property of this extension — and the reason it is safe to grant
a developer-supplied function this much latitude over the response shape —
is that **it never reimplements session validity**. Concretely:

```
Operation:     custom-session's /get-session endpoint
Requires:      (identical to the base operation's precondition — this
               extension does not add or relax any requirement on the
               incoming request)
Ensures:       1. the REAL base get-current-session operation is invoked
                  in full (not re-implemented) — including whatever cookie
                  rotation/refresh side effects it performs;
               2. IF the base call yields "no session":
                    the response is `null`; fn is NEVER invoked.
               3. IF the base call yields a valid {user, session}:
                    every Set-Cookie the base call attached to ITS response
                    is copied onto THIS response, individually — never
                    concatenated/merged into a single header value — so
                    that per-cookie attributes (e.g. distinct Max-Age
                    between a session-token cookie and a session-data
                    cache cookie) survive intact;
                    every other header the base call set is likewise
                    copied onto this response;
                    THEN fn(session, ctx) is invoked and ITS return value,
                    not the base {user, session} pair, is what is finally
                    serialized to the client.
Invariant:     the validity determination itself — expiry, revocation,
               rolling refresh — is made exactly once, by the base
               contract's own canonical implementation, on every call. This
               extension is strictly a post-validation transform; it has no
               code path that can declare a session valid on its own
               authority.
On violation:  a hypothetical implementation of this extension pattern that
               reimplemented validity checking instead of delegating would
               risk validity drift (e.g. forgetting a revocation check the
               base contract enforces) — that would be a SUPPLIER defect
               (the plugin, not its caller, narrowed the base postcondition
               by omission). The shipped implementation avoids this
               entirely by construction; this note exists so that an
               Effect-native reimplementation preserves the same
               "delegate, never duplicate" discipline.
```

```
SEQUENCE: GET /get-session (custom-session installed)
──────────────────────────────────────────────────────
  client         custom-session endpoint      base get-current-session op
    │  GET /get-session                              │
    ├─────────────────▶│                              │
    │                    │  invoke base op, in full     │
    │                    │  (returnHeaders: true)       │
    │                    ├─────────────────────────────▶│
    │                    │                              │  validity check,
    │                    │                              │  rolling refresh,
    │                    │                              │  Set-Cookie(s)
    │                    │◀─────────────────────────────┤
    │             ┌──────┴──────┐
    │        no session?    valid {user,session}?
    │             │                    │
    │        return null          copy EACH Set-Cookie header
    │        (fn NEVER called)    individually onto this response;
    │                             copy other headers;
    │                             THEN: fn(session, ctx) → Returns
    │◀── 200 null ──────┤                    │
    │◀── 200 Returns ───┴────────────────────┘
```

## 4. What custom-session is licensed to change vs. what it is not

This is the point at which the Liskov extension rule (doc 01 §5) needs
careful reading, because on the surface `fn` can appear to **narrow** the
base postcondition: a developer's `fn` may return a value that omits `user`
and `session` entirely (confirmed by this plugin's own type-inference
tests — the client-side inferred `Session` type contains only whatever
`fn` actually returns, with `user`/`session` absent from the type when `fn`
does not include them). Whether this is a narrowing depends on which
postcondition is being asked about:

* **The postcondition custom-session must not narrow**: "a request carrying
  a valid credential results in the base contract's validity/refresh
  machinery running, with its side effects (cookie rotation, etc.) applied
  to the response." This is preserved unconditionally — §3 shows it is
  structurally impossible to reach `fn` without it.
* **The postcondition custom-session IS licensed to replace**: "the JSON
  body handed to the client is a `{user, session}` tuple in the base
  contract's own shape." This was never a promise about the *wire
  representation* being fixed — it is a promise about *validity having been
  established*. Custom-session's whole reason to exist is to let a
  developer substitute their own wire representation once validity is
  established. Precondition-wise, `fn`'s domain contract (what it may
  assume about its input) is trivially satisfiable — it receives exactly
  the `{user, session}` the base contract already guarantees, nothing less
  — so the "weaken-or-keep-identical precondition" half of the Liskov rule
  holds vacuously. Postcondition-wise, the ENDPOINT's contract is
  strengthened, not narrowed: it now additionally guarantees "the response
  matches whatever shape the deployer's own `fn` contract promises" on top
  of "validity was checked" — the base guarantee is a strict subset of what
  a caller can rely on afterward (it can still be recovered by inspecting
  `ctx.context.session` server-side, e.g. inside `fn` itself, even when the
  client-visible JSON omits it).

```
Base contract's postcondition:      Q  =  "valid credential ⟹ side effects
                                            applied ∧ {user,session} shape"
custom-session's endpoint contract: Q' =  "valid credential ⟹ side effects
                                            applied (UNCHANGED) ∧
                                            response = fn({user,session})"

Q' does not imply the wire-shape half of Q when fn omits user/session —
but Q's SAFETY-RELEVANT half (side effects applied, validity actually
checked) is preserved without exception. The wire-shape half of Q was
never a safety property; it is exactly the part of the contract this
extension exists to make configurable, and the developer supplying `fn` —
not the plugin — owns responsibility for that substitution being fit for
their client's purpose.
```

Blame framing: if a deployer's `fn` accidentally drops information a
DIFFERENT part of their own application needed from `get-session`, that is
a CLIENT-side (application author) contract error in how they defined `fn`
— not a defect in custom-session, which faithfully applies exactly the
function it was given.

## 5. Composition with multi-session (`shouldMutateListDeviceSessionsEndpoint`)

```
Operation:     list-device-sessions mutation (after-hook, matches
               "/multi-session/list-device-sessions" AND the option is true)
Requires:      multi-session's own listDeviceSessions operation has already
               produced its array response (see 01-multi-session.md §4.2) —
               this hook reads that response, it does not compute one.
Ensures:       every {session, user} element of that array is individually
               passed through the SAME fn used for get-current-session, and
               the array of fn's results replaces the original array.
Invariant:     with the option left at its default (false), multi-session's
               own documented contract (01-multi-session.md §4.2) is
               completely unaffected by custom-session's presence — this is
               an important non-interference guarantee: installing
               custom-session must not silently change a DIFFERENT
               extension's endpoint contract unless the developer opts in
               explicitly, per plugin.
On violation:  n/a — this is an opt-in composition point, not a fallible
               operation. If `fn` throws for one element, that failure
               propagates exactly as it would for a single get-session call
               (custom-session applies no extra error-swallowing here);
               blame follows fn's own defect, i.e. CLIENT (application
               author), same as §4.
```

This is a second instance of the same higher-order pattern from doc 02 §3
(staged/dependent contracts): custom-session's `fn` is a single arrow
contract, `(session,user) -> Returns`, that this extension is willing to
mount at more than one point in the pipeline (get-session; optionally,
per-item, list-device-sessions) without ever changing the arrow's own
domain/range contract — only where it is applied changes.

## 6. Failure and edge-case behavior

```
Operation:     get-current-session, no valid credential
Requires:      (none beyond a well-formed request)
Ensures:       the base call's rejection/absence is caught and normalized to
               `null` at the custom-session endpoint boundary — including
               the case where the base call THROWS (e.g. a malformed
               carrier) rather than returning a clean "no session" value.
               fn is never invoked in this branch.
Invariant:     a thrown error from the base session lookup can never
               surface as a 5xx from custom-session's endpoint on account of
               that lookup failure alone — it degrades to the same "no
               session" response an ordinary unauthenticated caller would
               see.
On violation:  n/a by construction; if `fn` itself throws (a developer
               bug), that exception is NOT caught by this fallback — it
               propagates as an ordinary handler error. Blame: CLIENT
               (application author), for a defect in code they supplied,
               distinct from the base lookup's own failure modes.
```

Additional, narrower behavioral guarantees confirmed for this extension
(each stated because it was a previously-reported defect this contract
must not regress to):

* **Cookie-header integrity**: every `Set-Cookie` the base call produced is
  forwarded as its OWN header entry — never comma-joined with another. A
  comma-joined header would let one cookie's attributes (e.g. a short
  cookie-cache `Max-Age`) bleed into another's (the session token), which
  would be a silent WEAKENING of the base contract's rolling-session
  lifetime — this extension must preserve header-per-cookie fidelity
  exactly, and its correctness on this point is a precondition for every
  other guarantee in this document (a merged header would corrupt the very
  thing §3 says is delegated intact).
* **No double-encoding of the session token** across a refresh performed
  during the same call this extension mediates — the token value round-trips
  byte-for-byte through the custom-session layer.
* **Cookie attribute forwarding is exhaustive**, not allowlisted — e.g. a
  `partitioned` attribute set via advanced cookie configuration on the base
  contract must still be present after passing through custom-session's
  header-copy step.

## 7. Liskov compliance check

```
Base:            REQUIRE P (carrier present)   ENSURE Q (validity+shape+side-effects)
custom-session:  REQUIRE P  (unchanged)
                 ENSURE  Q_safety ∧ Q'   where
                   Q_safety = the side-effect/validity half of Q (UNCHANGED, never narrowed)
                   Q'       = "response = fn(the {user,session} Q_safety established)"
```

* Precondition: unchanged — custom-session adds no new requirement a caller
  must satisfy to reach a successful response.
* Postcondition: the safety-relevant half (validity was actually checked;
  side effects were actually applied) is preserved without exception — this
  is the half a base-contract CLIENT could have relied on for correctness
  or security, and it is never weakened. The wire-shape half is explicitly,
  by design, replaced with a developer-supplied contract (`fn`'s own range
  contract) — this is licensed because the base contract's promise about
  wire shape was never a cross-cutting invariant another part of the system
  depends on (unlike, say, "a session token is unique," which no extension
  in this tree is permitted to touch).
* Invariant preserved: the underlying session record, and any other
  plugin's ability to read it via `ctx.context.session`/`newSession`
  server-side, is completely unaffected by what `fn` chooses to expose to
  the client — custom-session mutates only the outbound wire payload, never
  the session entity itself.
