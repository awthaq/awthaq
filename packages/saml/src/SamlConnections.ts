// @awthaq/saml — SamlConnections
//
// spec/models/10-saml.md, BEH-EA-241: the write side of an organization's SAML connections — `SamlConnectionStore`,
// which an application or an administrator surface calls (there is no HTTP CRUD, like `@awthaq/scim`'s connections;
// the trust boundary is who may call the store). It validates everything an organization supplies, because an IdP
// description is exactly the input that decides whose signatures this server believes:
//
//   - the SSO URL is https without credentials (`OutboundUrl`; the browser is redirected there, this server never
//     fetches it, but a `javascript:` or `http:` URL has no business in a redirect);
//   - each certificate is parsed as X.509, RSA of at least 2048 bits (the only key type the XML-DSig adapter
//     verifies), and stored with its SHA-256 fingerprint and its own validity window — the trust set that pins the
//     signer and lets a rotation overlap (add the next certificate before the IdP starts using it, remove the old
//     one after);
//   - the organization must exist;
//   - an email domain routes to exactly one connection.
//
// An IdP's metadata can be imported (`importMetadata`): the certificates it lists become the trust set. That is
// exactly as trustworthy as the channel the metadata arrived by (TLS from the IdP's own URL, or pasted from its
// administrator); what gets pinned afterwards is the fingerprint, not the document.

import { OrganizationRecords } from "@awthaq/organization";
import { OutboundUrl } from "@awthaq/ports";
import type { XmlSignature } from "@awthaq/ports";
import { X509Certificate } from "node:crypto";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SamlConfig from "./SamlConfig.ts";
import { parseIdpMetadata } from "./SamlProtocol.ts";
import * as SamlRecords from "./SamlRecords.ts";

/** What an organization supplied is not acceptable; `reason` names the rule. */
export class InvalidSamlConnection extends Data.TaggedError("InvalidSamlConnection")<{
  readonly reason: string;
}> {}

export class SamlConnectionNotFound extends Data.TaggedError("SamlConnections/NotFound")<{
  readonly id: string;
}> {}

const invalid = (reason: string) => new InvalidSamlConnection({ reason });

