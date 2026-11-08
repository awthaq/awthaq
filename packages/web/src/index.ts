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
//   `x-csrf-token` and lands every `Set-Cookie` in the jar;
// - user agent: `UserAgent` (an in-process browser or native client over a
//   web handler: cookie store, CSRF echo, bearer token) and `makeCookieStore`
//   (its RFC 6265 store), which the in-process client is built on.
//
// spec/behaviors/24-nextjs-ssr.md (BEH-EA-185/188/189/190/344).

export {
  applyRotatedSession,
  getSession,
  makeGetSession,
  resolveSessionCookies,
} from "./Session.ts";
export type { ResolveSessionCookies, Session, SessionRuntime, SessionServices } from "./Session.ts";
export { hasSessionCookie } from "./HasSessionCookie.ts";
export { findCookieValue, hasCookie, parseCookieHeader } from "./CookieHeader.ts";
export type { HeadersLike } from "./CookieHeader.ts";
export { applyResponseCookies, decodeCookieValue, parseSetCookie, setCookie } from "./CookieJar.ts";
export type { CookieJarLike, CookieSetOptions, CookieWriteOptions } from "./CookieJar.ts";
export { inProcessClient, makeInProcessClient } from "./InProcessClient.ts";
export type { InProcessClientOptions } from "./InProcessClient.ts";
export { isSecureOrigin, makeCookieStore } from "./CookieStore.ts";
export type {
  CookieStore,
  Outgoing,
  Policy,
  Received,
  Refusal,
  SameSite,
  Site,
  StoredCookie,
} from "./CookieStore.ts";
export * as UserAgent from "./UserAgent.ts";
