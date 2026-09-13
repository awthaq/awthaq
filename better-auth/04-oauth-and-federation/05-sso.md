# Enterprise SSO Federation Contract

> This document specifies better-auth acting as a **service provider**
> federating with an enterprise identity provider (SAML or OIDC), a role
> distinct from both `01`–`03` (better-auth as a generic OAuth2 client of
> a consumer social provider) and `04` (better-auth as its own
> authorization server). The enterprise identity provider is a genuine
> **UPSTREAM PROVIDER** under `00-methodology/03`'s justification: it is
> a real, independently operated third party whose assertions can only be
> validated for well-formedness and cryptographic authenticity, never
> for truthfulness. The **CLIENT** in this document is the end user's
> browser and, where relevant, an attacker attempting to forge or replay
> a federation message. The **SUPPLIER** is better-auth's own validation
> logic and the deploying operator's registration of a given identity
> provider.

---

## 1. Identity provider registration contract

```
Operation:     Register Identity Provider
Requires:      - a provider identifier that does not collide with ANY
                 other registered identifier in the shared namespace
                 this document, `02-social-sign-in`, and
                 `03-generic-oauth` all draw from — this collision
                 check exists specifically so that trust can never be
                 established merely by an identifier string matching
                 something else
               - an issuer value and one or more domains this provider
                 is being registered for
               - EITHER a SAML configuration (metadata document, or an
                 explicit certificate plus SSO endpoint, with EXACTLY
                 ONE certificate source present — never both an
                 explicit certificate and a metadata document
                 simultaneously, and never neither) OR an OIDC
                 configuration (endpoints supplied directly, or a
                 discovery location, plus client credentials per
                 `01 §5.1`)
               - IF a SAML configuration is supplied WITHOUT a metadata
                 document (i.e. manually, field by field): an explicit
                 identity-provider entity identifier MUST be supplied
                 separately from better-auth's own service-provider
                 identifier — the two are never allowed to default to
                 the same value, precisely so the entity actually being
                 trusted as the assertion issuer is never confused with
                 the entity RECEIVING the assertion
               - a usable single-sign-on endpoint must be resolvable
                 from whatever was supplied (metadata, an explicit
                 endpoint, or an entry point URL)
               - if the operator declares that assertions must be
                 signed, no later configuration update may weaken that
                 to unsigned
Ensures:       a provider record is created, in an UNVERIFIED-DOMAIN
               state (§2) until domain ownership is separately proven
Invariant:     TRUST IN A REGISTERED PROVIDER IS ESTABLISHED SOLELY
               THROUGH VERIFIED DOMAIN OWNERSHIP (§2) — NEVER through
               the provider identifier string, and never through the
               mere existence of a registration record. This is the
               single load-bearing invariant of this entire document;
               every other contract below exists to protect it.
On violation:  - identifier collision: raised as a configuration error.
                 Blamed party: SUPPLIER.
               - missing/ambiguous certificate source, missing entity
                 identifier for a manual SAML configuration, no
                 resolvable SSO endpoint: raised as a configuration
                 error. Blamed party: SUPPLIER — these are all
                 detectable from the registration data alone, without
                 any network access to the identity provider itself.
```

```
Operation:     Register Identity Provider Under an Organization
Requires:      everything above, PLUS: the registering caller is a
               member of the target organization with sufficient
               privilege (an owner/admin-level role, not mere
               membership, whenever an organization capability is
               active)
Ensures:       identical to the unscoped registration, additionally
               associating the provider record with that organization
               for later JIT-provisioning org-assignment (§5.2)
Invariant:     an organization-scoped provider's domain-verification
               state (§2) is never inherited from, or shared with, any
               other provider registered under a different organization
On violation:  insufficient privilege: raised as a forbidden error.
               Blamed party: CLIENT.
```

---

## 2. Domain verification and routing

```
Operation:     Request Domain Verification
Requires:      a registered provider record and a domain from its
               configured domain set
Ensures:       a single-use, time-bounded verification token is
               generated and the operator is instructed to publish it
               as a DNS record for that domain
Invariant:     a verification token, once issued, is bound to the
               EXACT (provider identifier, domain) pair it was issued
               for at that moment — not merely to the domain string
               alone
On violation:  n/a
```

