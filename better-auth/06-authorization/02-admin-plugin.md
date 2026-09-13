# Admin Plugin — Administrative Capability Contracts

> Builds on `01-access-control.md` (the `authorize` arrow and the
> statement/role vocabulary — not restated here) and on the core session
> and user-entity invariants from `01-core-domain/` (referenced, not
> restated: this document specifies only what admin capabilities add on
> top of them).

The admin plugin is a single, fixed **instantiation** of the primitive
from `01-access-control.md`: one statements universe, two default roles.
Every administrative capability below is specified as an authorization
precondition (who may call it) plus a postcondition on the *target*
user's/session's entity invariants — never the caller's own.

---

## 1. The role/permission model

```
┌────────────────────────────────────────────────────────────────────┐
│                    ADMIN STATEMENTS UNIVERSE                        │
│                                                                       │
│   user:    create, list, set-role, ban, impersonate,                 │
│            impersonate-admins, delete, set-password,                 │
│            set-email, get, update                                    │
│                                                                        │
│   session: list, revoke, delete                                      │
└────────────────────────────────────────────────────────────────────┘

              default "admin" role         default "user" role
        ┌───────────────────────────┐  ┌───────────────────────────┐
        │ user:    create   ✓        │  │ user:    create   ✗       │
        │          list     ✓        │  │          list     ✗       │
        │          set-role ✓        │  │          set-role ✗       │
        │          ban      ✓        │  │          ban      ✗       │
        │          impersonate ✓     │  │          impersonate ✗    │
        │          impersonate-      │  │          impersonate-     │
        │            admins  ✗ ★     │  │            admins  ✗      │
        │          delete   ✓        │  │          delete   ✗       │
        │          set-password ✓    │  │          set-password ✗   │
        │          set-email ✓       │  │          set-email ✗      │
        │          get      ✓        │  │          get      ✗       │
        │          update   ✓        │  │          update   ✗       │
        │ session: list     ✓        │  │ session: list     ✗       │
        │          revoke   ✓        │  │          revoke   ✗       │
        │          delete   ✓        │  │          delete   ✗       │
        └───────────────────────────┘  └───────────────────────────┘

  ★ `impersonate-admins` is declared in the universe but granted to
    NEITHER default role. Even the default "admin" role cannot impersonate
    another admin unless a deployer explicitly grants that action (or sets
    the deprecated blanket escape hatch — see §5). This is deliberate: the
    universe declares more than any default role grants, by design.
```

A deployer may replace the whole universe and both default roles via
`ac`/`roles` (per `01-access-control.md §3`); everything below assumes
whichever roles are in effect, default or custom.

---

## 2. The admin `hasPermission` contract

```
hasPermission : ActorDescriptor -> boolean

  where ActorDescriptor = {
    userId?, role?, options: AdminOptions,
    permissions: PermissionRequest        (see 01-access-control.md §2)
  }

Requires:
  - `permissions` is a well-formed PermissionRequest (01 §2).

Ensures:
  1. If `userId` is present AND is listed in `options.adminUserIds`:
     returns true UNCONDITIONALLY — this bypasses the statement/role
     check entirely. `adminUserIds`, when configured, makes the named
     users superusers for every admin capability regardless of their
     stored `role` or its granted statements. (If `adminUserIds` is set
     at all, it is documented to make the ordinary `adminRoles` option
     irrelevant for those users specifically.)
  2. Otherwise, `role` (or, if absent, `options.defaultRole`, default
     "user") is split on "," — an actor may hold multiple role names
     simultaneously. For each held role name, resolve it against
     `options.roles` merged over the plugin's default roles, and delegate
     to that Role's `authorize(permissions)` (01 §2). Returns true if ANY
     held role authorizes; false if none do, or if `permissions` itself
     is absent/empty.

Invariant:
  - This function is a pure, synchronous predicate over its inputs plus
    the (already-resolved) role objects — no I/O. Every admin endpoint
    below evaluates it fresh, per call, against the CALLER's own role,
    before touching the target entity.
```

