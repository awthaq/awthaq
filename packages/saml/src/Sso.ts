// @awthaq/saml — Sso
//
// BEH-EA-308 (ADR-EA-023 Decision 4): the thin dispatcher in front of the two enterprise sign-in protocols. `Saml` and `OAuth` own
// their protocol routes; `Sso` only answers "where does this person sign in?": it routes an email domain (or an organization id)
// to an organization's OIDC/OAuth2 connection (`OrganizationConnectionStore`, `@awthaq/organization`) or to its SAML connection
// (`SamlConnectionStore`) and hands back the URL of the protocol plugin's own login route, which the browser then follows: the
// state cookies, the redirect and every check stay the owning plugin's.
//
// `POST /auth/sso/start { email | organizationId, callbackURL? }` -> `{ protocol, connectionId, organizationId, loginUrl }`.
// When BOTH protocols route the same hint (the same domain claimed by an OIDC connection and a SAML one), the configured
// `preferred` protocol wins (default `saml`) and `Sso.discoverAll` lists every match, so the conflict is visible rather than
// silently resolved. Nothing routing to a connection is one uniform `SsoNotFound`, whatever the reason (no such domain, no such
// organization, no hint at all); the endpoint is rate limited per source address because it does say whether a domain has SSO,
// which is what a "Sign in with SSO" button needs to know and what a scraper should not be able to sweep for.

import { Api } from "@awthaq/api";
import { AuthEvents, AuthPlugin, RateLimits } from "@awthaq/core";
import { OrganizationConnections } from "@awthaq/organization";
import { ClientAddress, RateLimiter } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as Saml from "./Saml.ts";
import * as SamlConfig from "./SamlConfig.ts";
import * as SamlConnections from "./SamlConnections.ts";

export type SsoProtocol = "saml" | "oidc";

/** Where an email or an organization routes: the connection, and the protocol plugin's login URL for it. */
export interface SsoRoute {
  readonly protocol: SsoProtocol;
  readonly connectionId: string;
  readonly organizationId: string;
  /** Relative to the application's origin: the protocol plugin's own login endpoint. */
  readonly loginUrl: string;
}

/** Nothing routes: uniformly, whatever the reason. */
export class SsoNotFound extends Schema.TaggedError<SsoNotFound>()(
  "SsoNotFound",
  {},
  { httpApiStatus: 404 },
) {}

const HintSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      value.length > 0 && value.length <= 320 ? undefined : "a hint of 1 to 320 characters",
    ),
  ),
);

export const StartPayload = Schema.Struct({
  email: Schema.optional(HintSchema),
  organizationId: Schema.optional(HintSchema),
  /** Forwarded to the protocol plugin, which resolves it against its own trusted origins. */
  callbackURL: Schema.optional(Schema.String),
});
export type StartPayload = typeof StartPayload.Type;

export class StartResponse extends Schema.Class<StartResponse>("SsoStartResponse")({
  protocol: Schema.Literals(["saml", "oidc"]),
  connectionId: Schema.String,
  organizationId: Schema.String,
  loginUrl: Schema.String,
}) {}

export const SsoGroup = HttpApiGroup.make("sso").add(
  HttpApiEndpoint.post("start", "/auth/sso/start", {
    payload: StartPayload,
    success: StartResponse,
    error: [SsoNotFound, Api.RateLimited],
  }),
);

export const SsoApi = HttpApi.make("auth").add(SsoGroup);

export interface SsoConfigShape {
  /** Which protocol wins when both route the same hint. Default `saml`. */
  readonly preferred: SsoProtocol;
}

const defaultSsoConfig: SsoConfigShape = { preferred: "saml" };

export const SsoConfig: Context.Reference<SsoConfigShape> = Context.Reference(
  "awthaq/saml/SsoConfig",
  {
    defaultValue: () => defaultSsoConfig,
  },
);

export const config = (partial: Partial<SsoConfigShape>) =>
  Layer.succeed(SsoConfig, { preferred: partial.preferred ?? "saml" });

export interface SsoShape {
  /** Every connection the hint routes to, across both protocols (the preferred protocol first). */
  readonly discoverAll: (hint: {
    readonly email?: string | undefined;
    readonly organizationId?: string | undefined;
    readonly callbackURL?: string | undefined;
  }) => Effect.Effect<ReadonlyArray<SsoRoute>>;
  /** The route the hint resolves to: the preferred protocol's, else the other's; `None` when nothing routes. */
  readonly discover: (hint: {
    readonly email?: string | undefined;
    readonly organizationId?: string | undefined;
    readonly callbackURL?: string | undefined;
  }) => Effect.Effect<Option.Option<SsoRoute>>;
  /** The HTTP operation: rate limited per source address, then `discover`. */
  readonly start: (
    input: StartPayload,
    ip: string | undefined,
  ) => Effect.Effect<SsoRoute, SsoNotFound | Api.RateLimited>;
}

