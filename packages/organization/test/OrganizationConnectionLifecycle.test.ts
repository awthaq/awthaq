// OrganizationConnectionLifecycle (CONN-01..04, BEH-EA-317/237): the suspended-organization gate, claim then write
// as one unit with its compensation, the re-check under the claim, claims-first removal, the single domain
// normaliser and the release on organization deletion, driven by a test descriptor on the memory records and on
// the SQL records (SQLite, or Postgres when AWTHAQ_POSTGRES_URL is set).
import { AuditLog, Auth, Users } from "@awthaq/core";
import { StoreFailure } from "@awthaq/sql";
import type { SqlTransaction } from "@awthaq/ports";
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
class NotFound extends Data.TaggedError("NotFound")<{ readonly id: string }> {}

const protocol: OrganizationConnectionLifecycle.ConnectionProtocol<Refused, Taken> = {
  protocol: "test",
  refuse: (reason) => new Refused({ reason }),
  taken: (domain) => new Taken({ domain }),
  isGone: (error) => error instanceof NotFound,
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
  | AuditLog.AuditLog
  | DomainClaims.DomainClaims
  | OrganizationConnectionLifecycle.OrganizationConnectionLifecycle
  | OrganizationDirectory.OrganizationDirectory
  | SqlTransaction.SqlTransaction;

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

  describe(`update (${leg})`, () => {
    const connect = (
      organizationId: string,
      connectionId: string,
      domains: ReadonlyArray<string>,
    ) =>
      Effect.flatMap(OrganizationConnectionLifecycle.OrganizationConnectionLifecycle, (lifecycle) =>
        lifecycle.create(
          protocol,
          organizationId,
          Effect.succeed({ connectionId, domains, write: Effect.void }),
        ),
      );

    it.effect("an unknown and a suspended organization are refused before prepare runs", () =>
      run(
        Effect.gen(function* () {
          const lifecycle = yield* OrganizationConnectionLifecycle.OrganizationConnectionLifecycle;
          const org = yield* makeOrganization("a");
          yield* suspend(org.id);
          let prepared = false;
          const attempt = (organizationId: string) =>
            lifecycle
              .update(
                protocol,
                organizationId,
                Effect.sync(() => {
                  prepared = true;
                  return {
                    connectionId: "c1",
                    domains: undefined,
                    previous: [],
                    write: Effect.void,
                  };
                }),
              )
              .pipe(Effect.flip);
          assert.deepStrictEqual(yield* attempt("no-such-org"), new Refused({ reason: GONE }));
          assert.deepStrictEqual(yield* attempt(org.id), new Refused({ reason: GONE }));
          assert.isFalse(prepared);
        }),
      ),
    );

    it.effect("an update naming no domains runs only the write and touches no claim", () =>
      run(
        Effect.gen(function* () {
          const lifecycle = yield* OrganizationConnectionLifecycle.OrganizationConnectionLifecycle;
          const a = yield* makeOrganization("a");
          const b = yield* makeOrganization("b");
          yield* connect(a.id, "c1", ["kept.example"]);
          const value = yield* lifecycle.update(
            protocol,
            a.id,
            Effect.succeed({
              connectionId: "c1",
              domains: undefined,
              previous: ["kept.example"],
              write: Effect.succeed("renamed"),
            }),
          );
          assert.strictEqual(value, "renamed");
          assert.isFalse(yield* canClaim(b.id, "kept.example"));
        }),
      ),
    );

    it.effect("new domains another organization owns are taken, and the previous claim stays", () =>
      run(
        Effect.gen(function* () {
          const lifecycle = yield* OrganizationConnectionLifecycle.OrganizationConnectionLifecycle;
          const a = yield* makeOrganization("a");
          const b = yield* makeOrganization("b");
          yield* connect(a.id, "c1", ["old.example"]);
          yield* claimFor(b.id, "cb", ["theirs.example"]);
          const failure = yield* lifecycle
            .update(
              protocol,
              a.id,
              Effect.succeed({
                connectionId: "c1",
                domains: ["new.example", "theirs.example"],
                previous: ["old.example"],
                write: Effect.void,
              }),
            )
            .pipe(Effect.flip);
          assert.deepStrictEqual(failure, new Taken({ domain: "theirs.example" }));
          assert.isFalse(yield* canClaim(b.id, "old.example"));
          assert.isTrue(yield* canClaim(b.id, "new.example"));
        }),
      ),
    );

    it.effect("a failed write keeps the previous claim and frees the new domains", () =>
      run(
        Effect.gen(function* () {
          const lifecycle = yield* OrganizationConnectionLifecycle.OrganizationConnectionLifecycle;
          const a = yield* makeOrganization("a");
          const b = yield* makeOrganization("b");
          yield* connect(a.id, "c1", ["old.example"]);
          const failure = yield* lifecycle
            .update(
              protocol,
              a.id,
              Effect.succeed({
                connectionId: "c1",
                domains: ["new.example"],
                previous: ["old.example"],
                write: Effect.fail(new WriteFailed({ step: "row" })),
              }),
            )
            .pipe(Effect.flip);
          assert.deepStrictEqual(failure, new WriteFailed({ step: "row" }));
          assert.isFalse(yield* canClaim(b.id, "old.example"));
          assert.isTrue(yield* canClaim(b.id, "new.example"));
        }),
      ),
    );
  });

  describe(`a connection removed meanwhile (${leg})`, () => {
    // The write releases the claims inside the unit to stand for another fiber's committed removal. Over SQL that
    // release is part of the unit and rolls back with it, so only the memory twin (no transaction) can show it.
    (leg === "memory" ? it.effect : it.effect.skip)(
      "an update whose write finds the connection gone (a concurrent removal released its claims) restores no claim",
      () =>
        run(
          Effect.gen(function* () {
            const lifecycle =
              yield* OrganizationConnectionLifecycle.OrganizationConnectionLifecycle;
            const a = yield* makeOrganization("a");
            const b = yield* makeOrganization("b");
            yield* claimFor(a.id, "c1", ["old.example"]);
            const failure = yield* lifecycle
              .update(
                protocol,
                a.id,
                Effect.succeed({
                  connectionId: "c1",
                  domains: ["new.example"],
                  previous: ["old.example"],
                  // The concurrent removal: it releases every claim of the connection and deletes its row.
                  write: Effect.andThen(
                    Effect.flatMap(DomainClaims.DomainClaims, (claims) =>
                      claims.release(a.id, "c1"),
                    ),
                    Effect.fail(new NotFound({ id: "c1" })),
                  ),
                }),
              )
              .pipe(Effect.flip);
            assert.deepStrictEqual(failure, new NotFound({ id: "c1" }));
            assert.isTrue(yield* canClaim(b.id, "old.example"));
            assert.isTrue(yield* canClaim(b.id, "new.example"));
          }),
        ),
    );

    it.effect(
      "an update that claimed after the removal released, then finds the connection gone, leaves no claim",
      () =>
        run(
          Effect.gen(function* () {
            const lifecycle =
              yield* OrganizationConnectionLifecycle.OrganizationConnectionLifecycle;
            const a = yield* makeOrganization("a");
            const b = yield* makeOrganization("b");
            const failure = yield* lifecycle
              .update(
                protocol,
                a.id,
                Effect.succeed({
                  connectionId: "c1",
                  domains: ["new.example"],
                  previous: ["old.example"],
                  write: Effect.fail(new NotFound({ id: "c1" })),
                }),
              )
              .pipe(Effect.flip);
            assert.deepStrictEqual(failure, new NotFound({ id: "c1" }));
            assert.isTrue(yield* canClaim(b.id, "old.example"));
            assert.isTrue(yield* canClaim(b.id, "new.example"));
          }),
        ),
    );

    it.effect("a removal that loses the race to another removal restores no claim", () =>
      run(
        Effect.gen(function* () {
          const lifecycle = yield* OrganizationConnectionLifecycle.OrganizationConnectionLifecycle;
          const a = yield* makeOrganization("a");
          const b = yield* makeOrganization("b");
          // The first removal has released the claims and deleted the row; this one finds neither.
          const failure = yield* lifecycle
            .remove(protocol, a.id, "c1", ["held.example"], Effect.fail(new NotFound({ id: "c1" })))
            .pipe(Effect.flip);
          assert.deepStrictEqual(failure, new NotFound({ id: "c1" }));
          assert.isTrue(yield* canClaim(b.id, "held.example"));
        }),
      ),
    );
  });

  describe(`compensation (${leg})`, () => {
    /** The lifecycle over a `DomainClaims` that counts `claim` calls and makes the nth one (from 1) die. */
    const spied = (dieOnCall: number | undefined) => {
      const calls = { claim: 0 };
      const spy = Layer.effect(
        DomainClaims.DomainClaims,
        Effect.map(DomainClaims.DomainClaims, (inner) => ({
          ...inner,
          claim: (input: DomainClaims.DomainClaim) =>
            Effect.suspend(() => {
              calls.claim += 1;
              return calls.claim === dieOnCall ? Effect.die("claim defect") : inner.claim(input);
            }),
        })),
      );
      const withSpy = <A, E2>(effect: Effect.Effect<A, E2, Needs>) =>
        effect.pipe(
          // `fresh`: the layer is memoised by reference, and the one `Live` built already holds the real claims.
          Effect.provide(
            Layer.fresh(
              OrganizationConnectionLifecycle.OrganizationConnectionLifecycle.layer.pipe(
                Layer.provide(spy),
              ),
            ),
          ),
          TestAuth.withoutRequest,
          Effect.provide(Live),
        );
      return { calls, withSpy };
    };
    const updateWith = (write: Effect.Effect<void, WriteFailed | StoreFailure.StoreUnavailable>) =>
      Effect.gen(function* () {
        const lifecycle = yield* OrganizationConnectionLifecycle.OrganizationConnectionLifecycle;
        const a = yield* makeOrganization("a");
        return yield* lifecycle
          .update(
            protocol,
            a.id,
            Effect.succeed({
              connectionId: "c1",
              domains: ["new.example"],
              previous: ["old.example"],
              write,
            }),
          )
          .pipe(Effect.flip);
      });

    it.effect(
      "a failed write restores the previous claim: one claim for the update, one to restore",
      () => {
        const { calls, withSpy } = spied(undefined);
        return withSpy(updateWith(Effect.fail(new WriteFailed({ step: "row" })))).pipe(
          Effect.tap((failure) =>
            Effect.sync(() => {
              assert.deepStrictEqual(failure, new WriteFailed({ step: "row" }));
              assert.strictEqual(calls.claim, 2);
            }),
          ),
        );
      },
    );

    it.effect(
      "a store outage in the write skips the compensation and is the failure returned",
      () => {
        const { calls, withSpy } = spied(undefined);
        const outage = new StoreFailure.StoreUnavailable({ operation: "write" });
        return withSpy(updateWith(Effect.fail(outage))).pipe(
          Effect.tap((failure) =>
            Effect.sync(() => {
              assert.deepStrictEqual(failure, outage);
              assert.strictEqual(calls.claim, 1);
            }),
          ),
        );
      },
    );

    it.effect("a compensation that dies does not replace the write's own failure", () => {
      const { calls, withSpy } = spied(2);
      return withSpy(updateWith(Effect.fail(new WriteFailed({ step: "row" })))).pipe(
        Effect.tap((failure) =>
          Effect.sync(() => {
            assert.deepStrictEqual(failure, new WriteFailed({ step: "row" }));
            assert.strictEqual(calls.claim, 2);
          }),
        ),
      );
    });
  });

  describe(`remove (${leg})`, () => {
    it.effect(
      "a suspended organization's connection can be removed, its domains freed before the write",
      () =>
        run(
          Effect.gen(function* () {
            const lifecycle =
              yield* OrganizationConnectionLifecycle.OrganizationConnectionLifecycle;
            const a = yield* makeOrganization("a");
            const b = yield* makeOrganization("b");
            yield* claimFor(a.id, "c1", ["gone.example"]);
            yield* suspend(a.id);
            // Claims first: inside the write the domain is already free for another organization.
            const freeInsideWrite = yield* lifecycle.remove(
              protocol,
              a.id,
              "c1",
              ["gone.example"],
              Effect.suspend(() => canClaim(b.id, "gone.example")),
            );
            assert.isTrue(freeInsideWrite);
          }),
        ),
    );

    it.effect("a failed write keeps the domain held", () =>
      run(
        Effect.gen(function* () {
          const lifecycle = yield* OrganizationConnectionLifecycle.OrganizationConnectionLifecycle;
          const a = yield* makeOrganization("a");
          const b = yield* makeOrganization("b");
          yield* claimFor(a.id, "c1", ["held.example"]);
          const failure = yield* lifecycle
            .remove(
              protocol,
              a.id,
              "c1",
              ["held.example"],
              Effect.fail(new WriteFailed({ step: "row" })),
            )
            .pipe(Effect.flip);
          assert.deepStrictEqual(failure, new WriteFailed({ step: "row" }));
          assert.isFalse(yield* canClaim(b.id, "held.example"));
        }),
      ),
    );
  });

  describe(`normalizeDomains and deletion (${leg})`, () => {
    it.effect(
      "trims, lower-cases, de-duplicates in first-seen order and refuses an invalid domain",
      () =>
        Effect.gen(function* () {
          const normalized = yield* OrganizationConnectionLifecycle.normalizeDomains(protocol, [
            " B.Example ",
            "a.example",
            "b.example",
          ]);
          assert.deepStrictEqual(normalized, ["b.example", "a.example"]);
          const bad = yield* OrganizationConnectionLifecycle.normalizeDomains(protocol, [
            "ok.example",
            "bad_domain",
          ]).pipe(Effect.flip);
          assert.deepStrictEqual(
            bad,
            new Refused({ reason: '"bad_domain" is not a valid email domain' }),
          );
        }),
    );

    it.effect("deleting an organization frees every domain its claims held", () =>
      run(
        Effect.gen(function* () {
          const directory = yield* OrganizationDirectory.OrganizationDirectory;
          const a = yield* makeOrganization("a");
          const b = yield* makeOrganization("b");
          yield* claimFor(a.id, "c1", ["one.example"]);
          yield* claimFor(a.id, "c2", ["two.example"]);
          assert.isFalse(yield* canClaim(b.id, "one.example"));
          yield* directory.delete(application, { organizationId: a.id });
          assert.isTrue(yield* canClaim(b.id, "one.example"));
          assert.isTrue(yield* canClaim(b.id, "two.example"));
        }),
      ),
    );

    it.effect("the module publishes no event", () =>
      run(
        Effect.gen(function* () {
          const lifecycle = yield* OrganizationConnectionLifecycle.OrganizationConnectionLifecycle;
          const auditLog = yield* AuditLog.AuditLog;
          const a = yield* makeOrganization("a");
          yield* lifecycle.create(
            protocol,
            a.id,
            Effect.succeed({ connectionId: "c1", domains: ["quiet.example"], write: Effect.void }),
          );
          yield* lifecycle.update(
            protocol,
            a.id,
            Effect.succeed({
              connectionId: "c1",
              domains: ["quieter.example"],
              previous: ["quiet.example"],
              write: Effect.void,
            }),
          );
          yield* lifecycle.remove(protocol, a.id, "c1", ["quieter.example"], Effect.void);
          for (const eventTag of [
            "auth.organization.connectionCreated",
            "auth.organization.connectionUpdated",
            "auth.organization.connectionDeleted",
          ]) {
            assert.strictEqual((yield* auditLog.list({ eventTag })).length, 0);
          }
        }),
      ),
    );
  });
};

suite("memory", memoryLive);
suite("sql", sqlLive);
