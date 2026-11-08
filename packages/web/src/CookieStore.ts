// @awthaq/web — CookieStore
//
// spec/behaviors/24-nextjs-ssr.md, BEH-EA-344. The cookie state of one user agent, as an RFC 6265bis
// §5.3–§5.4 subset: `receive` takes a `Set-Cookie` answered for a request URL, `header` answers the
// `Cookie` header of the next request. One parser (`CookieJar.parseSetCookie`) and one store for the
// server-action client, the test harness, the BDD worlds and the React world.
//
// Two policies:
// - `browser` applies a conforming browser's acceptance and sending rules: the `__Host-`/`__Secure-`
//   prefix rules, no `Secure` cookie from an insecure origin, no `SameSite=None` without `Secure`, a
//   `Domain` must domain-match the host; `Secure`, `Domain` and `SameSite` decide what is sent.
// - `trusted` is a server action calling its own application (`InProcessClient` addresses
//   `http://internal`, which is neither a secure origin nor any cookie's `Domain`): every cookie is kept
//   and `Domain`, `Secure` and `SameSite` are not enforced.
// Expiry (`Max-Age` over `Expires`) and `Path` are honoured under both.
//
// Not modelled (non-goals): partition keys (`Partitioned` is recorded, the agent has one top-level
// site) and public-suffix checks. Edge-safe (`@awthaq/web/cookies`): imports only `CookieJar.ts` and
// `CookieHeader.ts`, which import nothing.
import { parseCookieHeader } from "./CookieHeader.ts";
import { parseSetCookie } from "./CookieJar.ts";

export type SameSite = "strict" | "lax" | "none";

export interface StoredCookie {
  readonly name: string;
  /** Still percent-encoded: the bytes a browser sends back. */
  readonly value: string;
  readonly domain: string;
  /** No `Domain` attribute: sent to exactly the host that set it. */
  readonly hostOnly: boolean;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  /** An absent attribute reads as `lax` (RFC 6265bis §5.4.7). */
  readonly sameSite: SameSite;
  /** Recorded, not keyed: an in-process agent has one top-level site. */
  readonly partitioned: boolean;
  /** Epoch ms; `undefined` is a session cookie. */
  readonly expiresAt: number | undefined;
  readonly createdAt: number;
}

/**
 * `browser`: a conforming browser's acceptance and sending rules (tests).
 * `trusted`: the handler is the application itself (a server action): every cookie is kept and sent on
 * every matching path; `Domain`, `Secure` and `SameSite` are not enforced. Expiry and `Path` are honoured
 * in both.
 */
export type Policy = "browser" | "trusted";

export type Refusal =
  /** `__Host-` without `Secure`, with a `Domain`, or with a `Path` other than `/`. */
  | "HostPrefix"
  /** `__Secure-` without `Secure`. */
  | "SecurePrefix"
  /** A `Secure` cookie from a non-secure origin. */
  | "InsecureOrigin"
  /** The `Domain` does not domain-match the request host. */
  | "DomainMismatch"
  | "SameSiteNoneWithoutSecure";

export type Received =
  | { readonly _tag: "Stored"; readonly cookie: StoredCookie }
  | { readonly _tag: "Removed"; readonly name: string }
  | {
      readonly _tag: "Refused";
      readonly name: string;
      readonly refusal: Refusal;
      readonly header: string;
    };

/** Where a request comes from, relative to its target (`Sec-Fetch-Site`). */
export type Site = "same-origin" | "same-site" | "cross-site";

/** What a request is, as far as cookie sending cares (§5.4). */
export interface Outgoing {
  readonly url: URL;
  readonly method: string;
  readonly site: Site;
  /** A top-level navigation: a `Lax` cookie travels on a cross-site GET only then. */
  readonly navigation: boolean;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `https:`, or a loopback host (browsers treat `http://localhost` as a secure context). */
export const isSecureOrigin = (url: URL): boolean =>
  url.protocol === "https:" || LOOPBACK.has(url.hostname);

const isIpLiteral = (host: string): boolean =>
  host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);

/** §5.1.4: the directory of the request path (`/x/y` -> `/x`), `/` for a top-level path. */
const defaultPath = (url: URL): string => {
  const path = url.pathname;
  if (!path.startsWith("/")) return "/";
  const last = path.lastIndexOf("/");
  return last <= 0 ? "/" : path.slice(0, last);
};

/** §5.1.4 path-match. */
const pathMatches = (requestPath: string, cookiePath: string): boolean =>
  requestPath === cookiePath ||
  (requestPath.startsWith(cookiePath) &&
    (cookiePath.endsWith("/") || requestPath.charAt(cookiePath.length) === "/"));

/** §5.1.3 domain-match: a host-only cookie only to its host; otherwise the domain or a subdomain of it. */
const domainMatches = (host: string, domain: string, hostOnly: boolean): boolean =>
  host === domain || (!hostOnly && !isIpLiteral(host) && host.endsWith(`.${domain}`));

/** Why a conforming browser would drop `cookie`, received for `url`; `undefined` when it would store it. */
const refusalOf = (cookie: StoredCookie, hadDomain: boolean, url: URL): Refusal | undefined => {
  if (cookie.secure && !isSecureOrigin(url)) return "InsecureOrigin";
  if (cookie.name.startsWith("__Secure-") && !cookie.secure) return "SecurePrefix";
  if (cookie.name.startsWith("__Host-") && (!cookie.secure || hadDomain || cookie.path !== "/")) {
    return "HostPrefix";
  }
  if (cookie.sameSite === "none" && !cookie.secure) return "SameSiteNoneWithoutSecure";
  if (!cookie.hostOnly && !domainMatches(url.hostname.toLowerCase(), cookie.domain, false)) {
    return "DomainMismatch";
  }
  return undefined;
};

