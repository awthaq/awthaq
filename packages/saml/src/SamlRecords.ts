// @awthaq/saml — SamlRecords
//
// spec/models/10-saml.md ("`saml_connection`"), BEH-EA-241/244: this plugin's own persistence, owned here so no SAML
// concept leaks into the core schema, built like every plugin's `*Records.ts`: directly against `SqlSchema`, one
// `layerMemory` and one `layerSql` behind one contract suite. Four tables:
//
// - `saml_connection` — one organization's own identity provider: the IdP's entity id, its SSO URL, and its
//   *trust set* (`idpCertificates`: PEM + fingerprint + notBefore/notAfter per certificate, so a key rotation
//   overlaps: publish the next certificate ahead of its use, retire the old one after). BEH-EA-314..309 add whether
//   AuthnRequests are signed, the IdP's single-logout endpoint, the metadata URL it was imported from and the role
//   mapping (rules, ceiling, defaults).
// - `saml_connection_domain` — the email domains that route to a connection, UNIQUE across all connections (a
//   domain routes to exactly one, like `OrganizationConnectionStore.discover` does for OIDC), so home-realm
//   discovery ("ada@acme.example" -> Acme's IdP) is one indexed lookup and a domain cannot be claimed twice.
// - `saml_sp_key` — the service provider's own signing keys, per connection (BEH-EA-314): the certificate (public) and
//   the private key a `SealedColumn` (plan 05, ADR-EA-019 decision 6: sealed under `saml_sp_key:<id>:privateKey`, re-sealed
//   on read; a database read discloses nothing that signs). Several rows are a rotation overlap: the newest signs, every unexpired certificate is published.
// - `saml_session` — which local sessions a connection's sign-ins created, with the NameID and SessionIndex the IdP knows
//   them by (BEH-EA-315): what a Single Logout request from the IdP has to find.

import { type Encryption } from "@awthaq/ports";
import { Models as SqlModels, SealedColumn, StoreFailure, TenantScoped } from "@awthaq/sql";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
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

/**
 * BEH-EA-316: one mapping rule. When the assertion carries `attribute` (case-insensitive) with a value equal to `value`
 * (any value when `value` is absent), the user is given `roles` in the connection's organization. Rules are additive: a
 * user's roles are the union of every rule that matched.
 */
export interface RoleRule {
  readonly attribute: string;
  readonly value?: string | undefined;
  readonly roles: ReadonlyArray<string>;
}

/**
 * BEH-EA-316: the connection's role mapping. `ceiling` is the most it can confer (role names of the organization; the
 * `canGrant` rule of RRM-001 with the ceiling standing in for the caller), so a connection cannot mint `owner` unless its
 * ceiling holds it. `defaultRoles` are given when no rule matched (empty: a sign-in that matched nothing changes nothing).
 */
export interface RoleMapping {
  readonly rules: ReadonlyArray<RoleRule>;
  readonly ceiling: ReadonlyArray<string>;
  readonly defaultRoles: ReadonlyArray<string>;
}

export const EMPTY_ROLE_MAPPING: RoleMapping = { rules: [], ceiling: ["member"], defaultRoles: [] };

export type SloBinding = "redirect" | "post";

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
  /** BEH-EA-314: sign the AuthnRequests (and Single Logout messages) with the connection's SP key. Default `false`. */
  readonly authnRequestsSigned: boolean;
  /** BEH-EA-315: where this connection's IdP takes logout requests, and by which binding; `None`: no Single Logout. */
  readonly sloUrl: Option.Option<string>;
  readonly sloBinding: SloBinding;
  /** BEH-EA-318: the IdP metadata URL the connection was imported from (what a refresh re-reads). */
  readonly metadataUrl: Option.Option<string>;
  readonly roleMapping: RoleMapping;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}

/** One SP signing key (BEH-EA-314). `privateKey` is sealed: open it where the key signs, never before. */
export interface SpKeyRecord {
  readonly id: string;
  readonly connectionId: string;
  readonly certificate: string;
  readonly privateKey: SealedColumn.Sealed<string>;
  readonly fingerprint: string;
  readonly notBefore: DateTime.Utc;
  readonly notAfter: DateTime.Utc;
  readonly createdAt: DateTime.Utc;
}

/** A key to store: the records seal the PEM under the row's AAD. */
export interface NewSpKey extends Omit<SpKeyRecord, "createdAt" | "privateKey"> {
  readonly privateKey: Redacted.Redacted<string>;
}

