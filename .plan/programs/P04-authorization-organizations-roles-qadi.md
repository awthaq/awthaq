# P04 — Authorization: organizations, roles, qadi

Phase 1 · 54 open issues to fix (8 high, 32 medium, 11 low, 3 info) · 17 closed by validation · ~198h summed per-issue estimate (upper bound) · 4 need a decision first.

Each issue below links to its full dossier (evidence at HEAD `ec065a7`, fix steps, tests, acceptance) in its slice file. Work workstream by workstream, top to bottom; within a workstream do the canonical issue first — its fix closes the listed duplicates.

## `org-role-escalation-guards` — Organization role-escalation guards

Slices: [08-authz-org-roles-qadi](../slices/08-authz-org-roles-qadi.md) · ~6h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [RRM-001](../slices/08-authz-org-roles-qadi.md) | high | security | CONFIRMED | M | — | Apply PermissionEngine.canGrant to every role-assignment path, reject unknown role names, and forbid modifying a member who out-privileges the caller. |
| [OHS-005](../slices/08-authz-org-roles-qadi.md) | medium | correctness | CONFIRMED | S | RRM-001 | Make owner strictly above admin (better-auth parity: only owner may delete the organization), which also makes RRM-001's canGrant stop admins from minting owners. |
| [RRM-002](../slices/08-authz-org-roles-qadi.md) | medium | security | CONFIRMED | S | RRM-001 | Run the same requireGrantable check (RRM-001) on the invitation's requested role before persisting it. |

Closed by validation in this workstream: RRM-007 (DUPLICATE → OHS-005)

## `qadi-decision-cache-invalidation` — Request-scoped qadi decision cache + opt-in invalidation bridge / qadi DecisionCache invalidation bridge / qadi DecisionCache scope + invalidation (wayfinder ticket 12)

Slices: [08-authz-org-roles-qadi](../slices/08-authz-org-roles-qadi.md), [12-spec](../slices/12-spec.md), [13-repo-features-tooling](../slices/13-repo-features-tooling.md) · ~17h · depends on workstreams: `PCS-001/RZS-002 implementation (cross-slice)`, `org-qadi-relationships`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [PCS-001](../slices/12-spec.md) | high | security | CONFIRMED | M | — | Implement decision ticket 12: move decisionCacheLayer to per-request scope in the canonical wiring (Path A middleware / Path B extractor), and ship an opt-in `DecisionCacheInvalidationLive` in @awthaq/qadi that taps every OrganizationHooks observe point and calls DecisionCache.clear, documented as mandatory for app-scoped caches, with the coverage caveat. |
| [PCS-002](../slices/08-authz-org-roles-qadi.md) | high | architecture | CONFIRMED | M | — | Ship ticket 12's opt-in invalidation bridge (DecisionCacheInvalidationLive) for application-scoped DecisionCache deployments, and close the leave() hook gap it depends on. |
| [AAPS-005](../slices/13-repo-features-tooling.md) | medium | security | PARTIAL | M | PCS-001, RZS-002 | No TTL (ADR-QD-031 / ticket 12). Close the part ticket 12 misses: awthaq-owned user attributes must also invalidate an application-scoped cache — add a user-attribute-change signal and tap it in DecisionCacheInvalidationLive. |
| [PCS-005](../slices/13-repo-features-tooling.md) | medium | testing | CONFIRMED | M | PCS-001, RZS-002 | Write the regression net that wayfinder ticket 12's decision (PCS-001/RZS-002) needs: tests for per-request cache scope and for DecisionCacheInvalidationLive clearing on organization membership/role hooks. |
| [RZS-008](../slices/12-spec.md) | info | architecture | CONFIRMED | S | PCS-001 | Document the consistency contract at the resolver seam alongside the cache fix: relationship answers are as fresh as the records layer; a request-scoped cache preserves that, an app-scoped one needs the invalidation bridge; swapping in a Zanzibar engine = replacing OrganizationQadi.relationships. |

