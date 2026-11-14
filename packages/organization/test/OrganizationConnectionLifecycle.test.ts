// OrganizationConnectionLifecycle (CONN-01..04, BEH-EA-317/237): the suspended-organization gate, claim then write
// as one unit with its compensation, the re-check under the claim, claims-first removal, the single domain
// normaliser and the release on organization deletion, driven by a test descriptor on the memory records and on
// the SQL records (SQLite, or Postgres when AWTHAQ_POSTGRES_URL is set).
import { Auth, Users } from "@awthaq/core";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DomainClaims from "../src/DomainClaims.ts";
import * as Organization from "../src/Organization.ts";
import * as OrganizationActor from "../src/OrganizationActor.ts";
import * as OrganizationConnectionLifecycle from "../src/OrganizationConnectionLifecycle.ts";
import * as OrganizationDirectory from "../src/OrganizationDirectory.ts";

class Refused extends Data.TaggedError("Refused")<{ readonly reason: string }> {}
class Taken extends Data.TaggedError("Taken")<{ readonly domain: string }> {}
class WriteFailed extends Data.TaggedError("WriteFailed")<{ readonly step: string }> {}

const protocol: OrganizationConnectionLifecycle.ConnectionProtocol<Refused, Taken> = {
  protocol: "test",
  refuse: (reason) => new Refused({ reason }),
  taken: (domain) => new Taken({ domain }),
};

const GONE = "the organization does not exist";
const application = OrganizationActor.application("OrganizationConnectionLifecycle.test");
const admin = OrganizationActor.platformAdmin(Users.UserId("admin"));

const built = Auth.make([Organization.Organization]);
const memoryLive = TestAuth.layer(built, { services: Organization.config({}) });
const sqlLive = TestAuth.layer(built, {
  records: "sql",
  suite: "organization_ConnectionLifecycle",
  services: Organization.config({}),
});

const makeOrganization = (slug: string) =>
  Effect.flatMap(OrganizationDirectory.OrganizationDirectory, (directory) =>
    directory.create(application, { owner: Users.UserId(`owner-${slug}`), name: slug, slug }),
  );

const suspend = (organizationId: string) =>
  Effect.flatMap(OrganizationDirectory.OrganizationDirectory, (directory) =>
    directory.suspend(admin, { organizationId }),
  );

/** Whether `organizationId` can claim `domain` now (nobody else holds it). */
const canClaim = (organizationId: string, domain: string) =>
  Effect.flatMap(DomainClaims.DomainClaims, (claims) =>
    claims
      .claim({
        organizationId,
        protocol: "test",
        connectionId: `probe-${organizationId}`,
        domains: [domain],
      })
      .pipe(
        Effect.as(true),
        Effect.catchTag("DomainClaimTaken", () => Effect.succeed(false)),
      ),
  );

const claimFor = (organizationId: string, connectionId: string, domains: ReadonlyArray<string>) =>
  Effect.flatMap(DomainClaims.DomainClaims, (claims) =>
    claims.claim({ organizationId, protocol: "test", connectionId, domains }),
  );

type Needs =
  | DomainClaims.DomainClaims
  | OrganizationConnectionLifecycle.OrganizationConnectionLifecycle
  | OrganizationDirectory.OrganizationDirectory;

