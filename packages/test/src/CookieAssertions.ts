// @awthaq/test — CookieAssertions
//
// CSS-004: wire-level tests used to assert cookie *names* and throw the
// attributes away (`split(";")[0]`), which is exactly how the CSS-001 class
// of bug (a `__Host-` cookie with a narrowed `Path`) stayed invisible. These
// helpers parse a raw `Set-Cookie` header and assert its attributes, so every
// package's wire suite can pin them the same way. They throw a plain `Error`
// on a violation (no test-runner import), so they work under any runner.

export interface ParsedSetCookie {
  readonly name: string;
  readonly value: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  /** Lower-cased (`"lax"`, `"strict"`, `"none"`), when present. */
  readonly sameSite: string | undefined;
  readonly path: string | undefined;
  readonly domain: string | undefined;
  /** Seconds, when a `Max-Age` attribute is present. */
  readonly maxAge: number | undefined;
}

/** Parses one raw `Set-Cookie` header value into its name, value and attributes. */
export const parseSetCookie = (raw: string): ParsedSetCookie => {
  const [pair = "", ...attributes] = raw.split(";").map((part) => part.trim());
  const separator = pair.indexOf("=");
  const attribute = (key: string): string | undefined => {
    const match = attributes.find((part) => part.toLowerCase().split("=")[0] === key);
    return match === undefined ? undefined : match.slice(key.length + 1);
  };
  const flag = (key: string): boolean => attributes.some((part) => part.toLowerCase() === key);
  const maxAge = attribute("max-age");
  return {
    name: separator === -1 ? pair : pair.slice(0, separator),
    value: separator === -1 ? "" : pair.slice(separator + 1),
    secure: flag("secure"),
    httpOnly: flag("httponly"),
    sameSite: attribute("samesite")?.toLowerCase(),
    path: attribute("path"),
    domain: attribute("domain"),
    maxAge: maxAge === undefined ? undefined : Number(maxAge),
  };
};

/** Every `Set-Cookie` header of a web `Response`, parsed (a response may set several cookies). */
export const setCookiesOf = (response: Response): ReadonlyArray<ParsedSetCookie> =>
  response.headers.getSetCookie().map(parseSetCookie);

/** The one cookie named `name` among a response's `Set-Cookie` headers; throws if absent. */
export const findSetCookie = (response: Response, name: string): ParsedSetCookie => {
  const found = setCookiesOf(response).find((cookie) => cookie.name === name);
  if (found === undefined) {
    const names = setCookiesOf(response).map((cookie) => cookie.name);
    throw new Error(`expected a Set-Cookie for "${name}", got [${names.join(", ")}]`);
  }
  return found;
};

/**
 * Asserts a cookie satisfies the `__Host-` prefix rules (`Secure`, `Path=/`,
 * no `Domain`) plus the requested `HttpOnly` and `SameSite` values. A
 * violation of any of these makes a conforming browser silently drop the
 * cookie, which is why they are checked on the wire and not assumed.
 */
export const assertHostPrefixedCookie = (
  cookie: ParsedSetCookie,
  expected: { readonly httpOnly: boolean; readonly sameSite: "lax" | "strict" | "none" },
): void => {
  const problems: Array<string> = [];
  if (!cookie.name.startsWith("__Host-")) problems.push(`name "${cookie.name}" lacks __Host-`);
  if (!cookie.secure) problems.push("missing Secure");
  if (cookie.path !== "/") problems.push(`Path is ${cookie.path ?? "absent"}, must be /`);
  if (cookie.domain !== undefined) problems.push(`Domain=${cookie.domain} must be absent`);
  if (cookie.httpOnly !== expected.httpOnly) {
    problems.push(`HttpOnly is ${cookie.httpOnly}, expected ${expected.httpOnly}`);
  }
  if (cookie.sameSite !== expected.sameSite) {
    problems.push(`SameSite is ${cookie.sameSite ?? "absent"}, expected ${expected.sameSite}`);
  }
  if (problems.length > 0) {
    throw new Error(`cookie "${cookie.name}" violates its attributes: ${problems.join("; ")}`);
  }
};

/** Asserts a cookie is an expiry directive (`Max-Age=0`), as sent to clear it. */
export const assertExpiredCookie = (cookie: ParsedSetCookie): void => {
  if (cookie.maxAge !== 0) {
    throw new Error(`cookie "${cookie.name}" should expire (Max-Age=0), got ${cookie.maxAge}`);
  }
};
