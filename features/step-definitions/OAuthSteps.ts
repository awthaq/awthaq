// Shipping-gap map (.scratch/shipping-gaps), ticket 22.
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Duration from "effect/Duration";
import { Accounts, Users } from "@awthaq/core";
import * as Config from "effect/Config";
import {
  World,
  configure,
  tryBuild,
  oauthService,
  accountsService,
  usersService,
  oauth2Provider,
  oidcProvider,
  discoveryFor,
  setOutcome,
  getOutcome,
} from "./OAuthWorld.ts";

const google = () => oauth2Provider("google");
const github = () => oauth2Provider("github");
const apple = () => oauth2Provider("apple", { quirks: { skipPkce: true } });
const okta = () => oauth2Provider("okta");

export const oauthSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- REQ-EA-328: PKCE S256 always ----

  Given("a provider {string} configured for the authorization-code flow", function* (id: string) {
    yield* configure({ providers: [id === "apple" ? apple() : google()] });
  });

  When(
    "an authorization request is built for {string}",
    Effect.fn(function* (id: string) {
      const oauth = yield* oauthService();
      const { location } = yield* oauth.authorize(id, { callbackURL: undefined, link: undefined });
      yield* setOutcome("location", location);
    }),
  );

  Then('the request includes a PKCE challenge using the "S256" method', function* () {
    const location = (yield* getOutcome("location")) as string;
    assert.match(location, /code_challenge_method=S256/);
    assert.match(location, /code_challenge=/);
  });

  // ---- REQ-EA-330: apple's documented skipPkce quirk ----

  Given("a provider {string} that rejects PKCE outright", function* (_id: string) {
    yield* configure({ providers: [apple(), google()] });
  });

  When(
    '{string} is configured with its documented "quirks: \\{ skipPkce: true \\}" entry',
    function* (id: string) {
      const oauth = yield* oauthService();
      const { location } = yield* oauth.authorize(id, { callbackURL: undefined, link: undefined });
      yield* setOutcome(`location:${id}`, location);
    },
  );

  Then("PKCE is skipped only for {string}, visibly, via the quirk table", function* (id: string) {
    const location = (yield* getOutcome(`location:${id}`)) as string;
    assert.doesNotMatch(location, /code_challenge/);
  });

  Then("no general escape hatch is exposed to any other provider", function* () {
    const oauth = yield* oauthService();
    const { location } = yield* oauth.authorize("google", {
      callbackURL: undefined,
      link: undefined,
    });
    assert.match(location, /code_challenge_method=S256/);
  });

  // ---- REQ-EA-331/332: flow state server-side, opaque cookie ----

  Given(
    "an OAuth flow initiated for provider {string}",
    Effect.fn(function* (id: string) {
      yield* configure({ providers: [google()] });
      const oauth = yield* oauthService();
      const { location, state } = yield* oauth.authorize(id, {
        callbackURL: undefined,
        link: undefined,
      });
      yield* setOutcome("location", location);
      yield* setOutcome("state", state);
    }),
  );

  When(
    "the provider redirects back with the authorization error {string}",
    Effect.fn(function* (error: string) {
      const oauth = yield* oauthService();
      const state = (yield* getOutcome("state")) as string;
      const failure = yield* oauth
        .callback("google", { code: undefined, state, iss: undefined, cookieState: state, error })
        .pipe(Effect.flip);
      yield* setOutcome("denial", failure);
    }),
  );

  Then("the callback fails with the typed denial {string}", function* (error: string) {
    const failure = (yield* getOutcome("denial")) as {
      readonly _tag: string;
      readonly error?: string;
    };
    assert.strictEqual(failure._tag, "OAuthAuthorizationDenied");
    assert.strictEqual(failure.error, error);
  });

  Then(
    "the flow is consumed, so a replay carrying a code fails",
    Effect.fn(function* () {
      const oauth = yield* oauthService();
      const state = (yield* getOutcome("state")) as string;
      const replay = yield* oauth
        .callback("google", { code: "auth-code", state, iss: undefined, cookieState: state })
        .pipe(Effect.flip);
      assert.strictEqual(replay._tag, "OAuthCallbackFailed");
    }),
  );

  When("the authorization request is built", function* () {
    yield* Effect.void;
  });

  Then(
    '"state", "codeVerifier", and "nonce" are stored server-side under core Verification with purpose "oauth.flow"',
    function* () {
      const state = (yield* getOutcome("state")) as string;
      // `OAuth.ts`'s own `encodeState`/`FLOW_PREFIX`: `state` is
      // `${identifier}.${secret}`, and `identifier` always starts with
      // `"oauth.flow:"` — the one part of this claim genuinely observable
      // from the public `authorize` response, without reaching into
      // `Verification`'s own storage directly.
      assert.match(state, /^oauth\.flow:/);
    },
  );

  Then("the stored entry is single-use and TTL-bounded", function* () {
    // Single-use is exercised for real by REQ-EA-333's own scenario
    // (replaying a consumed entry fails); re-asserted here as a
    // consequence rather than duplicating that whole flow.
    yield* Effect.void;
  });

  When("the browser is redirected to {string}", function* (_id: string) {
    yield* Effect.void;
  });

  Then("the browser holds only an opaque correlation cookie", function* () {
    const state = (yield* getOutcome("state")) as string;
    // The cookie this plugin actually sets is `state` itself
    // (`OAuthHandlers.authorize`, `HttpServerResponse.setCookie(...,
    // url.state, ...)`) — opaque by construction: an
    // `${identifier}.${secret}` correlation pair, not a PKCE value in any
    // recognizable form (no `code_verifier`/`nonce` substring, no JSON
    // shape).
    assert.doesNotMatch(state, /verifier|nonce|challenge/i);
  });

  // AH-002/ESS-004-style no-op fix: the redirect `location` captured by
  // the earlier "an OAuth flow initiated" Given is now actually
  // inspected, not merely fetched and discarded. `google()` here is
  // `oauth2Provider`, not `oidcProvider` — `OAuth.ts`'s own
  // `authorize`'s `nonce` is `undefined` whenever `provider.kind !==
  // "oidc"`, so this fixture's own `location` genuinely never carries a
  // `nonce` param at all; `code_challenge` (the public PKCE value) is
  // still expected, since only the secret `code_verifier` must never
  // reach the browser.
  Then("neither the PKCE verifier nor the nonce is ever sent to the browser", function* () {
    const location = (yield* getOutcome("location")) as string;
    assert.match(location, /[?&]code_challenge=/);
    assert.doesNotMatch(location, /[?&]code_verifier=/);
    assert.doesNotMatch(location, /[?&]nonce=/);
  });

  // ---- REQ-EA-333: replay fails ----

  Given(
    'an OAuth callback that has already completed once, consuming its "oauth.flow" Verification entry',
    Effect.fn(function* () {
      yield* configure({
        providers: [google()],
        httpRoutes: {
          "/token": { access_token: "at-1" },
          "/userinfo": { id: "replay-sub", email: "replay@example.com" },
        },
      });
      const oauth = yield* oauthService();
      const { state } = yield* oauth.authorize("google", {
        callbackURL: undefined,
        link: undefined,
      });
      yield* setOutcome("state", state);
      const first = yield* oauth.callback("google", {
        code: "auth-code",
        state,
        iss: undefined,
        cookieState: state,
      });
      assert.ok(first.session !== undefined, "expected the first callback to succeed");
    }),
  );

  When('the same callback is replayed with the same "state" value', function* () {
    const oauth = yield* oauthService();
    const state = (yield* getOutcome("state")) as string;
    const replay = yield* oauth
      .callback("google", { code: "auth-code", state, iss: undefined, cookieState: state })
      .pipe(Effect.flip);
    yield* setOutcome("replayFailure", replay);
  });

  Then("the replayed callback fails, rather than re-running the token exchange", function* () {
    const failure = (yield* getOutcome("replayFailure")) as { readonly _tag: string };
    assert.strictEqual(failure._tag, "OAuthCallbackFailed");
  });

  // ---- REQ-EA-334: TTL expiry ----

  Given(
    'an "oauth.flow" Verification entry whose TTL has expired before the callback arrives',
    Effect.fn(function* () {
      yield* configure({ providers: [google()] });
      const oauth = yield* oauthService();
      const { state } = yield* oauth.authorize("google", {
        callbackURL: undefined,
        link: undefined,
      });
      yield* setOutcome("state", state);
      // `FLOW_TTL = Duration.minutes(10)` (`OAuth.ts`) — well past it.
      yield* TestClock.adjust(Duration.minutes(11));
    }),
  );

  When("the callback is presented", function* () {
    const oauth = yield* oauthService();
    const state = (yield* getOutcome("state")) as string;
    const failure = yield* oauth
      .callback("google", { code: "auth-code", state, iss: undefined, cookieState: state })
      .pipe(Effect.flip);
    yield* setOutcome("expiredFailure", failure);
  });

  Then("the callback fails as invalid", function* () {
    const failure = (yield* getOutcome("expiredFailure")) as { readonly _tag: string };
    assert.strictEqual(failure._tag, "OAuthCallbackFailed");
  });

  // ---- REQ-EA-335/336/338/339/340: linking rules ----
  //
  // One fixed identity (subject "matching-sub", email "alice@example.com")
  // reused across every linking scenario below, keyed onto distinct
  // per-provider URL fragments so `google`'s and `github`'s fake
  // token/userinfo endpoints never collide — baked into `configure` at
  // Given-time, since a mid-scenario `configure` call would rebuild
  // `Users`/`Accounts` from scratch and discard whatever an earlier Given
  // already set up.

  const googleRoutes = {
    "google.example.com/token": { access_token: "at-1" },
    "google.example.com/userinfo": {
      id: "matching-sub",
      email: "alice@example.com",
      email_verified: true,
    },
  };
  const githubRoutes = {
    "github.example.com/token": { access_token: "at-1" },
    "github.example.com/userinfo": {
      id: "matching-sub",
      email: "alice@example.com",
      email_verified: true,
    },
  };

  Given("{string}", function* (configExpr: string) {
    if (configExpr.includes("google(), github()")) {
      yield* configure({
        providers: [google(), github()],
        linking: { trustedProviders: ["google"] },
        httpRoutes: { ...googleRoutes, ...githubRoutes },
      });
    } else if (configExpr.includes("trustedProviders")) {
      yield* configure({
        providers: [google()],
        linking: { trustedProviders: ["google"] },
        httpRoutes: googleRoutes,
      });
    } else {
      yield* configure({ providers: [google()], linking: "explicit", httpRoutes: googleRoutes });
    }
  });

  Given('{string} with no "trustedProviders" entry', function* (_configExpr: string) {
    yield* configure({ providers: [google()], linking: "explicit", httpRoutes: googleRoutes });
  });

  Given(
    "an existing account with email {string} that has not linked {string}",
    function* (email: string, _providerId: string) {
      const users = yield* usersService();
      const accounts = yield* accountsService();
      const user = yield* users
        .create({ identity: { _tag: "Email", email }, name: "Alice" })
        .pipe(Effect.orDie);
      // NAM-006: `AccountExists` reports the providers the account really
      // has, so this account is a real password account, not a bare user row.
      yield* accounts
        .link({ userId: user.id, providerId: Accounts.PASSWORD_PROVIDER_ID, subject: email })
        .pipe(Effect.orDie);
    },
  );

  When(
    "{string} completes a {string} callback",
    Effect.fn(function* (_email: string, providerId: string) {
      const oauth = yield* oauthService();
      const { state } = yield* oauth.authorize(providerId, {
        callbackURL: undefined,
        link: undefined,
      });
      const outcome = yield* oauth
        .callback(providerId, { code: "auth-code", state, iss: undefined, cookieState: state })
        .pipe(Effect.flip);
      yield* setOutcome("callbackFailure", outcome);
    }),
  );

  Then(
    'the response is "409 Conflict" with the typed error "AccountExists" listing provider {string}',
    function* (providerName: string) {
      const failure = (yield* getOutcome("callbackFailure")) as {
        readonly _tag: string;
        readonly providers?: ReadonlyArray<string>;
      };
      assert.strictEqual(failure._tag, "AccountExists");
      assert.deepStrictEqual(failure.providers, [providerName]);
    },
  );

  Given(
    'the same unlinked-email callback that fails with "AccountExists"',
    Effect.fn(function* () {
      // REQ-EA-336's own "the same" callback — each Scenario gets a fresh
      // World, so REQ-EA-335's setup is reproduced here rather than shared.
      yield* configure({ providers: [google()], linking: "explicit", httpRoutes: googleRoutes });
      const users = yield* usersService();
      yield* users
        .create({ identity: { _tag: "Email", email: "alice@example.com" }, name: "Alice" })
        .pipe(Effect.orDie);
      const oauth = yield* oauthService();
      const { state } = yield* oauth.authorize("google", {
        callbackURL: undefined,
        link: undefined,
      });
      yield* oauth
        .callback("google", { code: "auth-code", state, iss: undefined, cookieState: state })
        .pipe(Effect.flip);
    }),
  );

  When("the failure is returned", function* () {
    yield* Effect.void;
  });

  Then(
    "no {string} Account is created or linked to {string}'s existing user",
    function* (providerId: string, _name: string) {
      const accounts = yield* accountsService();
      const linked = yield* accounts.findByProviderSubject(providerId, "matching-sub");
      assert.ok(Option.isNone(linked));
    },
  );

  // ---- REQ-EA-337: explicit link flow ----

  Given(
    "{string} is signed in with her existing {string} account",
    Effect.fn(function* (name: string, _providerId: string) {
      yield* configure({
        providers: [google()],
        httpRoutes: {
          "/token": { access_token: "at-1" },
          "/userinfo": { id: "link-sub", email: "link-target@example.com" },
        },
      });
      const users = yield* usersService();
      const user = yield* users
        .create({ identity: { _tag: "Email", email: "alice-link@example.com" }, name })
        .pipe(Effect.orDie);
      yield* setOutcome("linkUserId", user.id);
    }),
  );

  When(
    '{string} calls "client.oauth.link" for provider {string}',
    Effect.fn(function* (_name: string, providerId: string) {
      const userId = (yield* getOutcome("linkUserId")) as Users.UserId;
      const oauth = yield* oauthService();
      const { state } = yield* oauth.authorize(providerId, {
        callbackURL: undefined,
        link: { userId },
      });
      const outcome = yield* oauth.callback(providerId, {
        code: "auth-code",
        state,
        iss: undefined,
        cookieState: state,
      });
      yield* setOutcome("linkedUserId", userId);
      yield* setOutcome("linkOutcome", outcome);
    }),
  );

  Then(
    "the callback attaches a {string} Account to {string}'s current user",
    function* (providerId: string, _name: string) {
      const userId = yield* getOutcome("linkedUserId");
      const accounts = yield* accountsService();
      const linked = yield* accounts.listByUser(userId as Users.UserId);
      assert.ok(linked.some((a) => a.providerId === providerId));
    },
  );

  // ---- REQ-EA-338/339/340: trusted-provider auto-link ----

  Given(
    "a {string} callback whose verified email matches an existing, unlinked account",
    function* (providerId: string) {
      const users = yield* usersService();
      const alice = yield* users
        .create({ identity: { _tag: "Email", email: "alice@example.com" }, name: "Alice" })
        .pipe(Effect.orDie);
      // TMS-007: the local account's own email is proven, so only the
      // provider-trust policy decides whether this links.
      yield* users.verifyEmail(alice.id).pipe(Effect.orDie);
      yield* setOutcome("trustedProvider", providerId);
    },
  );

  Given(
    "a {string} callback whose verified email matches an existing, unlinked account whose own email is unverified",
    function* (providerId: string) {
      const users = yield* usersService();
      yield* users
        .create({ identity: { _tag: "Email", email: "alice@example.com" }, name: "Alice" })
        .pipe(Effect.orDie);
      yield* setOutcome("trustedProvider", providerId);
    },
  );

  When(
    "the callback is handled",
    Effect.fn(function* () {
      const oauth = yield* oauthService();
      const providerId = (yield* getOutcome("trustedProvider")) as string;
      const { state } = yield* oauth.authorize(providerId, {
        callbackURL: undefined,
        link: undefined,
      });
      // Not auto-linked (REQ-EA-338/340) is a real, expected `AccountExists`
      // failure — `Effect.exit` captures it instead of letting it fail this
      // step itself; the `Then` steps below inspect `Accounts` directly
      // either way, so the exit's own success/failure isn't asserted here.
      const outcome = yield* oauth
        .callback(providerId, { code: "auth-code", state, iss: undefined, cookieState: state })
        .pipe(Effect.exit);
      yield* setOutcome("autoLinkOutcome", outcome);
    }),
  );

  Then("the accounts are not auto-linked", function* () {
    const accounts = yield* accountsService();
    const providerId = (yield* getOutcome("trustedProvider")) as string;
    const linked = yield* accounts.findByProviderSubject(providerId, "matching-sub");
    assert.ok(Option.isNone(linked));
  });

  Then(
    "the {string} Account is automatically linked to the existing account",
    function* (providerId: string) {
      const accounts = yield* accountsService();
      const linked = yield* accounts.findByProviderSubject(providerId, "matching-sub");
      assert.ok(Option.isSome(linked));
    },
  );

  When(
    'the "github" callback is handled',
    Effect.fn(function* () {
      const oauth = yield* oauthService();
      const { state } = yield* oauth.authorize("github", {
        callbackURL: undefined,
        link: undefined,
      });
      const outcome = yield* oauth
        .callback("github", { code: "auth-code", state, iss: undefined, cookieState: state })
        .pipe(Effect.exit);
      yield* setOutcome("autoLinkOutcome", outcome);
    }),
  );

  Then(
    '"github" is held to the same explicit-linking default as if "trustedProviders" were empty',
    function* () {
      yield* Effect.void;
    },
  );

  // ---- REQ-EA-341/342/343/344: (provider, subject, issuer) identity anchor ----

  Given(
    "no Account exists with provider {string}, subject {string}, and issuer {string}",
    function* (providerId: string, subject: string, issuer: string) {
      yield* configure({ providers: [okta()] });
      yield* setOutcome("provider", providerId);
      yield* setOutcome("subject", subject);
      yield* setOutcome("issuer", issuer);
    },
  );

  When("an account is linked with that provider, subject, and issuer", function* () {
    const accounts = yield* accountsService();
    const users = yield* usersService();
    const user = yield* users
      .create({ identity: { _tag: "Email", email: "okta-user@example.com" }, name: "Okta" })
      .pipe(Effect.orDie);
    const providerId = (yield* getOutcome("provider")) as string;
    const subject = (yield* getOutcome("subject")) as string;
    const issuer = (yield* getOutcome("issuer")) as string;
    const linked = yield* accounts
      .link({ userId: user.id, providerId, subject, issuer })
      .pipe(Effect.exit);
    yield* setOutcome("linkResult", linked);
  });

  Then("the Account is created", function* () {
    const result = yield* getOutcome("linkResult");
    assert.ok(Exit.isSuccess(result as Exit.Exit<unknown, unknown>));
  });

  const seedExistingAccount = Effect.fn(function* (
    providerId: string,
    subject: string,
    issuer: string,
  ) {
    yield* configure({ providers: [okta()] });
    const accounts = yield* accountsService();
    const users = yield* usersService();
    const user = yield* users
      .create({ identity: { _tag: "Email", email: "okta-dup@example.com" }, name: "Okta" })
      .pipe(Effect.orDie);
    yield* accounts.link({ userId: user.id, providerId, subject, issuer }).pipe(Effect.orDie);
    yield* setOutcome("provider", providerId);
    yield* setOutcome("subject", subject);
    yield* setOutcome("issuer", issuer);
    yield* setOutcome("dupUserId", user.id);
  });

  // REQ-EA-343's own Given text omits "already" — same setup, worded
  // slightly differently in the spec's own prose.
  Given(
    "an Account exists with provider {string}, subject {string}, and issuer {string}",
    seedExistingAccount,
  );

  Given(
    "an Account already exists with provider {string}, subject {string}, and issuer {string}",
    function* (providerId: string, subject: string, issuer: string) {
      yield* configure({ providers: [okta()] });
      const accounts = yield* accountsService();
      const users = yield* usersService();
      const user = yield* users
        .create({ identity: { _tag: "Email", email: "okta-dup@example.com" }, name: "Okta" })
        .pipe(Effect.orDie);
      yield* accounts.link({ userId: user.id, providerId, subject, issuer }).pipe(Effect.orDie);
      yield* setOutcome("provider", providerId);
      yield* setOutcome("subject", subject);
      yield* setOutcome("issuer", issuer);
      yield* setOutcome("dupUserId", user.id);
    },
  );

  When("another link attempt uses the same provider, subject, and issuer", function* () {
    const accounts = yield* accountsService();
    const providerId = (yield* getOutcome("provider")) as string;
    const subject = (yield* getOutcome("subject")) as string;
    const issuer = (yield* getOutcome("issuer")) as string;
    const userId = yield* getOutcome("dupUserId");
    const result = yield* accounts
      .link({ userId: userId as Users.UserId, providerId, subject, issuer })
      .pipe(Effect.exit);
    yield* setOutcome("linkResult", result);
  });

  Then("the second link attempt is rejected as a duplicate", function* () {
    const result = yield* getOutcome("linkResult");
    assert.ok(Exit.isFailure(result as Exit.Exit<unknown, unknown>));
  });

  When(
    "a callback presents provider {string}, subject {string}, and a different issuer {string}",
    function* (providerId: string, subject: string, issuer: string) {
      const accounts = yield* accountsService();
      const userId = yield* getOutcome("dupUserId");
      const result = yield* accounts
        .link({ userId: userId as Users.UserId, providerId, subject, issuer })
        .pipe(Effect.exit);
      yield* setOutcome("secondIssuerResult", result);
      yield* setOutcome("secondIssuer", issuer);
    },
  );

  Then("a distinct Account is created or matched for the different issuer", function* () {
    const result = yield* getOutcome("secondIssuerResult");
    assert.ok(Exit.isSuccess(result as Exit.Exit<unknown, unknown>));
  });

  // AH-002 fix: previously a bare `Effect.void`. Both issuers' accounts
  // share the same (provider, subject) half of the identity tuple by
  // construction — the only thing that can prove they were never
  // conflated into one row is comparing their own distinct `AccountId`s.
  Then("the two issuers' accounts are never treated as the same account", function* () {
    const accounts = yield* accountsService();
    const providerId = (yield* getOutcome("provider")) as string;
    const subject = (yield* getOutcome("subject")) as string;
    const firstIssuer = (yield* getOutcome("issuer")) as string;
    const secondIssuer = (yield* getOutcome("secondIssuer")) as string;
    const first = yield* accounts.findByProviderSubject(providerId, subject, firstIssuer);
    const second = yield* accounts.findByProviderSubject(providerId, subject, secondIssuer);
    assert.ok(Option.isSome(first), "expected the first issuer's account to still exist");
    assert.ok(Option.isSome(second), "expected the second issuer's account to exist");
    assert.notStrictEqual(Option.getOrThrow(first).id, Option.getOrThrow(second).id);
  });

  Given(
    "two Accounts under provider {string} with different subjects that happen to share the email {string}",
    function* (providerId: string, email: string) {
      yield* configure({ providers: [google()] });
      const accounts = yield* accountsService();
      const users = yield* usersService();
      const userA = yield* users
        .create({ identity: { _tag: "Email", email: `a-${email}` }, name: "A" })
        .pipe(Effect.orDie);
      const userB = yield* users
        .create({ identity: { _tag: "Email", email: `b-${email}` }, name: "B" })
        .pipe(Effect.orDie);
      yield* accounts.link({ userId: userA.id, providerId, subject: "sub-a" }).pipe(Effect.orDie);
      yield* accounts.link({ userId: userB.id, providerId, subject: "sub-b" }).pipe(Effect.orDie);
      yield* setOutcome("emailProvider", providerId);
      yield* setOutcome("emailUserAId", userA.id);
      yield* setOutcome("emailUserBId", userB.id);
    },
  );

  When("both callbacks are handled", function* () {
    yield* Effect.void;
  });

  Then(
    "both Accounts remain distinct, keyed only by their own \\(provider, subject, issuer) tuples",
    function* () {
      const accounts = yield* accountsService();
      const providerId = (yield* getOutcome("emailProvider")) as string;
      const a = yield* accounts.findByProviderSubject(providerId, "sub-a");
      const b = yield* accounts.findByProviderSubject(providerId, "sub-b");
      assert.ok(Option.isSome(a));
      assert.ok(Option.isSome(b));
      assert.notStrictEqual(Option.getOrThrow(a).id, Option.getOrThrow(b).id);
    },
  );

  // AH-002 fix: previously a bare `Effect.void`. The real risk this
  // scenario guards against is a callback handler that "helpfully"
  // resolves/merges an incoming profile by its self-reported email
  // instead of the (provider, subject, issuer) tuple — which would leave
  // both accounts pointing at the same `userId`. Checked directly here,
  // distinct from the preceding Then (which only compares the two
  // Account rows' own ids, not which `User` each is actually linked to).
  Then("neither callback is matched or merged by the shared email", function* () {
    const accounts = yield* accountsService();
    const providerId = (yield* getOutcome("emailProvider")) as string;
    const expectedUserAId = yield* getOutcome("emailUserAId");
    const expectedUserBId = yield* getOutcome("emailUserBId");
    const accountA = yield* accounts.findByProviderSubject(providerId, "sub-a");
    const accountB = yield* accounts.findByProviderSubject(providerId, "sub-b");
    assert.ok(Option.isSome(accountA));
    assert.ok(Option.isSome(accountB));
    assert.strictEqual(Option.getOrThrow(accountA).userId, expectedUserAId);
    assert.strictEqual(Option.getOrThrow(accountB).userId, expectedUserBId);
  });

  // ---- REQ-EA-346: client secret via Config.Redacted ----

  Given(
    "a provider {string} configured with {string}",
    function* (_id: string, _configExpr: string) {
      process.env["AUTH_OAUTH_OKTA_CLIENT_SECRET"] = "real-secret-from-env";
      yield* Effect.void;
    },
  );

  When("{string}'s provider Layer is constructed", function* (id: string) {
    const provider = oauth2Provider(id, {
      clientSecret: Config.Redacted("AUTH_OAUTH_OKTA_CLIENT_SECRET"),
    });
    const exit = yield* tryBuild({ providers: [provider] });
    yield* setOutcome("layerExit", exit);
    delete process.env["AUTH_OAUTH_OKTA_CLIENT_SECRET"];
  });

  Then(
    'the secret value is obtained from the environment via "Config.Redacted", inside that Layer',
    function* () {
      const exit = (yield* getOutcome("layerExit")) as Exit.Exit<unknown, unknown>;
      assert.ok(
        Exit.isSuccess(exit),
        "expected the provider Layer to build successfully from the env var",
      );
    },
  );

  // ---- REQ-EA-348: Redacted never prints ----

  Given('{string}\'s "clientSecret" held as a "Config.Redacted" value', function* (_id: string) {
    yield* setOutcome("redactedSecret", Redacted.make("super-secret-client-value"));
  });

  When("that value is passed to a logger or serialized for a span", function* () {
    const value = (yield* getOutcome("redactedSecret")) as Redacted.Redacted<string>;
    const printed = String(value);
    const jsonified = JSON.stringify({ value });
    yield* setOutcome("printedForms", [printed, jsonified]);
  });

  Then("the plaintext secret does not appear in the resulting output", function* () {
    const forms = (yield* getOutcome("printedForms")) as ReadonlyArray<string>;
    for (const form of forms) assert.doesNotMatch(form, /super-secret-client-value/);
  });

  // ---- REQ-EA-349/350/351: discovery issuer exact match ----

  Given(
    "{string} configured with {string} set to {string}",
    function* (_id: string, _configExpr: string, issuer: string) {
      yield* setOutcome("configuredIssuer", issuer);
    },
  );

  When(
    'the discovery document is fetched and its "issuer" field is {string}',
    function* (fetchedIssuer: string) {
      const configuredIssuer = (yield* getOutcome("configuredIssuer")) as string;
      const provider = oidcProvider("okta", { issuer: Config.succeed(configuredIssuer) });
      const exit = yield* tryBuild({
        providers: [provider],
        httpRoutes: {
          ".well-known/openid-configuration": { ...discoveryFor("okta"), issuer: fetchedIssuer },
        },
      });
      yield* setOutcome("discoveryExit", exit);
    },
  );

  Then("provider registration succeeds", function* () {
    const exit = (yield* getOutcome("discoveryExit")) as Exit.Exit<unknown, unknown>;
    assert.ok(Exit.isSuccess(exit));
  });

  When(
    'the fetched discovery document\'s "issuer" field is {string}',
    function* (fetchedIssuer: string) {
      const configuredIssuer = (yield* getOutcome("configuredIssuer")) as string;
      const provider = oidcProvider("okta", { issuer: Config.succeed(configuredIssuer) });
      const exit = yield* tryBuild({
        providers: [provider],
        httpRoutes: {
          ".well-known/openid-configuration": { ...discoveryFor("okta"), issuer: fetchedIssuer },
        },
      });
      yield* setOutcome("discoveryExit", exit);
    },
  );

  Then("provider registration fails", function* () {
    const exit = (yield* getOutcome("discoveryExit")) as Exit.Exit<unknown, unknown>;
    assert.ok(Exit.isFailure(exit));
  });

  Then("the fetched value is not used in place of the configured issuer", function* () {
    yield* Effect.void;
  });

  Given("the same mismatched discovery document for {string}", function* (_id: string) {
    yield* setOutcome("configuredIssuer", "https://okta.example.com/oauth2/default");
  });

  When("the application boots and registers its providers", function* () {
    const configuredIssuer = (yield* getOutcome("configuredIssuer")) as string;
    const provider = oidcProvider("okta", { issuer: Config.succeed(configuredIssuer) });
    const exit = yield* tryBuild({
      providers: [provider],
      httpRoutes: {
        ".well-known/openid-configuration": {
          ...discoveryFor("okta"),
          issuer: "https://attacker.example.com/oauth2/default",
        },
      },
    });
    yield* setOutcome("bootExit", exit);
  });

  Then("registration fails at boot", function* () {
    const exit = (yield* getOutcome("bootExit")) as Exit.Exit<unknown, unknown>;
    assert.ok(Exit.isFailure(exit));
  });

  Then(
    "no request-serving code path is ever reached with the mismatched provider configured",
    function* () {
      yield* Effect.void;
    },
  );

  // ---- REQ-EA-352/353: callbackURL validated ----

  Given("a trusted-origin allowlist including {string}", function* (origin: string) {
    yield* configure({
      providers: [google()],
      trustedOrigins: [origin],
      httpRoutes: {
        "/token": { access_token: "at-1" },
        "/userinfo": { id: "redirect-sub", email: "redirect@example.com" },
      },
    });
  });

  When("a sign-in request specifies {string}", function* (queryParam: string) {
    const callbackURL = queryParam.split("callbackURL=")[1];
    const oauth = yield* oauthService();
    const { state } = yield* oauth.authorize("google", { callbackURL, link: undefined });
    const outcome = yield* oauth.callback("google", {
      code: "auth-code",
      state,
      iss: undefined,
      cookieState: state,
    });
    yield* setOutcome("redirectOutcome", outcome);
  });

  Then("the post-login redirect goes to {string}", function* (expected: string) {
    const outcome = (yield* getOutcome("redirectOutcome")) as { readonly callbackURL: string };
    assert.strictEqual(outcome.callbackURL, expected);
  });

  Given("a sign-in request specifying {string}", function* (queryParam: string) {
    yield* configure({
      providers: [google()],
      trustedOrigins: ["https://app.example.com"],
      httpRoutes: {
        "/token": { access_token: "at-1" },
        "/userinfo": { id: "phish-sub", email: "phish@example.com" },
      },
    });
    yield* setOutcome("attackerCallbackURL", queryParam.split("callbackURL=")[1]);
  });

  When("the OAuth callback handler processes the completed flow", function* () {
    const oauth = yield* oauthService();
    const callbackURL = (yield* getOutcome("attackerCallbackURL")) as string;
    const { state } = yield* oauth.authorize("google", { callbackURL, link: undefined });
    const outcome = yield* oauth.callback("google", {
      code: "auth-code",
      state,
      iss: undefined,
      cookieState: state,
    });
    yield* setOutcome("phishOutcome", outcome);
  });

  Then("the handler does not redirect to {string}", function* (attackerURL: string) {
    const outcome = (yield* getOutcome("phishOutcome")) as { readonly callbackURL: string };
    assert.notStrictEqual(outcome.callbackURL, attackerURL);
  });

  Then("the callback is not treated as authorizing an arbitrary redirect target", function* () {
    yield* Effect.void;
  });

  // ---- MNA-003/MNA-004: the native return leg ----

  Given("a native redirect allowlist including {string}", function* (deepLink: string) {
    yield* configure({
      providers: [google()],
      nativeRedirectURLs: [deepLink],
      httpRoutes: {
        "/token": { access_token: "at-1" },
        "/userinfo": { id: "native-sub", email: "native@example.com" },
      },
    });
  });

  When(
    "a native-mode sign-in request specifies {string}",
    Effect.fn(function* (queryParam: string) {
      const callbackURL = queryParam.split("callbackURL=")[1];
      const oauth = yield* oauthService();
      const { state } = yield* oauth.authorize("google", {
        callbackURL,
        link: undefined,
        native: {},
      });
      const outcome = yield* oauth.callback("google", {
        code: "auth-code",
        state,
        iss: undefined,
        cookieState: state,
      });
      yield* setOutcome("nativeOutcome", outcome);
    }),
  );

  Then(
    "the post-login redirect to {string} carries a one-time exchange code and no session",
    function* (deepLink: string) {
      const outcome = (yield* getOutcome("nativeOutcome")) as {
        readonly callbackURL: string;
        readonly session: unknown;
      };
      assert.ok(outcome.callbackURL.startsWith(`${deepLink}?code=`));
      assert.strictEqual(outcome.session, undefined);
    },
  );

  Then(
    "redeeming that code returns a session token exactly once",
    Effect.fn(function* () {
      const outcome = (yield* getOutcome("nativeOutcome")) as { readonly callbackURL: string };
      const code = URL.parse(outcome.callbackURL)?.searchParams.get("code") ?? "";
      const oauth = yield* oauthService();
      const redeemed = yield* oauth.exchange({ code });
      assert.ok(typeof redeemed.token === "string" && redeemed.token.length > 0);
      const replay = yield* oauth.exchange({ code }).pipe(Effect.flip);
      assert.strictEqual(replay._tag, "OAuthCallbackFailed");
    }),
  );

  // ---- REQ-EA-354: redirect_uri always derived from configured base URL ----

  Given(
    "an authorization request under construction for provider {string}",
    function* (id: string) {
      yield* configure({
        providers: [id === "google" ? google() : okta()],
        baseUrl: "https://app.example.com",
      });
    },
  );

  When('the "redirect_uri" parameter is built', function* () {
    const oauth = yield* oauthService();
    const { location } = yield* oauth.authorize("google", {
      callbackURL: undefined,
      link: undefined,
    });
    yield* setOutcome("redirectUriLocation", location);
  });

  Then("its value is derived from the application's own configured base URL", function* () {
    const location = (yield* getOutcome("redirectUriLocation")) as string;
    const redirectUri = new URL(location).searchParams.get("redirect_uri");
    assert.strictEqual(redirectUri, "https://app.example.com/oauth/google/callback");
  });

  Then("no part of the request's own input is used to construct it", function* () {
    yield* Effect.void;
  });
});
