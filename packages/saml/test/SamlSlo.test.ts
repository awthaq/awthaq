// BEH-EA-315 (spec/behaviors/29-saml-sp.md): SAML Single Logout, both directions, over the Redirect and POST bindings, with the
// same signature verification as the ACS. The invariant asserted throughout: every refusal is the SAME `SamlLogoutRejected` and
// changes nothing (no session ended, no state consumed by a message that failed), and a valid message ends exactly the sessions
// it names, at the connection it came from, with reason `federatedLogout`.
import { Api } from "@awthaq/api";
import { AuditLog, Sessions, Users } from "@awthaq/core";
import { RateLimiter } from "@awthaq/ports";
import * as Layer from "effect/Layer";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { inflateRawSync } from "node:zlib";
import * as Saml from "../src/Saml.ts";
import * as SamlKeys from "../src/SamlKeys.ts";
import * as SamlProtocol from "../src/SamlProtocol.ts";
import * as SamlRecords from "../src/SamlRecords.ts";
import * as SamlSlo from "../src/SamlSlo.ts";
import * as XmlSignatureNode from "../src/XmlSignatureNode.ts";
import { ALGORITHM, attacker, idp, idpNext, NOW, NS } from "./samlFixtures.ts";
import { certificatesInSpMetadata, redirectParts } from "./samlMetadata.ts";
import {
  atNow,
  BASE_URL,
  idpResponse,
  IDP_ENTITY_ID,
  SamlLive,
  seedConnection,
  startLogin,
} from "./support.ts";
import { X509Certificate } from "node:crypto";

const IDP_SLO = "https://idp.example.com/slo";

const MemoryLimiter = RateLimiter.layer.pipe(
  Layer.provide(
    RateLimiter.layerStoreMemoryWith({ maxBuckets: 1000, sweepInterval: Duration.days(3650) }),
  ),
);

let assertions = 0;
/** A fresh assertion id per sign-in: an assertion is accepted once, so two sign-ins in one test need two. */
const freshAssertionId = () => `_assertion-${(assertions += 1)}`;

const principalOf = (userId: Users.UserId, sessionId: Sessions.SessionId) =>
  new Api.UserPrincipal({ ref: new Api.PrincipalRef({ type: "user", id: userId }), sessionId });
const sloUrlOf = (connectionId: string) => `${BASE_URL}/auth/saml/slo/${connectionId}`;

const iso = (instant: DateTime.Utc) => DateTime.formatIso(instant).replace(/\.\d+Z$/, "Z");

interface LogoutRequestOptions {
  readonly id?: string;
  readonly issuer?: string;
  readonly destination: string;
  readonly nameId?: string;
  readonly sessionIndexes?: ReadonlyArray<string>;
  readonly issueInstant?: DateTime.Utc;
  readonly notOnOrAfter?: DateTime.Utc;
}

const logoutRequestXml = (options: LogoutRequestOptions): string =>
  `<samlp:LogoutRequest xmlns:samlp="${NS.samlp}" xmlns:saml="${NS.saml}" ID="${options.id ?? "_idp-logout-1"}" Version="2.0" ` +
  `IssueInstant="${iso(options.issueInstant ?? NOW)}" Destination="${options.destination}"` +
  (options.notOnOrAfter === undefined ? "" : ` NotOnOrAfter="${iso(options.notOnOrAfter)}"`) +
  `><saml:Issuer>${options.issuer ?? IDP_ENTITY_ID}</saml:Issuer>` +
  `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${options.nameId ?? "ada@acme.example"}</saml:NameID>` +
  (options.sessionIndexes ?? [])
    .map((index) => `<samlp:SessionIndex>${index}</samlp:SessionIndex>`)
    .join("") +
  `</samlp:LogoutRequest>`;

const logoutResponseXml = (options: {
  readonly id?: string;
  readonly destination: string;
  readonly inResponseTo: string;
  readonly issuer?: string;
  readonly issueInstant?: DateTime.Utc;
  readonly success?: boolean;
}): string =>
  `<samlp:LogoutResponse xmlns:samlp="${NS.samlp}" xmlns:saml="${NS.saml}" ID="${options.id ?? "_idp-response-1"}" Version="2.0" ` +
  `IssueInstant="${iso(options.issueInstant ?? NOW)}" Destination="${options.destination}" InResponseTo="${options.inResponseTo}">` +
  `<saml:Issuer>${options.issuer ?? IDP_ENTITY_ID}</saml:Issuer>` +
  `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:${options.success === false ? "Requester" : "Success"}"/></samlp:Status>` +
  `</samlp:LogoutResponse>`;

type Key = { readonly key: string };

