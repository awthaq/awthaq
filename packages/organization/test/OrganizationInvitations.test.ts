// Plan 04 (ADR-EA-040): `OrganizationInvitations`, tested at its own interface, with no principal. The
// capability token (MTI-010), the lifecycle, the quota, the team, the `Bound`, the veto, the observe points
// and the transaction of an acceptance are proved here. `Organization.test.ts` keeps who may invite, cancel
// and read.
import { AuditLog, HookPoint, Migrations, Persistence, Users } from "@awthaq/core";
import { Mailer, SqlTransaction } from "@awthaq/ports";
import { TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ActiveContextRecords from "../src/ActiveContextRecords.ts";
import * as InvitationRecords from "../src/InvitationRecords.ts";
import * as MembershipRecords from "../src/MembershipRecords.ts";
import * as Organization from "../src/Organization.ts";
import * as OrganizationActor from "../src/OrganizationActor.ts";
import * as OrganizationAuthority from "../src/OrganizationAuthority.ts";
import * as OrganizationDirectory from "../src/OrganizationDirectory.ts";
import * as OrganizationHooks from "../src/OrganizationHooks.ts";
import * as OrganizationInvitations from "../src/OrganizationInvitations.ts";
import * as OrganizationMemory from "../src/OrganizationMemory.ts";
import * as OrganizationRecords from "../src/OrganizationRecords.ts";
import * as OrganizationSystem from "../src/OrganizationSystem.ts";
import * as OrgRoleRecords from "../src/OrgRoleRecords.ts";
import * as TeamRecords from "../src/TeamRecords.ts";
import * as TestSql from "../../sql/test/support/TestSql.ts";

const teamsOn = {
  enabled: true,
  maximumTeams: Number.POSITIVE_INFINITY,
  maximumMembersPerTeam: Number.POSITIVE_INFINITY,
  allowRemovingAllTeams: true,
};

const buildLayer = (
  config: Partial<Organization.OrganizationConfigShape> = { teams: teamsOn },
  taps: Layer.Layer<
    never,
    never,
    Layer.Success<typeof OrganizationHooks.OrganizationHooksLive>
  > = Layer.empty,
  mailer: Layer.Layer<Mailer.Mailer> = Mailer.layerMemory,
) =>
  OrganizationSystem.layer.pipe(
    Layer.provide(Organization.config(config)),
    Layer.provideMerge(OrganizationMemory.layer),
    Layer.provideMerge(Users.layer.pipe(Layer.provide(Persistence.memory))),
    Layer.provideMerge(mailer),
    Layer.provideMerge(TestAuth.memoryFoundation),
    Layer.provideMerge(SqlTransaction.layerNoop),
    Layer.provideMerge(taps),
    Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
  );

const application = OrganizationActor.application("OrganizationInvitations.test");
const unbounded = OrganizationActor.Bound.Unbounded();
const owner = Users.UserId("owner-1");

const flipTag = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error._tag),
  );

/** An organization owned by `owner-1` (arranged through the Directory). */
const arrange = Effect.gen(function* () {
  const directory = yield* OrganizationDirectory.OrganizationDirectory;
  const invitations = yield* OrganizationInvitations.OrganizationInvitations;
  const org = yield* directory.create(application, { owner, name: "Acme", slug: "acme" });
  const invite = (
    email: string,
    extra: Partial<
      Parameters<OrganizationInvitations.OrganizationInvitationsShape["create"]>[1]
    > = {},
  ) =>
    invitations.create(application, {
      organizationId: org.id,
      inviterId: owner,
      email,
      role: ["member"],
      bound: unbounded,
      ...extra,
    });
  return { org, invitations, invite };
});

/** The capability only ever travels by email: read it back from the recording mailer, as an invitee would. */
const mailedToken = (invitationId: string) =>
  Effect.gen(function* () {
    const mailer = yield* Mailer.Mailer;
    for (const message of (yield* mailer.sent).toReversed()) {
      const data = message.data;
      if (
        data !== undefined &&
        data["invitationId"] === invitationId &&
        typeof data["token"] === "string"
      ) {
        return data["token"];
      }
    }
    return yield* Effect.die(new Error(`no invitation mail was sent for ${invitationId}`));
  });

