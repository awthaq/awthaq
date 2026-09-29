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
//
// EP-004 (ADR-EA-018): after the static registry, a provider id is offered to
// the installed `OAuthConnections` resolver (per-organization connections). The
// static registry always wins, so a connection can never shadow a static
// provider; a connection's discovery is resolved lazily, cached per revision,
// and never cached when it fails.

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as OAuthApi from "./OAuthApi.ts";
import * as OAuthConfig from "./OAuthConfig.ts";
import * as OAuthConnections from "./OAuthConnections.ts";
import * as OAuthProvider from "./OAuthProvider.ts";
import * as ProviderHttp from "./ProviderHttp.ts";

export interface OAuthProvidersShape {
  /** Whether `providerId` is configured at all, statically or as a connection — never fetches discovery. */
  readonly has: (providerId: string) => Effect.Effect<boolean>;
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
/** EP-004: how long a connection's discovery result is reused (a changed `revision` drops it sooner). */
const CONNECTION_REFRESH = Duration.hours(1);

export const layer = Layer.effect(
  OAuthProviders,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const config = yield* OAuthConfig.OAuthConfig;
    const connections = yield* OAuthConnections.OAuthConnectionResolver;
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

    // EP-004: resolved connection providers, by namespaced id. A hit is reused
    // only for the revision it was built from and until it goes stale.
    const resolvedConnections = new Map<
      string,
      {
        readonly revision: string;
        readonly expiresAtMillis: number;
        readonly provider: OAuthProvider.ResolvedProvider;
      }
    >();

    const connectionProvider = (
      resolver: OAuthConnections.OAuthConnectionResolverShape,
      providerId: string,
    ): Effect.Effect<
      OAuthProvider.ResolvedProvider,
      OAuthApi.ProviderNotFound | OAuthApi.ProviderUnavailable
    > =>
      Effect.gen(function* () {
        const found = yield* resolver.find(providerId);
        if (Option.isNone(found)) {
          resolvedConnections.delete(providerId);
          return yield* new OAuthApi.ProviderNotFound({ providerId });
        }
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        const cached = resolvedConnections.get(providerId);
        if (
          cached !== undefined &&
          cached.revision === found.value.revision &&
          cached.expiresAtMillis > now
        ) {
          return cached.provider;
        }
        const provider = yield* resolveOne(found.value.config).pipe(
          Effect.tapError((error) => Effect.logWarning(error.message)),
          Effect.mapError(() => new OAuthApi.ProviderUnavailable()),
          // A reachable-but-wrong connection (issuer mismatch, missing endpoints)
          // is that connection's problem, never a defect of the whole runtime.
          Effect.catchDefect((defect) =>
            Effect.logError(
              `awthaq/oauth: connection "${providerId}" is invalid and was not served`,
              defect,
            ).pipe(Effect.andThen(Effect.fail(new OAuthApi.ProviderUnavailable()))),
          ),
        );
        resolvedConnections.set(providerId, {
          revision: found.value.revision,
          expiresAtMillis: now + Duration.toMillis(CONNECTION_REFRESH),
          provider,
        });
        return provider;
      });

    return OAuthProviders.of({
      has: (providerId) =>
        registry.has(providerId)
          ? Effect.succeed(true)
          : Option.match(connections, {
              onNone: () => Effect.succeed(false),
              onSome: (resolver) => Effect.map(resolver.find(providerId), Option.isSome),
            }),
      get: (providerId) => {
        const registered = registry.get(providerId);
        if (registered !== undefined) return registered;
        return Option.match(connections, {
          onNone: () => Effect.fail(new OAuthApi.ProviderNotFound({ providerId })),
          onSome: (resolver) => connectionProvider(resolver, providerId),
        });
      },
    });
  }),
);
