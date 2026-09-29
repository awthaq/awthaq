// @awthaq/saml — SamlRecords
//
// spec/models/10-saml.md ("`saml_connection`"), BEH-EA-241/244: this plugin's own persistence, owned here so no SAML
// concept leaks into the core schema, built like every plugin's `*Records.ts`: directly against `SqlSchema`, one
// `layerMemory` and one `layerSql` behind one contract suite. Two tables:
//
// - `saml_connection` — one organization's own identity provider: the IdP's entity id, its SSO URL, and its
//   *trust set* (`idpCertificates`: PEM + fingerprint + notBefore/notAfter per certificate, so a key rotation
//   overlaps: publish the next certificate ahead of its use, retire the old one after).
// - `saml_connection_domain` — the email domains that route to a connection, UNIQUE across all connections (a
//   domain routes to exactly one, like `OrganizationConnectionStore.discover` does for OIDC), so home-realm
//   discovery ("ada@acme.example" -> Acme's IdP) is one indexed lookup and a domain cannot be claimed twice.

import { Models as SqlModels } from "@awthaq/sql";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

export interface IdpCertificate {
  readonly pem: string;
  /** SHA-256 of the DER, lower-case hex. */
  readonly fingerprint: string;
  readonly notBefore: DateTime.Utc;
  readonly notAfter: DateTime.Utc;
}

export interface ConnectionRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly idpEntityId: string;
  /** The IdP's single sign-on URL (HTTP-Redirect binding). */
  readonly ssoUrl: string;
  readonly idpCertificates: ReadonlyArray<IdpCertificate>;
  /** Lower-case email domains that route here. */
  readonly emailDomains: ReadonlyArray<string>;
  /**
   * BEH-EA-245's "explicit linking policy", per connection: when `true`, a first sign-in through this connection may
   * link to an existing local account with the asserted email, but only if that account's own address is already
   * verified. Default `false`: an IdP asserts an identity in ITS directory, not ownership of a local account.
   */
  readonly trustsEmail: boolean;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}

export class SamlRecordNotFound extends Data.TaggedError("SamlRecordNotFound")<{
  readonly id: string;
}> {}

/** An email domain is already routed to another connection. */
export class SamlDomainTaken extends Data.TaggedError("SamlDomainTaken")<{
  readonly domain: string;
}> {}

export interface NewConnection {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly idpEntityId: string;
  readonly ssoUrl: string;
  readonly idpCertificates: ReadonlyArray<IdpCertificate>;
  readonly emailDomains: ReadonlyArray<string>;
  readonly trustsEmail: boolean;
}

export interface SamlRecordsShape {
  readonly create: (input: NewConnection) => Effect.Effect<ConnectionRecord, SamlDomainTaken>;
  readonly findById: (id: string) => Effect.Effect<Option.Option<ConnectionRecord>>;
  /** Oldest first. */
  readonly listByOrganization: (
    organizationId: string,
  ) => Effect.Effect<ReadonlyArray<ConnectionRecord>>;
  /** The connection an email domain routes to, if any. */
  readonly findByDomain: (domain: string) => Effect.Effect<Option.Option<ConnectionRecord>>;
  /** Fields left out are unchanged; `emailDomains`, when given, replaces the whole set. */
  readonly update: (
    id: string,
    patch: {
      readonly name?: string | undefined;
      readonly idpEntityId?: string | undefined;
      readonly ssoUrl?: string | undefined;
      readonly idpCertificates?: ReadonlyArray<IdpCertificate> | undefined;
      readonly emailDomains?: ReadonlyArray<string> | undefined;
      readonly trustsEmail?: boolean | undefined;
    },
  ) => Effect.Effect<ConnectionRecord, SamlRecordNotFound | SamlDomainTaken>;
  readonly remove: (id: string) => Effect.Effect<void, SamlRecordNotFound>;
}

export class SamlRecords extends Context.Service<SamlRecords, SamlRecordsShape>()(
  "awthaq/saml/SamlRecords",
) {}

const notFound = (id: string): SamlRecordNotFound => new SamlRecordNotFound({ id });

