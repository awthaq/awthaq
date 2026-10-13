// spec.md. The `organization` group exercised over a real `HttpRouter`/
// `HttpRouter.toWebHandler` — real HTTP requests/responses, real status
// codes, a real session cookie — mirroring `@awthaq/admin`'s own
// `AuthHttp.test.ts`.
import { Api } from "@awthaq/api";
import { Auth, Sessions, Users } from "@awthaq/core";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as MembershipRecords from "../src/MembershipRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as OrganizationApi from "../src/OrganizationApi.ts";

// `OrganizationGroup` carries `.middleware(Api.CsrfProtection)`, and this file drives real HTTP, so every mutating
// request below carries a double-submit pair minted against the harness's own `CsrfConfig` (the handler under test
// runs on the real clock, so the token is stamped now).
const CSRF_TOKEN: string = TestAuth.csrfToken(TestAuth.TestCsrfConfig.secret);

/** Appends the double-submit CSRF cookie to an existing `cookie` header value, if any. */
const withCsrfCookie = (cookie?: string): string =>
  cookie
    ? `${cookie}; ${Api.CSRF_COOKIE_NAME}=${CSRF_TOKEN}`
    : `${Api.CSRF_COOKIE_NAME}=${CSRF_TOKEN}`;

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

  /** A real session cookie against the same running `Sessions` instance. */
  const issueSessionCookieHeader = (userId: string): Promise<string> =>
    app.run(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const issued = yield* sessions.issue({ userId: Users.UserId(userId) });
        return `__Host-session=${encodeURIComponent(Redacted.value(issued.token))}`;
      }),
    );

  /** Runs `effect` against the same running records the handler uses (e.g. to seed a member the HTTP surface gives no direct route for). */
  const withServices = <A, E>(
    effect: Effect.Effect<A, E, MembershipRecords.MembershipRecords>,
  ): Promise<A> => app.run(effect);

  return { handler, issueSessionCookieHeader, withServices };
};

