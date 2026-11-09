# ADR-EA-049: Plugins Own Their Event Definitions; a Composition's Event Set Is Core's Plus Every Composed Plugin's

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-049 |
> | Revision | 1.1 |
> | Effective Date | 2026-11-09 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-11-09): Initial release, Proposed (architecture plan 29 ticket 03; plan 09 phase 5) <br> 1.1 (2026-11-09): Accepted — implemented; the implementation notes (architecture plan 29 tickets 04–25) |

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

## Implementation

`packages/core/src/EventDefinition.ts` (public: `define`, `make`, `problems`, `Actor`, `UserId`/`SessionId`,
`ForeignEventTag`); `AuthPlugin.Service`'s `events` and `Auth.make`'s `composeEvents` (`Built.events`,
`Built.eventsLayer`, `manifest.events`, `Auth/EventTagConflict`); `AuthEvents.emit`, `is`, `typed` and
`UndeclaredEventPolicy` (`"warn"`, `"die"` under `TestAuth`); `AuditLog`'s `meta.pii`, `ForeignEvent`, `payloadAs`,
`toPublished` and the frozen `PRE_ADR_049_PII`. Core defines 24 events; 73 moved, verbatim, to eleven
`<Plugin>Events.ts` modules (device-authorization, roles, qadi's `UserClaims`, password, api-key, two-factor, scim, saml,
webhooks, admin, organization). As built:

- `AnyEvent` and `ForeignEventTag` are defined in `EventDefinition` (the leaf), so `problems` can refuse the reserved
  tag without a cycle; `ForeignEvent` is `AuthEvents.ForeignEvent`.
- `AuthEvents` reads `EventRegistry` and `UndeclaredEventPolicy` once, when its layer is built; `AuthHost.layer` provides
  `eventsLayer` beneath it (ADR-EA-044), so `TestAuth` and every `AuthHost` composition get it without a host line.
- `@awthaq/admin` declares two lists: `AdminEvents.events` on `Admin` and `AdminEvents.accountsEvents` on
  `AdminAccounts`, which is composable without `Admin`. `auth.admin.organization{Suspended, Unsuspended}` are published
  by `OrganizationDirectory`, so `OrganizationEvents` defines them.
- `runPluginContractTests` checks every declared event (`problems`, plus a sampled blank-pii-still-decodes and
  actor-is-carried case).

Tests: `packages/core/test/EventDefinition.test.ts`, `EventDefinition.plugin.types.test.ts`, `EventComposition.test.ts`,
`AuditLog.test.ts`, `AuthEvents.test.ts`, `AuthEventsUnitOfWork.test.ts`; `examples/plugin-template/test/Template.test.ts`;
`features/features/04-cross-cutting/13-events.feature` (REQ-EA-1510..1512) and
`00-foundations/02-plugin-composition-validate.feature` (REQ-EA-1513, BEH-EA-346).

_Related: [ADR-EA-012](012-slots-exclusive-registries-aggregate.md), [ADR-EA-029](029-event-pii-posture.md),
[ADR-EA-030](030-event-delivery-outbox-relay.md), [ADR-EA-034](034-versioning-and-deprecation-policy.md),
[ADR-EA-035](035-user-field-extension-point.md), [ADR-EA-037](037-unit-of-work-releases-events-on-commit.md),
[BEH-EA-101](../behaviors/13-events.md)._
