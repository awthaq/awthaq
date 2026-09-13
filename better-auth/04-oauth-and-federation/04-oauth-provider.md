# OAuth2/OIDC Authorization Server Contract

> This document specifies better-auth acting in the OPPOSITE role from
> `01`–`03`: here better-auth IS the authorization server, and the
> external party is a **relying party** — a third-party application
> integrating "Sign in with (this deployment)." Because better-auth is
> itself the provider, the UPSTREAM PROVIDER blame category from
> `00-methodology/03` generally does not apply within this document —
> the only genuine third-party boundary crossed FROM this role is the
> outbound backchannel-logout notification (§8), where better-auth
> itself becomes a caller of another party's endpoint. Everywhere else,
> the two parties are CLIENT (the relying-party application, and
> transitively, its own end user) and SUPPLIER (better-auth's own
> authorization-server logic, or the deploying operator's configuration
> of it).

---

## 1. Client registration contract

Three registration paths exist, each with its own precondition set, but
all producing the same kind of registered-client record and subject to
the same invariants thereafter.

```
Operation:     Register Client — Dynamic (self-service)
Requires:      - dynamic registration is enabled by the deploying
                 operator at all
               - the caller presents EITHER an authenticated operator
                 session, OR a valid initial-access credential verified
                 by an operator-supplied verification value, OR the
                 operator has explicitly allowed fully unauthenticated
                 registration
               - IF the requested grant set includes the
                 authorization-code grant: at least one redirect URI is
                 supplied, and every supplied redirect URI satisfies the
                 redirect-URI validity rules in §1.1
               - the requested grant set does NOT include a
                 machine-to-machine (client-credentials-shaped) grant
                 for an otherwise-unauthenticated dynamic registration
                 attempt — a caller with no operator-side credential at
                 all cannot dynamically mint itself a confidential,
                 credential-only client
               - requested scopes are a subset of the operator's
                 configured allowed scope set
               - IF a JWKS location is supplied for a signed-assertion
                 authentication method: it is reachable only over a
                 public, non-private, credential-free, fragment-free
                 HTTPS URL, UNLESS it is explicitly trusted by the
                 operator or belongs to the same origin as a client-
                 identifier-metadata document driving this registration
Ensures:       a new client record is created with a globally unique
               client identifier
Invariant:     see §1.2 (secret handling) and §1.3 (identifier
               uniqueness)
On violation:  - dynamic registration disabled, or authentication
                 precondition unmet: raised as an access-denied error.
                 Blamed party: CLIENT.
               - redirect URI fails validity rules, requested scope
                 exceeds the allowed set, JWKS location fails the SSRF
                 guard: raised as an invalid-client-metadata error.
                 Blamed party: CLIENT — the registering application
                 supplied metadata this operation's precondition
                 rejects.
```

```
Operation:     Register Client — Operator-Managed
Requires:      an authenticated operator session, AND a privilege check
               (an operator-supplied decision over whether this caller
               may create/administer clients) passing
Ensures:       identical to dynamic registration's postcondition, minus
               the unauthenticated-caller preconditions above (an
               operator-managed registration may create a confidential,
               credential-only client directly)
Invariant:     same as §1.2/§1.3
On violation:  privilege check fails: raised as a forbidden error.
               Blamed party: CLIENT (the caller lacks the privilege the
               operator's own policy requires) — this is still CLIENT-
               blamed under this document's vocabulary because the
               caller is external to the authorization-server's own
               logic, even though they may be the deploying
               organization's own staff.
```

```
Operation:     Register Client — Client-Identifier Metadata Document
Requires:      the presented client identifier is itself an HTTPS URL
               that resolves to a well-formed client metadata document
Ensures:       a client record is created or reused, scoped to the
               metadata document's own origin — a second registration
               attempt racing to create the same client identifier from
               the same metadata source resolves to the SAME
               underlying record (re-fetched and reconciled, never
               silently duplicated), while a DIFFERENT metadata source
               can never take over an existing client identifier it does
               not itself own
Invariant:     a client identifier's owning metadata source, once
               established, is fixed — no later registration attempt
               from a different source may silently reassign it
On violation:  the metadata document is unreachable or malformed:
               Blamed party: CLIENT (the party presenting this
               identifier is responsible for the document it points to
               resolving correctly — this is not an UPSTREAM PROVIDER
               fault because better-auth, in this role, has no upstream;
               the metadata document is simply data the CLIENT is
               vouching for by presenting the identifier).
```

