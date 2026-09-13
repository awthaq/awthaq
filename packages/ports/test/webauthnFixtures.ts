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
}): Uint8Array_ => {
  const rpIdHash = sha256(isoUint8Array.fromUTF8String(input.rpId));
  const flags = flagsByte({ up: true, uv: input.userVerified ?? true, at: true });
  const aaguid = new Uint8Array(16);
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
}): Uint8Array_ => {
  const rpIdHash = sha256(isoUint8Array.fromUTF8String(input.rpId));
  const flags = flagsByte({ up: true, uv: input.userVerified ?? true, at: false });
  return isoUint8Array.concat([rpIdHash, new Uint8Array([flags]), counterBytes(input.counter)]);
};

const buildClientDataJSON = (input: {
  readonly type: "webauthn.create" | "webauthn.get";
  readonly challenge: string;
  readonly origin: string;
}): string =>
  isoBase64URL.fromUTF8String(
    JSON.stringify({
      type: input.type,
      challenge: input.challenge,
      origin: input.origin,
      crossOrigin: false,
    }),
  );

const buildAttestationObject = (authData: Uint8Array_): Uint8Array_ => {
  const map = new Map<string, string | Uint8Array_ | Map<string, never>>();
  map.set("fmt", "none");
  map.set("attStmt", new Map<string, never>());
  map.set("authData", authData);
  return isoCBOR.encode(map);
};

/** BEH-EA-135's default: `"none"` attestation carries no attestation signature at all, so no signing is needed here — only the client-data/authenticator-data shape matters. */
export const buildRegistrationResponse = (input: {
  readonly authenticator: SoftwareAuthenticator;
  readonly rpId: string;
  readonly origin: string;
  readonly challenge: string;
  readonly counter?: number;
  readonly userVerified?: boolean;
}): RegistrationResponseJSON => {
  const authData = buildRegistrationAuthenticatorData(input);
  const clientDataJSON = buildClientDataJSON({
    type: "webauthn.create",
    challenge: input.challenge,
    origin: input.origin,
  });
  const credentialIdB64 = isoBase64URL.fromBuffer(input.authenticator.credentialId);
  return {
    id: credentialIdB64,
    rawId: credentialIdB64,
    response: {
      clientDataJSON,
      attestationObject: isoBase64URL.fromBuffer(buildAttestationObject(authData)),
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
}): AuthenticationResponseJSON => {
  const authData = buildAuthenticationAuthenticatorData(input);
  const clientDataJSON = buildClientDataJSON({
    type: "webauthn.get",
    challenge: input.challenge,
    origin: input.origin,
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
    },
    clientExtensionResults: {},
    type: "public-key",
  };
};
