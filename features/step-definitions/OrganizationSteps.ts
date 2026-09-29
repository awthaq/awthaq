// MTI-011/P20a: steps for 35-organization.feature. Givens arrange state through the real HTTP
// surface wherever a real caller could (so a Given cannot succeed by a route the scenario
// then fails to exercise); the only direct store writes are `has joined ... as` (the trusted
// `addMember` path SCIM and imports use, which the HTTP group deliberately has no route for)
// and the observation of rows an HTTP read cannot show (the erasure/delete cascades).
import { Erasure, HookPoint } from "@awthaq/core";
import type { Mailer } from "@awthaq/ports";
import {
  InvitationRecords,
  MembershipRecords,
  OrganizationHooks,
  OrgRoleRecords,
  TeamRecords,
} from "@awthaq/organization";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import {
  configureApp,
  currentApp,
  lastResponse,
  mailTo,
  openSession,
  send,
  sendAs,
  signInUser,
  World,
} from "./OrganizationWorld.ts";
import { mailedToken } from "./MailedToken.ts";
import { letForkedFibersRun } from "./shared/Harness.ts";
import {
  isRecord,
  objectOf,
  objectsOf,
  parseJson,
  stringField,
  type Snapshot,
} from "./shared/WireJson.ts";

const NO_SUCH_ORGANIZATION = "no-such-organization";
const PLACEHOLDER = /\[(org|user|id|invitation):([^\]]+)\]/g;

const isCreatorRole = (value: string): value is "owner" | "admin" =>
  value === "owner" || value === "admin";

const splitList = (list: string) =>
  list
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

const invitationMailData = (mail: Mailer.MailMessage, key: string) => {
  const value = mail.data?.[key];
  if (typeof value !== "string") {
    throw new Error(`expected the "${mail.template}" mail to carry a string "${key}"`);
  }
  return value;
};

/** The invitation mails sent to `email` for `organizationId`, newest first. */
const invitationMails = Effect.fn("features.organization.invitationMails")(function* (
  email: string,
  organizationId: string | undefined,
) {
  const mails = yield* mailTo(email);
  return mails.filter(
    (mail) =>
      mail.template === "organization-invite" &&
      (organizationId === undefined || mail.data?.["organizationId"] === organizationId),
  );
});

const pickMail = (mails: ReadonlyArray<Mailer.MailMessage>, which: string, email: string) => {
  const picked = which === "first" ? mails[mails.length - 1] : mails[0];
  if (which !== "first" && which !== "latest") {
    throw new Error(`expected "first" or "latest", got "${which}"`);
  }
  if (picked === undefined) throw new Error(`no invitation mail was sent to ${email}`);
  return picked;
};

/** Substitutes `[org:acme]`, `[user:alice]`, `[id:team:platform]` and `[invitation:carol@example.com]` in a path or body. */
const substitute = Effect.fn("features.organization.substitute")(function* (
  template: string,
  organizationOverride?: string,
) {
  const world = yield* World;
  const matches = [...template.matchAll(PLACEHOLDER)];
  const values: Array<string> = [];
  for (const match of matches) {
    const kind = match[1];
    const key = match[2];
    if (key === undefined) throw new Error(`malformed placeholder ${match[0]}`);
    if (kind === "org") {
      values.push(organizationOverride ?? (yield* world.organizations.get(key)));
    } else if (kind === "user") {
      values.push((yield* world.users.get(key)).userId);
    } else if (kind === "id") {
      values.push(yield* world.ids.get(key));
    } else {
      const mail = pickMail(yield* invitationMails(key, undefined), "latest", key);
      values.push(invitationMailData(mail, "invitationId"));
    }
  }
  let index = 0;
  return template.replace(PLACEHOLDER, () => values[index++] ?? "");
});

const parseBody = (body: string) => (body === "-" ? undefined : parseJson(body));

const orgPath = Effect.fn("features.organization.orgPath")(function* (
  organization: string,
  rest: string,
) {
  const { organizations } = yield* World;
  return `/organization/${yield* organizations.get(organization)}${rest}`;
});

