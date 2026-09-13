# Core Entities and Their Invariants

This document specifies the four entities that every other capability in
better-auth is built on top of: **User**, **Account**, **Session**, and
**Verification**. It defines what identifies each entity, what cardinality
holds between them, what each field protects, and how the extension
mechanism (additional fields, plugin-contributed fields) is constrained so
it cannot violate the invariants defined here. Read this before
`02-session-lifecycle.md`, `03-credentials-and-identity.md`, and
`04-database-adapter-contract.md`, all of which assume the entities defined
here without re-deriving them.

---

## 1. The shared base contract

Every one of the four entities (User, Account, Session, Verification)
extends one common base contract before adding its own fields:

```
┌─────────────────────────────────────────────────────────────┐
│                     BASE ENTITY CONTRACT                     │
│                                                                │
│   id          : string                                        │
│                 REQUIRED, opaque, assigned by the supplier —  │
│                 a client MAY NOT choose or predict this value │
│                 through the ordinary creation path (see       │
│                 04-database-adapter-contract.md §2 on         │
│                 `forceAllowId`, the narrow escape hatch used   │
│                 only by internal single-use-token flows).     │
│                                                                │
│   createdAt   : date, defaults to "now" at creation           │
│                 INVARIANT: never changes after creation.      │
│                                                                │
│   updatedAt   : date, defaults to "now" at creation,           │
│                 refreshed to "now" on every field-level         │
│                 update the supplier performs.                  │
│                 INVARIANT: updatedAt >= createdAt always.       │
└─────────────────────────────────────────────────────────────┘
```

Every entity-specific contract below is this base contract **extended**
(never replaced) with additional fields. Per the extension rule in
`00-methodology/01-design-by-contract.md` §5, an extension may only add
obligations on top of the base, never remove `id`/`createdAt`/`updatedAt`
or change what they mean.

The four entities relate to each other like this:

```
                     ┌──────────────┐
                     │     User     │
                     │──────────────│
                     │ id           │◀───────────────────┐
                     │ email (uniq) │                     │
                     │ emailVerified│                     │
                     │ name         │                     │
                     │ image?       │                     │
                     └──────┬───────┘                     │
                            │ 1                            │
             ┌──────────────┼──────────────┐               │
             │ 0..*                        │ 0..*          │ userId
             ▼                             ▼               │ (required,
      ┌──────────────┐              ┌──────────────┐        │  FK, cascade
      │   Account     │              │   Session     │        │  on delete)
      │──────────────│              │──────────────│        │
      │ id           │              │ id           │        │
      │ userId ──────┼──────────────┼──────────────┼────────┘
      │ providerId   │              │ userId       │
      │ accountId    │              │ token (uniq) │
      │ password?    │              │ expiresAt    │
      │ access/refresh│             │ ipAddress?   │
      │  /idToken?    │             │ userAgent?   │
      └──────────────┘              └──────────────┘

      ┌──────────────────────────────────────────┐
      │              Verification                  │
      │────────────────────────────────────────────│
      │ id                                           │
      │ identifier   (not user/account-scoped;       │
      │               a free-form key the caller      │
      │               defines the meaning of)          │
      │ value                                          │
      │ expiresAt                                      │
      └──────────────────────────────────────────────┘
        (no foreign key to User/Account — see §5)
```

---

## 2. User

### 2.1 Fields and what each protects

| Field | Required | Invariant protected |
|---|---|---|
| `email` | yes (current major version) | **Uniqueness**: no two User rows may hold the same email, compared case-insensitively — the supplier lower-cases every email before it is compared or stored. This is the primary identity key for email/password sign-in and for OAuth implicit account matching (§4 of `03-credentials-and-identity.md`). |
| `emailVerified` | yes, defaults to `false` | Tracks whether control of the mailbox has been proven. Never client-settable directly on creation or generic update (the field is supplier-authority-only — see §6); it is flipped only by specific, audited operations (email verification consume, OAuth sign-in with a provider-verified matching email, or the unproven-account cleanup in §2.3). |
| `name` | yes | Free-form, no uniqueness. |
| `image` | no | Free-form, no uniqueness. |

