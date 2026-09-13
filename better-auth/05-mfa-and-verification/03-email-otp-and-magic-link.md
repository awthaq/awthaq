# Email OTP and Magic Link Plugins

Both plugins implement the same shape of contract — a **channel-delivered,
single-use credential** proving control of an email address — but differ
sharply in the granted attempt budget, because a short numeric OTP is
guessable within a bounded number of tries while a long random token is not.
Neither plugin adds fields to `User`/`Session`; both operate entirely through
the shared verification-value store (see the core-domain database-adapter
contract) and both are built on the SAME higher-order pattern: a
caller-supplied delivery callback (`sendVerificationOTP` /
`sendMagicLink`) that the plugin cannot verify was actually delivered — it
can only verify that a record was created and can be redeemed.

---

## 1. The delivery callback: a higher-order contract, with two different failure disciplines

```
sendVerificationOTP : { email, otp, type } × ctx?  ->  Awaitable<void>
sendMagicLink       : { email, url, token, metadata? } × ctx?  ->  Awaitable<void>
```

**Domain contract** (what the plugin guarantees the callback receives): a
freshly generated, already-persisted credential and the recipient's address.
**Range contract**: nothing meaningful — the plugin cannot observe whether an
email was actually sent, bounced, or landed in spam. This is exactly the
Findler–Felleisen "cannot check a function's behavior at registration,
only observe it lazily at each call" situation: the contract is discharged
by *calling* the function, not by inspecting it in advance.

The two plugins diverge on what happens when the callback itself fails:

| | email-otp | magic-link |
|---|---|---|
| Await discipline | `runInBackgroundOrAwait` — may run detached from the request/response cycle (recommended precisely so a slow/failing send cannot be timed by an attacker to infer account existence) | directly `await`ed — a thrown/rejected `sendMagicLink` propagates and fails the endpoint |
| Blame on delivery failure | SUPPLIER (integrator's callback), but invisible to the caller — the endpoint still reports `{success: true}` | SUPPLIER, and visible — the endpoint surfaces a 5xx to the caller |
| Rationale | matches the "safe to leak OTP was requested, not whether user exists" enumeration-resistance goal used throughout this plugin | magic-link has no separate "check" endpoint, so a synchronous failure is the only way to signal a broken transport to the caller |

---

## 2. Credential lifecycle — OTP (email-otp)

Identifier is **`(type, email)`**, `type ∈ {sign-in, email-verification,
forget-password, change-email}` (change-email uses the composite identifier
`${currentEmail}-${newEmail}`). Stored value is `${encodedOtp}:${attempts}`.

```
                     send-verification-otp / auto-send-on-signup
                                    │
                                    ▼
                                ISSUED
                    (record for identifier=(type,email),
                     attempts=0, TTL=expiresIn, default 5 min)
                                    │
              a NEW send request for the SAME identifier arrives
                    │                              │
          resendStrategy="rotate"          resendStrategy="reuse"
          (default): delete + recreate      (only if storeOTP is
          with a brand-new code,             recoverable — plain /
          attempts reset to 0                encrypted / custom
                    │                         encrypt-decrypt; falls
                    │                         back to rotate if hashed):
                    │                         SAME code re-sent,
                    │                         expiresIn extended,
                    │                         attempts UNCHANGED
                    ▼                              │
                ISSUED  ◄──────────────────────────┘
                    │
        check/verify call with a code
                    │
        atomic consume of the record (first racer wins; every
        other concurrent racer sees "already consumed")
                    │
          ┌─────────┴─────────┐
    code matches          code does not match
          │                   │
          ▼                   ▼
      CONSUMED           attempts < allowedAttempts (default 3)?
   (terminal — the        │yes                    │no
   identifier is now       ▼                       ▼
   free for a new     record RECREATED with   CONSUMED anyway
   ISSUE, but this      same code+expiry,      (record stays gone,
   exact code/record   attempts+1; back to     no further guesses
   can never be         PENDING                possible until a
   redeemed again)                              fresh send-otp call)
                                                      │
                                                      ▼
                                              TOO_MANY_ATTEMPTS
                                              (403 FORBIDDEN)
```

A record whose expiry has already passed is deleted and reported as
`OTP_EXPIRED` rather than being silently treated as "not found" — this is a
deliberate, distinguishable error surfaced BEFORE the atomic consume so a
client can tell "your code timed out" from "your code was wrong", without
weakening the race gate (the consume itself still independently re-checks
expiry and returns nothing for an expired row).

---

## 3. Credential lifecycle — Magic Link token

Identifier is **the token itself** (or its hash, per `storeToken`), not the
email — so, unlike OTP, **multiple simultaneously-valid magic links can exist
for the same email** (each `sign-in/magic-link` call mints an independent
token/record pair; none of them invalidate the others).

```
             sign-in/magic-link
                    │
                    ▼
                ISSUED
        (token -> {email, name}, TTL=expiresIn, default 5 min)
                    │
        GET /magic-link/verify?token=...
                    │
        atomic consume (first racer wins)
                    │
          ┌─────────┴─────────┐
       found & fresh      not found / already
          │                consumed / expired
          ▼                       ▼
      CONSUMED               INVALID_TOKEN
   (session minted;          (redirect to errorCallbackURL
   token can never be         with ?error=INVALID_TOKEN, or
   redeemed again)            JSON error if no callbackURL
                               was supplied at all)
```

**There is no attempt budget and no retry**: `allowedAttempts` is an
accepted-but-ignored, deprecated option — the contract is deliberately
"exactly one verification call succeeds, ever, per issued token," because
the token's entropy (not a guess limit) is what makes it safe. This is the
key behavioral asymmetry with email-otp: a short OTP MUST cap guesses since
it's brute-forceable within a small budget; a long token must not need to,
since capping attempts on an unguessable token adds no security and would
only create a new denial-of-service surface (an attacker submitting wrong
tokens to exhaust someone else's budget).

---

## 4. Operations — email-otp

```
Operation:     send-verification-otp (POST /email-otp/send-verification-otp)
Requires:      sendVerificationOTP configured; a syntactically valid email;
               type != "change-email" (that flow has its own endpoint, §6)
Ensures:       an OTP record is (re)issued per §2's resend policy and handed
               to sendVerificationOTP. For type="sign-in" with
               disableSignUp=false the record is issued and delivered even
               if no user exists yet (auto-registration is decided at
               verification time, not issuance time); for other types, a
               nonexistent user causes the record to be immediately deleted
               and the endpoint still reports success (enumeration-safe: a
               client cannot distinguish "sent" from "no such account").
On violation:  BAD_REQUEST INVALID_EMAIL / (misuse of change-email type).
               Blamed party: CLIENT (bad email) or SUPPLIER
               (sendVerificationOTP not configured).
```

```
Operation:     check-verification-otp / verify-email / sign-in-email-otp /
               reset-password / request-email-change+change-email
Requires:      a live, correctly-typed record for the derived identifier;
               attempt budget not exhausted (§2)
Ensures:       (per operation) marks the address verified, creates or
               revives a session, resets the password, or finalizes an
               email change (§6) — full postconditions given in §6
Invariant:     a given OTP value can satisfy at most one successful
               verification, ever (§2's atomic-consume race gate)
On violation:  BAD_REQUEST INVALID_OTP / OTP_EXPIRED; FORBIDDEN
               TOO_MANY_ATTEMPTS. Blamed party: CLIENT.
```

```
Operation:     createVerificationOTP / getVerificationOTP  — server-only,
               no client SDK method
Requires:      trusted server-side caller
Ensures:       createVerificationOTP mints and returns a plaintext OTP
               programmatically (e.g. for a custom delivery path or test
               harness); getVerificationOTP reads back a still-live
               plaintext OTP — REFUSED (BAD_REQUEST) when storeOTP is
               "hashed" or a custom hash function, since the plaintext is
               genuinely unrecoverable in that configuration
On violation:  blamed party: SUPPLIER (caller is trusted server code by
               construction; a refusal here reflects the deployer's own
               storeOTP choice, not a client error).
```

---

## 5. Operations — magic-link

```
Operation:     sign-in-magic-link (POST /sign-in/magic-link)
Requires:      a syntactically valid email (via schema); CSRF-form check
Ensures:       mints a new, independent token (§3), stores {email, name},
               and (unconditionally) awaits sendMagicLink with the fully
               formed verification URL. Always reports {status: true} —
               enumeration-safe by construction, since token issuance never
               depends on whether the user already exists.
On violation:  a thrown/rejected sendMagicLink propagates as a 5xx. Blamed
               party: SUPPLIER.
```

```
Operation:     magic-link-verify (GET /magic-link/verify)
Requires:      a live, unconsumed token; callbackURL / newUserCallbackURL /
               errorCallbackURL (if supplied) must each pass an origin-check
               arrow contract (domain: the decoded redirect target; range:
               allow/deny) — this is the plugin's open-redirect defense,
               since this endpoint is reached by simple browser navigation
               from an emailed link, not a same-origin fetch
Ensures:       on success: if the user does not exist, one is created with
               emailVerified=true (unless disableSignUp, which instead
               redirects with error "new_user_signup_disabled"); if the
               user exists but is unverified, its unproven-account state is
               resolved via the same account-promotion step used by
               sign-in-email-otp (see the core-domain account-linking
               invariant); a session is created and set. Browser-style
               calls (callbackURL was supplied) end in a redirect to
               callbackURL (existing user) or newUserCallbackURL (new
               user); API-style calls (no callbackURL at all) get a JSON
               body instead.
Invariant:     every failure path redirects to errorCallbackURL with a
               machine-readable `error` code rather than throwing a raw
               API error to the browser — EXCEPT when no callbackURL was
               given, in which case the original APIError-shaped failure
               is what's returned, preserving API-style error handling for
               non-browser callers
On violation:  redirect with error=INVALID_TOKEN / new_user_signup_disabled
               / user_not_found / failed_to_create_user /
               failed_to_create_session, or (server-created-user path) the
               underlying create-user error code. Blamed party: CLIENT
               (expired/replayed link) or SUPPLIER (user/session creation
               failure).
```

---

## 6. Change-email sub-flow (email-otp only)

A two-step, two-address protocol layered on the same OTP primitive:

```
request-email-change (authenticated, sensitive session)
   │  changeEmail.verifyCurrentEmail=true?
   │     yes: requires and atomically verifies an OTP already issued
   │          against the CURRENT email (type "email-verification")
   │          before proceeding
   │     no:  proceeds unconditionally (a stray otp field is accepted
   │          but only warned about, never checked)
   ▼
issues a NEW OTP under the composite identifier
`${currentEmail}-${newEmail}` (type "change-email") and delivers it to
the NEW address — unless the new address is already claimed by another
user, in which case the record is deleted and the endpoint still reports
success (enumeration-safe)
   │
   ▼
change-email (authenticated, sensitive session)
   requires the OTP issued for that exact (currentEmail, newEmail) pair;
   on success, updates the session's user record in place (email,
   emailVerified: true) and refreshes the session cookie — no new
   session token is minted, this is a same-session mutation
```

**Invariant:** the change-email OTP identifier binds the specific
`(currentEmail, newEmail)` pair, so a code issued for one candidate new
address cannot be redeemed against a different one, even by the same
authenticated user in the same request window.

---

## 7. Configuration-driven behavior variants

**email-otp**

| Option | Default | Effect |
|---|---|---|
| `otpLength` | 6 | Digits in the generated code |
| `expiresIn` | 300s | TTL per issued record |
| `allowedAttempts` | 3 | Guesses before the record locks (stays consumed) |
| `storeOTP` | "plain" | plain / hashed / encrypted / custom hash / custom encrypt-decrypt |
| `resendStrategy` | "rotate" | "reuse" extends the same code instead of rotating (falls back to rotate if the stored form is unrecoverable) |
| `disableSignUp` | false | sign-in-email-otp will not auto-register an unknown address |
| `sendVerificationOnSignUp` | false | after-hook auto-sends an email-verification OTP post sign-up (mutually exclusive in practice with `overrideDefaultEmailVerification`) |
| `overrideDefaultEmailVerification` | false | plugin `init()` REPLACES the base auth system's `emailVerification.sendVerificationEmail` option with an OTP-driven implementation — a higher-order override of a cross-cutting base contract, not just an added endpoint |
| `changeEmail.enabled` / `verifyCurrentEmail` | false / false | Enables §6 and whether the current address must itself be re-proven first |
| `rateLimit.window` / `.max` | 60s / 3 | Applied uniformly across all 9 email-otp-related paths |

**magic-link**

| Option | Default | Effect |
|---|---|---|
| `expiresIn` | 300s | TTL per issued token |
| `storeToken` | "plain" | plain / hashed / custom-hasher (no "encrypted" mode, unlike email-otp) |
| `disableSignUp` | false | verify will not auto-register an unknown address |
| `generateToken` | random 32-char string | Custom token generation |
| `rateLimit.window` / `.max` | 60s / 5 | Applied to `/sign-in/magic-link` and `/magic-link/verify` |
| `allowedAttempts` | — | accepted for source compatibility, ignored (see §3); any value other than 1 logs a construction-time warning |

---

## 8. Sequence: sign-in-email-otp, first-time user

```
Client                  send-verification-otp         sign-in-email-otp
  │ POST send-verification-otp {email,type:"sign-in"}  │
  ├──────────────────────►│                             │
  │                       │ no existing user, but        │
  │                       │ disableSignUp=false, so       │
  │                       │ still issue+deliver OTP       │
  │◄──── {success:true} ──┤                             │
  │                                                       │
  │ POST /sign-in/email-otp {email, otp, name?}          │
  ├───────────────────────────────────────────────────►  │
  │                                    atomicVerifyOTP:    │
  │                                    consume record,     │
  │                                    code matches         │
  │                                    no user found ->     │
  │                                    createUser(name,     │
  │                                    emailVerified:true)  │
  │                                    createSession()      │
  │◄──────────── { token, user } ─────────────────────────┤
```