/** The IdP's redirect-binding delivery of `xml` (signed by `signer`, unless `unsigned`), as `SloInput` fields. */
const redirectDelivery = (
  connectionId: string,
  kind: "SAMLRequest" | "SAMLResponse",
  xml: string,
  options: {
    readonly signer?: Key;
    readonly unsigned?: boolean;
    readonly relayState?: string;
    readonly cookieState?: string;
  } = {},
): SamlSlo.SloInput => {
  const message = SamlProtocol.deflateBase64(xml);
  const query =
    options.unsigned === true
      ? SamlKeys.plainRedirect({ kind, message, relayState: options.relayState })
      : SamlKeys.signRedirect({
          kind,
          message,
          relayState: options.relayState,
          privateKeyPem: (options.signer ?? idp).key,
        });
  const parts = redirectParts(`https://x/?${query}`);
  return {
    connectionId,
    binding: "redirect",
    rawQuery: query,
    samlRequest: kind === "SAMLRequest" ? decodeURIComponent(parts.message) : undefined,
    samlResponse: kind === "SAMLResponse" ? decodeURIComponent(parts.message) : undefined,
    relayState: options.relayState,
    cookieState: options.cookieState,
    ip: undefined,
  };
};

/** The IdP's POST-binding delivery: an enveloped XML signature over the message root. */
const postDelivery = (
  connectionId: string,
  kind: "SAMLRequest" | "SAMLResponse",
  xml: string,
  referenceId: string,
  options: {
    readonly signer?: Key;
    readonly unsigned?: boolean;
    readonly cookieState?: string;
  } = {},
): SamlSlo.SloInput => {
  const signed =
    options.unsigned === true
      ? xml
      : SamlKeys.signXml({ xml, referenceId, privateKeyPem: (options.signer ?? idp).key });
  const encoded = Buffer.from(signed, "utf8").toString("base64");
  return {
    connectionId,
    binding: "post",
    rawQuery: undefined,
    samlRequest: kind === "SAMLRequest" ? encoded : undefined,
    samlResponse: kind === "SAMLResponse" ? encoded : undefined,
    relayState: undefined,
    cookieState: options.cookieState,
    ip: undefined,
  };
};

const slo = (input: SamlSlo.SloInput) => Effect.flatMap(Saml.Saml, (saml) => saml.slo(input));

/** A user signed in through `connectionId`, as the browser would: the session and the user it belongs to. */
const signIn = (connectionId: string, options: { readonly assertionId?: string } = {}) =>
  Effect.gen(function* () {
    const saml = yield* Saml.Saml;
    const started = yield* startLogin(connectionId);
    const outcome = yield* saml.acs({
      samlResponse: idpResponse(started, connectionId, {
        assertionId: options.assertionId ?? "_a1",
      }),
      cookieState: started.state,
    });
    return { sessionId: outcome.session.session.id, userId: outcome.session.session.userId };
  });

const isLive = (userId: Users.UserId, sessionId: Sessions.SessionId) =>
  Effect.flatMap(Sessions.Sessions, (sessions) => sessions.isLive(userId, sessionId));

const revocations = Effect.flatMap(AuditLog.AuditLog, (auditLog) =>
  auditLog.list({ eventTag: "auth.session.revoked" }),
).pipe(
  Effect.map((rows) =>
    rows.flatMap((row) =>
      row.payload._tag === "auth.session.revoked"
        ? [{ reason: row.payload.reason, sessionId: row.payload.sessionId, tenantId: row.tenantId }]
        : [],
    ),
  ),
);

const rejectedAs = (input: SamlSlo.SloInput) =>
  slo(input).pipe(
    Effect.flip,
    Effect.map((failure) => failure._tag),
  );

/** Parses the LogoutResponse the SP sent the IdP over the redirect binding, verifying its signature under the SP's certificate. */
const readSpResponse = (location: string, spCertificates: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const parts = redirectParts(location);
    const xml = inflateRawSync(Buffer.from(decodeURIComponent(parts.message), "base64")).toString(
      "utf8",
    );
    const now = yield* DateTime.now;
    const signed =
      parts.octets !== undefined &&
      parts.signature !== undefined &&
      parts.sigAlg !== undefined &&
      SamlKeys.verifyRedirect({
        octets: parts.octets,
        signature: parts.signature,
        sigAlg: parts.sigAlg,
        trust: {
          certificates: spCertificates.map((pem) => {
            const certificate = new X509Certificate(pem);
            return {
              fingerprint: certificate.fingerprint256.replaceAll(":", "").toLowerCase(),
              pem,
              notBefore: DateTime.makeUnsafe(certificate.validFromDate),
              notAfter: DateTime.makeUnsafe(certificate.validToDate),
            };
          }),
        },
        now,
      });
    return { xml, signed, endpoint: location.slice(0, location.indexOf("?")) };
  });