Closed by validation in this workstream: PCS-004 (WONTFIX-CANDIDATE), RZS-002 (DUPLICATE → PCS-001), YL-007 (DUPLICATE → PCS-001)

## `org-write-atomicity-and-uniqueness` — Organization write atomicity and membership uniqueness

Slices: [08-authz-org-roles-qadi](../slices/08-authz-org-roles-qadi.md) · ~13h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [OHS-002](../slices/08-authz-org-roles-qadi.md) | high | correctness | CONFIRMED | M | — | Make the organization-delete and team-delete cascades (and each multi-statement TeamRecords SQL op) commit or roll back as one unit via the existing SqlTransaction port. |
| [OHS-003](../slices/08-authz-org-roles-qadi.md) | high | correctness | CONFIRMED | M | OHS-002 | Back the one-membership-per-(team,user) invariant with a UNIQUE index plus typed already-member errors on both team-add paths, so memberCount can no longer over-count. |
| [MTI-003](../slices/08-authz-org-roles-qadi.md) | medium | correctness | CONFIRMED | M | — | Add UNIQUE(userId, organizationId) to organization_membership, a typed already-member error at the records layer, and an early duplicate check in addMember. |
| [OHS-006](../slices/08-authz-org-roles-qadi.md) | medium | correctness | CONFIRMED | S | MTI-003 | Refuse to invite or admit someone who is already a member, so an invitation can never overwrite or duplicate a membership. |

Closed by validation in this workstream: MTI-004 (ALREADY-FIXED)

## `org-qadi-relationships` — Organization ↔ qadi relationship resolver

Slices: [08-authz-org-roles-qadi](../slices/08-authz-org-roles-qadi.md) · ~12h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [RZS-001](../slices/08-authz-org-roles-qadi.md) | high | correctness | CONFIRMED | M | — | Implement the ticket-13 decision: a required, app-provided ResourceOrganizationLookup port consulted for member at depth >= 1; unresolved fails closed with RelationshipResolveError. |
| [PERS-005](../slices/08-authz-org-roles-qadi.md) | medium | architecture | PARTIAL | S | RZS-006 | Keep the self-contained engine (design decision) but make its decisions auditable: publish a denial event into the durable AuditLog, and let qadi evaluate the same statements via RZS-006's permission relations. |
| [RRC-003](../slices/08-authz-org-roles-qadi.md) | medium | security | CONFIRMED | S | RRC-001 | When ticket 28's ReadRouting lands (RRC-001), classify every authorization-decision read as primary-pinned and state the revocation-latency bound in the spec. |
| [RZS-004](../slices/08-authz-org-roles-qadi.md) | medium | performance | CONFIRMED | S | RZS-006 | Answer member and role:* relations from the membership row alone; only permission relations compute statements. |
| [RZS-005](../slices/08-authz-org-roles-qadi.md) | medium | architecture | CONFIRMED | S | — | Fail closed and legibly on malformed relation questions, and stop dynamic/custom role names from shadowing built-ins. |
| [RZS-006](../slices/08-authz-org-roles-qadi.md) | medium | correctness | CONFIRMED | M | RZS-005 | Derive every org relation qadi sees from the same functions the plugin's own gating uses, so a qadi policy and requirePermission can never disagree. |

Closed by validation in this workstream: OHS-009 (DUPLICATE → RZS-001)

## `org-active-context-lifecycle` — Active organization/team context lifecycle

