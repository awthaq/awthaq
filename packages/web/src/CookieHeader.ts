// @awthaq/web — CookieHeader
//
// The one place a raw `Cookie` request header — `"a=1; b=2"` — gets scanned
// for a single name's value, shared by `Session.ts` (which also
// percent-decodes the result), `HasSessionCookie.ts` (which only cares
// whether a match exists at all) and an adapter's edge tier. Edge-safe: no
// import at all (`@awthaq/web/cookies`).

/**
 * BO-004: the minimal shape every framework's request headers already
 * satisfy — Next's `ReadonlyHeaders`, a Route Handler's/Astro's/SvelteKit's
 * Web `Headers`. No adapter's own module is imported to describe it.
 */
export interface HeadersLike {
  readonly get: (name: string) => string | null;
}

/**
 * The still percent-encoded value of one cookie in a `Cookie` header, or
 * `undefined` for a missing header or an absent name. Never throws — this
 * is untrusted client input.
 */
export const findCookieValue = (cookieHeader: string | null, name: string): string | undefined =>
  parseCookieHeader(cookieHeader).find((pair) => pair.name === name)?.value;

/**
 * The `name=value` pairs of a `Cookie` request header, in order, values still percent-encoded. A part
 * without `=` or with an empty name is skipped. Never throws.
 */
export const parseCookieHeader = (
  cookieHeader: string | null | undefined,
): ReadonlyArray<{ readonly name: string; readonly value: string }> => {
  const pairs: Array<{ readonly name: string; readonly value: string }> = [];
  for (const part of (cookieHeader ?? "").split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator > 0) {
      pairs.push({ name: trimmed.slice(0, separator), value: trimmed.slice(separator + 1) });
    }
  }
  return pairs;
};

/** Presence only — does a cookie named `name` appear at all? */
export const hasCookie = (cookieHeader: string | null, name: string): boolean =>
  findCookieValue(cookieHeader, name) !== undefined;
