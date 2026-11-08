// Plan 25 ticket 14 (ADR-EA-041 decision 9): `ConnectionRecords`' contract, run on memory and SQL (Postgres under
// `pnpm test:pg`; libSQL too, as an extra adapter in `Contract.test.ts`). An email domain routes to one connection
// (the unique index decides a race); an update never brings a removed connection back (plan 24 C6); `emailDomains`
// is answered sorted (plan 24 R4, Q2).
import { SealedColumn } from "@awthaq/sql";
import { RecordsContract, type TestAuth } from "@awthaq/test";
import { assert } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as ConnectionRecords from "../../src/ConnectionRecords.ts";
import { ambientOrganization, grant } from "../support.ts";

// The records layers need `Encryption` (the sealed `clientSecret` column); the sealed suite below

/** What a sealed secret holds, opened through the substrate. */
const openSecret = (sealed: SealedColumn.Sealed<string>) =>
  Effect.map(SealedColumn.orDie(sealed.open), Redacted.value);

const input = (
  id: string,
  organizationId: string,
  overrides: Partial<ConnectionRecords.ConnectionInput> = {},
): ConnectionRecords.ConnectionInput => ({
  id,
  organizationId,
  kind: "oidc",
  name: "Acme SSO",
  issuer: "https://idp.acme.example",
  discoveryUrl: "https://idp.acme.example/.well-known/openid-configuration",
  clientId: "client-1",
  clientSecret: Redacted.make("provider-secret"),
  scopes: ["openid", "email"],
  emailDomains: ["acme.example"],
  ...overrides,
});

let isolationCounter = 0;
interface Row {
  readonly id: string;
  readonly organizationId: string;
  readonly domain: string;
}
const orgOf = (row: Row, as: "owner" | "other") =>
  as === "owner" ? row.organizationId : "another-organization";
const using = <A, E, R>(
  use: (records: ConnectionRecords.ConnectionRecordsShape) => Effect.Effect<A, E, R>,
) => Effect.flatMap(ConnectionRecords.ConnectionRecords, use);
const present = (row: Row) =>
  using((records) => Effect.map(records.findById(row.organizationId, row.id), Option.isSome));

const isolationMethods: {
  readonly [K in keyof ConnectionRecords.ConnectionRecordsShape]: TestAuth.MethodClass<
    Row,
    ConnectionRecords.ConnectionRecords
  >;
} = {
  create: { insert: true },
  findById: {
    keyed: {
      run: (row, as) =>
        using((records) => Effect.map(records.findById(orgOf(row, as), row.id), Option.isSome)),
    },
  },
  findByEmailDomain: {
    crossTenant: {
      run: (row) =>
        using((records) =>
          Effect.map(
            records.findByEmailDomain(grant, row.domain),
            (found) => Option.isSome(found) && found.value.id === row.id,
          ),
        ),
    },
  },
  listByOrganization: {
    keyed: {
      run: (row, as) =>
        using((records) =>
          Effect.map(records.listByOrganization(orgOf(row, as)), (rows) =>
            rows.some((found) => found.id === row.id),
          ),
        ),
    },
  },
  update: {
    keyed: {
      run: (row, as) =>
        using((records) =>
          records
            .update(orgOf(row, as), row.id, { name: "Renamed", emailDomains: [row.domain] })
            .pipe(
              Effect.as(true),
              Effect.catchTag("ConnectionRecordNotFound", () => Effect.succeed(false)),
            ),
        ),
    },
  },
  remove: {
    keyed: {
      run: (row, as) =>
        using((records) =>
          records.remove(orgOf(row, as), row.id).pipe(
            Effect.as(true),
            Effect.catchTag("ConnectionRecordNotFound", () => Effect.succeed(false)),
          ),
        ),
    },
  },
  removeAllForOrganization: {
    keyed: {
      run: (row, as) =>
        using((records) =>
          Effect.gen(function* () {
            const before = yield* present(row);
            yield* records.removeAllForOrganization(orgOf(row, as));
            return before && !(yield* present(row));
          }),
        ),
    },
  },
};

const insertRow = Effect.gen(function* () {
  const records = yield* ConnectionRecords.ConnectionRecords;
  isolationCounter += 1;
  const organizationId = yield* ambientOrganization;
  const domain = `isolation-${isolationCounter}.example`;
  const created = yield* records.create(
    input(`isolation-${isolationCounter}`, organizationId, { emailDomains: [domain] }),
  );
  return { id: created.id, organizationId, domain };
});

