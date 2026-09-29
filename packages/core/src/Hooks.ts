// @awthaq/core — Hooks
//
// spec/overview.md:107 already names this file; `HookPoint.ts` (the
// generic veto/observe/divert mechanism) stayed plugin-agnostic and never
// had its own concrete declarations split out until now. AOMS-006/BCR-004/
// CSG-002/THS-002 (.issues/high) — wayfinder ticket 03
// (.scratch/resolve-ready-for-human-findings): "no hook point is wired
// into a real signUp/signIn/session-issue/delete flow" — this file
// declares the four concrete points, and each owning flow's own module
// (`Users.ts`, `@awthaq/password`'s `Password.ts`, `@awthaq/oauth`'s
// `OAuth.ts`, `@awthaq/passkey`'s `Passkey.ts`) wires its own real call
// site directly, no "AuthCore" prerequisite needed — see ticket 03's own
// "Why the cited AuthCore blocker doesn't actually block this",
// `packages/organization/src/OrganizationHooks.ts` already proves a
// plugin/core module can depend on a `HookPoint` class as an ordinary
// `Context.Tag`, composed via `Layer.provide`/`Layer.merge` like any other
// service.
//
// Every id field below is a plain `Schema.String`, not a branded
// `Users.UserId` — matching `OrganizationHooks.ts`'s own real, already-
// compiling precedent, not ticket 03's own illustrative snippet (which
// used `Users.UserId` as if it were an `effect/Schema` value; it isn't —
// `Users.ts`'s `UserId` is a `Brand.nominal` constructor, not a
// `Schema.Schema`). A caller's actual branded `UserId` still assigns into
// a `string`-typed struct field with zero friction (it *is* a `string`,
// structurally), and this sidesteps importing anything at all from
// `Users.ts`, so `Hooks.ts` has no dependency — real or circular — on any
// module that might one day need to depend on it back.

import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HookPoint from "./HookPoint.ts";

// BEH-EA-090: veto — a plugin may reject a sign-up outright (e.g. an
// Auth0-Rule-style email-domain allow-list or subscription gate). Consulted on
// *every* user-creating path (NAM-002/SCP-008: password sign-up and the OAuth
// first-login creation), so `strategy` says which one — `"password"`, or the
// OAuth provider id — and one tap can tell them apart.
const SignUpInput = Schema.Struct({
  email: Schema.String,
  name: Schema.String,
  strategy: Schema.String,
});
export class BeforeSignUp extends HookPoint.veto<BeforeSignUp>()("auth.user.signUp", SignUpInput) {}

// NAM-002: observe — fired once a new user's creation has committed, whichever
// strategy created it (the after-the-fact twin of `BeforeSignUp`; welcome mail,
// provisioning fan-out, CRM sync).
const SignedUp = Schema.Struct({
  userId: Schema.String,
  email: Schema.String,
  strategy: Schema.String,
});
export class AfterSignUp extends HookPoint.observe<AfterSignUp>()("auth.user.signedUp", SignedUp) {}

// NAM-002: veto — consulted by every sign-in-completing flow (password,
// oauth, passkey) once the credential has been proven and before
// `BeforeSessionIssue`. This is where an Auth.js `signIn` callback returning
// `false` lands (a domain allow-list, a banned user): a tap fails with
// `HookAbort({ code })`, surfaced to the client as `HookAborted` (403). The
// amended value is ignored: a sign-in cannot change who is signing in.
const SignInInput = Schema.Struct({
  userId: Schema.String,
  email: Schema.String,
  strategy: Schema.String,
});
export class BeforeSignIn extends HookPoint.veto<BeforeSignIn>()("auth.user.signIn", SignInInput) {}

// BEH-EA-092: observe — fired once a session-backed sign-in completes,
// regardless of which strategy (password/oauth/passkey) produced it.
const SignedIn = Schema.Struct({ userId: Schema.String, strategy: Schema.String });
export class AfterSignIn extends HookPoint.observe<AfterSignIn>()("auth.signIn", SignedIn) {}

