// @awthaq/core — SignInContinuationRegistry
//
// ADR-EA-038: the registry half of `SignIn.continuation`, split into a leaf module so
// `Hooks.HooksLive` — the layer every composition already provides — can carry it (the same split
// as `ErasureRegistry`). A *continuation* is work a first-factor flow owes once the session
// exists, whichever request finally mints that session: SAML's Single Logout record and role
// mapping must run whether the ACS minted the session or `/two-factor/verify` did. Contributions
// aggregate and never conflict (ADR-EA-012); the first read freezes the registry.

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import * as ContributionRegistry from "./internal/contributionRegistry.ts";
import type { StoreUnavailable } from "./Errors.ts";
import type { Ids } from "@awthaq/ports";

/**
 * What a continuation is told: who signed in, by which strategy, and the session that now exists.
 * Ids only: this leaf is imported by `Hooks.ts`, which `Users.ts` imports, so it cannot name
 * `UserRecord` or `SessionView` without closing a cycle (a continuation that needs the record
 * reads it by id).
 */
export interface ContinuationContext {
  readonly userId: Ids.UserId;
  readonly sessionId: string;
  readonly strategy: string;
}

export interface ContinuationContribution {
  /** The contributing plugin's id. */
  readonly id: string;
  /** What `Attempt.continuation.kind` names, e.g. `saml.acs`. */
  readonly kind: string;
  readonly run: (
    payload: Schema.Json,
    context: ContinuationContext,
  ) => Effect.Effect<void, StoreUnavailable>;
}

/** A continuation registered after the registry was first read: a composition-order bug. */
export class ContinuationRegistryFrozen extends Data.TaggedError(
  "SignIn/ContinuationRegistryFrozen",
)<{
  readonly id: string;
  readonly message: string;
}> {}

export class SignInContinuationRegistry extends Context.Service<
  SignInContinuationRegistry,
  ContributionRegistry.Store<ContinuationContribution>
>()("awthaq/core/SignInContinuationRegistry") {}

/** The registry, one per composition (like a hook point's, ADR-EA-033). */
export const registryLayer = Layer.effect(
  SignInContinuationRegistry,
  Effect.map(
    ContributionRegistry.make<ContinuationContribution>(
      (id) =>
        new ContinuationRegistryFrozen({
          id,
          message: `awthaq: sign-in continuation "${id}" registered after the first sign-in: every continuation must be installed before the registry is first read`,
        }),
    ),
    (store) => SignInContinuationRegistry.of(store),
  ),
);