Slices: [08-authz-org-roles-qadi](../slices/08-authz-org-roles-qadi.md) · ~9h · depends on workstreams: `org-write-atomicity-and-uniqueness`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [CWM-003](../slices/08-authz-org-roles-qadi.md) | medium | correctness | CONFIRMED | M | DRS-008, OHS-002 | Clear active-context pointers (and team memberships) whenever the membership/team/org they point at goes away, and re-validate on read. |
| [MTI-001](../slices/08-authz-org-roles-qadi.md) | medium | architecture | CONFIRMED | M | DRS-008 | Make an unvalidated active-context write unrepresentable at the type level, and pin tenant-predicate discipline in SQL with an architecture test (RLS for plugin tables follows ticket 18). |
| [DRS-008](../slices/08-authz-org-roles-qadi.md) | low | architecture | CONFIRMED | S | — | Keep sessionId as the key (active org is per-session by design) but add an indexed userId column so the row can be cleared on user erasure and membership removal, and document its shard placement. |

Closed by validation in this workstream: OHS-007 (DUPLICATE → CWM-003)

## `authz-docs-truthfulness` — Authorization docs truthfulness

Slices: [08-authz-org-roles-qadi](../slices/08-authz-org-roles-qadi.md) · ~24h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [DTWS-002](../slices/08-authz-org-roles-qadi.md) | high | docs | CONFIRMED | M | — | Rewrite the 16 stale banners to shipped-vs-planned status (packages/next/README.md as template), keep the banner only on the 4 placeholder packages, and add a CI drift check. |
| [SAM-005](../slices/08-authz-org-roles-qadi.md) | medium | docs | CONFIRMED | M | RZS-006 | Write the RLS→qadi migration guide as a spec appendix. |
| [SAM-007](../slices/08-authz-org-roles-qadi.md) | medium | architecture | CONFIRMED | S | DTWS-002 | Document that JWT claims authenticate but do not authorize, and where claim-driven policy logic must be re-homed. |
| [JH-009](../slices/08-authz-org-roles-qadi.md) | low | docs | CONFIRMED | L | — | Ship docs/plugin-authoring.md plus a minimal, test-exercised template plugin so conventions have one canonical, CI-checked home. |
| [OHS-010](../slices/08-authz-org-roles-qadi.md) | low | docs | CONFIRMED | S | DTWS-002 | Rewrite the organization README (capability set, config flags, relation vocabulary, HTTP surface) and update the model doc's status paragraph. |
| [RRM-009](../slices/08-authz-org-roles-qadi.md) | low | docs | CONFIRMED | S | DTWS-002 | Refresh the roles/qadi spec banner and quality metrics (README handled by DTWS-002). |
| [RRM-012](../slices/08-authz-org-roles-qadi.md) | info | architecture | CONFIRMED | S | — | Align BEH-EA-138/REQ-EA-385-387 with the real enforcement point and pin it with a roles-specific test. |

Closed by validation in this workstream: PERS-009 (DUPLICATE → DTWS-002)

## `org-team-hierarchy` — Team hierarchy and team-scoped roles

Slices: [08-authz-org-roles-qadi](../slices/08-authz-org-roles-qadi.md) · ~44h · depends on workstreams: `org-write-atomicity-and-uniqueness`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [OHS-001](../slices/08-authz-org-roles-qadi.md) | high | architecture | CONFIRMED | XL | OHS-002, OHS-003 | Implement ticket 34: parentId write model + closure-table read model, cycle guard, move/ancestor/descendant/subtree operations, exposed through Organization and its HTTP contract. |
| [OHS-004](../slices/08-authz-org-roles-qadi.md) | medium | architecture | CONFIRMED ⚖️ decision | L | OHS-001 | Add team-scoped roles with explicit precedence (pending decision; ticket 34 deferred inheritance here). |

Closed by validation in this workstream: RZS-003 (DUPLICATE → OHS-001)

## `org-tenant-read-isolation` — Organization tenant read isolation (404 policy)

