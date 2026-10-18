// Plan 13 (ADR-EA-018 Decision 8, BEH-EA-221/224/236/237, BEH-EA-212/217/218/219, IDS-001/002/003):
// the one admin gate, tested once through the public operations of the three admin plugins (which
// also proves each call site picked the right action). Every gated operation x every predicate x
// {default, build-time allow, tenant opens, tenant tightens}.
//
// The operation table below is this test's OWN copy of the action table, deliberately not imported
// from `internal/AdminGate.ts`, so a wrong row in the gate is caught.
import { Api } from "@awthaq/api";
import { Accounts, AuditChain, Auth, AuthEvents, Sessions, Tenant, Users } from "@awthaq/core";
import { Organization } from "@awthaq/organization";
import { Mailer, PasswordHasher } from "@awthaq/ports";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Admin from "../src/Admin.ts";
import * as AdminAccounts from "../src/AdminAccounts.ts";
import * as AdminTenants from "../src/AdminTenants.ts";
import * as ImpersonationRecords from "../src/ImpersonationRecords.ts";

// ---- composition ---------------------------------------------------------------------------------

const buildLayer = (build: Partial<Admin.AdminConfigShape>) =>
  TestAuth.layer(
    Auth.make([
      Organization.Organization,
      Admin.Admin,
      AdminAccounts.AdminAccounts,
      AdminTenants.AdminTenants,
    ]),
    {
      services: Layer.mergeAll(
        Admin.config(build),
        Organization.config({}),
        AuditChain.config({ key: Redacted.make("admin-gate-chain-key-0123456789abcdef") }),
      ),
    },
  );

const allow = () => Effect.succeed(true);
const deny = () => Effect.succeed(false);

type Predicate =
  | "canManageUsers"
  | "canBanUsers"
  | "canDeleteUsers"
  | "canManageCredentials"
  | "canAdministerTenants"
  | "canImpersonate"
  | "canManageEpisode";

const predicates: ReadonlyArray<Predicate> = [
  "canManageUsers",
  "canBanUsers",
  "canDeleteUsers",
  "canManageCredentials",
  "canAdministerTenants",
  "canImpersonate",
  "canManageEpisode",
];

/** Every predicate allows. */
const allowAll: Partial<Admin.AdminConfigShape> = {
  canManageUsers: allow,
  canBanUsers: allow,
  canDeleteUsers: allow,
  canManageCredentials: allow,
  canAdministerTenants: allow,
  canImpersonate: allow,
  canManageEpisode: allow,
};

/** Only `predicate` allows; `canManageEpisode` is explicit so the `canImpersonate` derivation does not couple the two. */
const only = (predicate: Predicate): Partial<Admin.AdminConfigShape> => ({
  canManageUsers: predicate === "canManageUsers" ? allow : deny,
  canBanUsers: predicate === "canBanUsers" ? allow : deny,
  canDeleteUsers: predicate === "canDeleteUsers" ? allow : deny,
  canManageCredentials: predicate === "canManageCredentials" ? allow : deny,
  canAdministerTenants: predicate === "canAdministerTenants" ? allow : deny,
  canImpersonate: predicate === "canImpersonate" ? allow : deny,
  canManageEpisode: predicate === "canManageEpisode" ? allow : deny,
});

const asCaller = (id: string): Api.UserPrincipal =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id }),
    sessionId: `${id}-session`,
  });

const adminCaller = asCaller("admin-1");

// ---- the operation table -------------------------------------------------------------------------

interface Env {
  readonly admin: Admin.AdminShape;
  readonly accounts: AdminAccounts.AdminAccountsShape;
  readonly tenants: AdminTenants.AdminTenantsShape;
  readonly ghostUser: Users.UserId;
  readonly ghostOrg: string;
  /** Seeds a fresh impersonation episode and returns its session id (the gate looks the episode up first). */
  readonly seedEpisode: Effect.Effect<string, unknown>;
}

type Kind = "users" | "user" | "organizations" | "organization" | "impersonate" | "episode";
type Denial = "AdminActionDenied" | "AdminImpersonationDenied" | "empty";

