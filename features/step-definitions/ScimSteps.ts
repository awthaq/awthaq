// BDD-005/P20a: steps for 30-scim.feature. A When makes its request as a connection's bearer
// token holder over real HTTP; a Given arranges either through the same HTTP surface (so a
// Given cannot pass by a route the scenario then fails to exercise) or, for what only an
// operator can do (creating a connection, an administrator's ban, live sessions, a team made
// by hand), directly against the services the handler runs on. A Then reads the response, or
// the services, for what HTTP cannot show.
import { AuditLog, Sessions, Users } from "@awthaq/core";
import { MembershipRecords, OrganizationRecords, TeamRecords } from "@awthaq/organization";
import { ScimApi, ScimConnections, ScimRecords } from "@awthaq/scim";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import {
  configureApp,
  lastResponse,
  seedConnection,
  send,
  sendAs,
  withContext,
  World,
} from "./ScimWorld.ts";
import { letForkedFibersRun } from "./shared/Harness.ts";
import { isRecord, objectOf, type Snapshot } from "./shared/WireJson.ts";

const USERS = "/scim/v2/Users";
const GROUPS = "/scim/v2/Groups";

const splitList = (list: string) =>
  list
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

const expectStatus = (response: Snapshot, expected: number) =>
  assert.equal(response.status, expected, `expected ${expected}, got ${response.status} ${response.text}`);

const stringOf = (record: Readonly<Record<string, unknown>>, key: string) => {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`expected "${key}" to be a string in ${JSON.stringify(record)}`);
  return value;
};

/** Only the SCIM events the feature names may be looked up in the audit log (a type guard, not a cast). */
const SCIM_EVENT_TAGS = [
  "auth.scim.userProvisioned",
  "auth.scim.userDeactivated",
  "auth.scim.userReactivated",
  "auth.scim.userDeleted",
  "auth.scim.groupChanged",
] as const;
const isScimEventTag = (tag: string): tag is (typeof SCIM_EVENT_TAGS)[number] =>
  SCIM_EVENT_TAGS.some((known) => known === tag);

const isUserStatus = (status: string): status is "active" | "suspended" =>
  status === "active" || status === "suspended";

const patchBody = (operations: ReadonlyArray<Readonly<Record<string, unknown>>>) => ({
  schemas: [ScimApi.PATCH_SCHEMA],
  Operations: operations,
});

// ---- helpers over the World -----------------------------------------------------------------

const userId = Effect.fn("features.scim.userId")(function* (name: string) {
  const world = yield* World;
  return yield* world.userIds.get(name);
});

/** POSTs a user as `connection`, registering the resulting id under `name` (kept from the first provisioning). */
const provision = Effect.fn("features.scim.provision")(function* (
  connection: string,
  name: string,
  extra: Readonly<Record<string, unknown>> = {},
  contentType?: string,
) {
  const world = yield* World;
  const response = yield* sendAs(connection, {
    method: "POST",
    path: USERS,
    body: { userName: name, ...extra },
    contentType,
  });
  if (response.status === 201 || response.status === 200) {
    const id = stringOf(objectOf(response), "id");
    if (!world.firstIds.has(`user:${name}`)) world.firstIds.set(`user:${name}`, id);
    yield* world.userIds.set(name, id);
  }
  return response;
});

const provisionGroup = Effect.fn("features.scim.provisionGroup")(function* (
  connection: string,
  name: string,
  extra: Readonly<Record<string, unknown>> = {},
) {
  const world = yield* World;
  const state = yield* world.connections.get(connection);
  const members = yield* Effect.forEach(
    splitList(typeof extra["members"] === "string" ? extra["members"] : ""),
    (member) => userId(member),
  );
  const { members: _names, ...rest } = extra;
  const response = yield* sendAs(connection, {
    method: "POST",
    path: GROUPS,
    body: {
      displayName: name,
      ...rest,
      ...(members.length === 0 ? {} : { members: members.map((value) => ({ value })) }),
    },
  });
  if (response.status === 201 || response.status === 200) {
    const id = stringOf(objectOf(response), "id");
    if (!world.firstIds.has(`group:${name}`)) world.firstIds.set(`group:${name}`, id);
    yield* world.groupIds.set(name, id);
    world.groupOrgs.set(name, state.organizationId);
  }
  return response;
});

const patchUser = Effect.fn("features.scim.patchUser")(function* (
  connection: string,
  name: string,
  operations: ReadonlyArray<Readonly<Record<string, unknown>>>,
) {
  return yield* sendAs(connection, {
    method: "PATCH",
    path: `${USERS}/${yield* userId(name)}`,
    body: patchBody(operations),
    contentType: "application/json",
  });
});

const setActive = (connection: string, name: string, active: boolean) =>
  patchUser(connection, name, [{ op: "replace", path: "active", value: active }]);

