// @awthaq/web
//
// BO-004: the framework-neutral core of a web adapter — what `@awthaq/next`
// was made of before its Next-specific parts (`React.cache` dedup, the
// `serverActionClient` names, RSC seeds) were split off, and what an Astro or
// SvelteKit adapter reuses as is. Nothing here imports a framework.
//
// - cookie jar: `CookieJarLike` (structurally satisfied by Next's
//   `cookies()`, SvelteKit's `event.cookies`, Astro's `Astro.cookies`) and
//   `applyResponseCookies` (a `Response`'s `Set-Cookie` -> the jar);
// - session read/rotation: `getSession` (database-verified), `makeGetSession`
//   (inject a per-render dedup), `applyRotatedSession`, and the presence-only
//   `hasSessionCookie`;
// - CSRF echo: `makeInProcessClient`/`inProcessClient`, a typed in-process
//   client that forwards the caller's cookies, echoes `__Host-csrf` as
//   `x-csrf-token` and lands every `Set-Cookie` in the jar.
//
// spec/behaviors/24-nextjs-ssr.md (BEH-EA-185/188/189/190).

export { applyRotatedSession, getSession, makeGetSession, verifySessionToken } from "./Session.ts";
export type { Session, SessionRuntime, SessionServices, VerifySessionToken } from "./Session.ts";
export { hasSessionCookie } from "./HasSessionCookie.ts";
export { findCookieValue, hasCookie } from "./CookieHeader.ts";
export type { HeadersLike } from "./CookieHeader.ts";
export { applyResponseCookies, parseSetCookie, setCookie } from "./CookieJar.ts";
export type { CookieJarLike, CookieSetOptions, CookieWriteOptions } from "./CookieJar.ts";
export { inProcessClient, makeInProcessClient } from "./InProcessClient.ts";
export type { InProcessClientOptions } from "./InProcessClient.ts";
