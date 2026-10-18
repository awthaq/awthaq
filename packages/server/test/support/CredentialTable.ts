// The credential table every entry point is tested against (ADR-EA-042): the sessions, the claimed-credential
// contributions, the 23 request shapes (T1 to T23) and what each tier must resolve them to. `Credentials.test.ts`
// runs it through `Credentials.resolve`; `Authentication.test.ts` runs the same rows through Path A over
// `HttpApiTest`, so the two cannot drift.
import { AuditLog, AuthEvents, Persistence, SessionCookie, Sessions, Users } from "@awthaq/core";
import { Api } from "@awthaq/api";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as Credentials from "../../src/Credentials.ts";

// ---- fixtures -------------------------------------------------------------------------------------------

export const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const service = (id: string) =>
  new Api.ServicePrincipal({ ref: new Api.PrincipalRef({ type: "service", id }), scopes: [] });
const user = (id: string) =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id }),
    sessionId: "stateless",
  });
const apiKey = (id: string) =>
  new Api.ApiKeyPrincipal({ ref: new Api.PrincipalRef({ type: "apikey", id }), scopes: [] });

/** Counts contribution `resolve` calls, so a test can see how often a claimed credential was resolved. */
export const claimed = { resolves: 0 };

const contributions = Layer.mergeAll(
  Credentials.contribute("bearer", {
    id: "svc",
    claims: (raw) => raw.startsWith("svc."),
    resolve: (credential) =>
      Redacted.value(credential) === "svc.outage"
        ? Effect.fail(new Api.StoreUnavailable({ operation: "svc.resolve" }))
        : Effect.sync(() => {
            claimed.resolves += 1;
            return service("svc");
          }),
  }),
  Credentials.contribute("bearer", {
    id: "jwtu",
    claims: (raw) => raw.startsWith("jwtu."),
    resolve: (credential) =>
      Redacted.value(credential) === "jwtu.bad"
        ? Effect.fail(new Api.Unauthenticated())
        : Effect.sync(() => {
            claimed.resolves += 1;
            return user("jwt-user");
          }),
  }),
  Credentials.contribute("apiKey", {
    id: "keys",
    claims: (raw) => raw.startsWith("ak_"),
    resolve: (credential) =>
      Redacted.value(credential).startsWith("ak_bad")
        ? Effect.fail(new Api.Unauthenticated())
        : Effect.succeed(apiKey("key")),
  }),
);

const sessionStack = (decorate?: (base: Sessions.SessionsShape) => Sessions.SessionsShape) => {
  const sessions = Sessions.layer.pipe(Layer.provide(Persistence.memory));
  return decorate === undefined
    ? sessions
    : Layer.effect(
        Sessions.Sessions,
        Effect.map(Sessions.Sessions, (base) => decorate(base)),
      ).pipe(Layer.provide(sessions));
};

export interface Variant {
  readonly resolver?: Layer.Layer<Credentials.PrincipalResolver>;
  readonly cookie?: Layer.Layer<never>;
  readonly decorate?: (base: Sessions.SessionsShape) => Sessions.SessionsShape;
  readonly sessionConfig?: Layer.Layer<never>;
}

export const layerFor = (variant: Variant = {}) =>
  Layer.mergeAll(
    Layer.empty,
    variant.resolver ?? Credentials.PrincipalResolverLive,
    variant.cookie ?? Layer.empty,
  ).pipe(
    Layer.provideMerge(contributions.pipe(Layer.provideMerge(Credentials.CredentialResolversLive))),
    Layer.provideMerge(sessionStack(variant.decorate)),
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
    Layer.provide(
      variant.sessionConfig ??
        Layer.succeed(Sessions.SessionConfig, Sessions.SessionConfig.defaultValue()),
    ),
    Layer.provide(NodeCrypto.layer),
  );

export const secureDomain = SessionCookie.config({
  mode: SessionCookie.SecureDomain({ domain: "example.com", sameSite: "lax" }),
});

/** The sessions every row refers to by name. */
export const seed = Effect.gen(function* () {
  const sessions = yield* Sessions.Sessions;
  const issue = (userId: string, actingAs?: { readonly type: string; readonly id: string }) =>
    sessions
      .issue({
        userId: Users.UserId(userId),
        ...(actingAs === undefined ? {} : { actingAs }),
      })
      .pipe(Effect.map((issued) => Redacted.value(issued.token)));
  return {
    own: yield* issue(A),
    other: yield* issue(B),
    imp: yield* issue(B, { type: "user", id: A }),
    planted: yield* issue(B),
    stale: "stale.token",
  };
});
export type Tokens = Effect.Success<typeof seed>;

export const requestWith = (headers: Record<string, string>) =>
  HttpServerRequest.fromWeb(new Request("http://localhost/whatever", { headers }));

export const who = (id: string) => (id === A ? "A" : id === B ? "B" : id);

/** `A@cookie`, `B~A@impersonation` (B acting as A), `svc@bearer` (a claimed credential): who a request resolved to, and by which carrier. */
export const show = (resolved: Credentials.Resolved<Api.Principal>) => {
  const principal = resolved.principal;
  const acting =
    principal._tag === "User" && principal.actingAs !== undefined
      ? `~${who(principal.actingAs.id)}`
      : "";
  return `${who(principal.ref.id)}${acting}@${resolved.carrier}`;
};

// ---- group T: the table ---------------------------------------------------------------------------------

export interface Row {
  readonly id: string;
  /** `[cookie name, token name or literal]`; the name `impersonation`/`session` follows the configured mode. */
  readonly cookies?: ReadonlyArray<readonly [string, string]>;
  readonly apiKey?: string;
  readonly bearer?: string;
  readonly variant?: "secure" | "serviceResolver";
  readonly user: string;
  readonly machine: string;
  readonly optional: string;
}

