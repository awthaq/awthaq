// @awthaq/oauth — OAuthProviders
//
// NAM-004: the resolved-provider registry, built once and shared by
// `OAuth.layer` and `OAuthTokenAccess.layer` (each used to run its own
// `Effect.all(providers.map(resolve))`, fetching every discovery document
// twice). Both layers provide `OAuthProviders.layer` themselves; because
// Layers memoize by reference, a composition that uses both builds it — and
// fetches discovery — exactly once.
//
// Boot-mode providers (the default) are resolved while the layer builds:
// misconfiguration dies (BEH-EA-127), and an unreachable discovery endpoint
// is retried (ERS-003) before it, too, fails startup. `discovery: { mode:
// "lazy" }` providers resolve on first use instead — see
// `OAuthProvider.OAuthDiscoveryPolicy`.

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as OAuthApi from "./OAuthApi.ts";
import * as OAuthConfig from "./OAuthConfig.ts";
import * as OAuthProvider from "./OAuthProvider.ts";
import * as ProviderHttp from "./ProviderHttp.ts";

export interface OAuthProvidersShape {
  /** Whether `providerId` is configured at all — cheap, never touches the network. */
  readonly has: (providerId: string) => boolean;
  /** The resolved provider; a `"lazy"` one may still be resolving (or unreachable), hence `ProviderUnavailable`. */
  readonly get: (
    providerId: string,
  ) => Effect.Effect<
    OAuthProvider.ResolvedProvider,
    OAuthApi.ProviderNotFound | OAuthApi.ProviderUnavailable
  >;
}

export class OAuthProviders extends Context.Service<OAuthProviders, OAuthProvidersShape>()(
  "awthaq/oauth/OAuthProviders",
) {}

const DEFAULT_LAZY_REFRESH = Duration.hours(1);

export const layer = Layer.effect(
  OAuthProviders,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const config = yield* OAuthConfig.OAuthConfig;
    const discoveryClient = ProviderHttp.retrying(httpClient, config.retry);
    const resolveOne = (provider: OAuthProvider.OAuthProviderConfig) =>
      OAuthProvider.resolve(discoveryClient, provider, {
        discoveryTimeout: config.httpTimeouts.discovery,
      });

    const registry = new Map<
      string,
      Effect.Effect<
        OAuthProvider.ResolvedProvider,
        OAuthApi.ProviderNotFound | OAuthApi.ProviderUnavailable
      >
    >();

    for (const provider of config.providers) {
      if (provider.discovery?.mode === "lazy" && provider.discoveryUrl !== undefined) {
        const disabled = yield* Ref.make(false);
        const refresh = provider.discovery.refresh ?? DEFAULT_LAZY_REFRESH;
        // A failed resolution is never cached (TTL zero), so the next
        // request retries; a successful one is reused for `refresh`.
        const resolved = yield* Effect.cachedWithTTL(
          resolveOne(provider).pipe(
            Effect.tapError((error) => Effect.logWarning(error.message)),
            Effect.mapError(() => new OAuthApi.ProviderUnavailable()),
            // A reachable-but-wrong document (issuer mismatch, malformed
            // body) is BEH-EA-127's defect: this provider never serves again.
            Effect.catchDefect((defect) =>
              Effect.logError(
                `awthaq/oauth: provider "${provider.id}" disabled — discovery is invalid`,
                defect,
              ).pipe(
                Effect.andThen(Ref.set(disabled, true)),
                Effect.andThen(Effect.fail(new OAuthApi.ProviderUnavailable())),
              ),
            ),
          ),
          (exit) => (Exit.isSuccess(exit) ? refresh : Duration.zero),
        );
        registry.set(
          provider.id,
          Effect.flatMap(Ref.get(disabled), (isDisabled) =>
            isDisabled ? Effect.fail(new OAuthApi.ProviderUnavailable()) : resolved,
          ),
        );
      } else {
        const resolved = yield* resolveOne(provider).pipe(
          Effect.catchTag("DiscoveryUnavailable", (error) => Effect.die(new Error(error.message))),
        );
        registry.set(provider.id, Effect.succeed(resolved));
      }
    }

    return OAuthProviders.of({
      has: (providerId) => registry.has(providerId),
      get: (providerId) =>
        registry.get(providerId) ??
        Effect.fail(new OAuthApi.ProviderNotFound({ providerId })),
    });
  }),
);
