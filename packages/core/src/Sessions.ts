// @awthaq/core — Sessions
//
// spec/behaviors/07-sessions.md, BEH-EA-049 through BEH-EA-056.
// Plan 02 (ADR-EA-041, ADR-EA-014): written once, over `@awthaq/ports`' `SessionStore` (a `Ref`
// adapter there, a SQL adapter over `@awthaq/sql`'s repository, BEH-EA-033-036; a KV backend is an
// implementation of the same nine primitives). The service owns the rules (the token and its hash, the
// proof-before-state order, the expiries, the throttled touch, rotation and its grace window, reuse
// detection, the concurrent-session policy, the events); the store owns persistence and the
// atomicity of each primitive.

import { Api } from "@awthaq/api";
import { Hmac, type Ids, LegacySessionBridge, SessionStore, type Store } from "@awthaq/ports";
import { SessionStoreSql, type Repositories as SqlRepositories } from "@awthaq/sql";
import * as Brand from "effect/Brand";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as AuthEvents from "./AuthEvents.ts";
import { relabel, storeUnavailable, type StoreUnavailable } from "./Errors.ts";
import * as Observability from "./Observability.ts";
import * as SecretHash from "./SecretHash.ts";
import * as Tenant from "./Tenant.ts";
import { UserId } from "./Users.ts";

/**
 * BEH-EA-049: the public half of a session's `id.secret` token. INV-EA-018: an id is an identifier, never a capability — it appears in cookies, JWT `sid` claims and error messages, so nothing may act on it without the secret's proof (PIL-007).
 */
// MA-008: the brand is declared once, in `@awthaq/ports` (`Ids`); this keeps only a nominal constructor.
export type SessionId = Ids.SessionId;
export const SessionId = Brand.nominal<SessionId>();

const { toHex } = Hmac;

/** BEH-EA-050: the one hash both `Layer`s persist in place of the plaintext secret (OCM-002: shared with `@awthaq/api-key`). */
const hashSecret = SecretHash.digest;

/**
 * PIL-007: the hash an unknown session id is compared against, so a miss does
 * the same hash + constant-time compare work as a known id with a wrong
 * secret. Never equals any real `hashSecret` output (SHA-256 of a secret
 * whose digest is all zeros is not computable in practice).
 */
/**
 * CSD-003: the persisted `userAgent` is caller-supplied (a request header), so
 * it is capped at the persistence boundary — every issuing plugin benefits,
 * none has to remember.
 */
export const MAX_USER_AGENT_LENGTH = 512;

const cappedUserAgent = (userAgent: string | undefined): string | undefined =>
  userAgent?.slice(0, MAX_USER_AGENT_LENGTH);

const UNKNOWN_SESSION_HASH = SecretHash.NEVER_MATCHES;

// BEH-EA-056/ACS-005: both operands are the fixed-length hex output of the
// same digest, compared in constant time by the shared `Hmac` primitive.
const secretMatches = SecretHash.equals;

/**
 * RRS-005: which of a session's accepted secrets the presented hash is. Both comparisons always run
 * (the previous one against `NEVER_MATCHES` when there is none), so the work done does not reveal
 * whether the row has a live grace window. A previous secret only counts before its own expiry.
 */
const matchedSecret = (
  now: DateTime.Utc,
  presentedHash: string,
  currentHash: string,
  previousHash: string | undefined,
  previousExpiresAt: DateTime.Utc | undefined,
): "current" | "previous" | "none" => {
  const current = secretMatches(presentedHash, currentHash);
  const previous = secretMatches(presentedHash, previousHash ?? UNKNOWN_SESSION_HASH);
  if (current) return "current";
  return previous &&
    previousHash !== undefined &&
    previousExpiresAt !== undefined &&
    DateTime.toEpochMillis(now) < DateTime.toEpochMillis(previousExpiresAt)
    ? "previous"
    : "none";
};

/**
 * SMS-003: an opt-in cap on one user's simultaneously live sessions. Absent by
 * default — BEH-EA-047 forbids an implied base-model limit; this is a
 * deployment policy. `evictOldest` ends the least-recently-active surplus
 * session(s) in the same atomic step as the issue that would exceed `limit`,
 * publishing `auth.session.revoked` (`limitEvicted`) for each, so `issue`'s
 * error channel is unchanged. Impersonation (`actingAs`) sessions neither
 * count toward nor trigger the cap — an admin's support session must never end
 * the target's own sessions.
 */
export interface ConcurrentSessionPolicy {
  /** At least 1. */
  readonly limit: number;
  readonly onExceed: "evictOldest";
}

/** BEH-EA-051: `SessionConfig` — absolute/idle expiry and the idle-refresh throttle. */
export interface SessionConfig {
  readonly absolute: Duration.Duration;
  readonly idle: Duration.Duration;
  readonly touchEvery: Duration.Duration;
  /**
   * RRS-005/RRC-006: how long the secret a throttled touch just replaced keeps verifying, so a
   * rotation whose response never reached the client (a dropped `set-auth-token` header, a lost
   * `Set-Cookie`, a request already in flight) does not strand the legitimate holder. Presenting the
   * previous secret inside the window is accepted for *that session only*, hands back a fresh secret
   * (`rotated`), publishes `auth.session.rotated` with `viaGrace`, and never counts as reuse (RRS-003's
   * tombstone family revocation is a separate path this does not touch). `Duration.zero` restores
   * immediate invalidation; absent = `DEFAULT_ROTATION_GRACE`.
   */
  readonly rotationGrace?: Duration.Duration;
  /** SMS-003: opt-in concurrent-session cap; absent = uncapped (the default). */
  readonly maxConcurrent?: ConcurrentSessionPolicy;
}

/** RRS-005: the bounded window `SessionConfig.rotationGrace` defaults to. */
export const DEFAULT_ROTATION_GRACE = Duration.seconds(30);

