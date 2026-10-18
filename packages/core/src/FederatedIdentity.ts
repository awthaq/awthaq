// @awthaq/core — FederatedIdentity (ADR-EA-043, BEH-EA-338)
//
// A federated sign-in (an OAuth provider, an organization's OIDC connection, an organization's SAML
// connection) ends with one question: which local user is this external identity? Both federated plugins
// answered it by hand with the same five steps (anchor read, email holder, trust decision, sign-up, sign-in),
// the copies drifted, and neither owned the race the steps open: two requests that proved the SAME
// `(providerId, subject, issuer)` collided on a unique constraint and each plugin mapped the loss to whatever
// was nearest (a 500, or a refusal telling the person to sign in with the provider they just used).
//
// This module is the one implementation, next to `SignIn` and `SignUp`:
//
// - `resolve(identity, trust)`: the anchor's user, else the holder of the asserted address when the caller's
//   verdict allows a link, else a new user through `SignUp` (verified in the same unit under the same verdict
//   minus the holder).
// - `attach(identity, userId)`: the explicit "link this provider to my account" flow.
// - A lost race (a concurrent link, create, unlink or erasure) reads the anchor again, once: the winner's user
//   is the answer, exactly what the same request would have got a millisecond later (INV-EA-015). A second loss
//   is the typed `Contended` refusal, never a defect and never an outage (ADR-EA-028, ADR-EA-038 decision 4).
//
// The plugin keeps the protocol, its trust verdict (`EmailTrust`, computed from its own configuration), the
// wire answer for each refusal, and everything after resolution (`SignIn.complete`). A plugin resolves this
// once inside its `make` (`FederatedIdentity.make`), like `SignIn` and `SignUp`.

import { AccountContract } from "@awthaq/api";
import { Defects, SqlTransaction } from "@awthaq/ports";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Accounts from "./Accounts.ts";
import * as AuthEvents from "./AuthEvents.ts";
import type { StoreUnavailable } from "./Errors.ts";
import type * as HookPoint from "./HookPoint.ts";
import * as SignUp from "./SignUp.ts";
import * as Users from "./Users.ts";

// The services and hook points `make` requires (SignUp's, which embed the sign-in steps') ride this namespace so a
// plugin whose inferred layer type mentions them can name them through the `FederatedIdentity` import (TS2883).
export {
  AfterSignIn,
  AfterSignUp,
  BeforeSessionIssue,
  BeforeSignIn,
  BeforeSignUp,
} from "./Hooks.ts";
export { Accounts } from "./Accounts.ts";
export { SqlTransaction };
export { SignInContinuationRegistry } from "./SignInContinuationRegistry.ts";

/** An address an asserting party proved (or claimed) for a person. */
export interface AssertedEmail {
  readonly address: string;
  /**
   * Whether the asserting party vouches for the address (OIDC `email_verified`). A SAML assertion has no
   * per-claim flag: the signed assertion is the IdP's directory speaking, so SAML passes `true` and whether
   * that directory is believed is the trust verdict's business.
   */
  readonly verified: boolean;
}

/** What an asserting party (an OAuth provider, an OIDC or SAML connection) proved about a person. */
export interface ExternalIdentity {
  /** The account's `providerId` and the sign-up's `strategy`: a provider id, `org:<org>:<conn>`, `saml:<org>:<conn>`. */
  readonly providerId: string;
  /** OIDC `sub`, a provider's immutable id, a SAML NameID. Compared exactly, never case-folded. */
  readonly subject: string;
  /** BEH-EA-125: the anchor's third component. `None` for a plain OAuth2 provider. */
  readonly issuer: Option.Option<string>;
  readonly email: Option.Option<AssertedEmail>;
  readonly name: Option.Option<string>;
  /** NAM-009: kept only when it is an http(s) URL (`AccountContract.ImageUrl`); dropped here otherwise. */
  readonly image: Option.Option<string>;
  /** BE-002: stored on the account when it is linked or created, and replaces the stored set on a returning sign-in. */
  readonly tokens: Option.Option<Accounts.ProviderTokenSet>;
}

