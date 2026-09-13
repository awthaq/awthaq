# Two-Factor Authentication Plugin

The `two-factor` plugin is a higher-order extension of the base plugin
contract (see the plugin contract document) that bundles three interchangeable
**factor providers** — TOTP, channel-delivered OTP, and backup codes — behind
one shared **challenge contract**. It adds one entity (`TwoFactor`, one row
per user) and one field to `User` (`twoFactorEnabled`), and it wraps every
credential sign-in endpoint with a `before`/`after` hook arrow that can
redirect a completed credential check into a pending second-factor challenge.

Only TOTP and backup codes require the `TwoFactor` row; the OTP factor can run
purely off `twoFactorEnabled` plus a caller-supplied delivery channel, with no
persisted secret at all.

---

## 1. Entities and invariants added

```
User (extended)
  + twoFactorEnabled: boolean            (default false, not client-writable)

TwoFactor  (0 or 1 row per userId)
  id, userId
  secret: string            (encrypted; returned:false)
  backupCodes: string       (encoded per storeBackupCodes policy; returned:false)
  verified: boolean         (default true — legacy-safe for pre-migration rows)
  failedVerificationCount: number  (default 0, not client-writable)
  lockedUntil: date | null         (not client-writable)
```

**Entity invariants:**

1. `TwoFactor` is at most one row per `userId` (enforced by lookup-then-
   create/update logic, not a DB unique constraint in the shown schema — a
   reimplementation SHOULD add one).
2. `secret` and `backupCodes` are never present in any endpoint's JSON output
   (`returned:false`) — the *only* legitimate way to read decrypted backup
   codes is the server-only `viewBackupCodes` operation (§5).
3. `verified` is monotonic per enrollment cycle: it starts `false` on a fresh
   TOTP enrollment (unless `skipVerificationOnEnable`) and flips to `true`
   exactly once, on the first successful `verify-totp` call. Disabling and
   re-enabling starts a new cycle.
4. `failedVerificationCount` and `lockedUntil` are set/cleared together: a
   nonzero `lockedUntil` implies the count had reached the configured
   threshold at the time it was set; clearing one clears the other.
5. `User.twoFactorEnabled = true` does **not** imply a `TwoFactor` row exists:
   an account enrolled only in the OTP factor (`method: "otp"` at enable time)
   has `twoFactorEnabled = true` with zero `TwoFactor` rows. Consequently,
   **account-level lockout (§4) only applies to accounts that have a
   `TwoFactor` row** — pure-OTP accounts are governed solely by the
   per-challenge OTP attempt budget embedded in the OTP verification record.

---

## 2. Enrollment state machine (per user, per factor)

```
                    ┌─────────────────────────────────────────┐
                    │              TOTP factor                  │
                    └─────────────────────────────────────────┘

        enable(method:"totp")
   NOT_ENROLLED ───────────────────────► PENDING_VERIFICATION
   (no row)          creates row              (row, verified=false,
                      secret+backupCodes       twoFactorEnabled
                      generated                unchanged)
                                                    │
                       skipVerificationOnEnable=true│  verify-totp(code) ok
                       ├─────────────────────────────┤
                       ▼                             ▼
                   ENROLLED  ◄───────────────────────┘
                   (verified=true, twoFactorEnabled=true)
                       │
                       │ disable() [sensitive session]
                       ▼
                   NOT_ENROLLED  (row deleted, twoFactorEnabled=false,
                                  trust-device cookie/record revoked)

                    ┌─────────────────────────────────────────┐
                    │               OTP factor                   │
                    └─────────────────────────────────────────┘

   NOT_ENROLLED ──────────────────────────────────────► ENROLLED
   (twoFactorEnabled=false)   enable(method:"otp")       (twoFactorEnabled=true,
                              [requires otpOptions.sendOTP  no TwoFactor row
                               configured; sets enabled     required)
                               immediately, no challenge)
```

`enable` always rotates the caller's session (deletes the pre-enable session,
issues a new one bound to the updated user) so that any cached `twoFactorEnabled`
value elsewhere in the system cannot go stale.

---

## 3. Sign-in challenge state machine

