// BEH-EA-240 through 243 (spec/behaviors/29-saml-sp.md): `readAssertion` and `validateAssertion` as pure functions —
// what the signed bytes yield, and every rule the SP applies to them, at its boundaries.
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SamlAssertion from "../src/SamlAssertion.ts";
import { ACS_URL, NOW, responseXml, SP_ENTITY_ID_PREFIX } from "./samlFixtures.ts";

const SP = `${SP_ENTITY_ID_PREFIX}conn-1`;
const IDP = "https://idp.example.com/metadata";

const expectations = (overrides: Partial<SamlAssertion.Expectations> = {}): SamlAssertion.Expectations => ({
  idpEntityId: IDP,
  spEntityId: SP,
  acsUrl: ACS_URL,
  inResponseTo: "_authn1",
  now: NOW,
  skewMillis: 60_000,
  ...overrides,
});

const xmlFor = (options: Parameters<typeof responseXml>[0] = {}) => responseXml({ audience: SP, issuer: IDP, ...options });

/** The reason a check names, or `"ok"`. */
const judge = (xml: string, expected = expectations()) =>
  SamlAssertion.readAssertion(xml).pipe(
    Effect.flatMap((assertion) => SamlAssertion.validateAssertion(assertion, expected)),
    Effect.map(() => "ok"),
    Effect.catchTag("AssertionInvalid", (error) => Effect.succeed(error.reason)),
  );

describe("readAssertion: only what the signed bytes say", () => {
  it.effect("reads issuer, NameID, confirmations, conditions, attributes, session index", () =>
    Effect.gen(function* () {
      const assertion = yield* SamlAssertion.readAssertion(xmlFor());
      assert.strictEqual(assertion.id, "_assert1");
      assert.strictEqual(assertion.issuer, IDP);
      assert.deepStrictEqual(assertion.nameId, {
        value: "ada@acme.example",
        format: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
      });
      assert.strictEqual(assertion.confirmations.length, 1);
      assert.strictEqual(assertion.confirmations[0]?.recipient, ACS_URL);
      assert.strictEqual(assertion.confirmations[0]?.inResponseTo, "_authn1");
      assert.deepStrictEqual(assertion.audienceRestrictions, [[SP]]);
      assert.deepStrictEqual(assertion.attributes["groups"], ["eng", "admins"]);
      assert.strictEqual(assertion.sessionIndex, "_session1");
      assert.strictEqual(DateTime.toEpochMillis(assertion.notOnOrAfter ?? NOW), Date.UTC(2026, 8, 29, 12, 5));
    }),
  );

  it.effect("a Response root contributes its status and destination", () =>
    Effect.gen(function* () {
      const assertion = yield* SamlAssertion.readAssertion(xmlFor());
      assert.isTrue(assertion.responseSucceeded);
      assert.strictEqual(assertion.responseDestination, ACS_URL);
      const failed = yield* SamlAssertion.readAssertion(
        xmlFor().replace("urn:oasis:names:tc:SAML:2.0:status:Success", "urn:oasis:names:tc:SAML:2.0:status:Requester"),
      );
      assert.isFalse(failed.responseSucceeded);
    }),
  );

  it.effect("refuses non-UTC and malformed times rather than guessing", () =>
    Effect.gen(function* () {
      for (const bad of ["2026-09-29T12:05:00+02:00", "2026-09-29", "yesterday", "2026-13-40T99:99:99Z"]) {
        const reason = yield* judge(xmlFor({ notOnOrAfter: bad }));
        assert.strictEqual(reason, "malformedTime", bad);
      }
    }),
  );

  it.effect("refuses an assertion with no Issuer, no NameID, or an unknown condition", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* judge(xmlFor().replaceAll(/<saml:Issuer>[^<]*<\/saml:Issuer>/g, "")), "noIssuer");
      assert.strictEqual(yield* judge(xmlFor().replace(/<saml:NameID [^>]*>[^<]*<\/saml:NameID>/, "")), "noNameId");
      assert.strictEqual(
        yield* judge(xmlFor().replace("</saml:Conditions>", `<saml:Condition xsi:type="x" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/></saml:Conditions>`)),
        "unknownCondition",
      );
      // OneTimeUse and ProxyRestriction are understood.
      assert.strictEqual(yield* judge(xmlFor().replace("</saml:Conditions>", "<saml:OneTimeUse/></saml:Conditions>")), "ok");
    }),
  );

  it.effect("signed content that is itself hostile (a DOCTYPE, a comment) is unreadable", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* judge(`<!DOCTYPE x>${xmlFor()}`), "signedContentUnreadable");
      assert.strictEqual(yield* judge(xmlFor().replace("ada@acme.example", "ada@acme.example<!---->.evil")), "signedContentUnreadable");
    }),
  );
});

