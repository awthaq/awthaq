---
"@awthaq/core": minor
"@awthaq/test": minor
---

`AuthEvents.emit(definition, input)` publishes any declared event through its definition (ADR-EA-049): `_tag` is filled in, brands are enforced, and the event gets the same envelope, audit row (actor column, declared personal data recorded with the row) and ADR-EA-037 lane (from the definition's `attempt`) as `publish`, which keeps core's events. The bus carries every event of the composition: `stream` and `subscribe` yield `AuthEvents.PublishedAny`, narrowed by the new validating guard `AuthEvents.is(tag | definition | [...])` (a definition matches only when its schema accepts the event). `on` and `onBatch` take core tags and/or definitions, mixed, with the handler typed exactly. `AuthEvents.UndeclaredEventPolicy` (`"warn"` by default: logged as `auth.event.undeclared` and counted by `awthaq_event_undeclared_total`; `"die"`: `AuthEvents/UndeclaredEvent`) decides what `emit` does with a definition a composed registry does not declare. `@awthaq/test`'s `RedactionGuard.layerEvents` inspects every published event, a plugin's included.

Migration: `AuthEvents.stream`/`subscribe` yield `PublishedAny`; narrow before reading fields: `Stream.filter(AuthEvents.is("auth.session.issued"))` in place of `Stream.filter((e) => e._tag === "auth.session.issued")`, or `AuthEvents.is(AuthEvents.eventTags)` for every core event. A hand-written `AuthEventsShape` gains `emit`. ADR-EA-049, BEH-EA-102, BEH-EA-103.