```
                    SEQUENCE: an admin capability call
   client                admin endpoint            hasPermission        target entity
     │                        │                          │                    │
     │  POST /admin/ban-user  │                          │                    │
     ├───────────────────────▶│                          │                    │
     │                        │ resolve authoritative     │                    │
     │                        │ session (adminMiddleware) │                    │
     │                        │                          │                    │
     │                        │  hasPermission({          │                    │
     │                        │   userId, role, options,  │                    │
     │                        │   permissions:{user:[ban]}│                    │
     │                        │  }) ─────────────────────▶│                    │
     │                        │                          │ adminUserIds? role  │
     │                        │                          │ authorize()?        │
     │                        │◀─────────────────────────┤ boolean             │
     │                        │                          │                    │
     │                 false  │                          │                    │
     │◀── 403 FORBIDDEN ──────┤                          │                    │
     │                        │                          │                    │
     │                  true  │  additional precondition  │                    │
     │                        │  checks (e.g. not self) ─────────────────────▶│
     │                        │                          │   mutate + cascade  │
     │                        │◀─────────────────────────────────────────────┤
     │◀── 200 + updated view ─┤                          │                    │
```

---

## 3. Per-capability contracts

Every endpoint below first requires a valid, authoritative session (the
caller must be authenticated at all — this is the core session contract,
not restated) and then the specific `hasPermission` check named. "Target"
always denotes the user/session named in the request body, distinct from
the caller.

### 3.1 `setRole`

```
Requires:  caller authorized for user:set-role.
           If `options.roles` is a fixed, configured catalog, every
           requested role name must be a key of that catalog.
           Target user must exist.
Ensures:   target.role is REPLACED (not merged) with the comma-joined
           new role list.
Invariant: the target's existing sessions are not revoked by a role
           change — they remain valid; the new role governs every
           permission check performed against fresh reads of the user
           record from this point on.
On violation: FORBIDDEN (blamed CLIENT — caller lacks set-role) or
           BAD_REQUEST for an unknown role name (blamed CLIENT) or
           NOT_FOUND for a missing target (blamed CLIENT).
```

### 3.2 `getUser` / `listUsers` / `listUserSessions`

```
Requires:  caller authorized for user:get / user:list / session:list
           respectively.
Ensures:   read-only; returns the target user/users/sessions unchanged.
```

### 3.3 `createUser`

```
Requires:  - If a session is present: user:create.
           - If the request additionally names a role (top-level `role`
             or a `role` key nested in `data`): ADDITIONALLY
             user:set-role, and each named role must exist in the
             configured role catalog if one is configured.
           - If the request additionally sets any of
             banned/banReason/banExpires (nested in `data`):
             ADDITIONALLY user:ban.
           - If NO session is present at all (a trusted server-side
             call with neither a session nor request headers): every
             permission check above is skipped — this endpoint's
             session-based gate is a client/HTTP-surface gate, not an
             unconditional one.
Ensures:   a new user is created with the requested (or default) role;
           a credential account is linked only if a password was
           supplied — a passwordless admin-created user is legitimate
           (e.g. for magic-link/social-only sign-in).
Invariant: gating is PER-FIELD, not per-endpoint — supplying `role` or
           ban fields alongside an otherwise-plain user:create request
           layers additional, independent preconditions onto the same
           call rather than requiring a separate endpoint.
On violation: FORBIDDEN for each missing per-field permission (blamed
           CLIENT); BAD_REQUEST for an invalid role or a duplicate email
           (blamed CLIENT).
```

### 3.4 `adminUpdateUser`

```
Requires:  - user:update, always.
           - Touching `data.role`: ADDITIONALLY user:set-role (+ role
             catalog validation, same as setRole).
           - Touching any of data.banned/banReason/banExpires:
             ADDITIONALLY user:ban; if setting banned=true on the
             CALLER's own id, rejected regardless of permission
             (self-ban is never permitted through this path either).
           - Touching data.email or data.emailVerified: ADDITIONALLY
             user:set-email (+ new email format/uniqueness validated
             against every other user).
           - `data.password` is ALWAYS rejected here, independent of any
             permission — password changes are the sole responsibility
             of `setUserPassword` (§3.7); this endpoint never touches
             stored credential material.
           - `data` must be non-empty.
Ensures:   only the fields for which the per-field precondition was
           satisfied are ever persisted. Setting banned=true here
           carries the SAME compound postcondition as `banUser` (§3.6):
           the target's sessions are also revoked, atomically with the
           flag update — banning is never just a flag write, through
           either path.
Invariant: per-field gating, identical in spirit to createUser (§3.3) —
           one endpoint, several independently-required capabilities
           depending on which fields are present in the request.
```

