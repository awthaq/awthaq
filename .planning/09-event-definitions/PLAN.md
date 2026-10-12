# 09 — Event metadata travels with the event schema

| Property | Value |
|---|---|
| Strength | Speculative (phases 1–4 are low-risk and fix two live gaps; phase 5 is a real design change, gated on the user) |
| Dependency category | in-process |
| Wave | A (independent, small) — see `.planning/README.md` |
| Tracker | `.scratch/event-definitions/issues/NN-*.md` (tickets listed in §4.7) |
| Touches | `@awthaq/core`, `@awthaq/webhooks`, `features/`, `spec/`, `docs/plugin-authoring.md`; phase 5 also every plugin package that publishes events |
| Wire change | none in phases 1–3; phase 4 drops one or two operator-note fields from webhook bodies (gated, Q2); phase 5 none on the wire, but the `AuditLogRecord.payload` type widens |

---

## 1. Summary, goals, non-goals

### Summary

Every `AuthEvent` today has three facts that live in three different modules:

1. **Its shape** — a `Schema.TaggedStruct` in `packages/core/src/AuthEventSchemas.ts`, plus a line in the `AuthEventSchema` union.
2. **Who acted** — one `case` in the 92-case `actorOf` switch in `packages/core/src/AuditLog.ts:163-276`.
3. **Which fields are free text about a person** — an entry in `PII_FIELDS` (`AuthEventSchemas.ts:1127`), which the erasure path (`AuditLog.scrubRow`) and the webhooks payload builder (`WebhookPayload.toBody`) both read.

The switch is exhaustive on purpose, and that compile-time guarantee is worth keeping. `PII_FIELDS` has no such guarantee: it is a `Record<string, ReadonlyArray<string>>`, so a misspelled tag or field name compiles, and a new event that carries free text compiles fine when nobody lists it. This has already happened (§2.5).

The change is a deeper **module**: one constructor, `defineEvent(tag, fields, { actor, pii })`. It returns the same `TaggedStruct`, with a typed, declarative metadata record attached. The registry builder accepts only such definitions. `actorOf` and the PII lookup become generic readers over that metadata. The **interface** for adding an event becomes one call in one place. The compiler still forces the actor decision, and now also checks each field name against the event's own fields. The **implementation** behind it (field lookup, prefix stripping, blanking) is written once.

An optional fifth phase moves plugin-owned events into their plugins, which fixes the second friction: a plugin cannot publish an event core does not know about. That phase changes BEH-EA-101's "closed registry" requirement and how `AuditLog` decodes rows from an uninstalled plugin. It is designed here but runs only on the user's go-ahead (Q1).

### Goals

- G1. The actor and the personal-data fields of an event are declared **with** its schema, and the compiler enforces both. Leaving either out, naming a field the event does not have, or naming a field of the wrong kind is a type error.
- G2. `actorOf` and the PII blanking become generic readers over that metadata. The 92-case switch and `PII_FIELDS` are deleted.
- G3. Behaviour stays exactly the same: the same `actorUserId` column value for every event and the same blanked fields on erasure. This is proven by a parity test that runs the old switch and the new reader side by side over every event (fixtures plus a schema-derived property test) before the switch is removed.
- G4. Fix the two live gaps this exposes. (a) The memory `AuditLog` blanks free text on rows that don't name the erased user (drift from `layerSql`). (b) Operator free text (`auth.admin.userBanned.reason`, and possibly `auth.admin.organizationSuspended.reason`) is not declared personal data. (b) is gated on Q2.
- G5. One reader of "every tag the library can publish" (`AuthEvents.eventTags`) replaces three ad-hoc AST reads.
- G6 (phase 5, gated). A plugin declares its own events and contributes them to the composed registry, as it does with `userFields` today (ADR-EA-035).

### Non-goals

