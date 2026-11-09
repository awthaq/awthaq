// plugin-template — NotesEvents: the events this plugin publishes (ADR-EA-049).
//
// A plugin owns its events: each is defined here, in the plugin's own package, with
// `EventDefinition.define(tag, fields, { actor, pii })`, listed in the class's `events`, and published with
// `events.emit(definition, input)`. Core composes every composed plugin's list (`Auth.make`), refuses a tag
// declared twice, records each event in the audit log with its actor and declared personal data, and
// `runPluginContractTests` checks each definition. This module imports nothing of the plugin, so any of the
// plugin's modules can publish through it without a cycle.
import { EventDefinition } from "@awthaq/core";
import * as Schema from "effect/Schema";

/**
 * Published once a note is stored. Identifiers only (ADR-EA-029): the note's text is not on the event, so a
 * subscriber that needs it reads the note through the plugin. The caller who created it is the actor.
 */
export const NoteCreatedEvent = EventDefinition.define(
  "auth.notes.created",
  { userId: EventDefinition.UserId, noteId: Schema.String },
  { actor: EventDefinition.Actor.field("userId"), pii: [] },
);
export type NoteCreatedEvent = typeof NoteCreatedEvent.Type;

/** Every event this plugin publishes; the plugin class declares it as `events`. */
export const events = [NoteCreatedEvent];
