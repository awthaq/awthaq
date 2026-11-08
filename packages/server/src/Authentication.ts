// @awthaq/server — Authentication middleware (the Path A adapter)
//
// spec/behaviors/09-authentication-middleware.md, BEH-EA-065 through BEH-EA-072.
// Implements the `Authentication`/`OptionalAuthentication` declarations from
// `@awthaq/api`'s `Api.ts` as an adapter over `Credentials` (ADR-EA-042), the one
// credential-resolution module: this file owns only what is Path A's own —
// one handler per declared scheme (Effect's security loop over the declaration is
// the chain), the post-auth hook, and the JR-007 challenge.

import { Sessions } from "@awthaq/core";
import { Api } from "@awthaq/api";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type { unhandled } from "effect/Types";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Credentials from "./Credentials.ts";

/**
 * `.scratch/jwt/spec.md`'s "Automatic response mirroring" decision (and
 * `.scratch/jwt/issues/02-mint-delivery-mechanism.md`'s own resolution): a
 * second overridable slot, mirroring `Credentials.PrincipalResolver` immediately
 * above — an application/plugin may decorate the response of any
 * successfully-authenticated request, without this middleware knowing or
 * caring who's listening. Defaults to a true identity no-op, so installing
 * a plugin that never overrides this reference (i.e. every plugin except
 * `@awthaq/jwt` today) changes nothing about existing behavior.
 * `decorate`'s own type — `Effect.Effect<HttpServerResponse>`, no error
 * channel — forces any override to handle its own failures internally
 * (e.g. minting a JWT must never be able to fail an otherwise-successful
 * response); this middleware never adds its own recovery for it.
 */
export interface PostAuthResponseHookShape {
  /**
   * PDR-003: `context.scheme` names the credential that authenticated the
   * request, so a hook can treat a cookie-authenticated browser request
   * differently from a bearer-authenticated API client (e.g. `@awthaq/jwt`'s
   * `mirrorResponses: "bearer"`). `"impersonation"` is a cookie-delivered
   * episode (`__Host-impersonation`), so a hook keyed on `"bearer"` treats it
   * like `"cookie"`.
   */
  readonly decorate: (
    principal: Api.Principal,
    response: HttpServerResponse.HttpServerResponse,
    context: { readonly scheme: Credentials.Carrier },
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
}

export const PostAuthResponseHook = Context.Reference<PostAuthResponseHookShape>(
  "awthaq/server/PostAuthResponseHook",
  { defaultValue: () => ({ decorate: (_principal, response) => Effect.succeed(response) }) },
);

/**
 * Serves `httpEffect` as `principal` and runs the post-auth hook. Shared by the
 * session path and the claimed-credential path. `PostAuthResponseHook` is
 * resolved here, per request, not captured at layer-build time: a plugin
 * overriding it (e.g. `@awthaq/jwt`) may itself need `Api.Authentication` for
 * its own endpoints, which would make capturing it in THIS layer an
 * unresolvable circular build order.
 */
const serve = (
  scheme: Credentials.Carrier,
  httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, unhandled, Api.CurrentPrincipal>,
  principal: Api.Principal,
) =>
  Effect.provideService(httpEffect, Api.CurrentPrincipal, principal).pipe(
    Effect.annotateLogs(Credentials.principalFields(principal)),
    Effect.flatMap((response) =>
      Effect.flatMap(PostAuthResponseHook, (hook) =>
        hook.decorate(principal, response, { scheme }),
      ),
    ),
  );

/** JR-007: the `realm` of every `WWW-Authenticate` challenge this middleware emits. */
const CHALLENGE_REALM = "awthaq";

type Handler = HttpApiMiddleware.HttpApiMiddlewareSecurity<
  typeof Api.MachineAuthentication.security,
  Api.CurrentPrincipal,
  typeof Api.Unauthenticated | typeof Api.StoreUnavailable,
  Api.AuthRequestContext
>["cookie"];

/**
 * BEH-EA-065 through 067/070/072: one handler per declared scheme, each running exactly one
 * carrier through `Credentials.step`; Effect's security loop over the declaration is the chain
 * (it falls through to the next scheme on any typed failure and answers with the last one's).
 * A handler that ran the whole chain would ignore its declaration (REQ-EA-203 redeclares it).
 * A rotating `verify` hands its delivery to the request itself (PIL-005, `Credentials.httpScope`),
 * and the per-request `PostAuthResponseHook` rides `serve`.
 */
const tierHandlers = <P extends Api.Principal>(tier: Credentials.Tier<P>) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials.make;
    const handler =
      (carrier: Credentials.Carrier): Handler =>
      (httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const presented = yield* Credentials.fromRequest(request);
          const resolved = yield* credentials.step(
            carrier,
            presented,
            tier,
            Credentials.httpScope(request, yield* Api.AuthRequestContext),
          );
          return yield* serve(resolved.carrier, httpEffect, resolved.principal);
        });
    // JR-007: `bearer` is the last declared scheme, so an `Unauthenticated` here is the middleware's
    // final failure — answer it with an RFC 7235/6750 challenge alongside the unchanged typed JSON
    // body. `invalid_token` only when a bearer credential was actually presented; otherwise the bare
    // realm challenge (RFC 6750 §3.1: an absent credential carries no error code). A handler's own
    // errors reach here wrapped, never as `Unauthenticated`, so they get none.
    const bearer: Handler = (httpEffect, options) =>
      handler("bearer")(httpEffect, options).pipe(
        Effect.tapError((error) =>
          Predicate.isTagged(error, "Unauthenticated")
            ? Effect.gen(function* () {
                const request = yield* HttpServerRequest.HttpServerRequest;
                const presented = yield* Credentials.fromRequest(request);
                yield* HttpEffect.appendPreResponseHandler((_request, response) =>
                  Effect.succeed(
                    response.status === 401
                      ? HttpServerResponse.setHeader(
                          response,
                          "www-authenticate",
                          Option.isNone(presented.bearer)
                            ? `Bearer realm="${CHALLENGE_REALM}"`
                            : `Bearer realm="${CHALLENGE_REALM}", error="invalid_token"`,
                        )
                      : response,
                  ),
                );
              })
            : Effect.void,
        ),
      );
    return {
      impersonation: handler("impersonation"),
      cookie: handler("cookie"),
      apiKey: handler("apiKey"),
      bearer,
    };
  });

