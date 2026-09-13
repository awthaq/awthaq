# Last-Login-Method Read-Model Extension

> Extends: `01-core-domain/02-session-lifecycle.md` (the base session
> contract), as a pure observer of its session-issuance postcondition.
> Read `00-methodology/01` and `03` before this document.

## 1. What is being extended, and how modestly

This is the smallest extension in this tree, and it is worth stating
precisely what kind of extension it is, because that shapes every contract
below: it is a **read model**, not a new capability. It never decides
whether authentication succeeds, never gates a session from being issued,
and never participates in validity/expiry/revocation. Its entire job is to
OBSERVE that the base contract's session-issuance postcondition just held
("a new session was established for this response") and, having observed
that, record WHICH authentication method produced it — for later display
back to the client (e.g. "continue with Google," pre-selected) and/or for
server-side inspection.

```
                base session-issuance postcondition
        ┌──────────────────────────────────────────────┐
        │  a request to an authentication-completing     │
        │  endpoint succeeded ⟹ a new session exists,     │
        │  Set-Cookie for the primary session token is    │
        │  present in the response                        │
        └───────────────────┬──────────────────────────┘
                             │  (observed, never re-decided)
                             ▼
              last-login-method's ENTIRE contract:
        ┌──────────────────────────────────────────────┐
        │  IF (and only if) the above just held,          │
        │  record which method produced it — to a cookie, │
        │  and/or to the user record, independently        │
        │  gated (see §4)                                  │
        └──────────────────────────────────────────────┘
```

## 2. Configuration

| Option | Default | Effect |
|---|---|---|
| `cookieName` | `"better-auth.last_used_login_method"` | Name of the client-readable cookie. |
| `maxAge` | `2592000` (30 days) | Cookie lifetime in seconds. |
| `customResolveMethod` | the built-in path-matcher (see §3) | Overrides HOW a login method is identified from the completing request. |
| `storeInDatabase` | `false` | Additionally persists the method onto the user record (adds a schema field). |
| `beforeStoreCookie` | `undefined` (always permit) | Async/sync gate that can suppress the COOKIE write only — see §5 for why this does not also gate the database write. |
| `schema.user.lastLoginMethod` | `"lastLoginMethod"` | Field-name override when `storeInDatabase` is enabled. |

## 3. Method resolution — a best-effort classification, not an authority

```
Operation:     resolveMethod(ctx)
Requires:      a request context; `ctx.path` MAY be absent (defensively
               normalized to `""` rather than allowed to throw).
Ensures:       returns a method label (string) or `null`.
               Resolution order: `customResolveMethod(ctx)` if configured,
               ELSE the built-in resolver, which pattern-matches the
               completing request's path:
                 /callback/:id            → the provider id (OAuth)
                 /sign-in/email,
                 /sign-up/email           → "email"
                 path containing "siwe"   → "siwe"
                 /passkey/verify-
                   authentication         → "passkey"
                 /magic-link/verify*      → "magic-link"
                 /sign-in/email-otp       → "email-otp"
                 anything else            → null
Invariant:     resolution is PURELY a function of which endpoint path just
               completed — it has no knowledge of, and does not itself
               check, whether that completion actually produced a session.
               That check happens one layer up (§4); resolveMethod alone is
               not sufficient to trigger a write.
On violation:  a `customResolveMethod` that throws propagates as an
               ordinary handler error at the call site that invoked it
               (blame CLIENT/application-author for a defect in code they
               supplied) — EXCEPT inside the write-gating hook of §4, where
               such an error is caught (see §5).
```

This resolver is deliberately a **guess based on path shape**, not a
canonical record of "how the user authenticated" maintained anywhere else
in the system — a custom endpoint, a proxy that rewrites paths, or a
provider id that collides with a built-in label are all able to produce a
label this extension will faithfully record without cross-checking it
against anything. `customResolveMethod` exists precisely so an integrator
can correct or replace this guesswork for their own topology.

## 4. The write-gating invariant: coupled to actual session issuance

