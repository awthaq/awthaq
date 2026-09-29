// BEH-EA-307 (spec/behaviors/29-saml-sp.md): organization role mapping. What an IdP's assertion says about groups becomes an
// organization's roles by rules an administrator wrote, under a CEILING (RRM-001's `canGrant` rule with the ceiling standing in for a
// caller): a connection cannot mint `owner` unless the deployment allowed it and the connection's ceiling holds it, a member who
// out-privileges the connection is never reshaped by it, the last owner is never demoted, and a mapping that cannot be applied
// never locks the user out.
import { AuditLog, Users } from "@awthaq/core";
import { MembershipRecords, Organization } from "@awthaq/organization";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Saml from "../src/Saml.ts";
import * as SamlConnections from "../src/SamlConnections.ts";
import * as SamlRecords from "../src/SamlRecords.ts";
import * as SamlRoleMapping from "../src/SamlRoleMapping.ts";
import { idp } from "./samlFixtures.ts";
import {
  atNow,
  idpResponse,
  ownerPrincipal,
  SamlLive,
  seedConnection,
  startLogin,
} from "./support.ts";
import type { SignedAssertion } from "../src/SamlAssertion.ts";

const assertionWith = (
  attributes: Readonly<Record<string, ReadonlyArray<string>>>,
): SignedAssertion => ({
  id: "_a",
  issuer: "i",
  nameId: { value: "n", format: undefined },
  confirmations: [],
  notBefore: undefined,
  notOnOrAfter: undefined,
  audienceRestrictions: [],
  authnInstant: undefined,
  sessionIndex: undefined,
  attributes,
  responseDestination: undefined,
  responseSucceeded: undefined,
});

const mapping = (
  rules: SamlRecords.RoleMapping["rules"],
  ceiling: ReadonlyArray<string> = ["admin"],
  defaultRoles: ReadonlyArray<string> = [],
): SamlRecords.RoleMapping => ({ rules, ceiling, defaultRoles });

describe("SamlRoleMapping.rolesFor", () => {
  const rules = [
    { attribute: "groups", value: "admins", roles: ["admin"] },
    { attribute: "GROUPS", value: "auditors", roles: ["member", "auditor"] },
    { attribute: "department", roles: ["member"] },
  ];

  it("matches the attribute by name (case-insensitively) and value, across every value of a multi-valued attribute", () => {
    assert.deepStrictEqual(
      SamlRoleMapping.rolesFor(mapping(rules), assertionWith({ Groups: ["eng", "admins"] })),
      ["admin"],
    );
    assert.deepStrictEqual(
      SamlRoleMapping.rolesFor(mapping(rules), assertionWith({ groups: ["auditors", "admins"] })),
      ["admin", "member", "auditor"],
      "additive: the union of every matching rule, in rule order, without repeats",
    );
  });

  it("a rule without a value matches when the attribute is present at all, and not when it is absent or empty", () => {
    assert.deepStrictEqual(
      SamlRoleMapping.rolesFor(mapping(rules), assertionWith({ department: ["sales"] })),
      ["member"],
    );
    assert.isUndefined(
      SamlRoleMapping.rolesFor(mapping(rules), assertionWith({ department: [""] })),
    );
    assert.isUndefined(SamlRoleMapping.rolesFor(mapping(rules), assertionWith({})));
  });

  it("defaults apply only when nothing matched, and no match with no default changes nothing", () => {
    assert.deepStrictEqual(
      SamlRoleMapping.rolesFor(
        mapping(rules, ["admin"], ["member"]),
        assertionWith({ groups: ["eng"] }),
      ),
      ["member"],
    );
    assert.isUndefined(
      SamlRoleMapping.rolesFor(mapping(rules), assertionWith({ groups: ["eng"] })),
    );
    // An exact value: a superstring or a substring is not a match.
    assert.isUndefined(
      SamlRoleMapping.rolesFor(mapping(rules), assertionWith({ groups: ["superadmins", "admin"] })),
    );
  });

  it("names what a mapping could confer", () => {
    assert.deepStrictEqual(
      SamlRoleMapping.rolesMentioned(mapping(rules, ["admin"], ["member"])).toSorted(),
      ["admin", "auditor", "member"],
    );
    assert.isFalse(SamlRoleMapping.mentionsOwner(mapping(rules)));
    assert.isTrue(
      SamlRoleMapping.mentionsOwner(mapping([{ attribute: "g", roles: ["owner"] }], ["owner"])),
    );
    assert.isTrue(SamlRoleMapping.mentionsOwner(mapping([], ["member"], ["owner"])));
  });
});

