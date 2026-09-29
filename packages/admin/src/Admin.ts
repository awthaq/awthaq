// @awthaq/admin — Admin
//
// spec/behaviors/27-admin-impersonation.md, BEH-EA-209 through BEH-EA-220.
// `Auth.make([Admin])` composes: `dependsOn` is left unset on
// `AuthPlugin.layer` — `Sessions`/`Users`/`AuthEvents` are core domain
// services this plugin's own `make` Effect simply `yield*`s directly, the
// same established convention `@awthaq/passkey`'s own ticket 06
// corrected `Passkey.ts` to (see that file's own header comment).
//
// `AdminConfig.canImpersonate` takes a `@qadi/core` `AuthSubject`, but this
// plugin never depends on `@awthaq/qadi` (that would put a plugin
// sitting at the same stratum as `@awthaq/passkey`/`password` above
// `@awthaq/server`, breaking the stratum ordering `spec/overview.md`
// fixes) — so the subject passed to the predicate is a bare, identity-only
// one this plugin builds itself (`subjectOf`, below), the same "id only, no
// roles, no permissions" shape `@awthaq/qadi`'s own `SubjectResolver.ts`
// documents as its own *default* resolution. A host application whose
// `canImpersonate` needs more than an id looks the rest up itself (e.g. by
// closing over its own `Roles`/`SubjectResolver` at `config()` call time) —
// this plugin has no way to reach a fuller subject without the layering
// violation above.

import { Api, SessionContract } from "@awthaq/api";
import { AuthEvents, AuthPlugin, Migrations, SessionCookie, Sessions, Users } from "@awthaq/core";
import { Session } from "@awthaq/server";
import type { AuthSubject } from "@qadi/core";
import { makeSubject } from "@qadi/core";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as AdminApi from "./AdminApi.ts";
import * as ImpersonationRecords from "./ImpersonationRecords.ts";

/**
 * IDS-001/MTI-006: the gate sees BOTH sides of the act, so a host can refuse
 * impersonating a more privileged (or another tenant's) account. Both subjects
 * are identity-only (see `subjectOf`); a host needing roles/tenant looks them
 * up itself by id.
 */
export interface ImpersonationGateInput {
  readonly admin: AuthSubject;
  readonly target: AuthSubject;
}

/** IDS-001: the per-episode form of the gate used by `forceStop` and `list`. */
export interface EpisodeGateInput {
  readonly admin: AuthSubject;
  readonly episode: ImpersonationRecords.ImpersonationRecord;
}

export interface AdminConfigShape {
  /** BEH-EA-210: the hard expiry every impersonation session gets at issuance. */
  readonly maxDuration: Duration.Duration;
  /** BEH-EA-212: fail-closed by default — an application that installs this plugin but never configures a gate denies every attempt. */
  readonly canImpersonate: (input: ImpersonationGateInput) => Effect.Effect<boolean>;
  /**
   * IDS-001: may `admin` end (`forceStop`) or see (`list`) this episode?
   * `config` defaults it to `canImpersonate` evaluated against the episode's
   * target, so a host scoping impersonation by privilege/tenant gets the same
   * scoping on stop/list without writing a second predicate.
   */
  readonly canManageEpisode: (input: EpisodeGateInput) => Effect.Effect<boolean>;
  /**
   * BAM-005: the one fail-closed predicate behind the user and session administration
   * endpoints. `target` is `None` for a collection-level call (`listUsers`) and the
   * user being acted on otherwise — the same "the gate sees the target" rule as
   * `canImpersonate` (IDS-001), so a host can keep, say, a superadmin account out of
   * reach of ordinary administrators. Banning (`canBanUsers`) and tenant administration
   * (`canAdministerTenants`) get their own predicates when those capabilities land.
   */
  readonly canManageUsers: (input: UserAdminGateInput) => Effect.Effect<boolean>;
}

/** BAM-005: what `canManageUsers` is asked — see there. */
export interface UserAdminGateInput {
  readonly admin: AuthSubject;
  readonly target: Option.Option<AuthSubject>;
}

/** IDS-001: the identity-only subject for a bare user id (the episode's target). */
const subjectOfUserId = (id: string): AuthSubject => makeSubject({ id });

const episodeGateFrom =
  (canImpersonate: AdminConfigShape["canImpersonate"]): AdminConfigShape["canManageEpisode"] =>
  ({ admin, episode }) =>
    canImpersonate({ admin, target: subjectOfUserId(episode.targetUserId) });

const defaultAdminConfig: AdminConfigShape = {
  maxDuration: Duration.hours(1),
  canImpersonate: () => Effect.succeed(false),
  canManageEpisode: episodeGateFrom(() => Effect.succeed(false)),
  canManageUsers: () => Effect.succeed(false),
};

