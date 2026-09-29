// @awthaq/saml — SamlAssertion
//
// spec/behaviors/29-saml-sp.md, BEH-EA-240 through 243: reading a *verified* assertion and judging it.
//
// `readAssertion` is the only reader of signed content. Its input is `VerifiedXml.signedXml` — the canonical
// bytes of the element a verified signature covers (the `XmlSignature` port hands back nothing else) — parsed
// again through `SafeXml`, so the same DOCTYPE/comment/size rules hold and no unsigned sibling can be read. From
// it comes a plain `SignedAssertion` record; `validateAssertion` then judges that record against what this
// service provider expects, in the spec's order, and fails with a reason NAME that is logged and audited but
// never returned to the caller (BEH-EA-238: no validation oracle).

import type { XmlSignature } from "@awthaq/ports";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SafeXml from "./SafeXml.ts";

export const NS_SAML = "urn:oasis:names:tc:SAML:2.0:assertion";
export const NS_SAMLP = "urn:oasis:names:tc:SAML:2.0:protocol";
export const NS_METADATA = "urn:oasis:names:tc:SAML:2.0:metadata";

const saml = (localName: string): XmlSignature.ElementName => ({ namespace: NS_SAML, localName });
const samlp = (localName: string): XmlSignature.ElementName => ({ namespace: NS_SAMLP, localName });

export const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
export const STATUS_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";

export interface SubjectConfirmation {
  readonly method: string;
  readonly recipient: string | undefined;
  readonly inResponseTo: string | undefined;
  readonly notOnOrAfter: DateTime.Utc | undefined;
  readonly notBefore: DateTime.Utc | undefined;
}

/** Data of the SIGNED assertion (and, when the Response itself was signed, that Response's status and destination). */
export interface SignedAssertion {
  readonly id: string;
  readonly issuer: string;
  readonly nameId: { readonly value: string; readonly format: string | undefined };
  readonly confirmations: ReadonlyArray<SubjectConfirmation>;
  readonly notBefore: DateTime.Utc | undefined;
  readonly notOnOrAfter: DateTime.Utc | undefined;
  /** One entry per `AudienceRestriction`; every restriction must name this service provider. */
  readonly audienceRestrictions: ReadonlyArray<ReadonlyArray<string>>;
  readonly authnInstant: DateTime.Utc | undefined;
  readonly sessionIndex: string | undefined;
  readonly attributes: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Only when the signed element is the Response. */
  readonly responseDestination: string | undefined;
  readonly responseSucceeded: boolean | undefined;
}

/**
 * A check failed. `reason` names which one — for the log and the audit event, never for the wire
 * (BEH-EA-238): the HTTP contract answers one uniform `SamlAssertionRejected` whatever this says.
 */
export class AssertionInvalid extends Data.TaggedError("AssertionInvalid")<{
  readonly reason: string;
}> {}

const reject = (reason: string) => Effect.fail(new AssertionInvalid({ reason }));

const XS_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** SAML times are xs:dateTime in UTC; anything else (a zone offset, a date alone) is refused, not guessed. */
const instant = (value: string | undefined): DateTime.Utc | undefined | "invalid" => {
  if (value === undefined) return undefined;
  if (!XS_DATE_TIME.test(value)) return "invalid";
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? "invalid" : DateTime.makeUnsafe(millis);
};

/**
 * Reads the signed element into a `SignedAssertion`. The element may be the Assertion itself or a Response that
 * contains exactly one Assertion (the policy already guaranteed one in the whole document).
 */