describe("validating a mapping when a connection is written", () => {
  let slugs = 0;
  const refusal = (roleMapping: SamlRecords.RoleMapping) =>
    Effect.gen(function* () {
      const store = yield* SamlConnections.SamlConnectionStore;
      const organization = yield* Organization.Organization;
      const { id: organizationId } = yield* organization.create({
        caller: ownerPrincipal,
        name: "Acme",
        slug: `acme-${(slugs += 1)}`,
      });
      const failure = yield* store
        .create({
          organizationId,
          name: "Second",
          idp: {
            entityId: "https://idp2.example.com/m",
            ssoUrl: "https://idp2.example.com/sso",
            certificates: [idp.cert],
          },
          roleMapping,
        })
        .pipe(Effect.flip);
      return failure._tag === "InvalidSamlConnection" ? failure.reason : failure._tag;
    });

  it.effect(
    "a rule that confers more than the ceiling is refused by the canGrant rule, not by name",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        assert.include(
          yield* refusal(
            mapping([{ attribute: "groups", value: "admins", roles: ["admin"] }], ["member"]),
          ),
          "more than the connection's role ceiling",
        );
        assert.include(
          yield* refusal(mapping([], ["member"], ["admin"])),
          "more than the connection's role ceiling",
        );
      }).pipe(Effect.provide(SamlLive())),
  );

  it.effect("owner is refused unless the deployment allowed it, whatever the ceiling says", () =>
    Effect.gen(function* () {
      yield* atNow;
      assert.include(
        yield* refusal(
          mapping([{ attribute: "groups", value: "owners", roles: ["owner"] }], ["owner"]),
        ),
        "may not confer owner",
      );
      assert.include(yield* refusal(mapping([], ["owner"])), "may not confer owner");
      assert.include(yield* refusal(mapping([], ["member"], ["owner"])), "may not confer owner");
    }).pipe(Effect.provide(SamlLive())),
  );

  it.effect(
    "with allowOwnerRoleMapping an owner ceiling can hold owner; an admin ceiling still cannot mint one",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const store = yield* SamlConnections.SamlConnectionStore;
        const { organizationId } = yield* seedConnection();
        const idpOf = (n: number) => ({
          entityId: `https://idp${n}.example.com/m`,
          ssoUrl: `https://idp${n}.example.com/sso`,
          certificates: [idp.cert],
        });
        const ok = yield* store.create({
          organizationId,
          name: "Owners",
          idp: idpOf(2),
          roleMapping: mapping(
            [{ attribute: "groups", value: "owners", roles: ["owner"] }],
            ["owner"],
          ),
        });
        assert.deepStrictEqual(ok.roleMapping.ceiling, ["owner"]);
        const escalation = yield* store
          .create({
            organizationId,
            name: "Escalating",
            idp: idpOf(3),
            roleMapping: mapping(
              [{ attribute: "groups", value: "owners", roles: ["owner"] }],
              ["admin"],
            ),
          })
          .pipe(Effect.flip);
        assert.include(
          escalation._tag === "InvalidSamlConnection" ? escalation.reason : "",
          "more than the connection's role ceiling",
        );
      }).pipe(Effect.provide(SamlLive({ allowOwnerRoleMapping: true }))),
  );

  it.effect("unknown roles, an empty ceiling, blank rules and too many rules are refused", () =>
    Effect.gen(function* () {
      yield* atNow;
      assert.include(
        yield* refusal(mapping([{ attribute: "g", value: "x", roles: ["wizard"] }], ["admin"])),
        "does not have",
      );
      assert.include(yield* refusal(mapping([], ["wizard"])), "does not have");
      assert.include(yield* refusal(mapping([], [])), "needs a ceiling");
      assert.include(
        yield* refusal(mapping([{ attribute: " ", roles: ["member"] }], ["admin"])),
        "attribute name",
      );
      assert.include(
        yield* refusal(mapping([{ attribute: "g", roles: [] }], ["admin"])),
        "at least one role",
      );
      assert.include(
        yield* refusal(
          mapping(
            Array.from({ length: 51 }, (_, i) => ({ attribute: `g${i}`, roles: ["member"] })),
            ["admin"],
          ),
        ),
        "at most 50",
      );
    }).pipe(Effect.provide(SamlLive())),
  );
});

