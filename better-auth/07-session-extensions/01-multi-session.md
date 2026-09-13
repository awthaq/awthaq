# Multi-Session Extension

> Extends: `01-core-domain/02-session-lifecycle.md` (the base session contract).
> Read `00-methodology/01-05`, `02`, and `03` before this document — vocabulary
> and the Liskov extension rule are used here without re-derivation.

## 1. What is being extended

The base session contract (elsewhere in this tree) establishes, for a single
browser/client context:

* a session is an unforgeable token bound to exactly one user;
* at most one session token is "the" session carried by the primary
  session-cookie slot for a given browser context at any stable observation
  point;
* validity requires a canonical lookup (token → live, unexpired, unrevoked
  record) — the *same* lookup operation on every request, never a
  parallel/duplicated check;
* revocation is effective-immediately: the next lookup of a deleted token
  fails.

Multi-session does not change any of this. It adds a **second layer of
bookkeeping** — a set of auxiliary, individually-signed cookies, one per
concurrently-held session — so that *several* base-contract-valid sessions
can be tracked side by side for the same browser, with exactly one of them
promoted, at any moment, into the primary session-cookie slot the base
contract already defines as "the" session. Nothing about how an individual
session is validated changes; what changes is that a browser context may now
*remember* more than one such session at once and switch which one occupies
the primary slot.

```
                    BASE CONTRACT                    MULTI-SESSION EXTENSION
              ┌────────────────────────┐      ┌──────────────────────────────────┐
              │ 1 browser context      │      │ 1 browser context                 │
              │  → 1 primary session   │      │  → 1 primary session (unchanged)  │
              │    cookie slot         │      │  → N auxiliary "device-slot"      │
              │  → validity = base     │      │    cookies, each independently    │
              │    lookup contract     │      │    signed, each pointing at a     │
              └────────────────────────┘      │    base-contract-valid session    │
                                               │  → validity of EACH slot = the    │
                                               │    SAME base lookup contract,     │
                                               │    invoked once per slot          │
                                               └──────────────────────────────────┘
```

## 2. Configuration

| Option | Default | Effect |
|---|---|---|
| `maximumSessions` | `5` | Upper bound on the number of auxiliary device-slot cookies tracked per browser context. See §5 for the precise (soft) enforcement contract — exceeding it does **not** reject the sign-in. |

## 3. Vocabulary introduced by this extension

* **Device slot** — one auxiliary, HMAC-signed cookie named
  `<sessionCookieName>_multi-<token-lowercased>`, whose *signed value* is the
  session token it vouches for. The slot's existence is a claim of the form
  "this browser context has previously authenticated as the session
  identified by this token, and that authentication should remain
  switch-back-able."
