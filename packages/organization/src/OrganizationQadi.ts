// @awthaq/organization — OrganizationQadi
//
// Ticket 18 / spec.md's "qadi contribution": two plain `Layer.effect`
// contributions an application composes into its own `QadiLive` by hand —
// neither is wired automatically by `Auth.make` or this plugin's own
// `AuthPlugin.layer`, matching `usage-qadi.md` §6.2's shape and
// `packages/qadi/src/Resolvers.ts`'s own header comment ("BEH-EA-162
// belongs to the Organization plugin... nothing to build in this package
// for it").
//
// **Correction to spec.md's own framing, found while reading the real
// `@qadi/core` API this ticket builds against**: `AttributeResolverShape.resolve`
// is `(subjectId, attribute) => Effect<unknown, AttributeResolveError>` —
// it carries no `resourceId` at all. `spec.md`'s "resolves `orgRole`/
// `orgPermissions` from a subject's membership in whichever organization
// the check concerns" is not expressible through this shape: there is no
// parameter naming which organization is meant. Reading
// `@qadi/core`'s `Resource.ts` (`export type Resource = Readonly<Record<string,
// unknown>>`) and `Evaluate.ts`'s `EvaluateOptions.resource` confirms why:
// `hasResourceAttribute` is answered from a plain data bag the *calling
// application* passes into `evaluate(policy, { resource })` inline, never
// from a resolver service — there is no "ResourceAttributeResolver" to
// contribute to. Org-scoped questions ("is this subject an admin of *this*
// organization") therefore belong on `RelationshipResolver` instead, whose
// `RelationshipCheck` genuinely carries a `resourceId` — so this module
// expands `Organization.relationships`'s relation vocabulary beyond the
// ticket's own `"member"`/`"team-member"` to include role-based relations
// (`"admin"`, `"owner"`) that answer exactly the org-scoped questions
// `spec.md` wanted `Organization.attributes` to answer, through the
// mechanism that can actually carry an organization id.
// `Organization.attributes` still ships, narrowed to what `AttributeResolver`
// can honestly answer: subject-scoped (no resourceId) facts, mirroring
// `Resolvers.ts`'s own `UserAttributes` shape exactly — here,
// `"organizationCount"`/`"ownedOrganizationCount"`, the subject's total
// organization footprint across every org they belong to, not scoped to
// any one of them.
import { Organization as OrganizationService } from "./Organization.ts";
import * as MembershipRecords from "./MembershipRecords.ts";
import * as TeamRecords from "./TeamRecords.ts";
import * as Users from "@awthaq/core/Users";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  AttributeResolver,
  AttributeResolveError,
  RelationshipResolver,
  RelationshipResolveError,
} from "@qadi/core";

const USER_SUBJECT_PREFIX = "user:";

const userIdFromSubject = (subjectId: string): Users.UserId | undefined =>
  subjectId.startsWith(USER_SUBJECT_PREFIX)
    ? Users.UserId(subjectId.slice(USER_SUBJECT_PREFIX.length))
    : undefined;

/**
 * BEH-EA-162 (`"member"`), plus this plugin's own richer relations built on
 * the same mechanism: `"admin"`/`"owner"` (the subject holds that role in
 * the organization named by `resourceId`) and `"team-member"` (the subject
 * belongs to the team named by `resourceId`). `resourceId` names the
 * organization/team directly — see this module's own header comment for
 * why the richer "arbitrary application resource → organization" walk
 * `spec/models/14-organization.md`'s own worked example shows (via a
 * `Projects.use(...)` call this plugin cannot make) is out of scope: it
 * requires application-specific domain knowledge only the application
 * itself has.
 */
export const relationships = Layer.effect(
  RelationshipResolver,
  Effect.gen(function* () {
    const organization = yield* OrganizationService;
    const teams = yield* TeamRecords.TeamRecords;

    const roleRelation = (organizationId: string, userId: Users.UserId, role: string) =>
      organization
        .attributesFor(organizationId, userId)
        .pipe(
          Effect.map((attrs) =>
            Option.isSome(attrs) && attrs.value.role.includes(role)
              ? ("Related" as const)
              : ("Unrelated" as const),
          ),
        );

    return {
      name: "awthaq/OrganizationQadi.relationships",
      check: ({ subjectId, relation, resourceId }) =>
        Effect.gen(function* () {
          const userId = userIdFromSubject(subjectId);
          if (userId === undefined) return "Unrelated" as const;

          switch (relation) {
            case "member":
              return yield* organization
                .attributesFor(resourceId, userId)
                .pipe(
                  Effect.map((attrs) =>
                    Option.isSome(attrs) ? ("Related" as const) : ("Unrelated" as const),
                  ),
                );
            case "admin":
              return yield* roleRelation(resourceId, userId, "admin");
            case "owner":
              return yield* roleRelation(resourceId, userId, "owner");
            case "team-member": {
              const membership = yield* teams.findTeamMembership(resourceId, userId);
              return Option.isSome(membership) ? ("Related" as const) : ("Unrelated" as const);
            }
            default:
              return "Unrelated" as const;
          }
        }).pipe(
          Effect.catchDefect((cause) =>
            Effect.fail(new RelationshipResolveError({ relation, resourceId, cause })),
          ),
        ),
    };
  }),
);

/**
 * Subject-scoped facts `AttributeResolver`'s real shape can honestly
 * answer — no organization parameter exists to scope by (see this module's
 * own header comment). `"organizationCount"`: how many organizations this
 * subject belongs to at all; `"ownedOrganizationCount"`: how many of those
 * it owns. `undefined` for a non-`"user:"` subject or an unrecognized
 * attribute name, mirroring `Resolvers.ts`'s own `UserAttributes` exactly.
 */
export const attributes = Layer.effect(
  AttributeResolver,
  Effect.gen(function* () {
    const members = yield* MembershipRecords.MembershipRecords;
    return {
      name: "awthaq/OrganizationQadi.attributes",
      resolve: (subjectId, attribute) => {
        const userId = userIdFromSubject(subjectId);
        if (userId === undefined) return Effect.succeed(undefined);

        return members.listByUser(userId).pipe(
          Effect.map((memberships): unknown => {
            switch (attribute) {
              case "organizationCount":
                return memberships.length;
              case "ownedOrganizationCount":
                return memberships.filter((m) => m.role.includes("owner")).length;
              default:
                return undefined;
            }
          }),
          Effect.catchDefect((cause) =>
            Effect.fail(new AttributeResolveError({ attribute, cause })),
          ),
        );
      },
    };
  }),
);
