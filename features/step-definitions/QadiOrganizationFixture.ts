// AH-003 (decision 36, Tier 2): the real `@awthaq/organization` stores plus its qadi
// `relationships` resolver, composed the way `packages/organization/test/OrganizationQadi.test.ts`
// does, for 21-qadi-resolvers-obligations.feature (BEH-EA-162). The one seam an application owns is
// `ResourceOrganizationLookup` (which organization a resource belongs to); `probe` lets a scenario
// steer and observe it.
import { Sessions, Users } from "@awthaq/core";
import {
  Organization,
  OrganizationHooks,
  OrganizationQadi,
  OrganizationMemory,
} from "@awthaq/organization";
import { Mailer, SqlTransaction } from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { CsrfConfigForTests } from "./CsrfTestSupport.ts";
import { TestAuth } from "@awthaq/test";

/** What a scenario steers and observes about the application's resource -> organization walk. */
export interface WalkProbe {
  /** resource id -> the organization that owns it */
  readonly parents: Ref.Ref<Readonly<Record<string, string>>>;
  /** every resource id the resolver asked the lookup about */
  readonly consulted: Ref.Ref<ReadonlyArray<string>>;
  /** when true the lookup itself fails (the "organization-membership lookup fails while walking" case) */
  readonly failing: Ref.Ref<boolean>;
}

/** The application's own lookup failing (a database outage behind it). */
class LookupDown extends Data.TaggedError("LookupDown")<{ readonly reason: string }> {}

export const makeWalkProbe = (): WalkProbe => ({
  parents: Ref.makeUnsafe<Readonly<Record<string, string>>>({}),
  consulted: Ref.makeUnsafe<ReadonlyArray<string>>([]),
  failing: Ref.makeUnsafe(false),
});

const CoreLive = Layer.mergeAll(Sessions.layerMemory, Users.layerMemory).pipe(
  Layer.provideMerge(TestAuth.memoryFoundation),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(Layer.succeed(Csrf.CsrfConfig, CsrfConfigForTests)),
  Layer.provide(NodeCrypto.layer),
);

const OrganizationLive = Organization.Organization.layer.pipe(
  Layer.provide(Organization.config({})),
  Layer.provide(AuthenticationLive),
  Layer.provide(CsrfProtectionLive),
  Layer.provideMerge(OrganizationMemory.layer),
  Layer.provideMerge(CoreLive),
  Layer.provideMerge(Mailer.layerMemory),
  Layer.provideMerge(SqlTransaction.layerNoop),
  Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
);

export const organizationFixture = (probe: WalkProbe) => {
  const lookup = Layer.succeed(
    OrganizationQadi.ResourceOrganizationLookup,
    OrganizationQadi.ResourceOrganizationLookup.of({
      organizationOf: (resourceId) =>
        Effect.gen(function* () {
          yield* Ref.update(probe.consulted, (seen) => [...seen, resourceId]);
          if (yield* Ref.get(probe.failing)) {
            return yield* Effect.fail(
              new LookupDown({ reason: "organization-membership lookup is down" }),
            );
          }
          return Option.fromNullishOr((yield* Ref.get(probe.parents))[resourceId]);
        }),
    }),
  );
  return OrganizationQadi.relationships.pipe(
    Layer.provide(lookup),
    Layer.provideMerge(OrganizationLive),
  );
};

export type OrganizationFixtureServices = Layer.Success<ReturnType<typeof organizationFixture>>;
