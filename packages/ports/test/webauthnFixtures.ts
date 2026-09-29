// Test-only support: builds real, cryptographically valid WebAuthn
// ceremony payloads for `WebAuthn.test.ts` — a small software authenticator
// (an ECDSA P-256 keypair via `node:crypto`), CBOR/COSE-encoded the same
// way a real security key would be, "none" attestation (no attestation
// signature to construct — see BEH-EA-135's own default), and a real
// ECDSA signature over `authenticatorData || SHA-256(clientDataJSON)` for
// the authentication path. This lets `WebAuthn.test.ts` exercise
// `@simplewebauthn/server`'s real cryptographic verification rather than
// only ever feeding it deliberately-broken input.
//
// Every `Uint8Array`-shaped value here is typed as the library's own
// `Uint8Array_` (`ReturnType<Uint8Array['slice']>`, effectively
// `Uint8Array<ArrayBuffer>`) rather than the bare `Uint8Array` type —
// this project's TypeScript defaults a bare `Uint8Array` reference to the
// looser `Uint8Array<ArrayBufferLike>`, which the library's own
// (correctly stricter) signatures reject.
import { createHash, generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  Uint8Array_,
} from "@simplewebauthn/server";
import { cose, isoBase64URL, isoCBOR, isoUint8Array } from "@simplewebauthn/server/helpers";

const sha256 = (data: Uint8Array_): Uint8Array_ =>
  new Uint8Array(createHash("sha256").update(data).digest());

export interface SoftwareAuthenticator {
  readonly credentialId: Uint8Array_;
  readonly privateKey: KeyObject;
  readonly publicKeyX: Uint8Array_;
  readonly publicKeyY: Uint8Array_;
}

export const makeAuthenticator = (credentialId: Uint8Array_): SoftwareAuthenticator => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  return {
    credentialId,
    privateKey,
    publicKeyX: isoBase64URL.toBuffer(jwk.x),
    publicKeyY: isoBase64URL.toBuffer(jwk.y),
  };
};

export const encodeCosePublicKey = (authenticator: SoftwareAuthenticator): Uint8Array_ => {
  const map = new Map<number, number | Uint8Array_>();
  map.set(cose.COSEKEYS.kty, cose.COSEKTY.EC2);
  map.set(cose.COSEKEYS.alg, cose.COSEALG.ES256);
  map.set(cose.COSEKEYS.crv, cose.COSECRV.P256);
  map.set(cose.COSEKEYS.x, authenticator.publicKeyX);
  map.set(cose.COSEKEYS.y, authenticator.publicKeyY);
  return isoCBOR.encode(map);
};

const flagsByte = (input: {
  readonly up: boolean;
  readonly uv: boolean;
  readonly at: boolean;
}): number => (input.up ? 0x01 : 0) | (input.uv ? 0x04 : 0) | (input.at ? 0x40 : 0);

/** Parses a canonical `8-4-4-4-12` AAGUID into its 16 raw bytes. */
const aaguidBytes = (aaguid: string): Uint8Array_ =>
  new Uint8Array(Buffer.from(aaguid.replaceAll("-", ""), "hex"));

const counterBytes = (counter: number): Uint8Array_ => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, counter, false);
  return bytes;
};

const buildRegistrationAuthenticatorData = (input: {
  readonly rpId: string;
  readonly authenticator: SoftwareAuthenticator;
  readonly counter?: number;
  readonly userVerified?: boolean;
  readonly userPresent?: boolean;
  readonly aaguid?: string;
}): Uint8Array_ => {
  const rpIdHash = sha256(isoUint8Array.fromUTF8String(input.rpId));
  const flags = flagsByte({
    up: input.userPresent ?? true,
    uv: input.userVerified ?? true,
    at: true,
  });
  const aaguid = input.aaguid === undefined ? new Uint8Array(16) : aaguidBytes(input.aaguid);
  const credentialIdLength = new Uint8Array(2);
  new DataView(credentialIdLength.buffer).setUint16(
    0,
    input.authenticator.credentialId.length,
    false,
  );
  return isoUint8Array.concat([
    rpIdHash,
    new Uint8Array([flags]),
    counterBytes(input.counter ?? 0),
    aaguid,
    credentialIdLength,
    input.authenticator.credentialId,
    encodeCosePublicKey(input.authenticator),
  ]);
};

const buildAuthenticationAuthenticatorData = (input: {
  readonly rpId: string;
  readonly counter: number;
  readonly userVerified?: boolean;
  readonly userPresent?: boolean;
}): Uint8Array_ => {
  const rpIdHash = sha256(isoUint8Array.fromUTF8String(input.rpId));
  const flags = flagsByte({
    up: input.userPresent ?? true,
    uv: input.userVerified ?? true,
    at: false,
  });
  return isoUint8Array.concat([rpIdHash, new Uint8Array([flags]), counterBytes(input.counter)]);
};

const buildClientDataJSON = (input: {
  readonly type: "webauthn.create" | "webauthn.get";
  readonly challenge: string;
  readonly origin: string;
  readonly crossOrigin?: boolean;
  readonly topOrigin?: string;
}): string =>
  isoBase64URL.fromUTF8String(
    JSON.stringify({
      type: input.type,
      challenge: input.challenge,
      origin: input.origin,
      crossOrigin: input.crossOrigin ?? false,
      ...(input.topOrigin === undefined ? {} : { topOrigin: input.topOrigin }),
    }),
  );