/** BEH-EA-017's `Context.Reference`-with-default pattern, applied to this plugin's own policy knobs. */
export const AdminConfig: Context.Reference<AdminConfigShape> = Context.Reference(
  "awthaq/admin/Config",
  { defaultValue: () => defaultAdminConfig },
);

export const config = (partial: Partial<AdminConfigShape>) =>
  Layer.succeed(AdminConfig, {
    ...defaultAdminConfig,
    ...partial,
    canManageEpisode:
      partial.canManageEpisode ??
      episodeGateFrom(partial.canImpersonate ?? defaultAdminConfig.canImpersonate),
  });

export interface IssuedSession {
  readonly session: Sessions.SessionView;
  readonly token: Redacted.Redacted<string>;
}

/**
 * BEH-EA-137-style "identity-only" subject — this plugin's own, independent
 * copy (see this module's own header comment for why it cannot import
 * `@awthaq/qadi`'s real `SubjectResolver` default instead).
 */
const subjectOf = (principal: Api.UserPrincipal): AuthSubject =>
  makeSubject({ id: principal.ref.id });

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
  >;
  /** BEH-EA-216: `caller`'s own session must itself carry `actingAs`, or there is nothing to stop. */
  readonly stopImpersonating: (
    caller: Api.UserPrincipal,
  ) => Effect.Effect<void, AdminApi.AdminImpersonationNotFound>;
  /** BEH-EA-217: gated per episode by `canManageEpisode` (IDS-001); `sessionId` names the episode to end, not `caller`'s own. */
  readonly forceStop: (
    caller: Api.UserPrincipal,
    sessionId: string,
  ) => Effect.Effect<void, AdminApi.AdminImpersonationDenied | AdminApi.AdminImpersonationNotFound>;
  /** BEH-EA-219: rows are filtered through `canManageEpisode` (IDS-001); full history by default, `active` narrows to unended episodes. */
  readonly list: (
    caller: Api.UserPrincipal,
    input?: {
      readonly active?: boolean | undefined;
      readonly cursor?: ImpersonationRecords.ImpersonationCursor | undefined;
      readonly limit?: number | undefined;
    },
  ) => Effect.Effect<ImpersonationRecords.ImpersonationPage>;
  /**
   * IDS-004: closes every episode whose session hard-expired, as
   * `endedBy: "expired"`, publishing one `impersonationStopped` per closed
   * episode; resolves to how many it closed. `list`/`forceStop` already run
   * this lazily, so a host only schedules it (`Effect.repeat`/`Schedule`) when
   * it wants the audit trail closed without anyone reading it.
   */
  readonly sweepExpired: Effect.Effect<number>;
  /**
   * BAM-005: user and session administration, every call behind `canManageUsers` and
   * then (per-user calls) an existence check — see `AdminConfigShape.canManageUsers`.
   * Errors: `AdminActionDenied` (gate), `AdminTargetNotFound` (no such user),
   * `AdminSessionNotFound` (`revokeUserSession`: not one of that user's revocable
   * sessions — unknown, another user's, or an impersonation session, which `forceStop` owns).
   */
  readonly listUsers: (
    caller: Api.UserPrincipal,
    input?: {
      readonly cursor?: Users.UserCursor | undefined;
      readonly limit?: number | undefined;
    },
  ) => Effect.Effect<Users.UsersPage, AdminApi.AdminActionDenied>;
  readonly getUser: (
    caller: Api.UserPrincipal,
    userId: Users.UserId,
  ) => Effect.Effect<Users.UserRecord, AdminApi.AdminActionDenied | AdminApi.AdminTargetNotFound>;
  /** `metadata` left out leaves it untouched; `null` clears it (`Users.updateProfile`'s own rule). */
  readonly updateUser: (
    caller: Api.UserPrincipal,
    userId: Users.UserId,
    input: { readonly name: string; readonly metadata?: string | null | undefined },
  ) => Effect.Effect<Users.UserRecord, AdminApi.AdminActionDenied | AdminApi.AdminTargetNotFound>;
  /** The user's own sessions — impersonation sessions issued *as* that user are not among them. */
  readonly listUserSessions: (
    caller: Api.UserPrincipal,
    userId: Users.UserId,
  ) => Effect.Effect<
    ReadonlyArray<Sessions.SessionListItem>,
    AdminApi.AdminActionDenied | AdminApi.AdminTargetNotFound
  >;
  readonly revokeUserSession: (
    caller: Api.UserPrincipal,
    userId: Users.UserId,
    sessionId: string,
  ) => Effect.Effect<
    void,
    AdminApi.AdminActionDenied | AdminApi.AdminTargetNotFound | AdminApi.AdminSessionNotFound
  >;
  /** Revokes every one of the user's own sessions; impersonation sessions stay (end them with `forceStop`). */
  readonly revokeUserSessions: (
    caller: Api.UserPrincipal,
    userId: Users.UserId,
  ) => Effect.Effect<void, AdminApi.AdminActionDenied | AdminApi.AdminTargetNotFound>;
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