### 1.1 Redirect URI validity rules

```
INVARIANT (Redirect URI Validity):
   a WEB client's redirect URI: HTTPS scheme required on any
     non-loopback host.
   a NATIVE client's redirect URI: EITHER an exact loopback address
     (any port — see §1.1.1), OR a non-loopback HTTPS URL, OR a
     well-formed reverse-domain private-use URI scheme.
   forbidden UNCONDITIONALLY, for any client type: a scheme capable of
     executing script or reading local files in the context of the
     redirect target, and any redirect URI carrying embedded
     credentials or a fragment component.
```

#### 1.1.1 Loopback port matching (the one intentional fuzzy match)

```
INVARIANT (Loopback Redirect Matching):
   a registered loopback redirect URI matches an authorization
   request's redirect URI if EVERY component except the port is
   byte-identical, and only the port is permitted to differ. This is
   the ONLY approximate-match rule in this entire document — every
   other redirect URI comparison (§2) is exact.
```

### 1.2 Client secret invariant

```
INVARIANT (Client Secret Handling):
   - a client requiring a shared secret (per `01 §5.1`'s shared-secret
     method) is issued one, generated with sufficient entropy, and
     returned to the registering caller EXACTLY ONCE, at registration
     (or rotation) time
   - a public client, a client using a signed-assertion method, or a
     client using an extension authentication method that supplies no
     shared secret, is NEVER issued one
   - the secret is stored ONLY as a hash or an operator-configured
     encrypted form — never as retrievable plaintext, and hashed
     storage and encrypted storage are mutually exclusive storage
     modes for a given deployment, never mixed per-client
   - every later verification of a presented secret is a constant-time
     comparison against the stored hash/decrypted value — never a
     comparison that leaks timing information proportional to how much
     of the secret matched
   - a configured secret expiry is either "never" or a fixed lifetime
     from issuance; an expired secret fails authentication
     identically to a wrong one (no distinct "expired vs wrong" signal
     is leaked to the caller)
```

```
On violation:  a stored secret is found to be recoverable in plaintext,
               or a comparison is found to run in variable time:
               Blamed party: SUPPLIER — this is an authorization-server
               implementation defect, never attributable to the
               relying-party CLIENT.
```

### 1.3 Client identifier uniqueness

```
INVARIANT (Client Identifier Uniqueness):
   at most one client record exists for a given client identifier at
   any time. A registration attempt that would collide with an
   existing identifier either fails outright (operator-managed,
   dynamic paths) or is deterministically reconciled onto the existing
   record rather than duplicated (client-identifier-metadata-document
   path, §1's own note).
```

---

## 2. Authorization code issuance contract