const graceOf = (config: SessionConfig): Duration.Duration =>
  config.rotationGrace ?? DEFAULT_ROTATION_GRACE;

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
      rotationGrace: DEFAULT_ROTATION_GRACE,
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

/**
 * THS-003/APS-007: RFC 8176 authentication method references — how a session
 * was authenticated, not merely how recently (`authenticatedAt`). A closed set,
 * so a typo cannot silently fail a policy check: `pwd` password, `hwk`
 * hardware-bound key (passkey), `swk` software key, `user` user verification,
 * `otp` one-time password, `mfa` multiple factors, `fed` federated identity
 * (OAuth), `email` proof of mailbox control, `sms` an SMS-delivered code — a *restricted*
 * authenticator (NIST SP 800-63B-4), kept apart from `otp` so a policy can rank it lower
 * (`Assurance`, SOS-005); no plugin records it yet (ADR-EA-021).
 */
export type AuthMethod = "pwd" | "hwk" | "swk" | "user" | "otp" | "mfa" | "fed" | "email" | "sms";

const AUTH_METHODS: ReadonlySet<string> = new Set([
  "pwd",
  "hwk",
  "swk",
  "user",
  "otp",
  "mfa",
  "fed",
  "email",
  "sms",
]);

/** Narrows a plain string to a known method — how a consumer of a principal's `amr` (a `string[]` on the wire) gets `AuthMethod`s. */
export const isAuthMethod = (value: unknown): value is AuthMethod =>
  typeof value === "string" && AUTH_METHODS.has(value);

/** Order-preserving union — `amr` only ever grows within a session. The one definition the stores share. */
export const unionAmr = (
  existing: ReadonlyArray<AuthMethod>,
  additions: ReadonlyArray<AuthMethod>,
): ReadonlyArray<AuthMethod> => SessionStore.unionMethods(existing, additions);

/** What `Sessions.verify`/`issue` return — never the secret, never the stored hash. */
export interface SessionView {
  readonly id: SessionId;
  readonly userId: UserId;
  readonly createdAt: DateTime.Utc;
  /**
   * Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 15
   * (AAPS-001/BPAS-001): "when this session last *proved* a credential" —
   * equal to `createdAt` at `issue` time (every mint follows a real
   * credential presentation), advanced only by `reauthenticate`, and never
   * touched by `verify`'s own idle-refresh/rotation. This is the field a
   * step-up check (`isStale`) compares against, not `createdAt`, which
   * rotation deliberately preserves across an otherwise-unrelated secret
   * refresh.
   */
  readonly authenticatedAt: DateTime.Utc;
  readonly lastActiveAt: DateTime.Utc;
  readonly absoluteExpiresAt: DateTime.Utc;
  readonly idleExpiresAt: DateTime.Utc;
  readonly ipAddress: Option.Option<string>;
  readonly userAgent: Option.Option<string>;
  /** BEH-EA-209/210: present only for a session minted with `actingAs`; such a session never idle-refreshes. */
  readonly actingAs: Option.Option<ActingAs>;
  /** THS-003: the authentication methods recorded at issue (and unioned in by `reauthenticate`); empty when the issuing path recorded none. */
  readonly amr: ReadonlyArray<AuthMethod>;
  /**
   * DRS-001 (ADR-EA-018): the ambient tenant this session was issued under,
   * `None` for a single-tenant deployment. A host that serves several tenants
   * compares it with the request's own tenant to refuse a cookie minted for
   * another one.
   */
  readonly tenantId: Option.Option<string>;
}

/** BEH-EA-054: one row of `Sessions.list`. */
export interface SessionListItem {
  readonly id: SessionId;
  readonly createdAt: DateTime.Utc;
  /** Ticket 15: see `SessionView.authenticatedAt`'s own doc comment — the field a step-up check compares against. */
  readonly authenticatedAt: DateTime.Utc;
  readonly lastActiveAt: DateTime.Utc;
  readonly expiresAt: DateTime.Utc;
  readonly userAgent: Option.Option<string>;
  /** THS-003: see `SessionView.amr`. */
  readonly amr: ReadonlyArray<AuthMethod>;
  readonly current: boolean;
}

/**
 * Ticket 15: the one staleness comparison a step-up/reauth check needs.
 * `Sessions.requireFresh` is its only caller; a gate asks the store
 * (BEH-EA-320) instead of re-deriving the `DateTime.distance`/
 * `Duration.isGreaterThan` pair itself.
 */
export const isStale = (
  authenticatedAt: DateTime.Utc,
  maxAgeSeconds: number,
  now: DateTime.Utc,
): boolean =>
  Duration.isGreaterThan(DateTime.distance(authenticatedAt, now), Duration.seconds(maxAgeSeconds));

/**
 * IDS-008: a programming error in the producing plugin, not a request-level
 * condition — a session may not name its own user as the acting party
 * (BEH-EA-209). Raised as a defect from `issue` in both layers, so `issue`'s
 * public error channel is unchanged. The nesting rule (a caller who is
 * already acting-as may not mint a further acting-as session, BEH-EA-214)
 * needs the caller's own session, which `issue` never sees — that stays with
 * the producer (`@awthaq/admin`'s `impersonate` is the reference).
 */
export class InvalidActingAs extends Data.TaggedError("InvalidActingAs")<{
  readonly reason: "self";
}> {}

const refuseSelfActingAs = (input: {
  readonly userId: UserId;
  readonly actingAs?: ActingAs;
}): Effect.Effect<void> =>
  input.actingAs !== undefined &&
  input.actingAs.type === "user" &&
  input.actingAs.id === input.userId
    ? Effect.die(new InvalidActingAs({ reason: "self" }))
    : Effect.void;

