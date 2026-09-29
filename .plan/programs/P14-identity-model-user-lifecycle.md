# P14 — Identity model & user lifecycle

Phase 3 · 10 open issues to fix (3 high, 5 medium, 2 low) · 4 closed by validation · ~134h summed per-issue estimate (upper bound) · 1 need a decision first.

Each issue below links to its full dossier (evidence at HEAD `ec065a7`, fix steps, tests, acceptance) in its slice file. Work workstream by workstream, top to bottom; within a workstream do the canonical issue first — its fix closes the listed duplicates.

## `users-identity-model` — UserIdentity union, status, phone normalization (ticket 09)

Slices: [01-core-sessions-users](../slices/01-core-sessions-users.md) · ~37h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [FAMS-002](../slices/01-core-sessions-users.md) | high | architecture | CONFIRMED | XL | — | Implement ticket 09: UserRecord.identity: UserIdentity union + status, widened create, promoteIdentity, setStatus, dialect-branched migrations, and retire OAuth's synthetic email. |
| [SCP-005](../slices/01-core-sessions-users.md) | medium | architecture | PARTIAL | S | FAMS-002 | Record ticket 08/09's SCIM identity decisions in spec/models/12-scim.md (docs only). |
| [SOS-008](../slices/01-core-sessions-users.md) | low | dx | CONFIRMED | M | FAMS-002 | Ship E.164 normalization as part of ticket 09's Phone identity, enforced at the Users boundary, plus the verify-phone identifier scheme. |

## `user-identity-lifecycle` — User identity union and suspension state

Slices: [05-sql](../slices/05-sql.md) · ~36h · depends on workstreams: `admin banned gate (BAM-005, admin slice; co-design)`, `sql-dialect-neutral-models`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [SAM-003](../slices/05-sql.md) | high | correctness | CONFIRMED | XL | TS-001-tim-smart | Implement ticket 09's decision: a `UserIdentity` tagged union (Email / Phone / Anonymous) at the domain layer, flattened to nullable email/phone columns plus phoneVerified in SQL, with a `promoteIdentity` upgrade path. Ticket 09's migration ids 10-12 are already taken; use the next free ids. |
| [SCP-001](../slices/05-sql.md) | high | architecture | CONFIRMED | M | — | Implement ticket 09's decision: `status: "active" / "suspended"` with a dedicated `Users.setStatus` (never a generic write), composed with `Sessions.revokeAll` at the caller. Co-design the sign-in gate and migration with ticket 19's `banned` fields (BAM-005) so there is one gate and one migration. |

## `user-import-idempotency` — Idempotent, transactional user import

Slices: [01-core-sessions-users](../slices/01-core-sessions-users.md) · ~13h · depends on workstreams: `users-identity-model`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AOMS-008](../slices/01-core-sessions-users.md) | medium | api | PARTIAL | L | SCP-003, FAMS-002 | Provide a transactional, idempotent import primitive in core and batch importers on top of it. |
| [SCP-003](../slices/01-core-sessions-users.md) | medium | correctness | CONFIRMED | S | — | Add Users.createOrGet: insert, and on unique violation return the existing record deterministically (both layers). |

Closed by validation in this workstream: SAM-008 (DUPLICATE → AOMS-008), MW-007 (WONTFIX-CANDIDATE)

## `users-profile-surface` — User profile fields: image, email change, plugin-contributed fields

Slices: [01-core-sessions-users](../slices/01-core-sessions-users.md) · ~44h · depends on workstreams: `users-identity-model`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [BAM-009](../slices/01-core-sessions-users.md) | medium | api | PARTIAL | L | FAMS-002 | Add a nullable image field and a verified email-change primitive to Users; document better-auth field mapping. |
| [SAM-004](../slices/01-core-sessions-users.md) | medium | api | PARTIAL ⚖️ decision | XL | — | Implement the BEH-EA-040/048 user-field extension point (decision option A), decomposed into four tickets, with interim docs. |

Closed by validation in this workstream: BE-007 (DUPLICATE → SAM-004), SCP-004 (DUPLICATE → BAM-009)

## `user-profile-image` — User.image / OAuthProfile.image

Slices: [04-oauth-provider-jwt](../slices/04-oauth-provider-jwt.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [NAM-009](../slices/04-oauth-provider-jwt.md) | low | dx | CONFIRMED | M | FAMS-002 | Add an optional `image` to OAuthProfile and the User model so mapProfile can carry avatars (Auth.js/better-auth parity). |

