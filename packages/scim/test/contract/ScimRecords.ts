// Plan 25 ticket 23 (ADR-EA-041 decision 9): `ScimRecords`' contract, run on memory and SQL (Postgres under
// `pnpm test:pg`) from `Contract.test.ts`, a fresh store per case. BEH-EA-246/242: a connection acts only on what it
// provisioned, and a user's `userName` and a resource's `externalId` are unique per connection and kind (real
// database constraints on SQL, one `Ref.modify` on memory). Plan 24's SCIM link item: linking a resource that is
// already linked is `ScimLinkConflict` on every adapter (memory used to add a second row). These cases replace
// `ScimRecords.test.ts`' bespoke suite and its tenant-isolation run.
import { Tenant } from "@awthaq/ports";
import { TenantScoped } from "@awthaq/sql";
import { RecordsContract, type TestAuth, TestSql } from "@awthaq/test";
import { assert } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scheduler from "effect/Scheduler";
import * as TestClock from "effect/testing/TestClock";
import * as ScimRecords from "../../src/ScimRecords.ts";

/** The witness these cases present where a bearer token, erasure or export would. */
const grant = TenantScoped.crossTenant("scim records contract: a cross-organization caller");

/**
 * Racing fibers yield to the scheduler every few steps, so they interleave between a read and a write.
 * (Effect 4.1.2 stalls with a budget below 4.)
 */
const fineGrained = Effect.provideService(Scheduler.MaxOpsBeforeYield, 4);

/** Races `writers` and returns every outcome. */
const raced = <A, E, R>(writers: ReadonlyArray<Effect.Effect<A, E, R>>) =>
  Effect.all(
    writers.map((writer) => Effect.exit(writer)),
    { concurrency: "unbounded" },
  ).pipe(fineGrained);

const many = <A>(make: (n: number) => A) =>
  Array.from({ length: RecordsContract.CONCURRENCY }, (_, n) => make(n));

/** The field a failed link names, or the tag it failed with ("" for a success or a defect). */
const refusal = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? Option.match(Exit.findErrorOption(exit), {
        onNone: () => "",
        onSome: (error) =>
          error instanceof ScimRecords.ScimLinkConflict ? `conflict:${error.field}` : error._tag,
      })
    : "";

const connection = (id: string, organizationId: string) => ({
  id,
  organizationId,
  name: `Directory ${id}`,
  tokenHash: `hash-${id}`,
});

// ---- plan 05: tenant isolation, once, by the store ----------------------------------------------------
//
// `scim_connection` is Keyed by `organizationId`; `scim_resource` is Derived through its connection. A bearer
// token is the capability that finds a connection before any tenant is known, and erasure and export read a
// person's links in every connection: those take a witness. Everything else on a resource is keyed by a
// connection id the caller already resolved through its token.

interface Row {
  readonly connectionId: string;
  readonly organizationId: string;
  readonly tokenHash: string;
  readonly resourceId: string;
}

let isolationCounter = 0;

const orgOf = (row: Row, as: "owner" | "other") =>
  as === "owner" ? row.organizationId : "another-organization";

