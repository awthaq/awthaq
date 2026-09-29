# The Persistence Stratum

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-05 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |

---

> awthaq is pre-implementation (see `spec/README.md`). Every signature, requirement, and behavior in this file specifies intended design — drawn from `archive/PRD.md` §12 and `research/10-schema-migrations.md` — not code that has shipped.

## BEH-EA-033: Every entity is a `Model.Class` with `Model.UuidV7Insert` ids

> **See:** [ADR-EA-004](../decisions/004-database-neutral-models.md)

```ts
class User extends Model.Class<User>("User")({
  id: Model.UuidV7Insert,
  email: Schema.String,
  emailVerified: Schema.Boolean,
  createdAt: Model.DateTimeInsert,
  updatedAt: Model.DateTimeUpdate
}) {}
```

```text
REQUIREMENT: `User`, `Account`, `Session`, and `VerificationToken` MUST each
             be declared as a `Model.Class`, with a `Model.UuidV7Insert` id
             assigned by the supplier, never accepted as client input on
             the ordinary creation path.
```

`archive/PRD.md` §12 fixes `Model.Class` as the one entity-definition mechanism, from which validation schemas, JSON variants, and repository helpers are all derived, rather than declared three separate times. `better-auth/01-core-domain/01-entities-and-invariants.md` §1 documents the same base-contract shape (an opaque, supplier-assigned `id`) as the invariant every one of better-auth's four core entities shares; awthaq's plan is to make that shared base a property of `Model.Class` itself rather than a convention each entity's author must repeat.

## BEH-EA-034: `Model.Sensitive` fields never appear in any JSON variant of an entity

```ts
class Account extends Model.Class<Account>("Account")({
  id: Model.UuidV7Insert,
  passwordHash: Model.Sensitive(Schema.String),
  accessToken: Model.Sensitive(Schema.Redacted(Schema.String))
}) {}
```

```text
REQUIREMENT: A field declared `Model.Sensitive` MUST be excluded from every
             derived JSON-encoding variant of its entity, so that no
             handler can accidentally serialize it into an HTTP response
             merely by returning the entity value.
```

`archive/PRD.md` §12 and §18 both require this: "`Model.Sensitive` for hashes and secrets so they never appear in JSON variants," and separately, "contract tests assert no `Redacted` value reaches spans or events." `better-auth/01-core-domain/01-entities-and-invariants.md` §6.1 documents the analogous rule in better-auth's schema (`returned:false` on `password`, `accessToken`, `refreshToken`, `idToken`) as a per-field attribute a schema author must set correctly; awthaq's plan folds the same guarantee into `Model.Sensitive` so the exclusion is a type-level fact about the field, not an attribute that could be omitted.

## BEH-EA-035: Repositories are built with `SqlModel.makeRepository` over the ambient `SqlClient`, never opening their own transactions

```ts
const repo = yield* SqlModel.makeRepository(User, { tableName: "users", spanPrefix: "Users", idColumn: "id" })
```

```text
REQUIREMENT: A repository MUST be a `Context.Service` built via
             `SqlModel.makeRepository` (plus `SqlSchema` for typed one-off
             queries) against the ambient `SqlClient`; a repository method
             MUST NOT call `SqlClient.withTransaction` itself — transaction
             boundaries are the calling domain service's responsibility.
```

`research/10-schema-migrations.md` Q72 documents why: `SqlClient.withTransaction`'s nested calls become savepoints rather than independent transactions, so a repository that opened its own transaction internally would silently change the atomicity boundary any caller composing two repository calls expects. Keeping repositories transaction-agnostic and letting the domain service (`Password.confirmReset`, for instance, consuming a token and rotating a session in one transaction — see [BEH-EA-058](08-verification-tokens.md#beh-ea-058-a-verification-tokens-consumption-and-the-state-change-it-authorizes-commit-in-one-transaction)) hold the boundary is what keeps composition safe.

## BEH-EA-036: Pagination is keyset-only; no repository interface accepts an offset

```ts
type Cursor = { readonly createdAt: DateTime.Utc; readonly id: string }
listByUser: (userId: UserId, now: DateTime.Utc, cursor?: Cursor, limit?: number) => Effect.Effect<Page<Session>, RepositoryError>
```

```text
REQUIREMENT: No repository's public interface MAY accept an offset
             parameter; every paginated query MUST accept an opaque cursor
             derived from `(createdAt, id)` and return the next cursor
             alongside the page.
```

