# Passkey / WebAuthn (FIDO2) Plugin

Implements WebAuthn/FIDO2 registration and authentication ceremonies. It adds
one entity (`Passkey`) with no changes to `User`/`Session` shape, and it
delegates all cryptographic verification to the WebAuthn standard's own
attestation/assertion checks (relying-party ID, origin, challenge, signature)
— the plugin's own contract is about **ceremony bookkeeping**: minting a
challenge, binding it to exactly one ceremony type and one (possibly
not-yet-known) identity, and consuming it exactly once.

---

## 1. Entity and invariants added

```
Passkey
  id
  userId            (immutable after creation)
  credentialID      (unique; the WebAuthn credential identifier, the sole
                     lookup key during authentication)
  publicKey         (immutable after creation)
  counter           (signature counter; updated after every successful
                     authentication — WebAuthn's clone-detection signal,
                     validated by the underlying WebAuthn library, not
                     re-validated by this plugin)
  deviceType, backedUp, transports, aaguid   (metadata; aaguid identifies the
                     authenticator *model*, useful for a "Google Password
                     Manager" / "1Password" style label — not the device or
                     the user; many authenticators report an all-zero AAGUID)
  name              (optional, user-assigned label)
```

**Invariants:**

1. `credentialID` is unique across all passkeys (it is the only key used to
   resolve identity during a discoverable/usernameless authentication — see
   §3).
2. `userId` and `publicKey` are set once at registration and never mutated;
   only `counter` and `name` change after creation.
3. A `Passkey` row can only be created through a successfully verified
   registration ceremony (§2) — there is no direct "import a credential"
   operation.

---

## 2. The shared challenge channel and its state machine

Registration and authentication **share one signed cookie name**
(`webAuthnChallengeCookie`, default `better-auth-passkey`) and one
verification-record store. Each generate-options call mints a fresh,
single-use, ceremony-tagged challenge:

```
Challenge value = { type: "registration" | "authentication",
                     expectedChallenge,
                     userData: { id, name?, displayName? },
                     context?: string | null }
```

```
                    generate-*-options
                            │
                            ▼
                        ISSUED
              (signed cookie -> verification-record
               keyed by a random token; TTL = 5 minutes,
               MAX_AGE_IN_SECONDS)
                    │                       │
     verify-*-registration/           TTL elapses with no
     authentication called            verify call
     with the cookie present                │
                    │                       ▼
      atomically consume the           EXPIRED
      verification record              (lookup returns nothing;
      (first caller only)              CHALLENGE_NOT_FOUND)
                    │
       ceremony tag matches
       the endpoint being called?
          │no              │yes
          ▼                 ▼
   CHALLENGE_NOT_FOUND   proceed to WebAuthn library
   (reject — registration    verification (§3, §4)
   options cannot be
   consumed by the
   authentication verify
   endpoint or vice versa)
                            │
              ┌─────────────┴─────────────┐
              ▼                             ▼
         VERIFIED                      REJECTED
   (Passkey persisted /            (CHALLENGE_NOT_FOUND already
    session minted)                 consumed it — record does NOT
                                     get re-armed; ceremony must
                                     restart from generate-options)
```

The ceremony tag on a challenge that is otherwise structurally valid (right
cookie, right token, unexpired) is what prevents a registration challenge
from being replayed against the authentication verify endpoint or vice versa
— both endpoints read from the same record shape, so the tag is the only
thing that separates them.

---

## 3. Registration ceremony

```
Operation:     generate-register-options
               (GET /passkey/generate-register-options)
Requires:      registration.requireSession (default true): a *fresh*,
               DB-backed session (freshSessionMiddleware). If
               requireSession=false: either a session OR a configured
               registration.resolveUser callback that can identify the
               registrant from ctx.query.context alone (a higher-order,
               server-supplied identity-resolution contract — domain:
               {ctx, context} , range: Awaitable<{id, name, displayName}>,
               or throws RESOLVE_USER_REQUIRED / RESOLVED_USER_INVALID)
Ensures:       WebAuthn registration options are generated with
               excludeCredentials populated from the user's EXISTING
               passkeys (so an authenticator already registered to this
               user cannot be re-registered as a duplicate); a fresh
               ISSUED challenge (§2, type "registration") is stored,
               carrying the resolved user identity and the optional
               `context` query param forward to verification
Invariant:     excludeCredentials always reflects the CURRENT passkey set
               at generation time (a stale exclude list is possible only
               under concurrent registration, which is not itself guarded)
On violation:  UNAUTHORIZED SESSION_REQUIRED / BAD_REQUEST
               RESOLVE_USER_REQUIRED / RESOLVED_USER_INVALID.
               Blamed party: CLIENT (no session) or SUPPLIER (deployer set
               requireSession=false without providing resolveUser).
```

