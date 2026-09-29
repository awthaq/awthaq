// @awthaq/next — WithNextCookies
//
// spec/behaviors/24-nextjs-ssr.md, BEH-EA-189.
//
// BO-004: the `Set-Cookie` -> jar bridge is framework-neutral and lives in
// `@awthaq/web` (`CookieJar.ts`, where the contract is documented); Next's
// `cookies()` (`ResponseCookies`) satisfies its `CookieJarLike` as is. This
// module is the Next-named entry point.
import { applyResponseCookies } from "@awthaq/web";

export type { CookieJarLike, CookieSetOptions } from "@awthaq/web";

/**
 * BEH-EA-189: writes every `Set-Cookie` header on `response` into Next's
 * cookie jar — `withNextCookies(response, await cookies())`.
 */
export const withNextCookies = applyResponseCookies;
