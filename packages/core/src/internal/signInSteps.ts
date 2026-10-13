// @awthaq/core — the steps behind `SignIn` and `SignUp.createSignedIn` (ADR-EA-038)
//
// Package-private: `core/package.json` exports only ".", so no plugin can import this file, which is
// what makes `Clearance` unforgeable outside core. `SignIn.ts` re-exports the public types and `make`;
// `SignUp.ts` uses `makeSteps` directly for `createSignedIn`.

import * as Brand from "effect/Brand";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import { Defects } from "@awthaq/ports";
import { AuthEvents } from "../AuthEvents.ts";
import { AuthRequestContext } from "../AuthRequestContext.ts";
import * as HookPoint from "../HookPoint.ts";
import * as Hooks from "../Hooks.ts";
import type * as Sessions from "../Sessions.ts";
import { SignInContinuationRegistry } from "../SignInContinuationRegistry.ts";
import { TenantContext, withTenant } from "../Tenant.ts";
import * as Users from "../Users.ts";
import { Sessions as SessionsService } from "../Sessions.ts";

/** What a first-factor flow proved: who, by which strategy, and how (RFC 8176). */
export interface Attempt {
  readonly userId: Users.UserId;
  /** `password`, `passkey`, an OAuth provider id, `saml:<org>:<conn>`, `magicLink`, `emailOtp`, `device`. */
  readonly strategy: string;
  readonly amr: ReadonlyArray<Sessions.AuthMethod>;
  /** Built by `SignIn.continuation(...).of(payload)`; omitted by every flow but SAML today. */
  readonly continuation?: Hooks.Continuation | undefined;
}

/**
 * The only input `SignIn.issue` accepts. Minted by `clear` (gate, veto, divert all passed) or
 * `resume` (gate re-passed after a resolved divert). The `amr` the divert saw is this `amr`.
 */
export type Clearance = {
  readonly user: Users.UserRecord;
  readonly strategy: string;
  readonly amr: ReadonlyArray<Sessions.AuthMethod>;
  readonly tenantId: Option.Option<string>;
  readonly continuation: Option.Option<Hooks.Continuation>;
} & Brand.Brand<"awthaq/SignIn/Clearance">;

const clearance = Brand.nominal<Clearance>();

/** The user vanished between the credential proof and the session (a concurrent erasure). Never a defect. */
export class UserGone extends Data.TaggedError("SignIn/UserGone")<{
  readonly message: string;
  readonly userId: Users.UserId;
}> {}

