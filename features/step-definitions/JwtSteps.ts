// BDD-005/P20a: steps for 36-jwt.feature. A step reads a token the way a downstream service
// would (decode the compact JWS, verify against the served JWKS) and never reaches into the
// plugin's private state; the operator actions (rotating, revoking a key, denylisting a `jti`,
// revoking a session) call the same public functions an operator or the CLI calls.
import { Jwt, JwtConfig, KeyRing, RevocationStore, Verify } from "@awthaq/jwt";
import { Sessions } from "@awthaq/core";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import {
  claimsOf,
  configureApp,
  currentApp,
  forgeDefective,
  headerOf,
  inProcessHttpClient,
  isDefect,
  ISSUER,
  lastResponse,
  openSession,
  request,
  requestAs,
  signInUser,
  signWithUnpublishedKey,
  withFlippedSignature,
  withHeader,
  withPayload,
  World,
} from "./JwtWorld.ts";
import { isRecord, objectOf, stringField } from "./shared/WireJson.ts";

const expectStatus = (status: number, expected: number, body: string) =>
  assert.equal(status, expected, `expected ${expected}, got ${status} ${body}`);

/** The token a scenario refers to as "the token minted for X": the first one X requested. */
const firstMintedFor = Effect.fn("features.jwt.firstMintedFor")(function* (name: string) {
  const world = yield* World;
  const token = world.minted.get(name)?.[0];
  if (token === undefined) throw new Error(`no token was minted for "${name}"`);
  return token;
});

const newestToken = Effect.gen(function* () {
  const { newest } = yield* World;
  const token = yield* Ref.get(newest);
  if (token === undefined) throw new Error("no token has been minted yet");
  return token;
});

const mint = Effect.fn("features.jwt.mint")(function* (
  who: string,
  body?: unknown,
  options: { readonly record?: boolean } = {},
) {
  const world = yield* World;
  const response = yield* requestAs(who, { method: "POST", path: "/jwt/token", body });
  if (response.status === 200 && options.record !== false) {
    const token = stringField(objectOf(response), "token");
    const history = world.minted.get(who) ?? [];
    world.minted.set(who, [...history, token]);
    yield* Ref.set(world.newest, token);
  }
  return response;
});

const introspect = Effect.fn("features.jwt.introspect")(function* (
  who: string | undefined,
  token: string,
) {
  const path = "/jwt/introspect";
  return who === undefined
    ? yield* request({ method: "POST", path, body: { token } })
    : yield* requestAs(who, { method: "POST", path, body: { token } });
});

const jwksKeys = Effect.gen(function* () {
  const response = yield* request({ method: "GET", path: "/jwt/jwks" }, { observe: true });
  expectStatus(response.status, 200, response.text);
  const keys = objectOf(response)["keys"];
  if (!Array.isArray(keys)) throw new Error("the JWKS has no keys array");
  return keys.map((key) => {
    if (!isRecord(key)) throw new Error("a JWKS key is not an object");
    return key;
  });
});

const jwksBody = Effect.gen(function* () {
  const response = yield* lastResponse;
  const keys = objectOf(response)["keys"];
  if (!Array.isArray(keys)) throw new Error("the JWKS has no keys array");
  return keys.map((key) => {
    if (!isRecord(key)) throw new Error("a JWKS key is not an object");
    return key;
  });
});

const kidOf = (token: string) => {
  const kid = headerOf(token)["kid"];
  if (typeof kid !== "string") throw new Error("the token names no key id");
  return kid;
};