```
credential sign-in succeeds (email/username/phone-number)
                │
                ▼
     after-hook: user.twoFactorEnabled?
        │no                  │yes
        ▼                    ▼
   session stands    trust-device cookie present & HMAC-valid &
   (no 2FA)          server-side verification record unexpired?
                        │yes                        │no
                        ▼                            ▼
                 rotate trust cookie          delete the just-created
                 (sliding window,             session; create:
                 same userId)                  • signed "two_factor" cookie
                 session stands                 • verification row
                 (2FA skipped)                    "2fa-{id}" -> userId
                                                    (TTL = twoFactorCookieMaxAge)
                                                  • verification row
                                                    "2fa-attempts-{id}" -> "0"
                                                (same TTL)
                                                    │
                                                    ▼
                                          PENDING_CHALLENGE
                                          twoFactorMethods: [...]
```

```
                         PENDING_CHALLENGE
                                │
        verify-totp / verify-otp / verify-backup-code (code)
                                │
                 beginAttempt(): atomically consume
                 "2fa-attempts-{id}", read count
                                │
              count >= allowedAttempts? ──yes──► challenge cancelled:
                                │                  consume + expire the
                               no                  "two_factor" cookie;
                                │                  client must restart
                    code correct?                  credential sign-in
                    │no            │yes
                    ▼               ▼
             re-arm counter    CONSUMED: atomically consume the
             (+1), record      "two_factor" verification row
             account-level      (first winner only); create real
             failure if a       session; expire challenge cookie;
             TwoFactor row      optionally mint/rotate trust-device
             exists; stay in    cookie if trustDevice=true
             PENDING_CHALLENGE
```

The challenge and its attempt counter are **separate single-use verification
records**, both consumed atomically (`consumeVerificationValue`). This closes
two independent races: two concurrent submissions of the same correct code
can mint at most one session, and a burst of concurrent guesses cannot each
read the same attempt count before any write lands.

---

## 4. Account-level lockout (cross-factor, cross-challenge)

Distinct from the per-challenge attempt counter above. Applies only to
accounts with a `TwoFactor` row (TOTP or backup-code enrolled; also OTP
verification when such a row happens to exist).

```
Operation:     assertTwoFactorNotLocked (checked at the top of every
               verify-totp / verify-otp / verify-backup-code call, sign-in
               path only)
Requires:      a TwoFactor row for the account
Ensures:       throws ACCOUNT_TEMPORARILY_LOCKED (429) iff
               lockedUntil > now; otherwise, if lockedUntil is set and
               already expired, atomically clears
               {failedVerificationCount: 0, lockedUntil: null} guarded on
               lockedUntil <= now (so a lock set by a concurrent failure
               after this read is never wiped)
Invariant:     lockedUntil, once past, is lazily cleared exactly once
On violation:  429 TOO_MANY_REQUESTS, blamed party: CLIENT (repeated wrong
               second factor)
```

```
Operation:     recordTwoFactorFailure (called on any wrong code, sign-in path)
Ensures:       failedVerificationCount += 1 (atomic increment); if the
               resulting count >= maxFailedAttempts, sets
               lockedUntil = now + durationSeconds, guarded on the count
               still meeting the threshold (concurrency-safe)
Invariant:     the increment is unguarded on prior column state, so it still
               applies to a legacy row where the column was previously
               null/absent
```

```
Operation:     resetTwoFactorFailures (called on any successful verification,
               sign-in path)
Ensures:       unconditionally sets {failedVerificationCount: 0,
               lockedUntil: null}
```

Defaults: `enabled: true`, `maxFailedAttempts: 10`, `durationSeconds: 900`
(15 min) — independently configurable per two-factor plugin instance.

---

## 5. Operations

```
Operation:     enable  (POST /two-factor/enable)
Requires:      an authenticated session; password verified UNLESS
               allowPasswordless is set for the chosen method AND the
               account has no credential (password) account; method="otp"
               requires otpOptions.sendOTP configured; method="totp"
               requires totpOptions.disable !== true; method="totp" requires
               no existing *verified* TwoFactor row (else
               TOTP_ALREADY_ENABLED)
Ensures:       method="otp": twoFactorEnabled -> true immediately, session
               rotated. method="totp": a TwoFactor row is created/updated
               with a fresh secret + fresh backup-code set,
               verified = skipVerificationOnEnable; response includes
               totpURI + plaintext backupCodes (shown exactly once).
               skipVerificationOnEnable=true additionally flips
               twoFactorEnabled and rotates the session immediately, same
               as OTP.
Invariant:     TwoFactor row is 0-or-1 per user (upsert by userId)
On violation:  BAD_REQUEST — OTP_NOT_CONFIGURED / TOTP_NOT_CONFIGURED /
               TOTP_ALREADY_ENABLED / INVALID_PASSWORD.
               Blamed party: CLIENT (bad method/password) or SUPPLIER
               (deployer never configured otpOptions.sendOTP or disabled
               totp yet a client tries to enable it).
```

