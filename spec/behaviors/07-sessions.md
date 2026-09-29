# Sessions

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-07 |
> | Revision | 1.2 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Added a cross-reference to ADR-EA-014 (session storage backend neutrality) and a note on the revoke/in-flight-request TOCTOU window (CCR-EA-002) <br> 1.2 (2026-09-29): Replaced the pre-implementation banner with implementation pointers (DTWS-001, CCR-EA-006) |

---

> Implemented in `@awthaq/core` (`Sessions.ts`, `SessionCookie.ts`; tests `packages/core/test/Sessions.test.ts`); the tests behind each behavior are mapped in [`spec/traceability.md`](../traceability.md) §5, and a behavior whose text differs from the shipped code carries an *Implementation* or *Deviation* note. The design was drawn from `archive/PRD.md` §13 and `archive/design/usage-examples-v4.md` §5.

## BEH-EA-049: A session token is an opaque `id.secret` pair

> **See:** [ADR-EA-014](../decisions/014-session-storage-backend-neutrality.md)

```ts
const { session, token } = yield* sessions.issue({ userId, request: { ip, userAgent } })
// token: Redacted<"<id>.<secret>">
```

```text
REQUIREMENT: `Sessions.issue` MUST mint a token composed of a public `id`
             (used for lookup) and a `secret` (used for verification),
             joined as `id.secret`; the secret component MUST exist only in
             the value returned at issuance and in the client's cookie —
             never reconstructable from what is persisted.
```

`archive/PRD.md` §13 fixes this two-part shape so that a lookup does not require scanning every session for a matching hash: the `id` half indexes the row directly, and only the `secret` half needs the cryptographic comparison described in BEH-EA-056. `archive/design/usage-examples-v4.md` §5.2 shows the intended return type directly as `Redacted<"<id>.<secret>">`, underscoring that the raw value is meant to never appear in a log or span unredacted.

**Authentication methods are recorded per session (THS-003, APS-007).** A session carries `amr` — RFC 8176 authentication method references, a closed set (`pwd`, `hwk`, `swk`, `user`, `otp`, `mfa`, `fed`, `email`) — answering "with which factors", where `authenticatedAt` answers only "how recently". The authenticating plugin sets it at `issue` (password `["pwd"]`, OAuth `["fed"]`, passkey `["hwk"]`, plus `"user"` when the authenticator performed user verification; a legacy-bridge or impersonation session records none); `reauthenticate` unions newly proven methods in — order-preserving, without duplicates, and never removing one (monotone within a session). It is exposed on `SessionView`, `SessionListItem`, `SessionDto` and the resolved `UserPrincipal`, so a host or a qadi obligation (e.g. "requires `mfa`") can gate on how the session was proven rather than on "has a session"; SQL stores it as a JSON-array text column (migration 20).

## BEH-EA-050: Only `SHA-256(secret)` is persisted; the plaintext secret is never stored

