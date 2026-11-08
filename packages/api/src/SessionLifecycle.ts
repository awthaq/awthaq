// @awthaq/api — SessionLifecycle (ADR-EA-045, BEH-EA-343)
//
// "This endpoint mints (or rotates, ends, swaps) the caller's session" is a fact about the contract, so the
// contract states it: an endpoint declares one of five `HttpApiMiddleware` markers. A middleware rather than
// an endpoint annotation, because a middleware is both typed (it sits in the endpoint's type, and what it
// `provides` is removed from the handler's requirements) and reflectable (`HttpApi.reflect` hands it to the
// server, the generated clients and the OpenAPI generator). An annotation is only the second:
// `HttpApiEndpoint.annotations` is `Context.Context<never>`, so no compile-time check can read it.
//
// Four readers then share the one declaration:
//
// - `@awthaq/server`'s half of the markers resolves `X-Awthaq-Token-Delivery` before the handler runs,
//   provides a grant (`MintGrant`, `EndGrant`, `SwapGrant`) that every `SessionDelivery` function requires,
//   marks the response `no-store`, and dies if a successful response neither delivered nor declined.
// - A bearer client follows the headers every declared response carries (`set-auth-token`,
//   `x-awthaq-session-ended`); it needs no knowledge of which endpoint did what.
// - `@awthaq/react` installs a client half that refetches the session after a declared mutation.
// - `openApi` documents the lifecycle and its headers for exactly the declared operations.
//
// None of the five sets `requiredForClient`: a client that does not care (a cookie browser client, the CLI)
// needs nothing new.

import type * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as HttpApi from "effect/http-api/HttpApi";
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import { InvalidTokenDelivery, ROTATED_TOKEN_HEADER, SESSION_ENDED_HEADER } from "./Api.ts";

export { SESSION_ENDED_HEADER } from "./Api.ts";

/** What a successful response of the endpoint does to the caller's own session. */
export type Kind = "mints" | "rotates" | "ends" | "swaps" | "refreshes";

/** How the request asked for a fresh credential (`X-Awthaq-Token-Delivery`), resolved before the handler runs. */
export type Delivery = "cookie" | "bearer";

/** How a declared response settled its declaration. */
export type Outcome = "delivered" | "declined";

/**
 * The capability a declared endpoint's handler receives. `settle` is called by `@awthaq/server`'s
 * `SessionDelivery` only: "delivered" when it wrote the credential change, "declined" when this response
 * deliberately changes nothing (a concealed sign-up, an OAuth account link, revoking another device).
 */
export interface GrantShape {
  readonly kind: Kind;
  readonly delivery: Delivery;
  readonly settle: (outcome: Outcome) => Effect.Effect<void>;
}

/** Provided to a `Mints`/`Rotates` handler: it may issue a session through `SessionDelivery`. */
export class MintGrant extends Context.Service<MintGrant, GrantShape>()(
  "awthaq/api/SessionLifecycle/MintGrant",
) {}
/** Provided to an `Ends` handler: it may end the caller's own session through `SessionDelivery.end`. */
export class EndGrant extends Context.Service<EndGrant, GrantShape>()(
  "awthaq/api/SessionLifecycle/EndGrant",
) {}
/** Provided to a `Swaps` handler: it may swap the presented credential (`SessionDelivery.swapIn`/`swapOut`). */
export class SwapGrant extends Context.Service<SwapGrant, GrantShape>()(
  "awthaq/api/SessionLifecycle/SwapGrant",
) {}

