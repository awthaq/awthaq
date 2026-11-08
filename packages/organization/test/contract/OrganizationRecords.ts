// Plan 25 ticket 14 (ADR-EA-041 decision 9): `OrganizationRecords`' contract, run on memory and SQL (Postgres under
// `pnpm test:pg`) from `Contract.test.ts`. A slug is unique (the index decides a race), and `update` writes only
// the patched columns in one statement, so two concurrent patches of different fields both stay (plan 24 C4).
import { RecordsContract, type TestAuth } from "@awthaq/test";
import { assert } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as OrganizationRecords from "../../src/OrganizationRecords.ts";
import { grant } from "../support.ts";

let isolationCounter = 0;
const isolationCase: TestAuth.TableCase<
  OrganizationRecords.OrganizationRecordsShape,
  string,
  OrganizationRecords.OrganizationRecords
> = {
  table: "organization_org",
  insert: Effect.gen(function* () {
    const records = yield* OrganizationRecords.OrganizationRecords;
    isolationCounter += 1;
    const created = yield* records.create({
      name: `Isolation ${isolationCounter}`,
      slug: `isolation-${isolationCounter}`,
    });
    return created.id;
  }),
  methods: {
    create: { insert: true },
    findById: {
      keyed: {
        run: (id, as) =>
          Effect.flatMap(OrganizationRecords.OrganizationRecords, (records) =>
            Effect.map(
              records.findById(as === "owner" ? id : "another-organization"),
              Option.isSome,
            ),
          ),
      },
    },
    findBySlug: {
      keyed: {
        run: (id, as) =>
          Effect.flatMap(OrganizationRecords.OrganizationRecords, (records) =>
            Effect.gen(function* () {
              const own = yield* records.findById(id);
              const slug =
                as === "owner" ? (Option.isSome(own) ? own.value.slug : "") : "another-slug";
              return Option.isSome(yield* records.findBySlug(slug));
            }),
          ),
      },
    },
    update: {
      keyed: {
        run: (id, as) =>
          Effect.flatMap(OrganizationRecords.OrganizationRecords, (records) =>
            records.update(as === "owner" ? id : "another-organization", { name: "Renamed" }).pipe(
              Effect.as(true),
              Effect.catchTag("OrganizationRecordNotFound", () => Effect.succeed(false)),
            ),
          ),
      },
    },
    delete: {
      keyed: {
        run: (id, as) =>
          Effect.flatMap(OrganizationRecords.OrganizationRecords, (records) =>
            records.delete(as === "owner" ? id : "another-organization").pipe(
              Effect.as(true),
              Effect.catchTag("OrganizationRecordNotFound", () => Effect.succeed(false)),
            ),
          ),
      },
    },
    setSuspended: {
      crossTenant: {
        run: (id) =>
          Effect.flatMap(OrganizationRecords.OrganizationRecords, (records) =>
            Effect.flatMap(DateTime.now, (now) =>
              records.setSuspended(grant, id, Option.some(now)).pipe(
                Effect.as(true),
                Effect.catchTag("OrganizationRecordNotFound", () => Effect.succeed(false)),
              ),
            ),
          ),
      },
    },
    listPage: {
      crossTenant: {
        run: (id) =>
          Effect.flatMap(OrganizationRecords.OrganizationRecords, (records) =>
            Effect.map(records.listPage(grant, { after: Option.none(), limit: 1_000 }), (rows) =>
              rows.some((row) => row.id === id),
            ),
          ),
      },
    },
    listByIds: {
      crossTenant: {
        run: (id) =>
          Effect.flatMap(OrganizationRecords.OrganizationRecords, (records) =>
            Effect.map(records.listByIds(grant, [id]), (rows) => rows.some((row) => row.id === id)),
          ),
      },
    },
  },
};

