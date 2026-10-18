// @awthaq/core — VerificationLink
//
// spec/behaviors/08-verification-tokens.md, BEH-EA-057, ADR-EA-039 decision 9. The shared,
// purpose-checked codec every plugin that hands a `Verification` token to a client uses (password
// reset, verify-email and change-email links, magic links, the two-factor challenge, and the
// burn-first OAuth/SAML state), so the bugs that codec closes — a token of one purpose accepted by
// another purpose's endpoint (ARF-007), a user id embedded in a mailed artifact (ARF-009), no expiry
// or link in the mail (MLO-009) — are fixed once rather than per plugin.
//
// A token is `<identifier>.<secret>`; `identifier` is `<purpose>:<publicId>` and names the
// `Verification` row (its claim needs it to look the row up at all), `secret` is the row's own
// value. `publicId` is 128 random bits, base64url — it identifies the token, never the user
// (ARF-009); the user is recovered from the claimed row's `userId`. None of `purpose`, `publicId` or
// `secret` can contain a literal `.`, so splitting on the last `.` round-trips exactly.
//
// A *purpose* is a value (`forUser` / `forAddress`): its name, its payload schema, whether its row
// names a user, and how the public id is chosen. The code that mints a token (`issue`) and the code
// that redeems it (`redeemer`) share it, so the payload written and the payload read are one
// schema. The redeemer owns the order every link endpoint follows: per-source budget, decode for
// exactly this purpose, per-token budget, an optional pre-claim check, then `Verification.redeem`.

import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { storeUnavailable } from "./Errors.ts";
import type { UserId } from "./Users.ts";
import type { Settlement, VerificationShape, VerificationTokenView } from "./Verification.ts";

export interface DecodedToken {
  /** The `Verification` row's identifier, `<purpose>:<publicId>`. */
  readonly identifier: string;
  readonly publicId: string;
  readonly value: Redacted.Redacted<string>;
}

/** A fresh, unguessable, user-independent id for one token. */
export const newPublicId = (crypto: Crypto.Crypto) =>
  crypto.randomBytes(16).pipe(Effect.map((bytes) => Encoding.encodeBase64Url(bytes)));

export const identifierOf = (purpose: string, publicId: string): string => `${purpose}:${publicId}`;

/** The token string handed to the recipient. Redacted: it is a credential. */
export const encode = (input: {
  readonly purpose: string;
  readonly publicId: string;
  readonly value: Redacted.Redacted<string>;
}): Redacted.Redacted<string> =>
  Redacted.make(`${identifierOf(input.purpose, input.publicId)}.${Redacted.value(input.value)}`);

/**
 * `None` for anything that is not a well-formed token of exactly `purpose` (a codec-only record
 * `{ name }` is enough for the burn-first callers) —
 * a missing separator, an empty half, or another purpose's prefix — so an
 * endpoint answers it the way it answers any unknown token, before rate
 * limiting, consuming or slicing it.
 */
export const decode = (
  raw: string,
  purpose: { readonly name: string },
): Option.Option<DecodedToken> => {
  const separator = raw.lastIndexOf(".");
  if (separator <= 0 || separator === raw.length - 1) return Option.none();
  const identifier = raw.slice(0, separator);
  const prefix = `${purpose.name}:`;
  if (!identifier.startsWith(prefix) || identifier.length === prefix.length) return Option.none();
  return Option.some({
    identifier,
    publicId: identifier.slice(prefix.length),
    value: Redacted.make(raw.slice(separator + 1)),
  });
};

/**
 * BEH-EA-057: what `use` receives from a redeemer. `purpose` is the purpose's own literal name, so a
 * link of one purpose cannot be handed to code written for another's.
 */
export interface Link<Name extends string, UserRef, Payload> {
  readonly purpose: Name;
  readonly userId: UserRef;
  readonly payload: Payload;
}

/**
 * BEH-EA-057: a purpose of a token that travels through a client. Built only by `forUser` and
 * `forAddress`, which derive the `read`/`row` pair from the payload schema.
 */
export interface Purpose<Name extends string, L, IssueArgs> {
  readonly _tag: "VerificationLink/Purpose";
  readonly name: Name;
  /** How `issue` chooses the public id. `"user"`: one live link per user (issuing again supersedes). */
  readonly keyedBy: "random" | "user";
  /**
   * A claimed row as `use` receives it. `None` is a foreign row: no user where one is required, a
   * payload that does not decode, a user-keyed row whose user is not its public id.
   */
  read(token: VerificationTokenView, publicId: string): Option.Option<L>;
  /** What `issue` writes for `args`. */
  row(args: IssueArgs): {
    readonly userId: Option.Option<UserId>;
    readonly payload: unknown;
  };
}