```
Operation:     verify-registration (POST /passkey/verify-registration)
Requires:      registration.requireSession (default true): fresh session,
               matching the session used at generate-options time (if a
               session exists at all, its user id must equal the
               challenge's stored userData.id, else
               YOU_ARE_NOT_ALLOWED_TO_REGISTER_THIS_PASSKEY); a live,
               single-use ISSUED challenge tagged "registration"; a
               resolvable `origin` (explicit config or the request's Origin
               header — BAD_REQUEST if neither is present)
Ensures:       the WebAuthn attestation response is verified against the
               stored challenge/origin/rpID (standard: WebAuthn/FIDO2,
               attestationType "none", requireUserVerification: false —
               user-verification enforcement is left to the authenticator's
               own policy/UI, not re-enforced server-side); on success a
               Passkey row is created. The optional
               `registration.afterVerification` callback (a higher-order
               hook: domain = {ctx, verification, user, clientData,
               context}, range = Awaitable<{userId?, name?} | void>) may
               redirect the target user id — but if a session is present,
               a returned userId that differs from the session's user is
               rejected (a session-bound registration cannot be silently
               reassigned to a different account by the callback). A
               non-empty client-supplied `name` always wins over one
               returned by afterVerification. If body.createSession=true,
               passkey creation and session creation happen inside one
               transaction and the response includes {passkey, session,
               user}; otherwise only {passkey}.
Invariant:     a given ISSUED registration challenge yields at most one
               Passkey row (atomic single-use consume is the race gate,
               identical in shape to the OTP/token consume pattern used
               throughout this tree)
On violation:  BAD_REQUEST CHALLENGE_NOT_FOUND / FAILED_TO_VERIFY_REGISTRATION
               / RESOLVED_USER_INVALID; UNAUTHORIZED
               YOU_ARE_NOT_ALLOWED_TO_REGISTER_THIS_PASSKEY;
               INTERNAL_SERVER_ERROR USER_NOT_FOUND /
               UNABLE_TO_CREATE_SESSION. Blamed party: CLIENT (forged or
               replayed attestation, wrong session) unless the failure is a
               transaction/session-creation error, which is SUPPLIER
               (adapter).
```

---

## 4. Authentication ceremony (supports both targeted and discoverable/usernameless flows)

```
Operation:     generate-authenticate-options
               (GET /passkey/generate-authenticate-options)
Requires:      nothing — session is optional
Ensures:       IF a session exists: allowCredentials is restricted to that
               user's own passkeys (a "pick one of MY registered
               authenticators" flow). IF NO session exists: allowCredentials
               is omitted entirely — the browser is free to offer ANY
               discoverable/resident-key credential registered for this
               relying party (the standard "usernameless" / passkey
               autofill flow). Either way, a fresh ISSUED challenge (type
               "authentication") is stored, with userData.id = the
               session's user id or "" if none.
Invariant:     the challenge does not, by itself, commit to a specific
               user identity when issued without a session — identity is
               discovered at verification time from the credential
               response's own id (§below)
```

```
Operation:     verify-authentication (POST /passkey/verify-authentication)
Requires:      a live, single-use ISSUED challenge tagged "authentication";
               a resolvable origin; a Passkey row whose credentialID
               matches the WebAuthn response's `id` (this lookup is how
               identity is recovered in the usernameless flow — the
               plugin never needs to know in advance which user is
               authenticating)
Ensures:       the WebAuthn assertion is verified against the stored
               public key, counter, and transports for that credential
               (standard: WebAuthn/FIDO2, requireUserVerification: false);
               on success, `counter` is updated to the value the WebAuthn
               library reports, the optional
               `authentication.afterVerification` hook runs (domain:
               {ctx, verification, clientData}, range: Awaitable<void> —
               observation-only, cannot alter the outcome), and a session
               for `passkey.userId` is created and set
Invariant:     a given ISSUED authentication challenge yields at most one
               session (same atomic single-use consume pattern)
On violation:  BAD_REQUEST CHALLENGE_NOT_FOUND; UNAUTHORIZED
               PASSKEY_NOT_FOUND / AUTHENTICATION_FAILED;
               INTERNAL_SERVER_ERROR UNABLE_TO_CREATE_SESSION. Blamed
               party: CLIENT (unknown credential, forged/replayed
               assertion) unless session creation fails (SUPPLIER/adapter).
```