describe("an IdP-initiated LogoutRequest over the Redirect binding", () => {
  it.effect(
    "ends the sessions the NameID has at that connection, with reason federatedLogout, and answers Success",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const saml = yield* Saml.Saml;
        const { connection, organizationId } = yield* seedConnection({
          sloUrl: IDP_SLO,
          authnRequestsSigned: true,
        });
        const { sessionId, userId } = yield* signIn(connection.id);
        assert.isTrue(yield* isLive(userId, sessionId));
        const outcome = yield* slo(
          redirectDelivery(
            connection.id,
            "SAMLRequest",
            logoutRequestXml({ destination: sloUrlOf(connection.id) }),
            { relayState: "idp-state" },
          ),
        );
        assert.isFalse(yield* isLive(userId, sessionId));
        assert.strictEqual(outcome._tag, "redirect");
        if (outcome._tag !== "redirect") return;
        const spCertificates = certificatesInSpMetadata(yield* saml.metadata(connection.id));
        const answered = yield* readSpResponse(outcome.location, spCertificates);
        assert.strictEqual(answered.endpoint, IDP_SLO);
        assert.isTrue(answered.signed, "the answer is signed with the SP key the connection has");
        assert.include(answered.xml, "<samlp:LogoutResponse");
        assert.include(answered.xml, 'InResponseTo="_idp-logout-1"');
        assert.include(answered.xml, "status:Success");
        assert.include(
          answered.xml,
          `<saml:Issuer>https://sp.example.com/auth/saml/sp/${connection.id}</saml:Issuer>`,
        );
        assert.include(answered.xml, `Destination="${IDP_SLO}"`);
        // RelayState is echoed back to the IdP.
        assert.strictEqual(redirectParts(outcome.location).relay, "idp-state");
        // The revocation names its reason, and is stamped with the connection's organization as tenant.
        const ended = (yield* revocations).filter((row) => row.reason === "federatedLogout");
        assert.strictEqual(ended.length, 1);
        assert.deepStrictEqual(ended[0]?.tenantId, Option.some(organizationId));
        // The row the connection kept for it is gone.
        const records = yield* SamlRecords.SamlRecords;
        assert.isTrue(Option.isNone(yield* records.findSession(sessionId)));
      }).pipe(Effect.provide(SamlLive())),
  );

  it.effect(
    "names no more than it means to: a SessionIndex ends that session only; another NameID's sessions are untouched",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const records = yield* SamlRecords.SamlRecords;
        const sessions = yield* Sessions.Sessions;
        const { connection } = yield* seedConnection({ sloUrl: IDP_SLO });
        const one = yield* signIn(connection.id);
        // A second session of the same NameID with a different SessionIndex, and a third of somebody else.
        const second = yield* sessions.issue({ userId: one.userId, request: {} });
        yield* records.saveSession({
          sessionId: second.session.id,
          connectionId: connection.id,
          nameId: "ada@acme.example",
          sessionIndex: "idx-2",
        });
        const other = yield* sessions.issue({ userId: one.userId, request: {} });
        yield* records.saveSession({
          sessionId: other.session.id,
          connectionId: connection.id,
          nameId: "grace@acme.example",
          sessionIndex: "idx-3",
        });
        yield* slo(
          redirectDelivery(
            connection.id,
            "SAMLRequest",
            logoutRequestXml({ destination: sloUrlOf(connection.id), sessionIndexes: ["idx-2"] }),
          ),
        );
        assert.isFalse(yield* isLive(one.userId, second.session.id));
        assert.isTrue(
          yield* isLive(one.userId, one.sessionId),
          "the other SessionIndex of the same NameID stays",
        );
        assert.isTrue(
          yield* isLive(one.userId, other.session.id),
          "another NameID's session stays",
        );
        // Without a SessionIndex: every session of that NameID at the connection.
        yield* slo(
          redirectDelivery(
            connection.id,
            "SAMLRequest",
            logoutRequestXml({ id: "_idp-logout-2", destination: sloUrlOf(connection.id) }),
          ),
        );
        assert.isFalse(yield* isLive(one.userId, one.sessionId));
        assert.isTrue(yield* isLive(one.userId, other.session.id));
      }).pipe(Effect.provide(SamlLive())),
  );

  it.effect(
    "a NameID with no sessions is still answered Success (idempotent, and no oracle for which identities are signed in)",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const { connection } = yield* seedConnection({ sloUrl: IDP_SLO });
        const outcome = yield* slo(
          redirectDelivery(
            connection.id,
            "SAMLRequest",
            logoutRequestXml({
              destination: sloUrlOf(connection.id),
              nameId: "nobody@acme.example",
            }),
          ),
        );
        assert.strictEqual(outcome._tag, "redirect");
        assert.deepStrictEqual(yield* revocations, []);
      }).pipe(Effect.provide(SamlLive())),
  );

  it.effect(
    "stays inside the connection it arrived at: the same NameID at another connection is not logged out",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const organization = yield* seedConnection({ sloUrl: IDP_SLO });
        const other = yield* seedConnection({
          organizationId: organization.organizationId,
          name: "Second IdP",
          emailDomains: ["second.example"],
          entityId: "https://idp2.example.com/metadata",
          sloUrl: IDP_SLO,
          // The second IdP signs with the rotation-successor key, so a request signed by the first is not its own.
          certificates: [idpNext.cert],
        });
        const a = yield* signIn(organization.connection.id);
        yield* slo(
          redirectDelivery(
            other.connection.id,
            "SAMLRequest",
            logoutRequestXml({
              destination: sloUrlOf(other.connection.id),
              issuer: "https://idp2.example.com/metadata",
            }),
            { signer: idpNext },
          ),
        );
        assert.isTrue(yield* isLive(a.userId, a.sessionId));
      }).pipe(Effect.provide(SamlLive())),
  );
});

