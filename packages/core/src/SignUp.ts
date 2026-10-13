// @awthaq/core — SignUp (ADR-EA-038, BEH-EA-323)
//
// Six flows create a user on a person's or a directory's behalf (password in both its reveal and
// conceal modes, OAuth first login, SAML first login, magic link and email OTP, SCIM), and five of
// them hand-wrote "run `BeforeSignUp`, create, verify and link in one transaction, announce". The
// copies drifted: SCIM never consulted the veto nor published `auth.user.created`, and its rollback
// called a delete that a legal-hold tap could veto, stranding a half-provisioned user. This module
// is the one implementation:
//
// - `vet(application)` runs `BeforeSignUp` and returns a branded `Vetted`: `create`, `createWith`
//   and `createSignedIn` accept nothing else, so a user cannot be created without the veto having
//   run (the brand's constructor is module-private).
// - They own the transaction (create, mark verified, link the credential and the caller's own
//   `within` work are one unit that leaves nothing behind on failure, memory compositions included:
//   they are built on `Users.createWith`, which abandons the half-made user), one `IdentityTaken`
//   conflict, and the announcements, published only after the unit commits.
// - `createSignedIn` also mints the first session, as a cleared sign-in (the gate, `BeforeSignIn`,
//   `BeforeSessionIssue`, `auth.user.signedIn`, `AfterSignIn`), inside the same unit
//   (BEH-EA-113: user and session are one transaction).
//
// Operator migrations (`UserImport.importUser`, `awthaq seed admin`) are not sign-ups and do not
// come through here. A plugin resolves this once inside its `make` (`SignUp.make`), like `SignIn`.

import { Defects, SqlTransaction } from "@awthaq/ports";
import * as Brand from "effect/Brand";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isSqlError } from "effect/unstable/sql/SqlError";
import * as Accounts from "./Accounts.ts";
import * as AuthEvents from "./AuthEvents.ts";
import * as Errors from "./Errors.ts";
import * as HookPoint from "./HookPoint.ts";
import * as Hooks from "./Hooks.ts";
import * as SignInSteps from "./internal/signInSteps.ts";
import type * as Sessions from "./Sessions.ts";
import type * as SignIn from "./SignIn.ts";

// The two sign-up hook points `make` requires ride this namespace so a plugin whose inferred layer type
// mentions them can name them through the `SignUp` import it already has (TS2883).
export { AfterSignUp, BeforeSignUp } from "./Hooks.ts";
import * as Users from "./Users.ts";

/** What a flow knows when it wants an account to exist. */
export interface Application {
  readonly identity: Users.IdentityInput;
  readonly name: string;
  /** `password`, an OAuth provider id, `saml:<org>:<conn>`, `magicLink`, `emailOtp`, `scim:<org>:<conn>`. */
  readonly strategy: string;
}

/** An application the `BeforeSignUp` veto passed (and possibly amended). Only `vet` mints one. */
export type Vetted = Application & Brand.Brand<"awthaq/SignUp/Vetted">;
const vetted = Brand.nominal<Vetted>();

/** One conflict for every way a fresh account can collide; the caller picks its own wire answer. */
export class IdentityTaken extends Data.TaggedError("SignUp/IdentityTaken")<{
  readonly message: string;
  readonly kind: "Email" | "Phone" | "Account";
}> {}

export type LinkInput = Omit<Parameters<Accounts.AccountsShape["link"]>[0], "userId">;

export interface CreateOptions {
  /** The identity is already proven (a trusted OAuth `email_verified`, a consumed mailbox proof): marked verified in the same unit. */
  readonly verified?: boolean;
  readonly image?: string;
  readonly metadata?: string;
  /** The credential account linked in the same unit; a function when the subject is the new user's own id (a password account). */
  readonly link?: LinkInput | ((user: Users.UserRecord) => LinkInput);
}

