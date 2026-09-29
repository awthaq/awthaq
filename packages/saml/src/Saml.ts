// @awthaq/saml — Saml
//
// spec/behaviors/29-saml-sp.md, BEH-EA-238 through 245; spec/models/10-saml.md; ADR-EA-023. `Auth.make([Organization,
// Saml])` composes: `Saml` `dependsOn: [Organization]` — a SAML connection is an organization's own identity
// provider (the tenant model, ADR-EA-018), and a sign-in through it acts as that organization's tenant.
//
// The chain at `POST /auth/saml/acs`, cheap and structural before cryptography, every failure the SAME
// `SamlAssertionRejected` (the reason is logged and audited, never returned):
//
//    1. the request is bound to a browser: the `__Host-saml-request` cookie holds the state of a login THIS server
//       started (an unsolicited, IdP-initiated response has no cookie and is refused; so is a login-CSRF attempt that
//       posts an attacker's own valid response into a victim's browser);
//    2. size cap, before base64 is decoded and before any parse (BEH-EA-238);
//    3. the AuthnRequest id in that state is consumed, exactly once, and names the connection — the trust set is
//       chosen by what THIS server stored, never by anything inside the document (BEH-EA-241/244);
//    4. `XmlSignature.verify`: DOCTYPE/comments refused, exactly one Assertion, the signature covers the Assertion or
//       the Response containing it, allow-listed algorithms, pinned certificate within its window (BEH-EA-239/240);
//    5. the data is read ONLY from the signed bytes the port returned, then judged: issuer, audience, recipient,
//       destination, bearer confirmation answering THIS request id, bounded time window with skew (BEH-EA-241..243);
//    6. the assertion id is reserved once (a replay of a captured assertion fails even under a new request id);
//    7. the account is `(saml:<organizationId>:<connectionId>, NameID, issuer)` — never linked by email alone
//       (BEH-EA-245) — and `Users.assertCanSignIn` runs before a session exists.
//
// Beyond the ACS (each with its own behavior): signed AuthnRequests (BEH-EA-305), Single Logout in both directions
// (BEH-EA-306, `SamlSlo`), the administrator's connection CRUD (BEH-EA-309, `SamlAdmin`), and organization role mapping under a
// ceiling (BEH-EA-307, `SamlRoleMapping`). Not offered, by decision (spec/behaviors/29-saml-sp.md BEH-EA-244, ADR-EA-036):
// IdP-initiated LOGIN and encrypted assertions.

import { Api } from "@awthaq/api";
import {
  Accounts,
  AuthEvents,
  AuthPlugin,
  Errors,
  HookPoint,
  Hooks,
  Migrations,
  RateLimits,
  SessionCookie,
  Sessions,
  Tenant,
  Users,
  Verification,
} from "@awthaq/core";
import { ClientAddress, Defects, RateLimiter, SqlTransaction, XmlSignature } from "@awthaq/ports";
import { OrganizationRecords, Organization } from "@awthaq/organization";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SafeXml from "./SafeXml.ts";
import * as SamlAdmin from "./SamlAdmin.ts";
import * as SamlApi from "./SamlApi.ts";
import {
  AssertionInvalid,
  readAssertion,
  validateAssertion,
  type SignedAssertion,
} from "./SamlAssertion.ts";
import * as SamlConfig from "./SamlConfig.ts";
import { trustSetOf } from "./SamlConnections.ts";
import { authnRequestXml, redirectUrl, spMetadataXml } from "./SamlProtocol.ts";
import * as SamlRecords from "./SamlRecords.ts";
import * as SamlRoleMapping from "./SamlRoleMapping.ts";
import * as SamlSlo from "./SamlSlo.ts";
import * as SamlSpKeys from "./SamlSpKeys.ts";

export { SamlConfig, config } from "./SamlConfig.ts";
export type { SamlConfigShape, SamlConfigInput } from "./SamlConfig.ts";

export const REQUEST_COOKIE = "__Host-saml-request";
export const LOGOUT_COOKIE = SamlSlo.LOGOUT_COOKIE;
const REQUEST_PREFIX = "saml-request:";
const ASSERTION_PREFIX = "saml-assertion:";

/** The `providerId` accounts link under: `saml:<organizationId>:<connectionId>` (BEH-EA-245). */
export const providerIdOf = (organizationId: string, connectionId: string): string =>
  `saml:${organizationId}:${connectionId}`;

const RequestPayload = Schema.Struct({
  connectionId: Schema.String,
  requestId: Schema.String,
  callbackURL: Schema.String,
});
const decodeRequestPayload = Schema.decodeUnknownOption(RequestPayload);

type ServerError = Errors.StoreUnavailable;
type IssuedSession = Effect.Success<ReturnType<Sessions.SessionsShape["issue"]>>;

