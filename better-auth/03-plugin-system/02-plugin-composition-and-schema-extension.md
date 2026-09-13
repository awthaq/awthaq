# Plugin Composition — Staging, Ordering, and Conflict Contracts

> Evidence base: `packages/better-auth/src/context/create-context.ts`,
> `packages/better-auth/src/context/helpers.ts` (`runPluginInit`),
> `packages/core/src/db/get-tables.ts` (`buildAuthTables`),
> `packages/better-auth/src/api/index.ts` (`getEndpoints`,
> `checkEndpointConflicts`, the `onRequest`/`onResponse` loops),
> `packages/better-auth/src/api/dispatch.ts` (`getHooks`,
> `runBeforeHooks`/`runAfterHooks`), `packages/better-auth/src/api/
> rate-limiter/index.ts` (`resolveRateLimitConfig`), and
> `packages/better-auth/src/api/middlewares/authorization.ts` (evidence of
> the runtime `hasPlugin` dependency check).

`01-plugin-contract.md` specifies each contribution kind in isolation. This
document specifies what happens when **many plugins' contributions of the
same kind meet** — the composition contract per
`00-methodology/02-higher-order-contracts.md` §3's staged-contract model.
The central fact this document establishes: **better-auth has no single,
uniform composition rule.** Each contribution kind resolves multi-plugin
collisions with a *different* strategy, and a design-by-contract
reimplementation must treat each strategy as a first-class, independently
specified decision — not infer one from the others.

---

## 1. The full staged pipeline, end to end

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     PLUGIN COMPOSITION — CONSTRUCTION TIME                    │
│                     (once, when the auth instance is built)                   │
│                                                                                │
│  options.plugins : BetterAuthPlugin[]     (array order is the ONLY explicit   │
│                                             ordering signal a plugin has —    │
│                                             there is no `dependsOn` field)    │
│                                                                                │
│   Stage 0 ── Base context construction                                       │
│      adapter, tables (pre-plugin-schema), cookies, password config,          │
│      generateId, rateLimit defaults, getPlugin/hasPlugin (over the           │
│      COMPLETE, already-concatenated plugin list, including any internal      │
│      plugins) are all installed on `ctx` before any plugin's `init` runs.    │
│      ⇒ every plugin's `init`, regardless of array position, can already      │
│        call `hasPlugin`/`getPlugin` for ANY plugin's id — presence-checking  │
│        is NOT staged; only CONTEXT/OPTIONS DELTAS are staged (§2).           │
│                                                                                │
│   Stage 1 ── Schema merge (buildAuthTables)                                  │
│      base tables (user/session/account/verification) ⊕ every plugin's       │
│      `schema` field-maps, folded left-to-right over options.plugins          │
│      (`reduce`) ⇒ ctx.tables                          [§3 below]            │
│      NOTE: this happens BEFORE any plugin's `init` runs (`tables` is built   │
│      once, up front, and handed into `ctx` — init cannot see a schema        │
│      shaped by another plugin's init-time decision).                        │
│                                                                                │
│   Stage 2 ── init₁ → init₂ → … → initₙ   (options.plugins array order)      │
│      ┌────────────┐   ┌────────────┐   ┌────────────┐                       │
│      │  init₁      │──▶│  init₂     │──▶│  init₃     │──▶ …                  │
│      │  ΔCtx₁       │  │ (sees Ctx  │   │ (sees Ctx  │                       │
│      │  ΔOpts₁      │  │  ⊕ ΔCtx₁)  │   │  ⊕ ΔCtx₁   │                       │
│      └────────────┘   └────────────┘   │  ⊕ ΔCtx₂) │                       │
│                                          └────────────┘                       │
│      Each initₖ's domain contract is "AuthContext as accumulated through     │
│      stage k-1" — Object.assign(context, Δcontext) after each stage,        │
│      options merged via defu after each stage. See §2.                      │
│                                                                                │
│   Stage 3 ── checkEndpointConflicts (log-only diagnostic, not a gate)        │
│      scans every plugin's `endpoints[*].path` for same-path/overlapping-     │
│      method collisions ⇒ logs a single logger.error listing them; does      │
│      NOT throw, does NOT prevent the instance from starting. [§4]           │
│                                                                                │
│   Stage 4 ── ctx.checkSchema = schemaCheckFor(ctx.adapter)   (deferred;       │
│      awaited lazily on first request / first endpoint call, not here)       │
└──────────────────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────────────┐
│                     PLUGIN COMPOSITION — PER-REQUEST TIME                     │
│                                                                                │
│   onRequest₁ → onRequest₂ → … → onRequestₙ   (array order; short-circuits    │
│                                                on first {response})   [§5]   │
│                         │                                                     │
│                         ▼                                                     │
│                 router path match → endpoint selected                        │
│                 (keyed union of base + ALL plugins' endpoints,               │
│                  last-plugin-in-array-order wins on key collision)   [§4]   │
│                         │                                                     │
│                         ▼                                                     │
│         hooks.before:  user-global (unconditional) → plugin₁ → … → pluginₙ   │
│                         (each matched hook's context-delta chains into the   │
│                          next; first non-context-delta return HALTS)  [§6]  │
│                         │                                                     │
│                         ▼                                                     │
│                    endpoint handler executes                                 │
│                         │                                                     │
│                         ▼                                                     │
│         hooks.after:   user-global (unconditional) → plugin₁ → … → pluginₙ   │
│                         (each matched hook may replace `returned`;           │
│                          later matches see the prior replacement)     [§6]  │
│                         │                                                     │
│                         ▼                                                     │
│   onResponse₁ → onResponse₂ → … → onResponseₙ  (SAME array order as          │
│                                    onRequest — not reversed)          [§5]  │
└──────────────────────────────────────────────────────────────────────────────┘
```

Rate-limit rule resolution (`resolveRateLimitConfig`) is orthogonal to the
request pipeline above — it runs once, early, inside `onRequestRateLimit`
(itself invoked from the router's `onRequest`, before any plugin `onRequest`
runs) and independently walks `options.plugins` taking the **first** match
(§7) — the one contribution kind in this whole system that resolves
first-wins rather than last-wins or all-run.

---

## 2. The `init` staging contract, precisely

Per `00-methodology/02-higher-order-contracts.md` §3:

```
init₁ : AuthContext(Stage1)                          -> ΔContext₁ ⊕ ΔOptions₁
init₂ : AuthContext(Stage1) ⊕ ΔContext₁ ⊕ ΔOptions₁  -> ΔContext₂ ⊕ ΔOptions₂
init₃ : AuthContext(Stage1) ⊕ ΔContext₁ ⊕ ΔContext₂
                              ⊕ ΔOptions₁ ⊕ ΔOptions₂ -> ΔContext₃ ⊕ ΔOptions₃
   ...
