# Glossary

Terms as used consistently across this specification tree. Defined once
here; every other document assumes these meanings without redefining them.

---

## Methodology terms (from `00-methodology/`)

**Contract** — The complete, mutually binding specification of a
precondition, a postcondition, and the invariant(s) an operation preserves.
Nothing outside the contract is guaranteed. See `00-methodology/01`.

**Precondition (`Requires`)** — What the client of an operation must
establish before calling it. Violating it is always a client-blamed
failure. See `00-methodology/01` §2.1.

**Postcondition (`Ensures`)** — What the supplier of an operation
guarantees after it terminates normally, given the precondition held.
Violating it is always a supplier-blamed failure. See `00-methodology/01`
§2.2.

**Invariant** — A property of a stateful abstraction that holds at every
stable observation point (after construction, and between operations) —
not necessarily mid-operation. See `00-methodology/01` §2.3.

**Hoare triple** — The `{P} operation {Q}` notation used to state every
operation in this tree: if precondition `P` holds and the operation
terminates, postcondition `Q` holds. See `00-methodology/01` §3.

**Liskov-style extension rule** — The rule governing how a specialization
(a plugin, a concrete adapter, a subtype of any contract) may differ from
what it extends: it may only weaken (or keep) the precondition, and may
only strengthen (or keep) the postcondition, and must preserve the
invariant of the abstraction it extends. Used throughout this tree to
judge whether a plugin or adapter is a legitimate extension or a silent
breaking change. See `00-methodology/01` §5.

**Arrow contract (`domain -> range`)** — The contract form used for any
value that is itself behavior (a hook handler, a matcher, a plugin `init`
function, an adapter method, a provider strategy). Checked lazily, once
per invocation, not once at registration time. See `00-methodology/02`.

**Staged / dependent contract** — An arrow contract whose domain at stage
*N* is allowed to depend on the concrete value actually produced at stage
*N-1* (e.g. each plugin's `init` sees the merged context produced by every
plugin initialized before it). See `00-methodology/02` §3.

**Contract boundary** — The point where a value crosses from one party to
another (producer → consumer). Every blame assignment in this tree is
anchored to a specific boundary. See `00-methodology/03` §1.

**Blame (positive / negative)** — The formal assignment of fault for a
contract violation to exactly one of the two parties at a boundary:
*negative* blame falls on whoever supplied a bad incoming value (typically
the calling application/end user); *positive* blame falls on whoever
produced a bad outgoing value or effect (typically better-auth itself, a
plugin, or an adapter). See `00-methodology/03` §2.

**Blamed party** — One of `CLIENT` (the caller of the API — end user,
browser, calling application), `SUPPLIER` (better-auth core or a plugin),
`ADAPTER` (the database/storage implementation), or, only in the OAuth and
federation documents, `UPSTREAM PROVIDER` (a genuinely external identity
provider whose response is itself malformed or unreachable). See
`00-methodology/03` §2 and `04-oauth-and-federation/01` for the
provider-blame extension.

**"First cause, not first observer"** — The rule that when one plugin's
violation of an invariant causes a *different*, unrelated plugin to fail
downstream, blame attaches to the plugin that broke the invariant, not the
plugin that merely observed the breakage and failed as a result. See
`00-methodology/03` §4 and `02-request-pipeline/05` §1.

---

## Core-domain terms (from `01-core-domain/`)

**Entity** — One of the four core data abstractions: `User`, `Account`,
`Session`, `Verification`. Each has its own invariants, specified in
`01-core-domain/01-entities-and-invariants.md`.

**coreSchema** — The shared base shape (identity + audit fields) every
core entity extends, and the baseline invariant every plugin-contributed
field must not violate.

**Additional fields** — The generic mechanism by which configuration or a
plugin extends an entity's shape. Specified as a schema-extension contract
in `01-core-domain/01` and instantiated concretely in
`09-platform-services/05` (the `additional-fields` plugin).

