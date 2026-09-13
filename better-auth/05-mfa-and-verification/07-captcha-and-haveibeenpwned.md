# Captcha and Have I Been Pwned Plugins

Neither plugin adds an entity, a schema field, or a client-facing endpoint.
Both are **pure cross-cutting arrow contracts** that inject a precondition in
front of operations owned by OTHER plugins — captcha at the request-routing
layer (before any endpoint handler runs), haveibeenpwned at a shared
lower-level supplier function (`password.hash`) that many endpoints across
many plugins in this document ultimately call. They are the clearest
instances in this tree of the higher-order-contracts model applied to
"policy," rather than to identity or credentials.

---

## Part A — Captcha

### A.1 The arrow contract

```
Contract:      onRequest : Request × Context  ->  Response | undefined
Applies at:    EVERY inbound request, before any endpoint handler runs —
               this is a request-pipeline-level hook, not an endpoint or a
               per-plugin `before`/`after` hook scoped to one path pattern
Domain:        the raw incoming Request plus the shared AuthContext
Range:         `undefined` = the request proceeds unmodified to its target
               endpoint (precondition satisfied, or not applicable);
               a `Response` = the request is SHORT-CIRCUITED with that
               response, and the target endpoint's handler never runs at
               all
```

This is structurally identical to the rate-limiting arrow contract used
throughout this tree (`pathMatcher` + a decision that either lets a request
through or rejects it before the target endpoint's own logic runs) — captcha
is simply a heavier, network-bound version of the same shape, matched
against a configurable `endpoints` allow-list (exact string or `*`/`**`
wildcard; default: `/sign-up/email`, `/sign-in/email`,
`/request-password-reset`).

### A.2 Gate sequence

```
                    inbound request
                            │
              pathname matches a configured endpoint? ──no──► pass through
                            │yes                               unmodified
                            ▼
              options.secretKey configured? ──no──► 500 (logged as
                            │yes                     MISSING_SECRET_KEY
                            ▼                         internally; client
              x-captcha-response header present?      sees generic
                            │no                        UNKNOWN_ERROR —
                            ▼                          deployer
              400 MISSING_RESPONSE                     misconfiguration
              (fails closed WITHOUT ever                is never leaked
              contacting the provider —                 to the client)
              cheapest possible rejection)
                            │yes
                            ▼
              POST to the provider's siteverify URL,
              bounded by a 10s timeout
              (CAPTCHA_VERIFY_TIMEOUT_MS) — a hanging
              upstream fails closed rather than tying
              up the request indefinitely, ahead of
              any rate limiting that might otherwise
              apply
                            │
              ┌─────────────┼──────────────┐
       network/HTTP     provider reports   provider reports
       failure               !success       success, but
              │                  │            action/hostname
              ▼                  ▼            binding fails
       500 UNKNOWN_ERROR   403               (provider-specific,
       (blamed: UPSTREAM   VERIFICATION_     see §A.3)
       captcha service)    FAILED                  │
                            (blamed: CLIENT)         ▼
                                              403 VERIFICATION_FAILED
                                              (blamed: CLIENT — a
                                              token minted for a
                                              different action/host
                                              is being replayed here)
                            │
                            ▼ (all checks pass)
                    request proceeds to its target endpoint
                    (e.g. /sign-up/email, verified independently
                    by that endpoint's OWN contract)
```

### A.3 Provider-specific binding variants

| Provider | Extra options | Binding check |
|---|---|---|
| Cloudflare Turnstile | `expectedAction`, `allowedHostnames` | rejects a token whose reported `action`/`hostname` doesn't match, preventing a token solved under a shared widget or "Any Hostname" config from being replayed against a stricter endpoint |
| Google reCAPTCHA (v3) | `minScore`, `expectedAction`, `allowedHostnames` | same binding checks, plus a minimum bot-likelihood score threshold |
| hCaptcha | `siteKey` | provider-side site-key cross-check |
| CaptchaFox | `siteKey` | provider-side site-key cross-check |

### A.4 Configuration-driven behavior variants

| Option | Default | Effect |
|---|---|---|
| `endpoints` | `/sign-up/email`, `/sign-in/email`, `/request-password-reset` | which paths this gate protects — extendable to ANY path in the system, including every OTP-issuance or verification endpoint in this document |
| `siteVerifyURLOverride` | provider's public siteverify URL | escape hatch for self-hosted/proxy verification endpoints |
| `secretKey` | — (required) | server-side provider secret; NEVER exposed to the client, and its absence is logged, not surfaced |

**On violation, summarized:** `MISSING_RESPONSE` and `VERIFICATION_FAILED`
are CLIENT-blamed (a real end user either didn't complete or failed the
challenge); `UNKNOWN_ERROR` is the generic client-safe surface for BOTH an
`UPSTREAM` provider outage and a deployer misconfiguration
(`MISSING_SECRET_KEY`) — the two are intentionally indistinguishable to the
client (avoids leaking configuration state) but are logged distinctly on the
server.

---

## Part B — Have I Been Pwned

### B.1 A staged interception of a shared supplier, not an endpoint

```
Contract:      password.hash : string  ->  Promise<string>
Applies at:    the ONE shared password-hashing function used internally by
               every credential-setting operation in the system — sign-up,
               change-password, and every reset-password variant across
               EVERY plugin in this document that sets a password
               (email-otp's reset-password, phone-number's reset-password,
               plus admin create-user / set-user-password)
```

This is the higher-order-contracts model's "staged contract" pattern turned
into a security control: the plugin's `init()` does not add a new operation,
it REPLACES `ctx.password.hash` with a wrapped version that runs a
precondition check before delegating to the original. Every downstream
caller of `password.hash` — regardless of which plugin it lives in —
transparently inherits this precondition without any of those plugins being
aware of it. The check applies only when the CURRENT endpoint's path is in
the configured `paths` allow-list (resolved per-call from ambient request
context, since `password.hash` itself has no path parameter) — default list:
`/sign-up/email`, `/change-password`, `/reset-password`,
`/email-otp/reset-password`, `/phone-number/reset-password`,
`/admin/create-user`, `/admin/set-user-password`.

### B.2 The check itself (k-anonymity, per the Have I Been Pwned API)

```
Operation:     isPasswordCompromised(password)
Ensures:       computes SHA-1(password) locally; sends ONLY the first 5 hex
               characters (the k-anonymity prefix) to
               api.pwnedpasswords.com, with response padding requested
               (defends against upstream response-size traffic analysis);
               scans the returned suffix list for an exact match to the
               remaining 35 hex characters; validates the matched
               compromise count is a well-formed non-negative integer
               (guards against a malformed or adversarial upstream line
               being misparsed) before trusting it
Invariant:     the full password and the full SHA-1 hash NEVER leave the
               server — only a 5-character hash prefix is transmitted
On violation:  a network failure, non-success response, OR a malformed
               compromise-count line all raise INTERNAL_SERVER_ERROR,
               indistinguishable from each other to the caller. Blamed
               party: UPSTREAM (the Have I Been Pwned service or the
               network path to it) — NOT the client, and NOT this plugin's
               own logic.
```

### B.3 The fail-closed availability trade-off

```
password-setting operation (any path in `paths`)
            │
            ▼
   password.hash(password) called
            │
   enabled === false? ──yes──► original hash() runs, check skipped entirely
            │no
            ▼
   current path in `paths`? ──no──► original hash() runs, check skipped
            │yes
            ▼
   isPasswordCompromised() ──throws (UPSTREAM failure)──►
            │                        the ENTIRE password-setting
            │                        operation FAILS — the password
            │                        is never hashed or stored
            │
       compromised === true?
            │yes                          │no
            ▼                              ▼
   BAD_REQUEST                     original hash() runs,
   PASSWORD_COMPROMISED             operation proceeds
   (blamed: CLIENT — chose a
   breached password)
```

**This is a deliberate fail-CLOSED design**: if the upstream Have I Been
Pwned API is unreachable or misbehaving, sign-up, password reset, and
password change ALL become unavailable system-wide for every path in
`paths` — the plugin does not silently skip the check and let the password
through. A reimplementation must treat this as an explicit, named trade-off
(security-check availability coupled to core credential-setting
availability), not an oversight, and MUST preserve the same fail-closed
default unless the deployer has expressed a different risk tolerance
(there is no built-in fail-open toggle other than `enabled: false`, which
disables the check entirely and permanently rather than only on upstream
failure).

### B.4 Configuration-driven behavior variants

| Option | Default | Effect |
|---|---|---|
| `enabled` | true | Global kill switch — false skips the check unconditionally (including its availability coupling) |
| `paths` | 7 built-in credential-setting paths (§B.1) | Extendable to any path that ultimately calls `password.hash` |
| `customPasswordCompromisedMessage` | generic breach message | Overrides the client-facing rejection text |
