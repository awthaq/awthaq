// P20a (BCR-010): what the magic-link and email-otp steps share — a service call's outcome as a
// plain value a Then can narrow (no casts), the user/session/audit reads both features assert on,
// and the recipient-side helpers (`mint*`) that play the person opening the mail.
import { AuditLog, Users } from "@awthaq/core";
import { EmailOtp, MagicLink } from "@awthaq/magic-link";
import { SecondFactor } from "@awthaq/two-factor";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import {
  direct,
  directExit,
  mailOf,
  secretOf,
  World,
  type MagicLinkServices,
} from "./MagicLinkWorld.ts";
import { isString } from "./shared/Outcomes.ts";

/** A service call's outcome, drained to data: the typed failure (or the value) a later Then narrows. */
export type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown };

export const isOutcome = (value: unknown): value is Outcome =>
  typeof value === "object" && value !== null && "ok" in value && typeof value.ok === "boolean";

export const outcomeOf = <A, E>(exit: Exit.Exit<A, E>): Outcome =>
  Exit.isSuccess(exit)
    ? { ok: true, value: exit.value }
    : Option.match(Exit.findErrorOption(exit), {
        onNone: () => ({ ok: false, error: "defect" }),
        onSome: (error) => ({ ok: false, error }),
      });

/** Runs `effect` against the composition and records its outcome under `key`. */
export const recordOutcome = <A, E>(key: string, effect: Effect.Effect<A, E, MagicLinkServices>) =>
  Effect.gen(function* () {
    const world = yield* World;
    yield* world.outcomes.set(key, outcomeOf(yield* directExit(effect)));
  });

export const outcomeAt = (key: string) =>
  Effect.gen(function* () {
    const world = yield* World;
    return yield* world.outcomes.getAs(key, isOutcome);
  });

const tagOfError = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "_tag" in error && isString(error._tag)
    ? error._tag
    : undefined;

/** The failure's tag; asserts the outcome really was a typed failure. */
export const failureTag = (outcome: Outcome): string => {
  assert.ok(!outcome.ok, "expected the call to fail, but it succeeded");
  const tag = tagOfError(outcome.error);
  assert.ok(tag !== undefined, `expected a tagged failure, got ${String(outcome.error)}`);
  return tag;
};

export const failureField = (outcome: Outcome, field: string): unknown => {
  assert.ok(!outcome.ok);
  const error = outcome.error;
  assert.ok(typeof error === "object" && error !== null);
  return Reflect.get(error, field);
};

export interface IssuedShape {
  readonly session: {
    readonly id: string;
    readonly userId: string;
    readonly amr: ReadonlyArray<string>;
  };
}

const isIssued = (value: unknown): value is IssuedShape =>
  typeof value === "object" &&
  value !== null &&
  "session" in value &&
  typeof value.session === "object" &&
  value.session !== null &&
  "userId" in value.session &&
  isString(value.session.userId) &&
  "amr" in value.session &&
  Array.isArray(value.session.amr);

/** The issued session; asserts the outcome really succeeded. */
export const issuedOf = (outcome: Outcome): IssuedShape => {
  assert.ok(outcome.ok, `expected a session, got failure ${String(failureTagSafe(outcome))}`);
  assert.ok(isIssued(outcome.value));
  return outcome.value;
};

const failureTagSafe = (outcome: Outcome) =>
  outcome.ok ? "ok" : (tagOfError(outcome.error) ?? "?");

// ---- users, sessions and audit rows, as a Then reads them ----------------------------------------

export const findUser = (email: string) =>
  direct(Users.Users.pipe(Effect.flatMap((users) => users.findByEmail(email))));

export const requireUser = (email: string) =>
  Effect.gen(function* () {
    const user = yield* findUser(email);
    assert.ok(Option.isSome(user), `expected a user for ${email}`);
    return user.value;
  });

export const createUser = (email: string) =>
  direct(
    Users.Users.pipe(
      Effect.flatMap((users) =>
        users.create({ identity: { _tag: "Email", email }, name: email.split("@")[0] ?? email }),
      ),
    ),
  );

/** The number of `auth.session.issued` rows so far: a session-was-not-issued Then compares against the count taken before the act. */
export const sessionsIssued = direct(
  AuditLog.AuditLog.pipe(
    Effect.flatMap((audit) => audit.list({ eventTag: "auth.session.issued" })),
    Effect.map((rows) => rows.length),
  ),
);

export const signInFailures = (strategy: string) =>
  direct(
    AuditLog.AuditLog.pipe(
      Effect.flatMap((audit) => audit.list({ eventTag: "auth.user.signInFailed" })),
      Effect.map(
        (rows) =>
          rows.filter(
            (row) =>
              row.payload._tag === "auth.user.signInFailed" && row.payload.strategy === strategy,
          ).length,
      ),
    ),
  );

export const userCreations = (email: string) =>
  Effect.gen(function* () {
    const user = yield* requireUser(email);
    return yield* direct(
      AuditLog.AuditLog.pipe(
        Effect.flatMap((audit) => audit.list({ eventTag: "auth.user.created" })),
        Effect.map(
          (rows) =>
            rows.filter(
              (row) => row.payload._tag === "auth.user.created" && row.payload.userId === user.id,
            ).length,
        ),
      ),
    );
  });

// ---- the recipient ---------------------------------------------------------------------------------

/** Asks for a link the way a person would and returns what the mail carried. */
export const mintLink = (email: string) =>
  Effect.gen(function* () {
    yield* direct(MagicLink.MagicLink.pipe(Effect.flatMap((link) => link.requestLink({ email }))));
    const mail = yield* mailOf("magic-link", email);
    return { mail, token: secretOf(mail, "token") };
  });

/** Asks for a code the way a person would and returns what the mail carried. */
export const mintCode = (email: string) =>
  Effect.gen(function* () {
    yield* direct(EmailOtp.EmailOtp.pipe(Effect.flatMap((otp) => otp.requestCode({ email }))));
    const mail = yield* mailOf("email-otp", email);
    return { mail, code: secretOf(mail, "code") };
  });

/** Presents a link token to the service. */
export const presentLink = (token: string, ip?: string) =>
  MagicLink.MagicLink.pipe(
    Effect.flatMap((link) =>
      link.verify({ token: Redacted.make(token), ip }, { userAgent: "Browser/1.0" }),
    ),
  );

/** Presents a code to the service. */
export const presentCode = (email: string, code: string, ip?: string) =>
  EmailOtp.EmailOtp.pipe(
    Effect.flatMap((otp) =>
      otp.verify({ email, code: Redacted.make(code), ip }, { userAgent: "Browser/1.0" }),
    ),
  );

export const consumeChallenge = (challengeId: string) =>
  direct(
    SecondFactor.SecondFactor.pipe(
      Effect.flatMap((factor) => factor.consumeChallenge(Redacted.make(challengeId))),
    ),
  );

export const remember = (key: string, value: string) =>
  Effect.gen(function* () {
    const world = yield* World;
    yield* world.strings.set(key, value);
  });

export const recall = (key: string) =>
  Effect.gen(function* () {
    const world = yield* World;
    return yield* world.strings.get(key);
  });
