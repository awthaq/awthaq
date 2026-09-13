# Social Sign-In Contract

> Builds on `01-oauth2-core-contract.md`. Every operation below composes
> the core contract's operations (Build Authorization URL, Handle Provider
> Callback, Exchange Code for Tokens, Verify Provider ID Token) without
> restating their internals, per `00-methodology/01-design-by-contract.md
> §4`.

This document specifies the "sign in with provider X" feature: what
happens once a provider strategy (per `01 §1`) has produced a token
response and a raw profile, and better-auth must decide whether this
represents a brand-new user, a returning user, or a request to attach a
new provider identity to an already-existing user.

---

## 1. The social provider contract (what every provider supplies, what every caller receives)

Every social provider strategy additionally supplies, beyond the core
bundle in `01 §1`, exactly one normalizing arrow:

```
NormalizeProfile : (RawProfile) -> {
   name          : string?,
   email         : string?,
   image         : string?,
   emailVerified : boolean         -- REQUIRED, never optional, never
                                       inferred by the caller; a provider
                                       with no concept of verification
                                       at all must still supply this
                                       field, defaulted to false
}
```

This range contract has one structural exclusion that is itself part of
the contract: **the normalized profile carries no provider account
identifier at all.** Identity flows exclusively through the core
contract's `resolveAccountSubject` (`01 §1`), never through this value.
This is not an incidental omission — it is what makes it impossible for a
provider-supplied or developer-supplied profile-mapping value to
accidentally (or maliciously, via a compromised mapping hook) redefine
which real-world account a sign-in resolves to. A `NormalizeProfile`
implementation that produces an identifier is a contract violation blamed
on the **SUPPLIER** (whoever registered a strategy exceeding its declared
range), regardless of whether the extra field is ever consulted.

better-auth's reciprocal guarantee to every caller, regardless of which
provider was used, is that **only** this four-field shape plus the
provider-scoped account key is ever used to decide user identity —
nothing provider-specific (an internal user ID format, a vendor-specific
claim) leaks into the decision logic in §3–§5 below.

```
Operation:     Retrieve and Normalize Provider Profile
Requires:      a successful token exchange (per `01 §5`)
Ensures:       returns a value conforming to `NormalizeProfile`'s range,
               or a definite failure — never a partially-populated value
               silently treated as complete
Invariant:     `emailVerified` is always a concrete boolean in the
               returned value; it is never absent, `null`, or "unknown"
On violation:  the provider's userinfo call fails, times out, or the
               provider's response cannot be parsed into the expected
               shape: Blamed party UPSTREAM PROVIDER. If a developer-
               supplied override of this operation (see
               `03-generic-oauth §3`) returns a malformed value: Blamed
               party SUPPLIER.
```

---

## 2. The account-linking key

```
INVARIANT (Provider Identity Key):
   the pair (provider identifier, provider account identifier) — the
   latter produced exclusively by `resolveAccountSubject` (`01 §1`) —
   is the ONLY key ever used to recognize a returning sign-in. Email is
   never used to recognize a returning identity; it is used only (§4)
   to decide whether a *first-observed* identity should attach to an
   existing user.
```

This ordering is load-bearing: the lookup by provider identity key is
always attempted **before** any email-based reasoning runs. A user who
changes their email at the provider, or whose provider account has no
email at all on a later sign-in, is still recognized correctly because
recognition never depended on email in the first place.

---

## 3. First-time vs. returning sign-in

```
Operation:     Sign In With Provider (top-level)
Requires:      a normalized profile (§1) and a resolved provider account
               identifier (`01 §1`)
Ensures:       exactly one of the following branches is taken, and
               exactly one is ever taken — they are mutually exclusive
               and jointly exhaustive:
                 (a) RETURNING — an account already exists for this
                     exact (provider, provider-account-id) pair
                 (b) LINK — no such account exists, but a local user
                     already exists whose email exactly matches the
                     normalized profile's email, and the linking
                     preconditions in §4 are satisfied
                 (c) CREATE — no such account exists, no matching local
                     user exists (or the linking preconditions in §4
                     are not satisfied and implicit linking is
                     disallowed), and sign-up is not disabled for this
                     provider
                 (d) REJECT — sign-up is disabled for this provider and
                     branch (a)/(b) do not apply, or a required field
                     (notably: email, when the provider supplies none)
                     is absent
Invariant:     branch selection depends only on data available BEFORE
               any write occurs — the decision is made, then executed;
               no branch's write can retroactively invalidate the
               precondition that selected it
On violation:  see §6 (error taxonomy) for each branch's specific
               failure modes.
```