export const readAssertion = Effect.fnUntraced(function* (signedXml: string) {
  const root = yield* SafeXml.parse(signedXml).pipe(
    Effect.mapError(() => new AssertionInvalid({ reason: "signedContentUnreadable" })),
  );
  const isResponse = SafeXml.isNamed(root, samlp("Response"));
  const assertions = SafeXml.isNamed(root, saml("Assertion"))
    ? [root]
    : SafeXml.named(root, saml("Assertion"));
  const assertion = assertions[0];
  if (assertions.length !== 1 || assertion === undefined)
    return yield* reject("assertionCardinality");

  const times = (element: Element, names: ReadonlyArray<string>) => {
    const parsed: Array<DateTime.Utc | undefined> = [];
    for (const name of names) {
      const value = instant(SafeXml.attribute(element, name));
      if (value === "invalid") return undefined;
      parsed.push(value);
    }
    return parsed;
  };

  const issuerElement = SafeXml.childrenNamed(assertion, saml("Issuer"))[0];
  const issuer = issuerElement === undefined ? undefined : SafeXml.textOf(issuerElement)?.trim();
  if (issuer === undefined || issuer === "") return yield* reject("noIssuer");

  const subject = SafeXml.childrenNamed(assertion, saml("Subject"))[0];
  const nameIdElement =
    subject === undefined ? undefined : SafeXml.childrenNamed(subject, saml("NameID"))[0];
  const nameIdValue =
    nameIdElement === undefined ? undefined : SafeXml.textOf(nameIdElement)?.trim();
  if (
    subject === undefined ||
    nameIdElement === undefined ||
    nameIdValue === undefined ||
    nameIdValue === ""
  ) {
    return yield* reject("noNameId");
  }

  const confirmations: Array<SubjectConfirmation> = [];
  for (const confirmation of SafeXml.childrenNamed(subject, saml("SubjectConfirmation"))) {
    const data = SafeXml.childrenNamed(confirmation, saml("SubjectConfirmationData"))[0];
    const parsed =
      data === undefined ? [undefined, undefined] : times(data, ["NotOnOrAfter", "NotBefore"]);
    if (parsed === undefined) return yield* reject("malformedTime");
    confirmations.push({
      method: SafeXml.attribute(confirmation, "Method") ?? "",
      recipient: data === undefined ? undefined : SafeXml.attribute(data, "Recipient"),
      inResponseTo: data === undefined ? undefined : SafeXml.attribute(data, "InResponseTo"),
      notOnOrAfter: parsed[0],
      notBefore: parsed[1],
    });
  }

  const conditions = SafeXml.childrenNamed(assertion, saml("Conditions"))[0];
  let notBefore: DateTime.Utc | undefined;
  let notOnOrAfter: DateTime.Utc | undefined;
  const audienceRestrictions: Array<ReadonlyArray<string>> = [];
  if (conditions !== undefined) {
    const parsed = times(conditions, ["NotBefore", "NotOnOrAfter"]);
    if (parsed === undefined) return yield* reject("malformedTime");
    [notBefore, notOnOrAfter] = parsed;
    for (const condition of SafeXml.childElements(conditions)) {
      if (SafeXml.isNamed(condition, saml("AudienceRestriction"))) {
        audienceRestrictions.push(
          SafeXml.childrenNamed(condition, saml("Audience")).map(
            (audience) => SafeXml.textOf(audience)?.trim() ?? "",
          ),
        );
      } else if (
        !SafeXml.isNamed(condition, saml("OneTimeUse")) &&
        !SafeXml.isNamed(condition, saml("ProxyRestriction"))
      ) {
        // A condition this service provider does not understand invalidates the assertion (SAML core 2.5.1.1).
        return yield* reject("unknownCondition");
      }
    }
  }

  const authn = SafeXml.childrenNamed(assertion, saml("AuthnStatement"))[0];
  let authnInstant: DateTime.Utc | undefined;
  if (authn !== undefined) {
    const parsed = times(authn, ["AuthnInstant"]);
    if (parsed === undefined) return yield* reject("malformedTime");
    authnInstant = parsed[0];
  }

  const attributes: Record<string, Array<string>> = {};
  for (const statement of SafeXml.childrenNamed(assertion, saml("AttributeStatement"))) {
    for (const attribute of SafeXml.childrenNamed(statement, saml("Attribute"))) {
      const attributeName = SafeXml.attribute(attribute, "Name");
      if (attributeName === undefined) continue;
      const values = SafeXml.childrenNamed(attribute, saml("AttributeValue")).flatMap((value) => {
        const text = SafeXml.textOf(value);
        return text === undefined ? [] : [text.trim()];
      });
      attributes[attributeName] = [...(attributes[attributeName] ?? []), ...values];
    }
  }

  let responseDestination: string | undefined;
  let responseSucceeded: boolean | undefined;
  if (isResponse) {
    responseDestination = SafeXml.attribute(root, "Destination");
    const status = SafeXml.childrenNamed(root, samlp("Status"))[0];
    const code =
      status === undefined ? undefined : SafeXml.childrenNamed(status, samlp("StatusCode"))[0];
    responseSucceeded = code !== undefined && SafeXml.attribute(code, "Value") === STATUS_SUCCESS;
  }

  const result: SignedAssertion = {
    id: SafeXml.attribute(assertion, "ID") ?? "",
    issuer,
    nameId: { value: nameIdValue, format: SafeXml.attribute(nameIdElement, "Format") },
    confirmations,
    notBefore,
    notOnOrAfter,
    audienceRestrictions,
    authnInstant,
    sessionIndex: authn === undefined ? undefined : SafeXml.attribute(authn, "SessionIndex"),
    attributes,
    responseDestination,
    responseSucceeded,
  };
  return result;
});

