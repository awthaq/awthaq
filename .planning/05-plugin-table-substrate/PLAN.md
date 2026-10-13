# 05 — Plugin table substrate in `@awthaq/sql`

> **Cross-plan reconciliation (orchestrator, after all plans were written):** see `.planning/README.md` § Cross-plan reconciliations. In short: 05 lands first and owns `StoreFailure` in `@awthaq/sql`; the tenant-stamp rule lives in `@awthaq/ports` as `Tenant.stamp` (02's placement), and 05's `TenantScoped` calls it; 02's `SqlStore.read/write` wraps 05's `StoreFailure` rather than classifying `SqlError` again.


> Strength: **Strong**. Dependency category: **local-substitutable** (memory and SQL adapters of every plugin
> records module) and **ports & adapters** (`Encryption`, `SqlClient`, `TenantContext`).
> Fixes: webhooks' tenant-blind store, ADR-EA-019's re-seal ignored by five of six sealed plugin columns, no RLS
> on any plugin table, plugin `Effect.orDie` on every store failure.
> Execution: Wave C, **before plan 04** (organization records adopt this substrate first) and **before plan 02**
> (which reuses the shared `StoreFailure` and `TenantScoped.stamp` this plan defines). See README.md.

All `file:line` references below were checked against the tree at commit `38bcd1b` (2026-10-13). Effect APIs
were checked against the **installed** `effect@4.0.0-rc.116` (`node_modules/.pnpm/effect@4.0.0-rc.116/.../src/unstable/sql`).
`../effect` is now at `4.0.1`, where SQL has moved from `effect/unstable/sql/*` to `effect/sql/*`. This repo still
pins `effect: 4.0.0-rc.116` (`pnpm-workspace.yaml:17`), so every import below uses `effect/unstable/sql/*`.
The rc.116 surface used here exists in 4.0.1 under the new path: `Statement.Constructor` with `sql(identifier)`,
`sql.literal`, `sql.and`, `sql.onDialectOrElse`, and `SqlError.reason._tag`.

---

## 1. Summary, goals, non-goals

### Summary

Every plugin that owns tables repeats three concerns that core already solved inside `@awthaq/sql`, and each one
re-solves them differently:

1. **Tenant scoping.** Core stamps every insert with the ambient tenant through one private function
   (`stampTenant`, `sql/src/Repositories.ts:86-92`). Core's partitioned tables also get an opt-in Postgres RLS
   backstop (`TenantScope.partitionedTables`, `sql/src/TenantScope.ts:37-42`). Plugins have neither, and they
   have three conventions between them. Admin reads `TenantContext` and filters in SQL with
   `IS NOT DISTINCT FROM` plus an `anyTenant` boolean. Webhooks reads every tenant's rows and filters in memory
   in the service. Organization passes `organizationId` explicitly and is guarded by a regex test.
2. **Sealed columns.** Six plugin columns are stored as `Encryption` envelopes. They use four AAD spellings and
   four policies for a value that does not decrypt. Only two-factor honours ADR-EA-019 decision 3 (re-seal when
   `staleKid` is set).
3. **Store failures.** Every plugin records module sends `SqlError`/`SchemaError` to the defect channel with
   `Effect.orDie`, which ADR-EA-028 rejected as option A for core (the ADR is scoped to core only). Webhooks even
   names its `orDie` wrapper `sealed`.

This plan deepens `@awthaq/sql` with four exported modules: **`TenantScoped`**, **`SealedColumn`**,
**`StoreFailure`** and a generalised **`TenantScope`** (RLS). Each plugin's records module becomes a thin adapter
over them. It also adds one plugin declaration (`tables` becomes a record of per-table tenancy) that `Auth.make`
folds into `auth.tenancy`, which `TenantScope.enableRls` consumes. Isolation moves out of the services
(locality), the four conventions become one interface (leverage), and memory and SQL adapters share each rule.

### Goals

- G1. One **tenant interface** for plugin records. The store stamps on insert. Reads and writes are filtered by
  an index-friendly predicate built in one place. Cross-tenant access is a **type-visible witness**
  (`TenantScoped.CrossTenant`), and on Postgres that witness also lifts RLS. Memory adapters filter by the same
  rule (`TenantScoped.matches`).
- G2. **Every plugin table declares its tenancy** (`partitioned` / `keyed` / `derived` / `global`) on
  `AuthPlugin.Service`. A table with no declaration does not compile. `Auth.make` validates the declarations and
  exposes `auth.tenancy`.
- G3. **RLS covers plugin tables.** `TenantScope.enableRls({ plugins: auth.tenancy })` covers declared
  partitioned tables, and derived tables through their parent. Keyed (organization-id) tables are covered on
  request. The change stays idempotent and reversible (ADR-EA-018 decision 5).
- G4. **One sealed-column interface**: one AAD convention (`<table>:<rowKey>:<column>`), lazy re-seal by
  compare-and-swap when `staleKid` is set, one typed `SealedColumn/Unreadable` failure, and two sanctioned
  call-site treatments. Records hand out `Sealed<A>` values with an `open` effect, so domain code never sees an
  envelope or an AAD. Old AAD spellings still open, then re-seal to the canonical AAD.
- G5. **Plugin records fail with `StoreUnavailable`**, not defects. The ADR-EA-028 helper moves to
  `@awthaq/sql` (`StoreFailure`) and is defined once. Core re-exports it, and plan 02 uses it.
- G6. **One parameterised tenant-isolation conformance suite** in `@awthaq/test`, run per plugin table over
  memory, SQLite and (under `test:pg`) Postgres with RLS. It replaces the organization regex guard. It also
  enforces, at compile time, that every records method is classified.
- G7. **One key-rotation/tamper suite** for the `SealedColumn` mechanism, plus a thin wiring suite per declared
  column.

### Non-goals

- Core repositories' own AAD formats (`user:<id>:metadata`, `session:<id>:<field>`,
  `<providerId>:<userId>:<field>`, `Repositories.ts:284/880/1355`) are **not** migrated. Core's `PiiCodec` keeps
  its formats and its null-and-warn policy. Only its mechanics are re-implemented over `SealedColumn` primitives
  (Phase 1). Moving core columns to declarations is plan 02's choice.
- OAuth's transient sealed values inside core `Verification` payloads (`oauth/src/OAuth.ts:955-962, 1046-1060,
  1408, 1516-1520`) are not table columns. They are consumed once and never re-read, so there is nothing to
  re-seal. Out of scope.
- No new tenant columns on tables that are global today (passkey, api-key, device-authorization, jwt, roles,
  qadi claims, two-factor). The declaration records why each one is global. Adding a column is open question Q4.
- No numbered migrations. RLS stays an operator's idempotent switch (ADR-EA-018 decision 5). The AAD change is
  lazy plus an optional sweep. The only DDL change is in `examples/plugin-template` (an example, not a shipped
  ledger).
- Retention of plugin tables (plan 10 item 6). This plan leaves room for it in the table declaration (§3.5) but
  adds no `retention` field.
- Splitting organization records (plan 04) and matched `Persistence.*` bundles (plan 08).

---

## 2. Verified inventory of plugin tables

Legend.

- **Tenant today**: how the store confines rows now.
- **Proposed**: the `tenancy` this plan declares.
- **orDie**: count of `orDie` occurrences in the module (`grep -c orDie`).
- **RLS**: no plugin table is covered today. `enableRls` touches only `partitionedTables` and `directoryTables`
  (`TenantScope.ts:37-47`).

Every listed records module ships `layerMemory` and `layerSql` with one suite run over both, except where noted.

| Plugin | Table | Records module (adapters) | Tenant today | Proposed tenancy | Sealed columns · AAD today | Undecryptable today | orDie |
|---|---|---|---|---|---|---|---|
| admin | `admin_impersonation` | `admin/src/ImpersonationRecords.ts` (memory+sql) | `"tenantId"` (migration `add_admin_impersonation_tenant_id`, `Admin.ts:776-780`). Ambient read, `IS NOT DISTINCT FROM` + `{ anyTenant }` (`ImpersonationRecords.ts:78-82, 182-184, 350-459, 618-680`) | `partitioned("tenantId")` | — | — | 8 |
| admin | `admin_impersonation_chain` | same | none. The hash-chained ledger spans tenants and its payload carries `tenantId` (`:240-242`) | `global("append-only hash chain over every tenant's episodes; verifyChain reads it whole")` | — | — | (same) |
| api-key | `apikey_key` | `api-key/src/ApiKeyRecords.ts` (memory+sql) | none (`ownerId`) | `global("owned by a user; the identity directory is global, ADR-EA-018 d4")` | — (secret hashed) | — | 6 |
| api-key | `apikey_client` | `api-key/src/ApiKeyClientRecords.ts` (memory+sql) | none | `global("service clients are deployment-wide")` | — (hashed) | — | 5 |
| device-authorization | `device_authorization_grant` | `device-authorization/src/DeviceGrantRecords.ts` (memory+sql) | none | `global("a device grant starts before any tenant is known")` | — (hashed) | — | 12 |
| device-authorization | `device_authorization_client` | `.../DeviceClientRecords.ts` (memory+sql) | none | `global("deployment-wide client registry")` | — | — | 4 |
| jwt | `jwt_signing_key` | `jwt/src/SigningKeyRecords.ts` (memory **stores plaintext JWK**, sql sealed) | none | `global("deployment-wide key ring, ADR-EA-017")` | `privateKeyJwk` · `jwt_signing_key:<kid>:privateKeyJwk` (`:226`) | **defect** `InvariantViolation("SigningKeyUndecodable")` (`:237-257`). `staleKid` ignored | 4 |
| jwt | `jwt_token_revocation` | `jwt/src/RevocationStore.ts` (memory+sql) | none | `global("revoked jti set is deployment-wide")` | — | — | 2 |
| organization | `organization_org` | `organization/src/OrganizationRecords.ts` (memory+sql) | `id` **is** the tenant; explicit | `keyed("id")` | — | — | 9 |
| organization | `organization_membership` | `MembershipRecords.ts` | explicit `organizationId` | `keyed("organizationId")` | — | — | 11 |
| organization | `organization_invitation` | `InvitationRecords.ts` | explicit `organizationId` | `keyed("organizationId")` | — (`tokenHash` hashed) | — | 14 |
| organization | `organization_team` | `TeamRecords.ts` | explicit `organizationId` | `keyed("organizationId")` | — | — | 19 (module) |
| organization | `organization_team_membership` | `TeamRecords.ts` | via `teamId` | `derived("organization_team", "teamId")` | — | — | (same) |
| organization | `organization_team_closure` | `TeamRecords.ts` | via team ids | `derived("organization_team", "descendantId")` | — | — | (same) |
| organization | `organization_role` | `OrgRoleRecords.ts` | explicit `organizationId` | `keyed("organizationId")` | — | — | 8 |
| organization | `organization_active_context` | `ActiveContextRecords.ts` | `sessionId` (+`userId`) | `derived("sessions", "sessionId")` (core partitioned parent) | — | — | 11 |
| organization | `organization_oauth_connection` | `ConnectionRecords.ts` (memory+sql) + `OrganizationConnections.ts` | explicit `organizationId` | `keyed("organizationId")` | `clientSecret` · `organization-oauth-connection:<id>:clientSecret` (`OrganizationConnections.ts:70-71`) | **drop + warn** (`:152-172`). `staleKid` ignored | 5 (+2) |
| organization | `organization_oauth_connection_domain` | `ConnectionRecords.ts` | has `organizationId` (`Organization.ts:1689-1693`) | `keyed("organizationId")` | — | — | (same) |
| passkey | `passkey_credential` | `passkey/src/PasskeyCredentials.ts` (memory+sql) | none (`userId`) | `global("user-attached credential; directory is global")` | — (public key) | — | 8 |
| passkey | `passkey_challenge` | `ChallengeStore.ts` (cookie+memory+sql) | none (`scope`) | `global("a ceremony starts before any tenant is known")` | — | — | 7 |
| passkey | `passkey_user_handle` | `PasskeyUserHandles.ts` (memory+sql) | none | `global("user-attached; directory is global")` | — | — | 4 |
| roles | `roles_assignments` | `roles/src/Roles.ts` (static `layer`/`layerSql`) | none | `global("global roles, ADR-EA-025")` | — | — | 5 |
| qadi | `claims_user` | `qadi/src/UserClaims.ts` (static `layer`/`layerSql`) | none | `global("per-user claims document; directory is global")` | — | — | 2 |
| saml | `saml_connection` | `saml/src/SamlRecords.ts` (memory+sql) | explicit `organizationId` | `keyed("organizationId")` | — | — | 24 (module) |
| saml | `saml_connection_domain` | `SamlRecords.ts` | via `connectionId` | `derived("saml_connection", "connectionId")` | — | — | (same) |
| saml | `saml_sp_key` | `SamlRecords.ts` + `SamlSpKeys.ts` | via `connectionId` | `derived("saml_connection", "connectionId")` | `privateKey` · `saml-sp-key:<id>:privateKey` (`SamlSpKeys.ts:24`) | **defect** `InvariantViolation("saml.signingKeyOpens")` (`:114-123`). `staleKid` ignored | (same) +2 |
| saml | `saml_session` | `SamlRecords.ts` | via `connectionId` | `derived("saml_connection", "connectionId")` | — | — | (same) |
| scim | `scim_connection` | `scim/src/ScimRecords.ts` (memory+sql) | explicit `organizationId` | `keyed("organizationId")` | — (`tokenHash` hashed) | — | 9 (e.g. `:587`) |
| scim | `scim_resource` | `ScimRecords.ts` | via `scimConnectionId` | `derived("scim_connection", "scimConnectionId")` | — | — | (same) |
| two-factor | `two_factor_secret` | `two-factor/src/TwoFactorStore.ts` (`layerSecretsMemory`/`Sql`) | none (`userId`) | `global("per-user factor; directory is global")` | `secret` · `two_factor_secret:<userId>` (`SecondFactor.ts:130`) | **defect** `InvariantViolation("TwoFactorSecretUnreadable")` (`:201-215`). **Re-seals on `staleKid`** via CAS `reencrypt` (`SecondFactor.ts:216-219`, `TwoFactorStore.ts:351-364, 398-399`) | 13 (module) |
| two-factor | `two_factor_recovery_code` | `TwoFactorStore.ts` (`layerRecoveryCodesMemory`/`Sql`) | none | `global("per-user codes; directory is global")` | — (hashed) | — | (same) |
| webhooks | `webhooks_endpoint` | `webhooks/src/WebhookRecords.ts` (memory+sql) | `"tenantId"` (`Webhooks.ts:266-273`). **Store is tenant-blind**: `allEndpoints` = `SELECT * … ORDER BY` (`WebhookRecords.ts:618-622`). The service filters all tenants' rows in memory (`Webhooks.ts:478-504`) | `partitioned("tenantId")` | `secret`, `previousSecret`, `headers` · `webhooks-endpoint:<id>:<field>` (`WebhookSecrets.ts:20-21`) | **`None`**: the attempt fails as `secret`, the previous secret is dropped, rotation loses it (`WebhookSecrets.ts:40-80`, `Webhooks.ts:686-694`). `staleKid` ignored | 1, plus `const sealed = Effect.orDie` (`:736`) used 35 times |
| webhooks | `webhooks_delivery` | `WebhookRecords.ts` | via `endpointId`. `claimDue` etc. span tenants | `derived("webhooks_endpoint", "endpointId")` | — | — | (same) |
| (example) | `notes_note` | `examples/plugin-template/src/Template.ts` (sql only) | none | becomes the worked `partitioned("tenantId")` example (Phase 13) | — | — | 2 |

Non-plugin tables out of scope: `cli/src/Import.ts`'s import ledger (tooling), and the foreign better-auth tables
read by `migrate-better-auth`.

**Webhooks finding, stated precisely.** I found no live cross-tenant disclosure through HTTP.
`Webhooks.ts:478-504` filters in memory, and every by-id mutation (`:618, 664, 684, 728, 746, 769`) is preceded by
`existing()`. The defect is *where* isolation lives:

- One missed `existing()` is a leak, because `updateEndpoint`, `setSecrets`, `setDisabled` and `deleteEndpoint`
  are tenant-blind (`WebhookRecords.ts:775-832`).
- Every admin listing and every `maxEndpoints` check loads every tenant's rows, sealed secrets included, into the
  process (`Webhooks.ts:562-563`).
- RLS cannot back it up.

It is still first in risk order: it is the cheapest fix, and webhooks is the only plugin whose isolation exists
only in service code.

**Other confirmed findings** (used below):

- `IS NOT DISTINCT FROM` (admin) cannot use a btree index on Postgres. The new predicate emits
  `"tenantId" = $1` or `"tenantId" IS NULL` instead.
- `Encryption.encrypt` cannot fail (`ports/src/Encryption.ts:134`), so SAML's `.pipe(Effect.orDie)` on it
  (`SamlSpKeys.ts:93-95`) is a no-op.
- `Tenant.withoutTenant` (`ports/src/Tenant.ts:33`) clears the fiber reference but **not** the Postgres setting.
  Nothing in `packages/*/src` resets `awthaq.tenant_id`. So any cross-tenant read inside a
  `TenantScope.withTenant` transaction (the `layerWithRls` middleware, `organization/src/TenantMiddleware.ts:101-118`)
  is silently confined to the request's tenant on RLS-covered tables. Today that touches only core tables
  (erasure of a user's sessions across tenants). Once plugin tables are covered, it would break admin's
  `closeExpired`/`verifyChain`/superadmin reads and organization's cross-org reads. `TenantScoped.lift` (§3.1)
  fixes this, and core can adopt it (§8, plan 03).
- Plugin credential resolvers (`api-key/src/ApiKey.ts:636, 654`, `jwt/src/Jwt.ts:437`) are typed
  `Effect<Principal, Unauthenticated, …>` (`server/src/Authentication.ts:165-167`). They cannot surface
  `StoreUnavailable` even though the chain already handles one (`:333-364`).
- On Postgres, an RLS `WITH CHECK` failure is SQLSTATE 42501, which `@effect/sql-pg` maps to the
  `AuthorizationError` reason (`sql-pg/src/internal/sqlError.ts:49-50`).

---

## 3. Target design

All sketches follow the shared conventions: no `as`, no return-type annotations on new Effect/Layer consts,
interface members typed as the contract. Names are final unless marked otherwise.

### 3.1 `@awthaq/sql` — `TenantScoped.ts` (new)

The module's interface is small: declarations, one predicate, one memory matcher, one stamp, one witness, one RLS
lift. The implementation hides the dialect, NULL semantics, index-friendliness and the transaction-local setting.

```ts
// packages/sql/src/TenantScoped.ts
import { Tenant } from "@awthaq/ports";
import * as Brand from "effect/Brand";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** The transaction-local setting the RLS policies read (moved here from TenantScope.ts; TenantScope re-exports it). */
export const TENANT_SETTING = "awthaq.tenant_id";

