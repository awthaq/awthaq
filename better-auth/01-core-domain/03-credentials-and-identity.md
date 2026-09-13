# Credentials and Identity

This document specifies the password-credential contract (set / verify /
change / reset / delete-time confirmation) and the account-linking /
unlinking contract, including how provider identity conflicts are
resolved and blamed. It builds directly on the Account entity contract in
`01-entities-and-invariants.md` §3 (the credential account is an ordinary
Account row with `providerId = "credential"`) and the session-freshness
contract in `02-session-lifecycle.md` §9.

---

## 1. Where a credential lives, and what "having a password" means

A password is never a field on User. It is the `password` field of the
User's **credential Account** row (`providerId = "credential"`,
`accountId = <the User's own id>`). Consequently:

```
"Does this User have a password?"
   ⟺ does a row with (providerId="credential", accountId=User.id) exist,
      AND does that row's password field hold a value?

   (a credential Account can transiently exist WITHOUT a password in one
    documented case — see §4.2's set-password contract — so existence of
    the row and possession of a usable password are checked separately.)
```

This has a direct consequence for account-management operations: an
OAuth-only User (signed up entirely through a social provider) simply has
**no** credential Account row, and "add a password to my account" (§4.2)
is the operation that creates one where none existed.

---

## 2. The hash/verify contract

Password hashing and verification are specified **behaviorally** — as an
opaque digest contract — not by naming an algorithm. Any concrete
implementation satisfying the contract below (a memory-hard,
uniformly-salted password hash of the bcrypt/scrypt class) is
substitutable.

```
Contract:   hash-password :  plaintext-password (any string, including
                              empty, arbitrarily long, and containing
                              arbitrary Unicode)
                           -> opaque-digest (a string a supplier can later
                              recognize as "produced by hash-password" and
                              check a candidate against, but which reveals
                              nothing about the plaintext to a holder who
                              cannot invert or brute-force it)

  Ensures:
    (a) NON-DETERMINISM: hashing the same plaintext twice produces two
        DIFFERENT digests (a fresh random salt per call). Two different
        digests of the same password must both still verify successfully
        against that password.
    (b) NORMALIZATION STABILITY: the same logical password, represented as
        different but Unicode-equivalent byte sequences, hashes and
        verifies consistently (case-SENSITIVE — no case-folding is
        applied to the password itself, only Unicode normalization).
    (c) NO LENGTH-DEPENDENT FAILURE within the accepted range: very long
        passwords (deployer-configured maximum, rejected as a precondition
        failure above that — see §3) hash and verify successfully; a
        supplier must not silently truncate.

Contract:   verify-password : (stored-digest, candidate-plaintext) -> boolean

  Ensures:
    (a) verify-password(hash-password(p), p) = true for every p in the
        accepted domain, for EVERY digest hash-password could have
        produced for p (not just the most recent one — see (d) below).
    (b) verify-password(hash-password(p), p') = false whenever p' != p
        byte-for-byte (after normalization) — including a case-differing
        variant of an otherwise-identical password.
    (c) verify-password is the ONLY read operation defined on a stored
        credential. There is no "decrypt" or "recover" operation in this
        contract — a lost password cannot be retrieved, only reset
        (§4.3, which invalidates the old one rather than revealing it).
    (d) FORMAT TOLERANCE: verify-password must continue to correctly
        verify digests produced by a PRIOR version of the hash-password
        implementation, for as long as that prior format remains
        recognizable (a supplier is expected to version its digest format
        and support verifying old versions across an upgrade — a stored
        digest is not invalidated merely because the hashing
        implementation changed since it was created).

Invariant:  a stored credential's plaintext is NEVER reconstructable from
            its digest through any operation this contract defines.

On violation:
  - verify-password returning true for a wrong password, or hash-password
    producing colliding/predictable digests, is a SUPPLIER violation of
    the highest severity (it defeats the credential's entire purpose).
  - A caller that stores or logs the plaintext password anywhere before
    or instead of calling hash-password is a CLIENT/deployer violation —
    this contract only governs what happens to a password once handed to
    hash-password.
```