**Canonical session lookup** — The single, authoritative operation that
resolves a session token to a `{ session, user }` pair, referenced by
every session-carrying extension (bearer, JWT, multi-session) as the
delegate they must not bypass without documenting the resulting weakening.

**Rolling refresh** — The contract by which a session's expiry is
extended on use rather than fixed at issuance, specified in
`01-core-domain/02-session-lifecycle.md` §4.

**Atomic-fallback** — The degraded-but-documented transaction contract a
storage backend without native transactions must still satisfy (via
compare-and-delete/compare-and-swap-style guards) to remain substitutable
per the adapter contract. See `01-core-domain/04` and
`09-platform-services/01`.

**`consumeOne` / `incrementOne`** — The two race-safe adapter primitives
(single-use consumption, atomic counter increment) that require stronger
guarantees than a plain `update`, specified in `01-core-domain/04`.

---

## Request-pipeline terms (from `02-request-pipeline/`)

**Endpoint** — The unit of request/response behavior contributed either by
core or by a plugin; see `02-request-pipeline/01` for the shared contract
every endpoint satisfies regardless of contributor.

**Before hook / after hook** — The two matcher+handler arrow-contract
pairs a plugin may register around any endpoint; before-hooks may
continue/modify/halt, after-hooks may continue/replace. See
`02-request-pipeline/02`.

**onRequest / onResponse** — The router-level (not endpoint-level)
lifecycle arrows every plugin may contribute; documented as asymmetric
(onRequest chains across plugins, onResponse is first-wins). See
`02-request-pipeline/02` §4.

**No-store contract** — The guarantee that any response carrying
credential material (tokens, secrets) is marked non-cacheable by every
intermediary. See `02-request-pipeline/01`.

**Rolling window (rate limiting)** — The time-boxed request-count contract
enforced per path/plugin/global scope; violating it is always
client-blamed. See `02-request-pipeline/04`.

**Configuration-time error** — The fourth error category (alongside
per-request client/supplier/adapter errors): a contract violation
detected when the auth instance itself is assembled (e.g. conflicting
plugin schema), not when a request is handled. See
`02-request-pipeline/05` §4.

---

## Plugin-system terms (from `03-plugin-system/`)

**Plugin contribution surface** — The fixed, small vocabulary a plugin may
use to extend the system: `init`, `endpoints`, `middlewares`,
`onRequest`/`onResponse`, `hooks`, `schema`, `migrations`, `rateLimit`,
`$ERROR_CODES`, `adapter` overrides, `options`/`$Infer`. Each is its own
arrow contract, specified individually in `03-plugin-system/01`.

**Staged pipeline** — The ordered composition of every plugin's `init`
across the whole set of installed plugins, where later stages may observe
(but not rely on load-order-independent access to) earlier stages' output.
See `03-plugin-system/02`.

**Collision resolution strategy** — The (contract-significant, and
per-contribution-kind *different*) rule for what happens when two plugins
contribute to the same schema field, endpoint name/path, or rate-limit
rule. See `03-plugin-system/02` §3 for the full per-kind table.

**Server/client correspondence contract** — The expectation that a client
plugin's contract mirrors its paired server plugin's contract exactly; a
mismatch (client installed without server, or vice versa) is a documented
blame case. See `03-plugin-system/03`.

---

## OAuth & federation terms (from `04-oauth-and-federation/`)

**Provider-strategy contract** — The arrow contract every social/OIDC
provider integration must satisfy: given provider-specific tokens/claims,
produce a normalized identity profile. See `04-oauth-and-federation/02`.

**RETURNING / CREATE / LINK / REJECT decision** — The four-way branch
social sign-in resolves to on every callback, based on whether the
external identity is already linked, matches an existing verified local
identity, or conflicts. See `04-oauth-and-federation/02`.

