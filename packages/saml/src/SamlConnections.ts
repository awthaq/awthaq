// @awthaq/saml — SamlConnections
//
// spec/models/10-saml.md, BEH-EA-241/305/307/309: the write side of an organization's SAML connections —
// `SamlConnectionStore`, which the administrator's HTTP surface (`saml.admin`, BEH-EA-309) and an application call. It validates
// everything an organization supplies, because an IdP description is exactly the input that decides whose signatures this
// server believes:
//
//   - the SSO URL and the single-logout URL are https without credentials (`OutboundUrl`; the browser is redirected there, this
//     server never fetches them, but a `javascript:` or `http:` URL has no business in a redirect);
//   - each certificate is parsed as X.509, RSA of at least 2048 bits (the only key type the XML-DSig adapter
//     verifies), and stored with its SHA-256 fingerprint and its own validity window — the trust set that pins the
//     signer and lets a rotation overlap (add the next certificate before the IdP starts using it, remove the old
//     one after);
//   - the organization must exist;
//   - an email domain routes to exactly one connection;
//   - a connection that signs its AuthnRequests has an SP signing key (generated when there is none, BEH-EA-305);
//   - a role mapping names only roles the organization has, confers no more than its ceiling (the `canGrant` rule of RRM-001,
//     `Organization.checkRoleCeiling`), and mentions `owner` only where the deployment allowed it (BEH-EA-307).
//
// An IdP's metadata can be imported (`idp: { metadataXml }`, or fetched by the caller from a URL and passed the same way) and
// refreshed (`refreshMetadata`): the certificates it lists become the trust set. That is exactly as trustworthy as the channel
// the metadata arrived by (TLS from the IdP's own URL, through the SSRF-safe pinned fetcher, or pasted from its administrator);
// what gets pinned afterwards is the fingerprint, not the document.

import { Organization, OrganizationRecords } from "@awthaq/organization";
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
import * as SamlRoleMapping from "./SamlRoleMapping.ts";
import * as SamlSpKeys from "./SamlSpKeys.ts";

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
      /** The IdP's single-logout endpoint, if it has one. */
      readonly sloUrl?: string | undefined;
      readonly sloBinding?: SamlRecords.SloBinding | undefined;
    };

const MAX_RULES = 50;
const MAX_NAME = 255;

