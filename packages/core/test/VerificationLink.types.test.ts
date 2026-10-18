// BEH-EA-057, ADR-EA-039 decision 9: the guarantees the type system carries for link purposes. These
// are compile-time checks — `tsc -p tsconfig.test.json` is the assertion (`@ts-expect-error` fails
// the build when the line it covers stops being an error) — with a token runtime test so the file is
// a suite.
import { it } from "@effect/vitest";
import type * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as EmailChange from "../src/EmailChange.ts";
import type { UserId } from "../src/Users.ts";
import type { VerificationShape } from "../src/Verification.ts";
import * as VerificationLink from "../src/VerificationLink.ts";

const ResetLink = VerificationLink.forUser({ name: "reset-password" });
const VerifyLink = VerificationLink.forUser({ name: "verify-email" });
const AddressLink = VerificationLink.forAddress({
  name: "magic-link",
  payload: Schema.Struct({ email: Schema.String }),
});

declare const deps: { readonly verification: VerificationShape; readonly crypto: Crypto.Crypto };
declare const userId: UserId;
declare const wire: Redacted.Redacted<string>;
const ttl = Duration.hours(1);

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// A required user that is not there.
export const issueNeedsTheUser = () =>
  // @ts-expect-error `userId` is required by `forUser`
  VerificationLink.issue(deps, ResetLink, { ttl });

// A payload written in one shape and read in another.
export const issueChecksThePayload = () =>
  // @ts-expect-error the change-email payload is `{ newEmail }`
  VerificationLink.issue(deps, EmailChange.Link, { ttl, userId, payload: { email: "x" } });

// `use` receives the purpose's own typed link.
export const useGetsTheTypedLink = () => {
  const reset = VerificationLink.redeemer(ResetLink, {
    verification: deps.verification,
    budget: { source: "caller", token: "none" },
  });
  return reset({ token: wire }, (link) => {
    const exact: Equals<
      typeof link,
      VerificationLink.Link<"reset-password", UserId, undefined>
    > = true;
    return Effect.succeed(exact);
  });
};
export const addressUseGetsAnOptionalUser = () => {
  const magic = VerificationLink.redeemer(AddressLink, {
    verification: deps.verification,
    budget: { source: "caller", token: "none" },
  });
  return magic({ token: wire }, (link) => {
    const exact: Equals<typeof link.userId, Option.Option<UserId>> = true;
    return Effect.succeed(exact);
  });
};

// A link of one purpose is not another's.
export const linksOfTwoPurposesDoNotMix = (
  needsVerify: (link: VerificationLink.LinkOf<typeof VerifyLink>) => void,
  reset: VerificationLink.LinkOf<typeof ResetLink>,
) =>
  // @ts-expect-error a reset link is not a verify-email link
  needsVerify(reset);

// A token minted for purpose A is not accepted by purpose B's redeemer; a plain wire token is.
const verifyRedeemer = () =>
  VerificationLink.redeemer(VerifyLink, {
    verification: deps.verification,
    budget: { source: "caller", token: "none" },
  });
export const crossPurposeHandoff = (issued: VerificationLink.IssuedLink<"reset-password">) => {
  const verify = verifyRedeemer();
  // @ts-expect-error a token minted for reset-password is not a verify-email token
  const crossed = verify({ token: issued.token }, Effect.succeed);
  const fromTheWire = verify({ token: wire }, Effect.succeed);
  return [crossed, fromTheWire];
};

// A link endpoint with no budget decision.
export const budgetNeedsBothDeclarations = () =>
  VerificationLink.redeemer(ResetLink, {
    verification: deps.verification,
    // @ts-expect-error `token` is required: say `"none"` to opt out
    budget: { source: "caller" },
  });

it("is a compile-time suite", () => {});
