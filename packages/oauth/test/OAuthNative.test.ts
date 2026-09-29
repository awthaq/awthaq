// spec/behaviors/16-oauth.md, BEH-EA-128 (callback allowlist) and the native
// return leg (MNA-003/MNA-004, wayfinder ticket 17): a native-mode flow ends at
// an allowlisted deep link carrying a one-time exchange code, redeemed once at
// `POST /oauth/token` for the session token. Domain-level, like `OAuth.test.ts`.
import { createHash } from "node:crypto";
import {
  AuditLog,
  Hooks,
  AuthEvents,
  Accounts,
  RateLimits,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import { ClientAddress, Encryption, KeyProvider, RateLimiter, SqlTransaction } from "@awthaq/ports";
import { Authentication } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as OAuth from "../src/OAuth.ts";
import * as OAuthProvider from "../src/OAuthProvider.ts";
import { fakeHttpClient } from "./FakeProvider.ts";

const EncryptionLive = Encryption.layer.pipe(
  Layer.provide(
    KeyProvider.layerEnv.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { AWTHAQ_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") },
          }),
        ),
      ),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);

const CoreLive = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  Sessions.layerMemory,
  Verification.layerMemory,
).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

const acme = OAuthProvider.oauth2({
  id: "acme",
  clientId: Config.succeed("acme-client-id"),
  clientSecret: Config.succeed(Redacted.make("acme-secret")),
  scopes: ["read"],
  endpoints: {
    authorizationEndpoint: "https://acme.example.com/authorize",
    tokenEndpoint: "https://acme.example.com/token",
    userinfoEndpoint: "https://acme.example.com/userinfo",
  },
  mapProfile: (claims) => ({
    subject: String(claims["id"]),
    ...(typeof claims["email"] === "string" ? { email: claims["email"] } : {}),
  }),
});

const NATIVE_REDIRECT = "myapp://oauth/callback";

