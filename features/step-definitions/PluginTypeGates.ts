// P20a/AH-003: the compile-time half of the foundations features (INV-EA-001..006).
//
// Every claim below is verified by the TypeScript compiler, not by vitest: this file is part
// of `features/tsconfig.test.json`'s program (`pnpm run typecheck`), so it stops compiling
// the moment an invariant stops holding — a `// @ts-expect-error` that no longer has an error
// under it is itself a compile error, and an exact diagnostic literal that stops matching
// is an assignment error. The steps that name these scenarios read this file's source
// (`assertTypeGate`) so a gate cannot be deleted without its scenario failing; they do not
// pretend to run the compiler.
//
// A gate is a `// type-gate: <name>` line followed by its block (up to the next blank line).
import { Auth, AuthPlugin, HookPoint, Hooks } from "@awthaq/core";
import { Mailer, PasswordHasher } from "@awthaq/ports";
import { cheapArgon2id } from "./shared/Harness.ts";
import { Password } from "@awthaq/password";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as Schema from "effect/Schema";
import {
  DependentFixture,
  InviteFixture,
  InviteOne,
  InviteTwin,
  CryptoUserOne,
  CryptoUserTwo,
  InviteTapper,
  NotifierFixture,
  NotifierNoMail,
  PasskeyFixture,
  PasswordFixture,
  PortUserFixture,
  SessionsFixture,
  TwoFactorFixture,
  UsersFixture,
} from "./PluginFixtures.ts";

// type-gate: contract-group-in-own-namespace
export const ownNamespaceGroup = InviteFixture.contract.groups;

// type-gate: contract-group-outside-namespace
export class MisnamedGroupPlugin extends AuthPlugin.Service<
  MisnamedGroupPlugin,
  Record<string, never>
>()("acme.invite", {
  apiVersion: 1,
  // @ts-expect-error - group "invitations" is neither "acme.invite" nor "acme.invite.<sub>" (INV-EA-006)
  contract: HttpApi.make("auth").add(
    HttpApiGroup.make("invitations").add(
      HttpApiEndpoint.get("x", "/x", { success: Schema.String }),
    ),
  ),
}) {}

// type-gate: table-prefixed
export class PrefixedTablePlugin extends AuthPlugin.Service<
  PrefixedTablePlugin,
  Record<string, never>
>()("password", {
  apiVersion: 1,
  contract: HttpApi.make("auth"),
  tables: ["password_account"],
}) {}

// type-gate: table-bare
export class BareTablePlugin extends AuthPlugin.Service<BareTablePlugin, Record<string, never>>()(
  "password",
  {
    apiVersion: 1,
    contract: HttpApi.make("auth"),
    // @ts-expect-error - the bare table name "account" does not start with "password_" (BEH-EA-005)
    tables: ["account"],
  },
) {}

// type-gate: duplicate-id
export const duplicateIdDiagnostic: Auth.Validate<readonly [typeof InviteOne, typeof InviteTwin]> =
  { awthaq: 'plugin id "invite" appears more than once' };
export const duplicateIdComposition = (): void => {
  // @ts-expect-error - plugin id "invite" appears more than once (INV-EA-003)
  Auth.make([InviteOne, InviteTwin]);
};

// type-gate: missing-dep
export const missingDepDiagnostic: Auth.Validate<readonly [typeof TwoFactorFixture]> = {
  awthaq: 'plugin "twoFactor" depends on plugin "password", which is not in the list',
};
export const missingDepComposition = (): void => {
  // @ts-expect-error - plugin "twoFactor" depends on plugin "password", which is not in the list (INV-EA-001)
  Auth.make([TwoFactorFixture]);
};

// type-gate: satisfied-dep
export const satisfiedDepComposition = (): void => {
  Auth.make([PasswordFixture, TwoFactorFixture]);
};

// type-gate: out-of-order-dep
export const outOfOrderDiagnostic: Auth.Validate<
  readonly [typeof TwoFactorFixture, typeof PasswordFixture]
