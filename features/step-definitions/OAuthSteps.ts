// Shipping-gap map (.scratch/shipping-gaps), ticket 22.
import { defineSteps, ParameterTypeStore } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Duration from "effect/Duration";
import { Accounts, Users } from "@awthaq/core";
import { OAuthProvider } from "@awthaq/oauth";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ConfigProvider from "effect/ConfigProvider";
import {
  World,
  configure,
  tryBuild,
  oauthService,
  verificationService,
  accountsService,
  usersService,
  oauth2Provider,
  oidcProvider,
  discoveryFor,
  SqliteIdentityStores,
  setOutcome,
  getOutcome,
} from "./OAuthWorld.ts";

const google = () => oauth2Provider("google");
const github = () => oauth2Provider("github");
const apple = () => oauth2Provider("apple", { quirks: { skipPkce: true } });
const okta = () => oauth2Provider("okta");

/** What an `oauthConfig` literal in the feature text stands for. */
export interface OAuthConfigChoice {
  readonly providers: ReadonlyArray<"google" | "github">;
  readonly linking: "explicit" | { readonly trustedProviders: ReadonlyArray<string> };
}

// The raw literals exactly as they read in 16-oauth.feature (escaped quotes included).
const OAUTH_CONFIG_LITERALS: Readonly<Record<string, OAuthConfigChoice>> = {
  '"oauth({ providers: [google()], linking: \\"explicit\\" })"': {
    providers: ["google"],
    linking: "explicit",
  },
  '"oauth({ providers: [google()], linking: { trustedProviders: [\\"google\\"] } })"': {
    providers: ["google"],
    linking: { trustedProviders: ["google"] },
  },
  '"oauth({ providers: [google(), github()], linking: { trustedProviders: [\\"google\\"] } })"': {
    providers: ["google", "github"],
    linking: { trustedProviders: ["google"] },
  },
};

/** Registered by 16-oauth.steps.test.ts: `{oauthConfig}` matches a known literal and yields its meaning. */
export const oauthParameterTypes = ParameterTypeStore.layer([
  {
    name: "oauthConfig",
    regexp:
      /"oauth\(\{ providers: \[[^\]]*\], linking: (?:\\"explicit\\"|\{ trustedProviders: \[[^\]]*\] \}) \}\)"/,
    transform: (literal: string) => {
      const known = OAUTH_CONFIG_LITERALS[literal];
      if (known === undefined) throw new Error(`unrecognised oauth config literal: ${literal}`);
      return known;
    },
    definedAt: Option.some("OAuthSteps.ts"),
    useForSnippets: Option.none(),
    preferForRegexpMatch: Option.none(),
  },
]).pipe(Layer.orDie);