```
Operation:     disable  (POST /two-factor/disable)
Requires:      a *fresh, DB-backed* session (sensitiveSessionMiddleware —
               a stale cookie-cache payload cannot authorize this); password
               verified under the same passwordless rule as enable
Ensures:       TwoFactor row deleted; twoFactorEnabled -> false; session
               rotated; trust-device cookie (if any) is expired and its
               server-side verification record is revoked
On violation:  BAD_REQUEST INVALID_PASSWORD. Blamed party: CLIENT.
```

```
Operation:     verify-totp / verify-otp / verify-backup-code
Requires:      a resolvable challenge: either a valid signed "two_factor"
               cookie + live verification row (sign-in path), or an
               already-authenticated session (re-verification / TOTP
               enrollment-completion path — the latter is how a fresh TOTP
               enrollment transitions PENDING_VERIFICATION -> ENROLLED,
               §2); the relevant factor must be enrolled
               (TOTP row exists / OTP configured / backup codes exist);
               account must not be locked (§4, sign-in path only)
Ensures:       on a correct code — the challenge and (for OTP/backup-code)
               the single-use verification record are atomically consumed,
               exactly one session is created, account-lockout counters
               reset, and — for TOTP specifically — a still-unverified row
               is marked verified and, if this is the very first
               enrollment, twoFactorEnabled flips true. On an incorrect
               code — attempt counters increment (both the per-challenge
               budget and, if applicable, the account-level counter); once
               the per-challenge budget is exhausted the whole challenge is
               cancelled (client must restart credential sign-in from
               scratch, not just retry the second factor).
Invariant:     a given TOTP code, OTP code, or backup code can mint at most
               one session, even under concurrent submission (race gate is
               the atomic consume, not a client-visible check)
On violation:  UNAUTHORIZED INVALID_CODE / INVALID_BACKUP_CODE;
               BAD_REQUEST OTP_HAS_EXPIRED / TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE
               / TOTP_NOT_ENABLED / BACKUP_CODES_NOT_ENABLED;
               429 ACCOUNT_TEMPORARILY_LOCKED. Blamed party: CLIENT
               (wrong/expired/reused code) except ACCOUNT_TEMPORARILY_LOCKED,
               which is still CLIENT-caused but SUPPLIER-enforced policy.
```

```
Operation:     send-otp (POST /two-factor/send-otp) — OTP factor only
Requires:      otpOptions.sendOTP configured; a resolvable challenge or
               session (via the same verifyTwoFactor gate)
Ensures:       a fresh OTP is generated, stored per storeOTP policy with an
               embedded attempt counter (`value:0`), and handed to the
               caller-supplied sendOTP(user, otp, ctx) callback — a
               HIGHER-ORDER, fire-and-forget contract: domain =
               {user, otp} × ctx, range = Awaitable<void>. The endpoint's
               own postcondition (a verified, storable OTP now exists) is
               satisfied the instant the record is created — it does NOT
               depend on sendOTP resolving successfully. A rejected/thrown
               sendOTP promise is caught and logged, never surfaced to the
               caller (this is documented as intentional, to avoid a
               user-enumeration timing side-channel).
On violation:  BAD_REQUEST OTP_NOT_CONFIGURED if sendOTP absent. Blamed
               party for a delivery failure specifically: SUPPLIER (the
               integrator's sendOTP implementation) — but this is NOT a
               plugin contract violation, since delivery success was never
               part of the postcondition.
```

```
Operation:     generate-backup-codes (POST /two-factor/generate-backup-codes)
Requires:      authenticated session; twoFactorEnabled = true; password
               verified under the passwordless rule
Ensures:       the entire backup-code set is replaced (old codes are
               wholesale invalidated, not merged) and the new plaintext set
               is returned exactly once
```

