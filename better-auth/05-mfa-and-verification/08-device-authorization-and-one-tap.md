# Device Authorization Grant and Google One Tap Plugins

Grouped as two very different points on the same spectrum: device
authorization is a full standards-based protocol implementation (OAuth 2.0
Device Authorization Grant, RFC 8628) with its own entity, polling
discipline, and an explicit plugin-of-a-plugin extension point; One Tap is
the thinnest possible wrapper — it re-verifies the same higher-order-contract
gap this tree already flags for SIWE (a signature/token-verification oracle
that under-verifies unless explicitly told what to check) and otherwise
delegates entirely to the ordinary social sign-in identity-resolution path.

---

## Part A — Device Authorization Grant (RFC 8628)

### A.1 Entity and invariants

```
DeviceCode
  id, deviceCode (unique), userCode (unique)
  userId: string | null       (null = unclaimed; RFC 8628 §3.1 allows an
                                empty user_id at issuance)
  expiresAt                    (single expiry shared by BOTH codes — there
                                 is no separate user-code TTL)
  status: "pending" | "approved" | "denied"
  lastPolledAt, pollingInterval
  clientId, scope
```

1. `deviceCode` and `userCode` are each globally unique.
2. `status` only ever advances `pending -> approved` or `pending -> denied`,
   never backward, and only via an authenticated session that OWNS the
   `userId` already bound to the row (§A.4).
3. A `userId` can only be attached to a row while it is still `pending` and
   unclaimed (`userId = null`) — attachment is itself a one-shot,
   compare-and-swap style claim (§A.4), not a plain update.
4. The final, destructive redemption of an `approved` row (§A.3) is an
   atomic **conditional consume**: guarded simultaneously on the row's id,
   its ownership predicate, AND `status = "approved"` — so a race between
   two concurrent polls, or between an approval and an in-flight poll,
   can issue a token from a given device code at most once.

### A.2 The `grant` extension point: a plugin extending a plugin

```
DeviceAuthorizationGrant =
     requestSchemaFields          (additional /device/code body fields)
   ∧ deviceCodeSchemaFields       (additional persisted columns)
   ∧ authorizeRequest             (replaces/augments client_id validation)
   ∧ assertSessionRedemption      (can VETO the standalone /device/token
                                    path for grant-owned codes)
   ∧ getVerificationContext       (additional fields in the owner-only
                                    /device status response)
```

This is a second-order instance of the plugin-extends-plugin rule: at
construction time, `assertGrantFieldsAreAdditional` enforces — by throwing
immediately, not by silent override — that a grant's request fields, device
code columns, and verification-response fields **must be strictly
additive**: none may redefine a field the base device-authorization contract
already owns (`client_id`, `user_id`, `scope`, and the base `DeviceCode`
columns). This is Meyer's inheritance rule (§5 of the design-by-contract
document) enforced at the type/schema level: a grant may widen what the base
protocol accepts and add new observable fields, but it may never narrow or
redefine what the base protocol already promised.

### A.3 RFC 8628 polling state machine (`/device/token`)

```
                    device requests token (device_code, client_id)
                                    │
                    authorizeRedemption(deviceCodeRecord)
                    — grant-owned client/ownership checks
                    run FIRST, before any state transition
                                    │
                    polling too soon? (now - lastPolledAt <
                    pollingInterval) ──yes──► "slow_down"
                    (lastPolledAt is NOT yet updated at this
                    point in the check — see below)
                                    │no
                                    ▼
                    lastPolledAt := now  (updated UNCONDITIONALLY
                    for every redemption attempt that reaches this
                    point, regardless of the outcome below — so a
                    poll that is about to be rejected as expired,
                    pending, or denied still counts for the NEXT
                    attempt's slow_down throttling)
                                    │
                    expiresAt < now? ──yes──► DELETE the row,
                    │                          "expired_token"
                    │no                        (garbage-collected
                    ▼                           on first discovery)
                    status == "pending"? ──yes──► "authorization_pending"
                    │no                            (row left intact —
                    ▼                              polling continues)
                    status == "denied"? ──yes──► DELETE the row,
                    │no                           "access_denied"
                    ▼
                    status != "approved" or userId
                    missing? ──yes──► 500 "server_error"
                    (should be unreachable; defensive)
                    │no
                    ▼
                    ALL fallible checks (grant authorization, user
                    lookup) complete BEFORE the destructive step —
                    ONLY THEN: ATOMIC CONDITIONAL CONSUME
                    (id + ownershipWhere + status="approved")
                                    │
                    claim failed (lost the race)? ──yes──► "invalid_grant"
                    │no
                    ▼
                    session created for the claimed row's userId;
                    credential/session side effects run STRICTLY
                    AFTER the atomic claim, never before — so a
                    concurrent losing poller can never observe a
                    session that was minted from a device code it
                    didn't actually win
```

