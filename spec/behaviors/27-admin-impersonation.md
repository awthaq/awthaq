# Admin and Impersonation
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-27 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-13 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-13): Initial release, replacing [MOD-EA-015](../models/15-admin-impersonation.md)'s non-normative sketch (CCR-EA-004) |
---

> This file describes planned behavior. No code implementing it exists yet; awthaq is pre-implementation.

## BEH-EA-209: `actingAs` becomes a real, generic field on session issuance

```ts
interface IssueInput {
  readonly userId: UserId
  readonly request?: { readonly ip?: string; readonly userAgent?: string }
  readonly supersedes?: SessionId
  readonly actingAs?: { readonly type: string; readonly id: string }
}
```

```text
REQUIREMENT: `Sessions.issue` MUST accept an optional `actingAs` reference;
             when present, it MUST be persisted on the issued session's own
             row, immutably (no `update`/`jsonUpdate` variant), the same way
             `secretHash`/`absoluteExpiresAt` are already insert-only fields.
```

`archive/PRD.md` §17's Phase-2 row and [MOD-EA-015](../models/15-admin-impersonation.md) both describe impersonation as producing "a new session row: `userId` = target, `actingAs` = admin" — a session-level fact set once at issuance, not a value recomputed on every request. Extending `Sessions.issue` itself, rather than having `Admin` write to the sessions table directly, keeps `Sessions` the one owner of session-row shape and lets any future plugin reuse the identical parameter; `Admin` is simply the first caller to ever pass it.