const patchGroup = Effect.fn("features.scim.patchGroup")(function* (
  connection: string,
  name: string,
  operations: ReadonlyArray<Readonly<Record<string, unknown>>>,
) {
  const world = yield* World;
  const response = yield* sendAs(connection, {
    method: "PATCH",
    path: `${GROUPS}/${yield* world.groupIds.get(name)}`,
    body: patchBody(operations),
  });
  yield* renameFromResponse(response, name);
  return response;
});

/** After a PUT/PATCH renames a group, the scenario refers to it by its new name. */
const renameFromResponse = Effect.fn("features.scim.renameFromResponse")(function* (
  response: Snapshot,
  previousName: string,
) {
  if (response.status !== 200) return;
  const world = yield* World;
  const body = objectOf(response);
  const renamed = stringOf(body, "displayName");
  yield* world.groupIds.set(renamed, stringOf(body, "id"));
  const organizationId = world.groupOrgs.get(previousName);
  if (organizationId !== undefined) world.groupOrgs.set(renamed, organizationId);
});

const memberValues = Effect.fn("features.scim.memberValues")(function* (names: string) {
  const ids = yield* Effect.forEach(splitList(names), (name) => userId(name));
  return ids.map((value) => ({ value }));
});

const listUsers = (connection: string, query = "", observe = false) =>
  sendAs(connection, { method: "GET", path: `${USERS}${query}` }, { observe });

const idOfResponse = (response: Snapshot) => stringOf(objectOf(response), "id");

const auditRecords = Effect.fn("features.scim.auditRecords")(function* (tag: string) {
  if (!isScimEventTag(tag)) throw new Error(`"${tag}" is not one of the SCIM events`);
  yield* letForkedFibersRun;
  return yield* withContext(
    Effect.flatMap(AuditLog.AuditLog, (log) => log.list({ eventTag: tag })).pipe(Effect.orDie),
  );
});

const payloadOf = (payload: unknown) => {
  if (!isRecord(payload)) throw new Error("expected the event payload to be an object");
  return payload;
};

const teamOf = Effect.fn("features.scim.teamOf")(function* (name: string) {
  const world = yield* World;
  const teamId = yield* world.groupIds.get(name);
  const organizationId = world.groupOrgs.get(name);
  if (organizationId === undefined) throw new Error(`no organization is known for group "${name}"`);
  return { teamId, organizationId };
});

/** Which credential a Given/When scenario Outline row means (an exact literal, never a substring guess). */
const CREDENTIALS = {
  "no credential": undefined,
  "a token without the scim_ prefix": "not-a-scim-token",
  "a well-formed scim_ token no connection holds": `scim_${"0".repeat(64)}`,
  "an empty bearer token": "",
} as const;
const isCredentialKey = (key: string): key is keyof typeof CREDENTIALS =>
  Object.hasOwn(CREDENTIALS, key);