/**
 * EOTS-004: messages are constant strings — a session id is the public half of a bearer
 * credential (and enough, for a superseded session, to be probed), and error messages reach
 * logs. Identifiers ride only in typed fields, for in-process correlation; never log them.
 */
export class SessionNotFound extends Data.TaggedError("Sessions/NotFound")<{
  readonly message: string;
  readonly id?: SessionId;
}> {}

/**
 * BEH-EA-320: `requireFresh` found no session that proved a credential within `maxAge`.
 * Callers map it to their own wire error (`PasskeyReauthRequired`, `TwoFactorReauthRequired`,
 * `Api.ReauthRequired`); `reason` is for logs and step-up UX, never for an authorization decision.
 */
export class SessionStale extends Data.TaggedError("Sessions/Stale")<{
  readonly maxAgeSeconds: number;
  /** `notLive`: absent, foreign, tombstoned or expired. `stale`: live, but `authenticatedAt` is older than `maxAge`. */
  readonly reason: "notLive" | "stale";
}> {}

export class SessionExpired extends Data.TaggedError("SessionExpired")<{
  readonly message: string;
  readonly id: SessionId;
}> {}

/**
 * BEH-EA-055: the default session cookie's name. IC-007: the cookie's
 * attributes and (for `SecureDomain`) name are `SessionCookie`'s
 * `SessionCookieConfig`; every writer renders through `SessionCookie.render`.
 */
export const SESSION_COOKIE_NAME = Api.SESSION_COOKIE_NAME;
/**
 * APS-006: impersonation sessions travel under their own cookie, with the
 * identical attributes, so `impersonate` never overwrites the admin's own
 * `__Host-session` and `stopImpersonating` can hand the browser back to it.
 * `Authentication` only accepts a session carrying `actingAs` from this name.
 */
export const IMPERSONATION_COOKIE_NAME = Api.IMPERSONATION_COOKIE_NAME;