export interface SignUpShape {
  /** `BeforeSignUp`: a tap may abort, or amend `name` and `email`. */
  readonly vet: (application: Application) => Effect.Effect<Vetted, HookPoint.HookAborted>;
  /** Create (+ verify + link) in one unit, then announce `auth.user.created` and run `AfterSignUp`. */
  readonly create: (
    application: Vetted,
    options?: CreateOptions,
  ) => Effect.Effect<Users.UserRecord, IdentityTaken | Errors.StoreUnavailable>;
  /** `within` runs inside the same unit after create/verify/link; a failure rolls everything back. */
  readonly createWith: <A, E, R>(
    application: Vetted,
    options: CreateOptions,
    within: (user: Users.UserRecord) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<
    { readonly user: Users.UserRecord; readonly value: A },
    IdentityTaken | E | Errors.StoreUnavailable,
    R
  >;
  /**
   * Create + clear + mint in one unit (BEH-EA-113), then announce the sign-up and the sign-in.
   * A `BeforeSignIn` veto rolls the account back; a divert commits the account (and the owner's
   * challenge) and answers `TwoFactorRequired`.
   */
  readonly createSignedIn: (
    application: Vetted,
    options: CreateOptions & { readonly amr: ReadonlyArray<Sessions.AuthMethod> },
    request?: SignIn.SessionRequest,
  ) => Effect.Effect<
    SignIn.IssuedSession,
    IdentityTaken | HookPoint.HookAborted | Hooks.TwoFactorRequired | Errors.StoreUnavailable
  >;
}

/** Resolves the core services once, at plugin build; the returned closures carry no further requirements. */
export const make = Effect.gen(function* () {
  const users = yield* Users.Users;
  const accounts = yield* Accounts.Accounts;
  const events = yield* AuthEvents.AuthEvents;
  const sqlTransaction = yield* SqlTransaction.SqlTransaction;
  const beforeSignUp = yield* Hooks.BeforeSignUp;
  const afterSignUp = yield* Hooks.AfterSignUp;
  const steps = yield* SignInSteps.makeSteps;

  const vet: SignUpShape["vet"] = Effect.fnUntraced(function* (application) {
    const original = application.identity._tag === "Email" ? application.identity.email : undefined;
    const amended = yield* HookPoint.aborted(Hooks.BeforeSignUp)(
      beforeSignUp.run({
        ...(original === undefined ? {} : { email: original }),
        name: application.name,
        strategy: application.strategy,
      }),
    );
    // An email application keeps its address even if a tap drops it; an anonymous one becomes an
    // email identity if a tap supplies an address; a phone application is unchanged (the hook has
    // no phone field).
    const identity: Users.IdentityInput =
      application.identity._tag === "Phone"
        ? application.identity
        : amended.email !== undefined
          ? { _tag: "Email", email: amended.email }
          : application.identity;
    return vetted({ identity, name: amended.name, strategy: application.strategy });
  });

  /** The mailbox or number is proven: the one-way verified flip. A user just created always has the identity being verified. */
  const markVerified = Effect.fnUntraced(function* (user: Users.UserRecord) {
    switch (user.identity._tag) {
      case "Email":
        return yield* users.verifyEmail(user.id);
      case "Phone":
        return yield* users.verifyPhone(user.id);
      case "Anonymous":
        return user;
    }
  });

  /** The one transaction every create shares. */
  const runCreate = <A, E, R>(
    application: Vetted,
    options: CreateOptions,
    within: (user: Users.UserRecord) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const result = yield* sqlTransaction
        .withTransaction(
          users.createWith(
            {
              identity: application.identity,
              name: application.name,
              ...(options.image === undefined ? {} : { image: options.image }),
              ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
            },
            (created) =>
              Effect.gen(function* () {
                const user =
                  options.verified === true
                    ? yield* markVerified(created).pipe(
                        Effect.catchTags({
                          UserNotFound: (gone) =>
                            Defects.invariantViolation("SignUpUserGone", gone.message),
                          IdentityMismatch: (mismatch) =>
                            Defects.invariantViolation("SignUpIdentityMismatch", mismatch.message),
                        }),
                      )
                    : created;
                if (options.link !== undefined) {
                  yield* accounts
                    .link({
                      ...(typeof options.link === "function" ? options.link(user) : options.link),
                      userId: user.id,
                    })
                    .pipe(
                      Effect.catchTag(
                        "AccountAlreadyLinked",
                        () =>
                          new IdentityTaken({
                            kind: "Account",
                            message: "awthaq: that credential is already linked to an account",
                          }),
                      ),
                    );
                }
                return { user, value: yield* within(user) };
              }).pipe(
                // A composition without a real transaction (memory) rolls nothing back: take the credential
                // this call linked with the user `Users.createWith` abandons. In SQL the rollback did it.
                Effect.onError(() =>
                  accounts.deleteAllByUser(created.id).pipe(Effect.ignoreCause({ log: true })),
                ),
              ),
          ),
        )
        .pipe(
          // The transaction's own `SqlError` is an outage (ADR-EA-028), never a defect.
          Effect.catchIf(isSqlError, Errors.storeUnavailable("SignUp.create")),
          Effect.catchIf(
            (error): error is Users.EmailAlreadyExists => error instanceof Users.EmailAlreadyExists,
            (taken) => Effect.fail(new IdentityTaken({ kind: "Email", message: taken.message })),
          ),
          Effect.catchIf(
            (error): error is Users.PhoneAlreadyExists => error instanceof Users.PhoneAlreadyExists,
            (taken) => Effect.fail(new IdentityTaken({ kind: "Phone", message: taken.message })),
          ),
        );
      // Announced only after the unit committed: nobody hears of an account that was rolled back.
      yield* events.publish({ _tag: "auth.user.created", userId: result.value.user.id });
      yield* afterSignUp.run({
        userId: result.value.user.id,
        ...Users.emailField(result.value.user),
        strategy: application.strategy,
      });
      return result.value;
    });

  const createWith: SignUpShape["createWith"] = (application, options, within) =>
    runCreate(application, options, within);

  const create: SignUpShape["create"] = (application, options) =>
    Effect.map(
      runCreate(application, options ?? {}, () => Effect.void),
      (created) => created.user,
    );

  /** The two in-unit outcomes of a sign-up that wants a session. */
  type Outcome =
    | { readonly _tag: "Diverted"; readonly diverted: Hooks.TwoFactorRequired }
    | {
        readonly _tag: "Minted";
        readonly cleared: SignInSteps.Clearance;
        readonly issued: SignInSteps.IssuedSession;
      };
  const diverted = (value: Hooks.TwoFactorRequired): Outcome => ({
    _tag: "Diverted",
    diverted: value,
  });
  const minted = (cleared: SignInSteps.Clearance, issued: SignInSteps.IssuedSession): Outcome => ({
    _tag: "Minted",
    cleared,
    issued,
  });

  const createSignedIn: SignUpShape["createSignedIn"] = (application, options, request) =>
    Effect.gen(function* () {
      // Inside the unit: clear (a veto aborts, which rolls the account back; a divert becomes a value
      // so the account and the owner's challenge commit), then mint. `runCreate` announces the
      // *sign-up* after the commit; the *sign-in* is announced below, after it too.
      const { value } = yield* runCreate(application, options, (fresh) =>
        steps.clear({ userId: fresh.id, strategy: application.strategy, amr: options.amr }).pipe(
          Effect.flatMap((cleared) =>
            Effect.map(steps.mint(cleared, request), (issued) => minted(cleared, issued)),
          ),
          Effect.catchTags({
            "SignIn/UserGone": (gone) => Defects.invariantViolation("SignUpUserGone", gone.message),
            UserSuspended: () =>
              Defects.invariantViolation(
                "SignUpUserSuspended",
                "awthaq: a fresh user is suspended",
              ),
            TwoFactorRequired: (required) => Effect.succeed(diverted(required)),
          }),
        ),
      );
      if (value._tag === "Diverted") return yield* Effect.fail(value.diverted);
      return yield* steps.announce(value.cleared, value.issued);
    });

  return { vet, create, createWith, createSignedIn } satisfies SignUpShape;
});
