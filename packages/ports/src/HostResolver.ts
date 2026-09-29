// @awthaq/ports — HostResolver
//
// CWM-004 (@awthaq/webhooks) and SFS-003: the resolution half of the outbound-URL defence.
// `OutboundUrl.problem` refuses what a URL *says*; a name that says nothing suspicious can still
// resolve to `169.254.169.254` or `10.0.0.5`. A plugin that calls an administrator-supplied URL
// requires this port and checks the answer before it connects (`refusal`), so an internal address
// hidden behind a public-looking name is refused at call time, not only at registration.
//
// This narrows DNS rebinding (a name that flips between the check and the connect) but cannot
// close it, because the HTTP client resolves the name again on its own: pinning the connection to
// the checked address needs support in the client. Egress filtering at the network layer stays the
// deployer's control; this port is defence in depth. An application provides one implementation:
// `layerNode` (the platform resolver), `layerStatic` (tests, fixed tables), or its own.

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
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

/**
 * `Some(reason)` when `url`'s host is, or resolves to, anything but a globally routable unicast
 * address. An IP literal is judged as written (no lookup); a name must resolve, and *every*
 * address it resolves to must be public — one private answer among several is a refusal.
 */
export const refusal = (url: string) =>
  Effect.gen(function* () {
    const parsed = URL.parse(url);
    if (parsed === null) return Option.some("not an absolute URL");
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (OutboundUrl.isIpLiteral(host)) {
      return OutboundUrl.isPublicAddress(host)
        ? Option.none<string>()
        : Option.some("points at a private or loopback address");
    }
    const resolver = yield* HostResolver;
    const addresses = yield* resolver.resolve(host).pipe(Effect.option);
    if (Option.isNone(addresses) || addresses.value.length === 0) {
      return Option.some("host does not resolve");
    }
    return addresses.value.every(OutboundUrl.isPublicAddress)
      ? Option.none<string>()
      : Option.some("resolves to a private or loopback address");
  });
