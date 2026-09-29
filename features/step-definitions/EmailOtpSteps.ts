// P20a (BCR-010): steps for features/features/14-mfa-passwordless/33-email-otp.feature. The
// shared people/clock/gate steps are in PasswordlessCommonSteps.ts; what is specific here is a
// code — minted by Verification, mailed, presented with an attempt budget behind it.
import { AuditLog, AuthEvents, Verification } from "@awthaq/core";
import { EmailOtp, EmailOtpApi } from "@awthaq/magic-link";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
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
  failureTag,
  issuedOf,
  mintCode,
  outcomeAt,
  presentCode,
  recall,
  recordOutcome,
  remember,
  requireUser,
  sessionsIssued,
} from "./MagicLinkSupport.ts";
import { isString } from "./shared/Outcomes.ts";
import { objectOf } from "./shared/WireJson.ts";

const CODE = "code";
const LAST_EMAIL = "lastEmail";

/** A value that is not the live code, whatever the live code is. */
const wrongCode = (code: string) => (code === "000000" ? "111111" : "000000");

/** The variant `local+tag@domain`. */
const variant = (email: string, tag: string) => {
  const at = email.lastIndexOf("@");
  return `${email.slice(0, at)}+${tag}${email.slice(at)}`;
};

const requestCode = (email: string, ip?: string) =>
  EmailOtp.EmailOtp.pipe(Effect.flatMap((otp) => otp.requestCode({ email, ip })));

const issueNumeric = (identifier: string, digits: number) =>
  Verification.Verification.pipe(
    Effect.flatMap((verification) =>
      verification.issue({
        identifier,
        ttl: Duration.minutes(5),
        format: { _tag: "Numeric", digits },
        maxAttempts: 3,
      }),
    ),
  );

const consumeAs = (identifier: string, value: string) =>
  Verification.Verification.pipe(
    Effect.flatMap((verification) => verification.consume(identifier, Redacted.make(value))),
  );

