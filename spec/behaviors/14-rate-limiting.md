# Rate Limiting
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-14 |
> | Revision | 1.2 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Added fail-open/fail-closed guidance for an unreachable `RateLimiter` store, clarified the check-then-increment race under concurrency, and named the default fixed-window algorithm (CCR-EA-002) <br> 1.2 (2026-09-29): Replaced the pre-implementation banner with implementation pointers (DTWS-001, CCR-EA-006) |
---

> Implemented in `@awthaq/ports` (`RateLimiter.ts`) and `@awthaq/core` (`RateLimits.ts`); tests `packages/ports/test/RateLimiter.test.ts`, `packages/core/test/RateLimits.test.ts`, `packages/sql/test/RateLimiterStoreSql.test.ts`; the tests behind each behavior are mapped in [`spec/traceability.md`](../traceability.md) §5, and a behavior whose text differs from the shipped code carries an *Implementation* or *Deviation* note.

## BEH-EA-105: The RateLimiter port

> **See:** [ADR-EA-010](../decisions/010-plugins-require-ports-never-provide.md)

```ts
export interface RateLimiter {
  readonly consume: (input: {
    readonly key: string
    readonly limit: number
    readonly window: Duration.DurationInput
  }) => Effect<void, RateLimited>
}
```

```text
REQUIREMENT: `RateLimiter` MUST be a port a plugin requires and the application
             provides; a plugin MUST NOT bundle its own limiter implementation
             or bypass the port to enforce a limit directly against a store.
```

`RateLimiter` sits at stratum 2 alongside `Crypto`, `KeyValueStore` and `PasswordHasher`: it is a capability, not a feature. The default implementation is an in-memory store adequate for a single instance and tests; production wiring swaps in a Redis- or SQL-backed store by providing a different Layer for the same port, exactly as ADR-EA-010 requires for every port. A plugin that shipped its own limiter would duplicate storage, duplicate configuration, and make one plugin's throttling invisible to the operator who only knows to look at `RateLimiter`.

`consume` is expected to implement a **fixed-window** counter by default (increment a count keyed by `key` for the current `window`-sized bucket, fail with `RateLimited` once `limit` is exceeded within that bucket) — the simplest algorithm to implement correctly across every backing store (`RateLimiter.layerStoreMemory`, a SQL row with an expiring counter, a Redis `INCR`/`EXPIRE` pair), at the cost of allowing up to `2 × limit` requests across a window boundary, a cost this specification accepts as the documented default rather than requiring every store implementation to also implement a sliding-window or token-bucket algorithm. A `RateLimiter` implementation MAY instead implement sliding-window or token-bucket semantics — both give a tighter bound on burst-at-the-boundary behavior — provided it still satisfies `consume`'s `Effect<void, RateLimited>` contract and `retryAfterMillis` remains an honest estimate of when the next `consume` call is expected to succeed.

`RateLimiter.layerStoreMemory` is **bounded** (RBS-003): bucket keys embed caller-chosen input, so an unbounded map would let an unauthenticated caller grow process memory without limit by varying the key. The store reclaims buckets whose window has elapsed on a periodic sweep (default: every minute), enforces a hard cap on live buckets (default: 100,000) by dropping expired buckets and then the earliest-expiring live ones when a new key arrives at the cap, and exposes its current bucket count through `RateLimiter.RateLimiterMemoryStats` so operators and tests can observe saturation. `RateLimiter.layerStoreMemoryWith({ maxBuckets, sweepInterval })` tunes both. Evicting a live bucket forgives that key's count; that is the accepted cost of a memory bound, and the store is single-process only.

A rule may opt into **escalation** (RBS-009): `escalation: { factor, maxPenalty }` on `consume` / `RateLimits.enforce` / `RuleInput`. Each window in which the limit is exceeded counts one strike, and the caller is then refused for `window × factor^(strikes − 1)` capped at `maxPenalty` (`retryAfterMillis` reports that wait), so waiting out the fixed window costs an attacker more each time. Strikes are counted over a `maxPenalty` window, and the penalty is held as a block that refuses further attempts without touching the plain bucket. Escalation needs one extra store primitive, the read-only `peek`. Off by default: without `escalation` a rule is exactly the fixed window described above. The plugin-shipped rules do not enable it; an application opts a rule in explicitly.

