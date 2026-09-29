# Slice 07-password-mfa — validation & fix plan

- **Validated at:** `ec065a7` (HEAD) on 2026-09-29
- **Manifest:** `.plan/_manifests/07-password-mfa.tsv` — 54 issues (packages/password, packages/two-factor, packages/magic-link)

| Verdict | high | medium | low | info | total |
|---|---|---|---|---|---|
| CONFIRMED | 6 | 12 | 6 | 0 | 24 |
| PARTIAL | 1 | 4 | 0 | 0 | 5 |
| ALREADY-FIXED | 0 | 6 | 4 | 0 | 10 |
| INVALID | 0 | 0 | 0 | 0 | 0 |
| DUPLICATE | 0 | 4 | 4 | 6 | 14 |
| WONTFIX-CANDIDATE | 0 | 1 | 0 | 0 | 1 |
| **total** | 7 | 27 | 14 | 6 | 54 |

**Summary.** The password plugin has moved a long way since the 2026-09-19 audit: per-IP rate limits resolved through the trusted-proxy-aware `ClientAddress` port, forked reset/resend mail, a transaction around confirmReset, HIBP status checking, verify-email throttling, change-password session rotation and CSRF on every mutating route all landed (10 findings are ALREADY-FIXED, several more PARTIAL). What remains in password is a cluster of correctness edges in the recovery path (cross-purpose tokens → 500, credential-less resets → 500, weak password still burns the token outside SQL, reset doesn't verify email), a registry/enforcement rate-limit drift with secret-bearing keys and `as` casts, the unowned `forkDetach(...).pipe(Effect.ignore)` mail fibers, missing request metadata/assurance signals on sessions, no native bearer delivery (ticket 17) and no spans (ticket 27). The big-ticket item is that `two-factor` and `magic-link` are still `export {}`: wayfinder ticket 05 is resolved, and this plan decomposes it into a TwoFactor build (12 steps), a `BeforeCredentialReset` gate, and MagicLink + EmailOtp plugins. Two reconciliations with HEAD (not re-litigations): ticket 05's proposed `SecretBox` port already exists as `@awthaq/ports` `Encryption`, and HookPoint tap registries freeze after first run, so TwoFactor's taps must be opt-in layers — made fail-closed by a type-level marker that `TwoFactor.layer` requires.

## Workstreams

### confirmReset/requestReset correctness (`password-recovery-correctness`)

- **IDs:** ARF-002, APS-004, ARF-007, ARF-004, ARF-008, TMS-008, APS-005, CSD-008
- **Order hint:** 1 · **Effort:** M · **Depends on workstreams:** —
- **Why grouped:** Small, independent fixes to the same two functions; land before ARF-005 adds a hook inside confirmReset.

**Ordered steps**

1. ARF-007 prefix validation
2. ARF-002 policy before consume
3. ARF-004 credential-less accounts
4. ARF-008 reset verifies email

**Test plan:** Red-first unit tests in packages/password/test/Password.test.ts per issue; BDD 15-password.feature scenario for reset-then-sign-in of an unverified account.

**Acceptance**

- No 500 reachable from confirmReset
- Weak password never burns a token
- Unverified user can sign in after reset

### Single-source, secret-free, normalized password rate-limit rules (`password-rate-limit-hardening`)

- **IDs:** RBS-006, ESS-005, CSD-006, MLO-003, TMS-006, ARF-010, AGA-007, RBS-002, TMS-010
- **Order hint:** 1 · **Effort:** M · **Depends on workstreams:** —
- **Why grouped:** All touch RATE_LIMITS + the registry list; RBS-006's single-definition refactor makes the others one-liners and gives TwoFactor/MagicLink a reusable pattern.

**Ordered steps**

1. RBS-006 rule(...) helper feeding registry + enforcement (removes ESS-005 casts)
2. CSD-006 comment rewrite
3. MLO-003 resendVerificationByIp
4. TMS-006 subaddress-normalized email keys

**Test plan:** Registry/enforcement equality test; per-IP resend test; alias-bucket test.

**Acceptance**

- registered() == enforced keys, no secrets in keys, zero `as` casts
- resendVerification has a per-source bound

### Owned, observable, retrying mail dispatch; hardened Mailer contract (`mail-delivery-reliability`)

- **IDs:** ERS-002, MA-010, MLO-007, EOTS-010, ARF-003
- **Order hint:** 2 · **Effort:** M · **Depends on workstreams:** verification-token-delivery
- **Why grouped:** Every plugin that mails tokens (password now; magic-link/email-otp/two-factor/admin next) needs the same dispatcher; Mailer contract change is shared (slice 09 port).

**Ordered steps**

1. Mailer.send typed failure + never-log doc + layerNoop PII fix
2. core MailDispatcher (FiberSet, retry, Semaphore, drain, auth.mail.failed)
3. Replace 3 forkDetach sites
4. Redacted token in mail data

**Test plan:** TestClock retry tests, scope-close drain test, existing non-blocking tests stay green.

**Acceptance**

- No forkDetach in plugins
- Mail loss observable
- No PII/token in defects

### Shared token codec + link data (opaque ids, expiresAt, urls) (`verification-token-delivery`)

- **IDs:** MLO-009, ARF-009
- **Order hint:** 2 · **Effort:** M · **Depends on workstreams:** password-recovery-correctness
- **Why grouped:** Password and all M7 plugins mail Verification tokens; one purpose-checked codec avoids repeating ARF-007/ARF-009 bugs.

**Ordered steps**

1. VerificationLink module
2. opaque publicId identifiers + userId from consumed row
3. PasswordConfig.links + mail data {url, token, expiresAt}

**Test plan:** Codec unit tests; password mail-data tests; existing reset/verify tests unchanged.

**Acceptance**

- No userId in any mailed token
- Mail data has expiresAt

### Password contract hygiene (routes, sub-groups, schemas) (`password-api-contract-hygiene`)

- **IDs:** AVS-004, EHA-007, ESS-006, CDS-003, AR-002
- **Order hint:** 2 · **Effort:** S · **Depends on workstreams:** —
- **Why grouped:** Contract-shape fixes on PasswordApi/Auth.make that new M7 contracts must also follow.

**Ordered steps**

1. Auth.make RouteConflict
2. password.account sub-group
3. shared Email schema + password max length

**Test plan:** Composition conflict test; group middleware walk test; schema tests.

**Acceptance**

- Route conflicts fail at composition
- Convention-consistent groups
- Malformed emails rejected at decode

### Password policy defaults and enumeration posture (`password-policy-posture`)

- **IDs:** PHS-004, PHS-006, TMS-005, TSS-007, FAMS-003, RBS-005
- **Order hint:** 2 · **Effort:** M · **Depends on workstreams:** mail-delivery-reliability
- **Why grouped:** Policy/default decisions on the password plugin; two need a product call.

**Ordered steps**

1. PHS-004 body validation + timeout
2. FAMS-003 requireVerifiedEmail knob
3. PHS-006 default (after decision)
4. TMS-005 enumeration posture (after decision)

**Test plan:** Breach-check body/timeout tests; gate knob tests; conceal-mode uniformity test if C chosen.

**Acceptance**

- Breach check never hangs or silently passes garbage
- Defaults recorded in spec

### Request metadata + assurance signals on issued sessions (`session-issuance-context`)

- **IDs:** CSD-003, SMS-004, APS-007
- **Order hint:** 3 · **Effort:** L · **Depends on workstreams:** —
- **Why grouped:** Same call sites (every sessions.issue) and same schema surface (sessions row / SessionView / UserPrincipal); cross-slice with 01-core, 03-oauth, 10-passkey.

**Ordered steps**

1. Thread ip/userAgent at all issue sites
2. amr column + SessionView/UserPrincipal.amr
3. PrincipalResolver.layerWithUserFacts (emailVerified)

**Test plan:** HTTP test for userAgent on session list; memory+SQL amr round-trip; resolver test.

**Acceptance**

- Device list populated
- amr and (opt-in) emailVerified on the principal

### Opt-in bearer token delivery for native clients (ticket 17) (`native-token-delivery`)

- **IDs:** MNA-001
- **Order hint:** 3 · **Effort:** M · **Depends on workstreams:** —
- **Why grouped:** Ticket 17 decision; shared helper must exist before TwoFactor/MagicLink handlers are written.

**Ordered steps**

1. SessionDto.token + header constant
2. deliverIssuedSession helper
3. password handlers (+ passkey in slice 10)
4. docs

**Test plan:** AuthHttp tests for both modes + bearer auth round-trip.

**Acceptance**

- Native client can bootstrap a session without cookies

### Business-logic spans for auth operations (ticket 27 §2) (`auth-operation-tracing`)

- **IDs:** EOTS-001
- **Order hint:** 3 · **Effort:** M · **Depends on workstreams:** —
- **Why grouped:** Password instance of ticket 27's span plan (MW-001, slice 13 owns the substrate/ADR).

**Ordered steps**

1. core Observability.authSpan helper
2. wrap Password ops
3. wrap Sessions/OAuth/Passkey (cross-slice)

**Test plan:** In-memory tracer assertions incl. no-secret attributes.

**Acceptance**

- Named spans with documented attributes for every password op

### TwoFactor plugin (TOTP + recovery codes) and second-factor-aware recovery (`mfa-two-factor`)

- **IDs:** THS-001, AOMS-003, ARF-005, CSD-005, ACS-010, BCR-001, ECF-009, TTE-008
- **Order hint:** 4 · **Effort:** XL · **Depends on workstreams:** password-rate-limit-hardening, password-recovery-correctness, mail-delivery-reliability, verification-token-delivery, session-issuance-context
- **Why grouped:** All members trace to the empty two-factor package; wayfinder ticket 05 §1-§2 is the governing decision.

**Ordered steps**

1. 1 Totp.ts + RFC vectors (THS-001 s1) — no deps, can start immediately
2. 2 Reuse ports Encryption for secrets (s2); stores + migrations (s3); config (s4)
3. 3 Branded challenge over Verification (s5, TTE-008) and TwoFactor service enable/confirm/verify/verifyRecovery/disable/regenerate (s6-s8)
4. 4 Opt-in tap layers sessionGate / credentialResetGate / beforeUserDeleteErasure + type-level marker so the gate can't be forgotten (s9)
5. 5 Contract twoFactor + twoFactor.account (s10); events + audit + rate-limit registry (s11)
6. 6 BeforeCredentialReset hook + confirmReset integration + impersonation owner notice (ARF-005)
7. 7 amr on 2FA sessions + Auth0 migration doc (AOMS-003, after APS-007)
8. 8 Spec 28-two-factor.md, BDD feature, README (s12)

**Test plan:** Unit (Totp vectors, service flows, SQL store races), type tests (branded challenge, missing gate), HTTP tests (divert → verify), BDD 28-two-factor.feature, mutation-check that removing sessionGate breaks the divert test.

**Acceptance**

- Enrolled users cannot obtain a session from any first factor without TOTP/recovery code
- Reset of an enrolled account requires the second factor
- No plaintext TOTP secret/recovery code at rest
- pnpm check + spec:verify:strict green

### MagicLink + EmailOtp plugins on the Verification substrate (`passwordless-magic-link-email-otp`)

- **IDs:** BAM-007, SOS-001, MLO-005, FAMS-007, IC-009, SAM-009
- **Order hint:** 5 · **Effort:** XL · **Depends on workstreams:** verification-token-delivery, mail-delivery-reliability, password-rate-limit-hardening, mfa-two-factor
- **Why grouped:** Ticket 05 §2/§3: ship magic-link now (ARF-005 Fix A) and the EmailOtp channel substrate; SMS deferred; api-key → slice 09.

**Ordered steps**

1. 1 Verification numeric-code format (SOS-001 step 1, core)
2. 2 MagicLink plugin + POST-only contract + BeforeSessionIssue (BAM-007)
3. 3 EmailOtp plugin with attempt budget + resend window (SOS-001)
4. 4 Spec 29/30 behavior files, BDD, READMEs; SMS deferral note

**Test plan:** Plugin unit tests (uniform 202, single-use, divert, sign-up policy), HTTP test asserting no GET consumption route, BDD features.

**Acceptance**

- Passwordless sign-in works via link and via 6-digit code
- 2FA-enrolled users are diverted
- Mailed artifacts are prefetch-safe and carry expiresAt

## Decisions needed

### PHS-006 — Breach screening fully implemented but disabled by default

- A: keep `breachCheck: false`; document the OWASP/NIST rationale and the one-line opt-in prominently (README quickstart + BEH-EA-119).
- B: default `breachCheck: true` (fail-open) with PHS-004's timeout, so screening is on unless declined; document how to disable for air-gapped deployments.
- C: default on only when `NODE_ENV=production`-style config says so — rejected: environment-dependent security defaults are surprising.

**Recommendation:** B — NIST SP 800-63B §3.1.1.2 makes screening against compromised-password lists a SHALL; k-anonymity leaks only a 5-char SHA-1 prefix; fail-open + timeout keeps availability. Richer secure default wins; opting out stays one line.

### TMS-005 — signUp responds EmailAlreadyExists — account enumeration inconsistent with the plugin's own anti-enumeration posture

- A: keep 409 EmailAlreadyExists; add ADR 017 recording it as the deliberate exception to BEH-EA-086 with signUp/signUpByIp rate limits as compensating controls.
- B: always conceal — signUp returns 202 'check your email' for both branches; existing address gets an 'you already have an account' mail; session only after verification.
- C: config `signUpEnumeration: "reveal" | "conceal"` (default reveal) implementing both A's documentation and B's flow.

**Recommendation:** C — flexibility over complexity: most apps want reveal UX, security-sensitive ones need conceal; the conceal branch reuses the mail dispatcher and Verification already present. Document the default in an ADR either way.

### Flagged by ticket 05 for sanity-check (non-blocking; work proceeds on the recommendation)

- **SMS OTP (SOS-001/SAM-009):** ship the EmailOtp substrate now; SMS later as a separate, explicitly degraded plugin, never an account's sole factor, emitting `factor.sms.used`. *Recommendation: accept.*
- **Passkey-only zero-factor recovery (ARF-005):** leave self-service recovery of an account with no remaining factor to the application; ship only the impersonation owner-notification. *Recommendation: accept.*

### Implementation notes (resolved here, no user input needed)

- **SecretBox → Encryption.** Ticket 05 assumed no at-rest AEAD port existed; `packages/ports/src/Encryption.ts` (AES-256-GCM over `KeyProvider`, with AAD) now does. TwoFactor uses it with `aad = two_factor_secret:<userId>`; no new port.
- **Fail-closed tap composition.** Because tap registries freeze (Passkey.ts:1018), TwoFactor's taps are separate layers; `TwoFactor.layer` requires a `TwoFactorGateInstalled` marker provided only by `TwoFactor.sessionGate`, so forgetting the gate is a compile error. A per-runtime (non-module-singleton) hook registry would remove the need for the marker. That belongs to slice 02 and is suggested, not required.
- **Challenge retry UX.** Ticket 05 says to consume the challenge before checking the code. The plan keeps that and adds retries by issuing a fresh challenge (attempt+1) on a wrong code, up to `maxAttemptsPerChallenge`. It also adds a per-user verify budget.
- **EmailOtp packaging.** The plan puts it in `@awthaq/magic-link` as a second plugin class that shares the channel-credential module. spec/models/05 leaves "one plugin or two" open. Two classes in one package keeps both independently composable without adding a package.
- **Native CSRF (MNA-001).** Ticket 17 did not address CSRF for native clients. The plan keeps CsrfProtection unchanged and documents the cookie-bootstrap flow. Exempting requests that carry `X-Awthaq-Token-Delivery` is possible later as a separate decision owned by the CSRF slice.

## Per-issue dossiers

### Workstream `password-recovery-correctness`

#### APS-004 — confirmReset consumes the reset token before validating the new password

`medium` · `correctness` · `password` · [.issues/medium/APS-004-auth-pentest-specialist.md](../../.issues/medium/APS-004-auth-pentest-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **ARF-002**

Identical root cause and identical recommended fix (policy check before consume) as ARF-002; partially mitigated on SQL by 34caae8.

**Evidence at HEAD**

- `packages/password/src/Password.ts:986` — Policy (incl. HIBP network call) still runs AFTER consume, inside the open DB transaction.

```ts
yield* verification.consume(identifier, value).pipe(
  Effect.catchTag("TokenConsumed", () => new PasswordApi.TokenConsumed()),
  Effect.catchTag("PlatformError", Effect.die),
);

const hints = yield* checkPolicy(httpClient, crypto, input.password, config);
if (hints.length > 0) {
  return yield* Effect.fail(new PasswordApi.WeakPassword({ hints }));
```

**Recommended status:** `resolved`

#### APS-005 — changePassword never revokes existing sessions nor emits an audit event

`medium` · `security` · `password` · [.issues/medium/APS-005-auth-pentest-specialist.md](../../.issues/medium/APS-005-auth-pentest-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed by `2761e8d`

changePassword now revokes every other session and supersedes the caller's own (2761e8d, BEH-EA-053) and publishes auth.password.changed + auth.session.revoked (45325bb).

**Evidence at HEAD**

- `packages/password/src/Password.ts:1130` — Event added by 45325bb (ALF-004).

```ts
yield* events.publish({ _tag: "auth.password.changed", userId: input.userId });
```

- `packages/password/src/Password.ts:1137` — Other sessions revoked + current rotated (2761e8d); test Password.test.ts:848.

```ts
yield* sessions.revokeOthers(input.userId, input.currentSessionId);
```

**Recommended status:** `resolved`

#### ARF-002 — WeakPassword is checked after the reset token is consumed — a policy mistake burns the single-use token

`medium` · `correctness` · `password` · [.issues/medium/ARF-002-account-recovery-flow-specialist.md](../../.issues/medium/ARF-002-account-recovery-flow-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high) · fixed by `34caae8` · canonical for APS-004

PARTIAL: commit 34caae8 (ARF-001) wrapped consume+policy+update+revokeAll in SqlTransaction, so on a SQL deployment WeakPassword rolls the consume back. Still broken: (a) any composition whose Verification/SqlTransaction are not the same SQL client (SqlTransaction.layerNoop, memory Verification — including the shipped test composition) still burns the token; (b) the HIBP breach check (network I/O) runs while a DB transaction is held open; (c) no test asserts the token survives a WeakPassword. The finding's own recommended fix (policy before consume) is store-independent and removes (b).

**Evidence at HEAD**

- `packages/password/src/Password.ts:986` — Policy (incl. HIBP network call) still runs AFTER consume, inside the open DB transaction.

```ts
yield* verification.consume(identifier, value).pipe(
  Effect.catchTag("TokenConsumed", () => new PasswordApi.TokenConsumed()),
  Effect.catchTag("PlatformError", Effect.die),
);

const hints = yield* checkPolicy(httpClient, crypto, input.password, config);
if (hints.length > 0) {
  return yield* Effect.fail(new PasswordApi.WeakPassword({ hints }));
```

- `packages/password/test/Password.test.ts:137` — With layerNoop/memory Verification the WeakPassword path still burns the token; no test covers the rollback.

```ts
// ARF-001: `confirmReset` now runs inside a `SqlTransaction` — a no-op
// wrapper for this in-memory composition.
Layer.provide(SqlTransaction.layerNoop),
```

**Fix plan** — Evaluate the password policy before opening the transaction / consuming the token.

1. Password.ts confirmReset: after decode (+ prefix check, ARF-007) and the rate limit, call `checkPolicy(httpClient, crypto, input.password, config)` and fail `WeakPassword` BEFORE `sqlTransaction.withTransaction(...)`; delete the in-transaction policy block (Password.ts:991-994).
2. Update the ARF-001 comment (Password.ts:971-982) to describe the new ordering.

*Files:* `packages/password/src/Password.ts`

*Tests (write first):*

- packages/password/test/Password.test.ts — FIRST (red today with the memory composition): 'confirmReset with a weak password fails WeakPassword and the same token still resets with a strong password'.
- Same test under breachCheck {onUnavailable:"reject"} + failing HttpClient: token survives.

*Acceptance:*

- A WeakPassword (or breach-check-unavailable reject) never consumes the reset token under any store; no network call happens inside the DB transaction.

*Spec refs:* BEH-EA-117, BEH-EA-120, BEH-EA-058, INV-EA-009 · *Effort:* S · *Depends on:* —

**Recommended status:** `ready-for-agent`

#### ARF-004 — requestReset issues tokens for accounts with no password credential; confirmReset then dies with a 500

`medium` · `correctness` · `password` · [.issues/medium/ARF-004-account-recovery-flow-specialist.md](../../.issues/medium/ARF-004-account-recovery-flow-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

requestReset still mails a reset token to any existing user; confirmReset dies with a 500 when that user has no password account (OAuth-only/passkey-only), so the mailed link is a lie.

**Evidence at HEAD**

- `packages/password/src/Password.ts:1005` — Reachable for OAuth-/passkey-only users.

```ts
onNone: () =>
  Effect.die(
    new Error(`awthaq: password credential missing for user ${userId}`),
  ),
```

- `packages/password/src/Password.ts:903` — requestReset never checks for a password credential.

```ts
if (Option.isSome(userOpt)) {
  const user = userOpt.value;
  yield* Effect.forkDetach(
    Effect.gen(function* () {
      const identifier = `${RESET_PREFIX}${user.id}`;
```

**Fix plan** — Skip reset issuance for credential-less accounts (inside the forked fiber, preserving uniform latency) and map the missing-credential case to TokenConsumed defensively.

1. Password.ts requestReset: inside the forked fiber (NOT before the fork — keeps the TSS-001 uniform-latency property), look up `accounts.findByProviderSubject(PASSWORD_PROVIDER_ID, user.id)`; when none, send template `reset-password-unavailable` (tells the user which sign-in methods to use; no token) instead of issuing a reset token.
2. confirmReset: `onNone` → `Effect.fail(new PasswordApi.TokenConsumed())` instead of `Effect.die` (defense in depth for tokens issued before this change); remove the misleading 'defect' comment (Password.ts:1001-1004).

*Files:* `packages/password/src/Password.ts`

*Tests (write first):*

- packages/password/test/Password.test.ts — FIRST: 'requestReset for an account without a password credential answers 202 and mails reset-password-unavailable with no token'; 'confirmReset for a credential-less user fails TokenConsumed, not a defect'.

*Acceptance:*

- No 500 is reachable from confirmReset for a credential-less account; such users get a truthful mail.

*Spec refs:* BEH-EA-064, BEH-EA-117 · *Effort:* S · *Depends on:* —

**Recommended status:** `ready-for-agent`

#### CSD-008 — Password change does not revoke other sessions — attacker-held sessions survive credential rotation

`medium` · `security` · `password` · [.issues/medium/CSD-008-credential-stuffing-defense-specialist.md](../../.issues/medium/CSD-008-credential-stuffing-defense-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed by `2761e8d`

Same fix as APS-005 (2761e8d).

**Evidence at HEAD**

- `packages/password/src/Password.ts:1137`

```ts
yield* sessions.revokeOthers(input.userId, input.currentSessionId);
```

**Recommended status:** `resolved`

#### ARF-007 — confirmReset slices the token identifier without validating its prefix, turning a valid verify-email token into a 500

`low` · `correctness` · `password` · [.issues/low/ARF-007-account-recovery-flow-specialist.md](../../.issues/low/ARF-007-account-recovery-flow-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

A valid `verify-email:<id>.<secret>` token presented to /password/confirm-reset is consumed, then sliced at offset 15 into a garbage userId → the missing-credential Effect.die → 500 (on SQL the transaction rolls back the consume, but the response is still a 500). Same in verifyEmail with a reset token.

**Evidence at HEAD**

- `packages/password/src/Password.ts:968` — No startsWith(RESET_PREFIX) check; verifyEmail mirrors it at Password.ts:1057.

```ts
yield* rateLimit(`password:reset-confirm:${identifier}`, RATE_LIMITS.confirmReset);
const userId = Users.UserId(identifier.slice(RESET_PREFIX.length));
```

**Fix plan** — Validate the purpose prefix right after decode in confirmReset and verifyEmail.

1. Password.ts confirmReset: after `decodeVerificationToken`, `if (!identifier.startsWith(RESET_PREFIX)) return yield* Effect.fail(new PasswordApi.TokenConsumed())` before the rate limit and consume; same with VERIFY_PREFIX in verifyEmail. (Superseded structurally by MLO-009's VerificationLink.decode(raw, purpose), but land this S fix first.)

*Files:* `packages/password/src/Password.ts`

*Tests (write first):*

- packages/password/test/Password.test.ts — FIRST: 'a verify-email token presented to confirmReset fails TokenConsumed (410) and remains usable for verifyEmail'; mirror for a reset token at verifyEmail.

*Acceptance:*

- Cross-purpose tokens get 410 TokenConsumed, never a 500, and are not consumed.

*Spec refs:* BEH-EA-057, BEH-EA-059, BEH-EA-118 · *Effort:* S · *Depends on:* —

**Recommended status:** `ready-for-agent`

#### ARF-008 — Reset works for unverified accounts (good) but completing a reset neither confers nor requires verification, leaving the account still locked

`low` · `dx` · `password` · [.issues/low/ARF-008-account-recovery-flow-specialist.md](../../.issues/low/ARF-008-account-recovery-flow-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Reset proves mailbox control (the same evidence verifyEmail requires) but confirmReset discards it; an unverified user completes a reset and is still refused at signIn.

**Evidence at HEAD**

- `packages/password/src/Password.ts:841`

```ts
if (!user.emailVerified) {
  yield* events.publish({
    _tag: "auth.user.signInFailed",
    strategy: "password",
    reason: "emailNotVerified",
  });
  return yield* Effect.fail(new PasswordApi.EmailNotVerified());
}
```

- `packages/password/src/Password.ts:1013` — confirmReset never flips emailVerified.

```ts
const hash = yield* hasher.hash(input.password);
yield* accounts
  .updateCredentialHash(account.id, Redacted.make(hash))
  .pipe(Effect.orDie);
```

**Fix plan** — Treat a consumed reset token as email verification.

1. Password.ts confirmReset: inside the transaction after `updateCredentialHash`, call `users.verifyEmail(userId)` (idempotent; map `UserNotFound` → die as verifyEmail does).

*Files:* `packages/password/src/Password.ts`; `spec/behaviors/15-password.md`

*Tests (write first):*

- packages/password/test/Password.test.ts — FIRST: 'an unverified user who completes confirmReset can then signIn'.

*Acceptance:*

- After a successful reset the account's emailVerified is true; BEH-EA-117 text states it.

*Spec refs:* BEH-EA-117, BEH-EA-114 · *Effort:* S · *Depends on:* —

**Recommended status:** `ready-for-agent`

#### TMS-008 — confirmReset consumes the token outside any transaction — INV-EA-009's in-transaction requirement unmet by its flagship caller

`low` · `docs` · `password` · [.issues/low/TMS-008-threat-modeling-specialist.md](../../.issues/low/TMS-008-threat-modeling-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed by `34caae8`

Commit 34caae8 (ARF-001/RRC-002) wraps confirmReset's consume, credential update and revokeAll in SqlTransaction.withTransaction, satisfying INV-EA-009 on SQL deployments. The policy-ordering residual is ARF-002.

**Evidence at HEAD**

- `packages/password/src/Password.ts:986` — Policy (incl. HIBP network call) still runs AFTER consume, inside the open DB transaction.

```ts
yield* verification.consume(identifier, value).pipe(
  Effect.catchTag("TokenConsumed", () => new PasswordApi.TokenConsumed()),
  Effect.catchTag("PlatformError", Effect.die),
);

const hints = yield* checkPolicy(httpClient, crypto, input.password, config);
if (hints.length > 0) {
  return yield* Effect.fail(new PasswordApi.WeakPassword({ hints }));
```

- `packages/password/src/Password.ts:1024` — consume + updateCredentialHash + revokeAll run in one sqlTransaction.withTransaction.

```ts
yield* sessions.revokeAll(userId);
}),
)
.pipe(Effect.catchTag("SqlError", Effect.die));
```

**Recommended status:** `resolved`

### Workstream `password-rate-limit-hardening`

#### CSD-006 — Stale comment claims no client-IP mechanism exists, documenting away the missing IP dimension

`medium` · `architecture` · `password` · [.issues/medium/CSD-006-credential-stuffing-defense-specialist.md](../../.issues/medium/CSD-006-credential-stuffing-defense-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

The IP dimension was built (349e220, a3b7255) but the RATE_LIMITS doc comment still claims it does not exist — actively misleading.

**Evidence at HEAD**

- `packages/password/src/Password.ts:210` — Now false in the same file: signInByIp/signUpByIp/requestResetByIp/verifyEmailByIp (:224-259) via ClientAddress (a3b7255).

```ts
 * `signin:${email}` example for `signIn`'s numbers exactly. Every rule
 * here keys on identity/email, never IP: this codebase has no client-IP-
 * extraction mechanism anywhere yet (no handler threads a request's
 * origin into a domain capability today), and building one speculatively
```

**Fix plan** — Rewrite the RATE_LIMITS header comment.

1. Password.ts:206-218: describe the two-dimension scheme — identity-keyed budgets (brute-force per account) + per-source budgets resolved through the application-provided `ClientAddress` port (layerDirect / layerTrustedProxy), and that `unknown` IPs share one bucket.

*Files:* `packages/password/src/Password.ts`

*Tests (write first):*

- None (comment-only); `pnpm lint` passes.

*Acceptance:*

- No comment in Password.ts claims IP extraction is missing.

*Spec refs:* BEH-EA-108 · *Effort:* S · *Depends on:* —

**Recommended status:** `ready-for-agent`

#### ESS-005 — Rate-limit key derivation uses bare casts 60 lines after the same file forbids them

`medium` · `dx` · `password` · [.issues/medium/ESS-005-effect-schema-specialist.md](../../.issues/medium/ESS-005-effect-schema-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Casts still present at HEAD; violates the repo's hard no-type-assertion rule.

**Evidence at HEAD**

- `packages/password/src/Password.ts:571` — Also Password.ts:583 and :599 — three `as` casts 380 lines after the file's own no-cast note (:187-198).

```ts
key: (input) => `password:signup:${(input as { readonly email: string }).email}`,
```

- `packages/password/src/Password.ts:195` — The safe helper exists but is used only by resendVerification.

```ts
const emailFromRateLimitInput = (input: unknown): string =>
  typeof input === "object" && input !== null && "email" in input && typeof input.email === "string"
    ? input.email
    : "";
```

**Fix plan** — Remove the three casts — delivered by RBS-006's single-source rule definitions (schema-decoded registry keys).

1. If RBS-006 is sequenced later, interim S fix: replace the three casts with `emailFromRateLimitInput(input).toLowerCase()`.
2. Add an oxlint/grep guard in `pnpm lint` for ` as {` in packages/*/src (repo-tooling slice may own the generic rule).

*Files:* `packages/password/src/Password.ts`

*Tests (write first):*

- Covered by RBS-006's registry/enforcement equality test.

*Acceptance:*

- `grep -n ' as ' packages/password/src/Password.ts` returns only `as const`.

*Spec refs:* BEH-EA-107 · *Effort:* S · *Depends on:* —

**Recommended status:** `ready-for-agent`

#### MLO-003 — All email-flow rate limits key on email alone; no IP or dual keying, so mailbox flooding is bounded only per-victim

`medium` · `security` · `password` · [.issues/medium/MLO-003-magic-link-email-otp-specialist.md](../../.issues/medium/MLO-003-magic-link-email-otp-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high) · fixed by `a3b7255`

PARTIAL: requestReset gained a per-IP rule (a3b7255) and signUp too; resendVerification is still keyed on email alone, so one source can rotate across victims' addresses at 3 mails/15 min each without any per-source ceiling.

**Evidence at HEAD**

- `packages/password/src/Password.ts:923` — resendVerification: email-only, and its handler (Password.ts:433-439) never resolves ClientAddress.

```ts
const resendVerification: PasswordShape["resendVerification"] = Effect.fnUntraced(
  function* (input) {
    yield* rateLimit(
      `password:resend-verification:${input.email.toLowerCase()}`,
      RATE_LIMITS.resendVerification,
    );
```

- `packages/password/src/Password.ts:237` — requestReset now has a per-IP rule (a3b7255).

```ts
requestResetByIp: { limit: 30, window: Duration.minutes(15) },
```

**Fix plan** — Give resendVerification the same per-IP dimension.

1. PasswordShape.resendVerification input gains `ip?: string`; handler (Password.ts:433) resolves `clientAddress.resolve(request)` like requestReset.
2. RATE_LIMITS.resendVerificationByIp { limit: 20, window: 15 min }; enforce IP first, then email; register the rule (via RBS-006's single definition).

*Files:* `packages/password/src/Password.ts`; `packages/password/src/PasswordApi.ts`

*Tests (write first):*

- packages/password/test/Password.test.ts — FIRST: 'resendVerification is throttled per source IP across distinct emails' (mirror of the AGA-001 requestReset test at :1111).

*Acceptance:*

- One IP cannot request more than N verification mails per window across arbitrary addresses.

*Spec refs:* BEH-EA-108, BEH-EA-064 · *Effort:* S · *Depends on:* RBS-006

**Recommended status:** `ready-for-agent`

#### RBS-002 — verifyEmail is the only token-consuming endpoint with no rate limit

`medium` · `security` · `password` · [.issues/medium/RBS-002-rate-limiting-brute-force-specialist.md](../../.issues/medium/RBS-002-rate-limiting-brute-force-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed by `cbf899d`

Commit cbf899d (APS-003) added per-IP and per-identifier verifyEmail rules, registry entries and Api.RateLimited on the contract.

**Evidence at HEAD**

- `packages/password/src/PasswordApi.ts:204`

```ts
HttpApiEndpoint.post("verifyEmail", "/verify-email", {
  payload: VerifyEmailPayload,
  error: [TokenConsumed, Api.RateLimited],
}),
```

- `packages/password/src/Password.ts:256` — Enforced at Password.ts:1043 and :1056; tests :1156/:1208.

```ts
verifyEmail: { limit: 5, window: Duration.minutes(15) },
// Mirrors `signInByIp`/`requestResetByIp`: bounds one source spraying
// guesses across many distinct, unrelated tokens/accounts.
verifyEmailByIp: { limit: 30, window: Duration.minutes(15) },
```

**Recommended status:** `resolved`

#### RBS-006 — Registry metadata has already drifted from enforced keys (and two registered keys embed full request payloads)

`medium` · `correctness` · `password` · [.issues/medium/RBS-006-rate-limiting-brute-force-specialist.md](../../.issues/medium/RBS-006-rate-limiting-brute-force-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Registration (Password.ts:566-658) and enforcement (rateLimit calls) are still two hand-maintained lists; they disagree on case-folding and four registered keys JSON.stringify secret-bearing payloads.

**Evidence at HEAD**

- `packages/password/src/Password.ts:581` — Registered key: raw email + `as` cast; enforced key lowercases (Password.ts:800).

```ts
{
  endpoint: "signIn",
  key: (input) => `password:signin:${(input as { readonly email: string }).email}`,
  ...RATE_LIMITS.signIn,
},
```

- `packages/password/src/Password.ts:609` — JSON.stringify folds the reset token + new password into a key spec (also changePassword :621, reauthenticate :628, verifyEmail :641).

```ts
{
  endpoint: "confirmReset",
  // Keyed on the token's own decoded identifier at enforcement
  // time, not a payload field — this description is necessarily
  // approximate.
  key: (input) => `password:reset-confirm:${JSON.stringify(input)}`,
```

- `packages/password/src/Password.ts:800` — Enforced key differs from the registered one.

```ts
yield* rateLimit(`password:signin:${input.email.toLowerCase()}`, RATE_LIMITS.signIn);
```

**Fix plan** — Make one typed rule definition feed both the registry and enforcement; key functions never see secrets.

1. Password.ts: define `const rules = { signUpByEmail: rule("signUp", EmailInput, (i) => `password:signup:${emailKey(i.email)}`, RATE_LIMITS.signUp), … }` where `rule(endpoint, schema, key, limits)` returns `{ endpoint, limits, keyOf: (typed) => string, registryKey: (input: unknown) => string }` and `registryKey` narrows with `Schema.decodeUnknownOption(schema)` (no `as`; on mismatch returns `password:<endpoint>:unknown`).
2. Enforcement becomes `enforce(rules.signUpByEmail, input)` → `rateLimit(rule.keyOf(input), rule.limits)`; registration maps `Object.values(rules)` → `rateLimitsRegistry.register(Password, { group: "password", endpoint, key: registryKey, ...limits })`.
3. Secret-free key inputs: confirmReset/verifyEmail rules take `{ identifier }` (decoded pre-consume; after ARF-009, the publicId), changePassword/reauthenticate take `{ userId }` — never the payload.
4. Delete `emailFromRateLimitInput` once unused (ESS-005).

*Files:* `packages/password/src/Password.ts`; `packages/core/src/RateLimits.ts (only if a typed helper is lifted to core for OAuth/Passkey/TwoFactor reuse)`

*Tests (write first):*

- packages/password/test/Password.test.ts — FIRST: 'every registered password rule's key equals the key enforcement consumes for the same input (Alice@X.com)'; 'no registered key for confirmReset/changePassword contains the token or a password'.

*Acceptance:*

- RateLimitsRegistry.registered() reports exactly the keys enforced; no key contains secret material; zero `as` in Password.ts.

*Spec refs:* BEH-EA-107, BEH-EA-110, BEH-EA-111 · *Effort:* M · *Depends on:* —

**Recommended status:** `ready-for-agent`

#### TMS-006 — Signup spam and verification-mail bombing via subaddressed aliases — per-email rate keys normalize case only

`medium` · `security` · `password` · [.issues/medium/TMS-006-threat-modeling-specialist.md](../../.issues/medium/TMS-006-threat-modeling-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high) · fixed by `a3b7255`

PARTIAL: the IP dimension half is fixed (signUpByIp 20/h, a3b7255). Subaddress normalization for rate-limit keys is still missing, so N aliases × 5/h still mail-bomb one inbox from a botnet.

**Evidence at HEAD**

- `packages/password/src/Password.ts:715` — Per-IP signUp cap now exists (a3b7255); the per-email key still only lower-cases — `victim+1@`, `victim+2@` are distinct buckets.

```ts
yield* rateLimit(`password:signup:ip:${input.ip ?? "unknown"}`, RATE_LIMITS.signUpByIp);
yield* rateLimit(`password:signup:${input.email.toLowerCase()}`, RATE_LIMITS.signUp);
```

**Fix plan** — Normalize subaddressed emails for every per-email rate-limit key (delivery keeps the literal address).

1. Password.ts: `emailRateKey(email)` = lowercase, strip `+tag` from the local part; configurable via `PasswordConfig.rateLimitEmailKey?: (email: string) => string` (flexibility: providers with `-` tags / gmail dots).
2. Use it for signUp, signIn, requestReset, resendVerification keys (and export it for MagicLink/EmailOtp).
3. Do NOT change Users' stored email or lookup semantics (out of scope; would be an account-identity decision).

*Files:* `packages/password/src/Password.ts`

*Tests (write first):*

- packages/password/test/Password.test.ts — FIRST: 'signUp for victim+1..victim+6@x.com is throttled as one per-email bucket'.

*Acceptance:*

- Subaddressed variants share one per-email budget across all password email-keyed endpoints.

*Spec refs:* BEH-EA-108 · *Effort:* S · *Depends on:* RBS-006

**Recommended status:** `ready-for-agent`

#### AGA-007 — Password rate limits are identity-keyed only: proxy-safe, but network-level throttling is silently delegated to the gateway

`low` · `dx` · `password` · [.issues/low/AGA-007-api-gateway-auth-specialist.md](../../.issues/low/AGA-007-api-gateway-auth-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed by `349e220`

The premise ('no per-IP spray dimension anywhere; network throttling silently delegated to the gateway') no longer holds: per-IP rules for signIn (349e220), signUp/requestReset (a3b7255) and verifyEmail (cbf899d), resolved through the ClientAddress port whose layerTrustedProxy makes them proxy-safe. Residual resendVerification IP gap is MLO-003; stale comment is CSD-006.

**Evidence at HEAD**

- `packages/password/src/Password.ts:233` — In-app per-source limits now exist (349e220 signIn; a3b7255 signUp/requestReset + trusted-proxy-aware ClientAddress port).

```ts
signInByIp: { limit: 30, window: Duration.minutes(15) },
```

**Recommended status:** `resolved`

#### ARF-010 — Reset-request rate limit is keyed solely on the attacker-chosen email — unlimited spray across addresses

`low` · `security` · `password` · [.issues/low/ARF-010-account-recovery-flow-specialist.md](../../.issues/low/ARF-010-account-recovery-flow-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed by `a3b7255`

Commit a3b7255 (AGA-001/NHS-003) added requestResetByIp (30/15min) resolved via ClientAddress and registered in the RateLimits registry.

**Evidence at HEAD**

- `packages/password/src/Password.ts:884` — Per-IP dimension ahead of the per-email one; test Password.test.ts:1111.

```ts
yield* rateLimit(
  `password:reset-request:ip:${input.ip ?? "unknown"}`,
  RATE_LIMITS.requestResetByIp,
);
```

**Recommended status:** `resolved`

#### TMS-010 — verify-email accepts unlimited attempts and every well-formed miss pumps an auth.token.replay event

`low` · `security` · `password` · [.issues/low/TMS-010-threat-modeling-specialist.md](../../.issues/low/TMS-010-threat-modeling-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed by `cbf899d`

Fixed by cbf899d (per-IP + per-identifier). Replay-event coalescing is an optional events-stratum idea (slice 02), not needed once the endpoint is bounded.

**Evidence at HEAD**

- `packages/password/src/Password.ts:1043` — Per-IP bound runs before decode/consume, bounding replay-event flooding.

```ts
yield* rateLimit(
  `password:verify-email:ip:${input.ip ?? "unknown"}`,
  RATE_LIMITS.verifyEmailByIp,
);
```

**Recommended status:** `resolved`

### Workstream `mail-delivery-reliability`

#### ARF-003 — requestReset/resendVerification send mail inline, leaking account existence through response latency

`medium` · `security` · `password` · [.issues/medium/ARF-003-account-recovery-flow-specialist.md](../../.issues/medium/ARF-003-account-recovery-flow-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed by `bd1625c`

Commit bd1625c (TSS-001/002, EEM-001, MLO-001) forks both sends off the response path. (The fork's reliability is ERS-002.)

**Evidence at HEAD**

- `packages/password/src/Password.ts:903` — requestReset (and resendVerification :938) now fork the issue+send; tests Password.test.ts:519/:534 with a hanging Mailer.

```ts
if (Option.isSome(userOpt)) {
  const user = userOpt.value;
  yield* Effect.forkDetach(
    Effect.gen(function* () {
      const identifier = `${RESET_PREFIX}${user.id}`;
```

**Recommended status:** `resolved`

#### EOTS-010 — Mailer contract carries token-bearing payloads with no logging prohibition, and layerNoop interpolates recipient email into a die message

`medium` · `security` · `password` · [.issues/medium/EOTS-010-effect-observability-tracing-specialist.md](../../.issues/medium/EOTS-010-effect-observability-tracing-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Unchanged at HEAD.

**Evidence at HEAD**

- `packages/ports/src/Mailer.ts:50` — Recipient email interpolated into a defect.

```ts
export const layerNoop: Layer.Layer<Mailer> = Layer.succeed(
  Mailer,
  Mailer.of({
    send: (message) =>
      Effect.die(
        new Error(
          `awthaq: no Mailer configured — dropped a "${message.template}" message to ${message.to}. ` +
```

- `packages/ports/src/Mailer.ts:31` — Tokens travel as plain strings; no never-log clause.

```ts
export interface MailMessage {
  readonly to: string;
  readonly template: string;
  readonly data?: Record<string, unknown>;
}
```

**Fix plan** — Harden the Mailer contract: tokens as Redacted in data, never-log clause, no PII in layerNoop's defect.

1. Mailer.ts: doc comment on MailerShape/MailMessage — implementations MUST NOT log `data` or `to`; values in `data` may be `Redacted` and adapters unwrap them only when rendering.
2. layerNoop: drop `message.to` from the die message (keep template).
3. Password.ts (and new plugins): put `token: Redacted.make(...)` in mail data (VerificationLink.mailData from MLO-009); update tests reading `sent[i].data.token` to `Redacted.value` via a narrowing helper (no casts).

*Files:* `packages/ports/src/Mailer.ts`; `packages/password/src/Password.ts`; `packages/password/test/*.ts`; `features/step-definitions/PasswordWorld.ts`

*Tests (write first):*

- packages/ports/test/Mailer.test.ts — FIRST: 'layerNoop defect message does not contain the recipient'.
- packages/password/test/Password.test.ts — 'mail data token is Redacted (String(data) does not reveal it)'.

*Acceptance:*

- No token string or recipient address appears in any defect/log produced by awthaq code paths.

*Spec refs:* BEH-EA-199, BEH-EA-113 · *Effort:* S · *Depends on:* MLO-009

**Recommended status:** `ready-for-agent`

#### ERS-002 — Detached verification-mail fiber is unsupervised, unretried, and droppable on shutdown

`medium` · `correctness` · `password` · [.issues/medium/ERS-002-effect-runtime-scheduler-specialist.md](../../.issues/medium/ERS-002-effect-runtime-scheduler-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) · canonical for MA-010, MLO-007

Still `Effect.forkDetach(...).pipe(Effect.ignore)` — now at three sites (signUp, requestReset, resendVerification after bd1625c). No owner scope, no retry, no signal on loss, unbounded fan-out, dropped on shutdown. Detaching from the response path must be kept (BEH-EA-113/064 latency uniformity); ownership/observability must be added.

**Evidence at HEAD**

- `packages/password/src/Password.ts:775`

```ts
yield* Effect.forkDetach(
  Effect.gen(function* () {
    const identifier = `${VERIFY_PREFIX}${user.id}`;
    const { value } = yield* verification.issue({
      identifier,
      ttl: Duration.hours(24),
      userId: user.id,
    });
```

- `packages/password/src/Password.ts:783` — Same forkDetach+ignore at requestReset (:905) and resendVerification (:938).

```ts
    yield* mailer.send({
      to: user.email,
      template: "verify-email",
      data: { token: encodeVerificationToken(identifier, value) },
    });
  }).pipe(Effect.ignore),
);
```

- `packages/ports/src/Mailer.ts:37` — `send` has no error channel — a provider failure can only be swallowed or a defect.

```ts
export interface MailerShape {
  readonly send: (message: MailMessage) => Effect.Effect<void>;
  readonly sent: Effect.Effect<ReadonlyArray<MailMessage>>;
}
```

**Fix plan** — A layer-owned mail dispatcher: forks into a scoped FiberSet (still non-blocking), retries with jittered backoff, bounds concurrency, publishes `auth.mail.failed`, and drains on shutdown; Mailer.send gains a typed failure.

1. packages/ports/src/Mailer.ts (cross-slice 09): `send: (message) => Effect<void, MailDeliveryFailed>` with `class MailDeliveryFailed extends Data.TaggedError("MailDeliveryFailed")<{ reason: string; retryable: boolean }>`; update layerMemory/layerNoop and every adapter/test double.
2. packages/core/src/MailDispatch.ts (new): `MailDispatcher` service built with `FiberSet.make()` in the layer's scope (Layer.effect excludes Scope; AuthPlugin.ts:235), `dispatch(work: Effect<void, E>, meta: { template, userId? })` → `FiberSet.run(set, work.pipe(Semaphore.withPermits(1), Effect.retry(Schedule.exponential("200 millis").pipe(Schedule.jittered, Schedule.both(Schedule.recurs(3)))), Effect.catchCause(→ publish `auth.mail.failed` { template, userId } + Effect.logWarning annotated, never `to`/token)))` — returns immediately. Config `MailDispatchConfig` { concurrency: 32, retries: 3, drainTimeout: 5 s }. Finalizer: `FiberSet.awaitEmpty(set).pipe(Effect.timeout(drainTimeout))` then interrupt + log the dropped count.
3. packages/core/src/AuthEvents.ts: add `auth.mail.failed` ({ template, userId: Option }) + AuditLog.actorOf case.
4. Password.ts: replace the three `Effect.forkDetach(...).pipe(Effect.ignore)` blocks with `mailDispatcher.dispatch(...)`; the same dispatcher is used by MagicLink, EmailOtp, TwoFactor and ARF-005's impersonation notice.
5. Provide MailDispatcher from the core composition (CoreLive / Auth.make's layer) so plugins just yield it.

*Files:* `packages/ports/src/Mailer.ts`; `packages/core/src/MailDispatch.ts (new)`; `packages/core/src/AuthEvents.ts`; `packages/core/src/AuditLog.ts`; `packages/password/src/Password.ts`; `spec/behaviors/15-password.md`; `spec/behaviors/13-events.md`

*Tests (write first):*

- packages/core/test/MailDispatch.test.ts — FIRST: 'a Mailer failing twice then succeeding delivers once (TestClock)'; 'a permanently failing Mailer publishes auth.mail.failed with template and no recipient'; 'closing the layer scope with a hanging send interrupts after drainTimeout and logs'; 'dispatch returns before send completes'.
- Existing TSS-001/TSS-002 non-blocking tests (Password.test.ts:519, :534) stay green.

*Acceptance:*

- No `forkDetach` remains in packages/password; mail failures are observable as auth.mail.failed; shutdown drains in-flight mail up to the grace period.

*Spec refs:* BEH-EA-113, BEH-EA-064, BEH-EA-098, new BEH-EA (mail dispatch) · *Effort:* M · *Depends on:* —

**Recommended status:** `ready-for-agent`

#### MA-010 — Sign-up verification mail is an unsupervised detached fiber with no shutdown or backpressure story

`low` · `architecture` · `password` · [.issues/low/MA-010-michael-arnaldi.md](../../.issues/low/MA-010-michael-arnaldi.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **ERS-002**

Same forkDetach+ignore root cause; its asks (scoped ownership, bounded fan-out, flush-or-log on shutdown) are ERS-002's FiberSet + Semaphore + drain finalizer.

**Evidence at HEAD**

- `packages/password/src/Password.ts:775`

```ts
yield* Effect.forkDetach(
  Effect.gen(function* () {
    const identifier = `${VERIFY_PREFIX}${user.id}`;
    const { value } = yield* verification.issue({
      identifier,
      ttl: Duration.hours(24),
      userId: user.id,
    });
```

**Recommended status:** `resolved`

#### MLO-007 — signUp's forked verification mail swallows provider failures with Effect.ignore - silent token loss

`low` · `correctness` · `password` · [.issues/low/MLO-007-magic-link-email-otp-specialist.md](../../.issues/low/MLO-007-magic-link-email-otp-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **ERS-002**

Same root cause; the requested observable failure is ERS-002's `auth.mail.failed` event.

**Evidence at HEAD**

- `packages/password/src/Password.ts:783` — Same forkDetach+ignore at requestReset (:905) and resendVerification (:938).

```ts
    yield* mailer.send({
      to: user.email,
      template: "verify-email",
      data: { token: encodeVerificationToken(identifier, value) },
    });
  }).pipe(Effect.ignore),
);
```

**Recommended status:** `resolved`

### Workstream `verification-token-delivery`

#### MLO-009 — Token encoding embeds the raw identifier+secret with no canonical delivery format, leaving link shape entirely to consumers

`medium` · `architecture` · `password` · [.issues/medium/MLO-009-magic-link-email-otp-specialist.md](../../.issues/medium/MLO-009-magic-link-email-otp-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Still a bare dotted string; the codec is private to Password.ts; mail data has no url/expiresAt. MagicLink/EmailOtp/TwoFactor challenges all need the same codec, so this becomes a shared core module.

**Evidence at HEAD**

- `packages/password/src/Password.ts:271`

```ts
const encodeVerificationToken = (identifier: string, value: Redacted.Redacted<string>): string =>
  `${identifier}.${Redacted.value(value)}`;
```

- `packages/password/src/Password.ts:783` — Mail data carries only the bare token — no URL, no expiresAt.

```ts
yield* mailer.send({
  to: user.email,
  template: "verify-email",
  data: { token: encodeVerificationToken(identifier, value) },
});
```

**Fix plan** — Extract a shared, purpose-checked token codec + link builder into core and give every mailed token {url, token, expiresAt}.

1. packages/core/src/VerificationLink.ts (new): `encode({ purpose, publicId, value })`, `decode(raw, purpose) => Option<{ identifier, value }>` (rejects a wrong/missing purpose prefix — subsumes ARF-007 structurally), `mailData({ token, expiresAt, link? })` → `{ token: Redacted, url?: string, expiresAt: string /*ISO*/ }`.
2. PasswordConfig gains `links?: { verifyEmail?: (token: string) => string; resetPassword?: (token: string) => string }` — when set, mail data includes `url` (docs recommend a fragment/POST-consuming page, never token-in-query GET); `expiresAt` always included from the issued `VerificationTokenView.expiresAt`.
3. Password.ts: replace `encodeVerificationToken`/`decodeVerificationToken`/`RESET_PREFIX`/`VERIFY_PREFIX` slicing with VerificationLink; MagicLink/EmailOtp/TwoFactor reuse it.

*Files:* `packages/core/src/VerificationLink.ts (new)`; `packages/core/src/index.ts`; `packages/password/src/Password.ts`; `spec/behaviors/08-verification-tokens.md`

*Tests (write first):*

- packages/core/test/VerificationLink.test.ts — FIRST: round-trip; wrong purpose → None; missing separator → None.
- packages/password/test/Password.test.ts — 'reset mail data carries expiresAt and, when links.resetPassword is configured, a url'.

*Acceptance:*

- Every mailed token includes expiresAt; apps can configure link shapes; one codec used by all plugins.

*Spec refs:* BEH-EA-057, BEH-EA-113, BEH-EA-117 · *Effort:* M · *Depends on:* ARF-007

**Recommended status:** `ready-for-agent`

#### ARF-009 — Mailed reset token embeds the internal userId, leaking a UUIDv7 (creation timestamp) inside a recovery artifact

`low` · `security` · `password` · [.issues/low/ARF-009-account-recovery-flow-specialist.md](../../.issues/low/ARF-009-account-recovery-flow-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Mailed tokens still embed `reset-password:<userId>` / `verify-email:<userId>`. Since BCR-003 (commit 704cdd4) the verification row already carries `userId`, so the identifier can become opaque and the user be recovered from the consumed row.

**Evidence at HEAD**

- `packages/password/src/Password.ts:271`

```ts
const encodeVerificationToken = (identifier: string, value: Redacted.Redacted<string>): string =>
  `${identifier}.${Redacted.value(value)}`;
```

- `packages/password/src/Password.ts:907` — identifier (and so the mailed token) embeds the UUIDv7 userId.

```ts
const identifier = `${RESET_PREFIX}${user.id}`;
const { value } = yield* verification.issue({
  identifier,
  ttl: config.resetTtl,
  userId: user.id,
});
```

**Fix plan** — Replace the userId in token identifiers with a random public id; recover userId from the consumed VerificationTokenView.

1. Password.ts requestReset/signUp/resendVerification: identifier = VerificationLink purpose + 128-bit random base64url `publicId` (from Crypto.randomBytes); keep `userId` on the row.
2. confirmReset/verifyEmail: take `userId` from the `consume` result's `userId` (Option.none → TokenConsumed), deleting the `identifier.slice(...)` lines (Password.ts:969, :1057).
3. Rate-limit keys that used the identifier (`password:reset-confirm:${identifier}`) now key on publicId (per-token) — add a per-user budget after consume is not possible pre-consume, so keep the per-IP rule as the spray bound.
4. Invalidate older outstanding reset tokens for the user on a new requestReset? — optional; not required by the finding.

*Files:* `packages/password/src/Password.ts`; `packages/core/src/VerificationLink.ts`

*Tests (write first):*

- packages/password/test/Password.test.ts — FIRST: 'reset and verify mail tokens do not contain the userId'; existing confirmReset/verifyEmail tests stay green.

*Acceptance:*

- No mailed artifact contains a userId or UUIDv7 timestamp.

*Spec refs:* BEH-EA-057, BEH-EA-117, BEH-EA-118 · *Effort:* S · *Depends on:* MLO-009

**Recommended status:** `ready-for-agent`

### Workstream `password-api-contract-hygiene`

#### AR-002 — Self-service flows are ad-hoc endpoints, not resumable flow state machines

`medium` · `architecture` · `password` · [.issues/medium/AR-002-aeneas-rekkas.md](../../.issues/medium/AR-002-aeneas-rekkas.md) · current status `needs-triage`

**Verdict:** WONTFIX-CANDIDATE (confidence high)

Architectural preference, not a defect: awthaq deliberately follows the better-auth/Lucia one-shot-endpoint shape (ADR-003 HttpApi-as-contract). The multi-step journey it cites (factor two) is served by the typed divert outcome `Hooks.TwoFactorRequired { challengeId }` whose challenge state lives in Verification (ticket 05) — the 'minimal flow resource' the finding's own option 1 endorses. A Kratos-style flow resource would be a parallel API surface with no current consumer (speculative infra). Optional: a one-paragraph note in spec/behaviors/12-hooks.md describing divert outcomes as the multi-step mechanism, done as part of THS-001 step 12.

**Evidence at HEAD**

- `packages/password/src/PasswordApi.ts:149` — One-shot endpoints by design.

```ts
export const PasswordGroup = HttpApiGroup.make("password")
```

- `packages/core/src/Hooks.ts:62` — The divert seam (ticket 03, commit 3e298c8) exists; nothing taps it.

```ts
export class TwoFactorRequired extends Schema.TaggedError<TwoFactorRequired>()(
  "TwoFactorRequired",
  { userId: Schema.String, challengeId: Schema.String },
  { httpApiStatus: 401 },
) {}
```

**Recommended status:** `wontfix`

#### AVS-004 — Password plugin squats root-level URL paths inside its namespaced group

`medium` · `api` · `password` · [.issues/medium/AVS-004-api-design-versioning-specialist.md](../../.issues/medium/AVS-004-api-design-versioning-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Unchanged; with magic-link/email-otp/two-factor about to add routes, an unchecked path collision would silently shadow at routing time.

**Evidence at HEAD**

- `packages/password/src/PasswordApi.ts:204` — Root-level paths /verify-email, /resend-verification, /change-password still owned by the password group.

```ts
HttpApiEndpoint.post("verifyEmail", "/verify-email", {
  payload: VerifyEmailPayload,
  error: [TokenConsumed, Api.RateLimited],
}),
```

- `packages/core/src/Auth.ts:396` — Composition checks group ids only — never (method, path).

```ts
// BEH-EA-032: refuse a duplicate group id ourselves — `HttpApi.add`'s own
// last-wins semantics would otherwise silently drop the first
// contributor's endpoints.
const ownerOf = new Map<string, AuthPlugin.Any>();
```

**Fix plan** — Make route ownership a composition-time check instead of a registry of exceptions.

1. packages/core/src/Auth.ts composeApi: after the group-id pass, walk every contributed group's endpoints (`HttpApiEndpoint` exposes `method`/`path`) and throw a new `RouteConflict` (E_ROUTE_CONFLICT, naming both plugin ids, method and path) on a duplicate `(method, path)` — covers root-level and nested paths uniformly, so no hand-kept reserved-path list is needed.
2. Keep password's root-level routes (documented product reasoning); list current root-level routes in spec/behaviors/02-plugin-composition-validate.md as informative.

*Files:* `packages/core/src/Auth.ts`; `spec/behaviors/02-plugin-composition-validate.md`

*Tests (write first):*

- packages/core/test/Auth.test.ts — FIRST: 'two plugins contributing POST /verify-email in different groups fail Auth.make with RouteConflict'.

*Acceptance:*

- A second claimant of any (method, path) fails loudly at Auth.make.

*Spec refs:* BEH-EA-032, BEH-EA-004 · *Effort:* S · *Depends on:* —

**Recommended status:** `ready-for-agent`

#### CDS-003 — Credential-accepting endpoints have no explicit origin check — the login-CSRF posture is accidental

`medium` · `security` · `password` · [.issues/medium/CDS-003-csrf-defense-specialist.md](../../.issues/medium/CDS-003-csrf-defense-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed by `409334e`

Commit 409334e wired Api.CsrfProtection onto every mutating production endpoint including the whole password group; the middleware's Sec-Fetch-Site/Origin check plus signed double-submit is an explicit login-CSRF defense that does not depend on JSON-only decoding or absent CORS.

**Evidence at HEAD**

- `packages/password/src/PasswordApi.ts:254` — Group-level Sec-Fetch-Site/Origin + double-submit (packages/server/src/Csrf.ts:114-180).

```ts
// CSS-001/CDS-001/APS-001/NHS-001/PIL-001/TMS-001: every endpoint here
// is an unsafe method, and most (signUp/signIn/requestReset/
// confirmReset/verifyEmail/resendVerification) are otherwise-public —
// exactly the login-CSRF surface `CsrfProtectionLive` exists to close,
// and `CsrfProtection` doesn't require an authenticated principal, so it
// applies at the group level regardless of `changePassword`'s own
// per-endpoint `Authentication`.
.middleware(Api.CsrfProtection);
```

**Recommended status:** `resolved`

#### ESS-006 — Identity-bearing DTO fields are unrefined Schema.String

`medium` · `api` · `password` · [.issues/medium/ESS-006-effect-schema-specialist.md](../../.issues/medium/ESS-006-effect-schema-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Unchanged at HEAD.

**Evidence at HEAD**

- `packages/password/src/PasswordApi.ts:71` — Also SignIn/RequestReset/ResendVerification; only AdminApi.ts:47 uses Schema.makeFilter.

```ts
export const SignUpPayload = Schema.Struct({
  email: Schema.String,
  password: Schema.Redacted(Schema.String),
});
```

**Fix plan** — A shared `Email` schema at the contract boundary (+ a password length ceiling); runtime-config policy stays in checkPolicy.

1. packages/api/src/Email.ts (new): `export const Email = Schema.String.check(Schema.makeFilter(...))` following AdminApi.ts:47's exact idiom — trims nothing, requires one `@`, non-empty local/domain, domain has a dot, total ≤ 254, local ≤ 64; documented as non-normalizing (domain lower-cases).
2. Use in PasswordApi SignUp/SignIn/RequestReset/ResendVerification payloads, MagicLink/EmailOtp payloads, and (slice 08) organization invitation payloads; not on output DTOs.
3. Password payloads: `Schema.Redacted(Schema.String.check(maxLength 1024))` — config-independent hashing-DoS ceiling; minLength/breach remain in checkPolicy because they depend on the runtime `PasswordConfig` a static schema can't read (answering the finding's 'encode the cheap half' — the cheap config-free half is the upper bound).

*Files:* `packages/api/src/Email.ts (new)`; `packages/api/src/index.ts`; `packages/password/src/PasswordApi.ts`; `spec/behaviors/15-password.md`; `spec/behaviors/04-contract-stratum.md`

*Tests (write first):*

- packages/api/test/Email.test.ts — FIRST: accepts a@b.co; rejects 'junk', '@b.co', 'a@b', 255-char address.
- packages/password/test/AuthHttp.test.ts — 'sign-up with email "junk" answers 400 schema error, creates no user'.

*Acceptance:*

- Malformed emails are rejected at decode with 400 before any rate-limit/DB work.

*Spec refs:* BEH-EA-113, BEH-EA-085 · *Effort:* S · *Depends on:* —

**Recommended status:** `ready-for-agent`

#### EHA-007 — Plugin contract convention drift: per-endpoint middleware inside a shared group

`low` · `api` · `password` · [.issues/low/EHA-007-effect-http-api-specialist.md](../../.issues/low/EHA-007-effect-http-api-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Still per-endpoint; now two endpoints (changePassword, reauthenticate).

**Evidence at HEAD**

- `packages/password/src/PasswordApi.ts:249` — Per-endpoint Authentication inside the shared public group (same for changePassword at :230-239).

```ts
HttpApiEndpoint.post("reauthenticate", "/password/reauthenticate", {
  payload: ReauthenticatePayload,
  error: [WrongPassword, Api.RateLimited],
}).middleware(Api.Authentication),
```

- `packages/jwt/src/JwtApi.ts:15` — The documented convention.

```ts
// second, dotted-sub-id group carrying its own `.middleware(Api.Authentication)`
// (see `PasskeyApi.ts`'s `passkey`/`passkey.authenticate` split), never a
// per-endpoint middleware inside one shared group.
```

**Fix plan** — Split authenticated password endpoints into a `password.account` sub-group.

1. PasswordApi.ts: move changePassword and reauthenticate into `HttpApiGroup.make("password.account")` with group-level `.middleware(Api.Authentication)` and `.middleware(Api.CsrfProtection)`; paths unchanged; `PasswordApi = HttpApi.make("auth").add(PasswordGroup).add(PasswordAccountGroup)`.
2. Password.ts: split handlers into `PasswordHandlers` (group "password") and `PasswordAccountHandlers` (group "password.account"), merged (`Layer.mergeAll`) for `AuthPlugin.layer`'s `handlers`.
3. Update typed-client call sites/tests (`client["password.account"].changePassword`) and features step definitions; TwoFactor follows the same split (twoFactor / twoFactor.account).

*Files:* `packages/password/src/PasswordApi.ts`; `packages/password/src/Password.ts`; `packages/password/test/*.ts`; `features/step-definitions/PasswordWorld.ts`; `packages/client (if it wraps password endpoints)`

*Tests (write first):*

- packages/password/test/AuthHttp.test.ts — FIRST: 'every endpoint in group password.account requires Authentication; no endpoint in group password carries per-endpoint middleware' (walk the HttpApi groups).

*Acceptance:*

- Password contract follows the dotted-sub-group convention; wire paths unchanged.

*Spec refs:* BEH-EA-004, BEH-EA-066 · *Effort:* S · *Depends on:* —

**Recommended status:** `ready-for-agent`

### Workstream `password-policy-posture`

#### FAMS-003 — Hard emailVerified sign-in gate diverges from Firebase semantics and locks out migrated users

`medium` · `correctness` · `password` · [.issues/medium/FAMS-003-firebase-auth-migration-specialist.md](../../.issues/medium/FAMS-003-firebase-auth-migration-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Gate is unconditional; imported populations that never verified are locked out. Per the flexibility preference, ship the knob (secure default unchanged) rather than asking.

**Evidence at HEAD**

- `packages/password/src/Password.ts:841` — Hard, unconditional gate; PasswordConfigShape (:37-42) has no knob.

```ts
if (!user.emailVerified) {
  yield* events.publish({
    _tag: "auth.user.signInFailed",
    strategy: "password",
    reason: "emailNotVerified",
  });
  return yield* Effect.fail(new PasswordApi.EmailNotVerified());
}
```

**Fix plan** — Make the verified-email sign-in gate configurable (default unchanged) and document the migration step.

1. PasswordConfigShape gains `requireVerifiedEmail: boolean` (default true); signIn skips the gate when false (still after credential verification).
2. APS-007's emailVerified-on-principal lets apps that disable the gate still restrict unverified users downstream — cross-reference in docs.
3. Migration docs (packages/migrate-auth0/README.md already maps email_verified; add the same note to the Firebase/Supabase migration guidance): call Users.verifyEmail for imported users the source marked verified.

*Files:* `packages/password/src/Password.ts`; `spec/behaviors/15-password.md`; `packages/migrate-auth0/README.md`

*Tests (write first):*

- packages/password/test/Password.test.ts — FIRST: 'with requireVerifiedEmail:false an unverified user with correct credentials signs in'; existing ticket-04 gate tests unchanged under default.

*Acceptance:*

- Default behavior identical; operators can soften the gate by config.

*Spec refs:* BEH-EA-114, BEH-EA-120 · *Effort:* S · *Depends on:* —

**Recommended status:** `ready-for-agent`

#### PHS-004 — HIBP response status is never checked; non-2xx resolves to not-breached, bypassing fail-closed mode

`medium` · `security` · `password` · [.issues/medium/PHS-004-password-hashing-specialist.md](../../.issues/medium/PHS-004-password-hashing-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high) · fixed by `25d991e`

PARTIAL: the status-code half is fixed by 25d991e (CSD-001) with tests at Password.test.ts:757/:779. Remaining from this finding: a truncated/garbled 200 body silently downgrades to 'not breached'. Also found while validating: the HIBP call has no timeout, so a black-holed egress hangs signUp/confirmReset/changePassword indefinitely instead of reaching onUnavailable.

**Evidence at HEAD**

- `packages/password/src/Password.ts:316` — Non-2xx now routed to onUnavailable (25d991e); a malformed/empty 200 body still reads as 'not breached', and there is no timeout.

```ts
const response = yield* httpClient
  .get(`https://api.pwnedpasswords.com/range/${prefix}`)
  .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
const body = yield* response.text;
return body.split("\n").some((line) => line.split(":")[0]?.trim().toUpperCase() === suffix);
}).pipe(Effect.catch(() => Effect.succeed(onUnavailable === "reject")));
```

**Fix plan** — Treat an unparseable HIBP body and a slow provider as 'unavailable'.

1. Password.ts isBreached: parse lines with `/^[0-9A-F]{35}:\d+\r?$/i`; if the body is empty or any non-empty line fails to match → fail into the catch (onUnavailable).
2. PasswordConfig gains `breachCheckTimeout: Duration` default 3 s; apply `Effect.timeout` to the request+body read so a timeout also routes to onUnavailable.

*Files:* `packages/password/src/Password.ts`

*Tests (write first):*

- packages/password/test/Password.test.ts — FIRST: 'a 200 HTML body fails closed under onUnavailable:reject'; 'a never-responding breach check fails open by default after breachCheckTimeout (TestClock)'.

*Acceptance:*

- Malformed bodies and timeouts follow onUnavailable; signUp never hangs on HIBP.

*Spec refs:* BEH-EA-119 · *Effort:* S · *Depends on:* —

**Recommended status:** `ready-for-agent`

#### RBS-005 — HIBP check treats any non-throwing response as authoritative — a 429/5xx body silently counts as 'not breached'

`medium` · `security` · `password` · [.issues/medium/RBS-005-rate-limiting-brute-force-specialist.md](../../.issues/medium/RBS-005-rate-limiting-brute-force-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed by `25d991e`

Commit 25d991e (CSD-001) applies HttpClientResponse.filterStatusOk. Its 'consider garbled body' aside is tracked in PHS-004.

**Evidence at HEAD**

- `packages/password/src/Password.ts:316` — Non-2xx → failure → onUnavailable; tests Password.test.ts:757 (429 fail-open) and :779 (503 fail-closed).

```ts
const response = yield* httpClient
  .get(`https://api.pwnedpasswords.com/range/${prefix}`)
  .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
```

**Recommended status:** `resolved`

#### TMS-005 — signUp responds EmailAlreadyExists — account enumeration inconsistent with the plugin's own anti-enumeration posture

`medium` · `security` · `password` · [.issues/medium/TMS-005-threat-modeling-specialist.md](../../.issues/medium/TMS-005-threat-modeling-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) · canonical for TSS-007

Behavior unchanged and still undocumented as an exception to BEH-EA-086. Choosing between 'reveal' and 'conceal' is a genuine product decision (conceal changes signUp's contract: no session until the mailbox is proven).

**Evidence at HEAD**

- `packages/password/src/Password.ts:745` — 409 EmailAlreadyExists — an existence oracle.

```ts
const user = yield* users
  .create({ email: vetoedSignUp.email, name: vetoedSignUp.name })
  .pipe(
    Effect.catchTag("EmailAlreadyExists", () => new PasswordApi.EmailAlreadyExists()),
```

- `spec/behaviors/11-http-error-mapping.md:120` — BEH-EA-086 claims uniform enumeration safety with no recorded exception.

```ts
the requirement applies not only to sign-in (`InvalidCredentials`) and password reset (`requestReset` always `202`), but to every endpoint the composed `auth.api` exposes, including ones contributed by third-party plugins
```

**Fix plan** — Implement the chosen posture; at minimum record the exception in spec.

1. spec/decisions/017-signup-enumeration-posture.md (new ADR) + BEH-EA-086 note referencing it.
2. (C) PasswordConfig `signUpEnumeration`; conceal: signUp returns `HttpApiSchema.Empty(202)`-style response variant (contract gains a second success shape or a separate `/password/sign-up` response union), existing-email branch dispatches template `account-exists` via the mail dispatcher after equal-cost work (hash computed in both branches).

*Files:* `packages/password/src/Password.ts`; `packages/password/src/PasswordApi.ts`; `spec/decisions/017-signup-enumeration-posture.md (new)`; `spec/behaviors/11-http-error-mapping.md`; `spec/behaviors/15-password.md`

*Tests (write first):*

- (C) packages/password/test/Password.test.ts — 'conceal: duplicate and fresh sign-up are indistinguishable in status/body; existing owner gets account-exists mail'.

*Acceptance:*

- The enumeration posture of signUp is an explicit, documented decision; (C) conceal mode yields uniform responses.

*Spec refs:* BEH-EA-086, BEH-EA-113 · *Effort:* M · *Depends on:* ERS-002

*Decision needed:* see Decisions — recommendation: C — flexibility over complexity: most apps want reveal UX, security-sensitive ones need conceal; the conceal branch reuses the mail dispatcher and Verification already present. Document the default in an ADR either way.

**Recommended status:** `ready-for-human`

#### PHS-006 — Breach screening fully implemented but disabled by default

`low` · `security` · `password` · [.issues/low/PHS-006-password-hashing-specialist.md](../../.issues/low/PHS-006-password-hashing-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Default still off. Flipping it makes every default deployment call a third party on sign-up — a genuine product/privacy call; no existing decision covers it (BEH-EA-119 only fixes fail-open vs fail-closed semantics).

**Evidence at HEAD**

- `packages/password/src/Password.ts:44`

```ts
const defaultPasswordConfig: PasswordConfigShape = {
  minLength: 12,
  breachCheck: false,
  resetTtl: Duration.hours(1),
  rehashOnLogin: true,
};
```

**Fix plan** — After the decision: flip (B) or document (A).

1. B: `defaultPasswordConfig.breachCheck = true`; ensure PHS-004's timeout lands first; test compositions already provide `NoBreachHttpClient` (Password.test.ts) so suites stay deterministic; update BEH-EA-119 text + README quickstart ('breach screening on by default; `password.config({ breachCheck: false })` to disable').
2. A: README + BEH-EA-119 documentation only.

*Files:* `packages/password/src/Password.ts`; `README.md`; `spec/behaviors/15-password.md`

*Tests (write first):*

- packages/password/test/Password.test.ts — 'with default config, a breached password is rejected' (B).

*Acceptance:*

- Default posture is explicit in spec and code agrees.

*Spec refs:* BEH-EA-119 · *Effort:* S · *Depends on:* PHS-004

*Decision needed:* see Decisions — recommendation: B — NIST SP 800-63B §3.1.1.2 makes screening against compromised-password lists a SHALL; k-anonymity leaks only a 5-char SHA-1 prefix; fail-open + timeout keeps availability. Richer secure default wins; opting out stays one line.

**Recommended status:** `ready-for-human`

#### TSS-007 — signUp EmailAlreadyExists is an explicit account-existence oracle, undocumented as an exception to BEH-EA-086

`low` · `docs` · `password` · [.issues/low/TSS-007-timing-side-channel-specialist.md](../../.issues/low/TSS-007-timing-side-channel-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **TMS-005**

Same root cause (signUp EmailAlreadyExists oracle vs BEH-EA-086); its docs-only fix is option A of TMS-005's decision.

**Evidence at HEAD**

- `packages/password/src/Password.ts:748`

```ts
Effect.catchTag("EmailAlreadyExists", () => new PasswordApi.EmailAlreadyExists()),
```

**Recommended status:** `resolved`

### Workstream `session-issuance-context`

#### CSD-003 — Sessions never capture IP/userAgent at issuance — forensics and device-aware detection have no data

`medium` · `security` · `password` · [.issues/medium/CSD-003-credential-stuffing-defense-specialist.md](../../.issues/medium/CSD-003-credential-stuffing-defense-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) · canonical for SMS-004

Every production sessions.issue call still omits `request`, so ipAddress/userAgent are always null and the device list is useless. The handlers already resolve the client IP (ClientAddress) — only threading is missing.

**Evidence at HEAD**

- `packages/password/src/Password.ts:866` — Also signUp :759, changePassword :1143, OAuth.ts:853, Passkey.ts:832 — none pass `request`.

```ts
const issued = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
```

- `packages/core/src/Sessions.ts:169` — The port already accepts ip/userAgent.

```ts
readonly issue: (input: {
  readonly userId: UserId;
  readonly request?: { readonly ip?: string; readonly userAgent?: string };
  readonly supersedes?: SessionId;
```

**Fix plan** — Thread {ip, userAgent} from every session-minting handler into sessions.issue.

1. Password: PasswordShape signUp/signIn/changePassword inputs gain `userAgent?: string`; handlers read `Headers.get(request.headers, "user-agent")` (and resolved IP; changePassword handler must start taking `request`); pass `request: { ip, userAgent }` to sessions.issue at Password.ts:759, :866, :1144.
2. OAuth (slice 03): flow state already stores `ip` — add `userAgent` to flow state at authorize and pass both at OAuth.ts:853. Passkey (slice 10): pass request context at Passkey.ts:832 (and registration sign-up path). TwoFactor/MagicLink/EmailOtp: built with it from day one.
3. Cap userAgent length (e.g. 512 chars) before persisting.

*Files:* `packages/password/src/Password.ts`; `packages/oauth/src/OAuth.ts`; `packages/passkey/src/Passkey.ts`

*Tests (write first):*

- packages/password/test/AuthHttp.test.ts — FIRST: 'POST /password/sign-in with User-Agent X yields a session whose SessionDto.userAgent is X and ipAddress is the resolved client address'.
- Analogous tests in oauth/passkey suites (their slices).

*Acceptance:*

- GET /session/list shows a non-null userAgent for sessions created by password/OAuth/passkey sign-in.

*Spec refs:* BEH-EA-054, BEH-EA-113, BEH-EA-114 · *Effort:* M · *Depends on:* —

**Recommended status:** `ready-for-agent`

#### SMS-004 — Request ip/userAgent never recorded — the device list ships empty

`medium` · `dx` · `password` · [.issues/medium/SMS-004-session-management-specialist.md](../../.issues/medium/SMS-004-session-management-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **CSD-003**

Identical root cause (no call site passes request metadata to sessions.issue) and identical fix.

**Evidence at HEAD**

- `packages/password/src/Password.ts:866` — Also signUp :759, changePassword :1143, OAuth.ts:853, Passkey.ts:832 — none pass `request`.

```ts
const issued = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
```

- `packages/core/src/Sessions.ts:169` — The port already accepts ip/userAgent.

```ts
readonly issue: (input: {
  readonly userId: UserId;
  readonly request?: { readonly ip?: string; readonly userAgent?: string };
  readonly supersedes?: SessionId;
```

**Recommended status:** `resolved`

#### APS-007 — Sessions carry no email-verification trust signal while every issuance path mints them pre-verification

`low` · `security` · `password` · [.issues/low/APS-007-auth-pentest-specialist.md](../../.issues/low/APS-007-auth-pentest-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Unchanged: principals carry no emailVerified/amr signal; magic-link (BAM-007) will mint sessions purely from mailbox control, making the gap more relevant.

**Evidence at HEAD**

- `packages/api/src/Api.ts:21` — No verification or assurance fact on the principal.

```ts
export class UserPrincipal extends Schema.TaggedClass<UserPrincipal>()("User", {
  ref: PrincipalRef,
  sessionId: Schema.String,
  actingAs: Schema.optional(PrincipalRef),
}) {}
```

- `packages/password/src/Password.ts:759` — signUp mints a session for an unverified user.

```ts
const issued = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
```

**Fix plan** — Record per-session authentication methods (amr) and offer an opt-in principal resolver that exposes emailVerified.

1. packages/core/src/Sessions.ts: `issue` gains `amr?: ReadonlyArray<string>`; SessionView/SessionRecord gain `amr: ReadonlyArray<string>`; new nullable `sessions.amr` TEXT(JSON) column via a core migration (slice 05 sql owns the migration mechanics); memory + SQL layers.
2. Callers set amr: Password ["pwd"], OAuth ["fed"], Passkey ["hwk"] (+"user" when UV), MagicLink ["email"], EmailOtp ["otp","email"], TwoFactor [first, "otp"].
3. packages/api/src/Api.ts: `UserPrincipal` gains `amr: Schema.optional(Schema.Array(Schema.String))` and `emailVerified: Schema.optional(Schema.Boolean)`; PrincipalResolverLive (packages/server/src/Authentication.ts:42) copies amr from the session; new opt-in `PrincipalResolver.layerWithUserFacts` additionally loads `Users.findById` to set emailVerified (one PK lookup per request — opt-in because it costs a query).
4. Docs (09-authentication-middleware.md): hosts must gate trust on emailVerified/amr, not on 'has a session'.

*Files:* `packages/core/src/Sessions.ts`; `packages/sql/src/CoreMigrations.ts`; `packages/sql/src/Models.ts`; `packages/api/src/Api.ts`; `packages/server/src/Authentication.ts`; `packages/password/src/Password.ts`; `spec/behaviors/07-sessions.md`; `spec/behaviors/09-authentication-middleware.md`

*Tests (write first):*

- packages/core/test/Sessions.test.ts — FIRST: 'amr passed to issue round-trips through verify (memory + SQL)'.
- packages/server/test — 'layerWithUserFacts sets emailVerified=false for a fresh password sign-up'.

*Acceptance:*

- Every session exposes how it was authenticated; an app can read emailVerified off the principal with one opt-in layer.

*Spec refs:* BEH-EA-025, BEH-EA-054, new BEH-EA (amr) · *Effort:* L · *Depends on:* —

**Recommended status:** `ready-for-agent`

### Workstream `native-token-delivery`

#### MNA-001 — No native client can ever obtain its first session token

`high` · `api` · `password` · [.issues/high/MNA-001-mobile-native-auth-specialist.md](../../.issues/high/MNA-001-mobile-native-auth-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high)

Unimplemented at HEAD (no `x-awthaq-token-delivery` anywhere). Wayfinder ticket 17 decided: opt-in `X-Awthaq-Token-Delivery: bearer` request header; session-minting responses then return the raw token in the body and skip Set-Cookie (mutually exclusive); default unchanged.

**Evidence at HEAD**

- `packages/password/src/Password.ts:383` — Cookie is the only delivery channel (same in signIn :411, changePassword :486).

```ts
const issued = yield* password.signUp({
  ...payload,
  ...(Option.isSome(resolvedAddress) ? { ip: resolvedAddress.value } : {}),
});
yield* HttpApiBuilder.securitySetCookie(
  Api.SessionCookie,
  Redacted.value(issued.token),
  Sessions.SESSION_COOKIE_ATTRIBUTES,
```

- `packages/api/src/Session.ts:18` — No token field.

```ts
export class SessionDto extends Schema.Class<SessionDto>("SessionDto")({
  id: Schema.String,
  createdAt: Schema.String,
  lastActiveAt: Schema.String,
  expiresAt: Schema.String,
  userAgent: Schema.NullOr(Schema.String),
  current: Schema.Boolean,
}) {}
```

**Fix plan** — Implement ticket 17's opt-in bearer delivery for every session-minting response.

1. packages/api/src/Session.ts: `export const TOKEN_DELIVERY_HEADER = "x-awthaq-token-delivery"`; SessionDto gains `token: Schema.optional(Schema.String)` (documented: present only in bearer mode).
2. packages/server (new helper `deliverIssuedSession(issued, request)`): header value `bearer` → return `toSessionDto(issued.session)` with `token: Redacted.value(issued.token)` and DO NOT call securitySetCookie; otherwise set the cookie and omit token. Reject unknown header values with 400 (explicit, no silent fallback).
3. Password handlers signUp/signIn/changePassword (Password.ts:375-492) use the helper; Passkey registerVerify/authenticateVerify (slice 10) and TwoFactor/MagicLink/EmailOtp use it from day one; OAuth native exchange is MNA-003 (slice 03).
4. CSRF: native clients still pass the group-level CsrfProtection — document the bootstrap (obtain `__Host-csrf` then echo `x-csrf-token`); any exemption for header-bearing requests is a separate decision (see Decisions).
5. Docs: packages/password/README.md + packages/passkey/README.md 'Native clients' section (Keychain/Keystore storage is the app's responsibility).

*Files:* `packages/api/src/Session.ts`; `packages/server/src/Session.ts (or new SessionDelivery.ts)`; `packages/password/src/Password.ts`; `packages/passkey/src/Passkey.ts`; `packages/password/README.md`; `spec/behaviors/09-authentication-middleware.md`; `spec/behaviors/15-password.md`

*Tests (write first):*

- packages/password/test/AuthHttp.test.ts — FIRST: 'sign-in with X-Awthaq-Token-Delivery: bearer returns body.token and no Set-Cookie; the token authenticates GET /session via Authorization: Bearer'; 'without the header: Set-Cookie and no body token'; 'unknown header value → 400'.

*Acceptance:*

- A native client can sign up/in and then call authenticated endpoints with a bearer token; browser behavior byte-for-byte unchanged.

*Spec refs:* BEH-EA-113, BEH-EA-114, BEH-EA-066, new BEH-EA (token delivery mode) · *Effort:* M · *Depends on:* —

**Recommended status:** `ready-for-agent`

### Workstream `auth-operation-tracing`

#### EOTS-001 — Zero auth-operation spans: planned auth.signin/auth.session.refresh span skeleton never implemented

`high` · `architecture` · `password` · [.issues/high/EOTS-001-effect-observability-tracing-specialist.md](../../.issues/high/EOTS-001-effect-observability-tracing-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high)

Still zero `withSpan` in library source. Wayfinder ticket 27 (observability substrate, member MW-001 in slice 13) step 2 fixes the span names/attributes; this issue is the password (+ sibling plugin) instance of it.

**Evidence at HEAD**

- `packages/password/src/Password.ts:794` — No span; `grep -rn withSpan packages/*/src` → 0 hits at HEAD.

```ts
const signIn: PasswordShape["signIn"] = Effect.fnUntraced(function* (input) {
```

**Fix plan** — Add ticket 27's business-logic spans via one shared helper, starting with every Password operation.

1. packages/core/src/Observability.ts (new, ticket 27 §2/§4 home): `authSpan(name, { plugin, strategy? })` = `Effect.withSpan(name, { attributes: { "awthaq.plugin": plugin, "auth.strategy": strategy } })`, plus `annotatePrincipal(userId)` = `Effect.annotateCurrentSpan("user.id", userId)`; never accepts Redacted values (type param constrained to string|number|boolean).
2. Password.ts: wrap signUp/signIn/requestReset/resendVerification/confirmReset/verifyEmail/changePassword/reauthenticate — names `awthaq.password.signUp`, … (`awthaq.password.verify` for the hash check per ticket 27); annotate user.id after the user is known; never email/password/token.
3. Same helper in OAuth callback, Passkey verify, Sessions.issue/verify (`awthaq.session.issue`/`awthaq.session.verify`) — cross-slice (01/03/10); TwoFactor/MagicLink/EmailOtp use it from day one.
4. Naming follows ticket 27 (`awthaq.*`), superseding research/01's `auth.signin` sketch; record in the observability ADR ticket 27 §3 creates.

*Files:* `packages/core/src/Observability.ts (new)`; `packages/password/src/Password.ts`; `packages/core/src/Sessions.ts`; `packages/oauth/src/OAuth.ts`; `packages/passkey/src/Passkey.ts`

*Tests (write first):*

- packages/password/test/Password.test.ts — FIRST: with an in-memory Tracer layer, 'signIn emits span awthaq.password.signIn with awthaq.plugin=password, auth.strategy=password, user.id set on success, and no attribute value equal to the email or password'.

*Acceptance:*

- Every Password operation produces a named span with the documented attributes; no secret/PII attribute values.

*Spec refs:* BEH-EA-199, new BEH-EA / ADR (observability naming, ticket 27) · *Effort:* M · *Depends on:* —

**Recommended status:** `ready-for-agent`

### Workstream `mfa-two-factor`

#### AOMS-003 — MFA is absent at runtime: two-factor placeholder plus unconditional session issue

`high` · `security` · `two-factor` · [.issues/high/AOMS-003-auth0-okta-migration-specialist.md](../../.issues/high/AOMS-003-auth0-okta-migration-specialist.md) · current status `ready-for-agent`

**Verdict:** PARTIAL (confidence high) · fixed by `3e298c8`

PARTIAL: the 'no divert point / unconditional session issue' half is fixed — commit 3e298c8 wired Hooks.BeforeSessionIssue into Password.signIn (Password.ts:862), OAuth.callback (OAuth.ts:846) and Passkey (Passkey.ts:825). Still true: no TwoFactor plugin taps it, no MFA events exist in AuthEvents, and sessions record no amr. The plugin build-out itself is THS-001's fix; this issue keeps the residual assurance-signal + migration-doc work.

**Evidence at HEAD**

- `packages/two-factor/src/index.ts:8` — Still the verbatim placeholder at HEAD.

```ts
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

- `packages/password/src/Password.ts:862` — Password.signIn consults BeforeSessionIssue (also OAuth.ts:846, Passkey.ts:825).

```ts
const point = yield* beforeSessionIssue.run({ userId: user.id, strategy: "password" });
if (point._tag === "Diverted") {
  return yield* Effect.fail(point.value);
}
const issued = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
```

- `packages/oauth/src/OAuth.ts:846` — Divert seam now wired into OAuth too (commit 3e298c8).

```ts
const point = yield* beforeSessionIssue.run({
  userId: targetUserId,
  strategy: providerId,
});
if (point._tag === "Diverted") {
  return yield* Effect.fail(point.value);
}
const issued = yield* sessions.issue({ userId: targetUserId }).pipe(Effect.orDie);
```

**Fix plan** — Close the residual after THS-001 lands: MFA events in the audit trail, `amr` recorded on sessions minted after a second factor, and the Auth0 migration doc stating enrolments are not importable.

1. Depends on THS-001 step 11 for the `auth.twoFactor.*` events (no separate work).
2. Record assurance on the session: `Sessions.issue` gains `amr?: ReadonlyArray<string>` (RFC 8176 values: `pwd`, `otp`, `hwk`, `fed`, `email`), persisted in a new nullable `sessions.amr` column and exposed on `SessionView`/`Api.UserPrincipal` — delivered by the `session-issuance-context` workstream (APS-007); TwoFactor.finalizeSignIn passes `[firstFactorAmr, "otp"]`.
3. packages/migrate-auth0/README.md: add an 'MFA enrolments' section — Auth0 does not export TOTP secrets; imported users with MFA must re-enrol via /two-factor/enable on first sign-in; recommend composing TwoFactor.sessionGate before cut-over.

*Files:* `packages/migrate-auth0/README.md`; `packages/core/src/Sessions.ts (via APS-007)`; `packages/two-factor/src/TwoFactor.ts`

*Tests (write first):*

- packages/two-factor/test/TwoFactor.test.ts — 'a session minted by /two-factor/verify carries amr ["pwd","otp"]'

*Acceptance:*

- A 2FA-completed session exposes amr containing "otp"; migrate-auth0 README documents re-enrolment.

*Spec refs:* BEH-EA-093, new BEH-EA (two-factor) · *Effort:* S · *Depends on:* THS-001, APS-007

**Recommended status:** `ready-for-agent`

#### ARF-005 — The emailed reset link is the only recovery channel; recovery codes and magic-link are unimplemented, so email defeats every strong factor

`high` · `security` · `two-factor` · [.issues/high/ARF-005-account-recovery-flow-specialist.md](../../.issues/high/ARF-005-account-recovery-flow-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high)

Both plugins are still placeholders; confirmReset has no hook through which a second factor could be demanded. Ticket 05 §2 prescribes: magic-link joins BeforeSessionIssue's call sites (done inside BAM-007's MagicLink build), a new BeforeCredentialReset veto gates Password.confirmReset when a confirmed second factor exists, and admin impersonation notifies the account owner. Passkey-only zero-factor self-service recovery is explicitly left to the application (flagged, see Decisions).

**Evidence at HEAD**

- `packages/two-factor/src/index.ts:8` — Still the verbatim placeholder at HEAD.

```ts
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

- `packages/magic-link/src/index.ts:8` — Still the verbatim placeholder at HEAD.

```ts
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

- `packages/password/src/Password.ts:983` — confirmReset: mailbox possession alone rewrites the credential; no second-factor gate exists.

```ts
yield* sqlTransaction
  .withTransaction(
    Effect.gen(function* () {
      yield* verification.consume(identifier, value).pipe(
        Effect.catchTag("TokenConsumed", () => new PasswordApi.TokenConsumed()),
        Effect.catchTag("PlatformError", Effect.die),
      );
```

- `packages/core/src/Hooks.ts:94` — No BeforeCredentialReset point yet.

```ts
export const HooksLive = Layer.mergeAll(
  BeforeSignUp.layer,
  AfterSignIn.layer,
  BeforeSessionIssue.layer,
  BeforeUserDelete.layer,
);
```

**Fix plan** — Add `Hooks.BeforeCredentialReset` (veto), consult it inside confirmReset's transaction, tap it from `TwoFactor.credentialResetGate`, and notify owners on impersonation start.

1. packages/core/src/Hooks.ts: `export class BeforeCredentialReset extends HookPoint.veto<BeforeCredentialReset>()("auth.credential.beforeReset", Schema.Struct({ userId: Schema.String, secondFactorCode: Schema.optional(Schema.String) }))` and add `BeforeCredentialReset.layer` to `HooksLive`.
2. packages/password/src/PasswordApi.ts: `ConfirmResetPayload` gains `secondFactorCode: Schema.optional(Schema.Redacted(Schema.String))` (TOTP or recovery code); confirmReset `error` array gains `HookPoint.HookAborted`; add a typed `SecondFactorRequired` (401) if the veto code is `TWO_FACTOR_REQUIRED` so clients branch on `_tag`.
3. packages/password/src/Password.ts confirmReset: yield `Hooks.BeforeCredentialReset` in `make`; inside the existing transaction, after `verification.consume` and before `updateCredentialHash`, run the veto (translate `HookAbort` → `HookAborted`/`SecondFactorRequired` exactly like `vetoBeforeSignUp`, Password.ts:694-710) so a veto rolls the consume back on SQL.
4. packages/two-factor: `TwoFactor.credentialResetGate` layer — confirmed secret present and no/invalid code → `HookAbort({ code: "TWO_FACTOR_REQUIRED" })`; valid TOTP (advances last_used_step) or recovery code (marked used, event) → continue.
5. Owner notification (ticket 05 §2, the one mitigation shipped now): opt-in `Admin.impersonationOwnerNotice` layer (packages/admin) subscribing to `auth.admin.impersonationStarted` (Admin.ts:302) and sending template `impersonation-started` to the target user's email with {reason, startedAt} via the mail dispatcher (mail-delivery-reliability workstream) — never the session id/token.
6. MagicLink consume path runs BeforeSessionIssue (tracked in BAM-007's steps; listed here as the ARF-005 Fix A acceptance).

*Files:* `packages/core/src/Hooks.ts`; `packages/password/src/Password.ts`; `packages/password/src/PasswordApi.ts`; `packages/two-factor/src/TwoFactor.ts`; `packages/admin/src/Admin.ts`; `spec/behaviors/15-password.md`; `spec/behaviors/12-hooks.md`

*Tests (write first):*

- packages/password/test/Password.test.ts — 'confirmReset for an account with a confirmed TOTP factor fails SecondFactorRequired without secondFactorCode and leaves the password unchanged'; 'succeeds with a valid TOTP code'; 'succeeds once with a recovery code'.
- packages/core/test/Hooks.test.ts — BeforeCredentialReset veto surfaces as typed HookAborted.
- packages/admin/test — impersonation start mails the target owner (Mailer.layerMemory) with no token/session id in data.
- BDD: extend 15-password.feature with 'reset requires the enrolled second factor'.

*Acceptance:*

- Mailbox possession alone can no longer reset the password of a TOTP-enrolled account.
- A magic-link sign-in of an enrolled user diverts to TwoFactorRequired.
- Impersonation start produces an owner mail.

*Spec refs:* BEH-EA-117, BEH-EA-090, new BEH-EA (BeforeCredentialReset), BEH-EA-209 · *Effort:* L · *Depends on:* THS-001, ARF-002, BAM-007, ERS-002

**Recommended status:** `ready-for-agent`

#### THS-001 — Entire two-factor/TOTP domain is an unimplemented placeholder

`high` · `architecture` · `two-factor` · [.issues/high/THS-001-totp-hotp-mfa-specialist.md](../../.issues/high/THS-001-totp-hotp-mfa-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high) · canonical for CSD-005, ACS-010, BCR-001, ECF-009, TTE-008

Package is still `export {}`; repo-wide there is no TOTP/HOTP, base32, otpauth or recovery-code code and no two_factor_* table. Wayfinder ticket 05 (resolved) fixes the design: RFC 6238 TOTP + hashed recovery codes, tapping Hooks.BeforeSessionIssue, challenge state via Verification. Two implementation-level reconciliations with HEAD are recorded (not re-litigations): (1) ticket 05's proposed new `SecretBox` port already exists as `@awthaq/ports` `Encryption` (AES-256-GCM + AAD over KeyProvider) — reuse it; (2) HookPoint tap registries freeze after first run, so the TwoFactor taps must ship as separate opt-in layers (Passkey.beforeUserDeleteErasure precedent) — and to avoid a fail-open composition, TwoFactor.layer must type-require a marker only the gate layer provides.

**Evidence at HEAD**

- `packages/two-factor/src/index.ts:8` — Still the verbatim placeholder at HEAD.

```ts
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

- `packages/core/src/Hooks.ts:62` — The divert seam (ticket 03, commit 3e298c8) exists; nothing taps it.

```ts
export class TwoFactorRequired extends Schema.TaggedError<TwoFactorRequired>()(
  "TwoFactorRequired",
  { userId: Schema.String, challengeId: Schema.String },
  { httpApiStatus: 401 },
) {}
```

- `packages/ports/src/Encryption.ts:101` — An AES-256-GCM AEAD port over KeyProvider already exists (tickets 17/18) — satisfies ticket 05's proposed `SecretBox`.

```ts
readonly encrypt: (plaintext: Redacted.Redacted<string>, aad: string) => Effect.Effect<string>;
readonly decrypt: (
  envelope: string,
  aad: string,
) => Effect.Effect<Redacted.Redacted<string>, DecryptionFailed | UnknownKeyId>;
```

- `packages/passkey/src/Passkey.ts:1018` — Constraint the TwoFactor taps must follow (separate opt-in tap layers).

```ts
 * **A separate export, not merged into `Passkey.layer` itself:**
 * `Hooks.BeforeUserDelete` is a module-level singleton whose tap registry
 * freezes permanently after its first `run()` (BEH-EA-024) — a real,
 * empirically-confirmed constraint (CSG-002's own resolution comment).
```

**Fix plan** — Build the TwoFactor plugin (ticket 05 §1) in 12 implementable steps: pure TOTP module, encrypted secret + hashed recovery-code stores, branded single-use challenge over Verification, enable/confirm/verify/verifyRecovery/disable/regenerate, contract, opt-in hook-tap layers enforced by the type system, events, erasure, spec + BDD.

1. Step 1 — `packages/two-factor/src/Totp.ts` (pure, zero-dep): `hotp(key: Uint8Array, counter: bigint, digits)`, `totp(key, epochSeconds, {period: 30, digits: 6})`, `verifyTotp(key, code, epochSeconds, {window: 1, lastUsedStep: Option<bigint>}) => Option<bigint /*matched step*/>` (HMAC-SHA-1 via WebCrypto `crypto.subtle` like Encryption.ts; RFC 4226 §5.3 dynamic truncation; compares every candidate step with a constant-time equality — lift `constantTimeEqual` out of packages/core/src/Sessions.ts:50 into an exported core util rather than copying); `base32Encode/base32Decode` (RFC 4648, no padding); `otpauthUri({issuer, accountName, secret, period, digits})` per the Key Uri Format. Secret = 20 random bytes (160-bit) from `Crypto.randomBytes`. No `as` casts; bigint counter math via DataView.setBigUint64.
2. Step 2 — secret at rest: use the existing `Encryption` port (packages/ports/src/Encryption.ts:101) with `aad = `two_factor_secret:${userId}`` so a ciphertext copied to another row fails to decrypt. TwoFactor declares `Encryption` as a required port (ADR-010: plugins require ports, never provide). This satisfies ticket 05's `SecretBox` requirement without a duplicate port.
3. Step 3 — persistence `packages/two-factor/src/TwoFactorStore.ts`: `TwoFactorSecrets` (`upsertPending(userId, envelope)`, `find(userId)`, `confirm(userId, now)`, `advanceLastUsedStep(userId, step)` = conditional UPDATE `WHERE last_used_step IS NULL OR last_used_step < ?` returning affected-rows so a replayed code within the window fails, `delete(userId)`, `deleteAllByUser`) and `RecoveryCodes` (`replaceAll(userId, hashes)`, `listUnused(userId)`, `markUsed(id, now)` = `UPDATE … WHERE id = ? AND used_at IS NULL` affected-rows==1, `countUnused`, `deleteAllByUser`). layerMemory (Ref) + layerSql (SqlSchema, spanPrefix `TwoFactor`). Tables: `two_factor_secret(user_id PK FK users ON DELETE CASCADE, secret_envelope TEXT NOT NULL, confirmed_at TIMESTAMP NULL, last_used_step BIGINT NULL, created_at)`, `two_factor_recovery_code(id PK, user_id FK, code_hash TEXT NOT NULL, used_at NULL, created_at)` + index on user_id; migrations declared on the plugin (`tables:` + `migrations:`) following Passkey.ts:441-539's per-dialect pattern.
4. Step 4 — `TwoFactorConfig` Context.Reference with defaults {issuer: required-ish string default "awthaq", digits: 6, period: 30s, window: 1, challengeTtl: 10 min, maxAttemptsPerChallenge: 3, recoveryCodeCount: 10, recoveryCodeLength: 10, reauthMaxAgeSeconds: 600, bypassStrategies: [] } + `TwoFactor.config(partial)`; `bypassStrategies` lets an app declare e.g. `["passkey"]` (UV passkeys are already multi-factor) — secure default is none.
5. Step 5 — branded challenge (TTE-008): `TwoFactorChallengeId = string & Brand<"TwoFactorChallengeId">`; challenge = `Verification.issue({ identifier: `two-factor-challenge:${publicId}`, ttl: challengeTtl, userId, payload: { strategy, attempt } })` with a 128-bit random `publicId` (never the userId, per ARF-009's lesson), encoded `<identifier>.<value>`. Internal `verifyCode(...) => Effect<VerifiedChallenge, ...>` is the ONLY producer of the `VerifiedChallenge` brand, and `finalizeSignIn(verified: VerifiedChallenge)` is the only caller of `sessions.issue` in this plugin — a `// @ts-expect-error` type test proves an unverified challenge cannot reach it.
6. Step 6 — `TwoFactor` service (`packages/two-factor/src/TwoFactor.ts`, `AuthPlugin.Service<TwoFactor, TwoFactorShape>()("twoFactor", { apiVersion: 1, contract: TwoFactorApi, tables: ["two_factor_secret","two_factor_recovery_code"], migrations })`): `enable({userId, currentSessionId})` → requires fresh `authenticatedAt` via `Sessions.isStale` (same gate as Passkey.ts:560-583) else `TwoFactorReauthRequired`; refuses if already confirmed; stores a pending encrypted secret; returns `{ secret: Redacted<base32>, otpauthUri: Redacted<string> }`. `confirm({userId, code})` → verifies against the pending secret, sets confirmed_at, mints recovery codes (step 8), returns them once. `verify({challengeId, code, ip?, userAgent?})`, `verifyRecovery({challengeId, recoveryCode, ...})` → IssuedSession. `disable({userId, currentSessionId, code})` (fresh auth + valid TOTP or recovery code; deletes secret + codes). `regenerateRecoveryCodes({userId, code})`. `status(userId)` → `{ enabled, remainingRecoveryCodes }`.
7. Step 7 — verify algorithm (follows ticket 05: consume the challenge BEFORE checking the code, so BEH-EA-059 replay events fire on every bad/expired/reused challenge): decode + prefix-validate challengeId (else `InvalidTwoFactorCode`) → rate limits (`two-factor:verify:${publicId}` 3/10s per ticket 05, plus `two-factor:verify:user:${userId}` 10/15min so re-minting challenges via repeated sign-in cannot multiply the budget) → `verification.consume` → decrypt secret → `verifyTotp` + `advanceLastUsedStep` (replay within the ±1 window rejected, RFC 6238 §5.2) → on success `finalizeSignIn`; on a wrong code, if `attempt + 1 < maxAttemptsPerChallenge` issue a fresh challenge carrying `attempt + 1` and fail `InvalidTwoFactorCode { challengeId: next }` (retry UX without ever re-using a consumed challenge), otherwise fail `InvalidTwoFactorCode {}` (client restarts sign-in). Publish `auth.twoFactor.challengeFailed` on each failure.
8. Step 8 — recovery codes (BCR-001/ACS-010): 10 codes × 10 chars from a 32-symbol unambiguous alphabet via rejection sampling over `Crypto.randomBytes` (50 bits each), displayed `xxxxx-xxxxx`, normalized (strip `-`, lowercase) before hashing with the existing `PasswordHasher` port (ticket 05). `verifyRecovery` verifies the input against EVERY unused hash (no early exit → no which-index timing oracle), then `markUsed` (optimistic single-use); publishes `auth.twoFactor.recoveryCodeUsed { userId, remaining }`. `regenerateRecoveryCodes` replaces all atomically inside `SqlTransaction.withTransaction`.
9. Step 9 — hook taps as separate opt-in layers (HookPointFrozen constraint, Passkey.ts:1018): `TwoFactor.sessionGate` taps `Hooks.BeforeSessionIssue` (confirmed secret and strategy ∉ bypassStrategies → `Diverted(new Hooks.TwoFactorRequired({ userId, challengeId }))`); `TwoFactor.credentialResetGate` taps the new `Hooks.BeforeCredentialReset` (ARF-005); `TwoFactor.beforeUserDeleteErasure` taps `Hooks.BeforeUserDelete` (secrets + codes deleted, joins the caller's transaction like Passkey's). Fail-closed composition: `TwoFactor.layer` requires a marker service `TwoFactorGateInstalled` that ONLY `TwoFactor.sessionGate` provides, so composing the plugin without the gate is a compile error (type-system-first plugins), not a silent MFA bypass.
10. Step 10 — contract `packages/two-factor/src/TwoFactorApi.ts`: public group `twoFactor` (POST /two-factor/verify, POST /two-factor/verify-recovery → SessionContract.SessionDto) and authenticated dotted sub-group `twoFactor.account` with group-level `.middleware(Api.Authentication)` (EHA-007 convention: POST /two-factor/enable, /two-factor/confirm, /two-factor/disable, /two-factor/recovery-codes/regenerate, GET /two-factor/status); both groups `.middleware(Api.CsrfProtection)`. Errors as plain arrays (see PasswordApi.ts:154-159 note): `InvalidTwoFactorCode`(401, optional challengeId), `TwoFactorAlreadyEnabled`(409), `TwoFactorNotEnabled`(409), `TwoFactorReauthRequired`(403, maxAgeSeconds), `Api.RateLimited`. Handlers resolve `ClientAddress` + user-agent and set the session cookie (bearer mode once MNA-001 lands).
11. Step 11 — events + audit (AOMS-003): extend `AuthEvent` (packages/core/src/AuthEvents.ts) with `auth.twoFactor.enabled`, `auth.twoFactor.disabled`, `auth.twoFactor.challengeFailed`, `auth.twoFactor.recoveryCodeUsed`, `auth.twoFactor.recoveryCodesRegenerated` (ticket 05's `two_factor.*` names mapped onto the registry's existing `auth.<domain>.<verb>` convention); extend `AuditLog.actorOf`'s exhaustive match (AuditLog.ts:73). `finalizeSignIn` publishes `auth.user.signedIn` (strategy = the first factor's strategy from the challenge payload) + `auth.session.issued` and runs `Hooks.AfterSignIn`. Register every rate-limit rule in `RateLimitsRegistry` under group `twoFactor` with the SAME key functions enforcement uses (RBS-006 pattern).
12. Step 12 — package wiring + spec: `packages/two-factor/package.json` deps (@awthaq/core/api/ports/server), `src/index.ts` exports (TwoFactor, TwoFactorApi, Totp, stores), README plugin-table row, README.md:232 stub list updated; new `spec/behaviors/28-two-factor.md` with fresh BEH-EA ids (next free after BEH-EA-220: TOTP algorithm; divert on confirmed factor; single-use challenge + attempt budget; recovery codes hashed/single-use/show-once; enable requires fresh auth; secret encrypted at rest with row-bound AAD; credential-reset gate), `spec/models/06-two-factor-totp.md` status → implemented, `spec/traceability.md` + `spec/behaviors/index.yaml`; BDD `features/features/05-authentication-methods/28-two-factor.feature` + step definitions.

*Files:* `packages/two-factor/src/Totp.ts (new)`; `packages/two-factor/src/TwoFactorStore.ts (new)`; `packages/two-factor/src/TwoFactor.ts (new)`; `packages/two-factor/src/TwoFactorApi.ts (new)`; `packages/two-factor/src/index.ts`; `packages/two-factor/package.json`; `packages/core/src/AuthEvents.ts`; `packages/core/src/AuditLog.ts`; `packages/core/src/Sessions.ts (export constantTimeEqual)`; `spec/behaviors/28-two-factor.md (new)`; `spec/models/06-two-factor-totp.md`; `spec/traceability.md`; `spec/behaviors/index.yaml`; `features/features/05-authentication-methods/28-two-factor.feature (new)`; `README.md`

*Tests (write first):*

- packages/two-factor/test/Totp.test.ts — FIRST: RFC 4226 Appendix D vectors (secret "12345678901234567890", counters 0..9 → 755224, 287082, 359152, 969429, 338314, 254676, 287922, 162583, 399871, 520489) and RFC 6238 Appendix B SHA-1 vectors (T=59 → 94287082, T=1111111109 → 07081804, 8 digits); property test base32 round-trip; window ±1 accepts adjacent steps, rejects ±2.
- packages/two-factor/test/TwoFactor.test.ts — 'enable+confirm then password signIn fails TwoFactorRequired and verify with a valid TOTP issues a session'; 'a reused code in the same step is rejected'; 'wrong code rotates the challenge until maxAttemptsPerChallenge, then requires restart'; 'a consumed challengeId replays as InvalidTwoFactorCode and publishes auth.token.replay'; 'recovery code works exactly once'; 'enable with a stale session fails TwoFactorReauthRequired'; 'unconfirmed (pending) secret never diverts'; 'secret row is an Encryption envelope, never the base32 secret'; type test: finalizeSignIn rejects an unverified challenge (@ts-expect-error).
- packages/two-factor/test/TwoFactorSql.test.ts — migrations apply; conditional last_used_step update is race-safe; erasure layer deletes both tables' rows on user delete.
- Composition type test: Auth.make with TwoFactor.layer but without TwoFactor.sessionGate fails to type-check.
- BDD 28-two-factor.feature: enrol, sign in with TOTP, sign in with recovery code, disable.

*Acceptance:*

- A composition with TwoFactor.layer + TwoFactor.sessionGate diverts password/OAuth/passkey sign-in of an enrolled user with 401 TwoFactorRequired{challengeId} and mints no session until /two-factor/verify succeeds.
- RFC 4226/6238 vectors pass; a code cannot be used twice; codes outside ±1 step fail.
- two_factor_secret.secret_envelope decrypts only with the matching userId AAD; no plaintext secret or recovery code is ever persisted or logged.
- Omitting TwoFactor.sessionGate is a type error.
- pnpm check green; spec:verify:strict green with the new BEH ids traced to tests.

*Spec refs:* BEH-EA-093, BEH-EA-059, BEH-EA-024, new BEH-EA-221+ (spec/behaviors/28-two-factor.md) · *Effort:* XL · *Depends on:* RBS-006

**Recommended status:** `ready-for-agent`

#### CSD-005 — MFA is an empty placeholder — a stuffed valid credential yields unchallengeable account takeover

`medium` · `security` · `two-factor` · [.issues/medium/CSD-005-credential-stuffing-defense-specialist.md](../../.issues/medium/CSD-005-credential-stuffing-defense-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **THS-001**

Same root cause as THS-001 (no MFA plugin). Its secondary ask — 'expose a composable post-credential-verify hook' — is already fixed by commit 3e298c8 (Hooks.BeforeSessionIssue wired at every session-minting flow).

**Evidence at HEAD**

- `packages/two-factor/src/index.ts:8` — Still the verbatim placeholder at HEAD.

```ts
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

- `packages/password/src/Password.ts:862` — Password.signIn consults BeforeSessionIssue (also OAuth.ts:846, Passkey.ts:825).

```ts
const point = yield* beforeSessionIssue.run({ userId: user.id, strategy: "password" });
if (point._tag === "Diverted") {
  return yield* Effect.fail(point.value);
}
const issued = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
```

**Recommended status:** `resolved`

#### ACS-010 — TOTP, API-key, and magic-link crypto surfaces not yet implemented

`info` · `compliance` · `two-factor` · [.issues/info/ACS-010-applied-cryptography-specialist.md](../../.issues/info/ACS-010-applied-cryptography-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **THS-001**

Info-level 'crypto not reviewable yet' for TOTP (api-key/magic-link parts are covered by BAM-007 and slice 09). Its disciplines are folded into THS-001's acceptance: 160-bit secrets from Crypto.randomBytes, constant-time code comparison, hashed recovery codes, encrypted secrets.

**Evidence at HEAD**

- `packages/two-factor/src/index.ts:8` — Still the verbatim placeholder at HEAD.

```ts
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

**Recommended status:** `resolved`

#### BCR-001 — Backup codes entirely absent; two-factor package is an honest export{} placeholder

`info` · `architecture` · `two-factor` · [.issues/info/BCR-001-backup-codes-recovery-specialist.md](../../.issues/info/BCR-001-backup-codes-recovery-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **THS-001**

Backup codes are part of ticket 05's TwoFactor build; THS-001 step 8 specifies generation, hashing, single-use consume, regeneration and show-once. The README pointer it asks for is superseded by shipping.

**Evidence at HEAD**

- `packages/two-factor/src/index.ts:8` — Still the verbatim placeholder at HEAD.

```ts
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

**Recommended status:** `resolved`

#### ECF-009 — No bounded-concurrency primitives anywhere; 2FA rate limiting domain absent

`info` · `architecture` · `two-factor` · [.issues/info/ECF-009-effect-concurrency-fiber-specialist.md](../../.issues/info/ECF-009-effect-concurrency-fiber-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **THS-001**

2FA attempt throttling is THS-001 step 7 (per-challenge + per-user RateLimiter rules, attempt counter in the challenge payload). The generic 'first Semaphore' ask belongs to ECF-001/ECF-004 in another slice; the mail-dispatch Semaphore in ERS-002 is this slice's only bounded-concurrency need.

**Evidence at HEAD**

- `packages/two-factor/src/index.ts:8` — Still the verbatim placeholder at HEAD.

```ts
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

**Recommended status:** `resolved`

#### TTE-008 — Two-factor challenge state machine absent — the flagship illegal-state encoding cannot exist yet

`info` · `architecture` · `two-factor` · [.issues/info/TTE-008-typescript-type-level-engineer.md](../../.issues/info/TTE-008-typescript-type-level-engineer.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **THS-001**

The branded challenge requirement is THS-001 step 5 (`TwoFactorChallengeId` + `VerifiedChallenge` brand, finalizeSignIn only accepts the verified brand, proven by a @ts-expect-error test).

**Evidence at HEAD**

- `packages/two-factor/src/index.ts:8` — Still the verbatim placeholder at HEAD.

```ts
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

- `packages/core/src/Hooks.ts:62` — The divert seam (ticket 03, commit 3e298c8) exists; nothing taps it.

```ts
export class TwoFactorRequired extends Schema.TaggedError<TwoFactorRequired>()(
  "TwoFactorRequired",
  { userId: Schema.String, challengeId: Schema.String },
  { httpApiStatus: 401 },
) {}
```

**Recommended status:** `resolved`

### Workstream `passwordless-magic-link-email-otp`

#### BAM-007 — two-factor, magic-link, and api-key plugins are empty placeholders — no migration target for MFA users

`high` · `api` · `two-factor` · [.issues/high/BAM-007-better-auth-migration-specialist.md](../../.issues/high/BAM-007-better-auth-migration-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high) · canonical for MLO-005, FAMS-007, IC-009

Confirmed for two-factor (built via THS-001) and magic-link (built here). Per ticket 05 §4 the api-key portion is out of scope for this slice and belongs to ticket 10 (machine-service-identity, slice 09-ports-apikey-cli). This entry is the canonical MagicLink build; MLO-005's prefetch-safety requirements are folded in.

**Evidence at HEAD**

- `packages/two-factor/src/index.ts:8` — Still the verbatim placeholder at HEAD.

```ts
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

- `packages/magic-link/src/index.ts:8` — Still the verbatim placeholder at HEAD.

```ts
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

- `README.md:232` — README already discloses the stubs (IC-009's ask).

```ts
`two-factor`, `magic-link`, `api-key`, `cli`, and `next` remain stub packages
```

**Fix plan** — Ship `@awthaq/magic-link`'s MagicLink plugin on the Verification substrate, POST-only consumption, fragment-carried token, consulting BeforeSessionIssue (ARF-005 Fix A).

1. packages/magic-link/src/MagicLink.ts: `AuthPlugin.Service<MagicLink, MagicLinkShape>()("magicLink", { apiVersion: 1, contract: MagicLinkApi, tables: [] })` (reuses verification_tokens, spec/models/04). `MagicLinkConfig` Context.Reference: `ttl` 10 min, `allowSignUp` true, `markEmailVerified` true, `link: (token: string) => string` (default `${baseURL}/magic-link#token=${token}` — token in the URL FRAGMENT so it never reaches server logs/Referer), `rateLimits` overridable.
2. `requestLink({ email, ip })`: per-IP (30/15min) then per-normalized-email (5/15min, TMS-006 normalizer) rate limits; one user lookup; ALWAYS 202; issue + mail forked through the mail dispatcher (ERS-002) with identifier `magic-link:${publicId}` (128-bit random public id, userId on the row or `payload: { email }` for a sign-up) using the verification-token-delivery helper (MLO-009) so mail data = { url, token: Redacted, expiresAt }.
3. `verify({ token, ip, userAgent })` — POST /magic-link/verify ONLY (no GET route consumes a token: MLO-005 prefetch defense): decode + prefix check → rate limit → `verification.consume` → find-or-create user (creation runs `Hooks.BeforeSignUp` veto, only if `allowSignUp`) → `users.verifyEmail` (mailbox proven) → `Hooks.BeforeSessionIssue.run({ userId, strategy: "magicLink" })` (Diverted → fail TwoFactorRequired) → `sessions.issue({ userId, request, amr: ["email"] })` → events `auth.user.signedIn{strategy:"magicLink"}`, `auth.session.issued` → `Hooks.AfterSignIn`. Never touches an existing password credential (spec/models/04 `linkPolicy` concern).
4. packages/magic-link/src/MagicLinkApi.ts: group `magicLink` (POST /magic-link/request → 202, POST /magic-link/verify → SessionDto) with `.middleware(Api.CsrfProtection)`; errors `TokenConsumed`(410), `Api.RateLimited`, `HookPoint.HookAborted`, `Hooks.TwoFactorRequired`.
5. Handlers mirror PasswordHandlers (ClientAddress + user-agent, cookie or bearer delivery per MNA-001).
6. Docs: package README documents the interstitial pattern (the app page reads the fragment and POSTs it after a user click) and why GET links are unsafe; update README.md:232 stub list and the plugin table; update spec/models/04 status; new spec/behaviors/29-magic-link.md with BEH-EA ids (uniform 202; POST-only single-use consumption; verifies email; consults BeforeSessionIssue).
7. api-key: no work here — cross-reference ticket 10 / slice 09.

*Files:* `packages/magic-link/src/MagicLink.ts (new)`; `packages/magic-link/src/MagicLinkApi.ts (new)`; `packages/magic-link/src/index.ts`; `packages/magic-link/package.json`; `packages/magic-link/README.md`; `README.md`; `spec/behaviors/29-magic-link.md (new)`; `spec/models/04-magic-link.md`; `features/features/05-authentication-methods/29-magic-link.feature (new)`

*Tests (write first):*

- packages/magic-link/test/MagicLink.test.ts — FIRST: 'requestLink answers identically for known/unknown email and mails only the known one (Mailer.layerMemory), with no userId in the token'; 'verify signs in, marks emailVerified, and a replay fails TokenConsumed'; 'enrolled TOTP user diverts to TwoFactorRequired'; 'allowSignUp=false never creates a user'; 'expired link fails TokenConsumed'.
- packages/magic-link/test/AuthHttp.test.ts — 'no GET route under /magic-link exists' (walk the composed HttpApi's endpoints).
- BDD 29-magic-link.feature.

*Acceptance:*

- An emailed link signs a user in exactly once via POST; GET prefetch cannot consume it; 2FA-enrolled users are diverted; mail data carries url + expiresAt; README no longer lists magic-link as a stub.

*Spec refs:* BEH-EA-064, BEH-EA-093, BEH-EA-057, new BEH-EA (29-magic-link.md) · *Effort:* L · *Depends on:* MLO-009, ERS-002, TMS-006

**Recommended status:** `ready-for-agent`

#### SOS-001 — SMS/phone OTP factor is absent from every implemented package; nearest-sibling plugins are empty placeholders

`high` · `architecture` · `two-factor` · [.issues/high/SOS-001-sms-otp-specialist.md](../../.issues/high/SOS-001-sms-otp-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high) · canonical for SAM-009

No OTP/SMS code anywhere. Ticket 05 §3 decision: ship the shared EmailOtp channel-OTP substrate now; do NOT ship SMS in this pass (a later, explicitly degraded plugin, never an account's sole factor, emitting a distinguishable event). The SMS deferral is flagged by ticket 05 for the user's sanity-check (see Decisions) but does not block the EmailOtp work.

**Evidence at HEAD**

- `packages/two-factor/src/index.ts:8` — Still the verbatim placeholder at HEAD.

```ts
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

- `packages/magic-link/src/index.ts:8` — Still the verbatim placeholder at HEAD.

```ts
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

- `packages/core/src/Verification.ts:94` — Verification can only mint 256-bit hex values — no numeric-code format for an OTP substrate yet.

```ts
readonly issue: (input: {
  readonly identifier: string;
  readonly ttl: Duration.Duration;
  readonly payload?: unknown;
  /** BCR-003: attached when the caller already knows the real user this token concerns — lets a later account deletion sweep it. */
  readonly userId?: UserId;
}) => Effect.Effect<
  { readonly token: VerificationTokenView; readonly value: Redacted.Redacted<string> },
```

**Fix plan** — Ship the EmailOtp substrate (6-digit, hashed, attempt-budgeted, resend-windowed) over Verification; record SMS as deferred.

1. packages/core/src/Verification.ts: `issue` gains optional `format?: { readonly _tag: "Numeric"; readonly digits: number }` (default = today's 256-bit hex); numeric codes drawn uniformly via rejection sampling over `Crypto.randomBytes`; stored hashed like every other value (document: a 6-digit hash is offline-brute-forceable, acceptable only because TTL ≤ 5 min and rows are single-use). Cross-slice with 01-core.
2. packages/magic-link/src/EmailOtp.ts: second plugin class in the same package (recommended — shares the channel-credential module with MagicLink; see Decisions for the one-vs-two-plugin note) `AuthPlugin.Service<EmailOtp, EmailOtpShape>()("emailOtp", …)`; `EmailOtpConfig` {digits 6, ttl 5 min, maxAttempts 3, resendWindow 60 s, allowSignUp true}.
3. `requestCode({ email, ip })`: per-IP + normalized-email rate limits; resend window via `verification.reserve({ identifier: `email-otp-resend:${normalized}`, ttl: resendWindow })`; always 202; issue `{ identifier: `email-otp:${normalized}`, format: Numeric(6) }` + mail via dispatcher (template `email-otp`, data { code: Redacted, expiresAt }).
4. `verify({ email, code, ip, userAgent })`: attempt budget = RateLimiter key `email-otp:attempts:${normalized}` limit maxAttempts window ttl (exceeding ≡ invalidation until expiry) → consume → find-or-create → verifyEmail → BeforeSessionIssue(strategy "emailOtp") → session (amr ["otp","email"]) → events.
5. packages/magic-link/src/EmailOtpApi.ts: group `emailOtp` POST /email-otp/request, /email-otp/verify; CsrfProtection.
6. SMS: add a short 'Deferred: SMS OTP' section to spec/models/05-email-otp.md / roadmap citing NIST SP 800-63B-4 restricted status and ticket 05 §3 (future plugin, never sole factor, `factor.sms.used` event).

*Files:* `packages/core/src/Verification.ts`; `packages/magic-link/src/EmailOtp.ts (new)`; `packages/magic-link/src/EmailOtpApi.ts (new)`; `spec/behaviors/30-email-otp.md (new)`; `spec/models/05-email-otp.md`; `spec/roadmap.md`

*Tests (write first):*

- packages/core/test/Verification.test.ts — FIRST: 'numeric format yields exactly N digits, uniform (chi-square over 10k samples)'.
- packages/magic-link/test/EmailOtp.test.ts — 'correct code signs in once'; 'fourth wrong attempt is RateLimited even with the correct code'; 'resend within window does not mint a second code'; 'unknown email answers 202 and mails nothing'.

*Acceptance:*

- A 6-digit emailed code signs a user in; ≤3 guesses per code; uniform responses; SMS deferral recorded in spec.

*Spec refs:* BEH-EA-057, BEH-EA-063, BEH-EA-064, new BEH-EA (30-email-otp.md) · *Effort:* L · *Depends on:* BAM-007, ERS-002, TMS-006

**Recommended status:** `ready-for-agent`

#### MLO-005 — packages/magic-link is an empty placeholder: no prefetch defense surface exists despite being the package's stated purpose

`medium` · `security` · `magic-link` · [.issues/medium/MLO-005-magic-link-email-otp-specialist.md](../../.issues/medium/MLO-005-magic-link-email-otp-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **BAM-007**

Same root cause as BAM-007 (magic-link placeholder). Its specific mitigations — POST-only consumption, token never in a GET query string, interstitial documentation, EmailOtp fallback — are explicit steps/acceptance in BAM-007 and SOS-001.

**Evidence at HEAD**

- `packages/magic-link/src/index.ts:8` — Still the verbatim placeholder at HEAD.

```ts
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

**Recommended status:** `resolved`

#### IC-009 — Magic-link, api-key, two-factor plugins and CLI are empty placeholders

`low` · `dx` · `magic-link` · [.issues/low/IC-009-iain-collins.md](../../.issues/low/IC-009-iain-collins.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **BAM-007**

Magic-link/two-factor portions are BAM-007/THS-001; the README-status annotation it asks for already exists (README.md:232, e6b3237); api-key and CLI placeholders belong to slice 09 (ticket 10 / ECS-*).

**Evidence at HEAD**

- `packages/magic-link/src/index.ts:8` — Still the verbatim placeholder at HEAD.

```ts
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

- `README.md:232` — README annotation already present (commit e6b3237).

```ts
`two-factor`, `magic-link`, `api-key`, `cli`, and `next` remain stub packages
```

**Recommended status:** `resolved`

#### FAMS-007 — Passwordless email-link sign-in absent; magic-link is an empty placeholder

`info` · `architecture` · `magic-link` · [.issues/info/FAMS-007-firebase-auth-migration-specialist.md](../../.issues/info/FAMS-007-firebase-auth-migration-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **BAM-007**

Firebase email-link parity = the MagicLink plugin BAM-007 builds on Verification (spec/models/04).

**Evidence at HEAD**

- `packages/magic-link/src/index.ts:8` — Still the verbatim placeholder at HEAD.

```ts
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

**Recommended status:** `resolved`

#### SAM-009 — Passwordless and OTP migration targets do not exist yet (M7 placeholders)

`info` · `architecture` · `magic-link` · [.issues/info/SAM-009-supabase-auth-migration-specialist.md](../../.issues/info/SAM-009-supabase-auth-migration-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **SOS-001**

Supabase OTP/magic-link targets = EmailOtp (SOS-001) + MagicLink (BAM-007); SMS deferred per ticket 05 §3.

**Evidence at HEAD**

- `packages/magic-link/src/index.ts:8` — Still the verbatim placeholder at HEAD.

```ts
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

- `packages/two-factor/src/index.ts:8` — Still the verbatim placeholder at HEAD.

```ts
// Empty placeholder — awthaq is pre-implementation. No exported symbols yet.

export {};
```

**Recommended status:** `resolved`

## Closed without work

| ID | Level | Verdict | Reason | Evidence |
|---|---|---|---|---|
| MLO-005 | medium | DUPLICATE | Duplicate of BAM-007: Same root cause as BAM-007 (magic-link placeholder) | `packages/magic-link/src/index.ts:8` |
| IC-009 | low | DUPLICATE | Duplicate of BAM-007: Magic-link/two-factor portions are BAM-007/THS-001; the README-status annotation it asks for already exists (README.md:232, e6b3237); api-key and CLI placeholders belong to slice 09 (ticket 10 / ECS-*). | `packages/magic-link/src/index.ts:8` |
| FAMS-007 | info | DUPLICATE | Duplicate of BAM-007: Firebase email-link parity = the MagicLink plugin BAM-007 builds on Verification (spec/models/04). | `packages/magic-link/src/index.ts:8` |
| SAM-009 | info | DUPLICATE | Duplicate of SOS-001: Supabase OTP/magic-link targets = EmailOtp (SOS-001) + MagicLink (BAM-007); SMS deferred per ticket 05 §3. | `packages/magic-link/src/index.ts:8` |
| RBS-005 | medium | ALREADY-FIXED | `25d991e` — Commit 25d991e (CSD-001) applies HttpClientResponse.filterStatusOk | `packages/password/src/Password.ts:316` |
| ARF-010 | low | ALREADY-FIXED | `a3b7255` — Commit a3b7255 (AGA-001/NHS-003) added requestResetByIp (30/15min) resolved via ClientAddress and registered in the RateLimits registry. | `packages/password/src/Password.ts:884` |
| TSS-007 | low | DUPLICATE | Duplicate of TMS-005: Same root cause (signUp EmailAlreadyExists oracle vs BEH-EA-086); its docs-only fix is option A of TMS-005's decision. | `packages/password/src/Password.ts:748` |
| MA-010 | low | DUPLICATE | Duplicate of ERS-002: Same forkDetach+ignore root cause; its asks (scoped ownership, bounded fan-out, flush-or-log on shutdown) are ERS-002's FiberSet + Semaphore + drain finalizer. | `packages/password/src/Password.ts:775` |
| MLO-007 | low | DUPLICATE | Duplicate of ERS-002: Same root cause; the requested observable failure is ERS-002's `auth.mail.failed` event. | `packages/password/src/Password.ts:783` |
| AGA-007 | low | ALREADY-FIXED | `349e220` — The premise ('no per-IP spray dimension anywhere; network throttling silently delegated to the gateway') no longer holds: per-IP rules for signIn (349e220), signUp/requestReset (a3b7255) and verifyEmail (cbf899d), resolved through the ClientAddress port whose layerTrustedProxy makes them proxy-safe | `packages/password/src/Password.ts:233` |
| SMS-004 | medium | DUPLICATE | Duplicate of CSD-003: Identical root cause (no call site passes request metadata to sessions.issue) and identical fix. | `packages/password/src/Password.ts:866` |
| ARF-003 | medium | ALREADY-FIXED | `bd1625c` — Commit bd1625c (TSS-001/002, EEM-001, MLO-001) forks both sends off the response path | `packages/password/src/Password.ts:903` |
| APS-004 | medium | DUPLICATE | Duplicate of ARF-002: Identical root cause and identical recommended fix (policy check before consume) as ARF-002; partially mitigated on SQL by 34caae8. | `packages/password/src/Password.ts:986` |
| TMS-008 | low | ALREADY-FIXED | `34caae8` — Commit 34caae8 (ARF-001/RRC-002) wraps confirmReset's consume, credential update and revokeAll in SqlTransaction.withTransaction, satisfying INV-EA-009 on SQL deployments | `packages/password/src/Password.ts:986` |
| APS-005 | medium | ALREADY-FIXED | `2761e8d` — changePassword now revokes every other session and supersedes the caller's own (2761e8d, BEH-EA-053) and publishes auth.password.changed + auth.session.revoked (45325bb). | `packages/password/src/Password.ts:1130` |
| CSD-008 | medium | ALREADY-FIXED | `2761e8d` — Same fix as APS-005 (2761e8d). | `packages/password/src/Password.ts:1137` |
| AR-002 | medium | WONTFIX-CANDIDATE | Architectural preference, not a defect: awthaq deliberately follows the better-auth/Lucia one-shot-endpoint shape (ADR-003 HttpApi-as-contract) | `packages/password/src/PasswordApi.ts:149` |
| CDS-003 | medium | ALREADY-FIXED | `409334e` — Commit 409334e wired Api.CsrfProtection onto every mutating production endpoint including the whole password group; the middleware's Sec-Fetch-Site/Origin check plus signed double-submit is an explicit login-CSRF defense that does not depend on JSON-only decoding or absent CORS. | `packages/password/src/PasswordApi.ts:254` |
| RBS-002 | medium | ALREADY-FIXED | `cbf899d` — Commit cbf899d (APS-003) added per-IP and per-identifier verifyEmail rules, registry entries and Api.RateLimited on the contract. | `packages/password/src/PasswordApi.ts:204` |
| TMS-010 | low | ALREADY-FIXED | `cbf899d` — Fixed by cbf899d (per-IP + per-identifier) | `packages/password/src/Password.ts:1043` |
| CSD-005 | medium | DUPLICATE | Duplicate of THS-001: Same root cause as THS-001 (no MFA plugin) | `packages/two-factor/src/index.ts:8` |
| ACS-010 | info | DUPLICATE | Duplicate of THS-001: Info-level 'crypto not reviewable yet' for TOTP (api-key/magic-link parts are covered by BAM-007 and slice 09) | `packages/two-factor/src/index.ts:8` |
| BCR-001 | info | DUPLICATE | Duplicate of THS-001: Backup codes are part of ticket 05's TwoFactor build; THS-001 step 8 specifies generation, hashing, single-use consume, regeneration and show-once | `packages/two-factor/src/index.ts:8` |
| ECF-009 | info | DUPLICATE | Duplicate of THS-001: 2FA attempt throttling is THS-001 step 7 (per-challenge + per-user RateLimiter rules, attempt counter in the challenge payload) | `packages/two-factor/src/index.ts:8` |
| TTE-008 | info | DUPLICATE | Duplicate of THS-001: The branded challenge requirement is THS-001 step 5 (`TwoFactorChallengeId` + `VerifiedChallenge` brand, finalizeSignIn only accepts the verified brand, proven by a @ts-expect-error test). | `packages/two-factor/src/index.ts:8` |
