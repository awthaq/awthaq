# Storage and Adapters

This document specifies the six concrete storage integrations that ship in
the platform: five **database adapters** (in-memory, Kysely-based SQL,
Drizzle, Prisma, MongoDB) and one **secondary key-value store** (a
Redis-class store). Per methodology doc `01` §5, each adapter is a
**specialization** of the abstract adapter contract defined in
`01-core-domain/04-database-adapter-contract.md`: it must accept every input
the abstract contract accepts (precondition no narrower) and guarantee every
outcome the abstract contract promises (postcondition no weaker). This
document's job is to state, for each concrete adapter, exactly where it
sits relative to that baseline — where it is a pure specialization, and
where it **documents a deliberate narrowing** (per methodology doc `01` §5,
narrowing must be documented, not silently shipped).

The abstract contract's operation set, restated from methodology doc `02`
§4, is: `create`, `findOne`, `findMany`, `count`, `update`, `updateMany`,
`delete`, `deleteMany`, `consumeOne` (atomic find-and-remove of a single
row), `incrementOne` (atomic guarded numeric increment plus optional set,
of a single row), and `transaction` (a higher-order operation whose
argument is a callback that itself receives a full adapter instance scoped
to the transaction).

```
                    ABSTRACT ADAPTER CONTRACT
     create / findOne / findMany / count / update / updateMany /
     delete / deleteMany / consumeOne / incrementOne / transaction
                              │
        ┌───────────┬─────────┼─────────┬───────────┬────────────┐
        ▼           ▼         ▼         ▼           ▼            ▼
   in-memory     Kysely    Drizzle   Prisma      MongoDB     (Redis-class
   adapter      SQL adapt.  adapter   adapter     adapter     secondary
                                                              store — NOT
                                                              this contract;
                                                              see §6)
```

---

## 0. Cross-cutting concerns shared by every adapter section below

### 0.1 The "no real `RETURNING`" problem and its canonical resolution

