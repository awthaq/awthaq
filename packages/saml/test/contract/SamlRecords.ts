// Plan 25 ticket 22 (ADR-EA-041 decision 9): `SamlRecords`' contract, run on memory and SQL (Postgres under
// `pnpm test:pg`) from `Contract.test.ts`, a fresh store per case, Organization's migrations first (Saml's own
// backfill its domains into organization's claim tables, BEH-EA-317). BEH-EA-241: an email domain routes to exactly
// one connection, a real database constraint. A connection and its domains are written and removed as one step
// (one transaction, the connection row first), so a taken domain leaves nothing half-made and an update racing a
// removal never brings a domain back. Plan 24 C10: `saveSession` is one upsert. R5: `emailDomains` ascending.
// These cases replace `SamlRecords.test.ts`' bespoke suite, its constraint case and its tenant-isolation run.
import { Tenant } from "@awthaq/ports";
import { SealedColumn, TenantScoped } from "@awthaq/sql";
import { RecordsContract, type TestAuth, TestSql } from "@awthaq/test";
import { assert } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Scheduler from "effect/Scheduler";
import * as TestClock from "effect/testing/TestClock";
import * as SamlRecords from "../../src/SamlRecords.ts";
import { idp, idpNext, NOT_AFTER, NOT_BEFORE } from "../samlFixtures.ts";

/** The witness these cases present where a protocol message or a maintenance sweep would. */
const grant = TenantScoped.crossTenant("saml records contract: a cross-organization caller");

/**
 * Racing fibers yield to the scheduler every few steps, so they interleave between the statements of one write.
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

/** The tag a failed exit failed with ("" for a success or a defect). */
const failedWith = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? Option.match(Exit.findErrorOption(exit), { onNone: () => "", onSome: (error) => error._tag })
    : "";

const certificate = (who: typeof idp): SamlRecords.IdpCertificate => ({
  pem: who.cert,
  fingerprint: who.fingerprint,
  notBefore: NOT_BEFORE,
  notAfter: NOT_AFTER,
});

const input = (
  id: string,
  organizationId: string,
  domains: ReadonlyArray<string> = [],
): SamlRecords.NewConnection => ({
  id,
  organizationId,
  name: `connection ${id}`,
  idpEntityId: `https://idp-${id}.example.com/metadata`,
  ssoUrl: `https://idp-${id}.example.com/sso`,
  idpCertificates: [certificate(idp)],
  emailDomains: domains,
  trustsEmail: false,
});

const spKey = (id: string, connectionId: string) => ({
  id,
  connectionId,
  certificate: `cert-${id}`,
  privateKey: Redacted.make(`sealed-${id}`),
  fingerprint: `fp-${id}`,
  notBefore: NOT_BEFORE,
  notAfter: NOT_AFTER,
});

const domainOwner = (domain: string) =>
  Effect.flatMap(SamlRecords.SamlRecords, (records) =>
    Effect.map(
      records.findByDomain(grant, domain),
      Option.map((row) => row.id),
    ),
  );

const exists = (id: string) =>
  Effect.flatMap(SamlRecords.SamlRecords, (records) =>
    Effect.map(records.findById(grant, id), Option.isSome),
  );

const sessionIds = (rows: ReadonlyArray<SamlRecords.SamlSessionRecord>) =>
  rows.map((row) => row.sessionId).toSorted();

// ---- plan 05: tenant isolation, once, by the store ----------------------------------------------------
//
// `saml_connection` is Keyed by `organizationId`; the other three are Derived through it. One records interface
// serves all four, so each case classifies every method: the ones that belong to another table are `derived`
// and probed in that table's case.

interface Row {
  readonly id: string;
  readonly organizationId: string;
  readonly domain: string;
  readonly keyId: string;
  readonly sessionId: string;
}

let isolationCounter = 0;

const orgOf = (row: Row, as: "owner" | "other") =>
  as === "owner" ? row.organizationId : "another-organization";

