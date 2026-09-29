// P20a (BCR-010): steps for features/features/14-mfa-passwordless/32-magic-link.feature.
// The scenario's recipient is played from the captured mail; the service is driven directly where
// a clock or an error tag is the point, and over the web handler where the wire is.
import { Accounts, Verification } from "@awthaq/core";
import { PasswordHasher } from "@awthaq/ports";
import { MagicLink, MagicLinkApi } from "@awthaq/magic-link";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import {
  configureApp,
  direct,
  mailOf,
  mailsOf,
  request,
  secretOf,
  SESSION_COOKIE,
  World,
} from "./MagicLinkWorld.ts";
import {
  consumeChallenge,
  createUser,
  failureField,
  failureTag,
  findUser,
  issuedOf,
  mintLink,
  outcomeAt,
  presentLink,
  recall,
  remember,
  recordOutcome,
  requireUser,
  sessionsIssued,
  signInFailures,
  userCreations,
} from "./MagicLinkSupport.ts";
import { STRONG_PASSWORD } from "./shared/Harness.ts";
import { isString, isStringArray } from "./shared/Outcomes.ts";
import { objectOf } from "./shared/WireJson.ts";

const TOKEN = "token";
const LAST_EMAIL = "lastEmail";
const OTHER_IDENTIFIER = "reset-password:abc";

/** The email variant `local+tag@domain` — the address a `+tag` flood would use. */
const variant = (email: string, tag: string) => {
  const at = email.lastIndexOf("@");
  return `${email.slice(0, at)}+${tag}${email.slice(at)}`;
};

const publicIdOf = (token: string) => token.slice("magic-link:".length, token.indexOf("."));