**Requires:** none of the three SQL-family write paths (Kysely-based
adapter against a MySQL dialect, Drizzle against a MySQL provider, and by
Prisma's own client generation choices) can rely on a single-statement
"insert and return the row" primitive on that engine, unlike PostgreSQL,
SQLite, MSSQL, or MongoDB.

**Ensures:** all three adapters converge, independently, on the same
fallback discipline for `create`, applied in this priority order until one
yields exactly one row:

1. an identifier the caller supplied in the write itself;
2. a server-assigned auto-increment identifier read back immediately after
   the write, when `generateId` is configured as a serial/auto-increment
   strategy;
3. a lookup by any field the schema declares unique, restricted to a field
   actually present in the written data;
4. a full-field equality match against every column the write set,
   capped so that if the match is **ambiguous** (more than one candidate
   row), the fallback refuses to guess and returns nothing rather than an
   arbitrary row.

**Invariant:** an adapter never fabricates or guesses an inserted row's
identity under ambiguity — a losing race against strategy 4 must surface as
"row not confidently identified," not as an incorrect row.

**On violation:** if none of the four strategies resolves, the operation's
postcondition (`create` returns the created entity) cannot be discharged
reliably; each adapter logs an operator-facing warning recommending a
generated-id strategy. Blamed party: **CLIENT** (the deployer chose an ID
strategy incompatible with a MySQL-family engine without configuring one of
the two safe alternatives — server-supplied unique fields or serial IDs).

### 0.2 Single-row guarded mutation (`consumeOne`, `incrementOne`)

**Requires:** a `where` predicate that may or may not be unique.

**Ensures:** regardless of how many rows the predicate matches, at most
**one** row is read, mutated (or removed), and returned; the predicate is
never widened into an implicit multi-row operation. Every adapter
implements this by first resolving exactly one candidate row's identity
under the predicate, then re-scoping the actual mutation to that identity
alone (an identity-pinned second predicate), so a non-unique guard cannot
silently touch more than one row.

**Invariant:** this is the atomic primitive the rest of the system (rate
limiting, single-use verification values, OAuth code/token consumption)
relies on for race-safe state transitions — see
`01-core-domain/04-database-adapter-contract.md`.

**On violation:** a predicate matching zero rows yields `null`/no mutation,
never an error and never a mutation of an unrelated row. Blamed party:
**ADAPTER** if more than one row is ever observably mutated by a single
`consumeOne`/`incrementOne` call — this is never acceptable regardless of
predicate uniqueness.

### 0.3 Case-insensitive comparison is a per-adapter reimplementation, not a shared primitive

Every adapter independently reimplements the family of insensitive
operators (`eq`, `ne`, `in`, `not_in`, `contains`, `starts_with`,
`ends_with`) in terms of whatever its underlying engine offers natively:
lowercasing before comparison in the in-memory adapter; pattern-matching
operators translated per SQL dialect in the Kysely and Drizzle adapters;
provider-gated native case-insensitive mode in the Prisma adapter
(available only where the underlying engine supports it); and
regex-anchored matching in the MongoDB adapter. **Ensures:** for any two
adapters substituted for one another, an insensitive-mode query returns the
same logical row set — this is the substitutability guarantee the abstract
contract exists to protect — even though no two adapters implement it the
same way underneath.

---

## 1. The in-memory adapter

**Role relative to the abstract contract:** a full, general-purpose
specialization, explicitly scoped to development and testing rather than
production concurrency control.

### 1.1 Schema posture

**Requires:** nothing — the in-memory store has no independent schema of
its own; each table is created on first write. This is the schemaless end
of the spectrum, matching MongoDB's posture (§5) rather than the SQL
adapters' schema-first posture (§2–§4).

### 1.2 `transaction`

**Ensures:** `transaction` is real in the sense that a failed callback
leaves the live store completely untouched, and a successful callback's
writes are applied atomically from the caller's point of view — but it is
implemented as **copy-on-write plus a three-way merge**, not as engine-level
locking:

```
            transaction(cb) called
                     │
     snapshot BASE = clone(live)     snapshot CLONE = clone(live)
                     │                        │
                     │            cb runs against an adapter
                     │            scoped to CLONE only — writes
                     │            inside cb are invisible to any
                     │            concurrent caller reading `live`
                     │                        │
                     ▼                        ▼
              cb throws  ──────────►  live store untouched, error
                                       propagates (ROLLBACK)
                     │
              cb resolves
                     │
                     ▼
     merge(live, BASE, CLONE): for each row, apply the
     transaction's own create/update/delete; a row the
     transaction never touched keeps whatever the live
     store holds *now* (so a write that interleaved at an
     `await` point during the transaction survives)
```

**Invariant:** isolation is at **row/table granularity**, not full
snapshot isolation — if the transaction and a concurrent caller both
mutate the *same* row, the transaction's version wins (last-writer-wins),
which is weaker than a real database's row-locking or MVCC guarantee.

**On violation (documented narrowing, methodology doc `01` §5):** this
adapter's `transaction` contract is **weaker** than the abstract contract's
implicit expectation of true isolation between concurrent transactions on
the same row. This is an intentional, disclosed narrowing appropriate only
for single-process development/test use — blamed party if relied upon in
a concurrent production deployment: **CLIENT** (choosing this adapter
outside its documented scope).

### 1.3 Case-insensitive matching

Implemented by lowercasing both sides in JavaScript before comparison — see
§0.3. `null`/`undefined` are treated as equivalent for equality against a
`null` literal, matching SQL `IS NULL` and MongoDB's missing-or-null
semantics, so a caller cannot distinguish "field absent" from "field
explicitly null" through this adapter — an intentional convergence with the
other adapters' `IS NULL`-style semantics.

### 1.4 `create` under a serial-ID configuration

**Ensures:** when the deployer configures a serial/auto-increment ID
strategy, `create` assigns the next sequential integer by reading the
current table length — a same-process, non-durable counter. This satisfies
the abstract contract's "returns the created entity with its assigned
identifier" postcondition only under single-process, non-concurrent access;
concurrent creates racing on the same table can receive colliding
identifiers. **On violation:** blamed party **CLIENT** for relying on
serial-ID uniqueness under concurrent access with this adapter — the
documented scope is development/testing.

---

## 2. The Kysely-based SQL adapter

**Role relative to the abstract contract:** a full specialization covering
every SQL dialect the adapter recognizes (PostgreSQL, MySQL, SQLite, MSSQL,
and SQLite-compatible edge runtimes) behind one contract surface, with
dialect-specific behavior confined to internal strategy selection, never
leaking into the operation contracts themselves — except where explicitly
narrowed below.

### 2.1 Schema-first precondition

**Requires:** a live, already-migrated schema whose tables and columns the
adapter can introspect, matching (in identifier spelling, including any
identifier-renaming or schema-qualification the deployer's own query
customization applies) what the currently configured entities/fields
declare.

**Ensures:** on construction, the adapter can optionally run a schema
comparison (opt-in, see `04-cli.md` §migrate/generate for how this feeds
the CLI) that diffs the live introspected schema against the expected one
and reports every column that would silently reject every insert (missing
column, wrong nullability where a value is required, etc.).

**Invariant:** the adapter never auto-creates or auto-alters schema at
runtime — schema evolution is exclusively the CLI's migration/generation
responsibility (`04-cli.md`), never a side effect of a normal read/write
call. This is the defining trait of the "schema-first" posture shared by
every SQL-family adapter in this document (contrast with MongoDB, §5).

**On violation:** a write against a schema the live database does not
actually have yields the underlying engine's own constraint/type error,
surfaced as a supplier-side failure. Blamed party: **CLIENT** (the deployer
did not run the required migration before starting the application).

### 2.2 Transaction support is dialect-dependent, and this is a disclosed narrowing

**Ensures:** for every SQL dialect the adapter recognizes as supporting
interactive transactions (PostgreSQL, MySQL, SQLite in its several driver
forms, MSSQL), `transaction` provides real ACID transactional semantics:
every adapter call made through the callback's scoped adapter instance
participates in one database transaction, rolled back in full on any
thrown error.

**On violation (documented narrowing):** one SQL-compatible target — an
edge/serverless SQLite dialect with no interactive-transaction API, only a
batch-execute primitive — **cannot** support this operation at all;
`transaction` is contractually absent (not merely a no-op) for that target.
Blamed party if a caller depends on cross-statement transactional isolation
against that target: **CLIENT**, for choosing an adapter configuration
whose disclosed capability set does not include `transaction`. A caller
that needs this guarantee must not treat `transaction`'s absence as
equivalent to "transactions are supported but a no-op" — the two are
contractually distinct (see `01-core-domain/04-database-adapter-contract.md`
for the higher-order shape of a conditionally-present operation).

### 2.3 `create`/`update`/`consumeOne`/`incrementOne` under the no-`RETURNING` dialect

See §0.1 and §0.2. This adapter is the origin of the canonical four-step
fallback strategy that the Drizzle and Prisma adapters mirror.

### 2.4 Row-count postconditions depend on a driver capability precondition

**Requires:** for the no-`RETURNING` dialect specifically, `update`,
`updateMany`, `incrementOne`, and `consumeOne` depend on the underlying
driver reporting "rows matched by the predicate," not "rows whose stored
values actually changed." These are different numbers for an idempotent
write (new value equals old value).

**Ensures:** when the driver is configured to report "rows matched," an
idempotent guarded update still reports success (a match occurred) even
though no column value changed — preserving the abstract contract's
"guarded update succeeded iff the predicate matched" semantics.

**On violation (documented narrowing):** if the deployer's driver
configuration instead reports "rows changed," an idempotent guarded update
observably (and incorrectly, from the abstract contract's point of view)
reports no match. Blamed party: **CLIENT** — this is an explicit
driver-configuration precondition the adapter documents and cannot enforce
itself.

---

## 3. The Drizzle adapter

**Role relative to the abstract contract:** a full specialization across
its three supported providers (PostgreSQL-family, MySQL-family, SQLite),
structurally parallel to the Kysely adapter's dialect handling.

### 3.1 Schema-first precondition, with an explicit schema-supply requirement

**Requires:** the caller supplies the ORM's schema object explicitly (or
the adapter falls back to whatever schema object the ORM client instance
already carries). Every model this configuration writes must be resolvable
in that schema object by name; a model or field the schema object does not
declare is a **precondition violation at first use**, not at construction.

**On violation:** looking up an unresolvable model or field raises
immediately, naming the missing model/field and instructing the deployer to
regenerate the schema. Blamed party: **CLIENT**.

**Ensures:** the same opt-in schema-diff capability as the Kysely adapter
(§2.1), reading the ORM's own schema object rather than introspecting the
live database directly.

### 3.2 Row-count normalization across providers is a postcondition, not an implementation detail

**Requires:** `updateMany`/`deleteMany`/`consumeOne` must report an
affected-row count.

**Ensures:** regardless of which underlying driver family is in play, the
adapter normalizes whatever shape that driver reports (a plain numeric
field under one of several possible names, or a nested structure for one
edge SQL target) into the single numeric postcondition the abstract
contract specifies.

**Invariant:** if the driver's result shape is ever unrecognized, the
adapter treats this as an internal contract violation of its own
(**ADAPTER**-blamed) rather than silently returning a wrong count or
`undefined` — it raises rather than lying about the postcondition.

### 3.3 Transaction support is opt-in configuration, not automatic

**Ensures:** identically to the abstract contract's `transaction`
conjunct, when enabled the callback receives a scoped adapter whose writes
are all part of one underlying transaction.

**On violation (documented narrowing):** `transaction` defaults to **off**
for this adapter (the deployer must opt in), unlike MongoDB's default of
on-when-a-client-supports-it (§5.2). Blamed party for a caller assuming
transactional behavior without opting in: **CLIENT**.

### 3.4 `create`/`consumeOne`/`incrementOne` no-`RETURNING` fallback

Mirrors §0.1/§2.3 exactly for its MySQL-family provider.

---

## 4. The Prisma adapter

**Role relative to the abstract contract:** a full specialization, with
the distinguishing trait that many operations are expressed by delegating
to the ORM's own generated client methods rather than a hand-rolled query
builder, which introduces two Prisma-specific narrowings below.

### 4.1 Schema-first precondition, sourced from the generated client itself

**Requires:** a client that has actually been generated from the schema
(client generation is an explicit build step external to the adapter).

**On violation:** every operation that resolves a model by name raises
immediately if the generated client lacks that model, naming the missing
model and instructing the deployer to regenerate the client. Blamed party:
**CLIENT**.

**Ensures:** the same opt-in schema-diff capability, reading the generated
client's own compact runtime data model (a client that predates this
capability is skipped, not treated as an error).

