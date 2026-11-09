// spec.md. The `organization` group exercised over a real `HttpRouter`/
// `HttpRouter.toWebHandler` — real HTTP requests/responses, real status
// codes, a real session cookie — mirroring `@awthaq/admin`'s own
// `AuthHttp.test.ts`.
import { Auth, Sessions, Users } from "@awthaq/core";
import { TestAuth, type UserAgent } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as MembershipRecords from "../src/MembershipRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as OrganizationApi from "../src/OrganizationApi.ts";

const ORIGIN = "http://localhost:3000";

const buildHandler = (configOverrides: Partial<Organization.OrganizationConfigShape> = {}) => {
  const app = TestAuth.app(
    TestAuth.layer(Auth.make([Organization.Organization]), {
      services: Organization.config(configOverrides),
      openapiPath: "/openapi.json",
      docsPath: "/docs",
    }),
    { baseUrl: ORIGIN },
  );
  const { handler } = app;

  /**
   * A browser holding a real session of `userId`, issued against the same running `Sessions` instance and
   * received as the `Set-Cookie` the server would have answered.
   */
  const signInAs = async (userId: string) => {
    const setCookie = await app.run(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const issued = yield* sessions.issue({ userId: Users.UserId(userId) });
        return yield* TestAuth.sessionSetCookie(issued);
      }),
    );
    const browser = await app.agent();
    browser.cookies.receive(setCookie);
    return browser;
  };

  /** Runs `effect` against the same running records the handler uses (e.g. to seed a member the HTTP surface gives no direct route for). */
  const withServices = <A, E>(
    effect: Effect.Effect<A, E, MembershipRecords.MembershipRecords>,
  ): Promise<A> => app.run(effect);

  return { handler, signInAs, withServices };
};

/**
 * A JSON request from `browser`, which sends its own cookies and echoes its CSRF cookie on an unsafe
 * method (`OrganizationGroup` carries `.middleware(Api.CsrfProtection)`).
 */
