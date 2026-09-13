# Contracts for Higher-Order Values

> Source: Robert Bruce Findler & Matthias Felleisen,
> *"Contracts for Higher-Order Functions"*, ICFP 2002.

Meyer's model (`01-design-by-contract.md`) is stated for routines whose
arguments and results are plain data — a precondition inspects an argument
value, a postcondition inspects a result value. better-auth is built almost
entirely out of a different shape of value: **functions passed to
functions** — hook handlers, matchers, plugin `init` callbacks, database
adapters, endpoint middleware, social-provider strategy objects. Findler &
Felleisen's extension is what lets this tree write contracts for those.

---

## 1. The problem plain contracts cannot express

A first-order contract can check a value immediately, in full, at the
moment it crosses a boundary:

```
REQUIRE  email : string, matches EMAIL_FORMAT
         └── checkable instantly: inspect the string now.
```

A **function-valued** argument cannot be checked this way. Consider a
plugin contributing a *hook matcher*:

```
matcher : (context) -> boolean
```

There is no way to verify, at the moment the plugin is registered, that
`matcher` "correctly identifies the requests it should intercept" — the
only way to observe its behavior is to **wait until it is actually called**
with a real `context`, and check the shape of what it consumes and what it
produces at that moment.

```
                 registration time                 invocation time
                        │                                 │
   plugin supplies      │                                 │
   matcher : ctx→bool   ▼                                  ▼
                 ┌─────────────┐                   ┌───────────────┐
                 │   cannot     │                   │  CAN check:    │
                 │   check      │   ── waits ──▶   │  ctx shape in,  │
                 │   anything    │                  │  boolean out    │
                 └─────────────┘                   └───────────────┘
```

This is the central move of the 1992→2002 extension: **a contract on a
function is discharged lazily, once per application, at each point where
the function is actually invoked with concrete arguments** — not once,
up front, on the function value itself.

---

## 2. The arrow contract

Findler & Felleisen write a function contract as an arrow between a
*domain* contract and a *range* contract:

```
  domain-contract  ->  range-contract
```

Wrapping a function `f` in this contract produces a **monitored** function
`f'` that, on every call:

```
┌────────────────────────────────────────────────────────────────────┐
│  caller invokes f'(arg)                                              │
│         │                                                             │
│         ▼                                                             │
│  1. check  arg  against  domain-contract                              │
│         │ fails → blame the CALLER (see 03-theory-of-contracts)       │
│         ▼ passes                                                      │
│  2. call the real f(arg)  →  result                                   │
│         │                                                              │
│         ▼                                                              │
│  3. check  result  against  range-contract                             │
│         │ fails → blame f, the SUPPLIER of the function                │
│         ▼ passes                                                       │
│  4. return result to caller                                            │
└────────────────────────────────────────────────────────────────────┘
```

This is the shape every hook, matcher, `init` function, and adapter method
in better-auth is specified with throughout this tree. A "plugin hook
contract" is always an arrow:

```
before-hook  :  HookContext  ->  { continue }  |  { modify(context) }  |  { halt(response) }
```

read as: *domain contract on the incoming request/session context the hook
is allowed to depend on*, arrow, *range contract on the three shapes of
outcome the pipeline knows how to interpret*.

---

## 3. Contracts on values that return more functions (curried / staged contracts)

better-auth's plugin `init` is a function that, when called with the
current `AuthContext`, may return **a delta to be merged into the
context** — the returned object is not a data value the pipeline "uses" so
much as a new *shape of subsequent contract* (new fields become legally
accessible to every plugin initialized afterward). Findler & Felleisen's
theory covers this as a **dependent / staged contract**: the range contract
of stage *N* is allowed to depend on the concrete value produced at stage
*N-1*.

```
init₁ : AuthContext        -> ΔContext₁
init₂ : AuthContext ⊕ ΔContext₁   -> ΔContext₂
init₃ : AuthContext ⊕ ΔContext₁ ⊕ ΔContext₂  -> ΔContext₃
        └──────────────────────┬──────────────────────┘
                    each stage's domain contract is
                    "whatever the previous stages
                     actually, observably, produced"
```

`03-plugin-system/02-plugin-composition-and-schema-extension.md` specifies
this staging precisely: what a later plugin may assume is present (already
merged) versus what it must not assume (a later plugin, of a not-yet-fixed
initialization order, is not guaranteed present).

---

## 4. Contracts on database adapters (a higher-order value with many arrows)

The database adapter is the largest higher-order contract in the system: a
**record of functions**, each itself an arrow contract, and the record as a
whole carries a contract too (e.g. "if `transaction` is present, all
adapter methods called inside the callback observe the same isolation
guarantee"). This tree treats a "contract on a bundle of operations" (a
record/interface) as the conjunction of:

```
AdapterContract =
   create      : (model, data)            -> Entity
 ∧ findOne     : (model, where)           -> Entity | null
 ∧ findMany    : (model, where, cursor)   -> Entity[]
 ∧ update      : (model, where, data)     -> Entity | null
 ∧ delete      : (model, where)           -> void
 ∧ transaction : (( TxAdapter ) -> R)     -> R
```

Each conjunct is specified independently in
`01-core-domain/04-database-adapter-contract.md` with its own
precondition/postcondition, but the *whole* is what a concrete adapter
(memory, SQL, Mongo, Redis) must satisfy to be substitutable for any other
— this is the higher-order analogue of Meyer's inheritance rule from §5 of
`01-design-by-contract.md`: any concrete adapter is a **specialization**
of the abstract adapter contract, and must not narrow it.

---

## 5. Why "lazy, at the boundary" matters for this spec's structure

Because a function contract can only be discharged when the function is
actually applied, this tree never describes a hook, matcher, plugin
`init`, or adapter method as "correct" in isolation. Every such document is
written as:

```
Contract:     <domain>  ->  <range>
Applies at:   <the specific point in the request pipeline / lifecycle
               where this value is actually invoked>
On mismatch:  <blamed party — see 03-theory-of-contracts-and-blame.md>
```

This is also why the plugin system documents (`03-plugin-system/`) are kept
separate from the concrete plugin behavior documents (`05` through `09`):
the *arrow shapes* a plugin is allowed to contribute are a fixed, small
vocabulary (init, endpoint, middleware, hook, schema, adapter override);
each concrete plugin is simply an instantiation of that vocabulary with
specific domain/range contracts, described feature-by-feature in the later
documents.