```
Operation:     Complete Domain Verification
Requires:      a DNS lookup for the domain in question returns the
               expected published token value
Ensures:       - the provider's domain-verified state transitions to
                 true ONLY IF the (provider identifier, domain) pair is
                 STILL, at the moment of this transition, exactly what
                 it was when verification was requested — this
                 comparison is against the CURRENT record's identity-
                 defining fields, not against any assumption that
                 nothing else could have changed in between
               - two concurrent, otherwise-independent verification
                 completions for the SAME (provider, domain) pair both
                 succeed — this is not treated as a conflict, since
                 both observe the same true state
               - an unrelated field update on the provider record
                 (anything other than its identity-defining fields)
                 occurring concurrently with a verification attempt
                 does not abort the verification
Invariant:     A DOMAIN-OWNERSHIP PROOF ISSUED FOR ONE (PROVIDER,
               DOMAIN) PAIR CAN NEVER BE LAUNDERED ONTO A DIFFERENT
               PAIR — not by changing the provider's domain mid-flight,
               not by deleting and re-registering the same provider
               identifier so a NEW record inherits an old, in-flight
               proof, and not by any interleaving of these operations.
               This is a compare-and-swap contract, evaluated against
               identity-defining fields ONLY (never a naive version
               counter that would also reject harmless concurrent
               unrelated edits).
On violation:  the (provider, domain) pair has drifted since
               verification was requested (domain changed, or the
               provider identifier now names a different underlying
               record than it did at request time): raised as a
               conflict. Blamed party: SUPPLIER — this can only be
               observed when an operator (or a race in the operator's
               own tooling) mutated the provider's identity-defining
               fields between requesting and completing verification;
               it is never attributable to the DNS response itself
               (which either matches the token or does not — a
               mismatch there is an ordinary "not yet verified"
               outcome, not this conflict).
```

### 2.1 Provider selection for sign-in (routing precedence)

```
Operation:     Route Sign-In to an Identity Provider
Requires:      one of: an explicit provider identifier, an explicit
               organization reference, or an email address to derive a
               domain from
Ensures:       resolution is attempted in this fixed precedence:
                 (1) exact provider identifier, if supplied
                 (2) organization reference, if supplied and it names
                     an organization with a registered provider
                 (3) email domain — exact match first, then a scan
                     across every registered provider's domain set,
                     matching the domain itself or any of its
                     subdomains
               resolution stops at the first precedence level that
               yields a match
Invariant:     IF domain-verification enforcement is enabled for this
               deployment, a provider resolved by ANY of the three
               precedence levels above that is NOT yet domain-verified
               is treated as if it did not resolve at all — routing
               NEVER completes a sign-in against an unverified
               provider, regardless of which precedence level found it
On violation:  no provider resolves at any precedence level, or the
               only match is unverified under enforcement: raised as a
               provider-not-found outcome. Blamed party: CLIENT (the
               request named an email/organization/identifier that
               does not correspond to any usable, trusted route).
```

---

## 3. SAML assertion validation contract

Every incoming SAML response is subjected to an ORDERED chain of checks.
Each check either passes silently or terminates the operation with a
specific, distinguishable failure — later checks are never reached once
an earlier one fails, and this ordering is itself part of the contract
(cheap, DoS-relevant checks run before expensive cryptographic ones).