> = { awthaq: 'plugin "twoFactor" depends on plugin "password", which must be listed before it' };
export const outOfOrderComposition = (): void => {
  // @ts-expect-error - plugin "twoFactor" depends on plugin "password", which must be listed before it (JH-006)
  Auth.make([TwoFactorFixture, PasswordFixture]);
};

// type-gate: api-version-literal
export const futureGenerationPlugin = {
  id: "future",
  // @ts-expect-error - apiVersion 2 is not the generation 1 `Auth.make` accepts (BEH-EA-003)
  apiVersion: 2,
  contract: { identifier: "auth", groups: {} },
  tables: [],
  migrations: [],
  dependsOn: [],
  layer: Layer.empty,
} satisfies AuthPlugin.Any;

// type-gate: empty-tuple
export const emptyComposition = (): void => {
  // @ts-expect-error - Auth.make requires at least one plugin
  Auth.make([]);
};

// type-gate: port-stays-in-rin
export const passwordRequiresHasher: [PasswordHasher.PasswordHasher] extends [
  Layer.Services<typeof Password.Password.layer>,
]
  ? true
  : false = true;
export const passwordRequiresMailer: [Mailer.Mailer] extends [
  Layer.Services<typeof Password.Password.layer>,
]
  ? true
  : false = true;

// type-gate: port-not-in-rout
export const passwordProvidesNoPort: [
  Extract<
    Layer.Success<typeof Password.Password.layer>,
    PasswordHasher.PasswordHasher | Mailer.Mailer
  >,
] extends [never]
  ? true
  : false = true;

// type-gate: dependson-joins-rin
export const dependentRequiresSessionsAndUsers: [SessionsFixture | UsersFixture] extends [
  Layer.Services<typeof DependentFixture.layer>,
]
  ? true
  : false = true;

// type-gate: api-layer-consistency
declare const composed: Auth.Built<readonly [typeof PasswordFixture, typeof PasskeyFixture]>;
type ComposedGroups =
  typeof composed.api extends HttpApi.HttpApi<"auth", infer Groups> ? Groups : never;
type ComposedHandlers = Extract<
  Layer.Success<typeof composed.layer>,
  HttpApiGroup.Service<"auth", string>
>;
// Core's own `session`/`account` groups are served by `AuthHttp.coreHandlers` (MW-002), not by a
// plugin layer, so the comparison is over the plugins' groups.
type PluginGroupServices = Exclude<
  HttpApiGroup.ToService<"auth", ComposedGroups>,
  HttpApiGroup.Service<"auth", "session" | "account">
>;
export const everyGroupHasAHandler: [PluginGroupServices] extends [ComposedHandlers]
  ? [PluginGroupServices] extends [never]
    ? false
    : true
  : false = true;
export const everyHandlerHasAGroup: [ComposedHandlers] extends [PluginGroupServices]
  ? true
  : false = true;

// type-gate: launch-needs-ports
const portUserBuilt = () => Auth.make([PortUserFixture]);
export const requiresExactlyBothPorts: [
  Layer.Services<ReturnType<typeof portUserBuilt>["layer"]>,
] extends [Mailer.Mailer | PasswordHasher.PasswordHasher]
  ? [Mailer.Mailer | PasswordHasher.PasswordHasher] extends [
      Layer.Services<ReturnType<typeof portUserBuilt>["layer"]>,
    ]
    ? true
    : false
  : false = true;
export const launchWithoutPorts = (): void => {
  const auth = Auth.make([PortUserFixture]);
  // `Layer.launch` itself accepts any layer; what stops compiling is running the result, whose
  // requirements are the unprovided ports.
  // @ts-expect-error - Mailer and PasswordHasher are still unsatisfied, so the launch effect is not closed (INV-EA-002)
  // @effect-diagnostics-next-line missingEffectContext:off
  const closed: Effect.Effect<never, unknown, never> = Layer.launch(auth.layer);
  void closed;
};