const UNSAFE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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
      headers: {
        "content-type": "application/json",
        ...headers,
        ...(UNSAFE_METHODS.has(method)
          ? {
              cookie: withCsrfCookie(headers?.["cookie"]),
              [Api.CSRF_HEADER_NAME]: CSRF_TOKEN,
            }
          : {}),
      },
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
      const record = Schema.decodeUnknownSync(OrganizationApi.OrganizationDto)(
        yield* Effect.promise(() => created.json()),
      );
      assert.strictEqual(record.slug, "acme");

      const fetched = yield* Effect.promise(() =>
        handler(new Request(`${ORIGIN}/organization/${record.id}`, { headers: { cookie } })),
      );
      assert.strictEqual(fetched.status, 200);

      const updated = yield* Effect.promise(() =>
        request(handler, "PATCH", `/organization/${record.id}`, { name: "Acme Inc" }, { cookie }),
      );
      assert.strictEqual(updated.status, 200);
      const updatedBody = Schema.decodeUnknownSync(OrganizationApi.OrganizationDto)(
        yield* Effect.promise(() => updated.json()),
      );
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

  // MTI-009 (BEH-EA-147): a non-member's denial is a 404, never a 403 — it must
  // not reveal that the organization exists.
  it("update answers 404 for a non-member", async () => {
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
    const record = Schema.decodeUnknownSync(OrganizationApi.OrganizationDto)(await created.json());

    const denied = await request(
      handler,
      "PATCH",
      `/organization/${record.id}`,
      { name: "x" },
      { cookie: outsiderCookie },
    );
    assert.strictEqual(denied.status, 404);
  });

  // MTI-009: every /organization/:organizationId/* endpoint answers a
  // non-member byte-identically for an existing and a non-existent id.
  it("a non-member gets the same 404 for an existing organization as for a random id", async () => {
    const { handler, issueSessionCookieHeader } = buildHandler({
      teams: {
        enabled: true,
        maximumTeams: Number.POSITIVE_INFINITY,
        maximumMembersPerTeam: Number.POSITIVE_INFINITY,
        allowRemovingAllTeams: false,
      },
    });
    const ownerCookie = await issueSessionCookieHeader("owner-1");
    const outsiderCookie = await issueSessionCookieHeader("outsider-1");
    const created = await request(
      handler,
      "POST",
      "/organization",
      { name: "Acme", slug: "acme" },
      { cookie: ownerCookie },
    );
    const record = Schema.decodeUnknownSync(OrganizationApi.OrganizationDto)(await created.json());

    const probes: ReadonlyArray<{ method: string; path: (id: string) => string; body?: unknown }> =
      [
        { method: "GET", path: (id) => `/organization/${id}` },
        { method: "GET", path: (id) => `/organization/${id}/full` },
        { method: "GET", path: (id) => `/organization/${id}/members` },
        { method: "PATCH", path: (id) => `/organization/${id}`, body: { name: "x" } },
        { method: "DELETE", path: (id) => `/organization/${id}` },
        { method: "DELETE", path: (id) => `/organization/${id}/members/owner-1` },
        { method: "GET", path: (id) => `/organization/${id}/invitations` },
        {
          method: "POST",
          path: (id) => `/organization/${id}/invitations`,
          body: { email: "x@example.com", role: ["member"] },
        },
        { method: "GET", path: (id) => `/organization/${id}/teams` },
        // PV-300: `leave` and the caller-scoped team reads used to answer a different 404 body
        // (or 200 []) for an existing organization than for an unknown id.
        { method: "POST", path: (id) => `/organization/${id}/leave` },
        { method: "GET", path: (id) => `/organization/${id}/teams/mine` },
        { method: "GET", path: (id) => `/organization/${id}/teams/some-team/members` },
      ];
    for (const probe of probes) {
      const existing = await request(handler, probe.method, probe.path(record.id), probe.body, {
        cookie: outsiderCookie,
      });
      const missing = await request(handler, probe.method, probe.path("no-such-org"), probe.body, {
        cookie: outsiderCookie,
      });
      assert.strictEqual(existing.status, 404, `${probe.method} ${probe.path(record.id)}`);
      assert.strictEqual(missing.status, 404);
      assert.strictEqual(await existing.text(), await missing.text());
    }
  });

  // PV-300: with teams disabled (the default) the feature gate used to run before the membership
  // gate, so an outsider got 403 TeamsDisabled for an existing organization and 404 for an unknown one.
  it("a non-member gets the same 404 from team endpoints whether or not teams are enabled", async () => {
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
    const record = Schema.decodeUnknownSync(OrganizationApi.OrganizationDto)(await created.json());
    const probes: ReadonlyArray<{ method: string; path: (id: string) => string; body?: unknown }> =
      [
        { method: "GET", path: (id) => `/organization/${id}/teams` },
        { method: "GET", path: (id) => `/organization/${id}/teams/mine` },
        { method: "POST", path: (id) => `/organization/${id}/teams`, body: { name: "x" } },
      ];
    for (const probe of probes) {
      const existing = await request(handler, probe.method, probe.path(record.id), probe.body, {
        cookie: outsiderCookie,
      });
      const missing = await request(handler, probe.method, probe.path("no-such-org"), probe.body, {
        cookie: outsiderCookie,
      });
      assert.strictEqual(existing.status, 404, `${probe.method} ${probe.path(record.id)}`);
      assert.strictEqual(await existing.text(), await missing.text());
    }
  });

  it("a member without the statement still gets 403, not 404", async () => {
    const { handler, issueSessionCookieHeader, withServices } = buildHandler();
    const ownerCookie = await issueSessionCookieHeader("owner-1");
    const memberCookie = await issueSessionCookieHeader("member-1");
    const created = await request(
      handler,
      "POST",
      "/organization",
      { name: "Acme", slug: "acme" },
      { cookie: ownerCookie },
    );
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
      handler,
      "DELETE",
      `/organization/${record.id}/members/member-2`,
      undefined,
      { cookie: memberCookie },
    );
    assert.strictEqual(denied.status, 403);
  });

  // MTI-008: organization metadata is member-only.
  it("GET /organization/:id answers a non-member 404 and a member the DTO", async () => {
    const { handler, issueSessionCookieHeader } = buildHandler();
    const ownerCookie = await issueSessionCookieHeader("owner-1");
    const outsiderCookie = await issueSessionCookieHeader("outsider-1");
    const created = await request(
      handler,
      "POST",
      "/organization",
      { name: "Acme", slug: "acme", metadata: '{"secret":true}' },
      { cookie: ownerCookie },
    );
    const record = Schema.decodeUnknownSync(OrganizationApi.OrganizationDto)(await created.json());

    const outsider = await handler(
      new Request(`${ORIGIN}/organization/${record.id}`, { headers: { cookie: outsiderCookie } }),
    );
    assert.strictEqual(outsider.status, 404);
    const member = await handler(
      new Request(`${ORIGIN}/organization/${record.id}`, { headers: { cookie: ownerCookie } }),
    );
    assert.strictEqual(member.status, 200);
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
    const record = Schema.decodeUnknownSync(OrganizationApi.OrganizationDto)(await created.json());

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
    const record = Schema.decodeUnknownSync(OrganizationApi.OrganizationDto)(await created.json());

    const members = await handler(
      new Request(`${ORIGIN}/organization/${record.id}/members`, { headers: { cookie } }),
    );
    assert.strictEqual(members.status, 200);
    const rows = Schema.decodeUnknownSync(Schema.Array(OrganizationApi.MembershipDto))(
      await members.json(),
    );
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
    const record = Schema.decodeUnknownSync(OrganizationApi.OrganizationDto)(await created.json());

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
    const activeBody = Schema.decodeUnknownSync(OrganizationApi.ActiveContextDto)(
      await active.json(),
    );
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
    const record = Schema.decodeUnknownSync(OrganizationApi.OrganizationDto)(await created.json());

    const inviteRes = await request(
      handler,
      "POST",
      `/organization/${record.id}/invitations`,
      { email: "invitee@example.com", role: ["member"] },
      { cookie },
    );
    assert.strictEqual(inviteRes.status, 200);
    const invitationJson: unknown = await inviteRes.json();
    // MTI-010: neither the emailed token nor its hash ever appears on the wire (checked on the raw body,
    // since decoding through the contract would strip an unknown field).
    assert.notProperty(invitationJson, "tokenHash");
    assert.notProperty(invitationJson, "token");
    const invitation = Schema.decodeUnknownSync(OrganizationApi.InvitationDto)(invitationJson);

    const listRes = await handler(
      new Request(`${ORIGIN}/organization/${record.id}/invitations`, { headers: { cookie } }),
    );
    assert.strictEqual(listRes.status, 200);
    const invitations = Schema.decodeUnknownSync(Schema.Array(OrganizationApi.InvitationDto))(
      await listRes.json(),
    );
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
    const record = Schema.decodeUnknownSync(OrganizationApi.OrganizationDto)(await created.json());

    const createRes = await request(
      handler,
      "POST",
      `/organization/${record.id}/roles`,
      { role: "billing-admin", permission: { organization: ["update"] } },
      { cookie },
    );
    assert.strictEqual(createRes.status, 200);
    const role = Schema.decodeUnknownSync(OrganizationApi.OrgRoleDto)(await createRes.json());

    const listRes = await handler(
      new Request(`${ORIGIN}/organization/${record.id}/roles`, { headers: { cookie } }),
    );
    assert.strictEqual(listRes.status, 200);
    const roles = Schema.decodeUnknownSync(Schema.Array(OrganizationApi.OrgRoleDto))(
      await listRes.json(),
    );
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
    const record = Schema.decodeUnknownSync(OrganizationApi.OrganizationDto)(await created.json());

    const teamRes = await request(
      handler,
      "POST",
      `/organization/${record.id}/teams`,
      { name: "Engineering" },
      { cookie },
    );
    assert.strictEqual(teamRes.status, 200);
    const team = Schema.decodeUnknownSync(OrganizationApi.TeamDto)(await teamRes.json());

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
    const members = Schema.decodeUnknownSync(Schema.Array(OrganizationApi.TeamMembershipDto))(
      await membersRes.json(),
    );
    assert.strictEqual(members.length, 1);

    const setActiveTeamRes = await request(
      handler,
      "POST",
      "/organization/active-team",
      { teamId: team.id },
      { cookie },
    );
    assert.strictEqual(setActiveTeamRes.status, 200);
    const activeBody = Schema.decodeUnknownSync(OrganizationApi.ActiveContextDto)(
      await setActiveTeamRes.json(),
    );
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

  it("team roles (OHS-004): a lead manages their team over HTTP; role changes are canGrant-guarded", async () => {
    const { handler, issueSessionCookieHeader, withServices } = buildHandler({
      teams: {
        enabled: true,
        maximumTeams: Number.POSITIVE_INFINITY,
        maximumMembersPerTeam: Number.POSITIVE_INFINITY,
        allowRemovingAllTeams: true,
      },
    });
    const ownerCookie = await issueSessionCookieHeader("owner-1");
    const leadCookie = await issueSessionCookieHeader("lead-1");
    const created = await request(
      handler,
      "POST",
      "/organization",
      { name: "Acme", slug: "acme" },
      { cookie: ownerCookie },
    );
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
      await (await request(handler, "POST", base, { name: "Eng" }, { cookie: ownerCookie })).json(),
    );
    const sales = Schema.decodeUnknownSync(OrganizationApi.TeamDto)(
      await (
        await request(handler, "POST", base, { name: "Sales" }, { cookie: ownerCookie })
      ).json(),
    );

    const promoted = await request(
      handler,
      "POST",
      `${base}/${eng.id}/members`,
      { userId: "lead-1", role: ["lead"] },
      { cookie: ownerCookie },
    );
    assert.strictEqual(promoted.status, 200);
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(OrganizationApi.TeamMembershipDto)(await promoted.json()).role,
      ["lead"],
    );

    // The lead staffs their own team ...
    const added = await request(
      handler,
      "POST",
      `${base}/${eng.id}/members`,
      { userId: "worker-1" },
      { cookie: leadCookie },
    );
    assert.strictEqual(added.status, 200);
    // ... but not another one.
    const other = await request(
      handler,
      "POST",
      `${base}/${sales.id}/members`,
      { userId: "worker-1" },
      { cookie: leadCookie },
    );
    assert.strictEqual(other.status, 403);

    const rerole = await request(
      handler,
      "PATCH",
      `${base}/${eng.id}/members/worker-1`,
      { role: ["lead"] },
      { cookie: leadCookie },
    );
    assert.strictEqual(rerole.status, 200);
    const unknown = await request(
      handler,
      "PATCH",
      `${base}/${eng.id}/members/worker-1`,
      { role: ["nope"] },
      { cookie: leadCookie },
    );
    assert.strictEqual(unknown.status, 422);
    // The default lead holds only team:update, so deleting its team is still refused.
    const escalate = await request(handler, "DELETE", `${base}/${eng.id}`, undefined, {
      cookie: leadCookie,
    });
    assert.strictEqual(escalate.status, 403);
  });

  it("teams hierarchy (OHS-001): nested create, ancestors/descendants, move, cycle and has-children conflicts", async () => {
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
    const record = Schema.decodeUnknownSync(OrganizationApi.OrganizationDto)(await created.json());
    const base = `/organization/${record.id}/teams`;
    const makeTeam = async (name: string, parentId?: string) => {
      const res = await request(
        handler,
        "POST",
        base,
        parentId === undefined ? { name } : { name, parentId },
        { cookie },
      );
      assert.strictEqual(res.status, 200);
      return Schema.decodeUnknownSync(OrganizationApi.TeamDto)(await res.json());
    };
    const get = async (path: string, headers: Record<string, string>) =>
      handler(new Request(`${ORIGIN}${path}`, { headers }));

    const eng = await makeTeam("Engineering");
    const platform = await makeTeam("Platform", eng.id);
    assert.strictEqual(platform.parentId, eng.id);

    const ancestors = await get(`${base}/${platform.id}/ancestors`, { cookie });
    assert.strictEqual(ancestors.status, 200);
    assert.strictEqual(
      Schema.decodeUnknownSync(Schema.Array(OrganizationApi.TeamDto))(await ancestors.json())
        .length,
      1,
    );
    const descendants = await get(`${base}/${eng.id}/descendants`, { cookie });
    assert.strictEqual(descendants.status, 200);
    assert.strictEqual(
      Schema.decodeUnknownSync(Schema.Array(OrganizationApi.TeamDto))(await descendants.json())
        .length,
      1,
    );

    // Under its own descendant: 409.
    const cycle = await request(
      handler,
      "PATCH",
      `${base}/${eng.id}/parent`,
      { parentId: platform.id },
      { cookie },
    );
    assert.strictEqual(cycle.status, 409);

    // A parent with children cannot be deleted: 409.
    const blocked = await request(handler, "DELETE", `${base}/${eng.id}`, undefined, { cookie });
    assert.strictEqual(blocked.status, 409);

    const toRoot = await request(
      handler,
      "PATCH",
      `${base}/${platform.id}/parent`,
      { parentId: null },
      { cookie },
    );
    assert.strictEqual(toRoot.status, 200);
    assert.strictEqual(
      Schema.decodeUnknownSync(OrganizationApi.TeamDto)(await toRoot.json()).parentId,
      null,
    );
    const removed = await request(handler, "DELETE", `${base}/${eng.id}`, undefined, { cookie });
    assert.strictEqual(removed.status, 204);

    // A non-member cannot read the hierarchy.
    const outsider = await issueSessionCookieHeader("outsider-1");
    const hidden = await get(`${base}/${platform.id}/ancestors`, { cookie: outsider });
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
