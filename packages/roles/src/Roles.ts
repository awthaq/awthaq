// @awthaq/roles — Roles plugin
//
// spec/behaviors/18-roles-subject-resolver.md, BEH-EA-138 through BEH-EA-141.
// The one plugin that overrides `@awthaq/qadi`'s `SubjectResolver` slot
// (BEH-EA-138) with a real implementation: `UserPrincipal` gets its assigned
// role names looked up and flattened through qadi's role DAG into
// `AuthSubject.roles`/`permissions` (BEH-EA-139); every other principal kind
// — `Anonymous`, `ApiKey`, `Service`, and a `UserPrincipal`'s own
// `actingAs` — is delegated to `@awthaq/qadi`'s own
// `resolveIdentityOnly`, so installing this plugin never changes how those
// kinds resolve (BEH-EA-140's/141's real gap — no `scopes` field exists yet
// on `ApiKeyPrincipal`/`ServicePrincipal` — is documented once, in
// `@awthaq/qadi`'s `SubjectResolver.ts`, not repeated here).
//
// SQL persistence for role assignments is deferred: only `layerMemory`
// exists today, the same class of not-yet-designed persistence
// `@awthaq/ports`'s deferred `WebAuthn` interface documents. A real
// reservation/uniqueness design for a `role_assignments` table is separate,
// later work, not a gap silently papered over.
import { Users } from "@awthaq/core";
import { AuthPlugin, Slots } from "@awthaq/core";
import { SubjectResolver as QadiSubjectResolver } from "@awthaq/qadi";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import type { Role } from "@qadi/core";
import { fromRoles, withAttributes } from "@qadi/core";

export interface RolesShape {
  /** Idempotent: assigning an already-held role name is a no-op. */
  readonly assign: (userId: Users.UserId, roleName: string) => Effect.Effect<void>;
  readonly revoke: (userId: Users.UserId, roleName: string) => Effect.Effect<void>;
  readonly listRoleNames: (userId: Users.UserId) => Effect.Effect<ReadonlyArray<string>>;
}

export interface RolesConfigShape {
  /** BEH-EA-139: the whole role DAG this deployment defines, built with `@qadi/core`'s own `role()`. */
  readonly catalog: ReadonlyArray<Role>;
}

export const RolesConfig: Context.Reference<RolesConfigShape> = Context.Reference(
  "awthaq/roles/Config",
  { defaultValue: (): RolesConfigShape => ({ catalog: [] }) },
);

export const config = (catalog: ReadonlyArray<Role>): Layer.Layer<never> =>
  Layer.succeed(RolesConfig, { catalog });

const emptyNames: ReadonlyArray<string> = [];

const rolesMake: Effect.Effect<RolesShape> = Effect.gen(function* () {
  const state = yield* Ref.make(HashMap.empty<Users.UserId, ReadonlyArray<string>>());

  const namesOf = (
    map: HashMap.HashMap<Users.UserId, ReadonlyArray<string>>,
    userId: Users.UserId,
  ): ReadonlyArray<string> => HashMap.get(map, userId).pipe(Option.getOrElse(() => emptyNames));

  return {
    assign: (userId, roleName) =>
      Ref.update(state, (map) => {
        const existing = namesOf(map, userId);
        return existing.includes(roleName)
          ? map
          : HashMap.set(map, userId, [...existing, roleName]);
      }),
    revoke: (userId, roleName) =>
      Ref.update(state, (map) =>
        HashMap.set(
          map,
          userId,
          namesOf(map, userId).filter((name) => name !== roleName),
        ),
      ),
    listRoleNames: (userId) => Ref.get(state).pipe(Effect.map((map) => namesOf(map, userId))),
  };
});

export class Roles extends AuthPlugin.Service<Roles, RolesShape>()("roles", {
  apiVersion: 1,
  // BEH-EA-018/roadmap M3: no HTTP contract of its own — this plugin's whole
  // job is the `SubjectResolver` override, per this module's own header
  // comment. `HttpApi.make("auth")` with no `.add()` call is a real,
  // zero-group `HttpApi<"auth", never>`, which contributes nothing to
  // `Auth.make`'s composed `api` (`never extends GroupsFor<"roles">` holds
  // trivially, the same bottom-type reasoning `Auth.ts`'s own comments use
  // for `Layer`'s contravariant `ROut`).
  contract: HttpApi.make("auth"),
  tables: [],
}) {
  /**
   * Self-referential the same way `Password`'s own `static readonly layer`
   * is (that class's doc comment explains why this is safe): `Roles` is
   * read, as a `Context.Service` tag, from inside a lazily-run `Effect.gen`
   * body that is not evaluated until this very layer is built, so the
   * forward reference to the not-yet-finished class statement is fine.
   *
   * `Layer.provideMerge(subjectResolverOverride, ownLayer)` — `ownLayer`
   * (`AuthPlugin.layer(Roles, {make: rolesMake})`) provides `Roles` itself;
   * `subjectResolverOverride` (built via `Slots.override`, BEH-EA-021)
   * requires exactly that `Roles` to resolve role assignments, so folding
   * it underneath satisfies that requirement and the composed result
   * exposes both `Roles` and the overridden `SubjectResolver` in its
   * `ROut` — the real, working half of BEH-EA-138 this module's own header
   * comment describes. `Slots.override` also registers this claim with
   * `@awthaq/core`'s opt-in `Slots.SlotsRegistry`, so an application
   * that provides `Slots.layer` gets a real `SlotConflict` if some other
   * plugin ever claims this same slot too (`Slots.ts`'s own header comment
   * explains why that check is enforced at `Layer`-build time, not by
   * `Auth.make`'s type checker).
   */
  static readonly layer = Slots.override(
    Roles,
    QadiSubjectResolver.SubjectResolver,
    Effect.gen(function* () {
      const roles = yield* Roles;
      const rolesConfig = yield* RolesConfig;
      const catalog = new Map(rolesConfig.catalog.map((role) => [role.name, role] as const));

      return {
        resolve: (principal) => {
          if (principal._tag !== "User") {
            return Effect.succeed(QadiSubjectResolver.resolveIdentityOnly(principal));
          }
          return Effect.gen(function* () {
            const userId = Users.UserId(principal.ref.id);
            const names = yield* roles.listRoleNames(userId);
            const matched = names.flatMap((name) => {
              const found = catalog.get(name);
              return found === undefined ? [] : [found];
            });
            const subject = fromRoles({ id: `user:${userId}`, roles: matched });
            return principal.actingAs === undefined
              ? subject
              : withAttributes(subject, {
                  actingAs: { type: principal.actingAs.type, id: principal.actingAs.id },
                });
          });
        },
      };
    }),
  ).pipe(Layer.provideMerge(AuthPlugin.layer(Roles, { make: rolesMake })));
}
