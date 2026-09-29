// @awthaq/core — DataExportRegistry
//
// The registry half of `DataExport.ts` (CSG-005, wayfinder ticket 30's "natural next
// step"), a leaf module for the same reason `ErasureRegistry.ts` is: `Hooks.HooksLive`
// carries the registry so every composition already has it. See `DataExport.ts`.

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ContributionRegistry from "./internal/contributionRegistry.ts";
import type { UserId } from "./Users.ts";

/** A section is JSON-safe by construction: it is written straight into the export document. */
export type ExportSection = typeof Schema.Json.Type;

/** Who the export is for. The email is carried so a plugin can find rows keyed by address (an invitation addressed to the user). */
export interface DataExportSubject {
  readonly userId: UserId;
  readonly email: string;
}

export interface DataExportContribution {
  /** The contributing plugin's id (or `<plugin>.<part>`); it names the section in the document. */
  readonly id: string;
  /** Lower runs first; ties break by id. */
  readonly order?: number;
  /**
   * The personal data this plugin holds for the subject, as JSON. It must never include a
   * secret (a hash, a token, a key) and must fail — not return a partial section — if it
   * cannot read its store: a failing contribution fails the whole export, so a subject is
   * never handed an export that silently omits a category.
   */
  readonly collect: (subject: DataExportSubject) => Effect.Effect<ExportSection>;
}

/** A contribution registered after the registry was first read — a composition-order bug. */
export class DataExportRegistryFrozen extends Data.TaggedError("DataExportRegistryFrozen")<{
  readonly id: string;
  readonly message: string;
}> {}

export interface DataExportRegistryShape {
  readonly register: (contribution: DataExportContribution) => Effect.Effect<void>;
  /** Every registered contribution in run order; the first read freezes the registry. */
  readonly contributions: Effect.Effect<ReadonlyArray<DataExportContribution>>;
}

export class DataExportRegistry extends Context.Service<
  DataExportRegistry,
  DataExportRegistryShape
>()("awthaq/core/DataExportRegistry") {}

/** The registry, one per composition. */
export const registryLayer: Layer.Layer<DataExportRegistry> = Layer.effect(
  DataExportRegistry,
  Effect.map(
    ContributionRegistry.make<DataExportContribution>(
      (id) =>
        new DataExportRegistryFrozen({
          id,
          message: `awthaq: data-export contribution "${id}" registered after the first export — every contribution must be installed before the registry is first read`,
        }),
    ),
    (store) => DataExportRegistry.of(store),
  ),
);

/**
 * A plugin's export section, as a `Layer` its own `layer` includes (`AuthPlugin.layer`'s
 * `contributes` option, alongside its `Erasure.contribute`). `make` resolves the plugin's
 * record stores once, at build, and returns the closure that collects one subject's data.
 * The layer requires `DataExportRegistry`, so a composition without it does not compile.
 */
export const contribute = <E, R>(options: {
  readonly id: string;
  readonly order?: number;
  readonly make: Effect.Effect<DataExportContribution["collect"], E, R>;
}): Layer.Layer<never, E, DataExportRegistry | Exclude<R, Scope.Scope>> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* DataExportRegistry;
      const collect = yield* options.make;
      yield* registry.register({
        id: options.id,
        ...(options.order === undefined ? {} : { order: options.order }),
        collect,
      });
    }),
  );