```
Operation:     cookie write (after-hook, matches every request)
Requires:      resolveMethod(ctx) returns a non-null label.
Ensures:       the cookie is written IF AND ONLY IF the response's
               Set-Cookie headers ALREADY include the base contract's
               primary session-token cookie name — i.e. this hook does
               not itself determine "did authentication succeed"; it reads
               that fact off the base contract's own postcondition, which
               by the time this after-hook runs has already been
               discharged (or not) by the base pipeline.
Invariant:     it is structurally impossible for this extension to record
               a login method for a request that did NOT actually result
               in a new session — the confirmed test behaviors ("should
               NOT set the last login method cookie on failed
               authentication," "...on failed OAuth callback") are a direct
               consequence of this coupling, not of separate,
               independently-maintained success/failure detection logic
               that could drift out of sync with the base contract.
On violation:  n/a — there is no failure mode here that isn't already
               covered by "resolveMethod returned null" or "no session
               cookie was set," both of which simply result in no write,
               never an error.
```

```
Operation:     database write (databaseHooks, only when storeInDatabase)
Requires:      `storeInDatabase: true`.
               For the FIRST login of an account (sign-up): the
               `user.create.before` hook fires with the same-request
               context, so the field can be populated in the SAME
               insert as the user row itself.
               For every SUBSEQUENT session (sign-in on an existing
               user): the `session.create.after` hook fires once the
               session row itself has already been created, and issues a
               follow-up `updateUser` call.
Ensures:       `user.lastLoginMethod` reflects the method resolved for the
               request that is, at the moment either hook fires, ALREADY
               in the process of creating a user row (before-hook case) or
               has ALREADY created a session row (after-hook case) — i.e.
               this write, too, is anchored to an operation the base
               contract was already committed to performing, never
               speculative.
Invariant:     the field is overwritten on every qualifying login, not
               merely set once — "last" is accurate, not "first."
On violation:  `updateUser` failing (adapter-level fault) is caught and
               logged; it NEVER propagates to fail the session-creation
               request it is piggybacking on. Blame: ADAPTER, for the
               underlying storage fault — but this extension's own
               contract absorbs that fault rather than letting it corrupt
               the base contract's postcondition (a session was still
               successfully created even if this read-model's own write
               failed). This is the same "never subtract from the base
               postcondition" discipline stated generally in §6.
```

```
SEQUENCE: a qualifying sign-in, both sinks enabled
──────────────────────────────────────────────────────────────────
  client         base session pipeline          last-login-method hooks
    │  POST /sign-in/email                              │
    ├──────────────▶│                                    │
    │                │ credentials verified,               │
    │                │ session created, Set-Cookie          │
    │                │ for primary session token             │
    │                │◀── (session.create.after fires) ─────┤
    │                │                                        │  resolveMethod(ctx) = "email"
    │                │                                        │  storeInDatabase? → updateUser(
    │                │                                        │    lastLoginMethod: "email")
    │                │                                        │    (failure here: logged, swallowed)
    │                │─── response, after-hooks run ─────────▶│
    │                │                                        │  session cookie present in response?
    │                │                                        │  → yes: beforeStoreCookie gate (§5)
    │                │                                        │  → permitted: set cookie
    │◀── 200 + Set-Cookie(session) + Set-Cookie(last_used_login_method) ─┘
```

## 5. The two storage sinks are independently gated — a subtlety worth flagging explicitly

```
Invariant:     the COOKIE sink (client-observable) and the DATABASE sink
               (server-observable, via `storeInDatabase`) are configured,
               gated, and written INDEPENDENTLY of one another:
                 - `beforeStoreCookie` gates ONLY the cookie write. Its
                   return value (or thrown/rejected outcome — both are
                   caught and treated as "do not write," logged, never
                   allowed to fail the underlying sign-in) has NO effect
                   on whether the database field is written.
                 - `storeInDatabase` gates ONLY the database write, and has
                   no cookie-side gate of its own beyond the shared
                   "did a session actually get created" coupling (§4).
               Confirmed behavior: with BOTH enabled, and
               `beforeStoreCookie` returning `false` for a given login, the
               database field IS still updated for that login even though
               the cookie is not set.
On violation:  n/a as a runtime error — but this is exactly the kind of
               specialization behavior methodology doc 01 §5 requires be
               DOCUMENTED rather than assumed: an integrator who treats
               `beforeStoreCookie` as a general-purpose consent switch
               (e.g. for a GDPR requirement covering ALL storage of this
               data, not just the client-visible cookie) will be surprised
               to find the database copy persists regardless. Blame, once
               this is documented (as here): CLIENT/integrator, for
               relying on a narrower gate than the one actually offered —
               an integrator with that requirement must also condition
               `storeInDatabase` itself (or apply their own logic before
               enabling it) rather than relying on `beforeStoreCookie`
               alone.
```

