# One-Time Token (OTT) Plugin

A lower-level primitive than email-otp or magic-link: it does not prove
control of any identity channel at all. It proves **possession of a token
minted from an already-established session**, and its postcondition is
"reveal/reactivate that exact session," not "authenticate a user from
scratch." It exists for session **handoff** across a context boundary the
session cookie itself cannot cross (a different domain, a native-app
deep link, a server-to-server relay) — not for sign-in.

---

## 1. What it proves, contrasted with the channel-delivered credentials

| | one-time-token | email-otp / magic-link |
|---|---|---|
| Precondition to ISSUE | caller already holds a live session | caller supplies an address they claim to control |
| What redemption produces | the SAME pre-existing session (or a rejection if it has since expired) | a NEW session, possibly for a newly created user |
| Proves | "I was handed this token by someone who already had a session" | "I received something delivered to this address" |
| Attempt budget | none — single random token, atomic consume, no retries (same rationale as magic-link, §3 of `03-email-otp-and-magic-link.md`) | bounded (OTP) or single-shot-by-entropy (magic-link) |

No new persisted entity is added; the token is a verification-value record
whose identifier is `one-time-token:{storedToken}` and whose **value is the
underlying session's token**, not a user id or email.

---

## 2. Lifecycle

```
                    generate (session required)
                            │
              disableClientRequest=true AND this is
              a real network call (request object
              present, as opposed to an internal
              server-side auth.api.* call)? ──yes──► BAD_REQUEST
                            │no
                            ▼
                        ISSUED
        (identifier "one-time-token:{token}" -> value =
         CURRENT session's token; TTL = expiresIn, default 3 min)
                            │
                        verify (token)
                            │
              ATOMIC CONSUME (first racer wins; a missing/
              already-consumed/expired record -> "Invalid token")
                            │
                    look up the session by the
                    CONSUMED record's value (the
                    original session token)
                            │
              session found? ──no──► "Session not found"
                            │yes
                            ▼
              session.expiresAt already in the past?
                            │yes                  │no
                            ▼                       ▼
                    "Session expired"        set session cookie
                    (the OTT is ALREADY      (unless
                    burned at this point —    disableSetSessionCookie);
                    there is no way to        return {session, user}
                    retry redemption of
                    the same token; the
                    caller must obtain a
                    fresh session and a
                    fresh OTT, since the
                    session behind this
                    OTT can no longer be
                    revived by this
                    operation)
```

**Invariant:** consuming the OTT record happens strictly BEFORE checking
whether the underlying session is still live. A token minted just before its
session expired is therefore burned uselessly on first redemption attempt —
this is a deliberate ordering (atomic consume as the universal race gate
first, business-logic checks after), not a bug, but it does mean an
OTT has no automatic "regenerate on expiry" fallback: the caller must return
to a flow capable of establishing a fresh session before requesting a new
OTT.

---

## 3. Cross-cutting: automatic OTT issuance on every new session

```
Operation:     setOttHeaderOnNewSession after-hook
Applies at:    every endpoint in the system, unconditionally (matcher
               always true) — this hook does not care which plugin or
               endpoint produced a new session
Requires:      setOttHeaderOnNewSession = true; ctx.context.newSession set
               by whatever endpoint just ran
Ensures:       a fresh OTT is generated for that new session and exposed
               via a `set-ott` response header, with the header name added
               to `Access-Control-Expose-Headers` so cross-origin clients
               can read it
Invariant:     this path shares the exact same generation logic (and
               therefore the exact same expiry/storeToken policy) as the
               explicit GET /one-time-token/generate endpoint — there is
               only one OTT-issuance implementation in the plugin
```

This turns the plugin into a blanket capability layered under EVERY other
plugin in this document: any successful two-factor verification, passkey
authentication, SIWE verification, magic-link redemption, or plain
credential sign-in can, with this one flag, automatically also hand back a
short-lived bridging token — useful for redirect-based flows (e.g. a
server-rendered page redirecting into a native app or a different subdomain
that cannot read the original session cookie).

---

## 4. Operations

```
Operation:     generate (GET /one-time-token/generate)
Requires:      an authenticated session; if disableClientRequest, must be
               an internal/server-initiated call (no `request` object)
Ensures:       issues exactly one ISSUED record per call, value = the
               caller's current session token
On violation:  BAD_REQUEST ("Client requests are disabled"). Blamed party:
               CLIENT (a browser call against a server-only configuration).
```

```
Operation:     verify (POST /one-time-token/verify)
Requires:      a live, unconsumed OTT record
Ensures:       atomically consumes the record; resolves and returns the
               ORIGINAL session + its user; sets the session cookie unless
               disableSetSessionCookie
Invariant:     a given OTT redeems at most once, ever (§2)
On violation:  BAD_REQUEST "Invalid token" / "Session not found" /
               "Session expired". Blamed party: CLIENT (expired/replayed
               token, or redemption attempted after the underlying session
               itself lapsed).
```

---

## 5. Configuration-driven behavior variants

| Option | Default | Effect |
|---|---|---|
| `expiresIn` | 3 minutes | TTL per issued OTT |
| `disableClientRequest` | false | Restricts `generate` to server-initiated calls only |
| `generateToken` | random 32-char string | Higher-order override: domain `{user, session}` × ctx, range `Promise<string>` |
| `storeToken` | "plain" | plain / hashed / custom-hasher (no "encrypted" mode — same enum as magic-link) |
| `disableSetSessionCookie` | false | `verify` returns the session/user without mutating the caller's cookie |
| `setOttHeaderOnNewSession` | false | Enables the blanket cross-cutting issuance in §3 |

---

## 6. Sequence: cross-context handoff

```
Browser (context A)         OTT plugin              Native app / context B
  │ GET generate (has session) │                          │
  ├─────────────────────────────►│ issue OTT -> session token│
  │◄──── {token} ─────────────────┤                          │
  │                                                            │
  │  (token handed to context B via deep link / redirect URL) │
  │                                                             │
  │                              │ POST verify {token}          │
  │                              │◄──────────────────────────────
  │                              │ consume OTT, resolve session, │
  │                              │ set-cookie in context B        │
  │                              ├───────────────────────────────►
  │                                                    context B now
  │                                                    holds the SAME
  │                                                    session as A
```