- No change to the encoded event shape, `EVENT_VERSION` (stays `1`), `upcastPayload`, the audit table, or the relay cursor.
- No change to who counts as an event's actor. The parity test pins today's answers, including the debatable ones (for example `auth.scim.*` has no actor, and `auth.user.deleted`'s actor is the deleted user).
- No change to webhooks' `subjectUserId` heuristic (a fourth per-event rule, §2.5 finding F4). It is recorded as an open question (Q5) and an input to plan 05, not changed here.
- No change to `AuthEvents.countEvent` (two metric counters with a `default`, not per-event metadata) or to `SecuritySignals` rules (tag-keyed policy, not metadata).
- No storing of metadata as Effect `Schema` annotations. §3.1 explains why the typed property was chosen instead; mirroring it into annotations is Q3.

---

## 2. Verified inventory

All line numbers are as of the 2026-10-13 tree (`main` @ `38bcd1b`).

### 2.1 Event count by owner (92 events)

The owner is the set of `packages/*/src` that publish or match the tag, excluding `AuthEventSchemas.ts` and `AuditLog.ts`. Every one of the 92 has at least one publisher.

| Owner | # | Tags |
|---|---|---|
| core | 10 | `auth.token.replay`, `auth.user.deleted`, `auth.user.dataExported`, `auth.session.{reuse,issued,rotated,superseded,revoked,expired}`, `auth.mail.failed` |
| shared across packages (must stay core-owned) | 6 | `auth.user.created` (magic-link, oauth, password, saml), `auth.user.signedIn` (device-authorization, magic-link, oauth, passkey, password, saml, two-factor), `auth.user.signInFailed` (core `AuthEvents.countEvent`/`SecuritySignals`, magic-link, oauth, passkey, password, saml), `auth.password.changed` (admin, password), `auth.admin.actionDenied` (admin, saml, webhooks), `auth.rateLimit.exceeded` (core, device-authorization) |
| shared with core `SecuritySignals` | 2 | `auth.passkey.counterAnomaly` (passkey), `auth.admin.impersonationDenied` (admin) |
| organization | 21 | all `auth.organization.*` |
| admin | 11 | `auth.admin.{impersonationStarted, impersonationStopped, userUpdated, sessionRevoked, userBanned, userUnbanned, userDeleted, userEmailChangeRequested, userPasswordSet, organizationSuspended, organizationUnsuspended}` |
| two-factor | 7 | all `auth.twoFactor.*` |
| api-key | 6 | all `auth.apiKey.*` |
| scim | 5 | all `auth.scim.*` |
| webhooks | 5 | all `auth.webhooks.*` |
| saml | 5 | `auth.saml.{connectionCreated, connectionUpdated, connectionDeleted, signingKeyRotated, logoutRejected}` |
| password | 4 | `auth.user.emailVerified`, `auth.user.emailChanged`, `auth.password.resetRequested`, `auth.password.resetCompleted` |
| cli (not a composed plugin) | 4 | `auth.admin.seeded`, `auth.admin.seedRefused`, `auth.import.completed`, `auth.import.failed` |
| roles | 2 | `auth.roles.assigned`, `auth.roles.revoked` |
| qadi | 2 | `auth.authz.denied` (`DecisionSinkAudit`), `auth.user.claimsUpdated` (`UserClaims` plugin) |
| device-authorization | 2 | `auth.deviceAuthorization.{approved,denied}` |

So **74 of 92 event definitions belong to a single plugin package** but live in core. Phase 5 could move about 70 of them (§4.6). The 18 shared or core-referenced ones, and the CLI's 4 (the CLI is not composed through `Auth.make`), must stay in core.

### 2.2 The edit sites for one new event (more than three)

Adding one event today means editing:

| # | Site | Compiler-enforced? |
|---|---|---|
| 1 | `export const XEvent = Schema.TaggedStruct(...)` + `export type XEvent` in `core/src/AuthEventSchemas.ts` | — |
| 2 | Its entry in the `Schema.Union([...])` list, `AuthEventSchemas.ts:971-1064` | indirectly (publish site fails to type-check if missing) |
| 3 | A `case` in `actorOf`, `core/src/AuditLog.ts:163-276` | **yes** (`const exhaustive: never = event`) |
| 4 | `PII_FIELDS`, `AuthEventSchemas.ts:1127` | **no** (`Record<string, …>`: typos and omissions compile) |
| 5 | A sample in `core/test/AuditLog.test.ts:72-…` (`samples` mapped over `AuthEventTag`) | yes |
| 6 | `WebhookPayload.subjectUserId`'s field list, `webhooks/src/WebhookPayload.ts:103-109`, if the user field has a new name | **no** |

Plus the taxonomy paragraph in `spec/behaviors/13-events.md` BEH-EA-101.

### 2.3 The `actorOf` switch, as data (the migration source of truth)

`AuditLog.ts:163-276`, 92 cases, grouped by what they return:

| Rule | Count | Tags |
|---|---|---|
| `some(event.userId)` | 39 | `auth.user.{created, signedIn, emailVerified, emailChanged, deleted, dataExported}`, `auth.session.{reuse, issued, rotated, superseded, revoked, expired}`, `auth.password.{changed, resetRequested, resetCompleted}`, `auth.passkey.counterAnomaly`, `auth.organization.{memberAdded, memberRemoved, memberRoleUpdated, invitationAccepted, teamMemberAdded, teamMemberRoleUpdated, teamMemberRemoved, permissionDenied}`, `auth.twoFactor.*` (7), `auth.apiKey.*` (6), `auth.deviceAuthorization.{approved, denied}` |
| `some(event.adminUserId)` | 22 | `auth.admin.{impersonationStarted, impersonationStopped, impersonationDenied, actionDenied, userUpdated, userBanned, userUnbanned, userDeleted, userEmailChangeRequested, userPasswordSet, sessionRevoked, organizationSuspended, organizationUnsuspended}`, `auth.webhooks.*` (5), `auth.saml.{connectionCreated, connectionUpdated, connectionDeleted, signingKeyRotated}` |
| `fromNullishOr(event.userId)` (optional key) | 1 | `auth.mail.failed` |
| `fromNullishOr(event.actorUserId)` (optional) | 3 | `auth.roles.assigned`, `auth.roles.revoked`, `auth.user.claimsUpdated` |
| `subjectId` minus `"user:"` prefix, else none | 1 | `auth.authz.denied` |
| `some(event.creatorUserId)` | 1 | `auth.organization.created` |
| `none()` | 25 | `auth.token.replay`, `auth.rateLimit.exceeded`, `auth.user.signInFailed`, `auth.scim.*` (5), `auth.saml.logoutRejected`, `auth.admin.{seeded, seedRefused}`, `auth.import.{completed, failed}`, `auth.organization.{updated, deleted, invitationCreated, invitationRejected, invitationCanceled, roleCreated, roleUpdated, roleDeleted, teamCreated, teamUpdated, teamMoved, teamDeleted}` |

Parity detail the reader must keep: a required field returns `some` **even for the empty string** (`Option.some(UserId(""))`). Only `undefined`/`null` gives `none`, and only on the optional rules.

### 2.4 Every consumer of the metadata, and of the registry

| Consumer | File:line | Reads | After this plan |
|---|---|---|---|
| `AuditLog.toStoredRow` | `core/src/AuditLog.ts:311` | `actorOf(published)` → `actorUserId` column | `Option.map(AuthEvents.actorOf(published), UserId)` |
| `AuditLog.scrubRow` | `core/src/AuditLog.ts:380-384` | `PII_FIELDS[row.eventTag] ?? []`, `blankFields` | `piiFieldsOf(row.eventTag)` + a "row references the user" guard (§4.2 step 1b) |
| `AuditLog.layerMemory.pseudonymizeActor` | `core/src/AuditLog.ts:459-472` | `scrubRow` over **every** row | unchanged call; fixed by the guard |
| `AuditLog.layerSql.pseudonymizeActor` | `core/src/AuditLog.ts:544-560` | `scrubRow` over `repo.listReferencing(userId)` rows (`actorUserId = $1 OR payload LIKE %id%`, `sql/src/Repositories.ts:2306`) | unchanged |
| `DataExport` activity | `core/src/DataExport.ts:127-128` | `auditLog.list({ actorUserId })`, so it depends on `actorOf` | unchanged; parity keeps the export identical |
| `Erasure` | `core/src/Erasure.ts:133` | `auditLog.pseudonymizeActor` | unchanged |
| `WebhookPayload.toBody` | `webhooks/src/WebhookPayload.ts:70` | `AuthEvents.PII_FIELDS[event._tag] ?? []` | `AuthEvents.piiFieldsOf(event._tag)` |
| `WebhookPayload.knownEventTags` | `webhooks/src/WebhookPayload.ts:151-156` | `AuthEventSchema.members[].fields._tag.ast.literal` | `AuthEvents.eventTags` |
| BDD `registryTags` / `isRegistryTag` | `features/step-definitions/EventsSteps.ts:30-43` | same AST read + hand guard | `AuthEvents.eventTags` (typed `ReadonlyArray<AuthEventTag>`) |
| BDD secret-field scan | `features/step-definitions/PersistenceStratumSteps.ts:317` | `AuthEventSchema.members[].fields` | unchanged (still valid) |
| `RedactionGuard.layerEvents` | `test/src/RedactionGuard.ts:249` | `AuthEvents.payloadOf` (decode only; **not** `PII_FIELDS`) | unchanged (phase 5: registry-aware) |
| `EventRelay` | `core/src/EventRelay.ts` | `AuditLog.replay` → `toPublished`; no metadata | unchanged (Q4 asks whether it should scrub `pii`) |
| `scripts/check-error-tags.mjs` | — | scans `Data.TaggedError`/`Schema.TaggedError` declarations and `die(new Error(`; **does not touch events** | no change |
| Comments/docs naming `PII_FIELDS` | `AuthEventSchemas.ts:21-25,263`; `AuthEvents.ts:23`; `AuditLog.ts:139`; `WebhookPayload.ts:7`; `webhooks/test/WebhookPayload.test.ts:54`; `spec/decisions/029-event-pii-posture.md:24`; `spec/behaviors/13-events.md:104`; `spec/behaviors/34-webhooks.md:64` (BEH-EA-277) | text | reworded (§6) |

There is no event registry other than the `AuthEventSchema` union. `AuthEvent`, `AuthEventTag`, `EventOf<Tag>` and `Published<E>` are all derived from it (`AuthEventSchemas.ts:1066-1098`), and `AuthEvents.ts` re-exports the whole module with `export * from "./AuthEventSchemas.ts"`. `AuthEvents.publish` takes `AuthEvent`. So **a plugin cannot publish an event that is not in core's closed union**, even though BEH-EA-101's prose says the registry "lets a plugin author add a new event tag without breaking existing subscribers". This is the second friction, and phase 5 addresses it.

### 2.5 Findings the inventory surfaced

- **F1 — Undeclared operator free text (ADR-EA-029 gap, live).** `auth.admin.userBanned.reason` is the administrator's note about the banned person (`admin/src/Admin.ts:1000`, from `AdminApi` `ReasonSchema`). BEH-EA-27 (BAM-005) says it "is returned to administrators and never to the banned user". Today it is not in `PII_FIELDS`, so: (a) erasing the banned user pseudonymizes the ids in the row but keeps the note verbatim, and (b) `@awthaq/webhooks` sends it to every subscribed third-party endpoint. `auth.admin.organizationSuspended.reason` (`admin/src/AdminTenants.ts:256`) is the same kind of field, but about an organization. Phase 4, gated on Q2.
- **F2 — Memory/SQL drift in erasure (test layer, live).** `layerMemory.pseudonymizeActor` runs `scrubRow` on every row. `scrubRow` blanks the `PII_FIELDS` of the row's tag whether or not the row names the erased user, so erasing *any* user in the memory layer blanks *every* impersonation justification and counts those rows as rewritten. `layerSql` only scrubs rows from `listReferencing`. The existing test passes only because its one impersonation row targets the erased user. Fixed in phase 1 (ticket 02).
- **F3 — The blank value is `""`.** A future `pii` field that is a literal union (or a number) would blank to a value that no longer decodes, and `AuditLog.list`/`replay` (and so the relay) would fail with `AuditLogDecodeError` after an erasure. Nothing prevents this today. The new `pii` typing only accepts fields whose encoded side accepts `""` (§3.3).
- **F4 — A fourth per-event rule in webhooks.** `WebhookPayload.subjectUserId` (`webhooks/src/WebhookPayload.ts:103`) picks the first of `userId`/`targetUserId`/`adminUserId` to key the delivery log's erasure and export. It misses `creatorUserId`, `actorUserId` and `subjectId`. For an admin event it records the *target*, so erasing the *administrator* leaves their id in the stored delivery bodies. Not fixed here (Q5, plan 05).
- **F5 — The relay hands declared PII to custom transports.** `EventRelay` passes the full `Published` event, impersonation `reason` included, to an application `EventTransport`. Only the webhooks transport drops it. ADR-EA-030 Decision 6 says "what crosses the transport is identifiers and envelope only". Not fixed here (Q4).

### 2.6 Wire-format implications

- `defineEvent` returns the same `TaggedStruct` AST. The metadata is a plain property on the schema object, not part of the AST, so `encodeEvent`, `decodeEvent` and `payloadOf` produce byte-identical output. **The stored audit payload, `EVENT_VERSION` (1), the relay's `Published` events and the webhook `WebhookBody` are unchanged in phases 1–3.** No upcaster and no data migration are needed.
- The `auth_audit_log.actorUserId` column is computed by the new reader. Parity (G3) guarantees the same value for every event, so existing rows and `list({ actorUserId })` queries are unaffected.
- Phase 4 (if Q2 says yes) drops `reason` from webhook `data` for `auth.admin.userBanned` (and maybe `auth.admin.organizationSuspended`), and blanks it on erasure. That is a breaking change for webhook receivers that read it, so it ships as a `minor` changeset with a `Migration:` note (ADR-EA-034 §2).
- Phase 5 moves no tags and changes no payloads. Rows written before and after decode the same way, provided the plugin is still composed. A row whose plugin was removed decodes to a new `ForeignEvent` instead of failing (§4.6).

---

## 3. Target design

### 3.1 Where the metadata lives: a typed property, not an annotation

The brief proposed storing the actor resolver and PII list as Effect `Schema` annotations. Checked against `../effect/packages/effect/src` (Schema.ts `annotate` :669, `Annotations` :16453-16570, `resolveAnnotations` :16422; SchemaAST.ts `annotate` :4384, `resolve`/`resolveAt` :5134-5149), annotations are the wrong storage here:

1. **They are untyped when read.** `Annotations.Annotations` is `{ readonly [x: string]: unknown }`. Getting a typed read back means globally augmenting `effect/Schema`'s `Annotations` interface from `@awthaq/core`, which leaks into every consumer's type environment. The alternative is decoding the value at every read.
2. **They carry no compile-time proof.** `TaggedStruct<Tag, Fields>` has the same type with or without an annotation, so "every union member declared an actor" could only be checked at runtime. That loses the one property the switch has today.
3. **A resolver closure would not survive a decode.** Reading a function back from an `unknown` and calling it with the event needs an assertion. Calling it through a correlated mapped type built from an array also needs one (`Object.fromEntries` widens).

**Decision:** the metadata is **declarative data** (field names, a prefix, a list), attached to the schema object returned by `defineEvent` under the key `"~awthaq/event"`. This uses `Object.assign`, typed `T & U`, with no assertion. The key follows the repo's `"~userFields"` precedent (`AuthPlugin.ts:109`) and Effect's own `~` keys. Consequences:

- The intersection type is the compile-time proof: `registry([...])` requires every member to carry `"~awthaq/event"`, so a plain `Schema.TaggedStruct` in the list is a type error.
- `Schema.Union(members)` keeps member identity (`Union<Members>.members: Members`), so `AuthEventSchema.members[i]["~awthaq/event"]` is typed with no lookup.
- A rebuild (`.annotate`, `.pipe(...)`) returns a new schema object without the property. The registry then rejects that member at compile time, which is the loud failure we want.
- Readers are plain data walkers: `Reflect.get` plus a `typeof` check, the same idiom as `WebhookPayload.subjectUserId`. No `as` anywhere.

Verified runtime premise: `internal/schema/make.ts:46-58` builds a schema as a fresh function object with `SchemaProto` as its prototype. It is not frozen, so `Object.assign` with a new key is safe. A unit test pins this (§5.1, T1), so an Effect RC that starts freezing schemas fails loudly at test time.

### 3.2 Module layout

| Module | Role | Exported from `index.ts`? |
|---|---|---|
| `packages/core/src/internal/eventDefinition.ts` (new) | `defineEvent`, `Actor`, `EventMeta`/`EventMetaSchema`, `Defined`, `registry`, the generic readers. A leaf: imports only `effect/Schema`, `effect/Option`, `effect/Brand` (types). | no (phases 1–4); promoted to `src/EventDefinition.ts` in phase 5 |
| `packages/core/src/AuthEventSchemas.ts` | the 92 `defineEvent(...)` calls, `registry([...])`, and the registry-bound exports: `AuthEventSchema`, `eventTags`, `actorOf`, `piiFieldsOf` | via `AuthEvents` (`export *`) |
| `packages/core/src/internal/legacyEventMeta.ts` (temporary, phases 1–2) | the old switch moved out of `AuditLog.ts` verbatim as `legacyActorOf`, so the parity test can import it | no; deleted in phase 3 |
| `packages/core/src/AuditLog.ts` | uses `actorOf`/`piiFieldsOf`; keeps `replaceDeep`, `blankFields`, `scrubRow` (with the reference guard) | unchanged surface |

`AuthEventSchemas.ts` stays a leaf with respect to `AuthEvents`/`AuditLog`/`Users`, as its header requires. Brands are still declared locally (`Schema.brand("UserId")`), and the reader returns `Option<string>`. `AuditLog` maps the result to `UserId` with `Brand.nominal`, which is no assertion.

### 3.3 TypeScript sketch: `internal/eventDefinition.ts`

No `as`. No return type annotations on consts (the plain helper functions also rely on inference). `satisfies` gives contextual literal typing and is not an assertion.

```ts
import type * as Brand from "effect/Brand";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The property `defineEvent` stamps on a schema; the registry accepts nothing without it. */
export const MetaKey = "~awthaq/event";

// ---- the erased (runtime) shape: plain data, so it can be validated with a Schema --------------
export const ActorSpecSchema = Schema.Union([
  Schema.TaggedStruct("None", {}),
  Schema.TaggedStruct("Field", { field: Schema.String }),
  Schema.TaggedStruct("Prefixed", { field: Schema.String, prefix: Schema.String }),
]);
export const EventMetaSchema = Schema.Struct({
  tag: Schema.String,
  actor: ActorSpecSchema,
  pii: Schema.Array(Schema.String),
});
export type EventMeta = typeof EventMetaSchema.Type;

/** What a registry member must carry: only `defineEvent` produces it. */
export interface Defined {
  readonly [MetaKey]: EventMeta;
}

// ---- the typed (write-time) shape: field names checked against the event's own fields ----------
type Fields = Schema.Struct.Fields;

/** Keys whose decoded value is a user id (optional or not): the only legal actor fields. */
type UserIdKey<F extends Fields> = {
  [K in keyof F & string]: NonNullable<F[K]["Type"]> extends Brand.Brand<"UserId"> ? K : never;
}[keyof F & string];

/** Keys holding a plain string (for a prefixed actor such as qadi's `subjectId`). */
type StringKey<F extends Fields> = {
  [K in keyof F & string]: K extends "_tag" ? never : F[K]["Type"] extends string ? K : never;
}[keyof F & string];

/**
 * Keys that may be declared personal data: free text, i.e. not a branded id, and whose
 * *encoded* side accepts the blank `""` erasure writes (F3: a literal or a number would make
 * the scrubbed row undecodable).
 */
type FreeTextKey<F extends Fields> = {
  [K in keyof F & string]: K extends "_tag"
    ? never
    : NonNullable<F[K]["Type"]> extends Brand.Brand<string>
      ? never
      : "" extends F[K]["Encoded"]
        ? K
        : never;
}[keyof F & string];

interface NoActor { readonly _tag: "None" }
interface FieldActor<K extends string> { readonly _tag: "Field"; readonly field: K }
interface PrefixedActor<K extends string> {
  readonly _tag: "Prefixed";
  readonly field: K;
  readonly prefix: string;
}

export const Actor = {
  /** No user acted (a directory, the CLI, an anonymous attempt, an org-level change). */
  none: { _tag: "None" } satisfies NoActor,
  /** The user id in `field` acted; an optional field that is absent means no actor. */
  field: <const K extends string>(field: K) => ({ _tag: "Field", field }) satisfies FieldActor<K>,
  /** `field` holds `<prefix><userId>` when a user acted (qadi's `user:<id>` subject); anything else is no actor. */
  prefixed: <const K extends string>(field: K, prefix: string) =>
    ({ _tag: "Prefixed", field, prefix }) satisfies PrefixedActor<K>,
};

interface Declaration<F extends Fields> {
  /** Required: every event decides who acted (the old switch's exhaustiveness, by construction). */
  readonly actor: NoActor | FieldActor<UserIdKey<F>> | PrefixedActor<StringKey<F>>;
  /** Required, usually `[]`: the fields holding free text about a person (ADR-EA-029). */
  readonly pii: ReadonlyArray<FreeTextKey<F>>;
}

export const defineEvent = <const Tag extends string, const F extends Fields>(
  tag: Tag,
  fields: F,
  declaration: NoInfer<Declaration<F>>,
) =>
  Object.assign(Schema.TaggedStruct(tag, fields), {
    [MetaKey]: { tag, actor: declaration.actor, pii: declaration.pii },
  });

// ---- generic readers (the only implementation of "who acted" and "what to blank") ---------------
const stringAt = (event: object, field: string) => {
  const value: unknown = Reflect.get(event, field);
  return typeof value === "string" ? Option.some(value) : Option.none<string>();
};

/** Parity with the old switch: a present string is the actor, even `""`; only absence is `none`. */
export const actorValue = (meta: EventMeta, event: object) => {
  switch (meta.actor._tag) {
    case "None":
      return Option.none<string>();
    case "Field":
      return stringAt(event, meta.actor.field);
    case "Prefixed": {
      const { prefix } = meta.actor;
      return stringAt(event, meta.actor.field).pipe(
        Option.filter((value) => value.startsWith(prefix)),
        Option.map((value) => value.slice(prefix.length)),
      );
    }
  }
};

export const registry = <const Members extends ReadonlyArray<Schema.Constraint & Defined>>(
  members: Members,
) => {
  const byTag = new Map<string, EventMeta>(members.map((m) => [m[MetaKey].tag, m[MetaKey]]));
  return {
    schema: Schema.Union(members),
    /** Typed as the union of the members' literal tags, so it narrows to `AuthEventTag`. */
    tags: members.map((m) => m[MetaKey].tag),
    actorOf: (event: { readonly _tag: string }) => {
      const meta = byTag.get(event._tag);
      return meta === undefined ? Option.none<string>() : actorValue(meta, event);
    },
    piiFieldsOf: (tag: string) => byTag.get(tag)?.pii ?? [],
  };
};
```

Things to verify at implementation time, not by assumption:

- `NonNullable<F[K]["Type"]>` on `Schema.optionalKey(UserIdSchema)` (`auth.mail.failed.userId`) and `Schema.optional(UserIdSchema)` (`auth.roles.*.actorUserId`) must resolve to the branded `UserId`. The `exactOptionalPropertyTypes` setting does not affect a field schema's `Type`. A type test covers both (§5.1, T2).
- `Schema.Struct.Fields` is the exported namespace type (`Schema.ts:3339`). `Schema.Constraint` exposes `"Type"` and `"Encoded"` (`Schema.ts:803-821`).
- `members.map((m) => m[MetaKey].tag)` on a `const` tuple infers `Members[number]["~awthaq/event"]["tag"][]`, which is the literal tag union. If TS widens it to `string`, add a generic `Tag` parameter to `Defined` (`Defined<Tag extends string>`) instead of asserting.
- `noPropertyAccessFromIndexSignature` is on, so always use the bracketed `m[MetaKey]`.

### 3.4 `AuthEventSchemas.ts` after the migration

```ts
import { Actor, defineEvent, registry } from "./internal/eventDefinition.ts";

export const UserSignedInEvent = defineEvent(
  "auth.user.signedIn",
  { userId: UserIdSchema, strategy: Schema.String },
  { actor: Actor.field("userId"), pii: [] },
);
export type UserSignedInEvent = typeof UserSignedInEvent.Type; // unchanged

export const AdminImpersonationStartedEvent = defineEvent(
  "auth.admin.impersonationStarted",
  { adminUserId: UserIdSchema, targetUserId: UserIdSchema, reason: Schema.String, sessionId: SessionIdSchema },
  { actor: Actor.field("adminUserId"), pii: ["reason"] },
);

export const AuthorizationDeniedEvent = defineEvent(
  "auth.authz.denied",
  { subjectId: Schema.String, evaluationId: Schema.String, policyTag: Schema.String,
    action: Schema.optional(Schema.String), reason: Schema.String },
  // qadi's subject id: only a `user:` subject names an awthaq user.
  { actor: Actor.prefixed("subjectId", "user:"), pii: [] },
);

export const ScimUserProvisionedEvent = defineEvent(
  "auth.scim.userProvisioned",
  { connectionId: Schema.String, organizationId: Schema.String, userId: UserIdSchema },
  // CWM-002: a directory acts, not a user — the connection id rides in the payload.
  { actor: Actor.none, pii: [] },
);

// ... all 92 ...

const Registry = registry([TokenReplayEvent, UserCreatedEvent, /* ...same order as today... */]);

/** BEH-EA-101: the closed, statically-known set of event types `AuthEvents` carries. */
export const AuthEventSchema = Registry.schema;
export type AuthEvent = typeof AuthEventSchema.Type;            // unchanged
export type AuthEventTag = AuthEvent["_tag"];                   // unchanged
/** Every tag the library can publish (replaces three hand-rolled AST reads). */
export const eventTags = Registry.tags;
/** Who acted, as a raw id: `AuditLog` brands it; a relay/SIEM consumer can call it too. */
export const actorOf = Registry.actorOf;
/** ADR-EA-029: the fields of `tag` that hold free text about a person (blanked on erasure, never sent to a webhook). */
export const piiFieldsOf = Registry.piiFieldsOf;
```

The comments that today sit beside the switch's `none` cases (CWM-002, ECS-006/ECS-002, the `@awthaq/saml` logout note, qadi's subject) move next to the `actor:` line of the event they describe, so the reason stays next to the decision.