export interface SamlShape {
  /** BEH-EA-241: the SP metadata document for one connection. */
  readonly metadata: (
    connectionId: string,
  ) => Effect.Effect<string, SamlApi.SamlConnectionNotFound>;
  /** SP-initiated login: reserves the AuthnRequest id and returns the IdP redirect and the state the browser cookie must carry. */
  readonly authnRequest: (
    connectionId: string,
    input: { readonly callbackURL?: string | undefined; readonly ip?: string | undefined },
  ) => Effect.Effect<
    { readonly location: string; readonly state: Redacted.Redacted<string> },
    SamlApi.SamlConnectionNotFound | Api.RateLimited | ServerError
  >;
  /** The Assertion Consumer Service. `cookieState` is the value of the request cookie, if the browser sent one. */
  readonly acs: (input: {
    readonly samlResponse: string;
    readonly cookieState: string | undefined;
    readonly ip?: string | undefined;
    readonly userAgent?: string | undefined;
  }) => Effect.Effect<
    { readonly callbackURL: string; readonly session: IssuedSession },
    | SamlApi.SamlAssertionRejected
    | Users.UserSuspended
    | HookPoint.HookAborted
    | Hooks.TwoFactorRequired
    | Api.RateLimited
    | ServerError
  >;
  /**
   * BEH-EA-306: a Single Logout message delivered by the IdP's browser (a `LogoutRequest` to end sessions, or the
   * `LogoutResponse` to our own request); resolves to what the browser does next.
   */
  readonly slo: (
    input: SamlSlo.SloInput,
  ) => Effect.Effect<
    SamlSlo.SloOutcome,
    SamlApi.SamlLogoutRejected | Api.RateLimited | ServerError
  >;
  /** BEH-EA-306: the signed-in user's own SP-initiated logout: ends their session and, when the connection has a logout endpoint, sends the IdP a `LogoutRequest`. */
  readonly logout: (
    caller: Api.UserPrincipal,
    input: { readonly callbackURL?: string | undefined; readonly ip?: string | undefined },
  ) => Effect.Effect<SamlSlo.LogoutStart, ServerError>;
  /** BEH-EA-309: the administrator's operations (the `saml.admin` group). */
  readonly admin: SamlAdmin.SamlAdminShape;
}

// ---- migrations --------------------------------------------------------------------------------