const byCreation = (rows: ReadonlyArray<ConnectionRecord>): ReadonlyArray<ConnectionRecord> =>
  [...rows].sort(
    (a, b) =>
      DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt) ||
      a.id.localeCompare(b.id),
  );

// ---- layerMemory ------------------------------------------------------------------------

export const layerMemory = Layer.effect(
  SamlRecords,
  Effect.gen(function* () {
    const state = yield* Ref.make<ReadonlyArray<ConnectionRecord>>([]);

    /** The first domain in `domains` that another connection already holds. */
    const takenDomain = (
      rows: ReadonlyArray<ConnectionRecord>,
      domains: ReadonlyArray<string>,
      exceptId: string,
    ) =>
      domains.find((domain) =>
        rows.some((row) => row.id !== exceptId && row.emailDomains.includes(domain)),
      );

    const create: SamlRecordsShape["create"] = (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const record: ConnectionRecord = { ...input, createdAt: now, updatedAt: now };
        const outcome = yield* Ref.modify(
          state,
          (rows): readonly [Result.Result<ConnectionRecord, SamlDomainTaken>, ReadonlyArray<ConnectionRecord>] => {
            const taken = takenDomain(rows, input.emailDomains, input.id);
            if (taken !== undefined) return [Result.fail(new SamlDomainTaken({ domain: taken })), rows] as const;
            return [Result.succeed(record), [...rows, record]] as const;
          },
        );
        return yield* Effect.fromResult(outcome);
      });

    const update: SamlRecordsShape["update"] = (id, patch) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const outcome = yield* Ref.modify(
          state,
          (
            rows,
          ): readonly [
            Result.Result<ConnectionRecord, SamlRecordNotFound | SamlDomainTaken>,
            ReadonlyArray<ConnectionRecord>,
          ] => {
            const existing = rows.find((row) => row.id === id);
            if (existing === undefined) return [Result.fail(notFound(id)), rows] as const;
            const taken = takenDomain(rows, patch.emailDomains ?? [], id);
            if (taken !== undefined) return [Result.fail(new SamlDomainTaken({ domain: taken })), rows] as const;
            const updated: ConnectionRecord = {
              ...existing,
              ...(patch.name === undefined ? {} : { name: patch.name }),
              ...(patch.idpEntityId === undefined ? {} : { idpEntityId: patch.idpEntityId }),
              ...(patch.ssoUrl === undefined ? {} : { ssoUrl: patch.ssoUrl }),
              ...(patch.idpCertificates === undefined ? {} : { idpCertificates: patch.idpCertificates }),
              ...(patch.emailDomains === undefined ? {} : { emailDomains: patch.emailDomains }),
              ...(patch.trustsEmail === undefined ? {} : { trustsEmail: patch.trustsEmail }),
              updatedAt: now,
            };
            return [
              Result.succeed(updated),
              rows.map((row) => (row.id === id ? updated : row)),
            ] as const;
          },
        );
        return yield* Effect.fromResult(outcome);
      });

    return {
      create,
      findById: (id) =>
        Ref.get(state).pipe(Effect.map((rows) => Option.fromNullishOr(rows.find((row) => row.id === id)))),
      listByOrganization: (organizationId) =>
        Ref.get(state).pipe(
          Effect.map((rows) => byCreation(rows.filter((row) => row.organizationId === organizationId))),
        ),
      findByDomain: (domain) =>
        Ref.get(state).pipe(
          Effect.map((rows) => Option.fromNullishOr(rows.find((row) => row.emailDomains.includes(domain)))),
        ),
      update,
      remove: (id) =>
        Effect.gen(function* () {
          const removed = yield* Ref.modify(state, (rows) =>
            rows.some((row) => row.id === id)
              ? ([true, rows.filter((row) => row.id !== id)] as const)
              : ([false, rows] as const),
          );
          if (!removed) return yield* Effect.fail(notFound(id));
        }),
    } satisfies SamlRecordsShape;
  }),
);

// ---- layerSql -----------------------------------------------------------------------------

const CertificateJson = Schema.Struct({
  pem: Schema.String,
  fingerprint: Schema.String,
  notBefore: Schema.DateTimeUtcFromString,
  notAfter: Schema.DateTimeUtcFromString,
});

const makeConnectionRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({
    id: Schema.String,
    organizationId: Schema.String,
    name: Schema.String,
    idpEntityId: Schema.String,
    ssoUrl: Schema.String,
    idpCertificates: Schema.fromJsonString(Schema.Array(CertificateJson)),
    trustsEmail: wire.boolean,
    createdAt: wire.dateTime,
    updatedAt: wire.dateTime,
  });

export const layerSql = Layer.effect(
  SamlRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // TS-001: the row codecs follow the ambient client's dialect (Date on pg, ISO string on SQLite).
    const wire = SqlModels.dialectFields(yield* SqlModels.resolveDialect(sql));
    const ConnectionRow = makeConnectionRow(wire);
    const DomainRow = Schema.Struct({ domain: Schema.String, connectionId: Schema.String });

    const toRecord = (
      row: typeof ConnectionRow.Type,
      domains: ReadonlyArray<string>,
    ): ConnectionRecord => ({
      id: row.id,
      organizationId: row.organizationId,
      name: row.name,
      idpEntityId: row.idpEntityId,
      ssoUrl: row.ssoUrl,
      idpCertificates: row.idpCertificates,
      emailDomains: domains,
      trustsEmail: row.trustsEmail,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });

    const insertConnection = SqlSchema.findOne({
      Request: ConnectionRow,
      Result: ConnectionRow,
      execute: (r) => sql`
        INSERT INTO saml_connection (id, "organizationId", name, "idpEntityId", "ssoUrl", "idpCertificates", "trustsEmail", "createdAt", "updatedAt")
        VALUES (${r.id}, ${r.organizationId}, ${r.name}, ${r.idpEntityId}, ${r.ssoUrl}, ${r.idpCertificates}, ${r.trustsEmail}, ${r.createdAt}, ${r.updatedAt})
        RETURNING *`,
    });
    const connectionById = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: ConnectionRow,
      execute: (id) => sql`SELECT * FROM saml_connection WHERE id = ${id}`,
    });
    const connectionsOf = SqlSchema.findAll({
      Request: Schema.String,
      Result: ConnectionRow,
      execute: (organizationId) =>
        sql`SELECT * FROM saml_connection WHERE "organizationId" = ${organizationId} ORDER BY "createdAt", id`,
    });
    const connectionByDomain = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: ConnectionRow,
      execute: (domain) => sql`
        SELECT c.* FROM saml_connection c
        JOIN saml_connection_domain d ON d."connectionId" = c.id
        WHERE d.domain = ${domain}`,
    });
    const domainsOf = SqlSchema.findAll({
      Request: Schema.String,
      Result: DomainRow,
      execute: (connectionId) =>
        sql`SELECT domain, "connectionId" FROM saml_connection_domain WHERE "connectionId" = ${connectionId} ORDER BY domain`,
    });
    const writeMutable = SqlSchema.findOneOption({
      Request: Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        idpEntityId: Schema.String,
        ssoUrl: Schema.String,
        idpCertificates: Schema.fromJsonString(Schema.Array(CertificateJson)),
        trustsEmail: wire.boolean,
        updatedAt: wire.dateTime,
      }),
      Result: ConnectionRow,
      execute: (r) => sql`
        UPDATE saml_connection SET name = ${r.name}, "idpEntityId" = ${r.idpEntityId}, "ssoUrl" = ${r.ssoUrl},
          "idpCertificates" = ${r.idpCertificates}, "trustsEmail" = ${r.trustsEmail}, "updatedAt" = ${r.updatedAt}
        WHERE id = ${r.id}
        RETURNING *`,
    });

    const withDomains = (row: typeof ConnectionRow.Type) =>
      domainsOf(row.id).pipe(
        Effect.map((rows) => toRecord(row, rows.map((entry) => entry.domain))),
        Effect.orDie,
      );

    /** Inserts each domain; a unique-index violation names the domain that is taken. */
    const claimDomains = (connectionId: string, domains: ReadonlyArray<string>) =>
      Effect.forEach(
        domains,
        (domain) =>
          sql`INSERT INTO saml_connection_domain (domain, "connectionId") VALUES (${domain}, ${connectionId})`.pipe(
            Effect.catchTag("SqlError", (error) =>
              // Postgres reports a duplicate key as a unique violation; SQLite reports a PRIMARY KEY clash as a
              // generic constraint error (the domain IS the key), so both mean "taken".
              error.reason._tag === "UniqueViolation" || error.reason._tag === "ConstraintError"
                ? Effect.fail(new SamlDomainTaken({ domain }))
                : Effect.die(error),
            ),
          ),
        { discard: true },
      );

    const create: SamlRecordsShape["create"] = (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const row = yield* insertConnection({
          id: input.id,
          organizationId: input.organizationId,
          name: input.name,
          idpEntityId: input.idpEntityId,
          ssoUrl: input.ssoUrl,
          idpCertificates: input.idpCertificates,
          trustsEmail: input.trustsEmail,
          createdAt: now,
          updatedAt: now,
        }).pipe(Effect.orDie);
        // A taken domain leaves no half-created connection behind.
        yield* claimDomains(input.id, input.emailDomains).pipe(
          Effect.tapError(() =>
            sql`DELETE FROM saml_connection WHERE id = ${input.id}`.pipe(
              Effect.andThen(sql`DELETE FROM saml_connection_domain WHERE "connectionId" = ${input.id}`),
              Effect.orDie,
            ),
          ),
        );
        return toRecord(row, input.emailDomains);
      });

    const update: SamlRecordsShape["update"] = (id, patch) =>
      Effect.gen(function* () {
        const current = yield* connectionById(id).pipe(Effect.orDie);
        if (Option.isNone(current)) return yield* Effect.fail(notFound(id));
        const now = yield* DateTime.now;
        if (patch.emailDomains !== undefined) {
          const before = (yield* domainsOf(id).pipe(Effect.orDie)).map((entry) => entry.domain);
          yield* sql`DELETE FROM saml_connection_domain WHERE "connectionId" = ${id}`.pipe(Effect.orDie);
          yield* claimDomains(id, patch.emailDomains).pipe(
            // Put the previous set back if a new domain is taken.
            Effect.tapError(() =>
              sql`DELETE FROM saml_connection_domain WHERE "connectionId" = ${id}`.pipe(
                Effect.andThen(claimDomains(id, before).pipe(Effect.orDie)),
                Effect.orDie,
              ),
            ),
          );
        }
        const row = yield* writeMutable({
          id,
          name: patch.name ?? current.value.name,
          idpEntityId: patch.idpEntityId ?? current.value.idpEntityId,
          ssoUrl: patch.ssoUrl ?? current.value.ssoUrl,
          idpCertificates: patch.idpCertificates ?? current.value.idpCertificates,
          trustsEmail: patch.trustsEmail ?? current.value.trustsEmail,
          updatedAt: now,
        }).pipe(Effect.orDie);
        if (Option.isNone(row)) return yield* Effect.fail(notFound(id));
        return yield* withDomains(row.value);
      });

    return {
      create,
      findById: (id) =>
        connectionById(id).pipe(
          Effect.orDie,
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: (row) => Effect.map(withDomains(row), Option.some),
            }),
          ),
        ),
      listByOrganization: (organizationId) =>
        connectionsOf(organizationId).pipe(
          Effect.orDie,
          Effect.flatMap((rows) => Effect.forEach(rows, withDomains)),
        ),
      findByDomain: (domain) =>
        connectionByDomain(domain).pipe(
          Effect.orDie,
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: (row) => Effect.map(withDomains(row), Option.some),
            }),
          ),
        ),
      update,
      remove: (id) =>
        Effect.gen(function* () {
          const removed = yield* sql`DELETE FROM saml_connection WHERE id = ${id} RETURNING id`.pipe(Effect.orDie);
          if (removed.length === 0) return yield* Effect.fail(notFound(id));
          yield* sql`DELETE FROM saml_connection_domain WHERE "connectionId" = ${id}`.pipe(Effect.orDie);
        }),
    } satisfies SamlRecordsShape;
  }),
);
