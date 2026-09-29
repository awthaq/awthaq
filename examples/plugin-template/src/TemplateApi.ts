// plugin-template — TemplateApi
//
// The plugin's public contract: one `HttpApiGroup` whose id is the plugin id
// ("notes"), wrapped in an `HttpApi` named "auth" (every plugin does the same, so
// `Auth.make` can merge them). Anything a client should be able to match on is a
// `Schema.TaggedError` with an `httpApiStatus`.

import { Api } from "@awthaq/api";
import { HookPoint } from "@awthaq/core";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

/** A domain refusal the caller can act on: typed, with its own status. */
export class NoteTooLong extends Schema.TaggedError<NoteTooLong>()(
  "NoteTooLong",
  {},
  { httpApiStatus: 422 },
) {}

export const CreateNotePayload = Schema.Struct({ text: Schema.String });
export type CreateNotePayload = typeof CreateNotePayload.Type;

/** Wire shape: plain strings for dates, never a domain object. */
export class NoteDto extends Schema.Class<NoteDto>("NoteDto")({
  id: Schema.String,
  text: Schema.String,
  createdAt: Schema.String,
}) {}

export const NotesGroup = HttpApiGroup.make("notes")
  .add(
    HttpApiEndpoint.post("create", "/notes", {
      payload: CreateNotePayload,
      success: NoteDto,
      // A veto hook can abort the operation, so the endpoint must declare it.
      error: [NoteTooLong, HookPoint.HookAborted],
    }),
  )
  .add(HttpApiEndpoint.get("list", "/notes", { success: Schema.Array(NoteDto) }))
  // Middleware order: the last one declared runs first, so CSRF is checked
  // before any credential work.
  .middleware(Api.Authentication)
  .middleware(Api.CsrfProtection);

export const NotesApi = HttpApi.make("auth").add(NotesGroup);
