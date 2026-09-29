# P01 — Session integrity & cookie/CSRF correctness

Phase 1 · 44 open issues to fix (22 medium, 21 low, 1 info) · 26 closed by validation · ~125h summed per-issue estimate (upper bound) · 3 need a decision first.

Each issue below links to its full dossier (evidence at HEAD `ec065a7`, fix steps, tests, acceptance) in its slice file. Work workstream by workstream, top to bottom; within a workstream do the canonical issue first — its fix closes the listed duplicates.

## `session-verify-hardening` — Session verify: prove the secret before any state branch

Slices: [01-core-sessions-users](../slices/01-core-sessions-users.md) · ~5h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [IDS-008](../slices/01-core-sessions-users.md) | low | architecture | CONFIRMED | S | — | Enforce the self-act-as invariant inside Sessions.issue (both layers) as a typed defect, and document that the nesting check needs the caller's session and stays with the producer. |
| [PIL-007](../slices/01-core-sessions-users.md) | low | security | PARTIAL | M | — | Prove the secret before any row-state branch: hash first, look up, constant-time compare (against a dummy hash on miss), and only then evaluate tombstone/expiry; reuse detection must require a matching secret. |

Closed by validation in this workstream: RRS-005 (WONTFIX-CANDIDATE), SMS-007-session-management-specialist (DUPLICATE → PIL-007)

## `session-rotation-delivery` — Rotated-secret delivery on every path + bearer client capture

Slices: [06-server-api](../slices/06-server-api.md) · ~10h · depends on workstreams: `observability-substrate (MW-001, slice 02) for the redaction step only`, `per-request-session-cache`, `wire-constant-single-source`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [MNA-005](../slices/06-server-api.md) | medium | api | CONFIRMED | M | PIL-005, CSS-007 | Ship a first-class bearer-client contract: a shared header constant, a client-side token store, and a transform that attaches the bearer and captures rotations on every response. |
| [PIL-005](../slices/06-server-api.md) | medium | dx | CONFIRMED | M | TS-003-tim-smart, CSS-007 | Deliver rotated secrets from inside the memoized verify via `HttpEffect.appendPreResponseHandler`, so every path delivers: Path A, Path B, and responses whose handler failed with a typed error. |
| [MAPS-008](../slices/06-server-api.md) | low | security | CONFIRMED | S | PIL-005, MW-001 | Reduce the exposure of the rotated long-lived secret in transit and in logs. Header delivery itself stays, as ticket 01 decided. |
| [NHS-007](../slices/06-server-api.md) | low | correctness | PARTIAL | S | PIL-005 | Folded into PIL-005: rotation delivery moves into a pre-response handler that recovers encoding failures (log and continue) instead of orDie. Header-stripping guidance ships with MNA-005's docs. |

Closed by validation in this workstream: CTA-006 (DUPLICATE → MNA-005), PIL-009 (DUPLICATE → MNA-005)

## `csrf-hardening` — CSRF: bearer exemption (decision 24 §2) + time-bound tokens

Slices: [06-server-api](../slices/06-server-api.md) · ~5h · depends on workstreams: `hmac-secret-hygiene`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [CDS-006](../slices/06-server-api.md) | low | security | CONFIRMED | M | ACS-005 | Time-bound the double-submit token: sign `<iat>.<random>`, reject tokens older than a configurable max age, and re-mint proactively so the window never bites mid-session. |
| [MNA-008](../slices/06-server-api.md) | low | security | PARTIAL | S | — | The Secure-attribute claim is invalid, but the consequence it predicts for bearer clients is live: implement decision 24 §2's bearer exemption in CsrfProtectionLive. |

Closed by validation in this workstream: CDS-005 (ALREADY-FIXED), CDS-004 (ALREADY-FIXED), PDR-007 (ALREADY-FIXED)

## `session-supersede-atomicity` — Atomic issue(supersedes) / Transactional session supersession

Slices: [01-core-sessions-users](../slices/01-core-sessions-users.md), [12-spec](../slices/12-spec.md) · ~5h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ESR-002](../slices/01-core-sessions-users.md) | medium | correctness | PARTIAL | M | — | Make issue(supersedes) one atomic unit in both layers: SQL tombstone+insert inside one transaction; memory tombstone+insert inside one Ref.modify. |
| [RRS-004](../slices/12-spec.md) | medium | correctness | PARTIAL | S | — | Wrap the tombstone + insert pair in one transaction via the SqlTransaction port, and update ADR-016's reference. |