// ---- declarations (what a table is) -------------------------------------------------

/** How one table relates to the tenant (ADR-EA-018 decision 10, this plan). */
export type Tenancy = Data.TaggedEnum<{
  /** Nullable tenant column stamped at insert from the ambient tenant; NULL = untenanted (platform). */
  Partitioned: { readonly column: string };
  /** The organization id (= tenant id) is the row's own key column; callers pass it explicitly. */
  Keyed: { readonly column: string };
  /** No own tenant column: scoped through `parent` by `via` -> `parent.parentKey`. */
  Derived: { readonly parent: string; readonly via: string; readonly parentKey: string };
  /** Deliberately tenant-blind; `reason` is printed by `awthaq plugin list` and reviewed. */
  Global: { readonly reason: string };
}>;
export const Tenancy = Data.taggedEnum<Tenancy>();

export const partitioned = (column = "tenantId") => Tenancy.Partitioned({ column });
export const keyed = (column: string) => Tenancy.Keyed({ column });
export const derived = (parent: string, via: string, parentKey = "id") =>
  Tenancy.Derived({ parent, via, parentKey });
export const global = (reason: string) => Tenancy.Global({ reason });

/** One table's declaration. A record, not the bare Tenancy, so plan 10 item 6 can add `retention` beside it. */
export interface TableDeclaration {
  readonly tenancy: Tenancy;
}

// ---- the cross-tenant witness -------------------------------------------------------

/** The one way to lift tenant confinement. Carries why; minted only by `crossTenant`. */
export type CrossTenant = string & Brand.Brand<"awthaq/sql/CrossTenant">;
const mint = Brand.nominal<CrossTenant>(); // module-private, like two-factor's `proofOf`
export const crossTenant = (reason: string) => mint(reason);

// ---- what one statement may see -----------------------------------------------------

export type Visibility = Data.TaggedEnum<{
  Tenant: { readonly tenant: Option.Option<string> };
  Everywhere: { readonly grant: CrossTenant };
}>;
export const Visibility = Data.taggedEnum<Visibility>();

/** The ambient tenant, unless the caller presents a witness (which is recorded on the span). */
export const visibility = (grant?: CrossTenant) =>
  grant === undefined
    ? Effect.map(Tenant.TenantContext, (tenant) => Visibility.Tenant({ tenant }))
    : Effect.as(
        Effect.annotateCurrentSpan("awthaq.tenant.crossTenant", grant),
        Visibility.Everywhere({ grant }),
      );

/** Memory adapters: the same rule as `predicate`. `None` sees only untenanted rows; `Some(t)` only t's. */
export const matches = (row: string | null, seen: Visibility) =>
  Visibility.$match(seen, {
    Everywhere: () => true,
    Tenant: ({ tenant }) => Option.getOrNull(tenant) === row,
  });

/** Moved verbatim from `Repositories.ts:86-92`: an explicit tenantId wins, then the ambient one, then NULL. */
export const stamp = <A extends { readonly tenantId: string | null }>(input: A): Effect.Effect<A> =>
  input.tenantId !== null
    ? Effect.succeed(input)
    : Effect.map(Tenant.TenantContext, (tenant) => ({ ...input, tenantId: Option.getOrNull(tenant) }));
// (The annotation is the moved code's own; the no-annotation rule is for new code, not a retroactive strip.)

// ---- SQL ------------------------------------------------------------------------------

/**
 * Index-friendly predicate for a Partitioned column (`qualifier` for joins: `e."tenantId"`).
 * Never `IS NOT DISTINCT FROM`, which Postgres cannot serve from a btree index.
 */
export const predicate = (sql: SqlClient.SqlClient, column: string, seen: Visibility, qualifier?: string) => {
  const target = qualifier === undefined ? sql(column) : sql`${sql(qualifier)}.${sql(column)}`;
  return Visibility.$match(seen, {
    Everywhere: () => sql.literal("1 = 1"),
    Tenant: ({ tenant }) =>
      Option.match(tenant, {
        onNone: () => sql`${target} IS NULL`,
        onSome: (id) => sql`${target} = ${id}`,
      }),
  });
};

/** Set by `TenantScope.withTenant` (RLS transactions only): whether `awthaq.tenant_id` is set on this connection. */
export const InRlsScope = Context.Reference<boolean>("awthaq/sql/InRlsScope", { defaultValue: () => false });

/**
 * Runs `effect` with RLS lifted for a witnessed cross-tenant statement. Zero cost outside an RLS
 * transaction (SQLite, no withTenant, or the background relay). Inside one, it uses a savepoint:
 * clear the setting, run, and restore it on success (a rolled-back savepoint reverts it by itself).
 */
export const lift =
  (grant: CrossTenant) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      if (!(yield* InRlsScope)) return yield* effect;
      const sql = yield* SqlClient.SqlClient;
      yield* Effect.annotateCurrentSpan("awthaq.tenant.rlsLifted", grant);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const [previous] = yield* sql<{ readonly value: string | null }>`
            SELECT current_setting(${TENANT_SETTING}, true) AS value`;
          yield* sql`SELECT set_config(${TENANT_SETTING}, '', true)`;
          const result = yield* effect;
          yield* sql`SELECT set_config(${TENANT_SETTING}, ${previous?.value ?? ""}, true)`;
          return result;
        }),
      );
    });
```

The predicate builder takes the `SqlClient` the records layer captured at build. Records call
`TenantScoped.visibility(grant)` once per method and pass the result to both `predicate` and (memory) `matches`.

**Keyed tables** get no ambient predicate: the explicit `organizationId` is the scope. That is today's behaviour,
and Q2 asks whether to also require `key = ambient` when a tenant is set. Cross-organization methods on keyed
tables take a `CrossTenant` witness and wrap their statement in `lift`, so RLS (when enabled for keyed tables)
does not confine them.

**Derived tables** are scoped through their parent. A records method on a derived table either joins the parent
with `predicate(…, qualifier)`, or is called only with a parent key the caller already resolved through a scoped
read. The conformance coverage map (§3.6) records which.

### 3.2 `@awthaq/sql` — `TenantScope.ts` (generalised RLS)

`partitionedTables`/`directoryTables` stay as the core constants. `enableRls` gains the composition's declarations.

```ts
// packages/sql/src/TenantScope.ts (changed)
export { TENANT_SETTING } from "./TenantScoped.ts";

export interface DeclaredTable {
  readonly plugin: string;
  readonly table: string;
  readonly tenancy: TenantScoped.Tenancy;
}

export interface RlsOptions {
  readonly includeDirectory?: boolean;
  /** `auth.tenancy`: the plugin tables to cover (Partitioned always; Derived through a covered parent). */
  readonly plugins?: ReadonlyArray<DeclaredTable>;
  /** Also cover Keyed tables (organization-id keyed), and Derived tables beneath them. Default false (Q3). */
  readonly includeKeyed?: boolean;
}
```

Policy per kind. Every policy is `FOR ALL`, so with no `WITH CHECK` the `USING` expression also guards inserts
and updates, and the shape stays fail-open when unset (ADR-EA-018 decision 5). Let `unset` be
`NULLIF(current_setting('awthaq.tenant_id', true), '') IS NULL`.

| Kind | `USING` expression |
|---|---|
| core partitioned / Partitioned(column) | `unset OR "<column>" = current_setting('awthaq.tenant_id', true)` |
| Keyed(column) (`includeKeyed`) | same, on `"<column>"` |
| Derived(parent, via, parentKey) | `unset OR EXISTS (SELECT 1 FROM <parent> p WHERE p."<parentKey>" = <table>."<via>")`. The parent's own policy confines the subquery |
| Global | never covered |

How the policies are applied:

- Covered tables are computed by a pure `coverage(options)`. A Derived table whose parent is not covered is
  skipped with an `Effect.logInfo`. A Derived table may also name a core table as its parent (`sessions`); it is
  then covered when that core table is.
- Identifiers go through `sql(identifier)`, not string concatenation. `enableRls` uses `sql.unsafe` for DDL
  today (`TenantScope.ts:68-84`); each policy body is assembled from validated identifiers (the
  `^[A-Za-z_][A-Za-z0-9_]*$` check `Auth.make` already applied) and the constant setting name. `Auth.make` has
  already validated every table and column (§3.5).
- `disableRls` drops the policy from **every** table that has it:
  `SELECT schemaname, tablename FROM pg_policies WHERE policyname = 'awthaq_tenant'`, then
  `NO FORCE` / `DISABLE`. It stays idempotent whatever was enabled earlier, and needs no argument.
- `withTenant` additionally provides `TenantScoped.InRlsScope = true` inside its transaction (pg branch only).

All existing indexes already serve these policies: every `via` column is indexed (`webhooks_delivery("endpointId",…)`,
`saml_sp_key("connectionId")`, `saml_session("connectionId",…)`, `saml_connection_domain("connectionId")`,
`scim_resource` PK, `organization_team_membership("teamId")`, `organization_team_closure("descendantId")`), and
every parent key is a primary key. No index migrations are needed.

### 3.3 `@awthaq/sql` — `SealedColumn.ts` (new)

```ts
// packages/sql/src/SealedColumn.ts
import { Defects, Encryption } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export interface Column<A> {
  readonly table: string;
  readonly column: string;
  /** The row key bound into the AAD and used by the re-seal compare-and-swap. */
  readonly key: string;
  readonly schema: Schema.Codec<A, string>;
  /** Read-only AADs for envelopes sealed before this declaration; a hit re-seals under the canonical one. */
  readonly legacyAad: ReadonlyArray<(rowKey: string) => string>;
  /** Treat a non-envelope stored value as legacy plaintext and seal it on read (core PII's opt-in). */
  readonly adoptPlaintext: boolean;
}

/** Throws `SealedColumn/InvalidDeclaration` at definition time for a non-identifier table/column/key. */
export const column = <A = string>(options: {
  readonly table: string;
  readonly column: string;
  readonly key: string;
  readonly schema?: Schema.Codec<A, string>;
  readonly legacyAad?: ReadonlyArray<(rowKey: string) => string>;
  readonly adoptPlaintext?: boolean;
}) => { /* validate identifiers, default schema = Schema.String; returns Column<A> */ };

/** ADR-EA-019 decision 6: the one AAD convention. Matches core's `<entity>:<id>:<field>` shape. */
export const aadOf = <A>(column: Column<A>, rowKey: string) =>
  `${column.table}:${rowKey}:${column.column}`;

export class Unreadable extends Data.TaggedError("SealedColumn/Unreadable")<{
  readonly table: string;
  readonly column: string;
  readonly rowKey: string;
  readonly reason: "DecryptionFailed" | "UnknownKeyId" | "Malformed";
}> {}

/** What a record carries in place of an envelope. Domain code opens it where it needs the value. */
export interface Sealed<A> {
  readonly open: Effect.Effect<Redacted.Redacted<A>, Unreadable>;
}