/** Explicit request facts; each field falls back to `AuthRequestContext` when omitted. */
export interface SessionRequest {
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

/** The one session-with-token type every sign-in plugin aliases. */
export interface IssuedSession {
  readonly session: Sessions.SessionView;
  readonly token: Redacted.Redacted<string>;
}

export const makeSteps = Effect.gen(function* () {
  const users = yield* Users.Users;
  const sessions = yield* SessionsService;
  const events = yield* AuthEvents;
  const beforeSignIn = yield* Hooks.BeforeSignIn;
  const beforeSessionIssue = yield* Hooks.BeforeSessionIssue;
  const afterSignIn = yield* Hooks.AfterSignIn;
  const continuations = yield* SignInContinuationRegistry;

  /** Lookup + THE gate (SCP-001). A suspended refusal is announced for every strategy (policy 3.6.2). */
  const gate = Effect.fnUntraced(function* (attempt: Attempt) {
    const user = yield* users.findById(attempt.userId).pipe(
      Effect.catchTag(
        "UserNotFound",
        () =>
          new UserGone({
            message: "awthaq: the signing-in user no longer exists",
            userId: attempt.userId,
          }),
      ),
    );
    // EOTS-001: the credential is proven, so the span may name the user (an id, never the email).
    yield* Effect.annotateCurrentSpan("user.id", user.id);
    yield* Users.assertCanSignIn(user).pipe(
      Effect.tapError(() =>
        Effect.gen(function* () {
          const request = yield* AuthRequestContext;
          yield* events.publish({
            _tag: "auth.user.signInFailed",
            strategy: attempt.strategy,
            reason: "suspended",
            ...(Option.isSome(request.ip) ? { clientIp: request.ip.value } : {}),
          });
        }),
      ),
    );
    return user;
  });

  const clear = Effect.fnUntraced(function* (attempt: Attempt) {
    const user = yield* gate(attempt);
    // NAM-002: the sign-in veto, only now that the credential is proven, so a `HookAborted`
    // can never be used to probe a guessed credential.
    yield* HookPoint.aborted(Hooks.BeforeSignIn)(
      beforeSignIn.run({ userId: user.id, ...Users.emailField(user), strategy: attempt.strategy }),
    );
    const tenantId = yield* TenantContext;
    const handoff = {
      ...(Option.isSome(tenantId) ? { tenantId: tenantId.value } : {}),
      ...(attempt.continuation === undefined ? {} : { continuation: attempt.continuation }),
    };
    // BCR-004/THS-002: THE canonical MFA attachment point, never centralised inside
    // `Sessions.issue` (also called for impersonation and rotation).
    const point = yield* beforeSessionIssue.run({
      userId: user.id,
      strategy: attempt.strategy,
      amr: attempt.amr, // the same value `issue` records: the divert and the session cannot disagree
      handoff,
    });
    if (point._tag === "Diverted") return yield* Effect.fail(point.value);
    return clearance({
      user,
      strategy: attempt.strategy,
      amr: attempt.amr,
      tenantId,
      continuation: Option.fromUndefinedOr(attempt.continuation),
    });
  });

  const resume = Effect.fnUntraced(function* (
    attempt: Attempt & { readonly handoff?: Hooks.Handoff | undefined },
  ) {
    const user = yield* gate(attempt);
    return clearance({
      user,
      strategy: attempt.strategy,
      amr: attempt.amr,
      tenantId: Option.fromUndefinedOr(attempt.handoff?.tenantId),
      continuation: Option.fromUndefinedOr(attempt.handoff?.continuation),
    });
  });

  /** Inside or outside a transaction: the row only (plus the core-owned `auth.session.issued`). */
  const mint = (cleared: Clearance, request: SessionRequest | undefined) =>
    Effect.gen(function* () {
      const context = yield* AuthRequestContext;
      const ip = request?.ip ?? Option.getOrUndefined(context.ip);
      const userAgent = request?.userAgent ?? Option.getOrUndefined(context.userAgent);
      const issue = sessions.issue({
        userId: cleared.user.id,
        request: {
          ...(ip === undefined ? {} : { ip }),
          ...(userAgent === undefined ? {} : { userAgent }),
        },
        amr: cleared.amr,
      });
      // D3: a resumed sign-in is minted in the first factor's tenant, not the verify request's.
      return yield* Option.match(cleared.tenantId, {
        onNone: () => issue,
        onSome: (tenantId) => issue.pipe(withTenant(tenantId)),
      });
    });

  /** After the session exists (and, for a sign-up, after commit). */
  const announce = Effect.fnUntraced(function* (cleared: Clearance, issued: IssuedSession) {
    if (Option.isSome(cleared.continuation)) {
      const kind = cleared.continuation.value.kind;
      const handler = (yield* continuations.contributions).find((entry) => entry.kind === kind);
      if (handler === undefined) {
        return yield* Defects.invariantViolation(
          "SignInContinuationMissing",
          `awthaq: no sign-in continuation is registered for "${kind}"`,
        );
      }
      yield* handler.run(cleared.continuation.value.payload, {
        userId: cleared.user.id,
        sessionId: issued.session.id,
        strategy: cleared.strategy,
      });
    }
    yield* events.publish({
      _tag: "auth.user.signedIn",
      userId: cleared.user.id,
      strategy: cleared.strategy,
    });
    yield* afterSignIn.run({ userId: cleared.user.id, strategy: cleared.strategy });
    return issued;
  });

  return { gate, clear, resume, mint, announce };
});