### A.4 Verification and approval (`GET /device`, `/device/approve`, `/device/deny`)

```
Operation:     deviceVerify (GET /device?user_code=...)
Requires:      nothing to view minimal status; an authenticated session to
               claim an unclaimed code or to see owner-only fields
Ensures:       user_code lookup tries an EXACT match first, then (only for
               codes matching the default alphabet) a normalized form
               (non-alphanumeric stripped, uppercased) — preserving exact
               matching for custom generators while tolerating
               human-typo'd default codes. IF a session is present AND the
               row is pending AND unclaimed: ATOMICALLY claims it
               (compare-and-swap on id+status="pending"+userId=null).
               canReviewRequest (session's user == the row's — possibly
               just-claimed — userId) gates whether clientId/scope/grant
               context are disclosed at all; an unrelated caller (no
               session, or a different user) sees only {user_code, status}.
Invariant:     claiming is idempotent for the SAME session across repeated
               polls of the verification page, and impossible for a
               DIFFERENT session once claimed
On violation:  BAD_REQUEST INVALID_USER_CODE / EXPIRED_USER_CODE (rejected
               WITHOUT deleting the row here — cleanup is left to whichever
               path discovers the expiry next, e.g. §A.3's token poll).
               Blamed party: CLIENT.
```

```
Operation:     deviceApprove / deviceDeny (POST /device/approve|deny)
Requires:      authenticated session; row exists, unexpired, still
               pending, AND already claimed (userId set — else
               DEVICE_CODE_NOT_CLAIMED, meaning the caller must GET /device
               first); the calling session's user MUST equal the claimed
               userId (else FORBIDDEN access_denied — this is an ownership
               check, not a permission level)
Ensures:       status transitions to "approved" or "denied" (terminal for
               approve only in the sense that §A.3 will delete the row
               once it observes "denied"; "approved" rows are deleted only
               by successful or lost-race redemption)
On violation:  BAD_REQUEST invalid_request / expired_token /
               device_code_already_processed / device_code_not_claimed;
               FORBIDDEN access_denied. Blamed party: CLIENT.
```

### A.5 Configuration-driven behavior variants

| Option | Default | Effect |
|---|---|---|
| `expiresIn` | 30m | Shared device-code/user-code TTL |
| `interval` | 5s | Minimum polling gap enforced as `slow_down` |
| `deviceCodeLength` / `userCodeLength` | 40 / 8 | Capped at 191 chars (typical indexed-column limit) |
| `generateDeviceCode` / `generateUserCode` | random string / crowd-readable charset (excludes visually ambiguous characters) | Higher-order overrides; output is still length-validated |
| `validateClient` | none (any client_id accepted, unless a `grant` requires authorization) | Higher-order client allow-list predicate |
| `onDeviceAuthRequest` | — | Higher-order side-effect hook (e.g. audit logging) fired once per issuance |
| `verificationUri` | `/device` | Absolute or relative; `verification_uri_complete` always appends `?user_code=` |
| `grant` | none | Enables §A.2's extension point |

Cross-cutting: a rate limit of 5 requests per `expiresIn`-length window is
applied to `/device/code` — the rate-limit window is deliberately tied to
the configured device-code lifetime, not a fixed constant.

### A.6 Sequence: full device flow

```
Device (limited input)      /device/code          User's phone/browser        /device/token (polling)
     │ POST /device/code       │                          │                         │
     ├──────────────────────────►│                          │                         │
     │                          │ generate device_code +   │                         │
     │                          │ user_code, status=pending │                         │
     │◄─ {device_code,          │                          │                         │
     │    user_code,            │                          │                         │
     │    verification_uri} ────┤                          │                         │
     │                                                        │                         │
     │  (device displays user_code + verification_uri)        │                         │
     │                                                        │                         │
     │                          GET /device?user_code=...     │                         │
     │                          ◄──────────────────────────────                         │
     │                          claim (userId := session's)   │                         │
     │                          ──────── {status:pending,     │                         │
     │                                    client_id, scope} ──►                         │
     │                                                        │                         │
     │                          POST /device/approve          │                         │
     │                          ◄──────────────────────────────                         │
     │                          status := approved            │                         │
     │                          ──────── {success:true} ──────►                         │
     │                                                                                    │
     │ (meanwhile, device has been polling /device/token every `interval` seconds)       │
     │                                                                POST /device/token  │
     │                                                                ◄────────────────── │
     │                                                                atomic claim succeeds│
     │                                                                session created       │
     │◄──────────────────────────── {access_token, token_type, expires_in, scope} ────────┤
```

