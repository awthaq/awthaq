# SCIM Provisioning Contract

> This document specifies better-auth acting as a **SCIM server**: an
> enterprise identity provider (Okta, Entra ID, Google Workspace, or any
> SCIM-compliant caller) pushes user and group provisioning events INTO
> better-auth over a standardized resource-CRUD protocol. This is the
> mirror image of `05-sso`'s role assignment: here, the enterprise
> identity provider is issuing HTTP requests directly against
> better-auth's own API surface, exactly as any other integrating
> application would. Per the blame framework's own justification
> criterion (`00-methodology/03 §1`, "a genuine third real-world
> boundary"), **the enterprise identity provider is the CLIENT of this
> API, not an UPSTREAM PROVIDER** — better-auth never itself calls
> outward to a further downstream system on the identity provider's
> behalf while servicing a SCIM request. UPSTREAM PROVIDER is therefore
> not an applicable blame category anywhere in this document; every
> fault is either CLIENT (the calling identity provider sent a malformed
> or conflicting request) or SUPPLIER (an internal failure, or a
> deployer-supplied reconciliation callback misbehaving).

This document cross-references, without restating, the User/Account
entity invariants of `01-core-domain` — in particular, this document's
provisioned identities are a DISTINCT concept layered ALONGSIDE the core
User/Account model, not a replacement for it (see §5).

---

## 1. Resource discovery contract

```
Operation:     Discover SCIM Capabilities
Requires:      nothing — this operation is intentionally reachable
               without any connection authentication (§2)
Ensures:       - a fixed, connection-agnostic description of supported
                 capabilities is returned: which resource types exist,
                 which schemas they conform to, which optional SCIM
                 features are supported (patch: yes; bulk operations:
                 no; filtering: yes, with a bounded page size; sorting:
                 no; attribute-level ETags: no) and exactly one
                 supported authentication scheme (a bearer credential)
               - the returned description NEVER varies by caller, by
                 tenant, or by connection — no tenant-specific
                 information is observable through this operation
Invariant:     discovery output is identical for every caller,
               authenticated or not — it carries no capability to leak
               cross-tenant information, by construction, since it
               carries no tenant-scoped data at all
On violation:  a request for an unknown schema or resource-type
               identifier: raised as a standard not-found outcome in
               the protocol's own error shape (§8). Blamed party:
               CLIENT.
```

---

## 2. Connection and authentication contract

```
ConnectionAuthenticator : (BearerCredential) -> ConnectionPrincipal | Unauthenticated

  where ConnectionPrincipal = {
    connectionId, provisioningDomainId, credentialId, scopes
  }
```

```
Operation:     Authenticate a SCIM Request
Requires:      a bearer credential presented on the request
Ensures:       - the credential resolves, via exactly one of several
                 coexisting resolution strategies (a statically
                 configured credential, a framework-managed, digested/
                 rotatable credential catalog, or a deployer-supplied
                 verification callback), to EXACTLY ONE connection
                 principal, or the request is treated as unauthenticated
               - a resolved principal always carries an explicit scope
                 set; an operation requiring a write capability the
                 principal's scopes do not include is refused
                 independently of whether authentication itself
                 succeeded
               - credential comparison, wherever a shared-secret shape
                 is used, is performed in constant time
Invariant:     a malformed, ambiguous, expired, or otherwise
               unresolvable credential leaves NO partial state behind —
               it is uniformly treated as authentication failure, never
               as a partially-authenticated or best-effort principal
On violation:  credential missing, malformed, ambiguous, or expired:
               raised as an authentication failure. Blamed party:
               CLIENT. A principal lacking the scope a specific
               operation requires: raised as a forbidden outcome,
               distinct from authentication failure. Blamed party:
               CLIENT.
```

### 2.1 Connection-to-tenant binding invariant

```
INVARIANT (First-Use Domain Binding Is Permanent):
   the FIRST successful authentication of a given connection identifier
   permanently binds that connection to exactly one provisioning-
   domain identifier. Every SUBSEQUENT request — including a
   decommission request (§2.2) — presenting a DIFFERENT domain for the
   SAME connection identifier is refused as a conflict, and the
   ORIGINAL binding, along with everything already provisioned under
   it, is left completely untouched. Concurrent first-uses of the same
   connection identifier converge on exactly one binding — never two.
```

```
On violation:  a request presents a domain inconsistent with an
               already-established binding: raised as a conflict.
               Blamed party: CLIENT — the calling identity provider (or
               its operator) is misusing a connection identifier across
               tenants it should not span.
```

### 2.2 Decommissioning contract

```
Operation:     Decommission a Connection
Requires:      a connection identifier (which MAY be decommissioned
               even before it is ever successfully used, pre-emptively
               blocking it forever)
Ensures:       - every credential issued for this connection is
                 permanently rejected from the moment decommissioning
                 takes effect onward
               - EVERY user provisioned under this connection's
                 provisioning domain has this connection's specific
                 contribution to their aggregate provisioning state
                 removed (see §3's aggregate-active rule) — sessions
                 are terminated ONLY for a user whose aggregate active
                 state, after removing this connection's contribution,
                 becomes false (i.e. this was their LAST active
                 provisioning source)
               - NO user record is ever deleted as a side effect of
                 decommissioning a connection — decommissioning removes
                 a connection's standing, never the underlying user
                 data it contributed
               - a connection, once decommissioned, can never be reused
                 or rebound to a different domain
Invariant:     decommissioning is resumable and idempotent — interrupted
               partway through, it can be resumed without re-processing
               already-completed work twice, and completing it a second
               time (e.g. an operator re-triggering it) has no
               additional effect
On violation:  a request attempts to authenticate using a credential
               from an already-decommissioned connection: treated
               identically to any other unresolvable credential (§2).
               Blamed party: CLIENT.
```

### 2.3 Write-time fencing invariant

```
INVARIANT (Fencing Against Decommission-During-Write Races):
   every resource mutation re-checks, AT COMMIT TIME (not merely at the
   start of the request), that its connection's binding is STILL active
   — i.e. has not been decommissioned in the window between the
   mutation's initial read and its commit. If decommissioning has won
   that race, the ENTIRE mutation — including a mutation that would
   otherwise have been a no-op — is discarded, and the request is
   treated as unauthenticated. This closes the gap where a write
   authorized at the start of a request could otherwise land durably
   after its connection's authorized lifetime has already ended.
```

```
On violation:  the fencing check fails at commit time: raised as an
               authentication failure (uniform with §2's own outcome
               shape, so a caller cannot distinguish "never
               authenticated" from "was authenticated, but the
               connection ended before this write committed"). Blamed
               party: none in the fault sense for the caller — this is
               a correct, intended outcome of a race that this
               invariant exists specifically to resolve safely; if this
               invariant were ever observed NOT to hold (a write landing
               after decommission), that would be SUPPLIER-blamed.
```

---

## 3. User resource CRUD contract

```
Operation:     Create User (SCIM)
Requires:      - a payload declaring the core User schema (and,
                 optionally, an enterprise-user extension schema,
                 present if and only if a corresponding extension
                 attribute block is present)
               - a user-name value; if no separate email attribute is
                 supplied, the user-name value itself must be a
                 syntactically valid email
               - the user-name and, if supplied, the external
                 identifier, are each unique WITHIN this connection —
                 never checked or enforced globally across connections
               - at most one existing SCIM user record may already
                 exist, within this connection, resolving to the SAME
                 underlying better-auth user
Ensures:       - a deployer-supplied identity-resolution decision
                 determines whether this SCIM create results in a BRAND
                 NEW underlying user, or a LINK to an EXISTING
                 underlying user — the DEFAULT, absent any such
                 decision, is always to create a new one; SCIM never
                 implicitly matches an existing user by email the way
                 `02-social-sign-in §4` does for social identities —
                 these are deliberately DIFFERENT linking philosophies
                 for DIFFERENT trust models (an authenticated,
                 connection-scoped provisioning integration is not the
                 same trust boundary as an anonymous social login)
               - IF the resolution links to an existing user under a
                 MANAGE profile mode: this connection becomes
                 AUTHORITATIVE over that user's name/email — a later
                 email change through this connection resets that
                 user's verified-email flag, since a provisioning-driven
                 email change is not the same event as the user
                 themselves re-verifying a new address
               - IF the resolution links under a PRESERVE profile mode:
                 this connection's writes never alter the user's
                 existing name/email fields at all
               - AT MOST ONE connection, globally, may hold the MANAGE
                 profile mode for a given underlying user at any time
                 — claiming it is an atomic, all-or-nothing operation;
                 losing that race is a conflict, not a silent partial
                 grant. Multiple DIFFERENT connections MAY simultaneously
                 hold PRESERVE links to the SAME underlying user — this
                 fan-in is intentional, not an oversight
               - NO account-linking row of the kind `01-core-domain`'s
                 sign-in credential model uses is ever created as a
                 side effect of a SCIM create — a SCIM-provisioned
                 identity carries NO sign-in credential by itself; SCIM
                 provisioning and sign-in capability are independent
                 concerns
Invariant:     a duplicate user-name, external identifier, or email
               within the same connection is NEVER silently
               overwritten or merged — it is always a conflict outcome
On violation:  - duplicate user-name/external-id/email within the
                 connection: raised as a uniqueness conflict. Blamed
                 party: CLIENT — the calling identity provider sent a
                 payload conflicting with data it (or another SCIM
                 client under the same connection) already provisioned.
               - a resolution decision throws, or returns a
                 self-contradictory instruction: Blamed party: SUPPLIER
                 (the deployer-supplied resolution logic is
                 SUPPLIER-owned code running inside this contract, per
                 `00-methodology/03 §4`'s "first cause" rule).
```

```
Operation:     Deactivate User (SCIM, active:false)
Requires:      a SCIM user resource being written with its active
               attribute set to false
Ensures:       - this connection's OWN contribution to the underlying
                 user's provisioning state is marked inactive — this is
                 a SOURCE-LEVEL flag, never a direct, unconditional
                 disable of the underlying user
               - the underlying user's AGGREGATE active state is
                 recomputed as the logical OR across every one of its
                 non-decommissioned provisioning sources; only when
                 that aggregate becomes false does any user-facing
                 effect occur
               - the ONLY built-in effect of the aggregate becoming
                 false is termination of the user's existing sessions —
                 this operation does NOT itself set any independent
                 "banned" or "disabled" flag; any FURTHER, persistent
                 sign-in blocking beyond killing existing sessions is
                 delegated entirely to a deployer-supplied
                 reconciliation callback, which cannot suppress or
                 redirect the session-kill this operation already
                 performs
Invariant:     deactivation is NEVER a delete — no SCIM resource, no
               group membership, and no underlying user data is removed
               by this operation, regardless of how many of the user's
               provisioning sources are deactivated
On violation:  n/a for the deactivation path itself — see §8 for
               malformed-payload handling.
```

```
Operation:     Delete User (SCIM)
Requires:      an existing SCIM user resource within this connection
Ensures:       - the SCIM resource itself, its group memberships (within
                 this connection), and its provisioning grants are
                 permanently removed
               - a tombstone recording the external identifier and the
                 profile mode that was in effect is retained, so that a
                 LATER create presenting the SAME external identifier
                 re-links to the SAME underlying user rather than
                 provisioning a duplicate
               - the UNDERLYING better-auth user record is NEVER
                 deleted by this operation, under any profile mode —
                 deleting the SCIM resource is strictly narrower than
                 deleting the identity it was linked to
Invariant:     a SCIM delete and a SCIM deactivate are OBSERVABLY
               DIFFERENT operations with different postconditions — a
               deployer or auditor must never be able to construct a
               sequence of deactivate calls that produces the same
               effect as a delete, or vice versa
On violation:  n/a for the happy path; a delete of an already-deleted
               or nonexistent resource is a standard not-found outcome,
               Blamed party: CLIENT.
```

---

## 4. Group resource CRUD contract

```
Operation:     Create / Update / Patch Group (SCIM)
Requires:      - a display name and, if supplied, an external
                 identifier, each unique within this connection (display
                 name compared case-insensitively)
               - every member reference names an ALREADY-EXISTING SCIM
                 user resource belonging to THIS SAME connection — a
                 reference to a nonexistent user, or to a user
                 provisioned under a DIFFERENT connection, is rejected
                 outright; there is no deferred/forward-reference
                 tolerance
               - direct membership does not exceed a fixed maximum
                 member count, enforced both before and, re-checked,
                 during the mutation's commit (so a race that would
                 exceed the cap resolves to exactly one winner)
Ensures:       - patch-style membership changes support both a full-
                 array replacement and an incremental add/remove,
                 including a value-selector reference to a specific
                 member; adding an already-present member, or removing
                 a member not present, is a verified NO-OP — no
                 duplicate row, no error, and no unnecessary downstream
                 reconciliation triggered
               - a single underlying user MAY belong to an unbounded
                 number of groups — there is no per-user cap symmetric
                 to the per-group member cap
               - a group never contains another group as a member —
                 membership is exactly one level deep
               - a mutation touching multiple groups (e.g. removing one
                 user from several groups in one operation) acquires
                 locks across the affected groups and users in a fixed,
                 deterministic order, specifically to make concurrent
                 multi-group mutations deadlock-free
Invariant:     deleting a Group removes only its own resource and
               membership rows — the underlying provisioned Users named
               by its former membership are entirely unaffected
On violation:  - duplicate display name/external id: uniqueness
                 conflict. Blamed party: CLIENT.
               - member reference to a nonexistent or cross-connection
                 user: invalid-value rejection of the WHOLE mutation —
                 no partial membership change is ever committed. Blamed
                 party: CLIENT.
               - member cap exceeded, including the race case: rejection
                 of whichever request lost the race. Blamed party:
                 CLIENT (both callers are, from the protocol's point of
                 view, making a legitimate but jointly over-capacity
                 request — the loser simply retries, e.g. after removing
                 a different member first).
```

---

## 5. Identity mapping and uniqueness invariant

```
INVARIANT (SCIM Identity Chain):
   a SCIM-provisioned identity is represented as a chain:
     connection-scoped SCIM resource  →  a per-user provisioning
     aggregation record (tracking every connection contributing to
     that user, which one if any holds MANAGE mode, and a monotonic
     revision counter)  →  the underlying `01-core-domain` User entity.

   This chain is deliberately LAYERED ALONGSIDE the core User/Account
   invariants, never a replacement for them: `01-core-domain`'s
   invariants over the User entity (identity, credential ownership,
   session eligibility) continue to hold exactly as specified there,
   regardless of how many SCIM connections are also linked to that
   same user. A SCIM connection does not carry any sign-in credential
   of its own (§3) — it can influence a user's PROFILE fields (under
   MANAGE mode) and a user's ELIGIBILITY TO HOLD A SESSION (via the
   aggregate-active rule, §3), but it can never itself constitute or
   substitute for a credential the core domain's sign-in contract
   requires.

   Uniqueness is enforced STRICTLY PER CONNECTION for user-name,
   external identifier, and (for groups) display name — NEVER
   globally across connections. TWO SCIM resources, from TWO DIFFERENT
   connections, MAY legitimately resolve to the SAME underlying user
   (multiple PRESERVE-mode links, or one MANAGE-mode link plus any
   number of PRESERVE-mode links) — this fan-in is an intended,
   supported shape, not an anomaly.

   Cross-tenant isolation (one connection's provisioning domain never
   observing or affecting another's data) is a SEPARATE, always-on
   guarantee, orthogonal to the fan-in behavior above: fan-in describes
   multiple connections COOPERATING on one user by design; isolation
   describes connections that have NO relationship to each other never
   interfering, even accidentally.
```

```
On violation:  a MANAGE-mode claim is observed held by more than one
               connection simultaneously for the same user: SUPPLIER-
               blamed — the atomic claim-exchange this contract
               requires (§3) failed to be atomic. A SCIM resource
               observed to have crossed provisioning-domain isolation
               (affecting a user or resource outside its own connection
               binding): SUPPLIER-blamed, per §2.3's fencing invariant
               having failed to hold.
```

---

## 6. Concurrency and uniqueness on create

```
INVARIANT (No Double-Provisioning Under Concurrency):
   two simultaneous create requests presenting the SAME user-name,
   external identifier, or email WITHIN THE SAME CONNECTION can never
   both succeed in producing two distinct provisioned identities. The
   storage layer's own uniqueness enforcement is the ultimate
   backstop; a request that loses this race receives the SAME
   uniqueness-conflict outcome §3 already specifies for a
   non-concurrent duplicate — concurrency never produces a DIFFERENT
   failure shape than the equivalent sequential duplicate would.

   For identity LINKING specifically (claiming MANAGE mode, or a
   FIRST link of any mode to a given user), the per-user revision
   counter (§5) serializes concurrent attempts: a losing attempt
   observes a stale revision and retries against fresh state, within a
   bounded number of attempts, rather than corrupting the aggregation
   record. Two connections racing to independently PRESERVE-link to
   the same user both converge cleanly onto one aggregation record —
   this is the fan-in case (§5), not a conflict.
```

```
On violation:  a genuine duplicate is observed to have committed (two
               distinct provisioned identities for what should have
               been one uniqueness key): SUPPLIER-blamed — the storage
               layer's uniqueness enforcement, which this contract
               requires as a backstop, did not hold.
```

---

## 7. Filtering and pagination contract

```
Operation:     List / Filter Resources
Requires:      an OPTIONAL filter expression restricted to equality
               comparisons only, on a FIXED, per-resource-type allow-
               list of attributes (never an arbitrary attribute path);
               up to a bounded number of such equality clauses may be
               conjoined; no disjunction, negation, substring, or
               presence operator is supported
Ensures:       - a filter using any operator or attribute outside the
                 allow-list is rejected before any query executes —
                 never silently ignored or partially applied
               - pagination uses a 1-based starting index (values below
                 the minimum are clamped, never treated as an error)
                 and a page-size count capped at a fixed maximum; a
                 starting index beyond the end of the result set yields
                 an EMPTY page, not an error
               - the total result count reported reflects the FULL
                 filtered set, independent of the page size requested —
                 a caller can always determine how many pages remain
                 without walking them all
Invariant:     the filter grammar's allow-list is identical for every
               connection — no connection-specific relaxation or
               extension of what may be filtered on
On violation:  an unsupported operator, an attribute outside the
               allow-list, or a malformed (e.g. unquoted) filter value:
               raised as an invalid-filter outcome. Blamed party:
               CLIENT.
```

---

## 8. Error response contract

```
INVARIANT (Uniform Error Envelope):
   every error surfaced under this document's operations — regardless
   of which internal condition produced it — is normalized into ONE
   consistent shape before reaching the caller: a status code, an
   optional human-readable detail, and, where applicable, a
   machine-readable category drawn from a small, fixed vocabulary
   (invalid filter, too many results, uniqueness conflict, mutability
   violation, invalid syntax, invalid path, no target, invalid value,
   invalid protocol version, sensitive-attribute violation). A
   deployer-supplied reconciliation callback that itself raises an
   error already in this shape has that error passed through
   unchanged, preserving whatever category the callback intentionally
   chose; any OTHER kind of failure from such a callback (an unexpected
   exception) is normalized into an internal-failure outcome rather
   than leaking implementation detail to the caller.
```

```
On violation:  n/a — this is itself the normalization contract; see the
               per-operation tables above for which specific conditions
               are CLIENT-blamed (the overwhelming majority: malformed
               payloads, uniqueness conflicts, invalid filters, bad
               credentials, forbidden scope) versus SUPPLIER-blamed
               (storage-layer failures, a broken atomic-claim guarantee,
               a reconciliation callback throwing an unexpected
               exception). As established in this document's
               introduction, UPSTREAM PROVIDER never applies here: the
               calling identity provider occupies the CLIENT role for
               every operation in this document.
```

---

## 9. Diagrams

### 9.1 Identity linking lifecycle — state diagram

```
              Create User (SCIM), first observation of this
              external identifier within this connection
                              │
                 resolution decision (deployer-supplied,
                 default: create new)
                              │
              ┌───────────────┼───────────────────┐
              ▼                                    ▼
     ┌─────────────────┐                  ┌──────────────────────┐
     │  NEW UNDERLYING   │                  │  LINK TO EXISTING     │
     │  USER CREATED      │                  │  UNDERLYING USER      │
     └────────┬──────────┘                  └───────────┬───────────┘
              │                                          │
              │                              ┌───────────┴────────────┐
              │                        claim MANAGE            claim PRESERVE
              │                        (atomic CAS —            (never conflicts —
              │                        only ONE connection       many connections
              │                        globally may hold it       may coexist)
              │                              │                          │
              ▼                              ▼                          ▼
     ┌──────────────────┐          ┌──────────────────┐       ┌──────────────────┐
     │ this connection    │          │ this connection    │       │ this connection    │
     │ becomes MANAGE for  │          │ becomes MANAGE for  │       │ PRESERVE-linked;   │
     │ the new user        │          │ this user (won CAS) │       │ never writes name/  │
     │                     │          │  ✗ lost CAS → 409,   │       │ email               │
     │                     │          │    another conn.     │       │                     │
     │                     │          │    already MANAGE     │       │                     │
     └─────────┬───────────┘          └─────────┬───────────┘       └─────────┬───────────┘
               │                                  │                             │
               └──────────────┬───────────────────┴─────────────────────────────┘
                               │
                     Deactivate (active:false) — flips THIS
                     connection's source-level flag only
                               │
                     recompute aggregate = OR(all non-
                     decommissioned sources' active flags)
                               │
                  ┌────────────┴─────────────┐
           aggregate still TRUE        aggregate now FALSE
           (another source active)     (this WAS the last one)
                  │                            │
                  ▼                            ▼
          no session effect            terminate existing sessions
                                        (persistent block delegated
                                         to reconciliation callback)
                               │
                     Delete (SCIM resource only) — removes
                     THIS connection's resource + memberships +
                     grants, writes tombstone; underlying user
                     record is NEVER removed by this path
```

### 9.2 Fenced write — sequence diagram

```
   Enterprise IdP (CLIENT)      better-auth SCIM server (SUPPLIER)
        │                                │
        │──PATCH /Users/:id (Bearer)────▶│
        │                                │ Authenticate (§2)
        │                                │  resolve → ConnectionPrincipal
        │                                │  (connectionId, domainId, scopes)
        │                                │ check scope covers write
        │                                │ read current resource + revision
        │                                │ apply add/replace/remove ops
        │                                │  (no-op short-circuit if the
        │                                │   resulting state is byte-identical)
        │                                │
        │   ⋯ meanwhile, elsewhere ⋯      │
        │                                │      (an operator decommissions
        │                                │       this SAME connection)
        │                                │
        │                                │ COMMIT: re-check connection
        │                                │  binding is STILL active (§2.3)
        │                                │   ✗ decommissioned mid-flight →
        │                                │     DISCARD entire mutation,
        │                                │     respond as unauthenticated
        │                                │   ✓ still active →
        │                                │     commit write, increment
        │                                │     revision atomically
        │◀── 200 (or unauthenticated) ───┤
```
