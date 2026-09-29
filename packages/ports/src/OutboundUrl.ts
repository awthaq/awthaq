// @awthaq/ports — OutboundUrl
//
// CWM-004 (@awthaq/webhooks) and SFS-003: the SSRF floor for a URL an *administrator or tenant
// supplies* and this server will then call — a webhook endpoint, a SAML metadata URL. It is the
// syntactic half of the defence: only absolute `https:` URLs without credentials, and no
// `localhost`, `.local`/`.internal` name or private/loopback/link-local/reserved IP literal. It
// generalises the floor `@awthaq/organization`'s connections apply to OAuth endpoints (EP-004),
// with two corrections that check needs at scale: IPv6 is parsed (an IPv4-mapped `::ffff:7f00:1`
// is loopback, not "public"), and the IPv6 prefix tests apply to IPv6 *literals* only — a hostname
// such as `fcm.example.com` is not a unique-local address.
//
// The URL parser has already canonicalised decimal/hex/octal IPv4 forms (`http://2130706433/`
// arrives as `127.0.0.1`), so the literal checks see one spelling. What no syntactic check can see
// is a *name* that resolves to a private address, or resolves to a public one now and a private
// one at connect time (DNS rebinding): `HostResolver.refusal` adds the resolution check, and egress
// filtering at the network layer remains the deployer's responsibility.

import * as Option from "effect/Option";

const PRIVATE_HOSTNAME = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

const ipv4Octets = (host: string): ReadonlyArray<number> | undefined => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (match === null) return undefined;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : undefined;
};

const isPublicIpv4Octets = (octets: ReadonlyArray<number>): boolean => {
  const [a = 0, b = 0, c = 0] = octets;
  return !(
    a === 0 || // "this network"
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a === 127 ||
    (a === 169 && b === 254) || // link-local, including the cloud metadata address
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, TEST-NET-1
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
};

/** Expands an IPv6 literal (no brackets, no zone) to eight 16-bit groups, or `undefined` when it is not one. */
const ipv6Groups = (host: string): ReadonlyArray<number> | undefined => {
  if (!host.includes(":")) return undefined;
  const halves = host.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string): ReadonlyArray<number> | undefined => {
    if (part === "") return [];
    const groups: Array<number> = [];
    for (const piece of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(piece)) return undefined;
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };
  const head = parse(halves[0] ?? "");
  const tail = parse(halves[1] ?? "");
  if (head === undefined || tail === undefined) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return undefined;
  return [...head, ...Array.from({ length: missing }, () => 0), ...tail];
};

const isPublicIpv6Groups = (groups: ReadonlyArray<number>): boolean => {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const embedded = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
  const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (zeroPrefix && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return false; // :: and ::1
  if (zeroPrefix && g5 === 0xffff) return isPublicIpv4Octets(embedded); // IPv4-mapped
  if (zeroPrefix && g5 === 0) return false; // IPv4-compatible (deprecated), never a public route
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPublicIpv4Octets(embedded); // NAT64 well-known prefix
  }
  return !(
    (g0 & 0xfe00) === 0xfc00 || // unique-local fc00::/7
    (g0 & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (g0 & 0xffc0) === 0xfec0 || // site-local (deprecated)
    (g0 & 0xff00) === 0xff00 || // multicast
    (g0 === 0x2001 && g1 === 0x0db8) || // documentation
    (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) // discard-only
  );
};

/** `true` when `address` is a syntactically valid IP literal that is a globally routable unicast address. */
export const isPublicAddress = (address: string): boolean => {
  const host = address.replace(/^\[|\]$/g, "").toLowerCase();
  const octets = ipv4Octets(host);
  if (octets !== undefined) return isPublicIpv4Octets(octets);
  const groups = ipv6Groups(host);
  return groups !== undefined && isPublicIpv6Groups(groups);
};

/** `true` when `host` is written as an IP literal (v4, or v6 with or without brackets). */
export const isIpLiteral = (host: string): boolean => {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return ipv4Octets(bare) !== undefined || ipv6Groups(bare) !== undefined;
};

export interface OutboundUrlOptions {
  /**
   * Development and test only: allow `http:` and private/loopback hosts, so a webhook can
   * point at a receiver on `localhost`. Never set in production.
   */
  readonly allowPrivate?: boolean;
}

/** `Some(reason)` when `value` is not an acceptable outbound endpoint URL. */
export const problem = (
  field: string,
  value: string,
  options?: OutboundUrlOptions,
): Option.Option<string> => {
  if (!URL.canParse(value)) return Option.some(`${field} is not an absolute URL`);
  const url = new URL(value);
  if (options?.allowPrivate === true) {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return Option.some(`${field} must be http or https`);
    }
    return url.username !== "" || url.password !== ""
      ? Option.some(`${field} must not carry credentials`)
      : Option.none();
  }
  if (url.protocol !== "https:") return Option.some(`${field} must be https`);
  if (url.username !== "" || url.password !== "") {
    return Option.some(`${field} must not carry credentials`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "") return Option.some(`${field} has no host`);
  if (PRIVATE_HOSTNAME.test(host)) {
    return Option.some(`${field} must not point at a private or loopback address`);
  }
  if (isIpLiteral(host)) {
    return isPublicAddress(host)
      ? Option.none()
      : Option.some(`${field} must not point at a private or loopback address`);
  }
  // A single-label name (`intranet`) resolves through the host's search domains, i.e. internally.
  if (!host.includes(".")) return Option.some(`${field} must be a fully qualified host name`);
  return Option.none();
};
