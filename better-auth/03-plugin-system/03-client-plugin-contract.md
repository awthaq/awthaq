# The Client Plugin Contract, and Its Correspondence to the Server Plugin

> Evidence base: `packages/core/src/types/plugin-client.ts`
> (`BetterAuthClientPlugin`), `packages/better-auth/src/client/types.ts`
> (`$InferServerPlugin`-based type inference), `packages/better-auth/src/
> client/config.ts` (`getClientConfig` — the composition point),
> `packages/better-auth/src/client/vanilla.ts` (`createAuthClient`),
> `packages/better-auth/src/client/proxy.ts`
> (`createDynamicPathProxy` — the automatic RPC mechanism), and the paired
> `packages/better-auth/src/plugins/two-factor/{index,client}.ts` /
> `organization/{organization,client}.ts` server+client plugin pairs as
> correspondence evidence.

A **client plugin** is the mirror-image higher-order value to a server
plugin (`01-plugin-contract.md`): where a server plugin contributes to the
request-handling pipeline, a client plugin contributes to the **application-
facing SDK** that calls that pipeline. This document specifies (1) the
client plugin's own contribution surface as arrow contracts, and (2) the
**correspondence contract** between a server plugin and a client plugin
meant to pair with it — including what happens, and who is blamed, when the
two are installed inconsistently.

---

## 1. The client contribution surface, at a glance

```
┌───────────────────────────────────────────────────────────────────────┐
│                  BetterAuthClientPlugin  (a value)                     │
│                                                                         │
│  identity        id : LiteralString                                   │
│                  version? : string                                    │
│                                                                         │
│  ┌──────────────── TYPE-ONLY CORRESPONDENCE CHANNEL ─────────────────┐ │
│  │  $InferServerPlugin? : (a value never read at runtime — exists    │ │
│  │                          ONLY so TypeScript can unify this        │ │
│  │                          client plugin's inferred endpoint/schema/│ │
│  │                          error-code shape with a specific server  │ │
│  │                          plugin's `ReturnType`)                   │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  ┌──────────────── RUNTIME CONTRIBUTIONS ────────────────────────────┐ │
│  │  getActions?    : ($fetch, $store, options) -> { name -> fn }     │ │
│  │  getAtoms?      : ($fetch) -> { name -> Atom }                    │ │
│  │  pathMethods?   : { "/path" -> "POST"|"GET" }                     │ │
│  │  fetchPlugins?  : BetterFetchPlugin[]                             │ │
│  │  atomListeners? : { matcher, signal, callback? }[]                │ │
│  │  $ERROR_CODES?  : { code -> { code, message } }  (type + runtime) │ │
│  └────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────┘
```

Every field is specified below. The most important structural fact,
established up front: **most server-plugin endpoints require NO
corresponding client-plugin contribution at all.** The client's default
dispatch mechanism (`createDynamicPathProxy`, §2) can call ANY server
endpoint by naming convention alone — a client plugin exists to add
**ergonomics** (named actions, ready-made hooks/atoms, response-driven side
effects) on top of that default mechanism, not to establish basic
reachability.

---

## 2. The default correspondence: naming-convention dispatch (no plugin needed)

Before specifying client plugins at all, the baseline contract that makes
the whole client/server split work must be stated, because it is the
substrate every client-plugin contribution sits on top of:

