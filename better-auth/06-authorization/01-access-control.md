# Access Control — the Foundational Statement/Role/Permission Contract

> Reads against `00-methodology/01-design-by-contract.md` (Hoare-triple
> vocabulary), `02-higher-order-contracts.md` (arrow contracts — the
> permission check is written as one), and
> `03-theory-of-contracts-and-blame.md` (blame assignment). Not redefined
> here.

This document specifies the single authorization primitive that every other
document in this directory builds on without restating: `02-admin-plugin.md`
instantiates it once, `03-organization-plugin.md` instantiates it once per
organization (statically and dynamically), and `04-api-key-plugin.md` reuses
it verbatim to check a key's stored permissions. Nothing below is specific to
users, organizations, or admin — it is the vocabulary those domains are
expressed in.

---

## 1. The domain model: statements, roles, permissions

```
┌─────────────────────────────────────────────────────────────────────┐
│                         STATEMENTS  (a universe)                     │
│                                                                        │
│   resource-name  ──▶  [ action-literal, action-literal, ... ]         │
│                                                                        │
│   e.g.   "user"    ──▶ ["create","ban","delete","update", ...]        │
│          "session" ──▶ ["list","revoke","delete"]                    │
│                                                                        │
│   This is the DOMAIN CONTRACT: it declares, once, every action that   │
│   will ever be meaningful for a resource in this deployment. It is    │
│   not itself a grant of anything — it is the dictionary a role draws  │
│   from.                                                                │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   │  createAccessControl(statements)
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    ACCESS-CONTROL INSTANCE                            │
│                                                                        │
│   .statements   — the universe, retained for later validation         │
│   .newRole(partial-statements)  — builds a Role scoped to this        │
│                                    universe                            │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   │  .newRole({ user: ["ban"], ... })
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                              ROLE                                      │
│                                                                        │
│   .statements   — a resource -> action[] map that is a SUBSET of      │
│                    (or equal to) the parent universe, per resource     │
│   .authorize(request, connector?) -> AuthorizeResponse                │
│                                                                        │
│   A role is nothing more than a named, closed-over subset of the      │
│   universe, plus one pure decision function over that subset.         │
└─────────────────────────────────────────────────────────────────────┘
```

A **statement** is the domain contract for one resource: the finite,
declared set of action-literals that may ever be checked against that
resource. A **role** is a named set of granted statements — a subset
selection over that universe, one resource at a time. A **permission
check** is the application of a role's `authorize` arrow to a concrete
request.

### 1.1 Where the universe is enforced, and where it is not

The "role's statements are a subset of the universe's statements"
relationship is enforced by the type system at the point a role is
authored through `newRole`. The runtime primitive itself performs **no
such check** when a role is constructed: `authorize` only ever consults
the role's own `.statements` map, never the parent universe. Two
consequences follow, and both matter for a reimplementation:

