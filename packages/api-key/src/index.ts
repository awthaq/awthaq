// @awthaq/api-key — Plugin (M7)
//
// Long-lived API keys and `client_credentials` service identity: hashed-at-rest keys with
// expiry, revocation and dual-validity rotation (`x-api-key`), and short-lived service
// JWTs minted through `@awthaq/jwt` (`POST /api-key/token`). Both resolve through
// `@awthaq/server`'s credential-resolver registry to non-user principals
// (`ApiKeyPrincipal`/`ServicePrincipal`, `Api.MachineAuthentication`).
//
// Implemented: ApiKey.ts (spec/models/07-api-keys.md, BEH-EA-140/141, ADR-EA-022),
// ApiKeyApi.ts (the contract), ApiKeyRecords.ts / ApiKeyClientRecords.ts (persistence).
// See spec/overview.md for the full package map.

export * as ApiKey from "./ApiKey.ts";
export * as ApiKeyApi from "./ApiKeyApi.ts";
export * as ApiKeyClientRecords from "./ApiKeyClientRecords.ts";
export * as ApiKeyRecords from "./ApiKeyRecords.ts";
