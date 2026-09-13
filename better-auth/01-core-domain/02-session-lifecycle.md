# Session Lifecycle

This document specifies the full contract of the Session entity introduced
in `01-entities-and-invariants.md` §4: creation, expiry, rolling refresh,
revocation (single/all/others), concurrent-session behavior, the coupling
between a Session and its owning User/Account, and the token's own
guarantees. It assumes the base Session fields and cardinality already
established there.

---

## 1. The session invariant, stated once

```
INVARIANT (Session):
  A session row authenticates its bearer as its `userId` IF AND ONLY IF
  `expiresAt` is strictly in the future AND the row has not been revoked.
  Neither "the row exists" nor "the row was valid a moment ago" is
  sufficient — every read that authorizes an action must re-check
  liveness at the moment of use.
```

Everything below is either how a session enters this state (creation),
how it is kept in this state longer than its original grant (refresh), or
how it is forced out of this state before natural expiry (revocation).

---

## 2. Creation

```
Operation:      create-session
Requires:       a `userId` naming a User the caller is entitled to start a
                session for (the caller — an internal flow such as sign-in,
                sign-up, or OAuth callback — has already authenticated or
                provisioned that User by the time this is invoked; this
                operation itself performs no authentication).
Ensures:        a new Session row is produced with:
                  - a freshly generated `token`, unique among all live
                    sessions (see §8);
                  - `expiresAt` set to now + a configured duration — a
                    SHORTER duration when the caller signals "do not
                    remember me" than the deployment's normal session
                    lifetime (see §2.1);
                  - `ipAddress`/`userAgent` captured from the originating
                    request when available, absent otherwise;
                  - `createdAt`/`updatedAt` set to now.
                The returned Session's `userId` matches the requested one
                exactly — no operation is permitted to silently redirect a
                newly created session to a different user (see
                04-oauth-and-federation cross-reference: any hook that
                changes the effective user mid-flow must be treated as a
                conflict, not silently honored).
Invariant:      immediately after this operation returns, the new session
                satisfies the session invariant in §1 (it is not expired
                and not revoked).
On violation:   failure to create the row (store unavailable, constraint
                violation) is a SUPPLIER/ADAPTER-blamed failure — the
                caller supplied a valid userId and cannot itself have
                caused a storage failure.
```

### 2.1 The two expiry durations are a configuration-driven contract, not a fixed number

```
                          create-session
                                │
                 ┌──────────────┴──────────────┐
                 │                              │
        "remember me" = true            "remember me" = false
        (default)                        (explicit opt-out)
                 │                              │
                 ▼                              ▼
     expiresAt = now + <deployment's      expiresAt = now + <a short,
     configured session lifetime>          fixed duration, independent
     (deployer-tunable; unrelated          of the deployment's normal
     to any other duration in this         lifetime — intended for
     document)                             "this browser session only"
                                            semantics>
```

This is a client-signaled fork in the postcondition: the client's request
carries the "remember me" intent, and the supplier's obligation (which
`expiresAt` value is produced) depends on it. Both branches still satisfy
the base session invariant identically — only the grant length differs.

### 2.2 Storage-target variants are configuration, not separate contracts

A session may be persisted to a durable store (the primary database), to a
fast ephemeral store (a secondary, cache-shaped storage layer), to both at
once (durable store as source of truth, secondary store as an
accelerating mirror), or to the secondary store *only* (no durable row at
all — the secondary store becomes authoritative). Every operation in this
document (`create`, `find`, `update`, `delete`) has **the same externally
observable contract** regardless of which of these four configurations is
active — the storage target is a supplier-internal decision, never
something a caller must branch on.