const samlMigrations: Migrations.Migrations = [
  {
    name: "create_saml_connection",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE saml_connection (
            id TEXT PRIMARY KEY,
            "organizationId" TEXT NOT NULL,
            name TEXT NOT NULL,
            "idpEntityId" TEXT NOT NULL,
            "ssoUrl" TEXT NOT NULL,
            "idpCertificates" TEXT NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL,
            "updatedAt" TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE saml_connection (
            id TEXT PRIMARY KEY,
            "organizationId" TEXT NOT NULL,
            name TEXT NOT NULL,
            "idpEntityId" TEXT NOT NULL,
            "ssoUrl" TEXT NOT NULL,
            "idpCertificates" TEXT NOT NULL,
            "createdAt" TEXT NOT NULL,
            "updatedAt" TEXT NOT NULL
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
      yield* sql`CREATE INDEX saml_connection_organization_id ON saml_connection("organizationId")`;
    }),
  },
  {
    // BEH-EA-245: the connection-level "explicit linking policy" (default off).
    name: "add_saml_connection_trusts_email",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () =>
          sql`ALTER TABLE saml_connection ADD COLUMN "trustsEmail" BOOLEAN NOT NULL DEFAULT FALSE`,
        sqlite: () =>
          sql`ALTER TABLE saml_connection ADD COLUMN "trustsEmail" INTEGER NOT NULL DEFAULT 0`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  {
    // The domain is the primary key: an email domain routes to exactly one connection, as a database constraint.
    name: "create_saml_connection_domain",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE saml_connection_domain (
          domain TEXT PRIMARY KEY,
          "connectionId" TEXT NOT NULL
        )`;
      yield* sql`CREATE INDEX saml_connection_domain_connection_id ON saml_connection_domain("connectionId")`;
    }),
  },
  {
    // BEH-EA-305/306/307/309: signed AuthnRequests, the IdP's logout endpoint, the metadata URL, and the role mapping (JSON).
    name: "add_saml_connection_signing_logout_roles",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () =>
          sql`ALTER TABLE saml_connection ADD COLUMN "authnRequestsSigned" BOOLEAN NOT NULL DEFAULT FALSE`,
        sqlite: () =>
          sql`ALTER TABLE saml_connection ADD COLUMN "authnRequestsSigned" INTEGER NOT NULL DEFAULT 0`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
      yield* sql`ALTER TABLE saml_connection ADD COLUMN "sloUrl" TEXT`;
      yield* sql`ALTER TABLE saml_connection ADD COLUMN "sloBinding" TEXT NOT NULL DEFAULT 'redirect'`;
      yield* sql`ALTER TABLE saml_connection ADD COLUMN "metadataUrl" TEXT`;
      yield* sql`ALTER TABLE saml_connection ADD COLUMN "roleMapping" TEXT NOT NULL DEFAULT '{"rules":[],"ceiling":["member"],"defaultRoles":[]}'`;
    }),
  },
  {
    // BEH-EA-305: the SP's own signing keys per connection; `privateKey` is the sealed `Encryption` envelope.
    name: "create_saml_sp_key",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE saml_sp_key (
            id TEXT PRIMARY KEY,
            "connectionId" TEXT NOT NULL,
            certificate TEXT NOT NULL,
            "privateKey" TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            "notBefore" TIMESTAMPTZ NOT NULL,
            "notAfter" TIMESTAMPTZ NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE saml_sp_key (
            id TEXT PRIMARY KEY,
            "connectionId" TEXT NOT NULL,
            certificate TEXT NOT NULL,
            "privateKey" TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            "notBefore" TEXT NOT NULL,
            "notAfter" TEXT NOT NULL,
            "createdAt" TEXT NOT NULL
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
      yield* sql`CREATE INDEX saml_sp_key_connection_id ON saml_sp_key("connectionId")`;
    }),
  },
  {
    // BEH-EA-306: which local sessions a connection's sign-ins created, by the NameID/SessionIndex the IdP knows them by.
    name: "create_saml_session",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE saml_session (
            "sessionId" TEXT PRIMARY KEY,
            "connectionId" TEXT NOT NULL,
            "nameId" TEXT NOT NULL,
            "nameIdFormat" TEXT,
            "sessionIndex" TEXT,
            "createdAt" TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE saml_session (
            "sessionId" TEXT PRIMARY KEY,
            "connectionId" TEXT NOT NULL,
            "nameId" TEXT NOT NULL,
            "nameIdFormat" TEXT,
            "sessionIndex" TEXT,
            "createdAt" TEXT NOT NULL
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
      yield* sql`CREATE INDEX saml_session_identity ON saml_session("connectionId", "nameId")`;
      yield* sql`CREATE INDEX saml_session_created_at ON saml_session("createdAt")`;
    }),
  },
];

// ---- pieces ------------------------------------------------------------------------------------------

const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** A `callbackURL` is a relative path or an origin the deployment trusts; anything else is the default (BEH-EA-128's rule, as OAuth applies it). */
const resolveCallbackURL = (
  raw: string | undefined,
  settings: SamlConfig.SamlConfigShape,
): string => {
  if (raw === undefined) return settings.defaultCallbackURL;
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\")) return raw;
  const parsed = URL.parse(raw);
  return parsed !== null &&
    (parsed.protocol === "https:" || parsed.protocol === "http:") &&
    settings.trustedOrigins.includes(parsed.origin)
    ? raw
    : settings.defaultCallbackURL;
};

/** First present attribute (by any of `names`, case-insensitively), first value. */
const attributeOf = (
  assertion: SignedAssertion,
  names: ReadonlyArray<string>,
): string | undefined => {
  const wanted = names.map((name) => name.toLowerCase());
  for (const [name, values] of Object.entries(assertion.attributes)) {
    if (!wanted.includes(name.toLowerCase())) continue;
    const value = values.find((candidate) => candidate !== "");
    if (value !== undefined) return value;
  }
  return undefined;
};

const EMAIL_ATTRIBUTES = [
  "email",
  "mail",
  "emailaddress",
  "urn:oid:0.9.2342.19200300.100.1.3",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
];
const NAME_ATTRIBUTES = [
  "displayname",
  "name",
  "cn",
  "urn:oid:2.16.840.1.113730.3.1.241",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
];
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const emailOf = (assertion: SignedAssertion): string | undefined => {
  const attribute = attributeOf(assertion, EMAIL_ATTRIBUTES);
  if (attribute !== undefined && EMAIL_SHAPE.test(attribute)) return attribute.toLowerCase();
  return assertion.nameId.format === "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" &&
    EMAIL_SHAPE.test(assertion.nameId.value)
    ? assertion.nameId.value.toLowerCase()
    : undefined;
};

/** The request cookie: same attributes when set and when cleared, or a conforming browser will not match it. The POST from the IdP is cross-site, so `SameSite=None`. */
const requestCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  path: "/",
} as const;

const expireRequestCookie = HttpEffect.appendPreResponseHandler((_request, response) =>
  HttpServerResponse.expireCookie(response, REQUEST_COOKIE, requestCookieOptions).pipe(
    Effect.orDie,
  ),
);

const noReferrer = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, "referrer-policy", "no-referrer")),
);

// ---- handlers ----------------------------------------------------------------------------------------

export const SamlHandlers = HttpApiBuilder.group(
  SamlApi.SamlApi,
  "saml",
  Effect.fnUntraced(function* (handlers) {
    const saml = yield* Saml;
    const clientAddress = yield* ClientAddress.ClientAddress;
    const settings = yield* SamlConfig.SamlConfig;
    return handlers.handleAll({
      metadata: Effect.fnUntraced(function* ({ query }: { query: SamlApi.ConnectionQuery }) {
        return yield* saml.metadata(query.connection);
      }),

      login: Effect.fnUntraced(function* ({
        query,
        request,
      }: {
        query: SamlApi.LoginQuery;
        request: HttpServerRequest.HttpServerRequest;
      }) {
        yield* noReferrer;
        const resolved = yield* clientAddress.resolve(request);
        const started = yield* saml.authnRequest(query.connection, {
          callbackURL: query.callbackURL,
          ...(Option.isSome(resolved) ? { ip: resolved.value } : {}),
        });
        return yield* HttpServerResponse.setCookie(
          HttpServerResponse.redirect(started.location),
          REQUEST_COOKIE,
          Redacted.value(started.state),
          { ...requestCookieOptions, maxAge: settings.requestTtl },
        ).pipe(Effect.orDie);
      }),

      acs: Effect.fnUntraced(function* ({
        payload,
        request,
      }: {
        payload: SamlApi.AcsPayload;
        request: HttpServerRequest.HttpServerRequest;
      }) {
        yield* noReferrer;
        // The request state is single-use: every ACS response, success or failure, clears it.
        yield* expireRequestCookie;
        const resolved = yield* clientAddress.resolve(request);
        const outcome = yield* saml.acs({
          samlResponse: payload.SAMLResponse,
          cookieState: request.cookies[REQUEST_COOKIE],
          ...(Option.isSome(resolved) ? { ip: resolved.value } : {}),
          ...Option.match(Headers.get(request.headers, "user-agent"), {
            onNone: () => ({}),
            onSome: (userAgent) => ({ userAgent }),
          }),
        });
        const cookie = yield* SessionCookie.render(outcome.session.session, outcome.session.token);
        return yield* HttpServerResponse.setCookie(
          HttpServerResponse.redirect(outcome.callbackURL),
          cookie.name,
          cookie.value,
          cookie.options,
        ).pipe(Effect.orDie);
      }),

      slo: Effect.fnUntraced(function* ({
        params,
        query,
        request,
      }: {
        params: SamlApi.SloParams;
        query: SamlApi.SloQuery;
        request: HttpServerRequest.HttpServerRequest;
      }) {
        yield* noReferrer;
        const resolved = yield* clientAddress.resolve(request);
        // The signature covers the RAW query the IdP sent; the handler hands it on untouched.
        const questionMark = request.url.indexOf("?");
        const outcome = yield* saml.slo({
          connectionId: params.connection,
          binding: "redirect",
          rawQuery: questionMark < 0 ? undefined : request.url.slice(questionMark + 1),
          samlRequest: query.SAMLRequest,
          samlResponse: query.SAMLResponse,
          relayState: query.RelayState,
          cookieState: request.cookies[LOGOUT_COOKIE],
          ip: Option.getOrUndefined(resolved),
        });
        return yield* respondToBrowser(outcome);
      }),

      sloPost: Effect.fnUntraced(function* ({
        params,
        payload,
        request,
      }: {
        params: SamlApi.SloParams;
        payload: SamlApi.SloPayload;
        request: HttpServerRequest.HttpServerRequest;
      }) {
        yield* noReferrer;
        const resolved = yield* clientAddress.resolve(request);
        const outcome = yield* saml.slo({
          connectionId: params.connection,
          binding: "post",
          rawQuery: undefined,
          samlRequest: payload.SAMLRequest,
          samlResponse: payload.SAMLResponse,
          relayState: payload.RelayState,
          cookieState: request.cookies[LOGOUT_COOKIE],
          ip: Option.getOrUndefined(resolved),
        });
        return yield* respondToBrowser(outcome);
      }),
    });
  }),
);

/** The logout state is single-use: every response at the logout endpoint clears the cookie, and a page that carries a form must not be cached. */
const expireLogoutCookie = HttpEffect.appendPreResponseHandler((_request, response) =>
  HttpServerResponse.expireCookie(response, LOGOUT_COOKIE, requestCookieOptions).pipe(Effect.orDie),
);

const respondToBrowser = Effect.fnUntraced(function* (outcome: SamlSlo.SloOutcome) {
  yield* expireLogoutCookie;
  switch (outcome._tag) {
    case "redirect":
      return HttpServerResponse.redirect(outcome.location);
    case "done":
      return HttpServerResponse.redirect(outcome.callbackURL);
    case "postForm":
      return HttpServerResponse.text(outcome.html, {
        contentType: "text/html; charset=utf-8",
      }).pipe(HttpServerResponse.setHeader("cache-control", "no-store"));
  }
});

/** BEH-EA-306: the signed-in user's own logout (`saml.account`). */
export const SamlAccountHandlers = HttpApiBuilder.group(
  SamlApi.SamlApi,
  "saml.account",
  Effect.fnUntraced(function* (handlers) {
    const saml = yield* Saml;
    const clientAddress = yield* ClientAddress.ClientAddress;
    const settings = yield* SamlConfig.SamlConfig;
    return handlers.handleAll({
      logout: Effect.fnUntraced(function* ({
        payload,
        request,
      }: {
        payload: SamlApi.LogoutPayload;
        request: HttpServerRequest.HttpServerRequest;
      }) {
        yield* noReferrer;
        const principal = yield* Api.CurrentPrincipal;
        if (principal._tag !== "User") {
          return yield* Defects.invariantViolation(
            "NonUserPrincipal",
            `awthaq: saml.account reached with a non-User principal: ${principal._tag}`,
          );
        }
        const resolved = yield* clientAddress.resolve(request);
        const started = yield* saml.logout(principal, {
          callbackURL: payload.callbackURL,
          ip: Option.getOrUndefined(resolved),
        });
        // The caller's own session ended, so its cookie is expired, whatever the IdP does next.
        yield* SessionCookie.expire;
        if (started._tag === "local") return HttpServerResponse.redirect(started.callbackURL);
        const response =
          started._tag === "redirect"
            ? HttpServerResponse.redirect(started.location)
            : HttpServerResponse.text(started.html, {
                contentType: "text/html; charset=utf-8",
              }).pipe(HttpServerResponse.setHeader("cache-control", "no-store"));
        // The IdP's LogoutResponse comes back cross-site (POST), so the state cookie is `SameSite=None`.
        return yield* HttpServerResponse.setCookie(
          response,
          LOGOUT_COOKIE,
          Redacted.value(started.state),
          { ...requestCookieOptions, maxAge: settings.requestTtl },
        ).pipe(Effect.orDie);
      }),
    });
  }),
);

/** BEH-EA-309: the administrator's group (`saml.admin`): admin tier by its id, fail-closed by `canManageSaml`. */
export const SamlAdminHandlers = HttpApiBuilder.group(
  SamlApi.SamlApi,
  "saml.admin",
  Effect.fnUntraced(function* (handlers) {
    const saml = yield* Saml;
    const admin = saml.admin;
    return handlers.handleAll({
      createConnection: Effect.fnUntraced(function* ({
        payload,
      }: {
        payload: SamlApi.CreateConnectionPayload;
      }) {
        return yield* admin.createConnection(yield* currentUserPrincipal, payload);
      }),
      listConnections: Effect.fnUntraced(function* ({
        query,
      }: {
        query: SamlApi.ListConnectionsQuery;
      }) {
        return yield* admin.listConnections(yield* currentUserPrincipal, query.organizationId);
      }),
      getConnection: Effect.fnUntraced(function* ({
        params,
      }: {
        params: SamlApi.ConnectionIdParams;
      }) {
        return yield* admin.getConnection(yield* currentUserPrincipal, params.connectionId);
      }),
      updateConnection: Effect.fnUntraced(function* ({
        params,
        payload,
      }: {
        params: SamlApi.ConnectionIdParams;
        payload: SamlApi.UpdateConnectionPayload;
      }) {
        return yield* admin.updateConnection(
          yield* currentUserPrincipal,
          params.connectionId,
          payload,
        );
      }),
      deleteConnection: Effect.fnUntraced(function* ({
        params,
      }: {
        params: SamlApi.ConnectionIdParams;
      }) {
        yield* admin.deleteConnection(yield* currentUserPrincipal, params.connectionId);
      }),
      refreshMetadata: Effect.fnUntraced(function* ({
        params,
      }: {
        params: SamlApi.ConnectionIdParams;
      }) {
        return yield* admin.refreshMetadata(yield* currentUserPrincipal, params.connectionId);
      }),
      rotateSigningKey: Effect.fnUntraced(function* ({
        params,
        payload,
      }: {
        params: SamlApi.ConnectionIdParams;
        payload: SamlApi.SigningKeyPayload;
      }) {
        return yield* admin.rotateSigningKey(
          yield* currentUserPrincipal,
          params.connectionId,
          payload,
        );
      }),
      listSigningKeys: Effect.fnUntraced(function* ({
        params,
      }: {
        params: SamlApi.ConnectionIdParams;
      }) {
        return yield* admin.listSigningKeys(yield* currentUserPrincipal, params.connectionId);
      }),
    });
  }),
);

/** Same forward-reference pattern `@awthaq/admin` and `@awthaq/webhooks` document: a handler reached without a `User` principal is a wiring defect. */
const currentUserPrincipal = Effect.gen(function* () {
  const principal = yield* Api.CurrentPrincipal;
  if (principal._tag !== "User") {
    return yield* Defects.invariantViolation(
      "NonUserPrincipal",
      `awthaq: saml.admin reached with a non-User principal: ${principal._tag}`,
    );
  }
  return principal;
});

// ---- the plugin --------------------------------------------------------------------------------------

export class Saml extends AuthPlugin.Service<Saml, SamlShape>()("saml", {
  apiVersion: 1,
  contract: SamlApi.SamlApi,
  tables: ["saml_connection", "saml_connection_domain", "saml_sp_key", "saml_session"],
  migrations: samlMigrations,
}) {
  static readonly layer = AuthPlugin.layer(Saml, {
    dependsOn: [Organization.Organization],
    handlers: Layer.mergeAll(SamlHandlers, SamlAccountHandlers, SamlAdminHandlers),
    make: Effect.gen(function* () {
      const users = yield* Users.Users;
      const accounts = yield* Accounts.Accounts;
      const sessions = yield* Sessions.Sessions;
      const verification = yield* Verification.Verification;
      const events = yield* AuthEvents.AuthEvents;
      const records = yield* SamlRecords.SamlRecords;
      const orgs = yield* OrganizationRecords.OrganizationRecords;
      const organization = yield* Organization.Organization;
      const spKeys = yield* SamlSpKeys.SamlSpKeys;
      const xmlSignature = yield* XmlSignature.XmlSignature;
      const crypto = yield* Crypto.Crypto;
      const limiter = yield* RateLimiter.RateLimiter;
      const sqlTransaction = yield* SqlTransaction.SqlTransaction;
      const settings = yield* SamlConfig.SamlConfig;
      const beforeSignUp = yield* Hooks.BeforeSignUp;
      const afterSignUp = yield* Hooks.AfterSignUp;
      const beforeSignIn = yield* Hooks.BeforeSignIn;
      const beforeSessionIssue = yield* Hooks.BeforeSessionIssue;
      const afterSignIn = yield* Hooks.AfterSignIn;

      const acsUrl = SamlConfig.acsUrl(settings);
      const admin = yield* SamlAdmin.makeAdmin;

      const rateLimit = (endpoint: "login" | "acs", ip: string | undefined) =>
        RateLimits.enforce({
          key: `saml:${endpoint}:${ip ?? "unknown"}`,
          limit: settings.rateLimits[endpoint].limit,
          window: settings.rateLimits[endpoint].window,
          meta: { group: "saml", endpoint, rule: endpoint, dimension: "ip" },
        }).pipe(
          Effect.provideService(RateLimiter.RateLimiter, limiter),
          Effect.provideService(AuthEvents.AuthEvents, events),
          Effect.catchTag(
            "RateLimitExceeded",
            (error) => new Api.RateLimited({ retryAfterMillis: error.retryAfterMillis }),
          ),
        );

      /** A connection that exists AND whose organization exists and is not suspended (BEH-EA-237); anything else is `None`. */
      const usableConnection = (connectionId: string) =>
        records.findById(connectionId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: (connection) =>
                orgs
                  .findById(connection.organizationId)
                  .pipe(
                    Effect.map((organization) =>
                      Option.isSome(organization) && Option.isNone(organization.value.suspendedAt)
                        ? Option.some(connection)
                        : Option.none<SamlRecords.ConnectionRecord>(),
                    ),
                  ),
            }),
          ),
        );

      const metadata: SamlShape["metadata"] = Effect.fnUntraced(function* (connectionId) {
        const connection = yield* usableConnection(connectionId);
        if (Option.isNone(connection))
          return yield* Effect.fail(new SamlApi.SamlConnectionNotFound());
        return spMetadataXml({
          entityId: settings.spEntityId(connection.value.id),
          acsUrl,
          authnRequestsSigned: connection.value.authnRequestsSigned,
          certificates: yield* spKeys.certificates(connection.value.id),
          sloUrl: Option.isSome(connection.value.sloUrl)
            ? SamlConfig.sloUrl(settings, connection.value.id)
            : undefined,
        });
      });

      const authnRequest: SamlShape["authnRequest"] = Effect.fnUntraced(
        function* (connectionId, input) {
          yield* rateLimit("login", input.ip);
          const connection = yield* usableConnection(connectionId);
          if (Option.isNone(connection))
            return yield* Effect.fail(new SamlApi.SamlConnectionNotFound());
          const uuid = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
          // The AuthnRequest id is an NCName: a letter or underscore first.
          const requestId = `_${uuid}`;
          const identifier = `${REQUEST_PREFIX}${uuid}`;
          const { value } = yield* verification.issue({
            identifier,
            ttl: settings.requestTtl,
            payload: {
              connectionId,
              requestId,
              callbackURL: resolveCallbackURL(input.callbackURL, settings),
            },
          });
          const now = yield* DateTime.now;
          // BEH-EA-305: a connection that signs its requests never sends one unsigned. No usable key is a defect (the store
          // guarantees one exists, so this means every key has expired or cannot be opened), not a silent downgrade.
          const signing = connection.value.authnRequestsSigned
            ? yield* spKeys.signingKey(connectionId)
            : Option.none();
          if (connection.value.authnRequestsSigned && Option.isNone(signing)) {
            return yield* Defects.invariantViolation(
              "saml.signingKeyUsable",
              `awthaq/saml: connection ${connectionId} signs its AuthnRequests but has no usable signing key`,
            );
          }
          const location = redirectUrl({
            endpoint: connection.value.ssoUrl,
            kind: "SAMLRequest",
            xml: authnRequestXml({
              id: requestId,
              issueInstant: now,
              destination: connection.value.ssoUrl,
              acsUrl,
              issuer: settings.spEntityId(connectionId),
            }),
            signWith: Option.isSome(signing)
              ? Redacted.value(signing.value.privateKeyPem)
              : undefined,
          });
          // The cookie carries `<identifier>.<secret>`: the browser proves it is the one that started this login.
          return { location, state: Redacted.make(`${identifier}.${Redacted.value(value)}`) };
        },
      );

      // ---- the ACS chain -------------------------------------------------------------------------------

      /** Steps 1-3: the state cookie, the size cap, and the single-consume request. */
      const consumeRequest = Effect.fnUntraced(function* (cookieState: string | undefined) {
        // Unsolicited (IdP-initiated) responses, and any browser that did not start this login, stop here.
        if (cookieState === undefined)
          return yield* Effect.fail(new AssertionInvalid({ reason: "noRequestState" }));
        const dot = cookieState.indexOf(".");
        const identifier = dot < 0 ? "" : cookieState.slice(0, dot);
        const secret = dot < 0 ? "" : cookieState.slice(dot + 1);
        if (!identifier.startsWith(REQUEST_PREFIX) || secret === "") {
          return yield* Effect.fail(new AssertionInvalid({ reason: "requestStateMalformed" }));
        }
        const consumed = yield* verification
          .consume(identifier, Redacted.make(secret))
          .pipe(
            Effect.catchTag("Verification/TokenConsumed", () =>
              Effect.fail(new AssertionInvalid({ reason: "requestUnknownOrConsumed" })),
            ),
          );
        const payload = decodeRequestPayload(consumed.payload);
        if (Option.isNone(payload))
          return yield* Effect.fail(new AssertionInvalid({ reason: "requestPayloadInvalid" }));
        return payload.value;
      });

      /** BEH-EA-238: the response is capped before base64 is decoded and before any XML parser sees it. */
      const decodeResponse = Effect.fnUntraced(function* (samlResponse: string) {
        const compact = samlResponse.replace(/\s+/g, "");
        // Base64 inflates by 4/3: a longer string cannot decode to a permitted size.
        if (compact.length > Math.ceil((settings.maxResponseBytes * 4) / 3) + 4) {
          return yield* Effect.fail(new AssertionInvalid({ reason: "tooLarge" }));
        }
        const bytes = Encoding.decodeBase64(compact);
        if (Result.isFailure(bytes))
          return yield* Effect.fail(new AssertionInvalid({ reason: "notBase64" }));
        if (bytes.success.length > settings.maxResponseBytes) {
          return yield* Effect.fail(new AssertionInvalid({ reason: "tooLarge" }));
        }
        return yield* Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes.success),
          catch: () => new AssertionInvalid({ reason: "notUtf8" }),
        });
      });

      /** Steps 4-6: signature, the signed data, the checks, and the one-time assertion id. */
      const verifyResponse = Effect.fnUntraced(function* (
        xml: string,
        connection: SamlRecords.ConnectionRecord,
        requestId: string,
      ) {
        const verified = yield* xmlSignature
          .verify({
            xml,
            trust: trustSetOf(connection),
            policy: {
              maxBytes: settings.maxResponseBytes,
              signedElements: [
                { namespace: "urn:oasis:names:tc:SAML:2.0:assertion", localName: "Assertion" },
                { namespace: "urn:oasis:names:tc:SAML:2.0:protocol", localName: "Response" },
              ],
              exactlyOne: [
                { namespace: "urn:oasis:names:tc:SAML:2.0:assertion", localName: "Assertion" },
              ],
              forbidden: [
                {
                  namespace: "urn:oasis:names:tc:SAML:2.0:assertion",
                  localName: "EncryptedAssertion",
                },
              ],
            },
          })
          .pipe(
            Effect.mapError(
              (error) => new AssertionInvalid({ reason: `signature:${error.reason}` }),
            ),
          );
        const assertion = yield* readAssertion(verified.signedXml);
        const now = yield* DateTime.now;
        yield* validateAssertion(assertion, {
          idpEntityId: connection.idpEntityId,
          spEntityId: settings.spEntityId(connection.id),
          acsUrl,
          inResponseTo: requestId,
          now,
          skewMillis: Duration.toMillis(settings.clockSkew),
        });
        // A Response that was NOT signed still carries a Destination; when it is there it may only tighten (BEH-EA-242).
        if (verified.signedElement.localName === "Assertion") {
          const outer = yield* SafeXml.parse(xml, settings.maxResponseBytes).pipe(
            Effect.mapError(() => new AssertionInvalid({ reason: "unsignedResponseUnreadable" })),
          );
          const destination = SafeXml.attribute(outer, "Destination");
          if (destination !== undefined && destination !== acsUrl) {
            return yield* Effect.fail(new AssertionInvalid({ reason: "destinationMismatch" }));
          }
        }
        // One-time assertion id: kept until the assertion could no longer pass the time window anyway.
        const digest = hexOf(
          yield* crypto
            .digest(
              "SHA-256",
              new TextEncoder().encode(`${connection.idpEntityId}|${assertion.id}`),
            )
            .pipe(Effect.orDie),
        );
        const remaining = Math.max(
          0,
          DateTime.toEpochMillis(assertion.notOnOrAfter ?? now) - DateTime.toEpochMillis(now),
        );
        const fresh = yield* verification.reserve({
          identifier: `${ASSERTION_PREFIX}${digest}`,
          ttl: Duration.millis(remaining + Duration.toMillis(settings.clockSkew) + 60_000),
        });
        if (!fresh || assertion.id === "")
          return yield* Effect.fail(new AssertionInvalid({ reason: "assertionReplayed" }));
        return assertion;
      });

      /**
       * BEH-EA-307: the assertion's attributes, through the connection's rules, into the organization's roles, under the
       * connection's ceiling (`canGrant`, RRM-001). A mapping that cannot be applied (a role that no longer exists, a member who
       * out-privileges the connection, the last owner, a membership limit) is logged and skipped: the identity provider proved
       * who the user is, and that is still true; what it may confer is bounded, never a reason to lock them out.
       */
      const applyRoleMapping = (
        connection: SamlRecords.ConnectionRecord,
        assertion: SignedAssertion,
        userId: Users.UserId,
      ) => {
        const roles = SamlRoleMapping.rolesFor(connection.roleMapping, assertion);
        if (roles === undefined) return Effect.void;
        return organization
          .syncMemberRoles({
            organizationId: connection.organizationId,
            userId,
            roles,
            ceiling: connection.roleMapping.ceiling,
          })
          .pipe(
            Effect.asVoid,
            Effect.catch((error) =>
              Effect.logWarning("awthaq/saml: role mapping not applied", {
                connectionId: connection.id,
                reason: error._tag,
              }),
            ),
          );
      };

      /** Step 7: the account, the sign-in gate, the hooks and the session. Runs as the connection's tenant. */
      const signIn = Effect.fnUntraced(function* (
        connection: SamlRecords.ConnectionRecord,
        assertion: SignedAssertion,
        input: { readonly ip?: string | undefined; readonly userAgent?: string | undefined },
      ) {
        const providerId = providerIdOf(connection.organizationId, connection.id);
        const subject = assertion.nameId.value;
        const email = emailOf(assertion);
        const linked = yield* accounts.findByProviderSubject(
          providerId,
          subject,
          connection.idpEntityId,
        );

        const targetUserId: Users.UserId = yield* Option.match(linked, {
          onSome: (account) => Effect.succeed(account.userId),
          onNone: () =>
            Effect.gen(function* () {
              const existing =
                email === undefined ? Option.none() : yield* users.findByEmail(email);
              if (Option.isSome(existing)) {
                // BEH-EA-245: never linked by email alone. An explicitly trusted connection may link to a local
                // account whose own address is already verified; every other case is the uniform rejection.
                if (!connection.trustsEmail || !Users.isEmailVerified(existing.value)) {
                  return yield* Effect.fail(new AssertionInvalid({ reason: "emailInUse" }));
                }
                yield* accounts
                  .link({
                    userId: existing.value.id,
                    providerId,
                    subject,
                    issuer: connection.idpEntityId,
                  })
                  .pipe(Effect.catchTag("AccountAlreadyLinked", Effect.die));
                return existing.value.id;
              }
              const name = attributeOf(assertion, NAME_ATTRIBUTES) ?? email ?? subject;
              const vetoed = yield* HookPoint.aborted(Hooks.BeforeSignUp)(
                beforeSignUp.run({
                  ...(email === undefined ? {} : { email }),
                  name,
                  strategy: providerId,
                }),
              );
              const created = yield* sqlTransaction
                .withTransaction(
                  Effect.gen(function* () {
                    const user = yield* users
                      .create({
                        identity:
                          vetoed.email === undefined
                            ? { _tag: "Anonymous" }
                            : { _tag: "Email", email: vetoed.email },
                        name: vetoed.name,
                      })
                      .pipe(
                        Effect.catchTag("Users/EmailAlreadyExists", () =>
                          Effect.fail(new AssertionInvalid({ reason: "emailInUse" })),
                        ),
                        Effect.catchTag("Users/PhoneAlreadyExists", Effect.die),
                      );
                    yield* accounts
                      .link({
                        userId: user.id,
                        providerId,
                        subject,
                        issuer: connection.idpEntityId,
                      })
                      .pipe(Effect.catchTag("AccountAlreadyLinked", Effect.die));
                    return user;
                  }),
                )
                .pipe(Effect.catchTag("SqlError", Effect.die));
              yield* events.publish({ _tag: "auth.user.created", userId: created.id });
              yield* afterSignUp.run({
                userId: created.id,
                ...(vetoed.email === undefined ? {} : { email: vetoed.email }),
                strategy: providerId,
              });
              return created.id;
            }),
        });

        // SCP-001/BAM-005: THE shared sign-in gate — the IdP proved the identity; a suspended user still gets no session.
        const user = yield* users
          .findById(targetUserId)
          .pipe(Effect.orDie, Effect.tap(Users.assertCanSignIn));
        const userEmail = Users.emailOf(user);
        yield* HookPoint.aborted(Hooks.BeforeSignIn)(
          beforeSignIn.run({
            userId: targetUserId,
            ...(Option.isSome(userEmail) ? { email: userEmail.value } : {}),
            strategy: providerId,
          }),
        );
        const point = yield* beforeSessionIssue.run({ userId: targetUserId, strategy: providerId });
        if (point._tag === "Diverted") return yield* Effect.fail(point.value);
        yield* applyRoleMapping(connection, assertion, targetUserId);
        const issued = yield* sessions.issue({
          userId: targetUserId,
          request: {
            ...(input.ip !== undefined ? { ip: input.ip } : {}),
            ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
          },
          amr: ["fed"],
        });
        // BEH-EA-306: remember which identity the IdP knows this session by, so a Single Logout can find it again.
        yield* records.saveSession({
          sessionId: issued.session.id,
          connectionId: connection.id,
          nameId: assertion.nameId.value,
          nameIdFormat: assertion.nameId.format,
          sessionIndex: assertion.sessionIndex,
        });
        yield* records.pruneSessions(
          DateTime.subtractDuration(yield* DateTime.now, settings.sessionRecordRetention),
        );
        yield* events.publish({
          _tag: "auth.user.signedIn",
          userId: targetUserId,
          strategy: providerId,
        });
        yield* afterSignIn.run({ userId: targetUserId, strategy: providerId });
        return issued;
      });

      const acs: SamlShape["acs"] = Effect.fnUntraced(function* (input) {
        yield* rateLimit("acs", input.ip);
        // Which connection the attempt was for, once known, so the audit event can name it.
        let strategy = "saml";
        const reject = (reason: string) =>
          Effect.all(
            [
              Effect.logWarning("awthaq/saml: assertion rejected", { reason }),
              events.publish({
                _tag: "auth.user.signInFailed",
                strategy,
                reason: "assertionInvalid",
                ...(input.ip === undefined ? {} : { clientIp: input.ip }),
              }),
            ],
            { discard: true },
          ).pipe(Effect.andThen(Effect.fail(new SamlApi.SamlAssertionRejected())));

        const chain = Effect.gen(function* () {
          const request = yield* consumeRequest(input.cookieState);
          const xml = yield* decodeResponse(input.samlResponse);
          const connection = yield* usableConnection(request.connectionId);
          if (Option.isNone(connection))
            return yield* Effect.fail(new AssertionInvalid({ reason: "connectionUnavailable" }));
          strategy = providerIdOf(connection.value.organizationId, connection.value.id);
          const assertion = yield* verifyResponse(xml, connection.value, request.requestId);
          const run = signIn(connection.value, assertion, input);
          const issued = yield* settings.tenantScoped
            ? run.pipe(Tenant.withTenant(connection.value.organizationId))
            : run;
          return { callbackURL: request.callbackURL, session: issued };
        });

        return yield* chain.pipe(
          Effect.catchTag("AssertionInvalid", (invalid) => reject(invalid.reason)),
        );
      });

      const slo = SamlSlo.makeSlo({
        settings,
        usableConnection,
        records,
        sessions,
        verification,
        events,
        xmlSignature,
        spKeys,
        crypto,
        limiter,
        resolveCallbackURL: (raw) => resolveCallbackURL(raw, settings),
      });

      return Saml.of({ metadata, authnRequest, acs, slo: slo.slo, logout: slo.logout, admin });
    }),
  });
}
