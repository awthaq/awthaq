# Rate Limiting

> Reads against `02-hooks-and-middleware.md` §7 (rate limiting is the
> first HTTP-surface stage, running before `onRequest`) and conceptually
> cross-references `01-core-domain/04-database-adapter-contract.md` for
> the database-backed storage variant without restating that contract.

---

## 1. Scope: HTTP surface only, evaluated once per request

Rate limiting is enforced entirely at the router boundary, before route
matching, before any `onRequest` contributor, before the hook pipeline,
and before any endpoint's own precondition chain
(`02-hooks-and-middleware.md` §7). It therefore shares the same surface
restriction as origin/CSRF checking: an in-process call from trusted
server code (`01-http-endpoint-contract.md` §1, Surface B) is never
rate-limited by this mechanism, because it never passes through the
router at all.

```
Operation:      decide whether an incoming HTTP request may proceed
Requires:       (no precondition on the caller beyond having made an
                HTTP request — this check applies uniformly, including
                to requests that will go on to fail every other
                precondition in the pipeline)
Ensures:        the decision and any resulting count update happen as
                ONE atomic step — there is no window between "check
                whether this request is allowed" and "record that it was
                allowed" during which a concurrent, simultaneous request
                for the same key could also be checked against the
                stale, not-yet-updated count
Invariant:      at most the configured maximum number of requests for a
                given key are ever counted as allowed within any single
                rolling window, even under a burst of exactly-concurrent
                requests for that same key
On violation:   see §3
```

The atomicity requirement above is the single most important property of
this contract and is stated independently of any storage backend — §5
specifies it as the one operation every backend must provide.

---

## 2. Key derivation

```
Operation:      derive the rate-limit key for a request
Ensures:        a key that combines (a) a client identity derived from
                the request, and (b) the normalized path being requested
                — so the same client is tracked separately per path, and
                the same path is tracked separately per client
Invariant:      key derivation is deterministic: the same request,
                evaluated twice, produces the same key
```

### 2.1 Client identity — fail-closed, not fail-open

```
┌──────────────────────────────────────────────────────────────────────┐
│              CLIENT IDENTITY RESOLUTION — FAIL-CLOSED POSTURE          │
│                                                                          │
│  can a trusted client address be derived from this request,            │
│  given this deployment's configured trust rules for proxy/forwarding   │
│  headers?                                                               │
│      │ yes ──▶ key on that address (per-address bucket)                │
│      │ no                                                                │
│      ▼                                                                  │
│  has this deployment explicitly opted OUT of address-based tracking    │
│  entirely?                                                              │
│      │ yes ──▶ rate limiting is SKIPPED for this request (an explicit, │
│      │         deliberate deployer opt-out, not a fallback)            │
│      │ no                                                                │
│      ▼                                                                  │
│  key on a single SHARED bucket (a sentinel identity that can never     │
│  collide with a real address), so every such request — regardless of   │
│  its real, unresolvable origin — competes for the SAME limit           │
└──────────────────────────────────────────────────────────────────────┘
```

```
Operation:      resolve client identity when it cannot be derived and the
                deployer has not opted out of tracking
Ensures:        every request in this situation is keyed to the same
                shared bucket, so the group as a whole is still bounded
                by the configured limit, rather than each such request
                being treated as an independent, unlimited caller
Invariant:      this fail-closed choice cannot be defeated by a caller
                simply omitting the signal this deployment uses to
                derive identity — omitting it does not exempt the
                request from rate limiting, it merely places the request
                into the shared, most-restrictive bucket
On violation:   n/a — this is the designed behavior for an
                unresolvable identity, not an error condition
                Blamed party: SUPPLIER (the deployer) if client identity
                is routinely unresolvable in a way that makes the shared
                bucket too restrictive for legitimate traffic — the fix
                is a deployment-level configuration change (trusting the
                right proxy/forwarding signal), not a per-request
                accommodation
```

---

## 3. The postcondition on exceeding the limit

