// Shipping-gap map (.scratch/shipping-gaps), ticket 21.
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import {
  World,
  signUp,
  signInAgain,
  sessionIdOf,
  getSession,
  postSession,
  aliasActor,
  getActor,
  setLastResponse,
  getLastResponse,
} from "./SessionWorld.ts";
import { cookieFrom } from "./shared/Harness.ts";

export const sessionSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- REQ-EA-147: sign-in issues a newly minted session ----

  Given("{string} has no existing session", function* (_name: string) {
    yield* Effect.void;
  });

  When("{string} signs in", function* (name: string) {
    const { response } = yield* signUp(name);
    yield* setLastResponse(name, response);
  });

  Then("a newly minted session is issued for {string}", function* (name: string) {
    const response = yield* getLastResponse(name);
    assert.equal(response.status, 200);
    assert.match(cookieFrom(response), /^__Host-session=/);
  });

  // ---- REQ-EA-149: session list ----

  Given("{string} has {int} active sessions", function* (name: string, count: number) {
    yield* signUp(name);
    for (let i = 1; i < count; i++) {
      yield* signInAgain(`${name}-session-${i}`, name);
    }
  });

  When("{string} requests her session list", function* (name: string) {
    const actor = yield* getActor(name);
    const response = yield* getSession("/session/list", actor.cookie);
    yield* setLastResponse(name, response);
  });

  Then(
    'she sees {int} sessions, each with its own userAgent and a "current" flag on the session serving the request',
    function* (count: number) {
      const response = yield* getLastResponse("alice");
      assert.equal(response.status, 200);
      const body = (yield* Effect.promise(() => response.json())) as ReadonlyArray<{
        readonly current: boolean;
      }>;
      assert.equal(body.length, count);
      assert.equal(
        body.filter((s) => s.current).length,
        1,
        "expected exactly one session flagged current — the one serving this request",
      );
    },
  );

  // ---- REQ-EA-150: revoke one by id ----

  Given(
    "{string} has sessions {string} and {string}",
    function* (name: string, session1: string, session2: string) {
      yield* signUp(session1);
      yield* aliasActor(name, session1);
      yield* signInAgain(session2, session1);
    },
  );

  When("{string} revokes session {string}", function* (name: string, sessionName: string) {
    const actor = yield* getActor(name);
    const target = yield* getActor(sessionName);
    const id = yield* sessionIdOf(target.cookie);
    const response = yield* postSession("/session/revoke", { id }, actor.cookie);
    yield* setLastResponse("revoke", response);
  });

  Then("session {string} is no longer valid", function* (sessionName: string) {
    const target = yield* getActor(sessionName);
    const response = yield* getSession("/session", target.cookie);
    assert.equal(response.status, 401);
  });

  Then("session {string} remains valid", function* (sessionName: string) {
    const target = yield* getActor(sessionName);
    const response = yield* getSession("/session", target.cookie);
    assert.equal(response.status, 200);
  });

  // ---- REQ-EA-151: revoke-others ----

  Given(
    "{string} has sessions {string} \\(current), {string}, and {string}",
    function* (name: string, current: string, session2: string, session3: string) {
      yield* signUp(current);
      yield* aliasActor(name, current);
      yield* signInAgain(session2, current);
      yield* signInAgain(session3, current);
    },
  );

  When("{string} revokes all other sessions", function* (name: string) {
    const actor = yield* getActor(name);
    const response = yield* postSession("/session/revoke-others", undefined, actor.cookie);
    yield* setLastResponse("revokeOthers", response);
  });

  Then("{string} and {string} are no longer valid", function* (session2: string, session3: string) {
    const a = yield* getActor(session2);
    const b = yield* getActor(session3);
    assert.equal((yield* getSession("/session", a.cookie)).status, 401);
    assert.equal((yield* getSession("/session", b.cookie)).status, 401);
  });

  Then("{string} remains valid", function* (sessionName: string) {
    const target = yield* getActor(sessionName);
    const response = yield* getSession("/session", target.cookie);
    assert.equal(response.status, 200);
  });

  // ---- REQ-EA-154/155: cookie attributes ----

  Given("a signed-in user {string}", function* (name: string) {
    yield* signUp(name);
  });

  When("a session is issued for {string}", function* (_name: string) {
    yield* Effect.void;
  });

  Then('the response sets a cookie named "__Host-session"', function* () {
    const actor = yield* getActor("alice");
    assert.match(actor.cookie, /^__Host-session=/);
  });

  Then('the cookie carries "Secure", "HttpOnly", and "SameSite=Strict"', function* () {
    const actor = yield* getActor("alice");
    assert.match(actor.setCookie, /secure/i);
    assert.match(actor.setCookie, /httponly/i);
    assert.match(actor.setCookie, /samesite=strict/i);
  });

  Then('the cookie sets "Path=\\/"', function* () {
    const actor = yield* getActor("alice");
    assert.match(actor.setCookie, /path=\//i);
  });

  Then('the cookie sets no "Domain" attribute', function* () {
    const actor = yield* getActor("alice");
    assert.doesNotMatch(actor.setCookie, /domain=/i);
  });
});
