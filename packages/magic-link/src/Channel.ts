// @awthaq/magic-link — Channel
//
// BAM-007, SOS-001 (BEH-EA-264 to BEH-EA-271): what `MagicLink` and `EmailOtp` share — proof that a
// person controls a mailbox turned into a session. Both plugins are a *channel credential* over the
// `Verification` substrate: they differ in what the emailed artifact is (a long single-use link, a
// short attempt-budgeted code) and in how it is presented, never in what a proven mailbox means.
// That meaning lives here, once:
//
// 1. **Find or create the user.** The consumed row names a user when one existed at request time;
//    otherwise (or if that user has vanished) the address is looked up again, and a brand-new address
//    creates a user — *only* when the plugin's `allowSignUp` is on, through the same `BeforeSignUp`
//    veto every user-creating path consults (NAM-002), and announced with `auth.user.created` and
//    `AfterSignUp`. The user is created here, after the proof, never at request time: an unanswered
//    request creates nothing.
// 2. **The mailbox is now proven**, so `emailVerified` flips (idempotent).
// 3. **The shared sign-in gate**: `Users.assertCanSignIn` (a suspended user gets no session), then the
//    `BeforeSignIn` veto, then `BeforeSessionIssue` — the MFA divert (ARF-005 Fix A). A user with a
//    confirmed second factor is diverted to `TwoFactorRequired` exactly as a password or passkey
//    sign-in is: mailbox possession alone never mints a session for a 2FA-protected account.
// 4. **The session** records how it was proven (`amr`), the sign-in is announced (`auth.user.signedIn`)
//    and `AfterSignIn` observes.
//
// Nothing here touches an existing password credential: a magic link or code signs the person in; it
// does not link, unlink or replace any credential.

import { AuthEvents, Hooks, HookPoint, Sessions, Users } from "@awthaq/core";
import type { Errors } from "@awthaq/core";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";

/** The address exactly as compared and stored: trimmed and lower-cased (`Users` lower-cases too, BEH-EA-041). */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/**
 * TMS-006: the bucket a per-address limit counts against — lower-cased with a `+tag` stripped, so
 * `victim+1@x.com` and `victim+2@x.com` share one budget instead of mail-bombing one inbox.
 * Only the key is normalised; the address a mail is delivered to stays literal.
 */
export const emailRateKey = (email: string): string => {
  const lowered = normalizeEmail(email);
  const at = lowered.lastIndexOf("@");
  if (at === -1) return lowered;
  const local = lowered.slice(0, at);
  const plus = local.indexOf("+");
  return `${plus > 0 ? local.slice(0, plus) : local}${lowered.slice(at)}`;
};

/** The consumed proof named no usable user and no address to create one for. Each plugin maps it onto its own wire error. */
export class ChannelInvalid extends Data.TaggedError("MagicLink/ChannelInvalid")<{
  readonly reason: "noAddress" | "userMissing" | "signUpDisabled";
}> {}

export interface IssuedSession {
  readonly session: Sessions.SessionView;
  readonly token: Redacted.Redacted<string>;
}

