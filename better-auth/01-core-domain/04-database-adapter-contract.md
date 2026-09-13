# The Database Adapter Contract

The database adapter is the largest higher-order contract in the system —
a record of arrow-shaped operations (per
`00-methodology/02-higher-order-contracts.md` §4) that every entity
operation in `01`–`03` of this directory is ultimately built on top of.
This document specifies each conjunct independently, then the
substitutability requirement that makes the *whole* record swappable
between concrete stores (SQL, document, in-memory, key-value), and finally
the transaction contract's precise "atomic-fallback" weakening.

---

## 1. The adapter as a conjunction of arrow contracts

```
AdapterContract =
     create        : (model, data, ?select, ?forceAllowId)     -> Entity
   ∧ findOne        : (model, where, ?select, ?join)           -> Entity | null
   ∧ findMany       : (model, ?where, ?limit, ?select,
                        ?sortBy, ?offset, ?join)                -> Entity[]
   ∧ count          : (model, ?where)                          -> number
   ∧ update         : (model, where, data)                     -> Entity | null
   ∧ updateMany     : (model, where, data)                     -> number
   ∧ delete         : (model, where)                           -> void
   ∧ deleteMany     : (model, where)                           -> number
   ∧ consumeOne     : (model, where)                           -> Entity | null
   ∧ incrementOne    : (model, where, increment, ?set)          -> Entity | null
   ∧ transaction    : (( TxAdapter ) -> R)                     -> R
```

Every conjunct is specified below with its own precondition,
postcondition, and invariant. The record AS A WHOLE additionally carries
one cross-cutting contract: **if `transaction` is used, every adapter
method called inside its callback observes the SAME isolation guarantee**
— see §6.

---

## 2. `create`

```
Operation:      create
Requires:       a model name and a data payload that satisfies every
                REQUIRED field of that model's effective schema (base
                fields + additionalFields + plugin fields — see
                01-entities-and-invariants.md §6). The payload's `id`
                field, if present, is IGNORED unless the caller explicitly
                opts in to `forceAllowId` — an escape hatch reserved for
                internal flows that need a deterministic, caller-chosen
                primary key (e.g. the first-writer-wins reservation in
                01-entities-and-invariants.md §5.2's reserve-verification-
                value), never for ordinary entity creation.
Ensures:        a new row is created with a supplier-assigned `id` (unless
                `forceAllowId` legitimately overrode this), every field
                given a default value where the caller omitted it, and the
                full created row (or the caller-requested subset, via
                `select`) returned — reflecting exactly what is now
                durably stored, not merely an echo of the input.
Invariant:      calling `create` never mutates or removes any OTHER row.
On violation:   a payload missing a required field with no default is
                rejected before any write is attempted — CLIENT-blamed. A
                write that violates a store-level constraint (e.g.
                `01-entities-and-invariants.md`'s `User.email` uniqueness)
                is rejected by the store and must surface as a
                distinguishable "constraint violation," not a generic
                failure — blame is CLIENT if the caller could have known
                the value would collide (e.g. it already looked up an
                existing row), otherwise it is a benign race between two
                legitimate callers (no blame — see
                02-session-lifecycle.md §4's analogous benign-race clause).
```

### 2.1 `forceAllowId` as a domain→range narrowing, not a general escape

```
Contract:   create(forceAllowId: true) : (model, data-INCLUDING-id) -> Entity

  Applies at: exactly the internal flows in 01-entities-and-invariants.md
              that need a caller-determined primary key (deterministic
              reservation keys, single-use token rows created with a
              pre-computed hash as their id).
  On mismatch: a caller passing `forceAllowId: true` from ordinary,
              untrusted input (letting an external caller choose an
              entity's primary key) reintroduces every hazard id
              generation exists to prevent (collision, enumeration,
              cross-tenant id guessing). This is a CLIENT/deployer
              violation of how the escape hatch is meant to be used — the
              adapter itself has no way to distinguish a legitimate
              internal use from a misuse; the discipline is enforced by
              convention at the call site, not by the contract shape.
```

---

## 3. `findOne` / `findMany`

