// Shared composition for the SAML plugin's suites: the real in-memory core, the organization plugin (`Saml`
// `dependsOn: [Organization]`), the SAML records and connection store, and the Node `XmlSignature` adapter — the
// same layer graph an application builds — plus helpers that play the two other parties: the IdP (a signed
// response for a given AuthnRequest) and the browser (the state cookie).
import { Api } from "@awthaq/api";
import { Auth, type Sessions, type Users } from "@awthaq/core";
import { Organization, type OrganizationHooks } from "@awthaq/organization";
import { RateLimiter } from "@awthaq/ports";
import { TestAuth } from "@awthaq/test";
import { inflateRawSync } from "node:zlib";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Saml from "../src/Saml.ts";
import * as SamlConnections from "../src/SamlConnections.ts";
import * as SamlMetadataFetcher from "../src/SamlMetadataFetcher.ts";
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

/** A real `Encryption` over a fixed test key: the SP signing keys are sealed with it, as in production. */
export const EncryptionLive = TestAuth.encryption;

const built = Auth.make([Organization.Organization, Saml.Saml]);

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

/**
 * `Saml` over in-memory storage through `TestAuth.layer(Auth.make([Organization, Saml]))`: the organization plugin
 * (`Saml` `dependsOn: [Organization]`), the SAML records and connection store, and the Node `XmlSignature`
 * adapter. `limiter` and `fetcher` are the plugin's own substitutions; `coreOverride` wraps a core service
 * (`TestAuth.layer`'s `decorate`) the plugin captures at construction (for example to simulate a store outage);
 * `taps` are application taps on the organization hook points (an observer that records the actor of a role mapping).
 */
export const SamlLive = <Wrapped extends Sessions.Sessions | Users.Users = never>(
  samlConfig: Partial<Omit<Saml.SamlConfigInput, "baseUrl">> = {},
  limiter: Layer.Layer<RateLimiter.RateLimiter> = RateLimiter.layerPermissive,
  fetcher: Layer.Layer<SamlMetadataFetcher.SamlMetadataFetcher> = fakeFetcher({}).layer,
  coreOverride?: Layer.Layer<Wrapped, never, Wrapped>,
  taps: Layer.Layer<
    never,
    never,
    Layer.Success<typeof OrganizationHooks.OrganizationHooksLive>
  > = Layer.empty,
) =>
  TestAuth.layer(built, {
    services: Layer.mergeAll(
      Saml.config({ baseUrl: BASE_URL, ...samlConfig }),
      Organization.config({}),
      XmlSignatureNode.layer,
      fetcher,
      limiter,
      // The same layer the bundle projects `SamlRecords` from (one instance), plus its `MemoryEnvelopes` test seam
      // (what `SamlSigning.test.ts` plants), which a bundle does not provide.
      SamlRecords.layerMemory,
    ),
    ...(coreOverride === undefined ? {} : { decorate: coreOverride }),
    taps,
  });

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
