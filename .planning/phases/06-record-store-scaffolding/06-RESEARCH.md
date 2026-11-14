# Phase 6: Record-store scaffolding (gated) - Research

**Researched:** 2026-11-14
**HEAD at research:** `5e1de98051391339689f88151b0bac73cace9e97` (branch `architecture/deepening-batch-3`; only `.planning/` and untracked `.claude/` differ from the Phase 5 close)
**Domain:** plugin record stores (`*Records` modules): a measured go/no-go on shared scaffolding, plus the closure of plan 24 Track A
**Confidence:** HIGH on the census and the Track A record (every count below was produced by a command or a file read this session); MEDIUM on the line-saving estimates (no prototype was built; the executed spike is the committed decision)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Track A is closed by an approved requirement (REC-01).** The user approved REQUIREMENTS.md, which (a) lists "Replacing memory twins with SQLite `:memory:`" under Out of Scope (SQLite cannot reproduce Postgres races; plan 25 and ADR-EA-041 decision 9 keep two adapters) and (b) states REC-01 as "Plan 24 Track A is recorded closed (ADR-EA-041 revision note)". The research summary's "if Track A stays alive, drop C7 from this milestone" branch was therefore already taken by the user when all 8 candidates were put in scope. This phase records that closure; it does not reopen the question. The record is a docs-only revision (reversible) and is called out in the final report so the user can veto it.

### Claude's Discretion

