# Generic OAuth / OIDC Escape Hatch Contract

> Builds on `01-oauth2-core-contract.md` and `02-social-sign-in.md`. This
> document specifies a *configuration layer*: it does not introduce new
> sign-in mechanics, it specifies the preconditions a deployer's own
> configuration must satisfy in order to legally produce a `ProviderStrategy`
> (`01 §1`) for a provider that has no purpose-built strategy of its own.

Per `01-design-by-contract.md §5`, a specialization may only weaken a
precondition and strengthen a postcondition relative to what it extends.
This document is unusual in that its "extension" is not a code
specialization but a **configuration-driven instantiation**: a deployer
supplies data (endpoints, credentials, mapping rules) that this contract
turns into a `ProviderStrategy` conforming exactly to `01 §1`'s bundle,
with no divergence in the mechanics that bundle is used for
(authorization request, state/PKCE, callback handling, token exchange,
refresh, ID-token verification all remain governed by `01`; account
linking remains governed by `02`). What is genuinely new here is the set
of preconditions on the *configuration itself*, and the discovery and
profile-mapping machinery that turns an arbitrary provider's shape into
the normalized shapes `01` and `02` require.

---

## 1. Configuration precondition contract

```
Operation:     Register a Generic Provider
Requires:      - a provider identifier, unique among every OTHER
                 registered provider (generic, built-in social, or SSO —
                 see `05-sso §1` for the shared-namespace concern) —
                 supplying a colliding identifier is a configuration
                 error, not a runtime one
               - a client identifier
               - EITHER a discovery document location, OR both an
                 authorization endpoint and a token endpoint supplied
                 directly
               - a client secret, IF AND ONLY IF the chosen token-
                 endpoint authentication method requires one (per
                 `01 §5.1`) — supplying a secret alongside a secretless
                 method (signed-assertion or "none") is ALSO a
                 configuration error, symmetric with omitting a required
                 one
Ensures:       - if every REQUIRES clause above holds, a conforming
                 `ProviderStrategy` is produced and made available for
                 sign-in under the given provider identifier
               - if a REQUIRES clause fails in a way that can be
                 detected without any network call (identifier
                 collision, secret/method mismatch), the failure is
                 raised immediately, at registration time, as a
                 configuration error — never deferred to the first
                 sign-in attempt
               - if a REQUIRES clause can only be resolved by a network
                 call (endpoints only reachable via discovery, §2), a
                 failure there does NOT necessarily abort the entire
                 deployment: THIS PROVIDER is excluded from the set of
                 available sign-in options, and the exclusion is
                 recorded observably (not silently dropped) — a fault
                 isolated to one provider must not prevent every other
                 registered provider, or the rest of the application,
                 from starting
Invariant:     a provider identifier that failed registration is never
               partially available — sign-in against it is uniformly
               "provider not found," identical to an identifier that was
               never configured at all
On violation:  - identifier collision, or secret/method mismatch:
                 raised as a configuration error at registration time.
                 Blamed party: SUPPLIER (the deployer's own
                 configuration, or whoever wrote it for them, violated a
                 precondition checkable without any network access).
               - required endpoints unresolvable and no discovery
                 succeeded: raised as a configuration error at
                 registration time IF no discovery location was ever
                 supplied (this is a static omission, checkable
                 immediately); raised as a per-provider exclusion (see
                 §2) IF a discovery location was supplied but discovery
                 itself failed at runtime.
```

---

## 2. Discovery contract