Under concurrent, multi-instance load, `consume`'s check (has this key exceeded `limit`?) and its increment (record this attempt) MUST be one atomic operation against the backing store — a `RateLimiter` implementation that reads the current count, decides "not yet at the limit" in application code, and only then writes the incremented count back is a check-then-act race: two concurrent requests against the same key can both observe a pre-increment count under `limit` and both proceed, admitting `limit + 1` (or more, under enough concurrency) requests through a limit that was supposed to admit exactly `limit`. A store-level atomic primitive (SQL `UPDATE ... SET count = count + 1 WHERE count < limit RETURNING ...`, Redis `INCR` combined with a first-write `EXPIRE`, or an equivalent compare-and-swap) is what closes this race; a `RateLimiter` implementation backed by a store with no such primitive is not a legal implementation of the port, because it cannot honor `consume`'s contract under concurrent callers no matter how carefully the surrounding application code is written.

Because `RateLimiter` sits behind an application-provided store the same way `Mailer` and `PasswordHasher` do, the store itself can become unreachable (a Redis outage, a SQL connection-pool exhaustion distinct from the primary database's own availability). `RateLimiter.layer`'s default posture in that case is **fail-open**: `consume` succeeds (the request proceeds unthrottled) rather than failing every request in the application with an unrelated 5xx merely because the rate-limit store, a defense-in-depth mechanism, is unavailable — the same reasoning `behaviors/15-password.md`'s BEH-EA-119 states for the breach-check provider (a third-party dependency's outage should not be able to take down a path that has no other dependency on it). A store reports an outage on its `increment`'s error channel as `RateLimiterStoreUnavailable` (RBS-004); `RateLimiter.layer` catches it, logs a warning (never the bucket key) and lets the request through. An application whose risk posture prefers the opposite trade sets `RateLimiter.config({ onStoreUnavailable: "reject", unavailableRetryAfter })`, which makes `consume` fail closed with `RateLimitExceeded` instead, exactly as BEH-EA-119 offers `onUnavailable: "reject"` for breach-checking — but fail-open, not fail-closed, is the default a `RateLimiter.layer` ships with, and that default is documented, not an accident of how the store's connection failure happened to propagate.

