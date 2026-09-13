# API Key Plugin — Alternate-Credential Authentication and Permission Scoping

> Builds on `01-access-control.md` (the `authorize` arrow is reused
> verbatim at verify-time — not reimplemented) and
> `03-organization-plugin.md` (organization-owned keys borrow that
> plugin's `hasPermission` wholesale, including its creator-role bypass —
> not reimplemented here either). Also builds on the core session
> contract of `01-core-domain/`: this document's central claim is that an
> API key is an ALTERNATE CREDENTIAL that produces an authorization
> context equivalent to a session's, not a parallel concept living beside
> it.

---

## 1. Entity model and lifecycle

```
┌─────────────────────────────────────────────────────────────────────┐
│                             ApiKey                                    │
│                                                                        │
│  id, configId, name?, prefix?, start?                                 │
│  key            — HASHED at rest (unless hashing explicitly disabled) │
│  referenceId    — the owning user id, or organization id, depending   │
│                    on this key's configuration's `references` setting │
│  enabled, expiresAt?                                                  │
│  remaining?, refillAmount?, refillInterval?, lastRefillAt?            │
│  rateLimitEnabled, rateLimitTimeWindow?, rateLimitMax?, requestCount, │
│  lastRequest?                                                          │
│  permissions?   — a resource -> action[] map, checked via the SAME    │
│                    `authorize` arrow as 01-access-control.md §2       │
│  metadata?                                                             │
└─────────────────────────────────────────────────────────────────────┘

                        LIFECYCLE STATE DIAGRAM

   create ──▶ ┌──────────┐   verify (ok)    ┌──────────┐
              │ enabled,  │◀────────────────▶│  in use   │  (transient —
              │  live      │                  │           │   not a
              └────┬─────┘                    └──────────┘   stored state,
                    │                                          shown for
        update      │ update(enabled:false)                    clarity)
      (non-terminal)│
                    ▼
              ┌──────────┐
              │ disabled  │──update(enabled:true)──▶ back to enabled
              └──────────┘

     from ANY state:
        expiresAt elapses      ──▶ verify() rejects (KEY_EXPIRED) AND
                                    opportunistically DELETES the row —
                                    an expired key self-destructs on its
                                    first post-expiry use, it does not
                                    merely report invalid forever after.
        remaining reaches 0
        AND no refill configured ──▶ verify() rejects (USAGE_EXCEEDED)
                                      AND deletes the row — an exhausted,
                                      non-refillable key also
                                      self-destructs on first use past
                                      exhaustion.
        remaining reaches 0
        WITH refill configured    ──▶ verify() rejects (USAGE_EXCEEDED)
                                       but the row SURVIVES — the next
                                       verify() after the refill interval
                                       elapses tops `remaining` back up
                                       to `refillAmount` before consuming
                                       one unit for that call.
        delete (explicit)         ──▶ permanently removed; no soft-delete
                                       state exists — a subsequent
                                       verify() against the same raw key
                                       fails closed (INVALID_API_KEY /
                                       KEY_NOT_FOUND), identically to a
                                       key that never existed.
```

---

## 2. Configuration model

