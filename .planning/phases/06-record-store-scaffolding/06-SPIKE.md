# Phase 6 Spike: record-store scaffolding go/no-go

Date: 2026-11-14. Plan: `06-03-PLAN.md` (REC-02). Phase base `3be32564`. Spike head: `b0de5660412fcde882f1095513c33cec3e83bb9f` (the `SPIKE-HEAD` line in "## Verdict" repeats it for the checker). `git diff --quiet 3be32564 -- packages features examples` exits 0 at this head (no source file has changed since the phase base).

Line numbers below are valid at that sha only.

## Decision rule

Quoted verbatim from `06-CONTEXT.md` (Decided autonomously, "Go/no-go rule, stated before the spike measures", committed in `77515195` before any measurement):

> Per helper, and a helper is a go only if all three hold: (a) at least about 5 of the 16 `*Records` files carry a near-identical copy, (b) it passes the deletion test (it removes more duplicated code than it adds, or removes divergent copies of one rule), (c) adopting it is behaviour-preserving (byte-identical verdicts, operation labels, lock keys and ordering for canonical inputs, no `*Shape` change). The phase is a go if at least one helper passes; only helpers that pass are scaffolded; any other helper is recorded not pursued with its numbers

Operational reading (fixed in 06-03-PLAN.md before measurement):

- D1 "about 5" means at least 5 of the 16 files (research Q7 rule (i)).
- D2 Near-identical copy, for (a): code in a file that, for canonical inputs, computes what the helper would, differing only in identifiers, field names, direction, or the spelling of the same comparison or call. Code with different semantics is not a copy (for example a `createdAt` order with no id tie-break, where the helper has one). Count files, not sites.
- D3 Canonical inputs, for (c): the values the store's own code or its plugin's system modules mint for the compared fields. Ids minted as lowercase UUIDv7 are canonical (BEH-EA-036, `spec/behaviors/05-persistence-stratum.md:116`: "Canonical lowercase uuidV7 ids order the same by code unit and under any database collation"); a field that can hold an externally supplied string has every string as a canonical input.
- D4 Adopter set: the sites where adopting the helper is behaviour-preserving under (c). Sites outside it are not adopted and are listed with the reason. (a) is re-checked on the adopter set's files.
- D5 Deletion-test line counts, for (b): measured on the prototype (P1-P6) over the adopter files plus the helper module plus the helper's test. removed is the count of removed lines and added the count of added lines of `diff -ruN orig proto`; net = removed minus added. The first branch of (b) holds when net > 0. Test convention: one `it` case per new exported helper, with one input, added to the helper module's existing test file (`packages/ports/test/Keyset.test.ts`, `packages/sql/test/StoreFailure.test.ts`, `packages/sql/test/Models.test.ts`), plus only the imports that file lacks; each new exported helper carries exactly one one-line doc comment. A helper that already exists (`SqlStore.make`, `TenantScoped`) adds no helper or test lines.
- D6 Divergent copies of one rule, the second branch of (b): the adopter sites' copies are spelled in at least 2 different ways and each copy states the rule itself (an ordering, a predicate, a classification) rather than calling an already-shared function that states it (`StoreFailure.orStoreUnavailable`, `SqlModels.dialectFields`/`resolveDialect`, `TenantScoped.*`, `SqlStore.*`).
- D7 A helper whose (a) fails is not prototyped; its (b) and (c) are recorded as `n/e ((a) fails)`.
- D8 "Removes or moves" (CONTEXT specifics): removes when net > 0 under D5, moves otherwise.
- D9 `unavailable-label` and `sqlstore-make` replace the same per-file closure. If both pass, both are recorded as passed and a line `SPIKE-CONFLICT: unavailable-label, sqlstore-make: both replace the per-file label closure; only one can be adopted` is added for the continuation planner to resolve with the user.

This rule is CONTEXT's per-helper rule; research Q7's bundle-level reading and its preliminary verdict are not used. It is applied mechanically to the numbers measured below.

## Census

