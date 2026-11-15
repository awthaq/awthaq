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

Every file defines the same closure: 15 files ``const unavailable = (operation: string) => StoreFailure.orStoreUnavailable(`<Store>.${operation}`);`` over 2 lines, `WebhookRecords.ts:1137` the one-line `const failing = (method: string) => ...` (only a name differs; closure=16, closure-def-lines 2 x 15 + 1). 156 call sites (154 `("literal")` plus two `unavailable(operation)` in `ActiveContextRecords.ts:308,325`). 16 >= 5: pass.

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

Method (plan protocol P1-P6): each prototype lived under the session scratchpad (`proto-06/<helper id>/{orig,proto}`), was formatted with `npx oxfmt` run from the worktree root, and was counted with `diff -ruN orig proto | grep -cE '^-([^-]|$)'` (removed) and `'^\+([^+]|$)'` (added); no type-check was run (P5). Test convention (D5): one `it` case with one input, placed in an existing `describe` of the helper module's existing test file, one one-line doc comment per new helper. The prototype is deleted at the end of this task (see "Prototype discard").

Sensitivity of the convention: the test case is the only free layout choice. A test case wrapped in a `describe` block of its own costs 2 more lines (measured for unavailable-label: net -1 instead of +1); this is reported again under that helper because it flips its sign.

### comparators

Lives in: `packages/ports/src/Keyset.ts` (additive export `Keyset.chronological`, no new module), `@awthaq/ports`, stratum 2 (every adopter package already depends on `@awthaq/ports`).

Interface used by the prototype:

```ts
/** The `(createdAt, id)` order of a record listing, ids by code unit; `desc` is its flip. */
export const chronological = <Row>(spec: {
  readonly createdAt: (row: Row) => DateTime.Utc;
  readonly id: (row: Row) => string;
  readonly direction: Direction;
}): Order.Order<Row> => {
  const asc = Order.combine(
    Order.mapInput(DateTime.Order, spec.createdAt),
    Order.mapInput(Order.String, spec.id),
  );
  return spec.direction === "desc" ? Order.flip(asc) : asc;
};
```

(c) first, per site (D3, D4). Installed `effect` 4.1.2 (`packages/ports/node_modules/effect/dist`): `Order.make` returns `self === that ? 0 : compare(self, that)` (`Order.js:52`); `Order.String` is `make((self, that) => self < that ? -1 : 1)` (`Order.js:83`), the code-unit order; `Order.flip(O)` is `make((self, that) => O(that, self))` (`Order.js:208`); `Order.combine` returns the first non-zero result (`Order.js:254`); `Order.mapInput` applies the projection to both operands (`Order.js:381`); `DateTime.Order` compares `epochMilliseconds` with `<` and `>` (`internal/dateTime.js:174`). For finite epoch milliseconds the sign of that comparison equals the sign of the sites' `toEpochMillis(a) - toEpochMillis(b)` (and of `a.createdAt.epochMilliseconds - b.createdAt.epochMilliseconds`), so the combined order has the same sign as each site's comparator when the tie-break compares the same way. `MembershipRecords.applySort` sorts ascending and `.reverse()`s for `desc`; ids are primary keys, hence unique, so `(createdAt, id)` is a total order with no equal elements and the reverse of its sort equals the sort by the flipped order.

| Site | Tie-break field and where its value is minted | Today's tie-break | Helper's | D3 class | (c) |
|------|-----------------------------------------------|-------------------|----------|----------|-----|
| DeviceClientRecords `clientId` | `` input.clientId ?? `dc_${yield* random.uuidV7()}` `` (`DeviceAuthorization.ts:809`); may be operator-supplied | code unit (`<`) | code unit | any string is canonical | identical for every string |
| ApiKeyClientRecords `clientId` | `` `svc_${yield* random.uuidV7()}` `` (`ApiKey.ts:1016`) | code unit | code unit | canonical | identical for every string |
| ApiKeyRecords `id` | `random.uuidV7()` (`ApiKey.ts:859`) | code unit | code unit | canonical | identical for every string |
| MembershipRecords `id` | `random.uuidV7()` (`MembershipRecords.ts:242`, `:560`) | code unit | code unit | canonical | identical for every string |
| TeamRecords `id` (`:469`) | `random.uuidV7()` (`TeamRecords.ts:302`) | code unit | code unit | canonical | identical for every string |
| TeamRecords `id` (`:364`) | same | `localeCompare` | code unit | canonical | same sign (probe: 0 of 20000 differ) |
| ConnectionRecords `id` | `random.uuidV7()` (`OrganizationConnections.ts:433`) | `localeCompare` | code unit | canonical | same sign |
| SamlRecords connection `id` | `random.uuidV7()` (`SamlConnections.ts:355`) | `localeCompare` | code unit | canonical | same sign |
| SamlRecords sp-key `id` | `random.uuidV7()` (`SamlSpKeys.ts:97`) | `localeCompare` | code unit | canonical | same sign |
| ScimRecords `row.id` (connections) | `random.uuidV7()` (`ScimConnections.ts:94`) | `localeCompare` | code unit | canonical | same sign |
| ScimRecords `row.resourceId` (links) | the linked user or team id: `user.id` (`Scim.ts:987`, minted by core `Users.ts:598` with `uuidV7`), `made.id` (`Scim.ts:1381`, `TeamRecords.ts:302`) | `localeCompare` | code unit | canonical, but minted by core and organization, not by the scim plugin | same sign |
| ScimRecords `row.connectionId` (links) | the scim connection id, as above | `localeCompare` | code unit | canonical | same sign |
| WebhookRecords `id` (endpoints, deliveries) | `random.uuidV7()` (`Webhooks.ts:602`, `WebhookDelivery.ts:119`) | `localeCompare` | code unit | canonical | same sign |

