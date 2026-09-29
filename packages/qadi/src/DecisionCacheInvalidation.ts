// @awthaq/qadi — DecisionCacheInvalidation
//
// Wayfinder ticket 12 (PCS-001/PCS-002/RZS-002): the opt-in half of awthaq's
// decision-cache policy. The default is a **per-request** `DecisionCache`
// (see `RequestDecisionCache.ts`), which needs no invalidation at all. An
// application that provides `decisionCacheLayer` above request scope — a
// long-lived worker, or a deployment that measured the per-request cache
// build and wants a warmer cache — must also provide this layer, or it
// knowingly accepts the backend-revocation staleness window `DecisionCache`'s
// own doc comment warns about ("safe against token downgrade and unsafe
// against backend revocation").
import { Hooks } from "@awthaq/core";
import { OrganizationHooks } from "@awthaq/organization";
import { DecisionCache } from "@qadi/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Empties the `DecisionCache` whenever state an evaluation may have consulted
 * changes. Whole-cache `clear`, not a scoped evict: `clear` is the only
 * invalidation primitive `DecisionCacheShape` exposes, and a coarse-but-correct
 * flush beats a narrow-but-wrong one.
 *
 * Taps every `OrganizationHooks` observe point that can move a
 * `RelationshipResolver` answer (`OrganizationQadi.relationships`):
 * membership add/remove/role change (incl. `leave` and invitation
 * acceptance), organization deletion, team-membership add/remove, team
 * update/deletion, and dynamic-role CRUD (a role's statements feed the
 * `<resource>:<action>` relations). It also taps
 * `Hooks.AfterUserAttributesChanged` (AAPS-005), so awthaq-owned user
 * attributes (`Resolvers.UserAttributes`: `emailVerified`, `name`) cannot
 * outlive a `Users.verifyEmail`/`updateProfile`.
 *
 * **Provide it once, application-wide.** `HookPoint` tap registries are
 * module-level singletons that freeze at their point's first `run()`
 * (BEH-EA-024): building this layer after an organization operation has
 * already run dies with `HookPointFrozen`. It requires the `DecisionCache`
 * it flushes, so compose it next to the `decisionCacheLayer` it guards.
 *
 * **Coverage caveat — read before relying on it.** This only covers state
 * awthaq's own plugins own: organization/team membership and awthaq's own
 * user attributes. It does **not** cover application-defined
 * `AttributeResolver`/`RelationshipResolver` data — e.g.
 * `hasResourceAttribute("ownerId", ...)` over the application's own `Project`
 * table. An application-scoped cache over such data must call
 * `DecisionCache.clear` from its own mutations (or use per-request scope,
 * which needs none of this).
 */
export const DecisionCacheInvalidationLive = Layer.unwrap(
  Effect.gen(function* () {
    const cache = yield* DecisionCache;
    const clear = () => cache.clear;
    return Layer.mergeAll(
      OrganizationHooks.AfterAddMember.tap(clear),
      OrganizationHooks.AfterRemoveMember.tap(clear),
      OrganizationHooks.AfterUpdateMemberRole.tap(clear),
      OrganizationHooks.AfterAcceptInvitation.tap(clear),
      OrganizationHooks.AfterDeleteOrganization.tap(clear),
      OrganizationHooks.AfterAddTeamMember.tap(clear),
      OrganizationHooks.AfterRemoveTeamMember.tap(clear),
      OrganizationHooks.AfterUpdateTeam.tap(clear),
      OrganizationHooks.AfterDeleteTeam.tap(clear),
      OrganizationHooks.AfterCreateRole.tap(clear),
      OrganizationHooks.AfterUpdateRole.tap(clear),
      OrganizationHooks.AfterDeleteRole.tap(clear),
      Hooks.AfterUserAttributesChanged.tap(clear),
    );
  }),
);