describe("an IdP-initiated LogoutRequest over the POST binding", () => {
  it.effect(
    "is verified by the same XmlSignature port and ends the sessions; the answer is a signed auto-submitting form",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const saml = yield* Saml.Saml;
        const { connection } = yield* seedConnection({
          sloUrl: IDP_SLO,
          sloBinding: "post",
          authnRequestsSigned: true,
        });
        const { sessionId, userId } = yield* signIn(connection.id);
        const outcome = yield* slo(
          postDelivery(
            connection.id,
            "SAMLRequest",
            logoutRequestXml({ destination: sloUrlOf(connection.id) }),
            "_idp-logout-1",
          ),
        );
        assert.isFalse(yield* isLive(userId, sessionId));
        assert.strictEqual(outcome._tag, "postForm");
        if (outcome._tag !== "postForm") return;
        assert.include(outcome.html, `action="${IDP_SLO}"`);
        assert.include(outcome.html, 'name="SAMLResponse"');
        // The form's document is a LogoutResponse signed with the SP key, verifiable through the same port under its metadata certificate.
        const encoded = /name="SAMLResponse" value="([^"]+)"/.exec(outcome.html)?.[1] ?? "";
        const xml = Buffer.from(encoded, "base64").toString("utf8");
        const [pem] = certificatesInSpMetadata(yield* saml.metadata(connection.id));
        const certificate = new X509Certificate(pem ?? "");
        const verified = yield* XmlSignatureNode.verifyAt(
          {
            xml,
            trust: {
              certificates: [
                {
                  fingerprint: certificate.fingerprint256.replaceAll(":", "").toLowerCase(),
                  pem: pem ?? "",
                  notBefore: DateTime.makeUnsafe(certificate.validFromDate),
                  notAfter: DateTime.makeUnsafe(certificate.validToDate),
                },
              ],
            },
            policy: {
              signedElements: [{ namespace: NS.samlp, localName: "LogoutResponse" }],
              exactlyOne: [{ namespace: NS.samlp, localName: "LogoutResponse" }],
              now: NOW,
            },
          },
          NOW,
        );
        assert.include(verified.signedXml, 'InResponseTo="_idp-logout-1"');
      }).pipe(Effect.provide(SamlLive())),
  );
});