const request = (
  browser: UserAgent.UserAgent,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> => browser.request(method, path, body === undefined ? {} : { json: body });

describe("AuthHttp + Organization (real HTTP)", () => {
  it.effect("full create -> get -> update -> delete over real HTTP", () =>
    Effect.gen(function* () {
      const { signInAs } = buildHandler();
      const browser = yield* Effect.promise(() => signInAs("owner-1"));

      const created = yield* Effect.promise(() =>
        request(browser, "POST", "/organization", { name: "Acme", slug: "acme" }),
      );
      assert.strictEqual(created.status, 200);
      const record = Schema.decodeUnknownSync(OrganizationApi.OrganizationDto)(
        yield* Effect.promise(() => created.json()),
      );
      assert.strictEqual(record.slug, "acme");

      const fetched = yield* Effect.promise(() =>
        browser.request("GET", `/organization/${record.id}`),
      );
      assert.strictEqual(fetched.status, 200);

      const updated = yield* Effect.promise(() =>
        request(browser, "PATCH", `/organization/${record.id}`, { name: "Acme Inc" }),
      );
      assert.strictEqual(updated.status, 200);
      const updatedBody = Schema.decodeUnknownSync(OrganizationApi.OrganizationDto)(
        yield* Effect.promise(() => updated.json()),
      );
      assert.strictEqual(updatedBody.name, "Acme Inc");

      const deleted = yield* Effect.promise(() =>
        request(browser, "DELETE", `/organization/${record.id}`, undefined),
      );
      assert.strictEqual(deleted.status, 204);

      const goneAfterDelete = yield* Effect.promise(() =>
        browser.request("GET", `/organization/${record.id}`),
      );
      assert.strictEqual(goneAfterDelete.status, 404);
    }),
  );

  it("create answers 409 for a slug collision", async () => {
    const { signInAs } = buildHandler();
    const browser = await signInAs("owner-1");
    await request(browser, "POST", "/organization", { name: "Acme", slug: "acme" });
    const collision = await request(browser, "POST", "/organization", {
      name: "Acme 2",
      slug: "acme",
    });
    assert.strictEqual(collision.status, 409);
  });

  it("a member without the statement still gets 403, not 404", async () => {
    const { signInAs, withServices } = buildHandler();
    const owner = await signInAs("owner-1");
    const joiner = await signInAs("member-1");
    const created = await request(owner, "POST", "/organization", { name: "Acme", slug: "acme" });
    const record = Schema.decodeUnknownSync(OrganizationApi.OrganizationDto)(await created.json());
    await withServices(
      MembershipRecords.MembershipRecords.use((members) =>
        members.create({
          organizationId: record.id,
          userId: Users.UserId("member-1"),
          role: ["member"],
        }),
      ),
    );

    // Removing another (plain) member needs member:delete, which a member lacks.
    await withServices(
      MembershipRecords.MembershipRecords.use((members) =>
        members.create({
          organizationId: record.id,
          userId: Users.UserId("member-2"),
          role: ["member"],
        }),
      ),
    );
    const denied = await request(
      joiner,
      "DELETE",
      `/organization/${record.id}/members/member-2`,
      undefined,
    );
    assert.strictEqual(denied.status, 403);
  });

  // MTI-008: organization metadata is member-only.
  it("GET /organization/:id answers a non-member 404 and a member the DTO", async () => {
    const { signInAs } = buildHandler();
    const owner = await signInAs("owner-1");
    const stranger = await signInAs("outsider-1");
    const created = await request(owner, "POST", "/organization", {
      name: "Acme",
      slug: "acme",
      metadata: '{"secret":true}',
    });
    const record = Schema.decodeUnknownSync(OrganizationApi.OrganizationDto)(await created.json());

    const outsider = await stranger.request("GET", `/organization/${record.id}`);
    assert.strictEqual(outsider.status, 404);
    const member = await owner.request("GET", `/organization/${record.id}`);
    assert.strictEqual(member.status, 200);
  });

  it("removeMember answers 409 (OwnerInvariantViolation) for the last owner", async () => {
    const { signInAs } = buildHandler();
    const browser = await signInAs("owner-1");
    const created = await request(browser, "POST", "/organization", { name: "Acme", slug: "acme" });
    const record = Schema.decodeUnknownSync(OrganizationApi.OrganizationDto)(await created.json());

    const removed = await request(
      browser,
      "DELETE",
      `/organization/${record.id}/members/owner-1`,
      undefined,
    );
    assert.strictEqual(removed.status, 409);
  });

  it("listMembers answers the members of an organization over real HTTP", async () => {
    const { signInAs } = buildHandler();
    const browser = await signInAs("owner-1");
    const created = await request(browser, "POST", "/organization", { name: "Acme", slug: "acme" });
    const record = Schema.decodeUnknownSync(OrganizationApi.OrganizationDto)(await created.json());

    const members = await browser.request("GET", `/organization/${record.id}/members`);
    assert.strictEqual(members.status, 200);
    const rows = Schema.decodeUnknownSync(Schema.Array(OrganizationApi.MembershipDto))(
      await members.json(),
    );
    assert.strictEqual(rows.length, 1);
  });

  it("setActive/getActive round-trip over real HTTP", async () => {
    const { signInAs } = buildHandler();
    const browser = await signInAs("owner-1");
    const created = await request(browser, "POST", "/organization", { name: "Acme", slug: "acme" });
    const record = Schema.decodeUnknownSync(OrganizationApi.OrganizationDto)(await created.json());

    const set = await request(browser, "POST", "/organization/active", {
      organizationId: record.id,
    });
    assert.strictEqual(set.status, 200);

    const active = await browser.request("GET", `/organization/active`);
    assert.strictEqual(active.status, 200);
    const activeBody = Schema.decodeUnknownSync(OrganizationApi.ActiveContextDto)(
      await active.json(),
    );
    assert.strictEqual(activeBody.activeOrganizationId, record.id);

    const activeMember = await browser.request("GET", `/organization/active-member`);
    assert.strictEqual(activeMember.status, 200);
  });

  it("invite -> list -> cancel over real HTTP", async () => {
    // The full invite-then-accept round trip (a real `Users` record backing
    // the accepting caller's email) is covered at the domain level in
    // `Organization.test.ts` — this wire-level test exercises the HTTP
    // surface for invite/list/cancel, which don't need a real `Users` row.
    const { signInAs } = buildHandler();
    const browser = await signInAs("owner-1");
    const created = await request(browser, "POST", "/organization", { name: "Acme", slug: "acme" });
    const record = Schema.decodeUnknownSync(OrganizationApi.OrganizationDto)(await created.json());

    const inviteRes = await request(browser, "POST", `/organization/${record.id}/invitations`, {
      email: "invitee@example.com",
      role: ["member"],
    });
    assert.strictEqual(inviteRes.status, 200);
    const invitationJson: unknown = await inviteRes.json();
    // MTI-010: neither the emailed token nor its hash ever appears on the wire (checked on the raw body,
    // since decoding through the contract would strip an unknown field).
    assert.notProperty(invitationJson, "tokenHash");
    assert.notProperty(invitationJson, "token");
    const invitation = Schema.decodeUnknownSync(OrganizationApi.InvitationDto)(invitationJson);

    const listRes = await browser.request("GET", `/organization/${record.id}/invitations`);
    assert.strictEqual(listRes.status, 200);
    const invitations = Schema.decodeUnknownSync(Schema.Array(OrganizationApi.InvitationDto))(
      await listRes.json(),
    );
    assert.strictEqual(invitations.length, 1);

    const cancelRes = await request(
      browser,
      "POST",
      `/organization/invitations/${invitation.id}/cancel`,
      undefined,
    );
    assert.strictEqual(cancelRes.status, 204);
  });

  it("dynamic access control: create -> list -> delete a custom role over real HTTP", async () => {
    const { signInAs } = buildHandler({
      dynamicAccessControl: {
        enabled: true,
        maximumRolesPerOrganization: Number.POSITIVE_INFINITY,
      },
    });
    const browser = await signInAs("owner-1");
    const created = await request(browser, "POST", "/organization", { name: "Acme", slug: "acme" });
    const record = Schema.decodeUnknownSync(OrganizationApi.OrganizationDto)(await created.json());

    const createRes = await request(browser, "POST", `/organization/${record.id}/roles`, {
      role: "billing-admin",
      permission: { organization: ["update"] },
    });
    assert.strictEqual(createRes.status, 200);
    const role = Schema.decodeUnknownSync(OrganizationApi.OrgRoleDto)(await createRes.json());

    const listRes = await browser.request("GET", `/organization/${record.id}/roles`);
    assert.strictEqual(listRes.status, 200);
    const roles = Schema.decodeUnknownSync(Schema.Array(OrganizationApi.OrgRoleDto))(
      await listRes.json(),
    );
    assert.strictEqual(roles.length, 1);

    const deleteRes = await request(
      browser,
      "DELETE",
      `/organization/${record.id}/roles/${role.id}`,
      undefined,
    );
    assert.strictEqual(deleteRes.status, 204);
  });

  it("teams: create -> add member -> setActiveTeam -> remove member over real HTTP", async () => {
    const { signInAs } = buildHandler({
      teams: {
        enabled: true,
        maximumTeams: Number.POSITIVE_INFINITY,
        maximumMembersPerTeam: Number.POSITIVE_INFINITY,
        allowRemovingAllTeams: true,
      },
    });
    const browser = await signInAs("owner-1");
    const created = await request(browser, "POST", "/organization", { name: "Acme", slug: "acme" });
    const record = Schema.decodeUnknownSync(OrganizationApi.OrganizationDto)(await created.json());

    const teamRes = await request(browser, "POST", `/organization/${record.id}/teams`, {
      name: "Engineering",
    });
    assert.strictEqual(teamRes.status, 200);
    const team = Schema.decodeUnknownSync(OrganizationApi.TeamDto)(await teamRes.json());

    const addRes = await request(
      browser,
      "POST",
      `/organization/${record.id}/teams/${team.id}/members`,
      { userId: "owner-1" },
    );
    assert.strictEqual(addRes.status, 200);

    const membersRes = await browser.request(
      "GET",
      `/organization/${record.id}/teams/${team.id}/members`,
    );
    assert.strictEqual(membersRes.status, 200);
    const members = Schema.decodeUnknownSync(Schema.Array(OrganizationApi.TeamMembershipDto))(
      await membersRes.json(),
    );
    assert.strictEqual(members.length, 1);

    const setActiveTeamRes = await request(browser, "POST", "/organization/active-team", {
      teamId: team.id,
    });
    assert.strictEqual(setActiveTeamRes.status, 200);
    const activeBody = Schema.decodeUnknownSync(OrganizationApi.ActiveContextDto)(
      await setActiveTeamRes.json(),
    );
    assert.strictEqual(activeBody.activeTeamId, team.id);

    const removeRes = await request(
      browser,
      "DELETE",
      `/organization/${record.id}/teams/${team.id}/members/owner-1`,
      undefined,
    );
    assert.strictEqual(removeRes.status, 204);
  });

  it("team roles (OHS-004): a lead manages their team over HTTP; role changes are canGrant-guarded", async () => {
    const { signInAs, withServices } = buildHandler({
      teams: {
        enabled: true,
        maximumTeams: Number.POSITIVE_INFINITY,
        maximumMembersPerTeam: Number.POSITIVE_INFINITY,
        allowRemovingAllTeams: true,
      },
    });
    const owner = await signInAs("owner-1");
    const lead = await signInAs("lead-1");
    const created = await request(owner, "POST", "/organization", { name: "Acme", slug: "acme" });
    const record = Schema.decodeUnknownSync(OrganizationApi.OrganizationDto)(await created.json());
    for (const id of ["lead-1", "worker-1"]) {
      await withServices(
        MembershipRecords.MembershipRecords.use((members) =>
          members.create({
            organizationId: record.id,
            userId: Users.UserId(id),
            role: ["member"],
          }),
        ),
      );
    }
    const base = `/organization/${record.id}/teams`;
    const eng = Schema.decodeUnknownSync(OrganizationApi.TeamDto)(
      await (await request(owner, "POST", base, { name: "Eng" })).json(),
    );
    const sales = Schema.decodeUnknownSync(OrganizationApi.TeamDto)(
      await (await request(owner, "POST", base, { name: "Sales" })).json(),
    );

    const promoted = await request(owner, "POST", `${base}/${eng.id}/members`, {
      userId: "lead-1",
      role: ["lead"],
    });
    assert.strictEqual(promoted.status, 200);
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(OrganizationApi.TeamMembershipDto)(await promoted.json()).role,
      ["lead"],
    );

    // The lead staffs their own team ...
    const added = await request(lead, "POST", `${base}/${eng.id}/members`, { userId: "worker-1" });
    assert.strictEqual(added.status, 200);
    // ... but not another one.
    const other = await request(lead, "POST", `${base}/${sales.id}/members`, {
      userId: "worker-1",
    });
    assert.strictEqual(other.status, 403);

    const rerole = await request(lead, "PATCH", `${base}/${eng.id}/members/worker-1`, {
      role: ["lead"],
    });
    assert.strictEqual(rerole.status, 200);
    const unknown = await request(lead, "PATCH", `${base}/${eng.id}/members/worker-1`, {
      role: ["nope"],
    });
    assert.strictEqual(unknown.status, 422);
    // The default lead holds only team:update, so deleting its team is still refused.
    const escalate = await request(lead, "DELETE", `${base}/${eng.id}`, undefined);
    assert.strictEqual(escalate.status, 403);
  });

  it("teams hierarchy (OHS-001): nested create, ancestors/descendants, move, cycle and has-children conflicts", async () => {
    const { signInAs } = buildHandler({
      teams: {
        enabled: true,
        maximumTeams: Number.POSITIVE_INFINITY,
        maximumMembersPerTeam: Number.POSITIVE_INFINITY,
        allowRemovingAllTeams: true,
      },
    });
    const browser = await signInAs("owner-1");
    const created = await request(browser, "POST", "/organization", { name: "Acme", slug: "acme" });
    const record = Schema.decodeUnknownSync(OrganizationApi.OrganizationDto)(await created.json());
    const base = `/organization/${record.id}/teams`;
    const makeTeam = async (name: string, parentId?: string) => {
      const res = await request(
        browser,
        "POST",
        base,
        parentId === undefined ? { name } : { name, parentId },
      );
      assert.strictEqual(res.status, 200);
      return Schema.decodeUnknownSync(OrganizationApi.TeamDto)(await res.json());
    };
    const get = (path: string, as: UserAgent.UserAgent) => as.request("GET", path);

    const eng = await makeTeam("Engineering");
    const platform = await makeTeam("Platform", eng.id);
    assert.strictEqual(platform.parentId, eng.id);

    const ancestors = await get(`${base}/${platform.id}/ancestors`, browser);
    assert.strictEqual(ancestors.status, 200);
    assert.strictEqual(
      Schema.decodeUnknownSync(Schema.Array(OrganizationApi.TeamDto))(await ancestors.json())
        .length,
      1,
    );
    const descendants = await get(`${base}/${eng.id}/descendants`, browser);
    assert.strictEqual(descendants.status, 200);
    assert.strictEqual(
      Schema.decodeUnknownSync(Schema.Array(OrganizationApi.TeamDto))(await descendants.json())
        .length,
      1,
    );

    // Under its own descendant: 409.
    const cycle = await request(browser, "PATCH", `${base}/${eng.id}/parent`, {
      parentId: platform.id,
    });
    assert.strictEqual(cycle.status, 409);

    // A parent with children cannot be deleted: 409.
    const blocked = await request(browser, "DELETE", `${base}/${eng.id}`, undefined);
    assert.strictEqual(blocked.status, 409);

    const toRoot = await request(browser, "PATCH", `${base}/${platform.id}/parent`, {
      parentId: null,
    });
    assert.strictEqual(toRoot.status, 200);
    assert.strictEqual(
      Schema.decodeUnknownSync(OrganizationApi.TeamDto)(await toRoot.json()).parentId,
      null,
    );
    const removed = await request(browser, "DELETE", `${base}/${eng.id}`, undefined);
    assert.strictEqual(removed.status, 204);

    // A non-member cannot read the hierarchy.
    const outsider = await signInAs("outsider-1");
    const hidden = await get(`${base}/${platform.id}/ancestors`, outsider);
    assert.strictEqual(hidden.status, 404);
  });

  it.effect("serves generated OpenAPI JSON including the organization group", () =>
    Effect.gen(function* () {
      const { handler } = buildHandler();
      const openapi = yield* Effect.promise(() => handler(new Request(`${ORIGIN}/openapi.json`)));
      assert.strictEqual(openapi.status, 200);
      const spec = Schema.decodeUnknownSync(
        Schema.Struct({ paths: Schema.Record(Schema.String, Schema.Unknown) }),
      )(yield* Effect.promise(() => openapi.json()));
      assert.isTrue("/organization" in spec.paths);
      const docs = yield* Effect.promise(() => handler(new Request(`${ORIGIN}/docs`)));
      assert.strictEqual(docs.status, 200);
    }),
  );
});