### 4.2 A single-row write with a non-unique guard costs an extra round trip, but preserves the contract

**Requires:** the ORM's single-record update/delete primitives are typed to
require a uniquely-identifying predicate; they cannot be hoisted directly
onto an arbitrary, possibly non-unique `where`.

**Ensures:** when the predicate is not root-unique, `update` transparently
falls back to a bulk-conditioned update followed by a re-read, and
`consumeOne`/`incrementOne` fall back to a transaction that finds the
single candidate row first and then mutates it by identity — preserving
the single-row guarantee of §0.2 at the cost of an extra round trip
relative to the fast path.

**On violation (documented gap):** the ORM exposes no portable
row-locking primitive for the "find, then delete/update by id" fallback
path, so a race between two concurrent `consumeOne`/`incrementOne` calls
against the same non-unique predicate is resolved by the final
identity-scoped write's own atomicity (only one of the two racing writes
can actually match), not by an explicit lock held across the read. The
single-row postcondition of §0.2 still holds (at most one caller ever
observes a successful mutation), but the *losing* caller's diagnostic is
"predicate matched nothing" rather than "row was locked" — a
weaker-but-still-conformant race behavior. Blamed party if a caller
depends on lock-wait semantics specifically (rather than the winner/loser
outcome): **CLIENT**, for depending on a stronger guarantee than any
adapter in this document actually promises beyond §0.2.

