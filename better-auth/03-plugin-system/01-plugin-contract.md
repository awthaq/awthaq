# The Plugin Contract — What a Plugin May Contribute

> Evidence base: `packages/core/src/types/plugin.ts` (the `BetterAuthPlugin`
> contribution surface), `packages/core/src/db/plugin.ts` +
> `packages/core/src/db/type.ts` (schema shape), `packages/core/src/types/
> context.ts` (`AuthContext`), `packages/better-auth/src/api/index.ts`
> (`getEndpoints`, `checkEndpointConflicts`, the `onRequest`/`onResponse`
> pipeline), `packages/better-auth/src/api/dispatch.ts` (hook composition),
> `packages/better-auth/src/api/rate-limiter/index.ts` (rate-limit rule
> resolution), `packages/better-auth/src/context/helpers.ts`
> (`runPluginInit`), and five concrete plugins (`two-factor`, `organization`,
> `jwt`, `magic-link`) read as instantiation evidence.

A **plugin** is not a class or an object with methods to override — it is a
**value satisfying a fixed contribution-surface contract**: a plain record
whose fields are each, independently, a higher-order value with its own
domain→range arrow (per `00-methodology/02-higher-order-contracts.md`). This
document enumerates every field of that record as its own contract. The
*composition* of many such values (ordering, conflicts, staging) is
`02-plugin-composition-and-schema-extension.md`; this document is about the
shape each individual contribution must have to be a **legal specialization**
of the base auth system, per the Liskov rule in
`00-methodology/01-design-by-contract.md` §5.

---

## 0. The taxonomy, at a glance

```
┌───────────────────────────────────────────────────────────────────────────┐
│                         BetterAuthPlugin  (a value)                        │
│                                                                             │
│  identity            id : LiteralString                    (required)     │
│                       version? : string                                   │
│                                                                             │
│  ┌─────────────────────────── STAGED CONTEXT DELTA ──────────────────────┐ │
│  │  init? : AuthContext -> { context?: ΔCtx, options?: ΔOptions } | void  │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  ┌─────────────────────────── REQUEST-SURFACE CONTRIBUTIONS ─────────────┐ │
│  │  endpoints?     : { name -> Endpoint }         (named higher-order    │ │
│  │                                                  values, own full     │ │
│  │                                                  request/response     │ │
│  │                                                  contract)            │ │
│  │  middlewares?   : { path, middleware }[]        (path-scoped)         │ │
│  │  onRequest?     : Request × AuthContext -> {response}|{request}|void  │ │
│  │  onResponse?    : Response × AuthContext -> {response}|void           │ │
│  │  hooks?         : { before?, after?: {matcher, handler}[] }           │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  ┌─────────────────────────── DATA-SHAPE CONTRIBUTIONS ──────────────────┐ │
│  │  schema?        : { table -> { fields, indexes?, ... } }  (declarative)│ │
│  │  migrations?    : { name -> Migration }         (escape hatch)        │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  ┌─────────────────────────── POLICY / TAXONOMY CONTRIBUTIONS ───────────┐ │
│  │  rateLimit?     : { window, max, pathMatcher }[]                      │ │
│  │  $ERROR_CODES?  : { code -> RawError }          (blame vocabulary)    │ │
│  │  adapter?       : { opName -> fn }              (substitution)        │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  ┌─────────────────────────── TYPE / CONFIG-ONLY (no runtime arrow) ─────┐ │
│  │  options?       : Record<string, any>           (the plugin's own     │ │
│  │  $Infer?        : Record<string, any>            construction args    │ │
│  │                                                    and inferred types) │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────┘
```

Every non-leaf box above is specified below as `Operation / Requires /
Ensures / Invariant / On violation`. Fields with no runtime arrow (`options`,
`$Infer`) are noted as such and skipped past the taxonomy.

---

## 1. Identity: `id`, `version`