All other choices are at Claude's discretion under the standing rule: the cleanest end state, complexity accepted. Constraints already decided:
- Hard dependencies are met: Phase 3 (`Keyset` comparators feed the memory half) and Phase 4 (connection records were rewritten first) are complete.
- ADR-EA-046 is reserved for plan 24 and absent from `spec/decisions/` (highest file is 057; `index.yaml` carries the registry). Decide use or release from the evidence (plan 24's Track B was subsumed by plan 25; ADR-EA-041 decision 9 already rejects the differential parity harness as the bar) and record it: the planner/researcher recommends, the plan executes it. No ADR number is left reserved and unexplained.
- The go/no-go is measured, not asserted: the spike counts, per candidate helper (comparators, tenant-visibility plumbing, `unavailable(op)` labelling, dialect wire row helper, `SqlStore.make` adoption), how many `*Records` files carry a near-identical copy; the threshold is "about 5 files". The spike result is a committed artifact (`06-SPIKE.md`) before any scaffolding code.
- A go adds no `*Shape` change, no change to any `RecordsContract` verdict, every `layerMemory` stays one `Ref<State>`, lock-key strings and operation labels stay byte-identical (pinned before the refactor, as in Phases 1-5). `SqlModel.makeRepository` stays out of scope (unstable, lacks tenancy, sealed columns, leases and the memory twin).
- Postgres is available locally (Debian `postgres:16` container `awthaq-p3-pg` at `postgres://postgres:pw@localhost:55433/awthaq`; pass `AWTHAQ_POSTGRES_URL` explicitly; use `--shm-size=1g` if the container is recreated; never `scripts/test-pg.sh`, which uses an alpine image on another port). The roadmap's "recorded as not run locally" wording is superseded: the Postgres legs run locally on the CI image and are recorded as "run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)".
- Wave 0 before any `src` change: `06-BASELINE.md` (every gate at HEAD, as Phases 1-5) and pins of today's behaviour for every file the spike names (operation labels, lock keys, verdicts, ordering/comparator results, tenant visibility).
- Public-surface changes ship one changeset with a `Migration:` line; spec Revision and Change History bump together; `pnpm knip`, `pnpm check:readmes`, `pnpm spec:verify:strict`, `pnpm circular`, `pnpm check:contract-tests`, `pnpm check:error-tags`, `pnpm check:transactions` stay at baseline.
- Strata: `api < ports < sql < core < server < qadi < plugins < cli/test/features`; any helper lives at the lowest stratum that every consumer can import (the plugins already depend on `@awthaq/sql` and `@awthaq/test`); no new package dependency edge.
- Executors do not run `requirements.mark-complete`.

Decided autonomously (CONTEXT): the gate owner is the approved REC-01 requirement; the spike is a separate plan with its own artifact (baseline and the ADR records first, then the spike plan writes `06-SPIKE.md` with measured counts and the go/no-go; any go-branch plans are created after the spike result, not before); the Postgres wording is "run locally on the Debian image, CI confirmation open".

Specific idea (CONTEXT): the spike must also say, per helper, where it would live (module, stratum) and whether it removes code or only moves it, so the go/no-go is not decided by a raw file count alone.

### Deferred Ideas (OUT OF SCOPE)

None.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REC-01 | Plan 24 Track A is recorded closed (ADR-EA-041 revision note) and ADR-EA-046's fate is decided before any scaffolding work starts | Q3: the exact reservation text, what ADR-EA-041 and plan 25 already decided, the release recommendation, and the exact edits (revision 1.6 to 1.7) |
| REC-02 | A spike on `DeviceClientRecords`, `ApiKeyClientRecords`, `ApiKeyRecords` and `DeviceGrantRecords` yields a go/no-go; no-go if fewer than ~5 files share a helper | Q1: the pre-measured census (16 files, 5 pieces, counts and verdict per helper); Q7: the decision rule and the spike plan |
| REC-03 | On go, shared comparators, tenant-visibility plumbing, `unavailable(op)` labelling, a dialect wire row helper and `SqlStore.make` adoption replace the repeated scaffolding, with no `*Shape` change | Q2: per-helper design, placement, lines removed vs added, and which constraints each preserves. Preliminary verdict: not pursued |
| REC-04 | Every `layerMemory` stays one `Ref<State>`; lock-key strings and operation labels stay byte-identical; `docs/plugin-authoring.md` and `examples/plugin-template/` update last | Q4 (pins), Q5 (docs and template). Note the literal "one Ref" is already false for `ImpersonationRecords` (Pitfall 2) |
| GATE-04 | SQL-touching phases verified on Postgres | Validation Architecture: Postgres leg run this session on the four spike suites |
</phase_requirements>

## Project Constraints (from CLAUDE.md / AGENTS.md)

No `CLAUDE.md` exists in the worktree; `/Users/mohammadalmechkor/Projects/Perso/awthaq-arch/AGENTS.md` is the project instruction file. Directives that bind this phase:

- Domain docs are `spec/overview.md`, `spec/decisions/`, `spec/behaviors/`, `spec/traceability.md`; plugin conventions are in `docs/plugin-authoring.md`; the working template is `examples/plugin-template/` (AGENTS.md "Plugin authoring", "Domain docs").
- Library source forbids type assertions: `.oxlintrc.json` carries `"typescript/consistent-type-assertions": ["error", { "assertionStyle": "never" }]` ("`as const` stays allowed", `.oxlintrc.json:33-37`). Any helper must compile with no `as`.
- Strata and `pnpm circular` (type-only imports count) bind helper placement.
- `.planning/README.md` shared conventions: no return-type annotations on new Effect/Layer consts; changeset with a migration note for every package-visible change; replace-don't-layer tests.

## Summary

The census was run on all 16 `*Records` modules (10,664 lines, 154 operation-label call sites) and, for context, the 8 other plugin store modules plus the template. The five pieces the candidate names do not carry equal weight, and four of them fail either the "about 5 files" count or the deletion test:

- **Tenant-visibility plumbing** appears in 2 of 16 files (`ImpersonationRecords`, `WebhookRecords`; 3 with the template) because only 3 tables in the whole repo are `Partitioned`; the four spike files are all `Global` tables and carry none of it. It is already a shared substrate (`TenantScoped.visibility/matches/predicate/stamp`). **No-go on count (2 < 5).**
- **`unavailable(op)`** is the same two-line closure in 16 of 16 files (22 of 24 plugin store modules), differing only in the store name. **Passes the count, fails the deletion test:** it turns 2 lines into 1 per file and leaves all 154 call sites untouched. It moves lines; it concentrates no decision (the decision, `StoreFailure.orStoreUnavailable`, is already shared).
- **Dialect wire row helper:** `SqlModels.dialectFields(yield* SqlModels.resolveDialect(sql))` is one verbatim line in 14 files (2 variants), already backed by shared `dialectFields`. The row-to-record mapping (`makeRow` in 4 files, `toRecord` and the insert-argument object in every file) is domain-specific: **0 near-identical copies.** **Fails the deletion test** (one line replaced by one line).
- **`SqlStore.make` adoption:** **0 of 16 files use `SqlStore.make`** (the earlier research's "5 of 16 have started the shape" counted `SqlStore.atomically`, which is a different primitive). Adopting it is a migration with a behaviour change (`write` adds a transient retry) and a per-operation `write`/`read`/`once` classification (154 decisions). In the four spike files only 6 of 29 operations are idempotent enough to take the retry. It is not a refactor of copies and cannot satisfy "no behaviour change" as scaffolding.
- **Comparators** are the one real candidate: 11 of 16 files hand-roll a `(createdAt, id)` order, in four spellings, against 2 files already on Phase 3 `Keyset`. Passes the count; the deletion test is marginal: an estimated 30 to 55 lines removed on a 10,664-line base (at most 0.5%), and 7 of the 11 sites would change behaviour for ids that are not canonical lowercase UUIDv7 (5 use `localeCompare`, 2 have no id tie-break). It also surfaces one real latent drift (`DeviceGrantRecords.listByUser`: memory has no id tie-break, SQL orders `createdAt ASC, id ASC`).

Taken together, all five helpers would remove roughly 60 to 75 net lines of 10,664 (about 0.6%). The bulk of the files (row-to-record mapping, memory CRUD bodies, domain invariants) is outside the five pieces.

**Preliminary verdict: NO-GO for REC-03 as specified (the five-piece bundle); comparators is the single helper that clears the count and is recorded as the closest to go, with what would flip it.** The executed spike (`06-SPIKE.md`) is the committed decision; this research only lets the planner shape plans around the likely outcome.

**Track A / ADR-EA-046 recommendation: release ADR-EA-046 and record Track A's closure as ADR-EA-041 revision 1.7** (a revision note under Consequences plus alternative (e)). Do not write a stand-alone ADR-EA-046: the spike behind it (plan 24 gates G1-G5) was never run, strict verify already accepts ADR number gaps, and a new ADR would add an index row and a traceability row for no new information.

**Primary recommendation:** plan four docs-and-measurement plans now (baseline; REC-01 record; four-file pins; spike writing `06-SPIKE.md`), write the phase-close plan after the spike, and do not write any go-branch plan until the executed spike says go.

## Architectural Responsibility Map

This phase has no browser, SSR or CDN tier; the tiers that matter are the repo's strata (`api < ports < sql < core < server < qadi < plugins < cli/test/features`).

| Capability | Primary tier | Secondary tier | Rationale |
|------------|-------------|----------------|-----------|
| Memory-side ordering of an unpaged listing (comparators) | `@awthaq/ports` (stratum 2, beside `Keyset`) | plugins (adopters) | Pure, no SQL; Phase 3 already placed `Keyset.key`/`window` there; every plugin depends on `@awthaq/ports` |
| Operation labelling (`unavailable(op)`) and transient classification | `@awthaq/sql` (`StoreFailure`, `SqlStore`) | plugins | `orStoreUnavailable` and `SqlStore.make` already live there |
| Dialect wire codecs | `@awthaq/sql` (`Models.dialectFields`) | plugins | Exists; core stores share it |
| Tenant visibility, stamp, predicate, lift | `@awthaq/sql` (`TenantScoped`) | plugins | Exists; the helper the candidate asks for is already there |
| Verdicts and race cases (the bar) | `@awthaq/test` (`RecordsContract`, dev-only) | each plugin's `test/contract/*` | `check:contract-tests` keeps `@awthaq/test` out of runtime dependencies, so no runtime helper may live there |
| Per-store domain bodies, invariants, `*Shape` | each plugin `*Records.ts` | - | ADR-EA-041 decision 9: "The scaffold cannot generate operations; bodies and verdicts stay per store" (ARCHITECTURE.md candidate 7) |

## Standard Stack

No new package and no version bump (REQUIREMENTS Out of Scope: "New dependencies or version bumps"). The relevant substrate, all already installed:

### Core
| Library | Version | Purpose | Why standard |
|---------|---------|---------|--------------|
| `effect` | 4.1.2 | `Order`, `DateTime`, `Ref`, `HashMap`, `Schema` | [VERIFIED: `packages/sql/node_modules/effect/package.json` prints `4.1.2`] |
| `@awthaq/ports` `Keyset` | in tree | `key`, `window`, `paginate`, `Order`-based comparator | Phase 3 module (`packages/ports/src/Keyset.ts`) |
| `@awthaq/sql` `SqlStore`, `StoreFailure`, `TenantScoped`, `Models` | in tree | the shared adapter substrate | `packages/sql/src/*.ts` |
| `@awthaq/test` `RecordsContract` | in tree | verdict bar, run on memory and SQL | `packages/test/src/RecordsContract.ts` |

### Alternatives Considered
| Instead of | Could use | Tradeoff |
|------------|-----------|----------|
| A shared wire-row helper | `Schema.OptionFromNullOr` in each store's row schema | [VERIFIED: `packages/sql/node_modules/effect/dist/Schema.d.ts:10996` `export interface OptionFromNullOr<S extends Constraint> extends decodeTo<Option<toType<S>>, NullOr<S>>`] would delete the `Option.getOrNull`/`Option.fromNullishOr` pairs per column (about 86 `fromNullishOr` and 36 `getOrNull` sites in the 16 files), but it rewrites each store's row schema and `wire.nullableDateTime` consumers. An idiom per store, not a module; out of REC-03's five pieces and not recommended here |

**Installation:** none. **Version verification:** `effect` 4.1.2 read from the installed package (above). No registry query was needed because nothing is installed.

## Package Legitimacy Audit

None: this phase installs no external package (REQUIREMENTS Out of Scope). No `gsd-tools query package-legitimacy check` run was needed.

**Packages removed due to [SLOP] verdict:** none. **Packages flagged [SUS]:** none.

## Architecture Patterns

### System Architecture Diagram

```
  host picks bundle once (AuthHost persistence / TestAuth records mode)
        |
        v
  Plugin.records = { memory: layerMemory, sql: layerSql }      (BEH-EA-334, per *Records.ts)
        |                                |
        v                                v
  layerMemory                       layerSql
  Ref<State> (one per store*)       SqlClient (ambient)
   |  domain body per op             |  resolveDialect -> dialectFields -> makeRow(wire)
   |  [comparator: sort/page]  <--> |  SQL statements (ORDER BY, WHERE, tenant predicate)
   |  [Ref.modify = atomic]         |  each op: .pipe(unavailable("op")) = orStoreUnavailable("Store.op")
   |                                |  atomic ops: SqlStore.atomically(sql, key)  (9 modules)
   v                                v
  failure: StoreUnavailable{operation}  <-- same typed outage, wire-visible 503, on both halves
        ^
        |  RecordsContract.suite(store, { operations: verdict per op, sql?, tenancy? })
        +--- runs every case on memory, SQLite, and Postgres (AWTHAQ_POSTGRES_URL)

  The five candidate pieces sit at: [comparator] (11 files), [unavailable] (16), [wire line] (16),
  [tenant filter/predicate] (2), [SqlStore.make] (0). Everything else in the diagram is domain-specific.
```

(*) `ImpersonationRecords.layerMemory` makes two `Ref`s (`state`, `ledger`) and a `Semaphore`: see Pitfall 2.

### Recommended Project Structure (only on a go; not recommended)

```
packages/ports/src/Keyset.ts        # + one additive ordering helper (no new module, no surface:ports change)
packages/sql/src/StoreFailure.ts    # + labelled(store) (only if "unavailable" were taken)
packages/*/test/contract/*.ts       # unchanged: the verdict bar
packages/<one package>/test/RecordsScaffoldPins.test.ts   # Wave 0 source-scan pins (label set, lock keys, Ref count)
```

### Pattern 1: Declare an order once, derive both halves (the only helper with leverage)
**What:** Phase 3 `Keyset.Declaration` declares keys once; the memory twin sorts with the derived `Order`, the SQL side takes `ORDER BY` from `KeysetSql.make(declaration).orderBy(sql)`. Unpaged plugin listings could reuse the same keys.
**When to use:** a listing whose memory order must equal its SQL `ORDER BY`.
**Example:**
```typescript
// Source: packages/organization/src/OrganizationRecords.ts:55-70 (Phase 3, verified by reading)
const pageOrder: Keyset.Declaration<OrganizationRecord, OrganizationCursor> = {
  keys: [
    Keyset.key({ column: "createdAt", direction: "asc", order: DateTime.Order,
      row: (organization) => organization.createdAt, cursor: (cursor) => cursor.createdAt }),
    Keyset.key({ column: "id", direction: "asc", order: Order.String,
      row: (organization) => organization.id, cursor: (cursor) => cursor.id }),
  ],
  cursorOf: (organization) => ({ createdAt: organization.createdAt, id: organization.id }),
};
```
`Declaration.cursorOf` is mandatory and `Keyset.key` requires a `cursor` accessor, so an unpaged listing cannot use it as is; that is the one API gap a comparator helper would close (see Q2).

### Anti-Patterns to Avoid
- **A generic CRUD base class or "memory table" wrapper over `Ref<HashMap>`:** ADR-EA-041 decision 9 requires one read-modify-write primitive per operation; a wrapper offering `get` then `set` breaks the memory twin's role as the executable statement of atomicity, and one that offers only `modify` re-exports `Ref.modify` (a shallow module: interface as large as implementation). Only 4 of 16 files even use the plain `Ref.make(HashMap.empty<K, V>())` state.
- **Adopting `SqlStore.make.write` mechanically:** it retries a whole unit on a retryable `SqlError`; an `INSERT ... ON CONFLICT DO NOTHING RETURNING` or a `DELETE ... RETURNING` retried after a lost acknowledgement answers the wrong thing (Pitfall 4).

## Don't Hand-Roll

| Problem | Don't build | Use instead | Why |
|---------|-------------|-------------|-----|
| Tenant visibility, stamp, predicate, cross-tenant lift | a per-store "visibility plumbing" helper | `TenantScoped.visibility/matches/predicate/stamp/lift/liftOn` (`packages/sql/src/TenantScoped.ts`) | Already the one tenant interface for plugin records (ADR-EA-018 decision 10) |
| Outage classification | a second label wrapper | `StoreFailure.orStoreUnavailable(label)` / `SqlStore.make(sql)` | `SqlStore.make` is the ADR-EA-041 decision 5 shape; a third spelling adds drift |
| Dialect codecs | a per-store dialect switch | `SqlModels.dialectFields(dialect)` | Shared with core stores |
| Keyset paging | a plugin-local comparator for a paged listing | `Keyset.paginate/window` | Phase 3; `OrganizationRecords` and `ImpersonationRecords` already use it |
| Atomic read-modify-write | a scaffold composing `get` then `set` | `Ref.modify` (memory), a conditional statement or `SqlStore.atomically(sql, key)` (SQL) | ADR-EA-041 decision 9 |

**Key insight:** the five pieces are mostly already shared (`TenantScoped`, `dialectFields`, `orStoreUnavailable`, `SqlStore`, `Keyset`). What is copied is the glue that names them, one line or two per file, which a helper cannot delete without hiding the per-store string it needs.

## Q1: The census (the spike's evidence)

Reproduce with the commands under "Census commands" below; `HEAD 5e1de980`. File population: the 16 `*Records.ts` named in CONTEXT, 10,664 lines in total (`cat <16 files> | wc -l`). Extended population (context only, not in the 16): `DomainClaims`, `RevocationStore`, `ChallengeStore`, `PasskeyCredentials`, `PasskeyUserHandles`, `UserClaims`, `TwoFactorStore`, `RoleAssignments`, and `examples/plugin-template/src/Template.ts`.

### Per-file table (16 files)

Columns: (a) a hand-written `createdAt`-led comparator (file:lines); (b) tenant-visibility plumbing in the memory half (`TenantScoped.matches`/`visibility`) ; (c) the label closure definition (line); (d) the `wire` line (line); (e) `SqlStore.make` (all 0) and, for context, `SqlStore.atomically`; lines; label call sites.

| File | Lines | (a) comparator | (b) tenant filter | (c) closure def | (d) wire line | (e) make / atomically | Labels |
|------|------:|----------------|-------------------|-----------------|---------------|-----------------------|-------:|
| `device-authorization/DeviceClientRecords` | 171 | `:55-60` asc, id by `<` | no (Global) | `:103` | `:105` | 0 / 0 | 4 |
| `api-key/ApiKeyClientRecords` | 272 | `:75-80` desc, `clientId` by `<` | no (Global) | `:164` | `:166` | 0 / 0 | 6 |
| `api-key/ApiKeyRecords` | 332 | `:98-102` desc, id by `<` | no (Global) | `:206` | `:209` | 0 / 0 | 7 |
| `device-authorization/DeviceGrantRecords` | 428 | `:215` asc, **no tie-break** | no (Global) | `:251` | `:253` | 0 / 0 | 12 |
| `jwt/SigningKeyRecords` | 594 | `:168-173` desc, **no tie-break** | no (Global) | `:400` | `:398` | 0 / 0 | 6 |
| `admin/ImpersonationRecords` | 784 | on `Keyset` (`:183-200`) | **yes** (`:380-449`, `:639-680`) | `:543` | `:530` | 0 / 0 | 6 |
| `organization/OrganizationRecords` | 475 | on `Keyset` (`:55-70`) | no (Keyed) | `:311` | `:308` | 0 / 0 | 7 |
| `organization/ActiveContextRecords` | 387 | none | no (Derived) | `:248` | `:251` | 0 / 0 | 5 |
| `organization/ConnectionRecords` | 810 | `:339-343` asc, `localeCompare` | no (Keyed) | `:505` | `:508` | 0 / 0 | 7 |
| `organization/InvitationRecords` | 663 | none | no (Keyed) | `:389` | `:392` | 0 / 1 (`:528`) | 14 |
| `organization/MembershipRecords` | 748 | `:191-200` asc/desc, id by `<` | no (Keyed) | `:451` | `:454` | 0 / 3 (`:574,:593,:678`) | 9 |
| `organization/OrgRoleRecords` | 419 | none | no (Keyed) | `:256` | `:259` | 0 / 1 (`:340`) | 6 |
| `organization/TeamRecords` | 1375 | `:365-368` `localeCompare`; `:469-473` `<` | no (Keyed) | `:802` | `:805` | 0 / 1 (`:1014`) | 15 |
| `saml/SamlRecords` | 978 | `:265-270` asc and `:272-279` desc, `localeCompare` | no (Keyed) | `:637` | `:645` (variant: `dialectFields(dialect)`) | 0 / 0 | 14 |
| `scim/ScimRecords` | 822 | `:174-182` asc, `localeCompare` via `tieBreak` | no (Keyed) | `:508` | `:511` | 0 / 0 | 12 |
| `webhooks/WebhookRecords` | 1406 | `:314-321` asc, `localeCompare` | **yes** (`:413-414`, `:578-827`, `:912-927`) | `:1137` (named `failing`) | `:912` (variant) | 0 / 1 (`:1176`) | 24 |

Totals (`bash` census script, output verbatim from this session):

```
closure-def (unavailable|failing):       16
dialectFields(:       16
SqlStore.make:        0
SqlStore.atomically:        5
TenantScoped.matches:        2
TenantScoped.visibility:        2
TenantScoped.liftOn|lift:       10
Keyset.:        2
createdAt hand comparator:       11
makeRow:        4
orStoreUnavailable:       16
total lines:    10664
label call sites: 154
```

Why only 3 tables are tenant-visibility sites: [VERIFIED: `Table.partitioned` greps] the whole repo declares exactly three `Partitioned` tables, `admin_impersonation: AuthPlugin.Table.partitioned("tenantId"),` (`packages/admin/src/Admin.ts:655`), `webhooks_endpoint: AuthPlugin.Table.partitioned("tenantId"),` (`packages/webhooks/src/Webhooks.ts:391`) and `notes_note: AuthPlugin.Table.partitioned(),` (`examples/plugin-template/src/Template.ts:394`). The four spike tables are `Global`: `apikey_key: AuthPlugin.Table.global(` (`api-key/ApiKey.ts:754`), `apikey_client: AuthPlugin.Table.global("service clients are deployment-wide"),` (`:757`), `device_authorization_grant: AuthPlugin.Table.global(` (`device-authorization/DeviceAuthorization.ts:700`), `device_authorization_client: AuthPlugin.Table.global("deployment-wide client registry"),` (`:703`).

### Per helper: near-identical? files? verdict

Threshold: "about 5 files". "Near-identical" = verbatim, or parameterised by a name/field only; "divergent" = different semantics.

| Helper | Files carrying a copy (of 16) | Extended (of 24 modules + template) | How alike | Count test | Deletion test | Preliminary verdict |
|--------|------------------------------:|-----------------------------------:|-----------|:----------:|:--------------|:-------------------:|
| (a) Comparators | **11** (+2 already on `Keyset`) | 11 (the other 8 plugin modules sort nothing by `createdAt`) | 4 spellings; see below | pass | marginal: about -30 to -55 net lines; behaviour changes at 7 sites | **Closest to go; not a go on its own** |
| (b) Tenant-visibility plumbing | **2** (3 with template) | 3 | divergent (inline `matches(Option.getOrNull(row.tenantId), seen)` in Impersonation; named `seenTenant`/`endpointVisible`/`withVisibility` in Webhook) | **fail (2 < 5)** | the shared helper already exists; nothing to delete | **No-go** |
| (c) `unavailable(op)` | **16** (`failing` in Webhook) | 22 of 24 (adds `DomainClaims`, `RevocationStore`, `ChallengeStore`, `PasskeyCredentials`, `PasskeyUserHandles`, `TwoFactorStore`; `UserClaims`/`RoleAssignments`/Template use an inline literal) | verbatim except the store-name literal | pass | **fail:** 2 lines to 1 per file (about -11 net with the helper); the 154 call sites and every label string stay | **No-go** (moves lines) |
| (d) Dialect wire row helper | **16** for the `wire` line (14 verbatim, 2 variants); **`makeRow` in 4, near-identical in 0** | 22 + template | line: verbatim; row schema and `toRecord`: domain-specific | line pass; mapping fail | **fail:** one line replaced by one line; no mapping is shareable without Schema machinery per store | **No-go** |
| (e) `SqlStore.make` adoption | **0 adopted**; 16 candidates | 0 of 24 | not a copy: a migration | n/a | **fail as scaffolding:** adds retry semantics and 154 `write`/`read`/`once` decisions; net about -15 lines | **No-go as a refactor**; a separate behaviour decision if wanted |

**Overall (REC-03 bundle):** 4 of 5 helpers no-go; the 5th is a marginal, behaviour-touching deduplication worth about 0.3 to 0.5% of the base. All five together: roughly -60 to -75 net lines of 10,664 (about 0.6%).

### (a) Comparators in detail (verbatim values)

The four spellings (all in `packages/*/src`):

1. `createdAt` then id by code unit, ascending: `DeviceClientRecords.ts:55-60`
   `const byTime = DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt);` then `return byTime !== 0 ? byTime : a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0;`; also `MembershipRecords.ts:197-200` (reversed for `desc`) and `TeamRecords.ts:469-473`.
2. Same, descending: `ApiKeyClientRecords.ts:75-80` (`clientId`) and `ApiKeyRecords.ts:98-102` (`id`): `const byTime = DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt);` then `a.id < b.id ? 1 : a.id > b.id ? -1 : 0`. These two are verbatim up to the id field name.
3. Ascending or descending with `localeCompare`: `ConnectionRecords.ts:339-343`, `SamlRecords.ts:265-270` and `:272-279`, `ScimRecords.ts:174-182` (id through a `tieBreak` accessor), `WebhookRecords.ts:314-321`, `TeamRecords.ts:365-368` (`a.createdAt.epochMilliseconds - b.createdAt.epochMilliseconds || a.id.localeCompare(b.id)`).
4. No id tie-break: `SigningKeyRecords.ts:168-173` (`DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt)`, SQL `ORDER BY "createdAt" DESC` at `:467,:477`, so memory and SQL agree that ties are unspecified) and `DeviceGrantRecords.ts:215` (`.toSorted((a, b) => millis(a.createdAt) - millis(b.createdAt))` against SQL `ORDER BY "createdAt" ASC, id ASC` at the `listByUserQuery`: **a latent memory/SQL drift on equal `createdAt`**, not pinned by `DeviceGrantRecords`' contract, which has no tie case).

Domain-specific orders that no shared helper should touch: `WebhookRecords.ts:555-557` (`nextAttemptAt` then id), `:796` (`b.id.localeCompare(a.id)`), `ImpersonationRecords.ts:249-255` (`closeOrder` by `endedAt`).

Relation to Phase 3 `Keyset`: `Keyset.key` and `Keyset.window` own the paged order for users, organizations and impersonations (`OrganizationRecords.ts:55-70`, `ImpersonationRecords.ts:183-200`). The id order is declared by code unit (`order: Order.String`), consistent with BEH-EA-036's collation statement: [VERIFIED: `spec/behaviors/05-persistence-stratum.md:116`] "Canonical lowercase uuidV7 ids order the same by code unit and under any database collation ... other ids page completely, without duplicates and resumably on every backend, though their exact order may follow the database collation." So replacing the five `localeCompare` spellings with code-unit order is invisible for canonical ids and changes the order only for non-canonical ids, which BEH-EA-036 already declares collation-dependent.

Existing tie pins: [VERIFIED: grep of `packages/*/test/contract`] tie ordering is asserted in the suites of `DeviceClientRecords`, `ApiKeyClientRecords`, `ApiKeyRecords` (e.g. `"the owner's keys, newest first, equal times by id descending; nobody else's"`), `MembershipRecords`, `TeamRecords`, `ConnectionRecords`, `ScimRecords`, `WebhookRecords`; it is **not** asserted for `SamlRecords`, `SigningKeyRecords`, `DeviceGrantRecords`.

### (e) `SqlStore.make` in detail

[VERIFIED: `packages/sql/src/SqlStore.ts` doc comment] `write`: "classified like `orStoreUnavailable`, retried on a transient failure at the top level only"; `read`: "classified like `orStoreUnavailable`, never retried. Also the wrapper for a write that is not safe to repeat". Adopters today are only the six core `*StoreSql` adapters (`SessionStoreSql.ts:129`, `UserStoreSql.ts:143`, `AccountStoreSql.ts:103`, `VerificationStoreSql.ts:66`, `AuditLogStoreSql.ts:71`, `RelayCursorStoreSql.ts:27`).

ADR-EA-041 decision 5 already states the intent and the state of play: [VERIFIED: `spec/decisions/041-domain-store-ports.md`, decision 5] "The plugin records adapters follow it as plan 25 migrates each store (organization first: `SqlStore.atomically`, `isUniqueViolation`; the remaining stores still pipe each method through `StoreFailure.orStoreUnavailable`, which is the same classification without the retry)." So adoption is a pending migration with a stated behavioural delta (the retry), not duplicated scaffolding.

Researcher's classification of the four spike files' 29 operations (to be confirmed by the spike): 6 `write` (idempotent: `ApiKeyClientRecords.deleteByOwner`; `ApiKeyRecords.touch`, `deleteByOwner`; `DeviceGrantRecords.touchPoll`, `remove`, `deleteByUser`), 9 `read` (the `find*`/`list*` operations), 14 `once` (any write whose answer or effect changes on repetition: every `insert` (boolean from `ON CONFLICT DO NOTHING RETURNING`, or a unique violation turned into a defect), `revoke`, `rotateSecret` (`"previousSecretHash" = "secretHash"` repeated corrupts the pair), `rotate`, `claim`, `decide`, `raiseInterval` (increment), `consume` (`DELETE ... RETURNING`), `purgeExpired` (returns a count)). Only 6 of 29 (21%) operations would gain the retry; the other 23 keep today's behaviour with a longer spelling. [ASSUMED: the classification is the researcher's reading of the statements; no test injects a post-commit transient failure.]

### Context: the other 8 plugin store modules and the template

`unavailable`-style closures: `DomainClaims.ts:150`, `RevocationStore.ts:134`, `ChallengeStore.ts:193`, `PasskeyCredentials.ts:340`, `PasskeyUserHandles.ts:89`, `TwoFactorStore.ts:370,:493` (both with a store-name literal). `dialectFields(`: `RevocationStore.ts:107`, `ChallengeStore.ts:190`, `PasskeyCredentials.ts:343`, `PasskeyUserHandles.ts:92`, `TwoFactorStore.ts:368,:491`, `Template.ts:215`. `SqlStore.atomically` is in 9 modules in all: `TeamRecords`, `MembershipRecords`, `InvitationRecords`, `OrgRoleRecords`, `WebhookRecords`, `DomainClaims`, `UserClaims`, `TwoFactorStore`, `Template` (the "5 of 16" in ARCHITECTURE.md counted these, not `make`).

### Census commands (the spike re-runs these and pastes output)

```bash
# 16-file population; run with bash (zsh does not word-split an unquoted variable)
F16=(packages/admin/src/ImpersonationRecords.ts packages/api-key/src/ApiKeyClientRecords.ts packages/api-key/src/ApiKeyRecords.ts packages/device-authorization/src/DeviceClientRecords.ts packages/device-authorization/src/DeviceGrantRecords.ts packages/jwt/src/SigningKeyRecords.ts packages/organization/src/{ActiveContext,Connection,Invitation,Membership,Organization,OrgRole,Team}Records.ts packages/saml/src/SamlRecords.ts packages/scim/src/ScimRecords.ts packages/webhooks/src/WebhookRecords.ts)
c() { echo "$1: $(grep -lE "$2" "${F16[@]}" | wc -l)"; }
c "closure-def" "(const unavailable = |const failing = )"
c "dialectFields(" 'SqlModels\.dialectFields\('
c "SqlStore.make" 'SqlStore\.make'
c "SqlStore.atomically" 'SqlStore\.atomically'
c "TenantScoped.matches" 'TenantScoped\.matches'
c "lift|liftOn" 'TenantScoped\.(liftOn|lift)\('
c "Keyset." 'Keyset\.'
c "createdAt comparator" 'toEpochMillis\((a|b)\.createdAt\)|(a|b)\.createdAt\.epochMilliseconds|millis\(a\.createdAt\)'
c "makeRow" 'const makeRow'
echo "lines: $(cat "${F16[@]}" | wc -l); labels: $(cat "${F16[@]}" | grep -cE '(unavailable|failing)\("')"
```
(`packages/organization/src/{...}Records.ts` brace-expands in bash; the script used this session spelled the seven paths out.)

## Q2: What a helper would look like (only if the spike says go)

Constraints common to all: no `as` (`.oxlintrc.json:33-37`); no return-type annotations on new Effect/Layer consts (`.planning/README.md` shared conventions); `*Shape` unchanged; no new package edge ([VERIFIED: `package.json` read for all 12 plugin packages] every plugin depends on `@awthaq/ports`, `@awthaq/sql` and `@awthaq/core`, and `@awthaq/test` only as a devDependency; `roles` lacks `@awthaq/sql`, which it does not use); `@awthaq/test` cannot host a runtime helper (`pnpm check:contract-tests`: "@awthaq/test stays dev-only"). TS2883 (declaration emit cannot name a type) is documented in this repo as a narrow exception handled by naming the type in the owning module (`SigningKeyRecords.ts:234-235`: "The explicit types on `layerMemory` and `layerSql` are the narrow exception the plugins document (TS2883)"); a helper whose return type is `Order.Order<Row>` or a function from `StoreFailure` is nameable, but no prototype was compiled: [ASSUMED] low risk, to be probed by the spike.

| # | Helper (suggested name) | Module / stratum | Interface | Adopters | Lines removed vs added (estimate) | Preserves labels, lock keys, one `Ref` | Verdict |
|---|-------------------------|------------------|-----------|----------|-----------------------------------|----------------------------------------|---------|
| a | `Keyset.chronological` (additive export; or an exported `Keyset.orderOf(keys)` plus an optional `cursor` on `Keyset.key`) | `packages/ports/src/Keyset.ts`, stratum 2; no new module, so no `surface:ports` block change | `chronological<Row>({ createdAt: (r) => DateTime.Utc, id: (r) => string, direction }) => Order.Order<Row>` built from `Order.mapInput`, `Order.combine`, `Order.flip` | 11 files | about -81 removed (sum of the comparator ranges above: 6+6+5+12+9+5+14+9+8+6+1), +about 20 helper and +about 8 call lines, +tests: net -30 to -55 | yes (labels, keys, `Ref` untouched); comparator output identical for canonical ids; differs for 5 `localeCompare` sites on non-canonical ids and where tie-break is added at 2 sites | conditional |
| b | none (already `TenantScoped`) | `packages/sql/src/TenantScoped.ts` | `visibility`, `matches`, `predicate`, `stamp`, `lift`, `liftOn` | 2 | 0 | n/a | no |
| c | `StoreFailure.labelled(store)` | `packages/sql/src/StoreFailure.ts`, stratum 3 | `(store: string) => (operation: string) => orStoreUnavailable(`${store}.${operation}`)` | 16 (+6) | about -15 net (16 two-line closures to one line, +4 helper) | yes if it builds the identical string | no |
| d | `SqlModels.wireOf(sql)` | `packages/sql/src/Models.ts` | `Effect.map(resolveDialect(sql), dialectFields)` | 16 (+6) | 0 (one line for one line) | yes | no |
| e | none new: `SqlStore.make` exists | `packages/sql/src/SqlStore.ts` | `const { write, read, once } = SqlStore.make(sql)`; each call `write("Store.op")` / `read(...)` / `once(...)` | 16 | about -15 net; +154 classification decisions | labels byte-identical if the full string is passed; **behaviour changes** (retry on `write`) | no (separate decision) |

Type-level notes: (a) `Order.flip`, `Order.mapInput`, `Order.combineAll` and `DateTime.Order` are already used without `as` in `Keyset.ts:60-70` and `OrganizationRecords.ts:55-70` [VERIFIED: read]. Nothing here touches `layerMemory`'s state, so "every `layerMemory` is one `Ref<State>`" is preserved by construction for (a)-(e); only a memory-table wrapper (not in REC-03) would endanger it.

## Q3: Track A and ADR-EA-046

### What plan 24 reserved ADR-EA-046 for (verbatim)

[VERIFIED: `.planning/24-memory-records-over-sqlite/PLAN.md:11`] "`| New ADR | **ADR-EA-046** (reserved for this plan): "Plugin record stores keep a memory adapter held to the SQL adapter by a differential parity contract" (Track B), or its Track A counterpart if the spike says go. Both drafts are in §6.1 |`"; `:3`: "> **Superseded in part (2026-11-08, plan 25 Q0 accepted):** plan 25 subsumes Track B (Phases 1–5 ...). This plan keeps only the Track A spike and ADR-EA-046. Do not implement Phases 1–5 from here."; `:404`: "### 6.1 ADR-EA-046 (new; `spec/decisions/046-plugin-record-store-parity.md`, plus an `index.yaml` entry)"; `:425`: plan 24 itself specified an ADR-EA-041 revision, "Add to Alternatives: "**SQL over an in-process SQLite as the memory adapter.** Weighed for plugin record stores in ADR-EA-046; the same reasoning applies to core's ports ..."". The README reservation: [VERIFIED: `.planning/README.md:206`] `| ADR-EA-046 | Plugin record stores: one behaviour for memory and SQL | 24 |`. Track A's gates: G1 (`pnpm test` within +20%), G2, G3 (needs pglite), G4 (the user approves taking core's `Persistence.memory` out of `TestAuth`), G5 (Node floor) (`PLAN.md:308-313`); the spike's file `.scratch/memory-records-over-sqlite/issues/00-spike.md` does not exist [VERIFIED: `ls .scratch/memory-records-over-sqlite` printed nothing], so **the spike was never run and no measured numbers exist.**

### What is already decided

- **Plan 25** [VERIFIED: `.planning/25-record-store-contract/PLAN.md:131`] "**No differential parity harness** (plan 24's `runRecordsParity`) and **no Track A** (memory adapter over SQLite). §8 and Q0 explain why."; `:1227`: "ADR-EA-046 stays plan 24's, for Track A only."; `:1310-1311`: the Track A spike "asks a different question (should the memory adapter *be* SQLite?), and ADR-EA-046 stays reserved for that answer." Q0 was accepted by the user 2026-11-08 (`:1401`). Plan 37 has only a "Plugin-side only / None" interaction row (`.planning/37-store-contract-runner/PLAN.md:555`).
- **ADR-EA-041** [VERIFIED: read in full this session; Document Control `> | Revision | 1.6 |`, `> | Effective Date | 2026-11-10 |`]:
  - Decision 2: "Every primitive on a port is atomic by contract ... one `Ref.modify` in the memory adapter, one statement or one transaction in the SQL adapter."
  - Decision 5: the one adapter shape, including "The plugin records adapters follow it as plan 25 migrates each store ...".
  - Decision 6: the contract suite is the adapter bar, "`StoreContract.run(framework, mode)` owns the modes".
  - Decision 9: "A plugin's domain is already written once in its system modules (ADR-EA-040), so its record store keeps its two adapters, bundled as `records` (BEH-EA-334)"; every operation carries a verdict; "A transaction alone is not atomicity under READ COMMITTED."
  - Alternatives already recorded: "**Keep the twins with a shared helper module.** Rejected: the helpers already exist; the drift is in the I/O sequencing, which only an atomic seam fixes." and "**A differential memory/SQL parity harness as the plugin bar** (plan 24 Track B). Rejected as the bar for decision 9: it states no semantics and cannot see races ... It remains a possible addition."
  - **Not recorded:** the Track A alternative (SQL over an in-process SQLite as the memory adapter). That is the one gap REC-01 fills.
- **Requirements:** `Replacing memory twins with SQLite `:memory:` | SQLite cannot reproduce Postgres races; plan 25 and ADR-EA-041 decision 9 keep two adapters` (`REQUIREMENTS.md` Out of Scope row).

### Next free ADR number and `index.yaml` shape

Highest file in `spec/decisions/` is `057-one-jws-verifier.md`. ADR numbers 046, 050-053, 055, 056, 058 and 059 are absent; the README records them as "Released" (`.planning/README.md:454-461`) and strict verify accepts the gaps (`.planning/README.md`: "ADR-EA-050–053, 055, 056 gaps (accepted by strict verify)"). **If any new ADR were ever needed, the next number is ADR-EA-058** (above the highest file; reusing a lower released number is unnecessary). `spec/decisions/index.yaml` shape [VERIFIED: `index.yaml:1-4` and `:165-168`]:

```yaml
kind: decisions
package: awthaq
infix: EA
entries:
  - id: "ADR-EA-041"
    file: "041-domain-store-ports.md"
    title: "Core Domain Services Are Written Once Over Atomic Store Ports"
    status: "Accepted — implemented"
```
Entries carry only `id`, `file`, `title`, `status`; the order is not strictly numeric (`ADR-EA-057` is listed before `ADR-EA-054`). It carries no revision, so a revision bump of ADR-EA-041 needs **no** `index.yaml` edit.

### Recommendation: release ADR-EA-046; record Track A as ADR-EA-041 revision 1.7

Reasons: (1) REC-01 names the ADR-EA-041 revision note as the mechanism, and plan 24 itself specified an ADR-EA-041 alternative for this exact option. (2) A stand-alone ADR "Track A rejected" would sit on a spike that was never run, so it could cite only the architecture argument, which decision 9 already states. (3) Strict verify tolerates the gap (046 is one of 8 absent numbers). (4) A new ADR costs an `index.yaml` row, a `spec/traceability.md` row (strict check "decisions -> traceability": [VERIFIED: `spec/scripts/verify-traceability.sh:119-139`] every ADR file must appear in traceability) and a Revision bump of traceability (currently 1.94), for no new information. (5) The no-go path of the spike is also docs-only, so the smaller the spec footprint the better.

**Exact edits (docs only; `spec/decisions/041-domain-store-ports.md`):**

1. Document Control: `Revision` 1.6 to 1.7; `Effective Date` to 2026-11-14; append to the `Change History` cell ` <br> 1.7 (2026-11-14): revision note under Consequences and alternative (e): plan 24 Track A (SQL over an in-process SQLite as the memory adapter) is closed; ADR-EA-046, reserved for it, is released (architecture deepening batch 3, phase 6)`. Strict check 14 [VERIFIED: `spec/scripts/check-drift.mjs:203-217`]: the Revision must equal the newest version in Change History, matched by `/^\s*>?\s*\|\s*Revision\s*\|\s*([\d.]+)\s*\|/m` and `(?:^|<br>|;)\s*(\d+\.\d+)\s*\(`. Keep the new entry as `<br> 1.7 (` and avoid a `;` followed by digits and `(` inside it.
2. Body, after the "**Negative**" paragraph and before `## Alternatives considered` (the precedent is ADR-EA-040's "**Revision note (1.3).**" paragraph, which sits in that position):

   > **Revision note (1.7).** Plan 24's Track A, SQL over an in-process SQLite `:memory:` as the memory adapter for plugin record stores (which would delete every plugin `Ref` twin), is closed; decision 9 stands unchanged. SQLite serialises writers, so a suite over it cannot exhibit the Postgres READ COMMITTED races the `race` cases exist for, and the `Ref` adapter is the executable statement of the intended atomicity; a matched memory composition would also have to take core's `Persistence.memory` out of `TestAuth` (decision 4). The Track A spike (plan 24 gates G1-G5) was never run, so the closure rests on that argument and on the approved milestone requirement (REC-01 and the Out of Scope row), not on measured numbers. ADR-EA-046, which plan 24 reserved for this decision, is released: this note and alternative (e) are the record. No decision text changes.

3. Add to `## Alternatives considered`: `- **(e) SQL over an in-process SQLite `:memory:` as the memory adapter** (plan 24 Track A). Rejected: SQLite serialises writers, so it cannot reproduce the Postgres atomicity class decision 9 guards; deleting the `Ref` adapters removes the executable statement of the intended semantics; and a matched memory composition would require core's `Persistence.memory` to leave `TestAuth` too (decision 4).`
4. `spec/decisions/index.yaml`: no change. `spec/traceability.md`: no change required (the ADR-EA-041 row at `:186` names no revision). Gate: `pnpm spec:verify:strict` stays `FAIL 0`.

**`.planning/` reservations (in scope as docs, allowed by the phase path allowlist idea `\.planning/`):** `.planning/README.md:206` (the reserved-number row) and `:341` (the "Plugin memory/SQL parity" reconciliation row) say ADR-EA-046 is plan 24's for Track A; plan 24's own banner (`PLAN.md:3`) still reads as if the spike were pending. Recommended minimal edits so no reservation is left unexplained: annotate `.planning/README.md:206` as released ("released 2026-11-14, phase 6 REC-01: Track A closed in ADR-EA-041 rev 1.7"), append the same to `:341`, and add one banner line to the top of plan 24 ("Track A closed and ADR-EA-046 released: see ADR-EA-041 revision 1.7"). Plan 25 (`:1227`, `:1311`) and plan 37 need no edit: they say "ADR-EA-046 stays plan 24's", which stays true. Earlier phases never edited numbered plans or the README, and the user can decline these three annotations without affecting REC-01 (the ADR note is the record); the executor should make them because CONTEXT says "No ADR number is left reserved and unexplained". `ROADMAP.md` and `REQUIREMENTS.md` checkboxes are the orchestrator's, not the executor's.

## Q4: Pins to record before any `src` change (on a go; Wave 0 per CONTEXT)

What already pins what, and what is missing, for the four spike files:

| Pin | Already pinned | Missing (Wave 0 must add if a prototype or go is entered) |
|-----|----------------|-----------------------------------------------------------|
| Operation labels (`StoreUnavailable.operation`; [VERIFIED: `packages/api/src/Api.ts:194-198`] `export class StoreUnavailable extends Schema.TaggedError<StoreUnavailable>()("StoreUnavailable", { operation: Schema.String }, { httpApiStatus: 503 })`, so the string is on the wire) | 5 of the 29 four-file labels: `ApiKeyClientRecords.insert` (`api-key/test/contract/ApiKeyClientRecords.ts:240`), `ApiKeyRecords.insert` (`:358`) and `.rotate` (`:372`), `DeviceClientRecords.insert` (`device-authorization/test/contract/DeviceClientRecords.ts:186`), `DeviceGrantRecords.insert` (`:491`). Over all 16 files: 8 of 154 | A source-scan pin: for each store, the multiset of `unavailable("x")`/`failing("x")` arguments, per file, equals a frozen literal list (154 strings), and equals the store's `operations` keys. Cheap and exact; a trigger-based `TestSql.injectFailure` can only fail writes (`event: "DELETE" \| "INSERT" \| "UPDATE"`), never a `SELECT` |
| Lock keys | none; the key strings appear only in prose (`spec/behaviors/34-webhooks.md:163`, `31-two-factor.md:158`) | frozen literals for the nine `SqlStore.atomically` sites: `organization_team:org:${organizationId}` (`TeamRecords.ts:1014`), `organization_membership:org:${input.organizationId}` (`MembershipRecords.ts:576`), `organization_membership:owner:${input.userId}` (`:595`), `organization_membership:org:${organizationId}` (`:678`), `organization_invitation:inviter:${input.inviterId}` (`InvitationRecords.ts:530`), `organization_role:org:${input.organizationId}` (`OrgRoleRecords.ts:342`), `webhooks_endpoint:tenant:${stamped.tenantId ?? "-"}` (`WebhookRecords.ts:1178`), `organization_domain_claim:org:${organizationId}` (`DomainClaims.ts:161`), `qadi_claims:user:${userId}` (`UserClaims.ts:222`), `two_factor_recovery_code:user:${userId}` (`TwoFactorStore.ts:496`), `notes_note:owner:${input.owner}` (`Template.ts:255`). **None of the four spike files has a lock key**; none of the five helpers can change one |
| Verdict tables | enforced at compile time: `RecordsContract.suite(store, { operations })`, "an operation added without one does not compile" (`RecordsContract.ts` header); the runner reads both adapters from `Plugin.records` | nothing new: a go must leave every `operations` map untouched (`git diff` over `packages/*/test/contract/*.ts` empty) |
| Comparator outputs | tie cases in 8 of 11 comparator sites (see Q1); `RecordsContract` runs them on memory, SQLite and Postgres | tie cases for `SamlRecords`, `SigningKeyRecords`, `DeviceGrantRecords`. The `DeviceGrantRecords` case would **fail on memory today** (drift), so it is a finding for `06-SPIKE.md`, not a Wave 0 pin; a go must decide to fix it deliberately |
| Tenant visibility | `tenancy` cases in 13 contract suites incl. `ImpersonationRecords`, `WebhookRecords`, the template; the four spike suites have none because their tables are `Global` | nothing new |
| One `Ref` per `layerMemory` | not pinned | a source-scan of `Ref.make` per `layerMemory` per file against a frozen table (all 1, except `ImpersonationRecords` 2 + a `Semaphore`; `TwoFactorStore` 1 per store) |

Postgres leg of the existing pins, run this session [VERIFIED: executed]: `AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq npx vitest run packages/api-key/test/Contract.test.ts packages/device-authorization/test/Contract.test.ts examples/plugin-template/test/Contract.test.ts` printed `Test Files  3 passed (3)` and `Tests  174 passed (174)` (13 s); without the variable, `Tests  171 passed (171)` (2 s).

## Q5: Docs and example today, and what changes on a go

`docs/plugin-authoring.md` teaches, today:
- Line 29: [VERIFIED: read] "A records module never turns a database failure into a defect. Pipe each method through `StoreFailure.orStoreUnavailable("<Records>.<method>")` (or `Effect.catchTag("SqlError", StoreFailure.storeUnavailable(op))` beside a domain outcome of its own, and `StoreFailure.orConflict` for a unique violation) so it fails with the typed `StoreUnavailable` ...".
- "Record stores and bundles" (`:225-247`): the `records: { memory, sql }` bundle and its three compile-time refusals; the atomic-primitive rule (`SqlStore.atomically`); verdicts per operation in `RecordsContract`.
- Checklist item 4 (`:297`): "each with `layerMemory` and `layerSql` (the template ships both), every method failing with `StoreUnavailable`, never a defect"; item 10 (`:303`): tenancy declared, "its records filtered through `TenantScoped`".
- It does **not** mention `SqlStore.make`, comparators or a wire helper.

`examples/plugin-template/src/Template.ts` (465 lines) ships `layerMemory` (`:138`) and `layerSql` (`:210`), a `notes_note` `Partitioned` table (`:394`), `StoreFailure.orStoreUnavailable("NoteRecords.create")` inline (`:266`, `:273`), `TenantScoped.matches` (`:164`, `:178`), `SqlStore.atomically` with key `notes_note:owner:${input.owner}` (`:255`), and `records: { memory: layerMemory, sql: layerSql },` (`:399`). Its tests: `examples/plugin-template/test/{Contract,Schema.lock,Template}.test.ts`, `test/contract/NoteRecords.ts`; the root `vitest.config.ts` lists `examples/plugin-template` as a project; package script `"test": "vitest run"`.

On a go: lines 29 and 297 would name the adopted helper (`labelled`/`SqlStore.make`) instead of the inline `orStoreUnavailable("<Records>.<method>")` spelling, the template would adopt the same spelling, and both update **last** (REC-04). On a no-go: no change to either. Test commands: `pnpm --filter @awthaq/example-plugin-template test` or `npx vitest run examples/plugin-template`; the contract part alone, `npx vitest run examples/plugin-template/test/Contract.test.ts` (measured: green, part of the 171/174 above).

## Q6: Gates and risks

Gate list and phase-close rule [VERIFIED: `.planning/phases/05-core-table-list-cleanup/05-BASELINE.md`]: `tsc -b` (`npx tsc -b tsconfig.json`), tests typecheck (`npx tsc -p tsconfig.test.json`; 2 pre-existing `warning TS377149` in `TestingHarnessSteps.ts`), `pnpm circular`, `pnpm check:error-tags` (163 internal / 137 wire), `pnpm check:transactions`, `pnpm check:contract-tests` (21 plugin classes), `pnpm lint`, `pnpm format:check`, `pnpm check:readmes`, `pnpm workspace:check`, `pnpm test:bdd` (39 files; 1580 passed, 44 skipped), `pnpm test` (420 files + 6 skipped; 6676 passed, 1 expected fail, 22 skipped, SQLite/memory), `pnpm coverage` (floors 89 / 83 / 84 / 90; Phase 5: 91.75 / 85.24 / 87.06 / 92.27), `pnpm spec:verify:strict` (PASS 32, FAIL 0), `pnpm knip` (exit 1 pre-existing: 39 `.claude/` files + 3 unlisted deps in `packages/sql/test/fixtures/readme-quickstart.ts`; filtered output must gain nothing, `git diff --stat knip.json` empty), `pnpm package:smoke` (30 PASS). Comparison rule: every gate exits as in baseline, counts only grow, coverage at or above the floors, knip gains nothing, no new dependency (`git diff --stat <base> HEAD -- packages/*/package.json features/package.json pnpm-lock.yaml` empty). `tsc -b` runs before every cross-package vitest run (GATE-01). Wave 0 re-records the baseline at the Phase 6 planning HEAD (`06-BASELINE.md`), as Phases 1-5 did.

**Path allowlist for phase close** (the Phase 5 idea, adapted). On a no-go every line of `git diff --name-only <phase base> HEAD` must match `^(spec/decisions/041-domain-store-ports\.md$|\.planning/)` plus, if the pins plan lands, one tests-only path such as `^packages/[a-z-]+/test/`. On a go it additionally allows the named `packages/*/src/*Records.ts`, the helper module and its test, `.changeset/<name>.md`, `docs/plugin-authoring.md`, `examples/plugin-template/`, and (only if the surface changes) `spec/overview.md`, `spec/traceability.md`.

**Known flaky tests** [VERIFIED: 05-BASELINE.md "Known intermittents"]: (1) `packages/passkey/test/Contract.test.ts > ... ChallengeStore ... consume [atomic]: false for any other value, a tampered one included` (memory or sql variant); (2) `packages/organization/test/TenantMiddleware.test.ts > ... a suspended organization still resolves (the plugin's own gate refuses it)`. Rule: a command whose only failures are one of the two is re-run twice at most and every run recorded; any other failure is a real regression.

**Strata and cycles.** A comparator helper in `@awthaq/ports` (stratum 2) imports nothing above it; `@awthaq/sql` helpers stay below core. `pnpm circular` counts type-only cycles, so a helper must be generic over the row and never `import type` a protocol's records (ARCHITECTURE.md). A new exported helper with no production caller fails `pnpm knip` (unused export), so each helper needs at least one adopter in the same change.

**Postgres.** Local container `awthaq-p3-pg` is up: `PostgreSQL 16.16 (Debian 16.16-1.pgdg13+1) on aarch64-unknown-linux-gnu`, `pg_isready` "accepting connections" (executed). Always pass `AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq` explicitly; never `scripts/test-pg.sh`. Record each leg as "run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)" (this supersedes GATE-04's "record 'not run locally'" and the roadmap wording, per CONTEXT).

**Changeset.** A no-go touches no package source, so no changeset (`.changeset/` diff empty). A go adds one `.changeset/<name>.md` with a `Migration:` line if an export is added or removed (ADR-EA-034; pattern: `.changeset/keyset-page-module.md`, `connection-lifecycle-module.md`, `core-table-catalogue.md`). **Spec revisions:** ADR-EA-041 1.6 to 1.7 (REC-01, both paths); a go that adds a `ports` module would bump `spec/overview.md` (Revision 1.18; the `<!-- surface:ports -->` block, check 13) and `spec/traceability.md` (Revision 1.94) together with their Change History; extending the existing `Keyset` module needs neither.

**Risks.** (1) The `SqlStore.make` retry (Pitfall 4). (2) Unifying `localeCompare` and tie-breaks changes order for non-canonical ids and for `DeviceGrantRecords` ties. (3) A prototype that edits `src` before pins and the baseline violates CONTEXT's Wave 0 rule: run any prototype in a throwaway git worktree and never merge it (the plan 24 Phase 0 pattern). (4) `ConnectionRecords` was rewritten in Phase 4 and `OrganizationRecords`/`ImpersonationRecords` in Phase 3: re-read line numbers at execution time, they shift.

## Q7: Plan shape recommendation

Preliminary verdict and numbers (to be re-measured by the spike, not copied): 4 of 5 helpers fail (count or deletion test); comparators passes the count (11) and is marginal on the deletion test (about -30 to -55 net lines, at most 0.5% of 10,664); the whole bundle is about -60 to -75 net lines (0.6%); `SqlStore.make` has 0 adopters and a behaviour delta; tenant plumbing is 2 files. **The evidence is decisively no-go for the bundle as REC-03 states it.**

Decision rule to write into the spike plan before measuring (so the call is mechanical): a helper is GO only if (i) at least 5 of the 16 files carry a near-identical copy, (ii) lines removed minus lines added (helper and its test included) is positive at the call sites, and (iii) it changes no `*Shape`, verdict, label, lock key or ordering output for any input the contract can produce. REC-03 is satisfied only if the bundle as named goes; a partial verdict (comparators alone) is recorded as "not pursued; closest to go" unless the executed spike's numbers overturn the estimates. [ASSUMED: the roadmap's "no-go if fewer than about 5 files share a helper" is ambiguous between per-helper and bundle; this rule picks per-helper counting with a bundle-level go. The planner should state it in the spike plan.]

What would change the verdict: (1) the prototype showing a comparator declaration also replaces the hand-written SQL `ORDER BY` through `KeysetSql.orderBy` and removes at least about 150 lines in total; (2) the user choosing transient retry for plugin writes as an intentional behaviour change (a separate candidate with its own pins and ADR-EA-041 decision 5's stated delta), which makes `SqlStore.make` adoption a feature, not scaffolding; (3) a re-count that finds more than 2 `Partitioned` plugin stores (none planned).

### Recommended plans

| Plan | Wave | Content | Write now? |
|------|------|---------|------------|
| 06-01 | 1 | Wave 0: `06-BASELINE.md`, every gate at HEAD (Postgres leg included, Debian container version recorded, known intermittents), census command output pasted, path allowlist and close rule. No source change | yes |
| 06-02 | 2 | REC-01 record: ADR-EA-041 revision 1.7 (note + alternative (e)), `.planning/README.md:206,:341` annotation, plan 24 banner line; `pnpm spec:verify:strict` re-run. Docs only, reversible | yes |
| 06-03 | 2 (parallel with 06-02, file-disjoint) | Wave 0 pins for the four spike files (tests only): source-scan of operation-label sets (29 labels) and `Ref.make` counts, plus a frozen lock-key table for the nine sites; no `src` edit. A finding (not a pin) for the `DeviceGrantRecords.listByUser` tie drift | yes |
| 06-04 | 3 | The spike: re-run the census, fill the per-helper table with measured counts and the deletion test, optional throwaway-worktree prototype of comparators on the four files measuring `git diff --shortstat`, write `06-SPIKE.md` with the decision rule and the verdict. No scaffolding code lands | yes |
| 06-05 | 4 | Phase close on no-go: record REC-03 and REC-04 as not pursued with the reason; allowlist diff, `git diff` empty over `packages/*/src`, `.changeset/` empty, every gate vs baseline, Postgres legs; plus the no-go section in `06-SPIKE.md`. The orchestrator, not the executor, updates ROADMAP/REQUIREMENTS | write after the spike (its shape is predictable) |
| 06-06+ | 4+ | Go branch only: Wave 0 pins first, then one helper per plan (comparators first), docs and template last, changeset, spec, gates | **no: wait for the executed spike** |

If the user prefers fewer plans, 06-01 and 06-03 can merge; 06-02 must stay separate from the baseline (the baseline must precede any change, as in Phases 1-5).

## Common Pitfalls

### Pitfall 1: The "5 of 16 already adopted `SqlStore`" premise
**What goes wrong:** ARCHITECTURE.md and SUMMARY.md say 11 of 16 files "have not adopted `SqlStore`; that is the real shared slice". The 5 are `Invitation`, `Membership`, `OrgRole`, `Team`, `Webhook`, and they use `SqlStore.atomically`, not `SqlStore.make`.
**How to avoid:** count `SqlStore.make` (0 of 16). The "real shared slice" is therefore a migration with a behavioural delta, not a copy.
**Warning signs:** a plan that says "move the 11 stragglers onto `SqlStore.make`" without a per-operation classification.

### Pitfall 2: REC-04's "every `layerMemory` is one `Ref<State>`" is not literally true today
**What goes wrong:** [VERIFIED] `ImpersonationRecords.ts:319-320` `const state = yield* Ref.make<RecordsState>(HashMap.empty());` and `const ledger = yield* Ref.make<ReadonlyArray<LedgerEntry>>([]);` plus an `appendLock` `Semaphore`, by design (plan 25 F7: "one critical section ... no reader sees a row without its link"). `SigningKeyRecords` exports `layerMemory` and `layerMemoryStore`.
**How to avoid:** pin the count per module as it is today (all 1, Impersonation 2) and word the closure as "unchanged", not "exactly one".

### Pitfall 3: `localeCompare` is not the SQL order
**What goes wrong:** five memory comparators use `localeCompare`; SQL orders by the database collation; Phase 3 chose code-unit order. A unifying helper silently changes order for non-canonical ids and breaks "byte-identical comparator outputs" for those sites.
**How to avoid:** keep the spike's equality claim to canonical lowercase UUIDv7 ids (BEH-EA-036's own scope) and record the five sites as an intentional normalisation, with a mixed-case probe.

### Pitfall 4: `SqlStore.make.write` retries a unit whose repetition changes the answer
**What goes wrong:** `insert ... ON CONFLICT DO NOTHING RETURNING` answers `false` on a retry after a lost acknowledgement; a retried `consume` (`DELETE ... RETURNING`) loses the grant; `rotateSecret` swaps twice.
**How to avoid:** classify per operation (`once` for any non-idempotent write); 23 of 29 operations in the four files take the non-retrying path, so the gain is small.

### Pitfall 5: Counting a one-line closure as shared scaffolding
**What goes wrong:** `unavailable(op)` and the `wire` line appear in all 16 files, which clears the file count, but replacing them moves one or two lines per file and hides the per-store label string at the call site.
**How to avoid:** apply the deletion test, as CONTEXT's specifics require.

### Pitfall 6: Wave order
**What goes wrong:** pins or a prototype before the baseline invalidate the baseline; `spec:verify:strict` after the ADR edit but compared to a pre-edit baseline.
**How to avoid:** baseline first (Wave 1), everything else after, and the close compares against the baseline.

### Pitfall 7: Zsh word-splitting in census scripts
**What goes wrong:** `F16="a b c"; grep ... $F16` treats the list as one filename in zsh (seen this session). **How to avoid:** use a bash array in a `bash` script.

### Pitfall 8: Known flaky tests
See Q6: re-run at most twice and record each run.

## Code Examples

### The comparator the memory half would reuse (sketch; only on a go)
```typescript
// Sketch, not compiled. Built from primitives already used without `as` in packages/ports/src/Keyset.ts.
import * as DateTime from "effect/DateTime";
import * as Order from "effect/Order";

export const chronological = <Row>(spec: {
  readonly createdAt: (row: Row) => DateTime.Utc;
  readonly id: (row: Row) => string;
  readonly direction: "asc" | "desc";
}): Order.Order<Row> => {
  const ascending = Order.combine(
    Order.mapInput(DateTime.Order, spec.createdAt),
    Order.mapInput(Order.String, spec.id), // code unit, as Keyset declares ids
  );
  return spec.direction === "desc" ? Order.flip(ascending) : ascending;
};
```
(The no-return-type-annotation convention applies to Effect/Layer consts; a plain function type is fine. Confirm `Order.combine`'s signature in the pinned `effect` 4.1.2 before use: `Order.combineAll` is the one verified in `Keyset.ts:90`.)

### The label pin skeleton (Wave 0, tests only)
```typescript
// Sketch. Reads src as text; no import of the stores, so no runtime coupling.
import { readFileSync } from "node:fs";
const labelsOf = (file: string) =>
  [...readFileSync(file, "utf8").matchAll(/(?:unavailable|failing)\("([A-Za-z]+)"\)/g)].map((m) => m[1]);
// expected: a frozen literal per file, e.g. DeviceClientRecords: ["insert", "findById", "list", "revoke"]
```
(The four-file label sets were read from source: `DeviceClientRecords`: insert, findById, list, revoke; `ApiKeyClientRecords`: insert, findById, listByOwner, revoke, rotateSecret, deleteByOwner; `ApiKeyRecords`: insert, findById, listByOwner, revoke, rotate, touch, deleteByOwner; `DeviceGrantRecords`: insert, findByDeviceHash, findByUserHash, claim, decide, touchPoll, raiseInterval, consume, remove, purgeExpired, listByUser, deleteByUser.)

### The verbatim closures a `labelled` helper would replace
```typescript
// packages/device-authorization/src/DeviceClientRecords.ts:103-104
    const unavailable = (operation: string) =>
      StoreFailure.orStoreUnavailable(`DeviceClientRecords.${operation}`);
// packages/webhooks/src/WebhookRecords.ts:1137
    const failing = (method: string) => StoreFailure.orStoreUnavailable(`WebhookRecords.${method}`);
// the wire line, packages/device-authorization/src/DeviceClientRecords.ts:105
    const wire = SqlModels.dialectFields(yield* SqlModels.resolveDialect(sql));
```

## State of the Art

| Old approach | Current approach | When changed | Impact |
|--------------|------------------|--------------|--------|
| Plugin stores restate ordering per file | Core and 2 plugin stores declare order once (`Keyset`) | Phase 3 (2026-11-14) | Comparators are the one slice with a ready substrate |
| Plugin adapters pipe through `orStoreUnavailable` | ADR-EA-041 decision 5 names `SqlStore.make` as the shape; plan 25 migrated only `atomically` | plans 25, 28 | `make` adoption is pending, with the retry as its stated delta |
| Track A (SQLite as memory) kept as an open spike | Closed by REQUIREMENTS Out of Scope; recorded in ADR-EA-041 1.7 | this phase | Memory twins stay |

**Deprecated/outdated:** the research summary's premise "5 of 16 have started the `SqlStore` shape" (Pitfall 1).

## Assumptions Log

| # | Claim | Section | Risk if wrong |
|---|-------|---------|---------------|
| A1 | Net line savings (-30 to -55 for comparators, -60 to -75 for the bundle) are estimates from reading, not a prototype | Q1, Q2 | A prototype could find more (or less) saving; the spike measures it with `git diff --shortstat` |
| A2 | The `write`/`read`/`once` classification of the four files' 29 operations (6/9/14) is the researcher's reading | Q1 (e) | A different classification changes the 21% figure, not the conclusion; the spike confirms |
| A3 | TS2883 is a low risk for `Order.Order<Row>` and `StoreFailure` helper return types | Q2 | Declaration emit might need a named type; solved by naming it in the helper's module |
| A4 | The roadmap's "no-go if fewer than about 5 files share a helper" is applied per helper with a bundle-level go | Q7 | If the user reads it as "any helper at 5+ is a go", comparators alone would go; that is a narrow, behaviour-touching change worth about 0.5%, so surface it in the spike report |
| A5 | `npx vitest run examples/plugin-template` filters the root project by path | Q5 | The package script `pnpm --filter @awthaq/example-plugin-template test` is the verified alternative; the `Contract.test.ts` path was run and passed |
| A6 | Annotating `.planning/README.md` and plan 24 is wanted ("no number left unexplained") | Q3 | If declined, the ADR-EA-041 note alone still closes REC-01 |

## Open Questions

None that are user-owned: the locked CONTEXT decision records that REC-01 closes Track A, and the release-versus-write choice for ADR-EA-046 is the researcher's recommendation under Claude's discretion. For the planner and the spike plan (not the user): state the per-helper-count decision rule (A4) before measuring.

## Environment Availability

| Dependency | Required by | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| node | everything | yes | v26.13.0 | - |
| pnpm | gate scripts | yes | 11.20.0 | - |
| TypeScript (`tsc`) | `tsc -b` | yes | `Version 7.0.2+effect-tsgo.0.67.4` | - |
| vitest | tests | yes | 5.0.2 (printed by `vitest run`) | - |
| Docker + Postgres container `awthaq-p3-pg` | Postgres legs (GATE-04) | yes | `PostgreSQL 16.16 (Debian 16.16-1.pgdg13+1)`, accepting connections on `localhost:55433` | If recreated: Debian `postgres:16`, `--shm-size=1g`; never `scripts/test-pg.sh` |
| `gsd-tools` seam (`research-plan`, `package-legitimacy`) | research tooling | not used | - | No external docs were needed: every finding is in-repo; no package is installed |

**Missing dependencies with no fallback:** none.

## Validation Architecture

`.planning/config.json` contains only `workflow.use_worktrees`; `workflow.nyquist_validation` is absent, so this section is enabled.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 5.0.2 (`it.effect` from `@effect/vitest`), projects per package (`packages/*`, `examples/plugin-template`, `examples/memory-server`, `examples/sql-server`); BDD via `features/` |
| Config file | root `vitest.config.ts`, per-package `vitest.config.ts`, `tsconfig.test.json` |
| Quick run command | `npx vitest run packages/api-key/test/Contract.test.ts packages/device-authorization/test/Contract.test.ts examples/plugin-template/test/Contract.test.ts` (171 tests, about 2 s, executed) |
| Postgres run | `AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq npx vitest run packages/api-key/test/Contract.test.ts packages/device-authorization/test/Contract.test.ts examples/plugin-template/test/Contract.test.ts` (174 tests, about 13 s, executed); full: add the 16 stores' packages (`admin`, `jwt`, `organization`, `saml`, `scim`, `webhooks`) |
| Full suite command | `npx tsc -b tsconfig.json && pnpm test && pnpm test:bdd`, then the gate list in Q6 |
| Record as | "run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote)" |

### Phase Requirements to Test Map
| Req ID | Behavior | Test type | Automated command | File exists? |
|--------|----------|-----------|-------------------|--------------|
| REC-01 | ADR-EA-041 is Revision 1.7, Change History ends at 1.7, the note and alternative (e) are present, ADR-EA-046 is declared released | spec check + grep | `pnpm spec:verify:strict` (check 14 "Document Control revision is current"), `grep -n 'Revision note (1.7)' spec/decisions/041-domain-store-ports.md`, `grep -n '| Revision | 1.7 |' spec/decisions/041-domain-store-ports.md`, `grep -n 'released' .planning/README.md` | spec script exists; greps are commands |
| REC-01 | no `spec/decisions/046-*` file and no `index.yaml` row for it | static | `ls spec/decisions \| grep -c '^046'` prints 0; `grep -c 'ADR-EA-046' spec/decisions/index.yaml` prints 0 | command |
| REC-02 | `06-SPIKE.md` exists with the per-helper table, counts that match the census commands, the decision rule and a verdict line | artifact grep | `test -f .planning/phases/06-record-store-scaffolding/06-SPIKE.md && grep -c -E '^\| \((a\|b\|c\|d\|e)\)' ...` and `grep -E '^\*\*Verdict:\*\* (GO\|NO-GO)'`; the census commands in Q1 re-run and equal the recorded numbers | Wave 0 (the spike writes it) |
| REC-02 | the census is reproducible | command | the Q1 `bash` census script prints the recorded totals (16 / 16 / 0 / 5 / 2 / 10 / 2 / 11 / 4 / 10664 / 154) | command |
| REC-03 | (no-go) no scaffolding code landed | static | `git diff --name-only <phase base> HEAD -- 'packages/*/src' examples docs features` prints nothing; `.changeset/` diff empty; every changed path matches the allowlist | command |
| REC-03 | (go) helpers replace the copies; verdicts, labels, lock keys, `*Shape` unchanged | unit + contract | the contract commands above on SQLite and on Postgres, plus `git diff <base> HEAD -- 'packages/*/test/contract'` empty and the Wave 0 pin file green before and after | Wave 0 (pins) |
| REC-04 | (no-go) recorded as not pursued, with the reason | artifact grep | `grep -n 'not pursued' .planning/phases/06-record-store-scaffolding/06-SPIKE.md` and the closure note in the phase verification file; `docs/plugin-authoring.md` and `examples/plugin-template/` untouched (`git diff` empty) | written by the closure plan |
| REC-04 | (go) every `layerMemory` Ref count, label set and lock key unchanged; docs and template updated last, their tests pass | static + unit | the Wave 0 pin file (labels 154, lock keys 11, `Ref.make` table); `pnpm --filter @awthaq/example-plugin-template test`; docs diff last in `git log` order | Wave 0 (pins) |
| GATE-04 | Postgres legs for the four spike suites (and, on a go, every touched store) | integration (Postgres) | the Postgres run above: 174 passed at research time | command; record the run in `06-BASELINE.md` and at close |

### Sampling Rate
- **Per task commit:** the quick run plus `npx tsc -b tsconfig.json` (docs-only tasks: `pnpm spec:verify:strict`).
- **Per wave merge:** `pnpm test`, `pnpm test:bdd`, the Postgres run.
- **Phase gate:** every gate in Q6 at or equal to the Wave 0 baseline; on a no-go also the allowlist diff and the empty `packages/*/src` diff.

### Wave 0 Gaps
- [ ] `06-BASELINE.md` (every gate at the planning HEAD; Postgres version recorded).
- [ ] Source-scan pin file for the four spike files (label sets, `Ref.make` counts, lock-key literals); one commit, not edited afterwards (as the Phase 3-5 oracle files).
- [ ] `06-SPIKE.md` is the spike's output, not a Wave 0 input.
- Framework install: none.

## Security Domain

`security_enforcement` is not disabled in `.planning/config.json`, so this applies. The phase adds no input, endpoint or credential path; the preliminary outcome is docs-only.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard control |
|---------------|---------|-----------------|
| V2 Authentication | no | untouched (`jwt`, `api-key`, `device-authorization` stores keep their statements) |
| V3 Session Management | no | untouched |
| V4 Access Control | yes, only on a go | tenant isolation: `TenantScoped` plumbing and RLS lift stay as is; the `tenancy` cases of 13 contract suites run on SQLite and Postgres |
| V5 Input Validation | yes, only on a go | label strings are static literals, never user input; a comparator helper takes accessors, not strings |
| V6 Cryptography | yes, only on a go | `SigningKeyRecords` and `SamlRecords` sealed columns (`SealedColumn.codec`) are not touched by any of the five pieces |

### Known Threat Patterns

| Pattern | STRIDE | Standard mitigation |
|---------|--------|---------------------|
| A label helper changes `StoreUnavailable.operation` (wire-visible, 503 body) | Information disclosure / contract break | byte-identical label pin (Q4); the label never carries SQL or user input |
| A refactor drops a tenant filter from a memory twin (Webhook, Impersonation) | Information disclosure | untouched on the recommended path; if touched, the existing `tenancy` contract cases and RLS probes run on Postgres |
| `SqlStore.make` retry repeats a non-idempotent write (double rotate, lost grant) | Tampering / integrity | classify `once` per operation; or do not adopt (recommended) |

## Sources

### Primary (HIGH confidence, read or executed this session)
- `.planning/phases/06-record-store-scaffolding/06-CONTEXT.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md` (Phase 6), `.planning/STATE.md`, `.planning/README.md` (reservations, `:206`, `:341`, `:447-461`)
- `.planning/research/{ARCHITECTURE,FEATURES,SUMMARY}.md` (candidate 7), `.planning/24-memory-records-over-sqlite/PLAN.md`, `.planning/25-record-store-contract/PLAN.md`, `.planning/37-store-contract-runner/PLAN.md`
- `spec/decisions/041-domain-store-ports.md` (read in full), `spec/decisions/040-plugin-exposes-domain-services.md` (revision-note precedent), `spec/decisions/index.yaml`, `spec/scripts/check-drift.mjs` (check 14), `spec/scripts/verify-traceability.sh`, `spec/traceability.md`, `spec/behaviors/05-persistence-stratum.md:116`
- `packages/sql/src/{SqlStore,StoreFailure,TenantScoped,Models,KeysetSql}.ts`, `packages/ports/src/Keyset.ts`, `packages/api/src/Api.ts:194-198`, `packages/test/src/{RecordsContract,TestSql}.ts`
- The 16 `*Records.ts` files and the context modules named in Q1; `docs/plugin-authoring.md`; `examples/plugin-template/`; `.oxlintrc.json`; `.planning/phases/05-core-table-list-cleanup/{05-BASELINE,05-RESEARCH}.md`
- Executed: the Q1 census script, `vitest run` on SQLite (171 tests) and Postgres (174 tests), `pg_isready`, `select version()`, tool versions
- `packages/sql/node_modules/effect` 4.1.2 (`Schema.d.ts:10996`)

### Secondary (MEDIUM)
- None used (no web or Context7 lookup was needed; every claim is in-repo).

### Tertiary (LOW)
- None.

## Metadata

**Confidence breakdown:**
- Census (counts, file:line, label and closure verbatim): HIGH, commands re-run this session
- Track A record and ADR edits: HIGH, texts and check-14 regex read from source
- Line-saving estimates and the `write`/`once` classification: MEDIUM, from reading, no prototype
- Verdict: MEDIUM-HIGH (the structural reasons are measured; the executed spike decides)

**Research date:** 2026-11-14
**Valid until:** until Phase 6 plans execute or `packages/*/src/*Records.ts` change (re-run the Q1 census at planning HEAD; line numbers shift with every edit)