### 4.3 Row-not-found is normalized to the same signal every other adapter uses

**Ensures:** the ORM's own "record not found" failure mode (raised as an
exception by its generated client for update/delete-by-unique-key) is
caught and translated to exactly the same "guarded operation matched no
row" signal (`null`, or a no-op for delete) that every other adapter
produces natively. **Invariant:** deletion is idempotent — deleting an
already-absent row is a no-op, not an error, matching the abstract
contract; **any other** underlying failure (constraint violation,
connectivity, permissions) is never swallowed this way and must propagate.

---

## 5. The MongoDB adapter

**Role relative to the abstract contract:** a full specialization, but the
adapter for the one genuinely **schemaless** primary store in this set —
this is the sharpest documented divergence in posture from §2–§4.

### 5.1 Schemaless precondition/postcondition (contrast with §2.1/§3.1/§4.1)

**Requires:** nothing analogous to a migrated schema. Collections and their
indexes are the adapter's own responsibility to establish, lazily, the
first time a model is actually written to or read with a filter that
benefits from an index.

**Ensures:** required and unique indexes declared by the currently
configured entities are created on first use per collection (memoized so
repeated writes to the same collection do not repeatedly attempt index
creation); there is no separate migration step and no schema-diff/schema-
check capability analogous to §2.1/§3.1/§4.1 — schema drift simply cannot
be detected ahead of time for this adapter, because there is no declared
schema on the database side to diff against.