/** The sealed `privateKey` column (the legacy AAD spelling still opens, then re-seals canonically). */
export const privateKeyColumn = SealedColumn.column({
  table: "saml_sp_key",
  column: "privateKey",
  key: "id",
  legacyAad: [(id) => `saml-sp-key:${id}:privateKey`],
});

/** A local session a connection's sign-in created (BEH-EA-315). */
export interface SamlSessionRecord {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly nameId: string;
  readonly nameIdFormat: Option.Option<string>;
  readonly sessionIndex: Option.Option<string>;
  readonly createdAt: DateTime.Utc;
}

export interface NewSamlSession {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly nameId: string;
  readonly nameIdFormat?: string | undefined;
  readonly sessionIndex?: string | undefined;
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
  readonly authnRequestsSigned?: boolean | undefined;
  readonly sloUrl?: string | undefined;
  readonly sloBinding?: SloBinding | undefined;
  readonly metadataUrl?: string | undefined;
  readonly roleMapping?: RoleMapping | undefined;
}

export interface ConnectionPatch {
  readonly name?: string | undefined;
  readonly idpEntityId?: string | undefined;
  readonly ssoUrl?: string | undefined;
  readonly idpCertificates?: ReadonlyArray<IdpCertificate> | undefined;
  readonly emailDomains?: ReadonlyArray<string> | undefined;
  readonly trustsEmail?: boolean | undefined;
  readonly authnRequestsSigned?: boolean | undefined;
  /** `null` removes the single-logout endpoint. */
  readonly sloUrl?: string | null | undefined;
  readonly sloBinding?: SloBinding | undefined;
  /** `null` forgets the metadata URL. */
  readonly metadataUrl?: string | null | undefined;
  readonly roleMapping?: RoleMapping | undefined;
}

export interface SamlRecordsShape {
  readonly create: (
    input: NewConnection,
  ) => Effect.Effect<ConnectionRecord, SamlDomainTaken | StoreFailure.StoreUnavailable>;
  /**
   * A connection by its own id: how a protocol message (an ACS response, a logout request, SP metadata) names it before
   * any tenant is known, so the lookup presents a witness.
   */
  readonly findById: (
    grant: TenantScoped.CrossTenant,
    id: string,
  ) => Effect.Effect<Option.Option<ConnectionRecord>, StoreFailure.StoreUnavailable>;
  /** Oldest first. */
  readonly listByOrganization: (
    organizationId: string,
  ) => Effect.Effect<ReadonlyArray<ConnectionRecord>, StoreFailure.StoreUnavailable>;
  /** The connection an email domain routes to, if any: home-realm discovery crosses organizations, so it presents a witness. */
  readonly findByDomain: (
    grant: TenantScoped.CrossTenant,
    domain: string,
  ) => Effect.Effect<Option.Option<ConnectionRecord>, StoreFailure.StoreUnavailable>;
  /** Fields left out are unchanged; `emailDomains`, when given, replaces the whole set. */
  readonly update: (
    organizationId: string,
    id: string,
    patch: ConnectionPatch,
  ) => Effect.Effect<
    ConnectionRecord,
    SamlRecordNotFound | SamlDomainTaken | StoreFailure.StoreUnavailable
  >;
  /** Removes the connection with its domains, SP keys and session rows. */
  readonly remove: (
    organizationId: string,
    id: string,
  ) => Effect.Effect<void, SamlRecordNotFound | StoreFailure.StoreUnavailable>;
  // ---- SP signing keys (BEH-EA-314)
  readonly saveSpKey: (key: NewSpKey) => Effect.Effect<SpKeyRecord, StoreFailure.StoreUnavailable>;
  /** Newest first. */
  readonly listSpKeys: (
    connectionId: string,
  ) => Effect.Effect<ReadonlyArray<SpKeyRecord>, StoreFailure.StoreUnavailable>;
  // ---- sessions created by a connection's sign-ins (BEH-EA-315)
  readonly saveSession: (
    session: NewSamlSession,
  ) => Effect.Effect<void, StoreFailure.StoreUnavailable>;
  /** The sessions of one identity at one connection; with `sessionIndex`, only that one. */
  readonly findSessions: (input: {
    readonly connectionId: string;
    readonly nameId: string;
    readonly sessionIndex?: string | undefined;
  }) => Effect.Effect<ReadonlyArray<SamlSessionRecord>, StoreFailure.StoreUnavailable>;
  readonly findSession: (
    sessionId: string,
  ) => Effect.Effect<Option.Option<SamlSessionRecord>, StoreFailure.StoreUnavailable>;
  readonly removeSession: (sessionId: string) => Effect.Effect<void, StoreFailure.StoreUnavailable>;
  /**
   * Removes rows created before `before` (a session that old is over whatever this says); returns how many. A maintenance
   * sweep over every organization, so it presents a witness.
   */
  readonly pruneSessions: (
    grant: TenantScoped.CrossTenant,
    before: DateTime.Utc,
  ) => Effect.Effect<number, StoreFailure.StoreUnavailable>;
}