### 3.5 `AuditLog.ts` after the migration

```ts
import { actorOf, piiFieldsOf, /* ... */ } from "./AuthEventSchemas.ts";

// toStoredRow
actorUserId: Option.getOrNull(Option.map(actorOf(published), UserId)),

/** True when erasing `userId` must touch this row: the same predicate `listReferencing` applies in SQL. */
const references = (row: StoredRow, userId: string) =>
  row.actorUserId === userId || JSON.stringify(row.payload).includes(userId);

/** ESA-005: what erasing `userId` does to one row — nothing, unless the row names them (F2). */
const scrubRow = (row: StoredRow, userId: string, alias: string): StoredRow =>
  references(row, userId)
    ? {
        ...row,
        actorUserId: row.actorUserId === null ? null : row.actorUserId.replaceAll(userId, alias),
        payload: blankFields(replaceDeep(row.payload, userId, alias), piiFieldsOf(row.eventTag)),
      }
    : row;
```

`references` mirrors `sql/src/Repositories.ts:2240` exactly: `"actorUserId" = ${userId} OR payload LIKE %userId%`. The actor test there is equality, and the payload test is a substring match over the stored JSON text, which is what `JSON.stringify(row.payload).includes(userId)` reproduces in memory.

### 3.6 How exhaustiveness is guaranteed at compile time

