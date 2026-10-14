// @awthaq/core — Errors
//
// MA-004 (ADR-EA-028, spec/behaviors/06-domain-users-accounts.md BEH-EA-035). One policy for what a
// core service does when its backing store fails: a domain outcome (`SessionNotFound`,
// `EmailAlreadyExists`, ...) is a typed error in the Shape's `E`, and an *infrastructure* failure —
// a database that is down or busy, a crypto provider that cannot answer — is the one typed
// `StoreUnavailable`, so a caller can retry, degrade or answer 503, and the Shape's `E` says so
// for both `layerMemory` and `layerSql`. What still dies is a defect that a retry cannot fix: a
// row that no longer decodes (`SchemaError`), or an invariant this code itself broke.
//
// The class is `@awthaq/api`'s wire error (`Api.StoreUnavailable`, 503) on purpose: the
// authentication and CSRF middleware declare it, so it crosses the HTTP boundary as itself with
// no mapping layer, and there is no second `Data` twin to keep in step (ESS-008). Its cause is
// never a field: it is logged here, where it happened, and cannot reach a response body.

// Plan 05: the definitions live in `@awthaq/sql` (`StoreFailure`) so plugin records modules share
// them; this module re-exports them, so no core caller changes.

import { StoreFailure } from "@awthaq/sql";
import * as Effect from "effect/Effect";

export import StoreUnavailable = StoreFailure.StoreUnavailable;
export const { storeUnavailable, orStoreUnavailable, transientRetrySchedule, retryTransient } =
  StoreFailure;

const isStoreUnavailable = <E>(error: E): error is Extract<E, StoreUnavailable> =>
  error instanceof StoreUnavailable;

/**
 * Plan 02 (ADR-EA-041, "operation labels"): a store adapter names the primitive that failed
 * (`SessionStore.flagReuse`); the domain service says which of ITS operations the caller was running
 * (`Sessions.verify`), because `StoreUnavailable.operation` is visible on the wire and asserted by
 * tests. Wraps a whole service operation: every `StoreUnavailable` inside it is relabelled, every
 * other failure and defect passes through untouched.
 */
export const relabel =
  (operation: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.catchIf(self, isStoreUnavailable, () =>
      Effect.fail(new StoreUnavailable({ operation })),
    );