/** Sign-up, sign-in, a second factor, a federated callback, a device or native exchange. */
export class Mints extends HttpApiMiddleware.Service<Mints, { provides: MintGrant }>()(
  "awthaq/api/SessionLifecycle/Mints",
  { error: InvalidTokenDelivery },
) {}
/** The caller's credential is replaced by a fresh one (`changePassword`, BEH-EA-053). */
export class Rotates extends HttpApiMiddleware.Service<Rotates, { provides: MintGrant }>()(
  "awthaq/api/SessionLifecycle/Rotates",
  { error: InvalidTokenDelivery },
) {}
/** The caller's own session ends (sign-out, revoke-all, account deletion, SP-initiated SAML logout). */
export class Ends extends HttpApiMiddleware.Service<Ends, { provides: EndGrant }>()(
  "awthaq/api/SessionLifecycle/Ends",
) {}
/** The presented credential changes to another session and back (impersonation, APS-006). Cookie only. */
export class Swaps extends HttpApiMiddleware.Service<Swaps, { provides: SwapGrant }>()(
  "awthaq/api/SessionLifecycle/Swaps",
  { error: InvalidTokenDelivery },
) {}
/** The session's view or subject changes, the credential does not (re-authentication, active organization, a new membership). */
export class Refreshes extends HttpApiMiddleware.Service<Refreshes>()(
  "awthaq/api/SessionLifecycle/Refreshes",
) {}

const byKey: ReadonlyMap<string, Kind> = new Map<string, Kind>([
  [Mints.key, "mints"],
  [Rotates.key, "rotates"],
  [Ends.key, "ends"],
  [Swaps.key, "swaps"],
  [Refreshes.key, "refreshes"],
]);

const kindsOf = (middleware: Iterable<{ readonly key: string }>) =>
  [...middleware].flatMap((service) => {
    const kind = byKey.get(service.key);
    return kind === undefined ? [] : [kind];
  });

/** The declared kind among an endpoint's middleware, if any. */
export const kindOf = (middleware: Iterable<{ readonly key: string }>): Kind | undefined =>
  kindsOf(middleware)[0];

/**
 * BEH-EA-343: every declared endpoint of `api`, keyed by its default OpenAPI `operationId`
 * (`group.endpoint`, or `endpoint` for a top-level group). Throws, at composition time, on an endpoint
 * declaring two kinds.
 */
export const inventory = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
): ReadonlyMap<string, Kind> => {
  const declared = new Map<string, Kind>();
  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ group, endpoint, middleware }) => {
      const kinds = kindsOf(middleware);
      const id = group.topLevel
        ? endpoint.identifier
        : `${group.identifier}.${endpoint.identifier}`;
      if (kinds.length > 1) {
        throw new Error(
          `awthaq: ${id} declares more than one session lifecycle (${kinds.join(", ")})`,
        );
      }
      const [kind] = kinds;
      if (kind !== undefined) declared.set(id, kind);
    },
  });
  return declared;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const recordsOf = (value: unknown) =>
  isRecord(value)
    ? Object.entries(value).flatMap(([key, entry]) =>
        isRecord(entry) ? [[key, entry] as const] : [],
      )
    : [];

const noStore = { schema: { type: "string", enum: ["no-store"] } };

const responseHeaders = (kind: Kind, status: string) => {
  const success = status.startsWith("2");
  return {
    "Cache-Control": noStore,
    ...(success && (kind === "mints" || kind === "rotates")
      ? {
          [ROTATED_TOKEN_HEADER]: {
            description: "The session token, when the request asked for bearer delivery",
            schema: { type: "string" },
          },
        }
      : {}),
    ...(success && kind === "ends"
      ? {
          [SESSION_ENDED_HEADER]: {
            description: "The caller's own session ended: a bearer client forgets its token",
            schema: { type: "string", enum: ["1"] },
          },
        }
      : {}),
  };
};

/**
 * ADR-EA-045: an `OpenApi.Transform` documenting what each declared operation does to the session
 * (`x-awthaq-session`) and the headers its responses carry. `Auth.make` annotates the composed api with it.
 */
export const openApi =
  (declared: ReadonlyMap<string, Kind>) =>
  (spec: Record<string, unknown>): Record<string, unknown> => {
    for (const [, methods] of recordsOf(spec["paths"])) {
      for (const [, operation] of recordsOf(methods)) {
        const operationId = operation["operationId"];
        const kind = typeof operationId === "string" ? declared.get(operationId) : undefined;
        if (kind === undefined) continue;
        operation["x-awthaq-session"] = kind;
        if (kind === "refreshes") continue;
        for (const [status, response] of recordsOf(operation["responses"])) {
          response["headers"] = {
            ...(isRecord(response["headers"]) ? response["headers"] : {}),
            ...responseHeaders(kind, status),
          };
        }
      }
    }
    return spec;
  };
