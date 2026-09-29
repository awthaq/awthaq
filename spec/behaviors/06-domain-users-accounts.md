# Users and Accounts

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-06 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001); 1.1 (2026-09-29): the identity union, phone identity, suspension state, profile image and email change (wayfinder ticket 09 — FAMS-002/SAM-003/SCP-001/SOS-008/BAM-009) revise BEH-EA-041/042/046 in place |

---

> awthaq is pre-implementation (see `spec/README.md`). Every signature, requirement, and behavior in this file specifies intended design — drawn from `archive/PRD.md` §13 and, by comparison, `better-auth/01-core-domain/01-entities-and-invariants.md` — not code that has shipped.

## BEH-EA-041: A User is identified by a case-insensitively unique email

```ts
// Domain layer (Revision 1.1): the identity a user is known by is a tagged union.
type UserIdentity =
  | { _tag: "Email"; email: string; emailVerified: boolean }
  | { _tag: "Phone"; phone: E164; phoneVerified: boolean }
  | { _tag: "Anonymous" }

interface UserRecord {
  id: UserId
  identity: UserIdentity
  name: string
  metadata: Option<string>
  image: Option<string>
  status: "active" | "suspended"        // BEH-EA-046
  createdAt: DateTime.Utc
  updatedAt: DateTime.Utc
}

// Storage: the union is stored flattened, so both uniqueness rules stay real constraints.
class User extends Model.Class<User>("User")({
  id: Model.UuidV7Insert,
  email: Schema.NullOr(Schema.String),   // UNIQUE (lower(email)); NULL for Phone/Anonymous
  emailVerified: Schema.Boolean,
  phone: Schema.NullOr(E164),            // UNIQUE (phone) WHERE phone IS NOT NULL
  phoneVerified: Schema.Boolean,
  name: Schema.String
  // …metadata, image, status…
}) {}
```

```text
REQUIREMENT: No two `User` rows MAY hold the same email compared
             case-insensitively; an email MUST be lower-cased before it is
             compared or stored, and the constraint MUST be enforced at the
             schema level, not by application-level lookup discipline alone.
             (Revision 1.1) A user's identity MUST be exactly one of `Email`,
             `Phone` (E.164) or `Anonymous`; no phone number MAY be held by
             two users; `Anonymous` carries no uniqueness key, so any number
             of anonymous users coexist. An `Anonymous` user MUST be
             upgradeable in place to `Email` or `Phone` through
             `Users.promoteIdentity` — same `UserId`, so every Account and
             Session follows — and a user that already has an identity MUST
             be refused (`IdentityMismatch`). No production code MAY
             fabricate an email for a user that has none.
```

**Revision 1.1 (wayfinder ticket 09; FAMS-002, SAM-003, SOS-008).** The paragraph below records that requiring email "is the current invariant, not an eternal one"; this revision is that explicit, versioned change. `Users.create` takes `{ identity, name, metadata?, image? }` with `identity` an `IdentityInput` (no verified flag, ever — BEH-EA-042) and fails `EmailAlreadyExists` / `PhoneAlreadyExists` only for its own kind. Phones are normalized at the boundary: `Phone.normalizePhone` (strip separators, `+`/`00` prefix or a configured default country code) is the only way to mint the branded `E164` that `create`/`promoteIdentity`/`findByPhone` accept, so three spellings of one number resolve to one stored value and the type system keeps raw strings out of storage; it is a well-formedness floor, not a dialability check. The SQL layer keeps `email`, `emailVerified`, `phone`, `phoneVerified` as columns and folds them into the union in one place (`toUserRecord`); a row with both an email and a phone is not a state any writer produces and reads as a defect. `Users.createOrGet` (SCP-003) is the idempotent create — an existing holder of the email/phone is returned with `created: false`, atomically in both layers (one `Ref.modify`; `INSERT … ON CONFLICT DO NOTHING RETURNING *`, which does not abort an enclosing Postgres transaction) — and `UserImport.importUser` (AOMS-008) builds the transactional, re-runnable import on it. An OAuth profile with no email creates an `Anonymous` user, not a synthetic address (FAMS-002). The verification-token identifier for phone proof is `verify-phone:<userId>` (BEH-EA-057), the payload carrying the normalized number.