```
Operation:     Validate SAML Response
Requires:      an HTTP-delivered SAML response payload
Ensures, in order:
  (1) SIZE — the payload does not exceed a fixed maximum size.
  (2) ASSERTION CARDINALITY — the decoded response contains EXACTLY
      ONE assertion (plain or encrypted); zero or more than one is
      rejected outright. This specifically defends against a
      signature-wrapping attack where a second, unsigned assertion is
      smuggled alongside a validly signed one, hoping a naive
      implementation reads the wrong one.
  (3) DOMAIN VERIFICATION GATE — the owning provider's domain (§2)
      must already be verified before any further processing of the
      assertion's content occurs.
  (4) STRUCTURAL PARSE — the response must decode as well-formed XML
      matching the expected SAML response shape.
  (5) ALGORITHM ALLOW-LIST — the signature algorithm used MUST belong
      to a fixed set of currently strong algorithms; a small,
      explicitly named set of algorithms known to be weak (a
      SHA-1-based signature, a weak key-wrap or data-encryption
      algorithm) triggers a DEPLOYMENT-CONFIGURED response — reject
      outright, warn and proceed, or silently allow — defaulting to
      warn-and-proceed; any algorithm NOT recognized at all (neither
      strong nor named-weak) is UNCONDITIONALLY rejected regardless of
      configuration. This closes both algorithm-downgrade and
      algorithm-confusion attack classes.
  (6) TIMESTAMP VALIDITY — the assertion's validity window is checked
      against the current time with a bounded clock-skew tolerance; by
      default a MISSING timestamp is tolerated with a warning, but a
      deployment MAY require timestamps to be present, in which case a
      missing one is rejected exactly as an expired one would be.
  (7) SIGNATURE AND BINDING VALIDATION — the ASSERTION ITSELF (not
      merely the enclosing response envelope) must be signed and that
      signature must verify against a certificate the deploying
      operator pinned at registration time (§1) — there is no runtime
      fetch of identity-provider certificates; trust is exclusively
      what the operator supplied. Additionally: the assertion's
      audience restriction must name this service provider (or its
      configured audience value); the bearer subject-confirmation
      recipient must match one of this service provider's own
      known callback addresses; and the response's declared
      destination must match as well.
  (8) IN-RESPONSE-TO CORRELATION — for a service-provider-initiated
      flow, the response must correlate to a stored, unexpired,
      NOT-PREVIOUSLY-CONSUMED authentication request record, consumed
      atomically (single-use) at this step. An IDENTITY-PROVIDER-
      INITIATED (unsolicited) response — one with no such correlation
      to begin with — is REJECTED BY DEFAULT; a deployment may
      explicitly opt in to accepting them.
  (9) AUDIENCE RESTRICTION (explicit, independent re-check) against
      the configured/derived service-provider identifier.
  (10) REPLAY PROTECTION — the assertion's own unique identifier is
       atomically reserved as "consumed," with a lifetime derived from
       the assertion's own validity window (or a fixed fallback); a
       second submission of the identical assertion identifier is
       rejected regardless of whether every other check would still
       pass.
  (11) CLAIM EXTRACTION — a stable subject identifier and an email
       address must both be extractable from the assertion's attribute
       set; either being absent fails the whole validation.
Invariant:     no later check is ever evaluated once an earlier one in
               this ordered sequence has failed — a partially-validated
               assertion is never partially trusted
On violation:  see the per-step blame table in §6.
```

---

## 4. OIDC federation validation contract

```
Operation:     Validate Enterprise OIDC Discovery
Requires:      an issuer value and either a discovery location or
               explicit endpoints
Ensures:       - IF discovery is used, the discovered issuer value must
                 exactly equal the configured issuer (after trailing-
                 slash normalization) — a mismatch is treated
                 identically to a fetch failure, never silently
                 tolerated
               - every resolved endpoint is checked for scheme safety
                 and for not resolving to a private/internal address,
                 both at registration/update time AND, independently,
                 immediately before any runtime fetch — closing the gap
                 where a DNS answer could legitimately change between
                 those two moments
               - any endpoint that responds with an HTTP redirect is
                 rejected outright, never followed
Invariant:     an endpoint's SSRF-safety is re-verified at the moment
               of use, not merely trusted from a check performed once
               at registration time
On violation:  discovery unreachable, malformed, issuer mismatch, or an
               endpoint redirects/resolves to a disallowed address:
               Blamed party: UPSTREAM PROVIDER for a genuinely
               misconfigured or unreachable identity provider; the
               DNS-rebinding-style gap this operation closes is a
               SUPPLIER-owned defensive measure whose OWN failure
               (if the re-check were skipped) would be SUPPLIER-blamed,
               but a legitimate rejection triggered by it is UPSTREAM-
               blamed, since the underlying cause is the identity
               provider's endpoint resolving somewhere it should not.
```