### 3.1 RETURNING sign-in

```
Operation:     Sign In — Returning Identity
Requires:      a stored account row matching (provider identifier,
               provider account identifier) exactly
Ensures:       - a session is issued for the user that account row
                 belongs to
               - the account's stored provider tokens are refreshed to
                 the values just obtained, UNLESS the deployer has
                 disabled updating stored tokens on sign-in
               - IF the provider now reports a verified email matching
                 the local user's stored email, AND the local user's
                 email was not previously marked verified, the local
                 user's verified flag is promoted to true — this is a
                 one-directional promotion; a provider reporting
                 unverified email on a later sign-in never demotes an
                 already-verified local user
               - profile fields (name, image) are synchronized to the
                 freshly retrieved values ONLY if the deployer has
                 explicitly enabled overwriting stored profile data on
                 sign-in; otherwise the previously stored values are
                 left untouched
Invariant:     recognizing this as a returning identity never depends on
               email matching, current or historical (§2)
On violation:  n/a for the happy path; see §6 for the underlying lookup
               yielding more than one match (a supplier-blamed data-
               integrity condition, specified in `01 §9`).
```

### 3.2 CREATE — first-time sign-up

```
Operation:     Sign In — First-Time Identity, No Email Match
Requires:      - no existing account row for (provider identifier,
                 provider account identifier)
               - no existing local user whose email exactly matches
                 the normalized profile's email — OR the deployer has
                 explicitly requested sign-up over linking for this
                 call
               - sign-up is not disabled for this provider (or an
                 explicit sign-up request overrides that restriction
                 where the deployer allows such an override)
               - the normalized profile carries a non-empty email,
                 UNLESS the deployer's configuration explicitly permits
                 email-less accounts
Ensures:       - a new local user and a new account row are created
                 together, as a single atomic unit — never a user
                 without its originating account, nor an account
                 pointing at no user
               - the new user's verified-email flag is set exactly to
                 whatever the provider reported (true or false) — a
                 provider reporting unverified email does NOT by
                 itself block user creation
               - IF the deployer requires verified email before a
                 session may be issued, and the created user's email is
                 unverified, a verification message is dispatched and
                 the operation completes WITHOUT issuing a session —
                 the user row exists, but no session-issuance
                 postcondition holds until verification completes
Invariant:     a user and its first account are never observably split
               — no external caller can observe a user existing without
               at least one account, between the user-creation and
               account-creation steps
On violation:  - sign-up disabled for this provider: raised as a
                 sign-up-disabled error. Blamed party: SUPPLIER's own
                 policy (not a fault, but a deliberate configuration
                 decision surfaced to the caller as a rejection) —
                 attributed to SUPPLIER because the deployer chose this
                 restriction, and the caller has done nothing wrong by
                 the core contract's standard.
               - profile carries no email and email is required: Blamed
                 party UPSTREAM PROVIDER — the provider did not supply a
                 field this operation's precondition required.
```

---

## 4. Implicit account linking to an existing user

Linking a first-observed provider identity to an **already-existing**
local user (found by exact email match) is the single highest-stakes
decision in this document: get it wrong, and an attacker who controls an
unverified email at some provider can attach their provider identity to a
victim's existing account. Every precondition below exists specifically
to prevent that.