Closed by validation in this workstream: AH-007-anders-hejlsberg (ALREADY-FIXED), TTE-004 (ALREADY-FIXED), ECF-007 (DUPLICATE → ESR-002), PIL-004 (DUPLICATE → ESR-002), SMS-006-session-management-specialist (DUPLICATE → ESR-002)

## `session-list-correctness` — Sessions.list returns exactly the live sessions

Slices: [01-core-sessions-users](../slices/01-core-sessions-users.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ESS-005-effect-stream-specialist](../slices/01-core-sessions-users.md) | medium | correctness | CONFIRMED | M | — | Make Sessions.list return exactly the user's live (non-tombstoned, non-expired) sessions, newest-activity first, in both layers, and stop server handlers from using list for keyed lookups. |

Closed by validation in this workstream: VB-001 (ALREADY-FIXED), PIL-003 (DUPLICATE → ESS-005-effect-stream-specialist)

## `session-list-liveness-and-pagination` — Session device list: live-only, exhaustive, index-aligned, bounded

Slices: [05-sql](../slices/05-sql.md) · ~7h · depends on workstreams: `retention (CSG-003, cross-slice; reaper only)`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [PPS-002](../slices/05-sql.md) | medium | performance | CONFIRMED | S | — | Add a partial composite index that matches the page query's filter and order, and rewrite the cursor as a row-value comparison. |
| [SMS-002-session-management-specialist](../slices/05-sql.md) | medium | correctness | CONFIRMED | S | CSG-003 | Filter expired rows out of the device list in both layers. Delegate physical deletion to ticket 30's `Retention.sweep` (CSG-003, cross-slice) rather than inventing a second reaper. |
| [TIR-003](../slices/05-sql.md) | medium | correctness | PARTIAL | M | — | Add a keyed ownership lookup and route every point query through it. Make `list` exhaustive instead of silently truncating at 200. |
| [ESR-010](../slices/05-sql.md) | low | api | CONFIRMED | S | — | Bound the page size by construction: clamp in `listByUser` and enforce the bound in the request schema. |

Closed by validation in this workstream: SEA-006 (DUPLICATE → PPS-002), SSMS-008 (DUPLICATE → PPS-002)

## `session-docs-accuracy` — Session/memory-layer documentation accuracy

