# Passwords, 2FA, Magic Links, API Keys & Captcha — Research

Covers Q52 (password defaults), Q53 (PasswordHasher capability), Q57 (magic link / email OTP), Q58 (2FA/TOTP + recovery codes + pre-auth state), Q59 (API keys), Q63 (captcha plugin). Verified against primary sources as of 2026-09.

## TL;DR

- **OWASP Password Storage CS (current)**: Argon2id first — five equivalent configs (`m=19456 KiB, t=2, p=1` is the balanced pick); scrypt fallback `N=2^17, r=8, p=1`; bcrypt **legacy-only**, cost ≥ 10, 72-byte input limit; PBKDF2 only when FIPS-140 required (600,000 iters HMAC-SHA-256). [OWASP CS](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- **NIST SP 800-63B-4 (final, Aug 2025 — supersedes 63B-3)**: min 15 chars when password is the sole factor, min 8 within MFA; permit ≥ 64; **no composition rules, no periodic rotation**; mandatory blocklist comparison of the entire password; mandatory rate limiting; salt ≥ 32 bits; peppering (keyed post-hash) SHOULD; NFC normalization for Unicode. [NIST 63B-4 §3.1.1.2](https://pages.nist.gov/800-63-4/sp800-63b.html#passwordver)
- **HIBP Pwned Passwords**: free k-anonymity range API, `GET https://api.pwnedpasswords.com/range/{first5-SHA1}` — no key required, ~800 suffixes returned, `Add-Padding` header defeats size-fingerprinting, full corpus downloadable for self-hosting. [HIBP API v3](https://haveibeenpwned.com/API/v3#PwnedPasswords)
- **Hashing libraries**: `@node-rs/argon2` v2.2.1 (MIT, Rust/napi) is the fastest Node/Bun option; `hash-wasm` v4.12.0 (MIT, zero-dep pure WASM, runs in browsers/Node/Deno/Web Workers) brings **argon2id to edge runtimes**; WebCrypto itself has **no argon2/scrypt/bcrypt** — PBKDF2 only. [npm](https://www.npmjs.com/package/@node-rs/argon2), [hash-wasm](https://github.com/Daninet/hash-wasm), [CF WebCrypto table](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- **Rehash-on-login is the standard upgrade path** (OWASP); store algorithm+params with each hash (PHC string format) so `needsRehash` is decidable per row. [OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [PHC spec](https://github.com/P-H-C/phc-string-format/blob/master/phc-sf-spec.md)
- **TOTP** = HOTP with time moving factor: SHA-1 HMAC, 30 s step, T0=0, ≥ 6 digits, ± 1 step verification window, secrets of HMAC-output length (160 bits for SHA-1), OTPs single-use, brute-force throttling mandatory in practice. [RFC 6238 §5.2](https://www.rfc-editor.org/rfc/rfc6238), [RFC 4226 §7.3](https://datatracker.ietf.org/doc/html/rfc4226)
- **better-auth 2FA pre-auth pattern**: password accepted → pending session **discarded**, signed "2FA challenge" cookie (10 min default) issued → verify TOTP/OTP/backup-code → session cookie set. Recovery codes: 10 × 10-char, hashed, deleted on use. Failed attempts counted per-account across all factors, `429 ACCOUNT_TEMPORARILY_LOCKED`. [2FA docs](https://www.better-auth.com/docs/plugins/2fa), [source](https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/plugins/two-factor/index.ts)
- **SMS OOB is "restricted" in NIST 63B-4** (SIM-swap/number-porting risk indicators SHOULD be checked, alternatives SHALL exist); email is **prohibited** as an OOB authenticator entirely — magic-link email verification is fine because it is email confirmation, not OOB auth. [NIST 63B-4 §3.1.3](https://pages.nist.gov/800-63-4/sp800-63b.html#out-of-band)
- **Magic links**: better-auth defaults — 300 s TTL, **atomically consumed on first verification attempt** (multi-attempt redemption removed), token stored hashed (opt-in), click → session + redirect. [magic-link docs](https://www.better-auth.com/docs/plugins/magic-link)
- **API keys converge on one shape**: visible prefix + high-entropy secret, **shown once at create**, SHA-256 hash at rest (fast indexed lookup — not a password KDF), scopes/permissions, optional expiry, immediate revocation, rotation grace (Stripe: both keys valid ≤ 7 days). [Stripe](https://docs.stripe.com/keys), [better-auth apiKey](https://www.better-auth.com/docs/plugins/api-key)
- **Captcha**: client widget token must be verified server-side (Turnstile `siteverify`: token valid 300 s, single-use; hCaptcha same shape). Plugin = capability (`CaptchaVerifier`) + pre-signup/pre-signin hook with explicit fail-open/fail-closed policy. [Turnstile](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/), [hCaptcha](https://docs.hcaptcha.com/)

---

## Questions answered

### Q52 — Password: default algorithm & parameters, rehash-on-login, policy defaults, breach checking

**Evidence.**

*OWASP Password Storage Cheat Sheet (retrieved 2026-09)* — normative baseline for new systems:

| Algorithm | Status | Parameters |
|---|---|---|
| Argon2id | preferred | any of: `m=47104, t=1, p=1` · `m=19456, t=2, p=1` · `m=12288, t=3, p=1` · `m=9216, t=4, p=1` · `m=7168, t=5, p=1` (all "equal level of defense", CPU↔RAM tradeoff) |
| scrypt | when argon2 unavailable | `N=2^17, r=8, p=1` (128 MiB) — or `N=2^16,p=2 / 2^15,p=3 / 2^14,p=5 / 2^13,p=10` equivalents |
| bcrypt | legacy only | cost ≥ 10, enforce ≤ 72-byte input; if pre-hashing: `bcrypt(base64(hmac-sha384(password, pepper)))` to avoid null-byte truncation & shucking |
| PBKDF2 | FIPS-140 only | 600,000 (SHA-256) / 210,000 (SHA-512) iterations |

Also from OWASP: a hash should take **< 1 s** (tune per server, higher work factor = DoS surface on login), salts are managed by libraries, **peppering** (shared secret stored outside the DB; HMAC post-hash) is defense-in-depth, and work-factor upgrades happen at next login ("The most common approach to upgrading the work factor is to wait until the user next authenticates, then re-hash"). Hashes must store algorithm+work-factor — OWASP points to the [PHC string format](https://github.com/P-H-C/phc-string-format/blob/master/phc-sf-spec.md) (`$argon2id$v=19$m=19456,t=2,p=1$...`) as the interoperable encoding. Hash libraries must accept full Unicode/NULL bytes without entropy reduction.

*NIST SP 800-63B-4* (final published 2025; the [63-3 series was superseded Aug 1, 2025](https://pages.nist.gov/800-63-3/sp800-63b.html)) — §3.1.1.2 Password Verifiers, SHALL/SHOULD:

1. min **15 chars** single-factor; min **8** when password is used within MFA;
2. **SHOULD** permit max ≥ 64 chars; accept all printable ASCII + space; Unicode accepted with each code point = 1 char, **NFC normalization** before hashing;
3. **SHALL NOT** impose composition rules; **SHALL NOT** require periodic changes (forced change only on evidence of compromise); no hints, no KBA/security questions; verify the entire password (no truncation);
4. **SHALL** compare prospective passwords against a blocklist of "commonly used, expected, or compromised" values (breach corpuses, dictionaries, context-specific words such as service name/username) and **SHALL** give a reason for rejection; blocklist size bounded by what rate limiting already defends;
5. **SHALL** rate-limit failed authentication attempts per account;
6. storage: salted hash, salt ≥ 32 bits, cost as high as practical and **increased over time**; store scheme+cost reference per password; **peppering SHOULD** (keyed hash, key in HSM/TEE, stored separately).

NIST explicitly references HIBP as a compliant breach-blocklist source: [how HIBP satisfies SP 800-63B](https://haveibeenpwned.com/NIST).

*HIBP Pwned Passwords API* ([docs](https://haveibeenpwned.com/API/v3#PwnedPasswords)): `GET https://api.pwnedpasswords.com/range/{first 5 SHA-1 chars}` — free, **no API key**, every prefix returns 200 with ~800 `SUFFIX:COUNT` lines; client matches the full SHA-1 locally (k-anonymity: server never sees the password; [design rationale](https://www.troyhunt.com/ive-just-launched-pwned-passwords-version-2)). `Add-Padding: true` randomizes response size to 800–1000 lines against traffic analysis ([padding post](https://www.troyhunt.com/enhancing-pwned-passwords-privacy-with-padding)). `?mode=ntlm` for NTLM corpuses. The entire corpus is downloadable ([PwnedPasswordsDownloader](https://github.com/HaveIBeenPwned/PwnedPasswordsDownloader)) for air-gapped/self-hosted blocklists. Caveat: incremental per-keystroke searching leaks the password to network observers ([Quarkslab analysis](https://blog.quarkslab.com/passbolt-a-bold-use-of-haveibeenpwned.html)) — check on submit/blur, never per keystroke.

*Rehash-on-login*: two triggers — (a) hash used a legacy algorithm, (b) hash parameters below current configured floor (argued by OWASP "Upgrading the Work Factor" + NIST "cost SHOULD be increased over time"). Both are decidable from the stored PHC string without touching the password. `bcrypt` (72-byte truncation) and `md5/sha1` rows always qualify for (a).

**Recommendation:**

1. `password()` plugin defaults to **argon2id `m=19456, t=2, p=1`** (~19 MiB, ~50–100 ms) via the `PasswordHasher` capability (Q53). Expose algorithm choice as a **capability implementation**, not plugin config: `Argon2IdHasher`, `ScryptHasher`, `BcryptHasher`, `Pbkdf2Hasher` Layers, all consuming/emitting PHC strings.
2. scrypt preset: `N=2^17, r=8, p=1` and **raise `maxmem`** (node:crypto defaults to 32 MiB, which aborts at `N=2^17` because `128·N·r > maxmem`) — see [node:crypto docs](https://nodejs.org/api/crypto.html). bcrypt preset: cost 10, reject passwords > 72 bytes. PBKDF2 preset exists only for FIPS deployments (600k SHA-256).
3. Cap passwords at **128 chars / 1024 bytes** (well above NIST's 64 floor; bounds KDF DoS). Min length **8** (assume MFA-capable apps); never composition rules; never forced expiry; NFC-normalize before hashing; reject only via blocklist with reason.
4. Store the full PHC string. Add `needsRehash(phc): boolean` to the hasher; `password()` runs it after every successful sign-in and transparently re-hashes in the same request. Config floor: `parametersVersion` constant bumped by maintainers in releases.
5. Breach checking as an **opt-in `breach-check()` plugin**: on signup/password-change, SHA-1 the candidate password, query the range API with `Add-Padding`, reject when count ≥ 1 (configurable threshold), with typed error + user-facing message. Default **fail-open** (API unreachable → allow, emit event) to avoid outage lockouts; `failClosed: true` for strict deployments. Offer a `BreachChecker` capability so operators can plug a self-hosted corpus (downloader) or a private blocklist instead of the public API.

**Confidence:** high.

---

### Q53 — PasswordHasher capability: native deps vs pure-JS vs WebCrypto constraints on edge

**Evidence.**

*Node ecosystem (verified via npm, 2026-09)*:

| Library | What | Version | License | Notes |
|---|---|---|---|---|
| [`@node-rs/argon2`](https://www.npmjs.com/package/@node-rs/argon2) | Rust argon2 → napi-rs prebuilds | 2.2.1 | MIT | ~946k weekly downloads; argon2id/argon2i/argon2d, PHC output; native `.node` binaries per platform |
| [`bcrypt`](https://www.npmjs.com/package/bcrypt) | native bcrypt | 6.0.0 | MIT | legacy/interop only (72-byte limit) |
| `node:crypto` `scrypt` | stdlib scrypt + `timingSafeEqual` | built-in | MIT | defaults `N=16384, r=8, p=1`, `maxmem=32 MiB` — must override both for OWASP-grade params ([docs](https://nodejs.org/api/crypto.html)) |
| [`hash-wasm`](https://github.com/Daninet/hash-wasm) | hand-tuned WASM: argon2, bcrypt, scrypt, PBKDF2, SHA… | 4.12.0 | MIT | **zero dependencies**, WASM inlined as base64 (no linking issues), runs in browsers, Node.js, Deno, Web Workers |

*Edge reality (Cloudflare Workers docs, updated 2026-04)*: the [WebCrypto algorithm table](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) implements **PBKDF2** (`deriveBits`/`deriveKey`) but there is **no argon2, scrypt, or bcrypt** in WebCrypto on any runtime. Workers additionally ships a non-standard `crypto.timingSafeEqual`. So the naive "WebCrypto PBKDF2 fallback" is usable but PBKDF2 is GPU-friendly (OWASP ranks it below argon2/scrypt; cost scaling is CPU-bound and Workers' CPU-time limits punish high iterations). The actually-good edge story is **WASM**: Cloudflare Workers (and Vercel Edge) support importing WASM, and hash-wasm's argon2id is pure WASM with zero Node-API dependencies — `m=19456` (~19 MiB) fits comfortably inside Workers' 128 MB memory ceiling. Community writeups confirm `@node-rs/argon2` does *not* run on Pages/Workers while WASM implementations do ([example](https://tjenwellens.eu/blog/password-hashing-on-cloudflare-pages/)). Deno and Bun both implement `node:crypto` `scrypt` (Bun also loads napi native modules, so `@node-rs/argon2` works there).

*Effect fit*: a `PasswordHasher` `Context.Tag` + runtime-specific `Layer` matches the PRD's "capability over implementation" principle (§5.1) and Q11's capability declaration pattern — the plugin depends on the tag; the app picks the Layer per runtime. Constructing the Layer is compile-time; no runtime sniffing.

**Recommendation:**

1. Define `PasswordHasher` with `hash(password) -> Effect<PhcString, PasswordHashError>`, `verify(password, phc) -> Effect<boolean, ...>` (constant-time inside the implementation), `needsRehash(phc, policy) -> boolean`, `algorithm: AlgorithmId`. Plugins (password reset, basic auth, API-key secret if ever KDF'd) depend only on the tag.
2. **Ship three first-class Layers** and make the docs' quickstart pick per runtime: `@effect-auth/hasher-argon2-native` (peer-dep `@node-rs/argon2`, for Node/Bun), `@effect-auth/hasher-wasm` (peer-dep `hash-wasm`, universal incl. Workers — the **default for edge targets**), `@effect-auth/hasher-scrypt` (pure `node:crypto`, zero extra deps). Core itself ships **no native dependency** — hashers are optional peer deps so the framework stays installable everywhere.
3. Document the honest edge tradeoff matrix: argon2id-WASM ≈ native (same security), ~2–4× slower CPU per hash; PBKDF2-WebCrypto only for FIPS; never silently degrade — the chosen Layer is visible in the type signature of the compiled `Auth`.
4. Verification must never leak timing on miss: library verify functions are constant-time; for PBKDF2/scrypt use `crypto.timingSafeEqual` / Workers `crypto.timingSafeEqual` on the derived bytes (also covered by Q90's timing normalization on the whole sign-in path).
5. Do **not** use argon2/bcrypt/scrypt for high-entropy tokens (API keys, verification tokens) — SHA-256 suffices and is required for indexed lookup (see Q59).

**Confidence:** high on facts; **medium** on the default recommendation only insofar as "edge as day-1 target" (Q3) is still open — if Node-only at v1, argon2id-native default is unambiguous.

---

### Q57 — Magic link / email OTP: TTL, single-use, enumeration safety, click-to-session

**Evidence.**

*Normative constraints*: NIST 63B-4 [§3.1.3](https://pages.nist.gov/800-63-4/sp800-63b.html#out-of-band): **email SHALL NOT be used for out-of-band authentication** (password-accessible, interceptable, DNS-reroutable) — but the same section notes "Confirmation codes that are sent to validate email addresses … are not authentication processes", which is the hook that keeps magic-link *sign-in* legitimate as an email-possession proof. OOB-style one-time codes: verifier SHALL generate via approved RNG, validity **SHALL NOT exceed 10 minutes**, secret valid **only once** (replay resistance), regeneration SHALL NOT reset the failed-attempt counter, rate limiting SHALL when secret < 64 bits.

*better-auth magic-link plugin* ([docs](https://www.better-auth.com/docs/plugins/magic-link)) — a reference implementation of each property: `expiresIn` default **300 s**; verification now **consumes the token atomically on the first attempt** (the old `allowedAttempts` option is deprecated and ignored — retries always fail with `INVALID_TOKEN`); token storage is pluggable via `storeToken: "plain" | "hashed" | custom` (hashed recommended; the underlying verification layer supports secondary storage **only if it provides atomic `getAndDelete`**, e.g. Redis `GETDEL`); click on the link = `GET /magic-link/verify?token=…&callbackURL=…` which authenticates and redirects (click-to-session); `disableSignUp` gates auto-registration; and notably, verifying a link against a pre-existing never-confirmed account **removes any existing password and revokes sessions** — email ownership is treated as source of truth.

*Enumeration safety* is the operator's discipline, not the framework's: the sign-in response must be identical whether or not the account exists (same 200 + generic "check your inbox"), because the send path itself reveals nothing. The token is the secret: 256-bit random, stored **hashed** (it is exactly a bearer credential — better-auth's docs warn `generateToken` output "is used to verify who someone actually is in a confidential way").

**Recommendation:**

1. Implement magic links and email OTP on the **shared verification-token table** (purpose-scoped, PRD Q46): `tokenHash` (SHA-256 of a 256-bit random), `purpose: "magic-link" | "email-otp" | ...`, `userId?` nullable (signup case), `expiresAt`, `consumedAt`. Consume with a single atomic `UPDATE … SET consumed WHERE consumed IS NULL AND expires_at > now()` (or KV `getAndDelete`) — replay of an in-flight double-click must be a no-op.
2. **Defaults**: magic-link TTL **10 min** (OWASP-adjacent norm range 5–15; better-auth ships 5; NIST caps OOB at 10); email-OTP: 6 digits, **5 min**, max **3 failed verifications** per token, then the token is dead; send-rate-limit per address (e.g. 5/hour, NIST: reissuance must not reset attempt counters); both always answered with a uniform response.
3. **Enumeration-safe by construction**: the request handler must not branch on user existence for output or timing — look up by normalized email, hash-and-insert the token regardless, and "send" to a black-hole `Mailer` target when the user doesn't exist (one code path, uniform latency). Sign-in completion reveals nothing.
4. **Click-to-session**: `GET /verify?token=` → atomic consume → create session (Q45) → `302 callbackURL` with the session cookie set. Provide `errorCallbackURL` for dead/expired tokens (better-auth pattern). Offer an OTP fallback ("open on another device?" → type the 6-digit code) that reads the same row. Auto-signup behind `disableSignUp: false` default; **do not** silently clear existing passwords (better-auth does this; make it an explicit `linkPolicy` option — surprising behavior otherwise).
5. All of it rides the `Mailer` capability (Q48); the plugin never imports an SMTP client.

**Confidence:** high.

---

### Q58 — 2FA/TOTP: RFC details, recovery codes, pre-auth session state, rate limiting (+ SMS caveats)

**Evidence.**

*Algorithm (RFC 4226 → RFC 6238)*: TOTP = `HOTP(K, T)` with `T = floor((unixTime − T0) / X)`; defaults **X = 30 s**, T0 = 0; verifiers SHOULD allow **at most one time step** of network delay, i.e. check current ± 1 ([RFC 6238 §5.2](https://www.rfc-editor.org/rfc/rfc6238)); MAY use HMAC-SHA-256/512, but **SHA-1 is the interoperable default**; keys SHOULD be random and "of the length of the HMAC output" (**160 bits / 20 bytes** for SHA-1) ([R6, §5.1](https://www.rfc-editor.org/rfc/rfc6238)). HOTP: digits ≥ 6, shared secret ≥ 128 bits (160 recommended); **throttling parameter T** — "T SHOULD be set as low as possible" — plus look-ahead window `s` for resync ([RFC 4226 §7.2–7.4](https://datatracker.ietf.org/doc/html/rfc4226)). NIST 63B-4 OTP verifier rules: OTP accepted **only once while valid**; rate limiting **SHALL** when output < 64 bits; TOTP lifetime parameter SHALL account for expected clock drift. Replay detection is cheap: remember the last accepted time-step per authenticator and reject reuse of the same step.

*Provisioning format*: [`otpauth://totp/{issuer}:{account}?secret={base32}&issuer={issuer}&algorithm=SHA1&digits=6&period=30`](https://github.com/google/google-authenticator/wiki/Key-Uri-Format) — base32 (RFC 3548) **without padding**, `issuer` both as label prefix and parameter (old vs new authenticator apps), QR code rendered client-side from the URI.

*better-auth twoFactor plugin* ([docs](https://www.better-auth.com/docs/plugins/2fa), [source](https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/plugins/two-factor/index.ts)) — the concrete pre-auth state pattern:
- Sign-in with a 2FA-enabled account returns `twoFactorRedirect: true` + `twoFactorMethods: ["totp","otp",…]` **instead of a session**; the plugin **deletes the pending session cookie** and resets `newSession` to `null` — there is *no authenticated session* during the challenge.
- It sets a **signed, HttpOnly 2FA cookie with `twoFactorCookieMaxAge` default 10 minutes** binding the challenge to the browser; verification endpoints (TOTP/OTP/backup code) require that cookie and only then call `setSessionCookie`.
- TOTP verification accepts codes **± 1 period**; `trustDevice: true` sets a signed trust-device cookie for **30 days, refreshed on each successful sign-in**.
- Recovery/backup codes: default **10 codes × 10 chars** (`xxxxx-xxxxx`, [a-zA-Z0-9], [source](https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/plugins/two-factor/backup-codes/index.ts)); **deleted from the DB on use** (single-use); regeneration invalidates all previous; storage supports encrypted/plain.
- Email/SMS OTP second factor: 6 digits, pluggable `sendOTP`, hashed storage option, configurable resend window (3 min default).
- **Lockout is per-account and shared across factors** — TOTP, OTP, and backup codes share one failed-attempt counter, reset on success; excess → `429 ACCOUNT_TEMPORARILY_LOCKED`.

*SMS 2FA caveats*: NIST 63B-4 moves PSTN-delivered OOB into **"restricted" authenticator** status (§3.1.3.3/§3.2.9): verifiers SHALL offer alternative authenticators to all subscribers, SHOULD check risk indicators "device swap, SIM change, number porting" before use, and NIST reserves the right to tighten. The underlying threat is SIM-swap/porting account takeover; the -4 final document deliberately keeps it usable-but-restricted rather than banning it. Email as OOB remains **SHALL NOT**. TOTP/authenticator apps remain the low-cost default; passkeys are the phishing-resistant upgrade path (Q56/AAL2).

**Recommendation:**

1. `twoFactor()` plugin contributes: `twoFactor` table (per-user secret, method flags), endpoints `enable/verify-totp/verify-otp/verify-backup-code/generate-backup-codes/get-totp-uri/disable`, and the **pre-auth challenge cookie** mechanism below. Requires `password()` when used as a second factor for credential sign-in (PRD Q43 linkage guards apply).
2. TOTP defaults: SHA-1, **X=30 s, T0=0, 6 digits, verify ±1 step**, secret = **20 CSPRNG bytes**, base32-no-padding in the `otpauth://` URI (issuer = app name, label = `issuer:email`); store the secret **encrypted at rest** (it is a shared long-term credential; better-auth stores it in the table — encryption-at-rest is the defensible default); reject reuse of an already-accepted time-step (per-user `lastUsedStep`).
3. Verification throttling: per-account counter across **all** second factors (better-auth's shared-counter design is right), 5 failures → typed `AccountLocked` error mapped to **429** with `Retry-After`; counter reset on success; a new OTP does **not** reset it (NIST requirement).
4. Recovery codes: **10 codes, 12 chars** (a-z0-9, ~71 bits; better than better-auth's 10 chars and still typo-friendly), stored **hashed** (SHA-256 like verification tokens — high entropy, needs lookup not KDF), **delete-on-use**, regenerate invalidates old set, shown exactly once with copy-all UX, `remainingRecoveryCodes` surfaced so clients can nag.
5. Pre-auth state: on first-factor success, do **not** mint a session; set a signed, HttpOnly, SameSite=Lax **challenge cookie (5–10 min)** containing `userId` + a random challenge id persisted in the verification table (so the cookie is stateless-verifiable but server-revocable); all `/two-factor/verify-*` endpoints take the challenge, and **only success** writes the real session (Q45). This is better-auth's exact shape and it composes with Effect: the challenge is just another purpose-scoped token row.
6. Trusted-device: signed cookie, default 30 days, refreshed per successful sign-in, revocable server-side via the challenge/session tables (not just cookie expiry).
7. Ship SMS OTP as a **separate `sms-otp()` plugin** marked degraded: never a default factor, requires the operator to attest alternatives exist, and emits audit events `factor.sms.used` (NIST restricted status). Prefer documenting "add passkeys" in the same docs page.
8. Step-up: expose `requireFreshSecondFactor(maxAge)` so apps can re-challenge TOTP for sensitive ops (Q62 impersonation, password change).

**Confidence:** high.

---

### Q59 — API keys: format, hashing, scopes, expiry, revocation, principal mapping

**Evidence.** Four implementations converge on the same design, differing only in defaults:

| | Format | Hash at rest | Shown | Scopes | Expiry | Revocation |
|---|---|---|---|---|---|---|
| [Stripe](https://docs.stripe.com/keys) | `sk_live_…` / `rk_…` restricted / `pk_…` public / `sk_org_` | (Stripe-side) | **once**; can't reveal later | Restricted keys = per-permission grants; [access policies](https://docs.stripe.com/keys) (IP/ASN/country/proxy classes) | manual expire; **rotation: old+new both valid ≤ 7 days** | expire/rotate immediately |
| [WorkOS AuthKit](https://workos.com/docs/authkit/api-keys) | opaque, obfuscated display | (WorkOS-side) | full value **only in create response** | permission strings (`posts:read`) set per key; org-scoped **and** user-scoped | n/a (long-lived) | delete; `api_key.created/.updated/.revoked` events; **user keys auto-revoked when org membership deleted** |
| [Clerk](https://clerk.com/docs/guides/development/machine-auth/api-keys) | `ak_…` secret | (Clerk-side) | **secret only in create response** | `scopes: string[]` + free-form `claims` | `secondsUntilExpiration`, **default never** (deliberate: opaque token → instant revoke instead) | `revoke(id, reason)` — immediate, key stays listed as revoked |
| [better-auth apiKey](https://www.better-auth.com/docs/plugins/api-key) | `{prefix}_{64 random chars}`; prefix recommended to end in `_` | **SHA-256**, base64url ([source](https://github.com/better-auth/better-auth/blob/main/packages/api-key/src/index.ts)) | returned once on create | `permissions: Record<resource, action[]>` | default none; client-set clamped 1–365 days | delete endpoint; `deleteAllExpiredApiKeys` housekeeping (10 s cooldown) |

Mechanics worth copying: better-auth stores the **first 6 chars** (incl. prefix) as a `start` column for identification UX (list shows `hello_9f3a…`) while lookups go by the SHA-256 of the full key — hash-first lookup, prefix-last-4 for humans, exactly Stripe's dashboard pattern. Verification is then one indexed `WHERE keyHash = sha256(presented)` + constant-time equality; no KDF needed because the secret is 300+ bits of entropy (brute-forcing the hash is infeasible; KDF would only add ~100 ms to *every* authenticated API call). Header: `x-api-key` (better-auth default) vs `Authorization: Bearer` (WorkOS/Clerk) — Bearer is more proxy/middleware-friendly and unifies with Q61's strategy chain. WorkOS adds two governance ideas: **lifecycle events** (`api_key.created/updated/revoked`) and **ownership-derived revocation** (deleting the underlying membership kills user-owned keys).

**Recommendation:**

1. Format: `{prefix}_{secret}` where prefix is a short reverse-DNS-ish app/service id (`acme_`) and secret = **32 CSPRNG bytes, base62/base64url (~192–256 bits)**. Never embed data (no timestamps/user ids) in the key — it must be undecodable. `apiKey()` plugin takes `prefix` and validates display/name lengths.
2. At rest: `keyHash = SHA-256(full key)` in a **unique indexed column**, plus `start` (first ~8 chars) for list UX, `name`, `ownerType/ownerId`, `permissions`, `lastUsedAt`, `requestCount`, `expiresAt`, `revokedAt/reason`. Never log or return the full key after create (`show-once`); `GET`-family endpoints return `Omit<ApiKey, "secret">`.
3. Scopes: reuse the **authorization permission registry** (Q64) — keys store `Record<resource, action[]>`, validated at creation against the registry, checked by the same `requirePermission` path a user session would hit (Q70). Keys are credentials *for a principal*, not a parallel authorization system.
4. Expiry & rotation: optional `expiresAt` (default **1 year**, `null` allowed but surfaced in UI warnings); rotation endpoint mints a replacement and keeps the old key valid for a configurable grace window (Stripe's ≤ 7-day dual-validity) before revoking.
5. Revocation: immediate (single `UPDATE`), typed `401 ApiKeyRevoked` vs `403 ApiKeyMissingScope` (Q36 error table); lifecycle events on the event bus (Q13: `apikey.created/.revoked`); optional per-key rate limits (Q37) and `lastUsedAt` deferred-write.
6. Principal mapping (Q44): verification returns `Principal(kind: "api-key", id, owner: user|org, permissions)` — an explicit principal kind, not a mocked session (reject better-auth's `enableSessionForAPIKeys` session-impersonation default; if an app wants the *user's* identity, the strategy chain (Q61) yields the key principal and handlers decide). Transport: `Authorization: Bearer` + `x-api-key` both parsed.
7. Housekeeping: scheduled sweeper deletes expired rows (or partitions them) — cheap, event-driven, no cron dependency.

**Confidence:** high.

---

### Q63 — Bot defense: captcha (Turnstile/hCaptcha) as pre-signup hook

**Evidence.**

*Cloudflare Turnstile* ([server-side validation docs](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/), updated 2026-05): client widget yields a token; server **MUST** call `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` with `secret`, `response` (the token), optional `remoteip`, optional `idempotency_key` (UUID enabling safe retries). Token properties: ≤ 2048 chars, **valid 300 s, single-use** (replay → `timeout-or-duplicate`), response `{ success: boolean, "error-codes": [...], hostname, ... }`. "The client-side widget alone does not protect your forms" — forged strings must fail server-side.

*hCaptcha* ([developer guide](https://docs.hcaptcha.com/)): same shape — client form field `h-captcha-response`; server `POST https://api.hcaptcha.com/siteverify` (form-encoded, not JSON) with `secret`, `response`, `remoteip` recommended; response `{ success, challenge_ts, hostname, error-codes }`. Sitekeys can be scoped per flow ("one for signup and one for login"), which maps directly to per-route plugin config.

*Plugin precedent*: better-auth ships captcha as an optional plugin where a token is required by sign-up/sign-in endpoints; the ecosystem pattern is "verify token inside the endpoint's hook chain, before the rate limiter/user-write". The PRD's hook model (Q27: failure = abort) gives the abort semantics natively — a failing captcha hook aborts signup with a typed error before any user row is written.

**Recommendation:**

1. Ship `captcha()` as a plugin with two contributions: (a) a **`CaptchaVerifier` capability** — `verify(token, remoteip?) -> Effect<CaptchaResult, CaptchaError>` with built-in Turnstile and hCaptcha implementations (both are one `fetch` + response normalization; reCAPTCHA-compat is trivially addable by third parties); (b) **declarative hook registrations** on configurable endpoints, defaulting to `["sign-up"]` (opt-in list for `sign-in`, `forgot-password`, `magic-link.request` — the enumeration-relevant ones).
2. Typed errors: `CaptchaMissing`, `CaptchaInvalid({ codes })`, `CaptchaUnavailable` mapped per Q36 (4xx to the client, 5xx only for provider failure); never include the raw token in logs (Q93 redaction list).
3. **Failure policy is explicit config**: `onProviderFailure: "allow" | "deny"` — default `allow` (fail-open) so a Turnstile outage cannot lock out all signups, with a metric/event emitted; strict operators flip to `deny`. Provider *rejections* always deny.
4. Pass through `idempotency_key` (Turnstile) and enforce our own single-use semantics client-side (don't accept the same token twice across two endpoints — keep a short TTL cache of consumed token hashes).
5. Tests: contract-test the capability with a fake verifier (success / invalid codes / provider 500) asserting hook abort ordering (before rate-limit? after body validation — recommend **after validation, before user-write**, so missing-field errors don't burn solved tokens) — the PRD's `@effect-auth/test` harness (Q31) can pin this ordering.
6. Docs stance: captcha is a spam/cost control, **not** an auth factor; pair with rate limiting (Q37/Q91) and never gate password *reset* completion behind a captcha for an existing account (DoS-on-victim).

**Confidence:** high.

---

## Technologies & libraries

| Name | What it is | License | Maturity | Relevance to effect-auth |
|---|---|---|---|---|
| [@node-rs/argon2](https://www.npmjs.com/package/@node-rs/argon2) | Rust argon2 binding, napi prebuilds | MIT | v2.2.1, ~946k wk downloads | Default hasher Layer for Node/Bun |
| [hash-wasm](https://github.com/Daninet/hash-wasm) | Pure-WASM argon2/bcrypt/scrypt/PBKDF2/SHA, zero deps | MIT | v4.12.0, stable | Universal/edge hasher Layer (argon2id on Workers) |
| [bcrypt (npm)](https://www.npmjs.com/package/bcrypt) | native bcrypt | MIT | v6.0.0 | Legacy-hash verification & migration only |
| [`node:crypto` scrypt/PBKDF2/timingSafeEqual](https://nodejs.org/api/crypto.html) | stdlib KDFs | MIT (Node) | built-in | Zero-dep scrypt Layer; constant-time compare |
| [WebCrypto SubtleCrypto (PBKDF2)](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto) | browser/edge KDF | — | standard | FIPS-ish edge fallback; last resort for passwords |
| [otpauth](https://www.npmjs.com/package/otpauth) | HOTP/TOTP, browser+Node+Deno | MIT | v9.5.2 | Candidate dependency (or reference impl) for `twoFactor()` |
| [otplib](https://www.npmjs.com/package/otplib) | TOTP/HOTP utilities | MIT | v13.5.0 | Alternative; heavier dep graph |
| [HIBP Pwned Passwords API](https://haveibeenpwned.com/API/v3#PwnedPasswords) + [downloader](https://github.com/HaveIBeenPwned/PwnedPasswordsDownloader) | k-anonymity breach checking / offline corpus | free API | maintained (FBI/NCA feeds) | `breach-check()` plugin backend |
| [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) | CAPTCHA alternative, siteverify API | commercial/free tier | GA | Built-in `CaptchaVerifier` implementation |
| [hCaptcha](https://docs.hcaptcha.com/) | CAPTCHA, siteverify API | commercial | GA | Built-in `CaptchaVerifier` implementation |

## Books, papers, blogs, talks

- [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html) (2025) — the normative password/OTP/OOB rulebook; our policy defaults should quote it.
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) — parameter baselines, peppering, rehash-on-login.
- [RFC 4226](https://datatracker.ietf.org/doc/html/rfc4226) / [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238) — HOTP/TOTP algorithm + security requirements (throttling, resync, single-use).
- [Google Authenticator Key-Uri-Format](https://github.com/google/google-authenticator/wiki/Key-Uri-Format) — the de-facto `otpauth://` provisioning standard.
- [Troy Hunt — Pwned Passwords v2 (k-anonymity)](https://www.troyhunt.com/ive-just-launched-pwned-passwords-version-2), [padding](https://www.troyhunt.com/enhancing-pwned-passwords-privacy-with-padding), [NIST compliance note](https://haveibeenpwned.com/NIST) — why and how of the range API.
- [Quarkslab — Passbolt & HIBP incremental search risk](https://blog.quarkslab.com/passbolt-a-bold-use-of-haveibeenpwned.html) — check on submit, never per keystroke.
- [PHC String Format](https://github.com/P-H-C/phc-string-format/blob/master/phc-sf-spec.md) — self-describing hash storage enabling rehash-on-login.
- [Soatok — Beyond Bcrypt](https://soatok.blog/2024/11/27/beyond-bcrypt/) — deep dive on bcrypt limits/pre-hashing pitfalls (linked from OWASP).
- [Cloudflare Workers WebCrypto reference](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) — the definitive edge-crypto constraint table.
- [Stripe API keys docs](https://docs.stripe.com/keys) — lifecycle UX to emulate (show-once, rotation grace, scoped restricted keys).
- [better-auth 2FA / magic-link / api-key docs](https://www.better-auth.com/docs/plugins/2fa) — closest competitor behavior to match-or-beat.

## People & projects to follow

- **Troy Hunt** — HIBP/Pwned Passwords creator; breach-check design changes land via [troyhunt.com](https://www.troyhunt.com/) and [HIBP changelog](https://haveibeenpwned.com/API/v3).
- **better-auth team** ([@bekacru](https://github.com/bekacru), [better-auth/better-auth](https://github.com/better-auth/better-auth)) — the 2FA/apiKey/magic-link behavior baseline we compare against.
- **Cloudflare Workers/DX team** — Workers runtime crypto additions ([workers docs](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)); watch for native argon2 someday.
- **LongYinan (broooooklyn) / napi-rs** — [@node-rs/argon2](https://github.com/napi-rs/node-rs) maintainer; Node ABI/prebuild practices.
- **Daninet** — [hash-wasm](https://github.com/Daninet/hash-wasm); WASM crypto performance.
- **Colin Percival** — scrypt author ([paper](http://www.tarsnap.com/scrypt/scrypt.pdf)); authoritative on scrypt parameterization.
- **Soatok** — applied-crypto engineering blog ([beyond-bcrypt](https://soatok.blog/2024/11/27/beyond-bcrypt/)); sharp reviews of JS crypto mistakes.
- **NIST Digital Identity Guidelines team** — SP 800-63 revision process; the -4 revision shows where policy is heading (restricted PSTN, syncable authenticators).

## Recommended defaults for effect-auth

1. **Hasher**: argon2id `m=19456, t=2, p=1` (PHC strings) — native Layer on Node/Bun (`@node-rs/argon2`), WASM Layer (`hash-wasm`) as edge default; scrypt `N=2^17,r=8,p=1` (maxmem raised) as zero-dep option; bcrypt cost 10 for legacy verify only; PBKDF2 600k only for FIPS.
2. **PasswordHasher = capability** (Context.Tag + 3 Layers), core has **no native/optional dependency**; hashers are optional peer deps.
3. **Rehash-on-login** via `needsRehash(PHC, policy)`; algorithm/params always stored in the hash; maintainers bump the parameter floor per release.
4. **Policy**: min 8 (max 128), allow printable ASCII + Unicode (NFC), no composition rules, no forced expiry, blocklist-with-reason; nothing policy-shaped that NIST forbids.
5. **Breach check**: opt-in plugin, HIBP k-anonymity (5-char SHA-1 prefix, `Add-Padding`, check on submit only), threshold ≥ 1, **fail-open default**, `BreachChecker` capability for self-hosted corpora.
6. **TOTP**: SHA-1/30 s/6 digits/±1 step, 20-byte secret, encrypted at rest, `otpauth://totp/{issuer}:{email}?…` for QR, reject reused time-steps.
7. **Recovery codes**: 10 × 12-char, SHA-256-hashed, single-use (delete on use), regenerate = invalidate, show-once UI.
8. **Pre-auth 2FA state**: no session until second factor; signed HttpOnly challenge cookie (5–10 min) + server-side challenge row; all verify endpoints require it; per-account shared failure counter → typed 429 lockout.
9. **Magic link / email OTP**: shared purpose-scoped verification table; 256-bit token, SHA-256 at rest, atomic single-use consume; 10 min (links) / 5 min+3 attempts (OTP codes); uniform enumeration-safe responses; click → session → `callbackURL` redirect; OTP fallback code for cross-device.
10. **API keys**: `{prefix}_{32 bytes base62}`; SHA-256 hash + unique index (no KDF), `start` prefix for UX, show-once, scopes from the shared permission registry, default 1-year expiry (nullable), immediate revocation + events + rotation grace (≤ 7 days); principal `api-key` distinct from session.
11. **Captcha**: `captcha()` plugin = `CaptchaVerifier` capability (Turnstile + hCaptcha) + pre-signup hooks (after validation, before user-write); `onProviderFailure: "allow"` default; tokens treated as single-use; never logged.
12. **SMS OTP**: separate optional plugin, flagged degraded (NIST "restricted" PSTN status); TOTP/passkey always the documented first choice.

## Open questions for the user

1. **Is edge (Workers/Vercel Edge) a day-1 runtime target?** Determines the default hasher Layer: (a) argon2id-native everywhere (Node-only v1), (b) argon2id-WASM everywhere (uniform, slightly slower), (c) runtime-specific defaults with docs matrix (recommended).
2. **Breach-check failure mode default**: (a) fail-open + event (recommended), (b) fail-closed for compliance-first positioning, (c) no public API by default — blocklist only via self-hosted corpus.
3. **Recovery-code shape**: (a) 10 × 12 chars (recommended), (b) better-auth-compatible 10 × 10 for migration familiarity, (c) 8 × 16 for higher entropy at lower count.
4. **Magic-link verification of an unverified pre-existing account**: (a) keep password + send to verified-email-only flows (safer default, recommended), (b) better-auth behavior (strip password, revoke sessions — surprising but defensible), (c) admin-configurable, default (a).
5. **API-key principal**: (a) first-class `api-key` Principal (recommended), (b) session-mock mode like better-auth for drop-in DX, (c) both with session-mock behind an explicit flag.
6. **Captcha provider fail-closed default**: (a) fail-open everywhere (recommended), (b) fail-closed for signups only, (c) per-endpoint policy exposed to app devs (recommended if (a) feels too lax for an audience targeting fintech).

## Sources

- https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- https://pages.nist.gov/800-63-4/sp800-63b.html
- https://pages.nist.gov/800-63-3/sp800-63b.html (superseded notice)
- https://csrc.nist.gov/pubs/sp/800/63/b/4/final
- https://haveibeenpwned.com/API/v3
- https://haveibeenpwned.com/NIST
- https://www.troyhunt.com/ive-just-launched-pwned-passwords-version-2
- https://www.troyhunt.com/enhancing-pwned-passwords-privacy-with-padding
- https://github.com/HaveIBeenPwned/PwnedPasswordsDownloader
- https://blog.quarkslab.com/passbolt-a-bold-use-of-haveibeenpwned.html
- https://github.com/P-H-C/phc-string-format/blob/master/phc-sf-spec.md
- https://www.npmjs.com/package/@node-rs/argon2
- https://github.com/napi-rs/node-rs
- https://www.npmjs.com/package/bcrypt
- https://github.com/Daninet/hash-wasm
- https://nodejs.org/api/crypto.html
- https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- https://tjenwellens.eu/blog/password-hashing-on-cloudflare-pages/
- https://www.rfc-editor.org/rfc/rfc6238
- https://datatracker.ietf.org/doc/html/rfc4226
- https://github.com/google/google-authenticator/wiki/Key-Uri-Format
- https://www.better-auth.com/docs/plugins/2fa
- https://www.better-auth.com/docs/plugins/magic-link
- https://www.better-auth.com/docs/plugins/api-key
- https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/plugins/two-factor/index.ts
- https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/plugins/two-factor/backup-codes/index.ts
- https://github.com/better-auth/better-auth/blob/main/packages/api-key/src/index.ts
- https://docs.stripe.com/keys
- https://workos.com/docs/authkit/api-keys
- https://clerk.com/docs/guides/development/machine-auth/api-keys
- https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
- https://docs.hcaptcha.com/
- https://www.npmjs.com/package/otpauth
- https://www.npmjs.com/package/otplib
- http://www.tarsnap.com/scrypt/scrypt.pdf
- https://soatok.blog/2024/11/27/beyond-bcrypt/
