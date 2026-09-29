# P18 — Multi-tenancy, residency & enterprise federation

Phase 4 · 16 open issues to fix (5 high, 7 medium, 1 low, 3 info) · 6 closed by validation · ~194h summed per-issue estimate (upper bound) · 4 need a decision first.

Each issue below links to its full dossier (evidence at HEAD `ec065a7`, fix steps, tests, acceptance) in its slice file. Work workstream by workstream, top to bottom; within a workstream do the canonical issue first — its fix closes the listed duplicates.

## `tenancy-residency` — Tenant attribution column, RLS backstop, residency docs

Slices: [05-sql](../slices/05-sql.md) · ~35h · depends on workstreams: `organization TenantResolver/middleware (organization slice)`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [DRS-001](../slices/05-sql.md) | high | architecture | CONFIRMED | XL | — | Implement ticket 18's decision: an opaque, nullable, indexed tenant column on every core table, stamped from an ambient `TenantContext` Context.Reference (default `Option.none()`, zero-cost for single-tenant), with optional Postgres RLS policies underneath. |
| [DRS-005](../slices/05-sql.md) | medium | performance | CONFIRMED ⚖️ decision | S | DRS-001 | After the uniqueness-scope decision: document the users and accounts tables as the global identity directory, and let tenant-scoped routing apply only to sessions/verification/audit (recommended option A). Under option B, prefix the unique indexes with the tenant column instead. |
| [SAM-006](../slices/05-sql.md) | medium | security | PARTIAL | S | DRS-001 | The RLS backstop ships with DRS-001's opt-in RLS migrations. What remains here is documentation of the Supabase hybrid window and the recommended least-privilege database role. |
| [CSG-009](../slices/05-sql.md) | info | architecture | CONFIRMED | S | DRS-001 | Document the data-location model. Point multi-region at the seams that exist or are decided: the injected SqlClient, DRS-001's tenant column, and ADR-EA-005's `LayerMap.Service` for per-tenant/per-region SqlClient routing. Don't add per-table logic. |

Closed by validation in this workstream: SSMS-009 (DUPLICATE → DRS-001)

## `enterprise-federation-saml-scim` — SAML SP + SCIM packages: ADR, contracts, port, validation chain (decision 08)

Slices: [12-spec](../slices/12-spec.md) · ~73h · depends on workstreams: `multi-tenant-composition`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AOMS-009](../slices/12-spec.md) | high | architecture | CONFIRMED | XL | ticket-09 UserRecord deactivation (cross-slice) | Execute decision ticket 08's spec half now (ADR + contracts + resequenced roadmap) and its code half in order: UserRecord deactivation (ticket 09) -> packages/scim -> packages/saml (SP-only), SAML runnable in parallel with SCIM substrate. |
| [CWM-002](../slices/12-spec.md) | high | architecture | CONFIRMED | XL | AOMS-009, ticket-09 UserRecord deactivation (cross-slice) | Per decision 08: after ticket 09's UserRecord deactivation state lands, ship `packages/scim` (inbound RFC 7644) with an external-id mapping table and Sessions.revokeAll on deactivation; publish the interim deprovisioning recipe now. |
| [SFS-003](../slices/12-spec.md) | medium | architecture | CONFIRMED | M | AOMS-009 | Design the `SamlSigner` port in spec before any plugin code, with fused parse+verify semantics, then implement it in packages/saml (port lives in @awthaq/ports per ADR-EA-010). |
| [SFS-006](../slices/12-spec.md) | info | api | CONFIRMED | S | AOMS-009 | Record the dispatch shape implied by decisions 08 and 18 in ADR-EA-019: standalone `Saml` and `OAuth` plugins own their protocol routes; `Sso` is a thin connection-resolver plugin (routes under `sso.*`) that resolves an organization's connection (by email domain or org id) and redirects into the owning plugin. |
| [SFS-007](../slices/12-spec.md) | info | docs | CONFIRMED | M | SFS-003 | Adopt the ordered SAML validation chain as normative behaviors before implementation (cheap checks before crypto), naming canonicalization and signature wrapping explicitly. |

Closed by validation in this workstream: SFS-001 (DUPLICATE → AOMS-009), SFS-008 (DUPLICATE → AOMS-009), SCP-009 (DUPLICATE → CWM-002)

## `multi-tenant-composition` — Tenancy = Organization row, per-request tenant config (decision 18)

Slices: [12-spec](../slices/12-spec.md) · ~44h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [EP-001](../slices/12-spec.md) | high | architecture | CONFIRMED | XL | DRS-001, CWM-001 | Implement decision ticket 18: tenant = Organization row; ambient `TenantContext` in core; nullable indexed `tenant_id` on the five core tables stamped on every write; `TenantResolver` port + opt-in `Organization.tenantMiddleware`; Postgres RLS; per-org OAuth connections via a LayerMap-backed `OrganizationConnections`. Record it as an ADR first. |
| [EP-007](../slices/12-spec.md) | medium | architecture | CONFIRMED | L | EP-001 | Make per-tenant configuration real: plugins read their config Reference per operation (not once at Layer build), and a `TenantConfig` LayerMap.Service keyed by tenant id supplies each tenant's config Layers, provided per request by the tenant middleware — ADR-005/006's own prescription. |

## `multi-tenant-oauth-connections` — Per-organization OAuth connections (decision ticket 18)

Slices: [03-oauth-flow](../slices/03-oauth-flow.md) · ~32h · depends on workstreams: `oauth-outbound-resilience`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [EP-004](../slices/03-oauth-flow.md) | high | architecture | CONFIRMED | XL | — | Implement ticket 18's connection model: an org-owned connection table plus a LayerMap-backed resolver, consulted after the static registry. |

Closed by validation in this workstream: CWM-001 (DUPLICATE → EP-004)

## `org-config-and-tenancy` — Organization configuration defaults and tenancy fields

Slices: [08-authz-org-roles-qadi](../slices/08-authz-org-roles-qadi.md) · ~10h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [DRS-007](../slices/08-authz-org-roles-qadi.md) | medium | compliance | CONFIRMED ⚖️ decision | M | EP-001 | Add a typed, config-validated homeRegion to organizations (pending decision) so the org→shard mapping is data-driven. |
| [EP-005](../slices/08-authz-org-roles-qadi.md) | medium | api | CONFIRMED | S | EP-001 | Make the existing branding fields load-bearing where the plugin itself renders to tenants' users, and route custom-domain → tenant through ticket 18's TenantResolver. |
| [EP-006](../slices/08-authz-org-roles-qadi.md) | medium | security | CONFIRMED ⚖️ decision | M | — | Add per-organization quota overrides and set a finite default organizationLimit (pending the default decision). |
| [EP-010](../slices/08-authz-org-roles-qadi.md) | low | security | CONFIRMED ⚖️ decision | S | — | Flip requireEmailVerificationOnInvitation to true (pending decision) so membership is conferred only on a verified address. |

Closed by validation in this workstream: AR-004 (DUPLICATE → EP-001)

