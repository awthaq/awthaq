// @awthaq/saml — SamlKeys
//
// BEH-EA-305: the service provider's own signing material, and the two signature forms it produces.
//
//   - A SIGNING KEY is an RSA key pair (at least 2048 bits) and a self-signed X.509 certificate for it. `generateSigningKey`
//     makes one (node:crypto for the key and the signature; the certificate's DER is assembled here, because Node has no
//     certificate builder and a service provider needs no CA); `describeSigningKey` validates one an operator brings
//     (the key must parse, be RSA >= 2048 and match the certificate). The private half never leaves this module in the
//     clear except into `signRedirect`/`signXml`; the connection store seals it with the `Encryption` port before it is
//     written (`SamlSpKeys`).
//   - The HTTP-Redirect binding (SAML bindings 3.4.4.1) does NOT use an enveloped XML signature: the signature is over the
//     exact octets of the query string `SAMLRequest=..[&RelayState=..]&SigAlg=..` and travels as a `Signature` parameter.
//     `signRedirect` produces it; `verifyRedirect` checks an inbound one against a pinned trust set (algorithm allow-list
//     RSA-SHA256/512, certificates inside their validity windows, nothing taken from the message itself).
//   - The HTTP-POST binding carries an enveloped XML-DSig signature, produced here over `xml-crypto` (the library the
//     `XmlSignature` verifier already uses) and verified by that same port.

import type { XmlSignature } from "@awthaq/ports";
import {
  constants,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPair,
  randomBytes,
  sign,
  X509Certificate,
} from "node:crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { SignedXml } from "xml-crypto";

export const SIG_ALG_RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
export const SIG_ALG_RSA_SHA512 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512";
const NODE_ALGORITHM: Readonly<Record<string, string>> = {
  [SIG_ALG_RSA_SHA256]: "RSA-SHA256",
  [SIG_ALG_RSA_SHA512]: "RSA-SHA512",
};

export class InvalidSigningKey extends Data.TaggedError("InvalidSigningKey")<{
  readonly reason: string;
}> {}

// ---- a minimal DER writer, enough for one self-signed certificate ---------------------------------

type Bytes = Uint8Array;

const concat = (parts: ReadonlyArray<Bytes>): Bytes => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const lengthOf = (length: number): Bytes => {
  if (length < 0x80) return Uint8Array.of(length);
  const digits: Array<number> = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) digits.unshift(rest % 256);
  return Uint8Array.of(0x80 + digits.length, ...digits);
};

const der = (tag: number, ...contents: ReadonlyArray<Bytes>): Bytes => {
  const body = concat(contents);
  return concat([Uint8Array.of(tag), lengthOf(body.length), body]);
};

const sequence = (...contents: ReadonlyArray<Bytes>) => der(0x30, ...contents);
const set = (...contents: ReadonlyArray<Bytes>) => der(0x31, ...contents);
const explicit = (index: number, content: Bytes) => der(0xa0 + index, content);
const bitString = (content: Bytes) => der(0x03, Uint8Array.of(0), content);
const octetString = (content: Bytes) => der(0x04, content);
const utf8 = (text: string) => der(0x0c, new TextEncoder().encode(text));
const nullValue = Uint8Array.of(0x05, 0x00);
const boolean = (value: boolean) => der(0x01, Uint8Array.of(value ? 0xff : 0x00));

const integer = (bytes: Bytes): Bytes => {
  // Two's complement: strip leading zeros, then prepend one if the top bit is set (a positive number).
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const trimmed = bytes.slice(start);
  return der(
    0x02,
    trimmed[0] !== undefined && trimmed[0] >= 0x80 ? concat([Uint8Array.of(0), trimmed]) : trimmed,
  );
};

const oid = (dotted: string): Bytes => {
  const arcs = dotted.split(".").map(Number);
  const [first = 0, second = 0, ...rest] = arcs;
  const encode = (value: number): Array<number> => {
    const groups = [value % 128];
    for (
      let remaining = Math.floor(value / 128);
      remaining > 0;
      remaining = Math.floor(remaining / 128)
    ) {
      groups.unshift((remaining % 128) + 128);
    }
    return groups;
  };
  return der(0x06, Uint8Array.of(first * 40 + second, ...rest.flatMap(encode)));
};

const two = (value: number) => String(value).padStart(2, "0");

/** UTCTime up to 2049, GeneralizedTime after (RFC 5280 4.1.2.5). */
const time = (instant: Date): Bytes => {
  const year = instant.getUTCFullYear();
  const rest = `${two(instant.getUTCMonth() + 1)}${two(instant.getUTCDate())}${two(instant.getUTCHours())}${two(instant.getUTCMinutes())}${two(instant.getUTCSeconds())}Z`;
  return year < 2050
    ? der(0x17, new TextEncoder().encode(`${two(year % 100)}${rest}`))
    : der(0x18, new TextEncoder().encode(`${year}${rest}`));
};

const name = (commonName: string): Bytes =>
  sequence(set(sequence(oid("2.5.4.3"), utf8(commonName))));