```
Operation:     default (proxy-based) endpoint invocation
Contract:      authClient.<segment1>.<segment2>...(...) -> Promise<Result>
               translates, purely by property-access path, to:
                 POST|GET  /<segment1-kebab>/<segment2-kebab>/...
               (createDynamicPathProxy, proxy.ts) — method defaults to
               POST if a non-empty body is supplied, else GET, unless
               overridden by `knownPathMethods` (accumulated from every
               client plugin's `pathMethods`, §5).
Requires:      the caller's property-access path, kebab-cased and
               slash-joined, is EXACTLY the server endpoint's registered
               path (01-plugin-contract.md §3) — there is no independent
               registry of "known" server paths on the client; the proxy
               will construct and send a request to ANY path the caller
               spells out, whether or not a server plugin actually
               registered it.
Ensures:       nothing about the request being meaningful — the proxy is a
               dumb address-translator; a resulting 404 is the FIRST point
               at which "does the server actually have this?" is checked.
Invariant:     `authClient` provides no way to introspect, at the client's
               own runtime, whether a given server plugin is installed on
               the connected server — the client's only signals are (a)
               TypeScript's static type inference (via `$InferAuth`, if the
               application supplies its server's `BetterAuthOptions` type
               to the client for compile-time checking) and (b) the actual
               HTTP response at call time.
On violation:  (the application calls a path no server plugin registered)
   Raised as:      a NOT_FOUND-class HTTP response from the server's own
                   router (out of scope for the client plugin contract
                   itself — this is the request-pipeline's own routing
                   contract).
   Blamed party:   whoever wrote the call with a path the server does not
                   serve — typically the INTEGRATOR/application developer,
                   discovered at RUNTIME, not at TypeScript compile time,
                   UNLESS the application also configured `$InferAuth` to
                   point at its actual server's option type, in which case
                   TypeScript itself will refuse to compile a call to a
                   nonexistent route (a strictly EARLIER, and therefore
                   stronger, failure mode — see §4).
```

---

## 3. `getActions`, `getAtoms`, `pathMethods`, `fetchPlugins`, `atomListeners`

```
Contract:   getActions : ($fetch: BetterFetch, $store: ClientStore,
                          options: BetterAuthClientOptions | undefined)
                            -> Record<string, (...) -> Awaitable<any>>
Applies at: once, at `createAuthClient` construction (`getClientConfig`,
            `client/config.ts`), folded over `options.plugins` in array
            order.
```

* **Requires:** the plugin's action functions call `$fetch` (the shared,
  already-configured fetch client) rather than constructing their own HTTP
  client — this is how an action stays consistent with the rest of the
  client's base URL, credentials, and fetch-plugin pipeline.
* **Ensures:** every returned function becomes directly callable as
  `authClient.<name>(...)`, indistinguishable from a base-client method to
  application code.
* **Invariant — composition order:** `pluginsActions = defu(plugin.
  getActions(...), pluginsActions)` per plugin, in array order — `defu`
  keeps the FIRST (target) argument's value on conflict, and here the
  NEWLY-COMPUTED plugin's actions are passed as the target — so a **later**
  plugin's action name **overwrites** an **earlier** plugin's action of the
  same name (last-array-position wins, mirroring the server's own
  `endpoints` key-collision resolution in `01-plugin-contract.md` §3 /
  `02-plugin-composition-and-schema-extension.md` §4a).

```
Contract:   getAtoms : ($fetch: BetterFetch) -> Record<string, Atom<any>>
Applies at: once, at construction, folded via `Object.assign(pluginsAtoms,
            plugin.getAtoms($fetch))` per plugin, in array order.
```

* **Ensures:** every atom becomes available both directly on `$store.atoms`
  and, for non-`$`-prefixed keys, as a `use<Capitalized>` reactive hook on
  the returned client (`InferResolvedHooks`, `vanilla.ts`).
* **Invariant:** `Object.assign` — later plugin's atom of the same key
  silently replaces an earlier one, same resolution strategy as
  `getActions`.

```
Contract:   pathMethods : Record<string, "POST" | "GET">
Applies at: once, at construction, `Object.assign`-folded the same way.
```

* **Ensures:** overrides the proxy's own body-presence heuristic (§2) for
  specific paths — necessary for server endpoints that are semantically a
  mutation but accept no body (e.g. `/sign-out`), which the base heuristic
  would otherwise default to GET.
* **Invariant:** silently last-wins on key collision, identical pattern.

```
Contract:   fetchPlugins : BetterFetchPlugin[]
Applies at: once, at construction; concatenated (NOT keyed) onto the
            underlying `$fetch`'s own plugin list, alongside the built-in
            `lifeCyclePlugin` and (unless disabled) `redirectPlugin`.
```

* **Ensures:** every plugin's fetch-level hooks (`onRequest`, `onResponse`,
  `onSuccess`, `onError` at the HTTP-client layer — distinct from, and
  earlier/lower-level than, the server's own `onRequest`/`onResponse`
  contribution) run for EVERY request the client makes, not just requests
  to that plugin's own paths — this is a **global** interceptor
  contribution, unscoped by path, unlike the server's `middlewares`
  (path-scoped) or `hooks` (matcher-scoped).