Adopter set (D4): all 11 sites of the 9 files above (13 census anchors minus the 2 no-tie-break sites, `DeviceGrantRecords:215` and `SigningKeyRecords:168-173`). No `localeCompare` site's tie-break field can hold an externally supplied string, so none leaves the set. Not adopted: `DeviceGrantRecords:215` (no tie-break: adopting would add one, a behaviour change, finding F1), `SigningKeyRecords:168-173` (no tie-break, finding F2), and the four sort sites listed under (a) (other keys). (a) re-checked on the adopter set: still 9 files.

Collation probe (`probe-collation.mjs`, run with node; it prints the canonical-uuidv7 mismatch line, then four non-canonical pairs with both signs, then the collator locale):

```text
canonical-uuidv7 mismatches: 0 of 20000
pair ("B", "a"): localeCompare=1 codeUnit=-1
pair ("Z", "a"): localeCompare=1 codeUnit=-1
pair ("A1DE5995-C372-7CB4-B57B-49E3AC5F6C8A", "a1de5995-c372-7cb4-b57b-49e3ac5f6c8a"): localeCompare=1 codeUnit=-1
pair ("a-b", "ab"): localeCompare=-1 codeUnit=-1
en-US
```

Canonical lowercase UUIDv7 pairs order identically by `localeCompare` and by code unit (0 of 20000 differ on this ICU, locale `en-US`); mixed-case and punctuation pairs do not. So the helper preserves canonical ordering exactly, and would change `localeCompare` sites only for a non-canonical id, which no site's own code can mint (BEH-EA-036 states the same equivalence).

Prototype (adopters: the 9 files, 11 sites; the helper in the proto `Keyset.ts` with the added `DateTime` import; one `it` in the proto `Keyset.test.ts`, which already imports `DateTime`, `Option` and `Order`). Named functions and their callers were kept; only the comparator at each site changed.

| File | removed | added |
|------|---------|-------|
| `packages/api-key/src/ApiKeyClientRecords.ts` | 5 | 8 |
| `packages/api-key/src/ApiKeyRecords.ts` | 5 | 8 |
| `packages/device-authorization/src/DeviceClientRecords.ts` | 4 | 8 |
| `packages/organization/src/ConnectionRecords.ts` | 4 | 6 |
| `packages/organization/src/MembershipRecords.ts` | 5 | 7 |
| `packages/organization/src/TeamRecords.ts` (2 sites) | 6 | 11 |
| `packages/saml/src/SamlRecords.ts` (2 sites) | 7 | 11 |
| `packages/scim/src/ScimRecords.ts` | 4 | 6 |
| `packages/webhooks/src/WebhookRecords.ts` | 4 | 6 |
| `packages/ports/src/Keyset.ts` (helper) | 0 | 14 |
| `packages/ports/test/Keyset.test.ts` (one `it`) | 0 | 18 |
| Total | 44 | 103 |

removed=44 added=103 net=-59. One adopted site (`MembershipRecords.applySort`) after the change:

```ts
  const direction = input?.sortDirection ?? "asc";
  return [...records].sort(
    Keyset.chronological({
      createdAt: (record: MembershipRecord) => record.createdAt,
      id: (record) => record.id,
      direction,
    }),
  );
```

(b): first branch fails (net -59: each site still spells its `createdAt` and `id` selectors, which costs more lines than the comparator body it replaces). Second branch (D6): the 11 sites are spelled three ways: a `byTime !== 0 ? byTime : a.x < b.x ? -1 : ...` ternary chain (DeviceClient, ApiKeyClient, ApiKey), `||` then a `<` chain (Membership, Team `:469`), and `||` then `localeCompare` (Connection, Team `:364`, Saml x2, Scim, Webhook); plus `.reverse()` for descending (Membership) and `epochMilliseconds` against `toEpochMillis` as the time read. Each states the ordering itself and none calls a shared function. The `<` chains and the `localeCompare` calls are not even the same rule off the canonical ids (probe above), so these are divergent copies of one rule: second branch holds, (b) passes by that branch. Divergent copies: yes. Removes or moves (D8): moves (net -59: adds more lines than it removes).

(c): holds (table above). Verdict for the rule: (a) 9 files pass, (b) pass via divergent copies (net -59, thin in the sense that the line count alone says no), (c) pass.

### tenant-visibility

Lives in: none new; `TenantScoped.visibility/matches/predicate/stamp/lift/liftOn` already exist in `packages/sql/src/TenantScoped.ts`, `@awthaq/sql`, stratum 3, and already are the shared helper (10 files call it). (a) fails (2 files, `ImpersonationRecords` and `WebhookRecords`), so by D7: (b) `n/e ((a) fails)`, (c) `n/e ((a) fails)`, adopter set none, removed/added/net `n/e`, divergent copies `n/e`, removes or moves `n/e`.

### unavailable-label

Lives in: `packages/sql/src/StoreFailure.ts` (additive export `StoreFailure.labelled`), `@awthaq/sql`, stratum 3 (every plugin that owns a `*Records` file already imports `@awthaq/sql`).

Interface used by the prototype:

```ts
/** `orStoreUnavailable` for one store: `labelled("Store")("op")` names the operation `Store.op`. */
export const labelled = (store: string) => (operation: string) =>
  orStoreUnavailable(`${store}.${operation}`);
```

Adopter set: all 16 files, one closure each. Adopted site (`DeviceClientRecords`; call sites unchanged):

