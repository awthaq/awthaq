// P20a: steps for 29-saml-sp.feature (BEH-EA-238..245). A Given arranges the IdP's response (what it will
// say, who signs it, what an attacker did to the signed bytes) or the server (config, clock, connections);
// a When has the browser post it to the ACS; a Then reads the outcome and, for a rejection, the REASON the ACS
// logged - the wire only ever shows the uniform `SamlAssertionRejected`, so the reason is how a scenario tells
// "rejected for the rule under test" from "rejected for some other reason".
import { Accounts, Sessions, Users, Verification } from "@awthaq/core";
import { Saml } from "@awthaq/saml";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import {
  AFTER_CERTIFICATES_MILLIS,
  ALGORITHM,
  attacker,
  edit,
  elementsNamed,
  first,
  forgedAssertion,
  idp,
  idpNext,
  NOT_BEFORE_MILLIS,
  NOT_ON_OR_AFTER_MILLIS,
  NS,
} from "./SamlFixtures.ts";
import {
  BASE_URL,
  configure,
  ensureConnection,
  expectReason,
  inApp,
  lastOutcome,
  patchSpec,
  planConnection,
  postAcs,
  setClock,
  startLogin,
  submit,
  submitOnConnection,
  World,
} from "./SamlWorld.ts";
import { isBoolean, isString } from "./shared/Outcomes.ts";

const iso = (millis: number) => new Date(millis).toISOString().replace(".000Z", "Z");

const KIB = 1024;

/** BEH-EA-238 and BEH-EA-243's documented defaults. */
const DEFAULT_CAP_BYTES = 256 * KIB;
const DEFAULT_SKEW_SECONDS = 60;

const reasonMatches = (expected: string, logged: string | undefined) =>
  expected.endsWith("*")
    ? logged !== undefined && logged.startsWith(expected.slice(0, -1))
    : logged === expected;

const acceptedUserId = Effect.gen(function* () {
  const outcome = yield* lastOutcome();
  if (outcome._tag !== "accepted") {
    return yield* Effect.die(new Error(`expected a sign-in, got ${JSON.stringify(outcome)}`));
  }
  return outcome.userId;
});

const skewSeconds = Effect.gen(function* () {
  const world = yield* World;
  const config = yield* Ref.get(world.config);
  return config.clockSkew === undefined
    ? DEFAULT_SKEW_SECONDS
    : Duration.toSeconds(config.clockSkew);
});

/** The parts of a `saml:<organization>:<connection>` providerId literal a scenario names. */
const providerLiteral = (literal: string) => {
  const parts = literal.split(":");
  assert.equal(parts.length, 3, `providerId "${literal}" must be saml:<organization>:<connection>`);
  assert.equal(parts[0], "saml");
  return { organization: parts[1] ?? "", connection: parts[2] ?? "" };
};

const createUser = (email: string, verified: boolean) =>
  inApp(
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const user = yield* users
        .create({ identity: { _tag: "Email", email }, name: email })
        .pipe(Effect.orDie);
      if (verified) yield* users.verifyEmail(user.id).pipe(Effect.orDie);
      return user.id;
    }),
  );

const sessionCount = (userId: string) =>
  inApp(
    Effect.gen(function* () {
      const sessions = yield* Sessions.Sessions;
      const users = yield* Users.Users;
      const user = yield* users.findById(Users.UserId(userId)).pipe(Effect.orDie);
      return (yield* sessions.list(user.id).pipe(Effect.orDie)).length;
    }),
  );

// ---- attack documents (edits applied to a validly signed response) ---------------------------

const doctype = (body: string) => (xml: string) => `<!DOCTYPE samlp:Response [${body}]>${xml}`;

const billionLaughs =
  `<!ENTITY lol "lol">` +
  `<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">` +
  `<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">` +
  `<!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">`;

const withEntityReference = (xml: string) => xml.replace("</saml:Issuer>", "&lol4;</saml:Issuer>");

const withoutAssertion = (xml: string) =>
  edit(xml, (document) => {
    const assertion = first(elementsNamed(document, NS.saml, "Assertion"), "Assertion");
    assertion.parentNode?.removeChild(assertion);
  });

const withSecondAssertion = (xml: string) =>
  edit(xml, (document) => {
    const assertion = first(elementsNamed(document, NS.saml, "Assertion"), "Assertion");
    assertion.parentNode?.appendChild(assertion.cloneNode(true));
  });

const withEncryptedAssertion = (xml: string) =>
  edit(xml, (document) => {
    const response = first(elementsNamed(document, NS.samlp, "Response"), "Response");
    response.appendChild(document.createElementNS(NS.saml, "saml:EncryptedAssertion"));
  });

/** XSW-4/5/6: the signed Assertion parked inside a forged one that names an administrator. */
const wrappedInForgery = (xml: string) =>
  edit(xml, (document) => {
    const assertion = first(elementsNamed(document, NS.saml, "Assertion"), "Assertion");
    const response = first(elementsNamed(document, NS.samlp, "Response"), "Response");
    const evil = forgedAssertion(assertion, "_evil");
    response.replaceChild(evil, assertion);
    const advice = document.createElementNS(NS.saml, "saml:Advice");
    advice.appendChild(assertion);
    evil.appendChild(advice);
  });