export class SamlRecords extends Context.Service<SamlRecords, SamlRecordsShape>()(
  "awthaq/saml/records/SamlRecords",
) {}

const notFound = (id: string): SamlRecordNotFound => new SamlRecordNotFound({ id });

const byCreation = (rows: ReadonlyArray<ConnectionRecord>): ReadonlyArray<ConnectionRecord> =>
  [...rows].sort(
    (a, b) =>
      DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt) ||
      a.id.localeCompare(b.id),
  );

const newestFirst = <A extends { readonly createdAt: DateTime.Utc; readonly id: string }>(
  rows: ReadonlyArray<A>,
): ReadonlyArray<A> =>
  [...rows].sort(
    (a, b) =>
      DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt) ||
      b.id.localeCompare(a.id),
  );

const applyPatch = (
  existing: ConnectionRecord,
  patch: ConnectionPatch,
  now: DateTime.Utc,
): ConnectionRecord => ({
  ...existing,
  ...(patch.name === undefined ? {} : { name: patch.name }),
  ...(patch.idpEntityId === undefined ? {} : { idpEntityId: patch.idpEntityId }),
  ...(patch.ssoUrl === undefined ? {} : { ssoUrl: patch.ssoUrl }),
  ...(patch.idpCertificates === undefined ? {} : { idpCertificates: patch.idpCertificates }),
  ...(patch.emailDomains === undefined ? {} : { emailDomains: patch.emailDomains }),
  ...(patch.trustsEmail === undefined ? {} : { trustsEmail: patch.trustsEmail }),
  ...(patch.authnRequestsSigned === undefined
    ? {}
    : { authnRequestsSigned: patch.authnRequestsSigned }),
  ...(patch.sloUrl === undefined ? {} : { sloUrl: Option.fromNullOr(patch.sloUrl) }),
  ...(patch.sloBinding === undefined ? {} : { sloBinding: patch.sloBinding }),
  ...(patch.metadataUrl === undefined ? {} : { metadataUrl: Option.fromNullOr(patch.metadataUrl) }),
  ...(patch.roleMapping === undefined ? {} : { roleMapping: patch.roleMapping }),
  updatedAt: now,
});

// ---- layerMemory ------------------------------------------------------------------------

/** A key as the memory adapter keeps it: the private half is the envelope string, like a SQL row. */
interface StoredSpKey extends Omit<SpKeyRecord, "privateKey"> {
  readonly privateKey: string;
}

interface MemoryState {
  readonly connections: ReadonlyArray<ConnectionRecord>;
  readonly keys: ReadonlyArray<StoredSpKey>;
  readonly sessions: ReadonlyArray<SamlSessionRecord>;
}

/**
 * A test seam of `layerMemory`: the stored envelope of the sealed `privateKey` column, and a way to overwrite it
 * (`TestAuth.runSealedColumnTests` needs to look at, and plant, what is at rest; over SQL that is a statement).
 */
export class MemoryEnvelopes extends Context.Service<
  MemoryEnvelopes,
  {
    readonly stored: (id: string) => Effect.Effect<string>;
    readonly plant: (id: string, stored: string) => Effect.Effect<void>;
  }
>()("awthaq/saml/SamlRecords/MemoryEnvelopes") {}

