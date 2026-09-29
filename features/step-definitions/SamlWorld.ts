// P20a: the World for 29-saml-sp.feature. The real @awthaq/saml plugin over the in-memory core, the organization
// plugin it depends on, the SAML records and connection store, and the Node `XmlSignature` adapter - the same
// layer graph an application builds - with three observation points the scenarios need and the plugin does not
// expose: a spy around the `XmlSignature` port (what reached the parser/verifier, and how it answered), a log
// capture for the rejection REASON (never on the wire, by design: BEH-EA-238's uniform failure), and a
// `TestClock` so a time-window scenario moves the server's clock rather than editing the document.
//
// The scenarios play both other parties: the browser (the `__Host-saml-request` state a login hands back) and the
// IdP (a signed response for a given AuthnRequest). Everything goes through `Saml.acs`, the service behind
// `POST /auth/saml/acs`, so the chain a scenario exercises is the production one, cookie to session.
import { Api } from "@awthaq/api";
import {
  Accounts,
  AuditLog,
  AuthEvents,
  Hooks,
  RateLimits,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import {
  ActiveContextRecords,
  InvitationRecords,
  MembershipRecords,
  Organization,
  OrganizationHooks,
  OrganizationRecords,
  OrgRoleRecords,
  TeamRecords,
} from "@awthaq/organization";
import { ClientAddress, Mailer, RateLimiter, SqlTransaction, XmlSignature } from "@awthaq/ports";
import { Saml, SamlConnections, SamlRecords, XmlSignatureNode } from "@awthaq/saml";

type SamlConfigInput = Saml.SamlConfigInput;
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { inflateRawSync } from "node:zlib";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import {
  ALGORITHM,
  attacker,
  idp,
  idpNext,
  NOW_MILLIS,
  responseXml,
  signedResponse,
  type Identity,
  type ResponseOptions,
  type SignOptions,
} from "./SamlFixtures.ts";
import { makeOutcomes, type Outcomes } from "./shared/Outcomes.ts";

export const BASE_URL = "https://sp.example.com";
export const ACS_PATH = "/auth/saml/acs";

/** What the spy around the `XmlSignature` port saw: every document it was handed, and how it answered. */
export interface VerifyCall {
  readonly length: number;
  readonly fingerprints: ReadonlyArray<string>;
  /** `undefined` when verification succeeded; the port's own failure reason otherwise. */
  readonly failure: XmlSignature.XmlSignatureFailure | undefined;
  readonly verified: XmlSignature.VerifiedXml | undefined;
}

export type AppServices =
  | Saml.Saml
  | Saml.SamlConfig
  | SamlConnections.SamlConnectionStore
  | Organization.Organization
  | Users.Users
  | Accounts.Accounts
  | Sessions.Sessions
  | Verification.Verification;

export interface Observations {
  /** The reason names `Saml.acs` logged for each rejection, oldest first. */
  readonly reasons: Array<string>;
  readonly verifyCalls: Array<VerifyCall>;
  /** Everything logged, as text, for "this never reached a log" checks. */
  readonly logText: Array<string>;
}

const makeObservations = (): Observations => ({ reasons: [], verifyCalls: [], logText: [] });

const REASON = /"reason":"([^"]+)"/;

/** The recording `XmlSignature` port: the Node adapter, behind a spy. */
const spyLayer = (observations: Observations) =>
  Layer.effect(
    XmlSignature.XmlSignature,
    Effect.gen(function* () {
      const real = yield* XmlSignature.XmlSignature;
      return XmlSignature.XmlSignature.of({
        verify: (input) =>
          real.verify(input).pipe(
            Effect.tap((verified) =>
              Effect.sync(() =>
                observations.verifyCalls.push({
                  length: input.xml.length,
                  fingerprints: input.trust.certificates.map((entry) => entry.fingerprint),
                  failure: undefined,
                  verified,
                }),
              ),
            ),
            Effect.tapError((error) =>
              Effect.sync(() =>
                observations.verifyCalls.push({
                  length: input.xml.length,
                  fingerprints: input.trust.certificates.map((entry) => entry.fingerprint),
                  failure: error.reason,
                  verified: undefined,
                }),
              ),
            ),
          ),
      });
    }),
  ).pipe(Layer.provide(XmlSignatureNode.layer));