export interface SessionsShape {
  /**
   * BEH-EA-049/050/053: mints a fresh `id.secret` token, persists only the
   * secret's hash, and — when `supersedes` names a prior session —
   * tombstones that row in the same call (RRS-003: `supersededBy`/
   * `supersededAt` set, never deleted) rather than leaving both live. The
   * new row inherits the old row's `familyId` — see `verify`'s own doc
   * comment for what presenting a tombstoned row again means.
   *
   * ESA-006: publishes exactly one `auth.session.issued` (session id, user id,
   * family id, and `actingAs` when present) after the row is persisted, for
   * every caller — plugins no longer publish it themselves.
   *
   * ESR-002/RRS-004: the tombstone and the successor's insert are one atomic
   * unit in both layers (`layerSql`: one transaction; `layerMemory`: one
   * `Ref.modify`), so a failed or interrupted issue never leaves a tombstoned
   * session without its successor. Only a still-live row can be superseded:
   * of two concurrent issues naming the same `supersedes`, one inherits its
   * family and the other founds a fresh one.
   */
  readonly issue: (input: {
    readonly userId: UserId;
    readonly request?: { readonly ip?: string; readonly userAgent?: string };
    readonly supersedes?: SessionId;
    /**
     * BEH-EA-209/210: sets a hard expiry (`idleExpiresAt = absoluteExpiresAt`) and disables idle-refresh for this session's whole lifetime.
     * IDS-008: naming the session's own `userId` dies with `InvalidActingAs`. A producer MUST also refuse a caller whose own session already carries `actingAs` (BEH-EA-214) — `issue` cannot see the caller's session; `Admin.impersonate` is the reference implementation.
     */
    readonly actingAs?: ActingAs;
    /**
     * THS-003/APS-007: how the caller just authenticated, set by the
     * authenticating plugin (password `["pwd"]`, OAuth `["fed"]`, passkey
     * `["hwk", "user"]` under user verification). Defaults to none (a legacy
     * bridge, an impersonation session).
     */
    readonly amr?: ReadonlyArray<AuthMethod>;
    /** BEH-EA-212: overrides `SessionConfig.absolute` for this one call — e.g. `@awthaq/admin`'s own `AdminConfig.maxDuration`, generally shorter than an ordinary session's absolute lifetime. */
    readonly absoluteDuration?: Duration.Duration;
  }) => Effect.Effect<
    { readonly session: SessionView; readonly token: Redacted.Redacted<string> },
    StoreUnavailable
  >;
  /**
   * BEH-EA-050/056: hashes the presented secret and compares it to the
   * stored hash in constant time; BEH-EA-052: also performs the
   * throttled-at-most-once-per-`touchEvery` idle refresh this same request
   * is the one to have earned.
   *
   * Upstream-hardening map, ticket 01: the same throttled-touch write also
   * rotates the session's secret (PIL-006: this is not the session-fixation
   * defense — fixation is prevented by minting a fresh session at every
   * sign-in and privilege change, BEH-EA-053; rotation limits the useful life
   * of a leaked secret or a stale hash snapshot) —
   * `rotated` carries the freshly-minted full token exactly when this call
   * performed that rotation, `Option.none()` otherwise (including every
   * `actingAs` session, which never touches this path at all). The old
   * secret's hash is overwritten in the same atomic write and kept aside
   * as the *previous* secret for `SessionConfig.rotationGrace` (RRS-005):
   * inside that window it still verifies for this session, and presenting
   * it re-rotates and delivers a fresh secret in `rotated` — the recovery
   * path for a rotation whose response the client never saw; afterwards it
   * stops verifying. A concurrent second `verify`
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
   * result per request, single-flight and keyed on the request's
   * underlying `source` (TS-003/NHS-006) — both `AuthenticationLive`/
   * `OptionalAuthenticationLive` and `SubjectExtractorLive` funnel through
   * it, so a second call within the same request reuses the first's
   * outcome rather than calling `verify` again. The call that rotated also
   * delivers the new secret on that request's response (PIL-005).
   *
   * RRS-003: presenting a tombstoned row (one `issue`'s own `supersedes`
   * already rotated away) is refresh-token reuse — every still-live
   * session sharing its `familyId` is revoked in the same call, and
   * `AuthEvents.ts`'s `auth.session.reuse` is published (once, on the
   * first such presentation only). The external response stays the
   * uniform `SessionNotFound` either way — no distinguishable signal
   * leaked, matching `Verification.ts`'s own posture.
   */
  readonly verify: (
    token: Redacted.Redacted<string>,
  ) => Effect.Effect<
    { readonly session: SessionView; readonly rotated: Option.Option<Redacted.Redacted<string>> },
    SessionNotFound | SessionExpired | StoreUnavailable
  >;
  /**
   * TIR-008: every revocation primitive takes the `reason` the session ended
   * and publishes exactly one `auth.session.revoked` (`AuditLog` records it)
   * once the delete has happened — so sign-out, account deletion and admin
   * stops are observable, not just the password plugin's bulk revocations.
   */
  readonly revoke: (
    id: SessionId,
    reason: AuthEvents.SessionRevocationReason,
  ) => Effect.Effect<void, SessionNotFound | StoreUnavailable>;
  /**
   * GC-005: revokes session `id` only if it belongs to `userId`, atomically —
   * ownership is enforced by the domain operation, not by a caller-side
   * list-then-check. Fails `SessionNotFound` for an unknown id and a foreign
   * id alike (BEH-EA-086/ADR-EA-013's enumeration safety). Use bare `revoke`
   * only in already-authorized contexts (admin, the caller's own sign-out).
   */
  readonly revokeOwned: (
    userId: UserId,
    id: SessionId,
    reason: AuthEvents.SessionRevocationReason,
  ) => Effect.Effect<void, SessionNotFound | StoreUnavailable>;
  /** BEH-EA-054: revokes every session for `userId` except `keep`. */
  readonly revokeOthers: (
    userId: UserId,
    keep: SessionId,
    reason: AuthEvents.SessionRevocationReason,
  ) => Effect.Effect<void, StoreUnavailable>;
  /** Ticket 02: revokes every session for `userId`, no exceptions — including the caller's own current session. */
  readonly revokeAll: (
    userId: UserId,
    reason: AuthEvents.SessionRevocationReason,
  ) => Effect.Effect<void, StoreUnavailable>;
  /**
   * CSG-003: retention. Physically deletes every session — tombstoned rows
   * included — whose absolute or idle expiry is before `before`, and resolves to
   * how many went. Expiry is otherwise a read-time rejection (the row stays), so
   * this is what bounds the table; `Retention.sweep` calls it with `now - sessionGrace`.
   * Publishes nothing: an expired session was already dead.
   */
  readonly purgeExpired: (before: DateTime.Utc) => Effect.Effect<number, StoreUnavailable>;
  /**
   * BEH-EA-054: exactly the user's *live* sessions — not tombstoned, past
   * neither `absoluteExpiresAt` nor `idleExpiresAt` — newest activity first
   * (`lastActiveAt` descending), identically in both layers (ESS-005/
   * SMS-002). `current` is set on whichever row's id equals `current`.
   * Exhaustive: `layerSql` drains every repository page rather than silently
   * truncating (TIR-003), bounded by `LIST_LIMIT` with a logged warning if a
   * user somehow exceeds it. Not for keyed lookups — use `findOwned`.
   *
   * RRC-001: `options.consistency: "eventual"` lets a configured read replica
   * serve the listing (`layerSql` only); the default is the primary. Pass it
   * for a display-only device list, never for a liveness decision.
   */
  readonly list: (
    userId: UserId,
    current?: SessionId,
    options?: Store.ReadOptions,
  ) => Effect.Effect<ReadonlyArray<SessionListItem>, StoreUnavailable>;
  /**
   * TIR-003/ESS-005: the keyed ownership lookup every point query goes
   * through — one `findById` plus ownership, tombstone and expiry checks,
   * never `list`'s per-user scan. `None` for an unknown id, another user's
   * session, a tombstoned row, or one past either expiry. `current` on the
   * returned item is always `false`: the caller already knows which id it
   * asked about.
   */
  readonly findOwned: (
    userId: UserId,
    id: SessionId,
  ) => Effect.Effect<Option.Option<SessionListItem>, StoreUnavailable>;
  /**
   * TIR-002/FAMS-009/MAPS-006: the exact liveness check a caller holding
   * only a bare `id` (no secret — `verify`'s own credential) needs — e.g.
   * `@awthaq/jwt`'s `verifyLive`/`introspectLive`, checking whether a
   * JWT's `sid` still names a live session. Applies `verify`'s own full
   * expiry logic (both `absoluteExpiresAt` and `idleExpiresAt`, not just
   * the single deadline `SessionListItem.expiresAt` exposes) and treats a
   * tombstoned (RRS-003) row as not live — without `verify`'s secret
   * check, throttled touch, or rotation, since this never claims to
   * authenticate the caller, only to answer "is this session still live."
   * `false` for a session belonging to a different `userId` than claimed,
   * already tombstoned, past either expiry, or simply absent — a single
   * keyed lookup (`findOwned`), not `list`'s full per-user scan.
   */
  readonly isLive: (userId: UserId, id: SessionId) => Effect.Effect<boolean, StoreUnavailable>;
  /**
   * Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 15
   * (AAPS-001/BPAS-001): sets `authenticatedAt = now` only — deliberately a
   * different write path from `verify`'s own throttled touch/rotation (does
   * not rotate the secret/id, does not touch `idleExpiresAt`/
   * `absoluteExpiresAt`). Reauthentication is an explicit, credential-
   * proving event a caller invokes directly (e.g.
   * `@awthaq/password`/`@awthaq/passkey`'s own `reauthenticate` endpoints),
   * not a passive idle refresh, so it gets its own always-available method.
   *
   * BEH-EA-319: advances only a live session owned by `userId` (the same
   * rule as `findOwned`); a tombstoned, expired, foreign or absent row is
   * `SessionNotFound` and is left untouched.
   */
  readonly reauthenticate: (
    userId: UserId,
    id: SessionId,
    /** THS-003: methods this step-up just proved; unioned into the session's `amr` (monotone — never removed). */
    amr?: ReadonlyArray<AuthMethod>,
  ) => Effect.Effect<SessionView, SessionNotFound | StoreUnavailable>;
  /**
   * BEH-EA-320: the one "fresh session" gate. Succeeds with the session when it is live,
   * owned by `userId` and proved a credential (`authenticatedAt`) within `maxAge` (a session
   * exactly `maxAge` old is still fresh); otherwise fails `SessionStale` with the window and a
   * `reason`. Built once from `findOwned`, so both layers share the liveness rule and a test
   * double has a single member to stub.
   */
  readonly requireFresh: (
    userId: UserId,
    id: SessionId,
    maxAge: Duration.Duration,
  ) => Effect.Effect<SessionListItem, SessionStale | StoreUnavailable>;
}

