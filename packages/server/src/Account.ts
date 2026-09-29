// @awthaq/server — Account
//
// Shipping-gap map (.scratch/shipping-gaps), tickets 09/10. Handlers for
// `@awthaq/api`'s core `account` group, built against `AuthCoreApi`
// the same way `Session.SessionHandlers` is.

import { AuthCore, Api, AccountContract } from "@awthaq/api";
import { AuthEvents, DataExport, Erasure, RateLimits, UserFields, Users } from "@awthaq/core";
import { RateLimiter } from "@awthaq/ports";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { currentUser } from "./internal/CurrentUser.ts";
import { HandlerInvariantViolation } from "./internal/Defects.ts";
import { expireSessionCookie } from "./internal/SessionCookie.ts";

/**
 * The principal an `account` handler runs as. Also keeps `@awthaq/api`'s
 * `Authentication`/`CsrfProtection` middleware nameable for declaration
 * emit — `AccountHandlers`'s inferred type mentions them, and TS2883 fires
 * when this file holds no reference to that module.
 */
export type AccountPrincipal = Api.UserPrincipal;

/** FAMS-002: exhaustive over `Users.UserIdentity`; `phone` is an `E164` string on the wire. */
const identityDto = (identity: Users.UserIdentity): AccountContract.IdentityDto => {
  switch (identity._tag) {
    case "Email":
      return { _tag: "Email", email: identity.email, emailVerified: identity.emailVerified };
    case "Phone":
      return { _tag: "Phone", phone: identity.phone, phoneVerified: identity.phoneVerified };
    case "Anonymous":
      return { _tag: "Anonymous" };
  }
};

const toDto = (user: Users.UserRecord, fields: UserFields.Values): AccountContract.AccountDto =>
  new AccountContract.AccountDto({
    id: user.id,
    identity: identityDto(user.identity),
    name: user.name,
    image: Option.getOrNull(user.image),
    fields,
  });

/** Reading every plugin's store is the costliest thing an account can ask for; a person needs it rarely. */
const EXPORT_RATE_LIMIT = { limit: 5, window: Duration.hours(1) } as const;

export const AccountHandlers = HttpApiBuilder.group(
  AuthCore.AuthCoreApi,
  "account",
  Effect.fnUntraced(function* (handlers) {
    const users = yield* Users.Users;
    const erasure = yield* Erasure.AccountErasure;
    const dataExport = yield* DataExport.AccountExport;
    const limiter = yield* RateLimiter.RateLimiter;
    const events = yield* AuthEvents.AuthEvents;
    // SAM-004: a composition that declares no user field answers `fields: {}` without a query.
    const declared = yield* UserFields.UserFieldRegistry;

    return handlers.handleAll({
      updateProfile: Effect.fnUntraced(function* ({
        payload,
      }: {
        payload: AccountContract.UpdateProfilePayload;
      }) {
        const { userId } = yield* currentUser;
        // The token was validated at authentication time; the user it
        // names must still exist — a `UserNotFound` here is a defect, not
        // a request-level condition the caller can act on.
        const missing = () =>
          Effect.die(
            new HandlerInvariantViolation({
              invariant: "AuthenticatedUserMissing",
              message: `awthaq: authenticated user missing: ${userId}`,
            }),
          );
        // SAM-004/BEH-EA-048: declared fields first, as `source: "client"` — validated and gated as a
        // whole before anything is stored, so a refused field leaves the profile untouched too. Only
        // the fields their plugin left `clientWritable` are accepted.
        const requested = payload.fields === undefined ? {} : payload.fields;
        const written =
          Object.keys(requested).length === 0
            ? Option.none<UserFields.Values>()
            : Option.some(
                yield* users
                  .setFields(userId, requested, { source: "client" })
                  .pipe(Effect.catchTag("UserNotFound", missing)),
              );
        const updated = yield* users
          .updateProfile(userId, { name: payload.name, image: payload.image })
          .pipe(Effect.catchTag("UserNotFound", missing));
        const fields = Option.isSome(written)
          ? written.value
          : declared.size === 0
            ? {}
            : yield* users.getFields(userId).pipe(
                Effect.catchTag("UserNotFound", missing),
                // A key the registry itself listed cannot be undeclared.
                Effect.catchTag("UnknownUserField", Effect.die),
              );
        return toDto(updated, fields);
      }),

      // Deletes the caller's own account. The cascade itself — every registered
      // plugin's erasure, the core rows (accounts, sessions, verification tokens, the
      // user), the audit pseudonymization, all in one transaction, and the
      // `BeforeUserDelete` veto before any of it — is core's `AccountErasure`
      // (CSG-001/DRS-002, wayfinder ticket 30), so an admin console or a CLI runs the
      // same guaranteed-complete cascade; this handler is only the HTTP edge.
      deleteUser: Effect.fnUntraced(function* () {
        const { userId } = yield* currentUser;
        yield* erasure.eraseAccount(userId, { deletedBy: "self" }).pipe(
          // `@awthaq/api` (the contract stratum) sits below core and cannot name core's
          // `HookAborted`, so the endpoint declares no error for a `BeforeUserDelete` veto
          // (a legal hold): as before this refactor, it surfaces as a server defect.
          Effect.catchTag("HookAborted", Effect.die),
          Effect.catchTag("UserNotFound", () =>
            Effect.die(
              new HandlerInvariantViolation({
                invariant: "AuthenticatedUserMissing",
                message: `awthaq: authenticated user missing: ${userId}`,
              }),
            ),
          ),
        );
        // CSS-002: the account (and this request's own session) is gone, so
        // the browser's now-dead cookie is expired with the response.
        yield* expireSessionCookie;
      }),

      // CSG-005 (GDPR Art. 15/20): the caller's own data as one downloadable JSON document.
      // Core's `AccountExport` assembles it (core sections plus every plugin's registered
      // section); this is the HTTP edge: a per-user rate limit (the export reads every
      // store), and headers that keep the document out of caches and name the download.
      exportData: Effect.fnUntraced(function* () {
        const { userId } = yield* currentUser;
        yield* RateLimits.enforce({
          key: `account:export:${userId}`,
          limit: EXPORT_RATE_LIMIT.limit,
          window: EXPORT_RATE_LIMIT.window,
          meta: {
            group: "account",
            endpoint: "exportData",
            rule: "exportData",
            dimension: "principal",
          },
        }).pipe(
          Effect.provideService(RateLimiter.RateLimiter, limiter),
          Effect.provideService(AuthEvents.AuthEvents, events),
          Effect.catchTag("RateLimitExceeded", (error) =>
            Effect.fail(new Api.RateLimited({ retryAfterMillis: error.retryAfterMillis })),
          ),
        );
        const document = yield* dataExport.exportAccount(userId, { requestedBy: "self" }).pipe(
          Effect.catchTag("UserNotFound", () =>
            Effect.die(
              new HandlerInvariantViolation({
                invariant: "AuthenticatedUserMissing",
                message: `awthaq: authenticated user missing: ${userId}`,
              }),
            ),
          ),
        );
        yield* HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(
            HttpServerResponse.setHeaders(response, {
              "content-disposition": 'attachment; filename="account-export.json"',
              "cache-control": "no-store",
            }),
          ),
        );
        return new AccountContract.AccountExportDto(document);
      }),
    });
  }),
);