/** Data an attacker can place outside the signed Assertion without touching a signed byte. */
const withUnsignedDecoys = (xml: string) =>
  edit(xml, (document) => {
    const response = first(elementsNamed(document, NS.samlp, "Response"), "Response");
    const statement = document.createElementNS(NS.saml, "saml:AttributeStatement");
    const attribute = document.createElementNS(NS.saml, "saml:Attribute");
    attribute.setAttribute("Name", "email");
    const value = document.createElementNS(NS.saml, "saml:AttributeValue");
    value.textContent = "attacker@evil.example";
    attribute.appendChild(value);
    statement.appendChild(attribute);
    const nameId = document.createElementNS(NS.saml, "saml:NameID");
    nameId.textContent = "attacker-nameid";
    response.appendChild(statement);
    response.appendChild(nameId);
  });

const algorithmOf = (literal: string) => {
  const known: Readonly<Record<string, string>> = {
    "RSA-SHA1": ALGORITHM.rsaSha1,
    "RSA-SHA256": ALGORITHM.rsaSha256,
    "SHA-1": ALGORITHM.sha1,
    "SHA-256": ALGORITHM.sha256,
  };
  const found = known[literal];
  if (found === undefined) throw new Error(`no algorithm named "${literal}" in the fixtures`);
  return found;
};

const useMutation = (mutate: (xml: string) => string) =>
  patchSpec((spec) => ({ ...spec, mutations: [...spec.mutations, mutate] }));