export const scimSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- configuration (must precede the first connection) -------------------------------------

  Given("the SCIM plugin is configured with deleteBehavior {string}", function* (behavior: string) {
    if (behavior !== "erase" && behavior !== "deactivate") {
      throw new Error(`deleteBehavior must be "erase" or "deactivate", got "${behavior}"`);
    }
    yield* configureApp({ scim: { deleteBehavior: behavior } });
  });

  Given("the SCIM plugin is configured with maxResults {int}", function* (maxResults: number) {
    yield* configureApp({ scim: { maxResults } });
  });

  Given("the organization allows at most {int} members", function* (membershipLimit: number) {
    yield* configureApp({ organization: { membershipLimit } });
  });

  Given("a beforeDelete hook that vetoes every user deletion", function* () {
    yield* configureApp({ vetoDelete: true });
  });

  Given("a Users store that is unavailable when looked up by email", function* () {
    yield* configureApp({ usersOutage: true });
  });

  // ---- connections -----------------------------------------------------------------------------

  Given(
    "an organization {string} with the SCIM connection {string}",
    function* (organization: string, connection: string) {
      yield* seedConnection(connection, organization);
    },
  );

  Given("the connection {string} is revoked", function* (name: string) {
    const world = yield* World;
    const connection = yield* world.connections.get(name);
    yield* withContext(
      Effect.flatMap(ScimConnections.ScimConnectionStore, (store) =>
        store.revoke(connection.organizationId, connection.identity.id),
      ).pipe(Effect.orDie),
    );
  });

  Given("the organization of {string} is suspended", function* (name: string) {
    const world = yield* World;
    const connection = yield* world.connections.get(name);
    yield* withContext(
      Effect.gen(function* () {
        const organizations = yield* OrganizationRecords.OrganizationRecords;
        yield* organizations.setSuspended(connection.organizationId, Option.some(yield* DateTime.now));
      }).pipe(Effect.orDie),
    );
  });

  When("the organization of {string} is reinstated", function* (name: string) {
    const world = yield* World;
    const connection = yield* world.connections.get(name);
    yield* withContext(
      Effect.gen(function* () {
        const organizations = yield* OrganizationRecords.OrganizationRecords;
        yield* organizations.setSuspended(connection.organizationId, Option.none());
      }).pipe(Effect.orDie),
    );
  });

  // ---- accounts that exist independently of any directory --------------------------------------

  Given(
    "a user {string} who signed up independently of any directory",
    function* (email: string) {
      const world = yield* World;
      const id = yield* withContext(
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const user = yield* users
            .create({ identity: { _tag: "Email", email }, name: email })
            .pipe(Effect.orDie);
          return user.id;
        }),
      );
      yield* world.userIds.set(email, id);
    },
  );

  Given("a signed-in user {string}", function* (name: string) {
    const world = yield* World;
    const cookie = yield* withContext(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const user = yield* users
          .create({ identity: { _tag: "Email", email: `${name}@example.com` }, name })
          .pipe(Effect.orDie);
        const issued = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
        return `${Sessions.SESSION_COOKIE_NAME}=${encodeURIComponent(Redacted.value(issued.token))}`;
      }),
    );
    yield* world.cookies.set(name, cookie);
  });

  Given("the user {string} has {int} live sessions", function* (name: string, count: number) {
    const world = yield* World;
    const id = yield* userId(name);
    const tokens = yield* withContext(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const issued = [];
        for (let i = 0; i < count; i++) {
          issued.push((yield* sessions.issue({ userId: Users.UserId(id) }).pipe(Effect.orDie)).token);
        }
        return issued;
      }),
    );
    world.sessions.set(name, tokens);
  });

  Given(
    "an administrator has suspended the user {string} with the reason {string}",
    function* (name: string, reason: string) {
      const id = yield* userId(name);
      yield* withContext(
        Effect.flatMap(Users.Users, (users) =>
          users.setStatus(Users.UserId(id), "suspended", { reason }),
        ).pipe(Effect.orDie),
      );
    },
  );

  // ---- provisioning (Givens go through the same HTTP surface as the Whens) ---------------------

  Given(
    "{string} has provisioned the user {string}",
    function* (connection: string, name: string) {
      expectStatus(yield* provision(connection, name), 201);
    },
  );

  Given(
    "{string} has provisioned the user {string} with externalId {string}",
    function* (connection: string, name: string, externalId: string) {
      expectStatus(yield* provision(connection, name, { externalId }), 201);
    },
  );

  Given(
    "{string} has provisioned the users {string}",
    function* (connection: string, names: string) {
      for (const name of splitList(names)) expectStatus(yield* provision(connection, name), 201);
    },
  );

  Given(
    "{string} has provisioned the group {string}",
    function* (connection: string, name: string) {
      expectStatus(yield* provisionGroup(connection, name), 201);
    },
  );

  Given(
    "{string} has provisioned the group {string} with externalId {string}",
    function* (connection: string, name: string, externalId: string) {
      expectStatus(yield* provisionGroup(connection, name, { externalId }), 201);
    },
  );

  Given(
    "{string} has provisioned the group {string} with the members {string}",
    function* (connection: string, name: string, members: string) {
      expectStatus(yield* provisionGroup(connection, name, { members }), 201);
    },
  );

  Given("{string} has deactivated the user {string}", function* (connection: string, name: string) {
    expectStatus(yield* setActive(connection, name, false), 200);
  });

  Given("{string} has deleted the user {string}", function* (connection: string, name: string) {
    expectStatus(
      yield* sendAs(connection, { method: "DELETE", path: `${USERS}/${yield* userId(name)}` }),
      204,
    );
  });

  Given(
    "a team {string} that an organization admin created in the organization of {string}",
    function* (name: string, connectionName: string) {
      const world = yield* World;
      const connection = yield* world.connections.get(connectionName);
      const teamId = yield* withContext(
        Effect.flatMap(TeamRecords.TeamRecords, (teams) =>
          teams.createTeam({ organizationId: connection.organizationId, name }),
        ).pipe(Effect.orDie, Effect.map((team) => team.id)),
      );
      yield* world.groupIds.set(name, teamId);
      world.groupOrgs.set(name, connection.organizationId);
    },
  );

  Given(
    "{string} was added to the team behind the group {string} by an organization admin",
    function* (email: string, group: string) {
      const world = yield* World;
      const { teamId } = yield* teamOf(group);
      const id = yield* withContext(
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const teams = yield* TeamRecords.TeamRecords;
          const user = yield* users
            .create({ identity: { _tag: "Email", email }, name: email })
            .pipe(Effect.orDie);
          yield* teams.addTeamMember({ teamId, userId: user.id }).pipe(Effect.orDie);
          return user.id;
        }),
      );
      yield* world.userIds.set(email, id);
    },
  );

  Given(
    "a child team {string} of the team behind the group {string}",
    function* (name: string, group: string) {
      const { teamId, organizationId } = yield* teamOf(group);
      yield* withContext(
        Effect.flatMap(TeamRecords.TeamRecords, (teams) =>
          teams.createTeam({ organizationId, name, parentId: teamId }),
        ).pipe(Effect.orDie),
      );
    },
  );

  Given(
    "the team behind the group {string} is removed by an organization admin",
    function* (group: string) {
      const { teamId, organizationId } = yield* teamOf(group);
      yield* withContext(
        Effect.flatMap(TeamRecords.TeamRecords, (teams) =>
          teams.removeTeam(organizationId, teamId),
        ).pipe(Effect.orDie),
      );
    },
  );

  // ---- authentication ----------------------------------------------------------------------------

  When("a request presents {string}", function* (credential: string) {
    if (!isCredentialKey(credential)) throw new Error(`unknown credential "${credential}"`);
    yield* send({ method: "GET", path: USERS, bearer: CREDENTIALS[credential] });
  });

  When(
    "{string} requests the user list with only her session cookie",
    function* (name: string) {
      const world = yield* World;
      yield* send({ method: "GET", path: USERS, cookie: yield* world.cookies.get(name) });
    },
  );

  When("an unauthenticated request reads the {string} discovery document", function* (document: string) {
    yield* send({ method: "GET", path: `/scim/v2/${document}` });
  });

  When("{string} reads the {string} discovery document", function* (connection: string, document: string) {
    yield* sendAs(connection, { method: "GET", path: `/scim/v2/${document}` });
  });

  // ---- users -----------------------------------------------------------------------------------

  When("{string} lists users", function* (connection: string) {
    yield* listUsers(connection);
  });

  When(
    "{string} lists users with startIndex {int} and count {int}",
    function* (connection: string, startIndex: number, count: number) {
      const world = yield* World;
      world.pages.push(yield* listUsers(connection, `?startIndex=${startIndex}&count=${count}`));
    },
  );

  When(
    "{string} lists {word} with the filter {string}",
    function* (connection: string, resource: string, filter: string) {
      if (resource !== "users" && resource !== "groups") throw new Error(`unknown resource "${resource}"`);
      yield* sendAs(connection, {
        method: "GET",
        path: `${resource === "users" ? USERS : GROUPS}?filter=${encodeURIComponent(filter)}`,
      });
    },
  );

  When("{string} provisions the user {string}", function* (connection: string, name: string) {
    yield* provision(connection, name);
  });

  When(
    "{string} provisions the user {string} with the primary email {string}",
    function* (connection: string, name: string, email: string) {
      yield* provision(connection, name, { emails: [{ value: email, primary: true }] });
    },
  );

  When(
    "{string} provisions the user {string} with externalId {string}",
    function* (connection: string, name: string, externalId: string) {
      yield* provision(connection, name, { externalId });
    },
  );

  When(
    "{string} provisions the user {string} with active false",
    function* (connection: string, name: string) {
      yield* provision(connection, name, { active: false });
    },
  );

  When(
    "{string} provisions the user {string} sending the content type {string}",
    function* (connection: string, name: string, contentType: string) {
      yield* provision(connection, name, {}, contentType);
    },
  );

  When("{string} reads the user {string}", function* (connection: string, name: string) {
    yield* sendAs(connection, { method: "GET", path: `${USERS}/${yield* userId(name)}` });
  });

  When("{string} reads the user with the id {string}", function* (connection: string, id: string) {
    yield* sendAs(connection, { method: "GET", path: `${USERS}/${id}` });
  });

  When("{string} replaces the user {string}", function* (connection: string, name: string) {
    yield* sendAs(connection, {
      method: "PUT",
      path: `${USERS}/${yield* userId(name)}`,
      body: { userName: name },
    });
  });

  When(
    "{string} replaces the user {string} sending userName {string}",
    function* (connection: string, name: string, userName: string) {
      yield* sendAs(connection, {
        method: "PUT",
        path: `${USERS}/${yield* userId(name)}`,
        body: { userName },
      });
    },
  );

  When(
    "{string} replaces the user {string} with displayName {string}, externalId {string} and active false",
    function* (connection: string, name: string, displayName: string, externalId: string) {
      yield* sendAs(connection, {
        method: "PUT",
        path: `${USERS}/${yield* userId(name)}`,
        body: { userName: name, displayName, externalId, active: false },
      });
    },
  );

  When(
    "{string} replaces the user {string} without an externalId",
    function* (connection: string, name: string) {
      yield* sendAs(connection, {
        method: "PUT",
        path: `${USERS}/${yield* userId(name)}`,
        body: { userName: name },
      });
    },
  );

  When(
    "{string} PUTs a new userName {string} for the user {string}",
    function* (connection: string, userName: string, name: string) {
      yield* sendAs(connection, {
        method: "PUT",
        path: `${USERS}/${yield* userId(name)}`,
        body: { userName },
      });
    },
  );

  When(
    "{string} PATCHes a new userName {string} for the user {string}",
    function* (connection: string, userName: string, name: string) {
      yield* patchUser(connection, name, [{ op: "replace", path: "userName", value: userName }]);
    },
  );

  When(
    "{string} patches the user {string} with op {string} on path {string} to {string}",
    function* (connection: string, name: string, op: string, path: string, value: string) {
      yield* patchUser(connection, name, [{ op, path, value }]);
    },
  );

  When(
    "{string} patches the user {string} with op {string} on path {string}",
    function* (connection: string, name: string, op: string, path: string) {
      yield* patchUser(connection, name, [{ op, path }]);
    },
  );

  When(
    "{string} patches the user {string} with op {string} on path {string} to the boolean {word}",
    function* (connection: string, name: string, op: string, path: string, value: string) {
      if (value !== "true" && value !== "false") throw new Error(`expected true or false, got ${value}`);
      yield* patchUser(connection, name, [{ op, path, value: value === "true" }]);
    },
  );

  When(
    "{string} patches the user {string} with op {string} on path {string} to the string {string}",
    function* (connection: string, name: string, op: string, path: string, value: string) {
      yield* patchUser(connection, name, [{ op, path, value }]);
    },
  );

  When(
    "{string} patches the user {string} with the path-less op {string} of displayName {string} and title {string}",
    function* (
      connection: string,
      name: string,
      op: string,
      displayName: string,
      title: string,
    ) {
      yield* patchUser(connection, name, [{ op, value: { displayName, title } }]);
    },
  );

  When("{string} deactivates the user {string}", function* (connection: string, name: string) {
    yield* setActive(connection, name, false);
  });

  When("{string} reactivates the user {string}", function* (connection: string, name: string) {
    yield* setActive(connection, name, true);
  });

  When("{string} deletes the user {string}", function* (connection: string, name: string) {
    yield* sendAs(connection, { method: "DELETE", path: `${USERS}/${yield* userId(name)}` });
  });

  // ---- groups ----------------------------------------------------------------------------------

  When("{string} creates the group {string}", function* (connection: string, name: string) {
    yield* provisionGroup(connection, name);
  });

  When(
    "{string} creates the group {string} with externalId {string}",
    function* (connection: string, name: string, externalId: string) {
      yield* provisionGroup(connection, name, { externalId });
    },
  );

  When(
    "{string} creates the group {string} with the members {string}",
    function* (connection: string, name: string, members: string) {
      yield* provisionGroup(connection, name, { members });
    },
  );

  When("{string} reads the group {string}", function* (connection: string, name: string) {
    const world = yield* World;
    yield* sendAs(connection, { method: "GET", path: `${GROUPS}/${yield* world.groupIds.get(name)}` });
  });

  When("{string} deletes the group {string}", function* (connection: string, name: string) {
    const world = yield* World;
    yield* sendAs(connection, { method: "DELETE", path: `${GROUPS}/${yield* world.groupIds.get(name)}` });
  });

  When(
    "{string} replaces the group {string} with displayName {string} and the members {string}",
    function* (connection: string, name: string, displayName: string, members: string) {
      const world = yield* World;
      const response = yield* sendAs(connection, {
        method: "PUT",
        path: `${GROUPS}/${yield* world.groupIds.get(name)}`,
        body: { displayName, members: yield* memberValues(members) },
      });
      yield* renameFromResponse(response, name);
    },
  );

  When(
    "{string} patches the group {string} adding the members {string}",
    function* (connection: string, name: string, members: string) {
      yield* patchGroup(connection, name, [
        { op: "Add", path: "members", value: yield* memberValues(members) },
      ]);
    },
  );

  When(
    "{string} patches the group {string} removing the member {string}",
    function* (connection: string, name: string, member: string) {
      yield* patchGroup(connection, name, [
        { op: "remove", path: `members[value eq "${yield* userId(member)}"]` },
      ]);
    },
  );

  When(
    "{string} patches the group {string} replacing the members with {string} and renaming it to {string}",
    function* (connection: string, name: string, members: string, displayName: string) {
      yield* patchGroup(connection, name, [
        { op: "replace", path: "members", value: yield* memberValues(members) },
        { op: "replace", path: "displayName", value: displayName },
      ]);
    },
  );

  When(
    "{string} patches the group {string} renaming it to {string}",
    function* (connection: string, name: string, displayName: string) {
      yield* patchGroup(connection, name, [{ op: "replace", path: "displayName", value: displayName }]);
    },
  );

  // ---- Then: the response -------------------------------------------------------------------------

  Then("the response is {int}", function* (status: number) {
    expectStatus(yield* lastResponse, status);
  });

  Then("the response content type is {string}", function* (contentType: string) {
    const response = yield* lastResponse;
    assert.ok(
      (response.headers.get("content-type") ?? "").startsWith(contentType),
      `expected ${contentType}, got ${response.headers.get("content-type")}`,
    );
  });

  Then("the response is indistinguishable from an unauthenticated request's", function* () {
    const refused = yield* lastResponse;
    const baseline = yield* send({ method: "GET", path: USERS }, { observe: true });
    assert.equal(baseline.status, 401, "the unauthenticated baseline must itself be a 401");
    assert.equal(refused.status, baseline.status);
    assert.equal(refused.headers.get("content-type"), baseline.headers.get("content-type"));
    assert.equal(refused.text, baseline.text, "the refused body must not distinguish the reason");
  });

  Then("the error body has scimType {string}", function* (scimType: string) {
    const response = yield* lastResponse;
    assert.equal(objectOf(response)["scimType"], scimType, response.text);
  });

  Then(
    "the error body has status {string} and the RFC 7644 error schema",
    function* (status: string) {
      const response = yield* lastResponse;
      const body = objectOf(response);
      assert.equal(body["status"], status, response.text);
      assert.deepEqual(body["schemas"], [ScimApi.ERROR_SCHEMA]);
    },
  );

  Then("the error body has a detail", function* () {
    const body = objectOf(yield* lastResponse);
    assert.equal(typeof body["detail"], "string");
    assert.notEqual(body["detail"], "");
  });

  Then(
    "the error body does not mention {string} or {string}",
    function* (first: string, second: string) {
      const response = yield* lastResponse;
      assert.equal(response.text.includes(first), false, response.text);
      assert.equal(response.text.includes(second), false, response.text);
    },
  );

  // ---- Then: connections and their tokens ----------------------------------------------------------

  Then(
    'the token of {string} is "scim_" followed by 64 hexadecimal characters',
    function* (name: string) {
      const world = yield* World;
      assert.match((yield* world.connections.get(name)).token, /^scim_[0-9a-f]{64}$/);
    },
  );

  Then("the tokens of {string} and {string} differ", function* (first: string, second: string) {
    const world = yield* World;
    assert.notEqual(
      (yield* world.connections.get(first)).token,
      (yield* world.connections.get(second)).token,
    );
  });

  Then(
    "the stored record of {string} holds the SHA-256 of its token and not the token itself",
    function* (name: string) {
      const world = yield* World;
      const connection = yield* world.connections.get(name);
      const stored = yield* withContext(
        Effect.flatMap(ScimRecords.ScimRecords, (records) =>
          records.listConnections(connection.organizationId),
        ).pipe(Effect.orDie),
      );
      const row = stored.find((candidate) => candidate.id === connection.identity.id);
      assert.notEqual(row, undefined, "the connection must have a stored record");
      const expected = createHash("sha256").update(connection.token).digest("hex");
      assert.equal(row?.tokenHash, expected, "the stored value must be the token's SHA-256");
      assert.equal(JSON.stringify(row).includes(connection.token), false);
    },
  );

  // ---- Then: what the connection sees --------------------------------------------------------------

  Then(
    "as seen by {string}, {int} users are listed",
    function* (connection: string, count: number) {
      const response = yield* listUsers(connection, "", true);
      expectStatus(response, 200);
      const body = objectOf(response);
      assert.equal(body["totalResults"], count, response.text);
      assert.equal(Array.isArray(body["Resources"]) ? body["Resources"].length : -1, count);
    },
  );

  Then(
    "as seen by {string}, {int} groups are listed",
    function* (connection: string, count: number) {
      const response = yield* sendAs(connection, { method: "GET", path: GROUPS }, { observe: true });
      expectStatus(response, 200);
      const body = objectOf(response);
      assert.equal(body["totalResults"], count, response.text);
      assert.equal(Array.isArray(body["Resources"]) ? body["Resources"].length : -1, count);
    },
  );

  Then(
    "the list reports totalResults {int}, startIndex {int}, itemsPerPage {int} and {int} resources",
    function* (total: number, startIndex: number, perPage: number, resources: number) {
      const response = yield* lastResponse;
      expectStatus(response, 200);
      const body = objectOf(response);
      assert.deepEqual(body["schemas"], [ScimApi.LIST_SCHEMA]);
      assert.equal(body["totalResults"], total, response.text);
      assert.equal(body["startIndex"], startIndex, response.text);
      assert.equal(body["itemsPerPage"], perPage, response.text);
      assert.equal(Array.isArray(body["Resources"]) ? body["Resources"].length : -1, resources);
    },
  );

  const resourceNames = (response: Snapshot) => {
    const resources = objectOf(response)["Resources"];
    if (!Array.isArray(resources)) throw new Error("expected a Resources array");
    return resources.map((resource) => {
      if (!isRecord(resource)) throw new Error("expected every resource to be an object");
      return typeof resource["userName"] === "string"
        ? resource["userName"]
        : stringOf(resource, "displayName");
    });
  };

  // Listing is oldest-first by creation time and ties (two users created in one millisecond)
  // fall back to the id, so a scenario that names several resources compares them as a set.
  Then("the list resources are {string}", function* (expected: string) {
    assert.deepEqual(resourceNames(yield* lastResponse).sort(), splitList(expected).sort());
  });

  Then(
    "the pages listed so far together hold exactly {string}, each once",
    function* (expected: string) {
      const world = yield* World;
      const names = world.pages.flatMap((page) => resourceNames(page));
      assert.deepEqual(names.sort(), splitList(expected).sort());
    },
  );

  // ---- Then: the resource -------------------------------------------------------------------------

  Then("the resource reports active {word}", function* (active: string) {
    const response = yield* lastResponse;
    assert.equal(objectOf(response)["active"], active === "true", response.text);
  });

  Then("the resource has displayName {string}", function* (displayName: string) {
    const response = yield* lastResponse;
    assert.equal(objectOf(response)["displayName"], displayName, response.text);
  });

  Then("the resource has externalId {string}", function* (externalId: string) {
    const response = yield* lastResponse;
    assert.equal(objectOf(response)["externalId"], externalId, response.text);
  });

  Then("the resource has no externalId", function* () {
    const response = yield* lastResponse;
    assert.equal(objectOf(response)["externalId"], undefined, response.text);
  });

  Then("the response names the user it provisioned the first time", function* () {
    const world = yield* World;
    const name = yield* world.userIds.current;
    assert.equal(idOfResponse(yield* lastResponse), world.firstIds.get(`user:${name}`));
  });

  Then("the response names a new user", function* () {
    const world = yield* World;
    const name = yield* world.userIds.current;
    assert.notEqual(idOfResponse(yield* lastResponse), world.firstIds.get(`user:${name}`));
  });

  Then("the response names the group it provisioned the first time", function* () {
    const world = yield* World;
    const name = yield* world.groupIds.current;
    assert.equal(idOfResponse(yield* lastResponse), world.firstIds.get(`group:${name}`));
  });

  Then("the response names a new group", function* () {
    const world = yield* World;
    const name = yield* world.groupIds.current;
    assert.notEqual(idOfResponse(yield* lastResponse), world.firstIds.get(`group:${name}`));
  });

  // ---- Then: the account behind a user resource --------------------------------------------------

  const readUser = Effect.fn("features.scim.readUser")(function* (name: string) {
    const id = yield* userId(name);
    return yield* withContext(
      Effect.flatMap(Users.Users, (users) => users.findById(Users.UserId(id))).pipe(Effect.orDie),
    );
  });

  Then(
    "the user {string} has an {string} identity with the address {string}",
    function* (name: string, tag: string, address: string) {
      const user = yield* readUser(name);
      assert.equal(user.identity._tag, tag);
      assert.deepEqual(Users.emailOf(user), Option.some(address));
    },
  );

  Then("the user {string} has an {string} identity", function* (name: string, tag: string) {
    assert.equal((yield* readUser(name)).identity._tag, tag);
  });

  Then("the user {string} has no email address", function* (name: string) {
    assert.deepEqual(Users.emailOf(yield* readUser(name)), Option.none());
  });

  Then("the user {string} still has the status {string}", function* (name: string, status: string) {
    if (!isUserStatus(status)) throw new Error(`unknown status "${status}"`);
    assert.equal((yield* readUser(name)).status, status);
  });

  Then(
    "the user {string} is suspended with the reason marker of {string}",
    function* (name: string, connectionName: string) {
      const world = yield* World;
      const connection = yield* world.connections.get(connectionName);
      const user = yield* readUser(name);
      assert.equal(user.status, "suspended");
      assert.equal(Option.getOrNull(user.statusReason), `scim:${connection.identity.id}`);
    },
  );

  Then("no user {string} exists", function* (email: string) {
    const found = yield* withContext(
      Effect.flatMap(Users.Users, (users) => users.findByEmail(email)).pipe(Effect.orDie),
    );
    assert.equal(Option.isNone(found), true, `a user ${email} exists`);
  });

  Then("the user {string} cannot sign in", function* (name: string) {
    const user = yield* readUser(name);
    const refusal = yield* withContext(Users.assertCanSignIn(user).pipe(Effect.flip));
    assert.equal(refusal._tag, "UserSuspended");
  });

  Then(
    "the user {string} is a member of the organization of {string}",
    function* (name: string, connectionName: string) {
      const world = yield* World;
      const connection = yield* world.connections.get(connectionName);
      const id = yield* userId(name);
      const membership = yield* withContext(
        Effect.flatMap(MembershipRecords.MembershipRecords, (members) =>
          members.findByUserAndOrg(Users.UserId(id), connection.organizationId),
        ),
      );
      assert.equal(Option.isSome(membership), true);
    },
  );

  Then(
    "the user {string} is not a member of the organization of {string}",
    function* (name: string, connectionName: string) {
      const world = yield* World;
      const connection = yield* world.connections.get(connectionName);
      const id = yield* userId(name);
      const membership = yield* withContext(
        Effect.flatMap(MembershipRecords.MembershipRecords, (members) =>
          members.findByUserAndOrg(Users.UserId(id), connection.organizationId),
        ),
      );
      assert.equal(Option.isNone(membership), true);
    },
  );

  Then("none of the live sessions of {string} is accepted any more", function* (name: string) {
    const world = yield* World;
    const tokens = world.sessions.get(name);
    assert.ok(tokens !== undefined && tokens.length > 0, `"${name}" has no live sessions to check`);
    for (const token of tokens) {
      const refusal = yield* withContext(
        Effect.flatMap(Sessions.Sessions, (sessions) => sessions.verify(token)).pipe(Effect.flip),
      );
      assert.equal(refusal._tag, "Sessions/NotFound");
    }
  });

  // ---- Then: groups as teams -----------------------------------------------------------------------

  Then(
    "the team behind the group {string} has exactly the members {string}",
    function* (group: string, members: string) {
      const { teamId } = yield* teamOf(group);
      const expected = yield* Effect.forEach(splitList(members), (name) => userId(name));
      const rows = yield* withContext(
        Effect.flatMap(TeamRecords.TeamRecords, (teams) => teams.listTeamMembers(teamId)),
      );
      assert.deepEqual(rows.map((row) => String(row.userId)).sort(), [...expected].sort());
    },
  );

  Then(
    "the team {string} still exists in the organization of {string}",
    function* (name: string, connectionName: string) {
      const world = yield* World;
      const connection = yield* world.connections.get(connectionName);
      const teamId = yield* world.groupIds.get(name);
      const team = yield* withContext(
        Effect.flatMap(TeamRecords.TeamRecords, (teams) =>
          teams.findTeamById(connection.organizationId, teamId),
        ),
      );
      assert.equal(Option.isSome(team), true, `the team "${name}" is gone`);
    },
  );

  Then(
    "no team {string} exists in the organization of {string}",
    function* (name: string, connectionName: string) {
      const world = yield* World;
      const connection = yield* world.connections.get(connectionName);
      const teamId = yield* world.groupIds.get(name);
      const team = yield* withContext(
        Effect.flatMap(TeamRecords.TeamRecords, (teams) =>
          teams.findTeamById(connection.organizationId, teamId),
        ),
      );
      assert.equal(Option.isNone(team), true, `the team "${name}" still exists`);
    },
  );

  // ---- Then: discovery -----------------------------------------------------------------------------

  Then("the ServiceProviderConfig reports patch supported and filter supported", function* () {
    const body = objectOf(yield* lastResponse);
    assert.deepEqual(body["schemas"], [ScimApi.SERVICE_PROVIDER_CONFIG_SCHEMA]);
    assert.deepEqual(body["patch"], { supported: true });
    assert.ok(isRecord(body["filter"]) && body["filter"]["supported"] === true);
  });

  Then(
    "the ServiceProviderConfig reports bulk, sort, etag and change password not supported",
    function* () {
      const body = objectOf(yield* lastResponse);
      for (const key of ["bulk", "sort", "etag", "changePassword"]) {
        const section = body[key];
        assert.ok(isRecord(section) && section["supported"] === false, `${key} must report supported: false`);
      }
    },
  );

  Then(
    "the ServiceProviderConfig reports a filter maximum of {int} results",
    function* (maxResults: number) {
      const body = objectOf(yield* lastResponse);
      assert.ok(isRecord(body["filter"]));
      assert.equal(body["filter"]["maxResults"], maxResults);
    },
  );

  // ---- Then: the audit log --------------------------------------------------------------------------

  Then(
    "the audit log records {int} {string} events",
    function* (count: number, tag: string) {
      assert.equal((yield* auditRecords(tag)).length, count);
    },
  );

  Then(
    "the latest {string} event names the connection {string}, its organization and the user {string}",
    function* (tag: string, connectionName: string, name: string) {
      const world = yield* World;
      const connection = yield* world.connections.get(connectionName);
      const latest = (yield* auditRecords(tag))[0];
      assert.ok(latest !== undefined, `no ${tag} event was recorded`);
      const payload = payloadOf(latest.payload);
      assert.equal(payload["connectionId"], connection.identity.id);
      assert.equal(payload["organizationId"], connection.organizationId);
      assert.equal(payload["userId"], yield* userId(name));
    },
  );

  Then("the latest {string} event records no acting user", function* (tag: string) {
    const latest = (yield* auditRecords(tag))[0];
    assert.ok(latest !== undefined, `no ${tag} event was recorded`);
    assert.deepEqual(latest.actorUserId, Option.none());
    const payload = payloadOf(latest.payload);
    for (const key of ["actorUserId", "actorId", "actor", "performedBy"]) {
      assert.equal(key in payload, false, `the payload must not name an actor (${key})`);
    }
  });

  Then("the {string} events carry the changes {string}", function* (tag: string, changes: string) {
    // `list` is newest-first; a scenario states the changes in the order they happened.
    const recorded = [...(yield* auditRecords(tag))].reverse();
    assert.deepEqual(
      recorded.map((record) => payloadOf(record.payload)["change"]),
      splitList(changes),
    );
  });
});
