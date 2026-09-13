// @awthaq/next — CookieHeader (internal)
//
// The one place a raw `Cookie` request header — `"a=1; b=2"` — gets scanned
// for a single name's value, shared by `GetSession.ts` (which also
// percent-decodes the result) and `HasSessionCookie.ts` (which only cares
// whether a match exists at all). Not exported from `index.ts`.

/**
 * The still percent-encoded value of one cookie in a `Cookie` header, or
 * `undefined` for a missing header or an absent name. Never throws — this
 * is untrusted client input.
 */
export const findCookieValue = (cookieHeader: string | null, name: string): string | undefined => {
  if (cookieHeader === null) return undefined;
  const prefix = `${name}=`;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return undefined;
};

/** Presence only — does a cookie named `name` appear at all? */
export const hasCookie = (cookieHeader: string | null, name: string): boolean =>
  findCookieValue(cookieHeader, name) !== undefined;
