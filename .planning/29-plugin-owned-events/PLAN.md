# Plan 29: Plugins own their event definitions

> Written at `.planning/15-plugin-owned-events/PLAN.md`; the orchestrator renumbered it to **plan 29**
> (`29-plugin-owned-events`) and moves the directory. Its ADR is **ADR-EA-049** (ADR-EA-042 to 046 are taken by
> batch 2 of `.planning/README.md`).

| Property | Value |
|---|---|
| Source | Architecture review of 2026-11-08 (`/improve-codebase-architecture`), candidate "plugins own their event definitions" (strong friction). It carries out the phase that plan 09 designed and gated: `.planning/09-event-definitions/PLAN.md` §3.7 and §4.6, tickets 11–12+, decision Q1 ("later, after plans 04 and 08"). Both plans have landed |
| Strength | **Strong** (friction, locality). Behaviour today has no live bug. The plan closes two gaps in plan 09's phase-5 design before they ship (§2.8 F1, F2) |
| Dependency category | **in-process** |
| Wave / position | A new wave after **plan 25** (record-store contract). Core tickets 01–10 may overlap plan 25, except ticket 08. Per-plugin moves (11–21) follow plan 25 one plugin at a time: password after **plan 27**, organization last, and before **plan 30**. This plan and batch-2 **plan 15** (`AuthHost`) can land in either order, and whichever lands second adds one line (§8) |
| Tracker | `.scratch/29-plugin-owned-events/issues/NN-*.md`, 25 tickets (§4.6) |
| Touches | `@awthaq/core` (`EventDefinition`, `AuthEventSchemas`, `AuthEvents`, `AuditLog`, `AuthPlugin`, `Auth`, `EventRelay`, `Retention`), `@awthaq/test` (`TestAuth`, `RedactionGuard`, the contract runner), `@awthaq/webhooks`, `@awthaq/cli`, and every plugin package that publishes its own events: organization, admin, two-factor, api-key, scim, saml, webhooks, password, roles, device-authorization, qadi. Also `examples/plugin-template`, `examples/memory-server`, `features/`, `spec/`, `docs/plugin-authoring.md`, `packages/webhooks/README.md` |
| Wire change | **None on HTTP or in webhook bodies.** No tag is renamed, no payload field changes, and `EVENT_VERSION` stays `1`. A stored audit row of an event that declares personal data gains `meta.pii` (3 of 97 events). Old and new readers ignore unknown `meta` keys (Effect `Schema` decodes with `onExcessProperty: "ignore"` by default, `SchemaAST.d.ts:399`). The TypeScript interface changes in breaking ways, announced under ADR-EA-034 (§6.7) |
| ADRs | New **ADR-EA-049**. Amends ADR-EA-012, 029 and 030; adds a link in 035 |
| Verified at | **2026-11-08**, `architecture/deepening-plans-2` @ `5a0e8df4`, with `main` @ `935d15ee` merged and staged (not committed). The brief named `6c5377f8` plus the working tree on `chore/effect-4.1-peer-deps`; the checkout moved while this plan was being written. Every `file:line` here is for the **current** tree, and §2.7 lists where the old tree differs. `effect` is `^4.1.2` in the catalog and **4.1.2** is installed (`node_modules/.pnpm/effect@4.1.2`); TypeScript is 7.0.2 (`effect-tsgo` 0.53.3). The Effect APIs named here were checked in that copy, and the three type-level claims in §2.6 were compiled against it |

Conventions: everything in [`.planning/README.md` § Shared conventions](../README.md) and `.planning/IMPLEMENTING.md`
applies:
- no `as` (and no `as const`) in library source, and no return type annotations on new Effect/Layer consts;
- type-system first;
- replace-don't-layer tests;
- spec, traceability and BDD updates;
- a changeset with a `Migration:` note for every package-visible change;
- the per-phase gate `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`, and `pnpm check` per plan.

This plan changes the pure erasure function that both audit stores apply (`AuditLog.scrubRow`), so ticket 05 also
runs `pnpm test:pg`. No SQL adapter, migration or table changes. Plugin packages test against built `lib`, so run
`pnpm build` before `pnpm test` after a core ticket (`docs/plugin-authoring.md`, "House rules").

Vocabulary: **module, interface, implementation, depth, seam, adapter, leverage, locality**. Domain terms come from
`spec/glossary.md`. New terms (**event definition**, **foreign event**) are added to the glossary in ticket 24.

---

## 1. Summary, goals, non-goals

### Summary

`@awthaq/core` holds the definition of every event any package can publish. That is 97 `defineEvent(...)` calls in
`packages/core/src/AuthEventSchemas.ts` (1,899 lines), each listed again in its `registry([...])`
(`AuthEventSchemas.ts:1733-1831`). **73 of the 97 are published by exactly one plugin package** (§2.3), so every change
to a plugin's event edits core. Since 2026-08-08, 34 commits have touched that file, among them plan 04's organization
events (`3917b381`, `81d4323b`, `a305c26a`) and SCIM's (`197eef28`). A plugin outside this repository cannot add a tag at
all. `docs/plugin-authoring.md:121` says so, while BEH-EA-101's prose (`spec/behaviors/13-events.md:100`) promises that
the registry "lets a plugin author add a new event tag".

Plan 09 already turned an event into one declarative value. `defineEvent(tag, fields, { actor, pii, attempt? })` returns
the schema with its metadata attached (`packages/core/src/internal/eventDefinition.ts:116-123`). Every reader (the actor
column, erasure, the attempt lane, webhooks) reads that metadata generically. What remains is plan 09's phase 5, which
this plan carries out: **the value moves to the package that publishes it.**

The deepened module is the **event-definition seam**:
- `EventDefinition.define`, made public;
- the `events` declaration on `AuthPlugin.Service`;
- the registry `Auth.make` composes;
- `AuthEvents.emit(definition, input)`.

Its interface is one call to define an event, one list on the plugin class and one call to publish. Behind it, core
implements once:
- encoding through the definition;
- the actor column;
- the attempt or state-change lane (ADR-EA-037);
- recording the declared personal data with the row;
- reading a row whose plugin is gone;
- composing tags and refusing duplicates;
- the validating guards that type the open stream.

It reuses the precedent ADR-EA-035 set for `userFields`: a static declaration, a type-only `"~userFields"` member, a fold
over the plugin tuple, and a `Context.Reference` the composition provides.

Three measured facts shape the design (§2.6, §2.8):

1. **An open union member destroys `_tag` narrowing for the whole union.** This was compiled against the repo's
   TypeScript. The composed event set therefore cannot be `AuthEvent | <something open>` anywhere a consumer narrows.
   - The bus is typed open and narrowed by guards that validate.
   - The narrowable union of one composition exists only where the plugin tuple is in scope: `Auth.EventsOf<P>` and
     `AuthEvents.typed(auth.events)`.
   - Core's own `AuthEvent` stays a closed, narrowable union of the 24 events core keeps.
2. **Plan 09 §3.7 would have lost personal data.** It decoded and erased audit rows through the composed registry. Once
   a plugin is removed, its `pii` declaration goes with it, and erasure would leave that plugin's declared free text in
   the trail forever (ADR-EA-029). Here a row records its declared personal data (`meta.pii`) when it is written.
3. **The audit log therefore needs nothing from the composition.** Core reads a row whose tag it does not define as a
   `ForeignEvent`: a fixed-literal wrapper of the tag and the stored fields, which keeps `AuditLogRecord.payload`
   narrowable. A plugin decodes its own rows with `AuditLog.payloadAs(definition)`. None of the 91 composition sites of
   `AuditLog.layer` change.

### Goals

- **G1. Locality.** A plugin's events are defined, declared, published and tested in its own package. Core keeps only the
  24 events it must keep (§3.8). `AuthEventSchemas.ts` falls to ≤ 720 lines, and no tag published by only one plugin
  remains in core (`grep` in §9).
- **G2. Open to third parties, closed per composition.** Any plugin can declare tags. `Auth.make` refuses a tag that is
  declared twice, core included, with the link error `Auth/EventTagConflict`. The composed set is listed in
  `manifest.events`.
- **G3. Type soundness without assertions.**
  - Core's `AuthEvent`, `EventOf<Tag>` and `publish` keep exact narrowing.
  - A plugin's events are typed from their definitions.
  - A composition's events are typed from the tuple (`Auth.EventsOf<P>`).
  - The open stream is narrowed by guards that validate rather than trust.
  - No `as` anywhere.
- **G4. The audit trail keeps every guarantee for plugin events.**
  - The same actor column.
  - The same attempt or state-change lane.
  - Erasure blanks the declared personal data, even after the plugin is removed.
  - A removed plugin's rows are read as `ForeignEvent` and never fail `list`, `replay`, the relay or a data export.
- **G5. Readers of "every tag" read the composed registry**: webhook filters and payload personal data, Retention rules,
  `RedactionGuard`, the BDD registry steps, and `awthaq plugin list --events`.
- **G6. The plugin template is the worked example.** `docs/plugin-authoring.md` "Events" and BEH-EA-101 describe the code
  that ships.
- **G7. Replace, don't layer.** The 73 plugin samples and the per-event checks held in core's tests move to one shared,
  data-driven check that the contract runner (`runPluginContractTests`) applies to every plugin's declared events.
- **G8. Plan 09's decisions are kept.** Each moved definition keeps its actor, `pii`, `attempt`, JSDoc and constant name
  verbatim. Every deviation from plan 09's design is listed with its reason (§3.10).

### Non-goals

- No tag rename and no payload change. `EVENT_VERSION` stays `1`, and the HTTP and webhook wire formats are unchanged.
- No per-definition versioning or upcasters for plugin events. ADR-EA-049 records the consequence: a breaking change to a
  plugin event is a new tag.
- No events defined by the application (host) through `Auth.make` options (Q4).
- No relay-side scrub of declared personal data for custom transports. Plan 09's Q4/F5 stays a separate question, and the
  follow-up file plan 09 §11 names is missing from `.scratch/` (§2.8 F5).
- No change to `WebhookPayload.subjectUserId`'s field heuristic (plan 09 F4/Q5; still at `WebhookPayload.ts:103-109`).
- No type-level duplicate-tag check in `Validate<P>`. Duplicates are refused at runtime, like `GroupIdConflict` and
  `RouteConflict` (Q3).
- No change to who counts as an event's actor, or to which fields are personal data.

---

## 2. Verified current state

### 2.1 Re-measurement commands

Run these from the repo root. The numbers are for the current tree; the old-tree number, where it differs, is in
brackets.

```bash
wc -l packages/core/src/AuthEventSchemas.ts                                   # 1899 [1873]
grep -c '= defineEvent($' packages/core/src/AuthEventSchemas.ts               # 97   [96]
sed -n '/^const Registry = registry(\[/,/^\]);/p' packages/core/src/AuthEventSchemas.ts | grep -c 'Event,'  # 97
git log --since=2026-08-08 --oneline -- packages/core/src/AuthEventSchemas.ts | wc -l                      # 34   [32]
grep -c 'pii: \["' packages/core/src/AuthEventSchemas.ts                      # 3
grep -c 'attempt: true' packages/core/src/AuthEventSchemas.ts                 # 10
wc -l packages/core/test/support/eventSamples.ts                             # 477  [471]
# owner of each tag = the packages whose src names it (the schema file excluded)
grep -A1 '= defineEvent($' packages/core/src/AuthEventSchemas.ts | grep -oE '"auth\.[A-Za-z.]+"' | tr -d '"' |
  while read t; do printf '%s  ' "$t"; grep -rlF "\"$t\"" packages/*/src | grep -v AuthEventSchemas |
  sed -E 's#packages/([^/]+)/.*#\1#' | sort -u | tr '\n' ','; echo; done
grep -rn 'AuditLog.layer\b' --include=*.ts packages examples features | grep -v /lib/ | wc -l             # 91   [82]
grep -rn '\.stream\b\|\.subscribe\b' packages/*/test features/step-definitions --include=*.ts | grep -v /lib/ |
  grep -iv 'registry.subscribe\|pubsub' | wc -l                                                           # 61
grep -rln 'Stream.filter((\w*) => \w*\._tag ===' packages/*/test features/step-definitions --include=*.ts |
  grep -v /lib/ | wc -l                                                                                     # 9 files, 19 sites
grep -rn 'payloadOf\b' packages/*/src packages/*/test features/step-definitions --include=*.ts | grep -v /lib/ | wc -l  # 19
```

### 2.2 What plan 09 phases 1–4 actually landed

| Plan 09 artefact | Status in the current tree | Evidence |
|---|---|---|
| `internal/eventDefinition.ts`: `defineEvent`, `Actor`, `EventMetaSchema`, `Defined`, `registry`, `actorValue` | **Landed, extended.** Plan 10 item 5 added `attempt` (ADR-EA-037). `Defined<Tag>` became generic, and the registry gained `isTag`/`isAttempt` | `packages/core/src/internal/eventDefinition.ts:1-165` (`attempt` `:26`, `:91-98`; `Defined<Tag>` `:31-33`; `isTag` `:153`) |
| Every event a `defineEvent` call | **Landed.** 92 then, 97 now (plan 04 added `invitationExpired` and three `connection*`; batch-2 plan 14 added `auth.account.linked`) | `AuthEventSchemas.ts:42-1731` |
| `registry([...])` and the readers `eventTags`, `isEventTag`, `actorOf`, `piiFieldsOf`, `isAttemptEvent` | **Landed** | `AuthEventSchemas.ts:1733-1844` |
| The 92-case `actorOf` switch and `PII_FIELDS` deleted | **Landed** | `grep -rn 'PII_FIELDS\|legacyActorOf' packages features --include=*.ts \| grep -v /lib/` finds 0 |
| F2 (memory erasure drift) fixed | **Landed**, then subsumed by plan 02's single `AuditLog` over `AuditLogStore`: `scrubRow` is written once and both stores apply it | `packages/core/src/AuditLog.ts:262-282` |
| Shared `test/support/eventSamples.ts` | **Landed**, mapped over `AuthEventTag`, so a missing sample is a compile error | `packages/core/test/support/eventSamples.ts:12` (477 lines) |
| T1/T2/T3 tests | **Landed** | `packages/core/test/EventDefinition.test.ts` (T3 `:81-182`, attempt set `:184-209`), `EventDefinition.types.test.ts` |
| Webhooks reading `piiFieldsOf`/`eventTags` | **Landed** | `packages/webhooks/src/WebhookPayload.ts:70`, `:151` |
| Phase 4: the ban note and the suspension note are `pii` | **Landed** | `AuthEventSchemas.ts:548`, `:635` (`pii: ["reason"]`) |
| Phase 5 (this plan) | **Not started** | plan 09 §11 Q1 |
| Q4 follow-up `.scratch/09-event-definitions/issues/01-relay-scrub-declared-pii.md` | **Absent**: `.scratch/` has no `09-event-definitions` | `ls .scratch` |

Batch 2 has already changed four of the events this plan touches. `auth.admin.actionDenied` now names its target
(`a95959c2`, batch-2 plan 13). Core's `FederatedIdentity.ts:277` publishes the new `auth.account.linked` (`2dff755f`,
batch-2 plan 14). `EventRelay` moved its cursor behind a store port (batch-2 plan 23), so its anchors shifted. Batch-2
plan 16 deleted `Repositories`, so `AuditLogStoreSql` owns its statements. No batch-2 plan moves event definitions or
changes `defineEvent`. Batch-2 plan 15 (`AuthHost`, not landed) composes `built.userFieldsLayer` and would compose the
`built.eventsLayer` this plan adds (§8).

### 2.3 Event ownership (97 events)

Owner means the packages whose `src` names the tag (command in §2.1).

| Owner | # | Tags | This plan |
|---|---|---|---|
| core only | 14 | `auth.token.replay`, `auth.user.{created, signedIn, deleted, dataExported}`, `auth.account.linked`, `auth.session.{reuse, issued, rotated, superseded, revoked, expired}`, `auth.rateLimit.exceeded`, `auth.mail.failed` | stay |
| shared across packages | 5 | `auth.user.signInFailed` (core `SignIn`/`countEvent`, magic-link, oauth, passkey, password, saml) · `auth.password.changed` (admin, password) · `auth.admin.actionDenied` (admin, saml, webhooks) · `auth.passkey.counterAnomaly` (passkey + core `SecuritySignals`) · `auth.admin.impersonationDenied` (admin + core `SecuritySignals`) | stay |
| cli (not composed through `Auth.make`) | 4 | `auth.admin.{seeded, seedRefused}`, `auth.import.{completed, failed}` | stay (§3.8) |
| qadi `DecisionSinkAudit` (a host layer, not a plugin) | 1 | `auth.authz.denied` (`packages/qadi/src/DecisionLogging.ts:78`) | stay (§3.8) |
| **organization** | **27** | the 25 `auth.organization.*` plus `auth.admin.organization{Suspended, Unsuspended}` (published by `OrganizationDirectory.ts:408`, `:433`) | move |
| **admin** | **9** | `auth.admin.{impersonationStarted, impersonationStopped, userUpdated, sessionRevoked, userBanned, userUnbanned, userDeleted, userEmailChangeRequested, userPasswordSet}` | move |
| **two-factor** | **7** | every `auth.twoFactor.*` | move |
| **api-key** | **6** | every `auth.apiKey.*` | move |
| **scim** | **5** | every `auth.scim.*` | move |
| **saml** | **5** | `auth.saml.{connectionCreated, connectionUpdated, connectionDeleted, signingKeyRotated, logoutRejected}` | move |
| **webhooks** | **5** | every `auth.webhooks.*` | move |
| **password** | **4** | `auth.user.{emailVerified, emailChanged}`, `auth.password.{resetRequested, resetCompleted}` | move |
| **roles** | **2** | `auth.roles.{assigned, revoked}` | move |
| **device-authorization** | **2** | `auth.deviceAuthorization.{approved, denied}` | move |
| **qadi `UserClaims` plugin** (`claims`) | **1** | `auth.user.claimsUpdated` (`packages/qadi/src/UserClaims.ts:134`) | move |

**24 stay and 73 move.** The 73 move blocks span 1,156 lines of `AuthEventSchemas.ts`; that counts each block's JSDoc,
`defineEvent` call and `export type` line, measured with the script recorded in ticket 01. Three of the movers declare
`pii` (`auth.admin.impersonationStarted`, `auth.admin.userBanned`, `auth.admin.organizationSuspended`). Five declare
`attempt: true`: `auth.twoFactor.{challengeFailed, locked}`, `auth.organization.permissionDenied` and
`auth.deviceAuthorization.denied` move, while `auth.authz.denied`, `auth.token.replay`, `auth.user.signInFailed`,
`auth.rateLimit.exceeded`, `auth.admin.{actionDenied, impersonationDenied}` stay.

### 2.4 What one plugin event change costs today

| # | Edit site | Package |
|---|---|---|
| 1 | The definition, `defineEvent(...)` plus its `export type`, in `AuthEventSchemas.ts` | core |
| 2 | Its entry in `registry([...])` (`AuthEventSchemas.ts:1733-1831`) | core |
| 3 | A sample in `packages/core/test/support/eventSamples.ts` (the mapped type makes it mandatory) | core |
| 4 | Core tests that list tags: the attempt set (`EventDefinition.test.ts:187-198`), the actor table (`AuditLog.test.ts:54-114`), type tests (`AuthEvents.types.test.ts:29-38`) | core |
| 5 | The publish site | plugin |
| 6 | BEH-EA-101's taxonomy prose, when it changes | spec |