describe("every way of getting a logout message wrong is the same refusal, and ends nothing", () => {
  const setup = Effect.gen(function* () {
    yield* atNow;
    const { connection } = yield* seedConnection({ sloUrl: IDP_SLO });
    const session = yield* signIn(connection.id);
    return { connection, session };
  });
  const request = (connectionId: string, overrides: Partial<LogoutRequestOptions> = {}) =>
    logoutRequestXml({ destination: sloUrlOf(connectionId), ...overrides });
  const stillLive = (session: {
    readonly userId: Users.UserId;
    readonly sessionId: Sessions.SessionId;
  }) => isLive(session.userId, session.sessionId);

  it.effect(
    "redirect: unsigned, wrong key, tampered, downgraded algorithm, re-ordered parameters, dropped RelayState",
    () =>
      Effect.gen(function* () {
        const { connection, session } = yield* setup;
        const xml = request(connection.id);
        const good = redirectDelivery(connection.id, "SAMLRequest", xml, { relayState: "r" });
        const tag = (input: SamlSlo.SloInput) => rejectedAs(input);
        // No signature at all: a logout endpoint that accepted these would let anyone end anyone's sessions.
        assert.strictEqual(
          yield* tag(redirectDelivery(connection.id, "SAMLRequest", xml, { unsigned: true })),
          "SamlLogoutRejected",
        );
        // Signed by a key the connection does not trust.
        assert.strictEqual(
          yield* tag(redirectDelivery(connection.id, "SAMLRequest", xml, { signer: attacker })),
          "SamlLogoutRejected",
        );
        // The IdP's own successor key is not in this connection's trust set.
        assert.strictEqual(
          yield* tag(redirectDelivery(connection.id, "SAMLRequest", xml, { signer: idpNext })),
          "SamlLogoutRejected",
        );
        // Tampered message after signing: the signed octets no longer match.
        const parts = redirectParts(`https://x/?${good.rawQuery ?? ""}`);
        const tampered = {
          ...good,
          rawQuery: (good.rawQuery ?? "").replace(parts.message.slice(0, 6), "AAAAAA"),
        };
        assert.strictEqual(yield* tag(tampered), "SamlLogoutRejected");
        // SigAlg downgraded to SHA-1: refused even though the octets look plausible.
        const downgraded = {
          ...good,
          rawQuery: (good.rawQuery ?? "").replace(
            encodeURIComponent(SamlKeys.SIG_ALG_RSA_SHA256),
            encodeURIComponent(ALGORITHM.rsaSha1),
          ),
        };
        assert.strictEqual(yield* tag(downgraded), "SamlLogoutRejected");
        // RelayState dropped or added after signing.
        const noRelay = {
          ...good,
          rawQuery: (good.rawQuery ?? "").replace(/&RelayState=[^&]*/, ""),
        };
        assert.strictEqual(yield* tag(noRelay), "SamlLogoutRejected");
        // No message, both messages.
        assert.strictEqual(yield* tag({ ...good, samlRequest: undefined }), "SamlLogoutRejected");
        assert.strictEqual(
          yield* tag({ ...good, samlResponse: good.samlRequest }),
          "SamlLogoutRejected",
        );
        assert.isTrue(yield* stillLive(session));
      }).pipe(Effect.provide(SamlLive())),
  );

  it.effect(
    "POST: unsigned, wrong key, tampered after signing, duplicated element, a signature over another element, DOCTYPE, a comment in the NameID",
    () =>
      Effect.gen(function* () {
        const { connection, session } = yield* setup;
        const xml = request(connection.id);
        const post = (input: SamlSlo.SloInput) => rejectedAs(input);
        assert.strictEqual(
          yield* post(
            postDelivery(connection.id, "SAMLRequest", xml, "_idp-logout-1", { unsigned: true }),
          ),
          "SamlLogoutRejected",
        );
        assert.strictEqual(
          yield* post(
            postDelivery(connection.id, "SAMLRequest", xml, "_idp-logout-1", { signer: attacker }),
          ),
          "SamlLogoutRejected",
        );
        // Tampered after signing (the NameID swapped for another user's).
        const signed = SamlKeys.signXml({
          xml,
          referenceId: "_idp-logout-1",
          privateKeyPem: idp.key,
        });
        const swapped = signed.replace("ada@acme.example", "grace@acme.example");
        const withRaw = (raw: string): SamlSlo.SloInput => ({
          ...postDelivery(connection.id, "SAMLRequest", xml, "_idp-logout-1"),
          samlRequest: Buffer.from(raw, "utf8").toString("base64"),
        });
        assert.strictEqual(yield* post(withRaw(swapped)), "SamlLogoutRejected");
        // XSW: a validly signed LogoutRequest wrapped with a second, unsigned one: two requests in one document.
        const inner = signed.replace(/^<samlp:LogoutRequest[^>]*>/, (open) => `${open}`);
        const wrapped = signed.replace(
          "</samlp:LogoutRequest>",
          `<samlp:Extensions>${inner.replace(/ID="_idp-logout-1"/, 'ID="_evil"').replace("ada@acme.example", "grace@acme.example")}</samlp:Extensions></samlp:LogoutRequest>`,
        );
        assert.strictEqual(yield* post(withRaw(wrapped)), "SamlLogoutRejected");
        // A signature that verifies but covers a different element than the message root.
        const rootless = signed.replace(
          /^(<samlp:LogoutRequest[^>]*>)(.*)(<\/samlp:LogoutRequest>)$/s,
          (_m, open: string, body: string, close: string) =>
            `${open}<samlp:Extensions><saml:Attribute ID="_other"/></samlp:Extensions>${body}${close}`.replace(
              'ID="_idp-logout-1"',
              'ID="_root"',
            ),
        );
        assert.strictEqual(yield* post(withRaw(rootless)), "SamlLogoutRejected");
        // DOCTYPE/entities are refused before any parser (no XXE), and so is a comment in the NameID.
        assert.strictEqual(
          yield* post(withRaw(`<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>${signed}`)),
          "SamlLogoutRejected",
        );
        assert.strictEqual(
          yield* post(withRaw(signed.replace("ada@acme.example", "ada@<!-- x -->acme.example"))),
          "SamlLogoutRejected",
        );
        // Wrong element type: a signed LogoutResponse presented as a LogoutRequest.
        const response = logoutResponseXml({
          destination: sloUrlOf(connection.id),
          inResponseTo: "_x",
        });
        assert.strictEqual(
          yield* post(postDelivery(connection.id, "SAMLRequest", response, "_idp-response-1")),
          "SamlLogoutRejected",
        );
        assert.isTrue(yield* stillLive(session));
      }).pipe(Effect.provide(SamlLive())),
  );

  it.effect(
    "what a valid signature is not enough for: wrong issuer, wrong destination, stale, expired, replayed",
    () =>
      Effect.gen(function* () {
        const { connection, session } = yield* setup;
        const send = (overrides: Partial<LogoutRequestOptions>) =>
          rejectedAs(
            redirectDelivery(connection.id, "SAMLRequest", request(connection.id, overrides)),
          );
        assert.strictEqual(
          yield* send({ issuer: "https://other-idp.example.com/metadata" }),
          "SamlLogoutRejected",
        );
        // Destination must be exactly THIS connection's logout endpoint: another connection's URL, or none of ours.
        assert.strictEqual(
          yield* send({ destination: sloUrlOf("some-other-connection") }),
          "SamlLogoutRejected",
        );
        assert.strictEqual(
          yield* send({ destination: "https://evil.example.com/slo" }),
          "SamlLogoutRejected",
        );
        // Freshness: an IssueInstant far from now in either direction (a captured request, or a forged future one).
        assert.strictEqual(
          yield* send({ issueInstant: DateTime.subtract(NOW, { minutes: 30 }) }),
          "SamlLogoutRejected",
        );
        assert.strictEqual(
          yield* send({ issueInstant: DateTime.add(NOW, { minutes: 30 }) }),
          "SamlLogoutRejected",
        );
        // NotOnOrAfter in the past.
        assert.strictEqual(
          yield* send({ notOnOrAfter: DateTime.subtract(NOW, { minutes: 10 }) }),
          "SamlLogoutRejected",
        );
        assert.isTrue(yield* stillLive(session));
        // A valid one succeeds ONCE: replaying the captured message does not end the sessions of a fresh sign-in.
        const message = redirectDelivery(
          connection.id,
          "SAMLRequest",
          request(connection.id, { id: "_once" }),
        );
        yield* slo(message);
        assert.isFalse(yield* stillLive(session));
        const again = yield* signIn(connection.id, { assertionId: "_a2" });
        assert.strictEqual(yield* rejectedAs(message), "SamlLogoutRejected");
        assert.isTrue(
          yield* stillLive(again),
          "a replayed LogoutRequest cannot log the user out again",
        );
      }).pipe(Effect.provide(SamlLive())),
  );

  it.effect(
    "refused before anything else: an unknown connection, and one with no logout endpoint",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const { connection } = yield* seedConnection();
        const session = yield* signIn(connection.id);
        const message = (id: string) =>
          redirectDelivery(id, "SAMLRequest", logoutRequestXml({ destination: sloUrlOf(id) }));
        assert.strictEqual(yield* rejectedAs(message("no-such-connection")), "SamlLogoutRejected");
        // This connection has no logout endpoint (its IdP offers none): nothing to answer, so nothing is accepted.
        assert.strictEqual(yield* rejectedAs(message(connection.id)), "SamlLogoutRejected");
        assert.isTrue(yield* isLive(session.userId, session.sessionId));
      }).pipe(Effect.provide(SamlLive())),
  );

  it.effect(
    "every refusal is logged and audited as auth.saml.logoutRejected, and answers with no detail",
    () =>
      Effect.gen(function* () {
        const { connection } = yield* setup;
        const failure = yield* slo(
          redirectDelivery(connection.id, "SAMLRequest", request(connection.id), {
            unsigned: true,
          }),
        ).pipe(Effect.flip);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(failure)), { _tag: "SamlLogoutRejected" });
        const rows = yield* AuditLog.AuditLog.pipe(
          Effect.flatMap((log) => log.list({ eventTag: "auth.saml.logoutRejected" })),
        );
        assert.strictEqual(rows.length, 1);
      }).pipe(Effect.provide(SamlLive())),
  );
});