```
Operation:     Resolve Endpoints via Discovery
Requires:      a discovery document location
Ensures:       - if the discovery document is fetched successfully and
                 well-formed, any endpoint NOT already explicitly
                 supplied by the deployer is filled in from it
               - explicit configuration always wins: an endpoint the
                 deployer supplied directly is NEVER overwritten by a
                 discovered value, even if they disagree — this
                 precedence is absolute, not "discovery wins unless a
                 flag says otherwise"
               - the discovered issuer value is checked for basic
                 well-formedness (a syntactically invalid issuer is
                 treated identically to a fetch failure — see below)
Invariant:     after this operation completes (successfully or not),
               the resulting endpoint set is fixed for the lifetime of
               the registration — discovery is performed once, at
               registration time, never re-resolved per sign-in attempt
On violation:  - the discovery document is unreachable, returns a non-
                 success response, or is not parseable as the expected
                 document shape: Blamed party UPSTREAM PROVIDER. This
                 failure does not raise an exception that aborts
                 registration of every provider — it is caught and
                 folded into "this provider's endpoints are still
                 incomplete," evaluated next against §1's requirement
                 that a usable authorization+token endpoint pair exist.
               - IF, after a failed or partial discovery, no usable
                 authorization endpoint or token-exchange mechanism
                 exists at all: this provider is excluded from
                 availability (§1's per-provider exclusion outcome),
                 logged observably, WITHOUT preventing the rest of the
                 deployment's providers or the application itself from
                 becoming available. Blamed party: UPSTREAM PROVIDER for
                 the underlying cause, though the OBSERVABLE outcome
                 (provider unavailable) is a SUPPLIER-facing operational
                 signal, not an end-user-facing error until a user
                 actually attempts to sign in against that identifier.
```

### 2.1 Signing-key resolution as a discovery-dependent sub-contract

When both an issuer and a signing-key location are available (whether
supplied directly or filled in from discovery), ID-token verification
(`01 §7`) becomes available for this provider; when the signing-key
location is itself malformed or unreachable, this provider is excluded
from availability under the same rule as §2's outer clause — a
provider that cannot resolve where to fetch verification keys from is not
made available in a state where every ID token would silently fail
verification.

