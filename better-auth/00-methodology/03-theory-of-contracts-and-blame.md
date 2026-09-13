# A Theory of Contracts: Violation and Blame

> Source: Robert Bruce Felleisen & Robert Bruce Findler's formal treatment of
> contract satisfaction and blame, as developed alongside
> *"Contracts for Higher-Order Functions"* (ICFP 2002), and its companion
> line of work formalizing **contract violation as an assignment of
> responsibility** rather than merely a boolean failure.

The first two documents define what a contract *is* (`01`) and how it is
checked when the value crossing a boundary is itself behavior (`02`). This
document defines what happens when a contract is **not** satisfied: not
just "an error occurs," but a formal, structural answer to *whose fault it
was* — and it is this notion that better-auth's entire error taxonomy is
read against in this spec.

---

## 1. A contract boundary has exactly two parties

Every contract in this system is installed at a **boundary** between two
parties: whoever provides a value (the *positive* position) and whoever
consumes it (the *negative* position). Findler & Felleisen's insight is
that blame is always assignable to exactly one of these two — never to the
contract itself, and never left ambiguous:

```
                         CONTRACT BOUNDARY
                                │
     positive party ───────────┼───────────── negative party
     ("obligated to            │              ("obligated to
       PRODUCE a value           │               CONSUME correctly
       meeting the contract")    │               under the contract")
                                │
            if the boundary is crossed and the contract fails:
                                │
              ┌─────────────────┴─────────────────┐
              ▼                                     ▼
       blame POSITIVE                        blame NEGATIVE
       (the producer supplied                (the consumer's own
        a bad value)                          assumptions, at a
                                               nested boundary it
                                               itself installed,
                                               were violated)
```

The theorem this tree relies on informally: **a monitored system never
raises an error that cannot be attributed to one of the two parties at some
boundary** — there is no third, unaccountable failure mode once a contract
is in place. Every "on violation" clause in this specification names the
blamed party for exactly this reason: it is a claim about where the defect
must be looked for, not a generic "something went wrong."

---

## 2. Positive and negative blame, concretely

* **Negative blame** — the value flowing *into* an operation (an argument,
  a request body, a caller-supplied token) fails the precondition. Fault
  lies with whoever originated that value — typically the **client of the
  API** (an end user's browser, a calling application, a misconfigured
  caller).
* **Positive blame** — the value flowing *out of* an operation (a return
  value, a promised side effect, an adapter's result) fails the
  postcondition. Fault lies with whoever implements that operation —
  typically **better-auth itself, a plugin, or an adapter/database
  implementation** the deployer chose.

```
   Client                          better-auth                Adapter/DB
     │                                  │                          │
     │  request (candidate value)       │                          │
     ├─────────────────────────────────▶│                          │
     │      ✗ fails precondition        │                          │
     │◀─────────────  NEGATIVE BLAME ───┤                          │
     │        (400-class: client error) │                          │
     │                                  │                          │
     │  request (valid)                 │                          │
     ├─────────────────────────────────▶│  calls adapter            │
     │                                  ├─────────────────────────▶│
     │                                  │      ✗ fails adapter       │
     │                                  │        postcondition       │
     │                                  │◀──── POSITIVE BLAME ───────┤
     │◀── POSITIVE BLAME (propagated) ──┤     (500-class: supplier)  │
     │      (500-class: server error)   │                          │
```

This is the structural reason better-auth's error model (see
`02-request-pipeline/05-error-model-and-blame.md`) separates **client
errors** (4xx-class: `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`,
`NOT_FOUND`, `TOO_MANY_REQUESTS` …) from **supplier errors** (5xx-class:
adapter failures, unhandled plugin exceptions): they are not a severity
scale, they are a **blame assignment**.

---

## 3. Blame is preserved across composition (it does not evaporate at re-throw)

When contract *A* wraps contract *B* wraps contract *C* (e.g. a plugin
hook wraps an endpoint which wraps an adapter call), a violation deep
inside must still surface with blame attributable to the *originating*
boundary, not the outermost one that happened to catch and rethrow it.

```
   sign-in endpoint             two-factor plugin's                adapter's
   (outer contract)             "before" hook (middle)            findOne (inner)
        │                              │                                │
        │  invoke                     │  invoke                       │
        ├─────────────────────────────▶│                                │
        │                              ├───────────────────────────────▶│
        │                              │        ✗ malformed `where`      │
        │                              │        clause (hook's own bug)  │
        │                              │◀── blame: the HOOK (negative,   │
        │                              │    it produced a bad argument   │
        │                              │    to the adapter)              │
        │◀── error surfaces with the ──┤                                │
        │    SAME blame attribution     │                                │
        │    (the endpoint did not      │                                │
        │     cause it, and must not    │                                │
        │     be blamed for it)         │                                │
```

Practically, this means every behavior document in this tree that composes
sub-contracts (§4 of `01-design-by-contract.md`) must say, for each
failure mode, *which* of the composed parties is at fault — not just "the
operation may fail."

---

## 4. Blame and plugin extension (irresponsibility cannot be inherited away)

Per §5 of `01-design-by-contract.md`, a plugin may only weaken
preconditions and strengthen postconditions relative to the contract it
extends. The blame-theoretic reading of a violation of *that* rule is:

* If a plugin **narrows** a precondition the base system already promised
  to accept (rejects requests the core contract said were valid), any
  resulting failure is blamed on the **plugin**, even though the request
  itself was "conformant" from the caller's point of view.
* If a plugin **weakens** a postcondition the base system already promised
  (e.g. a plugin's `init` mutates context in a way that breaks a session
  invariant another, unrelated plugin depends on), the failure is blamed
  on the **plugin that broke the invariant**, not on the plugin that later
  observes the broken invariant and fails as a result.

This "first cause, not first observer" rule is used throughout the plugin
and extension documents (`03-plugin-system/`, and every plugin-specific
document in `05`–`09`) whenever describing what happens when two plugins
interact incompatibly.

---

## 5. Summary: how to read every "On violation" clause in this tree

Every operation specified in this documentation set ends with a clause of
the form:

```
On violation of <precondition | postcondition | invariant>:
   Raised as:      <the error category>
   Blamed party:   <CLIENT | SUPPLIER (better-auth/plugin) | ADAPTER>
   Recoverable by: <what the blamed party must change to satisfy the contract>
```

This is the direct operationalization of Findler & Felleisen's theorem for
this system: a failure is not merely reported, it is **assigned**, and the
assignment tells the reader exactly which of the boundary's two parties
must change their behavior for the contract to hold on a retry.
