// P20a/AH-003 (decision 36, Tier 4): toy plugins the foundations features compose.
//
// The 00-foundations scenarios are about the plugin *contract* (`AuthPlugin.Service`,
// `Auth.make`, `Validate<P>`, slots, hook points, registries), not about what any real
// plugin does. Composing the real `Password`/`Passkey`/`Roles` would need every port and
// middleware they require, so each named plugin in those scenarios is a small stand-in
// with the same id, group and dependency shape the scenario states. The real plugins are
// still used wherever a scenario is about them (e.g. `Password`'s own `PasswordConfig`).
import { AuthPlugin, Hooks, HookPoint, Slots } from "@awthaq/core";
import { Mailer, PasswordHasher } from "@awthaq/ports";
import { SubjectResolver } from "@awthaq/qadi";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

const endpointApi = <const Group extends string, const Name extends string>(
  group: Group,
  name: Name,
  path: `/${string}`,
) =>
  HttpApi.make("auth").add(
    HttpApiGroup.make(group).add(HttpApiEndpoint.get(name, path, { success: Schema.String })),
  );

// --- Password stand-in: id "password", one group, one migration, a `tables` entry -------

export const PasswordApiFixture = endpointApi("password", "probe", "/password/probe");

/** BEH-EA-017: the stand-in's options are a `Context.Reference` with a default, the same shape as the real `PasswordConfig`. */
export interface FixtureConfigShape {
  readonly minLength: number;
}

export const FixtureConfig = Context.Reference<FixtureConfigShape>(
  "features/PasswordFixtureConfig",
  { defaultValue: () => ({ minLength: 12 }) },
);

export const fixtureConfig = (override: Partial<FixtureConfigShape>) =>
  Layer.succeed(FixtureConfig, { minLength: 12, ...override });

/** Counts how many times the stand-in's own `make` ran — BEH-EA-006's "no Layer is evaluated" needs something to observe. */
export const layerEvaluations = { password: 0 };

export class PasswordFixture extends AuthPlugin.Service<
  PasswordFixture,
  { readonly probe: () => Effect.Effect<string>; readonly minLength: number }
>()("password", {
  apiVersion: 1,
  contract: PasswordApiFixture,
  tables: ["password_account"],
  migrations: [{ name: "create_password_account", up: Effect.void }],
}) {
  static readonly layer = AuthPlugin.layer(PasswordFixture, {
    make: Effect.gen(function* () {
      layerEvaluations.password += 1;
      const config = yield* FixtureConfig;
      return { probe: () => Effect.succeed("password"), minLength: config.minLength };
    }),
    handlers: HttpApiBuilder.group(PasswordApiFixture, "password", (handlers) =>
      handlers.handle("probe", () => Effect.succeed("password")),
    ),
  });
}

// --- Passkey stand-in: a second, independent plugin (adds a group + its handler) -------

export const PasskeyApiFixture = endpointApi("passkey", "probe", "/passkey/probe");

export class PasskeyFixture extends AuthPlugin.Service<
  PasskeyFixture,
  { readonly probe: () => Effect.Effect<string> }
>()("passkey", {
  apiVersion: 1,
  contract: PasskeyApiFixture,
  tables: ["passkey_credential"],
  migrations: [{ name: "create_passkey_credential", up: Effect.void }],
}) {
  static readonly layer = AuthPlugin.layer(PasskeyFixture, {
    make: Effect.succeed({ probe: () => Effect.succeed("passkey") }),
    handlers: HttpApiBuilder.group(PasskeyApiFixture, "passkey", (handlers) =>
      handlers.handle("probe", () => Effect.succeed("passkey")),
    ),
  });
}

// --- TwoFactor stand-in: depends on password (BEH-EA-008/011) ----------------------------

export const TwoFactorApiFixture = endpointApi("twoFactor", "probe", "/two-factor/probe");

export class TwoFactorFixture extends AuthPlugin.Service<
  TwoFactorFixture,
  { readonly probe: () => Effect.Effect<string> }
>()("twoFactor", {
  apiVersion: 1,
  contract: TwoFactorApiFixture,
  tables: ["twoFactor_secret"],
  migrations: [{ name: "create_two_factor_secret", up: Effect.void }],
}) {
  static readonly layer = AuthPlugin.layer(TwoFactorFixture, {
    dependsOn: [PasswordFixture],
    make: Effect.gen(function* () {
      const password = yield* PasswordFixture;
      return { probe: () => password.probe() };
    }),
    handlers: HttpApiBuilder.group(TwoFactorApiFixture, "twoFactor", (handlers) =>
      handlers.handle("probe", () => Effect.succeed("twoFactor")),
    ),
  });
}