_Previous: [BEH-EA-104](13-events.md#beh-ea-104-a-failing-subscriber-is-logged-under-a-stable-queryable-event-name-and-never-re-raised) | Next: [BEH-EA-106](14-rate-limiting.md#beh-ea-106-the-ratelimited-error)_

## BEH-EA-106: The RateLimited error

```ts
export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
  retryAfterMillis: Schema.Number
}) {}
```

```text
REQUIREMENT: Exceeding a configured limit MUST fail with `RateLimited` carrying
             `retryAfterMillis`; it MUST NOT fail with a generic or untyped error.
```

`RateLimited` is the **wire** error (`@awthaq/api`'s `Api.RateLimited`, HTTP 429). The `RateLimiter` port's own failure is the distinct `RateLimitExceeded` (RBS-010), carrying only `retryAfterMillis`: it never carries the bucket key (keys embed emails and IPs), and the plugin that called `consume` maps it onto `RateLimited` at its endpoint boundary. Where this document says `consume` fails with `RateLimited`, the port-level failure is `RateLimitExceeded` and the caller-visible one is `RateLimited`.

Every breach is observable (EOTS-007). A plugin enforces its rules through `RateLimits.enforce`, which on a refusal publishes the `auth.rateLimit.exceeded` event (`group`, `endpoint`, `rule`, `dimension`, `retryAfterMillis`), logs a warning annotated with the same fields, and increments the `awthaq.ratelimit.exceeded` counter tagged with them. None of the three carries the bucket key: it embeds an email or an IP, and a security signal must not double as an identifier leak (BEH-EA-108). The event is recorded by `AuditLog` with no actor.

`retryAfterMillis` is the one piece of information a client needs to behave well: back off, then retry. Carrying it as a typed field (rather than folding it into a message string) lets `@awthaq/client` render a localized "try again in n seconds" without parsing text, matching the error-catalog design used across the rest of the contract (research/11-client-frontend.md Q86) and the `RateLimited` handling shown in `usage-examples-v4.md` §11.2.

_Previous: [BEH-EA-105](14-rate-limiting.md#beh-ea-105-the-ratelimiter-port) | Next: [BEH-EA-107](14-rate-limiting.md#beh-ea-107-a-plugin-may-only-rate-limit-its-own-endpoints)_

## BEH-EA-107: A plugin may only rate-limit its own endpoints

```ts
export const AuthRateLimits: {
  readonly rule: (input: {
    readonly group: string
    readonly endpoint: string
    readonly key: "principal" | "ip" | ((ctx: unknown) => string)
    readonly limit: number
    readonly window: Duration.DurationInput
  }) => Layer<never>
}
```

```text
REQUIREMENT: A rate-limit rule contributed by plugin P naming `group` MUST be
             rejected at composition time unless `group` is one of P's own
             contract groups; a plugin MUST NOT rate-limit another plugin's
             endpoint.
```

Rate-limit rules are registry contributions, aggregated the way hook taps and event subscribers are (PRD §9.3, ADR-EA-012's registry half). Scoping a rule to the contributing plugin's own groups keeps the registry legible: reading `two-factor`'s rules tells you everything `two-factor` throttles, with no rule from an unrelated plugin hiding in the list. `usage-examples-v4.md` §16 shows the shape: a plugin's own `layer` mixes in `AuthRateLimits.rule({ group: "invite", ... })` next to its handlers, never a rule naming `"password"` or `"session"`.

_Previous: [BEH-EA-106](14-rate-limiting.md#beh-ea-106-the-ratelimited-error) | Next: [BEH-EA-108](14-rate-limiting.md#beh-ea-108-key-strategies)_

## BEH-EA-108: Key strategies

```ts
type RateLimitKey = "principal" | "ip" | ((input: unknown) => string)
```

```text
REQUIREMENT: A rate-limit rule MUST derive its bucket key from `CurrentPrincipal`,
             the request's network origin, or an explicit deterministic function
             of the request; it MUST NOT key on a value the caller can set to an
             arbitrary string of its choosing (e.g., an unvalidated header) without
             the plugin author opting into that explicitly.
```

Two failure modes motivate the constraint: keying only on IP lets a NATed office collectively lock itself out, and keying on an attacker-chosen value (an email in a sign-in payload, say) makes the limiter's bucket space attacker-controlled, defeating the limit's purpose. The built-in strategies (`"principal"`, `"ip"`) cover the common cases; a custom function is available for a plugin that genuinely needs a composite key (`` `signin:${email}` `` in `usage-examples-v4.md` §16), but the plugin author is then responsible for the same reasoning the built-ins already satisfy.

RBS-006/TMS-006: a plugin that registers rules for introspection and also enforces them (`@awthaq/password` does) defines each rule once, so the registered key function and the enforced key cannot drift; a key is derived only from the small secret-free input its endpoint names (an email, an address, a token's public id, a user id), never from a request payload that also carries a password or token. A per-email key SHOULD be normalized so subaddressed aliases (`victim+1@x.com`) share one bucket while delivery keeps the literal address.

_Previous: [BEH-EA-107](14-rate-limiting.md#beh-ea-107-a-plugin-may-only-rate-limit-its-own-endpoints) | Next: [BEH-EA-109](14-rate-limiting.md#beh-ea-109-swappable-stores)_

## BEH-EA-109: Swappable stores

```ts
Layer.provide(RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory)))
Layer.provide(RateLimiter.layer.pipe(Layer.provide(RateLimiterStoreSql.layerStoreSql)))
Layer.provide(RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreRedisConfig({ url: Config.Redacted("REDIS_URL") }))))
```

```text
REQUIREMENT: Providing two Layers for the `RateLimiter` port MUST shadow (the
             later Layer wins), never merge; awthaq MUST NOT attempt to
             combine two rate-limit store implementations into one.
```

This is the same rule ADR-EA-010 states for every port: `PasswordHasher`, `Mailer` and `RateLimiter` are all one-implementation-per-application services, and the type checker enforces it by construction — a second `Layer.provide` for the same tag simply replaces the first at that point in the graph. The memory store is adequate for a single process and for tests. `@awthaq/sql` ships `RateLimiterStoreSql.layerStoreSql` (RBS-004), the multi-replica store: one atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` per `increment` over the application's existing Postgres or SQLite `SqlClient`, with its table created by `RateLimiterStoreSql.migrate` (which uses its own tracking table, so its ids never collide with `coreMigrations`). Redis stays bring-your-own (the `layerStoreRedisConfig` line above is illustrative, not shipped); a SQL-backed or Redis store is the production default for multi-instance deployments, exactly as PRD §11 lists `RateLimiter` among the ports whose default implementations are "memory, SQL, Redis stores."

_Previous: [BEH-EA-108](14-rate-limiting.md#beh-ea-108-key-strategies) | Next: [BEH-EA-110](14-rate-limiting.md#beh-ea-110-built-in-rules-shipped-by-core-plugins)_

## BEH-EA-110: Built-in rules shipped by core plugins

```ts
AuthRateLimits.rule({ group: "two-factor", endpoint: "verify", key: "principal", limit: 3, window: "10 seconds" })
```

```text
REQUIREMENT: Every official plugin whose endpoints are a plausible brute-force
             target (sign-in, two-factor verification, password reset request)
             MUST ship a default rate-limit rule for that endpoint; an
             application MUST NOT have to add rate limiting itself to get a
             sane default.
```

`usage-examples-v4.md` §9 documents one instance directly: "`/two-factor/verify` is rate limited to three attempts per ten seconds by a rule the plugin ships." Shipping the rule as part of the plugin's own `layer` (rather than as documentation an application must remember to follow) makes secure-by-default (PRD G6) apply to rate limiting the same way it applies to session cookie flags and password hashing: the safe configuration is the one that requires no application code.

_Previous: [BEH-EA-109](14-rate-limiting.md#beh-ea-109-swappable-stores) | Next: [BEH-EA-111](14-rate-limiting.md#beh-ea-111-registry-ordering)_

## BEH-EA-111: Registry ordering

```text
REQUIREMENT: Rate-limit rules read for `awthaq plugin list --graph` or any
             other introspection MUST be ordered by plugin dependency order,
             then by an explicit `order` field, then by rule id — the same
             three-key ordering the hook and event registries use.
```

Rate-limit rules are a registry, and PRD §9.3 fixes one ordering discipline for every registry in the system: "aggregating contributions ordered by dependency, then `order`, then id." Rate limiting gets no special case. An operator who has learned to read the hook chain output from `awthaq plugin list --hooks` reads the rate-limit rule listing the same way, without learning a second convention.

_Previous: [BEH-EA-110](14-rate-limiting.md#beh-ea-110-built-in-rules-shipped-by-core-plugins) | Next: [BEH-EA-112](14-rate-limiting.md#beh-ea-112-testing-with-a-permissive-limiter)_

## BEH-EA-112: Testing with a permissive limiter

```ts
const TestLive = TestAuth.layer(plugins)   // includes a permissive RateLimiter
```

```text
REQUIREMENT: `TestAuth.layer` MUST provide a `RateLimiter` implementation that
             never rejects a request under ordinary test iteration counts; a
             test suite MUST NOT have to reconfigure or mock rate limiting
             merely to run a loop of sign-in attempts.
```

A limiter tuned for production (three attempts per ten seconds) would make a test that signs in fifty times in a `for` loop flaky or fail outright, for a reason that has nothing to do with what the test is checking. `TestAuth.layer(plugins)` (PRD §19, `usage-examples-v4.md` §22.1) exists precisely to remove this class of incidental failure: memory repositories, a memory mailer, and a permissive rate limiter, so a test that wants to exercise rate limiting specifically does so by providing a stricter `RateLimiter` Layer of its own, not by fighting the default.

RBS-007: the permissive limiter is for tests only, and the documented non-test default is a real one. `RateLimiter.layerMemory` is `layer` over the bounded memory store, one line for a single-process deployment (`layerPermissive` is what `TestAuth` bundles); `layerPermissive` logs one warning the first time a rule runs against it (`awthaq: RateLimiter.layerPermissive is active — every registered rate-limit rule is disabled`), so a test composition copied into production is not silently unprotected.

_Previous: [BEH-EA-111](14-rate-limiting.md#beh-ea-111-registry-ordering) | Next: [BEH-EA-113](15-password.md#beh-ea-113-sign-up-issues-a-pending-user-and-a-verification-mail)_
