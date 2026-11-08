// @awthaq/test — CookieAssertions
//
// CSS-004: wire-level tests used to assert cookie *names* and throw the
// attributes away (`split(";")[0]`), which is exactly how the CSS-001 class
// of bug (a `__Host-` cookie with a narrowed `Path`) stayed invisible. These
// helpers read a raw `Set-Cookie` header (with `@awthaq/web`'s parser) or a
// cookie an agent holds, and assert its attributes, so every package's wire
// suite can pin them the same way. They throw a plain `Error` on a violation
// (no test-runner import), so they work under any runner. An agent under the
// `browser` policy already refuses a non-conforming prefixed cookie; these
// remain for `SameSite`/`HttpOnly` expectations and expiry directives.
import { parseSetCookie, type StoredCookie } from "@awthaq/web/cookies";

export interface ParsedSetCookie {
  readonly name: string;
  /** Still percent-encoded, exactly as the header carried it. */
  readonly value: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  /** Lower-cased (`"lax"`, `"strict"`, `"none"`), when present. */
  readonly sameSite: string | undefined;
  readonly path: string | undefined;
  readonly domain: string | undefined;
  /** Seconds, when a numeric `Max-Age` attribute is present. */
  readonly maxAge: number | undefined;
  readonly partitioned: boolean;
}

/**
 * One raw `Set-Cookie` header value, read by `@awthaq/web`'s parser (the one `Set-Cookie` parser of the
 * repository, the one every user agent stores cookies with) and flattened for assertions.
 */
const parse = (raw: string): ParsedSetCookie => {
  const { name, rawValue, options } = parseSetCookie(raw);
  return {
    name,
    value: rawValue,
    secure: options.secure === true,
    httpOnly: options.httpOnly === true,
    sameSite: options.sameSite,
    path: options.path,
    domain: options.domain,
    maxAge: options.maxAge,
    partitioned: options.partitioned === true,
  };
};

/** A cookie an agent holds, read for the same assertions (a host-only cookie has no `Domain` attribute). */
const fromStored = (cookie: StoredCookie): ParsedSetCookie => ({
  name: cookie.name,
  value: cookie.value,
  secure: cookie.secure,
  httpOnly: cookie.httpOnly,
  sameSite: cookie.sameSite,
  path: cookie.path,
  domain: cookie.hostOnly ? undefined : cookie.domain,
  maxAge: undefined,
  partitioned: cookie.partitioned,
});

/** Every `Set-Cookie` header of a web `Response`, parsed (a response may set several cookies). */
export const setCookiesOf = (response: Response): ReadonlyArray<ParsedSetCookie> =>
  response.headers.getSetCookie().map(parse);

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
  subject: ParsedSetCookie | StoredCookie,
  expected: { readonly httpOnly: boolean; readonly sameSite: "lax" | "strict" | "none" },
): void => {
  const cookie = "hostOnly" in subject ? fromStored(subject) : subject;
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