export type LinkOf<P> = P extends Purpose<string, infer L, never> ? L : never;
export type IssueArgsOf<P> = P extends Purpose<string, unknown, infer I> ? I : never;

interface UserSpec<Name extends string> {
  readonly name: Name;
  readonly keyedBy?: "random" | "user";
}

/** A purpose whose every row names a user (`use` gets a `UserId`). */
export function forUser<const Name extends string>(
  spec: UserSpec<Name>,
): Purpose<Name, Link<Name, UserId, undefined>, { readonly userId: UserId }>;
export function forUser<const Name extends string, A>(
  spec: UserSpec<Name> & { readonly payload: Schema.Codec<A> },
): Purpose<Name, Link<Name, UserId, A>, { readonly userId: UserId; readonly payload: A }>;
export function forUser<const Name extends string, A>(
  spec: UserSpec<Name> & { readonly payload?: Schema.Codec<A> },
): Purpose<
  Name,
  Link<Name, UserId, A | undefined>,
  { readonly userId: UserId; readonly payload?: A }
> {
  const keyedBy = spec.keyedBy ?? "random";
  const decodePayload =
    spec.payload === undefined ? undefined : Schema.decodeUnknownOption(spec.payload);
  const made: Purpose<
    Name,
    Link<Name, UserId, A | undefined>,
    { readonly userId: UserId; readonly payload?: A }
  > = {
    _tag: "VerificationLink/Purpose",
    name: spec.name,
    keyedBy,
    read: (token, publicId) => {
      if (Option.isNone(token.userId)) return Option.none();
      if (keyedBy === "user" && token.userId.value !== publicId) return Option.none();
      const userId = token.userId.value;
      if (decodePayload === undefined) {
        return Option.some({ purpose: spec.name, userId, payload: undefined });
      }
      return Option.map(decodePayload(token.payload), (payload) => ({
        purpose: spec.name,
        userId,
        payload,
      }));
    },
    row: (args) => ({ userId: Option.some(args.userId), payload: args.payload }),
  };
  return made;
}

/** A purpose whose row may name no user yet (a link to an address that has no account). */
export const forAddress = <const Name extends string, A>(spec: {
  readonly name: Name;
  readonly payload: Schema.Codec<A>;
}) => {
  const decodePayload = Schema.decodeUnknownOption(spec.payload);
  const made: Purpose<
    Name,
    Link<Name, Option.Option<UserId>, A>,
    { readonly userId?: UserId | undefined; readonly payload: A }
  > = {
    _tag: "VerificationLink/Purpose",
    name: spec.name,
    keyedBy: "random",
    read: (token, _publicId) =>
      Option.map(decodePayload(token.payload), (payload) => ({
        purpose: spec.name,
        userId: token.userId,
        payload,
      })),
    row: (args) => ({ userId: Option.fromNullishOr(args.userId), payload: args.payload }),
  };
  return made;
};

/**
 * The phantom a minted token carries: the purpose it was minted for. A token off the wire has no
 * such key and is accepted by any redeemer (and checked at run time by `decode`); a token minted
 * for one purpose and handed in-process to another's redeemer does not type-check.
 */
export interface PresentedFor<Name extends string> {
  readonly "~linkPurpose"?: Name;
}

export interface IssuedLink<Name extends string = string> {
  readonly token: Redacted.Redacted<string> & PresentedFor<Name>;
  readonly publicId: string;
  readonly expiresAt: DateTime.Utc;
  readonly view: VerificationTokenView;
}

/**
 * Mints a row under `purpose` and returns the mailable token. Its public id is random, or the
 * user's id for a user-keyed purpose. `userId` rides on the row (BCR-003) so the redeeming endpoint
 * can recover it without it ever appearing in the token.
 */
export const issue = <const Name extends string, L, IssueArgs>(
  deps: { readonly verification: VerificationShape; readonly crypto: Crypto.Crypto },
  purpose: Purpose<Name, L, IssueArgs>,
  input: { readonly ttl: Duration.Duration } & IssueArgs,
) =>
  Effect.gen(function* () {
    const { userId, payload } = purpose.row(input);
    const publicId =
      purpose.keyedBy === "user" && Option.isSome(userId)
        ? userId.value
        : yield* newPublicId(deps.crypto).pipe(
            Effect.catchTag("PlatformError", storeUnavailable("VerificationLink.issue")),
          );
    const { token, value } = yield* deps.verification.issue({
      identifier: identifierOf(purpose.name, publicId),
      ttl: input.ttl,
      ...(Option.isSome(userId) ? { userId: userId.value } : {}),
      ...(payload === undefined ? {} : { payload }),
    });
    const issued: IssuedLink<Name> = {
      token: encode({ purpose: purpose.name, publicId, value }),
      publicId,
      expiresAt: token.expiresAt,
      view: token,
    };
    return issued;
  });

