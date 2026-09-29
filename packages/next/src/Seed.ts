// @awthaq/next — Seed
//
// spec/behaviors/24-nextjs-ssr.md, BEH-EA-185; spec/behaviors/23-react.md,
// BEH-EA-177/179. RSC-005/NF-11-4: the server -> client seam.
//
// `getSession`'s `Session` is a server-only shape (`SessionView` carries
// `DateTime.Utc`/`Option`/branded ids, `UserRecord` carries internal fields),
// and `@awthaq/react`'s `SessionDto`/`SubjectDto` are `Schema.Class` instances
// — neither can be a Client Component prop, which React serializes: class
// instances are rejected. These helpers produce the *encoded* plain-JSON
// shape `Providers` accepts as `initialSession`/`initialSubject` (and decodes
// and validates on the client).
//
// Deliberately structural about the subject: resolving one is the
// application's own `SubjectResolver.resolve(session.principal)` (qadi), and
// this package stays off `@awthaq/qadi`/`@qadi/core` (see `GetSession.ts`).
import { SessionContract, SubjectContract } from "@awthaq/api";
import { Session as ServerSession } from "@awthaq/server";
import * as Schema from "effect/Schema";
import type { Session } from "./GetSession.ts";

/**
 * `getSession`'s result as `Providers`' `initialSession` prop: the encoded
 * `SessionDto` (a plain object of strings, JSON round-trippable), or
 * `undefined` for no session. The server-resolved session `expiresAt` is the
 * absolute expiry, as on the wire everywhere else.
 */
export const toInitialSession = (session: Session | undefined) =>
  session === undefined
    ? undefined
    : Schema.encodeSync(SessionContract.SessionDto)(ServerSession.toSessionDto(session.session));

/** Anything shaped like a resolved authorization subject — `@qadi/core`'s `AuthSubject` satisfies it. */
export interface SubjectLike {
  readonly id: string;
  readonly roles: Iterable<string>;
  readonly permissions: Iterable<string>;
  /** Must itself be JSON-serializable to cross the RSC boundary. */
  readonly attributes: Readonly<Record<string, unknown>>;
}

/**
 * A resolved subject as `Providers`' `initialSubject` prop: the encoded
 * `SubjectDto` (roles/permissions flattened to arrays). Pass the subject your
 * own `SubjectResolver` resolved for `session.principal`.
 */
export const toInitialSubject = (subject: SubjectLike | undefined) =>
  subject === undefined
    ? undefined
    : Schema.encodeSync(SubjectContract.SubjectDto)(
        new SubjectContract.SubjectDto({
          id: subject.id,
          roles: Array.from(subject.roles),
          permissions: Array.from(subject.permissions),
          attributes: { ...subject.attributes },
        }),
      );