```
Operation:     Authorize
Requires:      - a registered, non-disabled client identifier
               - that client is registered for the authorization-code
                 grant
               - a response type requesting a code, exactly, supplied
                 exactly once
               - a redirect URI that EXACTLY matches one of the
                 client's registered redirect URIs (per §1.1's rules,
                 including the loopback-port exception)
               - requested scopes are a subset of what the client is
                 privileged for
               - PKCE parameters, WHEN REQUIRED (see below), both
                 present and well-formed, using ONLY the strong
                 challenge method (`01 §3.2`'s S256; the weak "plain"
                 method is never accepted here even if a caller
                 supplies it)
               - IF a claims-shaped parameter is present, the openid
                 scope is also requested, and the parameter is
                 well-formed
Ensures:       - IF client identifier or redirect URI fail to resolve
                 to a valid, matching pair, the operation NEVER
                 redirects the browser anywhere the caller controls —
                 the failure is rendered on an authorization-server-
                 owned surface, not delivered via redirect. This is an
                 unconditional carve-out with no exception: an
                 unverifiable redirect target is never trusted enough
                 to receive an error report either.
               - EVERY OTHER failure (bad scope, PKCE failure, consent
                 required, invalid resource, etc.), once client and
                 redirect URI are validated, IS delivered to the
                 client's own redirect URI, as a structured error
                 outcome rather than an authorization-server-rendered
                 page
               - on success, a fresh, single-use authorization code is
                 issued, bound at issuance to: the client identifier,
                 the exact redirect URI used, the granted scope, the
                 PKCE challenge and method (if used), any requested
                 resource indicators, the authenticated end user, the
                 authenticating session, and the authentication instant
               - the issued code has a short, fixed lifetime from
                 issuance
Invariant:     PKCE is REQUIRED, not merely available, when: the
               client is public (no confidential authentication
               method registered), OR the requested scope includes an
               offline-access grant of a refresh token UNLESS the
               request is already a confidential, OIDC request
               carrying its own nonce (nonce substitutes as an
               equivalent code-injection countermeasure in that one
               case). For a confidential client outside those cases,
               PKCE defaults to required but MAY be relaxed per-client
               at registration time — an explicit, auditable
               per-client decision, never a global silent default.
On violation:  - client id/redirect URI fail to resolve: raised on an
                 authorization-server-owned error surface, never via
                 redirect. Blamed party: CLIENT (the relying party sent
                 a request naming an unregistered client or an
                 unregistered redirect target) — UNLESS the client
                 record itself does not exist at all, which is
                 indistinguishable from the same case at this
                 precondition layer.
               - any other precondition fails, after client/redirect
                 validation: delivered to the client's redirect URI as
                 a structured error. Blamed party: CLIENT for malformed
                 requests (bad scope, missing PKCE where required,
                 malformed claims parameter); this entire step never
                 attributes failure to UPSTREAM PROVIDER, since
                 better-auth has no upstream in this role.
```

### 2.1 Authorization code single-use invariant

```
INVARIANT (Authorization Code Single-Use):
   redeeming an authorization code (§3) is an atomic
   consume-and-return operation — a concurrent or later second
   redemption attempt of the SAME code always observes "already
   consumed," never a second success, regardless of request timing.

   A redemption attempt against an ALREADY-CONSUMED code is treated as
   a signal that the code may have been intercepted and successfully
   used once already: every access and refresh token that was
   previously minted from that specific code's identity is
   proactively revoked as a defensive response, not merely rejecting
   the replay attempt itself.
```

```
On violation:  a second redemption of an already-consumed code is
               attempted: raised as an invalid-grant error, delivered
               to the caller of the token endpoint (not via browser
               redirect — token exchange is a direct server-to-server
               call). Blamed party: CLIENT — either a legitimate
               client's own retry-logic bug (resending a request whose
               response was lost) or a genuine interception attack;
               this document does not attempt to distinguish the two,
               and treats both identically by revoking the tokens the
               first, successful redemption produced.
```

---

## 3. Consent contract

```
Operation:     Evaluate Consent Requirement
Requires:      an authorization request that has already passed §2's
               client/redirect/scope/PKCE preconditions
Ensures:       consent is required UNLESS EITHER:
                 (a) the client is marked to skip consent entirely
                     (an operator-granted, first-party trust decision,
                     never a client's own self-declaration), OR
                 (b) a prior consent decision exists for this exact
                     (client, end user [, deployer-defined consent
                     scope, e.g. a specific organization/tenant])
                     tuple, and that prior decision's granted scopes,
                     claims, and resources are a SUPERSET of everything
                     the CURRENT request asks for
               a request explicitly demanding fresh consent always
               forces the consent step regardless of (a)/(b)
Invariant:     consent, once evaluated as required, is asked for the
               FULL current request's scope/claims/resources — never a
               partial re-ask covering only what changed since a prior
               grant
On violation:  n/a — this operation has no failure mode of its own; it
               only decides whether §3.1 must run before an
               authorization code can be issued.
```

```
Operation:     Record Consent Decision
Requires:      an authenticated end user actively presented with the
               exact scope/claims/resource set from the pending request
Ensures:       - IF the end user grants: a consent record is created or
                 updated for (client, end user [, consent scope]),
                 covering EXACTLY the accepted scopes/claims/resources —
                 which must themselves be no broader than what was
                 originally requested (the consent UI cannot grant more
                 than was asked)
               - IF the end user denies: no consent record is written
                 or widened, and the pending authorization request is
                 terminated with an access-denied outcome delivered to
                 the client's redirect URI — no code is issued
Invariant:     a consent record never silently grows beyond what an
               end user explicitly saw and accepted in one decision;
               growing it always requires a fresh Evaluate/Record cycle
               (§3's "scope escalation forces re-consent" rule)
On violation:  the end user denies: raised as an access-denied error,
               delivered via redirect. Blamed party: CLIENT is not
               quite right here — this is the END USER's own decision,
               which this document treats as neither party's fault: it
               is the correct, intended outcome of asking. Where a
               "blamed party" framing is still useful for the client
               APPLICATION'S retry logic, treat it as CLIENT-scoped
               (the calling application must not silently retry as
               though this were a transient failure).
```