---

## 5. Management operations

```
Operation:     list-user-passkeys (GET /passkey/list-user-passkeys)
Requires:      authenticated session
Ensures:       returns only the caller's own passkeys
```

```
Operation:     delete-passkey / update-passkey
               (POST /passkey/delete-passkey, /passkey/update-passkey)
Requires:      authenticated session; resource ownership of the target
               passkey id (enforced by a shared ownership-checking arrow
               contract — see the plugin contract document — that 404s a
               nonexistent id and 401s an id owned by someone else)
Ensures:       delete-passkey removes the row; update-passkey renames it
               (the only mutable field post-creation)
On violation:  UNAUTHORIZED PASSKEY_NOT_FOUND (ownership check folds
               "not found" and "not yours" into one response, avoiding an
               existence oracle) /
               YOU_ARE_NOT_ALLOWED_TO_REGISTER_THIS_PASSKEY on rename;
               INTERNAL_SERVER_ERROR FAILED_TO_UPDATE_PASSKEY. Blamed
               party: CLIENT.
```

---

## 6. Configuration-driven behavior variants

| Option | Default | Effect |
|---|---|---|
| `rpID` | derived from `baseURL` hostname, else `"localhost"` | Relying-party identifier bound into every ceremony |
| `rpName` | app name | Human-readable RP name shown by the authenticator UI |
| `origin` | request `Origin` header | Expected origin(s); mismatch is a hard reject at verify time |
| `authenticatorSelection` | `{ residentKey: "preferred", userVerification: "preferred" }` | Overridable per-registration; query param `authenticatorAttachment` (`platform`/`cross-platform`) narrows further per call |
| `registration.requireSession` | true | false enables session-less / first-factor passkey registration via `resolveUser` |
| `registration.resolveUser` | — | Required when `requireSession=false`; higher-order identity resolver |
| `registration.afterVerification` | — | Higher-order hook; can redirect target user (session-bound calls only redirect to the same user) and supply a fallback name |
| `registration.extensions` / `authentication.extensions` | — | Static object or `(ctx) => object` — a higher-order, per-call-resolved WebAuthn extensions contract |
| `advanced.webAuthnChallengeCookie` | `"better-auth-passkey"` | Cookie name shared by both ceremonies |
| challenge TTL | 5 minutes (`MAX_AGE_IN_SECONDS`, not user-configurable in the shown source) | Window to complete either ceremony |
| `createSession` (per registration call, request body) | false | Whether registration also mints a session (atomic with passkey creation) |

---

## 7. Sequence: registration (browser-initiated, session-bound)

```
Client                          Passkey plugin              WebAuthn lib / Authenticator
  │ GET generate-register-options │                                    │
  ├───────────────────────────────►│ excludeCredentials = own passkeys  │
  │                                │ generateRegistrationOptions() ────►│
  │                                │◄──────── options + challenge ──────┤
  │                                │ store ISSUED{registration} + set   │
  │◄────────── options ────────────┤ signed challenge cookie            │
  │                                │                                    │
  │  (browser calls navigator.credentials.create() with `options`)     │
  │                                │                                    │
  │ POST verify-registration       │                                    │
  │  {response, name?}             │                                    │
  ├───────────────────────────────►│ consume ISSUED challenge (atomic)  │
  │                                │ ceremony=="registration"?  yes     │
  │                                │ session.user.id==userData.id? yes  │
  │                                │ verifyRegistrationResponse() ─────►│
  │                                │◄──────────── verified ─────────────┤
  │                                │ create Passkey row                  │
  │◄────────── {passkey} ──────────┤                                    │
```

## 8. Sequence: authentication (discoverable / usernameless)

```
Client                          Passkey plugin              WebAuthn lib / Authenticator
  │ GET generate-authenticate-options (no session)          │
  ├───────────────────────────────►│ allowCredentials OMITTED           │
  │                                │ store ISSUED{authentication,       │
  │                                │   userData.id=""}                  │
  │◄────────── options ────────────┤                                    │
  │                                │                                    │
  │ (browser lets the platform pick ANY resident credential for this rp)│
  │                                │                                    │
  │ POST verify-authentication {response}                                │
  ├───────────────────────────────►│ consume ISSUED challenge (atomic)  │
  │                                │ lookup Passkey by response.id       │
  │                                │   -> resolves WHICH user this is    │
  │                                │ verifyAuthenticationResponse() ────►│
  │                                │◄──────────── verified ─────────────┤
  │                                │ update counter; createSession()     │
  │◄──── {session, user} ──────────┤                                    │
```
