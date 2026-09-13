// @awthaq/password — Plugin (M2)
//
// spec/behaviors/15-password.md, BEH-EA-113 through BEH-EA-120.
// `Password`/`Password.layer` (sign-up, sign-in, request/confirm reset, an
// argon2id/scrypt-backed rehash-on-login, an optional HIBP breach check)
// and `PasswordApi`/`PasswordGroup` (this plugin's own contract, mounted
// under the shared `"auth"` id, group `"password"`) — see `Password.ts`'s
// own header comment for exactly which parts of BEH-EA-113's illustrative
// sketch this fills in and how.
//
// See spec/overview.md for the full package map.

export * as Password from "./Password.ts";
export * as PasswordApi from "./PasswordApi.ts";
