// @awthaq/web/cookies — the edge-safe cookie subpath
//
// BO-004. Cookie-header scanning, `Set-Cookie` parsing and the jar bridge,
// with no import of `@awthaq/core`/`@awthaq/server`/`@awthaq/client` — an
// adapter's `proxy.ts`/`middleware.ts` bundle can take these without a SQL
// driver in the graph. `@awthaq/next/edge` imports from here.
export { findCookieValue, hasCookie } from "./CookieHeader.ts";
export type { HeadersLike } from "./CookieHeader.ts";
export { applyResponseCookies, parseSetCookie, setCookie } from "./CookieJar.ts";
export type { CookieJarLike, CookieSetOptions, CookieWriteOptions } from "./CookieJar.ts";
