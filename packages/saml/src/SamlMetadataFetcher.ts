// @awthaq/saml — SamlMetadataFetcher
//
// BEH-EA-318: fetching an IdP's metadata document from a URL an administrator supplied. That is an SSRF surface exactly like a
// webhook endpoint, so it gets the same defences, in the same order: the URL passes `OutboundUrl` (https, no credentials, no
// private or internal name), its host is resolved ONCE (`HostResolver.pin`) with every answer required to be public, and the
// request connects to that checked address with the original Host/SNI (`PinnedHttp`, `@awthaq/ports`), so a name that flips
// between the check and the connect has nothing to flip. A redirect is never followed, the body is read only up to
// `maxMetadataBytes` (a longer one is `tooLarge`, cut off, not buffered), the deadline is `metadataTimeout`, and failures are
// classes (`blocked`, `timeout`, `connect`, `tooLarge`, `status`), never a message from the far end.
//
// What comes back is a string, not yet trusted: the caller parses it through `SafeXml` (`parseIdpMetadata`) like pasted
// metadata, and the trust it creates is the certificates' FINGERPRINTS, pinned in the connection: importing metadata is trusting
// the channel it arrived by (TLS from the IdP's own URL), which is exactly why the channel is guarded this hard.

import { HostResolver, OutboundUrl, PinnedHttp } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SamlConfig from "./SamlConfig.ts";

/** The metadata could not be fetched; `failure` is a class, never text from the far end. */
export class MetadataFetchFailed extends Data.TaggedError("MetadataFetchFailed")<{
  readonly failure: "invalidUrl" | "blocked" | "timeout" | "connect" | "tooLarge" | "status";
  /** For `invalidUrl`/`blocked` before any request: the local rule that refused (a constant sentence of ours). */
  readonly detail: string;
}> {}

export interface SamlMetadataFetcherShape {
  readonly fetch: (url: string) => Effect.Effect<string, MetadataFetchFailed>;
}

export class SamlMetadataFetcher extends Context.Service<
  SamlMetadataFetcher,
  SamlMetadataFetcherShape
>()("awthaq/saml/SamlMetadataFetcher") {}

/** Requires `HostResolver` and `SamlConfig`; connects with `node:http(s)` (Node only). */
export const layerPinned = Layer.effect(
  SamlMetadataFetcher,
  Effect.gen(function* () {
    const resolver = yield* HostResolver.HostResolver;
    const settings = yield* SamlConfig.SamlConfig;
    return SamlMetadataFetcher.of({
      fetch: (url) =>
        Effect.gen(function* () {
          const problem = OutboundUrl.problem("metadataUrl", url, {
            allowPrivate: settings.allowPrivateTargets,
          });
          if (Option.isSome(problem)) {
            return yield* Effect.fail(
              new MetadataFetchFailed({ failure: "invalidUrl", detail: problem.value }),
            );
          }
          const pin = settings.allowPrivateTargets
            ? Result.succeed(Option.none<HostResolver.PinnedTarget>())
            : Result.map(
                yield* HostResolver.pin(url).pipe(
                  Effect.provideService(HostResolver.HostResolver, resolver),
                ),
                Option.some,
              );
          if (Result.isFailure(pin)) {
            return yield* Effect.fail(
              new MetadataFetchFailed({ failure: "blocked", detail: `the URL ${pin.failure}` }),
            );
          }
          const response = yield* PinnedHttp.send({
            method: "GET",
            url,
            headers: { accept: "application/samlmetadata+xml, application/xml, text/xml" },
            pin: pin.success,
            allowPrivate: settings.allowPrivateTargets,
            timeout: settings.metadataTimeout,
            maxResponseBytes: settings.maxMetadataBytes,
          }).pipe(
            Effect.mapError(
              (error) =>
                new MetadataFetchFailed({ failure: error.failure, detail: "the request failed" }),
            ),
          );
          if (response.status !== 200 || response.body === undefined) {
            return yield* Effect.fail(
              new MetadataFetchFailed({
                failure: "status",
                detail: "the server did not answer 200",
              }),
            );
          }
          return response.body;
        }),
    });
  }),
);
