// @awthaq/core — Sessions
//
// spec/behaviors/07-sessions.md, BEH-EA-049 through BEH-EA-056.
// Two `Layer`s over the same `SessionsShape`: `layerMemory` (a `Ref`) and
// `layerSql` (`@awthaq/sql`'s `Model.Class`/repository, BEH-EA-033–036)
// — neither changes this service's public interface, the same deferral
// `Migrations.ts` documents for the persistence stratum generally.

import { Models as SqlModels, Repositories as SqlRepositories } from "@awthaq/sql";
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
import * as Model from "effect/unstable/schema/Model";
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
  "awthaq/core/SessionConfig",
  {
    defaultValue: () => ({
      absolute: Duration.days(30),
      idle: Duration.days(7),
      touchEvery: Duration.hours(1),
    }),
  },
);

/**
 * BEH-EA-209: the caller's own identity, immutably attached to a session
 * minted on someone else's behalf (e.g. `@awthaq/admin`'s `impersonate`)
 * — a generic, `Admin`-agnostic field any future plugin could reuse.
 */
export interface ActingAs {
  readonly type: string;
  readonly id: string;
}

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
  /** BEH-EA-209/210: present only for a session minted with `actingAs`; such a session never idle-refreshes. */
  readonly actingAs: Option.Option<ActingAs>;
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
    /** BEH-EA-209/210: sets a hard expiry (`idleExpiresAt = absoluteExpiresAt`) and disables idle-refresh for this session's whole lifetime. */
    readonly actingAs?: ActingAs;
    /** BEH-EA-212: overrides `SessionConfig.absolute` for this one call — e.g. `@awthaq/admin`'s own `AdminConfig.maxDuration`, generally shorter than an ordinary session's absolute lifetime. */
    readonly absoluteDuration?: Duration.Duration;
  }) => Effect.Effect<
    { readonly session: SessionView; readonly token: Redacted.Redacted<string> },
    PlatformError.PlatformError
  >;
  /**
   * BEH-EA-050/056: hashes the presented secret and compares it to the
   * stored hash in constant time; BEH-EA-052: also performs the
   * throttled-at-most-once-per-`touchEvery` idle refresh this same request
   * is the one to have earned.
   *
   * Upstream-hardening map, ticket 01: the same throttled-touch write also
   * rotates the session's secret (the standard session-fixation defense) —
   * `rotated` carries the freshly-minted full token exactly when this call
   * performed that rotation, `Option.none()` otherwise (including every
   * `actingAs` session, which never touches this path at all). The old
   * secret's hash is overwritten in the same atomic write, so it stops
   * verifying immediately — no grace window. A concurrent second `verify`
   * racing the same throttled write never corrupts state (a compare-and-
   * swap in both `Layer`s' own implementation lets only one winner rotate;
   * the loser reports `rotated: Option.none()` over the winner's write),
   * calling `verify` a *second time within one request* against the same
   * pre-rotation credential used to be a real architectural risk:
   * `@awthaq/qadi`'s `SubjectExtractorLive` (BEH-EA-153) calls
   * `resolvePrincipal` — and so `verify` — independent of and potentially
   * before `Authentication`'s own middleware runs on the same request
   * (spec/behaviors/20-qadi-bridge-path-b.md), so an endpoint wiring both
   * Path A's `Api.Authentication` and Path B's `RequirePermission`
   * together would have rotated on the first call and then failed the
   * second with `SessionNotFound`, once every `touchEvery` window, per
   * session.
   *
   * Resolved (upstream-hardening-followups map, ticket 03):
   * `@awthaq/server`'s `Authentication.resolveSession` now memoizes its
   * result per request, keyed on the ambient `HttpServerRequest`'s own
   * identity — both `AuthenticationLive`/`OptionalAuthenticationLive` and
   * `SubjectExtractorLive` funnel through it, so a second call within the
   * same request reuses the first's outcome (including whether it
   * rotated) rather than calling `verify` again.
   */
  readonly verify: (
    token: Redacted.Redacted<string>,
  ) => Effect.Effect<
    { readonly session: SessionView; readonly rotated: Option.Option<Redacted.Redacted<string>> },
    SessionNotFound | SessionExpired | PlatformError.PlatformError
  >;
  readonly revoke: (id: SessionId) => Effect.Effect<void, SessionNotFound>;
  /** BEH-EA-054: revokes every session for `userId` except `keep`. */
  readonly revokeOthers: (userId: UserId, keep: SessionId) => Effect.Effect<void>;
  /** Ticket 02: revokes every session for `userId`, no exceptions — including the caller's own current session. */
  readonly revokeAll: (userId: UserId) => Effect.Effect<void>;
  /** BEH-EA-054: `current` is set on whichever row's id equals `current`. */
  readonly list: (
    userId: UserId,
    current?: SessionId,
  ) => Effect.Effect<ReadonlyArray<SessionListItem>>;
}