export class Sessions extends Context.Service<Sessions, SessionsShape>()("awthaq/core/Sessions") {}

/** BEH-EA-320: the single `requireFresh`, shared by both layers because it is built on their `findOwned`. */
const requireFreshVia =
  (findOwned: SessionsShape["findOwned"]) =>
  (userId: UserId, id: SessionId, maxAge: Duration.Duration) =>
    Effect.gen(function* () {
      const maxAgeSeconds = Duration.toSeconds(maxAge);
      const current = yield* findOwned(userId, id);
      if (Option.isNone(current)) {
        return yield* new SessionStale({ maxAgeSeconds, reason: "notLive" });
      }
      const now = yield* DateTime.now;
      if (isStale(current.value.authenticatedAt, maxAgeSeconds, now)) {
        return yield* new SessionStale({ maxAgeSeconds, reason: "stale" });
      }
      return current.value;
    });

/** ESS-005: newest activity first, ties broken by id so both layers order identically. */
const newestActivityFirst = (
  items: ReadonlyArray<SessionListItem>,
): ReadonlyArray<SessionListItem> =>
  [...items].sort(
    (a, b) =>
      DateTime.toEpochMillis(b.lastActiveAt) - DateTime.toEpochMillis(a.lastActiveAt) ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );

/**
 * Upper bound on how many live sessions `list` drains for one user — far past
 * any realistic device list; a logged warning (never silent truncation) if a
 * user somehow exceeds it.
 */
export const LIST_LIMIT = 1000;

/** ESA-006: the one `auth.session.issued` both layers publish. */
const publishIssued = (
  events: AuthEvents.AuthEventsShape,
  session: { readonly id: SessionId; readonly userId: UserId },
  familyId: string,
  actingAs: Option.Option<ActingAs>,
) =>
  events.publish({
    _tag: "auth.session.issued",
    sessionId: session.id,
    userId: session.userId,
    familyId,
    ...(Option.isSome(actingAs) ? { actingAs: actingAs.value } : {}),
  });

/**
 * ticket 27 §2 (MW-001): `awthaq.session.issue`, annotated with the new session's
 * id — the public half of the token, approved for spans; never the secret half.
 */
const traceIssue =
  (issue: SessionsShape["issue"]): SessionsShape["issue"] =>
  (input) =>
    issue(input).pipe(
      Effect.tap(({ session }) =>
        Effect.annotateCurrentSpan(Observability.Field.sessionId, session.id),
      ),
      Effect.withSpan(Observability.Span.sessionIssue),
    );

/**
 * ticket 27 §2/§4 (MW-001): `awthaq.session.verify`, its latency histogram and
 * `awthaq_session_verify_failed_total{reason}` (`not-found` or `expired`). The
 * span carries the id half of the presented token when it has one — never the
 * secret half, never the whole token.
 */
const traceVerify =
  (verify: SessionsShape["verify"]): SessionsShape["verify"] =>
  (token) => {
    const raw = Redacted.value(token);
    const separator = raw.indexOf(".");
    // A presented id is attacker-controlled: only an id-shaped, bounded one reaches a span.
    const presentedId = separator > 0 ? raw.slice(0, separator) : "";
    const announce = /^[A-Za-z0-9-]{1,64}$/.test(presentedId)
      ? Effect.annotateCurrentSpan(Observability.Field.sessionId, presentedId)
      : Effect.void;
    return Observability.observeSessionVerify(
      (error: SessionNotFound | SessionExpired | StoreUnavailable) =>
        error._tag === "SessionExpired"
          ? "expired"
          : error._tag === "Sessions/NotFound"
            ? "not-found"
            : "unavailable",
    )(Effect.andThen(announce, verify(token)));
  };

// RSC-001: an explicit object, never the stored record by identity: a bare identity return type-checks
// (a variable reference is exempt from excess-property checks) while still carrying
// `secretHash`/`familyId`/`supersededBy`/`supersededAt`/`reusedAt` at runtime, contradicting
// `SessionView`'s own doc comment ("never the secret, never the stored hash"). One careless prop pass of
// a `SessionView` to a Client Component (e.g. `@awthaq/next`'s `getSession`) would otherwise serialize
// the stored hash into the RSC flight payload.
const toView = (row: SessionStore.SessionRecord): SessionView => ({
  id: SessionId(row.id),
  userId: UserId(row.userId),
  createdAt: row.createdAt,
  authenticatedAt: row.authenticatedAt,
  lastActiveAt: row.lastActiveAt,
  absoluteExpiresAt: row.absoluteExpiresAt,
  idleExpiresAt: row.idleExpiresAt,
  ipAddress: row.ipAddress,
  userAgent: row.userAgent,
  actingAs: row.actingAs,
  amr: row.amr.filter(isAuthMethod),
  tenantId: row.tenantId,
});