---

## 4. Token issuance contract

Each grant type is its own arrow contract, sharing one token-issuance
postcondition shape but with independent preconditions:

```
GrantHandler : (GrantRequest, AuthenticatedClient) -> TokenSet | OAuthError

  authorization_code:
     REQUIRES a code satisfying §2.1's single-use invariant, whose
       bound redirect URI matches the one now presented (or both
       absent), and — if the code was bound to a PKCE challenge — a
       verifier hashing to that challenge; a public client relies on
       PKCE alone in place of client authentication, a confidential
       client additionally authenticates per `01 §5.1`. The bound end
       user and authenticating session must still exist and the
       session must not have since expired.
     ENSURES an access token scoped to exactly the code's bound scope;
       an ID token if the bound scope included openid; a refresh token
       ONLY IF the client is registered for refresh AND the bound
       scope included an offline-access grant.

  client_credentials:
     REQUIRES client authentication (a public/"none"-authenticated
       client is UNCONDITIONALLY forbidden from this grant, per
       `01 §5.1`'s own "none" precondition); requested scope drawn
       ONLY from a distinct, operator-configured machine-to-machine
       scope ceiling — NEVER from end-user-delegated scope categories
       (an OIDC identity scope, an offline-access grant) which have no
       meaning without an end user.
     ENSURES an access token with no bound end user or session; NEVER a
       refresh token (this grant is never renewed by refresh — a new
       client_credentials call is the renewal mechanism).

  refresh_token:
     REQUIRES a refresh token that is valid, unexpired, unrevoked, and
       bound to the presenting client identifier; requested scope, if
       narrower than the token's original scope, is honored — the
       original scope is NEVER exceeded by any refresh request. The
       same restriction applies to any resource indicator: refreshing
       can narrow the audience but never broaden it beyond what the
       original grant covered.
     ENSURES a new access token; a rotated refresh token per §4.1
       unless rotation is not the deployment's policy.

  device_code (opt-in extension):
     REQUIRES a device-flow authorization record that has reached an
       approved state through its own separate polling/approval
       lifecycle (specified by the device-authorization capability,
       not restated here), plus a re-check of client/scope/resource
       authorization at the moment of exchange (never trusted purely
       from the time the device flow began).
     ENSURES a real, introspectable, revocable token set — identical in
       shape and governed by identical rules to any other grant's
       output, never a distinct "device session" concept.
```

```
On violation (any grant, general form):  a REQUIRES clause failing is
   raised as the corresponding standard OAuth2 error outcome
   (invalid_grant, invalid_client, invalid_scope, unauthorized_client,
   unsupported_grant_type, invalid_target). Blamed party: CLIENT —
   uniformly, for every grant-type precondition failure specified
   above, since every one of them concerns data the relying-party
   application supplied or a credential it presented.
```

### 4.1 Refresh token rotation and reuse-breach response

```
Operation:     Rotate Refresh Token
Requires:      a successful §4 refresh_token grant evaluation
Ensures:       - by default: a brand-new refresh token is minted, and
                 the OLD refresh token's record is atomically
                 transitioned to revoked as part of the same operation
                 that mints the new one — a race between two
                 concurrent uses of the SAME old token can produce at
                 most one winner; the loser observes "invalid_grant,"
                 never a second valid token pair
               - IF the deployment configures a short reuse-tolerance
                 window instead of strict single-use: a repeat request
                 presenting the SAME old token WITHIN that window
                 receives the SAME prior response it already received
                 (replayed, not re-derived) rather than being treated
                 as a breach — this exists specifically to tolerate a
                 single client's own accidental double-fire, not to
                 weaken rotation generally
Invariant:     a refresh token, once superseded by rotation (outside
               any explicit reuse-tolerance window), can never again
               satisfy §4's refresh_token precondition
On violation:  a refresh token already known to be revoked (rotated
               away, and outside any reuse-tolerance window, or
               explicitly revoked per §5) is presented: raised as
               invalid_grant, AND treated as a breach signal — every
               refresh and access token issued for that SAME client +
               end-user pairing is invalidated as a unit ("family"
               invalidation), not just the one presented token. Blamed
               party: CLIENT is the immediate presenter, but the
               invalidation response itself is not a punishment of that
               specific caller — it is a defensive assumption that the
               token material for this client+user pairing may be
               compromised, protecting the END USER regardless of which
               party (a legitimate but confused client, or a genuine
               attacker) is actually presenting the reused token.
```

