// @awthaq/server — internal Presented
//
// BEH-EA-065 through BEH-EA-072: what a request presents and the tiers, one of the internal modules behind `Credentials.ts`.

import { SessionCookie } from "@awthaq/core";
import { Api } from "@awthaq/api";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Headers from "effect/http/Headers";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import type * as HttpApiSecurity from "effect/http-api/HttpApiSecurity";

// ---- what a request presents ----------------------------------------------------------------------------

/** APS-006/OCM-002: every credential carrier an awthaq middleware declares. */
export type Carrier = "impersonation" | "cookie" | "apiKey" | "bearer";
/** The carriers that resolve to a session row (and so can rotate). */
export type SessionCarrier = "impersonation" | "cookie" | "bearer";

const isCarrier = (key: string): key is Carrier =>
  key === "impersonation" || key === "cookie" || key === "apiKey" || key === "bearer";

/** What one request presents. An absent or empty value is `None` (BEH-EA-065: an empty credential never resolves). */
export type Presented = { readonly [K in Carrier]: Option.Option<Redacted.Redacted<string>> };

/** How an adapter exposes its request: a parsed cookie lookup and a case-insensitive header lookup. */
export interface Source {
  readonly cookie: (name: string) => string | undefined;
  readonly header: (name: string) => string | undefined;
}

const nonEmpty = (value: string | undefined) =>
  value === undefined || value === ""
    ? Option.none<Redacted.Redacted<string>>()
    : Option.some(Redacted.make(value));

/** RFC 9110 §11.1, identical to `HttpApiBuilder.securityDecode(Api.BearerToken)` (pinned by the parsing tests). */
const bearerCredential = (authorization: string | undefined) => {
  const scheme = "bearer";
  if (
    authorization === undefined ||
    authorization.length <= scheme.length ||
    authorization.charCodeAt(scheme.length) !== 32 ||
    authorization.slice(0, scheme.length).toLowerCase() !== scheme
  ) {
    return undefined;
  }
  const credential = authorization.slice(scheme.length + 1).replace(/^ +/, "");
  return credential === "" ? undefined : credential;
};

/**
 * IC-007: reads every carrier, the cookie names from the ambient `SessionCookieConfig`. The one reader:
 * no adapter names a cookie or a header itself.
 */
export const presented = Effect.fnUntraced(function* (source: Source) {
  const config = yield* SessionCookie.SessionCookieConfig;
  return {
    impersonation: nonEmpty(source.cookie(SessionCookie.cookieName(config, "impersonation"))),
    cookie: nonEmpty(source.cookie(SessionCookie.cookieName(config, "session"))),
    apiKey: nonEmpty(source.header(Api.API_KEY_HEADER_NAME)),
    bearer: nonEmpty(bearerCredential(source.header("authorization"))),
  } satisfies Presented;
});

/** The HTTP source: Effect's parsed cookies (the same map `HttpApiSecurity.apiKey({ in: "cookie" })` decodes). */
export const fromRequest = (request: HttpServerRequest.HttpServerRequest) =>
  presented({
    cookie: (name) => request.cookies[name],
    header: (name) => Option.getOrUndefined(Headers.get(request.headers, name)),
  });

// ---- tiers ----------------------------------------------------------------------------------------------

/** A tier: the carriers its declaration lists, in declaration order (BEH-EA-072), and the principals it admits. */
export interface Tier<P extends Api.Principal> {
  readonly carriers: ReadonlyArray<Carrier>;
  readonly admits: (principal: Api.Principal) => principal is P;
}

export const tier = <P extends Api.Principal>(
  declaration: {
    readonly security: Readonly<Record<string, HttpApiSecurity.HttpApiSecurity>>;
  },
  admits: (principal: Api.Principal) => principal is P,
) => ({ carriers: Record.keys(declaration.security).filter(isCarrier), admits }) satisfies Tier<P>;

const isUser = (principal: Api.Principal): principal is Api.UserPrincipal =>
  principal._tag === "User";
const isAny = (_principal: Api.Principal): _principal is Api.Principal => true;

/** OCM-002: the user tier admits a `User` only; the machine tier admits whatever a claimed credential resolves to. */
export const userTier = tier(Api.Authentication, isUser);
export const optionalTier = tier(Api.OptionalAuthentication, isUser);
export const machineTier = tier(Api.MachineAuthentication, isAny);
