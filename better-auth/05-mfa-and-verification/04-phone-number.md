# Phone Number Plugin

Establishes the phone number as a second first-class identity channel,
parallel to email-otp but with three behaviors that have no email
counterpart: (1) it can fully delegate verification to an external SMS
provider's own OTP logic, (2) it narrows the base `update-user` contract to
forbid changing a phone number outside its own verify flow, and (3) it can be
the primary sign-up identity (temp-email-backed accounts) rather than only a
secondary verification channel on an existing account.

---

## 1. Entity invariants added

```
User (extended)
  + phoneNumber: string | null      (unique, sortable, client-writable to null
                                      only — see §2)
  + phoneNumberVerified: boolean    (not client-writable directly; flips via
                                      the verify flow or the hook in §2)
```

1. `phoneNumber` is globally unique (schema `unique: true`).
2. **`phoneNumberVerified = true` never coexists with `phoneNumber = null`.**
   Enforced by a `databaseHooks.user.update.before` hook: whenever an update
   sets `phoneNumber` to `null`, the hook injects
   `phoneNumberVerified: false` into the SAME update, atomically.
3. **A phone number can only be *set to a new value* through the
   phone-number verify flow, never through the generic user-update
   operation.** A `before` hook on `/update-user` rejects any request body
   containing a non-null `phoneNumber` field with
   `PHONE_NUMBER_CANNOT_BE_UPDATED`; only `phoneNumber: null`
   (disassociation) is allowed through that endpoint. This is a plugin
   **narrowing** the base `update-user` precondition — per the
   inheritance/blame rules in the methodology documents, any caller that
   relied on the base contract's more permissive behavior and is now
   rejected is a fault attributable to THIS PLUGIN, not to `update-user`
   itself.

---

## 2. Verification lifecycle (three converging entry points, one state machine)

```
                    send-phone-number-otp
                            │
                            ▼
                        ISSUED
              (identifier = bare phoneNumber string;
               value = "code:0"; TTL = expiresIn, default 300s)
                            │
        verify-phone-number / consume-phone-number-otp (code)
                            │
              ┌── opts.verifyOTP configured? ──┐
             yes                                no
              │                                  │
              ▼                                  ▼
   DELEGATED VERIFICATION:              INTERNAL VERIFICATION:
   the plugin's own record is           atomic consume + embedded
   deleted UNCONDITIONALLY once         attempt counter, IDENTICAL
   verifyOTP returns true; no           in shape to email-otp's
   attempt cap or expiry is             atomicVerifyOTP (§ see
   enforced by this plugin at           03-email-otp-and-magic-link.md
   all — those become entirely          §2): wrong code re-arms with
   the external verifyOTP               same expiry + attempts+1 up
   implementation's responsibility      to allowedAttempts (default 3),
                                         then the record stays consumed
              └────────────┬───────────────────┘
                            ▼
              code accepted — branch on request shape:
                            │
        ┌───────────────────┼───────────────────────┐
        ▼                   ▼                         ▼
  updatePhoneNumber    existing user found      no user found AND
  =true (session         by phoneNumber          signUpOnVerification
  required): LINK        (default path):          configured:
  phone to the           mark                     CREATE a new user
  current session's      phoneNumberVerified       with a temp email
  user, after             = true                   (getTempEmail,
  confirming no                                     required) and temp
  OTHER user already                                name (getTempName,
  owns this number                                  defaults to the
  (else                                              phone number
  PHONE_NUMBER_EXIST)                                 itself), phone
                                                       pre-verified
        └───────────────────┴───────────────────────┘
                            │
              callbackOnVerification(phoneNumber, user, ctx)
              — higher-order, AWAITED DIRECTLY (not
              fire-and-forget): a throwing callback surfaces as
              a 500 to the client EVEN THOUGH the verification
              and user mutation already committed — a partial-
              success-reported-as-failure hazard callers of this
              hook must be aware of
                            │
              disableSession=true? ── yes ──► return {status:true,
                                                token:null, user}
                            │no
                            ▼
              create + set session; return {status:true, token, user}
```

---

## 3. Sign-in with mandatory prior verification

```
Operation:     sign-in-phone-number (POST /sign-in/phone-number)
Requires:      a user with this phoneNumber and a linked credential
               (password) account; if requireVerification is enabled, the
               user's phoneNumberVerified must already be true
Ensures:       on requireVerification=true and phoneNumberVerified=false:
               the endpoint does NOT simply reject — it SIDE-EFFECTS an OTP
               dispatch (issues a fresh code under the bare-phoneNumber
               identifier and calls sendOTP) as part of failing the sign-in
               attempt, then rejects with PHONE_NUMBER_NOT_VERIFIED. A
               caller must treat this specific rejection as "a code was
               just sent, go verify" rather than a terminal failure.
               Otherwise: standard password check, session created.
Invariant:     this OTP dispatch reuses the SAME identifier namespace as an
               explicit send-phone-number-otp call — a verification code
               requested this way can be redeemed by the ordinary
               verify-phone-number endpoint
On violation:  UNAUTHORIZED INVALID_PHONE_NUMBER_OR_PASSWORD /
               PHONE_NUMBER_NOT_VERIFIED. Blamed party: CLIENT (bad
               credentials) — PHONE_NUMBER_NOT_VERIFIED is CLIENT-caused
               but carries a SUPPLIER-initiated side effect (OTP dispatch)
               as part of the rejection.
```

---

## 4. The `verifyOTP` override: full postcondition delegation