If the deployer's configuration explicitly *requires* ID-token
verification for this provider (as opposed to it merely being available
when possible) and no discovery location was ever supplied at all, this
is treated as a static configuration error (§1's immediate-failure path)
rather than a runtime exclusion — the deployer asked for a guarantee that
was never possible to satisfy from the configuration given, and this is
detectable without any network access.

---

## 3. Profile mapping contract

```
ProfileMapper : (RawProfile, TokenResponse) -> NormalizedIdentity
   where NormalizedIdentity ⊆ NormalizeProfile's range (`02 §1`)
         ⊕ a provider account identifier per `01 §1`'s
           resolveAccountSubject domain/range
```

```
Operation:     Map Arbitrary Provider Profile
Requires:      a raw profile obtained either from a decoded, verified ID
               token or from a userinfo-style endpoint call
Ensures:       - a default, heuristic mapping is applied when the
                 deployer supplies no override: conventional field names
                 for email, verification, name, and image are read
                 directly from the raw profile, and an ID token's own
                 subject/email/verification claims are preferred over a
                 separate userinfo call whenever the ID token itself
                 already carries both a subject and an email
               - a deployer MAY override this mapping entirely with a
                 custom mapping value; where supplied, its output takes
                 precedence over the default heuristic for every field
                 it defines
               - the ACCOUNT IDENTIFIER is resolved through a
                 SEPARATE, narrower operation than the general profile
                 mapping (mirroring `01 §1`'s isolation of
                 `resolveAccountSubject`) — a custom profile mapping
                 value's domain never includes the power to redefine
                 account identity; only a dedicated identifier-
                 resolution override may do that
Invariant:     the resolved account identifier is never derived from
               ANY field the general profile mapper is free to reshape —
               this holds regardless of whether the default heuristic or
               a full custom override is in effect
On violation:  - the raw profile lacks the fields the default heuristic
                 needs (no discoverable identifier, no discoverable
                 email where email is required): Blamed party UPSTREAM
                 PROVIDER — the provider's userinfo/ID-token shape did
                 not carry data this operation's precondition assumed a
                 conventional provider would supply.
               - a deployer-supplied custom mapping or identifier-
                 resolution override itself returns an empty, null-like,
                 or otherwise structurally invalid identifier: Blamed
                 party SUPPLIER — the override, not the provider, is
                 responsible for this failure, since the same raw
                 profile might have mapped correctly under the default
                 heuristic or a different override. The sign-in attempt
                 is rejected rather than proceeding with an empty
                 identifier, specifically to prevent multiple distinct
                 real-world identities from colliding onto one stored
                 account key (`01 §9`'s uniqueness invariant depends on
                 this rejection).
```

---

## 4. Relation to the core contract — strict instantiation, explicit opt-outs only

This document's central claim is that generic-oauth is a **strict
configuration-driven instantiation** of `01`'s contract: the same
authorization-URL construction, the same state/PKCE storage and
verification, the same token-exchange and refresh mechanics apply,
unmodified, to a generic-oauth-configured provider as to any built-in
one. Per `01-design-by-contract.md §5`, any divergence from this must be
an explicit, named weakening — never a silent behavioral difference that
a caller could not have anticipated from reading `01` alone.

The permitted, explicitly-named divergences are:

```
INVARIANT (Named Divergences Only):
   a generic-oauth provider MAY, only via an explicit configuration
   flag, per provider:
     (a) disable PKCE entirely for that provider (weakens `01 §3.2`'s
         default expectation that a challenge is normally declared —
         permitted because §3.2 itself states PKCE is not universally
         mandated by the core contract)
     (b) disable ID-token nonce-replay binding (weakens `01 §7`'s
         nonce check specifically for providers that do not echo a
         requested nonce back correctly)
     (c) accept a callback with NO state parameter at all, by
         discarding the stateless callback and re-initiating a FRESH
         authorization request server-side rather than trusting the
         bare callback (this is not a weakening of `01 §3.1` — no
         stateless callback is ever trusted directly; it is instead
         bounced into a brand-new, fully state/PKCE-protected request,
         so the anti-CSRF guarantee is preserved, only its trigger
         point moves)
   No other divergence from `01` is permitted under this contract. A
   generic-oauth provider that silently skips a check `01` requires,
   without one of the three NAMED opt-outs above being explicitly set,
   is a contract violation.
```

```
On violation:  a generic-oauth provider observed to skip a `01`-required
               check without the matching named opt-out being set:
               Blamed party: SUPPLIER — this is `01-design-by-contract.md
               §5`'s inheritance rule violated by the layer that is
               supposed to be a strict, non-narrowing instantiation.
```

---

## 5. Sign-in and callback endpoint behavior specific to this layer

```
Operation:     Initiate Sign-In Against a Configured Provider Identifier
Requires:      the given provider identifier was successfully registered
               under §1 (i.e. is currently AVAILABLE, not excluded)
Ensures:       proceeds exactly as `01 §2`'s Build Authorization URL,
               using this provider's resolved endpoint/credential set
Invariant:     an identifier that failed registration or was later
               excluded is indistinguishable, to this operation, from an
               identifier that was never configured
On violation:  the given identifier is unknown or excluded: raised as a
               provider-not-found error. Blamed party: CLIENT — the
               caller requested a sign-in path that was never made
               available, which is a request-shape fault from this
               operation's point of view (whatever the underlying cause
               of exclusion was, per §1/§2's own blame assignment for
               THAT fault).
```

```
Operation:     Handle Callback for a Configured Provider
Requires:      identical to `01 §4`, plus: the provider identifier
               embedded in the callback path must match a currently
               AVAILABLE registration
Ensures:       identical to `01 §4` and `01 §5` — state/PKCE checks are
               not weakened by virtue of this being a generic provider,
               except exactly as permitted by §4's named divergences
Invariant:     none beyond what `01` already states
On violation:  identical to `01 §4`'s violation clauses; additionally,
               a callback naming an identifier that is unknown or
               excluded is a provider-not-found error, blamed on CLIENT
               under the same reasoning as the initiate operation above.
```

---

## 6. Account linking

Account linking for a generic-oauth-configured provider follows
`02-social-sign-in.md` exactly, with no separate linking flag introduced
by this layer. In particular:

- §4's trust/verification gates (`02 §4`) apply identically — a
  generic-oauth provider is not automatically trusted merely because a
  deployer took the effort to configure it; it must still be named in
  the deployer's trusted-provider set, or assert verified email per
  sign-in, exactly like a built-in social provider.
- The one detail specific to this layer: because a deployer controls the
  profile mapping (§3), it is possible for two DIFFERENT raw profile
  shapes from what a human would call "the same provider" (e.g. two
  differently-configured aliases of one vendor, for a web and a mobile
  client) to resolve to two DIFFERENT provider identifiers with two
  DIFFERENT resolved account identifiers for the same real-world
  end-user account. This is not a defect — `01 §9`'s uniqueness
  invariant is scoped to a single provider identifier, and this document
  does not claim cross-alias identity merging; a deployer wanting that
  outcome must arrange for both aliases to resolve to the same account
  identifier via a shared identifier-resolution override.

---

## 7. Error taxonomy and blame

| Condition | Blamed party |
|---|---|
| Provider identifier collides with an existing registration | SUPPLIER |
| Client secret supplied with a secretless auth method, or omitted with a method that requires one | SUPPLIER |
| No discovery location and no explicit endpoints supplied | SUPPLIER |
| Discovery document unreachable, malformed, or has an invalid issuer | UPSTREAM PROVIDER |
| Discovery succeeds but leaves no usable authorization/token endpoint pair | UPSTREAM PROVIDER (this provider is excluded, not fatal to the deployment) |
| ID-token verification explicitly required, but no discovery location was ever given | SUPPLIER |
| Default profile-mapping heuristic finds no usable identifier/email in the raw profile | UPSTREAM PROVIDER |
| A deployer-supplied mapping or identifier override returns an empty/invalid identifier | SUPPLIER |
| Callback names an unknown or excluded provider identifier | CLIENT |
| State/PKCE/nonce checks fail without the matching named opt-out (§4) being set | SUPPLIER (a `01`-violating divergence) |
| State/PKCE/nonce checks fail as `01` itself defines (opt-outs not in play) | per `01`'s own table |

---

## 8. Diagrams

### 8.1 Registration-time resolution — sequence diagram

```
   Deployer config          Registration (§1)         Discovery source (if any)
        │                        │                              │
        │──register(provider)──▶│                                │
        │                        │ check identifier collision     │
        │                        │  ✗ collision → SUPPLIER error, │
        │                        │    STOP (registration fails)   │
        │                        │ check secret/method pairing    │
        │                        │  ✗ mismatch → SUPPLIER error,  │
        │                        │    STOP                        │
        │                        │ endpoints fully explicit? ──yes┐
        │                        │        no                      │
        │                        │         │                      │
        │                        │  fetch discovery document ─────▶│
        │                        │         │  ✗ unreachable/       │
        │                        │         │    malformed          │
        │                        │◀────────┴── UPSTREAM failure ───┤
        │                        │  merge (explicit wins) ─────────┘
        │                        │                                 │
        │                        │  usable authorization+token      │
        │                        │  endpoint pair present?          │
        │                        │   NO  → EXCLUDE this provider,   │
        │                        │         log, continue booting    │
        │                        │         every OTHER provider     │
        │                        │   YES → provider AVAILABLE       │
        │◀── registration result─┤                                 │
```

### 8.2 Provider availability lifecycle — state diagram

```
                    Register a Generic Provider (§1)
                                  │
                    ┌─────────────┼──────────────┐
              collision/secret   valid config,     valid config,
              mismatch detected  fully explicit    needs discovery
              (no network yet)   endpoints                │
                    │                  │                   ▼
                    ▼                  │           ┌───────────────┐
            ┌───────────────┐          │           │  RESOLVING     │
            │ CONFIG_REJECTED│          │           │ (discovery in │
            │ (never becomes │          │           │  flight)       │
            │  AVAILABLE)    │          │           └───────┬───────┘
            └───────────────┘          │              success│  │failure /
                                        │                     │  │incomplete
                                        ▼                     ▼  ▼
                                 ┌───────────────┐   ┌───────────────┐
                                 │  AVAILABLE     │   │  EXCLUDED      │
                                 │ (sign-in works)│   │ (sign-in       │
                                 └───────────────┘   │  returns       │
                                                      │  "not found",  │
                                                      │  application   │
                                                      │  still boots)  │
                                                      └───────────────┘

     CONFIG_REJECTED and EXCLUDED are both terminal and both produce
     an identical externally observable outcome for a sign-in attempt
     against that identifier (§1's invariant) — the DIFFERENCE is only
     in when and how the deployer is informed: CONFIG_REJECTED aborts
     registration immediately and synchronously; EXCLUDED is discovered
     asynchronously via the discovery attempt and logged without
     aborting anything else.
```
