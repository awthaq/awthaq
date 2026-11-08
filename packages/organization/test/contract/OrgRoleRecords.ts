// Plan 25 ticket 13 (ADR-EA-041 decision 9): `OrgRoleRecords`' contract, run on memory and SQL (Postgres under
// `pnpm test:pg`) from `Contract.test.ts`. `maximumRolesPerOrganization` (`create`'s `within`) is decided with the
// insert.
import { RecordsContract, type TestAuth } from "@awthaq/test";
import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as OrgRoleRecords from "../../src/OrgRoleRecords.ts";
import { ambientOrganization } from "../support.ts";

const orgId = "org-1";

let isolationCounter = 0;
interface Row {
  readonly id: string;
  readonly organizationId: string;
}
const orgOf = (row: Row, as: "owner" | "other") =>
  as === "owner" ? row.organizationId : "another-organization";

const isolationCase: TestAuth.TableCase<
  OrgRoleRecords.OrgRoleRecordsShape,
  Row,
  OrgRoleRecords.OrgRoleRecords
> = {
  table: "organization_role",
  insert: Effect.gen(function* () {
    const records = yield* OrgRoleRecords.OrgRoleRecords;
    isolationCounter += 1;
    const organizationId = yield* ambientOrganization;
    const created = yield* records.create({
      organizationId,
      role: `isolation-${isolationCounter}`,
      permission: { billing: ["read"] },
    });
    return { id: created.id, organizationId };
  }),
  methods: {
    create: { insert: true },
    findById: {
      keyed: {
        run: (row, as) =>
          Effect.flatMap(OrgRoleRecords.OrgRoleRecords, (records) =>
            Effect.map(records.findById(orgOf(row, as), row.id), Option.isSome),
          ),
      },
    },
    listByOrganization: {
      keyed: {
        run: (row, as) =>
          Effect.flatMap(OrgRoleRecords.OrgRoleRecords, (records) =>
            Effect.map(records.listByOrganization(orgOf(row, as)), (rows) =>
              rows.some((found) => found.id === row.id),
            ),
          ),
      },
    },
    countByOrganization: {
      keyed: {
        run: (row, as) =>
          Effect.flatMap(OrgRoleRecords.OrgRoleRecords, (records) =>
            Effect.map(records.countByOrganization(orgOf(row, as)), (count) => count > 0),
          ),
      },
    },
    update: {
      keyed: {
        run: (row, as) =>
          Effect.flatMap(OrgRoleRecords.OrgRoleRecords, (records) =>
            records.update(orgOf(row, as), row.id, { billing: ["update"] }).pipe(
              Effect.as(true),
              Effect.catchTag("OrgRoleRecordNotFound", () => Effect.succeed(false)),
            ),
          ),
      },
    },
    remove: {
      keyed: {
        run: (row, as) =>
          Effect.flatMap(OrgRoleRecords.OrgRoleRecords, (records) =>
            records.remove(orgOf(row, as), row.id).pipe(
              Effect.as(true),
              Effect.catchTag("OrgRoleRecordNotFound", () => Effect.succeed(false)),
            ),
          ),
      },
    },
    removeAllForOrganization: {
      keyed: {
        run: (row, as) =>
          Effect.flatMap(OrgRoleRecords.OrgRoleRecords, (records) =>
            Effect.gen(function* () {
              const before = yield* records.findById(row.organizationId, row.id);
              yield* records.removeAllForOrganization(orgOf(row, as));
              const after = yield* records.findById(row.organizationId, row.id);
              return Option.isSome(before) && Option.isNone(after);
            }),
          ),
      },
    },
  },
};

