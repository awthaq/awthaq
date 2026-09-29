// @awthaq/webhooks — WebhookHeaders
//
// BEH-EA-304: per-endpoint custom request headers, for the receivers that want more than a signature (an
// `Authorization` token, an API key, a routing header). Their VALUES are credentials as far as this package is
// concerned: they are sealed with the `Encryption` port like the signing secret (AAD naming endpoint and field), never
// returned by the API (only the names are), and never logged. What an administrator may set is bounded here so a custom
// header can never replace what the delivery itself says (the signature headers, the content type, the framing, the
// host) or turn a request into something else (a `Transfer-Encoding`, an `Upgrade`).

import * as Option from "effect/Option";

/** Headers an attempt sets itself, or whose meaning would change the request: never settable. */
const RESERVED: ReadonlySet<string> = new Set([
  "host",
  "content-type",
  "content-length",
  "content-encoding",
  "user-agent",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "cookie",
  "set-cookie",
]);

const RESERVED_PREFIXES = ["webhook-", "proxy-", "sec-"];

export const MAX_HEADERS = 10;
export const MAX_VALUE_LENGTH = 1024;

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Printable ASCII only: no control characters (so no header injection), no obs-text. */
const VALUE = /^[\x20-\x7e]+$/;

/** The headers as stored and sent: names lower-cased. */
export type CustomHeaders = Readonly<Record<string, string>>;

/**
 * `Some(reason)` when `headers` is not an acceptable set, else `None`. Names are compared case-insensitively (HTTP field
 * names are), so two spellings of one name are a duplicate.
 */
export const problem = (headers: Readonly<Record<string, string>>): Option.Option<string> => {
  const entries = Object.entries(headers);
  if (entries.length > MAX_HEADERS) {
    return Option.some(`headers: at most ${MAX_HEADERS} custom headers`);
  }
  const seen = new Set<string>();
  for (const [rawName, value] of entries) {
    const name = rawName.toLowerCase();
    if (!NAME.test(name)) {
      return Option.some(`headers: "${rawName}" is not an acceptable header name`);
    }
    if (RESERVED.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      return Option.some(`headers: "${rawName}" is set by the delivery and cannot be customised`);
    }
    if (seen.has(name)) return Option.some(`headers: "${rawName}" is given twice`);
    seen.add(name);
    if (value.length === 0 || value.length > MAX_VALUE_LENGTH || !VALUE.test(value)) {
      return Option.some(
        `headers: the value of "${rawName}" must be 1 to ${MAX_VALUE_LENGTH} printable ASCII characters`,
      );
    }
  }
  return Option.none();
};

/** The names, lower-cased and sorted: what the API reveals about a set. */
export const namesOf = (headers: Readonly<Record<string, string>>): ReadonlyArray<string> =>
  Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();

/** Lower-cases the names (the form that is sealed and sent). */
export const normalize = (headers: Readonly<Record<string, string>>): CustomHeaders =>
  Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