Slices: [08-authz-org-roles-qadi](../slices/08-authz-org-roles-qadi.md) · ~17h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [MTI-008](../slices/08-authz-org-roles-qadi.md) | medium | security | CONFIRMED | S | MTI-009 | Require membership for GET /organization/:organizationId, answering 404 to non-members. |
| [MTI-009](../slices/08-authz-org-roles-qadi.md) | medium | security | CONFIRMED | M | — | Answer 404 OrganizationNotFound whenever the caller is not a member (BEH-EA-147); keep 403 only for members who lack a statement. |
| [MTI-010](../slices/08-authz-org-roles-qadi.md) | medium | security | CONFIRMED | L | MTI-009 | Bind getInvitation to the invitee (or an org member with invitation rights) and split the emailed capability token from the REST id. |

## `qadi-bridge-hardening` — qadi bridge hardening

Slices: [08-authz-org-roles-qadi](../slices/08-authz-org-roles-qadi.md) · ~28h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AAPS-004](../slices/08-authz-org-roles-qadi.md) | medium | performance | CONFIRMED | M | — | Memoize the user record per request (not across requests), so N attribute reads cost one lookup without introducing cross-request staleness. |
| [EEM-005](../slices/08-authz-org-roles-qadi.md) | medium | api | CONFIRMED | M | — | Give the reauth obligation a shared, wire-decodable error in @awthaq/api and use it from qadi's handler (Path A); document Path B's qadi-owned mapping. |
| [TS-001-torin-sandall](../slices/08-authz-org-roles-qadi.md) | medium | correctness | CONFIRMED | S | — | Fail closed on an uninterpretable reauth obligation, like the unknown-id branch already does. |
| [TS-002](../slices/08-authz-org-roles-qadi.md) | medium | architecture | PARTIAL | S | — | Make UserAttributes itself map store failures to AttributeResolveError (mirroring OrganizationQadi.attributes) and wire REQ-EA-452/453. |
| [TS-003-torin-sandall](../slices/08-authz-org-roles-qadi.md) | medium | architecture | CONFIRMED | M | — | Ship an opt-in DecisionSink implementation that logs denials (and optionally records them in AuditLog), and refresh the stale header. |
| [YL-004](../slices/08-authz-org-roles-qadi.md) | medium | security | CONFIRMED | L | — | Dogfood enforcement on the shipped surface and make an un-annotated endpoint detectable at startup. |
| [AAPS-008](../slices/08-authz-org-roles-qadi.md) | low | dx | CONFIRMED | S | — | Let the subject endpoint resolve a configured set of resolver-backed attributes into the DTO, and document the split. |
| [YL-008](../slices/08-authz-org-roles-qadi.md) | low | dx | PARTIAL | S | — | Ship a helper that applies the pair in the proven order and pin the type-level behaviour with a test. |

## `qadi-upstream` — Upstream fixes in ../qadi

Slices: [08-authz-org-roles-qadi](../slices/08-authz-org-roles-qadi.md) · ~6h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [PERS-002](../slices/08-authz-org-roles-qadi.md) | medium | architecture | CONFIRMED | M | — | In ../qadi: pass the evaluation's action and an opaque caller context to custom predicates. |
| [PERS-006](../slices/08-authz-org-roles-qadi.md) | low | correctness | CONFIRMED | S | PERS-002 | In ../qadi: state the read-only/idempotent contract and give predicates a replay signal. |
| [PERS-007](../slices/08-authz-org-roles-qadi.md) | low | dx | CONFIRMED | S | — | In ../qadi: a composition-time validator for HasCustom names against the registry. |

## `roles-catalog-validation` — Roles catalog validation

Slices: [08-authz-org-roles-qadi](../slices/08-authz-org-roles-qadi.md) · ~3h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [RRM-003](../slices/08-authz-org-roles-qadi.md) | medium | correctness | CONFIRMED | S | RRM-004 | Validate assignments against the catalog at assign time and make resolve-time drift observable. |
| [RRM-004](../slices/08-authz-org-roles-qadi.md) | low | correctness | CONFIRMED | S | — | Fail Roles layer construction on duplicate catalog names by validating through qadi's own resolveRoleGraph. |
| [RRM-010](../slices/08-authz-org-roles-qadi.md) | low | dx | CONFIRMED | S | — | Keep the fail-closed default but make the misconfiguration loud. |

