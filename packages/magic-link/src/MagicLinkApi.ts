// @awthaq/magic-link — MagicLinkApi
//
// BAM-007, MLO-005 (BEH-EA-264 to BEH-EA-267): the magic-link contract — one public group, `magicLink`,
// two endpoints, **both POST**. There is deliberately no GET route: a mail scanner, a link
// previewer or a browser prefetch dereferences every URL in a message, and a link that signs a
// person in on GET is consumed (and a session minted) by the scanner before the person clicks.
// The emailed URL instead carries the token in its **fragment** (`/magic-link#token=...`), which is
// never sent to a server, logged, or put in a `Referer`; the application's own page reads the
// fragment and POSTs it to `/magic-link/verify` only after the person acts on it (see the README's
// interstitial pattern).
//
// `request` answers `202` identically for a known address, an unknown one and a rate-limited-away
// one's mail — the response never says whether an account exists (BEH-EA-64). `verify` answers with
// the same `SessionDto` a password sign-in does; every failure of the token itself is the one
// `MagicLinkConsumed` (410, BEH-EA-59's shape): unknown, expired, replayed and foreign tokens are
// indistinguishable.

import { Api, EmailContract, SessionContract } from "@awthaq/api";
import { HookPoint, Hooks, Users } from "@awthaq/core";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

/** BEH-EA-59: the link is unknown, expired, already used, or not a magic link at all — one error for all of them. */
export class MagicLinkConsumed extends Schema.TaggedError<MagicLinkConsumed>()(
  "MagicLinkConsumed",
  {},
  { httpApiStatus: 410 },
) {}

export const RequestPayload = Schema.Struct({ email: EmailContract.Email });
export type RequestPayload = typeof RequestPayload.Type;

export const VerifyPayload = Schema.Struct({
  token: Schema.Redacted(Schema.String.check(Schema.isMaxLength(512))),
});
export type VerifyPayload = typeof VerifyPayload.Type;

export const MagicLinkGroup = HttpApiGroup.make("magicLink")
  .add(
    HttpApiEndpoint.post("request", "/magic-link/request", {
      payload: RequestPayload,
      success: HttpApiSchema.Empty(202),
      error: Api.RateLimited,
    }),
  )
  .add(
    HttpApiEndpoint.post("verify", "/magic-link/verify", {
      payload: VerifyPayload,
      success: SessionContract.SessionDto,
      // Plain array: each member's own `httpApiStatus` is honoured per member (see `PasswordApi.ts`).
      error: [
        MagicLinkConsumed,
        Api.RateLimited,
        // NAM-002: a `BeforeSignIn` / `BeforeSignUp` veto tap refused.
        HookPoint.HookAborted,
        // ARF-005 Fix A: the user has a second factor — a `BeforeSessionIssue` tap diverts.
        Hooks.TwoFactorRequired,
        // SCP-001: `Users.assertCanSignIn` refused.
        Users.UserSuspended,
        // MNA-001: an unrecognised `X-Awthaq-Token-Delivery` value.
        Api.InvalidTokenDelivery,
      ],
    }),
  )
  // Public and anonymous by design, but still unsafe-method endpoints a browser reaches: CSRF-worth
  // protecting the same as `PasswordApi.ts`'s public `signIn`.
  .middleware(Api.CsrfProtection);

export const MagicLinkApi = HttpApi.make("auth").add(MagicLinkGroup);
