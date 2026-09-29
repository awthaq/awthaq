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

import { Api } from "@awthaq/api";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { SqlError } from "effect/unstable/sql/SqlError";

export const StoreUnavailable = Api.StoreUnavailable;
export type StoreUnavailable = Api.StoreUnavailable;

/**
 * The recovery for an infrastructure failure at a service boundary: log the cause once (the
 * `SqlError`/`PlatformError` itself, never a bucket key or a credential) and fail with the typed
 * `StoreUnavailable` naming the operation. Use as a `catchTag`/`catchTags` handler:
 * `Effect.catchTag("SqlError", storeUnavailable("Sessions.verify"))`.
 */
export const storeUnavailable = (operation: string) => (cause: unknown) =>
  Effect.logWarning("awthaq: store unavailable", operation, cause).pipe(
    Effect.andThen(Effect.fail(new StoreUnavailable({ operation }))),
  );

/**
 * A repository call with nothing else to recover from: an outage is `StoreUnavailable`, a row that
 * no longer decodes (`SchemaError`) is a defect. Use it where the effect's `E` is exactly the
 * repository's `SqlError | SchemaError`; where a domain outcome shares the `catchTags`, map
 * `SqlError: storeUnavailable(operation)` and `SchemaError: Effect.die` beside it instead.
 */
export const orStoreUnavailable =
  (operation: string) =>
  <A, R>(self: Effect.Effect<A, SqlError | Schema.SchemaError, R>) =>
    self.pipe(
      Effect.catchTags({
        SqlError: storeUnavailable(operation),
        SchemaError: Effect.die,
      }),
    );