export interface Expectations {
  /** The connection's `idpEntityId`. */
  readonly idpEntityId: string;
  /** This service provider's entity id for the connection. */
  readonly spEntityId: string;
  /** The ACS URL. */
  readonly acsUrl: string;
  /** The AuthnRequest id this login reserved. */
  readonly inResponseTo: string;
  readonly now: DateTime.Utc;
  /** Bounded clock skew, milliseconds. */
  readonly skewMillis: number;
}

const millis = DateTime.toEpochMillis;

/**
 * BEH-EA-241 through 243, in order: issuer, the Response's own status and destination when it was signed,
 * audience, bearer confirmation with recipient / InResponseTo / expiry, then the time window with skew and a
 * mandatory upper bound. Any failure is an `AssertionInvalid` carrying a reason name for the log.
 */
export const validateAssertion = Effect.fnUntraced(function* (
  assertion: SignedAssertion,
  expected: Expectations,
) {
  // BEH-EA-241: the connection's IdP, exactly.
  if (assertion.issuer !== expected.idpEntityId) return yield* reject("issuerMismatch");

  if (assertion.responseSucceeded === false) return yield* reject("statusNotSuccess");
  // BEH-EA-242: a signed Response's Destination, when present, is this ACS.
  if (
    assertion.responseDestination !== undefined &&
    assertion.responseDestination !== expected.acsUrl
  ) {
    return yield* reject("destinationMismatch");
  }

  // BEH-EA-242: every AudienceRestriction must contain this SP; none at all is refused (an unrestricted assertion is
  // valid for every service provider the IdP serves).
  if (
    assertion.audienceRestrictions.length === 0 ||
    !assertion.audienceRestrictions.every((audiences) => audiences.includes(expected.spEntityId))
  ) {
    return yield* reject("audienceMismatch");
  }

  // BEH-EA-242/244: bearer only, addressed to this ACS, answering THIS login, and not expired.
  if (assertion.confirmations.length === 0) return yield* reject("noConfirmation");
  if (assertion.confirmations.some((confirmation) => confirmation.method !== BEARER)) {
    return yield* reject("confirmationMethod");
  }
  const skew = expected.skewMillis;
  const confirmed = assertion.confirmations.some(
    (confirmation) =>
      confirmation.recipient === expected.acsUrl &&
      confirmation.inResponseTo === expected.inResponseTo &&
      confirmation.notOnOrAfter !== undefined &&
      millis(expected.now) < millis(confirmation.notOnOrAfter) + skew &&
      (confirmation.notBefore === undefined ||
        millis(expected.now) >= millis(confirmation.notBefore) - skew),
  );
  if (!confirmed) return yield* reject("confirmationMismatch");

  // BEH-EA-243: an assertion without an upper bound is a bearer credential that never expires.
  if (assertion.notOnOrAfter === undefined) return yield* reject("noNotOnOrAfter");
  if (millis(expected.now) >= millis(assertion.notOnOrAfter) + skew)
    return yield* reject("expired");
  if (
    assertion.notBefore !== undefined &&
    millis(expected.now) < millis(assertion.notBefore) - skew
  ) {
    return yield* reject("notYetValid");
  }
  return assertion;
});
