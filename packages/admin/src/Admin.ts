// @awthaq/admin — Admin
//
// spec/behaviors/27-admin-impersonation.md, BEH-EA-209 through BEH-EA-220.
// `Auth.make([Admin])` composes: `dependsOn` is left unset on
// `AuthPlugin.layer` — `Sessions`/`Users`/`AuthEvents` are core domain
// services this plugin's own `make` Effect simply `yield*`s directly, the
// same established convention `@awthaq/passkey`'s own ticket 06
// corrected `Passkey.ts` to (see that file's own header comment).
//
// The admin gate (configuration in force, predicates, denial events, target lookup) is the one
// internal module `./internal/AdminGate.ts`; this plugin never reads `AdminConfig` itself.

import { AccountContract, Api, SessionContract } from "@awthaq/api";
import {
  AuditChain,
  AuthEvents,
  AuthPlugin,
  ConfigDescriptor,
  Defects,
  EffectiveConfig,
  Errors,
  Migrations,
  SessionCookie,
  Sessions,
  Users,
} from "@awthaq/core";
import { Session } from "@awthaq/server";
import { TenantScoped } from "@awthaq/sql";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as AdminApi from "./AdminApi.ts";
import * as ImpersonationRecords from "./ImpersonationRecords.ts";
import * as AdminGate from "./internal/AdminGate.ts";

export {
  config,
  type AdminConfigShape,
  type EpisodeGateInput,
  type ImpersonationGateInput,
  type TenantAdminGateInput,
  type UserAdminGateInput,
} from "./internal/AdminGate.ts";

export interface IssuedSession {
  readonly session: Sessions.SessionView;
  readonly token: Redacted.Redacted<string>;
}

export interface AdminShape {
  /**
   * BEH-EA-213/214/218: validates self/nested-impersonation first (neither
   * ever reaches the gate or publishes `impersonationDenied`), then the
   * configured gate over `{ admin, target }` (IDS-001), then the target's
   * existence (IDS-003, after the gate so a non-admin cannot use 404-vs-403
   * as a user-id oracle), then issues a dual-identity session for
   * `targetUserId` and records a durable audit row — `caller`'s own session
   * is never touched.
   */
  readonly impersonate: (input: {
    readonly caller: Api.UserPrincipal;
    readonly targetUserId: Users.UserId;
    readonly reason: string;
  }) => Effect.Effect<
    IssuedSession,
    | AdminApi.AdminImpersonationDenied
    | AdminApi.AdminSelfImpersonationRefused
    | AdminApi.AdminAlreadyImpersonating
    | AdminApi.AdminTargetNotFound
    | Errors.StoreUnavailable
  >;
  /** BEH-EA-216: `caller`'s own session must itself carry `actingAs`, or there is nothing to stop. */
  readonly stopImpersonating: (
    caller: Api.UserPrincipal,
  ) => Effect.Effect<void, AdminApi.AdminImpersonationNotFound | Errors.StoreUnavailable>;
  /** BEH-EA-217: gated per episode by `canManageEpisode` (IDS-001); `sessionId` names the episode to end, not `caller`'s own. */
  readonly forceStop: (
    caller: Api.UserPrincipal,
    sessionId: string,
  ) => Effect.Effect<
    void,
    | AdminApi.AdminImpersonationDenied
    | AdminApi.AdminImpersonationNotFound
    | Errors.StoreUnavailable
  >;
  /** BEH-EA-219: rows are filtered through `canManageEpisode` (IDS-001); full history by default, `active` narrows to unended episodes. */
  readonly list: (
    caller: Api.UserPrincipal,
    input?: {
      readonly active?: boolean | undefined;
      readonly cursor?: ImpersonationRecords.ImpersonationCursor | undefined;
      readonly limit?: number | undefined;
    },
  ) => Effect.Effect<ImpersonationRecords.ImpersonationPage, Errors.StoreUnavailable>;
  /**
   * IDS-004: closes every episode whose session hard-expired, as
   * `endedBy: "expired"`, publishing one `impersonationStopped` per closed
   * episode; resolves to how many it closed. `list`/`forceStop` already run
   * this lazily, so a host only schedules it (`Effect.repeat`/`Schedule`) when
   * it wants the audit trail closed without anyone reading it.
   */
  readonly sweepExpired: Effect.Effect<number, Errors.StoreUnavailable>;
  /**
   * BAM-005: user and session administration, every call behind `canManageUsers` and
   * then (per-user calls) an existence check — see `AdminConfigShape.canManageUsers`.
   * Errors: `AdminActionDenied` (gate), `AdminTargetNotFound` (no such user),
   * `AdminSessionNotFound` (`revokeUserSession`: not one of that user's revocable
   * sessions — unknown, another user's, or an impersonation session, which `forceStop` owns).
   */
  /**
   * EP-009/BEH-EA-229: the effective configuration this application was *built* with — every
   * descriptor in `EffectiveConfig.Catalog` (the application provides
   * `EffectiveConfig.layer(auth.manifest)`; unprovided, core's own) read against the
   * `Context` this plugin's layer was built in, so an override provided to the composed layer
   * shows up as `override`. Sensitive values are `<redacted>`, never unwrapped. Same gate as
   * `listUsers` (collection-level `canManageUsers`).
   */
  readonly effectiveConfig: (
    caller: Api.UserPrincipal,
  ) => Effect.Effect<ReadonlyArray<EffectiveConfig.Item>, AdminApi.AdminActionDenied>;
  readonly listUsers: (
    caller: Api.UserPrincipal,
    input?: {
      readonly cursor?: Users.UserCursor | undefined;
      readonly limit?: number | undefined;
    },
  ) => Effect.Effect<Users.UsersPage, AdminApi.AdminActionDenied | Errors.StoreUnavailable>;
  readonly getUser: (
    caller: Api.UserPrincipal,
    userId: Users.UserId,
  ) => Effect.Effect<
    Users.UserRecord,
    AdminApi.AdminActionDenied | AdminApi.AdminTargetNotFound | Errors.StoreUnavailable
  >;
  /** `metadata` left out leaves it untouched; `null` clears it (`Users.updateProfile`'s own rule). */
  readonly updateUser: (
    caller: Api.UserPrincipal,
    userId: Users.UserId,
    input: { readonly name: string; readonly metadata?: string | null | undefined },
  ) => Effect.Effect<
    Users.UserRecord,
    AdminApi.AdminActionDenied | AdminApi.AdminTargetNotFound | Errors.StoreUnavailable
  >;
  /**
   * BAM-005/SCP-001: `Users.setStatus("suspended")` composed with `Sessions.revokeAll(userId,
   * "suspended")` — every session, impersonation sessions issued *as* the user included, since
   * the account's access ends as a whole. Behind `canBanUsers`; an admin cannot ban themselves.
   * The block itself is `Users.assertCanSignIn`, the one gate password/passkey/oauth share.
   */
  readonly banUser: (
    caller: Api.UserPrincipal,
    userId: Users.UserId,
    input: {
      readonly reason?: string | undefined;
      readonly until?: DateTime.Utc | undefined;
    },
  ) => Effect.Effect<
    Users.UserRecord,
    | AdminApi.AdminActionDenied
    | AdminApi.AdminTargetNotFound
    | AdminApi.AdminSelfBanRefused
    | Errors.StoreUnavailable
  >;
  /** BAM-005: `Users.setStatus("active")`; accounts and session history are untouched (nothing was deleted), so the user simply signs in again. */
  readonly unbanUser: (
    caller: Api.UserPrincipal,
    userId: Users.UserId,
  ) => Effect.Effect<
    Users.UserRecord,
    AdminApi.AdminActionDenied | AdminApi.AdminTargetNotFound | Errors.StoreUnavailable
  >;
  /** The user's own sessions — impersonation sessions issued *as* that user are not among them. */
  readonly listUserSessions: (
    caller: Api.UserPrincipal,
    userId: Users.UserId,
  ) => Effect.Effect<
    ReadonlyArray<Sessions.SessionListItem>,
    AdminApi.AdminActionDenied | AdminApi.AdminTargetNotFound | Errors.StoreUnavailable
  >;
  readonly revokeUserSession: (
    caller: Api.UserPrincipal,
    userId: Users.UserId,
    sessionId: string,
  ) => Effect.Effect<
    void,
    | AdminApi.AdminActionDenied
    | AdminApi.AdminTargetNotFound
    | AdminApi.AdminSessionNotFound
    | Errors.StoreUnavailable
  >;
  /** Revokes every one of the user's own sessions; impersonation sessions stay (end them with `forceStop`). */
  readonly revokeUserSessions: (
    caller: Api.UserPrincipal,
    userId: Users.UserId,
  ) => Effect.Effect<
    void,
    AdminApi.AdminActionDenied | AdminApi.AdminTargetNotFound | Errors.StoreUnavailable
  >;
}

