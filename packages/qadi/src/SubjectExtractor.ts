// @awthaq/qadi — SubjectExtractor (Path B adapter)
//
// spec/behaviors/20-qadi-bridge-path-b.md, BEH-EA-153; ADR-EA-042.
//
// `@qadi/http` already ships the `SubjectExtractor` interface and the
// `RequirePermission` middleware built on it (BEH-EA-154 through 160 are all
// qadi's own exports — `RequiredPermission`/`PublicEndpoint` annotations,
// `requiresPermission`/`publicEndpoint`, the 403/502/500 status mapping,
// `guardApi`/`permissionRegistryRoute` — nothing awthaq-specific to
// build for those). What awthaq owns is the one *implementation* of
// that interface: an adapter over `@awthaq/server`'s `Credentials`, the one
// credential-resolution module, run directly against the raw request,
// independent of `Authentication`'s middleware pipeline (so qadi's
// `RequirePermission` can run before any awthaq contract middleware does).
// Path B's chain is the machine tier's declaration (it admits what Path A's
// machine tier admits), and a credential that does not resolve falls through
// to the next one exactly as it does on Path A.
import { Api } from "@awthaq/api";
import { Sessions } from "@awthaq/core";
import { ClientAddress } from "@awthaq/ports";
import { Credentials, RequestContext } from "@awthaq/server";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SubjectExtractionFailed, SubjectExtractor } from "@qadi/http";
import { SubjectResolver } from "./SubjectResolver.ts";

/**
 * BEH-EA-153: an absent or invalid credential is `anonymousPrincipal` — only
 * `Api.Unauthenticated` (every presented credential failed to resolve) is caught
 * below and mapped to it. MA-004: a store outage is the typed `StoreUnavailable`,
 * which this extractor reports as `@qadi/http`'s `SubjectExtractionFailed` — the
 * store-is-unreachable signal that error is reserved for — never as an anonymous
 * caller and never as a defect. PIL-005: a rotating `verify` registers its delivery
 * on the request itself (`Credentials.httpScope`), so a Path-B-only route rotates
 * cleanly.
 *
 * ADR-EA-047: `@qadi/http`'s `extract(request)` cannot carry a requirement, so this is the one reader of the request
 * context that reads it optionally: inside a group that declares `Api.RequestContext` (every awthaq group) it is the
 * middleware's capture; on a host route without one, it captures the same facts itself with `RequestContext.capture`.
 */
export const SubjectExtractorLive: Layer.Layer<
  SubjectExtractor,
  never,
  | Sessions.Sessions
  | Credentials.PrincipalResolver
  | ClientAddress.ClientAddress
  | SecureRandom.SecureRandom
> = Layer.effect(
  SubjectExtractor,
  Effect.gen(function* () {
    const credentials = yield* Credentials.make;
    const subjectResolver = yield* SubjectResolver;
    const captureDeps = Layer.succeedContext(
      yield* Effect.context<ClientAddress.ClientAddress | SecureRandom.SecureRandom>(),
    );
    const contextOf = (request: Parameters<typeof RequestContext.capture>[0]) =>
      Effect.flatMap(
        Effect.serviceOption(Api.AuthRequestContext),
        Option.match({
          onSome: Effect.succeed,
          onNone: () => RequestContext.capture(request).pipe(Effect.provide(captureDeps)),
        }),
      );
    return {
      extract: (request) =>
        Effect.all([Credentials.fromRequest(request), contextOf(request)]).pipe(
          Effect.flatMap(([presented, context]) =>
            credentials.resolve(
              presented,
              Credentials.machineTier,
              Credentials.httpScope(request, context),
            ),
          ),
          Effect.map((resolved) => resolved.principal),
          Effect.catchTag("Unauthenticated", () => Effect.succeed(Api.anonymousPrincipal)),
          Effect.flatMap(subjectResolver.resolve),
          Effect.catchTag("StoreUnavailable", (error) =>
            Effect.fail(
              new SubjectExtractionFailed({
                reason: `awthaq: session store unavailable (${error.operation})`,
              }),
            ),
          ),
        ),
    };
  }),
);