`research/10-schema-migrations.md` Q72 and Q79 cite the reason directly: offset pagination forces the database to walk and discard every skipped row, a cost that grows linearly with the offset (Winand, "No Offset"; Slack's own migration off offset pagination is cited as the production case study). Session and verification-token tables are append-mostly with a monotonic `(createdAt, id)`, which is exactly the shape a keyset cursor needs — a tiebreaker on `id` is required because timestamps alone can collide within the same millisecond.

Two refinements bind the session page query specifically. **Index-aligned (PPS-002):** the cursor is a row-value comparison `("createdAt", id) > (?, ?)` served by the partial composite index `sessions_user_created_live ON sessions("userId", "createdAt", id) WHERE "supersededAt" IS NULL` (migration 18), so filter and order need no sort node. **Bounded by construction (ESR-010):** `listByUser` clamps the page size to `[1, MAX_PAGE_SIZE]` (200) and the request schema enforces the same bound, so no caller-supplied limit can produce a `SqlError` or an unbounded page; the query also takes the caller's clock and lists only live (unexpired, non-tombstoned) rows (SMS-002, [BEH-EA-054](07-sessions.md#beh-ea-054-sessions-expose-a-device-list-per-device-revocation-and-revoke-others)).

## BEH-EA-037: A plugin's migrations are v4 `Migrator` records, exported statically per plugin

```ts
readonly migrations?: Migrations   // Record<string, Effect.Effect<void, unknown, SqlClient>>
```

```text
REQUIREMENT: A plugin's `migrations` MUST be a static value on the plugin
             class (BEH-EA-006), expressed as `@effect/sql` `Migrator`
             records keyed by name, resolvable without evaluating the
             plugin's `make` Layer or providing any configuration.
```

`archive/design/plugins-as-layers.md` §2.1 places `migrations` alongside `contract` and `tables` as one of the plugin's frozen static members. `research/10-schema-migrations.md`'s TL;DR is explicit that `@effect/sql`'s stock `Migrator` (single-transaction, ids-only, no checksums, no drift detection) is a fine runtime *applier* but not, by itself, the migration-authoring surface awthaq plugins are meant to target directly — the plan is for a plugin's migrations to be data the linker (BEH-EA-038) and, eventually, a CLI diff planner (BEH-EA-039) can read and re-key, not opaque imperative steps a plugin runs unaudited.

## BEH-EA-038: The linker orders and re-keys every plugin's migrations into one deterministic sequence

```
0001_core_users
0002_core_sessions
0003_password_account
0004_oauth_account
```

```text
REQUIREMENT: The composed migration set MUST run core's migrations first,
             then each plugin's migrations in `dependsOn` topological order,
             re-keyed `NNNN_<plugin>_<name>`, so that the same installed
             plugin set always produces the same ordered, re-keyed
             sequence.
```

`archive/design/plugins-as-layers.md` §7 assigns this ordering to the linker's one remaining runtime responsibility, alongside cycle detection: migration order is derived from `dependsOn`, the same graph that orders hook taps and registry contributions (BEH-EA-022, BEH-EA-024), so a table with a foreign key into another plugin's table is guaranteed to migrate after its target exists. `research/10-schema-migrations.md`'s recommended defaults add the determinism requirement explicitly: "same installed plugin set → byte-identical SQL," hash-stamped so the eventual CLI can detect when the plugin set itself has changed since the last apply.

## BEH-EA-039: Schema diffing, snapshot comparison, and destructive-change guardrails are a deferred CLI feature, not a v1 runtime requirement

```text
REQUIREMENT: The runtime (`Auth.make`, `auth.layer`, `auth.migrations`) MUST
             NOT depend on a snapshot-diff planner, a checksum ledger, or a
             live-database drift check to function; those capabilities, when
             built, MUST live in the CLI, consuming the same `auth.migrations`
             value the runtime already produces.
```

`archive/PRD.md` §12 states this scoping decision directly: "Snapshot-diff planning with a checksum ledger and destructive-change guardrails (research 10) is a CLI feature layered on top, not a v1 runtime requirement." `research/10-schema-migrations.md`'s own recommended defaults describe the eventual shape (Drizzle-kit-style snapshot diff, Atlas-style destructive-change lint and plan files, Prisma-style drift detection) precisely as tooling built *on* `@effect/sql`, never as something `Auth.make` itself must compute before an application can boot.

## BEH-EA-040: A plugin migration may only alter tables under its own prefix; shared tables are altered only through a declared extension point

> **Invariant:** [INV-EA-016](../invariants.md#inv-ea-016-a-plugin-cannot-alter-a-shared-table-outside-its-declared-extension-points)

```text
REQUIREMENT: A plugin's migrations MUST create or alter only tables named
             `<plugin-id>_<table>` (BEH-EA-005); a core-owned shared table
             (`users`, `sessions`, `accounts`) MUST NOT be altered by any
             plugin's migration directly — only through a declared
             extension point (a hook point contributing derived data, or a
             registry such as session claims).
```

`research/09-plugin-architecture.md` Q25 documents better-auth's opposite choice — plugins may add fields directly to the shared `user`/`session` tables via `additionalFields`, with a documentation-only warning against storing sensitive data there — as the failure mode this rule is designed to close: two plugins altering the same shared table in incompatible ways, or a plugin quietly widening a table core does not know about. `research/10-schema-migrations.md` Q78 states the awthaq-specific line precisely: primitive, nullable/defaulted scalar extensions are the only thing a shared table may accept, and even those go through a declared extension mechanism, never an unmediated `ALTER TABLE` from plugin migration code.

_Previous: [BEH-EA-032](04-contract-stratum.md#beh-ea-032-authapi-merges-contracts-and-refuses-a-duplicate-group-id)_
_Next: [BEH-EA-041](06-domain-users-accounts.md#beh-ea-041-a-user-is-identified-by-a-case-insensitively-unique-email)_