### 4.2 Access token binding

```
INVARIANT (Access Token Binding):
   an access token is, by default, an opaque reference requiring an
   introspection call (§5) to resolve. It becomes a self-contained,
   independently verifiable signed token automatically when issued for
   a specific resource audience under an operator-enabled signing
   capability. Independently of that choice, a token MAY be
   proof-of-possession-bound (per `01 §6`'s DPoP contract) — a
   sender-constrained token can NEVER be presented as a plain bearer
   token; a resource server verifying such a token MUST additionally
   verify a fresh proof, or reject the presentation outright.
   Sender-constraint binding, once established at issuance, is
   preserved across §4.1's rotation — a rotated refresh token issued
   from a bound grant produces an equally bound access token, never a
   silently downgraded bearer one.
```

---

## 5. Introspection and revocation contract

```
Operation:     Introspect Token
Requires:      the caller authenticates as a registered client
Ensures:       - IF the caller is the client that originally issued the
                 token (its own token), OR the caller is a DIFFERENT
                 client independently linked to at least one resource
                 named in the token's audience: the response reveals
                 whether the token is currently active and, if so, its
                 scope, owning client, subject, expiry, issuance time,
                 audience, and any resource-scoped claims
               - IF the caller satisfies NEITHER condition above: the
                 response is IDENTICAL in shape to the response for a
                 genuinely unknown or expired token (active: false,
                 nothing else revealed) — an unauthorized caller can
                 never distinguish "this token doesn't exist" from
                 "this token exists but you may not see it"
               - a token whose owning authentication session has ended
                 (by any means, including a backchannel logout event,
                 §8) is reported inactive at introspection EVEN IF its
                 stated expiry has not yet been reached — session
                 liveness is an independent, additional gate beyond raw
                 expiry, checked identically whether the token is
                 opaque or self-contained
               - a token bound to a resource that has since been
                 permanently removed (as opposed to merely disabled) is
                 also reported inactive — removing a resource revokes
                 every token scoped to it; disabling one does not
                 retroactively invalidate tokens already issued for it
Invariant:     introspection NEVER leaks the existence of a token to a
               caller not entitled to know about it (§5's anti-scanning
               property)
On violation:  caller fails client authentication entirely: raised as
               an authentication error, distinct from and prior to the
               "active: false" outcome above (which is reserved for an
               AUTHENTICATED-but-unentitled caller). Blamed party:
               CLIENT.
```

```
Operation:     Revoke Token
Requires:      the caller authenticates as a registered client
Ensures:       - revoking an ACCESS token removes only that token's own
                 record; a self-contained signed access token cannot be
                 individually revoked this way at all (its self-
                 contained nature means there is no stored record to
                 delete) — this is reported as a distinct
                 unsupported-token-type outcome, never silently treated
                 as a successful no-op
               - revoking a REFRESH token atomically marks it revoked
                 AND deletes every access token that was minted FROM
                 it — the cascade runs in that direction only (revoking
                 an access token never touches the refresh token that
                 produced it)
               - IF the presented refresh token was ALREADY revoked
                 before this call: the SAME family-invalidation
                 response as §4.1 applies
               - presenting an already-invalid or entirely unknown
                 token (other than the self-contained-access-token
                 case above) always reports success — this operation
                 never reveals whether a token existed
Invariant:     revocation is idempotent for every outcome except the
               unsupported-token-type case, which is reported
               consistently every time for that same kind of token
On violation:  n/a beyond the unsupported-token-type outcome and the
               authentication-failure case, both blamed on CLIENT under
               the same reasoning as introspection.
```

