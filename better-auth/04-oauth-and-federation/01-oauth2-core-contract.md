# OAuth2 Core Client Contract

> Prerequisite reading: `00-methodology/01-03`. This document assumes the
> Hoare-triple operation shape, the domain→range arrow notation for
> higher-order values, and the CLIENT / SUPPLIER / ADAPTER / UPSTREAM
> PROVIDER blame vocabulary defined there.

This document specifies the *generic* contract better-auth honors whenever
it acts as an **OAuth2/OIDC client** — i.e. whenever it is the party
redirecting an end user's browser to a third-party authorization server and
later exchanging a code for tokens. Every concrete capability built on top
of this contract (`02-social-sign-in`, `03-generic-oauth`, and the identity
provider federation leg of `05-sso`) is a specialization of the operations
specified here and must not narrow what this document promises (per §5 of
`01-design-by-contract.md`).

Three real-world parties are in scope for blame in this document, per the
justification in `00-methodology/03`: the **CLIENT** (the end user's
browser, or a caller of better-auth's server-to-server API), the
**SUPPLIER** (better-auth itself, or the deployer's configuration of it),
and the **UPSTREAM PROVIDER** (the external authorization server —
Google, GitHub, a generic OIDC issuer, etc. — a genuine third boundary
outside better-auth's control, reached only over the network, whose
responses cannot be validated for anything beyond well-formedness and
cryptographic authenticity).

---

## 1. The provider-strategy contract

Every concrete OAuth2/OIDC provider — whether a built-in social provider
(`02`), a developer-configured generic provider (`03`), or an enterprise
federation endpoint (`05`) — is required to supply a fixed bundle of
higher-order values. This bundle *is* the "provider strategy," and every
operation in this document is a lazily-checked arrow contract discharged
against one such bundle:

```
ProviderStrategy =
   buildAuthorizationURL   : (ClientConfig, RequestParams)        -> AuthorizationURL
 ∧ exchangeCode            : (ClientConfig, Code, PKCEVerifier?)  -> TokenResponse | ProviderError
 ∧ refreshToken            : (ClientConfig, RefreshToken)         -> TokenResponse | ProviderError
 ∧ retrieveUserInfo        : (TokenResponse)                      -> RawProfile | ProviderError
 ∧ resolveAccountSubject   : (TokenResponse, RawProfile)          -> ProviderAccountId
 ∧ verifyIdToken           : (IdToken, ExpectedClaims)            -> VerifiedClaims | false
```

`resolveAccountSubject` is deliberately isolated from the profile-mapping
value that later normalizes a user's display fields (`02-social-sign-in
§1`): its domain is restricted to the raw token response and raw provider
profile, never to anything a developer-supplied mapping function has
already reshaped. This is a structural invariant, not a convention — it
exists so that no profile-normalization value, however a developer
configures it, can redefine *which real-world provider identity* an
account represents. A provider strategy that lets a mapping function
influence the resolved subject violates this document's contract even if
every individual field mapping is otherwise correct.

**On violation of the `ProviderStrategy` bundle contract:** if a
conjunct is absent when the operation that depends on it is invoked (e.g.
`refreshToken` is called against a strategy that never supplied one), this
is blamed on the **SUPPLIER** (the strategy was registered incomplete for
the capability being invoked) — never on the caller, who reasonably
assumed the full bundle per this document.

---

## 2. Authorization request contract

```
Operation:     Build Authorization URL
Requires:      - a resolved client identifier
               - a redirect URI belonging to the set the deploying
                 application registered for this provider
               - a freshly generated, single-use anti-CSRF state value
                 (see §3)
               - zero or more requested scopes
               - if PKCE is used for this request: a freshly generated
                 code verifier (see §3.2)
               - zero or more provider-specific extra parameters, NONE of
                 which name a reserved parameter (state, client id,
                 redirect uri, response type, code challenge / method,
                 nonce, scope)
Ensures:       - the returned URL deterministically encodes exactly:
                 client id, redirect uri, requested scopes (space-joined
                 or provider-specific separator), the state value
                 unmodified, and — if PKCE is active — a code challenge
                 derived from the verifier by SHA-256 + base64url with
                 challenge method fixed to S256 (no "plain" method is
                 ever produced)
               - no extra parameter can overwrite any reserved parameter,
                 even if a caller supplies one under a colliding key —
                 it is dropped, not merged
Invariant:     the reserved-parameter set is closed: a provider strategy
               cannot extend it to permit smuggling a second state or
               redirect uri through "extra" parameters
On violation:  Precondition violation (missing client id, reserved
               parameter supplied): raised as a configuration/request
               error. Blamed party: CLIENT (a caller of the server-to-
               server construction operation supplied a malformed
               request) or SUPPLIER (a plugin built on this contract
               passed an incomplete `ClientConfig`) — never UPSTREAM
               PROVIDER, since no network call has occurred yet.
```

### 2.1 Outbound-fetch redirect rejection (SSRF containment)

Every server-to-server HTTP call this contract makes on the SUPPLIER's
behalf — token exchange, token refresh, JWKS retrieval, introspection —
is required to refuse to follow HTTP redirects transparently.

```
Operation:     Perform Outbound OAuth2 Fetch
Requires:      a fully-formed request to a provider endpoint
Ensures:       if the response is a redirect (3xx status, or an opaque/
               redirect-filtered response on runtimes that hide the
               status) the operation FAILS closed rather than following
               it
Invariant:     no OAuth2 server-to-server request performed under this
               contract ever silently visits a second URL chosen by the
               responding server
On violation:  raised as a network-boundary error, distinct from an
               ordinary provider error response. Blamed party: UPSTREAM
               PROVIDER — a compliant, honest token/JWKS endpoint never
               needs to redirect; a redirecting endpoint is either
               misconfigured or has been compromised to bounce
               credential-bearing requests toward an internal address
               (cloud metadata services, loopback, private ranges). This
               is a defensive precondition on the *response*, and it is
               listed as UPSTREAM-blamed because the fault, whatever its
               ultimate cause, is observed at the provider's boundary.
```

This is a narrower guarantee than validating the provider's endpoint URLs
themselves (that trust decision belongs to whoever configured the
provider — see `03-generic-oauth`) — it specifically closes the gap
between "the configured endpoint was safe when checked" and "the endpoint,
at request time, tried to redirect the request somewhere else."

---

## 3. State and PKCE — the anti-CSRF contract

### 3.1 State

```
Operation:     Issue Authorization State
Requires:      nothing beyond the intent to start an authorization
               request
Ensures:       - a state value with cryptographically strong entropy is
                 generated, unique with overwhelming probability across
                 concurrent requests
               - the state is bound, at issuance, to: the provider being
                 used, the intended redirect target, and (if PKCE is
                 used) the paired code verifier
               - the state is recorded as PENDING with a fixed, short
                 expiry from issuance
Invariant:     a state value, once issued, can be consumed AT MOST ONCE
On violation:  n/a (this is a pure postcondition-producing operation —
               it has no meaningful precondition to violate)
```

```
Operation:     Consume Authorization State (on provider callback)
Requires:      a state value presented by the callback request
Ensures:       - if a PENDING record exists for exactly this state value,
                 unexpired, it transitions to CONSUMED and its bound
                 provider/redirect/PKCE-verifier association is returned
               - the transition and the return of the association are
                 atomic: two concurrent callbacks presenting the same
                 state can never both observe PENDING
Invariant:     once CONSUMED (or once naturally EXPIRED), a state value
               can never again satisfy this operation's precondition —
               single-use is permanent, not just "single active use"
On violation:  - no record found, or record already CONSUMED: raised as
                 a state-not-found/replay error. Blamed party: CLIENT —
                 either a forged callback (no legitimate authorization
                 request ever produced this state) or a replay of an
                 already-completed callback.
               - record found but EXPIRED: raised as a state-expired
                 error. Blamed party: CLIENT — the authorization dance
                 took longer than the fixed window allowed (an
                 abandoned tab, a slow user) is the caller's timing to
                 manage, not a supplier defect.
               - record found, unexpired, but the presented state
                 string does not exactly match stored state character-
                 for-character (a distinguished "mismatch" outcome from
                 plain not-found): Blamed party: CLIENT — this shape of
                 failure specifically indicates a callback whose
                 companion anti-forgery cookie disagreed with its query
                 parameter, i.e. an attacker who could observe the state
                 value but not control the victim's cookie jar.
```

An implementation may weaken the consume-operation's requirement that a
companion cookie also match the presented state (an explicit, named
opt-out), used only by capabilities that have their own independent replay
protection (`05-sso`'s SAML relay-state binding is one such caller). Per
§5 of `01-design-by-contract.md`, this is a *permitted* specialization only
because the opt-out is explicit and the calling capability substitutes an
equivalent protection — a specialization that dropped the check silently
would be a contract violation blamed on the **SUPPLIER**.

### 3.2 PKCE

```
Operation:     Generate PKCE Pair
Requires:      nothing
Ensures:       a verifier of sufficient entropy is produced, and the
               challenge is exactly its SHA-256 digest, base64url-
               encoded with no padding
Invariant:     the challenge is a pure, deterministic function of the
               verifier — nothing else may be derived from
On violation:  n/a
```

```
Operation:     Verify PKCE at Token Exchange
Requires:      if an authorization request declared a code challenge,
               the matching token-exchange request MUST present the
               original verifier
Ensures:       the exchange proceeds only if SHA-256(presented verifier)
               base64url-equals the challenge recorded at authorization
               time
Invariant:     a code issued against a given challenge can never be
               redeemed by a party that only observed the code
               (intercepted in transit, e.g. via a malicious app on a
               shared OS) but not the verifier
On violation:  mismatch or missing verifier where one was required:
               raised as an invalid-grant error. Blamed party: CLIENT —
               either a genuine attacker attempting code interception,
               or an integrator's bug that lost the verifier between
               request and callback. If the *authorization* request
               never declared a challenge in the first place, PKCE
               verification does not apply at all for that flow — this
               contract does not itself mandate PKCE; §4 notes that
               mandating it is a decision made one layer up, by the
               capability that configures a given provider strategy.
```

This document does not mandate that every authorization request use PKCE
— it specifies what is guaranteed *if* a challenge was declared. Whether
PKCE is mandatory for a given provider or flow is a precondition owned by
the capability layered on top (`04-oauth-provider` mandates it for public
clients; `02`/`03` make it the default but not universally enforced,
since enforcement ultimately depends on what the upstream provider itself
requires).

---

## 4. Callback handling contract

```
Operation:     Handle Provider Callback
Requires:      - a state value that satisfies §3.1's Consume operation
               - EITHER a provider-issued authorization code, OR a
                 provider-issued error parameter explaining why no code
                 was issued
Ensures:       - if an error parameter is present, the operation
                 terminates without attempting a token exchange, and the
                 error is classified and surfaced (see §6) rather than
                 silently treated as "no code, try again"
               - if a code is present and state consumption succeeded,
                 the operation proceeds to §5 (token exchange) using
                 exactly the PKCE verifier and redirect URI bound to
                 the consumed state
Invariant:     the redirect URI presented at token exchange time is
               always the one recorded at authorization time — a
               callback can never retarget which redirect URI is
               asserted to the token endpoint
On violation:  - state consumption failure: see §3.1's own violation
                 clauses (blame CLIENT).
               - a provider error parameter present: Blamed party:
                 UPSTREAM PROVIDER for provider-declared failures whose
                 cause is on the authorization server's side (e.g. the
                 provider itself rejected the request due to its own
                 policy); CLIENT for provider-declared failures whose
                 documented cause is end-user action (e.g. the user
                 declined consent at the provider) — this distinction is
                 preserved, not collapsed, because a deployer's
                 corrective action differs: a provider-side failure is
                 nothing the deployer's own users caused, while a
                 declined-consent failure requires no remediation at
                 all.
```

---

## 5. Token exchange contract

```
Operation:     Exchange Authorization Code for Tokens
Requires:      - a code, obtained from a successful Handle Provider
                 Callback
               - client authentication material appropriate to the
                 provider's registered method (see §5.1)
               - the redirect URI used at authorization time (resent,
                 not re-derived)
               - if PKCE was declared: the paired verifier (§3.2)
Ensures:       - on success, a normalized token response is produced
                 carrying: an access token, an optional refresh token,
                 an optional ID token, a token type, and — if the
                 provider reports it — an absolute expiry instant
                 (never a bare relative "seconds remaining," which
                 becomes meaningless the instant the network reply is
                 delayed)
               - a scope value reported by the provider in any shape
                 (space-joined string, list, a mix of valid and
                 malformed entries) is normalized leniently: well-formed
                 entries are kept, and a malformed shape from the
                 provider does not by itself fail the whole exchange
Invariant:     the token response, once produced, is treated as
               opaque provider-issued material by every layer above
               this contract — no layer above may re-derive or infer a
               scope/expiry the provider did not actually report
On violation:  - the outbound fetch itself fails or is redirected: see
                 §2.1. Blamed party: UPSTREAM PROVIDER.
               - the provider's HTTP response is well-formed OAuth2
                 error JSON: surfaced to the caller as an invalid-grant/
                 invalid-request/etc. error, unwrapped. Blamed party:
                 either CLIENT (code already redeemed, expired, or
                 revoked by end-user action at the provider) or
                 UPSTREAM PROVIDER (the provider's policy or outage
                 caused the rejection) depending on the specific error
                 code the provider returned — this contract preserves
                 the provider's own distinction rather than collapsing
                 all token-exchange failures into one category.
               - the provider's HTTP response is not valid OAuth2 JSON
                 at all (malformed body, wrong content type, truncated):
                 Blamed party: UPSTREAM PROVIDER unconditionally — this
                 is the provider failing to honor the protocol, not a
                 policy decision it is entitled to make.
```

### 5.1 Client authentication to the token endpoint (arrow contract)

Client authentication is itself a family of mutually exclusive strategies,
each with its own precondition, all checked **before** any network call is
attempted (fail fast on configuration error rather than waste a round
trip):

```
ClientAuthMethod : (ClientConfig) -> AuthenticatedRequest | ConfigurationError

  none                : REQUIRES a client id, REQUIRES absence of a secret,
                         FORBIDDEN for a grant type that issues tokens
                         directly to a confidential machine identity
                         (no end-user redirect) — a public client
                         asserting "none" while also requesting
                         machine-to-machine tokens is a contradiction in
                         terms, not merely insecure.

  shared-secret        REQUIRES a client id and a client secret;
  (basic or post)      MUTUALLY EXCLUSIVE with a caller-supplied signed
                         assertion for the same request — carrying both
                         is rejected as ambiguous, not merged.

  signed-assertion      REQUIRES asymmetric key material (never a
  (private-key JWT)      symmetric/shared-secret key — signing with a
                         shared secret under this method is rejected
                         outright, and so is "none" as a signing
                         algorithm), REQUIRES the token endpoint's own
                         URL as the assertion's audience, ENSURES each
                         assertion carries a unique identifier and a
                         short, fixed validity window.

  custom               a deployer-supplied strategy value with the same
                         domain/range shape as the built-in methods,
                         still checked afterward for completeness before
                         the request is sent.
```

**On violation:** any of the REQUIRES clauses above failing is a
configuration precondition violation. Blamed party: **SUPPLIER** — these
are all checked against static configuration, never against anything the
end user or the provider supplied, so a failure here can only mean the
deployer wired the provider up incorrectly. This is deliberately
before the network boundary, so misconfiguration is never mistaken for a
provider outage.

---

## 6. Proof-of-possession token binding (DPoP)

```
DpopProofVerifier : (Proof, HttpMethod, HttpUrl, BoundAccessToken?) -> VerifiedProof | Rejected
```

```
Operation:     Verify DPoP Proof
Requires:      - a compact, signed proof of a fixed type, signed with an
                 asymmetric algorithm (a symmetric or "none" algorithm
                 is unconditionally rejected, independent of any other
                 check)
               - a public key embedded in the proof containing no
                 private-key material
               - the proof's declared HTTP method and URL match the
                 request it accompanies exactly (fragment excluded)
               - the proof's issued-at instant falls inside a bounded
                 freshness window
               - the proof's unique identifier has not been seen before
                 within that same freshness window, for the same key
                 thumbprint/method/URL combination
               - IF the proof is presented alongside an access token
                 bound to a specific key at issuance: the proof also
                 carries a token-hash claim matching that access token,
                 and its key thumbprint matches the token's bound
                 thumbprint
Ensures:       a request is treated as sender-constrained only when
               every clause above holds; a plain bearer presentation of
               a key-bound token is never accepted as equivalent
Invariant:     a replayed proof (same key + method + URL + identifier,
               within the freshness window) is rejected exactly once —
               after the window elapses the identifier need not be
               remembered further, since a stale proof would fail
               freshness anyway
On violation:  any clause failing: Blamed party: CLIENT — the party
               presenting the request constructed or replayed an
               invalid proof; this is always assessed against the
               presenter of the current request, independent of who
               originally obtained the underlying access token.
```

Note the replay store itself is a stateful ADAPTER dependency: a
deployment that only remembers proof identifiers in a single process's
memory cannot detect replay across independent server instances. This is
documented here as an explicit adapter-substitutability concern (per
`02-higher-order-contracts.md §4`) — a DPoP replay store adapter that
only guarantees single-instance memory is a **weaker** implementation of
this contract, not a non-conforming one, and deployers choosing it accept
reduced replay protection knowingly.

---

## 7. ID token verification contract

```
Operation:     Verify Provider ID Token
Requires:      an ID token string, an expected issuer, an expected
               audience, and — whenever the authorization request that
               produced this token declared a nonce — the nonce value to
               check against
Ensures:       the operation returns verified claims if and only if ALL
               of the following hold: the token is a signed JWT (never
               accepted with an unsigned/"none" algorithm), the
               signature verifies against a key belonging to the
               expected issuer, the issuer claim matches exactly, the
               audience claim contains the expected client identifier,
               the token has not expired, and — if a nonce was supplied
               to this operation — the nonce claim matches (by exact
               value or by a provider-declared hashing scheme)
Invariant:     this operation NEVER throws on a failing token — it
               fails closed by returning a definite "not verified"
               outcome, so that every caller is forced to handle
               rejection explicitly rather than accidentally treating an
               uncaught exception as "verification skipped, proceed
               anyway"
On violation:  - signature invalid, issuer/audience mismatch, expired,
                 or nonce mismatch: Blamed party: UPSTREAM PROVIDER if
                 the token was honestly issued by the claimed issuer but
                 fails on a value the provider itself controls (wrong
                 audience because of an issuer-side misrouting, an
                 unexpectedly short expiry); Blamed party: CLIENT if the
                 failure mode is consistent with token substitution or
                 replay (nonce mismatch, audience naming a different
                 client than the one that initiated the flow).
               - nonce was REQUIRED by policy for this call but absent
                 from the token entirely: Blamed party: UPSTREAM
                 PROVIDER — a provider that omits an explicitly
                 requested nonce claim has not honored the request it
                 was sent.
```

A provider strategy may declare that its ID tokens are not JWS-signed at
all (an "opaque" token, deferring identity entirely to a subsequent
userinfo call). This is a valid, but explicitly weaker, specialization:
nonce binding cannot be checked for such tokens (there is no claim to
check), and this document requires that any capability accepting opaque
tokens do so only for providers that explicitly declare this mode — never
as silent, automatic fallback when signature verification merely fails.

An additional provider-declared claims check (e.g. restricting sign-in to
a specific hosted domain) may run **after** all of the above pass. Its
failure is a distinct outcome from token forgery: it means "this is an
authentic, fresh token, but it does not satisfy an extra business rule,"
and must not be reported with the same error shape as a forged token —
doing so would make it impossible for a caller to distinguish "attacker"
from "authentic user outside policy."

---

## 8. Token refresh contract

```
Operation:     Refresh Access Token
Requires:      a refresh token previously issued to this client by this
               provider, and client authentication material per §5.1
Ensures:       - on success, a new access token is returned, with an
                 absolute expiry if the provider reports one
               - a new refresh token MAY or MAY NOT be returned — if
                 absent, the previously held refresh token remains the
                 one to use for the next refresh (this contract does not
                 itself mandate refresh-token rotation; a capability
                 requiring rotation, such as `04-oauth-provider` acting
                 as the issuer, states that separately)
               - no caller-supplied parameter may override the grant
                 type or the refresh token value itself, even under an
                 "extra parameters" escape hatch
Invariant:     this operation performs no local validity check on the
               refresh token before attempting the call — validity is
               entirely the provider's determination, discovered only
               by attempting the exchange
On violation:  - provider rejects the refresh token (revoked, expired,
                 unknown, or refresh unsupported by this provider):
                 surfaced unwrapped as an invalid-grant-shaped error.
                 Blamed party: UPSTREAM PROVIDER if the provider simply
                 does not support refresh at all for its token type;
                 CLIENT if the specific refresh token was individually
                 revoked or has expired through ordinary lifetime rules
                 (e.g. the end user revoked application access at the
                 provider).
               - malformed provider response: Blamed party: UPSTREAM
                 PROVIDER, per §5's general rule.
```

---

## 9. Token storage invariant

```
INVARIANT (Stored Provider Tokens):
   - a stored access/refresh token is always associated with exactly
     one (provider identifier, provider account identifier) pair — see
     §1's `resolveAccountSubject`
   - a deployment MAY choose to store tokens encrypted at rest; if it
     does, the storage layer MUST remain able to read tokens written
     before encryption was enabled — turning encryption on must never
     strand previously stored plaintext tokens as unreadable
   - a stored refresh token that a rotation policy has superseded is
     never left in a state where it would still satisfy §8's precondition
     — it is either deleted or explicitly marked unusable at the moment
     its replacement is issued
```

```
INVARIANT (Provider Account Identity Uniqueness):
   at most one stored account row may exist for a given (provider
   identifier, provider account identifier) pair. If a lookup by this
   pair ever finds more than one matching row, this is treated as an
   unrecoverable data-integrity condition, not resolved by arbitrarily
   picking one — no session is issued, and the condition is surfaced
   distinctly from an ordinary "account not found" outcome.
```

```
On violation of Provider Account Identity Uniqueness:
   Raised as:      an internal data-integrity error, never silently
                    resolved.
   Blamed party:   SUPPLIER / ADAPTER — this invariant can only be
                    broken by a defect in the write path that created
                    the duplicate (a race not properly serialized by
                    the storage adapter, or application code bypassing
                    the linking operations specified in
                    `02-social-sign-in`) — it is never attributable to
                    the end user or to the upstream provider, since the
                    provider only ever supplies one identity per token
                    response.
   Recoverable by: the deployer correcting the duplicate data and, if
                    the storage adapter does not already enforce
                    uniqueness on this pair at the storage layer,
                    adding that enforcement (see
                    `01-core-domain/04-database-adapter-contract.md`).
```

---

## 10. Diagrams

### 10.1 Authorization Code + PKCE — full redirect flow

```
 Browser (CLIENT)      better-auth (SUPPLIER)              Upstream Provider
      │                        │                                    │
      │  GET /sign-in/:pid     │                                    │
      ├───────────────────────▶│                                    │
      │                        │ Generate PKCE Pair (§3.2)          │
      │                        │ Issue Authorization State (§3.1)   │
      │                        │ Build Authorization URL (§2)       │
      │                        │  (state, code_challenge=S256(v),   │
      │                        │   redirect_uri, scopes, client_id) │
      │◀── 302 → provider URL ─┤                                    │
      │                                                             │
      │  GET authorize?state&client_id&code_challenge&redirect_uri  │
      ├────────────────────────────────────────────────────────────▶│
      │                                                              │ user
      │                                                              │ authenticates
      │                                                              │ & consents
      │◀── 302 → redirect_uri?code=...&state=... ────────────────────┤
      │                        │                                    │
      │  GET redirect_uri?code&state                                │
      ├───────────────────────▶│                                    │
      │                        │ Consume Authorization State (§3.1) │
      │                        │  ✗ not found/expired/mismatch      │
      │                        │    → CLIENT-blamed error, STOP     │
      │                        │  ✓ found → {provider, verifier,    │
      │                        │             redirect_uri}          │
      │                        │ Exchange Code for Tokens (§5)      │
      │                        │  POST token_endpoint                │
      │                        │   code, code_verifier=v,            │
      │                        │   redirect_uri, client-auth (§5.1)  │
      │                        ├─────────────────────────────────────▶│
      │                        │        redirect? → reject (§2.1)    │
      │                        │        malformed body → UPSTREAM     │
      │                        │        invalid_grant → CLIENT or     │
      │                        │          UPSTREAM per §5             │
      │                        │◀──── token response ──────────────── │
      │                        │ Verify Provider ID Token (§7)        │
      │                        │  (if id_token present)               │
      │                        │ Retrieve/normalize profile            │
      │                        │ → hand off to §02-social-sign-in      │
      │◀── session established─┤                                    │
```

### 10.2 State value lifecycle (state diagram)

```
                    Issue Authorization
                    State (§3.1)
                         │
                         ▼
                 ┌───────────────┐
          ┌─────▶│    PENDING     │
          │      └───────┬───────┘
          │              │
   (never │    ┌─────────┼─────────────┐
   reused, │    │         │             │
   even if │  fixed    presented,     presented,
   issue   │  window  exact match    mismatched
   fails)  │  elapses  (state+cookie) cookie/value
          │    │         │             │
          │    ▼         ▼             ▼
          │ ┌────────┐ ┌─────────┐ ┌───────────────┐
          │ │EXPIRED │ │CONSUMED │ │ REJECTED       │
          │ └────────┘ └─────────┘ │ (state_mismatch)│
          │                        └───────────────┘
          │
          │   any further presentation of the SAME state value,
          └── from ANY of the three terminal states, yields the
              same outcome as its terminal state — never re-enters
              PENDING, never grants a second CONSUMED transition

   Terminal states: EXPIRED, CONSUMED, REJECTED — all three are
   dead ends with respect to §3.1's Consume operation. Only
   CONSUMED represents a successful callback continuation.
```

### 10.3 Refresh contract failure classification (illustrative)

```
                     Refresh Access Token (§8)
                              │
                 ┌────────────┼─────────────────┐
                 ▼                               ▼
         outbound fetch                   fetch completes
         fails/redirects                          │
                 │                    ┌────────────┴────────────┐
                 ▼                    ▼                          ▼
          UPSTREAM PROVIDER    well-formed OAuth2         not valid OAuth2
          (network/redirect)   error JSON body            JSON at all
                 │                    │                          │
                 │           ┌────────┴─────────┐                │
                 │           ▼                   ▼                │
                 │   token individually    provider doesn't       │
                 │   revoked/expired        support refresh       │
                 │           │                   │                │
                 │           ▼                   ▼                ▼
                 │        CLIENT           UPSTREAM PROVIDER  UPSTREAM PROVIDER
                 └───────────────────────────────────────────────┘
                              all paths converge on a
                              blame-tagged rejection —
                              never a silent empty result
```