const SHA256_WITH_RSA = sequence(oid("1.2.840.113549.1.1.11"), nullValue);

const pemOf = (label: string, body: Bytes): string => {
  const base64 = Buffer.from(body).toString("base64");
  return `-----BEGIN ${label}-----\n${base64.match(/.{1,64}/g)?.join("\n") ?? ""}\n-----END ${label}-----\n`;
};

const certificateDer = (input: {
  readonly commonName: string;
  readonly publicKeyDer: Bytes;
  readonly signWith: (tbs: Bytes) => Bytes;
  readonly notBefore: Date;
  readonly notAfter: Date;
}): Bytes => {
  const extensions = explicit(
    3,
    sequence(
      // basicConstraints: not a CA.
      sequence(oid("2.5.29.19"), boolean(true), octetString(sequence())),
      // keyUsage: digitalSignature.
      sequence(oid("2.5.29.15"), boolean(true), octetString(der(0x03, Uint8Array.of(7, 0x80)))),
    ),
  );
  const tbs = sequence(
    explicit(0, integer(Uint8Array.of(2))),
    integer(randomBytes(16)),
    SHA256_WITH_RSA,
    name(input.commonName),
    sequence(time(input.notBefore), time(input.notAfter)),
    name(input.commonName),
    input.publicKeyDer,
    extensions,
  );
  return sequence(tbs, SHA256_WITH_RSA, bitString(input.signWith(tbs)));
};

// ---- keys ------------------------------------------------------------------------------------------

export interface SigningKey {
  /** PKCS#8 PEM. Seal it (`Encryption`) before it is stored. */
  readonly privateKeyPem: string;
  /** Self-signed X.509 PEM: what the IdP is given (in SP metadata) to verify our signatures. */
  readonly certificatePem: string;
  /** SHA-256 of the DER certificate, lower-case hex. */
  readonly fingerprint: string;
  readonly notBefore: DateTime.Utc;
  readonly notAfter: DateTime.Utc;
}

const MIN_MODULUS = 2048;

const fingerprintOf = (certificate: X509Certificate): string =>
  certificate.fingerprint256.replaceAll(":", "").toLowerCase();

const viewOf = (privateKeyPem: string, certificate: X509Certificate): SigningKey => ({
  privateKeyPem,
  certificatePem: certificate.toString(),
  fingerprint: fingerprintOf(certificate),
  notBefore: DateTime.makeUnsafe(certificate.validFromDate),
  notAfter: DateTime.makeUnsafe(certificate.validToDate),
});

