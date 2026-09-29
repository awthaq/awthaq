// @awthaq/saml — SamlLogout
//
// BEH-EA-315: reading and judging an inbound Single Logout message, the way `SamlAssertion` reads an assertion. A
// `LogoutRequest` (the IdP telling this SP to end a user's sessions) and a `LogoutResponse` (the IdP answering a logout this
// SP started) arrive over the HTTP-Redirect binding (a query-string signature, `SamlKeys.verifyRedirect`) or the HTTP-POST
// binding (an enveloped XML signature, the `XmlSignature` port). Either way the message is read ONLY from bytes a
// verification returned: for POST the port's `signedXml`; for Redirect the DEFLATE-inflated XML of a query whose signature
// verified (there is no unsigned sibling to wrap in a redirect message, but it still passes through `SafeXml`).
//
// What is judged, in order: the issuer is the connection's IdP; the `Destination` is exactly this SP's logout endpoint (the
// spec requires it on a signed message: it binds the message to this consumer); the message is fresh (`IssueInstant`
// within a bounded window, and `NotOnOrAfter` when present), because a captured LogoutRequest replayed later would otherwise
// log the user out again on demand; for a response, it answers THIS SP's request (`InResponseTo`) and succeeded. Every
// failure is a reason NAME for the log, never returned to the caller (no validation oracle, as at the ACS).

import type { XmlSignature } from "@awthaq/ports";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SafeXml from "./SafeXml.ts";
import { NS_SAML, NS_SAMLP } from "./SamlAssertion.ts";

const saml = (localName: string): XmlSignature.ElementName => ({ namespace: NS_SAML, localName });
const samlp = (localName: string): XmlSignature.ElementName => ({ namespace: NS_SAMLP, localName });

export const LOGOUT_REQUEST = samlp("LogoutRequest");
export const LOGOUT_RESPONSE = samlp("LogoutResponse");

/** A logout message failed a check. `reason` names which; it is for the log, never the wire. */
export class LogoutInvalid extends Data.TaggedError("LogoutInvalid")<{
  readonly reason: string;
}> {}

const reject = (reason: string) => Effect.fail(new LogoutInvalid({ reason }));

const XS_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const instant = (value: string | undefined): DateTime.Utc | undefined | "invalid" => {
  if (value === undefined) return undefined;
  if (!XS_DATE_TIME.test(value)) return "invalid";
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? "invalid" : DateTime.makeUnsafe(millis);
};

export interface LogoutRequestData {
  readonly id: string;
  readonly issuer: string;
  readonly destination: string | undefined;
  readonly issueInstant: DateTime.Utc | undefined;
  readonly notOnOrAfter: DateTime.Utc | undefined;
  readonly nameId: { readonly value: string; readonly format: string | undefined };
  /** Empty: every session of the NameID at this connection. */
  readonly sessionIndexes: ReadonlyArray<string>;
}

export interface LogoutResponseData {
  readonly id: string;
  readonly issuer: string;
  readonly destination: string | undefined;
  readonly issueInstant: DateTime.Utc | undefined;
  readonly inResponseTo: string | undefined;
  readonly succeeded: boolean;
}

const issuerOf = (root: Element): string | undefined => {
  const element = SafeXml.childrenNamed(root, saml("Issuer"))[0];
  const text = element === undefined ? undefined : SafeXml.textOf(element)?.trim();
  return text === undefined || text === "" ? undefined : text;
};

/** Reads a verified `LogoutRequest`. The root must be the request: nothing else in the bytes is read. */
export const readLogoutRequest = Effect.fnUntraced(function* (signedXml: string) {
  const root = yield* SafeXml.parse(signedXml).pipe(
    Effect.mapError(() => new LogoutInvalid({ reason: "unreadable" })),
  );
  if (!SafeXml.isNamed(root, LOGOUT_REQUEST)) return yield* reject("notALogoutRequest");
  const issuer = issuerOf(root);
  if (issuer === undefined) return yield* reject("noIssuer");
  const nameIdElement = SafeXml.childrenNamed(root, saml("NameID"))[0];
  const nameIdValue =
    nameIdElement === undefined ? undefined : SafeXml.textOf(nameIdElement)?.trim();
  // An EncryptedID is refused: this SP has no decryption key by design (BEH-EA-244's encrypted-assertion decision).
  if (nameIdElement === undefined || nameIdValue === undefined || nameIdValue === "") {
    return yield* reject("noNameId");
  }
  const issueInstant = instant(SafeXml.attribute(root, "IssueInstant"));
  const notOnOrAfter = instant(SafeXml.attribute(root, "NotOnOrAfter"));
  if (issueInstant === "invalid" || notOnOrAfter === "invalid")
    return yield* reject("malformedTime");
  const result: LogoutRequestData = {
    id: SafeXml.attribute(root, "ID") ?? "",
    issuer,
    destination: SafeXml.attribute(root, "Destination"),
    issueInstant,
    notOnOrAfter,
    nameId: { value: nameIdValue, format: SafeXml.attribute(nameIdElement, "Format") },
    sessionIndexes: SafeXml.childrenNamed(root, samlp("SessionIndex")).flatMap((element) => {
      const text = SafeXml.textOf(element)?.trim();
      return text === undefined || text === "" ? [] : [text];
    }),
  };
  return result;
});