const withCallback = (path: string, callbackURL: string | undefined, hasQuery: boolean) =>
  callbackURL === undefined
    ? path
    : `${path}${hasQuery ? "&" : "?"}callbackURL=${encodeURIComponent(callbackURL)}`;

export class Sso extends AuthPlugin.Service<Sso, SsoShape>()("sso", {
  apiVersion: 1,
  contract: SsoApi,
  tables: [],
  migrations: [],
}) {
  static readonly layer = AuthPlugin.layer(Sso, {
    dependsOn: [Saml.Saml],
    handlers: HttpApiBuilder.group(
      SsoApi,
      "sso",
      Effect.fnUntraced(function* (handlers) {
        const sso = yield* Sso;
        const clientAddress = yield* ClientAddress.ClientAddress;
        return handlers.handleAll({
          start: Effect.fnUntraced(function* ({
            payload,
            request,
          }: {
            payload: StartPayload;
            request: HttpServerRequest.HttpServerRequest;
          }) {
            const resolved = yield* clientAddress.resolve(request);
            const route = yield* sso.start(payload, Option.getOrUndefined(resolved));
            return new StartResponse(route);
          }),
        });
      }),
    ),
    make: Effect.gen(function* () {
      const saml = yield* SamlConnections.SamlConnectionStore;
      const oidc = yield* OrganizationConnections.OrganizationConnectionStore;
      const settings = yield* SamlConfig.SamlConfig;
      const preference = yield* SsoConfig;
      const events = yield* AuthEvents.AuthEvents;
      const limiter = yield* RateLimiter.RateLimiter;

      const samlRoute = (
        hint: { readonly email?: string | undefined; readonly organizationId?: string | undefined },
        callbackURL: string | undefined,
      ) =>
        saml.discover(hint).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: (connectionId) =>
                saml.get(connectionId).pipe(
                  Effect.map((connection) =>
                    Option.some<SsoRoute>({
                      protocol: "saml",
                      connectionId: connection.id,
                      organizationId: connection.organizationId,
                      loginUrl: withCallback(
                        `/auth/saml/login?connection=${encodeURIComponent(connection.id)}`,
                        callbackURL,
                        true,
                      ),
                    }),
                  ),
                  // Gone between the lookup and the read: nothing routes.
                  Effect.catchTag("SamlConnections/NotFound", () => Effect.succeedNone),
                ),
            }),
          ),
        );

      const oidcRoute = (
        hint: { readonly email?: string | undefined; readonly organizationId?: string | undefined },
        callbackURL: string | undefined,
      ) =>
        oidc.discover(hint).pipe(
          Effect.map(
            Option.flatMap((providerId) =>
              Option.map(OrganizationConnections.parseProviderId(providerId), (parsed) => {
                const route: SsoRoute = {
                  protocol: "oidc",
                  connectionId: parsed.connectionId,
                  organizationId: parsed.organizationId,
                  loginUrl: withCallback(
                    `/oauth/${encodeURIComponent(providerId)}/authorize`,
                    callbackURL,
                    false,
                  ),
                };
                return route;
              }),
            ),
          ),
        );

      const discoverAll: SsoShape["discoverAll"] = Effect.fnUntraced(function* (hint) {
        const scoped = { email: hint.email, organizationId: hint.organizationId };
        const [samlFound, oidcFound] = yield* Effect.all([
          samlRoute(scoped, hint.callbackURL),
          oidcRoute(scoped, hint.callbackURL),
        ]);
        const ordered =
          preference.preferred === "saml" ? [samlFound, oidcFound] : [oidcFound, samlFound];
        return ordered.flatMap((found) => (Option.isSome(found) ? [found.value] : []));
      });

      const discover: SsoShape["discover"] = (hint) =>
        Effect.map(discoverAll(hint), (routes) => Option.fromNullishOr(routes[0]));

      const start: SsoShape["start"] = Effect.fnUntraced(function* (input, ip) {
        yield* RateLimits.enforce({
          key: `sso:start:${ip ?? "unknown"}`,
          limit: settings.rateLimits.sso.limit,
          window: settings.rateLimits.sso.window,
          meta: { group: "sso", endpoint: "start", rule: "start", dimension: "ip" },
        }).pipe(
          Effect.provideService(RateLimiter.RateLimiter, limiter),
          Effect.provideService(AuthEvents.AuthEvents, events),
          Effect.catchTag(
            "RateLimitExceeded",
            (error) => new Api.RateLimited({ retryAfterMillis: error.retryAfterMillis }),
          ),
        );
        const found = yield* discover({
          email: input.email,
          organizationId: input.organizationId,
          callbackURL: input.callbackURL,
        });
        if (Option.isNone(found)) return yield* Effect.fail(new SsoNotFound());
        return found.value;
      });

      return Sso.of({ discoverAll, discover, start });
    }),
  });
}