```

* **What a plugin at position *k* MAY assume is present:** every field the
  base system (Stage 0/1) established, plus the **observable, merged**
  effect of every plugin at position `< k`'s `context`/`options` delta. It
  may not assume *which* earlier plugin contributed a given field — only
  that, if a field is present, it is present regardless of provenance
  (`AuthContext` carries no per-field provenance tag).
* **What a plugin at position *k* MUST NOT assume:** anything about a
  plugin at position `> k` — including that plugin's mere **existence**.
  There is no dependency-declaration field on `BetterAuthPlugin` (no
  `dependsOn`/`requires` key exists in `packages/core/src/types/plugin.ts`)
  and no load-time enforcement of plugin ordering. A plugin that needs
  another plugin's capability has exactly one supported mechanism, and it
  is a **runtime**, not a **load-time**, check:

```
Operation:     capability dependency check
Requires:      the depending plugin calls `ctx.hasPlugin("other-id")` (or
               `ctx.getPlugin("other-id")`) — evidenced in
               `api/middlewares/authorization.ts`: an organization-scoped
               authorization middleware calls
               `ctx.context.hasPlugin("organization")` and throws
               `APIError("BAD_REQUEST", ...)` if it is absent.
Ensures:       `hasPlugin`/`getPlugin` see the COMPLETE, final plugin list
               (concatenated once in `create-context.ts` before Stage 2
               begins) regardless of the calling plugin's own position in
               the array — presence-checking is NOT subject to the staging
               restriction that `init`'s CONTEXT reads are subject to.
               A plugin MAY safely check "is X present" from anywhere,
               including its own `init`, regardless of array order; it may
               NOT safely read "whatever X's init contributed to the
               context" unless X is guaranteed to run before it (array
               order), because init-contributed fields ARE staged.
Invariant:     the dependency is discovered lazily, per call, not declared
               up front — there is no "the auth instance refuses to start
               because plugin B requires plugin A" failure mode in the
               evidence found. The failure, when it occurs, happens at the
               FIRST request that reaches the dependent code path, not at
               construction time.
