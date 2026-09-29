// BEH-EA-238 through 245 (spec/behaviors/29-saml-sp.md), through the service: SP-initiated login, then the ACS
// chain against signed responses the fixtures' IdP produces — and against every way of getting one wrong. The
// invariant asserted throughout: every rejection is the SAME `SamlAssertionRejected`, and never a session.
import { AuthEvents, Users } from "@awthaq/core";
import { OrganizationRecords } from "@awthaq/organization";
import { RateLimiter } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Saml from "../src/Saml.ts";
import * as SamlConnections from "../src/SamlConnections.ts";
import {
  ACS_URL,
  ALGORITHM,
  attacker,
  cloneOf,
  edit,
  elementsNamed,
  first,
  idp,
  idpNext,
  NS,
  responseXml,
  signedResponse,
  SP_ENTITY_ID_PREFIX,
} from "./samlFixtures.ts";
import { atNow, idpResponse, SamlLive, seedConnection, startLogin, type Started } from "./support.ts";

const acs = (samlResponse: string, cookieState: string | undefined, ip?: string) =>
  Effect.flatMap(Saml.Saml, (saml) => saml.acs({ samlResponse, cookieState, ip }));

/** The failing tag of an ACS call that must fail. */
const rejectedAs = (samlResponse: string, cookieState: string | undefined) =>
  acs(samlResponse, cookieState).pipe(
    Effect.flip,
    Effect.map((failure) => failure._tag),
  );

const b64 = (xml: string) => Buffer.from(xml, "utf8").toString("base64");

describe("SP-initiated login", () => {
  it.effect("redirects to the IdP with an AuthnRequest naming this SP, and holds a request state", () =>
    Effect.gen(function* () {
      yield* atNow;
      const { connection } = yield* seedConnection();
      const started = yield* startLogin(connection.id, "/dashboard");
      const url = new URL(started.location);
      assert.strictEqual(`${url.origin}${url.pathname}`, "https://idp.example.com/sso");
      assert.include(started.authnRequest, `AssertionConsumerServiceURL="${ACS_URL}"`);
      assert.include(started.authnRequest, `<saml:Issuer>${SP_ENTITY_ID_PREFIX}${connection.id}</saml:Issuer>`);
      assert.include(started.authnRequest, `Destination="https://idp.example.com/sso"`);
      assert.match(started.requestId, /^_[0-9a-f-]{36}$/);
      // The cookie state is `<identifier>.<secret>`; the secret is not the request id.
      assert.notInclude(started.state, started.requestId);
      assert.match(started.state, /^saml-request:[0-9a-f-]+\.[^.]+$/);
    }).pipe(Effect.provide(SamlLive())),
  );

  it.effect("SP metadata names the entity id and the ACS, wants signed assertions, and refuses an unknown connection", () =>
    Effect.gen(function* () {
      yield* atNow;
      const saml = yield* Saml.Saml;
      const { connection } = yield* seedConnection();
      const xml = yield* saml.metadata(connection.id);
      assert.include(xml, `entityID="${SP_ENTITY_ID_PREFIX}${connection.id}"`);
      assert.include(xml, `Location="${ACS_URL}"`);
      assert.include(xml, 'WantAssertionsSigned="true"');
      assert.include(xml, 'AuthnRequestsSigned="false"');
      assert.strictEqual((yield* saml.metadata("nope").pipe(Effect.flip))._tag, "SamlConnectionNotFound");
    }).pipe(Effect.provide(SamlLive())),
  );

  it.effect("an untrusted callbackURL falls back to the default; a trusted origin is kept", () =>
    Effect.gen(function* () {
      yield* atNow;
      const saml = yield* Saml.Saml;
      const { connection } = yield* seedConnection();
      const landing = (callbackURL: string | undefined, assertionId: string) =>
        Effect.gen(function* () {
          const started = yield* startLogin(connection.id, callbackURL);
          const outcome = yield* saml.acs({
            samlResponse: idpResponse(started, connection.id, { assertionId }),
            cookieState: started.state,
          });
          return outcome.callbackURL;
        });
      assert.strictEqual(yield* landing("/settings", "_c1"), "/settings");
      assert.strictEqual(yield* landing("https://app.example.com/home", "_c2"), "https://app.example.com/home");
      assert.strictEqual(yield* landing("https://evil.example.com/phish", "_c3"), "/welcome");
      assert.strictEqual(yield* landing("//evil.example.com/phish", "_c4"), "/welcome");
      assert.strictEqual(yield* landing(undefined, "_c5"), "/welcome");
    }).pipe(
      Effect.provide(SamlLive({ trustedOrigins: ["https://app.example.com"], defaultCallbackURL: "/welcome" })),
    ),
  );
});