export const organizationRecords = RecordsContract.suite(OrganizationRecords.OrganizationRecords, {
  operations: {
    create: {
      atomic: [
        {
          name: "create then findById round-trips every field",
          run: Effect.gen(function* () {
            const records = yield* OrganizationRecords.OrganizationRecords;
            const created = yield* records.create({
              name: "Acme",
              slug: "acme",
              logo: "https://example.com/logo.png",
              metadata: '{"plan":"pro"}',
            });
            const found = yield* records.findById(created.id);
            assert.isTrue(Option.isSome(found));
            if (Option.isSome(found)) {
              assert.strictEqual(found.value.name, "Acme");
              assert.strictEqual(found.value.slug, "acme");
              assert.deepStrictEqual(found.value.logo, Option.some("https://example.com/logo.png"));
            }
          }),
        },

        {
          name: "create rejects a slug collision",
          run: Effect.gen(function* () {
            const records = yield* OrganizationRecords.OrganizationRecords;
            yield* records.create({ name: "Acme", slug: "acme" });
            const failure = yield* records
              .create({ name: "Acme 2", slug: "acme" })
              .pipe(Effect.flip);
            assert.strictEqual(failure._tag, "OrganizationRecordSlugTaken");
          }),
        },
      ],
      race: [
        {
          name: "8 creates of one slug store exactly one",
          run: Effect.gen(function* () {
            const records = yield* OrganizationRecords.OrganizationRecords;
            const outcomes = yield* RecordsContract.race(
              Effect.exit(records.create({ name: "Acme", slug: "same" })),
            );
            assert.strictEqual(outcomes.filter((exit) => exit._tag === "Success").length, 1);
          }),
        },
      ],
    },
    findById: {
      read: [
        {
          name: "an unknown id is none",
          run: Effect.gen(function* () {
            const records = yield* OrganizationRecords.OrganizationRecords;
            assert.isTrue(Option.isNone(yield* records.findById("missing")));
          }),
        },
      ],
    },
    findBySlug: {
      read: [
        {
          name: "findBySlug finds the same record findById does",
          run: Effect.gen(function* () {
            const records = yield* OrganizationRecords.OrganizationRecords;
            const created = yield* records.create({ name: "Acme", slug: "acme" });
            const found = yield* records.findBySlug("acme");
            assert.isTrue(Option.isSome(found));
            if (Option.isSome(found)) assert.strictEqual(found.value.id, created.id);
          }),
        },
      ],
    },
    update: {
      atomic: [
        {
          name: "update changes the given fields and rejects a slug collision",
          run: Effect.gen(function* () {
            const records = yield* OrganizationRecords.OrganizationRecords;
            const created = yield* records.create({ name: "Acme", slug: "acme" });
            yield* records.create({ name: "Globex", slug: "globex" });

            const updated = yield* records.update(created.id, { name: "Acme Inc" });
            assert.strictEqual(updated.name, "Acme Inc");
            assert.strictEqual(updated.slug, "acme");

            const collision = yield* records
              .update(created.id, { slug: "globex" })
              .pipe(Effect.flip);
            assert.strictEqual(collision._tag, "OrganizationRecordSlugTaken");
          }),
        },

        {
          name: "update fails for an unknown id",
          run: Effect.gen(function* () {
            const records = yield* OrganizationRecords.OrganizationRecords;
            const failure = yield* records
              .update("does-not-exist", { name: "x" })
              .pipe(Effect.flip);
            assert.strictEqual(failure._tag, "OrganizationRecordNotFound");
          }),
        },

        {
          name: "DRS-007: homeRegion round-trips through create, update and clearing",
          run: Effect.gen(function* () {
            const records = yield* OrganizationRecords.OrganizationRecords;
            const created = yield* records.create({
              name: "Acme",
              slug: "acme",
              homeRegion: "eu-west",
            });
            assert.deepStrictEqual(created.homeRegion, Option.some("eu-west"));
            const moved = yield* records.update(created.id, { homeRegion: "us-east" });
            assert.deepStrictEqual(moved.homeRegion, Option.some("us-east"));
            const untouched = yield* records.update(created.id, { name: "Acme Inc" });
            assert.deepStrictEqual(untouched.homeRegion, Option.some("us-east"));
            const cleared = yield* records.update(created.id, { homeRegion: null });
            assert.isTrue(Option.isNone(cleared.homeRegion));
            const plain = yield* records.create({ name: "Globex", slug: "globex" });
            assert.isTrue(Option.isNone(plain.homeRegion));
          }),
        },
      ],
      race: [
        {
          name: "concurrent patches of different fields both stay (plan 24 C4)",
          run: Effect.gen(function* () {
            const records = yield* OrganizationRecords.OrganizationRecords;
            for (let round = 0; round < RecordsContract.CONCURRENCY; round++) {
              const org = yield* records.create({ name: "Acme", slug: `acme-${round}` });
              yield* Effect.all(
                [
                  records.update(org.id, { name: `Renamed ${round}` }),
                  records.update(org.id, { logo: `logo-${round}` }),
                ],
                { concurrency: "unbounded" },
              );
              const found = Option.getOrThrow(yield* records.findById(org.id));
              assert.strictEqual(found.name, `Renamed ${round}`);
              assert.deepStrictEqual(found.logo, Option.some(`logo-${round}`));
            }
          }),
        },
      ],
    },
    setSuspended: {
      write: [
        {
          name: "EP-003: setSuspended suspends and reinstates, and reports an unknown id",
          run: Effect.gen(function* () {
            const records = yield* OrganizationRecords.OrganizationRecords;
            const created = yield* records.create({ name: "Acme", slug: "acme" });
            assert.isTrue(Option.isNone(created.suspendedAt));
            const at = yield* DateTime.now;
            const suspended = yield* records.setSuspended(grant, created.id, Option.some(at));
            assert.isTrue(Option.isSome(suspended.suspendedAt));
            const reread = yield* records.findById(created.id);
            assert.isTrue(Option.isSome(reread) && Option.isSome(reread.value.suspendedAt));
            const reinstated = yield* records.setSuspended(grant, created.id, Option.none());
            assert.isTrue(Option.isNone(reinstated.suspendedAt));
            const missing = yield* records
              .setSuspended(grant, "does-not-exist", Option.some(at))
              .pipe(Effect.flip);
            assert.strictEqual(missing._tag, "OrganizationRecordNotFound");
          }),
        },
      ],
    },
    listPage: {
      read: [
        {
          name: "EP-003: listPage keysets every organization by (createdAt, id)",
          run: Effect.gen(function* () {
            const records = yield* OrganizationRecords.OrganizationRecords;
            const created = yield* Effect.forEach(["a", "b", "c", "d", "e"], (slug) =>
              records.create({ name: slug, slug }),
            );
            const first = yield* records.listPage(grant, { after: Option.none(), limit: 2 });
            assert.strictEqual(first.length, 2);
            const last = first[first.length - 1];
            assert.isDefined(last);
            const second = yield* records.listPage(grant, {
              after: Option.some({
                createdAt: last?.createdAt ?? (yield* DateTime.now),
                id: last?.id ?? "",
              }),
              limit: 10,
            });
            assert.strictEqual(second.length, 3);
            assert.sameMembers(
              [...first, ...second].map((row) => row.id),
              created.map((row) => row.id),
            );
          }),
        },
      ],
    },
    delete: {
      write: [
        {
          name: "delete removes the record; a second delete fails",
          run: Effect.gen(function* () {
            const records = yield* OrganizationRecords.OrganizationRecords;
            const created = yield* records.create({ name: "Acme", slug: "acme" });
            yield* records.delete(created.id);
            const found = yield* records.findById(created.id);
            assert.isTrue(Option.isNone(found));
            const failure = yield* records.delete(created.id).pipe(Effect.flip);
            assert.strictEqual(failure._tag, "OrganizationRecordNotFound");
          }),
        },
      ],
    },
    listByIds: {
      read: [
        {
          name: "listByIds returns only the matching records, ignoring unknown ids",
          run: Effect.gen(function* () {
            const records = yield* OrganizationRecords.OrganizationRecords;
            const a = yield* records.create({ name: "Acme", slug: "acme" });
            const b = yield* records.create({ name: "Globex", slug: "globex" });
            const found = yield* records.listByIds(grant, [a.id, "does-not-exist", b.id]);
            assert.strictEqual(found.length, 2);
            assert.sameMembers(
              found.map((r) => r.id),
              [a.id, b.id],
            );
            const empty = yield* records.listByIds(grant, []);
            assert.strictEqual(empty.length, 0);
          }),
        },
      ],
    },
  },
  tenancy: {
    covers: ["organization_org"],
    cases: [isolationCase],
    // As on main before plan 25: the table is keyed by its own id, so no row's tenant is tenant B.
    withoutRls: "keyed by its own id; no organization's id is the ambient tenant",
  },
});