The one fold is JavaScript's `String.prototype.toLowerCase()`, applied at the domain boundary (ESR-003): `Users.create` stores the folded value, and `Users.findByEmail` folds its argument before the repository binds it, so lookups behave identically on the in-memory, SQLite and Postgres backends for non-ASCII addresses too (SQLite's own `lower()` folds ASCII only). The repository compares `lower(email)` on the column side against the already-folded parameter, so the `lower(email)` expression index still serves the lookup and the database never sees a non-normalized value.

`better-auth/01-core-domain/01-entities-and-invariants.md` §2.1 documents email uniqueness as better-auth's primary identity key, enforced by a schema-level unique constraint, and awthaq's plan follows the same choice for the same reason: it is the key both password sign-in and OAuth implicit account matching rely on. The same source file's note is worth carrying forward as a documented constraint rather than an eternal one — requiring email specifically is "the *current* invariant, not an eternal one," and any future relaxation toward a wider identity key must be an explicit, versioned design change, never a silent one.

## BEH-EA-042: `emailVerified` is monotone and never client-settable through a generic write

```text
REQUIREMENT: `emailVerified` MUST default to `false` at creation, MUST NOT
             be settable by a client through the ordinary create/update
             path, and MUST only transition `false → true` — no core
             operation may reset it to `false` once true, with one
             exception: replacing the address (`Users.changeEmail`), which
             installs a new, unproven address and so starts `false`.
             (Revision 1.1) `phoneVerified` follows the same rule for the
             `Phone` identity, through `Users.verifyPhone`; "verified" is a
             property of the identity variant, so it cannot be true while
             there is no email/phone to verify.
```

**Revision 1.1 additions.** The union shape makes "verified without an address" unrepresentable; `verifyEmail`/`verifyPhone` on the wrong identity kind fail `IdentityMismatch`. `Users.changeEmail(id, newEmail)` (BAM-009) is a *primitive*: it lower-cases, enforces uniqueness (`EmailAlreadyExists`) and resets `emailVerified`, but does not prove the caller owns the new address — the verified flow (mail a `change-email` token to the *new* address, then `changeEmail` + `verifyEmail` in one transaction, BEH-EA-058) belongs to the caller, and changing to the current address is a no-op that keeps the earned verification. The one sanctioned import exception (AOMS-008): `UserImport.importUser({ verified: true })` records that the *source* IdP already proved the address, through `verifyEmail`/`verifyPhone` (so it can never un-verify an existing user) — skipping it would lock every imported user out of a `requireVerifiedEmail` sign-in. The profile image (`image`, NAM-009/BAM-009) is client-writable like `name`, but only as a bounded `http(s)` URL: it is rendered by frontends, and a stored `javascript:`/`data:` value would be an XSS vector; OAuth avatars are applied only at first sign-up and pass the same check.

`better-auth/01-core-domain/01-entities-and-invariants.md` §2.1-§2.2 documents this as a supplier-authority-only field, flipped only by specific, audited operations (consuming an email-verification token, an OAuth sign-in whose provider already verified a matching email), and monotone thereafter. The OAuth plugin is one sanctioned caller of `verifyEmail` (AOMS-007): a first-time (just-in-time) sign-up through a provider named in `trustedProviders` that asserts `email_verified` marks the new user verified inside the creating transaction — it is a plugin-mediated operation, not a client-settable write, and no other OAuth path (auto-link, explicit link) calls it. awthaq's plan carries the same invariant but intends to enforce the "never client-settable" half structurally, through `Model.Class`'s field-level write gating, rather than through the `input:false` convention better-auth's own §6.2 documents as a default a field author must opt into and can therefore forget.

## BEH-EA-043: An Account is identified by `(providerId, subject)`, enforced as a schema-level unique constraint

```text
REQUIREMENT: The pair `(providerId, subject)` MUST identify at most one
             `Account` row, and that uniqueness MUST be a database-level
             constraint — never application-level lookup discipline alone.
```

