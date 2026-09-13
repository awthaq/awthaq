// spec.md. The `organization` group exercised over a real `HttpRouter`/
// `HttpRouter.toWebHandler` — real HTTP requests/responses, real status
// codes, a real session cookie — mirroring `@effect-auth/admin`'s own
// `AuthHttp.test.ts`.
import { AuthEvents, Sessions, Users } from "@effect-auth/core";
import { Mailer } from "@effect-auth/ports";
import { Authentication, AuthHttp } from "@effect-auth/server";
import { NodeCrypto } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { TestAuth } from "@effect-auth/test";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import {
  ActiveContextRecords,
  InvitationRecords,
  MembershipRecords,
  Organization,
  OrganizationApi,
  OrganizationHooks,
  OrganizationRecords,
  OrgRoleRecords,
  TeamRecords,
} from "../src/index.ts";

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const CoreLive = Layer.mergeAll(Sessions.layerMemory, AuthEvents.layer, Users.layerMemory).pipe(
  Layer.provideMerge(NodeCrypto.layer),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const buildAppLayer = (configOverrides: Partial<Organization.OrganizationConfigShape> = {}) =>
  Layer.mergeAll(
    AuthHttp.routes(OrganizationApi.OrganizationApi, { openapiPath: "/openapi.json" }).pipe(
      Layer.provide(Organization.Organization.layer),
      Layer.provide(Organization.config(configOverrides)),
      Layer.provide(AuthenticationLive),
    ),
    AuthHttp.docs(OrganizationApi.OrganizationApi),
  ).pipe(
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(OrganizationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(MembershipRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(ActiveContextRecords.layerMemory),
    Layer.provideMerge(InvitationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(OrgRoleRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(TeamRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(Mailer.layerMemory),
    Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
  );

const ORIGIN = "http://localhost:3000";

const buildHandler = (configOverrides: Partial<Organization.OrganizationConfigShape> = {}) => {
  const AppLayer = buildAppLayer(configOverrides);
  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler } = HttpRouter.toWebHandler(AppLayer, { memoMap });

  /** Mirrors `@effect-auth/admin`'s own `AuthHttp.test.ts`: a real session cookie against the same running `Sessions` instance. */
  const issueSessionCookieHeader = (userId: string): Promise<string> =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const context = yield* Layer.buildWithMemoMap(AppLayer, memoMap, scope);
          return yield* Effect.gen(function* () {
            const sessions = yield* Sessions.Sessions;
            const issued = yield* sessions.issue({ userId: Users.UserId(userId) });
            return `__Host-session=${encodeURIComponent(Redacted.value(issued.token))}`;
          }).pipe(Effect.provide(context));
        }),
      ),
    );

  return { handler, issueSessionCookieHeader };
};

const request = (
  handler: (request: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Response> =>
  handler(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

describe("AuthHttp + Organization (real HTTP)", () => {
  it.effect("full create -> get -> update -> delete over real HTTP", () =>
    Effect.gen(function* () {
      const { handler, issueSessionCookieHeader } = buildHandler();
      const cookie = yield* Effect.promise(() => issueSessionCookieHeader("owner-1"));

      const created = yield* Effect.promise(() =>
        request(handler, "POST", "/organization", { name: "Acme", slug: "acme" }, { cookie }),
      );
      assert.strictEqual(created.status, 200);
      const record = (yield* Effect.promise(() => created.json())) as { id: string; slug: string };
      assert.strictEqual(record.slug, "acme");

      const fetched = yield* Effect.promise(() =>
        handler(new Request(`${ORIGIN}/organization/${record.id}`, { headers: { cookie } })),
      );
      assert.strictEqual(fetched.status, 200);

      const updated = yield* Effect.promise(() =>
        request(handler, "PATCH", `/organization/${record.id}`, { name: "Acme Inc" }, { cookie }),
      );
      assert.strictEqual(updated.status, 200);
      const updatedBody = (yield* Effect.promise(() => updated.json())) as { name: string };
      assert.strictEqual(updatedBody.name, "Acme Inc");

      const deleted = yield* Effect.promise(() =>
        request(handler, "DELETE", `/organization/${record.id}`, undefined, { cookie }),
      );
      assert.strictEqual(deleted.status, 204);

      const goneAfterDelete = yield* Effect.promise(() =>
        handler(new Request(`${ORIGIN}/organization/${record.id}`, { headers: { cookie } })),
      );
      assert.strictEqual(goneAfterDelete.status, 404);
    }),
  );

  it("create answers 409 for a slug collision", async () => {
    const { handler, issueSessionCookieHeader } = buildHandler();
    const cookie = await issueSessionCookieHeader("owner-1");
    await request(handler, "POST", "/organization", { name: "Acme", slug: "acme" }, { cookie });
    const collision = await request(
      handler,
      "POST",
      "/organization",
      { name: "Acme 2", slug: "acme" },
      { cookie },
    );
    assert.strictEqual(collision.status, 409);
  });

  it("update answers 403 for a non-member without permission", async () => {
    const { handler, issueSessionCookieHeader } = buildHandler();
    const ownerCookie = await issueSessionCookieHeader("owner-1");
    const outsiderCookie = await issueSessionCookieHeader("outsider-1");
    const created = await request(
      handler,
      "POST",
      "/organization",
      { name: "Acme", slug: "acme" },
      { cookie: ownerCookie },
    );
    const record = (await created.json()) as { id: string };

    const denied = await request(
      handler,
      "PATCH",
      `/organization/${record.id}`,
      { name: "x" },
      { cookie: outsiderCookie },
    );
    assert.strictEqual(denied.status, 403);
  });

  it("removeMember answers 409 (OwnerInvariantViolation) for the last owner", async () => {
    const { handler, issueSessionCookieHeader } = buildHandler();
    const cookie = await issueSessionCookieHeader("owner-1");
    const created = await request(
      handler,
      "POST",
      "/organization",
      { name: "Acme", slug: "acme" },
      { cookie },
    );
    const record = (await created.json()) as { id: string };

    const removed = await request(
      handler,
      "DELETE",
      `/organization/${record.id}/members/owner-1`,
      undefined,
      { cookie },
    );
    assert.strictEqual(removed.status, 409);
  });

  it("listMembers answers the members of an organization over real HTTP", async () => {
    const { handler, issueSessionCookieHeader } = buildHandler();
    const cookie = await issueSessionCookieHeader("owner-1");
    const created = await request(
      handler,
      "POST",
      "/organization",
      { name: "Acme", slug: "acme" },
      { cookie },
    );
    const record = (await created.json()) as { id: string };

    const members = await handler(
      new Request(`${ORIGIN}/organization/${record.id}/members`, { headers: { cookie } }),
    );
    assert.strictEqual(members.status, 200);
    const rows = (await members.json()) as ReadonlyArray<unknown>;
    assert.strictEqual(rows.length, 1);
  });

  it("setActive/getActive round-trip over real HTTP", async () => {
    const { handler, issueSessionCookieHeader } = buildHandler();
    const cookie = await issueSessionCookieHeader("owner-1");
    const created = await request(
      handler,
      "POST",
      "/organization",
      { name: "Acme", slug: "acme" },
      { cookie },
    );
    const record = (await created.json()) as { id: string };

    const set = await request(
      handler,
      "POST",
      "/organization/active",
      { organizationId: record.id },
      { cookie },
    );
    assert.strictEqual(set.status, 200);

    const active = await handler(
      new Request(`${ORIGIN}/organization/active`, { headers: { cookie } }),
    );
    assert.strictEqual(active.status, 200);
    const activeBody = (await active.json()) as { activeOrganizationId: string | null };
    assert.strictEqual(activeBody.activeOrganizationId, record.id);

    const activeMember = await handler(
      new Request(`${ORIGIN}/organization/active-member`, { headers: { cookie } }),
    );
    assert.strictEqual(activeMember.status, 200);
  });

  it("invite -> list -> cancel over real HTTP", async () => {
    // The full invite-then-accept round trip (a real `Users` record backing
    // the accepting caller's email) is covered at the domain level in
    // `Organization.test.ts` — this wire-level test exercises the HTTP
    // surface for invite/list/cancel, which don't need a real `Users` row.
    const { handler, issueSessionCookieHeader } = buildHandler();
    const cookie = await issueSessionCookieHeader("owner-1");
    const created = await request(
      handler,
      "POST",
      "/organization",
      { name: "Acme", slug: "acme" },
      { cookie },
    );
    const record = (await created.json()) as { id: string };

    const inviteRes = await request(
      handler,
      "POST",
      `/organization/${record.id}/invitations`,
      { email: "invitee@example.com", role: ["member"] },
      { cookie },
    );
    assert.strictEqual(inviteRes.status, 200);
    const invitation = (await inviteRes.json()) as { id: string };

    const listRes = await handler(
      new Request(`${ORIGIN}/organization/${record.id}/invitations`, { headers: { cookie } }),
    );
    assert.strictEqual(listRes.status, 200);
    const invitations = (await listRes.json()) as ReadonlyArray<unknown>;
    assert.strictEqual(invitations.length, 1);

    const cancelRes = await request(
      handler,
      "POST",
      `/organization/invitations/${invitation.id}/cancel`,
      undefined,
      { cookie },
    );
    assert.strictEqual(cancelRes.status, 204);
  });

  it("dynamic access control: create -> list -> delete a custom role over real HTTP", async () => {
    const { handler, issueSessionCookieHeader } = buildHandler({
      dynamicAccessControl: {
        enabled: true,
        maximumRolesPerOrganization: Number.POSITIVE_INFINITY,
      },
    });
    const cookie = await issueSessionCookieHeader("owner-1");
    const created = await request(
      handler,
      "POST",
      "/organization",
      { name: "Acme", slug: "acme" },
      { cookie },
    );
    const record = (await created.json()) as { id: string };

    const createRes = await request(
      handler,
      "POST",
      `/organization/${record.id}/roles`,
      { role: "billing-admin", permission: { organization: ["update"] } },
      { cookie },
    );
    assert.strictEqual(createRes.status, 200);
    const role = (await createRes.json()) as { id: string };

    const listRes = await handler(
      new Request(`${ORIGIN}/organization/${record.id}/roles`, { headers: { cookie } }),
    );
    assert.strictEqual(listRes.status, 200);
    const roles = (await listRes.json()) as ReadonlyArray<unknown>;
    assert.strictEqual(roles.length, 1);

    const deleteRes = await request(
      handler,
      "DELETE",
      `/organization/${record.id}/roles/${role.id}`,
      undefined,
      { cookie },
    );
    assert.strictEqual(deleteRes.status, 204);
  });

  it("teams: create -> add member -> setActiveTeam -> remove member over real HTTP", async () => {
    const { handler, issueSessionCookieHeader } = buildHandler({
      teams: {
        enabled: true,
        maximumTeams: Number.POSITIVE_INFINITY,
        maximumMembersPerTeam: Number.POSITIVE_INFINITY,
        allowRemovingAllTeams: true,
      },
    });
    const cookie = await issueSessionCookieHeader("owner-1");
    const created = await request(
      handler,
      "POST",
      "/organization",
      { name: "Acme", slug: "acme" },
      { cookie },
    );
    const record = (await created.json()) as { id: string };

    const teamRes = await request(
      handler,
      "POST",
      `/organization/${record.id}/teams`,
      { name: "Engineering" },
      { cookie },
    );
    assert.strictEqual(teamRes.status, 200);
    const team = (await teamRes.json()) as { id: string };

    const addRes = await request(
      handler,
      "POST",
      `/organization/${record.id}/teams/${team.id}/members`,
      { userId: "owner-1" },
      { cookie },
    );
    assert.strictEqual(addRes.status, 200);

    const membersRes = await handler(
      new Request(`${ORIGIN}/organization/${record.id}/teams/${team.id}/members`, {
        headers: { cookie },
      }),
    );
    assert.strictEqual(membersRes.status, 200);
    const members = (await membersRes.json()) as ReadonlyArray<unknown>;
    assert.strictEqual(members.length, 1);

    const setActiveTeamRes = await request(
      handler,
      "POST",
      "/organization/active-team",
      { teamId: team.id },
      { cookie },
    );
    assert.strictEqual(setActiveTeamRes.status, 200);
    const activeBody = (await setActiveTeamRes.json()) as { activeTeamId: string | null };
    assert.strictEqual(activeBody.activeTeamId, team.id);

    const removeRes = await request(
      handler,
      "DELETE",
      `/organization/${record.id}/teams/${team.id}/members/owner-1`,
      undefined,
      { cookie },
    );
    assert.strictEqual(removeRes.status, 204);
  });

  it.effect("serves generated OpenAPI JSON including the organization group", () =>
    Effect.gen(function* () {
      const { handler } = buildHandler();
      const openapi = yield* Effect.promise(() => handler(new Request(`${ORIGIN}/openapi.json`)));
      assert.strictEqual(openapi.status, 200);
      const spec = (yield* Effect.promise(() => openapi.json())) as {
        paths: Record<string, unknown>;
      };
      assert.isTrue("/organization" in spec.paths);
      const docs = yield* Effect.promise(() => handler(new Request(`${ORIGIN}/docs`)));
      assert.strictEqual(docs.status, 200);
    }),
  );
});

/**
 * `runPluginContractTests` against the real `Organization` plugin — manifest
 * legality, group ids, every `organization_*` table's prefix, and migration
 * determinism. Mirrors `packages/admin/test/AuthHttp.test.ts`'s own use of
 * this same harness.
 */
const vitestFramework: TestAuth.TestFramework = {
  describe: (name, body) => describe(name, body),
  it: (name, body) => it(name, body),
  fail: (message) => {
    throw new Error(message);
  },
};

TestAuth.runPluginContractTests(vitestFramework, () => Organization.Organization, {
  options: [{}],
});
