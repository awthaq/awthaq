// @awthaq/core — internal/erasureClearance
//
// ADR-EA-031 (rev 1.2): proof that `AccountErasure` consulted `Hooks.BeforeUserDelete` for one user
// and no tap vetoed. `UserRemoval.remove` takes nothing else, so the only way to delete a user row
// is to have passed the veto inside `AccountErasure`. Three locks, none an assertion:
//   - the ES-private field makes the class nominal: no object literal satisfies it;
//   - the constructor is private: `new` fails to compile outside the class;
//   - this module is not exported from the package barrel, and `Erasure.ts` re-exports the *type*
//     only, so code outside core cannot even reach `afterVeto`. Inside core,
//     `ErasureClearance.boundary.test.ts` pins `Erasure.ts` as the single value importer.
import type { Models as SqlModels } from "@awthaq/sql";
import * as Effect from "effect/Effect";

export class ErasureClearance {
  readonly #userId: SqlModels.UserId;

  private constructor(userId: SqlModels.UserId) {
    this.#userId = userId;
  }

  get userId() {
    return this.#userId;
  }

  /** The clearance for `userId`, issued only once `veto` has succeeded. */
  static afterVeto<A, E, R>(userId: SqlModels.UserId, veto: Effect.Effect<A, E, R>) {
    return veto.pipe(Effect.as(new ErasureClearance(userId)));
  }
}
