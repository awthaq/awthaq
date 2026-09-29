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
import { Organization, OrganizationHooks, OrganizationMemory } from "@awthaq/organization";
import {
  ClientAddress,
  Encryption,
  KeyProvider,
  Mailer,
  RateLimiter,
  SqlTransaction,
} from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { inflateRawSync } from "node:zlib";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Saml from "../src/Saml.ts";
import * as SamlConnections from "../src/SamlConnections.ts";
import * as SamlMetadataFetcher from "../src/SamlMetadataFetcher.ts";
import * as SamlRecords from "../src/SamlRecords.ts";
import * as SamlSpKeys from "../src/SamlSpKeys.ts";
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

/** A real `Encryption` over a fixed test key: the SP signing keys are sealed with it, as in production. */
export const EncryptionLive = Encryption.layer.pipe(
  Layer.provide(
    KeyProvider.layerEnv.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { AWTHAQ_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") },
          }),
        ),
      ),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);

const AdminAuthenticationLive = Authentication.AdminAuthenticationLive.pipe(
  Layer.provide(AuthenticationLive),
);

/** A metadata fetcher over a fixed table: what a URL "serves", and (for a failing URL) the class it fails as. */
export const fakeFetcher = (
  table: Readonly<Record<string, string | SamlMetadataFetcher.MetadataFetchFailed>>,
) => {
  const requested: Array<string> = [];
  const layer = Layer.succeed(
    SamlMetadataFetcher.SamlMetadataFetcher,
    SamlMetadataFetcher.SamlMetadataFetcher.of({
      fetch: (url) => {
        requested.push(url);
        const answer = table[url];
        if (answer === undefined) {
          return Effect.fail(
            new SamlMetadataFetcher.MetadataFetchFailed({
              failure: "connect",
              detail: "no such URL",
            }),
          );
        }
        return typeof answer === "string" ? Effect.succeed(answer) : Effect.fail(answer);
      },
    }),
  );
  return { layer, requested };
};

const OrganizationLive = Organization.Organization.layer.pipe(
  Layer.provide(Organization.config({})),
  Layer.provide(AuthenticationLive),
  Layer.provide(CsrfProtectionLive),
);

export const SamlLive = (
  samlConfig: Partial<Omit<Saml.SamlConfigInput, "baseUrl">> = {},
  limiter: Layer.Layer<RateLimiter.RateLimiter> = RateLimiter.layerPermissive,
  fetcher: Layer.Layer<SamlMetadataFetcher.SamlMetadataFetcher> = fakeFetcher({}).layer,
) =>
  Saml.Saml.layer.pipe(
    Layer.provide(AdminAuthenticationLive),
    Layer.provide(AuthenticationLive),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(SamlConnections.layerStore),
    Layer.provideMerge(SamlSpKeys.layer),
    Layer.provideMerge(fetcher),
    Layer.provideMerge(EncryptionLive),
    Layer.provideMerge(OrganizationLive),
    Layer.provideMerge(SamlRecords.layerMemory),
    Layer.provideMerge(XmlSignatureNode.layer),
    Layer.provideMerge(limiter),
    Layer.provideMerge(ClientAddress.layerDirect),
    Layer.provideMerge(OrganizationMemory.layer),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(Mailer.layerMemory),
    Layer.provideMerge(SqlTransaction.layerNoop),
    Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
    Layer.provideMerge(Saml.config({ baseUrl: BASE_URL, ...samlConfig })),
  );

export const ownerPrincipal = new Api.UserPrincipal({
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
    readonly authnRequestsSigned?: boolean;
    readonly sloUrl?: string;
    readonly sloBinding?: "redirect" | "post";
    readonly roleMapping?: SamlRecords.RoleMapping;
    /** Register through an existing organization instead of creating one. */
    readonly organizationId?: string;
    readonly name?: string;
    readonly entityId?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const organization = yield* Organization.Organization;
    const store = yield* SamlConnections.SamlConnectionStore;
    const organizationId =
      options.organizationId ??
      (yield* organization.create({
        caller: ownerPrincipal,
        name: "Acme",
        slug: options.slug ?? "acme",
      })).id;
    const connection = yield* store.create({
      organizationId,
      name: options.name ?? "Acme Okta",
      idp: {
        entityId: options.entityId ?? IDP_ENTITY_ID,
        ssoUrl: "https://idp.example.com/sso",
        certificates: options.certificates ?? [idp.cert],
        sloUrl: options.sloUrl,
        sloBinding: options.sloBinding,
      },
      emailDomains: options.emailDomains ?? ["acme.example"],
      trustsEmail: options.trustsEmail ?? false,
      authnRequestsSigned: options.authnRequestsSigned,
      roleMapping: options.roleMapping,
    });
    return { organizationId, connection };
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