* **Active session** — whichever session's token currently occupies the
  *primary* session-cookie slot (the base contract's own cookie). This is a
  **transient, cookie-level fact**, not a stored attribute of the session
  record itself — no "is-active" flag exists in storage. Two different
  browsers/devices holding device slots for the same user therefore each have
  their *own*, independent notion of which session is active; multi-session
  never tries to reconcile these across browser contexts.

## 4. Operations

### 4.1 Track-on-issuance (implicit — runs after every session-creating call)

```
Operation:     device-slot registration (after-hook, matches every request)
Requires:      a new session was just issued in this response
               (ctx.context.newSession is present) AND a Set-Cookie for the
               primary session token is present in the response.
Ensures:       IF no existing device slot for the new session's token AND
                 not-over-capacity (see §5):
                   a new signed device-slot cookie is set for the new
                   session, using the SAME cookie attributes as the primary
                   session cookie.
               IF a device slot already exists for the same USER (not
                 necessarily the same token — see the "replace" case below):
                   that prior slot's session is deleted from storage and its
                   cookie is expired BEFORE the capacity check runs — a
                   fresh sign-in as a user who already holds a tracked slot
                   REPLACES, it does not ADD.
Invariant:     a device slot's signed value is exactly the token of a session
               that, at the moment the slot was created, satisfied the base
               session contract's validity condition.
On violation:  n/a (this is a side-effecting after-hook; it does not itself
               reject the triggering request). A slot that later fails the
               base validity check (expired/revoked) is simply filtered out
               wherever slots are read — see §4.2.
```

Every slot is created by re-signing a token that the base contract *already*
vouched for in this same response — the extension never mints or accepts a
device-slot value that did not come from a base-contract-valid session
issuance. This is what keeps the extension from being able to smuggle in a
session the base contract would not otherwise have created.

### 4.2 `listDeviceSessions`

```
Operation:     list-device-sessions
Requires:      a `cookie` header is present (no session middleware
               requirement — this endpoint tolerates a fully anonymous
               request and answers with an empty list rather than
               rejecting).
Ensures:       returns exactly one {session, user} pair per DISTINCT user
               among the browser context's device-slot cookies whose signed
               value verifies (HMAC) AND whose underlying session record
               still satisfies the base contract's expiry condition at read
               time.
Invariant:     a slot cookie whose signature fails to verify, or whose
               referenced session has since expired/been revoked, is SILENTLY
               excluded — it is never surfaced as an error, and (per this
               operation alone) its stale cookie is not proactively cleared.
               "Distinct user" de-duplication means: if two device slots
               happen to reference two different, still-valid sessions of
               the SAME user, only one is returned (first found) — a user
               is represented in this list once, by whichever of their
               sessions is enumerated first from the raw cookie header's key
               order (an incidental order — do not treat it as "most
               recent").
On violation:  n/a — no precondition can fail; a hostile or malformed cookie
               header degrades gracefully to fewer/zero listed sessions
               (blamed party if this ever surprises a caller: CLIENT, for
               having sent a cookie jar this endpoint could not make sense
               of — never a 5xx).
```

### 4.3 `setActiveSession`

```
Operation:     set-active-session
Requires:      request body names a `sessionToken`.
               A device-slot cookie named
               `<sessionCookieName>_multi-<sessionToken.lowercased>` MUST be
               present and MUST verify against the server secret.
Ensures:       IF the signed cookie fails to verify, OR verifies but the
                 session it names has expired:
                   UNAUTHORIZED is raised; a verified-but-expired slot's
                   cookie is proactively expired as a side effect.
               IF the signed cookie verifies AND the session is still valid:
                   the PRIMARY session cookie is overwritten to carry that
                   session — i.e. this session becomes "active" per §3 —
                   and the {session, user} pair is returned.
Invariant:     activation acts EXCLUSIVELY on the token recovered from the
               verified, signed cookie value — never on the raw
               `sessionToken` string supplied in the request body. The body
               value is used only to compute which cookie NAME to look for.
               Consequently: a caller cannot activate a session it does not
               hold a validly-signed device slot for, no matter what token
               string it names in the body — possession of someone else's
               plaintext token is not sufficient; possession of a slot
               COOKIE signed by this server for that token is required.
On violation:  Missing/unverifiable slot cookie, or slot names an expired
               session → UNAUTHORIZED. Blamed party: CLIENT (the caller
               presented a credential it does not legitimately hold, or one
               that has lapsed — recoverable by re-authenticating to obtain
               a fresh, validly-signed slot).
```

```
SEQUENCE: setActiveSession
──────────────────────────
  client                      multi-session endpoint            base adapter
    │  POST /multi-session/set-active                                │
    │  { sessionToken: T }                                           │
    ├──────────────────────────▶│                                    │
    │                            │  look up cookie                    │
    │                            │  "<name>_multi-<T.lower>"          │
    │                            │  in the REQUEST's own cookie jar   │
    │                            │  and verify its HMAC signature      │
    │                            │                                    │
    │                     ✗ absent/invalid signature                  │
    │◀── UNAUTHORIZED ───────────┤  (blame: CLIENT)                   │
    │                            │                                    │
    │                     ✓ signature verifies → recover token T'     │
    │                            │  (T' is authoritative; T is not)   │
    │                            ├───────────────────────────────────▶│
    │                            │        findSession(T')              │
    │                            │◀───────────────────────────────────┤
    │                     ✗ expired → expire the slot cookie, 401      │
    │                     ✓ valid → overwrite PRIMARY cookie with T'   │
    │◀── 200 {session,user} ─────┤                                    │
```

### 4.4 `revokeDeviceSession`

```
Operation:     revoke-device-session
Requires:      caller holds a currently-valid session for SOME slot (base
               session middleware applies to this endpoint — an unrelated,
               fully anonymous caller may not invoke it).
               Body names a `sessionToken`; as with §4.3, the acting
               credential is the SIGNED device-slot cookie for that token,
               not the plaintext body value.
Ensures:       the session named by the verified slot is deleted from
               storage and its slot cookie is expired.
               IF the revoked session WAS the active session (§3):
                 some OTHER still-valid device slot in this browser
                 context's cookie jar, if any exists, is promoted to
                 active (its cookie becomes the new primary cookie);
                 otherwise the primary cookie is cleared entirely
                 (signed-out state).
Invariant:     revocation acts on the session recovered from the verified
               slot cookie, never on the raw body token — identical binding
               discipline to §4.3, and for the identical reason: a caller
               must not be able to revoke a session it does not hold a
               validly-signed slot for merely by naming its token.
               Promotion of a replacement active session (when required)
               makes NO ordering guarantee among the remaining valid slots —
               "next active" is whichever slot is encountered first while
               re-scanning the cookie header; this is NOT a most-recently-
               used or least-recently-used policy, and no such policy
               should be assumed by a client.
On violation:  Missing/unverifiable slot cookie → UNAUTHORIZED, blame
               CLIENT. A revoke naming a token the caller never held a slot
               for silently fails to affect the intended target (see the
               binding invariant above) rather than revoking the wrong
               session — this is a deliberate SUPPLIER guarantee, not a
               violation.
```

### 4.5 Sign-out cascade (hook on `/sign-out`)

```
Operation:     sign-out cascade (after-hook, matches path === "/sign-out")
Requires:      the base sign-out operation has already run (this hook fires
               AFTER it) and a `cookie` header carrying zero or more
               device-slot cookies is present.
Ensures:       EVERY device-slot cookie in THIS browser context's cookie jar
               whose signature verifies has its underlying session deleted
               and its cookie expired — not only the session that was
               primary/active.
Invariant:     the cascade is scoped strictly to slots present in the
               REQUESTING browser context's own cookie jar. It cannot and
               does not reach sessions the same user holds in a DIFFERENT
               browser context (a different device, a different browser
               profile) — those are untouched.
On violation:  n/a — a forged slot cookie (signature does not verify) is
               skipped, not revoked; see §6 for the adversarial case.
```

```
STATE DIAGRAM: one browser context's device-slot set
─────────────────────────────────────────────────────

        ┌─────────────┐   sign-in as         ┌───────────────────────┐
        │   empty      │──same user again───▶│  N slots, one ACTIVE   │
        │ (signed out) │                      │  (replace-in-place)   │
        └──────┬───────┘                      └────────┬──────┬──────┘
               │                                        │      │
     sign-in ──┘                          setActive(S) ─┘      └── revoke(S)
     as user A                              (S ∈ slots)             │
               │                                 │                  │
               ▼                                 ▼                  ▼
      ┌─────────────────┐              ┌───────────────────┐  ┌───────────────────────┐
      │ 1 slot, ACTIVE   │◀── sign-in ──│ ACTIVE pointer     │  │ slot removed;          │
      │ (= new session)  │   as user B  │ moves to S         │  │ IF S was ACTIVE:       │
      └────────┬─────────┘  (capacity   │ (other slots       │  │   promote arbitrary    │
               │             permitting)│  untouched)         │  │   remaining slot, else │
               │                        └───────────────────┘  │   clear primary cookie │
               │                                                └───────────────────────┘
        sign-out ("/sign-out")
               │
               ▼
        ┌──────────────┐
        │    empty     │   (ALL verifiable slots deleted, not just ACTIVE)
        └──────────────┘
```

## 5. The capacity contract (`maximumSessions`) — a documented SOFT cap

```
Operation:     capacity check, embedded in §4.1's after-hook
Requires:      (as in §4.1)
Ensures:       currentCount = (# existing verifiable slots)
                              − (# same-user slots just replaced)
                              + (1 if a primary session cookie was set this
                                 response)
               IF currentCount > maximumSessions:
                   the NEW session is NOT given a device-slot cookie.
                   It still becomes the active session (the primary cookie
                   was already set by the base contract) — but it is
                   untracked: it will not appear in listDeviceSessions, and
                   it cannot later be switched back to via setActiveSession
                   once some other slot is activated, because no slot
                   cookie exists for it. It remains a fully valid session by
                   the base contract until it separately expires.
Invariant:     exceeding the configured maximum NEVER rejects
               authentication and NEVER deletes an existing tracked slot to
               make room. The cap bounds how many sessions this extension
               REMEMBERS, not how many the base contract permits to exist.
On violation:  There is no "violation" state here by construction — this is
               a documented WEAKENING of the naive expectation that
               `maximumSessions` behaves as a hard, rejecting limit. Per
               methodology doc 01 §5 / doc 03 §4: this must be, and here is,
               explicitly documented rather than silently discovered — a
               deployer who assumes eviction-on-overflow and is surprised by
               an "invisible" untracked session should read this as a
               SUPPLIER-documented tradeoff, not a bug. Blame for any
               resulting confusion, once documented, shifts to the CLIENT
               (deployer) for not reading the configuration contract.
```

## 6. Adversarial / blame-relevant behaviors confirmed by this extension

| Scenario | Outcome | Blamed party |
|---|---|---|
| Attacker forges a device-slot cookie value (`token.fake-signature`) and rides along on a victim's sign-out request | Forged cookie fails HMAC verification, is skipped; victim's real session, held in the VICTIM's own cookie jar, is untouched | n/a — correctly rejected; a forgery attempt is CLIENT-originated and inert |
| Caller places its OWN validly-signed slot cookie under a DIFFERENT session's slot cookie NAME, and names that other session's token in the request body, to `revoke`/`setActive` | Binding invariant (§4.3/§4.4) means the signed cookie's decoded value — the caller's own token — is what's acted on, not the cookie name or body token; the other session is unaffected | n/a — correctly rejected |
| Sign-in as a user who already holds a tracked slot | Old slot silently replaced (not duplicated) | n/a — documented behavior (§4.1) |

## 7. Liskov compliance check

```
Base session contract:            REQUIRE P (valid credential)   ENSURE Q (validity per canonical lookup)
Multi-session's per-slot check:   REQUIRE P (unchanged — same lookup, invoked once per slot)
                                   ENSURE  Q ∧ Q' where
                                     Q' = "this token is additionally reachable via a
                                          browser-remembered, signed device slot, and
                                          switchable into the primary slot without
                                          re-authenticating"
```

* Precondition: **unchanged** for the underlying session check — every slot
  is validated by the exact same base lookup, once per slot. Multi-session
  never accepts a credential the base contract would have rejected (P is
  not weakened, but it is also not narrowed — no new restriction is placed
  on what counts as a valid session).
* Postcondition: **strictly additive**. Everything the base contract
  promised about an individual session (identity binding, expiry,
  revocation-effective-immediately) still holds for every tracked slot;
  multi-session adds the ability to enumerate and switch among several such
  sessions. The one place this extension's postcondition is *intentionally
  weaker than a naïve reading* is the capacity cap (§5) and the sign-out
  cascade's widened blast radius (§4.5) — both are called out explicitly
  above, per doc 01 §5's requirement that a specialization document, rather
  than silently produce, any place its guarantee falls short of what a
  client might otherwise assume.
