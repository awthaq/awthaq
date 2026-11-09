---
"@awthaq/core": minor
---

New public `EventDefinition` module (ADR-EA-049, plan 09's `internal/eventDefinition.ts` promoted): `define(tag, fields, { actor, pii, attempt? })` (was the internal `defineEvent`), `Actor`, `make(definitions, origin)` (a registry with `tags`, `isTag`, `definitionOf`, `actorOf`, `piiFieldsOf`, `isAttempt` and a validating `is`), `problems(definitions, { notPersonal })` (the well-formedness check: declared tag, actor and `pii` fields, undeclared free text, tag naming, the reserved foreign-event tag, duplicates), the types `Any`, `TypeOf`, `Input`, `Registry`, `AnyEvent`, and `UserId`/`SessionId`. `AuthEvents` gains `CoreRegistry`, `coreDefinitions`, `AnyEvent`, `PublishedAny`, `EventRegistry` (a `Context.Reference`, core's registry by default) and `eventRegistryLayer`; `Published<E>` accepts any tagged event. Every event is still core's.

Migration: none required (additive). ADR-EA-049, BEH-EA-101.