```
Operation:     Validate Enterprise ID Token
Requires:      an ID token obtained via the enterprise identity
               provider's token endpoint
Ensures:       - signature verifies against the identity provider's own
                 live key material
               - audience matches the registered client identifier for
                 this provider
               - issuer matches the provider's configured issuer
               - standard expiry/not-before checks hold
               - IF the token carries multiple audience values: an
                 authorized-party claim MUST be present and MUST match
                 the registered client identifier — a multi-audience
                 token with no authorized-party claim, or one naming a
                 different party, is rejected
               - a subject claim is present (non-empty)
               - IF a separate userinfo endpoint is also configured,
                 its OWN reported subject must match this token's
                 verified subject exactly — a mismatch is treated as an
                 identity-substitution signal, not a benign
                 inconsistency
Invariant:     there is no nonce check in this operation — this
               contract's OIDC federation path is authorization-code-
               only (never the implicit flow), and its CSRF/replay
               defense is the state/PKCE machinery of `01 §3`, not a
               nonce; the absence of nonce checking here is therefore a
               deliberate consequence of the flow shape, not a gap
               relative to `01 §7`, which DOES require nonce checking
               specifically because it also has to support flows where
               nonce is the only available binding
On violation:  any clause fails: Blamed party UPSTREAM PROVIDER for
               signature/issuer/audience/expiry/authorized-party
               failures consistent with honest but mismatched or
               misconfigured tokens; Blamed party CLIENT for a
               mismatch pattern consistent with token substitution
               (e.g. a userinfo subject that disagrees with the ID
               token's own subject, which is more consistent with an
               attacker splicing together material from two different
               authentication events than with an honest
               misconfiguration).
```

### 4.1 Unsolicited (IdP-initiated) OIDC callbacks

```
INVARIANT (No Bare Unsolicited Trust):
   a callback arriving with no state parameter at all is NEVER trusted
   directly, even for a provider explicitly configured to allow
   identity-provider-initiated flows. Instead, such a callback is used
   ONLY to learn "an authentication event may have occurred"; the
   actual flow that is trusted is a FRESH one, initiated server-side
   with its own newly generated state and PKCE material, per
   `01 §3`'s ordinary anti-CSRF machinery. This mirrors
   `03-generic-oauth §4`'s "bounce" divergence exactly.
```

---

## 5. Just-in-time provisioning contract

```
Operation:     Provision or Resolve User from Federated Identity
Requires:      a validated assertion (§3) or ID token (§4) yielding, at
               minimum, a stable subject identifier and an email address
Ensures:       - IF no local account exists for this (provider,
                 subject) pair: a provisioning callback runs, and a new
                 local user is created from the validated claims
               - IF a local account already exists for this pair: the
                 provisioning callback runs AGAIN only if the
                 deployment has explicitly opted into re-running it on
                 EVERY login (rather than once, at first registration)
                 — and a deployment choosing that opt-in is responsible
                 for making its own callback safe to run repeatedly
               - the provider's own assertion of email verification is
                 NOT, by default, trusted as sufficient to mark the
                 local user's email verified — this is an explicit,
                 separately-named, discouraged opt-in, never a default,
                 precisely because a spoofable "verified" claim from a
                 federation partner is a weaker signal than
                 verification better-auth itself controls
               - whether the provider's profile fields (name, image,
                 etc.) overwrite an ALREADY-LINKED local user's stored
                 values on a later login is a separate, explicit
                 opt-in — never silent, default behavior
Invariant:     a required claim (subject, email) being absent from an
               otherwise cryptographically valid assertion/token
               ALWAYS aborts provisioning — an incomplete identity is
               never silently completed with placeholder or inferred
               data
On violation:  required claim missing: raised as an incomplete-profile
               error. Blamed party: UPSTREAM PROVIDER — the assertion
               was authentic and passed every cryptographic check, but
               the identity provider's own attribute release policy
               did not supply data this operation's precondition
               requires.
```

### 5.1 The anti-hijack trust gate for auto-linking

