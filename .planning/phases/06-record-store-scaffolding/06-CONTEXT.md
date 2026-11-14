# Phase 6: Record-store scaffolding (gated) - Context

**Gathered:** 2026-11-14
**Status:** Ready for planning

<domain>
## Phase Boundary

The repeated record-store scaffolding across the plugin `*Records` modules is consolidated only if a spike proves that enough files share a helper; otherwise the candidate is closed with a recorded no-go and no scaffolding code lands.

Two things come first and are not conditional: (1) plan 24 Track A (SQL over SQLite `:memory:` as the memory adapter) is recorded closed as an ADR-EA-041 revision note, and ADR-EA-046's fate (use or release) is decided in `spec/decisions/`; (2) a written spike on `DeviceClientRecords`, `ApiKeyClientRecords`, `ApiKeyRecords` and `DeviceGrantRecords` ends in a go/no-go, with a no-go if fewer than about 5 files share a helper.

On go: shared comparators, tenant-visibility plumbing, `unavailable(op)` labelling, a dialect wire row helper and `SqlStore.make` adoption replace the repeated scaffolding with no `*Shape` change; `RecordsContract` verdicts per operation pass unchanged; every `layerMemory` stays one `Ref<State>`; lock-key strings and operation labels stay byte-identical; `docs/plugin-authoring.md` and `examples/plugin-template/` update last and their tests pass. On no-go: REC-03 and REC-04 are recorded as not pursued with the reason written down.

Requirements: REC-01, REC-02 (always), REC-03, REC-04 (conditional on a go).

</domain>

<decisions>
## Implementation Decisions

### Track A is closed by an approved requirement (REC-01)
The user approved REQUIREMENTS.md, which (a) lists "Replacing memory twins with SQLite `:memory:`" under Out of Scope (SQLite cannot reproduce Postgres races; plan 25 and ADR-EA-041 decision 9 keep two adapters) and (b) states REC-01 as "Plan 24 Track A is recorded closed (ADR-EA-041 revision note)". The research summary's "if Track A stays alive, drop C7 from this milestone" branch was therefore already taken by the user when all 8 candidates were put in scope. This phase records that closure; it does not reopen the question. The record is a docs-only revision (reversible) and is called out in the final report so the user can veto it.

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

### Decided autonomously
- [Gate owner] Q: "Who decides Track A?" → Selected: "The approved REC-01 requirement and Out-of-Scope row already decide it; this phase only records it" — the user can veto at the final report
- [Spike shape] Q: "Is the spike a separate plan with its own artifact?" → Selected: "Yes: baseline and the ADR records first, then the spike plan writes `06-SPIKE.md` with measured counts and the go/no-go; any go-branch plans are created after the spike result, not before" — the roadmap makes REC-03/04 conditional
- [Postgres wording] Q: "Keep 'not run locally'?" → Selected: "No: run locally on the Debian image and record CI confirmation open" — consistent with Phases 3-5

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- Record stores: `packages/api-key/src/{ApiKeyClientRecords,ApiKeyRecords}.ts`, `packages/device-authorization/src/{DeviceClientRecords,DeviceGrantRecords}.ts`, `packages/jwt/src/SigningKeyRecords.ts`, `packages/webhooks/src/WebhookRecords.ts`, `packages/admin/src/ImpersonationRecords.ts`, `packages/organization/src/*Records.ts` (Active context, Connection, Invitation, Membership, Organization, OrgRole, Team), `packages/saml/src/SamlRecords.ts`, `packages/scim/src/ScimRecords.ts`.
- Substrate: `SqlStore.make` (`write`/`read`/`once`) and `SqlStore.atomically`; `StoreFailure.isUniqueViolation`; `@awthaq/test` `RecordsContract` (verdicts) and `StoreContract`; Phase 3 `Keyset`/`KeysetSql`; Phase 4 `OrganizationConnectionLifecycle` and `DomainClaims`; Phase 5 `CoreTables`.
- Docs: `docs/plugin-authoring.md`, `examples/plugin-template/` (updated last, and only on a go).
- Spec: ADR-EA-041 (decisions 5, 6, 9; alternative "differential parity harness (plan 24 Track B)" already rejected), `.planning/24-memory-records-over-sqlite/PLAN.md`, `.planning/25-record-store-contract/PLAN.md`.

### Established Patterns
- Phase process: baseline and pin matrix first, then the change, then every gate again; verbatim moves; one changeset with `Migration:`; spec Revision plus Change History bumped together.

### Integration Points
- `spec/decisions/041-domain-store-ports.md` and `index.yaml`; `packages/test/src/RecordsContract.ts`; per-package `Contract.test.ts`; `pnpm test:pg` path (use the local Debian container instead).

</code_context>

<specifics>
## Specific Ideas

The spike must also say, per helper, where it would live (module, stratum) and whether it removes code or only moves it, so the go/no-go is not decided by a raw file count alone.

</specifics>

<deferred>
## Deferred Ideas

None.

</deferred>