const toUserDto = (user: Users.UserRecord): AdminApi.UserDto =>
  new AdminApi.UserDto({
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    name: user.name,
    metadata: Option.getOrNull(user.metadata),
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
  });

/** Same forward-reference pattern `@awthaq/passkey`'s own `Passkey.ts` documents. */
const currentUserPrincipal = Effect.gen(function* () {
  const principal = yield* Api.CurrentPrincipal;
  if (principal._tag !== "User") {
    return yield* Effect.die(
      new Error(`awthaq: admin group reached with a non-User principal: ${principal._tag}`),
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
        orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
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
        orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
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
        orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
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
        orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
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
        orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
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
        orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
      });
    }),
  },
];

export class Admin extends AuthPlugin.Service<Admin, AdminShape>()("admin", {
  apiVersion: 1,
  contract: AdminApi.AdminApi,
  tables: ["admin_impersonation", "admin_impersonation_chain"],
  migrations: adminMigrations,
}) {
  static readonly layer = AuthPlugin.layer(Admin, {
    handlers: AdminHandlers,
    make: Effect.gen(function* () {
      const sessions = yield* Sessions.Sessions;
      const events = yield* AuthEvents.AuthEvents;
      const records = yield* ImpersonationRecords.ImpersonationRecords;
      const users = yield* Users.Users;
      const adminConfig = yield* AdminConfig;

      const deny = Effect.fnUntraced(function* (caller: Api.UserPrincipal) {
        yield* events.publish({
          _tag: "auth.admin.impersonationDenied",
          adminUserId: Users.UserId(caller.ref.id),
        });
        return yield* Effect.fail(new AdminApi.AdminImpersonationDenied());
      });

      // BAM-005: the user-administration gate — same shape as `deny` above but its own
      // predicate and its own event, so impersonation monitoring stays uncluttered.
      const authorizeUsers = Effect.fnUntraced(function* (
        caller: Api.UserPrincipal,
        action: string,
        target: Option.Option<Users.UserId>,
      ) {
        const allowed = yield* adminConfig.canManageUsers({
          admin: subjectOf(caller),
          target: Option.map(target, subjectOfUserId),
        });
        if (!allowed) {
          yield* events.publish({
            _tag: "auth.admin.actionDenied",
            adminUserId: Users.UserId(caller.ref.id),
            action,
          });
          return yield* Effect.fail(new AdminApi.AdminActionDenied());
        }
      });

      /** Gate first, then existence — a caller who fails the gate cannot probe which ids exist. */
      const authorizeUser = Effect.fnUntraced(function* (
        caller: Api.UserPrincipal,
        action: string,
        userId: Users.UserId,
      ) {
        yield* authorizeUsers(caller, action, Option.some(userId));
        return yield* users
          .findById(userId)
          .pipe(
            Effect.catchTag("UserNotFound", () => Effect.fail(new AdminApi.AdminTargetNotFound())),
          );
      });

      /** Sessions an impersonation episode owns are never touched by user-session administration (`forceStop` ends them). */
      const isImpersonationSession = (sessionId: string) =>
        records.findBySessionId(sessionId).pipe(Effect.map(Option.isSome));

      const ownSessions = Effect.fnUntraced(function* (userId: Users.UserId) {
        const listed = yield* sessions.list(userId);
        return yield* Effect.filter(listed, (session) =>
          Effect.map(isImpersonationSession(session.id), (impersonation) => !impersonation),
        );
      });

      const listUsers: AdminShape["listUsers"] = Effect.fnUntraced(function* (caller, input) {
        yield* authorizeUsers(caller, "listUsers", Option.none());
        return yield* users.list(input);
      });

      const getUser: AdminShape["getUser"] = (caller, userId) =>
        authorizeUser(caller, "getUser", userId);

      const updateUser: AdminShape["updateUser"] = Effect.fnUntraced(
        function* (caller, userId, input) {
          yield* authorizeUser(caller, "updateUser", userId);
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

      const listUserSessions: AdminShape["listUserSessions"] = Effect.fnUntraced(
        function* (caller, userId) {
          yield* authorizeUser(caller, "listUserSessions", userId);
          return yield* ownSessions(userId);
        },
      );

      const revokeUserSession: AdminShape["revokeUserSession"] = Effect.fnUntraced(
        function* (caller, userId, sessionId) {
          yield* authorizeUser(caller, "revokeUserSession", userId);
          // Must be one of *this user's own* revocable sessions — the same not-found for an
          // unknown id, another user's, or an impersonation session (no ownership oracle).
          const own = yield* ownSessions(userId);
          if (!own.some((session) => session.id === sessionId)) {
            return yield* Effect.fail(new AdminApi.AdminSessionNotFound());
          }
          yield* sessions
            .revoke(Sessions.SessionId(sessionId), "admin")
            // Gone between the check and the revoke: the desired end state, not an error.
            .pipe(Effect.catchTag("SessionNotFound", () => Effect.void));
          yield* events.publish({
            _tag: "auth.admin.sessionRevoked",
            adminUserId: Users.UserId(caller.ref.id),
            userId,
            sessionId,
          });
        },
      );

      const revokeUserSessions: AdminShape["revokeUserSessions"] = Effect.fnUntraced(
        function* (caller, userId) {
          yield* authorizeUser(caller, "revokeUserSessions", userId);
          const own = yield* ownSessions(userId);
          yield* Effect.forEach(
            own,
            (session) =>
              sessions
                .revoke(session.id, "admin")
                .pipe(Effect.catchTag("SessionNotFound", () => Effect.void)),
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

        const allowed = yield* adminConfig.canImpersonate({
          admin: subjectOf(caller),
          target: subjectOfUserId(targetUserId),
        });
        if (!allowed) return yield* deny(caller);

        // IDS-003: only a gate-passing caller learns whether the target exists.
        yield* users
          .findById(targetUserId)
          .pipe(
            Effect.catchTag("UserNotFound", () => Effect.fail(new AdminApi.AdminTargetNotFound())),
          );

        const issued = yield* sessions
          .issue({
            userId: targetUserId,
            actingAs: { type: caller.ref.type, id: caller.ref.id },
            absoluteDuration: adminConfig.maxDuration,
          })
          .pipe(Effect.orDie);
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
        const closed = yield* records.closeExpired(yield* DateTime.now);
        yield* Effect.forEach(
          closed,
          (episode) =>
            events.publish({
              _tag: "auth.admin.impersonationStopped",
              sessionId: episode.sessionId,
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
          .pipe(Effect.catchTag("SessionNotFound", () => Effect.void));

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
            sessionId: caller.sessionId,
            endedBy: "self",
          });
        },
      );

      const forceStop: AdminShape["forceStop"] = Effect.fnUntraced(function* (caller, sessionId) {
        yield* sweepExpired;
        // IDS-001: the row is the only proof `sessionId` is an impersonation
        // session, and the per-episode gate needs its target.
        const episode = yield* records.findBySessionId(sessionId);
        if (Option.isNone(episode)) {
          return yield* Effect.fail(new AdminApi.AdminImpersonationNotFound());
        }
        const allowed = yield* adminConfig.canManageEpisode({
          admin: subjectOf(caller),
          episode: episode.value,
        });
        if (!allowed) return yield* deny(caller);
        // IDS-007: revoke first and idempotently — the row proves this really is an
        // impersonation session, so it is safe to revoke even if the row is already
        // ended (which is then reported as not-found below).
        yield* revokeQuietly(sessionId);
        yield* records
          .endEpisode(sessionId, "forcedByAdmin")
          .pipe(
            Effect.catchTag("ImpersonationRecordNotFound", () =>
              Effect.fail(new AdminApi.AdminImpersonationNotFound()),
            ),
          );
        yield* events.publish({
          _tag: "auth.admin.impersonationStopped",
          sessionId,
          endedBy: "forcedByAdmin",
        });
      });

      const list: AdminShape["list"] = Effect.fnUntraced(function* (caller, input) {
        // IDS-004: lazy reconciliation — an expired episode is never reported active.
        yield* sweepExpired;
        const admin = subjectOf(caller);
        const page = yield* records.list(input);
        // IDS-001: per-row gate — a deny-all/unconfigured host exposes nothing. The gate
        // runs after paging, so a page can hold fewer than `limit` visible rows while
        // `nextCursor` still points onward.
        const items = yield* Effect.filter(
          page.items,
          (episode) => adminConfig.canManageEpisode({ admin, episode }),
          { concurrency: 8 },
        );
        return { items, nextCursor: page.nextCursor };
      });

      return Admin.of({
        impersonate,
        stopImpersonating,
        forceStop,
        list,
        sweepExpired,
        listUsers,
        getUser,
        updateUser,
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