/** Reads a verified `LogoutResponse`. */
export const readLogoutResponse = Effect.fnUntraced(function* (signedXml: string) {
  const root = yield* SafeXml.parse(signedXml).pipe(
    Effect.mapError(() => new LogoutInvalid({ reason: "unreadable" })),
  );
  if (!SafeXml.isNamed(root, LOGOUT_RESPONSE)) return yield* reject("notALogoutResponse");
  const issuer = issuerOf(root);
  if (issuer === undefined) return yield* reject("noIssuer");
  const issueInstant = instant(SafeXml.attribute(root, "IssueInstant"));
  if (issueInstant === "invalid") return yield* reject("malformedTime");
  const status = SafeXml.childrenNamed(root, samlp("Status"))[0];
  const code =
    status === undefined ? undefined : SafeXml.childrenNamed(status, samlp("StatusCode"))[0];
  const result: LogoutResponseData = {
    id: SafeXml.attribute(root, "ID") ?? "",
    issuer,
    destination: SafeXml.attribute(root, "Destination"),
    issueInstant,
    inResponseTo: SafeXml.attribute(root, "InResponseTo"),
    succeeded:
      code !== undefined &&
      SafeXml.attribute(code, "Value") === "urn:oasis:names:tc:SAML:2.0:status:Success",
  };
  return result;
});

export interface LogoutExpectations {
  /** The connection's `idpEntityId`. */
  readonly idpEntityId: string;
  /** This SP's logout endpoint URL: the `Destination` every signed message must carry. */
  readonly sloUrl: string;
  readonly now: DateTime.Utc;
  /** Bounded clock skew, milliseconds. */
  readonly skewMillis: number;
  /** How old (or how far ahead) an `IssueInstant` may be, milliseconds (skew included by the caller). */
  readonly freshnessMillis: number;
}

const millis = DateTime.toEpochMillis;

const judgeCommon = (
  message: {
    readonly issuer: string;
    readonly destination: string | undefined;
    readonly issueInstant: DateTime.Utc | undefined;
  },
  expected: LogoutExpectations,
) =>
  Effect.gen(function* () {
    if (message.issuer !== expected.idpEntityId) return yield* reject("issuerMismatch");
    if (message.destination !== expected.sloUrl) return yield* reject("destinationMismatch");
    if (message.issueInstant === undefined) return yield* reject("noIssueInstant");
    if (Math.abs(millis(expected.now) - millis(message.issueInstant)) > expected.freshnessMillis) {
      return yield* reject("stale");
    }
  });

/** BEH-EA-315: issuer, destination, freshness, and a `NotOnOrAfter` that has not passed. */
export const validateLogoutRequest = Effect.fnUntraced(function* (
  request: LogoutRequestData,
  expected: LogoutExpectations,
) {
  yield* judgeCommon(request, expected);
  if (
    request.notOnOrAfter !== undefined &&
    millis(expected.now) >= millis(request.notOnOrAfter) + expected.skewMillis
  ) {
    return yield* reject("expired");
  }
  if (request.id === "") return yield* reject("noId");
  return request;
});

/** BEH-EA-315: issuer, destination, freshness, `InResponseTo` naming the request this SP made, and a success status. */
export const validateLogoutResponse = Effect.fnUntraced(function* (
  response: LogoutResponseData,
  expected: LogoutExpectations & { readonly inResponseTo: string },
) {
  yield* judgeCommon(response, expected);
  if (response.inResponseTo !== expected.inResponseTo) return yield* reject("inResponseToMismatch");
  return response;
});