* **Invariant:** union/concatenation, all run — no collision possible by
  construction (better-fetch's own plugin composition owns exact ordering
  and short-circuit semantics; out of scope here).

```
Contract:   atomListeners : { matcher: (path) -> boolean,
                              signal: "$sessionSignal" | string,
                              callback?: (path) -> void }[]
Applies at: per successful HTTP response (proxy.ts's `onSuccess`), evaluated
            against EVERY listener from EVERY plugin PLUS the client's own
            built-in session-invalidation listener.
```

* **Ensures:** when a response's request path matches a listener's
  `matcher`, the named `signal` atom is toggled (triggering reactive
  re-computation for every subscriber, e.g. re-fetching the session) and
  the optional `callback` runs.
* **Invariant:** ALL matching listeners across ALL plugins run for a given
  response (concatenation, not keyed replacement) — this is the client-side
  analogue of the server's `hooks` all-run/chained resolution, not the
  last-wins resolution used for `getActions`/`getAtoms`/`pathMethods`.
* A listener's `signal` name is a **string convention**, not a statically
  checked reference — a plugin naming a `signal` that no atom (built-in or
  plugin-contributed) actually defines fails at the point the listener
  fires (`pluginsAtoms[signal].set(...)` throws on `undefined`), not at
  plugin-registration time.

```
On violation (a client plugin's atomListener names a signal no atom
defines):
   Raised as:      a runtime TypeError at the first matching response,
                   inside the proxy's `onSuccess` handler.
   Blamed party:   the CLIENT PLUGIN author (positive blame — it declared a
                   reference to a capability, the named atom, that it did
                   not itself provide and that nothing else in the composed
                   client provides either).
```

### Liskov rule for client contribution kinds

Symmetric to the server-side rule (`01-plugin-contract.md`): a client
plugin's `fetchPlugins`/`atomListeners` may only **add** global observation
of traffic; they must not narrow what a well-formed request/response looks
like to OTHER plugins' fetch-plugins or listeners further down the chain
(e.g. must not strip headers another plugin's fetch-plugin depends on
reading). `getActions`/`getAtoms`/`pathMethods` may only add or intentionally
override named capabilities the application is expected to call by that
exact name — silently colliding with another plugin's name for an unrelated
purpose is an authoring defect, exactly as for the server's `endpoints` key
collisions.

---

## 4. `$InferServerPlugin` — the type-level correspondence channel

```
Contract (type-level only, NO runtime value or arrow):
   $InferServerPlugin? : ReturnType<typeof theCorrespondingServerPluginFactory>
```

* **Requires:** nothing at runtime — evidenced directly in `two-factor/
  client.ts`: `$InferServerPlugin: {} as ReturnType<typeof twoFa>` assigns
  an **empty object**, type-asserted to the server plugin's return type,
  purely so TypeScript's structural inference can flow the server plugin's
  `endpoints`/`schema`/`$ERROR_CODES` shape into the client's own inferred
  types (`InferPluginEndpoints`, `InferErrorCodes`,
  `InferAdditionalFromClient` — all in `client/types.ts`). The value `{}`
  is never read, called, or dereferenced by any runtime code path found in
  the composition evidence.
* **Ensures:** at COMPILE TIME ONLY, `authClient.<inferred method>(...)`
  gets the correct parameter/return types matching the paired server
  plugin's actual endpoint contracts, and `$ERROR_CODES`/`$Infer`-derived
  types (session/user shape with additional fields) reflect that server
  plugin's schema contributions.
* **Invariant:** this channel establishes NO runtime guarantee whatsoever —
  it is possible, and not detected by anything at construction or request
  time, for a client plugin's `$InferServerPlugin` type assertion to name a
  server plugin that is not actually installed on the server the client is
  configured to talk to (a wrong `baseURL`, a server that removed the
  plugin, or simply copy-pasting a client plugin's `$InferServerPlugin`
  import from documentation without installing the matching server plugin).