/** Re-seal is on by default (ADR-EA-019 d3); a deployment reading a replica-only path can turn it off. */
export const SealedColumnConfig = Context.Reference<{ readonly resealOnRead: boolean }>(
  "awthaq/sql/SealedColumnConfig",
  { defaultValue: () => ({ resealOnRead: true }) },
);

/** Persists a re-seal only while the row still holds `stored`; `false` when a concurrent writer won. */
export interface Swap {
  (rowKey: string, stored: string, fresh: string): Effect.Effect<boolean, unknown>;
}

/** The SQL `Swap`: `UPDATE t SET c = fresh WHERE key = rowKey AND c = stored RETURNING key`. */
export const sqlSwap = <A>(column: Column<A>) =>
  Effect.map(SqlClient.SqlClient, (sql): Swap => (rowKey, stored, fresh) =>
    sql`UPDATE ${sql(column.table)} SET ${sql(column.column)} = ${fresh}
        WHERE ${sql(column.key)} = ${rowKey} AND ${sql(column.column)} = ${stored}
        RETURNING ${sql(column.key)}`.pipe(Effect.map((rows) => rows.length > 0)));

/**
 * One codec per column per records layer. `seal` for writes; `sealed` wraps a stored value for a record.
 * `open`: canonical AAD first. On DecryptionFailed, each legacy AAD in turn. On UnknownKeyId, no retry.
 * Then decode via `schema` (Malformed). On staleKid or a legacy hit, re-seal under the canonical AAD and
 * `swap`; a failed or lost swap is logged (ids only) and never fails the read.
 */
export const codec = <A>(column: Column<A>, swap: Swap) =>
  Effect.gen(function* () {
    const encryption = yield* Encryption.Encryption;
    const config = yield* SealedColumnConfig;
    const seal = (rowKey: string, value: Redacted.Redacted<A>) => /* encode, encrypt(aadOf) */;
    const sealed = (rowKey: string, stored: string): Sealed<A> => ({ open: /* as documented */ });
    return { seal, sealed };
  });

// ---- the two sanctioned call-site treatments of Unreadable ---------------------------

/** Fail closed: a defect naming the column (never the value). For a value the operation cannot proceed without. */
export const orDie = <A, E, R>(self: Effect.Effect<A, E | Unreadable, R>) =>
  Effect.catchTag(self, "SealedColumn/Unreadable", (e) =>
    Defects.invariantViolation("sealedColumn.readable",
      `awthaq: ${e.table}.${e.column} of ${e.rowKey} cannot be opened (${e.reason})`));

/** Degrade: `None` plus one warning (ids only). For one optional value or one row of a list. */
export const option = <A, E, R>(self: Effect.Effect<A, E | Unreadable, R>) =>
  self.pipe(
    Effect.map(Option.some),
    Effect.catchTag("SealedColumn/Unreadable", (e) =>
      Effect.logWarning("awthaq: a sealed column cannot be opened").pipe(
        Effect.annotateLogs({ table: e.table, column: e.column, rowKey: e.rowKey, reason: e.reason }),
        Effect.as(Option.none()),
      )),
  );

// ---- low-level primitive (core PII) and maintenance ----------------------------------

/** What core's `sealedPii` becomes: explicit AADs, the same decrypt/legacy/re-seal rules, its own policy. */
export const reveal = (encryption: Encryption.EncryptionShape, options: {
  readonly aad: string; readonly legacyAad?: ReadonlyArray<string>; readonly adoptPlaintext?: boolean;
}, stored: string) => /* Effect<{ plaintext: Redacted<string>; refreshed: Option<string> }, DecryptionFailed | UnknownKeyId> */;

/**
 * Batch re-seal (ADR-EA-019 d3 left batch out of scope; this has a caller now: retiring a kid, and Phase 14).
 * Keyset-pages `table` by `key`, opens every value, re-seals stale/legacy ones by `swap`, and reports
 * { scanned, resealed, unreadable }. An operator job, never run by a request.
 */
export const sweep = <A>(column: Column<A>, options?: { readonly batch?: number }) => /* Effect<SweepReport, SqlError, SqlClient | Encryption> */;
```

**Undecryptable policy, decided.** The substrate never reads an unreadable value as `null` and never dies. It
fails `open` with the typed `SealedColumn/Unreadable`. Each call site picks exactly one of two treatments, and the
treatment is visible in code:

- `SealedColumn.orDie`: fail closed as a tagged defect. Used for a signing key or a TOTP secret, where
  continuing is unsafe and a retry cannot help (ADR-EA-028 decision 3: bugs a retry cannot fix die).
- `SealedColumn.option`: degrade one value or one row with a warning. Used for optional values and lists.

**Lazy decrypt.** `Sealed.open` is lazy, so listing endpoints for the relay no longer decrypts every secret.
**Re-seal** uses compare-and-swap, so a concurrent rotation always wins.

**AAD compatibility, decided.** Canonical is `<table>:<rowKey>:<column>`. It matches JWT's existing AAD exactly,
and core's `<entity>:<id>:<field>` shape. Every other plugin column declares its old spelling in `legacyAad`, so
existing ciphertext keeps opening, re-seals to canonical on the next read, and `sweep` can finish the rest.

Why the legacy fallback is safe: every legacy AAD binds the same row key and field as the canonical one. The
exception is two-factor, which binds the row only, but that table has a single sealed column. So the fallback
cannot be used to move a ciphertext to another row or column. The cost is one extra AES-GCM attempt per legacy
read, until the row is re-sealed. Open question Q1 offers the zero-migration alternative.

| Column | Canonical AAD | `legacyAad` |
|---|---|---|
| `webhooks_endpoint.secret` | `webhooks_endpoint:<id>:secret` | `webhooks-endpoint:<id>:secret` |
| `webhooks_endpoint.previousSecret` | `webhooks_endpoint:<id>:previousSecret` | `webhooks-endpoint:<id>:previousSecret` |
| `webhooks_endpoint.headers` | `webhooks_endpoint:<id>:headers` | `webhooks-endpoint:<id>:headers` |
| `organization_oauth_connection.clientSecret` | `organization_oauth_connection:<id>:clientSecret` | `organization-oauth-connection:<id>:clientSecret` |
| `saml_sp_key.privateKey` | `saml_sp_key:<id>:privateKey` | `saml-sp-key:<id>:privateKey` |
| `jwt_signing_key.privateKeyJwk` | `jwt_signing_key:<kid>:privateKeyJwk` | none (already canonical) |
| `two_factor_secret.secret` | `two_factor_secret:<userId>:secret` | `two_factor_secret:<userId>` |

**Memory adapters seal too.** A memory adapter builds the same `codec` with a `Ref`-backed `Swap`, so the
mechanism and its tests run identically on both adapters. JWT's `layerMemory` stops keeping a plaintext JWK and
now requires `Encryption`. Tests provide `Encryption.layer` over `KeyProvider.layerEphemeral` or the fixed
`EncryptionLive` test layer (`sql/test/contract.ts:28-41`).

### 3.4 `@awthaq/sql` — `StoreFailure.ts` (new; defined once, shared with plan 02)

`@awthaq/sql` gains a dependency on `@awthaq/api` (stratum 1 sits below stratum 3, so the stratum rule allows
it; `api` depends only on `effect`).

```ts
// packages/sql/src/StoreFailure.ts — moved from core/src/Errors.ts:22-79, plus the classification below
import { Api } from "@awthaq/api";
import { Defects } from "@awthaq/ports";
import { isSqlError, type SqlError } from "effect/unstable/sql/SqlError";

export import StoreUnavailable = Api.StoreUnavailable;

/** Reasons a retry cannot fix and a 503 would misreport: a bug, a missing GRANT, or an RLS refusal of a forgotten filter. */
const isDefect = (cause: unknown) =>
  isSqlError(cause) &&
  (cause.reason._tag === "SqlSyntaxError" || cause.reason._tag === "AuthorizationError");

export const storeUnavailable = (operation: string) => (cause: unknown) =>
  isDefect(cause)
    ? Defects.invariantViolation("store.statementRefused", `awthaq: ${operation} was refused by the database`)
        .pipe(Effect.tap(() => Effect.logError("awthaq: store refused a statement", operation, cause)))
    : Effect.logWarning("awthaq: store unavailable", operation, cause).pipe(
        Effect.andThen(Effect.fail(new StoreUnavailable({ operation }))),
      );

/** Unchanged signature (core Errors.ts:42-50). */
export const orStoreUnavailable = (operation: string) =>
  <A, R>(self: Effect.Effect<A, SqlError | Schema.SchemaError, R>) =>
    self.pipe(Effect.catchTags({ SqlError: storeUnavailable(operation), SchemaError: Effect.die }));

export const transientRetrySchedule = /* moved verbatim (Errors.ts:59-61) */;
export const retryTransient = /* moved verbatim (Errors.ts:73-83) */;
```

How records use it:

- A records method whose effect has only `SqlError | SchemaError` pipes `StoreFailure.orStoreUnavailable("Webhooks.listEndpoints")`.
- A method that turns a `SqlError` into a domain error catches that first, the way JWT turns `UniqueViolation`
  into `CurrentKeyConflict` (`SigningKeyRecords.ts:365-372`), and then maps the rest with
  `catchTags({ SqlError: StoreFailure.storeUnavailable(op), SchemaError: Effect.die })`.
- `PlatformError` from `Crypto` in a records layer: `catchTag("PlatformError", storeUnavailable(op))`.
- Operation labels are `<Records>.<method>` (`WebhookRecords.findEndpoint`), static and safe to expose (ADR-EA-028 decision 1).

`core/src/Errors.ts` keeps its exports as re-exports, so no core caller changes:
`export const { storeUnavailable, orStoreUnavailable, retryTransient, transientRetrySchedule } = StoreFailure;`
plus `StoreUnavailable`.

The `isDefect` classification is the one behaviour change for core: a syntax error or an `AuthorizationError`
(a missing GRANT, or an RLS refusal) used to answer 503 and now dies. ADR-EA-028 revision 1.2 records this.

### 3.5 `AuthPlugin` declaration and `Auth.make`

`tables` changes from a string array to a record keyed by table name. **One declaration** carries both the
table's name and its tenancy. A table without a tenancy does not compile, and keys must still match
`${Id}_${string}` (BEH-EA-005).

```ts
// packages/core/src/AuthPlugin.ts (Service options; Class/Any members)
readonly tables?: { readonly [T in `${NoInfer<Id>}_${string}`]?: TenantScoped.TableDeclaration };
// Class:
readonly tables: ReadonlyArray<`${Id}_${string}`>;                  // unchanged type, now Object.keys(options.tables)
readonly tenancy: Readonly<Record<string, TenantScoped.TableDeclaration>>;
// Any:
readonly tenancy?: Readonly<Record<string, TenantScoped.TableDeclaration>>; // optional for hand-built fixtures
// re-export for packages without an @awthaq/sql dependency (roles, qadi):
export const Table = { partitioned: …, keyed: …, derived: …, global: … };  // each returns { tenancy }
```

Webhooks after the change:

```ts
tables: {
  webhooks_endpoint: AuthPlugin.Table.partitioned(),
  webhooks_delivery: AuthPlugin.Table.derived("webhooks_endpoint", "endpointId"),
},
```

Narrowing `Object.keys(options.tables)` to `` `${Id}_${string}` `` must not use `as`. Do it with a filter guard
`(key): key is \`${Id}_${string}\` => key.startsWith(\`${id}_\`)`, which also re-checks the prefix at runtime.

`Auth.make` changes (`core/src/Auth.ts`):

- **Validation** at link time, failing with a new tagged `Auth/TenancyDeclarationInvalid`:
  - every identifier matches `^[A-Za-z_][A-Za-z0-9_]*$`;
  - a Derived `parent` is a table of the same plugin, of a plugin in its `dependsOn`, or a core table
    (`partitionedTables ∪ directoryTables`);
  - a Derived `parent` is not `Global`;
  - Derived chains are acyclic.
- **`Built.tenancy`**: `ReadonlyArray<TenantScope.DeclaredTable>` in plugin order. This is what an operator
  passes to `TenantScope.enableRls({ plugins: auth.tenancy })`.
- **`ManifestPlugin.tenancy`**: the same per plugin, so `awthaq plugin list` prints
  `webhooks_endpoint (partitioned "tenantId")` (`cli/src/Plugin.ts:35, 59, 111`).

The change cascades to 65 `tables: [...]` sites in ~45 files: plugin sources, `features/step-definitions/*`,
test fixtures. It is mechanical:

- `tables: []` becomes `tables: {}`.
- A fixture's `tables: ["x_y"]` becomes `tables: { x_y: AuthPlugin.Table.global("test fixture") }`.

Phase 3 lists the files.

### 3.6 Conformance suites in `@awthaq/test`

Both suites are framework-injected, like `runPluginContractTests` (`test/src/TestAuth.ts:529`), so third-party
plugins can run them.

```ts
// packages/test/src/TenantConformance.ts
export interface Probe<Id, R> {
  /** Runs the method against row `id` under whatever tenant the suite set; true = it saw/changed that row. */
  readonly run: (id: Id) => Effect.Effect<boolean, unknown, R>;
}
export type MethodClass<Id, R> =
  | { readonly scoped: Probe<Id, R> }                          // must see own tenant only
  | { readonly crossTenant: Probe<Id, R> }                     // takes a witness; must see every tenant
  | { readonly insert: true }                                  // covered by the stamp case
  | { readonly derived: string }                               // keyed by a parent key the caller resolved; why
  | { readonly keyed: Probe<Id, R> };                          // explicit organization key: must not see other orgs

export interface TableCase<Shape, Id, R> {
  readonly table: string;
  /** Inserts one row as the ambient tenant (the suite wraps it in Tenant.withTenant / withoutTenant). */
  readonly insert: Effect.Effect<Id, unknown, R>;
  /** Every member of the records interface, classified. A new method that is not classified fails to compile. */
  readonly methods: { readonly [K in keyof Shape]: MethodClass<Id, R> };
}

export const runTenantIsolationTests = <Shape, Id, R>(
  framework: TestFramework,
  config: {
    readonly plugin: AuthPlugin.Any;                        // its `tenancy` drives coverage
    readonly adapters: ReadonlyArray<{ readonly name: string; readonly layer: Layer.Layer<R, unknown> }>;
    readonly cases: ReadonlyArray<TableCase<Shape, Id, R>>;
    /** Postgres only: the plugin's migrations already applied; the suite creates a non-owner role and enables RLS. */
    readonly rls?: Layer.Layer<SqlClient.SqlClient, unknown>;
  },
) => void;
```

Cases per adapter:

1. A row stamped under A is seen by every `scoped` probe under A, and by none under B or under no tenant.
2. An untenanted row is seen with no tenant and not under A.
3. A `scoped` mutation under B leaves A's row unchanged (re-probe under A).
4. Every `crossTenant` probe sees rows of A, B and NULL.
5. `keyed` probes see only the passed organization's rows.
6. **Coverage**: every Partitioned, Keyed and Derived table in `plugin.tenancy` has a `TableCase`, and no Global
   table has one.