An installation may define one or more named **configurations**
(`configId`), each independently controlling: which header carries the
key, whether hashing is disabled (discouraged), key length/prefix/name
constraints, expiration bounds, default rate-limit, storage backend
(`database`, or `secondary-storage` with optional database fallback),
what a key's `permissions` default to when unspecified, and — the setting
most relevant here — **`references`**: whether a key under this
configuration is owned by a `"user"` (default) or by an
`"organization"`. This single setting is what determines, for every
contract below, which plugin's permission system governs the key: a
user-owned key's issuance/management is gated by the caller's own
session identity alone; an organization-owned key's issuance/management
is gated by `03-organization-plugin.md`'s `hasPermission`, under a
resource named `apiKey` that a deployer must add to their organization's
access-control universe (per `01-access-control.md §3` — it is not part
of the organization plugin's own default statements).

---

## 3. Issuance contract (`create`)

```
Operation:  createApiKey

Requires:
  - Client/server trust boundary (checked BEFORE any permission logic,
    and independent of it): a call arriving through the client-facing
    surface (a request/headers is present) may NEVER set any of:
    refillAmount, refillInterval, rateLimitMax, rateLimitTimeWindow,
    rateLimitEnabled, permissions, a non-null `remaining`, or an
    explicit `userId`. Presence of ANY of these on a client-originated
    call is rejected outright, independent of the caller's own
    permissions or role — this is a capability boundary between
    "server code embedding better-auth" and "anything reachable over
    the network," not a role check.
  - Ownership/authentication, by `references` type:
      - `"user"` (default): an authenticated session is required for a
        client-originated call; a server-side (no request/headers)
        call may instead supply an explicit `userId` directly.
        Session resolution is FORCED to bypass the cookie-cache and hit
        the authoritative session store — issuing a key mints a
        long-lived credential, so a just-revoked session (including one
        revoked by `banUser`, `02-admin-plugin.md §3.6`) must not still
        be able to mint one within the cookie-cache's staleness window.
      - `"organization"`: an explicit `organizationId` is required, and
        the acting user must be a member of it AND authorized for
        `apiKey:create` under that organization's `hasPermission`
        (`03-organization-plugin.md §4`), including that plugin's
        creator-role bypass (`allowCreatorAllPermissions: true` is set
        for this check specifically).
  - Field-level constraints: `expiresIn` (if custom expiration is not
    disabled for this configuration) within the configured min/max day
    bounds; `prefix`/`name` lengths within configured bounds (`name`
    additionally required if `requireName` is set); `metadata` an
    object, and only accepted if this configuration enables metadata;
    `refillAmount` and `refillInterval` must be supplied TOGETHER or not
    at all (one without the other is rejected).

Ensures:
  - A freshly generated secret is returned EXACTLY ONCE, in this
    response only — it is never again retrievable in plaintext from
    `get`, `list`, or `update`. This is a write-once-read-never
    invariant on the credential material itself: the stored record
    keeps only a hash of it (unless the deployer has explicitly disabled
    hashing, a discouraged escape hatch), plus optionally a small,
    non-secret prefix of the plaintext for UI display purposes.
  - Every quota/rate-limit/expiration field left unspecified is filled
    from the resolved configuration's defaults, not left null-by-omission.

Invariant (scoping — the Liskov-style narrowing rule):
  A created key's `permissions`, when present, are intended to describe
  a SUBSET of what the issuing actor may itself do — formally, using
  the substitution vocabulary of
  `00-methodology/01-design-by-contract.md §5`:

     keyPermissions' ⟸ actorPermissions

  i.e. a request that `authorize()` (§01 §2) would grant against the
  key's own stored permissions must also be a request the issuing
  actor's own role would have granted, at the moment of issuance. This
  is the CORRECT design target and the one this document specifies as
  the contract to hold.

  What the reference implementation actually enforces is weaker: because
  `permissions` can only ever be supplied by a caller that has already
  cleared the client/server trust boundary above (a trusted, server-side
  caller — never the client-facing endpoint), the reference
  implementation DELEGATES enforcement of the subset relationship to
  that trusted caller. `createApiKey` itself performs no structural
  cross-check of the requested `permissions` map against the acting
  principal's own session-level or organization-level permission set.
  This is an explicit design decision point for a reimplementation, not
  a detail to silently inherit: an Effect-native port should decide
  whether `createApiKey`'s postcondition includes a hard, structural
  proof of `keyPermissions' ⟸ actorPermissions` (rejecting an
  over-broad request rather than trusting the caller), or whether it
  continues to treat "may this caller set permissions at all" (the trust
  boundary) as sufficient and leaves the subset relationship as a
  caller-side obligation, undocumented in code but binding in practice.

On violation:
  - A server-only field set on a client-originated call: BAD_REQUEST,
    blamed CLIENT (the calling application/browser, for exceeding what
    the client-facing surface is allowed to request — not the end user).
  - Missing membership/permission for an organization-owned key:
    FORBIDDEN, blamed CLIENT, per `03-organization-plugin.md §4`.
  - Field-constraint violations (expiry bounds, name/prefix length):
    BAD_REQUEST, blamed CLIENT.
```

---

## 4. Verification contract (`verify`, and the equivalent before-hook)

```
Operation:  validateApiKey
Arrow shape: (rawKey: string, requestedPermissions?: PermissionRequest)
             -> { valid: true, key: ApiKey } | { valid: false, error }

Requires:   `rawKey` is a string of at least the configured key length
            for whichever configuration is being checked against.