/** The caller's verdict on the asserting party's email claims (BEH-EA-124, BEH-EA-245). Required: no default. */
export type EmailTrust =
  | { readonly _tag: "Untrusted" }
  | { readonly _tag: "Trusted"; readonly domains: "any" | ReadonlyArray<string> };

export const untrusted: EmailTrust = { _tag: "Untrusted" };
/**
 * `"any"`: a provider trusted for every address it verifies. A list: only addresses in these domains
 * (a connection's claimed domains); an empty list links nothing.
 */
export const trusted = (domains: "any" | ReadonlyArray<string>): EmailTrust => ({
  _tag: "Trusted",
  domains,
});

/** Who the identity is, and how that was decided. */
export type Resolved =
  /** The anchor already named a user (a returning sign-in). */
  | { readonly _tag: "Linked"; readonly userId: Users.UserId }
  /** Linked into the existing holder of the address: trusted party, address in its domains, both sides verified. */
  | { readonly _tag: "AutoLinked"; readonly userId: Users.UserId }
  /** A user was created through `SignUp` with the identity linked in the same unit. */
  | {
      readonly _tag: "Created";
      readonly userId: Users.UserId;
      readonly user: Users.UserRecord;
    };

export interface Attached {
  readonly userId: Users.UserId;
  /** `true`: the identity was already linked to this very user (a repeated link): nothing new, tokens replaced. */
  readonly already: boolean;
}

/** Why a holder of the address was not linked into. The caller decides what (if anything) to reveal. */
export type EmailRefusal =
  | "untrusted"
  | "outsideTrustedDomains"
  | "claimUnverified"
  | "localUnverified";

/** BEH-EA-123/245: the address belongs to a local user this identity may not be linked into. Each caller maps it. */
export class EmailInUse extends Data.TaggedError("FederatedIdentity/EmailInUse")<{
  readonly message: string;
  readonly holder: Users.UserId;
  readonly reason: EmailRefusal;
  /** OAuth's NAM-006 reveals the holder's providers only when the party vouched for the address. */
  readonly claimVerified: boolean;
}> {}

/** `attach`: the identity is already linked to another user. */
export class LinkedElsewhere extends Data.TaggedError("FederatedIdentity/LinkedElsewhere")<{
  readonly message: string;
}> {}

/** `attach`: the user the link was started for no longer exists. */
export class TargetGone extends Data.TaggedError("FederatedIdentity/TargetGone")<{
  readonly message: string;
  readonly userId: Users.UserId;
}> {}

/** The anchor changed under the resolution twice in a row (a pathological interleaving). Never a defect. */
export class Contended extends Data.TaggedError("FederatedIdentity/Contended")<{
  readonly message: string;
}> {}

export type ResolveError = EmailInUse | Contended | HookPoint.HookAborted | StoreUnavailable;
export type AttachError = LinkedElsewhere | TargetGone | Contended | StoreUnavailable;

export interface FederatedIdentityShape {
  /**
   * The anchor's user, else the address holder if `trust` allows (auto-link), else a new user through
   * `SignUp` (`BeforeSignUp` with `strategy = providerId`; verified in the same unit when `trust` allows).
   * A lost race reads the anchor again, once: the winner's user is the answer.
   */
  readonly resolve: (
    identity: ExternalIdentity,
    trust: EmailTrust,
  ) => Effect.Effect<Resolved, ResolveError>;
  /** The explicit "link this provider to my account" flow (no email policy: the caller is signed in as `userId`). */
  readonly attach: (
    identity: ExternalIdentity,
    userId: Users.UserId,
  ) => Effect.Effect<Attached, AttachError>;
}

/** The anchor moved under this attempt (a concurrent link, create, unlink or erasure). Module-private: never escapes `make`. */
class Lost extends Data.TaggedError("FederatedIdentity/Lost")<{}> {}
const isLost = (error: unknown): error is Lost => error instanceof Lost;

