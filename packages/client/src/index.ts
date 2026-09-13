// @effect-auth/client — Client
//
// AtomHttpApi client and session atom — the isomorphic Effect client derived from the merged contract.
//
// Implemented: AuthClient.ts (spec/behaviors/22-client-effect.md, BEH-EA-169
// through BEH-EA-176 — see that module's own header comment for what is
// deliberately deferred: the `AtomHttpApi`-based reactive binding, no longer
// blocked (`effect` itself ships `AtomHttpApi` natively at
// `effect/unstable/reactivity`) but left for `@effect-auth/react`'s own
// package to build, and the `{csrf: false}` contract variant, which has
// nothing to strip yet since no plugin group in this repository declares
// `CsrfProtection` middleware today).
// See spec/overview.md for the full package map.

export * as AuthClient from "./AuthClient.ts";