```
Operation:     viewBackupCodes  — server-only, no HTTP surface, no client
               method
Requires:      trusted server-side caller; a userId from an already
               authenticated context (this operation does its own
               authorization by construction — the contract's precondition
               is "caller is trusted server code", not "caller is a
               browser")
Ensures:       returns the plaintext backup-code array for that user
On violation:  BAD_REQUEST BACKUP_CODES_NOT_ENABLED / INVALID_BACKUP_CODE
               (decode failure). Blamed party: SUPPLIER (whoever calls this
               from server code is responsible for its own authorization —
               there is no client-facing precondition to violate).
```

---

## 6. Configuration-driven behavior variants

| Option | Default | Effect |
|---|---|---|
| `totpOptions.digits` | 6 | 6 or 8-digit TOTP codes |
| `totpOptions.period` | 30s | TOTP step window |
| `totpOptions.issuer` | app name | Label in the `totpURI` |
| `totpOptions.disable` | false | TOTP factor entirely unavailable (enable/verify/getTOTPURI all reject) |
| `totpOptions.allowPasswordless` | plugin-level `allowPasswordless` | Skip password check for TOTP-only ops if no credential account |
| `otpOptions.period` | 3 min | OTP validity window |
| `otpOptions.digits` | 6 | OTP code length |
| `otpOptions.allowedAttempts` | 5 | Per-OTP-record attempt budget before it locks (stays consumed) |
| `otpOptions.storeOTP` | "plain" | plain / hashed / encrypted / custom hash / custom encrypt-decrypt at rest |
| `otpOptions.sendOTP` | — (required to enable OTP factor at all) | Higher-order delivery callback |
| `backupCodeOptions.amount` | 10 | Codes generated per (re)generation |
| `backupCodeOptions.length` | 10 | Characters per code (formatted `XXXXX-XXXXX`) |
| `backupCodeOptions.storeBackupCodes` | "encrypted" (two-factor level default; "plain" is the *sub-module* default if used standalone) | at-rest encoding |
| `backupCodeOptions.customBackupCodesGenerate` | — | Full override of code generation |
| `skipVerificationOnEnable` | false | Skips PENDING_VERIFICATION entirely for TOTP |
| `allowPasswordless` | false | Plugin-wide default for all sub-options above |
| `twoFactorCookieMaxAge` | 600s | Window to complete a pending challenge |
| `trustDeviceMaxAge` | 30 days | Trusted-device sliding window |
| `accountLockout.enabled` | true | Toggles §4 entirely |
| `accountLockout.maxFailedAttempts` | 10 | Cross-factor failure budget |
| `accountLockout.durationSeconds` | 900 | Lock duration |
| `twoFactorTable` | "twoFactor" | Custom table name |

**Cross-cutting:** the plugin installs its own rate limit — 3 requests / 10s
window — on every path under `/two-factor/*`, independent of any
rate-limiting or captcha plugin (see `07-captcha-and-haveibeenpwned.md` for
the general arrow-contract treatment of such cross-cutting policies).

---

## 7. Sequence: sign-in with a pending TOTP challenge

```
Client              Sign-in endpoint      2FA after-hook        verify-totp
  │  POST /sign-in/email  │                    │                    │
  ├───────────────────────►│                    │                    │
  │                        │ password OK,       │                    │
  │                        │ session created ────► twoFactorEnabled? │
  │                        │                    │  yes, no trust cky │
  │                        │                    │  delete session,   │
  │                        │◄── twoFactorRedirect: true, methods ────┤
  │  { twoFactorRedirect,  │    create challenge + attempt-counter    │
  │    twoFactorMethods }  │    verification rows, set "two_factor"   │
  │◄───────────────────────┤    signed cookie                        │
  │                                                                    │
  │  POST /two-factor/verify-totp {code}                              │
  ├────────────────────────────────────────────────────────────────► │
  │                                             beginAttempt(): atomic │
  │                                             consume of counter row │
  │                                             code verified against  │
  │                                             decrypted TOTP secret  │
  │                                             consume challenge row, │
  │                                             create session, expire │
  │                                             "two_factor" cookie    │
  │◄──────────────────────── { token, user } ──────────────────────── │
```