```
Operation:      findOne
Requires:       a model name and a `where` clause (§7 for its semantics).
Ensures:        the FIRST row matching `where` (under the adapter's own
                stable but store-defined ordering when `where` matches
                more than one row and no `sortBy` is given elsewhere in
                this record — `findOne` itself takes no `sortBy`, so a
                caller relying on a specific "first" match across a
                multi-row match MUST use `findMany` with an explicit
                `sortBy` and take the head, not `findOne`), or `null` if
                none matches. An optional `select` restricts which fields
                are populated on the returned entity; an optional `join`
                additionally attaches related rows from another model
                (§3.1).
Invariant:      `findOne` never mutates state.
On violation:   n/a for well-formed calls — there is no precondition
                whose failure is attributable to the caller beyond
                `where` being malformed (§7).
```

```
Operation:      findMany
Requires:       a model name; `where`, `limit`, `select`, `sortBy`,
                `offset`, `join` all optional.
Ensures:        every row matching `where` (or every row of the model, if
                `where` is omitted), truncated to `limit` if given,
                skipping `offset` rows if given, ordered by `sortBy` if
                given — otherwise in a store-defined but stable order.
                Returns an empty array (never `null`) when nothing
                matches.
Invariant:      `findMany` never mutates state; two calls with identical
                arguments against an unchanged store return equal results.
On violation:   n/a beyond `where` malformation (§7).
```

### 3.1 `join` as a bounded relational fetch, not a general query capability

```
Contract:   join : { [relatedModel]: true | { limit?: number } }

  Ensures:  a "one-to-one"-declared relation attaches AT MOST ONE related
            row per primary row; a "one-to-many"/"many-to-many"-declared
            relation attaches an array, bounded by the relation's
            configured limit (or a supplier-wide default limit if the
            relation declares none) — an UNBOUNDED join is never
            performed implicitly.
  On mismatch: a caller relying on `join` to fetch an unbounded number of
            related rows in one call is relying on behavior outside the
            contract — the bound is a supplier obligation specifically to
            prevent one logical query from becoming an unbounded fetch;
            exceeding the intended set requires paging via a direct
            `findMany` against the related model instead.
```

---

## 4. `count`

```
Operation:      count
Requires:       a model name; `where` optional.
Ensures:        the number of rows matching `where` (or the total row
                count for the model, if omitted) at the moment of the
                call.
Invariant:      never mutates state.
On violation:   n/a.
```

---

## 5. `update` / `updateMany`

```
Operation:      update
Requires:       a model name, a NON-EMPTY `where` clause, and a partial
                data payload of fields to change.
Ensures:        AT MOST ONE row — the first matched, under the same
                "store-defined but stable" ordering rule as `findOne` — is
                updated; its full post-update state is returned. An EMPTY
                `where` clause is a special precondition case: rather than
                updating an arbitrary/unbounded set of rows, this
                operation FAILS CLOSED and returns `null` with no write at
                all — `updateMany` is the only path to an intentional
                bulk update.
Invariant:      a single `update` call never changes more than one row.
On violation:   no row matches `where` — returns `null`, not an error
                (this is the ordinary "nothing to update" outcome, not a
                violation). An empty `where` — returns `null` by
                deliberate design (§ above), which a caller must not
                mistake for "matched zero rows" when auditing for bugs:
                the two are the same observable outcome by contract, but
                only one (empty where) is a caller mistake worth guarding
                against upstream.
```

```
Operation:      updateMany
Requires:       a model name, a `where` clause (may be empty — an empty
                `where` here IS a legitimate "update every row" request,
                unlike single-row `update`), and a partial data payload.
Ensures:        EVERY row matching `where` is updated; returns the COUNT
                of rows actually changed (not the rows themselves).
Invariant:      n/a beyond the count accurately reflecting rows changed.
On violation:   n/a.
```

> **`update` is not the race-safe primitive for a guarded state
> transition.** Neither `update` nor `updateMany` promises that the
> `where`-clause evaluation and the write happen as one atomic step under
> concurrent callers targeting the same row with a value-dependent
> predicate (e.g. "only if remaining > 0"). §8 (`incrementOne`) is the
> primitive that makes that promise; `update`/`updateMany` make no such
> guarantee and must not be used where two racing callers both matching
> the same predicate is a correctness hazard.

---

## 6. `delete` / `deleteMany`