describe("a valid login", () => {
  it.effect("creates the user, issues a session as the organization's tenant, and lands on the callback", () =>
    Effect.gen(function* () {
      yield* atNow;
      const saml = yield* Saml.Saml;
      const users = yield* Users.Users;
      const { connection, organizationId } = yield* seedConnection();
      const started = yield* startLogin(connection.id, "/dashboard");
      const outcome = yield* saml.acs({
        samlResponse: idpResponse(started, connection.id),
        cookieState: started.state,
      });
      assert.strictEqual(outcome.callbackURL, "/dashboard");
      const session = outcome.session.session;
      // The tenant model: the session belongs to the connection's organization.
      assert.deepStrictEqual(session.tenantId, Option.some(organizationId));
      const user = Option.getOrThrow(yield* users.findByEmail("ada@acme.example"));
      assert.strictEqual(session.userId, user.id);
      assert.deepStrictEqual(session.amr, ["fed"]);
      assert.strictEqual(user.name, "ada@acme.example");
    }).pipe(Effect.provide(SamlLive())),
  );

  it.effect("the same person signing in again reuses the linked account (providerId saml:<org>:<connection>)", () =>
    Effect.gen(function* () {
      yield* atNow;
      const saml = yield* Saml.Saml;
      const { connection } = yield* seedConnection();
      const one = yield* startLogin(connection.id);
      const first_ = yield* saml.acs({ samlResponse: idpResponse(one, connection.id, { assertionId: "_a1" }), cookieState: one.state });
      const two = yield* startLogin(connection.id);
      const second = yield* saml.acs({ samlResponse: idpResponse(two, connection.id, { assertionId: "_a2" }), cookieState: two.state });
      assert.strictEqual(first_.session.session.userId, second.session.session.userId);
    }).pipe(Effect.provide(SamlLive())),
  );

  it.effect("a Response-signed document and a doubly-signed one work too", () =>
    Effect.gen(function* () {
      yield* atNow;
      const saml = yield* Saml.Saml;
      const { connection } = yield* seedConnection();
      for (const target of ["response", "both"] as const) {
        const started = yield* startLogin(connection.id);
        const outcome = yield* saml.acs({
          samlResponse: idpResponse(started, connection.id, { target, assertionId: `_a-${target}` }),
          cookieState: started.state,
        });
        assert.isDefined(outcome.session.token);
      }
    }).pipe(Effect.provide(SamlLive())),
  );

  it.effect("a key rotation: the next certificate trusted alongside the old, then the old retired", () =>
    Effect.gen(function* () {
      yield* atNow;
      const saml = yield* Saml.Saml;
      const store = yield* SamlConnections.SamlConnectionStore;
      const { connection } = yield* seedConnection({ certificates: [idp.cert, idpNext.cert] });
      const signIn = (who: typeof idp, assertionId: string) =>
        Effect.gen(function* () {
          const started = yield* startLogin(connection.id);
          return yield* saml.acs({
            samlResponse: idpResponse(started, connection.id, { who, assertionId }),
            cookieState: started.state,
          });
        });
      yield* signIn(idp, "_old-1");
      yield* signIn(idpNext, "_new-1");
      // Retire the old certificate: its signatures stop at once, the new one keeps working.
      yield* store.update(connection.id, { certificates: [idpNext.cert] });
      const started = yield* startLogin(connection.id);
      assert.strictEqual(
        yield* rejectedAs(idpResponse(started, connection.id, { who: idp, assertionId: "_old-2" }), started.state),
        "SamlAssertionRejected",
      );
      yield* signIn(idpNext, "_new-2");
    }).pipe(Effect.provide(SamlLive())),
  );
});

/** One way of getting a response wrong, and the login it is presented against. */
interface Attack {
  readonly name: string;
  readonly response: (started: Started, connectionId: string) => string;
  /** The state cookie to present instead of the real one. */
  readonly cookie?: (started: Started) => string;
}

