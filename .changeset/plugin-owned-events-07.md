---
"@awthaq/core": minor
"@awthaq/server": minor
"@awthaq/test": minor
"@awthaq/cli": minor
---

Plugins declare the events they publish, and `Auth.make` composes them (ADR-EA-049). `AuthPlugin.Service(id, { events })` takes the plugin's event definitions (each made with `EventDefinition.define`), read statically like `userFields`. `Auth.make` composes core's definitions with every composed plugin's into `auth.events` (an `EventDefinition.Registry` typed by the tuple: `Auth.EventsOf<P>`), lists them in `manifest.events` (tag, owner, actor, personal-data fields, attempt), provides them through `auth.eventsLayer` (`AuthEvents.EventRegistry`), and refuses a tag declared twice, core's included, or the reserved `"awthaq.foreignEvent"`, with `Auth/EventTagConflict` naming both owners. `AuthEvents.typed(auth.events)` gives the composition-typed `is`, `subscribe` and `on(tag, handler)`. `AuthHost.layer` provides `auth.eventsLayer` (so `TestAuth.layer` does), and `TestAuth.layer` sets `AuthEvents.UndeclaredEventPolicy` to `"die"`. `awthaq plugin list --events` prints `manifest.events` (text or JSON); config loading and `awthaq doctor` report `Auth/EventTagConflict`, `UndeclaredTableDependency`, `Auth/TenancyDeclarationInvalid`, `Auth/SealedColumnDeclarationInvalid`, `Auth/MigrationDeclarationInvalid` and `UserFieldConflict` as link problems with their code instead of a generic load failure.

Migration: a host that composes without `AuthHost.layer` and serves webhooks, configures Retention rules for plugin tags, or relies on the undeclared-event check provides `auth.eventsLayer` last, like `auth.userFieldsLayer`. A hand-written `Auth.Manifest` gains `events`. ADR-EA-049, BEH-EA-101, BEH-EA-016.