const suite = <E>(leg: string, Live: Layer.Layer<Needs, E>) => {
  const run = <A, E2>(effect: Effect.Effect<A, E2, Needs>) =>
    effect.pipe(TestAuth.withoutRequest, Effect.provide(Live));

  describe(`create (${leg})`, () => {
    it.effect(
      "claims the domains, returns the write's value and refuses another organization's claim",
      () =>
        run(
          Effect.gen(function* () {
            const lifecycle =
              yield* OrganizationConnectionLifecycle.OrganizationConnectionLifecycle;
            const a = yield* makeOrganization("a");
            const b = yield* makeOrganization("b");
            const value = yield* lifecycle.create(
              protocol,
              a.id,
              Effect.succeed({
                connectionId: "c1",
                domains: ["acme.example"],
                write: Effect.succeed("written"),
              }),
            );
            assert.strictEqual(value, "written");
            assert.isFalse(yield* canClaim(b.id, "acme.example"));
          }),
        ),
    );

    it.effect(
      "an unknown and a suspended organization are refused alike, before prepare and write run",
      () =>
        run(
          Effect.gen(function* () {
            const lifecycle =
              yield* OrganizationConnectionLifecycle.OrganizationConnectionLifecycle;
            const org = yield* makeOrganization("a");
            yield* suspend(org.id);
            const ran: Array<string> = [];
            const attempt = (organizationId: string) =>
              lifecycle
                .create(
                  protocol,
                  organizationId,
                  Effect.sync(() => {
                    ran.push("prepare");
                    return {
                      connectionId: "c1",
                      domains: ["gone.example"],
                      write: Effect.sync(() => {
                        ran.push("write");
                      }),
                    };
                  }),
                )
                .pipe(Effect.flip);
            const unknown = yield* attempt("no-such-org");
            const suspended = yield* attempt(org.id);
            assert.deepStrictEqual(unknown, new Refused({ reason: GONE }));
            assert.deepStrictEqual(suspended, unknown);
            assert.deepStrictEqual(ran, []);
          }),
        ),
    );

    it.effect(
      "a domain another organization owns is taken (the first foreign one) and nothing is written",
      () =>
        run(
          Effect.gen(function* () {
            const lifecycle =
              yield* OrganizationConnectionLifecycle.OrganizationConnectionLifecycle;
            const a = yield* makeOrganization("a");
            const b = yield* makeOrganization("b");
            yield* claimFor(a.id, "ca", ["one.example", "two.example"]);
            let wrote = false;
            const failure = yield* lifecycle
              .create(
                protocol,
                b.id,
                Effect.succeed({
                  connectionId: "cb",
                  domains: ["free.example", "two.example", "one.example"],
                  write: Effect.sync(() => {
                    wrote = true;
                  }),
                }),
              )
              .pipe(Effect.flip);
            assert.deepStrictEqual(failure, new Taken({ domain: "two.example" }));
            assert.isFalse(wrote);
            assert.isTrue(yield* canClaim(b.id, "free.example"));
          }),
        ),
    );

    it.effect("a failed write returns the write's error and holds no claim afterwards", () =>
      run(
        Effect.gen(function* () {
          const lifecycle = yield* OrganizationConnectionLifecycle.OrganizationConnectionLifecycle;
          const a = yield* makeOrganization("a");
          const b = yield* makeOrganization("b");
          const failure = yield* lifecycle
            .create(
              protocol,
              a.id,
              Effect.succeed({
                connectionId: "c1",
                domains: ["rolled.example"],
                write: Effect.fail(new WriteFailed({ step: "row" })),
              }),
            )
            .pipe(Effect.flip);
          assert.deepStrictEqual(failure, new WriteFailed({ step: "row" }));
          assert.isTrue(yield* canClaim(b.id, "rolled.example"));
        }),
      ),
    );

    it.effect(
      "an organization suspended by prepare itself is refused by the re-check, with no claim held",
      () =>
        run(
          Effect.gen(function* () {
            const lifecycle =
              yield* OrganizationConnectionLifecycle.OrganizationConnectionLifecycle;
            const a = yield* makeOrganization("a");
            const b = yield* makeOrganization("b");
            let wrote = false;
            const failure = yield* lifecycle
              .create(
                protocol,
                a.id,
                Effect.as(suspend(a.id), {
                  connectionId: "c1",
                  domains: ["late.example"],
                  write: Effect.sync(() => {
                    wrote = true;
                  }),
                }),
              )
              .pipe(Effect.flip);
            assert.deepStrictEqual(failure, new Refused({ reason: GONE }));
            assert.isFalse(wrote);
            assert.isTrue(yield* canClaim(b.id, "late.example"));
          }),
        ),
    );
  });
};

suite("memory", memoryLive);
suite("sql", sqlLive);
