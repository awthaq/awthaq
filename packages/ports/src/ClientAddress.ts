// @awthaq/ports — ClientAddress
//
// .scratch/resolve-ready-for-human-findings/issues/23-trusted-proxy-rate-limiting.md
// (AGA-001/NHS-003). `HttpServerRequest.remoteAddress` is always the raw
// socket peer — Effect's platform layer does no forwarded-header parsing
// itself (confirmed against `../effect/packages/platform`'s Node/Deno/Bun
// implementations), so any trusted-proxy story has to be effect-auth's
// own. This is a stratum-2 port alongside `RateLimiter`/`Crypto`/
// `PasswordHasher` (ADR-EA-010): "which proxy hops do I trust" is
// deployment topology, not something a plugin like `@awthaq/oauth` or
// `@awthaq/password` can know, so it is a capability the *application*
// provides, never a plugin-bundled feature.
//
// Two shipped layers:
//
// - `layerDirect` (the default `TestAuth.layer`/zero-config apps get):
//   `resolve = (request) => Effect.succeed(request.remoteAddress)` —
//   byte-for-byte today's behavior. No app that doesn't opt in changes
//   behavior.
// - `layerTrustedProxy(config)` — opt-in, the actual fix: parses the
//   configured header (`X-Forwarded-For` by default, or `Forwarded`),
//   walks it right-to-left past the operator's own trusted proxy hops
//   (either a fixed `hopCount` or a `trustedCidrs` allowlist — both ship
//   since some operators know a fixed hop depth and others know their
//   load balancer's egress CIDR range, and both are cheap off the same
//   right-to-left walk), and returns the next entry inward as the real
//   client address. A header that is absent, malformed, or shorter than
//   the configured trust boundary falls back to `remoteAddress` — never
//   `None`-vs-spoofable-header ambiguity.
//
// Trust boundary: this only ever inspects header contents once the
// request has reached this process — it never re-validates that the
// immediate connecting peer (`remoteAddress`) is itself one of the
// operator's own proxies. That is the same trust an operator already
// grants by choosing to run `layerTrustedProxy` at all (mirroring, e.g.,
// Express's own `trust proxy` setting): a deployment that lets
// unfiltered internet traffic reach this process directly while running
// `layerTrustedProxy` lets any direct caller spoof its own address via
// the configured header. This is a rollout/deployment-topology
// responsibility, not something this port can enforce from inside the
// request.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

export interface ClientAddressShape {
  readonly resolve: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<Option.Option<string>>;
}

export class ClientAddress extends Context.Service<ClientAddress, ClientAddressShape>()(
  "awthaq/ports/ClientAddress",
) {}

/** Byte-for-byte today's behavior — the raw socket peer, no header trusted. */
export const layerDirect: Layer.Layer<ClientAddress> = Layer.succeed(
  ClientAddress,
  ClientAddress.of({ resolve: (request) => Effect.succeed(request.remoteAddress) }),
);

export type TrustedProxyStrategy =
  /** A fixed number of rightmost hops are the operator's own proxies. */
  | { readonly _tag: "hopCount"; readonly count: number }
  /** Walk right-to-left while each hop's address is itself inside one of these CIDR ranges (IPv4 or IPv6). */
  | { readonly _tag: "cidr"; readonly trusted: ReadonlyArray<string> };

export interface TrustedProxyConfig {
  readonly strategy: TrustedProxyStrategy;
  /** Which forwarded-header dialect to parse. Default `"x-forwarded-for"`. */
  readonly header?: "x-forwarded-for" | "forwarded";
}

const splitXForwardedFor = (value: string): ReadonlyArray<string> =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

/**
 * RFC 7239's `Forwarded` header: comma-separated hops, each a
 * semicolon-separated `key=value` list. Only the `for` parameter matters
 * here; its value may be quoted, and a bracketed IPv6 literal may carry a
 * `:port` suffix (`for="[2001:db8::1]:4711"`) that must be stripped
 * without mistaking an unbracketed IPv6 address's own colons for one.
 */
const parseForwardedHop = (segment: string): string | undefined => {
  const param = segment
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.toLowerCase().startsWith("for="));
  if (param === undefined) return undefined;
  let value = param.slice("for=".length).trim();
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? undefined : value.slice(1, end);
  }
  // A single colon is an IPv4-with-port (`192.0.2.1:4711`); zero or many
  // colons means a bare address (IPv4, or an unbracketed IPv6 literal the
  // spec technically disallows without brackets — passed through as-is
  // rather than guessing where the port would start).
  const colonCount = value.split(":").length - 1;
  return colonCount === 1 ? (value.split(":")[0] ?? value) : value;
};

