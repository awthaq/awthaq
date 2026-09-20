// @awthaq/client — Client
//
// AtomHttpApi client and session atom — the isomorphic Effect client derived from the merged contract.
//
// Implemented: AuthClient.ts (spec/behaviors/22-client-effect.md, BEH-EA-169
// through BEH-EA-176 — see that module's own header comment for what is
// deliberately deferred: the `AtomHttpApi`-based reactive binding, no longer
// blocked (`effect` itself ships `AtomHttpApi` natively at
// `effect/unstable/reactivity`) but left for `@awthaq/react`'s own
// package to build, and the `{csrf: false}` contract variant, which has
// nothing to strip yet since no plugin group in this repository declares
// `CsrfProtection` middleware today). PasskeyClient.ts/PasskeyClientError.ts
// (BPAS-002, wayfinder ticket 32): the browser-side WebAuthn ceremony
// helper over `@simplewebauthn/browser`, layered on an already-built
// `PasskeyApi` client slice the same way `AuthClient.ts`'s own
// `SessionStore`/`toPromiseFacade` layer on a caller-supplied client.
// See spec/overview.md for the full package map.

export * as AuthClient from "./AuthClient.ts";
export * as PasskeyClient from "./passkey/PasskeyClient.ts";
export * as PasskeyClientError from "./passkey/PasskeyClientError.ts";
