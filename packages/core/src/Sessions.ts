// @awthaq/core — Sessions
//
// spec/behaviors/07-sessions.md, BEH-EA-049 through BEH-EA-056.
// Two `Layer`s over the same `SessionsShape`: `layerMemory` (a `Ref`) and
// `layerSql` (`@awthaq/sql`'s `Model.Class`/repository, BEH-EA-033–036)
// — neither changes this service's public interface, the same deferral
// `Migrations.ts` documents for the persistence stratum generally.

import { Api } from "@awthaq/api";
import { Hmac, LegacySessionBridge } from "@awthaq/ports";
import {
  Models as SqlModels,
  ReadRouting as SqlReadRouting,
  Repositories as SqlRepositories,
} from "@awthaq/sql";
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
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Model from "effect/unstable/schema/Model";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as AuthEvents from "./AuthEvents.ts";
import {
  orStoreUnavailable,
  retryTransient,
  storeUnavailable,
  type StoreUnavailable,
} from "./Errors.ts";
import * as Observability from "./Observability.ts";
import * as SecretHash from "./SecretHash.ts";
import { pruneExpiredAbove } from "./internal/pruneExpired.ts";
import { drainBatches } from "./internal/purgeBatches.ts";
import * as Tenant from "./Tenant.ts";
import { UserId } from "./Users.ts";

/**
 * BEH-EA-049: the public half of a session's `id.secret` token. INV-EA-018: an id is an identifier, never a capability — it appears in cookies, JWT `sid` claims and error messages, so nothing may act on it without the secret's proof (PIL-007).
 */
// MA-008: the brand is declared once, in `@awthaq/sql`; this keeps only a nominal constructor.
export type SessionId = SqlModels.SessionId;
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
  /** SMS-003: opt-in concurrent-session cap; absent = uncapped (the default). */
  readonly maxConcurrent?: ConcurrentSessionPolicy;
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

/** Order-preserving union — `amr` only ever grows within a session. */
export const unionAmr = (
  existing: ReadonlyArray<AuthMethod>,
  additions: ReadonlyArray<AuthMethod>,
): ReadonlyArray<AuthMethod> => [
  ...existing,
  ...additions.filter(
    (method, index) => !existing.includes(method) && additions.indexOf(method) === index,
  ),
];

/** Decodes the stored JSON text, dropping anything that is not a known method. */
const parseAmr = (text: string): ReadonlyArray<AuthMethod> => {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter(isAuthMethod) : [];
  } catch {
    return [];
  }
};

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
 * Ticket 15: the one staleness comparison a step-up/reauth check needs —
 * factored out here so `@awthaq/qadi`'s `reauthHandler` and
 * `@awthaq/passkey`'s own enrollment gate both compare `authenticatedAt`
 * the same way, rather than each re-deriving the
 * `DateTime.distance`/`Duration.isGreaterThan` pair independently.
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
    options?: SqlReadRouting.ReadOptions,
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
   */
  readonly reauthenticate: (
    id: SessionId,
    /** THS-003: methods this step-up just proved; unioned into the session's `amr` (monotone — never removed). */
    amr?: ReadonlyArray<AuthMethod>,
  ) => Effect.Effect<SessionView, SessionNotFound | StoreUnavailable>;
}

export class Sessions extends Context.Service<Sessions, SessionsShape>()("awthaq/core/Sessions") {}

/**
 * TIR-003/SMS-002: the one liveness predicate — the same absolute and idle
 * checks `verify` applies (modulo the secret), a tombstoned (RRS-003) row
 * being not live. `list`, `findOwned` and `isLive` share it so the layers
 * and the operations cannot drift.
 */
const isLiveAt = (
  now: DateTime.Utc,
  row: {
    readonly absoluteExpiresAt: DateTime.Utc;
    readonly idleExpiresAt: DateTime.Utc;
    readonly supersededAt: Option.Option<DateTime.Utc>;
  },
): boolean =>
  Option.isNone(row.supersededAt) &&
  DateTime.toEpochMillis(now) < DateTime.toEpochMillis(row.absoluteExpiresAt) &&
  DateTime.toEpochMillis(now) < DateTime.toEpochMillis(row.idleExpiresAt);

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

/**
 * SMS-003: which of a user's existing live, non-impersonation sessions the
 * about-to-be-issued one evicts — the least-recently-active surplus so that
 * (existing - evicted) + 1 <= limit. Pure, shared by both layers.
 */