const buildLayer = (config: Partial<OAuth.OAuthConfigInput> = {}) =>
  OAuth.OAuth.layer.pipe(
    Layer.provide(Authentication.OptionalAuthenticationLive),
    Layer.provide(Authentication.PrincipalResolverLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(RateLimiter.layerPermissive),
    Layer.provideMerge(RateLimits.layer),
    Layer.provideMerge(SqlTransaction.layerNoop),
    Layer.provideMerge(ClientAddress.layerDirect),
    Layer.provideMerge(EncryptionLive),
    Layer.provide(
      fakeHttpClient({
        "/token": { access_token: "at-1" },
        "/userinfo": { id: "native-user-1", email: "native@example.com" },
      }),
    ),
    Layer.provide(
      OAuth.config({
        providers: [acme],
        baseUrl: "https://app.example.com",
        retry: { base: Duration.zero },
        nativeRedirectURLs: [NATIVE_REDIRECT, "com.example.app:/cb"],
        ...config,
      }),
    ),
  );

/** Runs the flow up to the callback and returns what it redirected to. */
const runFlow = (native: { readonly codeChallenge?: string } | undefined, callbackURL?: string) =>
  Effect.gen(function* () {
    const oauth = yield* OAuth.OAuth;
    const { state } = yield* oauth.authorize("acme", {
      callbackURL,
      link: undefined,
      ...(native === undefined ? {} : { native }),
    });
    return yield* oauth.callback("acme", { code: "c1", state, iss: undefined, cookieState: state });
  });

const codeOf = (callbackURL: string): string => {
  const parsed = URL.parse(callbackURL, "https://app.example.com");
  const code = parsed?.searchParams.get("code");
  if (code === null || code === undefined) throw new Error(`no exchange code in ${callbackURL}`);
  return code;
};

const s256 = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

describe("native callbackURL allowlist (MNA-004, BEH-EA-128)", () => {
  it.effect("a native-mode flow honours an allowlisted myapp:// callbackURL", () =>
    Effect.gen(function* () {
      const outcome = yield* runFlow({}, NATIVE_REDIRECT);
      assert.match(outcome.callbackURL, /^myapp:\/\/oauth\/callback\?code=/);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("an RFC 8252 single-slash private-use URI works too", () =>
    Effect.gen(function* () {
      const outcome = yield* runFlow({}, "com.example.app:/cb");
      assert.match(outcome.callbackURL, /^com\.example\.app:\/cb\?code=/);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("the allowlist matches on a path boundary, never a bare string prefix", () =>
    Effect.gen(function* () {
      const deeper = yield* runFlow({}, "myapp://oauth/callback/deeper?x=1");
      assert.match(deeper.callbackURL, /^myapp:\/\/oauth\/callback\/deeper\?x=1&code=/);
      const lookalike = yield* runFlow({}, "myapp://oauth/callbackevil");
      assert.strictEqual(lookalike.callbackURL.includes("myapp:"), false);
      const otherHost = yield* runFlow({}, "myapp://evil/callback");
      assert.strictEqual(otherHost.callbackURL.includes("myapp:"), false);
      const traversal = yield* runFlow({}, "myapp://oauth/callback/../evil");
      assert.strictEqual(traversal.callbackURL.includes("evil"), false);
      const userinfo = yield* runFlow({}, "myapp://attacker@oauth/callback");
      assert.strictEqual(userinfo.callbackURL.includes("attacker"), false);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect(
    "javascript: and other unlisted schemes fall back to the default, even in native mode",
    () =>
      Effect.gen(function* () {
        const js = yield* runFlow({}, "javascript:alert(1)");
        assert.strictEqual(js.callbackURL.startsWith("javascript"), false);
        const other = yield* runFlow({}, "otherapp://oauth/callback");
        assert.strictEqual(other.callbackURL.startsWith("otherapp"), false);
      }).pipe(Effect.provide(buildLayer())),
  );

  it.effect(
    "a custom scheme in browser mode falls back: a Set-Cookie on a 302 to myapp:// is useless",
    () =>
      Effect.gen(function* () {
        const outcome = yield* runFlow(undefined, NATIVE_REDIRECT);
        assert.strictEqual(outcome.callbackURL, "/");
        assert.isDefined(outcome.session);
      }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("a discarded callbackURL logs exactly one warning naming the reason", () =>
    Effect.gen(function* () {
      const warnings: Array<string> = [];
      const capture = Logger.make((entry) => {
        // `RateLimiter.layerPermissive` warns once on its first rule; that is not what is counted here.
        const line = JSON.stringify(entry.message);
        if (entry.logLevel === "Warn" && line.includes("callbackURL discarded"))
          warnings.push(line);
      });
      yield* Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        yield* oauth.authorize("acme", {
          callbackURL: "otherapp://x/y",
          link: undefined,
          native: {},
        });
      }).pipe(Effect.provide(Logger.layer([capture])));
      assert.strictEqual(warnings.length, 1);
      assert.match(warnings[0] ?? "", /callbackURL discarded: untrusted-native-scheme/);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("an https/javascript entry in nativeRedirectURLs fails at boot", () =>
    Effect.gen(function* () {
      for (const bad of ["https://evil.example.com/cb", "javascript:alert(1)", "not a url"]) {
        const exit = yield* Effect.void.pipe(
          Effect.provide(buildLayer({ nativeRedirectURLs: [bad] })),
          Effect.exit,
        );
        assert.isTrue(Exit.isFailure(exit), bad);
      }
    }),
  );
});

describe("native exchange code (MNA-003, wayfinder ticket 17)", () => {
  it.effect("the callback sets no session and never puts the token in the URL", () =>
    Effect.gen(function* () {
      const outcome = yield* runFlow({}, NATIVE_REDIRECT);
      assert.isUndefined(outcome.session);
      const code = codeOf(outcome.callbackURL);
      assert.isTrue(code.startsWith("oauth.exchange:"));
      // Redeeming yields the real token; nothing of it appears in the redirect.
      const oauth = yield* OAuth.OAuth;
      const redeemed = yield* oauth.exchange({ code });
      assert.isString(redeemed.token);
      assert.strictEqual(outcome.callbackURL.includes(redeemed.token ?? ""), false);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("POST /oauth/token redeems the code once for a working bearer token", () =>
    Effect.gen(function* () {
      const outcome = yield* runFlow({}, NATIVE_REDIRECT);
      const oauth = yield* OAuth.OAuth;
      const redeemed = yield* oauth.exchange({ code: codeOf(outcome.callbackURL) });
      assert.isTrue(redeemed.current);
      const sessions = yield* Sessions.Sessions;
      const verified = yield* sessions.verify(Redacted.make(redeemed.token ?? ""));
      assert.strictEqual(verified.session.id, redeemed.id);
      assert.deepStrictEqual(verified.session.amr, ["fed"]);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("a second redemption of the same code fails", () =>
    Effect.gen(function* () {
      const outcome = yield* runFlow({}, NATIVE_REDIRECT);
      const oauth = yield* OAuth.OAuth;
      const code = codeOf(outcome.callbackURL);
      yield* oauth.exchange({ code });
      const second = yield* Effect.flip(oauth.exchange({ code }));
      assert.strictEqual(second._tag, "OAuthCallbackFailed");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("a code older than the exchange TTL fails", () =>
    Effect.gen(function* () {
      const outcome = yield* runFlow({}, NATIVE_REDIRECT);
      const oauth = yield* OAuth.OAuth;
      yield* TestClock.adjust(Duration.seconds(61));
      const late = yield* Effect.flip(oauth.exchange({ code: codeOf(outcome.callbackURL) }));
      assert.strictEqual(late._tag, "OAuthCallbackFailed");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect(
    "an OAuth flow's own state cannot be redeemed as an exchange code (and is not burned)",
    () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { state } = yield* oauth.authorize("acme", {
          callbackURL: undefined,
          link: undefined,
        });
        const failed = yield* Effect.flip(oauth.exchange({ code: state }));
        assert.strictEqual(failed._tag, "OAuthCallbackFailed");
        // The flow entry is untouched: the genuine callback still completes.
        const outcome = yield* oauth.callback("acme", {
          code: "c1",
          state,
          iss: undefined,
          cookieState: state,
        });
        assert.isDefined(outcome.session);
      }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("garbage codes fail uniformly", () =>
    Effect.gen(function* () {
      const oauth = yield* OAuth.OAuth;
      for (const code of ["", "nonsense", "oauth.exchange:missing.secret"]) {
        const failed = yield* Effect.flip(oauth.exchange({ code }));
        assert.strictEqual(failed._tag, "OAuthCallbackFailed");
      }
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("a code bound to a challenge needs the matching verifier", () =>
    Effect.gen(function* () {
      const verifier = "a-long-random-app-held-secret";
      const oauth = yield* OAuth.OAuth;
      const bound = () =>
        runFlow({ codeChallenge: s256(verifier) }, NATIVE_REDIRECT).pipe(
          Effect.map((outcome) => codeOf(outcome.callbackURL)),
        );
      const missing = yield* Effect.flip(oauth.exchange({ code: yield* bound() }));
      assert.strictEqual(missing._tag, "OAuthCallbackFailed");
      const wrong = yield* Effect.flip(
        oauth.exchange({ code: yield* bound(), codeVerifier: "not-the-secret" }),
      );
      assert.strictEqual(wrong._tag, "OAuthCallbackFailed");
      const ok = yield* oauth.exchange({ code: yield* bound(), codeVerifier: verifier });
      assert.isString(ok.token);
      // A wrong guess spends the code: the right verifier afterwards is too late.
      const spent = yield* bound();
      yield* Effect.flip(oauth.exchange({ code: spent, codeVerifier: "wrong" }));
      const retry = yield* Effect.flip(oauth.exchange({ code: spent, codeVerifier: verifier }));
      assert.strictEqual(retry._tag, "OAuthCallbackFailed");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("browser mode is unchanged: a session comes back, no exchange code", () =>
    Effect.gen(function* () {
      const outcome = yield* runFlow(undefined, "/dashboard");
      assert.isDefined(outcome.session);
      assert.strictEqual(outcome.callbackURL, "/dashboard");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("the exchange record does not persist the session token in the clear", () =>
    Effect.gen(function* () {
      const outcome = yield* runFlow({}, NATIVE_REDIRECT);
      const code = codeOf(outcome.callbackURL);
      // Consumed as a raw `Verification` value (not redeemed) to see what is stored.
      const verification = yield* Verification.Verification;
      const separator = code.lastIndexOf(".");
      const consumed = yield* verification.consume(
        code.slice(0, separator),
        Redacted.make(code.slice(separator + 1)),
      );
      const sealed = Reflect.get(Object(consumed.payload), "token");
      const sessionId = Reflect.get(Object(Reflect.get(Object(consumed.payload), "session")), "id");
      assert.isString(sealed);
      assert.isString(sessionId);
      // A live token is `<session id>.<secret>`; the stored value is an Encryption envelope.
      assert.isFalse(String(sealed).startsWith(`${sessionId}.`));
    }).pipe(Effect.provide(buildLayer())),
  );
});
