// P20a: request/mail/row helpers over `DomainWorld`'s composition, shared by
// `VerificationSteps.ts` and `UsersAccountsSteps.ts`.
import { Users } from "@awthaq/core";
import type { Mailer } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CSRF_TEST_COOKIE_VALUE, withCsrfCookie } from "./CsrfTestSupport.ts";
import { direct, type HeldToken, type Person, World } from "./DomainWorld.ts";
import { mailedToken } from "./MailedToken.ts";
import { cookieFrom, STRONG_PASSWORD } from "./shared/Harness.ts";

const ORIGIN = "http://localhost";

export interface RequestOptions {
  readonly body?: unknown;
  readonly cookie?: string | undefined;
  readonly headers?: Record<string, string>;
}

/** One request through the real router, as a browser that already holds the double-submit CSRF cookie would send it. */
export const request = Effect.fn("features.domain.request")(function* (
  method: string,
  path: string,
  options: RequestOptions = {},
) {
  const { handler } = yield* World;
  return yield* Effect.promise(() =>
    handler(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          ...options.headers,
          cookie: withCsrfCookie(options.cookie),
          "x-csrf-token": CSRF_TEST_COOKIE_VALUE,
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
    ),
  );
});

/** How many `template` mails `email` has received so far — the baseline for `awaitMail`'s `after`. */
export const mailCount = Effect.fn("features.domain.mailCount")(function* (
  email: string,
  template: string,
) {
  const { sentMail } = yield* World;
  return (yield* sentMail).filter(
    (message) => message.to === email && message.template === template,
  ).length;
});

/**
 * The (`after`+1)th mail the app sent `email` under `template`, polled on the real clock:
 * `signUp`/`requestReset` dispatch their mail on a detached fiber (BEH-EA-064) that no
 * `TestClock` step can advance.
 */
export const awaitMail = Effect.fn("features.domain.awaitMail")(function* (
  email: string,
  template: string,
  after = 0,
) {
  const { sentMail } = yield* World;
  for (let attempt = 0; attempt < 500; attempt++) {
    const found = (yield* sentMail).filter(
      (message) => message.to === email && message.template === template,
    );
    const latest = found[found.length - 1];
    if (found.length > after && latest !== undefined) return latest;
    yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)));
  }
  return yield* Effect.die(new Error(`no "${template}" mail was sent to ${email}`));
});

/** Splits a mailed `<purpose>:<publicId>.<secret>` token into what `Verification` is keyed by. */
export const heldTokenFrom = (message: Mailer.MailMessage): HeldToken => {
  const mailed = mailedToken(message);
  const separator = mailed.lastIndexOf(".");
  return {
    identifier: mailed.slice(0, separator),
    mailed,
    secret: mailed.slice(separator + 1),
  };
};

/** Rows of an arbitrary read-only query, for the scenarios whose claim is about what is *persisted*. */
export const rows = Effect.fn("features.domain.rows")(function* (
  query: string,
  ...parameters: ReadonlyArray<string | number>
) {
  return yield* direct(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.unsafe<Record<string, unknown>>(query, parameters);
    }),
  );
});

/** A scenario's person, registered by name. */
export const setPerson = Effect.fn("features.domain.setPerson")(function* (
  name: string,
  person: Person,
) {
  const { people } = yield* World;
  yield* people.set(name, person);
});

/** BDD-008: naming a person makes them the "current" one a pronoun step resolves to. */
export const getPerson = Effect.fn("features.domain.getPerson")(function* (name: string) {
  const { people } = yield* World;
  yield* people.use(name);
  return yield* people.get(name);
});

export const currentPersonName = Effect.fn("features.domain.currentPersonName")(function* () {
  const { people } = yield* World;
  return yield* people.current;
});

/** A fresh person, never yet seen by the app. */
export const newPerson = (email: string): Person => ({
  email,
  password: STRONG_PASSWORD,
  userId: Option.none(),
  cookie: Option.none(),
});

/** Signs `name` up over the wire (the app answers 200 with a session), leaving the address unverified. */
export const signUp = Effect.fn("features.domain.signUp")(function* (name: string) {
  const person = yield* getPerson(name);
  const response = yield* request("POST", "/password/sign-up", {
    body: { email: person.email, password: person.password },
  });
  if (response.status !== 200) {
    return yield* Effect.die(new Error(`sign-up failed for ${person.email}: ${response.status}`));
  }
  const found = yield* direct(
    Effect.gen(function* () {
      const users = yield* Users.Users;
      return yield* users.findByEmail(person.email);
    }),
  );
  const { people } = yield* World;
  yield* people.set(name, {
    ...person,
    userId: Option.map(found, (user) => user.id),
    cookie: Option.some(cookieFrom(response)),
  });
  return response;
});

/** Consumes the verification mail `signUp` dispatched, so a later sign-in passes the verified-email gate. */
export const verifyEmailOf = Effect.fn("features.domain.verifyEmailOf")(function* (name: string) {
  const person = yield* getPerson(name);
  const mail = yield* awaitMail(person.email, "verify-email");
  const verified = yield* request("POST", "/verify-email", { body: { token: mailedToken(mail) } });
  if (verified.status !== 204) {
    return yield* Effect.die(
      new Error(`verify-email failed for ${person.email}: ${verified.status}`),
    );
  }
});

export const signUpVerified = Effect.fn("features.domain.signUpVerified")(function* (name: string) {
  yield* signUp(name);
  yield* verifyEmailOf(name);
});

/** A signed-in user's session cookie, from a fresh sign-in over the wire. */
export const signIn = Effect.fn("features.domain.signIn")(function* (name: string) {
  const person = yield* getPerson(name);
  const response = yield* request("POST", "/password/sign-in", {
    body: { email: person.email, password: person.password },
  });
  if (response.status !== 200) {
    return yield* Effect.die(new Error(`sign-in failed for ${person.email}: ${response.status}`));
  }
  return cookieFrom(response);
});

export const bodyText = (response: Response) => Effect.promise(() => response.clone().text());
