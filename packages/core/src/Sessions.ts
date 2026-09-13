// @effect-auth/core — Sessions
//
// spec/behaviors/07-sessions.md, BEH-EA-049 through BEH-EA-056.
// Two `Layer`s over the same `SessionsShape`: `layerMemory` (a `Ref`) and
// `layerSql` (`@effect-auth/sql`'s `Model.Class`/repository, BEH-EA-033–036)
// — neither changes this service's public interface, the same deferral
// `Migrations.ts` documents for the persistence stratum generally.

import { Models as SqlModels, Repositories as SqlRepositories } from "@effect-auth/sql";
import * as Brand from "effect/Brand";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import { Model } from "effect/unstable/schema";
import { UserId } from "./Users.ts";

/** BEH-EA-049: the public half of a session's `id.secret` token. */
export type SessionId = string & Brand.Brand<"SessionId">;
export const SessionId = Brand.nominal<SessionId>();

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** BEH-EA-050: the one hash both `Layer`s persist in place of the plaintext secret. */
const hashSecret = (
  crypto: Crypto.Crypto,
  secret: string,
): Effect.Effect<string, PlatformError.PlatformError> =>
  crypto.digest("SHA-256", new TextEncoder().encode(secret)).pipe(Effect.map(toHex));

/**
 * BEH-EA-056: both operands are the fixed-length output of the same digest
 * algorithm, so a byte-length mismatch (should never occur in practice, but
 * is checked first so the loop below never runs over mismatched lengths) is
 * itself not a security-relevant timing signal — only the loop over
 * equal-length operands needs to run in constant time.
 */
const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
};

/** BEH-EA-051: `SessionConfig` — absolute/idle expiry and the idle-refresh throttle. */
export interface SessionConfig {
  readonly absolute: Duration.Duration;
  readonly idle: Duration.Duration;
  readonly touchEvery: Duration.Duration;
}

/**
 * `archive/PRD.md`'s own 30-day-absolute/7-day-idle defaults
 * (`spec/roadmap.md`'s "Under consideration" #2 notes these are not yet
 * finally settled against the 7d/1d ecosystem norm, but they are this
 * specification's current, documented default, not an arbitrary placeholder).
 */
export const SessionConfig: Context.Reference<SessionConfig> = Context.Reference<SessionConfig>(
  "effect-auth/core/SessionConfig",
  {
    defaultValue: () => ({
      absolute: Duration.days(30),
      idle: Duration.days(7),
      touchEvery: Duration.hours(1),
    }),
  },
);

/** What `Sessions.verify`/`issue` return — never the secret, never the stored hash. */
export interface SessionView {
  readonly id: SessionId;
  readonly userId: UserId;
  readonly createdAt: DateTime.Utc;
  readonly lastActiveAt: DateTime.Utc;
  readonly absoluteExpiresAt: DateTime.Utc;
  readonly idleExpiresAt: DateTime.Utc;
  readonly ipAddress: Option.Option<string>;
  readonly userAgent: Option.Option<string>;
}

/** BEH-EA-054: one row of `Sessions.list`. */
export interface SessionListItem {
  readonly id: SessionId;
  readonly createdAt: DateTime.Utc;
  readonly lastActiveAt: DateTime.Utc;
  readonly expiresAt: DateTime.Utc;
  readonly userAgent: Option.Option<string>;
  readonly current: boolean;
}

export class SessionNotFound extends Data.TaggedError("SessionNotFound")<{
  readonly message: string;
}> {}

export class SessionExpired extends Data.TaggedError("SessionExpired")<{
  readonly message: string;
  readonly id: SessionId;
}> {}

/** BEH-EA-055: the one session cookie's fixed, non-configurable attribute set. */
export const SESSION_COOKIE_NAME = "__Host-session";
export const SESSION_COOKIE_ATTRIBUTES = {
  secure: true,
  httpOnly: true,
  sameSite: "strict",
  path: "/",
} as const;