// RSC-005: the mapping is `@awthaq/server`'s `Session.toSessionDto`; the typed
// wrapper also keeps `SessionContract` in scope so declaration emit can name
// `SessionDto` in the handler group's inferred type (TS2883 otherwise).
const sessionResponse = (view: Sessions.SessionView): SessionContract.SessionDto =>
  Session.toSessionDto(view);

const toSessionListDto = (session: Sessions.SessionListItem): SessionContract.SessionDto =>
  new SessionContract.SessionDto({
    id: session.id,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    expiresAt: session.expiresAt,
    userAgent: Option.getOrNull(session.userAgent),
    // The admin is never "the current session" of the user they are looking at.
    current: false,
  });

/** FAMS-002: exhaustive over `Users.UserIdentity` (`@awthaq/server`'s `Account.ts` has the same mapping for the self-service DTO). */
const identityDto = (identity: Users.UserIdentity): AccountContract.IdentityDto => {
  switch (identity._tag) {
    case "Email":
      return { _tag: "Email", email: identity.email, emailVerified: identity.emailVerified };
    case "Phone":
      return { _tag: "Phone", phone: identity.phone, phoneVerified: identity.phoneVerified };
    case "Anonymous":
      return { _tag: "Anonymous" };
  }
};

const toUserDto = (user: Users.UserRecord): AdminApi.UserDto =>
  new AdminApi.UserDto({
    id: user.id,
    identity: identityDto(user.identity),
    name: user.name,
    image: Option.getOrNull(user.image),
    metadata: Option.getOrNull(user.metadata),
    tenantId: Option.getOrNull(user.tenantId),
    status: user.status,
    statusReason: Option.getOrNull(user.statusReason),
    suspendedUntil: Option.match(user.suspendedUntil, {
      onNone: () => null,
      onSome: DateTime.formatIso,
    }),
    createdAt: DateTime.formatIso(user.createdAt),
    updatedAt: DateTime.formatIso(user.updatedAt),
  });