export const magicLinkSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-267: POST only, token in the fragment ----

  Given("the magic-link contract", function* () {
    // Narrative Given: the contract is read from the plugin's own group in the When.
    yield* Effect.void;
  });

  When("its endpoints are listed", function* () {
    const world = yield* World;
    const endpoints = Object.values(MagicLinkApi.MagicLinkGroup.endpoints).map(
      (endpoint) => `${endpoint.method} ${endpoint.path}`,
    );
    yield* world.outcomes.set("endpoints", endpoints);
  });

  Then("every endpoint is a {string}", function* (method: string) {
    const world = yield* World;
    const endpoints = yield* world.outcomes.getAs("endpoints", isStringArray);
    assert.ok(endpoints.length > 0);
    for (const endpoint of endpoints) assert.ok(endpoint.startsWith(`${method} `), endpoint);
  });

  Then("the endpoint paths are {string} and {string}", function* (first: string, second: string) {
    const world = yield* World;
    const endpoints = yield* world.outcomes.getAs("endpoints", isStringArray);
    assert.deepEqual(endpoints.map((endpoint) => endpoint.split(" ")[1]).sort(), [first, second]);
  });

  Given("a mailed magic link for {string}", function* (email: string) {
    const { token } = yield* mintLink(email);
    yield* remember(TOKEN, token);
    yield* remember(`${TOKEN}:${email}`, token);
    yield* remember(LAST_EMAIL, email);
  });

  When(
    "a {string} request carries the token in the query string of {string}",
    function* (method: string, path: string) {
      const world = yield* World;
      const token = yield* recall(TOKEN);
      const response = yield* request(method, `${path}?token=${encodeURIComponent(token)}`);
      yield* world.responses.set(`${method} ${path}`, response);
    },
  );

  Then("both requests are refused as unrouted", function* () {
    const world = yield* World;
    for (const key of ["GET /magic-link/verify", "GET /magic-link"]) {
      const response = yield* world.responses.get(key);
      // A route that does not exist: never a 2xx, never a session.
      assert.ok(response.status === 404 || response.status === 405, `${key} -> ${response.status}`);
      assert.equal(response.headers.get("set-cookie"), null);
    }
  });

  Then(
    "a POST of the same token to {string} still signs {string} in",
    function* (path: string, email: string) {
      const token = yield* recall(TOKEN);
      const response = yield* request("POST", path, { token });
      assert.equal(response.status, 200, response.text);
      assert.match(response.headers.get("set-cookie") ?? "", new RegExp(`${SESSION_COOKIE}=`));
      assert.deepEqual(objectOf(response)["amr"], ["email"]);
      // The link was unspent until now, and the session is the addressed person's.
      assert.ok(Option.isSome(yield* findUser(email)));
    },
  );

  When(
    "a {string} to {string} carries the token only in the query string",
    function* (method: string, path: string) {
      const world = yield* World;
      const token = yield* recall(TOKEN);
      const response = yield* request(method, `${path}?token=${encodeURIComponent(token)}`, {});
      yield* world.responses.set("last", response);
    },
  );

  Then("the response is {string}", function* (status: string) {
    const world = yield* World;
    const response = yield* world.responses.get("last");
    assert.equal(String(response.status), status);
  });

  Given("the application configures the magic-link base URL {string}", function* (baseUrl: string) {
    yield* configureApp({ magicLink: { baseUrl } });
  });

  Then("the mailed URL is {string} followed by the encoded token", function* (prefix: string) {
    const mail = yield* mailOf("magic-link", yield* recall(LAST_EMAIL));
    assert.equal(
      String(mail.data?.["url"]),
      `${prefix}${encodeURIComponent(secretOf(mail, "token"))}`,
    );
  });

  Then(
    "the mailed URL has no query string and nothing of the token before its fragment",
    function* () {
      const mail = yield* mailOf("magic-link", yield* recall(LAST_EMAIL));
      const url = String(mail.data?.["url"]);
      const token = secretOf(mail, "token");
      const [beforeFragment = ""] = url.split("#");
      assert.ok(!url.includes("?"));
      assert.ok(
        !beforeFragment.includes(token) && !beforeFragment.includes(encodeURIComponent(token)),
      );
      assert.ok(url.includes("#token="));
    },
  );

  // ---- BEH-EA-268: 202 for everyone, at most one link per window ----

  When("{string} requests a magic link", function* (email: string) {
    yield* direct(MagicLink.MagicLink.pipe(Effect.flatMap((link) => link.requestLink({ email }))));
    yield* remember(LAST_EMAIL, email);
  });

  When(
    "{string} and {string} each request a magic link over HTTP",
    function* (first: string, second: string) {
      const world = yield* World;
      const a = yield* request("POST", "/magic-link/request", { email: first });
      const b = yield* request("POST", "/magic-link/request", { email: second });
      yield* world.responses.set("first", a);
      yield* world.responses.set("second", b);
    },
  );

  Then("both responses are {string} with the same empty body", function* (status: string) {
    const world = yield* World;
    const a = yield* world.responses.get("first");
    const b = yield* world.responses.get("second");
    assert.equal(String(a.status), status);
    assert.equal(String(b.status), status);
    assert.equal(a.text, b.text);
    assert.equal(a.text, "");
  });

  Given("the application disallows sign-up through magic links", function* () {
    yield* configureApp({ magicLink: { allowSignUp: false } });
  });

  When(
    "{string} and {string} each request a magic link",
    function* (first: string, second: string) {
      for (const email of [first, second]) {
        yield* direct(
          MagicLink.MagicLink.pipe(Effect.flatMap((link) => link.requestLink({ email }))),
        );
      }
    },
  );

  Then("only {string} was mailed a magic link", function* (email: string) {
    assert.equal((yield* mailsOf("magic-link", email)).length, 1);
    assert.equal((yield* mailsOf("magic-link", "nobody@example.com")).length, 0);
  });

  Then(
    "the {string} mail to {string} carries a redacted {string} and an expiry",
    function* (template: string, to: string, field: string) {
      const mail = yield* mailOf(template, to);
      assert.ok(Redacted.isRedacted(mail.data?.[field]));
      assert.ok(isString(mail.data?.["expiresAt"]));
    },
  );

  Then("the mail carries no URL because no base URL or link builder is configured", function* () {
    const mail = yield* mailOf("magic-link", yield* recall(LAST_EMAIL));
    assert.equal(mail.data?.["url"], undefined);
  });

  When("{string} requests a magic link {int} times", function* (email: string, times: number) {
    for (let i = 0; i < times; i++) {
      yield* direct(
        MagicLink.MagicLink.pipe(Effect.flatMap((link) => link.requestLink({ email }))),
      );
    }
    yield* remember(LAST_EMAIL, email);
  });

  Then("{string} was mailed {int} magic link(s)", function* (email: string, count: number) {
    assert.equal((yield* mailsOf("magic-link", email)).length, count);
  });

  When(
    "links are requested for {int} {string} variants of {string}",
    function* (count: number, tag: string, email: string) {
      assert.equal(tag, "+tag");
      for (let i = 0; i < count; i++) {
        yield* direct(
          MagicLink.MagicLink.pipe(
            Effect.flatMap((link) => link.requestLink({ email: variant(email, String(i)) })),
          ),
        );
      }
    },
  );

  Then(
    "a request for the variant {string} fails with {string}",
    function* (email: string, tag: string) {
      yield* recordOutcome(
        "request",
        MagicLink.MagicLink.pipe(Effect.flatMap((link) => link.requestLink({ email }))),
      );
      assert.equal(failureTag(yield* outcomeAt("request")), tag);
    },
  );

  When(
    "links are requested from source {string} for {int} distinct addresses",
    function* (ip: string, count: number) {
      for (let i = 0; i < count; i++) {
        yield* direct(
          MagicLink.MagicLink.pipe(
            Effect.flatMap((link) => link.requestLink({ email: `person${i}@example.com`, ip })),
          ),
        );
      }
    },
  );

  Then(
    "one more request from source {string} fails with {string}",
    function* (ip: string, tag: string) {
      yield* recordOutcome(
        "request",
        MagicLink.MagicLink.pipe(
          Effect.flatMap((link) => link.requestLink({ email: "one-more@example.com", ip })),
        ),
      );
      assert.equal(failureTag(yield* outcomeAt("request")), tag);
    },
  );

  // ---- BEH-EA-269: presenting a link ----

  When("the link is presented", function* () {
    const world = yield* World;
    yield* world.numbers.set("issuedBefore", yield* sessionsIssued);
    yield* recordOutcome("verify", presentLink(yield* recall(TOKEN)));
  });

  When("the same link is presented again", function* () {
    yield* recordOutcome("verify", presentLink(yield* recall(TOKEN)));
  });

  Then(
    "a session is issued for {string} recorded as {string}",
    function* (email: string, method: string) {
      const issued = issuedOf(yield* outcomeAt("verify"));
      const user = yield* requireUser(email);
      assert.equal(issued.session.userId, user.id);
      assert.deepEqual(issued.session.amr, [method]);
    },
  );

  Then("a {string} sign-in failure was published", function* (strategy: string) {
    assert.ok((yield* signInFailures(strategy)) >= 1);
  });

  Then("a user creation was published for {string}", function* (email: string) {
    assert.equal(yield* userCreations(email), 1);
  });

  When("{string} is presented as a magic link", function* (kind: string) {
    const world = yield* World;
    const token = yield* tokenOfKind(kind);
    yield* world.numbers.set("issuedBefore", yield* sessionsIssued);
    yield* recordOutcome("verify", presentLink(token));
  });

  Given("a token of another purpose", function* () {
    yield* remember(TOKEN, yield* tokenOfKind("a token of another purpose"));
  });

  When("it is presented as a magic link", function* () {
    yield* recordOutcome("verify", presentLink(yield* recall(TOKEN)));
  });

  Then("the token of the other purpose can still be consumed for its own purpose", function* () {
    const secret = yield* recall("otherSecret");
    yield* direct(
      Verification.Verification.pipe(
        Effect.flatMap((verification) =>
          verification.consume(OTHER_IDENTIFIER, Redacted.make(secret)),
        ),
      ),
    );
  });

  Then("it fails with {string} carrying the code {string}", function* (tag: string, code: string) {
    const outcome = yield* outcomeAt("verify");
    assert.equal(failureTag(outcome), tag);
    assert.equal(failureField(outcome, "code"), code);
  });

  Then(
    "the second-factor challenge records the first factor as {string} via {string}",
    function* (method: string, strategy: string) {
      const consumed = yield* consumeChallenge(yield* recall("challengeId"));
      assert.deepEqual(consumed.amr, [method]);
      assert.equal(consumed.strategy, strategy);
    },
  );

  Given("a user {string} with a password credential", function* (email: string) {
    const user = yield* createUser(email);
    const hash = yield* direct(
      PasswordHasher.PasswordHasher.pipe(
        Effect.flatMap((hasher) => hasher.hash(Redacted.make(STRONG_PASSWORD))),
      ),
    );
    yield* direct(
      Accounts.Accounts.pipe(
        Effect.flatMap((accounts) =>
          accounts.link({
            userId: user.id,
            providerId: "password",
            subject: email,
            credentialHash: Redacted.make(hash),
          }),
        ),
      ),
    );
    yield* remember(`hash:${email}`, hash);
  });

  Then(
    "the password credential of {string} is unchanged and still verifies",
    function* (email: string) {
      const user = yield* requireUser(email);
      const stored = yield* recall(`hash:${email}`);
      const accounts = yield* direct(
        Accounts.Accounts.pipe(Effect.flatMap((service) => service.listByUser(user.id))),
      );
      // Signing in with a link linked nothing and unlinked nothing.
      assert.equal(accounts.length, 1);
      const [account] = accounts;
      assert.ok(account !== undefined);
      const current = yield* direct(
        Accounts.Accounts.pipe(Effect.flatMap((service) => service.findCredentialHash(account.id))),
      );
      assert.ok(Option.isSome(current));
      assert.equal(Redacted.value(current.value), stored);
      const verifies = yield* direct(
        PasswordHasher.PasswordHasher.pipe(
          Effect.flatMap((hasher) =>
            hasher.verify(Redacted.make(STRONG_PASSWORD), Redacted.value(current.value)),
          ),
        ),
      );
      assert.ok(verifies);
    },
  );

  When("the same made-up token is presented {int} times", function* (times: number) {
    for (let i = 0; i < times; i++) {
      yield* recordOutcome("verify", presentLink("magic-link:made-up-id.made-up-secret"));
      assert.equal(failureTag(yield* outcomeAt("verify")), "MagicLinkConsumed");
    }
  });

  Then("presenting it a sixth time fails with {string}", function* (tag: string) {
    yield* recordOutcome("verify", presentLink("magic-link:made-up-id.made-up-secret"));
    assert.equal(failureTag(yield* outcomeAt("verify")), tag);
  });

  // ---- BEH-EA-270: a Verification row under its own purpose ----

  Then("the token starts with {string}", function* (prefix: string) {
    assert.ok((yield* recall(TOKEN)).startsWith(prefix));
  });

  Then("the token contains neither the user's id nor the address", function* () {
    const token = yield* recall(TOKEN);
    const email = yield* recall(LAST_EMAIL);
    const user = yield* requireUser(email);
    assert.ok(!token.includes(user.id));
    assert.ok(!token.includes(email));
  });

  Then("each token's public id decodes to 16 bytes", function* () {
    for (const email of ["one@example.com", "two@example.com"]) {
      const id = publicIdOf(yield* recall(`${TOKEN}:${email}`));
      assert.equal(Buffer.from(id, "base64url").length, 16);
    }
  });

  Then("the two public ids differ", function* () {
    const one = publicIdOf(yield* recall(`${TOKEN}:one@example.com`));
    const two = publicIdOf(yield* recall(`${TOKEN}:two@example.com`));
    assert.notEqual(one, two);
  });
});

/** A token of the named kind: the scenario's own words for a token that is not a live magic link. */
const tokenOfKind = (kind: string) =>
  Effect.gen(function* () {
    switch (kind) {
      case "an empty string":
        return "";
      case "arbitrary text":
        return "nonsense";
      case "a token of another purpose": {
        const issued = yield* direct(
          Verification.Verification.pipe(
            Effect.flatMap((verification) =>
              verification.issue({ identifier: OTHER_IDENTIFIER, ttl: Duration.minutes(5) }),
            ),
          ),
        );
        const secret = Redacted.value(issued.value);
        yield* remember("otherSecret", secret);
        return `${OTHER_IDENTIFIER}.${secret}`;
      }
      default:
        return yield* Effect.die(new Error(`unknown token kind "${kind}"`));
    }
  });