---

## 6. Scope enforcement invariant

```
INVARIANT (Scope Never Widens):
   scope is checked and narrowed at every hop, and NEVER regains
   breadth once narrowed:
     (1) Authorize:        requested scope ∩ client's registered scope
     (2) Code issuance:    exactly the scope resolved at (1), fixed
     (3) Token issuance
         (authorization_code): exactly the scope stored on the code —
                                 the token endpoint never re-reads a
                                 caller-supplied scope for this grant
     (4) Refresh:          requested scope ⊆ the refresh token's own
                                 stored scope — escalation requires a
                                 brand-new Authorize/Consent round trip,
                                 never a refresh request
     (5) client_credentials: requested scope ⊆ the operator-configured
                                 machine-to-machine ceiling, wholly
                                 disjoint from end-user-delegated scope
                                 categories
     (6) Resource binding:  a resource's own allowed-scope list further
                                 INTERSECTS the effective scope whenever
                                 a resource indicator is present — never
                                 adds to it
     (7) Consent:            a code is issued only once a consent
                                 record already covers the code's full
                                 scope (or consent is operator-waived
                                 for this client) — consent is a gate,
                                 not a scope SOURCE
   No path exists by which an issued token's scope can exceed the
   intersection of everything the end user consented to and every
   static ceiling (client privilege, resource allow-list) that applied
   at issuance.
```

```
On violation:  an issued token is found carrying scope outside this
               invariant's intersection: Blamed party: SUPPLIER — this
               can only happen through a defect in the authorization-
               server's own enforcement logic; it is never attributable
               to a relying-party CLIENT, since every widening
               opportunity in the chain above is a SUPPLIER-owned
               enforcement point, not something a client request can
               force open by construction.
```

---

## 7. Error taxonomy summary