```
┌─────────────────────────────────────────────────────────────────┐
│                    create-session (any storage mode)               │
│                                                                      │
│   durable-only:        write durable row  ──▶  done                 │
│                                                                      │
│   durable + mirror:    write durable row  ──▶  queue a BEST-EFFORT   │
│                                                 mirror write to the   │
│                                                 secondary store,      │
│                                                 AFTER the durable      │
│                                                 write's transaction    │
│                                                 boundary closes         │
│                                                 (see §7)                │
│                                                                          │
│   secondary-only:      write to secondary store directly ──▶  done      │
│                        (a caller-supplied id is generated by the        │
│                        base system itself in this mode, since no        │
│                        durable-store id-generation path runs)            │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Expiry semantics

A session's `expiresAt` is checked on every read that is used to authorize
something, not just at creation. A row whose `expiresAt` has passed is:

* never returned as a valid session to any caller checking liveness;
* eligible for physical removal on next contact (a "touch" that discovers
  expiry deletes the row as a side effect, unless the deployment defers
  that cleanup to a later, explicit revalidation — see §3.1);
* **never** implicitly "renewed back to life" by any operation in this
  document. Only §4's rolling-refresh contract extends `expiresAt`, and
  only while the row is still live at the moment of refresh.

### 3.1 Deferred session refresh mode

```
Contract:   read-session -> { session, needsRefresh: boolean } | null

  In the default (non-deferred) mode, a session read that determines the
  row is due for a rolling refresh (§4) performs the refresh write
  synchronously, as part of the same read.

  In DEFERRED mode (a configuration toggle), a plain read (idempotent,
  side-effect-free) instead reports `needsRefresh: true` alongside the
  still-valid session, and the caller must issue a SEPARATE, explicit
  write-intent request to actually perform the refresh. This lets a
  deployment keep ordinary session reads side-effect-free (cacheable,
  safe to retry) while still supporting rolling expiration on demand.
```

---

## 4. Rolling refresh (extending `expiresAt` on use)

```
Operation:      refresh-session-on-access
Requires:       a live (non-expired, non-revoked) session is being read
                for authorization purposes, AND the caller has not
                disabled refresh for this read (either per-request or via
                deployment-wide configuration), AND the caller has not
                signaled "do not remember me" for this session (§2.1 —
                such sessions are never extended past their original short
                grant).
Ensures:        IF the session is "due" for a refresh (see formula below),
                `expiresAt` is extended to now + the deployment's full
                session lifetime, and `updatedAt` is set to now.
                IF the session is not yet due, nothing is written — this
                is a THROTTLE, not an unconditional touch-on-every-read.
Invariant:      a session's `expiresAt` only ever moves forward in time as
                a result of this operation; it is never shortened by a
                refresh.
On violation:   a refresh write that fails because the row was concurrently
                deleted (e.g. revoked by another request racing this one)
                must not be treated as an ordinary write failure — the
                caller observes "no session" (as if reading a moment
                later), not an error. Blamed party: none — this is a
                benign race between legitimate operations, not a contract
                violation by either side.
```

### 4.1 The throttle formula

Refreshing on literally every read would mean a write on every request.
Instead, a session is "due" for refresh only once its remaining lifetime
has fallen below a configured update-age threshold:

```
   dueDate  =  expiresAt  −  <full session lifetime>  +  <update-age>

   refresh IS due  ⟺  now >= dueDate
                    ⟺ remaining-lifetime(session) <= <update-age>
```

```
   session lifetime:  |<──────────────── full lifetime ────────────────>|
   timeline:           createdAt                                    expiresAt
                        │                                                │
                        │<───── not due for refresh ─────>│<── due ──>│
                                                            ^
                                                     dueDate = expiresAt
                                                       - lifetime + updateAge
```

A read that lands in the "not due" region returns the session as-is with
no write. A read landing in the "due" region performs the extension
(§4, subject to deferred mode in §3.1).

---

## 5. Revocation

Three distinct revocation operations exist, differing only in *which*
sessions they target — all three share the requirement that the caller
present an **authoritative** session (one read from the durable/primary
source, bypassing any accelerating read-cache — see §9) before any
revocation is honored, because revocation is inherently a sensitive,
security-relevant write.

### 5.1 Revoke one session by token

```
Operation:      revoke-session(token)
Requires:       the caller holds a currently-authoritative session of
                their own (proves they are *a* legitimate, currently-live
                principal — not necessarily the owner of `token`).
Ensures:        IF a session matching `token` exists AND its `userId`
                equals the caller's own authoritative session's `userId`,
                that session is deleted. OTHERWISE (token not found, or it
                belongs to a different user), NOTHING is deleted.
Invariant:      a caller can never revoke a session belonging to a
                different user by supplying its token, even though the
                operation reports success either way (see next clause).
On violation:   the operation reports the SAME successful outcome whether
                the token matched-and-was-deleted or matched-nothing/
                matched-someone-else — this is a deliberate opacity, not a
                missing error path: distinguishing the two responses would
                let a caller enumerate whether an arbitrary token string
                corresponds to a live session belonging to someone else.
                Blamed party for a caller relying on the response to
                distinguish these cases: CLIENT — the contract never
                promised that distinction.