7. **RLS (when `rls` is given and the dialect is pg)**:
   - `enableRls({ plugins: tenancyOf(plugin), includeKeyed: true })`;
   - `SET LOCAL ROLE` to a non-owner probe role, with GRANTs, as `sql/test/Repositories.postgres.test.ts:337-370` does;
   - a deliberately unfiltered `SELECT count(*) FROM <table>` inside `TenantScope.withTenant("B")` sees 0 of A's rows;
   - the same statement wrapped in `TenantScoped.lift(grant)` sees them;
   - an `INSERT` of A's tenant inside B fails with a defect (the `AuthorizationError` classification);
   - `disableRls` runs in a finalizer.

```ts
// packages/test/src/SealedConformance.ts — thin wiring suite, one call per declared column
export const runSealedColumnTests = <A, R>(framework: TestFramework, config: {
  readonly column: SealedColumn.Column<A>;
  readonly adapters: ReadonlyArray<{ readonly name: string; readonly layer: Layer.Layer<R, unknown> }>;
  readonly write: (rowKey: string, value: A) => Effect.Effect<void, unknown, R>;     // through the records interface
  readonly read: (rowKey: string) => Effect.Effect<SealedColumn.Sealed<A>, unknown, R>;
  readonly raw: (rowKey: string) => Effect.Effect<string, unknown, R>;               // the stored value, for at-rest checks
}) => void;
// cases: stored value is an envelope (never the plaintext); opens to what was written;
// a ciphertext copied to another row fails Unreadable; after a key rotation `open` re-seals (raw changes, kid current).
```

The **mechanism** suite runs once, in `packages/sql/test/SealedColumn.test.ts` (+ `.postgres.test.ts`). It
exercises every branch of `open`: canonical, legacy hit + re-seal, staleKid re-seal, UnknownKeyId,
DecryptionFailed (tamper: row move, column move), Malformed, `adoptPlaintext`, a lost CAS, a failed swap (logged,
read still succeeds), `resealOnRead: false`, and `sweep` counts.

### 3.7 Records after the change (webhooks, abbreviated)

```ts
// WebhookRecords (interface excerpt)
readonly createEndpoint: (input: { …; readonly secret: Redacted.Redacted<string>;
  readonly headers?: { readonly value: WebhookHeaders.CustomHeaders; readonly names: ReadonlyArray<string> } })
  => Effect.Effect<EndpointRecord, StoreUnavailable>;                     // stamped from the ambient tenant
readonly findEndpoint: (id: string) => Effect.Effect<Option.Option<EndpointRecord>, StoreUnavailable>; // ambient
readonly listEndpoints: Effect.Effect<ReadonlyArray<EndpointRecord>, StoreUnavailable>;               // ambient
// relay: cross-tenant by nature, so the witness is a parameter
readonly listEnabledEndpoints: (grant: TenantScoped.CrossTenant) => Effect.Effect<ReadonlyArray<EndpointRecord>, StoreUnavailable>;
readonly findEndpointForDelivery: (grant: TenantScoped.CrossTenant, id: string) => Effect.Effect<Option.Option<EndpointRecord>, StoreUnavailable>;
readonly claimDue: (grant: TenantScoped.CrossTenant, input: …) => Effect.Effect<ReadonlyArray<DeliveryRecord>, StoreUnavailable>;
// EndpointRecord
readonly secret: SealedColumn.Sealed<string>;
readonly previousSecret: Option.Option<SealedColumn.Sealed<string>>;
readonly headers: Option.Option<SealedColumn.Sealed<WebhookHeaders.CustomHeaders>>;
```

The SQL adapter:

```ts
const scoped = Effect.fnUntraced(function* (grant?: TenantScoped.CrossTenant) {
  return TenantScoped.predicate(sql, "tenantId", yield* TenantScoped.visibility(grant));
});
const endpointsQuery = (where: Statement.Fragment) =>
  sql`SELECT * FROM webhooks_endpoint WHERE ${where} ORDER BY "createdAt", id`;
```

The memory adapter filters with `TenantScoped.matches(Option.getOrNull(row.tenantId), seen)`.

---

## 4. Phased migration

Every phase:

- has its own ticket under `.scratch/plugin-table-substrate/issues/NN-*.md` (Status line, one ticket per phase);
- ends green on `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`, plus `pnpm test:pg`
  whenever a SQL adapter changed (every phase except 3 and 13);
- carries its own changeset, and updates its spec rows in the same commit.

### Phase 0 — tickets

Create `.scratch/plugin-table-substrate/spec.md` (link to this plan) and issues `01`–`14` mirroring the phases below.

### Phase 1 — the substrate, with its own tests (no consumer changes beyond the moves)

Files:

- **New `packages/sql/src/TenantScoped.ts`** (§3.1).
- **New `packages/sql/src/SealedColumn.ts`** (§3.3).
- **New `packages/sql/src/StoreFailure.ts`** (§3.4).
- **`packages/sql/src/index.ts`**: export the three modules and extend the header comment.
- **`packages/sql/package.json`**: add `"@awthaq/api": "workspace:*"`. Add the project reference to
  `packages/sql/tsconfig.json`, then run `pnpm workspace:sync`.
- **`packages/sql/src/TenantScope.ts`**: §3.2 (`RlsOptions.plugins/includeKeyed`, per-kind policies, the
  `pg_policies`-driven `disableRls`, `InRlsScope` provided in `withTenant`). `TENANT_SETTING` is re-exported.
- **`packages/sql/src/Repositories.ts`**:
  - delete private `stampTenant` (`:86-92`) and import `TenantScoped.stamp` (call sites `:405, 468, 1036, 1429, 1962`);
  - re-implement `sealedPii` (`:116-163`) over `SealedColumn.reveal`, keeping `PiiCodec`'s interface and its
    null-and-warn policy unchanged;
  - re-implement the accounts `readColumn` (`:915-946`) over `SealedColumn.reveal`, keeping
    `AccountTokenUndecryptable` and `reencryptOnRead`.
- **`packages/core/src/Errors.ts`**: replace the bodies with re-exports from `@awthaq/sql` `StoreFailure`; the
  exported names and signatures stay the same.
- **`packages/server/src/Authentication.ts:165-167`**: widen `CredentialResolverContribution.resolve` to
  `Effect<Api.Principal, Api.Unauthenticated | Api.StoreUnavailable, HttpServerRequest>`. In the resolver chain,
  record a contribution's `StoreUnavailable` as the request outage, exactly as the cookie scheme's is (`:333-364`).
- **New `packages/test/src/TenantConformance.ts`, `packages/test/src/SealedConformance.ts`** (§3.6). Export them
  from `packages/test/src/index.ts`. Add `@awthaq/sql` to `@awthaq/test` deps (it is already there).

Tests:

- New `packages/sql/test/TenantScoped.test.ts`:
  - `predicate` emits `= $1` / `IS NULL` / `1 = 1`;
  - `matches` agrees with `predicate` on a 3×3 grid of row tenant × visibility, run against `:memory:` SQLite;
  - `stamp`: an explicit tenant wins; the ambient tenant applies; otherwise NULL;
  - `crossTenant` annotates the span;
  - `lift` is a no-op outside `InRlsScope`.
- New `packages/sql/test/TenantScope.postgres.test.ts`:
  - per-kind policies on two scratch tables (Partitioned parent, Derived child);
  - `lift` restores the setting after success, and a failing lifted effect leaves it set (savepoint revert);
  - `disableRls` removes policies it did not create in this call.
  - Move the existing "Tenant RLS (real Postgres)" block (`Repositories.postgres.test.ts:333-460`) here
    unchanged, so RLS has one home. Delete it from `Repositories.postgres.test.ts`.
- New `packages/sql/test/SealedColumn.test.ts` and `SealedColumn.postgres.test.ts`: the mechanism suite (§3.6).
- New `packages/sql/test/StoreFailure.test.ts`:
  - a `ConnectionError` reason becomes `StoreUnavailable` with the operation label;
  - `SqlSyntaxError` and `AuthorizationError` become `Defects/InvariantViolation`;
  - `SchemaError` dies;
  - `retryTransient` retries only retryable reasons. There are no direct `retryTransient` tests in
    `packages/core/test` today (`grep -rn retryTransient packages/core/test` is empty), so these are new.
- `packages/sql/test/PiiEncryption.test.ts` and `AccountsTokenReadPath.test.ts` stay unchanged and must pass.
  They are the regression net for the `sealedPii` and `readColumn` re-implementation.