```
DECISION DIAGRAM: independent gating of the two sinks
──────────────────────────────────────────────────────────────
        did resolveMethod(ctx) return a label,
        AND did this response actually issue a session cookie? ──NO──▶ neither sink writes
                            │ YES
              ┌─────────────┴─────────────┐
              ▼                             ▼
   COOKIE SINK                     DATABASE SINK
   gate: beforeStoreCookie(ctx,     gate: storeInDatabase === true
         method) truthy?  (default:        (no further gate — always
         true if unconfigured;              writes once this branch is
         false/throw/rejection →            reached, on every qualifying
         suppressed, logged, auth           login, not just the first)
         unaffected)
              │                             │
        write / skip cookie           updateUser(...) / skip
        (independently of the         (independently of the
         database branch's outcome)   cookie branch's outcome)
```

## 6. Robustness invariant: this extension can only ADD observations, never subtract from the base contract

```
Invariant:     no failure internal to this extension — a throwing
               `customResolveMethod`, a throwing/rejecting
               `beforeStoreCookie`, an `updateUser` adapter fault, a
               missing `ctx.path` — is ever allowed to prevent, delay, or
               alter the outcome of the authentication operation it is
               observing. Every one of these failure modes is caught at
               the narrowest possible point and degrades to "this
               extension's own write is skipped," logged where a logger is
               available, with the base contract's session-issuance
               postcondition completely unaffected.
On violation:  a hypothetical implementation that let, e.g., a
               `beforeStoreCookie` exception propagate up through the
               response pipeline and turn a successful sign-in into a 500
               would be a SUPPLIER defect — this extension existing at all
               must never make the base contract's guarantees LESS
               reliable than they were without it. The shipped
               implementation upholds this for every internal failure
               mode enumerated above.
```

## 7. Not a security boundary

```
Invariant:     the recorded "last login method" — in either sink — is
               ADVISORY UX metadata, never an authorization input. Its
               resolution (§3) is a best-effort path-based guess, its
               cookie is explicitly non-httpOnly (readable and, in
               principle, writable by client-side script), and neither
               sink participates in the base contract's validity,
               expiry, or revocation checks in any way.
On violation:  a relying party that used the cookie value (or the database
               field) as an input to an authorization decision (e.g. "trust
               this request more because the cookie claims a
               high-assurance method was last used") would be introducing
               a vulnerability entirely of its own making — blame CLIENT
               (integrator), never this extension, which makes no
               integrity claim about this data beyond "this is what
               resolveMethod computed for the request that most recently
               satisfied §4's coupling condition."
```

## 8. Cross-subdomain cookie clearing — a plain attribute-matching precondition

```
Operation:     client-side clearLastUsedLoginMethod()
Requires:      when the server was configured with cross-subdomain cookies
               (a shared `domain` attribute), the CLIENT-side call must be
               configured with the SAME `domain` value.
Ensures:       the cookie-clearing write includes a matching `domain`
               attribute, without which a browser will treat the clear as
               applying to a different (host-only) cookie and leave the
               real, domain-scoped cookie in place.
On violation:  a mismatched or omitted client-side `domain` results in the
               cookie appearing to survive a "clear" call. Blame: CLIENT
               (the application's own frontend configuration), for not
               mirroring server-side cookie scoping — this is an ordinary
               cookie-attribute precondition, not a defect in either side's
               logic individually.
```

## 9. Liskov compliance check

```
Base session contract:         REQUIRE P (credential presented)
                                ENSURE  Q (session issued or not, per validity)
last-login-method:              REQUIRE P  (unchanged — this extension adds
                                            no requirement on the
                                            authenticating request itself)
                                 ENSURE  Q ∧ Q'  where
                                   Q' = "IF Q's session-issuance branch held,
                                        a best-effort method label is
                                        additionally recorded to zero, one,
                                        or two independently-gated sinks;
                                        IF Q's session-issuance branch did
                                        NOT hold, NOTHING is recorded"
```

* Precondition: unchanged — this extension never adds a requirement the
  authenticating request must satisfy beyond what the base contract already
  demands.
* Postcondition: strictly additive, and — per §4 and §6 — provably unable to
  regress the base contract's own guarantee, since every one of its own
  internal failure modes is contained and never surfaces as a failure of
  the operation it observes. The only property worth flagging as a
  documented specialization detail (not a weakening of the base contract,
  but a nuance of THIS extension's own two-sink design) is §5's
  independent gating — recorded here so an Effect-native reimplementation
  does not accidentally couple the two sinks under a single consent gate
  where the original does not.
