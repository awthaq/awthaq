// The steps of 29-saml-sp.feature's BEH-EA-314 through BEH-EA-318 rules: signed AuthnRequests, Single Logout in both directions,
// role mapping under a ceiling, the `Sso` dispatcher and the administrator's fail-closed, tenant-scoped connection management.
// They share the World of `SamlSteps.ts` (the real in-memory core, the organization plugin, the SAML records and stores, the Node
// XML-signature adapter, sealed SP keys over a real `Encryption`) and play the IdP's side of each protocol message themselves.
import { Api } from "@awthaq/api";
import { AuditLog, Sessions, Tenant, Users } from "@awthaq/core";
import { MembershipRecords, Organization, OrganizationConnections } from "@awthaq/organization";
import { Encryption } from "@awthaq/ports";
import {
  Saml,
  SamlConnections,
  SamlKeys,
  SamlProtocol,
  SamlRecords,
  SamlSlo,
  SamlSpKeys,
  Sso,
} from "@awthaq/saml";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { ALGORITHM, attacker, idp, idpNext, NOW_MILLIS, NS } from "./SamlFixtures.ts";
import {
  BASE_URL,
  configure,
  ensureConnection,
  inApp,
  inAppExit,
  patchSpec,
  planConnection,
  postAcs,
  idpResponse,
  startLogin,
  World,
} from "./SamlWorld.ts";
import { isNumber, isString } from "./shared/Outcomes.ts";

const IDP_SLO = "https://idp.example.com/slo";
const NOW = DateTime.makeUnsafe(NOW_MILLIS);
const iso = (instant: DateTime.Utc) => DateTime.formatIso(instant).replace(/\.\d+Z$/, "Z");
const sloUrlOf = (connectionId: string) => `${BASE_URL}/auth/saml/slo/${connectionId}`;

const ownerPrincipal = new Api.UserPrincipal({
  ref: new Api.PrincipalRef({ type: "user", id: "owner-1" }),
  sessionId: "owner-session",
});
const adminPrincipal = new Api.UserPrincipal({
  ref: new Api.PrincipalRef({ type: "user", id: "admin-1" }),
  sessionId: "admin-session",
});

// ---- IdP-side messages --------------------------------------------------------------------------

interface LogoutRequestOptions {
  readonly id: string;
  readonly issuer: string;
  readonly destination: string;
  readonly nameId: string;
  readonly sessionIndexes?: ReadonlyArray<string>;
  readonly issueInstant?: DateTime.Utc;
  readonly notOnOrAfter?: DateTime.Utc;
}

const logoutRequestXml = (options: LogoutRequestOptions): string =>
  `<samlp:LogoutRequest xmlns:samlp="${NS.samlp}" xmlns:saml="${NS.saml}" ID="${options.id}" Version="2.0" ` +
  `IssueInstant="${iso(options.issueInstant ?? NOW)}" Destination="${options.destination}"` +
  (options.notOnOrAfter === undefined ? "" : ` NotOnOrAfter="${iso(options.notOnOrAfter)}"`) +
  `><saml:Issuer>${options.issuer}</saml:Issuer>` +
  `<saml:NameID>${options.nameId}</saml:NameID>` +
  (options.sessionIndexes ?? [])
    .map((index) => `<samlp:SessionIndex>${index}</samlp:SessionIndex>`)
    .join("") +
  `</samlp:LogoutRequest>`;

const logoutResponseXml = (options: {
  readonly id: string;
  readonly issuer: string;
  readonly destination: string;
  readonly inResponseTo: string;
}): string =>
  `<samlp:LogoutResponse xmlns:samlp="${NS.samlp}" xmlns:saml="${NS.saml}" ID="${options.id}" Version="2.0" ` +
  `IssueInstant="${iso(NOW)}" Destination="${options.destination}" InResponseTo="${options.inResponseTo}">` +
  `<saml:Issuer>${options.issuer}</saml:Issuer>` +
  `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status></samlp:LogoutResponse>`;

type Flaw =
  | "is unsigned"
  | "is signed by another key"
  | "was tampered with after signing"
  | "claims the SHA-1 signature algorithm"
  | "loses its RelayState after signing"
  | "is wrapped with a second, unsigned request"
  | "carries a DOCTYPE";

const KNOWN_FLAWS: ReadonlyArray<string> = [
  "is unsigned",
  "is signed by another key",
  "was tampered with after signing",
  "claims the SHA-1 signature algorithm",
  "loses its RelayState after signing",
  "is wrapped with a second, unsigned request",
  "carries a DOCTYPE",
];
const isFlaw = (value: string): value is Flaw => KNOWN_FLAWS.includes(value);

const redirectInput = (
  connectionId: string,
  kind: "SAMLRequest" | "SAMLResponse",
  xml: string,
  options: {
    readonly signer?: typeof idp;
    readonly unsigned?: boolean;
    readonly relayState?: string;
    readonly cookieState?: string;
  } = {},
): SamlSlo.SloInput => {
  const message = SamlProtocol.deflateBase64(xml);
  const query =
    options.unsigned === true
      ? SamlKeys.plainRedirect({ kind, message, relayState: options.relayState })
      : SamlKeys.signRedirect({
          kind,
          message,
          relayState: options.relayState,
          privateKeyPem: (options.signer ?? idp).key,
        });
  const raw =
    query
      .split("&")
      .find((pair) => pair.startsWith(`${kind}=`))
      ?.slice(kind.length + 1) ?? "";
  return {
    connectionId,
    binding: "redirect",
    rawQuery: query,
    samlRequest: kind === "SAMLRequest" ? decodeURIComponent(raw) : undefined,
    samlResponse: kind === "SAMLResponse" ? decodeURIComponent(raw) : undefined,
    relayState: options.relayState,
    cookieState: options.cookieState,
    ip: undefined,
  };
};

const postInput = (
  connectionId: string,
  kind: "SAMLRequest" | "SAMLResponse",
  xml: string,
  referenceId: string,
  options: {
    readonly signer?: typeof idp;
    readonly unsigned?: boolean;
    readonly raw?: (signed: string) => string;
    readonly cookieState?: string;
  } = {},
): SamlSlo.SloInput => {
  const signed =
    options.unsigned === true
      ? xml
      : SamlKeys.signXml({ xml, referenceId, privateKeyPem: (options.signer ?? idp).key });
  const encoded = Buffer.from(
    options.raw === undefined ? signed : options.raw(signed),
    "utf8",
  ).toString("base64");
  return {
    connectionId,
    binding: "post",
    rawQuery: undefined,
    samlRequest: kind === "SAMLRequest" ? encoded : undefined,
    samlResponse: kind === "SAMLResponse" ? encoded : undefined,
    relayState: undefined,
    cookieState: options.cookieState,
    ip: undefined,
  };
};

