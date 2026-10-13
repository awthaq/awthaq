// ADR-EA-038, BEH-EA-315/316: what the SAML plugin hands the core `SignIn` module, and the sign-in continuation that keeps the
// Single Logout record, the role mapping and the connection's tenant on a sign-in that a second factor finishes. Policy (gate,
// veto, divert, announcement, outages) is tested once at `SignIn`.
import { Hooks, SignIn, Users } from "@awthaq/core";
import { MembershipRecords } from "@awthaq/organization";
import { SignInProbe } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Saml from "../src/Saml.ts";
import * as SamlRecords from "../src/SamlRecords.ts";
import { atNow, idpResponse, SamlLive, seedConnection, startLogin } from "./support.ts";

const signInThrough = (
  connectionId: string,
  attributes?: Readonly<Record<string, ReadonlyArray<string>>>,
) =>
  Effect.gen(function* () {
    const saml = yield* Saml.Saml;
    const started = yield* startLogin(connectionId);
    return yield* saml.acs({
      samlResponse: idpResponse(started, connectionId, {
        nameId: "ada@acme.example",
        ...(attributes === undefined ? {} : { attributes }),
      }),
      cookieState: started.state,
    });
  });

const groupsRule = {
  rules: [{ attribute: "groups", value: "admins", roles: ["admin"] }],
  ceiling: ["admin"],
  defaultRoles: ["member"],
};

describe("SAML sign-in wiring (ADR-EA-038)", () => {
  it.effect(
    "BEH-EA-240: hands SignIn strategy saml:<org>:<connection> and amr [fed]; the session records the same amr",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const probe = yield* SignInProbe.SignInProbe;
        const { connection, organizationId } = yield* seedConnection();
        const outcome = yield* signInThrough(connection.id);
        const recorded = yield* probe.recorded;
        const strategy = `saml:${organizationId}:${connection.id}`;
        assert.deepStrictEqual(
          recorded.beforeSessionIssue.map((input) => [input.userId, input.strategy, input.amr]),
          [[outcome.session.session.userId, strategy, ["fed"]]],
        );
        assert.deepStrictEqual(recorded.beforeSessionIssue[0]?.amr, outcome.session.session.amr);
        // The Single Logout record and the role mapping ride the divert as a continuation (BEH-EA-315/316).
        assert.strictEqual(recorded.beforeSessionIssue[0]?.handoff?.continuation?.kind, "saml.acs");
        assert.deepStrictEqual(
          recorded.beforeSignUp.map((input) => input.strategy),
          [strategy],
        );
      }).pipe(Effect.provide(SignInProbe.layer.pipe(Layer.provideMerge(SamlLive())))),
  );

  it.effect(
    "a user erased between the IdP's proof and the session is the uniform SamlAssertionRejected",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const { connection } = yield* seedConnection();
        const failure = yield* signInThrough(connection.id).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "SamlAssertionRejected");
      }).pipe(
        Effect.provide(
          SamlLive(
            {},
            undefined,
            undefined,
            Layer.effect(
              Users.Users,
              Effect.map(Users.Users, (real) =>
                Users.Users.of({
                  ...real,
                  findById: (id) => Effect.fail(new Users.UserNotFound({ id, message: "erased" })),
                }),
              ),
            ),
          ),
        ),
      ),
  );
});

describe("a SAML sign-in finished by a second factor keeps what the first factor owed (ADR-EA-038)", () => {
  // A divert owner as `@awthaq/two-factor` is: it stores the handoff, and later returns it to `SignIn.resume`.
  const held: Array<{ readonly userId: string; readonly handoff: Hooks.Handoff | undefined }> = [];
  const diverting = Hooks.BeforeSessionIssue.tap((input) =>
    Effect.sync(() => {
      held.push({ userId: input.userId, handoff: input.handoff });
      return Option.some(new Hooks.TwoFactorRequired({ userId: input.userId, challengeId: "c1" }));
    }),
  );

  it.effect(
    "the session records fed + the second factor, the Single Logout record exists, the role is mapped and the tenant is the connection's",
    () =>
      Effect.gen(function* () {
        yield* atNow;
        const records = yield* SamlRecords.SamlRecords;
        const signIn = yield* SignIn.make;
        const members = yield* MembershipRecords.MembershipRecords;
        const { connection, organizationId } = yield* seedConnection({ roleMapping: groupsRule });
        const diverted = yield* signInThrough(connection.id, {
          email: ["ada@acme.example"],
          groups: ["admins"],
        }).pipe(Effect.flip);
        assert.strictEqual(diverted._tag, "TwoFactorRequired");
        const [stored] = held;
        if (stored === undefined) return assert.fail("the divert recorded nothing");
        // Nothing is conferred, and no Single Logout record exists, until the second factor passes.
        assert.deepStrictEqual(
          Option.map(
            yield* members.findByUserAndOrg(Users.UserId(stored.userId), organizationId),
            (row) => row.role,
          ),
          Option.none(),
        );

        // The second factor passes in another request, in no tenant of its own.
        const cleared = yield* signIn.resume({
          userId: Users.UserId(stored.userId),
          strategy: `saml:${organizationId}:${connection.id}`,
          amr: ["fed", "otp", "mfa"],
          handoff: stored.handoff,
        });
        const issued = yield* signIn.issue(cleared);

        assert.deepStrictEqual(issued.session.amr, ["fed", "otp", "mfa"]);
        assert.deepStrictEqual(Option.getOrUndefined(issued.session.tenantId), organizationId);
        const row = yield* records.findSession(issued.session.id);
        assert.isTrue(Option.isSome(row));
        assert.strictEqual(Option.getOrUndefined(row)?.connectionId, connection.id);
        assert.strictEqual(Option.getOrUndefined(row)?.nameId, "ada@acme.example");
        assert.deepStrictEqual(
          Option.map(
            yield* members.findByUserAndOrg(Users.UserId(stored.userId), organizationId),
            (row) => row.role,
          ),
          Option.some(["admin"]),
        );
      }).pipe(Effect.provide(diverting.pipe(Layer.provideMerge(SamlLive())))),
  );
});