```
Operation:      a request's key has already reached the configured
                maximum within the current window
Ensures:        the request is refused before it reaches route matching
                — it never reaches the hook pipeline, any endpoint
                precondition chain, or any handler body
Invariant:      the refusal carries a hint at how long the caller should
                wait before retrying: the number of seconds until the
                current window frees up
On violation:   raised as too-many-requests (429-class)
                Blamed party: CLIENT — this request (or a prior request
                that shares this request's key) exhausted the shared
                allowance
                Recoverable by: waiting the hinted number of seconds
                (or, if no hint could be computed, the full configured
                window length) before retrying with the same key; note
                that when the key resolves to the shared fail-closed
                bucket (§2.1), the blame is diffuse — some other caller
                sharing that bucket may be the one who actually exhausted
                it, but the observable contract is identical from the
                refused caller's point of view
```

```
┌───────────────────────────────────────────────────────────────┐
│                 ROLLING WINDOW STATE (per key)                  │
│                                                                   │
│        ┌─────────┐  first request for   ┌──────────┐            │
│   ─────▶  empty   │──  this key ────────▶│ counting  │           │
│        └─────────┘   (opens a window)    └────┬─────┘           │
│                                                 │                 │
│                          under max, within window │ allow +      │
│                          ◀──────────────────────┘ increment      │
│                                                 │                 │
│                          at max, still within window │            │
│                                                 ▼                 │
│                                          ┌───────────┐            │
│                                          │ exceeded   │──▶ refuse │
│                                          └─────┬─────┘   (429)   │
│                                                 │                 │
│                          window elapses (regardless of whether    │
│                          it was "counting" or "exceeded")          │
│                                                 ▼                 │
│                                          ┌─────────┐              │
│                                          │  reset   │──▶ back to   │
│                                          └─────────┘   "counting"  │
│                                                         at count 1  │
└───────────────────────────────────────────────────────────────┘
```

A window's elapsing is defined relative to the time of the last request
counted against it, not a fixed wall-clock boundary — this is a *rolling*
window, not a fixed bucket that resets at, say, the top of every minute.

---

## 4. Per-path override — a higher-order, staged contract

The window and maximum applied to a given request are not fixed
globally. They are decided by a **layered override chain**, where each
layer is an arrow contract of the same shape, and a later layer's
decision (when it applies) replaces an earlier layer's:

```
path-rule  :  path  ->  boolean               [the matcher half]
             (window, max)                    [the rule half, only
                                                consulted when the
                                                matcher returns true]
```

```
┌────────────────────────────────────────────────────────────────────────┐
│              OVERRIDE CHAIN (each stage may replace the prior)          │
│                                                                           │
│  1. deployment-wide default rule                                        │
│         (window, max) — applies to every path with no more specific     │
│         rule                                                            │
│              │                                                          │
│              ▼                                                          │
│  2. built-in sensitive-path rules                                       │
│         a small, fixed set of path-matcher → (window, max) rules        │
│         this system applies out of the box to its own                  │
│         highest-abuse-risk paths (credential sign-in/sign-up, password  │
│         and email changes get one tighter rule; password-reset and      │
│         verification-email dispatch get a second, separately-tuned      │
│         rule) — the first matching built-in rule, if any, replaces      │
│         stage 1's result                                                │
│              │                                                          │
│              ▼                                                          │
│  3. plugin-contributed rules                                            │
│         each plugin may contribute its own ordered list of              │
│         path-matcher → (window, max) rules; the first matching rule,    │
│         considered across all plugins in registration order, replaces  │
│         whatever stage 1-2 had decided so far                          │
│              │                                                          │
│              ▼                                                          │
│  4. deployer custom rules — a DEPENDENT/staged final override           │
│         keyed by exact path or a path pattern; each entry is either a   │
│         fixed (window, max), an instruction to DISABLE rate limiting    │
│         entirely for that path, or a function whose domain includes     │
│         the rule stages 1-3 already produced and whose range is a new   │
│         (window, max), a disable instruction, or "no opinion" (in       │
│         which case stages 1-3's result stands unchanged)               │
└────────────────────────────────────────────────────────────────────────┘
```

```
Contract:     stage 4's function: (request, rule-so-far) -> (window, max)
                                    | disable | no-opinion
Applies at:   once per request, only when the request's path matches this
              stage's own key, after stages 1-3 have already produced a
              candidate rule
Requires:     the function may read the request and the candidate rule
              produced by every earlier stage, but must not assume any
              particular earlier stage actually fired (stage 1's
              deployment-wide default is the only one guaranteed to have
              produced something)
Ensures:      exactly one of: a replacement rule, a disable instruction,
              or "no opinion" (leave the incoming candidate as-is)
On mismatch:  a deployer rule that names a path pattern which also
              matches an unrelated, more specific path than intended is a
              SUPPLIER-side (deployer) configuration defect — the
              resulting over- or under-restriction is not any individual
              caller's fault
              Blamed party: SUPPLIER — the deployer's own configuration
```