```
┌────────────────────────────────────────────────────────────────┐
│                     hash-password / verify-password                │
│                                                                      │
│   plaintext ──▶ [hash-password] ──▶ opaque digest ──▶ stored on the  │
│                                                        credential      │
│                                                        Account row      │
│                                                                          │
│   candidate ──┐                                                          │
│               ├──▶ [verify-password] ──▶ boolean                          │
│   stored ─────┘         (never a decrypt; never returns the plaintext)     │
│   digest                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### 2.1 Timing-attack resistance is part of the surrounding contract, not the hash contract alone

Every operation that reveals, through its response TIME or its response
SHAPE, whether a given email/account exists is required to perform an
equivalent amount of hashing work on the "does not exist" path as on the
"exists" path (hashing a throwaway value, or the supplied candidate
against nothing meaningful) before responding. This is stated here because
it constrains *callers* of the hash/verify contract (sign-in, sign-up,
password-reset-request), not the hash/verify contract's own two
operations — see §3 and §5 for where this applies.

---

## 3. Setting a credential at sign-up

```
Operation:      set-initial-credential (at sign-up)
Requires:       a candidate password whose length is within the
                deployment's configured [minimum, maximum] bounds; an
                email that does not already identify an existing User
                (see 01-entities-and-invariants.md §2.1) UNLESS the
                deployment is configured to return an opaque "success"
                response for duplicate emails (see §3.1).
Ensures:        a new User row and a new credential Account row
                (providerId="credential", accountId=User.id, password =
                hash-password(candidate)) are created together, as a
                single unit — either both exist afterward or neither does.
Invariant:      a User created through this path always has exactly one
                credential Account immediately after creation; the digest
                stored is never the plaintext.
On violation:   a password outside the configured length bounds is
                rejected — CLIENT-blamed. A duplicate email, when the
                deployment is NOT using opaque-duplicate mode, is rejected
                as a distinguishable error — also CLIENT-blamed (the
                caller could have avoided this by checking availability
                first, or is simply told directly). A storage failure
                after validation passes is SUPPLIER/ADAPTER-blamed.
```

### 3.1 Opaque-duplicate mode: an enumeration-resistance contract

```
Contract:   sign-up-with-email -> { user, token } | { synthetic-user, no-token }

  When the deployment requires email verification before a session is
  usable, OR disables automatic sign-in after sign-up, a sign-up attempt
  against an EXISTING email is answered with a SYNTHETIC response shaped
  identically to a genuine new-signup response (same fields present, same
  approximate timing — the candidate password is still hashed on this
  path purely to keep response timing consistent, and the digest is
  discarded) — the caller cannot distinguish "this email was already
  taken" from "a new account was created and awaits verification."

  On mismatch: a deployment that enables this mode but then leaks the
  distinction some OTHER way (a differently-shaped error on a related
  endpoint, a detectably different response time) reintroduces the
  enumeration channel this mode exists to close. Blamed party: whichever
  component (base system or plugin) introduced the leak — per
  00-methodology/03 §4, the plugin/endpoint that broke the enumeration-
  resistance invariant is at fault, not the opaque-duplicate mode itself.
```

---

## 4. Changing, adding, and resetting a credential

Three distinct operations exist, gated differently, for three distinct
situations: the user knows their current password and wants a new one
(§4.1); the user has no password yet and wants to add one (§4.2); the user
cannot authenticate at all and needs to regain access (§4.3).

### 4.1 Change password (caller knows the current one)

```
Operation:      change-password
Requires:       a currently-authoritative, session-authenticated caller
                (see 02-session-lifecycle.md §9) who supplies BOTH the new
                candidate password (length within bounds) AND their
                CURRENT password, which must verify-password successfully
                against the stored digest on their own credential
                Account.
Ensures:        the credential Account's password field becomes
                hash-password(new-candidate). Optionally, if the caller
                requests it, every OTHER session belonging to the caller
                is revoked and a fresh session is minted for the current
                request (never the reverse — the requesting session is
                never the one revoked by this option).
Invariant:      the OLD digest is completely replaced, never retained
                anywhere the base system can read it back.
On violation:   a caller without a credential Account at all (OAuth-only
                user attempting "change" instead of "set") is rejected as
                a distinguishable precondition failure — CLIENT-blamed
                (the correct operation for that caller is §4.2, not this
                one). A supplied current-password that fails to verify is
                rejected — CLIENT-blamed.