const certificatesIn = (metadata: string): ReadonlyArray<string> =>
  [...metadata.matchAll(/<ds:X509Certificate>([^<]+)<\/ds:X509Certificate>/g)].map(
    (match) => `-----BEGIN CERTIFICATE-----\n${match[1] ?? ""}\n-----END CERTIFICATE-----\n`,
  );

const trustFrom = (pems: ReadonlyArray<string>) => ({
  certificates: pems.map((pem) => {
    const certificate = new X509Certificate(pem);
    return {
      fingerprint: certificate.fingerprint256.replaceAll(":", "").toLowerCase(),
      pem,
      notBefore: DateTime.makeUnsafe(certificate.validFromDate),
      notAfter: DateTime.makeUnsafe(certificate.validToDate),
    };
  }),
});

const redirectParts = (location: string) => {
  const raw = location.slice(location.indexOf("?") + 1);
  const rawOf = (name: string) =>
    raw
      .split("&")
      .find((pair) => pair.startsWith(`${name}=`))
      ?.slice(name.length + 1);
  const kind = rawOf("SAMLRequest") === undefined ? "SAMLResponse" : "SAMLRequest";
  const message = rawOf(kind) ?? "";
  const relay = rawOf("RelayState");
  const sigAlg = rawOf("SigAlg");
  const signature = rawOf("Signature");
  return {
    kind,
    message,
    sigAlg: sigAlg === undefined ? undefined : decodeURIComponent(sigAlg),
    signature: signature === undefined ? undefined : decodeURIComponent(signature),
    octets:
      sigAlg === undefined
        ? undefined
        : `${kind}=${message}${relay === undefined ? "" : `&RelayState=${relay}`}&SigAlg=${sigAlg}`,
  };
};

const verifiesUnder = (location: string, pems: ReadonlyArray<string>) => {
  const parts = redirectParts(location);
  return (
    parts.octets !== undefined &&
    parts.signature !== undefined &&
    parts.sigAlg !== undefined &&
    SamlKeys.verifyRedirect({
      octets: parts.octets,
      signature: parts.signature,
      sigAlg: parts.sigAlg,
      trust: trustFrom(pems),
      now: NOW,
    })
  );
};

// ---- the scenario's own state -------------------------------------------------------------------

const currentLocation = Effect.gen(function* () {
  const world = yield* World;
  const login = world.logins.get("current");
  assert.ok(login !== undefined, "a login was started");
  return login.location;
});

const connectionState = (name: string) => ensureConnection(name);

const spMetadata = (name: string) =>
  Effect.gen(function* () {
    const connection = yield* connectionState(name);
    return yield* inApp(
      Effect.flatMap(Saml.Saml, (saml) => saml.metadata(connection.id).pipe(Effect.orDie)),
    );
  });

/** Per-scenario bookkeeping that is not an "outcome" a Then reads back (a missing outcome is a defect, and these may be absent). */
interface Book {
  readonly sessions: Map<string, ReadonlyArray<string>>;
  readonly organizations: Map<string, string>;
}
const books = new WeakMap<object, Book>();
const bookOf = (world: World["Service"]): Book => {
  const existing = books.get(world.connections);
  if (existing !== undefined) return existing;
  const fresh: Book = { sessions: new Map(), organizations: new Map() };
  books.set(world.connections, fresh);
  return fresh;
};

/** A user signs in through `connectionName` (the IdP's answer to a fresh login), optionally carrying groups; remembers the session. */
const signInUser = Effect.fn("features.saml.signInUser")(function* (
  user: string,
  connectionName: string,
  options: { readonly groups?: ReadonlyArray<string>; readonly sessionIndex?: string } = {},
) {
  const world = yield* World;
  const login = yield* startLogin(connectionName, "current");
  yield* patchSpec((spec) => ({
    ...spec,
    response: {
      ...spec.response,
      nameId: user,
      attributes: {
        email: [`${user}@${connectionName}.example`],
        ...(options.groups === undefined ? {} : { groups: [...options.groups] }),
      },
    },
  }));
  const payload = yield* idpResponse(login, yield* Ref.get(world.spec));
  const outcome = yield* postAcs(payload, login.state);
  if (outcome._tag !== "accepted") return outcome;
  world.users.set(user, outcome.userId);
  const found = yield* inApp(
    Effect.gen(function* () {
      const sessions = yield* Sessions.Sessions;
      const rows = yield* sessions.list(Users.UserId(outcome.userId)).pipe(Effect.orDie);
      return rows.map((row) => row.id);
    }),
  );
  const book = bookOf(world);
  const known = book.sessions.get(user) ?? [];
  const fresh = found.filter((id) => !known.includes(id));
  book.sessions.set(user, [...known, ...fresh]);
  if (options.sessionIndex !== undefined) {
    const connection = yield* connectionState(connectionName);
    for (const id of fresh) {
      yield* inApp(
        Effect.flatMap(SamlRecords.SamlRecords, (records) =>
          records.saveSession({
            sessionId: id,
            connectionId: connection.id,
            nameId: user,
            sessionIndex: options.sessionIndex,
          }),
        ),
      );
    }
  }
  return outcome;
});

const sessionIdsOf = (user: string) =>
  Effect.gen(function* () {
    const world = yield* World;
    return bookOf(world).sessions.get(user) ?? [];
  });

const isLive = (user: string, sessionId: string) =>
  Effect.gen(function* () {
    const world = yield* World;
    const userId = world.users.get(user);
    assert.ok(userId !== undefined, `"${user}" has signed in`);
    return yield* inApp(
      Effect.flatMap(Sessions.Sessions, (sessions) =>
        sessions.isLive(Users.UserId(userId), Sessions.SessionId(sessionId)).pipe(Effect.orDie),
      ),
    );
  });

const revocationsOf = inApp(
  Effect.flatMap(AuditLog.AuditLog, (log) => log.list({ eventTag: "auth.session.revoked" })).pipe(
    Effect.map((rows) =>
      rows.flatMap((row) =>
        row.payload._tag === "auth.session.revoked"
          ? [
              {
                reason: row.payload.reason,
                sessionId: row.payload.sessionId,
                tenantId: row.tenantId,
              },
            ]
          : [],
      ),
    ),
    Effect.orDie,
  ),
);

/** What `Saml.slo` did, recorded for the Then steps. */
type SloResult =
  | { readonly _tag: "outcome"; readonly outcome: SamlSlo.SloOutcome }
  | { readonly _tag: "failed"; readonly tag: string };