```
Operation:     Sign In — Implicit Link to Existing User
Requires:      ALL of the following:
               (1) no existing account row for (provider identifier,
                   provider account identifier) — this is a
                   first-observed identity
               (2) an existing local user whose email exactly matches
                   the normalized profile's email
               (3) implicit linking is enabled at all (a deployer may
                   disable it entirely)
               (4) trust condition — AT LEAST ONE of:
                     (4a) this provider is explicitly named in the
                          deployer's trusted-provider set (a static
                          list, or a per-request decision function), OR
                     (4b) the normalized profile's `emailVerified` is
                          true for THIS sign-in
               (5) local-verification condition — UNLESS the deployer
                   has explicitly relaxed it: the EXISTING local user's
                   own verified-email flag must already be true —
                   an unverified local account cannot receive an
                   implicit link even from a fully trusted, verified
                   provider claim
Ensures:       - the new account row is created and attached to the
                 EXISTING user's identity — no new user row is created
               - if the provider's email is verified and the local
                 user's was not, the local user's verified flag is
                 promoted (same one-directional rule as §3.1)
Invariant:     satisfying (1)+(2) alone is NEVER sufficient — (4) and
               (5) are independent, both-required gates; weakening
               either to "email match alone is enough" reintroduces the
               exact account-takeover vector this operation exists to
               prevent
On violation:  ANY of (3)/(4)/(5) failing: the operation does not fall
               back to CREATE (§3.2) — it is a hard REJECT (§5). Blamed
               party: UPSTREAM PROVIDER when (4) fails because the
               provider itself declares the email unverified for an
               untrusted provider (the provider is, truthfully, not
               vouching for this address) — this is not a defect, it is
               the provider correctly reporting a state that this
               operation's precondition treats as insufficient. Blamed
               party: none in the fault sense when (5) fails — this is
               the SUPPLIER's own policy correctly refusing to compound
               one unverified state with another.
```

### 4.1 Two providers, same email, different verification

If Provider A (trusted, or itself verified) already established a user's
verified email, and Provider B (untrusted, unverified) later presents an
identity claiming the same email, §4's clause (4) is not satisfied by
Provider B's claim alone — Provider B cannot ride in on Provider A's
established trust. This is not a special case; it falls directly out of
clause (4) being evaluated fresh, per sign-in, against the CURRENT
provider's own trust/verification standing — never against a different
provider's prior contribution to the same local user.

### 4.2 Explicit linking (already-authenticated user links a new provider)

A variant of this operation exists for an **already-signed-in** user
explicitly requesting to attach a new provider identity to their own
account (as opposed to an anonymous sign-in flow resolving into a link).

```
Operation:     Explicit Link Provider Identity
Requires:      - an active session identifying the target user
               - all of §4's clauses (3), (4), (5) still apply
               - UNLESS the deployer explicitly allows attaching a
                 provider identity whose email differs from the
                 session's user's email, the normalized profile's email
                 MUST match the current user's email exactly
               - the provider identity (provider identifier, provider
                 account identifier) must not already belong to a
                 DIFFERENT local user
Ensures:       the new account row is attached to the session's user
Invariant:     an account row's ownership, once established, is never
               silently reassigned to a different user by a later
               explicit-link call — reassignment is always a distinct,
               separately-gated operation outside this contract's scope
On violation:  - email mismatch, allowance not granted: raised as an
                 email-mismatch error. Blamed party: CLIENT — the
                 signed-in user (or an application UI acting on their
                 behalf) attempted to attach an identity inconsistent
                 with their own account under the deployer's policy.
               - the target provider identity already belongs to a
                 different user: raised as an already-linked-elsewhere
                 error. Blamed party: CLIENT in the ordinary case (the
                 user is attempting to claim an identity that is not
                 theirs, whether by mistake or by attack).
```

---

## 5. REJECT branch

```
Operation:     Sign In — Reject
Requires:      none of CREATE/RETURNING/LINK's preconditions were
               satisfied
Ensures:       no user row, no account row, and no session are created
               or modified as a side effect of the attempt
Invariant:     a rejected sign-in attempt is fully inert with respect to
               stored state — attempting it repeatedly produces no
               accumulating side effect (no partial rows, no orphaned
               verification records left dangling beyond their own
               fixed expiry)
On violation:  n/a — REJECT is itself the terminal, well-defined outcome
               of the top-level operation's precondition not being
               fully satisfiable; see §6 for how each specific rejection
               reason is classified.
```

---

## 6. Error taxonomy and blame

