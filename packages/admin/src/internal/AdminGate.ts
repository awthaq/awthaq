// @awthaq/admin — internal/AdminGate
//
// ADR-EA-018 Decision 8 / BEH-EA-221 / BEH-EA-236 (plan 13): the one admin gate. Every gated admin
// operation asks it, and it alone reads `AdminConfig` per operation, through `Tenant.configInForce`.
// What an operation needs from the configuration (`maxDuration`, `passwordPolicy`, `links`) comes
// from the clearance the gate returns, i.e. from the very value that authorized it.
//
// `AdminConfig.canImpersonate` takes a `@qadi/core` `AuthSubject`, but this plugin never depends on
// `@awthaq/qadi` (that would put a plugin sitting at the same stratum as `@awthaq/passkey`/`password`
// above `@awthaq/server`, breaking the stratum ordering `spec/overview.md` fixes), so the subject
// passed to a predicate is a bare, identity-only one this module builds itself (`subject`), the
// same "id only, no roles, no permissions" shape `@awthaq/qadi`'s own `SubjectResolver.ts` documents
// as its default resolution (BEH-EA-137). A host whose predicate needs more than an id looks the
// rest up itself (e.g. by closing over its own `Roles`/`SubjectResolver` at `config()` call time).
import { Api } from "@awthaq/api";
import { AuthEvents, ConfigDescriptor, Errors, Sessions, Tenant, Users } from "@awthaq/core";
import { TenantScoped } from "@awthaq/sql";
import type { AuthSubject } from "@qadi/core";
import { makeSubject } from "@qadi/core";
import * as Brand from "effect/Brand";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as AdminApi from "../AdminApi.ts";
import type * as ImpersonationRecords from "../ImpersonationRecords.ts";

// ---- 1. Configuration: moved verbatim from Admin.ts ----------------------------------------------

/**
 * IDS-001/MTI-006: the gate sees BOTH sides of the act, so a host can refuse
 * impersonating a more privileged (or another tenant's) account. Both subjects
 * are identity-only (see `subjectOf`); a host needing roles/tenant looks them
 * up itself by id.
 */
export interface ImpersonationGateInput {
  readonly admin: AuthSubject;
  readonly target: AuthSubject;
  /** IDS-002: the ambient tenant the request acts for, so a host predicate can compare tenant affinity. */
  readonly tenantId: Option.Option<string>;
}

/** IDS-001: the per-episode form of the gate used by `forceStop` and `list`. */
export interface EpisodeGateInput {
  readonly admin: AuthSubject;
  readonly episode: ImpersonationRecords.ImpersonationRecord;
}