/** One re-read after a lost race; a second loss is `Contended`. */
const onceMore = <A, E, R>(attempt: Effect.Effect<A, E | Lost, R>) =>
  attempt.pipe(
    Effect.catchIf(isLost, () => attempt),
    Effect.catchIf(isLost, () =>
      Effect.fail(
        new Contended({
          message: "awthaq: the federated identity changed twice while it was resolved",
        }),
      ),
    ),
  );

/** NAM-009: the same bounded http(s) rule the client-writable `image` field has. */
const isImageUrl = Schema.is(AccountContract.ImageUrl);

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();
const withinDomains = (domains: "any" | ReadonlyArray<string>, address: string) =>
  domains === "any" || domains.some((domain) => domain.toLowerCase() === domainOf(address));

/** TMS-007, BEH-EA-124, BEH-EA-245, decided once: trusted party, address in its domains, both sides verified. */
const refusalOf = (
  trust: EmailTrust,
  email: AssertedEmail,
  holder: Users.UserRecord,
): Option.Option<EmailRefusal> =>
  trust._tag === "Untrusted"
    ? Option.some<EmailRefusal>("untrusted")
    : !withinDomains(trust.domains, email.address)
      ? Option.some<EmailRefusal>("outsideTrustedDomains")
      : !email.verified
        ? Option.some<EmailRefusal>("claimUnverified")
        : !Users.isEmailVerified(holder)
          ? Option.some<EmailRefusal>("localUnverified")
          : Option.none();

/** AOMS-007: the same verdict, minus the local side, marks a created user verified in the sign-up's unit. */
const verifiesOnCreate = (trust: EmailTrust, email: Option.Option<AssertedEmail>) =>
  trust._tag === "Trusted" &&
  Option.isSome(email) &&
  email.value.verified &&
  withinDomains(trust.domains, email.value.address);

/** FAMS-002: no address, an Anonymous user (upgradeable through `Users.promoteIdentity`). */
const identityOf = (email: Option.Option<AssertedEmail>): Users.IdentityInput =>
  Option.match(email, {
    onNone: (): Users.IdentityInput => ({ _tag: "Anonymous" }),
    onSome: (asserted): Users.IdentityInput => ({ _tag: "Email", email: asserted.address }),
  });

/** Case and image rules applied once, before any read. */
const normalized = (identity: ExternalIdentity): ExternalIdentity => ({
  ...identity,
  email: Option.map(identity.email, (asserted) => ({
    ...asserted,
    address: asserted.address.toLowerCase(),
  })),
  image: Option.filter(identity.image, isImageUrl),
});

const linked = (userId: Users.UserId): Resolved => ({ _tag: "Linked", userId });
const autoLinked = (userId: Users.UserId): Resolved => ({ _tag: "AutoLinked", userId });
const created = (user: Users.UserRecord): Resolved => ({
  _tag: "Created",
  userId: user.id,
  user,
});
const attached = (userId: Users.UserId, already: boolean): Attached => ({ userId, already });