describe("SP-initiated logout", () => {
  it.effect(
    "ends the local session first, then sends the IdP a signed LogoutRequest naming the NameID and SessionIndex",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const saml = yield* Saml.Saml;
        const { connection } = yield* seedConnection({
          sloUrl: IDP_SLO,
          authnRequestsSigned: true,
        });
        const { sessionId, userId } = yield* signIn(connection.id);
        const started = yield* saml.logout(principalOf(userId, sessionId), { callbackURL: "/bye" });
        assert.isFalse(yield* isLive(userId, sessionId));
        assert.strictEqual(started._tag, "redirect");
        if (started._tag !== "redirect") return;
        const spCertificates = certificatesInSpMetadata(yield* saml.metadata(connection.id));
        const sent = yield* readSpResponse(started.location, spCertificates);
        assert.strictEqual(sent.endpoint, IDP_SLO);
        assert.isTrue(sent.signed);
        assert.include(sent.xml, "<samlp:LogoutRequest");
        assert.include(sent.xml, ">ada@acme.example</saml:NameID>");
        assert.include(sent.xml, "<samlp:SessionIndex>_session1</samlp:SessionIndex>");
        assert.include(sent.xml, `Destination="${IDP_SLO}"`);
        assert.match(Redacted.value(started.state), /^saml-logout:[0-9a-f-]+\.[^.]+$/);
        // The revocation is the user's own sign-out.
        assert.deepStrictEqual(
          (yield* revocations).map((row) => row.reason),
          ["signOut"],
        );
      }).pipe(Effect.provide(SamlLive())),
  );
});