Ensures — an ORDERED sequence of independent preconditions, each of
which is itself "this credential currently authorizes its holder":

  1. The key resolves, by hash lookup, to a stored record. Otherwise:
     INVALID_API_KEY.
  2. The record's `enabled` flag is true. Otherwise: KEY_DISABLED.
  3. The record is not past `expiresAt`. Otherwise: KEY_EXPIRED, AND
     (see §1's lifecycle diagram) the expired record is deleted as a
     side effect of this same failed verification.
  4. IF this verification supplied `requestedPermissions`: the key's
     OWN stored `permissions` map must authorize that exact request via
     `authorize()` from `01-access-control.md §2` — the identical
     primitive, unmodified. A key with NO stored permissions map at all
     can never satisfy a scoped verification (fails closed —
     KEY_NOT_FOUND), even though the same key remains fully usable for
     an UNSCOPED verification (one that asks no `requestedPermissions`
     at all). Scoping is therefore opt-in per verify call, not a
     property the key can be inspected for independently.
  5. Quota and rate-limit are consumed ATOMICALLY as a single guarded
     step: exactly one of — the request proceeds and `remaining`/
     `requestCount` are incremented under a concurrency-safe guard that
     never allows either counter to cross its configured bound even
     under concurrent verifications of the same key — or the request is
     rejected (USAGE_EXCEEDED / RATE_LIMIT_EXCEEDED) with the stored
     counters left EXACTLY as they were (a rejected verification is
     never partially charged). A key that reaches zero `remaining` with
     no refill configured is deleted outright as part of this step (see
     §1).
     Refill sub-rule: when `refillInterval`/`refillAmount` are
     configured and the interval has elapsed since the last refill (or
     since creation, if never refilled), the FIRST verification past
     that boundary resets `remaining` to `refillAmount` (a top-up, not
     necessarily restoring any prior higher watermark) before consuming
     one unit for the current call; concurrent verifications racing the
     same boundary are guarded so the refill is applied exactly once.

Invariant:
  - Every check above is independent and ordered — a disabled key is
    rejected before its expiry is even considered; an expired key is
    rejected before its permissions are checked; a permission failure is
    reported before quota is touched. No check is skipped because a
    later one would also have failed.
```

```
        SEQUENCE: a request carrying an API key becomes a session

   client                 before-hook               validateApiKey        downstream endpoint
     │                        │                          │                       │
     │ GET /some/route         │                          │                       │
     │ x-api-key: sk_live_...  │                          │                       │
     ├─────────────────────────▶│                          │                       │
     │                        │ header configured for      │                       │
     │                        │ session-mocking?           │                       │
     │                        │ ── yes ─────────────────────▶ hash, lookup,          │
     │                        │                          │   enabled/expiry/        │
     │                        │                          │   permission/quota       │
     │                        │                          │   checks (above)         │
     │                        │◀── ApiKey record ─────────┤                       │
     │                        │  references == "user"?    │                       │
     │                        │  (organization-owned keys │                       │
     │                        │   CANNOT mock a session — │                       │
     │                        │   rejected here)           │                       │
     │                        │  synthesize session:        │                       │
     │                        │    user = referenced user   │                       │
     │                        │    session.id/token = key id│                       │
     │                        │    expiresAt = key's own,   │                       │
     │                        │      else default lifetime  │                       │
     │                        │  ctx.context.session = ...──┼──────────────────────▶│
     │                        │                          │                       │  sees a session
     │                        │                          │                       │  indistinguishable
     │                        │                          │                       │  in shape from a
     │                        │                          │                       │  cookie session
     │◀──────────────────────────────────────────────────────────────────────────┤
```

---

## 5. Session-equivalence contract (cross-reference to core domain)

```
Requires (opt-in): the matched configuration has
  `enableSessionForAPIKeys: true` (default false — an explicit,
  per-configuration opt-in, never ambient) AND `references: "user"`
  (an organization-owned key can authenticate a request for permission
  purposes via `checkOrgApiKeyPermission`, but it never synthesizes a
  user-shaped session — INVALID_REFERENCE_ID_FROM_API_KEY otherwise).

Ensures: for the remainder of the request, `session.user` is the
  referenced user's full record, `session.session.id`/`.token` are the
  API key's own id/raw value (not an opaque session token), and
  `session.session.expiresAt` is the key's own `expiresAt` if set, else
  a default session lifetime.

Invariant: from the perspective of every consumer OTHER than the
  authentication layer itself — every permission check in
  `01`/`02`/`03`, `getSession`, every organization-membership lookup —
  an API-key-derived request context and a cookie-derived one are
  INDISTINGUISHABLE in shape: the same `can(actor, action, resource)`
  decisions apply, using the same actor identity. They diverge only in
  PROVENANCE:
    - the backing record lives in the API-key store, not the session
      store, so it is invisible to session-listing/revocation endpoints
      that only ever query the session table (`02-admin-plugin.md §3.9`'s
      `listUserSessions`/`revokeUserSessions` do not see or touch API
      keys, and vice versa — the two credential kinds are managed
      through entirely separate lifecycle endpoints, even though they
      produce equivalent authorization contexts);
    - the "session" token IS the credential's raw secret, not a separate
      opaque value — revoking the credential (§7) is therefore the ONLY
      way to invalidate this authorization context; there is no
      independent session-level revocation layered on top of it.
  This is the precise sense in which an API key is "an alternate
  credential producing an equivalent authorization context" rather than
  a parallel, unrelated concept: everything downstream of authentication
  is shared machinery; only how the actor got authenticated differs.
```

---

## 6. Rotation contract

```
better-auth does not expose a single "rotate" primitive. Rotation is
compositional, built from two already-specified operations:

   create (new key)  ─▶  caller migrates consumers to the new secret  ─▶  delete (old key)

Invariant: deletion (§7) is immediate and unconditional — there is no
  grace/overlap period, and no stored link between an old key and its
  replacement. Safe rotation is therefore ENTIRELY the caller's
  responsibility to sequence correctly (issue the new key, confirm every
  consumer has adopted it, only THEN delete the old one). This is an
  explicit absence in the reference implementation, not an oversight to
  silently paper over in a reimplementation: a from-scratch design may
  choose to add an atomic two-key handover primitive (e.g. a key that is
  "superseded" but still valid for a bounded overlap window); better-auth,
  as specified here, does not have one.
```

---

## 7. Revocation contract (`delete`)

```
Operation:  deleteApiKey

Requires:   ownership: for a user-owned key, `referenceId` must equal
            the caller's own user id; for an organization-owned key,
            the caller must be a member of the owning organization AND
            authorized for `apiKey:delete` there
            (`03-organization-plugin.md §4`, creator-bypass included).
            ADDITIONALLY, specific to this endpoint (defense in depth,
            beyond ordinary session validity): the caller's session
            user must not currently be banned.

Ensures:    the key is permanently and unconditionally removed from its
            backing store (the database row, the secondary-storage
            entry, or both when a fallback is configured) — there is no
            soft-delete/tombstone state.

Invariant:  after this call, ANY subsequent verification attempt
            (§4) against the deleted key's raw value fails closed
            (INVALID_API_KEY / KEY_NOT_FOUND) — identically to a key
            that never existed. Any authorization context synthesized
            from it (§5) is therefore unusable from this point forward;
            there is no independent "session" to separately revoke.
```

---

## 8. Update contract

```
Operation:  updateApiKey

Requires:   the SAME ownership/permission gates as delete (§7); the SAME
            client/server-only field partition as create (§3) — a
            client-originated call may not touch refillAmount,
            refillInterval, rateLimitMax, rateLimitTimeWindow,
            rateLimitEnabled, remaining, or permissions; at least one
            field must actually be supplied (an empty update body is
            itself a precondition violation — NO_VALUES_TO_UPDATE).

Ensures:    only the fields explicitly present in the request are
            merged into the stored record; everything else is left
            untouched.

Invariant:  changing `permissions` on an EXISTING key is subject to the
            identical, currently-unenforced narrowing caveat described
            in §3's Invariant — it is a server-only mutation, and the
            same design decision (whether to structurally enforce
            `keyPermissions' ⟸ actorPermissions`, or continue trusting
            the caller) applies equally here, at update time, as at
            creation time.
```

---

## 9. Read contracts (`get`, `list`)

```
Requires:   the same ownership/permission gates as delete (§7) —
            `get` and `list` are read operations, not exempt from the
            authorization boundary.

Ensures:    the raw key secret is NEVER included in a get/list
            response — it is stripped from the returned shape even
            though the (hashed, or in the discouraged case, plaintext)
            value is retained in storage. This is a structural
            invariant on the ApiKey entity's OUTPUT shape, independent
            of and stricter than its STORAGE shape: the write-once-
            read-never property of the secret (§3) applies to every
            read path, not only to the ones a careless reimplementation
            might think to guard.
```

---

## 10. Maintenance: expired-key sweep

```
Operation:  deleteAllExpiredApiKeys (also exposed as its own server-only
            endpoint)

Ensures:    every record past its `expiresAt` is removed in bulk.

Invariant:  this is pure housekeeping, not a correctness precondition
            for anything else in this document — `validateApiKey` (§4)
            already independently detects and self-heals a single
            expired key on its own hot path the moment it is used past
            expiry. The sweep exists to reclaim storage for keys that
            expire WITHOUT ever being used again, and is throttled
            (via a last-run timestamp) rather than run unconditionally
            on every request.
```