/** BEH-EA-057/ADR-EA-039: why a presented link was refused. Callers map it to one wire error; `reason` is for logs only. */
export class LinkRefused extends Data.TaggedError("VerificationLink/Refused")<{
  readonly purpose: string;
  /**
   * `malformed`: not a token of this purpose (never budgeted per token, the store untouched).
   * `missed`: unknown, expired, spent or wrong secret. `foreign`: claimed, but the row is not one
   * this purpose writes (spent).
   */
  readonly reason: "malformed" | "missed" | "foreign";
}> {}

/**
 * BEH-EA-105/APS-003: both budgets are declared where a link is bound. A link endpoint is public
 * and its token is attacker-supplied, so a missing budget must be a visible decision.
 */
export interface LinkBudget<E, R> {
  /** Spent first, before the token is decoded (a flood of garbage), keyed on the request's source. `"caller"`: the endpoint already spent it; say where in a comment. */
  readonly source: ((ip: string | undefined) => Effect.Effect<void, E, R>) | "caller";
  /** Spent once the token is well-formed, keyed on its public id (never the secret), before the store is touched. `"none"`: this purpose's guesses are budgeted elsewhere; say where. */
  readonly token: ((publicId: string) => Effect.Effect<void, E, R>) | "none";
}

const isRefused = (error: unknown): error is LinkRefused => error instanceof LinkRefused;

/**
 * ADR-EA-039 decision 9: binds `purpose` and its budgets once (in a plugin's `make`) and returns the
 * function every endpoint of that purpose redeems a presented token through. The order is fixed:
 * source budget, decode, token budget, `beforeClaim`, claim.
 */
export const redeemer = <const Name extends string, L, IssueArgs, EB = never, RB = never>(
  purpose: Purpose<Name, L, IssueArgs>,
  deps: { readonly verification: VerificationShape; readonly budget: LinkBudget<EB, RB> },
) => {
  const refused = (reason: LinkRefused["reason"]) =>
    new LinkRefused({ purpose: purpose.name, reason });
  const source = deps.budget.source;
  const perToken = deps.budget.token;

  return <A, E, R, EP = never, RP = never>(
    presented: {
      readonly token: Redacted.Redacted<string> & PresentedFor<Name>;
      readonly ip?: string | undefined;
    },
    use: (link: L) => Effect.Effect<A, E, R>,
    options?: {
      /** How a typed failure of `use` settles (ADR-EA-039). A foreign row always commits, before this is asked. */
      readonly onFailure?: ((error: E) => Settlement) | undefined;
      /** Runs after both budgets and before the claim, outside the transaction: a check that must never burn the token or run network I/O inside it (`confirmReset`'s policy, ARF-002). */
      readonly beforeClaim?: Effect.Effect<void, EP, RP> | undefined;
    },
  ) =>
    Effect.gen(function* () {
      if (source !== "caller") yield* source(presented.ip);
      const decoded = decode(Redacted.value(presented.token), purpose);
      if (Option.isNone(decoded)) return yield* refused("malformed");
      if (perToken !== "none") yield* perToken(decoded.value.publicId);
      if (options?.beforeClaim !== undefined) yield* options.beforeClaim;
      return yield* deps.verification
        .redeem<A, E | LinkRefused, R>({
          identifier: decoded.value.identifier,
          value: decoded.value.value,
          use: (token) =>
            Option.match(purpose.read(token, decoded.value.publicId), {
              onNone: () => Effect.fail(refused("foreign")),
              onSome: use,
            }),
          onFailure: (error) =>
            isRefused(error) ? "commit" : (options?.onFailure?.(error) ?? "rollback"),
        })
        .pipe(Effect.catchTag("Verification/TokenConsumed", () => Effect.fail(refused("missed"))));
    });
};

/**
 * The `data` a mail template receives for a mailed token. `token` stays
 * `Redacted` (EOTS-010: an adapter unwraps it only to render); `expiresAt` is
 * always present so a template can say how long the link lives; `url` is set
 * when the application configured a link builder — prefer a page that
 * consumes the token from the URL fragment or a POST, never a token in a
 * query string a GET handler acts on (mail scanners prefetch links).
 */
export const mailData = (input: {
  readonly token: Redacted.Redacted<string>;
  readonly expiresAt: DateTime.Utc;
  readonly link?: ((token: string) => string) | undefined;
}): {
  readonly token: Redacted.Redacted<string>;
  readonly url?: string;
  readonly expiresAt: string;
} => ({
  token: input.token,
  ...(input.link === undefined ? {} : { url: input.link(Redacted.value(input.token)) }),
  expiresAt: DateTime.formatIso(input.expiresAt),
});
