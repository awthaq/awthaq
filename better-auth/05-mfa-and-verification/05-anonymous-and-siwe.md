# Anonymous Session and Sign-In-With-Ethereum (SIWE) Plugins

Grouped because both establish a **session and a `User` row without any
proof of a durable, checkable identity claim** (no password, no verified
channel) — anonymous sessions trade identity for immediacy and expect to be
"upgraded" later; SIWE substitutes a cryptographic wallet-control proof for
every other identity check and treats the wallet address itself as the
durable identity.

---

## Part A — Anonymous Sessions

### A.1 Entity invariant added

```
User (extended)
  + isAnonymous: boolean   (default false, not client-writable)
```

`isAnonymous = true` marks a row as ephemeral by convention — the plugin
provides no schema-level TTL or garbage collector; a `true` row that is
never linked (§A.3) simply persists until the deployer chooses to reap it.

### A.2 Anonymous session lifecycle

```
                    sign-in-anonymous
                            │
        already holds an anonymous session? ──yes──►
        ANONYMOUS_USERS_CANNOT_SIGN_IN_AGAIN_ANONYMOUSLY
        (an anonymous identity must be upgraded, §A.3,
         before another anonymous identity can be minted
         in its place)
                            │no
                            ▼
                       ANONYMOUS
          (User: isAnonymous=true, placeholder email,
           emailVerified=false; Session bound to it)
                    │                    │
       delete-anonymous-user       any linking-eligible
       (self, sensitive session,   endpoint succeeds with
       disableDeleteAnonymousUser  a NEW session for a
       must be false)              DIFFERENT (real) user
                    │               (§A.3)
                    ▼                    ▼
                 GONE                UPGRADED
          (sessions + user        (this ANONYMOUS user row is
           rows deleted)          deleted — best-effort — unless
                                   disableDeleteAnonymousUser,
                                   or the new session's user IS
                                   this same row, or the new
                                   session is ITSELF anonymous)
```

### A.3 The upgrade/link contract (cross-cutting after-hook)

```
Operation:     anonymous-upgrade after-hook
Applies at:    the response of any of: /sign-in/*, /sign-up/*, /callback/*,
               /magic-link/verify, /email-otp/verify-email,
               /one-tap/callback, /passkey/verify-authentication,
               /phone-number/verify, /verify-email — i.e. every endpoint in
               this document capable of minting a fresh, non-anonymous
               session
Requires:      the caller held an anonymous session at request time (read
               from the session cookie), OR — for OAuth redirect flows that
               may arrive without a cookie (e.g. an in-app browser) — the
               anonymous user id was carried across the redirect via
               server-only OAuth state, captured by a companion
               `before`-hook on /sign-in/social
Ensures:       IF the response set a NEW session for a DIFFERENT, non-
               anonymous user: (1) invokes the higher-order
               `onLinkAccount({anonymousUser, newUser, ctx})` hook —
               contract: domain is both full {session,user} pairs, range is
               Awaitable<void>, intended for migrating anon-owned data to
               the real account; (2) deletes the anonymous user row
               UNLESS disableDeleteAnonymousUser is set, or the new
               session's user IS the same row (a no-op path, e.g.
               verifying an email on the still-anonymous account), or the
               new session is itself still anonymous
Invariant:     deletion of the old anonymous row is best-effort and
               happens strictly AFTER onLinkAccount has run — a deletion
               failure is logged and swallowed, never surfacing as an
               error to the client, since the actual identity transition
               (data migration + new session) has already succeeded by
               that point
On violation:  no client-visible error path for a failed cleanup. Blamed
               party for a failed onLinkAccount migration itself: SUPPLIER
               (the integrator's own hook) — its failure is NOT caught
               here and will propagate, since data-migration correctness
               is the deployer's responsibility, unlike the best-effort
               row cleanup that follows it.
```

### A.4 Configuration-driven behavior variants

| Option | Default | Effect |
|---|---|---|
| `emailDomainName` | RFC-2606-style placeholder domain | Template for generated placeholder emails |
| `generateRandomEmail` | internal placeholder generator | Full override; validated as a syntactically legal email, else `INVALID_EMAIL_FORMAT` |
| `generateName` | `"Anonymous"` | Per-request higher-order name generator |
| `disableDeleteAnonymousUser` | false | Disables both self-service deletion (§A.2) and automatic post-link cleanup (§A.3) |
| `onLinkAccount` | — | Higher-order data-migration hook (§A.3) |

---

## Part B — Sign-In With Ethereum (SIWE / EIP-4361)

### B.1 Entity added

```
WalletAddress
  id, userId, address (EIP-55 checksummed), chainId, isPrimary, createdAt
```

**Invariant:** `address` is always stored in EIP-55 checksummed form
(normalized at both parse time and lookup time), so equality comparisons are
exact-string, never case-insensitive. A single `userId` may own multiple
`WalletAddress` rows across different `chainId`s; the first address ever
linked to a user is `isPrimary = true`, all subsequent ones are not.

### B.2 The two independent higher-order suppliers, and why neither is trusted alone

```
getNonce      : ()  ->  Promise<string>
verifyMessage : { message, signature, address, chainId, cacao? }
                    ->  Promise<boolean>
```

**`getNonce`** is trusted to produce a value, but its OUTPUT is validated by
the plugin (range-contract check, per the higher-order-contracts model)
before being trusted further: it must be 8–~250 alphanumeric characters
(ERC-4361 shape). A nonce failing this check is rejected with a 500
`SIWE_INVALID_NONCE` — **blamed on the SUPPLIER** (`getNonce`'s own
implementation), since the endpoint's precondition on its caller (no request
body needed) was already satisfied.