```
Operation:      delete
Requires:       a model name and a `where` clause.
Ensures:        AT MOST ONE matching row is removed (same "first matched"
                rule as `update`); returns nothing meaningful either way
                (the operation is fire-and-forget from the caller's
                perspective — a caller needing to know WHAT was deleted
                must read it first, e.g. via `findOne`, or use
                `consumeOne`, §7, which reads-and-deletes atomically).
Invariant:      never removes more than one row.
On violation:   n/a — deleting zero matching rows is a silent no-op, not
                an error.
```

```
Operation:      deleteMany
Requires:       a model name and a `where` clause (may be empty — deletes
                every row of the model, an intentional bulk operation).
Ensures:        every matching row is removed; returns the COUNT removed.
Invariant:      n/a beyond the count being accurate.
On violation:   n/a.
```

---

## 7. `consumeOne`: the race-safe read-and-delete primitive

```
Operation:      consumeOne
Requires:       a model name and a `where` clause.
Ensures:        AT MOST ONE row matching `where` is deleted AND returned
                in the SAME atomic step; when multiple callers race against
                a `where` clause that (at the instant of the race) matches
                only one row, EXACTLY ONE caller receives that row and
                every other racing caller receives `null` — never do two
                racing callers both receive the same row, and never does
                the operation delete more than the one row that also
                matches any additional non-unique predicate in `where`.
Invariant:      a row consumed by one caller cannot subsequently be
                observed, consumed again, or "un-consumed" by any other
                caller — this is the primitive
                01-entities-and-invariants.md §5.2's consume-verification-
                value contract is built on.
On violation:   a concrete adapter that implements this by first reading,
                then separately deleting (two round trips, not one atomic
                step) has NOT satisfied this contract unless it can
                otherwise guarantee the same race-exclusivity some other
                way (see §7.1's fallback). An adapter that reports success
                to two racing callers for the same row is a SUPPLIER/
                ADAPTER-blamed violation of the highest severity for any
                caller relying on this primitive for single-use-token
                safety (01-entities-and-invariants.md §5.2).
```

### 7.1 The atomic-fallback for `consumeOne`

A concrete adapter is not required to implement `consumeOne` as one native
atomic store operation (e.g. "delete-and-return" in one round trip). When
it does not, the adapter factory provides a **fallback** built from
`findOne` + a GUARDED `deleteMany` — and this fallback is itself part of
the contract every adapter is entitled to rely on, not a lesser, optional
substitute:

```
   1. READ a snapshot of the candidate row via findOne(where).
      → none found: return null immediately.

   2. BUILD A GUARD: the original `where`, AND-ed with an exact-match
      condition on the row's own id, AND-ed with exact-match conditions on
      every OTHER scalar field of the snapshot (so the delete only fires
      if the row is STILL, at delete time, identical to what was read —
      a compare-and-delete built from ordinary predicates).

      EXCEPTION: if the original `where` contains an OR connector, the
      guard is narrowed to the id condition alone for safety, and any
      non-unique field appearing in that OR predicate that cannot be
      safely re-expressed as a scalar equality FORCES this fallback to
      refuse (throw) rather than risk deleting a different row than the
      one read — a store needing OR-predicate consumeOne semantics MUST
      implement it natively (no fallback exists for that shape).

   3. DELETE-MANY with the guard. The affected-row count MUST be exactly
      0 or 1 — any other count is a supplier-contract violation in
      itself (the guard was supposed to make this impossible) and is
      raised as an internal error, not silently tolerated.

      → 1 row affected: the caller that issued THIS delete is the winner;
        return the snapshot read in step 1.
      → 0 rows affected: something changed the row (or deleted it)
        between the read and this delete — THIS caller lost the race;
        return null. (The winner of that race observed its own
        consistent view; this caller correctly sees none.)
```

```
┌──────────────────────────────────────────────────────────────────┐
│              consumeOne fallback — race outcome diagram              │
│                                                                          │
│  caller A                    store                     caller B          │
│    │  read snapshot            │                          │              │
│    ├─────────────────────────▶│                            │              │
│    │◀─────────────────────────┤                            │              │
│    │  build guard from          │                            │              │
│    │  snapshot                   │                            │              │
│    │                              │      read snapshot          │              │
│    │                              │◀─────────────────────────┤              │
│    │                              ├─────────────────────────▶│              │
│    │                              │      (same snapshot,          │              │
│    │                              │       same guard)               │              │
│    │  deleteMany(guard)            │                                  │              │
│    ├─────────────────────────────▶│                                  │              │
│    │◀─────────────────────────────┤  affected = 1                     │              │
│    │  WINNER: returns row           │                                  │              │
│    │                              │      deleteMany(guard)               │              │
│    │                              │◀─────────────────────────────────┤              │
│    │                              ├─────────────────────────────────▶│              │
│    │                              │  affected = 0 (row already gone)   │              │
│    │                              │      LOSER: returns null             │              │
└──────────────────────────────────────────────────────────────────┘
```