/** Starts an SP-initiated logout and returns what the IdP is told and the cookie state the browser keeps. */
const startLogout = (connectionId: string) =>
  Effect.gen(function* () {
    const saml = yield* Saml.Saml;
    const session = yield* signIn(connectionId, { assertionId: freshAssertionId() });
    const started = yield* saml.logout(principalOf(session.userId, session.sessionId), {
      callbackURL: "/bye",
    });
    if (started._tag === "local")
      return yield* Effect.die(new Error("expected the IdP to be involved"));
    const requestId =
      started._tag === "redirect"
        ? (/ID="([^"]+)"/.exec(
            inflateRawSync(
              Buffer.from(decodeURIComponent(redirectParts(started.location).message), "base64"),
            ).toString("utf8"),
          )?.[1] ?? "")
        : (/ID="([^"]+)"/.exec(
            Buffer.from(
              /name="SAMLRequest" value="([^"]+)"/.exec(started.html)?.[1] ?? "",
              "base64",
            ).toString("utf8"),
          )?.[1] ?? "");
    return { started, requestId, session };
  });

describe("the IdP's LogoutResponse to our own logout", () => {
  it.effect(
    "finishes the logout: consumed once, answering THIS request, and lands on the callback",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const { connection } = yield* seedConnection({ sloUrl: IDP_SLO });
        const { started, requestId } = yield* startLogout(connection.id);
        const state = Redacted.value(started.state);
        const response = logoutResponseXml({
          destination: sloUrlOf(connection.id),
          inResponseTo: requestId,
        });
        const done = yield* slo(
          redirectDelivery(connection.id, "SAMLResponse", response, { cookieState: state }),
        );
        assert.deepStrictEqual(done, { _tag: "done", callbackURL: "/bye" });
        // The state was single-use: the same response again is refused.
        assert.strictEqual(
          yield* rejectedAs(
            redirectDelivery(connection.id, "SAMLResponse", response, { cookieState: state }),
          ),
          "SamlLogoutRejected",
        );
      }).pipe(Effect.provide(SamlLive())),
  );

  it.effect(
    "over the POST binding too (XML signature), including an IdP that reports a failed logout",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const { connection } = yield* seedConnection({ sloUrl: IDP_SLO });
        const { started, requestId } = yield* startLogout(connection.id);
        const response = logoutResponseXml({
          destination: sloUrlOf(connection.id),
          inResponseTo: requestId,
          success: false,
        });
        const done = yield* slo(
          postDelivery(connection.id, "SAMLResponse", response, "_idp-response-1", {
            cookieState: Redacted.value(started.state),
          }),
        );
        // The local session was already ended: a failed status at the IdP is logged, and the user still lands on the callback.
        assert.strictEqual(done._tag, "done");
      }).pipe(Effect.provide(SamlLive())),
  );

  it.effect(
    "is refused: no cookie, another request id, unsigned, wrong key, another connection's state, an expired state",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const organization = yield* seedConnection({ sloUrl: IDP_SLO });
        const { connection } = organization;
        const { started, requestId } = yield* startLogout(connection.id);
        const state = Redacted.value(started.state);
        const answer = (overrides: Partial<Parameters<typeof logoutResponseXml>[0]> = {}) =>
          logoutResponseXml({
            destination: sloUrlOf(connection.id),
            inResponseTo: requestId,
            ...overrides,
          });
        const refused = (input: SamlSlo.SloInput) => rejectedAs(input);
        assert.strictEqual(
          yield* refused(redirectDelivery(connection.id, "SAMLResponse", answer())),
          "SamlLogoutRejected",
        );
        assert.strictEqual(
          yield* refused(
            redirectDelivery(connection.id, "SAMLResponse", answer({ inResponseTo: "_another" }), {
              cookieState: state,
            }),
          ),
          "SamlLogoutRejected",
        );
        // The state of the failed attempt above is consumed, so start again for each of the rest.
        for (const build of [
          (id: string, cookie: string) =>
            redirectDelivery(id, "SAMLResponse", answer({ inResponseTo: id }), {
              cookieState: cookie,
              unsigned: true,
            }),
          (id: string, cookie: string) =>
            redirectDelivery(id, "SAMLResponse", answer({ inResponseTo: id }), {
              cookieState: cookie,
              signer: attacker,
            }),
          (id: string, cookie: string) =>
            redirectDelivery(
              id,
              "SAMLResponse",
              answer({ inResponseTo: id, issuer: "https://other.example.com/m" }),
              { cookieState: cookie },
            ),
          (id: string, cookie: string) =>
            redirectDelivery(
              id,
              "SAMLResponse",
              answer({ inResponseTo: id, destination: "https://evil.example.com/slo" }),
              { cookieState: cookie },
            ),
        ]) {
          const next = yield* startLogout(connection.id);
          const message = build(next.requestId, Redacted.value(next.started.state));
          assert.strictEqual(
            yield* refused({ ...message, connectionId: connection.id }),
            "SamlLogoutRejected",
          );
        }
        // A state minted for one connection presented at another.
        const second = yield* seedConnection({
          organizationId: organization.organizationId,
          name: "Second",
          emailDomains: ["second.example"],
          entityId: "https://idp2.example.com/metadata",
          sloUrl: IDP_SLO,
          certificates: [idpNext.cert],
        });
        const forCross = yield* startLogout(connection.id);
        assert.strictEqual(
          yield* refused(
            redirectDelivery(
              second.connection.id,
              "SAMLResponse",
              logoutResponseXml({
                destination: sloUrlOf(second.connection.id),
                inResponseTo: forCross.requestId,
                issuer: "https://idp2.example.com/metadata",
              }),
              { cookieState: Redacted.value(forCross.started.state), signer: idpNext },
            ),
          ),
          "SamlLogoutRejected",
        );
        // An expired state.
        const expired = yield* startLogout(connection.id);
        yield* TestClock.adjust(Duration.minutes(11));
        assert.strictEqual(
          yield* refused(
            redirectDelivery(
              connection.id,
              "SAMLResponse",
              logoutResponseXml({
                destination: sloUrlOf(connection.id),
                inResponseTo: expired.requestId,
                issueInstant: DateTime.add(NOW, { minutes: 11 }),
              }),
              { cookieState: Redacted.value(expired.started.state) },
            ),
          ),
          "SamlLogoutRejected",
        );
      }).pipe(Effect.provide(SamlLive())),
  );
});

