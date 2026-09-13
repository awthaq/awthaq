# Users and Accounts

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-06 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | effect-auth Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |

---

> effect-auth is pre-implementation (see `spec/README.md`). Every signature, requirement, and behavior in this file specifies intended design — drawn from `archive/PRD.md` §13 and, by comparison, `better-auth/01-core-domain/01-entities-and-invariants.md` — not code that has shipped.

## BEH-EA-041: A User is identified by a case-insensitively unique email

```ts
class User extends Model.Class<User>("User")({
  id: Model.UuidV7Insert,
  email: Schema.String,
  emailVerified: Schema.Boolean,
  name: Schema.String
}) {}
```

```text
REQUIREMENT: No two `User` rows MAY hold the same email compared
             case-insensitively; an email MUST be lower-cased before it is
             compared or stored, and the constraint MUST be enforced at the
             schema level, not by application-level lookup discipline alone.
```

`better-auth/01-core-domain/01-entities-and-invariants.md` §2.1 documents email uniqueness as better-auth's primary identity key, enforced by a schema-level unique constraint, and effect-auth's plan follows the same choice for the same reason: it is the key both password sign-in and OAuth implicit account matching rely on. The same source file's note is worth carrying forward as a documented constraint rather than an eternal one — requiring email specifically is "the *current* invariant, not an eternal one," and any future relaxation toward a wider identity key must be an explicit, versioned design change, never a silent one.

## BEH-EA-042: `emailVerified` is monotone and never client-settable through a generic write

```text
REQUIREMENT: `emailVerified` MUST default to `false` at creation, MUST NOT
             be settable by a client through the ordinary create/update
             path, and MUST only transition `false → true` — no core
             operation may reset it to `false` once true.
```

`better-auth/01-core-domain/01-entities-and-invariants.md` §2.1-§2.2 documents this as a supplier-authority-only field, flipped only by specific, audited operations (consuming an email-verification token, an OAuth sign-in whose provider already verified a matching email), and monotone thereafter. effect-auth's plan carries the same invariant but intends to enforce the "never client-settable" half structurally, through `Model.Class`'s field-level write gating, rather than through the `input:false` convention better-auth's own §6.2 documents as a default a field author must opt into and can therefore forget.

## BEH-EA-043: An Account is identified by `(providerId, subject)`, enforced as a schema-level unique constraint

```text
REQUIREMENT: The pair `(providerId, subject)` MUST identify at most one
             `Account` row, and that uniqueness MUST be a database-level
             constraint — never application-level lookup discipline alone.
```

`better-auth/01-core-domain/01-entities-and-invariants.md` §3.1 documents better-auth's deliberately weaker choice here: `(providerId, accountId)` uniqueness is maintained only by application-level query discipline ("query with a small limit and treat more than one match as a defect"), not a database constraint, accepting a race window between two concurrent link operations. effect-auth's plan deliberately strengthens this: `archive/PRD.md` §18 lists "`(provider, subject, issuer)` uniqueness" among its security-model guarantees, and the design intent is a schema-level constraint from the start rather than a documented, best-effort weaker guarantee a deployment must remember to add.

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

`better-auth/01-core-domain/01-entities-and-invariants.md` §3.3 documents exactly this pattern and its consequence: because `(providerId, subject)` identifies at most one row (BEH-EA-043) and `subject` is pinned to the user's own id, a `User` can have at most one usable password credential in practice, and an OAuth-only signup simply has no such row at all. effect-auth's plan adopts this pattern unchanged, since it is what makes the next behavior (BEH-EA-045) a well-formed rule to state in the first place.

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

`better-auth/01-core-domain/01-entities-and-invariants.md` §3.4 states the reasoning this design carries forward unchanged: "a Session's validity is tied to the User, not to any one linked identity." Unlinking the `google` account from a user who also has a password credential must leave every live session, and every other linked account, intact — a session's authority derives from the user record, never from the specific identity that happened to establish it.

## BEH-EA-047: A User may have any number of Accounts and any number of concurrent Sessions

```text
REQUIREMENT: The base domain model MUST NOT cap the number of Accounts one
             User may link, nor the number of simultaneously valid Sessions
             one User may hold; a "single active session" policy, if
             wanted, is a capability layered on top by a plugin or
             deployment, never an implied base-model limit.
```

`better-auth/01-core-domain/01-entities-and-invariants.md` §3.2 and §4.2 document the identical cardinality choice — no base-system cap on linked providers, no base-system cap on concurrent sessions — and effect-auth's plan matches it directly: a User with a password credential, two OAuth providers, and a passkey is an ordinary, fully-supported state, as is a user signed in simultaneously on a laptop, a phone, and a CI service account acting on their behalf.

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

`better-auth/01-core-domain/01-entities-and-invariants.md` §6.2 documents this as the extension mechanism's sharpest edge and assigns blame precisely: a plugin that omits the write-gate on a system-authority field it contributes is the party responsible for the resulting corruption, "not the base system, and not whichever other plugin later trusts the now-corrupted field as authoritative." effect-auth's plan inherits the same default and the same blame rule, while narrowing where a plugin may contribute such a field at all — per BEH-EA-040, a shared-table extension is scalar-only and mediated by a declared extension point, which shrinks, but does not eliminate, the surface this rule has to cover.

_Previous: [BEH-EA-040](05-persistence-stratum.md#beh-ea-040-a-plugin-migration-may-only-alter-tables-under-its-own-prefix-shared-tables-are-altered-only-through-a-declared-extension-point)_
_Next: [BEH-EA-049](07-sessions.md#beh-ea-049-a-session-token-is-an-opaque-idsecret-pair)_