/** Sends a request as `who`, recording the template so a Then can replay it against a missing organization. */
const sendTemplate = Effect.fn("features.organization.sendTemplate")(function* (
  who: string | undefined,
  method: string,
  pathTemplate: string,
  bodyTemplate: string,
) {
  const world = yield* World;
  yield* Ref.set(world.lastTemplate, { who, method, path: pathTemplate, body: bodyTemplate });
  const path = yield* substitute(pathTemplate);
  const body = parseBody(yield* substitute(bodyTemplate));
  return who === undefined
    ? yield* send(undefined, method, path, body)
    : yield* sendAs(who, method, path, body);
});

const expectStatus = (response: Snapshot, status: number, context: string) =>
  assert.equal(
    response.status,
    status,
    `${context}: expected ${status}, got ${response.status} ${response.text}`,
  );

const membersAsSeenBy = Effect.fn("features.organization.membersAsSeenBy")(function* (
  viewer: string,
  organization: string,
) {
  const world = yield* World;
  const roster = yield* Ref.get(world.roster);
  const response = yield* sendAs(
    viewer,
    "GET",
    yield* orgPath(organization, "/members"),
    undefined,
    {
      observe: true,
    },
  );
  expectStatus(response, 200, `${viewer} listing the members of "${organization}"`);
  return objectsOf(response).map((membership) => {
    const userId = stringField(membership, "userId");
    const actor = roster.find((candidate) => candidate.userId === userId);
    const roles = membership["role"];
    if (!Array.isArray(roles)) throw new Error("expected a role array on the membership");
    return {
      name: actor?.name ?? userId,
      roles: roles.map(String).toSorted(),
    };
  });
});

const invitationsAsSeenBy = Effect.fn("features.organization.invitationsAsSeenBy")(function* (
  viewer: string,
  organization: string,
  email: string,
) {
  const response = yield* sendAs(
    viewer,
    "GET",
    yield* orgPath(organization, "/invitations"),
    undefined,
    { observe: true },
  );
  expectStatus(response, 200, `${viewer} listing the invitations of "${organization}"`);
  return objectsOf(response).filter((invitation) => stringField(invitation, "email") === email);
});

const addMemberDirectly = Effect.fn("features.organization.addMemberDirectly")(function* (
  name: string,
  organization: string,
  role: string,
) {
  const world = yield* World;
  const app = yield* currentApp;
  const actor = yield* world.users.get(name);
  const organizationId = yield* world.organizations.get(organization);
  yield* Effect.promise(() =>
    app.withContext(
      MembershipRecords.MembershipRecords.use((members) =>
        members.create({ organizationId, userId: actor.userId, role: [role] }).pipe(Effect.orDie),
      ),
    ),
  );
});

const permissionPayload = (grant: string) => {
  const [resource, action] = grant.split(":");
  if (resource === undefined || action === undefined) {
    throw new Error(`expected "resource:action", got "${grant}"`);
  }
  return { [resource]: [action] };
};

const invite = Effect.fn("features.organization.invite")(function* (
  who: string,
  email: string,
  organization: string,
  role: string,
  resend: boolean,
) {
  return yield* sendAs(who, "POST", yield* orgPath(organization, "/invitations"), {
    email,
    role: [role],
    ...(resend ? { resend: true } : {}),
  });
});

const respondToInvitation = Effect.fn("features.organization.respondToInvitation")(function* (
  who: string,
  action: "accept" | "reject",
  invitationId: string,
  token: string,
) {
  return yield* sendAs(who, "POST", `/organization/invitations/${invitationId}/${action}`, {
    token,
  });
});