On violation:  (the required plugin is absent)
   Raised as:      whatever error the depending plugin's own code chooses
                   to throw on a failed hasPlugin check — evidenced as
                   APIError("BAD_REQUEST") in the organization-authorization
                   case (a 4xx-class error, even though the actual fault is
                   a composition/deployment mistake, not a malformed
                   request from the end user).
   Blamed party:   the INTEGRATOR who composed a plugin list where a
                   dependent plugin's capability requirement went unmet —
                   this is the specification's canonical example of a
                   THIRD blame category the base Client/Supplier model
                   (00-methodology/03 §2) does not name outright: the party
                   that assembles the plugin list is neither the end-user
                   client of the running instance nor a single plugin's
                   supplier — it is the operator of better-auth itself.
                   This spec treats integrator-blame as a specialization of
                   SUPPLIER-side blame (00-methodology/03 §2's "positive"
                   position): the composed instance, as a whole, failed to
                   deliver a capability its own wiring implied it would —
                   from the true end-user's perspective, that is still a
                   server-side (positive) fault, not a client input fault,
                   even though the immediate HTTP status observed
                   (BAD_REQUEST, in the evidenced case) reuses a
                   client-error-shaped code. A reimplementation SHOULD NOT
                   reuse a 4xx-class code for this failure mode; it is
                   configuration-blame, not input-blame.
   Recoverable by: the integrator adding the missing plugin to
                   `options.plugins`, or removing/reconfiguring the
                   dependent plugin so it degrades gracefully instead of
                   assuming the capability.
```

### A note on "dependency-aware compilation"

No evidence was found, anywhere in the composition path examined
(`create-context.ts`, `helpers.ts`, `get-tables.ts`, `api/index.ts`,
`api/dispatch.ts`), of a compile-/construction-time mechanism that
**reorders** plugins to satisfy a declared dependency, or that **refuses to
construct** the auth instance when a dependency is missing. The only
construction-time cross-plugin check evidenced is `checkEndpointConflicts`
(§4), which is path-collision detection, not dependency resolution. The
actually-implemented dependency mechanism is exclusively the request-time
`hasPlugin`/`getPlugin` pattern above — a **runtime capability query**, not
a **load-time precondition**. A reimplementation that wants true
dependency-aware compilation (reordering `init`, or refusing to construct
on a missing dependency) would be *adding* a capability beyond what this
codebase evidences, not preserving one — worth flagging explicitly if that
guarantee is a design goal for the Effect-native version, since it changes
the failure mode above from "request-time 4xx" to "construction-time
refusal," which is a strictly stronger, and therefore Liskov-legal,
specialization of this contract (per `01-design-by-contract.md` §5: a
supplier may always strengthen what it guarantees).

---

## 3. Schema field merge contract — the same table, contributed by many plugins

```
Operation:     schema table merge (buildAuthTables, folded over
               options.plugins with Array.reduce)
Requires:      each plugin's `schema[tableName].fields` is a valid field-map
               (01-plugin-contract.md §7)
Ensures:       the merged table's `fields` is the union of every
               contributing plugin's field-maps, keyed by field name;
               `indexes` is the de-duplicated union (by (name, fields,
               unique) triple) of every contributing plugin's indexes;
               `disableMigrations` is true if ANY contributor set it
               (`??=`-style: `value.disableMigration ?? acc[key]?.
               disableMigrations` — sticky-true, first truthy value in
               fold order wins and later `undefined`s do not clear it).
Invariant:     a table name is a SHARED namespace across every plugin that
               contributes to it — there is no per-plugin field
               namespacing (e.g. no automatic `pluginId_fieldName`
               prefixing). Two plugins are free to extend the SAME base
               table (user, session, account, verification) with
               DIFFERENT field names — this is the supported, common case
               (evidenced: `organization` adds `activeOrganizationId`/
               `activeTeamId` to `session`; `two-factor` adds its own,
               separately-named `twoFactor` table entirely, avoiding the
               shared-table case for its own data).