const isSloResult = (value: unknown): value is SloResult =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  (value._tag === "outcome" || value._tag === "failed");

const deliver = (input: SamlSlo.SloInput) =>
  Effect.gen(function* () {
    const world = yield* World;
    const exit = yield* inAppExit(Effect.flatMap(Saml.Saml, (saml) => saml.slo(input)));
    const result: SloResult = Exit.isSuccess(exit)
      ? { _tag: "outcome", outcome: exit.value }
      : {
          _tag: "failed",
          tag: Option.match(Exit.findErrorOption(exit), {
            onNone: () => "defect",
            onSome: (error) =>
              typeof error === "object" &&
              error !== null &&
              "_tag" in error &&
              typeof error._tag === "string"
                ? error._tag
                : "unknown",
          }),
        };
    yield* world.outcomes.set("slo", result);
    return result;
  });

const lastSlo = Effect.gen(function* () {
  const world = yield* World;
  return yield* world.outcomes.getAs("slo", isSloResult);
});

const REQUEST_ID = "_idp-logout-1";

const logoutFor = (
  user: string,
  connectionId: string,
  entityId: string,
  overrides: Partial<LogoutRequestOptions> = {},
) =>
  logoutRequestXml({
    id: REQUEST_ID,
    issuer: entityId,
    destination: sloUrlOf(connectionId),
    nameId: user,
    ...overrides,
  });