export const jwtSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- configuration (rebuilds the app; before anyone signs in) ----

  Given("the JWKS may be cached for {int} seconds", function* (seconds: number) {
    yield* configureApp({ jwksMaxAge: Duration.seconds(seconds) });
  });

  Given("tokens are accepted as bearer credentials", function* () {
    yield* configureApp({ acceptAsBearer: true });
  });

  Given("keys rotate every {int} ms", function* (millis: number) {
    yield* configureApp({ keyRotationInterval: Duration.millis(millis) });
  });

  // ---- actors ----

  Given("a signed-in user {string}", function* (name: string) {
    yield* signInUser(name);
  });

  Given("{string} has a second session {string}", function* (user: string, session: string) {
    yield* openSession(session, user);
  });

  Given("{string} has requested a token", function* (who: string) {
    const response = yield* mint(who);
    expectStatus(response.status, 200, response.text);
  });

  // ---- forged and tampered tokens ----

  Given("a token signed by the issuer's key with the defect {string}", function* (defect: string) {
    const world = yield* World;
    if (!isDefect(defect)) throw new Error(`unknown defect "${defect}"`);
    yield* world.tokens.set("forged", yield* forgeDefective(defect));
  });

  Given("a token signed by a key the issuer never published", function* () {
    const world = yield* World;
    yield* world.tokens.set("forged", yield* signWithUnpublishedKey());
  });

  Given(
    "the token minted for {string} has its payload claim {string} replaced by {string}",
    function* (who: string, claim: string, value: string) {
      const world = yield* World;
      yield* world.tokens.set("tampered", withPayload(yield* firstMintedFor(who), claim, value));
    },
  );

  Given("the token minted for {string} has its signature altered", function* (who: string) {
    const world = yield* World;
    yield* world.tokens.set("tampered", withFlippedSignature(yield* firstMintedFor(who)));
  });

  Given(
    "the token minted for {string} has its header algorithm replaced by {string}",
    function* (who: string, alg: string) {
      const world = yield* World;
      yield* world.tokens.set("tampered", withHeader(yield* firstMintedFor(who), "alg", alg));
    },
  );

  // ---- general-purpose tokens (signJWT) ----

  Given("a general-purpose token is signed with the payload {string}", function* (payload: string) {
    const world = yield* World;
    const app = yield* currentApp;
    const claims = JSON.parse(payload);
    yield* world.tokens.set(
      "general",
      yield* Effect.promise(() =>
        app.withContext(Jwt.Jwt.use((jwt) => jwt.signJWT(claims)).pipe(Effect.orDie)),
      ),
    );
  });

  Given(
    "a general-purpose token is signed for the audience {string} with the payload {string}",
    function* (audience: string, payload: string) {
      const world = yield* World;
      const app = yield* currentApp;
      const claims = JSON.parse(payload);
      yield* world.tokens.set(
        "general",
        yield* Effect.promise(() =>
          app.withContext(
            Jwt.Jwt.use((jwt) => jwt.signJWT(claims, { audience })).pipe(Effect.orDie),
          ),
        ),
      );
    },
  );

  Given(
    "a general-purpose token is signed carrying the user id and the session id of {string}",
    function* (who: string) {
      const world = yield* World;
      const app = yield* currentApp;
      const actor = yield* world.users.get(who);
      yield* world.tokens.set(
        "general",
        yield* Effect.promise(() =>
          app.withContext(
            Jwt.Jwt.use((jwt) => jwt.signJWT({ sub: actor.userId, sid: actor.sessionId })).pipe(
              Effect.orDie,
            ),
          ),
        ),
      );
    },
  );

  // ---- whens ----

  When("{string} requests a token", function* (who: string) {
    yield* mint(who);
  });

  When("{string} requests another token", function* (who: string) {
    yield* mint(who);
  });

  When("{string} requests a token with the body {string}", function* (who: string, body: string) {
    yield* mint(who, JSON.parse(body));
  });

  When("an anonymous caller requests a token", function* () {
    yield* request({ method: "POST", path: "/jwt/token" });
  });

  When("{string} sends GET {string}", function* (who: string, path: string) {
    yield* requestAs(who, { method: "GET", path });
  });

  When("an anonymous caller fetches the JWKS", function* () {
    yield* request({ method: "GET", path: "/jwt/jwks" });
  });

  When(
    "{string} introspects the token minted for {string}",
    function* (who: string, minted: string) {
      yield* introspect(who, yield* firstMintedFor(minted));
    },
  );

  When("{string} introspects the newest token", function* (who: string) {
    yield* introspect(who, yield* newestToken);
  });

  When("{string} introspects the forged token", function* (who: string) {
    const world = yield* World;
    yield* introspect(who, yield* world.tokens.get("forged"));
  });

  When("{string} introspects the tampered token", function* (who: string) {
    const world = yield* World;
    yield* introspect(who, yield* world.tokens.get("tampered"));
  });

  When("{string} introspects the text {string}", function* (who: string, text: string) {
    yield* introspect(who, text);
  });

  When("an anonymous caller introspects the text {string}", function* (text: string) {
    yield* introspect(undefined, text);
  });

  When("the session of {string} is revoked", function* (who: string) {
    const world = yield* World;
    const app = yield* currentApp;
    const actor = yield* world.users.get(who);
    yield* Effect.promise(() =>
      app.withContext(
        Sessions.Sessions.use((sessions) =>
          sessions.revoke(Sessions.SessionId(actor.sessionId), "admin"),
        ).pipe(Effect.orDie),
      ),
    );
  });

  Given("the session of {string} has been revoked", function* (who: string) {
    const world = yield* World;
    const app = yield* currentApp;
    const actor = yield* world.users.get(who);
    yield* Effect.promise(() =>
      app.withContext(
        Sessions.Sessions.use((sessions) =>
          sessions.revoke(Sessions.SessionId(actor.sessionId), "admin"),
        ).pipe(Effect.orDie),
      ),
    );
  });

  Given("the id of the token minted for {string} is denylisted", function* (who: string) {
    const app = yield* currentApp;
    const claims = claimsOf(yield* firstMintedFor(who));
    const jti = claims["jti"];
    const exp = claims["exp"];
    if (typeof jti !== "string" || typeof exp !== "number") {
      throw new Error("the token carries no jti/exp to denylist");
    }
    yield* Effect.promise(() =>
      app.withContext(
        RevocationStore.RevocationStore.use((store) =>
          store.revoke(jti, DateTime.fromEpochSeconds(exp)),
        ),
      ),
    );
  });

  When("the operator rotates the signing key", function* () {
    const app = yield* currentApp;
    yield* Effect.promise(() => app.withContext(KeyRing.rotateNow().pipe(Effect.orDie)));
  });

  When("the operator rotates the signing key with no grace period", function* () {
    const app = yield* currentApp;
    yield* Effect.promise(() =>
      app.withContext(KeyRing.rotateNow({ gracePeriod: Duration.zero }).pipe(Effect.orDie)),
    );
  });

  When(
    "the operator revokes the key that signed the token minted for {string}",
    function* (who: string) {
      const app = yield* currentApp;
      const kid = kidOf(yield* firstMintedFor(who));
      const revoked = yield* Effect.promise(() =>
        app.withContext(KeyRing.revoke(kid).pipe(Effect.orDie)),
      );
      assert.equal(revoked, true, "the key was not known to the key ring");
    },
  );

  When("{int} ms pass", function* (millis: number) {
    yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)));
  });

  When(
    "{string} calls the token endpoint with the token minted for {string} as a bearer credential",
    function* (_who: string, minted: string) {
      yield* request({
        method: "POST",
        path: "/jwt/token",
        headers: { authorization: `Bearer ${yield* firstMintedFor(minted)}` },
      });
    },
  );

  When(
    "someone calls the token endpoint with the token minted for {string} as a bearer credential",
    function* (minted: string) {
      yield* request({
        method: "POST",
        path: "/jwt/token",
        headers: { authorization: `Bearer ${yield* firstMintedFor(minted)}` },
      });
    },
  );

  When(
    "{string} calls the token endpoint with the opaque session token as a bearer credential",
    function* (who: string) {
      const world = yield* World;
      const actor = yield* world.users.get(who);
      yield* request({
        method: "POST",
        path: "/jwt/token",
        headers: { authorization: `Bearer ${actor.sessionToken}` },
      });
    },
  );

  When(
    "someone calls the token endpoint with the general-purpose token as a bearer credential",
    function* () {
      const world = yield* World;
      yield* request({
        method: "POST",
        path: "/jwt/token",
        headers: { authorization: `Bearer ${yield* world.tokens.get("general")}` },
      });
    },
  );

  // ---- downstream verifier ----

  Given("a downstream verifier for the audience {string}", function* (audience: string) {
    const world = yield* World;
    const http = yield* inProcessHttpClient();
    const verifier = yield* Effect.promise(() =>
      Effect.runPromise(
        Verify.makeVerifier({
          jwksUrl: "http://localhost/jwt/jwks",
          issuer: ISSUER,
          audience,
          algorithms: ["EdDSA"],
        }).pipe(Effect.provide(http)),
      ),
    );
    yield* Ref.set(world.verifier, {
      verify: (token) => Effect.runPromise(Effect.exit(verifier.verify(token))),
    });
  });

  When(
    "the downstream verifier checks the token minted for {string} {int} times",
    function* (who: string, times: number) {
      const verifier = yield* downstreamVerifier;
      const token = yield* firstMintedFor(who);
      for (let attempt = 0; attempt < times; attempt++) {
        const outcome = yield* Effect.promise(() => verifier.verify(token));
        assert.ok(Exit.isSuccess(outcome), "the downstream verifier refused a valid token");
      }
    },
  );

  When(
    "the downstream verifier checks {int} tokens signed by a key the issuer never published",
    function* (count: number) {
      const verifier = yield* downstreamVerifier;
      for (let attempt = 0; attempt < count; attempt++) {
        const token = yield* signWithUnpublishedKey();
        const outcome = yield* Effect.promise(() => verifier.verify(token));
        assert.ok(
          Exit.isFailure(outcome),
          "the downstream verifier accepted a token from an unpublished key",
        );
      }
    },
  );

  // ---- thens ----

  Then("the response is {int}", function* (status: number) {
    const response = yield* lastResponse;
    expectStatus(response.status, status, response.text);
  });

  Then("the response carries no {string} header", function* (header: string) {
    assert.equal((yield* lastResponse).headers.get(header), null);
  });

  Then(
    "the response has the header {string} set to {string}",
    function* (header: string, value: string) {
      assert.equal((yield* lastResponse).headers.get(header), value);
    },
  );

  Then(
    "the token has the header {string} set to {string}",
    function* (member: string, value: string) {
      assert.equal(headerOf(yield* mintedFromLastResponse)[member], value);
    },
  );

  Then("the token names the current signing key in its header", function* () {
    const token = yield* mintedFromLastResponse;
    const [current] = yield* jwksKeys;
    assert.ok(current, "the JWKS lists no key");
    assert.equal(kidOf(token), current["kid"]);
  });

  Then(
    "the token has the claim {string} set to {string}",
    function* (claim: string, value: string) {
      assert.equal(claimsOf(yield* mintedFromLastResponse)[claim], value);
    },
  );

  Then(
    "the token's {string} claim is the user id of {string}",
    function* (claim: string, who: string) {
      const world = yield* World;
      assert.equal(
        claimsOf(yield* mintedFromLastResponse)[claim],
        (yield* world.users.get(who)).userId,
      );
    },
  );

  Then(
    "the token's {string} claim is the session id of {string}",
    function* (claim: string, who: string) {
      const world = yield* World;
      assert.equal(
        claimsOf(yield* mintedFromLastResponse)[claim],
        (yield* world.users.get(who)).sessionId,
      );
    },
  );

  Then("the token expires {int} minutes after it was issued", function* (minutes: number) {
    const claims = claimsOf(yield* mintedFromLastResponse);
    const iat = claims["iat"];
    const exp = claims["exp"];
    assert.equal(typeof iat, "number");
    assert.equal(typeof exp, "number");
    assert.equal(Number(exp) - Number(iat), minutes * 60);
    assert.equal(typeof claims["jti"], "string");
  });

  Then(
    "the tokens minted for {string} carry different {string} claims",
    function* (who: string, claim: string) {
      const world = yield* World;
      const [first, second] = world.minted.get(who) ?? [];
      assert.ok(first !== undefined && second !== undefined, "expected two minted tokens");
      const a = claimsOf(first)[claim];
      const b = claimsOf(second)[claim];
      assert.ok(typeof a === "string" && a !== b, `expected two different ${claim} values`);
    },
  );

  Then("the JWKS lists {int} key(s)", function* (count: number) {
    assert.equal((yield* jwksKeys).length, count);
  });

  Then(
    "every JWKS key has a {string} and the {string} {string}",
    function* (member: string, other: string, value: string) {
      const keys = yield* jwksBody;
      assert.ok(keys.length > 0);
      for (const key of keys) {
        assert.equal(typeof key[member], "string", `a JWKS key has no ${member}`);
        assert.equal(key[other], value);
      }
    },
  );

  Then("no JWKS key carries a private member", function* () {
    for (const key of yield* jwksBody) {
      for (const priv of ["d", "p", "q", "dp", "dq", "qi", "privateKeyJwk", "k"]) {
        assert.ok(!(priv in key), `a JWKS key carries the private member "${priv}"`);
      }
    }
  });

  Then(
    "the JWKS does not list the key that signed the token minted for {string}",
    function* (who: string) {
      const kid = kidOf(yield* firstMintedFor(who));
      const kids = (yield* jwksKeys).map((key) => key["kid"]);
      assert.ok(!kids.includes(kid), "the revoked key is still listed");
    },
  );

  Then("the introspection answer is exactly {string}", function* (expected: string) {
    const response = yield* lastResponse;
    expectStatus(response.status, 200, response.text);
    assert.equal(response.text, expected);
  });

  Then("the token is reported active", function* () {
    const response = yield* lastResponse;
    expectStatus(response.status, 200, response.text);
    assert.equal(objectOf(response)["active"], true, response.text);
  });

  Then("the introspection claims name {string} as the subject", function* (who: string) {
    const world = yield* World;
    const claims = objectOf(yield* lastResponse)["claims"];
    assert.ok(isRecord(claims), "an active answer carries claims");
    assert.equal(claims["sub"], (yield* world.users.get(who)).userId);
  });

  Then(
    "the newest token is signed by a different key than the token minted for {string}",
    function* (who: string) {
      assert.notEqual(kidOf(yield* newestToken), kidOf(yield* firstMintedFor(who)));
    },
  );

  Then("the principal verifier refuses the general-purpose token", function* () {
    const world = yield* World;
    const app = yield* currentApp;
    const token = yield* world.tokens.get("general");
    const outcome = yield* Effect.promise(() =>
      app.withContext(Effect.exit(Jwt.Jwt.use((jwt) => jwt.verify(token)))),
    );
    assert.ok(Exit.isFailure(outcome), "verify accepted a general-purpose token as a principal");
  });

  Then("the live principal verifier refuses the general-purpose token", function* () {
    const world = yield* World;
    const app = yield* currentApp;
    const token = yield* world.tokens.get("general");
    const outcome = yield* Effect.promise(() =>
      app.withContext(Effect.exit(Jwt.Jwt.use((jwt) => jwt.verifyLive(token)))),
    );
    assert.ok(
      Exit.isFailure(outcome),
      "verifyLive accepted a general-purpose token as a principal",
    );
  });

  Then("the general-purpose verifier accepts the general-purpose token", function* () {
    const world = yield* World;
    const app = yield* currentApp;
    const token = yield* world.tokens.get("general");
    const claims = yield* Effect.promise(() =>
      app.withContext(Jwt.Jwt.use((jwt) => jwt.verifyJWT(token)).pipe(Effect.orDie)),
    );
    assert.equal(claims["iss"], ISSUER);
  });

  Then(
    "the general-purpose verifier accepts the general-purpose token for the audience {string}",
    function* (audience: string) {
      const world = yield* World;
      const app = yield* currentApp;
      const token = yield* world.tokens.get("general");
      const claims = yield* Effect.promise(() =>
        app.withContext(
          Jwt.Jwt.use((jwt) => jwt.verifyJWT(token, { audience })).pipe(Effect.orDie),
        ),
      );
      assert.equal(claims["aud"], audience);
    },
  );

  Then(
    "the general-purpose verifier refuses the general-purpose token for the default audience",
    function* () {
      const world = yield* World;
      const app = yield* currentApp;
      const token = yield* world.tokens.get("general");
      const outcome = yield* Effect.promise(() =>
        app.withContext(Effect.exit(Jwt.Jwt.use((jwt) => jwt.verifyJWT(token)))),
      );
      assert.ok(Exit.isFailure(outcome), "verifyJWT accepted a token minted for another audience");
    },
  );

  Then(
    "the general-purpose verifier refuses the token minted for {string}",
    function* (who: string) {
      const app = yield* currentApp;
      const token = yield* firstMintedFor(who);
      const outcome = yield* Effect.promise(() =>
        app.withContext(Effect.exit(Jwt.Jwt.use((jwt) => jwt.verifyJWT(token)))),
      );
      assert.ok(Exit.isFailure(outcome), "verifyJWT accepted a principal token");
    },
  );

  Then("the principal verifier accepts the token minted for {string}", function* (who: string) {
    const app = yield* currentApp;
    const token = yield* firstMintedFor(who);
    const claims = yield* Effect.promise(() =>
      app.withContext(Jwt.Jwt.use((jwt) => jwt.verify(token)).pipe(Effect.orDie)),
    );
    assert.ok(typeof claims["sub"] === "string");
  });

  Then("the downstream verifier accepts the token minted for {string}", function* (who: string) {
    const verifier = yield* downstreamVerifier;
    const token = yield* firstMintedFor(who);
    const outcome = yield* Effect.promise(() => verifier.verify(token));
    assert.ok(Exit.isSuccess(outcome), "the downstream verifier refused a valid token");
  });

  Then("the downstream verifier refuses the token minted for {string}", function* (who: string) {
    const verifier = yield* downstreamVerifier;
    const token = yield* firstMintedFor(who);
    const outcome = yield* Effect.promise(() => verifier.verify(token));
    assert.ok(Exit.isFailure(outcome), "the downstream verifier accepted a token it should refuse");
  });

  Then("the downstream verifier refuses the tampered token", function* () {
    const world = yield* World;
    const verifier = yield* downstreamVerifier;
    const token = yield* world.tokens.get("tampered");
    const outcome = yield* Effect.promise(() => verifier.verify(token));
    assert.ok(Exit.isFailure(outcome), "the downstream verifier accepted a tampered token");
  });

  Then("the JWKS was fetched {int} times", function* (count: number) {
    assert.equal(yield* Ref.get((yield* World).jwksFetches), count);
  });

  Then("the JWKS was fetched at most {int} times", function* (count: number) {
    assert.ok((yield* Ref.get((yield* World).jwksFetches)) <= count);
  });

  Given("a configuration with a key grace period of {int} minutes", function* (minutes: number) {
    const world = yield* World;
    const outcome = yield* Effect.promise(() =>
      Effect.runPromiseExit(
        Layer.build(
          JwtConfig.config({ issuer: ISSUER, keyGracePeriod: Duration.minutes(minutes) }),
        ).pipe(Effect.scoped),
      ),
    );
    yield* world.tokens.set("configuration", Exit.isFailure(outcome) ? "refused" : "accepted");
  });

  Then("the configuration is refused", function* () {
    const world = yield* World;
    assert.equal(yield* world.tokens.get("configuration"), "refused");
  });
});

const downstreamVerifier = Effect.gen(function* () {
  const { verifier } = yield* World;
  const found = yield* Ref.get(verifier);
  if (found === undefined) throw new Error("no downstream verifier was set up");
  return found;
});

/** The token in the body of the last `POST /jwt/token` response. */
const mintedFromLastResponse = Effect.gen(function* () {
  const response = yield* lastResponse;
  expectStatus(response.status, 200, response.text);
  return stringField(objectOf(response), "token");
});