export interface SessionsShape {
  /**
   * BEH-EA-049/050/053: mints a fresh `id.secret` token, persists only the
   * secret's hash, and — when `supersedes` names a prior session — deletes
   * that row in the same call rather than leaving both live.
   */
  readonly issue: (input: {
    readonly userId: UserId;
    readonly request?: { readonly ip?: string; readonly userAgent?: string };
    readonly supersedes?: SessionId;
  }) => Effect.Effect<
    { readonly session: SessionView; readonly token: Redacted.Redacted<string> },
    PlatformError.PlatformError
  >;
  /**
   * BEH-EA-050/056: hashes the presented secret and compares it to the
   * stored hash in constant time; BEH-EA-052: also performs the
   * throttled-at-most-once-per-`touchEvery` idle refresh this same request
   * is the one to have earned.
   */
  readonly verify: (
    token: Redacted.Redacted<string>,
  ) => Effect.Effect<SessionView, SessionNotFound | SessionExpired | PlatformError.PlatformError>;
  readonly revoke: (id: SessionId) => Effect.Effect<void, SessionNotFound>;
  /** BEH-EA-054: revokes every session for `userId` except `keep`. */
  readonly revokeOthers: (userId: UserId, keep: SessionId) => Effect.Effect<void>;
  /** BEH-EA-054: `current` is set on whichever row's id equals `current`. */
  readonly list: (
    userId: UserId,
    current?: SessionId,
  ) => Effect.Effect<ReadonlyArray<SessionListItem>>;
}

export class Sessions extends Context.Service<Sessions, SessionsShape>()(
  "effect-auth/core/Sessions",
) {}

interface SessionRow {
  readonly id: SessionId;
  readonly userId: UserId;
  readonly secretHash: string;
  readonly createdAt: DateTime.Utc;
  readonly lastActiveAt: DateTime.Utc;
  readonly absoluteExpiresAt: DateTime.Utc;
  readonly idleExpiresAt: DateTime.Utc;
  readonly ipAddress: Option.Option<string>;
  readonly userAgent: Option.Option<string>;
}

const toView = (row: SessionRow): SessionView => row;