// --- Sessions / Users / a plugin depending on both (BEH-EA-008's `dependsOn` scenario) ----

export class SessionsFixture extends AuthPlugin.Service<SessionsFixture, Record<string, never>>()(
  "sessions",
  {
    apiVersion: 1,
    contract: HttpApi.make("auth"),
    tables: ["sessions_row"],
    migrations: [{ name: "create_sessions_row", up: Effect.void }],
  },
) {
  static readonly layer = AuthPlugin.layer(SessionsFixture, { make: Effect.succeed({}) });
}

export class UsersFixture extends AuthPlugin.Service<UsersFixture, Record<string, never>>()(
  "users",
  {
    apiVersion: 1,
    contract: HttpApi.make("auth"),
    tables: ["users_row"],
    migrations: [{ name: "create_users_row", up: Effect.void }],
  },
) {
  static readonly layer = AuthPlugin.layer(UsersFixture, { make: Effect.succeed({}) });
}

export class DependentFixture extends AuthPlugin.Service<DependentFixture, Record<string, never>>()(
  "dependent",
  {
    apiVersion: 1,
    contract: HttpApi.make("auth"),
    tables: ["dependent_row"],
    migrations: [{ name: "create_dependent_row", up: Effect.void }],
  },
) {
  static readonly layer = AuthPlugin.layer(DependentFixture, {
    dependsOn: [SessionsFixture, UsersFixture],
    make: Effect.gen(function* () {
      yield* SessionsFixture;
      yield* UsersFixture;
      return {};
    }),
  });
}

// --- Invite: BEH-EA-004's namespaced groups (id "acme.invite") ---------------------------

export const InviteApiFixture = HttpApi.make("auth")
  .add(
    HttpApiGroup.make("acme.invite").add(
      HttpApiEndpoint.get("list", "/acme/invite", { success: Schema.String }),
    ),
  )
  .add(
    HttpApiGroup.make("acme.invite.admin").add(
      HttpApiEndpoint.get("audit", "/acme/invite/audit", { success: Schema.String }),
    ),
  );

export class InviteFixture extends AuthPlugin.Service<
  InviteFixture,
  { readonly count: () => Effect.Effect<number> }
>()("acme.invite", {
  apiVersion: 1,
  contract: InviteApiFixture,
  tables: ["acme.invite_row"],
}) {}

/** A second, independently valid plugin sharing the id "invite" with `InviteTwin` — BEH-EA-010's duplicate. */
export const DuplicateApiFixture = endpointApi("invite", "list", "/invite");

export class InviteOne extends AuthPlugin.Service<
  InviteOne,
  { readonly n: () => Effect.Effect<number> }
>()("invite", { apiVersion: 1, contract: DuplicateApiFixture }) {
  static readonly layer = AuthPlugin.layer(InviteOne, {
    make: Effect.succeed({ n: () => Effect.succeed(1) }),
    handlers: HttpApiBuilder.group(DuplicateApiFixture, "invite", (handlers) =>
      handlers.handle("list", () => Effect.succeed("one")),
    ),
  });
}

export class InviteTwin extends AuthPlugin.Service<
  InviteTwin,
  { readonly n: () => Effect.Effect<number> }
>()("invite", { apiVersion: 1, contract: DuplicateApiFixture }) {
  static readonly layer = AuthPlugin.layer(InviteTwin, {
    make: Effect.succeed({ n: () => Effect.succeed(2) }),
    handlers: HttpApiBuilder.group(DuplicateApiFixture, "invite", (handlers) =>
      handlers.handle("list", () => Effect.succeed("two")),
    ),
  });
}

// --- A plugin that uses two ports (BEH-EA-014/020): they stay in its layer's RIn ------------

export class PortUserFixture extends AuthPlugin.Service<PortUserFixture, Record<string, never>>()(
  "portUser",
  { apiVersion: 1, contract: HttpApi.make("auth") },
) {
  static readonly layer = AuthPlugin.layer(PortUserFixture, {
    make: Effect.gen(function* () {
      yield* Mailer.Mailer;
      yield* PasswordHasher.PasswordHasher;
      return {};
    }),
  });
}

// --- BEH-EA-019's variant: a plugin with a full layer and a static variant that drops a port ----

export class NotifierFixture extends AuthPlugin.Service<
  NotifierFixture,
  { readonly notify: () => Effect.Effect<string> }
