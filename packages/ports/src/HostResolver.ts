// @awthaq/ports — HostResolver
//
// CWM-004 (@awthaq/webhooks) and SFS-003: the resolution half of the outbound-URL defence.
// `OutboundUrl.problem` refuses what a URL *says*; a name that says nothing suspicious can still
// resolve to `169.254.169.254` or `10.0.0.5`. A plugin that calls an administrator-supplied URL
// requires this port and checks the answer before it connects (`refusal`), so an internal address
// hidden behind a public-looking name is refused at call time, not only at registration.
//
// `refusal` alone narrows DNS rebinding (a name that flips between the check and the connect) but cannot
// close it, because an HTTP client resolves the name again on its own. `pin` closes it: it resolves once and
// hands back the address to connect to, so a transport that connects to that address (keeping the original
// Host/SNI) never asks DNS again. Egress filtering at the network layer stays the deployer's control; this
// port is defence in depth. An application provides one implementation:
// `layerNode` (the platform resolver), `layerStatic` (tests, fixed tables), or its own.

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as OutboundUrl from "./OutboundUrl.ts";

/** The name did not resolve (NXDOMAIN, timeout, no records). Treated as a refusal, never as "assume public". */
export class HostResolutionFailed extends Data.TaggedError("HostResolutionFailed")<{
  readonly hostname: string;
  readonly reason: string;
}> {}

export interface HostResolverShape {
  /** Every address (v4 and v6) the name resolves to. */
  readonly resolve: (
    hostname: string,
  ) => Effect.Effect<ReadonlyArray<string>, HostResolutionFailed>;
}

export class HostResolver extends Context.Service<HostResolver, HostResolverShape>()(
  "awthaq/ports/HostResolver",
) {}

/** The platform resolver (`node:dns/promises`, loaded lazily so this module stays bundler-neutral). */
export const layerNode = Layer.succeed(
  HostResolver,
  HostResolver.of({
    resolve: (hostname) =>
      Effect.tryPromise({
        try: async () => {
          const dns = await import("node:dns/promises");
          const records = await dns.lookup(hostname, { all: true, verbatim: true });
          return records.map((record) => record.address);
        },
        catch: (cause) =>
          new HostResolutionFailed({
            hostname,
            reason: cause instanceof Error ? cause.message : "lookup failed",
          }),
      }),
  }),
);

/** A fixed table, for tests and air-gapped deployments; an unlisted name fails to resolve. */
export const layerStatic = (table: Readonly<Record<string, ReadonlyArray<string>>>) =>
  Layer.succeed(
    HostResolver,
    HostResolver.of({
      resolve: (hostname) => {
        const addresses = table[hostname.toLowerCase()];
        return addresses === undefined
          ? Effect.fail(new HostResolutionFailed({ hostname, reason: "not in the static table" }))
          : Effect.succeed(addresses);
      },
    }),
  );

/** The one address a connection is pinned to: judged public, resolved once, and never looked up again. */
export interface PinnedTarget {
  /** The URL's own host name: still what the `Host` header and the TLS server name (SNI) say. */
  readonly hostname: string;
  /** The checked address to connect to (an IPv6 address without brackets). */
  readonly address: string;
  readonly family: 4 | 6;
}

const familyOf = (address: string): 4 | 6 => (address.includes(":") ? 6 : 4);

/**
 * Resolves `url`'s host ONCE and returns the address to connect to, or the reason the target is refused. An IP
 * literal is judged as written (no lookup); a name must resolve, and *every* address it resolves to must be a
 * globally routable unicast one (one private answer among several is a refusal). The first answer is pinned.
 *
 * This is what closes DNS rebinding (BEH-EA-312): a caller connects to `address` with the original `hostname`
 * as Host and SNI, so the name is never resolved again between this check and the connect. Call it on EVERY
 * attempt (a stored URL's answer can change), and let the connecting side re-judge the address it is handed
 * (`OutboundUrl.isPublicAddress`) so a caller that forgets the check still cannot reach a private one.
 */
export const pin = (url: string) =>
  Effect.gen(function* () {
    const parsed = URL.parse(url);
    if (parsed === null) return Result.fail("not an absolute URL");
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (OutboundUrl.isIpLiteral(host)) {
      return OutboundUrl.isPublicAddress(host)
        ? Result.succeed<PinnedTarget>({ hostname: host, address: host, family: familyOf(host) })
        : Result.fail("points at a private or loopback address");
    }
    const resolver = yield* HostResolver;
    const addresses = yield* resolver.resolve(host).pipe(Effect.option);
    const first = Option.isSome(addresses) ? addresses.value[0] : undefined;
    if (Option.isNone(addresses) || first === undefined) {
      return Result.fail("host does not resolve");
    }
    if (!addresses.value.every(OutboundUrl.isPublicAddress)) {
      return Result.fail("resolves to a private or loopback address");
    }
    return Result.succeed<PinnedTarget>({
      hostname: host,
      address: first,
      family: familyOf(first),
    });
  });

/**
 * `Some(reason)` when `url`'s host is, or resolves to, anything but a globally routable unicast
 * address (see `pin`, of which this is the refusal half).
 */
export const refusal = (url: string) =>
  pin(url).pipe(
    Effect.map((outcome) =>
      Result.isFailure(outcome) ? Option.some(outcome.failure) : Option.none<string>(),
    ),
  );
