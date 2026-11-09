---
"@awthaq/test": minor
---

`runPluginContractTests` checks every event a plugin declares (ADR-EA-049), always: `EventDefinition.problems` (the declared tag is the schema's, actor and personal-data fields are the event's, a free-text-looking field is declared `pii` or listed as not personal, the tag is `auth.<namespace>.<event>`, not reserved, not repeated), and a sampled check that blanking the declared personal-data fields still decodes and that the actor is a value the event carries. New option `events: { notPersonal: ["<tag>.<field>"] }` for a free-text-looking field that holds no personal data.

Migration: none required (a plugin that declares no events passes vacuously). ADR-EA-049, BEH-EA-198.