| Condition | Blamed party | Reasoning |
|---|---|---|
| Provider returns no email at all, and email is required | UPSTREAM PROVIDER | The provider failed to supply data this contract's precondition required; better-auth cannot invent an email. |
| Provider returns `emailVerified: false` (or omits verification) for a first-time CREATE | *(not a fault)* | §3.2 explicitly accepts unverified email at creation time — this is expected behavior, not a violation, unless deployer policy (see below) additionally requires verification before session issuance. |
| Deployer requires verified email before session issuance, and it is missing | SUPPLIER (policy) | A deliberate configuration choice surfaced as a rejection, not a defect. |
| Untrusted, unverified provider attempts implicit link to an existing user | UPSTREAM PROVIDER | The provider is honestly declining to vouch for the address; the contract's trust gate (§4 clause 4) correctly refuses the link. |
| Provider account identifier is empty, null-like, or otherwise structurally invalid | UPSTREAM PROVIDER, unless produced by a developer-supplied resolver override (`03-generic-oauth`), in which case SUPPLIER | Traced to whichever party actually produced the invalid value. |
| Token exchange fails, provider unreachable, malformed token response | UPSTREAM PROVIDER | Per `01 §5`. |
| Callback state missing/expired/mismatched | CLIENT | Per `01 §3.1`. |
| Lookup by (provider, account id) finds more than one account row | SUPPLIER / ADAPTER | Data-integrity violation of `01 §9`'s uniqueness invariant; never resolved by picking arbitrarily — no session is issued. |
| An account row references a user that no longer exists | SUPPLIER / ADAPTER | Referential-integrity violation; treated as a serious, non-self-healing condition rather than silently falling back to CREATE or an email-based match. |
| A deployer-supplied hook (validating provider info, choosing an account/user binding) throws, or resolves to a binding conflicting with what this contract already determined | SUPPLIER | The hook is SUPPLIER-owned code running inside this contract's flow; a conflict it introduces is blamed on the hook, per the blame theory's "first cause, not first observer" rule (`00-methodology/03 §4`). |

---

## 7. Diagrams

### 7.1 Branch decision — state diagram

```
                         Retrieve & Normalize Profile (§1)
                         Resolve Provider Account Id (01 §1)
                                       │
                                       ▼
                     ┌─────────────────────────────────┐
                     │ lookup by (provider, account id) │
                     └────────────┬──────────────────┬─┘
                            FOUND │                  │ NOT FOUND
                                  ▼                  ▼
                          ┌───────────────┐   ┌─────────────────────┐
                          │   RETURNING    │   │ lookup local user   │
                          │ (§3.1)         │   │ by exact email match│
                          │ - refresh      │   └─────┬───────────┬───┘
                          │   tokens       │    FOUND │           │ NOT FOUND
                          │ - maybe promote│         ▼           ▼
                          │   verified flag│  ┌───────────────┐ ┌───────────────┐
                          │ - issue session│  │ check §4      │ │ check sign-up  │
                          └───────────────┘  │ trust + local │ │ allowed (§3.2) │
                                              │ verification  │ └──────┬────────┘
                                              │ gates         │        │
                                              └──┬─────────┬──┘   ┌────┴────┐
                                          PASS   │         │ FAIL │         │
                                                 ▼         ▼      ▼         ▼
                                          ┌───────────┐ ┌──────┐ ┌──────┐ ┌────────┐
                                          │   LINK    │ │REJECT│ │CREATE│ │ REJECT │
                                          │  (§4)     │ │      │ │(§3.2)│ │(sign-up│
                                          │ attach to │ │      │ │ new  │ │disabled│
                                          │existing   │ │      │ │ user │ │  or no │
                                          │  user     │ │      │ │+acct │ │ email) │
                                          └───────────┘ └──────┘ └──────┘ └────────┘

     Every terminal box is mutually exclusive with every other — the
     decision is made once, from data fixed before any write (§3
     invariant).
```

### 7.2 Sequence — first-time sign-in vs. returning sign-in, side by side

```
   FIRST-TIME (CREATE)                      RETURNING
   ─────────────────────                    ─────────────────────
   Browser   better-auth   Provider         Browser   better-auth   Provider
     │           │            │               │           │            │
     │──sign-in─▶│            │               │──sign-in─▶│            │
     │           │──(01 flow: authorize,      │           │──(01 flow) │
     │           │   callback, code exchange)─▶│           │───────────▶│
     │           │◀───── tokens ───────────────┤           │◀── tokens ─┤
     │           │ Retrieve & Normalize (§1)   │           │ Retrieve & │
     │           │            │               │           │ Normalize  │
     │           │ lookup (provider,acct id)   │           │ lookup     │
     │           │  → NOT FOUND                │           │  → FOUND   │
     │           │ lookup by email             │           │ (account   │
     │           │  → NOT FOUND                │           │  already   │
     │           │ CREATE user + account       │           │  exists)   │
     │           │  (atomic, §3.2)             │           │ refresh    │
     │           │            │               │           │ tokens     │
     │           │            │               │           │ maybe      │
     │           │            │               │           │ promote    │
     │           │            │               │           │ verified   │
     │◀─ session ┤            │               │◀─ session ┤            │
```