---

## Part B — Google One Tap

### B.1 A thin wrapper over social sign-in

One Tap contributes exactly one endpoint, no schema, and no new identity
model. Its entire postcondition is: verify a Google-issued ID token, then
hand the resulting identity to the SAME `handleOAuthUserInfo` resolution
path used by the ordinary Google redirect-based social sign-in — the "account
that owns this Google `sub` (subject) wins" rule, NOT an email-match rule,
is enforced identically for both flows specifically to prevent account
hijacking via a colliding email address.

### B.2 The audience-verification gap (parallel to SIWE's `verifyMessage` gap)

```
Contract:      verifyGoogleIdToken : {token, audience}  ->  Promise<payload|null>
```

Verifying a Google ID token's signature and issuer, WITHOUT an expected
`audience`, does not confirm the token was minted for THIS relying party —
any token issued by Google to ANY client could otherwise be replayed here.
Exactly as SIWE independently re-derives message-body fields before trusting
`verifyMessage`'s boolean, One Tap resolves and REQUIRES an audience
(the plugin's own `clientId`, or falling back to the configured Google
social-provider's `clientId`) and fails closed with `BAD_REQUEST` if neither
is configured, BEFORE calling the verification function at all.

```
Operation:     oneTapCallback (POST /one-tap/callback)
Requires:      a resolvable audience (clientId, §B.2); a valid Google ID
               token whose `sub` and `email` claims are present; the
               token's `hd` (hosted domain) claim must satisfy whatever
               hosted-domain restriction is configured on the Google
               social provider — the SAME restriction check the redirect
               flow enforces, so One Tap cannot be used to bypass an
               organization's hosted-domain policy that would otherwise
               apply to standard Google sign-in with the same provider
               configuration
Ensures:       delegates to the shared OAuth user-info resolution path
               (handleOAuthUserInfo) with providerId="google", the token's
               `sub` as accountId — identity resolution, sign-up gating
               (disableSignup, falling back to the provider's own
               disableSignUp), and account-linking all follow the SAME
               rules as ordinary Google social sign-in; a session is
               created and set on success
Invariant:     One Tap and redirect-based Google sign-in can never diverge
               on WHICH local account a given Google identity resolves to,
               since both paths funnel through the same resolution
               function
On violation:  BAD_REQUEST (invalid/missing audience, invalid id token,
               missing email/sub, disallowed hosted domain); FORBIDDEN
               EMAIL_NOT_VERIFIED; UNAUTHORIZED (any other resolution
               failure, message forwarded from the shared resolver).
               Blamed party: CLIENT (forged/expired/wrong-audience token,
               unverified email) or SUPPLIER (deployer never configured a
               resolvable clientId).
```

The `callbackURL` field accepted in the request body is not used for a
server-side redirect at all — it exists purely so the value is visible to
the framework's general trusted-origin validation before the CLIENT SDK
performs its own `window.location` navigation, preventing an unvalidated
open redirect at the point where the browser, not the server, does the
navigating.

### B.3 Configuration-driven behavior variants

| Option | Default | Effect |
|---|---|---|
| `disableSignup` | false | Blocks auto-registration of a previously-unseen Google identity via One Tap specifically (independent of the shared Google provider's own `disableSignUp`, either being true is sufficient to block) |
| `clientId` | falls back to `socialProviders.google.clientId` | Resolves the required audience (§B.2) |

### B.4 Sequence

```
Browser                    One Tap prompt (Google)         oneTapCallback
  │  Google renders the One Tap UI using the                    │
  │  configured client_id; user selects an account               │
  │◄──────────────────────────────────────────────────────────────
  │  (browser receives a signed Google ID token)                  │
  │                                                                 │
  │ POST /one-tap/callback {idToken, callbackURL?}                │
  ├─────────────────────────────────────────────────────────────► │
  │                                    resolve audience (required)  │
  │                                    verifyGoogleIdToken()         │
  │                                    check hosted-domain policy    │
  │                                    handleOAuthUserInfo()         │
  │                                    — same path as redirect-based │
  │                                      Google sign-in              │
  │◄──────────────── {token, user} ─────────────────────────────────┤
```