> **Invariant:** [INV-EA-007](../invariants.md#inv-ea-007-a-session-secret-is-never-stored-in-plaintext-only-its-sha-256-hash)

```text
REQUIREMENT: The `Session` row MUST store `SHA-256(secret)`, never the
             secret itself; verifying a presented token MUST hash the
             presented secret and compare the hash, never compare against a
             stored plaintext value.
```

`archive/design/usage-examples-v4.md` §5.3 states the property this is designed to guarantee plainly: "a leaked table cannot authenticate." A database backup, a compromised read replica, or a misconfigured log capturing a row's contents discloses only a hash that cannot be replayed as a bearer credential — the same design goal `archive/PRD.md` §18 states for session secrets generally, alongside passwords and tokens traveling as `Redacted` end to end.

## BEH-EA-051: A session carries independent absolute and idle expiries; idle refresh never extends the absolute deadline

> **Invariant:** [INV-EA-008](../invariants.md#inv-ea-008-a-sessions-absolute-expiry-never-extends-past-its-original-value-under-sliding-idle-refresh)

```ts
type SessionConfig = { readonly absolute: Duration.Duration; readonly idle: Duration.Duration; readonly touchEvery: Duration.Duration }
```

```text
REQUIREMENT: A session's absolute expiry MUST be fixed at issuance and MUST
             NOT be extended by any subsequent activity; a session's idle
             expiry MAY be pushed forward by activity, but MUST never
             advance past the session's absolute expiry.
```

`archive/PRD.md` §13 names both deadlines as reading from `SessionConfig` together: "absolute plus idle expiry." Without the absolute ceiling, a session touched frequently enough — by a legitimate but forgotten background tab, or by an attacker automating activity — could remain valid indefinitely, which is precisely what an absolute expiry exists to rule out regardless of how the idle window behaves.

**As shipped (CSG-003, ADR-EA-033):** expiry is a read-time rejection; the row stays until `Retention.sweep` (opt-in) physically deletes it. `Sessions.purgeExpired(before)` removes every session whose absolute or idle expiry is before the cutoff, tombstoned refresh-rotation rows included, in bounded batches in both layers; the sweep passes `now - sessionGrace` (default 7 days), so reuse detection (BEH-EA-053) outlives the session's own life by the grace. `packages/core/test/Retention.test.ts` proves a live session and one still inside the grace survive.

## BEH-EA-052: Idle-window refresh is throttled to at most one write per `touchEvery`

```text
REQUIREMENT: A session's idle-refresh write MUST occur at most once per
             configured `touchEvery` interval, regardless of how many
             requests arrive within that interval.
```

`archive/design/usage-examples-v4.md` §5.3 states the default directly: "Sliding idle refresh writes at most once per `touchEvery` (default one hour)." Without this throttle, sliding-window refresh would turn every authenticated request into a session-table write, which is both an unnecessary cost under normal load and an availability risk under the request volumes a session table is expected to serve.

**Rotation delivery (PIL-005).** The throttled write also rotates the secret (there is no grace window: the old secret stops verifying immediately), so a `verify` that rotated MUST have the new secret delivered on the response to that same request — on every route style (Path A's `Authentication`, Path B's `SubjectExtractor`, see [BEH-EA-153](20-qadi-bridge-path-b.md#beh-ea-153-subjectextractor-runs-session-resolution-on-the-raw-request)) and every handler outcome, including a typed-error response. A cookie-authenticated request receives it as `Set-Cookie`; a bearer-authenticated request receives it in the `set-auth-token` header (`Api.ROTATED_TOKEN_HEADER`); both responses carry `Cache-Control: no-store`, and delivery is exactly once per rotation. A delivery failure (cookie encoding) is logged and the response returned undecorated — it never turns a response into a defect. The rotated token is a long-lived secret: request loggers and tracers MUST redact `set-auth-token` (and `x-jwt-token`) — `AuthHttp.layerRedactedHeaders` extends Effect's default `Headers.CurrentRedactedNames` with both — and proxies MUST preserve the header (MAPS-008).

## BEH-EA-053: A new session is issued — never reused — at sign-in and at privilege change; the superseded row is tombstoned atomically with the new row's insertion

```text
REQUIREMENT: Every sign-in and every privilege-changing operation
             (password change, email change) MUST issue a newly minted
             session and supersede the row it replaces, rather than
             extending or re-validating an existing session row. The
             superseded row MUST be tombstoned (RRS-003: `supersededBy`/
             `supersededAt` set, never deleted) in the same atomic unit as
             the successor's insertion — one SQL transaction in `layerSql`,
             one `Ref.modify` in `layerMemory` — so no failure or interruption
             can leave a tombstoned session without its successor.
```

`archive/design/usage-examples-v4.md` §5.3 states this directly: "A new session is issued at every sign-in and after password or email change; the old row is deleted." (Revised by RRS-003/ESR-002: the old row is now tombstoned, atomically with the new row's insertion, so a later presentation of the superseded token is detectable as reuse.) `better-auth/01-core-domain/01-entities-and-invariants.md` §2.3 documents the same rule for a related case — promoting a previously-unverified user on proof of mailbox ownership strips every pre-existing session and account, and a fresh session is minted only afterward by the caller, never by reusing whatever session happened to exist before the proof resolved.

## BEH-EA-054: Sessions expose a device list, per-device revocation, and revoke-others

```ts
yield* client.session.list()          // [{ id, createdAt, lastActiveAt, expiresAt, userAgent, current }, …]
yield* client.session.revoke({ params: { id } })
yield* client.session.revokeOthers()
```

```text
REQUIREMENT: `Sessions` MUST expose a list of a user's own live sessions
             with per-row `userAgent` and `current` metadata, MUST support
             revoking one session by id, and MUST support revoking every
             session except the caller's current one in a single operation.
```

**"Live" is exact, and lookups are keyed (ESS-005/SMS-002/TIR-003/GC-005).** The list contains exactly the sessions `verify` would still accept (modulo the secret): not tombstoned (BEH-EA-053) and past neither the absolute nor the idle expiry (BEH-EA-051) — identically in both `Layer`s, newest activity (`lastActiveAt`) first. It is exhaustive: `layerSql` drains every repository page rather than silently truncating at one (a truncated list used to drop the newest, i.e. current, session and turn `GET /session` into a 500). It is a device list, not a lookup primitive: point queries go through `Sessions.findOwned(userId, id)` (one keyed read plus ownership/tombstone/expiry checks), and revoking one session by id through `Sessions.revokeOwned(userId, id)`, which enforces ownership in the domain operation and answers an unknown and a foreign id identically (`SessionNotFound`, [BEH-EA-086](11-http-error-mapping.md)). Physical removal of expired rows is the retention sweep's job (CSG-003), not the list's.

**Device metadata is recorded at issuance (CSD-003).** Every session-minting path — password sign-up, sign-in and change-password, the OAuth callback, the passkey authenticate ceremony — MUST pass the request's client address (resolved through the `ClientAddress` port, so a trusted-proxy composition records the real client) and `User-Agent` to `Sessions.issue`, so the device list and forensics have data. `issue` caps the persisted user agent at 512 characters (`MAX_USER_AGENT_LENGTH`) at the persistence boundary, since it is a caller-supplied header.

`archive/design/usage-examples-v4.md` §5.1 is the worked example of all three operations reached through the core `session` group (BEH-EA-031): listing devices, revoking a specific one, and revoking the rest after a password change (`sessions.revokeOthers(userId, session.id)`, §5.2) — the operation BEH-EA-053's privilege-change rule is designed to trigger automatically as well as expose for a user to invoke directly.

`revoke`/`revokeOthers` racing against an already-in-flight request is a TOCTOU window this specification resolves explicitly rather than leaving to whichever database read happens to land first: a request whose `Authentication` middleware validated the session *before* the row was deleted is allowed to run to completion on the principal it already resolved — `Sessions.verify` is checked once, at middleware time, not re-checked mid-handler, so an in-flight handler is not required to abort partway through because a concurrent `revoke` call landed while it was running. Only the *next* request against that session id observes the revocation (`Sessions.verify` fails, per ADR-EA-014's "authoritative on the very next read"). This is a deliberate, bounded window — one in-flight request, never a second one, since a second request re-validates from scratch — rather than an attempt to make revocation instantaneously atomic with every already-running handler on the server, which would require a cross-request cancellation mechanism this specification does not otherwise have any use for.

## BEH-EA-055: The session cookie is `__Host-session`, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, with no `Domain` attribute

```
__Host-session=<id.secret>; Max-Age=<remaining absolute lifetime>; Secure; HttpOnly; SameSite=Strict; Path=/
```

```text
REQUIREMENT: By default the session cookie MUST be named with the `__Host-`
             prefix, MUST carry `Secure`, `HttpOnly`, and `SameSite=Strict`,
             MUST set `Path=/`, and MUST NOT set a `Domain` attribute. A
             deployment MAY opt into one of a closed set of typed modes via
             `SessionCookieConfig` (below); every site that issues or rotates
             the cookie MUST render it through the one shared renderer, so no
             site can drift from another.
```

**Secure default, typed opt-in modes (IC-007, AGA-004, BO-005).** `SessionCookieConfig` is a `Context.Reference` whose default is exactly the attribute set above (plus `Max-Age`). Its `mode` is a closed union and illegal combinations are unrepresentable — only `SecureDomain` carries a `domain`, and it renders a different prefix:

- `Host` (default): `__Host-session`, `SameSite=Strict`, no `Domain`.
- `HostEmbedded` (AGA-004): for a third-party-iframe deployment. `__Host-` is kept (CHIPS recommends it for `Partitioned` cookies) but the cookie is `SameSite=None; Partitioned`, and the `__Host-csrf` double-submit cookie follows suit. This trades away `SameSite=Strict`, so the CSRF double-submit middleware ([BEH-EA-073](10-csrf.md#beh-ea-073-sec-fetch-site-is-the-primary-csrf-signal)–078) — already mandatory for cookie auth — is the only cross-site defence.
- `SecureDomain({ domain, sameSite })` (IC-007): `__Secure-session` with a `Domain` for a multi-subdomain app (`__Host-` forbids `Domain`). `sameSite` is required, not defaulted. Readers (`Authentication`'s cookie handler, `SubjectExtractor`, the legacy-cookie alias middleware) resolve the configured name; the CSRF cookie stays host-only. `@awthaq/next` renders and reads under the default config only.

`persistence` (BO-005) is `absolute` by default — `Max-Age` is the session's remaining absolute lifetime, recomputed at issuance and at every rotation (so it shrinks toward the absolute expiry and is never negative), so closing the browser does not log a user out of a 30-day session — or `browserSession`, which omits `Max-Age`.

`archive/design/usage-examples-v4.md` §5.3 and `archive/PRD.md` §18 both fix this exact attribute set as a secure default requiring no configuration: the `__Host-` prefix is itself an enforcement mechanism (browsers refuse to accept such a cookie unless it also satisfies `Secure`, `Path=/`, and no `Domain`), so misconfiguring any of the other attributes away from their secure defaults is designed to make the cookie simply not set, rather than silently set it insecurely.

**The cookie is expired when the caller's own session ends (CSS-002).** Every response that ends the caller's own session MUST also expire `__Host-session` (empty value, `Max-Age=0`, epoch `Expires`, with `Secure` and `Path=/` so a browser accepts the write): `signOut`, `revokeAll`, `revoke` when the target is the caller's current session, account deletion, and the "current session vanished" `401` on `GET /session` (EHA-009). Revoking a *different* session leaves the cookie intact. A handler-written session cookie (this expiry, a fresh sign-in) takes precedence over a rotated secret delivered for the same request (BEH-EA-052).

## BEH-EA-056: Session-secret verification is a constant-time comparison over a fixed-length hash

```text
REQUIREMENT: Verifying a presented session secret MUST compare
             `SHA-256(presented secret)` against the stored hash using a
             constant-time equality check (`Crypto.digest` equality on
             fixed-length hashes), never a comparison whose timing can vary
             with how many leading bytes match.
```

`archive/PRD.md` §18 states this directly among the security-model guarantees: "constant-time comparison via `Crypto.digest` equality on fixed-length hashes." A variable-time comparison (an ordinary string or buffer equality that short-circuits on the first mismatched byte) leaks timing information an attacker can use to recover a secret byte-by-byte; fixing both operands to the same hash length and comparing them in constant time removes that channel regardless of what the underlying secret's actual length or content is.

**Proof precedes state (PIL-007).** The `id` half is public — it appears in cookies, JWT `sid` claims and error messages — so `verify` MUST prove the presented secret (hash + constant-time compare, against a fixed dummy hash when the id is unknown) *before* evaluating any row state. Consequently: an id-only caller always receives the uniform `SessionNotFound` (never `SessionExpired`, so expiry state is not disclosed), and BEH-EA-053's reuse detection (family revocation and `auth.session.reuse`) fires only when the presented token carries the superseded row's correct secret — forging `<supersededId>.<anything>` revokes nothing.

_Previous: [BEH-EA-048](06-domain-users-accounts.md#beh-ea-048-a-plugin-contributed-field-on-user-or-account-defaults-to-client-writable-unless-the-plugin-declares-otherwise)_
_Next: [BEH-EA-057](08-verification-tokens.md#beh-ea-057-a-verification-token-is-scoped-to-one-purpose)_

## BEH-EA-258: A session's authentication facts reach the policy layer as attributes

> **See:** [ADR-EA-021](../decisions/021-sms-otp-restricted-plugin.md), [ADR-EA-012](../decisions/012-slots-exclusive-registries-aggregate.md)

```ts
Assurance.assuranceLevel(amr): "aal1" | "aal2" | "aal3"
Assurance.assurance(amr): { level, restricted }
Assurance.satisfies(amr, required, { allowRestricted? }): boolean
// AuthSubject.attributes: { amr, authenticatedAt, aal, restrictedFactor, actingAs? }
// UserPrincipal.authenticatedAt: epoch seconds; JWT claims: amr, auth_time
```

```text
REQUIREMENT: How a session was authenticated MUST reach an authorization
             policy without the policy re-deriving it. The resolved
             `UserPrincipal` MUST carry the session's `amr` and
             `authenticatedAt` (epoch seconds, the OIDC `auth_time`
             convention); the default `SubjectResolver` — and any overriding
             resolver, through the shared `principalAttributes` — MUST place
             `amr` (empty when nothing was recorded), `authenticatedAt`, the
             derived `aal` and `restrictedFactor` on `AuthSubject.attributes`;
             and a principal JWT MUST carry `amr` and `auth_time` when the
             session recorded them. `aal` MUST be derived by one pure
             function that never guesses a stronger level than the recorded
             methods prove, MUST count factors by class (two possession
             methods are one factor), MUST NOT raise a session above aal1 on
             `sms` alone, and MUST flag a restricted factor.
```

The mapping (NIST SP 800-63B): knowledge (`pwd`) and possession (`hwk`, `swk`, `otp`, `sms`, `email`) are different classes; a key method with user verification (`user`) is a multi-factor authenticator; `mfa` states multiple factors outright; `fed` counts for nothing (a federated sign-in is as strong as the identity provider says, which awthaq cannot see). aal3 needs a hardware-bound key with user verification (`hwk` + `user`). A passkey session records `hwk` for a device-bound credential and `swk` for a synced one, plus `user` when the authenticator verified the user (HSK-005), so a policy can require `amr contains "hwk"`. A password plus SMS reaches aal2 nominally but `Assurance.satisfies` ignores a restricted factor unless the caller opts in. A policy states `hasAttribute("aal", oneOf("aal2", "aal3"))` instead of enumerating method combinations.