/**
 * BEH-EA-093 / archive/PRD.md §13's own worked example: the canonical
 * divert point — the MFA attachment mechanism a future `TwoFactor` plugin
 * (wayfinder ticket 05) taps. Modeled as a `Schema.TaggedError` (ticket
 * 03's own snippet used a plain `Schema.TaggedClass`) rather than —
 * `HookPoint.DivertShape["run"]`'s `Diverted` branch is threaded straight
 * into the guarded flow's own `Effect.fail` at every call site below, so
 * it needs to serialize over HTTP the same way any other typed failure in
 * this codebase's `HttpApiEndpoint` `error:` arrays does (an
 * `httpApiStatus` annotation), not merely carry data. `401`, shared with
 * `Api.InvalidCredentials`: the primary credential was accepted, but the
 * caller is not yet authorized until the second factor is presented too —
 * clients branch on `_tag`, not on the HTTP status alone, the same way
 * every other multi-member `error:` array in this codebase already
 * assumes. The exact wire shape here is a placeholder ticket 05's own
 * `TwoFactor` plugin is free to revisit once it exists as the point's
 * first real tap.
 */
export class TwoFactorRequired extends Schema.TaggedError<TwoFactorRequired>()(
  "TwoFactorRequired",
  { userId: Schema.String, challengeId: Schema.String },
  { httpApiStatus: 401 },
) {}
const SessionIssueContext = Schema.Struct({ userId: Schema.String, strategy: Schema.String });
const SessionIssueDiverted = Schema.Union([TwoFactorRequired]);
export class BeforeSessionIssue extends HookPoint.divert<BeforeSessionIssue>()(
  "auth.session.beforeIssue",
  SessionIssueContext,
  SessionIssueDiverted,
) {}

// BEH-EA-095's own worked example (Invite purging on user delete) — veto,
// not observe: a plugin must be able to block a delete outright (a GDPR
// legal hold, an org-ownership-transfer requirement), not just react
// after the fact.
const UserDeleteInput = Schema.Struct({ id: Schema.String, email: Schema.String });
export class BeforeUserDelete extends HookPoint.veto<BeforeUserDelete>()(
  "auth.user.beforeDelete",
  UserDeleteInput,
) {}

/**
 * AAPS-005: observe — fired once a user's awthaq-owned, policy-readable
 * attributes actually change (`Users.updateProfile` → `name`,
 * `Users.verifyEmail` → `emailVerified`, and only when it flips). qadi's
 * `UserAttributes` resolver reads those attributes, so an application-scoped
 * `DecisionCache` needs a signal to flush on — `@awthaq/qadi`'s
 * `DecisionCacheInvalidationLive` taps this one. Optional at the call site:
 * `Users` reads it through `Effect.serviceOption`, so a composition that does
 * not provide it (or does not care) is unchanged.
 */
const UserAttributesChangedInput = Schema.Struct({
  userId: Schema.String,
  attributes: Schema.Array(Schema.String),
});
export class AfterUserAttributesChanged extends HookPoint.observe<AfterUserAttributesChanged>()(
  "auth.user.attributesChanged",
  UserAttributesChangedInput,
) {}

/**
 * Every point's own default (no-tap) layer, merged into one — an
 * application composing any of `Users`/`Password`/`OAuth`/`Passkey`
 * needs this once, the same way `OrganizationHooksLive` already covers
 * `@awthaq/organization`'s own points. A tap's Layer requires its point
 * (ELC-001), so a composition that `.tap(...)`s one provides this *to* the
 * tap (`Tap.pipe(Layer.provideMerge(HooksLive))`): the registry lives in the
 * point's built layer, per composition — see `HookPoint.ts`'s header.
 */
export const HooksLive = Layer.mergeAll(
  BeforeSignUp.layer,
  AfterSignUp.layer,
  BeforeSignIn.layer,
  AfterSignIn.layer,
  BeforeSessionIssue.layer,
  BeforeUserDelete.layer,
  AfterUserAttributesChanged.layer,
);