```
On violation:   this fallback's every internal precondition failure
                (the adapter cannot report the row's own id; the adapter's
                deleteMany reports an affected count outside {0,1}) is
                raised as a SUPPLIER/ADAPTER-blamed integrity error — the
                fallback's correctness depends on the underlying adapter
                honestly reporting exactly what it changed, which is the
                adapter's own baseline obligation from §6.
```

---

## 8. `incrementOne`: the race-safe guarded counter mutation

```
Operation:      incrementOne
Requires:       a model name, a `where` clause that serves DOUBLE DUTY as
                both the row SELECTOR and a value-dependent GUARD (e.g.
                "only apply this if `remaining > 0`" is expressed by
                putting that comparison directly in `where`, not checked
                separately beforehand), a map of field→signed-delta to
                apply, and an optional map of field→absolute-value to set
                in the same atomic step.
Ensures:        for each entry in the increment map, `field = field +
                delta` is applied atomically (a negative delta
                decrements); when the guard matches no row (because the
                value-dependent condition is no longer true, or the row is
                gone), NOTHING is changed and `null` is returned; a no-op
                request (deltas that would not change any value, given a
                `set` that matches the current values) MAY be answered
                from the read snapshot without issuing a write, but still
                counts as success — it does not, on that basis alone,
                establish anything about EXCLUSIVE ownership of the row
                for the caller (see the note below).
Invariant:      under any number of concurrent callers targeting the same
                row and the same guard, the final stored value is the
                correct SEQUENTIAL composition of every increment that its
                own guard permitted — no increment is silently lost, and
                no increment is applied whose guard had already stopped
                holding by the time it took effect.
On violation:   a store or fallback that cannot make evaluate-then-mutate
                atomic for this operation is not exempt from this
                contract — see §8.1's fallback and its own explicit
                failure mode (contention exhaustion).
```

> **A non-null result does not, by itself, prove exclusive ownership of
> the row going forward.** `incrementOne` guarantees the mutation it
> performed was race-safe AT THE MOMENT it happened; it makes no promise
> about what any other caller does to the row a moment later. A caller
> that needs "I now exclusively own this row for a sequence of further
> operations" must build that guarantee some other way (e.g. a status
> field flipped as part of the SAME incrementOne call via `set`, which
> every subsequent guard then checks).

### 8.1 The atomic-fallback for `incrementOne`

When a concrete adapter has no native guarded-counter-mutation primitive,
the factory-provided fallback performs BOUNDED COMPARE-AND-SWAP RETRIES:

```
   repeat up to a fixed maximum attempt count:
     1. READ a snapshot via findOne(where-as-selector).
        → none found: return null (the guard does not hold — done).
     2. COMPUTE each incremented value from the snapshot's CURRENT stored
        value (never from a previous attempt's stale read).
        → if a target field's stored value is not a finite number (or
          null, treated as zero), or the arithmetic would overflow to a
          non-finite result, this is a SUPPLIER/ADAPTER-blamed integrity
          error — the fallback refuses to guess.
        → if the update would be a true no-op (every field's new value
          equals its current value), return the snapshot AS success
          without writing (see the "no-op" clause in §8's postcondition).
     3. BUILD A GUARD identical in spirit to §7.1 step 2 (snapshot-scoped
        compare-and-swap condition, narrowed under an OR predicate the
        same way).
     4. UPDATE-MANY with the guard and the computed new values.
        → affected count of 1: SUCCESS — return the snapshot merged with
          the new values (NOT a fresh read — a second read at this point
          could observe a DIFFERENT writer's subsequent change instead of
          this caller's own committed result, which would misattribute
          that value to this caller).
        → affected count of 0: another writer changed the row first —
          RETRY from step 1 (fresh read), up to the attempt limit.

   if every attempt is exhausted without a successful guarded write:
     THROW (contention exhaustion) — this is NOT the same outcome as "the
     guard does not hold" (which returns null cleanly at step 1). A
     caller must treat exhaustion as "the operation's outcome is
     genuinely unknown/unresolved under this level of contention," and
     either retry at a higher level or fail the surrounding operation —
     never treat a thrown contention-exhaustion as equivalent to a clean
     null.
```