Five of the last twelve commits to the file were changes to plugin events alone (`3917b381`, `81d4323b`, `a305c26a`,
`197eef28`, `14bc1bc6`; `git show --stat <hash>` lists core plus one or two plugin packages each).
`docs/plugin-authoring.md:121` tells a plugin author to edit core, and ends: "Until plugins own their events (plan 09
phase 5), a third-party plugin cannot add a tag: reuse an existing one, or contribute the definition to core."

### 2.5 Every reader of the event set and its types

| Reader | `file:line` | Reads today | After this plan |
|---|---|---|---|
| `AuthEvents.publish` / `deliver` | `packages/core/src/AuthEvents.ts:64`, `:211-272` (attempt split `:264`) | `AuthEvent`, `isAttemptEvent` | `publish` keeps core's events. New `emit(definition, input)`, and both share one `deliver` driven by the definition |
| `stream` / `subscribe` | `AuthEvents.ts:73`, `:79` | `Published` (closed union) | `PublishedAny` (open) plus guards (§3.5) |
| `TagSelect` / `Handled` / `matching` / `on` / `onBatch` | `AuthEvents.ts:294-309`, `:419-466` | core tags | selectors: core tags and/or definitions |
| `countEvent` | `AuthEvents.ts:169-183` | two core tags | unchanged (core events only) |
| `AuditLog.record` / `toStoredRow` | `packages/core/src/AuditLog.ts:120`, `:176-205` | `encodeEvent` (core union), `actorOf` | through the event's definition; stamps `meta.pii` |
| `AuditLog.decodeRow` | `AuditLog.ts:212-250` | `decodeEvent` (core union), so a non-core tag is an `AuditLogDecodeError` | core tags decode as today; any other tag is a `ForeignEvent` |
| `AuditLog.scrubRow` | `AuditLog.ts:262-282` (`piiFieldsOf` `:276`) | `piiFieldsOf(row.eventTag)` | the row's own `meta.pii`, else the frozen pre-ADR-EA-049 table, plus core's `piiFieldsOf` |
| `AuditLogRecord.eventTag` / `payload` | `AuditLog.ts:76`, `:87` | `AuthEventTag` / `AuthEvent` | `string` / `AuthEvent \| ForeignEvent` |
| list / replay / purge inputs | `AuditLog.ts:104`, `:113`, `:152-153` | `AuthEventTag` | `string` |
| `toPublished` | `AuditLog.ts:91` | `Published` | `PublishedAny`, unwrapping a `ForeignEvent` |
| `EventRelay` | `packages/core/src/EventRelay.ts:48`, `:57`, `:74`, `:129` | `Published`, `AuthEventTag` | `PublishedAny`, `string` |
| `DataExport` activity | `packages/core/src/DataExport.ts:127-129`, `:167-172` | `list({ actorUserId })`, `eventTag`; `AuditLogDecodeError` → die | unchanged. A removed plugin's row is no longer a decode error |
| `Retention` | `packages/core/src/Retention.ts:38`, `:47`, `:131-144` | `AuthEventTag` | `string`, validated against `EventRegistry` |
| `SecuritySignals` | `packages/core/src/SecuritySignals.ts:38`, `:49`, `:88`, `:119-165` | five core tags | unchanged (all five stay in core) |
| `WebhookPayload.toBody` | `packages/webhooks/src/WebhookPayload.ts:69-101` (`:70`) | `AuthEvents.piiFieldsOf` (core) | the composed registry's `piiFieldsOf`, passed in |
| `knownEventTags` / `unknownPattern` | `WebhookPayload.ts:151`, `:162-163` | `AuthEvents.eventTags` | `knownEventTags` deleted; `unknownPattern(patterns, tags)` |
| `Webhooks` `validateTags` | `packages/webhooks/src/Webhooks.ts:591-599` | `unknownPattern` | reads `AuthEvents.EventRegistry` |
| `WebhookDelivery.enqueue` / `transportLayer` | `packages/webhooks/src/WebhookDelivery.ts:68-116`, `:118-133` | `toBody` | reads the registry; an unknown tag is not enqueued |
| `RedactionGuard.layerEvents` | `packages/test/src/RedactionGuard.ts:242-252` (`:249`) | `AuthEvents.payloadOf`, which **throws** for a non-core event | inspects the published value |
| `TestAuth.makeLayer` | `packages/test/src/TestAuth.ts:346-410` (`userFieldsLayer` `:409`) | — | plus `built.eventsLayer` and `UndeclaredEventPolicy` set to `"die"` |
| `runPluginContractTests` | `TestAuth.ts:1133-` (`ContractTestOptions` `:773-831`) | — | plus an always-on events check |
| admin `ImpersonationOwnerNotice` | `packages/admin/src/ImpersonationOwnerNotice.ts:39` | `on("auth.admin.impersonationStarted")` | `on(AdminEvents.AdminImpersonationStartedEvent)` |
| CLI `Seed` / `Import` | `packages/cli/src/Seed.ts:89`, `:156`; `Import.ts:408-411` | `publish` (core tags) | unchanged |
| CLI `linkErrorCodes` | `packages/cli/src/Config.ts:109-115` | 5 link-error tags | plus `Auth/EventTagConflict`, and the five link errors it misses today (§2.8 F4) |
| CLI `plugin list` | `packages/cli/src/Plugin.ts` | manifest | plus `--events` |
| BDD registry steps | `features/step-definitions/EventsSteps.ts:31-33`, `:406-449` | `isEventTag`, `AuthEventSchema.members` | the world's composed registry |
| BDD secret-field scan | `features/step-definitions/PersistenceStratumSteps.ts:301` | `AuthEventSchema.members` | the composed registry's definitions |
| Core tests | `EventDefinition.test.ts:81-209`, `AuditLog.test.ts:54-114`, `AuthEvents.types.test.ts:29-38`, `test/support/eventSamples.ts` | all 97 tags | core's 24; plugin cases move (§5.2) |
| `payloadOf` callers | 19 sites: `features/step-definitions/ScimSteps.ts` (5), `packages/organization/test/Organization.test.ts` (6), core tests (6), `RedactionGuard.ts` (1), the definition (1) | core decode | plugin events: `Schema.decodeUnknownSync(<Def>)` |
| Docs | `docs/plugin-authoring.md:119-121`, `:261`; `packages/webhooks/README.md:6-20` | — | rewritten (§6.6) |

### 2.6 Type-level facts (compiled against the repo's TypeScript and `effect@4.1.2`)

1. **One open member kills narrowing.** Take
   `{ _tag: "auth.session.issued"; sessionId: string } | { _tag: "auth.user.created"; userId: string } | { _tag: string & Brand; [k: string]: unknown }`.
   After `if (e._tag === "auth.session.issued")`, `e.sessionId` fails with TS2339 ("does not exist on type 'Any'"). The
   compiler stops treating the union as discriminated at all; a branded tag does not help, and neither does the inferred
   predicate of `xs.filter(x => x._tag === …)`. So the composed set can never be `AuthEvent | Open` where narrowing
   matters (the bus element, the audit record payload). Ticket 02 pins this as a type test.
2. **A `Context.Service` shape is fixed when it is declared.** `AuthEvents`'s `publish` cannot depend on the plugin tuple,
   and a plugin's `make` never sees `P`. The type "every event of this composition" can exist only where `P` is in scope:
   `Built<P>`. This is exactly how `UserFieldsOf<P>` (`packages/core/src/Auth.ts:447-463`) and
   `Users.typedFields(auth.userFields)` work.
3. **`emit` can be typed with no assertion.** `D["~type.make.in"]` of a `TaggedStruct` omits `_tag` (the `tag()`
   constructor default, `Schema.d.ts:5043-5068`) and keeps brands; a bare string for a `UserId` field is rejected. A
   generic `emit<D>(d, input)` over `Schema.Top & Defined` uses `d.makeEffect(input)` (`Schema.d.ts:239`) and
   `Schema.encodeUnknownEffect(d)`, and compiles. Inside the generic body, the requirement channel is
   `D["EncodingServices"]`. `EventDefinition.Any` must therefore pin `EncodingServices` and `DecodingServices` to
   `never`, which also compiled. At a concrete call site the channel is already `never`.

### 2.7 Evidence corrections