```
Contract:      verifyOTP : { phoneNumber, code } × ctx?  ->  Awaitable<boolean>
Applies at:    every call to verify-phone-number / consume-phone-number-otp,
               in place of the plugin's own atomic-consume + attempt-cap
               machinery (§2)
On mismatch:   if verifyOTP is configured but throws or returns false, the
               plugin surfaces INVALID_OTP and does NOT fall back to
               internal verification — it is all-or-nothing per call, not
               a fallback chain. Blamed party for an incorrect true/false
               judgment: SUPPLIER (the external SMS/OTP provider
               integration), since the plugin's own contract explicitly
               stops enforcing expiry/attempts once this hook is present.
```

This is the sharpest example in this document of Meyer's inheritance rule
being exercised at the *configuration* level rather than at the plugin
level: supplying `verifyOTP` doesn't just add behavior, it WEAKENS the
plugin's own postcondition (no more attempt cap, no more plugin-side expiry)
in exchange for delegating that postcondition entirely to a trusted external
supplier — a valid trade only because the plugin stops claiming to enforce it
at all, rather than silently enforcing it inconsistently alongside the
external check.

---

## 5. Other operations

```
Operation:     send-phone-number-otp (POST /phone-number/send-otp)
Requires:      opts.sendOTP configured (else SEND_OTP_NOT_IMPLEMENTED);
               phoneNumberValidator(phoneNumber), if configured, must
               return true (higher-order predicate, domain: string,
               range: Awaitable<boolean>)
Ensures:       issues a record under the bare-phoneNumber identifier and
               hands it to sendOTP (background-eligible via the same
               runInBackgroundOrAwait pattern used by email-otp/two-factor
               when a background-task handler is configured, otherwise
               awaited directly)
On violation:  NOT_IMPLEMENTED SEND_OTP_NOT_IMPLEMENTED; BAD_REQUEST
               INVALID_PHONE_NUMBER. Blamed party: SUPPLIER (not
               configured) or CLIENT (fails validator).
```

```
Operation:     request-password-reset (POST /phone-number/request-password-reset)
Requires:      nothing about existence — always reports {status: true}
Ensures:       issues a record under the DISTINCT identifier
               `${phoneNumber}-request-password-reset` (isolated from the
               bare-phoneNumber namespace so a pending password-reset code
               cannot be redeemed as a verification code or vice versa);
               if no user owns this number, the record is created and then
               immediately discarded without dispatch — enumeration-safe,
               identical pattern to email-otp's forget-password.
```

```
Operation:     reset-password (POST /phone-number/reset-password)
Requires:      a live, correctly-scoped OTP under the reset identifier;
               new password within configured length bounds
Ensures:       atomically verifies the OTP (same internal attempt-cap
               machinery as §2's internal branch — this endpoint does NOT
               honor a custom verifyOTP override, since RFC-style
               delegation was scoped to phone verification, not password
               reset), creates or updates the credential account,
               optionally revokes all other sessions
               (emailAndPassword.revokeSessionsOnPasswordReset)
On violation:  BAD_REQUEST OTP_NOT_FOUND / OTP_EXPIRED / INVALID_OTP /
               PASSWORD_TOO_SHORT / PASSWORD_TOO_LONG; FORBIDDEN
               TOO_MANY_ATTEMPTS. Blamed party: CLIENT.
```

```
Operation:     consume-phone-number-otp — server-only, no client SDK method,
               hidden from OpenAPI (HIDE_METADATA)
Ensures:       verifies and consumes an OTP WITHOUT updating any user or
               creating a session — a bare "was this code correct" check
               for callers building custom flows on top of the primitive
```

---

## 6. Configuration-driven behavior variants

| Option | Default | Effect |
|---|---|---|
| `otpLength` | 6 | Digits per code |
| `expiresIn` | 300s | TTL per issued record (shared by both identifier namespaces) |
| `allowedAttempts` | 3 | Guesses before internal-verification lockout (irrelevant when `verifyOTP` is set) |
| `sendOTP` | — (required) | Higher-order delivery callback |
| `verifyOTP` | — | Higher-order full-postcondition delegation (§4) |
| `phoneNumberValidator` | accepts any string | Higher-order format/allow-list predicate |
| `requireVerification` | false | Gates sign-in on `phoneNumberVerified`, side-effecting an OTP dispatch on rejection (§3) |
| `signUpOnVerification.getTempEmail` | — (required if enabled) | Enables phone-number-as-primary-identity sign-up |
| `signUpOnVerification.getTempName` | phone number itself | Display name for a phone-created account |
| `callbackOnVerification` | — | Higher-order, directly-awaited post-verification hook (§2's partial-success hazard) |
| `sendPasswordResetOTP` | — | Separate delivery callback from `sendOTP`, used only by the reset-password identifier namespace |

Cross-cutting: a plugin-level rate limit of 10 requests / 60s window applies
to every path under `/phone-number/*`.

---

## 7. Sequence: verify with sign-up (phone-first onboarding)

```
Client              send-phone-number-otp        verify-phone-number
  │ POST send-otp {phoneNumber}                   │
  ├──────────────────►│                            │
  │                   │ issue record (bare phone)  │
  │◄── {message} ─────┤                            │
  │                                                  │
  │ POST verify {phoneNumber, code}                 │
  ├─────────────────────────────────────────────────►
  │                              atomic consume, code OK
  │                              no existing user with
  │                              this phoneNumber, but
  │                              signUpOnVerification set:
  │                              createUser(tempEmail,
  │                                tempName, phoneNumber,
  │                                phoneNumberVerified:true)
  │                              callbackOnVerification()
  │                              createSession()
  │◄──── {status:true, token, user} ─────────────────┤
```