const toRecordDto = (
  record: ImpersonationRecords.ImpersonationRecord,
): AdminApi.ImpersonationRecordDto =>
  new AdminApi.ImpersonationRecordDto({
    id: record.id,
    adminUserId: record.adminUserId,
    targetUserId: record.targetUserId,
    sessionId: record.sessionId,
    reason: record.reason,
    startedAt: DateTime.formatIso(record.startedAt),
    expiresAt: Option.match(record.expiresAt, { onNone: () => null, onSome: DateTime.formatIso }),
    endedAt: Option.match(record.endedAt, { onNone: () => null, onSome: DateTime.formatIso }),
    endedBy: Option.getOrNull(record.endedBy),
    tenantId: Option.getOrNull(record.tenantId),
  });

/** Same forward-reference pattern `@awthaq/passkey`'s own `Passkey.ts` documents. */
const currentUserPrincipal = Effect.gen(function* () {
  const principal = yield* Api.CurrentPrincipal;
  if (principal._tag !== "User") {
    return yield* Defects.invariantViolation(
      "NonUserPrincipal",
      `awthaq: admin group reached with a non-User principal: ${principal._tag}`,
    );
  }
  return principal;
});

/** APS-006: expires the impersonation cookie so the browser reverts to the admin's own session cookie. */
const clearImpersonationCookie = SessionCookie.expireImpersonation;

export const AdminHandlers = HttpApiBuilder.group(
  AdminApi.AdminApi,
  "admin",
  Effect.fnUntraced(function* (handlers) {
    const admin = yield* Admin;
    return handlers.handleAll({
      impersonate: Effect.fnUntraced(function* ({
        params,
        payload,
      }: {
        params: AdminApi.UserIdParams;
        payload: AdminApi.ImpersonatePayload;
      }) {
        const caller = yield* currentUserPrincipal;
        const issued = yield* admin.impersonate({
          caller,
          targetUserId: Users.UserId(params.userId),
          reason: payload.reason,
        });
        // APS-006: a cookie of its own — the admin's `__Host-session` stays
        // untouched and `Authentication` prefers this one while it lives.
        yield* SessionCookie.set(issued.session, issued.token, "impersonation");
        return sessionResponse(issued.session);
      }),
      stopImpersonating: Effect.fnUntraced(function* () {
        const caller = yield* currentUserPrincipal;
        yield* admin.stopImpersonating(caller);
        yield* clearImpersonationCookie;
      }),
      forceStop: Effect.fnUntraced(function* ({ params }: { params: AdminApi.SessionIdParams }) {
        const caller = yield* currentUserPrincipal;
        yield* admin.forceStop(caller, params.sessionId);
        // APS-006: ending one's own current episode must hand the browser back.
        if (params.sessionId === caller.sessionId) yield* clearImpersonationCookie;
      }),
      effectiveConfig: Effect.fnUntraced(function* () {
        const caller = yield* currentUserPrincipal;
        const items = yield* admin.effectiveConfig(caller);
        return items.map(
          (item) =>
            new AdminApi.ConfigItemDto({
              owner: item.owner,
              key: item.key,
              source: item.source,
              entries: item.entries.map((entry) => new AdminApi.ConfigEntryDto(entry)),
            }),
        );
      }),
      listUsers: Effect.fnUntraced(function* ({ query }: { query: AdminApi.ListUsersQuery }) {
        const caller = yield* currentUserPrincipal;
        const page = yield* admin.listUsers(caller, { cursor: query.cursor, limit: query.limit });
        return new AdminApi.UserPageDto({
          items: page.items.map(toUserDto),
          nextCursor: Option.getOrNull(page.nextCursor),
        });
      }),
      getUser: Effect.fnUntraced(function* ({ params }: { params: AdminApi.UserIdParams }) {
        const caller = yield* currentUserPrincipal;
        return toUserDto(yield* admin.getUser(caller, Users.UserId(params.userId)));
      }),
      updateUser: Effect.fnUntraced(function* ({
        params,
        payload,
      }: {
        params: AdminApi.UserIdParams;
        payload: AdminApi.UpdateUserPayload;
      }) {
        const caller = yield* currentUserPrincipal;
        const updated = yield* admin.updateUser(caller, Users.UserId(params.userId), payload);
        return toUserDto(updated);
      }),
      banUser: Effect.fnUntraced(function* ({
        params,
        payload,
      }: {
        params: AdminApi.UserIdParams;
        payload: AdminApi.BanUserPayload;
      }) {
        const caller = yield* currentUserPrincipal;
        return toUserDto(
          yield* admin.banUser(caller, Users.UserId(params.userId), {
            reason: payload.reason,
            until: payload.until,
          }),
        );
      }),
      unbanUser: Effect.fnUntraced(function* ({ params }: { params: AdminApi.UserIdParams }) {
        const caller = yield* currentUserPrincipal;
        return toUserDto(yield* admin.unbanUser(caller, Users.UserId(params.userId)));
      }),
      listUserSessions: Effect.fnUntraced(function* ({
        params,
      }: {
        params: AdminApi.UserIdParams;
      }) {
        const caller = yield* currentUserPrincipal;
        const listed = yield* admin.listUserSessions(caller, Users.UserId(params.userId));
        return listed.map(toSessionListDto);
      }),
      revokeUserSession: Effect.fnUntraced(function* ({
        params,
      }: {
        params: AdminApi.UserSessionParams;
      }) {
        const caller = yield* currentUserPrincipal;
        yield* admin.revokeUserSession(caller, Users.UserId(params.userId), params.sessionId);
      }),
      revokeUserSessions: Effect.fnUntraced(function* ({
        params,
      }: {
        params: AdminApi.UserIdParams;
      }) {
        const caller = yield* currentUserPrincipal;
        yield* admin.revokeUserSessions(caller, Users.UserId(params.userId));
      }),
      list: Effect.fnUntraced(function* ({ query }: { query: AdminApi.ListQuery }) {
        const caller = yield* currentUserPrincipal;
        const page = yield* admin.list(caller, {
          active: query.active === "true",
          cursor: query.cursor,
          limit: query.limit,
        });
        return new AdminApi.ImpersonationPageDto({
          items: page.items.map(toRecordDto),
          nextCursor: Option.getOrNull(page.nextCursor),
        });
      }),
    });
  }),
);