export const organizationSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- configuration: rebuilds the app, so it must precede every "signed-in user" ----

  Given("the creator role is {string}", function* (role: string) {
    if (!isCreatorRole(role))
      throw new Error(`creatorRole must be "owner" or "admin", got "${role}"`);
    yield* configureApp({ config: { creatorRole: role } });
  });

  Given("nobody may create an organization", function* () {
    yield* configureApp({ config: { allowUserToCreateOrganization: () => Effect.succeed(false) } });
  });

  Given("each user may own at most {int} organization(s)", function* (limit: number) {
    yield* configureApp({ config: { organizationLimit: limit } });
  });

  Given("organization deletion is disabled", function* () {
    yield* configureApp({ config: { disableOrganizationDeletion: true } });
  });

  Given("teams are enabled", function* () {
    yield* configureApp({
      config: {
        teams: {
          enabled: true,
          maximumTeams: Number.POSITIVE_INFINITY,
          maximumMembersPerTeam: Number.POSITIVE_INFINITY,
          allowRemovingAllTeams: true,
        },
      },
    });
  });

  Given("the team limit is {int}", function* (limit: number) {
    const app = yield* Ref.get((yield* World).options);
    const teams = app.config?.teams;
    yield* configureApp({
      config: {
        teams: {
          enabled: true,
          maximumTeams: limit,
          maximumMembersPerTeam: teams?.maximumMembersPerTeam ?? Number.POSITIVE_INFINITY,
          allowRemovingAllTeams: true,
        },
      },
    });
  });

  Given("the team member limit is {int}", function* (limit: number) {
    const app = yield* Ref.get((yield* World).options);
    const teams = app.config?.teams;
    yield* configureApp({
      config: {
        teams: {
          enabled: true,
          maximumTeams: teams?.maximumTeams ?? Number.POSITIVE_INFINITY,
          maximumMembersPerTeam: limit,
          allowRemovingAllTeams: true,
        },
      },
    });
  });

  Given("dynamic access control is enabled", function* () {
    yield* configureApp({
      config: {
        dynamicAccessControl: {
          enabled: true,
          maximumRolesPerOrganization: Number.POSITIVE_INFINITY,
        },
      },
    });
  });

  Given("invitations expire after {int} ms", function* (millis: number) {
    yield* configureApp({ config: { invitationExpiresIn: Duration.millis(millis) } });
  });

  Given("the membership limit is {int}", function* (limit: number) {
    yield* configureApp({ config: { membershipLimit: limit } });
  });

  Given("the invitation limit is {int} per inviter", function* (limit: number) {
    yield* configureApp({ config: { invitationLimit: limit } });
  });

  Given("re-inviting cancels the pending invitation", function* () {
    yield* configureApp({ config: { cancelPendingInvitationsOnReInvite: true } });
  });

  Given("the application grants per-organization quotas", function* () {
    const { quotaOverrides } = yield* World;
    yield* configureApp({
      config: {
        limitsFor: (organizationId) => Effect.sync(() => quotaOverrides.get(organizationId) ?? {}),
      },
    });
  });

  Given("a hook vetoes invitations to {string}", function* (blocked: string) {
    yield* configureApp({
      hooks: OrganizationHooks.BeforeCreateInvitation.tap((input) =>
        input.email === blocked
          ? Effect.fail(new HookPoint.HookAbort({ code: "INVITATION_BLOCKED" }))
          : Effect.succeed(input),
      ),
    });
  });

  Given("a hook observer fails after every organization creation", function* () {
    yield* configureApp({
      hooks: OrganizationHooks.AfterCreateOrganization.tap(() =>
        Effect.fail("observer exploded, this must never surface"),
      ),
    });
  });

  // ---- actors and arrangement ----

  Given("a signed-in user {string}", function* (name: string) {
    yield* signInUser(name);
  });

  Given("a signed-in user {string} whose email is not verified", function* (name: string) {
    yield* signInUser(name, { verified: false });
  });

  Given("a second session {string} for {string}", function* (session: string, user: string) {
    yield* openSession(session, user);
  });

  Given("{string} has created the organization {string}", function* (who: string, slug: string) {
    const world = yield* World;
    const response = yield* sendAs(who, "POST", "/organization", { name: `Org ${slug}`, slug });
    expectStatus(response, 200, `${who} creating "${slug}"`);
    yield* world.organizations.set(slug, stringField(objectOf(response), "id"));
  });

  Given(
    "{string} has joined the organization {string} as {string}",
    function* (who: string, organization: string, role: string) {
      yield* addMemberDirectly(who, organization, role);
    },
  );

  Given(
    "{string} has created the team {string} in the organization {string}",
    function* (who: string, team: string, organization: string) {
      const world = yield* World;
      const response = yield* sendAs(who, "POST", yield* orgPath(organization, "/teams"), {
        name: team,
      });
      expectStatus(response, 200, `${who} creating the team "${team}"`);
      yield* world.ids.set(`team:${team}`, stringField(objectOf(response), "id"));
    },
  );

  Given(
    "{string} has added {string} to the team {string} of the organization {string}",
    function* (who: string, member: string, team: string, organization: string) {
      const world = yield* World;
      const teamId = yield* world.ids.get(`team:${team}`);
      const target = yield* world.users.get(member);
      const response = yield* sendAs(
        who,
        "POST",
        yield* orgPath(organization, `/teams/${teamId}/members`),
        { userId: target.userId },
      );
      expectStatus(response, 200, `${who} adding ${member} to "${team}"`);
    },
  );

  Given(
    "{string} has created the role {string} in the organization {string} granting {string}",
    function* (who: string, role: string, organization: string, grant: string) {
      const world = yield* World;
      const response = yield* sendAs(who, "POST", yield* orgPath(organization, "/roles"), {
        role,
        permission: permissionPayload(grant),
      });
      expectStatus(response, 200, `${who} creating the role "${role}"`);
      yield* world.ids.set(`role:${role}`, stringField(objectOf(response), "id"));
    },
  );

  Given(
    "{string} has invited {string} to the organization {string} as {string}",
    function* (who: string, email: string, organization: string, role: string) {
      const response = yield* invite(who, email, organization, role, false);
      expectStatus(response, 200, `${who} inviting ${email}`);
    },
  );

  Given(
    "{string} has set the active organization to {string}",
    function* (who: string, organization: string) {
      const world = yield* World;
      const response = yield* sendAs(who, "POST", "/organization/active", {
        organizationId: yield* world.organizations.get(organization),
      });
      expectStatus(response, 200, `${who} activating "${organization}"`);
    },
  );

  Given(
    "the organization {string} is on a plan with at most {int} member(s)",
    function* (organization: string, limit: number) {
      const world = yield* World;
      world.quotaOverrides.set(yield* world.organizations.get(organization), {
        membershipLimit: limit,
      });
    },
  );

  // ---- whens ----

  When("{string} creates the organization {string}", function* (who: string, slug: string) {
    const world = yield* World;
    const response = yield* sendAs(who, "POST", "/organization", { name: `Org ${slug}`, slug });
    if (response.status === 200) {
      yield* world.organizations.set(slug, stringField(objectOf(response), "id"));
    }
  });

  When(
    "{string} checks whether the slug {string} is available",
    function* (who: string, slug: string) {
      yield* sendAs(who, "GET", `/organization/check-slug?slug=${encodeURIComponent(slug)}`);
    },
  );

  When(
    "{string} sends {word} {string} with body {string}",
    function* (who: string, method: string, path: string, body: string) {
      yield* sendTemplate(who, method, path, body);
    },
  );

  When(
    "an anonymous caller sends {word} {string} with body {string}",
    function* (method: string, path: string, body: string) {
      yield* sendTemplate(undefined, method, path, body);
    },
  );

  When(
    "{string} lists the members of the organization {string}",
    function* (who: string, organization: string) {
      yield* sendAs(who, "GET", yield* orgPath(organization, "/members"));
    },
  );

  When(
    "{string} lists the invitations of the organization {string}",
    function* (who: string, organization: string) {
      yield* sendAs(who, "GET", yield* orgPath(organization, "/invitations"));
    },
  );

  When(
    "{string} removes {string} from the organization {string}",
    function* (who: string, member: string, organization: string) {
      const world = yield* World;
      const target = yield* world.users.get(member);
      yield* sendAs(who, "DELETE", yield* orgPath(organization, `/members/${target.userId}`));
    },
  );

  When("{string} leaves the organization {string}", function* (who: string, organization: string) {
    yield* sendAs(who, "POST", yield* orgPath(organization, "/leave"));
  });

  When(
    "{string} changes the roles of {string} in the organization {string} to {string}",
    function* (who: string, member: string, organization: string, roles: string) {
      const world = yield* World;
      const target = yield* world.users.get(member);
      yield* sendAs(who, "PATCH", yield* orgPath(organization, `/members/${target.userId}`), {
        role: splitList(roles),
      });
    },
  );

  When("{string} deletes the organization {string}", function* (who: string, organization: string) {
    yield* sendAs(who, "DELETE", yield* orgPath(organization, ""));
  });

  When(
    "{string} invites {string} to the organization {string} as {string}",
    function* (who: string, email: string, organization: string, role: string) {
      yield* invite(who, email, organization, role, false);
    },
  );

  When(
    "{string} invites {string} to the organization {string} as {string} asking for a resend",
    function* (who: string, email: string, organization: string, role: string) {
      yield* invite(who, email, organization, role, true);
    },
  );

  When(
    "{string} accepts the invitation to the organization {string} with the {word} token mailed to {string}",
    function* (who: string, organization: string, which: string, email: string) {
      const { organizations } = yield* World;
      const organizationId = yield* organizations.get(organization);
      const mail = pickMail(yield* invitationMails(email, organizationId), which, email);
      yield* respondToInvitation(
        who,
        "accept",
        invitationMailData(mail, "invitationId"),
        mailedToken(mail),
      );
    },
  );

  When(
    "{string} rejects the invitation to the organization {string} with the {word} token mailed to {string}",
    function* (who: string, organization: string, which: string, email: string) {
      const { organizations } = yield* World;
      const organizationId = yield* organizations.get(organization);
      const mail = pickMail(yield* invitationMails(email, organizationId), which, email);
      yield* respondToInvitation(
        who,
        "reject",
        invitationMailData(mail, "invitationId"),
        mailedToken(mail),
      );
    },
  );

  When(
    "{string} accepts the invitation to the organization {string} with the token {string}",
    function* (who: string, organization: string, token: string) {
      // The newest invitation mailed for this organization, whoever it was for.
      const world = yield* World;
      const organizationId = yield* world.organizations.get(organization);
      const app = yield* currentApp;
      const mail = (yield* app.sentMail)
        .filter(
          (candidate) =>
            candidate.template === "organization-invite" &&
            candidate.data?.["organizationId"] === organizationId,
        )
        .at(-1);
      if (mail === undefined) throw new Error(`no invitation was mailed for "${organization}"`);
      yield* respondToInvitation(who, "accept", invitationMailData(mail, "invitationId"), token);
    },
  );

  When("{string} accepts an invitation that does not exist", function* (who: string) {
    yield* respondToInvitation(who, "accept", randomUUID(), "not-a-real-token");
  });

  When(
    "{string} cancels the invitation mailed to {string}",
    function* (who: string, email: string) {
      const mail = pickMail(yield* invitationMails(email, undefined), "latest", email);
      yield* sendAs(
        who,
        "POST",
        `/organization/invitations/${invitationMailData(mail, "invitationId")}/cancel`,
      );
    },
  );

  When(
    "{string} sets the active organization to {string}",
    function* (who: string, organization: string) {
      const world = yield* World;
      yield* sendAs(who, "POST", "/organization/active", {
        organizationId: yield* world.organizations.get(organization),
      });
    },
  );

  When("{string} clears the active organization", function* (who: string) {
    yield* sendAs(who, "POST", "/organization/active", { organizationId: null });
  });

  When("{string} asks for her active organization", function* (who: string) {
    yield* sendAs(who, "GET", "/organization/active");
  });

  When("{int} ms pass", function* (millis: number) {
    yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)));
  });

  When("the account of {string} is erased", function* (name: string) {
    const world = yield* World;
    const app = yield* currentApp;
    const actor = yield* world.users.get(name);
    yield* Effect.promise(() =>
      app.withContext(
        Erasure.AccountErasure.use((erasure) => erasure.eraseAccount(actor.userId)).pipe(
          Effect.orDie,
        ),
      ),
    );
  });

  // ---- thens ----

  Then("the response is {int}", function* (status: number) {
    expectStatus(yield* lastResponse, status, "the last response");
  });

  Then("the response is a {string} error", function* (tag: string) {
    const response = yield* lastResponse;
    assert.equal(objectOf(response)["_tag"], tag, `expected a ${tag} error, got ${response.text}`);
  });

  Then(
    "the response is byte-identical to the one for an organization that does not exist",
    function* () {
      const world = yield* World;
      const actual = yield* lastResponse;
      const template = yield* Ref.get(world.lastTemplate);
      if (template === undefined) throw new Error("no templated request was sent");
      const path = yield* substitute(template.path, NO_SUCH_ORGANIZATION);
      const body = parseBody(yield* substitute(template.body, NO_SUCH_ORGANIZATION));
      const missing =
        template.who === undefined
          ? yield* send(undefined, template.method, path, body, { observe: true })
          : yield* sendAs(template.who, template.method, path, body, { observe: true });
      assert.equal(actual.status, missing.status, "status differs for an unknown organization");
      assert.equal(actual.text, missing.text, "body differs for an unknown organization");
    },
  );

  Then("the slug is reported as taken", function* () {
    assert.equal(objectOf(yield* lastResponse)["available"], false);
  });

  Then("the slug is reported as free", function* () {
    assert.equal(objectOf(yield* lastResponse)["available"], true);
  });

  Then(
    "as seen by {string}, the organization {string} has exactly the members {string}",
    function* (viewer: string, organization: string, expected: string) {
      const members = yield* membersAsSeenBy(viewer, organization);
      const actual = members.map((member) => `${member.name}:${member.roles.join("+")}`).toSorted();
      assert.deepEqual(actual, splitList(expected).toSorted());
    },
  );

  Then(
    "as seen by {string}, {string} holds the roles {string} in the organization {string}",
    function* (viewer: string, member: string, roles: string, organization: string) {
      const members = yield* membersAsSeenBy(viewer, organization);
      const found = members.find((candidate) => candidate.name === member);
      assert.ok(found, `${member} is not a member of "${organization}"`);
      assert.deepEqual(found.roles, splitList(roles).toSorted());
    },
  );

  Then(
    "{string} belongs to exactly the organizations {string}",
    function* (who: string, slugs: string) {
      const response = yield* sendAs(who, "GET", "/organization", undefined, { observe: true });
      expectStatus(response, 200, `${who} listing organizations`);
      const actual = objectsOf(response)
        .map((organization) => stringField(organization, "slug"))
        .toSorted();
      assert.deepEqual(actual, splitList(slugs).toSorted());
    },
  );

  Then(
    "the organization {string} answers 404 to {string}",
    function* (organization: string, who: string) {
      const response = yield* sendAs(who, "GET", yield* orgPath(organization, ""), undefined, {
        observe: true,
      });
      expectStatus(response, 404, `${who} reading "${organization}"`);
    },
  );

  Then(
    "no membership, invitation, team or role rows remain for the organization {string}",
    function* (organization: string) {
      const world = yield* World;
      const app = yield* currentApp;
      const organizationId = yield* world.organizations.get(organization);
      const remaining = yield* Effect.promise(() =>
        app.withContext(
          Effect.gen(function* () {
            const members = yield* MembershipRecords.MembershipRecords;
            const invitations = yield* InvitationRecords.InvitationRecords;
            const teams = yield* TeamRecords.TeamRecords;
            const roles = yield* OrgRoleRecords.OrgRoleRecords;
            return {
              memberships: (yield* members.listByOrganization(organizationId)).length,
              invitations: (yield* invitations.listByOrganization(organizationId)).length,
              teams: (yield* teams.listTeamsByOrganization(organizationId)).length,
              roles: (yield* roles.listByOrganization(organizationId)).length,
            };
          }),
        ),
      );
      assert.deepEqual(remaining, { memberships: 0, invitations: 0, teams: 0, roles: 0 });
    },
  );

  Then(
    "{string} was mailed an organization invitation carrying a token",
    function* (email: string) {
      const mails = yield* invitationMails(email, undefined);
      assert.equal(mails.length, 1, `expected exactly one invitation mail to ${email}`);
      const first = mails[0];
      assert.ok(first);
      assert.ok(mailedToken(first).length >= 32, "the mailed token should be a long random value");
    },
  );

  Then("no response so far carries that token or any token hash", function* () {
    const world = yield* World;
    const app = yield* currentApp;
    const mail = (yield* app.sentMail)
      .filter((candidate) => candidate.template === "organization-invite")
      .at(-1);
    assert.ok(mail, "no invitation mail was sent");
    const token = mailedToken(mail);
    const hash = createHash("sha256").update(token).digest("hex");
    for (const body of yield* Ref.get(world.transcript)) {
      assert.ok(!body.includes(token), "a response carried the emailed token");
      assert.ok(!body.includes(hash), "a response carried the token's hash");
      assert.ok(!/"token(Hash)?"\s*:/.test(body), "a response carried a token field");
    }
  });

  Then(
    "as seen by {string}, the newest invitation for {string} to the organization {string} is {string}",
    function* (viewer: string, email: string, organization: string, status: string) {
      const invitations = yield* invitationsAsSeenBy(viewer, organization, email);
      const newest = invitations.at(-1);
      assert.ok(newest, `no invitation for ${email}`);
      assert.equal(stringField(newest, "status"), status);
    },
  );

  Then(
    "as seen by {string}, the organization {string} has {int} pending invitation(s) for {string}",
    function* (viewer: string, organization: string, count: number, email: string) {
      const invitations = yield* invitationsAsSeenBy(viewer, organization, email);
      assert.equal(
        invitations.filter((invitation) => stringField(invitation, "status") === "pending").length,
        count,
      );
    },
  );

  Then(
    "as seen by {string}, the organization {string} has the teams {string}",
    function* (viewer: string, organization: string, names: string) {
      const response = yield* sendAs(
        viewer,
        "GET",
        yield* orgPath(organization, "/teams"),
        undefined,
        { observe: true },
      );
      expectStatus(response, 200, `${viewer} listing teams`);
      const actual = objectsOf(response)
        .map((team) => stringField(team, "name"))
        .toSorted();
      assert.deepEqual(actual, splitList(names).toSorted());
    },
  );

  Then(
    "as seen by {string}, the team {string} of the organization {string} has {int} member(s)",
    function* (viewer: string, team: string, organization: string, count: number) {
      const response = yield* sendAs(
        viewer,
        "GET",
        yield* orgPath(organization, "/teams"),
        undefined,
        { observe: true },
      );
      expectStatus(response, 200, `${viewer} listing teams`);
      const found = objectsOf(response).find(
        (candidate) => stringField(candidate, "name") === team,
      );
      assert.ok(found, `no team "${team}"`);
      assert.equal(found["memberCount"], count);
    },
  );

  Then(
    "as seen by {string}, the role {string} of the organization {string} grants exactly {string}",
    function* (viewer: string, role: string, organization: string, grants: string) {
      const response = yield* sendAs(
        viewer,
        "GET",
        yield* orgPath(organization, "/roles"),
        undefined,
        { observe: true },
      );
      expectStatus(response, 200, `${viewer} listing roles`);
      const found = objectsOf(response).find(
        (candidate) => stringField(candidate, "role") === role,
      );
      assert.ok(found, `no role "${role}"`);
      const permission = found["permission"];
      assert.ok(isRecord(permission), "expected a permission record");
      const actual = Object.entries(permission)
        .flatMap(([resource, actions]) =>
          Array.isArray(actions) ? actions.map((action) => `${resource}:${String(action)}`) : [],
        )
        .toSorted();
      assert.deepEqual(actual, splitList(grants).toSorted());
    },
  );

  Then("the active organization is {string}", function* (organization: string) {
    const world = yield* World;
    assert.equal(
      objectOf(yield* lastResponse)["activeOrganizationId"],
      yield* world.organizations.get(organization),
    );
  });

  Then("the active organization is none", function* () {
    assert.equal(objectOf(yield* lastResponse)["activeOrganizationId"], null);
  });

  Then("no mail was sent to {string}", function* (email: string) {
    yield* letForkedFibersRun;
    assert.deepEqual(yield* mailTo(email), []);
  });

  Then("the event {string} was published {int} time(s)", function* (tag: string, count: number) {
    yield* letForkedFibersRun;
    const app = yield* currentApp;
    const events = yield* app.publishedEvents;
    assert.equal(events.filter((event) => event._tag === tag).length, count);
  });

  Then("the event {string} was published once for {string}", function* (tag: string, name: string) {
    yield* letForkedFibersRun;
    const world = yield* World;
    const app = yield* currentApp;
    const user = yield* world.users.get(name);
    const events = yield* app.publishedEvents;
    // Creating an organization also announces its creator as a member, so the count is per user.
    const matching = events.filter(
      (event) => event._tag === tag && "userId" in event && event.userId === user.userId,
    );
    assert.equal(matching.length, 1, `expected one ${tag} event for ${name}`);
  });

  Then(
    "the published {string} event carries no email address and no token",
    function* (tag: string) {
      yield* letForkedFibersRun;
      const app = yield* currentApp;
      const event = (yield* app.publishedEvents).find((candidate) => candidate._tag === tag);
      assert.ok(event, `no ${tag} event was published`);
      const serialized = JSON.stringify(event);
      assert.ok(!serialized.includes("@"), `the event carries an address: ${serialized}`);
      assert.ok(!/token/i.test(serialized), `the event carries a token: ${serialized}`);
    },
  );
});