**On violation (documented narrowing):** a required-but-absent field is
not rejected by the store itself (there is no column-level "not null"
enforcement) — any such validation is the entity/endpoint layer's
responsibility upstream of the adapter, not this adapter's. Blamed party
for a missing-required-field bug that reaches the database uncaught:
**SUPPLIER** (the layer responsible for enforcing the entity's own
invariant before calling the adapter), never this adapter, which correctly
has no schema to enforce against.

### 5.2 Transaction support requires a topology precondition the adapter cannot verify at configuration time

**Requires:** transactions require a client connected to a deployment that
actually supports multi-document transactions (a replica set or sharded
cluster) — a standalone server does not.

**Ensures:** when a client is supplied, `transaction` defaults to **on**
(opposite default from the Drizzle adapter's opt-in posture, §3.3) and
provides real session-scoped ACID semantics: every call through the
scoped adapter participates in one server-side transaction, committed only
if the callback resolves, aborted otherwise.

**On violation (documented narrowing):** against a standalone deployment
that does not support transactions, the deployer **must** explicitly
disable this default; the adapter has no way to detect topology
incompatibility ahead of the first attempted transaction, at which point
the underlying driver's own error surfaces. Blamed party: **CLIENT** for
not disabling `transaction` against a topology that cannot support it —
this is a precondition the adapter documents but cannot check proactively.

### 5.3 Identity representation is adapter-owned and reversible at the boundary

**Ensures:** the store's native identifier type (or an alternative native
identifier type, under a UUID `generateId` configuration) is transparently
converted to and from the string identifier shape every other adapter and
the rest of the system expects, at both write time (coercing a supplied
string into the native type, including inside arrays and foreign-key-like
reference fields) and read time (coercing back to string) — this
conversion is invisible to every caller above the adapter boundary,
preserving the abstract contract's "identifiers are strings" expectation
uniformly across all adapters despite MongoDB's native type being
different from a bare string.