/**
 * BAM-002 (.issues/high): no plugin populated `migrations` before AOMS-006's
 * cluster resolution added `@awthaq/jwt`'s own — this is the same pattern
 * (`ImpersonationRecords.test.ts`'s own inline `CREATE TABLE` is this
 * table's canonical, already-working shape; ported verbatim, dialect-
 * branched via `sql.onDialectOrElse` like `@awthaq/sql`'s own
 * `CoreMigrations.ts`). `sessionId` is `ImpersonationRecords.ts`'s own real
 * filter key (`findBySessionId`/`endBySessionId`), unindexed until now —
 * the same class of gap `CoreMigrations.ts`'s own `accounts_user_id`/
 * `sessions_user_id` migrations closed. Columns left unquoted under `pg`
 * (unlike `CoreMigrations.ts`'s own `users`/`sessions` tables, like
 * `@awthaq/jwt`'s own `jwtMigrations`): `ImpersonationRecords.ts`'s own
 * queries already reference every column unquoted, so Postgres's automatic
 * lowercase-folding is what keeps migration and query consistent here.
 */
const adminMigrations: Migrations.Migrations = [
  {
    name: "create_admin_impersonation",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE admin_impersonation (
            id TEXT PRIMARY KEY,
            "adminUserId" TEXT NOT NULL,
            "targetUserId" TEXT NOT NULL,
            "sessionId" TEXT NOT NULL,
            reason TEXT NOT NULL,
            "startedAt" TIMESTAMPTZ NOT NULL,
            "endedAt" TIMESTAMPTZ,
            "endedBy" TEXT
          )`,
        sqlite: () => sql`
          CREATE TABLE admin_impersonation (
            id TEXT PRIMARY KEY,
            "adminUserId" TEXT NOT NULL,
            "targetUserId" TEXT NOT NULL,
            "sessionId" TEXT NOT NULL,
            reason TEXT NOT NULL,
            "startedAt" TEXT NOT NULL,
            "endedAt" TEXT,
            "endedBy" TEXT
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  {
    name: "create_admin_impersonation_session_id_index",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () =>
          sql`CREATE INDEX admin_impersonation_session_id ON admin_impersonation("sessionId")`,
        sqlite: () =>
          sql`CREATE INDEX admin_impersonation_session_id ON admin_impersonation("sessionId")`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  {
    // IDS-004: each episode records its session's hard expiry so an expired episode can
    // be closed as `endedBy = 'expired'`. Nullable: rows written before this migration
    // have no recorded expiry and are simply never auto-closed (pre-release; no backfill).
    name: "add_admin_impersonation_expires_at",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`ALTER TABLE admin_impersonation ADD COLUMN "expiresAt" TIMESTAMPTZ`,
        sqlite: () => sql`ALTER TABLE admin_impersonation ADD COLUMN "expiresAt" TEXT`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  {
    // ESS-006: the keyset the history is paged on — `(startedAt, id)` newest-first.
    name: "create_admin_impersonation_started_at_index",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () =>
          sql`CREATE INDEX admin_impersonation_started_at ON admin_impersonation("startedAt", id)`,
        sqlite: () =>
          sql`CREATE INDEX admin_impersonation_started_at ON admin_impersonation("startedAt", id)`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  {
    // ALF-005: the append-only, hash-chained ledger `ImpersonationRecords` writes every
    // episode start/end to (see that module's header). `payload` is the canonical string
    // that was hashed, so `verifyChain` can recompute `rowHash` from what is stored.
    name: "create_admin_impersonation_chain",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE admin_impersonation_chain (
            seq SERIAL PRIMARY KEY,
            kind TEXT NOT NULL,
            "episodeId" TEXT NOT NULL,
            "prevHash" TEXT NOT NULL,
            payload TEXT NOT NULL,
            "rowHash" TEXT NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE admin_impersonation_chain (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            "episodeId" TEXT NOT NULL,
            "prevHash" TEXT NOT NULL,
            payload TEXT NOT NULL,
            "rowHash" TEXT NOT NULL
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  {
    // ALF-005: database-level immutability. `admin_impersonation` rejects DELETE and any
    // UPDATE other than *closing an open episode* (`endedAt`/`endedBy` while `endedAt` is
    // still NULL); the ledger rejects every UPDATE and DELETE. A DBA can still drop these
    // triggers — which is what the hash chain (`ImpersonationRecords.verifyChain`) exists
    // to make detectable. Postgres also blocks TRUNCATE. The Postgres branch is exercised
    // by no test in this repo (SQLite only) — review it against a real Postgres.
    name: "add_admin_impersonation_immutability_triggers",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () =>
          Effect.gen(function* () {
            yield* sql`
              CREATE FUNCTION admin_impersonation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
              BEGIN
                IF TG_TABLE_NAME = 'admin_impersonation' AND TG_OP = 'UPDATE' THEN
                  IF NEW.id IS DISTINCT FROM OLD.id
                    OR NEW."adminUserId" IS DISTINCT FROM OLD."adminUserId"
                    OR NEW."targetUserId" IS DISTINCT FROM OLD."targetUserId"
                    OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
                    OR NEW.reason IS DISTINCT FROM OLD.reason
                    OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
                    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
                    OR OLD."endedAt" IS NOT NULL THEN
                    RAISE EXCEPTION 'awthaq: % is append-only: this UPDATE is rejected', TG_TABLE_NAME;
                  END IF;
                  RETURN NEW;
                END IF;
                RAISE EXCEPTION 'awthaq: % is append-only: % is rejected', TG_TABLE_NAME, TG_OP;
              END
              $$`;
            yield* sql`
              CREATE TRIGGER admin_impersonation_guard BEFORE UPDATE OR DELETE ON admin_impersonation
              FOR EACH ROW EXECUTE FUNCTION admin_impersonation_guard()`;
            yield* sql`
              CREATE TRIGGER admin_impersonation_no_truncate BEFORE TRUNCATE ON admin_impersonation
              FOR EACH STATEMENT EXECUTE FUNCTION admin_impersonation_guard()`;
            yield* sql`
              CREATE TRIGGER admin_impersonation_chain_guard BEFORE UPDATE OR DELETE ON admin_impersonation_chain
              FOR EACH ROW EXECUTE FUNCTION admin_impersonation_guard()`;
            yield* sql`
              CREATE TRIGGER admin_impersonation_chain_no_truncate BEFORE TRUNCATE ON admin_impersonation_chain
              FOR EACH STATEMENT EXECUTE FUNCTION admin_impersonation_guard()`;
          }),
        sqlite: () =>
          Effect.gen(function* () {
            yield* sql`
              CREATE TRIGGER admin_impersonation_no_delete BEFORE DELETE ON admin_impersonation
              BEGIN SELECT RAISE(ABORT, 'awthaq: admin_impersonation is append-only: DELETE is rejected'); END`;
            yield* sql`
              CREATE TRIGGER admin_impersonation_immutable BEFORE UPDATE ON admin_impersonation
              WHEN NEW.id IS NOT OLD.id
                OR NEW."adminUserId" IS NOT OLD."adminUserId"
                OR NEW."targetUserId" IS NOT OLD."targetUserId"
                OR NEW."sessionId" IS NOT OLD."sessionId"
                OR NEW.reason IS NOT OLD.reason
                OR NEW."startedAt" IS NOT OLD."startedAt"
                OR NEW."expiresAt" IS NOT OLD."expiresAt"
                OR OLD."endedAt" IS NOT NULL
              BEGIN SELECT RAISE(ABORT, 'awthaq: admin_impersonation is append-only: this UPDATE is rejected'); END`;
            yield* sql`
              CREATE TRIGGER admin_impersonation_chain_no_update BEFORE UPDATE ON admin_impersonation_chain
              BEGIN SELECT RAISE(ABORT, 'awthaq: admin_impersonation_chain is append-only: UPDATE is rejected'); END`;
            yield* sql`
              CREATE TRIGGER admin_impersonation_chain_no_delete BEFORE DELETE ON admin_impersonation_chain
              BEGIN SELECT RAISE(ABORT, 'awthaq: admin_impersonation_chain is append-only: DELETE is rejected'); END`;
          }),
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
];

/**
 * IDS-002 (ADR-EA-018): the tenant column, appended as its own migration so an existing
 * deployment upgrades in place. The immutability triggers list the frozen columns
 * explicitly, so they are recreated with `tenantId` added — otherwise the new column
 * would be the one an UPDATE could rewrite. Nullable, unbackfilled: `NULL` is "no
 * tenant", which every episode written before tenancy — and every single-tenant one —
 * carries.
 */
const addTenantIdMigration: Migrations.Migrations[number] = {
  name: "add_admin_impersonation_tenant_id",
  up: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE admin_impersonation ADD COLUMN "tenantId" TEXT`;
    yield* sql`CREATE INDEX admin_impersonation_tenant_started_at ON admin_impersonation("tenantId", "startedAt", id)`;
    yield* sql.onDialectOrElse({
      pg: () =>
        Effect.gen(function* () {
          yield* sql`
            CREATE OR REPLACE FUNCTION admin_impersonation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              IF TG_TABLE_NAME = 'admin_impersonation' AND TG_OP = 'UPDATE' THEN
                IF NEW.id IS DISTINCT FROM OLD.id
                  OR NEW."adminUserId" IS DISTINCT FROM OLD."adminUserId"
                  OR NEW."targetUserId" IS DISTINCT FROM OLD."targetUserId"
                  OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
                  OR NEW.reason IS DISTINCT FROM OLD.reason
                  OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
                  OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
                  OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
                  OR OLD."endedAt" IS NOT NULL THEN
                  RAISE EXCEPTION 'awthaq: % is append-only: this UPDATE is rejected', TG_TABLE_NAME;
                END IF;
                RETURN NEW;
              END IF;
              RAISE EXCEPTION 'awthaq: % is append-only: % is rejected', TG_TABLE_NAME, TG_OP;
            END
            $$`;
        }),
      sqlite: () =>
        Effect.gen(function* () {
          yield* sql`DROP TRIGGER admin_impersonation_immutable`;
          yield* sql`
            CREATE TRIGGER admin_impersonation_immutable BEFORE UPDATE ON admin_impersonation
            WHEN NEW.id IS NOT OLD.id
              OR NEW."adminUserId" IS NOT OLD."adminUserId"
              OR NEW."targetUserId" IS NOT OLD."targetUserId"
              OR NEW."sessionId" IS NOT OLD."sessionId"
              OR NEW.reason IS NOT OLD.reason
              OR NEW."startedAt" IS NOT OLD."startedAt"
              OR NEW."expiresAt" IS NOT OLD."expiresAt"
              OR NEW."tenantId" IS NOT OLD."tenantId"
              OR OLD."endedAt" IS NOT NULL
            BEGIN SELECT RAISE(ABORT, 'awthaq: admin_impersonation is append-only: this UPDATE is rejected'); END`;
        }),
      orElse: () => Defects.unsupportedDialect("migrations"),
    });
  }),
};

export class Admin extends AuthPlugin.Service<Admin, AdminShape>()("admin", {
  apiVersion: 1,
  contract: AdminApi.AdminApi,
  tables: {
    admin_impersonation: AuthPlugin.Table.partitioned("tenantId"),
    admin_impersonation_chain: AuthPlugin.Table.global(
      "append-only hash chain over every tenant's episodes; verifyChain reads it whole",
    ),
  },
  migrations: [...adminMigrations, addTenantIdMigration],
  // Plan 08 (BEH-EA-T4): the impersonation store, memory and SQL, matched.
  records: {
    memory: ImpersonationRecords.layerMemory,
    sql: ImpersonationRecords.layerSql,
  },
  // The impersonation audit rows are hash-chained (`AuditChain`); the chain's key is this plugin's concern.
  config: [
    AdminGate.descriptor,
    ConfigDescriptor.make(AuditChain.AuditChainConfig, {
      audit: (value, environment) =>
        environment.production && Option.isNone(value.key)
          ? [
              ConfigDescriptor.finding(
                "warning",
                "audit-chain-unkeyed",
                "the impersonation audit hash chain has no key: an attacker with database write access can recompute it",
              ),
            ]
          : [],
    }),
  ],
}) {
  static readonly layer = AuthPlugin.layer(Admin, {
    handlers: AdminHandlers,
    make: Effect.gen(function* () {
      const sessions = yield* Sessions.Sessions;
      const events = yield* AuthEvents.AuthEvents;
      const records = yield* ImpersonationRecords.ImpersonationRecords;
      const users = yield* Users.Users;
      // ADR-EA-018 Decision 8 (plan 13): every gate and the impersonation ceiling are read per
      // operation by the one admin gate, so a tenant's `Admin.config(...)` governs its own requests.
      const gate = yield* AdminGate.make;
      // EP-009: captured at build, like every other configuration read — a request-time read would
      // see only the router's own context, not the overrides the composed layer was built under.
      const builtIn = yield* Effect.context<never>();
      const catalog = Context.getOrElse(
        builtIn,
        EffectiveConfig.Catalog,
        () => EffectiveConfig.core,
      );

      /** Sessions an impersonation episode owns are never touched by user-session administration (`forceStop` ends them). */
      // IDS-002: classification, not authorization — a session that any tenant's episode owns must
      // never be revoked as an ordinary user session, so the lookup is deliberately tenant-blind.
      const isImpersonationSession = (sessionId: string) =>
        records
          .findBySessionId(
            sessionId,
            TenantScoped.crossTenant("admin: classify any session as impersonation"),
          )
          .pipe(Effect.map(Option.isSome));

      const ownSessions = Effect.fnUntraced(function* (userId: Users.UserId) {
        const listed = yield* sessions.list(userId);
        return yield* Effect.filter(listed, (session) =>
          Effect.map(isImpersonationSession(session.id), (impersonation) => !impersonation),
        );
      });

      const effectiveConfig: AdminShape["effectiveConfig"] = Effect.fnUntraced(function* (caller) {
        yield* gate.collection(caller, "effectiveConfig");
        return EffectiveConfig.read(builtIn, catalog);
      });

      const listUsers: AdminShape["listUsers"] = Effect.fnUntraced(function* (caller, input) {
        yield* gate.collection(caller, "listUsers");
        return yield* users.list(input);
      });

      const getUser: AdminShape["getUser"] = (caller, userId) =>
        Effect.flatMap(gate.user(caller, "getUser", userId), (cleared) => cleared.target);

      const updateUser: AdminShape["updateUser"] = Effect.fnUntraced(
        function* (caller, userId, input) {
          yield* Effect.flatMap(
            gate.user(caller, "updateUser", userId),
            (cleared) => cleared.target,
          );
          const updated = yield* users
            .updateProfile(userId, {
              name: input.name,
              ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
            })
            .pipe(
              Effect.catchTag("UserNotFound", () =>
                Effect.fail(new AdminApi.AdminTargetNotFound()),
              ),
            );
          yield* events.publish({
            _tag: "auth.admin.userUpdated",
            adminUserId: Users.UserId(caller.ref.id),
            userId,
          });
          return updated;
        },
      );

      const banUser: AdminShape["banUser"] = Effect.fnUntraced(function* (caller, userId, input) {
        // Gate first (the caller learns nothing about ids or about the refusal rule), then the
        // lock-out guard, then existence.
        const cleared = yield* gate.user(caller, "banUser", userId);
        if (caller.ref.id === userId) return yield* Effect.fail(new AdminApi.AdminSelfBanRefused());
        yield* cleared.target;
        const suspended = yield* users
          .setStatus(userId, "suspended", { reason: input.reason?.trim(), until: input.until })
          .pipe(
            Effect.catchTag("UserNotFound", () => Effect.fail(new AdminApi.AdminTargetNotFound())),
          );
        // Ordering: the flag first, so no sign-in can slip in between the revoke and the write
        // (a session issued in that gap would be refused-then-revoked anyway; the reverse order
        // could leave a fresh session behind).
        yield* sessions.revokeAll(userId, "suspended");
        yield* events.publish({
          _tag: "auth.admin.userBanned",
          adminUserId: Users.UserId(caller.ref.id),
          userId,
          reason: input.reason?.trim() ?? null,
          until: input.until === undefined ? null : DateTime.formatIso(input.until),
        });
        return suspended;
      });

      const unbanUser: AdminShape["unbanUser"] = Effect.fnUntraced(function* (caller, userId) {
        yield* Effect.flatMap(gate.user(caller, "unbanUser", userId), (cleared) => cleared.target);
        const reactivated = yield* users
          .setStatus(userId, "active")
          .pipe(
            Effect.catchTag("UserNotFound", () => Effect.fail(new AdminApi.AdminTargetNotFound())),
          );
        yield* events.publish({
          _tag: "auth.admin.userUnbanned",
          adminUserId: Users.UserId(caller.ref.id),
          userId,
        });
        return reactivated;
      });

      const listUserSessions: AdminShape["listUserSessions"] = Effect.fnUntraced(
        function* (caller, userId) {
          yield* Effect.flatMap(
            gate.user(caller, "listUserSessions", userId),
            (cleared) => cleared.target,
          );
          return yield* ownSessions(userId);
        },
      );

      const revokeUserSession: AdminShape["revokeUserSession"] = Effect.fnUntraced(
        function* (caller, userId, sessionId) {
          yield* Effect.flatMap(
            gate.user(caller, "revokeUserSession", userId),
            (cleared) => cleared.target,
          );
          // Must be one of *this user's own* revocable sessions — the same not-found for an
          // unknown id, another user's, or an impersonation session (no ownership oracle).
          const own = yield* ownSessions(userId);
          if (!own.some((session) => session.id === sessionId)) {
            return yield* Effect.fail(new AdminApi.AdminSessionNotFound());
          }
          yield* sessions
            .revoke(Sessions.SessionId(sessionId), "admin")
            // Gone between the check and the revoke: the desired end state, not an error.
            .pipe(Effect.catchTag("Sessions/NotFound", () => Effect.void));
          yield* events.publish({
            _tag: "auth.admin.sessionRevoked",
            adminUserId: Users.UserId(caller.ref.id),
            userId,
            sessionId: Sessions.SessionId(sessionId),
          });
        },
      );

      const revokeUserSessions: AdminShape["revokeUserSessions"] = Effect.fnUntraced(
        function* (caller, userId) {
          yield* Effect.flatMap(
            gate.user(caller, "revokeUserSessions", userId),
            (cleared) => cleared.target,
          );
          const own = yield* ownSessions(userId);
          yield* Effect.forEach(
            own,
            (session) =>
              sessions
                .revoke(session.id, "admin")
                .pipe(Effect.catchTag("Sessions/NotFound", () => Effect.void)),
            { discard: true },
          );
          yield* events.publish({
            _tag: "auth.admin.sessionRevoked",
            adminUserId: Users.UserId(caller.ref.id),
            userId,
            sessionId: null,
          });
        },
      );

      const impersonate: AdminShape["impersonate"] = Effect.fnUntraced(function* ({
        caller,
        targetUserId,
        reason,
      }) {
        // BEH-EA-214/218: validation refusals never reach the gate and never
        // publish `impersonationDenied`.
        if (caller.ref.id === targetUserId) {
          return yield* Effect.fail(new AdminApi.AdminSelfImpersonationRefused());
        }
        if (caller.actingAs !== undefined) {
          return yield* Effect.fail(new AdminApi.AdminAlreadyImpersonating());
        }

        const cleared = yield* gate.impersonation(caller, targetUserId);
        // IDS-003: only a gate-passing caller learns whether the target exists.
        yield* cleared.target;

        const issued = yield* sessions.issue({
          userId: targetUserId,
          actingAs: { type: caller.ref.type, id: caller.ref.id },
          absoluteDuration: cleared.config.maxDuration,
        });
        const trimmedReason = reason.trim();
        yield* records.create({
          adminUserId: Users.UserId(caller.ref.id),
          targetUserId,
          sessionId: issued.session.id,
          reason: trimmedReason,
          expiresAt: issued.session.absoluteExpiresAt,
        });
        yield* events.publish({
          _tag: "auth.admin.impersonationStarted",
          adminUserId: Users.UserId(caller.ref.id),
          targetUserId,
          reason: trimmedReason,
          sessionId: issued.session.id,
        });
        return issued;
      });

      /**
       * IDS-004: closes every episode whose session hard-expired and announces each
       * once — `closeExpired` returns only the rows *this* call closed, so concurrent
       * readers never double-publish.
       */
      const sweepExpired: AdminShape["sweepExpired"] = Effect.gen(function* () {
        const closed = yield* records.closeExpired(
          TenantScoped.crossTenant("admin: expired episodes close in every tenant"),
          yield* DateTime.now,
        );
        yield* Effect.forEach(
          closed,
          (episode) =>
            events.publish({
              _tag: "auth.admin.impersonationStopped",
              sessionId: Sessions.SessionId(episode.sessionId),
              adminUserId: episode.adminUserId,
              targetUserId: episode.targetUserId,
              endedBy: "expired",
            }),
          { discard: true },
        );
        return closed.length;
      });

      /** IDS-007: idempotent — a session already gone (revokeAll, expiry sweep) is the desired end state. */
      const revokeQuietly = (sessionId: string) =>
        sessions
          .revoke(Sessions.SessionId(sessionId), "impersonationStopped")
          .pipe(Effect.catchTag("Sessions/NotFound", () => Effect.void));

      const stopImpersonating: AdminShape["stopImpersonating"] = Effect.fnUntraced(
        function* (caller) {
          if (caller.actingAs === undefined) {
            return yield* Effect.fail(new AdminApi.AdminImpersonationNotFound());
          }
          // IDS-007: `actingAs` on the caller's own session is proof enough, so revocation
          // is the primary act and never depends on the audit row's state.
          yield* revokeQuietly(caller.sessionId);
          const closed = yield* records.endEpisode(caller.sessionId, "self").pipe(Effect.option);
          if (Option.isNone(closed)) {
            yield* Effect.logWarning(
              `awthaq: stopImpersonating revoked session ${caller.sessionId} but found no open audit episode for it`,
            );
            return;
          }
          yield* events.publish({
            _tag: "auth.admin.impersonationStopped",
            sessionId: Sessions.SessionId(caller.sessionId),
            adminUserId: closed.value.adminUserId,
            targetUserId: closed.value.targetUserId,
            endedBy: "self",
          });
        },
      );

      const forceStop: AdminShape["forceStop"] = Effect.fnUntraced(function* (caller, sessionId) {
        yield* sweepExpired;
        // IDS-002: episodes are confined to the ambient tenant unless the caller passes the
        // superadmin predicate, in which case a `CrossTenant` witness is minted (only then).
        const scope = Option.getOrUndefined(yield* gate.crossTenantScope(caller));
        // IDS-001: the row is the only proof `sessionId` is an impersonation
        // session, and the per-episode gate needs its target. IDS-002: another
        // tenant's episode is simply not found, unless the caller is a superadmin.
        const episode = yield* records.findBySessionId(sessionId, scope);
        if (Option.isNone(episode)) {
          return yield* Effect.fail(new AdminApi.AdminImpersonationNotFound());
        }
        yield* gate.episode(caller, episode.value);
        // IDS-007: revoke first and idempotently — the row proves this really is an
        // impersonation session, so it is safe to revoke even if the row is already
        // ended (which is then reported as not-found below).
        yield* revokeQuietly(sessionId);
        const ended = yield* records
          .endEpisode(sessionId, "forcedByAdmin", scope)
          .pipe(
            Effect.catchTag("ImpersonationRecordNotFound", () =>
              Effect.fail(new AdminApi.AdminImpersonationNotFound()),
            ),
          );
        yield* events.publish({
          _tag: "auth.admin.impersonationStopped",
          sessionId: Sessions.SessionId(sessionId),
          adminUserId: ended.adminUserId,
          targetUserId: ended.targetUserId,
          endedBy: "forcedByAdmin",
        });
      });

      const list: AdminShape["list"] = Effect.fnUntraced(function* (caller, input) {
        // IDS-004: lazy reconciliation — an expired episode is never reported active.
        yield* sweepExpired;
        const page = yield* records.list(
          input,
          Option.getOrUndefined(yield* gate.crossTenantScope(caller)),
        );
        // IDS-001: per-row gate — a deny-all/unconfigured host exposes nothing. The gate
        // runs after paging, so a page can hold fewer than `limit` visible rows while
        // `nextCursor` still points onward.
        const items = yield* gate.visibleEpisodes(caller, page.items);
        return { items, nextCursor: page.nextCursor };
      });

      return Admin.of({
        impersonate,
        stopImpersonating,
        forceStop,
        list,
        sweepExpired,
        effectiveConfig,
        listUsers,
        getUser,
        updateUser,
        banUser,
        unbanUser,
        listUserSessions,
        revokeUserSession,
        revokeUserSessions,
      });
    }),
  });
}

/** IDS-004: `Admin.sweepExpired` as a bare Effect — `Effect.repeat(Admin.sweepExpiredEpisodes, Schedule.spaced("1 minute"))`. */
export const sweepExpiredEpisodes = Effect.gen(function* () {
  const admin = yield* Admin;
  return yield* admin.sweepExpired;
});