```
INVARIANT (Auto-Link Requires Verified-Domain Trust, Not Name Trust):
   whether a federated login is permitted to auto-link to an EXISTING
   local user by email match is gated by a trust computation that is
   DELIBERATELY: (domain-verified per §2) AND (the asserted email's
   own domain matches the provider's registered, verified domain) —
   and NEVER merely "this provider's identifier matches a name we
   recognize." A provider identifier string is explicitly excluded as
   a trust signal for this purpose, closing the exact gap `01 §1`
   also closes for account-subject resolution: no string-matching
   shortcut may substitute for a cryptographically/DNS-anchored trust
   decision.
On violation:  an auto-link is attempted against an unverified-domain
               provider, or against a verified-domain provider whose
               asserted email domain does not match: REJECTED, not
               downgraded to "create a new, disconnected user instead"
               — silently falling back to account creation would still
               let an attacker sign in under a plausible-looking
               identity, so the correct response is an explicit
               refusal, not a quiet substitution. Blamed party:
               UPSTREAM PROVIDER when the provider's own domain
               genuinely is unverified (nothing wrong occurred; the
               gate is doing its job); SUPPLIER if an operator
               mistakenly relies on an unverified provider for
               auto-linking without realizing verification was never
               completed.
```

### 5.2 Organization assignment invariant

```
INVARIANT (Domain-Based Org Auto-Join Cannot Be Attacker-Triggered):
   automatic organization assignment following a successful sign-in,
   when driven by domain matching rather than an explicit provider-to-
   organization binding, requires ALL of:
     (a) the matched domain belongs to a provider that is
         DOMAIN-VERIFIED (§2) — an unverified provider's domain claim
         NEVER triggers auto-join
     (b) the CANONICAL, currently-stored local user record — refetched
         fresh, never trusted from any value carried through the
         request — itself has its email marked verified
     (c) the matched domain resolves to EXACTLY ONE organization; if
         it ambiguously matches more than one, assignment is skipped
         entirely rather than guessing
   Separately, assignment driven by an EXPLICIT provider-to-
   organization binding (a provider registered directly under a
   specific organization, §1) is not subject to (a)-(c) in the same
   way, because the organization binding itself is fixed by whoever
   registered that specific provider record — the risk this clause
   defends against (a domain string ambiguously implying membership)
   does not arise when the binding was never domain-derived in the
   first place.
   Linking a new provider identity to an ALREADY-AUTHENTICATED session
   (as opposed to a fresh sign-in event) NEVER triggers domain-based
   auto-join by itself — auto-join is tied to a genuine authentication
   event, not to an account-linking side effect.
On violation:  any of (a)-(c) fails and auto-join is nonetheless
               attempted: this is exactly the class of defect this
               invariant exists to prevent; if OBSERVED, it is a
               SUPPLIER-blamed violation of this document's own
               invariant, not attributable to any external party,
               since every input to (a)-(c) is checked against
               canonical, already-validated, server-controlled state.
```

---

## 6. Error taxonomy and blame (SAML validation chain, per step)

| Step | Failure meaning | Blamed party |
|---|---|---|
| (1) Size | Oversized payload | CLIENT (malicious or malformed transmission) |
| (2) Cardinality | Zero or multiple assertions | CLIENT (signature-wrapping attempt or malformed relay) |
| (3) Domain gate | Provider not yet domain-verified | SUPPLIER (reached this step prematurely — an operator relying on an unverified provider) |
| (4) Parse | Malformed XML | CLIENT or UPSTREAM PROVIDER depending on transmission origin — indistinguishable at this step, so treated conservatively as CLIENT unless corroborated by other signals |
| (5) Algorithm | Weak or unrecognized algorithm | UPSTREAM PROVIDER (a weak-but-configured IdP) if the algorithm is on the named-weak list and the operator chose to warn/allow; SUPPLIER if the operator's own choice to allow a weak algorithm is what let the assertion through |
| (6) Timestamp | Expired, not-yet-valid, or missing when required | UPSTREAM PROVIDER (clock drift, misconfigured validity window) or CLIENT (replay of a stale cached response) |
| (7) Signature/binding | Bad signature, wrong audience, wrong recipient/destination | UPSTREAM PROVIDER if the IdP itself is misconfigured for this SP; CLIENT if the pattern is consistent with replay at a different endpoint |
| (8) InResponseTo | No correlation, or unsolicited when disallowed | CLIENT (replay or forged unsolicited injection) |
| (9) Audience (explicit) | Wrong audience | UPSTREAM PROVIDER |
| (10) Replay | Duplicate assertion identifier | CLIENT |
| (11) Claim extraction | Missing subject/email | UPSTREAM PROVIDER |
| Registering the wrong/expired certificate | Pinned trust material is simply wrong | SUPPLIER (operator error — there is no live fetch to self-correct) |
| Mid-authentication provider record mutation (cert, entity id, audience, endpoints changed while a login is in flight) | A TOCTOU condition independent of who instigated it | detected and blocked as a conflict; the in-flight login is aborted rather than completed against a definition that changed underneath it — treated as SUPPLIER-protective, not attributed to CLIENT or UPSTREAM |

