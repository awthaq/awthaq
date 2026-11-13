// P20a: request/mail/row helpers over `DomainWorld`'s composition, shared by
// `VerificationSteps.ts` and `UsersAccountsSteps.ts`.
import { Users } from "@awthaq/core";
import type { Mailer } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { Api } from "@awthaq/api";
import { parseCookieHeader } from "@awthaq/web/cookies";
import { agentOver } from "./shared/Csrf.ts";
import { direct, type HeldToken, type Person, World } from "./DomainWorld.ts";
import { mailedToken } from "./MailedToken.ts";
import { STRONG_PASSWORD } from "./shared/Harness.ts";

const ORIGIN = "http://localhost";

export interface RequestOptions {
  readonly body?: unknown;
  readonly cookie?: string | undefined;
  readonly headers?: Record<string, string>;
}

/**
 * One request through the real router from a user agent that already holds the double-submit CSRF cookie
 * (`agentOver`), carrying `options.cookie` (a person's session pair) beside it. The agent is returned too,
 * so a sign-up or sign-in reads the session cookie it now holds instead of parsing `Set-Cookie`.
 */
const requestWithAgent = Effect.fn("features.domain.requestWithAgent")(function* (
  method: string,
  path: string,
  options: RequestOptions = {},
) {
  const { handler } = yield* World;
  const agent = agentOver(handler, { origin: ORIGIN });
  const response = yield* Effect.promise(() =>
    agent.request(method, path, {
      ...(options.body === undefined ? {} : { json: options.body }),
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      extraCookies: Object.fromEntries(
        parseCookieHeader(options.cookie).map((pair) => [pair.name, pair.value]),
      ),
    }),
  );
  return { agent, response };
});

/** One request through the real router, as a browser that already holds the double-submit CSRF cookie would send it. */
export const request = Effect.fn("features.domain.request")(function* (
  method: string,
  path: string,
  options: RequestOptions = {},
) {
  return (yield* requestWithAgent(method, path, options)).response;
});

/** The `name=value` pair of the session cookie `agent` holds (what a browser sends back), or a defect when it holds none. */
const sessionPairOf = (agent: ReturnType<typeof agentOver>) => {
  const held = agent.cookies.get(Api.SESSION_COOKIE_NAME);
  if (held === undefined) throw new Error("expected the response to set a session cookie");
  return `${held.name}=${held.value}`;
};

/**
 * The (`after`+1)th mail the app sent `email` under `template`, awaited by subscription: `signUp`/`requestReset`
 * dispatch their mail on a detached fiber (BEH-EA-064) that no `TestClock` step can advance. Returns the newest match.
 */
export const awaitMail = Effect.fn("features.domain.awaitMail")(function* (
  email: string,
  template: string,
  after = 0,
) {
  const { mailbox } = yield* World;
  const match = { to: email, template };
  yield* mailbox.mail.waitFor(match, { nth: after + 1 });
  const found = (yield* mailbox.mail.messages).filter(
    (message) => message.to === email && message.template === template,
  );
  return (
    found[found.length - 1] ?? (yield* Effect.die(new Error("unreachable: a waited mail vanished")))
  );
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

/** `query` with its `?` placeholders as the ambient database wants them (Postgres numbers them `$1`...). */
export const numbered = Effect.fn("features.domain.numbered")(function* (query: string) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.onDialectOrElse({
    pg: () => {
      let index = 0;
      return Effect.succeed(query.replace(/\?/g, () => `$${(index += 1)}`));
    },
    orElse: () => Effect.succeed(query),
  });
});

/** The SQL literal a boolean column takes: SQLite stores 0/1, Postgres a real boolean. */
export const booleanValue = Effect.fn("features.domain.booleanValue")(function* (value: boolean) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.onDialectOrElse({
    pg: () => Effect.succeed<boolean | number>(value),
    orElse: () => Effect.succeed<boolean | number>(value ? 1 : 0),
  });
});

/** Rows of an arbitrary read-only query, for the scenarios whose claim is about what is *persisted*. */
export const rows = Effect.fn("features.domain.rows")(function* (
  query: string,
  ...parameters: ReadonlyArray<string | number>
) {
  return yield* direct(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const text = yield* numbered(query);
      return yield* sql.unsafe<Record<string, unknown>>(text, parameters);
    }),
  );
});

/** The column names of `table` as the database itself reports them (SQLite pragma, Postgres catalog). */
export const columnNames = Effect.fn("features.domain.columnNames")(function* (table: string) {
  const found = yield* direct(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.onDialectOrElse({
        pg: () =>
          sql<{
            readonly name: string;
          }>`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ${table}`,
        orElse: () => sql<{ readonly name: string }>`SELECT name FROM pragma_table_info(${table})`,
      });
    }),
  );
  return found.map((column) => column.name);
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
  const { agent, response } = yield* requestWithAgent("POST", "/password/sign-up", {
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
    cookie: Option.some(sessionPairOf(agent)),
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

/** A signed-in user's session cookie, from a fresh sign-in over the wire (from a device named by `headers`, if given). */
export const signIn = Effect.fn("features.domain.signIn")(function* (
  name: string,
  headers?: Record<string, string>,
) {
  const person = yield* getPerson(name);
  const { agent, response } = yield* requestWithAgent("POST", "/password/sign-in", {
    body: { email: person.email, password: person.password },
    ...(headers === undefined ? {} : { headers }),
  });
  if (response.status !== 200) {
    return yield* Effect.die(new Error(`sign-in failed for ${person.email}: ${response.status}`));
  }
  return sessionPairOf(agent);
});

export const bodyText = (response: Response) => Effect.promise(() => response.clone().text());