### 3.5 `unbanUser`

```
Requires:  caller authorized for user:ban.
Ensures:   target.banned=false, banReason=null, banExpires=null.
Invariant: does NOT restore sessions that were revoked at ban time —
           un-banning only changes eligibility for FUTURE session
           creation; it is not a session-level undo.
```

### 3.6 `banUser`

```
Requires:  caller authorized for user:ban; target != caller (banning
           yourself is rejected unconditionally, independent of
           permission).
Ensures:   COMPOUND postcondition, both parts atomic to this call:
             (a) target.banned=true, banReason set (request-supplied,
                 else `options.defaultBanReason`, else "No reason"),
                 banExpires set (request-supplied duration, else
                 `options.defaultBanExpiresIn`, else permanent/null —
                 explicitly null, not left stale from any prior ban);
             (b) EVERY existing session of the target is deleted.
           A ban is a flag change plus a forced global sign-out of the
           target, never one without the other.
Invariant (core-domain session-creation hook, cross-referenced): a
           user entity whose `banned` flag is true but whose
           `banExpires` has already elapsed is NOT treated as
           currently banned at the next session-creation attempt for
           that user — the ban is lazily healed (banned/banReason/
           banExpires are cleared) instead of blocking sign-in. A
           temporary ban is therefore self-expiring from the target's
           point of view; it is `unbanUser` (§3.5) that is required
           only to lift a ban BEFORE its natural expiry.
On violation: BAD_REQUEST for self-ban (blamed CLIENT, unconditionally,
           even for a caller who otherwise holds user:ban) or a missing
           target (blamed CLIENT); FORBIDDEN for a caller lacking
           user:ban (blamed CLIENT).
```

### 3.7 Impersonation — a session-substitution contract

Impersonation is the one admin capability that does not merely mutate a
target entity — it substitutes the CALLER's own active identity for the
target's, for a bounded window, while preserving an unbreakable audit
link back to the true actor. It is specified separately from the
Operation/Requires/Ensures shape above because its postcondition is a
statement about TWO sessions and their relationship, not one entity.

```
Operation:  impersonateUser

Requires:
  - Caller authorized for user:impersonate.
  - If the TARGET's own role intersects the configured `adminRoles` set,
    or the target's id is listed in `adminUserIds`: caller is
    ADDITIONALLY required to be authorized for user:impersonate-admins
    — UNLESS the deployment has set the deprecated blanket
    `allowImpersonatingAdmins: true` option, which suppresses this
    additional check entirely for every admin target.
  - Target user must exist.

Ensures (session substitution):
  1. A NEW session is created, owned by the TARGET user, carrying an
     `impersonatedBy` field set to the CALLER's own user id, with a
     bounded lifetime (`options.impersonationSessionDuration`, default
     one hour) — deliberately shorter-lived than an ordinary session.
  2. The caller's OWN pre-impersonation session token is preserved
     out-of-band (a separate, independently signed cookie), NOT
     destroyed. This is what makes returning to the original identity
     possible: the original session is suspended, never discarded, for
     as long as the impersonation session lives.
  3. The active session for the current browser/client is swapped to
     the new target-owned session. From this point until
     `stopImpersonating` (§3.8) or expiry, every authorization decision
     and every domain-entity mutation performed through this session is
     evaluated as the TARGET user, in full — the actor genuinely
     becomes the target for the purposes of any `can(actor, action,
     resource)` decision elsewhere in the system.

Invariant (the session-substitution invariant):
  - For the entire lifetime of an impersonation session, its
    `impersonatedBy` attribution MUST remain present, unchanged, and
    distinct from the session's own owning user id. It is never
    cleared, reassigned, or made to equal the target's own id while the
    session is live. This is what lets `stopImpersonating` recover the
    original actor, and what lets any audit consumer recover the true
    actor behind a mutation performed during impersonation — the
    substitution is total for authorization purposes but never total
    for attribution purposes.
  - Read paths MAY choose to hide impersonation sessions from a
    listing without weakening this invariant: the reference
    implementation filters sessions carrying `impersonatedBy` out of
    the `list-sessions` response specifically, while leaving the
    session itself fully present, queryable by id, and revocable
    through the ordinary session-revocation endpoints. "Hidden from one
    listing" and "erased" are not the same postcondition, and only the
    former is guaranteed here.

On violation:
  - Missing user:impersonate, or missing user:impersonate-admins for an
    admin target without the blanket override: FORBIDDEN, blamed
    CLIENT.
  - A plugin or storage adapter that overwrites or drops
    `impersonatedBy` on any write to the impersonation session during
    its lifetime: this is a violation of the invariant above, and per
    `00-methodology/03-theory-of-contracts-and-blame.md §4` ("first
    cause, not first observer"), blame lies with whatever code performed
    that write — not with `stopImpersonating` or any audit consumer that
    later fails because the attribution is gone.
```