---

## 7. Diagrams

### 7.1 SAML SP-initiated flow through the validation pipeline

```
  Browser (CLIENT)     better-auth (SUPPLIER)              Enterprise IdP (UPSTREAM)
     │                       │                                       │
     │──GET /sso/:providerId▶│                                        │
     │                       │ Route Sign-In (§2.1)                   │
     │                       │  domain-verified? NO → reject          │
     │                       │  YES → store AuthnRequest record       │
     │                       │  (single-use correlation token)        │
     │◀── redirect to IdP SSO endpoint ─────────────────────────────▶ │
     │                                                                 │ user
     │                                                                 │ authenticates
     │◀── POST SAMLResponse (browser relays it back) ──────────────────┤
     │                       │                                        │
     │──POST /sso/acs────────▶│                                       │
     │                       │ (1) size check                         │
     │                       │ (2) exactly one assertion?              │
     │                       │ (3) domain-verification gate            │
     │                       │ (4) structural parse                    │
     │                       │ (5) algorithm allow-list                │
     │                       │ (6) timestamp validity                  │
     │                       │ (7) signature + audience + recipient    │
     │                       │     + destination, against PINNED cert  │
     │                       │ (8) InResponseTo — consume stored        │
     │                       │     AuthnRequest atomically (single-use)│
     │                       │ (9) explicit audience re-check           │
     │                       │ (10) replay reservation (assertion id)  │
     │                       │ (11) extract subject + email             │
     │                       │  ✗ any step fails → abort, blame per §6 │
     │                       │  ✓ all pass                              │
     │                       │ JIT Provision/Resolve (§5)                │
     │                       │  trust gate (§5.1) for auto-link          │
     │                       │  org auto-join gate (§5.2)                │
     │◀── session established─┤                                        │
```

### 7.2 Domain verification lifecycle — state diagram (with concurrency guard)

```
                Register Identity Provider (§1)
                          │
                          ▼
                 ┌─────────────────┐
                 │   UNVERIFIED     │◀─────────────────────────┐
                 └────────┬────────┘                            │
                          │ Request Domain Verification (§2)     │
                          ▼                                      │
                 ┌─────────────────┐                             │
                 │  TOKEN_ISSUED    │                             │
                 │ (bound to THIS   │                             │
                 │  provider+domain │                             │
                 │  pair, at THIS   │                             │
                 │  moment)         │                             │
                 └────────┬────────┘                             │
                          │                                       │
        ┌─────────────────┼───────────────────────┐               │
        │ DNS lookup       │ provider's domain      │ provider      │
        │ matches token    │ CHANGED before          │ deleted &      │
        │                  │ completion runs         │ re-registered  │
        │                  │                         │ under same id  │
        ▼                  ▼                         ▼                │
 ┌──────────────┐  ┌───────────────────┐   ┌───────────────────┐    │
 │   VERIFIED    │  │  CONFLICT (409):   │   │  CONFLICT (409):   │    │
 │               │  │ pair drifted from  │   │ new record does    │    │
 │               │  │ issuance-time      │   │ NOT inherit old    │────┘
 │               │  │ identity — token   │   │ record's in-flight │
 │               │  │ NOT honored for    │   │ proof              │
 │               │  │ the NEW pair       │   └───────────────────┘
 └──────────────┘  └───────────────────┘
        │
        │ (concurrent second completion
        │  for the SAME still-matching
        │  pair — both succeed, no conflict)
        ▼
 ┌──────────────┐
 │   VERIFIED    │  (idempotent under true concurrency)
 └──────────────┘

     Only VERIFIED unlocks §2.1's routing and §5.1's auto-link trust
     gate. Every CONFLICT outcome routes back to requiring a fresh
     Request Domain Verification cycle against the NEW current pair.
```