On violation:  (two plugins declare the SAME field name on the SAME table)
   Raised as:      NOT raised — no error, no warning, no log line. The
                   merge is a plain object spread,
                   `{ ...acc[key]?.fields, ...value.fields }`, executed
                   once per plugin in `options.plugins` array order inside
                   `Array.reduce`. The LAST plugin (in array order) to
                   declare that field name wins; every earlier declaration
                   of the same field name for that table is silently
                   discarded from the merged schema — its `type`,
                   `required`, `validator`, `transform`, `defaultValue`,
                   everything, is gone.
   Blamed party:   Per 00-methodology/03 §4 ("first cause, not first
                   observer"): the plugin whose declaration causes the
                   collision to exist is at fault, but the system provides
                   no mechanism to determine, after the fact, which of the
                   two plugins is the "intruder" — from the schema
                   compiler's point of view they are two equally valid
                   contributions to the same key. In practice, blame
                   resolves to the INTEGRATOR who combined two plugins
                   whose schema contributions were never designed to
                   coexist on that field, UNLESS one plugin's documentation
                   explicitly claims ownership of that field name on that
                   table (in which case the OTHER plugin, which redefined
                   an already-claimed name without coordinating, is at
                   fault).
   Recoverable by: renaming the colliding field via whichever plugin
                   exposes a field-remapping option (several plugins accept
                   a `fields: { logicalName: "physicalColumnName" }` -style
                   override precisely so integrators can resolve exactly
                   this kind of collision without forking the plugin), or
                   not combining the two plugins on that table.
```

### Diagram — schema merge as staged folding, not a single set union

```
   base tables (user, session, account, verification)
              │
              ▼
   ⊕  plugin₁.schema        (folded via Array.reduce, options.plugins order)
              │  { user: { fields: { A, B } }, ... }
              ▼
   ⊕  plugin₂.schema
              │  { user: { fields: { B', C } }, ... }   ← B' silently
              │                                            replaces B,
              │                                            no diagnostic
              ▼
   ⊕  plugin₃.schema
              │  { session: { fields: { D } }, ... }    ← new table-field
              ▼                                            pair, no conflict
        ctx.tables  (final, frozen for the life of the instance —
                      NOT re-derived per request)
```

---

## 4. Endpoint / path collision contract

Two independent mechanisms exist, and they check **different things**:

### 4a. Key-level collision (silent, last-wins) — `getEndpoints`

```
Operation:     endpoint table assembly
               (`options.plugins.reduce((acc, p) => ({...acc, ...p.endpoints}), {})`,
               then spread again under the base-system's own endpoint map)
Requires:      each plugin's `endpoints` is a `{ name: Endpoint }` map
               (01-plugin-contract.md §3)
Ensures:       the FINAL `endpoints` object has exactly one value per key —
               base-system endpoints first, then every plugin's endpoints
               folded left-to-right in `options.plugins` order.
Invariant:     the KEY (the property name, e.g. `enableTwoFactor`) is the
               unit of collision here — NOT the HTTP path.
On violation:  (two plugins export an endpoint under the SAME key,
               e.g. both naming their endpoint `verifyEmail`)
   Raised as:      no error. Later plugin's endpoint value silently
                   replaces the earlier one at that key — the earlier
                   plugin's endpoint becomes entirely unreachable via
                   `auth.api.<key>` (though it may still be reachable via
                   its own PATH if that path never collided — see 4b — a
                   key collision and a path collision are independent
                   failure modes that can occur separately).
   Blamed party:   INTEGRATOR (two plugins whose authors did not coordinate
                   naming, composed together) — or, if one plugin's docs
                   established the key name first and the other reused it
                   deliberately, the LATER-DEFINED plugin.
```

### 4b. Path-level collision (diagnosed, but NOT gated) — `checkEndpointConflicts`

```
Operation:     endpoint path-conflict diagnostic
               (walks every plugin's endpoints, groups by `endpoint.path`,
               and within each path group checks whether the declared HTTP
               methods overlap — an explicit method list conflicts with
               another explicit list sharing an entry, and ANY entry with
               no explicit method, treated as wildcard "*", conflicts with
               everything else at that path)
Requires:      each endpoint's `options.method` (if present) is a string or
               array of HTTP method names; absence is treated as "*"
               (matches/conflicts with every method).
Ensures:       a single `logger.error(...)` listing every conflicting
               (path, methods, plugin-ids) triple — this runs once, during
               `createAuthContext`, for its side effect on the log only.
Invariant:     this check NEVER throws and NEVER prevents the auth
               instance from being constructed or from serving requests —
               it is strictly a diagnostic. Router-level dispatch behavior
               for a genuinely-conflicting path/method pair is whatever the
               underlying router's own last-registration-wins or
               first-match-wins semantics produce (out of scope for the
               plugin system itself — this is a router-contract concern).
On violation:  (two plugins register overlapping methods at the same path)
   Raised as:      a logged error message only; the instance starts and
                   serves requests regardless. This is the ONE contribution
                   kind where the system affirmatively DETECTS the
                   conflict yet still deliberately chooses NOT to fail
                   construction — a documented "log and continue" contract,
                   distinct from every silent (undetected) collision above.
   Blamed party:   INTEGRATOR (per the log message's own remediation text:
                   "use only one of the conflicting plugins," "configure
                   the plugins to use different paths," or "ensure plugins
                   use different HTTP methods for the same path" — all
                   three remedies are integrator-side actions, not
                   plugin-author-side or end-user-side).
   Recoverable by: the integrator acting on one of the three remedies the
                   diagnostic itself names.
```

### Diagram — the two collision checks are orthogonal

```
                     KEY collision              PATH collision
                     (getEndpoints)              (checkEndpointConflicts)
                          │                              │
     detected?            NO — silent                    YES — logged
     gates construction?  n/a (never checked)             NO — logs only
     resolution           last-plugin-in-array-order      whatever the
                           wins at that key                router does with
                                                             the ambiguous
                                                             registration
```

A pair of plugins can collide on ONE of these axes without colliding on the
other: same endpoint key, different path (silent key-shadowing, no log);
same path, different key (logged path conflict, but `auth.api.*` still
resolves both keys — only the HTTP-routed path is ambiguous).

---

## 5. `onRequest`/`onResponse` ordering contract (recap, composition-focused)

Already specified per-contribution in `01-plugin-contract.md` §5; the
composition-level fact worth isolating here: **the plugin array is walked
in the identical order for both directions.** This means a plugin late in
`options.plugins` runs its `onRequest` LAST (deepest layer for the
request-inbound direction) but ALSO runs its `onResponse` LAST (outermost
layer would be the conventional middleware-stack expectation — better-auth
does not do this). A plugin wanting to see a response before a
later-in-array plugin's `onResponse` has already rewritten it must be
ordered AFTER that plugin in `options.plugins`, not before, which is
counter to the intuition many middleware systems train ("last registered =
outermost, sees the response first").

```
Operation:     onRequest/onResponse chain composition
Requires:      plugin order in options.plugins reflects the ACTUAL intended
               observation order for both the request-inbound and the
               response-outbound direction identically.
On violation:  (an integrator assumes response-phase order is reversed,
               as in a conventional onion-model middleware stack)
   Raised as:      no error — silently wrong behavior; a later plugin's
                   onResponse will not see an earlier plugin's rewrite
                   applied "on the way out" the way an onion model would
                   deliver it, because both phases share one order.
   Blamed party:   INTEGRATOR (a misunderstanding of this system's actual,
                   non-onion ordering contract) — this is exactly the kind
                   of composition-contract fact this document exists to
                   make explicit rather than left to be discovered.
```

---

## 6. Hook ordering contract (recap, composition-focused)

Per `01-plugin-contract.md` §6: user-configured global hooks always run
first (unconditionally matched) within their phase, then plugin hooks in
`options.plugins` array order. Two plugins whose `before`-hook matchers both
match the same request run BOTH, in array order, each seeing the previous
one's context delta merged in; there is no key-based collision here at all
because hooks are an **ordered list**, not a **keyed map** — every matching
hook always runs (unless an earlier one halts the chain by returning a
non-context-delta value). This is the "all-run, chained" resolution
strategy, distinct from both "last-wins" (schema/endpoints) and
"first-wins" (rateLimit).

```
Operation:     multi-plugin hook chain resolution within one phase
Requires:      each hook's matcher only matches contexts it is actually
               scoped to (01-plugin-contract.md §6's Liskov rule)
Ensures:       every hook whose matcher returns true for this request runs,
               in the fixed order (user-global, then plugin array order);
               a `before`-hook returning a context delta lets the chain
               continue to the NEXT matched hook; returning anything else
               halts immediately and skips every hook after it in BOTH the
               rest of `before` AND the endpoint handler itself (an `after`
               phase never runs for a request halted in `before`, since the
               handler that would produce the value `after` operates on
               never executes).
Invariant:     hook execution order is a total order across ALL plugins
               combined, not a per-plugin-independent set — two plugins'
               hooks on the same endpoint interact through shared,
               sequential state (the accumulating context delta / the
               accumulating `returned` value), not in isolation.
On violation:  (two plugins' before-hooks both match the same request and
               the later one's context delta silently overwrites a field
               the earlier one set, because the merge for hook context
               deltas is defu with array-REPLACEMENT — objects deep-merge,
               but any array-valued field the earlier hook set is wholly
               replaced, not concatenated, by a later hook that also sets
               that field)
   Raised as:      no error — silent overwrite of the array field.
   Blamed party:   the LATER hook's plugin, per "first cause" — it produced
                   the overwriting delta. (Object-valued fields do NOT have
                   this failure mode, since defu deep-merges objects; only
                   array-valued fields are replace-not-merge, which is a
                   narrower, evidenced special case worth calling out
                   explicitly: `defuReplaceArrays` in `dispatch.ts`.)
```

---

## 7. Rate-limit rule resolution contract (recap, composition-focused)

Already specified in full in `01-plugin-contract.md` §9. The composition
fact worth isolating: this is the **only** contribution kind in the entire
system that resolves multi-plugin collision by **first-match-in-array-order
wins** (`break` on first match). Every other keyed/collidable contribution
(`schema`, `endpoints`, `$ERROR_CODES`) resolves last-wins; ordered,
non-keyed contributions (`hooks`, `onRequest`/`onResponse`) resolve
all-run/chained. A reimplementation must treat this as a deliberately
distinct policy per contribution kind, not normalize all collisions to one
rule.

```
┌──────────────────────────────────────────────────────────────────────┐
│               COLLISION RESOLUTION STRATEGY, BY CONTRIBUTION KIND      │
├───────────────────┬────────────────────────────────────────────────┤
│ schema (same field)│ last-plugin-in-array-order wins, SILENT         │
│ endpoints (same key)│ last-plugin-in-array-order wins, SILENT        │
│ endpoints (same path)│ diagnosed (logged), NOT gated, router-defined │
│ $ERROR_CODES (same code)│ last-plugin-in-array-order wins (docs/types)│
│ rateLimit (same path)│ FIRST-plugin-in-array-order wins, SILENT       │
│ hooks (same request)│ ALL run, in array order, CHAINED (no collision)│
│ onRequest/onResponse│ ALL run, in array order (both directions),     │
│                     │   with onRequest able to SHORT-CIRCUIT          │
│ middlewares (same path)│ ALL run (union), array order, no collision  │
│ init (context field)│ Object.assign, shallow — later plugin's TOP-   │
│                     │   LEVEL key wins if it re-sets the same key      │
│ init (options field)│ defu, deep — EARLIER plugin's value wins on     │
│                     │   scalar leaf conflict (defu keeps the first-   │
│                     │   seen value; note this is the OPPOSITE         │
│                     │   precedence direction from `context`'s merge)  │
└───────────────────┴────────────────────────────────────────────────┘
```

The last two rows are worth dwelling on because they are easy to get
backwards: `runPluginInit` folds `options = defu(options, restOpts)` per
plugin, and `defu(target, source)` keeps `target`'s value wherever both
define a scalar leaf — so across the fold, the **first** plugin (in array
order) to set a given options leaf wins, while `context` is merged with
`Object.assign(context, result.context)`, where the **last**-assigned
(i.e., **later**-array-order) plugin's top-level key wins. `init`'s two
return channels — `context` and `options` — have **opposite** precedence
directions. This asymmetry is a specification fact, not an accident to be
"fixed" by a reimplementation without deliberate reconsideration — but it
is exactly the kind of asymmetry a design-by-contract reimplementation
should either preserve consciously or replace with a single, documented
rule, never leave implicit.

---

## 8. Summary obligations for a reimplementation

1. Every contribution kind's collision-resolution strategy (the table in
   §7) must be **individually and explicitly** specified — there is no
   single "last plugin wins" or "first plugin wins" rule that covers the
   whole system, and treating this as a uniform rule during reimplementation
   would silently change observable behavior for existing plugin
   combinations.
2. The `init` staging contract (§2) — later plugins may read earlier
   plugins' merged deltas, never the reverse — must be preserved exactly,
   because it is the load-bearing assumption every multi-plugin
   configuration in the ecosystem is already written against.
3. Dependency-on-another-plugin is, today, an **unenforced, runtime-only**
   convention (`hasPlugin`/`getPlugin`), not a load-time contract. A
   reimplementation MAY strengthen this to a load-time precondition (this is
   Liskov-legal — strengthening a supplier's guarantee) but MUST NOT weaken
   it to something less discoverable than the current explicit runtime
   check.
4. The two "detected but only logged" (`checkEndpointConflicts`) and
   "detected and silently resolved" (schema/endpoint key merges) categories
   are different severities of the same underlying problem — a plugin
   composition contract violation — and should be modeled as such: both are
   INTEGRATOR-blamed precondition violations on the *set* of plugins as a
   whole, differing only in whether the current implementation happens to
   surface a diagnostic.