| Old guarantee (switch) | New guarantee |
|---|---|
| A union member with no `case` fails `const exhaustive: never` | A union member without `"~awthaq/event"` fails `registry([...])`'s `Members extends ReadonlyArray<Schema.Constraint & Defined>`. Only `defineEvent` produces that property. |
| A `case` reading `event.adminUserId` on an event without it fails | `Actor.field("adminUserId")` fails unless `adminUserId` is a `UserId`-typed field of *that* event (`UserIdKey<F>`) |
| — (none: `PII_FIELDS` is `Record<string, …>`) | `pii` is required, and each entry must be a free-text field of *that* event whose encoded side accepts `""` (`FreeTextKey<F>`), so a typo, an id field, a literal or a number is a type error |
| — | `actor` is required: "forgot to decide" is not expressible |

What stays a runtime/test check (§5.1, T3): that tags are unique across the registry, and that `meta.tag` equals the schema's literal. Both are by construction in `defineEvent`, but cheap to assert. Also the free-text naming heuristic (T3-P6), which catches the *classification* mistake behind F1, something no type can catch.

### 3.7 Phase 5 sketch (plugin-owned events, gated on Q1)

The precedent is ADR-EA-035's user fields: a static declaration on the plugin class, a type-only `"~userFields"` member, `Auth.UserFieldsOf<P>` folded over the plugin tuple, and a `Context.Reference` registry provided by the composition.

```ts
// AuthPlugin.Service option and class statics (mirrors userFields / "~userFields")
export class Scim extends AuthPlugin.Service<Scim, ScimShape>()("scim", {
  contract: ScimApi, tables: [...], migrations,
  events: [ScimUserProvisioned, ScimUserDeactivated, ScimUserReactivated, ScimUserDeleted, ScimGroupChanged],
}) {}
//   static events: ReadonlyArray<EventDefinition.Defined & Schema.Constraint>
//   readonly "~events"?: Events          // type-only, never assigned

// Auth.ts
type EventsOfPlugin<Plugin> = Plugin extends { readonly "~events"?: infer E extends ReadonlyArray<Schema.Constraint> }
  ? E[number]["Type"] : never;
export type EventsOf<P extends ReadonlyArray<AuthPlugin.Any>> = AuthEvents.AuthEvent | EventsOfPlugin<P[number]>;
//   Built.events: the composed registry (core + plugins); Auth.make refuses a duplicate tag (EventTagConflict)

// core: the registry is a composition-provided reference, defaulting to core's own events
export const EventRegistry = Context.Reference<EventDefinition.Registry>("awthaq/core/EventRegistry",
  { defaultValue: () => CoreRegistry });

// AuthEvents: a plugin publishes its own event through its definition
readonly emit: <D extends EventDefinition.Defined & Schema.Constraint>(definition: D, event: D["Type"]) => Effect.Effect<void>;
// AuthEvents.on accepts a tag (core) or a definition (plugin)
```

`AuditLog.record` encodes through `registry.schemaOf(tag)`. `list`/`replay` decode through the composed registry. A stored row whose tag is in no composed registry (its plugin was removed) decodes to `ForeignEvent { _tag: string; data: Json }` instead of failing. `AuditLogRecord.payload` widens to `AuthEvent | ForeignEvent`, and the relay delivers foreign rows unchanged. ADR-EA-030 Decision 5's "stop loudly" then applies only to a *known* tag that fails to decode.

---

## 4. Phased migration

Every phase gate (README): `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`. Phases 1 and 3 also change code that `layerSql` runs (`scrubRow`), so run `pnpm test:pg`. Plan gate: `pnpm check`.