export interface AdminConfigShape {
  /** BEH-EA-210: the hard expiry every impersonation session gets at issuance. */
  readonly maxDuration: Duration.Duration;
  /** BEH-EA-212: fail-closed by default — an application that installs this plugin but never configures a gate denies every attempt. */
  readonly canImpersonate: (input: ImpersonationGateInput) => Effect.Effect<boolean>;
  /**
   * IDS-001: may `admin` end (`forceStop`) or see (`list`) this episode?
   * `config` defaults it to `canImpersonate` evaluated against the episode's
   * target, so a host scoping impersonation by privilege/tenant gets the same
   * scoping on stop/list without writing a second predicate.
   */
  readonly canManageEpisode: (input: EpisodeGateInput) => Effect.Effect<boolean>;
  /**
   * BAM-005: the one fail-closed predicate behind the user and session administration
   * endpoints. `target` is `None` for a collection-level call (`listUsers`) and the
   * user being acted on otherwise — the same "the gate sees the target" rule as
   * `canImpersonate` (IDS-001), so a host can keep, say, a superadmin account out of
   * reach of ordinary administrators. Banning (`canBanUsers`) and tenant administration
   * (`canAdministerTenants`) get their own predicates when those capabilities land.
   */
  readonly canManageUsers: (input: UserAdminGateInput) => Effect.Effect<boolean>;
  /**
   * IDS-002/EP-003 (ADR-EA-018): the superadmin predicate — "may `admin` act across
   * tenants?". Fail-closed. Without it, `list`/`forceStop` see only the ambient
   * tenant's impersonation episodes; with it they see every tenant's. The tenant
   * administration surface (`AdminTenants`, `listOrganizations`, `suspendOrganization`,
   * ...) is gated by it too, with `organizationId` naming the organization acted on
   * (`None` for the collection-level listing).
   */
  readonly canAdministerTenants: (input: TenantAdminGateInput) => Effect.Effect<boolean>;
  /**
   * BAM-005/SCP-001: the fail-closed predicate behind `banUser`/`unbanUser` — its own
   * capability, since locking an account out is a stronger act than editing it. Same
   * `{ admin, target }` shape as `canManageUsers`.
   */
  readonly canBanUsers: (input: UserAdminGateInput) => Effect.Effect<boolean>;
  /**
   * BAM-005: the fail-closed predicate behind `AdminAccounts.deleteUser` — erasing an account
   * is irreversible, so it is its own capability, apart from editing or banning. Same
   * `{ admin, target }` shape as `canManageUsers`.
   */
  readonly canDeleteUsers: (input: UserAdminGateInput) => Effect.Effect<boolean>;
  /**
   * BAM-005/BAM-009: the fail-closed predicate behind `AdminAccounts.setUserEmail` and
   * `setUserPassword` — the two acts that change *how a user proves who they are*, so a host
   * that lets support staff edit profiles need not let them do this. Same shape as
   * `canManageUsers`.
   */
  readonly canManageCredentials: (input: UserAdminGateInput) => Effect.Effect<boolean>;
  /**
   * BAM-005: the strength policy for an administrator-set password: the hints it violates
   * (empty = acceptable), the same contract `@awthaq/password`'s own policy has. `Admin` cannot
   * depend on the password plugin, so this is its own knob; the default is the password
   * plugin's default floor (12 to 1024 characters), and a host that screens against a breach
   * corpus, or wants the same policy as its `Password.config`, supplies it here.
   */
  readonly passwordPolicy: (
    password: Redacted.Redacted<string>,
  ) => Effect.Effect<ReadonlyArray<string>>;
  /**
   * BAM-009: builds the link mailed to the *new* address of an administrator-requested email
   * change (the same `data.url` `@awthaq/password`'s `links.changeEmail` builds for a user's
   * own request). Point both at the page that posts the token to `POST /change-email/confirm`.
   */
  readonly links: { readonly changeEmail?: (token: string) => string };
}

/** BAM-005: what `canManageUsers` is asked — see there. */
export interface UserAdminGateInput {
  readonly admin: AuthSubject;
  readonly target: Option.Option<AuthSubject>;
  /** IDS-002: the ambient tenant of the request. */
  readonly tenantId: Option.Option<string>;
}

/** EP-003: what `canAdministerTenants` is asked — see there. */
export interface TenantAdminGateInput {
  readonly admin: AuthSubject;
  readonly organizationId: Option.Option<string>;
}

/** IDS-001: the identity-only subject for a bare user id (the episode's target). */
const subjectOfUserId = (id: string): AuthSubject => makeSubject({ id });

const episodeGateFrom =
  (canImpersonate: AdminConfigShape["canImpersonate"]): AdminConfigShape["canManageEpisode"] =>
  ({ admin, episode }) =>
    canImpersonate({
      admin,
      target: subjectOfUserId(episode.targetUserId),
      // The episode's own tenant: the gate compares affinity with where the episode ran.
      tenantId: episode.tenantId,
    });

/** The password plugin's default floor and ceiling (`Password.config`'s `minLength` 12, `MAX_PASSWORD_LENGTH` 1024). */
const defaultPasswordHints = (password: string): ReadonlyArray<string> =>
  password.length < 12
    ? ["must be at least 12 characters"]
    : password.length > 1024
      ? ["must be at most 1024 characters"]
      : [];