const attacks: ReadonlyArray<Attack> = [
  {
    name: "BEH-EA-244: an unsigned response",
    response: (started, id) =>
      b64(responseXml({ inResponseTo: started.requestId, audience: `${SP_ENTITY_ID_PREFIX}${id}` })),
  },
  {
    name: "BEH-EA-240: a response signed by an unpinned key",
    response: (started, id) => idpResponse(started, id, { who: attacker }),
  },
  {
    name: "BEH-EA-240: a SHA-1 signature",
    response: (started, id) =>
      idpResponse(started, id, { signatureAlgorithm: ALGORITHM.rsaSha1, digestAlgorithm: ALGORITHM.sha1 }),
  },
  {
    name: "BEH-EA-241: an assertion from a different issuer",
    response: (started, id) => idpResponse(started, id, { issuer: "https://other-idp.example.com/metadata" }),
  },
  {
    name: "BEH-EA-242: an audience that is not this SP",
    response: (started, id) => idpResponse(started, id, { audience: "https://another-sp.example.com" }),
  },
  {
    name: "BEH-EA-242: a recipient that is not this ACS",
    response: (started, id) => idpResponse(started, id, { recipient: "https://evil.example.com/acs" }),
  },
  {
    name: "BEH-EA-242: a Destination that is not this ACS (unsigned Response, signed Assertion)",
    response: (started, id) => idpResponse(started, id, { destination: "https://evil.example.com/acs" }),
  },
  {
    name: "BEH-EA-243: an expired assertion",
    response: (started, id) =>
      idpResponse(started, id, { notBefore: "2026-09-29T10:00:00Z", notOnOrAfter: "2026-09-29T11:00:00Z" }),
  },
  {
    name: "BEH-EA-243: an assertion that is not valid yet",
    response: (started, id) =>
      idpResponse(started, id, { notBefore: "2026-09-29T13:00:00Z", notOnOrAfter: "2026-09-29T14:00:00Z" }),
  },
  {
    name: "BEH-EA-244: InResponseTo naming another request",
    response: (started, id) => idpResponse(started, id, { inResponseTo: "_someone-elses-request" }),
  },
  {
    name: "BEH-EA-244: a state cookie that is not the one issued (an unsolicited or injected response)",
    response: (started, id) => idpResponse(started, id),
    cookie: () => "saml-request:00000000-0000-0000-0000-000000000000.forged",
  },
  {
    name: "BEH-EA-238: a payload over the size cap",
    response: (started, id) => idpResponse(started, id, { attributes: { blob: ["x".repeat(300 * 1024)] } }),
  },
  {
    name: "BEH-EA-239: a DOCTYPE (XXE) around an otherwise valid response",
    response: (started, id) =>
      b64(
        `<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]>` +
          signedResponse(responseXml({ inResponseTo: started.requestId, audience: `${SP_ENTITY_ID_PREFIX}${id}` })),
      ),
  },
  { name: "BEH-EA-239: not base64 at all", response: () => "%%% not base64 %%%" },
];