// type-gate: launch-names-mailer
const withoutMailer = () => Auth.make([PortUserFixture]).layer.pipe(Layer.provide(cheapArgon2id));
export const stillRequiresOnlyMailer: [
  Exclude<Layer.Services<ReturnType<typeof withoutMailer>>, Crypto.Crypto>,
] extends [Mailer.Mailer]
  ? [Mailer.Mailer] extends [Layer.Services<ReturnType<typeof withoutMailer>>]
    ? true
    : false
  : false = true;
export const launchWithoutMailer = (): void => {
  // @ts-expect-error - Layer.launch still requires Mailer once only PasswordHasher is provided
  // @effect-diagnostics-next-line missingEffectContext:off
  const closed: Effect.Effect<never, unknown, never> = Layer.launch(withoutMailer());
  void closed;
};

// type-gate: port-diagnostic-is-effects-own
export const noCuratedDiagnosticForMissingPort: [
  Auth.Validate<readonly [typeof PortUserFixture]>,
] extends [{ readonly awthaq: string }]
  ? false
  : true = true;

// type-gate: config-wrong-type
export const wrongTypedOverride = (): void => {
  // @ts-expect-error - minLength is declared as a number (BEH-EA-018)
  Password.config({ minLength: "twelve" });
};

// type-gate: config-unknown-key
export const unknownKeyOverride = (): void => {
  // @ts-expect-error - "unknownOption" is not a key of the config shape (BEH-EA-018)
  Password.config({ unknownOption: true });
};

// type-gate: variant-drops-port
const fullNotifier = () => Auth.make([NotifierFixture]);
const variantNotifier = () => Auth.make([NotifierNoMail]);
export const fullLayerRequiresMailer: [Mailer.Mailer] extends [
  Layer.Services<ReturnType<typeof fullNotifier>["layer"]>,
]
  ? true
  : false = true;
export const variantLayerDoesNotRequireMailer: [Mailer.Mailer] extends [
  Layer.Services<ReturnType<typeof variantNotifier>["layer"]>,
]
  ? false
  : true = true;

// type-gate: shared-port-is-one-entry
const twoCryptoUsers = () => Auth.make([CryptoUserOne, CryptoUserTwo]);
export const cryptoIsTheOnlyRequirement: [
  Layer.Services<ReturnType<typeof twoCryptoUsers>["layer"]>,
] extends [Crypto.Crypto]
  ? [Crypto.Crypto] extends [Layer.Services<ReturnType<typeof twoCryptoUsers>["layer"]>]
    ? true
    : false
  : false = true;

// type-gate: divert-must-be-handled
export const handledDivert = (result: HookPoint.DivertResult<string, number>): string => {
  switch (result._tag) {
    case "Continue":
      return result.value;
    case "Diverted":
      return String(result.value);
  }
};
// @ts-expect-error - the "Diverted" case is not handled, so not every path returns a string
export const unhandledDivert = (result: HookPoint.DivertResult<string, number>): string => {
  if (result._tag === "Continue") return result.value;
};

// type-gate: tap-joins-rin
export const tapPointJoinsRin: [Hooks.BeforeUserDelete] extends [
  Layer.Services<typeof InviteTapper.layer>,
]
  ? true
  : false = true;

// type-gate: tap-on-undefined-point-fails
const tapperBuilt = () => Auth.make([InviteTapper]);
export const tapPointStillRequired: [Hooks.BeforeUserDelete] extends [
  Layer.Services<ReturnType<typeof tapperBuilt>["layer"]>,
]
  ? true
  : false = true;
export const launchWithoutThePoint = (): void => {
  const auth = tapperBuilt();
  // @ts-expect-error - no installed plugin provides BeforeUserDelete, so the composition is not closed (INV-EA-005)
  // @effect-diagnostics-next-line missingEffectContext:off
  const closed: Effect.Effect<never, unknown, never> = Layer.launch(auth.layer);
  void closed;
};