- `packages/test/test/TenantConformance.test.ts`: run the suite against a fixture plugin with one Partitioned and
  one Derived table, in memory and on SQLite, including a deliberately leaky adapter that the suite must fail
  (`expect` the suite's own `describe` to report failure, as `runPluginContractTests.test.ts` does).
- `scripts/test-pg.sh`: add `packages/sql/test/TenantScope.postgres.test.ts` and `SealedColumn.postgres.test.ts`.

Gate: phase gate plus `pnpm test:pg`. Changeset `.changeset/sql-plugin-table-substrate.md`
(`@awthaq/sql`, `@awthaq/core`, `@awthaq/server`, `@awthaq/test`: minor). Migration note:

- `TenantScope.disableRls` now removes the `awthaq_tenant` policy from every table that has one;
- `Errors.storeUnavailable` now dies on SQL syntax and authorization errors (ADR-EA-028 1.2);
- credential resolvers may fail with `StoreUnavailable`.

### Phase 2 — webhooks tenant hotfix (security hardening, shippable alone)

Files: `packages/webhooks/src/WebhookRecords.ts`, `Webhooks.ts`, `WebhookDelivery.ts`; tests below.

Steps:

1. `WebhookRecords`:
   - `createEndpoint` drops the `tenantId?` input (`:118`). Both adapters stamp with `TenantScoped.stamp`.
   - Ambient-scoped (SQL `WHERE` plus memory `matches`): `findEndpoint`, `listEndpoints`, `updateEndpoint`,
     `setSecrets`, `setDisabled`, `deleteEndpoint`. In SQL, add `AND ${scoped()}` to the select and to the
     `UPDATE`/`DELETE` `WHERE` (`:613-616, 624-640, 775-832`).
   - Ambient through the endpoint, using `EXISTS (SELECT 1 FROM webhooks_endpoint e WHERE e.id = webhooks_delivery."endpointId" AND ${predicate(…,"e")})`:
     `listDeliveries`, `findDelivery`, `redrive`.
   - Witness-taking and cross-tenant: new `listEnabledEndpoints(grant)` (pushes `"disabledAt" IS NULL` into SQL),
     new `findEndpointForDelivery(grant, id)`, and `claimDue`, `markSucceeded`, `reschedule`, `defer`,
     `markDead`, `bumpDead`, `clearDead`, `pruneFinished`, `deleteBySubject`, `listBySubject`.
   - `enqueue` stays unscoped: it is a derived insert, and its rows inherit the endpoint's tenant.
2. `Webhooks.ts`:
   - delete `inScope` and `scopedEndpoints` (`:478-504`);
   - `existing(id)` = `records.findEndpoint(id)` mapped to `WebhookEndpointNotFound`;
   - `createEndpoint`'s limit check uses `records.listEndpoints`;
   - drop `tenantId:` (`:584`);
   - the erasure and export contributions (`:293, 303`) pass
     `TenantScoped.crossTenant("erasure/export: a subject's deliveries in every tenant")`.
3. `WebhookDelivery.ts`: `const relay = TenantScoped.crossTenant("webhooks relay: tenantRoutes decides delivery")`;
   - `:63` becomes `records.listEnabledEndpoints(relay)`;
   - `:154` becomes `findEndpointForDelivery(relay, …)`;
   - pass `relay` to every relay-only call (`:156-303`).
   - **This must land in the same commit as step 1.** Otherwise a background attempt with no tenant only finds
     untenanted endpoints and marks every tenant's delivery `endpointGone`.
4. Keep `Effect.orDie`/`sealed` for now; Phase 4 removes them. This keeps the hotfix diff small.

Tests:

- `packages/webhooks/test/WebhookRecords.test.ts`: add `TestAuth.runTenantIsolationTests` for `webhooks_endpoint`
  (partitioned) and `webhooks_delivery` (derived; `listDeliveries/findDelivery/redrive` as `scoped` via the join),
  over the existing `layerMemory` and `layerSql`.
- `WebhooksTenant.test.ts`:
  - keep `describe("events are routed to the endpoints of their own tenant")` (routing is service behaviour);
  - in `describe("administration is scoped to the ambient tenant")`, keep one case asserting the HTTP-level 404
    for another tenant's endpoint id, plus "maxEndpoints is a per-tenant budget";
  - delete the other store-level cases, which the conformance suite now covers. Name each deleted case in the
    ticket.
- Add to `WebhooksBackground.test.ts`: "a tenant's endpoint receives its delivery when the relay runs with no
  ambient tenant" (the regression guard for step 3).

Spec:

- `spec/behaviors/34-webhooks.md` BEH-EA-309: "administration is scoped **by the store**". Bump to revision 1.2.
- `spec/traceability.md` row.

Changeset `.changeset/webhooks-store-tenant-scope.md` (`@awthaq/webhooks`: patch). Migration note:
`WebhookRecordsShape` changes (relay methods take a `CrossTenant`, `createEndpoint` no longer takes `tenantId`).

### Phase 3 — every plugin declares its tables' tenancy

Files:

- `packages/core/src/AuthPlugin.ts:84-86, 199, 291-320`: §3.5, `Table` constructors, `tenancy` getter;
- `packages/core/src/Auth.ts:271-279, 663-680`: `ManifestPlugin.tenancy`, `Built.tenancy`, validation with
  `Auth/TenancyDeclarationInvalid`;
- `packages/core/src/Migrations.ts:58` (comment);
- `packages/cli/src/Plugin.ts:35, 59, 111`: print tenancy.

Plugin declarations exactly as the "Proposed tenancy" column of §2:

- `admin/src/Admin.ts:829`
- `api-key/src/ApiKey.ts:718`
- `device-authorization/src/DeviceAuthorization.ts:712`
- `jwt/src/Jwt.ts:551`
- `organization/src/Organization.ts:1805-1816`
- `passkey/src/Passkey.ts:1031`
- `qadi/src/UserClaims.ts:260`
- `roles/src/Roles.ts:453`
- `saml/src/Saml.ts:654`
- `scim/src/Scim.ts:417`
- `two-factor/src/TwoFactor.ts:425`
- `webhooks/src/Webhooks.ts:335`
- `examples/plugin-template/src/Template.ts:198`
- `tables: {}` in `magic-link/src/MagicLink.ts:230`, `EmailOtp.ts:235`, `oauth/src/OAuth.ts:730`,
  `password/src/Password.ts:708`, `saml/src/Sso.ts:134`.

Codemod the fixtures (`grep -rln "tables: \[" packages/*/test features examples`, 65 occurrences):

- `packages/{admin,jwt,oauth,passkey,organization,roles,password}/test/AuthComposition.test.ts`
- `packages/core/test/{AuthPlugin,RateLimits,Slots}.test.ts`
- `packages/cli/test/Doctor.test.ts`
- `packages/test/test/{TestAuth,TestAuthDocs,runPluginContractTests}.test.ts`
- `packages/webhooks/test/WebhooksAdmin.test.ts`
- `features/step-definitions/{PluginFixtures,CompileTimeGates,HttpErrorWorld,QadiResolversSteps,TestingHarnessWorld,CliSteps,PersistenceMigrationSteps,PluginTypeGates,CsrfWorld,RateLimitingWorld,MigrationFixtures,TestingHarnessSteps,PluginContractSteps,HooksWorld}.ts`

Tests:

- `packages/core/test/AuthPlugin.test.ts`:
  - BEH-EA-005's type test is rewritten for record keys: `{ other_x: … }` does not compile, and a table with no
    declaration does not compile (`// @ts-expect-error`);
  - `tables` lists the record's keys in declaration order.
- New `packages/core/test/AuthTenancy.test.ts`:
  - each `TenancyDeclarationInvalid` cause;
  - `auth.tenancy` order;
  - manifest content.
- `cli` snapshot of `plugin list` updated.

No runtime behaviour changes: `Built.tenancy` has no consumer until Phase 12. Gate: phase gate (no `test:pg`
needed).

Spec:

- `01-plugin-contract.md` BEH-EA-005 amended. Bump to revision 1.2.
- New BEH in `28-tenancy.md`: "every plugin table declares its tenancy; Auth.make validates it".
- `spec/overview.md`'s `AuthPlugin.Class` row gains `tenancy`.

Changeset `.changeset/plugin-table-tenancy.md` (core, cli, every plugin: minor). Migration note: `tables: [..]`
becomes `tables: { name: AuthPlugin.Table.<kind>(...) }`, with the rule for picking a kind.

### Phase 4 — webhooks: sealed columns and store failures

Files: `WebhookRecords.ts`, `WebhookSecrets.ts`, `Webhooks.ts`, `WebhookDelivery.ts`.

1. Declare the three columns in `WebhookRecords.ts`: `SealedColumn.column({ table: "webhooks_endpoint", column:
   "secret", key: "id", legacyAad: [(id) => \`webhooks-endpoint:${id}:secret\`] })`, the same for
   `previousSecret`, and `headers` with `schema: Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))`.
   Both adapters build `codec(column, swap)`: `sqlSwap` for SQL, and a `Ref` swap for memory. Records now accept
   plaintext `Redacted` values and hand out `Sealed` values (§3.7).
2. Delete `WebhookSecrets.ts`'s `aad`, `seal`, `sealHeaders` and the decrypt halves of `open`/`openHeaders`.
   What remains in `WebhookSecrets.open` (both open) is the grace-window rule:
   - `endpoint.secret.open` with `SealedColumn.option`: `None` fails the attempt as `secret`, as today;
   - `previousSecret`: `SealedColumn.option`, dropped when it does not open, as today.
   - `openHeaders` → `endpoint.headers` opened with `SealedColumn.option`, keeping today's meaning:
     none stored = `{}`; unreadable = `None`.
3. `Webhooks.rotateSecret` (`:686-694`) opens the current secret (`SealedColumn.option`) and passes it as the
   plaintext `previousSecret` to `records.setSecrets`, which seals it under `previousSecret`'s AAD. `Webhooks`
   and `WebhookDelivery` no longer require `Encryption`; `WebhookRecords` does.
4. Replace `const sealed = <A, E>(effect) => Effect.orDie(effect)` (`:736`) and all 35 uses with
   `StoreFailure.orStoreUnavailable("WebhookRecords.<method>")` in SQL. Memory never fails. Every
   `WebhookRecordsShape` member gains `StoreUnavailable` in `E`. `Webhooks` handlers are behind
   `AdminAuthentication` (`WebhooksApi.ts:267`), which declares it. `WebhookDelivery` worker loops:
   - a `StoreUnavailable` in `claimDue` logs and retries on the next tick, instead of the fiber dying;
   - `enqueue` (the `EventTransport`) lets it surface: `deliver`'s `E` is `unknown` (`core/src/EventRelay.ts:56`),
     so the relay's own retry applies.

Tests:

- `WebhookRecords.test.ts`: `runSealedColumnTests` for the three columns over both adapters, plus one case:
  "an endpoint sealed under the legacy `webhooks-endpoint:` AAD opens and is re-sealed canonically". The test
  writes the raw legacy envelope with `Encryption.encrypt` directly.
- Delete as moved:
  - `WebhookDelivery.test.ts` "the stored secret is an Encryption envelope, never the plaintext" (`:511`);
  - the at-rest half of `WebhooksAdmin.test.ts` "returns the secret once; the row holds only its sealed envelope;
    reads never carry it" (keep "returns once; reads never carry it");
  - the at-rest half of `WebhooksHeaders.test.ts:82`.
- Keep as call-site policy:
  - `WebhookDelivery.test.ts:484` "a secret that no longer decrypts … fails as `secret`, never sends";
  - `WebhooksHeaders.test.ts:161`;
  - `WebhooksAdmin.test.ts:251` (rotation grace).
- Add "a store outage in claimDue is logged and retried, the worker keeps running" (`WebhooksBackground.test.ts`).

Spec:

- `34-webhooks.md`: secrets re-seal on rotation of the encryption key, and the outage policy.
- ADR-EA-019 table row (§6).

Changeset (`@awthaq/webhooks` minor). Migration note: `EndpointRecord.secret/previousSecret/headers` are `Sealed`;
`WebhookSecrets.aad/seal/sealHeaders` are removed; `Webhooks` no longer requires `Encryption` directly; stored
secrets re-seal on read, so run `SealedColumn.sweep` to finish.

### Phase 5 — admin

Files: `admin/src/ImpersonationRecords.ts`, `Admin.ts`.

1. Replace `TenantScope { anyTenant?: boolean }` (`:78-82`) with an optional `grant?: TenantScoped.CrossTenant`
   parameter on `findBySessionId`, `endEpisode` and `list`. Delete the exported `TenantScope` type (its name also
   collides with `@awthaq/sql`'s module).
2. Replace `sameTenant` (`:182-184`) with `TenantScoped.matches`. The memory adapter uses it at `:370-376,
   384-396, 453-459`.
3. SQL: replace the three `IS NOT DISTINCT FROM` sites (`:627, 649, 678`) and the `anyTenant` booleans in the
   query requests (`:618-680`) with `TenantScoped.predicate(sql, "tenantId", seen)`. Inserts stamp with
   `TenantScoped.stamp` (`:350, 693`).
4. `closeExpired` and `verifyChain` take a `CrossTenant` (maintenance), and their statements run inside
   `TenantScoped.lift(grant)`. Call sites:
   - `Admin.ts:1131` → `TenantScoped.crossTenant("admin: expired episodes close in every tenant")`;
   - `verifyChain`'s callers (`grep -rn verifyChain packages/*/src packages/cli/src`) →
     `crossTenant("admin: the hash chain spans every tenant")`.
5. `Admin.ts:933` (`{ anyTenant: true }`, the tenant-blind "is this an impersonation session" classification) →
   `crossTenant("admin: classify any session as impersonation")`.
6. `Admin.ts:1183-1192` `tenantScopeFor` returns `Option<CrossTenant>`. It is minted only after
   `canAdministerTenants` passes, as `crossTenant("admin: superadmin (canAdministerTenants)")`.
7. `Effect.orDie` (8 sites) → `StoreFailure.orStoreUnavailable("ImpersonationRecords.<method>")`, and
   `crypto.randomUUIDv7` `PlatformError` → `storeUnavailable`. `AdminShape` methods already sit behind
   `AdminAuthentication` (`AdminApi.ts:366`).

Tests:

- `ImpersonationRecords.test.ts`: add `runTenantIsolationTests`:
  - `admin_impersonation`: `findBySessionId`/`endEpisode`/`list` scoped and also probed `crossTenant`;
    `closeExpired`/`verifyChain` crossTenant; `create` insert;
  - `admin_impersonation_chain` is Global (no case).
  - Delete the tenant cases at `:263-290`, which the suite covers; name them in the ticket.
- `Admin.test.ts:677-731` (superadmin and cross-tenant behaviour through the service) stays: it tests the
  `canAdministerTenants` gate, not the store.
- Add an RLS case (pg): `verifyChain` inside `TenantScope.withTenant("org-a")` with RLS on still reports an intact
  chain. This is the regression for the `lift` finding.

Spec:

- `27-admin-impersonation.md` (IDS-002 wording: witness, not boolean). Bump to revision 1.2.
- `28-tenancy.md` BEH (cross-tenant witness lifts RLS).

Changeset (`@awthaq/admin` minor). Migration note: `ImpersonationRecords.TenantScope` is removed, and its
`{ anyTenant: true }` becomes a `TenantScoped.crossTenant(reason)` argument.

### Phase 6 — organization (must land before plan 04)

Files: `organization/src/{OrganizationRecords,MembershipRecords,InvitationRecords,TeamRecords,OrgRoleRecords,ActiveContextRecords,ConnectionRecords,OrganizationConnections,Organization}.ts`.

1. **Cross-organization methods take a witness.** Each of the 27 allowlist entries in
   `organization/test/TenantScoping.test.ts` gets the disposition below. The *why* text moves into the
   `crossTenant(...)` reason at the method, so the justification lives next to the code (locality).

   | Allowlist statement (abbrev.) | Disposition |
   |---|---|
   | `organization_org WHERE (id\|slug) =` | keyed (the id is the key; slug resolves it) |
   | `organization_org WHERE id IN` (listByIds) | witness: "a caller's own memberships across organizations" |
   | `organization_org … ORDER BY … LIMIT` (listPage) | witness: "platform listing behind canAdministerTenants" |
   | `UPDATE organization_org SET suspendedAt` | witness: "platform suspension" |
   | `UPDATE organization_org SET …` / `DELETE organization_org WHERE id` | keyed |
   | `c.* FROM organization_oauth_connection c JOIN … domain` (findByEmailDomain) | witness: "home-realm discovery" |
   | `domain, connectionId … WHERE connectionId IN` (domainsOf) | derived child read (coverage map `derived`) |
   | `DELETE … oauth_connection_domain WHERE connectionId` | add `AND "organizationId" = ${org}` → keyed |
   | `organization_membership WHERE userId` (listByUser) | witness: "a user's own memberships" |
   | `DELETE organization_membership WHERE userId` | witness: "erasure" |
   | `DELETE organization_invitation WHERE inviterId …` (both) | witness: "erasure" |
   | `organization_invitation WHERE inviterId` (export) | witness: "data-subject export" |
   | `teamId … organization_team_membership WHERE userId` | witness: "erasure" |
   | `DELETE organization_active_context WHERE userId` | witness: "erasure" |
   | `organization_invitation WHERE id` (findById) | witness: "the invitation id is the capability" |
   | `UPDATE organization_invitation SET status … WHERE id` | add `AND "organizationId" =` → keyed (callers hold the org) |
   | `organization_invitation WHERE tokenHash` | witness: "the emailed token hash is the capability" |
   | `UPDATE organization_invitation SET tokenHash … WHERE id` | add `AND "organizationId" =` → keyed |
   | `organization_invitation WHERE email` (listByEmail) | witness: "the invitee's own pending invitations" |
   | `COUNT … organization_invitation WHERE inviterId` | witness: "deployment-wide per-inviter quota" |
   | `organization_team WHERE id` (findTeamByIdAnyOrg) | witness: "qadi team-member relation existence" |
   | closure `COUNT … WHERE ancestorId` / `DELETE … descendantId (IN\|=)` | derived (team ids already keyed-checked) |
   | `UPDATE organization_team SET memberCount … WHERE id` | add `AND "organizationId" =` → keyed |

   Witness-taking methods wrap their statement in `TenantScoped.lift(grant)`. Erasure and export contributions
   (`Organization.ts:1730, 1756, 1822`) mint their witness at the contribution.
2. **Sealed `clientSecret`.**
   - Declare `organization_oauth_connection.clientSecret` with `legacyAad`.
   - `ConnectionRecords` seals and hands out `Option<Sealed<string>>`.
   - `OrganizationConnections.buildSet` (`:152-172`) opens with `SealedColumn.option`. Drop-and-warn is unchanged,
     now logged once by the substrate.
   - `layerStore.sealSecret` (`:408-409`) and the private `secretAad` (`:70-71`) are deleted.
3. **Store failures.** 81 `orDie` sites across the 7 records modules → `StoreFailure`. `Organization` service
   methods already widen to `StoreUnavailable` (they compose core services), and the endpoints sit behind
   `Authentication` (`OrganizationApi.ts:946`). `TenantMiddleware.ts` already maps its own `SqlError` (`:55-64`).

Tests:

- Delete `organization/test/TenantScoping.test.ts`.
- Add `runTenantIsolationTests` to each of `{Organization,Membership,Invitation,Team,OrgRole,ActiveContext,Connection}Records.test.ts`.
  Keyed probes pass org A's id and must not touch org B's rows; witness methods are `crossTenant`; closure and
  domain children are `derived`. The compile-time `methods` map replaces the regex guard's "a new unscoped query
  fails CI".
- `runSealedColumnTests` for `clientSecret` in `ConnectionRecords.test.ts`, plus a legacy-AAD case.
- `OrganizationConnections.test.ts:238` "a connection whose secret no longer decrypts is dropped alone" stays
  (call-site policy).

Docs:

- `docs/plugin-authoring.md:83`: replace the "static guard you can copy" bullet (full rewrite in Phase 13).

Spec:

- `35-organization.md` revision 1.1.
- `28-tenancy.md` (keyed tenancy).

Changeset (`@awthaq/organization` minor). Migration note:

- cross-organization records methods take a `CrossTenant`;
- `ConnectionRecord.clientSecret` is `Option<Sealed<string>>`;
- client secrets re-seal on read.

### Phase 7 — SAML

Files: `saml/src/SamlRecords.ts`, `SamlSpKeys.ts`, `Saml.ts`, `SamlSlo.ts`, `SamlAdmin.ts`.

1. Declare `saml_sp_key.privateKey` with `legacyAad: [(id) => \`saml-sp-key:${id}:privateKey\`]`.
   - `SamlRecords.saveSpKey` takes `privateKeyPem: Redacted<string>` and seals.
   - `SpKeyRecord.privateKey` becomes `Sealed<string>`.
   - `SamlSpKeys.signingKey` (`:107-129`) opens with `SealedColumn.orDie`. Fail-closed is unchanged; the defect
     tag becomes `sealedColumn.readable`, so update the assertion in `SamlSigning.test.ts:197-226`.
   - `SamlSpKeys` no longer requires `Encryption`, and its no-op `.pipe(Effect.orDie)` (`:93-95`) goes.
2. Tenancy:
   - connection lookups by organization stay keyed;
   - domain discovery and the ACS/SLO lookups of a connection by id from a protocol message (pre-tenant, public
     endpoints) take `crossTenant("saml: the protocol message names the connection before any tenant is known")`;
   - `Saml.ts:1095` and `SamlSlo.ts:186, 367` keep switching to the connection's tenant for the session work.
3. 24 `orDie` sites → `StoreFailure`. `SamlApi` already declares `Api.StoreUnavailable` (`SamlApi.ts:126`).

Tests:

- `SamlRecords.test.ts`: `runTenantIsolationTests` (keyed `saml_connection`; derived domain/key/session) and
  `runSealedColumnTests(privateKey)` with a legacy case.
- Delete as moved: `SamlSigning.test.ts:172` "is stored only sealed, under an AAD that names the key: it opens
  there and nowhere else".
- Keep: `:197` (fail closed) and `:227`.

Spec: `29-saml-sp.md` BEH-EA-314 (re-seal). Bump to revision 1.3. Changeset (`@awthaq/saml` minor).

### Phase 8 — JWT

Files: `jwt/src/SigningKeyRecords.ts`, `RevocationStore.ts`, `KeyRing.ts`, `Jwt.ts`.

1. Declare `jwt_signing_key.privateKeyJwk` with `schema: Schema.fromJsonString(Schema.Record(Schema.String,
   Schema.Unknown))`, `key: "kid"`, no legacy (already canonical).
   - `SigningKeyRecord.privateKeyJwk` becomes `Option<Sealed<Jwk>>`.
   - `decodeRow` (`:245-272`) stops decrypting.
   - `KeyRing` opens the current key with `SealedColumn.orDie`. The deployment fault stays a defect; its tag is
     now `sealedColumn.readable` (was `SigningKeyUndecodable`). The public-JWK decode keeps its own
     `InvariantViolation`.
   - `layerMemory` seals too, so it requires `Encryption`. Update `api-key/test/harness.ts:119`,
     `jwt/test/{AuthHttp,JwtTenantConfig,KeyRing}.test.ts`.
2. Stale-kid keys now re-seal on read. Before this, a rotated `AWTHAQ_ENCRYPTION_KEY_ID` left every signing key on
   the retired kid forever, so it could never be dropped.
3. `orDie` (4 + 2) → `StoreFailure`, keeping `CurrentKeyConflict`'s `UniqueViolation` catch first
   (`SigningKeyRecords.ts:365-372`).
   - `KeyRing`'s Shape gains `StoreUnavailable`.
   - The bearer resolver (`Jwt.ts:437`) can now surface it (Phase 1 widening).
   - The public `jwt` group (JWKS, `JwtApi.ts:57`) adds `Api.StoreUnavailable` to its endpoint `error` list. The
     compiler names the endpoint.

Tests:

- `KeyRing.test.ts`: replace `describe("layerSql private key at rest (KRS-001)")`, i.e.
  "never stores the private JWK in plaintext" and "a privateKeyJwk ciphertext copied onto another kid's row fails
  to decrypt" (`:348-386`), with `runSealedColumnTests`.
- Add "a signing key written under a retired kid is re-sealed on the next mint/verify".
- `RevocationStore`: no tenancy cases (Global).

Spec: `36-jwt.md` revision 1.1; ADR-EA-017 cross-reference only. Changeset (`@awthaq/jwt` minor). Migration note:
`SigningKeyRecords.layerMemory` requires `Encryption`.

### Phase 9 — SCIM

Files: `scim/src/ScimRecords.ts`, `Scim.ts`, `ScimConnections.ts`.

- `scim_connection` keyed. `findConnectionByTokenHash` (`:590`) takes
  `crossTenant("scim: the bearer token hash is the capability")`. `scim_resource` is derived.
- 9 + 3 `orDie` → `StoreFailure`. `ScimApi` already declares `StoreUnavailable`.

Tests:

- `ScimRecords.test.ts`: `runTenantIsolationTests`.
- Check `ScimUsers.test.ts`/`ScimHttp.test.ts` outage assertions still hold, and delete any that re-test the
  records mapping.

Spec: `30-scim.md`. Changeset (`@awthaq/scim` minor).

### Phase 10 — two-factor (adoption; behaviour already correct)

Files: `two-factor/src/TwoFactorStore.ts`, `SecondFactor.ts`.

- Declare `two_factor_secret.secret`: `key: "userId"`, `legacyAad: [(userId) => \`two_factor_secret:${userId}\`]`.
  - The store seals and hands out `Sealed<string>`.
  - `SecondFactor.readSecret` (`:201-229`) becomes `record.secret.open.pipe(SealedColumn.orDie)` plus the base32
    decode.
  - Delete `secretAad` (`:130`) and the manual re-encrypt (`:216-219`).
  - Delete `TwoFactorSecretsShape.reencrypt` (`TwoFactorStore.ts:71-72, 169, 351-364, 398-399`); the substrate's
    CAS swap replaces it.
- 13 `orDie` → `StoreFailure`. `TwoFactor`'s groups sit behind `CsrfProtection`/`Authentication`, which declare it.

Tests:

- Delete `TwoFactorStore.test.ts:97` "reencrypt swaps the envelope only while the row still holds the one that was
  read". It is replaced by the mechanism suite's lost-CAS case and by `runSealedColumnTests(secret)` with a legacy
  case.

Spec: `31-two-factor.md`; ADR-EA-020 decision 1 wording (the AAD gains `:secret`). Changeset
(`@awthaq/two-factor` minor).

### Phase 11 — remaining stores: store failures and Global classification only

Files:

- `api-key/src/{ApiKeyRecords,ApiKeyClientRecords,ApiKey}.ts`
- `device-authorization/src/{DeviceGrantRecords,DeviceClientRecords,DeviceAuthorization,UserCode}.ts`
- `passkey/src/{PasskeyCredentials,PasskeyUserHandles,ChallengeStore,Passkey}.ts`
- `roles/src/Roles.ts:278-314`
- `qadi/src/UserClaims.ts:208, 229`

Steps:

- `orDie` on records → `StoreFailure`.
- Shapes gain `StoreUnavailable`, including `PasskeyCredentials.recordUsage` (`Passkey.ts:1614`, flagged by plan
  10 item 2).
- Public groups that do not inherit it from middleware add `Api.StoreUnavailable` to the endpoint error lists:
  - `apikey.token` (`ApiKeyApi.ts:257`);
  - the device-authorization public endpoints already declare it (`DeviceAuthorizationApi.ts`).
- API-key resolvers (`ApiKey.ts:636, 654`) surface outages as `StoreUnavailable`.
- No tenancy cases: all these tables are Global.
- Each plugin's existing records suite gains one outage case through a failing `SqlClient` layer: one
  `StoreFailure`-mapping test per module, not per method.

Changeset per package (minor). Migration note: records Shapes widen by `StoreUnavailable`.

### Phase 12 — RLS rollout for plugin tables

Files:

- `packages/sql/README.md` "Multi-tenancy" (`:142`) and "Data location & residency" (`:167`):
  `TenantScope.enableRls({ plugins: auth.tenancy })`, `includeKeyed`, backfill-before-enable, non-owner role,
  and `lift`.
- `organization/src/TenantMiddleware.ts` header (`:19-20`): what `layerWithRls` now covers.
- `features/features/12-multi-tenancy/28-tenancy.feature` + `features/step-definitions/TenancySteps.ts`, new
  scenarios:
  - a plugin's partitioned table is confined inside a tenant scope with RLS on;
  - a derived table is confined through its parent;
  - a witnessed cross-tenant read sees every tenant under RLS;
  - `disableRls` removes every policy.
- `scripts/test-pg.sh`: confirm every records suite that now calls `runTenantIsolationTests` with `rls` is listed.
  All 25 plugin suites are already there (`:20-50`).

Steps:

1. Wire `rls: SqlLive` into each plugin's conformance call. It is skipped off Postgres, so it runs in
   `pnpm test:pg` and in CI's Postgres service (`.github/workflows/check.yml`).
2. Add `packages/organization/test/TenantMiddleware.test.ts` (pg-only block): a full request through
   `layerWithRls` lists only its tenant's webhook endpoints, even with a records adapter whose predicate is
   deliberately removed. This proves the backstop end to end.
3. No default flips: `enableRls()` with no argument still covers only core tables.

Spec: BEH-EA-233 amended (plugin tables via declarations; derived through parent; keyed opt-in). Revision of
`28-tenancy.md` → 1.1. Changeset (`@awthaq/sql`, `@awthaq/organization` minor). Migration note: opting in is
`enableRls({ plugins: auth.tenancy })`; backfill NULL `"tenantId"` rows first if they must remain visible inside
tenant scopes (ADR-EA-018 Consequences).

### Phase 13 — authoring surface

Files:

- `examples/plugin-template/src/Template.ts`:
  - `notes_note` gains `"tenantId"` (an appended migration, as the template teaches);
  - `tables: { notes_note: AuthPlugin.Table.partitioned() }`;
  - `NoteRecords` gains `layerMemory`;
  - records use `TenantScoped.stamp/predicate/matches` and `StoreFailure`; no `orDie`.
- `examples/plugin-template/test/Template.test.ts`: `runTenantIsolationTests` over both layers.
- `docs/plugin-authoring.md`:
  - the Persistence row (`:15`) names `TenantScoped`/`SealedColumn`/`StoreFailure`;
  - replace `:83` with "declare each table's tenancy; filter through `TenantScoped.predicate`; cross-tenant
    methods take a `CrossTenant`; run `TestAuth.runTenantIsolationTests`";
  - a new "Sealed columns" section;
  - a new "Store failures" bullet under Contract (records fail with `StoreUnavailable`; public endpoints list it);
  - checklist item 4 (`:100`): the template ships both adapters now;
  - new checklist item: the tenancy and sealed suites.
- `AGENTS.md`: no change (it already points at the doc).

Gate: the plan gate `pnpm check` plus `pnpm test:pg`.

### Phase 14 — legacy AAD sunset (a later release; ticket created now, `Status: needs-info`)

Criteria:

- one minor release has shipped with Phase 4–10;
- the release notes told operators to run `SealedColumn.sweep` per column (a CLI wrapper
  `awthaq migration reseal` is optional: open question Q5);
- `sweep` reports `resealed: 0` on a reference deployment.

Then delete every `legacyAad` entry and the legacy branch of `open`, and record it in ADR-EA-019 revision 1.2.

---

## 5. Test plan

| Concern | Where it runs | Adapters / dialects | Replaces |
|---|---|---|---|
| Tenant predicate, matcher, stamp, lift | `sql/test/TenantScoped.test.ts` | SQLite | — |
| RLS policies per kind, lift restore, disable | `sql/test/TenantScope.postgres.test.ts` | Postgres | the RLS block of `Repositories.postgres.test.ts:333-460` (moved) |
| Sealed mechanism (every `open` branch, CAS, sweep) | `sql/test/SealedColumn{,.postgres}.test.ts` | memory swap, SQLite, Postgres | — |
| Store failure classification and retry | `sql/test/StoreFailure.test.ts` | — | — (new; core has no direct retry tests) |
| **Tenant-isolation conformance**, per plugin table | each `*Records.test.ts` via `TestAuth.runTenantIsolationTests` | `layerMemory`, `layerSql` on SQLite; `layerSql` + RLS on `test:pg` | `organization/test/TenantScoping.test.ts` (deleted); `admin/test/ImpersonationRecords.test.ts:263-290` tenant cases; store-level cases of `webhooks/test/WebhooksTenant.test.ts` |
| **Sealed wiring**, per declared column | `WebhookRecords`, `ConnectionRecords`, `SamlRecords`, `KeyRing`, `TwoFactorStore` tests via `TestAuth.runSealedColumnTests` | memory + SQLite (+ pg via `test:pg`) | `WebhookDelivery.test.ts:511`; at-rest halves of `WebhooksAdmin.test.ts:146`, `WebhooksHeaders.test.ts:82`; `SamlSigning.test.ts:172`; `KeyRing.test.ts:348-386`; `TwoFactorStore.test.ts:97` |
| Call-site Unreadable policy | existing service tests | — | kept: `WebhookDelivery.test.ts:484`, `WebhooksHeaders.test.ts:161`, `SamlSigning.test.ts:197`, `OrganizationConnections.test.ts:238` |
| Declaration typing and validation | `core/test/AuthPlugin.test.ts`, `core/test/AuthTenancy.test.ts` | type-level + runtime | BEH-EA-005 case rewritten |
| End-to-end RLS backstop | `organization/test/TenantMiddleware.test.ts` (pg block), `features/.../28-tenancy.feature` | Postgres | — |
| Relay regression | `WebhooksBackground.test.ts` new case | memory + SQLite | — |
| Lift regression | `ImpersonationRecords.test.ts` pg case (`verifyChain` under RLS) | Postgres | — |

Rules:

- Conformance and sealed suites are framework-injected (`TestFramework`), so `examples/plugin-template` and
  third-party plugins run the same suites.
- The coverage map over `keyof Shape` makes "a new records method without a tenancy classification" a compile
  error. This is the type-system replacement for the regex guard.
- No case is duplicated between the mechanism suite and a wiring suite: wiring proves the plugin used the
  declaration, and the mechanism proves the declaration works.

---

## 6. Spec, ADR, traceability, docs, changesets

ADR amendments (Document Control: revision, effective date, change history):

- **ADR-EA-018 → 1.2.** Decision 10 "Plugin tables declare their tenancy":
  - the four kinds;
  - `Auth.make` validation and `auth.tenancy`;
  - `TenantScoped` is the store-level filter for Partitioned tables;
  - cross-tenant access is a `CrossTenant` witness that also lifts RLS (`lift`), and `Tenant.withoutTenant` alone
    does not lift RLS;
  - Keyed tables keep explicit keys.

  Amend decision 5: `enableRls({ plugins, includeKeyed })`; `disableRls` drops every `awthaq_tenant` policy.
  Status: "implemented, including plugin tables".
- **ADR-EA-019 → 1.1.** Decision 6 "One sealed-column interface":
  - canonical AAD `<table>:<rowKey>:<column>`;
  - re-seal on `staleKid` or a legacy hit by compare-and-swap, failures logged;
  - typed `SealedColumn/Unreadable` with exactly two call-site treatments (`orDie`, `option`);
  - `legacyAad` read path and its sunset criteria;
  - `sweep` (narrows decision 3's "batch is out of scope": the library now ships the job, and running it stays
    operational).

  Add a table of the six plugin columns and their policy.
- **ADR-EA-028 → 1.2.**
  - Scope extended to plugin records (decision 2 "a repository" now includes plugin records modules).
  - Option A ("defects") is rejected for plugins on the same grounds.
  - The helper is defined once in `@awthaq/sql` `StoreFailure`, and core re-exports it.
  - New decision 3a: `SqlSyntaxError` and `AuthorizationError` reasons die (`store.statementRefused`), because a
    retry cannot fix them and a 503 would misreport a forgotten tenant filter refused by RLS.
  - Decision 4 gains: credential-resolver contributions may fail with `StoreUnavailable`.
  - Rollout paragraph lists the plugins.
- **ADR-EA-020 → 1.1.** Decision 1: the AAD is `two_factor_secret:<userId>:secret`, and the legacy form still
  opens and re-seals.
- `spec/decisions/index.yaml`: the revision and status fields of 018/019/020/028.

Behaviors:

- Allocate the next free ids at execution time. The highest today is BEH-EA-318; plans 01–10 may allocate first,
  so read `spec/behaviors/index.yaml` before numbering.
- `28-tenancy.md`, 1.1:
  - new: "every plugin table declares its tenancy";
  - new: "plugin partitioned tables are filtered by the store, identically in memory and SQL";
  - new: "a cross-tenant read requires a witness and lifts RLS";
  - amended: BEH-EA-233.
- `05-persistence-stratum.md`, 1.2: new "a sealed column is declared once and re-sealed on read"; new "plugin
  records fail with StoreUnavailable".
- `01-plugin-contract.md`, 1.2: BEH-EA-005.
- `34-webhooks.md` 1.2, `27-admin-impersonation.md` 1.2, `35-organization.md` 1.1, `29-saml-sp.md` 1.3,
  `36-jwt.md` 1.1, `31-two-factor.md` 1.1, `30-scim.md`: the per-plugin wording above.
- `spec/behaviors/index.yaml` entries.

Other spec, BDD and docs:

- **`spec/traceability.md`**: rows for the new BEH ids, naming `@awthaq/sql/src/{TenantScoped,SealedColumn,StoreFailure,TenantScope}.ts`
  and the suites. Bump the document's revision.
- **`spec/overview.md`** 1.3:
  - Persistence row: "tenant scoping, sealed columns, store-failure mapping, RLS";
  - `AuthPlugin.Class` row gains `tenancy`;
  - `Auth.Built` gains `tenancy`.
- **BDD**: Phase 12 scenarios; `features/traceability.md` regenerated by the existing allocator.
- **Docs**: `docs/plugin-authoring.md` (Phases 6 and 13), `packages/sql/README.md` (Phase 12), and the READMEs of
  changed plugins where they document sealing or tenancy (`pnpm check:readmes` stays green).
- **Changesets**: one per phase as listed, each with a "Migration:" paragraph (ADR-EA-034). No numbered DDL
  migration ships, except the template example. The data migration is lazy re-seal plus `SealedColumn.sweep`,
  stated in the Phase 4–10 notes.

---

## 7. Risks, mitigations, rollback

| Risk | Likelihood / impact | Mitigation | Rollback |
|---|---|---|---|
| Relay loses tenant endpoints once `findEndpoint` is ambient-scoped (background has no tenant) | high if split / severe (all tenant deliveries marked dead) | Phase 2 step 3 lands in the same commit; dedicated regression test; relay methods take a witness, so a missing one is a compile error | revert Phase 2 (self-contained) |
| Legacy-AAD rows never read again keep the legacy branch alive | certain / low | `sweep`; Phase 14 criteria; the legacy attempt costs one extra decrypt only on legacy rows | none needed (the read path is additive) |
| A re-seal write races a rotation or update | medium / none | compare-and-swap on the stored value; a lost swap is logged, never retried | — |
| Re-seal write on a read path hits a read-only replica or a busy DB | low / low | `swap` uses the captured primary client; failures are logged and never fail the read; `SealedColumnConfig.resealOnRead: false` opts out | set the reference |
| Ciphertext data loss | very low / severe | no destructive step: an old envelope is replaced only by a CAS after successfully opening it and sealing anew; `sweep` reports `unreadable` and does not touch those rows | keep `legacyAad` (Phase 14 is gated) |
| RLS on plugin tables breaks an existing deployment | low / high | opt-in by argument (`enableRls()` without `plugins` is unchanged); README backfill guidance; `disableRls` removes every policy | `TenantScope.disableRls` |
| Cross-tenant maintenance confined by RLS (`verifyChain` false break, `closeExpired` misses rows, erasure incomplete) | high without `lift` / medium-high | every Global/witness method wraps in `lift`; pg regression cases (Phase 5) | disable RLS for plugin tables |
| `lift` mis-restores the setting and leaks a tenant within one transaction | low / high | restore on the success path inside a savepoint; failure path reverts by savepoint rollback; dedicated pg test | — |
| Derived-table policy cost (EXISTS per row) | medium on `claimDue` / low | the relay runs without a tenant, so the `unset OR` short-circuits; every `via` column and parent key is indexed (§3.2) | omit the derived table from `plugins` |
| `IS NULL` vs `= $1` differs from the old `IS NOT DISTINCT FROM` | low / low | same semantics; the conformance NULL case pins it | — |
| `StoreFailure` classification makes some 503s into 500s | low / low | only syntax and authorization (incl. RLS refusal) reasons; logged at error level with the operation | revert the classification in one function |
| `E` widening cascade through plugin Shapes and public endpoints | certain / low | the compiler names each site; most groups inherit `StoreUnavailable` from middleware | per-phase revert |
| Fixture churn (65 `tables:` sites) | certain / low | mechanical codemod in Phase 3, no behaviour change | revert Phase 3 |
| JWT/two-factor memory adapters now need `Encryption` | certain / low | ephemeral or test key layers; plan 08's bundles provide it | — |

Rollback granularity: each phase is one PR, and each plugin phase reverts alone, because the substrate stays.
Phase 1 can only be reverted after every consumer phase.

---

## 8. Interactions with other plans

- **02 (store seam).** This plan defines the shared modules once, and 02 consumes them without redefining:
  - `StoreFailure` (`storeUnavailable`, `orStoreUnavailable`, `retryTransient`, the defect classification);
  - `TenantScoped.stamp` (moved from `Repositories.ts:86-92`);
  - `SealedColumn.reveal` (what core's PII and token codecs already run on after Phase 1).

  02's memory and SQL core stores filter with `TenantScoped.matches`/`predicate` where they read partitioned
  tables, and may declare core columns as `SealedColumn.column` with `legacyAad` for core's formats (its choice).
  02 also owns adopting `TenantScoped.lift` for core cross-tenant operations (`revokeAllForUser`, erasure of
  sessions), which have the RLS confinement gap from §2.
- **03 (erasure).** Erasure is cross-tenant by nature. The single cascade runs its contributions under
  `TenantScoped.lift(crossTenant("erasure"))`, so RLS cannot leave another tenant's rows behind. Plugin
  contributions in this plan already pass witnesses (webhooks Phase 2, organization Phase 6).
- **04 (organization system modules).** Phase 6 lands first. When 04 splits the organization records, it must
  carry over:
  - every `CrossTenant` reason from the Phase 6 table;
  - the keyed `AND "organizationId" =` additions;
  - the per-module `runTenantIsolationTests` coverage maps, which re-classify per new Shape (the compiler forces it);
  - the sealed `clientSecret`.

  04's SCIM team create/delete through the organization interface sees `StoreUnavailable` in `E` from Phase 6 and
  Phase 9.
- **08 (test composition).** The matched `Plugin.records.memory/sql` bundles are exactly the pairs this plan's
  suites take. Bundles that contain a sealed column (webhooks, organization connections, SAML, JWT, two-factor)
  require `Encryption`, and `TestAuth.layer` should provide a fixed test key. 08 may fold
  `runTenantIsolationTests`/`runSealedColumnTests` into `runPluginContractTests` via the plugin's `tenancy`
  declaration.
- **10 (standalone fixes).**
  - Item 2 (sign-in `orDie` hotfix) is independent and lands first.
  - Item 8h (`sealed` misnamed) is resolved by Phase 4 deleting it.
  - Item 6 (`RetentionRegistry`) may add `retention` to `TableDeclaration` (§3.1), which is why the declaration is
    a record and not a bare `Tenancy`.
  - `PasskeyCredentials.recordUsage` (`Passkey.ts:1614`) is Phase 11.
- **01 (sign-in/sign-up).** No shared files beyond `Saml.ts`. Phase 7 touches the records lookups, and 01 the ACS
  completion (`Saml.ts:1025-1060`). Rebase whichever lands second; there is no semantic conflict.

---

## 9. Acceptance checklist

- [ ] `@awthaq/sql` exports `TenantScoped`, `SealedColumn`, `StoreFailure`. `TenantScope.enableRls` accepts
      `{ plugins, includeKeyed }`, and `disableRls` drops every `awthaq_tenant` policy.
- [ ] `core/src/Errors.ts` defines nothing and only re-exports `StoreFailure`; `Repositories.ts` has no private
      `stampTenant`, and its PII/token codecs run on `SealedColumn.reveal`.
- [ ] `grep -rn "Effect.orDie" packages/*/src/*Records.ts packages/*/src/{TwoFactorStore,ChallengeStore,PasskeyCredentials,PasskeyUserHandles,RevocationStore,SamlSpKeys}.ts packages/roles/src/Roles.ts packages/qadi/src/UserClaims.ts`
      finds no store-error `orDie` (any remaining `orDie` is on `crypto` id minting inside a service and carries a
      comment).
- [ ] No `IS NOT DISTINCT FROM`, no `anyTenant`, and no in-memory tenant filter in any plugin service
      (`grep -rn "anyTenant\|IS NOT DISTINCT" packages/*/src` is empty; `Webhooks.ts` has no `scopedEndpoints`).
- [ ] Every `AuthPlugin.Service` declares `tables` as a record of `TableDeclaration`; `Auth.make` exposes
      `auth.tenancy` and refuses invalid declarations; `awthaq plugin list` prints tenancy.
- [ ] Every Partitioned, Keyed and Derived plugin table has a `runTenantIsolationTests` case, and every records
      interface has a complete compile-time coverage map. `organization/test/TenantScoping.test.ts` is deleted.
- [ ] `pnpm test:pg` runs the conformance suites with RLS on, as a non-owner role, and the deliberately leaky probe
      is confined.
- [ ] All six plugin sealed columns are `SealedColumn` declarations. No plugin source calls `encryption.decrypt`
      on a table column (`grep -rn "encryption.decrypt" packages/{webhooks,organization,saml,jwt,two-factor}/src`
      is empty). Legacy AADs open and re-seal (one test per column). The re-seal on `staleKid` is tested per column.
- [ ] Every `SealedColumn/Unreadable` is handled by `SealedColumn.orDie` or `SealedColumn.option` at a named call site.
- [ ] Public endpoints that can now see `StoreUnavailable` declare it; credential resolvers can fail with it.
- [ ] ADR-EA-018 1.2, 019 1.1, 020 1.1, 028 1.2; behaviors, traceability, overview, index.yaml updated; BDD
      scenarios added; `docs/plugin-authoring.md` and the template updated.
- [ ] One changeset per phase with a migration note; Phase 14 ticket exists with its criteria.
- [ ] `pnpm check` and `pnpm test:pg` are green at the end.

---

## 10. Open questions (only the user can answer)

- **Q1 — AAD convention vs zero migration.** The plan canonicalises to `<table>:<rowKey>:<column>`, with a lazy
  legacy path and a sweep. The alternative freezes each column's current AAD as an explicit per-column override,
  with no migration and no Phase 14, at the cost of keeping four spellings. Which do you want?
- **Q2 — Keyed tables and the ambient tenant.** When a request runs under tenant A, may it act on organization B
  through an explicit `organizationId`? Today it may; this plan keeps that. Requiring `key = ambient` unless
  witnessed would close "tenant A's host administers org B", but would change the organization switcher's
  behaviour on tenant hosts.
- **Q3 — RLS for keyed (organization) tables by default.** The plan makes them opt-in (`includeKeyed`), mirroring
  `includeDirectory`. Should `enableRls({ plugins })` cover them by default instead?
- **Q4 — Global tables that could partition.** `device_authorization_grant`, `passkey_challenge`, `apikey_key`
  and `apikey_client` are declared Global. Do you want tenant columns on any of them (for example API keys owned by
  an organization)? Each one would be a new plugin migration and a Partitioned declaration.
- **Q5 — Operator surface for the sweep.** Is a library effect (`SealedColumn.sweep`) enough, or should Phase 14
  add `awthaq migration reseal` to the CLI?
- **Q6 — StoreFailure classification for core.** The plan makes `SqlSyntaxError` and `AuthorizationError` defects
  everywhere, core included. Keep that, or limit the classification to plugin records and leave core's
  "every SqlError is 503" as is?
- **Q7 — Admin chain under RLS.** `admin_impersonation_chain` is declared Global, so it never gets RLS. Its rows
  carry tenant ids in `payload`, readable by any tenant-scoped connection with table access. Acceptable, or should
  the chain split per tenant (a new ledger design, out of this plan's scope)?

---

## 11. Decisions taken (implementation)

Open questions (section 10), taken at the plan's recommended default:

- **Q1** AAD: canonicalise to `<table>:<rowKey>:<column>` with `legacyAad` read fallbacks, lazy re-seal and `SealedColumn.sweep`.
- **Q2** Keyed tables keep explicit organization keys; no `key = ambient` requirement.
- **Q3** RLS for Keyed (organization) tables is opt-in (`includeKeyed`).
- **Q4** `device_authorization_grant`, `passkey_challenge`, `apikey_key`, `apikey_client` stay Global; no new tenant columns.
- **Q5** `SealedColumn.sweep` is a library effect only; no `awthaq migration reseal` CLI.
- **Q6** The `SqlSyntaxError`/`AuthorizationError` defect classification applies to core as well.
- **Q7** `admin_impersonation_chain` stays Global (the chain is one append-only ledger over every tenant).

Phase 1:

- The tenant-stamp rule is `Tenant.stamp` in `@awthaq/ports` (README reconciliation, plan 02's placement). `TenantScoped.stamp` is `Tenant.stamp`; `Repositories.ts` uses `Tenant.stamp` directly. `StoreFailure` lives in `@awthaq/sql`, `core/src/Errors.ts` re-exports it.
- ADR revisions are one higher than the plan wrote where a plan before this one already bumped them: ADR-EA-028 is revision 1.3 (1.2 was plan 10 item 2); ADR-EA-018 1.2; ADR-EA-019 1.1. New behaviors are BEH-EA-324..328 (highest before this plan was 323); they are appended at the end of `05-persistence-stratum.md` and `28-tenancy.md` the way BEH-EA-322/323 were, so `spec/README.md`'s per-file ranges list them.
- The plan's `SealedColumn.postgres.test.ts` is not a separate file: `SealedColumn.test.ts` and `TenantScoped.test.ts` build their database with `TestSql.layer`, so the same suites run on Postgres under `pnpm test:pg` (both are added to `scripts/test-pg.sh`). `TenantScope.postgres.test.ts` is Postgres-only.
- `lift` opens its savepoint with `SqlTransaction.transactional` (the repo's `check:transactions` forbids a bare `sql.withTransaction`).
- `server`: `CredentialResolverContribution.resolve` was already widened by plan 10 item 0; this phase adds the outage recording in `resolveClaimed`.
- Conformance suites: `TestFramework` moved to `packages/test/src/TestFramework.ts` (a cycle with `TestAuth.ts` otherwise); `runTenantIsolationTests` takes `covers` (the declared tables one records interface is responsible for, since a plugin makes one call per `Shape`) and a structural `plugin` (`AuthPlugin.Any` satisfies it once phase 3 adds `tenancy`); the `rls` option is `{ layer }`, a SQL adapter that also provides `SqlClient`. `runSealedColumnTests` adapter layers require `Encryption` (the suite supplies a rotatable key) and take a `plant` effect to write a raw stored value.
- No Postgres or Docker was available: every Postgres-only path (RLS policies, `lift`, `disableRls` via `pg_policies`, the `rls` conformance cases) is typechecked and lint-clean but was never executed.

Phase 2:

- The relay and worker also needed one method the plan did not list: `disableFailing(grant, id, at)`. The worker auto-disables an endpoint after `disableAfterConsecutiveDead` dead deliveries, and the old call (`setDisabled`, now ambient-scoped) would have silently done nothing for a tenant's endpoint with no ambient tenant.
- `listEnabledEndpoints` pushes the `"disabledAt" IS NULL` filter into SQL; `findEndpointForDelivery` is the worker's by-id lookup; `bumpDead` and `clearDead` take the witness too. One module-level witness (`relay`) serves the whole delivery module; erasure and export mint their own.
- The plan's conformance call needs a `plugin.tenancy`; `Webhooks` has none until phase 3, so `WebhookRecords.test.ts` passes the two declarations inline and phase 3 switches it to `Webhooks.Webhooks`. Both tables share one `WebhookRecordsShape`, so each case classifies the other table's methods as `derived` ("operates on the other table").
- Deleted tests are named in `.scratch/plugin-table-substrate/issues/03-*.md`. BEH-EA-309's file is 34-webhooks.md revision 1.5 (not 1.2); traceability revision 1.12.

Phase 3:

- `AuthPlugin.Table.*` are thin wrappers returning `TenantScoped.TableDeclaration` (so roles, qadi and tests need no `@awthaq/sql` import). `Class.tables` is derived from the record's keys with a prefix filter guard (no `as`). `Any.tenancy` is optional; a hand-built `Any` keeps `tables: [..]` and an absent `tenancy` reads as no declarations.
- `Auth.make` skips the plain-identifier check on the table name of a Global table (it never reaches DDL, and fixture plugins use dotted ids such as `acme.invite`); columns, parents and the names of non-Global tables are checked. Derived parents resolve to a table of the same plugin, of a `dependsOn` plugin, or a core table.
- `GraphNode` keeps `tables` as names and adds `tenancy` (name to a short description); the text view prints `table (partitioned "tenantId")`.
- `examples/plugin-template` declares `notes_note` Global ("template example; phase 13 partitions it") until phase 13 adds the column.
- Fixtures were codemodded to `AuthPlugin.Table.global("test fixture")`; the BDD type gates (`table-bare`, `table-foreign-prefix`, `table-prefixed`) were rewritten for the record form, and `Auth.make`'s key list gained `tenancy`.
- The behavior is BEH-EA-328; `01-plugin-contract.md` is revision 1.2, `28-tenancy.md` 1.2, traceability 1.13. The webhooks isolation conformance call now passes the real `Webhooks.Webhooks` plugin.

Phase 4:

- `SealedColumn.orDie`/`option` were typed `Effect<_, unknown, _>` at call sites (a phase 1 typing bug: `catchIf` with an `unknown`-parameter guard lost the error type); they now use a generic `isUnreadable` refinement and return `Exclude<E, Unreadable>`.
- `runSealedColumnTests` takes `raw` and `plant` per adapter (storage differs: a SQL statement, a memory row), so it is called once per adapter. `WebhookRecords.layerMemory` additionally provides `MemoryEnvelopes`, a test seam over its in-memory envelopes, because a memory adapter has no other way to expose what is at rest. It is exported for the suites, not part of the production surface.
- BDD (`34-webhooks.feature`): REQ-EA-1136 and REQ-EA-1137 (a sealed secret copied into, or swapped within, a row does not decrypt) are deleted, since the records no longer expose an envelope to copy; the moved-ciphertext case is `runSealedColumnTests`' and the delivery-level `secret` failure is `WebhookDelivery.test.ts` ("a secret that no longer decrypts"). REQ-EA-1135 and REQ-EA-1264 now assert that the sealed value opens to what was created/registered.
- `enqueue`, `drainDue` and `pruneOnce` in `WebhookDelivery.ts` carry explicit types (the TS2883 exception the plugins document: declaration emit cannot name `StoreUnavailable` through the records' inferred error). `WebhookRecords.layerMemory`/`layerSql` carry explicit `Layer` types for the same reason (`Encryption`).
- `Webhooks` no longer lists `Encryption` among its `ports`.

Phase 5:

- `closeExpired(grant, now)` and `verifyChain(grant)` take the witness as a leading/only parameter (the plan only said "take a CrossTenant"); the memory adapter ignores it, the SQL adapter wraps the statement in `TenantScoped.lift`. `findBySessionId`/`endEpisode`/`list` lift only when a witness is passed.
- SQL queries carry the `Visibility` through the `SqlSchema` request (a `Schema.declare` guard) and build the predicate inside the query; `TenantScoped.predicate` now returns a plain `Statement.Fragment` (each branch annotated) so it composes into `sql.and([...])`.
- `Admin.tenantScopeFor` returns `Option<CrossTenant>`, minted only when `canAdministerTenants` allows; `AdminShape.list` and `sweepExpired` gain `StoreUnavailable`. Crypto `PlatformError` from id minting is `StoreUnavailable` (`ImpersonationRecords.create`).
- The conformance suite classifies `closeExpired`/`verifyChain` as `crossTenant` and runs with `rls: { layer: SqlLayer }`; the Postgres-only `verifyChain` under RLS case is in `ImpersonationRecords.test.ts`. Neither ran (no Postgres). Deleted store-level case: "IDS-002: list, findBySessionId and endEpisode only see the ambient tenant's episodes" (replaced by the suite plus a small witness case). `27-admin-impersonation.md` is revision 1.4, traceability 1.15.

Phase 6:

- The `Organization` service's `OrganizationShape` widens every method with `StoreUnavailable` (the plan said it already did; only some did), and `AdminTenants`, `SamlShape`, `SsoShape`, `SamlConnectionStoreShape`, the SCIM bearer middleware and the SAML metadata/SSO endpoints follow so the tree compiles; phases 7 and 9 do the rest of those plugins' own records.
- `StoreFailure.orStoreUnavailable` also accepts `NoSuchElementError` (a `RETURNING` that returned no row: a defect), and a new `StoreFailure.orConflict(operation, onUnique)` maps a `UniqueViolation` to a domain error; `TenantScoped.liftOn(sql, grant)` is `lift` with the records layer's captured client provided, so a witnessed method stays a plain `Effect<A, E>`.
- `adjustMemberCount` (`TeamRecords`) is a private helper keyed by a team id the same operation just resolved, so it keeps no organization parameter (the table is covered as `derived`); every other row-level statement on a Keyed table filters by its organization key.
- `ConnectionRecord` carries `secretRevision` (the ciphertext, compare-only) beside the `Sealed` secret, because `OrganizationConnections.revisionOf` fingerprints a connection by it; a cache fingerprint cannot be derived from a sealed value that opens lazily. `OrganizationConnections.buildSet` keeps one `orDie` on its records listing: the `@awthaq/oauth` resolver contract (`find`) is infallible, so a store outage while building a set is a defect of that lookup.
- The qadi relationship and attribute resolvers map `StoreUnavailable` to their own typed resolve errors (fail closed); the tenant middleware answers `StoreUnavailable` from its organization lookup with the `503` body.
- `rls: ...` is not passed to the organization conformance calls: `organization_org` ids are minted by `create`, so a keyed RLS insert (row key = tenant id) cannot be built through the records; phase 12 wires the rls cases for the tables where it can.
- Deleted: `organization/test/TenantScoping.test.ts` (27 allowlisted statements, replaced by seven conformance calls) and the at-rest half of `OrganizationConnections.test.ts` "the client secret is ciphertext at rest" (now `runSealedColumnTests`). BEH-EA-284 carries the implementation note; `35-organization.md` is revision 1.1, `28-tenancy.md` 1.3, traceability 1.16.

Phase 7:

- `SamlRecords.update` and `remove` take the connection's `organizationId` (Keyed), as `InvitationRecords.updateStatus` did in phase 6; `findById`, `findByDomain` and `pruneSessions` take a witness. The session and key methods keyed by a connection or session id the caller already resolved are `derived` in the conformance suite. `SamlSlo.protocolGrant` is the one witness for a protocol message naming its connection (shared by `Saml` and `SamlSlo`); `SamlConnectionStore.get` presents its own admin witness (`SamlAdmin` authorizes against the connection's organization).
- `StoreFailure.orStoreUnavailable` is generalised to accept an `E` that also carries domain errors (it catches only `SqlError`, `SchemaError` and `NoSuchElementError`), so the SAML records pipe whole generators through it; `orConflict` is built on it.
- The remaining `Effect.orDie` in the SAML sources are on crypto id minting, cookie expiry and the like (not store errors); `SamlRecords` has none left.
- `SamlRecords.MemoryEnvelopes` is the memory adapter's test seam (as `WebhookRecords.MemoryEnvelopes`). The BDD steps that read the sealed key at rest use it. `SamlSigning.test.ts` "is stored only sealed, under an AAD that names the key" is deleted as moved to `runSealedColumnTests`; the fail-closed and expired-key cases stay (call-site policy). `29-saml-sp.md` is revision 1.6 (the plan wrote 1.3), traceability 1.17.
- `pnpm workspace:sync` added `@awthaq/api` to scim's tsconfig (its `ScimApi.ts` imports it since phase 6; phase 6's commit left the roster check failing).

Phase 8:

- `SigningKeyRecords.create` keeps accepting a `Redacted` JWK (as the plan's webhooks and SAML phases did) and the record hands out `Sealed<Jwk>`; `KeyRing`'s `SigningKey.privateKeyJwk` carries the `Sealed` through and `Jwt.signClaims` opens it with `SealedColumn.orDie`. The three `Effect.orDie` that closed `KeyRing`'s transactions (rotation, `registerRemoteKey`, `importKey`) became `SqlError -> StoreUnavailable` plus a `CurrentKeyConflict` defect (impossible inside the transaction that just rotated, and for a key inserted already rotated).
- `KeyRing.refresh` carries an explicit type (`Effect<void, Api.StoreUnavailable, KeyRing>`), the TS2883 exception the plugins document: it lets declaration emit name `StoreUnavailable` for the rest of the module. `jwks` declares `StoreUnavailable`; the `jwt.token` group inherits it from `Authentication`.
- `jwt/test/support.ts` provides `EncryptionLive` and `SigningKeyRecordsLive` (the in-memory records with a fixed-key `Encryption`); the api-key and next tests import it. `features/step-definitions/shared/TestEncryption.ts` does the same for the BDD worlds (and SamlWorld now uses it). Deleted as moved: the two `KeyRing.test.ts` cases "never stores the private JWK in plaintext" and "a privateKeyJwk ciphertext copied onto another kid's row fails to decrypt". Added: "is re-sealed to the current encryption key the next time it is read". `36-jwt.md` is revision 1.1, traceability 1.18.

Phase 9:

- `StoreFailure.orConflict`'s `onUnique` now receives the `SqlError`, because SCIM names the violated field (`name` or `externalId`) from the constraint (`conflictField`); the other callers ignore the argument.
- The three `Effect.orDie` in `ScimConnections` are crypto (id minting, random bytes, the SHA-256 digest): they became `StoreUnavailable` too, since `hashToken` runs on the bearer path, whose middleware now declares it (phase 6). In `Scim.ts` the cleanup `records.unlink` on an already failing create path logs an outage instead of masking the original failure. `@awthaq/api` is a dependency of `@awthaq/scim` (its `ScimApi` imports it), `@awthaq/test` a dev dependency; `pnpm-lock.yaml` follows.
- `30-scim.md` is revision 1.4, traceability 1.19. `ScimUsers`/`ScimHttp` outage assertions held unchanged.

Phase 10:

- `TwoFactorSecrets.upsertPending` takes the plaintext base32 secret (`Redacted`) and the records seal it, as the other sealed columns; `SecondFactor` no longer touches `Encryption` or an AAD. The BDD scenario REQ-EA-1052 states the AAD with its new `:secret` suffix (the step takes the suffix as a parameter), reads the stored envelope through `TwoFactorStore.MemoryEnvelopes`, and its "moved to bob's row" case uses the canonical AAD of bob's row.
- The credential-reset tap (`Hooks.BeforeCredentialReset`) keeps turning a `StoreUnavailable` into a defect: a hook point's `E` is `HookAbort` only, an outage there cannot be typed, and the tap runs inside the reset's transaction, so the reset rolls back (unchanged behaviour).
- Deleted as moved: `TwoFactorStore.test.ts` "reencrypt swaps the envelope only while the row still holds the one that was read" (the mechanism suite's lost-swap case and `runSealedColumnTests`' legacy-AAD case replace it) and `TwoFactor.test.ts` "the stored secret is an Encryption envelope bound to its user" (replaced by "opens to the base32 secret the user was shown"). ADR-EA-020 is revision 1.3 (the plan wrote 1.1), `31-two-factor.md` 1.7, traceability 1.20.

Phase 11:

- The qadi `SubjectResolver` slot's `resolve` and the `AuthorizedSubject` middleware gained `StoreUnavailable` (a `Roles` that is down used to be a defect of the slot): the plan did not list this, but `Roles.listRoleNames` feeds `SubjectResolver`. `@awthaq/roles` and `@awthaq/qadi` have no `@awthaq/sql` dependency, so they use `Errors.orStoreUnavailable` from `@awthaq/core`.
- The few `Effect.orDie` left in these packages are on `Crypto` (id minting, digests, `hmacSha256`, cookie signing) and on `Users.findById` / `Accounts.link` of a user the ceremony just resolved; none is a store error. `PasskeyCredentials` calls whose row was just read (`flagCounterAnomaly`, `recordUsage`, `delete`) turn a vanished row into a defect on its own tag only.
- The outage cases use `TestSql.injectFailure` (a trigger that raises on `INSERT`), which maps to `StoreUnavailable` on SQLite and Postgres alike, one case per module. `DeviceGrantRecords`/`ApiKeyRecords` had no direct SQL suite, so each gets a small `StoreOutage.test.ts`. ADR-EA-028 is revision 1.4, `05-persistence-stratum.md` 1.4, traceability 1.21.