export const emailOtpSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-271: numeric values and the attempt budget, in Verification ----

  When(
    "Verification issues a numeric value of {int} digits with an attempt budget of 3",
    function* (digits: number) {
      const issued = yield* direct(issueNumeric("email-otp:digits@example.com", digits));
      yield* remember("value", Redacted.value(issued.value));
    },
  );

  Then("the value is exactly {int} decimal digits", function* (digits: number) {
    assert.match(yield* recall("value"), new RegExp(`^[0-9]{${digits}}$`));
  });

  // REQ-EA-1101: a scripted crypto source (`Crypto.make` over the real SHA-256) whose first six-digit
  // draw is the bytes 255 down to 250 and then 0 up to 5. Rejection sampling drops the six bytes at or
  // above 250, so the code is 012345; a plain `byte % 10` would have minted 543210 from them, which is
  // how modulo bias over-draws 0..5.
  Given(
    "a crypto source whose first six-digit draw is the bytes {int} down to {int} and then {int} up to {int}",
    function* (high: number, low: number, from: number, to: number) {
      assert.deepEqual([high, low, from, to], [255, 250, 0, 5]);
      yield* Effect.void;
    },
  );

  When("a 6-digit numeric value is minted from it", function* () {
    const script = [255, 254, 253, 252, 251, 250, 0, 1, 2, 3, 4, 5];
    const scripted = Crypto.make({
      randomBytes: (size) =>
        size === script.length ? Uint8Array.from(script) : new Uint8Array(size),
      digest: (algorithm, data) =>
        Effect.promise(
          async () =>
            new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, new Uint8Array(data))),
        ),
    });
    const value = yield* Effect.gen(function* () {
      const verification = yield* Verification.Verification;
      const issued = yield* verification.issue({
        identifier: "email-otp:scripted@example.com",
        ttl: Duration.minutes(5),
        format: { _tag: "Numeric", digits: 6 },
        maxAttempts: 3,
      });
      return Redacted.value(issued.value);
    }).pipe(
      Effect.provide(
        Verification.layerMemory.pipe(
          Layer.provide(Layer.succeed(Crypto.Crypto, scripted)),
          Layer.provide(AuthEvents.layer.pipe(Layer.provide(AuditLog.layerMemory))),
        ),
      ),
    );
    yield* remember("scriptedValue", value);
  });

  Then(
    "no digit was taken from a byte of 250 or more, so no digit is over-drawn by modulo bias",
    function* () {
      // Bytes 250..255 were refused: their residues (0..5) are not over-drawn at the 5..0 the bias would give.
      assert.equal(yield* recall("scriptedValue"), "012345");
    },
  );

  When("Verification is asked for a numeric value of {int} digits", function* (digits: number) {
    yield* recordOutcome("issue", issueNumeric("email-otp:width@example.com", digits));
  });

  Then("the request is refused as a defect", function* () {
    const outcome = yield* outcomeAt("issue");
    // Not a typed failure a caller could handle: a misconfiguration is a defect (Effect.die).
    assert.ok(!outcome.ok);
    assert.equal(outcome.error, "defect");
  });

  Given(
    "a numeric code with an attempt budget of 3 under the identifier {string}",
    function* (identifier: string) {
      const issued = yield* direct(issueNumeric(identifier, 6));
      yield* remember(`value:${identifier}`, Redacted.value(issued.value));
    },
  );

  Given(
    "a value with no attempt budget under the identifier {string}",
    function* (identifier: string) {
      const issued = yield* direct(
        Verification.Verification.pipe(
          Effect.flatMap((verification) =>
            verification.issue({ identifier, ttl: Duration.minutes(5) }),
          ),
        ),
      );
      yield* remember(`value:${identifier}`, Redacted.value(issued.value));
    },
  );

  When(
    "{int} wrong values are presented under {string}",
    function* (count: number, identifier: string) {
      for (let i = 0; i < count; i++) {
        yield* recordOutcome("wrong", consumeAs(identifier, `wrong-${i}`));
        assert.ok(!(yield* outcomeAt("wrong")).ok);
      }
    },
  );

  Then("the right value no longer works under {string}", function* (identifier: string) {
    yield* recordOutcome("right", consumeAs(identifier, yield* recall(`value:${identifier}`)));
    assert.ok(!(yield* outcomeAt("right")).ok);
  });

  Then("the right value still works under {string}", function* (identifier: string) {
    yield* recordOutcome("right", consumeAs(identifier, yield* recall(`value:${identifier}`)));
    assert.ok((yield* outcomeAt("right")).ok);
  });

  // ---- BEH-EA-272: requesting a code ----

  Given("a mailed code for {string}", function* (email: string) {
    const { code } = yield* mintCode(email);
    yield* remember(CODE, code);
    yield* remember(`${CODE}:${email}`, code);
    yield* remember(LAST_EMAIL, email);
  });

  When("{string} requests a code", function* (email: string) {
    yield* direct(requestCode(email));
    yield* remember(LAST_EMAIL, email);
  });

  When("{string} requests a code {int} times", function* (email: string, times: number) {
    for (let i = 0; i < times; i++) yield* direct(requestCode(email));
    yield* remember(LAST_EMAIL, email);
  });

  When(
    "{string} and {string} each request a code over HTTP",
    function* (first: string, second: string) {
      const world = yield* World;
      yield* world.responses.set(
        "first",
        yield* request("POST", "/email-otp/request", { email: first }),
      );
      yield* world.responses.set(
        "second",
        yield* request("POST", "/email-otp/request", { email: second }),
      );
    },
  );

  When("{string} and {string} each request a code", function* (first: string, second: string) {
    for (const email of [first, second]) yield* direct(requestCode(email));
  });

  Then("both responses are {string} with the same empty body", function* (status: string) {
    const world = yield* World;
    const a = yield* world.responses.get("first");
    const b = yield* world.responses.get("second");
    assert.equal(String(a.status), status);
    assert.equal(String(b.status), status);
    assert.equal(a.text, b.text);
    assert.equal(a.text, "");
  });

  Then(
    "the {string} mail to {string} carries a redacted six-digit code and an expiry",
    function* (template: string, to: string) {
      const mail = yield* mailOf(template, to);
      assert.ok(Redacted.isRedacted(mail.data?.["code"]));
      assert.match(secretOf(mail, "code"), /^[0-9]{6}$/);
      assert.ok(isString(mail.data?.["expiresAt"]));
    },
  );

  Given("the application disallows sign-up through email codes", function* () {
    yield* configureApp({ emailOtp: { allowSignUp: false } });
  });

  Then("only {string} was mailed a code", function* (email: string) {
    assert.equal((yield* mailsOf("email-otp", email)).length, 1);
    assert.equal((yield* mailsOf("email-otp", "nobody@example.com")).length, 0);
  });

  Then("{string} was mailed {int} code(s)", function* (email: string, count: number) {
    assert.equal((yield* mailsOf("email-otp", email)).length, count);
  });

  Then("presenting the mailed code signs {string} in", function* (email: string) {
    const code = secretOf(yield* mailOf("email-otp", email), "code");
    yield* recordOutcome("verify", presentCode(email, code));
    assert.equal(
      issuedOf(yield* outcomeAt("verify")).session.userId,
      (yield* requireUser(email)).id,
    );
  });

  Then("the first code no longer works unless the two happen to be equal", function* () {
    const email = yield* recall(LAST_EMAIL);
    const first = yield* recall(`${CODE}:${email}`);
    const newest = secretOf(yield* mailOf("email-otp", email), "code");
    // A colliding six-digit value is possible (one in a million); the superseded code is refused unless it is the same value.
    if (first === newest) return;
    yield* recordOutcome("stale", presentCode(email, first));
    assert.equal(failureTag(yield* outcomeAt("stale")), "InvalidEmailOtp");
  });

  Then("presenting the newest code signs {string} in", function* (email: string) {
    const code = secretOf(yield* mailOf("email-otp", email), "code");
    yield* recordOutcome("verify", presentCode(email, code));
    assert.equal(
      issuedOf(yield* outcomeAt("verify")).session.userId,
      (yield* requireUser(email)).id,
    );
  });

  When(
    "codes are requested for {int} {string} variants of {string}",
    function* (count: number, tag: string, email: string) {
      assert.equal(tag, "+tag");
      for (let i = 0; i < count; i++) yield* direct(requestCode(variant(email, String(i))));
    },
  );

  Then(
    "a request for the variant {string} fails with {string}",
    function* (email: string, tag: string) {
      yield* recordOutcome("request", requestCode(email));
      assert.equal(failureTag(yield* outcomeAt("request")), tag);
    },
  );

  When(
    "codes are requested from source {string} for {int} distinct addresses",
    function* (ip: string, count: number) {
      for (let i = 0; i < count; i++) yield* direct(requestCode(`person${i}@example.com`, ip));
    },
  );

  Then(
    "one more request from source {string} fails with {string}",
    function* (ip: string, tag: string) {
      yield* recordOutcome("request", requestCode("one-more@example.com", ip));
      assert.equal(failureTag(yield* outcomeAt("request")), tag);
    },
  );

  // ---- BEH-EA-273: presenting a code ----

  When("the code is presented for {string}", function* (email: string) {
    const world = yield* World;
    yield* world.numbers.set("issuedBefore", yield* sessionsIssued);
    yield* recordOutcome("verify", presentCode(email, yield* recall(CODE)));
  });

  When("the same code is presented again for {string}", function* (email: string) {
    yield* recordOutcome("verify", presentCode(email, yield* recall(CODE)));
  });

  Then(
    "a session is issued for {string} recorded as {string} and {string}",
    function* (email: string, first: string, second: string) {
      const issued = issuedOf(yield* outcomeAt("verify"));
      assert.equal(issued.session.userId, (yield* requireUser(email)).id);
      assert.deepEqual(issued.session.amr, [first, second]);
      assert.ok(!issued.session.amr.includes("sms"));
    },
  );

  When("the code is presented over HTTP for {string}", function* (email: string) {
    const world = yield* World;
    const code = yield* recall(CODE);
    yield* world.responses.set(
      "last",
      yield* request("POST", "/email-otp/verify", { email, code }),
    );
  });

  When("{string} is presented over HTTP for {string}", function* (kind: string, email: string) {
    const world = yield* World;
    const code = yield* recall(CODE);
    const presented = (() => {
      switch (kind) {
        case "a wrong code":
          return wrongCode(code);
        case "a code that is too short":
          return "12345";
        case "letters":
          return "abcdef";
        // The right code, presented for an address nothing was mailed to.
        case "a code for no address":
          return code;
        default:
          throw new Error(`unknown presented value "${kind}"`);
      }
    })();
    yield* world.responses.set(
      "last",
      yield* request("POST", "/email-otp/verify", { email, code: presented }),
    );
  });

  Then(
    "the response is {string} and sets a session cookie recorded as {string} and {string}",
    function* (status: string, first: string, second: string) {
      const world = yield* World;
      const response = yield* world.responses.get("last");
      assert.equal(String(response.status), status, response.text);
      assert.match(response.headers.get("set-cookie") ?? "", new RegExp(`${SESSION_COOKIE}=`));
      assert.deepEqual(objectOf(response)["amr"], [first, second]);
    },
  );

  Then("the response is {string} with the tag {string}", function* (status: string, tag: string) {
    const world = yield* World;
    const response = yield* world.responses.get("last");
    assert.equal(String(response.status), status, response.text);
    assert.equal(objectOf(response)["_tag"], tag);
    assert.equal(response.headers.get("set-cookie"), null);
  });

  When("{int} wrong codes are presented for {string}", function* (count: number, email: string) {
    // With a code mailed, a value that is certainly not it; with none, any six digits.
    const remembered = yield* Effect.exit(recall(CODE));
    const code = Exit.isSuccess(remembered) ? remembered.value : "123456";
    for (let i = 0; i < count; i++) {
      yield* recordOutcome("verify", presentCode(email, wrongCode(code)));
      assert.ok(!(yield* outcomeAt("verify")).ok);
    }
  });

  When(
    "{int} values that cannot be a code are presented for {string}",
    function* (count: number, email: string) {
      const shapes = ["12345", "abcdef", "1234567"];
      for (let i = 0; i < count; i++) {
        yield* recordOutcome("verify", presentCode(email, shapes[i % shapes.length] ?? "1"));
        assert.equal(failureTag(yield* outcomeAt("verify")), "InvalidEmailOtp");
      }
    },
  );

  Then(
    "presenting one more for {string} fails with {string}",
    function* (email: string, tag: string) {
      yield* recordOutcome("verify", presentCode(email, "123456"));
      assert.equal(failureTag(yield* outcomeAt("verify")), tag);
    },
  );

  Then(
    "the second-factor challenge records the first factor as {string} and {string} via {string}",
    function* (first: string, second: string, strategy: string) {
      const challengeId = yield* recall("challengeId");
      const consumed = yield* consumeChallenge(challengeId);
      assert.deepEqual(consumed.amr, [first, second]);
      assert.equal(consumed.strategy, strategy);
    },
  );

  // ---- BEH-EA-274: a Verification row under email-otp:<address> ----

  Then("the mailed code consumes under the identifier {string}", function* (identifier: string) {
    const email = yield* recall(LAST_EMAIL);
    yield* recordOutcome("consume", consumeAs(identifier, yield* recall(`${CODE}:${email}`)));
    assert.ok((yield* outcomeAt("consume")).ok);
  });

  Then(
    "the {string} contract exposes only {string} and {string}",
    function* (plugin: string, first: string, second: string) {
      yield* Effect.void;
      assert.equal(plugin, "emailOtp");
      const endpoints = Object.values(EmailOtpApi.EmailOtpGroup.endpoints).map(
        (endpoint) => `${endpoint.method} ${endpoint.path}`,
      );
      assert.deepEqual(endpoints.sort(), [first, second].sort());
    },
  );
});