```

```
┌──────────────────────────────────────────────────────────────────┐
│                     revoke-session(token) outcomes                  │
│                                                                        │
│   token belongs to caller's own user  ──▶  deleted, reports success    │
│   token belongs to a different user   ──▶  NOT deleted, reports        │
│                                             success (same shape)         │
│   token does not exist at all         ──▶  NOT deleted, reports         │
│                                             success (same shape)          │
│                                                                            │
│   (a caller cannot distinguish these three outcomes from the response)    │
└──────────────────────────────────────────────────────────────────┘
```

### 5.2 Revoke all of a user's sessions

```
Operation:      revoke-all-sessions(for: the caller's own authoritative user)
Requires:       the caller holds a currently-authoritative session.
Ensures:        every session row belonging to that user — INCLUDING the
                one the caller is currently using to make this request —
                is deleted.
Invariant:      after this returns, no session for that user satisfies the
                liveness check in §1, until a new one is created.
On violation:   this operation targets only the caller's own user; it
                cannot be directed at another user's sessions through this
                contract at all (there is no "for" parameter accepting an
                arbitrary user id in the client-facing shape of this
                operation).
```

### 5.3 Revoke every session except the current one

```
Operation:      revoke-other-sessions(for: the caller's own authoritative user)
Requires:       the caller holds a currently-authoritative session.
Ensures:        every LIVE session belonging to that user, EXCEPT the one
                whose token matches the caller's current authoritative
                session, is deleted.
Invariant:      the caller's own current session survives this operation
                unconditionally.
On violation:   n/a for well-formed calls; a session that expires between
                being listed and being individually revoked is a benign
                race (same treatment as §4's violation clause).
```

### 5.4 Revocation sequence (all three share this shape)

```
   client                    supplier                        store
     │                          │                               │
     │  revoke-* request         │                               │
     ├─────────────────────────▶│                               │
     │                          │  read AUTHORITATIVE session      │
     │                          │  (bypass any read-cache)          │
     │                          ├──────────────────────────────▶│
     │                          │◀──────────────────────────────┤
     │                          │  [not live] ──▶ reject: caller   │
     │                          │                 is not authenticated
     │                          │  [live] ──▶ compute target set     │
     │                          │             (§5.1/5.2/5.3)          │
     │                          ├──────────────────────────────▶│
     │                          │        delete target row(s)         │
     │                          │◀──────────────────────────────┤
     │◀─────────────────────────┤                               │
     │   success                │                               │
```

---

## 6. Concurrent sessions and the User/Account coupling

* **Concurrent sessions**: unbounded. Nothing in the base contract limits
  how many live sessions one User may hold at once; §5.2/§5.3 exist
  precisely because a user is expected to accumulate multiple sessions
  (different devices/browsers) and may want to prune them selectively.
* **Session ↔ User**: a session's validity is anchored to the *User*, not
  to any specific linked Account. Deleting the User cascades to delete (or
  make unreachable) every one of that User's sessions — see
  `01-entities-and-invariants.md` §3.4.
* **Session ↔ Account**: unlinking or deleting one linked Account has **no
  effect** on the User's existing sessions. A session issued via a
  since-unlinked OAuth provider remains exactly as valid as any other
  session for that User until it naturally expires or is explicitly
  revoked — the session does not "belong" to the Account that was live at
  the moment it was created.

```
┌────────────────────────────────────────────────────────────────┐
│   User deleted        ──▶  ALL sessions for that user become      │
│                             unreachable (cascade)                  │
│                                                                       │
│   One Account unlinked ──▶  NO effect on any session                 │
│   or deleted from a                                                    │
│   still-live User                                                       │
└────────────────────────────────────────────────────────────────────┘
```

---

## 7. Secondary-storage mirror: an explicitly weaker consistency contract

When a session is mirrored to a secondary (cache-shaped) store alongside
the durable store, the mirror write happens **after** the durable write's
transaction boundary has already closed — it is queued and executed
post-commit, not inside the same atomic unit.

```
   ┌─────────────────────────────┐        ┌───────────────────────────┐
   │   durable-store transaction    │        │  post-commit mirror write   │
   │───────────────────────────────│        │──────────────────────────│
   │  write Session row              │───────▶│  write session payload to    │
   │  COMMIT                         │  after  │  secondary store, with a      │
   │                                  │  commit │  TTL derived from expiresAt   │
   └─────────────────────────────┘        └───────────────────────────┘
                                                        │
                                              on failure: LOGGED, not
                                              surfaced to the caller —
                                              the durable write already
                                              succeeded and is not rolled
                                              back for a mirror failure.
```

```
Invariant (WEAKENED, by design): the secondary-store mirror is an
  eventually-consistent, best-effort accelerator over the durable session
  record — NOT a second source of truth that is guaranteed consistent
  with the durable row at every instant. A reader that consults the
  mirror before the post-commit write has run observes a session that is
  durably valid but not yet reflected in the cache (a false negative, not
  a false positive — see 04-database-adapter-contract.md §7 for the
  general form of this "weakened postcondition, who is told" pattern).
```

Symmetrically, when the secondary store is the *only* store (§2.2,
secondary-only mode), there is no such gap — the secondary store IS the
durable record for that deployment shape, and reads/writes against it are
as strongly consistent as that store itself provides.

---

## 8. Token invariants

```
Contract on the session token (stated behaviorally, not by algorithm):

  UNIQUENESS:      no two live sessions share a token — enforced by the
                    store (a uniqueness constraint), not merely
                    "practically unlikely."

  UNGUESSABILITY:  a token must be drawn from a source with enough entropy
                    that an adversary who can observe many valid tokens,
                    or who can make many guesses, cannot feasibly predict
                    or enumerate another valid token. This is a property
                    the SUPPLIER must guarantee of its token-generation
                    process; the specific algorithm is out of scope for
                    this contract (see 00-methodology/01 §6 — this
                    document deliberately excludes algorithm choice).

  OPACITY:         a client must treat the token as a bearer secret with
                    no interpretable internal structure — the supplier
                    makes no promise that the token encodes anything
                    (a userId, a timestamp, etc.) that a client could
                    extract or rely on.

  BLAME:           a token collision (the supplier issuing the same token
                    twice while the first is still live) is a SUPPLIER
                    violation. A token being guessed or leaked through a
                    channel outside this contract (e.g. logged in
                    cleartext by the calling application, transmitted over
                    an insecure channel by a misconfigured deployment) is
                    a CLIENT/deployer violation — the token contract only
                    governs generation and uniqueness, not the caller's
                    handling of the secret once issued.
```

---

## 9. Authoritative reads vs. accelerated reads

Two distinct read paths exist for "is this session valid," and sensitive
operations (§5's revocations, credential changes in
`03-credentials-and-identity.md`, account deletion) must use the
authoritative path specifically:

```
Contract:   get-session -> { session, user } | null   (ordinary path)
Contract:   get-authoritative-session -> { session, user } | null
              (bypasses any accelerating cache; always consults the
               source of truth directly)

  Applies at: any endpoint whose action, if authorized on stale/cached
              data, would let an already-revoked session perform a
              sensitive action (revoke-*, password/email change, account
              deletion, account unlinking).

  On mismatch: an endpoint that uses the ordinary (possibly cached) path
               for a sensitive operation is a SUPPLIER-side contract
               violation — the base system commits to routing every
               sensitivity-tagged operation through the authoritative
               path; a plugin or deployment extension that adds a new
               sensitive operation without doing so inherits the blame
               for any resulting authorization-on-stale-data incident,
               per 00-methodology/03 §4 ("first cause, not first
               observer").
```

There is also a distinct, narrower notion of a session being **fresh**
(created recently enough to authorize the most sensitive operations, e.g.
changing a password without re-supplying it, or listing all sessions) —
orthogonal to "authoritative":

```
Contract:   require-fresh-session -> passes | rejects

  Requires: the session is authoritative (§9 above) AND
            now - session.createdAt < <configured freshness window>.
  Ensures:  a session older than the freshness window is rejected for
            freshness-gated operations even though it is still perfectly
            VALID for ordinary authorization.
  On violation: rejected as a distinct error condition from "not
            authenticated" — the caller has a valid session, just not a
            recent enough one, and the recoverable action is to
            re-authenticate (or supply the credential directly, where the
            operation offers that alternative — see
            03-credentials-and-identity.md §5's delete-user password
            fallback).
```