* A role assembled by any path other than the typed builder (for example,
  a role loaded from a database at runtime — see the organization
  plugin's dynamic-access-control feature in `03-organization-plugin.md`)
  can in principle carry actions or resources the universe never declared,
  and nothing in this primitive will reject that at construction time.
* The one place in the reference implementation that *does* perform a
  runtime universe check is a caller sitting above this primitive (the
  organization plugin's dynamic-role endpoints reject a resource key not
  present in the deployer's universe before persisting a new role). That
  check is not part of the access-control primitive's own contract — it
  is a caller-side precondition, documented at the caller (see
  `03-organization-plugin.md §7`).

A reimplementation is free to make universe-membership a runtime
invariant of role construction itself; better-auth does not.

---

## 2. The permission-check contract

```
Operation:     authorize
Arrow shape:   Role  ×  PermissionRequest  ×  Connector?  ->  AuthorizeResponse

  where
    PermissionRequest = { [resource]: ActionList | { actions: ActionList, connector } }
    ActionList        = action-literal[]
    Connector         = "AND" | "OR"                         (default "AND")
    AuthorizeResponse = { success: true } | { success: false, error }

Requires:
  - The role against which the check is performed already exists and its
    `.statements` reflect exactly the actions it was granted at
    construction time (see Invariant below) — the caller does not pass a
    role identifier, it holds the role value itself.
  - `PermissionRequest` is either an object whose values are each either
    an action-list or an `{ actions, connector }` pair. Any other shape
    (not an object, or a value that is neither form) is a malformed
    request.

Ensures (per resource named in the request):
  - If the resource is NOT present in the role's own statements:
      - under a top-level AND: the whole check fails immediately
        ("unknown resource"), with no further resources evaluated.
      - under a top-level OR: that resource contributes nothing and
        evaluation continues to the next one (an unknown resource is
        never treated as a failure by itself under OR — only as a
        non-contribution).
  - If the resource IS present, its request is evaluated against the
    role's allowed actions for that resource using the resource's own
    connector (default AND, or an explicit "OR" on that resource's
    request):
      - AND: every requested action for that resource must be present in
        the role's allowed-action list for it.
      - OR: at least one requested action must be present.
      - An EMPTY requested action list is never satisfied by either
        connector (vacuous falsehood, not vacuous truth).
  - Across resources, the TOP-LEVEL connector composes the per-resource
    outcomes:
      - AND (default): the first resource that fails the check above
        fails the whole call immediately; if every named resource
        succeeds, the call succeeds.
      - OR: the first resource that succeeds short-circuits the whole
        call to success immediately; if none succeed, the call fails.
  - An empty `PermissionRequest` (`{}`) always fails, under either
    top-level connector — there is no resource to authorize against.

Ensures (postcondition, precisely, answering "no more, no less"):
  a call `role.authorize(request)` returns `{ success: true }` if and only
  if every resource/action combination named in `request` is licensed by
  `role.statements` under the connectors specified above — the check
  reflects `role.statements` exactly: it grants nothing the role's
  statements do not contain, and it withholds nothing the role's
  statements do contain, for the specific resources and actions actually
  named in the request. (A role's ungranted resources are simply never
  consulted unless the caller names them.)

Invariant:
  - A role's `.statements` are fixed at construction (`newRole`/`role(...)`)
    and never mutated by `authorize`. Two calls to `authorize` on the same
    role with the same request always produce the same result — the
    function is pure and synchronous: no I/O, no hidden state, no
    dependency on wall-clock time or any external system. (Contrast this
    with the plugin-level `hasPermission` wrappers in `02` and `03`, which
    are asynchronous because they may first resolve *which* role object to
    check against — e.g. by loading a dynamic role from storage — before
    delegating to this same pure `authorize`.)

On violation:
  - Malformed `PermissionRequest` shape (neither an action-list nor an
    `{ actions, connector }` object): raised as an internal error at the
    access-control boundary itself.
    Blamed party: SUPPLIER — this can only be reached by a plugin or
    application constructing the request programmatically; a well-typed
    caller cannot produce it. It is never reachable from an end HTTP
    client's input, so the blame is on the code that builds the
    permission-request object, not on the request that ultimately
    triggered it.
  - A request that names only unknown resources under AND, or a request
    whose named actions are simply not granted: raised as an ordinary
    "not authorized" outcome (a value, `{ success: false, error }`, not a
    thrown error) — the primitive itself never distinguishes "actor is
    wrong" from "actor is malicious" from "actor mistyped a resource
    name"; that judgment belongs to the caller that turns this boolean
    into an HTTP-level FORBIDDEN and decides blame (CLIENT, ordinarily —
    an actor asking for something it was never granted).
```

---

## 3. Composability and extension: adding custom resources/actions

`createAccessControl` takes an arbitrary statements object; there is
nothing "built in" to the shape of a resource name or action literal.
Extending the model — adding a new resource, or new actions on an
existing resource — is done by constructing a **new** access-control
instance whose universe is the old one's plus the additions, and building
every role fresh against that new instance. This is a strict superset
relationship, and it satisfies the substitution rule from
`00-methodology/01-design-by-contract.md §5` in the following sense:

```
                 Base universe U = { user: [...], session: [...] }
                            │
                            │  add resource "apiKey", or add an action
                            │  to an existing resource
                            ▼
                 Extended universe U' ⊇ U   (per-resource superset)

     Rule preserved:  a role built against U continues to authorize
     every check it authorized before — nothing that was granted is
     revoked by the extension, because the extension only ever adds
     entries to the universe, and a role's own statements (a separate,
     independently-authored subset) are untouched by extending U.

     Rule NOT automatic: a role built against U does not automatically
     gain anything for the newly added resource/actions — a superset
     universe does not imply a superset grant. Extension only ever
     ENABLES a resource/action to be named in a *new* role; existing
     roles must be re-authored to grant it.
```

Concretely, this is how both `02-admin-plugin.md` and
`03-organization-plugin.md` work: each ships its own default statements
object and its own `createAccessControl` instance, and each exposes an
options field (`ac`, `roles`) that lets a deployer supply a *replacement*
statements object — typically the plugin's own defaults plus additional
application-specific resources — and rebuild every role (including the
plugin's own default roles, which the deployer is expected to redefine
against the new universe if they still want them). The plugin itself does
not merge universes for you; the deployer owns the merged universe and
authors every role — default and custom alike — against it.

The `role(...)` constructor is also exported and usable directly, without
ever calling `createAccessControl` — a role's statements do not have to be
authored against any particular universe at all. `createAccessControl` is
the disciplined path (declare the universe once, derive every role from
it, get type-level subset checking for free); using `role(...)` on its own
forfeits type-level closure to a universe. The runtime `authorize`
contract in §2 is identical either way.

---

## 4. Composition above this primitive: multiple roles per actor

This primitive checks exactly one role against one request. Every
concrete plugin in this tree (`02`, `03`) lets an actor hold **more than
one** role name simultaneously (a comma-joined role string on the actor
record) and defines its own outer composition rule — resolve each held
role name to a `Role` value, delegate each to `authorize` per §2, and
combine the individual booleans with a logical OR (the actor is
authorized if *any* held role would authorize it alone). That outer OR is
a property of the plugin-level `hasPermission` wrapper, not of this file's
`authorize` — it is documented once, at each plugin, rather than here,
because nothing in `access.ts` itself is aware that an actor can hold more
than one role.

---

## 5. Sequence: one `authorize()` call, resource by resource

```
   caller                         Role.authorize(request, topConnector)
     │                                        │
     │  { user: ["ban"], session: ["list"] }  │
     ├───────────────────────────────────────▶│
     │                                        │  for each [resource, req] in request:
     │                                        │
     │                                        │──▶ resource in role.statements?
     │                                        │       │
     │                                        │      no ──▶ topConnector AND? ──▶ FAIL "unknown resource"
     │                                        │       │                    OR? ──▶ continue (skip)
     │                                        │      yes
     │                                        │       │
     │                                        │       ▼
     │                                        │   normalize req -> {actions, connector}
     │                                        │       │
     │                                        │       ▼
     │                                        │   every/some action ∈ allowed[resource]?
     │                                        │       │
     │                                        │      yes ──▶ topConnector OR? ──▶ SUCCEED (short-circuit)
     │                                        │       │                   AND? ──▶ mark authorized, continue
     │                                        │      no  ──▶ topConnector AND? ──▶ FAIL "unauthorized: resource"
     │                                        │                          OR? ──▶ continue (not a failure)
     │                                        │
     │                                        │  loop ends without early return:
     │                                        │    any resource authorized? ──▶ SUCCEED
     │                                        │    none authorized?         ──▶ FAIL "Not authorized"
     │◀───────────────────────────────────────┤
     │   { success: true }  or  { success: false, error }
```

---

## 6. Summary: the arrow contract, restated once

```
authorize : (Role, PermissionRequest, Connector?) -> AuthorizeResponse

Domain contract  — Role is a fixed, already-constructed subset of a
                    statements universe; PermissionRequest names the
                    resources/actions being asked about; Connector
                    chooses AND/OR composition across the named
                    resources (default AND).

Range contract   — AuthorizeResponse is `{ success: true }` exactly when
                    every named resource/action combination is licensed
                    by Role.statements under the rules in §2; otherwise
                    `{ success: false, error }`, never a thrown error for
                    an ordinary "not granted" outcome.

Applies at       — every point in `02-admin-plugin.md` and
                    `03-organization-plugin.md` where a capability check
                    is described as "Requires: actor has role R" — that
                    phrase always means "some held role of the actor,
                    checked via this exact arrow, returns success for
                    the stated resource/action."
```