**Self-act-as is refused in the primitive (IDS-008).** `Sessions.issue` (both layers) MUST die with `InvalidActingAs` when `actingAs` names the session's own user (`type: "user"`, `id === userId`) — a programming error in the producing plugin, so a defect, leaving `issue`'s public error channel unchanged. The nesting rule ([BEH-EA-214](27-admin-impersonation.md#beh-ea-214-self-impersonation-and-nested-impersonation-are-refused)) needs the *caller's* session, which `issue` never sees, so it stays with the producer; `Admin.impersonate` is the reference implementation.

_Previous: [BEH-EA-208](26-cli.md#beh-ea-208-the-cli-reads-the-manifest-it-never-runs-the-application) | Next: [BEH-EA-210](27-admin-impersonation.md#beh-ea-210-a-session-carrying-actingas-never-idle-refreshes)_

## BEH-EA-210: A session carrying `actingAs` never idle-refreshes

```text
REQUIREMENT: `Sessions.issue` MUST set `idleExpiresAt` equal to
             `absoluteExpiresAt` for a session issued with `actingAs`
             present; `Sessions.verify`'s idle-refresh touch (BEH-EA-052)
             MUST be skipped for any session whose `actingAs` is non-null,
             for the lifetime of that session.
```

This is [INV-EA-014](../invariants.md#inv-ea-014-an-impersonation-session-carries-a-hard-expiry-with-no-sliding-refresh)'s enforcement point, now backed by a real requirement instead of a planned one. `actingAs` being non-null is the complete signal — no separate "is this an impersonation session" flag exists or is needed, since the two facts (dual identity, hard expiry) always travel together for this plugin. Without this rule, an admin impersonating a user during an active support session could remain impersonating indefinitely simply by continuing to act, a materially worse blast radius than an ordinary session outliving its own absolute expiry.

_Previous: [BEH-EA-209](27-admin-impersonation.md#beh-ea-209-actingas-becomes-a-real-generic-field-on-session-issuance) | Next: [BEH-EA-211](27-admin-impersonation.md#beh-ea-211-resolveprincipal-closes-the-loop-to-userprincipalactingas)_

## BEH-EA-211: `resolvePrincipal` closes the loop to `UserPrincipal.actingAs`

```text
REQUIREMENT: `Authentication`'s `resolvePrincipal` MUST place a session
             row's `actingAs` (when present) onto the `UserPrincipal` it
             builds, unconditionally — the same row-to-principal mapping
             that already happens for `userId`/`sessionId`.
```

`spec/behaviors/18-roles-subject-resolver.md`'s BEH-EA-142 already requires that `SubjectResolver` place a principal's `actingAs` onto `AuthSubject.attributes.actingAs`, framed there as "a property `SubjectResolver` must honor if an `Admin` plugin is installed." This requirement is the other half BEH-EA-142 was written anticipating: the point where a session's `actingAs` actually reaches the `Principal` in the first place. Once both halves exist, the chain is unbroken: `Session.actingAs` → `UserPrincipal.actingAs` → `AuthSubject.attributes.actingAs`, with no plugin other than `Admin` ever needing to touch any of the three.

_Previous: [BEH-EA-210](27-admin-impersonation.md#beh-ea-210-a-session-carrying-actingas-never-idle-refreshes) | Next: [BEH-EA-212](27-admin-impersonation.md#beh-ea-212-the-admin-gate-is-a-config-supplied-predicate-fail-closed-by-default)_

## BEH-EA-212: The admin gate is a config-supplied predicate, fail-closed by default

```ts
interface AdminConfigShape {
  readonly maxDuration: Duration.Duration
  readonly canImpersonate: (input: { admin: AuthSubject; target: AuthSubject }) => Effect.Effect<boolean>
  readonly canManageEpisode: (input: { admin: AuthSubject; episode: ImpersonationRecord }) => Effect.Effect<boolean>
}
const AdminConfig: Context.Reference<AdminConfigShape>  // defaultValue: canImpersonate always false
```

```text
REQUIREMENT: `Admin` MUST NOT declare a `dependsOn` on any other plugin to
             gate impersonation. The check MUST be a config-supplied
             predicate over BOTH the caller's and the target's resolved
             `AuthSubject` (identity-only subjects; a host needing roles or
             tenant looks them up itself by id), with a fail-closed default
             (always denies) when the host application supplies none.
             `forceStop` and `list` MUST be gated per episode by
             `canManageEpisode`, which defaults to `canImpersonate`
             evaluated against the episode's target.
```

A hard dependency on `@awthaq/roles` specifically would force every consumer onto that one authorization mechanism, and would repeat the exact `dependsOn`-is-for-plugins-only mistake `@awthaq/passkey`'s own ticket 06 already found and corrected — `Sessions`/`Users` are core services a plugin reaches with a plain `yield*`, not something `dependsOn` exists for, and the same reasoning extends to "another plugin's role check," which `Admin` never needs to see as a plugin at all. A host that authorizes via `@awthaq/roles`, a qadi policy, or any other mechanism supplies `canImpersonate` itself. The fail-closed default gives `archive/PRD.md` §18's "impersonation off by default" two independent guarantees: the plugin must be installed, and it must be explicitly configured with a real predicate, before impersonation is ever reachable.

**IDS-001/MTI-006**: a caller-only predicate cannot refuse impersonating a more privileged (or another tenant's) account — the one decision an impersonation gate most needs to make — so the predicate receives the target too. Because stopping and listing episodes is the same privilege over the same target, they reuse that decision per episode (`canManageEpisode`, overridable) instead of a second, drift-prone predicate. `list` therefore filters rows rather than rejecting the call: a caller who may manage no episode sees an empty history (fail-closed without an existence oracle).

_Previous: [BEH-EA-211](27-admin-impersonation.md#beh-ea-211-resolveprincipal-closes-the-loop-to-userprincipalactingas) | Next: [BEH-EA-213](27-admin-impersonation.md#beh-ea-213-impersonate-issues-a-new-dual-identity-session-for-the-target)_

## BEH-EA-213: `impersonate` issues a new, dual-identity session for the target

```ts
yield* client.admin.impersonate({ params: { userId }, payload: { reason: "support ticket #4821" } })
// new session row: userId = target, actingAs = { type: "user", id: <admin's own id> }
// hard expiry = now + AdminConfig.maxDuration; no sliding refresh (BEH-EA-210)
// cookie mode: Set-Cookie __Host-impersonation=<token>; the admin's __Host-session is untouched
```

```text
REQUIREMENT: `impersonate` MUST reject a `reason` that is empty after
             trimming, or longer than 1000 characters. It MUST reject the
             call entirely (before issuing any session) when
             `AdminConfig.canImpersonate` resolves `false` for the caller's
             and target's subjects. After the gate passes, it MUST fail with
             `AdminTargetNotFound` (404) when the target user does not
             exist, issuing no session and writing no audit row (IDS-003;
             the gate runs first so a caller who fails it cannot use
             404-versus-403 to probe which user ids exist). On success, it MUST issue a new session for the
             target user with `actingAs` set to the caller's own identity,
             and MUST leave the caller's own existing session untouched —
             both sessions are valid and live at once. In cookie mode the
             new session MUST be delivered under `__Host-impersonation`
             (same attributes as `__Host-session`), never by overwriting
             `__Host-session` (APS-006).
```

`archive/PRD.md` §18 names "reason required" as its own named security-model property, independent of the hard-expiry/dual-identity properties this file's earlier requirements already cover. The caller's own session is deliberately never revoked or modified by this call: a bearer client already holds that session's own token and switches to the newly-issued impersonation session's token to act as the target; a browser holds both cookies at once, with `__Host-impersonation` shadowing `__Host-session` (BEH-EA-065) — see BEH-EA-216 for why no server-side "handback" step exists to reverse this.

**Decision (2026-09-29, APS-006):** adopted recommended option A (a distinct impersonation cookie) over handback/body-only/document-only; the user may revisit.

_Previous: [BEH-EA-212](27-admin-impersonation.md#beh-ea-212-the-admin-gate-is-a-config-supplied-predicate-fail-closed-by-default) | Next: [BEH-EA-214](27-admin-impersonation.md#beh-ea-214-self-impersonation-and-nested-impersonation-are-refused)_

## BEH-EA-214: Self-impersonation and nested impersonation are refused

```text
REQUIREMENT: `impersonate` MUST reject a call where the target user id
             equals the caller's own user id (`AdminSelfImpersonationRefused`),
             and MUST reject a call made from a session whose own principal
             already carries `actingAs` (`AdminAlreadyImpersonating`) —
             an impersonation session can never itself impersonate a
             further, different user.
```

Both are named, typed errors rather than a silent no-op or an unbounded chain. Nested impersonation in particular would otherwise let dual identity stack arbitrarily deep, defeating the "who is really behind the wheel" property `archive/PRD.md` §17 states as this plugin's whole reason to exist.

_Previous: [BEH-EA-213](27-admin-impersonation.md#beh-ea-213-impersonate-issues-a-new-dual-identity-session-for-the-target) | Next: [BEH-EA-215](27-admin-impersonation.md#beh-ea-215-admin_impersonation-is-a-durable-audit-trail)_

## BEH-EA-215: `admin_impersonation` is a durable audit trail

```ts
interface ImpersonationRecord {
  readonly id: string
  readonly adminUserId: UserId
  readonly targetUserId: UserId
  readonly sessionId: SessionId
  readonly reason: string
  readonly startedAt: DateTime.Utc
  readonly expiresAt: DateTime.Utc | null   // the session's hard expiry (IDS-004)
  readonly endedAt: DateTime.Utc | null
  readonly endedBy: "self" | "forcedByAdmin" | "expired" | null
  readonly tenantId: string | null            // the ambient tenant when it started (IDS-002)
}
```

```text
REQUIREMENT: `impersonate` MUST insert one `admin_impersonation` row per
             episode at the same time it issues the session (BEH-EA-213).
             `endedAt`/`endedBy` MUST be populated exactly once, by
             whichever of `stopImpersonating` (BEH-EA-216), `forceStop`
             (BEH-EA-217), or hard-expiry observation sets them first.
             The row MUST record the session's hard expiry (`expiresAt`).
             Hard-expiry observation MUST close every open episode whose
             `expiresAt` has passed as `endedBy: "expired"` (`endedAt` =
             its `expiresAt`), lazily before `list`/`forceStop` run and via
             an exported sweep (`Admin.sweepExpiredEpisodes`), publishing
             one `auth.admin.impersonationStopped { endedBy: "expired" }`
             per episode it closes, exactly once.

REQUIREMENT: The trail MUST be tamper-evident (ALF-005). The database MUST
             reject DELETE on `admin_impersonation` and any UPDATE of it
             other than closing an open episode (`endedAt`/`endedBy` while
             `endedAt` is still null). Every episode start and end MUST also
             be appended, in one transaction with the row change, to an
             append-only `admin_impersonation_chain` ledger whose links are
             chained with `AuditChain` (`rowHash = HMAC(key, prevHash ||
             payload)`, key optional). `ImpersonationRecords.verifyChain`
             MUST report the first ledger link that no longer verifies, or
             the first episode row that no longer matches, is missing from,
             or was never recorded in the ledger.
```

ALF-005 (decision recorded 2026-09-29: adopted recommended option C now + A, shared primitive; B — an external append-only sink — is left as an optional future port): a DBA can still drop the triggers, which is what the chain is for — editing, deleting or reordering a row, or forging one with raw SQL, is detectable by anyone holding the key. Without a configured key the chain is unkeyed SHA-256: it catches casual edits but can be recomputed end to end, so a host wanting forgery-evidence supplies `AuditChain.config({ key })`. Detecting truncation of the newest links needs an external anchor (an exported head hash) and is the host's. The primitive (`@awthaq/core`'s `AuditChain`) is table-agnostic; applying it to the core `audit_log` (BEH-EA-100) is tracked separately. The Postgres trigger DDL ships in the same migration but is untested here (SQLite only).

IDS-002 ([ADR-EA-018](../decisions/018-tenancy-is-an-organization.md)): the row records the ambient `TenantContext` at `impersonate` (`null` when none), frozen with the other start facts by the immutability triggers and included in the ledger payload only when set — so every link written before the column existed, and every single-tenant one, still verifies byte-for-byte. `findBySessionId`, `endEpisode` and `list` see only the ambient tenant's episodes (an untenanted request sees the untenanted ones — everything, in a single-tenant deployment) unless the caller opts into `{ anyTenant: true }`, which `Admin` does only for a caller passing `canAdministerTenants`, and for its own tenant-blind "is this an impersonation session" classification (so another tenant's impersonation session is never mistaken for an ordinary one by the user-session endpoints). `closeExpired` and `verifyChain` are maintenance over every tenant.

IDS-004: before this, `"expired"` was declared but nothing produced it, so a naturally-expired episode stayed reported `active` forever and the audit trail never closed. The close is a single atomic statement that returns only the rows it closed, so concurrent readers cannot double-announce an episode.

This is the table [MOD-EA-015](../models/15-admin-impersonation.md) named without specifying its shape. It exists independently of the `Session` row itself (BEH-EA-209): a session row can be deleted or expire out of any active-sessions view, but the audit record of who impersonated whom, when, and why must survive that, satisfying `archive/PRD.md` §18's "audit events" as real persisted history rather than only a transient event-bus emission.

_Previous: [BEH-EA-214](27-admin-impersonation.md#beh-ea-214-self-impersonation-and-nested-impersonation-are-refused) | Next: [BEH-EA-216](27-admin-impersonation.md#beh-ea-216-stopimpersonating-revokes-with-no-session-handback)_

## BEH-EA-216: `stopImpersonating` revokes with no session handback

```ts
yield* client.admin.stopImpersonating()   // acts on the caller's own current (impersonation) session
```

```text
REQUIREMENT: `stopImpersonating` MUST revoke the caller's own current
             session (which MUST carry `actingAs`, or the call fails) and
             set the matching `admin_impersonation` row's `endedAt`/
             `endedBy: "self"`. Revocation is the primary, idempotent act:
             it MUST NOT depend on the audit row (missing or already ended)
             and MUST NOT fail when the session is already gone; recording
             the episode end is best-effort after it (IDS-007). It MUST NOT issue any replacement session —
             the caller is expected to already hold their own original
             session's token from before `impersonate` was called. In
             cookie mode the response MUST expire `__Host-impersonation`
             (`Max-Age=0`), which is what returns the browser to the
             admin's own, still-live `__Host-session` (APS-006); `forceStop`
             of the caller's own current episode does the same.
```

Because BEH-EA-213 never touches the admin's original session, there is nothing to hand back: ending impersonation is purely a revocation of the session it added, not a restoration of one it never removed — clearing the shadowing cookie is all a browser needs.

_Previous: [BEH-EA-215](27-admin-impersonation.md#beh-ea-215-admin_impersonation-is-a-durable-audit-trail) | Next: [BEH-EA-217](27-admin-impersonation.md#beh-ea-217-forcestop-lets-another-admin-end-someone-elses-impersonation)_

## BEH-EA-217: `forceStop` lets another admin end someone else's impersonation

```ts
yield* client.admin.forceStop({ params: { sessionId } })
```

```text
REQUIREMENT: `forceStop` MUST look the episode up by the named session id
             (an unknown id, which cannot be an impersonation session, fails
             with `AdminImpersonationNotFound`) and MUST then be gated by
             `canManageEpisode` for that episode (IDS-001; by default the
             same `canImpersonate` decision over the episode's target).
             On success it MUST revoke the named session and set the
             matching `admin_impersonation` row's `endedAt`/`endedBy:
             "forcedByAdmin"`. Revocation is idempotent (an already-gone
             session, e.g. after the target's `revokeAll`, is not an error
             and never a defect) and MUST only ever be applied to a session
             an episode row proves is an impersonation session; an episode
             that had already ended is reported `AdminImpersonationNotFound`
             (its live session, if any, is still revoked) (IDS-007).

REQUIREMENT: An episode belonging to another tenant than the ambient one MUST
             be reported `AdminImpersonationNotFound`, exactly like an unknown
             id (IDS-002), unless the caller passes
             `AdminConfig.canAdministerTenants` (fail-closed by default), in
             which case `forceStop` may end any tenant's episode (still
             subject to `canManageEpisode`).
```

[MOD-EA-015](../models/15-admin-impersonation.md) named this explicitly as an undecided question. Resolved here: yes, an admin (any caller passing the same gate) can end another active impersonation episode, identified by the impersonation session's own id — the same id BEH-EA-219's listing endpoint surfaces — rather than inventing a second, parallel identifier space for it.

_Previous: [BEH-EA-216](27-admin-impersonation.md#beh-ea-216-stopimpersonating-revokes-with-no-session-handback) | Next: [BEH-EA-218](27-admin-impersonation.md#beh-ea-218-three-audit-events-bound-the-impersonation-lifecycle)_

## BEH-EA-218: Three audit events bound the impersonation lifecycle

```text
REQUIREMENT: `Admin` MUST publish `auth.admin.impersonationStarted` on a
             successful `impersonate` (carrying adminUserId, targetUserId,
             reason, sessionId), `auth.admin.impersonationStopped` on
             either stop path (carrying sessionId, endedBy), and
             `auth.admin.impersonationDenied` specifically when
             `canImpersonate` resolves `false` — never for
             `AdminSelfImpersonationRefused`, `AdminAlreadyImpersonating`,
             or an unknown target user, which are ordinary validation
             failures, not authorization-bypass attempts.
```

Scoping `impersonationDenied` to genuine gate rejections keeps it a real security-monitoring signal — "someone attempted privileged action without authorization" — rather than diluting it with unrelated input-validation noise. **Correction from this file's first draft**: `AuthEvents.ts`'s own header comment names `auth.session.issued` only as one of the *illustrative* tags its registry design anticipates, not a tag any code actually publishes yet — no `SessionIssuedEvent` exists in the current `AuthEvent` union. `impersonate`'s own `auth.admin.impersonationStarted` is this plugin's complete signal for "a session was issued with `actingAs` set"; this file does not require `Sessions.issue` to gain a generic, cross-plugin "session issued" event as a side effect of this plugin's own work — that would be a change to every other plugin's behavior (`Password`, `OAuth`, `Passkey` would all start publishing it too), well beyond what `Admin`'s own spec should mandate unilaterally.

_Previous: [BEH-EA-217](27-admin-impersonation.md#beh-ea-217-forcestop-lets-another-admin-end-someone-elses-impersonation) | Next: [BEH-EA-219](27-admin-impersonation.md#beh-ea-219-the-audit-trail-is-queryable)_

## BEH-EA-219: The audit trail is queryable

```ts
yield* client.admin.list()                         // first page of the history, newest first
yield* client.admin.list({ urlParams: { active: "true" } })  // endedAt IS NULL only
yield* client.admin.list({ urlParams: { limit: 50, cursor } }) // next page: { items, nextCursor }
```

```text
REQUIREMENT: `Admin` MUST expose a listing endpoint over `admin_impersonation`,
             filtering each row through `canManageEpisode` (IDS-001),
             returning history ordered newest-first by default, with an `active`
             filter narrowing to rows whose `endedAt` is still null. The
             listing MUST be keyset-paginated on `(startedAt, id)` — an
             opaque cursor in, `{ items, nextCursor }` out, `limit`
             defaulting to 50 and bounded to 1..200 on the wire, never an
             offset and never more than `limit + 1` rows read (BEH-EA-036;
             ESS-006). An expired episode MUST NOT be listed as active
             (IDS-004). The listing MUST show only the ambient tenant's
             episodes unless the caller passes `canAdministerTenants`
             (IDS-002), and the impersonation gates MUST be told the ambient
             `tenantId` so a host predicate can compare tenant affinity.
```

An audit trail nobody can query defeats much of its own purpose; both the "what happened" (full history) and "what's live right now" (support-ops needing a kill switch target for BEH-EA-217) shapes are real, distinct use cases over the same one table.

_Previous: [BEH-EA-218](27-admin-impersonation.md#beh-ea-218-three-audit-events-bound-the-impersonation-lifecycle) | Next: [BEH-EA-220](27-admin-impersonation.md#beh-ea-220-impersonation-never-touches-the-targets-own-sessions)_

## BEH-EA-220: Impersonation never touches the target's own sessions

```text
REQUIREMENT: Neither `impersonate`, `stopImpersonating`, `forceStop`, nor
             hard-expiry MUST ever revoke, list, or otherwise modify any
             session belonging to the target user. Impersonation is
             additive, parallel access — never a takeover of the target's
             own account.
```

A target user who is impersonated keeps using their own account, on their own sessions, exactly as before; nothing about being impersonated is visible to `Sessions`' own view of that user's session list, and no code path in this plugin ever iterates or touches it.

_Previous: [BEH-EA-219](27-admin-impersonation.md#beh-ea-219-the-audit-trail-is-queryable) | Next: [BEH-EA-221](27-admin-impersonation.md#beh-ea-221-user-and-session-administration-is-gated-per-capability-fail-closed-with-the-target-in-view)_

## BEH-EA-221: User and session administration is gated per capability, fail-closed, with the target in view

```ts
interface AdminConfigShape {
  // …BEH-EA-212…
  readonly canManageUsers: (input: {
    admin: AuthSubject
    target: Option<AuthSubject>   // None for a collection-level call (listUsers)
  }) => Effect.Effect<boolean>
  readonly canBanUsers: (input: {   // same shape; gates banUser / unbanUser
    admin: AuthSubject
    target: Option<AuthSubject>
  }) => Effect.Effect<boolean>
}
```

```text
REQUIREMENT: Every user- and session-administration operation (`listUsers`,
             `getUser`, `updateUser`, `listUserSessions`, `revokeUserSession`,
             `revokeUserSessions`) MUST be gated by
             `AdminConfig.canManageUsers`, and `banUser`/`unbanUser` by its
             own `AdminConfig.canBanUsers`; both MUST deny by default. The
             predicate MUST receive the target user (identity-only
             `AuthSubject`, like BEH-EA-212) for every per-user operation.
             The gate MUST run before the target's existence is checked, so a
             caller who fails it cannot use 404-versus-403 to probe which
             user ids exist; an unknown user is then `AdminTargetNotFound`
             (404). A denied call fails `AdminActionDenied` (403) and
             publishes `auth.admin.actionDenied` (BEH-EA-224) — never
             `impersonationDenied`, which stays specific to BEH-EA-212/218.
```

BAM-005 (wayfinder ticket 19 §1): an admin plugin that only impersonates cannot run a support desk. Each capability has its own predicate — `canManageUsers`, `canBanUsers` (BAM-005's ban slice, below), and `canAdministerTenants` when tenant administration lands — so a deployment enables exactly the powers it means to, and impersonation being on says nothing about user administration. The target is in the gate's view for the reason BEH-EA-212's IDS-001 amendment gives: a caller-only predicate cannot refuse an operation on a more privileged account. **Banning is a separate capability with the shared gate behind it (SCP-001).** `banUser(userId, { reason?, until? })` (`POST /admin/users/:userId/ban`) runs, in this order, the `canBanUsers` gate (failing `AdminActionDenied` and publishing `auth.admin.actionDenied` with action `banUser`), a refusal to ban oneself (`AdminSelfBanRefused`, 400), the existence check (`AdminTargetNotFound`), `Users.setStatus(userId, "suspended", …)` and `Sessions.revokeAll(userId, "suspended")` — every session of the user, impersonation sessions issued *as* them included, since the account's access ends as a whole — and finally publishes `auth.admin.userBanned { adminUserId, userId, reason, until }`. The block itself is `Users.assertCanSignIn` (BEH-EA-046), which password, passkey and OAuth sign-in each consult, so a banned user is refused `UserSuspended` (403) at every sign-in path while the admin surface still resolves them (`getUser`, `unbanUser`). `unbanUser` (`POST /admin/users/:userId/unban`) is `Users.setStatus(userId, "active")` plus `auth.admin.userUnbanned`; nothing was deleted, so the user simply signs in again. A timed ban (`until`) lapses by itself at that instant without any write. The reason is an operator note: it is returned to administrators (`UserDto.statusReason`) and never to the banned user.

**Role assignment (`setRole`) is deliberately not an admin endpoint** (ADR-EA-009, wayfinder ticket 19 §2): who holds which role is a qadi/application concern, and duplicating it here would put a second authority next to the authorization library.

_Previous: [BEH-EA-220](27-admin-impersonation.md#beh-ea-220-impersonation-never-touches-the-targets-own-sessions) | Next: [BEH-EA-222](27-admin-impersonation.md#beh-ea-222-users-are-listed-keyset-paginated-read-and-updated-through-the-admin-surface)_

## BEH-EA-222: Users are listed keyset-paginated, read, and updated through the admin surface

```ts
yield* client.admin.listUsers({ urlParams: { limit: 50, cursor } })   // { items, nextCursor }
yield* client.admin.getUser({ params: { userId } })
yield* client.admin.updateUser({ params: { userId }, payload: { name: "Ada", metadata: null } })
```

```text
REQUIREMENT: `listUsers` MUST be keyset-paginated on `(createdAt, id)` (oldest
             first) through `Users.list` — an opaque cursor in, `{ items,
             nextCursor }` out, `limit` defaulting to 50 and bounded to 1..200
             on the wire, never an offset and never more than `limit + 1`
             rows read (BEH-EA-036); a malformed cursor is a 400. `updateUser`
             MUST change only what `Users.updateProfile` can — `name`
             (non-blank, at most 200 characters) and `metadata` (left out:
             untouched; `null`: cleared) — never `email` or `emailVerified`
             (BEH-EA-042), and MUST publish `auth.admin.userUpdated`
             (BEH-EA-224).
```

The admin surface reuses the same domain operations a user's own `Account` endpoints use rather than a second write path, so BEH-EA-041/042's invariants hold identically here. Changing a user's password and deleting a user remain separate capabilities (tracked under BAM-005): password writes belong to the password plugin and deletion needs the single shared erasure cascade. The domain now has `Users.changeEmail` (BEH-EA-042) but no admin endpoint uses it yet, because an admin-set address must itself be verified by the owner. `UserDto` carries the identity union (`identity`), `image`, `status`, `statusReason` and `suspendedUntil` in place of the former flat `email`/`emailVerified`.

_Previous: [BEH-EA-221](27-admin-impersonation.md#beh-ea-221-user-and-session-administration-is-gated-per-capability-fail-closed-with-the-target-in-view) | Next: [BEH-EA-223](27-admin-impersonation.md#beh-ea-223-an-admin-manages-a-users-own-sessions-never-an-impersonation-episodes)_

## BEH-EA-223: An admin manages a user's own sessions, never an impersonation episode's

```ts
yield* client.admin.listUserSessions({ params: { userId } })
yield* client.admin.revokeUserSession({ params: { userId, sessionId } })   // 204
yield* client.admin.revokeUserSessions({ params: { userId } })              // 204
```

```text
REQUIREMENT: `listUserSessions` MUST list only sessions that belong to the named
             user and are not impersonation sessions (no `admin_impersonation`
             row). `revokeUserSession` MUST revoke a session only if it appears
             in that list, answering `AdminSessionNotFound` (404)
             identically for an unknown id, another user's session, and an
             impersonation session — no ownership oracle — and MUST treat a
             session that vanished in between as success.
             `revokeUserSessions` MUST revoke every session in that list and
             MUST leave impersonation sessions alone. Both publish
             `auth.admin.sessionRevoked` (BEH-EA-224).
```

An impersonation session carries the target's `userId`, so a naive "all of this user's sessions" would also kill a support episode without closing its audit row. Episodes have their own lifecycle and controls (BEH-EA-216/217, `forceStop`); user-session administration stays strictly on the user's own credentials.

_Previous: [BEH-EA-222](27-admin-impersonation.md#beh-ea-222-users-are-listed-keyset-paginated-read-and-updated-through-the-admin-surface) | Next: [BEH-EA-224](27-admin-impersonation.md#beh-ea-224-admin-actions-are-audited-by-events)_

## BEH-EA-224: Admin actions are audited by events

```text
REQUIREMENT: `Admin` MUST publish `auth.admin.actionDenied { adminUserId,
             action }` when `canManageUsers` resolves `false`,
             `auth.admin.userUpdated { adminUserId, userId }` after a
             successful `updateUser`, `auth.admin.userBanned {
             adminUserId, userId, reason, until }` after `banUser` and
             `auth.admin.userUnbanned { adminUserId, userId }` after
             `unbanUser` (the sweep that ends the sessions is announced by
             `Sessions` itself as `auth.session.revoked` with reason
             `suspended`), and `auth.admin.sessionRevoked {
             adminUserId, userId, sessionId }` after `revokeUserSession`
             (`sessionId: null` after `revokeUserSessions`). All of these are
             `AuthEvent` members, so `AuditLog` (BEH-EA-100) records them
             durably with `adminUserId` as the actor.
```

Denials, changes and revocations are exactly the events a security review reconstructs "who did what to whom" from; making them `AuthEvent`s (rather than logs) puts them on the durable audit path BEH-EA-100 already guarantees, with no per-plugin persistence.

_Previous: [BEH-EA-223](27-admin-impersonation.md#beh-ea-223-an-admin-manages-a-users-own-sessions-never-an-impersonation-episodes) | Next: [BEH-EA-225](28-tenancy.md#beh-ea-225-the-tenant-is-an-ambient-reference-that-defaults-to-none)_