Freeze rule for the phase-2 window: any event added or changed by another plan while phase 2 is in flight must update **both** the legacy switch and its `defineEvent` call, or it will fail the parity test. Simplest: land phases 1–3 in one sitting (they are mechanical).

### 4.1 Phase 0 — baseline (no code)

1. Create `.scratch/event-definitions/issues/01..12-*.md` from §4.7.
2. Record `pnpm typecheck` wall time and the line count of `packages/core/lib/AuthEventSchemas.d.ts` (2,879 today) as the type-cost baseline (§7, R3).

### 4.2 Phase 1 — the constructor, the readers, the parity harness (no behaviour change)

**Step 1a (ticket 01) — the module.**
- Add `packages/core/src/internal/eventDefinition.ts` exactly as §3.3.
- Add `packages/core/test/EventDefinition.test.ts` with T1 (§5.1): a throwaway `defineEvent("test.x", { userId: UserIdSchema, note: Schema.String }, { actor: Actor.field("userId"), pii: ["note"] })` round-trips through `Schema.decodeUnknownSync`/`encodeSync` unchanged and keeps `["~awthaq/event"]`. Also check that `.annotate({})` drops the property (documents the rebuild behaviour).
- Add `packages/core/test/EventDefinition.types.test.ts` with T2 (§5.1).

**Step 1b (ticket 02) — fix F2 first, as its own commit.**
- `AuditLog.ts`: add `references` and the guarded `scrubRow` (§3.5). For now it still reads `PII_FIELDS`.
- `AuditLog.test.ts`, inside `suite(...)` so both layers run: add "erasing one user leaves another user's impersonation justification intact". Record an impersonation by admin A of target B with reason "billing bug", erase an unrelated C, assert the count is `0` and the reason survives. It fails on `layerMemory` before the fix.
- Gate plus `pnpm test:pg`.