const splitForwarded = (value: string): ReadonlyArray<string> =>
  value
    .split(",")
    .map(parseForwardedHop)
    .filter((hop): hop is string => hop !== undefined);

const ipv4ToInt = (ip: string): number | undefined => {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let result = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
    result = (result << 8) | n;
  }
  return result >>> 0;
};

// IPv6 addresses are compared as eight 16-bit groups rather than as one
// 128-bit BigInt: the lint config forbids BigInt literals, and a per-group
// prefix comparison needs no wide integer at all.
const ipv6ToGroups = (ip: string): ReadonlyArray<number> | undefined => {
  const doubleColonCount = ip.split("::").length - 1;
  if (doubleColonCount > 1) return undefined;
  const [head, tail] = ip.includes("::") ? ip.split("::") : [ip, undefined];
  const headParts = head.length > 0 ? head.split(":") : [];
  const tailParts = tail !== undefined && tail.length > 0 ? tail.split(":") : [];
  if (tail === undefined && headParts.length !== 8) return undefined;
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0) return undefined;
  const groups = [
    ...headParts,
    ...Array<string>(tail !== undefined ? missing : 0).fill("0"),
    ...tailParts,
  ];
  if (groups.length !== 8) return undefined;
  const values: Array<number> = [];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
    values.push(Number.parseInt(group, 16));
  }
  return values;
};

/** True when the first `prefix` bits of both group lists agree. */
const groupsShareMask = (
  address: ReadonlyArray<number>,
  network: ReadonlyArray<number>,
  prefix: number,
): boolean => {
  for (let index = 0; index < address.length; index++) {
    const bits = Math.min(16, Math.max(0, prefix - index * 16));
    if (bits === 0) return true;
    const mask = (0xffff << (16 - bits)) & 0xffff;
    if (((address[index] ?? 0) & mask) !== ((network[index] ?? 0) & mask)) return false;
  }
  return true;
};

const isInCidr = (address: string, cidr: string): boolean => {
  const separator = cidr.indexOf("/");
  if (separator === -1) return false;
  const network = cidr.slice(0, separator);
  const prefix = Number(cidr.slice(separator + 1));
  if (!Number.isInteger(prefix)) return false;
  if (address.includes(":") || network.includes(":")) {
    const addressGroups = ipv6ToGroups(address);
    const networkGroups = ipv6ToGroups(network);
    if (addressGroups === undefined || networkGroups === undefined || prefix < 0 || prefix > 128) {
      return false;
    }
    return groupsShareMask(addressGroups, networkGroups, prefix);
  }
  const addressBits = ipv4ToInt(address);
  const networkBits = ipv4ToInt(network);
  if (addressBits === undefined || networkBits === undefined || prefix < 0 || prefix > 32) {
    return false;
  }
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (addressBits & mask) >>> 0 === (networkBits & mask) >>> 0;
};

const resolveFromHops = (
  hops: ReadonlyArray<string>,
  strategy: TrustedProxyStrategy,
): Option.Option<string> => {
  if (hops.length === 0) return Option.none();
  if (strategy._tag === "hopCount") {
    const index = hops.length - 1 - strategy.count;
    return index >= 0 ? Option.some(hops[index]!) : Option.none();
  }
  for (let index = hops.length - 1; index >= 0; index--) {
    const hop = hops[index]!;
    if (!strategy.trusted.some((cidr) => isInCidr(hop, cidr))) {
      return Option.some(hop);
    }
  }
  // Every hop (including the client's own claimed address) fell inside
  // the trusted range — nothing left to treat as "the client". Falling
  // back to `remoteAddress` (the caller does this) is safer than picking
  // an arbitrary trusted-proxy address.
  return Option.none();
};

/** Opt-in: derives the client address from a configured forwarded header, past the operator's own trusted proxy hops. */
export const layerTrustedProxy = (config: TrustedProxyConfig): Layer.Layer<ClientAddress> =>
  Layer.succeed(
    ClientAddress,
    ClientAddress.of({
      resolve: (request) =>
        Effect.sync(() => {
          const header = config.header ?? "x-forwarded-for";
          const raw = request.headers[header];
          if (raw === undefined) return request.remoteAddress;
          const hops = header === "forwarded" ? splitForwarded(raw) : splitXForwardedFor(raw);
          const resolved = resolveFromHops(hops, config.strategy);
          return Option.isSome(resolved) ? resolved : request.remoteAddress;
        }),
    }),
  );