**`verifyMessage`** is documented to be commonly implemented with a library
(e.g. viem) that performs ONLY signature recovery — it does **not** inspect
the message body at all. The plugin therefore does not treat "verifyMessage
returned true" as sufficient on its own: it independently parses the raw
SIWE message text and re-derives nonce, domain, address, chain ID, and the
optional `expirationTime`/`notBefore` time bounds, checking each against
server-held state BEFORE calling `verifyMessage`. This is a case where a
higher-order contract's *documented* domain (the full message) is narrower
than what the plugin actually needs verified, so the plugin does the
narrower supplier's missing verification work itself rather than trusting
the boolean blindly.

```
Contract:      verifyMessage : {message, signature, address, chainId, cacao}
                                    ->  Promise<boolean>
Applies at:    only AFTER the plugin has independently confirmed: nonce
               matches a live, just-consumed server record; domain matches
               configured `options.domain`; address is a syntactically
               valid checksummable hex address; chainId is a positive
               integer; expirationTime (if present) is in the future;
               notBefore (if present) has already passed
On mismatch:   `false` or a thrown value from verifyMessage is surfaced as
               401 UNAUTHORIZED. Blamed party: CLIENT (invalid signature
               for an otherwise well-formed, freshly-nonced message).
```

### B.3 Nonce and verification state machine

```
                        getSiweNonce / getNonce
                                │
                                ▼
                            ISSUED
                (identifier "siwe:{nonce}", TTL 15 min)
                                │
                    verify {message, signature, email?}
                                │
              parse message locally (never throws; tolerant
              extraction of nonce/domain/address/chainId/
              time-bounds from the SIGNED text)
                                │
              nonce shape valid (ERC-4361)? ──no──► UNAUTHORIZED
                                │yes                 (mismatch)
                                ▼
              ATOMIC CONSUME of the nonce record — BEFORE any
              signature verification or state mutation. A failed
              or forged signature STILL burns the nonce: replay
              prevention takes priority over allowing a retry on
              a typo'd signature.
                                │
                    not found / already consumed? ──yes──► UNAUTHORIZED
                                │no                          (invalid/expired nonce)
                                ▼
              domain / address / chainId / time-bounds all
              check out against the PARSED (not caller-asserted)
              message? ──no──► UNAUTHORIZED (mismatch)
                                │yes
                                ▼
              verifyMessage(...) === true? ──no──► UNAUTHORIZED
                                │yes                 (invalid signature)
                                ▼
                        WALLET IDENTITY RESOLVED (§B.4)
                                │
                                ▼
                    session created — CONSUMED (terminal;
                    this nonce can never be redeemed again)
```

### B.4 Wallet identity resolution

```
exact (address, chainId) match in WalletAddress? ──yes──► that row's userId
                    │no
                    ▼
   same address on ANY OTHER chainId? ──yes──► that row's userId
   (cross-chain identity is address-based: a wallet already
    linked on chain A is automatically recognized as the same
    person signing on chain B — a new WalletAddress row is added
    for the new chain, isPrimary=false)
                    │no
                    ▼
            CREATE A NEW USER
   options.anonymous (default true):
     email optional — falls back to a wallet-derived placeholder
     address (or `${address}@emailDomainName` if configured)
   options.anonymous = false:
     email REQUIRED by the request schema
   EITHER WAY, an explicitly supplied `email` is only an
   OPPORTUNISTIC claim: reserved via a short-lived (60s)
   exclusive reservation, silently discarded (no distinguishable
   error — enumeration-safe) if already claimed by another user
   or if reservation fails; the user is created with the
   wallet-derived placeholder email in that case. SIWE proves
   WALLET control, never EMAIL ownership — this is a documented,
   intentional floor, not a full contact-verification flow.
```

### B.5 Configuration-driven behavior variants

| Option | Default | Effect |
|---|---|---|
| `domain` | — (required) | The RP domain a signed message must match |
| `anonymous` | true | Whether `email` is optional at verify time (§B.4) |
| `emailDomainName` | — | Deterministic placeholder-email domain instead of the default namespaced placeholder |
| `ensLookup` | — | Higher-order name/avatar resolver for newly created users (domain: `{walletAddress}`, range: `Promise<{name, avatar}>`) |
| `getNonce` | — (required) | Higher-order nonce generator (§B.2) |
| `verifyMessage` | — (required) | Higher-order signature-recovery oracle, narrower than its full domain suggests (§B.2) |

### B.6 Sequence: nonce issuance and verification

```
Client                    getNonce endpoint            verify endpoint
  │ POST /siwe/nonce         │                              │
  ├──────────────────────────►│ options.getNonce() -> nonce  │
  │                           │ validate ERC-4361 shape      │
  │                           │ persist ISSUED "siwe:{nonce}"│
  │◄────── {nonce} ───────────┤                              │
  │                                                            │
  │ (client builds + signs the ERC-4361 message off-chain)    │
  │                                                            │
  │ POST /siwe/verify {message, signature, email?}            │
  ├───────────────────────────────────────────────────────────►
  │                                    parse message locally    │
  │                                    ATOMIC CONSUME nonce      │
  │                                    re-derive & check domain/ │
  │                                      address/chainId/time    │
  │                                    verifyMessage() -> true   │
  │                                    resolve/create user (§B.4)│
  │                                    createSession()           │
  │◄──── { token, user:{id,walletAddress,chainId} } ────────────┤
```
