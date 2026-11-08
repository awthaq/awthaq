// Plan 25 (ADR-EA-041 decision 9): `NoteRecords`' contract. Every operation carries a verdict; the
// runner (`runPluginContractTests`' `records`) reads both adapters from `Notes.records` and runs each case
// on memory and on SQL (Postgres under `pnpm test:pg`), a fresh store per case. `create` is `atomic`: the
// per-owner quota is decided inside the write, and the `race` case is what proves it (change the memory
// adapter to `Ref.get` then `Ref.update` and it fails).
import { Tenant } from "@awthaq/ports";
import { RecordsContract } from "@awthaq/test";
import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Template from "../../src/Template.ts";

const MAX = 3;

interface Written {
  readonly id: string;
  readonly owner: string;
}
let isolationCounter = 0;

export const noteRecords = RecordsContract.suite(Template.NoteRecords, {
  operations: {
    create: {
      atomic: [
        {
          name: "a note carries the tenant it was written under, and none outside a tenant",
          run: Effect.gen(function* () {
            const records = yield* Template.NoteRecords;
            const inTenant = yield* records
              .create({ owner: "o", text: "t" })
              .pipe(Tenant.withTenant("acme"));
            assert.deepStrictEqual(inTenant.tenantId, Option.some("acme"));
            const outside = yield* records.create({ owner: "o", text: "u" });
            assert.isTrue(Option.isNone(outside.tenantId));
          }),
        },
        {
          name: "within refuses at the limit with NoteRecords/LimitReached, and stores nothing",
          run: Effect.gen(function* () {
            const records = yield* Template.NoteRecords;
            for (let n = 0; n < MAX; n++) {
              yield* records.create({ owner: "o", text: `n${n}` }, { within: MAX });
            }
            const refused = yield* Effect.flip(
              records.create({ owner: "o", text: "over" }, { within: MAX }),
            );
            assert.strictEqual(refused._tag, "NoteRecords/LimitReached");
            assert.strictEqual((yield* records.listByOwner("o")).length, MAX);
            // Another owner, and the same owner in another tenant, have their own quota.
            yield* records.create({ owner: "p", text: "p" }, { within: MAX });
            yield* records
              .create({ owner: "o", text: "elsewhere" }, { within: MAX })
              .pipe(Tenant.withTenant("acme"));
          }),
        },
      ],
      race: [
        {
          name: "8 creates racing at max - 1 store exactly one",
          run: Effect.gen(function* () {
            const records = yield* Template.NoteRecords;
            for (let n = 0; n < MAX - 1; n++) {
              yield* records.create({ owner: "o", text: `n${n}` }, { within: MAX });
            }
            const outcomes = yield* RecordsContract.race(
              Effect.exit(records.create({ owner: "o", text: "racer" }, { within: MAX })),
            );
            assert.strictEqual(outcomes.filter((exit) => exit._tag === "Success").length, 1);
            assert.strictEqual((yield* records.listByOwner("o")).length, MAX);
          }),
        },
      ],
    },
    listByOwner: {
      read: [
        {
          name: "the owner's notes in the ambient tenant, oldest first",
          run: Effect.gen(function* () {
            const records = yield* Template.NoteRecords;
            const first = yield* records.create({ owner: "o", text: "first" });
            yield* TestClock.adjust("1 millis");
            const second = yield* records.create({ owner: "o", text: "second" });
            yield* records.create({ owner: "p", text: "other owner" });
            const listed = yield* records.listByOwner("o");
            assert.deepStrictEqual(
              listed.map((row) => row.id),
              [first.id, second.id],
            );
          }),
        },
      ],
    },
  },
  // Plan 05: the table is Partitioned. A note is stamped with the ambient tenant at insert and seen only
  // under it, identically in memory and SQL, and on Postgres the database confines an unfiltered statement.
  tenancy: {
    covers: ["notes_note"],
    cases: [
      {
        table: "notes_note",
        insert: Effect.gen(function* () {
          const records = yield* Template.NoteRecords;
          isolationCounter += 1;
          const owner = `isolation-owner-${isolationCounter}`;
          const created = yield* records.create({ owner, text: "isolated" });
          const written: Written = { id: created.id, owner };
          return written;
        }),
        methods: {
          create: { insert: true },
          listByOwner: {
            scoped: {
              run: (written) =>
                Effect.flatMap(Template.NoteRecords, (records) =>
                  Effect.map(records.listByOwner(written.owner), (rows) =>
                    rows.some((row) => row.id === written.id),
                  ),
                ),
            },
          },
        },
      },
    ],
  },
});