| Review claim | Measured | Verdict |
|---|---|---|
| `AuthEventSchemas.ts` is ~1873 lines | 1,873 at `6c5377f8`; **1,899** in the current tree (`auth.account.linked`, `actionDenied` target fields) | right for the old tree |
| 32 commits in 3 months | 32 at `6c5377f8` (since 2026-08-08, which is the file's whole history); **34** in the current tree | right |
| "~96 plugin tags" | 96 (old) or 97 (current) is the **whole** registry. **73** are published by a single plugin; 24 are core, shared, the CLI's or qadi's sink | **wrong**: the move is 73 |
| organization ~25 | 25 `auth.organization.*` **plus 2** `auth.admin.organization{Suspended,Unsuspended}` published by organization since plan 04 (`OrganizationDirectory.ts:408`, `:433`) = **27** | close; the right number is 27 |
| admin ~15 | 15 tags in the `auth.admin.*` namespace: **9** published by admin alone, 2 by organization, 2 by the CLI, 2 shared | **wrong**: admin moves 9 |
| twoFactor ~7, apiKey ~6, scim/saml/webhooks ~5 each | 7, 6, 5, 5, 5 | right |
| `docs/plugin-authoring.md (~:117)` | **`:121`** (the `349acb4d` "package.json: effect is the host's" section shifted it) | line moved |
| BEH-EA-101 promises plugins can add tags | `13-events.md:100` (prose) contradicts the REQUIREMENT at `:92-98` ("closed, statically-known set ... the registry declares") and the code | right |
| Plan 09 §2.1's counts (92 events; organization 21; admin 11; core 10) | superseded. Plan 01 made `auth.user.{created, signedIn}` core-only; plan 04 added 4 organization events and moved the suspension events to organization; plan 06 made `auth.rateLimit.exceeded` core-only; batch-2 plan 14 added `auth.account.linked` | plan 09 is out of date |
| Brief: "existing ADRs end at 041" | the current tree has ADR-EA-042 and 043, with 044–046 reserved by batch 2 | the orchestrator assigned ADR-EA-049 |

### 2.8 Findings

- **F1. Plan 09's phase-5 design loses personal data on plugin removal (design gap, not shipped).** Plan 09 §3.7/§4.6
  step 6 has `AuditLog` erase through the composed registry. A removed plugin's `pii` list leaves with it, so erasing a
  person leaves that plugin's declared free text in their rows verbatim, against ADR-EA-029 decision 2. Today all three
  `pii`-declaring events belong to plugins (§2.3). Fixed by design: a row records `meta.pii` (§3.6), and rows written
  earlier fall back to a frozen three-entry table.
- **F2. Plan 09's `ForeignEvent { _tag: string }` would break every record consumer's narrowing (design gap).** Fact
  §2.6.1. Fixed by design: `ForeignEvent` has the fixed literal tag `"awthaq.foreignEvent"`.
- **F3. BEH-EA-101 contradicts itself** (§2.7). The REQUIREMENT is rewritten in §6.1.
- **F4. The CLI misclassifies five of `Auth.make`'s link errors (live, adjacent).** `linkErrorCodes` (`Config.ts:109-115`)
  lists `CircularPluginDependency`, `EmptyPluginTuple`, `GroupIdConflict`, `RouteConflict` and
  `LinkerInvariantViolation`. `Auth.make` (`Auth.ts:1138-1161`) also throws `UndeclaredTableDependency`,
  `Auth/TenancyDeclarationInvalid`, `Auth/SealedColumnDeclarationInvalid`, `Auth/MigrationDeclarationInvalid` and
  (through `UserFields.describeAll`) `UserFieldConflict`. The CLI reports these as a generic load failure instead of a
  `LinkProblem` with its code. Ticket 07 adds `Auth/EventTagConflict` and the five missing tags, all in the same set.
- **F5. Plan 09's Q4 follow-up is not on file.** Plan 09 §11 names `.scratch/09-event-definitions/issues/01-relay-scrub-declared-pii.md`,
  and it does not exist. This plan does not take Q4 on. Ticket 01 recreates the file from plan 09 §10 Q4, so the
  question is not lost.
- **F6. Webhooks' `subjectUserId` heuristic (plan 09 F4) is unchanged** (`WebhookPayload.ts:103-109`). Moved events keep
  their field names, so its behaviour is identical. Not touched.

---

## 3. Target design

### 3.1 The seam, and what sits behind it

```
plugin package                         @awthaq/core (behind the seam)                         host
──────────────                         ──────────────────────────────                         ────
TwoFactorEvents.ts ── EventDefinition.define ──► schema + "~awthaq/event" metadata (leaf module)
TwoFactor class    ── events: [...] ──────────► AuthPlugin.Class.events / "~events" (type-only)
                                                Auth.make ── composeEvents ──► Built.events : Registry<EventsOf<P>>
                                                         └─ Auth/EventTagConflict    Built.eventsLayer ─► provideMerge (last)
SecondFactor.ts    ── events.emit(def, input) ─► AuthEvents.emit ─► AuditLog.record(event, def)
                                                    │                 row: actor column, meta.pii, attempt lane
                                                    └─► bus: Stream<PublishedAny> ─► AuthEvents.on(def | tag)
                                                                                    AuthEvents.typed(auth.events)
webhooks plugin    ◄── AuthEvents.EventRegistry (Context.Reference; default = core's registry) ── filters, pii
AuditLog.list      ── core tag → AuthEvent  ·  other tag → ForeignEvent ─► AuditLog.payloadAs(def)
```

What sits behind the seam, implemented once in core:
- encoding through the event's own definition;
- the actor column (`actorValue`, unchanged from plan 09);
- the attempt or state-change lane (ADR-EA-037), read from the definition;
- stamping declared personal data on the row;
- reading a row core does not define;
- composing core's and every plugin's definitions and refusing duplicates;
- the validating guards that turn the open stream into typed events;
- the shared well-formedness check that both core's tests and the contract runner apply.

### 3.2 `EventDefinition`, a public leaf module (`packages/core/src/EventDefinition.ts`)

This is `internal/eventDefinition.ts`, promoted. Everything in `:14-146` stays: `MetaKey`, `EventMetaSchema`,
`EventMeta`, `Defined<Tag>`, the key types `UserIdKey`/`StringKey`/`FreeTextKey`, `Actor`, `Declaration` and
`actorValue`. The module imports only `effect` and `@awthaq/ports`' `Ids`, so it stays a leaf (`pnpm circular`).

```ts
// packages/core/src/EventDefinition.ts (ADR-EA-049; plan 09's internal/eventDefinition.ts, promoted)
import { Ids } from "@awthaq/ports";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const MetaKey = "~awthaq/event";
// ... EventMetaSchema, EventMeta, Defined<Tag>, Actor, Declaration, actorValue: unchanged from :14-146 ...

/** Re-exported so a plugin that does not depend on `@awthaq/ports` (roles) brands ids through core alone. */
export const UserId = Ids.UserId;
export const SessionId = Ids.SessionId;

/** Any event definition: a schema `define` produced, encodable and decodable with no services (§2.6.3). */
export type Any = Schema.Top &
  Defined & { readonly EncodingServices: never; readonly DecodingServices: never };
/** The decoded event a definition describes. */
export type TypeOf<D extends Any> = D["Type"];
/** What `AuthEvents.emit` takes: the event's fields; `_tag` is the constructor's default. */
export type Input<D extends Any> = D["~type.make.in"];

/** Plan 09's `defineEvent`, renamed: the one constructor of an event, wherever it is defined. */
export const define = <const Tag extends string, const F extends Schema.Struct.Fields>(
  tag: Tag,
  fields: F,
  declaration: NoInfer<Declaration<F>>,
) => Object.assign(Schema.TaggedStruct(tag, fields), { [MetaKey]: erase(tag, declaration) });

/** A set of definitions with the readers plan 09 attached to core's registry, and validating guards. */
export interface Registry<E extends { readonly _tag: string }> {
  /** `"core"` for core's own set; `"composition"` for what `Auth.make` composed. */
  readonly origin: "core" | "composition";
  readonly definitions: ReadonlyArray<Any>;
  readonly tags: ReadonlyArray<E["_tag"]>;
  readonly isTag: (tag: string) => tag is E["_tag"];
  readonly definitionOf: (tag: string) => Option.Option<Any>;
  readonly actorOf: (event: { readonly _tag: string }) => Option.Option<string>;
  readonly piiFieldsOf: (tag: string) => ReadonlyArray<string>;
  readonly isAttempt: (tag: string) => boolean;
  /** Validates, it does not trust: the tag is registered AND that definition's schema accepts the value. */
  readonly is: (value: { readonly _tag: string }) => value is E;
}

/** Plan 09's `registry`, renamed and extended. Core calls it for its own set; `Auth.make` for the composed set. */
export const make = <const Members extends ReadonlyArray<Any>>(
  members: Members,
  origin: "core" | "composition",
) => {
  const byTag = new Map<string, Any>(members.map((m) => [m[MetaKey].tag, m]));
  const isTag = (tag: string): tag is Members[number][typeof MetaKey]["tag"] => byTag.has(tag);
  const is = (value: { readonly _tag: string }): value is Members[number]["Type"] => {
    const definition = byTag.get(value._tag);
    return definition !== undefined && Schema.is(definition)(value);
  };
  return {
    origin,
    definitions: members,
    schema: Schema.Union(members),
    tags: members.map((m) => m[MetaKey].tag).filter(isTag),
    isTag,
    is,
    definitionOf: (tag: string) => Option.fromNullishOr(byTag.get(tag)),
    actorOf: (event: { readonly _tag: string }) => {
      const definition = byTag.get(event._tag);
      return definition === undefined ? Option.none<string>() : actorValue(definition[MetaKey], event);
    },
    piiFieldsOf: (tag: string): ReadonlyArray<string> => byTag.get(tag)?.[MetaKey].pii ?? [],
    isAttempt: (tag: string) => byTag.get(tag)?.[MetaKey].attempt === true,
  };
};

/**
 * The data-level well-formedness checks (plan 09 T3 P1, P2, P3, P6, plus naming and uniqueness), as messages.
 * Core's tests run it over core's set; `runPluginContractTests` runs it over every plugin's `events`.
 */
export const problems = (
  definitions: ReadonlyArray<Any>,
  options?: { readonly notPersonal?: ReadonlyArray<string> },
): ReadonlyArray<string> => [/* §3.2.1 */];
```

To verify in ticket 02 rather than assume:
- `Schema.Union(members)` accepts `ReadonlyArray<Any>`.
- The `Registry<E>` returned by `make` is assignable to the interface above. If TypeScript widens `tags` to `string[]`,
  keep plan 09's `.filter(isTag)` (it narrows through the predicate).
- `Schema.is(definition)` narrows to `Members[number]["Type"]` through the `byTag` lookup. If it does not, give the
  predicate a looser declared type and keep validation as the proof.

#### 3.2.1 What `problems` checks

| Check | Rule | Source |
|---|---|---|
| P1 | `meta.tag` equals the schema's `_tag` literal (`fields._tag.ast.literal`) | plan 09 T3 P1 |
| P2 | a `Field`/`Prefixed` actor names a key of the event | T3 P2 |
| P3 | every `pii` entry is a key of the event | T3 P3 |
| P6 | a field named like free text (`/reason\|note\|justification\|description\|comment\|message\|text/i`) whose schema is a non-literal, unbranded string is in `pii` or in `options.notPersonal` (`"<tag>.<field>"`) | T3 P6 (`EventDefinition.test.ts:146-182`) |
| N | the tag matches `^auth\.[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$`; all 97 tags do | new (third-party naming) |
| U | no tag appears twice in the list | T3 P1 |
| R | the tag is not `"awthaq.foreignEvent"` (reserved) | new |

The type system already enforces P2, P3 and the blankability of `pii` at definition time (plan 09 §3.6). `problems`
repeats them as data, so a hand-built or JavaScript-authored plugin is checked too.

### 3.3 A plugin declares its events (`packages/core/src/AuthPlugin.ts`)

This mirrors `userFields`/`"~userFields"` (`AuthPlugin.ts:125-136`) exactly.

```ts
export interface Class<
  Self, Id extends string, Shape, Groups extends HttpApiGroup.Constraint,
  Fields extends UserFields.Declarations = {}, Limits extends RateLimitModel.Table = {},
  Records extends AnyRecords = NoRecords, Points extends Layer.Layer<never, unknown, unknown> = Layer.Layer<never>,
  Events extends ReadonlyArray<EventDefinition.Any> = readonly [],          // new, last
> extends Context.ServiceClass<Self, Key<Id>, Shape> {
  // ...
  /** ADR-EA-049: the event definitions this plugin publishes, declared statically (none when it publishes none). */
  readonly events: ReadonlyArray<EventDefinition.Any>;
  /** Type-only: the declared list, which `Auth.EventsOf` folds. Never assigned, for the reason `"~userFields"` is not. */
  readonly "~events"?: Events;
}

// Any (:339-371):  readonly events?: ReadonlyArray<EventDefinition.Any>;
// Service options (:470-500):  readonly events?: Events;   with  const Events extends ReadonlyArray<EventDefinition.Any> = readonly []
// Implementation (:511-545):   events: options.events ?? noEvents   (const noEvents: ReadonlyArray<EventDefinition.Any> = [])
```

A plugin module, using two-factor as the example (ticket 16):

```ts
// packages/two-factor/src/TwoFactorEvents.ts: moved verbatim from AuthEventSchemas.ts:1609-1705
import { EventDefinition } from "@awthaq/core";
import * as Schema from "effect/Schema";

/** Published when a pending secret is confirmed with a first valid code — the factor is now active. */
export const TwoFactorEnabledEvent = EventDefinition.define(
  "auth.twoFactor.enabled",
  { userId: EventDefinition.UserId },
  { actor: EventDefinition.Actor.field("userId"), pii: [] },
);
export type TwoFactorEnabledEvent = typeof TwoFactorEnabledEvent.Type;
// ... TwoFactorDisabledEvent, TwoFactorVerifiedEvent, TwoFactorChallengeFailedEvent (attempt: true), ... six more

/** Every event this plugin publishes; the plugin class declares it as `events`. */
export const events = [
  TwoFactorEnabledEvent, TwoFactorDisabledEvent, TwoFactorVerifiedEvent, TwoFactorChallengeFailedEvent,
  TwoFactorRecoveryCodeUsedEvent, TwoFactorRecoveryCodesRegeneratedEvent, TwoFactorLockedEvent,
];
```

The constant names stay verbatim, so the migration is a namespace swap: `AuthEvents.TwoFactorEnabledEvent` becomes
`TwoFactorEvents.TwoFactorEnabledEvent` (Q6). The `events` array is not a tuple, and needs no `as const`: `EventsOf`
only reads `Events[number]`.

The class (`packages/two-factor/src/TwoFactor.ts`) gains `events: TwoFactorEvents.events`. A publish site
(`SecondFactor.ts:350`) changes from `events.publish({ _tag: "auth.twoFactor.enabled", userId })` to
`events.emit(TwoFactorEvents.TwoFactorEnabledEvent, { userId })`.

### 3.4 Composition: `Auth.EventsOf<P>`, `Built.events`, `Built.eventsLayer`, `Auth/EventTagConflict`

```ts
// packages/core/src/Auth.ts
type EventsOfPlugin<Plugin> = Plugin extends { readonly "~events"?: infer Events }
  ? NonNullable<Events> extends ReadonlyArray<infer D extends EventDefinition.Any>
    ? EventDefinition.TypeOf<D>
    : never
  : never;

/** ADR-EA-049: every event a composition can publish: core's plus each composed plugin's. Narrowable by `_tag`. */
export type EventsOf<P extends ReadonlyArray<AuthPlugin.Any>> = AuthEvents.AuthEvent | EventsOfPlugin<P[number]>;

/** ADR-EA-049: two declarations of one event tag (core's included). A plugin-authoring defect, found at link time. */
export class EventTagConflict extends Data.TaggedError("Auth/EventTagConflict")<{
  readonly tag: string;
  readonly firstOwner: string;   // "core" (CORE_OWNER, :947) or a plugin id
  readonly secondOwner: string;
  readonly message: string;
}> {}

const composeEvents = (order: ReadonlyArray<AuthPlugin.Any>) => {
  const owners = new Map<string, string>([
    [AuthEvents.ForeignEventTag, CORE_OWNER],   // reserved
    ...AuthEvents.coreDefinitions.map((d): [string, string] => [d[EventDefinition.MetaKey].tag, CORE_OWNER]),
  ]);
  for (const plugin of order) {
    for (const definition of plugin.events ?? []) {
      const tag = definition[EventDefinition.MetaKey].tag;
      const first = owners.get(tag);
      if (first !== undefined) {
        throw new EventTagConflict({
          tag, firstOwner: first, secondOwner: plugin.id,
          message: `awthaq: E_EVENT_TAG_CONFLICT: event "${tag}" is declared by "${first}" and by plugin "${plugin.id}"`,
        });
      }
      owners.set(tag, plugin.id);
    }
  }
  return EventDefinition.make(
    [...AuthEvents.coreDefinitions, ...order.flatMap((plugin) => plugin.events ?? [])],
    "composition",
  );
};

// Built<P> (:537-597), beside userFields/userFieldsLayer:
/** ADR-EA-049: core's events plus every composed plugin's declared events, typed by the tuple. */
readonly events: EventDefinition.Registry<EventsOf<P>>;
/** Provides `AuthEvents.EventRegistry` for `events`. Provide it last, like `userFieldsLayer`; `TestAuth.layer` does. */
readonly eventsLayer: Layer.Layer<never>;

// Manifest (:395-420):
readonly events: ReadonlyArray<ManifestEvent>;
export interface ManifestEvent {
  readonly tag: string;
  readonly owner: string;                          // "core" or a plugin id
  readonly actor: EventDefinition.EventMeta["actor"];
  readonly pii: ReadonlyArray<string>;
  readonly attempt: boolean;
}

// make (:1138-1161), after checkMigrationNames(order):
const events = composeEvents(order);
return { /* ... */, events, eventsLayer: AuthEvents.eventRegistryLayer(events), manifest: buildManifest(order, events) };
```

`make`'s implementation is typed against the widest shapes (`Registry<AnyEvent>`), and its overload declares
`Registry<EventsOf<P>>`. That is the pattern `userFields` already uses: the overload's return type is assignable to the
implementation's, so the two are compatible. Ticket 02 compiles a reduced copy of the overload to prove it.

The composed registry is static. It is a pure function of the tuple, so the manifest, webhook filter validation, the CLI
and `AuthEvents.typed` read it without building any layer. That is why it is not a `Layer.effectDiscard` registry (BEH-EA-024)
but the statically composed kind ADR-EA-035 introduced for user fields. ADR-EA-049 decision 3 and the ADR-EA-012
amendment state this.

### 3.5 `AuthEvents` (`packages/core/src/AuthEvents.ts`) and the type-level effect

```ts
// AuthEventSchemas.ts (leaf), re-exported by `export * from "./AuthEventSchemas.ts"` (AuthEvents.ts:54)
/** An event core may hold without knowing its shape: any registered or stored event. */
export interface AnyEvent { readonly _tag: string }
export type Published<E extends AnyEvent = AuthEvent> = E & EventMetadata;     // was `E extends AuthEvent` (:1878)
export type PublishedAny = Published<AnyEvent>;
export const CoreRegistry = EventDefinition.make([/* the 24 core definitions */], "core");
export const coreDefinitions = CoreRegistry.definitions;
/** ADR-EA-049: the composition's registry (`auth.eventsLayer`); core's alone by default. Read by webhooks and Retention. */
export const EventRegistry = Context.Reference<EventDefinition.Registry<AnyEvent>>("awthaq/core/EventRegistry", {
  defaultValue: () => CoreRegistry,
});
export const eventRegistryLayer = (registry: EventDefinition.Registry<AnyEvent>) => Layer.succeed(EventRegistry, registry);

// AuthEvents.ts
export interface AuthEventsShape {
  /** BEH-EA-098: core's own events. */
  readonly publish: (event: AuthEvent) => Effect.Effect<void>;
  /**
   * ADR-EA-049: any declared event, through its definition: `events.emit(TwoFactorEvents.TwoFactorEnabledEvent, { userId })`.
   * The same guarantees as `publish`: one envelope, the audit row (actor column, declared personal data recorded with
   * the row), the lane its definition declares (ADR-EA-037), then the bus.
   */
  readonly emit: <D extends EventDefinition.Any>(definition: D, input: EventDefinition.Input<D>) => Effect.Effect<void>;
  /** BEH-EA-102: every event of the composition, unnarrowed. Narrow with `AuthEvents.is(...)`. */
  readonly stream: Stream.Stream<PublishedAny>;
  readonly subscribe: Effect.Effect<Stream.Stream<PublishedAny>, never, Scope.Scope>;
  readonly droppedCount: Effect.Effect<number>;
}

/** What `emit` does with a tag a *composed* registry does not hold (its plugin did not list it in `events`). */
export const UndeclaredEventPolicy = Context.Reference<"warn" | "die">("awthaq/core/UndeclaredEventPolicy", {
  defaultValue: () => "warn",
});
export class UndeclaredEvent extends Data.TaggedError("AuthEvents/UndeclaredEvent")<{
  readonly tag: string; readonly message: string;
}> {}

type Selector = AuthEventTag | EventDefinition.Any;
type Select = Selector | ReadonlyArray<Selector>;
type One<S extends Select> = S extends ReadonlyArray<infer Item> ? Item : S;
type EventOfSelector<S> = S extends AuthEventTag ? EventOf<S> : S extends EventDefinition.Any ? EventDefinition.TypeOf<S> : never;
/** What a handler or guard for `S` receives: the selected events with their envelope. */
export type Handled<S extends Select> = Published<EventOfSelector<One<S>>>;

/** A guard over the open stream, by core tag(s) and/or definition(s). A definition is validated (`Schema.is`), not trusted. */
export const is = <const S extends Select>(select: S) => (event: PublishedAny): event is Handled<S> => /* ... */;
export const on = <const S extends Select>(select: S, handler: (event: Handled<S>) => Effect.Effect<void, unknown>) => /* ... */;
export const onBatch = /* the same selectors, over `subscribe` */;

/** ADR-EA-049: the composition-typed view (the `Users.typedFields(auth.userFields)` precedent). */
export const typed = <E extends AnyEvent>(registry: EventDefinition.Registry<E>) => ({
  is: (event: PublishedAny): event is Published<E> => registry.is(event),
  subscribe: /* AuthEvents.subscribe, filtered by registry.is: Stream<Published<E>> */,
  on: <const Tag extends E["_tag"]>(
    select: Tag | ReadonlyArray<Tag>,
    handler: (event: Published<Extract<E, { readonly _tag: Tag }>>) => Effect.Effect<void, unknown>,
  ) => /* Layer<never, never, AuthEvents> */,
});
```

`deliver` (`AuthEvents.ts:211-272`) becomes `deliver(event, definition, parent)`:
1. It stamps the envelope as today.
2. It calls `auditLog.record(published, definition)`.
3. It takes the lane from `definition[MetaKey].attempt` (today `isAttemptEvent(event._tag)`, `:264`).
4. It runs `countEvent` only when `CoreRegistry.is(event)`.

`publish(event)` passes `CoreRegistry.definitionOf(event._tag)`; the event is typed `AuthEvent`, so the lookup always
finds it, and a miss is `Defects.invariantViolation`.

`emit(definition, input)` runs:
1. `Effect.orDie(definition.makeEffect(input))`, the same defect policy as today's `Effect.orDie(encodeEvent(...))`.
2. The undeclared-tag check: when the provided `EventRegistry.origin === "composition"` and `!registry.isTag(tag)`, log
   `auth.event.undeclared` and count it under `"warn"`, or `Effect.die(new UndeclaredEvent(...))` under `"die"`.
   `TestAuth` sets `"die"`. Nothing is checked against core's default registry, which knows no plugin.
3. `deliver`.

**Type-level effect** (the brief's question, answered):

| Type or member | Today | After |
|---|---|---|
| `AuthEvent` | 97-member union | **24-member** union of core-owned events; still closed and narrowable |
| `AuthEventTag` | 97 literals | 24 literals |
| `EventOf<Tag extends AuthEventTag>` | any tag | core tags. A plugin event is `EventDefinition.TypeOf<typeof Def>`; a composition's is `Extract<Auth.EventsOf<P>, { _tag: T }>` |
| `publish(event: AuthEvent)` | every tag | unchanged signature. A plugin tag literal **no longer type-checks**, which is the loud migration path |
| `emit` | — | `<D>(definition: D, input: Input<D>)`. Brands are enforced and `_tag` is filled in |
| `Published<E>` | `E extends AuthEvent` | `E extends AnyEvent`, default `AuthEvent`, plus `PublishedAny` |
| `stream`, `subscribe` | `Published` (closed) | `PublishedAny` (open). A consumer that narrows fails to compile, and a forwarder keeps every event (Q1) |
| `on`, `onBatch`, `Handled` | core tags | core tags and/or definitions, mixed, handler typed exactly |
| `Auth.EventsOf<P>` | — | `AuthEvent \| <each plugin's declared events>` |
| `Built.events` | — | `EventDefinition.Registry<EventsOf<P>>`, and `AuthEvents.typed(auth.events)` narrows over it |
| `AuditLogRecord.eventTag` / `payload` | `AuthEventTag` / `AuthEvent` | `string` / `AuthEvent \| ForeignEvent` (narrowable) |
| `EventTransport.deliver` | `ReadonlyArray<Published>` | `ReadonlyArray<PublishedAny>` |
| list, replay, purge, Retention and `EventRelay` tag filters | `AuthEventTag` | `string` (Retention validates against the registry) |

Module augmentation would have kept `publish` working for every tag with no churn: each plugin would declare
`declare module "@awthaq/core" { interface AuthEventRegistry { ... } }`. It is rejected in ADR-EA-049 (§6.2):
- the union would follow the program's imports, not the composition;
- it is a global, ambient mechanism that no other extension point uses;
- the runtime would still need the composed registry, so type and runtime would have two sources of truth.

### 3.6 `AuditLog` (`packages/core/src/AuditLog.ts`): independent of the composition

```ts
// AuthEventSchemas.ts
export const ForeignEventTag = "awthaq.foreignEvent";
/** ADR-EA-049: a stored event whose tag core does not define: a plugin's (composed or removed). Core decodes nothing. */
export const ForeignEvent = Schema.TaggedStruct(ForeignEventTag, {
  /** The stored tag (`AuditLogRecord.eventTag`). */
  tag: Schema.String,
  /** The event's stored fields, without `_tag`, `version` and `meta`. */
  fields: Schema.Record(Schema.String, Schema.Unknown),
});
export type ForeignEvent = typeof ForeignEvent.Type;

// AuditLog.ts
export interface AuditLogRecord { /* ... */ readonly eventTag: string; readonly payload: AuthEvent | ForeignEvent }
export interface AuditLogListInput { readonly eventTag?: string; /* ... */ }
export interface AuditLogReplayInput { readonly eventTag?: string; /* ... */ }

export interface AuditLogShape {
  /** Called by `AuthEvents` for every event. A core event is encoded with core's definition; any other with the one given. */
  readonly record: {
    (event: Published): Effect.Effect<void, StoreUnavailable>;
    <D extends EventDefinition.Any>(event: Published<EventDefinition.TypeOf<D>>, definition: D): Effect.Effect<void, StoreUnavailable>;
  };
  // list / replay / pseudonymizeActor unchanged; purge's eventTags/exceptTags become ReadonlyArray<string>
}

const StoredMeta = Schema.Struct({
  version: Schema.optional(Schema.Number),
  meta: Schema.optional(Schema.Struct({
    traceId: Schema.optional(Schema.String), spanId: Schema.optional(Schema.String),
    ip: Schema.optional(Schema.String), userAgent: Schema.optional(Schema.String),
    /** ADR-EA-049: the fields this event declared personal data when it was written. */
    pii: Schema.optional(Schema.Array(Schema.String)),
  })),
});

/** Rows written before ADR-EA-049 carry no `meta.pii`: these three tags were the only ones then declaring personal data. Frozen. */
const PRE_ADR_049_PII: Readonly<Record<string, ReadonlyArray<string>>> = {
  "auth.admin.impersonationStarted": ["reason"],
  "auth.admin.userBanned": ["reason"],
  "auth.admin.organizationSuspended": ["reason"],
};
```

Behaviour:

- **`record`.** `toStoredRow(published, definition)` encodes with `Schema.encodeUnknownEffect(definition)`. That keeps
  only the declared fields, as `encodeEvent` does today (`:176-205`); the encoded value is narrowed with a record guard,
  not an assertion. The actor is `actorValue(definition[MetaKey], published)`. When `definition[MetaKey].pii` is
  non-empty, the stamp includes `meta.pii`. A row with nothing declared is byte-identical to today's, and a test asserts
  this for `auth.user.created`. The overloads share one implementation,
  `(event: PublishedAny, definition?: EventDefinition.Any)`, which satisfies both signatures without an assertion. With
  no definition, it is core's (`CoreRegistry.definitionOf`).
- **`decodeRow` (`:212-250`).**
  - `isEventTag(row.eventTag)`: unchanged. The row decodes through core's union, and a failure is `AuditLogDecodeError`.
  - Any other tag: the parsed JSON must be an object (else `AuditLogDecodeError`), and the payload is
    `ForeignEvent.make({ tag: row.eventTag, fields })`, with `_tag`, `version` and `meta` removed.
  - A row of a plugin that is still composed and a row of a plugin that was removed are read the same way. `AuditLog`
    reads no registry.
- **`scrubRow` (`:262-282`).** The fields blanked are `meta.pii` when the row has it. Otherwise they are
  `PRE_ADR_049_PII[row.eventTag] ?? []` plus `piiFieldsOf(row.eventTag)` (core's registry, which keeps a future core
  event with `pii` correct for rows that predate it). The function stays pure and total (`Schema.decodeUnknownOption(StoredMeta)`).
  `AuditLogStoreSql`'s `rewriteReferencing` applies it unchanged.
- **`payloadAs(definition)(record)`, new: `Option<TypeOf<D>>`.**
  - `none` unless `record.eventTag` is the definition's tag.
  - For a `ForeignEvent`: `Schema.decodeUnknownOption(definition)({ ...fields, _tag: tag })`.
  - For a core payload: `Schema.is(definition)(payload)`.
- **`toPublished` (`:91`).** It returns `PublishedAny` and unwraps a `ForeignEvent` into
  `{ ...fields, _tag: tag, ...envelope }`, so the relay delivers the event as published.
- **ADR-EA-030 decision 5** ("a row that no longer decodes stops the relay") now covers a core row that fails to decode,
  and a row that is not a JSON object. A plugin row is carried opaquely, and its plugin judges its shape (amendment in
  §6.3). `DataExport`'s `catchTag("AuditLogDecodeError", Effect.die)` (`DataExport.ts:129`) can no longer be tripped by a
  removed plugin's history.

### 3.7 Webhooks, Retention, `RedactionGuard`, `eventSamples.ts`

- **`WebhookPayload` (`packages/webhooks/src/WebhookPayload.ts`).**
  - `toBody(event: AuthEvents.PublishedAny, options, pii: ReadonlyArray<string>)` (`:69-101`): the caller passes the
    registry's `piiFieldsOf(event._tag)`.
  - `subjectUserId(event: AuthEvents.PublishedAny)` (`:103`): the type widens and the logic stays.
  - `knownEventTags` (`:151`) is **deleted**.
  - `unknownPattern(patterns, tags)` (`:162-163`) takes the tag list.
- **`Webhooks` (`Webhooks.ts:591-599`).** The layer's `make` reads `yield* AuthEvents.EventRegistry` once, and
  `validateTags` calls `WebhookPayload.unknownPattern(tags, registry.tags)`. A family such as `auth.organization.*` is
  accepted exactly when organization is composed and `auth.eventsLayer` is provided.
- **`WebhookDelivery` (`:68-133`).** `transportLayer` reads the registry and `enqueue` uses it. **An event whose tag the
  registry does not hold is not enqueued**: a removed plugin's history, or a host that forgot `auth.eventsLayer`. Each
  skip logs `auth.webhooks.unknownEvent` with the tag. This is fail-closed: without a definition there is no `pii` list,
  and webhooks never guesses (BEH-EA-277).
- **`Retention` (`Retention.ts:38`, `:47`, `:119-145`).** `AuditRetentionRule.tags: ReadonlyArray<string>`. Where
  `Retention` reads its config, a tag the `EventRegistry` does not hold is
  `Defects.invalidConfiguration("Retention.auditLog.rules", ...)`. A typo is refused, as it is today by the
  `AuthEventTag` type.
- **`RedactionGuard.layerEvents` (`packages/test/src/RedactionGuard.ts:242-252`).** `guard.inspectEvent(event._tag, event)`
  inspects the published value: the stored row holds the encoded event plus `meta` (trace ids, IP, user agent), so this
  is the same content. `AuthEvents.payloadOf` (`:249`) throws for a non-core event and is no longer used here.
- **`packages/core/test/support/eventSamples.ts`.** The mapped type stays and covers core's 24 tags (477 lines become
  about 170). Plugin samples are deleted, not moved. Each plugin's existing tests already publish and assert their events,
  and the per-definition checks run in the contract runner (§3.9).

### 3.8 What stays in core, and why (24 events)

| Group | Tags | Why it cannot move |
|---|---|---|
| Core publishes it | `auth.token.replay`, `auth.user.{created, signedIn, deleted, dataExported}`, `auth.account.linked`, `auth.session.*` (6), `auth.rateLimit.exceeded`, `auth.mail.failed` | its publisher is a core module (`Verification`, `SignUp`, `SignIn`, `AccountErasure`, `DataExport`, `FederatedIdentity`, `Sessions`, `RateLimits`, `MailDispatch`) |
| Shared | `auth.user.signInFailed`, `auth.password.changed`, `auth.admin.actionDenied` | published by several packages: no single owner, and no plugin depends on another to publish |
| Read by core by tag | `auth.passkey.counterAnomaly`, `auth.admin.impersonationDenied` | core's `SecuritySignals` rules (`SecuritySignals.ts:119-165`) name them and cannot import a plugin |
| The CLI's | `auth.admin.{seeded, seedRefused}`, `auth.import.{completed, failed}` | the CLI writes into the **host's** audit table through the host's `AuthEvents` (`Seed.ts:82`, `Import.ts:367`). The CLI is no plugin of the host's composition, so no `Auth.make` exists through which it could contribute. Every host must decode these rows as core events |
| qadi's decision sink | `auth.authz.denied` | published by `DecisionSinkAudit` (`packages/qadi/src/DecisionLogging.ts:61-84`), a host-composed layer and not a plugin: a host may run it without composing any qadi plugin (ADR-EA-009 makes authorization a core concern) |

The CLI's listing reads `manifest.events`, which is static (`awthaq plugin list --events`). `awthaq doctor` and config
loading classify `Auth/EventTagConflict` as a link problem (ticket 07).

### 3.9 Module layout after this plan

| Module | Role | Exported? |
|---|---|---|
| `packages/core/src/EventDefinition.ts` (new; replaces `internal/eventDefinition.ts`) | `define`, `Actor`, `Any`, `TypeOf`, `Input`, `Registry`, `make`, `problems`, `actorValue`, `MetaKey`, `EventMetaSchema`, `UserId`, `SessionId` | `export * as EventDefinition` |
| `packages/core/src/AuthEventSchemas.ts` | core's 24 definitions, `CoreRegistry`, `coreDefinitions`, core readers (`eventTags`, `isEventTag`, `actorOf`, `piiFieldsOf`, `isAttemptEvent`), `AnyEvent`, `Published`, `PublishedAny`, `ForeignEvent`, `EventRegistry`, `eventRegistryLayer`, the stored codec | via `AuthEvents` (`export *`) |
| `packages/core/src/AuthEvents.ts` | `publish`, `emit`, `stream`, `subscribe`, `is`, `on`, `onBatch`, `typed`, `UndeclaredEventPolicy`, `UndeclaredEvent` | `AuthEvents` |
| `packages/core/src/AuditLog.ts` | definition-driven rows, `meta.pii`, `ForeignEvent` reading, `payloadAs` | `AuditLog` |
| `packages/core/src/Auth.ts` | `EventsOf`, `EventTagConflict`, `composeEvents`, `Built.events`, `Built.eventsLayer`, `Manifest.events` | `Auth` |
| `packages/<pkg>/src/<Name>Events.ts` (11 new) | that package's definitions and `events` array | `export * as <Name>Events` |
| `packages/test/src/TestAuth.ts` | provides `built.eventsLayer` and `UndeclaredEventPolicy: "die"`; contract runner events check | `TestAuth` |

The 11 new modules are `DeviceAuthorizationEvents`, `RolesEvents`, `UserClaimsEvents` (qadi), `PasswordEvents`,
`ApiKeyEvents`, `TwoFactorEvents`, `ScimEvents`, `SamlEvents`, `WebhookEvents`, `AdminEvents` and `OrganizationEvents`.

### 3.10 Deviations from plan 09, and why

| # | Plan 09 said (§3.7, §4.6) | This plan | Why |
|---|---|---|---|
| D1 | `AuditLog` encodes through `registry.schemaOf(tag)` and decodes `list`/`replay` through the composed `EventRegistry` | `AuditLog` reads no registry. It encodes with the definition `emit` passes; a non-core row is read as `ForeignEvent`; a plugin decodes its own rows with `payloadAs` | No new requirement on `AuditLog.layer` (91 sites unchanged) and no forgotten-wiring failure mode. F1: plan 09's version cannot erase a removed plugin's personal data |
| D2 | `ForeignEvent { _tag: string; data: Json }`, only for a removed plugin's rows; `payload: AuthEvent \| ForeignEvent` | `ForeignEvent` has the fixed tag `"awthaq.foreignEvent"` and is used for every non-core row | F2/§2.6.1: an open `_tag` member destroys narrowing on every record consumer |
| D3 | not covered | the row records `meta.pii`; rows written before fall back to a frozen three-entry table | F1 (ADR-EA-029 decision 2) |
| D4 | "the `Published` stream's element type widens" (R8); core `on(tag)` keeps narrowing | `stream`/`subscribe` are typed `PublishedAny`, the guard `AuthEvents.is(...)` validates, and `on`/`onBatch` take mixed selectors | §2.6.1: widening the union is impossible without losing narrowing; an open element type plus validating guards is sound. The core-only alternative silently drops plugin events for forwarders (Q1) |
| D5 | `emit(definition, event: D["Type"])` | `emit(definition, input: Input<D>)`, with `_tag` filled by the constructor (`makeEffect`) | no `_tag` duplicated at 73 publish sites; brands still enforced (§2.6.3) |
| D6 | `EventsOf<P>` only | `EventsOf<P>` plus `Built.events` typed by it, plus `AuthEvents.typed(auth.events)` | gives the composed union a consumer: hosts, BDD worlds, the template test (the `Users.typedFields` precedent) |
| D7 | qadi: move `claimsUpdated` only if `authz.denied` can move too, "otherwise both stay" | `auth.user.claimsUpdated` moves to the `UserClaims` plugin; `auth.authz.denied` stays | each has exactly one publisher. `claimsUpdated` is published only inside the composed `UserClaims` plugin (`UserClaims.ts:134`); `authz.denied` by a host layer that is no plugin |
| D8 | admin moves 11 (including the two suspension events) | admin moves 9; the 2 suspension events go to organization | plan 04 moved the publisher to `OrganizationDirectory` (`:408`, `:433`) |
| D9 | organization moves 21; password's 4 "unless plan 01 moved them" | organization moves 27 (plan 04 added 4); password moves its 4 (plan 01 left them in password: `Password.ts:1297`, `:1475`, `:1486`, `:1556`) | re-measured (§2.3) |
| D10 | a new ADR, "next free number (037)" | **ADR-EA-049** | the orchestrator's reservation |
| D11 | not covered | `UndeclaredEventPolicy` (`"warn"` by default, `"die"` in `TestAuth`) | catches the likeliest authoring mistake of the new extension point: a plugin emits a definition it did not list in `events` |
| D12 | not covered | the contract runner checks every plugin's `events` (`EventDefinition.problems`) | G7: replaces the 73 hand samples and plan 09's per-member loops, data-driven |
| D13 | `WebhookPayload.knownEventTags`/`unknownPattern` "read the registry service" | the same, plus **fail closed**: an unknown tag is not enqueued | without a definition, webhooks cannot know which fields are personal data (BEH-EA-277) |
| D14 | not covered | Retention rule tags become `string`, validated against the registry | otherwise a plugin tag could not have a retention window after the move |
| D15 | phase 5 "after plans 04 and 08" | after plan 25 (both 04 and 08 have landed) | plan 25 fixes live races in the same plugin packages (§8) |

---

## 4. Phased migration

Gates, named once:
- **Phase gate:** `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`. Treat knip as passing when
  every file it reports is under `.reports/` (`.planning/IMPLEMENTING.md`).
- **+BDD:** also `pnpm test:bdd`, for any ticket that touches `features/` or changes a type the features compile against.
- **+PG:** also `pnpm test:pg`.
- **Plan gate:** `pnpm check`, plus `pnpm test:pg`.

Run `pnpm build` before `pnpm test` whenever a core ticket changes what plugin packages import.

Each ticket that touches `packages/` adds `.changeset/plugin-owned-events-NN.md`. The CI runs `changeset status`, and
every breaking change carries `Migration:` (§6.7). Order: Phase 0 → 1 (tickets 04–10 in order; 08 and 09 may swap)
→ 2 (11–21, smallest first, organization last) → 3.

### 4.1 Phase 0: preconditions, baseline, spike, ADR (tickets 01–03)

#### 01 — Baseline and tracker
- **Files:** `.scratch/29-plugin-owned-events/issues/01-…25-*.md` (from §4.6, `Status: ready-for-agent`, with
  `Blocked by:` lines); `.scratch/29-plugin-owned-events/baseline.md`; `.scratch/09-event-definitions/issues/01-relay-scrub-declared-pii.md`
  (recreated from plan 09 §10 Q4, F5).
- **Change:**
  - Record every §2.1 number in `baseline.md`.
  - Run `pnpm build`, then record `wc -l packages/core/lib/AuthEventSchemas.d.ts`.
  - Record the wall time of `pnpm typecheck`, and the test counts of `pnpm test` and `pnpm test:bdd`.
  - Record the commit hash and the §2.3 move table, plus the script that measured the 1,156 moved lines.
- **Done when:** `baseline.md` holds all of the above; 25 issue files exist; the plan 09 Q4 file exists with `Status: needs-triage`.
- **Gate:** none (no code).

#### 02 — Spike: the type-level interface, pinned as a permanent type test
- **Files:** `packages/core/test/EventDefinition.plugin.types.test.ts` (new, the `*.types.test.ts` convention: checked by
  `tsc -p tsconfig.test.json`, nothing executes).
- **Change:** prove each of the following with `@ts-expect-error` lines and assignability constants, against today's
  `internal/eventDefinition.ts` plus local stand-ins for the new names:
  - (a) §2.6.3: `Input<D>` omits `_tag` and rejects a bare string for a `UserId` field. A generic
    `emit<D extends Any>(d, input)` compiles to `Effect<void>` with no `as`, given `Any`'s `never` service pins. If
    another constraint is needed (for example `Schema.Codec<unknown, unknown, never, never>`), record it and use it in
    ticket 04.
  - (b) `Schema.Union` accepts `ReadonlyArray<Any>`.
  - (c) An `EventsOf`-style fold over `"~events"?` on two stand-in plugin classes gives a union whose `switch (e._tag)`
    reads each member's fields.
  - (d) `Handled<readonly ["auth.session.issued", typeof LocalDef]>` is `Published<EventOf<"auth.session.issued"> | TypeOf<typeof LocalDef>>`.
  - (e) `AuthEvent | ForeignEvent` (fixed literal) narrows. A union with `{ readonly _tag: string }` does not: an
    `@ts-expect-error` on the field read, with a comment that this is why the bus is typed open (§2.6.1).
  - (f) A reduced copy of `make`'s overload pattern: an implementation returning `Registry<AnyEvent>` under an overload
    declaring `Registry<EventsOf<P>>` compiles.
- **Done when:** every case compiles or fails exactly as written; the ticket records the findings, including any
  constraint change for (a) or (f).
- **Gate:** `pnpm typecheck`.

#### 03 — ADR-EA-049 lands as Proposed
- **Files:** `spec/decisions/049-plugins-own-event-definitions.md` (new, the text in §6.2, `Status: Proposed`);
  `spec/decisions/index.yaml` (entry `ADR-EA-049`).
- **Done when:** `pnpm spec:verify` is green and the index lists ADR-EA-049.
- **Gate:** `pnpm spec:verify`.

### 4.2 Phase 1: the core interface, with nothing moved yet (tickets 04–10)

After this phase every event is still core's: `AuthEvents.eventTags.length === 97`. The new interface is complete and
exercised by test-local definitions and by the template.

#### 04 — `EventDefinition` becomes a public core module
- **Files:**
  - `packages/core/src/EventDefinition.ts` (new, via `git mv packages/core/src/internal/eventDefinition.ts`);
  - `packages/core/src/index.ts`;
  - `packages/core/src/AuthEventSchemas.ts`;
  - `packages/core/test/EventDefinition.test.ts`, `packages/core/test/EventDefinition.types.test.ts`;
  - `.changeset/plugin-owned-events-04.md`.
- **Change:**
  1. In the moved module (§3.2), rename `defineEvent` to `define` and `registry` to `make` (with `origin`). Add `Any`,
     `TypeOf`, `Input`, `Registry<E>`, `problems` (§3.2.1), and the `UserId`/`SessionId` re-exports from `Ids`. `make`
     returns `definitions`, `definitionOf`, `is` and `origin` on top of plan 09's readers.
  2. `index.ts`: `export * as EventDefinition from "./EventDefinition.ts";`, in alphabetical order before `EventRelay`.
  3. `AuthEventSchemas.ts`:
     - import `* as EventDefinition`;
     - replace the local `UserIdSchema`/`SessionIdSchema` (`:37-38`) with `EventDefinition.UserId`/`.SessionId`;
     - turn every `defineEvent(` into `EventDefinition.define(`;
     - turn `registry([...])` (`:1733`) into `export const CoreRegistry = EventDefinition.make([...], "core")`;
     - add `coreDefinitions`, `AnyEvent`, `PublishedAny`, the widened `Published<E extends AnyEvent = AuthEvent>`
       (`:1878`), `EventRegistry` and `eventRegistryLayer` (§3.5);
     - point the existing reader exports at `CoreRegistry`.
  4. Tests: switch imports to `../src/EventDefinition.ts`. T3's hand loops for P1, P2, P3 and P6
     (`EventDefinition.test.ts:81-182`) become
     `assert.deepStrictEqual(EventDefinition.problems(AuthEvents.coreDefinitions, { notPersonal: ["auth.authz.denied.reason"] }), [])`.
     Add one unit test per problem kind with a throwaway definition (replace, don't layer).
- **Done when:**
  - `test -e packages/core/src/internal/eventDefinition.ts` fails;
  - `grep -rn 'defineEvent\|internal/eventDefinition' packages features --include=*.ts | grep -v /lib/` finds 0;
  - `AuthEvents.eventTags.length === 97`;
  - the problem-kind tests pass.
- **Changeset:** `"@awthaq/core": minor`. "New public `EventDefinition` module (`define`, `Actor`, `make`, `problems`,
  `UserId`/`SessionId`); `AuthEvents.EventRegistry`, `AnyEvent`, `PublishedAny`." No migration needed: additive.
- **Gate:** phase gate.

#### 05 — `AuditLog` no longer needs the event set: definition-driven rows, `meta.pii`, `ForeignEvent`
- **Files:**
  - `packages/core/src/AuditLog.ts` (`:76`, `:87`, `:91`, `:104`, `:113`, `:120`, `:152-153`, `:162-282`);
  - `packages/core/src/AuthEventSchemas.ts` (`ForeignEventTag`, `ForeignEvent`);
  - `packages/core/src/EventRelay.ts` (`:48`, `:57`, `:74`), `packages/core/src/Retention.ts` (`:38`, `:47`, `:131`);
  - `packages/webhooks/src/WebhookPayload.ts` (`:69`, `:103`: parameter types only),
    `packages/webhooks/src/WebhookDelivery.ts` (`:68-70`: parameter type only);
  - `packages/core/test/AuditLog.test.ts`, `packages/core/test/EventRelay.test.ts`;
  - `.changeset/plugin-owned-events-05.md`.
- **Change:** §3.6, in this order:
  1. `ForeignEvent`, the widened record and input types, and `purge`'s `ReadonlyArray<string>`;
  2. `StoredMeta.meta.pii`;
  3. `record`'s two overloads over one implementation, and `toStoredRow(published, definition)` with the record guard;
  4. `decodeRow`'s non-core branch;
  5. `scrubRow`'s pii source with `PRE_ADR_049_PII`;
  6. `payloadAs` and `toPublished`'s unwrap.

  In `EventRelay`, `deliver` takes `ReadonlyArray<PublishedAny>` and `eventTag` becomes `string`. Retention's `tags`
  become `ReadonlyArray<string>`; validation comes in ticket 09.
- **Tests** (`AuditLog.test.ts`, inside `suite(...)`, so both stores run). Each uses a test-local
  `EventDefinition.define("auth.local.happened", { userId: EventDefinition.UserId, note: Schema.String }, { actor: Actor.field("userId"), pii: ["note"] })`:
  - A1: `record(event, LocalDef)` stores `actorUserId` and `meta.pii: ["note"]`. `list()` returns the row as a
    `ForeignEvent`, and `AuditLog.payloadAs(LocalDef)` gives `Some` with the same fields.
  - A2: a core event with no `pii` (`auth.user.created`) stores a payload whose JSON equals today's shape (no `pii` key).
  - A3: `pseudonymizeActor` blanks `note` on the local row through `meta.pii`. No registry is in scope: this is the
    removed-plugin case (F1).
  - A4: a hand-written stored row of `auth.admin.userBanned` with no `meta.pii` (the shape before ADR-EA-049) has its
    `reason` blanked through `PRE_ADR_049_PII`. A table-pinning test asserts the three frozen entries.
  - A5: `replay` and `list` return a foreign row without `AuditLogDecodeError`. A non-JSON row and a core-tag row that
    fails to decode still fail with it (keep `:310-360`'s tests).
  - A6: `toPublished` of a foreign record is `{ _tag: "auth.local.happened", note, userId, ...envelope }`.
  - `EventRelay.test.ts`: the relay delivers a foreign row unchanged.
- **Done when:**
  - A1–A6 pass on memory and SQL;
  - `pnpm test:pg` is green;
  - `AccountErasure.test.ts` and `AccountExport.test.ts` pass unchanged;
  - `grep -n 'AuthEventTag' packages/core/src/AuditLog.ts packages/core/src/EventRelay.ts packages/core/src/Retention.ts` finds 0.
- **Changeset:** `"@awthaq/core": minor`, `"@awthaq/webhooks": patch`. `Migration:` `AuditLogRecord.eventTag` is a
  `string`, and `payload` is `AuthEvent | AuditLog.ForeignEvent`. Narrow on `payload._tag`, or decode a plugin's row with
  `AuditLog.payloadAs(definition)`. `EventTransport.deliver` receives `ReadonlyArray<AuthEvents.PublishedAny>`. The tag
  filters of `list`, `replay`, `purge`, `EventRelay` and Retention take `string`. ADR-EA-049, ADR-EA-029, ADR-EA-030,
  BEH-EA-100.
- **Gate:** phase gate, +PG.

#### 06 — `AuthEvents`: `emit`, the open stream, guards, selectors
- **Files:**
  - `packages/core/src/AuthEvents.ts` (`:43-86`, `:169-183`, `:190-288`, `:294-466`);
  - `packages/core/test/AuthEvents.test.ts` (including the fake shape at `:215`), `AuthEvents.types.test.ts`,
    `AuthEventsUnitOfWork.test.ts`;
  - `packages/test/src/RedactionGuard.ts` (`:242-252`);
  - every test and feature site that narrows on the raw stream: the 19 tag-filter lambdas in 9 files (§2.1), and those
    of the 61 `stream`/`subscribe` uses that read fields; the compiler lists them;
  - `.changeset/plugin-owned-events-06.md`.
- **Change:** §3.5.
  - `emit` and the generalised `deliver(event, definition, parent)`;
  - the lane from `definition[MetaKey].attempt`;
  - `countEvent` only for core events;
  - `stream`/`subscribe` typed `PublishedAny`;
  - export `is`, a generalised `matching` (`:306`): a definition selector also requires `Schema.is(definition)`;
  - `on`/`onBatch` take selectors;
  - `UndeclaredEventPolicy` and `UndeclaredEvent`, checked only when the provided `EventRegistry.origin` is
    `"composition"`;
  - `RedactionGuard.layerEvents` inspects the published value.

  Migrate the narrowing consumers mechanically: `Stream.filter((e) => e._tag === "x")` followed by a field read becomes
  `Stream.filter(AuthEvents.is("x"))`.
- **Tests:**
  - E1: `emit(LocalDef, { userId, note })` reaches `AuthEvents.on(LocalDef, h)` with `h` typed (`event.note: string`),
    and writes the audit row (A1's assertions).
  - E2: `AuthEvents.is(LocalDef)` refuses an event with the same tag whose shape does not decode.
  - E3: a mixed `on(["auth.session.issued", LocalDef], h)` sees both.
  - E4 (`AuthEventsUnitOfWork.test.ts`): an `attempt: true` local definition emitted in a rolled-back unit is recorded
    and delivered, while a state-change one is neither (ADR-EA-037 for plugin events).
  - E5: with a composed `EventRegistry` lacking the tag, `"die"` dies with `AuthEvents/UndeclaredEvent` and `"warn"`
    logs `auth.event.undeclared`. With the default registry nothing is checked.
  - The types test pins `Handled` for mixed selectors and that `publish({ _tag: "auth.local.happened", ... })` is
    rejected.
- **Done when:**
  - E1–E5 pass;
  - `grep -n 'payloadOf' packages/test/src/RedactionGuard.ts` finds 0;
  - `features` and every package compile;
  - BDD is green.
- **Changeset:** `"@awthaq/core": minor`, `"@awthaq/test": minor`. `Migration:` `AuthEvents.stream`/`subscribe` yield
  `PublishedAny`; narrow with `Stream.filter(AuthEvents.is("auth.session.issued"))`. `on`/`onBatch` also take event
  definitions. New `emit(definition, input)`. ADR-EA-049, BEH-EA-102, BEH-EA-103.
- **Gate:** phase gate, +BDD.

#### 07 — Plugins declare events; `Auth.make` composes them
- **Files:**
  - `packages/core/src/AuthPlugin.ts` (`Class` `:80-147`, `Any` `:339-371`, `Service` `:434-575`);
  - `packages/core/src/Auth.ts` (`EventTagConflict` beside `:106-147`, `Manifest` `:395-430`, `EventsOf` beside
    `:447-463`, `Built` `:537-597`, `buildManifest` `:913-`, `make` `:1138-1161`);
  - `packages/core/src/AuthEvents.ts` (`typed`);
  - `packages/core/test/EventComposition.test.ts` (new);
  - `packages/test/src/TestAuth.ts` (`makeLayer` `:346-410`: `Layer.provideMerge(built.eventsLayer)` beside `:409`,
    and `Layer.succeed(AuthEvents.UndeclaredEventPolicy, "die")`);
  - `examples/memory-server/app.ts` (`:189`);
  - `packages/cli/src/Config.ts` (`:109-115`), `packages/cli/src/Plugin.ts` (`--events`), `packages/cli/src/Doctor.ts`,
    and the CLI tests for `plugin list`/`doctor`;
  - `features/step-definitions/PluginContractSteps.ts` (`:216-224`, the `Built` keys);
  - `.changeset/plugin-owned-events-07.md`.

  If batch-2 plan 15 (`AuthHost`) has landed, the `eventsLayer` line goes into `AuthHost.layer` next to its
  `userFieldsLayer`, and the example and `TestAuth` inherit it (§8).
- **Change:** §3.3 and §3.4, plus `AuthEvents.typed` (§3.5). In the CLI:
  - `linkErrorCodes` gains `Auth/EventTagConflict` and the five tags of F4;
  - `awthaq plugin list --events` prints `manifest.events` as `tag  owner  actor  pii  attempt`, in text, JSON and DOT,
    like `--rules`.
- **Tests** (`EventComposition.test.ts`):
  - C1: two stand-in plugins declaring the same tag throw `Auth/EventTagConflict`, naming both owners.
  - C2: a plugin declaring a core tag throws with `firstOwner: "core"`; a plugin declaring `"awthaq.foreignEvent"`
    throws too.
  - C3: `built.events.tags` is core's then each plugin's, in link order.
  - C4: `manifest.events` lists owner, actor, `pii` and `attempt`.
  - C5: `built.eventsLayer` provides a registry with `origin: "composition"`.
  - C6: `AuthEvents.typed(built.events).on(tag, h)` narrows (type) and filters (runtime).
  - CLI test: `plugin list --events` output, and a config whose `Auth.make` throws `Auth/EventTagConflict` is reported
    as `LinkProblem` with that code.
- **Done when:** C1–C6 and the CLI tests pass; `Built` has `events` and `eventsLayer`; no plugin declares `events` yet,
  so `manifest.events` lists core's 97 at this point.
- **Changeset:** `"@awthaq/core": minor`, `"@awthaq/test": minor`, `"@awthaq/cli": minor`. New `AuthPlugin.Service`
  option `events`, `Auth.EventsOf<P>`, `Built.events`/`eventsLayer`, `manifest.events`, `Auth/EventTagConflict`,
  `AuthEvents.typed`, `awthaq plugin list --events`. `Migration:` a host that serves webhooks or configures Retention
  rules for plugin tags provides `auth.eventsLayer` last, like `auth.userFieldsLayer`. `TestAuth.layer` does so itself.
  ADR-EA-049, BEH-EA-101, BEH-EA-016.
- **Gate:** phase gate, +BDD.

#### 08 — The contract runner checks a plugin's events
- **Files:** `packages/test/src/TestAuth.ts` (`ContractTestOptions` `:773-831`, `runPluginContractTests` `:1133-`); the
  contract runner's own test in `packages/test/test/` (the file that exercises `runPluginContractTests`); `.changeset/plugin-owned-events-08.md`.
- **Change:**
  - A new always-on case, `${label}: every declared event is well-formed`: fail with each message of
    `EventDefinition.problems(plugin.events ?? [], { notPersonal: config.events?.notPersonal })`.
  - Option `events?: { readonly notPersonal?: ReadonlyArray<string> }`.
  - Where `effect/Arbitrary` samples synchronously (as `packages/core/test/ApiContracts.property.test.ts` uses it), add a
    sampled check per definition: plan 09 T3's P3 (blanking `pii` still decodes) and P4 (the actor is a value the event
    carries).
- **Done when:** a stand-in plugin with an undeclared free-text field fails, naming `"<tag>.<field>"`; with the field in
  `notPersonal` it passes; `pnpm check:contract-tests` is green (vacuous until Phase 2).
- **Changeset:** `"@awthaq/test": minor`.
- **Gate:** phase gate.

#### 09 — Readers of the registry: webhooks and Retention
- **Files:**
  - `packages/webhooks/src/WebhookPayload.ts` (`:69-101`, `:149-163`), `Webhooks.ts` (layer `make`, `:591-599`),
    `WebhookDelivery.ts` (`:68-133`);
  - `packages/webhooks/test/WebhookPayload.test.ts`, `WebhookDelivery.test.ts`;
  - `packages/webhooks/README.md` (`:6-20`: add `Layer.provideMerge(auth.eventsLayer)`);
  - `packages/core/src/Retention.ts` (`:119-145`), `packages/core/test/Retention.test.ts`;
  - `.changeset/plugin-owned-events-09.md`.
- **Change:** §3.7.
- **Tests:**
  - W1: `unknownPattern(["auth.local.*"], registry.tags)` accepts with a composed registry holding `auth.local.happened`,
    and refuses with core's.
  - W2: `toBody(event, options, ["note"])` drops `note`.
  - W3: `enqueue` with an event whose tag the registry lacks enqueues nothing and logs `auth.webhooks.unknownEvent`.
  - W4: the impersonation-justification test (`WebhookPayload.test.ts:54`) passes through the registry's `pii`.
  - R1: a Retention rule naming an undeclared tag dies with `invalidConfiguration`.
  - Replace "knows every tag the library publishes" (`WebhookPayload.test.ts:125-137`) with a registry-based assertion.
- **Done when:** `grep -n 'knownEventTags' packages/webhooks/src` finds 0; W1–W4 and R1 pass; the webhooks BDD
  (`features/features/15-webhooks/`) is green.
- **Changeset:** `"@awthaq/webhooks": minor`, `"@awthaq/core": minor`. `Migration:` `WebhookPayload.knownEventTags` is
  removed, so read `AuthEvents.EventRegistry`'s `tags`. Endpoint filters are validated against the composition's
  registry: provide `auth.eventsLayer`. An event whose tag the registry does not hold is not delivered. Retention rule
  tags are strings validated at build. BEH-EA-277, BEH-EA-278.
- **Gate:** phase gate, +BDD.

#### 10 — The template plugin publishes its own event (the worked example), and the authoring docs
- **Files:**
  - `examples/plugin-template/src/NotesEvents.ts` (new), `src/Template.ts` (`:305-361`), `src/index.ts`;
  - `examples/plugin-template/test/Template.test.ts`;
  - `docs/plugin-authoring.md` (`:119-121`, `:261`, "Testing a plugin");
  - `.changeset/plugin-owned-events-10.md` (`pnpm changeset --empty`: the example is private and the docs are docs).
- **Change:**
  - `NotesEvents.NoteCreatedEvent = EventDefinition.define("auth.notes.created", { userId: EventDefinition.UserId, noteId: Schema.String }, { actor: EventDefinition.Actor.field("userId"), pii: [] })`,
    and `events = [NoteCreatedEvent]`.
  - `Notes` declares `events: NotesEvents.events`.
  - `create` (`:339-354`) runs `yield* events.emit(NotesEvents.NoteCreatedEvent, { userId: Users.UserId(caller.ref.id), noteId: record.id })`
    after `afterCreate.run`. `Users.UserId` is a `Brand.nominal` constructor, not an assertion.
  - Rewrite the docs "Events" section (text in §6.6) and checklist item 9.
- **Tests (template):**
  - after creating a note, `AuditLog.list({ eventTag: "auth.notes.created" })` has one row whose `actorUserId` is the
    caller;
  - `AuditLog.payloadAs(NotesEvents.NoteCreatedEvent)(row)` is `Some`;
  - an `AuthEvents.on(NotesEvents.NoteCreatedEvent, …)` handler receives a typed `noteId`;
  - `AuthEvents.typed(built.events).is` narrows;
  - all of this passes in both `TestAuth.recordModes`.
- **Done when:** the template tests pass; `grep -n 'cannot add a tag' docs/plugin-authoring.md` finds 0; the template's
  contract test runs the events check.
- **Gate:** phase gate.

### 4.3 Phase 2: the move recipe

Tickets 11–21 apply the same recipe, one plugin per ticket and per commit. Review each move with
`git diff --color-moved=dimmed-zebra`: a moved definition must show up as moved, not rewritten (R1).

1. **Module.** Create `packages/<pkg>/src/<Name>Events.ts` with a header comment. Cut each definition block (JSDoc,
   `define` call, `export type`) **verbatim** from `AuthEventSchemas.ts`, changing only:
   - `EventDefinition.define(` stays as it is after ticket 04;
   - `UserIdSchema`/`SessionIdSchema` become `EventDefinition.UserId`/`.SessionId`;
   - `Actor.` becomes `EventDefinition.Actor.`.

   Copy any private helper the block used (for example `RoleNames`, `AuthEventSchemas.ts:39`) into the module.
   Constant names stay the same. Export an `events` array in core's former registry order.
2. **Export.** `packages/<pkg>/src/index.ts`: `export * as <Name>Events from "./<Name>Events.ts";`.
3. **Declare.** The plugin class: `events: <Name>Events.events`.
4. **Publish.** At every site, `events.publish({ _tag: "x", ...fields })` becomes `events.emit(<Name>Events.XEvent, { ...fields })`.
5. **Core.**
   - Delete the blocks and their `CoreRegistry` entries from `AuthEventSchemas.ts`.
   - Delete their samples from `packages/core/test/support/eventSamples.ts`.
   - Delete their rows from core tests: the actor table in `AuditLog.test.ts:54-114` and the attempt set in
     `EventDefinition.test.ts:187-198`. The compiler lists every site.
6. **Consumers.**
   - Plugin tests and `features/` that narrow on these tags: `Stream.filter(AuthEvents.is(<Name>Events.XEvent))`,
     `AuditLog.payloadAs(<Name>Events.XEvent)`, `Schema.decodeUnknownSync(<Name>Events.XEvent)` in place of
     `AuthEvents.payloadOf`.
   - Subscriptions: `AuthEvents.on(<Name>Events.XEvent, …)`.
7. **Text.** `grep -rn 'AuthEvents\.<Const>' docs spec packages/*/README.md` → the new home.
8. **Contract.** The package's `test/Contract.test.ts` runs the events check (ticket 08). Pass `events: { notPersonal }`
   only with a commented reason.
9. **Changeset.** `"@awthaq/core": minor`, `"@awthaq/<pkg>": minor`. `Migration:` lists each moved constant with its new
   home (template in §6.7); the tags are unchanged.

**Done when** (every move ticket):
- `grep -cE '"auth\.<namespace>\.' packages/core/src/AuthEventSchemas.ts` is 0 for the moved tags;
- `AuthEvents.eventTags` has shrunk by exactly the moved count;
- the composed `built.events.tags` of a composition including the plugin still contains them;
- the package's tests, its contract test and the BDD pass.

**Gate:** phase gate, +BDD.

### 4.4 Phase 2: per-plugin moves (tickets 11–21)

Smallest first, so the recipe settles on cheap cases. Organization is last because plans 25 and 30 also edit its
system modules.

#### 11 — device-authorization (2): `auth.deviceAuthorization.{approved, denied}`
- **Files:** `packages/device-authorization/src/DeviceAuthorizationEvents.ts` (new), `DeviceAuthorization.ts` (class;
  the publish at `:1012-1022`), `src/index.ts`, `test/DeviceAuthorization.test.ts`, the `features/` device-authorization
  steps.
- **Special case:** the publish site picks the tag by condition (`:1017-1018`). Write two `emit` branches, or
  `events.emit(approved ? DeviceAuthorizationApprovedEvent : DeviceAuthorizationDeniedEvent, { userId, clientId })`;
  both definitions have the same `Input`. `denied` keeps `attempt: true`.

#### 12 — roles (2): `auth.roles.{assigned, revoked}`
- **Files:** `packages/roles/src/RolesEvents.ts` (new), `Roles.ts` (class; `:163`, `:174`), `index.ts`, `test/Roles*.test.ts`.
- **Special case:** roles does not depend on `@awthaq/ports`, so it uses `EventDefinition.UserId`. Copy `RoleNames`
  locally. The actor is `Actor.field("actorUserId")`, an optional key.

#### 13 — qadi `UserClaims` (1): `auth.user.claimsUpdated`
- **Files:** `packages/qadi/src/UserClaimsEvents.ts` (new), `UserClaims.ts` (class `:279-`; publish `:133-137`),
  `index.ts`, `test/UserClaims.test.ts`.
- **Special case:** `auth.authz.denied` (`DecisionLogging.ts:78`) **stays** in core (§3.8). Its publish site does not
  change.

#### 14 — password (4): `auth.user.{emailVerified, emailChanged}`, `auth.password.{resetRequested, resetCompleted}`
- **Files:** `packages/password/src/PasswordEvents.ts` (new), `Password.ts` (class; `:1297`, `:1475`, `:1486`, `:1556`),
  `index.ts`, `test/Password*.test.ts`, the `features/` password steps (`PasswordWorld.ts` raw-stream reader).
- **Special case:** `auth.password.changed` stays (admin publishes it too). Run after plan 27 (password credential),
  which rewrites these bodies.

#### 15 — api-key (6): every `auth.apiKey.*`
- **Files:** `packages/api-key/src/ApiKeyEvents.ts` (new), `ApiKey.ts` (class; `:904`, `:918`, `:940`, `:1020`, `:1044`,
  `:1064`), `index.ts`, `test/ApiKey*.test.ts`.

#### 16 — two-factor (7): every `auth.twoFactor.*`
- **Files:** `packages/two-factor/src/TwoFactorEvents.ts` (new, §3.3), `TwoFactor.ts` (class), `SecondFactor.ts`
  (`:227`, `:234`, `:350`, `:371`, `:397`, `:402`, `:421`, `:429`), `index.ts`, `test/TwoFactor.test.ts` (`:646`,
  `:740-751`), the `features/` `TwoFactorSecuritySteps.ts`.
- **Special case:** the publisher is the package's `SecondFactor` domain module, not the plugin class. It imports
  `TwoFactorEvents`, which imports nothing of the package, so there is no cycle. `challengeFailed` and `locked` keep
  `attempt: true`.

#### 17 — scim (5): every `auth.scim.*`
- **Files:** `packages/scim/src/ScimEvents.ts` (new), `Scim.ts` (class; `:719`, `:735`, `:894`, `:1009`, `:1249`,
  `:1274`), `index.ts`, `test/Scim*.test.ts`, `features/step-definitions/ScimSteps.ts` (5 `payloadOf`).
- **Special case:** the CWM-002 comment on `Actor.none` moves with the definitions.

#### 18 — saml (5): `auth.saml.{connectionCreated, connectionUpdated, connectionDeleted, signingKeyRotated, logoutRejected}`
- **Files:** `packages/saml/src/SamlEvents.ts` (new), `SamlAdmin.ts` (`:280`, `:332`, `:352`, `:374`, `:412`),
  `SamlSlo.ts` (`:388`; it receives `events: AuthEventsShape` at `:110`, which now has `emit`), the plugin class,
  `index.ts`, `test/Saml*.test.ts`, the `features/` SAML steps.
- **Special case:** `auth.admin.actionDenied`, also published by saml, stays in core.

#### 19 — webhooks (5): every `auth.webhooks.*`
- **Files:** `packages/webhooks/src/WebhookEvents.ts` (new), `Webhooks.ts` (class; `:632`, `:693`, `:716`, `:748`,
  `:832`), `index.ts`, `test/WebhooksPingAndAudit.test.ts`, `test/WebhookPayload.test.ts`, the `features/` webhooks steps.
- **Special case:** an endpoint filter `auth.webhooks.*` now resolves through the composed registry. Webhooks is
  composed whenever it serves, so its own tags are always present.

#### 20 — admin (9): `auth.admin.{impersonationStarted, impersonationStopped, userUpdated, sessionRevoked, userBanned, userUnbanned, userDeleted, userEmailChangeRequested, userPasswordSet}`
- **Files:** `packages/admin/src/AdminEvents.ts` (new), `Admin.ts` (class; `:747`, `:771`, `:788`, `:822`, `:846`, `:886`,
  `:909`, `:942`, `:976`), `AdminAccounts.ts` (`:178`, `:210`, `:274`), `ImpersonationOwnerNotice.ts` (`:39` becomes
  `AuthEvents.on(AdminEvents.AdminImpersonationStartedEvent, …)`), `index.ts`, `test/Admin*.test.ts`,
  `test/ImpersonationOwnerNotice.test.ts`, the `features/` admin steps (`AdminWorld.ts`).
- **Special cases:**
  - Two `pii` events move (`impersonationStarted`, `userBanned`). Add a test that a row written by the moved definition
    carries `meta.pii: ["reason"]`.
  - `auth.admin.{impersonationDenied, actionDenied, seeded, seedRefused}` stay.

#### 21 — organization (27): every `auth.organization.*` plus `auth.admin.organization{Suspended, Unsuspended}`
- **Files:**
  - `packages/organization/src/OrganizationEvents.ts` (new);
  - `Organization.ts` (class, and 1 site);
  - the system modules: `OrganizationConnections.ts` (3), `OrganizationDirectory.ts` (4, including `:408`, `:433`),
    `OrganizationInvitations.ts` (8), `OrganizationMembers.ts` (4), `OrganizationRoles.ts` (3), `OrganizationTeams.ts` (10);
  - `index.ts`;
  - `test/Organization*.test.ts`. `Organization.test.ts` has 6 `payloadOf` uses, which become `Schema.decodeUnknownSync(OrganizationEvents.X)`;
  - `packages/organization/test/OrganizationEvents.types.test.ts` (new: the ESA-005 "no email on invitationCreated"
    case moves from `packages/core/test/AuthEvents.types.test.ts:29-38`);
  - the `features/` organization steps (`OrganizationWorld.ts:127`).
- **Special cases:**
  - `auth.organization.permissionDenied` keeps `attempt: true`.
  - `organizationSuspended` keeps `pii: ["reason"]`; add the same `meta.pii` test as ticket 20.
  - Run after plan 25 (which changes these system modules' store calls) and before plan 30, whose organization authorize
    primitive then publishes `OrganizationEvents.OrganizationPermissionDeniedEvent` (plan 30 §RA6).

### 4.5 Phase 3: core residue, BDD, spec (tickets 22–25)

#### 22 — Core residue and core tests at the new interface
- **Files:** `packages/core/src/AuthEventSchemas.ts` (header `:1-30`, unused helpers), `packages/core/test/support/eventSamples.ts`,
  `AuditLog.test.ts` (`:54-114`), `EventDefinition.test.ts` (`:184-209`), `AuthEvents.types.test.ts`.
- **Change:**
  - Rewrite the header's PII and "Every event is declared with" paragraphs: core's own events only, with plugins' events
    in their packages (ADR-EA-049).
  - Delete helper schemas left unused.
  - The actor table keeps core rows plus one row per actor rule through a test-local definition (`Field`, optional
    `Field` present and absent, `Prefixed`, `None`).
  - The attempt-set test lists core's 6 attempt tags; the composed-level assertion moves to BDD (ticket 23).
- **Done when:**
  - `wc -l packages/core/src/AuthEventSchemas.ts` is ≤ 720;
  - `grep -c '= EventDefinition.define($' packages/core/src/AuthEventSchemas.ts` is 24;
  - `wc -l packages/core/test/support/eventSamples.ts` is ≤ 180;
  - the §9 grep for plugin namespaces in core finds 0.
- **Gate:** phase gate.

#### 23 — BDD on the composed registry
- **Files:** `features/step-definitions/EventsSteps.ts` (`:31-33`, `:406-449`), `PersistenceStratumSteps.ts` (`:301`),
  `features/features/04-cross-cutting/13-events.feature` (`:87-110`), `features/features/01-contract-and-persistence/`
  (or wherever BEH-EA-016 is exercised: the new composition scenario), `features/traceability.md`.
- **Change:**
  - `tagNamed` and the registry steps read the world's `built.events` (`isTag`, `definitions`).
  - The secret-field scan iterates `built.events.definitions`.
  - Add the scenarios in §6.5: a composed plugin contributes a tag; a foreign row stays readable; the composed attempt
    set; `Auth.make` refuses a duplicate tag.
- **Done when:** `pnpm test:bdd` is green, and `features/traceability.md` maps the new REQ-EA ids.
- **Gate:** phase gate, +BDD.

#### 24 — Spec, ADRs, glossary, traceability, final changeset
- **Files:**
  - `spec/behaviors/13-events.md`, `34-webhooks.md`, `02-plugin-composition-validate.md`, `03-ports-slots-hooks-registries.md`,
    `25-testing-harness.md`;
  - `spec/decisions/049-plugins-own-event-definitions.md` (`Status: Accepted — implemented`), `029-…`, `030-…`, `012-…`,
    `035-…`, `index.yaml`;
  - `spec/glossary.md`, `spec/traceability.md`;
  - `.changeset/plugin-owned-events-24.md`.
- **Change:** §6.1–§6.4. Revisions are assigned at landing, in landing order (`.planning/README.md` batch-2 rule).
- **Done when:** `pnpm spec:verify:strict` is green; BEH-EA-101's REQUIREMENT reads as in §6.1; the ADR-EA-049 status is
  Accepted.
- **Gate:** phase gate, plus `pnpm spec:verify:strict`.

#### 25 — Acceptance recount
- **Files:** `.scratch/29-plugin-owned-events/baseline.md` (append "after"), this plan's "Decisions taken".
- **Change:** re-run §2.1 and every §9 command, compare `pnpm typecheck` time and `AuthEventSchemas.d.ts` lines with the
  baseline (R6), and fill in §9.
- **Done when:** every §9 box is ticked or explained in "Decisions taken".
- **Gate:** plan gate (`pnpm check`, `pnpm test:pg`).

### 4.6 Ticket table (one-to-one with `.scratch/29-plugin-owned-events/issues/NN-*.md`)

| # | Title | Phase | Depends on |
|---|---|---|---|
| 01 | Baseline and tracker | 0 | — |
| 02 | Spike: the type-level interface | 0 | 01 |
| 03 | ADR-EA-049 lands as Proposed | 0 | 01 |
| 04 | `EventDefinition` becomes a public core module | 1 | 02 |
| 05 | `AuditLog`: definition-driven rows, `meta.pii`, `ForeignEvent` | 1 | 04 |
| 06 | `AuthEvents`: `emit`, open stream, guards, selectors | 1 | 05 |
| 07 | Plugins declare events; `Auth.make` composes them; TestAuth, CLI | 1 | 06 |
| 08 | Contract runner checks a plugin's events | 1 | 07, plan 25's runner change |
| 09 | Registry readers: webhooks and Retention | 1 | 07 |
| 10 | Template plugin worked example and authoring docs | 1 | 07 |
| 11 | Move device-authorization (2) | 2 | 08, 09, 10 |
| 12 | Move roles (2) | 2 | 11 |
| 13 | Move qadi `UserClaims` (1) | 2 | 11 |
| 14 | Move password (4) | 2 | 11, plan 27 |
| 15 | Move api-key (6) | 2 | 11, plan 25 (api-key step) |
| 16 | Move two-factor (7) | 2 | 11, plan 25 (two-factor step) |
| 17 | Move scim (5) | 2 | 11, plan 25 (scim step) |
| 18 | Move saml (5) | 2 | 11, plan 25 (saml step) |
| 19 | Move webhooks (5) | 2 | 11, plan 25 (webhooks step) |
| 20 | Move admin (9) | 2 | 11, plan 25 (admin step) |
| 21 | Move organization (27) | 2 | 11–20, plan 25 (organization) |
| 22 | Core residue and core tests | 3 | 21 |
| 23 | BDD on the composed registry | 3 | 21 |
| 24 | Spec, ADRs, glossary, traceability, final changeset | 3 | 22, 23 |
| 25 | Acceptance recount | 3 | 24 |

---

## 5. Test plan

### 5.1 Tests at the new interface

| Test | Where | What it proves |
|---|---|---|
| Type spike (permanent) | `packages/core/test/EventDefinition.plugin.types.test.ts` (ticket 02) | `Input<D>`; `emit` typed without `as`; `EventsOf` narrows; mixed `Handled`; `ForeignEvent` narrows; an open member does not (§2.6) |
| `problems` units | `packages/core/test/EventDefinition.test.ts` (ticket 04) | one failing definition per check P1, P2, P3, P6, N, U, R, plus core's set is clean. **Replaces** T3's hand loops (`:81-182`) |
| Registry readers | same file | `make(...).is` refuses a value of a registered tag whose shape does not decode; `definitionOf`; `origin` |
| A1–A6 | `packages/core/test/AuditLog.test.ts`, both stores (ticket 05) | rows driven by the definition; `meta.pii` only when declared; erasure of a removed plugin's personal data (F1); the fallback for rows written before ADR-EA-049; foreign rows never fail; `toPublished` unwraps |
| Relay passes foreign rows | `packages/core/test/EventRelay.test.ts` | ADR-EA-030 decision 5 as amended |
| E1–E5 | `AuthEvents.test.ts`, `AuthEventsUnitOfWork.test.ts` (ticket 06) | `emit` reaches typed `on(definition)` and the audit row; guards validate; mixed selectors; ADR-EA-037 lanes for plugin events; `UndeclaredEventPolicy` |
| C1–C6 | `packages/core/test/EventComposition.test.ts` (ticket 07) | `Auth/EventTagConflict` (plugin/plugin, plugin/core, reserved tag); link order; manifest; `eventsLayer`; `typed` |
| CLI | `packages/cli/test/` (ticket 07) | `plugin list --events`; `Auth/EventTagConflict` and F4's five tags become `LinkProblem` |
| Contract events check | `packages/test/test/` (ticket 08) | a bad plugin definition fails, naming `tag.field`; `notPersonal` |
| W1–W4, R1 | `packages/webhooks/test/`, `packages/core/test/Retention.test.ts` (ticket 09) | filters validated against the composed registry; `pii` from the registry; fail-closed on an unknown tag; a Retention typo is refused |
| Worked example | `examples/plugin-template/test/Template.test.ts` (ticket 10) | the whole path for a plugin outside core, in both record modes |
| `meta.pii` on moved events | `packages/admin/test/`, `packages/organization/test/` (tickets 20, 21) | the three `pii` events still stamp their declared fields after the move |
| BDD | `features/features/04-cross-cutting/13-events.feature` plus the composition feature (ticket 23) | §6.5 |

### 5.2 Tests deleted or moved (replace, don't layer)

- `packages/core/test/support/eventSamples.ts`: the 73 plugin samples are **deleted**, not moved (477 lines become ≤ 180).
  Each plugin's own tests already publish and assert its events, and the contract runner checks each definition.
- `EventDefinition.test.ts:81-182` (T3's per-member loops) become one `problems(...)` assertion plus the unit tests.
  `:184-209` (the attempt set) keeps core's 6 tags; the composed set is asserted once in BDD.
- `AuditLog.test.ts:54-114`: the rows for plugin events (`organization.permissionDenied`, `admin.userUpdated`,
  `organization.created`, `scim.userProvisioned`, ...) are replaced by rows for a test-local definition, one per actor
  rule. Core rows stay.
- `AuthEvents.types.test.ts:29-38` (no email on `invitationCreated`) **moves** to
  `packages/organization/test/OrganizationEvents.types.test.ts`.
- `WebhookPayload.test.ts:125-137` ("knows every tag the library publishes") becomes a registry-based assertion.
- The 19 `payloadOf` call sites: core-event sites stay; plugin-event sites become `Schema.decodeUnknownSync(<Def>)`.

### 5.3 Concurrency and real Postgres

- `pnpm test:pg` in ticket 05. `AuditLogStoreSql.rewriteReferencing` applies the pure `scrubRow` inside its locked
  transaction, so A3 and A4 run on Postgres with `FOR UPDATE`. No SQL statement changes.
- E4 runs the attempt-lane case inside a real SQLite unit of work (the `AuthEventsUnitOfWork.test.ts` harness).
- `emit` and `publish` share `deliver`, so plan 10 item 5's commit/rollback tests cover both, with one added case per
  lane for `emit`.

### 5.4 Measurable targets

| Measure | Baseline (current tree) | Target |
|---|---|---|
| `wc -l packages/core/src/AuthEventSchemas.ts` | 1,899 | ≤ 720 |
| `defineEvent`/`define` calls in core | 97 | 24 |
| Tags published by a single plugin, defined in core | 73 | 0 |
| `wc -l packages/core/test/support/eventSamples.ts` | 477 | ≤ 180 |
| Files edited to add an event to an existing plugin | 4 in core + 1 in the plugin (§2.4) | 1 (the plugin's `*Events.ts`) + the publish site |
| Packages a third-party plugin edits to add a tag | impossible | its own |
| `pnpm typecheck` wall time | ticket 01 baseline | ≤ +10% (R6) |

---

## 6. Spec, ADR, traceability, BDD, docs, changesets

New BEH and REQ ids: take the next free ones at execution. In the current tree the highest is BEH-EA-339 and
REQ-EA-1320; batch-2 plans may take more first. Revision numbers are assigned at landing, in landing order.

### 6.1 Behaviours

- **`spec/behaviors/13-events.md`** (1.10 → next). Change history: "BEH-EA-100–103: plugins define and declare their
  own events; the set is closed per composition; `emit`; open stream with validating guards; foreign rows; declared
  personal data recorded with the row (ADR-EA-049, architecture plan 29)".
  - **BEH-EA-101 REQUIREMENT**, replacing `:92-98`:
    ```text
    REQUIREMENT: Every event published to `AuthEvents` MUST be a tagged value
                 from a closed, statically-known set of event types fixed by
                 the composition: core's own events plus the events each
                 composed plugin declares (`AuthPlugin.Service`'s `events`).
                 `Auth.make` MUST refuse a composition in which two
                 declarations, core's included, share a tag. A subscriber
                 filtering or handling by tag MUST be able to rely on the
                 payload shape that tag has in that composition.
    ```
  - Prose at `:100`: keep the sentence about a registry letting a plugin author add a tag; it is now true. Add: "A
    plugin defines each event it publishes with `EventDefinition.define(tag, fields, { actor, pii, attempt? })` in its
    own package, lists them in its class's `events`, and publishes with `AuthEvents.emit(definition, input)`. Core
    defines only the events core publishes, those several packages publish, those core reads by tag, the CLI's, and
    `auth.authz.denied`."
  - The `:102` paragraph: "Every event is an Effect `Schema` in `AuthEventSchemas.ts`" becomes "Every event is an
    Effect `Schema`, defined where it is published"; plugin events are version 1 of their own shape.
  - Replace the *Implementation* note at `:104`: "Adding an event is one `EventDefinition.define` call in the package
    that publishes it plus its entry in that plugin's `events` (core's own: `AuthEventSchemas.ts`'s `CoreRegistry`)."
  - Add a paragraph: "**A stored event whose tag the composition does not declare** (its plugin was removed) is read as a
    foreign event (its tag and stored fields) and never fails `AuditLog.list`/`replay`, the relay or an export. When it
    was written, its declared personal-data fields were recorded with the row, so erasure still blanks them."
  - BEH-EA-100: the row records the fields its event declares as personal data (`meta.pii`).
  - BEH-EA-102: `stream`/`subscribe` carry every event of the composition, typed open, and
    `AuthEvents.is(tag | definition)` narrows by validating.
  - BEH-EA-103: `on(select, handler)` takes core tags and/or definitions.
- **`spec/behaviors/34-webhooks.md`** (1.6 → next).
  - BEH-EA-278: "every pattern MUST match at least one tag the library can publish" becomes "… at least one tag of the
    composition's event registry (core's events plus every composed plugin's)".
  - BEH-EA-277: add "an event whose tag the composition's registry does not hold is not delivered: its personal-data
    fields are unknown".
- **`spec/behaviors/02-plugin-composition-validate.md`** (1.2 → next): a **new BEH-EA-NNN**, "`Auth.make` composes event
  definitions and refuses a duplicate tag":
  ```text
  REQUIREMENT: `Auth.make` MUST compose core's event definitions with every
               composed plugin's declared `events` into `Built.events`, list
               them in `manifest.events`, provide them through
               `Built.eventsLayer`, and refuse, with `Auth/EventTagConflict`
               naming both owners, a tag declared twice (core's included).
  ```
- **`spec/behaviors/03-ports-slots-hooks-registries.md`** (1.4 → next): BEH-EA-024 gains a note. "*As shipped
  (ADR-EA-035, ADR-EA-049):* user fields and event definitions are registries composed statically by `Auth.make` from the
  plugins' declarations, not through `Layer.effectDiscard`, because they must be known without building a layer. A
  duplicate event tag is a composition error: a tag is an identity, like a group id."
- **`spec/behaviors/25-testing-harness.md`** (1.4 → next): BEH-EA-193 says `TestAuth.layer` provides `built.eventsLayer`
  and fails an emit of an undeclared event. BEH-EA-198 says `runPluginContractTests` checks every declared event
  (`EventDefinition.problems`).

### 6.2 ADR-EA-049 (new): draft text

```markdown
# ADR-EA-049: Plugins Own Their Event Definitions; a Composition's Event Set Is Core's Plus Every Composed Plugin's

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-049 |
> | Revision | 1.0 |
> | Effective Date | <date of ticket 24> |
> | Status | Proposed (ticket 03) → Accepted — implemented (ticket 24) |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0: Initial release (architecture plan 29; plan 09 phase 5) |

---

## Context

ADR-EA-029 and plan 09 made an event one declarative value: `defineEvent(tag, fields, { actor, pii, attempt? })`, read
generically by the audit log's actor column, erasure, the attempt lane (ADR-EA-037) and the webhooks payload. All 97
definitions still lived in `@awthaq/core`, 73 of them published by exactly one plugin. Every change to a plugin event
edited core, and a plugin outside the repository could not add a tag at all, although BEH-EA-101 says the registry lets
a plugin author do so.

Two facts constrain the design. TypeScript loses `_tag` narrowing for a whole union as soon as one member's tag is open,
so the set of events cannot be "core's union plus something open" where code narrows. And a `Context.Service` shape
cannot depend on the plugin tuple, so the precise union of one composition exists only where the tuple is in scope:
`Auth.make`'s result.

## Decision

1. **An event is defined where it is published.** `EventDefinition.define(tag, fields, { actor, pii, attempt? })`
   (public in `@awthaq/core`) is the one constructor. Core defines only the events core's modules publish, events
   several packages publish, events core reads by tag (`SecuritySignals`), the CLI's, and `auth.authz.denied`
   (published by qadi's host-composed decision sink, not by a plugin).
2. **A plugin declares the events it publishes** on its class, `AuthPlugin.Service(id, { events })`. This is a static
   read without building a layer, with a type-only `"~events"` member, mirroring `userFields` (ADR-EA-035).
3. **The event set is closed per composition.** `Auth.make` composes core's definitions with every composed plugin's
   (`Built.events`, typed `Auth.EventsOf<P>`), refuses a tag declared twice, core's included (`Auth/EventTagConflict`),
   lists the set in `manifest.events` and provides it through `auth.eventsLayer` (`AuthEvents.EventRegistry`, a
   `Context.Reference` whose default is core's own set). It is composed statically, not through `Layer.effectDiscard`
   (ADR-EA-012), because webhook filters, the manifest and typed views need it without building a layer.
4. **A plugin publishes through its definition**: `AuthEvents.emit(definition, input)`. `publish(event)` stays for core's
   events. Both stamp one envelope, write the same audit row and honour the lane the definition declares (ADR-EA-037).
5. **Types.** `AuthEvent` is core's closed, narrowable union. The bus and the relay carry every event typed as the open
   `PublishedAny`, narrowed by guards that validate against the definition (`AuthEvents.is(tag | definition)`). The
   narrowable union of a composition is `Auth.EventsOf<P>`, consumed through `AuthEvents.typed(auth.events)`.
6. **The audit log does not depend on the composition.** A row records what erasure needs when it is written: its actor
   column, and the fields its definition declares as personal data (`meta.pii`). A row whose tag core does not define is
   read as a `ForeignEvent` (its tag and stored fields), whether its plugin is still composed or was removed, and never
   fails `list`, `replay`, the relay or an export. A plugin decodes its own rows with `AuditLog.payloadAs(definition)`.
   Rows written before this decision carry no `meta.pii` and are scrubbed with the personal-data fields their tags
   declared then, a frozen three-entry table.
7. **Readers of "every tag" read the composed registry.** Webhook filters and payload personal data: an event whose tag
   the registry does not hold is not delivered. Retention rules: an undeclared tag is a configuration defect. Also the
   CLI's `plugin list --events` and the BDD steps.
8. **No deprecation window (ADR-EA-034 §2).** Core cannot re-export a definition from the plugin package that owns it
   (dependency direction), so each move is announced by a changeset whose `Migration:` names each constant's new home.
   Tags and payloads do not change.

## Alternatives considered

- **Keep every event in core.** Rejected: no locality; a third-party plugin cannot add a tag; BEH-EA-101's prose stays
  false.
- **Module augmentation of a core `AuthEventRegistry` interface** (`declare module "@awthaq/core"` in each plugin), so
  `AuthEvent` grows with every imported plugin and `publish` keeps working unchanged. Rejected: the union follows the
  program's imports, not the composition (an imported but uncomposed plugin's events type-check and are never
  registered); it is a global ambient mechanism no other extension point uses; and the runtime still needs the composed
  registry, so type and runtime would have two sources of truth.
- **The audit log decodes and erases through the composed registry** (plan 09 §3.7). Rejected: it makes the audit log
  depend on host wiring, and a removed plugin's declared personal data would never be blanked again (ADR-EA-029).
- **An open member in the union** (`AuthEvent | { _tag: string }`). Rejected: it disables `_tag` narrowing on the whole
  union (measured).
- **An overloaded `publish(definition, input)`.** Rejected: overload errors ("No overload matches this call") are
  unreadable, and core's call sites keep their signature.
- **Event metadata as `Schema` annotations.** Rejected in plan 09 §3.1; unchanged.

## Consequences

**Positive**: a plugin's events live, change and are tested in its own package; a third-party plugin adds tags; a
duplicate is refused at composition, by name; erasure stays correct after a plugin is removed; core's narrowing is
untouched; the audit log needs no composition wiring.

**Negative**: two verbs, `publish` (core) and `emit` (definitions); raw-stream consumers narrow through a guard; a plugin
row in `AuditLog.list` is a `ForeignEvent` until the plugin decodes it; plugin events have no upcaster (`EVENT_VERSION`
covers core's union), so a breaking change to a plugin event is a new tag; a host that serves webhooks or sets Retention
rules for plugin tags must provide `auth.eventsLayer`.

_Related: [ADR-EA-012](012-slots-exclusive-registries-aggregate.md), [ADR-EA-029](029-event-pii-posture.md),
[ADR-EA-030](030-event-delivery-outbox-relay.md), [ADR-EA-034](034-versioning-and-deprecation-policy.md),
[ADR-EA-035](035-user-field-extension-point.md), [ADR-EA-037](037-unit-of-work-releases-events-on-commit.md),
[BEH-EA-101](../behaviors/13-events.md)._
```

### 6.3 Amendments to existing ADRs

- **ADR-EA-029** (1.2 → next). Decision 2 adds: "wherever the event is defined (core or a plugin, ADR-EA-049); the row
  records the declared fields when it is written (`meta.pii`), so erasure blanks them even after the event's plugin is
  removed."
- **ADR-EA-030** (1.2 → next). Decision 5 becomes: "A core row that no longer decodes, or a row that is not a JSON
  object, stops the relay at that row, loudly. A row whose tag core does not define is relayed as stored (a foreign event,
  ADR-EA-049); its plugin judges its shape." Decision 6 is unchanged (plan 09 F5 is still open).
- **ADR-EA-012** (1.2 → next). Consequences add: "Event definitions (ADR-EA-049) and user fields (ADR-EA-035) are
  registries composed statically by `Auth.make`. A duplicate event tag is refused, like a duplicate group id, because a
  tag is an identity, not a contribution."
- **ADR-EA-035** (1.0 → next): a *Related* link to ADR-EA-049 ("the same declared-extension pattern carries event
  definitions"). If batch-2 plan 15 has already revised decision 5, add the link to that revision.
- **ADR-EA-034**: no amendment. It is applied (decision 8 of ADR-EA-049).

### 6.4 Traceability and glossary

- `spec/traceability.md`:
  - a new ADR row for ADR-EA-049: `packages/core/test/EventComposition.test.ts`, `EventDefinition.test.ts`,
    `EventDefinition.plugin.types.test.ts`, `AuditLog.test.ts`, `AuthEvents.test.ts`,
    `examples/plugin-template/test/Template.test.ts`;
  - the ADR-EA-029 row gains `AuditLog.test.ts` A3/A4;
  - §5 test list rows for the new files;
  - a BEH row for the new composition behaviour.
- `features/traceability.md`: the new REQ-EA ids (§6.5) and the `13-events.feature` row count.
- `spec/glossary.md` (1.10 → next):
  - **Event definition**: "the schema an event is declared with (`EventDefinition.define`), carrying who acted, which
    fields are personal data and whether it records an attempt; defined in the package that publishes it and declared in
    that plugin's `events`."
  - **Foreign event**: "how core reads a stored event whose tag it does not define: its tag and stored fields; the
    owning plugin decodes it with `AuditLog.payloadAs`."
  - **Registry** gains: "user fields and event definitions are composed statically by `Auth.make` (ADR-EA-035,
    ADR-EA-049)."
- Run `pnpm spec:verify:strict`.

### 6.5 BDD

`features/features/04-cross-cutting/13-events.feature`, under `@BEH-EA-101`:

```gherkin
    @REQ-EA-NNNN
    Scenario: A composed plugin contributes its own event tag to the registry
      Given a composition of core and the "roles" plugin, which declares "auth.roles.assigned"
      When a role is assigned to a user
      Then an "auth.roles.assigned" event is published and recorded with its actor
      And the composition's registry declares "auth.roles.assigned" beside core's tags

    @REQ-EA-NNNN
    Scenario: A stored event whose plugin is no longer composed stays readable and erasable
      Given an audit row recorded through a plugin event definition that declares "note" as personal data
      And a composition that does not include that plugin
      When the audit log is listed and replayed, and the row's user is erased
      Then the row is read as a foreign event with its tag and fields, nothing fails, and "note" is blanked

    @REQ-EA-NNNN
    Scenario: The composed registry classifies exactly the documented attempt events
      Given a composition of every first-party plugin
      Then exactly these tags are attempt events: the documented set of ten
```

The composition feature (where BEH-EA-016 is exercised), under the new BEH:

```gherkin
    @REQ-EA-NNNN
    Scenario: Auth.make refuses two declarations of one event tag
      Given two plugins that both declare the event tag "auth.dup.happened"
      When they are composed with Auth.make
      Then the composition is refused with "Auth/EventTagConflict" naming both plugins
```

The two stand-in plugins and the plugin definition with `note` are local to the step file. `features` depends on every
first-party package but not on the template.

### 6.6 Docs

**`docs/plugin-authoring.md` "Events"** (`:119-121`), replacing the paragraph:

> Events are identifiers-only (ADR-EA-029) and **owned by the plugin that publishes them** (ADR-EA-049). Define each one
> in a module of your package with `EventDefinition.define(tag, fields, { actor, pii })`, as
> `examples/plugin-template/src/NotesEvents.ts` does.
> - Name the tag `auth.<plugin id>.<pastTense>`.
> - Brand user ids with `EventDefinition.UserId`.
> - Choose the actor: `Actor.field("<userId field>")` for the user who *did* it (an administrator, not the target),
>   `Actor.none` when no user acted (a directory, the CLI, an anonymous attempt), or `Actor.prefixed`.
> - List every free-text field about a person in `pii` (never an email: carry an id and let subscribers join).
> - Add `attempt: true` for an event that records an *attempt* (a failed sign-in or second factor, a replay, a denial):
>   it is recorded and delivered after the surrounding transaction ends, committed or not. Leave it off for a state
>   change (see "Units of work").
>
> List the definitions in your class's `events` and publish with `events.emit(Definition, { ...fields })`; `_tag` is
> filled in for you. Subscribe with `AuthEvents.on(Definition, handler)`, and read your audit rows with
> `AuditLog.payloadAs(Definition)`. `Auth.make` refuses a tag another plugin or core already declares. A host serving
> webhooks provides `auth.eventsLayer`, and `TestAuth.layer` does it for you and fails a test that emits an event you
> did not list. `runPluginContractTests` checks every declared event (an undeclared free-text field fails, naming
> `tag.field`). Core keeps only the events core publishes, shares or reads by tag.

Checklist item 9 (`:261`): "Every event defined in the plugin with `EventDefinition.define`, its actor chosen, its
free-text fields in `pii`, listed in the class's `events`, and published with `emit`."

"Testing a plugin" adds one sentence on `eventsLayer` and `UndeclaredEventPolicy`.

**`packages/webhooks/README.md`** (`:6-20`): the recipe adds `Layer.provideMerge(auth.eventsLayer)`, and a sentence
saying filters are validated against the composed registry.

### 6.7 Changesets (ADR-EA-034)

Per ticket, the text is in §4. Every package is in one Changesets `fixed` group, so versions move together. The per-plugin
template (tickets 11–21):

```md
---
"@awthaq/core": minor
"@awthaq/two-factor": minor
---
`@awthaq/two-factor` owns its events (ADR-EA-049): the seven `auth.twoFactor.*` definitions moved from `@awthaq/core` to
`TwoFactorEvents`, are declared on the plugin's `events`, and are published with `AuthEvents.emit`. Tags, payloads,
actors, personal-data fields and attempt lanes are unchanged.

Migration: `AuthEvents.TwoFactorEnabledEvent` (and `…Disabled…`, `…Verified…`, `…ChallengeFailed…`,
`…RecoveryCodeUsed…`, `…RecoveryCodesRegenerated…`, `…Locked…`) → `TwoFactorEvents.<same name>` from
`@awthaq/two-factor`. `AuthEvents.AuthEventTag`/`AuthEvent` no longer include `auth.twoFactor.*`: subscribe with
`AuthEvents.on(TwoFactorEvents.TwoFactorEnabledEvent, …)`, narrow the stream with
`AuthEvents.is(TwoFactorEvents.TwoFactorEnabledEvent)`, decode an audit row with
`AuditLog.payloadAs(TwoFactorEvents.TwoFactorEnabledEvent)`, and replace `AuthEvents.payloadOf(e)` with
`Schema.decodeUnknownSync(TwoFactorEvents.TwoFactorEnabledEvent)(e)`. ADR-EA-049, BEH-EA-101.
```

Each moved constant's new home (the `Migration:` lines of tickets 11–21):

| Moved from `@awthaq/core` `AuthEvents.*` | New home |
|---|---|
| `DeviceAuthorizationApprovedEvent`, `DeviceAuthorizationDeniedEvent` | `@awthaq/device-authorization` `DeviceAuthorizationEvents` |
| `RolesAssignedEvent`, `RolesRevokedEvent` | `@awthaq/roles` `RolesEvents` |
| `UserClaimsUpdatedEvent` | `@awthaq/qadi` `UserClaimsEvents` |
| `UserEmailVerifiedEvent`, `UserEmailChangedEvent`, `PasswordResetRequestedEvent`, `PasswordResetCompletedEvent` | `@awthaq/password` `PasswordEvents` |
| `ApiKey{Created, Revoked, Rotated, ClientRegistered, ClientRevoked, ClientSecretRotated}Event` | `@awthaq/api-key` `ApiKeyEvents` |
| `TwoFactor{Enabled, Disabled, Verified, ChallengeFailed, RecoveryCodeUsed, RecoveryCodesRegenerated, Locked}Event` | `@awthaq/two-factor` `TwoFactorEvents` |
| `Scim{UserProvisioned, UserDeactivated, UserReactivated, UserDeleted, GroupChanged}Event` | `@awthaq/scim` `ScimEvents` |
| `Saml{ConnectionCreated, ConnectionUpdated, ConnectionDeleted, SigningKeyRotated, LogoutRejected}Event` | `@awthaq/saml` `SamlEvents` |
| `Webhook{EndpointCreated, EndpointUpdated, SecretRotated, EndpointDeleted, TestQueued}Event` | `@awthaq/webhooks` `WebhookEvents` |
| `Admin{ImpersonationStarted, ImpersonationStopped, UserUpdated, SessionRevoked, UserBanned, UserUnbanned, UserDeleted, UserEmailChangeRequested, UserPasswordSet}Event` | `@awthaq/admin` `AdminEvents` |
| the 25 `Organization*Event`, `AdminOrganizationSuspendedEvent`, `AdminOrganizationUnsuspendedEvent` | `@awthaq/organization` `OrganizationEvents` |

Ticket 24's changeset sums up the plan (`"@awthaq/core": minor`) and points to ADR-EA-049.

---

## 7. Risks, mitigations, rollback

| # | Risk | Likelihood | Mitigation | Rollback |
|---|---|---|---|---|
| R1 | A move changes a definition by accident (a field, an optional, `pii`, `attempt`) | low | The recipe is cut-and-paste, reviewed with `git diff --color-moved`; `problems()` in the contract runner; each plugin's existing audit and stream assertions; `meta.pii` tests for the three `pii` events | revert the plugin's commit (the definitions return to core) |
| R2 | A removed plugin's personal data survives erasure (plan 09's gap) | was high under plan 09's design | `meta.pii` on every row that declares personal data, plus the frozen fallback for older rows; A3 and A4 on both stores, on Postgres | — |
| R3 | A raw-stream consumer silently loses plugin events | would be medium with a core-only stream | the stream is typed open (D4): a narrowing consumer breaks at compile time, and a forwarder keeps every event (Q1) | — |
| R4 | A host forgets `auth.eventsLayer` | medium | Only webhooks and Retention read it. Webhooks refuses plugin-family filters at registration (loud) and does not enqueue unknown tags (logged, fail-closed); Retention dies with `invalidConfiguration`. `TestAuth` provides it; the docs, the webhooks README and the changeset say so. If batch-2 plan 15 lands, `AuthHost.layer` provides it | — |
| R5 | A plugin emits a definition it did not list in `events` | medium (likeliest authoring mistake) | `UndeclaredEventPolicy`: `"die"` under `TestAuth`, `"warn"` plus a log in production; the audit row is still correct (the definition was in hand) | — |
| R6 | Type-checking cost: `Class` gains a type parameter, `EventsOf<P>` folds 11 plugins | low–medium | measure against ticket 01's baseline in ticket 25; if over +10%, compute `EventsOfPlugin` once per plugin through a named alias, or drop `typed`'s per-tag `Extract` for a precomputed map type | — |
| R7 | Concurrent plans edit the same plugin packages (25, 26, 27, 30; batch-2 15, 21, 22, 24) | high (textually) | per-plugin tickets are small and run after plan 25's step for that plugin (§8); the edits are publish lines and one class option | rebase |
| R8 | A third-party plugin picks a tag core later adds | low | `Auth/EventTagConflict` names both owners at the upgrade (loud); the docs recommend `auth.<plugin id>.` | — |
| R9 | Two copies of a plugin package in a host (two definition objects for one tag) | low | the guards validate shape, not identity; the composition sees one class, so no conflict | — |
| R10 | A foreign row reaches a custom `EventTransport` with its declared personal data (plan 09 F5, unchanged) | existing | out of scope (non-goal); webhooks never delivers foreign rows; F5's follow-up file is recreated (ticket 01) | — |
| R11 | A breaking change for hosts: `AuditLogRecord.payload`, the stream element type, `EventTransport` | certain | ADR-EA-034 pre-1.0 policy: changesets with `Migration:` per ticket; every break is a compile error, none silent | — |
| R12 | A plugin event needs a breaking shape change later, and there is no per-definition upcaster | low | ADR-EA-049 states the consequence: a new tag. Revisit with a real case | — |

**Rollback overall.** Phase 1 tickets are separable commits, and their type widenings revert cleanly. There is no data
migration. Rows written with `meta.pii` decode under the old code, because `StoredMeta` ignores excess keys
(`onExcessProperty: "ignore"` default). A plugin's rows decode under the old core union again once its move is reverted,
since the encoded event is the same. Per-plugin moves revert independently, smallest first.

---

## 8. Interactions with other plans

**Batch 1 (01–10, all landed).**
- **09:** this plan carries out its phase 5. §3.10 lists every deviation.
- **04, 08:** plan 09's gates. Both have landed: organization's events sit in its system modules (§4.4/21), and
  `TestAuth.layer` is the one place that composes test layers (ticket 07).
- **10 item 5:** ADR-EA-037's lanes are read from the definition for `emit` too (E4).
- **02:** `AuditLog` is written once over `AuditLogStore`, so `scrubRow` changes in one place.
- **03:** the erasure cascade is unchanged.
- **05:** webhooks' `subjectUserId` (plan 09 F4) is untouched.
- **01:** `auth.user.{created, signedIn}` stay core's.

**Batch 2 (11–24, review of 2026-10-17).**
- **15 `AuthHost` (not landed):** the composition-owned rule ("a pure function of the plugin tuple") makes `eventsLayer`
  `AuthHost`'s to provide, next to `userFieldsLayer` (plan 15's §3, its `:407`). If 15 lands first, ticket 07 adds the
  line to `AuthHost.layer`, and `TestAuth` and the examples inherit it. If this plan lands first, plan 15 adds
  `built.eventsLayer` to its composition-owned list. Either order works.
- **21 (not landed), 22 (phases 2–9 not landed), 24 (not landed)** edit the same plugin packages: session-minting
  markers in handlers, table DDL in records modules, record adapters. The edits are disjoint; a class's options object
  is the one adjacency. Whichever lands second rebases.
- **23 (landed)** moved `EventRelay`'s cursor behind a store port. The anchors used here are the current ones.
- **13, 14 (landed)** changed `auth.admin.actionDenied` and added `auth.account.linked`, both core's (§2.2).
- **11, 12, 16–19:** no interaction beyond rebasing.

**New round (25–30, review of 2026-11-08).**
- **25 record-store contract:** both plans touch every plugin package. Plan 25 fixes live races (the last owner, quotas,
  the team forest), and this plan fixes none, so **25 goes first**. This plan's core tickets 01–10 may run alongside plan
  25, except ticket 08, which extends `runPluginContractTests` after plan 25 changes it. Each per-plugin ticket 15–21
  runs after plan 25's step for that plugin, organization last. Plan 25's own header already orders it before "plan 15's
  edits to the organization system modules" (its old number for this plan).
- **26 request context:** plugin interfaces drop `ip`/`userAgent`; the envelope's `ip`/`userAgent` come from
  `AuthRequestContext` as today. No moved event carries a client address (only core's `signInFailed.clientIp`). The
  publish neighbourhoods in admin, saml and organization overlap textually: rebase.
- **27 password credential:** rewrites `Password.ts` bodies. Ticket 14 runs after it (plan 27's header agrees).
- **28 SQL store adapters:** disjoint. This plan changes no SQL; `pnpm test:pg` in ticket 05 exercises
  `AuditLogStoreSql`'s rewrite with the new `scrubRow`, and whichever lands second re-runs it.
- **30 speculative follow-ups:** its organization authorize primitive publishes `permissionDenied` from one function
  (plan 30 §RA6). After ticket 21 that call is `emit(OrganizationEvents.OrganizationPermissionDeniedEvent, …)`. Run 30
  after 21, or have 21 rebase over 30's one call site.

**One-line ordering:** run after plan 25. Tickets 01–10 can overlap it (except 08). Moves follow plan 25 plugin by
plugin, password after 27, organization last and before 30. Either order with batch-2 plan 15.

---

## 9. Acceptance checklist

- [ ] `test -e packages/core/src/internal/eventDefinition.ts` fails; `packages/core/src/EventDefinition.ts` exists and is exported (`grep -n 'EventDefinition' packages/core/src/index.ts`).
- [ ] `grep -rnE '\bas\b' packages/core/src/EventDefinition.ts packages/core/src/AuditLog.ts packages/core/src/AuthEvents.ts packages/*/src/*Events.ts` finds only comments (no assertions).
- [ ] `grep -c '= EventDefinition.define($' packages/core/src/AuthEventSchemas.ts` is `24`.
- [ ] `wc -l packages/core/src/AuthEventSchemas.ts` is ≤ 720.
- [ ] `grep -cE '"auth\.(organization|twoFactor|apiKey|scim|saml|webhooks|roles|deviceAuthorization)\.' packages/core/src/AuthEventSchemas.ts` is `0`, and so is `grep -cE '"auth\.admin\.(impersonationSt|user|sessionRevoked|organization)|"auth\.user\.(emailVerified|emailChanged|claimsUpdated)"|"auth\.password\.reset' packages/core/src/AuthEventSchemas.ts`.
- [ ] Eleven `packages/*/src/*Events.ts` modules exist, each exported from its `index.ts` and declared as `events:` on its plugin class (`grep -rn 'events: .*Events.events' packages/*/src`).
- [ ] `grep -rn '\.publish({ _tag: "auth\.\(organization\|twoFactor\|apiKey\|scim\|saml\|webhooks\|roles\|deviceAuthorization\)' packages/*/src` finds 0.
- [ ] `wc -l packages/core/test/support/eventSamples.ts` is ≤ 180.
- [ ] `EventComposition.test.ts` C1–C6 pass; `Auth.make` with a duplicate tag throws `Auth/EventTagConflict`.
- [ ] `AuditLog.test.ts` A1–A6 pass on both stores, and `pnpm test:pg` is green.
- [ ] `AuthEvents.test.ts` E1–E3 and E5, and `AuthEventsUnitOfWork.test.ts` E4, pass.
- [ ] `EventDefinition.plugin.types.test.ts` compiles under `tsc -p tsconfig.test.json`.
- [ ] `grep -n 'knownEventTags' packages/webhooks/src` finds 0; W1–W4 and R1 pass.
- [ ] `grep -n 'payloadOf' packages/test/src/RedactionGuard.ts` finds 0.
- [ ] The template test asserts the audit row, actor, `payloadAs`, typed `on` and `typed(...).is`, in both record modes.
- [ ] `grep -n 'cannot add a tag' docs/plugin-authoring.md` finds 0; checklist item 9 is rewritten; the webhooks README recipe has `auth.eventsLayer`.
- [ ] `awthaq plugin list --events` prints `manifest.events`; `Config.ts`'s `linkErrorCodes` holds `Auth/EventTagConflict` and the five tags of F4.
- [ ] `pnpm check:contract-tests` is green and every plugin's contract run includes the events check.
- [ ] The four BDD scenarios of §6.5 pass (`pnpm test:bdd`) and are mapped in `features/traceability.md`.
- [ ] `spec/decisions/049-plugins-own-event-definitions.md` has status Accepted; ADR-EA-029, 030, 012 and 035 have new revisions; BEH-EA-101's REQUIREMENT matches §6.1; `pnpm spec:verify:strict` is green.
- [ ] A changeset with `Migration:` exists for every package-visible ticket (04–09, 11–21, 24).
- [ ] `pnpm typecheck` wall time is within +10% of ticket 01's baseline, or R6's mitigation is recorded.
- [ ] `pnpm check` is green.

---

## 10. Open questions (only the user can answer)

- **Q1. The raw stream: open-typed with every event, or core-typed with core events only?** The recommended default is
  open-typed (`PublishedAny`), narrowed with `AuthEvents.is(...)`. A consumer that narrows breaks at compile time and a
  forwarder keeps everything. The alternative keeps `stream`/`subscribe` core-typed and filtered to core events, with a
  new `streamAll`/`subscribeAll`. It keeps more consumers compiling, but a SIEM forwarder on `stream` would silently stop
  seeing plugin events.
- **Q2. Rows written before this plan: a frozen three-entry table, or a one-time SQL data migration that stamps
  `meta.pii`?** The recommended default is the frozen table (`PRE_ADR_049_PII`). It needs no data migration, covers rows
  written by an old instance during a rolling deploy, and covers the memory store. The migration (`jsonb_set`/`json_set`
  on `auth_audit_log.payload` for the three tags) would leave no plugin tag strings in core, at the cost of a data
  migration and a rolling-deploy gap.
- **Q3. Should `Validate<P>` also refuse a duplicate event tag at the type level?** The recommended default is no.
  Runtime only, like `GroupIdConflict`/`RouteConflict`/`UserFieldConflict`; a pairwise type-level check costs
  type-checking time on every composition. Revisit if a conflict ever ships to production.
- **Q4. Application (host) events?** `Auth.make([...], { extraEvents })` would let a host record its own events in the
  audit log, like `extraGroups`. The recommended default is not in this plan (no caller today). The design allows it
  (`composeEvents` takes one more list) without an architectural change.
- **Q5. Should webhooks deliver foreign rows to `*` endpoints?** The recommended default is no, fail closed: without a
  definition there is no personal-data list (BEH-EA-277).
- **Q6. Constant names: verbatim (`TwoFactorEvents.TwoFactorEnabledEvent`) or shortened (`TwoFactorEvents.Enabled`)?**
  The recommended default is verbatim. The migration is a namespace swap, grep finds both sides, and the ADR-EA-034 notes
  stay mechanical.
- **Q7. Ordering against plan 25 and batch-2 plan 15.** The recommended default is plan 25 first (it fixes live races),
  and either order with batch-2 plan 15 (§8).
- **Q8. `UndeclaredEventPolicy` default.** The recommended default is `"warn"` in production and `"die"` under
  `TestAuth`. Making production `"die"` would turn a plugin-authoring slip into a failing request.

---

## Decisions taken (implementation record)

### Wave 1 (tickets 01–10): the core interface, nothing moved yet

Branch `feat/plugin-owned-events`, from `origin/main` @ `3c2cdd86` (plans 25, 26 and 27 landed).

**Baseline (ticket 01).** Recorded in `.scratch/29-plugin-owned-events/baseline.md` (untracked), with the 25 issue
files and the recreated plan 09 Q4 file (`.scratch/09-event-definitions/issues/01-relay-scrub-declared-pii.md`,
`needs-triage`). Every §2.1 number matches the plan except `AuditLog.layer` sites (88, not 91) and raw stream uses
(62, not 61). The move table is unchanged: 24 stay, 73 move. The moved blocks span **1,083** lines (each block from its
JSDoc to its `export type`, blank separators excluded; script at `.scratch/29-plugin-owned-events/measure-moved.py`);
the plan's 1,156 came from a script not on file. `auth.user.signInFailed` is now named only by core's `src` (plan 27),
which does not change its place. `packages/core/lib/AuthEventSchemas.d.ts` is 6,318 lines. `pnpm typecheck` takes
4.0 s warm (three runs: 4.00, 4.06, 4.03). `pnpm test`: 5,812 passed, 1 expected fail, 16 skipped. `pnpm test:bdd`:
1,551 passed, 44 skipped, 1 failed (the known local `useInvalidate` flake).

**Shipped (tickets 02–10).**

| Ticket | Commit | What landed |
|---|---|---|
| 02 | `76e879c1` | `packages/core/test/EventDefinition.plugin.types.test.ts`: cases (a)–(f) of §4.1/02 |
| 03 | `1e2784b0` | `spec/decisions/049-plugins-own-event-definitions.md` (Proposed, the §6.2 text), `index.yaml`, `spec/traceability.md` 1.73 |
| 04 | `8eef2091` | `EventDefinition` public (git mv of `internal/eventDefinition.ts`): `define`, `make(members, origin)`, `problems`, `Any`/`TypeOf`/`Input`/`Registry`/`AnyEvent`, `ForeignEventTag`, `UserId`/`SessionId`. Core defines every event with `EventDefinition.define` and `EventDefinition.Actor` (so a move is verbatim); `CoreRegistry`, `coreDefinitions`, `AnyEvent`, `PublishedAny`, `EventRegistry`, `eventRegistryLayer` |
| 05 | `5a3998dd` | `AuditLog.record(event, definition?)`, `meta.pii`, `ForeignEvent`, `PRE_ADR_049_PII`, `payloadAs`, `toPublished` unwrap; string tags in `AuditLog`/`EventRelay`/`Retention`; `PublishedAny` in `EventTransport` and the webhooks payload; `encodeEvent` removed |
| 06 | `8fda4799` | `emit`, one `deliver`, the lane from the definition, `PublishedAny` stream, `AuthEvents.is`, mixed selectors in `on`/`onBatch`, `UndeclaredEventPolicy`/`UndeclaredEvent`, `awthaq_event_undeclared_total`; `RedactionGuard` inspects the published value; 19 tag-filter lambdas and the field-reading raw-stream consumers migrated |
| 07 | `40c84f1c` | `AuthPlugin.Service({ events })`, `"~events"`, `Class`'s ninth parameter `Events`; `Auth.EventsOf<P>`, `Built.events`/`eventsLayer`, `Manifest.events`, `Auth/EventTagConflict`; `AuthEvents.typed`; `AuthHost.layer` provides `eventsLayer`; `TestAuth` sets `"die"`; `awthaq plugin list --events`; `linkErrorCodes` + 6 |
| 08 | `76ba2e37` | contract runner: "every declared event is well-formed" and a sampled P3/P4 case, `events: { notPersonal }` |
| 09 | `4f65d9e6` | webhooks filters/payload/enqueue and Retention rules read `EventRegistry`; `knownEventTags` removed; unknown tags not enqueued |
| 10 | `63554505` | template `NotesEvents` end to end; `docs/plugin-authoring.md` "Events", checklist 9, "Testing a plugin" |

Nothing has moved: `AuthEvents.eventTags.length === 97` (asserted in `EventDefinition.test.ts`).

**Deviations.**
- **`EventDefinition.Any` also pins `Type` to `AnyEvent`** (ticket 02 finding). Without it `TypeOf<Any>` is `Schema.Top`'s `unknown`, and `Published<TypeOf<D>>` fails its constraint. Every `define` result satisfies it.
- **`Input<D>` keeps `_tag` as an optional key** (the `tag()` constructor default) rather than omitting it: the right literal is accepted, another tag is refused. Callers leave it out.
- **`AnyEvent` and `ForeignEventTag` are defined in `EventDefinition`** (the leaf), re-exported by `AuthEventSchemas` (`AuthEvents.AnyEvent`, `AuthEvents.ForeignEventTag`), so `problems` can refuse the reserved tag without a cycle. `ForeignEvent` itself lives in `AuthEventSchemas` as planned (`AuthEvents.ForeignEvent`, not `AuditLog.ForeignEvent`).
- **`AuthEvents` reads `EventRegistry` and `UndeclaredEventPolicy` once, when its layer is built**, not per `emit`: the composition provides both beneath it (`AuthHost.layer`'s last `provideMerge`, `TestAuth`'s platform). Likewise `WebhookDelivery.transportLayer` captures the registry at build and provides it to `enqueue`, which reads it from its context.
- **`AuthEvents.encodeEvent` is removed** (unused once rows are encoded through each definition), announced in changeset 05.
- **Plan 15 (`AuthHost`) has landed**, so `eventsLayer` is provided by `AuthHost.layer` (§8's "if 15 lands first" branch); `TestAuth` and `examples/memory-server` inherit it. BEH-EA-342's harness-parity check (`TestAuthHost.test.ts`, REQ-EA-1325's Then step) now names the one extra service the harness adds, `UndeclaredEventPolicy`.
- **BDD worlds that collect core events filter with `AuthEvents.is(AuthEvents.eventTags)`** (`AdminWorld`, `OrganizationWorld`, `PasswordWorld`, and the `collectEvents` helpers in admin/password tests): they keep `ReadonlyArray<AuthEvent>`. `DomainWorld`/`EventsWorld` hold `PublishedAny` and their readers narrow with `AuthEvents.is`. See the Phase 2 notes below.
- **`problems`' P6 heuristic skips names ending in `Id`/`Ids`**: the template's `noteId` tripped it (ticket 10). Core's set is unaffected.
- **`awthaq plugin list --events` prints text and JSON**, like `--rules` (which has no DOT output either).
- **Retention validates at `sweep` and at `layerScheduled` build**: the scheduled tick logs and retries a failed sweep, which would hide a typo.
- **The sampled P3/P4 check uses `Arbitrary.sampleEffect`** (25 samples per definition, seeded by the tag) inside an async contract case.
- **Moved lines are 1,083**, not 1,156 (baseline above).

**Open questions: the recommended default, applied.** Q1 open-typed stream (`PublishedAny` + `AuthEvents.is`). Q2 the frozen three-entry table (`AuditLog.PRE_ADR_049_PII`), no data migration. Q3 runtime refusal only (`Auth/EventTagConflict`), no `Validate<P>` check. Q4 no host events (`composeEvents` would take one more list). Q5 fail closed: webhooks never delivers a tag its registry lacks. Q6 constant names verbatim (none moved yet; the recipe keeps them). Q7 plan 25 landed first; plan 15 landed first (see above). Q8 `"warn"` in production, `"die"` under `TestAuth`.

**Ids.** ADR-EA-049 (049 was the next free; 048 is plan 27's). No new BEH id (BEH-EA-346 stays free) and no new REQ-EA id: the composition BEH and the §6.5 scenarios are ticket 23/24's. A REQ-EA id added later should start at 1510 (open PR #61 uses 1502/1503).

**What only Postgres CI proves.** `pnpm test:pg` was not run (Postgres is down locally). CI's Postgres run covers: `AuditLogStoreSql.rewriteReferencing` applying the new `scrubRow` (A3/A4 ran on memory and SQLite here); `AuthEventsUnitOfWork.test.ts` E4 under Postgres transactions (and the tenanted-request case, Postgres-only); the SQL record mode of `TestAuthHost.test.ts` and of the template's event suite on Postgres; the contract runner's SQL cases.

**Phase 2 notes (the move recipe with the interface as built).**
- Core already writes `EventDefinition.define(`, `EventDefinition.Actor.` and `EventDefinition.UserId`/`.SessionId`, so recipe step 1 is a pure cut-and-paste of each block (JSDoc, `define`, `export type`): add `import { EventDefinition } from "@awthaq/core"; import * as Schema from "effect/Schema";`, copy `RoleNames` where used, and export `events = [...]` (an array, no `as const`).
- Declare: `AuthPlugin.Service<...>()(id, { ..., events: XEvents.events })`.
- Publish: `events.emit(XEvents.XEvent, { ...fields })` (drop `_tag`). `emit` returns `Effect<void>`, like `publish`. A publisher that is not the plugin's `make` (two-factor's `SecondFactor`, saml's `SamlSlo`, organization's system modules) already holds an `AuthEventsShape`, which has `emit`.
- Core: delete the blocks and their `CoreRegistry` entries, their samples in `test/support/eventSamples.ts`, the `AuditLog.test.ts` actor rows and the attempt-set entries in `EventDefinition.test.ts`, and lower the `eventTags.length`/`coreDefinitions.length === 97` assertions in `EventDefinition.test.ts` by the moved count (`AuthPlugin.test.ts`'s manifest owner check maps `eventTags`, so it follows). Ticket 20 also breaks `packages/cli/test/Inspection.test.ts`'s `--events` case, which reads the `auth.admin.impersonationStarted` row from a `[Password, Roles]` composition: point it at an event that composition still holds (after ticket 20 no core event declares `pii`).
- Consumers: an `AuthEvents.is("auth.x.y")` or `on("auth.x.y")` naming a moved tag stops compiling: switch it to `AuthEvents.is(XEvents.XEvent)`/`on(XEvents.XEvent)`. **Silent trap:** the worlds and helpers that filter with `AuthEvents.is(AuthEvents.eventTags)` (`AdminWorld`, `OrganizationWorld`, `PasswordWorld`, admin's `AdminAccounts`/`AdminUsers`/`AdminGate` tests, `PasswordChangeEmail.test.ts`) keep compiling but drop the moved events: widen each one's array to `AuthEvents.PublishedAny` (or add the plugin's definitions to the selector) in the move that needs it. `AuthEvents.payloadOf` throws for a moved event: use `Schema.decodeUnknownSync(XEvents.XEvent)`. An audit-row reader uses `AuditLog.payloadAs(XEvents.XEvent)`.
- The webhooks BDD step `"the payload of event {string} is built with includeClientContext"` passes `AuthEvents.piiFieldsOf` (core's): for the moved `pii` events (admin's two, organization's suspension) pass the composed registry's `piiFieldsOf` instead.
- `TestAuth.layer` dies on an emitted tag the composition does not declare, so a plugin that emits without declaring fails its own suite at once. The contract runner checks each moved definition; `auth.authz.denied.reason` is the only `notPersonal` entry core needed, and it stays in core.
- Rows written before a move carry no `meta.pii`; the three `pii` tags are in `PRE_ADR_049_PII`, so ticket 20/21's `meta.pii` test should assert a *new* row carries `meta.pii: ["reason"]`.

**`pnpm check` (end of Wave 1).** Every step through `pnpm coverage` passed (5,920 tests, 1 expected fail, 16 skipped). `pnpm test:bdd` failed one React scenario under load, "A just-revoked permission does not render a stale allow while re-evaluating" (`23-react`); re-run alone it passes, and the file's only failure alone is the known local `useInvalidate` flake (green in CI). `pnpm spec:verify:strict`, which `pnpm check` did not reach, passes on its own (32/32).