```
On violation:   contention exhaustion propagating as an ordinary "guard
                did not hold" result (silently swallowed and treated as
                null) is a CLIENT-side misuse of this contract — the two
                outcomes are deliberately distinct and a caller conflating
                them can misreport "no capacity remained" when the truth
                is "the store was too contended to tell."
```

---

## 9. `transaction`: the atomic-fallback contract, precisely

```
Contract:   transaction : ( (TxAdapter) -> R ) -> R

  Applies at: any multi-step sequence of adapter calls whose caller
              requires that either ALL of them take effect or NONE of
              them do (e.g. 01-entities-and-invariants.md §2.3's
              promote-unverified-user-on-email-proof, which deletes
              multiple Account rows, deletes Sessions, and flips
              emailVerified as one unit).

  STRONG form (adapter DOES support real transactions):
    Ensures:  every adapter call made through the `TxAdapter` handed to
              the callback is either ALL durably committed together, or —
              if the callback throws, or the underlying store aborts the
              transaction for its own reasons — NONE of them are, and no
              caller outside this transaction can ever observe a partial
              subset of the callback's writes, at any point, from before
              the commit through after a rollback.

  WEAKENED form (adapter does NOT support real transactions — "as-is"/
  sequential fallback):
    Ensures:  the callback is simply invoked against the ordinary
              (non-transactional) adapter — each individual call inside it
              is applied and durably visible to other callers IMMEDIATELY,
              one at a time, in the order the callback issues them. If the
              callback throws partway through, EVERY call already applied
              before the throw REMAINS applied — there is no rollback.
    This is a POSTCONDITION WEAKENING relative to the strong form: "all or
    nothing" degrades to "each one, as it happens, with no undo."
```

```
┌────────────────────────────────────────────────────────────────────┐
│         transaction — strong form vs. weakened (as-is) fallback        │
│                                                                          │
│   STRONG (real transaction):                                             │
│     step 1 ──▶ step 2 ──▶ step 3 ──▶ [callback throws at step 3]           │
│                                            │                                │
│                                            ▼                                │
│                                   ROLLBACK: steps 1 and 2               │
│                                   are undone too — an external            │
│                                   reader NEVER observed steps 1/2           │
│                                   as durable, even transiently.              │
│                                                                                │
│   WEAKENED (as-is fallback):                                                    │
│     step 1 (committed) ──▶ step 2 (committed) ──▶ step 3 [throws]                │
│                                                        │                            │
│                                                        ▼                             │
│                                              NO ROLLBACK: steps 1 and 2               │
│                                              remain durably applied —                  │
│                                              an external reader COULD                   │
│                                              observe this partial state.                 │
└────────────────────────────────────────────────────────────────────┘
```

### 9.1 Who is told, and who is blamed, when the weaker guarantee causes a downstream invariant violation

```
On violation:   when a caller's own invariant depends on all-or-nothing
                behavior (it composed several writes inside `transaction`
                specifically to get that guarantee) and the configured
                adapter only offers the weakened as-is fallback, any
                downstream invariant violation caused by a PARTIAL write
                becoming durably visible is blamed on the DEPLOYER/
                ADAPTER CHOICE — not on the calling code that correctly
                used `transaction`, and not on the base system, which
                honestly reports (via the adapter's own declared
                capability) whether real transactions are available.

                Concretely: a caller MUST NOT assume the strong form is in
                effect merely because it called `transaction` — the
                contract explicitly reserves the right to be the weakened
                form, and a caller with an invariant that CANNOT tolerate
                partial visibility (rather than merely preferring it be
                avoided) must either require a transaction-capable adapter
                as its own precondition, or restructure the operation to
                be safe under interruption at every intermediate step
                (e.g. by making each step individually idempotent and
                re-driveable, the way 01-entities-and-invariants.md §2.3's
                cleanup lock allows a second caller to observe and wait
                out a first caller's in-progress work rather than assuming
                atomicity).
```