```ts
    const unavailable = StoreFailure.labelled("DeviceClientRecords");
```

In `WebhookRecords` the bound name stays `failing`, in `ActiveContextRecords` the two `unavailable(operation)` calls (`:308`, `:325`) are unchanged.

| File | removed | added |
|------|---------|-------|
| 15 `*Records.ts` files (the two-line closure becomes one line) | 2 each (30) | 1 each (15) |
| `packages/webhooks/src/WebhookRecords.ts` (one line to one line) | 1 | 1 |
| `packages/sql/src/StoreFailure.ts` (helper) | 0 | 4 |
| `packages/sql/test/StoreFailure.test.ts` (one `it` inside the existing `describe("StoreFailure.orStoreUnavailable")`) | 0 | 10 |
| Total | 31 | 30 |

removed=31 added=30 net=1. Sensitivity: the first prototype put the test in a `describe` of its own (12 added lines) and measured removed=31 added=32 net=-1. Under D5's convention (an `it` case, no new `describe`) the measured value is net=+1, and that is the value the rule uses, but the sign depends on two test lines.

(b): first branch holds with net=+1 (one line). Divergent copies: no (the 16 closures differ only in names: the store name, `unavailable` against `failing`, `operation` against `method`, and each calls the shared `StoreFailure.orStoreUnavailable`, so D6 does not hold). Removes or moves (D8): removes (net=1), by one line.

(c): `labelled(store)(operation)` builds the label by the same template `<Store>.<operation>` and hands it to the same `orStoreUnavailable` (`StoreFailure.ts:91-96`), so every `StoreUnavailable.operation` string, the defect paths and the logging are byte-identical; the returned function keeps `orStoreUnavailable`'s own generic signature, so no call site's inferred `E` changes. Holds.

Verdict for the rule: (a) 16 pass, (b) pass by net=+1 (thin: one line, and two test lines would flip it), (c) pass.

### wire-row

Lives in: `packages/sql/src/Models.ts` (additive export `Models.wireOf`, beside `resolveDialect` at `:207`), `@awthaq/sql`, stratum 3.

Interface used by the prototype:

```ts
/** The wire codecs of the client's own dialect: `dialectFields` of `resolveDialect`. */
export const wireOf = (sql: SqlClient.SqlClient) => Effect.map(resolveDialect(sql), dialectFields);
```

Adopter set: the 14 files with the verbatim line; `SamlRecords` and `WebhookRecords` are not adopted (their `dialect` binding has another use, see (a)). Adopted site (one line to one line):

```ts
    const wire = yield* SqlModels.wireOf(sql);
```

| File | removed | added |
|------|---------|-------|
| 14 `*Records.ts` files | 1 each (14) | 1 each (14) |
| `packages/sql/src/Models.ts` (helper) | 0 | 3 |
| `packages/sql/test/Models.test.ts` (one `it.effect` with a stub client) | 0 | 7 |
| Total | 14 | 24 |

removed=14 added=24 net=-10. (b): first branch fails (net -10); second branch fails (the 14 adopter copies are one spelling, and each calls the shared `dialectFields` and `resolveDialect`, D6). Divergent copies: no. Removes or moves (D8): moves. The row-to-record mapping has no shared candidate (see (a)). (c): holds: `Effect.map(resolveDialect(sql), dialectFields)` yields the same value as `dialectFields(yield* resolveDialect(sql))`, and the layer reads the dialect at the same point (layer construction). Verdict for the rule: (a) 14 pass, (b) fail, (c) pass.

### sqlstore-make

Lives in: `packages/sql/src/SqlStore.ts` (exists: `SqlStore.make(sql)` returns `{ write, read, once: read }` at `:82-109`), `@awthaq/sql`, stratum 3. No helper and no test lines (D5).

(c) first. `read(operation)` is `orStoreUnavailable(operation)(options?.capture === true ? ReadRouting.captureTokenOn(sql)(self) : self)` (`SqlStore.ts:102-107`) and `once` is the same function (`:109`). With no `options`, `read(operation)(self)` is exactly `StoreFailure.orStoreUnavailable(operation)(self)` (`StoreFailure.ts:91-96`), which is what `unavailable(operation)` is today: the same `StoreUnavailable.operation` string when the relabelled string equals today's, the same defect paths (a `SchemaError` or a `RETURNING` that returned no row dies, a refused statement is a defect), no retry, and nothing logged or traced differently (the one `Effect.logWarning`/`logError` is inside `storeUnavailable`, shared). Only `write` adds behaviour: `retryTransient()` when not inside a transaction (`:87-95`). So adopting `write` for any operation is a behaviour change (a transient failure is retried at the top level); the behaviour-preserving variant uses `read` and `once` only, which makes the helper a rename of `unavailable` with a prefix moved into the call sites. (c) holds for that variant, for every adopter.