>()("notifier", { apiVersion: 1, contract: HttpApi.make("auth") }) {
  /** The full layer reads the `Mailer` port. */
  static readonly layer = AuthPlugin.layer(NotifierFixture, {
    make: Effect.gen(function* () {
      const mailer = yield* Mailer.Mailer;
      return { notify: () => Effect.map(mailer.sent, (sent) => `mailed:${sent.length}`) };
    }),
  });

  /** A variant that never reads `Mailer`, so it is absent from this layer's `RIn`. */
  static readonly layerNoMail = AuthPlugin.layer(NotifierFixture, {
    make: Effect.succeed({ notify: () => Effect.succeed("silent") }),
  });
}

/** A variant is an ordinary plugin value: the class's own static declarations with the alternative `layer`. */
export const NotifierNoMail = {
  id: NotifierFixture.id,
  apiVersion: NotifierFixture.apiVersion,
  contract: NotifierFixture.contract,
  tables: NotifierFixture.tables,
  migrations: NotifierFixture.migrations,
  dependsOn: NotifierFixture.dependsOn,
  layer: NotifierFixture.layerNoMail,
};

// --- Two plugins that both use the `Crypto` port (BEH-EA-020) ------------------------------

export class CryptoUserOne extends AuthPlugin.Service<CryptoUserOne, Record<string, never>>()(
  "cryptoOne",
  { apiVersion: 1, contract: HttpApi.make("auth") },
) {
  static readonly layer = AuthPlugin.layer(CryptoUserOne, {
    make: Effect.gen(function* () {
      yield* Crypto.Crypto;
      return {};
    }),
  });
}

export class CryptoUserTwo extends AuthPlugin.Service<CryptoUserTwo, Record<string, never>>()(
  "cryptoTwo",
  { apiVersion: 1, contract: HttpApi.make("auth") },
) {
  static readonly layer = AuthPlugin.layer(CryptoUserTwo, {
    make: Effect.gen(function* () {
      yield* Crypto.Crypto;
      return {};
    }),
  });
}

// --- A plugin that taps core's `BeforeUserDelete` point (BEH-EA-024) -----------------------

export class InviteTapper extends AuthPlugin.Service<InviteTapper, Record<string, never>>()(
  "inviteTap",
  { apiVersion: 1, contract: HttpApi.make("auth") },
) {
  static readonly layer = AuthPlugin.layer(InviteTapper, {
    make: Effect.succeed({}),
    taps: [Hooks.BeforeUserDelete.declareTap((input) => Effect.succeed(input), { order: 3 })],
  });
}

// --- BEH-EA-032: two plugins colliding on one group id -----------------------------------
//
// `GroupsFor<Id>` (BEH-EA-004) already refuses a plugin naming a group outside its own namespace,
// so the one collision it cannot see is a dotted sub-group: "login" is entitled to "login.legacy",
// and a separate plugin *id*'d "login.legacy" is entitled to a top-level group of that name.

export const LoginHostApi = HttpApi.make("auth")
  .add(
    HttpApiGroup.make("login").add(
      HttpApiEndpoint.get("start", "/login", { success: Schema.String }),
    ),
  )
  .add(
    HttpApiGroup.make("login.legacy").add(
      HttpApiEndpoint.get("old", "/login/old", { success: Schema.String }),
    ),
  );

export class LoginHost extends AuthPlugin.Service<LoginHost, Record<string, never>>()("login", {
  apiVersion: 1,
  contract: LoginHostApi,
}) {
  static readonly layer = AuthPlugin.layer(LoginHost, {
    make: Effect.succeed({}),
    handlers: Layer.mergeAll(
      HttpApiBuilder.group(LoginHostApi, "login", (handlers) =>
        handlers.handle("start", () => Effect.succeed("start")),
      ),
      HttpApiBuilder.group(LoginHostApi, "login.legacy", (handlers) =>
        handlers.handle("old", () => Effect.succeed("old")),
      ),
    ),
  });
}

export const LegacyLoginApi = endpointApi("login.legacy", "imposter", "/legacy-login/imposter");

export class LegacyLogin extends AuthPlugin.Service<LegacyLogin, Record<string, never>>()(
  "login.legacy",
  { apiVersion: 1, contract: LegacyLoginApi },
) {
  static readonly layer = AuthPlugin.layer(LegacyLogin, {
    make: Effect.succeed({}),
    handlers: HttpApiBuilder.group(LegacyLoginApi, "login.legacy", (handlers) =>
      handlers.handle("imposter", () => Effect.succeed("imposter")),
    ),
  });
}

