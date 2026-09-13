// @effect-auth/api — Contract stratum (1)
//
// Principal, SessionView, SubjectDto, errors, Authentication and CsrfProtection middleware definitions, core groups — isomorphic, no server code, importable in the browser.
//
// Implemented: Api.ts (spec/behaviors/04-contract-stratum.md, BEH-EA-025/027/028/029/030 —
// Principal, contract errors, and the Authentication/OptionalAuthentication/CsrfProtection
// middleware *declarations*), Session.ts (BEH-EA-031 — the core `session` group),
// AuthCore.ts (the "auth" HttpApi id that group mounts under).
// Planned next: SessionView/SubjectDto (BEH-EA-026), folding `session` into `Auth.make`'s
// full plugin-composed `api` (BEH-EA-032) rather than the standalone `AuthCoreApi` here.
// See spec/overview.md for the full package map.

export * as Api from "./Api.ts";
export * as AuthCore from "./AuthCore.ts";
export * as SessionContract from "./Session.ts";