describe("validateAssertion: BEH-EA-241 through 243, each at its boundary", () => {
  it.effect("a well-formed assertion for this SP, ACS and request passes", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* judge(xmlFor()), "ok");
    }),
  );

  it.effect("the issuer must equal the connection's IdP exactly", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* judge(xmlFor({ issuer: `${IDP}/` })), "issuerMismatch");
      assert.strictEqual(yield* judge(xmlFor({ issuer: IDP.toUpperCase() })), "issuerMismatch");
    }),
  );

  it.effect("every AudienceRestriction must name this SP; none is refused", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* judge(xmlFor({ audience: "https://other-sp.example.com" })), "audienceMismatch");
      // Two restrictions are ANDed: one naming the SP is not enough.
      const two = xmlFor().replace(
        "</saml:AudienceRestriction>",
        `</saml:AudienceRestriction><saml:AudienceRestriction><saml:Audience>https://other-sp.example.com</saml:Audience></saml:AudienceRestriction>`,
      );
      assert.strictEqual(yield* judge(two), "audienceMismatch");
      // An unrestricted assertion is valid for every SP the IdP serves: refused.
      assert.strictEqual(yield* judge(xmlFor().replace(/<saml:AudienceRestriction>.*<\/saml:AudienceRestriction>/, "")), "audienceMismatch");
      // Several audiences in one restriction: naming this SP among them is enough.
      const several = xmlFor().replace("<saml:Audience>", "<saml:Audience>https://x.example.com</saml:Audience><saml:Audience>");
      assert.strictEqual(yield* judge(several), "ok");
    }),
  );

  it.effect("bearer only; recipient, InResponseTo and expiry of the confirmation must all hold", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* judge(xmlFor({ recipient: "https://evil.example.com/acs" })), "confirmationMismatch");
      assert.strictEqual(yield* judge(xmlFor({ inResponseTo: "_other" })), "confirmationMismatch");
      assert.strictEqual(
        yield* judge(xmlFor().replace("urn:oasis:names:tc:SAML:2.0:cm:bearer", "urn:oasis:names:tc:SAML:2.0:cm:holder-of-key")),
        "confirmationMethod",
      );
      assert.strictEqual(yield* judge(xmlFor().replace(/<saml:SubjectConfirmation .*<\/saml:SubjectConfirmation>/s, "")), "noConfirmation");
      // A confirmation without NotOnOrAfter never expires: refused.
      assert.strictEqual(yield* judge(xmlFor().replace(/ NotOnOrAfter="[^"]*"\/><\/saml:SubjectConfirmation>/, "/></saml:SubjectConfirmation>")), "confirmationMismatch");
    }),
  );

  it.effect("the time window: an upper bound is mandatory, and skew is symmetric and bounded", () =>
    Effect.gen(function* () {
      // Missing Conditions/NotOnOrAfter.
      assert.strictEqual(yield* judge(xmlFor().replace(/<saml:Conditions [^>]*>/, "<saml:Conditions>")), "noNotOnOrAfter");
      // NOW is 12:00:00. NotOnOrAfter is exclusive; skew 60 s extends it.
      const expiring = (notOnOrAfter: string) =>
        judge(xmlFor({ notBefore: "2026-09-29T11:00:00Z", notOnOrAfter }));
      assert.strictEqual(yield* expiring("2026-09-29T11:59:01Z"), "ok"); // 59 s past
      // Exactly skew past NotOnOrAfter (exclusive): the confirmation's own expiry trips first ...
      assert.strictEqual(yield* expiring("2026-09-29T11:59:00Z"), "confirmationMismatch");
      assert.strictEqual(yield* expiring("2026-09-29T12:00:00Z"), "ok");
      // ... and the Conditions' bound is enforced on its own when only IT has passed.
      const conditionsOnly = xmlFor({ notBefore: "2026-09-29T11:00:00Z", notOnOrAfter: "2026-09-29T12:30:00Z" }).replace(
        /(<saml:Conditions NotBefore="[^"]*" NotOnOrAfter=")[^"]*"/,
        '$12026-09-29T11:00:00Z"',
      );
      assert.strictEqual(yield* judge(conditionsOnly), "expired");
      // NotBefore 59 s in the future passes; 61 s does not.
      const starting = (notBefore: string) =>
        judge(xmlFor({ notBefore, notOnOrAfter: "2026-09-29T13:00:00Z" }));
      assert.strictEqual(yield* starting("2026-09-29T12:00:59Z"), "ok");
      assert.strictEqual(yield* starting("2026-09-29T12:01:01Z"), "notYetValid");
      // No skew: strict.
      const strict = expectations({ skewMillis: 0 });
      assert.strictEqual(
        yield* judge(xmlFor({ notBefore: "2026-09-29T11:00:00Z", notOnOrAfter: "2026-09-29T11:59:59Z" }), strict),
        "confirmationMismatch",
      );
    }),
  );

  it.effect("a signed Response's own status and Destination are judged; an unsigned Response's are not read here", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* judge(xmlFor().replace("urn:oasis:names:tc:SAML:2.0:status:Success", "urn:oasis:names:tc:SAML:2.0:status:Responder")),
        "statusNotSuccess",
      );
      assert.strictEqual(yield* judge(xmlFor({ destination: "https://evil.example.com/acs" })), "destinationMismatch");
    }),
  );
});