```
On violation (the client plugin's $InferServerPlugin corresponds to a
server plugin that is not actually running on the target server):
   Raised as:      NOTHING at plugin-registration or client-construction
                   time — this is a pure type-level assertion with no
                   runtime check. The first OBSERVABLE symptom is exactly
                   §2's baseline failure mode: a NOT_FOUND-class response
                   the first time application code calls an action this
                   client plugin exposes (via getActions or the default
                   proxy) for a path the server does not serve.
   Blamed party:   the INTEGRATOR — specifically, whoever configured the
                   CLIENT's plugin list without ensuring the SERVER's
                   plugin list is a superset of what every client plugin
                   assumes. This is the direct client-side analogue of
                   §2's dependency-on-another-plugin blame assignment in
                   02-plugin-composition-and-schema-extension.md §2: a
                   capability the composed system implies is present, is
                   not, and the mismatch surfaces lazily, at first use, as
                   a request-level failure rather than a construction-time
                   refusal.
   Recoverable by: installing the corresponding server plugin, OR — the
                   stronger, EARLIER-failing option — configuring the
                   client's `$InferAuth` to the server's actual
                   `BetterAuthOptions` type, which makes an inconsistent
                   client-plugin/server-plugin pairing a TYPE ERROR at
                   application build time rather than a runtime 404 (this
                   is the one mechanism in the evidenced system that CAN
                   catch this mismatch before a request is ever sent — but
                   it is opt-in, requires the application to actually wire
                   `$InferAuth`, and is a compile-time-only guarantee with
                   no runtime enforcement backing it, so an application
                   that skips this wiring, or whose client and server
                   packages drift out of sync at runtime despite matching
                   types at build time — e.g. a deployed server rolled
                   back after the client was built — gets no protection at
                   all).
```

---

## 5. The correspondence contract, stated directly

This is the section the task calls out explicitly: the obligation a paired
server-plugin/client-plugin pair jointly upholds, and what "transparent
precondition inheritance" means concretely.

```
Operation:     paired server-plugin / client-plugin correspondence
Requires (on the INTEGRATOR who composes BOTH sides of an application):
   for every client plugin C installed on the client whose
   $InferServerPlugin names a server plugin S:
      S must be installed on the server this client is configured to call,
      AND S's actual runtime behavior (endpoints, schema, error codes) must
      match what C's $InferServerPlugin asserts (i.e., client and server
      package/plugin VERSIONS must be compatible — there is no runtime
      version-compatibility handshake evidenced; this is an out-of-band
      obligation the integrator's build/deploy process must uphold).
Ensures (when the precondition holds):
   every precondition S's endpoint declares (e.g. "requires a valid
   session," "requires the request to be scoped to an organization the
   caller is a member of" — the request-pipeline's own endpoint contracts,
   cross-referenced conceptually, not restated here) is INHERITED
   TRANSPARENTLY by C's corresponding action: the application developer
   calling `authClient.twoFactor.enable(...)` does not need to independently
   know or re-declare "this requires an authenticated session" — that
   precondition lives entirely in the SERVER endpoint's own contract
   (`sessionMiddleware` in the evidenced `two-factor` plugin's
   `enableTwoFactor` endpoint), and the client action is a thin, contract-
   preserving proxy to it. The client plugin's OWN contract (getActions,
   §3) adds no additional precondition on top — it is exactly as permissive
   or restrictive as the server endpoint it calls, per the Liskov rule that
   a specialization may not narrow what it accepts beyond the base
   contract.
Invariant:     the correspondence is by CONVENTION (matching `id` strings
               and, more loosely, the plugin author choosing to write a
               $InferServerPlugin assertion at all) — it is NOT structurally
               enforced anywhere in the evidenced code. Nothing prevents:
               (a) a client plugin whose `id` differs from its
                   corresponding server plugin's `id` (evidenced pairs
                   happen to match — "two-factor"/"two-factor",
                   "organization"/"organization" — by author discipline,
                   not by a checked invariant);
               (b) a client plugin with NO $InferServerPlugin at all,
                   whose actions call arbitrary paths with no compile-time
                   correspondence signal whatsoever;
               (c) installing a client plugin without its server
                   counterpart, or a server plugin without any client
                   plugin at all (perfectly legal — many server plugins,
                   e.g. those consumed only via `auth.api.*` from
                   server-side code, have no client plugin and need none).
On violation:  see §4's violation clause — surfaces as a request-time
               NOT_FOUND/mismatched-shape failure, blamed on the
               INTEGRATOR, with an available-but-opt-in earlier detection
               path via `$InferAuth`-based type checking.
```

