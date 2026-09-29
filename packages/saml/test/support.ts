// Shared composition for the SAML plugin's suites: the real in-memory core, the organization plugin (`Saml`
// `dependsOn: [Organization]`), the SAML records and connection store, and the Node `XmlSignature` adapter — the
// same layer graph an application builds — plus helpers that play the two other parties: the IdP (a signed
// response for a given AuthnRequest) and the browser (the state cookie).
import { Api } from "@awthaq/api";
import {
  Accounts,
  AuditLog,
  AuthEvents,
  Hooks,
  RateLimits,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import {
  ActiveContextRecords,
  InvitationRecords,
  MembershipRecords,
  Organization,
  OrganizationHooks,
  OrganizationRecords,
  OrgRoleRecords,
  TeamRecords,
} from "@awthaq/organization";
import { ClientAddress, Mailer, RateLimiter, SqlTransaction } from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { inflateRawSync } from "node:zlib";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Saml from "../src/Saml.ts";
import * as SamlConnections from "../src/SamlConnections.ts";
import * as SamlRecords from "../src/SamlRecords.ts";
import * as XmlSignatureNode from "../src/XmlSignatureNode.ts";
import {
  ACS_URL,
  idp,
  NOW,
  responseXml,
  signedResponse,
  SP_ENTITY_ID_PREFIX,
  type ResponseOptions,
  type SignOptions,
} from "./samlFixtures.ts";

export const BASE_URL = "https://sp.example.com";
export const IDP_ENTITY_ID = "https://idp.example.com/metadata";

const CoreLive = Layer.mergeAll(
  Sessions.layerMemory,
  Users.layerMemory,
  Accounts.layerMemory,
  Verification.layerMemory,
).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(RateLimits.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("saml-test-csrf-secret-padded-to-thirty-two-bytes-long"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const OrganizationLive = Organization.Organization.layer.pipe(
  Layer.provide(Organization.config({})),
  Layer.provide(AuthenticationLive),
  Layer.provide(CsrfProtectionLive),
);

export const SamlLive = (
  samlConfig: Partial<Omit<Saml.SamlConfigInput, "baseUrl">> = {},
  limiter: Layer.Layer<RateLimiter.RateLimiter> = RateLimiter.layerPermissive,
) =>
  Saml.Saml.layer.pipe(
    Layer.provideMerge(SamlConnections.layerStore),
    Layer.provideMerge(OrganizationLive),
    Layer.provideMerge(SamlRecords.layerMemory),
    Layer.provideMerge(XmlSignatureNode.layer),
    Layer.provideMerge(limiter),
    Layer.provideMerge(ClientAddress.layerDirect),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(OrganizationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(MembershipRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(ActiveContextRecords.layerMemory),
    Layer.provideMerge(InvitationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(OrgRoleRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(TeamRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(Mailer.layerMemory),
    Layer.provideMerge(SqlTransaction.layerNoop),
    Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
    Layer.provideMerge(Saml.config({ baseUrl: BASE_URL, ...samlConfig })),
  );

const ownerPrincipal = new Api.UserPrincipal({
  ref: new Api.PrincipalRef({ type: "user", id: "owner-1" }),
  sessionId: "owner-session",
});

/** Fixes the clock at the fixtures' `NOW` (test time otherwise starts at the epoch). */
export const atNow = TestClock.setTime(DateTime.toEpochMillis(NOW));

/** An organization and a SAML connection for it, trusting the fixture IdP (and optionally its rotation successor). */
export const seedConnection = (
  options: {
    readonly slug?: string;
    readonly certificates?: ReadonlyArray<string>;
    readonly emailDomains?: ReadonlyArray<string>;
    readonly trustsEmail?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const organization = yield* Organization.Organization;
    const store = yield* SamlConnections.SamlConnectionStore;
    const org = yield* organization.create({
      caller: ownerPrincipal,
      name: "Acme",
      slug: options.slug ?? "acme",
    });
    const connection = yield* store.create({
      organizationId: org.id,
      name: "Acme Okta",
      idp: {
        entityId: IDP_ENTITY_ID,
        ssoUrl: "https://idp.example.com/sso",
        certificates: options.certificates ?? [idp.cert],
      },
      emailDomains: options.emailDomains ?? ["acme.example"],
      trustsEmail: options.trustsEmail ?? false,
    });
    return { organizationId: org.id, connection };
  });

export interface Started {
  readonly requestId: string;
  /** The value of the `__Host-saml-request` cookie the browser holds. */
  readonly state: string;
  /** The AuthnRequest XML the SP put in the redirect. */
  readonly authnRequest: string;
  readonly location: string;
}

/** SP-initiated login as the browser would see it: the redirect to the IdP and the state cookie. */
export const startLogin = (connectionId: string, callbackURL?: string) =>
  Effect.gen(function* () {
    const saml = yield* Saml.Saml;
    const started = yield* saml.authnRequest(connectionId, { callbackURL });
    const url = new URL(started.location);
    const encoded = url.searchParams.get("SAMLRequest") ?? "";
    const authnRequest = inflateRawSync(Buffer.from(encoded, "base64")).toString("utf8");
    const requestId = /ID="([^"]+)"/.exec(authnRequest)?.[1] ?? "";
    const result: Started = {
      requestId,
      state: Redacted.value(started.state),
      authnRequest,
      location: started.location,
    };
    return result;
  });

/** The IdP's answer to `started`: a signed, base64 `SAMLResponse` (POST binding). */
export const idpResponse = (
  started: Started,
  connectionId: string,
  options: ResponseOptions & SignOptions = {},
): string =>
  Buffer.from(
    signedResponse(
      responseXml({
        inResponseTo: started.requestId,
        audience: `${SP_ENTITY_ID_PREFIX}${connectionId}`,
        recipient: ACS_URL,
        destination: ACS_URL,
        issuer: IDP_ENTITY_ID,
        ...options,
      }),
      options,
    ),
    "utf8",
  ).toString("base64");