const defaultAdminConfig: AdminConfigShape = {
  maxDuration: Duration.hours(1),
  canImpersonate: () => Effect.succeed(false),
  canManageEpisode: episodeGateFrom(() => Effect.succeed(false)),
  canManageUsers: () => Effect.succeed(false),
  canBanUsers: () => Effect.succeed(false),
  canDeleteUsers: () => Effect.succeed(false),
  canManageCredentials: () => Effect.succeed(false),
  passwordPolicy: (password) => Effect.succeed(defaultPasswordHints(Redacted.value(password))),
  links: {},
  canAdministerTenants: () => Effect.succeed(false),
};

/** BEH-EA-017's `Context.Reference`-with-default pattern, applied to this plugin's own policy knobs. */
/** Module-private (plan 13): the only reader is `make` below, which reads it per operation. */
const AdminConfig: Context.Reference<AdminConfigShape> = Context.Reference("awthaq/admin/Config", {
  defaultValue: () => defaultAdminConfig,
});

export const config = (partial: Partial<AdminConfigShape>) =>
  Layer.succeed(AdminConfig, {
    ...defaultAdminConfig,
    ...partial,
    canManageEpisode:
      partial.canManageEpisode ??
      episodeGateFrom(partial.canImpersonate ?? defaultAdminConfig.canImpersonate),
  });

/** EP-009: the descriptor `Admin` declares (same key, so `EffectiveConfig` output is unchanged). Precedent: `server/src/BodyLimit.ts:57`. */
export const descriptor = ConfigDescriptor.make(AdminConfig);

// ---- 2. The action table -------------------------------------------------------------------------

/** The predicates whose input is `I`. Derived from `AdminConfigShape`, so a new predicate of a known shape joins on its own. */
type GateOf<I> = {
  [K in keyof AdminConfigShape]: AdminConfigShape[K] extends (input: I) => Effect.Effect<boolean>
    ? K
    : never;
}[keyof AdminConfigShape];
/** "canManageUsers" | "canBanUsers" | "canDeleteUsers" | "canManageCredentials" (checked by AdminGate.types.test.ts). */
export type UserGate = GateOf<UserAdminGateInput>;
/** "canAdministerTenants". */
export type TenantGate = GateOf<TenantAdminGateInput>;

/**
 * BEH-EA-221 / BEH-EA-237: which predicate guards which action, and what the predicate is shown.
 * The action name is also the `action` of `auth.admin.actionDenied` (unchanged strings).
 */
const actions = {
  effectiveConfig: { gate: "canManageUsers", on: "users" },
  listUsers: { gate: "canManageUsers", on: "users" },
  getUser: { gate: "canManageUsers", on: "user" },
  updateUser: { gate: "canManageUsers", on: "user" },
  listUserSessions: { gate: "canManageUsers", on: "user" },
  revokeUserSession: { gate: "canManageUsers", on: "user" },
  revokeUserSessions: { gate: "canManageUsers", on: "user" },
  banUser: { gate: "canBanUsers", on: "user" },
  unbanUser: { gate: "canBanUsers", on: "user" },
  deleteUser: { gate: "canDeleteUsers", on: "user" },
  setUserEmail: { gate: "canManageCredentials", on: "user" },
  setUserPassword: { gate: "canManageCredentials", on: "user" },
  listOrganizations: { gate: "canAdministerTenants", on: "organizations" },
  getOrganization: { gate: "canAdministerTenants", on: "organization" },
  suspendOrganization: { gate: "canAdministerTenants", on: "organization" },
  unsuspendOrganization: { gate: "canAdministerTenants", on: "organization" },
} as const satisfies Record<
  string,
  | { readonly gate: UserGate; readonly on: "users" | "user" }
  | { readonly gate: TenantGate; readonly on: "organizations" | "organization" }
>;

type Actions = typeof actions;
type ActionOn<On> = {
  [K in keyof Actions]: Actions[K]["on"] extends On ? K : never;
}[keyof Actions];
/** The predicate sees no target: "effectiveConfig" | "listUsers" | "listOrganizations". */
export type CollectionAction = ActionOn<"users" | "organizations">;
export type UserAction = ActionOn<"user">;
export type OrganizationAction = ActionOn<"organization">;