`better-auth/01-core-domain/01-entities-and-invariants.md` §3.1 documents better-auth's deliberately weaker choice here: `(providerId, accountId)` uniqueness is maintained only by application-level query discipline ("query with a small limit and treat more than one match as a defect"), not a database constraint, accepting a race window between two concurrent link operations. awthaq's plan deliberately strengthens this: `archive/PRD.md` §18 lists "`(provider, subject, issuer)` uniqueness" among its security-model guarantees, and the design intent is a schema-level constraint from the start rather than a documented, best-effort weaker guarantee a deployment must remember to add.

## BEH-EA-044: A password credential is an ordinary Account row, not a separate entity

```text
providerId = "password"
subject    = <the owning User's own id>
```

```text
REQUIREMENT: A password credential MUST be represented as an `Account` row
             with `providerId = "password"` and `subject` equal to the
             owning `User`'s own id; "does this user have a password" MUST
             be answered by the presence or absence of that row, never by a
             nullable flag on `User`.
```

`better-auth/01-core-domain/01-entities-and-invariants.md` §3.3 documents exactly this pattern and its consequence: because `(providerId, subject)` identifies at most one row (BEH-EA-043) and `subject` is pinned to the user's own id, a `User` can have at most one usable password credential in practice, and an OAuth-only signup simply has no such row at all. awthaq's plan adopts this pattern unchanged, since it is what makes the next behavior (BEH-EA-045) a well-formed rule to state in the first place.

## BEH-EA-045: A User is never left with zero linked credentials by an unlink operation

```text
REQUIREMENT: Unlinking an Account MUST be refused when it is the User's
             last remaining Account, unless the deployment's policy
             explicitly allows it; a refusal MUST be attributable to the
             request itself (the caller asked for something that would
             leave the user unable to authenticate), not to a system
             defect.
```

`better-auth/01-core-domain/01-entities-and-invariants.md` §3.4 documents the identical rule and its blame assignment: the request is well-formed, but its effect — zero ways to authenticate — is exactly what the precondition exists to prevent. `archive/PRD.md` §11 (passkey removal, "refuses to remove the last credential when no other method exists") and §17 (unlink) both restate the same guarantee for their own credential types, so this is one rule enforced uniformly across every credential-bearing plugin, not re-derived per plugin.

## BEH-EA-046: Deleting a User cascades to its Accounts and Sessions; deleting or unlinking an Account never cascades to Sessions

```text
REQUIREMENT: Deleting a `User` row MUST make every `Account` and `Session`
             row referencing it unreachable (cascade); deleting or
             unlinking one `Account` row MUST NOT affect any other Account
             or any Session belonging to the same User.
```

**Suspension is never deletion (Revision 1.1; SCP-001, BAM-005).** A `User` also has `status: "active" | "suspended"` (with an operator-only reason and an optional expiry). `Users.setStatus(id, status, { reason?, until? })` is the *only* writer of `status`: `updateProfile` has no such field and the SQL `update` variant excludes the columns, so no generic write can reach it. `setStatus` leaves Accounts and Sessions alone (the caller — an admin, a SCIM handler — composes `Sessions.revokeAll(id, "suspended")`), and reactivating restores sign-in with every row intact; `delete` keeps the destructive cascade above unchanged, and SCIM `active:false` maps to suspension, not deletion. One shared gate, `Users.assertCanSignIn(user)`, fails `UserSuspended` (403, no body) for a user whose suspension is in force at the current instant (a `suspendedUntil` in the past has lapsed with no write); password sign-in, passkey `authenticateVerify` and the OAuth callback each call it with the `UserRecord` they already hold, *after* the credential proof and *before* `Sessions.issue`, so a wrong credential never learns whether an account is suspended. It is deliberately a plain call, not a hook point (a tap left out of a composition would silently un-gate a flow), and deliberately not inside `Users.findById` (an administrator must still resolve and reactivate a suspended user); admin impersonation does not consult it.