Closed by validation in this workstream: YL-005 (DUPLICATE → RRM-003), TS-008 (DUPLICATE → RRM-003)

## `roles-audit-and-admin` — Roles audit events and administration surface

Slices: [08-authz-org-roles-qadi](../slices/08-authz-org-roles-qadi.md) · ~8h · depends on workstreams: `roles-catalog-validation`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [RRM-005](../slices/08-authz-org-roles-qadi.md) | medium | compliance | CONFIRMED | M | — | Publish auth.roles.assigned/revoked (durably audited) on real state changes, recording the actor. |
| [YL-009](../slices/08-authz-org-roles-qadi.md) | info | dx | CONFIRMED ⚖️ decision | M | RRM-005, RRM-003 | Ship an opt-in RolesAdmin plugin (pending decision) whose endpoints are guarded by qadi Path B, dogfooding enforcement. |

Closed by validation in this workstream: PCS-003 (DUPLICATE → RRM-005)

## `authz-model-boundaries` — Global roles vs organization authority (decision)

Slices: [08-authz-org-roles-qadi](../slices/08-authz-org-roles-qadi.md) · ~1h · depends on workstreams: `org-qadi-relationships`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [MTI-007](../slices/08-authz-org-roles-qadi.md) | medium | architecture | CONFIRMED ⚖️ decision | S | RZS-006 | Decide and codify the authority split between global Roles and per-organization roles (see Decisions); the recommended option is a documented, test-pinned contract plus naming guidance, not a third mechanism. |

Closed by validation in this workstream: RRM-006 (DUPLICATE → MTI-007), YL-002 (DUPLICATE → MTI-007)

## `org-sql-count-queries` — Organization SQL count queries

Slices: [08-authz-org-roles-qadi](../slices/08-authz-org-roles-qadi.md) · ~1h · depends on workstreams: `org-write-atomicity-and-uniqueness`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [MTI-005](../slices/08-authz-org-roles-qadi.md) | medium | performance | PARTIAL | S | — | Replace every row-materializing count in the SQL layers with COUNT(*) queries (the index half of this finding already shipped). |

Closed by validation in this workstream: OHS-008 (DUPLICATE → MTI-005), PPS-005 (ALREADY-FIXED)

## `qadi-attribute-typing` — Typed attribute names for qadi policies

Slices: [06-server-api](../slices/06-server-api.md) · ~4h · depends on workstreams: `attributeresolver-registry (AAPS-002, slice 08)`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AAPS-003](../slices/06-server-api.md) | medium | api | PARTIAL | M | AAPS-002 | Add typing on the producer and evaluator side (in @awthaq/qadi and ../qadi). The isomorphic SubjectDto stays an open record, because its attribute set depends on the composition. |

## `user-claims-store` — Per-user custom claims store (decision)

Slices: [08-authz-org-roles-qadi](../slices/08-authz-org-roles-qadi.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [FAMS-004](../slices/08-authz-org-roles-qadi.md) | medium | architecture | PARTIAL ⚖️ decision | M | — | Add an opt-in per-user claims store exposed to qadi as a namespaced attribute (pending decision), and document the Firebase import mapping. |

## `roles-permission-modeling` — Document exact-key permission modeling and definition-time bundling

Slices: [13-repo-features-tooling](../slices/13-repo-features-tooling.md) · ~1h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [YL-006](../slices/13-repo-features-tooling.md) | low | api | CONFIRMED | S | — | Keep qadi's exact O(1) membership (deliberate engine design; no matcher change in ../qadi). Document the modeling boundary in @awthaq/roles and show definition-time expansion via qadi's `createPermissionGroup`, plus attribute policies for the 'wildcard instinct'. |

Closed by validation in this workstream: RRM-008 (DUPLICATE → YL-006)