export const samlFederationSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-314: signed AuthnRequests -------------------------------------------------------

  Given("the connection {string} signs its AuthnRequests", function* (name: string) {
    yield* planConnection(name, { authnRequestsSigned: true });
  });
  Given("the connection {string} has an IdP logout endpoint", function* (name: string) {
    yield* planConnection(name, { sloUrl: IDP_SLO });
  });
  Given(
    "the connection {string} signs its AuthnRequests and has an IdP logout endpoint",
    function* (name: string) {
      yield* planConnection(name, { authnRequestsSigned: true, sloUrl: IDP_SLO });
    },
  );
  When("the browser starts a login on {string}", function* (name: string) {
    yield* startLogin(name, "current");
  });
  Then("the redirect to the IdP carries an RSA-SHA256 query signature", function* () {
    const parts = redirectParts(yield* currentLocation);
    assert.equal(parts.sigAlg, ALGORITHM.rsaSha256);
    assert.ok(parts.signature !== undefined && parts.signature !== "");
  });
  Then("the redirect to the IdP carries no signature", function* () {
    const parts = redirectParts(yield* currentLocation);
    assert.equal(parts.sigAlg, undefined);
    assert.equal(parts.signature, undefined);
  });
  Then(
    "that signature verifies under the certificate published in the metadata of {string}",
    function* (name: string) {
      const published = certificatesIn(yield* spMetadata(name));
      assert.equal(published.length, 1);
      assert.ok(verifiesUnder(yield* currentLocation, published));
    },
  );
  Then("that signature no longer verifies once the request is altered", function* () {
    const location = yield* currentLocation;
    const name =
      (yield* Effect.flatMap(World, (world) =>
        Effect.succeed(world.logins.get("current")?.connectionName),
      )) ?? "acme";
    const published = certificatesIn(yield* spMetadata(name));
    const parts = redirectParts(location);
    const altered = location.replace(parts.message.slice(0, 8), "AAAAAAAA");
    assert.equal(verifiesUnder(altered, published), false);
  });
  Then("that signature does not verify under the IdP's own certificate", function* () {
    assert.equal(verifiesUnder(yield* currentLocation, [idp.cert]), false);
    assert.equal(verifiesUnder(yield* currentLocation, [attacker.cert]), false);
  });
  Then(
    "the metadata of {string} declares AuthnRequestsSigned false and publishes no certificate",
    function* (name: string) {
      const metadata = yield* spMetadata(name);
      assert.ok(metadata.includes('AuthnRequestsSigned="false"'));
      assert.deepEqual(certificatesIn(metadata), []);
    },
  );
  Then(
    "the stored signing key of {string} is a sealed envelope holding no private key material",
    function* (name: string) {
      const connection = yield* connectionState(name);
      const rows = yield* inApp(
        Effect.flatMap(SamlRecords.SamlRecords, (records) => records.listSpKeys(connection.id)),
      );
      assert.equal(rows.length, 1);
      assert.ok(!rows[0]?.privateKey.includes("PRIVATE KEY"));
      assert.ok(Encryption.looksLikeEnvelope(rows[0]?.privateKey ?? ""));
    },
  );
  Then("it opens only under its own key id", function* () {
    const connection = yield* connectionState("acme");
    const opened = yield* inApp(
      Effect.gen(function* () {
        const records = yield* SamlRecords.SamlRecords;
        const encryption = yield* Encryption.Encryption;
        const [row] = yield* records.listSpKeys(connection.id);
        assert.ok(row !== undefined);
        const own = yield* encryption
          .decrypt(row.privateKey, SamlSpKeys.aad(row.id))
          .pipe(Effect.option);
        const other = yield* encryption
          .decrypt(row.privateKey, SamlSpKeys.aad("another-key"))
          .pipe(Effect.option);
        return {
          own: Option.map(own, (value) => Redacted.value(value.plaintext)),
          other: Option.isSome(other),
        };
      }),
    );
    assert.ok(Option.isSome(opened.own) && opened.own.value.includes("BEGIN PRIVATE KEY"));
    assert.equal(opened.other, false);
  });
  When("the administrator rotates the SP signing key of {string}", function* (name: string) {
    const connection = yield* connectionState(name);
    // A later instant: "the newest key" is by creation time, and two keys made in one millisecond have no order.
    yield* inApp(TestClock.adjust("5 seconds"));
    yield* inApp(
      Effect.flatMap(SamlSpKeys.SamlSpKeys, (keys) =>
        keys.generate(connection.id).pipe(Effect.orDie),
      ),
    );
  });
  Then(
    "the metadata of {string} publishes {int} certificates",
    function* (name: string, count: number) {
      assert.equal(certificatesIn(yield* spMetadata(name)).length, count);
    },
  );
  Then("a new login on {string} is signed by the newest key only", function* (name: string) {
    const before = yield* Effect.flatMap(World, (world) =>
      Effect.succeed(world.logins.get("current")?.location),
    );
    const login = yield* startLogin(name, "next");
    const published = certificatesIn(yield* spMetadata(name));
    const previous =
      before === undefined ? [] : published.filter((pem) => verifiesUnder(before, [pem]));
    const newest = published.filter((pem) => !previous.includes(pem));
    assert.equal(newest.length, 1);
    assert.ok(verifiesUnder(login.location, newest));
    assert.equal(verifiesUnder(login.location, previous), false);
  });
  When("a newer signing key of {string} is stored that cannot be opened", function* (name: string) {
    const connection = yield* connectionState(name);
    yield* inApp(TestClock.adjust("5 seconds"));
    yield* inApp(
      Effect.gen(function* () {
        const records = yield* SamlRecords.SamlRecords;
        const [row] = yield* records.listSpKeys(connection.id);
        assert.ok(row !== undefined);
        // A sealed key bound to ANOTHER key id: the newest row, and it cannot be opened.
        yield* records.saveSpKey({ ...row, id: "swapped-key" });
      }),
    );
  });
  Then(
    "starting a login on {string} is a defect and produces no redirect",
    function* (name: string) {
      const connection = yield* connectionState(name);
      const exit = yield* inAppExit(
        Effect.flatMap(Saml.Saml, (saml) => saml.authnRequest(connection.id, {})),
      );
      assert.ok(Exit.isFailure(exit));
      assert.ok(Exit.hasDies(exit));
    },
  );

  // ---- BEH-EA-315: Single Logout -------------------------------------------------------------

  Given("{string} is signed in through {string}", function* (user: string, name: string) {
    const outcome = yield* signInUser(user, name);
    assert.equal(outcome._tag, "accepted");
  });
  Given(
    "{string} is signed in through {string} with SessionIndex {string}",
    function* (user: string, name: string, index: string) {
      const outcome = yield* signInUser(user, name, { sessionIndex: index });
      assert.equal(outcome._tag, "accepted");
    },
  );
  When("{string} signs in again through {string}", function* (user: string, name: string) {
    const outcome = yield* signInUser(user, name);
    assert.equal(outcome._tag, "accepted");
  });
  When(
    "the IdP sends a LogoutRequest for {string} over the Redirect binding",
    function* (user: string) {
      const connection = yield* connectionState("acme");
      const world = yield* World;
      const input = redirectInput(
        connection.id,
        "SAMLRequest",
        logoutFor(user, connection.id, connection.entityId),
        { relayState: "idp-state" },
      );
      yield* world.outcomes.set("logoutInput", input);
      yield* deliver(input);
    },
  );
  When(
    "the IdP sends a LogoutRequest for {string} over the POST binding",
    function* (user: string) {
      const connection = yield* connectionState("acme");
      yield* deliver(
        postInput(
          connection.id,
          "SAMLRequest",
          logoutFor(user, connection.id, connection.entityId),
          REQUEST_ID,
        ),
      );
    },
  );
  When(
    "the IdP sends a LogoutRequest for {string} naming only SessionIndex {string}",
    function* (user: string, index: string) {
      const connection = yield* connectionState("acme");
      yield* deliver(
        redirectInput(
          connection.id,
          "SAMLRequest",
          logoutFor(user, connection.id, connection.entityId, { sessionIndexes: [index] }),
        ),
      );
    },
  );
  When("the IdP replays the same LogoutRequest", function* () {
    const world = yield* World;
    const input = yield* world.outcomes.getAs(
      "logoutInput",
      (value): value is SamlSlo.SloInput =>
        typeof value === "object" && value !== null && "binding" in value,
    );
    yield* deliver(input);
  });
  When(
    "the IdP sends a LogoutRequest for {string} over the {word} binding that {}",
    function* (user: string, binding: string, flaw: string) {
      const connection = yield* connectionState("acme");
      assert.ok(isFlaw(flaw), `the World does not know the flaw "${flaw}"`);
      const xml = logoutFor(user, connection.id, connection.entityId);
      if (binding === "Redirect") {
        const good = redirectInput(connection.id, "SAMLRequest", xml, { relayState: "r" });
        const raw = good.rawQuery ?? "";
        const first = (raw.match(/SAMLRequest=([^&]+)/)?.[1] ?? "").slice(0, 6);
        switch (flaw) {
          case "is unsigned":
            return yield* deliver(
              redirectInput(connection.id, "SAMLRequest", xml, { unsigned: true }),
            );
          case "is signed by another key":
            return yield* deliver(
              redirectInput(connection.id, "SAMLRequest", xml, { signer: attacker }),
            );
          case "was tampered with after signing":
            return yield* deliver({ ...good, rawQuery: raw.replace(first, "AAAAAA") });
          case "claims the SHA-1 signature algorithm":
            return yield* deliver({
              ...good,
              rawQuery: raw.replace(
                encodeURIComponent(ALGORITHM.rsaSha256),
                encodeURIComponent(ALGORITHM.rsaSha1),
              ),
            });
          case "loses its RelayState after signing":
            return yield* deliver({ ...good, rawQuery: raw.replace(/&RelayState=[^&]*/, "") });
          default:
            return yield* Effect.die(new Error(`"${flaw}" does not apply to the Redirect binding`));
        }
      }
      switch (flaw) {
        case "is unsigned":
          return yield* deliver(
            postInput(connection.id, "SAMLRequest", xml, REQUEST_ID, { unsigned: true }),
          );
        case "is signed by another key":
          return yield* deliver(
            postInput(connection.id, "SAMLRequest", xml, REQUEST_ID, { signer: attacker }),
          );
        case "was tampered with after signing":
          return yield* deliver(
            postInput(connection.id, "SAMLRequest", xml, REQUEST_ID, {
              raw: (signed) => signed.replace(user, "grace"),
            }),
          );
        case "is wrapped with a second, unsigned request":
          return yield* deliver(
            postInput(connection.id, "SAMLRequest", xml, REQUEST_ID, {
              raw: (signed) =>
                signed.replace(
                  "</samlp:LogoutRequest>",
                  `<samlp:Extensions>${signed.replace(REQUEST_ID, "_evil").replace(user, "grace")}</samlp:Extensions></samlp:LogoutRequest>`,
                ),
            }),
          );
        case "carries a DOCTYPE":
          return yield* deliver(
            postInput(connection.id, "SAMLRequest", xml, REQUEST_ID, {
              raw: (signed) => `<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>${signed}`,
            }),
          );
        default:
          return yield* Effect.die(new Error(`"${flaw}" does not apply to the POST binding`));
      }
    },
  );
  When(
    "the IdP sends a validly signed LogoutRequest for {string} over the Redirect binding that {}",
    function* (user: string, flaw: string) {
      const connection = yield* connectionState("acme");
      const overrides: Partial<LogoutRequestOptions> =
        flaw === "names another issuer"
          ? { issuer: "https://other-idp.example.com/metadata" }
          : flaw === "is addressed to another destination"
            ? { destination: "https://evil.example.com/slo" }
            : flaw === "was issued half an hour ago"
              ? { issueInstant: DateTime.subtract(NOW, { minutes: 30 }) }
              : flaw === "was issued half an hour from now"
                ? { issueInstant: DateTime.add(NOW, { minutes: 30 }) }
                : flaw === "has already expired"
                  ? { notOnOrAfter: DateTime.subtract(NOW, { minutes: 10 }) }
                  : {};
      assert.notDeepEqual(overrides, {}, `the World does not know the flaw "${flaw}"`);
      yield* deliver(
        redirectInput(
          connection.id,
          "SAMLRequest",
          logoutFor(user, connection.id, connection.entityId, overrides),
        ),
      );
    },
  );
  Then(
    "the session of {string} is ended with the reason {string} in the tenant of {string}",
    function* (user: string, reason: string, name: string) {
      const connection = yield* connectionState(name);
      const ids = yield* sessionIdsOf(user);
      assert.ok(ids.length > 0);
      for (const id of ids) assert.equal(yield* isLive(user, id), false);
      const rows = (yield* revocationsOf).filter((row) => row.reason === reason);
      assert.ok(rows.length >= 1, `a session was revoked with the reason "${reason}"`);
      assert.deepEqual(rows[0]?.tenantId, Option.some(connection.organizationId));
    },
  );
  Then("the IdP is answered with a signed LogoutResponse of status Success", function* () {
    const result = yield* lastSlo;
    assert.equal(result._tag, "outcome");
    if (result._tag !== "outcome" || result.outcome._tag !== "redirect")
      return assert.fail("expected a redirect to the IdP");
    const location = result.outcome.location;
    assert.equal(location.slice(0, location.indexOf("?")), IDP_SLO);
    const xml = inflateRawSync(
      Buffer.from(decodeURIComponent(redirectParts(location).message), "base64"),
    ).toString("utf8");
    assert.ok(
      xml.includes("<samlp:LogoutResponse") &&
        xml.includes("status:Success") &&
        xml.includes(`InResponseTo="${REQUEST_ID}"`),
    );
    const published = certificatesIn(yield* spMetadata("acme"));
    assert.ok(verifiesUnder(location, published), "the answer is signed with the SP key");
  });
  Then("the logout is refused with the uniform {string} failure", function* (tag: string) {
    const result = yield* lastSlo;
    assert.deepEqual(result, { _tag: "failed", tag });
  });
  Then("the session of {string} is still live", function* (user: string) {
    for (const id of yield* sessionIdsOf(user)) assert.equal(yield* isLive(user, id), true);
  });
  Then("the new session of {string} is still live", function* (user: string) {
    const ids = yield* sessionIdsOf(user);
    assert.equal(yield* isLive(user, ids.at(-1) ?? ""), true);
  });
  Then("exactly {int} session of {string} is ended", function* (count: number, user: string) {
    const live = [];
    for (const id of yield* sessionIdsOf(user)) if (yield* isLive(user, id)) live.push(id);
    const all = yield* sessionIdsOf(user);
    assert.equal(all.length - live.length, count);
  });
  When("{string} logs out through {string}", function* (user: string, _name: string) {
    const world = yield* World;
    const userId = world.users.get(user);
    assert.ok(userId !== undefined);
    const ids = yield* sessionIdsOf(user);
    const started = yield* inApp(
      Effect.flatMap(Saml.Saml, (saml) =>
        saml.logout(
          new Api.UserPrincipal({
            ref: new Api.PrincipalRef({ type: "user", id: userId }),
            sessionId: ids.at(-1) ?? "",
          }),
          { callbackURL: "/bye" },
        ),
      ),
    );
    yield* world.outcomes.set("logoutStart", started);
  });
  Then(
    "the IdP receives a signed LogoutRequest naming {string} and the SessionIndex of that sign-in",
    function* (user: string) {
      const world = yield* World;
      const started = yield* world.outcomes.getAs(
        "logoutStart",
        (value): value is SamlSlo.LogoutStart =>
          typeof value === "object" && value !== null && "_tag" in value,
      );
      assert.equal(started._tag, "redirect");
      if (started._tag !== "redirect") return;
      const xml = inflateRawSync(
        Buffer.from(decodeURIComponent(redirectParts(started.location).message), "base64"),
      ).toString("utf8");
      assert.ok(
        xml.includes("<samlp:LogoutRequest") &&
          xml.includes(`>${user}</saml:NameID>`) &&
          xml.includes("<samlp:SessionIndex>_session1</samlp:SessionIndex>"),
      );
      assert.ok(verifiesUnder(started.location, certificatesIn(yield* spMetadata("acme"))));
    },
  );
  const answerOurLogout = (inResponseTo: "ours" | string) =>
    Effect.gen(function* () {
      const world = yield* World;
      const started = yield* world.outcomes.getAs(
        "logoutStart",
        (value): value is SamlSlo.LogoutStart =>
          typeof value === "object" && value !== null && "_tag" in value,
      );
      assert.equal(started._tag, "redirect");
      if (started._tag !== "redirect") return;
      const connection = yield* connectionState("acme");
      const xml = inflateRawSync(
        Buffer.from(decodeURIComponent(redirectParts(started.location).message), "base64"),
      ).toString("utf8");
      const ourId = /ID="([^"]+)"/.exec(xml)?.[1] ?? "";
      yield* deliver(
        redirectInput(
          connection.id,
          "SAMLResponse",
          logoutResponseXml({
            id: "_idp-response-1",
            issuer: connection.entityId,
            destination: sloUrlOf(connection.id),
            inResponseTo: inResponseTo === "ours" ? ourId : inResponseTo,
          }),
          { cookieState: Redacted.value(started.state) },
        ),
      );
    });
  When("the IdP answers our LogoutRequest with a signed LogoutResponse", function* () {
    yield* answerOurLogout("ours");
  });
  When("the IdP answers a different request with a signed LogoutResponse", function* () {
    yield* answerOurLogout("_some-other-request");
  });
  Then("the browser lands back on the application", function* () {
    const result = yield* lastSlo;
    assert.deepEqual(result, { _tag: "outcome", outcome: { _tag: "done", callbackURL: "/bye" } });
  });
  Then("the browser is sent straight back to the application", function* () {
    const world = yield* World;
    const started = yield* world.outcomes.getAs(
      "logoutStart",
      (value): value is SamlSlo.LogoutStart =>
        typeof value === "object" && value !== null && "_tag" in value,
    );
    assert.deepEqual(started, { _tag: "local", callbackURL: "/bye" });
  });

  // ---- BEH-EA-316: role mapping ----------------------------------------------------------------

  Given(
    "the connection {string} maps the group {string} to the role {string} under the ceiling {string} with the default role {string}",
    function* (name: string, group: string, role: string, ceiling: string, defaultRole: string) {
      yield* planConnection(name, {
        roleMapping: {
          rules: [{ attribute: "groups", value: group, roles: [role] }],
          ceiling: [ceiling],
          defaultRoles: [defaultRole],
        },
      });
    },
  );
  When(
    "{string} signs in through {string} carrying the groups {string}",
    function* (user: string, name: string, groups: string) {
      const outcome = yield* signInUser(user, name, {
        groups: groups.split(",").map((group) => group.trim()),
      });
      assert.ok(outcome._tag === "accepted" || outcome._tag === "failed");
    },
  );
  const rolesOf = (user: string, name: string) =>
    Effect.gen(function* () {
      const world = yield* World;
      const connection = yield* connectionState(name);
      const userId = world.users.get(user);
      assert.ok(userId !== undefined, `"${user}" has signed in`);
      const found = yield* inApp(
        Effect.flatMap(MembershipRecords.MembershipRecords, (members) =>
          members.findByUserAndOrg(Users.UserId(userId), connection.organizationId),
        ),
      );
      return Option.map(found, (row) => row.role);
    });
  Then(
    "{string} holds the role {string} in the organization of {string}",
    function* (user: string, role: string, name: string) {
      assert.deepEqual(yield* rolesOf(user, name), Option.some([role]));
    },
  );
  Then(
    "{string} holds no role in the organization of {string}",
    function* (user: string, name: string) {
      assert.deepEqual(yield* rolesOf(user, name), Option.none());
    },
  );
  Then("{string} is signed in", function* (user: string) {
    const world = yield* World;
    assert.ok(world.users.has(user));
  });
  When(
    "an administrator writes the connection {string} of {string} mapping the group {string} to the role {string} under the ceiling {string}",
    function* (second: string, name: string, group: string, role: string, ceiling: string) {
      const world = yield* World;
      const connection = yield* connectionState(name);
      const exit = yield* inAppExit(
        Effect.flatMap(SamlConnections.SamlConnectionStore, (store) =>
          store.create({
            organizationId: connection.organizationId,
            name: second,
            idp: {
              entityId: `https://idp.${second}.example`,
              ssoUrl: `https://idp.${second}.example/sso`,
              certificates: [idp.cert],
            },
            roleMapping: {
              rules: [{ attribute: "groups", value: group, roles: [role] }],
              ceiling: [ceiling],
              defaultRoles: [],
            },
          }),
        ),
      );
      const reason = Exit.isFailure(exit)
        ? Option.match(Exit.findErrorOption(exit), {
            onNone: () => "defect",
            onSome: (error) =>
              "reason" in error && typeof error.reason === "string" ? error.reason : error._tag,
          })
        : "created";
      yield* world.outcomes.set("connectionRefusal", reason);
    },
  );
  Then("the connection is refused as {string}", function* (fragment: string) {
    const world = yield* World;
    const reason = yield* world.outcomes.getAs("connectionRefusal", isString);
    assert.ok(
      reason.includes(fragment),
      `expected the reason to name "${fragment}", got "${reason}"`,
    );
  });
  Given(
    "the mapping of {string} is rewritten in the records to give owner to the group {string} under the ceiling {string}",
    function* (name: string, group: string, ceiling: string) {
      const connection = yield* connectionState(name);
      yield* inApp(
        Effect.flatMap(SamlRecords.SamlRecords, (records) =>
          records
            .update(connection.id, {
              roleMapping: {
                rules: [{ attribute: "groups", value: group, roles: ["owner"] }],
                ceiling: [ceiling],
                defaultRoles: [],
              },
            })
            .pipe(Effect.orDie),
        ),
      );
    },
  );
  Given(
    "{string} is the only owner of the organization of {string} and trusts the connection's email",
    function* (user: string, name: string) {
      const world = yield* World;
      const connection = yield* connectionState(name);
      const userId = yield* inApp(
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const members = yield* MembershipRecords.MembershipRecords;
          const records = yield* SamlRecords.SamlRecords;
          const created = yield* users
            .create({ identity: { _tag: "Email", email: `${user}@${name}.example` }, name: user })
            .pipe(Effect.orDie);
          yield* users.verifyEmail(created.id).pipe(Effect.orDie);
          yield* members.create({
            userId: created.id,
            organizationId: connection.organizationId,
            role: ["owner"],
          });
          yield* members
            .remove(Users.UserId(ownerPrincipal.ref.id), connection.organizationId)
            .pipe(Effect.orDie);
          yield* records.update(connection.id, { trustsEmail: true }).pipe(Effect.orDie);
          return created.id;
        }),
      );
      world.users.set(user, userId);
    },
  );

  // ---- BEH-EA-317: the Sso dispatcher ------------------------------------------------------------

  /** The organization called `name`: the one its SAML connection seeded, else one created for it (an OIDC-only organization). */
  const organizationOf = (name: string) =>
    Effect.gen(function* () {
      const world = yield* World;
      const known = world.connections.get(name);
      if (known !== undefined) return known.organizationId;
      const remembered = bookOf(world).organizations.get(name);
      if (remembered !== undefined) return remembered;
      const created = yield* inApp(
        Effect.flatMap(Organization.Organization, (organization) =>
          organization.create({ caller: ownerPrincipal, name, slug: name }).pipe(Effect.orDie),
        ),
      );
      bookOf(world).organizations.set(name, created.id);
      return created.id;
    });

  Given(
    "the organization {string} has a {word} connection for the domain {string}",
    function* (name: string, protocol: string, domain: string) {
      if (protocol === "SAML") {
        yield* planConnection(name, { emailDomains: [domain] });
        yield* connectionState(name);
        return;
      }
      assert.equal(protocol, "OIDC");
      const organizationId = yield* organizationOf(name);
      const view = yield* inApp(
        Effect.flatMap(OrganizationConnections.OrganizationConnectionStore, (store) =>
          store
            .create({
              organizationId,
              kind: "oidc",
              name: `${name} OIDC`,
              issuer: `https://oidc.${name}.example`,
              discoveryUrl: `https://oidc.${name}.example/.well-known/openid-configuration`,
              clientId: "client-1",
              clientSecret: Redacted.make("secret"),
              emailDomains: [domain],
            })
            .pipe(Effect.orDie),
        ),
      );
      const world = yield* World;
      yield* world.outcomes.set(`oidc:${name}`, view.providerId);
    },
  );
  Given("the Sso preference is {word}", function* (preferred: string) {
    const world = yield* World;
    yield* Ref.set(world.ssoPreference, preferred === "OIDC" ? "oidc" : "saml");
  });
  When("the Sso dispatcher is asked where {string} signs in", function* (email: string) {
    const world = yield* World;
    const routes = yield* inApp(Effect.flatMap(Sso.Sso, (sso) => sso.discoverAll({ email })));
    yield* world.outcomes.set("ssoRoutes", routes);
    const first = yield* inApp(Effect.flatMap(Sso.Sso, (sso) => sso.discover({ email })));
    yield* world.outcomes.set("ssoRoute", Option.getOrUndefined(first) ?? null);
  });
  Then("it answers the {word} login URL of that connection", function* (protocol: string) {
    const world = yield* World;
    const route = yield* world.outcomes.getAs(
      "ssoRoute",
      (value): value is Sso.SsoRoute | null =>
        value === null || (typeof value === "object" && "loginUrl" in value),
    );
    assert.ok(route !== null, "a route");
    if (protocol === "SAML") {
      assert.equal(route.protocol, "saml");
      const connection = yield* connectionState("acme");
      assert.equal(route.connectionId, connection.id);
      assert.equal(route.loginUrl, `/auth/saml/login?connection=${connection.id}`);
    } else {
      assert.equal(route.protocol, "oidc");
      const providerId = yield* world.outcomes.getAs("oidc:acme", isString);
      assert.equal(route.loginUrl, `/oauth/${encodeURIComponent(providerId)}/authorize`);
    }
  });
  Then("it lists both protocols for the address", function* () {
    const world = yield* World;
    const routes = yield* world.outcomes.getAs(
      "ssoRoutes",
      (value): value is ReadonlyArray<Sso.SsoRoute> => Array.isArray(value),
    );
    assert.deepEqual(routes.map((route) => route.protocol).toSorted(), ["oidc", "saml"]);
  });
  Then(
    "asking where {string} signs in is refused as {string}",
    function* (email: string, tag: string) {
      const exit = yield* inAppExit(
        Effect.flatMap(Sso.Sso, (sso) => sso.start({ email }, "203.0.113.9")),
      );
      assert.ok(Exit.isFailure(exit));
      assert.equal(Option.getOrUndefined(Exit.findErrorOption(exit))?._tag, tag);
    },
  );

  // ---- BEH-EA-318: administration ---------------------------------------------------------------

  Given("the administrator gate allows every action", function* () {
    yield* configure({ canManageSaml: () => Effect.succeed(true) });
  });
  Given("the connection {string} exists", function* (name: string) {
    yield* connectionState(name);
  });
  When("the administrator attempts every SAML admin operation", function* () {
    const world = yield* World;
    const connection = yield* connectionState("acme");
    const results = yield* inApp(
      Effect.flatMap(Saml.Saml, (saml) => {
        const ops = saml.admin;
        return Effect.all([
          Effect.result(
            ops.createConnection(adminPrincipal, {
              organizationId: connection.organizationId,
              name: "x",
              idp: {
                entityId: "e",
                ssoUrl: "https://idp.example.com/sso",
                certificates: [idp.cert],
              },
            }),
          ),
          Effect.result(ops.listConnections(adminPrincipal, connection.organizationId)),
          Effect.result(ops.getConnection(adminPrincipal, connection.id)),
          Effect.result(ops.updateConnection(adminPrincipal, connection.id, { name: "renamed" })),
          Effect.result(ops.deleteConnection(adminPrincipal, connection.id)),
          Effect.result(ops.refreshMetadata(adminPrincipal, connection.id)),
          Effect.result(ops.rotateSigningKey(adminPrincipal, connection.id, {})),
          Effect.result(ops.listSigningKeys(adminPrincipal, connection.id)),
        ]);
      }),
    );
    yield* world.outcomes.set(
      "denials",
      results.filter(
        (result) => result._tag === "Failure" && result.failure._tag === "SamlActionDenied",
      ).length,
    );
  });
  Then("all {int} are refused as {string}", function* (count: number, tag: string) {
    const world = yield* World;
    assert.equal(tag, "SamlActionDenied");
    assert.equal(yield* world.outcomes.getAs("denials", isNumber), count);
  });
  Then(
    "each refusal published auth.admin.actionDenied naming {string}",
    function* (pattern: string) {
      assert.equal(pattern, "saml.<action>");
      const rows = yield* inApp(
        Effect.flatMap(AuditLog.AuditLog, (log) =>
          log.list({ eventTag: "auth.admin.actionDenied" }),
        ).pipe(Effect.orDie),
      );
      const actions = rows
        .flatMap((row) =>
          row.payload._tag === "auth.admin.actionDenied" ? [row.payload.action] : [],
        )
        .toSorted();
      assert.deepEqual(actions, [
        "saml.createConnection",
        "saml.deleteConnection",
        "saml.getConnection",
        "saml.listConnections",
        "saml.listSigningKeys",
        "saml.refreshMetadata",
        "saml.rotateSigningKey",
        "saml.updateConnection",
      ]);
    },
  );
  Then("the connection {string} is unchanged", function* (name: string) {
    const connection = yield* connectionState(name);
    const found = yield* inApp(
      Effect.flatMap(SamlRecords.SamlRecords, (records) => records.findById(connection.id)),
    );
    assert.ok(Option.isSome(found));
    assert.equal(found.value.name, name);
  });
  const metadataXml = (options: {
    readonly entityId: string;
    readonly certs: ReadonlyArray<string>;
    readonly slo?: string;
  }) =>
    `<?xml version="1.0"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="${NS.ds}" entityID="${options.entityId}">` +
    `<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
    options.certs
      .map(
        (pem) =>
          `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "")}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`,
      )
      .join("") +
    (options.slo === undefined
      ? ""
      : `<md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${options.slo}"/>`) +
    `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso"/></md:IDPSSODescriptor></md:EntityDescriptor>`;

  const METADATA_URL = "https://idp.example.com/metadata.xml";
  const isDto = (
    value: unknown,
  ): value is {
    readonly id: string;
    readonly certificates: ReadonlyArray<{ readonly fingerprint: string }>;
    readonly sloUrl: string | null;
  } => typeof value === "object" && value !== null && "certificates" in value;

  When(
    "the administrator creates a connection for {string} from IdP metadata listing two certificates and a logout endpoint",
    function* (name: string) {
      const world = yield* World;
      const organizationId = yield* organizationOf(name);
      const created = yield* inApp(
        Effect.flatMap(Saml.Saml, (saml) =>
          saml.admin
            .createConnection(adminPrincipal, {
              organizationId,
              name: "From metadata",
              idp: {
                metadataXml: metadataXml({
                  entityId: "https://idp.example.com/metadata",
                  certs: [idp.cert, idpNext.cert],
                  slo: "https://idp.example.com/slo",
                }),
              },
            })
            .pipe(Effect.orDie),
        ),
      );
      yield* world.outcomes.set("dto", created);
    },
  );
  Then("the connection pins both certificate fingerprints and the logout endpoint", function* () {
    const world = yield* World;
    const dto = yield* world.outcomes.getAs("dto", isDto);
    assert.deepEqual(
      dto.certificates.map((entry) => entry.fingerprint).toSorted(),
      [idp.fingerprint, idpNext.fingerprint].toSorted(),
    );
    assert.equal(dto.sloUrl, "https://idp.example.com/slo");
  });
  Then("a creation audit event names the administrator and the connection", function* () {
    const world = yield* World;
    const dto = yield* world.outcomes.getAs("dto", isDto);
    const rows = yield* inApp(
      Effect.flatMap(AuditLog.AuditLog, (log) =>
        log.list({ eventTag: "auth.saml.connectionCreated" }),
      ).pipe(Effect.orDie),
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.actorUserId, Option.some(adminPrincipal.ref.id));
    assert.equal(
      rows[0]?.payload._tag === "auth.saml.connectionCreated" ? rows[0].payload.connectionId : "",
      dto.id,
    );
  });
  Given("the connection {string} was imported from IdP metadata", function* (name: string) {
    const world = yield* World;
    world.metadata.set(
      METADATA_URL,
      metadataXml({ entityId: "https://idp.example.com/metadata", certs: [idp.cert] }),
    );
    const organizationId = yield* organizationOf(name);
    const created = yield* inApp(
      Effect.flatMap(Saml.Saml, (saml) =>
        saml.admin
          .createConnection(adminPrincipal, {
            organizationId,
            name,
            idp: { metadataUrl: METADATA_URL },
          })
          .pipe(Effect.orDie),
      ),
    );
    yield* world.outcomes.set("dto", created);
  });
  const refresh = Effect.gen(function* () {
    const world = yield* World;
    const dto = yield* world.outcomes.getAs("dto", isDto);
    const exit = yield* inAppExit(
      Effect.flatMap(Saml.Saml, (saml) => saml.admin.refreshMetadata(adminPrincipal, dto.id)),
    );
    yield* world.outcomes.set(
      "refresh",
      Exit.isSuccess(exit)
        ? { tag: "refreshed" }
        : {
            tag: Option.match(Exit.findErrorOption(exit), {
              onNone: () => "defect",
              onSome: (error) => error._tag,
            }),
          },
    );
  });
  When("the IdP metadata is refreshed with only the next certificate", function* () {
    const world = yield* World;
    world.metadata.set(
      METADATA_URL,
      metadataXml({ entityId: "https://idp.example.com/metadata", certs: [idpNext.cert] }),
    );
    yield* refresh;
  });
  When("the IdP metadata is refreshed naming another entity", function* () {
    const world = yield* World;
    world.metadata.set(
      METADATA_URL,
      metadataXml({ entityId: "https://evil.example.com/m", certs: [attacker.cert] }),
    );
    yield* refresh;
  });
  const trustedFingerprints = Effect.gen(function* () {
    const world = yield* World;
    const dto = yield* world.outcomes.getAs("dto", isDto);
    const found = yield* inApp(
      Effect.flatMap(SamlRecords.SamlRecords, (records) => records.findById(dto.id)),
    );
    assert.ok(Option.isSome(found));
    return found.value.idpCertificates.map((certificate) => certificate.fingerprint);
  });
  Then("the connection trusts only the next certificate", function* () {
    assert.deepEqual(yield* trustedFingerprints, [idpNext.fingerprint]);
  });
  Then("the refresh is refused as {string}", function* (tag: string) {
    const world = yield* World;
    const result = yield* world.outcomes.getAs(
      "refresh",
      (value): value is { readonly tag: string } =>
        typeof value === "object" && value !== null && "tag" in value,
    );
    assert.equal(result.tag, tag);
  });
  Then("the connection still trusts the original certificate", function* () {
    assert.deepEqual(yield* trustedFingerprints, [idp.fingerprint]);
  });
  Given("a second organization {string} exists", function* (name: string) {
    yield* organizationOf(name);
  });
  When(
    "an administrator acting inside {string} reads the connection {string}",
    function* (tenant: string, name: string) {
      const world = yield* World;
      const organizationId = yield* organizationOf(tenant);
      const connection = yield* connectionState(name);
      const read = (id: string) =>
        inApp(
          Tenant.withTenant(organizationId)(
            Effect.flatMap(Saml.Saml, (saml) =>
              saml.admin.getConnection(adminPrincipal, id).pipe(Effect.flip),
            ),
          ),
        );
      const foreign = yield* read(connection.id);
      const unknown = yield* read("no-such-connection");
      yield* world.outcomes.set("foreign", {
        tag: foreign._tag,
        same: JSON.stringify(foreign) === JSON.stringify(unknown),
      });
    },
  );
  Then("the read is refused as {string}, exactly as for an unknown id", function* (tag: string) {
    const world = yield* World;
    const result = yield* world.outcomes.getAs(
      "foreign",
      (value): value is { readonly tag: string; readonly same: boolean } =>
        typeof value === "object" && value !== null && "same" in value,
    );
    assert.equal(result.tag, tag);
    assert.equal(result.same, true);
  });
  When(
    "the administrator renames the connection {string} to {string} and disables its email linking",
    function* (name: string, renamed: string) {
      const connection = yield* connectionState(name);
      yield* inApp(
        Effect.flatMap(Saml.Saml, (saml) =>
          saml.admin
            .updateConnection(adminPrincipal, connection.id, { name: renamed, trustsEmail: false })
            .pipe(Effect.orDie),
        ),
      );
    },
  );
  Then(
    "the update audit event names the fields {string} and {string} and no value",
    function* (first: string, second: string) {
      const rows = yield* inApp(
        Effect.flatMap(AuditLog.AuditLog, (log) =>
          log.list({ eventTag: "auth.saml.connectionUpdated" }),
        ).pipe(Effect.orDie),
      );
      assert.equal(rows.length, 1);
      const payload = rows[0]?.payload;
      assert.ok(payload?._tag === "auth.saml.connectionUpdated");
      assert.deepEqual([...payload.fields].toSorted(), [first, second].toSorted());
      assert.ok(!JSON.stringify(payload).includes("private"));
    },
  );
});