export const oauthSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- REQ-EA-328: PKCE S256 always ----

  Given("a provider {string} configured for the authorization-code flow", function* (id: string) {
    yield* configure({ providers: [id === "apple" ? apple() : google()] });
  });

  When(
    "an authorization request is built for {string}",
    Effect.fn(function* (id: string) {
      const oauth = yield* oauthService();
      const { location, state } = yield* oauth.authorize(id, {
        callbackURL: undefined,
        link: undefined,
      });
      yield* setOutcome("location", location);
      yield* setOutcome("state", state);
    }),
  );

  Then('the request includes a PKCE challenge using the "S256" method', function* () {
    const location = (yield* getOutcome("location")) as string;
    assert.match(location, /code_challenge_method=S256/);
    assert.match(location, /code_challenge=/);
  });

  // ---- REQ-EA-329: no configuration turns PKCE off (a type-level property, fixtured) ----
  //
  // `pkce: true` is a literal type, so the property is a compile error rather than a runtime
  // request. The `@ts-expect-error` lines below are that fixture: `tsc` over this suite fails
  // if either stops being an error. The runtime half is the factory's behaviour: even a value
  // smuggled past the type never reaches the provider.

  Given('the "OAuthProvider" interface', function* () {
    yield* setOutcome("pkceBase", oauth2Provider("okta"));
  });

  When("a provider is configured", function* () {
    const base = (yield* getOutcome("pkceBase")) as OAuthProvider.OAuthProviderConfig;
    // @ts-expect-error BEH-EA-121: `pkce` is not an option of the provider factories.
    const smuggled = OAuthProvider.oauth2({ ...base, pkce: false });
    yield* setOutcome("pkceSmuggled", smuggled.pkce);
    yield* setOutcome("pkceDefault", base.pkce);
  });

  Then(
    'no option exists to turn PKCE off, since the interface declares "pkce" as structurally "true"',
    function* () {
      const base = (yield* getOutcome("pkceBase")) as OAuthProvider.OAuthProviderConfig;
      // @ts-expect-error BEH-EA-121: `OAuthProviderConfig.pkce` is the literal `true`, never `boolean`.
      const disabled: OAuthProvider.OAuthProviderConfig = { ...base, pkce: false };
      assert.ok(disabled !== undefined);
      assert.strictEqual(yield* getOutcome("pkceDefault"), true);
      assert.strictEqual(yield* getOutcome("pkceSmuggled"), true);
    },
  );

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

  // REQ-EA-331: the When is the action — a fresh authorization request, whose stored flow the
  // Thens inspect (the Given's own initiated flow is only the precondition state).
  When(
    "the authorization request is built",
    Effect.fn(function* () {
      const oauth = yield* oauthService();
      const { location, state } = yield* oauth.authorize("google", {
        callbackURL: undefined,
        link: undefined,
      });
      yield* setOutcome("location", location);
      yield* setOutcome("state", state);
    }),
  );

  // The state token is `${identifier}.${secret}`; consuming it hands back what was stored, which
  // is also what makes "single-use" observable (a second consume must fail).
  const splitState = (state: string) => {
    const separator = state.lastIndexOf(".");
    return {
      identifier: state.slice(0, separator),
      secret: Redacted.make(state.slice(separator + 1)),
    };
  };

  Then(
    '"state", "codeVerifier", and "nonce" are stored server-side under core Verification with purpose "oauth.flow"',
    function* () {
      const state = (yield* getOutcome("state")) as string;
      const verification = yield* verificationService();
      const { identifier, secret } = splitState(state);
      assert.match(identifier, /^oauth\.flow:/);
      const stored = yield* verification.consume(identifier, secret).pipe(Effect.orDie);
      const payload = stored.payload as {
        readonly providerId: string;
        readonly codeVerifier: unknown;
        readonly nonce?: unknown;
      };
      assert.strictEqual(payload.providerId, "google");
      // The verifier is stored (encrypted at rest — never the plaintext, which is not in the URL either).
      assert.ok(payload.codeVerifier !== undefined && payload.codeVerifier !== null);
      // `google` here is a plain oauth2 provider: it has no id_token, so no nonce exists to store.
      // The OIDC counterpart (nonce persisted too) is the next scenario.
      assert.strictEqual(payload.nonce, undefined);
      yield* setOutcome("consumedFlowIdentifier", identifier);
      yield* setOutcome("consumedFlowSecret", secret);
    },
  );

  // The OIDC counterpart of REQ-EA-331: an id_token provider also has a nonce to persist.
  Given(
    "an OIDC flow configured for provider {string}",
    Effect.fn(function* (id: string) {
      yield* configure({
        providers: [oidcProvider(id)],
        httpRoutes: { ".well-known/openid-configuration": discoveryFor(id) },
      });
    }),
  );

  const consumeStoredFlow = Effect.fn(function* () {
    const verification = yield* verificationService();
    const { identifier, secret } = splitState((yield* getOutcome("state")) as string);
    const stored = yield* verification.consume(identifier, secret).pipe(Effect.orDie);
    return stored.payload as { readonly codeVerifier?: unknown; readonly nonce?: unknown };
  });

  Then(
    'the stored flow entry carries an encrypted "codeVerifier" and an encrypted "nonce"',
    function* () {
      const payload = yield* consumeStoredFlow();
      assert.ok(typeof payload.codeVerifier === "string" && payload.codeVerifier.length > 0);
      assert.ok(typeof payload.nonce === "string" && payload.nonce.length > 0);
      yield* setOutcome("storedPayload", JSON.stringify(payload));
    },
  );

  Then(
    "the nonce sent to the provider does not appear in plaintext in the stored entry",
    function* () {
      const location = (yield* getOutcome("location")) as string;
      const sentNonce = new URL(location).searchParams.get("nonce");
      assert.ok(sentNonce !== null && sentNonce.length > 0, "an OIDC request carries a nonce");
      assert.ok(!((yield* getOutcome("storedPayload")) as string).includes(sentNonce));
    },
  );

  Then("the stored entry is single-use and TTL-bounded", function* () {
    const verification = yield* verificationService();
    // Single-use: the entry the previous Then consumed cannot be consumed again.
    const identifier = (yield* getOutcome("consumedFlowIdentifier")) as string;
    const secret = (yield* getOutcome("consumedFlowSecret")) as Redacted.Redacted<string>;
    const replay = yield* verification.consume(identifier, secret).pipe(Effect.exit);
    assert.ok(Exit.isFailure(replay));
    assert.match(String(replay.cause), /TokenConsumed/);
    // TTL-bounded: a fresh flow's entry is no longer consumable once its ten minutes have passed.
    const oauth = yield* oauthService();
    const { state } = yield* oauth.authorize("google", { callbackURL: undefined, link: undefined });
    yield* TestClock.adjust(Duration.minutes(11));
    const late = splitState(state);
    const expired = yield* verification.consume(late.identifier, late.secret).pipe(Effect.exit);
    assert.ok(Exit.isFailure(expired));
    assert.match(String(expired.cause), /TokenConsumed/);
  });

  When(
    "the browser is redirected to {string}",
    Effect.fn(function* (id: string) {
      const oauth = yield* oauthService();
      const { location, state } = yield* oauth.authorize(id, {
        callbackURL: undefined,
        link: undefined,
      });
      yield* setOutcome("location", location);
      yield* setOutcome("state", state);
    }),
  );

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

  // AH-007: the config Givens resolve through the `oauthConfig` parameter type (registered in the
  // feature's steps.test.ts), which accepts only the exact literals below — an unknown literal
  // fails to match rather than silently configuring a default.
  const configureLinking = (config: OAuthConfigChoice) =>
    configure({
      providers: config.providers.map((id) => (id === "google" ? google() : github())),
      linking: config.linking,
      httpRoutes: config.providers.includes("github")
        ? { ...googleRoutes, ...githubRoutes }
        : googleRoutes,
    });

  Given("{oauthConfig}", function* (config: OAuthConfigChoice) {
    yield* configureLinking(config);
  });

  Given('{oauthConfig} with no "trustedProviders" entry', function* (config: OAuthConfigChoice) {
    assert.strictEqual(
      config.linking,
      "explicit",
      "expected a config that names no trustedProviders",
    );
    yield* configureLinking(config);
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
      // Arranges only: the callback itself runs in the When.
      yield* configure({ providers: [google()], linking: "explicit", httpRoutes: googleRoutes });
      const users = yield* usersService();
      yield* users
        .create({ identity: { _tag: "Email", email: "alice@example.com" }, name: "Alice" })
        .pipe(Effect.orDie);
    }),
  );

  When(
    "the failure is returned",
    Effect.fn(function* () {
      const oauth = yield* oauthService();
      const { state } = yield* oauth.authorize("google", {
        callbackURL: undefined,
        link: undefined,
      });
      const failure = yield* oauth
        .callback("google", { code: "auth-code", state, iss: undefined, cookieState: state })
        .pipe(Effect.flip);
      // The Given's claim, checked where the callback actually runs.
      assert.strictEqual(failure._tag, "AccountExists");
    }),
  );

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
      // Explicit linking answers a matching-email callback with the typed `AccountExists` (the
      // REQ-EA-335 outcome for an empty `trustedProviders`), and links nothing.
      const outcome = (yield* getOutcome("autoLinkOutcome")) as Exit.Exit<unknown, unknown>;
      assert.ok(Exit.isFailure(outcome));
      assert.match(String(outcome.cause), /AccountExists/);
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
      // Each callback below answers with the next profile: distinct subjects, one shared email.
      const profiles = [
        { id: "sub-a", email, email_verified: true },
        { id: "sub-b", email, email_verified: true },
      ];
      let served = 0;
      yield* configure({
        providers: [google()],
        httpRoutes: {
          "google.example.com/token": { access_token: "at-1" },
          "google.example.com/userinfo": () => profiles[served++ % profiles.length],
        },
      });
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
    const oauth = yield* oauthService();
    const providerId = (yield* getOutcome("emailProvider")) as string;
    const signedIn: Array<Users.UserId | undefined> = [];
    for (const _ of [0, 1]) {
      const { state } = yield* oauth.authorize(providerId, {
        callbackURL: undefined,
        link: undefined,
      });
      const outcome = yield* oauth.callback(providerId, {
        code: "auth-code",
        state,
        iss: undefined,
        cookieState: state,
      });
      signedIn.push(outcome.session?.session.userId);
    }
    yield* setOutcome("emailCallbackUsers", signedIn);
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
    // And the callbacks themselves signed each subject into its own user, not into whichever
    // user the shared email would have selected.
    assert.deepStrictEqual(yield* getOutcome("emailCallbackUsers"), [
      expectedUserAId,
      expectedUserBId,
    ]);
  });

  // ---- REQ-EA-345: concurrent link attempts, arbitrated by the database ----

  When(
    "two concurrent requests race to link that same provider, subject, and issuer",
    function* () {
      const providerId = (yield* getOutcome("provider")) as string;
      const subject = (yield* getOutcome("subject")) as string;
      const issuer = (yield* getOutcome("issuer")) as string;
      const context = yield* Layer.build(SqliteIdentityStores);
      const accounts = Context.get(context, Accounts.Accounts);
      const users = Context.get(context, Users.Users);
      // The Given's precondition, re-checked against the SQL store this race runs on.
      assert.ok(
        Option.isNone(
          yield* accounts.findByProviderSubject(providerId, subject, issuer).pipe(Effect.orDie),
        ),
      );
      const first = yield* users
        .create({ identity: { _tag: "Email", email: "race-a@example.com" }, name: "A" })
        .pipe(Effect.orDie);
      const second = yield* users
        .create({ identity: { _tag: "Email", email: "race-b@example.com" }, name: "B" })
        .pipe(Effect.orDie);
      const attempt = (userId: Users.UserId) =>
        accounts.link({ userId, providerId, subject, issuer }).pipe(Effect.exit);
      const results = yield* Effect.all([attempt(first.id), attempt(second.id)], {
        concurrency: "unbounded",
      });
      const sql = Context.get(context, SqlClient.SqlClient);
      const rows = yield* sql<{ readonly n: number }>`
        SELECT count(*) AS n FROM accounts WHERE providerId = ${providerId} AND subject = ${subject}`.pipe(
        Effect.orDie,
      );
      yield* setOutcome("raceResults", results);
      yield* setOutcome("raceRowCount", rows[0]?.n);
    },
  );

  Then("only one link attempt succeeds", function* () {
    const results = (yield* getOutcome("raceResults")) as ReadonlyArray<
      Exit.Exit<unknown, unknown>
    >;
    assert.strictEqual(results.filter(Exit.isSuccess).length, 1);
    assert.strictEqual(yield* getOutcome("raceRowCount"), 1);
  });

  Then(
    "the other is rejected by the database-level constraint, not by application-level query discipline that could lose the race",
    function* () {
      const results = (yield* getOutcome("raceResults")) as ReadonlyArray<
        Exit.Exit<unknown, unknown>
      >;
      const failure = results.find(Exit.isFailure);
      assert.ok(failure !== undefined, "expected one attempt to be rejected");
      // `Accounts.layerSql` maps the UNIQUE violation itself to this tag; it does no lookup first.
      assert.match(String(failure.cause), /AccountAlreadyLinked/);
    },
  );

  // ---- REQ-EA-346: client secret via Config.Redacted ----
  //
  // ESS-009: this scenario was pruned after an "Encoding" schema failure. Root cause: the
  // failure was the step setup, not the product — the Scenario runtime's ambient ConfigProvider
  // is not `process.env`, so a `process.env[...] =` assignment was never seen and
  // `Config.Redacted` reported the *missing* variable as `Expected string` (the Redacted
  // schema's encoding issue, an unhelpful message for an absent key). The product path is
  // covered by packages/oauth/test/OAuthProviderConfig.test.ts; here the environment is an
  // explicit `ConfigProvider` layer, and the absent-variable counterpart proves the value
  // really comes from the environment rather than a default.

  const OKTA_SECRET_VARIABLE = "AUTH_OAUTH_OKTA_CLIENT_SECRET";

  Given(
    "a provider {string} configured with {string}",
    function* (_id: string, configExpr: string) {
      // The literal in the Gherkin text is the config the provider is built with below.
      assert.match(configExpr, /Config\.Redacted\("AUTH_OAUTH_OKTA_CLIENT_SECRET"\)/);
      yield* setOutcome("secretEnv", { [OKTA_SECRET_VARIABLE]: "real-secret-from-env" });
    },
  );

  When("{string}'s provider Layer is constructed", function* (id: string) {
    const provider = oauth2Provider(id, {
      clientSecret: Config.Redacted(OKTA_SECRET_VARIABLE),
    });
    const env = (yield* getOutcome("secretEnv")) as Record<string, string>;
    const withEnv = (variables: Record<string, string>) =>
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: variables }));
    const exit = yield* tryBuild({ providers: [provider] }).pipe(Effect.provide(withEnv(env)));
    const withoutVariable = yield* tryBuild({ providers: [provider] }).pipe(
      Effect.provide(withEnv({})),
    );
    yield* setOutcome("layerExit", exit);
    yield* setOutcome("layerExitWithoutVariable", withoutVariable);
  });

  Then(
    'the secret value is obtained from the environment via "Config.Redacted", inside that Layer',
    function* () {
      const exit = (yield* getOutcome("layerExit")) as Exit.Exit<unknown, unknown>;
      assert.ok(
        Exit.isSuccess(exit),
        "expected the provider Layer to build successfully from the env var",
      );
      // The same Layer with the variable absent must fail: the secret is read from the
      // environment, not defaulted or inlined.
      const absent = (yield* getOutcome("layerExitWithoutVariable")) as Exit.Exit<unknown, unknown>;
      assert.ok(Exit.isFailure(absent), "expected the Layer to fail when the variable is unset");
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
    // The registration died rather than adopting the fetched issuer, and the failure names the
    // mismatch between the two values.
    const exit = (yield* getOutcome("discoveryExit")) as Exit.Exit<unknown, unknown>;
    assert.ok(Exit.isFailure(exit));
    const message = String(exit.cause);
    assert.ok(message.includes("https://attacker.example.com/oauth2/default"), message);
    assert.ok(message.includes("https://okta.example.com/oauth2/default"), message);
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
      // Layer construction itself died (a configuration defect, not a typed request-level error),
      // so no `OAuth` service exists for any request to reach.
      const exit = (yield* getOutcome("bootExit")) as Exit.Exit<unknown, unknown>;
      assert.ok(Exit.isFailure(exit));
      assert.ok(exit.cause.reasons.some((reason) => reason._tag === "Die"));
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
    // The redirect that *was* chosen stays on the application's own origin.
    const outcome = (yield* getOutcome("phishOutcome")) as { readonly callbackURL: string };
    assert.strictEqual(
      new URL(outcome.callbackURL, "https://app.example.com").origin,
      "https://app.example.com",
    );
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
    // A request carrying hostile input (a callbackURL on another origin) yields the same redirect_uri.
    const oauth = yield* oauthService();
    const hostile = yield* oauth.authorize("google", {
      callbackURL: "https://attacker.example.com/steal",
      link: undefined,
    });
    assert.strictEqual(
      new URL(hostile.location).searchParams.get("redirect_uri"),
      "https://app.example.com/oauth/google/callback",
    );
  });
});