Slices: [01-core-sessions-users](../slices/01-core-sessions-users.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [SEA-002](../slices/01-core-sessions-users.md) | medium | performance | CONFIRMED | S | MA-004 | Document the embedded-SQLite write ceiling and the move-to-Postgres signal; the retry/typed-error half rides on MA-004's decision. |
| [TRBS-005](../slices/01-core-sessions-users.md) | medium | security | CONFIRMED | S | — | Document every core layerMemory as single-process/test-grade and point multi-instance deployments at layerSql (or a future KV layer per ADR-EA-014). |
| [PIL-006](../slices/01-core-sessions-users.md) | low | docs | CONFIRMED | S | — | Reword the verify doc comment: fixation is prevented by fresh issuance/supersede (BEH-EA-053); throttled secret rotation limits the useful life of a leaked secret / stale hash snapshot. |
| [APS-010](../slices/01-core-sessions-users.md) | info | security | CONFIRMED | S | — | Record the invariant 'ids are identifiers, never capabilities' in spec/invariants.md and on SessionId/UserId doc comments. |

## `hmac-secret-hygiene` — Shared HMAC primitive + signing-secret policy

Slices: [06-server-api](../slices/06-server-api.md) · ~6h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [SMS-004-secrets-management-specialist](../slices/06-server-api.md) | medium | security | CONFIRMED | S | ACS-007 | Ship Config-backed layers for the CSRF secret and origins (mirroring KeyProvider.layerEnv), so the obvious path never puts a literal secret in source. |
| [ACS-005](../slices/06-server-api.md) | low | correctness | CONFIRMED | M | — | Hoist HMAC-SHA256, constant-time equality and hex encoding into one tested module in @awthaq/ports, and use it from server, passkey and core. |
| [ACS-007](../slices/06-server-api.md) | low | security | CONFIRMED | S | ACS-005 | Enforce a 32-byte minimum on HMAC signing secrets at layer construction, dying loudly like KeyProvider.layerEnv. |

## `session-issuance-context` — Request metadata + assurance signals on issued sessions

Slices: [07-password-mfa](../slices/07-password-mfa.md) · ~16h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [CSD-003](../slices/07-password-mfa.md) | medium | security | CONFIRMED | M | — | Thread {ip, userAgent} from every session-minting handler into sessions.issue. |
| [APS-007](../slices/07-password-mfa.md) | low | security | CONFIRMED | L | — | Record per-session authentication methods (amr) and offer an opt-in principal resolver that exposes emailVerified. |

Closed by validation in this workstream: SMS-004-session-management-specialist (DUPLICATE → CSD-003)

## `session-policy` — Session policy features: concurrent cap, amr

Slices: [01-core-sessions-users](../slices/01-core-sessions-users.md) · ~16h · depends on workstreams: `session-supersede-atomicity`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [SMS-003-session-management-specialist](../slices/01-core-sessions-users.md) | medium | security | CONFIRMED | M | ESR-002 | Add an opt-in concurrent-session cap to SessionConfig (default: none, preserving BEH-EA-047) with a typed eviction policy, enforced atomically in issue, publishing an event on eviction. |
| [THS-003](../slices/01-core-sessions-users.md) | medium | security | CONFIRMED | L | — | Add RFC 8176 `amr` evidence to sessions: set at issue by the authenticating plugin, extendable by reauthenticate, exposed on SessionView/SessionListItem/SessionDto. |

Closed by validation in this workstream: PIL-008 (WONTFIX-CANDIDATE)

## `session-cookie-policy` — Configurable session cookie with a secure default

Slices: [01-core-sessions-users](../slices/01-core-sessions-users.md) · ~14h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AGA-004](../slices/01-core-sessions-users.md) | medium | security | CONFIRMED ⚖️ decision | S | IC-007 | Deliver the `HostEmbedded` mode of IC-007's SessionCookieConfig (SameSite=None; Partitioned; __Host- kept) for session and CSRF cookies. |
| [BO-005](../slices/01-core-sessions-users.md) | medium | dx | CONFIRMED ⚖️ decision | S | IC-007 | Give the session cookie a Max-Age derived from the session's absoluteExpiresAt (recomputed at every rotation), via IC-007's cookie helper, with a 'browserSession' opt-out. |
| [IC-007](../slices/01-core-sessions-users.md) | low | architecture | CONFIRMED ⚖️ decision | L | — | Introduce SessionCookieConfig with a secure default and typed opt-in modes (incl. __Secure-+Domain for multi-subdomain apps); route every issuance site through one helper. |

Closed by validation in this workstream: EP-008 (DUPLICATE → IC-007)

## `session-cookie-expiry` — Expire __Host-session when the caller's own session ends