const CoreLive = Layer.mergeAll(
  Sessions.layerMemory,
  Users.layerMemory,
  Accounts.layerMemory,
  Verification.layerMemory,
).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(RateLimits.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("saml-bdd-csrf-secret-padded-to-thirty-two-bytes-long"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const OrganizationLive = Organization.Organization.layer.pipe(
  Layer.provide(Organization.config({})),
  Layer.provide(AuthenticationLive),
  Layer.provide(CsrfProtectionLive),
);

const buildLive = (observations: Observations, config: Partial<SamlConfigInput>) => {
  // The suite's output is not one console line per rejection: the base loggers are replaced by the capture.
  const Capture = Logger.layer([
    Logger.make((options) => {
      const text = JSON.stringify(options.message);
      observations.logText.push(text);
      const reason = REASON.exec(text)?.[1];
      if (reason !== undefined) observations.reasons.push(reason);
    }),
  ]);
  const ClockLive = Layer.effectDiscard(TestClock.setTime(NOW_MILLIS)).pipe(
    Layer.provideMerge(TestClock.layer()),
  );
  return Saml.Saml.layer.pipe(
    Layer.provideMerge(SamlConnections.layerStore),
    Layer.provideMerge(OrganizationLive),
    Layer.provideMerge(SamlRecords.layerMemory),
    Layer.provideMerge(spyLayer(observations)),
    Layer.provideMerge(RateLimiter.layerPermissive),
    Layer.provideMerge(ClientAddress.layerDirect),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(OrganizationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(MembershipRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(ActiveContextRecords.layerMemory),
    Layer.provideMerge(InvitationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(OrgRoleRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(TeamRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(Mailer.layerMemory),
    Layer.provideMerge(SqlTransaction.layerNoop),
    Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
    Layer.provideMerge(Saml.config({ baseUrl: BASE_URL, ...config })),
    Layer.provideMerge(Capture),
    Layer.provideMerge(ClockLive),
  );
};

/** The built application: run an effect against the very instances the scenario has been using. */
interface AppHandle {
  readonly run: <A, E>(effect: Effect.Effect<A, E, AppServices>) => Promise<Exit.Exit<A, E>>;
  readonly close: Effect.Effect<void>;
}

const buildApp = (observations: Observations, config: Partial<SamlConfigInput>): AppHandle => {
  const Live = buildLive(observations, config);
  const scope = Effect.runSync(Scope.make());
  let built: Promise<Context.Context<AppServices>> | undefined;
  const context = () =>
    (built ??= Effect.runPromise(Layer.buildWithMemoMap(Live, Layer.makeMemoMapUnsafe(), scope)));
  return {
    run: (effect) =>
      context().then((services) => Effect.runPromiseExit(effect.pipe(Effect.provide(services)))),
    close: Scope.close(scope, Exit.void),
  };
};

// ---- the scenario's own state ----------------------------------------------------------------------

/** One connection the scenario has seeded: an organization, its SAML connection and the IdP identity that signs for it. */
export interface ConnectionState {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly entityId: string;
  readonly signer: Identity;
}

/** A login the browser has started: the state cookie, and the AuthnRequest id the IdP must answer. */
export interface LoginState {
  readonly connectionName: string;
  readonly requestId: string;
  readonly state: string;
  readonly location: string;
}

/** What the IdP is about to send: the response's fields, the signing choices and the edits applied after signing. */
export interface ResponseSpec {
  readonly response: ResponseOptions;
  readonly sign: SignOptions;
  /** Edits applied to the signed document, in order (the attack documents). */
  readonly mutations: ReadonlyArray<(xml: string) => string>;
  /** Padding inside the signed Assertion so the decoded response is about this many bytes. */
  readonly padBytes: number;
  /** Replaces the whole payload: the browser posts something that is not a response the IdP signed. */
  readonly rawPayload: ((login: LoginState | undefined) => string) | undefined;
  /** The audience/issuer a scenario leaves unset are derived from the connection the response is for. */
  readonly forConnection: string | undefined;
}

export const emptySpec: ResponseSpec = {
  response: {},
  sign: {},
  mutations: [],
  padBytes: 0,
  rawPayload: undefined,
  forConnection: undefined,
};

export type Outcome =
  | { readonly _tag: "accepted"; readonly userId: string; readonly callbackURL: string }
  | { readonly _tag: "failed"; readonly tag: string };

export const isOutcome = (value: unknown): value is Outcome =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  (value._tag === "accepted" || value._tag === "failed");

export interface WorldShape {
  readonly observations: Observations;
  readonly config: Ref.Ref<Partial<SamlConfigInput>>;
  readonly started: Ref.Ref<boolean>;
  readonly app: Ref.Ref<AppHandle | undefined>;
  readonly connections: Map<string, ConnectionState>;
  /** Logins by the label the scenario gave them; `current` is the latest. */
  readonly logins: Map<string, LoginState>;
  readonly spec: Ref.Ref<ResponseSpec>;
  /** Per-connection choices made before the connection exists: its IdP's entity id and whether it trusts email. */
  readonly connectionPlans: Map<
    string,
    {
      entityId?: string;
      signer?: Identity;
      trustsEmail?: boolean;
      certificates?: ReadonlyArray<Identity>;
    }
  >;
  readonly outcomes: Outcomes;
  /** The reason a scenario expects the ACS to log for its rejection (the uniform failure hides it on the wire). */
  readonly expectedReason: Ref.Ref<string | undefined>;
  /** Users the scenario created directly, by the name it gave them. */
  readonly users: Map<string, string>;
}

export class World extends Context.Service<World, WorldShape>()("features/SamlWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    const observations = makeObservations();
    const app = yield* Ref.make<AppHandle | undefined>(undefined);
    yield* Effect.addFinalizer(() =>
      Ref.get(app).pipe(
        Effect.flatMap((handle) => (handle === undefined ? Effect.void : handle.close)),
      ),
    );
    return World.of({
      observations,
      config: yield* Ref.make<Partial<SamlConfigInput>>({}),
      started: yield* Ref.make(false),
      app,
      connections: new Map(),
      logins: new Map(),
      spec: yield* Ref.make(emptySpec),
      connectionPlans: new Map(),
      outcomes: yield* makeOutcomes,
      expectedReason: yield* Ref.make<string | undefined>(undefined),
      users: new Map(),
    });
  }),
);

// ---- running things against the app ---------------------------------------------------------------

const currentApp = Effect.gen(function* () {
  const world = yield* World;
  yield* Ref.set(world.started, true);
  const existing = yield* Ref.get(world.app);
  if (existing !== undefined) return existing;
  const fresh = buildApp(world.observations, yield* Ref.get(world.config));
  yield* Ref.set(world.app, fresh);
  return fresh;
});

/** Merges into the configuration the app will be built with; only before anything has run. */
export const configure = Effect.fn("features.saml.configure")(function* (
  change: Partial<SamlConfigInput>,
) {
  const world = yield* World;
  if (yield* Ref.get(world.started)) {
    return yield* Effect.die(new Error("configure SAML before a connection or a request exists"));
  }
  yield* Ref.update(world.config, (existing) => ({ ...existing, ...change }));
});

/** Runs `effect` against the app; a defect or failure the scenario did not expect is a defect of the step. */
export const inApp = Effect.fn("features.saml.inApp")(function* <A, E>(
  effect: Effect.Effect<A, E, AppServices>,
) {
  const app = yield* currentApp;
  const exit = yield* Effect.promise(() => app.run(effect));
  if (Exit.isFailure(exit)) return yield* Effect.die(exit.cause);
  return exit.value;
});

/** Runs `effect` and hands back its exit, for a call whose failure is the thing under test. */
export const inAppExit = <A, E>(effect: Effect.Effect<A, E, AppServices>) =>
  Effect.gen(function* () {
    const app = yield* currentApp;
    return yield* Effect.promise(() => app.run(effect));
  });

export const setClock = (millis: number) => inApp(TestClock.setTime(millis));

// ---- connections and logins ------------------------------------------------------------------------

const ownerPrincipal = new Api.UserPrincipal({
  ref: new Api.PrincipalRef({ type: "user", id: "owner-1" }),
  sessionId: "owner-session",
});

/** The organization-owned SAML connection called `name`, seeded on first use with whatever the scenario planned for it. */
export const ensureConnection = Effect.fn("features.saml.ensureConnection")(function* (
  name: string,
  organizationName?: string,
) {
  const world = yield* World;
  const known = world.connections.get(name);
  if (known !== undefined) return known;
  const plan = world.connectionPlans.get(name) ?? {};
  // A second connection trusts the next certificate, so "each trusting only its own IdP certificate" is real.
  const signer = plan.signer ?? (name === "globex" || name === "conn-2" ? idpNext : idp);
  const certificates = plan.certificates ?? [signer];
  const entityId = plan.entityId ?? `https://idp.${name}.example`;
  const orgName = organizationName ?? name;
  const seeded = yield* inApp(
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const store = yield* SamlConnections.SamlConnectionStore;
      const org = yield* organization
        .create({ caller: ownerPrincipal, name: orgName, slug: orgName })
        .pipe(Effect.orDie);
      const connection = yield* store
        .create({
          organizationId: org.id,
          name,
          idp: {
            entityId,
            ssoUrl: `https://idp.${name}.example/sso`,
            certificates: certificates.map((identity) => identity.cert),
          },
          emailDomains: [`${name}.example`],
          trustsEmail: plan.trustsEmail ?? false,
        })
        .pipe(Effect.orDie);
      return { id: connection.id, organizationId: org.id };
    }),
  );
  const state: ConnectionState = {
    id: seeded.id,
    organizationId: seeded.organizationId,
    organizationName: orgName,
    entityId,
    signer,
  };
  world.connections.set(name, state);
  return state;
});

/** Plans a connection's IdP before it is seeded; too late once it exists. */
export const planConnection = Effect.fn("features.saml.planConnection")(function* (
  name: string,
  plan: {
    entityId?: string;
    signer?: Identity;
    trustsEmail?: boolean;
    certificates?: ReadonlyArray<Identity>;
  },
) {
  const world = yield* World;
  if (world.connections.has(name)) {
    return yield* Effect.die(new Error(`connection "${name}" already exists; plan it first`));
  }
  world.connectionPlans.set(name, { ...world.connectionPlans.get(name), ...plan });
});

/** SP-initiated login as the browser sees it: the redirect to the IdP and the state cookie it now holds. */
export const startLogin = Effect.fn("features.saml.startLogin")(function* (
  connectionName: string,
  label: string,
) {
  const world = yield* World;
  const connection = yield* ensureConnection(connectionName);
  const started = yield* inApp(
    Effect.flatMap(Saml.Saml, (saml) => saml.authnRequest(connection.id, {})),
  );
  const encoded = new URL(started.location).searchParams.get("SAMLRequest") ?? "";
  const authnRequest = inflateRawSync(Buffer.from(encoded, "base64")).toString("utf8");
  const requestId = /ID="([^"]+)"/.exec(authnRequest)?.[1];
  if (requestId === undefined)
    return yield* Effect.die(new Error("the AuthnRequest carries no ID"));
  const login: LoginState = {
    connectionName,
    requestId,
    state: Redacted.value(started.state),
    location: started.location,
  };
  world.logins.set(label, login);
  // "the current login": what a When that does not name one answers.
  world.logins.set("current", login);
  return login;
});

export const patchSpec = Effect.fn("features.saml.patchSpec")(function* (
  change: (spec: ResponseSpec) => ResponseSpec,
) {
  const world = yield* World;
  yield* Ref.update(world.spec, change);
});

export const expectReason = Effect.fn("features.saml.expectReason")(function* (reason: string) {
  const world = yield* World;
  yield* Ref.set(world.expectedReason, reason);
});

const signerNamed = (who: Identity | undefined, connection: ConnectionState) =>
  who ?? connection.signer;

/** The base64 `SAMLResponse` the IdP would post for `login`, from the scenario's current response spec. */
export const idpResponse = Effect.fn("features.saml.idpResponse")(function* (
  login: LoginState | undefined,
  spec: ResponseSpec,
) {
  if (spec.rawPayload !== undefined) return spec.rawPayload(login);
  const world = yield* World;
  const config = yield* Ref.get(world.config);
  // The IdP that answers is the one the login was solicited on; a scenario may address the assertion to another
  // connection's service provider (`forConnection`) without changing who signs it.
  const issuingName = login?.connectionName ?? "acme";
  const issuer = yield* ensureConnection(issuingName);
  const audienceFor = yield* ensureConnection(spec.forConnection ?? issuingName);
  const baseUrl = config.baseUrl ?? BASE_URL;
  const audience =
    config.spEntityId?.(audienceFor.id) ?? `${baseUrl}/auth/saml/sp/${audienceFor.id}`;
  const attributes: Record<string, ReadonlyArray<string>> = {
    email: [`ada@${issuingName}.example`],
    ...(spec.padBytes > 0 ? { pad: ["x".repeat(spec.padBytes)] } : {}),
  };
  // Each login gets its own assertion id (a captured assertion may not be replayed), unless the scenario names one.
  const assertionId = spec.response.assertionId ?? `${login?.requestId ?? "_unsolicited"}-a`;
  const xml = responseXml({
    issuer: issuer.entityId,
    nameId: "ada",
    audience,
    recipient: `${baseUrl}${ACS_PATH}`,
    destination: `${baseUrl}${ACS_PATH}`,
    inResponseTo: login?.requestId ?? null,
    attributes,
    ...spec.response,
    assertionId,
  });
  const signed = signedResponse(xml, {
    ...spec.sign,
    who: signerNamed(spec.sign.who, issuer),
    assertionId,
    responseId: spec.response.responseId ?? "_resp1",
  });
  const mutated = spec.mutations.reduce((current, mutate) => mutate(current), signed);
  return Buffer.from(mutated, "utf8").toString("base64");
});

/** Posts `samlResponse` to the ACS with the browser's `state` cookie, and records what happened. */
export const postAcs = Effect.fn("features.saml.postAcs")(function* (
  samlResponse: string,
  cookieState: string | undefined,
) {
  const world = yield* World;
  const exit = yield* inAppExit(
    Effect.gen(function* () {
      const saml = yield* Saml.Saml;
      const users = yield* Users.Users;
      const outcome = yield* saml.acs({ samlResponse, cookieState });
      const user = yield* users.findById(outcome.session.session.userId);
      return { outcome, userId: user.id };
    }),
  );
  const result: Outcome = Exit.isSuccess(exit)
    ? { _tag: "accepted", userId: exit.value.userId, callbackURL: exit.value.outcome.callbackURL }
    : { _tag: "failed", tag: failureTag(exit) };
  yield* world.outcomes.set("last", result);
  return result;
});

const failureTag = <A, E>(exit: Exit.Exit<A, E>): string =>
  Option.match(Exit.findErrorOption(exit), {
    onNone: () => "defect",
    onSome: (error) =>
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      typeof error._tag === "string"
        ? error._tag
        : "unknown",
  });

/** The IdP answers `login` with the scenario's current response, and the browser posts it. */
export const submit = Effect.fn("features.saml.submit")(function* (loginLabel = "current") {
  const world = yield* World;
  const login = world.logins.get(loginLabel);
  const spec = yield* Ref.get(world.spec);
  const payload = yield* idpResponse(login, spec);
  yield* world.outcomes.set("payload", payload);
  return yield* postAcs(payload, login?.state);
});

/** Starts a login on `connectionName` when the scenario has not, then submits the current response for it. */
export const submitOnConnection = Effect.fn("features.saml.submitOnConnection")(function* (
  connectionName: string,
) {
  const world = yield* World;
  const current = world.logins.get("current");
  if (current === undefined || current.connectionName !== connectionName) {
    yield* startLogin(connectionName, "current");
  }
  return yield* submit("current");
});

export const lastOutcome = Effect.fn("features.saml.lastOutcome")(function* () {
  const world = yield* World;
  return yield* world.outcomes.getAs("last", isOutcome);
});

export { ALGORITHM, attacker, idp, idpNext };