> **Note on the email-required invariant.** The current contract requires
> `email` on every User and enforces it unique. This is deliberately
> narrower than some identity providers support (a provider may return a
> phone-only or perpetually-omitted-email identity). Any reimplementation
> should treat "email is the sign-in key" as the *current* invariant, not an
> eternal one — a wider identity key (e.g. `(providerId, accountId)` alone)
> is a legitimate future relaxation, but relaxing it is a **postcondition
> weakening** relative to every existing caller that currently relies on
> `email` always being present and unique, and must be introduced as an
> explicit, versioned change per `00-methodology/01` §5, not silently.

### 2.2 Lifecycle: verification state machine

```
                    ┌────────────────────────────────────────┐
                    │                                          │
                    ▼                                          │
        ┌───────────────────────┐                              │
        │   emailVerified: false │                              │
        │     (freshly created)  │                              │
        └───────────┬────────────┘                              │
                     │                                          │
     ┌───────────────┼───────────────────────────┐              │
     │               │                            │              │
     │ (a) consume    │ (b) OAuth sign-in with a   │ (c) email-primary
     │ email-          │     provider-trusted OR    │     proof (magic
     │ verification    │     provider-verified       │     link / email OTP)
     │ token           │     email that matches       │     resolves to this
     │                 │     the local email exactly   │     user — see §2.3
     ▼                 ▼                              ▼
        ┌───────────────────────────────────────────────┐
        │              emailVerified: true                │
        └───────────────────────────────────────────────┘
                     │
                     │ (one-way: nothing in the base contract
                     │  ever flips this back to false)
                     ▼
                 (terminal)
```

`emailVerified` is monotone: once `true`, no base-system operation resets
it to `false`. (A plugin could add a flow that does; per the blame rule in
`00-methodology/03` §4, a plugin that resets it without the base system's
knowledge is responsible for any downstream invariant it thereby breaks —
e.g. an unrelated plugin that gates a capability on `emailVerified`.)

### 2.3 Cross-cutting invariant: unproven access must not survive proof of ownership

When an **email-primary proof** (a magic link or email OTP, as opposed to a
password the account holder set themselves) resolves to a pre-existing,
not-yet-verified User row, the row's accumulated state (its linked
Accounts, its live Sessions) carries **no proof** that it belongs to the
mailbox owner — anyone could have created it by typing that email into a
sign-up form.

```
Operation:      promote-unverified-user-on-email-proof
Requires:       (1) an email-primary proof has just resolved to userId U;
                (2) U's current row has emailVerified = false.
Ensures:        every Account row referencing U is deleted, every Session
                row referencing U is deleted, and U.emailVerified becomes
                true — atomically with respect to concurrent promotions of
                the same U (see mutual exclusion below).
Invariant:      once this operation returns, no session or account created
                before the proof resolved can still authenticate as U.
On violation:   a concurrent second promotion of the same U observes the
                first promotion's lock and waits for it rather than
                double-running the strip; if the lock cannot itself be
                taken durably (verification storage is not database-backed),
                the operation degrades to best-effort serialization within
                one process. Blamed party if two racing promotions both
                partially strip: SUPPLIER (the lock is the base system's
                obligation to provide when durable storage is available).
```

```
┌────────────────────────────────────────────────────────────────────┐
│  BEFORE promotion                        AFTER promotion             │
│                                                                        │
│  User U  emailVerified=false             User U  emailVerified=true   │
│    ├─ Account (password set by ?)   ✗    (no accounts survive)         │
│    ├─ Account (google, linked by ?) ✗    (no accounts survive)         │
│    ├─ Session (created by ?)        ✗    (no sessions survive)         │
│    └─ Session (created by ?)        ✗    (no sessions survive)         │
│                                                                        │
│  A fresh session for the now-proven owner is minted AFTER this        │
│  operation returns, by the caller — never reusing a pre-proof session.│
└────────────────────────────────────────────────────────────────────┘
```

---

## 3. Account

### 3.1 Identity and cardinality

