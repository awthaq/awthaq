// Ticket 19 / spec.md's "Lifecycle hooks": proves a tapped `veto` can
// abort or amend a representative operation, and a tapped `observe` fires
// after a representative success without being able to affect its
// outcome. One operation per area (org/member/invitation/team) would be
// excessive; `create` and `createTeam` are enough to prove the mechanism
// itself works, since every other operation wires the identical pattern
// (see `Organization.ts`'s own header comment — this is the first real
// plugin consumer of `HookPoint`, mirrored identically everywhere).
//
// Every hook point class is a shared, module-level singleton whose
// registry freezes at its own first `run()` (BEH-EA-024) — including an
// implicit run with zero taps, which is exactly what an earlier, untapped
// `create`/`createTeam` call in this same file would do to a later test
// wanting to tap that same point. Each `it.effect` case below is therefore
// the *only* place in this file that ever calls the operation whose hooks
// it taps, and taps every point that operation touches (both its `before`
// and `after`) up front, in the same `Effect.provide`, so nothing runs
// untapped before the tap is installed.
import { Api } from "@awthaq/api";
import { AuthEvents, HookPoint, Sessions, Users } from "@awthaq/core";
import { Mailer } from "@awthaq/ports";
import { Authentication } from "@awthaq/server";
import { NodeCrypto } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  ActiveContextRecords,
  InvitationRecords,
  MembershipRecords,
  Organization,
  OrganizationHooks,
  OrganizationRecords,
  OrgRoleRecords,
  TeamRecords,
} from "../src/index.ts";

const CoreLive = Layer.mergeAll(Sessions.layerMemory, AuthEvents.layer, Users.layerMemory).pipe(
  Layer.provideMerge(NodeCrypto.layer),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const buildLayer = (extraHooks: Layer.Layer<never>) =>
  Organization.Organization.layer.pipe(
    Layer.provide(
      Organization.config({
        teams: {
          enabled: true,
          maximumTeams: Number.POSITIVE_INFINITY,
          maximumMembersPerTeam: Number.POSITIVE_INFINITY,
          allowRemovingAllTeams: false,
        },
      }),
    ),
    Layer.provide(AuthenticationLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(OrganizationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(MembershipRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(ActiveContextRecords.layerMemory),
    Layer.provideMerge(InvitationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(OrgRoleRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(TeamRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(Mailer.layerMemory),
    Layer.provideMerge(extraHooks),
    Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
  );

const asCaller = (id: string): Api.UserPrincipal =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id }),
    sessionId: `session-${id}`,
  });

describe("OrganizationHooks (BEH-EA-089-096, ticket 19)", () => {
  it.effect(
    "create: a veto tap can abort or amend, and an observe tap's own failure never affects the outcome",
    () =>
      Effect.gen(function* () {
        const organization = yield* Organization.Organization;
        const owner = asCaller("owner-1");

        const aborted = yield* organization
          .create({ caller: owner, name: "Nope", slug: "forbidden" })
          .pipe(Effect.exit);
        assert.strictEqual(aborted._tag, "Failure");

        const record = yield* organization.create({
          caller: owner,
          name: "Original",
          slug: "acme",
        });
        // The veto tap amended the name; the observe tap below always
        // fails, and that failure must never surface here.
        assert.strictEqual(record.name, "Renamed By Tap");

        const orgs = yield* organization.list(owner);
        assert.strictEqual(orgs.length, 1);
      }).pipe(
        Effect.provide(
          buildLayer(
            Layer.mergeAll(
              OrganizationHooks.BeforeCreateOrganization.tap((input) =>
                input.slug === "forbidden"
                  ? Effect.fail(new HookPoint.HookAbort({ code: "SLUG_FORBIDDEN" }))
                  : Effect.succeed({ ...input, name: "Renamed By Tap" }),
              ),
              OrganizationHooks.AfterCreateOrganization.tap(() =>
                Effect.fail("observer exploded, this must never surface"),
              ),
            ),
          ),
        ),
      ),
  );

  it.effect(
    "createTeam: a veto tap can abort team creation (a second, independent operation area)",
    () =>
      Effect.gen(function* () {
        const organization = yield* Organization.Organization;
        const owner = asCaller("owner-1");
        const record = yield* organization.create({ caller: owner, name: "Acme", slug: "acme" });

        const exit = yield* organization
          .createTeam(owner, record.id, "forbidden-team")
          .pipe(Effect.exit);
        assert.strictEqual(exit._tag, "Failure");

        const teams = yield* organization.listTeams(record.id);
        assert.strictEqual(teams.length, 0);
      }).pipe(
        Effect.provide(
          buildLayer(
            OrganizationHooks.BeforeCreateTeam.tap((input) =>
              input.name === "forbidden-team"
                ? Effect.fail(new HookPoint.HookAbort({ code: "TEAM_NAME_FORBIDDEN" }))
                : Effect.succeed(input),
            ),
          ),
        ),
      ),
  );
});