// The explicit types on `layerMemory` and `layerSql` are the narrow exception the plugins document (TS2883):
// declaration emit cannot name `Encryption` through the inferred requirement of the sealed-column codec.
export const layerMemory: Layer.Layer<SamlRecords | MemoryEnvelopes, never, Encryption.Encryption> =
  Layer.effectContext(
    Effect.gen(function* () {
      const state = yield* Ref.make<MemoryState>({ connections: [], keys: [], sessions: [] });

      /** Persists a re-seal only while the row still holds the envelope that was read. */
      const swap: SealedColumn.Swap = (rowKey, stored, fresh) =>
        Ref.modify(state, (s) => {
          const row = s.keys.find((candidate) => candidate.id === rowKey);
          if (row === undefined || row.privateKey !== stored) return [false, s] as const;
          return [
            true,
            {
              ...s,
              keys: s.keys.map((candidate) =>
                candidate.id === rowKey ? { ...candidate, privateKey: fresh } : candidate,
              ),
            },
          ] as const;
        });
      const privateKeys = yield* SealedColumn.codec(privateKeyColumn, swap);
      const toKeyRecord = (row: StoredSpKey): SpKeyRecord => ({
        ...row,
        privateKey: privateKeys.sealed(row.id, row.privateKey),
      });

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
          const record: ConnectionRecord = {
            id: input.id,
            organizationId: input.organizationId,
            name: input.name,
            idpEntityId: input.idpEntityId,
            ssoUrl: input.ssoUrl,
            idpCertificates: input.idpCertificates,
            emailDomains: input.emailDomains,
            trustsEmail: input.trustsEmail,
            authnRequestsSigned: input.authnRequestsSigned ?? false,
            sloUrl: Option.fromNullishOr(input.sloUrl),
            sloBinding: input.sloBinding ?? "redirect",
            metadataUrl: Option.fromNullishOr(input.metadataUrl),
            roleMapping: input.roleMapping ?? EMPTY_ROLE_MAPPING,
            createdAt: now,
            updatedAt: now,
          };
          const outcome = yield* Ref.modify(
            state,
            (s): readonly [Result.Result<ConnectionRecord, SamlDomainTaken>, MemoryState] => {
              const taken = takenDomain(s.connections, input.emailDomains, input.id);
              if (taken !== undefined)
                return [Result.fail(new SamlDomainTaken({ domain: taken })), s] as const;
              return [
                Result.succeed(record),
                { ...s, connections: [...s.connections, record] },
              ] as const;
            },
          );
          return yield* Effect.fromResult(outcome);
        });

      const update: SamlRecordsShape["update"] = (organizationId, id, patch) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const outcome = yield* Ref.modify(
            state,
            (
              s,
            ): readonly [
              Result.Result<ConnectionRecord, SamlRecordNotFound | SamlDomainTaken>,
              MemoryState,
            ] => {
              const existing = s.connections.find(
                (row) => row.id === id && row.organizationId === organizationId,
              );
              if (existing === undefined) return [Result.fail(notFound(id)), s] as const;
              const taken = takenDomain(s.connections, patch.emailDomains ?? [], id);
              if (taken !== undefined)
                return [Result.fail(new SamlDomainTaken({ domain: taken })), s] as const;
              const updated = applyPatch(existing, patch, now);
              return [
                Result.succeed(updated),
                { ...s, connections: s.connections.map((row) => (row.id === id ? updated : row)) },
              ] as const;
            },
          );
          return yield* Effect.fromResult(outcome);
        });

      const records = {
        create,
        findById: (_grant, id) =>
          Ref.get(state).pipe(
            Effect.map((s) => Option.fromNullishOr(s.connections.find((row) => row.id === id))),
          ),
        listByOrganization: (organizationId) =>
          Ref.get(state).pipe(
            Effect.map((s) =>
              byCreation(s.connections.filter((row) => row.organizationId === organizationId)),
            ),
          ),
        findByDomain: (_grant, domain) =>
          Ref.get(state).pipe(
            Effect.map((s) =>
              Option.fromNullishOr(s.connections.find((row) => row.emailDomains.includes(domain))),
            ),
          ),
        update,
        remove: (organizationId, id) =>
          Effect.gen(function* () {
            const removed = yield* Ref.modify(state, (s) =>
              s.connections.some((row) => row.id === id && row.organizationId === organizationId)
                ? ([
                    true,
                    {
                      connections: s.connections.filter((row) => row.id !== id),
                      keys: s.keys.filter((row) => row.connectionId !== id),
                      sessions: s.sessions.filter((row) => row.connectionId !== id),
                    },
                  ] as const)
                : ([false, s] as const),
            );
            if (!removed) return yield* Effect.fail(notFound(id));
          }),
        saveSpKey: (key) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const sealed = yield* privateKeys.seal(key.id, key.privateKey);
            const record: StoredSpKey = { ...key, privateKey: sealed, createdAt: now };
            yield* Ref.update(state, (s) => ({ ...s, keys: [...s.keys, record] }));
            return toKeyRecord(record);
          }),
        listSpKeys: (connectionId) =>
          Ref.get(state).pipe(
            Effect.map((s) =>
              newestFirst(s.keys.filter((row) => row.connectionId === connectionId)).map(
                toKeyRecord,
              ),
            ),
          ),
        saveSession: (session) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const record: SamlSessionRecord = {
              sessionId: session.sessionId,
              connectionId: session.connectionId,
              nameId: session.nameId,
              nameIdFormat: Option.fromNullishOr(session.nameIdFormat),
              sessionIndex: Option.fromNullishOr(session.sessionIndex),
              createdAt: now,
            };
            yield* Ref.update(state, (s) => ({
              ...s,
              sessions: [
                ...s.sessions.filter((row) => row.sessionId !== session.sessionId),
                record,
              ],
            }));
          }),
        findSessions: ({ connectionId, nameId, sessionIndex }) =>
          Ref.get(state).pipe(
            Effect.map((s) =>
              s.sessions.filter(
                (row) =>
                  row.connectionId === connectionId &&
                  row.nameId === nameId &&
                  (sessionIndex === undefined ||
                    Option.getOrNull(row.sessionIndex) === sessionIndex),
              ),
            ),
          ),
        findSession: (sessionId) =>
          Ref.get(state).pipe(
            Effect.map((s) =>
              Option.fromNullishOr(s.sessions.find((row) => row.sessionId === sessionId)),
            ),
          ),
        removeSession: (sessionId) =>
          Ref.update(state, (s) => ({
            ...s,
            sessions: s.sessions.filter((row) => row.sessionId !== sessionId),
          })),
        pruneSessions: (_grant, before) =>
          Ref.modify(state, (s) => {
            const kept = s.sessions.filter(
              (row) => DateTime.toEpochMillis(row.createdAt) >= DateTime.toEpochMillis(before),
            );
            return [s.sessions.length - kept.length, { ...s, sessions: kept }] as const;
          }),
      } satisfies SamlRecordsShape;
      const envelopes = MemoryEnvelopes.of({
        stored: (id) =>
          Effect.map(Ref.get(state), (s) => s.keys.find((row) => row.id === id)?.privateKey ?? ""),
        plant: (id, stored) =>
          Ref.update(state, (s) => ({
            ...s,
            keys: s.keys.map((row) => (row.id === id ? { ...row, privateKey: stored } : row)),
          })),
      });
      return Context.make(SamlRecords, records).pipe(Context.add(MemoryEnvelopes, envelopes));
    }),
  );