/** Resolves the core services once, at plugin build; the returned closures carry no further requirements. */
export const make = Effect.gen(function* () {
  const users = yield* Users.Users;
  const accounts = yield* Accounts.Accounts;
  const events = yield* AuthEvents.AuthEvents;
  const signUp = yield* SignUp.make;

  const anchorOf = (identity: ExternalIdentity) =>
    accounts.findByProviderSubject(
      identity.providerId,
      identity.subject,
      Option.getOrUndefined(identity.issuer),
    );

  const linkFor = (identity: ExternalIdentity): SignUp.LinkInput => ({
    providerId: identity.providerId,
    subject: identity.subject,
    ...Option.match(identity.issuer, { onNone: () => ({}), onSome: (issuer) => ({ issuer }) }),
    ...Option.match(identity.tokens, { onNone: () => ({}), onSome: (tokens) => ({ tokens }) }),
  });

  /** BE-002: a returning sign-in replaces the stored set; an account that vanished since the read is a lost race. */
  const refresh = (account: Accounts.AccountRecord, identity: ExternalIdentity) =>
    Option.match(identity.tokens, {
      onNone: () => Effect.void,
      onSome: (tokens) =>
        accounts
          .updateProviderTokens(account.id, tokens)
          .pipe(Effect.catchTag("AccountNotFound", () => Effect.fail(new Lost()))),
    });

  /** A link this module made is announced; a lost link is a lost race. */
  const linkTo = (
    identity: ExternalIdentity,
    userId: Users.UserId,
    via: "emailMatch" | "explicit",
  ) =>
    accounts.link({ ...linkFor(identity), userId }).pipe(
      Effect.catchTag("AccountAlreadyLinked", () => Effect.fail(new Lost())),
      Effect.andThen(
        events.publish({
          _tag: "auth.account.linked",
          userId,
          providerId: identity.providerId,
          via,
        }),
      ),
    );

  const resolveOnce = Effect.fnUntraced(function* (identity: ExternalIdentity, trust: EmailTrust) {
    const anchored = yield* anchorOf(identity);
    if (Option.isSome(anchored)) {
      yield* refresh(anchored.value, identity);
      return linked(anchored.value.userId);
    }
    if (Option.isSome(identity.email)) {
      const holder = yield* users.findByEmail(identity.email.value.address);
      if (Option.isSome(holder)) {
        const refusal = refusalOf(trust, identity.email.value, holder.value);
        if (Option.isSome(refusal)) {
          // The "holder" may be the user a concurrent first sign-in for this very identity just created.
          const winner = yield* anchorOf(identity);
          if (Option.isSome(winner)) return yield* new Lost();
          return yield* new EmailInUse({
            message:
              "awthaq: the asserted address belongs to an account this identity is not linked to",
            holder: holder.value.id,
            reason: refusal.value,
            claimVerified: identity.email.value.verified,
          });
        }
        yield* linkTo(identity, holder.value.id, "emailMatch");
        return autoLinked(holder.value.id);
      }
    }
    const vetted = yield* signUp.vet({
      identity: identityOf(identity.email),
      name: Option.getOrElse(identity.name, () =>
        Option.match(identity.email, {
          onNone: () => identity.subject,
          onSome: (asserted) => asserted.address,
        }),
      ),
      strategy: identity.providerId,
    });
    const user = yield* signUp
      .create(vetted, {
        verified: verifiesOnCreate(trust, identity.email),
        ...Option.match(identity.image, {
          onNone: () => ({}),
          onSome: (image) => ({ image }),
        }),
        link: linkFor(identity),
      })
      .pipe(
        Effect.catchTag("SignUp/IdentityTaken", (taken) =>
          taken.kind === "Phone"
            ? // No federated party creates a phone identity (FAMS-002).
              Defects.invariantViolation("FederatedSignUpPhone", taken.message)
            : // The address or the anchor was claimed between our reads and this insert: read again.
              Effect.fail(new Lost()),
        ),
      );
    return created(user);
  });

  const attachOnce = Effect.fnUntraced(function* (
    identity: ExternalIdentity,
    userId: Users.UserId,
  ) {
    const anchored = yield* anchorOf(identity);
    if (Option.isSome(anchored)) {
      if (anchored.value.userId !== userId) {
        return yield* new LinkedElsewhere({
          message: "awthaq: that identity is linked to another account",
        });
      }
      yield* refresh(anchored.value, identity);
      return attached(userId, true);
    }
    yield* users
      .findById(userId)
      .pipe(
        Effect.catchTag("UserNotFound", () =>
          Effect.fail(new TargetGone({ message: "awthaq: no such user", userId })),
        ),
      );
    yield* linkTo(identity, userId, "explicit");
    return attached(userId, false);
  });

  return {
    resolve: (identity, trust) => onceMore(resolveOnce(normalized(identity), trust)),
    attach: (identity, userId) => onceMore(attachOnce(normalized(identity), userId)),
  } satisfies FederatedIdentityShape;
});