describe("the chain refuses, uniformly", () => {
  for (const attack of attacks) {
    it.effect(attack.name, () =>
      Effect.gen(function* () {
        yield* atNow;
        const { connection } = yield* seedConnection();
        const started = yield* startLogin(connection.id);
        const tag = yield* rejectedAs(
          attack.response(started, connection.id),
          attack.cookie === undefined ? started.state : attack.cookie(started),
        );
        assert.strictEqual(tag, "SamlAssertionRejected");
        // Nothing came of it: no user was created.
        const users = yield* Users.Users;
        assert.isTrue(Option.isNone(yield* users.findByEmail("ada@acme.example")));
      }).pipe(Effect.provide(SamlLive())),
    );
  }

  it.effect("BEH-EA-244: an unsolicited response (no state cookie at all) is refused", () =>
    Effect.gen(function* () {
      yield* atNow;
      const { connection } = yield* seedConnection();
      const started = yield* startLogin(connection.id);
      assert.strictEqual(yield* rejectedAs(idpResponse(started, connection.id), undefined), "SamlAssertionRejected");
    }).pipe(Effect.provide(SamlLive())),
  );

  it.effect("BEH-EA-239/240: signature wrapping — a forged second assertion is refused, and nothing is created", () =>
    Effect.gen(function* () {
      yield* atNow;
      const { connection } = yield* seedConnection();
      const started = yield* startLogin(connection.id);
      const genuine = signedResponse(
        responseXml({
          inResponseTo: started.requestId,
          audience: `${SP_ENTITY_ID_PREFIX}${connection.id}`,
          nameId: "intern@acme.example",
        }),
      );
      const wrapped = edit(genuine, (document) => {
        const assertion = first(elementsNamed(document, NS.saml, "Assertion"), "Assertion");
        const forged = cloneOf(assertion);
        forged.setAttribute("ID", "_forged");
        first(Array.from(forged.getElementsByTagNameNS(NS.saml, "NameID")), "NameID").textContent = "ceo@acme.example";
        for (const signature of Array.from(forged.getElementsByTagNameNS(NS.ds, "Signature"))) {
          signature.parentNode?.removeChild(signature);
        }
        assertion.parentNode?.insertBefore(forged, assertion);
      });
      assert.strictEqual(yield* rejectedAs(b64(wrapped), started.state), "SamlAssertionRejected");
      const users = yield* Users.Users;
      assert.isTrue(Option.isNone(yield* users.findByEmail("ceo@acme.example")));
      assert.isTrue(Option.isNone(yield* users.findByEmail("intern@acme.example")));
    }).pipe(Effect.provide(SamlLive())),
  );

  it.effect("BEH-EA-244: the request is single-use — replaying a valid response fails; a wrong secret does not burn the real request", () =>
    Effect.gen(function* () {
      yield* atNow;
      const saml = yield* Saml.Saml;
      const { connection } = yield* seedConnection();
      const started = yield* startLogin(connection.id);
      const response = idpResponse(started, connection.id);
      yield* saml.acs({ samlResponse: response, cookieState: started.state });
      assert.strictEqual(yield* rejectedAs(response, started.state), "SamlAssertionRejected");

      const second = yield* startLogin(connection.id);
      const [identifier] = second.state.split(".");
      assert.strictEqual(
        yield* rejectedAs(idpResponse(second, connection.id, { assertionId: "_x" }), `${identifier}.wrong-secret`),
        "SamlAssertionRejected",
      );
      // The real one still works: a guess at the secret never spends the request.
      yield* saml.acs({
        samlResponse: idpResponse(second, connection.id, { assertionId: "_y" }),
        cookieState: second.state,
      });
    }).pipe(Effect.provide(SamlLive())),
  );

  it.effect("BEH-EA-241: the trust set is the connection the request was started for; another IdP's key cannot sign in here", () =>
    Effect.gen(function* () {
      yield* atNow;
      const saml = yield* Saml.Saml;
      const { connection: acme } = yield* seedConnection({ slug: "acme", certificates: [idp.cert] });
      const { connection: other } = yield* seedConnection({
        slug: "other",
        certificates: [idpNext.cert],
        emailDomains: ["other.example"],
      });
      // A login for `other`, answered by `acme`'s IdP (whose key `other` does not trust).
      const started = yield* startLogin(other.id);
      assert.strictEqual(
        yield* rejectedAs(idpResponse(started, other.id, { who: idp }), started.state),
        "SamlAssertionRejected",
      );
      // The right pair works.
      const good = yield* startLogin(acme.id);
      yield* saml.acs({ samlResponse: idpResponse(good, acme.id, { who: idp }), cookieState: good.state });
    }).pipe(Effect.provide(SamlLive())),
  );

  it.effect("a replayed assertion id is refused even under a fresh request id (one-time assertion ids)", () =>
    Effect.gen(function* () {
      yield* atNow;
      const saml = yield* Saml.Saml;
      const { connection } = yield* seedConnection();
      const one = yield* startLogin(connection.id);
      yield* saml.acs({
        samlResponse: idpResponse(one, connection.id, { assertionId: "_same-assertion" }),
        cookieState: one.state,
      });
      const two = yield* startLogin(connection.id);
      assert.strictEqual(
        yield* rejectedAs(idpResponse(two, connection.id, { assertionId: "_same-assertion" }), two.state),
        "SamlAssertionRejected",
      );
    }).pipe(Effect.provide(SamlLive())),
  );

  it.effect("clock skew is bounded: 30 s past NotOnOrAfter passes at the default 60 s, 2 minutes does not", () =>
    Effect.gen(function* () {
      yield* atNow;
      const saml = yield* Saml.Saml;
      const { connection } = yield* seedConnection();
      const within = yield* startLogin(connection.id);
      yield* saml.acs({
        samlResponse: idpResponse(within, connection.id, {
          notBefore: "2026-09-29T11:50:00Z",
          notOnOrAfter: "2026-09-29T11:59:30Z",
          assertionId: "_skew-ok",
        }),
        cookieState: within.state,
      });
      const beyond = yield* startLogin(connection.id);
      assert.strictEqual(
        yield* rejectedAs(
          idpResponse(beyond, connection.id, {
            notBefore: "2026-09-29T11:50:00Z",
            notOnOrAfter: "2026-09-29T11:58:00Z",
            assertionId: "_skew-late",
          }),
          beyond.state,
        ),
        "SamlAssertionRejected",
      );
    }).pipe(Effect.provide(SamlLive())),
  );

  it.effect("a suspended organization's connection stops signing people in, and stops starting logins", () =>
    Effect.gen(function* () {
      yield* atNow;
      const saml = yield* Saml.Saml;
      const orgs = yield* OrganizationRecords.OrganizationRecords;
      const { connection, organizationId } = yield* seedConnection();
      const started = yield* startLogin(connection.id);
      yield* orgs.setSuspended(organizationId, Option.some(yield* DateTime.now));
      assert.strictEqual(
        yield* rejectedAs(idpResponse(started, connection.id), started.state),
        "SamlAssertionRejected",
      );
      assert.strictEqual((yield* saml.authnRequest(connection.id, {}).pipe(Effect.flip))._tag, "SamlConnectionNotFound");
      assert.strictEqual((yield* saml.metadata(connection.id).pipe(Effect.flip))._tag, "SamlConnectionNotFound");
    }).pipe(Effect.provide(SamlLive())),
  );

  it.effect("every rejection is audited as signInFailed(assertionInvalid) naming the strategy; the caller learns no reason", () =>
    Effect.gen(function* () {
      yield* atNow;
      const events = yield* AuthEvents.AuthEvents;
      const seen = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* events.stream.pipe(
        Stream.runForEach((event) =>
          event._tag === "auth.user.signInFailed"
            ? Ref.update(seen, (all) => [...all, `${event.strategy}|${event.reason}`])
            : Effect.void,
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      const { connection, organizationId } = yield* seedConnection();
      const started = yield* startLogin(connection.id);
      const failure = yield* acs(
        idpResponse(started, connection.id, { audience: "https://another-sp.example.com" }),
        started.state,
      ).pipe(Effect.flip);
      // No fields: the reason is not in the answer.
      assert.deepStrictEqual(Object.keys(failure).filter((key) => key !== "_tag"), []);
      yield* TestClock.adjust(Duration.millis(10));
      assert.deepStrictEqual(yield* Ref.get(seen), [`saml:${organizationId}:${connection.id}|assertionInvalid`]);
      // Before the connection is known (no state at all) the strategy is just `saml`.
      yield* acs("AAAA", undefined).pipe(Effect.flip);
      yield* TestClock.adjust(Duration.millis(10));
      assert.include(yield* Ref.get(seen), "saml|assertionInvalid");
    }).pipe(Effect.scoped, Effect.provide(SamlLive())),
  );
});

describe("account linking (BEH-EA-245)", () => {
  it.effect("an assertion never links to an existing account by email alone", () =>
    Effect.gen(function* () {
      yield* atNow;
      const users = yield* Users.Users;
      const { connection } = yield* seedConnection();
      const existing = yield* users.create({
        identity: { _tag: "Email", email: "ada@acme.example" },
        name: "Ada (password user)",
      });
      yield* users.verifyEmail(existing.id);
      const started = yield* startLogin(connection.id);
      assert.strictEqual(yield* rejectedAs(idpResponse(started, connection.id), started.state), "SamlAssertionRejected");
      // The existing account was neither taken over nor changed.
      assert.strictEqual(Option.getOrThrow(yield* users.findByEmail("ada@acme.example")).id, existing.id);
    }).pipe(Effect.provide(SamlLive())),
  );

  it.effect("a connection that trusts email links to a local account whose own address is verified — and only then", () =>
    Effect.gen(function* () {
      yield* atNow;
      const saml = yield* Saml.Saml;
      const users = yield* Users.Users;
      const { connection } = yield* seedConnection({ trustsEmail: true });
      const local = yield* users.create({ identity: { _tag: "Email", email: "ada@acme.example" }, name: "Ada" });
      // The local address is not verified yet: squatting is refused.
      const first_ = yield* startLogin(connection.id);
      assert.strictEqual(
        yield* rejectedAs(idpResponse(first_, connection.id, { assertionId: "_u1" }), first_.state),
        "SamlAssertionRejected",
      );
      yield* users.verifyEmail(local.id);
      const second = yield* startLogin(connection.id);
      const outcome = yield* saml.acs({
        samlResponse: idpResponse(second, connection.id, { assertionId: "_u2" }),
        cookieState: second.state,
      });
      assert.strictEqual(outcome.session.session.userId, local.id);
    }).pipe(Effect.provide(SamlLive())),
  );

  it.effect("a suspended user is refused after a valid assertion (the shared sign-in gate), with no session", () =>
    Effect.gen(function* () {
      yield* atNow;
      const saml = yield* Saml.Saml;
      const users = yield* Users.Users;
      const { connection } = yield* seedConnection();
      const started = yield* startLogin(connection.id);
      yield* saml.acs({
        samlResponse: idpResponse(started, connection.id, { assertionId: "_s1" }),
        cookieState: started.state,
      });
      const user = Option.getOrThrow(yield* users.findByEmail("ada@acme.example"));
      yield* users.setStatus(user.id, "suspended");
      const again = yield* startLogin(connection.id);
      const failure = yield* saml
        .acs({ samlResponse: idpResponse(again, connection.id, { assertionId: "_s2" }), cookieState: again.state })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "UserSuspended");
    }).pipe(Effect.provide(SamlLive())),
  );

  it.effect("tenantScoped: false leaves the session unstamped", () =>
    Effect.gen(function* () {
      yield* atNow;
      const saml = yield* Saml.Saml;
      const { connection } = yield* seedConnection();
      const started = yield* startLogin(connection.id);
      const outcome = yield* saml.acs({ samlResponse: idpResponse(started, connection.id), cookieState: started.state });
      assert.isTrue(Option.isNone(outcome.session.session.tenantId));
    }).pipe(Effect.provide(SamlLive({ tenantScoped: false }))),
  );
});

/**
 * The real limiter over a memory store whose sweeper wakes rarely: the tests jump the clock from the epoch to
 * 2026 (`atNow`), and a one-minute sweeper would run tens of millions of times to catch up.
 */
const MemoryLimiter = RateLimiter.layer.pipe(
  Layer.provide(RateLimiter.layerStoreMemoryWith({ maxBuckets: 1000, sweepInterval: Duration.days(3650) })),
);

describe("rate limits", () => {
  it.effect("login and ACS are limited per source address", () =>
    Effect.gen(function* () {
      yield* atNow;
      const saml = yield* Saml.Saml;
      const { connection } = yield* seedConnection();
      yield* saml.authnRequest(connection.id, { ip: "203.0.113.7" });
      yield* saml.authnRequest(connection.id, { ip: "203.0.113.7" });
      const limited = yield* saml.authnRequest(connection.id, { ip: "203.0.113.7" }).pipe(Effect.flip);
      assert.strictEqual(limited._tag, "RateLimited");
      yield* saml.authnRequest(connection.id, { ip: "203.0.113.8" });
      const tags: Array<string> = [];
      for (let i = 0; i < 3; i++) {
        tags.push((yield* acs("x", undefined, "198.51.100.1").pipe(Effect.flip))._tag);
      }
      assert.deepStrictEqual(tags, ["SamlAssertionRejected", "SamlAssertionRejected", "RateLimited"]);
    }).pipe(
      Effect.provide(
        SamlLive(
          { rateLimits: { login: { limit: 2, window: Duration.minutes(1) }, acs: { limit: 2, window: Duration.minutes(1) } } },
          MemoryLimiter,
        ),
      ),
    ),
  );
});