### 9.2 Nesting and the after-transaction hook boundary

A `transaction` call issued while ALREADY inside an active transaction
does not open a second, nested transaction — it reuses the SAME active
transaction context, so all of its calls are still part of the single
outer atomic unit (in the strong form) or the same sequential run (in the
weakened form).

Separately, a distinct mechanism exists for side effects that must run
**only after** a transaction has successfully committed (e.g.
`02-session-lifecycle.md` §7's secondary-storage mirror write, or a
notification that must never fire for work that was rolled back):

```
Contract:   queue-after-transaction-hook : ( () -> void ) -> void

  Ensures:  IF called while inside an active (strong-form) transaction,
            the hook is deferred and run only after that transaction
            successfully commits — NEVER if the transaction is rolled
            back. IF called outside any active transaction (including
            while inside the WEAKENED as-is fallback, which never reaches
            a true "commit" event to defer to), the hook runs
            IMMEDIATELY instead.
  Invariant: a hook queued this way, once its transaction has committed,
            runs even if the surrounding operation as a whole later fails
            for an unrelated reason — its own failure does NOT unwind the
            already-committed transaction (there is nothing left to
            unwind), and is reported through a separate error channel
            (an error callback) rather than by re-raising into the
            original caller's control flow.
  On mismatch: treating a queued hook's success as GUARANTEED merely
            because the transaction committed is a CLIENT-side
            over-assumption — the hook's own execution can still fail
            independently (per 02-session-lifecycle.md §7's secondary-
            storage mirror example) and that failure is the hook
            caller's to handle, not evidence of a broken transaction
            contract.
```

---

## 10. `where`-clause semantics

```
Where = {
  field:      <logical field name — see §11 for what "logical" means>,
  value:      <scalar | scalar-array | null>,
  operator?:  eq | ne | lt | lte | gt | gte | in | not_in
              | contains | starts_with | ends_with     (default: eq),
  connector?: AND | OR                                  (default: AND),
  mode?:      sensitive | insensitive                   (default: sensitive,
              applies only to string comparisons)
}
```

```
Ensures:  a `where` array is the CONJUNCTION (AND) of its entries by
          default; entries explicitly marked `connector: OR` are grouped
          into a disjunction with their neighbors of the same marking —
          the exact grouping semantics of a MIX of AND and OR entries in
          one array is a single, fixed, store-independent evaluation rule
          every adapter must implement identically (not left to each
          store's own native operator-precedence quirks), because two
          adapters disagreeing about how a mixed AND/OR array groups would
          break substitutability (§12) silently and dangerously — the
          exact query would find a different answer depending on which
          store is behind it.

Invariant: an empty `where` array means "match every row" for operations
          that accept it as a legitimate bulk target (`findMany`,
          `updateMany`, `deleteMany`, `count`) and means "match no target
          at all, fail closed" for operations where a single, specific row
          is implied (`update`, `delete` — see §5/§6's explicit empty-
          where handling).

On violation: a `field` naming something outside the model's effective
          schema (§1 of 01-entities-and-invariants.md's extension
          contract) is a CLIENT-blamed malformed-query error, raised
          before any store round trip when the adapter can detect it
          ahead of time.
```

---

## 11. Field and model name mapping is a contract, not a leak

```
Contract:   getFieldName : (model, logical-field-name) -> physical-field-name
Contract:   getModelName : (logical-model-name) -> physical-table-name

  Ensures:  every operation in this document that accepts a `model` name
            or a field name inside a `where`/`data` payload accepts the
            LOGICAL name (the name this specification and every entity
            document use — "user", "email", "session", "token") and the
            adapter itself resolves it to whatever PHYSICAL name a given
            deployment's schema configuration has renamed it to. A caller
            of this contract (including every operation specified in
            01-entities-and-invariants.md through 03-credentials-and-
            identity.md) NEVER needs to know or care what the physical
            name is.

  Invariant: renaming a field's physical name, or a model's physical table
             name, through configuration is a NO-OP on every contract in
             this document — it changes nothing about required-ness,
             uniqueness, type, or any other logical-schema property (see
             01-entities-and-invariants.md §6's Layer diagram: renaming is
             explicitly called out there as NOT a logical-contract change).

  On mismatch: an adapter implementation that requires callers to know or
             supply PHYSICAL names anywhere in this document's operations
             has broken the abstraction this contract exists to provide —
             this is a SUPPLIER/ADAPTER-blamed violation, because every
             other document in this specification tree is written
             assuming logical names are the only vocabulary a caller ever
             needs.
```