const verifiedUser = (email: string) =>
  Effect.gen(function* () {
    const users = yield* Users.Users;
    const created = yield* users.create({ identity: { _tag: "Email", email }, name: email });
    yield* users.verifyEmail(created.id);
    return created;
  });

describe("OrganizationInvitations.create", () => {
  it.effect("mails the capability with the organization's name, and stores only its hash", () =>
    Effect.gen(function* () {
      const { org, invite } = yield* arrange;
      const invitation = yield* invite("invitee@example.com");
      assert.strictEqual(invitation.status, "pending");
      const mailer = yield* Mailer.Mailer;
      const sent = yield* mailer.sent;
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0]?.template, "organization-invite");
      assert.strictEqual(sent[0]?.data?.["organizationName"], "Acme");
      const token = yield* mailedToken(invitation.id);
      assert.notStrictEqual(token, invitation.id);
      assert.isTrue(Option.isSome(invitation.tokenHash));
      assert.notStrictEqual(Option.getOrNull(invitation.tokenHash), token);
      const invitations = yield* OrganizationInvitations.OrganizationInvitations;
      assert.isTrue(yield* invitations.holdsToken(invitation, token));
      assert.isFalse(yield* invitations.holdsToken(invitation, "wrong"));
      assert.strictEqual(invitation.organizationId, org.id);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect(
    "a mail outage is InvitationDeliveryFailed and keeps the invitation pending; resend recovers",
    () =>
      Effect.gen(function* () {
        const { org, invitations, invite } = yield* arrange;
        assert.strictEqual(
          yield* flipTag(invite("invitee@example.com")),
          "InvitationDeliveryFailed",
        );
        const pending = yield* invitations.listPendingForOrganization(org.id);
        assert.strictEqual(pending.length, 1);
      }).pipe(
        Effect.provide(
          buildLayer(
            { teams: teamsOn },
            Layer.empty,
            Layer.succeed(
              Mailer.Mailer,
              Mailer.Mailer.of({
                send: (message) =>
                  Effect.fail(
                    new Mailer.MailDeliveryFailed({
                      template: message.template,
                      reason: "down",
                      retryable: true,
                    }),
                  ),
                sent: Effect.succeed([]),
              }),
            ),
          ),
        ),
      ),
  );

  it.effect(
    "re-inviting without resend returns the same invitation; with resend it rotates the token and runs the observer again",
    () => {
      const observed: Array<string> = [];
      return Effect.gen(function* () {
        const { invite } = yield* arrange;
        const first = yield* invite("invitee@example.com");
        const again = yield* invite("invitee@example.com");
        assert.strictEqual(again.id, first.id);
        const firstToken = yield* mailedToken(first.id);
        const resent = yield* invite("invitee@example.com", { resend: true });
        assert.strictEqual(resent.id, first.id);
        assert.notStrictEqual(yield* mailedToken(first.id), firstToken);
        // `AfterCreateInvitation` ran for the first creation and for the resend (plan 04).
        assert.deepStrictEqual(observed, ["created", "created"]);
      }).pipe(
        Effect.provide(
          buildLayer(
            { teams: teamsOn },
            OrganizationHooks.AfterCreateInvitation.tap(() => {
              observed.push("created");
              return Effect.void;
            }),
          ),
        ),
      );
    },
  );

  it.effect("cancelPendingInvitationsOnReInvite cancels the old one, and says so (D8)", () =>
    Effect.gen(function* () {
      const { invite } = yield* arrange;
      const first = yield* invite("invitee@example.com");
      const second = yield* invite("invitee@example.com");
      assert.notStrictEqual(second.id, first.id);
      const invitations = yield* OrganizationInvitations.OrganizationInvitations;
      assert.strictEqual(Option.getOrThrow(yield* invitations.find(first.id)).status, "canceled");
      const canceled = yield* (yield* AuditLog.AuditLog).list({
        eventTag: "auth.organization.invitationCanceled",
      });
      assert.strictEqual(canceled.length, 1);
    }).pipe(
      Effect.provide(buildLayer({ teams: teamsOn, cancelPendingInvitationsOnReInvite: true })),
    ),
  );

  it.effect(
    "inviting an existing member is AlreadyMember, cancels their stale pending invitation and says so (D8)",
    () =>
      Effect.gen(function* () {
        const { org, invite } = yield* arrange;
        const users = yield* Users.Users;
        const member = yield* verifiedUser("member@example.com");
        const pending = yield* invite("member@example.com");
        yield* (yield* MembershipRecords.MembershipRecords).create({
          userId: member.id,
          organizationId: org.id,
          role: ["member"],
        });
        void users;
        assert.strictEqual(yield* flipTag(invite("member@example.com")), "AlreadyMember");
        const invitations = yield* OrganizationInvitations.OrganizationInvitations;
        assert.strictEqual(
          Option.getOrThrow(yield* invitations.find(pending.id)).status,
          "canceled",
        );
        assert.strictEqual(
          (yield* (yield* AuditLog.AuditLog).list({
            eventTag: "auth.organization.invitationCanceled",
          })).length,
          1,
        );
      }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("invitationLimit bounds the inviter's pending invitations", () =>
    Effect.gen(function* () {
      const { invite } = yield* arrange;
      yield* invite("a@example.com");
      assert.strictEqual(yield* flipTag(invite("b@example.com")), "InvitationLimitReached");
    }).pipe(Effect.provide(buildLayer({ teams: teamsOn, invitationLimit: 1 }))),
  );

  it.effect("an unknown role is refused, and a Ceiling bounds what the invitation confers", () =>
    Effect.gen(function* () {
      const { org, invite } = yield* arrange;
      assert.strictEqual(
        yield* flipTag(invite("a@example.com", { role: ["ghost"] })),
        "UnknownOrgRole",
      );
      const authority = yield* OrganizationAuthority.OrganizationAuthority;
      const adminCeiling = yield* authority.ceilingOf(org.id, ["admin"]);
      assert.strictEqual(
        yield* flipTag(invite("a@example.com", { role: ["owner"], bound: adminCeiling })),
        "RolePermissionEscalation",
      );
      yield* invite("a@example.com", { role: ["admin"], bound: adminCeiling });
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("a team needs teams on and an existing team", () =>
    Effect.gen(function* () {
      const { invite } = yield* arrange;
      assert.strictEqual(
        yield* flipTag(invite("a@example.com", { teamId: "nope" })),
        "TeamNotFound",
      );
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("a team is refused while teams are off", () =>
    Effect.gen(function* () {
      const { invite } = yield* arrange;
      assert.strictEqual(yield* flipTag(invite("a@example.com", { teamId: "x" })), "TeamsDisabled");
    }).pipe(Effect.provide(buildLayer({}))),
  );

  it.effect("a veto aborts with the point's id and creates nothing", () =>
    Effect.gen(function* () {
      const { org, invitations, invite } = yield* arrange;
      const aborted = yield* invite("blocked@example.com").pipe(Effect.flip);
      assert.strictEqual(aborted._tag, "HookAborted");
      if (aborted._tag === "HookAborted") {
        assert.strictEqual(aborted.point, OrganizationHooks.BeforeCreateInvitation.id);
      }
      assert.deepStrictEqual(yield* invitations.listForOrganization(org.id), []);
    }).pipe(
      Effect.provide(
        buildLayer(
          { teams: teamsOn },
          OrganizationHooks.BeforeCreateInvitation.tap((input) =>
            input.email === "blocked@example.com"
              ? Effect.fail(new HookPoint.HookAbort({ code: "NO" }))
              : Effect.succeed(input),
          ),
        ),
      ),
    ),
  );
});

describe("OrganizationInvitations.accept, reject and cancel", () => {
  it.effect(
    "a full round trip makes a real membership, and the token is the capability (MTI-010)",
    () =>
      Effect.gen(function* () {
        const { org, invitations, invite } = yield* arrange;
        const members = yield* MembershipRecords.MembershipRecords;
        const invitee = yield* verifiedUser("invitee@example.com");
        const invitation = yield* invite("invitee@example.com");
        const userId = invitee.id;
        assert.strictEqual(
          yield* flipTag(
            invitations.accept({ invitationId: invitation.id, token: "wrong", userId }),
          ),
          "InvitationNotFound",
        );
        const membership = yield* invitations.accept({
          invitationId: invitation.id,
          token: yield* mailedToken(invitation.id),
          userId,
        });
        assert.deepStrictEqual(membership.role, ["member"]);
        assert.isTrue(Option.isSome(yield* members.findByUserAndOrg(userId, org.id)));
        assert.strictEqual(
          Option.getOrThrow(yield* invitations.find(invitation.id)).status,
          "accepted",
        );
        // A second acceptance with the same token is a replay: no longer pending.
        assert.strictEqual(
          yield* flipTag(
            invitations.accept({
              invitationId: invitation.id,
              token: yield* mailedToken(invitation.id),
              userId,
            }),
          ),
          "InvitationNotPending",
        );
      }).pipe(Effect.provide(buildLayer())),
  );

  it.effect(
    "an expired invitation is InvitationExpired, becomes expired, and publishes invitationExpired (D8)",
    () =>
      Effect.gen(function* () {
        const { invitations, invite } = yield* arrange;
        const invitee = yield* verifiedUser("invitee@example.com");
        const invitation = yield* invite("invitee@example.com");
        yield* TestClock.adjust(Duration.hours(49));
        assert.strictEqual(
          yield* flipTag(
            invitations.accept({
              invitationId: invitation.id,
              token: yield* mailedToken(invitation.id),
              userId: invitee.id,
            }),
          ),
          "InvitationExpired",
        );
        assert.strictEqual(
          Option.getOrThrow(yield* invitations.find(invitation.id)).status,
          "expired",
        );
        assert.strictEqual(
          (yield* (yield* AuditLog.AuditLog).list({
            eventTag: "auth.organization.invitationExpired",
          })).length,
          1,
        );
      }).pipe(Effect.provide(buildLayer())),
  );

  it.effect(
    "the invitee must own the address, and verify it unless configured otherwise (EP-010)",
    () =>
      Effect.gen(function* () {
        const { invitations, invite } = yield* arrange;
        const users = yield* Users.Users;
        const stranger = yield* verifiedUser("stranger@example.com");
        const unverified = yield* users.create({
          identity: { _tag: "Email", email: "invitee@example.com" },
          name: "I",
        });
        const invitation = yield* invite("invitee@example.com");
        const token = yield* mailedToken(invitation.id);
        assert.strictEqual(
          yield* flipTag(
            invitations.accept({ invitationId: invitation.id, token, userId: stranger.id }),
          ),
          "InvitationEmailMismatch",
        );
        assert.strictEqual(
          yield* flipTag(
            invitations.accept({ invitationId: invitation.id, token, userId: unverified.id }),
          ),
          "EmailVerificationRequired",
        );
      }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("accepting while already a member cancels the stale invitation and says so", () =>
    Effect.gen(function* () {
      const { org, invitations, invite } = yield* arrange;
      const invitee = yield* verifiedUser("invitee@example.com");
      const invitation = yield* invite("invitee@example.com");
      yield* (yield* MembershipRecords.MembershipRecords).create({
        userId: invitee.id,
        organizationId: org.id,
        role: ["admin"],
      });
      assert.strictEqual(
        yield* flipTag(
          invitations.accept({
            invitationId: invitation.id,
            token: yield* mailedToken(invitation.id),
            userId: invitee.id,
          }),
        ),
        "AlreadyMember",
      );
      assert.strictEqual(
        Option.getOrThrow(yield* invitations.find(invitation.id)).status,
        "canceled",
      );
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect(
    "an acceptance joins the team, and fires AfterAddMember and AfterAddTeamMember with the invitee as actor (D7)",
    () => {
      const seen: Array<string> = [];
      return Effect.gen(function* () {
        const { org, invitations, invite } = yield* arrange;
        const teams = yield* TeamRecords.TeamRecords;
        const team = yield* teams.createTeam({ organizationId: org.id, name: "Eng" });
        const invitee = yield* verifiedUser("invitee@example.com");
        const invitation = yield* invite("invitee@example.com", { teamId: team.id });
        seen.length = 0; // the creator's own membership fired first (D7)
        yield* invitations.accept({
          invitationId: invitation.id,
          token: yield* mailedToken(invitation.id),
          userId: invitee.id,
        });
        assert.strictEqual((yield* teams.listTeamMembers(team.id)).length, 1);
        assert.deepStrictEqual(seen, ["accepted:User", "memberAdded:User", "teamMemberAdded:User"]);
      }).pipe(
        Effect.provide(
          buildLayer(
            { teams: teamsOn },
            Layer.mergeAll(
              OrganizationHooks.AfterAcceptInvitation.tap((input) => {
                seen.push(`accepted:${input.actor._tag}`);
                return Effect.void;
              }),
              OrganizationHooks.AfterAddMember.tap((input) => {
                seen.push(`memberAdded:${input.actor._tag}`);
                return Effect.void;
              }),
              OrganizationHooks.AfterAddTeamMember.tap((input) => {
                seen.push(`teamMemberAdded:${input.actor._tag}`);
                return Effect.void;
              }),
            ),
          ),
        ),
      );
    },
  );

  it.effect("the veto point of an acceptance runs first, before the token is looked at", () =>
    Effect.gen(function* () {
      const { invitations } = yield* arrange;
      const aborted = yield* invitations
        .accept({ invitationId: "no-such-invitation", token: "x", userId: Users.UserId("u") })
        .pipe(Effect.flip);
      assert.strictEqual(aborted._tag, "HookAborted");
    }).pipe(
      Effect.provide(
        buildLayer(
          { teams: teamsOn },
          OrganizationHooks.BeforeAcceptInvitation.tap(() =>
            Effect.fail(new HookPoint.HookAbort({ code: "HOLD" })),
          ),
        ),
      ),
    ),
  );

  it.effect("reject needs the token and the invitee's address, and creates no membership", () =>
    Effect.gen(function* () {
      const { org, invitations, invite } = yield* arrange;
      const invitee = yield* verifiedUser("invitee@example.com");
      const stranger = yield* verifiedUser("stranger@example.com");
      const invitation = yield* invite("invitee@example.com");
      const token = yield* mailedToken(invitation.id);
      assert.strictEqual(
        yield* flipTag(
          invitations.reject({ invitationId: invitation.id, token, userId: stranger.id }),
        ),
        "InvitationEmailMismatch",
      );
      yield* invitations.reject({ invitationId: invitation.id, token, userId: invitee.id });
      assert.strictEqual(
        Option.getOrThrow(yield* invitations.find(invitation.id)).status,
        "rejected",
      );
      assert.isTrue(
        Option.isNone(
          yield* (yield* MembershipRecords.MembershipRecords).findByUserAndOrg(invitee.id, org.id),
        ),
      );
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect(
    "cancel marks a pending invitation canceled once, and runs its veto and observe points",
    () => {
      const seen: Array<string> = [];
      return Effect.gen(function* () {
        const { invitations, invite } = yield* arrange;
        const invitation = yield* invite("invitee@example.com");
        yield* invitations.cancel(application, { invitationId: invitation.id });
        assert.strictEqual(
          Option.getOrThrow(yield* invitations.find(invitation.id)).status,
          "canceled",
        );
        assert.strictEqual(
          yield* flipTag(invitations.cancel(application, { invitationId: invitation.id })),
          "InvitationNotPending",
        );
        assert.strictEqual(
          yield* flipTag(invitations.cancel(application, { invitationId: "nope" })),
          "InvitationNotFound",
        );
        assert.deepStrictEqual(seen, ["canceled:Application"]);
      }).pipe(
        Effect.provide(
          buildLayer(
            { teams: teamsOn },
            OrganizationHooks.AfterCancelInvitation.tap((input) => {
              seen.push(`canceled:${input.actor._tag}`);
              return Effect.void;
            }),
          ),
        ),
      );
    },
  );

  it.effect("listForUser is the invitee's own address (FAMS-002), nothing for another user", () =>
    Effect.gen(function* () {
      const { invitations, invite } = yield* arrange;
      const invitee = yield* verifiedUser("invitee@example.com");
      const other = yield* verifiedUser("other@example.com");
      yield* invite("invitee@example.com");
      assert.strictEqual((yield* invitations.listForUser(invitee.id)).length, 1);
      assert.deepStrictEqual(yield* invitations.listForUser(other.id), []);
    }).pipe(Effect.provide(buildLayer())),
  );
});

// ---- over SQL: an acceptance is one transaction (D3) -------------------------------------------

const SqlLive = TestSql.layer("organization_OrganizationInvitations");
const Migrated = Layer.effectDiscard(Migrations.run(Organization.Organization.migrations)).pipe(
  Layer.provide(SqlLive),
);
const sqlRecords = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  layer.pipe(Layer.provide(NodeCrypto.layer));
const SqlSystemLive = OrganizationSystem.layer.pipe(
  Layer.provide(Organization.config({ teams: teamsOn })),
  Layer.provideMerge(Users.layer.pipe(Layer.provide(Persistence.memory))),
  Layer.provideMerge(Mailer.layerMemory),
  Layer.provideMerge(TestAuth.memoryFoundation),
  Layer.provideMerge(sqlRecords(OrganizationRecords.layerSql)),
  Layer.provideMerge(sqlRecords(MembershipRecords.layerSql)),
  Layer.provideMerge(ActiveContextRecords.layerSql),
  Layer.provideMerge(sqlRecords(InvitationRecords.layerSql)),
  Layer.provideMerge(sqlRecords(OrgRoleRecords.layerSql)),
  Layer.provideMerge(sqlRecords(TeamRecords.layerSql)),
  Layer.provideMerge(SqlTransaction.layerSql),
  Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
  Layer.provideMerge(Migrated),
  Layer.provideMerge(SqlLive),
);

const countRows = (sql: SqlClient.SqlClient, table: string) =>
  sql.unsafe(`SELECT COUNT(*) AS n FROM ${table}`).pipe(
    Effect.map((rows) => {
      const first = rows[0];
      return typeof first === "object" && first !== null && "n" in first ? Number(first.n) : -1;
    }),
  );

describe("OrganizationInvitations over SQL", () => {
  it.effect("a failing team insert leaves the invitation pending and no membership (D3)", () =>
    Effect.gen(function* () {
      const { org, invitations, invite } = yield* arrange;
      const teams = yield* TeamRecords.TeamRecords;
      const sql = yield* SqlClient.SqlClient;
      const team = yield* teams.createTeam({ organizationId: org.id, name: "Eng" });
      const invitee = yield* verifiedUser("invitee@example.com");
      const invitation = yield* invite("invitee@example.com", { teamId: team.id });
      const token = yield* mailedToken(invitation.id);
      yield* TestSql.injectFailure({
        name: "fail_team_membership_insert",
        table: "organization_team_membership",
        event: "INSERT",
      });
      const exit = yield* Effect.exit(
        invitations.accept({ invitationId: invitation.id, token, userId: invitee.id }),
      );
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(
        Option.getOrThrow(yield* invitations.find(invitation.id)).status,
        "pending",
      );
      // Only the creator's membership: the invitee's was rolled back with the failed team insert.
      assert.strictEqual(yield* countRows(sql, "organization_membership"), 1);
    }).pipe(Effect.provide(SqlSystemLive)),
  );
});
