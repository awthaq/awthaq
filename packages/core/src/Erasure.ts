// @awthaq/core — Erasure
//
// CSG-001/DRS-002/SEA-001 (.issues/high), wayfinder ticket 30 — GDPR Art. 17.
// "Erase this user everywhere" is something *every plugin that stores personal
// data* must take part in, and a plugin's failure to erase its own rows must
// abort the whole erasure, not be swallowed — the opposite of an observe hook
// (BEH-EA-092), so this is not an `AuthEvents` subscription or an observe tap.
// It is an aggregating registry (ADR-EA-012): each plugin contributes its own
// erasure, ordered by declared `order` then id, frozen at first read.
//
// The type system carries the guarantee (ADR-EA-030's principle): a plugin's
// `contribute` layer *requires* `ErasureRegistry`, so a composition that installs
// a plugin holding personal data without providing the registry does not
// compile — erasure is no longer something a host has to remember to opt in to.
//
// `AccountErasure.eraseAccount` is the domain service the HTTP handler used to
// inline, so any caller (an admin console, a CLI, a retention job) invokes the
// same guaranteed-complete cascade:
//
//   1. the `BeforeUserDelete` veto runs FIRST (a legal hold, an ownership
//      transfer requirement) — before anything is touched, so a composition
//      with no real transaction (`SqlTransaction.layerNoop`, in memory) is never
//      left half-erased by a veto. `Users.delete` consults the point again at the
//      end; a veto tap must therefore be idempotent (a pure check is);
//   2. inside one `SqlTransaction`: every registered contribution, then the
//      core rows (accounts, sessions, verification tokens, the user row), then —
//      last, so nothing published above can re-introduce the id — the audit
//      pseudonymization (`AuditLog.pseudonymizeActor`, ESA-005);
//   3. only after commit: `auth.user.deleted` (SCP-006) — a rolled-back erasure
//      publishes nothing.
//
// FK-less by design (SEA-001): no table carries a FOREIGN KEY to `users`, so a
// database-level cascade cannot do this job and does not exist. Erasure is
// hook-and-registry driven across plugins (spec/behaviors/12-hooks.md, BEH-EA-095)
// and transactional (`SqlTransaction`), which `AccountErasure.test.ts` proves by
// rolling back a failing contribution.
//
// `admin_impersonation` (and its hash-chained ledger) is NOT erased or
// pseudonymized: it is the tamper-evident record of who accessed whose account
// (ALF-005), protected by database triggers on purpose, and its chain payload
// embeds the ids it would have to rewrite. It is retained under the legal-
// obligation basis (GDPR Art. 17(3)(b)/(e), SOC 2 access-review) and documented
// as such in ADR-EA-033; a ledger designed to survive erasure (identifiers
// replaced by per-user keyed digests) is the follow-up.

import { SqlTransaction } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Accounts } from "./Accounts.ts";
import { AuditLog } from "./AuditLog.ts";
import { AuthEvents } from "./AuthEvents.ts";
import * as HookPoint from "./HookPoint.ts";
import type { StoreUnavailable } from "./Errors.ts";
import { ErasureRegistry, type ErasureSubject } from "./ErasureRegistry.ts";
import * as Hooks from "./Hooks.ts";
import { Sessions } from "./Sessions.ts";
import { Users, emailOf, type UserId, type UserNotFound } from "./Users.ts";
import { Verification } from "./Verification.ts";

export * from "./ErasureRegistry.ts";

export interface ErasureConfigShape {
  /**
   * What happens to the durable audit rows that name the erased user: `"pseudonymize"`
   * (default — the actor id and identifier fields become a fresh alias and free-text
   * fields are blanked, keeping the forensic timeline: `AuditLog.pseudonymizeActor`),
   * or `"retain"` (keep them unchanged under a documented Art. 17(3)(b)/(e)
   * legal-obligation exemption — a deployment's own policy decision).
   */
  readonly auditLog: "pseudonymize" | "retain";
}

export const ErasureConfig = Context.Reference<ErasureConfigShape>("awthaq/core/ErasureConfig", {
  defaultValue: () => ({ auditLog: "pseudonymize" }),
});

export const config = (partial: Partial<ErasureConfigShape>) =>
  Layer.succeed(ErasureConfig, { auditLog: "pseudonymize", ...partial });

export interface AccountErasureShape {
  /**
   * Erases `userId` everywhere (see the module header for the order). Fails
   * `UserNotFound` for an unknown user and `HookAborted` when a
   * `BeforeUserDelete` tap vetoes; anything else dies and rolls back.
   */
  readonly eraseAccount: (
    userId: UserId,
    options?: { readonly deletedBy?: "self" | "admin" },
  ) => Effect.Effect<void, UserNotFound | HookPoint.HookAborted | StoreUnavailable>;
}

export class AccountErasure extends Context.Service<AccountErasure, AccountErasureShape>()(
  "awthaq/core/AccountErasure",
) {}

export const layer = Layer.effect(
  AccountErasure,
  Effect.gen(function* () {
    const users = yield* Users;
    const accounts = yield* Accounts;
    const sessions = yield* Sessions;
    const verification = yield* Verification;
    const auditLog = yield* AuditLog;
    const events = yield* AuthEvents;
    const registry = yield* ErasureRegistry;
    const sqlTransaction = yield* SqlTransaction.SqlTransaction;
    const beforeDelete = yield* Hooks.BeforeUserDelete;
    const { auditLog: auditPolicy } = yield* ErasureConfig;

    const eraseAccount: AccountErasureShape["eraseAccount"] = (userId, options) =>
      Effect.gen(function* () {
        const user = yield* users.findById(userId);
        // FAMS-002: only an email-identity user has an address to sweep rows keyed by one.
        const email = Option.getOrUndefined(emailOf(user));
        const subject: ErasureSubject = email === undefined ? { userId } : { userId, email };
        // Veto first: nothing has been touched yet (see the module header).
        yield* HookPoint.aborted(Hooks.BeforeUserDelete)(
          beforeDelete.run(email === undefined ? { id: userId } : { id: userId, email }),
        );
        const contributions = yield* registry.contributions;
        yield* sqlTransaction
          .withTransaction(
            Effect.gen(function* () {
              for (const contribution of contributions) {
                yield* contribution.erase(subject);
              }
              yield* accounts.deleteAllByUser(userId);
              yield* sessions.revokeAll(userId, "userDeleted");
              yield* verification.deleteAllByUser(userId);
              yield* users.delete(userId);
              // Last: everything published above (the session revocation) is included.
              if (auditPolicy === "pseudonymize") yield* auditLog.pseudonymizeActor(userId);
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die));
        // Only a committed erasure is announced (SCP-006), and it carries no email.
        yield* events.publish({
          _tag: "auth.user.deleted",
          userId,
          deletedBy: options?.deletedBy ?? "self",
        });
      });

    return AccountErasure.of({ eraseAccount });
  }),
);