This same mapping layer is also where a store with structurally different
id conventions (e.g. a document store using its own reserved primary-key
field name instead of a plain `id` column) reconciles that difference —
key-renaming at the INPUT and OUTPUT boundary (`mapKeysTransformInput` /
`mapKeysTransformOutput` in adapter configuration) is the same kind of
no-op-to-callers renaming as field/model renaming, just applied at the
whole-row level rather than per field.

---

## 12. Substitutability: the Liskov-style requirement across concrete adapters

```
┌────────────────────────────────────────────────────────────────────┐
│                    ABSTRACT ADAPTER CONTRACT (this document)          │
│                                                                          │
│         create ∧ findOne ∧ findMany ∧ count ∧ update ∧ updateMany       │
│         ∧ delete ∧ deleteMany ∧ consumeOne ∧ incrementOne ∧ transaction  │
└─────────────────────────┬──────────────────────┬─────────────────────┘
                          │                      │
              specialization                specialization
                          │                      │
                          ▼                      ▼
             ┌─────────────────────┐  ┌─────────────────────┐
             │  concrete adapter A   │  │  concrete adapter B   │
             │  (e.g. a relational    │  │  (e.g. an in-process   │
             │  SQL store with real    │  │  memory store with no    │
             │  transactions and a      │  │  transaction support at   │
             │  native consumeOne)       │  │  all, using the atomic-     │
             │                            │  │  fallback for consumeOne/   │
             │                            │  │  incrementOne, and the       │
             │                            │  │  as-is sequential fallback    │
             │                            │  │  for transaction)               │
             └─────────────────────┘  └─────────────────────┘

  RULE (per 00-methodology/01 §5, restated for a bundle of operations
  per 00-methodology/02 §4): each concrete adapter's preconditions must be
  the abstract contract's preconditions OR WEAKER (accept at least
  everything the abstract contract requires callers be able to send), and
  its postconditions must be the abstract contract's postconditions OR
  STRONGER (guarantee at least everything specified above) — WITH THE
  SINGLE DOCUMENTED EXCEPTION of §9's transaction weakening, which every
  caller is on notice about and must design around per §9.1.

  CONSEQUENCE: any capability built on top of THIS document (every
  operation in 01-entities-and-invariants.md, 02-session-lifecycle.md,
  03-credentials-and-identity.md, and every higher-level flow built on
  them) is required to behave identically regardless of which concrete
  adapter is configured underneath it — EXCEPT for the one place
  (transaction atomicity) where this document itself says the guarantee
  may differ, and requires that difference to be surfaced as a capability
  the adapter declares, never silently discovered by a caller at runtime.
```

### 12.1 Configuration-declared capabilities are part of what "substitutable" means

A concrete adapter declares, up front (not discovered by probing), which
of several STORE-SHAPE accommodations it needs the shared adapter
machinery to perform on its behalf — for example, whether the store can
represent JSON, arrays, booleans, or dates natively, or needs them
translated to/from strings; whether it can generate its own UUIDs or
numeric ids or needs the shared machinery to generate them instead;
whether it supports a native atomic `consumeOne`/`incrementOne` or needs
the §7/§8 fallbacks. None of these declarations change what a CALLER of
this document's contracts observes — they change only how a concrete
adapter's INTERNAL implementation reaches the same externally-observed
postconditions. This is precisely why substitutability holds: the
declarations are a private negotiation between a concrete adapter and the
shared adapter-factory machinery, invisible to every caller specified in
the rest of this document.

```
On violation:   an adapter that mis-declares its own capability (e.g.
                claims native UUID generation it does not actually
                perform, or claims transaction support it does not
                honestly provide) causes every contract in this document
                that depends on the true capability to silently fail its
                postcondition. Blamed party: the ADAPTER (or whoever
                authored its configuration) — this is exactly the
                "positive blame" case from 00-methodology/03 §2: the
                value flowing OUT of the adapter's own self-description
                was wrong.
```