**JIT (just-in-time) provisioning** — The contract by which a first-time
federated identity (SSO/SCIM) creates a local `User` record automatically
under stated preconditions, rather than requiring prior manual creation.
See `04-oauth-and-federation/05`.

**Domain-verification CAS (compare-and-swap)** — The concurrency-safe
contract preventing two organizations from simultaneously claiming the
same verified email domain for SSO routing. See `04-oauth-and-federation/05`.

---

## MFA & verification terms (from `05-mfa-and-verification/`)

**Channel-delivered credential** — A one-shot secret (email OTP, magic
link, SMS OTP) whose delivery depends on a caller-supplied "send" callback
— itself a higher-order contract whose failure mode is distinct from the
credential's own issuance/consumption contract. See
`05-mfa-and-verification/03`.

**Attempt-budget discipline** — The contrast between bounded-guess
credentials (short OTPs, which must rate-limit verification attempts) and
single-shot high-entropy tokens (magic links, which rely on unguessability
instead). See `05-mfa-and-verification/03`.

**Ceremony** — A multi-round challenge/response protocol with its own
session-scoped state (WebAuthn registration/authentication, SIWE
sign/verify). See `05-mfa-and-verification/02` and `05`.

**Fail-open / fail-closed** — Whether a cross-cutting precondition check
(captcha, breached-password lookup) that depends on an unreachable
upstream service defaults to permitting or blocking the underlying
operation. See `05-mfa-and-verification/07`.

---

## Authorization terms (from `06-authorization/`)

**Statement** — A declared universe of permissible actions for a resource
type; the atomic unit roles are built from. See `06-authorization/01`.

**Role** — A named, fixed subset of statements; the `authorize` arrow
contract checks an actor's assigned role(s) against a requested
action/resource pair. See `06-authorization/01`.

**Session-substitution contract (impersonation)** — The contract
governing an admin acting as another user's session while preserving an
immutable attribution trail back to the real actor. See
`06-authorization/02`.

**Permission-narrowing contract (API keys)** — The rule that a key's
granted permissions must be a subset of its creator's permissions at
creation time — a Liskov-style narrowing requirement. See
`06-authorization/04`.

---

## Session-extension terms (from `07-session-extensions/`)

**Device slot** — The multi-session plugin's bookkeeping unit tracking
one concurrently valid session among several for the same user. See
`07-session-extensions/01`.

**Session-equivalence contract** — The requirement that an alternate
session carrier (bearer token, API key) produce an authorization context
indistinguishable, downstream of authentication, from a cookie-carried
session. See `07-session-extensions/03` and `06-authorization/04`.

**Documented postcondition weakening** — The explicit, named exception to
the Liskov extension rule permitted when a plugin cannot fully preserve a
base postcondition (e.g. stateless JWT sessions cannot guarantee
immediate revocation) — permitted only if disclosed, per
`00-methodology/01` §5 and instantiated in `07-session-extensions/03`.

---

## Client-SDK terms (from `08-client-sdk/`)

**Reactive session store** — The invariant that client-side session state
always reflects either the last server-confirmed value or an explicit
loading/error state — never a stale value presented as current. See
`08-client-sdk/01`.

**Framework binding contract** — The single generic hook/composable
contract every UI-framework integration satisfies; per-framework sections
document only genuine deltas. See `08-client-sdk/02`.

---

## Platform-services terms (from `09-platform-services/`)

**Secondary/cache storage contract** — A narrower key-value contract (get/
set/delete/increment/list) layered *alongside*, never *instead of*, a
full adapter — the role `redis-storage` plays. See
`09-platform-services/01` §6.

**Advisory vs. hard-gate generation** — The asymmetry between the CLI's
schema `generate` (warns but still emits) and `migrate` (refuses outright
on unsafe changes). See `09-platform-services/04`.

**Disclosure inventory** — The exhaustive list of what telemetry may ever
transmit (configuration shape booleans only, never secrets or values),
stated as a contract ceiling, not a description of current behavior. See
`09-platform-services/03`.