interface Row {
  readonly name: string;
  readonly predicate: Predicate;
  readonly kind: Kind;
  readonly denial: Denial;
  /** The outcome of a call that got past the gate (a ghost target, or success for collection calls). */
  readonly passed: string;
  readonly run: (env: Env) => Effect.Effect<string, unknown>;
}

const outcome = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.match(effect, { onSuccess: () => "ok", onFailure: (error) => error._tag });

const userRow = (
  name: string,
  predicate: Predicate,
  run: (env: Env) => Effect.Effect<string, unknown>,
  passed = "AdminTargetNotFound",
): Row => ({ name, predicate, kind: "user", denial: "AdminActionDenied", passed, run });

const rows: ReadonlyArray<Row> = [
  {
    name: "effectiveConfig",
    predicate: "canManageUsers",
    kind: "users",
    denial: "AdminActionDenied",
    passed: "ok",
    run: ({ admin }) => outcome(admin.effectiveConfig(adminCaller)),
  },
  {
    name: "listUsers",
    predicate: "canManageUsers",
    kind: "users",
    denial: "AdminActionDenied",
    passed: "ok",
    run: ({ admin }) => outcome(admin.listUsers(adminCaller, {})),
  },
  userRow("getUser", "canManageUsers", ({ admin, ghostUser }) =>
    outcome(admin.getUser(adminCaller, ghostUser)),
  ),
  userRow("updateUser", "canManageUsers", ({ admin, ghostUser }) =>
    outcome(admin.updateUser(adminCaller, ghostUser, { name: "x" })),
  ),
  userRow("listUserSessions", "canManageUsers", ({ admin, ghostUser }) =>
    outcome(admin.listUserSessions(adminCaller, ghostUser)),
  ),
  userRow("revokeUserSession", "canManageUsers", ({ admin, ghostUser }) =>
    outcome(admin.revokeUserSession(adminCaller, ghostUser, "no-such-session")),
  ),
  userRow("revokeUserSessions", "canManageUsers", ({ admin, ghostUser }) =>
    outcome(admin.revokeUserSessions(adminCaller, ghostUser)),
  ),
  userRow("banUser", "canBanUsers", ({ admin, ghostUser }) =>
    outcome(admin.banUser(adminCaller, ghostUser, {})),
  ),
  userRow("unbanUser", "canBanUsers", ({ admin, ghostUser }) =>
    outcome(admin.unbanUser(adminCaller, ghostUser)),
  ),
  userRow("deleteUser", "canDeleteUsers", ({ accounts, ghostUser }) =>
    outcome(accounts.deleteUser(adminCaller, ghostUser)),
  ),
  userRow("setUserEmail", "canManageCredentials", ({ accounts, ghostUser }) =>
    outcome(accounts.setUserEmail(adminCaller, ghostUser, { email: "new@example.com" })),
  ),
  userRow("setUserPassword", "canManageCredentials", ({ accounts, ghostUser }) =>
    outcome(
      accounts.setUserPassword(adminCaller, ghostUser, {
        password: Redacted.make("a brand new strong password"),
      }),
    ),
  ),
  {
    name: "listOrganizations",
    predicate: "canAdministerTenants",
    kind: "organizations",
    denial: "AdminActionDenied",
    passed: "ok",
    run: ({ tenants }) => outcome(tenants.listOrganizations(adminCaller)),
  },
  {
    name: "getOrganization",
    predicate: "canAdministerTenants",
    kind: "organization",
    denial: "AdminActionDenied",
    passed: "AdminOrganizationNotFound",
    run: ({ tenants, ghostOrg }) => outcome(tenants.getOrganization(adminCaller, ghostOrg)),
  },
  {
    name: "suspendOrganization",
    predicate: "canAdministerTenants",
    kind: "organization",
    denial: "AdminActionDenied",
    passed: "AdminOrganizationNotFound",
    run: ({ tenants, ghostOrg }) => outcome(tenants.suspendOrganization(adminCaller, ghostOrg, {})),
  },
  {
    name: "unsuspendOrganization",
    predicate: "canAdministerTenants",
    kind: "organization",
    denial: "AdminActionDenied",
    passed: "AdminOrganizationNotFound",
    run: ({ tenants, ghostOrg }) => outcome(tenants.unsuspendOrganization(adminCaller, ghostOrg)),
  },
  {
    name: "impersonate",
    predicate: "canImpersonate",
    kind: "impersonate",
    denial: "AdminImpersonationDenied",
    passed: "AdminTargetNotFound",
    run: ({ admin, ghostUser }) =>
      outcome(admin.impersonate({ caller: adminCaller, targetUserId: ghostUser, reason: "x" })),
  },
  {
    name: "forceStop",
    predicate: "canManageEpisode",
    kind: "episode",
    denial: "AdminImpersonationDenied",
    passed: "ok",
    run: ({ admin, seedEpisode }) =>
      Effect.flatMap(seedEpisode, (sessionId) => outcome(admin.forceStop(adminCaller, sessionId))),
  },
  {
    name: "list",
    predicate: "canManageEpisode",
    kind: "episode",
    denial: "empty",
    passed: "ok",
    run: ({ admin }) =>
      Effect.map(admin.list(adminCaller), (page) => (page.items.length > 0 ? "ok" : "empty")),
  },
];