An Account row is identified externally by the pair `(providerId,
accountId)` — the **AccountKey**. `providerId` names the identity source
(a specific OAuth/OIDC provider, or the literal credential provider used
for password sign-in); `accountId` is that source's own identifier for the
principal (an OAuth subject id, or — for the credential provider — the
User's own id).

```
Operation:      resolve-account-owner-by-key
Requires:       a (providerId, accountId) pair.
Ensures:        at most one Account row in the store matches the pair; the
                result is either "no such account", "an account owned by a
                live User", or "an orphaned account" (userId references a
                User row that no longer exists — a supplier-side integrity
                defect, not a normal outcome).
Invariant:      (providerId, accountId) identifies at most one Account row.
On violation:   if more than one row matches the same pair, this is raised
                as a supplier integrity error, not resolved silently by
                picking one. Blamed party: SUPPLIER/ADAPTER — the store
                allowed two rows to be created for one external identity.
                Recoverable only by an operator manually resolving the
                duplicate; the base system has no automatic merge policy.
```

better-auth's schema does **not** declare `(providerId, accountId)` as a
database-level unique constraint by default — the invariant above is
maintained by application-level lookup discipline (querying with a small
limit and treating more than one match as a defect) rather than by a
store-enforced constraint. This is a **deliberately weaker** guarantee than
`User.email`'s uniqueness (§2.1), and any concrete adapter/deployment is
free to *strengthen* it (add its own unique index on the pair) without
violating the contract — per the Liskov rule in `00-methodology/01` §5, a
specialization may strengthen what it guarantees. A deployment that does
**not** add such an index accepts a small window in which a race between
two concurrent "link this external identity" operations can create two
rows for the same key; the detection above turns that into a loud failure
on next read rather than a silent split-brain identity.

### 3.2 Cardinality rules

```
        ┌────────────┐                          ┌────────────┐
        │    User     │  1 ─────────────── 0..* │   Account   │
        └────────────┘                          └────────────┘
```

* **One User may have many Accounts** — one per linked identity provider,
  plus at most one *credential* account (password sign-in). There is no
  base-system cap on the number of linked providers.
* **One Account belongs to exactly one User** — `userId` is required and
  is a foreign reference to User with cascading delete: deleting a User
  makes every one of its Account rows unreachable (see §3.4).
* **An Account can never be re-parented** to a different User by any base
  operation. Changing which user an external identity resolves to is not
  offered as a capability — it would silently transfer whatever that
  identity could authenticate as.

### 3.3 The credential account (password sign-in) is not a separate entity

better-auth stores a password credential as an ordinary Account row with:

```
providerId = "credential"
accountId  = <the owning User's own id>
password   = <opaque digest — see 03-credentials-and-identity.md>
```

This means: **a User can have at most one usable credential account**
in practice, because `accountId` is fixed to the User's own id and the
`(providerId, accountId)` key is meant to identify at most one row (§3.1).
It also means a User with no password set (an OAuth-only signup) simply
has no `providerId="credential"` row at all — "does this user have a
password" is answered by *absence of a row*, not by a nullable flag on
User.

### 3.4 Deletion and unlinking

```
Operation:      unlink-account
Requires:       the account being unlinked belongs to the caller's own
                User, AND either (a) the caller has more than one linked
                Account, or (b) the deployment explicitly allows unlinking
                the last account.
Ensures:        the Account row is gone; every OTHER Account and every
                Session belonging to the User is untouched.
Invariant:      a User is never left with a linked-identity count that
                the deployment's policy forbids.
On violation:   attempting to unlink the sole remaining account under the
                default policy is rejected. Blamed party: CLIENT (the
                request itself is well-formed, but its effect — leaving
                the user with zero ways to authenticate — is what the
                precondition exists to prevent).
```

Deleting the owning **User** (not just unlinking one Account) cascades: all
of that User's Account rows become unreachable, whether the store enforces
the cascade natively (a foreign-key `ON DELETE CASCADE`) or the base
system performs the equivalent cleanup explicitly. Deleting or unlinking
an **Account** never cascades to Sessions — a Session's validity is tied
to the User, not to any one linked identity (see `02-session-lifecycle.md`
§6).

---

## 4. Session

### 4.1 Fields and invariants

| Field | Required | Invariant protected |
|---|---|---|
| `userId` | yes | Every Session belongs to exactly one User (foreign reference, cascading delete). |
| `token` | yes | **Uniqueness**: no two live Session rows may share a token, store-enforced. This is the bearer secret a client presents to be recognized as that session — see `02-session-lifecycle.md` §8 for the unguessability contract. |
| `expiresAt` | yes | The session is authoritative only while `expiresAt` is in the future; a supplier must never treat an expired row as evidence of authentication (see `02-session-lifecycle.md` §3). |
| `ipAddress`, `userAgent` | no | Diagnostic/contextual metadata captured at creation time; absence never invalidates a session. |

### 4.2 Cardinality

```
        ┌────────────┐                          ┌────────────┐
        │    User     │  1 ─────────────── 0..* │   Session   │
        └────────────┘                          └────────────┘
```

A User may have **any number of concurrent, simultaneously-valid
Sessions** — there is no base-system invariant limiting this to one active
session per user (a "single active session" policy, if desired, is a
capability a plugin or deployment adds on top; it is not implied by this
contract). See `02-session-lifecycle.md` for the full creation, refresh,
and revocation contract.

---

## 5. Verification

### 5.1 What it is

Verification is a generic, single-purpose **ephemeral keyed value store**
layered on top of the durable entity model — not a user-facing entity in
its own right. It has no foreign key to User or Account; its `identifier`
field is an arbitrary string whose *meaning* is defined entirely by the
caller that created the row (an email-verification token keyed by
`"verify-email:<token>"`, a password-reset token keyed by
`"reset-password:<token>"`, a mutual-exclusion lock keyed by
`"revoke-unproven-account-access:<userId>"`, a first-writer-wins
replay-tombstone keyed by a deterministic hash of another identifier —
these are all uses of the same entity, distinguished only by identifier
naming convention).

| Field | Required | Meaning |
|---|---|---|
| `identifier` | yes | The lookup key. May be stored in plaintext or, per deployment configuration, hashed before storage (a supplier-side confidentiality hardening that does not change the read/write contract below — the same identifier, hashed the same way, must always resolve to the same row). |
| `value` | yes | Caller-defined payload (e.g. a User id, an opaque token). |
| `expiresAt` | yes | Rows past this instant are treated as already invalid by every read operation, even before they are physically removed. |

### 5.2 Lifecycle

```
                    ┌─────────────┐
                    │   created    │
                    └──────┬───────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                 │
          ▼                ▼                 ▼
   ┌─────────────┐  ┌─────────────┐   ┌─────────────┐
   │  read many    │  │  consumed    │   │   expired    │
   │  times without │  │  (first      │   │  (lazily      │
   │  side effect   │  │  caller wins,│   │  discovered   │
   │  (peek)        │  │  destructive,│   │  on next read;│
   │                │  │  race-safe)  │   │  treated as   │
   │                │  │              │   │  already gone)│
   └────────┬────────┘  └─────────────┘   └─────────────┘
            │
            └──▶ eventually consumed or expired — a Verification row
                 is never a permanent record.
```

```
Operation:      consume-verification-value
Requires:       an identifier.
Ensures:        AT MOST ONE caller, among any number racing on the same
                identifier, receives the (non-expired) row; every other
                concurrent caller receives "not found", and the row is
                gone afterward regardless of who "won" — an expired row is
                deleted but always reported as "not found", never handed
                to a caller as if valid.
Invariant:      a value consumed once can never be consumed, peeked as
                still-valid, or replayed again.
On violation:   a caller that proceeds with a state change (issuing a
                session, minting a token, changing a password) WITHOUT
                gating on a non-null consume result is a CLIENT-side
                (i.e. calling-code-side) contract violation — the
                supplier's race-safety guarantee only protects callers
                that actually check the result.
```

```
Operation:      reserve-verification-value
Requires:       an identifier that the caller wants to claim exclusively
                (e.g. a replay-tombstone for an external assertion id).
Ensures:        returns true to the FIRST caller that reserves a given
                identifier and false to every subsequent caller for the
                same identifier, for as long as the reservation has not
                expired.
Invariant:      uniqueness of "who won the reservation" is derived from a
                deterministic key computed from the identifier — not from
                the identifier column's own uniqueness, which the base
                Verification schema does not declare.
On violation:   a store that cannot make row-creation-by-deterministic-key
                atomic (i.e. cannot reject a duplicate primary key) cannot
                honor this contract and must fail closed rather than
                report a false positive. Blamed party: ADAPTER, if it
                reports success for two racing reservations of the same
                identifier.
```

---

## 6. Additional fields and plugin schema extension as a contract

Every entity's field set is not fixed to the tables above — a deployment
may declare `additionalFields` on User/Session/Account/Verification, and a
plugin may contribute its own fields to any of the four base tables. This
extension mechanism is itself a contract, staged exactly as
`00-methodology/02-higher-order-contracts.md` §3 describes for `init`
functions: each layer's field set is added on top of what the previous
layer already established, never replacing it.

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 0:  coreSchema           { id, createdAt, updatedAt }       │
│                     │                                              │
│                     ▼  (entity-specific fields — §2/§3/§4/§5 above) │
│  Layer 1:  base entity schema   { email, emailVerified, ... }       │
│                     │                                              │
│                     ▼  (deployment config)                          │
│  Layer 2:  additionalFields     { <deployer-chosen fields> }          │
│                     │                                              │
│                     ▼  (each plugin, in registration order)          │
│  Layer 3:  plugin-contributed   { <plugin-chosen fields> }             │
│            fields                                                    │
│                                                                       │
│  RULE (per 00-methodology/01 §5): a later layer may ADD fields; it   │
│  must not redefine the TYPE, uniqueness, or meaning of a field a      │
│  prior layer already declared. Renaming a field's on-the-wire name    │
│  (`fieldName`) or a table's storage name (`modelName`) is permitted   │
│  and does not change the logical contract — see 04-database-adapter- │
│  contract.md §5 for why the adapter must not care about this either.  │
└─────────────────────────────────────────────────────────────────┘
```

### 6.1 A field's `input`/`returned`/`required` attributes are its own arrow contract

Every field — base or contributed — carries three independent gates that
together define what a *client* may do with it, separate from what it
means internally:

```
Contract:     a field's declared attributes -> what a generic write/read
              route may do with it

  input:false     ->  the CLIENT may never set this field through a
                       generic create/update route (attempting to is
                       rejected — a well-formed request that violates
                       this precondition is blamed on the CLIENT). Only
                       a specific, audited operation that bypasses the
                       generic input path may set it (e.g. emailVerified
                       is input:false; only the operations named in §2.2
                       may change it).

  returned:false  ->  the field is never present in output handed back
                       to a client (e.g. a stored password digest, an
                       OAuth access/refresh/id token, and their expiry
                       timestamps are all returned:false on Account —
                       see 03-credentials-and-identity.md §2 for why this
                       is load-bearing, not cosmetic).

  required:true   ->  creation fails closed (a CLIENT-blamed rejection)
                       if the field is absent and has no default.
```

### 6.2 The extension contract's sharpest edge: a contributed field defaults to writable

Unlike a base entity field (whose `input`/`returned` gates are chosen
deliberately per field, as in §6.1), a field a **plugin** contributes to
User/Session/Account is, by default, writable through the generic input
path unless the plugin itself declares `input: false`. This means:

```
┌───────────────────────────────────────────────────────────────────┐
│  A plugin that contributes a field meant to be a SYSTEM-AUTHORITY    │
│  value (e.g. "this session was elevated by two-factor," "this        │
│  account's tier was set by billing") MUST declare that field           │
│  input:false ITSELF. The base system provides no default protection  │
│  for plugin-contributed fields the way it does for its own.           │
│                                                                        │
│  Per 00-methodology/03 §4 ("first cause, not first observer"):         │
│  if a plugin omits input:false on such a field and a client writes     │
│  it through a generic route, the resulting invariant violation is      │
│  blamed on the PLUGIN AUTHOR who under-specified the field — not on    │
│  the base system, and not on whichever other plugin or operation       │
│  later trusts the now-corrupted field as authoritative.                 │
└───────────────────────────────────────────────────────────────────┘
```

---

## 7. Summary table of cross-entity invariants

| Invariant | Enforced by | Scope |
|---|---|---|
| `User.email` unique (case-insensitive) | schema-level unique constraint | global |
| `(Account.providerId, Account.accountId)` identifies ≤ 1 row | application-level lookup discipline, not a store constraint by default | global (best strengthened per-deployment) |
| `Account.userId` references a live User | schema-level FK, cascading delete | per-account |
| `Session.token` unique | schema-level unique constraint | global |
| `Session.userId` references a live User | schema-level FK, cascading delete | per-session |
| `emailVerified` is monotone (false→true, never back) in the base system | operation-level discipline (§2.2) | per-user |
| A field's `input`/`returned` gates bind every generic route | schema attribute, checked on every parse | per-field |
| A contributed field defaults to client-writable unless the contributor opts out | schema attribute default | per-plugin-field (§6.2) |