export class Sessions extends Context.Service<Sessions, SessionsShape>()("awthaq/core/Sessions") {}

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
  readonly actingAs: Option.Option<ActingAs>;
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
      const absoluteExpiresAt = DateTime.addDuration(
        now,
        input.absoluteDuration ?? config.absolute,
      );
      // BEH-EA-210: a session minted with `actingAs` gets a hard expiry —
      // `idleExpiresAt` set equal to `absoluteExpiresAt` at issuance, never
      // pushed further out by `verify`'s idle-refresh touch.
      const idleExpiresAt =
        input.actingAs === undefined
          ? DateTime.min(DateTime.addDuration(now, config.idle), absoluteExpiresAt)
          : absoluteExpiresAt;
      const row: SessionRow = {
        id,
        userId: input.userId,
        secretHash,
        createdAt: now,
        lastActiveAt: now,
        absoluteExpiresAt,
        idleExpiresAt,
        ipAddress: Option.fromNullishOr(input.request?.ip),
        userAgent: Option.fromNullishOr(input.request?.userAgent),
        actingAs: Option.fromNullishOr(input.actingAs),
      };
      yield* Ref.update(state, (s) => HashMap.set(s, id, row));
      return { session: toView(row), token: Redacted.make(`${id}.${secret}`) };
    });

    const verify: SessionsShape["verify"] = Effect.fnUntraced(function* (token) {
      const raw = Redacted.value(token);
      const separator = raw.indexOf(".");
      if (separator < 0) {
        return yield* Effect.fail(
          new SessionNotFound({ message: "awthaq: malformed session token" }),
        );
      }
      const id = SessionId(raw.slice(0, separator));
      const secret = raw.slice(separator + 1);
      const row = yield* Ref.get(state).pipe(Effect.map((s) => HashMap.get(s, id)));
      if (Option.isNone(row)) {
        return yield* Effect.fail(
          new SessionNotFound({ message: `awthaq: no such session: ${id}` }),
        );
      }
      const now = yield* DateTime.now;
      if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.value.absoluteExpiresAt)) {
        return yield* Effect.fail(
          new SessionExpired({ message: `awthaq: session expired: ${id}`, id }),
        );
      }
      if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.value.idleExpiresAt)) {
        return yield* Effect.fail(
          new SessionExpired({ message: `awthaq: session idle-expired: ${id}`, id }),
        );
      }
      const presentedHash = yield* hashSecret(crypto, secret);
      const matches = constantTimeEqual(
        new TextEncoder().encode(presentedHash),
        new TextEncoder().encode(row.value.secretHash),
      );
      if (!matches) {
        return yield* Effect.fail(
          new SessionNotFound({ message: `awthaq: no such session: ${id}` }),
        );
      }
      // BEH-EA-210: a session carrying `actingAs` never idle-refreshes — its
      // hard expiry is the whole mechanism, so `verify` never touches it.
      if (Option.isSome(row.value.actingAs)) {
        return { session: toView(row.value), rotated: Option.none() };
      }
      // BEH-EA-052: throttled idle refresh — at most one write per `touchEvery`.
      const dueForTouch =
        DateTime.toEpochMillis(now) >=
        DateTime.toEpochMillis(DateTime.addDuration(row.value.lastActiveAt, config.touchEvery));
      if (!dueForTouch) {
        return { session: toView(row.value), rotated: Option.none() };
      }
      // Ticket 01: the same throttled write also rotates the secret — via
      // `Ref.modify`'s own atomicity, compare-and-swapped against
      // `row.value.secretHash` (the value this call just read) so a losing
      // concurrent request never clobbers a winner's write with its own,
      // independently-generated secret. Losing the race isn't a failure:
      // this call simply reports no rotation of its own, over whatever the
      // winner's write left behind.
      const newSecret = toHex(yield* crypto.randomBytes(32));
      const newSecretHash = yield* hashSecret(crypto, newSecret);
      const expectedSecretHash = row.value.secretHash;
      const touched = yield* Ref.modify(
        state,
        (s): readonly [Option.Option<SessionRow>, HashMap.HashMap<SessionId, SessionRow>] => {
          const current = HashMap.get(s, id);
          if (Option.isNone(current) || current.value.secretHash !== expectedSecretHash) {
            return [Option.none(), s] as const;
          }
          const refreshed: SessionRow = {
            ...current.value,
            secretHash: newSecretHash,
            lastActiveAt: now,
            idleExpiresAt: DateTime.min(
              DateTime.addDuration(now, config.idle),
              current.value.absoluteExpiresAt,
            ),
          };
          return [Option.some(refreshed), HashMap.set(s, id, refreshed)] as const;
        },
      );
      if (Option.isNone(touched)) {
        const current = yield* Ref.get(state).pipe(Effect.map((s) => HashMap.get(s, id)));
        if (Option.isNone(current)) {
          return yield* Effect.fail(
            new SessionNotFound({ message: `awthaq: no such session: ${id}` }),
          );
        }
        return { session: toView(current.value), rotated: Option.none() };
      }
      return {
        session: toView(touched.value),
        rotated: Option.some(Redacted.make(`${id}.${newSecret}`)),
      };
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
              Result.fail(new SessionNotFound({ message: `awthaq: no such session: ${id}` })),
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

    const revokeAll: SessionsShape["revokeAll"] = (userId) =>
      Ref.update(state, (s) => HashMap.filter(s, (row) => row.userId !== userId));

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

    return { issue, verify, revoke, revokeOthers, revokeAll, list };
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
  actingAs:
    row.actingAsType === null || row.actingAsId === null
      ? Option.none()
      : Option.some({ type: row.actingAsType, id: row.actingAsId }),
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
      const absoluteExpiresAt = DateTime.addDuration(
        now,
        input.absoluteDuration ?? config.absolute,
      );
      // BEH-EA-210: a session minted with `actingAs` gets a hard expiry —
      // `idleExpiresAt` set equal to `absoluteExpiresAt` at issuance.
      const idleExpiresAt =
        input.actingAs === undefined
          ? DateTime.min(DateTime.addDuration(now, config.idle), absoluteExpiresAt)
          : absoluteExpiresAt;
      const insert = yield* SqlModels.Session.insert
        .makeEffect({
          userId: input.userId,
          secretHash,
          ipAddress: input.request?.ip ?? null,
          userAgent: input.request?.userAgent ?? null,
          absoluteExpiresAt,
          idleExpiresAt: Model.Override(idleExpiresAt),
          actingAsType: input.actingAs?.type ?? null,
          actingAsId: input.actingAs?.id ?? null,
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
          new SessionNotFound({ message: "awthaq: malformed session token" }),
        );
      }
      const id = SessionId(raw.slice(0, separator));
      const secret = raw.slice(separator + 1);
      const row = yield* repo.findById(id).pipe(
        Effect.catchTags({
          NoSuchElementError: () =>
            Effect.fail(new SessionNotFound({ message: `awthaq: no such session: ${id}` })),
          SchemaError: Effect.die,
          SqlError: Effect.die,
        }),
      );
      const now = yield* DateTime.now;
      if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.absoluteExpiresAt)) {
        return yield* Effect.fail(
          new SessionExpired({ message: `awthaq: session expired: ${id}`, id }),
        );
      }
      if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.idleExpiresAt)) {
        return yield* Effect.fail(
          new SessionExpired({ message: `awthaq: session idle-expired: ${id}`, id }),
        );
      }
      const presentedHash = yield* hashSecret(crypto, secret);
      const matches = constantTimeEqual(
        new TextEncoder().encode(presentedHash),
        new TextEncoder().encode(row.secretHash),
      );
      if (!matches) {
        return yield* Effect.fail(
          new SessionNotFound({ message: `awthaq: no such session: ${id}` }),
        );
      }
      // BEH-EA-210: a session carrying `actingAs` never idle-refreshes.
      if (row.actingAsType !== null || row.actingAsId !== null) {
        return { session: toSessionView(row), rotated: Option.none() };
      }
      // BEH-EA-052: throttled idle refresh — at most one write per `touchEvery`.
      const dueForTouch =
        DateTime.toEpochMillis(now) >=
        DateTime.toEpochMillis(DateTime.addDuration(row.lastActiveAt, config.touchEvery));
      if (!dueForTouch) {
        return { session: toSessionView(row), rotated: Option.none() };
      }
      // Ticket 01: the same throttled write also rotates the secret.
      // `repo.touch`'s own compare-and-swap (guarded on `row.secretHash`,
      // the value this call just read) means a losing concurrent request
      // never clobbers a winner's write — see `SessionsRepositoryShape.touch`'s
      // own doc comment. Losing the race isn't a failure: this call simply
      // reports no rotation of its own, over whatever the winner's write
      // left behind.
      const newSecret = toHex(yield* crypto.randomBytes(32));
      const newSecretHash = yield* hashSecret(crypto, newSecret);
      const touched = yield* repo
        .touch({
          id: row.id,
          expectedSecretHash: row.secretHash,
          secretHash: newSecretHash,
          lastActiveAt: now,
          idleExpiresAt: DateTime.min(
            DateTime.addDuration(now, config.idle),
            row.absoluteExpiresAt,
          ),
        })
        .pipe(Effect.orDie);
      if (Option.isNone(touched)) {
        const current = yield* repo.findById(id).pipe(
          Effect.catchTags({
            NoSuchElementError: () =>
              Effect.fail(new SessionNotFound({ message: `awthaq: no such session: ${id}` })),
            SchemaError: Effect.die,
            SqlError: Effect.die,
          }),
        );
        return { session: toSessionView(current), rotated: Option.none() };
      }
      return {
        session: toSessionView(touched.value),
        rotated: Option.some(Redacted.make(`${id}.${newSecret}`)),
      };
    });

    const revoke: SessionsShape["revoke"] = (id) =>
      repo.findById(id).pipe(
        Effect.catchTags({
          NoSuchElementError: () =>
            Effect.fail(new SessionNotFound({ message: `awthaq: no such session: ${id}` })),
          SchemaError: Effect.die,
          SqlError: Effect.die,
        }),
        Effect.flatMap(() => repo.delete(id).pipe(Effect.orDie)),
      );

    const revokeOthers: SessionsShape["revokeOthers"] = (userId, keep) =>
      repo.deleteAllForUserExcept(userId, keep).pipe(Effect.orDie);

    const revokeAll: SessionsShape["revokeAll"] = (userId) =>
      repo.deleteAllByUser(userId).pipe(Effect.orDie);

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

    return { issue, verify, revoke, revokeOthers, revokeAll, list };
  }),
);
