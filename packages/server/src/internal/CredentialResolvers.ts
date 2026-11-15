// @awthaq/server — internal CredentialResolvers
//
// ADR-EA-012 registry of claimed credentials, one of the internal modules behind `Credentials.ts`.

import { Api } from "@awthaq/api";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

/**
 * MAPS-001/MAPS-004/OCM-002: the carriers whose credentials a plugin may claim
 * instead of a session: `bearer` (`Authorization: Bearer`, JWTs) and `apiKey`
 * (`x-api-key`). `cookie`/`impersonation` are session-only by design (BEH-EA-065).
 */
export type ClaimCarrier = "bearer" | "apiKey";

/**
 * MAPS-001/MAPS-004 (wayfinder ticket 33, registry option): one plugin's claim on
 * a carrier's credentials. `claims` is a cheap, secret-free look at the credential's
 * *shape* (three dot-separated segments and a JOSE `typ`, a key prefix), never a
 * verification and never constant-time-sensitive; the first contribution whose
 * `claims` matches resolves, and if that resolution fails the request is
 * `Unauthenticated` (later contributions are not tried, so one credential is
 * never probed against several strategies). A `bearer` credential nobody claims
 * falls through to opaque session resolution, exactly as before.
 * `resolve` goes straight to an `Api.Principal`: a stateless token has no session
 * row to hand `PrincipalResolver` (and so no rotation to deliver). It runs inside
 * the request: `HttpServerRequest` and the request context (ADR-EA-047; e.g. to
 * rate-limit by client address) are the services it may require; every other
 * dependency is captured when the contributing layer is built.
 */
export interface CredentialResolverContribution {
  readonly id: string;
  /** Lower runs first among contributions claiming the same credential shape; ties break on `id`. Default 0. */
  readonly order?: number;
  readonly claims: (credential: string) => boolean;
  readonly resolve: (
    credential: Redacted.Redacted<string>,
  ) => Effect.Effect<
    Api.Principal,
    Api.Unauthenticated | Api.StoreUnavailable,
    HttpServerRequest.HttpServerRequest | Api.AuthRequestContext
  >;
}

/** Two contributions on one carrier share an `id`: a composition mistake, surfaced at layer build. */
export class DuplicateCredentialResolver extends Data.TaggedError("DuplicateCredentialResolver")<{
  readonly carrier: ClaimCarrier;
  readonly id: string;
  readonly message: string;
}> {}

/** A contribution arrived after the registry was first read (ADR-EA-012: registries freeze at first read). */
export class CredentialResolversFrozen extends Data.TaggedError("CredentialResolversFrozen")<{
  readonly message: string;
}> {}

export interface CredentialResolversShape {
  readonly register: (
    carrier: ClaimCarrier,
    contribution: CredentialResolverContribution,
  ) => Effect.Effect<void, DuplicateCredentialResolver | CredentialResolversFrozen>;
  /** The carrier's contributions in (`order`, `id`) order; the first call freezes the registry. */
  readonly resolvers: (
    carrier: ClaimCarrier,
  ) => Effect.Effect<ReadonlyArray<CredentialResolverContribution>>;
}

/**
 * ADR-EA-012 registry (aggregating, not an exclusive slot): any number of plugins
 * add a credential type with `contribute` and a Layer alone, without editing
 * `@awthaq/api` or this package. A real per-composition service (like
 * `RateLimitsRegistry`), so unrelated compositions and tests never share one.
 * `Authentication` reads it per request through `Effect.serviceOption`, so
 * `AuthenticationLive`'s own `R` is unchanged and an app that provides no
 * registry simply has no contributions.
 */
export class CredentialResolvers extends Context.Service<
  CredentialResolvers,
  CredentialResolversShape
>()("awthaq/server/CredentialResolvers") {}

export const CredentialResolversLive = Layer.effect(
  CredentialResolvers,
  Effect.gen(function* () {
    const entries = yield* Ref.make<
      ReadonlyArray<{
        readonly carrier: ClaimCarrier;
        readonly contribution: CredentialResolverContribution;
      }>
    >([]);
    const frozen = yield* Ref.make(false);
    const register: CredentialResolversShape["register"] = (carrier, contribution) =>
      Effect.gen(function* () {
        if (yield* Ref.get(frozen)) {
          return yield* new CredentialResolversFrozen({
            message: `awthaq: credential resolver "${contribution.id}" was contributed after the registry was first read`,
          });
        }
        const existing = yield* Ref.get(entries);
        if (existing.some((e) => e.carrier === carrier && e.contribution.id === contribution.id)) {
          return yield* new DuplicateCredentialResolver({
            carrier,
            id: contribution.id,
            message: `awthaq: two ${carrier} credential resolvers share the id "${contribution.id}"`,
          });
        }
        yield* Ref.set(entries, [...existing, { carrier, contribution }]);
      });
    const resolvers: CredentialResolversShape["resolvers"] = (carrier) =>
      Ref.set(frozen, true).pipe(
        Effect.flatMap(() => Ref.get(entries)),
        Effect.map((all) =>
          all
            .filter((e) => e.carrier === carrier)
            .map((e) => e.contribution)
            .sort(
              (a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
            ),
        ),
      );
    return CredentialResolvers.of({ register, resolvers });
  }),
);

/** A Layer that adds one contribution to `carrier`: how `@awthaq/jwt` and `@awthaq/api-key` claim credentials. */
export const contribute = (carrier: ClaimCarrier, contribution: CredentialResolverContribution) =>
  Layer.effectDiscard(
    Effect.flatMap(CredentialResolvers, (registry) => registry.register(carrier, contribution)),
  );

/**
 * The claiming contribution for `credential`, or `None` when no contribution claims it (or none are
 * registered). The registry lookup alone; running the contribution is `resolveClaimed`.
 */
const findClaim = (carrier: ClaimCarrier, credential: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const raw = Redacted.value(credential);
    const registry = yield* Effect.serviceOption(CredentialResolvers);
    if (raw === "" || Option.isNone(registry)) return Option.none<CredentialResolverContribution>();
    const contributions = yield* registry.value.resolvers(carrier);
    return Option.fromNullishOr(contributions.find((contribution) => contribution.claims(raw)));
  });

/**
 * MAPS-001/OCM-002: the claiming contribution's principal, or `None` when no contribution claims the
 * credential. A claimed credential that fails to resolve fails `Unauthenticated`: see
 * `CredentialResolverContribution`.
 */
export const resolveClaimed = (carrier: ClaimCarrier, credential: Redacted.Redacted<string>) =>
  findClaim(carrier, credential).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<Api.Principal>()),
        onSome: (claiming) => Effect.map(claiming.resolve(credential), Option.some),
      }),
    ),
  );
