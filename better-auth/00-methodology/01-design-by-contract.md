# Design by Contract — Foundations

> Source: Bertrand Meyer, *"Applying 'Design by Contract'"*, IEEE Computer, 1992.

This document defines the vocabulary used by every other document in this
specification tree. It contains **no implementation details** — it defines
what a *contract* is, what obligations it distributes, and how better-auth's
behaviors are to be read as contracts rather than as narrative descriptions
of code.

---

## 1. The core idea: software elements as suppliers and clients

Meyer's model treats every unit of behavior (a routine, a module, a class) as
a **supplier** that offers a service to one or more **clients**. A contract
is the precise, mutually binding statement of:

```
┌──────────────────────────────────────────────────────────────────┐
│                         THE CONTRACT                              │
│                                                                    │
│   CLIENT'S OBLIGATION  ──────────────▶  SUPPLIER'S BENEFIT         │
│   (precondition)                        (may assume it holds)     │
│                                                                    │
│   SUPPLIER'S OBLIGATION ─────────────▶  CLIENT'S BENEFIT           │
│   (postcondition)                       (may rely on it holding)  │
│                                                                    │
│   BOTH PARTIES' OBLIGATION ──────────▶  SYSTEM'S BENEFIT           │
│   (invariant, preserved across the call)                          │
└──────────────────────────────────────────────────────────────────┘
```

A contract is not a suggestion and not documentation-as-prose: it is the
*complete and exclusive* specification of correctness. If behavior is not
promised by the contract, the supplier may change it without notice; if a
client violates its part, the supplier owes it nothing.

---

## 2. The three clauses

### 2.1 Precondition — `REQUIRE`

What must be true of the arguments, the caller's state, and the system
state **before** an operation may be invoked. A precondition is entirely the
**client's** responsibility to establish.

```
REQUIRE  P(input, state)
```

If `P` does not hold when the operation is invoked, the operation is under
no obligation whatsoever — not even to fail gracefully. In better-auth's
concrete manifestation this is softened for safety (endpoints validate and
reject with a typed error rather than behaving arbitrarily), but the
*specification* of "what must be true for the happy path to be guaranteed"
is still a precondition, and it is documented in this tree as such.

### 2.2 Postcondition — `ENSURE`

What the operation guarantees to be true **after** it terminates normally,
expressed in terms of the pre-call state (`old(x)`) and the post-call state.
This is entirely the **supplier's** responsibility.

```
ENSURE   Q(input, old(state), state, output)
```

### 2.3 Invariant — `INVARIANT`

A property of a stateful abstraction (an entity, a session, a database
record, a running auth instance) that holds:

* after the abstraction is constructed,
* before and after every operation that is part of its public contract.

```
INVARIANT  I(state)   — holds at every stable observation point
```

Invariants are **not required to hold in the middle of an operation** — only
at the boundaries between operations. This matters throughout the spec: a
multi-step flow (e.g. sign-up → verification → session issuance) may pass
through states where the invariant of the *final* abstraction does not yet
hold, as long as it is restored by the time control returns to the caller.

---

## 3. The Hoare-triple reading

Every operation documented in this tree can be reduced to a Hoare triple:

```
        ┌───────────┐        ┌────────────┐        ┌───────────┐
        │  {  P  }   │──────▶ │  operation  │──────▶ │  {  Q  }   │
        └───────────┘        └────────────┘        └───────────┘
        precondition                                postcondition
        holds before                                holds after,
        the call                                    IF P held
```

Read as: *"If `P` holds before the operation runs, and the operation
terminates, then `Q` will hold after it runs."* This is a conditional
promise — it says nothing about what happens if `P` did not hold. Each
behavior document in this tree writes operations in exactly this shape:

```
Operation:     <name>
Requires:      <precondition — client obligation>
Ensures:       <postcondition — supplier obligation>
Invariant:     <what remains true of the entity across the call>
On violation:  <which error is raised, and who is blamed — see 03>
```

---

## 4. Contracts compose: routine calls inside routines

A supplier discharging its own postcondition is usually itself a client of
other suppliers. Design by Contract requires that **a call is only made
when the caller has independently ensured the precondition holds** — a
supplier is never permitted to call a sub-operation "hopefully" and catch
the failure as normal control flow. Concretely, in this spec:

```
sign-in-with-password
   │
   ├─ REQUIRE: credential lookup precondition (email format valid)
   │     └─▶ calls Adapter.findAccount              [sub-contract #1]
   │
   ├─ REQUIRE: verification precondition (account located, hash present)
   │     └─▶ calls PasswordHasher.verify             [sub-contract #2]
   │
   └─ ENSURE: on success, Session invariant holds     [own postcondition]
```

Each arrow is itself a full contract with its own pre/post/invariant,
documented at the layer that owns that abstraction (see
`01-core-domain/04-database-adapter-contract.md` for the adapter contract,
for example). A top-level flow document composes these without restating
their internals — this is what makes the specification layered rather than
a flat wall of prose.

---

## 5. Contracts and inheritance / extension (relevant to plugins)

Meyer's discipline for subtyping — later formalized as the Liskov
Substitution Principle — states that a specialization of a contract may:

* **weaken** (or keep identical) the precondition — accept everything the
  general contract accepted, and possibly more;
* **strengthen** (or keep identical) the postcondition — guarantee
  everything the general contract guaranteed, and possibly more;
* **preserve** the invariant of the abstraction being extended.

```
                    General contract
                 REQUIRE P  ENSURE Q
                          │
              extension/specialization
                          ▼
                 REQUIRE P'  ENSURE Q'

              rule:   P' ⟸ P     (P' is P or weaker)
                      Q' ⟹ Q     (Q' is Q or stronger)
```

better-auth's plugin system is exactly this kind of extension mechanism —
a plugin extends the base auth contract (adds schema fields, adds
endpoints, wraps hooks). `03-plugin-system/01-plugin-contract.md` restates
this rule specifically for plugins: a plugin must not narrow what the base
system already promised to existing clients, and it must not weaken an
invariant the base system depends on (e.g. "a session token is unique").

---

## 6. Why this framing, and what it excludes

This tree deliberately avoids:

* function signatures, class names, file paths, or library choices,
* algorithms or data structures,
* framework-specific mechanics (HTTP verbs, cookie flag names, SQL).

It deliberately keeps:

* what must hold before an operation is attempted,
* what is guaranteed if it succeeds,
* what invariant the relevant entity maintains across its lifetime,
* who is at fault, and what is observable, when a contract is broken.

The next two documents extend this base model to two aspects Meyer's 1992
paper does not cover, both of which are essential for a plugin-and-hook
based system like better-auth: contracts on **values that are themselves
behavior** (hook handlers, matchers, adapters — see `02`), and the formal
question of **who is blamed when a contract breaks at a boundary crossed by
such values** (see `03`).