// ---- layerSql -----------------------------------------------------------------------------

const CertificateJson = Schema.Struct({
  pem: Schema.String,
  fingerprint: Schema.String,
  notBefore: Schema.DateTimeUtcFromString,
  notAfter: Schema.DateTimeUtcFromString,
});

const RoleMappingJson = Schema.fromJsonString(
  Schema.Struct({
    rules: Schema.Array(
      Schema.Struct({
        attribute: Schema.String,
        value: Schema.optional(Schema.String),
        roles: Schema.Array(Schema.String),
      }),
    ),
    ceiling: Schema.Array(Schema.String),
    defaultRoles: Schema.Array(Schema.String),
  }),
);

const SloBindingSchema = Schema.Literals(["redirect", "post"]);

const makeConnectionRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({
    id: Schema.String,
    organizationId: Schema.String,
    name: Schema.String,
    idpEntityId: Schema.String,
    ssoUrl: Schema.String,
    idpCertificates: Schema.fromJsonString(Schema.Array(CertificateJson)),
    trustsEmail: wire.boolean,
    authnRequestsSigned: wire.boolean,
    sloUrl: Schema.NullOr(Schema.String),
    sloBinding: SloBindingSchema,
    metadataUrl: Schema.NullOr(Schema.String),
    roleMapping: RoleMappingJson,
    createdAt: wire.dateTime,
    updatedAt: wire.dateTime,
  });

const makeKeyRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({
    id: Schema.String,
    connectionId: Schema.String,
    certificate: Schema.String,
    privateKey: Schema.String,
    fingerprint: Schema.String,
    notBefore: wire.dateTime,
    notAfter: wire.dateTime,
    createdAt: wire.dateTime,
  });

const makeSessionRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({
    sessionId: Schema.String,
    connectionId: Schema.String,
    nameId: Schema.String,
    nameIdFormat: Schema.NullOr(Schema.String),
    sessionIndex: Schema.NullOr(Schema.String),
    createdAt: wire.dateTime,
  });

export const layerSql: Layer.Layer<
  SamlRecords,
  never,
  SqlClient.SqlClient | Encryption.Encryption
> = Layer.effect(
  SamlRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const unavailable = (operation: string) =>
      StoreFailure.orStoreUnavailable(`SamlRecords.${operation}`);
    const privateKeys = yield* SealedColumn.codec(
      privateKeyColumn,
      yield* SealedColumn.sqlSwap(privateKeyColumn),
    );
    // TS-001: the row codecs follow the ambient client's dialect (Date on pg, ISO string on SQLite).
    const dialect = yield* SqlModels.resolveDialect(sql);
    const wire = SqlModels.dialectFields(dialect);
    const wireDate = (instant: DateTime.Utc) =>
      dialect === "pg" ? DateTime.toDate(instant) : DateTime.formatIso(instant);
    const ConnectionRow = makeConnectionRow(wire);
    const KeyRow = makeKeyRow(wire);
    const SessionRow = makeSessionRow(wire);
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
      authnRequestsSigned: row.authnRequestsSigned,
      sloUrl: Option.fromNullOr(row.sloUrl),
      sloBinding: row.sloBinding,
      metadataUrl: Option.fromNullOr(row.metadataUrl),
      roleMapping: row.roleMapping,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });

    const insertConnection = SqlSchema.findOne({
      Request: ConnectionRow,
      Result: ConnectionRow,
      execute: (r) => sql`
        INSERT INTO saml_connection (id, "organizationId", name, "idpEntityId", "ssoUrl", "idpCertificates", "trustsEmail",
          "authnRequestsSigned", "sloUrl", "sloBinding", "metadataUrl", "roleMapping", "createdAt", "updatedAt")
        VALUES (${r.id}, ${r.organizationId}, ${r.name}, ${r.idpEntityId}, ${r.ssoUrl}, ${r.idpCertificates}, ${r.trustsEmail},
          ${r.authnRequestsSigned}, ${r.sloUrl}, ${r.sloBinding}, ${r.metadataUrl}, ${r.roleMapping}, ${r.createdAt}, ${r.updatedAt})
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
        authnRequestsSigned: wire.boolean,
        sloUrl: Schema.NullOr(Schema.String),
        sloBinding: SloBindingSchema,
        metadataUrl: Schema.NullOr(Schema.String),
        roleMapping: RoleMappingJson,
        updatedAt: wire.dateTime,
      }),
      Result: ConnectionRow,
      execute: (r) => sql`
        UPDATE saml_connection SET name = ${r.name}, "idpEntityId" = ${r.idpEntityId}, "ssoUrl" = ${r.ssoUrl},
          "idpCertificates" = ${r.idpCertificates}, "trustsEmail" = ${r.trustsEmail},
          "authnRequestsSigned" = ${r.authnRequestsSigned}, "sloUrl" = ${r.sloUrl}, "sloBinding" = ${r.sloBinding},
          "metadataUrl" = ${r.metadataUrl}, "roleMapping" = ${r.roleMapping}, "updatedAt" = ${r.updatedAt}
        WHERE id = ${r.id}
        RETURNING *`,
    });
    const insertKey = SqlSchema.findOne({
      Request: KeyRow,
      Result: KeyRow,
      execute: (r) => sql`
        INSERT INTO saml_sp_key (id, "connectionId", certificate, "privateKey", fingerprint, "notBefore", "notAfter", "createdAt")
        VALUES (${r.id}, ${r.connectionId}, ${r.certificate}, ${r.privateKey}, ${r.fingerprint}, ${r.notBefore}, ${r.notAfter}, ${r.createdAt})
        RETURNING *`,
    });
    const keysOf = SqlSchema.findAll({
      Request: Schema.String,
      Result: KeyRow,
      execute: (connectionId) =>
        sql`SELECT * FROM saml_sp_key WHERE "connectionId" = ${connectionId} ORDER BY "createdAt" DESC, id DESC`,
    });
    const sessionsOf = SqlSchema.findAll({
      Request: Schema.Struct({
        connectionId: Schema.String,
        nameId: Schema.String,
        sessionIndex: Schema.NullOr(Schema.String),
      }),
      Result: SessionRow,
      execute: (r) => sql`
        SELECT * FROM saml_session WHERE "connectionId" = ${r.connectionId} AND "nameId" = ${r.nameId}
          ${r.sessionIndex === null ? sql`` : sql`AND "sessionIndex" = ${r.sessionIndex}`}`,
    });
    const sessionById = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: SessionRow,
      execute: (sessionId) => sql`SELECT * FROM saml_session WHERE "sessionId" = ${sessionId}`,
    });

    const toKey = (row: typeof KeyRow.Type): SpKeyRecord => ({
      ...row,
      privateKey: privateKeys.sealed(row.id, row.privateKey),
    });
    const toSession = (row: typeof SessionRow.Type): SamlSessionRecord => ({
      sessionId: row.sessionId,
      connectionId: row.connectionId,
      nameId: row.nameId,
      nameIdFormat: Option.fromNullOr(row.nameIdFormat),
      sessionIndex: Option.fromNullOr(row.sessionIndex),
      createdAt: row.createdAt,
    });

    const withDomains = (row: typeof ConnectionRow.Type) =>
      domainsOf(row.id).pipe(
        Effect.map((rows) =>
          toRecord(
            row,
            rows.map((entry) => entry.domain),
          ),
        ),
      );

    /** Inserts each domain; a unique-index violation names the domain that is taken. */
    const claimDomains = (connectionId: string, domains: ReadonlyArray<string>) =>
      Effect.forEach(
        domains,
        (domain) =>
          sql`INSERT INTO saml_connection_domain (domain, "connectionId") VALUES (${domain}, ${connectionId})`.pipe(
            // Postgres reports a duplicate key as a unique violation; SQLite reports a PRIMARY KEY clash as a
            // generic constraint error (the domain IS the key), so both mean "taken".
            Effect.mapError((error) =>
              error.reason._tag === "UniqueViolation" || error.reason._tag === "ConstraintError"
                ? new SamlDomainTaken({ domain })
                : error,
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
          authnRequestsSigned: input.authnRequestsSigned ?? false,
          sloUrl: input.sloUrl ?? null,
          sloBinding: input.sloBinding ?? "redirect",
          metadataUrl: input.metadataUrl ?? null,
          roleMapping: input.roleMapping ?? EMPTY_ROLE_MAPPING,
          createdAt: now,
          updatedAt: now,
        });
        // A taken domain leaves no half-created connection behind.
        yield* claimDomains(input.id, input.emailDomains).pipe(
          Effect.tapError(() =>
            sql`DELETE FROM saml_connection WHERE id = ${input.id}`.pipe(
              Effect.andThen(
                sql`DELETE FROM saml_connection_domain WHERE "connectionId" = ${input.id}`,
              ),
            ),
          ),
        );
        return toRecord(row, input.emailDomains);
      }).pipe(unavailable("create"));

    const update: SamlRecordsShape["update"] = (organizationId, id, patch) =>
      Effect.gen(function* () {
        const current = yield* connectionById(id);
        if (Option.isNone(current) || current.value.organizationId !== organizationId) {
          return yield* Effect.fail(notFound(id));
        }
        const now = yield* DateTime.now;
        if (patch.emailDomains !== undefined) {
          const before = (yield* domainsOf(id)).map((entry) => entry.domain);
          yield* sql`DELETE FROM saml_connection_domain WHERE "connectionId" = ${id}`;
          yield* claimDomains(id, patch.emailDomains).pipe(
            // Put the previous set back if a new domain is taken.
            Effect.tapError(() =>
              sql`DELETE FROM saml_connection_domain WHERE "connectionId" = ${id}`.pipe(
                Effect.andThen(
                  claimDomains(id, before).pipe(
                    // The previous set was held a moment ago: a clash now is a bug, not a domain outcome.
                    Effect.catchTag("SamlDomainTaken", Effect.die),
                  ),
                ),
              ),
            ),
          );
        }
        const merged = applyPatch(toRecord(current.value, []), patch, now);
        const row = yield* writeMutable({
          id,
          name: merged.name,
          idpEntityId: merged.idpEntityId,
          ssoUrl: merged.ssoUrl,
          idpCertificates: merged.idpCertificates,
          trustsEmail: merged.trustsEmail,
          authnRequestsSigned: merged.authnRequestsSigned,
          sloUrl: Option.getOrNull(merged.sloUrl),
          sloBinding: merged.sloBinding,
          metadataUrl: Option.getOrNull(merged.metadataUrl),
          roleMapping: merged.roleMapping,
          updatedAt: now,
        });
        if (Option.isNone(row)) return yield* Effect.fail(notFound(id));
        return yield* withDomains(row.value);
      }).pipe(unavailable("update"));

    return {
      create,
      findById: (grant, id) =>
        connectionById(id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: (row) => Effect.map(withDomains(row), Option.some),
            }),
          ),
          TenantScoped.liftOn(sql, grant),
          unavailable("findById"),
        ),
      listByOrganization: (organizationId) =>
        connectionsOf(organizationId).pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, withDomains)),
          unavailable("listByOrganization"),
        ),
      findByDomain: (grant, domain) =>
        connectionByDomain(domain).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: (row) => Effect.map(withDomains(row), Option.some),
            }),
          ),
          TenantScoped.liftOn(sql, grant),
          unavailable("findByDomain"),
        ),
      update,
      remove: (organizationId, id) =>
        Effect.gen(function* () {
          const removed =
            yield* sql`DELETE FROM saml_connection WHERE id = ${id} AND "organizationId" = ${organizationId} RETURNING id`;
          if (removed.length === 0) return yield* Effect.fail(notFound(id));
          yield* sql`DELETE FROM saml_connection_domain WHERE "connectionId" = ${id}`;
          yield* sql`DELETE FROM saml_sp_key WHERE "connectionId" = ${id}`;
          yield* sql`DELETE FROM saml_session WHERE "connectionId" = ${id}`;
        }).pipe(unavailable("remove")),
      saveSpKey: (key) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const sealed = yield* privateKeys.seal(key.id, key.privateKey);
          const saved = yield* insertKey({ ...key, privateKey: sealed, createdAt: now });
          return toKey(saved);
        }).pipe(unavailable("saveSpKey")),
      listSpKeys: (connectionId) =>
        keysOf(connectionId).pipe(
          Effect.map((rows) => rows.map(toKey)),
          unavailable("listSpKeys"),
        ),
      saveSession: (session) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          yield* sql`DELETE FROM saml_session WHERE "sessionId" = ${session.sessionId}`;
          yield* sql`
            INSERT INTO saml_session ("sessionId", "connectionId", "nameId", "nameIdFormat", "sessionIndex", "createdAt")
            VALUES (${session.sessionId}, ${session.connectionId}, ${session.nameId}, ${session.nameIdFormat ?? null},
              ${session.sessionIndex ?? null}, ${wireDate(now)})`;
        }).pipe(unavailable("saveSession")),
      findSessions: ({ connectionId, nameId, sessionIndex }) =>
        sessionsOf({ connectionId, nameId, sessionIndex: sessionIndex ?? null }).pipe(
          Effect.map((rows) => rows.map(toSession)),
          unavailable("findSessions"),
        ),
      findSession: (sessionId) =>
        sessionById(sessionId).pipe(Effect.map(Option.map(toSession)), unavailable("findSession")),
      removeSession: (sessionId) =>
        sql`DELETE FROM saml_session WHERE "sessionId" = ${sessionId}`.pipe(
          Effect.asVoid,
          unavailable("removeSession"),
        ),
      pruneSessions: (grant, before) =>
        sql`DELETE FROM saml_session WHERE "createdAt" < ${wireDate(before)} RETURNING "sessionId"`.pipe(
          Effect.map((rows) => rows.length),
          TenantScoped.liftOn(sql, grant),
          unavailable("pruneSessions"),
        ),
    } satisfies SamlRecordsShape;
  }),
);

/**
 * Plan 08 (BEH-EA-T4): the plugin's record store as two matched layers, `Saml.records`. `layerMemory` also
 * provides `MemoryEnvelopes`, a test seam that is not a store; a bundle provides record stores only, so it is
 * projected away (a suite that plants envelopes uses `layerMemory` directly).
 */
const memoryStore = Layer.effect(SamlRecords, Effect.service(SamlRecords)).pipe(
  Layer.provide(layerMemory),
);

export const records = { memory: memoryStore, sql: layerSql };