`better-auth/01-core-domain/01-entities-and-invariants.md` §3.4 states the reasoning this design carries forward unchanged: "a Session's validity is tied to the User, not to any one linked identity." Unlinking the `google` account from a user who also has a password credential must leave every live session, and every other linked account, intact — a session's authority derives from the user record, never from the specific identity that happened to establish it.

## BEH-EA-047: A User may have any number of Accounts and any number of concurrent Sessions

```text
REQUIREMENT: The base domain model MUST NOT cap the number of Accounts one
             User may link, nor the number of simultaneously valid Sessions
             one User may hold; a "single active session" policy, if
             wanted, is a capability layered on top by a plugin or
             deployment, never an implied base-model limit.
```

`better-auth/01-core-domain/01-entities-and-invariants.md` §3.2 and §4.2 document the identical cardinality choice — no base-system cap on linked providers, no base-system cap on concurrent sessions — and awthaq's plan matches it directly: a User with a password credential, two OAuth providers, and a passkey is an ordinary, fully-supported state, as is a user signed in simultaneously on a laptop, a phone, and a CI service account acting on their behalf.

**The opt-in cap is that deployment capability (SMS-003).** `SessionConfig.maxConcurrent` (`{ limit, onExceed: "evictOldest" }`) is absent by default, so nothing above changes. When configured, `Sessions.issue` — in the same atomic step as the insert (one `Ref.modify` in `layerMemory`, one transaction in `layerSql`) — ends the least-recently-active surplus of the user's live sessions so that no more than `limit` remain, and publishes `auth.session.revoked` with reason `limitEvicted` for each ([BEH-EA-101](13-events.md)); `issue`'s error channel is unchanged. Impersonation (`actingAs`) sessions neither count toward nor trigger the cap, so an admin's support session can never end the target's own sessions. A `refuse` policy would need a typed, user-facing error in `issue`'s channel and is not part of v1.

## BEH-EA-048: A plugin-contributed field on `User` or `Account` defaults to client-writable unless the plugin declares otherwise

```text
REQUIREMENT: A field a plugin contributes to `User`, `Account`, or `Session`
             MUST be writable through the generic input path by default;
             if a plugin intends a contributed field to carry
             system-authority meaning (an elevation flag, a billing tier),
             that plugin's own schema MUST declare it non-writable
             explicitly — the base system provides no default protection
             for a field it did not itself define.
```

`better-auth/01-core-domain/01-entities-and-invariants.md` §6.2 documents this as the extension mechanism's sharpest edge and assigns blame precisely: a plugin that omits the write-gate on a system-authority field it contributes is the party responsible for the resulting corruption, "not the base system, and not whichever other plugin later trusts the now-corrupted field as authoritative." awthaq's plan inherits the same default and the same blame rule, while narrowing where a plugin may contribute such a field at all — per BEH-EA-040, a shared-table extension is scalar-only and mediated by a declared extension point, which shrinks, but does not eliminate, the surface this rule has to cover.

**Interim guidance until the extension point ships (SAM-004).** The typed `userFields` extension point (`AuthPlugin` option, linker-enforced `${id}_${field}` columns, typed `getFields`/`setFields`, `clientWritable` gating of the HTTP profile payload) is not implemented: nothing in the shipped code contributes a field to `User`. Meanwhile application data belongs in `UserRecord.metadata` — an opaque, server-only-writable string that no HTTP payload can set (`UpdateProfilePayload` is `{ name, image }`; `metadata` is written only by trusted server code such as an import or the admin surface) — or in a plugin-prefixed side table keyed by `UserId`. Anything a policy or an authorization decision may rely on MUST live in one of those two server-only places and MUST NOT be a client-writable field; the only client-writable profile fields today are `name` and `image`.

_Previous: [BEH-EA-040](05-persistence-stratum.md#beh-ea-040-a-plugin-migration-may-only-alter-tables-under-its-own-prefix-shared-tables-are-altered-only-through-a-declared-extension-point)_
_Next: [BEH-EA-049](07-sessions.md#beh-ea-049-a-session-token-is-an-opaque-idsecret-pair)_