export const layerMemory: Layer.Layer<Sessions, never, Crypto.Crypto> = Layer.effect(
  Sessions,
  Effect.gen(function* () {
    const state = yield* Ref.make(HashMap.empty<SessionId, SessionRow>());
    const crypto = yield* Crypto.Crypto;
    const config = yield* SessionConfig;

    const issue: SessionsShape["issue"] = Effect.fnUntraced(function* (input) {
      if (input.supersedes !== undefined) {
        yield* Ref.update(state, (s) => HashMap.remove(s, input.supersedes as SessionId));
      }
      const id = SessionId(yield* crypto.randomUUIDv7);
      const secret = toHex(yield* crypto.randomBytes(32));
      const secretHash = yield* hashSecret(crypto, secret);
      const now = yield* DateTime.now;
      const absoluteExpiresAt = DateTime.addDuration(now, config.absolute);
      const row: SessionRow = {
        id,
        userId: input.userId,
        secretHash,
        createdAt: now,
        lastActiveAt: now,
        absoluteExpiresAt,
        idleExpiresAt: DateTime.min(DateTime.addDuration(now, config.idle), absoluteExpiresAt),
        ipAddress: Option.fromNullishOr(input.request?.ip),
        userAgent: Option.fromNullishOr(input.request?.userAgent),
      };
      yield* Ref.update(state, (s) => HashMap.set(s, id, row));
      return { session: toView(row), token: Redacted.make(`${id}.${secret}`) };
    });

    const verify: SessionsShape["verify"] = Effect.fnUntraced(function* (token) {
      const raw = Redacted.value(token);
      const separator = raw.indexOf(".");
      if (separator < 0) {
        return yield* Effect.fail(
          new SessionNotFound({ message: "effect-auth: malformed session token" }),
        );
      }
      const id = SessionId(raw.slice(0, separator));
      const secret = raw.slice(separator + 1);
      const row = yield* Ref.get(state).pipe(Effect.map((s) => HashMap.get(s, id)));
      if (Option.isNone(row)) {
        return yield* Effect.fail(
          new SessionNotFound({ message: `effect-auth: no such session: ${id}` }),
        );
      }
      const now = yield* DateTime.now;
      if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.value.absoluteExpiresAt)) {
        return yield* Effect.fail(
          new SessionExpired({ message: `effect-auth: session expired: ${id}`, id }),
        );
      }
      if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.value.idleExpiresAt)) {
        return yield* Effect.fail(
          new SessionExpired({ message: `effect-auth: session idle-expired: ${id}`, id }),
        );
      }
      const presentedHash = yield* hashSecret(crypto, secret);
      const matches = constantTimeEqual(
        new TextEncoder().encode(presentedHash),
        new TextEncoder().encode(row.value.secretHash),
      );
      if (!matches) {
        return yield* Effect.fail(
          new SessionNotFound({ message: `effect-auth: no such session: ${id}` }),
        );
      }
      // BEH-EA-052: throttled idle refresh — at most one write per `touchEvery`.
      const dueForTouch =
        DateTime.toEpochMillis(now) >=
        DateTime.toEpochMillis(DateTime.addDuration(row.value.lastActiveAt, config.touchEvery));
      if (!dueForTouch) {
        return toView(row.value);
      }
      const refreshed: SessionRow = {
        ...row.value,
        lastActiveAt: now,
        idleExpiresAt: DateTime.min(
          DateTime.addDuration(now, config.idle),
          row.value.absoluteExpiresAt,
        ),
      };
      yield* Ref.update(state, (s) => HashMap.set(s, id, refreshed));
      return toView(refreshed);
    });

    const revoke: SessionsShape["revoke"] = (id) =>
      Ref.modify(
        state,
        (
          s,
        ): readonly [
          Result.Result<void, SessionNotFound>,
          HashMap.HashMap<SessionId, SessionRow>,
        ] => {
          if (!HashMap.has(s, id)) {
            return [
              Result.fail(new SessionNotFound({ message: `effect-auth: no such session: ${id}` })),
              s,
            ] as const;
          }
          const ok: Result.Result<void, SessionNotFound> = Result.succeed(undefined);
          return [ok, HashMap.remove(s, id)] as const;
        },
      ).pipe(Effect.flatMap(Effect.fromResult));

    const revokeOthers: SessionsShape["revokeOthers"] = (userId, keep) =>
      Ref.update(state, (s) =>
        HashMap.filter(s, (row, id) => id === keep || row.userId !== userId),
      );

    const list: SessionsShape["list"] = (userId, current) =>
      Ref.get(state).pipe(
        Effect.map((s) =>
          Array.from(HashMap.values(s))
            .filter((row) => row.userId === userId)
            .map((row): SessionListItem => ({
              id: row.id,
              createdAt: row.createdAt,
              lastActiveAt: row.lastActiveAt,
              expiresAt: row.absoluteExpiresAt,
              userAgent: row.userAgent,
              current: row.id === current,
            })),
        ),
      );

    return { issue, verify, revoke, revokeOthers, list };
  }),
);

const toSessionView = (row: SqlModels.Session): SessionView => ({
  id: SessionId(row.id),
  userId: UserId(row.userId),
  createdAt: row.createdAt,
  lastActiveAt: row.lastActiveAt,
  absoluteExpiresAt: row.absoluteExpiresAt,
  idleExpiresAt: row.idleExpiresAt,
  ipAddress: Option.fromNullishOr(row.ipAddress),
  userAgent: Option.fromNullishOr(row.userAgent),
});

/** Generous enough for `Sessions.list`'s realistic device-list sizes; real UI-facing pagination (BEH-EA-036) is a repository-level concern this Shape doesn't itself expose. */
const LIST_PAGE_SIZE = 200;

export const layerSql: Layer.Layer<
  Sessions,
  never,
  SqlRepositories.SessionsRepository | Crypto.Crypto