export const none = "unauthenticated";

export const isAny = (_principal: Api.Principal): _principal is Api.Principal => true;

export const rows: ReadonlyArray<Row> = [
  { id: "T1", user: none, machine: none, optional: none },
  {
    id: "T2",
    cookies: [["session", "own"]],
    user: "A@cookie",
    machine: "A@cookie",
    optional: "A@cookie",
  },
  {
    id: "T3",
    cookies: [["session", "own"]],
    bearer: "other",
    user: "A@cookie",
    machine: "A@cookie",
    optional: "A@cookie",
  },
  {
    id: "T4",
    cookies: [["session", "stale"]],
    bearer: "other",
    user: "B@bearer",
    machine: "B@bearer",
    optional: "B@bearer",
  },
  {
    id: "T5",
    cookies: [["session", "stale"]],
    bearer: "jwtu.ok",
    user: "jwt-user@bearer",
    machine: "jwt-user@bearer",
    optional: "jwt-user@bearer",
  },
  {
    id: "T6",
    cookies: [["session", "stale"]],
    bearer: "svc.x",
    user: none,
    machine: "svc@bearer",
    optional: none,
  },
  {
    id: "T7",
    cookies: [
      ["impersonation", "imp"],
      ["session", "own"],
    ],
    user: "B~A@impersonation",
    machine: "B~A@impersonation",
    optional: "B~A@impersonation",
  },
  {
    id: "T8",
    cookies: [
      ["impersonation", "planted"],
      ["session", "own"],
    ],
    user: "A@cookie",
    machine: "A@cookie",
    optional: "A@cookie",
  },
  { id: "T9", cookies: [["impersonation", "planted"]], user: none, machine: none, optional: none },
  {
    id: "T10",
    cookies: [
      ["impersonation", "stale"],
      ["session", "own"],
    ],
    user: "A@cookie",
    machine: "A@cookie",
    optional: "A@cookie",
  },
  { id: "T11", apiKey: "ak_1", user: none, machine: "key@apiKey", optional: none },
  {
    id: "T12",
    apiKey: "nope",
    bearer: "own",
    user: "A@bearer",
    machine: "A@bearer",
    optional: "A@bearer",
  },
  {
    id: "T13",
    apiKey: "ak_bad",
    bearer: "own",
    user: "A@bearer",
    machine: "A@bearer",
    optional: "A@bearer",
  },
  {
    id: "T14",
    cookies: [["session", "own"]],
    apiKey: "ak_1",
    user: "A@cookie",
    machine: "A@cookie",
    optional: "A@cookie",
  },
  { id: "T15", bearer: "ak_1", user: none, machine: none, optional: none },
  { id: "T16", bearer: "own", user: "A@bearer", machine: "A@bearer", optional: "A@bearer" },
  { id: "T17", bearer: "jwtu.bad", user: none, machine: none, optional: none },
  {
    id: "T18",
    cookies: [["impersonation", "imp"]],
    bearer: "own",
    user: "B~A@impersonation",
    machine: "B~A@impersonation",
    optional: "B~A@impersonation",
  },
  {
    id: "T19",
    apiKey: "ak_1",
    bearer: "svc.x",
    user: none,
    machine: "key@apiKey",
    optional: none,
  },
  {
    id: "T20",
    variant: "secure",
    cookies: [["__Host-session", "own"]],
    user: none,
    machine: none,
    optional: none,
  },
  {
    id: "T21",
    variant: "secure",
    cookies: [["__Secure-session", "own"]],
    user: "A@cookie",
    machine: "A@cookie",
    optional: "A@cookie",
  },
  {
    id: "T22",
    variant: "secure",
    cookies: [
      ["__Secure-impersonation", "imp"],
      ["__Secure-session", "own"],
    ],
    user: "B~A@impersonation",
    machine: "B~A@impersonation",
    optional: "B~A@impersonation",
  },
  {
    id: "T23",
    variant: "serviceResolver",
    cookies: [["session", "own"]],
    user: none,
    machine: "svc-session@cookie",
    optional: none,
  },
];

const tokenOf = (tokens: Tokens, name: string) =>
  name in tokens ? String(Reflect.get(tokens, name)) : name;

export const headersFor = (row: Row, tokens: Tokens) => {
  const names: Record<string, string> =
    row.variant === "secure"
      ? { session: "__Secure-session", impersonation: "__Secure-impersonation" }
      : { session: "__Host-session", impersonation: "__Host-impersonation" };
  const cookie = (row.cookies ?? [])
    .map(([name, token]) => `${names[name] ?? name}=${tokenOf(tokens, token)}`)
    .join("; ");
  return {
    ...(cookie === "" ? {} : { cookie }),
    ...(row.apiKey === undefined ? {} : { "x-api-key": tokenOf(tokens, row.apiKey) }),
    ...(row.bearer === undefined ? {} : { authorization: `Bearer ${tokenOf(tokens, row.bearer)}` }),
  };
};

export const variantOf = (row: Row): Variant =>
  row.variant === "secure"
    ? { cookie: secureDomain }
    : row.variant === "serviceResolver"
      ? {
          resolver: Layer.succeed(Credentials.PrincipalResolver, {
            resolve: () => Effect.succeed(service("svc-session")),
          }),
        }
      : {};

export const tiers = [
  ["user", Credentials.userTier],
  ["machine", Credentials.machineTier],
  ["optional", Credentials.optionalTier],
] as const;