export const samlSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- the failure every rule shares ----

  Then("the response is rejected with the uniform {string} failure", function* (tag: string) {
    const world = yield* World;
    const outcome = yield* lastOutcome();
    assert.deepEqual(outcome, { _tag: "failed", tag });
    const expected = yield* Ref.get(world.expectedReason);
    if (expected !== undefined) {
      const logged = world.observations.reasons.at(-1);
      assert.ok(
        reasonMatches(expected, logged),
        `rejected for "${String(logged)}", expected "${expected}"`,
      );
    }
  });

  // ---- BEH-EA-238: the size cap comes before any parse ----

  Given("a SAML connection whose decoded size cap is {int} KiB", function* (kib: number) {
    yield* configure({ maxResponseBytes: kib * KIB });
    yield* ensureConnection("acme");
  });

  Given("a SAML connection with no size cap configured", function* () {
    yield* ensureConnection("acme");
  });

  Then("the effective size cap is {int} KiB", function* (kib: number) {
    const cap = yield* inApp(Effect.map(Saml.SamlConfig, (config) => config.maxResponseBytes));
    assert.equal(cap, kib * KIB);
    assert.equal(cap, DEFAULT_CAP_BYTES);
  });

  When("the ACS receives a SAMLResponse of {int} KiB", function* (kib: number) {
    yield* patchSpec((spec) => ({ ...spec, padBytes: kib * KIB }));
    yield* submitOnConnection("acme");
  });

  Then("the response proceeds to XML parsing", function* () {
    const world = yield* World;
    yield* acceptedUserId;
    // The XML parser sits behind the port: a response that reached it was under the cap.
    assert.ok(world.observations.verifyCalls.length >= 1);
    assert.ok(world.observations.verifyCalls.every((call) => call.failure === undefined));
  });

  When("the ACS receives a SAMLResponse whose decoded size is {int} KiB", function* (kib: number) {
    yield* expectReason("tooLarge");
    yield* patchSpec((spec) => ({ ...spec, padBytes: kib * KIB }));
    yield* submitOnConnection("acme");
  });

  Then("no XML parser was invoked for it", function* () {
    const world = yield* World;
    // Every parser the ACS uses sits behind the `XmlSignature` port or runs after it succeeded:
    // a response refused before the port was never parsed.
    assert.equal(world.observations.verifyCalls.length, 0);
  });

  When(
    "the ACS receives a DEFLATE payload that is small on the wire and inflates beyond {int} KiB",
    function* (kib: number) {
      const bomb = deflateRawSync(Buffer.alloc((kib + 44) * KIB, "a"));
      assert.ok(bomb.length < 4 * KIB, "the payload must be small on the wire");
      yield* patchSpec((spec) => ({ ...spec, rawPayload: () => bomb.toString("base64") }));
      yield* submitOnConnection("acme");
    },
  );

  Then("the payload was not inflated beyond the cap", function* () {
    const world = yield* World;
    // The ACS is the POST binding (base64, never DEFLATE): whatever it made of the bytes, nothing
    // larger than the cap ever reached a parser.
    assert.ok(world.observations.verifyCalls.every((call) => call.length <= DEFAULT_CAP_BYTES));
    assert.equal((yield* lastOutcome())._tag, "failed");
  });

  // ---- BEH-EA-239: DTD/XXE refused, exactly one assertion ----

  Given("a SAML response document that declares a DOCTYPE", function* () {
    yield* useMutation(doctype(`<!ENTITY a "b">`));
    yield* expectReason("signature:doctype");
  });

  Given("a SAML response document whose DOCTYPE defines nested entity expansions", function* () {
    yield* useMutation(doctype(billionLaughs));
    yield* useMutation(withEntityReference);
    yield* expectReason("signature:doctype");
  });

  Given(
    "a SAML response document whose DOCTYPE references a local file as an external entity",
    function* () {
      const directory = mkdtempSync(join(tmpdir(), "awthaq-saml-xxe-"));
      const file = join(directory, "canary.txt");
      const canary = `CANARY-${Math.random().toString(36).slice(2)}`;
      writeFileSync(file, canary);
      const world = yield* World;
      yield* world.outcomes.set("canary", canary);
      yield* useMutation(doctype(`<!ENTITY lol4 SYSTEM "file://${file}">`));
      yield* useMutation(withEntityReference);
      yield* expectReason("signature:doctype");
    },
  );

  Given("a SAML response document containing zero Assertion elements", function* () {
    yield* useMutation(withoutAssertion);
    yield* expectReason("signature:cardinality");
  });

  Given("a SAML response document containing two Assertion elements", function* () {
    yield* useMutation(withSecondAssertion);
    yield* expectReason("signature:cardinality");
  });

  Given("a SAML response document carrying an EncryptedAssertion", function* () {
    yield* useMutation(withEncryptedAssertion);
    yield* expectReason("signature:forbiddenElement");
  });

  When("the ACS processes it", function* () {
    yield* submitOnConnection("acme");
  });

  Then("no external entity was resolved", function* () {
    const world = yield* World;
    // The DOCTYPE is refused outright, before any entity is read: the parser never got to resolve one.
    assert.equal(world.observations.verifyCalls.at(-1)?.failure, "doctype");
  });

  Then("no entity was expanded", function* () {
    const world = yield* World;
    assert.equal(world.observations.verifyCalls.at(-1)?.failure, "doctype");
  });

  Then("the referenced file was never read", function* () {
    const world = yield* World;
    const canary = yield* world.outcomes.getAs("canary", isString);
    assert.equal(world.observations.verifyCalls.at(-1)?.failure, "doctype");
    // Whatever the entity would have pulled in, it never reached anything the server logged.
    assert.ok(world.observations.logText.every((line) => !line.includes(canary)));
  });

  Then("no signature verification was attempted", function* () {
    const world = yield* World;
    // The structural rules run before any cryptography: the port refused the document by its
    // shape, not by a signature that failed to verify.
    const last = world.observations.verifyCalls.at(-1);
    assert.ok(last !== undefined);
    assert.ok(
      last.failure === "cardinality" || last.failure === "forbiddenElement",
      `expected a structural refusal, got ${String(last.failure)}`,
    );
  });

  // ---- BEH-EA-240: the signature covers what is processed ----

  Given("a SAML connection whose trust set holds the IdP's signing certificate", function* () {
    yield* ensureConnection("acme");
  });

  Given(
    "a response whose only Assertion is signed by that certificate with RSA-SHA256",
    function* () {
      yield* patchSpec((spec) => ({
        ...spec,
        sign: { ...spec.sign, signatureAlgorithm: ALGORITHM.rsaSha256 },
      }));
    },
  );

  When("the ACS verifies the signature", function* () {
    yield* submitOnConnection("acme");
  });

  Then("the signature check passes", function* () {
    const world = yield* World;
    yield* acceptedUserId;
    const verified = world.observations.verifyCalls.at(-1)?.verified;
    assert.ok(verified !== undefined);
    assert.equal(verified.signedElement.localName, "Assertion");
    assert.equal(verified.signatureAlgorithm, ALGORITHM.rsaSha256);
  });

  Given(
    "a response with a valid signature over Assertion {string} and unsigned attribute data elsewhere in the document",
    function* (assertionId: string) {
      yield* patchSpec((spec) => ({
        ...spec,
        response: { ...spec.response, assertionId },
        sign: { ...spec.sign, assertionId },
      }));
      yield* useMutation(withUnsignedDecoys);
    },
  );

  When("the ACS verifies the response", function* () {
    yield* submitOnConnection("acme");
  });

  Then(
    "the returned NameID and attributes come only from Assertion {string}",
    function* (assertionId: string) {
      const world = yield* World;
      const userId = yield* acceptedUserId;
      const verified = world.observations.verifyCalls.at(-1)?.verified;
      assert.ok(verified !== undefined);
      assert.equal(verified.signedId, assertionId);
      assert.ok(!verified.signedXml.includes("attacker"));
      const found = yield* inApp(
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const accounts = yield* Accounts.Accounts;
          const connection = yield* Effect.succeed(world.connections.get("acme"));
          if (connection === undefined) return yield* Effect.die(new Error("no connection"));
          const user = yield* users.findById(Users.UserId(userId)).pipe(Effect.orDie);
          const decoyUser = yield* users.findByEmail("attacker@evil.example").pipe(Effect.orDie);
          const decoyAccount = yield* accounts
            .findByProviderSubject(
              Saml.providerIdOf(connection.organizationId, connection.id),
              "attacker-nameid",
              connection.entityId,
            )
            .pipe(Effect.orDie);
          const signedAccount = yield* accounts
            .findByProviderSubject(
              Saml.providerIdOf(connection.organizationId, connection.id),
              "ada",
              connection.entityId,
            )
            .pipe(Effect.orDie);
          return { email: Users.emailOf(user), decoyUser, decoyAccount, signedAccount };
        }),
      );
      // The account carries the signed NameID and the signed email; nothing an attacker parked outside.
      assert.deepEqual(found.email, Option.some("ada@acme.example"));
      assert.ok(Option.isSome(found.signedAccount));
      assert.ok(Option.isNone(found.decoyUser));
      assert.ok(Option.isNone(found.decoyAccount));
    },
  );

  Given(
    "a response whose signature is valid over a benign element while a forged Assertion sits elsewhere in the document",
    function* () {
      yield* useMutation(wrappedInForgery);
      yield* expectReason("signature:cardinality");
    },
  );

  Given(
    "a response whose signature Reference URI names an element other than the Assertion it accompanies",
    function* () {
      yield* useMutation((xml) => xml.replace('URI="#_assert1"', 'URI="#_resp1"'));
      yield* patchSpec((spec) => ({
        ...spec,
        response: { ...spec.response, assertionId: "_assert1" },
        sign: { ...spec.sign, assertionId: "_assert1" },
      }));
      yield* expectReason("signature:*");
    },
  );

  Given(
    "a response signed with signature algorithm {string} and digest algorithm {string}",
    function* (signature: string, digest: string) {
      yield* patchSpec((spec) => ({
        ...spec,
        sign: {
          ...spec.sign,
          signatureAlgorithm: algorithmOf(signature),
          digestAlgorithm: algorithmOf(digest),
        },
      }));
      yield* expectReason("signature:unsupportedAlgorithm");
    },
  );

  Given(
    "a response signed by a certificate whose fingerprint is not in the connection's IdpTrustSet",
    function* () {
      yield* patchSpec((spec) => ({ ...spec, sign: { ...spec.sign, who: attacker } }));
      yield* expectReason("signature:*");
    },
  );

  Given("a response signed by a trusted certificate that has expired", function* () {
    // Every fixture certificate is valid until 2036-09-26: the server's clock is moved past it, so the
    // very certificate the connection pins is now outside its own notBefore/notAfter window.
    yield* ensureConnection("acme");
    yield* setClock(AFTER_CERTIFICATES_MILLIS);
    yield* expectReason("signature:*");
  });

  Given(
    "a SAML connection whose trust set holds the IdP's old and new signing certificates",
    function* () {
      yield* planConnection("acme", { certificates: [idp, idpNext], signer: idp });
      yield* ensureConnection("acme");
    },
  );

  When("the ACS verifies a response signed by the new certificate", function* () {
    const world = yield* World;
    yield* startLogin("acme", "new");
    yield* patchSpec((spec) => ({
      ...spec,
      sign: { ...spec.sign, who: idpNext, assertionId: "_new1" },
      response: { ...spec.response, assertionId: "_new1" },
    }));
    yield* world.outcomes.set("rotation-new", yield* submit("new"));
  });

  When("the ACS verifies a response signed by the old certificate", function* () {
    const world = yield* World;
    yield* startLogin("acme", "old");
    yield* patchSpec((spec) => ({
      ...spec,
      sign: { ...spec.sign, who: idp, assertionId: "_old1" },
      response: { ...spec.response, assertionId: "_old1" },
    }));
    yield* world.outcomes.set("rotation-old", yield* submit("old"));
  });

  Then("both signature checks pass", function* () {
    const world = yield* World;
    for (const key of ["rotation-new", "rotation-old"]) {
      const outcome = yield* world.outcomes.getAs(
        key,
        (value): value is { readonly _tag: string } =>
          typeof value === "object" && value !== null && "_tag" in value,
      );
      assert.equal(outcome._tag, "accepted", key);
    }
    const fingerprints = world.observations.verifyCalls.map(
      (call) => call.verified?.certificateFingerprint,
    );
    assert.ok(fingerprints.includes(idpNext.fingerprint));
    assert.ok(fingerprints.includes(idp.fingerprint));
  });

  // ---- BEH-EA-241: the issuer is the connection's IdP; the trust set is the soliciting connection's ----

  Given("a SAML connection with idpEntityId {string}", function* (entityId: string) {
    yield* planConnection("acme", { entityId });
    yield* ensureConnection("acme");
  });

  When("the ACS checks a verified assertion issued by {string}", function* (issuer: string) {
    const world = yield* World;
    const connection = yield* ensureConnection("acme");
    yield* patchSpec((spec) => ({ ...spec, response: { ...spec.response, issuer } }));
    if (issuer !== connection.entityId) yield* expectReason("issuerMismatch");
    yield* world.outcomes.set("issuer", issuer);
    yield* submitOnConnection("acme");
  });

  Then("the issuer check passes", function* () {
    yield* acceptedUserId;
  });

  Given(
    "two SAML connections {string} and {string}, each trusting only its own IdP certificate",
    function* (first_: string, second: string) {
      const one = yield* ensureConnection(first_);
      const two = yield* ensureConnection(second);
      assert.notEqual(one.signer.fingerprint, two.signer.fingerprint);
    },
  );

  Given("a login was solicited on connection {string}", function* (name: string) {
    yield* startLogin(name, "current");
  });

  When(
    "the ACS receives a response signed by the certificate trusted by {string}",
    function* (name: string) {
      const other = yield* ensureConnection(name);
      yield* patchSpec((spec) => ({ ...spec, sign: { ...spec.sign, who: other.signer } }));
      yield* expectReason("signature:*");
      yield* submit("current");
    },
  );

  When(
    "the ACS receives a response whose unverified Issuer names connection {string}'s identity provider",
    function* (name: string) {
      const other = yield* ensureConnection(name);
      yield* patchSpec((spec) => ({
        ...spec,
        response: { ...spec.response, issuer: other.entityId },
      }));
      yield* expectReason("issuerMismatch");
      yield* submit("current");
    },
  );

  Then("the trust set consulted is the one of {string}", function* (name: string) {
    const world = yield* World;
    const connection = yield* ensureConnection(name);
    const call = world.observations.verifyCalls.at(-1);
    assert.ok(call !== undefined);
    // The signature verified under THIS connection's pinned certificate, and the document's own
    // (unverified) Issuer only failed the later issuer check.
    assert.deepEqual(call.fingerprints, [connection.signer.fingerprint]);
    assert.equal(call.failure, undefined);
    assert.deepEqual(yield* lastOutcome(), { _tag: "failed", tag: "SamlAssertionRejected" });
    assert.equal(world.observations.reasons.at(-1), "issuerMismatch");
  });

  // ---- BEH-EA-242: audience, recipient, destination, bearer ----

  Given("a service provider with entity id {string}", function* (entityId: string) {
    yield* configure({ spEntityId: () => entityId });
  });

  Given("an ACS URL {string}", function* (url: string) {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, "/auth/saml/acs");
    yield* configure({ baseUrl: parsed.origin });
  });

  When(
    "the ACS checks an assertion whose AudienceRestriction contains {string}",
    function* (audience: string) {
      yield* patchSpec((spec) => ({ ...spec, response: { ...spec.response, audience } }));
      yield* submitOnConnection("acme");
    },
  );

  When(
    "the ACS checks an assertion whose AudienceRestriction contains only {string}",
    function* (audience: string) {
      yield* patchSpec((spec) => ({ ...spec, response: { ...spec.response, audience } }));
      yield* expectReason("audienceMismatch");
      yield* submitOnConnection("acme");
    },
  );

  Then("the audience check passes", function* () {
    yield* acceptedUserId;
  });

  When("the ACS checks an assertion whose Recipient is {string}", function* (recipient: string) {
    yield* patchSpec((spec) => ({ ...spec, response: { ...spec.response, recipient } }));
    yield* expectReason("confirmationMismatch");
    yield* submitOnConnection("acme");
  });

  When("the ACS checks a response whose Destination is {string}", function* (destination: string) {
    yield* patchSpec((spec) => ({ ...spec, response: { ...spec.response, destination } }));
    yield* expectReason("destinationMismatch");
    yield* submitOnConnection("acme");
  });

  When("the ACS checks a response that carries no Destination", function* () {
    yield* patchSpec((spec) => ({ ...spec, response: { ...spec.response, destination: null } }));
    yield* submitOnConnection("acme");
  });

  Then("the destination check passes", function* () {
    yield* acceptedUserId;
  });

  When(
    "the ACS checks an assertion whose SubjectConfirmation method is {string}",
    function* (method: string) {
      yield* patchSpec((spec) => ({
        ...spec,
        response: {
          ...spec.response,
          confirmationMethod: `urn:oasis:names:tc:SAML:2.0:cm:${method}`,
        },
      }));
      yield* expectReason("confirmationMethod");
      yield* submitOnConnection("acme");
    },
  );

  // ---- BEH-EA-243: the time window ----

  Given("the server clock is inside an assertion's NotBefore and NotOnOrAfter", function* () {
    yield* setClock(NOT_BEFORE_MILLIS + (NOT_ON_OR_AFTER_MILLIS - NOT_BEFORE_MILLIS) / 2);
  });

  Given("a configured skew tolerance of {int} seconds", function* (seconds: number) {
    yield* configure({ clockSkew: Duration.seconds(seconds) });
  });

  Given(
    "the server clock is {int} seconds after the assertion's NotOnOrAfter",
    function* (seconds: number) {
      const skew = yield* skewSeconds;
      yield* setClock(NOT_ON_OR_AFTER_MILLIS + seconds * 1000);
      // The SubjectConfirmationData outlives the Conditions window, so what is judged is the window itself.
      yield* patchSpec((spec) => ({
        ...spec,
        response: {
          ...spec.response,
          confirmationNotOnOrAfter: iso(NOT_ON_OR_AFTER_MILLIS + 30 * 60_000),
        },
      }));
      if (seconds > skew) yield* expectReason("expired");
    },
  );

  Given(
    "the server clock is {int} seconds before the assertion's NotBefore",
    function* (seconds: number) {
      const skew = yield* skewSeconds;
      yield* setClock(NOT_BEFORE_MILLIS - seconds * 1000);
      if (seconds > skew) yield* expectReason("notYetValid");
    },
  );

  Given(
    "the assertion's Conditions window is valid but its SubjectConfirmationData NotOnOrAfter is past",
    function* () {
      yield* patchSpec((spec) => ({
        ...spec,
        response: {
          ...spec.response,
          confirmationNotOnOrAfter: iso(NOT_BEFORE_MILLIS - 60 * 60_000),
        },
      }));
      yield* expectReason("confirmationMismatch");
    },
  );

  Given("an assertion that carries no NotOnOrAfter", function* () {
    yield* patchSpec((spec) => ({
      ...spec,
      response: {
        ...spec.response,
        notOnOrAfter: null,
        // The bearer confirmation keeps its own expiry, so what is missing is the assertion's upper bound.
        confirmationNotOnOrAfter: iso(NOT_ON_OR_AFTER_MILLIS),
      },
    }));
    yield* expectReason("noNotOnOrAfter");
  });

  When("the ACS checks the assertion's time window", function* () {
    yield* submitOnConnection("acme");
  });

  Then("the time check passes", function* () {
    yield* acceptedUserId;
  });

  Given("a SAML connection with no skew tolerance configured", function* () {
    yield* ensureConnection("acme");
  });

  Then("the effective skew tolerance is {int} seconds", function* (seconds: number) {
    const skew = yield* inApp(
      Effect.map(Saml.SamlConfig, (config) => Duration.toSeconds(config.clockSkew)),
    );
    assert.equal(skew, seconds);
  });

  When("a skew tolerance of {int} seconds is configured", function* (seconds: number) {
    const world = yield* World;
    const exit = yield* Effect.promise(() =>
      Effect.runPromiseExit(
        Effect.scoped(
          Layer.build(Saml.config({ baseUrl: BASE_URL, clockSkew: Duration.seconds(seconds) })),
        ),
      ),
    );
    yield* world.outcomes.set("configRefused", Exit.isFailure(exit));
  });

  Then("the configuration is refused", function* () {
    const world = yield* World;
    assert.equal(yield* world.outcomes.getAs("configRefused", isBoolean), true);
  });

  // ---- BEH-EA-244: InResponseTo is a stored, single-consume request id ----

  Given("a SAML connection {string}", function* (name: string) {
    yield* ensureConnection(name);
  });

  When("a login is started on connection {string}", function* (name: string) {
    yield* startLogin(name, "started");
  });

  Then(
    "the AuthnRequest id is reserved in Verification, bound to {string}, with a short TTL",
    function* (name: string) {
      const world = yield* World;
      const connection = yield* ensureConnection(name);
      const login = world.logins.get("started");
      assert.ok(login !== undefined);
      const dot = login.state.indexOf(".");
      const identifier = login.state.slice(0, dot);
      const secret = login.state.slice(dot + 1);
      // Reading the reservation back is redeeming it: the payload is what the ACS will later hold the response to.
      const view = yield* inApp(
        Effect.flatMap(Verification.Verification, (verification) =>
          verification.consume(identifier, Redacted.make(secret)),
        ),
      );
      const payload = view.payload;
      assert.ok(typeof payload === "object" && payload !== null);
      assert.ok("connectionId" in payload && "requestId" in payload);
      assert.equal(payload.connectionId, connection.id);
      assert.equal(payload.requestId, login.requestId);
      assert.equal(
        DateTime.toEpochMillis(view.expiresAt) - DateTime.toEpochMillis(view.createdAt),
        Duration.toMillis(Duration.minutes(10)),
      );
    },
  );

  Then("the redirect to the identity provider happens after the reservation", function* () {
    const world = yield* World;
    const login = world.logins.get("started");
    assert.ok(login !== undefined);
    // The state the browser holds carries the reservation's secret, which exists only once the
    // reservation was written: the redirect was returned after it.
    assert.match(login.state, /^saml-request:[0-9a-f-]+\..+$/);
    assert.ok(login.location.startsWith("https://idp.acme.example/sso?"));
    assert.ok(new URL(login.location).searchParams.has("SAMLRequest"));
  });

  Given(
    "a login was solicited on connection {string} with AuthnRequest id {string}",
    function* (name: string, label: string) {
      yield* startLogin(name, label);
      const world = yield* World;
      const login = world.logins.get(label);
      if (login !== undefined) world.logins.set("current", login);
    },
  );

  When(
    "the ACS receives a response with InResponseTo {string} for connection {string}",
    function* (label: string, name: string) {
      const world = yield* World;
      const known = world.logins.get(label);
      if (known === undefined) {
        // An id this server never issued: the browser still holds a real login's state, the IdP answers a different id.
        yield* startLogin(name, "solicited");
        yield* patchSpec((spec) => ({
          ...spec,
          response: { ...spec.response, inResponseTo: label },
        }));
        yield* expectReason("confirmationMismatch");
        yield* submit("solicited");
        return;
      }
      if (known.connectionName !== name) {
        // Answered for another connection's service provider: the audience is not this login's.
        yield* patchSpec((spec) => ({ ...spec, forConnection: name }));
        yield* expectReason("audienceMismatch");
      }
      yield* submit(label);
    },
  );

  Then("the InResponseTo check passes", function* () {
    yield* acceptedUserId;
  });

  Then("the reserved id {string} is consumed", function* (label: string) {
    const world = yield* World;
    const login = world.logins.get(label);
    assert.ok(login !== undefined);
    const payload = yield* world.outcomes.getAs("payload", isString);
    const again = yield* postAcs(payload, login.state);
    assert.deepEqual(again, { _tag: "failed", tag: "SamlAssertionRejected" });
    assert.equal(world.observations.reasons.at(-1), "requestUnknownOrConsumed");
  });

  Given("a response with InResponseTo {string} was already accepted", function* (label: string) {
    yield* submit(label);
    yield* acceptedUserId;
  });

  When("the same response is presented again", function* () {
    const world = yield* World;
    const login = world.logins.get("current");
    assert.ok(login !== undefined);
    const payload = yield* world.outcomes.getAs("payload", isString);
    yield* expectReason("requestUnknownOrConsumed");
    yield* postAcs(payload, login.state);
  });

  Given("the reservation's TTL has elapsed", function* () {
    yield* setClock(NOT_BEFORE_MILLIS + 5 * 60_000 + Duration.toMillis(Duration.minutes(11)));
    yield* expectReason("requestUnknownOrConsumed");
  });

  Given("a SAML connection that has not opted in to IdP-initiated login", function* () {
    yield* ensureConnection("acme");
  });

  When("the ACS receives a response with no InResponseTo", function* () {
    // No login was started: the browser holds no state, and the IdP answers no request.
    yield* patchSpec((spec) => ({ ...spec, response: { ...spec.response, inResponseTo: null } }));
    yield* expectReason("noRequestState");
    yield* submit("none");
  });

  // ---- BEH-EA-245: the NameID links through the connection, never by email alone ----

  Given(
    "an account linked under providerId {string} with NameID {string}",
    function* (literal: string, nameId: string) {
      const world = yield* World;
      const { organization, connection } = providerLiteral(literal);
      const seeded = yield* ensureConnection(connection, organization);
      const userId = yield* createUser(`linked@${connection}.example`, false);
      yield* inApp(
        Effect.flatMap(Accounts.Accounts, (accounts) =>
          accounts
            .link({
              userId: Users.UserId(userId),
              providerId: Saml.providerIdOf(seeded.organizationId, seeded.id),
              subject: nameId,
              issuer: seeded.entityId,
            })
            .pipe(Effect.orDie),
        ),
      );
      world.users.set("linked", userId);
    },
  );

  When(
    "a fully validated response for connection {string} of {string} carries NameID {string}",
    function* (connection: string, organization: string, nameId: string) {
      yield* ensureConnection(connection, organization);
      yield* patchSpec((spec) => ({
        ...spec,
        response: {
          ...spec.response,
          nameId,
          attributes: { email: [`${nameId}@${connection}.example`] },
        },
      }));
      yield* submitOnConnection(connection);
    },
  );

  Then("the sign-in resolves to that account", function* () {
    const world = yield* World;
    const userId = yield* acceptedUserId;
    assert.equal(userId, world.users.get("linked"));
  });

  Given("a fully validated response carrying a NameID no account is linked to", function* () {
    yield* patchSpec((spec) => ({
      ...spec,
      response: {
        ...spec.response,
        nameId: "unlinked-1",
        attributes: { email: ["unlinked-1@acme.example"] },
      },
    }));
  });

  When("the ACS resolves the account", function* () {
    yield* submitOnConnection("acme");
  });

  Then(
    "a user is created and linked under the connection's provider id and that NameID",
    function* () {
      const userId = yield* acceptedUserId;
      const connection = yield* ensureConnection("acme");
      const linked = yield* inApp(
        Effect.flatMap(Accounts.Accounts, (accounts) =>
          accounts
            .findByProviderSubject(
              Saml.providerIdOf(connection.organizationId, connection.id),
              "unlinked-1",
              connection.entityId,
            )
            .pipe(Effect.orDie),
        ),
      );
      assert.ok(Option.isSome(linked));
      assert.equal(linked.value.userId, userId);
    },
  );

  Given("an existing local account {string}", function* (email: string) {
    const world = yield* World;
    world.users.set("existing", yield* createUser(email, false));
  });

  Given("an existing local account {string} whose address is verified", function* (email: string) {
    const world = yield* World;
    world.users.set("existing", yield* createUser(email, true));
  });

  Given(
    "a fully validated response whose email attribute is {string} and whose NameID is unlinked",
    function* (email: string) {
      yield* patchSpec((spec) => ({
        ...spec,
        response: { ...spec.response, nameId: "opaque-unlinked", attributes: { email: [email] } },
      }));
      yield* expectReason("emailInUse");
    },
  );

  Then("the existing account is not linked", function* () {
    const world = yield* World;
    const existing = world.users.get("existing");
    assert.ok(existing !== undefined);
    const accounts = yield* inApp(
      Effect.flatMap(Accounts.Accounts, (service) =>
        service.listByUser(Users.UserId(existing)).pipe(Effect.orDie),
      ),
    );
    assert.ok(accounts.every((account) => !account.providerId.startsWith("saml:")));
  });

  Then("the sign-in does not resolve to {string}", function* (email: string) {
    const world = yield* World;
    const existing = world.users.get("existing");
    assert.ok(existing !== undefined, `no account ${email} was set up`);
    assert.equal((yield* lastOutcome())._tag, "failed");
    assert.equal(yield* sessionCount(existing), 0);
  });

  Given("a linking policy that trusts the connection", function* () {
    yield* planConnection("acme", { trustsEmail: true });
  });

  When(
    "a fully validated response whose email attribute is {string} is resolved",
    function* (email: string) {
      yield* patchSpec((spec) => ({
        ...spec,
        response: { ...spec.response, nameId: "opaque-trusted", attributes: { email: [email] } },
      }));
      yield* submitOnConnection("acme");
    },
  );

  Then("the account is linked under the connection's provider id", function* () {
    const world = yield* World;
    const userId = yield* acceptedUserId;
    assert.equal(userId, world.users.get("existing"));
    const connection = yield* ensureConnection("acme");
    const linked = yield* inApp(
      Effect.flatMap(Accounts.Accounts, (accounts) =>
        accounts
          .findByProviderSubject(
            Saml.providerIdOf(connection.organizationId, connection.id),
            "opaque-trusted",
            connection.entityId,
          )
          .pipe(Effect.orDie),
      ),
    );
    assert.ok(Option.isSome(linked));
  });

  Given(
    "a NameID {string} linked under connection {string} of {string}",
    function* (nameId: string, connection: string, organization: string) {
      const world = yield* World;
      yield* ensureConnection(connection, organization);
      yield* patchSpec((spec) => ({
        ...spec,
        response: {
          ...spec.response,
          nameId,
          attributes: { email: [`${nameId}@${connection}.example`] },
        },
      }));
      yield* submitOnConnection(connection);
      world.users.set(`first:${connection}`, yield* acceptedUserId);
    },
  );

  Then("the sign-in does not resolve to the account of {string}", function* (connection: string) {
    const world = yield* World;
    const first_ = world.users.get(`first:${connection}`);
    assert.ok(first_ !== undefined);
    const userId = yield* acceptedUserId;
    assert.notEqual(userId, first_);
  });

  Given("an account linked to a NameID and suspended", function* () {
    const world = yield* World;
    const connection = yield* ensureConnection("acme");
    const userId = yield* createUser("suspended@acme.example", false);
    yield* inApp(
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts;
        const users = yield* Users.Users;
        yield* accounts
          .link({
            userId: Users.UserId(userId),
            providerId: Saml.providerIdOf(connection.organizationId, connection.id),
            subject: "suspended-name",
            issuer: connection.entityId,
          })
          .pipe(Effect.orDie);
        yield* users.setStatus(Users.UserId(userId), "suspended").pipe(Effect.orDie);
      }),
    );
    world.users.set("suspended", userId);
  });

  When("a fully validated response carries that NameID", function* () {
    yield* patchSpec((spec) => ({
      ...spec,
      response: {
        ...spec.response,
        nameId: "suspended-name",
        attributes: { email: ["suspended@acme.example"] },
      },
    }));
    yield* submitOnConnection("acme");
  });

  Then("{string} refuses the sign-in", function* (gate: string) {
    assert.equal(gate, "Users.assertCanSignIn");
    assert.deepEqual(yield* lastOutcome(), { _tag: "failed", tag: "UserSuspended" });
  });

  Then("no session is minted", function* () {
    const world = yield* World;
    const suspended = world.users.get("suspended");
    assert.ok(suspended !== undefined);
    assert.equal(yield* sessionCount(suspended), 0);
  });
});