/** MW-002: a plugin whose id (and so its one permitted group) is "session" — core's own group id. */
export const SessionImposterApi = endpointApi("session", "imposter", "/imposter");

export class SessionImposter extends AuthPlugin.Service<SessionImposter, Record<string, never>>()(
  "session",
  { apiVersion: 1, contract: SessionImposterApi },
) {
  static readonly layer = AuthPlugin.layer(SessionImposter, {
    make: Effect.succeed({}),
    handlers: HttpApiBuilder.group(SessionImposterApi, "session", (handlers) =>
      handlers.handle("imposter", () => Effect.succeed("imposter")),
    ),
  });
}

// --- Roles / Organization stand-ins: both override the real SubjectResolver slot ----------

const NoApi = HttpApi.make("auth");

export class RolesFixture extends AuthPlugin.Service<RolesFixture, Record<string, never>>()(
  "roles",
  { apiVersion: 1, contract: NoApi },
) {
  static readonly layer = Slots.override(
    RolesFixture,
    SubjectResolver.SubjectResolver,
    Effect.succeed({
      resolve: (principal) => Effect.succeed(SubjectResolver.resolveIdentityOnly(principal)),
    }),
  ).pipe(Layer.provideMerge(AuthPlugin.layer(RolesFixture, { make: Effect.succeed({}) })));
}

export class OrganizationFixture extends AuthPlugin.Service<
  OrganizationFixture,
  Record<string, never>
>()("organization", { apiVersion: 1, contract: NoApi }) {
  static readonly layer = Slots.override(
    OrganizationFixture,
    SubjectResolver.SubjectResolver,
    Effect.succeed({
      resolve: (principal) => Effect.succeed(SubjectResolver.resolveIdentityOnly(principal)),
    }),
  ).pipe(Layer.provideMerge(AuthPlugin.layer(OrganizationFixture, { make: Effect.succeed({}) })));
}

/** A distinct slot, so "Roles overriding SubjectResolver and another plugin overriding a distinct slot" (REQ-EA-026) is expressible. */
export const AuditSinkSlot = Slots.define<{ readonly sink: string }>()("AuditSink", {
  defaultValue: () => ({ sink: "none" }),
});

export class AuditorFixture extends AuthPlugin.Service<AuditorFixture, Record<string, never>>()(
  "auditor",
  { apiVersion: 1, contract: NoApi },
) {
  static readonly layer = Slots.override(
    AuditorFixture,
    AuditSinkSlot,
    Effect.succeed({ sink: "auditor" }),
  ).pipe(Layer.provideMerge(AuthPlugin.layer(AuditorFixture, { make: Effect.succeed({}) })));
}

// --- Hand-built plugin values: a dependency cycle needs deps that point at each other ----

export type FakePlugin<Id extends string> = AuthPlugin.Any & { readonly id: Id };

/** BEH-EA-016: a real class cannot be forced into a cycle (ELC-006 refuses a second `dependsOn`), so a cycle is built from plugin *values* whose `dependsOn` point at each other, the shape a circular import produces. */
export const fakePlugin = <const Id extends string>(
  id: Id,
  dependsOn: () => ReadonlyArray<AuthPlugin.Any>,
  migrationNames: ReadonlyArray<string> = [],
): FakePlugin<Id> => ({
  id,
  apiVersion: 1,
  contract: { identifier: "auth", groups: {} },
  tables: [],
  migrations: migrationNames.map((name) => ({ name, up: Effect.void })),
  get dependsOn() {
    return dependsOn();
  },
  layer: Layer.empty,
});

// --- Hook points for BEH-EA-022/023/024 --------------------------------------------------

export class SignUpInput extends Schema.Class<SignUpInput>("FoundationsSignUpInput")({
  email: Schema.String,
}) {}

export class BeforeSignUp extends HookPoint.veto<BeforeSignUp>()(
  "foundations.beforeSignUp",
  SignUpInput,
) {}

export class AfterSignIn extends HookPoint.observe<AfterSignIn>()(
  "foundations.afterSignIn",
  SignUpInput,
) {}

export class SignInOutcome extends Schema.Class<SignInOutcome>("FoundationsSignInOutcome")({
  tag: Schema.Literal("TwoFactorRequired"),
}) {}

export class SignInDivert extends HookPoint.divert<SignInDivert>()(
  "foundations.signInDivert",
  SignUpInput,
  SignInOutcome,
) {}