Idempotency classification of the 29 operations of the four spike files, from each `layerSql` statement (the table whose rows start `| <Store>.<operation> |`; "contract" is the kind of case the operation's `RecordsContract` stanza uses):

| Operation | Statement shape | Class | Reason |
|-----------|-----------------|-------|--------|
| DeviceClientRecords.insert | `INSERT ... ON CONFLICT DO NOTHING RETURNING "clientId"` (contract atomic, race) | once | a repetition after a lost acknowledgement answers `false`, not the first call's `true` |
| DeviceClientRecords.findById | `SELECT * ... WHERE "clientId" =` | read | no write |
| DeviceClientRecords.list | `SELECT * ... ORDER BY "createdAt" ASC, "clientId" ASC` | read | no write |
| DeviceClientRecords.revoke | `UPDATE ... SET "revokedAt" WHERE ... "revokedAt" IS NULL RETURNING` (atomic, race) | once | the repetition answers `false` |
| ApiKeyClientRecords.insert | `INSERT` without `ON CONFLICT`, unique violation becomes a defect | once | a repetition hits the primary key and dies |
| ApiKeyClientRecords.findById | `SELECT * ... WHERE "clientId" =` | read | no write |
| ApiKeyClientRecords.listByOwner | `SELECT * ... ORDER BY "createdAt" DESC, "clientId" DESC` | read | no write |
| ApiKeyClientRecords.revoke | `UPDATE ... WHERE "revokedAt" IS NULL RETURNING` (atomic, race) | once | the repetition answers `false` |
| ApiKeyClientRecords.rotateSecret | one `UPDATE` moving `"secretHash"` to `"previousSecretHash"` | once | a repetition copies the new hash into `previous`, losing the earlier previous hash |
| ApiKeyClientRecords.deleteByOwner | `DELETE ... WHERE "ownerId" =` (void) | write | repeat-safe: the second delete finds nothing and the answer is `void` |
| ApiKeyRecords.insert | `INSERT` without `ON CONFLICT`, unique violation becomes a defect | once | a repetition dies on the primary key |
| ApiKeyRecords.findById | `SELECT * ... WHERE id =` | read | no write |
| ApiKeyRecords.listByOwner | `SELECT * ... ORDER BY "createdAt" DESC, id DESC` | read | no write |
| ApiKeyRecords.revoke | `UPDATE ... WHERE id = AND "revokedAt" IS NULL RETURNING id` (atomic, race) | once | the repetition answers `false` |
| ApiKeyRecords.rotate | transaction: conditional `UPDATE` capping the predecessor, then `INSERT` of the successor (atomic, race) | once | a repetition inserts the successor again (primary key) or answers `notLive` |
| ApiKeyRecords.touch | `UPDATE ... SET "lastUsedAt" = ${at}` (void) | write | sets the same value; repeat-safe |
| ApiKeyRecords.deleteByOwner | `DELETE ... WHERE "ownerId" =` (void) | write | repeat-safe |
| DeviceGrantRecords.insert | `INSERT ... ON CONFLICT DO NOTHING RETURNING id` (atomic, race) | once | the repetition answers `false` |
| DeviceGrantRecords.findByDeviceHash | `SELECT * ... WHERE "deviceCodeHash" =` | read | no write |
| DeviceGrantRecords.findByUserHash | `SELECT * ... WHERE "userCodeHash" =` | read | no write |
| DeviceGrantRecords.claim | `UPDATE ... SET "userId" WHERE status = 'pending' AND "userId" IS NULL RETURNING id` (atomic, race) | once | compare-and-swap; the repetition answers `false` |
| DeviceGrantRecords.decide | `UPDATE ... SET status, amr WHERE status = 'pending' AND ... RETURNING id` (atomic, race) | once | compare-and-swap; the repetition answers `false` |
| DeviceGrantRecords.touchPoll | `UPDATE ... SET "lastPolledAt" = ${now}` (void) | write | sets the same value; repeat-safe |
| DeviceGrantRecords.raiseInterval | `UPDATE ... SET "pollInterval" = "pollInterval" + ${seconds}` (atomic, race) | once | a repetition adds the seconds twice |
| DeviceGrantRecords.consume | `DELETE ... WHERE status = 'approved' ... RETURNING *` (atomic, race) | once | the redemption answer `Some` is lost on a repetition (`None`) |
| DeviceGrantRecords.remove | `DELETE ... WHERE id =` (void) | write | repeat-safe |
| DeviceGrantRecords.purgeExpired | `DELETE ... WHERE "expiresAt" < ${before} RETURNING id`, answer is the row count | once | a repetition answers `0` |
| DeviceGrantRecords.listByUser | `SELECT * ... ORDER BY "createdAt" ASC, id ASC` | read | no write |
| DeviceGrantRecords.deleteByUser | `DELETE ... WHERE "userId" =` (void) | write | repeat-safe |

Totals: 9 read, 6 write, 14 once. Only the 6 `write` operations would gain a retry if `write` were used, which is a behaviour change (and is why the variant measured here relabels them `once`).

Prototype (variant of `read` and `once` only; adopters: all 16 files): each two-line closure becomes `const { read, once } = SqlStore.make(sql);`, each `unavailable("op")` / `failing("op")` becomes `once("<Store>.op")` or `read("<Store>.op")` (the four spike files by the table, `find`/`list`/`get`/`count` names read and the rest once elsewhere), and `SqlStore` is added to the `@awthaq/sql` import where absent (11 files; the other five already import it). The relabelled call is longer than the one it replaces (the store name moves into the string), so oxfmt re-wraps lines and the "same length" assumption of the plan does not hold; this is part of the measured result. `SamlRecords` also grows its import from one line to a wrapped block.

| File | removed | added |
|------|---------|-------|
| `packages/admin/src/ImpersonationRecords.ts` | 9 | 11 |
| `packages/api-key/src/ApiKeyClientRecords.ts` | 9 | 12 |
| `packages/api-key/src/ApiKeyRecords.ts` | 10 | 10 |
| `packages/device-authorization/src/DeviceClientRecords.ts` | 7 | 12 |
| `packages/device-authorization/src/DeviceGrantRecords.ts` | 15 | 24 |
| `packages/jwt/src/SigningKeyRecords.ts` | 9 | 11 |
| `packages/organization/src/ActiveContextRecords.ts` | 10 | 9 |
| `packages/organization/src/ConnectionRecords.ts` | 10 | 19 |
| `packages/organization/src/InvitationRecords.ts` | 16 | 21 |
| `packages/organization/src/MembershipRecords.ts` | 11 | 10 |
| `packages/organization/src/OrganizationRecords.ts` | 10 | 15 |
| `packages/organization/src/OrgRoleRecords.ts` | 8 | 7 |
| `packages/organization/src/TeamRecords.ts` | 17 | 16 |
| `packages/saml/src/SamlRecords.ts` | 17 | 25 |
| `packages/scim/src/ScimRecords.ts` | 15 | 14 |
| `packages/webhooks/src/WebhookRecords.ts` | 25 | 31 |
| Total | 198 | 247 |

removed=198 added=247 net=-49. One adopted site (`DeviceClientRecords`):

```ts
    const { read, once } = SqlStore.make(sql);
    ...
        }).pipe(Effect.map(Option.isSome), once("DeviceClientRecords.insert")),
```

(b): first branch fails (net -49); second branch fails (the 16 copies differ only in names, each calls the shared `StoreFailure.orStoreUnavailable`, D6). Divergent copies: no. Removes or moves (D8): moves. (c) holds for the `read`/`once` variant. Verdict for the rule: (a) 16 pass, (b) fail, (c) pass.

D9: `sqlstore-make` does not pass, so `unavailable-label` is the only helper on the label closure and there is no conflict.

### Prototype discard

`rm -rf` of the prototype directory was run after the numbers above were pasted; `test ! -e` on it is recorded in the Task 2 commit verification, and `git status --porcelain -- packages features examples docs spec .changeset` prints nothing.

## Findings

F1. `DeviceGrantRecords.listByUser` tie drift. The memory adapter sorts `HashMap.toValues` by `createdAt` alone (`packages/device-authorization/src/DeviceGrantRecords.ts:213-215`: `.toSorted((a, b) => millis(a.createdAt) - millis(b.createdAt))`, no tie-break), while the SQL adapter orders by `ORDER BY "createdAt" ASC, id ASC` (`:370`). Two grants with an equal `createdAt` can therefore come back in a different order on memory (the iteration order of the hash map, which is not specified) and SQL (by id). The contract does not pin it: `packages/device-authorization/test/contract/DeviceGrantRecords.ts:427-453` has one `listByUser` read case whose two rows differ in `createdAt` (`early` 910000 < `late` 950000), no equal-time case. Recorded as a finding, not fixed in this phase: giving the memory sort an id tie-break is a deliberate behaviour change (it fixes a latent adapter difference), outside a behaviour-preserving adoption. The comparator helper, if adopted here, would have changed this site; it is therefore excluded from the adopter set.

F2. `SigningKeyRecords.newestFirst` has no tie-break on either side: memory `:168-173` sorts `createdAt` descending only and the SQL statements order `"createdAt" DESC` only (`:467` `... ORDER BY "createdAt" DESC LIMIT 1`, `:477` `ORDER BY "createdAt" DESC`). Both adapters are consistent in leaving ties unspecified, so nothing drifts; it is not a copy of the comparator rule (D2) and is left alone.

## Verdict table

The CONTEXT rule applied mechanically with D1-D9 to the numbers above; nothing the rule does not name was weighed (not the research's preliminary verdict, not the size of the saving).

| Helper | (a) files (adopter files) | (b) removed / added / net; divergent copies | (c) | Lives in (module, stratum) | Removes or moves | Verdict |
|--------|---------------------------|---------------------------------------------|-----|----------------------------|------------------|---------|
| comparators | 9 of 16 (9) | 44 / 103 / -59; divergent yes (3 spellings: ternary chain, `\|\|` + `<`, `\|\|` + `localeCompare`): holds by the second branch only | pass (0 of 20000 canonical UUIDv7 pairs differ; all tie-break fields minted) | `packages/ports/src/Keyset.ts`, `@awthaq/ports`, stratum 2 | moves (net -59) | pass |
| tenant-visibility | 2 of 16 (n/e) | n/e ((a) fails) | n/e ((a) fails) | `packages/sql/src/TenantScoped.ts` (exists), `@awthaq/sql`, stratum 3 | n/e | not pursued |
| unavailable-label | 16 of 16 (16) | 31 / 30 / +1; divergent no: holds by the first branch, by one line | pass | `packages/sql/src/StoreFailure.ts`, `@awthaq/sql`, stratum 3 | removes (net +1) | pass |
| wire-row | 16 of 16 (14) | 14 / 24 / -10; divergent no (one spelling): fails both branches | pass | `packages/sql/src/Models.ts`, `@awthaq/sql`, stratum 3 | moves (net -10) | not pursued |
| sqlstore-make | 16 of 16 (16) | 198 / 247 / -49; divergent no: fails both branches | pass (`read`/`once` variant only) | `packages/sql/src/SqlStore.ts` (exists), `@awthaq/sql`, stratum 3 | moves (net -49) | not pursued |

Margins, stated as measured: `comparators` passes (b) only through the divergent-copies branch (by line count it adds 59 lines more than it removes); `unavailable-label` passes (b) by a net of one line, and a test case wrapped in its own `describe` (2 more lines) would make it net -1 and fail. Neither margin was adjusted to reach the verdict.

## Verdict

The phase is a go: two helpers, comparators and unavailable-label, pass all three criteria, and the rule needs one. The other three are not pursued.

REC-02 result: met. The spike on DeviceClientRecords, ApiKeyClientRecords, ApiKeyRecords and DeviceGrantRecords, with the 16-file census, yields go (the call ROADMAP success criterion 2 asks for is written, measured and not a no-go: the fewer-than-about-5-files no-go does not apply to the two helpers that pass, which are carried by 9 and 16 files).

SPIKE-HEAD: b0de5660412fcde882f1095513c33cec3e83bb9f
SPIKE-VERDICT: go
SPIKE-PASSED: comparators, unavailable-label
SPIKE-ADOPTERS comparators: packages/device-authorization/src/DeviceClientRecords.ts, packages/api-key/src/ApiKeyClientRecords.ts, packages/api-key/src/ApiKeyRecords.ts, packages/organization/src/ConnectionRecords.ts, packages/organization/src/MembershipRecords.ts, packages/organization/src/TeamRecords.ts, packages/saml/src/SamlRecords.ts, packages/scim/src/ScimRecords.ts, packages/webhooks/src/WebhookRecords.ts
SPIKE-DELTA comparators: removed=44 added=103 net=-59
SPIKE-ADOPTERS unavailable-label: packages/admin/src/ImpersonationRecords.ts, packages/api-key/src/ApiKeyClientRecords.ts, packages/api-key/src/ApiKeyRecords.ts, packages/device-authorization/src/DeviceClientRecords.ts, packages/device-authorization/src/DeviceGrantRecords.ts, packages/jwt/src/SigningKeyRecords.ts, packages/organization/src/ActiveContextRecords.ts, packages/organization/src/ConnectionRecords.ts, packages/organization/src/InvitationRecords.ts, packages/organization/src/MembershipRecords.ts, packages/organization/src/OrganizationRecords.ts, packages/organization/src/OrgRoleRecords.ts, packages/organization/src/TeamRecords.ts, packages/saml/src/SamlRecords.ts, packages/scim/src/ScimRecords.ts, packages/webhooks/src/WebhookRecords.ts
SPIKE-DELTA unavailable-label: removed=31 added=30 net=1
SPIKE-NOT-PURSUED tenant-visibility: criterion (a) fails: 2 of 16 files carry a copy (ImpersonationRecords, WebhookRecords) against at least 5; TenantScoped already is the shared helper
SPIKE-NOT-PURSUED wire-row: criterion (b) fails: removed=14 added=24 net=-10 and the 14 adopter copies are one spelling (D6 not met)
SPIKE-NOT-PURSUED sqlstore-make: criterion (b) fails: removed=198 added=247 net=-49 and the 16 closures differ only in names (D6 not met)

## Continuation input

Written for the planner of REC-03 and REC-04 after this commit. Line numbers are valid at `SPIKE-HEAD` (`b0de5660412fcde882f1095513c33cec3e83bb9f`) only; re-read every site before editing. The verdict is go, with two passed helpers (`comparators`, `unavailable-label`), so only those two may be scaffolded; `tenant-visibility`, `wire-row` and `sqlstore-make` are recorded not pursued (their `SPIKE-NOT-PURSUED` lines carry the numbers) and REC-03's pieces for them are closed with that reason. There is no `SPIKE-CONFLICT`: `sqlstore-make` did not pass, so `unavailable-label` is the only helper on the per-file label closure.

Both passed helpers are additive exports to existing modules (`Keyset.chronological` in `@awthaq/ports`, `StoreFailure.labelled` in `@awthaq/sql`); neither is a new module, a new package edge or a `*Shape` change. Both are "moves, or removes by one line", not shrinkers: a go plan should say so in its own record rather than present them as a size win (REC-03's own measure is the spike's rule, not lines).

### comparators

Home and interface: `packages/ports/src/Keyset.ts`, `@awthaq/ports`, stratum 2; the exact prototype signature is under "Measurements > comparators" (`chronological({ createdAt, id, direction })` built from `Order.mapInput(DateTime.Order, ...)`, `Order.mapInput(Order.String, ...)`, `Order.combine`, and `Order.flip` for `desc`; adds a `DateTime` import). Test: one `it` in `packages/ports/test/Keyset.test.ts`, comparing `chronological` against `Keyset.window` on the file's existing `rows` for `asc` and `desc`.

Adopters (site at SPIKE-HEAD, spelling today, per-file removed / added in the prototype, which includes the new `Keyset` import where the file had no `@awthaq/ports` import):

| File | Site | Spelling today | removed / added |
|------|------|----------------|-----------------|
| `packages/device-authorization/src/DeviceClientRecords.ts` | `:55-59` `oldestFirst` | ternary chain, asc, code-unit tie | 4 / 8 (new `@awthaq/ports` import line) |
| `packages/api-key/src/ApiKeyClientRecords.ts` | `:75-81` `newestFirst` | ternary chain, desc, code-unit tie | 5 / 8 |
| `packages/api-key/src/ApiKeyRecords.ts` | `:98-102` `newestFirst` | ternary chain, desc, code-unit tie | 5 / 8 |
| `packages/organization/src/ConnectionRecords.ts` | `:339-343` inline in `listByOrganization` | `\|\|` + `localeCompare`, asc | 4 / 6 |
| `packages/organization/src/MembershipRecords.ts` | `:192-203` `applySort` | `\|\|` + `<`, `.reverse()` for desc | 5 / 7 (new `@awthaq/ports` import line; the `.reverse()` goes, the helper takes `direction`) |
| `packages/organization/src/TeamRecords.ts` | `:364-368` `descendantsIn`, `:469-473` `listTeamsByOrganization` | `.epochMilliseconds` + `localeCompare`; `.epochMilliseconds` + `<` | 6 / 11 |
| `packages/saml/src/SamlRecords.ts` | `:265-270` `byCreation`, `:272-279` `newestFirst` | `\|\|` + `localeCompare`, asc and desc | 7 / 11 |
| `packages/scim/src/ScimRecords.ts` | `:174-182` `byCreation(rows, tieBreak)` (callers `:226-233` `row.id`, `:391-394` `row.resourceId`, `:449-452` `row.connectionId`) | `\|\|` + `tieBreak(a).localeCompare(tieBreak(b))` | 4 / 6 (`id: tieBreak` keeps the call sites) |
| `packages/webhooks/src/WebhookRecords.ts` | `:314-321` `byCreation` | `\|\|` + `localeCompare` | 4 / 6 |
| `packages/ports/src/Keyset.ts` and `packages/ports/test/Keyset.test.ts` | end of file / end of the `describe("Keyset.window")` | helper and one `it` | 0 / 14 and 0 / 18 |

Total `SPIKE-DELTA comparators: removed=44 added=103 net=-59`. Keep the named functions and their callers; replace only the comparator body.

Not adopted, with the reason: `DeviceGrantRecords.ts:213-215` (memory sort has no id tie-break; adopting would silently change `listByUser` tie order, finding F1; if the user wants F1 fixed it is a separate, deliberate change with its own contract case), `SigningKeyRecords.ts:168-173` (no tie-break on either side, F2; different semantics), `WebhookRecords.ts:555-558` (`nextAttemptAt` then `localeCompare`: same shape on another key, left out because it was not in the measured set), `WebhookRecords.ts:796` (id only), `ImpersonationRecords.ts:249-254` (`endedAt` with `None` as `0`), `SigningKeyRecords.ts:191` (tuple sort).

Behaviour the contract suites already pin for these sites (equal `createdAt`, different id): `ApiKeyClientRecords` contract (`packages/api-key/test/contract/ApiKeyClientRecords.ts:98`, desc), `ApiKeyRecords` (`:131`, desc), `DeviceClientRecords` (`packages/device-authorization/test/contract/DeviceClientRecords.ts:117`, asc), `MembershipRecords` (`packages/organization/test/contract/MembershipRecords.ts:332`, both directions), `TeamRecords` (`packages/organization/test/contract/TeamRecords.ts:433-441`, ties `tied-a`/`tied-b`). Time-ordered cases without an equal-time case: `SamlRecords` (`packages/saml/test/contract/SamlRecords.ts:404`, `:697`), `ScimRecords` (`packages/scim/test/contract/ScimRecords.ts:248`, `:508`), `WebhookRecords` (`packages/webhooks/test/contract/WebhookRecords.ts:505`, `:523`); `ConnectionRecords` has no listing-order case found by grep. The localeCompare sites (Connection, Saml, Scim, Webhook, Team `:364`) are the ones whose order could differ for a non-canonical id.

Wave 0 pins the go branch must add before any `src` change (narrowed to what comparators can touch): for each adopter file an equal-`createdAt`, different-id (canonical UUIDv7-shaped ids) listing case with an inline literal expected order, in both directions where the file has both (Saml connections asc and sp keys desc; Membership asc and desc), for the four files with no equal-time case (Connection, Saml, Scim, Webhook) and for Team `:364` `descendantsIn` (through a descendants read); the helper's own case in `Keyset.test.ts`; and each of the 16 modules' `Ref` count frozen as in the "`Ref.make` per module" table above (`ImpersonationRecords` keeps two `Ref`s and a `Semaphore`). Operation labels and lock keys are untouched by this helper (it changes no `unavailable(...)` call and no `SqlStore.atomically` key), so they are pinned only through the whole-label pin below.

Docs and template impact (REC-04 updates last): `grep -n` over `docs/plugin-authoring.md` and `examples/plugin-template/src/Template.ts` for ordering, `Keyset`, `sort`, `localeCompare` and `newestFirst` finds nothing, so a comparator export needs no doc or template edit unless the go plan chooses to mention it.

Changeset and spec: one `.changeset/<name>.md` naming `@awthaq/ports` (and `@awthaq/sql` if `unavailable-label` ships in the same change) with a `Migration:` line; an additive export to an existing module needs no `spec/overview.md` or `spec/traceability.md` change.

Allowlist paths to append to `06-BASELINE.md` "Path allowlist": `packages/ports/src/Keyset.ts`, `packages/ports/test/Keyset.test.ts`, the nine adopter files listed in `SPIKE-ADOPTERS comparators`, the go branch's Wave 0 pin files (named by that plan), and one `.changeset/<name>.md`.

### unavailable-label

Home and interface: `packages/sql/src/StoreFailure.ts`, `@awthaq/sql`, stratum 3; the exact prototype signature is under "Measurements > unavailable-label" (`labelled(store)(operation)` returning ``orStoreUnavailable(`${store}.${operation}`)``, one one-line doc comment). Test: one `it` in the existing `describe("StoreFailure.orStoreUnavailable")` of `packages/sql/test/StoreFailure.test.ts` asserting `labelled("Probe")("read")` fails with `operation === "Probe.read"`. Keep it inside that `describe` (a wrapper of its own costs 2 lines and flips the sign of the spike's net).

Adopters (closure definition at SPIKE-HEAD; each becomes one line `const unavailable = StoreFailure.labelled("<Store>");`, `failing` in `WebhookRecords`; call sites unchanged; per-file removed / added is 2 / 1, `WebhookRecords` 1 / 1):

| File | Closure lines |
|------|---------------|
| `packages/admin/src/ImpersonationRecords.ts` | `:543-544` |
| `packages/api-key/src/ApiKeyClientRecords.ts` | `:164-165` |
| `packages/api-key/src/ApiKeyRecords.ts` | `:206-207` |
| `packages/device-authorization/src/DeviceClientRecords.ts` | `:103-104` |
| `packages/device-authorization/src/DeviceGrantRecords.ts` | `:251-252` |
| `packages/jwt/src/SigningKeyRecords.ts` | `:400-401` |
| `packages/organization/src/ActiveContextRecords.ts` | `:248-249` (two further calls `unavailable(operation)` at `:308`, `:325` stay) |
| `packages/organization/src/ConnectionRecords.ts` | `:505-506` |
| `packages/organization/src/InvitationRecords.ts` | `:389-390` |
| `packages/organization/src/MembershipRecords.ts` | `:451-452` |
| `packages/organization/src/OrganizationRecords.ts` | `:311-312` |
| `packages/organization/src/OrgRoleRecords.ts` | `:256-257` |
| `packages/organization/src/TeamRecords.ts` | `:802-803` |
| `packages/saml/src/SamlRecords.ts` | `:637-638` |
| `packages/scim/src/ScimRecords.ts` | `:508-509` |
| `packages/webhooks/src/WebhookRecords.ts` | `:1137` (`failing`, one line) |

Total `SPIKE-DELTA unavailable-label: removed=31 added=30 net=1` (sites removed 31 and added 16, helper added 4, test added 10). No site in the adopter set is left out. If both this helper and `comparators` are adopted, `MembershipRecords`, `ConnectionRecords`, `TeamRecords`, `SamlRecords`, `ScimRecords`, `WebhookRecords`, `ApiKey*Records` and `DeviceClientRecords` are edited by both: sequence them (or do both in one plan per file) so the pins for each are green first.

Behaviour the contract suites already pin: `StoreUnavailable.operation` is asserted on one operation in 7 of the 16 contract files (`ApiKeyClientRecords:240`, `ApiKeyRecords`, `DeviceClientRecords`, `DeviceGrantRecords`, `SigningKeyRecords`, `ScimRecords`, one each) and in none of the other nine. The 154 literal labels plus the two `ActiveContextRecords` variable calls are otherwise pinned by nothing but the census. Wave 0 pin the go branch must add before any `src` change: a label pin that, for each of the 16 modules, fails every operation's statement and asserts the exact `<Store>.<operation>` literal (inline literals; the four spike files' 29 labels are listed below and the other 12 files' labels come from the census and the source). Lock keys (`SqlStore.atomically`, 5 files) and `Ref` counts are untouched by this helper; pin the `Ref` counts as in the table above anyway, since the same files are edited.

The four spike files' 29 labels (from the census): DeviceClientRecords findById insert list revoke; ApiKeyClientRecords deleteByOwner findById insert listByOwner revoke rotateSecret; ApiKeyRecords deleteByOwner findById insert listByOwner revoke rotate touch; DeviceGrantRecords claim consume decide deleteByUser findByDeviceHash findByUserHash insert listByUser purgeExpired raiseInterval remove touchPoll.

Docs and template impact (REC-04, last): `docs/plugin-authoring.md:29` tells plugin authors to "Pipe each method through `StoreFailure.orStoreUnavailable("<Records>.<method>")`" and `examples/plugin-template/src/Template.ts:266` and `:273` do exactly that (`StoreFailure.orStoreUnavailable("NoteRecords.create")`, `"NoteRecords.listByOwner"`). Both remain correct (`orStoreUnavailable` is unchanged), so the go plan decides whether to add `StoreFailure.labelled("NoteRecords")` to the template and one sentence to the doc; if it does, the template's contract test (`examples/plugin-template/test/Contract.test.ts`) and the docs checks must pass.

Changeset and spec: as for comparators (one changeset, `Migration:` line, no spec edit for an additive export to an existing module).

Allowlist paths to append: `packages/sql/src/StoreFailure.ts`, `packages/sql/test/StoreFailure.test.ts`, the 16 adopter files listed in `SPIKE-ADOPTERS unavailable-label`, the Wave 0 pin files, one `.changeset/<name>.md`, and `docs/plugin-authoring.md` and `examples/plugin-template/src/Template.ts` only if the plan edits them.

### Not pursued (REC-03 pieces closed with these numbers)

- shared comparators for `DeviceGrantRecords` and `SigningKeyRecords`: outside the adopter set (no tie-break, F1/F2).
- tenant-visibility plumbing: (a) fails, 2 of 16 files; `TenantScoped` is already the shared helper.
- dialect wire row helper: (b) fails, removed=14 added=24 net=-10, one spelling across the 14 adopter copies; the row-to-record mapping has no shared candidate.
- `SqlStore.make` adoption: (b) fails, removed=198 added=247 net=-49, closures differ only in names; (c) would hold for a `read`/`once` variant, and `write` would add a transient retry (6 of the 29 spike operations are repeat-safe), a behaviour change.

### In every case

- The 16-module `Ref.make` table is in "(a) Count per helper"; `ImpersonationRecords` keeps two `Ref`s and one `Semaphore` (REC-04's wording "every layerMemory is one Ref<State>" is corrected in the record, per CONTEXT, not by rewriting a module).
- The four spike files' 29 labels and their idempotency classification are in "Measurements > sqlstore-make" (9 read, 6 write, 14 once).
- Findings F1 (`DeviceGrantRecords.listByUser` tie drift, memory vs SQL, unpinned, not fixed) and F2 (`SigningKeyRecords` no tie-break) stand regardless of the go.
- Line numbers are valid at SPIKE-HEAD (`b0de5660412fcde882f1095513c33cec3e83bb9f`) only; `git diff --quiet 3be32564 -- packages features examples` exits 0 at that head.