const buildNoneAttestationObject = (authData: Uint8Array_): Uint8Array_ => {
  const map = new Map<string, string | Uint8Array_ | Map<string, never>>();
  map.set("fmt", "none");
  map.set("attStmt", new Map<string, never>());
  map.set("authData", authData);
  return isoCBOR.encode(map);
};

/**
 * HSK-008: a `packed` *self*-attestation — the attestation statement is an
 * ES256 signature over `authData || SHA-256(clientDataJSON)` made with the
 * credential's own private key (no `x5c` chain), exactly what a real
 * security key that does not ship a batch attestation certificate answers.
 */
const buildPackedSelfAttestationObject = (
  authData: Uint8Array_,
  clientDataJSON: string,
  authenticator: SoftwareAuthenticator,
): Uint8Array_ => {
  const clientDataHash = sha256(isoBase64URL.toBuffer(clientDataJSON));
  const signature = nodeSign(
    "sha256",
    isoUint8Array.concat([authData, clientDataHash]),
    authenticator.privateKey,
  );
  const attStmt = new Map<string, number | Uint8Array_>();
  attStmt.set("alg", cose.COSEALG.ES256);
  attStmt.set("sig", new Uint8Array(signature));
  const map = new Map<string, string | Uint8Array_ | Map<string, number | Uint8Array_>>();
  map.set("fmt", "packed");
  map.set("attStmt", attStmt);
  map.set("authData", authData);
  return isoCBOR.encode(map);
};

/** BEH-EA-135's default: `"none"` attestation carries no attestation signature at all, so no signing is needed here — only the client-data/authenticator-data shape matters. `attestation: "packed-self"` (HSK-008) builds a real, self-signed packed statement instead. */
export const buildRegistrationResponse = (input: {
  readonly authenticator: SoftwareAuthenticator;
  readonly rpId: string;
  readonly origin: string;
  readonly challenge: string;
  readonly counter?: number;
  readonly userVerified?: boolean;
  readonly userPresent?: boolean;
  /** Canonical `8-4-4-4-12` AAGUID; the all-zero one when omitted. */
  readonly aaguid?: string;
  readonly attestation?: "none" | "packed-self";
  /** What the browser reports via `getTransports()`. */
  readonly transports?: ReadonlyArray<"usb" | "nfc" | "ble" | "internal" | "hybrid">;
  readonly crossOrigin?: boolean;
  readonly topOrigin?: string;
}): RegistrationResponseJSON => {
  const authData = buildRegistrationAuthenticatorData(input);
  const clientDataJSON = buildClientDataJSON({
    type: "webauthn.create",
    challenge: input.challenge,
    origin: input.origin,
    ...(input.crossOrigin === undefined ? {} : { crossOrigin: input.crossOrigin }),
    ...(input.topOrigin === undefined ? {} : { topOrigin: input.topOrigin }),
  });
  const credentialIdB64 = isoBase64URL.fromBuffer(input.authenticator.credentialId);
  const attestationObject =
    input.attestation === "packed-self"
      ? buildPackedSelfAttestationObject(authData, clientDataJSON, input.authenticator)
      : buildNoneAttestationObject(authData);
  return {
    id: credentialIdB64,
    rawId: credentialIdB64,
    response: {
      clientDataJSON,
      attestationObject: isoBase64URL.fromBuffer(attestationObject),
      ...(input.transports === undefined ? {} : { transports: [...input.transports] }),
    },
    clientExtensionResults: {},
    type: "public-key",
  };
};

export const buildAuthenticationResponse = (input: {
  readonly authenticator: SoftwareAuthenticator;
  readonly rpId: string;
  readonly origin: string;
  readonly challenge: string;
  readonly counter: number;
  readonly userVerified?: boolean;
  readonly userPresent?: boolean;
  readonly userHandle?: string;
  readonly crossOrigin?: boolean;
  readonly topOrigin?: string;
}): AuthenticationResponseJSON => {
  const authData = buildAuthenticationAuthenticatorData(input);
  const clientDataJSON = buildClientDataJSON({
    type: "webauthn.get",
    challenge: input.challenge,
    origin: input.origin,
    ...(input.crossOrigin === undefined ? {} : { crossOrigin: input.crossOrigin }),
    ...(input.topOrigin === undefined ? {} : { topOrigin: input.topOrigin }),
  });
  const clientDataHash = sha256(isoBase64URL.toBuffer(clientDataJSON));
  const signature = nodeSign(
    "sha256",
    isoUint8Array.concat([authData, clientDataHash]),
    input.authenticator.privateKey,
  );
  const credentialIdB64 = isoBase64URL.fromBuffer(input.authenticator.credentialId);
  return {
    id: credentialIdB64,
    rawId: credentialIdB64,
    response: {
      clientDataJSON,
      authenticatorData: isoBase64URL.fromBuffer(authData),
      signature: isoBase64URL.fromBuffer(new Uint8Array(signature)),
      ...(input.userHandle === undefined ? {} : { userHandle: input.userHandle }),
    },
    clientExtensionResults: {},
    type: "public-key",
  };
};