const using = <A, E, R>(use: (records: ScimRecords.ScimRecordsShape) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(ScimRecords.ScimRecords, use);

const insertRow = Effect.gen(function* () {
  const records = yield* ScimRecords.ScimRecords;
  isolationCounter += 1;
  const organizationId = yield* Effect.map(
    Tenant.TenantContext,
    Option.getOrElse(() => "platform-organization"),
  );
  const connectionId = `isolation-${isolationCounter}`;
  const tokenHash = `isolation-hash-${isolationCounter}`;
  yield* records.createConnection({
    id: connectionId,
    organizationId,
    name: `Directory ${isolationCounter}`,
    tokenHash,
  });
  const resourceId = `isolation-user-${isolationCounter}`;
  yield* records.link({
    connectionId,
    kind: "User",
    resourceId,
    name: `user-${isolationCounter}`,
  });
  return { connectionId, organizationId, tokenHash, resourceId } satisfies Row;
});

type Methods = TestAuth.TableCase<
  ScimRecords.ScimRecordsShape,
  Row,
  ScimRecords.ScimRecords
>["methods"];

const derivedElsewhere = (table: string) => ({
  derived: `operates on ${table}; classified in that table's case`,
});

const viaConnection = {
  derived: "keyed by a connection id the caller resolved through its bearer token (a Keyed read)",
};

const connectionMethods: Methods = {
  createConnection: { insert: true },
  findConnectionByTokenHash: {
    crossTenant: {
      run: (row) =>
        using((records) =>
          Effect.map(
            records.findConnectionByTokenHash(grant, row.tokenHash),
            (found) => Option.isSome(found) && found.value.id === row.connectionId,
          ),
        ),
    },
  },
  listConnections: {
    keyed: {
      run: (row, as) =>
        using((records) =>
          Effect.map(records.listConnections(orgOf(row, as)), (rows) =>
            rows.some((found) => found.id === row.connectionId),
          ),
        ),
    },
  },
  revokeConnection: {
    keyed: {
      run: (row, as) =>
        using((records) =>
          records.revokeConnection(orgOf(row, as), row.connectionId).pipe(
            Effect.as(true),
            Effect.catchTag("ScimRecordNotFound", () => Effect.succeed(false)),
          ),
        ),
    },
  },
  removeAllForOrganization: {
    keyed: {
      run: (row, as) =>
        using((records) =>
          Effect.gen(function* () {
            yield* records.removeAllForOrganization(orgOf(row, as));
            // Keyed by the organization: only that organization's own connection is gone.
            const remaining = yield* records.listConnections(row.organizationId);
            return !remaining.some((found) => found.id === row.connectionId);
          }),
        ),
    },
  },
  link: derivedElsewhere("scim_resource"),
  find: derivedElsewhere("scim_resource"),
  findByName: derivedElsewhere("scim_resource"),
  findByExternalId: derivedElsewhere("scim_resource"),
  list: derivedElsewhere("scim_resource"),
  setExternalId: derivedElsewhere("scim_resource"),
  unlink: derivedElsewhere("scim_resource"),
  linksOfResource: derivedElsewhere("scim_resource"),
  unlinkResource: derivedElsewhere("scim_resource"),
};

const resourceMethods: Methods = {
  createConnection: { insert: true },
  findConnectionByTokenHash: derivedElsewhere("scim_connection"),
  listConnections: derivedElsewhere("scim_connection"),
  revokeConnection: derivedElsewhere("scim_connection"),
  removeAllForOrganization: derivedElsewhere("scim_connection"),
  link: { insert: true },
  find: viaConnection,
  findByName: viaConnection,
  findByExternalId: viaConnection,
  list: viaConnection,
  setExternalId: viaConnection,
  unlink: viaConnection,
  linksOfResource: {
    crossTenant: {
      run: (row) =>
        using((records) =>
          Effect.map(records.linksOfResource(grant, "User", row.resourceId), (links) =>
            links.some((link) => link.connectionId === row.connectionId),
          ),
        ),
    },
  },
  unlinkResource: {
    crossTenant: {
      run: (row) =>
        using((records) =>
          Effect.gen(function* () {
            const before = yield* records.find(row.connectionId, "User", row.resourceId);
            yield* records.unlinkResource(grant, "User", row.resourceId);
            return (
              Option.isSome(before) &&
              Option.isNone(yield* records.find(row.connectionId, "User", row.resourceId))
            );
          }),
        ),
    },
  },
};

export const scimRecords = RecordsContract.suite(ScimRecords.ScimRecords, {
  operations: {
    createConnection: {
      write: [
        {
          name: "a new connection is live, with its token hash and organization",
          run: Effect.gen(function* () {
            const records = yield* ScimRecords.ScimRecords;
            const created = yield* records.createConnection(connection("c1", "org-1"));
            assert.isTrue(Option.isNone(created.revokedAt));
            assert.strictEqual(created.tokenHash, "hash-c1");
            assert.strictEqual(created.organizationId, "org-1");
          }),
        },
      ],
    },
    findConnectionByTokenHash: {
      read: [
        {
          name: "a connection by its token hash, across organizations; None for an unknown hash",
          run: Effect.gen(function* () {
            const records = yield* ScimRecords.ScimRecords;
            yield* records.createConnection(connection("c1", "org-1"));
            yield* records.createConnection(connection("c2", "org-2"));
            const found = yield* records.findConnectionByTokenHash(grant, "hash-c2");
            assert.isTrue(Option.isSome(found) && found.value.id === "c2");
            assert.isTrue(Option.isNone(yield* records.findConnectionByTokenHash(grant, "nope")));
          }),
        },
      ],
    },
    listConnections: {
      read: [
        {
          name: "per organization, oldest first",
          run: Effect.gen(function* () {
            const records = yield* ScimRecords.ScimRecords;
            yield* records.createConnection(connection("c2", "org-1"));
            yield* TestClock.adjust(Duration.millis(5));
            yield* records.createConnection(connection("c1", "org-1"));
            yield* records.createConnection(connection("c3", "org-2"));
            assert.deepStrictEqual(
              (yield* records.listConnections("org-1")).map((row) => row.id),
              ["c2", "c1"],
            );
          }),
        },
      ],
    },
    revokeConnection: {
      atomic: [
        {
          name: "revocable once: revoking again keeps the first time, and another organization cannot revoke it",
          run: Effect.gen(function* () {
            const records = yield* ScimRecords.ScimRecords;
            yield* records.createConnection(connection("c1", "org-1"));
            const revoked = yield* records.revokeConnection("org-1", "c1");
            assert.isTrue(Option.isSome(revoked.revokedAt));
            yield* TestClock.adjust(Duration.minutes(1));
            const again = yield* records.revokeConnection("org-1", "c1");
            assert.deepStrictEqual(again.revokedAt, revoked.revokedAt);
            const foreign = yield* records.revokeConnection("org-2", "c1").pipe(Effect.flip);
            assert.strictEqual(foreign._tag, "ScimRecordNotFound");
            const missing = yield* records.revokeConnection("org-1", "nope").pipe(Effect.flip);
            assert.strictEqual(missing._tag, "ScimRecordNotFound");
          }),
        },
      ],
      race: [
        {
          name: "8 concurrent revocations all succeed and agree on the one stored revokedAt",
          run: Effect.gen(function* () {
            const records = yield* ScimRecords.ScimRecords;
            yield* records.createConnection(connection("c1", "org-1"));
            const revoked = yield* RecordsContract.race(
              records.revokeConnection("org-1", "c1"),
            ).pipe(fineGrained);
            const stored = Option.getOrThrow(
              yield* records.findConnectionByTokenHash(grant, "hash-c1"),
            );
            assert.isTrue(Option.isSome(stored.revokedAt));
            for (const row of revoked) assert.deepStrictEqual(row.revokedAt, stored.revokedAt);
          }),
        },
      ],
    },
    removeAllForOrganization: {
      write: [
        {
          name: "removes that organization's connections with their links, and nothing else; idempotent",
          run: Effect.gen(function* () {
            const records = yield* ScimRecords.ScimRecords;
            yield* records.createConnection(connection("c1", "org-1"));
            yield* records.createConnection(connection("c2", "org-2"));
            yield* records.link({ connectionId: "c1", kind: "User", resourceId: "u1", name: "a" });
            yield* records.link({ connectionId: "c2", kind: "User", resourceId: "u2", name: "b" });
            yield* records.removeAllForOrganization("org-1");
            assert.deepStrictEqual(yield* records.listConnections("org-1"), []);
            assert.isTrue(Option.isNone(yield* records.find("c1", "User", "u1")));
            assert.strictEqual((yield* records.listConnections("org-2")).length, 1);
            assert.isTrue(Option.isSome(yield* records.find("c2", "User", "u2")));
            yield* records.removeAllForOrganization("org-1");
          }),
        },
      ],
    },
    link: {
      atomic: [
        {
          name: "BEH-EA-246: userName and externalId are unique per connection and kind, never across them",
          run: Effect.gen(function* () {
            const records = yield* ScimRecords.ScimRecords;
            yield* records.link({
              connectionId: "c1",
              kind: "User",
              resourceId: "u1",
              name: "ada@acme.example",
              externalId: "dir-1",
            });
            const sameName = yield* records
              .link({
                connectionId: "c1",
                kind: "User",
                resourceId: "u2",
                name: "ada@acme.example",
              })
              .pipe(Effect.exit);
            assert.strictEqual(refusal(sameName), "conflict:name");
            const sameExternal = yield* records
              .link({
                connectionId: "c1",
                kind: "User",
                resourceId: "u2",
                name: "bo@acme.example",
                externalId: "dir-1",
              })
              .pipe(Effect.exit);
            assert.strictEqual(refusal(sameExternal), "conflict:externalId");
            // Another connection, and another kind, may reuse both.
            yield* records.link({
              connectionId: "c2",
              kind: "User",
              resourceId: "u3",
              name: "ada@acme.example",
              externalId: "dir-1",
            });
            yield* records.link({
              connectionId: "c1",
              kind: "Group",
              resourceId: "g1",
              externalId: "dir-1",
            });
            // Rows with no name/externalId never collide with each other.
            yield* records.link({ connectionId: "c1", kind: "Group", resourceId: "g2" });
            yield* records.link({ connectionId: "c1", kind: "Group", resourceId: "g3" });
            // The failed writes left nothing behind.
            assert.isTrue(Option.isNone(yield* records.find("c1", "User", "u2")));
          }),
        },
        {
          name: "plan 24: a resource already linked is refused (ScimLinkConflict), never a second row",
          run: Effect.gen(function* () {
            const records = yield* ScimRecords.ScimRecords;
            yield* records.link({ connectionId: "c1", kind: "User", resourceId: "u1", name: "a" });
            const twice = yield* records
              .link({ connectionId: "c1", kind: "User", resourceId: "u1", name: "other" })
              .pipe(Effect.exit);
            assert.strictEqual(refusal(twice), "conflict:name");
            const page = yield* records.list("c1", "User", { offset: 0, limit: 10 });
            assert.strictEqual(page.total, 1);
            assert.deepStrictEqual(
              Option.getOrThrow(yield* records.find("c1", "User", "u1")).name,
              Option.some("a"),
            );
          }),
        },
      ],
      race: [
        {
          name: "BEH-EA-246: 8 resources linked under one userName concurrently: exactly one holds it",
          run: Effect.gen(function* () {
            const records = yield* ScimRecords.ScimRecords;
            const outcomes = yield* raced(
              many((n) =>
                records.link({
                  connectionId: "c1",
                  kind: "User",
                  resourceId: `u${n}`,
                  name: "ada",
                }),
              ),
            );
            assert.strictEqual(outcomes.filter(Exit.isSuccess).length, 1);
            assert.deepStrictEqual(
              outcomes.filter(Exit.isFailure).map(refusal),
              many(() => "conflict:name").slice(1),
            );
            assert.strictEqual(
              (yield* records.list("c1", "User", { offset: 0, limit: 20 })).total,
              1,
            );
          }),
        },
        {
          name: "plan 24: one resource linked 8 times concurrently leaves exactly one row",
          run: Effect.gen(function* () {
            const records = yield* ScimRecords.ScimRecords;
            const outcomes = yield* raced(
              many((n) =>
                records.link({
                  connectionId: "c1",
                  kind: "Group",
                  resourceId: "g1",
                  externalId: `dir-${n}`,
                }),
              ),
            );
            assert.strictEqual(outcomes.filter(Exit.isSuccess).length, 1);
            assert.deepStrictEqual(
              outcomes.filter(Exit.isFailure).map(refusal),
              many(() => "conflict:name").slice(1),
            );
            assert.strictEqual(
              (yield* records.list("c1", "Group", { offset: 0, limit: 20 })).total,
              1,
            );
          }),
        },
      ],
    },
    find: {
      read: [
        {
          name: "a link round-trips and is found by id, scoped by connection and kind",
          run: Effect.gen(function* () {
            const records = yield* ScimRecords.ScimRecords;
            yield* records.link({
              connectionId: "c1",
              kind: "User",
              resourceId: "u1",
              name: "ada@acme.example",
              externalId: "dir-1",
            });
            const byId = Option.getOrThrow(yield* records.find("c1", "User", "u1"));
            assert.deepStrictEqual(byId.name, Option.some("ada@acme.example"));
            assert.deepStrictEqual(byId.externalId, Option.some("dir-1"));
            assert.isTrue(Option.isNone(yield* records.find("c2", "User", "u1")));
            assert.isTrue(Option.isNone(yield* records.find("c1", "Group", "u1")));
          }),
        },
      ],
    },
    findByName: {
      read: [
        {
          name: "a link by its userName, scoped by connection and kind",
          run: Effect.gen(function* () {
            const records = yield* ScimRecords.ScimRecords;
            yield* records.link({
              connectionId: "c1",
              kind: "User",
              resourceId: "u1",
              name: "ada",
            });
            const found = yield* records.findByName("c1", "User", "ada");
            assert.isTrue(Option.isSome(found) && found.value.resourceId === "u1");
            assert.isTrue(Option.isNone(yield* records.findByName("c2", "User", "ada")));
            assert.isTrue(Option.isNone(yield* records.findByName("c1", "Group", "ada")));
          }),
        },
      ],
    },
    findByExternalId: {
      read: [
        {
          name: "a link by its externalId, scoped by connection and kind",
          run: Effect.gen(function* () {
            const records = yield* ScimRecords.ScimRecords;
            yield* records.link({
              connectionId: "c1",
              kind: "User",
              resourceId: "u1",
              externalId: "dir-1",
            });
            const found = yield* records.findByExternalId("c1", "User", "dir-1");
            assert.isTrue(Option.isSome(found) && found.value.resourceId === "u1");
            assert.isTrue(Option.isNone(yield* records.findByExternalId("c2", "User", "dir-1")));
          }),
        },
      ],
    },
    list: {
      read: [
        {
          name: "pages oldest first per connection and kind, and reports the total",
          run: Effect.gen(function* () {
            const records = yield* ScimRecords.ScimRecords;
            for (const n of [1, 2, 3, 4]) {
              yield* records.link({
                connectionId: "c1",
                kind: "User",
                resourceId: `u${n}`,
                name: `n${n}`,
              });
              yield* TestClock.adjust(Duration.millis(5));
            }
            yield* records.link({ connectionId: "c1", kind: "Group", resourceId: "g1" });
            yield* records.link({ connectionId: "c2", kind: "User", resourceId: "x1", name: "x" });
            const page = yield* records.list("c1", "User", { offset: 1, limit: 2 });
            assert.strictEqual(page.total, 4);
            assert.deepStrictEqual(
              page.items.map((row) => row.resourceId),
              ["u2", "u3"],
            );
            assert.strictEqual(
              (yield* records.list("c1", "Group", { offset: 0, limit: 10 })).total,
              1,
            );
          }),
        },
      ],
    },
    setExternalId: {
      atomic: [
        {
          name: "sets, clears and refuses a taken id; an unknown link is ScimRecordNotFound",
          run: Effect.gen(function* () {
            const records = yield* ScimRecords.ScimRecords;
            yield* records.link({
              connectionId: "c1",
              kind: "User",
              resourceId: "u1",
              name: "a",
              externalId: "e1",
            });
            yield* records.link({ connectionId: "c1", kind: "User", resourceId: "u2", name: "b" });
            const taken = yield* records.setExternalId("c1", "User", "u2", "e1").pipe(Effect.exit);
            assert.strictEqual(refusal(taken), "conflict:externalId");
            const set = yield* records.setExternalId("c1", "User", "u2", "e2");
            assert.deepStrictEqual(set.externalId, Option.some("e2"));
            const cleared = yield* records.setExternalId("c1", "User", "u2", null);
            assert.isTrue(Option.isNone(cleared.externalId));
            const missing = yield* records
              .setExternalId("c1", "User", "nope", "e9")
              .pipe(Effect.flip);
            assert.strictEqual(missing._tag, "ScimRecordNotFound");
          }),
        },
      ],
      race: [
        {
          name: "8 links taking one externalId concurrently: exactly one holds it, the others keep theirs",
          run: Effect.gen(function* () {
            const records = yield* ScimRecords.ScimRecords;
            for (const n of many((index) => index)) {
              yield* records.link({
                connectionId: "c1",
                kind: "User",
                resourceId: `u${n}`,
                name: `n${n}`,
                externalId: `own-${n}`,
              });
            }
            const outcomes = yield* raced(
              many((n) => records.setExternalId("c1", "User", `u${n}`, "shared")),
            );
            assert.strictEqual(outcomes.filter(Exit.isSuccess).length, 1);
            assert.deepStrictEqual(
              outcomes.filter(Exit.isFailure).map(refusal),
              many(() => "conflict:externalId").slice(1),
            );
            const winner = outcomes.findIndex(Exit.isSuccess);
            for (const n of many((index) => index)) {
              assert.deepStrictEqual(
                Option.getOrThrow(yield* records.find("c1", "User", `u${n}`)).externalId,
                Option.some(n === winner ? "shared" : `own-${n}`),
              );
            }
          }),
        },
      ],
    },
    unlink: {
      write: [
        {
          name: "unlink drops one link and frees its keys; idempotent",
          run: Effect.gen(function* () {
            const records = yield* ScimRecords.ScimRecords;
            yield* records.link({
              connectionId: "c1",
              kind: "User",
              resourceId: "u1",
              name: "a",
              externalId: "e1",
            });
            yield* records.unlink("c1", "User", "u1");
            assert.isTrue(Option.isNone(yield* records.find("c1", "User", "u1")));
            yield* records.unlink("c1", "User", "u1");
            yield* records.link({
              connectionId: "c1",
              kind: "User",
              resourceId: "u9",
              name: "a",
              externalId: "e1",
            });
          }),
        },
      ],
    },
    linksOfResource: {
      read: [
        {
          name: "ADR-EA-031: every link to a resource of a kind, across connections",
          run: Effect.gen(function* () {
            const records = yield* ScimRecords.ScimRecords;
            yield* records.link({ connectionId: "c1", kind: "User", resourceId: "u1", name: "a" });
            yield* records.link({ connectionId: "c2", kind: "User", resourceId: "u1", name: "a" });
            yield* records.link({ connectionId: "c1", kind: "Group", resourceId: "u1" });
            assert.deepStrictEqual(
              (yield* records.linksOfResource(grant, "User", "u1")).map((row) => row.connectionId),
              ["c1", "c2"],
            );
            assert.deepStrictEqual(yield* records.linksOfResource(grant, "User", "nobody"), []);
          }),
        },
      ],
    },
    unlinkResource: {
      write: [
        {
          name: "ADR-EA-031: drops a user's links across connections and leaves groups and other users; idempotent",
          run: Effect.gen(function* () {
            const records = yield* ScimRecords.ScimRecords;
            yield* records.link({ connectionId: "c1", kind: "User", resourceId: "u1", name: "a" });
            yield* records.link({ connectionId: "c2", kind: "User", resourceId: "u1", name: "a" });
            yield* records.link({ connectionId: "c1", kind: "User", resourceId: "u2", name: "b" });
            yield* records.link({ connectionId: "c1", kind: "Group", resourceId: "u1" });
            yield* records.unlinkResource(grant, "User", "u1");
            assert.deepStrictEqual(yield* records.linksOfResource(grant, "User", "u1"), []);
            assert.isTrue(Option.isSome(yield* records.find("c1", "User", "u2")));
            assert.isTrue(Option.isSome(yield* records.find("c1", "Group", "u1")));
            yield* records.unlinkResource(grant, "User", "u1");
          }),
        },
      ],
    },
  },
  sql: [
    {
      name: "plan 24 label: a revocation outage names ScimRecords.revokeConnection",
      run: Effect.gen(function* () {
        const records = yield* ScimRecords.ScimRecords;
        yield* records.createConnection(connection("c1", "org-1"));
        yield* TestSql.injectFailure({
          name: "scim_revoke_refused",
          table: "scim_connection",
          event: "UPDATE",
        });
        const failure = yield* records.revokeConnection("org-1", "c1").pipe(Effect.flip);
        assert.strictEqual(failure._tag, "StoreUnavailable");
        assert.strictEqual(
          failure._tag === "StoreUnavailable" ? failure.operation : "",
          "ScimRecords.revokeConnection",
        );
      }),
    },
    {
      name: "a failure deleting the connections rolls the links' removal back",
      run: Effect.gen(function* () {
        const records = yield* ScimRecords.ScimRecords;
        yield* records.createConnection(connection("c1", "org-1"));
        yield* records.link({ connectionId: "c1", kind: "User", resourceId: "u1", name: "a" });
        yield* TestSql.injectFailure({
          name: "scim_connection_delete_refused",
          table: "scim_connection",
          event: "DELETE",
        });
        const failure = yield* records.removeAllForOrganization("org-1").pipe(Effect.flip);
        assert.strictEqual(failure._tag, "StoreUnavailable");
        assert.isTrue(Option.isSome(yield* records.find("c1", "User", "u1")));
        assert.strictEqual((yield* records.listConnections("org-1")).length, 1);
      }),
    },
  ],
  tenancy: {
    covers: ["scim_connection", "scim_resource"],
    cases: [
      { table: "scim_connection", insert: insertRow, methods: connectionMethods },
      { table: "scim_resource", insert: insertRow, methods: resourceMethods },
    ],
  },
});