| Condition | Blamed party |
|---|---|
| Unregistered/disabled client, unmatched redirect URI at Authorize | CLIENT (never redirected to; see §2) |
| Malformed scope, missing/invalid PKCE where required, malformed claims parameter | CLIENT |
| Authorization code replay | CLIENT (defensive family-wide token revocation follows regardless of intent) |
| Grant-type precondition failure (any of §4's grant handlers) | CLIENT |
| Refresh token reuse after rotation | CLIENT is the immediate presenter; response protects the end user regardless of fault |
| Introspection/revocation by an unentitled or unauthenticated caller | CLIENT |
| An issued token found to exceed the scope-narrowing invariant (§6) | SUPPLIER |
| Client secret recoverable in plaintext, or a non-constant-time comparison | SUPPLIER |
| A consent record found to have silently grown beyond what was ever explicitly accepted | SUPPLIER |
| A backchannel-logout delivery attempt fails (network error, non-success response, timeout) | the RELYING PARTY's own endpoint is unreachable/failing, which this document treats as neither CLIENT nor SUPPLIER fault in the blame-worthy sense — see §8; it is logged, never retried beyond the single attempt, and never blocks the session-termination operation itself |

---

## 8. Logout and backchannel logout contract

```
Operation:     Register for Backchannel Logout
Requires:      a client-supplied logout-notification address, reachable
               only over a public, credential-free, fragment-free HTTPS
               URL (same SSRF-guard shape as §1's JWKS-location rule)
Ensures:       registering this address is itself the entire
               subscription — no separate confirmation step exists
Invariant:     none beyond §1.3's identifier uniqueness (the address is
               just client metadata)
On violation:  the supplied address fails the SSRF/well-formedness
               guard: raised as an invalid-client-metadata error.
               Blamed party: CLIENT.
```

```
Operation:     Terminate Session and Notify Relying Parties
Requires:      a session has been deleted, by any means
Ensures:       - EVERY access token tied to that session is revoked
                 unconditionally
               - EVERY refresh token tied to that session is revoked,
                 UNLESS it carries an offline-access grant, which is
                 explicitly allowed to outlive the browser session that
                 originally created it
               - for every relying party registered for backchannel
                 logout that had a live token under this session, a
                 short-lived, signed logout notification is produced
                 and delivered to that relying party's registered
                 address, on a best-effort, single-attempt basis
               - the durable guarantee does NOT depend on delivery
                 succeeding: §5's introspection contract independently
                 reports any token whose session has ended as inactive,
                 regardless of whether the corresponding relying party
                 ever received, or successfully processed, the
                 notification
Invariant:     a relying party's failure to receive a logout
               notification can NEVER keep a token alive from the
               authorization server's own point of view — server-side
               revocation and introspection are the durable backstop;
               the notification is a best-effort courtesy on top of it
On violation:  notification delivery fails for one relying party:
               logged, not retried, and does not affect the outcome of
               the session-termination operation for any OTHER relying
               party or for the introspection guarantee above. No
               blamed party in the fault sense — this is documented,
               accepted best-effort behavior, not a violated contract.
```

---

## 9. Diagrams

### 9.1 Authorization code + consent + token exchange — full sequence

```
  Relying Party (CLIENT)      better-auth as Authorization Server (SUPPLIER)
       │                                    │
       │ GET /authorize?client_id&redirect_uri&response_type=code       │
       │   &scope&code_challenge=S256(v)&code_challenge_method=S256     │
       ├───────────────────────────────────▶│
       │                                     │ validate client_id + redirect_uri
       │                                     │  ✗ EITHER invalid → render
       │                                     │    error on OWN surface,
       │                                     │    NEVER redirect (§2)
       │                                     │  ✓ both valid
       │                                     │ validate scope/PKCE/claims
       │                                     │  ✗ → redirect to redirect_uri
       │                                     │    with ?error=...        │
       │◀── redirect (only reached once      │
       │    client+redirect_uri validated) ──┤
       │                                     │ Evaluate Consent (§3)
       │                                     │  needed? → render consent UI
       │                                     │  (end user interacts)
       │                                     │ Record Consent Decision
       │                                     │  deny → redirect
       │                                     │    ?error=access_denied
       │                                     │  grant → issue single-use
       │                                     │    authorization code,
       │                                     │    bound to client+redirect
       │                                     │    +scope+PKCE+resource
       │◀── redirect ?code&state ────────────┤
       │                                     │
       │ POST /token                         │
       │  grant_type=authorization_code       │
       │  code, code_verifier=v, redirect_uri,│
       │  client authentication (§1 §5.1)     │
       ├────────────────────────────────────▶│
       │                                     │ Consume code (§2.1, atomic)
       │                                     │  already consumed? → revoke
       │                                     │    every token from this
       │                                     │    code's prior redemption,
       │                                     │    respond invalid_grant
       │                                     │  fresh → verify PKCE match
       │                                     │  ✗ mismatch → invalid_grant
       │                                     │  ✓ issue access token,
       │                                     │    ID token (if openid),
       │                                     │    refresh token (if
       │                                     │    offline_access granted)
       │◀── token response ───────────────────┤
```

### 9.2 Refresh token rotation and breach response — state diagram

```
                    Token issued (initial grant, §4)
                                │
                                ▼
                       ┌────────────────┐
                  ┌───▶│     ACTIVE      │
                  │    └───────┬────────┘
                  │            │ Refresh grant (§4) presents this token
                  │            ▼
                  │   ┌─────────────────────┐
                  │   │ atomic CAS: mark     │
                  │   │ REVOKED, mint new    │──── new token starts at
                  │   │ ACTIVE successor     │     ACTIVE (loop back ▲)
                  │   └──────────┬──────────┘
                  │              │
             (within reuse-      │ (outside any reuse-tolerance
              tolerance window,  │  window, OR reuse-tolerance
              if configured)     │  not configured at all)
                  │              ▼
                  │     ┌─────────────────┐
                  └─────│    REVOKED       │
                         └────────┬────────┘
                                  │ this SAME revoked token is
                                  │ presented AGAIN to Refresh (§4)
                                  ▼
                    ┌───────────────────────────┐
                    │  BREACH RESPONSE:           │
                    │  invalidate the ENTIRE       │
                    │  refresh/access token family │
                    │  for this client+user pair   │
                    │  (§4.1) — every token in the │
                    │  family becomes REVOKED,     │
                    │  regardless of its own state │
                    └───────────────────────────┘

     Only one path re-enters ACTIVE (successful, first-time rotation).
     Every other path terminates at REVOKED, and the family-breach
     path is irreversible for the whole family, not just the one token
     presented.
```
