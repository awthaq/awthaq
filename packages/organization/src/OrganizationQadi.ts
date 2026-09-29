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
import * as OrganizationRecords from "./OrganizationRecords.ts";
import * as PermissionEngine from "./PermissionEngine.ts";
import * as TeamRecords from "./TeamRecords.ts";
import { Users } from "@awthaq/core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
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
 * RZS-001 (wayfinder ticket 13): the port an application provides so
 * `"member"` can be asked of a resource that is not itself an organization
 * ("member of this *project*", `hasRelationship("member", { depth: 2 })`).
 * This plugin cannot know that an arbitrary resource id is a project or a task
 * — only the application does — so it asks: `organizationOf` answers the
 * resource's *direct* owning organization (the application resolves any longer
 * chain itself). `Option.none()` means "no organization could be resolved".
 * Per ADR-EA-010 the plugin requires the port and the application provides it;
 * `layerNone` is the visible, deliberate "no walking configured" choice.
 */
export interface ResourceOrganizationLookupShape {
  readonly organizationOf: (resourceId: string) => Effect.Effect<Option.Option<string>, unknown>;
}

export class ResourceOrganizationLookup extends Context.Service<
  ResourceOrganizationLookup,
  ResourceOrganizationLookupShape
>()("awthaq/organization/ResourceOrganizationLookup") {
  /** For applications with no non-organization resources to walk from: every walk is unresolved, i.e. a `RelationshipResolveError`, never a silent deny. */
  static readonly layerNone = Layer.succeed(
    ResourceOrganizationLookup,
    ResourceOrganizationLookup.of({ organizationOf: () => Effect.succeed(Option.none()) }),
  );
}

/**
 * RZS-006: the relation grammar `relationships` understands, in one place so
 * application policies reference it instead of string literals.
 *
 * - `member` — the subject holds a membership in the organization (`resourceId`,
 *   or, at `depth >= 1`, the organization `ResourceOrganizationLookup` resolves
 *   it to).
 * - `has-role:<name>` — the membership holds that role, whatever kind it is
 *   (built-in, `OrganizationConfig.permissionStatements`, or a dynamic role);
 *   `admin`/`owner` are aliases of `has-role:admin`/`has-role:owner`. (Not
 *   `role:<name>`: `role` is itself a built-in statement resource —
 *   `role:create`, `role:delete` — so that spelling would collide with the
 *   `<resource>:<action>` form below.)
 * - `<resource>:<action>` (e.g. `member:update`) — the membership's *effective*
 *   statements include it: the very `effectivePermissionsOf` result
 *   `requirePermission` gates the plugin's own endpoints with, so a qadi policy
 *   and the plugin's own gating can never disagree.
 * - `team-member` — the subject is on the team `resourceId` names.
 * - `team-role:<name>` — the subject holds that team role on the team `resourceId`
 *   names *or any of its ancestors* (OHS-004: team authority flows down the subtree,
 *   exactly as the plugin's own gating applies it).
 *
 * Anything else is `"Unknown"` — qadi's documented answer for a relation the
 * resolver has no answer for — and so is an organization-scoped relation whose
 * `resourceId` names no organization (or a team relation naming no team): a
 * malformed question is distinguishable from a genuine negative in traces.
 */
export const relations = {
  member: "member",
  admin: "admin",
  owner: "owner",
  teamMember: "team-member",
  teamRole: <const Name extends string>(name: Name): `team-role:${Name}` => `team-role:${name}`,
  role: <const Name extends string>(name: Name): `has-role:${Name}` => `has-role:${name}`,
  permission: <const Resource extends string, const Action extends string>(
    resource: Resource,
    action: Action,
  ): `${Resource}:${Action}` => `${resource}:${action}`,
};

type ParsedRelation =
  | { readonly _tag: "member" }
  | { readonly _tag: "team" }
  | { readonly _tag: "team-role"; readonly name: string }
  | { readonly _tag: "role"; readonly name: string }
  | { readonly _tag: "permission"; readonly resource: string; readonly action: string };

const parseRelation = (relation: string): ParsedRelation | undefined => {
  switch (relation) {
    case "member":
      return { _tag: "member" };
    case "team-member":
      return { _tag: "team" };
    case "admin":
    case "owner":
      return { _tag: "role", name: relation };
  }
  const colon = relation.indexOf(":");
  if (colon <= 0 || colon === relation.length - 1) return undefined;
  const head = relation.slice(0, colon);
  const tail = relation.slice(colon + 1);
  if (head === "team-role") return { _tag: "team-role", name: tail };
  return head === "has-role"
    ? { _tag: "role", name: tail }
    : { _tag: "permission", resource: head, action: tail };
};

/**
 * BEH-EA-162 (`"member"`, plus `depth >= 1` through `ResourceOrganizationLookup`)
 * and this plugin's richer relations — see `relations` for the grammar.
 * Every organization-scoped relation is answered from the membership row
 * (`member`, `has-role:*`: one indexed lookup, RZS-004) or, for `<resource>:<action>`,
 * from the same effective statements the plugin's own gating computes
 * (RZS-006). No cross-request cache lives here — the per-request
 * `DecisionCache` (ticket 12) is the sanctioned memo.
 *
 * Only `member` walks at `depth >= 1` (ticket 13's scope); the other relations
 * always treat `resourceId` as the organization (or team) itself.
 */