Slices: [06-server-api](../slices/06-server-api.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [CSS-002](../slices/06-server-api.md) | medium | security | CONFIRMED | M | — | Expire __Host-session on every response that ends the caller's own session: signOut, revokeAll, revoke when the target is the current session, deleteUser, and the EHA-009 'current row missing' path. |

Closed by validation in this workstream: IC-002 (DUPLICATE → CSS-002), NSA-004 (DUPLICATE → CSS-002), SMS-005-session-management-specialist (DUPLICATE → CSS-002)

## `per-request-session-cache` — Per-request session-resolution cache: atomic, keyed on request.source

Slices: [06-server-api](../slices/06-server-api.md) · ~7h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [TS-003-tim-smart](../slices/06-server-api.md) | medium | correctness | CONFIRMED | M | — | Make per-request memoization single-flight by construction and key it on `request.source`, as Effect's own per-request state is keyed. |
| [ELC-007](../slices/06-server-api.md) | low | architecture | PARTIAL | S | TS-003-tim-smart | Documentation only. The module-level WeakMap is Effect v4's own idiom (there is no FiberRef in v4), and the ambient HttpServerRequest requirement is already visible in resolveSession's R type. |
| [NHS-006](../slices/06-server-api.md) | low | architecture | CONFIRMED | S | TS-003-tim-smart | Key the per-request cache on `request.source`, not the HttpServerRequest wrapper, so re-wrapping (HttpRouter prefix mounts) cannot fork it. Fix the doc comment's false 'mutated in place, never replaced' invariant. |
| [PCS-006](../slices/06-server-api.md) | low | correctness | CONFIRMED | S | — | Document the bounded mid-request revocation window as a deliberate staleness budget. |

Closed by validation in this workstream: ECF-005 (DUPLICATE → TS-003-tim-smart)

## `session-handler-hardening` — Session/account handler correctness and typing

Slices: [06-server-api](../slices/06-server-api.md) · ~7h · depends on workstreams: `session-cookie-expiry`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [GC-003](../slices/06-server-api.md) | medium | architecture | PARTIAL | S | — | Re-establish brands once per request in one shared helper, not at 12 call sites, and delete the duplicated currentUserPrincipal. |
| [GC-005](../slices/06-server-api.md) | medium | api | CONFIRMED | M | — | Add an owning revoke to the Sessions algebra, so ownership and enumeration-safety are enforced in the domain operation. This also fixes the 200-row list cap that wrongly 404s owned sessions. |
| [EHA-009](../slices/06-server-api.md) | low | correctness | CONFIRMED | S | CSS-002 | Answer a concurrently-revoked current session with a typed 401 and an expired cookie, not a 500 defect. |
| [GC-008](../slices/06-server-api.md) | low | dx | PARTIAL | S | GC-003, EHA-009 | Replace plain-Error defects in @awthaq/server with one tagged defect class. The repo-wide sweep is out of scope for this slice. |

## `session-lifecycle-events` — Sessions publishes issue/revoke/expire events for every path

Slices: [12-spec](../slices/12-spec.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ESA-006](../slices/12-spec.md) | medium | architecture | PARTIAL | M | — | Move session lifecycle publication into the Sessions service itself (both layers) so every issuance/revocation path — OAuth, passkey, admin impersonation, sign-out, revokeAll — emits, with a reason, and drop the plugin-level duplicates in Password. |

## `session-revocation-events` — Observable session revocation

Slices: [10-passkey-admin](../slices/10-passkey-admin.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [TIR-008](../slices/10-passkey-admin.md) | medium | architecture | PARTIAL | M | — | Publish revocation from the Sessions primitives themselves with a per-row identity and a cause, so every revocation path is observable and durably audited. |

## `optional-auth-contract` — Authentication middleware wire contract (OpenAPI, ordering, challenges)

Slices: [06-server-api](../slices/06-server-api.md) · ~6h · depends on workstreams: `bearer-credential-extensibility (sequence only: both edit the bearer handler)`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [EHA-006](../slices/06-server-api.md) | low | api | CONFIRMED | M | — | Give OptionalAuthentication no error type, so the OpenAPI document stops advertising an impossible 401. The cookie handler resolves cookie, then bearer, then anonymous itself. |
| [JR-007](../slices/06-server-api.md) | low | compliance | CONFIRMED | S | — | Emit RFC 6750/7235 challenges on 401s from Authentication while keeping the typed JSON body. |
| [NHS-010](../slices/06-server-api.md) | low | api | PARTIAL | S | EHA-006 | Remove the one real positional coupling (OptionalAuthentication's fallback hard-wired to the last-declared `bearer` key) and pin the order with a wired test. Ordering stays the security record's declaration order, as BEH-EA-072 requires. |

## `wire-constant-single-source` — Single source for session cookie name and rotation header

Slices: [06-server-api](../slices/06-server-api.md) · ~1h · depends on workstreams: `httpapi-surface-consolidation (MW-002, slice 01) adds the same core->api dependency; coordinate`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [CSS-007](../slices/06-server-api.md) | low | api | PARTIAL | S | — | Make the session cookie name (and the rotation header name) one constant owned by the contract stratum, with core deriving from it. core (stratum 4) may depend on api (stratum 1). |

Closed by validation in this workstream: EHA-008 (DUPLICATE → CSS-007), MW-009 (DUPLICATE → CSS-007), BE-009 (DUPLICATE → CSS-007)