// ---- running every row in one scenario -------------------------------------------------------------

interface Scenario {
  /** Row name -> outcome. */
  readonly outcomes: Record<string, string>;
  /** `auth.admin.actionDenied.action` / `impersonationDenied.operation`, in publication order. */
  readonly denials: ReadonlyArray<string>;
}

/**
 * Builds a fresh composition with `build` as the build-time configuration, then runs every row in
 * order with the request configuration `request` provided (the tenant's `Admin.config(...)`, as the
 * tenant middleware does) or none, inside `tenant` when named.
 */
const scenario = (options: {
  readonly build: Partial<Admin.AdminConfigShape>;
  readonly request?: Partial<Admin.AdminConfigShape>;
  readonly tenant?: string;
  readonly only?: (row: Row) => boolean;
}) =>
  Effect.gen(function* () {
    const admin = yield* Admin.Admin;
    const accounts = yield* AdminAccounts.AdminAccounts;
    const tenants = yield* AdminTenants.AdminTenants;
    const records = yield* ImpersonationRecords.ImpersonationRecords;
    const events = yield* AuthEvents.AuthEvents;
    const seen = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* events.stream.pipe(
      Stream.runForEach((event) =>
        event._tag === "auth.admin.actionDenied"
          ? Ref.update(seen, (all) => [...all, event.action])
          : event._tag === "auth.admin.impersonationDenied"
            ? Ref.update(seen, (all) => [...all, event.operation])
            : Effect.void,
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    const ghostUser = Users.UserId("ghost-user");
    let counter = 0;
    const seedEpisode = Effect.suspend(() => {
      counter += 1;
      const sessionId = `episode-${counter}`;
      return Effect.map(
        Effect.flatMap(DateTime.now, (now) =>
          records.create({
            adminUserId: Users.UserId("admin-1"),
            targetUserId: ghostUser,
            sessionId,
            reason: "seed",
            expiresAt: DateTime.addDuration(now, Duration.days(1)),
          }),
        ),
        () => sessionId,
      );
    });
    const env: Env = { admin, accounts, tenants, ghostUser, ghostOrg: "ghost-org", seedEpisode };
    // `list` needs a row to show, in the scenario's own tenant.
    yield* options.tenant === undefined
      ? seedEpisode
      : Tenant.withTenant(options.tenant)(seedEpisode);
    const withScope = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
      const scoped =
        options.tenant === undefined ? effect : Tenant.withTenant(options.tenant)(effect);
      return options.request === undefined
        ? scoped
        : scoped.pipe(Effect.provide(Admin.config(options.request)));
    };
    const outcomes: Record<string, string> = {};
    for (const row of rows) {
      if (options.only !== undefined && !options.only(row)) continue;
      outcomes[row.name] = yield* withScope(row.run(env));
    }
    yield* TestClock.adjust(Duration.millis(10));
    return { outcomes, denials: yield* Ref.get(seen) } satisfies Scenario;
  }).pipe(Effect.scoped, Effect.provide(buildLayer(options.build)));

const expectedFor = (row: Row, opens: boolean) => (opens ? row.passed : row.denial);

// ---- tests ---------------------------------------------------------------------------------------

describe("the admin gate (plan 13)", () => {
  it.effect(
    "BEH-EA-221/224/237, BEH-EA-212/218: every gated operation is fail-closed by default and publishes exactly one denial naming the action",
    () =>
      Effect.gen(function* () {
        const result = yield* scenario({ build: {} });
        for (const row of rows) {
          assert.strictEqual(result.outcomes[row.name], row.denial, row.name);
        }
        // `list` is a filter: no event, an empty page.
        assert.deepStrictEqual(
          result.denials,
          rows.filter((row) => row.name !== "list").map((row) => row.name),
        );
      }),
  );

  it.effect(
    "BEH-EA-212/218: a denied impersonate issues no session; IDS-006 names the target",
    () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const admin = yield* Admin.Admin;
        const events = yield* AuthEvents.AuthEvents;
        const seen = yield* Ref.make<ReadonlyArray<AuthEvents.AuthEvent>>([]);
        yield* events.stream.pipe(
          Stream.runForEach((event) => Ref.update(seen, (all) => [...all, event])),
          Effect.forkScoped({ startImmediately: true }),
        );
        const target = yield* users.create({
          identity: { _tag: "Email", email: "target@example.com" },
          name: "Target",
        });
        const failure = yield* admin
          .impersonate({ caller: adminCaller, targetUserId: target.id, reason: "x" })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "AdminImpersonationDenied");
        assert.strictEqual((yield* sessions.list(target.id)).length, 0);
        yield* TestClock.adjust(Duration.millis(10));
        const denied = (yield* Ref.get(seen)).flatMap((event) =>
          event._tag === "auth.admin.impersonationDenied" ? [event] : [],
        );
        assert.strictEqual(denied.length, 1);
        assert.strictEqual(denied[0]?.operation, "impersonate");
        assert.strictEqual(denied[0]?.targetUserId, target.id);
      }).pipe(Effect.scoped, Effect.provide(buildLayer({}))),
  );

  it.effect(
    "BEH-EA-217: a denied forceStop names the session and target and leaves the episode live",
    () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const admin = yield* Admin.Admin;
        const records = yield* ImpersonationRecords.ImpersonationRecords;
        const events = yield* AuthEvents.AuthEvents;
        const seen = yield* Ref.make<ReadonlyArray<AuthEvents.AuthEvent>>([]);
        yield* events.stream.pipe(
          Stream.runForEach((event) => Ref.update(seen, (all) => [...all, event])),
          Effect.forkScoped({ startImmediately: true }),
        );
        const target = yield* users.create({
          identity: { _tag: "Email", email: "target@example.com" },
          name: "Target",
        });
        const issued = yield* sessions.issue({ userId: target.id });
        yield* records.create({
          adminUserId: Users.UserId("admin-1"),
          targetUserId: target.id,
          sessionId: issued.session.id,
          reason: "seed",
          expiresAt: DateTime.addDuration(yield* DateTime.now, Duration.days(1)),
        });
        const failure = yield* admin.forceStop(adminCaller, issued.session.id).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "AdminImpersonationDenied");
        assert.strictEqual((yield* sessions.verify(issued.token)).session.id, issued.session.id);
        yield* TestClock.adjust(Duration.millis(10));
        const denied = (yield* Ref.get(seen)).flatMap((event) =>
          event._tag === "auth.admin.impersonationDenied" ? [event] : [],
        );
        assert.strictEqual(denied[0]?.operation, "forceStop");
        assert.strictEqual(denied[0]?.sessionId, issued.session.id);
        assert.strictEqual(denied[0]?.targetUserId, target.id);
      }).pipe(Effect.scoped, Effect.provide(buildLayer({}))),
  );

  it.effect("BEH-EA-221: each operation opens on its own predicate and on no other", () =>
    Effect.gen(function* () {
      for (const predicate of predicates) {
        const result = yield* scenario({ build: only(predicate) });
        for (const row of rows) {
          assert.strictEqual(
            result.outcomes[row.name],
            expectedFor(row, row.predicate === predicate),
            `${row.name} under only ${predicate}`,
          );
        }
      }
    }),
  );

  it.effect("BEH-EA-221, IDS-003: the gate runs before existence", () =>
    Effect.gen(function* () {
      const closed = yield* scenario({ build: {} });
      const open = yield* scenario({ build: allowAll });
      for (const row of rows.filter((candidate) => candidate.passed !== "ok")) {
        // A refused caller never learns whether the id exists ...
        assert.strictEqual(closed.outcomes[row.name], row.denial, row.name);
        // ... a gate-passing caller does.
        assert.strictEqual(open.outcomes[row.name], row.passed, row.name);
      }
    }),
  );

  it.effect(
    "BEH-EA-236: with no tenant configuration the build-time value applies exactly as before",
    () =>
      Effect.gen(function* () {
        const result = yield* scenario({ build: allowAll });
        for (const row of rows) {
          assert.strictEqual(result.outcomes[row.name], row.passed, row.name);
        }
      }),
  );

  it.effect(
    "ADR-EA-018 D8, BEH-EA-236: a tenant's configuration opens a deny-all build, per predicate",
    () =>
      Effect.gen(function* () {
        for (const predicate of predicates) {
          const opened = yield* scenario({ build: {}, request: only(predicate) });
          const other = yield* scenario({ build: {}, request: {} });
          for (const row of rows) {
            assert.strictEqual(
              opened.outcomes[row.name],
              expectedFor(row, row.predicate === predicate),
              `${row.name} opened by ${predicate}`,
            );
            assert.strictEqual(other.outcomes[row.name], row.denial, `${row.name} in tenant other`);
          }
        }
      }),
  );

  it.effect(
    "ADR-EA-018 D8, BEH-EA-236: a tenant's configuration tightens a permissive build, per predicate",
    () =>
      Effect.gen(function* () {
        for (const predicate of predicates) {
          // The tenant keeps everything except `predicate`.
          const keeps: Partial<Admin.AdminConfigShape> = {
            ...allowAll,
            ...Object.fromEntries([[predicate, deny]]),
          };
          const tightened = yield* scenario({ build: allowAll, request: keeps });
          for (const row of rows) {
            assert.strictEqual(
              tightened.outcomes[row.name],
              expectedFor(row, row.predicate !== predicate),
              `${row.name} under a tenant that withdraws ${predicate}`,
            );
          }
        }
        const nothing = yield* scenario({ build: allowAll, request: {} });
        for (const row of rows) {
          assert.strictEqual(nothing.outcomes[row.name], row.denial, row.name);
        }
      }),
  );

  it.effect("ADR-EA-018 D8: a tightening tenant leaves the account in place (deleteUser)", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const accounts = yield* AdminAccounts.AdminAccounts;
      const target = yield* users.create({
        identity: { _tag: "Email", email: "target@example.com" },
        name: "Target",
      });
      const refused = yield* accounts
        .deleteUser(adminCaller, target.id)
        .pipe(Effect.provide(Admin.config({})), Effect.flip);
      assert.strictEqual(refused._tag, "AdminActionDenied");
      assert.strictEqual((yield* users.findById(target.id)).id, target.id);
    }).pipe(Effect.provide(buildLayer({ canDeleteUsers: allow }))),
  );

  it.effect(
    "BEH-EA-221, IDS-001/002: each predicate sees the identity-only admin, the target and the ambient tenant",
    () =>
      Effect.gen(function* () {
        const calls: Array<Call> = [];
        const row = (name: string) => {
          const found = rows.find((candidate) => candidate.name === name);
          assert.isDefined(found, name);
          return found;
        };
        const run = (name: string) =>
          scenario({ build: capturing(calls), tenant: "org-a", only: (r) => r.name === name });
        for (const name of rows.map((r) => r.name)) {
          calls.length = 0;
          yield* run(name);
          const kind = row(name)?.kind;
          const gateCalls = calls.filter(
            (call) => !(call.predicate === "canAdministerTenants" && kind === "episode"),
          );
          switch (kind) {
            case "users":
            case "user": {
              assert.strictEqual(gateCalls.length, 1, name);
              const [call] = gateCalls;
              assert.isTrue(
                call?.predicate === "canManageUsers" ||
                  call?.predicate === "canBanUsers" ||
                  call?.predicate === "canDeleteUsers" ||
                  call?.predicate === "canManageCredentials",
                name,
              );
              if (
                call?.predicate === "canManageUsers" ||
                call?.predicate === "canBanUsers" ||
                call?.predicate === "canDeleteUsers" ||
                call?.predicate === "canManageCredentials"
              ) {
                assert.strictEqual(call.input.admin.id, "admin-1", name);
                assert.deepStrictEqual(
                  Option.map(call.input.target, (subject) => subject.id),
                  kind === "users" ? Option.none() : Option.some("ghost-user"),
                  name,
                );
                assert.deepStrictEqual(call.input.tenantId, Option.some("org-a"), name);
              }
              break;
            }
            case "organizations":
            case "organization": {
              assert.strictEqual(gateCalls.length, 1, name);
              const [call] = gateCalls;
              assert.strictEqual(call?.predicate, "canAdministerTenants", name);
              if (call?.predicate === "canAdministerTenants") {
                assert.strictEqual(call.input.admin.id, "admin-1", name);
                assert.deepStrictEqual(
                  call.input.organizationId,
                  kind === "organizations" ? Option.none() : Option.some("ghost-org"),
                  name,
                );
              }
              break;
            }
            case "impersonate": {
              assert.strictEqual(gateCalls.length, 1, name);
              const [call] = gateCalls;
              assert.strictEqual(call?.predicate, "canImpersonate", name);
              if (call?.predicate === "canImpersonate") {
                assert.strictEqual(call.input.admin.id, "admin-1");
                assert.strictEqual(call.input.target.id, "ghost-user");
                assert.deepStrictEqual(call.input.tenantId, Option.some("org-a"));
              }
              break;
            }
            case "episode": {
              // The scope check names no organization; the per-episode gate shows the row.
              assert.isTrue(
                calls.some(
                  (call) =>
                    call.predicate === "canAdministerTenants" &&
                    Option.isNone(call.input.organizationId),
                ),
                name,
              );
              const episodeCalls = gateCalls.filter(
                (call) => call.predicate === "canManageEpisode",
              );
              assert.isAbove(episodeCalls.length, 0, name);
              for (const call of episodeCalls) {
                if (call.predicate === "canManageEpisode") {
                  assert.strictEqual(call.input.admin.id, "admin-1");
                  assert.strictEqual(call.input.episode.targetUserId, "ghost-user");
                }
              }
              break;
            }
          }
        }
      }),
  );

  it.effect(
    "IDS-001: canManageEpisode defaults to canImpersonate against the episode's own tenant",
    () =>
      Effect.gen(function* () {
        const seenTenants: Array<Option.Option<string>> = [];
        const result = yield* scenario({
          build: {
            canImpersonate: ({ tenantId }) =>
              Effect.sync(() => {
                seenTenants.push(tenantId);
                return true;
              }),
          },
          tenant: "org-a",
          only: (r) => r.name === "list",
        });
        assert.strictEqual(result.outcomes["list"], "ok");
        assert.deepStrictEqual(seenTenants, [Option.some("org-a")]);
      }),
  );

  it.effect(
    "BEH-EA-236: the non-gate configuration is read per operation, from the configuration that authorized the call",
    () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const accounts = yield* AdminAccounts.AdminAccounts;
        const admin = yield* Admin.Admin;
        const mailer = yield* Mailer.Mailer;
        const target = yield* users.create({
          identity: { _tag: "Email", email: "target@example.com" },
          name: "Target",
        });
        const ops = Admin.config({
          canImpersonate: allow,
          canManageCredentials: allow,
          maxDuration: Duration.minutes(5),
          passwordPolicy: (password) =>
            Effect.succeed(/\d/.test(Redacted.value(password)) ? [] : ["must contain a digit"]),
          links: { changeEmail: (token) => `https://ops.example/confirm?token=${token}` },
        });
        // maxDuration: the impersonation session expires at the tenant's ceiling.
        const issued = yield* admin
          .impersonate({ caller: adminCaller, targetUserId: target.id, reason: "x" })
          .pipe(Effect.provide(ops));
        const now = yield* DateTime.now;
        assert.strictEqual(
          DateTime.toEpochMillis(issued.session.absoluteExpiresAt) - DateTime.toEpochMillis(now),
          Duration.toMillis(Duration.minutes(5)),
        );
        // passwordPolicy: refuses with the tenant's hints.
        const weak = yield* accounts
          .setUserPassword(adminCaller, target.id, {
            password: Redacted.make("a thirty character password no digit"),
          })
          .pipe(Effect.provide(ops), Effect.flip);
        assert.strictEqual(weak._tag, "AdminWeakPassword");
        if (weak._tag === "AdminWeakPassword") {
          assert.deepStrictEqual(weak.hints, ["must contain a digit"]);
        }
        // links.changeEmail: the mailed URL.
        yield* accounts
          .setUserEmail(adminCaller, target.id, { email: "new@example.com" })
          .pipe(Effect.provide(ops));
        const mail = (yield* mailer.sent)[0];
        assert.match(String(mail?.data?.["url"]), /^https:\/\/ops\.example\/confirm\?token=/);
      }).pipe(Effect.scoped, Effect.provide(buildLayer({}))),
  );

  it.effect(
    "IDS-002: only canAdministerTenants lifts the tenant confinement, and a tenant's configuration may withdraw it",
    () =>
      Effect.gen(function* () {
        const admin = yield* Admin.Admin;
        const superadmin = asCaller("superadmin-1");
        const users = yield* Users.Users;
        const records = yield* ImpersonationRecords.ImpersonationRecords;
        const target = yield* users.create({
          identity: { _tag: "Email", email: "t@example.com" },
          name: "t",
        });
        const expiresAt = DateTime.addDuration(yield* DateTime.now, Duration.days(1));
        const make = (tenant: string, sessionId: string) =>
          records
            .create({
              adminUserId: Users.UserId("superadmin-1"),
              targetUserId: target.id,
              sessionId,
              reason: tenant,
              expiresAt,
            })
            .pipe(Tenant.withTenant(tenant));
        yield* make("org-a", "s-a");
        yield* make("org-b", "s-b");
        const listed = (request?: Partial<Admin.AdminConfigShape>) =>
          Effect.map(
            admin
              .list(superadmin)
              .pipe(
                Tenant.withTenant("org-a"),
                request === undefined ? (effect) => effect : Effect.provide(Admin.config(request)),
              ),
            (page) => page.items.map((row) => row.sessionId).sort(),
          );
        assert.deepStrictEqual(yield* listed(), ["s-a", "s-b"]);
        // The tenant's own configuration withdraws the lift.
        assert.deepStrictEqual(yield* listed({ canManageEpisode: allow }), ["s-a"]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          buildLayer({
            canAdministerTenants: ({ admin }) => Effect.succeed(admin.id === "superadmin-1"),
            canManageEpisode: allow,
          }),
        ),
      ),
  );
});