// ---- 3. Clearances: proof the gate passed, minted only here (the SignIn `Clearance` precedent) ----

export type Clearance = {
  readonly adminUserId: Users.UserId;
  /** The configuration in force that authorized this operation. Read nothing else. */
  readonly config: AdminConfigShape;
} & Brand.Brand<"awthaq/admin/Clearance">;

export type UserClearance = {
  readonly adminUserId: Users.UserId;
  readonly config: AdminConfigShape;
  readonly userId: Users.UserId;
  /** IDS-003 / BEH-EA-221: existence second. Run it after any self-refusal, never before the gate. */
  readonly target: Effect.Effect<
    Users.UserRecord,
    AdminApi.AdminTargetNotFound | Errors.StoreUnavailable
  >;
} & Brand.Brand<"awthaq/admin/UserClearance">;

export type OrganizationClearance = {
  readonly adminUserId: Users.UserId;
  readonly config: AdminConfigShape;
  readonly organizationId: string;
} & Brand.Brand<"awthaq/admin/OrganizationClearance">;

const clearance = Brand.nominal<Clearance>();
const userClearance = Brand.nominal<UserClearance>();
const organizationClearance = Brand.nominal<OrganizationClearance>();

// ---- 4. The gate. Yielded once in each plugin's `make` (precedent: `SignIn.make`, `SignUp.make`). ----
export const make = Effect.gen(function* () {
  const users = yield* Users.Users;
  const events = yield* AuthEvents.AuthEvents;
  // The one read of the built value: what `Layer.provide(Admin.config(...))` gave this layer.
  const inForce = Tenant.configInForce(AdminConfig, yield* AdminConfig);

  /** IDS-001 / BEH-EA-137: identity-only; a host needing roles looks them up by id. */
  const subject = (id: string) => makeSubject({ id });

  const targetOf = (userId: Users.UserId) =>
    users
      .findById(userId)
      .pipe(Effect.catchTag("UserNotFound", () => Effect.fail(new AdminApi.AdminTargetNotFound())));

  /** BEH-EA-224: a genuine refusal, never validation noise. An attempt event (ADR-EA-037): it survives a rollback. */
  const refuse = Effect.fnUntraced(function* (
    caller: Api.UserPrincipal,
    action: string,
    named: { readonly targetUserId?: Users.UserId; readonly organizationId?: string },
  ) {
    yield* events.publish({
      _tag: "auth.admin.actionDenied",
      adminUserId: Users.UserId(caller.ref.id),
      action,
      ...named,
    });
    return yield* Effect.fail(new AdminApi.AdminActionDenied());
  });

  const decide = Effect.fnUntraced(function* (
    caller: Api.UserPrincipal,
    action: keyof Actions,
    target: Option.Option<string>,
  ) {
    const config = yield* inForce;
    const entry = actions[action];
    const allowed =
      entry.gate === "canAdministerTenants"
        ? yield* config[entry.gate]({ admin: subject(caller.ref.id), organizationId: target })
        : yield* config[entry.gate]({
            admin: subject(caller.ref.id),
            target: Option.map(target, subject),
            tenantId: yield* Tenant.TenantContext,
          });
    if (!allowed) {
      return yield* Option.match(target, {
        onNone: () => refuse(caller, action, {}),
        onSome: (id) =>
          refuse(
            caller,
            action,
            entry.on === "organization"
              ? { organizationId: id }
              : { targetUserId: Users.UserId(id) },
          ),
      });
    }
    return config;
  });

  /** `listUsers`, `effectiveConfig`, `listOrganizations`: the predicate sees no target. */
  const collection = (caller: Api.UserPrincipal, action: CollectionAction) =>
    Effect.map(decide(caller, action, Option.none()), (config) =>
      clearance({ adminUserId: Users.UserId(caller.ref.id), config }),
    );

  /** BEH-EA-221: per-user. The predicate sees the target; `target` loads it afterwards. */
  const user = (caller: Api.UserPrincipal, action: UserAction, userId: Users.UserId) =>
    Effect.map(decide(caller, action, Option.some(userId)), (config) =>
      userClearance({
        adminUserId: Users.UserId(caller.ref.id),
        config,
        userId,
        target: targetOf(userId),
      }),
    );

  /** BEH-EA-237 / EP-003: per-organization. */
  const organization = (
    caller: Api.UserPrincipal,
    action: OrganizationAction,
    organizationId: string,
  ) =>
    Effect.map(decide(caller, action, Option.some(organizationId)), (config) =>
      organizationClearance({
        adminUserId: Users.UserId(caller.ref.id),
        config,
        organizationId,
      }),
    );

  /** IDS-006: the impersonation denial names the refused call and what it named. */
  const impersonationDenied = Effect.fnUntraced(function* (
    caller: Api.UserPrincipal,
    attempt: {
      readonly operation: "impersonate" | "forceStop";
      readonly targetUserId: Users.UserId;
      readonly sessionId?: Sessions.SessionId;
    },
  ) {
    yield* events.publish({
      _tag: "auth.admin.impersonationDenied",
      adminUserId: Users.UserId(caller.ref.id),
      operation: attempt.operation,
      targetUserId: attempt.targetUserId,
      ...(attempt.sessionId === undefined ? {} : { sessionId: attempt.sessionId }),
    });
    return yield* Effect.fail(new AdminApi.AdminImpersonationDenied());
  });

  /** BEH-EA-212/213, IDS-001/002/003. Call it after the self/nested refusals (BEH-EA-214/218 never reach the gate). */
  const impersonation = Effect.fnUntraced(function* (
    caller: Api.UserPrincipal,
    targetUserId: Users.UserId,
  ) {
    const config = yield* inForce;
    const allowed = yield* config.canImpersonate({
      admin: subject(caller.ref.id),
      target: subject(targetUserId),
      tenantId: yield* Tenant.TenantContext,
    });
    if (!allowed) {
      return yield* impersonationDenied(caller, { operation: "impersonate", targetUserId });
    }
    return userClearance({
      adminUserId: Users.UserId(caller.ref.id),
      config,
      userId: targetUserId,
      target: targetOf(targetUserId),
    });
  });

  /** BEH-EA-217 / IDS-001: `forceStop`'s per-episode gate. The episode was looked up first, because the gate needs it. */
  const episode = Effect.fnUntraced(function* (
    caller: Api.UserPrincipal,
    record: ImpersonationRecords.ImpersonationRecord,
  ) {
    const config = yield* inForce;
    const allowed = yield* config.canManageEpisode({
      admin: subject(caller.ref.id),
      episode: record,
    });
    if (!allowed) {
      return yield* impersonationDenied(caller, {
        operation: "forceStop",
        targetUserId: record.targetUserId,
        sessionId: Sessions.SessionId(record.sessionId),
      });
    }
    return clearance({ adminUserId: Users.UserId(caller.ref.id), config });
  });

  /** BEH-EA-219 / IDS-001: `list`'s per-row gate. It filters, and never publishes or fails. */
  const visibleEpisodes = (
    caller: Api.UserPrincipal,
    records: ReadonlyArray<ImpersonationRecords.ImpersonationRecord>,
  ) =>
    Effect.flatMap(inForce, (config) =>
      Effect.filter(
        records,
        (record) => config.canManageEpisode({ admin: subject(caller.ref.id), episode: record }),
        { concurrency: 8 },
      ),
    );

  /** IDS-002: a `CrossTenant` witness for a caller who passes `canAdministerTenants`, else `None` (confinement stays). */
  const crossTenantScope = (caller: Api.UserPrincipal) =>
    Effect.flatMap(inForce, (config) =>
      config
        .canAdministerTenants({ admin: subject(caller.ref.id), organizationId: Option.none() })
        .pipe(
          Effect.map((allowed) =>
            allowed
              ? Option.some(TenantScoped.crossTenant("admin: superadmin (canAdministerTenants)"))
              : Option.none(),
          ),
        ),
    );

  return {
    collection,
    user,
    organization,
    impersonation,
    episode,
    visibleEpisodes,
    crossTenantScope,
  };
});

export type AdminGate = Effect.Success<typeof make>;
