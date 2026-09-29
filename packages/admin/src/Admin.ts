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
import { AuthEvents, AuthPlugin, Migrations, Sessions, Users } from "@awthaq/core";
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
    input?: { readonly active?: boolean },
  ) => Effect.Effect<ReadonlyArray<ImpersonationRecords.ImpersonationRecord>>;
}

const toSessionDto = (session: Sessions.SessionView): SessionContract.SessionDto =>
  new SessionContract.SessionDto({
    id: session.id,
    createdAt: DateTime.formatIso(session.createdAt),
    lastActiveAt: DateTime.formatIso(session.lastActiveAt),
    expiresAt: DateTime.formatIso(session.absoluteExpiresAt),
    userAgent: Option.getOrNull(session.userAgent),
    current: true,
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
        yield* HttpApiBuilder.securitySetCookie(
          Api.SessionCookie,
          Redacted.value(issued.token),
          Sessions.SESSION_COOKIE_ATTRIBUTES,
        );
        return toSessionDto(issued.session);
      }),
      stopImpersonating: Effect.fnUntraced(function* () {
        const caller = yield* currentUserPrincipal;
        yield* admin.stopImpersonating(caller);
      }),
      forceStop: Effect.fnUntraced(function* ({ params }: { params: AdminApi.SessionIdParams }) {
        const caller = yield* currentUserPrincipal;
        yield* admin.forceStop(caller, params.sessionId);
      }),
      list: Effect.fnUntraced(function* ({ query }: { query: AdminApi.ListQuery }) {
        const caller = yield* currentUserPrincipal;
        const records = yield* admin.list(caller, { active: query.active === "true" });
        return records.map(toRecordDto);
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
            adminUserId TEXT NOT NULL,
            targetUserId TEXT NOT NULL,
            sessionId TEXT NOT NULL,
            reason TEXT NOT NULL,
            startedAt TIMESTAMPTZ NOT NULL,
            endedAt TIMESTAMPTZ,
            endedBy TEXT
          )`,
        sqlite: () => sql`
          CREATE TABLE admin_impersonation (
            id TEXT PRIMARY KEY,
            adminUserId TEXT NOT NULL,
            targetUserId TEXT NOT NULL,
            sessionId TEXT NOT NULL,
            reason TEXT NOT NULL,
            startedAt TEXT NOT NULL,
            endedAt TEXT,
            endedBy TEXT
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
          sql`CREATE INDEX admin_impersonation_session_id ON admin_impersonation(sessionId)`,
        sqlite: () =>
          sql`CREATE INDEX admin_impersonation_session_id ON admin_impersonation(sessionId)`,
        orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
      });
    }),
  },
];

export class Admin extends AuthPlugin.Service<Admin, AdminShape>()("admin", {
  apiVersion: 1,
  contract: AdminApi.AdminApi,
  tables: ["admin_impersonation"],
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

      const stopImpersonating: AdminShape["stopImpersonating"] = Effect.fnUntraced(
        function* (caller) {
          if (caller.actingAs === undefined) {
            return yield* Effect.fail(new AdminApi.AdminImpersonationNotFound());
          }
          yield* records
            .endEpisode(caller.sessionId, "self")
            .pipe(
              Effect.catchTag("ImpersonationRecordNotFound", () =>
                Effect.fail(new AdminApi.AdminImpersonationNotFound()),
              ),
            );
          yield* sessions.revoke(Sessions.SessionId(caller.sessionId)).pipe(Effect.orDie);
          yield* events.publish({
            _tag: "auth.admin.impersonationStopped",
            sessionId: caller.sessionId,
            endedBy: "self",
          });
        },
      );

      const forceStop: AdminShape["forceStop"] = Effect.fnUntraced(function* (caller, sessionId) {
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
        yield* records
          .endEpisode(sessionId, "forcedByAdmin")
          .pipe(
            Effect.catchTag("ImpersonationRecordNotFound", () =>
              Effect.fail(new AdminApi.AdminImpersonationNotFound()),
            ),
          );
        yield* sessions.revoke(Sessions.SessionId(sessionId)).pipe(Effect.orDie);
        yield* events.publish({
          _tag: "auth.admin.impersonationStopped",
          sessionId,
          endedBy: "forcedByAdmin",
        });
      });

      const list: AdminShape["list"] = Effect.fnUntraced(function* (caller, input) {
        const admin = subjectOf(caller);
        const rows = yield* records.list(input);
        // IDS-001: per-row gate — a deny-all/unconfigured host exposes nothing.
        return yield* Effect.filter(
          rows,
          (episode) => adminConfig.canManageEpisode({ admin, episode }),
          { concurrency: 8 },
        );
      });

      return Admin.of({ impersonate, stopImpersonating, forceStop, list });
    }),
  });
}