> = Layer.effect(
  Sessions,
  Effect.gen(function* () {
    const repo = yield* SqlRepositories.SessionsRepository;
    const crypto = yield* Crypto.Crypto;
    const config = yield* SessionConfig;

    const issue: SessionsShape["issue"] = Effect.fnUntraced(function* (input) {
      if (input.supersedes !== undefined) {
        yield* repo.delete(input.supersedes).pipe(Effect.orDie);
      }
      const secret = toHex(yield* crypto.randomBytes(32));
      const secretHash = yield* hashSecret(crypto, secret);
      const now = yield* DateTime.now;
      const absoluteExpiresAt = DateTime.addDuration(now, config.absolute);
      const idleExpiresAt = DateTime.min(DateTime.addDuration(now, config.idle), absoluteExpiresAt);
      const insert = yield* SqlModels.Session.insert
        .makeEffect({
          userId: input.userId,
          secretHash,
          ipAddress: input.request?.ip ?? null,
          userAgent: input.request?.userAgent ?? null,
          absoluteExpiresAt,
          idleExpiresAt: Model.Override(idleExpiresAt),
        })
        .pipe(Effect.orDie);
      const row = yield* repo.insert(insert).pipe(Effect.orDie);
      return { session: toSessionView(row), token: Redacted.make(`${row.id}.${secret}`) };
    });

    const verify: SessionsShape["verify"] = Effect.fnUntraced(function* (token) {
      const raw = Redacted.value(token);
      const separator = raw.indexOf(".");
      if (separator < 0) {
        return yield* Effect.fail(
          new SessionNotFound({ message: "effect-auth: malformed session token" }),
        );
      }
      const id = SessionId(raw.slice(0, separator));
      const secret = raw.slice(separator + 1);
      const row = yield* repo.findById(id).pipe(
        Effect.catchTags({
          NoSuchElementError: () =>
            Effect.fail(new SessionNotFound({ message: `effect-auth: no such session: ${id}` })),
          SchemaError: Effect.die,
          SqlError: Effect.die,
        }),
      );
      const now = yield* DateTime.now;
      if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.absoluteExpiresAt)) {
        return yield* Effect.fail(
          new SessionExpired({ message: `effect-auth: session expired: ${id}`, id }),
        );
      }
      if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.idleExpiresAt)) {
        return yield* Effect.fail(
          new SessionExpired({ message: `effect-auth: session idle-expired: ${id}`, id }),
        );
      }
      const presentedHash = yield* hashSecret(crypto, secret);
      const matches = constantTimeEqual(
        new TextEncoder().encode(presentedHash),
        new TextEncoder().encode(row.secretHash),
      );
      if (!matches) {
        return yield* Effect.fail(
          new SessionNotFound({ message: `effect-auth: no such session: ${id}` }),
        );
      }
      // BEH-EA-052: throttled idle refresh — at most one write per `touchEvery`.
      const dueForTouch =
        DateTime.toEpochMillis(now) >=
        DateTime.toEpochMillis(DateTime.addDuration(row.lastActiveAt, config.touchEvery));
      if (!dueForTouch) {
        return toSessionView(row);
      }
      const update = yield* SqlModels.Session.update
        .makeEffect({
          id: row.id,
          lastActiveAt: Model.Override(now),
          idleExpiresAt: Model.Override(
            DateTime.min(DateTime.addDuration(now, config.idle), row.absoluteExpiresAt),
          ),
        })
        .pipe(Effect.orDie);
      const refreshed = yield* repo.update(update).pipe(Effect.orDie);
      return toSessionView(refreshed);
    });

    const revoke: SessionsShape["revoke"] = (id) =>
      repo.findById(id).pipe(
        Effect.catchTags({
          NoSuchElementError: () =>
            Effect.fail(new SessionNotFound({ message: `effect-auth: no such session: ${id}` })),
          SchemaError: Effect.die,
          SqlError: Effect.die,
        }),
        Effect.flatMap(() => repo.delete(id).pipe(Effect.orDie)),
      );

    const revokeOthers: SessionsShape["revokeOthers"] = (userId, keep) =>
      repo.deleteAllForUserExcept(userId, keep).pipe(Effect.orDie);

    const list: SessionsShape["list"] = (userId, current) =>
      repo.listByUser(userId, undefined, LIST_PAGE_SIZE).pipe(
        Effect.map((page) =>
          page.items.map((row): SessionListItem => ({
            id: SessionId(row.id),
            createdAt: row.createdAt,
            lastActiveAt: row.lastActiveAt,
            expiresAt: row.absoluteExpiresAt,
            userAgent: Option.fromNullishOr(row.userAgent),
            current: row.id === current,
          })),
        ),
        Effect.orDie,
      );

    return { issue, verify, revoke, revokeOthers, list };
  }),
);
