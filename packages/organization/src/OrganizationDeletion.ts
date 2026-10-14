// @awthaq/organization — OrganizationDeletion
//
// The registry of rows that hang off an organization but are not this plugin's (ADR-EA-040,
// ADR-EA-012 aggregating-registry style, shaped like `Erasure.contribute`): an OIDC connection,
// a SAML connection with its keys and sessions, a SCIM connection with its mappings. Each plugin
// contributes a handler; `OrganizationDirectory.delete` runs every `inTransaction` inside its
// delete transaction (so a failing contribution rolls the whole deletion back) and every
// `afterCommit` once it has committed.
//
// Contributions are collected in any order, run by `order` then id, and the first read freezes
// the registry: registering afterwards is a composition-order bug and a defect, never a silent
// no-op.

import type { Errors } from "@awthaq/core";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

export interface OrganizationDeletionHandler {
  /**
   * Removes this plugin's rows for the organization. It runs inside the deletion's transaction: it must be
   * idempotent, and a failure aborts the deletion and rolls it back.
   */
  readonly inTransaction: (organizationId: string) => Effect.Effect<void, Errors.StoreUnavailable>;
  /** Runs after the deletion has committed (cache invalidation); cannot fail the deletion. */
  readonly afterCommit?: ((organizationId: string) => Effect.Effect<void>) | undefined;
}

export interface OrganizationDeletionContribution {
  /** The contributing plugin's id (or `<plugin>.<part>`). */
  readonly id: string;
  /** Lower runs first; ties break by id. */
  readonly order?: number | undefined;
  readonly handler: OrganizationDeletionHandler;
}

/** A contribution registered after the registry was first read: a composition-order bug. */
export class OrganizationDeletionRegistryFrozen extends Data.TaggedError(
  "OrganizationDeletionRegistryFrozen",
)<{
  readonly id: string;
  readonly message: string;
}> {}

export interface OrganizationDeletionShape {
  readonly register: (contribution: OrganizationDeletionContribution) => Effect.Effect<void>;
  /** Every registered contribution in run order; the first read freezes the registry. */
  readonly contributions: Effect.Effect<ReadonlyArray<OrganizationDeletionContribution>>;
}

export class OrganizationDeletion extends Context.Service<
  OrganizationDeletion,
  OrganizationDeletionShape
>()("awthaq/plugin/organization/Deletion") {
  /** The registry, one per composition (like a hook point's, ADR-EA-033). */
  static readonly layer = Layer.effect(
    OrganizationDeletion,
    Effect.gen(function* () {
      const entries = yield* Ref.make<ReadonlyArray<OrganizationDeletionContribution>>([]);
      const frozen = yield* Ref.make(false);
      const register: OrganizationDeletionShape["register"] = (contribution) =>
        Effect.gen(function* () {
          if (yield* Ref.get(frozen)) {
            return yield* Effect.die(
              new OrganizationDeletionRegistryFrozen({
                id: contribution.id,
                message: `awthaq: organization deletion contribution "${contribution.id}" registered after the first organization deletion: every contribution must be installed before the registry is first read`,
              }),
            );
          }
          yield* Ref.update(entries, (current) => [...current, contribution]);
        });
      const contributions: OrganizationDeletionShape["contributions"] = Effect.gen(function* () {
        yield* Ref.set(frozen, true);
        return (yield* Ref.get(entries)).toSorted(
          (a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
      });
      return OrganizationDeletion.of({ register, contributions });
    }),
  );
}

/**
 * A plugin's part of an organization's deletion, as a `Layer` its own `layer` includes
 * (`AuthPlugin.layer`'s `contributes` option). `make` resolves the plugin's own stores once, at build, and
 * returns the handler; the layer requires `OrganizationDeletion`, which `Organization.layer` exposes, so a
 * composition that installs the plugin without `Organization` does not compile.
 */
export const contribute = <E, R>(options: {
  readonly id: string;
  readonly order?: number | undefined;
  readonly make: Effect.Effect<OrganizationDeletionHandler, E, R>;
}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* OrganizationDeletion;
      const handler = yield* options.make;
      yield* registry.register({ id: options.id, order: options.order, handler });
    }),
  ) satisfies Layer.Layer<never, E, OrganizationDeletion | Exclude<R, Scope.Scope>>;