const toItem = (
  row: SessionStore.SessionRecord,
  current: SessionId | undefined,
): SessionListItem => ({
  id: SessionId(row.id),
  createdAt: row.createdAt,
  authenticatedAt: row.authenticatedAt,
  lastActiveAt: row.lastActiveAt,
  expiresAt: row.absoluteExpiresAt,
  userAgent: row.userAgent,
  amr: row.amr.filter(isAuthMethod),
  current: row.id === current,
});

const notFound = (id?: SessionId) =>
  new SessionNotFound({
    message: id === undefined ? "awthaq: malformed session token" : "awthaq: no such session",
    ...(id === undefined ? {} : { id }),
  });

/**
 * Written once over `SessionStore` (ADR-EA-041). Needs the store, `Crypto` (the id, the secret and its
 * hash) and `AuthEvents`; the legacy bridge is a `Context.Reference` with a default. The clock is read
 * once per operation and handed to the store, so a row never carries two instants.
 */
export const layer = Layer.effect(
  Sessions,
  Effect.gen(function* () {
    const store = yield* SessionStore.SessionStore;
    const crypto = yield* Crypto.Crypto;
    // EP-007 (ADR-EA-018 Decision 8): lifetimes are decided per operation: a tenant's `SessionConfig`
    // provided in the calling fiber wins; with none, the build-time value applies.
    const builtConfig = yield* SessionConfig;
    const configNow = Tenant.configInForce(SessionConfig, builtConfig);
    const events = yield* AuthEvents.AuthEvents;
    const bridge = yield* LegacySessionBridge.LegacySessionBridge;

    const issue: SessionsShape["issue"] = Effect.fnUntraced(
      function* (input) {
        const config = yield* configNow;
        yield* refuseSelfActingAs(input);
        const id = SessionId(yield* crypto.randomUUIDv7);
        const secret = toHex(yield* crypto.randomBytes(32));
        const secretHash = yield* hashSecret(crypto, secret);
        const now = yield* DateTime.now;
        const absoluteExpiresAt = DateTime.addDuration(
          now,
          input.absoluteDuration ?? config.absolute,
        );
        // BEH-EA-210: a session minted with `actingAs` gets a hard expiry: `idleExpiresAt` set equal to
        // `absoluteExpiresAt` at issuance, never pushed further out by `verify`'s idle-refresh touch.
        const idleExpiresAt =
          input.actingAs === undefined
            ? DateTime.min(DateTime.addDuration(now, config.idle), absoluteExpiresAt)
            : absoluteExpiresAt;
        // ESR-002/RRS-004: tombstoning the superseded row and inserting its successor are ONE store
        // primitive, so no interruption or failure can leave a tombstoned session without its successor
        // (whose next presentation would read as refresh-token reuse: a false theft alarm and a family
        // revocation). SMS-003: the cap is enforced in that same step. Impersonation (`actingAs`)
        // sessions neither count toward nor trigger it.
        const { inserted, superseded, evicted } = yield* store.insert({
          session: {
            id,
            userId: input.userId,
            secretHash,
            at: now,
            absoluteExpiresAt,
            idleExpiresAt,
            ipAddress: Option.fromNullishOr(input.request?.ip),
            userAgent: Option.fromNullishOr(cappedUserAgent(input.request?.userAgent)),
            actingAs: Option.fromNullishOr(input.actingAs),
            amr: input.amr ?? [],
          },
          supersedes: Option.fromNullishOr(input.supersedes),
          maxLive:
            input.actingAs === undefined
              ? Option.map(Option.fromNullishOr(config.maxConcurrent), (policy) => policy.limit)
              : Option.none(),
        });
        // RRS-008: the rotation's own event, published from `Sessions` so every strategy's `supersedes`
        // is covered, only when a live ancestor of the same user was tombstoned.
        if (Option.isSome(superseded)) {
          yield* events.publish({
            _tag: "auth.session.superseded",
            sessionId: superseded.value.id,
            supersededBy: id,
            familyId: superseded.value.familyId,
            userId: superseded.value.userId,
          });
        }
        for (const gone of evicted) {
          yield* events.publish({
            _tag: "auth.session.revoked",
            userId: input.userId,
            sessionId: gone,
            scope: "one",
            reason: "limitEvicted",
          });
        }
        const view = toView(inserted);
        yield* publishIssued(events, view, inserted.familyId, view.actingAs);
        return { session: view, token: Redacted.make(`${id}.${secret}`) };
      },
      Effect.catchTag("PlatformError", storeUnavailable("Sessions.issue")),
      relabel("Sessions.issue"),
    );

    /**
     * BAM-003 (.issues/high): consulted only on a primary-store miss: a still-live legacy (e.g.
     * better-auth) session's own opaque token structurally cannot parse as `id.secret`, so it never
     * reaches `issue`'s own credential path at all. A `resolve` hit is minted through this same `issue`
     * (fresh id/secret/hashes, the bridge's own `userId`/`ipAddress`/`userAgent`), then `consume`d so the
     * legacy credential is single-use: modeled as "rotated from nothing valid to a fresh session",
     * reusing `verify`'s existing `rotated` channel rather than widening its return type.
     */
    const bridgeLegacySession = Effect.fnUntraced(function* (rawToken: string) {
      const resolved = yield* bridge.resolve(rawToken);
      if (Option.isNone(resolved)) return Option.none();
      const legacy = resolved.value;
      const minted = yield* issue({
        userId: UserId(legacy.userId),
        request: {
          ...(Option.isSome(legacy.ipAddress) ? { ip: legacy.ipAddress.value } : {}),
          ...(Option.isSome(legacy.userAgent) ? { userAgent: legacy.userAgent.value } : {}),
        },
      });
      yield* bridge.consume(rawToken);
      return Option.some({ session: minted.session, rotated: Option.some(minted.token) });
    });

    const verify: SessionsShape["verify"] = Effect.fnUntraced(
      function* (token) {
        const config = yield* configNow;
        const raw = Redacted.value(token);
        const separator = raw.indexOf(".");
        if (separator < 0) {
          const bridged = yield* bridgeLegacySession(raw);
          if (Option.isSome(bridged)) return bridged.value;
          return yield* notFound();
        }
        const id = SessionId(raw.slice(0, separator));
        const secret = raw.slice(separator + 1);
        // PIL-007: the id is the public half of the token (cookies, JWT `sid`, error messages): the
        // secret is proven before ANY row-state branch (tombstone/reuse, expiry), so an id-only caller
        // can neither trigger reuse-detection side effects nor learn a row's state.
        const presentedHash = yield* hashSecret(crypto, secret);
        const found = yield* store.get(id);
        if (Option.isNone(found)) {
          secretMatches(presentedHash, UNKNOWN_SESSION_HASH);
          const bridged = yield* bridgeLegacySession(raw);
          if (Option.isSome(bridged)) return bridged.value;
          return yield* notFound(id);
        }
        const row = found.value;
        const now = yield* DateTime.now;
        const matched = matchedSecret(
          now,
          presentedHash,
          row.secretHash,
          Option.getOrUndefined(row.previousSecretHash),
          Option.getOrUndefined(row.previousSecretExpiresAt),
        );
        if (matched === "none") return yield* notFound(id);
        // RRS-003: a tombstoned row is a presented-already-rotated token: reuse. Reached only with the
        // correct (old) secret (PIL-007), and checked before expiry: a rotated-away row's own expiry
        // timestamps are stale and not the interesting signal here. The external response stays the
        // uniform `SessionNotFound` whether this is the first reuse or a later presentation of an
        // already-flagged row: no distinguishable signal leaked.
        if (Option.isSome(row.supersededAt)) {
          // RRS-005: only the row's *current* secret can be reuse: a previous secret inside its grace
          // window is a stale-but-legitimate holder, never a family-revoking signal.
          if (matched === "current" && Option.isNone(row.reusedAt)) {
            // "Published once": the store flags the row and revokes the family in one atomic step and
            // answers `Some` to exactly one of any number of racing presentations.
            const flagged = yield* store.flagReuse(id, now);
            if (Option.isSome(flagged)) {
              yield* events.publish({
                _tag: "auth.session.reuse",
                sessionId: id,
                familyId: flagged.value.familyId,
                userId: flagged.value.userId,
              });
              yield* events.publish({
                _tag: "auth.session.revoked",
                userId: flagged.value.userId,
                sessionId: null,
                scope: "family",
                reason: "reuseDetected",
              });
            }
          }
          return yield* notFound(id);
        }
        if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.absoluteExpiresAt)) {
          yield* events.publish({
            _tag: "auth.session.expired",
            sessionId: id,
            userId: row.userId,
            kind: "absolute",
          });
          return yield* new SessionExpired({ message: "awthaq: session expired", id });
        }
        if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.idleExpiresAt)) {
          yield* events.publish({
            _tag: "auth.session.expired",
            sessionId: id,
            userId: row.userId,
            kind: "idle",
          });
          return yield* new SessionExpired({ message: "awthaq: session idle-expired", id });
        }
        // BEH-EA-210: a session carrying `actingAs` never idle-refreshes: its hard expiry is the whole
        // mechanism, so `verify` never touches it.
        if (Option.isSome(row.actingAs)) {
          return { session: toView(row), rotated: Option.none() };
        }
        // BEH-EA-052: throttled idle refresh: at most one write per `touchEvery`.
        const dueForTouch =
          DateTime.toEpochMillis(now) >=
          DateTime.toEpochMillis(DateTime.addDuration(row.lastActiveAt, config.touchEvery));
        // RRS-005: a previous secret presented in its grace window always re-rotates, so the holder that
        // missed the last delivery is handed a durable credential.
        if (!dueForTouch && matched === "current") {
          return { session: toView(row), rotated: Option.none() };
        }
        const grace = graceOf(config);
        const keepPrevious = Duration.toMillis(grace) > 0;
        // Ticket 01: the same throttled write also rotates the secret, compare-and-swapped against the
        // hash this call just read, so a losing concurrent request never clobbers a winner's write with
        // its own independently-generated secret. Losing the race isn't a failure: this call simply
        // reports no rotation of its own, over whatever the winner's write left behind, re-checked for
        // liveness (a row tombstoned or expired in the meantime is not authenticated).
        const newSecret = toHex(yield* crypto.randomBytes(32));
        const newSecretHash = yield* hashSecret(crypto, newSecret);
        const outcome = yield* store.rotate({
          id,
          expectedSecretHash: row.secretHash,
          secretHash: newSecretHash,
          previous: keepPrevious
            ? Option.some({ hash: row.secretHash, expiresAt: DateTime.addDuration(now, grace) })
            : Option.none(),
          lastActiveAt: now,
          idleExpiresAt: DateTime.min(
            DateTime.addDuration(now, config.idle),
            row.absoluteExpiresAt,
          ),
        });
        if (outcome._tag === "Lost") {
          if (Option.isNone(outcome.current) || Option.isSome(outcome.current.value.supersededAt)) {
            return yield* notFound(id);
          }
          if (!SessionStore.isLive(outcome.current.value, now)) {
            return yield* new SessionExpired({ message: "awthaq: session expired", id });
          }
          return { session: toView(outcome.current.value), rotated: Option.none() };
        }
        // RRS-008: only the call that won the rotation announces it.
        yield* events.publish({
          _tag: "auth.session.rotated",
          sessionId: id,
          familyId: outcome.session.familyId,
          userId: outcome.session.userId,
          ...(matched === "previous" ? { viaGrace: true } : {}),
        });
        return {
          session: toView(outcome.session),
          rotated: Option.some(Redacted.make(`${id}.${newSecret}`)),
        };
      },
      Effect.catchTag("PlatformError", storeUnavailable("Sessions.verify")),
      relabel("Sessions.verify"),
    );

    // TIR-008: every revocation primitive is one store call that answers what it removed, and publishes
    // exactly one `auth.session.revoked` for the call, after the delete.
    const revoke: SessionsShape["revoke"] = Effect.fnUntraced(function* (id, reason) {
      const removed = yield* store.remove(id, Option.none());
      if (Option.isNone(removed)) return yield* notFound(id);
      yield* events.publish({
        _tag: "auth.session.revoked",
        userId: removed.value,
        sessionId: id,
        scope: "one",
        reason,
      });
    }, relabel("Sessions.revoke"));

    // GC-005: ownership is part of the store primitive; an unknown and a foreign id answer alike.
    const revokeOwned: SessionsShape["revokeOwned"] = Effect.fnUntraced(function* (
      userId,
      id,
      reason,
    ) {
      const removed = yield* store.remove(id, Option.some(userId));
      if (Option.isNone(removed)) return yield* notFound(id);
      yield* events.publish({
        _tag: "auth.session.revoked",
        userId,
        sessionId: id,
        scope: "one",
        reason,
      });
    }, relabel("Sessions.revokeOwned"));

    const revokeOthers: SessionsShape["revokeOthers"] = Effect.fnUntraced(function* (
      userId,
      keep,
      reason,
    ) {
      yield* store.removeForUser(userId, Option.some(keep));
      yield* events.publish({
        _tag: "auth.session.revoked",
        userId,
        sessionId: null,
        scope: "others",
        reason,
      });
    }, relabel("Sessions.revokeOthers"));

    const revokeAll: SessionsShape["revokeAll"] = Effect.fnUntraced(function* (userId, reason) {
      yield* store.removeForUser(userId, Option.none());
      yield* events.publish({
        _tag: "auth.session.revoked",
        userId,
        sessionId: null,
        scope: "all",
        reason,
      });
    }, relabel("Sessions.revokeAll"));

    const purgeExpired: SessionsShape["purgeExpired"] = (before) =>
      store.purgeExpired(before).pipe(relabel("Sessions.purgeExpired"));

    // RRS-003/SMS-002: `isLive` is load-bearing, not cosmetic. A tombstoned or expired row must never
    // appear in a user's device list (and is what makes `verifyLive`/`Jwt.introspectLive` reject a
    // reused/family-revoked session's JWT: they call `isLive`). TIR-003: the listing is exhaustive up to
    // `LIST_LIMIT`, with a logged warning (never silent truncation) past it.
    const list: SessionsShape["list"] = Effect.fnUntraced(function* (userId, current, options) {
      const now = yield* DateTime.now;
      const listing = yield* store.listLive({
        userId,
        now,
        limit: LIST_LIMIT,
        consistency: options?.consistency ?? "authoritative",
      });
      if (listing.truncated) {
        yield* Effect.logWarning(
          `awthaq: Sessions.list stopped at ${LIST_LIMIT} live sessions for user ${userId}`,
        );
      }
      return newestActivityFirst(listing.items.map((row) => toItem(row, current)));
    }, relabel("Sessions.list"));

    const findOwned: SessionsShape["findOwned"] = Effect.fnUntraced(function* (userId, id) {
      const row = yield* store.get(id);
      const now = yield* DateTime.now;
      return Option.filter(row, (r) => r.userId === userId && SessionStore.isLive(r, now)).pipe(
        Option.map((r) => toItem(r, undefined)),
      );
    }, relabel("Sessions.findOwned"));

    const isLive: SessionsShape["isLive"] = (userId, id) =>
      findOwned(userId, id).pipe(Effect.map(Option.isSome));

    // BEH-EA-319: advances only a live session owned by `userId`; the store applies ownership and
    // liveness inside the same atomic step as the write, and unions the methods into `amr` (THS-003).
    const reauthenticate: SessionsShape["reauthenticate"] = Effect.fnUntraced(function* (
      userId,
      id,
      amr,
    ) {
      const now = yield* DateTime.now;
      const updated = yield* store.reauthenticate({
        id,
        owner: userId,
        at: now,
        addAmr: amr ?? [],
      });
      if (Option.isNone(updated)) return yield* notFound(id);
      return toView(updated.value);
    }, relabel("Sessions.reauthenticate"));

    return {
      issue: traceIssue(issue),
      verify: traceVerify(verify),
      revoke,
      revokeOwned,
      revokeOthers,
      revokeAll,
      purgeExpired,
      list,
      findOwned,
      isLive,
      reauthenticate,
      requireFresh: requireFreshVia(findOwned),
    };
  }),
);

// ---- transitional aliases (removed in phase 7) -----------------------------------

/**
 * TRBS-005: single-process, test-grade storage. It is not shared across instances (a revocation on one
 * instance does not propagate to another), it is lost on restart, and it grows without bound until a
 * retention sweep (CSG-003) prunes it. Use `layerSql` (or a `SessionStore` over a KV store, ADR-EA-014)
 * for any multi-instance deployment.
 */
export const layerMemory = layer.pipe(Layer.provide(SessionStore.layerMemory));

// The annotation is the TS2883 exception (declaration emit cannot name the repository through the
// adapter's inferred layer type); this alias is removed with `layerMemory` in phase 7.
export const layerSql: Layer.Layer<
  Sessions,
  never,
  SqlRepositories.SessionsRepository | SqlClient.SqlClient | Crypto.Crypto | AuthEvents.AuthEvents
> = layer.pipe(Layer.provide(SessionStoreSql.layer));
