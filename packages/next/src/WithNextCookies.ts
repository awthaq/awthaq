// @effect-auth/next — WithNextCookies
//
// spec/behaviors/24-nextjs-ssr.md, BEH-EA-189.
//
// Bridges a `Set-Cookie` produced by effect-auth's own composed HTTP router
// (a sign-in, a CSRF rotation — anything reached through
// `HttpApiBuilder.securitySetCookie`) into Next's `next/headers` cookie
// jar, for use inside a server action, which never sees the raw HTTP
// response object an ordinary Effect HTTP handler would write that header
// onto.
//
// A pure `Response -> jar` bridge, not a request dispatcher: the caller
// produces the `Response` however it already does (typically by dispatching
// a `Request` against its own composed router via
// `HttpRouter.toWebHandler`/the ambient-`HttpRouter` pattern this
// repository's other wire-level tests already use — see
// `packages/qadi/test/SubjectApi.test.ts`), and `withNextCookies` only
// harvests whatever `Set-Cookie` header(s) that response already carries.
//
// Scoped deliberately to HTTP-layer effects: `HttpApiBuilder.securitySetCookie`
// is the only thing that sets a cookie anywhere in this codebase today — a
// plain domain-service call (`Users.rename`, `Sessions.issue` called
// directly rather than through a handler) never produces a `Set-Cookie` at
// all, so wrapping one here writes nothing into the jar. (The archive design
// cookbook's illustrative `withNextCookies(Users.use(...))` snippet is
// treated as loose, superseded shorthand for "some mutations need cookie
// bridging" — not a literal contract this module tries to satisfy for
// arbitrary domain calls.)
//
// `CookieJarLike` is a minimal structural subset of `next/headers`'
// `cookies()` return value (`ResponseCookies`) — this module never imports
// from `"next/headers"` itself, so it stays testable with a plain fake.

export interface CookieSetOptions {
  readonly maxAge?: number;
  readonly path?: string;
  readonly domain?: string;
  readonly expires?: Date;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  readonly sameSite?: "lax" | "strict" | "none";
}

export interface CookieJarLike {
  readonly set: (name: string, value: string, options?: CookieSetOptions) => unknown;
}

type MutableCookieSetOptions = { -readonly [K in keyof CookieSetOptions]?: CookieSetOptions[K] };

const isSameSite = (value: string): value is "lax" | "strict" | "none" =>
  value === "lax" || value === "strict" || value === "none";

/**
 * Parses one raw `Set-Cookie` header value (RFC 6265's
 * `name=value; Attr=Value; Flag` shape) into the name/value pair and a
 * `CookieSetOptions` a jar's `set` already understands. Unknown attributes
 * are ignored rather than rejected — a cookie carrying an attribute this
 * bridge doesn't translate should still have its name/value/known
 * attributes written, not be dropped entirely.
 */
const parseSetCookie = (
  header: string,
): { readonly name: string; readonly value: string; readonly options: CookieSetOptions } => {
  const segments = header.split(";").map((segment) => segment.trim());
  const [pair, ...attributes] = segments;
  const separator = (pair ?? "").indexOf("=");
  const name = separator === -1 ? (pair ?? "") : (pair ?? "").slice(0, separator);
  const rawValue = separator === -1 ? "" : (pair ?? "").slice(separator + 1);
  const value = (() => {
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  })();

  const options: MutableCookieSetOptions = {};
  for (const attribute of attributes) {
    const eq = attribute.indexOf("=");
    const key = (eq === -1 ? attribute : attribute.slice(0, eq)).toLowerCase();
    const raw = eq === -1 ? undefined : attribute.slice(eq + 1);
    if (key === "max-age" && raw !== undefined) {
      options.maxAge = Number(raw);
    } else if (key === "path" && raw !== undefined) {
      options.path = raw;
    } else if (key === "domain" && raw !== undefined) {
      options.domain = raw;
    } else if (key === "expires" && raw !== undefined) {
      options.expires = new Date(raw);
    } else if (key === "secure") {
      options.secure = true;
    } else if (key === "httponly") {
      options.httpOnly = true;
    } else if (key === "samesite" && raw !== undefined) {
      const lower = raw.toLowerCase();
      if (isSameSite(lower)) {
        options.sameSite = lower;
      }
    }
  }
  return { name, value, options };
};

/**
 * BEH-EA-189: writes every `Set-Cookie` header on `response` into `jar` —
 * the same header the browser would have received over a real network
 * call, now landing in Next's cookie jar instead. A response with no
 * `Set-Cookie` header writes nothing.
 */
export const withNextCookies = (response: Response, jar: CookieJarLike): void => {
  for (const header of response.headers.getSetCookie()) {
    const { name, value, options } = parseSetCookie(header);
    jar.set(name, value, options);
  }
};
