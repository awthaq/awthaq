// @awthaq/jwt — Plugin (M7)
//
// Short-lived, self-contained, cryptographically signed JWTs representing
// an already-authenticated caller — EdDSA/ES256, JWKS with grace-period
// key rotation, a standalone lite verifier for downstream services, and
// general-purpose signing primitives.
//
// See spec/overview.md for the full package map, and .scratch/jwt/spec.md
// for this plugin's own full design.

export * as Jwt from "./Jwt.ts";
export * as JwtApi from "./JwtApi.ts";
export * as JwtCodec from "./JwtCodec.ts";
export * as JwtConfig from "./JwtConfig.ts";
export * as KeyRing from "./KeyRing.ts";
export * as RevocationStore from "./RevocationStore.ts";
export * as SigningKeyRecords from "./SigningKeyRecords.ts";
export * as Verify from "./verify.ts";
