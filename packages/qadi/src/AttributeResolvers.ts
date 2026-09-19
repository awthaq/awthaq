// @awthaq/qadi — AttributeResolvers
//
// Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 14
// (AAPS-002): `@qadi/core`'s `AttributeResolver` is a plain `Context.Service`
// tag with no registry/conflict-detection semantics of its own — composing
// two applications' worth of resolvers (e.g. `Resolvers.UserAttributes` and
// `@awthaq/organization`'s `OrganizationQadi.attributes`) into one `QadiLive`
// via an ordinary `Layer.provide`/`Layer.merge` silently drops whichever one
// was layered first, per `spec/behaviors/21-qadi-resolvers-obligations.md`'s
// own admission. `@qadi/core` ships only single-resolver wrappers
// (`attributeResolverRetrying`/`attributeResolverBounded`/
// `attributeResolverFromRecord`) — no fan-out/merge combinator across
// multiple resolvers — and is a separate library this project does not
// modify, so the fix is this awthaq-side combinator applications reach for
// when hand-assembling `QadiLive`, mirroring `ADR-EA-012`'s own "exclusive
// things are conflict-checked at composition time" discipline extended to
// this qadi-facing seam.
import { AttributeResolver } from "@qadi/core";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * One producer's own contribution to the registry: the attribute names it
 * answers for, alongside the `Layer` that answers them. `names` is declared
 * by the contributor, not inferred from `layer` (`AttributeResolverShape`
 * itself carries no such metadata — `resolve` is opaque), so every
 * awthaq-shipped resolver exports its own name list alongside its `Layer`
 * (`Resolvers.UserAttributeNames`, `OrganizationQadi.OrganizationAttributeNames`)
 * rather than a composing application hand-copying a list that can drift.
 */
export interface AttributeResolverContribution<E = never, R = never> {
  readonly names: ReadonlyArray<string>;
  readonly layer: Layer.Layer<AttributeResolver, E, R>;
}

/**
 * Two contributions declared the same attribute name — caught here, at
 * composition time, rather than silently letting whichever one built last
 * shadow the other's answer for that attribute (the exact failure mode this
 * module exists to close, one level more precise than the whole-`Layer`
 * shadowing `AAPS-002` originally reported).
 */
export class DuplicateAttributeResolver extends Data.TaggedError("DuplicateAttributeResolver")<{
  readonly attribute: string;
  readonly contributors: ReadonlyArray<string>;
}> {}

/**
 * Composes several `AttributeResolver` contributions into one, dispatching
 * `resolve(subjectId, attribute)` to exactly the one contribution that
 * declared `attribute` — an O(1) index lookup, not a fan-out that calls
 * every producer per lookup (which would also reintroduce a per-attribute
 * version of the exact ambiguity this combinator exists to refuse). An
 * attribute no contribution declared resolves `undefined`, the same "no
 * value" answer any single resolver already gives for an attribute it does
 * not recognize (`AttributeResolverNone`'s own "resolves nothing" posture).
 *
 * Each contribution's own `Layer` is built once, in isolation, at
 * composition time (the same `Layer.build`/`Context.get` ceremony
 * `@qadi/core`'s own `wrapService`/`wrapServiceEffect` use to unwrap a
 * service out of an already-built `Layer`) — never merged with the others
 * through the ambient `Context`, which is exactly the mechanism that lets
 * two same-tag `Layer`s silently shadow each other in the first place.
 */
export const attributeResolverRegistry = <E, R>(
  contributions: ReadonlyArray<AttributeResolverContribution<E, R>>,
): Layer.Layer<AttributeResolver, DuplicateAttributeResolver | E, R> =>
  Layer.effect(
    AttributeResolver,
    Effect.gen(function* () {
      const built = yield* Effect.forEach(contributions, (contribution) =>
        Layer.build(contribution.layer).pipe(
          Effect.map((context) => ({
            names: contribution.names,
            resolver: Context.get(context, AttributeResolver),
          })),
        ),
      );

      const index = new Map<string, (typeof built)[number]>();
      for (const entry of built) {
        for (const name of entry.names) {
          const existing = index.get(name);
          if (existing !== undefined) {
            return yield* Effect.fail(
              new DuplicateAttributeResolver({
                attribute: name,
                contributors: [existing.resolver.name ?? "?", entry.resolver.name ?? "?"],
              }),
            );
          }
          index.set(name, entry);
        }
      }

      return {
        name: "awthaq/attributeResolverRegistry",
        resolve: (subjectId, attribute) => {
          const entry = index.get(attribute);
          return entry === undefined
            ? Effect.succeed(undefined)
            : entry.resolver.resolve(subjectId, attribute);
        },
      };
    }),
  );