// ---- the production path: a tenant's `Admin.config(...)` served by a LayerMap -----------------------

/** The application's own map: tenant "ops" keeps deletion and credentials; every other tenant keeps nothing. */
class TenantConfig extends LayerMap.Service<TenantConfig>()("test/AdminGateTenantConfig", {
  lookup: (tenantId: string) =>
    Layer.merge(
      tenantId === "ops"
        ? Admin.config({
            canDeleteUsers: allow,
            canManageCredentials: allow,
            canManageUsers: allow,
          })
        : Admin.config({}),
      Tenant.configApplied(tenantId),
    ),
  idleTimeToLive: "1 minute",
}) {}

const inTenant = (tenantId: string) => Effect.provide(TenantConfig.get(tenantId));

describe("ADR-EA-018 D8: a LayerMap of per-tenant Admin.config governs all three plugins", () => {
  it.effect("a tenant tightens, another opens, the build-time value is the fallback", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const accounts = yield* AdminAccounts.AdminAccounts;
      const admin = yield* Admin.Admin;
      const target = yield* users.create({
        identity: { _tag: "Email", email: "target@example.com" },
        name: "Target",
      });
      const hasher = yield* PasswordHasher.PasswordHasher;
      yield* (yield* Accounts.Accounts).link({
        userId: target.id,
        providerId: Accounts.PASSWORD_PROVIDER_ID,
        subject: target.id,
        credentialHash: Redacted.make(
          yield* hasher.hash(Redacted.make("the old password of the target")),
        ),
      });
      const refused = yield* accounts
        .deleteUser(adminCaller, target.id)
        .pipe(inTenant("other"), Effect.flip);
      assert.strictEqual(refused._tag, "AdminActionDenied");
      assert.strictEqual((yield* users.findById(target.id)).id, target.id);
      const ghost = yield* accounts
        .setUserPassword(adminCaller, Users.UserId("ghost"), {
          password: Redacted.make("whatever 1 password"),
        })
        .pipe(inTenant("ops"), Effect.flip);
      assert.strictEqual(ghost._tag, "AdminTargetNotFound");
      const items = yield* admin.effectiveConfig(adminCaller).pipe(inTenant("ops"));
      assert.isAbove(items.length, 0);
      const noTenant = yield* admin.effectiveConfig(adminCaller).pipe(Effect.flip);
      assert.strictEqual(noTenant._tag, "AdminActionDenied");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(buildLayer({ canDeleteUsers: allow }), TenantConfig.layer)),
    ),
  );
});

