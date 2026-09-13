// @awthaq/api — Subject
//
// spec/behaviors/04-contract-stratum.md, BEH-EA-026: `SubjectDto` here is
// exactly that behavior's own illustrated shape (`{id, roles, permissions,
// attributes}`, roles/permissions flattened to arrays) — but BEH-EA-026's
// other half, a single combined `SessionView = {principal, user, session,
// subject}` returned by `GET /auth/session` itself, is *not* what this
// pass builds: core's `session`/`current` handler (`@awthaq/server`)
// cannot reach qadi's `SubjectResolver` at all (qadi is a stratum above
// server — see this package's own `SubjectApi`, and `@awthaq/qadi`'s
// `SubjectApi.ts`, for the layering reasoning), so there is no single
// handler that could assemble one combined struct. `subject` is instead its
// own standalone contract/atom, composed client-side
// (`@awthaq/react`'s `Providers.tsx`) with the session atom rather
// than merged server-side into one response — the same two pieces of
// information BEH-EA-026 asks for, delivered as two atoms instead of one
// struct.
//
// The client-facing "whoami" contract — a standalone `HttpApi` (like
// `AuthCore.AuthCoreApi`/`Session.ts`'s `SessionGroup`) describing an
// already-resolved authorization subject's wire shape.
//
// Declared here, not in `@awthaq/qadi`, specifically so
// `@awthaq/react` (a browser package) can build a reactive client
// against it without depending on `@awthaq/qadi` itself — which
// transitively depends on `@awthaq/server`/`sql`/`core` (Node-only SQL
// drivers among them) and would be a serious, silent bundle-size/
// installability regression for a frontend-only consumer of
// `@awthaq/react`.
//
// This file declares the group *without* the qadi-owned `AuthorizedSubject`
// middleware attached — this stratum cannot import anything qadi-specific
// (`@awthaq/api` sits below `@awthaq/qadi`). `@awthaq/qadi`'s
// own `SubjectApi.ts` attaches that middleware to this same base group and
// builds the real, served `HttpApi` from it — the two representations
// describe the identical wire endpoint (same path, same response schema),
// just typed slightly differently: this file's client-safe view has no
// static knowledge `AuthorizedSubject` exists, which costs nothing in
// practice, since that middleware never actually fails (`SubjectResolver`'s
// own contract is `Effect.Effect<AuthSubject>` — no error channel at all).
import * as Schema from "effect/Schema";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

/** The wire shape of `@qadi/core`'s `AuthSubject` — every field already public per-request data. */
export class SubjectDto extends Schema.Class<SubjectDto>("SubjectDto")({
  id: Schema.String,
  roles: Schema.Array(Schema.String),
  permissions: Schema.Array(Schema.String),
  attributes: Schema.Record(Schema.String, Schema.Unknown),
}) {}

export const SubjectGroup = HttpApiGroup.make("subject").add(
  HttpApiEndpoint.get("current", "/subject", { success: SubjectDto }),
);

export const SubjectApi = HttpApi.make("auth-subject").add(SubjectGroup);