describe("a sign-in through a connection with a role mapping", () => {
  const groupsRule = mapping(
    [{ attribute: "groups", value: "admins", roles: ["admin"] }],
    ["admin"],
    ["member"],
  );

  const signInWith = (
    connectionId: string,
    attributes: Readonly<Record<string, ReadonlyArray<string>>>,
    nameId: string,
    assertionId: string,
  ) =>
    Effect.gen(function* () {
      const saml = yield* Saml.Saml;
      const started = yield* startLogin(connectionId);
      return yield* saml.acs({
        samlResponse: idpResponse(started, connectionId, { attributes, nameId, assertionId }),
        cookieState: started.state,
      });
    });

  const rolesOf = (userId: Users.UserId, organizationId: string) =>
    Effect.flatMap(MembershipRecords.MembershipRecords, (members) =>
      members.findByUserAndOrg(userId, organizationId),
    ).pipe(Effect.map((found) => Option.map(found, (row) => row.role)));

  it.effect(
    "adds the membership with the mapped roles, defaults when nothing matched, and re-syncs on the next sign-in",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const { connection, organizationId } = yield* seedConnection({ roleMapping: groupsRule });
        const admin = yield* signInWith(
          connection.id,
          { email: ["ada@acme.example"], groups: ["eng", "admins"] },
          "ada@acme.example",
          "_r1",
        );
        assert.deepStrictEqual(
          yield* rolesOf(admin.session.session.userId, organizationId),
          Option.some(["admin"]),
        );
        const plain = yield* signInWith(
          connection.id,
          { email: ["grace@acme.example"], groups: ["eng"] },
          "grace@acme.example",
          "_r2",
        );
        assert.deepStrictEqual(
          yield* rolesOf(plain.session.session.userId, organizationId),
          Option.some(["member"]),
        );
        // The IdP takes the admins group away from ada: the next sign-in re-syncs her to the default.
        yield* signInWith(
          connection.id,
          { email: ["ada@acme.example"], groups: ["eng"] },
          "ada@acme.example",
          "_r3",
        );
        assert.deepStrictEqual(
          yield* rolesOf(admin.session.session.userId, organizationId),
          Option.some(["member"]),
        );
      }).pipe(Effect.provide(SamlLive())),
  );

  it.effect("a connection with no mapping changes no membership at all", () =>
    Effect.gen(function* () {
      yield* atNow;
      const { connection, organizationId } = yield* seedConnection();
      const outcome = yield* signInWith(
        connection.id,
        { email: ["ada@acme.example"], groups: ["admins"] },
        "ada@acme.example",
        "_n1",
      );
      assert.deepStrictEqual(
        yield* rolesOf(outcome.session.session.userId, organizationId),
        Option.none(),
      );
    }).pipe(Effect.provide(SamlLive())),
  );

  it.effect(
    "a mapping that would mint owner (stale, or written around the store) is refused at sign-in: the user is in, the role is not conferred",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const records = yield* SamlRecords.SamlRecords;
        const { connection, organizationId } = yield* seedConnection({ roleMapping: groupsRule });
        // Rewritten straight in the records, the way a stale row or a hand-edited database could look.
        yield* records.update(connection.id, {
          roleMapping: mapping(
            [{ attribute: "groups", value: "admins", roles: ["owner"] }],
            ["member"],
            [],
          ),
        });
        const outcome = yield* signInWith(
          connection.id,
          { email: ["ada@acme.example"], groups: ["admins"] },
          "ada@acme.example",
          "_o1",
        );
        assert.isDefined(outcome.session.token);
        assert.deepStrictEqual(
          yield* rolesOf(outcome.session.session.userId, organizationId),
          Option.none(),
        );
        // Even an admin ceiling cannot mint an owner: it is the statements held, not the name.
        yield* records.update(connection.id, {
          roleMapping: mapping(
            [{ attribute: "groups", value: "admins", roles: ["owner"] }],
            ["admin"],
            [],
          ),
        });
        const again = yield* signInWith(
          connection.id,
          { email: ["ada@acme.example"], groups: ["admins"] },
          "ada@acme.example",
          "_o2",
        );
        assert.deepStrictEqual(
          yield* rolesOf(again.session.session.userId, organizationId),
          Option.none(),
        );
        const memberships = yield* Effect.flatMap(MembershipRecords.MembershipRecords, (members) =>
          members.countOwners(organizationId),
        );
        assert.strictEqual(memberships, 1, "only the founder is an owner");
      }).pipe(Effect.provide(SamlLive({ allowOwnerRoleMapping: true }))),
  );

  it.effect(
    "never reshapes an existing owner, and never demotes the last one, even under an owner ceiling",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const records = yield* SamlRecords.SamlRecords;
        const users = yield* Users.Users;
        const members = yield* MembershipRecords.MembershipRecords;
        const { connection, organizationId } = yield* seedConnection({ roleMapping: groupsRule });
        // The organization's founder signs in through the IdP too (their SAML account links to their verified email), and after
        // the seeded creator is removed they are the ONLY owner.
        const founder = yield* users.create({
          identity: { _tag: "Email", email: "owner@acme.example" },
          name: "Founder",
        });
        yield* users.verifyEmail(founder.id);
        yield* members.create({ userId: founder.id, organizationId, role: ["owner"] });
        yield* members.remove(Users.UserId(ownerPrincipal.ref.id), organizationId);
        yield* records.update(connection.id, { trustsEmail: true });
        assert.strictEqual(yield* members.countOwners(organizationId), 1);
        // Under an admin ceiling the IdP cannot touch an owner at all (they out-privilege the connection).
        const outranked = yield* signInWith(
          connection.id,
          { email: ["owner@acme.example"], groups: ["admins"] },
          "owner@acme.example",
          "_ow1",
        );
        assert.strictEqual(outranked.session.session.userId, founder.id);
        assert.deepStrictEqual(yield* rolesOf(founder.id, organizationId), Option.some(["owner"]));
        // Even under an owner ceiling, an IdP mapping to `member` does not demote the only owner.
        yield* records.update(connection.id, {
          roleMapping: mapping(
            [{ attribute: "groups", value: "staff", roles: ["member"] }],
            ["owner"],
            [],
          ),
        });
        yield* signInWith(
          connection.id,
          { email: ["owner@acme.example"], groups: ["staff"] },
          "owner@acme.example",
          "_ow2",
        );
        assert.deepStrictEqual(yield* rolesOf(founder.id, organizationId), Option.some(["owner"]));
        assert.strictEqual(yield* members.countOwners(organizationId), 1);
      }).pipe(Effect.provide(SamlLive({ allowOwnerRoleMapping: true }))),
  );

  it.effect("a role that no longer exists is logged and skipped: the sign-in still succeeds", () =>
    Effect.gen(function* () {
      yield* atNow;
      const records = yield* SamlRecords.SamlRecords;
      const { connection, organizationId } = yield* seedConnection({ roleMapping: groupsRule });
      yield* records.update(connection.id, {
        roleMapping: mapping(
          [{ attribute: "groups", value: "admins", roles: ["retired-role"] }],
          ["admin"],
          [],
        ),
      });
      const outcome = yield* signInWith(
        connection.id,
        { email: ["ada@acme.example"], groups: ["admins"] },
        "ada@acme.example",
        "_u1",
      );
      assert.isDefined(outcome.session.token);
      assert.deepStrictEqual(
        yield* rolesOf(outcome.session.session.userId, organizationId),
        Option.none(),
      );
    }).pipe(Effect.provide(SamlLive())),
  );

  it.effect(
    "the membership it adds is announced like any other, and stamped with the connection's tenant",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const { connection, organizationId } = yield* seedConnection({ roleMapping: groupsRule });
        yield* signInWith(
          connection.id,
          { email: ["ada@acme.example"], groups: ["admins"] },
          "ada@acme.example",
          "_e1",
        );
        const added = yield* Effect.flatMap(AuditLog.AuditLog, (log) =>
          log.list({ eventTag: "auth.organization.memberAdded" }),
        );
        // The founder's own membership (creation) and ada's, whose event names the mapped role.
        const ada = added.find(
          (row) =>
            row.payload._tag === "auth.organization.memberAdded" &&
            row.payload.role.includes("admin"),
        );
        assert.isDefined(ada);
        assert.deepStrictEqual(ada?.tenantId, Option.some(organizationId));
      }).pipe(Effect.provide(SamlLive())),
  );
});
