// @awthaq/ports — XmlSignature
//
// SFS-003 (ADR-EA-023 Decision 3): the port XML-DSig verification sits behind, so `@awthaq/saml` (and
// anything else that consumes signed XML) requires a *fused parse-and-verify* and never holds an unverified
// document. XML signatures fail in one characteristic way: a valid signature over one element is
// presented while the application reads another (signature wrapping, XSW). The contract makes that
// unrepresentable instead of merely tested for:
//
//   - `verify` takes the raw document and returns ONLY the canonical bytes of the element a verified
//     signature covers (`VerifiedXml.signedXml`). Nothing else escapes: no DOM of the unverified input, no
//     "find the Assertion in the document" query. A caller parses `signedXml` and reads from that.
//   - Parsing happens inside the port, with DTDs, entities, processing-instruction stylesheets and comments
//     refused, so no XXE, billion-laughs or comment-injection surface exists at the caller.
//   - Canonicalization is exclusive C14N and internal; the algorithm allow-list refuses SHA-1 (and every
//     transform but enveloped-signature and exclusive C14N: no XSLT, no XPath).
//   - The signer is pinned: verification uses only certificates from the caller's trust set (matched by
//     fingerprint, inside their `notBefore`/`notAfter` window so a key rotation can overlap); a certificate
//     the document names in its own `KeyInfo` is never used to verify and, if it is not pinned, refuses the document.
//   - The structural rules a caller states in the `policy` (how many elements of a name, which element may be
//     signed) are checked before any cryptography.
//
// An application (or `@awthaq/saml`) provides an implementation; `layerUnavailable` is the composition-time
// default that fails loudly so a forgotten adapter is a defect, not a silent pass.

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** An XML element name: namespace URI plus local name. */
export interface ElementName {
  readonly namespace: string;
  readonly localName: string;
}

export interface TrustedCertificate {
  /** SHA-256 of the DER certificate, lower-case hex without separators. */
  readonly fingerprint: string;
  readonly pem: string;
  /** The certificate is trusted from this instant (inclusive) ... */
  readonly notBefore: DateTime.Utc;
  /** ... until this one (exclusive). Outside the window it is not trusted, so an IdP's next key can be published ahead of its use. */
  readonly notAfter: DateTime.Utc;
}

/** The signers a document may be verified against. Several entries are the rotation overlap. */
export interface TrustSet {
  readonly certificates: ReadonlyArray<TrustedCertificate>;
}

export interface VerifyPolicy {
  /** Refuse a document larger than this many bytes (UTF-8) before it is parsed. Default 262144 (256 KiB). */
  readonly maxBytes?: number;
  /** The element a verified signature may cover (the Reference target). At least one. The first entry with a verified signature wins. */
  readonly signedElements: ReadonlyArray<ElementName>;
  /** Elements that must occur exactly once in the whole document (the cardinality that removes wrapping's ambiguity). */
  readonly exactlyOne?: ReadonlyArray<ElementName>;
  /** Elements whose presence anywhere refuses the document (e.g. an encrypted assertion this build cannot read). */
  readonly forbidden?: ReadonlyArray<ElementName>;
  /** The instant certificate windows are judged at. Default: the ambient clock. */
  readonly now?: DateTime.Utc;
}

/** What survives verification: the signed element and how it was signed. Never anything from outside it. */
export interface VerifiedXml {
  /** The canonical (exclusive C14N, no comments) XML of the signed element, exactly the bytes the digest covers. */
  readonly signedXml: string;
  readonly signedElement: ElementName;
  /** The signed element's own `ID`. */
  readonly signedId: string;
  readonly signatureAlgorithm: string;
  readonly digestAlgorithm: string;
  /** The pinned certificate the signature verified against. */
  readonly certificateFingerprint: string;
}

export type XmlSignatureFailure =
  | "tooLarge"
  | "malformed"
  | "doctype"
  | "processingInstruction"
  | "comment"
  | "forbiddenElement"
  | "cardinality"
  | "duplicateId"
  | "noSignature"
  | "tooManySignatures"
  | "signatureStructure"
  | "signatureNotEnveloped"
  | "unsupportedAlgorithm"
  | "unsupportedTransform"
  | "unsignedElement"
  | "untrustedKey"
  | "noTrustedCertificate"
  | "invalidSignature";

/**
 * Verification failed. `reason` is for the log and the audit event, never for the wire (a validation
 * oracle tells an attacker which rule to work around); `detail` is a constant description, never an
 * excerpt of the input.
 */
export class XmlSignatureError extends Data.TaggedError("XmlSignatureError")<{
  readonly reason: XmlSignatureFailure;
  readonly detail: string;
}> {}

export interface XmlSignatureShape {
  readonly verify: (input: {
    readonly xml: string;
    readonly trust: TrustSet;
    readonly policy: VerifyPolicy;
  }) => Effect.Effect<VerifiedXml, XmlSignatureError>;
}

export class XmlSignature extends Context.Service<XmlSignature, XmlSignatureShape>()(
  "awthaq/ports/XmlSignature",
) {}

/** Every verification fails as `invalidSignature`: a placeholder that makes a composition without an adapter refuse, never accept. */
export const layerUnavailable = Layer.succeed(
  XmlSignature,
  XmlSignature.of({
    verify: () =>
      Effect.fail(
        new XmlSignatureError({
          reason: "invalidSignature",
          detail: "no XmlSignature adapter is installed",
        }),
      ),
  }),
);
