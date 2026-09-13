// @effect-auth/password — PasswordApi
//
// spec/behaviors/15-password.md, BEH-EA-113, BEH-EA-114, BEH-EA-117, BEH-EA-120.
// The plugin's own contract, groups named `password` (BEH-EA-004: a
// plugin's groups are confined to its own id or a dotted sub-id) — built the
// same way `@effect-auth/api`'s core `session` group is (`packages/api/src/Session.ts`),
// since a plugin's contract is stratum-1-shaped even though it lives in the
// plugin's own package (`spec/overview.md`: "Each plugin's own groups,
// schemas, errors, and contract `HttpApi`").

import { Api, SessionContract } from "@effect-auth/api";
import * as Schema from "effect/Schema";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";

/** BEH-EA-120: `422 WeakPassword { hints }` — too short, or (when `breachCheck` is on) found in a breach corpus. */
export class WeakPassword extends Schema.TaggedError<WeakPassword>()(
  "WeakPassword",
  { hints: Schema.Array(Schema.String) },
  { httpApiStatus: 422 },
) {}

/**
 * Not part of BEH-EA-113's own illustrative error union (`Effect<SessionView,
 * WeakPassword>`) — that sketch simply doesn't address what happens when the
 * email is already registered. `Users.create` (BEH-EA-041) already returns a
 * real, distinct `EmailAlreadyExists` for exactly this case; leaving it
 * unmapped here would mean every duplicate sign-up dies as an unhandled
 * defect instead of a request-level failure, which is worse than filling the
 * gap explicitly. `409` (not `401`/`422`) since this is a genuinely different
 * condition from a weak password or an authentication failure.
 */
export class EmailAlreadyExists extends Schema.TaggedError<EmailAlreadyExists>()(
  "EmailAlreadyExists",
  {},
  { httpApiStatus: 409 },
) {}

/**
 * BEH-EA-059/117: `confirmReset`'s failure mode is a bad/expired/replayed
 * reset token, not a wrong password — the wire shape BEH-EA-059 itself
 * fixes (`410 TokenConsumed`), reproduced here as this plugin's own schema
 * error since no shared `verification` contract group exists yet for it to
 * come from instead (see `@effect-auth/api`'s own header comment on what is
 * and isn't built yet).
 */
export class TokenConsumed extends Schema.TaggedError<TokenConsumed>()(
  "TokenConsumed",
  {},
  { httpApiStatus: 410 },
) {}

export const SignUpPayload = Schema.Struct({
  email: Schema.String,
  password: Schema.Redacted(Schema.String),
});
export type SignUpPayload = typeof SignUpPayload.Type;

export const SignInPayload = Schema.Struct({
  email: Schema.String,
  password: Schema.Redacted(Schema.String),
});
export type SignInPayload = typeof SignInPayload.Type;

/** BEH-EA-064/117: answered identically whether or not `email` resolves to an account. */
export const RequestResetPayload = Schema.Struct({
  email: Schema.String,
});
export type RequestResetPayload = typeof RequestResetPayload.Type;

export const ConfirmResetPayload = Schema.Struct({
  token: Schema.Redacted(Schema.String),
  password: Schema.Redacted(Schema.String),
});
export type ConfirmResetPayload = typeof ConfirmResetPayload.Type;

/**
 * BEH-EA-113: `signUp`/`signIn`'s success shape reuses `@effect-auth/api`'s
 * `SessionContract.SessionDto` rather than inventing a second, competing
 * "who is signed in" wire shape — `SessionView`/`SubjectDto` proper
 * (BEH-EA-026) is its own, still-deferred piece of work; `SessionDto` is
 * the one that already exists and is already what the `session` group
 * itself returns for the identical "here is your session" moment.
 * `confirmReset` declares no `success` schema (defaults to `204`, the same
 * convention `@effect-auth/api`'s `session` group's `signOut`/`revokeOthers`
 * already use) — it does not sign the caller in on whatever device
 * submitted the reset, only revokes every *other* session (BEH-EA-117).
 */
export const PasswordGroup = HttpApiGroup.make("password")
  .add(
    HttpApiEndpoint.post("signUp", "/password/sign-up", {
      payload: SignUpPayload,
      success: SessionContract.SessionDto,
      // Each error's own `httpApiStatus` is only honored per member when
      // `error` is a plain array — `HttpApiEndpoint.getErrorSchemas` reads
      // `endpoint.error` as a `Set` of individually-annotated schemas
      // (`HttpApiEndpoint.ts`'s own `getErrorResponse`); a `Schema.Union`
      // here would be stored as a single member whose own AST carries no
      // `httpApiStatus` annotation, silently falling back to 500.
      error: [WeakPassword, EmailAlreadyExists],
    }),
  )
  .add(
    HttpApiEndpoint.post("signIn", "/password/sign-in", {
      payload: SignInPayload,
      success: SessionContract.SessionDto,
      error: Api.InvalidCredentials,
    }),
  )
  .add(
    HttpApiEndpoint.post("requestReset", "/password/request-reset", {
      payload: RequestResetPayload,
      success: HttpApiSchema.Empty(202),
    }),
  )
  .add(
    HttpApiEndpoint.post("confirmReset", "/password/confirm-reset", {
      payload: ConfirmResetPayload,
      // BEH-EA-120: the new password is checked against the same policy
      // (`minLength`/`breachCheck`) any other newly-set password is. A
      // plain array, not `Schema.Union` — see `signUp`'s own comment above.
      error: [TokenConsumed, WeakPassword],
    }),
  );

export const PasswordApi = HttpApi.make("auth").add(PasswordGroup);