This is a direct instance of the staged/dependent contract pattern from
`00-methodology/02-higher-order-contracts.md` §3: each stage's domain
legitimately includes what the previous stage actually, observably
produced, and stage 4 is explicitly permitted to depend on it.

---

## 5. Storage-backend independence

The entire contract a rate-limit storage backend must satisfy is a single
operation:

```
consume  :  (key, rule{window, max})  ->  { allowed, retryAfter }
```

```
Contract:     (key, rule) -> { allowed: boolean, retryAfter: seconds|none }
Applies at:   once per rate-limited request, after key derivation (§2)
              and rule resolution (§4) have both completed
Requires:     `rule.window` is a positive duration; `rule.max` is a
              non-negative integer
Ensures:      the check-and-increment described in §1 happens as one
              atomic step with respect to every other concurrent call to
              this same operation for the same key — this is the ENTIRE
              obligation a storage backend owes; everything else (key
              format, rule resolution, the 429 response shape) is
              provided by the layer that calls this operation, not by
              the backend itself
Invariant:    calling this operation never has an observable side effect
              on any key OTHER than the one it was called with
On violation:   a backend that cannot provide the atomicity guarantee
                (e.g. because its underlying store only offers a
                separate read-then-write pair with no guard) has not
                satisfied this contract, even if it happens to work
                correctly in the absence of concurrent traffic
                Blamed party: ADAPTER — the storage backend
                implementation
                Recoverable by: the backend implementer adding a guard
                condition to its write (a conditional update keyed on the
                value most recently read) so a losing concurrent writer
                re-reads and re-decides rather than silently overwriting
                a winning writer's update
```

```
┌──────────────────────────────────────────────────────────────────────┐
│         ONE CONTRACT, THREE SUBSTITUTABLE STORAGE BACKENDS             │
│                                                                          │
│   in-process memory     shared secondary store      persistence-layer   │
│   ──────────────────    ────────────────────────    ──────────────────│
│   single-process        delegates to a generic       delegates to the  │
│   atomicity is free      counter-with-expiry          persistence       │
│   (no concurrent          primitive the shared        layer's adapter   │
│   access without an       store already exposes;      contract (see     │
│   interleaving point);    requires that primitive     01-core-domain/   │
│   bounds its own total    to exist — a deployment      04) via a        │
│   tracked-key count so    that enables this backend    conditional      │
│   an unbounded stream     without a store that         (guard-then-     │
│   of distinct keys        offers it fails FAST at      write) update,   │
│   cannot exhaust its      configuration time, not      re-reading and   │
│   memory without bound    per-request                  retrying on a    │
│                                                          lost race;      │
│                                                          prunes rows     │
│                                                          past every      │
│                                                          rule's longest  │
│                                                          observed        │
│                                                          window on a     │
│                                                          best-effort     │
│                                                          basis           │
│                                                                          │
│              all three satisfy IDENTICAL: consume(key,rule) → …         │
└──────────────────────────────────────────────────────────────────────┘
```

A deployment may substitute any of these three (or a wholly custom
backend that only satisfies the `consume` contract above) without
changing anything a caller can observe about the enforcement contract in
§§1–4 — this is the same substitutability principle
`00-methodology/02-higher-order-contracts.md` §4 states for the full
database-adapter contract, scoped down to the much smaller surface this
capability actually needs.

---

## 6. Enabled/disabled — a deployment-time precondition

```
Operation:      enable rate limiting for this deployment
Requires:       (none beyond ordinary configuration — the default posture
                is enabled in a production-like environment and disabled
                otherwise, but a deployer may override either default
                explicitly)
Ensures:        when disabled, EVERY request skips §1 entirely — this is
                a deployment-wide switch, not a per-path one (per-path
                exemption is expressed through §4's disable instruction
                instead, which requires rate limiting to be enabled
                overall and then locally turned off for that one path)
Invariant:      disabling rate limiting never affects anything on the
                in-process surface, which was already exempt (§1)
```