const evictionOrder = (
  limit: number,
  existing: ReadonlyArray<{ readonly id: string; readonly lastActiveAt: DateTime.Utc }>,
): ReadonlyArray<string> => {
  const surplus = existing.length + 1 - Math.max(1, limit);
  if (surplus <= 0) return [];
  return [...existing]
    .sort(
      (a, b) =>
        DateTime.toEpochMillis(a.lastActiveAt) - DateTime.toEpochMillis(b.lastActiveAt) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .slice(0, surplus)
    .map((row) => row.id);
};

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

interface SessionRow {
  readonly id: SessionId;
  readonly userId: UserId;
  readonly secretHash: string;
  readonly createdAt: DateTime.Utc;
  readonly authenticatedAt: DateTime.Utc;
  readonly lastActiveAt: DateTime.Utc;
  readonly absoluteExpiresAt: DateTime.Utc;
  readonly idleExpiresAt: DateTime.Utc;
  readonly ipAddress: Option.Option<string>;
  readonly userAgent: Option.Option<string>;
  readonly actingAs: Option.Option<ActingAs>;
  readonly amr: ReadonlyArray<AuthMethod>;
  readonly tenantId: Option.Option<string>;
  /**
   * RRS-003: this row's founding session id — its own `id` when it has no
   * ancestor, inherited from the superseded row's own `familyId`
   * otherwise. `revokeFamily`'s own walk key.
   */
  readonly familyId: SessionId;
  /** Set at most once, when this row is superseded by a rotation — never at issue. */
  readonly supersededBy: Option.Option<SessionId>;
  readonly supersededAt: Option.Option<DateTime.Utc>;
  /** Set at most once — the first time a tombstoned row is presented again. */
  readonly reusedAt: Option.Option<DateTime.Utc>;
}

// RSC-001: an explicit object, not `row` by identity — a bare identity
// return type-checks (a variable reference is exempt from excess-property
// checks) while still carrying `secretHash`/`familyId`/`supersededBy`/
// `supersededAt`/`reusedAt` at runtime, contradicting `SessionView`'s own
// doc comment ("never the secret, never the stored hash"). One careless
// prop pass of a `SessionView` to a Client Component (e.g. `@awthaq/next`'s
// `getSession`) would otherwise serialize the stored hash into the RSC
// flight payload. Mirrors `toSessionView`'s own explicit-construction
// pattern below, which the SQL layer already gets right.
const toView = (row: SessionRow): SessionView => ({
  id: row.id,
  userId: row.userId,
  createdAt: row.createdAt,
  authenticatedAt: row.authenticatedAt,
  lastActiveAt: row.lastActiveAt,
  absoluteExpiresAt: row.absoluteExpiresAt,
  idleExpiresAt: row.idleExpiresAt,
  ipAddress: row.ipAddress,
  userAgent: row.userAgent,
  actingAs: row.actingAs,
  amr: row.amr,
  tenantId: row.tenantId,
});

/**
 * TRBS-005: single-process, test-grade storage. State is one per-process
 * `Ref`: it is not shared across instances (a revocation on one instance does
 * not propagate to another), it is lost on restart, and it grows without bound
 * until a retention sweep (CSG-003) prunes it. Use `layerSql` (or a future KV
 * layer, ADR-EA-014) for any multi-instance deployment. `AuthEvents`' in-process
 * `PubSub` has the same process boundary.
 */
export const layerMemory: Layer.Layer<Sessions, never, Crypto.Crypto | AuthEvents.AuthEvents> =
  Layer.effect(
    Sessions,
    Effect.gen(function* () {
      const state = yield* Ref.make(HashMap.empty<SessionId, SessionRow>());
      const crypto = yield* Crypto.Crypto;
      // EP-007 (ADR-EA-018 Decision 8): lifetimes are decided per operation — a tenant's
      // `SessionConfig` provided in the calling fiber wins; with none, the build-time value applies.
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
          const tenantId = yield* Tenant.TenantContext;
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
          // ESR-002/RRS-004: tombstoning the superseded row and inserting its
          // successor are ONE `Ref.modify`, so no interruption or failure can
          // leave a tombstoned session without its successor (whose next
          // presentation would read as refresh-token reuse — a false theft
          // alarm and a family revocation). RRS-003: tombstoned, not deleted —
          // the ancestor's own `familyId` is what this row inherits; a row with
          // no live `supersedes` ancestor founds a fresh family, `familyId = id`.
          const { row, evicted, superseded } = yield* Ref.modify(
            state,
            (
              s,
            ): readonly [
              {
                readonly row: SessionRow;
                readonly evicted: ReadonlyArray<SessionRow>;
                readonly superseded: Option.Option<SessionRow>;
              },
              HashMap.HashMap<SessionId, SessionRow>,
            ] => {
              // TMS-004: rows are otherwise removed only on revoke; prune
              // expired ones once the map is large, in the same atomic step.
              const pruned = pruneExpiredAbove(s, now, (r) => r.absoluteExpiresAt);
              const ancestor =
                input.supersedes === undefined
                  ? Option.none()
                  : Option.filter(HashMap.get(pruned, input.supersedes), (r) =>
                      Option.isNone(r.supersededAt),
                    );
              const created: SessionRow = {
                id,
                userId: input.userId,
                secretHash,
                createdAt: now,
                authenticatedAt: now,
                lastActiveAt: now,
                absoluteExpiresAt,
                idleExpiresAt,
                ipAddress: Option.fromNullishOr(input.request?.ip),
                userAgent: Option.fromNullishOr(cappedUserAgent(input.request?.userAgent)),
                actingAs: Option.fromNullishOr(input.actingAs),
                amr: input.amr ?? [],
                tenantId,
                familyId: Option.match(ancestor, {
                  onNone: () => id,
                  onSome: (r) => r.familyId,
                }),
                supersededBy: Option.none(),
                supersededAt: Option.none(),
                reusedAt: Option.none(),
              };
              const withAncestor = Option.match(ancestor, {
                onNone: () => pruned,
                onSome: (r) =>
                  HashMap.set(pruned, r.id, {
                    ...r,
                    supersededBy: Option.some(id),
                    supersededAt: Option.some(now),
                  }),
              });
              // SMS-003: the cap is enforced in this same modify — count the
              // user's other live, non-impersonation sessions and drop the
              // least-recently-active surplus alongside the insert.
              const policy = input.actingAs === undefined ? config.maxConcurrent : undefined;
              const existing =
                policy === undefined
                  ? []
                  : Array.from(HashMap.values(withAncestor)).filter(
                      (r) =>
                        r.userId === input.userId && isLiveAt(now, r) && Option.isNone(r.actingAs),
                    );
              const evictedIds = new Set<string>(
                policy === undefined ? [] : evictionOrder(policy.limit, existing),
              );
              const evictedRows = existing.filter((r) => evictedIds.has(r.id));
              const kept = HashMap.filter(withAncestor, (r) => !evictedIds.has(r.id));
              return [
                { row: created, evicted: evictedRows, superseded: ancestor },
                HashMap.set(kept, id, created),
              ] as const;
            },
          );
          // RRS-008: the rotation's own event, published from `Sessions` so every
          // strategy's `supersedes` is covered, only when a live ancestor was tombstoned.
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
              userId: gone.userId,
              sessionId: gone.id,
              scope: "one",
              reason: "limitEvicted",
            });
          }
          yield* publishIssued(events, row, row.familyId, row.actingAs);
          return { session: toView(row), token: Redacted.make(`${id}.${secret}`) };
        },
        Effect.catchTag("PlatformError", storeUnavailable("Sessions.issue")),
      );

      /**
       * BAM-003 (.issues/high): consulted only on a primary-store miss — a
       * still-live legacy (e.g. better-auth) session's own opaque token
       * structurally cannot parse as `id.secret`, so it never reaches
       * `issue`'s own credential path at all. A `resolve` hit is minted
       * through this same `issue` (fresh id/secret/hashes, the bridge's own
       * `userId`/`ipAddress`/`userAgent`), then `consume`d so the legacy
       * credential is single-use — modeled as "rotated from nothing valid
       * to a fresh session," reusing `verify`'s existing `rotated` channel
       * rather than widening its return type.
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
            return yield* Effect.fail(
              new SessionNotFound({ message: "awthaq: malformed session token" }),
            );
          }
          const id = SessionId(raw.slice(0, separator));
          const secret = raw.slice(separator + 1);
          // PIL-007: the id is the public half of the token (cookies, JWT
          // `sid`, error messages) — the secret is proven before ANY row-state
          // branch (tombstone/reuse, expiry) so an id-only caller can neither
          // trigger reuse-detection side effects nor learn a row's state.
          const presentedHash = yield* hashSecret(crypto, secret);
          const row = yield* Ref.get(state).pipe(Effect.map((s) => HashMap.get(s, id)));
          if (Option.isNone(row)) {
            secretMatches(presentedHash, UNKNOWN_SESSION_HASH);
            const bridged = yield* bridgeLegacySession(raw);
            if (Option.isSome(bridged)) return bridged.value;
            return yield* Effect.fail(
              new SessionNotFound({ message: "awthaq: no such session", id }),
            );
          }
          if (!secretMatches(presentedHash, row.value.secretHash)) {
            return yield* Effect.fail(
              new SessionNotFound({ message: "awthaq: no such session", id }),
            );
          }
          const now = yield* DateTime.now;
          // RRS-003: a tombstoned row is a presented-already-rotated token —
          // reuse. Reached only with the correct (old) secret (PIL-007).
          // Checked before expiry: a rotated-away row's own expiry
          // timestamps are stale and not the interesting signal here. The
          // external response stays the uniform `SessionNotFound` whether this
          // is the first reuse or a later presentation of an already-flagged
          // row — no distinguishable signal leaked, matching `Verification.ts`'s
          // own posture.
          if (Option.isSome(row.value.supersededAt)) {
            if (Option.isNone(row.value.reusedAt)) {
              const familyId = row.value.familyId;
              yield* Ref.update(state, (s) => {
                const marked = HashMap.modify(s, id, (r) => ({ ...r, reusedAt: Option.some(now) }));
                return HashMap.filter(
                  marked,
                  (r) => r.familyId !== familyId || Option.isSome(r.supersededAt),
                );
              });
              yield* events.publish({
                _tag: "auth.session.reuse",
                sessionId: id,
                familyId,
                userId: row.value.userId,
              });
              yield* events.publish({
                _tag: "auth.session.revoked",
                userId: row.value.userId,
                sessionId: null,
                scope: "family",
                reason: "reuseDetected",
              });
            }
            return yield* Effect.fail(
              new SessionNotFound({ message: "awthaq: no such session", id }),
            );
          }
          if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.value.absoluteExpiresAt)) {
            yield* events.publish({
              _tag: "auth.session.expired",
              sessionId: id,
              userId: row.value.userId,
              kind: "absolute",
            });
            return yield* Effect.fail(
              new SessionExpired({ message: "awthaq: session expired", id }),
            );
          }
          if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.value.idleExpiresAt)) {
            yield* events.publish({
              _tag: "auth.session.expired",
              sessionId: id,
              userId: row.value.userId,
              kind: "idle",
            });
            return yield* Effect.fail(
              new SessionExpired({ message: "awthaq: session idle-expired", id }),
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
                new SessionNotFound({ message: "awthaq: no such session", id }),
              );
            }
            return { session: toView(current.value), rotated: Option.none() };
          }
          // RRS-008: only the call that won the rotation announces it — the
          // concurrent loser took the branch above and reports `rotated: none`.
          yield* events.publish({
            _tag: "auth.session.rotated",
            sessionId: id,
            familyId: touched.value.familyId,
            userId: touched.value.userId,
          });
          return {
            session: toView(touched.value),
            rotated: Option.some(Redacted.make(`${id}.${newSecret}`)),
          };
        },
        Effect.catchTag("PlatformError", storeUnavailable("Sessions.verify")),
      );

      // TIR-008: each primitive removes the row(s) in one `Ref.modify` and
      // then publishes exactly one `auth.session.revoked` for the call.
      const removeOne = (
        userId: UserId | undefined,
        id: SessionId,
      ): Effect.Effect<SessionRow, SessionNotFound> =>
        Ref.modify(
          state,
          (
            s,
          ): readonly [
            Result.Result<SessionRow, SessionNotFound>,
            HashMap.HashMap<SessionId, SessionRow>,
          ] => {
            const row = HashMap.get(s, id);
            if (Option.isNone(row) || (userId !== undefined && row.value.userId !== userId)) {
              return [
                Result.fail(new SessionNotFound({ message: "awthaq: no such session", id })),
                s,
              ] as const;
            }
            const removed: Result.Result<SessionRow, SessionNotFound> = Result.succeed(row.value);
            return [removed, HashMap.remove(s, id)] as const;
          },
        ).pipe(Effect.flatMap(Effect.fromResult));

      const revoke: SessionsShape["revoke"] = (id, reason) =>
        removeOne(undefined, id).pipe(
          Effect.flatMap((row) =>
            events.publish({
              _tag: "auth.session.revoked",
              userId: row.userId,
              sessionId: row.id,
              scope: "one",
              reason,
            }),
          ),
        );

      const revokeOwned: SessionsShape["revokeOwned"] = (userId, id, reason) =>
        removeOne(userId, id).pipe(
          Effect.flatMap((row) =>
            events.publish({
              _tag: "auth.session.revoked",
              userId: row.userId,
              sessionId: row.id,
              scope: "one",
              reason,
            }),
          ),
        );

      const revokeOthers: SessionsShape["revokeOthers"] = (userId, keep, reason) =>
        Ref.update(state, (s) =>
          HashMap.filter(s, (row, id) => id === keep || row.userId !== userId),
        ).pipe(
          Effect.andThen(
            events.publish({
              _tag: "auth.session.revoked",
              userId,
              sessionId: null,
              scope: "others",
              reason,
            }),
          ),
        );

      const revokeAll: SessionsShape["revokeAll"] = (userId, reason) =>
        Ref.update(state, (s) => HashMap.filter(s, (row) => row.userId !== userId)).pipe(
          Effect.andThen(
            events.publish({
              _tag: "auth.session.revoked",
              userId,
              sessionId: null,
              scope: "all",
              reason,
            }),
          ),
        );

      const purgeExpired: SessionsShape["purgeExpired"] = (before) =>
        Ref.modify(state, (s) => {
          const cutoff = DateTime.toEpochMillis(before);
          const kept = HashMap.filter(
            s,
            (row) =>
              DateTime.toEpochMillis(row.absoluteExpiresAt) >= cutoff &&
              DateTime.toEpochMillis(row.idleExpiresAt) >= cutoff,
          );
          return [HashMap.size(s) - HashMap.size(kept), kept] as const;
        });

      const toItem = (row: SessionRow, current: SessionId | undefined): SessionListItem => ({
        id: row.id,
        createdAt: row.createdAt,
        authenticatedAt: row.authenticatedAt,
        lastActiveAt: row.lastActiveAt,
        expiresAt: row.absoluteExpiresAt,
        userAgent: row.userAgent,
        amr: row.amr,
        current: row.id === current,
      });

      // RRS-003/SMS-002: `isLiveAt` — load-bearing, not cosmetic. A
      // tombstoned or expired row must never appear in a user's device list
      // (and is what makes `verifyLive`/`Jwt.introspectLive` reject a
      // reused/family-revoked session's JWT — they call `isLive`).
      const list: SessionsShape["list"] = (userId, current) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const s = yield* Ref.get(state);
          return newestActivityFirst(
            Array.from(HashMap.values(s))
              .filter((row) => row.userId === userId && isLiveAt(now, row))
              .map((row) => toItem(row, current)),
          );
        });

      const findOwned: SessionsShape["findOwned"] = (userId, id) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const row = yield* Ref.get(state).pipe(Effect.map((s) => HashMap.get(s, id)));
          return Option.filter(row, (r) => r.userId === userId && isLiveAt(now, r)).pipe(
            Option.map((r) => toItem(r, undefined)),
          );
        });

      const isLive: SessionsShape["isLive"] = (userId, id) =>
        findOwned(userId, id).pipe(Effect.map(Option.isSome));

      const reauthenticate: SessionsShape["reauthenticate"] = Effect.fnUntraced(
        function* (id, amr) {
          const now = yield* DateTime.now;
          const updated = yield* Ref.modify(
            state,
            (s): readonly [Option.Option<SessionRow>, HashMap.HashMap<SessionId, SessionRow>] => {
              const current = HashMap.get(s, id);
              if (Option.isNone(current)) return [Option.none(), s] as const;
              const refreshed: SessionRow = {
                ...current.value,
                authenticatedAt: now,
                amr: unionAmr(current.value.amr, amr ?? []),
              };
              return [Option.some(refreshed), HashMap.set(s, id, refreshed)] as const;
            },
          );
          if (Option.isNone(updated)) {
            return yield* Effect.fail(
              new SessionNotFound({ message: "awthaq: no such session", id }),
            );
          }
          return toView(updated.value);
        },
      );

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
      };
    }),
  );

const toSessionView = (row: SqlModels.Session): SessionView => ({
  id: SessionId(row.id),
  userId: UserId(row.userId),
  createdAt: row.createdAt,
  authenticatedAt: row.authenticatedAt,
  lastActiveAt: row.lastActiveAt,
  absoluteExpiresAt: row.absoluteExpiresAt,
  idleExpiresAt: row.idleExpiresAt,
  ipAddress: Option.fromNullishOr(row.ipAddress),
  userAgent: Option.fromNullishOr(row.userAgent),
  actingAs:
    row.actingAsType === null || row.actingAsId === null
      ? Option.none()
      : Option.some({ type: row.actingAsType, id: row.actingAsId }),
  amr: parseAmr(row.amr),
  tenantId: Option.fromNullOr(row.tenantId),
});

export const layerSql: Layer.Layer<
  Sessions,
  never,
  SqlRepositories.SessionsRepository | SqlClient.SqlClient | Crypto.Crypto | AuthEvents.AuthEvents
> = Layer.effect(
  Sessions,
  Effect.gen(function* () {
    const repo = yield* SqlRepositories.SessionsRepository;
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    // EP-007: see `layerMemory`.
    const builtConfig = yield* SessionConfig;
    const configNow = Tenant.configInForce(SessionConfig, builtConfig);
    const events = yield* AuthEvents.AuthEvents;
    const bridge = yield* LegacySessionBridge.LegacySessionBridge;

    const issue: SessionsShape["issue"] = Effect.fnUntraced(
      function* (input) {
        const config = yield* configNow;
        yield* refuseSelfActingAs(input);
        // Generated here, not left to `Model.UuidV7Insert`'s own
        // constructor-default: `familyId` needs this row's own `id` before
        // insert (to self-reference when it founds a fresh family), so `id`
        // must be known up front — mirrors `layerMemory.issue`'s own
        // already-explicit generation.
        const id = SessionId(yield* crypto.randomUUIDv7);
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
        // ESR-002/RRS-004: the tombstone and the successor's insert commit
        // together or not at all — a crash between them would leave the client
        // holding a tombstoned token whose next use reads as refresh-token
        // reuse (family revocation and a false `auth.session.reuse`). The
        // hash/id/clock work above stays outside the transaction.
        const persist = Effect.gen(function* () {
          // RRS-003: tombstoned, not deleted — the ancestor's own `familyId` is
          // what this new row inherits; no live `supersedes` ancestor founds a
          // fresh family, `familyId = id`.
          let familyId = id;
          let superseded: { readonly id: SessionId; readonly familyId: string } | undefined;
          if (input.supersedes !== undefined) {
            const ancestor = yield* repo
              .tombstone({ id: input.supersedes, supersededBy: id, supersededAt: now })
              .pipe(
                Effect.catchTags({
                  NoSuchElementError: () => Effect.succeed(undefined),
                }),
              );
            if (ancestor !== undefined) {
              familyId = SessionId(ancestor.familyId);
              superseded = { id: input.supersedes, familyId: ancestor.familyId };
            }
          }
          const insert = yield* repo.models.Session.insert
            .makeEffect({
              id,
              userId: input.userId,
              secretHash,
              ipAddress: input.request?.ip ?? null,
              userAgent: cappedUserAgent(input.request?.userAgent) ?? null,
              absoluteExpiresAt,
              idleExpiresAt: Model.Override(idleExpiresAt),
              actingAsType: input.actingAs?.type ?? null,
              actingAsId: input.actingAs?.id ?? null,
              amr: JSON.stringify(input.amr ?? []),
              familyId,
              supersededBy: null,
              supersededAt: null,
              reusedAt: null,
            })
            .pipe(Effect.orDie);
          const inserted = yield* repo.insert(insert);
          // SMS-003: enforced in this same transaction — list the user's other
          // live, non-impersonation sessions (oldest activity first) and delete
          // the surplus. Under Postgres' default isolation two racing issues can
          // each see room and transiently exceed the cap by one; the next issue
          // evicts back to `limit`.
          const policy = input.actingAs === undefined ? config.maxConcurrent : undefined;
          const evicted: Array<string> = [];
          if (policy !== undefined) {
            const live = yield* repo.listLiveIds(input.userId, now);
            for (const goneId of evictionOrder(
              policy.limit,
              live.filter((r) => r.id !== id),
            )) {
              yield* repo.delete(SessionId(goneId));
              evicted.push(goneId);
            }
          }
          return { inserted, evicted, superseded };
        });
        const {
          inserted: row,
          evicted,
          superseded,
          // SEA-002: a busy/deadlocked write is retried as a whole unit (the statement, or the rolled
          // back transaction) a few times before it becomes `StoreUnavailable`.
        } = yield* (
          input.supersedes === undefined && config.maxConcurrent === undefined
            ? persist
            : sql.withTransaction(persist)
        ).pipe(retryTransient());
        // RRS-008: see `layerMemory.issue`.
        if (superseded !== undefined) {
          yield* events.publish({
            _tag: "auth.session.superseded",
            sessionId: superseded.id,
            supersededBy: id,
            familyId: superseded.familyId,
            userId: input.userId,
          });
        }
        for (const goneId of evicted) {
          yield* events.publish({
            _tag: "auth.session.revoked",
            userId: input.userId,
            sessionId: SessionId(goneId),
            scope: "one",
            reason: "limitEvicted",
          });
        }
        const view = toSessionView(row);
        yield* publishIssued(events, view, row.familyId, view.actingAs);
        return { session: view, token: Redacted.make(`${row.id}.${secret}`) };
      },
      Effect.catchTags({
        PlatformError: storeUnavailable("Sessions.issue"),
        SqlError: storeUnavailable("Sessions.issue"),
        SchemaError: Effect.die,
      }),
    );

    /**
     * BAM-003 (.issues/high): consulted only on a primary-store miss — see
     * `layerMemory`'s own identical helper for the full rationale. Mints
     * through this layer's own `issue`, so a bridge hit persists via the
     * same SQL repository every other session does.
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
          return yield* Effect.fail(
            new SessionNotFound({ message: "awthaq: malformed session token" }),
          );
        }
        const id = SessionId(raw.slice(0, separator));
        const secret = raw.slice(separator + 1);
        // PIL-007: prove the secret before any row-state branch — see
        // `layerMemory.verify`'s identical comment.
        const presentedHash = yield* hashSecret(crypto, secret);
        const found = yield* repo.findById(id).pipe(
          Effect.map(Option.some),
          Effect.catchTags({
            NoSuchElementError: () => Effect.succeed(Option.none()),
          }),
        );
        if (Option.isNone(found)) {
          secretMatches(presentedHash, UNKNOWN_SESSION_HASH);
          const bridged = yield* bridgeLegacySession(raw);
          if (Option.isSome(bridged)) return bridged.value;
          return yield* Effect.fail(
            new SessionNotFound({ message: "awthaq: no such session", id }),
          );
        }
        const row = found.value;
        if (!secretMatches(presentedHash, row.secretHash)) {
          return yield* Effect.fail(
            new SessionNotFound({ message: "awthaq: no such session", id }),
          );
        }
        const now = yield* DateTime.now;
        // RRS-003: a tombstoned row is a presented-already-rotated token —
        // reuse. Reached only with the correct (old) secret (PIL-007), and
        // checked before expiry: a rotated-away row's own expiry timestamps
        // are stale and not the interesting signal here. The external response stays the
        // uniform `SessionNotFound` whether this is the first reuse or a
        // later presentation of an already-flagged row.
        if (row.supersededAt !== null) {
          if (row.reusedAt === null) {
            const familyId = SessionId(row.familyId);
            yield* repo.markReused(id, now);
            yield* repo.revokeFamily(familyId);
            yield* events.publish({
              _tag: "auth.session.reuse",
              sessionId: id,
              familyId,
              userId: UserId(row.userId),
            });
            yield* events.publish({
              _tag: "auth.session.revoked",
              userId: UserId(row.userId),
              sessionId: null,
              scope: "family",
              reason: "reuseDetected",
            });
          }
          return yield* Effect.fail(
            new SessionNotFound({ message: "awthaq: no such session", id }),
          );
        }
        if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.absoluteExpiresAt)) {
          yield* events.publish({
            _tag: "auth.session.expired",
            sessionId: id,
            userId: UserId(row.userId),
            kind: "absolute",
          });
          return yield* Effect.fail(new SessionExpired({ message: "awthaq: session expired", id }));
        }
        if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.idleExpiresAt)) {
          yield* events.publish({
            _tag: "auth.session.expired",
            sessionId: id,
            userId: UserId(row.userId),
            kind: "idle",
          });
          return yield* Effect.fail(
            new SessionExpired({ message: "awthaq: session idle-expired", id }),
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
          .pipe(retryTransient());
        if (Option.isNone(touched)) {
          const current = yield* repo.findById(id).pipe(
            Effect.catchTags({
              NoSuchElementError: () =>
                Effect.fail(new SessionNotFound({ message: "awthaq: no such session", id })),
            }),
          );
          return { session: toSessionView(current), rotated: Option.none() };
        }
        // RRS-008: only the call that won the rotation announces it.
        yield* events.publish({
          _tag: "auth.session.rotated",
          sessionId: id,
          familyId: touched.value.familyId,
          userId: UserId(touched.value.userId),
        });
        return {
          session: toSessionView(touched.value),
          rotated: Option.some(Redacted.make(`${id}.${newSecret}`)),
        };
      },
      Effect.catchTags({
        PlatformError: storeUnavailable("Sessions.verify"),
        SqlError: storeUnavailable("Sessions.verify"),
        SchemaError: Effect.die,
      }),
    );

    // TIR-008: each primitive deletes, then publishes exactly one
    // `auth.session.revoked` for the call.
    const revoke: SessionsShape["revoke"] = (id, reason) =>
      repo.findById(id).pipe(
        Effect.catchTags({
          NoSuchElementError: () =>
            Effect.fail(new SessionNotFound({ message: "awthaq: no such session", id })),
        }),
        Effect.flatMap((row) =>
          repo.delete(id).pipe(
            Effect.andThen(
              events.publish({
                _tag: "auth.session.revoked",
                userId: UserId(row.userId),
                sessionId: id,
                scope: "one",
                reason,
              }),
            ),
          ),
        ),
        Effect.catchTags({
          SqlError: storeUnavailable("Sessions.revoke"),
          SchemaError: Effect.die,
        }),
      );

    const revokeOwned: SessionsShape["revokeOwned"] = (userId, id, reason) =>
      repo.deleteOwned(id, userId).pipe(
        Effect.flatMap((deleted) =>
          deleted
            ? events.publish({
                _tag: "auth.session.revoked",
                userId,
                sessionId: id,
                scope: "one",
                reason,
              })
            : Effect.fail(new SessionNotFound({ message: "awthaq: no such session", id })),
        ),
        Effect.catchTag("SqlError", storeUnavailable("Sessions.revokeOwned")),
      );

    const revokeOthers: SessionsShape["revokeOthers"] = (userId, keep, reason) =>
      repo.deleteAllForUserExcept(userId, keep).pipe(
        Effect.andThen(
          events.publish({
            _tag: "auth.session.revoked",
            userId,
            sessionId: null,
            scope: "others",
            reason,
          }),
        ),
        Effect.catchTag("SqlError", storeUnavailable("Sessions.revokeOthers")),
      );

    const revokeAll: SessionsShape["revokeAll"] = (userId, reason) =>
      repo.deleteAllByUser(userId).pipe(
        Effect.andThen(
          events.publish({
            _tag: "auth.session.revoked",
            userId,
            sessionId: null,
            scope: "all",
            reason,
          }),
        ),
        Effect.catchTag("SqlError", storeUnavailable("Sessions.revokeAll")),
      );

    const purgeExpired: SessionsShape["purgeExpired"] = (before) =>
      drainBatches((limit) =>
        repo.deleteExpiredBefore(before, limit).pipe(orStoreUnavailable("Sessions.purgeExpired")),
      );

    const toItem = (row: SqlModels.Session, current: SessionId | undefined): SessionListItem => ({
      id: SessionId(row.id),
      createdAt: row.createdAt,
      authenticatedAt: row.authenticatedAt,
      lastActiveAt: row.lastActiveAt,
      expiresAt: row.absoluteExpiresAt,
      userAgent: Option.fromNullishOr(row.userAgent),
      amr: parseAmr(row.amr),
      current: row.id === current,
    });

    // TIR-003/ESS-005: drains every page of the user's live rows (the
    // repository applies the liveness predicate at `now`, SMS-002) rather
    // than one 200-row page — a silent truncation used to drop the newest,
    // i.e. current, session from the list.
    const drainLive = Effect.fnUntraced(function* (
      userId: UserId,
      options?: SqlReadRouting.ReadOptions,
    ) {
      const now = yield* DateTime.now;
      const rows: Array<SqlModels.Session> = [];
      let cursor: Option.Option<SqlRepositories.Cursor> = Option.none();
      while (rows.length < LIST_LIMIT) {
        const page = yield* repo.listByUser(
          userId,
          now,
          Option.getOrUndefined(cursor),
          SqlRepositories.MAX_PAGE_SIZE,
          options,
        );
        rows.push(...page.items);
        if (Option.isNone(page.nextCursor)) return rows;
        cursor = page.nextCursor;
      }
      yield* Effect.logWarning(
        `awthaq: Sessions.list stopped at ${LIST_LIMIT} live sessions for user ${userId}`,
      );
      return rows;
    });

    const list: SessionsShape["list"] = (userId, current, options) =>
      drainLive(userId, options).pipe(
        Effect.map((rows) => newestActivityFirst(rows.map((row) => toItem(row, current)))),
        Effect.catchTags({
          SqlError: storeUnavailable("Sessions.list"),
          SchemaError: Effect.die,
        }),
      );

    const findOwned: SessionsShape["findOwned"] = (userId, id) =>
      Effect.gen(function* () {
        const row = yield* repo.findById(id).pipe(
          Effect.map(Option.some),
          Effect.catchTags({
            NoSuchElementError: () => Effect.succeed(Option.none()),
          }),
        );
        const now = yield* DateTime.now;
        return Option.filter(
          row,
          (r) =>
            r.userId === userId &&
            isLiveAt(now, {
              absoluteExpiresAt: r.absoluteExpiresAt,
              idleExpiresAt: r.idleExpiresAt,
              supersededAt: Option.fromNullishOr(r.supersededAt),
            }),
        ).pipe(Option.map((r) => toItem(r, undefined)));
      }).pipe(
        Effect.catchTags({
          SqlError: storeUnavailable("Sessions.findOwned"),
          SchemaError: Effect.die,
        }),
      );

    const isLive: SessionsShape["isLive"] = (userId, id) =>
      findOwned(userId, id).pipe(Effect.map(Option.isSome));

    const reauthenticate: SessionsShape["reauthenticate"] = Effect.fnUntraced(
      function* (id, amr) {
        const now = yield* DateTime.now;
        const notFound = () =>
          Effect.fail(new SessionNotFound({ message: "awthaq: no such session", id }));
        // THS-003: union the newly proven methods into the stored `amr` (monotone).
        const unioned =
          amr === undefined || amr.length === 0
            ? undefined
            : yield* repo.findById(id).pipe(
                Effect.map((current) => JSON.stringify(unionAmr(parseAmr(current.amr), amr))),
                Effect.catchTags({
                  NoSuchElementError: notFound,
                }),
              );
        const row = yield* repo.reauthenticate(id, now, unioned).pipe(
          Effect.catchTags({
            NoSuchElementError: notFound,
          }),
        );
        return toSessionView(row);
      },
      Effect.catchTags({
        SqlError: storeUnavailable("Sessions.reauthenticate"),
        SchemaError: Effect.die,
      }),
    );

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
    };
  }),
);