export const AuthenticationLive: Layer.Layer<
  Api.Authentication,
  never,
  Sessions.Sessions | Credentials.PrincipalResolver
> = Layer.effect(
  Api.Authentication,
  Effect.map(tierHandlers(Credentials.userTier), ({ impersonation, cookie, bearer }) => ({
    impersonation,
    cookie,
    bearer,
  })),
);

/**
 * OCM-002/MAPS-003: the machine tier — `AuthenticationLive`'s chain plus the
 * `x-api-key` carrier, admitting `ApiKey`/`Service` principals that plugins'
 * credential resolvers produce. Provide it next to `AuthenticationLive`.
 */
export const MachineAuthenticationLive: Layer.Layer<
  Api.MachineAuthentication,
  never,
  Sessions.Sessions | Credentials.PrincipalResolver
> = Layer.effect(Api.MachineAuthentication, tierHandlers(Credentials.machineTier));

/**
 * AR-003: the default admin-tier scheme is `Authentication` itself — the identical
 * handlers behind a second tag, so declaring the admin groups behind
 * `Api.AdminAuthentication` changes nothing for a co-hosted deployment. Override this
 * layer (provide your own `Api.AdminAuthentication`) to put the admin surface behind a
 * different credential; a deployment that serves only `adminApi` and overrides it needs
 * no `Api.Authentication` at all.
 */
export const AdminAuthenticationLive: Layer.Layer<
  Api.AdminAuthentication,
  never,
  Api.Authentication
> = Layer.effect(
  Api.AdminAuthentication,
  Effect.gen(function* () {
    return yield* Api.Authentication;
  }),
);

/**
 * BEH-EA-068/029/EHA-006: `Api.OptionalAuthentication` declares no error type, so no handler may fail
 * with `Unauthenticated`: every handler runs the whole optional chain (`Credentials.resolve` over the
 * declaration: impersonation cookie, session cookie, bearer) and falls back to `anonymousPrincipal`.
 * The anonymous fallback is a *recovery* from resolution failure, never a success `resolve` produced:
 * `PostAuthResponseHook` is only ever consulted on the genuine success path, so an anonymous caller
 * never gets a decorated (e.g. `@awthaq/jwt`-minted) response. A store outage is not "no credential":
 * it stays `StoreUnavailable` (MA-004).
 */
export const OptionalAuthenticationLive: Layer.Layer<
  Api.OptionalAuthentication,
  never,
  Sessions.Sessions | Credentials.PrincipalResolver
> = Layer.effect(
  Api.OptionalAuthentication,
  Effect.gen(function* () {
    const credentials = yield* Credentials.make;
    const handler: HttpApiMiddleware.HttpApiMiddlewareSecurity<
      typeof Api.OptionalAuthentication.security,
      Api.CurrentPrincipal,
      typeof Api.StoreUnavailable,
      Api.AuthRequestContext
    >["cookie"] = (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const presented = yield* Credentials.fromRequest(request);
        const resolved = yield* credentials
          .resolve(
            presented,
            Credentials.optionalTier,
            Credentials.httpScope(request, yield* Api.AuthRequestContext),
          )
          .pipe(
            Effect.map(Option.some),
            Effect.catchTag("Unauthenticated", () => Effect.succeedNone),
          );
        if (Option.isNone(resolved)) {
          return yield* Effect.provideService(
            httpEffect,
            Api.CurrentPrincipal,
            Api.anonymousPrincipal,
          );
        }
        return yield* serve(resolved.value.carrier, httpEffect, resolved.value.principal);
      });
    return { impersonation: handler, cookie: handler, bearer: handler };
  }),
);