export const relationships = Layer.effect(
  RelationshipResolver,
  Effect.gen(function* () {
    const organization = yield* OrganizationService;
    const members = yield* MembershipRecords.MembershipRecords;
    const orgs = yield* OrganizationRecords.OrganizationRecords;
    const teams = yield* TeamRecords.TeamRecords;
    const lookup = yield* ResourceOrganizationLookup;

    return {
      name: "awthaq/OrganizationQadi.relationships",
      check: ({ subjectId, relation, resourceId, depth }) =>
        Effect.gen(function* () {
          const parsed = parseRelation(relation);
          if (parsed === undefined) return "Unknown" as const;
          const userId = userIdFromSubject(subjectId);
          if (userId === undefined) return "Unrelated" as const;

          // EP-003 (ADR-EA-018): a suspended organization confers nothing —
          // membership answers must not open a door the plugin's own gating shut.
          const isSuspended = (organizationId: string) =>
            orgs
              .findById(organizationId)
              .pipe(
                Effect.map((found) => Option.isSome(found) && Option.isSome(found.value.suspendedAt)),
              );

          if (parsed._tag === "team") {
            const team = yield* teams.findTeamByIdAnyOrg(resourceId);
            if (Option.isSome(team) && (yield* isSuspended(team.value.organizationId))) {
              return "Unrelated" as const;
            }
            const membership = yield* teams.findTeamMembership(resourceId, userId);
            if (Option.isSome(membership)) return "Related" as const;
            return Option.isSome(team) ? ("Unrelated" as const) : ("Unknown" as const);
          }

          if (parsed._tag === "team-role") {
            const team = yield* teams.findTeamByIdAnyOrg(resourceId);
            if (Option.isNone(team)) return "Unknown" as const;
            if (yield* isSuspended(team.value.organizationId)) return "Unrelated" as const;
            const ancestors = yield* teams.getAncestors(team.value.organizationId, resourceId);
            for (const id of [resourceId, ...ancestors.map((row) => row.id)]) {
              const held = yield* teams.findTeamMembership(id, userId);
              if (Option.isSome(held) && held.value.role.includes(parsed.name)) {
                return "Related" as const;
              }
            }
            return "Unrelated" as const;
          }

          // ticket 13: `member` at depth >= 1 asks the application which
          // organization owns the resource; an unresolved walk fails closed.
          const organizationId =
            parsed._tag === "member" && depth !== undefined && depth >= 1
              ? yield* lookup.organizationOf(resourceId).pipe(
                  Effect.mapError(
                    (cause) => new RelationshipResolveError({ relation, resourceId, cause }),
                  ),
                  Effect.flatMap(
                    Option.match({
                      onNone: () =>
                        Effect.fail(
                          new RelationshipResolveError({
                            relation,
                            resourceId,
                            cause: `no organization could be resolved for resource "${resourceId}"`,
                          }),
                        ),
                      onSome: Effect.succeed,
                    }),
                  ),
                )
              : resourceId;

          if (yield* isSuspended(organizationId)) return "Unrelated" as const;

          // A subject that is simply not in an organization is a genuine
          // negative; an id naming no organization at all is malformed.
          const notRelated = () =>
            orgs
              .findById(organizationId)
              .pipe(
                Effect.map((found) =>
                  Option.isSome(found) ? ("Unrelated" as const) : ("Unknown" as const),
                ),
              );

          if (parsed._tag === "permission") {
            const attrs = yield* organization.attributesFor(organizationId, userId);
            if (Option.isNone(attrs)) return yield* notRelated();
            return PermissionEngine.hasPermission(
              attrs.value.permissions,
              parsed.resource,
              parsed.action,
            )
              ? ("Related" as const)
              : ("Unrelated" as const);
          }

          const membership = yield* members.findByUserAndOrg(userId, organizationId);
          if (Option.isNone(membership)) return yield* notRelated();
          if (parsed._tag === "member") return "Related" as const;
          return membership.value.role.includes(parsed.name)
            ? ("Related" as const)
            : ("Unrelated" as const);
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
/**
 * Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 14
 * (AAPS-002): the attribute names `attributes` actually answers, declared
 * alongside the `Layer` itself — mirrors `@awthaq/qadi`'s own
 * `Resolvers.UserAttributeNames`, for the identical reason.
 */
export const OrganizationAttributeSchemas = {
  organizationCount: Schema.Number,
  ownedOrganizationCount: Schema.Number,
};

/** AAPS-003: valid `attributes` names, derived from `OrganizationAttributeSchemas`. */
export type OrganizationAttributeName = keyof typeof OrganizationAttributeSchemas;

export const OrganizationAttributeNames = Record.keys(OrganizationAttributeSchemas);

/** AAPS-003: a policy author's typed attribute name — a typo is a compile error, not a silent "no value". */
export const orgAttr = <const N extends OrganizationAttributeName>(name: N): N => name;

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
