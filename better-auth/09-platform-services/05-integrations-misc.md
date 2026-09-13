# Miscellaneous Integrations

Seven integrations, each specified as an **instantiation** of the plugin
extension contract from methodology doc `01` §5 and the arrow-contract
vocabulary from methodology doc `02`: additional-fields (a generic
schema-extension mechanism), open-api (a self-referential documentation
generator), oauth-popup and oauth-proxy (two narrow fixes for two distinct
OAuth deployment problems), and three domain plugins (stripe, mcp, cimd)
each instantiating the plugin contract for a different external protocol.

---

## 1. Additional fields — the schema-field-extension mechanism

This is the mechanism referenced throughout `01-core-domain` wherever an
entity is said to accept "additional fields." It has **no server-side
runtime component of its own** — the server-side contract is simply that
the `user` and `session` entities' field sets accept a deployer-declared
extension map as part of the base entity configuration (methodology doc
`01` §5's "extension of a contract" applied directly to the entity schema,
not via a plugin object). The client-side half is a pure **type-inference
bridge**: it contributes no runtime behavior at all, only widening the
client's own static view of request/response shapes to match.

### 1.1 Declaring an additional field: a per-field sub-contract

**Requires:** each declared field names a storage type, and optionally:
whether it is required on creation, a default value (a static value, or a
function evaluated at record-creation time — see §1.2), and whether it is
client-writable at all.

**Ensures:** a field declared **client-writable** (the default) is
accepted as input on every endpoint that accepts entity input for that
entity (sign-up, update) and is returned on every endpoint that returns
that entity. A field declared **not client-writable** is a strictly
narrower contract on the input side only: it is silently dropped from any
client-supplied input body — a client attempting to set it observes no
error, only that the value never takes effect from that path — while
remaining fully populated on output, and fully settable through any
server-side path that bypasses client input (a database hook, an
administrative operation). This is the mechanism by which a field can be
system-managed yet still visible to a client.

**On violation:** none observable from the client side — the client-side
type bridge (§1.4) itself enforces the same restriction statically for any
caller using the generated client types, rejecting an attempt to set a
not-client-writable field **at the type level**, before a request is even
constructed. A caller bypassing the generated types (raw request
construction) is a **CLIENT**-blamed precondition violation that the
server silently absorbs by dropping the field rather than erroring —
dropping, not rejecting, is the documented postcondition here.

### 1.2 Default-value evaluation contract

**Ensures:** a static default value is applied verbatim whenever the field
is omitted from input at creation time. A **function** default is
evaluated fresh **at the moment the record is created**, not at
declaration time and not at request-received time — this is the
distinction that lets a default express "the current instant" (e.g. an
expiry a fixed distance in the future) rather than a value frozen at
process startup.

**Invariant:** a default is applied only when the field is a genuine
create-time omission — it is never retroactively applied to an existing
record, and it never overrides an explicitly supplied value (including an
explicitly supplied value contributed by a database hook running earlier
in the same creation, per the staged-contract composition of methodology
doc `02` §3).

### 1.3 Interaction with secondary storage

**Ensures:** this mechanism's create-time default-application and
required-field contracts hold identically regardless of whether the
entity being created is ultimately persisted through the primary adapter
alone or also mirrored into a configured secondary store
(`01-storage-and-adapters.md` §6) — the additional-field contract is
enforced once, upstream of wherever the record is subsequently written,
so no adapter-specific or secondary-storage-specific narrowing applies
here.

### 1.4 The client-side type bridge is a zero-runtime higher-order contribution

**Requires:** the client-side half is handed either (a) the exact
compile-time type of the server auth instance itself, from which it
extracts the currently declared additional-field maps for `user` and
`session`, or (b) an explicitly restated field-shape map mirroring what
the server declares, for a client built independently of the server's
own source (a separately deployed client application).

**Ensures:** every client operation whose request or response shape
includes the extended entity (sign-up, update-user, update-session,
get-session, sign-in) has its statically-known shape widened to include
the declared additional fields, with the correct optionality: a field
marked not-required is optional in the widened request shape; a field
marked not-client-writable is present in the widened **response** shape
but **absent** from the widened **request** shape for the operations that
would otherwise let a client set it.