export const connectionRecords = RecordsContract.suite(ConnectionRecords.ConnectionRecords, {
  operations: {
    create: {
      atomic: [
        {
          name: "create then findById round-trips every field, scoped to its organization",
          run: Effect.gen(function* () {
            const records = yield* ConnectionRecords.ConnectionRecords;
            const created = yield* records.create(input("c1", "org-1"));
            const found = yield* records.findById("org-1", "c1");
            assert.isTrue(Option.isSome(found));
            if (Option.isSome(found)) {
              assert.strictEqual(found.value.name, "Acme SSO");
              assert.strictEqual(found.value.kind, "oidc");
              assert.deepStrictEqual(found.value.issuer, Option.some("https://idp.acme.example"));
              assert.isTrue(Option.isSome(found.value.clientSecret));
              if (Option.isSome(found.value.clientSecret)) {
                assert.strictEqual(
                  yield* openSecret(found.value.clientSecret.value),
                  "provider-secret",
                );
              }
              assert.deepStrictEqual(found.value.scopes, ["openid", "email"]);
              assert.deepStrictEqual(found.value.emailDomains, ["acme.example"]);
              assert.isTrue(Option.isNone(found.value.userinfoEndpoint));
              assert.strictEqual(
                DateTime.toEpochMillis(found.value.createdAt),
                DateTime.toEpochMillis(created.createdAt),
              );
            }
            // Another organization cannot read it by id.
            assert.isTrue(Option.isNone(yield* records.findById("org-2", "c1")));
          }),
        },
      ],
      race: [
        {
          name: "8 connections racing for one domain: exactly one holds it",
          run: Effect.gen(function* () {
            const records = yield* ConnectionRecords.ConnectionRecords;
            const outcomes = yield* Effect.all(
              Array.from({ length: RecordsContract.CONCURRENCY }, (_, n) =>
                Effect.exit(
                  records.create(
                    input(`race-${n}`, `org-${n}`, { emailDomains: ["contested.example"] }),
                  ),
                ),
              ),
              { concurrency: "unbounded" },
            );
            assert.strictEqual(outcomes.filter((exit) => exit._tag === "Success").length, 1);
          }),
        },
        {
          name: "emailDomains is answered sorted on create and every read (plan 24 R4)",
          run: Effect.gen(function* () {
            const records = yield* ConnectionRecords.ConnectionRecords;
            const created = yield* records.create(
              input("c-sorted", "org-1", { emailDomains: ["b.example", "a.example"] }),
            );
            assert.deepStrictEqual(created.emailDomains, ["a.example", "b.example"]);
            const found = Option.getOrThrow(yield* records.findById("org-1", "c-sorted"));
            assert.deepStrictEqual(found.emailDomains, ["a.example", "b.example"]);
            const updated = yield* records.update("org-1", "c-sorted", {
              emailDomains: ["z.example", "c.example"],
            });
            assert.deepStrictEqual(updated.emailDomains, ["c.example", "z.example"]);
          }),
        },
      ],
    },
    findById: {
      read: [
        {
          name: "finds a connection only in its own organization",
          run: Effect.gen(function* () {
            const records = yield* ConnectionRecords.ConnectionRecords;
            yield* records.create(input("c-find", "org-1"));
            assert.isTrue(Option.isSome(yield* records.findById("org-1", "c-find")));
            assert.isTrue(Option.isNone(yield* records.findById("org-2", "c-find")));
          }),
        },
      ],
    },
    findByEmailDomain: {
      read: [
        {
          name: "an email domain routes to exactly one connection across organizations",
          run: Effect.gen(function* () {
            const records = yield* ConnectionRecords.ConnectionRecords;
            yield* records.create(input("c1", "org-1"));
            const clash = yield* records
              .create(
                input("c2", "org-2", {
                  emailDomains: ["ACME.example".toLowerCase(), "other.example"],
                }),
              )
              .pipe(Effect.flip);
            assert.strictEqual(clash._tag, "ConnectionDomainTaken");
            // The failed create left nothing behind — not the row, not the second domain.
            assert.isTrue(Option.isNone(yield* records.findById("org-2", "c2")));
            assert.isTrue(Option.isNone(yield* records.findByEmailDomain(grant, "other.example")));
            const routed = yield* records.findByEmailDomain(grant, "acme.example");
            assert.isTrue(Option.isSome(routed) && routed.value.id === "c1");
          }),
        },
      ],
    },
    listByOrganization: {
      read: [
        {
          name: "list is per organization and remove releases the connection's domains",
          run: Effect.gen(function* () {
            const records = yield* ConnectionRecords.ConnectionRecords;
            yield* records.create(input("c1", "org-1"));
            yield* records.create(input("c2", "org-1", { emailDomains: [] }));
            yield* records.create(input("c3", "org-2", { emailDomains: ["other.example"] }));
            assert.sameMembers(
              (yield* records.listByOrganization("org-1")).map((row) => row.id),
              ["c1", "c2"],
            );
            yield* records.remove("org-1", "c1");
            assert.isTrue(Option.isNone(yield* records.findByEmailDomain(grant, "acme.example")));
            // The freed domain can be claimed by someone else.
            yield* records.create(input("c4", "org-2"));
            const missing = yield* records.remove("org-2", "c1").pipe(Effect.flip);
            assert.strictEqual(missing._tag, "ConnectionRecordNotFound");
          }),
        },
      ],
    },
    update: {
      atomic: [
        {
          name: "update patches fields, null clears, and domains are replaced atomically",
          run: Effect.gen(function* () {
            const records = yield* ConnectionRecords.ConnectionRecords;
            yield* records.create(input("c1", "org-1"));
            yield* records.create(input("c2", "org-1", { emailDomains: ["second.example"] }));
            const patched = yield* records.update("org-1", "c1", {
              name: "Renamed",
              clientSecret: null,
              userinfoEndpoint: "https://idp.acme.example/userinfo",
              emailDomains: ["acme.example", "acme.test"],
            });
            assert.strictEqual(patched.name, "Renamed");
            assert.isTrue(Option.isNone(patched.clientSecret));
            assert.deepStrictEqual(
              patched.userinfoEndpoint,
              Option.some("https://idp.acme.example/userinfo"),
            );
            assert.sameMembers([...patched.emailDomains], ["acme.example", "acme.test"]);
            assert.isTrue(
              DateTime.toEpochMillis(patched.updatedAt) >=
                DateTime.toEpochMillis(patched.createdAt),
            );
            // A domain another connection holds is refused, and the connection keeps its old set.
            const clash = yield* records
              .update("org-1", "c1", { emailDomains: ["second.example"] })
              .pipe(Effect.flip);
            assert.strictEqual(clash._tag, "ConnectionDomainTaken");
            const after = yield* records.findById("org-1", "c1");
            assert.isTrue(Option.isSome(after));
            if (Option.isSome(after)) {
              assert.sameMembers([...after.value.emailDomains], ["acme.example", "acme.test"]);
            }
            const missing = yield* records.update("org-2", "c1", { name: "x" }).pipe(Effect.flip);
            assert.strictEqual(missing._tag, "ConnectionRecordNotFound");
          }),
        },
      ],
      race: [
        {
          name: "an update racing a removal never brings the connection back (plan 24 C6)",
          run: Effect.gen(function* () {
            const records = yield* ConnectionRecords.ConnectionRecords;
            for (let round = 0; round < RecordsContract.CONCURRENCY; round++) {
              const id = `c6-${round}`;
              yield* records.create(input(id, "org-1", { emailDomains: [`r${round}.example`] }));
              const [removed] = yield* Effect.all(
                [
                  Effect.exit(records.remove("org-1", id)),
                  Effect.exit(records.update("org-1", id, { name: "Renamed" })),
                ],
                { concurrency: "unbounded" },
              );
              assert.strictEqual(removed?._tag, "Success");
              assert.isTrue(
                Option.isNone(yield* records.findById("org-1", id)),
                `round ${round}: resurrected`,
              );
            }
          }),
        },
      ],
    },
    remove: {
      write: [
        {
          name: "removes the connection and releases its domains; a second remove is ConnectionRecordNotFound",
          run: Effect.gen(function* () {
            const records = yield* ConnectionRecords.ConnectionRecords;
            yield* records.create(input("c-rm", "org-1"));
            yield* records.remove("org-1", "c-rm");
            assert.isTrue(Option.isNone(yield* records.findByEmailDomain(grant, "acme.example")));
            const again = yield* Effect.flip(records.remove("org-1", "c-rm"));
            assert.strictEqual(again._tag, "ConnectionRecordNotFound");
            yield* records.create(input("c-next", "org-2"));
          }),
        },
      ],
    },
    removeAllForOrganization: {
      write: [
        {
          name: "removeAllForOrganization sweeps only that organization's connections and domains",
          run: Effect.gen(function* () {
            const records = yield* ConnectionRecords.ConnectionRecords;
            yield* records.create(input("c1", "org-1"));
            yield* records.create(input("c2", "org-2", { emailDomains: ["other.example"] }));
            yield* records.removeAllForOrganization("org-1");
            assert.strictEqual((yield* records.listByOrganization("org-1")).length, 0);
            assert.isTrue(Option.isNone(yield* records.findByEmailDomain(grant, "acme.example")));
            assert.strictEqual((yield* records.listByOrganization("org-2")).length, 1);
            assert.isTrue(Option.isSome(yield* records.findByEmailDomain(grant, "other.example")));
          }),
        },
      ],
    },
  },
  tenancy: {
    covers: ["organization_oauth_connection", "organization_oauth_connection_domain"],
    cases: [
      { table: "organization_oauth_connection", insert: insertRow, methods: isolationMethods },
      {
        table: "organization_oauth_connection_domain",
        insert: insertRow,
        methods: isolationMethods,
      },
    ],
  },
});