```

### 4.2 Set password (caller has none yet)

```
Operation:      set-initial-credential-post-signup
Requires:       a currently-authoritative session-authenticated caller,
                AND that caller's credential Account either does not exist
                yet OR exists with no password set (see §1's note on a
                credential row transiently existing without a password —
                this arises when the deployment always creates the
                credential row but defers setting a digest until this
                operation runs).
Ensures:        a credential Account exists afterward
                (providerId="credential", accountId=caller's own User id)
                with password = hash-password(new-candidate) — created
                fresh if it did not exist, updated in place if it existed
                without a digest.
Invariant:      this operation NEVER overwrites an already-set digest —
                that is what §4.1 (change) is for.
On violation:   calling this when a usable digest already exists is
                rejected as a distinguishable precondition failure —
                CLIENT-blamed; the caller should use §4.1 instead. This
                operation is intentionally restricted to trusted/
                server-side callers, not exposed as an ordinary
                client-facing capability, because it has no
                current-password check to gate it (there is nothing to
                check yet) — a deployment that exposes it to untrusted
                callers directly assumes responsibility for gating it some
                other way (e.g. behind its own re-authentication step).
```

### 4.3 Reset password (caller cannot authenticate)

```
Operation:      request-password-reset  (step 1: issue a token)
Requires:       an email address (need not correspond to any real User —
                see enumeration-resistance clause below).
Ensures:        IF a User with that email exists, a single-use
                Verification token is created, scoped to that User, with a
                bounded expiry, and delivered out-of-band (e.g. emailed) —
                never returned directly in this operation's response.
                IF no such User exists, the SAME response shape is
                returned regardless, after performing equivalent token-
                generation and lookup work to keep timing consistent (see
                §2.1).
Invariant:      the response to this operation never reveals whether the
                email corresponds to a real User.
On violation:   n/a for the response itself (it is deliberately
                uninformative); a deployment that adds a side channel
                revealing existence (e.g. a distinct email bounce it
                exposes to the caller) breaks this invariant and is
                blamed per the same rule as §3.1.
```

```
Operation:      reset-password  (step 2: consume the token)
Requires:       a token (matching the one delivered in step 1) AND a new
                candidate password within the deployment's length bounds.
Ensures:        the token is CONSUMED atomically (§5.2 of
                01-entities-and-invariants.md's Verification contract) —
                the FIRST caller to present a still-valid token succeeds;
                every other caller presenting the same token (concurrently
                or afterward) is rejected, and an expired token is
                rejected identically to a not-found one. On success, the
                identified User's credential Account is created (if it
                did not exist) or updated (if it did) with
                password = hash-password(new-candidate). Optionally, if
                the deployment is configured to do so, ALL of that User's
                sessions are revoked as part of this same operation.
Invariant:      a reset token can never be replayed — consuming it once
                exhausts it regardless of outcome.
On violation:   an invalid, already-consumed, or expired token is
                rejected — CLIENT-blamed (the caller must request a fresh
                one via step 1). A candidate password outside the length
                bounds is rejected — CLIENT-blamed.
```

```
┌─────────────────────────────────────────────────────────────────┐
│                     Password-reset sequence                        │
│                                                                       │
│  client          request-password-reset       Verification store      │
│    │                     │                              │              │
│    │  email               │                              │              │
│    ├────────────────────▶│  create single-use token,      │              │
│    │                     │  scoped to the resolved user     │              │
│    │                     ├────────────────────────────────▶│              │
│    │                     │  (delivered out-of-band, NOT in   │              │
│    │◀────────────────────┤   this response)                    │              │
│    │  opaque success       │                                       │              │
│    │  (always, regardless   │                                       │              │
│    │   of whether email       │                                       │              │
│    │   existed)                │                                       │              │
│                                                                             │
│  client              reset-password                Verification store       │
│    │                     │                              │              │
│    │  token, newPassword  │                              │              │
│    ├────────────────────▶│  CONSUME (first caller wins;   │              │
│    │                     │   racers/expired get rejected)  │              │
│    │                     ├────────────────────────────────▶│              │
│    │                     │◀────────────────────────────────┤              │
│    │                     │  [not consumed] ──▶ reject          │              │
│    │                     │  [consumed] ──▶ hash & store on       │              │
│    │                     │                  credential Account       │              │
│    │◀────────────────────┤                                             │              │
│    │  success              │                                                │              │
└─────────────────────────────────────────────────────────────────┘
```

### 4.4 Verify-only (no state change)

```
Operation:      verify-current-password
Requires:       a currently-authoritative session-authenticated caller,
                AND a candidate password.
Ensures:        returns whether the candidate verifies against the
                caller's OWN credential digest; changes no state.
Invariant:      this operation is read-only with respect to the
                credential — it exists so other flows (e.g. a
                deployer-built "confirm your password to continue" step
                outside this document's scope) can check without
                duplicating the verify-password contract.
On violation:   no credential Account (OAuth-only user) — rejected as a
                distinguishable precondition failure, CLIENT-blamed
                (there is nothing to verify against).
```

---

## 5. Sensitive-action confirmation: password as a freshness substitute

Certain destructive operations (most notably account deletion) accept a
password as an ALTERNATIVE to session freshness
(`02-session-lifecycle.md` §9):

```
Contract:   confirm-sensitive-action -> passes | rejects

  Requires:  EITHER (a) the caller supplies their current password, which
             must verify against their credential Account's digest, OR
             (b) no password is supplied AND the caller's session is
             still within the freshness window.
  Ensures:   the action proceeds only once one of the two branches is
             satisfied.
  On violation: neither branch satisfied (no password given and the
             session is stale) — rejected, distinguishable from "not
             authenticated at all" (see 02-session-lifecycle.md §9's
             freshness clause). A supplied password that fails to verify
             is rejected as an ordinary invalid-credential failure,
             CLIENT-blamed.
```

A deployment may additionally offer a THIRD path for the same sensitive
action — an out-of-band, single-use confirmation token (delivered by
email), consumed exactly like the password-reset token in §4.3, that
substitutes for both the password and the freshness check entirely. All
three paths converge on the same postcondition; they are alternative ways
to discharge the same precondition, not three different operations.

---

## 6. Account linking and unlinking

### 6.1 What "linking" means and its cardinality

Linking attaches a new `(providerId, accountId)` identity to an
**already-resolved** User — either the currently-authenticated caller
(explicit linking, via a dedicated capability) or a User the sign-in flow
resolves implicitly by matching email (implicit linking, via ordinary
social sign-in — see §6.3). Cardinality is exactly the Account contract
from `01-entities-and-invariants.md` §3.2: many Accounts per User, each
Account belonging to exactly one User, never re-parented.

### 6.2 Explicit linking (an authenticated user attaches a new provider)

```
Operation:      link-account (explicit)
Requires:       a currently-authoritative session-authenticated caller;
                the external identity being linked (via a completed OAuth
                exchange or a verified provider-issued identity token)
                must not ALREADY be linked to a DIFFERENT User.
Ensures:        a new Account row is created with userId = caller's own
                User id.
Invariant:      the caller's own identity boundary is preserved — this
                operation can only ever add an Account whose userId equals
                the CALLER's, never any other User's.
On violation:   see §6.4 (conflict) for the case where the external
                identity is already linked elsewhere.
```

### 6.3 Implicit linking (a sign-in resolves to an existing local User by email)

```
Operation:      link-account (implicit, during social sign-in)
Requires:       the external provider's returned identity does NOT already
                match an existing Account row (i.e. this is genuinely a
                first-time sign-in from this provider for this person),
                AND a User already exists whose email matches the
                provider's returned email (case-insensitive), AND ALL of
                the following linking-eligibility conditions hold:
                  (a) the provider is either a DEPLOYER-TRUSTED provider,
                      or the provider itself reports the returned email as
                      verified;
                  (b) the LOCAL user's email is itself already verified
                      (a deployment may explicitly relax this, but doing
                      so is a documented weakening, not the default);
                  (c) account linking is enabled at all for the
                      deployment, and implicit linking specifically has
                      not been disabled.
Ensures:        a new Account row is created with userId = the matched
                local User's id, and (if the provider's email is verified
                and the local user's was not) the local User's
                `emailVerified` is promoted to true (see
                01-entities-and-invariants.md §2.2, path (b)).
Invariant:      an external identity is never silently attached to a local
                User whose email is unverified while the provider's own
                claim is unverified too — that combination has no proof on
                either side that the two identities are the same person.
On violation:   ANY of the eligibility conditions failing rejects the
                link attempt as a distinguishable "account not linked"
                outcome — this is a CLIENT-observable outcome, but the
                fault is more precisely characterized as a POLICY
                boundary than ordinary bad input: the request itself
                (a legitimate sign-in attempt) is well-formed, but the
                base system's identity-proof requirements are not met, so
                no party is "blamed" so much as the operation correctly
                declines to guess.
```

```
┌───────────────────────────────────────────────────────────────────┐
│              Implicit linking eligibility (ALL required)              │
│                                                                          │
│   provider trusted OR email reported verified by provider   [a]         │
│                          AND                                             │
│   local user's email already verified (default policy)      [b]         │
│                          AND                                             │
│   account linking enabled, implicit linking not disabled     [c]         │
│                          │                                                │
│                          ▼                                                │
│              ── all true ──▶  link proceeds                                │
│              ── any false ──▶  "account not linked" (no state change)       │
└───────────────────────────────────────────────────────────────────┘
```

### 6.4 Provider identity conflicts

```
Scenario A — the external identity is ALREADY linked to a DIFFERENT user
             than the one the current flow resolved to (explicit linking
             while authenticated as someone else, or a hook that pins
             linking to a specific selected user):

  Ensures:  the link attempt is rejected with a CONFLICT-class outcome;
            NO Account row is modified.
  Blamed:   CLIENT — the caller (or the flow's caller-supplied selection)
            asked to attach an identity that provably belongs to someone
            else already; the correct remedial action is to sign in as
            the identity's actual owner instead.

Scenario B — the external identity is ALREADY linked to the SAME user the
             current flow resolves to (ordinary repeat sign-in through a
             provider already linked):

  Ensures:  NO new Account row is created; the EXISTING Account's tokens
            (access/refresh/id token and their expiries) are refreshed in
            place, unless the deployment disables refreshing tokens on
            sign-in. This is not a conflict at all — it is the expected
            steady state for a returning user.

Scenario C — the Account row's userId references a User that no longer
             exists (an "orphaned" account — see
             01-entities-and-invariants.md §3.1):

  Ensures:  the flow refuses to proceed (it cannot resolve who the
            identity belongs to) and surfaces this as an internal
            integrity failure, not an ordinary "not linked" outcome.
  Blamed:   SUPPLIER/ADAPTER — this state should be unreachable if
            cascading delete (01-entities-and-invariants.md §3.4) is
            correctly enforced; its existence indicates the store did not
            honor the cascade, or an adapter bypassed it.

Scenario D — MORE THAN ONE Account row matches the same
             (providerId, accountId) key (a duplicate-identity race — see
             01-entities-and-invariants.md §3.1):

  Ensures:  the flow refuses to guess which row is authoritative and
            fails loudly rather than picking one arbitrarily.
  Blamed:   SUPPLIER/ADAPTER — per 01-entities-and-invariants.md §3.1,
            this key is meant to identify at most one row; its violation
            is a storage-layer integrity defect, not a normal runtime
            outcome any caller could have avoided.
```

```
┌────────────────────────────────────────────────────────────────────┐
│                 BLAME BOUNDARY — account-linking conflicts             │
│                                                                          │
│   CLIENT-blamed             SUPPLIER/ADAPTER-blamed                        │
│   ───────────────           ────────────────────────                       │
│   Scenario A: identity      Scenario C: orphaned account                    │
│   already claimed by         (cascade-delete integrity failure)              │
│   someone else                                                                │
│                              Scenario D: duplicate identity key                │
│   (§6.3 eligibility           (uniqueness-discipline failure)                   │
│   failures — policy,                                                             │
│   not fault)                                                                       │
└────────────────────────────────────────────────────────────────────┘
```

### 6.5 Unlinking

Specified fully in `01-entities-and-invariants.md` §3.4 (the "last account"
guard). Restated here for completeness: unlinking never touches the
User's sessions or any other linked Account — it is scoped to exactly the
one Account being removed.