### 3.8 `stopImpersonating`

```
Requires:  the CALLER's current session must itself be an impersonation
           session (its own `impersonatedBy` is set) — otherwise
           rejected as "not impersonating anyone."
           The preserved original-session cookie must still resolve to
           a session whose owner matches the impersonation session's
           `impersonatedBy` value — a mismatch is treated as an
           internal integrity failure, never silently trusted.
Ensures:   the impersonation session is deleted outright (a hard
           revoke, not merely a cookie swap away from it), and the
           ORIGINAL session is restored as the active one, honoring
           whatever "remember me" preference was captured at the moment
           impersonation began.
Invariant: after this call, no trace of the impersonation session
           remains queryable as a live session; the actor's identity
           and permissions revert exactly to what they were
           immediately before `impersonateUser` was called.
```

### 3.9 `revokeUserSession` / `revokeUserSessions`

```
Requires:  caller authorized for session:revoke.
Ensures:   the named session, or ALL of the target's sessions
           respectively, are deleted. `revokeUserSessions` implicitly
           also destroys any impersonation session where the target is
           being impersonated, since that is simply one more session
           owned by that user id — impersonation sessions are not
           exempt from a bulk revoke.
```

### 3.10 `removeUser`

```
Requires:  caller authorized for user:delete; target != caller.
Ensures:   COMPOUND, ordered postcondition: every session of the target
           is deleted, THEN the user record itself is deleted — the
           system never leaves a session referencing a since-deleted
           user.
On violation: BAD_REQUEST for self-removal (blamed CLIENT,
           unconditionally); FORBIDDEN for missing user:delete (blamed
           CLIENT); NOT_FOUND for a missing target (blamed CLIENT).
```

### 3.11 `setUserPassword`

```
Requires:  caller authorized for user:set-password; new password
           length within the same minimum/maximum bounds enforced for
           ordinary self-service password changes (core-domain
           credential contract — not restated here).
Ensures:   the target's credential account is created (if none exists)
           or its password overwritten (if one does); this is the
           ONLY admin path permitted to write password material — see
           `adminUpdateUser` (§3.4), which explicitly refuses it.
```

### 3.12 `userHasPermission` — a pure introspection endpoint

```
Operation:  userHasPermission
Arrow shape: ActorDescriptor -> boolean   (identical arrow to §2)

Requires:  a well-formed permission request, and enough of {session,
           userId, role} to resolve an actor to check.
Ensures:   returns whether that actor/role WOULD be authorized — a pure
           query with no side effect and no capability of its own being
           exercised.
Invariant: this endpoint is deliberately NOT gated by any admin
           capability — asking "would X be allowed to Y" reveals a
           boolean about the permission model, it does not grant Y. Any
           authenticated caller may ask about themselves; a
           server-side (no session) caller may ask about an explicit
           `userId`/`role`.
```

---

## 4. What this plugin adds to the core session/user invariants

Cross-referencing `01-core-domain/` (invariants restated only insofar as
this plugin extends them):

* the `banned`/`banReason`/`banExpires` fields, and the rule that a new
  session may not be created for a user currently and validly banned
  (§3.6's healing behavior is the exception carve-out to that rule, not a
  contradiction of it);
* the `impersonatedBy` field on a session, and the invariant in §3.7 that
  it is immutable and non-self-referential for the life of an
  impersonation session;
* the `role` field on a user, consulted fresh (not cached in the session)
  by every `hasPermission` check in this document — a role change (§3.1)
  takes effect for the target's very next permission check, without
  requiring a new session.