const keyOf = (cookie: Pick<StoredCookie, "domain" | "path" | "name">): string =>
  `${cookie.domain};${cookie.path};${cookie.name}`;

const isLive = (cookie: StoredCookie, now: number): boolean =>
  cookie.expiresAt === undefined || cookie.expiresAt > now;

/** §5.4 step 2: longer paths first, then earlier creation (the sort is stable: insertion order last). */
const bySpecificity = (a: StoredCookie, b: StoredCookie): number =>
  b.path.length - a.path.length || a.createdAt - b.createdAt;

export const makeCookieStore = (options: {
  readonly policy: Policy;
  readonly now: () => number;
}) => {
  const cookies = new Map<string, StoredCookie>();

  /** §5.3: store (or remove, or refuse) one `Set-Cookie` received in answer to a request for `url`. */
  const receive = (url: URL, header: string): Received => {
    const parsed = parseSetCookie(header);
    const now = options.now();
    // §5.2.2: Max-Age wins over Expires; <= 0 expires now.
    const expiresAt =
      parsed.options.maxAge !== undefined
        ? now + parsed.options.maxAge * 1000
        : parsed.options.expires?.getTime();
    const domainAttribute = parsed.options.domain?.replace(/^\./, "").toLowerCase();
    const domain =
      domainAttribute === undefined || domainAttribute === ""
        ? url.hostname.toLowerCase()
        : domainAttribute;
    const path =
      parsed.options.path !== undefined && parsed.options.path.startsWith("/")
        ? parsed.options.path
        : defaultPath(url);
    // §5.3 step 11: an overwrite keeps the creation time of the cookie it replaces.
    const existing = cookies.get(keyOf({ name: parsed.name, domain, path }));
    const cookie: StoredCookie = {
      name: parsed.name,
      value: parsed.rawValue,
      domain,
      hostOnly: domainAttribute === undefined || domainAttribute === "",
      path,
      secure: parsed.options.secure === true,
      httpOnly: parsed.options.httpOnly === true,
      sameSite: parsed.options.sameSite ?? "lax",
      partitioned: parsed.options.partitioned === true,
      expiresAt,
      createdAt: existing?.createdAt ?? now,
    };
    if (options.policy === "browser") {
      const refusal = refusalOf(cookie, !cookie.hostOnly, url);
      if (refusal !== undefined) return { _tag: "Refused", name: cookie.name, refusal, header };
    }
    if (!isLive(cookie, now)) {
      cookies.delete(keyOf(cookie));
      return { _tag: "Removed", name: cookie.name };
    }
    cookies.set(keyOf(cookie), cookie);
    return { _tag: "Stored", cookie };
  };

  const sendable = (request: Outgoing, now: number) => (cookie: StoredCookie) => {
    if (!isLive(cookie, now)) return false;
    if (!pathMatches(request.url.pathname, cookie.path)) return false;
    if (options.policy === "trusted") return true;
    if (!domainMatches(request.url.hostname.toLowerCase(), cookie.domain, cookie.hostOnly)) {
      return false;
    }
    if (cookie.secure && !isSecureOrigin(request.url)) return false;
    if (request.site !== "cross-site") return true;
    return (
      cookie.sameSite === "none" ||
      (cookie.sameSite === "lax" && request.navigation && request.method.toUpperCase() === "GET")
    );
  };

  /** §5.4: the cookies a request carries, most specific first. */
  const matching = (request: Outgoing): ReadonlyArray<StoredCookie> =>
    [...cookies.values()].filter(sendable(request, options.now())).sort(bySpecificity);

  /** §5.4: the `Cookie` header for `request`, or `undefined` when nothing matches. */
  const header = (request: Outgoing): string | undefined => {
    const found = matching(request);
    return found.length === 0
      ? undefined
      : found.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  };

  /**
   * A server action's incoming `Cookie` header: one host-only `Path=/` cookie per pair, attributes unknown,
   * values kept raw (still percent-encoded) so they round-trip byte for byte.
   */
  const seed = (url: URL, cookieHeader: string): void => {
    const now = options.now();
    for (const pair of parseCookieHeader(cookieHeader)) {
      const cookie: StoredCookie = {
        name: pair.name,
        value: pair.value,
        domain: url.hostname.toLowerCase(),
        hostOnly: true,
        path: "/",
        secure: false,
        httpOnly: false,
        sameSite: "lax",
        partitioned: false,
        expiresAt: undefined,
        createdAt: now,
      };
      cookies.set(keyOf(cookie), cookie);
    }
  };

  /** `document.cookie` as a page script on `url` sees it: the matching cookies without `HttpOnly`. */
  const scriptVisible = (url: URL): string =>
    matching({ url, method: "GET", site: "same-origin", navigation: false })
      .filter((cookie) => !cookie.httpOnly)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");

  /** The most specific live cookie named `name` (longest path, then the oldest). */
  const get = (name: string): StoredCookie | undefined => {
    const now = options.now();
    return [...cookies.values()]
      .filter((cookie) => cookie.name === name && isLive(cookie, now))
      .sort(bySpecificity)[0];
  };

  /** Every live cookie. */
  const all = (): ReadonlyArray<StoredCookie> => {
    const now = options.now();
    return [...cookies.values()].filter((cookie) => isLive(cookie, now));
  };

  return { receive, header, seed, scriptVisible, get, all };
};

export type CookieStore = ReturnType<typeof makeCookieStore>;