### Diagram — the correspondence contract as two independently-composed pipelines joined only by convention

```
   SERVER SIDE                                    CLIENT SIDE
  ┌─────────────────────────────┐               ┌─────────────────────────────┐
  │ options.plugins: [           │               │ options.plugins: [           │
  │   twoFactor({...})            │               │   twoFactorClient({...})    │
  │ ]                             │               │ ]                            │
  │                                │               │                              │
  │ id: "two-factor"    ◀────────────by convention only, unenforced────────────▶│ id: "two-factor"
  │ endpoints: {                  │               │ $InferServerPlugin:          │
  │   enableTwoFactor: ...        │  type-level   │   {} as ReturnType<typeof    │
  │     use: [sessionMiddleware]  │◀───inference──┤     twoFa>                   │
  │ }                              │   (compile-   │ getActions / pathMethods /   │
  │ schema: { twoFactor: {...} }  │    time only, │   atomListeners / fetchPlugins│
  │ $ERROR_CODES: {...}           │    opt-in via │                              │
  │                                │    $InferAuth)│                              │
  └─────────────────────────────┘               └─────────────────────────────┘
              ▲                                                │
              │                                                │
              └──────────── actual HTTP request/response ──────┘
                    (the ONLY runtime-checked correspondence:
                     does a request to this path get a non-404
                     response shaped the way the client expects?)
```

---

## 6. Summary: blame table for correspondence mismatches

```
┌────────────────────────────────────────┬──────────────────────────────┐
│ Mismatch                                 │ Blamed party / when detected │
├────────────────────────────────────────┼──────────────────────────────┤
│ Client plugin installed, matching server │ INTEGRATOR / request time    │
│ plugin absent                            │ (404-class), or build time   │
│                                           │ IF $InferAuth wired          │
├────────────────────────────────────────┼──────────────────────────────┤
│ Server plugin installed, no client plugin│ NOT a violation — legal and  │
│ (app calls it via raw path or auth.api.*)│ common; no correspondence    │
│                                           │ obligation exists this       │
│                                           │ direction                    │
├────────────────────────────────────────┼──────────────────────────────┤
│ Both installed, but versions/behavior    │ INTEGRATOR (build/deploy     │
│ drifted (server plugin's actual shape no │ process obligation, entirely │
│ longer matches what client's             │ out-of-band — no runtime     │
│ $InferServerPlugin asserted)             │ handshake exists)            │
├────────────────────────────────────────┼──────────────────────────────┤
│ Client plugin's id differs from its      │ CLIENT PLUGIN author (an     │
│ intended server plugin's id              │ authoring defect — breaks    │
│                                           │ the only naming convention   │
│                                           │ this correspondence relies   │
│                                           │ on, though nothing enforces  │
│                                           │ id-matching structurally)    │
├────────────────────────────────────────┼──────────────────────────────┤
│ Client action calls server endpoint that │ deferred to the SERVER       │
│ IS present, but caller's session/input   │ endpoint's own contract      │
│ doesn't satisfy the endpoint's own       │ (request-pipeline documents) │
│ precondition (e.g. no session)           │ — CLIENT (end-user/app) blame│
└────────────────────────────────────────┴──────────────────────────────┘
```

A design-by-contract reimplementation should treat the last row as the
*intended*, healthy failure mode (an ordinary precondition violation,
transparently inherited per §5) and every row above it as a **composition**
failure the current system either cannot detect at all, or can only detect
opportunistically via an opt-in type-level mechanism — both are candidates
for a stronger, structurally-enforced correspondence check (e.g. a runtime
capability-negotiation handshake) in an Effect-native design, which would
be a Liskov-legal strengthening of this contract, not a breaking change to
it.
