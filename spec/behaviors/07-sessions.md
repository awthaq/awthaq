# Sessions

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-07 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | effect-auth Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Added a cross-reference to ADR-EA-014 (session storage backend neutrality) and a note on the revoke/in-flight-request TOCTOU window (CCR-EA-002) |

---

> effect-auth is pre-implementation (see `spec/README.md`). Every signature, requirement, and behavior in this file specifies intended design — drawn from `archive/PRD.md` §13 and `archive/design/usage-examples-v4.md` §5 — not code that has shipped.

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

## BEH-EA-052: Idle-window refresh is throttled to at most one write per `touchEvery`

```text
REQUIREMENT: A session's idle-refresh write MUST occur at most once per
             configured `touchEvery` interval, regardless of how many
             requests arrive within that interval.
```

`archive/design/usage-examples-v4.md` §5.3 states the default directly: "Sliding idle refresh writes at most once per `touchEvery` (default one hour)." Without this throttle, sliding-window refresh would turn every authenticated request into a session-table write, which is both an unnecessary cost under normal load and an availability risk under the request volumes a session table is expected to serve.

## BEH-EA-053: A new session is issued — never reused — at sign-in and at privilege change; the superseded row is deleted

```text
REQUIREMENT: Every sign-in and every privilege-changing operation
             (password change, email change) MUST issue a newly minted
             session and delete the row it supersedes, rather than
             extending or re-validating an existing session row.
```

`archive/design/usage-examples-v4.md` §5.3 states this directly: "A new session is issued at every sign-in and after password or email change; the old row is deleted." `better-auth/01-core-domain/01-entities-and-invariants.md` §2.3 documents the same rule for a related case — promoting a previously-unverified user on proof of mailbox ownership strips every pre-existing session and account, and a fresh session is minted only afterward by the caller, never by reusing whatever session happened to exist before the proof resolved.

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

`archive/design/usage-examples-v4.md` §5.1 is the worked example of all three operations reached through the core `session` group (BEH-EA-031): listing devices, revoking a specific one, and revoking the rest after a password change (`sessions.revokeOthers(userId, session.id)`, §5.2) — the operation BEH-EA-053's privilege-change rule is designed to trigger automatically as well as expose for a user to invoke directly.

`revoke`/`revokeOthers` racing against an already-in-flight request is a TOCTOU window this specification resolves explicitly rather than leaving to whichever database read happens to land first: a request whose `Authentication` middleware validated the session *before* the row was deleted is allowed to run to completion on the principal it already resolved — `Sessions.verify` is checked once, at middleware time, not re-checked mid-handler, so an in-flight handler is not required to abort partway through because a concurrent `revoke` call landed while it was running. Only the *next* request against that session id observes the revocation (`Sessions.verify` fails, per ADR-EA-014's "authoritative on the very next read"). This is a deliberate, bounded window — one in-flight request, never a second one, since a second request re-validates from scratch — rather than an attempt to make revocation instantaneously atomic with every already-running handler on the server, which would require a cross-request cancellation mechanism this specification does not otherwise have any use for.

## BEH-EA-055: The session cookie is `__Host-session`, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, with no `Domain` attribute

```
__Host-session=<id.secret>; Secure; HttpOnly; SameSite=Strict; Path=/
```

```text
REQUIREMENT: The session cookie MUST be named with the `__Host-` prefix,
             MUST carry `Secure`, `HttpOnly`, and `SameSite=Strict`, MUST
             set `Path=/`, and MUST NOT set a `Domain` attribute.
```

`archive/design/usage-examples-v4.md` §5.3 and `archive/PRD.md` §18 both fix this exact attribute set as a secure default requiring no configuration: the `__Host-` prefix is itself an enforcement mechanism (browsers refuse to accept such a cookie unless it also satisfies `Secure`, `Path=/`, and no `Domain`), so misconfiguring any of the other attributes away from their secure defaults is designed to make the cookie simply not set, rather than silently set it insecurely.

## BEH-EA-056: Session-secret verification is a constant-time comparison over a fixed-length hash

```text
REQUIREMENT: Verifying a presented session secret MUST compare
             `SHA-256(presented secret)` against the stored hash using a
             constant-time equality check (`Crypto.digest` equality on
             fixed-length hashes), never a comparison whose timing can vary
             with how many leading bytes match.
```

`archive/PRD.md` §18 states this directly among the security-model guarantees: "constant-time comparison via `Crypto.digest` equality on fixed-length hashes." A variable-time comparison (an ordinary string or buffer equality that short-circuits on the first mismatched byte) leaks timing information an attacker can use to recover a secret byte-by-byte; fixing both operands to the same hash length and comparing them in constant time removes that channel regardless of what the underlying secret's actual length or content is.

_Previous: [BEH-EA-048](06-domain-users-accounts.md#beh-ea-048-a-plugin-contributed-field-on-user-or-account-defaults-to-client-writable-unless-the-plugin-declares-otherwise)_
_Next: [BEH-EA-057](08-verification-tokens.md#beh-ea-057-a-verification-token-is-scoped-to-one-purpose)_