const using = <A, E, R>(use: (records: SamlRecords.SamlRecordsShape) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(SamlRecords.SamlRecords, use);

const insertRow = Effect.gen(function* () {
  const records = yield* SamlRecords.SamlRecords;
  isolationCounter += 1;
  const organizationId = yield* Effect.map(
    Tenant.TenantContext,
    Option.getOrElse(() => "platform-organization"),
  );
  const id = `isolation-${isolationCounter}`;
  const domain = `isolation-${isolationCounter}.example`;
  yield* records.create(input(id, organizationId, [domain]));
  const keyId = `isolation-key-${isolationCounter}`;
  yield* records.saveSpKey(spKey(keyId, id));
  const sessionId = `isolation-session-${isolationCounter}`;
  yield* records.saveSession({ sessionId, connectionId: id, nameId: "ada", sessionIndex: "i1" });
  return { id, organizationId, domain, keyId, sessionId } satisfies Row;
});

type Methods = TestAuth.TableCase<
  SamlRecords.SamlRecordsShape,
  Row,
  SamlRecords.SamlRecords
>["methods"];

const derivedElsewhere = (table: string) => ({
  derived: `operates on ${table}; classified in that table's case`,
});

const allElsewhere = (table: string): Methods => ({
  create: { insert: true },
  findById: derivedElsewhere(table),
  listByOrganization: derivedElsewhere(table),
  findByDomain: derivedElsewhere(table),
  update: derivedElsewhere(table),
  remove: derivedElsewhere(table),
  saveSpKey: derivedElsewhere(table),
  listSpKeys: derivedElsewhere(table),
  saveSession: derivedElsewhere(table),
  findSessions: derivedElsewhere(table),
  findSession: derivedElsewhere(table),
  removeSession: derivedElsewhere(table),
  pruneSessions: derivedElsewhere(table),
});

const connectionMethods: Methods = {
  ...allElsewhere("saml_sp_key and saml_session"),
  findById: {
    crossTenant: {
      run: (row) => using((records) => Effect.map(records.findById(grant, row.id), Option.isSome)),
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
  findByDomain: {
    crossTenant: {
      run: (row) =>
        using((records) =>
          Effect.map(
            records.findByDomain(grant, row.domain),
            (found) => Option.isSome(found) && found.value.id === row.id,
          ),
        ),
    },
  },
  update: {
    keyed: {
      run: (row, as) =>
        using((records) =>
          records.update(orgOf(row, as), row.id, { name: "renamed" }).pipe(
            Effect.as(true),
            Effect.catchTag("SamlRecordNotFound", () => Effect.succeed(false)),
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
            Effect.catchTag("SamlRecordNotFound", () => Effect.succeed(false)),
          ),
        ),
    },
  },
};

const keyMethods: Methods = {
  ...allElsewhere("saml_connection and saml_session"),
  saveSpKey: { insert: true },
  listSpKeys: {
    derived:
      "keyed by a connection id the caller resolved through an organization-keyed connection read",
  },
};

const sessionMethods: Methods = {
  ...allElsewhere("saml_connection and saml_sp_key"),
  saveSession: { insert: true },
  findSessions: {
    derived:
      "keyed by a connection id the caller resolved through an organization-keyed connection read",
  },
  findSession: {
    derived: "keyed by a local session id, a tenant-scoped core row the caller already resolved",
  },
  removeSession: {
    derived: "keyed by a local session id, a tenant-scoped core row the caller already resolved",
  },
  pruneSessions: {
    crossTenant: {
      run: (row) =>
        using((records) =>
          Effect.gen(function* () {
            const before = yield* records.findSession(row.sessionId);
            yield* records.pruneSessions(
              grant,
              DateTime.makeUnsafe(Date.now() + 86_400_000 * 3650),
            );
            return (
              Option.isSome(before) && Option.isNone(yield* records.findSession(row.sessionId))
            );
          }),
        ),
    },
  },
};

export const samlRecords = RecordsContract.suite(SamlRecords.SamlRecords, {
  operations: {
    create: {
      atomic: [
        {
          name: "a connection round-trips with its certificates, domains (ascending) and flag",
          run: Effect.gen(function* () {
            const records = yield* SamlRecords.SamlRecords;
            const created = yield* records.create({
              ...input("c1", "org-1", ["acme.test", "acme.example"]),
              trustsEmail: true,
            });
            assert.deepStrictEqual(created.emailDomains, ["acme.example", "acme.test"]);
            const found = Option.getOrThrow(yield* records.findById(grant, "c1"));
            assert.deepStrictEqual(found, created);
            assert.strictEqual(found.organizationId, "org-1");
            assert.strictEqual(found.idpEntityId, "https://idp-c1.example.com/metadata");
            assert.isTrue(found.trustsEmail);
            assert.deepStrictEqual(
              found.idpCertificates.map((entry) => [
                entry.fingerprint,
                DateTime.toEpochMillis(entry.notBefore),
                DateTime.toEpochMillis(entry.notAfter),
              ]),
              [
                [
                  idp.fingerprint,
                  DateTime.toEpochMillis(NOT_BEFORE),
                  DateTime.toEpochMillis(NOT_AFTER),
                ],
              ],
            );
            assert.strictEqual(found.idpCertificates[0]?.pem, idp.cert);
          }),
        },
        {
          name: "BEH-EA-241: a domain cannot be claimed twice, and a refused create leaves no half-made connection",
          run: Effect.gen(function* () {
            const records = yield* SamlRecords.SamlRecords;
            yield* records.create(input("c1", "org-1", ["acme.example"]));
            const taken = yield* records
              .create(input("c4", "org-2", ["fresh.example", "acme.example"]))
              .pipe(Effect.flip);
            assert.strictEqual(taken._tag, "SamlDomainTaken");
            assert.strictEqual(
              taken._tag === "SamlDomainTaken" ? taken.domain : "",
              "acme.example",
            );
            assert.isFalse(yield* exists("c4"));
            assert.isTrue(Option.isNone(yield* domainOwner("fresh.example")));
          }),
        },
        {
          name: "the signing, logout, metadata and role-mapping fields round-trip and default to what a pre-existing connection always was",
          run: Effect.gen(function* () {
            const records = yield* SamlRecords.SamlRecords;
            const plain = yield* records.create(input("c1", "org-1"));
            assert.isFalse(plain.authnRequestsSigned);
            assert.isTrue(Option.isNone(plain.sloUrl));
            assert.strictEqual(plain.sloBinding, "redirect");
            assert.isTrue(Option.isNone(plain.metadataUrl));
            assert.deepStrictEqual(plain.roleMapping, SamlRecords.EMPTY_ROLE_MAPPING);
            const mapping: SamlRecords.RoleMapping = {
              rules: [
                { attribute: "groups", value: "admins", roles: ["admin"] },
                { attribute: "department", roles: ["member"] },
              ],
              ceiling: ["admin"],
              defaultRoles: ["member"],
            };
            const full = yield* records.create({
              ...input("c2", "org-1"),
              authnRequestsSigned: true,
              sloUrl: "https://idp.example.com/slo",
              sloBinding: "post",
              metadataUrl: "https://idp.example.com/metadata.xml",
              roleMapping: mapping,
            });
            const read = Option.getOrThrow(yield* records.findById(grant, "c2"));
            assert.deepStrictEqual(read, full);
            assert.isTrue(read.authnRequestsSigned);
            assert.deepStrictEqual(read.sloUrl, Option.some("https://idp.example.com/slo"));
            assert.strictEqual(read.sloBinding, "post");
            assert.deepStrictEqual(
              read.metadataUrl,
              Option.some("https://idp.example.com/metadata.xml"),
            );
            assert.deepStrictEqual(read.roleMapping, mapping);
          }),
        },
      ],
      race: [
        {
          name: "BEH-EA-241: 8 creates claiming one domain store exactly one connection; the losers leave nothing behind",
          run: Effect.gen(function* () {
            const records = yield* SamlRecords.SamlRecords;
            const outcomes = yield* raced(
              many((n) =>
                records.create(input(`c${n}`, `org-${n}`, [`own-${n}.example`, "shared.example"])),
              ),
            );
            assert.strictEqual(outcomes.filter(Exit.isSuccess).length, 1);
            assert.deepStrictEqual(
              outcomes.filter(Exit.isFailure).map(failedWith),
              many(() => "SamlDomainTaken").slice(1),
            );
            const winner = outcomes.findIndex(Exit.isSuccess);
            assert.deepStrictEqual(yield* domainOwner("shared.example"), Option.some(`c${winner}`));
            for (const n of many((index) => index)) {
              assert.strictEqual(yield* exists(`c${n}`), n === winner);
              assert.strictEqual(
                Option.isSome(yield* domainOwner(`own-${n}.example`)),
                n === winner,
              );
            }
          }),
        },
      ],
    },
    findById: {
      read: [
        {
          name: "a connection by its own id, across organizations; None for an unknown id",
          run: Effect.gen(function* () {
            const records = yield* SamlRecords.SamlRecords;
            yield* records.create(input("c1", "org-1", ["a.example"]));
            assert.strictEqual(
              Option.getOrThrow(yield* records.findById(grant, "c1")).organizationId,
              "org-1",
            );
            assert.isTrue(Option.isNone(yield* records.findById(grant, "nope")));
          }),
        },
      ],
    },
    listByOrganization: {
      read: [
        {
          name: "per organization, oldest first",
          run: Effect.gen(function* () {
            const records = yield* SamlRecords.SamlRecords;
            yield* records.create(input("c2", "org-1"));
            yield* TestClock.adjust(Duration.millis(5));
            yield* records.create(input("c1", "org-1"));
            yield* records.create(input("c3", "org-2"));
            assert.deepStrictEqual(
              (yield* records.listByOrganization("org-1")).map((row) => row.id),
              ["c2", "c1"],
            );
            assert.deepStrictEqual(yield* records.listByOrganization("org-none"), []);
          }),
        },
      ],
    },
    findByDomain: {
      read: [
        {
          name: "BEH-EA-241: a domain routes to exactly one connection, across organizations",
          run: Effect.gen(function* () {
            const records = yield* SamlRecords.SamlRecords;
            yield* records.create(input("c1", "org-1", ["acme.example"]));
            yield* records.create(input("c3", "org-2", ["other.example"]));
            assert.deepStrictEqual(yield* domainOwner("acme.example"), Option.some("c1"));
            assert.deepStrictEqual(yield* domainOwner("other.example"), Option.some("c3"));
            assert.isTrue(Option.isNone(yield* domainOwner("nobody.example")));
          }),
        },
      ],
    },
    update: {
      atomic: [
        {
          name: "changes only what is given; certificates are replaced whole; domains are replaced (ascending) and re-checked",
          run: Effect.gen(function* () {
            const records = yield* SamlRecords.SamlRecords;
            yield* records.create(input("c1", "org-1", ["a.example"]));
            yield* records.create(input("c2", "org-1", ["b.example"]));
            const renamed = yield* records.update("org-1", "c1", { name: "renamed" });
            assert.strictEqual(renamed.name, "renamed");
            assert.strictEqual(renamed.ssoUrl, "https://idp-c1.example.com/sso");
            assert.deepStrictEqual(renamed.emailDomains, ["a.example"]);
            const rotated = yield* records.update("org-1", "c1", {
              idpCertificates: [certificate(idpNext)],
              trustsEmail: true,
            });
            assert.deepStrictEqual(
              rotated.idpCertificates.map((entry) => entry.fingerprint),
              [idpNext.fingerprint],
            );
            assert.isTrue(rotated.trustsEmail);
            const moved = yield* records.update("org-1", "c1", {
              emailDomains: ["z.example", "c.example"],
            });
            assert.deepStrictEqual(moved.emailDomains, ["c.example", "z.example"]);
            assert.isTrue(Option.isNone(yield* domainOwner("a.example")));
            // A domain another connection holds is refused, and nothing of the update is kept.
            const clash = yield* records
              .update("org-1", "c1", { name: "lost", emailDomains: ["d.example", "b.example"] })
              .pipe(Effect.flip);
            assert.strictEqual(clash._tag, "SamlDomainTaken");
            const kept = Option.getOrThrow(yield* records.findById(grant, "c1"));
            assert.deepStrictEqual(kept.emailDomains, ["c.example", "z.example"]);
            assert.strictEqual(kept.name, "renamed");
            assert.isTrue(Option.isNone(yield* domainOwner("d.example")));
          }),
        },
        {
          name: "a patch changes what it names; null clears the two optional URLs",
          run: Effect.gen(function* () {
            const records = yield* SamlRecords.SamlRecords;
            const mapping: SamlRecords.RoleMapping = {
              rules: [{ attribute: "groups", value: "admins", roles: ["admin"] }],
              ceiling: ["admin"],
              defaultRoles: ["member"],
            };
            yield* records.create({
              ...input("c2", "org-1"),
              authnRequestsSigned: true,
              sloUrl: "https://idp.example.com/slo",
              sloBinding: "post",
              metadataUrl: "https://idp.example.com/metadata.xml",
              roleMapping: mapping,
            });
            const patched = yield* records.update("org-1", "c2", {
              authnRequestsSigned: false,
              sloUrl: null,
              metadataUrl: null,
            });
            assert.isFalse(patched.authnRequestsSigned);
            assert.isTrue(Option.isNone(patched.sloUrl));
            assert.isTrue(Option.isNone(patched.metadataUrl));
            assert.strictEqual(patched.sloBinding, "post");
            assert.deepStrictEqual(patched.roleMapping, mapping);
            const remapped = yield* records.update("org-1", "c2", {
              roleMapping: SamlRecords.EMPTY_ROLE_MAPPING,
            });
            assert.deepStrictEqual(remapped.roleMapping, SamlRecords.EMPTY_ROLE_MAPPING);
          }),
        },
        {
          name: "an unknown connection, or another organization's, is SamlRecordNotFound",
          run: Effect.gen(function* () {
            const records = yield* SamlRecords.SamlRecords;
            yield* records.create(input("c1", "org-1"));
            const missing = yield* records.update("org-1", "nope", { name: "x" }).pipe(Effect.flip);
            assert.strictEqual(missing._tag, "SamlRecordNotFound");
            const foreign = yield* records.update("org-2", "c1", { name: "x" }).pipe(Effect.flip);
            assert.strictEqual(foreign._tag, "SamlRecordNotFound");
            assert.strictEqual(
              Option.getOrThrow(yield* records.findById(grant, "c1")).name,
              "connection c1",
            );
          }),
        },
      ],
      race: [
        {
          name: "8 connections moving onto one domain: exactly one holds it, the others keep their own sets",
          run: Effect.gen(function* () {
            const records = yield* SamlRecords.SamlRecords;
            for (const n of many((index) => index)) {
              yield* records.create(input(`c${n}`, "org-1", [`own-${n}.example`]));
            }
            const outcomes = yield* raced(
              many((n) =>
                records.update("org-1", `c${n}`, {
                  emailDomains: ["shared.example", `next-${n}.example`],
                }),
              ),
            );
            assert.strictEqual(outcomes.filter(Exit.isSuccess).length, 1);
            assert.deepStrictEqual(
              outcomes.filter(Exit.isFailure).map(failedWith),
              many(() => "SamlDomainTaken").slice(1),
            );
            const winner = outcomes.findIndex(Exit.isSuccess);
            assert.deepStrictEqual(yield* domainOwner("shared.example"), Option.some(`c${winner}`));
            for (const n of many((index) => index)) {
              const stored = Option.getOrThrow(yield* records.findById(grant, `c${n}`));
              assert.deepStrictEqual(
                stored.emailDomains,
                n === winner ? [`next-${n}.example`, "shared.example"] : [`own-${n}.example`],
              );
            }
          }),
        },
        {
          name: "updates racing the connection's removal never bring it or a domain back, and never fail otherwise",
          run: Effect.gen(function* () {
            const records = yield* SamlRecords.SamlRecords;
            yield* records.create(input("c1", "org-1", ["a.example"]));
            const outcomes = yield* raced([
              ...many((n) =>
                records.update("org-1", "c1", { emailDomains: [`moved-${n}.example`] }),
              ),
              records.remove("org-1", "c1"),
            ]);
            for (const outcome of outcomes) {
              assert.include(["", "SamlRecordNotFound"], failedWith(outcome));
              assert.isTrue(Exit.isSuccess(outcome) || failedWith(outcome) !== "");
            }
            assert.isFalse(yield* exists("c1"));
            assert.isTrue(Option.isNone(yield* domainOwner("a.example")));
            for (const n of many((index) => index)) {
              assert.isTrue(Option.isNone(yield* domainOwner(`moved-${n}.example`)));
            }
            // Every domain is free again.
            yield* records.create(input("c2", "org-2", ["a.example", "moved-0.example"]));
          }),
        },
      ],
    },
    remove: {
      atomic: [
        {
          name: "deletes the connection with its domains, SP keys and sessions; then SamlRecordNotFound",
          run: Effect.gen(function* () {
            const records = yield* SamlRecords.SamlRecords;
            yield* records.create(input("c1", "org-1", ["a.example"]));
            yield* records.saveSpKey(spKey("k1", "c1"));
            yield* records.saveSpKey(spKey("k2", "other"));
            yield* records.saveSession({ sessionId: "s1", connectionId: "c1", nameId: "ada" });
            yield* records.saveSession({ sessionId: "s2", connectionId: "other", nameId: "ada" });
            const foreign = yield* records.remove("org-2", "c1").pipe(Effect.flip);
            assert.strictEqual(foreign._tag, "SamlRecordNotFound");
            yield* records.remove("org-1", "c1");
            assert.isFalse(yield* exists("c1"));
            assert.isTrue(Option.isNone(yield* domainOwner("a.example")));
            assert.deepStrictEqual(yield* records.listSpKeys("c1"), []);
            assert.strictEqual((yield* records.listSpKeys("other")).length, 1);
            assert.isTrue(Option.isNone(yield* records.findSession("s1")));
            assert.isTrue(Option.isSome(yield* records.findSession("s2")));
            yield* records.create(input("c2", "org-2", ["a.example"]));
            assert.strictEqual(
              (yield* records.remove("org-1", "c1").pipe(Effect.flip))._tag,
              "SamlRecordNotFound",
            );
          }),
        },
      ],
      race: [
        {
          name: "8 concurrent removals: exactly one removes, the others are SamlRecordNotFound",
          run: Effect.gen(function* () {
            const records = yield* SamlRecords.SamlRecords;
            yield* records.create(input("c1", "org-1", ["a.example", "b.example"]));
            yield* records.saveSpKey(spKey("k1", "c1"));
            yield* records.saveSession({ sessionId: "s1", connectionId: "c1", nameId: "ada" });
            const outcomes = yield* raced(many(() => records.remove("org-1", "c1")));
            assert.strictEqual(outcomes.filter(Exit.isSuccess).length, 1);
            assert.deepStrictEqual(
              outcomes.filter(Exit.isFailure).map(failedWith),
              many(() => "SamlRecordNotFound").slice(1),
            );
            assert.isFalse(yield* exists("c1"));
            assert.isTrue(Option.isNone(yield* domainOwner("b.example")));
            assert.deepStrictEqual(yield* records.listSpKeys("c1"), []);
            assert.isTrue(Option.isNone(yield* records.findSession("s1")));
          }),
        },
      ],
    },
    saveSpKey: {
      write: [
        {
          name: "BEH-EA-314: a key is stored sealed and opens to what was saved",
          run: Effect.gen(function* () {
            const records = yield* SamlRecords.SamlRecords;
            const saved = yield* records.saveSpKey(spKey("k1", "c1"));
            assert.strictEqual(
              Redacted.value(yield* SealedColumn.orDie(saved.privateKey.open)),
              "sealed-k1",
            );
            assert.strictEqual(saved.fingerprint, "fp-k1");
          }),
        },
      ],
    },
    listSpKeys: {
      read: [
        {
          name: "SP signing keys are listed newest first per connection",
          run: Effect.gen(function* () {
            const records = yield* SamlRecords.SamlRecords;
            yield* records.create(input("c1", "org-1"));
            yield* records.saveSpKey(spKey("k1", "c1"));
            yield* TestClock.adjust(Duration.seconds(1));
            yield* records.saveSpKey(spKey("k2", "c1"));
            yield* records.saveSpKey(spKey("k3", "other"));
            const listed = yield* records.listSpKeys("c1");
            assert.deepStrictEqual(
              listed.map((row) => row.id),
              ["k2", "k1"],
            );
            assert.strictEqual(
              Redacted.value(
                yield* SealedColumn.orDie(
                  Option.getOrThrow(Option.fromNullishOr(listed[0])).privateKey.open,
                ),
              ),
              "sealed-k2",
            );
            assert.strictEqual(
              DateTime.toEpochMillis(listed[0]?.notAfter ?? NOT_BEFORE),
              DateTime.toEpochMillis(NOT_AFTER),
            );
            assert.deepStrictEqual(yield* records.listSpKeys("nobody"), []);
          }),
        },
      ],
    },
    saveSession: {
      atomic: [
        {
          name: "BEH-EA-315: saving the same session id again replaces its row rather than adding one",
          run: Effect.gen(function* () {
            const records = yield* SamlRecords.SamlRecords;
            yield* records.saveSession({
              sessionId: "s1",
              connectionId: "c1",
              nameId: "ada",
              nameIdFormat: "emailAddress",
              sessionIndex: "i1",
            });
            yield* records.saveSession({ sessionId: "s2", connectionId: "c1", nameId: "ada" });
            yield* records.saveSession({
              sessionId: "s1",
              connectionId: "c1",
              nameId: "ada",
              sessionIndex: "i1-again",
            });
            assert.deepStrictEqual(
              sessionIds(yield* records.findSessions({ connectionId: "c1", nameId: "ada" })),
              ["s1", "s2"],
            );
            const s1 = Option.getOrThrow(yield* records.findSession("s1"));
            assert.deepStrictEqual(s1.sessionIndex, Option.some("i1-again"));
            assert.isTrue(Option.isNone(s1.nameIdFormat));
          }),
        },
      ],
      race: [
        {
          name: "plan 24 C10: 8 concurrent saves of one session id all succeed and leave exactly one row",
          run: Effect.gen(function* () {
            const records = yield* SamlRecords.SamlRecords;
            const outcomes = yield* raced(
              many((n) =>
                records.saveSession({
                  sessionId: "s1",
                  connectionId: "c1",
                  nameId: "ada",
                  sessionIndex: `i${n}`,
                }),
              ),
            );
            assert.strictEqual(outcomes.filter(Exit.isSuccess).length, RecordsContract.CONCURRENCY);
            const rows = yield* records.findSessions({ connectionId: "c1", nameId: "ada" });
            assert.strictEqual(rows.length, 1);
            assert.include(
              many((n) => `i${n}`),
              Option.getOrNull(rows[0]?.sessionIndex ?? Option.none()),
            );
          }),
        },
      ],
    },
    findSessions: {
      read: [
        {
          name: "BEH-EA-315: the sessions of one identity at one connection; with a SessionIndex, only that one",
          run: Effect.gen(function* () {
            const records = yield* SamlRecords.SamlRecords;
            yield* records.saveSession({
              sessionId: "s1",
              connectionId: "c1",
              nameId: "ada",
              sessionIndex: "i1",
            });
            yield* records.saveSession({
              sessionId: "s2",
              connectionId: "c1",
              nameId: "ada",
              sessionIndex: "i2",
            });
            yield* records.saveSession({ sessionId: "s3", connectionId: "c1", nameId: "grace" });
            yield* records.saveSession({
              sessionId: "s4",
              connectionId: "other",
              nameId: "ada",
              sessionIndex: "i1",
            });
            assert.deepStrictEqual(
              sessionIds(yield* records.findSessions({ connectionId: "c1", nameId: "ada" })),
              ["s1", "s2"],
            );
            assert.deepStrictEqual(
              sessionIds(
                yield* records.findSessions({
                  connectionId: "c1",
                  nameId: "ada",
                  sessionIndex: "i2",
                }),
              ),
              ["s2"],
            );
            assert.deepStrictEqual(
              yield* records.findSessions({ connectionId: "c1", nameId: "nobody" }),
              [],
            );
          }),
        },
      ],
    },
    findSession: {
      read: [
        {
          name: "a session by its id, with its NameID format and SessionIndex when given",
          run: Effect.gen(function* () {
            const records = yield* SamlRecords.SamlRecords;
            yield* records.saveSession({
              sessionId: "s1",
              connectionId: "c1",
              nameId: "ada",
              nameIdFormat: "emailAddress",
              sessionIndex: "i1",
            });
            yield* records.saveSession({ sessionId: "s3", connectionId: "c1", nameId: "grace" });
            const s1 = Option.getOrThrow(yield* records.findSession("s1"));
            assert.deepStrictEqual(s1.nameIdFormat, Option.some("emailAddress"));
            assert.deepStrictEqual(s1.sessionIndex, Option.some("i1"));
            assert.strictEqual(s1.connectionId, "c1");
            const s3 = Option.getOrThrow(yield* records.findSession("s3"));
            assert.isTrue(Option.isNone(s3.sessionIndex));
            assert.isTrue(Option.isNone(yield* records.findSession("nope")));
          }),
        },
      ],
    },
    removeSession: {
      write: [
        {
          name: "removes one session row; removing it again is a no-op",
          run: Effect.gen(function* () {
            const records = yield* SamlRecords.SamlRecords;
            yield* records.saveSession({ sessionId: "s5", connectionId: "c1", nameId: "ada" });
            yield* records.saveSession({ sessionId: "s6", connectionId: "c1", nameId: "ada" });
            yield* records.removeSession("s5");
            assert.isTrue(Option.isNone(yield* records.findSession("s5")));
            assert.isTrue(Option.isSome(yield* records.findSession("s6")));
            yield* records.removeSession("s5");
          }),
        },
      ],
    },
    pruneSessions: {
      write: [
        {
          name: "drops the rows created before the cutoff, counts them, and keeps the newer ones",
          run: Effect.gen(function* () {
            const records = yield* SamlRecords.SamlRecords;
            yield* records.saveSession({ sessionId: "s1", connectionId: "c1", nameId: "ada" });
            yield* TestClock.adjust(Duration.days(2));
            yield* records.saveSession({ sessionId: "s2", connectionId: "c1", nameId: "ada" });
            yield* records.saveSession({ sessionId: "s3", connectionId: "c2", nameId: "grace" });
            yield* TestClock.adjust(Duration.days(3));
            yield* records.saveSession({ sessionId: "fresh", connectionId: "c1", nameId: "ada" });
            assert.strictEqual(
              yield* records.pruneSessions(
                grant,
                DateTime.subtract(yield* DateTime.now, { days: 2 }),
              ),
              3,
            );
            assert.isTrue(Option.isNone(yield* records.findSession("s2")));
            assert.isTrue(Option.isSome(yield* records.findSession("fresh")));
          }),
        },
      ],
    },
  },
  sql: [
    {
      name: "plan 28: a domain insert refused by a constraint that is not unique is a store failure, and leaves no connection",
      run: Effect.gen(function* () {
        const records = yield* SamlRecords.SamlRecords;
        yield* TestSql.injectFailure({
          name: "saml_domain_refused",
          table: "saml_connection_domain",
          event: "INSERT",
        });
        const refused = yield* records
          .create(input("c1", "org-1", ["acme.example"]))
          .pipe(Effect.flip);
        assert.strictEqual(refused._tag, "StoreUnavailable");
        assert.strictEqual(
          refused._tag === "StoreUnavailable" ? refused.operation : "",
          "SamlRecords.create",
        );
        assert.isFalse(yield* exists("c1"));
      }),
    },
    {
      name: "a failure while replacing the domains rolls the whole update back",
      run: Effect.gen(function* () {
        const records = yield* SamlRecords.SamlRecords;
        yield* records.create(input("c1", "org-1", ["a.example"]));
        yield* TestSql.injectFailure({
          name: "saml_domain_refused_on_update",
          table: "saml_connection_domain",
          event: "INSERT",
        });
        const refused = yield* records
          .update("org-1", "c1", { name: "lost", emailDomains: ["b.example"] })
          .pipe(Effect.flip);
        assert.strictEqual(refused._tag, "StoreUnavailable");
        const kept = Option.getOrThrow(yield* records.findById(grant, "c1"));
        assert.strictEqual(kept.name, "connection c1");
        assert.deepStrictEqual(kept.emailDomains, ["a.example"]);
      }),
    },
    {
      name: "a failure deleting the SP keys rolls the connection's removal back",
      run: Effect.gen(function* () {
        const records = yield* SamlRecords.SamlRecords;
        yield* records.create(input("c1", "org-1", ["a.example"]));
        yield* records.saveSpKey(spKey("k1", "c1"));
        yield* TestSql.injectFailure({
          name: "saml_key_delete_refused",
          table: "saml_sp_key",
          event: "DELETE",
        });
        const refused = yield* records.remove("org-1", "c1").pipe(Effect.flip);
        assert.strictEqual(refused._tag, "StoreUnavailable");
        assert.isTrue(yield* exists("c1"));
        assert.deepStrictEqual(yield* domainOwner("a.example"), Option.some("c1"));
        assert.strictEqual((yield* records.listSpKeys("c1")).length, 1);
      }),
    },
  ],
  tenancy: {
    covers: ["saml_connection", "saml_connection_domain", "saml_sp_key", "saml_session"],
    cases: [
      { table: "saml_connection", insert: insertRow, methods: connectionMethods },
      { table: "saml_connection_domain", insert: insertRow, methods: connectionMethods },
      { table: "saml_sp_key", insert: insertRow, methods: keyMethods },
      { table: "saml_session", insert: insertRow, methods: sessionMethods },
    ],
  },
});