export interface Completion {
  /** The plugin's own strategy label — `magicLink` or `emailOtp` (also the `BeforeSessionIssue` strategy). */
  readonly strategy: string;
  /** How the mailbox proof authenticated the session, as RFC 8176 references. */
  readonly amr: ReadonlyArray<Sessions.AuthMethod>;
  /** The address the proof concerns, normalised. `None` only if the payload carried none (a foreign row). */
  readonly email: Option.Option<string>;
  /** The user the consumed row named, when it named one. */
  readonly userId: Option.Option<Users.UserId>;
  /** Whether an unknown address may create a user (the plugin's `allowSignUp`). */
  readonly allowSignUp: boolean;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

export interface Channel {
  readonly complete: (
    completion: Completion,
  ) => Effect.Effect<
    IssuedSession,
    | ChannelInvalid
    | HookPoint.HookAborted
    | Hooks.TwoFactorRequired
    | Users.UserSuspended
    | Errors.StoreUnavailable
  >;
}

/** Resolves the core services once, at plugin build; the returned closure carries no further requirements. */
export const make = Effect.gen(function* () {
  const users = yield* Users.Users;
  const sessions = yield* Sessions.Sessions;
  const events = yield* AuthEvents.AuthEvents;
  const beforeSignUp = yield* Hooks.BeforeSignUp;
  const afterSignUp = yield* Hooks.AfterSignUp;
  const beforeSignIn = yield* Hooks.BeforeSignIn;
  const beforeSessionIssue = yield* Hooks.BeforeSessionIssue;
  const afterSignIn = yield* Hooks.AfterSignIn;

  /** A user for `email`: the existing one, or — when allowed and the veto passes — a new one. */
  const resolveUser = Effect.fnUntraced(function* (completion: Completion) {
    if (Option.isSome(completion.userId)) {
      const named = yield* users.findById(completion.userId.value).pipe(
        Effect.map(Option.some),
        Effect.catchTag("UserNotFound", () => Effect.succeed(Option.none())),
      );
      if (Option.isSome(named)) return named.value;
    }
    if (Option.isNone(completion.email)) {
      return yield* Effect.fail(new ChannelInvalid({ reason: "noAddress" }));
    }
    const email = completion.email.value;
    const existing = yield* users.findByEmail(email);
    if (Option.isSome(existing)) return existing.value;
    if (!completion.allowSignUp) {
      return yield* Effect.fail(new ChannelInvalid({ reason: "signUpDisabled" }));
    }
    // NAM-002/SCP-008: creation through any path is a sign-up, so the same veto guards it.
    const local = email.slice(0, Math.max(email.indexOf("@"), 1));
    const vetoedSignUp = yield* HookPoint.aborted(Hooks.BeforeSignUp)(
      beforeSignUp.run({ email, name: local, strategy: completion.strategy }),
    );
    const vetoed = { ...vetoedSignUp, email: vetoedSignUp.email ?? email };
    const created = yield* users
      .create({ identity: { _tag: "Email", email: vetoed.email }, name: vetoed.name })
      .pipe(
        Effect.map((user) => ({ user, fresh: true })),
        // A concurrent request claimed the address between our lookup and this insert: use theirs.
        Effect.catchTag("Users/EmailAlreadyExists", () =>
          users.findByEmail(vetoed.email).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new ChannelInvalid({ reason: "userMissing" })),
                onSome: (winner) => Effect.succeed({ user: winner, fresh: false }),
              }),
            ),
          ),
        ),
        // FAMS-002: `create` here is an Email identity, so a phone conflict is unreachable.
        Effect.catchTag("Users/PhoneAlreadyExists", Effect.die),
      );
    if (created.fresh) {
      yield* events.publish({ _tag: "auth.user.created", userId: created.user.id });
      yield* afterSignUp.run({
        userId: created.user.id,
        email: vetoed.email,
        strategy: completion.strategy,
      });
    }
    return created.user;
  });

  const complete: Channel["complete"] = Effect.fnUntraced(function* (completion) {
    const user = yield* resolveUser(completion);
    // The mailbox is proven: the one-way `emailVerified` flip (idempotent). A user reached through
    // this path always has an email identity (they were found by address or created with one).
    yield* users.verifyEmail(user.id).pipe(
      Effect.catchTags({
        UserNotFound: () => Effect.fail(new ChannelInvalid({ reason: "userMissing" })),
        IdentityMismatch: Effect.die,
      }),
    );
    // SCP-001/BAM-005: THE shared sign-in gate, after the proof and before any session exists.
    yield* Users.assertCanSignIn(user);
    // NAM-002: the sign-in veto, before the MFA divert point below.
    yield* HookPoint.aborted(Hooks.BeforeSignIn)(
      beforeSignIn.run({
        userId: user.id,
        ...Users.emailField(user),
        strategy: completion.strategy,
      }),
    );
    // ARF-005 Fix A / BCR-004: THE canonical MFA attachment point, consulted right before this
    // flow's own `sessions.issue` — a user with a confirmed second factor is diverted here.
    const point = yield* beforeSessionIssue.run({
      userId: user.id,
      strategy: completion.strategy,
      amr: completion.amr,
    });
    if (point._tag === "Diverted") return yield* Effect.fail(point.value);
    const issued = yield* sessions.issue({
      userId: user.id,
      request: {
        ...(completion.ip === undefined ? {} : { ip: completion.ip }),
        ...(completion.userAgent === undefined ? {} : { userAgent: completion.userAgent }),
      },
      amr: completion.amr,
    });
    yield* events.publish({
      _tag: "auth.user.signedIn",
      userId: user.id,
      strategy: completion.strategy,
    });
    yield* afterSignIn.run({ userId: user.id, strategy: completion.strategy });
    return issued;
  });

  return { complete } satisfies Channel;
});

/** A refusal reaching the client is one opaque error; the reason (an operator's question) goes to the log. */
export const logInvalid = (strategy: string, error: ChannelInvalid) =>
  Effect.logDebug("awthaq: channel sign-in refused").pipe(
    Effect.annotateLogs({ strategy, reason: error.reason }),
  );