/** A PEM certificate as a trust-set entry: fingerprint and validity read from the certificate itself. */
export const certificateOf = (
  pem: string,
): Effect.Effect<SamlRecords.IdpCertificate, InvalidSamlConnection> =>
  Effect.try({
    try: () => {
      const certificate = new X509Certificate(pem);
      if (certificate.publicKey.asymmetricKeyType !== "rsa") {
        throw invalid("a signing certificate must carry an RSA key");
      }
      if ((certificate.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
        throw invalid("a signing certificate's RSA key must be at least 2048 bits");
      }
      return {
        pem: certificate.toString(),
        fingerprint: certificate.fingerprint256.replaceAll(":", "").toLowerCase(),
        notBefore: DateTime.makeUnsafe(certificate.validFromDate),
        notAfter: DateTime.makeUnsafe(certificate.validToDate),
      };
    },
    catch: (cause) =>
      cause instanceof InvalidSamlConnection
        ? cause
        : invalid("a certificate is not a valid X.509 certificate"),
  });

/** The record's certificates as the port's trust set. */
export const trustSetOf = (record: SamlRecords.ConnectionRecord): XmlSignature.TrustSet => ({
  certificates: record.idpCertificates.map((certificate) => ({
    fingerprint: certificate.fingerprint,
    pem: certificate.pem,
    notBefore: certificate.notBefore,
    notAfter: certificate.notAfter,
  })),
});

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const normalizeDomains = (domains: ReadonlyArray<string>) => {
  const normalized = Array.from(new Set(domains.map((domain) => domain.trim().toLowerCase())));
  const bad = normalized.find((domain) => !DOMAIN.test(domain));
  return bad === undefined
    ? Effect.succeed(normalized)
    : Effect.fail(invalid(`"${bad}" is not a valid email domain`));
};

export type IdpSource =
  | { readonly metadataXml: string }
  | {
      readonly entityId: string;
      readonly ssoUrl: string;
      /** PEM certificates: the trust set. At least one. */
      readonly certificates: ReadonlyArray<string>;
    };

export interface SamlConnectionStoreShape {
  readonly create: (input: {
    readonly organizationId: string;
    readonly name: string;
    readonly idp: IdpSource;
    readonly emailDomains?: ReadonlyArray<string> | undefined;
    /** BEH-EA-245: allow first sign-ins to link to an existing local account with a verified matching email. Default false. */
    readonly trustsEmail?: boolean | undefined;
  }) => Effect.Effect<
    SamlRecords.ConnectionRecord,
    InvalidSamlConnection | SamlRecords.SamlDomainTaken
  >;
  readonly get: (id: string) => Effect.Effect<SamlRecords.ConnectionRecord, SamlConnectionNotFound>;
  readonly list: (
    organizationId: string,
  ) => Effect.Effect<ReadonlyArray<SamlRecords.ConnectionRecord>>;
  /** Fields left out are unchanged; `certificates`, when given, REPLACES the trust set (that is how a rotation retires the old key). */
  readonly update: (
    id: string,
    patch: {
      readonly name?: string | undefined;
      readonly entityId?: string | undefined;
      readonly ssoUrl?: string | undefined;
      readonly certificates?: ReadonlyArray<string> | undefined;
      readonly emailDomains?: ReadonlyArray<string> | undefined;
      readonly trustsEmail?: boolean | undefined;
    },
  ) => Effect.Effect<
    SamlRecords.ConnectionRecord,
    InvalidSamlConnection | SamlConnectionNotFound | SamlRecords.SamlDomainTaken
  >;
  readonly remove: (id: string) => Effect.Effect<void, SamlConnectionNotFound>;
  /**
   * Home-realm discovery: the connection an organization id (its first-created one) or an email's domain routes
   * to. `None` when there is none — the caller falls back to another way in.
   */
  readonly discover: (hint: {
    readonly organizationId?: string | undefined;
    readonly email?: string | undefined;
  }) => Effect.Effect<Option.Option<string>>;
}

export class SamlConnectionStore extends Context.Service<
  SamlConnectionStore,
  SamlConnectionStoreShape
>()("awthaq/saml/SamlConnectionStore") {}

/** Requires `SamlRecords`, `OrganizationRecords`, `Crypto` and `SamlConfig`. */
export const layerStore = Layer.effect(
  SamlConnectionStore,
  Effect.gen(function* () {
    const records = yield* SamlRecords.SamlRecords;
    const orgs = yield* OrganizationRecords.OrganizationRecords;
    const crypto = yield* Crypto.Crypto;
    const settings = yield* SamlConfig.SamlConfig;

    const validatedSsoUrl = (ssoUrl: string) => {
      const problem = OutboundUrl.problem("ssoUrl", ssoUrl, {
        allowPrivate: settings.allowPrivateTargets,
      });
      return Option.isSome(problem) ? Effect.fail(invalid(problem.value)) : Effect.succeed(ssoUrl);
    };

    const certificatesOf = (pems: ReadonlyArray<string>) =>
      pems.length === 0
        ? Effect.fail(invalid("at least one IdP signing certificate is required"))
        : Effect.forEach(pems, certificateOf).pipe(
            // The same certificate listed twice is one trust entry.
            Effect.map((all) =>
              all.filter(
                (entry, index) =>
                  all.findIndex((other) => other.fingerprint === entry.fingerprint) === index,
              ),
            ),
          );

    const resolveIdp = Effect.fnUntraced(function* (idp: IdpSource) {
      if ("metadataXml" in idp) {
        const metadata = yield* parseIdpMetadata(idp.metadataXml).pipe(
          Effect.mapError((error) =>
            invalid(
              error._tag === "InvalidMetadata" ? error.detail : "the metadata could not be read",
            ),
          ),
        );
        return {
          entityId: metadata.entityId,
          ssoUrl: metadata.ssoUrl,
          certificates: metadata.certificates,
        };
      }
      return { entityId: idp.entityId, ssoUrl: idp.ssoUrl, certificates: idp.certificates };
    });

    const create: SamlConnectionStoreShape["create"] = Effect.fnUntraced(function* (input) {
      const organization = yield* orgs.findById(input.organizationId);
      if (Option.isNone(organization))
        return yield* Effect.fail(invalid("the organization does not exist"));
      const name = input.name.trim();
      if (name === "") return yield* Effect.fail(invalid("a connection needs a name"));
      const idp = yield* resolveIdp(input.idp);
      if (idp.entityId.trim() === "")
        return yield* Effect.fail(invalid("the IdP entity id is empty"));
      const ssoUrl = yield* validatedSsoUrl(idp.ssoUrl);
      const idpCertificates = yield* certificatesOf(idp.certificates);
      const emailDomains = yield* normalizeDomains(input.emailDomains ?? []);
      const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
      return yield* records.create({
        id,
        organizationId: input.organizationId,
        name,
        idpEntityId: idp.entityId.trim(),
        ssoUrl,
        idpCertificates,
        emailDomains,
        trustsEmail: input.trustsEmail ?? false,
      });
    });

    const get: SamlConnectionStoreShape["get"] = (id) =>
      records.findById(id).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new SamlConnectionNotFound({ id })),
            onSome: Effect.succeed,
          }),
        ),
      );

    const update: SamlConnectionStoreShape["update"] = Effect.fnUntraced(function* (id, patch) {
      yield* get(id);
      const ssoUrl = patch.ssoUrl === undefined ? undefined : yield* validatedSsoUrl(patch.ssoUrl);
      const idpCertificates =
        patch.certificates === undefined ? undefined : yield* certificatesOf(patch.certificates);
      const emailDomains =
        patch.emailDomains === undefined ? undefined : yield* normalizeDomains(patch.emailDomains);
      if (patch.entityId !== undefined && patch.entityId.trim() === "") {
        return yield* Effect.fail(invalid("the IdP entity id is empty"));
      }
      return yield* records
        .update(id, {
          name: patch.name?.trim(),
          idpEntityId: patch.entityId?.trim(),
          ssoUrl,
          idpCertificates,
          emailDomains,
          trustsEmail: patch.trustsEmail,
        })
        .pipe(
          Effect.catchTag("SamlRecordNotFound", () =>
            Effect.fail(new SamlConnectionNotFound({ id })),
          ),
        );
    });

    const discover: SamlConnectionStoreShape["discover"] = Effect.fnUntraced(function* (hint) {
      if (hint.organizationId !== undefined) {
        const [first] = yield* records.listByOrganization(hint.organizationId);
        if (first !== undefined) return Option.some(first.id);
      }
      const domain = hint.email?.split("@")[1]?.trim().toLowerCase();
      if (domain === undefined || domain === "") return Option.none<string>();
      return Option.map(yield* records.findByDomain(domain), (record) => record.id);
    });

    return SamlConnectionStore.of({
      create,
      get,
      list: records.listByOrganization,
      update,
      remove: (id) =>
        records
          .remove(id)
          .pipe(
            Effect.catchTag("SamlRecordNotFound", () =>
              Effect.fail(new SamlConnectionNotFound({ id })),
            ),
          ),
      discover,
    });
  }),
);