**Contract shape:** not a function — a first-order value, but one that
participates in every other contract in this tree because `id` is the unit
of address for `getPlugin`/`hasPlugin` (§`PluginContext` in `context.ts`) and
for blame attribution (every hook, middleware, and log line in the request
pipeline is tagged `plugin:${id}`, per `dispatch.ts`'s `hooksSourceWeakMap`
and `api/index.ts`'s `withSpan` calls).

```
Operation:     plugin identity declaration
Requires:      id is a non-empty string, unique across the plugin list
               passed to this auth instance
Ensures:       every other contract this plugin installs is attributable to
               exactly this id at blame time (never "unknown", except where
               a value crosses a boundary the pipeline cannot instrument —
               treated as a pipeline defect, not a normal outcome)
Invariant:     id does not change for the lifetime of the auth instance
On violation:  Two plugins with the same id — undefined resolution; the
               later one silently wins wherever the composition uses
               id-keying (see 02, "identity collision"). Blamed party:
               INTEGRATOR (whoever assembled the plugin list).
```

`version` is purely informational (telemetry, `$Infer` disambiguation for
tooling); it carries no contract obligation on its own and is not otherwise
enforced at composition time.

---

## 2. `init` — the staged context/options delta

This is the plugin system's central higher-order contract, and the direct
instantiation of `00-methodology/02-higher-order-contracts.md` §3's staged
contract.

```
Contract:   init : AuthContext(as accumulated so far)
                     -> Awaitable<{ context?: ΔContext, options?: ΔOptions } | void>
Applies at: once per plugin, in options.plugins array order, during
            AuthContext construction — after the base context (adapter,
            tables, cookies, password config, etc.) is built, before the
            router/endpoint table is compiled and before the first request
            is served.
```

* **Requires** (domain contract on the argument): the `AuthContext` passed to
  `init` reflects the base system's fields plus every `context` delta already
  merged from plugins *earlier* in the array (see `02` for the exact staging
  rule). A plugin's `init` may read anything on this object — including
  fields contributed by an earlier plugin — but has no way to know, from the
  type alone, which fields came from the base system versus an earlier
  plugin; it must treat the whole object as "whatever is observably present
  right now."

* **Ensures** (range contract on the return value): if `init` returns an
  object,
  * `context`, if present, is a *partial* structural delta (`DeepPartial`) —
    every leaf value it sets is merged onto the accumulating context via
    `Object.assign` at the top level (`runPluginInit`, `context/helpers.ts`)
    — **not** a deep merge. A plugin returning `{ context: { sessionConfig:
    { cookieCacheSigner } } }` **replaces the entire `sessionConfig` object**
    on the shared context, discarding sibling keys the base system or an
    earlier plugin set on `sessionConfig`, unless the plugin explicitly
    spreads the prior value forward itself (the `jwt` plugin does exactly
    this: `{ context: { sessionConfig: { ...ctx.sessionConfig,
    cookieCacheSigner } } }` — the spread is the plugin's own obligation, not
    something the pipeline does for it).
  * `options`, if present, is merged onto the accumulating
    `BetterAuthOptions` with `defu` (first-object-wins-on-conflict,
    recursively) — the *opposite* merge strategy from `context`. `options`
    that includes `databaseHooks` or `trustedOrigins` is intercepted and
    composed specially (hooks accumulate into an ordered list tagged
    `plugin:${id}`; `trustedOrigins` functions/arrays are all evaluated and
    unioned) rather than defu-merged like the rest of `options`.
  * Returning `undefined`/`void` contributes nothing; this is a legal,
    complete no-op, not a partial failure.

* **Invariant this contribution must preserve:** any invariant the base
  context already established before this plugin ran (e.g. "`adapter` is a
  fully constructed `DBAdapter`", "`tables` reflects the final schema") must
  still hold after the merge. `init` may **add** capabilities to the context;
  it must not remove or corrupt a capability the base system or an earlier
  plugin already installed, because that capability may already be depended
  upon by plugins ordered after this one (see the "first cause, not first
  observer" rule, `00-methodology/03-theory-of-contracts-and-blame.md` §4).

```
On violation of the domain contract (init throws, or the AuthContext it
reads is not yet in the state the plugin assumed — e.g. it reads a field
only a later plugin installs):
   Raised as:      whatever the plugin's `init` throws (typically
                    BetterAuthError, as evidenced in `jwt`'s init, which
                    throws BetterAuthError when its own preconditions on
                    `ctx.options.session.cookieCache.strategy` are unmet)
   Blamed party:   the PLUGIN whose init made an unwarranted assumption about
                    ordering. It is the plugin's own responsibility, not the
                    integrator's, to fail loudly and specifically rather than
                    silently misbehave.
   Recoverable by: the integrator re-ordering `options.plugins`, or the
                    plugin author changing the plugin to declare and check
                    its own precondition instead of assuming order (see 02
                    for the ordering contract itself).

On violation of the range contract (init's `context` delta overwrites a
sibling key of a nested object other plugins/base system depend on):
   Raised as:      no error at merge time — this is NOT detected. The
                    breakage surfaces later, at the point some other plugin
                    or endpoint reads the now-missing sibling field, as
                    whatever failure mode that read produces (commonly a
                    silent `undefined`, sometimes a thrown TypeError).
   Blamed party:   the PLUGIN that returned the overwriting `context` delta
                    (positive blame — it produced a bad value at this
                    boundary), per the "first cause" rule — not the plugin
                    or endpoint that later observes the missing field.
   Recoverable by: the offending plugin's `init` spreading the prior value
                    of any object-valued field it touches, rather than
                    replacing it outright.
```

### Liskov rule for `init`

A plugin's `init` is a **specialization of the identity function** on
`AuthContext` (the base case: no plugins, context is unchanged). Per
`01-design-by-contract.md` §5:

* it may **weaken** what it requires of the incoming context (tolerate a
  context state it doesn't strictly need) — never strengthen (never require
  a field that only a *specific* plugin, of unknowable position, would have
  added, without an explicit dependency check via `hasPlugin`/`getPlugin`
  first);
* it may **strengthen** what it ensures about the outgoing context (add new
  capabilities) — never weaken an existing one (never narrow or remove a
  capability the incoming context already had).

---

## 3. `endpoints` — named higher-order request/response contracts

```
Contract:   endpoints : { [name: string]: Endpoint }
            where each Endpoint is itself the arrow
              Endpoint : RequestContext -> Response | { body, status, headers }
            (its own full precondition/postcondition/invariant is the
            request-pipeline endpoint contract — see the conceptual
            cross-reference to the request-pipeline documents' endpoint
            contract; this document only specifies the *plugin contribution*
            of that value, not the endpoint contract's internals.)
Applies at: endpoint-table compilation (`getEndpoints`, once, at context/
            router construction) and per-request dispatch
            (`dispatchAuthEndpoint`, once per matching request).
```

* **Requires:** each endpoint value is a legitimate `Endpoint` (has a `path`,
  an HTTP method, and a handler arrow) — the plugin is the *positive* party
  (producer) at the boundary where this endpoint is registered into the
  shared endpoint table.
* **Ensures:** once registered, the endpoint is reachable at its declared
  path/method and is a first-class peer of every base-system endpoint — it
  participates in the *same* hook pipeline, the *same* rate-limit gate, the
  *same* error model as `signInEmail`, `getSession`, etc. There is no
  "second-class" plugin endpoint.
* **Invariant:** the *name* under which an endpoint is contributed (the
  object key, e.g. `enableTwoFactor`) is the address used for `auth.api.*`
  and for the endpoint-key merge in `getEndpoints` (`{ ...acc, ...
  plugin.endpoints }`, plain object spread over the plugin array). Two
  plugins contributing under the **same key** silently collide (`02` covers
  this in full); two plugins contributing the same key with *different
  paths* is a plugin-authoring defect, not a supported feature.

```
On violation (an endpoint contribution's own request/response contract
is violated at request time):
   Raised as / Blamed party / Recoverable by: — deferred entirely to the
   endpoint contract itself, per 00-methodology/02 §5 ("the plugin system
   documents are kept separate from concrete plugin behavior documents").
   This document's only obligation is: the plugin must contribute a value
   that IS an Endpoint (satisfies the endpoint arrow shape) — that is a
   precondition on the plugin, checked implicitly by the compiler/router at
   registration, blamed on the PLUGIN if not met.
```

### Liskov rule for `endpoints`

A plugin endpoint must not narrow the *pipeline-level* guarantees every
endpoint gets for free (hook interception, rate-limit application, uniform
error shape) — it cannot opt itself out of `hooks.before`/`hooks.after`
observing it, for example. It may only add path-specific behavior on top.

---

## 4. `middlewares` — path-scoped middleware contribution

```
Contract:   middlewares : { path: string, middleware: Middleware }[]
            where Middleware : RequestContext -> void | { ...context overrides }
Applies at: router construction (wrapped once, per `getEndpoints`, into a
            span-instrumented middleware that merges the live AuthContext
            into the incoming context) and matched per-request by `path`
            against the router (`better-call`'s router semantics own exact
            path-pattern matching — out of scope here).
```

* **Requires:** `path` is a router-pattern string (may use wildcards, e.g.
  `/**`); `middleware` does not assume any particular `context` shape beyond
  the router-supplied one plus whatever `AuthContext` fields are guaranteed
  by base-system + already-run `init` stages.
* **Ensures:** the middleware runs for every request whose path matches,
  *before* endpoint dispatch, with `context.context` set to the live
  `AuthContext` merged over whatever the router already put there — a
  plugin's middleware is layered **underneath** router-level context, i.e.
  router-supplied `context` fields win over the plugin's base `AuthContext`
  spread (`{ ...authContext, ...context.context }` in `getEndpoints`).
* **Invariant:** middleware contribution does not remove or shadow another
  plugin's middleware; all matching middlewares registered by all plugins
  run (concatenated across `options.plugins`, order preserved) — this is a
  **union**, not a **replacement**, contract, unlike `endpoints` (keyed
  union with collision) or `hooks` (matched, ordered chain).

```
On violation (middleware throws, or returns a context shape the router/
endpoint layer cannot interpret):
   Raised as:      the router's own error handling (an uncaught throw
                    becomes an INTERNAL_SERVER_ERROR-class failure at the
                    `onError` handler in `api/index.ts`, unless it is an
                    APIError, which is treated as an intentional short
                    circuit).
   Blamed party:   the PLUGIN that owns the middleware (positive blame — a
                    middleware is a supplier of request transformation to
                    every downstream consumer on that path).
```

### Liskov rule for `middlewares`

A middleware may only **add** context fields or **halt with a documented
error**; it must not silently swallow or invert a decision a base-system
middleware or another plugin's middleware already made on the same path
(e.g. it must not clear a `context.session` another middleware populated,
without an explicit, documented reason — doing so weakens a postcondition
downstream consumers rely on).

---

## 5. `onRequest` / `onResponse` — whole-request/response transform arrows

```
Contract:   onRequest  : Request × AuthContext
                           -> Awaitable<{ response: Response }
                                        | { request: Request }
                                        | void>
            onResponse : Response × AuthContext
                           -> Awaitable<{ response: Response } | void>
Applies at: onRequest — once per incoming HTTP request, after disabled-path
            and rate-limit gating, in options.plugins array order, BEFORE
            the router matches a path (evidence: the loop in `api/index.ts`'s
            `router(...).onRequest`, which runs strictly before
            `createRouter` dispatches to any endpoint).
            onResponse — once per outgoing HTTP response, in the SAME
            options.plugins array order (not reversed), after the endpoint
            (and its hooks) produced a response.
```

* **Requires (`onRequest`):** the plugin receives the *current* request —
  which may already have been rewritten by an earlier plugin's `onRequest`
  in this same pass — and the live `AuthContext`. It must not assume it is
  the only, or the first, transform to see this request.
* **Ensures (`onRequest`):**
  * returning `{ response }` **short-circuits** the entire pipeline —
    no further plugin `onRequest`s run, the router never sees the request,
    and no endpoint, hook, or rate-limit-adjacent logic downstream of this
    point executes. This is the most powerful contribution surface a plugin
    has: it can fully replace better-auth's routing for matched requests.
  * returning `{ request }` **replaces** the request object seen by every
    subsequent plugin's `onRequest` and, ultimately, the router.
  * returning `void`/`undefined` passes the current request through
    unchanged.
* **Requires/Ensures (`onResponse`):** symmetric — receives the response
  produced by the endpoint pipeline (or by an earlier plugin's `onResponse`
  in the same pass), may replace it via `{ response }`, or pass through with
  `void`. Unlike `onRequest`, there is no "halt" outcome — `onResponse` runs
  to completion across all plugins that have one, each seeing the previous
  plugin's replacement if any (sequential rewrite chain, not short-circuit).
* **Invariant:** the *order* in which plugins run for `onRequest` and
  `onResponse` is the **same** — `options.plugins` array order in both
  directions (this is notably NOT the onion/middleware-stack convention of
  reversing order for the response phase; it is evidenced directly in
  `api/index.ts`, where both loops iterate `ctx.options.plugins || []` in
  the same forward order).

```
On violation (a plugin's onRequest/onResponse throws):
   Raised as:      propagates to the router's onError handler exactly like
                    an endpoint throw — no special catch is installed around
                    these plugin hooks specifically.
   Blamed party:   the PLUGIN that threw (positive blame at this boundary).
   Recoverable by: the plugin catching its own transformation errors and
                    returning `void` (pass-through) rather than throwing,
                    unless an intentional hard-fail (e.g. `APIError`) is the
                    plugin's documented behavior for that condition.
```

### Liskov rule for `onRequest`/`onResponse`

A plugin's transform must not **narrow** what requests/responses the base
system is able to serve for plugins ordered after it — e.g. it must not
mutate `Request` headers in a way that makes a later plugin's own
precondition on those headers spuriously fail. It may only add
transformations that are transparent to well-behaved downstream consumers,
or explicitly and observably halt (which is a *documented*, not silent,
narrowing — the halt is visible in the returned `Response`).

---

## 6. `hooks` — matcher/handler pairs (before/after)

```
Contract:   hooks.before? : { matcher: HookEndpointContext -> boolean,
                              handler: AuthMiddleware }[]
            hooks.after?  : { matcher: HookEndpointContext -> boolean,
                              handler: AuthMiddleware }[]
            where AuthMiddleware : HookEndpointContext
                                     -> Awaitable<{ response? } | void>
Applies at: per matched endpoint dispatch, inside `dispatchAuthEndpoint`
            (`api/dispatch.ts`) — `before` hooks run after request
            validation but before the endpoint handler; `after` hooks run
            after the handler produced a result but before the response is
            finalized.
```

This is the canonical instance of `00-methodology/02-higher-order-contracts.
md` §1–2: the matcher's contract cannot be checked at registration time —
only by calling it, per request, with the real `HookEndpointContext`.

* **Requires (on `matcher`):** must be a pure, synchronous, total function
  from `HookEndpointContext` to `boolean` — it is invoked on *every* dispatch
  regardless of path, so it must not throw for contexts outside its intended
  scope (throwing here is treated as a hard failure — see below — not as
  "doesn't match").
* **Ensures (on `handler`, when `matched === true`):** for a **before**
  hook, returning an object with a `context` key contributes a **deep-merge
  delta** (`defu`-style, arrays replaced not concatenated) onto the working
  dispatch context, and hook execution **continues** to the next before-hook
  in the chain; returning anything else **halts** the entire endpoint
  dispatch and that value becomes the response (the endpoint handler itself
  never runs). For an **after** hook, returning a `response` **replaces**
  `context.context.returned`, visible to every after-hook still to run, and
  ultimately becomes the endpoint's result unless a later after-hook
  replaces it again.
* **Invariant:** a hook's `handler` observes the **cumulative** effect of
  every hook that matched and ran before it in the same phase — before-hooks
  chain their context deltas; after-hooks chain their response replacements.
  Order within a phase is: user-configured global `hooks.before`/`.after`
  (from `BetterAuthOptions.hooks`) first, unconditionally (`matcher: () =>
  true`), then every plugin's hooks **in `options.plugins` array order**
  (`getHooks`, `api/dispatch.ts`).

```
On violation (matcher throws):
   Raised as:      INTERNAL_SERVER_ERROR (`dispatch.ts`'s runBeforeHooks
                    catches the matcher's own throw specifically, logs which
                    plugin's hook it was, and converts it to a generic
                    APIError so internal details do not leak to the caller)
   Blamed party:   the PLUGIN owning that hook (negative blame is not
                    possible here — a matcher takes the request context as
                    given; if it throws on a legitimately-shaped context,
                    the fault is the matcher's own logic, i.e. the supplier).
   Recoverable by: the plugin author making the matcher defensive — it must
                    return `false` for any context it does not confidently
                    recognize, never throw.

On violation (handler throws, not caught as an intentional APIError):
   Raised as:      propagates out of dispatchAuthEndpoint as-is (before
                    hooks) or is caught and folded into the response chain
                    when it IS an APIError (after hooks specifically catch
                    APIError and fold it into `{ response: e }`, letting a
                    later after-hook or the caller see it as the endpoint's
                    outcome rather than an unhandled exception).
   Blamed party:   the PLUGIN owning the hook.
```

### Liskov rule for `hooks`

A hook may **add** a halt condition (narrow the set of requests that
succeed) only for requests it is specifically scoped to via its matcher —
it must never match broadly and halt for contexts outside the concern it
documents, because that silently narrows the base system's postcondition
("this endpoint succeeds for well-formed input") for every caller, which is
exactly the extension-rule violation `01-design-by-contract.md` §5
prohibits. A hook may **strengthen** an endpoint's postcondition (e.g. the
`two-factor` plugin's `after` hook on `/sign-in/email` adds a stronger
guarantee: "a session is only durably issued once any required 2FA is
satisfied") but must do so by contributing a **new, later-observed** result,
never by mutating the base endpoint's own promise out from under it.

---

## 7. `schema` — declarative data-shape contribution

```
Contract:   schema : {
              [table: string]: {
                fields: { [field: string]: DBFieldAttribute },
                indexes?: DBTableIndex[],
                disableMigration?: boolean,
                modelName?: string,
              }
            }
Applies at: schema compilation (`getAuthTables` / `buildAuthTables`,
            `packages/core/src/db/get-tables.ts`), once, before the adapter
            is asked to validate or migrate anything.
```

* **Requires:** each `DBFieldAttribute` is a legal field descriptor (a
  `type`, plus optional `required`/`unique`/`references`/`defaultValue`/
  `transform`/`validator`/etc. — the full attribute-config contract lives in
  `01-core-domain`'s database-adapter-contract document; this document only
  specifies that a plugin's *contribution* of such attributes is legal
  input to the merge).
* **Ensures:** every field a plugin declares under a table name becomes part
  of that table's effective schema, available to the adapter, to
  `InferDBFieldsInput`/`Output` type inference, and to every other plugin
  that reads or writes that table via `ctx.context.adapter`.
* **Invariant — the load-bearing one:** a plugin's schema contribution for
  **table T** is merged with every other plugin's (and the base system's)
  contribution for the **same T** via a **shallow field-map union**:
  `{ ...accumulated.fields, ...this-plugin.fields }` (evidenced verbatim in
  `buildAuthTables`). This is a plain object spread with **no collision
  detection**. See `02-plugin-composition-and-schema-extension.md` for the
  full conflict contract and blame assignment — this document's obligation
  is narrower: **a plugin must not declare a field name, on a table it does
  not own, that collides with a field name already used by the base schema
  or by another plugin, unless it is intentionally and compatibly
  re-declaring the identical field** (e.g. `organization` adding
  `activeOrganizationId`/`activeTeamId` to the base `session` table — new
  field names, not a collision).
* Indexes are merged with de-duplication on `(name, fields, unique)` triples
  (`mergeTableIndexes`) — an index re-declared identically by two plugins
  collapses to one; two *different* index definitions under different names
  both survive (additive), but two different definitions that would violate
  a physical database constraint (e.g. two unique indexes on overlapping
  field sets with different names) are **not** detected as a conflict here.

```
On violation (two plugins declare the same field name on the same table
with incompatible attributes — e.g. different `type`):
   Raised as:      no error at schema-compile time. The LATER plugin in
                    `options.plugins` order silently overwrites the earlier
                    plugin's field definition in the merged schema (plain
                    object spread, last-write-wins). The earlier plugin's
                    declared contract for that field is simply gone from
                    the effective schema — any code (including the earlier
                    plugin's own endpoints) that assumed its own field
                    definition (e.g. its `validator`, `transform`, or
                    `defaultValue`) is now silently working against the
                    later plugin's definition instead.
   Blamed party:   the PLUGIN whose declaration was silently discarded is
                    the *victim*, not the cause; per the "first cause, not
                    first observer" rule (00-methodology/03 §4), fault lies
                    with whichever of the two plugins is responsible for
                    the collision existing at all — in practice, since the
                    system does not resolve or record which one "meant" to
                    own the field, blame falls on the INTEGRATOR who
                    composed two plugins whose schema contributions were
                    never designed to coexist on that table.
   Recoverable by: renaming the field in one plugin's `schema`/options
                    (several plugins expose a `fields` remapping option
                    exactly for this), or not combining the two plugins.
```

### Liskov rule for `schema`

A plugin's schema contribution may only **add** fields/indexes; it must
never redefine a field the base system already requires with a
**weaker** constraint (e.g. a plugin must not mark `user.email` optional)
or **narrower** type than the base system promises to existing callers —
doing so breaks the postcondition every base-system endpoint already
guarantees about the shape of `User`.

---

## 8. `migrations` — the escape hatch, and its relation to `schema`

```
Contract:   migrations : { [name: string]: Migration }
            (a raw, imperative migration step, in the query-builder's own
            migration format)
```

* **Requires:** used *instead of* `schema` for the tables it touches, and
  only meaningfully in combination with `disableMigration: true` on the
  corresponding `schema` entry (or no `schema` entry at all for that table)
  — per the field's own documentation in `plugin.ts`: *"⚠️ Only use this if
  you don't want to use the schema option and you disabled migrations for
  the tables."* Declaring both a live (non-disabled) `schema` entry for a
  table **and** a `migrations` entry that also creates/alters that table is
  a contradiction the plugin author must avoid — the system does not
  reconcile the two.
* **Ensures:** nothing about `migrations`' *content* is contract-checked by
  the plugin system itself — it is an escape hatch precisely because it
  opts a table **out** of the declarative schema→migration pipeline
  (`01-core-domain`'s schema-diff/migration-generation contract) and takes
  on full responsibility for correctness in exchange.
* **Invariant relationship to `schema`:** `schema` is the **declarative**
  contract ("this is the shape of the data"); `migrations` is the
  **imperative escape hatch** ("this is how to get the database into that
  shape, because the declarative generator cannot or should not do it for
  this table"). A plugin choosing `migrations` for a table takes on the
  supplier's full obligation for keeping the physical schema consistent
  with whatever shape its `schema` (if any) or its endpoints assume — the
  plugin system provides no cross-check between the two for that table.

```
On violation (a plugin supplies `migrations` for a table it also declares
live in `schema`, and the two disagree about the table's shape):
   Raised as:      whatever the underlying adapter/database reports when a
                    query against a column the `schema` declares but the
                    `migrations` never created is attempted (a database-
                    level "column does not exist" class error).
   Blamed party:   the PLUGIN — it owns both halves of this contradiction.
```

### Liskov rule for `migrations`

Because `migrations` bypasses the declarative contract entirely, the Liskov
obligation shifts from "don't narrow/weaken the declared contract" to "don't
claim a `schema` shape you do not also imperatively deliver." A plugin using
this escape hatch must ensure the *observable* end state (the physical
schema after migrations run) is a superset-or-equal of whatever the same
plugin's `schema` (if declared) or its endpoints assume — it may not use the
escape hatch to under-deliver relative to its own declared shape.

---

## 9. `rateLimit` — path-scoped policy rules

```
Contract:   rateLimit : { window: number, max: number,
                           pathMatcher: (path: string) -> boolean }[]
Applies at: per-request, before rate-limit-gated endpoints execute
            (`onRequestRateLimit` / `resolveRateLimitConfig`,
            `api/rate-limiter/index.ts`).
```

* **Requires:** `pathMatcher` is total and side-effect-free (called on every
  request's normalized path).
* **Ensures:** for a request whose path matches, the rule's `window`/`max`
  **replace** the system default (`ctx.rateLimit.window`/`.max`) for that
  request's rate-limit accounting — this is a **substitution**, not an
  additional, stricter limit layered on top.
* **Invariant — resolution order, distinct from every other contribution
  kind:** `resolveRateLimitConfig` iterates `ctx.options.plugins` in array
  order and takes the **first** plugin whose `rateLimit` rules contain a
  matching `pathMatcher` (`break` on first match, evidenced verbatim) —
  **first-plugin-wins**, the opposite resolution order from `schema` and
  `endpoints` (last-wins) and orthogonal to `hooks`/`onRequest`/`onResponse`
  (all-run, chained). A global `rateLimit.customRules` entry, if the path
  also matches one, is applied **after** and can still override the
  plugin-supplied rule.

```
On violation (two plugins' pathMatchers both match the same path with
different window/max):
   Raised as:      no error — silently resolved by first-plugin-in-array-
                    order-wins, per the invariant above.
   Blamed party:   the INTEGRATOR, if the two rules were meant to coexist
                    (ordering is a load-bearing, silent configuration
                    decision here) — or the PLUGIN authors, if the two
                    rules were never meant to apply to overlapping paths
                    (an overly broad `pathMatcher` is the plugin's own
                    defect, symmetric to an overly broad hook `matcher`,
                    §6).
```

### Liskov rule for `rateLimit`

A plugin's rate-limit contribution may only **narrow** the traffic allowed
on paths it specifically owns (its own endpoints); it must not declare a
`pathMatcher` broad enough to silently override the rate-limit policy for
paths owned by the base system or by other plugins, because — given
first-match-wins resolution — doing so **strengthens a restriction the
matched request's actual owner never agreed to**, which is a narrowing of
that owner's contract with its callers.

---

## 10. `$ERROR_CODES` — a plugin's own blame-taxonomy extension

```
Contract:   $ERROR_CODES : { [code: string]: RawError }
```

* **Requires:** each code is a stable, unique string within this plugin's
  own vocabulary (uniqueness *across* plugins is not currently
  cross-checked — see below).
* **Ensures:** these codes become part of the auth instance's overall error
  vocabulary — surfaced through `$ERROR_CODES` on the server export and
  (via `$InferServerPlugin`, see `03-client-plugin-contract.md`) through the
  client's own `$ERROR_CODES`, letting application code match on
  plugin-specific error codes with the same ergonomics as base-system codes
  (`BASE_ERROR_CODES`).
* **Invariant:** a plugin's error codes are a pure **addition** to the
  system's blame taxonomy (per `00-methodology/03` — every error is an
  assignment of fault, and a named code is how that assignment is
  communicated to the caller). Two plugins declaring the *same code string*
  with different meanings is a latent ambiguity: whichever plugin's
  `$ERROR_CODES` object is merged last into the aggregate (accumulated the
  same way plugin endpoints are, by key) silently shadows the other's
  definition of that code for documentation/type purposes, though each
  plugin's own runtime `APIError.from(status, ITS_OWN_CODE_OBJECT)` calls
  still carry that plugin's own message text regardless of the merge —
  the ambiguity is representational (which plugin "owns" that code string
  in the aggregate type/docs), not a runtime misrouting of errors.

```
On violation (two plugins reuse the same code string for different faults):
   Raised as:      no runtime error; a documentation/type-level ambiguity
                    only, as described above.
   Blamed party:   the PLUGIN that chose a code string colliding with an
                    already-published one (the later-defined plugin is
                    expected to namespace its own codes distinctly, since
                    it is the one with visibility into the broader
                    ecosystem's already-taken names at publish time — the
                    same "later author bears the collision-avoidance
                    burden" convention used for schema field naming).
```

### Liskov rule for `$ERROR_CODES`

A plugin may only **add** new blame vocabulary; it must never redefine a
base-system error code's meaning (e.g. reusing `UNAUTHORIZED` for a
condition the base system does not consider unauthorized) — doing so
corrupts the caller's ability to pattern-match on codes with their
originally-documented meaning, which is exactly the kind of postcondition
the base system already promised callers and that a specialization must
preserve.

---

## 11. `adapter` — declared per-operation substitution (design intent)

```
Contract (as declared):  adapter : { [operationName: string]: (...args) -> Awaitable<any> }
```

The field's own documentation states its intent precisely: *"All database
operations that are performed by the plugin. This will override the default
database operations."* Read as a contract, this is a plugin claiming the
**positive** (producer) position at the `AdapterContract` boundary
(`00-methodology/02-higher-order-contracts.md` §4) for a **named subset** of
adapter operations — the plugin substitutes its own implementation of, say,
`findOne` for a given model, while every other adapter operation continues
to flow through the base adapter untouched.

* **Requires:** a substituted operation must satisfy the **exact same**
  domain→range arrow as the operation it replaces (the same conjunct of the
  `AdapterContract` — same argument shape, same result shape, same
  precondition on `where`/`data` well-formedness).
* **Ensures:** every caller of the substituted operation — including base-
  system endpoints that have no awareness this plugin exists — observes
  behavior indistinguishable, at the contract level, from the operation it
  replaced, except for whatever the plugin's documented reason for
  substituting is (e.g. adding encryption-at-rest transparently around
  `create`/`update` for one model).
* **Invariant — substitutability:** this is a direct instance of the
  Liskov rule for adapters already stated in `00-methodology/02` §4: *"any
  concrete adapter is a specialization of the abstract adapter contract,
  and must not narrow it."* A plugin substituting one operation is, for
  that operation, now standing in the position of "the concrete adapter,"
  and inherits that obligation in full: it must not narrow the precondition
  the base operation accepted, must not weaken the postcondition the base
  operation guaranteed, and must preserve every invariant of the surrounding
  `AdapterContract` (e.g. "if `transaction` is present, all adapter methods
  called inside the callback observe the same isolation guarantee" — a
  substituted operation must still honor an in-flight transaction it is
  called within).

**Evidence note on current wiring:** across the runtime composition path
examined (`context/create-context.ts`, `context/helpers.ts`,
`api/index.ts`), no code was found that reads a plugin's declared `adapter`
field and installs it as a per-operation override on `ctx.adapter`. The
substitution mechanism actually exercised by concrete plugins is coarser:
`init` returning `{ context: { adapter: <fully custom adapter> } }` would
replace the **entire** adapter object via `Object.assign`, and individual
plugins instead commonly keep their own adapter-shaped helper modules
(e.g. `organization/adapter.ts`) that they call directly from their own
endpoints, rather than substituting into the shared `ctx.adapter` at all.
For the purposes of this design-basis specification, the contract above is
the **declared intent** of the `adapter` field and is what a reimplementation
should honor structurally (a per-operation substitution point on the shared
adapter, with the Liskov obligation above) — a reimplementation is not
obligated to reproduce the current runtime's gap between declared type and
wiring.

```
On violation (a substituted operation narrows what the base operation
accepted, or weakens what it promised):
   Raised as:      whatever failure mode the now-unmet caller expectation
                    produces at the FIRST caller that relied on the
                    original, wider contract — commonly a thrown error from
                    code that assumed a case the substitute now rejects, or
                    silently wrong data from code that assumed a guarantee
                    the substitute no longer provides.
   Blamed party:   the PLUGIN that installed the substitution (positive
                    blame — it is standing in the supplier position for
                    every caller of that operation, including callers with
                    no knowledge the plugin exists).
   Recoverable by: the plugin author restoring full substitutability, or
                    scoping the substitution to a model/operation pair no
                    other code path depends on.
```

---

## 12. `options` and `$Infer` — no runtime arrow

`options` is the plugin's own constructor-argument record — it is consumed
entirely by the plugin's own closure (as seen in every concrete plugin: the
options object captured by the returned `BetterAuthPlugin` value is read
directly by that plugin's own endpoints/hooks/init, never by the generic
plugin-composition machinery). It carries no contract obligation *to the
plugin system* — its contract, if any, is internal to the plugin
(`options` is validated, or not, by the plugin's own construction code, as
seen in `jwt`'s constructor-time `BetterAuthError` throws for invalid
option combinations).

`$Infer` is purely a type-level carrier (documented in `plugin.ts` as
"types to be inferred") with no runtime representation or arrow — it exists
so a plugin can publish additional TypeScript types (e.g. richer inferred
shapes of its own domain objects) alongside its runtime value, consumed by
downstream type-level machinery (`InferDBFieldsFromPlugins`,
`$InferServerPlugin` on the client side, §`03-client-plugin-contract.md`).
Neither field is subject to a "Liskov rule" in this document's sense,
because neither participates in the composed system's runtime behavior.
