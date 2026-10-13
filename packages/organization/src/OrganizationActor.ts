// @awthaq/organization — OrganizationActor
//
// Who performs a system operation, for audit and for hook taps. Never an authorization input:
// the authorized layer has already decided, a system interface only records who acted. The one
// exception is a type, not a check: `suspend` and `reinstate` take a `PlatformAdminActor`, which
// restricts who can construct the call, not what the call may do (ADR-EA-040, plan 04 §3.2).
//
// `Bound` is the grant ceiling of a role-conferring operation (RRM-001, OHS-004, BEH-EA-288/316):
// `Ceiling` carries the statements the source holds; `Unbounded` is the deliberate, greppable
// choice of a trusted source (the application, a directory's configured role).

import type { Api } from "@awthaq/api";
import { Users } from "@awthaq/core";
import * as Data from "effect/Data";
import * as Schema from "effect/Schema";
import type * as PermissionEngine from "./PermissionEngine.ts";

export const ActorSchema = Schema.TaggedUnion({
  /** A signed-in member acting through the authorized interface. */
  User: { userId: Schema.String, sessionId: Schema.optional(Schema.String) },
  /** A directory (`@awthaq/scim`) provisioning through its connection. */
  Directory: { connectionId: Schema.String },
  /** An identity provider (`@awthaq/saml`) mapping roles at sign-in. */
  IdentityProvider: { connectionId: Schema.String },
  /** A platform administrator (`@awthaq/admin`). */
  PlatformAdmin: { adminUserId: Schema.String },
  /** Trusted application code: a job, a seed, a test. */
  Application: { label: Schema.String },
});
export type Actor = typeof ActorSchema.Type;
export type PlatformAdminActor = typeof ActorSchema.cases.PlatformAdmin.Type;

export const user = (principal: Api.UserPrincipal) =>
  ActorSchema.cases.User.make({ userId: principal.ref.id, sessionId: principal.sessionId });
export const directory = (connectionId: string) =>
  ActorSchema.cases.Directory.make({ connectionId });
export const identityProvider = (connectionId: string) =>
  ActorSchema.cases.IdentityProvider.make({ connectionId });
export const platformAdmin = (adminUserId: Users.UserId) =>
  ActorSchema.cases.PlatformAdmin.make({ adminUserId });
export const application = (label: string) => ActorSchema.cases.Application.make({ label });

/** The user an actor names, when it names one. */
export const userIdOf = (actor: Actor) =>
  actor._tag === "User"
    ? Users.UserId(actor.userId)
    : actor._tag === "PlatformAdmin"
      ? Users.UserId(actor.adminUserId)
      : undefined;

export type Bound = Data.TaggedEnum<{
  Unbounded: {};
  Ceiling: { readonly statements: PermissionEngine.Statements };
}>;
export const Bound = Data.taggedEnum<Bound>();