**On violation:** a value that cannot be coerced to the store's native
identifier type on a field known to be an identifier or identifier
reference is a **CLIENT**-blamed precondition violation (a malformed
identifier was supplied), raised before any write is attempted.

### 5.4 `consumeOne`/`incrementOne` and the empty-update edge case

**Ensures:** an `incrementOne` call whose numeric-increment portion is
empty (only an absolute `set` is requested) is still satisfied correctly —
the adapter does not issue a native increment operation with nothing to
increment, which some server versions reject; it distinguishes "nothing to
increment" from "increment by zero" so the guarded read/write still
completes.

---

## 6. The Redis-class secondary store: a cache/ephemeral-value contract, *not* an adapter

This is the one storage integration in this document that is **not** an
instance of the abstract adapter contract at all, and stating that
precisely is this section's purpose.

### 6.1 What contract it actually satisfies

**Role:** a **secondary storage** contract — a much narrower key-value
surface (get / set-with-optional-TTL / delete / atomic get-and-delete /
atomic TTL-scoped increment / enumerate-keys-under-a-prefix /
clear-all-keys-under-a-prefix) that the system layers **in front of, or
alongside**, one of the five adapters in §1–§5, never in place of one.
There is no `create`/`findOne`/`findMany`/`update`/`delete`/`transaction`
surface here, and no notion of a "model" or an entity schema.

```
                  request pipeline
                        │
        ┌───────────────┴────────────────┐
        │                                 │
        ▼                                 ▼
  secondary storage                 primary adapter
  (Redis-class KV store)            (any of §1–§5)
   - session cache                   - system of record for
   - rate-limit counters               every persisted entity
   - single-use verification          - the ONLY thing that
     values, opportunistically          satisfies the abstract
     when configured                    adapter contract
        │                                 │
        └── never a substitute for ───────┘
            the primary adapter; a cache
            miss / absence here always
            falls back to (or is backed
            by) the primary adapter
```

**Requires:** a caller (rate limiting, session caching, single-use
verification-value storage where configured to use secondary storage)
that treats every value as an opaque string with an optional expiry, never
as a queryable structured row.

**Ensures:**

* `get`/`set`/`delete` behave as a plain expiring key-value store; `set`
  with a positive TTL expires the key at that boundary, `set` without one
  persists until explicitly deleted or cleared.
* `getAndDelete` is atomic: a concurrent caller can never observe the value
  after one caller has begun consuming it, matching the same single-use
  discipline as `consumeOne` (§0.2) but at the key-value level. Where the
  underlying store's ideal atomic primitive for this is unavailable, the
  contract is still discharged (a scripted equivalent is used
  transparently) — this is an implementation-fallback detail invisible at
  the contract boundary.
* `increment` is atomic and TTL-scoped: the very first increment that
  creates a counter also fixes its expiry window, and no later increment
  on the same key extends that window — this is a deliberate fixed-window
  rate-limiting postcondition, not a sliding window.
* `listKeys`/`clear`, scoped to a configured key prefix, are **best-effort**
  enumerations over a store that may be concurrently mutated by other
  callers: a key added or removed mid-enumeration may or may not be
  observed, and `clear` is **not atomic** — a failure partway through
  leaves an unknown subset already removed. **Invariant:** `clear` is
  idempotent and safe to retry to convergence; an already-empty scope is a
  no-op.

**On violation:** none of these five operations ever raises the abstract
adapter contract's entity-shaped errors (no "model not found," no schema
violation) because there is no schema — the only failure mode is the
underlying store's own connectivity/protocol failure, which propagates as
a supplier-side failure. Blamed party for a caller that mistakes this
contract for the primary adapter's (e.g. expecting a queryable, durable
system of record here): **CLIENT** — this store is documented as
ephemeral, unstructured, and non-authoritative by construction.
