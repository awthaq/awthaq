// @awthaq/core: RetentionRegistry
//
// The plugin half of `Retention.ts` (plan 10 item 6, ADR-EA-031 Decision 6), split into a leaf
// module so `Hooks.HooksLive`, the layer every composition already provides, can carry the
// registry (the same split as `ErasureRegistry`). Core's sweep purges the three core stores;
// every plugin that owns a table that grows (SAML session records, device grants, revoked-token
// rows, invitations, passkey challenges, webhook deliveries) contributes its own expiry rule here,
// so one scheduled `Retention.sweep` covers every installed plugin and each rule stays next to its
// table. Contributions aggregate and never conflict (ADR-EA-012); the first read freezes the
// registry.

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ContributionRegistry from "./internal/contributionRegistry.ts";
import type { StoreUnavailable } from "./Errors.ts";

export interface RetentionContribution {
  /** The contributing plugin's id (or `<plugin>.<part>`), e.g. `saml.sessions`. */
  readonly id: string;
  /** Lower runs first; ties break by id. */
  readonly order?: number;
  /**
   * Deletes the rows past this contribution's own window as of `now` (the window is the plugin's
   * config, not the registry's) and returns how many went. Bounded batches; idempotent.
   */
  readonly purge: (now: DateTime.Utc) => Effect.Effect<number, StoreUnavailable>;
}

/** A contribution registered after the registry was first read: a composition-order bug. */
export class RetentionRegistryFrozen extends Data.TaggedError("RetentionRegistryFrozen")<{
  readonly id: string;
  readonly message: string;
}> {}

export class RetentionRegistry extends Context.Service<
  RetentionRegistry,
  ContributionRegistry.Store<RetentionContribution>
>()("awthaq/core/RetentionRegistry") {}

/** The registry, one per composition (like a hook point's, ADR-EA-033). */
export const registryLayer = Layer.effect(
  RetentionRegistry,
  Effect.map(
    ContributionRegistry.make<RetentionContribution>(
      (id) =>
        new RetentionRegistryFrozen({
          id,
          message: `awthaq: retention contribution "${id}" registered after the first sweep: every contribution must be installed before the registry is first read`,
        }),
    ),
    (store) => RetentionRegistry.of(store),
  ),
);

/**
 * A plugin's retention rule, as a `Layer` its own `layer` includes (`AuthPlugin.layer`'s
 * `contributes` option). `make` resolves the plugin's record stores and config once, at build, and
 * returns the closure that purges as of `now`. The layer requires `RetentionRegistry`: a composition
 * that installs the plugin without providing it fails to compile.
 */
export const contribute = <E, R>(options: {
  readonly id: string;
  readonly order?: number;
  readonly make: Effect.Effect<RetentionContribution["purge"], E, R>;
}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* RetentionRegistry;
      const purge = yield* options.make;
      yield* registry.register({
        id: options.id,
        ...(options.order === undefined ? {} : { order: options.order }),
        purge,
      });
    }),
  );