export interface SamlConnectionStoreShape {
  readonly create: (input: {
    readonly organizationId: string;
    readonly name: string;
    readonly idp: IdpSource;
    readonly emailDomains?: ReadonlyArray<string> | undefined;
    /** BEH-EA-245: allow first sign-ins to link to an existing local account with a verified matching email. Default false. */
    readonly trustsEmail?: boolean | undefined;
    /** BEH-EA-305: sign AuthnRequests. Default: what the IdP's metadata asks for (`WantAuthnRequestsSigned`), else false. */
    readonly authnRequestsSigned?: boolean | undefined;
    /** Overrides the single-logout endpoint the metadata offered (or supplies one for a hand-made connection). */
    readonly sloUrl?: string | undefined;
    readonly sloBinding?: SamlRecords.SloBinding | undefined;
    /** BEH-EA-309: where the metadata was fetched from, kept so it can be refreshed. */
    readonly metadataUrl?: string | undefined;
    /** BEH-EA-307. */
    readonly roleMapping?: SamlRecords.RoleMapping | undefined;
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
      readonly authnRequestsSigned?: boolean | undefined;
      /** `null` removes the single-logout endpoint. */
      readonly sloUrl?: string | null | undefined;
      readonly sloBinding?: SamlRecords.SloBinding | undefined;
      readonly metadataUrl?: string | null | undefined;
      readonly roleMapping?: SamlRecords.RoleMapping | undefined;
    },
  ) => Effect.Effect<
    SamlRecords.ConnectionRecord,
    InvalidSamlConnection | SamlConnectionNotFound | SamlRecords.SamlDomainTaken
  >;
  /**
   * BEH-EA-309: re-reads the IdP's metadata (fetched by the caller) into the connection: the trust set is REPLACED by the
   * certificates it lists, and the SSO and single-logout endpoints follow. The metadata must name the connection's own entity
   * id (an IdP whose identity changed is a new connection, not a refresh).
   */
  readonly refreshMetadata: (
    id: string,
    metadataXml: string,
  ) => Effect.Effect<SamlRecords.ConnectionRecord, InvalidSamlConnection | SamlConnectionNotFound>;
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

/** Requires `SamlRecords`, `OrganizationRecords`, the `Organization` service, `SamlSpKeys`, `Crypto` and `SamlConfig`. */
export const layerStore = Layer.effect(
  SamlConnectionStore,
  Effect.gen(function* () {
    const records = yield* SamlRecords.SamlRecords;
    const orgs = yield* OrganizationRecords.OrganizationRecords;
    const organization = yield* Organization.Organization;
    const spKeys = yield* SamlSpKeys.SamlSpKeys;
    const crypto = yield* Crypto.Crypto;
    const settings = yield* SamlConfig.SamlConfig;

    const validatedUrl = (field: string, url: string) => {
      const problem = OutboundUrl.problem(field, url, {
        allowPrivate: settings.allowPrivateTargets,
      });
      return Option.isSome(problem) ? Effect.fail(invalid(problem.value)) : Effect.succeed(url);
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

    const metadataOf = (xml: string) =>
      parseIdpMetadata(xml).pipe(
        Effect.mapError((error) =>
          invalid(
            error._tag === "InvalidMetadata" ? error.detail : "the metadata could not be read",
          ),
        ),
      );

    /** BEH-EA-307: the mapping is well-formed, names only roles the organization has, and confers no more than its ceiling. */
    const validatedRoleMapping = Effect.fnUntraced(function* (
      organizationId: string,
      mapping: SamlRecords.RoleMapping,
    ) {
      if (mapping.rules.length > MAX_RULES)
        return yield* Effect.fail(invalid(`at most ${MAX_RULES} role rules`));
      if (mapping.ceiling.length === 0) {
        return yield* Effect.fail(
          invalid("a role mapping needs a ceiling (the roles it may confer at most)"),
        );
      }
      for (const rule of mapping.rules) {
        if (rule.attribute.trim() === "" || rule.attribute.length > MAX_NAME) {
          return yield* Effect.fail(
            invalid("a role rule needs an attribute name of 1 to 255 characters"),
          );
        }
        if (rule.value !== undefined && (rule.value === "" || rule.value.length > MAX_NAME)) {
          return yield* Effect.fail(
            invalid("a role rule's value is 1 to 255 characters, or absent to match any value"),
          );
        }
        if (rule.roles.length === 0) {
          return yield* Effect.fail(invalid("a role rule needs at least one role"));
        }
      }
      if (SamlRoleMapping.mentionsOwner(mapping) && !settings.allowOwnerRoleMapping) {
        return yield* Effect.fail(
          invalid("a role mapping may not confer owner (allowOwnerRoleMapping is off)"),
        );
      }
      const conferred = [
        ...new Set([...mapping.rules.flatMap((rule) => rule.roles), ...mapping.defaultRoles]),
      ];
      const verdict = yield* organization
        .checkRoleCeiling({ organizationId, roles: conferred, ceiling: mapping.ceiling })
        .pipe(
          Effect.catchTag("OrganizationNotFound", () =>
            Effect.fail(invalid("the organization does not exist")),
          ),
        );
      if (Option.isSome(verdict)) {
        return yield* Effect.fail(
          invalid(
            verdict.value === "unknownRole"
              ? "a role rule names a role the organization does not have"
              : verdict.value === "unknownCeiling"
                ? "the role ceiling names a role the organization does not have"
                : "a role rule confers more than the connection's role ceiling",
          ),
        );
      }
      return mapping;
    });

    /** BEH-EA-305: a connection that signs has a key. Generated when there is none; a present key is never replaced here. */
    const ensureSigningKey = (connection: SamlRecords.ConnectionRecord) =>
      connection.authnRequestsSigned
        ? spKeys.list(connection.id).pipe(
            Effect.flatMap((keys) =>
              keys.length > 0 ? Effect.void : Effect.asVoid(spKeys.generate(connection.id)),
            ),
            Effect.catchTag("InvalidSigningKey", Effect.die),
          )
        : Effect.void;

    const create: SamlConnectionStoreShape["create"] = Effect.fnUntraced(function* (input) {
      const found = yield* orgs.findById(input.organizationId);
      if (Option.isNone(found))
        return yield* Effect.fail(invalid("the organization does not exist"));
      const name = input.name.trim();
      if (name === "") return yield* Effect.fail(invalid("a connection needs a name"));
      const idp =
        "metadataXml" in input.idp
          ? yield* Effect.map(metadataOf(input.idp.metadataXml), (metadata) => ({
              entityId: metadata.entityId,
              ssoUrl: metadata.ssoUrl,
              certificates: metadata.certificates,
              sloUrl: metadata.slo?.url,
              sloBinding: metadata.slo?.binding,
              wantsSignedRequests: metadata.wantsSignedRequests,
            }))
          : {
              entityId: input.idp.entityId,
              ssoUrl: input.idp.ssoUrl,
              certificates: input.idp.certificates,
              sloUrl: input.idp.sloUrl,
              sloBinding: input.idp.sloBinding,
              wantsSignedRequests: false,
            };
      if (idp.entityId.trim() === "")
        return yield* Effect.fail(invalid("the IdP entity id is empty"));
      const ssoUrl = yield* validatedUrl("ssoUrl", idp.ssoUrl);
      const sloUrlRaw = input.sloUrl ?? idp.sloUrl;
      const sloUrl = sloUrlRaw === undefined ? undefined : yield* validatedUrl("sloUrl", sloUrlRaw);
      const idpCertificates = yield* certificatesOf(idp.certificates);
      const emailDomains = yield* normalizeDomains(input.emailDomains ?? []);
      const roleMapping =
        input.roleMapping === undefined
          ? undefined
          : yield* validatedRoleMapping(input.organizationId, input.roleMapping);
      const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
      const created = yield* records.create({
        id,
        organizationId: input.organizationId,
        name,
        idpEntityId: idp.entityId.trim(),
        ssoUrl,
        idpCertificates,
        emailDomains,
        trustsEmail: input.trustsEmail ?? false,
        authnRequestsSigned: input.authnRequestsSigned ?? idp.wantsSignedRequests,
        sloUrl,
        sloBinding:
          input.sloBinding ?? (sloUrl === idp.sloUrl ? idp.sloBinding : undefined) ?? "redirect",
        metadataUrl: input.metadataUrl,
        roleMapping,
      });
      yield* ensureSigningKey(created);
      return created;
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
      const current = yield* get(id);
      const ssoUrl =
        patch.ssoUrl === undefined ? undefined : yield* validatedUrl("ssoUrl", patch.ssoUrl);
      const sloUrl =
        patch.sloUrl === undefined || patch.sloUrl === null
          ? patch.sloUrl
          : yield* validatedUrl("sloUrl", patch.sloUrl);
      const idpCertificates =
        patch.certificates === undefined ? undefined : yield* certificatesOf(patch.certificates);
      const emailDomains =
        patch.emailDomains === undefined ? undefined : yield* normalizeDomains(patch.emailDomains);
      if (patch.entityId !== undefined && patch.entityId.trim() === "") {
        return yield* Effect.fail(invalid("the IdP entity id is empty"));
      }
      const roleMapping =
        patch.roleMapping === undefined
          ? undefined
          : yield* validatedRoleMapping(current.organizationId, patch.roleMapping);
      const updated = yield* records
        .update(id, {
          name: patch.name?.trim(),
          idpEntityId: patch.entityId?.trim(),
          ssoUrl,
          idpCertificates,
          emailDomains,
          trustsEmail: patch.trustsEmail,
          authnRequestsSigned: patch.authnRequestsSigned,
          sloUrl,
          sloBinding: patch.sloBinding,
          metadataUrl: patch.metadataUrl,
          roleMapping,
        })
        .pipe(
          Effect.catchTag("SamlRecordNotFound", () =>
            Effect.fail(new SamlConnectionNotFound({ id })),
          ),
        );
      yield* ensureSigningKey(updated);
      return updated;
    });

    const refreshMetadata: SamlConnectionStoreShape["refreshMetadata"] = Effect.fnUntraced(
      function* (id, metadataXml) {
        const current = yield* get(id);
        const metadata = yield* metadataOf(metadataXml);
        if (metadata.entityId !== current.idpEntityId) {
          return yield* Effect.fail(
            invalid(
              "the metadata names another entity id: an IdP whose identity changed is a new connection",
            ),
          );
        }
        const ssoUrl = yield* validatedUrl("ssoUrl", metadata.ssoUrl);
        const sloUrl =
          metadata.slo === undefined ? null : yield* validatedUrl("sloUrl", metadata.slo.url);
        const idpCertificates = yield* certificatesOf(metadata.certificates);
        return yield* records
          .update(id, {
            ssoUrl,
            idpCertificates,
            sloUrl,
            ...(metadata.slo === undefined ? {} : { sloBinding: metadata.slo.binding }),
          })
          .pipe(
            Effect.catchTag("SamlRecordNotFound", () =>
              Effect.fail(new SamlConnectionNotFound({ id })),
            ),
            // The update names no email domains, so a domain clash cannot arise here.
            Effect.catchTag("SamlDomainTaken", Effect.die),
          );
      },
    );

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
      refreshMetadata,
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