Script `census06.sh` (the plan's script, verbatim; run with `bash` from the worktree root). Its `CENSUS:` line equals the planning value, so no `packages` file changed and the script was not altered.

```bash
#!/usr/bin/env bash
# Phase 6 census over the 16 plugin *Records modules. Run with bash from the worktree root.
set -u
F16=(packages/admin/src/ImpersonationRecords.ts packages/api-key/src/ApiKeyClientRecords.ts packages/api-key/src/ApiKeyRecords.ts packages/device-authorization/src/DeviceClientRecords.ts packages/device-authorization/src/DeviceGrantRecords.ts packages/jwt/src/SigningKeyRecords.ts packages/organization/src/ActiveContextRecords.ts packages/organization/src/ConnectionRecords.ts packages/organization/src/InvitationRecords.ts packages/organization/src/MembershipRecords.ts packages/organization/src/OrganizationRecords.ts packages/organization/src/OrgRoleRecords.ts packages/organization/src/TeamRecords.ts packages/saml/src/SamlRecords.ts packages/scim/src/ScimRecords.ts packages/webhooks/src/WebhookRecords.ts)
SPIKE4=(packages/device-authorization/src/DeviceClientRecords.ts packages/api-key/src/ApiKeyClientRecords.ts packages/api-key/src/ApiKeyRecords.ts packages/device-authorization/src/DeviceGrantRecords.ts)
n() { grep -lE "$1" "${F16[@]}" | wc -l | tr -d ' '; }
CMP='toEpochMillis\((a|b)\.createdAt\)|(a|b)\.createdAt\.epochMilliseconds|millis\(a\.createdAt\)'
echo "## per file: path lines labels Ref.make closure-def-lines wire-lines comparator-lines"
for f in "${F16[@]}"; do
  d=$(awk '/const (unavailable|failing) = /{k=1; if ($0 ~ /=>[[:space:]]*$/) k=2; print k; exit}' "$f")
  echo "$f $(wc -l < "$f" | tr -d ' ') $(grep -cE '(unavailable|failing)\("' "$f") $(grep -c 'Ref\.make' "$f") ${d:-0} $(grep -c 'SqlModels\.dialectFields(' "$f") $(grep -cE "$CMP" "$f")"
done
echo "## comparator anchor lines"
grep -nE "$CMP" "${F16[@]}"
echo "## label multisets of the four spike files"
for f in "${SPIKE4[@]}"; do echo "$f: $(grep -oE '(unavailable|failing)\("[A-Za-z]+"\)' "$f" | sed -E 's/.*\("([A-Za-z]+)"\)/\1/' | sort | tr '\n' ' ')"; done
echo "CENSUS: files=${#F16[@]} lines=$(cat "${F16[@]}" | wc -l | tr -d ' ') labels=$(cat "${F16[@]}" | grep -cE '(unavailable|failing)\("') closure=$(n '(const unavailable = |const failing = )') dialectFields=$(n 'SqlModels\.dialectFields\(') make=$(n 'SqlStore\.make') atomically=$(n 'SqlStore\.atomically') matches=$(n 'TenantScoped\.matches') visibility=$(n 'TenantScoped\.visibility') lift=$(n 'TenantScoped\.(liftOn|lift)\(') keyset=$(n 'Keyset\.') comparator=$(n "$CMP") localeCompare=$(n 'localeCompare') makeRow=$(n 'const makeRow')"
```

Output, verbatim:

```text
## per file: path lines labels Ref.make closure-def-lines wire-lines comparator-lines
packages/admin/src/ImpersonationRecords.ts 784 6 2 2 1 0
packages/api-key/src/ApiKeyClientRecords.ts 272 6 1 2 1 1
packages/api-key/src/ApiKeyRecords.ts 332 7 1 2 1 1
packages/device-authorization/src/DeviceClientRecords.ts 171 4 1 2 1 1
packages/device-authorization/src/DeviceGrantRecords.ts 428 12 1 2 1 1
packages/jwt/src/SigningKeyRecords.ts 594 6 1 2 1 1
packages/organization/src/ActiveContextRecords.ts 387 5 1 2 1 0
packages/organization/src/ConnectionRecords.ts 810 7 1 2 1 1
packages/organization/src/InvitationRecords.ts 663 14 1 2 1 0
packages/organization/src/MembershipRecords.ts 748 9 1 2 1 1
packages/organization/src/OrganizationRecords.ts 475 7 1 2 1 0
packages/organization/src/OrgRoleRecords.ts 419 6 1 2 1 0
packages/organization/src/TeamRecords.ts 1375 15 1 2 1 2
packages/saml/src/SamlRecords.ts 978 14 1 2 1 2
packages/scim/src/ScimRecords.ts 822 12 1 2 1 1
packages/webhooks/src/WebhookRecords.ts 1406 24 1 1 1 1
## comparator anchor lines
packages/api-key/src/ApiKeyClientRecords.ts:79:    const byTime = DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt);
packages/api-key/src/ApiKeyRecords.ts:100:    const byTime = DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt);
packages/device-authorization/src/DeviceClientRecords.ts:57:    const byTime = DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt);
packages/device-authorization/src/DeviceGrantRecords.ts:215:              .toSorted((a, b) => millis(a.createdAt) - millis(b.createdAt)),
packages/jwt/src/SigningKeyRecords.ts:172:    (a, b) => DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt),
packages/organization/src/ConnectionRecords.ts:341:                DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt) ||
packages/organization/src/MembershipRecords.ts:199:      DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt) ||
packages/organization/src/TeamRecords.ts:367:          a.createdAt.epochMilliseconds - b.createdAt.epochMilliseconds || a.id.localeCompare(b.id),
packages/organization/src/TeamRecords.ts:471:                a.createdAt.epochMilliseconds - b.createdAt.epochMilliseconds ||
packages/saml/src/SamlRecords.ts:268:      DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt) ||
packages/saml/src/SamlRecords.ts:277:      DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt) ||
packages/scim/src/ScimRecords.ts:180:      DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt) ||
packages/webhooks/src/WebhookRecords.ts:319:      DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt) ||
## label multisets of the four spike files
packages/device-authorization/src/DeviceClientRecords.ts: findById insert list revoke 
packages/api-key/src/ApiKeyClientRecords.ts: deleteByOwner findById insert listByOwner revoke rotateSecret 
packages/api-key/src/ApiKeyRecords.ts: deleteByOwner findById insert listByOwner revoke rotate touch 
packages/device-authorization/src/DeviceGrantRecords.ts: claim consume decide deleteByUser findByDeviceHash findByUserHash insert listByUser purgeExpired raiseInterval remove touchPoll 
```

The census line, pasted verbatim (also equals the planning-HEAD value `77515195`, and a re-run at the end of Task 3 must print it again):

CENSUS: files=16 lines=10664 labels=154 closure=16 dialectFields=16 make=0 atomically=5 matches=2 visibility=2 lift=10 keyset=2 comparator=11 localeCompare=5 makeRow=4

## The four spike files

| File | Lines | Labels (count, multiset) | Comparator site and spelling | Closure def | Wire line | `Ref.make` | `SqlStore.atomically` | Table tenancy (declaration) |
|------|-------|--------------------------|------------------------------|-------------|-----------|-----------|----------------------|-----------------------------|
| DeviceClientRecords | 171 | 4: findById insert list revoke | `:55-59` `oldestFirst`, asc, `byTime !== 0 ? byTime : a.clientId < b.clientId ? -1 : ...` (code-unit tie-break on `clientId`) | `:103-104` (2 lines, `unavailable`) | `:105` verbatim | 1 | 0 | `device_authorization_client`: `Table.global` (`DeviceAuthorization.ts:703`) |
| ApiKeyClientRecords | 272 | 6: deleteByOwner findById insert listByOwner revoke rotateSecret | `:75-81` `newestFirst`, desc, `byTime = b - a`, tie `a.clientId < b.clientId ? 1 : ...` | `:164-165` (2 lines) | `:166` verbatim | 1 | 0 | `apikey_client`: `Table.global` (`ApiKey.ts:757`) |
| ApiKeyRecords | 332 | 7: deleteByOwner findById insert listByOwner revoke rotate touch | `:98-102` `newestFirst`, desc, tie `a.id < b.id ? 1 : ...` | `:206-207` (2 lines) | `:209` verbatim | 1 | 0 | `apikey_key`: `Table.global` (`ApiKey.ts:754`) |
| DeviceGrantRecords | 428 | 12: claim consume decide deleteByUser findByDeviceHash findByUserHash insert listByUser purgeExpired raiseInterval remove touchPoll | `:215` inline `.toSorted((a, b) => millis(a.createdAt) - millis(b.createdAt))`, asc, **no tie-break** (SQL `:370` `ORDER BY "createdAt" ASC, id ASC`) | `:251-252` (2 lines) | `:253` verbatim | 1 | 0 | `device_authorization_grant`: `Table.global` (`DeviceAuthorization.ts:700`) |
| Total | 1203 | 29 operations | | | | | 0 | all four global |

All four are tenant-global tables, so none carries `TenantScoped.*` (the census `matches=2`, `visibility=2` are the two tenant-scoped modules, see "(a) Count per helper").

## (a) Count per helper

D1 threshold: at least 5 of the 16 files.

### comparators: 9 files carry a near-identical copy: pass

The 13 anchor lines (11 files) plus the sort sites the census anchors do not match were each read in full. Classification:

| Site | Direction | Spelling | Tie-break | Copy per D2 |
|------|-----------|----------|-----------|-------------|
| DeviceClientRecords:55-59 | asc | `toEpochMillis` subtraction, `!== 0 ? : <` chain | `clientId`, code unit | yes |
| ApiKeyClientRecords:75-81 | desc | same, `b - a`, chain flipped | `clientId`, code unit | yes |
| ApiKeyRecords:98-102 | desc | same | `id`, code unit | yes |
| ConnectionRecords:339-343 | asc | `toEpochMillis` subtraction `\|\|` `a.id.localeCompare(b.id)` | `id`, locale | yes |
| MembershipRecords:192-203 | asc, `.reverse()` for desc | subtraction `\|\|` `<` chain | `id`, code unit | yes |
| TeamRecords:364-368 | asc | `.epochMilliseconds` subtraction `\|\|` `localeCompare` | `id`, locale | yes |
| TeamRecords:469-473 | asc | `.epochMilliseconds` subtraction `\|\|` `<` chain | `id`, code unit | yes (same file) |
| SamlRecords:265-270 | asc | subtraction `\|\|` `localeCompare` | `id`, locale | yes |
| SamlRecords:272-279 | desc | `b - a` `\|\|` `b.id.localeCompare(a.id)` | `id`, locale | yes (same file) |
| ScimRecords:174-182 | asc | subtraction `\|\|` `tieBreak(a).localeCompare(tieBreak(b))` | caller's `row.id` / `row.resourceId` / `row.connectionId`, locale | yes |
| WebhookRecords:314-321 | asc | subtraction `\|\|` `a.id.localeCompare(b.id)` | `id`, locale | yes |
| DeviceGrantRecords:215 | asc | inline subtraction | none | **no**: different semantics (no tie-break) |
| SigningKeyRecords:168-173 | desc | `b - a` | none (SQL also `ORDER BY "createdAt" DESC` only, `:467`, `:477`) | **no**: different semantics (no tie-break) |

Files with a copy: DeviceClientRecords, ApiKeyClientRecords, ApiKeyRecords, ConnectionRecords, MembershipRecords, TeamRecords, SamlRecords, ScimRecords, WebhookRecords = 9. 9 >= 5: pass.

Sort sites outside the 13 census anchors (read, not counted as copies and not adopted): `WebhookRecords.ts:555-558` (`nextAttemptAt` then `id.localeCompare`, a due-delivery lease order: same shape on another field, in a file already counted), `WebhookRecords.ts:796` (`b.id.localeCompare(a.id)`, id only, no time key), `ImpersonationRecords.ts:249-254` `closeOrder` (`endedAt` with `None` read as `0`, then `<` on id: a different key and a null rule), `SigningKeyRecords.ts:191` (a tuple sort on a key id, no time key).

### tenant-visibility: 2 files: fail

`TenantScoped.matches` or `TenantScoped.visibility` appears in `ImpersonationRecords.ts` and `WebhookRecords.ts` only (census `matches=2`, `visibility=2`; a `grep -c tenantId` over the 16 files finds `tenantId` in only those two). The candidate is not a new helper: `TenantScoped.visibility/matches/predicate/stamp/lift/liftOn` exists in `@awthaq/sql` and the 10 files that touch tenancy (census `lift=10`) already call it. The other 14 files have no tenant column in memory. 2 < 5: fail.

### unavailable-label: 16 files: pass

Every file defines the same closure: 15 files `const unavailable = (operation: string) => StoreFailure.orStoreUnavailable(\`<Store>.${operation}\`);` over 2 lines, `WebhookRecords.ts:1137` the one-line `const failing = (method: string) => ...` (only a name differs; closure=16, closure-def-lines 2 x 15 + 1). 156 call sites (154 `("literal")` plus two `unavailable(operation)` in `ActiveContextRecords.ts:308,325`). 16 >= 5: pass.

### wire-row: 16 files carry the wire value, 14 are adoptable: pass

`SqlModels.dialectFields(yield* SqlModels.resolveDialect(sql))` verbatim in 14 files; the same value in 2 variant files that bind `const dialect = yield* SqlModels.resolveDialect(sql); const wire = SqlModels.dialectFields(dialect);` (`SamlRecords.ts:644-645`, `WebhookRecords.ts:911-912`). In both variants `dialect` has another use (`dialect === "pg" ? DateTime.toDate(instant) : DateTime.formatIso(instant)` at `SamlRecords.ts:647` and `WebhookRecords.ts:915`, and `WebhookRecords.ts:1311`), so they are not adopted. Copies: 16, adopter set 14. 14 >= 5: pass. The row-to-record mapping (`makeRow`, 4 census files with `const makeRow`, plus each module's `toRecord`) has 0 near-identical copies: each file's column set and domain decoding differ (for example `Users.UserId(row.ownerId)`, `Option.fromNullishOr(row.revokedAt)`, sealed columns), so there is no shared candidate.

### sqlstore-make: 16 files carry the closure it would replace, 0 call it: pass

The closure it replaces is the unavailable-label closure (16 files). `SqlStore.make` is called by 0 of the 16 files (census `make=0`); `SqlStore.atomically` by 5 (census `atomically=5`: MembershipRecords, InvitationRecords, OrgRoleRecords, TeamRecords, WebhookRecords, which are lock-key users and stay untouched). 16 >= 5: pass.

### `Ref.make` per module (frozen if a go branch edits a module)

| Module | `Ref.make` | Other state |
|--------|-----------|-------------|
| ImpersonationRecords | 2 (`state` `:319`, `ledger` `:320`) | `Semaphore.make(1)` `appendLock` `:321` (`grep -c 'Semaphore'` prints 2: the import and the make) |
| ApiKeyClientRecords | 1 | |
| ApiKeyRecords | 1 | |
| DeviceClientRecords | 1 | |
| DeviceGrantRecords | 1 | |
| SigningKeyRecords | 1 | |
| ActiveContextRecords | 1 | |
| ConnectionRecords | 1 | |
| InvitationRecords | 1 | |
| MembershipRecords | 1 | |
| OrganizationRecords | 1 | |
| OrgRoleRecords | 1 | |
| TeamRecords | 1 | |
| SamlRecords | 1 | |
| ScimRecords | 1 | |
| WebhookRecords | 1 | |

## Measurements

_Filled by Task 2._

## Findings

F1. `DeviceGrantRecords.listByUser` tie drift. The memory adapter sorts `HashMap.toValues` by `createdAt` alone (`packages/device-authorization/src/DeviceGrantRecords.ts:213-215`: `.toSorted((a, b) => millis(a.createdAt) - millis(b.createdAt))`, no tie-break), while the SQL adapter orders by `ORDER BY "createdAt" ASC, id ASC` (`:370`). Two grants with an equal `createdAt` can therefore come back in a different order on memory (the iteration order of the hash map, which is not specified) and SQL (by id). The contract does not pin it: `packages/device-authorization/test/contract/DeviceGrantRecords.ts:427-453` has one `listByUser` read case whose two rows differ in `createdAt` (`early` 910000 < `late` 950000), no equal-time case. Recorded as a finding, not fixed in this phase: giving the memory sort an id tie-break is a deliberate behaviour change (it fixes a latent adapter difference), outside a behaviour-preserving adoption. The comparator helper, if adopted here, would have changed this site; it is therefore excluded from the adopter set.

F2. `SigningKeyRecords.newestFirst` has no tie-break on either side: memory `:168-173` sorts `createdAt` descending only and the SQL statements order `"createdAt" DESC` only (`:467` `... ORDER BY "createdAt" DESC LIMIT 1`, `:477` `ORDER BY "createdAt" DESC`). Both adapters are consistent in leaving ties unspecified, so nothing drifts; it is not a copy of the comparator rule (D2) and is left alone.

## Verdict table

_Filled by Task 3._

## Verdict

_Filled by Task 3._

## Continuation input

_Filled by Task 3._