/** A fresh RSA-2048 key and a self-signed certificate valid from `notBefore` for `validity`. */
export const generateSigningKey = (input: {
  readonly commonName: string;
  readonly notBefore: DateTime.Utc;
  readonly validityDays: number;
}) =>
  Effect.tryPromise({
    try: async () => {
      const pair = await new Promise<{
        readonly privateKey: string;
        readonly publicKeyDer: Buffer;
      }>((resolve, reject) =>
        generateKeyPair(
          "rsa",
          {
            modulusLength: MIN_MODULUS,
            publicKeyEncoding: { type: "spki", format: "der" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" },
          },
          (error, publicKey, privateKey) =>
            error === null ? resolve({ privateKey, publicKeyDer: publicKey }) : reject(error),
        ),
      );
      const notBefore = DateTime.toDate(input.notBefore);
      const notAfter = new Date(notBefore.getTime() + input.validityDays * 86_400_000);
      const privateKey = createPrivateKey(pair.privateKey);
      const certificate = new X509Certificate(
        pemOf(
          "CERTIFICATE",
          certificateDer({
            commonName: input.commonName,
            publicKeyDer: pair.publicKeyDer,
            notBefore,
            notAfter,
            signWith: (tbs) => sign("sha256", tbs, privateKey),
          }),
        ),
      );
      return viewOf(pair.privateKey, certificate);
    },
    catch: () => new InvalidSigningKey({ reason: "a signing key could not be generated" }),
  });

/**
 * Validates a key pair an operator supplies: the private key must parse and be RSA of at least 2048 bits, the certificate
 * must parse and carry the SAME public key. Fails with a constant sentence, never an excerpt of the input.
 */
export const describeSigningKey = (
  privateKeyPem: string,
  certificatePem: string,
): Effect.Effect<SigningKey, InvalidSigningKey> =>
  Effect.try({
    try: () => {
      const invalid = (reason: string) => new InvalidSigningKey({ reason });
      const privateKey = createPrivateKey(privateKeyPem);
      if (privateKey.asymmetricKeyType !== "rsa")
        throw invalid("the signing key must be an RSA key");
      if ((privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_MODULUS) {
        throw invalid(`the signing key must be at least ${MIN_MODULUS} bits`);
      }
      const certificate = new X509Certificate(certificatePem);
      const fromKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
      const fromCertificate = certificate.publicKey.export({ type: "spki", format: "der" });
      if (!fromKey.equals(fromCertificate)) {
        throw invalid("the signing certificate is not the one for this private key");
      }
      // Re-export in PKCS#8 so what is sealed is one canonical form whatever the input spelled.
      return viewOf(privateKey.export({ type: "pkcs8", format: "pem" }).toString(), certificate);
    },
    catch: (cause) =>
      cause instanceof InvalidSigningKey
        ? cause
        : new InvalidSigningKey({ reason: "the signing key or certificate could not be read" }),
  });

// ---- HTTP-Redirect binding signatures -------------------------------------------------------------

/** `encodeURIComponent` with upper-case hex, as SAML bindings 3.4.4.1 wants for the signed octets. */
const urlEncode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * The octets a redirect-binding signature covers, from raw (already URL-encoded) parameter values, in the mandated
 * order: `<SAMLRequest|SAMLResponse>=..[&RelayState=..]&SigAlg=..`.
 */
export const redirectSignedOctets = (input: {
  readonly kind: "SAMLRequest" | "SAMLResponse";
  readonly message: string;
  readonly relayState: string | undefined;
  readonly sigAlg: string;
}): string =>
  `${input.kind}=${input.message}${input.relayState === undefined ? "" : `&RelayState=${input.relayState}`}&SigAlg=${input.sigAlg}`;

/** Builds a signed redirect query string (`SAMLRequest=..&RelayState=..&SigAlg=..&Signature=..`, all URL-encoded). */
export const signRedirect = (input: {
  readonly kind: "SAMLRequest" | "SAMLResponse";
  /** base64 of the DEFLATE-compressed message, NOT yet URL-encoded. */
  readonly message: string;
  readonly relayState?: string | undefined;
  readonly privateKeyPem: string;
}): string => {
  const octets = redirectSignedOctets({
    kind: input.kind,
    message: urlEncode(input.message),
    relayState: input.relayState === undefined ? undefined : urlEncode(input.relayState),
    sigAlg: urlEncode(SIG_ALG_RSA_SHA256),
  });
  const signature = createSign("RSA-SHA256")
    .update(octets)
    .sign(input.privateKeyPem)
    .toString("base64");
  return `${octets}&Signature=${urlEncode(signature)}`;
};

/** An unsigned redirect query string. */
export const plainRedirect = (input: {
  readonly kind: "SAMLRequest" | "SAMLResponse";
  readonly message: string;
  readonly relayState?: string | undefined;
}): string =>
  `${input.kind}=${urlEncode(input.message)}${input.relayState === undefined ? "" : `&RelayState=${urlEncode(input.relayState)}`}`;

/**
 * Verifies an inbound redirect-binding signature over the octets the SENDER signed (the raw, still-encoded parameters, in
 * the mandated order; re-encoding decoded values would change them). Only `sigAlg`s on the allow-list are accepted (SHA-1
 * and anything unknown are refused), and only certificates the caller pinned, inside their validity windows, are used:
 * nothing about the key comes from the message.
 */
export const verifyRedirect = (input: {
  readonly octets: string;
  /** The `Signature` parameter, URL-decoded (base64). */
  readonly signature: string;
  /** The `SigAlg` parameter, URL-decoded. */
  readonly sigAlg: string;
  readonly trust: XmlSignature.TrustSet;
  readonly now: DateTime.Utc;
}): boolean => {
  const algorithm = NODE_ALGORITHM[input.sigAlg];
  if (algorithm === undefined) return false;
  const signature = Buffer.from(input.signature, "base64");
  if (signature.length === 0) return false;
  const at = DateTime.toEpochMillis(input.now);
  let verified = false;
  for (const certificate of input.trust.certificates) {
    if (at < DateTime.toEpochMillis(certificate.notBefore)) continue;
    if (at >= DateTime.toEpochMillis(certificate.notAfter)) continue;
    try {
      // Every candidate is checked (no early exit), as the XML verifier does.
      if (
        createVerify(algorithm)
          .update(input.octets)
          .verify({ key: certificate.pem, padding: constants.RSA_PKCS1_PADDING }, signature)
      ) {
        verified = true;
      }
    } catch {
      // A certificate that cannot verify is simply not the signer.
    }
  }
  return verified;
};

// ---- HTTP-POST binding: an enveloped XML signature ------------------------------------------------

/**
 * Signs the element with `ID = referenceId` (the message's root) with RSA-SHA256 and SHA-256, exclusive C14N and the
 * enveloped-signature transform, placing `ds:Signature` right after the `saml:Issuer`, where the SAML schema wants it.
 * No `KeyInfo`: the IdP holds the SP certificate from its metadata, and the verifier never trusts a certificate a document
 * names anyway.
 */
export const signXml = (input: {
  readonly xml: string;
  readonly referenceId: string;
  readonly privateKeyPem: string;
}): string => {
  const signer = new SignedXml({
    privateKey: input.privateKeyPem,
    signatureAlgorithm: SIG_ALG_RSA_SHA256,
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    getKeyInfoContent: () => null,
  });
  signer.addReference({
    xpath: `//*[@ID='${input.referenceId}']`,
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  signer.computeSignature(input.xml, {
    prefix: "ds",
    location: {
      reference: `//*[@ID='${input.referenceId}']/*[local-name(.)='Issuer']`,
      action: "after",
    },
  });
  return signer.getSignedXml();
};