**Step 1c (ticket 03) — the parity harness.**
- Move the switch verbatim from `AuditLog.ts:158-276` to `packages/core/src/internal/legacyEventMeta.ts` as `export const legacyActorOf`. `AuditLog` imports it, so production behaviour is unchanged.
- Add `packages/core/test/EventDefinitionParity.test.ts`:
  - Import `samples` from a new shared fixture `packages/core/test/support/eventSamples.ts`. Move the `samples` object out of `AuditLog.test.ts:71-…` (the mapped type over `AuthEventTag` stays, so it is still compile-enforced). `AuditLog.test.ts` imports it from there (replace, don't copy).
  - For each member of `AuthEvents.AuthEventSchema.members`, read its metadata with `Schema.decodeUnknownOption(EventMetaSchema)(Reflect.get(member, MetaKey))`. This tolerates members that are not yet migrated, with no assertion. For each migrated member: `assert.deepStrictEqual(Option.map(actorValue(meta, sample), UserId), legacyActorOf(sample))` and `assert.deepStrictEqual([...meta.pii], [...(PII_FIELDS[tag] ?? [])])`.
  - A **ratchet**: `const MIGRATED = <n>` with `assert.strictEqual(migratedCount, MIGRATED)`. Each phase-2 batch raises it, so a batch cannot silently skip an event. It starts at 0.
  - Property: `it.prop("the generic reader agrees with the legacy switch for any event", { event: AuthEvents.AuthEventSchema }, ...)`, skipping unmigrated tags. Plus a targeted property for the prefix rule: `{ id: Schema.String }`, with `subjectId` being `user:${id}`, `apikey:${id}`, `${id}` in turn, checked against `legacyActorOf`.
- Gate.

### 4.3 Phase 2 — migrate the 92 definitions in five batches (no behaviour change)

Each batch has one ticket and one commit. Per batch: rewrite each listed `Schema.TaggedStruct("tag", { ... })` in `AuthEventSchemas.ts` as `defineEvent("tag", { ... }, { actor, pii })`, keeping the export name, the `export type` line, the JSDoc and the field order. Raise `MIGRATED` in the parity test. Run the gate. The union is still a plain `Schema.Union([...])`, which accepts migrated and unmigrated members alike.

Notation: `F(x)` = `Actor.field("x")`, `P(x,"user:")` = `Actor.prefixed(...)`, `∅` = `Actor.none`. `pii: []` unless stated.

**Batch A (ticket 04): core-owned and shared, 20 events, `MIGRATED = 20`**
- `F(userId)`: `auth.user.{created, signedIn, emailVerified, emailChanged, deleted, dataExported}`, `auth.session.{reuse, issued, rotated, superseded, revoked, expired}`, `auth.password.{changed, resetRequested, resetCompleted}`, `auth.passkey.counterAnomaly`, `auth.mail.failed` (optional key: absent means none).
- `∅`: `auth.token.replay`, `auth.user.signInFailed`, `auth.rateLimit.exceeded`.

**Batch B (ticket 05): admin and CLI, 17 events, `MIGRATED = 37`**
- `F(adminUserId)`: `auth.admin.{impersonationStarted (pii: ["reason"]), impersonationStopped, impersonationDenied, actionDenied, userUpdated, userBanned, userUnbanned, userDeleted, userEmailChangeRequested, userPasswordSet, sessionRevoked, organizationSuspended, organizationUnsuspended}`. Keep `userBanned`/`organizationSuspended` at `pii: []` here: parity first, behaviour change in phase 4.
- `∅`: `auth.admin.{seeded, seedRefused}`, `auth.import.{completed, failed}` (ECS-006/ECS-002 comment moves here).

**Batch C (ticket 06): federation and integrations, 15 events, `MIGRATED = 52`**
- `∅`: `auth.scim.{userProvisioned, userDeactivated, userReactivated, userDeleted, groupChanged}` (CWM-002 comment), `auth.saml.logoutRejected`.
- `F(adminUserId)`: `auth.webhooks.{endpointCreated, endpointUpdated, secretRotated, endpointDeleted, testQueued}`, `auth.saml.{connectionCreated, connectionUpdated, connectionDeleted, signingKeyRotated}`.

**Batch D (ticket 07): organization, 21 events, `MIGRATED = 73`**
- `F(creatorUserId)`: `auth.organization.created`.
- `F(userId)`: `auth.organization.{memberAdded, memberRemoved, memberRoleUpdated, invitationAccepted, teamMemberAdded, teamMemberRoleUpdated, teamMemberRemoved, permissionDenied}`.
- `∅`: `auth.organization.{updated, deleted, invitationCreated, invitationRejected, invitationCanceled, roleCreated, roleUpdated, roleDeleted, teamCreated, teamUpdated, teamMoved, teamDeleted}`.

**Batch E (ticket 08): authorization, credentials, factors, 19 events, `MIGRATED = 92`**
- `P(subjectId, "user:")`: `auth.authz.denied`.
- `F(actorUserId)`: `auth.user.claimsUpdated`, `auth.roles.assigned`, `auth.roles.revoked` (the "actor is who *changed* the roles" comment moves here).
- `F(userId)`: `auth.apiKey.*` (6), `auth.twoFactor.*` (7), `auth.deviceAuthorization.{approved, denied}`.

Batch E's parity test adds `assert.strictEqual(migratedCount, AuthEvents.AuthEventSchema.members.length)`.

### 4.4 Phase 3 — cut over and delete (ticket 09)

One commit. Order matters only for review.

1. `AuthEventSchemas.ts`: replace `export const AuthEventSchema = Schema.Union([...])` with `const Registry = registry([...same list...])` and export `AuthEventSchema`, `eventTags`, `actorOf`, `piiFieldsOf` (§3.4). **Delete `PII_FIELDS`.** Rewrite the module header's PII paragraph (lines 21-25) and the `AdminImpersonationStartedEvent` JSDoc ("declared PII (`PII_FIELDS`)" becomes "declared personal data (`pii`)").
2. `AuditLog.ts`: `toStoredRow` uses `Option.map(actorOf(published), UserId)`, and `scrubRow` uses `piiFieldsOf(row.eventTag)`. Remove the `legacyActorOf` import, and rewrite the header and the `pseudonymizeActor` JSDoc (line 139) wording.
3. Delete `packages/core/src/internal/legacyEventMeta.ts` and `packages/core/test/EventDefinitionParity.test.ts` (replace, don't layer: the parity proof did its job, and the metadata is now the source of truth).
4. `AuthEvents.ts:23`: header wording.
5. `webhooks/src/WebhookPayload.ts`: `toBody` uses `new Set(AuthEvents.piiFieldsOf(event._tag))`, and `knownEventTags` becomes `export const knownEventTags: ReadonlyArray<string> = AuthEvents.eventTags;`. Keep the export: it is used by `WebhookPayload.unknownPattern` and by the test. Header line 7 wording.
6. `features/step-definitions/EventsSteps.ts:30-43`: `registryTags` becomes `AuthEvents.eventTags`, and `isRegistryTag` becomes a `.some` over `eventTags` with no thrown `Error` (the `typeof literal !== "string"` branch disappears).
7. Tests changed and added: §5.2 and §5.3.
8. Spec and docs: §6.1–6.4. Changeset: §6.5 (C1).
9. Gate, `pnpm test:pg`, then `pnpm check`. Compare against the phase 0 type-cost baseline (R3).

### 4.5 Phase 4 — classify operator free text (ticket 10, blocked on Q2)

If Q2 = yes:

1. `AuthEventSchemas.ts`: `AdminUserBannedEvent` gets `pii: ["reason"]`. The type allows it, since `reason` is `NullOr(String)` and its encoded side accepts `""`. Do the same for `AdminOrganizationSuspendedEvent` if Q2 includes it. Update the JSDoc.
2. Tests: `AuditLog.test.ts` erasure test covers a ban row; `WebhookPayload.test.ts` "drops declared free text" covers `auth.admin.userBanned`; the T3-P6 allowlist loses those entries.
3. Spec: BEH-EA-101 PII paragraph ("the declared free-text fields are the impersonation justification and the ban note…"), BEH-EA-27's BAM-005 paragraph (the note is blanked on erasure and never leaves in a webhook), ADR-EA-029 change history. Changeset C2 (§6.5).
4. Gate and `pnpm check`.

If Q2 = no: delete the two allowlist entries' "pending Q2" comments and record the reason there instead ("operator note about an account, retained under …").

### 4.6 Phase 5 — plugin-owned events (tickets 11–12+, blocked on Q1; recommend **not now**)

Run this only after plans 04 (organization) and 08 (test composition) land, because both touch the same plugin packages and `TestAuth.layer`.

1. Promote `internal/eventDefinition.ts` to `src/EventDefinition.ts` and export it from `index.ts` (`EventDefinition.define`, `EventDefinition.Actor`, `EventDefinition.Defined`, `EventDefinition.Registry`).
2. `AuthPlugin.ts`: add an `events` option and static (default `[]`) plus the type-only `"~events"?: Events` on `Class`, mirroring `userFields`/`"~userFields"` (`AuthPlugin.ts:103-109`). Add `events?` to `Any`.
3. `Auth.ts`: `EventsOf<P>` (§3.7), `Built.events`, and an `EventTagConflict` composition failure modelled on `UserFieldConflict`. Add a manifest listing (`Manifest.events`) so `awthaq` CLI listings show them.
4. Core `EventRegistry` `Context.Reference`, defaulting to the core registry. `auth.layer` provides the composed one (as `userFieldsLayer` does), and `TestAuth.layer` provides it too.
5. `AuthEvents`: `emit(definition, event)`, and `on`/`onBatch` accepting a definition. `publish` keeps its `AuthEvent` signature for core events.
6. `AuditLog`: encode, decode and the actor read go through `EventRegistry`. Add `ForeignEvent` for unknown tags, and widen `AuditLogRecord.payload`. `EventRelay` passes `ForeignEvent` through. `AuditLogDecodeError` now means a known tag that fails to decode.
7. `WebhookPayload.knownEventTags` and `unknownPattern` read the registry service (registration is already effectful). `RedactionGuard.layerEvents` decodes through the registry.
8. Move definitions, one plugin per commit, owner-local file `packages/<plugin>/src/<Plugin>Events.ts`: organization (21), admin (11 single-owner ones), two-factor (7), api-key (6), scim (5), webhooks (5), saml (5), roles (2), device-authorization (2), qadi `auth.user.claimsUpdated` (only if `DecisionSinkAudit`'s `auth.authz.denied` can be declared by a composed plugin; otherwise both stay), and password's 4 (unless plan 01 moved their publication to core). **They stay in core:** the 18 shared or core-referenced events (§2.1), the CLI's 4, and `auth.session.*`.
9. `examples/plugin-template`: declare and publish one event, with the template's test asserting its audit row and actor (the real caller that justifies the phase).
10. Spec: new ADR (next free number; 037 at time of writing, check `spec/decisions/index.yaml`) "Plugins contribute event definitions to the composed registry". Rewrite the BEH-EA-101 REQUIREMENT to "a closed, statically-known set **per composition**: core's events plus every composed plugin's declared events". ADR-EA-030 Decision 5 amendment (foreign rows). ADR-EA-012 cross-reference (event definitions are an aggregating registry). `docs/plugin-authoring.md` "Events" section rewritten. Changeset C3 for every touched package.

### 4.7 Tickets

| # | Ticket | Phase | Blocked by |
|---|---|---|---|
| 01 | `internal/eventDefinition.ts` + T1/T2 | 1a | — |
| 02 | Memory erasure drift fix (F2) + regression test | 1b | — |
| 03 | Move switch to `legacyEventMeta.ts`, shared `eventSamples.ts`, parity test | 1c | 01 |
| 04–08 | Batches A–E | 2 | 03 (and each previous batch, for the ratchet) |
| 09 | Cut over, delete switch and `PII_FIELDS`, webhooks/features readers, spec/docs, changeset C1 | 3 | 08, 02 |
| 10 | Classify operator free text, changeset C2 | 4 | 09, Q2 |
| 11 | Phase 5 design ADR + `EventDefinition` public + `AuthPlugin.events` + `EventRegistry` | 5 | 09, Q1, plans 04 & 08 |
| 12+ | Phase 5 per-plugin moves, `ForeignEvent`, template caller, changeset C3 | 5 | 11 |

---

## 5. Test plan

### 5.1 New tests

- **T1 `packages/core/test/EventDefinition.test.ts` (unit).** `defineEvent` returns a working `TaggedStruct`: decode/encode round-trip, `.fields._tag.schema.literal` equals the tag, `["~awthaq/event"]` is present and equals the declaration, and a rebuild drops it. `actorValue` returns `some("")` for an empty required field (parity), `none` for an absent optional, and for the prefix rule: matching, non-matching and exactly-the-prefix inputs.
- **T2 `packages/core/test/EventDefinition.types.test.ts` (`@ts-expect-error`, checked by `tsc -p tsconfig.test.json`, like `AuthEvents.types.test.ts`):**
  - `registry([Schema.TaggedStruct("x", {})])`, a plain struct, is rejected.
  - `defineEvent("x", { userId: UserIdSchema }, { pii: [] })`, missing `actor`, is rejected. Same for missing `pii`.
  - `Actor.field("strategy")` on a `Schema.String` field is rejected, and so is `Actor.field("nope")`.
  - `Actor.field("userId")` is accepted on `Schema.optionalKey(UserIdSchema)` and on `Schema.optional(UserIdSchema)`.
  - `pii: ["userId"]` (branded), `pii: ["kind"]` (`Schema.Literals`), `pii: ["count"]` (`Schema.Number`) and `pii: ["_tag"]` are rejected. `pii: ["reason"]` on `Schema.NullOr(Schema.String)` is accepted.
  - `AuthEvents.eventTags[number]` is assignable to `AuthEvents.AuthEventTag`.
- **T3 registry properties (in `EventDefinition.test.ts`, over `AuthEvents.AuthEventSchema.members`):**
  - P1: every member carries metadata; `meta.tag === member.fields._tag.schema.literal`; `eventTags` has no duplicates and `eventTags.length === members.length`.
  - P2: every `Field`/`Prefixed` actor names a key of `member.fields`.
  - P3: every `pii` entry is a key of `member.fields`. For an arbitrary event of that member (`it.prop` with `{ event: member }`), blanking all its `pii` fields to `""` still decodes with `Schema.decodeUnknownSync(member)`.
  - P4: `it.prop("the actor is a value the event carries", { event: AuthEventSchema }, ...)`: `actorOf(event)` is `none`, or a string found in `JSON.stringify(event)`.
  - P5: `it.prop` over `AuthEventSchema`: `piiFieldsOf(event._tag)` is a subset of `Object.keys(event)` plus optional keys of its member.
  - P6, the free-text guard: every field whose name matches `/reason|note|justification|description|comment|message|text/i` and whose `Type` is a non-literal string (decide via the schema: not `Schema.Literals`, not branded) is either in that event's `pii` or in a commented `NOT_PERSONAL` allowlist in the test. Today the allowlist holds `auth.authz.denied.reason` (qadi's sentence names attributes, never values) and, pending Q2, `auth.admin.userBanned.reason` and `auth.admin.organizationSuspended.reason`.
- **T4 parity (temporary, phases 1–2, deleted in phase 3): `packages/core/test/EventDefinitionParity.test.ts`**, as specified in §4.2 step 1c.

### 5.2 Changed tests

- `packages/core/test/AuditLog.test.ts`:
  - `samples` moves to `packages/core/test/support/eventSamples.ts` (phase 1c) and is imported.
  - New in `suite(...)` (both layers), phase 1b: unrelated erasure leaves another row's justification intact (F2).
  - New in `suite(...)`, phase 3: a table-driven actor-column test, one sample per actor rule (`F(userId)`, `F(adminUserId)`, optional present and absent (`auth.mail.failed`, `auth.roles.assigned`), prefixed `user:` and non-`user:` (`auth.authz.denied`), `F(creatorUserId)`, `∅`), asserting `list()`'s `actorUserId`. This is the lasting, interface-level replacement for the parity test. The existing "records every published AuthEvent, actorless events included", "records an organization permission denial with its actor" and "records the CLI's admin-seed and import events with no actor" are folded into it and deleted.
  - Phase 4 (Q2 = yes): the existing `pseudonymizeActor` test also records a ban row naming the user and asserts the note is gone.
- `packages/webhooks/test/WebhookPayload.test.ts`:
  - Line 54's test renamed from "(PII_FIELDS)" to "(the event's declared `pii`)". Phase 4 adds the ban case.
  - Lines 125-137 ("knows every tag the library publishes") stay valid. Add `assert.deepStrictEqual(WebhookPayload.knownEventTags, AuthEvents.eventTags)`.
- `features/step-definitions/EventsSteps.ts`: reader swap (§4.4 step 6). Add one scenario to `features/features/04-cross-cutting/13-events.feature` under `@BEH-EA-101`: "Every registered event declares who acted and which of its fields are personal data". Its Then iterates `AuthEvents.eventTags` and asserts `actorOf` of each feature-world sample is consistent with the declared rule, failing if a tag is missing. It is mapped through the existing REQ-EA-268 row (no new REQ id).

### 5.3 Deleted tests

- `packages/core/test/EventDefinitionParity.test.ts` (phase 3).
- The three actor assertions folded into the table-driven test (§5.2).

### 5.4 Redaction and pseudonymisation coverage (unchanged, re-run)

- `RedactionGuard` (`packages/test`) does not read `PII_FIELDS`; its event channel inspects `payloadOf(event)`. No change. `pnpm test` covers `runPluginContractTests`' `redaction` option for plugins that opt in.
- `packages/core/test/AccountErasure.test.ts` (ADR-EA-031 cascade, `auditLog: "pseudonymize" | "retain"`) and `AccountExport.test.ts` (activity = rows where the person is the actor) must pass unchanged. They are the end-to-end evidence that parity held.
- `features/features/15-webhooks/34-webhooks.feature` line 187 (impersonation justification never delivered) must pass unchanged.

---

## 6. Spec, ADR, traceability, docs, changesets

### 6.1 Behaviours

- `spec/behaviors/13-events.md`: Document Control to **1.2** with the date of execution. Change history: "1.2: each event declares its actor and personal-data fields with its schema (`defineEvent`); `PII_FIELDS` replaced by `AuthEvents.piiFieldsOf`; `AuthEvents.eventTags`/`actorOf` (plan 09)". BEH-EA-101:
  - "The registry is schema-first and versioned" paragraph: add that every event is declared with `defineEvent(tag, fields, { actor, pii })`, that the compiler refuses a registry member without that declaration, and that `AuditLog`'s actor column and erasure read it.
  - "PII posture" paragraph: "declared in `PII_FIELDS`" becomes "declared in the event's `pii` (read with `AuthEvents.piiFieldsOf`)". Add a sentence: a declared field must be blankable (its encoded side accepts `""`).
  - Add an *Implementation* note: "Adding an event is one `defineEvent` call in `AuthEventSchemas.ts` plus its entry in the registry list."
- `spec/behaviors/34-webhooks.md` BEH-EA-277 REQUIREMENT: "(the fields declared in `PII_FIELDS`, BEH-EA-100)" becomes "(the fields each event declares as personal data, BEH-EA-101)". Revision **1.2** with change history.
- Phase 4 only: `spec/behaviors/27-admin-impersonation.md` BAM-005 paragraph (the ban note is personal data: blanked on erasure, not delivered to webhooks), revision bump.
- Phase 5 only: BEH-EA-101 REQUIREMENT rewording (§4.6 step 10).

### 6.2 ADRs

- `spec/decisions/029-event-pii-posture.md` to **1.1**. Decision 2 becomes: "**Fields that can still hold personal data are declared with the event, not discovered.** Each event's definition names them (`defineEvent(..., { pii })`); the type system refuses a name the event does not carry or a field erasure could not blank; `AuditLog.pseudonymizeActor` blanks exactly those, on the rows that name the erased user…" The rest is unchanged. Phase 4 adds the ban note to the narrative.
- No new ADR for phases 1–4. This is a change of mechanism inside ADR-EA-029 Decision 2, not a new decision. Phase 5 needs one (§4.6).
- `spec/decisions/index.yaml`: bump 029's revision if the index records it.

### 6.3 Traceability

- `spec/traceability.md:177` (ADR-EA-029 row): add `packages/core/test/EventDefinition.test.ts`, `packages/core/test/EventDefinition.types.test.ts`.
- `spec/traceability.md` §5 test list: add rows for those two files ("BEH-EA-101: every registry member declares its actor and personal-data fields; the readers' contract; the free-text guard", and "BEH-EA-101: compile-time refusal of an undeclared or mis-declared event").
- `features/traceability.md`: no new row (the scenario sits under REQ-EA-268's feature file).
- Run `pnpm spec:verify:strict`.

### 6.4 `docs/plugin-authoring.md`

Add a section **"## Events"** between "Personal data: erasure and export" and "Migrations".

Phases 1–4 text:

> Events are identifiers-only (ADR-EA-029) and declared in `@awthaq/core`'s `AuthEventSchemas.ts` with `defineEvent(tag, fields, { actor, pii })`. Name the tag `auth.<plugin>.<pastTense>`. Brand user ids with the module's `UserIdSchema`. Choose the actor: `Actor.field("<userId field>")` for the user who *did* it (an administrator, not the target), `Actor.none` when no user acted (a directory, the CLI, an anonymous attempt), or `Actor.prefixed`. List every free-text field about a person in `pii` (never an email; carry an id and let subscribers join). Add the event to the registry list, add a sample to `test/support/eventSamples.ts` (the compiler asks for it), and publish with `AuthEvents.publish`. Until plugins own their events (plan 09 phase 5), a third-party plugin cannot add a tag: reuse an existing one, or contribute the definition to core.

Add checklist item 8: "Every event declared with `defineEvent`, its actor chosen and its free-text fields in `pii`."

Phase 5 rewrites the section around the `events:` option and `EventDefinition.define`, using `examples/plugin-template` as the worked example.

### 6.5 Changesets

- **C1 (phase 3)** `.changeset/event-definitions.md`:
  ```md
  ---
  "@awthaq/core": minor
  "@awthaq/webhooks": patch
  ---
  An event's actor and personal-data fields are declared with its schema (`defineEvent(tag, fields, { actor, pii })` inside core), and the audit trail reads them from there instead of a 92-case switch and a separate `PII_FIELDS` table. New: `AuthEvents.eventTags` (every publishable tag), `AuthEvents.actorOf(event)` (who acted, as the audit row records it), `AuthEvents.piiFieldsOf(tag)`. Fixed: the in-memory `AuditLog`'s erasure no longer blanks free text on rows that do not name the erased user. No change to any stored or delivered payload.

  Migration: `AuthEvents.PII_FIELDS` is removed; replace `AuthEvents.PII_FIELDS[tag] ?? []` with `AuthEvents.piiFieldsOf(tag)`. ADR-EA-029 (rev 1.1), BEH-EA-101, BEH-EA-277.
  ```
- **C2 (phase 4, Q2 = yes)**: `"@awthaq/core": minor`, `"@awthaq/webhooks": minor`. "The ban note (and the organization suspension note) is personal data: blanked when the person is erased and no longer sent in webhook `data`." `Migration:` "a webhook receiver that read `data.reason` on `auth.admin.userBanned` must read the note through the admin API instead." ADR-EA-029, BEH-EA-277, BAM-005.
- **C3 (phase 5)**: every touched package, `minor`, with a `Migration:` covering `AuditLogRecord.payload` widening to `AuthEvent | ForeignEvent`, plugin event definitions moving packages (re-exports from `@awthaq/core` removed), and `AuthEvents.emit`.

---

## 7. Risks, mitigations, rollback

| # | Risk | Likelihood | Mitigation | Rollback |
|---|---|---|---|---|
| R1 | Wire-format drift: a `defineEvent` rewrite changes a field (order, optionality, a dropped JSDoc'd field) | low | Phase-2 diffs are mechanical, so review field-by-field. `AuditLog.test`'s "round-trips every AuthEvent variant" (both layers) and the `samples` mapped type catch shape changes. The parity test catches actor/PII changes. | revert the batch commit |
| R2 | Actor column differs for some event, so `DataExport` activity and `list({ actorUserId })` change silently | low | Parity test over fixtures and a schema-derived property, across all 92, with a ratchet. `AccountExport.test.ts` unchanged. | revert phase 3 (code only; no stored data was rewritten) |
| R3 | Type-check cost: 92 calls each computing three mapped key types; `AuthEventSchemas.d.ts` grows | medium | Measure against the phase 0 baseline. If `pnpm typecheck` slows by more than 10%, precompute the key types once per call (move `UserIdKey`/`FreeTextKey` behind a single `Keys<F>` object type) before shipping | n/a |
| R4 | An Effect RC freezes schema objects, or `TaggedStruct` stops being an extensible object, so `Object.assign` throws at import | low | T1 fails at test time on the `effect` bump PR. The documented fallback keeps the same interface: `defineEvent` returns `{ schema, meta }`, and `registry` is called with an explicitly written tuple of schemas plus a `WeakMap` side table. The compile-time proof then moves to a mapped-type check over `AuthEventTag`. | pin `effect` |
| R5 | Relay/webhook consumers depend on `reason` in `auth.admin.userBanned` | only phase 4 | Gated on Q2, minor changeset with `Migration:`, BEH-EA-277 text | revert phase 4; already-erased rows stay blanked (the intended effect) |
| R6 | Concurrent plans add or alter events during phase 2 | medium (Wave A runs beside 03, 06, 10) | Freeze rule (§4); land phases 1–3 together; 03's `deletedBy: "directory"` is a schema edit that parity does not see (actor unchanged) | — |
| R7 | Phase 5: a removed plugin's history becomes undecodable, stopping the relay and `AuditLog.list` | high if phase 5 ships without `ForeignEvent` | `ForeignEvent` is part of phase 5's first ticket, not a follow-up. A test composes a plugin, records, recomposes without it, then `list`/`replay`/relay succeed. | phase 5 is per-plugin commits; revert the moves |
| R8 | Phase 5: the `Published` stream's element type widens, so existing `stream` consumers lose narrowing | medium | Core `on(tag)` keeps `AuthEventTag` narrowing; plugin events are reached through `on(definition)`. A type test pins both. | — |

Rollback overall: phases 1–2 are additive (the old switch stays the production path). Phase 3 is one commit with no data migration. Reverting it restores `PII_FIELDS` and the switch, and every stored row stays valid because nothing about storage changed.

---

## 8. Interactions with other plans

- **03 (erasure is the only way to delete a User).**
  - 03 adds `deletedBy: "directory"` to `auth.user.deleted` (SCIM erase through the ADR-EA-031 cascade). After this plan, that is one edit to the `defineEvent` call's `Schema.Literals([...])`: actor stays `F(userId)`, `pii: []`. The `eventSamples.ts` sample may add a directory variant.
  - If 03 lands first, nothing here changes except the batch A fixture.
  - 03 also routes erasure through one cascade that ends in `AuditLog.pseudonymizeActor`. The F2 fix (ticket 02) makes the memory layer's result match SQL, which 03's tests would otherwise see as a double count.
- **01 (sign-in completion and sign-up in core).**
  - 01 centralises the publication of `auth.user.created`, `auth.user.signedIn` and `auth.user.signInFailed`, and may add fields (for example `amr`/assurance on `signedIn`) or a new event (for example a sign-up outcome).
  - Order: 09 is Wave A, 01 is Wave B, so 01 writes `defineEvent` from the start. If 01 starts during phase 2, it obeys the freeze rule.
  - If 01 moves password's four single-owner events' publication into core, they leave phase 5's move list.
- **05 (plugin table substrate).**
  - 05 rewrites `@awthaq/webhooks`' records and SQL, including the delivery log keyed by `subjectUserId`.
  - This plan touches only `WebhookPayload.toBody`/`knownEventTags` (two lines); rebase whichever lands second.
  - F4 (`subjectUserId` misses `creatorUserId`/`actorUserId`/`subjectId` and records the target, not the administrator) is 05's to fix or Q5's to answer. If Q5 chooses declared subjects, the declaration goes into `defineEvent` here as a third required field, after both plans land.
- **02 (one domain implementation over a store seam).** If 02 turns `AuditLog` into one implementation over a store seam, `scrubRow`/`references` move into the shared domain layer as they are. The F2 fix is exactly the memory/SQL drift class 02 targets, so 02's drift tests should include ticket 02's case.
- **04 (organization system modules).** It does not touch definitions. If 04 adds events (for example SCIM team events with a directory actor), it uses `defineEvent` with `Actor.none`. Phase 5 must follow 04 (same package).
- **08 (test composition).** Phase 5's `EventRegistry` must be provided by `TestAuth.layer`. Do phase 5 after 08 so it changes one composition.
- **10 (standalone fixes: "events from a rolled-back transaction").** That changes *when* `publish` runs, not what an event declares. No conflict.

---

## 9. Acceptance checklist

- [ ] `packages/core/src/internal/eventDefinition.ts` exists; no `as` (`grep -nE '\bas\b' packages/core/src/internal/eventDefinition.ts` finds only comments), and no return type annotation on any `Effect`/`Layer` const.
- [ ] All 92 events in `AuthEventSchemas.ts` are `defineEvent(...)` calls. `grep -c 'Schema.TaggedStruct("auth\.' packages/core/src/AuthEventSchemas.ts` gives `0`.
- [ ] `AuthEventSchema` is built by `registry([...])`; adding a plain `Schema.TaggedStruct` to the list fails `pnpm typecheck` (T2).
- [ ] `actorOf` switch and `PII_FIELDS` are deleted. `grep -rn "PII_FIELDS\|legacyActorOf" packages features spec docs --include='*.ts' --include='*.md'` finds only changeset/history text.
- [ ] The parity test passed at `MIGRATED = 92` on the commit before phase 3 (record the commit hash in ticket 09).
- [ ] F2 regression test passes on both `layerMemory` and `layerSql`; `pnpm test:pg` is green.
- [ ] `WebhookPayload` reads `piiFieldsOf`/`eventTags`; `EventsSteps.ts` reads `eventTags`; no code reads `members[].fields._tag.ast.literal` any more.
- [ ] T1, T2, T3 (P1–P6) are in place; the new `@BEH-EA-101` scenario passes (`pnpm test:bdd`).
- [ ] `spec/behaviors/13-events.md` 1.2, `34-webhooks.md` 1.2, ADR-EA-029 1.1, `spec/traceability.md` rows, `docs/plugin-authoring.md` "Events" section and checklist item are done; `pnpm spec:verify:strict` is green.
- [ ] Changeset C1 is present with a `Migration:` section.
- [ ] `pnpm typecheck` time is within 10% of the phase 0 baseline (or R3 mitigation applied).
- [ ] `pnpm check` is green.
- [ ] (Phase 4, if Q2 = yes) ban note (and suspension note) in `pii`; erasure and webhook tests cover it; C2 present.
- [ ] (Phase 5, if Q1 = yes) separate acceptance in its ADR: `ForeignEvent` test, template caller, no plugin-owned definition left in core except the §4.6 step 8 "stay" list.

---

## 10. Open questions (only the user can answer)

- **Q1 — Plugin-owned events (phase 5): go, later, or never?** It restores locality (74 of 92 definitions belong to one plugin) and lets a third-party plugin add a tag at all. The cost: it turns BEH-EA-101's "closed, statically-known set" into "closed per composition", it needs `ForeignEvent` so a removed plugin's history still decodes, and it widens `AuditLogRecord.payload` and the `stream` element type. The real caller today is the plugin template plus first-party plugins. No external plugin exists yet. Recommendation: later, after 04 and 08.
- **Q2 — Is `auth.admin.userBanned.reason` personal data?** (BAM-005 says it is an operator note never shown to the banned user, yet it reaches the audit trail verbatim after erasure and is sent to webhook receivers.) Is `auth.admin.organizationSuspended.reason` too? Recommendation: yes for the ban note. For the suspension note, also yes, since operators write free text and the blanking only touches rows naming the erased user.
- **Q3 — Also mirror the metadata into `Schema` annotations?** Only worth it if you want a JSON-Schema/OpenAPI catalog of events for webhook receivers that shows `x-awthaq-actor`/`x-awthaq-pii`. There is no caller today, so the plan does not do it.
- **Q4 — Should `EventRelay` scrub declared `pii` before handing events to a custom `EventTransport`?** (F5: ADR-EA-030 Decision 6 says identifiers only, but the impersonation justification crosses today; only the webhooks transport drops it.) A `piiFieldsOf`-based scrub would be on by default with an opt-out for a trusted internal SIEM. That is a behaviour change, so it would be its own ticket.
- **Q5 — Declare an event's *subjects* (every user it is about) as well?** This would replace webhooks' `subjectUserId` heuristic (F4) and could feed `DataExport` "events about me", not just "events I did". It would be a third required field in `defineEvent`. Decide together with plan 05.
- **Q6 — Should `AuthEvents.actorOf` be public?** It comes for free through `export *` and helps relay/SIEM consumers, who get `Published` events without the audit row's actor column. The alternative is to keep it internal and have `AuditLog` call the registry directly.
