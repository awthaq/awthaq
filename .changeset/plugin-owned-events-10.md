---
"@awthaq/core": patch
---

`EventDefinition.problems` no longer treats a field whose name ends in `Id` or `Ids` (`noteId`) as free text, so an identifier named after a note, message or comment needs no `notPersonal` entry. The plugin template publishes its own `auth.notes.created` event (`NotesEvents`), the worked example of ADR-EA-049, and `docs/plugin-authoring.md` "Events" describes defining, declaring, emitting and reading a plugin's events.

Migration: none required. ADR-EA-049.