describe("logout without an IdP round trip", () => {
  it.effect(
    "a session with no SAML row, or a connection with no logout endpoint, is a local sign-out",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const saml = yield* Saml.Saml;
        const sessions = yield* Sessions.Sessions;
        const { connection } = yield* seedConnection();
        const session = yield* signIn(connection.id);
        // No sloUrl on the connection: the user is signed out here and sent to the callback.
        const local = yield* saml.logout(principalOf(session.userId, session.sessionId), {
          callbackURL: "/bye",
        });
        assert.deepStrictEqual(local, { _tag: "local", callbackURL: "/bye" });
        assert.isFalse(yield* isLive(session.userId, session.sessionId));
        // A password session (no SAML row at all).
        const plain = yield* sessions.issue({ userId: session.userId, request: {} });
        const alsoLocal = yield* saml.logout(principalOf(session.userId, plain.session.id), {});
        assert.strictEqual(alsoLocal._tag, "local");
        assert.isFalse(yield* isLive(session.userId, plain.session.id));
        // The callback is checked like a login's: a foreign origin falls back to the default.
        const bad = yield* saml.logout(principalOf(session.userId, plain.session.id), {
          callbackURL: "https://evil.example.com/",
        });
        assert.deepStrictEqual(bad, { _tag: "local", callbackURL: "/" });
      }).pipe(Effect.provide(SamlLive())),
  );

  it.effect("a connection whose IdP takes the POST binding is sent an auto-submitting form", () =>
    Effect.gen(function* () {
      yield* atNow;
      const { connection } = yield* seedConnection({
        sloUrl: IDP_SLO,
        sloBinding: "post",
        authnRequestsSigned: true,
      });
      const { started } = yield* startLogout(connection.id);
      assert.strictEqual(started._tag, "postForm");
      if (started._tag !== "postForm") return;
      assert.include(started.html, `action="${IDP_SLO}"`);
      assert.include(started.html, 'name="SAMLRequest"');
      assert.include(started.html, 'onload="document.forms[0].submit()"');
      // The document it carries is a signed LogoutRequest (the SP key exists).
      const encoded = /name="SAMLRequest" value="([^"]+)"/.exec(started.html)?.[1] ?? "";
      assert.include(Buffer.from(encoded, "base64").toString("utf8"), "<ds:Signature");
    }).pipe(Effect.provide(SamlLive())),
  );
});

describe("the logout endpoint's own limits", () => {
  it.effect("is rate limited per source address like the ACS", () =>
    Effect.gen(function* () {
      yield* atNow;
      const { connection } = yield* seedConnection({ sloUrl: IDP_SLO });
      const attempt = () =>
        slo({
          ...redirectDelivery(
            connection.id,
            "SAMLRequest",
            logoutRequestXml({ destination: sloUrlOf(connection.id) }),
            { unsigned: true },
          ),
          ip: "203.0.113.5",
        }).pipe(
          Effect.flip,
          Effect.map((failure) => failure._tag),
        );
      assert.strictEqual(yield* attempt(), "SamlLogoutRejected");
      assert.strictEqual(yield* attempt(), "SamlLogoutRejected");
      assert.strictEqual(yield* attempt(), "RateLimited");
    }).pipe(
      Effect.provide(
        SamlLive(
          {
            rateLimits: {
              login: { limit: 30, window: Duration.minutes(1) },
              acs: { limit: 30, window: Duration.minutes(1) },
              slo: { limit: 2, window: Duration.minutes(1) },
              sso: { limit: 30, window: Duration.minutes(1) },
            },
          },
          MemoryLimiter,
        ),
      ),
    ),
  );
});