// ---- predicate capture (test "each predicate sees ...") --------------------------------------------

type Call =
  | { readonly predicate: "canManageUsers"; readonly input: Admin.UserAdminGateInput }
  | { readonly predicate: "canBanUsers"; readonly input: Admin.UserAdminGateInput }
  | { readonly predicate: "canDeleteUsers"; readonly input: Admin.UserAdminGateInput }
  | { readonly predicate: "canManageCredentials"; readonly input: Admin.UserAdminGateInput }
  | { readonly predicate: "canAdministerTenants"; readonly input: Admin.TenantAdminGateInput }
  | { readonly predicate: "canImpersonate"; readonly input: Admin.ImpersonationGateInput }
  | { readonly predicate: "canManageEpisode"; readonly input: Admin.EpisodeGateInput };

/** Every predicate records what it was asked and then allows. */
const capturing = (calls: Array<Call>): Partial<Admin.AdminConfigShape> => ({
  canManageUsers: (input) =>
    Effect.sync(() => {
      calls.push({ predicate: "canManageUsers", input });
      return true;
    }),
  canBanUsers: (input) =>
    Effect.sync(() => {
      calls.push({ predicate: "canBanUsers", input });
      return true;
    }),
  canDeleteUsers: (input) =>
    Effect.sync(() => {
      calls.push({ predicate: "canDeleteUsers", input });
      return true;
    }),
  canManageCredentials: (input) =>
    Effect.sync(() => {
      calls.push({ predicate: "canManageCredentials", input });
      return true;
    }),
  canAdministerTenants: (input) =>
    Effect.sync(() => {
      calls.push({ predicate: "canAdministerTenants", input });
      return true;
    }),
  canImpersonate: (input) =>
    Effect.sync(() => {
      calls.push({ predicate: "canImpersonate", input });
      return true;
    }),
  canManageEpisode: (input) =>
    Effect.sync(() => {
      calls.push({ predicate: "canManageEpisode", input });
      return true;
    }),
});