export const orgRoleRecords = RecordsContract.suite(OrgRoleRecords.OrgRoleRecords, {
  operations: {
    create: {
      atomic: [
        {
          name: "create then findById round-trips permission",
          run: Effect.gen(function* () {
            const records = yield* OrgRoleRecords.OrgRoleRecords;
            const record = yield* records.create({
              organizationId: orgId,
              role: "billing-admin",
              permission: { billing: ["read", "update"] },
            });
            const found = yield* records.findById(orgId, record.id);
            assert.isTrue(Option.isSome(found));
            if (Option.isSome(found)) {
              assert.deepStrictEqual(found.value.permission, { billing: ["read", "update"] });
            }
          }),
        },
        {
          name: "create rejects a duplicate role name within the same organization",
          run: Effect.gen(function* () {
            const records = yield* OrgRoleRecords.OrgRoleRecords;
            yield* records.create({ organizationId: orgId, role: "dup", permission: {} });
            const failure = yield* records
              .create({ organizationId: orgId, role: "dup", permission: {} })
              .pipe(Effect.flip);
            assert.strictEqual(failure._tag, "OrgRoleRecordNameTaken");
          }),
        },
        {
          name: "the same role name is allowed across different organizations",
          run: Effect.gen(function* () {
            const records = yield* OrgRoleRecords.OrgRoleRecords;
            yield* records.create({ organizationId: "org-a", role: "dup", permission: {} });
            yield* records.create({ organizationId: "org-b", role: "dup", permission: {} });
            assert.strictEqual((yield* records.listByOrganization("org-a")).length, 1);
            assert.strictEqual((yield* records.listByOrganization("org-b")).length, 1);
          }),
        },
        {
          name: "within refuses at the organization's limit (OrgRoleRecords/LimitReached)",
          run: Effect.gen(function* () {
            const records = yield* OrgRoleRecords.OrgRoleRecords;
            yield* records.create(
              { organizationId: orgId, role: "a", permission: {} },
              { within: 1 },
            );
            const refused = yield* Effect.flip(
              records.create({ organizationId: orgId, role: "b", permission: {} }, { within: 1 }),
            );
            assert.strictEqual(refused._tag, "OrgRoleRecords/LimitReached");
            yield* records.create(
              { organizationId: "org-2", role: "b", permission: {} },
              { within: 1 },
            );
            assert.strictEqual(yield* records.countByOrganization(orgId), 1);
          }),
        },
      ],
      race: [
        {
          name: "8 creates racing at within - 1 store exactly one",
          run: Effect.gen(function* () {
            const records = yield* OrgRoleRecords.OrgRoleRecords;
            yield* records.create({ organizationId: orgId, role: "first", permission: {} });
            const outcomes = yield* Effect.all(
              Array.from({ length: RecordsContract.CONCURRENCY }, (_, n) =>
                Effect.exit(
                  records.create(
                    { organizationId: orgId, role: `r${n}`, permission: {} },
                    { within: 2 },
                  ),
                ),
              ),
              { concurrency: "unbounded" },
            );
            assert.strictEqual(outcomes.filter((exit) => exit._tag === "Success").length, 1);
            assert.strictEqual(yield* records.countByOrganization(orgId), 2);
          }),
        },
      ],
    },
    findById: {
      read: [
        {
          name: "finds a role only in its own organization",
          run: Effect.gen(function* () {
            const records = yield* OrgRoleRecords.OrgRoleRecords;
            const created = yield* records.create({
              organizationId: orgId,
              role: "a",
              permission: {},
            });
            assert.isTrue(Option.isSome(yield* records.findById(orgId, created.id)));
            assert.isTrue(Option.isNone(yield* records.findById("org-2", created.id)));
          }),
        },
      ],
    },
    listByOrganization: {
      read: [
        {
          name: "lists only that organization's roles",
          run: Effect.gen(function* () {
            const records = yield* OrgRoleRecords.OrgRoleRecords;
            yield* records.create({ organizationId: orgId, role: "a", permission: {} });
            yield* records.create({ organizationId: orgId, role: "b", permission: {} });
            yield* records.create({ organizationId: "org-2", role: "c", permission: {} });
            const roles = (yield* records.listByOrganization(orgId)).map((row) => row.role);
            assert.deepStrictEqual([...roles].sort(), ["a", "b"]);
          }),
        },
      ],
    },
    countByOrganization: {
      read: [
        {
          name: "countByOrganization counts only that organization's roles",
          run: Effect.gen(function* () {
            const records = yield* OrgRoleRecords.OrgRoleRecords;
            yield* records.create({ organizationId: "org-a", role: "r1", permission: {} });
            yield* records.create({ organizationId: "org-a", role: "r2", permission: {} });
            yield* records.create({ organizationId: "org-b", role: "r1", permission: {} });
            assert.strictEqual(yield* records.countByOrganization("org-a"), 2);
          }),
        },
      ],
    },
    update: {
      write: [
        {
          name: "update replaces the permission map; fails for an unknown id",
          run: Effect.gen(function* () {
            const records = yield* OrgRoleRecords.OrgRoleRecords;
            const record = yield* records.create({
              organizationId: orgId,
              role: "r",
              permission: {},
            });
            const updated = yield* records.update(orgId, record.id, { billing: ["read"] });
            assert.deepStrictEqual(updated.permission, { billing: ["read"] });
            const failure = yield* records.update(orgId, "no-such-id", {}).pipe(Effect.flip);
            assert.strictEqual(failure._tag, "OrgRoleRecordNotFound");
          }),
        },
      ],
    },
    remove: {
      write: [
        {
          name: "remove deletes the role; a second remove fails",
          run: Effect.gen(function* () {
            const records = yield* OrgRoleRecords.OrgRoleRecords;
            const record = yield* records.create({
              organizationId: orgId,
              role: "r",
              permission: {},
            });
            yield* records.remove(orgId, record.id);
            const found = yield* records.findById(orgId, record.id);
            assert.isTrue(Option.isNone(found));
            const failure = yield* records.remove(orgId, record.id).pipe(Effect.flip);
            assert.strictEqual(failure._tag, "OrgRoleRecordNotFound");
          }),
        },
      ],
    },
    removeAllForOrganization: {
      write: [
        {
          name: "removes every role of that organization, and no other",
          run: Effect.gen(function* () {
            const records = yield* OrgRoleRecords.OrgRoleRecords;
            yield* records.create({ organizationId: orgId, role: "a", permission: {} });
            yield* records.create({ organizationId: "org-2", role: "b", permission: {} });
            yield* records.removeAllForOrganization(orgId);
            assert.strictEqual(yield* records.countByOrganization(orgId), 0);
            assert.strictEqual(yield* records.countByOrganization("org-2"), 1);
          }),
        },
      ],
    },
  },
  tenancy: { covers: ["organization_role"], cases: [isolationCase] },
});