**Invariant (methodology doc `01` §5):** this contribution can only ever
**widen** what a generated client believes it may send and receive — it
never narrows any shape the base client already exposed, and two
independently declared additional-field sets (from this mechanism and
from an unrelated plugin's own schema contribution) compose without
conflict as a plain union of properties, since each contributes disjoint
field names by deployer convention.

**On violation:** a mismatch between what the client-side bridge declares
and what the server instance actually enforces (e.g. a client declares a
field as client-writable that the server has marked otherwise) is a
**CLIENT**-blamed configuration-drift bug: the server's own enforcement in
§1.1 is authoritative regardless of what the client-side type bridge
believes, since the bridge contributes no runtime behavior — a mismatch
manifests only as a value silently failing to take effect, never as a
crash.

---

## 2. OpenAPI documentation generation — a self-referential contract

**Role:** an endpoint that, on every request to it, generates a complete
API description document by **introspecting the live, currently registered
set of endpoints** — not by reading a separately maintained, hand-written
specification file. This is what makes its central postcondition
interesting enough to state precisely.

### 2.1 The self-referential postcondition

**Ensures:** the generated document's postcondition is: *for every
endpoint currently registered in this auth instance* (base system plus
every currently installed plugin, in the order they are installed, with
one collision rule — see §2.2), *that endponers's entry in the generated
document accurately reflects that endpoint's own declared contract* —
specifically: its HTTP method(s), its path (with path-parameter syntax
translated into the description format's own convention), its declared
query-parameter shape, its declared request-body shape (translated from
the endpoint's own input-validation schema into the description format's
schema dialect, structurally, not just by reference), and its declared
response shapes, including the fixed set of standard error responses every
endpoint may produce.

**Invariant:** because the document is regenerated **fresh, from the live
endpoint registry, on every request to the documentation endpoint itself**
(there is no separately persisted, cacheable "the spec" that could drift
out of sync with what is actually registered), the postcondition above
holds **by construction** with respect to *registration* — an endpoint
that is currently installed cannot be missing from a freshly generated
document, and an endpoint that has been removed cannot linger in one.

**On violation — the one gap this construction cannot close:** the
postcondition's accuracy is bounded by how faithfully each endpoint's own
**declared** schema matches that endpoint's **actual runtime behavior**.
If an endpoint's real behavior diverges from what it declared (accepts an
undeclared field, returns a response shape its declared schema does not
describe), the generated document is accurate *to the declaration*, not
necessarily to the runtime — this is not a defect in the generator, it is
the boundary of what "generated from the registry" can promise. Blamed
party for such a divergence: **SUPPLIER** (whichever plugin or base
endpoint under-declared its own contract), never the documentation
generator itself, which has fully discharged its own postcondition by
faithfully transcribing what was declared.

### 2.2 Endpoint-collision and exclusion rules

**Ensures:** an endpoint explicitly marked as hidden, or explicitly listed
in the deployer's disabled-paths configuration, is excluded from the
generated document entirely — its absence there mirrors its actual
unavailability (or its deliberately-undocumented status) in the live
pipeline. An endpoint explicitly marked server-only (never reachable
through the public HTTP surface at all) is likewise excluded, since
documenting a path that can never be called would violate the
self-referential postcondition of §2.1 in the opposite direction (falsely
implying reachability).

**Invariant:** when a plugin registers an endpoint at a path the base
system (or an earlier-installed plugin) has already registered, the
**earlier** registration wins for documentation purposes — the later
plugin's colliding endpoint is silently excluded from the generated
document rather than producing two conflicting entries for the same path,
matching the same "first cause" precedence methodology doc `03` §4
applies to plugin interaction generally.

### 2.3 Additional-fields contribution to the generated request bodies

**Ensures:** the two endpoints whose input shape is extensible by the
additional-fields mechanism (§1) and by arbitrary plugin schema
contributions have their generated request-body documentation **merged**
with every currently declared additional/plugin field that is
client-writable, so the self-referential postcondition of §2.1 continues
to hold even for entity shapes assembled from multiple contributors at
different layers — the documentation generator itself performs this
merge, rather than each contributor needing to register its own
documentation delta.

---

## 3. OAuth popup completion — solving the "the redirect lands in the wrong window" problem

**Problem this solves:** the base OAuth sign-in flow is a full-page
redirect round trip; an application that wants to run OAuth sign-in inside
a popup window (so the host page never navigates away) has no way, using
only the base flow, to get the popup's *completed* session handed back to
the *opener* window — the callback response would simply render inside the
popup with nowhere for the host page to observe it.

### 3.1 The two-endpoint sequence, as a diagram

```
   host page (opener)          popup window                 auth server
        │                            │                            │
        │──window.open(start URL,───▶│                            │
        │   carrying: trusted        │                            │
        │   opener origin, a fresh   │                            │
        │   per-attempt nonce)       │                            │
        │                            │──navigate to start ───────▶│
        │                            │                            │── opener origin is
        │                            │                            │   in the trusted-
        │                            │                            │   origins set?
        │                            │                            │      │no ──▶ render an
        │                            │                            │      │       error-
        │                            │                            │      │       completion
        │                            │                            │      │       page (see
        │                            │                            │      │       §3.2) instead
        │                            │                            │      │       of failing
        │                            │                            │      │       silently
        │                            │                            │      │yes
        │                            │                            │      ▼
        │                            │                            │  set a short-lived,
        │                            │                            │  signed "this is a
        │                            │                            │  popup flow, remember
        │                            │                            │  the opener origin +
        │                            │                            │  nonce" marker cookie
        │                            │                            │      │
        │                            │◀── redirect to the ────────│      │
        │                            │    provider's own                │
        │                            │    consent screen                │
        │                            │──user completes consent ─────────▶│
        │                            │                            │  ordinary OAuth
        │                            │                            │  callback processing
        │                            │                            │  (unchanged) issues a
        │                            │                            │  session and would
        │                            │                            │  normally redirect
        │                            │                            │      │
        │                            │                            │  marker cookie present?
        │                            │                            │      │no ─▶ keep the
        │                            │                            │      │      normal redirect
        │                            │                            │      │      (not a popup
        │                            │                            │      │      flow)
        │                            │                            │      │yes
        │                            │                            │      ▼
        │                            │                            │  SWAP the redirect for
        │                            │                            │  a completion page that
        │                            │                            │  embeds the session
        │                            │                            │  token, the echoed
        │                            │                            │  nonce, and the trusted
        │                            │                            │  opener origin
        │                            │◀───────────────────────────│
        │                            │  completion page's own
        │                            │  script posts a message
        │                            │  to window.opener,
        │                            │  addressed EXACTLY to the
        │                            │  trusted origin recorded
        │                            │  in the marker, then
        │                            │  closes itself
        │◀── message received ───────│
        │  (origin- and nonce-
        │   checked before use)
```

### 3.2 Contract clauses

**Requires:** the opener's own origin, supplied by the popup at start
time, must already be a member of the deployer's trusted-origins
configuration — this is checked **before** anything else happens, because
everything downstream (the completion page's cross-window message) is
only as safe as knowing the message's destination is trusted.

**On violation (untrusted opener origin):** refused with a typed error at
the start endpoint itself, before any provider redirect is even
constructed. Blamed party: **CLIENT** (the embedding application's own
origin was never added to the trusted-origins configuration).

**Ensures:** every one of the three redirect-target URLs the caller may
supply (the success callback, the error callback, the new-user callback)
is validated against the same trusted-origin rule the base redirect flow
applies — but because this endpoint is reached by simple navigation (no
opportunity for the base flow's own request-body origin check to run), a
failure here is **relayed to the opener as a completion-page error
message** rather than thrown as a bare HTTP error the popup would just
display uselessly to the end user with no way for the host application to
react.

**Ensures (the handoff itself):** the completion page carries the session
token and posts it **only** to the exact origin recorded in the signed
marker set at start time — never to a wildcard destination — and the
opener-side counterpart accepts the incoming message only if its origin,
its message-type tag, and its echoed nonce **all** match what that specific
popup attempt itself generated, discarding anything else. **Invariant:**
this nonce-plus-origin double check is what prevents one popup attempt's
completion message from being accepted by a *different*, unrelated popup
attempt racing on the same page, or by an unrelated message from anywhere
else on the page.

**On violation (popup blocked, closed early, or timed out):** each is a
distinct, named outcome (not a generic failure) so the caller can present
the right recovery action to the end user; none of the three ever leaves a
completed-but-unobserved session silently orphaned — a closed-before-
completion popup simply never produces a completion message, and the
opener's wait is bounded by a caller-configurable timeout after which it
gives up and cleans up its own wait state. Blamed party for a blocked
popup specifically: **CLIENT** in the sense that the browser's own popup
policy — not this contract — made the call; the contract's obligation is
only to report this distinctly, which it does.

**Invariant (defense in depth):** the completion page itself is served
with a content-security policy that permits **only** its own single,
fixed, pre-computed script to execute — a page carrying a live session
token is deliberately the least hospitable possible target for any
injected script, and the page is served with caching disabled so the
token-bearing response is never persisted by an intermediary.

---

## 4. OAuth proxy — solving the "preview deployment has no stable OAuth redirect URI" problem

**Problem this solves:** an OAuth provider's registered redirect URI is
fixed at registration time, but a preview/staging deployment's own URL is
often generated fresh per deployment (a per-branch or per-pull-request
hostname) — there is no way to pre-register every such URL with the
provider ahead of time. This plugin lets every non-production deployment
transparently **borrow** the one stable, pre-registered redirect URI that
belongs to the production deployment, then hands the completed sign-in
back to whichever preview deployment actually initiated it.

### 4.1 The three-hop sequence

```
  preview deployment          OAuth provider           production deployment
   (unstable URL)            (fixed redirect URI          (stable, registered
                               registered to prod)          redirect URI)
        │                            │                            │
        │  end user starts sign-in on preview                     │
        │  before-hook rewrites the callback URL so the           │
        │  PROVIDER is told to come back to PRODUCTION's          │
        │  fixed callback path, carrying the preview's own        │
        │  origin embedded as a query parameter, and encrypts     │
        │  the OAuth state under a proxy-specific key so that     │
        │  production (which does not hold preview's own          │
        │  per-environment secret) can still decrypt it            │
        │                            │                            │
        │────provider authorization redirect (unchanged)─────────▶│
        │                            │                            │
        │                            │◀──user completes consent───│
        │                            │───callback with code──────▶│
        │                            │                            │  after-hook detects
        │                            │                            │  this state was proxy-
        │                            │                            │  encrypted, decrypts it
        │                            │                            │  under the SAME proxy
        │                            │                            │  key, exchanges the
        │                            │                            │  code for tokens itself
        │                            │                            │  (production completes
        │                            │                            │  the OAuth exchange —
        │                            │                            │  it is the only party
        │                            │                            │  with a redirect URI
        │                            │                            │  the provider actually
        │                            │                            │  trusts), fetches the
        │                            │                            │  profile, but does
        │                            │                            │  NOT create a session
        │                            │                            │  or persist anything
        │                            │                            │  on production — it
        │                            │                            │  re-encrypts the
        │                            │                            │  profile+account
        │                            │                            │  payload under the
        │                            │                            │  proxy key and redirects
        │                            │                            │  back to the preview
        │                            │                            │  origin embedded earlier
        │◀───redirect carrying the encrypted passthrough payload───│
        │                            │                            │
        │  preview's own callback-completion endpoint decrypts   │
        │  the payload under its OWN copy of the proxy key,       │
        │  validates its age against a short max-age window,     │
        │  validates the embedded state binding, and completes    │
        │  the actual user/session creation LOCALLY, against      │
        │  the preview deployment's own database                  │
```

### 4.2 Contract clauses

**Requires:** every participating environment (production and every
preview) must share **one** proxy-specific secret, independent of each
environment's own primary signing secret — this is a deliberate blast-
radius narrowing (§4.4) rather than convenience: the value that crosses
between environments is protected by a key scoped to exactly this purpose.

**Ensures:** whether a given request is proxied at all is itself
determined by a same-origin check performed fresh on **every** relevant
request — a request whose current origin already equals the configured
production origin is never proxied (there would be nothing to solve), and
an explicit request header lets a caller force the non-proxied path
regardless of origin, for testing.

**Ensures (the passthrough payload's postcondition):** the payload
production hands back to preview contains everything preview needs to
complete the sign-in **without preview ever needing its own trusted
redirect URI registered with the provider**: the resolved user-profile
information, the resolved provider-account linkage information, the
original callback destination, and a timestamp — but **never** the raw
authorization code and **never** a token the provider issued directly to
production, since those were already fully consumed by production's own
token exchange; preview receives only the *result* of that exchange, not
the means to repeat it.

**Invariant (replay bound):** the passthrough payload carries a
generation timestamp and is rejected by the receiving preview deployment
if its age exceeds a short, deployer-configured maximum (a small,
deliberately tight window, permitting only a small amount of clock-skew
tolerance in the future direction) — this bounds how long a captured
payload could be replayed if intercepted, independent of the transport
security of the redirect itself.

**On violation:** every failure mode in this sequence — a missing or
undecryptable payload, a payload whose embedded state does not match what
preview itself originally issued, a payload older than the configured
window, a provider-reported error — redirects to a configured error
destination with a machine-readable reason rather than surfacing a bare
exception, because by the time any of these can be detected the flow has
already crossed two deployments and the end user is mid-redirect; there is
no "throw and let the caller retry the same request" option available at
this point. Blamed party: **CLIENT** for a state/binding mismatch (a
tampered or foreign payload was presented) — never the provider and never
production, since production's own token exchange already succeeded
before any of these checks run.

### 4.3 Interaction with the popup completion contract (§3)

**Invariant:** these two contracts compose without conflict because they
intervene at different points in the pipeline — the proxy's hooks operate
on the callback's *redirect target*, while the popup contract's hook
operates on swapping that same redirect for a completion page — but a
configuration combining both for the same sign-in attempt must resolve
proxying **before** the popup marker check, since the popup marker itself
is scoped to whichever origin the request actually reaches, and after
proxying that is preview's origin, not production's.

### 4.4 Disclosure: why a dedicated secret is documented as a stated precondition

**Ensures:** using a secret scoped specifically to this plugin, rather
than each environment's own primary secret, means a leak of this one
proxy secret cannot be used to forge a session directly (it protects only
the passthrough payload's confidentiality/integrity in transit between two
already-trusted deployments) and cannot be used to decrypt anything
protected under any environment's own primary secret. **On violation:** a
deployer who instead lets every environment fall back to its own separate
primary secret for this purpose breaks the contract at its root — the two
environments would then be unable to decrypt each other's payloads at all,
since the entire mechanism depends on the encrypting and decrypting party
sharing the same key. Blamed party: **CLIENT** (must explicitly configure
one shared secret across every participating environment for this feature
to function).

---

## 5. Stripe — billing/subscription state synchronized to a user or organization by webhook

**Role:** a plugin instantiation of the base plugin contract that links a
billing-provider customer and subscription record to either a user or an
organization (configurable), and keeps the locally persisted subscription
record's state **driven by, and only by, the billing provider's own
webhook events** — the plugin's own subscription-management endpoints
(upgrade, cancel, restore, list, billing-portal) only ever *initiate*
change with the provider; they never themselves write the terminal state
of a subscription record directly. That is exactly what makes this a
webhook-driven state-sync contract worth stating precisely.

### 5.1 Customer linkage: created lazily, reconciled defensively

**Ensures:** when configured to create a billing-provider customer
automatically at account creation, the plugin first attempts to find and
reuse an existing billing-provider customer already associated with that
email — but reuse is gated on two conditions that both must hold: the
matched provider customer must not already be linked to a **different**
local user, and the local user's email must itself already be verified.
Failing either condition, a **new** provider customer is created instead
of reusing the ambiguous match.

**Invariant:** the customer-identifier field this plugin adds to the user
(or organization) entity is populated **at most once** in the automatic
path — a user that already carries one is never re-processed by this
hook, making this specific database-hook contribution idempotent under
retries or duplicate invocation.

**On violation:** any failure in customer creation/linkage (a network
failure against the billing provider, an unexpected provider response) is
logged and swallowed at the hook boundary rather than failing the
account-creation operation it is attached to — **Invariant:** account
creation's own postcondition is never weakened by a billing-provider
outage; the customer linkage is best-effort relative to sign-up succeeding.
Blamed party for an account left without billing-provider linkage after
such a failure: **SUPPLIER** (the billing provider or network), and
recovery is the deployer's own responsibility (a subsequent subscription
attempt re-runs the same lazy-creation lookup).

### 5.2 The subscription record's state machine is entirely webhook-driven

```
   local subscription record's status field
                    │
   the ONLY writer of this field's terminal values is the
   webhook handler, reacting to the billing provider's own
   authoritative event stream — never the plugin's own
   upgrade/cancel/restore endpoints directly:

   checkout completed event ──▶ record created/updated: status,
                                 plan, current period bounds, trial
                                 bounds (if any), seat count — all
                                 copied FROM the provider's own
                                 subscription object, not computed
                                 locally

   subscription created event (e.g. a subscription started directly
   on the provider's own dashboard, never through this plugin's own
   checkout) ──▶ record created if none exists yet for the resolved
                 customer — reconciling out-of-band provider-side
                 changes into the local system of record

   subscription updated event ──▶ record's status, period bounds,
                                   cancellation bookkeeping, and plan
                                   are ALL overwritten from the
                                   provider's current object state;
                                   a transition into "pending
                                   cancellation" or out of a trial
                                   fires the corresponding
                                   deployer-supplied callback exactly
                                   once, gated on comparing the
                                   record's PRE-update state to its
                                   post-update state (never fired
                                   from the webhook event's shape
                                   alone)

   subscription deleted event ──▶ record's status set to canceled,
                                   final period/cancellation
                                   timestamps copied from the
                                   provider's own final object state
```

**Requires:** every webhook request must carry a valid signature over the
exact raw request body, verified against a configured webhook secret
before the payload is parsed as an event at all — the raw body is
deliberately read and verified before any JSON parsing occurs, so no
event is ever acted upon whose authenticity has not first been
cryptographically established.

**On violation:** a missing signature header, a missing configured
secret, or a signature that fails verification are each distinct,
named failure outcomes, and in every case **zero** local state is
touched — the handler refuses before dispatching to any of the
per-event-type handlers above. Blamed party: **CLIENT** for a missing
webhook-secret configuration; an unverifiable signature is blamed on
whoever sent the request (an unauthenticated caller impersonating the
provider), never on the local subscription record's own consistency,
which remains untouched.

**Ensures (idempotent event processing):** the created-event handler
explicitly checks for an already-existing record for the same
subscription before creating another, so a duplicate delivery of the same
provider event (a normal occurrence for any webhook-based integration,
since providers redeliver on ambiguous acknowledgement) cannot produce two
local records for one provider subscription. **Invariant:** every
per-event handler is independently resilient to "the local record was
concurrently modified or deleted between this handler's read and its
write" — such a race degrades to a logged warning and a skipped callback
invocation, never a crash and never a state overwrite with stale data.

### 5.3 Organization billing extends, never narrows, the user-billing contract

**Ensures:** when configured to bill organizations rather than individual
users, every contract in §5.1–§5.2 holds identically with the
organization entity substituted for the user entity as the linkage
target, plus two additive behaviors layered on top of the host
organization plugin's own hooks (composed with, never replacing, any
hooks the deployer already attached — see the composition pattern in
`03-plugin-system/`): an organization's own name is kept synchronized to
its billing-provider customer record's name after every organization
update, and an organization carrying any subscription that is not
canceled or incomplete cannot be deleted — that deletion attempt is
refused with a typed error, before the organization plugin's own deletion
proceeds.

**Ensures (seat-based billing):** when a plan declares a seat price, the
billing-provider subscription's quantity for that price is kept
synchronized to the organization's current member count after every
membership change (add, remove, accept-invitation) — but only for an
organization whose subscription is currently active or trialing and whose
plan is actually seat-priced; a no-op is a valid, expected outcome for
every other combination, not a skipped update.

---

## 6. MCP — a Model Context Protocol authorization server exposing auth-gated resources

**Role:** this plugin **is** the OAuth 2.1/OIDC authorization server,
specialized for the Model Context Protocol's own resource-server discovery
conventions — it is not a client of a separately configured provider, and
it cannot be composed alongside a separately configured generic OAuth
provider plugin in the same instance, because both would claim the same
authorization-server role.

### 6.1 Resource binding is the load-bearing contract

**Requires:** the deployer supplies exactly one canonical protected-
resource identifier for the MCP server itself — an absolute URL, without
embedded credentials, without a fragment, without a query string (a
query-carrying resource is explicitly out of scope for this convenience
layer and must use the lower-level verification primitives directly), and
restricted to HTTPS except for loopback addresses reserved for local
development.

**Ensures:** every token this authorization server issues is
**audience-bound** to that exact resource identifier, and that same
identifier is both added to the provider's own recognized-resources set
and published in the standard protected-resource discovery document this
plugin serves — so an MCP client performing standard discovery learns,
without any MCP-specific code, both which authorization server to use and
which resource identifier to request tokens for.

**Invariant:** a token whose audience does not match this exact resource
identifier is never accepted by the resource-server-side verification
half of this contract (§6.2), regardless of any other property (valid
signature, unexpired, correct issuer) — audience binding is enforced as
an independent, non-optional check, precisely because RFC 8707-style
audience restriction is the mechanism that prevents a token minted for one
resource from being replayed against a different one.

### 6.2 Resource-server request protection: a reusable arrow contract

```
request-protection arrow  :  incoming HTTP request
                              ->  { verified claims, handler runs }
                                | { 401, RFC 9728-shaped WWW-Authenticate
                                    challenge, handler never runs }
                                | { 403, RFC 6750-shaped
                                    insufficient-scope challenge naming
                                    every missing scope, handler never
                                    runs }
```

**Requires:** a bearer access token on the incoming request, verified
against the authorization server's own published key material, with the
expected issuer and the expected audience (§6.1) both matched exactly; if
the deployer additionally declares a set of required scopes, every one of
them must be present on the verified token's own scope claim (or satisfy
a deployer-supplied custom matcher).

**Ensures:** a request that fails verification for **any** reason
(missing token, invalid signature, expired, wrong issuer, wrong audience)
never reaches the wrapped handler, and instead receives a discovery-
shaped challenge response — this is what lets a standards-compliant MCP
client, on receiving this exact response shape, autonomously begin the
authorization flow with no bespoke error-handling for this server.
**Invariant:** a request that verifies but is missing a required scope is
distinguished from outright authentication failure — it receives the
scope-naming challenge instead, so the client can request exactly the
missing scopes on its next attempt rather than restarting authorization
from nothing; a handler may itself raise this same class of challenge for
a scope only it — not this generic contract — knows to require.

**On violation:** none beyond the two challenge shapes above — this
arrow contract has no other failure mode; every rejection is one of the
two named, standards-shaped challenges, never a bare, unstructured error.
Blamed party for a request that fails verification: **CLIENT** (the
caller's token was missing, expired, or insufficiently scoped).

### 6.3 Client registration is opt-in and delegated

**Ensures:** this plugin, by itself, opens **no** path for a previously
unknown client application to register itself — dynamic client
registration and admission is entirely delegated to whichever discovery/
registration mechanism the deployer separately composes in (the CIMD
plugin, §7, being the mechanism this ecosystem's own protocol revision
specifically pins). **Invariant:** composing this plugin with that
discovery mechanism is additive only (methodology doc `01` §5) — it
strictly grows the set of client identities this authorization server will
recognize, and never weakens the resource-binding or scope-verification
contracts of §6.1–§6.2, which apply uniformly regardless of how a client
came to be registered.

### 6.4 A disclosed relaxation specific to this plugin

**Ensures:** unlike the general-purpose authorization-server contract's
strict-by-default replay handling for a rotated refresh token, this
plugin configures a short reuse-tolerance window by default, so a client
that legitimately retries a refresh request (having failed to observe the
first response, a common condition for the kind of long-lived, imperfectly
connected client this protocol is designed for) can still recover the
exact token response the earlier, successful attempt already produced,
rather than being treated as a replay attack.

**On violation (documented narrowing):** this is a **strictly weaker**
replay-window contract than the strict default, applied specifically and
only to clients configured through this plugin — a deployer that wants the
strict default back may set the window to disable it entirely. Blamed
party for anyone surprised by the relaxed default specifically: none —
this is the plugin's documented, intentional specialization, justified by
the operating conditions of the protocol it targets.

---

## 7. CIMD — unauthenticated, on-demand client discovery over HTTPS

**Role:** a **contribution** to the authorization-server plugin's own
client-discovery extension point (methodology doc `02` §4's "record of
functions" composition) — CIMD is not usable on its own; it only has
effect when composed with an authorization-server plugin (such as MCP,
§6) that accepts such a contribution. What it does: lets a client identify
itself by presenting an HTTPS URL as its own client identifier, at which
the authorization server fetches, validates, and caches a small metadata
document describing that client — in place of any pre-registration step.

### 7.1 The resolution sequence as a diagram

```
   authorization server                          client's own HTTPS URL
   needs to resolve a client                     (the client_id itself)
   identifier it has never
   seen before, OR needs to
   confirm a previously
   resolved one is still fresh
              │
              ▼
   does the identifier even LOOK like an HTTPS URL?
              │no ──▶ not a candidate for this mechanism at all;
              │       falls through to whatever other client-lookup
              │       path the authorization server already has
              │yes
              ▼
   is a still-fresh, previously validated document
   cached for this exact identifier?
              │yes ──▶ use the cached, already-validated document;
              │        NO network fetch occurs at all for a fresh hit
              │no
              ▼
   is a resolution for this SAME identifier already
   in flight from a concurrent request?
              │yes ──▶ await and reuse that SAME in-flight resolution
              │        rather than issuing a second concurrent fetch
              │        for the identical identifier
              │no
              ▼
   would issuing a new fetch now exceed any of five independent,
   simultaneously-enforced budgets: per-client minimum retry
   interval (failed fetches only), global concurrent-fetch limit,
   per-origin concurrent-fetch limit, global rolling-window rate
   limit, per-origin rolling-window rate limit?
              │yes ──▶ reject immediately (a distinct, named
              │        "temporarily unavailable" outcome) — this
              │        contract NEVER queues a fetch that cannot run
              │        immediately; it fails fast instead
              │no
              ▼
   fetch the document over HTTPS, WITHOUT following any redirect,
   with a strict response-size ceiling and a strict timeout,
   presenting any previously cached conditional-fetch validators
              │
              ▼
   validate the fetched document against §7.2's rule set
              │invalid ──▶ reject; nothing is persisted or cached
              │valid
              ▼
   persist (create, or reconcile onto an already-existing) an
   authorization-server client record derived from the document,
   fire a best-effort creation/refresh notification, cache the
   document under the freshness lifetime the response itself
   negotiates (bounded above by a deployer-configured ceiling)
```

### 7.2 The validation contract: why this client type is trusted less than a pre-registered one

**Requires:** the client-identifier URL itself must be a plain, credential-
free, fragment-free, dot-segment-free, explicit-path HTTPS URL whose host
is publicly routable (not loopback, not a private or reserved address —
this is a server-side-request-forgery boundary, since the server is about
to make an outbound fetch to a caller-supplied URL).

**Ensures:** the fetched document is rejected outright if it declares
itself under any authentication method that depends on a shared secret
(this discovery mechanism has no side channel through which a secret
could ever be provisioned to a dynamically-discovered client, so accepting
one would be meaningless at best and a confusable-identity risk at worst)
— only credential-free or public-key-based client authentication is
accepted; if public-key authentication is declared, a usable public key
must actually be present in the document. The document's own declared
identifier must equal, by exact string comparison, the URL it was fetched
from — this is the mechanism's core binding: the URL *is* the identity,
so a document fetched from one location cannot claim to speak for another.
A configurable subset of the document's own URL-valued fields (by default,
its logout-redirect and human-facing-homepage fields) must additionally
share the client identifier's own origin, preventing a client from
claiming URLs on a domain it does not control — deliberately **excluding**
the redirect-URI field from this origin-binding-by-default rule, since
exact redirect-URI matching at authorization time is already mandatory
and independently enforced, and legitimate native/distributed clients
routinely use a redirect destination on a different origin than their
metadata document's own host.

**Invariant:** every accepted document, once persisted, is treated by the
authorization server as an ordinary registered client for every purpose
downstream of this plugin (§6's audience-binding and scope-verification
contracts apply identically) — this plugin's entire narrowing relative to
pre-registration lives in *how* a client gets admitted, never in what it
is subsequently permitted to do.

**On violation:** every one of the checks above is a hard rejection with
no partial admission — a document failing any single rule never produces a
client record, and the identifier is not cached as valid (though a
per-client failure-retry pacing interval still applies, independent of
success/failure, to bound how often the server will re-attempt fetching a
URL that keeps failing). Blamed party: **CLIENT** (the party presenting
the URL as its identifier is responsible for the document served at that
URL meeting every rule above) — except for the network-transport
guarantees the fetch itself depends on (resolving the host exactly once,
pinning the resolved address for the connection's lifetime, refusing
redirects at the transport layer, rejecting reserved-address targets),
which this plugin explicitly documents as a **precondition it cannot
itself enforce after the fact**: it requires the deployer's own supplied
fetch transport to provide these guarantees, because a generic fetch
wrapper applied after DNS resolution has already happened cannot retroactively
close a time-of-check-to-time-of-use gap between resolving the host and
connecting to it. Blamed party for a transport that does not honor this:
**CLIENT** (supplied a fetch transport that does not meet this plugin's
documented precondition).

### 7.3 Cache freshness is a negotiated, bounded contract

**Ensures:** how long a validated document is trusted without
re-fetching is governed by the fetched response's own standard caching
directives (an explicit no-store or no-cache instruction is honored
exactly; an explicit lifetime is honored up to, but never exceeding, a
deployer-configured ceiling) — a response that declares no caching
information at all falls back to that same deployer-configured ceiling
directly. **Invariant:** the cache is bounded in size (a fixed maximum
number of entries, least-recently-used eviction) so an unbounded number of
distinct client identifiers cannot grow this cache without limit — a
resolution for an identifier evicted under this pressure is simply treated
as a fresh, uncached resolution next time, never as an error.

**On violation:** a stale-but-not-yet-expired cached document is never
proactively re-validated by a background process — this mechanism is
exclusively **revalidate-on-next-use**, never periodic; a document that
happens not to be resolved again until well after it changed
upstream continues to serve its last-cached version until the next actual
resolution attempt notices it has expired. Blamed party for staleness
beyond the deployer's own configured ceiling: none — this is the
documented contract, not a violation of it.
